// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {AfterHoursMarket} from "../src/AfterHoursMarket.sol";
import {ProtectionVault} from "../src/ProtectionVault.sol";
import {FeedMirror} from "../src/FeedMirror.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockPricer} from "../src/mocks/MockPricer.sol";
import {IPricer} from "../src/interfaces/IPricer.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @dev ERC-1155 receiver that tries to re-enter the market from the mint callback and records what it saw.
contract ReentrantReceiver {
    AfterHoursMarket internal immutable market;
    ProtectionVault internal immutable vault;
    uint32 internal immutable uid;
    bytes public reentryError;
    uint256 public lockedSeen;
    uint256 public unearnedSeen;

    constructor(AfterHoursMarket market_, ProtectionVault vault_, uint32 uid_) {
        market = market_;
        vault = vault_;
        uid = uid_;
    }

    function buy(IERC20 usd, uint256 strike, uint64 expiry, uint256 units) external returns (uint256 id) {
        usd.approve(address(market), type(uint256).max);
        (id,) = market.buyProtection(uid, strike, expiry, units, type(uint256).max);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4) {
        lockedSeen = vault.lockedCollateral();
        unearnedSeen = vault.unearnedPremium();
        try market.buyProtection(uid, 340e8, uint64(block.timestamp + 7 days), 1e18, type(uint256).max) {}
        catch (bytes memory err) {
            reentryError = err;
        }
        return this.onERC1155Received.selector;
    }
}

/// @notice Buy-side, admin and series-bookkeeping tests.
contract AfterHoursMarketTest is BaseTest {
    // ------------------------------------------------------------------ CEI / reentrancy (item 13)

    function test_buy_mintIsLastAndReentryBlocked() public {
        ReentrantReceiver r = new ReentrantReceiver(market, vault, tsla);
        usd.mint(address(r), 1_000e6);
        r.buy(IERC20(address(usd)), 340 * P8, _week(), 10 * UNIT);
        // At the mint callback every effect and transfer had already happened...
        assertEq(r.lockedSeen(), 3_400e6);
        assertEq(r.unearnedSeen(), 72e6);
        // ...and re-entering the market was refused.
        assertEq(bytes4(r.reentryError()), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
    }

    // ------------------------------------------------------------------ closed window (item 1)

    function test_isClosedAt_window() public view {
        assertTrue(market.isClosedAt(MON0), "Mon 00:00");
        assertTrue(market.isClosedAt(MON0 + 1 hours - 1), "Mon 00:59:59");
        assertFalse(market.isClosedAt(MON0 + 1 hours), "Mon 01:00");
        assertFalse(market.isClosedAt(MON0 + 3 days), "Thu 00:00");
        assertFalse(market.isClosedAt(SAT0 - 1), "Fri 23:59:59");
        assertTrue(market.isClosedAt(SAT0), "Sat 00:00");
        assertTrue(market.isClosedAt(SAT0 + 1 days + 12 hours), "Sun 12:00");
        assertTrue(market.isClosedAt(NEXT_MON0 + 1 hours - 1), "next Mon 00:59:59");
        assertFalse(market.isClosedAt(NEXT_MON0 + 1 hours), "next Mon 01:00");
        assertTrue(market.isClosedAt(2 days), "1970-01-03 was a Saturday");
        assertFalse(market.isClosedAt(0), "1970-01-01 was a Thursday");
    }

    function testFuzz_isClosedAt_weeklyAnd49Hours(uint256 ts) public view {
        ts = bound(ts, 0, type(uint64).max);
        assertEq(market.isClosedAt(ts), market.isClosedAt(ts + 1 weeks));
        // Exactly 49 closed hours per week, measured on a whole week starting at ts' hour boundary.
        if (ts % 7 == 0) {
            uint256 h0 = ts - ts % 1 hours;
            uint256 closedHours;
            for (uint256 h; h < 168; ++h) {
                if (market.isClosedAt(h0 + h * 1 hours)) ++closedHours;
            }
            assertEq(closedHours, 49);
        }
    }

    /// @dev Expiries are refused from Friday 20:00 UTC (regular-session close; the live feeds print at most
    ///      once after it) until Monday 01:00 UTC. Sales themselves follow isClosedAt.
    function test_isDarkAt_window() public view {
        assertFalse(market.isDarkAt(FRI20 - 1), "Fri 19:59:59");
        assertTrue(market.isDarkAt(FRI20), "Fri 20:00");
        assertTrue(market.isDarkAt(SAT0 - 1), "Fri 23:59:59");
        assertTrue(market.isDarkAt(SAT0 + 1 days), "Sun 00:00");
        assertTrue(market.isDarkAt(NEXT_MON0 + 1 hours - 1), "Mon 00:59:59");
        assertFalse(market.isDarkAt(NEXT_MON0 + 1 hours), "Mon 01:00");
        assertFalse(market.isDarkAt(MON0 + 3 days + 20 hours), "Thu 20:00");
    }

    function testFuzz_isDarkAt_supersetOfClosedBy4Hours(uint256 ts) public view {
        ts = bound(ts, 0, type(uint64).max - 1 weeks);
        if (market.isClosedAt(ts)) assertTrue(market.isDarkAt(ts));
        assertEq(market.isDarkAt(ts), market.isDarkAt(ts + 1 weeks));
        if (ts % 7 == 0) {
            uint256 h0 = ts - ts % 1 hours;
            uint256 darkHours;
            for (uint256 h; h < 168; ++h) {
                if (market.isDarkAt(h0 + h * 1 hours)) ++darkHours;
            }
            assertEq(darkHours, 53);
        }
    }

    function test_buy_revertsInsideClosedWindow() public {
        uint64 expiry = uint64(NEXT_MON0 + 2 days + 15 hours); // Wed
        _push(spot, SAT0 - 10 minutes);
        uint256[3] memory closedTimes = [SAT0 + 1, SAT0 + 1 days + 20 hours, NEXT_MON0 + 59 minutes];
        for (uint256 i; i < closedTimes.length; ++i) {
            vm.warp(closedTimes[i]);
            vm.prank(buyer);
            vm.expectRevert(AfterHoursMarket.MarketClosed.selector);
            market.buyProtection(tsla, 340 * P8, expiry, UNIT, type(uint256).max);
        }
        // Friday evening just before the window: sales are still open (the expiry is next week).
        vm.warp(SAT0 - 1);
        _buy(340 * P8, expiry, UNIT);
    }

    function test_quote_revertsInsideClosedWindow() public {
        vm.warp(SAT0 + 3 hours);
        vm.expectRevert(AfterHoursMarket.MarketClosed.selector);
        market.quote(tsla, 340 * P8, uint64(NEXT_MON0 + 2 days), UNIT);
    }

    /// @dev Regression: an expiry in the Friday-evening slice (accepted before, priced with no closed time)
    ///      settled on the Monday reopen print and paid the weekend gap at weekday prices.
    function test_buy_revertsWhenExpiryInsideDarkWindow() public {
        uint64[6] memory bad = [
            uint64(FRI20), // Friday 20:00 UTC (web "friday close" preset before the fix)
            uint64(FRI20 + 30 minutes),
            uint64(SAT0 - 30 minutes), // Friday 23:30
            uint64(SAT0),
            uint64(SAT0 + 1 days + 12 hours),
            uint64(NEXT_MON0 + 30 minutes)
        ];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(buyer);
            vm.expectRevert(AfterHoursMarket.BadExpiry.selector);
            market.buyProtection(tsla, 340 * P8, bad[i], UNIT, type(uint256).max);
        }
        _buy(340 * P8, uint64(FRI20 - 30 minutes), UNIT); // Friday 19:30
        _buy(340 * P8, uint64(NEXT_MON0 + 1 hours), UNIT); // Monday 01:00
        _buy(340 * P8, uint64(NEXT_MON0 + 13 hours + 30 minutes), UNIT); // Monday 13:30 (NYSE open preset)
    }

    /// @dev Regression: minute-granular expiries opened a new series per buy and exhausted the cap.
    function test_buy_expiryMustBeOnThirtyMinuteGrid() public {
        uint64 onGrid = _week();
        uint64[3] memory bad = [onGrid + 1, onGrid + 1 minutes, onGrid + 29 minutes];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(buyer);
            vm.expectRevert(AfterHoursMarket.BadExpiry.selector);
            market.buyProtection(tsla, 340 * P8, bad[i], UNIT, type(uint256).max);
        }
        _buy(340 * P8, onGrid, UNIT);
        _buy(340 * P8, onGrid + 30 minutes, UNIT);
        assertEq(market.EXPIRY_GRID(), 30 minutes);
    }

    // ------------------------------------------------------------------ quote / buy basics

    function test_quote_matchesPricerAndLocksStrike() public view {
        (uint256 premium, uint256 collateral, uint256 s, uint256 vol,) =
            market.quote(tsla, 340 * P8, _week(), 10 * UNIT);
        assertEq(s, spot);
        assertEq(premium, 72e6); // 2% * 360 * 10
        assertEq(collateral, 3_400e6);
        assertEq(vol, 0.5e18);
    }

    function test_buy_transfersPremiumLocksCollateralMintsPosition() public {
        uint64 expiry = _week();
        uint256 vaultBefore = usd.balanceOf(address(vault));
        uint256 valueBefore = _shareValue(writer);
        (uint256 id, uint256 premium) = _buy(340 * P8, expiry, 10 * UNIT);

        assertEq(premium, 72e6);
        assertEq(usd.balanceOf(address(vault)), vaultBefore + premium);
        assertEq(vault.lockedCollateral(), 3_400e6);
        assertEq(vault.unearnedPremium(), premium);
        assertEq(market.balanceOf(buyer, id), 10 * UNIT);
        AfterHoursMarket.Series memory s = market.getSeries(id);
        assertEq(s.underlyingId, tsla);
        assertEq(s.strike, 340 * P8);
        assertEq(s.expiry, expiry);
        assertEq(s.grace, 5 days);
        assertEq(s.openUnits, 10 * UNIT);
        assertEq(s.locked, 3_400e6);
        assertEq(s.premium, premium);
        assertEq(s.timeValue, premium); // out of the money: the whole premium is time value
        assertEq(s.accrualRate, (premium * 1e18 + (expiry - block.timestamp) - 1) / (expiry - block.timestamp));
        assertEq(market.unearnedOf(id), premium);
        assertFalse(s.settled);
        uint256[] memory active = market.activeSeries(tsla);
        assertEq(active.length, 1);
        assertEq(active[0], id);
        // Premium is unearned at the sale: writers' share value does not move on a buy.
        assertEq(_shareValue(writer), valueBefore);
    }

    function test_buy_emitsEvents() public {
        uint64 expiry = _week();
        uint256 id = market.seriesId(tsla, 340 * P8, expiry);
        vm.expectEmit(true, true, false, true, address(market));
        emit AfterHoursMarket.SeriesCreated(id, tsla, 340 * P8, expiry, 5 days);
        vm.expectEmit(true, true, true, true, address(market));
        emit AfterHoursMarket.ProtectionBought(id, buyer, tsla, 340 * P8, expiry, UNIT, 7.2e6, 0, spot, 0.5e18);
        _buy(340 * P8, expiry, UNIT);
    }

    function test_buy_takesProtocolFee() public {
        _setConfig(treasury, 1_000, 1 hours, 30 days, 26 hours, 5 days, 5_000, 12_000);
        (uint256 id, uint256 premium) = _buy(340 * P8, _week(), 10 * UNIT);
        assertEq(usd.balanceOf(treasury), premium / 10);
        assertEq(vault.unearnedPremium(), premium - premium / 10);
        assertEq(market.getSeries(id).premium, premium - premium / 10);
    }

    /// @dev Regression: the fee used to come out of the whole premium, so an in-the-money sale could leave
    ///      the vault less than the intrinsic value it has to pay back. The fee is now taken from the time
    ///      value only.
    function test_buy_feeOnlyOnTimeValue() public {
        _setConfig(treasury, 2_000, 1 hours, 30 days, 26 hours, 5 days, 5_000, 12_000);
        uint64 expiry = _week();
        // strike 400 vs spot 360, 10 units: intrinsic 400, floor premium 401.8 (intrinsic + 5 bps of spot).
        uint256 id = market.seriesId(tsla, 400 * P8, expiry);
        vm.expectEmit(true, true, true, true, address(market));
        emit AfterHoursMarket.ProtectionBought(
            id, buyer, tsla, 400 * P8, expiry, 10 * UNIT, 401.8e6, 0.36e6, spot, 0.5e18
        );
        (, uint256 premium) = _buy(400 * P8, expiry, 10 * UNIT);
        assertEq(premium, 401.8e6);
        assertEq(usd.balanceOf(treasury), 0.36e6); // 20% of the 1.8 time value
        AfterHoursMarket.Series memory s = market.getSeries(id);
        assertEq(s.premium, 401.44e6);
        assertEq(s.timeValue, 1.44e6);
        assertEq(vault.unearnedPremium(), 401.44e6);
        assertGe(s.premium, 400e6, "vault keeps at least the intrinsic value");
    }

    function test_buy_revertsOnSlippage() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.PremiumTooHigh.selector, 72e6, 71e6));
        market.buyProtection(tsla, 340 * P8, _week(), 10 * UNIT, 71e6);
    }

    function test_buy_revertsOnZeroUnits() public {
        vm.prank(buyer);
        vm.expectRevert(AfterHoursMarket.ZeroUnits.selector);
        market.buyProtection(tsla, 340 * P8, _week(), 0, type(uint256).max);
    }

    function test_buy_revertsOnUnknownUnderlying() public {
        vm.prank(buyer);
        vm.expectRevert(AfterHoursMarket.UnknownUnderlying.selector);
        market.buyProtection(2, 340 * P8, _week(), UNIT, type(uint256).max);
    }

    function test_buy_revertsOnBadTenor() public {
        vm.startPrank(buyer);
        vm.expectRevert(AfterHoursMarket.BadExpiry.selector);
        market.buyProtection(tsla, 340 * P8, uint64(block.timestamp + 30 minutes), UNIT, type(uint256).max);
        vm.expectRevert(AfterHoursMarket.BadExpiry.selector);
        market.buyProtection(tsla, 340 * P8, uint64(block.timestamp + 31 days), UNIT, type(uint256).max);
        vm.stopPrank();
        _buy(340 * P8, uint64(block.timestamp + 1 hours), UNIT); // min tenor is inclusive
        _buy(340 * P8, uint64(block.timestamp + 30 days), UNIT); // max tenor is inclusive (a Wednesday)
    }

    // ------------------------------------------------------------------ series minimum (dust griefing)

    /// @dev Regression: 32 one-wei buys used to fill MAX_ACTIVE_SERIES for 32 wei of premium.
    function test_buy_newSeriesRequiresMinimumPremium() public {
        assertEq(market.minSeriesPremium(), 5e6);
        address attacker = makeAddr("attacker");
        usd.mint(attacker, 1_000e6);
        vm.prank(attacker);
        usd.approve(address(market), type(uint256).max);
        uint64 expiry = _grid(START + 29 days);
        for (uint256 i; i < 32; ++i) {
            vm.prank(attacker);
            vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.SeriesTooSmall.selector, 1, 5e6));
            market.buyProtection(tsla, (180 + i) * P8, expiry, 1, type(uint256).max);
        }
        assertEq(market.activeSeries(tsla).length, 0);
        // quote() applies the same check.
        vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.SeriesTooSmall.selector, 3.6e6, 5e6));
        market.quote(tsla, 340 * P8, expiry, UNIT / 2);
        // A $4.99 premium is refused, $5 opens the series...
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.SeriesTooSmall.selector, 4_999_999, 5e6));
        market.buyProtection(tsla, 340 * P8, expiry, 4_999_999 * UNIT / 7_200_000, type(uint256).max);
        (uint256 id,) = _buy(340 * P8, expiry, 5e6 * UNIT / 7.2e6);
        // ...and top-ups of an existing series have no minimum.
        _buy(340 * P8, expiry, 1);
        assertEq(market.getSeries(id).openUnits, 5e6 * UNIT / 7.2e6 + 1);
    }

    function test_setMinSeriesPremium_raiseIsImmediateLowerIsScheduled() public {
        market.setMinSeriesPremium(50e6);
        assertEq(market.minSeriesPremium(), 50e6);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.SeriesTooSmall.selector, 7.2e6, 50e6));
        market.buyProtection(tsla, 340 * P8, _week(), UNIT, type(uint256).max);

        bytes memory lower = abi.encodeCall(market.setMinSeriesPremium, (1e6));
        vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.NotScheduled.selector, keccak256(lower)));
        market.setMinSeriesPremium(1e6);
        _exec(lower);
        assertEq(market.minSeriesPremium(), 1e6);
        _buy(340 * P8, _week(), UNIT);

        vm.expectRevert(AfterHoursMarket.BadConfig.selector);
        market.setMinSeriesPremium(1_000e6 + 1);
        market.setMinSeriesPremium(1_000e6);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        market.setMinSeriesPremium(0);
    }

    // ------------------------------------------------------------------ strike checks (item 2)

    function test_buy_strikeMustBeWholeDollars() public {
        vm.prank(buyer);
        vm.expectRevert(AfterHoursMarket.BadStrike.selector);
        market.buyProtection(tsla, 340 * P8 + 50_000_000, _week(), UNIT, type(uint256).max); // $340.50
        vm.prank(buyer);
        vm.expectRevert(AfterHoursMarket.BadStrike.selector);
        market.buyProtection(tsla, 0, _week(), UNIT, type(uint256).max);
        _buy(341 * P8, _week(), UNIT);
    }

    function test_buy_strikeBoundsUseFeedSpot() public {
        // spot 360: 50% = 180, 120% = 432 (both inclusive)
        uint64 expiry = _week();
        vm.startPrank(buyer);
        vm.expectRevert(AfterHoursMarket.BadStrike.selector);
        market.buyProtection(tsla, 179 * P8, expiry, UNIT, type(uint256).max);
        vm.expectRevert(AfterHoursMarket.BadStrike.selector);
        market.buyProtection(tsla, 433 * P8, expiry, UNIT, type(uint256).max);
        market.buyProtection(tsla, 180 * P8, expiry, UNIT, type(uint256).max);
        market.buyProtection(tsla, 432 * P8, expiry, UNIT, type(uint256).max);
        vm.stopPrank();
    }

    function test_buy_strikeBoundsIgnorePricerSpot() public {
        // A pricer that reports a much higher spot must not widen the strike band: the market checks the
        // strike against its own feed read before it even asks the pricer.
        pricer.setSpotOverride(true, 1_000 * P8);
        vm.prank(buyer);
        vm.expectRevert(AfterHoursMarket.BadStrike.selector);
        market.buyProtection(tsla, 500 * P8, _week(), UNIT, type(uint256).max);
    }

    // ------------------------------------------------------------------ pricer trust (item 4)

    function test_buy_revertsOnPricerSpotMismatch() public {
        pricer.setSpotOverride(true, spot + 1);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.PricerSpotMismatch.selector, spot + 1, spot));
        market.buyProtection(tsla, 340 * P8, _week(), UNIT, type(uint256).max);
        pricer.setSpotOverride(false, 0);
        _buy(340 * P8, _week(), UNIT);
    }

    function test_buy_premiumFloorOtmAgainstMaliciousPricer() public {
        pricer.setPremiumOverride(true, 0);
        // floor per unit = 0 intrinsic + 360 * 5 bps = $0.18
        (, uint256 premium) = _buy(340 * P8, _week(), 100 * UNIT);
        assertEq(premium, 18e6);
    }

    function test_buy_premiumFloorItmAgainstMaliciousPricer() public {
        pricer.setPremiumOverride(true, 1);
        // strike 400 vs spot 360: floor per unit = $40 intrinsic + $0.18 = $40.18
        uint256 strike = 400 * P8;
        (, uint256 premium) = _buy(strike, _week(), 10 * UNIT);
        assertEq(premium, 401.8e6);
        // The pricer's own (higher) quote is used when it clears the floor.
        pricer.setPremiumOverride(true, 50 * P8);
        (, premium) = _buy(strike, _week(), 10 * UNIT);
        assertEq(premium, 500e6);
    }

    function testFuzz_buy_premiumNeverBelowFloor(uint256 pricerPremium, uint256 strikeDollars, uint256 units) public {
        _noMinSeries();
        pricerPremium = bound(pricerPremium, 0, 100 * P8);
        strikeDollars = bound(strikeDollars, 180, 432);
        units = bound(units, 1, 50 * UNIT);
        pricer.setPremiumOverride(true, pricerPremium);
        uint256 strike = strikeDollars * P8;
        (uint256 id, uint256 premium) = _buy(strike, _week(), units);
        uint256 floorPerUnit = (strike > spot ? strike - spot : 0) + spot * 5 / 10_000;
        assertGe(premium, _usdUp(floorPerUnit, units));
        assertGe(premium, _usdUp(pricerPremium, units));
        // The net premium always covers the intrinsic value the vault may have to pay back.
        AfterHoursMarket.Series memory s = market.getSeries(id);
        uint256 intrinsic = strike > spot ? _usdUp(strike - spot, units) : 0;
        assertGe(s.premium, intrinsic);
        assertEq(s.premium - intrinsic, s.timeValue);
    }

    function test_buy_roundsPremiumAndCollateralUp() public {
        uint256 units = UNIT + 1;
        (uint256 id, uint256 premium) = _buy(340 * P8, _week(), units);
        assertEq(premium, 7_200_001); // ceil(7.2e8 * (1e18 + 1) / 1e20)
        assertEq(market.getSeries(id).locked, 340_000_001); // ceil(340e8 * (1e18 + 1) / 1e20)
        // Dust-sized top-ups still lock at least 1 wei and pay at least 1 wei.
        (uint256 id2, uint256 p2) = _buy(340 * P8, _week(), 1);
        assertEq(id2, id);
        assertEq(p2, 1);
        assertEq(market.getSeries(id2).locked, 340_000_002);
    }

    // ------------------------------------------------------------------ feed checks (items 2, 3)

    function test_buy_revertsWhenFeedStale() public {
        vm.warp(block.timestamp + 26 hours + 61); // Tuesday
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.StalePrice.selector, START - 60));
        market.buyProtection(tsla, 340 * P8, _week(), UNIT, type(uint256).max);
        _push(spot, block.timestamp);
        _buy(340 * P8, _week(), UNIT);
    }

    /// @dev Regression: maxPriceAge could be set to 4 days, so at Monday 01:00 UTC a Friday print counted
    ///      as fresh and both sales and the vault reopened on the pre-weekend price. The cap is now 36h,
    ///      below the shortest print-to-reopen gap (48h).
    function test_maxPriceAge_cappedBelowWeekendGap() public {
        vm.expectRevert(AfterHoursMarket.BadConfig.selector);
        market.setConfig(treasury, 0, 1 hours, 30 days, 36 hours + 1, 5 days, 5_000, 12_000);
        _setConfig(treasury, 0, 1 hours, 30 days, 36 hours, 5 days, 5_000, 12_000);
        _buy(340 * P8, uint64(NEXT_MON0 + 2 days + 15 hours), UNIT);
        // Last pre-weekend print at the latest possible moment (Saturday 00:59 UTC under EST).
        _push(spot, SAT0 + 59 minutes);
        vm.warp(NEXT_MON0 + 1 hours); // Monday 01:00 UTC: window over, no reopen print yet
        assertFalse(vault.isOpen());
        assertEq(vault.maxWithdraw(writer), 0);
        vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.StalePrice.selector, SAT0 + 59 minutes));
        market.quote(tsla, 340 * P8, uint64(NEXT_MON0 + 2 days + 15 hours), UNIT);
        _push(spot, block.timestamp);
        assertTrue(vault.isOpen());
    }

    function test_buy_revertsWhenFeedPaused() public {
        vm.prank(relayer);
        feed.setPaused(true);
        vm.prank(buyer);
        vm.expectRevert(AfterHoursMarket.FeedPaused.selector);
        market.buyProtection(tsla, 340 * P8, _week(), UNIT, type(uint256).max);
        assertTrue(market.isFeedPaused(tsla));
    }

    function test_buy_revertsWhenStockTokenOraclePaused() public {
        stock.setOraclePaused(true);
        assertTrue(market.isFeedPaused(tsla));
        vm.prank(buyer);
        vm.expectRevert(AfterHoursMarket.FeedPaused.selector);
        market.buyProtection(tsla, 340 * P8, _week(), UNIT, type(uint256).max);
        stock.setOraclePaused(false);
        assertFalse(market.isFeedPaused(tsla));
        _buy(340 * P8, _week(), UNIT);
    }

    function test_pauseProbe_missingFunctionIsNotPaused() public {
        // Stock token = an EOA and = a contract without oraclePaused(): both read as not paused.
        FeedMirror feed2 = new FeedMirror("X", 8, relayer);
        vm.prank(relayer);
        feed2.pushRound(1, int256(spot), uint64(block.timestamp));
        ProtectionVault v2 = _newVault(2);
        uint32 id2 = market.addUnderlying("X", makeAddr("eoa"), IAggregatorV3(address(feed2)), _params(), v2);
        ProtectionVault v3 = _newVault(3);
        uint32 id3 = market.addUnderlying("Y", address(usd), IAggregatorV3(address(feed2)), _params(), v3);
        assertFalse(market.isFeedPaused(id2));
        assertFalse(market.isFeedPaused(id3));
        vm.startPrank(writer);
        usd.approve(address(v2), type(uint256).max);
        v2.deposit(10_000e6, writer);
        vm.stopPrank();
        vm.prank(buyer);
        market.buyProtection(id2, 340 * P8, _week(), UNIT, type(uint256).max);
    }

    function test_buy_rejectsInvalidAnswers() public {
        // A 16-decimal genesis-era answer ($396.41 scaled 1e16) is invalid and is never rescaled.
        _push(3_964_149_999_900_000_000, block.timestamp);
        vm.prank(buyer);
        vm.expectRevert(AfterHoursMarket.InvalidAnswer.selector);
        market.buyProtection(tsla, 340 * P8, _week(), UNIT, type(uint256).max);
        // $1,000,000 exactly is already invalid.
        _push(1e14, block.timestamp);
        vm.prank(buyer);
        vm.expectRevert(AfterHoursMarket.InvalidAnswer.selector);
        market.buyProtection(tsla, 340 * P8, _week(), UNIT, type(uint256).max);
        _push(spot, block.timestamp);
        _buy(340 * P8, _week(), UNIT);
    }

    // ------------------------------------------------------------------ vault capacity

    function test_buy_revertsWhenVaultLacksLiquidity() public {
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(ProtectionVault.InsufficientFreeLiquidity.selector, 340_000e6, 100_000e6)
        );
        market.buyProtection(tsla, 340 * P8, _week(), 1_000 * UNIT, type(uint256).max);
    }

    function test_buy_respectsUtilizationCap() public {
        vm.prank(buyer);
        vm.expectRevert(ProtectionVault.UtilizationTooHigh.selector);
        market.buyProtection(tsla, 340 * P8, _week(), 280 * UNIT, type(uint256).max); // 95.2%
        _buy(340 * P8, _week(), 264 * UNIT); // 89.76%
    }

    // ------------------------------------------------------------------ pause / disable (item 11)

    function test_pause_blocksBuysOnly() public {
        (uint256 id,) = _buy(340 * P8, _week(), UNIT);
        market.pause();
        vm.prank(buyer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        market.buyProtection(tsla, 340 * P8, _week(), UNIT, type(uint256).max);
        _settleAt(id, 300 * P8);
        vm.prank(buyer);
        assertEq(market.claim(id, UNIT), 40e6);
        market.unpause();
        _push(spot, block.timestamp);
        _buy(340 * P8, _week(), UNIT);
    }

    function test_disabledUnderlying_blocksBuysOnly() public {
        (uint256 id,) = _buy(340 * P8, _week(), UNIT);
        market.setUnderlying(tsla, false, _params()); // same params: applies at once
        vm.prank(buyer);
        vm.expectRevert(AfterHoursMarket.UnderlyingDisabled.selector);
        market.buyProtection(tsla, 340 * P8, _week(), UNIT, type(uint256).max);
        _settleAt(id, 300 * P8);
        vm.prank(buyer);
        assertEq(market.claim(id, UNIT), 40e6);
    }

    // ------------------------------------------------------------------ admin timelock (item 11)

    function test_setPricer_requiresSchedule() public {
        MockPricer next = new MockPricer(300);
        bytes memory data = abi.encodeCall(market.setPricer, (IPricer(address(next))));
        bytes32 id = keccak256(data);
        vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.NotScheduled.selector, id));
        market.setPricer(IPricer(address(next)));

        uint64 eta = uint64(block.timestamp + 2 days); // Monday -> Wednesday: no closed time in between
        vm.expectEmit(true, false, false, true, address(market));
        emit AfterHoursMarket.ChangeScheduled(id, data, eta);
        (bytes32 idOut, uint64 etaOut) = market.schedule(data);
        assertEq(idOut, id);
        assertEq(etaOut, eta);
        assertEq(market.scheduledEta(id), eta);

        vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.Timelocked.selector, id, eta));
        market.setPricer(IPricer(address(next)));
        vm.warp(eta - 1);
        vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.Timelocked.selector, id, eta));
        market.setPricer(IPricer(address(next)));

        vm.warp(eta);
        vm.expectEmit(true, false, false, true, address(market));
        emit AfterHoursMarket.ChangeExecuted(id);
        vm.expectEmit(false, false, false, true, address(market));
        emit AfterHoursMarket.PricerUpdated(address(next));
        market.setPricer(IPricer(address(next)));
        assertEq(address(market.pricer()), address(next));
        assertEq(market.scheduledEta(id), 0);
        // Consumed: cannot be replayed.
        vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.NotScheduled.selector, id));
        market.setPricer(IPricer(address(next)));
        // The premium now comes from the new pricer (3% instead of 2%).
        _push(spot, block.timestamp);
        (, uint256 premium) = _buy(340 * P8, _week(), 10 * UNIT);
        assertEq(premium, 108e6);
    }

    /// @dev Regression: a proposal used to be acceptable forever; now it lapses ADMIN_WINDOW after its eta.
    function test_schedule_lapsesAfterWindow() public {
        MockPricer next = new MockPricer(300);
        bytes memory data = abi.encodeCall(market.setPricer, (IPricer(address(next))));
        (bytes32 id, uint64 eta) = market.schedule(data);
        vm.warp(eta + 3 days);
        // still fine at the edge
        uint256 snap = vm.snapshotState();
        market.setPricer(IPricer(address(next)));
        vm.revertToState(snap);
        vm.warp(eta + 3 days + 1);
        vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.ScheduleExpired.selector, id, eta));
        market.setPricer(IPricer(address(next)));
    }

    function test_schedule_cancelAndOnlyOwner() public {
        IPricer next = IPricer(address(new MockPricer(300)));
        bytes memory data = abi.encodeCall(market.setPricer, (next));
        (bytes32 id, uint64 eta) = market.schedule(data);
        vm.expectEmit(true, false, false, true, address(market));
        emit AfterHoursMarket.ChangeCancelled(id);
        market.cancel(id);
        assertEq(market.scheduledEta(id), 0);
        vm.warp(eta);
        vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.NotScheduled.selector, id));
        market.setPricer(next);

        vm.expectRevert(AfterHoursMarket.BadConfig.selector);
        market.setPricer(IPricer(address(0)));

        vm.startPrank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        market.schedule(data);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        market.cancel(id);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        market.setPricer(IPricer(buyer));
        vm.stopPrank();
    }

    /// @dev Regression: 45 of the 48 timelock hours could fall inside the weekend, when writers cannot exit.
    ///      The delay now counts open-market time only.
    function test_schedule_countsOnlyOpenMarketTime() public {
        vm.warp(SAT0 - 1 hours); // Friday 23:00 UTC
        bytes memory data = abi.encodeCall(market.setPricer, (IPricer(address(new MockPricer(300)))));
        (, uint64 eta) = market.schedule(data);
        // 1h open on Friday, 49h closed, 47h open Monday 01:00 -> Wednesday 00:00 UTC.
        assertEq(eta, NEXT_MON0 + 2 days);
        assertEq(eta - block.timestamp, 97 hours);

        assertEq(market.etaAfterOpenSeconds(START, 2 days), START + 2 days);
        assertEq(market.etaAfterOpenSeconds(SAT0 + 12 hours, 1 hours), NEXT_MON0 + 2 hours);
        assertEq(market.etaAfterOpenSeconds(NEXT_MON0, 30 minutes), NEXT_MON0 + 1 hours + 30 minutes);
        assertEq(market.etaAfterOpenSeconds(START, 0), START);
        // Exactly one full open week (168h - 49h = 119h) elapses at the next Saturday 00:00.
        assertEq(market.etaAfterOpenSeconds(MON0 + 1 hours, 119 hours), SAT0);
    }

    /// @dev Regression: pricing params and config changed instantly, so the pricer timelock could be
    ///      bypassed by dropping the vol floor, buying, and restoring it.
    function test_riskIncreasingParamsRequireSchedule() public {
        AfterHoursMarket.PricingParams memory p = _params();
        p.volFloor = 0.05e18;
        bytes memory data = abi.encodeCall(market.setUnderlying, (tsla, true, p));
        vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.NotScheduled.selector, keccak256(data)));
        market.setUnderlying(tsla, true, p);
        p = _params();
        p.lookback = 31; // any lookback change is scheduled
        vm.expectRevert(
            abi.encodeWithSelector(
                AfterHoursMarket.NotScheduled.selector, keccak256(abi.encodeCall(market.setUnderlying, (tsla, true, p)))
            )
        );
        market.setUnderlying(tsla, true, p);
        // Raising floors / caps / multiplier / spread only makes protection dearer: immediate.
        p = _params();
        p.volFloor = 0.6e18;
        p.volCap = 4e18;
        p.closedVolMult = 2e18;
        p.spreadBps = 1_500;
        market.setUnderlying(tsla, true, p);
        assertEq(market.getUnderlying(tsla).params.volFloor, 0.6e18);
        // Lowering back needs the timelock.
        _setParams(tsla, true, _params());
        assertEq(market.getUnderlying(tsla).params.volFloor, 0.5e18);
    }

    function test_riskIncreasingConfigRequiresSchedule() public {
        bytes memory feeUp =
            abi.encodeCall(market.setConfig, (treasury, 500, 1 hours, 30 days, 26 hours, 5 days, 5_000, 12_000));
        vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.NotScheduled.selector, keccak256(feeUp)));
        market.setConfig(treasury, 500, 1 hours, 30 days, 26 hours, 5 days, 5_000, 12_000);
        _exec(feeUp);
        assertEq(market.protocolFeeBps(), 500);
        // Tightening the market for buyers is immediate: lower fee, shorter maxTenor, narrower strikes,
        // longer minTenor, fresher prices.
        market.setConfig(treasury, 200, 2 hours, 20 days, 12 hours, 5 days, 6_000, 11_000);
        assertEq(market.protocolFeeBps(), 200);
        assertEq(market.maxTenor(), 20 days);
        // Every loosening direction is scheduled.
        address other = makeAddr("otherTreasury");
        bytes[] memory riskier = new bytes[](6);
        riskier[0] = abi.encodeCall(market.setConfig, (other, 200, 2 hours, 20 days, 12 hours, 5 days, 6_000, 11_000));
        riskier[1] =
            abi.encodeCall(market.setConfig, (treasury, 200, 1 hours, 20 days, 12 hours, 5 days, 6_000, 11_000));
        riskier[2] =
            abi.encodeCall(market.setConfig, (treasury, 200, 2 hours, 21 days, 12 hours, 5 days, 6_000, 11_000));
        riskier[3] =
            abi.encodeCall(market.setConfig, (treasury, 200, 2 hours, 20 days, 13 hours, 5 days, 6_000, 11_000));
        riskier[4] =
            abi.encodeCall(market.setConfig, (treasury, 200, 2 hours, 20 days, 12 hours, 6 days, 6_000, 11_000));
        riskier[5] =
            abi.encodeCall(market.setConfig, (treasury, 200, 2 hours, 20 days, 12 hours, 5 days, 5_000, 11_001));
        for (uint256 i; i < riskier.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.NotScheduled.selector, keccak256(riskier[i])));
            (bool ok,) = address(market).call(riskier[i]);
            ok;
        }
        _exec(riskier[2]);
        assertEq(market.maxTenor(), 21 days);
    }

    // ------------------------------------------------------------------ config bounds (item 11)

    struct Cfg {
        address treasury;
        uint16 fee;
        uint64 minTenor;
        uint64 maxTenor;
        uint64 maxAge;
        uint64 grace;
        uint16 minStrike;
        uint16 maxStrike;
    }

    function _okCfg() internal view returns (Cfg memory) {
        return Cfg(treasury, 0, 1 hours, 30 days, 26 hours, 5 days, 5_000, 12_000);
    }

    function _setCfg(Cfg memory c) internal {
        _setConfig(c.treasury, c.fee, c.minTenor, c.maxTenor, c.maxAge, c.grace, c.minStrike, c.maxStrike);
    }

    /// @dev Bounds are checked before the timelock, so a bad config never needs to be scheduled to be refused.
    function _expectBadCfg(Cfg memory c) internal {
        vm.expectRevert(AfterHoursMarket.BadConfig.selector);
        market.setConfig(c.treasury, c.fee, c.minTenor, c.maxTenor, c.maxAge, c.grace, c.minStrike, c.maxStrike);
    }

    function test_setConfig_bounds() public {
        Cfg memory c;
        c = _okCfg();
        c.treasury = address(0);
        _expectBadCfg(c);
        c = _okCfg();
        c.fee = 2_001;
        _expectBadCfg(c);
        c = _okCfg();
        c.minTenor = 1 hours - 1;
        _expectBadCfg(c);
        c = _okCfg();
        c.minTenor = 1 days + 1;
        _expectBadCfg(c);
        c = _okCfg();
        c.minTenor = 2 hours;
        c.maxTenor = 2 hours - 1;
        _expectBadCfg(c);
        c = _okCfg();
        c.maxTenor = 90 days + 1;
        _expectBadCfg(c);
        c = _okCfg();
        c.maxAge = 1 hours - 1;
        _expectBadCfg(c);
        c = _okCfg();
        c.maxAge = 36 hours + 1;
        _expectBadCfg(c);
        c = _okCfg();
        c.grace = 4 days - 1;
        _expectBadCfg(c);
        c = _okCfg();
        c.grace = 14 days + 1;
        _expectBadCfg(c);
        c = _okCfg();
        c.minStrike = 2_999;
        _expectBadCfg(c);
        c = _okCfg();
        c.minStrike = 10_001;
        c.maxStrike = 12_000;
        _expectBadCfg(c);
        c = _okCfg();
        c.minStrike = 9_000;
        c.maxStrike = 8_999;
        _expectBadCfg(c);
        c = _okCfg();
        c.maxStrike = 15_001;
        _expectBadCfg(c);

        // Every inclusive edge is accepted.
        _setCfg(Cfg(treasury, 2_000, 1 hours, 1 hours, 1 hours, 4 days, 3_000, 3_000));
        _setCfg(Cfg(treasury, 0, 1 days, 90 days, 36 hours, 14 days, 10_000, 15_000));
        assertEq(market.settlementGrace(), 14 days);
        assertEq(market.maxStrikeBps(), 15_000);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        market.setConfig(treasury, 0, 1 hours, 30 days, 26 hours, 5 days, 5_000, 12_000);
    }

    function test_defaults() public view {
        assertEq(market.minTenor(), 1 hours);
        assertEq(market.maxTenor(), 30 days);
        assertEq(market.maxPriceAge(), 26 hours);
        assertEq(market.settlementGrace(), 5 days);
        assertEq(market.minStrikeBps(), 5_000);
        assertEq(market.maxStrikeBps(), 12_000);
        assertEq(market.minSeriesPremium(), 5e6);
        assertEq(market.STRIKE_TICK(), 1e8);
        assertEq(market.EXPIRY_GRID(), 30 minutes);
        assertEq(market.MIN_PREMIUM_BPS(), 5);
        assertEq(market.MAX_ACTIVE_SERIES(), 32);
        assertEq(market.MAX_SETTLE_WALK(), 300);
        assertEq(market.ADMIN_DELAY(), 2 days);
        assertEq(market.ADMIN_WINDOW(), 3 days);
    }

    // ------------------------------------------------------------------ pricing param bounds (item 11)

    function _expectBadParams(AfterHoursMarket.PricingParams memory p) internal {
        vm.expectRevert(AfterHoursMarket.BadParams.selector);
        market.setUnderlying(tsla, true, p);
        ProtectionVault v2 = _newVault(2);
        vm.expectRevert(AfterHoursMarket.BadParams.selector);
        market.addUnderlying("X", address(0), IAggregatorV3(address(feed)), p, v2);
    }

    function test_pricingParams_bounds() public {
        AfterHoursMarket.PricingParams memory p;
        p = _params();
        p.lookback = 9;
        _expectBadParams(p);
        p = _params();
        p.lookback = 241;
        _expectBadParams(p);
        p = _params();
        p.volFloor = 0.05e18 - 1;
        _expectBadParams(p);
        p = _params();
        p.volFloor = 5e18 + 1;
        p.volCap = 6e18;
        _expectBadParams(p);
        p = _params();
        p.volCap = p.volFloor - 1;
        _expectBadParams(p);
        p = _params();
        p.volCap = 10e18 + 1;
        _expectBadParams(p);
        p = _params();
        p.closedVolMult = 1e18 - 1;
        _expectBadParams(p);
        p = _params();
        p.closedVolMult = 5e18 + 1;
        _expectBadParams(p);
        p = _params();
        p.spreadBps = 5_001;
        _expectBadParams(p);

        // Inclusive edges pass.
        _setParams(
            tsla,
            true,
            AfterHoursMarket.PricingParams({
                lookback: 10, volFloor: 0.05e18, volCap: 0.05e18, closedVolMult: 1e18, spreadBps: 0
            })
        );
        _setParams(
            tsla,
            true,
            AfterHoursMarket.PricingParams({
                lookback: 240, volFloor: 5e18, volCap: 10e18, closedVolMult: 5e18, spreadBps: 5_000
            })
        );
        assertEq(market.getUnderlying(tsla).params.lookback, 240);
    }

    function test_setUnderlying_unknownAndOnlyOwner() public {
        vm.expectRevert(AfterHoursMarket.UnknownUnderlying.selector);
        market.setUnderlying(2, true, _params());
        vm.expectRevert(AfterHoursMarket.UnknownUnderlying.selector);
        market.getUnderlying(0);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        market.setUnderlying(tsla, false, _params());
    }

    // ------------------------------------------------------------------ addUnderlying vault binding

    function test_addUnderlying_validatesVaultAndFeed() public {
        IAggregatorV3 f = IAggregatorV3(address(feed));
        // wrong id (next id is 2)
        ProtectionVault wrongId = _newVault(3);
        vm.expectRevert(AfterHoursMarket.BadVault.selector);
        market.addUnderlying("X", address(0), f, _params(), wrongId);
        // wrong market
        ProtectionVault wrongMarket = new ProtectionVault(IERC20(address(usd)), "v", "v", address(this), 2);
        vm.expectRevert(AfterHoursMarket.BadVault.selector);
        market.addUnderlying("X", address(0), f, _params(), wrongMarket);
        // wrong asset
        MockERC20 other = new MockERC20("o", "o", 6);
        ProtectionVault wrongAsset = new ProtectionVault(IERC20(address(other)), "v", "v", address(market), 2);
        vm.expectRevert(AfterHoursMarket.BadVault.selector);
        market.addUnderlying("X", address(0), f, _params(), wrongAsset);
        // non-8-decimal feed
        FeedMirror f18 = new FeedMirror("X", 18, relayer);
        ProtectionVault ok = _newVault(2);
        vm.expectRevert(AfterHoursMarket.BadFeed.selector);
        market.addUnderlying("X", address(0), IAggregatorV3(address(f18)), _params(), ok);

        vm.expectEmit(true, false, false, true, address(market));
        emit AfterHoursMarket.UnderlyingAdded(2, "X", address(feed), address(ok), address(0));
        assertEq(market.addUnderlying("X", address(0), f, _params(), ok), 2);
        assertEq(address(market.getUnderlying(2).vault), address(ok));
        assertEq(ok.underlyingId(), 2);
        assertEq(ok.market(), address(market));
    }

    // ------------------------------------------------------------------ series accounting (items 5, 6)

    function test_multipleBuysIntoOneSeries_accumulateExactly() public {
        _setConfig(treasury, 700, 1 hours, 30 days, 26 hours, 5 days, 5_000, 12_000);
        uint64 expiry = _week();
        uint256[4] memory amounts = [UNIT + 1, 3 * UNIT + 7, 12_345_678_901_234_567, 999];
        uint256 locked;
        uint256 net;
        uint256 id;
        for (uint256 i; i < amounts.length; ++i) {
            uint256 premium;
            (id, premium) = _buy(341 * P8, expiry, amounts[i]);
            locked += _usdUp(341 * P8, amounts[i]);
            net += premium - premium * 700 / 10_000;
        }
        AfterHoursMarket.Series memory s = market.getSeries(id);
        assertEq(s.locked, locked);
        assertEq(s.premium, net);
        assertEq(s.timeValue, net);
        assertEq(vault.lockedCollateral(), locked);
        assertEq(vault.unearnedPremium(), net);
        assertEq(market.activeSeries(tsla).length, 1);
    }

    function test_activeSeries_capAndSwapPopRemoval() public {
        uint64 expiry = uint64(START + 2 days); // Wednesday 15:30
        uint256[] memory ids = new uint256[](32);
        for (uint256 i; i < 32; ++i) {
            (ids[i],) = _buy((330 + i) * P8, expiry, UNIT);
        }
        assertEq(market.activeSeries(tsla).length, 32);
        vm.prank(buyer);
        vm.expectRevert(AfterHoursMarket.TooManyActiveSeries.selector);
        market.buyProtection(tsla, 362 * P8, expiry, UNIT, type(uint256).max);
        // Existing series can still be topped up at the cap.
        _buy(335 * P8, expiry, UNIT);

        // Settle series #3: the last one is swapped into its slot.
        _push(spot, expiry + 1);
        vm.warp(expiry + 2);
        market.settle(ids[3]);
        uint256[] memory active = market.activeSeries(tsla);
        assertEq(active.length, 31);
        assertEq(active[3], ids[31]);
        for (uint256 i; i < active.length; ++i) {
            assertTrue(active[i] != ids[3]);
        }
        // Settling the (new) last element pops it without a swap.
        market.settle(ids[30]);
        active = market.activeSeries(tsla);
        assertEq(active.length, 30);
        assertEq(active[29], ids[29]);

        // Room for new series again.
        _push(spot, block.timestamp);
        _buy(340 * P8, _grid(block.timestamp + 2 days), UNIT);
        assertEq(market.activeSeries(tsla).length, 31);
    }

    function test_graceIsSnapshotPerSeries() public {
        uint64 expiry = _week();
        (uint256 a,) = _buy(340 * P8, expiry, UNIT);
        _setConfig(treasury, 0, 1 hours, 30 days, 26 hours, 10 days, 5_000, 12_000);
        (uint256 b,) = _buy(341 * P8, expiry, UNIT);
        // Changing config after creation does not move either series' grace.
        _setConfig(treasury, 0, 1 hours, 30 days, 26 hours, 4 days, 5_000, 12_000);
        assertEq(market.getSeries(a).grace, 5 days);
        assertEq(market.getSeries(b).grace, 10 days);
        // Buying more into A later does not refresh its grace either.
        _buy(340 * P8, expiry, UNIT);
        assertEq(market.getSeries(a).grace, 5 days);

        // No post-expiry print: A falls back after 5 days, B only after 10.
        vm.warp(expiry + 5 days);
        market.settle(a);
        assertTrue(market.getSeries(a).settled);
        vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.AwaitingPostExpiryPrint.selector, expiry, START - 60));
        market.settle(b);
        vm.warp(expiry + 10 days - 1);
        vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.AwaitingPostExpiryPrint.selector, expiry, START - 60));
        market.settle(b);
        vm.warp(expiry + 10 days);
        market.settle(b);
        assertTrue(market.getSeries(b).settled);
    }
}
