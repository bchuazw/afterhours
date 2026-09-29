import { defineChain, type Address } from "viem";
import raw from "../deployments.json";

type ChainInfo = {
  name: string;
  shortName: string;
  rpc: string;
  explorer?: string;
  explorerName?: string;
  /** Multicall3, only where it is actually deployed. Without it reads fall back to individual calls. */
  multicall3?: Address;
};

/** Canonical Multicall3 address (verified deployed on Robinhood Chain testnet and Arbitrum Sepolia). */
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** Networks AfterHours can be deployed to. The active one follows `chainId` in deployments.json. */
const CHAINS: Record<number, ChainInfo> = {
  46630: {
    name: "Robinhood Chain Testnet",
    shortName: "Robinhood Testnet",
    rpc: "https://rpc.testnet.chain.robinhood.com",
    explorer: "https://explorer.testnet.chain.robinhood.com",
    explorerName: "Blockscout",
    multicall3: MULTICALL3,
  },
  421614: {
    name: "Arbitrum Sepolia",
    shortName: "Arbitrum Sepolia",
    rpc: "https://sepolia-rollup.arbitrum.io/rpc",
    explorer: "https://sepolia.arbiscan.io",
    explorerName: "Arbiscan",
    multicall3: MULTICALL3,
  },
  // Local Nitro dev node: no Multicall3 predeploy, so no multicall3 entry.
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
/** Whether the target chain has Multicall3 configured (viem's `client.multicall` throws without it). */
export const HAS_MULTICALL = !!info.multicall3;

export const targetChain = defineChain({
  id: CHAIN_ID,
  name: info.name,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  ...(info.explorer ? { blockExplorers: { default: { name: info.explorerName ?? "Explorer", url: info.explorer } } } : {}),
  ...(info.multicall3 ? { contracts: { multicall3: { address: info.multicall3 } } } : {}),
  testnet: true,
});

/** Explorer links; undefined on networks without an explorer (local dev node). */
export const explorerAddress = (a: string) => (EXPLORER_URL ? `${EXPLORER_URL}/address/${a}` : undefined);
export const explorerTx = (h: string) => (EXPLORER_URL ? `${EXPLORER_URL}/tx/${h}` : undefined);
