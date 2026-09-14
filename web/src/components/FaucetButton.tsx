"use client";

import { useAccount } from "wagmi";
import { parseUnits } from "viem";
import { erc20Abi } from "@/abi";
import { deployment, isDeployed } from "@/lib/deployment";
import { useTx } from "@/lib/hooks/useTx";
import { USD_DECIMALS } from "@/lib/format";

const AMOUNT = parseUnits("10000", USD_DECIMALS);

/** Mints 10,000 tUSD from the open MockERC20 faucet to the connected wallet. */
export function FaucetButton({ className = "btn btn-sm" }: { className?: string }) {
  const { address } = useAccount();
  const { send, busy } = useTx();
  if (!address) return null;
  return (
    <button
      className={className}
      disabled={busy || !isDeployed}
      onClick={() =>
        send("Mint 10,000 tUSD", {
          address: deployment.usd,
          abi: erc20Abi,
          functionName: "mint",
          args: [address, AMOUNT],
        })
      }
    >
      Get 10,000 tUSD
    </button>
  );
}
