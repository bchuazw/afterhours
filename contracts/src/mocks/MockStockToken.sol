// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal Robinhood Stock Token stand-in for tests: exposes the corporate-action surface
///         (oraclePaused / uiMultiplier / newUIMultiplier / effectiveAt) that lives on the token.
contract MockStockToken is ERC20 {
    bool public oraclePaused;
    uint256 public uiMultiplier = 1e18;
    uint256 public newUIMultiplier = 1e18;
    uint256 public effectiveAt;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function setOraclePaused(bool paused) external {
        oraclePaused = paused;
    }

    function scheduleMultiplier(uint256 multiplier, uint256 at) external {
        newUIMultiplier = multiplier;
        effectiveAt = at;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
