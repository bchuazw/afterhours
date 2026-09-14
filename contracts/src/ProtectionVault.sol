// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626, IERC20} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title ProtectionVault
/// @notice ERC-4626 vault of stablecoins that underwrites AfterHours protection. Writers deposit the
///         quote asset (USDG on Robinhood Chain) and earn premiums; the market locks collateral for
///         every protection sold so all positions are fully collateralized at all times.
/// @dev Invariant: asset.balanceOf(vault) >= lockedCollateral. Premiums are transferred straight into
///      the vault by the market, which raises the share price for writers.
contract ProtectionVault is ERC4626 {
    using SafeERC20 for IERC20;
    using Math for uint256;

    address public immutable market;
    /// @notice Collateral reserved for open positions (in asset units).
    uint256 public lockedCollateral;
    /// @notice Cap on utilization: locked / totalAssets, in bps. Protects writers' exit liquidity.
    uint256 public constant MAX_UTILIZATION_BPS = 9_000;

    event CollateralLocked(uint256 amount, uint256 totalLocked);
    event CollateralReleased(uint256 amount, uint256 totalLocked);
    event Payout(address indexed to, uint256 amount);

    error OnlyMarket();
    error InsufficientFreeLiquidity(uint256 requested, uint256 available);
    error UtilizationTooHigh();
    error ReleaseExceedsLocked();

    modifier onlyMarket() {
        if (msg.sender != market) revert OnlyMarket();
        _;
    }

    constructor(IERC20 asset_, string memory name_, string memory symbol_, address market_)
        ERC4626(asset_)
        ERC20(name_, symbol_)
    {
        market = market_;
    }

    /// @notice Assets not reserved for open positions.
    function freeLiquidity() public view returns (uint256) {
        uint256 bal = IERC20(asset()).balanceOf(address(this));
        return bal > lockedCollateral ? bal - lockedCollateral : 0;
    }

    /// @notice Current utilization in bps.
    function utilizationBps() public view returns (uint256) {
        uint256 total = totalAssets();
        return total == 0 ? 0 : lockedCollateral * 10_000 / total;
    }

    // ---------------------------------------------------------------------------------------------
    // Market hooks
    // ---------------------------------------------------------------------------------------------

    /// @notice Reserve collateral for a newly sold position.
    function lock(uint256 amount) external onlyMarket {
        uint256 free = freeLiquidity();
        if (amount > free) revert InsufficientFreeLiquidity(amount, free);
        lockedCollateral += amount;
        if (lockedCollateral * 10_000 > totalAssets() * MAX_UTILIZATION_BPS) revert UtilizationTooHigh();
        emit CollateralLocked(amount, lockedCollateral);
    }

    /// @notice Release collateral that is no longer needed (position expired worthless or partially ITM).
    function release(uint256 amount) external onlyMarket {
        if (amount > lockedCollateral) revert ReleaseExceedsLocked();
        lockedCollateral -= amount;
        emit CollateralReleased(amount, lockedCollateral);
    }

    /// @notice Pay a settled claim out of locked collateral.
    function pay(address to, uint256 amount) external onlyMarket {
        if (amount > lockedCollateral) revert ReleaseExceedsLocked();
        lockedCollateral -= amount;
        IERC20(asset()).safeTransfer(to, amount);
        emit Payout(to, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // ERC-4626 overrides: withdrawals are limited to free liquidity
    // ---------------------------------------------------------------------------------------------

    function maxWithdraw(address owner) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner), freeLiquidity());
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        uint256 byShares = super.maxRedeem(owner);
        uint256 byLiquidity = _convertToShares(freeLiquidity(), Math.Rounding.Floor);
        return Math.min(byShares, byLiquidity);
    }

    /// @dev Virtual offset makes first-depositor share inflation attacks uneconomic.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }
}
