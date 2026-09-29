// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPricer} from "../interfaces/IPricer.sol";
import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";

/// @notice Deterministic pricer for unit tests: premium = spot * premiumBps / 10_000 per unit.
/// @dev Overrides let tests impersonate a buggy or malicious pricer: `spotOverride` reports a different
///      spot than the feed, `premiumOverride` returns an arbitrary (e.g. zero) premium.
contract MockPricer is IPricer {
    uint256 public premiumBps;
    bool public spotOverridden;
    uint256 public spotOverride;
    bool public premiumOverridden;
    uint256 public premiumOverride;

    constructor(uint256 premiumBps_) {
        premiumBps = premiumBps_;
    }

    function setPremiumBps(uint256 bps) external {
        premiumBps = bps;
    }

    /// @notice Report `spot` instead of the feed's latest answer (enabled = false restores the feed).
    function setSpotOverride(bool enabled, uint256 spot) external {
        spotOverridden = enabled;
        spotOverride = spot;
    }

    /// @notice Return `premium` per unit regardless of inputs (enabled = false restores premiumBps).
    function setPremiumOverride(bool enabled, uint256 premium) external {
        premiumOverridden = enabled;
        premiumOverride = premium;
    }

    function quotePut(address feed, uint256, uint256 expiry, uint32, uint64 volFloor, uint64, uint64, uint16)
        external
        view
        returns (uint256 premium, uint256 spot, uint256 vol, uint256 closedSeconds)
    {
        (, int256 answer,,,) = IAggregatorV3(feed).latestRoundData();
        spot = spotOverridden ? spotOverride : uint256(answer);
        premium = premiumOverridden ? premiumOverride : spot * premiumBps / 10_000;
        vol = volFloor;
        closedSeconds = expiry > block.timestamp ? (expiry - block.timestamp) / 3 : 0;
    }
}
