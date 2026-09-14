"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAccount, useBalance, useConnect, useDisconnect } from "wagmi";
import { formatEther } from "viem";
import { BURNER_ID, burnerAddress, exportBurnerKey, resetBurner } from "@/lib/burner";
import { robinhoodTestnet } from "@/lib/chain";
import { shortAddr } from "@/lib/format";
import { useMounted } from "@/lib/hooks/useNow";
import { AddressLink, CopyButton } from "./ui";
import { FaucetButton } from "./FaucetButton";
import { useTusdBalance } from "@/lib/hooks/useToken";
import { fmtUsd } from "@/lib/format";

export function WalletButton() {
  const mounted = useMounted();
  const { address, isConnected, connector } = useAccount();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!mounted) return <button className="btn btn-primary">Connect</button>;

  return (
    <>
      {isConnected && address ? (
        <button className="btn" onClick={() => setOpen(true)}>
          <span className={`h-2 w-2 rounded-full ${connector?.id === BURNER_ID ? "bg-warn" : "bg-pos"}`} />
          <span className="num">{shortAddr(address)}</span>
        </button>
      ) : (
        <button className="btn btn-primary" onClick={() => setOpen(true)}>
          Connect
        </button>
      )}
      {open && createPortal(<WalletModal onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function WalletModal({ onClose }: { onClose: () => void }) {
  const { address, isConnected, connector } = useAccount();
  const { connectors, connectAsync, isPending, error } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const [showKey, setShowKey] = useState(false);

  const injected = connectors.find((c) => c.id === "injected");
  const burner = connectors.find((c) => c.id === BURNER_ID);
  const isBurner = connector?.id === BURNER_ID;
  const demoAddr = burnerAddress();

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center" onClick={onClose}>
      <div className="card w-full max-w-md p-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold">{isConnected ? "Wallet" : "Connect a wallet"}</h3>
          <button onClick={onClose} className="text-muted hover:text-fg" aria-label="Close">×</button>
        </div>

        {isConnected && address ? (
          <ConnectedPanel address={address} isBurner={isBurner} onDisconnect={async () => { await disconnectAsync(); onClose(); }} />
        ) : (
          <div className="space-y-2">
            <button
              className="btn w-full justify-between"
              disabled={!injected || isPending}
              onClick={async () => {
                if (!injected) return;
                await connectAsync({ connector: injected, chainId: robinhoodTestnet.id }).catch(() => {});
                onClose();
              }}
            >
              <span>Browser wallet</span>
              <span className="text-xs text-muted">MetaMask, Rabby, …</span>
            </button>
            <button
              className="btn w-full justify-between"
              disabled={!burner || isPending}
              onClick={async () => {
                if (!burner) return;
                await connectAsync({ connector: burner, chainId: robinhoodTestnet.id }).catch(() => {});
                onClose();
              }}
            >
              <span>Demo wallet</span>
              <span className="text-xs text-muted">No extension needed</span>
            </button>
            {demoAddr && (
              <p className="num px-1 text-[11px] text-dim">Demo wallet on this device: {shortAddr(demoAddr, 6)}</p>
            )}
            {error && <p className="text-xs text-neg">{error.message.split("\n")[0]}</p>}
            <p className="pt-2 text-xs leading-relaxed text-muted">
              The demo wallet is a throwaway key stored in this browser. Fund it with testnet ETH for gas and mint tUSD
              with the faucet.
            </p>
          </div>
        )}

        {isConnected && isBurner && (
          <div className="mt-4 border-t border-line pt-3">
            <button className="text-xs text-muted hover:text-fg" onClick={() => setShowKey((s) => !s)}>
              {showKey ? "Hide" : "Reveal"} private key
            </button>
            {showKey && (
              <div className="num mt-2 break-all rounded-md border border-line bg-bg p-2 text-[11px] text-muted">
                {exportBurnerKey() ?? "—"}
              </div>
            )}
            <button
              className="mt-2 block text-xs text-neg/80 hover:text-neg"
              onClick={async () => {
                if (!confirm("Discard this demo wallet? Any funds in it will be lost.")) return;
                await disconnectAsync();
                resetBurner();
                onClose();
              }}
            >
              Reset demo wallet
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ConnectedPanel({ address, isBurner, onDisconnect }: { address: `0x${string}`; isBurner: boolean; onDisconnect: () => void }) {
  const { data: eth } = useBalance({ address, chainId: robinhoodTestnet.id, query: { refetchInterval: 15_000 } });
  const { data: tusd } = useTusdBalance(address);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="label">{isBurner ? "Demo wallet" : "Address"}</div>
          <div className="num mt-1 text-sm">{shortAddr(address, 8)}</div>
        </div>
        <div className="flex gap-2">
          <CopyButton text={address} label="Copy address" />
          <a href={`https://explorer.testnet.chain.robinhood.com/address/${address}`} target="_blank" rel="noreferrer" className="btn btn-sm">
            Explorer
          </a>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 rounded-lg border border-line bg-bg p-3">
        <div>
          <div className="label">ETH (gas)</div>
          <div className="num mt-1 text-sm">{eth ? Number(formatEther(eth.value)).toFixed(5) : "—"}</div>
        </div>
        <div>
          <div className="label">tUSD</div>
          <div className="num mt-1 text-sm">{fmtUsd(tusd)}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <FaucetButton />
        <button className="btn btn-sm" onClick={onDisconnect}>Disconnect</button>
      </div>
      <p className="text-xs leading-relaxed text-muted">
        Need gas? Send a little testnet ETH to this address (copy it above). <AddressLink address={address} chars={6} />
      </p>
    </div>
  );
}
