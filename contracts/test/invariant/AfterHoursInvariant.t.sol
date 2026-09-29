// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AfterHoursMarket} from "../../src/AfterHoursMarket.sol";
import {ProtectionVault} from "../../src/ProtectionVault.sol";
import {FeedMirror} from "../../src/FeedMirror.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockPricer} from "../../src/mocks/MockPricer.sol";
import {IPricer} from "../../src/interfaces/IPricer.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Drives the market through random buys, settlements, claims, vault flows, time and prices.
/// @dev Time is tracked in `now_` and re-applied at the start of every action so warps persist across the
///      invariant sequence.
contract Handler is Test {
    uint256 internal constant P8 = 1e8;
    uint256 internal constant UNIT = 1e18;

    AfterHoursMarket public market;
    ProtectionVault public vault;
    FeedMirror public feed;
    MockERC20 public usd;
    uint32 public uid;
    address public relayer;

    uint256 public now_;
    uint80 public lastRound;
    uint256 public price;
    uint256[] public roundTimes; // roundTimes[i] = updatedAt of round i + 1

    address[] public buyers;
    address[] public writers;
    uint256[] public allSeries;
    mapping(uint256 => bool) internal _known;

    /// @dev Call / success counters, handy when debugging a failing sequence.
    mapping(bytes32 => uint256) public calls;

    constructor(
        AfterHoursMarket market_,
        ProtectionVault vault_,
        FeedMirror feed_,
        MockERC20 usd_,
        uint32 uid_,
        address relayer_,
        uint256 start,
        uint256 price_
    ) {
        market = market_;
        vault = vault_;
        feed = feed_;
        usd = usd_;
        uid = uid_;
        relayer = relayer_;
        now_ = start;
        price = price_;
        for (uint256 i; i < 3; ++i) {
            address b = makeAddr(string.concat("buyer", vm.toString(i)));
            address w = makeAddr(string.concat("writer", vm.toString(i)));
            buyers.push(b);
            writers.push(w);
            usd.mint(b, 10_000_000e6);
            usd.mint(w, 10_000_000e6);
            vm.prank(b);
            usd.approve(address(market), type(uint256).max);
            vm.prank(w);
            usd.approve(address(vault), type(uint256).max);
        }
        _pushAt(price, start);
        vm.prank(writers[0]);
        vault.deposit(200_000e6, writers[0]);
    }

    modifier useTime() {
        vm.warp(now_);
        _;
    }

    function seriesCount() external view returns (uint256) {
        return allSeries.length;
    }

    function _pushAt(uint256 p, uint256 at) internal {
        ++lastRound;
        roundTimes.push(at);
        vm.prank(relayer);
        feed.pushRound(lastRound, int256(p), uint64(at));
    }

    // ------------------------------------------------------------------ actions

    function buy(uint256 actorSeed, uint256 strikeSeed, uint256 tenorSeed, uint256 unitsSeed) external useTime {
        calls["buy"]++;
        if (market.isClosedAt(now_)) return;
        (, int256 a,, uint256 at,) = feed.latestRoundData();
        if (at + market.maxPriceAge() < now_) {
            _pushAt(price, now_);
            a = int256(price);
        }
        uint256 s = uint256(a);
        uint256 lo = (s * market.minStrikeBps() + 10_000 * P8 - 1) / (10_000 * P8);
        uint256 hi = s * market.maxStrikeBps() / (10_000 * P8);
        if (hi < lo) return;
        uint256 strike = bound(strikeSeed, lo, hi) * P8;
        uint256 expiry = now_ + bound(tenorSeed, 1 hours, 20 days);
        while (market.isClosedAt(expiry)) expiry += 1 hours;
        if (expiry > now_ + market.maxTenor()) return;
        uint256 units = bound(unitsSeed, 1e12, 40 * UNIT);
        address b = buyers[actorSeed % buyers.length];
        vm.prank(b);
        try market.buyProtection(uid, strike, uint64(expiry), units, type(uint256).max) returns (uint256 id, uint256) {
            if (!_known[id]) {
                _known[id] = true;
                allSeries.push(id);
            }
            calls["buy.ok"]++;
        } catch {}
    }

    function settle(uint256 seriesSeed) external useTime {
        calls["settle"]++;
        if (allSeries.length == 0) return;
        uint256 id = allSeries[seriesSeed % allSeries.length];
        try market.settle(id) {
            calls["settle.ok"]++;
        } catch {}
    }

    function settleAt(uint256 seriesSeed) external useTime {
        calls["settleAt"]++;
        if (allSeries.length == 0) return;
        uint256 id = allSeries[seriesSeed % allSeries.length];
        uint64 expiry = market.getSeries(id).expiry;
        // Off-chain hint search, as the keeper does it: first round at/after expiry.
        for (uint256 i; i < roundTimes.length; ++i) {
            if (roundTimes[i] >= expiry) {
                try market.settleAt(id, uint80(i + 1)) {
                    calls["settleAt.ok"]++;
                } catch {}
                return;
            }
        }
    }

    function claim(uint256 seriesSeed, uint256 actorSeed, uint256 fracSeed) external useTime {
        calls["claim"]++;
        if (allSeries.length == 0) return;
        uint256 id = allSeries[seriesSeed % allSeries.length];
        address b = buyers[actorSeed % buyers.length];
        uint256 bal = market.balanceOf(b, id);
        if (bal == 0) return;
        uint256 units = fracSeed % 3 == 0 ? bal : bound(fracSeed, 1, bal);
        vm.prank(b);
        try market.claim(id, units) {
            calls["claim.ok"]++;
        } catch {}
    }

    function transferPosition(uint256 seriesSeed, uint256 fromSeed, uint256 toSeed, uint256 amountSeed)
        external
        useTime
    {
        if (allSeries.length == 0) return;
        uint256 id = allSeries[seriesSeed % allSeries.length];
        address from = buyers[fromSeed % buyers.length];
        address to = buyers[toSeed % buyers.length];
        uint256 bal = market.balanceOf(from, id);
        if (bal == 0) return;
        vm.prank(from);
        market.safeTransferFrom(from, to, id, bound(amountSeed, 1, bal), "");
    }

    function deposit(uint256 actorSeed, uint256 amount) external useTime {
        calls["deposit"]++;
        address w = writers[actorSeed % writers.length];
        amount = bound(amount, 1, 500_000e6);
        vm.prank(w);
        try vault.deposit(amount, w) {
            calls["deposit.ok"]++;
        } catch {}
    }

    function withdraw(uint256 actorSeed, uint256 amount, bool redeemAll) external useTime {
        calls["withdraw"]++;
        address w = writers[actorSeed % writers.length];
        if (redeemAll) {
            uint256 shares = vault.maxRedeem(w);
            if (shares == 0) return;
            vm.prank(w);
            try vault.redeem(shares, w, w) {
                calls["withdraw.ok"]++;
            } catch {}
            return;
        }
        uint256 maxW = vault.maxWithdraw(w);
        if (maxW == 0) return;
        amount = bound(amount, 1, maxW);
        vm.prank(w);
        try vault.withdraw(amount, w, w) {
            calls["withdraw.ok"]++;
        } catch {}
    }

    function warp(uint256 dt) external {
        calls["warp"]++;
        now_ += bound(dt, 1 minutes, 3 days);
        vm.warp(now_);
    }

    function pushRound(uint256 moveSeed) external useTime {
        calls["pushRound"]++;
        if (market.isClosedAt(now_)) return; // 24/5 feed is dark on weekends
        if (roundTimes[roundTimes.length - 1] >= now_) return;
        // Move up to +/-20%, keep within $50..$2,000.
        uint256 bps = bound(moveSeed, 8_000, 12_000);
        uint256 next = price * bps / 10_000;
        if (next < 50 * P8) next = 50 * P8;
        if (next > 2_000 * P8) next = 2_000 * P8;
        price = next;
        _pushAt(next, now_);
    }

    // ------------------------------------------------------------------ ghost views

    function sumOwedSettled() external view returns (uint256 total) {
        for (uint256 i; i < allSeries.length; ++i) {
            AfterHoursMarket.Series memory s = market.getSeries(allSeries[i]);
            if (s.settled) total += s.owed;
        }
    }

    function sumActive() external view returns (uint256 locked, uint256 premium) {
        uint256[] memory active = market.activeSeries(uid);
        for (uint256 i; i < active.length; ++i) {
            AfterHoursMarket.Series memory s = market.getSeries(active[i]);
            locked += s.locked;
            premium += s.premium;
        }
    }

    function unsettledNotActive() external view returns (uint256 n) {
        uint256[] memory active = market.activeSeries(uid);
        for (uint256 i; i < allSeries.length; ++i) {
            AfterHoursMarket.Series memory s = market.getSeries(allSeries[i]);
            bool isActive;
            for (uint256 j; j < active.length; ++j) {
                if (active[j] == allSeries[i]) isActive = true;
            }
            if (s.settled == isActive) ++n; // settled must be inactive; unsettled must be active
        }
    }
}

/// @notice Protocol-wide accounting invariants:
///           vault balance >= lockedCollateral + unearnedPremium
///           market balance >= sum of owed over settled series
///           lockedCollateral == sum of s.locked over active series
///           unearnedPremium == sum of s.premium over active series
/// forge-config: default.invariant.runs = 128
/// forge-config: default.invariant.depth = 64
contract AfterHoursInvariantTest is Test {
    AfterHoursMarket internal market;
    ProtectionVault internal vault;
    FeedMirror internal feed;
    MockERC20 internal usd;
    Handler internal handler;

    function setUp() public {
        uint256 start = 1_789_400_000; // Monday 2026-09-14 15:33:20 UTC
        vm.warp(start);
        address relayer = makeAddr("relayer");
        usd = new MockERC20("Test USD", "tUSD", 6);
        feed = new FeedMirror("RHTSLA / USD", 8, relayer);
        MockPricer pricer = new MockPricer(150);
        market = new AfterHoursMarket(IERC20(address(usd)), IPricer(address(pricer)), makeAddr("treasury"), "");
        market.setConfig(makeAddr("treasury"), 500, 1 hours, 30 days, 26 hours, 5 days, 5_000, 12_000);
        vault = new ProtectionVault(IERC20(address(usd)), "AfterHours TSLA Writer", "ahTSLA", address(market), 1);
        uint32 uid = market.addUnderlying(
            "TSLA",
            address(0),
            IAggregatorV3(address(feed)),
            AfterHoursMarket.PricingParams({
                lookback: 30, volFloor: 0.5e18, volCap: 3e18, closedVolMult: 1.5e18, spreadBps: 1_000
            }),
            vault
        );
        // The handler pushes round 1 and seeds the vault with 200k.
        handler = new Handler(market, vault, feed, usd, uid, relayer, start, 360e8);

        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = Handler.buy.selector;
        selectors[1] = Handler.settle.selector;
        selectors[2] = Handler.settleAt.selector;
        selectors[3] = Handler.claim.selector;
        selectors[4] = Handler.deposit.selector;
        selectors[5] = Handler.withdraw.selector;
        selectors[6] = Handler.warp.selector;
        selectors[7] = Handler.pushRound.selector;
        selectors[8] = Handler.transferPosition.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_vaultBalanceCoversLockedAndUnearned() public view {
        assertGe(usd.balanceOf(address(vault)), vault.lockedCollateral() + vault.unearnedPremium());
    }

    function invariant_marketEscrowCoversOwed() public view {
        assertGe(usd.balanceOf(address(market)), handler.sumOwedSettled());
    }

    function invariant_lockedEqualsSumOfActiveSeries() public view {
        (uint256 locked,) = handler.sumActive();
        assertEq(vault.lockedCollateral(), locked);
    }

    function invariant_unearnedEqualsSumOfActivePremium() public view {
        (, uint256 premium) = handler.sumActive();
        assertEq(vault.unearnedPremium(), premium);
    }

    function invariant_activeListMatchesUnsettledSeries() public view {
        assertEq(handler.unsettledNotActive(), 0);
        assertLe(market.activeSeries(1).length, market.MAX_ACTIVE_SERIES());
    }

    /// @dev Scripted walk proving every handler action can succeed; the fuzzed campaign would otherwise
    ///      pass vacuously if the handler's calls always reverted inside its try/catch blocks.
    function test_handlerActionsSucceed() public {
        handler.deposit(1, 100_000e6);
        handler.buy(0, 350, 3 days, 10e18); // Thursday expiry, OTM
        handler.buy(1, 400, 3 days, 5e18); // same expiry, ITM
        handler.warp(1 hours);
        handler.pushRound(9_000); // -10%
        handler.withdraw(0, 1_000e6, false);
        handler.warp(3 days); // past expiry
        handler.pushRound(10_000);
        handler.settle(0);
        handler.settleAt(1);
        handler.claim(0, 0, 0);
        handler.claim(1, 1, 0);
        handler.withdraw(0, 0, true);

        assertEq(handler.calls("buy.ok"), 2);
        assertEq(handler.calls("settle.ok"), 1);
        assertEq(handler.calls("settleAt.ok"), 1);
        assertEq(handler.calls("claim.ok"), 2);
        assertEq(handler.calls("deposit.ok"), 1);
        assertEq(handler.calls("withdraw.ok"), 2);
        // buyer1's $400 put settled at $324: payout 5 x $76 = $380 exceeds the ~$201 premium it paid.
        assertGt(usd.balanceOf(makeAddr("buyer1")), 10_000_000e6);
        invariant_vaultBalanceCoversLockedAndUnearned();
        invariant_marketEscrowCoversOwed();
        invariant_lockedEqualsSumOfActiveSeries();
        invariant_unearnedEqualsSumOfActivePremium();
        invariant_activeListMatchesUnsettledSeries();
        assertEq(vault.lockedCollateral(), 0);
        assertEq(usd.balanceOf(address(market)), 0);
    }

    /// @dev Share accounting never exceeds the assets backing it.
    function invariant_totalAssetsWithinCapital() public view {
        assertLe(vault.totalAssets(), vault.capital());
    }
}
