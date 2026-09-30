import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defineChain, type Address } from "viem";
import "dotenv/config";

const here = dirname(fileURLToPath(import.meta.url));

export const robinhoodMainnet = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.MAINNET_RPC ?? "https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

/// Target chain for the mirrors/market: Robinhood Chain testnet (46630, default), Arbitrum Sepolia
/// (421614) or a local Nitro dev node (412346). TESTNET_RPC overrides the RPC.
export const TARGET_CHAIN_ID = Number(process.env.CHAIN_ID ?? 46630);

const TARGETS: Record<number, { name: string; rpc: string }> = {
  46630: { name: "Robinhood Chain Testnet", rpc: "https://rpc.testnet.chain.robinhood.com" },
  421614: { name: "Arbitrum Sepolia", rpc: "https://sepolia-rollup.arbitrum.io/rpc" },
  412346: { name: "Local Nitro dev node", rpc: "http://127.0.0.1:8547" },
};
const target = TARGETS[TARGET_CHAIN_ID] ?? { name: `chain-${TARGET_CHAIN_ID}`, rpc: "http://127.0.0.1:8547" };

export const robinhoodTestnet = defineChain({
  id: TARGET_CHAIN_ID,
  name: target.name,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.TESTNET_RPC ?? target.rpc] } },
  testnet: true,
});

/// Production Chainlink tokenized-equity feed proxies on Robinhood Chain mainnet (8 decimals).
export const MAINNET_FEEDS: Record<string, Address> = {
  TSLA: "0x4A1166a659A55625345e9515b32adECea5547C38",
  AMZN: "0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C",
  NVDA: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
  PLTR: "0x820ABedFF239034956B7A9d2F0a331f9F075eB4c",
  AMD: "0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72",
};

/// Robinhood Stock Tokens on mainnet. The corporate-action pause (`oraclePaused()`) lives on the
/// token, not the feed; the relayer copies it onto each FeedMirror.
export const MAINNET_STOCK_TOKENS: Record<string, Address> = {
  TSLA: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
  AMZN: "0x12f190a9F9d7D37a250758b26824B97CE941bF54",
  NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  PLTR: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A",
  AMD: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC",
};

export type Deployment = {
  chainId: number;
  deployer: Address;
  usd: Address;
  pricer: Address;
  market: Address;
  deployBlock: number;
  underlyings: Record<string, { id: number; symbol: string; feed: Address; vault: Address; stockToken: Address }>;
};

export function loadDeployment(chainId = TARGET_CHAIN_ID): Deployment {
  const p = join(here, "..", "..", "contracts", "deployments", `${chainId}.json`);
  return JSON.parse(readFileSync(p, "utf8")) as Deployment;
}

/// Earlier market deployments on the target chain that may still have open series; the settlement
/// bot keeps settling them alongside the current deployment. Comma-separated addresses.
export const LEGACY_MARKETS: Address[] = (process.env.LEGACY_MARKETS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s): s is Address => /^0x[0-9a-fA-F]{40}$/.test(s));

export function relayerKey(): `0x${string}` {
  const raw = (process.env.RELAYER_KEY ?? process.env.PRIVATE_KEY ?? "").trim();
  if (!raw) throw new Error("RELAYER_KEY (or PRIVATE_KEY) not set");
  const k = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error("RELAYER_KEY is not a 32-byte hex key");
  return k as `0x${string}`;
}
