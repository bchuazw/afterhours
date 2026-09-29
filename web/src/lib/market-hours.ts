/**
 * Robinhood Chain Stock Token feeds print 24/5: the week closes Friday 20:00 ET and the overnight
 * session reopens Sunday 20:00 ET. In UTC that is Sat 00:00 -> Mon 00:00 in daylight time and
 * Sat 01:00 -> Mon 01:00 in standard time. AfterHoursMarket uses the conservative union of both,
 * Saturday 00:00 UTC -> Monday 01:00 UTC, as its closed window: no sales inside it and no expiry
 * may fall inside it. `isClosedAt` below mirrors `AfterHoursMarket.isClosedAt` exactly.
 */

const DAY = 86_400;
const HOUR = 3_600;

/** A print older than this outside the closed window is shown as "feed quiet". */
export const QUIET_AFTER_SEC = 30 * 60;

/** Headroom added to `now + minTenor` for presets, so the buy still clears minTenor when it mines. */
export const EXPIRY_BUFFER_SEC = 10 * 60;

/** 0 = Sunday .. 6 = Saturday, in UTC (same formula as the contract). */
const utcDow = (ts: number) => (Math.floor(ts / DAY) + 4) % 7;
const dayStart = (ts: number) => Math.floor(ts / DAY) * DAY;

/** Mirror of AfterHoursMarket.isClosedAt: Saturday 00:00 UTC through Monday 01:00 UTC (exclusive). */
export function isClosedAt(ts: number): boolean {
  const dow = utcDow(ts);
  return dow === 6 || dow === 0 || (dow === 1 && ts % DAY < HOUR);
}

/** `ts` itself if the market is open then, otherwise the end of its closed window (Monday 01:00 UTC). */
export function nextOpenAt(ts: number): number {
  if (!isClosedAt(ts)) return ts;
  const dow = utcDow(ts);
  const daysToMonday = dow === 6 ? 2 : dow === 0 ? 1 : 0;
  return dayStart(ts) + daysToMonday * DAY + HOUR;
}

/** Start (Saturday 00:00 UTC) of the closed window containing `ts`, or of the next one if open. */
export function closedWindowStart(ts: number): number {
  const dow = utcDow(ts);
  if (isClosedAt(ts)) {
    const back = dow === 6 ? 0 : dow === 0 ? 1 : 2;
    return dayStart(ts) - back * DAY;
  }
  return dayStart(ts) + ((6 - dow + 7) % 7) * DAY;
}

/** First timestamp >= `from` that falls on UTC weekday `dow` at `hh:mm` UTC. */
export function nextWeekdayAt(from: number, dow: number, hh: number, mm: number): number {
  const base = dayStart(from) + hh * HOUR + mm * 60;
  let t = base + ((dow - utcDow(from) + 7) % 7) * DAY;
  if (t < from) t += 7 * DAY;
  return t;
}

export type ExpiryPreset = "monday" | "friday" | "7d" | "30d";

/**
 * Expiry for a preset, computed from `now`. Never returns a time inside the closed window or outside
 * [now + minTenor + buffer, now + maxTenor - buffer]; returns undefined if no such time exists.
 *  - monday: next Monday 13:30 UTC (NYSE open) at or after now + minTenor
 *  - friday: next Friday 20:00 UTC (NYSE close) at or after now + minTenor
 *  - 7d / 30d: now + N days (to the minute), moved forward to Monday 01:00 UTC if that lands in the
 *    closed window; if moving forward would pass maxTenor, moved back to the Friday 20:00 UTC before it.
 */
export function presetExpiry(preset: ExpiryPreset, now: number, minTenor: number, maxTenor: number): number | undefined {
  const earliest = now + minTenor + EXPIRY_BUFFER_SEC;
  const latest = now + maxTenor - EXPIRY_BUFFER_SEC;
  const minute = Math.floor(now / 60) * 60;
  let t: number;
  switch (preset) {
    case "monday":
      t = nextWeekdayAt(earliest, 1, 13, 30);
      break;
    case "friday":
      t = nextWeekdayAt(earliest, 5, 20, 0);
      break;
    case "7d":
    case "30d": {
      const days = preset === "7d" ? 7 : 30;
      t = Math.min(latest, Math.max(earliest, minute + days * DAY));
      if (isClosedAt(t)) {
        const fwd = nextOpenAt(t);
        t = fwd <= latest ? fwd : closedWindowStart(t) - 4 * HOUR;
      }
      break;
    }
  }
  if (t < earliest || t > latest || isClosedAt(t)) return undefined;
  return t;
}

export type FeedStatus =
  | { kind: "live"; label: string }
  | { kind: "closed"; label: string; since: number; reopens: number }
  | { kind: "quiet"; label: string; since: number }
  | { kind: "stale"; label: string; since: number }
  | { kind: "paused"; label: string }
  | { kind: "invalid"; label: string }
  | { kind: "unknown"; label: string };

/**
 * UI status of a feed. `maxPriceAge` is the market's staleness limit: older prints block sales.
 * `invalid` means the latest answer is outside (0, 1e14) and the market will refuse to quote.
 */
export function feedStatus(
  updatedAt: number | undefined,
  opts: { paused?: boolean; invalid?: boolean; maxPriceAge?: number; nowMs?: number } = {},
): FeedStatus {
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (opts.paused) return { kind: "paused", label: "Feed paused · corporate action" };
  if (updatedAt === undefined) return { kind: "unknown", label: "No feed data" };
  if (opts.invalid) return { kind: "invalid", label: "Latest feed answer invalid" };
  if (isClosedAt(nowSec)) {
    return { kind: "closed", label: "Market closed · feed dark", since: updatedAt, reopens: nextOpenAt(nowSec) };
  }
  const age = nowSec - updatedAt;
  if (opts.maxPriceAge !== undefined && age > opts.maxPriceAge) {
    return { kind: "stale", label: "Feed stale", since: updatedAt };
  }
  if (age > QUIET_AFTER_SEC) return { kind: "quiet", label: "Feed quiet", since: updatedAt };
  return { kind: "live", label: "Market open · feed live" };
}

/** Value for an <input type="datetime-local"> (local wall-clock time). */
export function toDatetimeLocal(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromDatetimeLocal(s: string): number | undefined {
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined;
}
