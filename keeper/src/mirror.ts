/**
 * Feed mirror relayer.
 *
 * Replays Robinhood Chain *mainnet* Chainlink tokenized-equity rounds onto the testnet FeedMirror
 * contracts, round-for-round (same roundId / answer / updatedAt), and copies each mainnet Stock
 * Token's corporate-action `oraclePaused()` flag onto its mirror. The testnet therefore sees real
 * 24/5 market data, including the weekend freeze that AfterHours prices.
 *
 *   pnpm mirror          # backfill, then poll forever
 *   pnpm mirror:once     # backfill + single sync (for cron)
 *
 * Mainnet round scanning rules (scan.ts):
 *   - Nothing is read or pushed when the mirror already holds the mainnet head round.
 *   - A scan never leaves the phase it starts in (round id >> 64) and never goes below aggregator
 *     index 1. At most SCAN_LIMIT round ids are read per feed per sync; a mirror further behind is
 *     caught up oldest window first, so it never skips ids.
 *   - Every round FeedMirror can store is replayed verbatim, including invalid answers (>= 1e14,
 *     e.g. the 16-decimal genesis rounds): ids stay contiguous and the market skips them exactly as
 *     it would on mainnet. Nothing is ever rescaled.
 *   - Rounds FeedMirror cannot store (empty, answer <= 0, reverting) are holes: skipped and logged,
 *     never the end of a scan. The market steps over them like any other invalid round.
 *   - A failed RPC request aborts the sync for that feed (nothing is pushed) and the same range is
 *     re-read on the next pass, so a flaky RPC never leaves a gap behind a moved-on latestRound.
 */
import { createPublicClient, createWalletClient, http, type Address, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MAINNET_FEEDS, MAINNET_STOCK_TOKENS, loadDeployment, relayerKey, robinhoodMainnet, robinhoodTestnet } from "./config.js";
import { aggregatorAbi, feedMirrorAbi, stockTokenAbi } from "./abi.js";
import { collect, type Round, type RoundReader, type ScanOptions } from "./scan.js";
import { errMsg, indexOf, isValidAnswer, sleep } from "./util.js";

// The pricer reads `lookback` = 120 rounds; a little extra covers the settlement walk-back.
const BACKFILL_ROUNDS = Number(process.env.BACKFILL_ROUNDS ?? 150);
/// Hard cap on mainnet round ids read per feed per sync.
const SCAN_LIMIT = BigInt(process.env.SCAN_LIMIT ?? 2_000);
const BATCH = 60;
const CHUNK = 100n;
const POLL_MS = Number(process.env.POLL_MS ?? 60_000);
const once = process.argv.includes("--once");
const scanOptions: ScanOptions = { scanLimit: SCAN_LIMIT, chunk: CHUNK, backfill: BACKFILL_ROUNDS };

const mainnet = createPublicClient({ chain: robinhoodMainnet, transport: http() });
const testnet = createPublicClient({ chain: robinhoodTestnet, transport: http() });
const account = privateKeyToAccount(relayerKey());
const wallet = createWalletClient({ account, chain: robinhoodTestnet, transport: http() });

type Target = { symbol: string; feed: Address; token: Address; mirror: Address };
/// Mainnet state for one underlying, read in a single Multicall3 snapshot. `null` = read failed.
type Head = { latest: Round | null; paused: boolean | null };

/** Latest mainnet round and Stock Token pause flag for every target (two Multicall3 calls). */
async function readHeads(targets: Target[]): Promise<Head[]> {
  const [rounds, paused] = await Promise.all([
    mainnet.multicall({
      contracts: targets.map((t) => ({ address: t.feed, abi: aggregatorAbi, functionName: "latestRoundData" as const })),
      allowFailure: true,
    }),
    mainnet.multicall({
      contracts: targets.map((t) => ({ address: t.token, abi: stockTokenAbi, functionName: "oraclePaused" as const })),
      allowFailure: true,
    }),
  ]);
  return targets.map((_, i) => {
    const r = rounds[i];
    const p = paused[i];
    let latest: Round | null = null;
    if (r.status === "success") {
      const [roundId, answer, , updatedAt] = r.result;
      if (updatedAt > 0n) latest = { roundId, answer, updatedAt };
    }
    return { latest, paused: p.status === "success" ? p.result : null };
  });
}

/** getRoundData for every id on `feed` in one Multicall3 request; failures are reported per call. */
const readRounds: RoundReader = (feed, ids) =>
  mainnet.multicall({
    contracts: ids.map((rid) => ({ address: feed, abi: aggregatorAbi, functionName: "getRoundData" as const, args: [rid] as const })),
    allowFailure: true,
  });

async function confirm(hash: Hash): Promise<void> {
  const receipt = await testnet.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx ${hash} reverted`);
}

async function setPaused(t: Target, paused: boolean): Promise<void> {
  const hash = await wallet.writeContract({ address: t.mirror, abi: feedMirrorAbi, functionName: "setPaused", args: [paused] });
  await confirm(hash);
  console.log(`[${t.symbol}] mirror oraclePaused -> ${paused} (mainnet Stock Token ${paused ? "paused for a corporate action" : "resumed"}) (${hash.slice(0, 10)})`);
}

async function push(t: Target, rounds: Round[]): Promise<void> {
  for (let i = 0; i < rounds.length; i += BATCH) {
    const chunk = rounds.slice(i, i + BATCH);
    const hash = await wallet.writeContract({
      address: t.mirror,
      abi: feedMirrorAbi,
      functionName: "pushRounds",
      args: [chunk.map((r) => r.roundId), chunk.map((r) => r.answer), chunk.map((r) => r.updatedAt)],
    });
    await confirm(hash);
    const last = chunk[chunk.length - 1];
    const price = isValidAnswer(last.answer) ? `$${(Number(last.answer) / 1e8).toFixed(2)}` : `invalid answer ${last.answer}`;
    console.log(
      `[${t.symbol}] pushed ${chunk.length} rounds -> #${indexOf(last.roundId)} ${price} @ ${new Date(Number(last.updatedAt) * 1000).toISOString()} (${hash.slice(0, 10)})`,
    );
  }
}

async function sync(t: Target, head: Head): Promise<void> {
  const [mirrorLatest, mirrorPaused] = await Promise.all([
    testnet.readContract({ address: t.mirror, abi: feedMirrorAbi, functionName: "latestRound" }),
    testnet.readContract({ address: t.mirror, abi: feedMirrorAbi, functionName: "oraclePaused" }),
  ]);
  if (head.paused === null) console.warn(`[${t.symbol}] oraclePaused() unreadable on mainnet Stock Token; mirror flag left at ${mirrorPaused}`);
  if (head.latest === null) console.warn(`[${t.symbol}] mainnet latestRoundData unavailable; no rounds this pass`);

  // A pause lands before the new rounds and an unpause after them, so the mirror never looks live
  // with only part of a corporate action applied.
  if (head.paused === true && !mirrorPaused) await setPaused(t, true);
  if (head.latest !== null) {
    if (head.latest.roundId <= mirrorLatest) console.log(`[${t.symbol}] up to date`);
    else await push(t, await collect(readRounds, t.symbol, t.feed, head.latest.roundId, mirrorLatest, scanOptions));
  }
  if (head.paused === false && mirrorPaused) await setPaused(t, false);
}

async function main() {
  const dep = loadDeployment();
  const targets: Target[] = [];
  for (const u of Object.values(dep.underlyings)) {
    const feed = MAINNET_FEEDS[u.symbol];
    const token = MAINNET_STOCK_TOKENS[u.symbol];
    if (!feed || !token) {
      console.warn(`[${u.symbol}] no mainnet feed / Stock Token configured; skipping`);
      continue;
    }
    targets.push({ symbol: u.symbol, feed, token, mirror: u.feed });
  }
  console.log(`relayer ${account.address}; mirroring ${targets.map((t) => t.symbol).join(", ")}`);
  for (;;) {
    try {
      const heads = await readHeads(targets);
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        try {
          await sync(t, heads[i]);
        } catch (e) {
          console.error(`[${t.symbol}] sync failed: ${errMsg(e)}`);
        }
      }
    } catch (e) {
      console.error(`mainnet read failed: ${errMsg(e)}`);
    }
    if (once) return;
    await sleep(POLL_MS);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
