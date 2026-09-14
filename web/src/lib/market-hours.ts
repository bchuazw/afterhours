/**
 * Robinhood Chain Stock Token feeds print 24/5. The observed Chainlink schedule freezes the
 * last print at Friday 20:00 UTC and resumes Sunday ~22:00 UTC. We treat any print older than
 * 30 minutes on a Saturday/Sunday (UTC) as "market closed, feed frozen".
 */

export const FROZEN_AFTER_MS = 30 * 60 * 1000;

export type FeedStatus =
  | { kind: "live"; label: string }
  | { kind: "closed"; label: string; since: number }
  | { kind: "stale"; label: string; since: number }
  | { kind: "paused"; label: string }
  | { kind: "unknown"; label: string };

export function feedStatus(updatedAt: number | undefined, paused: boolean, nowMs = Date.now()): FeedStatus {
  if (paused) return { kind: "paused", label: "Feed paused · corporate action" };
  if (updatedAt === undefined) return { kind: "unknown", label: "No feed data" };
  const ageMs = nowMs - updatedAt * 1000;
  const day = new Date(nowMs).getUTCDay(); // 0 Sun .. 6 Sat
  const weekend = day === 0 || day === 6;
  if (ageMs > FROZEN_AFTER_MS && weekend) {
    return { kind: "closed", label: "Market closed · feed frozen", since: updatedAt };
  }
  if (ageMs > FROZEN_AFTER_MS) {
    return { kind: "stale", label: "Feed quiet", since: updatedAt };
  }
  return { kind: "live", label: "Market open · feed live" };
}

/** Next Monday 13:30 UTC (NYSE open) strictly after `now`. */
export function nextMondayOpen(nowMs = Date.now()): number {
  const d = new Date(nowMs);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 13, 30, 0));
  const dow = target.getUTCDay();
  let add = (1 - dow + 7) % 7;
  if (add === 0 && target.getTime() <= nowMs) add = 7;
  target.setUTCDate(target.getUTCDate() + add);
  return Math.floor(target.getTime() / 1000);
}

/** Next Friday 20:00 UTC (NYSE close) strictly after `now`. */
export function nextFridayClose(nowMs = Date.now()): number {
  const d = new Date(nowMs);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 20, 0, 0));
  const dow = target.getUTCDay();
  let add = (5 - dow + 7) % 7;
  if (add === 0 && target.getTime() <= nowMs) add = 7;
  target.setUTCDate(target.getUTCDate() + add);
  return Math.floor(target.getTime() / 1000);
}

/** Is a unix-second timestamp inside the 24/5 closed window (Fri 20:00 UTC to Sun 22:00 UTC)? */
export function isClosedAt(ts: number): boolean {
  const d = new Date(ts * 1000);
  const dow = d.getUTCDay();
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (dow === 6) return true;
  if (dow === 5 && h >= 20) return true;
  if (dow === 0 && h < 22) return true;
  return false;
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
