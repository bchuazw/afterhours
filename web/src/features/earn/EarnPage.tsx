"use client";

import { underlyingList } from "@/lib/deployment";
import { VaultCard } from "./VaultCard";

export function EarnPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Earn premiums by writing protection</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Deposit tUSD into a per-underlying ERC-4626 vault. Every protection sold locks collateral from the vault and
          pays its premium straight in, lifting the share price for writers. Positions are always fully collateralized
          and utilization is capped at 90% so exits stay liquid.
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
