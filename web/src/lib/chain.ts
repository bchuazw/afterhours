import { defineChain } from "viem";
import raw from "../deployments.json";

/** Chain id follows deployments.json so a local Nitro dev-node deployment (412346) can be dropped in for testing. */
export const CHAIN_ID: number = (raw as { chainId?: number }).chainId || 46630;
export const IS_LOCAL = CHAIN_ID !== 46630;
export const DEFAULT_RPC = IS_LOCAL ? "http://127.0.0.1:8547" : "https://rpc.testnet.chain.robinhood.com";
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || DEFAULT_RPC;
export const EXPLORER_URL = "https://explorer.testnet.chain.robinhood.com";

export const robinhoodTestnet = defineChain({
  id: CHAIN_ID,
  name: IS_LOCAL ? `Local Nitro dev node (${CHAIN_ID})` : "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: EXPLORER_URL } },
  testnet: true,
});

export const explorerAddress = (a: string) => `${EXPLORER_URL}/address/${a}`;
export const explorerTx = (h: string) => `${EXPLORER_URL}/tx/${h}`;
