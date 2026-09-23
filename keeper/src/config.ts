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

export function relayerKey(): `0x${string}` {
  const k = process.env.RELAYER_KEY ?? process.env.PRIVATE_KEY;
  if (!k) throw new Error("RELAYER_KEY (or PRIVATE_KEY) not set");
  return (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;
}
