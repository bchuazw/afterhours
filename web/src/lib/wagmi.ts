import { createConfig, createStorage, http, injected } from "wagmi";
import { targetChain, RPC_URL, EXPLORER_URL } from "./chain";
import { burnerConnector } from "./burner";

const noopStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

export const wagmiConfig = createConfig({
  chains: [targetChain],
  connectors: [injected({ shimDisconnect: true }), burnerConnector(RPC_URL)],
  transports: { [targetChain.id]: http(RPC_URL, { batch: true }) },
  // Pages are prerendered (static export); defer restoring the persisted connection until after
  // hydration so the first client render matches the server HTML.
  ssr: true,
  storage: createStorage({
    storage: typeof window !== "undefined" ? window.localStorage : noopStorage,
    key: "afterhours",
  }),
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

/** Parameters for wallet_addEthereumChain on injected wallets. */
export const addChainParams = {
  chainId: `0x${targetChain.id.toString(16)}`,
  chainName: targetChain.name,
  nativeCurrency: targetChain.nativeCurrency,
  rpcUrls: [RPC_URL],
  ...(EXPLORER_URL ? { blockExplorerUrls: [EXPLORER_URL] } : {}),
};
