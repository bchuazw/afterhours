"use client";

import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import { zeroAddress, type Address } from "viem";
import { marketAbi, vaultAbi } from "@/abi";
import { deployment, isDeployed, isZero, type UnderlyingDeployment } from "@/lib/deployment";
import { isClosedAt, nextOpenAt } from "@/lib/market-hours";
import { fmtDuration, fmtUtc } from "@/lib/format";
import { useFeed } from "./useFeed";
import { useMarketConfig } from "./useMarket";
import { useNow } from "./useNow";

/** Vault utilization cap (ProtectionVault.MAX_UTILIZATION_BPS). */
export const MAX_UTILIZATION_BPS = 9_000n;

export type VaultStats = {
  totalAssets?: bigint;
  capital?: bigint;
  locked?: bigint;
  free?: bigint;
  exit?: bigint;
  utilBps?: bigint;
  unearned?: bigint;
  /** From AfterHoursMarket.vaultState: deposits/exits allowed. */
  open?: boolean;
  /** Mark-to-market liability of open puts beyond their own unearned premium. */
  liability?: bigint;
  decimals: number;
  totalSupply?: bigint;
  shares?: bigint;
  maxDeposit?: bigint;
  maxWithdraw?: bigint;
  maxRedeem?: bigint;
  activeIds: readonly bigint[];
};

/**
 * Everything the app shows about one underlying's writer vault, plus a human explanation of why the
 * vault is closed when AfterHoursMarket.vaultState says so.
 */
export function useVault(u: UnderlyingDeployment, owner?: Address) {
  const enabled = isDeployed && !isZero(u.vault);
  const vault = { address: u.vault, abi: vaultAbi } as const;
  const market = { address: deployment.market, abi: marketAbi } as const;
  const who = owner ?? zeroAddress;

  const q = useReadContracts({
    contracts: [
      { ...vault, functionName: "totalAssets" },
      { ...vault, functionName: "capital" },
      { ...vault, functionName: "lockedCollateral" },
      { ...vault, functionName: "freeLiquidity" },
      { ...vault, functionName: "exitLiquidity" },
      { ...vault, functionName: "utilizationBps" },
      { ...vault, functionName: "unearnedPremium" },
      { ...market, functionName: "vaultState", args: [u.id] },
      { ...vault, functionName: "decimals" },
      { ...vault, functionName: "totalSupply" },
      { ...vault, functionName: "balanceOf", args: [who] },
      { ...vault, functionName: "maxDeposit", args: [who] },
      { ...vault, functionName: "maxWithdraw", args: [who] },
      { ...vault, functionName: "maxRedeem", args: [who] },
      { ...market, functionName: "activeSeries", args: [u.id] },
    ],
    allowFailure: true,
    query: { enabled, refetchInterval: 15_000 },
  });

  const stats = useMemo<VaultStats | undefined>(() => {
    const r = q.data;
    if (!r) return undefined;
    const g = <T,>(i: number): T | undefined => (r[i].status === "success" ? (r[i].result as T) : undefined);
    const state = g<readonly [boolean, bigint]>(7);
    return {
      totalAssets: g<bigint>(0),
      capital: g<bigint>(1),
      locked: g<bigint>(2),
      free: g<bigint>(3),
      exit: g<bigint>(4),
      utilBps: g<bigint>(5),
      unearned: g<bigint>(6),
      open: state?.[0],
      liability: state?.[1],
      decimals: g<number>(8) ?? 12,
      totalSupply: g<bigint>(9),
      shares: owner ? g<bigint>(10) : undefined,
      maxDeposit: owner ? g<bigint>(11) : undefined,
      maxWithdraw: owner ? g<bigint>(12) : undefined,
      maxRedeem: owner ? g<bigint>(13) : undefined,
      activeIds: g<readonly bigint[]>(14) ?? [],
    };
  }, [q.data, owner]);

  const activeIds = stats?.activeIds ?? [];
  const seriesQ = useReadContracts({
    contracts: activeIds.map((id) => ({ ...market, functionName: "getSeries", args: [id] }) as const),
    allowFailure: true,
    query: { enabled: enabled && activeIds.length > 0, refetchInterval: 15_000 },
  });

  const feed = useFeed(u.feed, { underlyingId: u.id });
  const { config } = useMarketConfig();
  const now = useNow(15_000);

  const closedReasons = useMemo<string[]>(() => {
    if (!stats || stats.open !== false) return [];
    const t = now || Math.floor(Date.now() / 1000);
    const out: string[] = [];
    const exposure = activeIds.length > 0;
    const expired = (seriesQ.data ?? []).filter((s) => s.status === "success" && Number(s.result.expiry) <= t).length;
    if (expired > 0) {
      out.push(
        `${expired} expired series ${expired === 1 ? "awaits" : "await"} settlement. Anyone can settle from the Positions tab (the keeper also does), and the vault reopens once it settles.`,
      );
    }
    if (exposure && isClosedAt(t)) {
      out.push(
        `The feeds are dark (Sat 00:00 to Mon 01:00 UTC) while the vault has open exposure, so share prices cannot be marked. Reopens ${fmtUtc(nextOpenAt(t))}.`,
      );
    }
    if (exposure && feed.data?.paused) out.push("The feed or Stock Token is paused (corporate action) while the vault has open exposure.");
    if (exposure && feed.data?.invalid) out.push("The feed's latest answer is invalid, so open puts are marked at a worst-case spot of 0.");
    if (exposure && feed.data && !isClosedAt(t) && feed.data.updatedAt + config.maxPriceAge < t) {
      out.push(`The feed has not printed for over ${fmtDuration(config.maxPriceAge)} while the vault has open exposure.`);
    }
    if (out.length === 0) out.push("The market reports this vault closed to entries and exits right now.");
    return out;
  }, [stats, activeIds.length, seriesQ.data, feed.data, config.maxPriceAge, now]);

  const firstError = q.data?.find((x) => x.status === "failure")?.error;

  return {
    stats,
    closedReasons,
    enabled,
    isLoading: enabled && q.isLoading,
    error: q.error ?? firstError,
  };
}

/**
 * Whether the vault can lock `collateral` right now (mirrors ProtectionVault.lock):
 * collateral <= capital - locked, and (locked + collateral) <= 90% of capital.
 * Returns the most collateral it could take as `headroom`.
 */
export function vaultCapacity(stats: Pick<VaultStats, "capital" | "locked"> | undefined, collateral: bigint) {
  if (!stats || stats.capital === undefined || stats.locked === undefined) return undefined;
  const { capital, locked } = stats;
  const free = capital > locked ? capital - locked : 0n;
  const capRoom = (capital * MAX_UTILIZATION_BPS) / 10_000n;
  const utilRoom = capRoom > locked ? capRoom - locked : 0n;
  const headroom = free < utilRoom ? free : utilRoom;
  return { ok: collateral <= headroom, headroom, free };
}
