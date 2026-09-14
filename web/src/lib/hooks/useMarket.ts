"use client";

import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import { marketAbi } from "@/abi";
import { deployment, isDeployed } from "@/lib/deployment";

const market = { address: deployment.market, abi: marketAbi } as const;

export type MarketConfig = {
  minTenor: number;
  maxTenor: number;
  minStrikeBps: number;
  maxStrikeBps: number;
  protocolFeeBps: number;
  settlementGrace: number;
  maxPriceAge: number;
  paused: boolean;
};

const FALLBACK: MarketConfig = {
  minTenor: 3600,
  maxTenor: 30 * 86400,
  minStrikeBps: 5000,
  maxStrikeBps: 12000,
  protocolFeeBps: 0,
  settlementGrace: 5 * 86400,
  maxPriceAge: 4 * 86400,
  paused: false,
};

/** Global market parameters. Falls back to the contract defaults until the read resolves. */
export function useMarketConfig() {
  const q = useReadContracts({
    contracts: [
      { ...market, functionName: "minTenor" },
      { ...market, functionName: "maxTenor" },
      { ...market, functionName: "minStrikeBps" },
      { ...market, functionName: "maxStrikeBps" },
      { ...market, functionName: "protocolFeeBps" },
      { ...market, functionName: "settlementGrace" },
      { ...market, functionName: "maxPriceAge" },
      { ...market, functionName: "paused" },
    ],
    allowFailure: true,
    query: { enabled: isDeployed, staleTime: 60_000 },
  });

  const config = useMemo<MarketConfig>(() => {
    const r = q.data;
    if (!r) return FALLBACK;
    const num = (i: number, fb: number) => (r[i].status === "success" ? Number(r[i].result) : fb);
    return {
      minTenor: num(0, FALLBACK.minTenor),
      maxTenor: num(1, FALLBACK.maxTenor),
      minStrikeBps: num(2, FALLBACK.minStrikeBps),
      maxStrikeBps: num(3, FALLBACK.maxStrikeBps),
      protocolFeeBps: num(4, FALLBACK.protocolFeeBps),
      settlementGrace: num(5, FALLBACK.settlementGrace),
      maxPriceAge: num(6, FALLBACK.maxPriceAge),
      paused: r[7].status === "success" ? Boolean(r[7].result) : false,
    };
  }, [q.data]);

  return { config, isLoading: isDeployed && q.isLoading, isLive: !!q.data };
}

/** Onchain Underlying struct for `id` (params, enabled flag, and the vault/feed the market actually uses). */
export function useUnderlyingInfo(id: number | undefined) {
  const q = useReadContracts({
    contracts: [{ ...market, functionName: "getUnderlying", args: [id ?? 0] }],
    allowFailure: true,
    query: { enabled: isDeployed && id !== undefined && id > 0, staleTime: 60_000 },
  });
  const info = q.data?.[0].status === "success" ? q.data[0].result : undefined;
  return { info, isLoading: q.isLoading, error: q.data?.[0].status === "failure" ? q.data[0].error : q.error };
}
