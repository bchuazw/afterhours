"use client";

import { useEffect, useMemo, useRef } from "react";
import { useAccount, useReadContract } from "wagmi";
import { encodeAbiParameters, keccak256 } from "viem";
import { erc20Abi, marketAbi } from "@/abi";
import { deployment, isDeployed, type UnderlyingDeployment } from "@/lib/deployment";
import { describeError } from "@/lib/errors";
import {
  fmtDuration,
  fmtPct,
  fmtPrice,
  fmtTime,
  fmtUnits,
  fmtUsd,
  fmtUtc,
  fmtVol,
  hoursOf,
  priceToNumber,
  unitsToNumber,
  usdToNumber,
} from "@/lib/format";
import { isClosedAt, nextOpenAt } from "@/lib/market-hours";
import { useAllowance, useTusdBalance } from "@/lib/hooks/useToken";
import { useMarketConfig } from "@/lib/hooks/useMarket";
import { useTx, WRONG_CHAIN_HINT } from "@/lib/hooks/useTx";
import { useVault, vaultCapacity } from "@/lib/hooks/useVault";
import { useNow } from "@/lib/hooks/useNow";
import { useToast } from "@/components/Toaster";
import { ErrorNote, InfoNote, Row, Skeleton } from "@/components/ui";
import { FaucetButton } from "@/components/FaucetButton";

export type QuoteInputs = {
  underlyingId: number;
  strike8: bigint | undefined;
  expiry: number | undefined;
  units18: bigint | undefined;
  validation?: string;
};

export function sameInputs(a: QuoteInputs, b: QuoteInputs): boolean {
  return (
    a.underlyingId === b.underlyingId &&
    a.strike8 === b.strike8 &&
    a.expiry === b.expiry &&
    a.units18 === b.units18 &&
    a.validation === b.validation
  );
}

/** Client-side AfterHoursMarket.seriesId: keccak256(abi.encode(uint32, uint256, uint64)). */
function seriesIdOf(underlyingId: number, strike: bigint, expiry: number): bigint {
  return BigInt(
    keccak256(
      encodeAbiParameters([{ type: "uint32" }, { type: "uint256" }, { type: "uint64" }], [underlyingId, strike, BigInt(expiry)]),
    ),
  );
}

export function QuoteCard({
  underlying,
  inputs,
  live,
  underlyingEnabled,
  lookback,
  inFlight,
  onInFlightChange,
  onBought,
}: {
  underlying: UnderlyingDeployment;
  /** Debounced inputs the quote is fetched for. */
  inputs: QuoteInputs;
  /** Current (undebounced) inputs; a buy only goes out while both agree. */
  live: QuoteInputs;
  /** Underlying.enabled from the market (undefined until loaded). */
  underlyingEnabled?: boolean;
  lookback?: number;
  inFlight: boolean;
  onInFlightChange: (v: boolean) => void;
  onBought?: () => void;
}) {
  const { address, isConnected } = useAccount();
  const now = useNow(1000);
  const { send, busy, wrongChain } = useTx();
  const toast = useToast();
  const { config } = useMarketConfig();
  const { stats: vault } = useVault(underlying, address);

  const settling = !sameInputs(inputs, live);

  // Market-level reasons the contract would refuse to even quote. `now` is 0 until mounted.
  const marketBlock = useMemo(() => {
    if (now > 0 && isClosedAt(now)) {
      const reopen = nextOpenAt(now);
      return `Sales pause while the feeds are dark, Saturday 00:00 to Monday 01:00 UTC. They reopen ${fmtUtc(reopen)} (in ${fmtDuration(reopen - now)}).`;
    }
    if (underlyingEnabled === false) {
      return `Sales for ${underlying.symbol} are disabled by the operator. Existing positions still settle and claim normally.`;
    }
    return undefined;
  }, [now, underlyingEnabled, underlying.symbol]);

  const ready =
    isDeployed && !marketBlock && !!inputs.strike8 && !!inputs.expiry && !!inputs.units18 && inputs.units18 > 0n && !inputs.validation;

  const q = useReadContract({
    address: deployment.market,
    abi: marketAbi,
    functionName: "quote",
    args: [inputs.underlyingId, inputs.strike8 ?? 0n, BigInt(inputs.expiry ?? 0), inputs.units18 ?? 0n],
    query: { enabled: ready, refetchInterval: 15_000, retry: false, staleTime: 5_000 },
  });

  const { data: allowance } = useAllowance(deployment.usd, address, deployment.market);
  const { data: tusd } = useTusdBalance(address);

  const d = useMemo(() => {
    if (!ready || !q.data || !inputs.units18 || !inputs.strike8 || !inputs.expiry) return undefined;
    const [premium, collateral, spot, vol, closedSeconds] = q.data;
    const units = unitsToNumber(inputs.units18);
    const notional = priceToNumber(spot) * units;
    const premiumUsd = usdToNumber(premium);
    const premiumPerToken = units > 0 ? premiumUsd / units : 0;
    const strikeN = priceToNumber(inputs.strike8);
    const tenor = Math.max(0, inputs.expiry - (now || Math.floor(Date.now() / 1000)));
    const maxPremium = (premium * 102n + 99n) / 100n;
    const cap = vaultCapacity(vault, collateral);
    const sid = seriesIdOf(inputs.underlyingId, inputs.strike8, inputs.expiry);
    const isNewSeries = vault ? !vault.activeIds.includes(sid) : false;
    return {
      premium,
      collateral,
      spot,
      vol,
      closedSeconds: Number(closedSeconds),
      tenor,
      notional,
      premiumPct: notional > 0 ? premiumUsd / notional : 0,
      premiumPerToken,
      breakeven: strikeN - premiumPerToken,
      strikePctOfSpot: spot > 0n ? strikeN / priceToNumber(spot) : 0,
      maxPremium,
      needsApproval: allowance === undefined ? true : allowance < maxPremium,
      insufficient: tusd !== undefined && tusd < premium,
      cap,
      // Most tokens the vault could back at this strike: headroom * 1e20 / strike (8-dec price, 6-dec asset).
      maxUnits: cap && inputs.strike8 > 0n ? (cap.headroom * 10n ** 20n) / inputs.strike8 : undefined,
      tooManySeries: isNewSeries && vault !== undefined && vault.activeIds.length >= config.maxActiveSeries,
    };
  }, [ready, q.data, inputs, now, allowance, tusd, vault, config.maxActiveSeries]);

  // Reasons the Buy button is disabled even though a quote is shown.
  const buyBlock = useMemo(() => {
    if (!d) return undefined;
    if (config.paused) return "The market is paused by the operator, so new protection cannot be bought. Settlement and claims still work.";
    if (d.premium === 0n) return "This quote has a zero premium. Protect more tokens to get a sellable quote.";
    if (d.cap && !d.cap.ok) {
      return `The ${underlying.symbol} vault cannot back this: it needs ${fmtUsd(d.collateral)} of collateral but can lock at most ${fmtUsd(d.cap.headroom)} right now (free liquidity and the 90% utilization cap). ${
        d.maxUnits !== undefined && d.maxUnits > 0n ? `Protect at most ${fmtUnits(d.maxUnits, 4)} tokens, or add` : "Add"
      } capital on Earn.`;
    }
    if (d.tooManySeries) {
      return `${underlying.symbol} already has ${config.maxActiveSeries} open series and this strike and expiry would open a new one. Pick a strike and expiry that already trade, or wait for a series to settle.`;
    }
    if (wrongChain) return WRONG_CHAIN_HINT;
    return undefined;
  }, [d, config.paused, config.maxActiveSeries, underlying.symbol, wrongChain]);

  // Latest inputs, read after the approval confirms to make sure the buy still matches the snapshot.
  const liveRef = useRef(live);
  const inputsRef = useRef(inputs);
  useEffect(() => {
    liveRef.current = live;
    inputsRef.current = inputs;
  }, [live, inputs]);

  const buy = async () => {
    if (!d || !address || buyBlock || settling || inFlight) return;
    const snap = inputs;
    if (!snap.strike8 || !snap.expiry || !snap.units18) return;
    const args = [snap.underlyingId, snap.strike8, BigInt(snap.expiry), snap.units18, d.maxPremium] as const;
    const label = `Buy ${underlying.symbol} protection`;
    onInFlightChange(true);
    try {
      if (d.needsApproval) {
        const ok = await send("Approve tUSD", {
          address: deployment.usd,
          abi: erc20Abi,
          functionName: "approve",
          args: [deployment.market, d.maxPremium],
        });
        if (!ok) return;
        if (!sameInputs(liveRef.current, snap) || !sameInputs(inputsRef.current, snap)) {
          toast.push({
            kind: "info",
            title: "Buy not sent",
            description: "Your inputs changed while the approval was confirming. Review the new quote and buy again.",
          });
          return;
        }
      }
      const receipt = await send(label, {
        address: deployment.market,
        abi: marketAbi,
        functionName: "buyProtection",
        args,
      });
      if (receipt) onBought?.();
    } finally {
      onInFlightChange(false);
    }
  };

  const errorText = q.error ? describeError(q.error) : undefined;

  return (
    <div className="card flex h-full flex-col p-4 sm:p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Live quote</h2>
        {(settling || (q.isFetching && ready)) && <span className="text-[11px] text-dim">refreshing…</span>}
      </div>

      {!isDeployed ? (
        <InfoNote className="mt-4">Quotes will appear once the market contract is deployed.</InfoNote>
      ) : marketBlock ? (
        <InfoNote className="mt-4">{marketBlock}</InfoNote>
      ) : inputs.validation ? (
        <InfoNote className="mt-4">{inputs.validation}</InfoNote>
      ) : !ready ? (
        <InfoNote className="mt-4">Enter a strike, expiry and number of tokens to get a quote.</InfoNote>
      ) : errorText ? (
        <ErrorNote className="mt-4">{errorText}</ErrorNote>
      ) : (
        <>
          <div className="mt-4">
            <div className="label">Premium</div>
            <div className="num mt-1 text-3xl leading-none">
              {d ? fmtUsd(d.premium) : <Skeleton className="h-8 w-32" />}
            </div>
            <div className="mt-1.5 text-xs text-muted">
              {d ? (
                <>
                  {fmtPct(d.premiumPct)} of notional · {fmtUsd(BigInt(Math.round(d.premiumPerToken * 1e6)))} per token
                </>
              ) : (
                <Skeleton className="h-3 w-40" />
              )}
            </div>
          </div>

          <div className="mt-4 divide-y divide-line border-y border-line">
            <Row k="Spot used" v={d ? fmtPrice(d.spot) : <Skeleton />} />
            <Row
              k="Strike"
              v={
                d && inputs.strike8 ? (
                  <>
                    {fmtPrice(inputs.strike8)} <span className="text-dim">({fmtPct(d.strikePctOfSpot, 0)} of spot)</span>
                  </>
                ) : (
                  <Skeleton />
                )
              }
            />
            <Row k="Effective vol" v={d ? fmtVol(d.vol) : <Skeleton />} />
            <Row
              k="Closed-market time"
              v={
                d ? (
                  <span className={d.closedSeconds > 0 ? "text-warn" : ""}>
                    {hoursOf(d.closedSeconds)} of the {hoursOf(d.tenor)} tenor
                  </span>
                ) : (
                  <Skeleton />
                )
              }
            />
            <Row k="Collateral locked" v={d ? fmtUsd(d.collateral) : <Skeleton />} />
            <Row
              k="Vault can back"
              v={d?.cap ? <span className={d.cap.ok ? "" : "text-neg"}>{fmtUsd(d.cap.headroom)}</span> : <Skeleton />}
            />
            <Row k="Max payout" v={d ? fmtUsd(d.collateral) : <Skeleton />} />
            <Row
              k="Breakeven at expiry"
              v={d ? <>{fmtPrice(BigInt(Math.round(d.breakeven * 1e8)))}</> : <Skeleton />}
            />
            <Row k="Expiry" v={inputs.expiry ? fmtTime(inputs.expiry) : "—"} muted />
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-dim">
            Pays max(strike − settle, 0) per token, where settle is the first valid feed print at or after expiry.
            Priced onchain by the Stylus engine{lookback ? ` from ${lookback} rounds of feed history` : ""}: a
            Black-Scholes put with realized vol and a closed-market surcharge, floored at intrinsic + 5 bps of spot.
          </p>
        </>
      )}

      <div className="mt-auto pt-4">
        {!isConnected ? (
          <InfoNote>Connect a wallet (or use the demo wallet) to buy protection.</InfoNote>
        ) : (
          <>
            {buyBlock && <div className="mb-2 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs leading-relaxed text-warn">{buyBlock}</div>}
            {d?.insufficient && !buyBlock && (
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">
                <span>Your tUSD balance ({fmtUsd(tusd)}) is below the premium.</span>
                <FaucetButton className="btn btn-sm" />
              </div>
            )}
            <button
              className="btn btn-primary w-full py-2.5 text-[15px]"
              disabled={!ready || !d || busy || inFlight || settling || !!errorText || !!buyBlock || d.insufficient}
              onClick={buy}
            >
              {busy || inFlight
                ? "Confirm in wallet…"
                : settling
                  ? "Updating quote…"
                  : d?.needsApproval
                    ? "Approve & buy protection"
                    : "Buy protection"}
            </button>
            {d && inputs.units18 && (
              <p className="mt-2 text-center text-[11px] text-dim">
                Protects {fmtUnits(inputs.units18, 4)} {underlying.symbol} tokens · max premium {fmtUsd(d.maxPremium)} (2% slippage)
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
