"use client";

import { useReadContract } from "wagmi";
import type { Address } from "viem";
import { erc20Abi } from "@/abi";
import { deployment, isDeployed, isZero } from "@/lib/deployment";

export function useTusdBalance(owner?: Address) {
  return useReadContract({
    address: deployment.usd,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled: isDeployed && !!owner, refetchInterval: 15_000 },
  });
}

export function useAllowance(token: Address, owner: Address | undefined, spender: Address) {
  return useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner ?? "0x0000000000000000000000000000000000000000", spender],
    query: { enabled: isDeployed && !!owner && !isZero(token), refetchInterval: 15_000 },
  });
}

export function useErc20Balance(token: Address | undefined, owner?: Address) {
  const enabled = !!token && !isZero(token) && !!owner;
  return useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled, refetchInterval: 20_000 },
  });
}
