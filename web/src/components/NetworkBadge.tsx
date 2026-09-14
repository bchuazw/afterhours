"use client";

import { useAccount, useConnectorClient, useSwitchChain } from "wagmi";
import { robinhoodTestnet } from "@/lib/chain";
import { addChainParams } from "@/lib/wagmi";
import { useMounted } from "@/lib/hooks/useNow";
import { useToast } from "./Toaster";
import { describeError } from "@/lib/errors";
import { BURNER_ID } from "@/lib/burner";

/** Shows the target network; if an injected wallet is on the wrong chain, offers to add/switch. */
export function NetworkBadge() {
  const mounted = useMounted();
  const { chainId, isConnected, connector } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { data: client } = useConnectorClient();
  const toast = useToast();

  const wrong = mounted && isConnected && chainId !== robinhoodTestnet.id;

  const switchNetwork = async () => {
    try {
      if (connector?.id !== BURNER_ID) {
        // wallet_addEthereumChain both adds and switches on most injected wallets.
        await client?.request({
          method: "wallet_addEthereumChain",
          params: [addChainParams],
        } as never);
      }
      await switchChainAsync({ chainId: robinhoodTestnet.id });
      toast.push({ kind: "success", title: "Switched to Robinhood Chain Testnet" });
    } catch (err) {
      toast.push({ kind: "error", title: "Could not switch network", description: describeError(err) });
    }
  };

  if (wrong) {
    return (
      <button onClick={switchNetwork} className="pill pill-neg cursor-pointer hover:brightness-110" title="Click to switch">
        <span className="pill-dot" />
        <span className="hidden sm:inline">Wrong network · </span>Switch to Robinhood Testnet
      </button>
    );
  }

  return (
    <span className="hidden sm:inline-flex">
      <span className="pill" title={`chainId ${robinhoodTestnet.id}`}>
        <span className="pill-dot bg-accent" />
        Robinhood Chain Testnet
      </span>
    </span>
  );
}
