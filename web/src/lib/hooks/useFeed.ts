"use client";

import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import type { Address } from "viem";
import { feedAbi, marketAbi } from "@/abi";
import { deployment, isZero } from "@/lib/deployment";

/** 8-decimal answers at or above $1,000,000 are invalid (mirrors AfterHoursMarket.MAX_ANSWER). */
export const MAX_ANSWER = 10n ** 14n;

/**
 * Mirror of AfterHoursMarket._valid. Early mainnet rounds carry 16-decimal-scaled answers
 * (e.g. 3964149999900000000 for $396.41); those are invalid and must be skipped, never rescaled.
 */
export const isValidAnswer = (answer: bigint) => answer > 0n && answer < MAX_ANSWER;

export type FeedSnapshot = {
  roundId: bigint;
  /** Latest answer, 8 decimals; undefined when the answer is invalid (the market refuses to quote). */
  answer: bigint | undefined;
  rawAnswer: bigint;
  invalid: boolean;
  updatedAt: number;
  /** oraclePaused() on the feed or the Stock Token, as the market sees it (isFeedPaused). */
  paused: boolean;
  description?: string;
};

/**
 * Latest feed round plus the pause flag the market enforces. The pause lives on the Robinhood Stock
 * Token (oraclePaused), so it is read through AfterHoursMarket.isFeedPaused(underlyingId), which
 * probes both the feed and the token; the feed's own flag is the fallback before deployment.
 */
export function useFeed(feed: Address | undefined, opts?: { underlyingId?: number; refetchInterval?: number }) {
  const enabled = !!feed && !isZero(feed);
  const q = useReadContracts({
    contracts: [
      { address: feed, abi: feedAbi, functionName: "latestRoundData" },
      { address: feed, abi: feedAbi, functionName: "oraclePaused" },
      { address: feed, abi: feedAbi, functionName: "description" },
      { address: deployment.market, abi: marketAbi, functionName: "isFeedPaused", args: [opts?.underlyingId ?? 0] },
    ],
    allowFailure: true,
    query: { enabled, refetchInterval: opts?.refetchInterval ?? 15_000, staleTime: 5_000 },
  });

  const data = useMemo<FeedSnapshot | undefined>(() => {
    const r = q.data;
    if (!r) return undefined;
    const latest = r[0];
    if (latest.status !== "success") return undefined;
    const [roundId, answer, , updatedAt] = latest.result;
    const valid = isValidAnswer(answer);
    const feedPaused = r[1].status === "success" ? r[1].result : false;
    const marketSaysPaused = opts?.underlyingId && r[3].status === "success" ? r[3].result : false;
    return {
      roundId,
      answer: valid ? answer : undefined,
      rawAnswer: answer,
      invalid: !valid,
      updatedAt: Number(updatedAt),
      paused: feedPaused || marketSaysPaused,
      description: r[2].status === "success" ? r[2].result : undefined,
    };
  }, [q.data, opts?.underlyingId]);

  const error = q.error ?? (q.data && q.data[0].status === "failure" ? q.data[0].error : undefined);

  return { data, isLoading: enabled && q.isLoading, error, enabled, refetch: q.refetch };
}
