"use client";

import { useMemo } from "react";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { zeroAddress } from "viem";
import { marketAbi } from "@/abi";
import { deployment, isDeployed, underlyingById } from "@/lib/deployment";
import { useClaimed, useProtectionBought, type BoughtLog } from "@/lib/hooks/useLogs";
import { useNow, useMounted } from "@/lib/hooks/useNow";
import { useTx } from "@/lib/hooks/useTx";
import { fmtDuration, fmtPrice, fmtTime, fmtUnits, fmtUsd } from "@/lib/format";
import { Card, ErrorNote, InfoNote, Pill, Skeleton } from "@/components/ui";

type Status = "open" | "awaiting" | "itm" | "otm" | "claimed";

type Position = {
  seriesId: bigint;
  underlyingId: number;
  strike: bigint;
  expiry: number;
  balance: bigint;
  settled: boolean;
  settlePrice: bigint;
  openUnits: bigint;
  status: Status;
  payout: bigint; // for `balance` units
  claimedPayout: bigint; // historical, from Claimed logs
  boughtUnits: bigint;
  premiumPaid: bigint;
};

/** Mirrors AfterHoursMarket._toAsset for a 6-decimal asset. */
const toAsset = (price8: bigint, units18: bigint) => (price8 * units18 * 1_000_000n) / 10n ** 26n;

export function PositionsPage() {
  const mounted = useMounted();
  const { address, isConnected } = useAccount();
  const now = useNow(1000);
  const { send, busy } = useTx();

  // Discover every series that has ever been bought; the wallet may hold transferred positions too.
  const all = useProtectionBought(undefined);
  const claimed = useClaimed(address);

  const series = useMemo(() => {
    const m = new Map<string, BoughtLog & { mine: boolean; myUnits: bigint; myPremium: bigint }>();
    for (const l of all.data ?? []) {
      const k = l.seriesId.toString();
      const mine = !!address && l.buyer.toLowerCase() === address.toLowerCase();
      const cur = m.get(k);
      if (cur) {
        cur.mine ||= mine;
        if (mine) {
          cur.myUnits += l.units;
          cur.myPremium += l.premium;
        }
      } else {
        m.set(k, { ...l, mine, myUnits: mine ? l.units : 0n, myPremium: mine ? l.premium : 0n });
      }
    }
    return [...m.values()];
  }, [all.data, address]);

  const ids = series.map((s) => s.seriesId);
  const readsEnabled = isDeployed && !!address && ids.length > 0;
  const balanceRead = useReadContract({
    address: deployment.market,
    abi: marketAbi,
    functionName: "balanceOfBatch",
    args: [ids.map(() => address ?? zeroAddress), ids],
    query: { enabled: readsEnabled, refetchInterval: 15_000 },
  });
  const seriesReads = useReadContracts({
    contracts: ids.map((id) => ({ address: deployment.market, abi: marketAbi, functionName: "getSeries", args: [id] }) as const),
    allowFailure: true,
    query: { enabled: readsEnabled, refetchInterval: 15_000 },
  });

  const positions = useMemo<Position[] | undefined>(() => {
    const balances = balanceRead.data;
    const infos = seriesReads.data;
    if (!balances || !infos || !address) return undefined;
    const claimedBy = new Map<string, bigint>();
    for (const c of claimed.data ?? []) claimedBy.set(c.seriesId.toString(), (claimedBy.get(c.seriesId.toString()) ?? 0n) + c.payout);
    const t = now || Math.floor(Date.now() / 1000);
    const out: Position[] = [];
    series.forEach((s, i) => {
      const sr = infos[i];
      if (!sr || sr.status !== "success") return;
      const info = sr.result;
      const balance = balances[i] ?? 0n;
      const hasClaim = claimedBy.has(s.seriesId.toString());
      if (balance === 0n && !s.mine && !hasClaim) return;
      const expiry = Number(info.expiry);
      let status: Status;
      if (balance === 0n) status = "claimed";
      else if (info.settled) status = info.settlePrice < info.strike ? "itm" : "otm";
      else if (t >= expiry) status = "awaiting";
      else status = "open";
      const payout = info.settled && info.settlePrice < info.strike ? toAsset(info.strike - info.settlePrice, balance) : 0n;
      out.push({
        seriesId: s.seriesId,
        underlyingId: info.underlyingId,
        strike: info.strike,
        expiry,
        balance,
        settled: info.settled,
        settlePrice: info.settlePrice,
        openUnits: info.openUnits,
        status,
        payout,
        claimedPayout: claimedBy.get(s.seriesId.toString()) ?? 0n,
        boughtUnits: s.myUnits,
        premiumPaid: s.myPremium,
      });
    });
    const rank: Record<Status, number> = { awaiting: 0, itm: 1, open: 2, otm: 3, claimed: 4 };
    return out.sort((a, b) => rank[a.status] - rank[b.status] || a.expiry - b.expiry);
  }, [balanceRead.data, seriesReads.data, address, series, claimed.data, now]);

  const settle = (p: Position) =>
    send(`Settle ${underlyingById(p.underlyingId)?.symbol ?? ""} series`, {
      address: deployment.market,
      abi: marketAbi,
      functionName: "settle",
      args: [p.seriesId],
    });
  const claim = (p: Position) =>
    send(`Claim ${fmtUsd(p.payout)}`, {
      address: deployment.market,
      abi: marketAbi,
      functionName: "claim",
      args: [p.seriesId, p.balance],
    });

  const loading = all.isLoading || (readsEnabled && (balanceRead.isLoading || seriesReads.isLoading));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Your positions</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Protection positions are ERC-1155 tokens keyed by (underlying, strike, expiry). After expiry anyone can settle
          the series at the first feed print; you then claim your payout and the remaining collateral returns to writers.
        </p>
      </div>

      {!mounted || !isConnected ? (
        <Card>
          <InfoNote>Connect a wallet to see your positions.</InfoNote>
        </Card>
      ) : !isDeployed ? (
        <Card>
          <InfoNote>Positions will appear once the market contract is deployed.</InfoNote>
        </Card>
      ) : all.error ? (
        <Card>
          <ErrorNote>Could not load positions: {all.error.message.split("\n")[0]}</ErrorNote>
        </Card>
      ) : loading ? (
        <div className="grid gap-3">
          {[0, 1].map((i) => (
            <Card key={i}>
              <Skeleton className="h-5 w-40" />
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[0, 1, 2, 3].map((j) => (
                  <Skeleton key={j} className="h-8 w-full" />
                ))}
              </div>
            </Card>
          ))}
        </div>
      ) : !positions || positions.length === 0 ? (
        <Card>
          <InfoNote>No positions yet. Buy protection on the Protect tab.</InfoNote>
        </Card>
      ) : (
        <div className="grid gap-3">
          {positions.map((p) => (
            <PositionCard key={p.seriesId.toString()} p={p} now={now} busy={busy} onSettle={() => settle(p)} onClaim={() => claim(p)} />
          ))}
        </div>
      )}
    </div>
  );
}

function StatusPill({ s }: { s: Status }) {
  switch (s) {
    case "open": return <Pill tone="accent">Open</Pill>;
    case "awaiting": return <Pill tone="closed">Expired · awaiting print</Pill>;
    case "itm": return <Pill tone="live">Settled · in the money</Pill>;
    case "otm": return <Pill>Settled · out of the money</Pill>;
    case "claimed": return <Pill dot={false}>Claimed</Pill>;
  }
}

function PositionCard({ p, now, busy, onSettle, onClaim }: { p: Position; now: number; busy: boolean; onSettle: () => void; onClaim: () => void }) {
  const u = underlyingById(p.underlyingId);
  const t = now || Math.floor(Date.now() / 1000);
  const remaining = p.expiry - t;
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold">{u?.symbol ?? `#${p.underlyingId}`}</span>
            <span className="num text-sm text-muted">{fmtPrice(p.strike)} put</span>
            <StatusPill s={p.status} />
          </div>
          <div className="mt-1 text-xs text-muted">
            Expiry {fmtTime(p.expiry)}
            {p.status === "open" && (
              <>
                {" "}· <span className="num text-fg">{fmtDuration(remaining)}</span> left
              </>
            )}
            {p.status === "awaiting" && <> · expired {fmtDuration(-remaining)} ago</>}
          </div>
        </div>
        <div className="flex gap-2">
          {p.status === "awaiting" && (
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={onSettle}>
              Settle
            </button>
          )}
          {(p.status === "itm" || p.status === "otm") && (
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={onClaim}>
              {p.status === "itm" ? `Claim ${fmtUsd(p.payout)}` : "Claim (release collateral)"}
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-5">
        <div>
          <div className="label">Units held</div>
          <div className="num mt-1">{fmtUnits(p.balance, 4)}</div>
        </div>
        <div>
          <div className="label">Premium paid</div>
          <div className="num mt-1">{p.boughtUnits > 0n ? fmtUsd(p.premiumPaid) : "—"}</div>
        </div>
        <div>
          <div className="label">Settle price</div>
          <div className="num mt-1">{p.settled ? fmtPrice(p.settlePrice) : <span className="text-dim">pending</span>}</div>
        </div>
        <div>
          <div className="label">Payout</div>
          <div className={`num mt-1 ${p.payout > 0n ? "text-pos" : ""}`}>
            {p.status === "claimed" ? fmtUsd(p.claimedPayout) : p.settled ? fmtUsd(p.payout) : <span className="text-dim">—</span>}
          </div>
        </div>
        <div>
          <div className="label">Series open units</div>
          <div className="num mt-1 text-muted">{fmtUnits(p.openUnits, 2)}</div>
        </div>
      </div>
      {p.status === "awaiting" && (
        <p className="mt-3 text-[11px] leading-relaxed text-dim">
          Settlement uses the first feed print at or after expiry. If the feed has not printed since expiry (e.g. over a
          weekend), settle will revert with AwaitingPostExpiryPrint until it does; after the grace period the last price is used.
        </p>
      )}
    </Card>
  );
}
