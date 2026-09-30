"use client";

import { useState } from "react";
import { useAccount, useReadContracts } from "wagmi";
import { formatUnits } from "viem";
import { erc20Abi, vaultAbi } from "@/abi";
import { COMPANY, deployment, isDeployed, isZero, type UnderlyingDeployment } from "@/lib/deployment";
import { fmtBps, fmtDuration, fmtPrice, fmtTime, fmtUnits, fmtUsd, parseDecimal, USD_DECIMALS, usdToNumber } from "@/lib/format";
import { useAllowance, useTusdBalance } from "@/lib/hooks/useToken";
import { useVaultFlows } from "@/lib/hooks/useLogs";
import { useTx, WRONG_CHAIN_HINT } from "@/lib/hooks/useTx";
import { useSettle } from "@/lib/hooks/useSettle";
import { type SeriesInfo } from "@/lib/hooks/useSeries";
import { useVault, type VaultStats } from "@/lib/hooks/useVault";
import { useMounted, useNow } from "@/lib/hooks/useNow";
import { AddressLink, ErrorNote, InfoNote, Pill, Stat } from "@/components/ui";
import { FaucetButton } from "@/components/FaucetButton";

export function VaultCard({ u }: { u: UnderlyingDeployment }) {
  const mounted = useMounted();
  const { address: connected, isConnected } = useAccount();
  const address = mounted ? connected : undefined;
  const vault = { address: u.vault, abi: vaultAbi } as const;
  const { stats: base, expired, closedReasons, enabled, isLoading: loading, error } = useVault(u, address);

  const oneShare = 10n ** BigInt(base?.decimals ?? 12);
  const conv = useReadContracts({
    contracts: [
      { ...vault, functionName: "convertToAssets", args: [base?.shares ?? 0n] },
      { ...vault, functionName: "convertToAssets", args: [oneShare] },
    ],
    allowFailure: true,
    query: { enabled: enabled && !!base, refetchInterval: 15_000 },
  });
  const yourAssets = address && conv.data?.[0].status === "success" ? conv.data[0].result : undefined;
  const sharePrice = conv.data?.[1].status === "success" ? conv.data[1].result : undefined;

  const { data: flows } = useVaultFlows(u.vault, address);
  const earned = yourAssets !== undefined && flows ? yourAssets - (flows.deposited - flows.withdrawn) : undefined;

  const open = base?.open;
  const openSeries = base?.activeIds.length;

  return (
    <div className="card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-lg font-semibold">{u.symbol} vault</span>
            <span className="text-xs text-muted">{COMPANY[u.key]} protection writers</span>
            {open === true && <Pill tone="live">Open</Pill>}
            {open === false && <Pill tone="closed">Closed to entries and exits</Pill>}
          </div>
          <div className="mt-0.5 text-[11px] text-dim">
            ERC-4626 · {isZero(u.vault) ? "not deployed" : <AddressLink address={u.vault} chars={6} />}
            {openSeries !== undefined && <> · {openSeries} open series</>}
          </div>
        </div>
        <UtilizationRing bps={base?.utilBps} loading={loading} />
      </div>

      {error && <ErrorNote className="mt-3">Vault read failed: {error.message.split("\n")[0]}</ErrorNote>}

      {open === false && (
        <div className="mt-3 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs leading-relaxed text-warn">
          <div className="font-medium">Deposits and withdrawals are paused.</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {closedReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {expired.length > 0 && <ExpiredSeries u={u} series={expired} />}

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
        <Stat
          label="Writer equity (TVL)"
          value={fmtUsd(base?.totalAssets, { compact: true })}
          sub="capital − MTM liability"
          loading={loading}
        />
        <Stat label="Locked collateral" value={fmtUsd(base?.locked, { compact: true })} loading={loading} />
        <Stat
          label="Exit liquidity"
          value={fmtUsd(base?.exit, { compact: true })}
          sub={base?.free !== undefined ? `free ${fmtUsd(base.free, { compact: true })}` : undefined}
          loading={loading}
        />
        <Stat
          label="Share price"
          value={sharePrice !== undefined ? `$${usdToNumber(sharePrice).toFixed(4)}` : "—"}
          sub={sharePrice !== undefined ? `${(usdToNumber(sharePrice) - 1 >= 0 ? "+" : "")}${((usdToNumber(sharePrice) - 1) * 100).toFixed(3)}% since 1.0000` : undefined}
          loading={loading}
          tone={sharePrice !== undefined && sharePrice > 1_000_000n ? "pos" : sharePrice !== undefined && sharePrice < 1_000_000n ? "neg" : undefined}
        />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
        <Stat label="Capital" value={fmtUsd(base?.capital, { compact: true })} sub="balance − unearned premium" loading={loading} />
        <Stat
          label="Unearned premium"
          value={fmtUsd(base?.unearned, { compact: true })}
          sub="earned when its series settles"
          loading={loading}
        />
        <Stat
          label="Mark-to-market liability"
          value={fmtUsd(base?.liability, { compact: true })}
          sub="intrinsic of open puts beyond their premium"
          tone={base?.liability !== undefined && base.liability > 0n ? "warn" : undefined}
          loading={loading}
        />
        <Stat
          label="Utilization"
          value={base?.utilBps !== undefined ? fmtBps(base.utilBps, 1) : "—"}
          sub="locked / capital · cap 90%"
          loading={loading}
        />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 rounded-lg border border-line bg-bg p-3 sm:grid-cols-4">
        <Stat label="Your vault shares" value={base?.shares !== undefined ? fmtShares(base.shares, base.decimals) : "—"} loading={loading && isConnected} />
        <Stat label="Your assets" value={fmtUsd(yourAssets)} loading={isConnected && enabled && conv.isLoading} />
        <Stat
          label="Earned premiums"
          value={earned !== undefined ? `${earned >= 0n ? "+" : "−"}${fmtUsd(earned < 0n ? -earned : earned)}` : "—"}
          sub={flows ? `net deposits ${fmtUsd(flows.deposited - flows.withdrawn)}` : undefined}
          tone={earned !== undefined ? (earned > 0n ? "pos" : earned < 0n ? "neg" : undefined) : undefined}
        />
        <Stat label="Withdrawable now" value={fmtUsd(base?.maxWithdraw)} loading={loading && isConnected} />
      </div>

      {!isConnected ? (
        <InfoNote className="mt-4">Connect a wallet to deposit tUSD and earn premiums.</InfoNote>
      ) : (
        <Forms u={u} stats={base} closedReasons={closedReasons} />
      )}
    </div>
  );
}

/**
 * Expired series still on the active list. Anyone can settle them (no position needed), which is
 * what unfreezes the vault; the keeper does the same on its own schedule.
 */
function ExpiredSeries({ u, series }: { u: UnderlyingDeployment; series: SeriesInfo[] }) {
  const mounted = useMounted();
  const { isConnected } = useAccount();
  const now = useNow(1000);
  const { settle, notes, busy, wrongChain } = useSettle();
  const t = now || Math.floor(Date.now() / 1000);
  const canSend = mounted && isConnected && !wrongChain;
  return (
    <div className="mt-3 rounded-lg border border-line bg-bg p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="label">Expired series awaiting settlement</span>
        <span className="text-[11px] text-dim">
          {mounted && !isConnected ? "Connect any wallet to settle" : "Settling takes one transaction and needs no position"}
        </span>
      </div>
      <ul className="mt-2 divide-y divide-line">
        {series.map((s) => {
          const key = s.id.toString();
          return (
            <li key={key} className="py-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <div className="min-w-0">
                  <span className="num">{fmtPrice(s.strike)} put</span>
                  <span className="text-muted"> · expired {fmtTime(s.expiry)}</span>
                  <span className="text-dim"> · {fmtDuration(t - s.expiry)} ago · {fmtUnits(s.openUnits, 2)} open</span>
                </div>
                <button className="btn btn-primary btn-sm" disabled={!canSend || busy} onClick={() => settle(s.id, u.symbol)}>
                  Settle
                </button>
              </div>
              {notes[key] && (
                <div className="mt-2 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs leading-relaxed text-warn">{notes[key]}</div>
              )}
            </li>
          );
        })}
      </ul>
      {mounted && wrongChain && <div className="mt-2 text-xs text-warn">{WRONG_CHAIN_HINT}</div>}
    </div>
  );
}

function fmtShares(v: bigint, decimals: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(Number(formatUnits(v, decimals)));
}

function UtilizationRing({ bps, loading }: { bps?: bigint; loading: boolean }) {
  const pct = bps !== undefined ? Math.min(100, Number(bps) / 100) : 0;
  const r = 20;
  const c = 2 * Math.PI * r;
  const color = pct >= 80 ? "#fb7185" : pct >= 50 ? "#fbbf24" : "#34d399";
  return (
    <div className="flex items-center gap-2" title="Utilization = locked collateral / capital. Sales and exits keep it at or below 90%.">
      <svg width="52" height="52" viewBox="0 0 52 52" aria-hidden>
        <circle cx="26" cy="26" r={r} stroke="#222634" strokeWidth="5" fill="none" />
        <circle cx="26" cy="26" r={r} stroke={color} strokeWidth="5" fill="none" strokeLinecap="round" strokeDasharray={`${(c * pct) / 100} ${c}`} transform="rotate(-90 26 26)" />
        <text x="26" y="30" textAnchor="middle" fontSize="11" fill="#e8eaf0" fontFamily="var(--font-mono)">
          {loading ? "…" : bps !== undefined ? `${Math.round(pct)}%` : "—"}
        </text>
      </svg>
      <div className="text-[11px] leading-tight text-dim">
        <div>utilization</div>
        <div>{bps !== undefined ? fmtBps(bps, 1) : "—"} · cap 90%</div>
      </div>
    </div>
  );
}

function Forms({ u, stats, closedReasons }: { u: UnderlyingDeployment; stats?: VaultStats; closedReasons: string[] }) {
  const { address } = useAccount();
  const { send, busy, wrongChain } = useTx();
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  // Set when MAX was clicked in withdraw mode: redeem the exact share amount so no dust is left behind.
  const [redeemAll, setRedeemAll] = useState(false);
  const amt = parseDecimal(amount, USD_DECIMALS);
  const { data: tusd } = useTusdBalance(address);
  const { data: allowance } = useAllowance(deployment.usd, address, u.vault);

  const maxDeposit = stats?.maxDeposit;
  const maxWithdraw = stats?.maxWithdraw;
  const maxRedeem = stats?.maxRedeem;

  // Why the current mode is unavailable (the vault reports max 0), if it is.
  const blocked = (() => {
    if (!stats) return undefined;
    if (mode === "deposit") {
      if (maxDeposit === 0n) {
        return stats.open === false ? "Deposits are paused while the vault is closed (see above)." : "The vault is not accepting deposits right now.";
      }
      return undefined;
    }
    if (maxWithdraw === 0n) {
      if (stats.open === false) return `Withdrawals are paused while the vault is closed. ${closedReasons[0] ?? ""}`.trim();
      if (!stats.shares) return "You have no shares in this vault.";
      if (stats.exit === 0n) {
        return "Utilization is at the 90% cap: every free dollar backs open protection. Withdrawals reopen as series settle or writers deposit.";
      }
      return "Nothing is withdrawable right now.";
    }
    return undefined;
  })();

  const tooMuchDeposit =
    mode === "deposit" && amt !== undefined && ((tusd !== undefined && amt > tusd) || (maxDeposit !== undefined && amt > maxDeposit));
  const tooMuchWithdraw = mode === "withdraw" && amt !== undefined && maxWithdraw !== undefined && amt > maxWithdraw;
  const valid = !!amt && amt > 0n && !tooMuchDeposit && !tooMuchWithdraw && !blocked;

  const submit = async () => {
    if (!address || !amt || blocked) return;
    if (mode === "deposit") {
      if (allowance === undefined || allowance < amt) {
        const ok = await send("Approve tUSD", { address: deployment.usd, abi: erc20Abi, functionName: "approve", args: [u.vault, amt] });
        if (!ok) return;
      }
      const ok = await send(`Deposit into ${u.symbol} vault`, { address: u.vault, abi: vaultAbi, functionName: "deposit", args: [amt, address] });
      if (ok) setAmount("");
    } else {
      const ok =
        redeemAll && maxRedeem !== undefined && maxRedeem > 0n
          ? await send(`Withdraw from ${u.symbol} vault`, { address: u.vault, abi: vaultAbi, functionName: "redeem", args: [maxRedeem, address, address] })
          : await send(`Withdraw from ${u.symbol} vault`, { address: u.vault, abi: vaultAbi, functionName: "withdraw", args: [amt, address, address] });
      if (ok) {
        setAmount("");
        setRedeemAll(false);
      }
    }
  };

  const maxFor = mode === "deposit" ? (tusd !== undefined && maxDeposit !== undefined && maxDeposit < tusd ? maxDeposit : tusd) : maxWithdraw;

  return (
    <div className="mt-4 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="seg">
          <button data-active={mode === "deposit"} onClick={() => { setMode("deposit"); setRedeemAll(false); }}>Deposit</button>
          <button data-active={mode === "withdraw"} onClick={() => { setMode("withdraw"); setRedeemAll(false); }}>Withdraw</button>
        </div>
        <div className="text-[11px] text-dim">
          {mode === "deposit" ? (
            <>
              Balance <span className="num text-muted">{fmtUsd(tusd)}</span> tUSD
            </>
          ) : (
            <>
              Max <span className="num text-muted">{fmtUsd(maxWithdraw)}</span> (keeps utilization ≤ 90%)
            </>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">$</span>
          <input
            className="input num pl-7 pr-14"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            disabled={!!blocked}
            onChange={(e) => {
              setAmount(e.target.value);
              setRedeemAll(false);
            }}
          />
          <button
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-accent hover:underline disabled:opacity-50"
            disabled={!!blocked}
            onClick={() => {
              if (maxFor === undefined) return;
              setAmount(formatUnits(maxFor, USD_DECIMALS));
              setRedeemAll(mode === "withdraw");
            }}
          >
            MAX
          </button>
        </div>
        <button className="btn btn-primary sm:w-44" disabled={!valid || busy || !isDeployed || wrongChain} onClick={submit}>
          {busy ? "Confirm…" : mode === "deposit" ? (allowance !== undefined && amt !== undefined && allowance >= amt ? "Deposit" : "Approve & deposit") : "Withdraw"}
        </button>
      </div>
      {wrongChain && <div className="mt-2 text-xs text-warn">{WRONG_CHAIN_HINT}</div>}
      {blocked && <div className="mt-2 text-xs leading-relaxed text-warn">{blocked}</div>}
      {!blocked && tooMuchDeposit && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-warn">
          <span>{maxDeposit !== undefined && amt !== undefined && amt > maxDeposit ? "Amount exceeds the vault's current deposit limit." : "Amount exceeds your tUSD balance."}</span>
          <FaucetButton />
        </div>
      )}
      {!blocked && tooMuchWithdraw && (
        <div className="mt-2 text-xs text-warn">
          Exceeds withdrawable amount: exits are capped so utilization stays at or below 90%, and collateral backing open
          positions stays locked until they settle.
        </div>
      )}
      {mode === "deposit" && !blocked && !tooMuchDeposit && tusd === 0n && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span>No tUSD yet.</span>
          <FaucetButton />
        </div>
      )}
    </div>
  );
}
