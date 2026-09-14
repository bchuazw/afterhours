//! Fixed-point option math (WAD = 1e18), `no_std`, i128 throughout.
//!
//! Everything here is pure so it can be unit-tested natively and reused by the Stylus entrypoint.
//! Prices are passed in the feed's own units (8 decimals on Robinhood Chain); volatilities and
//! multipliers are WAD-scaled (1e18 = 100% / 1.0x).

pub const WAD: i128 = 1_000_000_000_000_000_000;
pub const LN2: i128 = 693_147_180_559_945_309; // ln 2
pub const INV_SQRT_2PI: i128 = 398_942_280_401_432_678; // 1 / sqrt(2*pi)
pub const SECONDS_PER_YEAR: i128 = 31_536_000;
pub const DAY: u64 = 86_400;

/// a * b / WAD without overflowing i128 for |a| < 1.7e38 / 1e18 and |b| < 1.7e20.
#[inline]
pub fn mul_wad(a: i128, b: i128) -> i128 {
    (a / WAD) * b + ((a % WAD) * b) / WAD
}

/// a * WAD / b
#[inline]
pub fn div_wad(a: i128, b: i128) -> i128 {
    a * WAD / b
}

fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    // Newton iteration from a power-of-two upper bound.
    let mut x = 1u128 << ((128 - n.leading_zeros()).div_ceil(2));
    loop {
        let y = (x + n / x) >> 1;
        if y >= x {
            return x;
        }
        x = y;
    }
}

/// sqrt of a WAD number, result in WAD. Non-positive inputs return 0.
pub fn sqrt_wad(x: i128) -> i128 {
    if x <= 0 {
        return 0;
    }
    isqrt((x as u128) * (WAD as u128)) as i128
}

/// Natural log of a WAD number (x > 0), result in WAD.
pub fn ln_wad(x: i128) -> i128 {
    debug_assert!(x > 0);
    let mut m = x;
    let mut k: i128 = 0;
    while m >= 2 * WAD {
        m /= 2;
        k += 1;
    }
    while m < WAD {
        m *= 2;
        k -= 1;
    }
    // m in [1, 2): ln(m) = 2 * atanh(z), z = (m-1)/(m+1) in [0, 1/3)
    let z = (m - WAD) * WAD / (m + WAD);
    let z2 = mul_wad(z, z);
    let mut term = z;
    let mut sum = 0i128;
    let mut i = 1i128;
    while i <= 21 {
        sum += term / i;
        term = mul_wad(term, z2);
        if term == 0 {
            break;
        }
        i += 2;
    }
    2 * sum + k * LN2
}

/// e^x for WAD x. Clamped: returns 0 below -60 and saturates above +60.
pub fn exp_wad(x: i128) -> i128 {
    if x < -60 * WAD {
        return 0;
    }
    let x = if x > 60 * WAD { 60 * WAD } else { x };
    let k = x.div_euclid(LN2);
    let r = x - k * LN2; // [0, ln2)
    let mut term = WAD;
    let mut sum = WAD;
    let mut n = 1i128;
    while n <= 16 {
        term = mul_wad(term, r) / n;
        sum += term;
        if term == 0 {
            break;
        }
        n += 1;
    }
    if k >= 0 {
        sum << (k as u32)
    } else {
        sum >> ((-k) as u32)
    }
}

/// Standard normal CDF (Abramowitz & Stegun 26.2.17, |err| < 7.5e-8), WAD in / WAD out.
pub fn norm_cdf_wad(x: i128) -> i128 {
    const P: i128 = 231_641_900_000_000_000;
    const B1: i128 = 319_381_530_000_000_000;
    const B2: i128 = -356_563_782_000_000_000;
    const B3: i128 = 1_781_477_937_000_000_000;
    const B4: i128 = -1_821_255_978_000_000_000;
    const B5: i128 = 1_330_274_429_000_000_000;

    let ax = x.abs();
    if ax > 8 * WAD {
        return if x > 0 { WAD } else { 0 };
    }
    let t = div_wad(WAD, WAD + mul_wad(P, ax));
    let poly = mul_wad(t, B1 + mul_wad(t, B2 + mul_wad(t, B3 + mul_wad(t, B4 + mul_wad(t, B5)))));
    let phi = mul_wad(exp_wad(-mul_wad(ax, ax) / 2), INV_SQRT_2PI);
    let n = WAD - mul_wad(phi, poly);
    if x >= 0 {
        n
    } else {
        WAD - n
    }
}

/// Seconds in [from, to) that fall on Saturday or Sunday (UTC).
///
/// Robinhood tokenized-equity feeds publish 24/5: the overnight session opens Sunday 20:00 ET and
/// the week closes Friday 20:00 ET, i.e. Saturday 00:00 to Monday 00:00 UTC during daylight time.
/// Onchain Stock Tokens keep trading through that window with a frozen oracle; this is the gap
/// AfterHours prices.
pub fn closed_seconds(from: u64, to: u64) -> u64 {
    if to <= from {
        return 0;
    }
    let mut closed = 0u64;
    let mut t = from;
    while t < to {
        let day = t / DAY;
        let dow = (day + 4) % 7; // 0 = Sunday, 6 = Saturday (1970-01-01 was a Thursday)
        let day_end = ((day + 1) * DAY).min(to);
        if dow == 0 || dow == 6 {
            closed += day_end - t;
        }
        t = day_end;
    }
    closed
}

/// Annualized realized volatility (WAD) from (price, timestamp) rounds sorted oldest -> newest.
/// Log returns are squared and summed, then annualized over *open-market* seconds so weekend
/// freezes do not dilute the estimate. Returns `None` with fewer than 2 usable rounds.
pub fn realized_vol(rounds: &[(i128, u64)]) -> Option<i128> {
    let mut sum_r2 = 0i128;
    let mut prev: Option<(i128, u64)> = None;
    let mut first_t = 0u64;
    let mut last_t = 0u64;
    let mut n = 0u32;
    for &(p, t) in rounds {
        if p <= 0 {
            continue;
        }
        if let Some((pp, pt)) = prev {
            if t <= pt {
                continue;
            }
            let r = ln_wad(p * WAD / pp);
            sum_r2 += mul_wad(r, r);
            last_t = t;
            n += 1;
        } else {
            first_t = t;
            last_t = t;
        }
        prev = Some((p, t));
    }
    if n == 0 || last_t <= first_t {
        return None;
    }
    let open = (last_t - first_t) - closed_seconds(first_t, last_t);
    if open == 0 {
        return None;
    }
    let var_annual = sum_r2 * SECONDS_PER_YEAR / open as i128;
    Some(sqrt_wad(var_annual))
}

/// Black-Scholes European put (r = 0) per 1 unit of underlying, in price units.
///
/// The variance budget is split into open and closed seconds; closed seconds are scaled by
/// `closed_mult^2` so weekend gap risk is charged explicitly. Result is floored at intrinsic value.
pub fn put_premium(
    spot: i128,
    strike: i128,
    vol: i128,
    t_seconds: u64,
    closed_secs: u64,
    closed_mult: i128,
) -> i128 {
    let intrinsic = (strike - spot).max(0);
    if t_seconds == 0 || spot <= 0 || strike <= 0 {
        return intrinsic;
    }
    let closed = closed_secs.min(t_seconds) as i128;
    let open = t_seconds as i128 - closed;
    let m2 = mul_wad(closed_mult, closed_mult);
    let eff_seconds_wad = open * WAD + m2 * closed; // WAD-scaled effective seconds
    let var_t = mul_wad(mul_wad(vol, vol), eff_seconds_wad / SECONDS_PER_YEAR); // sigma^2 * T (WAD)
    let sig_sqrt_t = sqrt_wad(var_t);
    if sig_sqrt_t == 0 {
        return intrinsic;
    }
    let ln_sk = ln_wad(spot * WAD / strike);
    let d1 = div_wad(ln_sk + var_t / 2, sig_sqrt_t);
    let d2 = d1 - sig_sqrt_t;
    let put = mul_wad(strike, norm_cdf_wad(-d2)) - mul_wad(spot, norm_cdf_wad(-d1));
    put.max(intrinsic)
}

/// Robinhood Chain feeds emitted a handful of genesis-era rounds scaled at 18 decimals instead of
/// 8. Anything above $1,000,000/share in 8-dec terms is treated as an 18-dec answer.
pub fn normalize_answer(answer: i128) -> i128 {
    if answer >= 100_000_000_000_000 {
        answer / 10_000_000_000
    } else {
        answer
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: i128, b: i128, tol: i128) {
        assert!((a - b).abs() <= tol, "{a} vs {b} (tol {tol})");
    }

    #[test]
    fn ln_exp_sqrt() {
        close(ln_wad(2 * WAD), LN2, 10);
        close(ln_wad(WAD), 0, 1);
        close(ln_wad(WAD / 2), -LN2, 10);
        close(ln_wad(10 * WAD), 2_302_585_092_994_045_684, 100);
        close(exp_wad(WAD), 2_718_281_828_459_045_235, 1_000);
        close(exp_wad(-WAD), 367_879_441_171_442_321, 1_000);
        close(exp_wad(0), WAD, 0);
        assert_eq!(sqrt_wad(4 * WAD), 2 * WAD);
        close(sqrt_wad(2 * WAD), 1_414_213_562_373_095_048, 10);
        // round trip
        for x in [3i128, 7, 123, 999] {
            close(exp_wad(ln_wad(x * WAD)), x * WAD, x * 1_000_000); // ~1e-12 relative
        }
    }

    #[test]
    fn normal_cdf() {
        close(norm_cdf_wad(0), WAD / 2, 100_000_000_000);
        close(norm_cdf_wad(WAD), 841_344_746_068_542_949, 100_000_000_000);
        close(norm_cdf_wad(-WAD), 158_655_253_931_457_051, 100_000_000_000);
        close(norm_cdf_wad(1_959_963_984_540_054_000), 975_000_000_000_000_000, 100_000_000_000);
        assert_eq!(norm_cdf_wad(9 * WAD), WAD);
        assert_eq!(norm_cdf_wad(-9 * WAD), 0);
    }

    #[test]
    fn black_scholes_reference_values() {
        // S=100, K=100, sigma=20%, T=1y (no closed time): put = 7.9656
        let p = put_premium(100_0000_0000, 100_0000_0000, WAD / 5, SECONDS_PER_YEAR as u64, 0, WAD);
        close(p, 7_9656_0000, 20_000); // within $0.0002
        // S=100, K=90, sigma=30%, T=0.5y: d1=0.6027, d2=0.3906 -> put = 3.9896
        let p = put_premium(100_0000_0000, 90_0000_0000, 3 * WAD / 10, (SECONDS_PER_YEAR / 2) as u64, 0, WAD);
        close(p, 3_9896_0000, 50_000);
        // Deep ITM floors at intrinsic
        let p = put_premium(50_0000_0000, 100_0000_0000, WAD / 5, 3600, 0, WAD);
        assert!(p >= 50_0000_0000);
        // Zero tenor -> intrinsic
        assert_eq!(put_premium(90_0000_0000, 100_0000_0000, WAD / 5, 0, 0, WAD), 10_0000_0000);
        assert_eq!(put_premium(110_0000_0000, 100_0000_0000, WAD / 5, 0, 0, WAD), 0);
    }

    #[test]
    fn closed_time_raises_premium() {
        // 3 days, none closed vs 2 of 3 days closed with 1.5x multiplier
        let base = put_premium(360_0000_0000, 340_0000_0000, WAD / 2, 3 * DAY, 0, 3 * WAD / 2);
        let gap = put_premium(360_0000_0000, 340_0000_0000, WAD / 2, 3 * DAY, 2 * DAY, 3 * WAD / 2);
        assert!(gap > base, "{gap} <= {base}");
        // multiplier of exactly 1.0 makes closed time irrelevant
        let same = put_premium(360_0000_0000, 340_0000_0000, WAD / 2, 3 * DAY, 2 * DAY, WAD);
        assert_eq!(same, base);
    }

    #[test]
    fn weekend_calendar() {
        // 2026-09-14 is a Monday. 1789344000 = 2026-09-14T00:00:00Z
        let mon = 1_789_344_000u64;
        assert_eq!(closed_seconds(mon, mon + 5 * DAY), 0); // Mon..Sat 00:00
        assert_eq!(closed_seconds(mon, mon + 7 * DAY), 2 * DAY); // full week
        assert_eq!(closed_seconds(mon + 5 * DAY + 3600, mon + 6 * DAY), DAY - 3600); // inside Saturday
        assert_eq!(closed_seconds(mon + 5 * DAY, mon + 7 * DAY + 12 * 3600), 2 * DAY); // Sat->Mon noon
        assert_eq!(closed_seconds(mon, mon), 0);
        assert_eq!(closed_seconds(mon + 10, mon), 0);
    }

    #[test]
    fn realized_vol_from_rounds() {
        // 1% moves every hour for 48 hours on weekdays -> sigma ~ 1% * sqrt(8760) ~ 93.6%
        let mon = 1_789_344_000u64;
        let mut rounds = Vec::new();
        let mut p = 100_0000_0000i128;
        for i in 0..48u64 {
            p = if i % 2 == 0 { p * 101 / 100 } else { p * 100 / 101 };
            rounds.push((p, mon + i * 3600));
        }
        let v = realized_vol(&rounds).unwrap();
        close(v, 936_000_000_000_000_000, 20_000_000_000_000_000);
        assert!(realized_vol(&rounds[..1]).is_none());
        assert!(realized_vol(&[]).is_none());
        // duplicate timestamps and bad prices are ignored, not fatal
        let noisy = [(0i128, mon), (100_0000_0000, mon), (100_0000_0000, mon), (101_0000_0000, mon + 3600)];
        assert!(realized_vol(&noisy).is_some());
    }

    #[test]
    fn genesis_round_normalization() {
        assert_eq!(normalize_answer(360_0000_0000), 360_0000_0000);
        assert_eq!(normalize_answer(360 * WAD), 360_0000_0000);
    }
}
