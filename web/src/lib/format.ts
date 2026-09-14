import { formatUnits, parseUnits } from "viem";

export const USD_DECIMALS = 6;
export const PRICE_DECIMALS = 8;
export const UNIT_DECIMALS = 18;

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const usdCompactFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
});
const numFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

/** 6-decimal quote-asset amount to "$1,234.56". */
export function fmtUsd(v: bigint | undefined | null, opts?: { compact?: boolean }): string {
  if (v === undefined || v === null) return "—";
  const n = Number(formatUnits(v, USD_DECIMALS));
  return opts?.compact && Math.abs(n) >= 100_000 ? usdCompactFmt.format(n) : usdFmt.format(n);
}

/** 8-decimal feed price to "$412.30". */
export function fmtPrice(v: bigint | undefined | null): string {
  if (v === undefined || v === null) return "—";
  return usdFmt.format(Number(formatUnits(v, PRICE_DECIMALS)));
}

/** 1e18 = 100% to "42.5%". */
export function fmtVol(v: bigint | undefined | null, digits = 1): string {
  if (v === undefined || v === null) return "—";
  return `${(Number(formatUnits(v, 18)) * 100).toFixed(digits)}%`;
}

export function fmtPct(n: number | undefined | null, digits = 2): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtBps(bps: bigint | number | undefined | null, digits = 1): string {
  if (bps === undefined || bps === null) return "—";
  return `${(Number(bps) / 100).toFixed(digits)}%`;
}

/** 18-decimal units to "1.25" shares. */
export function fmtUnits(v: bigint | undefined | null, digits = 4): string {
  if (v === undefined || v === null) return "—";
  const n = Number(formatUnits(v, UNIT_DECIMALS));
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(n);
}

export function fmtNum(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return "—";
  return numFmt.format(n);
}

export const priceToNumber = (v: bigint) => Number(formatUnits(v, PRICE_DECIMALS));
export const usdToNumber = (v: bigint) => Number(formatUnits(v, USD_DECIMALS));
export const unitsToNumber = (v: bigint) => Number(formatUnits(v, UNIT_DECIMALS));

/** Parse a user-entered decimal string safely; returns undefined for junk. */
export function parseDecimal(s: string, decimals: number): bigint | undefined {
  const t = s.trim().replace(/,/g, "");
  if (!t || !/^\d*\.?\d*$/.test(t) || t === ".") return undefined;
  try {
    return parseUnits(t as `${number}`, decimals);
  } catch {
    return undefined;
  }
}

export function shortAddr(a: string, n = 4): string {
  return `${a.slice(0, 2 + n)}…${a.slice(-n)}`;
}

export function shortHash(h: string): string {
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}

// ---- time ----------------------------------------------------------------------------------

const dtLocal = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const dtUtcTime = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  hour12: false,
});
const dtUtcFull = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  hour12: false,
});

/** Local time with a UTC hint, e.g. "Mon, Sep 15, 09:30 PM (13:30 UTC)". */
export function fmtTime(ts: number | bigint | undefined | null): string {
  if (ts === undefined || ts === null) return "—";
  const d = new Date(Number(ts) * 1000);
  return `${dtLocal.format(d)} (${dtUtcTime.format(d)} UTC)`;
}

export function fmtTimeShort(ts: number | bigint): string {
  return dtLocal.format(new Date(Number(ts) * 1000));
}

export function fmtUtc(ts: number | bigint): string {
  return `${dtUtcFull.format(new Date(Number(ts) * 1000))} UTC`;
}

/** "2d 4h", "3h 12m", "45m 3s", "12s". */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** "3 min ago", "2 h ago", "2 d ago". */
export function fmtAgo(ts: number | bigint, nowSec = Date.now() / 1000): string {
  const s = Math.max(0, nowSec - Number(ts));
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function hoursOf(seconds: number | bigint): string {
  const h = Number(seconds) / 3600;
  return h >= 10 ? `${Math.round(h)}h` : `${h.toFixed(1)}h`;
}
