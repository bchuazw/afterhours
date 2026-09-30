"use client";

import { useMemo } from "react";
import { useReadContract, useReadContracts } from "wagmi";
import { marketAbi } from "@/abi";
import { deployment, isDeployed } from "@/lib/deployment";

const market = { address: deployment.market, abi: marketAbi } as const;

/** AfterHoursMarket.Series for one active series id. */
export type SeriesInfo = {
  id: bigint;
  underlyingId: number;
  strike: bigint;
  expiry: number;
  grace: number;
  settled: boolean;
  openUnits: bigint;
  locked: bigint;
  premium: bigint;
  settlePrice: bigint;
  owed: bigint;
};

/**
 * Every active (unsettled) series of an underlying, from `activeSeries(id)` plus one `getSeries`
 * read per id. `series` is undefined until both reads resolve, then sorted by expiry then strike.
 * This is what a buyer can join (expiry still ahead) and what anyone can settle (expiry passed).
 */
export function useActiveSeries(underlyingId: number | undefined, opts?: { enabled?: boolean }) {
  const enabled = isDeployed && underlyingId !== undefined && underlyingId > 0 && (opts?.enabled ?? true);
  const idsQ = useReadContract({
    ...market,
    functionName: "activeSeries",
    args: [underlyingId ?? 0],
    query: { enabled, refetchInterval: 15_000 },
  });
  const ids = useMemo<readonly bigint[]>(() => idsQ.data ?? [], [idsQ.data]);

  const infoQ = useReadContracts({
    contracts: ids.map((id) => ({ ...market, functionName: "getSeries", args: [id] }) as const),
    allowFailure: true,
    query: { enabled: enabled && ids.length > 0, refetchInterval: 15_000 },
  });

  const series = useMemo<SeriesInfo[] | undefined>(() => {
    if (!idsQ.data) return undefined;
    if (ids.length === 0) return [];
    const infos = infoQ.data;
    if (!infos) return undefined;
    const out: SeriesInfo[] = [];
    ids.forEach((id, i) => {
      const r = infos[i];
      if (!r || r.status !== "success") return;
      const s = r.result;
      out.push({
        id,
        underlyingId: s.underlyingId,
        strike: s.strike,
        expiry: Number(s.expiry),
        grace: Number(s.grace),
        settled: s.settled,
        openUnits: s.openUnits,
        locked: s.locked,
        premium: s.premium,
        settlePrice: s.settlePrice,
        owed: s.owed,
      });
    });
    return out.sort((a, b) => a.expiry - b.expiry || (a.strike < b.strike ? -1 : a.strike > b.strike ? 1 : 0));
  }, [idsQ.data, ids, infoQ.data]);

  return {
    ids,
    series,
    isLoading: enabled && (idsQ.isLoading || (ids.length > 0 && infoQ.isLoading)),
    error: idsQ.error ?? infoQ.error ?? undefined,
  };
}
