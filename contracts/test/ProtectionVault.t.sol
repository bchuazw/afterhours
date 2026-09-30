// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {AfterHoursMarket} from "../src/AfterHoursMarket.sol";
import {ProtectionVault} from "../src/ProtectionVault.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

/// @notice ProtectionVault v3: linear premium accrual, mark-to-market liability, entry/exit gating, exit cap.
contract ProtectionVaultTest is BaseTest {
    address internal lp = makeAddr("lp");

    function setUp() public override {
        super.setUp();
        usd.mint(lp, 10_000_000e6);
        vm.prank(lp);
        usd.approve(address(vault), type(uint256).max);
    }

    function _assertClosed() internal view {
        assertFalse(vault.isOpen());
        assertEq(vault.maxDeposit(lp), 0);
        assertEq(vault.maxMint(lp), 0);
        assertEq(vault.maxWithdraw(writer), 0);
        assertEq(vault.maxRedeem(writer), 0);
    }

    function _depositLp(uint256 amount) internal returns (uint256 shares) {
        vm.prank(lp);
        shares = vault.deposit(amount, lp);
    }

    function _redeemAll(address who) internal returns (uint256 out) {
        uint256 shares = vault.balanceOf(who);
        vm.prank(who);
        out = vault.redeem(shares, who, who);
    }

    // ------------------------------------------------------------------ construction / hooks

    function test_constructor_bindsMarketAndUnderlying() public view {
        assertEq(vault.market(), address(market));
        assertEq(vault.underlyingId(), tsla);
        assertEq(vault.asset(), address(usd));
        assertEq(vault.decimals(), 12); // 6 + decimalsOffset 6
        assertEq(vault.MAX_UTILIZATION_BPS(), 9_000);
    }

    function test_onlyMarketHooks() public {
        vm.expectRevert(ProtectionVault.OnlyMarket.selector);
        vault.lock(1, 0);
        vm.expectRevert(ProtectionVault.OnlyMarket.selector);
        vault.settle(0, 0, 0);
    }

    function test_settleHook_rejectsInconsistentAmounts() public {
        _buy(340 * P8, _week(), 10 * UNIT); // locked 3,400, unearned 72
        vm.startPrank(address(market));
        vm.expectRevert(ProtectionVault.BadSettle.selector);
        vault.settle(100e6, 101e6, 0); // owed > locked amount
        vm.expectRevert(ProtectionVault.BadSettle.selector);
        vault.settle(3_400e6 + 1, 0, 0); // more than locked
        vm.expectRevert(ProtectionVault.BadSettle.selector);
        vault.settle(0, 0, 72e6 + 1); // more than unearned
        vm.stopPrank();
    }

    function test_lock_capacityChecks() public {
        vm.startPrank(address(market));
        vm.expectRevert(
            abi.encodeWithSelector(ProtectionVault.InsufficientFreeLiquidity.selector, 100_000e6 + 1, 100_000e6)
        );
        vault.lock(100_000e6 + 1, 0);
        vm.expectRevert(ProtectionVault.UtilizationTooHigh.selector);
        vault.lock(90_000e6 + 1, 0);
        vault.lock(90_000e6, 0);
        vm.stopPrank();
        assertEq(vault.utilizationBps(), 9_000);
    }

    function test_lock_capacityExcludesUnearnedPremium() public {
        // A premium sitting in the vault is not capital: it cannot back new collateral.
        _buy(340 * P8, _week(), 10 * UNIT); // +72 unearned, 3,400 locked
        assertEq(vault.capital(), 100_000e6);
        assertEq(vault.freeLiquidity(), 96_600e6);
        vm.prank(address(market));
        vm.expectRevert(ProtectionVault.UtilizationTooHigh.selector);
        vault.lock(86_600e6 + 1, 0);
    }

    // ------------------------------------------------------------------ gating (item 10)

    function test_closedOnWeekendWithExposure() public {
        vm.warp(START + 4 days); // Friday 15:30
        _push(spot, block.timestamp);
        _buy(340 * P8, uint64(NEXT_MON0 + 2 days + 15 hours), UNIT); // expires next Wednesday
        assertTrue(vault.isOpen());

        vm.warp(SAT0 + 1 hours);
        _assertClosed();
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxDeposit.selector, lp, 1e6, 0));
        vault.deposit(1e6, lp);
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, writer, 1e6, 0));
        vault.withdraw(1e6, writer, writer);

        // Monday 00:30 UTC is still inside the conservative window.
        vm.warp(NEXT_MON0 + 30 minutes);
        _assertClosed();
        // Monday 01:00: window over, but the latest print is Friday's (stale) -> still closed.
        vm.warp(NEXT_MON0 + 1 hours);
        _assertClosed();
        _push(spot, block.timestamp);
        assertTrue(vault.isOpen());
        vm.prank(lp);
        vault.deposit(1e6, lp);
    }

    function test_openOnWeekendWithoutExposure() public {
        vm.warp(SAT0 + 12 hours);
        assertTrue(vault.isOpen());
        vm.prank(lp);
        vault.deposit(1_000e6, lp);
        vm.prank(writer);
        vault.withdraw(1_000e6, writer, writer);
    }

    function test_closedWhileExpiredSeriesAwaitsSettlement() public {
        uint64 expiry = uint64(START + 2 days); // Wednesday
        (uint256 id,) = _buy(340 * P8, expiry, UNIT);
        vm.warp(expiry);
        _push(spot, expiry); // feed live and fresh, weekday
        _assertClosed();
        vm.warp(expiry + 3 days); // still unsettled on Saturday
        _assertClosed();
        market.settle(id);
        assertTrue(vault.isOpen());
        assertGt(vault.maxWithdraw(writer), 0);
    }

    function test_closedWhileFeedOrTokenPausedWithExposure() public {
        _buy(340 * P8, _week(), UNIT);
        vm.prank(relayer);
        feed.setPaused(true);
        _assertClosed();
        vm.prank(relayer);
        feed.setPaused(false);
        assertTrue(vault.isOpen());
        stock.setOraclePaused(true);
        _assertClosed();
    }

    function test_closedWhenFeedStaleOrInvalidWithExposure() public {
        (uint256 id,) = _buy(340 * P8, _week(), UNIT);
        vm.warp(block.timestamp + 26 hours + 1); // Tuesday, no print for > maxPriceAge
        _assertClosed();
        _push(3_964_149_999_900_000_000, block.timestamp); // invalid answer: closed, marked worst-case
        _assertClosed();
        uint256 unearned = market.unearnedOf(id);
        assertGt(unearned, 0);
        assertLt(unearned, 7.2e6);
        assertEq(vault.liability(), 340e6 + unearned); // intrinsic at spot 0 = the whole collateral
        _push(spot, block.timestamp);
        assertTrue(vault.isOpen());
        assertEq(vault.liability(), unearned);
    }

    // ------------------------------------------------------------------ JIT / dilution (item 10)

    function test_jitDepositAroundBuyCapturesNothing() public {
        uint256 deposit = 1_000_000e6;
        uint256 shares = _depositLp(deposit);

        (, uint256 premium) = _buy(340 * P8, _week(), 200 * UNIT);
        assertGt(premium, 1_000e6);

        uint256 maxR = vault.maxRedeem(lp);
        assertEq(maxR, shares);
        vm.prank(lp);
        uint256 out = vault.redeem(shares, lp, lp);
        assertLe(out, deposit, "JIT LP captured premium");
        assertApproxEqAbs(out, deposit, 1);
        // The premium stays in the vault for the writers who carry the risk until settlement.
        assertEq(vault.unearnedPremium(), premium);
    }

    function test_itmSaleDoesNotMoveSharePrice() public {
        uint256 before = vault.convertToAssets(1e18);
        // 20% in the money: intrinsic 7,200, premium (floored at intrinsic + 5 bps) 7,218.
        (uint256 id, uint256 premium) = _buy(432 * P8, _week(), 100 * UNIT);
        assertEq(premium, 7_218e6);
        assertEq(vault.liability(), premium); // intrinsic 7,200 marked + 18 unearned time value
        assertEq(vault.convertToAssets(1e18), before);

        // So a deposit right after the sale buys at a fair price and cannot capture the intrinsic
        // value that writers are owed back at settlement.
        _depositLp(100_000e6);
        _settleAt(id, spot); // spot unchanged: owed 7,200, premium 7,218 earned
        uint256 lpValue = _shareValue(lp);
        uint256 writerValue = _shareValue(writer);
        assertApproxEqAbs(lpValue, writerValue, 2);
    }

    /// @dev Regression: with a 20% fee the vault used to receive 5,774.40 for a put worth 7,200 intrinsic,
    ///      so the sale itself pushed the share price down and the owner (buyer + treasury) could extract
    ///      the difference at settlement. The fee now comes out of the time value only.
    function test_itmSaleWithFeeDoesNotMoveSharePrice() public {
        _setConfig(treasury, 2_000, 1 hours, 30 days, 26 hours, 5 days, 5_000, 12_000);
        uint256 before = vault.convertToAssets(1e18);
        uint256 writerBefore = _shareValue(writer);
        (uint256 id, uint256 premium) = _buy(432 * P8, _week(), 100 * UNIT);
        assertEq(premium, 7_218e6);
        assertEq(usd.balanceOf(treasury), 3.6e6); // 20% of the 18 time value
        assertEq(market.getSeries(id).premium, 7_214.4e6);
        assertEq(vault.liability(), 7_214.4e6);
        assertEq(vault.convertToAssets(1e18), before);
        assertEq(_shareValue(writer), writerBefore);

        _settleAt(id, spot); // owed 7,200; writers keep the 14.40 net time value
        assertApproxEqAbs(_shareValue(writer), writerBefore + 14.4e6, 1);
        assertEq(vault.totalAssets(), 100_000e6 + 14.4e6);
    }

    function test_premiumEarnedAtSettlement() public {
        (uint256 id, uint256 premium) = _buy(340 * P8, _week(), 10 * UNIT);
        uint256 before = _shareValue(writer);
        assertApproxEqAbs(before, 100_000e6, 1);
        _settleAt(id, 380 * P8);
        assertApproxEqAbs(_shareValue(writer), 100_000e6 + premium, 1);
    }

    // ------------------------------------------------------------------ premium accrual

    function test_premiumAccruesLinearlyToExpiry() public {
        uint64 expiry = _week();
        uint256 tenor = expiry - block.timestamp;
        (uint256 id, uint256 premium) = _buy(340 * P8, expiry, 200 * UNIT); // 1,440
        assertEq(vault.totalAssets(), 100_000e6);
        assertEq(market.unearnedOf(id), premium);

        vm.warp(block.timestamp + tenor / 4);
        assertApproxEqAbs(market.unearnedOf(id), premium * 3 / 4, 1);
        assertApproxEqAbs(vault.totalAssets(), 100_000e6 + premium / 4, 1);

        vm.warp(expiry - tenor / 2);
        assertApproxEqAbs(vault.totalAssets(), 100_000e6 + premium / 2, 1);

        vm.warp(expiry - 1);
        assertApproxEqAbs(vault.totalAssets(), 100_000e6 + premium, 10_000); // < $0.01 still unearned
        assertLt(vault.totalAssets(), 100_000e6 + premium);

        vm.warp(expiry);
        assertEq(market.unearnedOf(id), 0);
        assertFalse(vault.isOpen()); // expired, awaiting its print
        _push(380 * P8, expiry + 1);
        vm.warp(expiry + 2);
        market.settle(id);
        assertEq(vault.totalAssets(), 100_000e6 + premium);
    }

    function test_accrualPoolsBuysMadeAtDifferentTimes() public {
        uint64 expiry = _week();
        (uint256 id, uint256 p1) = _buy(340 * P8, expiry, 100 * UNIT); // t0
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 2 days);
        _push(spot, block.timestamp);
        (, uint256 p2) = _buy(340 * P8, expiry, 100 * UNIT); // t0 + 2d
        uint256 t1 = block.timestamp;
        // Right after the second buy nothing of it is earned; 2/7 of the first is.
        assertApproxEqAbs(market.unearnedOf(id), p1 * (expiry - t1) / (expiry - t0) + p2, 2);
        vm.warp(t1 + 1 days);
        uint256 expected =
            p1 * (expiry - block.timestamp) / (expiry - t0) + p2 * (expiry - block.timestamp) / (expiry - t1);
        assertApproxEqAbs(market.unearnedOf(id), expected, 2);
        assertApproxEqAbs(vault.totalAssets(), 100_000e6 + p1 + p2 - expected, 2);
    }

    /// @dev Regression: a $1M deposit at expiry-1s used to take 91% of a series' premium at settlement.
    function test_jitDepositBeforeExpiryCapturesOnlyItsRiskPeriod() public {
        uint64 expiry = uint64(START + 2 days);
        (uint256 id, uint256 premium) = _buy(340 * P8, expiry, 200 * UNIT); // 1,440 for 2 days of risk
        uint256 writerBefore = _shareValue(writer);

        vm.warp(expiry - 1);
        _push(spot, block.timestamp);
        uint256 deposit = 1_000_000e6;
        uint256 shares = _depositLp(deposit);

        _push(spot, expiry + 1);
        vm.warp(expiry + 2);
        market.settle(id); // out of the money: the whole premium is now writer equity

        vm.prank(lp);
        uint256 out = vault.redeem(shares, lp, lp);
        // One second of a two-day series is worth 1,440 / 172,800 = $0.0083 of premium.
        assertLe(out, deposit + 10_000, "JIT LP captured premium");
        assertApproxEqAbs(_shareValue(writer), writerBefore + premium, 10_000);
    }

    /// @dev Regression: a writer exiting one second before expiry used to get back exactly their deposit
    ///      and forfeit their whole share of the premium they underwrote.
    function test_exitingWriterKeepsAccruedPremium() public {
        address writer2 = makeAddr("writer2");
        usd.mint(writer2, 100_000e6);
        vm.startPrank(writer2);
        usd.approve(address(vault), type(uint256).max);
        vault.deposit(100_000e6, writer2);
        vm.stopPrank();

        uint64 expiry = uint64(START + 2 days);
        (uint256 id, uint256 premium) = _buy(340 * P8, expiry, 20 * UNIT); // 144
        vm.warp(expiry - 1);
        _push(spot, block.timestamp);
        assertEq(vault.maxRedeem(writer), vault.balanceOf(writer));
        uint256 out1 = _redeemAll(writer);
        assertApproxEqAbs(out1, 100_000e6 + premium / 2, 1_000); // half of 144 less one second's worth

        _push(spot, expiry + 1);
        vm.warp(expiry + 2);
        market.settle(id);
        uint256 out2 = _redeemAll(writer2);
        assertApproxEqAbs(out2, 100_000e6 + premium / 2, 1_000);
        assertApproxEqAbs(out1 + out2, 200_000e6 + premium, 2);
    }

    /// @dev Regression: a buy into a series already in liability used to book its time value at once, so a
    ///      deposit sandwiched around it gained $1,823 on $1M inside one block.
    function test_sandwichBuyIntoItmSeriesGainsNothing() public {
        uint64 expiry = uint64(START + 2 days);
        _buy(340 * P8, expiry, 100 * UNIT); // premium 720
        _push(300 * P8, block.timestamp); // intrinsic 4,000 > premium
        assertEq(vault.liability(), 4_000e6 + 720e6);
        uint256 writerBefore = _shareValue(writer);

        uint256 shares = _depositLp(1_000_000e6);
        uint256 lpBefore = vault.convertToAssets(shares);
        pricer.setPremiumOverride(true, 50 * P8); // $40 intrinsic + $10 time value per unit
        (, uint256 p2) = _buy(340 * P8, expiry, 200 * UNIT);
        assertEq(p2, 10_000e6);
        assertEq(vault.liability(), 4_000e6 + 720e6 + 10_000e6);
        assertEq(vault.convertToAssets(shares), lpBefore);
        assertEq(_shareValue(writer), writerBefore);
    }

    // ------------------------------------------------------------------ mark-to-market (item 10)

    function test_totalAssetsMarksOpenPutsToMarket() public {
        (uint256 id, uint256 premium) = _buy(340 * P8, _week(), 100 * UNIT); // premium 720
        assertEq(vault.totalAssets(), 100_000e6);
        assertEq(market.unearnedOf(id), premium);
        _push(335 * P8, block.timestamp); // intrinsic 500
        assertEq(vault.liability(), 500e6 + premium);
        assertEq(vault.totalAssets(), 100_000e6 - 500e6);
        _push(330 * P8, block.timestamp); // intrinsic 1,000
        assertEq(vault.liability(), 1_000e6 + premium);
        assertEq(vault.totalAssets(), 100_000e6 - 1_000e6);
        _push(1 * P8, block.timestamp); // intrinsic 339 per unit
        assertEq(vault.liability(), 33_900e6 + premium);
        (bool open, uint256 liab) = market.vaultState(tsla);
        assertTrue(open);
        assertEq(liab, 33_900e6 + premium);
        // Back above the strike: the mark is gone, the unearned premium remains.
        _push(380 * P8, block.timestamp);
        assertEq(vault.liability(), premium);
        assertEq(vault.totalAssets(), 100_000e6);
    }

    // ------------------------------------------------------------------ exit cap (item 10)

    function test_exitCappedAtNinetyPercentUtilization() public {
        _buy(340 * P8, _week(), 250 * UNIT); // locks 85,000 of 100,000
        uint256 cap = 100_000e6 - 94_444_444_445; // capital - ceil(85,000 / 0.9)
        assertEq(vault.exitLiquidity(), cap);
        assertEq(vault.maxWithdraw(writer), cap);

        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, writer, cap + 1, cap));
        vault.withdraw(cap + 1, writer, writer);
        vm.prank(writer);
        vault.withdraw(cap, writer, writer);
        assertLe(vault.lockedCollateral() * 10_000, vault.capital() * 9_000);
        assertEq(vault.maxWithdraw(writer), 0);
    }

    function test_maxRedeemConsistentWithExitCap() public {
        _buy(340 * P8, _week(), 250 * UNIT);
        uint256 maxR = vault.maxRedeem(writer);
        assertLt(maxR, vault.balanceOf(writer));
        assertLe(vault.previewRedeem(maxR), vault.exitLiquidity());

        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxRedeem.selector, writer, maxR + 1, maxR));
        vault.redeem(maxR + 1, writer, writer);
        vm.prank(writer);
        vault.redeem(maxR, writer, writer);
        assertLe(vault.lockedCollateral() * 10_000, vault.capital() * 9_000);
    }

    function testFuzz_exitsNeverBreachUtilizationCap(uint256 units, uint256 frac, uint256 dt) public {
        _noMinSeries();
        units = bound(units, 1, 264 * UNIT);
        dt = bound(dt, 0, 6 days);
        _buy(340 * P8, _week(), units);
        vm.warp(block.timestamp + dt);
        if (!vault.isOpen()) _push(spot, block.timestamp);
        if (!vault.isOpen()) return; // weekend
        uint256 maxW = vault.maxWithdraw(writer);
        uint256 amount = bound(frac, 0, maxW);
        vm.prank(writer);
        vault.withdraw(amount, writer, writer);
        assertLe(vault.lockedCollateral() * 10_000, vault.capital() * 9_000);
        assertGe(usd.balanceOf(address(vault)), vault.lockedCollateral() + vault.unearnedPremium());
        uint256 maxR = vault.maxRedeem(writer);
        vm.prank(writer);
        vault.redeem(maxR, writer, writer);
        assertLe(vault.lockedCollateral() * 10_000, vault.capital() * 9_000);
        assertGe(usd.balanceOf(address(vault)), vault.lockedCollateral() + vault.unearnedPremium());
        assertLe(vault.liability(), vault.lockedCollateral() + vault.unearnedPremium());
    }
}
