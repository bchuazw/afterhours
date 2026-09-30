// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {AfterHoursMarket} from "../src/AfterHoursMarket.sol";
import {ProtectionVault} from "../src/ProtectionVault.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

/// @dev Aggregator whose missing rounds read as all-zero instead of reverting (some Chainlink
///      aggregator versions behave like this).
contract ZeroGapFeed is IAggregatorV3 {
    struct R {
        int256 answer;
        uint256 updatedAt;
    }

    mapping(uint80 => R) internal _r;
    uint80 public latest;

    function set(uint80 id, int256 answer, uint256 updatedAt) external {
        _r[id] = R(answer, updatedAt);
        if (id > latest) latest = id;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function description() external pure returns (string memory) {
        return "zero-gap";
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return getRoundData(latest);
    }

    function getRoundData(uint80 id) public view returns (uint80, int256, uint256, uint256, uint80) {
        R memory x = _r[id];
        return (id, x.answer, x.updatedAt, x.updatedAt, id);
    }
}

/// @notice settle / settleAt / claim, and how settlement moves value between vault, escrow and holders.
contract SettlementTest is BaseTest {
    int256 internal constant GENESIS_ANSWER = 3_964_149_999_900_000_000; // $396.41 scaled 1e16

    function _pushPostExpiry(uint64 expiry, uint256 n) internal {
        uint80[] memory ids = new uint80[](n);
        int256[] memory answers = new int256[](n);
        uint64[] memory ats = new uint64[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = ++lastRound;
            answers[i] = i == 0 ? int256(300 * P8) : int256(350 * P8);
            ats[i] = uint64(expiry + 1 + i);
        }
        vm.prank(relayer);
        feed.pushRounds(ids, answers, ats);
    }

    // ------------------------------------------------------------------ basic guards

    function test_settle_revertsBeforeExpiry() public {
        (uint256 id,) = _buy(340 * P8, _week(), UNIT);
        vm.expectRevert(AfterHoursMarket.NotExpired.selector);
        market.settle(id);
        vm.expectRevert(AfterHoursMarket.NotExpired.selector);
        market.settleAt(id, 1);
    }

    function test_settle_unknownAndAlreadySettled() public {
        vm.expectRevert(AfterHoursMarket.UnknownSeries.selector);
        market.settle(123);
        vm.expectRevert(AfterHoursMarket.UnknownSeries.selector);
        market.settleAt(123, 1);
        (uint256 id,) = _buy(340 * P8, _week(), UNIT);
        _settleAt(id, 300 * P8);
        vm.expectRevert(AfterHoursMarket.AlreadySettled.selector);
        market.settle(id);
        vm.expectRevert(AfterHoursMarket.AlreadySettled.selector);
        market.settleAt(id, lastRound);
    }

    // ------------------------------------------------------------------ first print at/after expiry (item 7)

    function test_settle_waitsForPostExpiryPrint() public {
        uint64 expiry = _week();
        (uint256 id,) = _buy(340 * P8, expiry, UNIT);
        _push(300 * P8, expiry - 1);
        vm.warp(expiry + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.AwaitingPostExpiryPrint.selector, expiry, expiry - 1));
        market.settle(id);
        _push(320 * P8, expiry + 2 hours);
        vm.warp(expiry + 2 hours);
        market.settle(id);
        assertEq(market.getSeries(id).settlePrice, 320 * P8);
    }

    function test_settle_printExactlyAtExpiryCounts() public {
        uint64 expiry = _week();
        (uint256 id,) = _buy(340 * P8, expiry, UNIT);
        _push(310 * P8, expiry - 1);
        uint80 at = _push(320 * P8, expiry);
        _push(330 * P8, expiry + 1);
        vm.warp(expiry + 1);
        vm.expectEmit(true, false, false, true, address(market));
        emit AfterHoursMarket.SeriesSettled(id, 320 * P8, at, false, 20e6, 320e6);
        market.settle(id);
    }

    function test_settle_usesFirstPostExpiryPrintNotLatest() public {
        uint64 expiry = _week();
        (uint256 id,) = _buy(340 * P8, expiry, UNIT);
        _push(350 * P8, expiry - 3 hours); // pre-expiry, ignored
        _push(320 * P8, expiry + 5 minutes); // first post-expiry print
        _push(300 * P8, expiry + 1 hours);
        _push(290 * P8, expiry + 3 hours); // latest, more favourable to the buyer
        vm.warp(expiry + 4 hours);
        market.settle(id);
        assertEq(market.getSeries(id).settlePrice, 320 * P8);
    }

    function test_settle_fallbackAfterGrace() public {
        uint64 expiry = _week();
        (uint256 id,) = _buy(340 * P8, expiry, UNIT);
        _push(300 * P8, expiry - 1);
        vm.warp(expiry + 5 days - 1);
        vm.expectRevert(abi.encodeWithSelector(AfterHoursMarket.AwaitingPostExpiryPrint.selector, expiry, expiry - 1));
        market.settle(id);
        vm.warp(expiry + 5 days);
        vm.expectEmit(true, false, false, true, address(market));
        emit AfterHoursMarket.SeriesSettled(id, 300 * P8, 2, true, 40e6, 300e6);
        market.settle(id);
    }

    // ------------------------------------------------------------------ pause handling (items 3, 7)

    function test_settle_pausedRevertsOnlyBeforeGrace() public {
        uint64 expiry = _week();
        (uint256 id,) = _buy(340 * P8, expiry, UNIT);
        uint80 first = _push(300 * P8, expiry + 1);
        _push(280 * P8, expiry + 2);
        vm.prank(relayer);
        feed.setPaused(true);
        vm.warp(expiry + 1 hours);
        vm.expectRevert(AfterHoursMarket.FeedPaused.selector);
        market.settle(id);
        vm.expectRevert(AfterHoursMarket.FeedPaused.selector);
        market.settleAt(id, first);

        // Pause flag on the Stock Token blocks settlement the same way.
        vm.prank(relayer);
        feed.setPaused(false);
        stock.setOraclePaused(true);
        vm.expectRevert(AfterHoursMarket.FeedPaused.selector);
        market.settle(id);
        vm.warp(expiry + 5 days - 1);
        vm.expectRevert(AfterHoursMarket.FeedPaused.selector);
        market.settle(id);

        // Past grace the pause no longer blocks: normal first-print rules apply.
        vm.warp(expiry + 5 days);
        vm.expectEmit(true, false, false, true, address(market));
        emit AfterHoursMarket.SeriesSettled(id, 300 * P8, first, false, 40e6, 300e6);
        market.settle(id);
    }

    function test_settle_pausedBeyondGraceFallsBack() public {
        uint64 expiry = _week();
        (uint256 id,) = _buy(340 * P8, expiry, UNIT);
        uint80 last = _push(310 * P8, expiry - 1 hours);
        vm.prank(relayer);
        feed.setPaused(true);
        vm.warp(expiry + 5 days);
        vm.expectEmit(true, false, false, true, address(market));
        emit AfterHoursMarket.SeriesSettled(id, 310 * P8, last, true, 30e6, 310e6);
        market.settle(id);
    }

    // ------------------------------------------------------------------ invalid answers (item 7)

    function test_settle_skipsInvalidFirstPrint() public {
        uint64 expiry = _week();
        (uint256 a,) = _buy(340 * P8, expiry, UNIT);
        (uint256 b,) = _buy(341 * P8, expiry, UNIT);
        uint80 bad = ++lastRound;
        _pushRaw(bad, GENESIS_ANSWER, expiry + 1);
        uint80 good = _push(310 * P8, expiry + 2);
        uint80 later = _push(320 * P8, expiry + 3);
        vm.warp(expiry + 3);
        vm.expectRevert(AfterHoursMarket.BadRoundHint.selector);
        market.settleAt(a, bad); // invalid answer can never be used
        vm.expectRevert(AfterHoursMarket.BadRoundHint.selector);
        market.settleAt(a, later); // a valid post-expiry round precedes it
        vm.expectEmit(true, false, false, true, address(market));
        emit AfterHoursMarket.SeriesSettled(a, 310 * P8, good, false, 30e6, 310e6);
        market.settle(a);
        // settleAt accepts the same round settle() picks: the walk steps over the invalid print.
        vm.expectEmit(true, false, false, true, address(market));
        emit AfterHoursMarket.SeriesSettled(b, 310 * P8, good, false, 31e6, 310e6);
        market.settleAt(b, good);
    }

    /// @dev Regression: with an invalid first post-expiry round and a walk longer than MAX_SETTLE_WALK,
    ///      settle() reverted and settleAt rejected every hint, so the series (and the vault) froze forever.
    function test_settleAt_walksOverInvalidPostExpiryRounds() public {
        uint64 expiry = _week();
        (uint256 id,) = _buy(340 * P8, expiry, UNIT);
        uint80 pre = _push(350 * P8, expiry - 1 hours);
        uint80 bad = ++lastRound;
        _pushRaw(bad, GENESIS_ANSWER, expiry + 1); // first post-expiry round: 16-decimal answer
        uint80 bad2 = ++lastRound;
        _pushRaw(bad2, 1e14, expiry + 2); // second: $1,000,000, also invalid
        uint80 first = _push(300 * P8, expiry + 3); // first *valid* post-expiry round
        for (uint256 i; i < 301; ++i) {
            _push(350 * P8, expiry + 4 + i); // 301 more valid rounds: settle()'s walk is too long
        }
        vm.warp(expiry + 1 hours);

        vm.expectRevert(AfterHoursMarket.SettleWalkTooLong.selector);
        market.settle(id);
        vm.expectRevert(AfterHoursMarket.BadRoundHint.selector);
        market.settleAt(id, pre);
        vm.expectRevert(AfterHoursMarket.BadRoundHint.selector);
        market.settleAt(id, bad);
        vm.expectRevert(AfterHoursMarket.BadRoundHint.selector);
        market.settleAt(id, bad2);
        vm.expectRevert(AfterHoursMarket.BadRoundHint.selector);
        market.settleAt(id, first + 1); // `first` is valid and earlier
        vm.expectEmit(true, false, false, true, address(market));
        emit AfterHoursMarket.SeriesSettled(id, 300 * P8, first, false, 40e6, 300e6);
        market.settleAt(id, first);
        assertTrue(vault.isOpen());
    }

    /// @dev Regression: across a phase change settleAt accepted both the old phase's first post-expiry
    ///      round and the new phase's index 1, so the caller picked the price. Hints must now be in the
    ///      latest phase, which is the phase settle() walks.
    function test_settleAt_rejectsHintsOutsideLatestPhase() public {
        uint64 expiry = _week();
        (uint256 a,) = _buy(340 * P8, expiry, UNIT);
        (uint256 b,) = _buy(341 * P8, expiry, UNIT);
        _push(345 * P8, expiry - 1 hours);
        uint80 oldFirst = _push(300 * P8, expiry + 5); // old aggregator keeps printing past expiry
        uint80 p2first = uint80((uint256(2) << 64) | 1);
        _pushRaw(p2first, int256(350 * P8), expiry + 10);
        vm.warp(expiry + 1 hours);

        vm.expectRevert(AfterHoursMarket.BadRoundHint.selector);
        market.settleAt(a, oldFirst);
        market.settleAt(a, p2first);
        market.settle(b);
        assertEq(market.getSeries(a).settlePrice, 350 * P8);
        assertEq(market.getSeries(b).settlePrice, 350 * P8);

        // Variant: the old aggregator prints again days later; still not a valid hint.
        (uint256 c,) = _buy(342 * P8, _week(), UNIT);
        uint64 expiryC = market.getSeries(c).expiry;
        uint80 oldLate = _push(200 * P8, expiryC + 3 days);
        _pushRaw(uint80((uint256(2) << 64) | 2), int256(360 * P8), expiryC + 5);
        vm.warp(expiryC + 4 days);
        vm.expectRevert(AfterHoursMarket.BadRoundHint.selector);
        market.settleAt(c, oldLate);
        market.settle(c);
        assertEq(market.getSeries(c).settlePrice, 360 * P8);
    }

    /// @dev Regression: an expiry in the Friday-evening slice (accepted before) was priced as weekday risk
    ///      but settled on the Monday reopen print, paying the weekend gap. Such expiries are refused; an
    ///      expiry at Friday 19:30 UTC is followed by live prints and settles on them.
    function test_fridayExpiry_neverSettlesOnMondayReopen() public {
        vm.warp(FRI20 - 2 hours); // Friday 18:00 UTC
        _push(spot, block.timestamp - 60);
        vm.prank(buyer);
        vm.expectRevert(AfterHoursMarket.BadExpiry.selector);
        market.buyProtection(tsla, 360 * P8, uint64(FRI20), 100 * UNIT, type(uint256).max);
        vm.prank(buyer);
        vm.expectRevert(AfterHoursMarket.BadExpiry.selector);
        market.buyProtection(tsla, 360 * P8, uint64(SAT0 - 30 minutes), 100 * UNIT, type(uint256).max);

        uint64 expiry = uint64(FRI20 - 30 minutes); // Friday 19:30 UTC
        (uint256 id,) = _buy(360 * P8, expiry, 100 * UNIT);
        _push(355 * P8, expiry + 3 minutes); // regular session still open: prints follow
        _push(300 * P8, NEXT_MON0 + 40); // Monday reopen after a weekend gap
        vm.warp(NEXT_MON0 + 60);
        market.settle(id);
        assertEq(market.getSeries(id).settlePrice, 355 * P8);
        assertEq(market.getSeries(id).owed, 500e6);
    }

    function test_settle_onlyInvalidPostExpiryPrintReverts() public {
        uint64 expiry = _week();
        (uint256 id,) = _buy(340 * P8, expiry, UNIT);
        _pushRaw(++lastRound, GENESIS_ANSWER, expiry + 1);
        vm.warp(expiry + 1 hours);
        vm.expectRevert(AfterHoursMarket.InvalidAnswer.selector);
        market.settle(id);
        // $1,000,000 exactly is also invalid (no rescaling of any kind).
        _pushRaw(++lastRound, 1e14, expiry + 2);
        vm.expectRevert(AfterHoursMarket.InvalidAnswer.selector);
        market.settle(id);
        _push(330 * P8, expiry + 3);
        market.settle(id);
        assertEq(market.getSeries(id).settlePrice, 330 * P8);
    }

    function test_settle_fallbackSkipsInvalidLatest() public {
        uint64 expiry = _week();
        (uint256 id,) = _buy(340 * P8, expiry, UNIT);
        uint80 good = _push(300 * P8, expiry - 2 hours);
        _pushRaw(++lastRound, GENESIS_ANSWER, expiry - 1 hours);
        vm.warp(expiry + 5 days);
        vm.expectEmit(true, false, false, true, address(market));
        emit AfterHoursMarket.SeriesSettled(id, 300 * P8, good, true, 40e6, 300e6);
        market.settle(id);
    }

    // ------------------------------------------------------------------ walk-back bound and hints (item 7)

    function test_settle_walksBack300Rounds() public {
        uint64 expiry = _week();
        (uint256 id,) = _buy(340 * P8, expiry, UNIT);
        _pushPostExpiry(expiry, 300); // rounds 2..301
        vm.warp(expiry + 1 hours);
        market.settle(id);
        assertEq(market.getSeries(id).settlePrice, 300 * P8);
    }

    function test_settle_walkTooLong_thenSettleAtHint() public {
        uint64 expiry = _week();
        (uint256 id,) = _buy(340 * P8, expiry, UNIT);
        _pushPostExpiry(expiry, 301); // rounds 2..302
        vm.warp(expiry + 1 hours);
        vm.expectRevert(AfterHoursMarket.SettleWalkTooLong.selector);
        market.settle(id);
        vm.expectEmit(true, false, false, true, address(market));
        emit AfterHoursMarket.SeriesSettled(id, 300 * P8, 2, false, 40e6, 300e6);
        market.settleAt(id, 2);
    }

    function test_settleAt_rejectsBadHints() public {
        uint64 expiry = _week();
        (uint256 id,) = _buy(340 * P8, expiry, UNIT);
        uint80 pre = _push(350 * P8, expiry - 1 hours);
        uint80 first = _push(320 * P8, expiry + 1);
        uint80 second = _push(310 * P8, expiry + 2);
        vm.warp(expiry + 1 hours);

        vm.expectRevert(AfterHoursMarket.BadRoundHint.selector);
        market.settleAt(id, second); // predecessor is also post-expiry
        vm.expectRevert(AfterHoursMarket.BadRoundHint.selector);
        market.settleAt(id, pre); // before expiry
        vm.expectRevert(AfterHoursMarket.BadRoundHint.selector);
        market.settleAt(id, 1); // index 1 but before expiry
        vm.expectRevert(AfterHoursMarket.BadRoundHint.selector);
        market.settleAt(id, second + 1); // newer than latest

        market.settleAt(id, first);
        assertEq(market.getSeries(id).settlePrice, 320 * P8);
    }

    function test_settle_missingPredecessorReverts_thenBackfill() public {
        uint64 expiry = _week();
        (uint256 id,) = _buy(340 * P8, expiry, UNIT);
        _pushRaw(10, int256(320 * P8), expiry + 1); // rounds 2..9 missing
        vm.warp(expiry + 1 hours);
        vm.expectRevert(AfterHoursMarket.SettleWalkTooLong.selector);
        market.settle(id);
        vm.expectRevert(AfterHoursMarket.BadRoundHint.selector);
        market.settleAt(id, 10);
        vm.expectRevert(AfterHoursMarket.BadRoundHint.selector);
        market.settleAt(id, 5); // missing round itself
        _pushRaw(9, int256(330 * P8), expiry - 1); // relayer backfills the gap
        market.settleAt(id, 10);
        assertEq(market.getSeries(id).settlePrice, 320 * P8);
    }

    function test_settle_zeroPredecessorReverts() public {
        ZeroGapFeed zg = new ZeroGapFeed();
        zg.set(1, int256(spot), block.timestamp - 60);
        ProtectionVault v2 = _newVault(2);
        uint32 u2 = market.addUnderlying("ZG", address(0), IAggregatorV3(address(zg)), _params(), v2);
        vm.startPrank(writer);
        usd.approve(address(v2), type(uint256).max);
        v2.deposit(10_000e6, writer);
        vm.stopPrank();
        uint64 expiry = _week();
        vm.prank(buyer);
        (uint256 id,) = market.buyProtection(u2, 340 * P8, expiry, UNIT, type(uint256).max);

        zg.set(5, int256(320 * P8), expiry + 1); // round 4 reads as zeros
        vm.warp(expiry + 1 hours);
        vm.expectRevert(AfterHoursMarket.SettleWalkTooLong.selector);
        market.settle(id);
        vm.expectRevert(AfterHoursMarket.BadRoundHint.selector);
        market.settleAt(id, 5);
        zg.set(4, int256(330 * P8), expiry - 1);
        market.settle(id);
        assertEq(market.getSeries(id).settlePrice, 320 * P8);
    }

    function test_settle_stopsAtPhaseStart() public {
        uint64 expiry = _week();
        (uint256 a,) = _buy(340 * P8, expiry, UNIT);
        (uint256 b,) = _buy(341 * P8, expiry, UNIT);
        // Aggregator upgrade after expiry: phase 2 starts at index 1 and has no predecessor.
        uint80 p2first = uint80((uint256(2) << 64) | 1);
        uint80 p2second = uint80((uint256(2) << 64) | 2);
        _pushRaw(p2first, int256(310 * P8), expiry + 10);
        _pushRaw(p2second, int256(320 * P8), expiry + 20);
        vm.warp(expiry + 1 hours);

        vm.expectEmit(true, false, false, true, address(market));
        emit AfterHoursMarket.SeriesSettled(a, 310 * P8, p2first, false, 30e6, 310e6);
        market.settle(a);

        vm.expectRevert(AfterHoursMarket.BadRoundHint.selector);
        market.settleAt(b, uint80(uint256(2) << 64)); // index 0 is never a round
        vm.expectRevert(AfterHoursMarket.BadRoundHint.selector);
        market.settleAt(b, p2second);
        market.settleAt(b, p2first); // index 1 needs no predecessor
        assertEq(market.getSeries(b).settlePrice, 310 * P8);
    }

    // ------------------------------------------------------------------ settlement accounting (items 8, 9)

    function test_settleOtm_freesAllCollateralWithoutClaims() public {
        (uint256 id, uint256 premium) = _buy(340 * P8, _week(), 10 * UNIT);
        assertEq(vault.lockedCollateral(), 3_400e6);

        uint64 expiry = market.getSeries(id).expiry;
        _push(380 * P8, expiry + 1);
        vm.warp(expiry + 2);
        vm.expectEmit(true, false, false, true, address(market));
        emit AfterHoursMarket.SeriesSettled(id, 380 * P8, lastRound, false, 0, 3_400e6);
        market.settle(id);

        // Nobody has claimed, yet all collateral is free and the premium is earned.
        assertEq(market.balanceOf(buyer, id), 10 * UNIT);
        assertEq(vault.lockedCollateral(), 0);
        assertEq(vault.unearnedPremium(), 0);
        assertEq(usd.balanceOf(address(market)), 0);
        assertEq(market.activeSeries(tsla).length, 0);
        AfterHoursMarket.Series memory s = market.getSeries(id);
        assertEq(s.locked, 0);
        assertEq(s.owed, 0);
        assertTrue(s.settled);
        assertEq(vault.totalAssets(), 100_000e6 + premium);
        assertTrue(vault.isOpen());

        uint256 shares = vault.balanceOf(writer);
        assertEq(vault.maxRedeem(writer), shares);
        vm.prank(writer);
        uint256 out = vault.redeem(shares, writer, writer);
        assertApproxEqAbs(out, 100_000e6 + premium, 1);
    }

    function test_settleItm_escrowsOwedInMarket() public {
        (uint256 id, uint256 premium) = _buy(340 * P8, _week(), 10 * UNIT);
        uint64 expiry = market.getSeries(id).expiry;
        _push(300 * P8, expiry + 1);
        vm.warp(expiry + 2);
        vm.expectEmit(true, false, false, true, address(market));
        emit AfterHoursMarket.SeriesSettled(id, 300 * P8, lastRound, false, 400e6, 3_000e6);
        market.settle(id);

        assertEq(usd.balanceOf(address(market)), 400e6);
        assertEq(market.getSeries(id).owed, 400e6);
        assertEq(vault.lockedCollateral(), 0);
        assertEq(usd.balanceOf(address(vault)), 100_000e6 + premium - 400e6);
        assertEq(vault.totalAssets(), 100_000e6 + premium - 400e6);

        uint256 vaultBal = usd.balanceOf(address(vault));
        uint256 buyerBefore = usd.balanceOf(buyer);
        vm.prank(buyer);
        assertEq(market.claim(id, 10 * UNIT), 400e6);
        assertEq(usd.balanceOf(buyer), buyerBefore + 400e6);
        assertEq(usd.balanceOf(address(vault)), vaultBal, "claims never touch the vault");
        assertEq(usd.balanceOf(address(market)), 0);
    }

    function test_itmSettle_lowersAllWritersAtOnce_firstExiterGainsNothing() public {
        address writer2 = makeAddr("writer2");
        usd.mint(writer2, 100_000e6);
        vm.startPrank(writer2);
        usd.approve(address(vault), type(uint256).max);
        vault.deposit(100_000e6, writer2);
        vm.stopPrank();

        (uint256 id,) = _buy(340 * P8, _week(), 100 * UNIT); // premium 720, collateral 34,000
        uint64 expiry = market.getSeries(id).expiry;
        uint256 v1 = _shareValue(writer);
        uint256 v2 = _shareValue(writer2);
        assertApproxEqAbs(v1, 100_000e6, 1);

        // Expired but unsettled: nobody can exit at the stale value.
        _push(300 * P8, expiry + 1);
        vm.warp(expiry + 2);
        assertEq(vault.maxRedeem(writer), 0);
        assertEq(vault.maxWithdraw(writer), 0);

        market.settle(id); // owed = 4,000; premium 720 earned
        uint256 loss = (4_000e6 - 720e6) / 2;
        assertApproxEqAbs(_shareValue(writer), v1 - loss, 2);
        assertApproxEqAbs(_shareValue(writer2), v2 - loss, 2);

        uint256 s1 = vault.balanceOf(writer);
        uint256 s2 = vault.balanceOf(writer2);
        vm.prank(writer);
        uint256 out1 = vault.redeem(s1, writer, writer);
        vm.prank(writer2);
        uint256 out2 = vault.redeem(s2, writer2, writer2);
        assertApproxEqAbs(out1, out2, 2);
        assertApproxEqAbs(out1, 100_000e6 - loss, 2);
    }

    function test_markToMarket_firstExiterBeforeExpiryGainsNothing() public {
        address writer2 = makeAddr("writer2");
        usd.mint(writer2, 100_000e6);
        vm.startPrank(writer2);
        usd.approve(address(vault), type(uint256).max);
        vault.deposit(100_000e6, writer2);
        vm.stopPrank();

        (uint256 id,) = _buy(340 * P8, _week(), 100 * UNIT);
        uint64 expiry = market.getSeries(id).expiry;
        // Spot falls after an hour: the open put is marked at intrinsic (4,000) plus its still-unearned
        // premium (720 less one hour of accrual).
        _push(300 * P8, block.timestamp + 1 hours);
        vm.warp(block.timestamp + 1 hours);
        uint256 unearned = market.unearnedOf(id);
        assertApproxEqAbs(unearned, uint256(720e6) * (7 days - 1 hours) / 7 days, 1);
        assertEq(vault.liability(), 4_000e6 + unearned);
        uint256 s1 = vault.balanceOf(writer);
        vm.prank(writer);
        uint256 out1 = vault.redeem(s1, writer, writer); // exits before anyone settles

        _push(300 * P8, expiry + 1);
        vm.warp(expiry + 2);
        market.settle(id);
        uint256 s2 = vault.balanceOf(writer2);
        vm.prank(writer2);
        uint256 out2 = vault.redeem(s2, writer2, writer2);
        // Both carry half the 4,000 loss; the exiting writer takes only the hour of premium it earned and
        // the writer who stays through expiry earns the rest.
        assertApproxEqAbs(out1, 100_000e6 - 2_000e6 + (720e6 - unearned) / 2, 2);
        assertApproxEqAbs(out2 - out1, unearned, 2);
        assertApproxEqAbs(out1 + out2, 200_000e6 - 4_000e6 + 720e6, 2);
    }

    function test_claims_proRataSumExactlyToOwed() public {
        (uint256 id,) = _buy(341 * P8, _week(), 10 * UNIT);
        address h2 = makeAddr("h2");
        address h3 = makeAddr("h3");
        uint256 third = 3_333_333_333_333_333_333;
        vm.startPrank(buyer);
        market.safeTransferFrom(buyer, h2, id, third, "");
        market.safeTransferFrom(buyer, h3, id, third, "");
        vm.stopPrank();
        _settleAt(id, 300 * P8);
        uint256 owed = market.getSeries(id).owed;
        assertEq(owed, 410e6);

        vm.prank(h2);
        uint256 p2 = market.claim(id, third);
        vm.prank(h3);
        uint256 p3 = market.claim(id, third);
        vm.prank(buyer);
        uint256 p1 = market.claim(id, 10 * UNIT - 2 * third);
        assertEq(p1 + p2 + p3, owed);
        assertEq(p2, 136_666_666);
        assertEq(usd.balanceOf(address(market)), 0);
        AfterHoursMarket.Series memory s = market.getSeries(id);
        assertEq(s.owed, 0);
        assertEq(s.openUnits, 0);
    }

    function testFuzz_claims_sumToOwed(uint256 units, uint256 a, uint256 b, uint256 price, bool reverseOrder) public {
        _noMinSeries();
        units = bound(units, 3, 100 * UNIT);
        a = bound(a, 1, units - 2);
        b = bound(b, 1, units - a - 1);
        price = bound(price, 1, 339 * P8);
        (uint256 id,) = _buy(340 * P8, _week(), units);
        address h2 = makeAddr("h2");
        address h3 = makeAddr("h3");
        vm.startPrank(buyer);
        market.safeTransferFrom(buyer, h2, id, a, "");
        market.safeTransferFrom(buyer, h3, id, b, "");
        vm.stopPrank();
        _settleAt(id, price);
        uint256 owed = market.getSeries(id).owed;
        assertLe(owed, _usdUp(340 * P8, units));

        uint256 total;
        if (reverseOrder) {
            vm.prank(buyer);
            total += market.claim(id, units - a - b);
        }
        vm.prank(h3);
        total += market.claim(id, b);
        vm.prank(h2);
        total += market.claim(id, a);
        if (!reverseOrder) {
            vm.prank(buyer);
            total += market.claim(id, units - a - b);
        }
        assertEq(total, owed);
        assertEq(usd.balanceOf(address(market)), 0);
    }

    function test_multipleBuys_neverOverRelease() public {
        uint64 expiry = _week();
        uint256[5] memory amounts = [UNIT + 1, 3 * UNIT + 7, 12_345_678_901_234_567, 999, 7 * UNIT / 3];
        uint256 premiums;
        uint256 id;
        uint256 idOtm;
        uint256 totalUnits;
        for (uint256 i; i < amounts.length; ++i) {
            uint256 p;
            (id, p) = _buy(341 * P8, expiry, amounts[i]);
            premiums += p;
            (idOtm, p) = _buy(250 * P8, expiry, amounts[i]);
            premiums += p;
            totalUnits += amounts[i];
            // price wiggles between buys
            _push((360 + i) * P8, block.timestamp + 1);
            vm.warp(block.timestamp + 1);
        }
        uint256 locked = market.getSeries(id).locked + market.getSeries(idOtm).locked;
        assertEq(vault.lockedCollateral(), locked);

        _push(299 * P8, expiry + 1);
        vm.warp(expiry + 2);
        market.settle(id);
        market.settle(idOtm);
        uint256 owed = market.getSeries(id).owed;
        assertEq(owed, _usd(42 * P8, totalUnits));
        assertEq(market.getSeries(idOtm).owed, 0);
        assertEq(vault.lockedCollateral(), 0);
        assertEq(vault.unearnedPremium(), 0);
        assertEq(usd.balanceOf(address(vault)), 100_000e6 + premiums - owed);

        uint256 vaultBal = usd.balanceOf(address(vault));
        vm.startPrank(buyer);
        for (uint256 i; i < amounts.length; ++i) {
            market.claim(id, amounts[i]);
            market.claim(idOtm, amounts[i]);
        }
        vm.stopPrank();
        assertEq(usd.balanceOf(address(vault)), vaultBal);
        assertEq(usd.balanceOf(address(market)), 0);
        assertEq(market.getSeries(id).owed, 0);
    }

    // ------------------------------------------------------------------ claim

    function test_claim_reverts() public {
        (uint256 id,) = _buy(340 * P8, _week(), UNIT);
        vm.prank(buyer);
        vm.expectRevert(AfterHoursMarket.NotSettled.selector);
        market.claim(id, UNIT);
        _settleAt(id, 300 * P8);
        vm.prank(buyer);
        vm.expectRevert(AfterHoursMarket.ZeroUnits.selector);
        market.claim(id, 0);
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InsufficientBalance.selector, writer, 0, UNIT, id));
        market.claim(id, UNIT);
    }

    function test_claim_otmBurnsForZero() public {
        (uint256 id,) = _buy(340 * P8, _week(), 10 * UNIT);
        _settleAt(id, 380 * P8);
        vm.prank(buyer);
        assertEq(market.claim(id, 10 * UNIT), 0);
        assertEq(market.balanceOf(buyer, id), 0);
        assertEq(market.getSeries(id).openUnits, 0);
    }

    function test_payoutsRoundDown() public {
        // Collateral rounded up to 340_000_001; intrinsic 40 * (1e18 + 1) / 1e20 = 40e6 + 4e-12 -> 40e6.
        (uint256 id,) = _buy(340 * P8, _week(), UNIT + 1);
        _settleAt(id, 300 * P8);
        AfterHoursMarket.Series memory s = market.getSeries(id);
        assertEq(s.owed, 40e6);
        vm.prank(buyer);
        assertEq(market.claim(id, UNIT + 1), 40e6);
    }

    function test_payoutOf() public {
        (uint256 id,) = _buy(340 * P8, _week(), 10 * UNIT);
        vm.expectRevert(AfterHoursMarket.NotSettled.selector);
        market.payoutOf(id, UNIT);
        _settleAt(id, 300 * P8);
        assertEq(market.payoutOf(id, 5 * UNIT), 200e6);
        assertEq(market.payoutOf(id, 10 * UNIT), 400e6);
        vm.prank(buyer);
        market.claim(id, 5 * UNIT);
        assertEq(market.payoutOf(id, 5 * UNIT), 200e6);
    }

    function testFuzz_payoutNeverExceedsCollateral(uint256 strikeDollars, uint256 settle, uint256 units) public {
        _noMinSeries();
        strikeDollars = bound(strikeDollars, 180, 432);
        units = bound(units, 1, 100 * UNIT);
        settle = bound(settle, 1, 1e14 - 1);
        uint256 strike = strikeDollars * P8;
        (uint256 id,) = _buy(strike, _week(), units);
        uint256 lockedBefore = vault.lockedCollateral();
        _settleAt(id, settle);
        vm.prank(buyer);
        uint256 payout = market.claim(id, units);
        assertLe(payout, lockedBefore);
        assertEq(vault.lockedCollateral(), 0);
        assertEq(usd.balanceOf(address(market)), 0);
        assertGe(usd.balanceOf(address(vault)), vault.lockedCollateral() + vault.unearnedPremium());
    }
}
