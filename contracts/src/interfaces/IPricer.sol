// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Pricing engine interface. The production implementation is a Stylus (Rust) contract that
///         reads the underlying's Chainlink round history, derives realized volatility, applies a
///         closed-market (weekend) jump surcharge and returns a Black-Scholes put premium.
/// @dev All prices are in the feed's 8-decimal units. Volatilities are annualized, 1e18 = 100%.
interface IPricer {
    /// @param feed          Chainlink-compatible AggregatorV3 for the underlying.
    /// @param strike        Strike price, 8 decimals.
    /// @param expiry        Unix timestamp of expiry.
    /// @param lookback      Number of historical rounds used for realized volatility.
    /// @param volFloor      Minimum annualized vol used (1e18 = 100%).
    /// @param volCap        Maximum annualized vol used.
    /// @param closedVolMult Multiplier applied to vol during closed-market hours (1e18 = 1.0x).
    /// @param spreadBps     Writer spread added on top of fair value, in basis points of fair value.
    /// @return premium      Premium per 1e18 units of underlying, 8 decimals.
    /// @return spot         Spot price used, 8 decimals.
    /// @return vol          Effective annualized vol used, 1e18 = 100%.
    /// @return closedSeconds Seconds of closed market between now and expiry.
    function quotePut(
        address feed,
        uint256 strike,
        uint256 expiry,
        uint32 lookback,
        uint64 volFloor,
        uint64 volCap,
        uint64 closedVolMult,
        uint16 spreadBps
    ) external view returns (uint256 premium, uint256 spot, uint256 vol, uint256 closedSeconds);
}
