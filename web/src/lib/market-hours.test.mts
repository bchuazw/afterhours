/**
 * Regression tests for the expiry rules in market-hours.ts. No test runner is installed for the web
 * app, so this uses node:test and Node's built-in TypeScript type stripping (Node >= 22.6):
 *
 *   node --test src/lib/market-hours.test.mts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EXPIRY_BUFFER_SEC,
  GRID_HOUR_UTC,
  gridExpiryAtOrAfter,
  gridExpiryAtOrBefore,
  isClosedAt,
  isDarkAt,
  nextLiveAt,
  nextOpenAt,
  presetExpiry,
  type ExpiryPreset,
} from "./market-hours.ts";

const HOUR = 3_600;
const DAY = 86_400;
const MIN_TENOR = HOUR;
const MAX_TENOR = 30 * DAY;
const PRESETS: ExpiryPreset[] = ["monday", "friday", "7d", "30d"];

/** Monday 2026-09-28 00:00 UTC. */
const MON = Date.UTC(2026, 8, 28) / 1000;
const at = (dayOffset: number, hh: number, mm = 0) => MON + dayOffset * DAY + hh * HOUR + mm * 60;
const FRI = (hh: number, mm = 0) => at(4, hh, mm);
const utcDow = (ts: number) => (Math.floor(ts / DAY) + 4) % 7;

describe("isDarkAt (Friday 20:00 UTC -> Monday 01:00 UTC)", () => {
  it("is a superset of the contract's closed window", () => {
    for (let ts = MON; ts < MON + 7 * DAY; ts += 15 * 60) {
      if (isClosedAt(ts)) assert.equal(isDarkAt(ts), true, `closed but not dark at +${(ts - MON) / HOUR}h`);
    }
  });

  it("starts at Friday 20:00 UTC, where the contract window only starts Saturday 00:00 UTC", () => {
    assert.equal(isDarkAt(FRI(19, 59)), false);
    assert.equal(isDarkAt(FRI(20, 0)), true);
    assert.equal(isDarkAt(FRI(23, 59)), true);
    assert.equal(isClosedAt(FRI(23, 59)), false);
    assert.equal(isDarkAt(at(5, 0)), true); // Saturday
    assert.equal(isDarkAt(at(7, 0, 59)), true); // Monday 00:59
    assert.equal(isDarkAt(at(7, 1)), false); // Monday 01:00
    assert.equal(isDarkAt(at(2, 20)), false); // Wednesday evening is live
  });

  it("nextLiveAt maps the whole dark window to Monday 01:00 UTC", () => {
    const reopen = at(7, 1);
    assert.equal(nextLiveAt(FRI(20)), reopen);
    assert.equal(nextLiveAt(FRI(23, 30)), reopen);
    assert.equal(nextLiveAt(at(6, 12)), reopen);
    assert.equal(nextLiveAt(at(7, 0, 30)), reopen);
    assert.equal(nextLiveAt(at(7, 1)), at(7, 1));
    assert.equal(nextLiveAt(FRI(19)), FRI(19));
    // The contract's own reopen is the same instant.
    assert.equal(nextOpenAt(at(5, 0)), reopen);
  });
});

describe("expiry grid (weekday 19:00 UTC)", () => {
  it("rounds forward to the next weekday 19:00 UTC, skipping the weekend", () => {
    assert.equal(gridExpiryAtOrAfter(at(0, 10)), at(0, 19));
    assert.equal(gridExpiryAtOrAfter(at(0, 19)), at(0, 19));
    assert.equal(gridExpiryAtOrAfter(at(0, 19, 1)), at(1, 19));
    assert.equal(gridExpiryAtOrAfter(FRI(19, 30)), at(7, 19)); // next Monday
    assert.equal(gridExpiryAtOrAfter(at(5, 3)), at(7, 19)); // Saturday -> Monday
  });

  it("rounds back to the previous weekday 19:00 UTC, skipping the weekend", () => {
    assert.equal(gridExpiryAtOrBefore(at(1, 10)), at(0, 19));
    assert.equal(gridExpiryAtOrBefore(at(1, 19)), at(1, 19));
    assert.equal(gridExpiryAtOrBefore(FRI(22)), FRI(19)); // Friday evening -> Friday 19:00, not 20:00
    assert.equal(gridExpiryAtOrBefore(at(6, 12)), FRI(19)); // Sunday -> Friday
    assert.equal(gridExpiryAtOrBefore(at(7, 0, 30)), FRI(19)); // Monday 00:30 -> Friday
  });
});

describe("presetExpiry", () => {
  it("never lands in the dark window or outside the tenor band, for any time of the week", () => {
    for (let now = MON; now < MON + 7 * DAY; now += 10 * 60) {
      const earliest = now + MIN_TENOR + EXPIRY_BUFFER_SEC;
      const latest = now + MAX_TENOR - EXPIRY_BUFFER_SEC;
      for (const p of PRESETS) {
        const t = presetExpiry(p, now, MIN_TENOR, MAX_TENOR);
        assert.notEqual(t, undefined, `${p} undefined at +${(now - MON) / HOUR}h`);
        assert.ok(t! >= earliest && t! <= latest, `${p} outside tenor band at +${(now - MON) / HOUR}h`);
        assert.equal(isDarkAt(t!), false, `${p} in the dark window at +${(now - MON) / HOUR}h`);
        assert.equal(isClosedAt(t!), false);
      }
    }
  });

  it("'friday' is Friday 19:00 UTC, never Friday 20:00 UTC", () => {
    const t = presetExpiry("friday", at(2, 12), MIN_TENOR, MAX_TENOR);
    assert.equal(t, FRI(19));
    // Thursday 18:30: Friday 19:00 is still more than minTenor away.
    assert.equal(presetExpiry("friday", at(3, 17, 30), MIN_TENOR, MAX_TENOR), FRI(19));
    // Friday 18:30: this Friday is too close, roll to next week.
    assert.equal(presetExpiry("friday", FRI(18, 30), MIN_TENOR, MAX_TENOR), FRI(19) + 7 * DAY);
    for (let now = MON; now < MON + 7 * DAY; now += HOUR) {
      const f = presetExpiry("friday", now, MIN_TENOR, MAX_TENOR)!;
      assert.equal(utcDow(f), 5);
      assert.equal(f % DAY, GRID_HOUR_UTC * HOUR);
    }
  });

  it("'30d' that would end on Friday evening or the weekend backs off to Friday 19:00 UTC", () => {
    // now + 30d - buffer lands Friday 22:00 UTC (a time the contract accepts but the feeds are dark).
    const now = FRI(22) - MAX_TENOR + EXPIRY_BUFFER_SEC;
    assert.equal(presetExpiry("30d", now, MIN_TENOR, MAX_TENOR), FRI(19));
    // now + 30d lands Sunday: same Friday.
    const nowSun = at(6, 12) - MAX_TENOR;
    assert.equal(presetExpiry("30d", nowSun, MIN_TENOR, MAX_TENOR), FRI(19));
  });

  it("'7d' that would land on the weekend rolls forward to Monday 19:00 UTC", () => {
    const nowSat = at(5, 9) - 7 * DAY; // now + 7d = Saturday 09:00
    assert.equal(presetExpiry("7d", nowSat, MIN_TENOR, MAX_TENOR), at(7, 19));
    const nowFriEve = FRI(21) - 7 * DAY; // now + 7d = Friday 21:00, in the dark slice
    assert.equal(presetExpiry("7d", nowFriEve, MIN_TENOR, MAX_TENOR), at(7, 19));
  });

  it("'7d' and '30d' snap to the listed grid so buyers in the same day share a series", () => {
    for (const p of ["7d", "30d"] as const) {
      const seen = new Set<number>();
      for (let now = at(1, 0); now < at(2, 0); now += 60) {
        const t = presetExpiry(p, now, MIN_TENOR, MAX_TENOR)!;
        assert.equal(t % DAY, GRID_HOUR_UTC * HOUR, `${p} off the grid at ${now}`);
        assert.ok(utcDow(t) >= 1 && utcDow(t) <= 5, `${p} on a weekend at ${now}`);
        seen.add(t);
      }
      // A minute-granular expiry would produce 1440 distinct series in a day; the grid produces at most 2.
      assert.ok(seen.size <= 2, `${p} produced ${seen.size} distinct expiries over one day`);
    }
    // Two buyers one second apart get the same expiry (the old 30d fallback was `now + maxTenor - 600`).
    const a = presetExpiry("30d", at(1, 10, 5), MIN_TENOR, MAX_TENOR);
    const b = presetExpiry("30d", at(1, 10, 5) + 1, MIN_TENOR, MAX_TENOR);
    assert.equal(a, b);
  });

  it("returns undefined when no listed time fits the tenor band", () => {
    // A 90-minute max tenor from Tuesday 10:00: the only grid time (19:00) is out of range.
    assert.equal(presetExpiry("7d", at(1, 10), MIN_TENOR, 90 * 60), undefined);
    assert.equal(presetExpiry("30d", at(1, 10), MIN_TENOR, 90 * 60), undefined);
  });
});
