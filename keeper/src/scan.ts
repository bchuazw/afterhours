/**
 * Mainnet round scanning for the feed mirror relayer (mirror.ts). Kept free of RPC clients so the
 * scan can be exercised against a scripted feed (scan.test.ts).
 *
 * Rules:
 *   - A scan never leaves the phase it starts in (round id >> 64) and never goes below aggregator
 *     index 1. At most `scanLimit` round ids are read per call; a mirror further behind is caught
 *     up oldest window first, so it never skips ids.
 *   - Every round FeedMirror can store is replayed verbatim, including invalid answers (>= 1e14,
 *     e.g. the 16-decimal genesis rounds): ids stay contiguous and the market skips them exactly as
 *     it would on mainnet. Nothing is ever rescaled.
 *   - Rounds FeedMirror cannot store (updatedAt == 0, answer <= 0 or > int192.max, a reverting id,
 *     a proxy answering with another id) are holes: skipped and reported, never the end of a scan.
 *   - A failed RPC request throws, so the caller pushes nothing and re-reads the same range on its
 *     next pass. A flaky RPC therefore never leaves a hole behind a moved-on latestRound.
 */
import type { Address } from "viem";
import { indexOf, isRevert, isValidAnswer, phaseBase, phaseOf } from "./util.js";

export type Round = { roundId: bigint; answer: bigint; updatedAt: bigint };
/// One getRoundData result, as viem's multicall reports it with `allowFailure: true`.
export type RoundRead =
  | { status: "success"; result: readonly [bigint, bigint, bigint, bigint, bigint] }
  | { status: "failure"; error: unknown };
/// getRoundData for every id on `feed` (one Multicall3 request), results in `ids` order.
export type RoundReader = (feed: Address, ids: bigint[]) => Promise<RoundRead[]>;
export type ScanOptions = {
  /// Hard cap on mainnet round ids read per feed per sync.
  scanLimit: bigint;
  /// Ids per Multicall3 request.
  chunk: bigint;
  /// Valid rounds an empty mirror is seeded with (the pricer's lookback plus the settlement walk-back).
  backfill: number;
};
export type Scan = {
  /// Oldest-first, ready to push.
  rounds: Round[];
  /// Rounds in `rounds` whose answer the market and pricer skip.
  invalid: number;
  /// Ids in the scanned range the mirror cannot store, ascending.
  holes: bigint[];
  scanned: bigint;
  stop: "floor" | "enough" | "scan limit";
};

/// Largest answer FeedMirror.pushRound stores (int192).
export const INT192_MAX = (1n << 191n) - 1n;
/// True when FeedMirror.pushRound accepts the round (its BadRound check).
export const isMirrorable = (answer: bigint, updatedAt: bigint): boolean => updatedAt > 0n && answer > 0n && answer <= INT192_MAX;

const min = (...xs: bigint[]): bigint => xs.reduce((a, b) => (a < b ? a : b));

/**
 * Read mainnet rounds downward from `start` (inclusive) to `floor` (exclusive), returned
 * oldest-first. Stops at the floor, once `keep` valid rounds are in hand, or after `scanLimit` ids.
 */
export async function scanDown(read: RoundReader, feed: Address, start: bigint, floor: bigint, keep: number, o: ScanOptions): Promise<Scan> {
  const phase = phaseOf(start);
  const out: Round[] = [];
  const holes: bigint[] = [];
  let invalid = 0;
  let valid = 0;
  let scanned = 0n;
  let id = start;
  let stop: Scan["stop"] | undefined;
  while (!stop) {
    if (id <= floor) {
      stop = "floor";
      break;
    }
    if (scanned >= o.scanLimit) {
      stop = "scan limit";
      break;
    }
    const n = min(o.chunk, id - floor, o.scanLimit - scanned);
    const ids = Array.from({ length: Number(n) }, (_, i) => id - BigInt(i));
    const res = await read(feed, ids);
    for (let i = 0; i < ids.length && !stop; i++) {
      scanned++;
      const r = res[i];
      if (r.status !== "success") {
        // viem reports a failed Multicall3 request (RPC error, timeout) as a failure of every call
        // in that request; only a genuine revert is a property of the round itself.
        if (!isRevert(r.error)) throw r.error;
        holes.push(ids[i]);
        continue;
      }
      const [rid, answer, , updatedAt] = r.result;
      if (rid !== ids[i] || phaseOf(rid) !== phase || !isMirrorable(answer, updatedAt)) {
        holes.push(ids[i]);
        continue;
      }
      out.push({ roundId: rid, answer, updatedAt });
      if (isValidAnswer(answer)) valid++;
      else invalid++;
      if (valid >= keep) stop = "enough";
    }
    id -= n;
  }
  return { rounds: out.reverse(), invalid, holes: holes.reverse(), scanned, stop };
}

/**
 * Collect the mainnet rounds the mirror is missing (roundId > `after`), oldest-first. Returns []
 * at once when the mirror already holds the mainnet head. Throws when a mainnet read fails, so the
 * caller pushes nothing this pass and re-reads the same range on the next one.
 */
export async function collect(read: RoundReader, symbol: string, feed: Address, head: bigint, after: bigint, o: ScanOptions): Promise<Round[]> {
  if (head <= after) return [];

  let start = head;
  let floor = phaseBase(head);
  let keep = Infinity;
  if (after === 0n) {
    keep = o.backfill; // empty mirror: backfill the most recent history only
  } else if (phaseOf(after) === phaseOf(head)) {
    floor = after;
  } else {
    console.warn(`[${symbol}] mainnet feed moved to phase ${phaseOf(head)} (mirror at phase ${phaseOf(after)}); replaying the new phase from its first round`);
  }
  if (keep === Infinity && head - floor > o.scanLimit) {
    // Far behind: replay the oldest missing window so the mirror stays gap-free (settlement needs
    // contiguous rounds around expiry); later polls continue from there.
    start = floor + o.scanLimit;
    console.log(`[${symbol}] mirror is ${head - floor} rounds behind; replaying #${indexOf(floor) + 1n}..#${indexOf(start)} first`);
  }

  const { rounds, invalid, holes, scanned, stop } = await scanDown(read, feed, start, floor, keep, o);
  if (invalid > 0) console.warn(`[${symbol}] ${invalid} round(s) with invalid answers mirrored verbatim; the market skips them`);
  if (holes.length > 0) {
    console.warn(`[${symbol}] ${holes.length} round(s) the mirror cannot store (empty, non-positive or reverting on mainnet) left as holes: ${describe(holes)}`);
  }
  if (stop === "scan limit") console.log(`[${symbol}] scan limit reached after ${scanned} ids; ${rounds.length} round(s) found`);
  return rounds;
}

function describe(ids: bigint[]): string {
  const shown = ids
    .slice(0, 5)
    .map((x) => `#${indexOf(x)}`)
    .join(", ");
  return ids.length > 5 ? `${shown} and ${ids.length - 5} more` : shown;
}
