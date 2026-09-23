import { defineChain } from "viem";
import raw from "../deployments.json";

type ChainInfo = { name: string; shortName: string; rpc: string; explorer?: string; explorerName?: string };

/** Networks AfterHours can be deployed to. The active one follows `chainId` in deployments.json. */
const CHAINS: Record<number, ChainInfo> = {
  46630: {
    name: "Robinhood Chain Testnet",
    shortName: "Robinhood Testnet",
    rpc: "https://rpc.testnet.chain.robinhood.com",
    explorer: "https://explorer.testnet.chain.robinhood.com",
    explorerName: "Blockscout",
  },
  421614: {
    name: "Arbitrum Sepolia",
    shortName: "Arbitrum Sepolia",
    rpc: "https://sepolia-rollup.arbitrum.io/rpc",
    explorer: "https://sepolia.arbiscan.io",
    explorerName: "Arbiscan",
  },
  412346: {
    name: "Local Nitro dev node",
    shortName: "Local Nitro",
    rpc: "http://127.0.0.1:8547",
  },
};

export const CHAIN_ID: number = (raw as { chainId?: number }).chainId || 46630;
const info: ChainInfo = CHAINS[CHAIN_ID] ?? { name: `Chain ${CHAIN_ID}`, shortName: `Chain ${CHAIN_ID}`, rpc: "http://127.0.0.1:8547" };

export const CHAIN_NAME = info.name;
export const CHAIN_SHORT_NAME = info.shortName;
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || info.rpc;
export const EXPLORER_URL = info.explorer;

export const targetChain = defineChain({
  id: CHAIN_ID,
  name: info.name,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  ...(info.explorer ? { blockExplorers: { default: { name: info.explorerName ?? "Explorer", url: info.explorer } } } : {}),
  testnet: true,
});

/** Explorer links; undefined on networks without an explorer (local dev node). */
export const explorerAddress = (a: string) => (EXPLORER_URL ? `${EXPLORER_URL}/address/${a}` : undefined);
export const explorerTx = (h: string) => (EXPLORER_URL ? `${EXPLORER_URL}/tx/${h}` : undefined);
