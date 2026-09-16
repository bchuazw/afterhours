"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { formatUnits } from "viem";
import { COMPANY, deployment, isZero, type UnderlyingKey } from "@/lib/deployment";
import { useFeed } from "@/lib/hooks/useFeed";
import { useMarketConfig, useUnderlyingInfo } from "@/lib/hooks/useMarket";
import { useErc20Balance } from "@/lib/hooks/useToken";
import { useNow, useMounted } from "@/lib/hooks/useNow";
import { useDebounced } from "@/lib/hooks/useDebounce";
import { feedStatus, fromDatetimeLocal, nextFridayClose, nextMondayOpen, toDatetimeLocal } from "@/lib/market-hours";
import { fmtDuration, fmtPrice, fmtTime, fmtUnits, parseDecimal, PRICE_DECIMALS, UNIT_DECIMALS } from "@/lib/format";
import { Card, SectionTitle, Skeleton } from "@/components/ui";
import { UnderlyingSelector, FeedPill } from "./UnderlyingSelector";
import { QuoteCard, type QuoteInputs } from "./QuoteCard";
import { Sparkline } from "./Sparkline";
import { RecentProtection } from "./RecentProtection";

type StrikeMode = 95 | 90 | 85 | "custom";
type ExpiryMode = "monday" | "friday" | "7d" | "30d" | "custom";

const EXPIRY_PRESETS: { id: ExpiryMode; label: string; hint: string }[] = [
  { id: "monday", label: "Monday open", hint: "Mon 13:30 UTC" },
  { id: "friday", label: "Friday close", hint: "Fri 20:00 UTC" },
  { id: "7d", label: "7 days", hint: "" },
  { id: "30d", label: "30 days", hint: "" },
  { id: "custom", label: "Custom", hint: "" },
];

/** Round an 8-decimal price to cents. */
const toCents = (p8: bigint) => (p8 / 1_000_000n) * 1_000_000n;

export function ProtectPage() {
  const [key, setKey] = useState<UnderlyingKey>("TSLA");
  const u = deployment.underlyings[key];
  const { address: connectedAddress } = useAccount();
  const mounted = useMounted();
  // The burner wallet reconnects synchronously on the client; keep the first render server-equal.
  const address = mounted ? connectedAddress : undefined;
  const now = useNow(1000);

  const feed = useFeed(u.feed);
  const spot = feed.data?.answer;
  const status = feedStatus(feed.data?.updatedAt, feed.data?.paused ?? false, now ? now * 1000 : Date.now());
  const { config } = useMarketConfig();
  const { info } = useUnderlyingInfo(u.id);
  const { data: stockBal } = useErc20Balance(isZero(u.stockToken) ? undefined : u.stockToken, address);

  // ---- strike ----
  const [strikeMode, setStrikeMode] = useState<StrikeMode>(90);
  const [customStrike, setCustomStrike] = useState("");
  const strike8 = useMemo(() => {
    if (strikeMode === "custom") return parseDecimal(customStrike, PRICE_DECIMALS);
    if (!spot) return undefined;
    return toCents((spot * BigInt(strikeMode)) / 100n);
  }, [strikeMode, customStrike, spot]);

  // ---- expiry (presets are fixed at selection time so the quote key is stable) ----
  const [expiryMode, setExpiryMode] = useState<ExpiryMode>("monday");
  const [customExpiry, setCustomExpiry] = useState("");
  const [presetExpiry, setPresetExpiry] = useState<number | undefined>(undefined);
  useEffect(() => {
    const nowMs = Date.now();
    const sec = Math.floor(nowMs / 1000);
    if (expiryMode === "monday") setPresetExpiry(nextMondayOpen(nowMs));
    else if (expiryMode === "friday") setPresetExpiry(nextFridayClose(nowMs));
    else if (expiryMode === "7d") setPresetExpiry(sec + 7 * 86400);
    else if (expiryMode === "30d") setPresetExpiry(sec + 30 * 86400 - 15 * 60);
    else {
      setPresetExpiry(undefined);
      if (!customExpiry) setCustomExpiry(toDatetimeLocal(sec + 3 * 86400));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiryMode]);
  const expiry = expiryMode === "custom" ? fromDatetimeLocal(customExpiry) : presetExpiry;

  // ---- units ----
  const [units, setUnits] = useState("1");
  const units18 = parseDecimal(units, UNIT_DECIMALS);

  // ---- validation ----
  const validation = useMemo(() => {
    const t = now || Math.floor(Date.now() / 1000);
    if (feed.enabled && feed.data?.paused) return "The feed is paused for a corporate action; quotes are unavailable.";
    if (strikeMode === "custom" && customStrike && !strike8) return "Enter a valid strike price.";
    if (!units18 || units18 === 0n) return "Enter how many shares to protect.";
    if (expiry === undefined) return "Pick an expiry.";
    if (expiry < t + config.minTenor) return `Expiry must be at least ${fmtDuration(config.minTenor)} from now.`;
    if (expiry > t + config.maxTenor) return `Expiry must be within ${fmtDuration(config.maxTenor)} from now.`;
    if (spot && strike8) {
      const bps = (strike8 * 10_000n) / spot;
      if (bps < BigInt(config.minStrikeBps) || bps > BigInt(config.maxStrikeBps))
        return `Strike must be between ${config.minStrikeBps / 100}% and ${config.maxStrikeBps / 100}% of spot (${fmtPrice(spot)}).`;
    }
    return undefined;
  }, [now, feed.enabled, feed.data?.paused, strikeMode, customStrike, strike8, units18, expiry, config, spot]);

  const debounced = useDebounced<QuoteInputs>({ strike8, expiry, units18, validation }, 400);

  const tenor = expiry ? Math.max(0, expiry - (now || Math.floor(Date.now() / 1000))) : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Protect your Stock Tokens through the weekend</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Stock Tokens trade 24/7, but their price feeds freeze from Friday close to Monday open. Buy cash-settled
            downside protection priced onchain, paid out at the first print after expiry.
          </p>
        </div>
      </div>

      <UnderlyingSelector value={key} onChange={setKey} />

      <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <Card className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="label">Protecting</div>
              <div className="mt-0.5 flex items-baseline gap-2">
                <span className="text-lg font-semibold">{u.symbol}</span>
                <span className="text-sm text-muted">{COMPANY[key]}</span>
                <span className="num text-sm text-muted">
                  {feed.enabled ? feed.isLoading ? <Skeleton className="h-4 w-16" /> : fmtPrice(spot) : "—"}
                </span>
              </div>
            </div>
            {feed.enabled && feed.data && <FeedPill status={status} long />}
          </div>

          {/* Strike */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="label">Strike</span>
              <span className="num text-xs text-muted">{strike8 ? fmtPrice(strike8) : "—"}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="seg">
                {([95, 90, 85] as const).map((p) => (
                  <button key={p} data-active={strikeMode === p} onClick={() => setStrikeMode(p)}>
                    {p}%
                  </button>
                ))}
                <button data-active={strikeMode === "custom"} onClick={() => { setStrikeMode("custom"); if (!customStrike && spot) setCustomStrike(formatUnits(toCents((spot * 90n) / 100n), PRICE_DECIMALS)); }}>
                  Custom
                </button>
              </div>
              {strikeMode === "custom" && (
                <div className="relative flex-1 min-w-[160px]">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">$</span>
                  <input className="input num pl-7" inputMode="decimal" value={customStrike} onChange={(e) => setCustomStrike(e.target.value)} placeholder="Strike price" />
                </div>
              )}
            </div>
            <p className="mt-1.5 text-[11px] text-dim">Percent of spot. You are paid (strike − settle price) per share if the print at expiry is below the strike.</p>
          </div>

          {/* Expiry */}
          <div>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="label">Expiry</span>
              <span className="num text-right text-xs text-muted">{expiry ? `${fmtTime(expiry)} · in ${fmtDuration(tenor)}` : "—"}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="seg flex-wrap">
                {EXPIRY_PRESETS.map((p) => (
                  <button key={p.id} data-active={expiryMode === p.id} onClick={() => setExpiryMode(p.id)} title={p.hint}>
                    {p.label}
                  </button>
                ))}
              </div>
              {expiryMode === "custom" && (
                <input type="datetime-local" className="input num flex-1 min-w-[200px]" value={customExpiry} onChange={(e) => setCustomExpiry(e.target.value)} />
              )}
            </div>
          </div>

          {/* Units */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="label">Shares to protect</span>
              {stockBal !== undefined && (
                <button className="text-xs text-accent hover:underline" onClick={() => setUnits(formatUnits(stockBal, UNIT_DECIMALS))}>
                  Protect all · {fmtUnits(stockBal, 4)} {u.symbol}
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <input className="input num" inputMode="decimal" value={units} onChange={(e) => setUnits(e.target.value)} placeholder="1.0" />
              <div className="seg">
                {["0.1", "1", "10"].map((v) => (
                  <button key={v} data-active={units === v} onClick={() => setUnits(v)}>
                    {v}
                  </button>
                ))}
              </div>
            </div>
            <p className="mt-1.5 text-[11px] text-dim">
              {isZero(u.stockToken)
                ? "Protection is cash-settled; you do not need to hold the Stock Token to buy it."
                : address
                  ? `Your ${u.symbol} Stock Token balance is shown above. Protection is cash-settled, so any amount works.`
                  : "Connect a wallet to see your Stock Token balance."}
            </p>
          </div>
        </Card>

        <QuoteCard underlying={u} inputs={debounced} lookback={info?.params.lookback} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <Card>
          <SectionTitle right={<span className="text-[11px] text-dim">last ~80 feed rounds</span>}>
            {u.symbol} feed history
          </SectionTitle>
          {feed.enabled ? (
            <Sparkline feed={u.feed} symbol={u.symbol} strike={strike8} />
          ) : (
            <div className="text-xs text-muted">Feed not deployed.</div>
          )}
        </Card>
        <Card>
          <SectionTitle>Why the weekend matters</SectionTitle>
          <ul className="space-y-2 text-sm text-muted">
            <li className="flex gap-2"><span className="text-warn">▮</span><span>Shaded bands are closed-market windows: the feed holds Friday&apos;s close for ~52 hours while the token keeps trading.</span></li>
            <li className="flex gap-2"><span className="text-accent">╌</span><span>The dashed line is your strike. If Monday&apos;s first print lands below it, you are paid the difference per share.</span></li>
            <li className="flex gap-2"><span className="text-pos">●</span><span>Premiums are quoted from realized vol over the lookback window, with closed hours weighted by the closed-market multiplier.</span></li>
          </ul>
        </Card>
      </div>

      <Card>
        <SectionTitle right={<span className="text-[11px] text-dim">from ProtectionBought events</span>}>Recent protection · {u.symbol}</SectionTitle>
        <RecentProtection underlyingId={u.id} />
      </Card>
    </div>
  );
}
