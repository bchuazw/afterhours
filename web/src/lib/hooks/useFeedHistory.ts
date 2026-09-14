"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { feedAbi } from "@/abi";
import { isZero } from "@/lib/deployment";
import { normalizePrice } from "./useFeed";

export type RoundPoint = { roundId: bigint; price: bigint; updatedAt: number };

/**
 * Walks back `count` rounds from the feed's latest round via multicall. FeedMirror replays
 * mainnet roundIds verbatim so ids are contiguous within a phase; rounds that were never
 * backfilled revert with NoData and are simply skipped.
 */
export function useFeedHistory(feed: Address | undefined, count = 80) {
  const client = usePublicClient();
  const enabled = !!client && !!feed && !isZero(feed);

  return useQuery({
    queryKey: ["feedHistory", feed, count],
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
    queryFn: async (): Promise<RoundPoint[]> => {
      if (!client || !feed) return [];
      const latest = await client.readContract({ address: feed, abi: feedAbi, functionName: "latestRound" });
      const ids: bigint[] = [];
      for (let i = 0n; i < BigInt(count) && latest - i > 0n; i++) ids.push(latest - i);
      const res = await client.multicall({
        allowFailure: true,
        contracts: ids.map((id) => ({ address: feed, abi: feedAbi, functionName: "getRoundData", args: [id] } as const)),
      });
      const pts: RoundPoint[] = [];
      res.forEach((r, i) => {
        if (r.status !== "success") return;
        const [, answer, , updatedAt] = r.result;
        if (answer <= 0n || updatedAt === 0n) return;
        pts.push({ roundId: ids[i], price: normalizePrice(answer), updatedAt: Number(updatedAt) });
      });
      pts.sort((a, b) => a.updatedAt - b.updatedAt);
      return pts;
    },
  });
}
