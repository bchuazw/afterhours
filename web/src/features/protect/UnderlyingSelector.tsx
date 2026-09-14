"use client";

import { COMPANY, underlyingList, type UnderlyingDeployment, type UnderlyingKey } from "@/lib/deployment";
import { useFeed } from "@/lib/hooks/useFeed";
import { useNow } from "@/lib/hooks/useNow";
import { feedStatus } from "@/lib/market-hours";
import { fmtAgo, fmtPrice, fmtUtc } from "@/lib/format";
import { Pill, Skeleton } from "@/components/ui";

export function UnderlyingSelector({ value, onChange }: { value: UnderlyingKey; onChange: (k: UnderlyingKey) => void }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {underlyingList.map((u) => (
        <UnderlyingTile key={u.key} u={u} active={u.key === value} onClick={() => onChange(u.key)} />
      ))}
    </div>
  );
}

function UnderlyingTile({ u, active, onClick }: { u: UnderlyingDeployment; active: boolean; onClick: () => void }) {
  const { data, isLoading, error, enabled } = useFeed(u.feed);
  const now = useNow(10_000);
  const status = feedStatus(data?.updatedAt, data?.paused ?? false, now ? now * 1000 : Date.now());

  return (
    <button
      type="button"
      onClick={onClick}
      className={`card group text-left transition ${active ? "border-accent-2/70 ring-1 ring-accent-2/40" : "hover:border-line-2"}`}
    >
      <div className="flex items-start justify-between gap-2 p-4">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold tracking-tight">{u.symbol}</span>
            <span className="text-xs text-muted">{COMPANY[u.key]}</span>
          </div>
          <div className="num mt-1.5 text-2xl leading-none">
            {!enabled ? <span className="text-dim">—</span> : isLoading ? <Skeleton className="h-6 w-24" /> : error ? <span className="text-neg text-sm">feed error</span> : fmtPrice(data?.answer)}
          </div>
          <div className="mt-1.5 text-[11px] text-dim">
            {data ? (
              <span title={fmtUtc(data.updatedAt)}>Last print {fmtAgo(data.updatedAt, now || Date.now() / 1000)}</span>
            ) : enabled && !error ? (
              <Skeleton className="h-3 w-20" />
            ) : (
              "no feed"
            )}
          </div>
        </div>
        <div className="shrink-0">
          {enabled && data ? <FeedPill status={status} /> : null}
        </div>
      </div>
    </button>
  );
}

export function FeedPill({ status, long = false }: { status: ReturnType<typeof feedStatus>; long?: boolean }) {
  if (status.kind === "live") return <Pill tone="live">{long ? "Market open · feed live" : "Open"}</Pill>;
  if (status.kind === "closed")
    return (
      <Pill tone="closed">
        {long ? `Market closed · feed frozen since ${fmtUtc(status.since)}` : "Closed"}
      </Pill>
    );
  if (status.kind === "paused") return <Pill tone="neg">{long ? status.label : "Paused"}</Pill>;
  if (status.kind === "stale") return <Pill tone="closed">{long ? `Feed quiet · last print ${fmtUtc(status.since)}` : "Quiet"}</Pill>;
  return <Pill>{status.label}</Pill>;
}
