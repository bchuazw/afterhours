import { createConfig, createStorage, http, injected } from "wagmi";
import { robinhoodTestnet, RPC_URL } from "./chain";
import { burnerConnector } from "./burner";

const noopStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

export const wagmiConfig = createConfig({
  chains: [robinhoodTestnet],
  connectors: [injected({ shimDisconnect: true }), burnerConnector(RPC_URL)],
  transports: { [robinhoodTestnet.id]: http(RPC_URL, { batch: true }) },
  ssr: false,
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
  chainId: `0x${robinhoodTestnet.id.toString(16)}`,
  chainName: robinhoodTestnet.name,
  nativeCurrency: robinhoodTestnet.nativeCurrency,
  rpcUrls: [RPC_URL],
  blockExplorerUrls: [robinhoodTestnet.blockExplorers.default.url],
};
