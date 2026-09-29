//! Fixed-point option math (WAD = 1e18), `no_std`, i128 throughout.
//!
//! Everything here is pure so it can be unit-tested natively and reused by the Stylus entrypoint.
//! Prices are passed in the feed's own units (8 decimals on Robinhood Chain); volatilities and
//! multipliers are WAD-scaled (1e18 = 100% / 1.0x).
//!
//! Overflow audit (i128::MAX ~ 1.7e38). [`put_premium`] only prices inside an explicit domain:
//! `0 < spot < MAX_PRICE (1e14)`, `0 < strike <= 100 * spot (< 1e16)`, `0 <= vol <= MAX_VOL
//! (1e20)`, `0 <= closed_mult <= MAX_CLOSED_MULT (1e20)`, `t <= MAX_TENOR (3.2e8 s)`. Inside it
//! the largest intermediates are:
//!   - `closed_mult^2 / WAD <= 1e22`, effective WAD-seconds `<= 1e22 * 3.2e8 = 3.2e30`;
//!   - `sigma^2 * T <= 1e22 * 1e23 / WAD = 1e27`, then clamped to `VAR_CAP = 1.6e21`;
//!   - `spot * WAD < 1e32` (log-moneyness argument), `strike * N(.) < 1e34` (premium numerator);
//!   - `d1 = (ln(S/K) + var/2) / sqrt(var)` with numerator `< 8.4e20`, computed by [`div_wad`]
//!     without ever forming `numerator * WAD`, so `|d1| * WAD < 1e38`.
//!
//! [`mul_wad`] and [`div_wad`] split their operands so no intermediate is larger than the result
//! plus 1e36, and the release profile keeps overflow checks on as a second line of defense (an
//! unexpected overflow reverts instead of wrapping into a wrong price).

pub const WAD: i128 = 1_000_000_000_000_000_000;
pub const LN2: i128 = 693_147_180_559_945_309; // ln 2
pub const INV_SQRT_2PI: i128 = 398_942_280_401_432_678; // 1 / sqrt(2*pi)
pub const SECONDS_PER_YEAR: i128 = 31_536_000;
pub const HOUR: u64 = 3_600;
pub const DAY: u64 = 86_400;
pub const WEEK: u64 = 7 * DAY;

/// Offset of Saturday 00:00 UTC inside an epoch-aligned week. Unix weeks start on a Thursday
/// (1970-01-01), so Saturday begins two days in.
const CLOSED_START: u64 = 2 * DAY;
/// Weekly closed window: Saturday 00:00 UTC -> Monday 01:00 UTC (49 hours). This is the union of
/// the feed's dark period (Fri 20:00 ET -> Sun 20:00 ET) under both EDT and EST.
pub const CLOSED_PER_WEEK: u64 = 2 * DAY + HOUR;

/// Feed answers at or above this are invalid: 1e14 in 8 decimals is $1,000,000 per token. Early
/// mainnet rounds carry 16-decimal-scaled answers (e.g. 3_964_149_999_900_000_000 for $396.41);
/// they are rejected, never rescaled.
pub const MAX_PRICE: i128 = 100_000_000_000_000;
/// Strikes above this multiple of spot are rejected (the put is pure intrinsic value there).
pub const MAX_STRIKE_MULT: i128 = 100;
/// Largest annualized vol [`put_premium`] accepts (10,000%). `quotePut` passes u64 values, <= 18.4e18.
pub const MAX_VOL: i128 = 100 * WAD;
/// Largest closed-market vol multiplier [`put_premium`] accepts (100x).
pub const MAX_CLOSED_MULT: i128 = 100 * WAD;
/// Longest variance horizon priced (about 10 years, including any staleness of the last print).
pub const MAX_TENOR: u64 = 3_650 * DAY;
/// Total variance `sigma^2 * T` is clamped here (sigma * sqrt(T) = 40). With |ln(S/K)| < 33 inside
/// the domain, both |d1| and |d2| exceed 19 at the cap, where the normal CDF is saturated and the
/// put already equals the strike, so the clamp never changes a price.
pub const VAR_CAP: i128 = 1_600 * WAD;
/// Premium never quotes below this fraction of spot (bps), so deep-OTM protection is never free.
pub const MIN_PREMIUM_BPS: i128 = 5;
/// Largest exponent [`exp_wad`] evaluates: e^46 * 1e18 ~ 9.5e37 still fits in i128.
const EXP_MAX: i128 = 46 * WAD;

/// a * b / WAD. Operands are split as `a = a1*WAD + a0`, `b = b1*WAD + b0`, so no intermediate is
/// larger than the result plus 1e36: it cannot overflow whenever the result itself fits.
#[inline]
pub fn mul_wad(a: i128, b: i128) -> i128 {
    let (a1, a0) = (a / WAD, a % WAD);
    let (b1, b0) = (b / WAD, b % WAD);
    a1 * b1 * WAD + a1 * b0 + a0 * b1 + a0 * b0 / WAD
}

/// a * WAD / b, computed as `(a / b) * WAD + (a % b) * WAD / b` so `a * WAD` is never formed.
/// Requires |b| < 1.7e20 and |a / b| < 1.7e20.
#[inline]
pub fn div_wad(a: i128, b: i128) -> i128 {
    (a / b) * WAD + (a % b) * WAD / b
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
///
/// `x * WAD` only fits in u128 for x <= u128::MAX / WAD (~3.4e20). Above that the scale is reduced
/// in steps of 100 (`sqrt(x * 1e18) = sqrt(x * 10^2k) * 10^(9-k)`), so the result never wraps and
/// its floor error stays below `10^(9-k)` units (at most 1e9 for i128::MAX, relative error < 1e-10).
pub fn sqrt_wad(x: i128) -> i128 {
    if x <= 0 {
        return 0;
    }
    let x = x as u128;
    let mut scale = WAD as u128;
    let mut post = 1u128;
    while x > u128::MAX / scale {
        scale /= 100;
        post *= 10;
    }
    (isqrt(x * scale) * post) as i128
}

/// Natural log of a WAD number, result in WAD. `None` for x <= 0 (undefined), so callers can
/// never spin in the normalization loops or silently price a garbage log.
pub fn ln_wad(x: i128) -> Option<i128> {
    if x <= 0 {
        return None;
    }
    // Normalize to m in [1, 2) WAD. Both loops are bounded because 1 <= x < 2^127:
    // at most 67 halvings and 60 doublings.
    let mut m = x;
    let mut k: i128 = 0;
    while m >= 2 * WAD {
        m >>= 1;
        k += 1;
    }
    while m < WAD {
        m <<= 1;
        k -= 1;
    }
    // m in [1, 2): ln(m) = 2 * atanh(z), z = (m-1)/(m+1) in [0, 1/3)
    let z = (m - WAD) * WAD / (m + WAD);
    let z2 = mul_wad(z, z);
    let mut term = z;
    let mut sum = 0i128;
    let mut i = 1i128;
    while i <= 39 {
        sum += term / i;
        term = mul_wad(term, z2);
        if term == 0 {
            break;
        }
        i += 2;
    }
    Some(2 * sum + k * LN2)
}

/// e^x for WAD x. Returns 0 below -60 and saturates at e^46 above +46 (the largest power whose
/// WAD value fits in i128).
pub fn exp_wad(x: i128) -> i128 {
    if x < -60 * WAD {
        return 0;
    }
    let x = x.min(EXP_MAX);
    let k = x.div_euclid(LN2); // [-87, 66]
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
    // sum < 2 WAD, so sum << 66 < 1.5e38.
    if k >= 0 {
        sum << (k as u32)
    } else {
        sum >> ((-k) as u32)
    }
}

/// Standard normal CDF (Abramowitz & Stegun 26.2.17, |err| < 7.5e-8), WAD in / WAD out, in [0, WAD].
pub fn norm_cdf_wad(x: i128) -> i128 {
    const P: i128 = 231_641_900_000_000_000;
    const B1: i128 = 319_381_530_000_000_000;
    const B2: i128 = -356_563_782_000_000_000;
    const B3: i128 = 1_781_477_937_000_000_000;
    const B4: i128 = -1_821_255_978_000_000_000;
    const B5: i128 = 1_330_274_429_000_000_000;

    if x > 8 * WAD {
        return WAD;
    }
    if x < -8 * WAD {
        return 0;
    }
    let ax = x.abs();
    let t = div_wad(WAD, WAD + mul_wad(P, ax));
    let poly = mul_wad(t, B1 + mul_wad(t, B2 + mul_wad(t, B3 + mul_wad(t, B4 + mul_wad(t, B5)))));
    let phi = mul_wad(exp_wad(-mul_wad(ax, ax) / 2), INV_SQRT_2PI);
    let n = (WAD - mul_wad(phi, poly)).clamp(0, WAD);
    if x >= 0 {
        n
    } else {
        WAD - n
    }
}

/// True for a usable 8-decimal feed answer: positive and below $1M (see [`MAX_PRICE`]).
#[inline]
pub fn is_valid_price(p: i128) -> bool {
    p > 0 && p < MAX_PRICE
}

/// Closed-market seconds in [0, t).
fn closed_before(t: u64) -> u64 {
    let into_week = t % WEEK;
    (t / WEEK) * CLOSED_PER_WEEK + into_week.saturating_sub(CLOSED_START).min(CLOSED_PER_WEEK)
}

/// True if `t` falls inside the weekly closed window [Sat 00:00 UTC, Mon 01:00 UTC).
pub fn is_closed(t: u64) -> bool {
    let into_week = t % WEEK;
    (CLOSED_START..CLOSED_START + CLOSED_PER_WEEK).contains(&into_week)
}

/// Seconds in [from, to) that fall in the closed window, Saturday 00:00 UTC to Monday 01:00 UTC.
///
/// Robinhood tokenized-equity feeds publish 24/5 and go dark from Friday 20:00 ET to Sunday
/// 20:00 ET: Sat 00:00 -> Mon 00:00 UTC under EDT, Sat 01:00 -> Mon 01:00 UTC under EST. The
/// window is the conservative union of both, so it is right on either side of a DST switch.
/// Onchain Stock Tokens keep trading through that window with a frozen oracle; this is the gap
/// AfterHours prices. O(1) for any range.
pub fn closed_seconds(from: u64, to: u64) -> u64 {
    if to <= from {
        return 0;
    }
    closed_before(to) - closed_before(from)
}

/// Pricing horizon end for `expiry`: an expiry inside the closed window cannot see a print before
/// the next open (Monday 01:00 UTC), so the dark period through that open is priced as well.
pub fn effective_expiry(expiry: u64) -> u64 {
    if is_closed(expiry) {
        let week_start = expiry - expiry % WEEK;
        week_start.saturating_add(CLOSED_START + CLOSED_PER_WEEK)
    } else {
        expiry
    }
}

/// Annualized realized volatility (WAD) from (price, timestamp) rounds sorted oldest -> newest.
/// Log returns are squared and summed, then annualized over *open-market* seconds so weekend
/// freezes do not dilute the estimate. Invalid prices (outside (0, MAX_PRICE)) and non-increasing
/// timestamps are skipped. Returns `None` with fewer than 2 usable rounds.
pub fn realized_vol(rounds: &[(i128, u64)]) -> Option<i128> {
    let mut sum_r2 = 0i128;
    let mut prev: Option<(i128, u64)> = None;
    let mut first_t = 0u64;
    let mut last_t = 0u64;
    let mut n = 0u32;
    for &(p, t) in rounds {
        if !is_valid_price(p) {
            continue;
        }
        if let Some((pp, pt)) = prev {
            if t <= pt {
                continue;
            }
            // p * WAD < 1e32 and p / pp lies in (1e-14, 1e14): ln is defined and |r| < 33 WAD.
            let r = ln_wad(p * WAD / pp)?;
            sum_r2 = sum_r2.saturating_add(mul_wad(r, r));
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
    let var_annual = sum_r2.saturating_mul(SECONDS_PER_YEAR) / open as i128;
    Some(sqrt_wad(var_annual))
}

/// Total variance sigma^2 * T (WAD) over `t_seconds`, of which `closed_secs` are charged at
/// (vol * closed_mult)^2. Clamped to [`VAR_CAP`]. Caller guarantees the [`put_premium`] domain.
fn total_variance(vol: i128, t_seconds: u64, closed_secs: u64, closed_mult: i128) -> i128 {
    let closed = closed_secs.min(t_seconds) as i128;
    let open = t_seconds as i128 - closed;
    let m2 = mul_wad(closed_mult, closed_mult); // <= 1e22
    let eff_seconds_wad = open * WAD + m2 * closed; // <= 3.2e30, WAD-scaled effective seconds
    let years = eff_seconds_wad / SECONDS_PER_YEAR; // <= 1e23
    mul_wad(mul_wad(vol, vol), years).min(VAR_CAP) // <= 1e27 before the clamp
}

/// Black-Scholes European put (r = 0) per 1 unit of underlying, in price units.
///
/// The variance budget is split into open and closed seconds; closed seconds are scaled by
/// `closed_mult^2` so weekend gap risk is charged explicitly. The result lies in
/// [intrinsic, strike]. Returns `None` outside the supported domain (see the module docs):
/// spot not in (0, MAX_PRICE), strike not in (0, 100 * spot], vol or closed_mult negative or
/// above their caps, or `t_seconds > MAX_TENOR`.
pub fn put_premium(
    spot: i128,
    strike: i128,
    vol: i128,
    t_seconds: u64,
    closed_secs: u64,
    closed_mult: i128,
) -> Option<i128> {
    if !is_valid_price(spot)
        || strike <= 0
        || strike > spot * MAX_STRIKE_MULT
        || !(0..=MAX_VOL).contains(&vol)
        || !(0..=MAX_CLOSED_MULT).contains(&closed_mult)
        || t_seconds > MAX_TENOR
    {
        return None;
    }
    let intrinsic = (strike - spot).max(0);
    let var_t = total_variance(vol, t_seconds, closed_secs, closed_mult);
    let sig_sqrt_t = sqrt_wad(var_t);
    if sig_sqrt_t == 0 {
        return Some(intrinsic);
    }
    // S/K >= 1/100, so the argument is >= 1e16 and the log is always defined.
    let ln_sk = ln_wad(spot * WAD / strike)?;
    let d1 = div_wad(ln_sk + var_t / 2, sig_sqrt_t);
    let d2 = d1 - sig_sqrt_t;
    // One rounding step: strike * N < 1e34 and spot * N < 1e32.
    let put = (strike * norm_cdf_wad(-d2) - spot * norm_cdf_wad(-d1)) / WAD;
    Some(put.max(intrinsic).min(strike))
}

/// Cheap sanity checks shared by the entrypoint (before walking history) and [`quote_put`].
pub fn check_terms(now: u64, spot: i128, strike: i128, expiry: u64) -> Result<(), &'static str> {
    if expiry <= now {
        return Err("expired");
    }
    if strike <= 0 {
        return Err("zero strike");
    }
    if !is_valid_price(spot) {
        return Err("bad spot");
    }
    if strike > spot * MAX_STRIKE_MULT {
        return Err("strike above 100x spot");
    }
    Ok(())
}

/// Output of [`quote_put`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Quote {
    /// Premium per unit of underlying incl. spread, in [min premium, strike], price units.
    pub premium: i128,
    /// Seconds of variance priced: from the last print to the effective expiry.
    pub t_seconds: u64,
    /// Closed-market seconds inside that horizon.
    pub closed_secs: u64,
}

/// Full quote once the feed has been read: horizon, closed time, fair value, spread and floors.
///
/// Variance is measured from the last observed print, not from `now`: a stale spot has already
/// been exposed to every second since it printed. An expiry inside the closed window is priced
/// through to the next open ([`effective_expiry`]).
#[allow(clippy::too_many_arguments)]
pub fn quote_put(
    now: u64,
    spot: i128,
    spot_updated_at: u64,
    strike: i128,
    expiry: u64,
    vol: i128,
    closed_mult: i128,
    spread_bps: u16,
) -> Result<Quote, &'static str> {
    check_terms(now, spot, strike, expiry)?;
    let start = spot_updated_at.min(now);
    let end = effective_expiry(expiry);
    let t_seconds = end - start; // end >= expiry > now >= start
    if t_seconds > MAX_TENOR {
        return Err("tenor too long");
    }
    let closed_secs = closed_seconds(start, end);
    let fair = put_premium(spot, strike, vol, t_seconds, closed_secs, closed_mult).ok_or("pricing out of range")?;
    // fair <= strike < 1e16, so the spread product stays below 1e21.
    let premium =
        (fair * (10_000 + spread_bps as i128) / 10_000).max(spot * MIN_PREMIUM_BPS / 10_000).min(strike);
    Ok(Quote { premium, t_seconds, closed_secs })
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::U256;

    /// 2026-09-14T00:00:00Z, a Monday.
    const MON: u64 = 1_789_344_000;

    fn close(a: i128, b: i128, tol: i128) {
        assert!((a - b).abs() <= tol, "{a} vs {b} (tol {tol})");
    }

    fn put(spot: i128, strike: i128, vol: i128, t: u64, closed: u64, mult: i128) -> i128 {
        put_premium(spot, strike, vol, t, closed, mult).expect("in domain")
    }

    #[test]
    #[should_panic]
    fn overflow_checks_are_enabled() {
        // The property tests below rely on overflow panicking instead of wrapping.
        let x = core::hint::black_box(i128::MAX);
        let _ = core::hint::black_box(x + 1);
    }

    #[test]
    fn ln_exp_sqrt() {
        close(ln_wad(2 * WAD).unwrap(), LN2, 10);
        close(ln_wad(WAD).unwrap(), 0, 1);
        close(ln_wad(WAD / 2).unwrap(), -LN2, 10);
        close(ln_wad(10 * WAD).unwrap(), 2_302_585_092_994_045_684, 100);
        close(exp_wad(WAD), 2_718_281_828_459_045_235, 1_000);
        close(exp_wad(-WAD), 367_879_441_171_442_321, 1_000);
        close(exp_wad(0), WAD, 0);
        assert_eq!(sqrt_wad(4 * WAD), 2 * WAD);
        close(sqrt_wad(2 * WAD), 1_414_213_562_373_095_048, 10);
        // round trip
        for x in [3i128, 7, 123, 999] {
            close(exp_wad(ln_wad(x * WAD).unwrap()), x * WAD, x * 1_000_000); // ~1e-12 relative
        }
    }

    #[test]
    fn ln_rejects_non_positive_and_handles_extremes() {
        assert_eq!(ln_wad(0), None);
        assert_eq!(ln_wad(-1), None);
        assert_eq!(ln_wad(i128::MIN), None);
        // ln(1e-18) = -18 ln 10, ln(i128::MAX / 1e18) = ln(1.7014e20)
        close(ln_wad(1).unwrap(), -41_446_531_673_892_822_312, 1_000_000);
        close(ln_wad(i128::MAX).unwrap(), 46_583_160_257_220_231_984, 1_000_000_000);
        // near 2 (slowest series convergence) is accurate to ~1e-15
        close(ln_wad(2 * WAD - 1).unwrap(), LN2, 1_000);
    }

    #[test]
    fn exp_saturates_without_wrapping() {
        let e46 = exp_wad(46 * WAD);
        assert!(e46 > 0);
        close(e46 / WAD, 94_961_194_206_024_488_745, 1_000_000_000_000); // e^46 ~ 9.4961e19
        assert_eq!(exp_wad(60 * WAD), e46);
        assert_eq!(exp_wad(i128::MAX), e46);
        assert!(exp_wad(45 * WAD) < e46);
        assert_eq!(exp_wad(-61 * WAD), 0);
        assert_eq!(exp_wad(i128::MIN), 0);
    }

    #[test]
    fn wad_mul_div_large_operands() {
        // Old mul_wad formed (a % WAD) * b = 5e17 * 1e23 and overflowed.
        assert_eq!(mul_wad(10_000 * WAD + WAD / 2, 100_000 * WAD), 1_000_050_000 * WAD);
        assert_eq!(mul_wad(-3 * WAD / 2, 2 * WAD), -3 * WAD);
        assert_eq!(mul_wad(-3 * WAD / 2, -3 * WAD / 2), 9 * WAD / 4);
        // Old div_wad formed a * WAD = 8e38 and overflowed.
        assert_eq!(div_wad(800 * WAD, 40 * WAD), 20 * WAD);
        assert_eq!(div_wad(-7 * WAD, 2 * WAD), -7 * WAD / 2);
        assert_eq!(div_wad(WAD, 3), WAD * WAD / 3);
    }

    /// floor(sqrt(x * 1e18)) checked exactly in 256-bit arithmetic: s^2 <= x*1e18 < (s + tol + 1)^2.
    fn assert_sqrt(x: i128, tol: u128) {
        let s = sqrt_wad(x);
        assert!(s >= 0);
        let target = U256::from(x as u128) * U256::from(WAD as u128);
        let lo = U256::from(s as u128);
        let hi = U256::from(s as u128 + tol + 1);
        assert!(lo * lo <= target, "sqrt_wad({x}) = {s} too high");
        assert!(hi * hi > target, "sqrt_wad({x}) = {s} too low");
    }

    #[test]
    fn sqrt_near_and_above_u128_threshold() {
        let threshold = (u128::MAX / WAD as u128) as i128; // ~3.4e20: last x where x * WAD fits
        for x in [1, WAD, threshold - 1, threshold] {
            assert_sqrt(x, 0);
        }
        for x in [threshold + 1, threshold + 1_000, 2 * threshold, 1_000 * WAD, 40_000 * WAD, 10i128.pow(25)] {
            assert_sqrt(x, 1_000);
        }
        for x in [10i128.pow(30), 10i128.pow(35), i128::MAX / 2, i128::MAX] {
            assert_sqrt(x, 1_000_000_000);
        }
        // exact on perfect squares past the threshold; across it the reduced scale may floor up
        // to 9 units (1e-17 relative) lower, never wrapping as `x * WAD` did before
        assert_eq!(sqrt_wad(40_000 * WAD), 200 * WAD);
        assert_eq!(sqrt_wad(1_600 * WAD), 40 * WAD);
        let mut prev = 0;
        for x in [threshold - 1, threshold, threshold + 1, threshold + 2, 2 * threshold, i128::MAX] {
            let s = sqrt_wad(x);
            assert!(s + 9 >= prev, "sqrt_wad not monotone at {x}");
            prev = s;
        }
        assert!(sqrt_wad(threshold + 1) > 18_000_000_000 * WAD / 1_000_000_000); // ~1.84e19, not wrapped
        assert_eq!(sqrt_wad(0), 0);
        assert_eq!(sqrt_wad(-5), 0);
    }

    #[test]
    fn normal_cdf() {
        close(norm_cdf_wad(0), WAD / 2, 100_000_000_000);
        close(norm_cdf_wad(WAD), 841_344_746_068_542_949, 100_000_000_000);
        close(norm_cdf_wad(-WAD), 158_655_253_931_457_051, 100_000_000_000);
        close(norm_cdf_wad(1_959_963_984_540_054_000), 975_000_000_000_000_000, 100_000_000_000);
        assert_eq!(norm_cdf_wad(9 * WAD), WAD);
        assert_eq!(norm_cdf_wad(-9 * WAD), 0);
        assert_eq!(norm_cdf_wad(i128::MAX), WAD);
        assert_eq!(norm_cdf_wad(i128::MIN), 0);
        // monotone on a fine grid
        let mut prev = 0;
        let mut x = -9 * WAD;
        while x <= 9 * WAD {
            let n = norm_cdf_wad(x);
            assert!((0..=WAD).contains(&n) && n >= prev, "cdf not monotone at {x}");
            prev = n;
            x += WAD / 64;
        }
    }

    #[test]
    fn black_scholes_reference_values() {
        // S=100, K=100, sigma=20%, T=1y (no closed time): put = 7.9656
        let p = put(100_0000_0000, 100_0000_0000, WAD / 5, SECONDS_PER_YEAR as u64, 0, WAD);
        close(p, 7_9656_0000, 20_000); // within $0.0002
        // S=100, K=90, sigma=30%, T=0.5y: d1=0.6027, d2=0.3906 -> put = 3.9896
        let p = put(100_0000_0000, 90_0000_0000, 3 * WAD / 10, (SECONDS_PER_YEAR / 2) as u64, 0, WAD);
        close(p, 3_9896_0000, 50_000);
        // Deep ITM floors at intrinsic
        let p = put(50_0000_0000, 100_0000_0000, WAD / 5, 3600, 0, WAD);
        assert!(p >= 50_0000_0000);
        // Zero tenor -> intrinsic
        assert_eq!(put(90_0000_0000, 100_0000_0000, WAD / 5, 0, 0, WAD), 10_0000_0000);
        assert_eq!(put(110_0000_0000, 100_0000_0000, WAD / 5, 0, 0, WAD), 0);
        // Huge variance -> the put is worth exactly the strike (VAR_CAP region)
        assert_eq!(put(100_0000_0000, 100_0000_0000, MAX_VOL, MAX_TENOR, MAX_TENOR, MAX_CLOSED_MULT), 100_0000_0000);
    }

    #[test]
    fn put_domain_is_enforced() {
        let s = 100_0000_0000i128;
        let y = SECONDS_PER_YEAR as u64;
        assert_eq!(put_premium(0, s, WAD, y, 0, WAD), None);
        assert_eq!(put_premium(-1, s, WAD, y, 0, WAD), None);
        assert_eq!(put_premium(MAX_PRICE, s, WAD, y, 0, WAD), None);
        assert_eq!(put_premium(s, 0, WAD, y, 0, WAD), None);
        assert_eq!(put_premium(s, 100 * s + 1, WAD, y, 0, WAD), None);
        assert!(put_premium(s, 100 * s, WAD, y, 0, WAD).is_some());
        assert_eq!(put_premium(s, s, -1, y, 0, WAD), None);
        assert_eq!(put_premium(s, s, MAX_VOL + 1, y, 0, WAD), None);
        assert_eq!(put_premium(s, s, WAD, y, 0, -1), None);
        assert_eq!(put_premium(s, s, WAD, y, 0, MAX_CLOSED_MULT + 1), None);
        assert_eq!(put_premium(s, s, WAD, MAX_TENOR + 1, 0, WAD), None);
        assert_eq!(put_premium(s, s, WAD, u64::MAX, u64::MAX, WAD), None);
        // strike 1 unit with spot near the cap: log-moneyness ~ +32 still prices
        assert_eq!(put_premium(MAX_PRICE - 1, 1, WAD, y, 0, WAD), Some(0));
    }

    #[test]
    fn closed_time_raises_premium() {
        // 3 days, none closed vs 2 of 3 days closed with 1.5x multiplier
        let base = put(360_0000_0000, 340_0000_0000, WAD / 2, 3 * DAY, 0, 3 * WAD / 2);
        let gap = put(360_0000_0000, 340_0000_0000, WAD / 2, 3 * DAY, 2 * DAY, 3 * WAD / 2);
        assert!(gap > base, "{gap} <= {base}");
        // multiplier of exactly 1.0 makes closed time irrelevant
        let same = put(360_0000_0000, 340_0000_0000, WAD / 2, 3 * DAY, 2 * DAY, WAD);
        assert_eq!(same, base);
    }

    /// Spec-level reference: hour by hour, dow = (day + 4) % 7 (0 = Sunday); closed on Saturday,
    /// Sunday, and Monday before 01:00 UTC.
    fn closed_ref(from: u64, to: u64) -> u64 {
        let mut closed = 0;
        let mut t = from;
        while t < to {
            let seg_end = ((t / HOUR + 1) * HOUR).min(to);
            let dow = (t / DAY + 4) % 7;
            let hour = (t % DAY) / HOUR;
            if dow == 6 || dow == 0 || (dow == 1 && hour < 1) {
                closed += seg_end - t;
            }
            t = seg_end;
        }
        closed
    }

    #[test]
    fn weekend_calendar() {
        assert_eq!((MON / DAY + 4) % 7, 1, "anchor must be a Monday");
        let sat = MON + 5 * DAY;
        let next_mon = MON + 7 * DAY;
        assert_eq!(closed_seconds(MON, MON + HOUR), HOUR); // Mon 00:00-01:00 UTC is closed
        assert_eq!(closed_seconds(MON + HOUR, sat), 0); // Mon 01:00 .. Sat 00:00 open
        assert_eq!(closed_seconds(MON, MON + 7 * DAY), CLOSED_PER_WEEK); // full week: 49h
        assert_eq!(closed_seconds(MON, MON + 28 * DAY), 4 * CLOSED_PER_WEEK);
        assert_eq!(closed_seconds(sat + 3600, sat + DAY), DAY - 3600); // inside Saturday
        assert_eq!(closed_seconds(sat, next_mon + 12 * HOUR), CLOSED_PER_WEEK); // Sat -> Mon noon
        assert_eq!(closed_seconds(MON, MON), 0);
        assert_eq!(closed_seconds(MON + 10, MON), 0);
        // O(1) for absurd ranges (no per-day loop), 49h per full week
        let all = closed_seconds(0, u64::MAX);
        let full_weeks = (u64::MAX / WEEK) * CLOSED_PER_WEEK;
        assert!(all >= full_weeks && all <= full_weeks + CLOSED_PER_WEEK);
    }

    #[test]
    fn weekend_calendar_edges() {
        let fri = MON + 4 * DAY;
        let sat = MON + 5 * DAY;
        let next_mon = MON + 7 * DAY;
        // Friday 23:59:59 open, Saturday 00:00:00 closed
        assert!(!is_closed(sat - 1));
        assert!(is_closed(sat));
        assert_eq!(closed_seconds(sat - 1, sat), 0);
        assert_eq!(closed_seconds(sat, sat + 1), 1);
        assert_eq!(closed_seconds(fri + 20 * HOUR, sat + HOUR), HOUR);
        // Monday 00:59:59 closed, 01:00:00 open
        assert!(is_closed(next_mon + HOUR - 1));
        assert!(!is_closed(next_mon + HOUR));
        assert_eq!(closed_seconds(next_mon + HOUR - 1, next_mon + HOUR + 1), 1);
        assert_eq!(closed_seconds(next_mon, next_mon + 2 * HOUR), HOUR);
        assert!(!is_closed(MON + 2 * DAY));
    }

    #[test]
    fn weekend_calendar_dst_edges() {
        // EDT week (Sep): feed dark Fri 20:00 EDT = Sat 00:00Z -> Sun 20:00 EDT = Mon 00:00Z.
        let sat = MON + 5 * DAY;
        assert_eq!(closed_seconds(sat, sat + 2 * DAY), 2 * DAY);
        // Sun 20:00-21:00 EDT (Mon 00:00-01:00Z) is charged too: conservative under EDT.
        assert!(is_closed(sat + 2 * DAY + HOUR - 1));

        // DST ends Sun 2026-11-01: close Fri 20:00 EDT = Sat 2026-10-31 00:00Z,
        // open Sun 20:00 EST = Mon 2026-11-02 01:00Z. The window matches the dark period exactly.
        let close_oct31 = 1_793_404_800u64;
        let open_nov2 = 1_793_581_200u64;
        assert_eq!((close_oct31 / DAY + 4) % 7, 6);
        assert_eq!(closed_seconds(close_oct31, open_nov2), open_nov2 - close_oct31);
        assert_eq!(open_nov2 - close_oct31, 49 * HOUR);
        assert!(!is_closed(close_oct31 - 1) && is_closed(close_oct31));
        assert!(is_closed(open_nov2 - 1) && !is_closed(open_nov2));

        // EST week: close Fri 20:00 EST = Sat 2026-11-07 01:00Z, open Mon 2026-11-09 01:00Z.
        // Fri 19:00-20:00 EST (Sat 00:00-01:00Z) is charged too: conservative under EST.
        let sat_nov7 = 1_794_009_600u64;
        let close_nov7 = 1_794_013_200u64;
        let open_nov9 = 1_794_186_000u64;
        assert_eq!(closed_seconds(close_nov7, open_nov9), open_nov9 - close_nov7); // 48h fully dark
        assert_eq!(closed_seconds(sat_nov7, open_nov9), 49 * HOUR);
        assert!(is_closed(sat_nov7));

        // DST starts Sun 2027-03-14: close Fri 20:00 EST = Sat 2027-03-13 01:00Z,
        // open Sun 20:00 EDT = Mon 2027-03-15 00:00Z (47h dark), all inside the window.
        let sat_mar13 = 1_804_896_000u64;
        let close_mar13 = 1_804_899_600u64;
        let open_mar15 = 1_805_068_800u64;
        assert_eq!((sat_mar13 / DAY + 4) % 7, 6);
        assert_eq!(closed_seconds(close_mar13, open_mar15), 47 * HOUR);
        assert_eq!(closed_seconds(sat_mar13, open_mar15 + HOUR), 49 * HOUR);
    }

    #[test]
    fn weekend_calendar_matches_reference() {
        let mut seed = 0x243f_6a88_85a3_08d3u64;
        let mut next = || {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            seed >> 33
        };
        for _ in 0..3_000 {
            let from = MON - 3 * DAY + next() % (21 * DAY);
            let to = from + next() % (22 * DAY);
            assert_eq!(closed_seconds(from, to), closed_ref(from, to), "[{from}, {to})");
        }
        // every hour boundary (and 1s either side) across two weeks
        for h in 0..(14 * 24) {
            let t = MON - 2 * DAY + h * HOUR;
            for (a, b) in [(t - 1, t + 1), (t, t + HOUR), (t - 1, t + 3 * DAY + 7)] {
                assert_eq!(closed_seconds(a, b), closed_ref(a, b), "[{a}, {b})");
                assert_eq!(is_closed(a), closed_ref(a, a + 1) == 1, "is_closed({a})");
            }
        }
    }

    #[test]
    fn expiry_inside_closed_window_extends_to_next_open() {
        let sat = MON + 5 * DAY;
        let next_open = MON + 7 * DAY + HOUR;
        assert_eq!(effective_expiry(sat - 1), sat - 1); // Friday 23:59:59 stays
        assert_eq!(effective_expiry(sat), next_open);
        assert_eq!(effective_expiry(sat + 30 * HOUR), next_open);
        assert_eq!(effective_expiry(next_open - 1), next_open);
        assert_eq!(effective_expiry(next_open), next_open);
        assert_eq!(effective_expiry(MON + 2 * DAY), MON + 2 * DAY);
        // near the top of the range the extension saturates instead of overflowing
        let top_sat = u64::MAX - u64::MAX % WEEK - WEEK + CLOSED_START;
        assert!(is_closed(top_sat));
        assert_eq!(effective_expiry(top_sat), top_sat + CLOSED_PER_WEEK);
        assert_eq!(effective_expiry(u64::MAX), u64::MAX);
        // across many weeks the extension lands on an open Monday 01:00Z
        for w in 0..60u64 {
            let e = effective_expiry(sat + w * WEEK + 12 * HOUR);
            assert!(!is_closed(e) && is_closed(e - 1));
            assert_eq!((e / DAY + 4) % 7, 1);
            assert_eq!(e % DAY, HOUR);
        }
    }

    #[test]
    fn realized_vol_from_rounds() {
        // 1% moves every hour for 48 hours on weekdays -> sigma ~ 1% * sqrt(8760) ~ 93.6%
        let start = MON + HOUR; // Monday 01:00Z, after the closed window
        let mut rounds = Vec::new();
        let mut p = 100_0000_0000i128;
        for i in 0..48u64 {
            p = if i % 2 == 0 { p * 101 / 100 } else { p * 100 / 101 };
            rounds.push((p, start + i * 3600));
        }
        let v = realized_vol(&rounds).unwrap();
        close(v, 936_000_000_000_000_000, 20_000_000_000_000_000);
        assert!(realized_vol(&rounds[..1]).is_none());
        assert!(realized_vol(&[]).is_none());
        // duplicate timestamps and bad prices are ignored, not fatal
        let t = MON + 2 * HOUR;
        let noisy = [(0i128, t), (100_0000_0000, t), (100_0000_0000, t), (101_0000_0000, t + 3600)];
        assert!(realized_vol(&noisy).is_some());
    }

    #[test]
    fn realized_vol_skips_invalid_answers() {
        let t0 = MON + 2 * HOUR;
        let clean = [(396_4100_0000i128, t0), (400_0000_0000, t0 + HOUR), (398_0000_0000, t0 + 2 * HOUR)];
        let v = realized_vol(&clean).unwrap();
        // 16-decimal genesis answer ($396.41 scaled by 1e8 too much), negative and zero are skipped
        let dirty = [
            (3_964_149_999_900_000_000i128, t0 - HOUR),
            (396_4100_0000, t0),
            (-5, t0 + 30 * 60),
            (400_0000_0000, t0 + HOUR),
            (MAX_PRICE, t0 + 90 * 60),
            (0, t0 + 100 * 60),
            (398_0000_0000, t0 + 2 * HOUR),
        ];
        assert_eq!(realized_vol(&dirty), Some(v));
        // extreme but valid moves (1 unit -> $999,999) stay finite
        let wild = [(1i128, t0), (MAX_PRICE - 1, t0 + 1), (1, t0 + 2)];
        let v = realized_vol(&wild).unwrap();
        assert!(v > 0);
    }

    #[test]
    fn put_properties_over_extreme_grid() {
        let spots: [i128; 9] = [1, 100, 1_000_000, 1_0000_0000, 360_0000_0000, 1e11 as i128, 1e12 as i128, 1e13 as i128, MAX_PRICE - 1];
        // strike as bps of spot, up to 100x
        let strike_bps: [i128; 19] = [
            1, 10, 100, 1_000, 5_000, 8_000, 9_000, 9_500, 9_900, 10_000, 10_100, 10_500, 11_000, 12_000, 15_000, 20_000,
            50_000, 100_000, 1_000_000,
        ];
        let vols: [i128; 12] = [
            0, WAD / 1_000, WAD / 20, WAD / 5, WAD / 2, WAD, 2 * WAD, 3 * WAD, 5 * WAD, 10 * WAD, u64::MAX as i128, MAX_VOL,
        ];
        let tenors: [u64; 9] = [0, 1, 60, HOUR, DAY, 3 * DAY, 7 * DAY, 30 * DAY, 90 * DAY];
        let mults: [i128; 5] = [0, WAD, 3 * WAD / 2, 5 * WAD, u64::MAX as i128];
        let mut evaluated = 0u32;
        for &spot in &spots {
            let mut strikes: Vec<i128> = strike_bps.iter().map(|b| spot * b / 10_000).filter(|&k| k > 0).collect();
            strikes.dedup();
            for &t in &tenors {
                for closed in [0, t / 3, t] {
                    for &mult in &mults {
                        // monotone in strike (vol fixed) and in vol (strike fixed)
                        let mut by_vol = vec![0i128; strikes.len()];
                        for &vol in &vols {
                            let mut prev_k = 0i128;
                            for (j, &strike) in strikes.iter().enumerate() {
                                let p = put_premium(spot, strike, vol, t, closed, mult)
                                    .unwrap_or_else(|| panic!("none: S={spot} K={strike} v={vol} t={t} c={closed} m={mult}"));
                                let intrinsic = (strike - spot).max(0);
                                let ctx = || format!("S={spot} K={strike} v={vol} t={t} c={closed} m={mult} p={p}");
                                assert!(p >= intrinsic, "below intrinsic: {}", ctx());
                                assert!(p <= strike, "above strike: {}", ctx());
                                assert!(p >= prev_k, "not monotone in strike: {} prev={prev_k}", ctx());
                                assert!(p >= by_vol[j], "not monotone in vol: {} prev={}", ctx(), by_vol[j]);
                                prev_k = p;
                                by_vol[j] = p;
                                evaluated += 1;
                            }
                        }
                    }
                }
            }
        }
        assert!(evaluated > 100_000, "{evaluated}");
    }

    #[test]
    fn put_monotone_in_horizon_and_closed_charge() {
        let (s, k) = (360_0000_0000i128, 340_0000_0000i128);
        for vol in [WAD / 10, WAD / 2, 2 * WAD, 10 * WAD] {
            let mut prev = 0;
            let mut t = 0u64;
            while t <= 90 * DAY {
                let p = put(s, k, vol, t, t / 3, 5 * WAD);
                assert!(p >= prev, "not monotone in t at {t}");
                prev = p;
                t += 6 * HOUR + 17;
            }
            let mut prev = 0;
            for mult in [0, WAD / 2, WAD, 3 * WAD / 2, 2 * WAD, 5 * WAD] {
                let p = put(s, k, vol, 7 * DAY, 2 * DAY, mult);
                assert!(p >= prev, "not monotone in closed_mult at {mult}");
                prev = p;
            }
        }
    }

    #[test]
    fn quote_measures_variance_from_last_print() {
        let now = MON + 2 * DAY; // Wednesday 00:00Z
        let expiry = now + 2 * DAY; // Friday 00:00Z, open
        let (s, k, v) = (360_0000_0000i128, 340_0000_0000i128, WAD / 2);
        let fresh = quote_put(now, s, now, k, expiry, v, 2 * WAD, 0).unwrap();
        assert_eq!(fresh.t_seconds, 2 * DAY);
        assert_eq!(fresh.closed_secs, 0);
        // A print from Friday 16:00Z last week, priced on Wednesday: includes the whole weekend.
        let stale_at = MON - 3 * DAY + 16 * HOUR;
        let stale = quote_put(now, s, stale_at, k, expiry, v, 2 * WAD, 0).unwrap();
        assert_eq!(stale.t_seconds, expiry - stale_at);
        assert_eq!(stale.closed_secs, CLOSED_PER_WEEK);
        assert!(stale.premium > fresh.premium);
        // A print stamped in the future never shortens the horizon below now -> expiry.
        let future = quote_put(now, s, now + HOUR, k, expiry, v, 2 * WAD, 0).unwrap();
        assert_eq!(future, fresh);
    }

    #[test]
    fn quote_prices_closed_expiry_through_next_open() {
        let now = MON + 3 * DAY; // Thursday 00:00Z
        let sat_noon = MON + 5 * DAY + 12 * HOUR;
        let next_open = MON + 7 * DAY + HOUR;
        let (s, k, v) = (360_0000_0000i128, 350_0000_0000i128, WAD / 2);
        let inside = quote_put(now, s, now, k, sat_noon, v, 2 * WAD, 100).unwrap();
        let at_open = quote_put(now, s, now, k, next_open, v, 2 * WAD, 100).unwrap();
        assert_eq!(inside, at_open);
        assert_eq!(inside.t_seconds, next_open - now);
        assert_eq!(inside.closed_secs, CLOSED_PER_WEEK);
        let before_close = quote_put(now, s, now, k, MON + 5 * DAY - 1, v, 2 * WAD, 100).unwrap();
        assert!(inside.premium > before_close.premium);
        assert_eq!(before_close.closed_secs, 0);
    }

    #[test]
    fn quote_rejects_bad_terms() {
        let now = MON + 2 * DAY;
        let exp = now + DAY;
        let s = 360_0000_0000i128;
        assert_eq!(quote_put(now, s, now, s, now, WAD, WAD, 0), Err("expired"));
        assert_eq!(quote_put(now, s, now, 0, exp, WAD, WAD, 0), Err("zero strike"));
        assert_eq!(quote_put(now, s, now, -1, exp, WAD, WAD, 0), Err("zero strike"));
        assert_eq!(quote_put(now, 0, now, s, exp, WAD, WAD, 0), Err("bad spot"));
        assert_eq!(quote_put(now, -s, now, s, exp, WAD, WAD, 0), Err("bad spot"));
        assert_eq!(quote_put(now, 3_964_149_999_900_000_000, now, s, exp, WAD, WAD, 0), Err("bad spot"));
        assert_eq!(quote_put(now, s, now, 100 * s + 1, exp, WAD, WAD, 0), Err("strike above 100x spot"));
        assert!(quote_put(now, s, now, 100 * s, exp, WAD, WAD, 0).is_ok());
        assert_eq!(quote_put(now, s, now, s, u64::MAX, WAD, WAD, 0), Err("tenor too long"));
        assert_eq!(quote_put(now, s, 0, s, exp, WAD, WAD, 0), Err("tenor too long")); // print from 1970
        assert_eq!(quote_put(now, s, now, s, exp, MAX_VOL + 1, WAD, 0), Err("pricing out of range"));
    }

    #[test]
    fn quote_premium_floor_and_cap() {
        let now = MON + 2 * DAY;
        let exp = now + DAY;
        let s = 360_0000_0000i128;
        // deep OTM: floored at 5 bps of spot
        let q = quote_put(now, s, now, s / 100, exp, WAD / 10, WAD, 0).unwrap();
        assert_eq!(q.premium, s * MIN_PREMIUM_BPS / 10_000);
        // floor never exceeds the strike (max payout)
        let q = quote_put(now, s, now, 1, exp, WAD / 10, WAD, 0).unwrap();
        assert_eq!(q.premium, 1);
        // deep ITM with the maximum spread is capped at the strike
        let q = quote_put(now, s, now, 100 * s, exp, WAD, WAD, u16::MAX).unwrap();
        assert_eq!(q.premium, 100 * s);
        // spread applies on fair value
        let a = quote_put(now, s, now, s, exp, WAD / 2, WAD, 0).unwrap();
        let b = quote_put(now, s, now, s, exp, WAD / 2, WAD, 1_000).unwrap();
        assert_eq!(b.premium, a.premium * 11_000 / 10_000);
    }
}
