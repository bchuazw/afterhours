/**
 * Off-chain search for the round `AfterHoursMarket.settleAt` expects: the first valid print at or
 * after a series' expiry. Kept free of RPC clients so it can be exercised against a scripted mirror
 * (hint.test.ts).
 */
import type { Address } from "viem";
import { indexOf, phaseBase } from "./util.js";

export type RoundInfo = { updatedAt: bigint; valid: boolean };
/**
 * Feed access for the search. `round` resolves null when the feed has no usable round at that id
 * (FeedMirror reverts NoData; an OCR2 aggregator returns an empty round) and `latest` resolves null
 * for an empty feed. Transport errors must be thrown, never turned into null, so a flaky RPC can
 * never pass for a missing round.
 */
export type FeedReader = {
  latest(feed: Address): Promise<(RoundInfo & { roundId: bigint }) | null>;
  round(feed: Address, roundId: bigint): Promise<RoundInfo | null>;
};
/**
 * `roundId` is the earliest valid round at/after expiry. `missing` is set when a round settleAt
 * checks below it (its predecessors down to the last pre-expiry print) is absent from the feed: the
 * hole nearest to `roundId`. A hint at aggregator index 1 needs no predecessor.
 */
export type Hint = { roundId: bigint; missing?: bigint };

/// When the round just before a settlement candidate is missing, probe this many ids further down.
export const GAP_PROBE = 64;
/// Longest run of invalid post-expiry rounds stepped over to reach a valid answer (the market's MAX_SETTLE_WALK).
export const MAX_WALK = 300;

/**
 * Binary search within the latest round's phase for the first round with updatedAt >= expiry,
 * treating missing ids (before the mirrored history, or holes) as pre-expiry; then verify the
 * predecessor and step up over invalid answers. Returns null if the feed has not printed since
 * expiry; throws if every print since expiry is invalid.
 */
export async function findSettleRound(reader: FeedReader, feed: Address, expiry: bigint): Promise<Hint | null> {
  const latest = await reader.latest(feed);
  if (latest === null || latest.updatedAt < expiry) return null;
  const seen = new Map<bigint, RoundInfo | null>([[latest.roundId, latest]]);
  const round = async (id: bigint): Promise<RoundInfo | null> => {
    let r = seen.get(id);
    if (r === undefined) {
      r = await reader.round(feed, id);
      seen.set(id, r);
    }
    return r;
  };

  const lowest = phaseBase(latest.roundId) + 1n;
  let hi = latest.roundId; // invariant: round `hi` exists and updatedAt(hi) >= expiry
  let missing: bigint | undefined;
  for (let attempt = 0; attempt < 8; attempt++) {
    let lo = lowest - 1n;
    let loMissing = true;
    while (hi - lo > 1n) {
      const mid = lo + (hi - lo) / 2n;
      const r = await round(mid);
      if (r !== null && r.updatedAt >= expiry) hi = mid;
      else {
        lo = mid;
        loMissing = r === null;
      }
    }
    missing = loMissing && hi !== lowest ? lo : undefined;
    if (missing === undefined) break;
    // `hi - 1` is missing. If an earlier post-expiry round sits below the hole, search again below it.
    let below: RoundInfo | null = null;
    let belowId = lo - 1n;
    for (let n = 0; n < GAP_PROBE && belowId >= lowest; n++, belowId--) {
      below = await round(belowId);
      if (below !== null) break;
    }
    if (below === null || below.updatedAt < expiry) break;
    hi = belowId;
  }

  // settleAt needs a valid answer: step up over invalid post-expiry rounds to the first valid one,
  // the round the market's own walk settles at. A missing id on the way is another hole.
  let roundId = hi;
  for (let i = 0; ; i++, roundId++) {
    const r = await round(roundId);
    if (r !== null && r.valid) break;
    if (r === null) missing = roundId;
    if (roundId >= latest.roundId || i >= MAX_WALK) {
      throw new Error(`no valid answer at/after expiry ${expiry}: rounds #${indexOf(hi)}..#${indexOf(roundId)} are invalid or missing`);
    }
  }
  return missing === undefined ? { roundId } : { roundId, missing };
}
