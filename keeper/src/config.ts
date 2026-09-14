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
});

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.TESTNET_RPC ?? "https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://explorer.testnet.chain.robinhood.com" } },
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

export function loadDeployment(chainId = 46630): Deployment {
  const p = join(here, "..", "..", "contracts", "deployments", `${chainId}.json`);
  return JSON.parse(readFileSync(p, "utf8")) as Deployment;
}

export function relayerKey(): `0x${string}` {
  const k = process.env.RELAYER_KEY ?? process.env.PRIVATE_KEY;
  if (!k) throw new Error("RELAYER_KEY (or PRIVATE_KEY) not set");
  return (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;
}
