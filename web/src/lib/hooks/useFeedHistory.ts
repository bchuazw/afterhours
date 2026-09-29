"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { feedAbi } from "@/abi";
import { isZero } from "@/lib/deployment";
import { targetChain } from "@/lib/chain";
import { isValidAnswer } from "./useFeed";

export type RoundPoint = { roundId: bigint; price: bigint; updatedAt: number };

/** Chainlink round ids carry the phase in the top 16 bits; the aggregator index is the low 64. */
const INDEX_MASK = (1n << 64n) - 1n;

type RoundResult = { ok: true; answer: bigint; updatedAt: bigint } | { ok: false };

/**
 * Walks back up to `count` rounds from the feed's latest round, staying inside the latest phase
 * (stops at aggregator index 1). Uses Multicall3 when the chain has it and individual (JSON-RPC
 * batched) reads otherwise. Rounds that were never mirrored revert with NoData and are skipped, as
 * are invalid answers (<= 0 or >= 1e14, e.g. 16-decimal genesis rounds); those are never rescaled.
 */
export function useFeedHistory(feed: Address | undefined, count = 80) {
  const client = usePublicClient({ chainId: targetChain.id });
  const enabled = !!client && !!feed && !isZero(feed);

  return useQuery({
    queryKey: ["feedHistory", feed, count],
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
    queryFn: async (): Promise<RoundPoint[]> => {
      if (!client || !feed) return [];
      const [latest] = await client.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData" });
      const ids: bigint[] = [];
      for (let i = 0n; i < BigInt(count) && ((latest - i) & INDEX_MASK) >= 1n; i++) ids.push(latest - i);

      const readOne = async (id: bigint): Promise<RoundResult> => {
        try {
          const [, answer, , updatedAt] = await client.readContract({ address: feed, abi: feedAbi, functionName: "getRoundData", args: [id] });
          return { ok: true, answer, updatedAt };
        } catch {
          return { ok: false };
        }
      };

      let results: RoundResult[] | undefined;
      if (client.chain?.contracts?.multicall3) {
        try {
          const res = await client.multicall({
            allowFailure: true,
            contracts: ids.map((id) => ({ address: feed, abi: feedAbi, functionName: "getRoundData", args: [id] }) as const),
          });
          results = res.map((r) =>
            r.status === "success" ? { ok: true as const, answer: r.result[1], updatedAt: r.result[3] } : { ok: false as const },
          );
        } catch {
          results = undefined; // fall through to individual reads
        }
      }
      if (!results) results = await Promise.all(ids.map(readOne));

      const pts: RoundPoint[] = [];
      results.forEach((r, i) => {
        if (!r.ok || r.updatedAt === 0n || !isValidAnswer(r.answer)) return;
        pts.push({ roundId: ids[i], price: r.answer, updatedAt: Number(r.updatedAt) });
      });
      pts.sort((a, b) => a.updatedAt - b.updatedAt);
      return pts;
    },
  });
}
