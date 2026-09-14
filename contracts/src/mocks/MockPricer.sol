// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPricer} from "../interfaces/IPricer.sol";
import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";

/// @notice Deterministic pricer for unit tests: premium = spot * premiumBps / 10_000 per unit.
contract MockPricer is IPricer {
    uint256 public premiumBps;

    constructor(uint256 premiumBps_) {
        premiumBps = premiumBps_;
    }

    function setPremiumBps(uint256 bps) external {
        premiumBps = bps;
    }

    function quotePut(address feed, uint256, uint256 expiry, uint32, uint64 volFloor, uint64, uint64, uint16)
        external
        view
        returns (uint256 premium, uint256 spot, uint256 vol, uint256 closedSeconds)
    {
        (, int256 answer,,,) = IAggregatorV3(feed).latestRoundData();
        spot = uint256(answer);
        premium = spot * premiumBps / 10_000;
        vol = volFloor;
        closedSeconds = expiry > block.timestamp ? (expiry - block.timestamp) / 3 : 0;
    }
}
