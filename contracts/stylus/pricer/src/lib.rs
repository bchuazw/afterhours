//! AfterHours Pricer — Arbitrum Stylus (Rust) contract.
//!
//! Quotes fully collateralized European puts on Robinhood Chain Stock Tokens entirely onchain:
//!   1. reads the underlying's Chainlink feed and walks `lookback` historical rounds,
//!   2. derives annualized realized volatility over open-market time,
//!   3. charges closed-market (weekend) seconds at `closedVolMult` x vol, because Stock Tokens keep
//!      trading onchain while the 24/5 feed is frozen,
//!   4. returns a Black-Scholes premium plus the writer spread.
//!
//! Solidity ABI (see `IPricer.sol`):
//!   quotePut(address feed, uint256 strike, uint256 expiry, uint32 lookback, uint64 volFloor,
//!            uint64 volCap, uint64 closedVolMult, uint16 spreadBps)
//!     returns (uint256 premium, uint256 spot, uint256 vol, uint256 closedSeconds)

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
/// Premium never quotes below this fraction of spot (bps), so deep-OTM protection is never free.
const MIN_PREMIUM_BPS: i128 = 5;

sol_storage! {
    #[entrypoint]
    pub struct Pricer {}
}

struct Round {
    round_id: U256,
    answer: i128,
    updated_at: u64,
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
        if expiry <= now {
            return Err(b"expired".to_vec());
        }
        let strike: i128 = strike.try_into().map_err(|_| b"strike overflow".to_vec())?;
        if strike <= 0 {
            return Err(b"zero strike".to_vec());
        }

        let latest = self.latest_round(feed)?;
        let spot = math::normalize_answer(latest.answer);
        if spot <= 0 {
            return Err(b"bad spot".to_vec());
        }

        let rounds = self.history(feed, &latest, lookback)?;
        let mut vol = math::realized_vol(&rounds).unwrap_or(vol_floor as i128);
        vol = vol.clamp(vol_floor as i128, vol_cap.max(vol_floor) as i128);

        let t = expiry - now;
        let closed = math::closed_seconds(now, expiry);
        let fair = math::put_premium(spot, strike, vol, t, closed, closed_vol_mult as i128);
        let mut premium = fair * (10_000 + spread_bps as i128) / 10_000;
        let min_premium = spot * MIN_PREMIUM_BPS / 10_000;
        if premium < min_premium {
            premium = min_premium;
        }

        Ok((
            U256::from(premium as u128),
            U256::from(spot as u128),
            U256::from(vol as u128),
            U256::from(closed),
        ))
    }

    /// Annualized realized vol (1e18 = 100%) of `feed` over the last `lookback` rounds, measured
    /// over open-market seconds. Returns 0 when there is not enough history.
    pub fn realized_vol(&self, feed: Address, lookback: u32) -> Result<U256, Vec<u8>> {
        let latest = self.latest_round(feed)?;
        let rounds = self.history(feed, &latest, lookback)?;
        Ok(U256::from(math::realized_vol(&rounds).unwrap_or(0) as u128))
    }

    /// Seconds of closed market (Sat/Sun UTC, i.e. Fri 20:00 ET -> Sun 20:00 ET) in [from, to).
    pub fn closed_seconds(&self, from: U256, to: U256) -> Result<U256, Vec<u8>> {
        let from: u64 = from.try_into().map_err(|_| b"from overflow".to_vec())?;
        let to: u64 = to.try_into().map_err(|_| b"to overflow".to_vec())?;
        Ok(U256::from(math::closed_seconds(from, to)))
    }

    /// Pure Black-Scholes put helper exposed for UIs and audits.
    pub fn put_premium(
        &self,
        spot: U256,
        strike: U256,
        vol: U256,
        t_seconds: U256,
        closed_secs: U256,
        closed_mult: U256,
    ) -> Result<U256, Vec<u8>> {
        let conv = |v: U256| -> Result<i128, Vec<u8>> { v.try_into().map_err(|_| b"overflow".to_vec()) };
        let p = math::put_premium(
            conv(spot)?,
            conv(strike)?,
            conv(vol)?,
            conv(t_seconds)? as u64,
            conv(closed_secs)? as u64,
            conv(closed_mult)?,
        );
        Ok(U256::from(p.max(0) as u128))
    }

    pub fn version(&self) -> u32 {
        1
    }
}

impl Pricer {
    fn static_call(&self, to: Address, data: &[u8]) -> Result<Vec<u8>, Vec<u8>> {
        // SAFETY: static call, no state mutation possible on our side.
        unsafe { RawCall::new_static(self.vm()).call(to, data) }.map_err(|_| b"feed call failed".to_vec())
    }

    fn decode_round(out: &[u8]) -> Result<Round, Vec<u8>> {
        if out.len() < 160 {
            return Err(b"short round data".to_vec());
        }
        let round_id = U256::from_be_slice(&out[0..32]);
        let raw_answer = U256::from_be_slice(&out[32..64]);
        // Negative answers (top bit set) are invalid for a price; surface as 0 so callers skip them.
        let answer: i128 = if raw_answer.bit(255) {
            0
        } else {
            raw_answer.try_into().unwrap_or(0)
        };
        let updated_at: u64 = U256::from_be_slice(&out[96..128]).try_into().unwrap_or(0);
        Ok(Round { round_id, answer, updated_at })
    }

    fn latest_round(&self, feed: Address) -> Result<Round, Vec<u8>> {
        let out = self.static_call(feed, &SEL_LATEST_ROUND_DATA)?;
        let r = Self::decode_round(&out)?;
        if r.answer <= 0 || r.updated_at == 0 {
            return Err(b"invalid latest round".to_vec());
        }
        Ok(r)
    }

    /// Walk back `lookback` rounds (stopping at a phase boundary / missing round) and return
    /// (price, timestamp) pairs oldest -> newest, newest being `latest`.
    fn history(&self, feed: Address, latest: &Round, lookback: u32) -> Result<Vec<(i128, u64)>, Vec<u8>> {
        let lookback = lookback.min(MAX_LOOKBACK);
        let mut rounds: Vec<(i128, u64)> = Vec::with_capacity(lookback as usize + 1);
        rounds.push((math::normalize_answer(latest.answer), latest.updated_at));
        let mut calldata = [0u8; 36];
        calldata[..4].copy_from_slice(&SEL_GET_ROUND_DATA);
        for i in 1..=lookback {
            let id = latest.round_id.checked_sub(U256::from(i));
            let Some(id) = id else { break };
            if id.is_zero() {
                break;
            }
            calldata[4..].copy_from_slice(&id.to_be_bytes::<32>());
            let Ok(out) = self.static_call(feed, &calldata) else { break };
            let Ok(r) = Self::decode_round(&out) else { break };
            if r.updated_at == 0 {
                break;
            }
            if r.answer > 0 {
                rounds.push((math::normalize_answer(r.answer), r.updated_at));
            }
        }
        rounds.reverse();
        Ok(rounds)
    }
}
