/**
 * Settlement bot: finds expired, unsettled series and settles them. Anyone can do this.
 *
 *   - `settle(id)` walks the feed back from its latest round to the first print at/after expiry.
 *     When that walk is longer than the market allows (SettleWalkTooLong) the bot finds the round
 *     off-chain and calls `settleAt(id, roundId)`, which the market verifies.
 *   - AwaitingPostExpiryPrint (no print since expiry yet, e.g. over the weekend) and FeedPaused
 *     (corporate action) are expected states: the series is simply retried on the next pass.
 *   - Errors are contained per series and per pass; RPC failures never end the loop.
 *
 *   pnpm settle          # poll forever
 *   pnpm settle:once     # single pass (for cron)
 */
import { createPublicClient, createWalletClient, http, parseAbiItem, type Address, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadDeployment, relayerKey, robinhoodTestnet, type Deployment } from "./config.js";
import { feedMirrorAbi, marketAbi } from "./abi.js";
import { errMsg, indexOf, isRevert, isValidAnswer, phaseBase, revertName, short, sleep } from "./util.js";

const once = process.argv.includes("--once");
const POLL_MS = Number(process.env.POLL_MS ?? 120_000);
/// eth_getLogs block span; shrinks automatically when the RPC rejects a range, then regrows.
const LOG_SPAN = BigInt(process.env.LOG_SPAN ?? 50_000);
const MIN_LOG_SPAN = 500n;
/// When the round just before a settlement candidate is missing, probe this many ids further down.
const GAP_PROBE = 64;

const client = createPublicClient({ chain: robinhoodTestnet, transport: http() });
const account = privateKeyToAccount(relayerKey());
const wallet = createWalletClient({ account, chain: robinhoodTestnet, transport: http() });

const boughtEvent = parseAbiItem(
  "event ProtectionBought(uint256 indexed seriesId, address indexed buyer, uint32 indexed underlyingId, uint256 strike, uint64 expiry, uint256 units, uint256 premium, uint256 fee, uint256 spot, uint256 vol)",
);

type Open = { id: bigint; underlyingId: number; expiry: bigint };
type Outcome = "settled" | "awaiting" | "paused" | "gone";

/// Series seen in ProtectionBought logs and not yet known to be settled, plus the log cursor.
let market: Address | undefined;
let nextBlock = 0n;
let span = LOG_SPAN;
const open = new Map<bigint, Open>();

/** Scan ProtectionBought logs incrementally, in block ranges the RPC accepts. */
async function discover(dep: Deployment): Promise<void> {
  if (market !== dep.market) {
    market = dep.market;
    nextBlock = BigInt(dep.deployBlock);
    open.clear();
  }
  const head = await client.getBlockNumber();
  while (nextBlock <= head) {
    const to = nextBlock + span - 1n < head ? nextBlock + span - 1n : head;
    let logs;
    try {
      logs = await client.getLogs({ address: dep.market, event: boughtEvent, fromBlock: nextBlock, toBlock: to });
    } catch (e) {
      if (span <= MIN_LOG_SPAN) throw e;
      span = span / 4n > MIN_LOG_SPAN ? span / 4n : MIN_LOG_SPAN;
      continue;
    }
    for (const l of logs) {
      const { seriesId, underlyingId, expiry } = l.args;
      if (seriesId === undefined || underlyingId === undefined || expiry === undefined) continue;
      if (!open.has(seriesId)) open.set(seriesId, { id: seriesId, underlyingId, expiry });
    }
    nextBlock = to + 1n;
    if (span < LOG_SPAN) span = span * 2n < LOG_SPAN ? span * 2n : LOG_SPAN;
  }
}

async function confirm(hash: Hash): Promise<void> {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx ${hash} reverted`);
}

/** Expected, retry-later reverts. Returns null for anything that deserves a log line. */
function quietOutcome(e: unknown, id: bigint): Outcome | null {
  switch (revertName(e)) {
    case "AwaitingPostExpiryPrint":
    case "NotExpired":
      return "awaiting";
    case "FeedPaused":
      return "paused";
    case "AlreadySettled":
      open.delete(id);
      return "gone";
    default:
      return null;
  }
}

/**
 * updatedAt of `roundId` on `feed`, or null when the feed has no usable round there (the call
 * reverts, as FeedMirror does, or returns an empty round, as an OCR2 aggregator does). Transport
 * errors are rethrown so a flaky RPC can never pass for a missing round.
 */
async function updatedAtOf(feed: Address, roundId: bigint): Promise<bigint | null> {
  try {
    const [rid, answer, , updatedAt] = await client.readContract({
      address: feed,
      abi: feedMirrorAbi,
      functionName: "getRoundData",
      args: [roundId],
    });
    return rid === roundId && updatedAt > 0n && isValidAnswer(answer) ? updatedAt : null;
  } catch (e) {
    if (isRevert(e)) return null;
    throw e;
  }
}

/**
 * First round on `feed` with updatedAt >= expiry whose predecessor has updatedAt < expiry: the
 * round `settleAt` expects. Binary search within the latest round's phase, treating missing ids
 * (before the mirrored history, or skipped invalid answers) as pre-expiry, then verifying the
 * predecessor. `exact` is false when the predecessor is missing and the round is the earliest
 * post-expiry round that could be found. Returns null if the feed has not printed since expiry.
 */
async function findSettleRound(feed: Address, expiry: bigint): Promise<{ roundId: bigint; exact: boolean } | null> {
  let latestId: bigint;
  let latestAt: bigint;
  try {
    [latestId, , , latestAt] = await client.readContract({ address: feed, abi: feedMirrorAbi, functionName: "latestRoundData" });
  } catch (e) {
    if (isRevert(e)) return null; // empty mirror
    throw e;
  }
  if (latestAt < expiry) return null;
  const lowest = phaseBase(latestId) + 1n;
  let hi = latestId; // invariant: round `hi` exists and updatedAt(hi) >= expiry
  for (let attempt = 0; attempt < 8; attempt++) {
    let lo = lowest - 1n;
    let loMissing = true;
    while (hi - lo > 1n) {
      const mid = lo + (hi - lo) / 2n;
      const t = await updatedAtOf(feed, mid);
      if (t !== null && t >= expiry) hi = mid;
      else {
        lo = mid;
        loMissing = t === null;
      }
    }
    if (!loMissing) return { roundId: hi, exact: true };
    // `hi - 1` is missing. If an earlier post-expiry round sits below the hole, search again below it.
    let below: bigint | null = null;
    let belowId = lo - 1n;
    for (let n = 0; n < GAP_PROBE && belowId >= lowest; n++, belowId--) {
      below = await updatedAtOf(feed, belowId);
      if (below !== null) break;
    }
    if (below === null || below < expiry) return { roundId: hi, exact: false };
    hi = belowId;
  }
  return { roundId: hi, exact: false };
}

function underlyingOf(dep: Deployment, underlyingId: number) {
  return Object.values(dep.underlyings).find((x) => x.id === underlyingId);
}

async function settleOne(dep: Deployment, id: bigint, now: bigint): Promise<Outcome> {
  const s = await client.readContract({ address: dep.market, abi: marketAbi, functionName: "getSeries", args: [id] });
  if (s.settled || s.expiry === 0n) {
    open.delete(id);
    return "gone";
  }
  if (s.expiry > now) return "awaiting";
  const u = underlyingOf(dep, s.underlyingId);
  const symbol = u?.symbol ?? `underlying ${s.underlyingId}`;

  try {
    const { request } = await client.simulateContract({ address: dep.market, abi: marketAbi, functionName: "settle", args: [id], account });
    const hash = await wallet.writeContract(request);
    await confirm(hash);
    open.delete(id);
    console.log(`settled series ${short(id)} (${symbol}) (${hash.slice(0, 10)})`);
    return "settled";
  } catch (e) {
    const quiet = quietOutcome(e, id);
    if (quiet) return quiet;
    if (revertName(e) !== "SettleWalkTooLong") throw e;
  }

  // The on-chain walk-back from the latest round is capped; locate the first post-expiry round here.
  if (!u) throw new Error(`SettleWalkTooLong, but ${symbol} is missing from deployments/${dep.chainId}.json`);
  const hint = await findSettleRound(u.feed, s.expiry);
  if (!hint) throw new Error(`SettleWalkTooLong, but the ${symbol} feed has no round at/after expiry ${s.expiry}`);
  try {
    const { request } = await client.simulateContract({
      address: dep.market,
      abi: marketAbi,
      functionName: "settleAt",
      args: [id, hint.roundId],
      account,
    });
    const hash = await wallet.writeContract(request);
    await confirm(hash);
    open.delete(id);
    console.log(
      `settled series ${short(id)} (${symbol}) via settleAt(#${indexOf(hint.roundId)}${hint.exact ? "" : ", predecessor missing"}) (${hash.slice(0, 10)})`,
    );
    return "settled";
  } catch (e) {
    const quiet = quietOutcome(e, id);
    if (quiet) return quiet;
    throw new Error(`settleAt(#${indexOf(hint.roundId)}) failed: ${errMsg(e)}`);
  }
}

async function pass(): Promise<void> {
  const dep = loadDeployment();
  await discover(dep);
  const { timestamp: now } = await client.getBlock();
  const due = [...open.values()].filter((o) => o.expiry <= now);
  const tally = { settled: 0, awaiting: 0, paused: 0, failed: 0 };
  for (const o of due) {
    try {
      const outcome = await settleOne(dep, o.id, now);
      if (outcome !== "gone") tally[outcome]++;
    } catch (e) {
      tally.failed++;
      console.error(`series ${short(o.id)}: ${errMsg(e)}`);
    }
  }
  const pending = tally.settled + tally.awaiting + tally.paused + tally.failed;
  if (pending > 0) {
    console.log(
      `pass: ${pending} expired open series; settled ${tally.settled}, awaiting post-expiry print ${tally.awaiting}, feed paused ${tally.paused}, failed ${tally.failed}`,
    );
  }
}

async function main() {
  console.log(`settler ${account.address} on chain ${robinhoodTestnet.id}`);
  for (;;) {
    try {
      await pass();
    } catch (e) {
      console.error(`settle pass failed: ${errMsg(e)}`);
    }
    if (once) return;
    await sleep(POLL_MS);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
