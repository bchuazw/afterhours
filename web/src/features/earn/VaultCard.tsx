"use client";

import { useMemo, useState } from "react";
import { useAccount, useReadContracts } from "wagmi";
import { formatUnits, zeroAddress } from "viem";
import { erc20Abi, vaultAbi } from "@/abi";
import { COMPANY, deployment, isDeployed, isZero, type UnderlyingDeployment } from "@/lib/deployment";
import { fmtBps, fmtUsd, parseDecimal, USD_DECIMALS, usdToNumber } from "@/lib/format";
import { useAllowance, useTusdBalance } from "@/lib/hooks/useToken";
import { useVaultFlows } from "@/lib/hooks/useLogs";
import { useTx } from "@/lib/hooks/useTx";
import { AddressLink, ErrorNote, InfoNote, Stat } from "@/components/ui";
import { FaucetButton } from "@/components/FaucetButton";

export function VaultCard({ u }: { u: UnderlyingDeployment }) {
  const { address, isConnected } = useAccount();
  const vault = { address: u.vault, abi: vaultAbi } as const;
  const owner = address ?? zeroAddress;
  const enabled = isDeployed && !isZero(u.vault);

  const q = useReadContracts({
    contracts: [
      { ...vault, functionName: "totalAssets" },
      { ...vault, functionName: "lockedCollateral" },
      { ...vault, functionName: "freeLiquidity" },
      { ...vault, functionName: "utilizationBps" },
      { ...vault, functionName: "decimals" },
      { ...vault, functionName: "balanceOf", args: [owner] },
      { ...vault, functionName: "maxWithdraw", args: [owner] },
      { ...vault, functionName: "totalSupply" },
    ],
    allowFailure: true,
    query: { enabled, refetchInterval: 15_000 },
  });

  const base = useMemo(() => {
    const r = q.data;
    if (!r) return undefined;
    const g = <T,>(i: number): T | undefined => (r[i].status === "success" ? (r[i].result as T) : undefined);
    return {
      totalAssets: g<bigint>(0),
      locked: g<bigint>(1),
      free: g<bigint>(2),
      utilBps: g<bigint>(3),
      decimals: g<number>(4) ?? 12,
      shares: g<bigint>(5),
      maxWithdraw: g<bigint>(6),
      totalSupply: g<bigint>(7),
    };
  }, [q.data]);

  const oneShare = base ? 10n ** BigInt(base.decimals) : 10n ** 12n;
  const conv = useReadContracts({
    contracts: [
      { ...vault, functionName: "convertToAssets", args: [base?.shares ?? 0n] },
      { ...vault, functionName: "convertToAssets", args: [oneShare] },
    ],
    allowFailure: true,
    query: { enabled: enabled && !!base, refetchInterval: 15_000 },
  });
  const yourAssets = conv.data?.[0].status === "success" ? conv.data[0].result : undefined;
  const sharePrice = conv.data?.[1].status === "success" ? conv.data[1].result : undefined;

  const { data: flows } = useVaultFlows(u.vault, address);
  const earned = yourAssets !== undefined && flows ? yourAssets - (flows.deposited - flows.withdrawn) : undefined;

  const loading = enabled && q.isLoading;
  const firstErr = q.data?.find((x) => x.status === "failure");

  return (
    <div className="card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-semibold">{u.symbol} vault</span>
            <span className="text-xs text-muted">{COMPANY[u.key]} protection writers</span>
          </div>
          <div className="mt-0.5 text-[11px] text-dim">
            ERC-4626 · {isZero(u.vault) ? "not deployed" : <AddressLink address={u.vault} chars={6} />}
          </div>
        </div>
        <UtilizationRing bps={base?.utilBps} loading={loading} />
      </div>

      {firstErr && <ErrorNote className="mt-3">Vault read failed: {firstErr.error?.message.split("\n")[0]}</ErrorNote>}

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
        <Stat label="TVL" value={fmtUsd(base?.totalAssets, { compact: true })} loading={loading} />
        <Stat label="Locked collateral" value={fmtUsd(base?.locked, { compact: true })} loading={loading} />
        <Stat label="Free liquidity" value={fmtUsd(base?.free, { compact: true })} loading={loading} />
        <Stat
          label="Share price"
          value={sharePrice !== undefined ? `$${usdToNumber(sharePrice).toFixed(4)}` : "—"}
          sub={sharePrice !== undefined ? `${(usdToNumber(sharePrice) - 1 >= 0 ? "+" : "")}${((usdToNumber(sharePrice) - 1) * 100).toFixed(3)}% since 1.0000` : undefined}
          loading={loading}
          tone={sharePrice !== undefined && sharePrice > 1_000_000n ? "pos" : undefined}
        />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 rounded-lg border border-line bg-bg p-3 sm:grid-cols-4">
        <Stat label="Your shares" value={base?.shares !== undefined ? fmtShares(base.shares, base.decimals) : "—"} loading={loading && isConnected} />
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
        <Forms u={u} maxWithdraw={base?.maxWithdraw} />
      )}
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
    <div className="flex items-center gap-2" title="Utilization = locked collateral / total assets. Cap 90%.">
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

function Forms({ u, maxWithdraw }: { u: UnderlyingDeployment; maxWithdraw?: bigint }) {
  const { address } = useAccount();
  const { send, busy } = useTx();
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const amt = parseDecimal(amount, USD_DECIMALS);
  const { data: tusd } = useTusdBalance(address);
  const { data: allowance } = useAllowance(deployment.usd, address, u.vault);

  const tooMuchDeposit = mode === "deposit" && amt !== undefined && tusd !== undefined && amt > tusd;
  const tooMuchWithdraw = mode === "withdraw" && amt !== undefined && maxWithdraw !== undefined && amt > maxWithdraw;
  const valid = !!amt && amt > 0n && !tooMuchDeposit && !tooMuchWithdraw;

  const submit = async () => {
    if (!address || !amt) return;
    if (mode === "deposit") {
      if (allowance === undefined || allowance < amt) {
        const ok = await send("Approve tUSD", { address: deployment.usd, abi: erc20Abi, functionName: "approve", args: [u.vault, amt] });
        if (!ok) return;
      }
      const ok = await send(`Deposit into ${u.symbol} vault`, { address: u.vault, abi: vaultAbi, functionName: "deposit", args: [amt, address] });
      if (ok) setAmount("");
    } else {
      const ok = await send(`Withdraw from ${u.symbol} vault`, { address: u.vault, abi: vaultAbi, functionName: "withdraw", args: [amt, address, address] });
      if (ok) setAmount("");
    }
  };

  return (
    <div className="mt-4 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="seg">
          <button data-active={mode === "deposit"} onClick={() => setMode("deposit")}>Deposit</button>
          <button data-active={mode === "withdraw"} onClick={() => setMode("withdraw")}>Withdraw</button>
        </div>
        <div className="text-[11px] text-dim">
          {mode === "deposit" ? (
            <>
              Balance <span className="num text-muted">{fmtUsd(tusd)}</span> tUSD
            </>
          ) : (
            <>
              Max <span className="num text-muted">{fmtUsd(maxWithdraw)}</span> (free liquidity)
            </>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">$</span>
          <input className="input num pl-7 pr-14" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <button
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-accent hover:underline"
            onClick={() => {
              const v = mode === "deposit" ? tusd : maxWithdraw;
              if (v !== undefined) setAmount(formatUnits(v, USD_DECIMALS));
            }}
          >
            MAX
          </button>
        </div>
        <button className="btn btn-primary sm:w-44" disabled={!valid || busy || !isDeployed} onClick={submit}>
          {busy ? "Confirm…" : mode === "deposit" ? (allowance !== undefined && amt !== undefined && allowance >= amt ? "Deposit" : "Approve & deposit") : "Withdraw"}
        </button>
      </div>
      {tooMuchDeposit && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-warn">
          <span>Amount exceeds your tUSD balance.</span>
          <FaucetButton />
        </div>
      )}
      {tooMuchWithdraw && <div className="mt-2 text-xs text-warn">Exceeds withdrawable amount; collateral backing open positions stays locked until they settle.</div>}
      {mode === "deposit" && !tooMuchDeposit && tusd === 0n && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span>No tUSD yet.</span>
          <FaucetButton />
        </div>
      )}
    </div>
  );
}
