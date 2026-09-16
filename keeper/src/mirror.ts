/**
 * Feed mirror relayer.
 *
 * Replays Robinhood Chain *mainnet* Chainlink tokenized-equity rounds onto the testnet FeedMirror
 * contracts, round-for-round (same roundId / answer / updatedAt). The testnet therefore sees real
 * 24/5 market data, including the weekend freeze that AfterHours prices.
 *
 *   pnpm mirror          # backfill, then poll forever
 *   pnpm mirror:once     # backfill + single sync (for cron)
 */
import { createPublicClient, createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MAINNET_FEEDS, loadDeployment, relayerKey, robinhoodMainnet, robinhoodTestnet } from "./config.js";
import { aggregatorAbi, feedMirrorAbi } from "./abi.js";

const BACKFILL_ROUNDS = Number(process.env.BACKFILL_ROUNDS ?? 400);
const BATCH = 60;
const POLL_MS = Number(process.env.POLL_MS ?? 60_000);
const once = process.argv.includes("--once");

const mainnet = createPublicClient({ chain: robinhoodMainnet, transport: http() });
const testnet = createPublicClient({ chain: robinhoodTestnet, transport: http() });
const account = privateKeyToAccount(relayerKey());
const wallet = createWalletClient({ account, chain: robinhoodTestnet, transport: http() });

type Round = { roundId: bigint; answer: bigint; updatedAt: bigint };

async function readRound(feed: Address, roundId?: bigint): Promise<Round | null> {
  try {
    const r =
      roundId === undefined
        ? await mainnet.readContract({ address: feed, abi: aggregatorAbi, functionName: "latestRoundData" })
        : await mainnet.readContract({ address: feed, abi: aggregatorAbi, functionName: "getRoundData", args: [roundId] });
    const [id, answer, , updatedAt] = r;
    if (answer <= 0n || updatedAt === 0n) return null;
    return { roundId: id, answer, updatedAt };
  } catch {
    return null;
  }
}

/** Collect mainnet rounds with roundId > `after`, returned oldest-first. Uses Multicall3 in chunks. */
async function collect(feed: Address, after: bigint, max: number): Promise<Round[]> {
  const latest = await readRound(feed);
  if (!latest) return [];
  const out: Round[] = [latest];
  let id = latest.roundId - 1n;
  const CHUNK = 100n;
  outer: while (id > after && out.length < max) {
    const n = Number([CHUNK, id - after, BigInt(max - out.length)].reduce((a, b) => (a < b ? a : b)));
    const ids = Array.from({ length: n }, (_, i) => id - BigInt(i));
    const res = await mainnet.multicall({
      contracts: ids.map((rid) => ({ address: feed, abi: aggregatorAbi, functionName: "getRoundData" as const, args: [rid] })),
      allowFailure: true,
    });
    for (let i = 0; i < res.length; i++) {
      const r = res[i];
      if (r.status !== "success") break outer; // phase boundary / missing round
      const [rid, answer, , updatedAt] = r.result;
      if (answer > 0n && updatedAt > 0n) out.push({ roundId: rid, answer, updatedAt });
    }
    id -= BigInt(n);
  }
  return out.reverse();
}

async function sync(symbol: string, mainnetFeed: Address, mirror: Address): Promise<number> {
  const mirrorLatest = await testnet.readContract({ address: mirror, abi: feedMirrorAbi, functionName: "latestRound" });
  const rounds = await collect(mainnetFeed, mirrorLatest, mirrorLatest === 0n ? BACKFILL_ROUNDS : 10_000);
  if (rounds.length === 0) return 0;
  for (let i = 0; i < rounds.length; i += BATCH) {
    const chunk = rounds.slice(i, i + BATCH);
    const hash = await wallet.writeContract({
      address: mirror,
      abi: feedMirrorAbi,
      functionName: "pushRounds",
      args: [chunk.map((r) => r.roundId), chunk.map((r) => r.answer), chunk.map((r) => r.updatedAt)],
    });
    await testnet.waitForTransactionReceipt({ hash });
    const last = chunk[chunk.length - 1];
    console.log(
      `[${symbol}] pushed ${chunk.length} rounds -> #${last.roundId & ((1n << 64n) - 1n)} $${(Number(last.answer) / 1e8).toFixed(2)} @ ${new Date(Number(last.updatedAt) * 1000).toISOString()} (${hash.slice(0, 10)})`,
    );
  }
  return rounds.length;
}

async function main() {
  const dep = loadDeployment();
  const targets = Object.values(dep.underlyings).map((u) => ({ symbol: u.symbol, mainnet: MAINNET_FEEDS[u.symbol], mirror: u.feed }));
  console.log(`relayer ${account.address}; mirroring ${targets.map((t) => t.symbol).join(", ")}`);
  for (;;) {
    for (const t of targets) {
      try {
        const n = await sync(t.symbol, t.mainnet, t.mirror);
        if (n === 0) console.log(`[${t.symbol}] up to date`);
      } catch (e) {
        console.error(`[${t.symbol}] sync failed:`, (e as Error).message);
      }
    }
    if (once) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
