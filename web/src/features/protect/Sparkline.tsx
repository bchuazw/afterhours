"use client";

import { useMemo, useState } from "react";
import type { Address } from "viem";
import { useFeedHistory } from "@/lib/hooks/useFeedHistory";
import { isClosedAt } from "@/lib/market-hours";
import { fmtPrice, fmtTimeShort, priceToNumber } from "@/lib/format";
import { Skeleton } from "@/components/ui";

const W = 720;
const H = 160;
const PAD = { l: 8, r: 8, t: 12, b: 18 };

/**
 * Inline SVG line of the last ~80 feed rounds. Weekend/closed windows are shaded; a flat segment
 * across a shaded band is exactly the "frozen feed" the product hedges.
 */
export function Sparkline({ feed, symbol, strike }: { feed: Address; symbol: string; strike?: bigint }) {
  const { data, isLoading, error } = useFeedHistory(feed, 80);
  const [hover, setHover] = useState<number | null>(null);

  const model = useMemo(() => {
    if (!data || data.length < 2) return null;
    const xs = data.map((p) => p.updatedAt);
    const ys = data.map((p) => priceToNumber(p.price));
    const x0 = xs[0];
    const x1 = xs[xs.length - 1];
    const strikeN = strike !== undefined ? priceToNumber(strike) : undefined;
    let yMin = Math.min(...ys);
    let yMax = Math.max(...ys);
    if (strikeN !== undefined && strikeN > yMin * 0.8 && strikeN < yMax * 1.2) {
      yMin = Math.min(yMin, strikeN);
      yMax = Math.max(yMax, strikeN);
    }
    const padY = (yMax - yMin || yMax * 0.01) * 0.12;
    yMin -= padY;
    yMax += padY;
    const sx = (t: number) => PAD.l + ((t - x0) / Math.max(1, x1 - x0)) * (W - PAD.l - PAD.r);
    const sy = (v: number) => PAD.t + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);
    const pts = data.map((p, i) => ({ x: sx(xs[i]), y: sy(ys[i]), t: xs[i], v: ys[i], raw: p.price }));
    const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

    // Shade windows where the feed was frozen: consecutive prints > 2h apart, or in the closed window.
    const bands: { x: number; w: number }[] = [];
    for (let i = 1; i < pts.length; i++) {
      const gap = xs[i] - xs[i - 1];
      if (gap > 2 * 3600 || (isClosedAt(xs[i - 1]) && isClosedAt(xs[i]))) {
        bands.push({ x: pts[i - 1].x, w: Math.max(1.5, pts[i].x - pts[i - 1].x) });
      }
    }
    const last = pts[pts.length - 1];
    const first = pts[0];
    const up = last.v >= first.v;
    return { pts, path, bands, strikeY: strikeN !== undefined ? sy(strikeN) : undefined, up, x0, x1 };
  }, [data, strike]);

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (error) return <div className="text-xs text-neg">Could not load feed history: {error.message.split("\n")[0]}</div>;
  if (!model) return <div className="text-xs text-muted">Not enough feed history yet.</div>;

  const hp = hover !== null ? model.pts[hover] : model.pts[model.pts.length - 1];

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <div className="flex items-center gap-3 text-muted">
          <span>
            <span className="num text-fg">{fmtPrice(hp.raw)}</span> · {fmtTimeShort(hp.t)}
          </span>
        </div>
        <div className="flex items-center gap-3 text-dim">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-3 bg-warn/20 ring-1 ring-warn/30" /> closed market
          </span>
          {model.strikeY !== undefined && (
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-px w-3 border-t border-dashed border-accent" /> your strike
            </span>
          )}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-40 w-full"
        preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - rect.left) / rect.width) * W;
          let best = 0;
          let bd = Infinity;
          model.pts.forEach((p, i) => {
            const d = Math.abs(p.x - x);
            if (d < bd) {
              bd = d;
              best = i;
            }
          });
          setHover(best);
        }}
        role="img"
        aria-label={`${symbol} price history, last ${model.pts.length} feed rounds`}
      >
        <defs>
          <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={model.up ? "#34d399" : "#fb7185"} stopOpacity="0.18" />
            <stop offset="100%" stopColor={model.up ? "#34d399" : "#fb7185"} stopOpacity="0" />
          </linearGradient>
        </defs>
        {model.bands.map((b, i) => (
          <rect key={i} x={b.x} y={PAD.t - 6} width={b.w} height={H - PAD.t - PAD.b + 12} fill="#fbbf24" fillOpacity="0.10" />
        ))}
        <path d={`${model.path} L${model.pts[model.pts.length - 1].x},${H - PAD.b} L${model.pts[0].x},${H - PAD.b} Z`} fill="url(#sparkFill)" />
        <path d={model.path} fill="none" stroke={model.up ? "#34d399" : "#fb7185"} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        {model.strikeY !== undefined && (
          <line x1={PAD.l} x2={W - PAD.r} y1={model.strikeY} y2={model.strikeY} stroke="#8ea6ff" strokeDasharray="4 4" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        )}
        {hover !== null && (
          <line x1={hp.x} x2={hp.x} y1={PAD.t - 6} y2={H - PAD.b} stroke="#5c6275" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        )}
        <circle cx={hp.x} cy={hp.y} r="3" fill={model.up ? "#34d399" : "#fb7185"} />
        <text x={PAD.l} y={H - 4} fill="#5c6275" fontSize="10" fontFamily="var(--font-mono)">
          {fmtTimeShort(model.x0)}
        </text>
        <text x={W - PAD.r} y={H - 4} fill="#5c6275" fontSize="10" textAnchor="end" fontFamily="var(--font-mono)">
          {fmtTimeShort(model.x1)}
        </text>
      </svg>
    </div>
  );
}
