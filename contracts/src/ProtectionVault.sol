// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626, IERC20} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IMarketVaultState} from "./interfaces/IMarketVaultState.sol";

/// @title ProtectionVault
/// @notice ERC-4626 vault of stablecoins that underwrites AfterHours protection on one underlying. Writers
///         deposit the quote asset (USDG on Robinhood Chain); the market locks collateral for every
///         protection sold, so every position is fully collateralized at all times.
///
///         Accounting (v3):
///           capital     = balance - unearnedPremium          (backs collateral; premium is never collateral)
///           totalAssets = balance - liability                (writer equity)
///         - `liability` (see IMarketVaultState) is, per open series, the premium's not-yet-earned time value
///           plus the mark-to-market intrinsic value of the puts. A sale adds its net premium to both the
///           balance and the liability, so the share price never moves on a buy and a just-in-time deposit
///           around a buy earns nothing. The time value is then released to writers linearly until expiry,
///           so a deposit or exit just before expiry neither captures nor forfeits premium for a risk
///           period it did not carry, and a loss hits every writer's share price at once instead of
///           whoever exits last.
///         - At settlement the market moves the owed payout out of the vault into its own escrow, so an
///           out-of-the-money series frees all of its collateral without anyone having to claim.
///         - Entries and exits pause (max* = 0) while the feed is dark with open exposure or while an
///           expired series awaits settlement, and exits can never push utilization above 90%.
/// @dev Invariant: asset.balanceOf(vault) >= lockedCollateral + unearnedPremium >= liability.
contract ProtectionVault is ERC4626 {
    using SafeERC20 for IERC20;

    /// @notice Cap on utilization, locked / capital, in bps. Protects writers' exit liquidity.
    uint256 public constant MAX_UTILIZATION_BPS = 9_000;

    address public immutable market;
    uint32 public immutable underlyingId;
    /// @notice Collateral reserved for open series (asset units). Always fully backed by the balance.
    uint256 public lockedCollateral;
    /// @notice Net premium received for series that have not settled yet (asset units). Excluded from the
    ///         capital that backs collateral; the part already earned by writers is in totalAssets.
    uint256 public unearnedPremium;

    event CollateralLocked(uint256 collateral, uint256 premium, uint256 totalLocked, uint256 totalUnearned);
    event CollateralSettled(
        uint256 unlocked, uint256 owed, uint256 premiumEarned, uint256 totalLocked, uint256 totalUnearned
    );

    error OnlyMarket();
    error InsufficientFreeLiquidity(uint256 requested, uint256 available);
    error UtilizationTooHigh();
    error BadSettle();

    modifier onlyMarket() {
        if (msg.sender != market) revert OnlyMarket();
        _;
    }

    constructor(IERC20 asset_, string memory name_, string memory symbol_, address market_, uint32 underlyingId_)
        ERC4626(asset_)
        ERC20(name_, symbol_)
    {
        market = market_;
        underlyingId = underlyingId_;
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice Balance that backs collateral: everything except premium of unsettled series.
    function capital() public view returns (uint256) {
        uint256 bal = IERC20(asset()).balanceOf(address(this));
        return bal > unearnedPremium ? bal - unearnedPremium : 0;
    }

    /// @notice Capital not reserved as collateral.
    function freeLiquidity() public view returns (uint256) {
        uint256 c = capital();
        return c > lockedCollateral ? c - lockedCollateral : 0;
    }

    /// @notice Assets writers may withdraw in aggregate without pushing utilization above the cap:
    ///         capital - ceil(locked * 10_000 / MAX_UTILIZATION_BPS).
    function exitLiquidity() public view returns (uint256) {
        uint256 c = capital();
        uint256 needed = Math.mulDiv(lockedCollateral, 10_000, MAX_UTILIZATION_BPS, Math.Rounding.Ceil);
        return c > needed ? c - needed : 0;
    }

    /// @notice Current utilization (locked / capital) in bps.
    function utilizationBps() public view returns (uint256) {
        uint256 c = capital();
        return c == 0 ? 0 : lockedCollateral * 10_000 / c;
    }

    /// @notice Whether deposits and exits are currently allowed (see IMarketVaultState.vaultState).
    function isOpen() public view returns (bool open) {
        (open,) = IMarketVaultState(market).vaultState(underlyingId);
    }

    /// @notice Unearned time value plus mark-to-market intrinsic value of the open puts, asset units.
    function liability() public view returns (uint256 liab) {
        (, liab) = IMarketVaultState(market).vaultState(underlyingId);
    }

    /// @notice Writer equity: balance - liability. Never below capital() - lockedCollateral.
    function totalAssets() public view override returns (uint256) {
        uint256 bal = IERC20(asset()).balanceOf(address(this));
        uint256 liab = liability();
        return bal > liab ? bal - liab : 0;
    }

    // ---------------------------------------------------------------------------------------------
    // Market hooks
    // ---------------------------------------------------------------------------------------------

    /// @notice Reserve `collateral` for a sale and book `premiumNet` (sent by the market right after this
    ///         call) as premium of an unsettled series.
    function lock(uint256 collateral, uint256 premiumNet) external onlyMarket {
        uint256 c = capital();
        uint256 locked = lockedCollateral;
        uint256 free = c > locked ? c - locked : 0;
        if (collateral > free) revert InsufficientFreeLiquidity(collateral, free);
        locked += collateral;
        if (locked * 10_000 > c * MAX_UTILIZATION_BPS) revert UtilizationTooHigh();
        lockedCollateral = locked;
        uint256 unearned = unearnedPremium + premiumNet;
        unearnedPremium = unearned;
        emit CollateralLocked(collateral, premiumNet, locked, unearned);
    }

    /// @notice A series settled: unlock all of its collateral, release its premium into capital and hand the
    ///         owed payout to the market, which escrows it for position holders.
    function settle(uint256 lockedAmt, uint256 owed, uint256 premiumNet) external onlyMarket {
        uint256 locked = lockedCollateral;
        uint256 unearned = unearnedPremium;
        if (owed > lockedAmt || lockedAmt > locked || premiumNet > unearned) revert BadSettle();
        locked -= lockedAmt;
        unearned -= premiumNet;
        lockedCollateral = locked;
        unearnedPremium = unearned;
        if (owed > 0) IERC20(asset()).safeTransfer(market, owed);
        emit CollateralSettled(lockedAmt, owed, premiumNet, locked, unearned);
    }

    // ---------------------------------------------------------------------------------------------
    // ERC-4626 overrides: gated while the feed is dark with exposure, exits capped by utilization
    // ---------------------------------------------------------------------------------------------

    function maxDeposit(address receiver) public view override returns (uint256) {
        return isOpen() ? super.maxDeposit(receiver) : 0;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        return isOpen() ? super.maxMint(receiver) : 0;
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        if (!isOpen()) return 0;
        return Math.min(super.maxWithdraw(owner), exitLiquidity());
    }

    /// @dev All shares when their value fits the exit liquidity, otherwise the shares worth at most the
    ///      exit liquidity; either way previewRedeem(maxRedeem) <= exitLiquidity().
    function maxRedeem(address owner) public view override returns (uint256) {
        if (!isOpen()) return 0;
        uint256 shares = balanceOf(owner);
        uint256 exit = exitLiquidity();
        if (_convertToAssets(shares, Math.Rounding.Floor) <= exit) return shares;
        return _convertToShares(exit, Math.Rounding.Floor);
    }

    /// @dev Virtual offset makes first-depositor share inflation attacks uneconomic.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }
}
