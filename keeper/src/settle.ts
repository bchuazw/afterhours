/**
 * Settlement bot: finds expired, unsettled series and calls `settle`. Anyone can do this; the
 * market only accepts the first feed print at/after expiry, so the bot simply retries until the
 * feed produces one (or the grace window elapses and the fallback applies).
 */
import { createPublicClient, createWalletClient, http, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadDeployment, relayerKey, robinhoodTestnet } from "./config.js";
import { marketAbi } from "./abi.js";

const once = process.argv.includes("--once");
const POLL_MS = Number(process.env.POLL_MS ?? 120_000);

const client = createPublicClient({ chain: robinhoodTestnet, transport: http() });
const account = privateKeyToAccount(relayerKey());
const wallet = createWalletClient({ account, chain: robinhoodTestnet, transport: http() });

async function pass() {
  const dep = loadDeployment();
  const bought = await client.getLogs({
    address: dep.market,
    event: parseAbiItem(
      "event ProtectionBought(uint256 indexed seriesId, address indexed buyer, uint32 indexed underlyingId, uint256 strike, uint64 expiry, uint256 units, uint256 premium, uint256 fee, uint256 spot, uint256 vol)",
    ),
    fromBlock: BigInt(dep.deployBlock),
    toBlock: "latest",
  });
  const ids = [...new Set(bought.map((l) => l.args.seriesId!))];
  const now = BigInt(Math.floor(Date.now() / 1000));
  for (const id of ids) {
    const s = await client.readContract({ address: dep.market, abi: marketAbi, functionName: "getSeries", args: [id] });
    if (s.settled || s.expiry > now) continue;
    try {
      const { request } = await client.simulateContract({ address: dep.market, abi: marketAbi, functionName: "settle", args: [id], account });
      const hash = await wallet.writeContract(request);
      await client.waitForTransactionReceipt({ hash });
      console.log(`settled series ${id.toString(16).slice(0, 10)}… (${hash.slice(0, 10)})`);
    } catch (e) {
      const msg = (e as Error).message;
      console.log(`series ${id.toString(16).slice(0, 10)}…: ${msg.includes("AwaitingPostExpiryPrint") ? "awaiting post-expiry print" : msg.split("\n")[0]}`);
    }
  }
}

async function main() {
  for (;;) {
    await pass();
    if (once) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
