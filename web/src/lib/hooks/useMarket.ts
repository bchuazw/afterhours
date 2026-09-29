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
  /** Strikes must be a multiple of this (8 decimals; $1 in v2). */
  strikeTick: bigint;
  maxActiveSeries: number;
};

const FALLBACK: MarketConfig = {
  minTenor: 3600,
  maxTenor: 30 * 86400,
  minStrikeBps: 5000,
  maxStrikeBps: 12000,
  protocolFeeBps: 0,
  settlementGrace: 5 * 86400,
  maxPriceAge: 26 * 3600,
  paused: false,
  strikeTick: 100_000_000n,
  maxActiveSeries: 32,
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
      { ...market, functionName: "STRIKE_TICK" },
      { ...market, functionName: "MAX_ACTIVE_SERIES" },
    ],
    allowFailure: true,
    query: { enabled: isDeployed, staleTime: 60_000, refetchInterval: 60_000 },
  });

  const config = useMemo<MarketConfig>(() => {
    const r = q.data;
    if (!r) return FALLBACK;
    const num = (i: number, fb: number) => (r[i].status === "success" ? Number(r[i].result) : fb);
    const tick = r[8].status === "success" ? r[8].result : FALLBACK.strikeTick;
    return {
      minTenor: num(0, FALLBACK.minTenor),
      maxTenor: num(1, FALLBACK.maxTenor),
      minStrikeBps: num(2, FALLBACK.minStrikeBps),
      maxStrikeBps: num(3, FALLBACK.maxStrikeBps),
      protocolFeeBps: num(4, FALLBACK.protocolFeeBps),
      settlementGrace: num(5, FALLBACK.settlementGrace),
      maxPriceAge: num(6, FALLBACK.maxPriceAge),
      paused: r[7].status === "success" ? Boolean(r[7].result) : false,
      strikeTick: tick > 0n ? tick : FALLBACK.strikeTick,
      maxActiveSeries: num(9, FALLBACK.maxActiveSeries),
    };
  }, [q.data]);

  return { config, isLoading: isDeployed && q.isLoading, isLive: !!q.data };
}

/** Onchain Underlying struct for `id` (params, enabled flag, and the vault/feed the market actually uses). */
export function useUnderlyingInfo(id: number | undefined) {
  const q = useReadContracts({
    contracts: [{ ...market, functionName: "getUnderlying", args: [id ?? 0] }],
    allowFailure: true,
    query: { enabled: isDeployed && id !== undefined && id > 0, staleTime: 30_000, refetchInterval: 30_000 },
  });
  const info = q.data?.[0].status === "success" ? q.data[0].result : undefined;
  return { info, isLoading: q.isLoading, error: q.data?.[0].status === "failure" ? q.data[0].error : q.error };
}

/** Strike bounds for `spot`, snapped inward to the tick: [ceil(min), floor(max)] (8 decimals). */
export function strikeBounds(spot: bigint, cfg: Pick<MarketConfig, "minStrikeBps" | "maxStrikeBps" | "strikeTick">) {
  const t = cfg.strikeTick;
  const den = 10_000n * t;
  const loNum = spot * BigInt(cfg.minStrikeBps);
  const lo = ((loNum + den - 1n) / den) * t;
  const hi = ((spot * BigInt(cfg.maxStrikeBps)) / den) * t;
  return { lo: lo > 0n ? lo : t, hi };
}

/** `pct`% of spot rounded to the nearest strike tick and clamped into the valid band; undefined if none. */
export function presetStrike(
  spot: bigint,
  pct: number,
  cfg: Pick<MarketConfig, "minStrikeBps" | "maxStrikeBps" | "strikeTick">,
): bigint | undefined {
  const t = cfg.strikeTick;
  const { lo, hi } = strikeBounds(spot, cfg);
  if (lo > hi) return undefined;
  const raw = (spot * BigInt(pct)) / 100n;
  const k = ((raw + t / 2n) / t) * t;
  return k < lo ? lo : k > hi ? hi : k;
}
