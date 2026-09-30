// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AfterHoursMarket} from "../src/AfterHoursMarket.sol";
import {ProtectionVault} from "../src/ProtectionVault.sol";
import {FeedMirror} from "../src/FeedMirror.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockPricer} from "../src/mocks/MockPricer.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";
import {IPricer} from "../src/interfaces/IPricer.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Shared fixture: one underlying (TSLA) on a FeedMirror, a 100k writer vault, spot $360.
///         Time starts on a weekday, on the expiry grid: Monday 2026-09-14 15:30:00 UTC.
abstract contract BaseTest is Test {
    uint256 internal constant P8 = 1e8;
    uint256 internal constant UNIT = 1e18;
    uint256 internal constant GRID = 30 minutes;
    /// @dev Monday 2026-09-14 00:00:00 UTC.
    uint256 internal constant MON0 = 1_789_344_000;
    /// @dev Monday 2026-09-14 15:30:00 UTC (so START + whole days stays on the 30-minute expiry grid).
    uint256 internal constant START = MON0 + 15 hours + 30 minutes;
    /// @dev Saturday 2026-09-19 00:00:00 UTC (closed window opens).
    uint256 internal constant SAT0 = MON0 + 5 days;
    /// @dev Friday 2026-09-18 20:00:00 UTC (expiry dark window opens).
    uint256 internal constant FRI20 = SAT0 - 4 hours;
    /// @dev Monday 2026-09-21 00:00:00 UTC.
    uint256 internal constant NEXT_MON0 = MON0 + 7 days;

    MockERC20 internal usd;
    FeedMirror internal feed;
    MockPricer internal pricer;
    MockStockToken internal stock;
    AfterHoursMarket internal market;
    ProtectionVault internal vault;
    uint32 internal tsla;

    address internal writer = makeAddr("writer");
    address internal buyer = makeAddr("buyer");
    address internal treasury = makeAddr("treasury");
    address internal relayer = makeAddr("relayer");

    uint256 internal spot = 360 * P8;
    uint80 internal lastRound;

    function setUp() public virtual {
        vm.warp(START);
        usd = new MockERC20("Test USD", "tUSD", 6);
        feed = new FeedMirror("RHTSLA / USD", 8, relayer);
        pricer = new MockPricer(200); // premium = 2% of spot per unit
        stock = new MockStockToken("Tesla Stock Token", "TSLA");
        market = new AfterHoursMarket(IERC20(address(usd)), IPricer(address(pricer)), treasury, "ipfs://x/{id}");

        _push(spot, block.timestamp - 60);
        vault = _newVault(1);
        tsla = market.addUnderlying("TSLA", address(stock), IAggregatorV3(address(feed)), _params(), vault);

        usd.mint(writer, 1_000_000e6);
        usd.mint(buyer, 1_000_000e6);
        vm.startPrank(writer);
        usd.approve(address(vault), type(uint256).max);
        vault.deposit(100_000e6, writer);
        vm.stopPrank();
        vm.prank(buyer);
        usd.approve(address(market), type(uint256).max);
    }

    // ------------------------------------------------------------------ helpers

    function _params() internal pure returns (AfterHoursMarket.PricingParams memory) {
        return AfterHoursMarket.PricingParams({
            lookback: 30, volFloor: 0.5e18, volCap: 3e18, closedVolMult: 1.5e18, spreadBps: 1_000
        });
    }

    function _newVault(uint32 id) internal returns (ProtectionVault) {
        return new ProtectionVault(IERC20(address(usd)), "AfterHours TSLA Writer", "ahTSLA", address(market), id);
    }

    /// @dev Push the next sequential round on the TSLA mirror.
    function _push(uint256 price, uint256 at) internal returns (uint80 id) {
        id = ++lastRound;
        vm.prank(relayer);
        feed.pushRound(id, int256(price), uint64(at));
    }

    function _pushRaw(uint80 id, int256 answer, uint256 at) internal {
        vm.prank(relayer);
        feed.pushRound(id, answer, uint64(at));
    }

    function _buy(uint256 strike, uint64 expiry, uint256 units) internal returns (uint256 id, uint256 premium) {
        vm.prank(buyer);
        (id, premium) = market.buyProtection(tsla, strike, expiry, units, type(uint256).max);
    }

    /// @dev Mirror of AfterHoursMarket.isDarkAt (pure, so helpers never consume a pending prank/expectRevert).
    function _isDark(uint256 ts) internal pure returns (bool) {
        uint256 dow = (ts / 1 days + 4) % 7;
        return dow == 6 || dow == 0 || (dow == 1 && ts % 1 days < 1 hours) || (dow == 5 && ts % 1 days >= 20 hours);
    }

    /// @dev First allowed expiry at or after `t`: on the 30-minute grid and outside the dark window.
    function _grid(uint256 t) internal pure returns (uint64) {
        t = (t + GRID - 1) / GRID * GRID;
        while (_isDark(t)) t += GRID;
        return uint64(t);
    }

    function _week() internal view returns (uint64) {
        return _grid(block.timestamp + 7 days);
    }

    /// @dev Print `price` one second after expiry, move past it and settle.
    function _settleAt(uint256 id, uint256 price) internal {
        uint64 expiry = market.getSeries(id).expiry;
        _push(price, expiry + 1);
        vm.warp(expiry + 2);
        market.settle(id);
    }

    /// @dev Schedule an admin change, execute it once its timelock has elapsed, then return to the present.
    function _exec(bytes memory data) internal {
        (, uint64 eta) = market.schedule(data);
        uint256 now_ = block.timestamp;
        vm.warp(eta);
        (bool ok, bytes memory ret) = address(market).call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        vm.warp(now_);
    }

    function _setConfig(
        address treasury_,
        uint16 fee,
        uint64 minTenor,
        uint64 maxTenor,
        uint64 maxAge,
        uint64 grace,
        uint16 minStrike,
        uint16 maxStrike
    ) internal {
        _exec(
            abi.encodeCall(market.setConfig, (treasury_, fee, minTenor, maxTenor, maxAge, grace, minStrike, maxStrike))
        );
    }

    function _setParams(uint32 id, bool enabled, AfterHoursMarket.PricingParams memory p) internal {
        _exec(abi.encodeCall(market.setUnderlying, (id, enabled, p)));
    }

    function _setPricer(IPricer p) internal {
        _exec(abi.encodeCall(market.setPricer, (p)));
    }

    /// @dev Drop the series-opening premium minimum (for tests that need dust-sized new series).
    function _noMinSeries() internal {
        _exec(abi.encodeCall(market.setMinSeriesPremium, (0)));
    }

    function _usd(uint256 price8, uint256 units) internal pure returns (uint256) {
        return price8 * units / 1e20;
    }

    function _usdUp(uint256 price8, uint256 units) internal pure returns (uint256) {
        return (price8 * units + 1e20 - 1) / 1e20;
    }

    function _shareValue(address who) internal view returns (uint256) {
        return vault.convertToAssets(vault.balanceOf(who));
    }
}
