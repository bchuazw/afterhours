import { defineChain } from "viem";

export const DEFAULT_RPC = "https://rpc.testnet.chain.robinhood.com";
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || DEFAULT_RPC;
export const EXPLORER_URL = "https://explorer.testnet.chain.robinhood.com";

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: EXPLORER_URL } },
  testnet: true,
});

export const explorerAddress = (a: string) => `${EXPLORER_URL}/address/${a}`;
export const explorerTx = (h: string) => `${EXPLORER_URL}/tx/${h}`;
