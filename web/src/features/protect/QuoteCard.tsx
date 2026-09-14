"use client";

import { useMemo } from "react";
import { useAccount, useReadContract } from "wagmi";
import { erc20Abi, marketAbi } from "@/abi";
import { deployment, isDeployed, type UnderlyingDeployment } from "@/lib/deployment";
import { describeError } from "@/lib/errors";
import { fmtPct, fmtPrice, fmtTime, fmtUnits, fmtUsd, fmtVol, hoursOf, priceToNumber, unitsToNumber, usdToNumber } from "@/lib/format";
import { useAllowance, useTusdBalance } from "@/lib/hooks/useToken";
import { useTx } from "@/lib/hooks/useTx";
import { useNow } from "@/lib/hooks/useNow";
import { ErrorNote, InfoNote, Row, Skeleton } from "@/components/ui";
import { FaucetButton } from "@/components/FaucetButton";

export type QuoteInputs = {
  strike8: bigint | undefined;
  expiry: number | undefined;
  units18: bigint | undefined;
  validation?: string;
};

export function QuoteCard({
  underlying,
  inputs,
  lookback,
  onBought,
}: {
  underlying: UnderlyingDeployment;
  inputs: QuoteInputs;
  lookback?: number;
  onBought?: () => void;
}) {
  const { address, isConnected } = useAccount();
  const now = useNow(1000);
  const { send, busy } = useTx();

  const ready = isDeployed && !!inputs.strike8 && !!inputs.expiry && !!inputs.units18 && inputs.units18 > 0n && !inputs.validation;

  const q = useReadContract({
    address: deployment.market,
    abi: marketAbi,
    functionName: "quote",
    args: [underlying.id, inputs.strike8 ?? 0n, BigInt(inputs.expiry ?? 0), inputs.units18 ?? 0n],
    query: { enabled: ready, refetchInterval: 15_000, retry: false, staleTime: 5_000 },
  });

  const { data: allowance } = useAllowance(deployment.usd, address, deployment.market);
  const { data: tusd } = useTusdBalance(address);

  const d = useMemo(() => {
    if (!q.data || !inputs.units18 || !inputs.strike8 || !inputs.expiry) return undefined;
    const [premium, collateral, spot, vol, closedSeconds] = q.data;
    const units = unitsToNumber(inputs.units18);
    const notional = priceToNumber(spot) * units;
    const premiumUsd = usdToNumber(premium);
    const premiumPerShare = units > 0 ? premiumUsd / units : 0;
    const strikeN = priceToNumber(inputs.strike8);
    const tenor = Math.max(0, inputs.expiry - (now || Math.floor(Date.now() / 1000)));
    const maxPremium = (premium * 102n) / 100n;
    return {
      premium,
      collateral,
      spot,
      vol,
      closedSeconds: Number(closedSeconds),
      tenor,
      notional,
      premiumPct: notional > 0 ? premiumUsd / notional : 0,
      premiumPerShare,
      breakeven: strikeN - premiumPerShare,
      strikePctOfSpot: spot > 0n ? strikeN / priceToNumber(spot) : 0,
      maxPremium,
      needsApproval: allowance === undefined ? true : allowance < maxPremium,
      insufficient: tusd !== undefined && tusd < premium,
    };
  }, [q.data, inputs, now, allowance, tusd]);

  const buy = async () => {
    if (!d || !address || !inputs.strike8 || !inputs.expiry || !inputs.units18) return;
    if (d.needsApproval) {
      const ok = await send("Approve tUSD", {
        address: deployment.usd,
        abi: erc20Abi,
        functionName: "approve",
        args: [deployment.market, d.maxPremium],
      });
      if (!ok) return;
    }
    const receipt = await send(`Buy ${underlying.symbol} protection`, {
      address: deployment.market,
      abi: marketAbi,
      functionName: "buyProtection",
      args: [underlying.id, inputs.strike8, BigInt(inputs.expiry), inputs.units18, d.maxPremium],
    });
    if (receipt) onBought?.();
  };

  const errorText = q.error ? describeError(q.error) : undefined;

  return (
    <div className="card flex h-full flex-col p-4 sm:p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Live quote</h2>
        {q.isFetching && ready && <span className="text-[11px] text-dim">refreshing…</span>}
      </div>

      {!isDeployed ? (
        <InfoNote className="mt-4">Quotes will appear once the market contract is deployed.</InfoNote>
      ) : inputs.validation ? (
        <InfoNote className="mt-4">{inputs.validation}</InfoNote>
      ) : !ready ? (
        <InfoNote className="mt-4">Enter a strike, expiry and number of shares to get a quote.</InfoNote>
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
                  {fmtPct(d.premiumPct)} of notional · {fmtUsd(BigInt(Math.round(d.premiumPerShare * 1e6)))} per share
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
            <Row k="Max payout" v={d ? fmtUsd(d.collateral) : <Skeleton />} />
            <Row
              k="Breakeven at expiry"
              v={d ? <>{fmtPrice(BigInt(Math.round(d.breakeven * 1e8)))}</> : <Skeleton />}
            />
            <Row k="Expiry" v={inputs.expiry ? fmtTime(inputs.expiry) : "—"} muted />
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-dim">
            Priced onchain by the Stylus engine{lookback ? ` from ${lookback} rounds of feed history` : ""}: Black-Scholes put
            with realized vol and a closed-market surcharge. Settles at the first feed print at or after expiry.
          </p>
        </>
      )}

      <div className="mt-auto pt-4">
        {!isConnected ? (
          <InfoNote>Connect a wallet (or use the demo wallet) to buy protection.</InfoNote>
        ) : (
          <>
            {d?.insufficient && (
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">
                <span>Your tUSD balance ({fmtUsd(tusd)}) is below the premium.</span>
                <FaucetButton className="btn btn-sm" />
              </div>
            )}
            <button
              className="btn btn-primary w-full py-2.5 text-[15px]"
              disabled={!ready || !d || busy || !!errorText || d.insufficient}
              onClick={buy}
            >
              {busy ? "Confirm in wallet…" : d?.needsApproval ? "Approve & buy protection" : "Buy protection"}
            </button>
            {d && inputs.units18 && (
              <p className="mt-2 text-center text-[11px] text-dim">
                Protects {fmtUnits(inputs.units18, 4)} {underlying.symbol} · max premium {fmtUsd(d.maxPremium)} (2% slippage)
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
