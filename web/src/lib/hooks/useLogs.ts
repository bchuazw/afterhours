"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { parseAbiItem } from "viem";
import { deployment, isDeployed } from "@/lib/deployment";

export const protectionBoughtEvent = parseAbiItem(
  "event ProtectionBought(uint256 indexed seriesId, address indexed buyer, uint32 indexed underlyingId, uint256 strike, uint64 expiry, uint256 units, uint256 premium, uint256 fee, uint256 spot, uint256 vol)",
);
export const claimedEvent = parseAbiItem(
  "event Claimed(uint256 indexed seriesId, address indexed holder, uint256 units, uint256 payout)",
);
export const depositEvent = parseAbiItem(
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
);
export const withdrawEvent = parseAbiItem(
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
);

export type BoughtLog = {
  seriesId: bigint;
  buyer: Address;
  underlyingId: number;
  strike: bigint;
  expiry: number;
  units: bigint;
  premium: bigint;
  fee: bigint;
  spot: bigint;
  vol: bigint;
  blockNumber: bigint;
  txHash: `0x${string}`;
};

export type ClaimedLog = { seriesId: bigint; units: bigint; payout: bigint; txHash: `0x${string}` };

const CHUNK = 20_000n;

/**
 * Some RPCs cap eth_getLogs block ranges. Try the whole range first; on failure fall back to
 * fixed-size chunks walking backwards from head so the newest events arrive first.
 */
async function resilientRange<T>(
  fromBlock: bigint,
  head: bigint,
  fetch: (from: bigint, to: bigint) => Promise<T[]>,
): Promise<T[]> {
  try {
    return await fetch(fromBlock, head);
  } catch {
    const out: T[] = [];
    let to = head;
    while (to >= fromBlock) {
      const from = to - CHUNK + 1n > fromBlock ? to - CHUNK + 1n : fromBlock;
      out.push(...(await fetch(from, to)));
      if (from === fromBlock) break;
      to = from - 1n;
    }
    return out;
  }
}

const byBlockDesc = (a: { blockNumber: bigint }, b: { blockNumber: bigint }) =>
  a.blockNumber === b.blockNumber ? 0 : a.blockNumber > b.blockNumber ? -1 : 1;

/** All ProtectionBought events (optionally filtered by buyer / underlying), newest first. */
export function useProtectionBought(buyer?: Address, opts?: { underlyingId?: number; enabled?: boolean }) {
  const client = usePublicClient();
  const enabled = !!client && isDeployed && (opts?.enabled ?? true);
  return useQuery({
    queryKey: ["protectionBought", buyer ?? "all", opts?.underlyingId ?? "all"],
    enabled,
    staleTime: 20_000,
    refetchInterval: 30_000,
    queryFn: async (): Promise<BoughtLog[]> => {
      if (!client) return [];
      const head = await client.getBlockNumber();
      const logs = await resilientRange(BigInt(deployment.deployBlock), head, (fromBlock, toBlock) =>
        client.getLogs({
          address: deployment.market,
          event: protectionBoughtEvent,
          args: { buyer, underlyingId: opts?.underlyingId },
          fromBlock,
          toBlock,
        }),
      );
      const out: BoughtLog[] = [];
      for (const l of logs) {
        const a = l.args;
        if (a.seriesId === undefined || !a.buyer || a.strike === undefined || a.expiry === undefined) continue;
        out.push({
          seriesId: a.seriesId,
          buyer: a.buyer,
          underlyingId: Number(a.underlyingId ?? 0),
          strike: a.strike,
          expiry: Number(a.expiry),
          units: a.units ?? 0n,
          premium: a.premium ?? 0n,
          fee: a.fee ?? 0n,
          spot: a.spot ?? 0n,
          vol: a.vol ?? 0n,
          blockNumber: l.blockNumber ?? 0n,
          txHash: l.transactionHash ?? "0x",
        });
      }
      return out.sort(byBlockDesc);
    },
  });
}

/** Claimed events by `holder`, used to show claim history. */
export function useClaimed(holder?: Address) {
  const client = usePublicClient();
  const enabled = !!client && isDeployed && !!holder;
  return useQuery({
    queryKey: ["claimed", holder],
    enabled,
    staleTime: 20_000,
    queryFn: async (): Promise<ClaimedLog[]> => {
      if (!client || !holder) return [];
      const head = await client.getBlockNumber();
      const logs = await resilientRange(BigInt(deployment.deployBlock), head, (fromBlock, toBlock) =>
        client.getLogs({ address: deployment.market, event: claimedEvent, args: { holder }, fromBlock, toBlock }),
      );
      const out: ClaimedLog[] = [];
      for (const l of logs) {
        if (l.args.seriesId === undefined) continue;
        out.push({
          seriesId: l.args.seriesId,
          units: l.args.units ?? 0n,
          payout: l.args.payout ?? 0n,
          txHash: l.transactionHash ?? "0x",
        });
      }
      return out;
    },
  });
}

/** Gross deposits and withdrawals (asset units) for `owner` in a vault, from ERC-4626 events. */
export function useVaultFlows(vault: Address, owner?: Address) {
  const client = usePublicClient();
  const enabled = !!client && isDeployed && !!owner;
  return useQuery({
    queryKey: ["vaultFlows", vault, owner],
    enabled,
    staleTime: 20_000,
    queryFn: async () => {
      if (!client || !owner) return { deposited: 0n, withdrawn: 0n };
      const from = BigInt(deployment.deployBlock);
      const head = await client.getBlockNumber();
      const [dep, wd] = await Promise.all([
        resilientRange(from, head, (fromBlock, toBlock) =>
          client.getLogs({ address: vault, event: depositEvent, args: { owner }, fromBlock, toBlock }),
        ),
        resilientRange(from, head, (fromBlock, toBlock) =>
          client.getLogs({ address: vault, event: withdrawEvent, args: { owner }, fromBlock, toBlock }),
        ),
      ]);
      const deposited = dep.reduce((s, l) => s + (l.args.assets ?? 0n), 0n);
      const withdrawn = wd.reduce((s, l) => s + (l.args.assets ?? 0n), 0n);
      return { deposited, withdrawn };
    },
  });
}
