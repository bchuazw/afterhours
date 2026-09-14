// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AfterHoursMarket} from "../src/AfterHoursMarket.sol";
import {ProtectionVault} from "../src/ProtectionVault.sol";
import {FeedMirror} from "../src/FeedMirror.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockPricer} from "../src/mocks/MockPricer.sol";
import {IPricer} from "../src/interfaces/IPricer.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";

contract AfterHoursMarketTest is Test {
    uint256 constant P8 = 1e8;
    uint256 constant UNIT = 1e18;

    MockERC20 usd;
    FeedMirror feed;
    MockPricer pricer;
    AfterHoursMarket market;
    ProtectionVault vault;
    uint32 tsla;

    address writer = makeAddr("writer");
    address buyer = makeAddr("buyer");
    address treasury = makeAddr("treasury");
    address relayer = makeAddr("relayer");

    uint256 spot = 360 * P8;

    function setUp() public {
        vm.warp(1_789_400_000); // Mon 2026-09-14 ~15:00 UTC
        usd = new MockERC20("Test USD", "tUSD", 6);
        feed = new FeedMirror("RHTSLA / USD", 8, relayer);
        pricer = new MockPricer(200); // premium = 2% of spot per unit
        market = new AfterHoursMarket(IERC20(address(usd)), IPricer(address(pricer)), treasury, "ipfs://x/{id}");

        feed.pushRound(1, int256(spot), uint64(block.timestamp - 60));
        AfterHoursMarket.PricingParams memory p = AfterHoursMarket.PricingParams({
            lookback: 30,
            volFloor: 0.5e18,
            volCap: 3e18,
            closedVolMult: 1.5e18,
            spreadBps: 1_000
        });
        tsla = market.addUnderlying("TSLA", address(0), IAggregatorV3(address(feed)), p, "AfterHours TSLA Writer", "ahTSLA");
        vault = market.getUnderlying(tsla).vault;

        usd.mint(writer, 1_000_000e6);
        usd.mint(buyer, 100_000e6);
        vm.startPrank(writer);
        usd.approve(address(vault), type(uint256).max);
        vault.deposit(100_000e6, writer);
        vm.stopPrank();
        vm.prank(buyer);
        usd.approve(address(market), type(uint256).max);
    }

    // ------------------------------------------------------------------ helpers

    function _buy(uint256 strike, uint64 expiry, uint256 units) internal returns (uint256 id, uint256 premium) {
        vm.prank(buyer);
        (id, premium) = market.buyProtection(tsla, strike, expiry, units, type(uint256).max);
    }

    function _usd(uint256 price8, uint256 units) internal pure returns (uint256) {
        return price8 * units * 1e6 / 1e26;
    }

    // ------------------------------------------------------------------ quote / buy

    function test_quote_matchesPricerAndLocksStrike() public view {
        uint64 expiry = uint64(block.timestamp + 7 days);
        (uint256 premium, uint256 collateral, uint256 s,,) = market.quote(tsla, 340 * P8, expiry, 10 * UNIT);
        assertEq(s, spot);
        assertEq(premium, _usd(spot * 200 / 10_000, 10 * UNIT)); // 2% * 360 * 10 = 72 USD
        assertEq(premium, 72e6);
        assertEq(collateral, 3_400e6);
    }

    function test_buy_transfersPremiumLocksCollateralMintsPosition() public {
        uint64 expiry = uint64(block.timestamp + 7 days);
        uint256 vaultBefore = usd.balanceOf(address(vault));
        (uint256 id, uint256 premium) = _buy(340 * P8, expiry, 10 * UNIT);

        assertEq(premium, 72e6);
        assertEq(usd.balanceOf(address(vault)), vaultBefore + premium);
        assertEq(vault.lockedCollateral(), 3_400e6);
        assertEq(market.balanceOf(buyer, id), 10 * UNIT);
        AfterHoursMarket.Series memory s = market.getSeries(id);
        assertEq(s.strike, 340 * P8);
        assertEq(s.expiry, expiry);
        assertEq(s.openUnits, 10 * UNIT);
        // writers' share price rose because premium landed in the vault
        assertGt(vault.convertToAssets(vault.balanceOf(writer)), 100_000e6);
    }

    function test_buy_takesProtocolFee() public {
        market.setConfig(treasury, 1_000, 1 hours, 30 days, 4 days, 5 days, 5_000, 12_000);
        uint64 expiry = uint64(block.timestamp + 7 days);
        (, uint256 premium) = _buy(340 * P8, expiry, 10 * UNIT);
        assertEq(usd.balanceOf(treasury), premium / 10);
    }

    function test_buy_revertsOnSlippage() public {
        uint64 expiry = uint64(block.timestamp + 7 days);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.PremiumTooHigh.selector, 72e6, 71e6));
        market.buyProtection(tsla, 340 * P8, expiry, 10 * UNIT, 71e6);
    }

    function test_buy_revertsOnBadTenor() public {
        vm.startPrank(buyer);
        vm.expectRevert(AfterHoursMarket.BadExpiry.selector);
        market.buyProtection(tsla, 340 * P8, uint64(block.timestamp + 30 minutes), UNIT, type(uint256).max);
        vm.expectRevert(AfterHoursMarket.BadExpiry.selector);
        market.buyProtection(tsla, 340 * P8, uint64(block.timestamp + 31 days), UNIT, type(uint256).max);
        vm.stopPrank();
    }

    function test_buy_revertsOnStrikeOutOfBounds() public {
        uint64 expiry = uint64(block.timestamp + 7 days);
        vm.startPrank(buyer);
        vm.expectRevert(AfterHoursMarket.BadStrike.selector);
        market.buyProtection(tsla, 100 * P8, expiry, UNIT, type(uint256).max); // 28% of spot
        vm.expectRevert(AfterHoursMarket.BadStrike.selector);
        market.buyProtection(tsla, 500 * P8, expiry, UNIT, type(uint256).max); // 139% of spot
        vm.stopPrank();
    }

    function test_buy_revertsWhenFeedStale() public {
        vm.warp(block.timestamp + 5 days);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.StalePrice.selector, block.timestamp - 5 days - 60));
        market.buyProtection(tsla, 340 * P8, uint64(block.timestamp + 7 days), UNIT, type(uint256).max);
    }

    function test_buy_revertsWhenFeedPaused() public {
        vm.prank(relayer);
        feed.setPaused(true);
        vm.prank(buyer);
        vm.expectRevert(AfterHoursMarket.FeedPaused.selector);
        market.buyProtection(tsla, 340 * P8, uint64(block.timestamp + 7 days), UNIT, type(uint256).max);
    }

    function test_buy_revertsWhenVaultLacksLiquidity() public {
        uint64 expiry = uint64(block.timestamp + 7 days);
        vm.prank(buyer);
        // 1000 units * 340 = 340,000 USD collateral > 100k in vault
        vm.expectRevert();
        market.buyProtection(tsla, 340 * P8, expiry, 1_000 * UNIT, type(uint256).max);
    }

    function test_buy_respectsUtilizationCap() public {
        uint64 expiry = uint64(block.timestamp + 7 days);
        // vault has 100k; 95% utilization -> 95,000 USD collateral -> ~279.4 units at 340
        vm.prank(buyer);
        vm.expectRevert(ProtectionVault.UtilizationTooHigh.selector);
        market.buyProtection(tsla, 340 * P8, expiry, 280 * UNIT, type(uint256).max);
        // 88% is fine
        _buy(340 * P8, expiry, 258 * UNIT);
    }

    function test_buy_pausable() public {
        market.pause();
        vm.prank(buyer);
        vm.expectRevert();
        market.buyProtection(tsla, 340 * P8, uint64(block.timestamp + 7 days), UNIT, type(uint256).max);
        market.unpause();
        _buy(340 * P8, uint64(block.timestamp + 7 days), UNIT);
    }

    // ------------------------------------------------------------------ settle

    function test_settle_revertsBeforeExpiry() public {
        (uint256 id,) = _buy(340 * P8, uint64(block.timestamp + 7 days), UNIT);
        vm.expectRevert(AfterHoursMarket.NotExpired.selector);
        market.settle(id);
    }

    function test_settle_waitsForPostExpiryPrint() public {
        uint64 expiry = uint64(block.timestamp + 7 days);
        (uint256 id,) = _buy(340 * P8, expiry, UNIT);
        // Feed frozen (weekend). Last print is pre-expiry.
        vm.prank(relayer);
        feed.pushRound(2, int256(300 * P8), expiry - 1);
        vm.warp(expiry + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.AwaitingPostExpiryPrint.selector, expiry, expiry - 1));
        market.settle(id);
        // First print after expiry settles it, at that print.
        vm.prank(relayer);
        feed.pushRound(3, int256(320 * P8), expiry + 2 hours);
        vm.warp(expiry + 2 hours);
        market.settle(id);
        assertEq(market.getSeries(id).settlePrice, 320 * P8);
    }

    function test_settle_fallbackAfterGrace() public {
        uint64 expiry = uint64(block.timestamp + 7 days);
        (uint256 id,) = _buy(340 * P8, expiry, UNIT);
        vm.prank(relayer);
        feed.pushRound(2, int256(300 * P8), expiry - 1);
        vm.warp(expiry + 5 days + 1);
        vm.expectEmit(true, false, false, true);
        emit AfterHoursMarket.SeriesSettled(id, 300 * P8, true);
        market.settle(id);
    }

    function test_settle_revertsWhenPaused() public {
        uint64 expiry = uint64(block.timestamp + 7 days);
        (uint256 id,) = _buy(340 * P8, expiry, UNIT);
        vm.startPrank(relayer);
        feed.pushRound(2, int256(300 * P8), expiry + 1);
        feed.setPaused(true);
        vm.stopPrank();
        vm.warp(expiry + 2);
        vm.expectRevert(AfterHoursMarket.FeedPaused.selector);
        market.settle(id);
    }

    function test_settle_normalizes18DecimalGenesisRounds() public {
        uint64 expiry = uint64(block.timestamp + 7 days);
        (uint256 id,) = _buy(340 * P8, expiry, UNIT);
        vm.prank(relayer);
        feed.pushRound(2, int256(300 * 1e18), expiry + 1); // mis-scaled round
        vm.warp(expiry + 2);
        market.settle(id);
        assertEq(market.getSeries(id).settlePrice, 300 * P8);
    }

    // ------------------------------------------------------------------ claim

    function test_claim_inTheMoney_paysIntrinsicAndReleasesRest() public {
        uint64 expiry = uint64(block.timestamp + 7 days);
        (uint256 id, uint256 premium) = _buy(340 * P8, expiry, 10 * UNIT);
        vm.prank(relayer);
        feed.pushRound(2, int256(300 * P8), expiry + 1);
        vm.warp(expiry + 2);
        market.settle(id);

        uint256 buyerBefore = usd.balanceOf(buyer);
        vm.prank(buyer);
        uint256 payout = market.claim(id, 10 * UNIT);
        assertEq(payout, 400e6); // (340-300) * 10
        assertEq(usd.balanceOf(buyer), buyerBefore + 400e6);
        assertEq(vault.lockedCollateral(), 0);
        assertEq(market.balanceOf(buyer, id), 0);
        // vault kept premium, paid 400
        assertEq(usd.balanceOf(address(vault)), 100_000e6 + premium - 400e6);
    }

    function test_claim_outOfTheMoney_paysNothingReleasesAll() public {
        uint64 expiry = uint64(block.timestamp + 7 days);
        (uint256 id,) = _buy(340 * P8, expiry, 10 * UNIT);
        vm.prank(relayer);
        feed.pushRound(2, int256(380 * P8), expiry + 1);
        vm.warp(expiry + 2);
        market.settle(id);
        vm.prank(buyer);
        uint256 payout = market.claim(id, 10 * UNIT);
        assertEq(payout, 0);
        assertEq(vault.lockedCollateral(), 0);
        assertEq(vault.freeLiquidity(), usd.balanceOf(address(vault)));
    }

    function test_claim_partialAndTransferredPositions() public {
        uint64 expiry = uint64(block.timestamp + 7 days);
        (uint256 id,) = _buy(340 * P8, expiry, 10 * UNIT);
        address holder2 = makeAddr("holder2");
        vm.prank(buyer);
        market.safeTransferFrom(buyer, holder2, id, 4 * UNIT, "");
        vm.prank(relayer);
        feed.pushRound(2, int256(300 * P8), expiry + 1);
        vm.warp(expiry + 2);
        market.settle(id);
        vm.prank(holder2);
        assertEq(market.claim(id, 4 * UNIT), 160e6);
        vm.prank(buyer);
        assertEq(market.claim(id, 6 * UNIT), 240e6);
        assertEq(vault.lockedCollateral(), 0);
    }

    function test_claim_revertsUnsettled() public {
        (uint256 id,) = _buy(340 * P8, uint64(block.timestamp + 7 days), UNIT);
        vm.prank(buyer);
        vm.expectRevert(AfterHoursMarket.NotSettled.selector);
        market.claim(id, UNIT);
    }

    // ------------------------------------------------------------------ vault

    function test_vault_withdrawLimitedToFreeLiquidity() public {
        uint64 expiry = uint64(block.timestamp + 7 days);
        _buy(340 * P8, expiry, 200 * UNIT); // locks 68,000
        uint256 maxW = vault.maxWithdraw(writer);
        assertLe(maxW, vault.freeLiquidity());
        assertGt(maxW, 30_000e6);
        vm.prank(writer);
        vm.expectRevert();
        vault.withdraw(90_000e6, writer, writer);
        vm.prank(writer);
        vault.withdraw(maxW, writer, writer);
    }

    function test_vault_onlyMarketCanLock() public {
        vm.expectRevert(ProtectionVault.OnlyMarket.selector);
        vault.lock(1);
        vm.expectRevert(ProtectionVault.OnlyMarket.selector);
        vault.pay(writer, 1);
    }

    // ------------------------------------------------------------------ fuzz

    /// @dev Payout can never exceed the collateral locked for the position, for any settle price.
    function testFuzz_payoutNeverExceedsCollateral(uint256 strikeBps, uint256 settle, uint256 units) public {
        strikeBps = bound(strikeBps, 5_000, 12_000);
        units = bound(units, 1e15, 100 * UNIT);
        settle = bound(settle, 1, 10_000 * P8);
        uint256 strike = spot * strikeBps / 10_000;
        uint64 expiry = uint64(block.timestamp + 7 days);
        (uint256 id,) = _buy(strike, expiry, units);
        uint256 lockedBefore = vault.lockedCollateral();
        vm.prank(relayer);
        feed.pushRound(2, int256(settle), expiry + 1);
        vm.warp(expiry + 2);
        market.settle(id);
        vm.prank(buyer);
        uint256 payout = market.claim(id, units);
        assertLe(payout, lockedBefore);
        assertEq(vault.lockedCollateral(), 0);
        assertGe(usd.balanceOf(address(vault)), vault.lockedCollateral());
    }
}
