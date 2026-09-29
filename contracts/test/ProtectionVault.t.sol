// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {AfterHoursMarket} from "../src/AfterHoursMarket.sol";
import {ProtectionVault} from "../src/ProtectionVault.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

/// @notice ProtectionVault v2: unearned premium, mark-to-market liability, entry/exit gating, exit cap.
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
        vm.warp(START + 4 days); // Friday 15:33
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
        _buy(340 * P8, _week(), UNIT);
        vm.warp(block.timestamp + 26 hours + 1); // Tuesday, no print for > maxPriceAge
        _assertClosed();
        _push(3_964_149_999_900_000_000, block.timestamp); // invalid answer: closed, marked worst-case
        _assertClosed();
        assertEq(vault.liability(), 340e6 - 7.2e6);
        _push(spot, block.timestamp);
        assertTrue(vault.isOpen());
        assertEq(vault.liability(), 0);
    }

    // ------------------------------------------------------------------ JIT / dilution (item 10)

    function test_jitDepositAroundBuyCapturesNothing() public {
        uint256 deposit = 1_000_000e6;
        vm.prank(lp);
        uint256 shares = vault.deposit(deposit, lp);

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
        assertEq(vault.liability(), 0);
        assertEq(vault.convertToAssets(1e18), before);

        // So a deposit right after the sale buys at a fair price and cannot capture the intrinsic
        // value that writers are owed back at settlement.
        vm.prank(lp);
        vault.deposit(100_000e6, lp);
        _settleAt(id, spot); // spot unchanged: owed 7,200, premium 7,218 earned
        uint256 lpValue = _shareValue(lp);
        uint256 writerValue = _shareValue(writer);
        assertApproxEqAbs(lpValue, writerValue, 2);
    }

    function test_premiumEarnedAtSettlement() public {
        (uint256 id, uint256 premium) = _buy(340 * P8, _week(), 10 * UNIT);
        uint256 before = _shareValue(writer);
        assertApproxEqAbs(before, 100_000e6, 1);
        _settleAt(id, 380 * P8);
        assertApproxEqAbs(_shareValue(writer), 100_000e6 + premium, 1);
    }

    // ------------------------------------------------------------------ mark-to-market (item 10)

    function test_totalAssetsMarksOpenPutsToMarket() public {
        (, uint256 premium) = _buy(340 * P8, _week(), 100 * UNIT); // premium 720
        assertEq(vault.totalAssets(), 100_000e6);
        _push(335 * P8, block.timestamp); // intrinsic 500 < premium: no liability yet
        assertEq(vault.liability(), 0);
        _push(330 * P8, block.timestamp); // intrinsic 1,000 > premium 720
        assertEq(vault.liability(), 1_000e6 - premium);
        assertEq(vault.totalAssets(), 100_000e6 - (1_000e6 - premium));
        _push(1 * P8, block.timestamp); // intrinsic 339 per unit
        assertEq(vault.liability(), 33_900e6 - premium);
        (bool open, uint256 liab) = market.vaultState(tsla);
        assertTrue(open);
        assertEq(liab, 33_900e6 - premium);
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

    function testFuzz_exitsNeverBreachUtilizationCap(uint256 units, uint256 frac) public {
        units = bound(units, 1, 264 * UNIT);
        _buy(340 * P8, _week(), units);
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
    }
}
