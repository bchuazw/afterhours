"use client";

import { underlyingList } from "@/lib/deployment";
import { VaultCard } from "./VaultCard";

export function EarnPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Earn premiums by writing protection</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Deposit tUSD into a per-underlying ERC-4626 vault. Every protection sold locks strike × tokens of collateral
          and pays its premium in; the premium stays unearned until its series settles, then lifts the share price.
          Open puts are marked to market, so a loss hits every writer at once. Positions are always fully
          collateralized, exits keep utilization at or below 90%, and entries and exits pause while the feed is dark
          with open exposure or an expired series awaits settlement.
        </p>
      </div>
      <div className="grid gap-4">
        {underlyingList.map((u) => (
          <VaultCard key={u.key} u={u} />
        ))}
      </div>
    </div>
  );
}
