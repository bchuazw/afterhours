"use client";

import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import type { Address } from "viem";
import { feedAbi } from "@/abi";
import { isZero } from "@/lib/deployment";

export type FeedSnapshot = {
  roundId: bigint;
  answer: bigint; // normalized to 8 decimals (mirrors AfterHoursMarket._normalize)
  updatedAt: number;
  paused: boolean;
  description?: string;
};

/** Mirror of AfterHoursMarket._normalize: genesis-era rounds were 18-decimal. */
export function normalizePrice(answer: bigint): bigint {
  return answer >= 10n ** 14n ? answer / 10n ** 10n : answer;
}

export function useFeed(feed: Address | undefined, refetchInterval = 15_000) {
  const enabled = !!feed && !isZero(feed);
  const q = useReadContracts({
    contracts: [
      { address: feed, abi: feedAbi, functionName: "latestRoundData" },
      { address: feed, abi: feedAbi, functionName: "oraclePaused" },
      { address: feed, abi: feedAbi, functionName: "description" },
    ],
    allowFailure: true,
    query: { enabled, refetchInterval, staleTime: 5_000 },
  });

  const data = useMemo<FeedSnapshot | undefined>(() => {
    const r = q.data;
    if (!r) return undefined;
    const latest = r[0];
    if (latest.status !== "success") return undefined;
    const [roundId, answer, , updatedAt] = latest.result;
    return {
      roundId,
      answer: normalizePrice(answer),
      updatedAt: Number(updatedAt),
      paused: r[1].status === "success" ? r[1].result : false,
      description: r[2].status === "success" ? r[2].result : undefined,
    };
  }, [q.data]);

  const error = q.error ?? (q.data && q.data[0].status === "failure" ? q.data[0].error : undefined);

  return { data, isLoading: enabled && q.isLoading, error, enabled, refetch: q.refetch };
}
