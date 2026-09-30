"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { formatUnits } from "viem";
import { COMPANY, deployment, isZero, type UnderlyingKey } from "@/lib/deployment";
import { useFeed } from "@/lib/hooks/useFeed";
import { presetStrike, strikeBounds, useMarketConfig, useUnderlyingInfo } from "@/lib/hooks/useMarket";
import { useErc20Balance } from "@/lib/hooks/useToken";
import { useActiveSeries, type SeriesInfo } from "@/lib/hooks/useSeries";
import { useNow, useMounted } from "@/lib/hooks/useNow";
import { useDebounced } from "@/lib/hooks/useDebounce";
import {
  feedStatus,
  fromDatetimeLocal,
  isDarkAt,
  nextLiveAt,
  presetExpiry,
  toDatetimeLocal,
  type ExpiryPreset,
} from "@/lib/market-hours";
import { fmtDuration, fmtPrice, fmtTime, fmtUnits, fmtUtc, parseDecimal, PRICE_DECIMALS, UNIT_DECIMALS } from "@/lib/format";
import { Card, SectionTitle, Skeleton } from "@/components/ui";
import { UnderlyingSelector, FeedPill } from "./UnderlyingSelector";
import { QuoteCard, type QuoteInputs } from "./QuoteCard";
import { Sparkline } from "./Sparkline";
import { RecentProtection } from "./RecentProtection";

type StrikeMode = 95 | 90 | 85 | "custom";
/** "series" = strike and expiry copied from an open series (see joinSeries), so the buy joins it. */
type ExpiryMode = ExpiryPreset | "custom" | "series";

/**
 * Presets land on listed times (weekday 19:00 UTC, the last whole hour of the US regular session in
 * both DST regimes, or Monday 13:30 UTC), so everyone who picks the same preset that day shares one
 * series instead of opening a new one per minute. None of them fall in the Friday-evening dark slice.
 */
const EXPIRY_PRESETS: { id: ExpiryPreset | "custom"; label: string; hint: string }[] = [
  { id: "monday", label: "Monday open", hint: "Next Monday 13:30 UTC at least the minimum tenor away" },
  { id: "friday", label: "Friday close", hint: "Next Friday 19:00 UTC, the last hour of the regular session before the feeds go quiet for the weekend" },
  { id: "7d", label: "7 days", hint: "First weekday 19:00 UTC at least 7 days out (weekends roll to Monday)" },
  { id: "30d", label: "30 days", hint: "Last weekday 19:00 UTC within the max tenor" },
  { id: "custom", label: "Custom", hint: "" },
];

export function ProtectPage() {
  const [key, setKey] = useState<UnderlyingKey>("TSLA");
  const u = deployment.underlyings[key];
  const { address: connectedAddress } = useAccount();
  const mounted = useMounted();
  // The burner wallet reconnects synchronously on the client; keep the first render server-equal.
  const address = mounted ? connectedAddress : undefined;
  const now = useNow(1000);
  // True while an approve + buy is in flight: every input is frozen until it finishes.
  const [inFlight, setInFlight] = useState(false);

  const feed = useFeed(u.feed, { underlyingId: u.id });
  const spot = feed.data?.answer;
  const { config } = useMarketConfig();
  const status = feedStatus(feed.data?.updatedAt, {
    paused: feed.data?.paused,
    invalid: feed.data?.invalid,
    maxPriceAge: config.maxPriceAge,
    nowMs: now ? now * 1000 : Date.now(),
  });
  const { info } = useUnderlyingInfo(u.id);
  const { data: stockBal } = useErc20Balance(isZero(u.stockToken) ? undefined : u.stockToken, address);

  // ---- strike (whole-dollar tick, inside the market's band around spot) ----
  const [strikeMode, setStrikeMode] = useState<StrikeMode>(90);
  const [customStrike, setCustomStrike] = useState("");
  const bounds = useMemo(() => (spot ? strikeBounds(spot, config) : undefined), [spot, config]);
  const strikeParsed = useMemo(() => {
    if (strikeMode === "custom") return parseDecimal(customStrike, PRICE_DECIMALS);
    return spot ? presetStrike(spot, strikeMode, config) : undefined;
  }, [strikeMode, customStrike, spot, config]);
  const strikeError = useMemo(() => {
    if (strikeMode !== "custom" || !customStrike.trim()) return undefined;
    const tick = config.strikeTick;
    if (strikeParsed === undefined || strikeParsed === 0n) return "Enter a valid strike price.";
    if (strikeParsed % tick !== 0n) {
      const lower = (strikeParsed / tick) * tick;
      return `Strikes are whole-dollar amounts (${fmtPrice(tick)} tick). Try ${fmtPrice(lower > 0n ? lower : tick)} or ${fmtPrice(lower + tick)}.`;
    }
    if (bounds && spot && (strikeParsed < bounds.lo || strikeParsed > bounds.hi)) {
      return `Strike must be between ${fmtPrice(bounds.lo)} and ${fmtPrice(bounds.hi)} (${config.minStrikeBps / 100}% to ${config.maxStrikeBps / 100}% of spot ${fmtPrice(spot)}).`;
    }
    return undefined;
  }, [strikeMode, customStrike, strikeParsed, bounds, spot, config]);
  const strike8 = strikeError ? undefined : strikeParsed;

  // ---- expiry: presets are computed from now + minTenor and never land in the dark window ----
  const [expiryMode, setExpiryMode] = useState<ExpiryMode>("monday");
  const [customExpiry, setCustomExpiry] = useState("");
  const [presetTs, setPresetTs] = useState<number | undefined>(undefined);
  // The open series whose strike and expiry were copied in (expiryMode === "series").
  const [joined, setJoined] = useState<SeriesInfo | undefined>(undefined);
  const computePreset = useCallback(
    (m: ExpiryPreset) => presetExpiry(m, Math.floor(Date.now() / 1000), config.minTenor, config.maxTenor),
    [config.minTenor, config.maxTenor],
  );
  // Recompute once the clock (or a config change) makes the current preset invalid: too close to now,
  // beyond maxTenor or inside the dark window. Also fills the first value after mount.
  useEffect(() => {
    if (!now || expiryMode === "custom" || expiryMode === "series") return;
    const invalid =
      presetTs === undefined ||
      presetTs < now + config.minTenor + 60 ||
      presetTs > now + config.maxTenor ||
      isDarkAt(presetTs);
    if (!invalid) return;
    const next = computePreset(expiryMode);
    if (next !== presetTs) setPresetTs(next);
  }, [now, expiryMode, presetTs, config.minTenor, config.maxTenor, computePreset]);

  const expiry = expiryMode === "custom" ? fromDatetimeLocal(customExpiry) : expiryMode === "series" ? joined?.expiry : presetTs;

  const choosePreset = (m: ExpiryPreset | "custom") => {
    if (m === "custom") {
      if (!customExpiry) {
        const t = Math.floor(Date.now() / 1000);
        setCustomExpiry(toDatetimeLocal(expiry ?? computePreset("7d") ?? nextLiveAt(t + 3 * 86400)));
      }
    } else {
      // Every click recomputes from the current time.
      setPresetTs(computePreset(m));
    }
    setExpiryMode(m);
  };

  // Copy an open series' exact strike and expiry so the buy joins it rather than opening a new one.
  const joinSeries = (s: SeriesInfo) => {
    setJoined(s);
    setExpiryMode("series");
    setStrikeMode("custom");
    setCustomStrike(formatUnits(s.strike, PRICE_DECIMALS));
  };

  // A joined series belongs to one underlying: switching underlying drops it and returns to the defaults.
  const selectUnderlying = (k: UnderlyingKey) => {
    setKey(k);
    if (expiryMode === "series") {
      setJoined(undefined);
      setStrikeMode(90);
      setCustomStrike("");
      choosePreset("monday");
    }
  };

  // Open series of this underlying that can still be bought (expiry at least minTenor away).
  const active = useActiveSeries(u.id);
  const joinable = useMemo(() => {
    const t = now || Math.floor(Date.now() / 1000);
    return (active.series ?? []).filter((s) => s.expiry >= t + config.minTenor + 60);
  }, [active.series, now, config.minTenor]);
  const atSeriesCap = active.series !== undefined && active.series.length >= config.maxActiveSeries;

  const customExpiryError =
    expiryMode === "custom" && expiry !== undefined && isDarkAt(expiry)
      ? `That time is between Friday 20:00 UTC and Monday 01:00 UTC, when the feeds are dark. A series expiring then would be priced with no closed-market time but settle on the Monday reopen print. Pick a time before Friday 20:00 UTC or from ${fmtUtc(nextLiveAt(expiry))} on.`
      : undefined;

  // ---- units (1e18 = protection on one Stock Token) ----
  // 10 tokens by default: a new series needs a minimum premium (SeriesTooSmall otherwise), and a
  // single token's short-dated protection is usually below it.
  const [units, setUnits] = useState("10");
  const units18 = parseDecimal(units, UNIT_DECIMALS);

  // ---- validation ----
  const validation = useMemo(() => {
    const t = now || Math.floor(Date.now() / 1000);
    if (feed.enabled && feed.data?.paused) return "The feed or Stock Token is paused (corporate action), so quotes are unavailable.";
    if (feed.enabled && feed.data?.invalid) return "The feed's latest answer is invalid, so the market will not quote until a valid print arrives.";
    if (strikeError) return strikeError;
    if (strikeMode === "custom" && !customStrike.trim()) return "Enter a strike price.";
    if (!units18 || units18 === 0n) return "Enter how many tokens to protect.";
    if (expiry === undefined) {
      if (expiryMode === "custom") return "Pick an expiry.";
      // Presets are filled on the first clock tick after mount.
      return now ? "No preset expiry fits the tenor limits right now. Pick a custom expiry." : undefined;
    }
    if (customExpiryError) return customExpiryError;
    if (isDarkAt(expiry)) return "That expiry is while the feeds are dark (Friday 20:00 UTC to Monday 01:00 UTC).";
    if (expiry < t + config.minTenor) return `Expiry must be at least ${fmtDuration(config.minTenor)} from now.`;
    if (expiry > t + config.maxTenor) return `Expiry must be within ${fmtDuration(config.maxTenor)} from now.`;
    return undefined;
  }, [now, feed.enabled, feed.data?.paused, feed.data?.invalid, strikeError, strikeMode, customStrike, units18, expiry, expiryMode, customExpiryError, config]);

  const live = useMemo<QuoteInputs>(
    () => ({ underlyingId: u.id, strike8, expiry, units18, validation }),
    [u.id, strike8, expiry, units18, validation],
  );
  const debounced = useDebounced<QuoteInputs>(live, 400);

  const tenor = expiry ? Math.max(0, expiry - (now || Math.floor(Date.now() / 1000))) : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Protect your Stock Tokens through the weekend</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Stock Tokens trade 24/7, but their price feeds go dark from Friday 20:00 to Sunday 20:00 ET. Buy
            cash-settled downside protection priced onchain: it pays max(strike − settle, 0) per token, where settle
            is the first valid feed print at or after expiry.
          </p>
        </div>
      </div>

      <UnderlyingSelector value={key} onChange={selectUnderlying} disabled={inFlight} />

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

          <fieldset disabled={inFlight} className="min-w-0 space-y-5 disabled:opacity-70">
            {/* Strike */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="label">Strike</span>
                <span className="num text-xs text-muted">{strike8 ? fmtPrice(strike8) : "—"}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="seg">
                  {([95, 90, 85] as const).map((p) => (
                    <button
                      key={p}
                      data-active={strikeMode === p}
                      onClick={() => setStrikeMode(p)}
                      title={spot ? fmtPrice(presetStrike(spot, p, config)) : undefined}
                    >
                      {p}%
                    </button>
                  ))}
                  <button
                    data-active={strikeMode === "custom"}
                    onClick={() => {
                      setStrikeMode("custom");
                      if (!customStrike && spot) {
                        const s = presetStrike(spot, 90, config);
                        if (s) setCustomStrike(formatUnits(s, PRICE_DECIMALS));
                      }
                    }}
                  >
                    Custom
                  </button>
                </div>
                {strikeMode === "custom" && (
                  <div className="relative flex-1 min-w-[160px]">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">$</span>
                    <input
                      className="input num pl-7"
                      inputMode="numeric"
                      value={customStrike}
                      onChange={(e) => setCustomStrike(e.target.value)}
                      placeholder="Strike price"
                      aria-invalid={!!strikeError}
                    />
                  </div>
                )}
              </div>
              {strikeError ? (
                <p className="mt-1.5 text-[11px] text-neg">{strikeError}</p>
              ) : (
                <p className="mt-1.5 text-[11px] text-dim">
                  Percent of spot, rounded to a whole dollar ({fmtPrice(config.strikeTick)} tick)
                  {bounds ? `; valid ${fmtPrice(bounds.lo)} to ${fmtPrice(bounds.hi)}` : ""}. Pays (strike − settle price)
                  per token if the first print after expiry is below the strike.
                </p>
              )}
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
                    <button key={p.id} data-active={expiryMode === p.id} onClick={() => choosePreset(p.id)} title={p.hint || undefined}>
                      {p.label}
                    </button>
                  ))}
                </div>
                {expiryMode === "custom" && (
                  <input
                    type="datetime-local"
                    className="input num flex-1 min-w-[200px]"
                    value={customExpiry}
                    onChange={(e) => setCustomExpiry(e.target.value)}
                    aria-invalid={!!customExpiryError}
                  />
                )}
              </div>
              {customExpiryError ? (
                <p className="mt-1.5 text-[11px] text-neg">{customExpiryError}</p>
              ) : expiryMode === "series" && joined ? (
                <p className="mt-1.5 text-[11px] text-dim">
                  Joining the open {fmtPrice(joined.strike)} series expiring {fmtTime(joined.expiry)}. Changing the strike or
                  expiry opens a new series instead.
                </p>
              ) : (
                <p className="mt-1.5 text-[11px] text-dim">
                  No expiry is offered while the feeds are dark (Friday 20:00 UTC to Monday 01:00 UTC): the feeds stop
                  printing at the Friday close, so a series expiring then would settle on the Monday reopen print.
                  Presets land on weekday 19:00 UTC so buyers share series.
                </p>
              )}
            </div>

            {/* Open series: join one instead of opening a new (underlying, strike, expiry) series */}
            {active.series !== undefined && active.series.length > 0 && (
              <div>
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="label">Open series · join one</span>
                  <span className="num text-xs text-muted">
                    {active.series.length} of {config.maxActiveSeries}
                    {joinable.length < active.series.length ? ` · ${joinable.length} joinable` : ""}
                  </span>
                </div>
                {joinable.length === 0 ? (
                  <p className="text-[11px] text-dim">
                    Every open {u.symbol} series has expired or is within the minimum tenor, so none can be joined right now.
                  </p>
                ) : (
                  <div className="max-h-44 overflow-y-auto rounded-lg border border-line">
                    {joinable.map((s) => {
                      const selected = strike8 === s.strike && expiry === s.expiry;
                      return (
                        <button
                          key={s.id.toString()}
                          type="button"
                          data-active={selected}
                          onClick={() => joinSeries(s)}
                          title={`Series id ${s.id.toString()}`}
                          className="flex w-full items-center justify-between gap-3 border-b border-line px-3 py-1.5 text-left text-xs last:border-b-0 hover:bg-panel-2 data-[active=true]:bg-accent/10 data-[active=true]:text-fg"
                        >
                          <span className="num">{fmtPrice(s.strike)} put</span>
                          <span className="text-muted">{fmtTime(s.expiry)}</span>
                          <span className="num text-dim">{fmtUnits(s.openUnits, 2)} open</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <p className="mt-1.5 text-[11px] text-dim">
                  {atSeriesCap
                    ? `${u.symbol} is at the ${config.maxActiveSeries}-series cap: only these strike and expiry pairs can be bought until a series settles.`
                    : `Series are keyed by (underlying, strike, expiry); ${u.symbol} can have at most ${config.maxActiveSeries} open at once. Joining one keeps that slot free.`}
                </p>
              </div>
            )}

            {/* Units */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="label">Tokens to protect</span>
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
                One unit protects one {u.symbol} Stock Token.{" "}
                {isZero(u.stockToken)
                  ? "Protection is cash-settled; you do not need to hold the Stock Token to buy it."
                  : address
                    ? `Your ${u.symbol} Stock Token balance is shown above. Protection is cash-settled, so any amount works.`
                    : "Connect a wallet to see your Stock Token balance."}
              </p>
            </div>
          </fieldset>
        </Card>

        <QuoteCard
          underlying={u}
          inputs={debounced}
          live={live}
          underlyingEnabled={info?.enabled}
          lookback={info?.params.lookback}
          inFlight={inFlight}
          onInFlightChange={setInFlight}
        />
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
            <li className="flex gap-2"><span className="text-warn">▮</span><span>Shaded bands are closed-market windows: the feed holds Friday&apos;s close for about 48 hours while the token keeps trading. Sales pause from Saturday 00:00 to Monday 01:00 UTC.</span></li>
            <li className="flex gap-2"><span className="text-accent">╌</span><span>The dashed line is your strike. If the first print after expiry lands below it, you are paid the difference per token.</span></li>
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
