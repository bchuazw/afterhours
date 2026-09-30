/**
 * Settlement bot: finds expired, unsettled series and settles them. Anyone can do this.
 *
 *   - `settle(id)` walks the feed back from its latest round to the first print at/after expiry.
 *     When that walk is longer than the market allows (SettleWalkTooLong) the bot finds the round
 *     off-chain (hint.ts) and calls `settleAt(id, roundId)`, which the market verifies against the
 *     round's predecessors. A mirror hole among them is a certain BadRoundHint, so it is reported
 *     as a gap that needs a manual backfill instead of being simulated on every pass.
 *   - AwaitingPostExpiryPrint (no print since expiry yet, e.g. over the weekend) and FeedPaused
 *     (corporate action) are expected states: the series is simply retried on the next pass.
 *   - Errors are contained per series and per pass; RPC failures never end the loop.
 *
 *   pnpm settle          # poll forever
 *   pnpm settle:once     # single pass (for cron)
 */
import { createPublicClient, createWalletClient, http, parseAbiItem, type Address, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { LEGACY_MARKETS, loadDeployment, relayerKey, robinhoodTestnet, type Deployment } from "./config.js";
import { feedMirrorAbi, marketAbi } from "./abi.js";
import { findSettleRound, type FeedReader } from "./hint.js";
import { errMsg, indexOf, isRevert, isValidAnswer, revertName, short, sleep } from "./util.js";

const once = process.argv.includes("--once");
const POLL_MS = Number(process.env.POLL_MS ?? 120_000);
/// eth_getLogs block span; shrinks automatically when the RPC rejects a range, then regrows.
const LOG_SPAN = BigInt(process.env.LOG_SPAN ?? 50_000);
const MIN_LOG_SPAN = 500n;

const client = createPublicClient({ chain: robinhoodTestnet, transport: http() });
const account = privateKeyToAccount(relayerKey());
const wallet = createWalletClient({ account, chain: robinhoodTestnet, transport: http() });

const boughtEvent = parseAbiItem(
  "event ProtectionBought(uint256 indexed seriesId, address indexed buyer, uint32 indexed underlyingId, uint256 strike, uint64 expiry, uint256 units, uint256 premium, uint256 fee, uint256 spot, uint256 vol)",
);

type Open = { id: bigint; underlyingId: number; expiry: bigint };
type Outcome = "settled" | "awaiting" | "paused" | "gap" | "gone";

/// Series seen in ProtectionBought logs and not yet known to be settled, plus the log cursor.
/// One such state per market: the current deployment and any legacy markets (LEGACY_MARKETS) that
/// still have open series.
type MarketState = { nextBlock: bigint; span: bigint; open: Map<bigint, Open> };
const states = new Map<Address, MarketState>();
let market: Address | undefined;
let nextBlock = 0n;
let span = LOG_SPAN;
let open = new Map<bigint, Open>();

/** Point the module-level cursor/state at `addr` (creating it on first use). */
function selectMarket(addr: Address, deployBlock: number): void {
  if (market) states.set(market, { nextBlock, span, open });
  const s = states.get(addr) ?? { nextBlock: BigInt(deployBlock), span: LOG_SPAN, open: new Map<bigint, Open>() };
  market = addr;
  nextBlock = s.nextBlock;
  span = s.span;
  open = s.open;
}

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
 * Feed access for the hint search. A revert (FeedMirror's NoData) or an empty round means the feed
 * has no such round; transport errors are rethrown so a flaky RPC can never pass for a missing one.
 */
const reader: FeedReader = {
  async latest(feed) {
    try {
      const [roundId, answer, , updatedAt] = await client.readContract({ address: feed, abi: feedMirrorAbi, functionName: "latestRoundData" });
      return updatedAt > 0n ? { roundId, updatedAt, valid: isValidAnswer(answer) } : null;
    } catch (e) {
      if (isRevert(e)) return null; // empty mirror
      throw e;
    }
  },
  async round(feed, roundId) {
    try {
      const [rid, answer, , updatedAt] = await client.readContract({ address: feed, abi: feedMirrorAbi, functionName: "getRoundData", args: [roundId] });
      return rid === roundId && updatedAt > 0n ? { updatedAt, valid: isValidAnswer(answer) } : null;
    } catch (e) {
      if (isRevert(e)) return null;
      throw e;
    }
  },
};

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
  const hint = await findSettleRound(reader, u.feed, s.expiry);
  if (!hint) throw new Error(`SettleWalkTooLong, but the ${symbol} feed has no round at/after expiry ${s.expiry}`);
  const gap = hint.missing === undefined ? null : `mirror gap at #${indexOf(hint.missing)} below settlement round #${indexOf(hint.roundId)}; manual backfill needed`;
  // settleAt checks the hint's predecessors down to the last pre-expiry print, so a hole among them
  // is a certain BadRoundHint until the grace period has passed; after that the market may accept
  // the hint over the hole, so it is offered once per pass.
  if (gap && now < s.expiry + s.grace) {
    console.warn(`series ${short(id)} (${symbol}): ${gap}`);
    return "gap";
  }
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
    console.log(`settled series ${short(id)} (${symbol}) via settleAt(#${indexOf(hint.roundId)}${gap ? ", over a mirror gap" : ""}) (${hash.slice(0, 10)})`);
    return "settled";
  } catch (e) {
    const quiet = quietOutcome(e, id);
    if (quiet) return quiet;
    if (gap && revertName(e) === "BadRoundHint") {
      console.warn(`series ${short(id)} (${symbol}): ${gap}`);
      return "gap";
    }
    throw new Error(`settleAt(#${indexOf(hint.roundId)}) failed: ${errMsg(e)}`);
  }
}

async function pass(): Promise<void> {
  const current = loadDeployment();
  // Legacy markets share the deployment's feeds/vault layout; only the market address differs.
  const targets = [current, ...LEGACY_MARKETS.filter((m) => m.toLowerCase() !== current.market.toLowerCase()).map((m) => ({ ...current, market: m }))];
  const { timestamp: now } = await client.getBlock();
  for (const dep of targets) {
    selectMarket(dep.market, dep.deployBlock);
    await discover(dep);
    const due = [...open.values()].filter((o) => o.expiry <= now);
    const tally = { settled: 0, awaiting: 0, paused: 0, gap: 0, failed: 0 };
    for (const o of due) {
      try {
        const outcome = await settleOne(dep, o.id, now);
        if (outcome !== "gone") tally[outcome]++;
      } catch (e) {
        tally.failed++;
        console.error(`series ${short(o.id)}: ${errMsg(e)}`);
      }
    }
    const pending = tally.settled + tally.awaiting + tally.paused + tally.gap + tally.failed;
    if (pending > 0) {
      console.log(
        `pass (${dep.market.slice(0, 10)}…): ${pending} expired open series; settled ${tally.settled}, awaiting post-expiry print ${tally.awaiting}, feed paused ${tally.paused}, mirror gap ${tally.gap}, failed ${tally.failed}`,
      );
    }
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
