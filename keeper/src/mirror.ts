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
 * Mainnet round scanning rules:
 *   - Nothing is read or pushed when the mirror already holds the mainnet head round.
 *   - A scan never leaves the phase it starts in (round id >> 64) and never goes below aggregator
 *     index 1. A reverted call, or a round with updatedAt == 0 or answer == 0, ends the scan.
 *   - Answers <= 0 or >= 1e14 (>= $1M at 8 decimals, e.g. 16-decimal genesis rounds) are skipped,
 *     never rescaled or pushed.
 *   - At most SCAN_LIMIT round ids are read per feed per sync, however many rounds are kept.
 */
import { createPublicClient, createWalletClient, http, type Address, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MAINNET_FEEDS, MAINNET_STOCK_TOKENS, loadDeployment, relayerKey, robinhoodMainnet, robinhoodTestnet } from "./config.js";
import { aggregatorAbi, feedMirrorAbi, stockTokenAbi } from "./abi.js";
import { errMsg, indexOf, isValidAnswer, phaseBase, phaseOf, sleep } from "./util.js";

// The pricer reads `lookback` = 120 rounds; a little extra covers the settlement walk-back.
const BACKFILL_ROUNDS = Number(process.env.BACKFILL_ROUNDS ?? 150);
/// Hard cap on mainnet round ids read per feed per sync.
const SCAN_LIMIT = BigInt(process.env.SCAN_LIMIT ?? 2_000);
const BATCH = 60;
const CHUNK = 100n;
const POLL_MS = Number(process.env.POLL_MS ?? 60_000);
const once = process.argv.includes("--once");

const mainnet = createPublicClient({ chain: robinhoodMainnet, transport: http() });
const testnet = createPublicClient({ chain: robinhoodTestnet, transport: http() });
const account = privateKeyToAccount(relayerKey());
const wallet = createWalletClient({ account, chain: robinhoodTestnet, transport: http() });

type Round = { roundId: bigint; answer: bigint; updatedAt: bigint };
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

/**
 * Read mainnet rounds downward from `start` (inclusive) to `floor` (exclusive), returned
 * oldest-first. Stops at the first terminal boundary (see the header) or after SCAN_LIMIT ids.
 */
async function scanDown(feed: Address, start: bigint, floor: bigint, keep: number) {
  const phase = phaseOf(start);
  const out: Round[] = [];
  let skipped = 0;
  let scanned = 0n;
  let id = start;
  let stop = "";
  while (!stop) {
    if (id <= floor) {
      stop = "floor";
      break;
    }
    if (scanned >= SCAN_LIMIT) {
      stop = "scan limit";
      break;
    }
    const n = [CHUNK, id - floor, SCAN_LIMIT - scanned].reduce((a, b) => (a < b ? a : b));
    const ids = Array.from({ length: Number(n) }, (_, i) => id - BigInt(i));
    const res = await mainnet.multicall({
      contracts: ids.map((rid) => ({ address: feed, abi: aggregatorAbi, functionName: "getRoundData" as const, args: [rid] as const })),
      allowFailure: true,
    });
    for (let i = 0; i < ids.length && !stop; i++) {
      scanned++;
      const r = res[i];
      if (r.status !== "success") {
        stop = "call reverted";
        break;
      }
      const [rid, answer, , updatedAt] = r.result;
      if (updatedAt === 0n || answer === 0n) stop = "empty round";
      else if (rid !== ids[i] || phaseOf(rid) !== phase) stop = "round id mismatch";
      else if (!isValidAnswer(answer)) skipped++;
      else {
        out.push({ roundId: rid, answer, updatedAt });
        if (out.length >= keep) stop = "enough";
      }
    }
    id -= n;
  }
  return { rounds: out.reverse(), skipped, scanned, stop };
}

/**
 * Collect the mainnet rounds the mirror is missing (roundId > `after`), oldest-first. Returns []
 * at once when the mirror already holds the mainnet head.
 */
async function collect(symbol: string, feed: Address, head: bigint, after: bigint): Promise<Round[]> {
  if (head <= after) return [];

  let start = head;
  let floor = phaseBase(head);
  let keep = Infinity;
  let catchingUp = false;
  if (after === 0n) {
    keep = BACKFILL_ROUNDS; // empty mirror: backfill the most recent history only
  } else if (phaseOf(after) === phaseOf(head)) {
    floor = after;
    if (head - after > SCAN_LIMIT) {
      // Far behind: replay the oldest missing window so the mirror stays gap-free (settlement
      // needs contiguous rounds around expiry); later polls continue from there.
      start = after + SCAN_LIMIT;
      catchingUp = true;
      console.log(`[${symbol}] mirror is ${head - after} rounds behind; replaying #${indexOf(after) + 1n}..#${indexOf(start)} first`);
    }
  } else {
    console.warn(`[${symbol}] mainnet feed moved to phase ${phaseOf(head)} (mirror at phase ${phaseOf(after)}); resyncing from the new phase`);
  }

  const { rounds, skipped, scanned, stop } = await scanDown(feed, start, floor, keep);
  if (skipped > 0) console.warn(`[${symbol}] skipped ${skipped} round(s) with invalid answers`);
  const reachedFloor = stop === "floor" || stop === "enough";
  if (!reachedFloor && !(catchingUp && stop === "scan limit")) {
    console.warn(`[${symbol}] scan stopped early (${stop}) after ${scanned} ids at #${indexOf(start)} and below; mirror may have a gap`);
  }
  return rounds;
}

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
    console.log(
      `[${t.symbol}] pushed ${chunk.length} rounds -> #${indexOf(last.roundId)} $${(Number(last.answer) / 1e8).toFixed(2)} @ ${new Date(Number(last.updatedAt) * 1000).toISOString()} (${hash.slice(0, 10)})`,
    );
  }
}

async function sync(t: Target, head: Head): Promise<number> {
  const [mirrorLatest, mirrorPaused] = await Promise.all([
    testnet.readContract({ address: t.mirror, abi: feedMirrorAbi, functionName: "latestRound" }),
    testnet.readContract({ address: t.mirror, abi: feedMirrorAbi, functionName: "oraclePaused" }),
  ]);
  if (head.paused === null) console.warn(`[${t.symbol}] oraclePaused() unreadable on mainnet Stock Token; mirror flag left at ${mirrorPaused}`);
  if (head.latest === null) console.warn(`[${t.symbol}] mainnet latestRoundData unavailable; no rounds this pass`);

  // A pause lands before the new rounds and an unpause after them, so the mirror never looks live
  // with only part of a corporate action applied.
  if (head.paused === true && !mirrorPaused) await setPaused(t, true);
  const rounds = head.latest ? await collect(t.symbol, t.feed, head.latest.roundId, mirrorLatest) : [];
  await push(t, rounds);
  if (head.paused === false && mirrorPaused) await setPaused(t, false);
  return rounds.length;
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
          const n = await sync(t, heads[i]);
          if (n === 0 && heads[i].latest) console.log(`[${t.symbol}] up to date`);
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
