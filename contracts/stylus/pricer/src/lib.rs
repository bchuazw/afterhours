//! AfterHours Pricer — Arbitrum Stylus (Rust) contract.
//!
//! Quotes fully collateralized European puts on Robinhood Chain Stock Tokens entirely onchain:
//!   1. reads the underlying's Chainlink feed and walks up to `lookback` historical rounds inside
//!      the current phase, skipping invalid answers,
//!   2. derives annualized realized volatility over open-market time,
//!   3. charges closed-market seconds (Sat 00:00 -> Mon 01:00 UTC, the union of the feed's dark
//!      window under EDT and EST) at `closedVolMult` x vol, because Stock Tokens keep trading
//!      onchain while the 24/5 feed is frozen,
//!   4. measures variance from the last observed print (not from `now`) to expiry, extending an
//!      expiry that falls inside the closed window to the next open,
//!   5. returns a Black-Scholes premium plus the writer spread, floored at 5 bps of spot and
//!      capped at the strike.
//!
//! Solidity ABI (see `IPricer.sol`):
//!   quotePut(address feed, uint256 strike, uint256 expiry, uint32 lookback, uint64 volFloor,
//!            uint64 volCap, uint64 closedVolMult, uint16 spreadBps)
//!     returns (uint256 premium, uint256 spot, uint256 vol, uint256 closedSeconds)
//!   `closedSeconds` covers the priced horizon: last print -> effective expiry.
//!
//! Reverts carry a short ASCII reason (e.g. `expired`, `zero strike`, `strike above 100x spot`,
//! `invalid latest round`, `tenor too long`).

#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
#![cfg_attr(not(any(test, feature = "export-abi")), no_std)]
extern crate alloc;

pub mod math;

use alloc::{vec, vec::Vec};
use stylus_sdk::{
    alloy_primitives::{Address, U256},
    call::RawCall,
    prelude::*,
};

const SEL_LATEST_ROUND_DATA: [u8; 4] = [0xfe, 0xaf, 0x96, 0x8c];
const SEL_GET_ROUND_DATA: [u8; 4] = [0x9a, 0x6f, 0xc8, 0xf5];
const MAX_LOOKBACK: u32 = 240;

sol_storage! {
    #[entrypoint]
    pub struct Pricer {}
}

/// One decoded `(roundId, answer, startedAt, updatedAt, answeredInRound)` tuple.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Round {
    pub round_id: U256,
    /// Validated 8-decimal answer, or 0 when the raw answer is not a usable price.
    pub answer: i128,
    pub updated_at: u64,
}

#[public]
impl Pricer {
    /// Quote a put. See crate docs for the ABI.
    #[allow(clippy::too_many_arguments)]
    pub fn quote_put(
        &self,
        feed: Address,
        strike: U256,
        expiry: U256,
        lookback: u32,
        vol_floor: u64,
        vol_cap: u64,
        closed_vol_mult: u64,
        spread_bps: u16,
    ) -> Result<(U256, U256, U256, U256), Vec<u8>> {
        let now = self.vm().block_timestamp();
        let expiry: u64 = expiry.try_into().map_err(|_| b"expiry overflow".to_vec())?;
        let strike: i128 = strike.try_into().map_err(|_| b"strike overflow".to_vec())?;

        let latest = self.latest_round(feed)?;
        let spot = latest.answer;
        // Fail fast before the (expensive) history walk.
        math::check_terms(now, spot, strike, expiry).map_err(revert)?;

        let rounds = self.history(feed, &latest, lookback);
        let vol = math::realized_vol(&rounds)
            .unwrap_or(vol_floor as i128)
            .clamp(vol_floor as i128, vol_cap.max(vol_floor) as i128);

        let q = math::quote_put(now, spot, latest.updated_at, strike, expiry, vol, closed_vol_mult as i128, spread_bps)
            .map_err(revert)?;

        Ok((
            U256::from(q.premium as u128),
            U256::from(spot as u128),
            U256::from(vol as u128),
            U256::from(q.closed_secs),
        ))
    }

    /// Annualized realized vol (1e18 = 100%) of `feed` over the last `lookback` rounds, measured
    /// over open-market seconds. Returns 0 when there is not enough history.
    pub fn realized_vol(&self, feed: Address, lookback: u32) -> Result<U256, Vec<u8>> {
        let latest = self.latest_round(feed)?;
        let rounds = self.history(feed, &latest, lookback);
        Ok(U256::from(math::realized_vol(&rounds).unwrap_or(0) as u128))
    }

    /// Seconds of closed market in [from, to): Saturday 00:00 UTC through Monday 01:00 UTC, the
    /// union of Fri 20:00 ET -> Sun 20:00 ET under EDT and EST.
    pub fn closed_seconds(&self, from: U256, to: U256) -> Result<U256, Vec<u8>> {
        let from: u64 = from.try_into().map_err(|_| b"from overflow".to_vec())?;
        let to: u64 = to.try_into().map_err(|_| b"to overflow".to_vec())?;
        Ok(U256::from(math::closed_seconds(from, to)))
    }

    /// Pure Black-Scholes put helper exposed for UIs and audits. Reverts with `out of range`
    /// outside the pricing domain documented on `math::put_premium`.
    pub fn put_premium(
        &self,
        spot: U256,
        strike: U256,
        vol: U256,
        t_seconds: U256,
        closed_secs: U256,
        closed_mult: U256,
    ) -> Result<U256, Vec<u8>> {
        let int = |v: U256| -> Result<i128, Vec<u8>> { v.try_into().map_err(|_| b"overflow".to_vec()) };
        let secs = |v: U256| -> Result<u64, Vec<u8>> { v.try_into().map_err(|_| b"overflow".to_vec()) };
        let p = math::put_premium(int(spot)?, int(strike)?, int(vol)?, secs(t_seconds)?, secs(closed_secs)?, int(closed_mult)?)
            .ok_or_else(|| b"out of range".to_vec())?;
        Ok(U256::from(p as u128))
    }

    pub fn version(&self) -> u32 {
        2
    }
}

impl Pricer {
    fn static_call(&self, to: Address, data: &[u8]) -> Result<Vec<u8>, Vec<u8>> {
        // SAFETY: static call, no state mutation possible on our side.
        unsafe { RawCall::new_static(self.vm()).call(to, data) }.map_err(|_| b"feed call failed".to_vec())
    }

    fn latest_round(&self, feed: Address) -> Result<Round, Vec<u8>> {
        let out = self.static_call(feed, &SEL_LATEST_ROUND_DATA)?;
        let r = decode_round(&out)?;
        if r.answer == 0 || r.updated_at == 0 {
            return Err(b"invalid latest round".to_vec());
        }
        Ok(r)
    }

    /// Up to `lookback` earlier rounds of the latest round's phase, oldest -> newest, ending with
    /// `latest`. See [`walk_history`].
    fn history(&self, feed: Address, latest: &Round, lookback: u32) -> Vec<(i128, u64)> {
        let mut calldata = [0u8; 36];
        calldata[..4].copy_from_slice(&SEL_GET_ROUND_DATA);
        walk_history(latest, lookback, |id| {
            calldata[4..].copy_from_slice(&id.to_be_bytes::<32>());
            let out = self.static_call(feed, &calldata).ok()?;
            decode_round(&out).ok()
        })
    }
}

fn revert(reason: &'static str) -> Vec<u8> {
    reason.as_bytes().to_vec()
}

/// Decode `latestRoundData` / `getRoundData` return data. The int256 answer is kept only when it
/// is a usable 8-decimal price (`0 < answer < 1e14`); negative, zero, oversized and 16-decimal
/// genesis-era answers decode to 0 so callers skip (history) or reject (latest) them. Answers are
/// never rescaled.
pub fn decode_round(out: &[u8]) -> Result<Round, Vec<u8>> {
    if out.len() < 160 {
        return Err(b"short round data".to_vec());
    }
    let round_id = U256::from_be_slice(&out[0..32]);
    // A negative int256 has the top bit set, so it fails the i128 conversion like any oversized value.
    let answer = match i128::try_from(U256::from_be_slice(&out[32..64])) {
        Ok(a) if math::is_valid_price(a) => a,
        _ => 0,
    };
    let updated_at: u64 = U256::from_be_slice(&out[96..128]).try_into().unwrap_or(0);
    Ok(Round { round_id, answer, updated_at })
}

/// Walk back up to `lookback` (capped at 240) rounds from `latest` and return (price, timestamp)
/// pairs oldest -> newest, newest being `latest`.
///
/// Chainlink proxy round ids are `(phaseId << 64) | aggregatorRoundId`. The walk decrements only
/// the aggregator part and stops once it reaches 1, so it never steps into round 0 or into another
/// phase (whose aggregator may have a different scale or history). It also stops when `fetch`
/// fails (call reverted / bad return data) or a round has `updatedAt == 0`. Rounds with an invalid
/// answer (decoded as 0) are skipped but the walk continues past them.
pub fn walk_history(latest: &Round, lookback: u32, mut fetch: impl FnMut(U256) -> Option<Round>) -> Vec<(i128, u64)> {
    let lookback = lookback.min(MAX_LOOKBACK);
    let mut rounds: Vec<(i128, u64)> = Vec::with_capacity(lookback as usize + 1);
    rounds.push((latest.answer, latest.updated_at));
    let mut limbs = *latest.round_id.as_limbs(); // little-endian: limbs[0] = aggregator round id
    for _ in 0..lookback {
        if limbs[0] <= 1 {
            break;
        }
        limbs[0] -= 1;
        let Some(r) = fetch(U256::from_limbs(limbs)) else { break };
        if r.updated_at == 0 {
            break;
        }
        if r.answer > 0 {
            rounds.push((r.answer, r.updated_at));
        }
    }
    rounds.reverse();
    rounds
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::format;

    const PHASE2: u64 = 2;

    fn rid(phase: u64, agg: u64) -> U256 {
        U256::from_limbs([agg, phase, 0, 0])
    }

    fn round(id: U256, answer: i128, updated_at: u64) -> Round {
        Round { round_id: id, answer, updated_at }
    }

    /// ABI-encode (roundId, answer, startedAt, updatedAt, answeredInRound) with a raw int256 answer.
    fn encode(round_id: U256, answer: U256, updated_at: u64) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&round_id.to_be_bytes::<32>());
        out.extend_from_slice(&answer.to_be_bytes::<32>());
        out.extend_from_slice(&U256::from(updated_at).to_be_bytes::<32>());
        out.extend_from_slice(&U256::from(updated_at).to_be_bytes::<32>());
        out.extend_from_slice(&round_id.to_be_bytes::<32>());
        out
    }

    #[test]
    fn decode_rejects_invalid_answers_without_rescaling() {
        let id = rid(PHASE2, 7);
        let ok = decode_round(&encode(id, U256::from(396_4100_0000u64), 1_000)).unwrap();
        assert_eq!(ok, round(id, 396_4100_0000, 1_000));
        // 16-decimal genesis answer for $396.41 must be rejected, not divided down.
        let genesis = decode_round(&encode(id, U256::from(3_964_149_999_900_000_000u64), 1_000)).unwrap();
        assert_eq!(genesis.answer, 0);
        // $1M boundary: 1e14 - 1 is valid, 1e14 is not.
        assert_eq!(decode_round(&encode(id, U256::from(99_999_999_999_999u64), 1)).unwrap().answer, 99_999_999_999_999);
        assert_eq!(decode_round(&encode(id, U256::from(100_000_000_000_000u64), 1)).unwrap().answer, 0);
        // negative int256 (two's complement) and zero
        let minus_one = U256::MAX;
        assert_eq!(decode_round(&encode(id, minus_one, 1)).unwrap().answer, 0);
        assert_eq!(decode_round(&encode(id, U256::ZERO, 1)).unwrap().answer, 0);
        assert_eq!(decode_round(&encode(id, U256::from(u128::MAX), 1)).unwrap().answer, 0);
        // short return data
        assert!(decode_round(&[0u8; 159]).is_err());
        // updatedAt beyond u64 reads as missing
        let mut big = encode(id, U256::from(1u8), 0);
        big[96..128].copy_from_slice(&U256::MAX.to_be_bytes::<32>());
        assert_eq!(decode_round(&big).unwrap().updated_at, 0);
    }

    #[test]
    fn history_stops_at_phase_start() {
        let latest = round(rid(PHASE2, 4), 100_0000_0000, 1_000);
        let mut asked = Vec::new();
        let rounds = walk_history(&latest, 50, |id| {
            asked.push(id);
            let agg = id.as_limbs()[0];
            Some(round(id, 100_0000_0000 + agg as i128, 1_000 - (4 - agg) * 10))
        });
        // agg ids 3, 2, 1 of phase 2 only: never agg 0, never phase 1's last round.
        assert_eq!(asked, vec![rid(PHASE2, 3), rid(PHASE2, 2), rid(PHASE2, 1)]);
        assert_eq!(rounds.len(), 4);
        assert_eq!(rounds[0], (100_0000_0001, 970));
        assert_eq!(rounds[3], (100_0000_0000, 1_000));

        // latest at aggregator round 1: nothing to walk
        let first = round(rid(PHASE2, 1), 100_0000_0000, 1_000);
        let rounds = walk_history(&first, 50, |id| panic!("must not fetch {id}"));
        assert_eq!(rounds, vec![(100_0000_0000, 1_000)]);
    }

    #[test]
    fn history_stops_on_failure_or_missing_round() {
        let latest = round(rid(PHASE2, 100), 100_0000_0000, 10_000);
        // call fails at agg 97
        let rounds = walk_history(&latest, 50, |id| {
            let agg = id.as_limbs()[0];
            (agg > 97).then(|| round(id, 100_0000_0000, agg * 100))
        });
        assert_eq!(rounds.len(), 3);
        // updatedAt == 0 at agg 98
        let rounds = walk_history(&latest, 50, |id| {
            let agg = id.as_limbs()[0];
            Some(round(id, 100_0000_0000, if agg == 98 { 0 } else { agg * 100 }))
        });
        assert_eq!(rounds.len(), 2);
    }

    #[test]
    fn history_skips_invalid_answers_and_caps_lookback() {
        let latest = round(rid(PHASE2, 1_000), 100_0000_0000, 100_000);
        // every third round decoded invalid (answer 0): skipped, walk continues
        let mut calls = 0u32;
        let rounds = walk_history(&latest, 9, |id| {
            calls += 1;
            let agg = id.as_limbs()[0];
            Some(round(id, if agg % 3 == 0 { 0 } else { 100_0000_0000 }, agg * 100))
        });
        assert_eq!(calls, 9);
        assert_eq!(rounds.len(), 1 + 6);
        assert!(rounds.windows(2).all(|w| w[0].1 < w[1].1), "{}", format!("{rounds:?}"));
        // lookback is capped at MAX_LOOKBACK
        let mut calls = 0u32;
        walk_history(&latest, u32::MAX, |id| {
            calls += 1;
            Some(round(id, 100_0000_0000, id.as_limbs()[0] * 100))
        });
        assert_eq!(calls, MAX_LOOKBACK);
    }

    #[test]
    fn history_feeds_realized_vol_with_mainnet_style_ids() {
        // phase 1 ids like 18446744073709552000+ on real feeds; genesis round has a 16-dec answer
        let latest = round(rid(1, 5), 400_0000_0000, 1_789_344_000 + 10 * 3_600);
        let rounds = walk_history(&latest, 10, |id| {
            let agg = id.as_limbs()[0];
            let answer = if agg == 1 { 0 } else { 396_0000_0000 + agg as i128 * 1_0000_0000 };
            Some(round(id, answer, 1_789_344_000 + (5 + agg) * 3_600))
        });
        assert_eq!(rounds.len(), 4); // agg 2, 3, 4 + latest; agg 1 (invalid) skipped
        assert!(math::realized_vol(&rounds).is_some());
    }
}
