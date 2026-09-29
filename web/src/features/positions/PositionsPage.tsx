"use client";

import { useMemo, useState } from "react";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { zeroAddress } from "viem";
import { marketAbi } from "@/abi";
import { deployment, isDeployed, underlyingById } from "@/lib/deployment";
import { useClaimed, useProtectionBought, type BoughtLog } from "@/lib/hooks/useLogs";
import { useNow, useMounted } from "@/lib/hooks/useNow";
import { useTx, WRONG_CHAIN_HINT, type TxFailure } from "@/lib/hooks/useTx";
import { fmtDuration, fmtPrice, fmtTime, fmtUnits, fmtUsd } from "@/lib/format";
import { Card, ErrorNote, InfoNote, Pill, Skeleton } from "@/components/ui";

type Status = "open" | "awaiting" | "itm" | "otm" | "claimed";

type Position = {
  seriesId: bigint;
  underlyingId: number;
  strike: bigint;
  expiry: number;
  grace: number;
  balance: bigint;
  settled: boolean;
  settlePrice: bigint;
  openUnits: bigint;
  owed: bigint; // series-wide payout escrowed in the market for unclaimed units
  status: Status;
  claimable: bigint; // pro-rata share of `owed` for `balance` units
  claimedPayout: bigint; // historical, from Claimed logs
  boughtUnits: bigint;
  premiumPaid: bigint;
};

/** Mirrors AfterHoursMarket.claim: the last claimant takes the remainder, others are paid pro rata (floor). */
const proRata = (owed: bigint, units: bigint, openUnits: bigint) =>
  units === 0n || openUnits === 0n ? 0n : units === openUnits ? owed : (owed * units) / openUnits;

/** Errors from settle() that deserve a note on the card, not just a toast. */
const SETTLE_NOTES = new Set(["SettleWalkTooLong", "AwaitingPostExpiryPrint", "FeedPaused"]);

export function PositionsPage() {
  const mounted = useMounted();
  const { address, isConnected } = useAccount();
  const now = useNow(1000);
  const { send, busy, wrongChain } = useTx();
  const [notes, setNotes] = useState<Record<string, string>>({});

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
      const claimable = info.settled ? proRata(info.owed, balance, info.openUnits) : 0n;
      let status: Status;
      if (balance === 0n) status = "claimed";
      else if (info.settled) status = info.settlePrice < info.strike && info.owed > 0n ? "itm" : "otm";
      else if (t >= expiry) status = "awaiting";
      else status = "open";
      out.push({
        seriesId: s.seriesId,
        underlyingId: info.underlyingId,
        strike: info.strike,
        expiry,
        grace: Number(info.grace),
        balance,
        settled: info.settled,
        settlePrice: info.settlePrice,
        openUnits: info.openUnits,
        owed: info.owed,
        status,
        claimable,
        claimedPayout: claimedBy.get(s.seriesId.toString()) ?? 0n,
        boughtUnits: s.myUnits,
        premiumPaid: s.myPremium,
      });
    });
    const rank: Record<Status, number> = { awaiting: 0, itm: 1, open: 2, otm: 3, claimed: 4 };
    return out.sort((a, b) => rank[a.status] - rank[b.status] || a.expiry - b.expiry);
  }, [balanceRead.data, seriesReads.data, address, series, claimed.data, now]);

  const noteFor = (p: Position) => (f: TxFailure) => {
    if (f.errorName && SETTLE_NOTES.has(f.errorName)) setNotes((n) => ({ ...n, [p.seriesId.toString()]: f.message }));
  };

  const settle = async (p: Position) => {
    setNotes((n) => {
      const next = { ...n };
      delete next[p.seriesId.toString()];
      return next;
    });
    await send(
      `Settle ${underlyingById(p.underlyingId)?.symbol ?? ""} series`,
      { address: deployment.market, abi: marketAbi, functionName: "settle", args: [p.seriesId] },
      { onError: noteFor(p) },
    );
  };
  const claim = (p: Position) =>
    send(p.claimable > 0n ? `Claim ${fmtUsd(p.claimable)}` : "Burn worthless position", {
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
          Protection positions are ERC-1155 tokens keyed by (underlying, strike, expiry); one unit protects one Stock
          Token. After expiry anyone can settle the series at the first valid feed print at or after expiry. Settlement
          moves the series&apos; payout into escrow and returns the rest of the collateral to writers, so out-of-the-money
          positions need no claim; in-the-money holders claim their pro-rata share.
        </p>
      </div>

      {mounted && wrongChain && (
        <Card>
          <InfoNote>{WRONG_CHAIN_HINT}</InfoNote>
        </Card>
      )}

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
            <PositionCard
              key={p.seriesId.toString()}
              p={p}
              now={now}
              disabled={busy || wrongChain}
              note={notes[p.seriesId.toString()]}
              onSettle={() => settle(p)}
              onClaim={() => claim(p)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StatusPill({ s }: { s: Status }) {
  switch (s) {
    case "open": return <Pill tone="accent">Open</Pill>;
    case "awaiting": return <Pill tone="closed">Expired · awaiting settlement</Pill>;
    case "itm": return <Pill tone="live">Settled · in the money</Pill>;
    case "otm": return <Pill>Settled · worthless</Pill>;
    case "claimed": return <Pill dot={false}>Claimed</Pill>;
  }
}

function PositionCard({
  p,
  now,
  disabled,
  note,
  onSettle,
  onClaim,
}: {
  p: Position;
  now: number;
  disabled: boolean;
  note?: string;
  onSettle: () => void;
  onClaim: () => void;
}) {
  const u = underlyingById(p.underlyingId);
  const t = now || Math.floor(Date.now() / 1000);
  const remaining = p.expiry - t;
  const fallbackAt = p.expiry + p.grace;
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
            <button className="btn btn-primary btn-sm" disabled={disabled} onClick={onSettle}>
              Settle
            </button>
          )}
          {p.status === "itm" && (
            <button className="btn btn-primary btn-sm" disabled={disabled} onClick={onClaim}>
              Claim {fmtUsd(p.claimable)}
            </button>
          )}
          {p.status === "otm" && (
            <button className="btn btn-sm" disabled={disabled} onClick={onClaim} title="Optional: burns the worthless position tokens. Pays nothing.">
              Burn position
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-5">
        <div>
          <div className="label">Tokens protected</div>
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
          <div className="label">{p.status === "claimed" ? "Claimed" : "Your payout"}</div>
          <div className={`num mt-1 ${p.claimable > 0n || p.claimedPayout > 0n ? "text-pos" : ""}`}>
            {p.status === "claimed" ? fmtUsd(p.claimedPayout) : p.settled ? fmtUsd(p.claimable) : <span className="text-dim">—</span>}
          </div>
        </div>
        <div>
          <div className="label">Series escrow</div>
          <div className="num mt-1 text-muted">
            {p.settled ? fmtUsd(p.owed) : <span className="text-dim">—</span>}
            <span className="text-dim"> · {fmtUnits(p.openUnits, 2)} open</span>
          </div>
        </div>
      </div>

      {p.status === "otm" && (
        <p className="mt-3 text-[11px] leading-relaxed text-dim">
          Settled worthless, nothing to claim: the settle price was at or above the strike, and all collateral went back
          to the writers at settlement. Burning the position is optional.
        </p>
      )}
      {p.status === "itm" && (
        <p className="mt-3 text-[11px] leading-relaxed text-dim">
          Pays max(strike − settle, 0) per token. Your {fmtUnits(p.balance, 4)} of {fmtUnits(p.openUnits, 4)} open units
          {p.balance === p.openUnits ? " take the whole escrow" : " take a pro-rata share of the escrow"}.
        </p>
      )}
      {p.status === "awaiting" && (
        <p className="mt-3 text-[11px] leading-relaxed text-dim">
          Settlement uses the first valid feed print at or after expiry. Until one arrives, settle reverts with
          AwaitingPostExpiryPrint; after this series&apos; grace period ({fmtDuration(p.grace)}, from {fmtTime(fallbackAt)})
          the latest valid price is used so collateral never strands. If the walk back to that print is too long, the
          keeper settles with a round hint (settleAt).
        </p>
      )}
      {note && <div className="mt-3 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs leading-relaxed text-warn">{note}</div>}
    </Card>
  );
}
