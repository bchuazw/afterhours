/**
 * Robinhood Chain Stock Token feeds print 24/5: the week closes Friday 20:00 ET and the overnight
 * session reopens Sunday 20:00 ET. In UTC that is Sat 00:00 -> Mon 00:00 in daylight time and
 * Sat 01:00 -> Mon 01:00 in standard time. AfterHoursMarket uses the conservative union of both,
 * Saturday 00:00 UTC -> Monday 01:00 UTC, as its closed window: no sales inside it and no expiry
 * may fall inside it. `isClosedAt` below mirrors `AfterHoursMarket.isClosedAt` exactly.
 *
 * In practice the feeds stop printing earlier than that. On the live mainnet feeds (TSLA, AMZN, NVDA,
 * Aug-Sep 2026) the last Friday print lands between 14:50 and 20:03 UTC, Friday 20:00-24:00 UTC sees
 * at most one print, and the next print is the Monday 00:00 UTC reopen. A series expiring in that
 * Friday-evening slice is accepted by the contract and priced with no closed-market time, yet settles
 * on the Monday reopen print: roughly 52 hours of weekend gap bought at weekday prices. The app
 * therefore treats Friday 20:00 UTC -> Monday 01:00 UTC as "dark" (`isDarkAt`) and never offers or
 * accepts an expiry inside it, and its presets land on a coarse grid (`gridExpiryAtOrAfter`) so
 * buyers share series instead of opening a new one on every buy.
 */

const DAY = 86_400;
const HOUR = 3_600;

/** A print older than this outside the closed window is shown as "feed quiet". */
export const QUIET_AFTER_SEC = 30 * 60;

/** Headroom added to `now + minTenor` for presets, so the buy still clears minTenor when it mines. */
export const EXPIRY_BUFFER_SEC = 10 * 60;

/**
 * Seconds into Friday (UTC) from which the feeds are treated as dark: 20:00 UTC, the regular-session
 * close in US daylight time (21:00 UTC in standard time, so 20:00 is the conservative choice).
 */
export const DARK_FROM_FRIDAY_SEC = 20 * HOUR;

/**
 * Hour (UTC) of the listed expiry grid: 19:00 UTC on weekdays. That is inside the US regular session
 * in both daylight (13:30-20:00 UTC) and standard (14:30-21:00 UTC) time, so a live print follows
 * every listed expiry within minutes, and it is the last whole hour before the Friday dark window.
 */
export const GRID_HOUR_UTC = 19;

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

/**
 * True while the feeds are dark in practice: Friday 20:00 UTC through Monday 01:00 UTC (exclusive).
 * A superset of `isClosedAt`. An expiry in here would be accepted by the contract (before Saturday
 * 00:00 UTC) but priced with no closed-market time and settled on the Monday reopen print, so the
 * app refuses it. Sales themselves follow the contract window (`isClosedAt`).
 */
export function isDarkAt(ts: number): boolean {
  return (utcDow(ts) === 5 && ts % DAY >= DARK_FROM_FRIDAY_SEC) || isClosedAt(ts);
}

/** `ts` itself if the feeds are live then, otherwise the end of the dark window (Monday 01:00 UTC). */
export function nextLiveAt(ts: number): number {
  if (!isDarkAt(ts)) return ts;
  const dow = utcDow(ts);
  const daysToMonday = dow === 5 ? 3 : dow === 6 ? 2 : dow === 0 ? 1 : 0;
  return dayStart(ts) + daysToMonday * DAY + HOUR;
}

/** First timestamp >= `from` that falls on UTC weekday `dow` at `hh:mm` UTC. */
export function nextWeekdayAt(from: number, dow: number, hh: number, mm: number): number {
  const base = dayStart(from) + hh * HOUR + mm * 60;
  let t = base + ((dow - utcDow(from) + 7) % 7) * DAY;
  if (t < from) t += 7 * DAY;
  return t;
}

/** First listed expiry (weekday 19:00 UTC) at or after `from`. Saturday and Sunday roll to Monday. */
export function gridExpiryAtOrAfter(from: number): number {
  let t = dayStart(from) + GRID_HOUR_UTC * HOUR;
  if (t < from) t += DAY;
  while (isDarkAt(t)) t += DAY;
  return t;
}

/** Last listed expiry (weekday 19:00 UTC) at or before `to`. Saturday and Sunday roll back to Friday. */
export function gridExpiryAtOrBefore(to: number): number {
  let t = dayStart(to) + GRID_HOUR_UTC * HOUR;
  if (t > to) t -= DAY;
  while (isDarkAt(t)) t -= DAY;
  return t;
}

export type ExpiryPreset = "monday" | "friday" | "7d" | "30d";

/**
 * Expiry for a preset, computed from `now`. Never returns a time inside the dark window or outside
 * [now + minTenor + buffer, now + maxTenor - buffer]; returns undefined if no such time exists.
 * Every preset lands on a listed time (a weekday 19:00 UTC, or Monday 13:30 UTC), so everyone who
 * picks the same preset on the same day joins the same series instead of opening a new one.
 *  - monday: next Monday 13:30 UTC (NYSE open) at or after now + minTenor
 *  - friday: next Friday 19:00 UTC (last whole hour of the regular session) at or after now + minTenor
 *  - 7d: first weekday 19:00 UTC at or after now + 7 days, or the last one within maxTenor
 *  - 30d: last weekday 19:00 UTC within maxTenor
 */
export function presetExpiry(preset: ExpiryPreset, now: number, minTenor: number, maxTenor: number): number | undefined {
  const earliest = now + minTenor + EXPIRY_BUFFER_SEC;
  const latest = now + maxTenor - EXPIRY_BUFFER_SEC;
  let t: number;
  switch (preset) {
    case "monday":
      t = nextWeekdayAt(earliest, 1, 13, 30);
      break;
    case "friday":
      t = nextWeekdayAt(earliest, 5, GRID_HOUR_UTC, 0);
      break;
    case "7d":
      t = gridExpiryAtOrAfter(Math.max(earliest, now + 7 * DAY));
      if (t > latest) t = gridExpiryAtOrBefore(latest);
      break;
    case "30d":
      t = gridExpiryAtOrBefore(latest);
      break;
  }
  if (t < earliest || t > latest || isDarkAt(t)) return undefined;
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
 * "closed" follows the contract's sales window, not the wider dark window: sales are still accepted
 * on Friday evening, where a quiet feed is reported as such.
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
