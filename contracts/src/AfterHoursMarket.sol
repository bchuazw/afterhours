// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IAggregatorV3, IPausableFeed} from "./interfaces/IAggregatorV3.sol";
import {IPricer} from "./interfaces/IPricer.sol";
import {IMarketVaultState} from "./interfaces/IMarketVaultState.sol";
import {ProtectionVault} from "./ProtectionVault.sol";

/// @title AfterHoursMarket
/// @notice Fully collateralized, cash-settled downside protection (European puts) on Robinhood Chain
///         Stock Tokens. Stock Tokens trade 24/7 onchain while their Chainlink feeds run 24/5, so a
///         holder carries unhedgeable gap risk every weekend. AfterHours lets them buy protection
///         priced onchain from the feed's own history, and lets stablecoin writers earn the premium.
///
///         Lifecycle:
///           buyProtection -> (expiry) -> settle / settleAt (first valid feed print at/after expiry)
///             -> vault releases collateral, owed payout moves to market escrow -> claim
///
///         Positions are ERC-1155 tokens keyed by (underlying, strike, expiry) so they are transferable
///         and composable. 1e18 position units = protection on 1 Stock Token. Feed prices are per token
///         and already include the token's uiMultiplier, so corporate actions do not change units.
///
///         Sales stop while the feeds are dark (Saturday 00:00 UTC -> Monday 01:00 UTC, the union of the
///         Friday 20:00 ET -> Sunday 20:00 ET window across US daylight saving) and no series may expire
///         inside that window, so every expiry is followed by a live print.
contract AfterHoursMarket is ERC1155, Ownable2Step, Pausable, ReentrancyGuard, IMarketVaultState {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    struct PricingParams {
        uint32 lookback; // rounds of history used for realized vol
        uint64 volFloor; // 1e18 = 100% annualized
        uint64 volCap;
        uint64 closedVolMult; // 1e18 = 1.0x; applied to vol during closed-market hours
        uint16 spreadBps; // writer spread on top of fair value
    }

    struct Underlying {
        string symbol;
        address stockToken; // Robinhood Stock Token; probed for oraclePaused() (corporate actions)
        IAggregatorV3 feed;
        ProtectionVault vault;
        PricingParams params;
        bool enabled;
    }

    struct Series {
        uint32 underlyingId;
        uint64 expiry;
        uint64 grace; // settlementGrace snapshot taken when the series was created
        bool settled;
        uint256 strike; // 8 decimals
        uint256 openUnits; // 1e18 units outstanding (not yet claimed)
        uint256 locked; // exact collateral locked in the vault by buys (asset units); 0 once settled
        uint256 premium; // exact net premium sent to the vault by buys (asset units)
        uint256 settlePrice; // 8 decimals, 0 until settled
        uint256 owed; // payout escrowed in this contract for unclaimed units (asset units)
    }

    struct Quote {
        uint256 premium;
        uint256 collateral;
        uint256 spot;
        uint256 vol;
        uint256 closedSeconds;
    }

    // ---------------------------------------------------------------------------------------------
    // Constants / storage
    // ---------------------------------------------------------------------------------------------

    /// @notice Max rounds read while walking back to the first post-expiry print.
    uint256 public constant MAX_SETTLE_WALK = 300;
    /// @notice Strikes are whole dollars.
    uint256 public constant STRIKE_TICK = 1e8;
    /// @notice Premium floor enforced independently of the pricer: intrinsic + 5 bps of spot per unit.
    uint256 public constant MIN_PREMIUM_BPS = 5;
    /// @notice Bound on open series per underlying (keeps vault mark-to-market O(32)).
    uint256 public constant MAX_ACTIVE_SERIES = 32;
    /// @notice Delay between proposing and accepting a new pricer.
    uint256 public constant PRICER_TIMELOCK = 2 days;
    /// @dev 8-decimal answers at or above $1,000,000 are invalid (e.g. mis-scaled genesis-era rounds).
    int256 internal constant MAX_ANSWER = 1e14;
    uint256 internal constant INDEX_MASK = type(uint64).max;

    IERC20 public immutable asset; // quote asset (USDG / test USD)
    /// @dev price8 * units18 / _unitDiv = asset units; _unitDiv = 10 ** (26 - asset decimals).
    uint256 internal immutable _unitDiv;
    IPricer public pricer;
    IPricer public pendingPricer;
    uint64 public pendingPricerEta;
    address public treasury;
    uint16 public protocolFeeBps; // taken from premium

    uint64 public minTenor = 1 hours;
    uint64 public maxTenor = 30 days;
    /// @notice Buys are rejected if the feed's latest print is older than this (the closed window already
    ///         blocks weekend sales, so this only has to cover weekday gaps and holidays).
    uint64 public maxPriceAge = 26 hours;
    /// @notice If no post-expiry print arrives within a series' grace (snapshot of this at creation), the
    ///         series may be settled at the latest valid price so collateral never strands.
    uint64 public settlementGrace = 5 days;
    /// @notice Strike bounds relative to the feed spot, in bps.
    uint16 public minStrikeBps = 5_000;
    uint16 public maxStrikeBps = 12_000;

    uint32 public underlyingCount;
    mapping(uint32 => Underlying) internal _underlyings;
    mapping(uint256 => Series) internal _series;
    mapping(uint32 => uint256[]) internal _active;
    mapping(uint256 => uint256) internal _activePos; // index in _active + 1; 0 = not active

    // ---------------------------------------------------------------------------------------------
    // Events / errors
    // ---------------------------------------------------------------------------------------------

    event UnderlyingAdded(uint32 indexed id, string symbol, address feed, address vault, address stockToken);
    event UnderlyingUpdated(uint32 indexed id, bool enabled, PricingParams params);
    event SeriesCreated(
        uint256 indexed seriesId, uint32 indexed underlyingId, uint256 strike, uint64 expiry, uint64 grace
    );
    event ProtectionBought(
        uint256 indexed seriesId,
        address indexed buyer,
        uint32 indexed underlyingId,
        uint256 strike,
        uint64 expiry,
        uint256 units,
        uint256 premium,
        uint256 fee,
        uint256 spot,
        uint256 vol
    );
    event SeriesSettled(
        uint256 indexed seriesId, uint256 settlePrice, uint80 roundId, bool fallbackUsed, uint256 owed, uint256 released
    );
    event Claimed(uint256 indexed seriesId, address indexed holder, uint256 units, uint256 payout);
    event PricerProposed(address indexed pricer, uint64 eta);
    event PricerUpdated(address pricer);
    event ConfigUpdated();

    error UnknownUnderlying();
    error UnderlyingDisabled();
    error UnknownSeries();
    error MarketClosed();
    error BadExpiry();
    error BadStrike();
    error ZeroUnits();
    error StalePrice(uint256 updatedAt);
    error FeedPaused();
    error InvalidAnswer();
    error PricerSpotMismatch(uint256 pricerSpot, uint256 feedSpot);
    error PremiumTooHigh(uint256 premium, uint256 maxPremium);
    error TooManyActiveSeries();
    error NotExpired();
    error AlreadySettled();
    error NotSettled();
    error AwaitingPostExpiryPrint(uint64 expiry, uint256 lastUpdate);
    error SettleWalkTooLong();
    error BadRoundHint();
    error BadConfig();
    error BadParams();
    error BadFeed();
    error BadVault();
    error NoPendingPricer();
    error PricerTimelocked(uint64 eta);

    // ---------------------------------------------------------------------------------------------
    // Constructor / admin
    // ---------------------------------------------------------------------------------------------

    constructor(IERC20 asset_, IPricer pricer_, address treasury_, string memory uri_)
        ERC1155(uri_)
        Ownable(msg.sender)
    {
        if (treasury_ == address(0)) revert BadConfig();
        asset = asset_;
        _unitDiv = 10 ** (26 - uint256(IERC20Metadata(address(asset_)).decimals()));
        pricer = pricer_;
        treasury = treasury_;
    }

    /// @notice Register a new underlying with its (pre-deployed) writer vault. The vault must have been
    ///         constructed for this market, this market's asset and id `underlyingCount + 1`.
    function addUnderlying(
        string calldata symbol,
        address stockToken,
        IAggregatorV3 feed,
        PricingParams calldata params,
        ProtectionVault vault
    ) external onlyOwner returns (uint32 id) {
        if (feed.decimals() != 8) revert BadFeed();
        _checkParams(params);
        id = underlyingCount + 1;
        if (vault.market() != address(this) || vault.underlyingId() != id || vault.asset() != address(asset)) {
            revert BadVault();
        }
        underlyingCount = id;
        _underlyings[id] = Underlying({
            symbol: symbol, stockToken: stockToken, feed: feed, vault: vault, params: params, enabled: true
        });
        emit UnderlyingAdded(id, symbol, address(feed), address(vault), stockToken);
    }

    /// @notice Enable/disable sales and update pricing parameters. Disabling only blocks new buys;
    ///         settle / settleAt / claim always work.
    function setUnderlying(uint32 id, bool enabled, PricingParams calldata params) external onlyOwner {
        if (id == 0 || id > underlyingCount) revert UnknownUnderlying();
        _checkParams(params);
        _underlyings[id].enabled = enabled;
        _underlyings[id].params = params;
        emit UnderlyingUpdated(id, enabled, params);
    }

    /// @notice Start the timelock for a new pricer. Proposing address(0) cancels a pending proposal.
    function proposePricer(IPricer newPricer) external onlyOwner {
        uint64 eta = uint64(block.timestamp + PRICER_TIMELOCK);
        pendingPricer = newPricer;
        pendingPricerEta = eta;
        emit PricerProposed(address(newPricer), eta);
    }

    /// @notice Activate the pending pricer once its timelock has elapsed.
    function acceptPricer() external onlyOwner {
        IPricer next = pendingPricer;
        if (address(next) == address(0)) revert NoPendingPricer();
        if (block.timestamp < pendingPricerEta) revert PricerTimelocked(pendingPricerEta);
        pricer = next;
        delete pendingPricer;
        delete pendingPricerEta;
        emit PricerUpdated(address(next));
    }

    function setConfig(
        address treasury_,
        uint16 protocolFeeBps_,
        uint64 minTenor_,
        uint64 maxTenor_,
        uint64 maxPriceAge_,
        uint64 settlementGrace_,
        uint16 minStrikeBps_,
        uint16 maxStrikeBps_
    ) external onlyOwner {
        if (
            treasury_ == address(0) || protocolFeeBps_ > 2_000 || minTenor_ < 1 hours || minTenor_ > 1 days
                || maxTenor_ < minTenor_ || maxTenor_ > 90 days || maxPriceAge_ < 1 hours || maxPriceAge_ > 4 days
                || settlementGrace_ < 4 days || settlementGrace_ > 14 days || minStrikeBps_ < 3_000
                || minStrikeBps_ > 10_000 || maxStrikeBps_ < minStrikeBps_ || maxStrikeBps_ > 15_000
        ) revert BadConfig();
        treasury = treasury_;
        protocolFeeBps = protocolFeeBps_;
        minTenor = minTenor_;
        maxTenor = maxTenor_;
        maxPriceAge = maxPriceAge_;
        settlementGrace = settlementGrace_;
        minStrikeBps = minStrikeBps_;
        maxStrikeBps = maxStrikeBps_;
        emit ConfigUpdated();
    }

    /// @notice Pausing blocks new buys only; settlement and claims keep working.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice True inside the weekly window where the 24/5 feeds may be dark: Saturday 00:00 UTC through
    ///         Monday 01:00 UTC (conservative union of Fri 20:00 ET -> Sun 20:00 ET across US DST).
    function isClosedAt(uint256 ts) public pure returns (bool) {
        uint256 dow = (ts / 1 days + 4) % 7; // 0 = Sunday .. 6 = Saturday
        return dow == 6 || dow == 0 || (dow == 1 && ts % 1 days < 1 hours);
    }

    function seriesId(uint32 underlyingId, uint256 strike, uint64 expiry) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(underlyingId, strike, expiry)));
    }

    function getUnderlying(uint32 id) external view returns (Underlying memory) {
        if (id == 0 || id > underlyingCount) revert UnknownUnderlying();
        return _underlyings[id];
    }

    function getSeries(uint256 id) external view returns (Series memory) {
        return _series[id];
    }

    /// @notice Unsettled series of an underlying (unordered).
    function activeSeries(uint32 underlyingId) external view returns (uint256[] memory) {
        return _active[underlyingId];
    }

    /// @notice Whether the feed or the Stock Token of `underlyingId` reports oraclePaused().
    function isFeedPaused(uint32 underlyingId) external view returns (bool) {
        return _isPaused(_underlyings[underlyingId]);
    }

    /// @notice Quote protection for `units` (1e18 = 1 Stock Token) of `underlyingId` at `strike` until
    ///         `expiry`. Runs every check buyProtection runs.
    /// @return premium       Total premium in asset units (rounded up; protocol fee is carved out of it).
    /// @return collateral    Collateral the vault must lock (strike * units, rounded up), asset units.
    /// @return spot          Feed spot used, 8 decimals.
    /// @return vol           Effective annualized vol, 1e18 = 100%.
    /// @return closedSeconds Closed-market seconds until expiry.
    function quote(uint32 underlyingId, uint256 strike, uint64 expiry, uint256 units)
        external
        view
        returns (uint256 premium, uint256 collateral, uint256 spot, uint256 vol, uint256 closedSeconds)
    {
        (, Quote memory q) = _quote(underlyingId, strike, expiry, units);
        return (q.premium, q.collateral, q.spot, q.vol, q.closedSeconds);
    }

    /// @notice Payout for `units` of a settled series if claimed now, asset units.
    function payoutOf(uint256 id, uint256 units) external view returns (uint256) {
        Series storage s = _series[id];
        if (!s.settled) revert NotSettled();
        uint256 open = s.openUnits;
        if (units >= open) return s.owed;
        return Math.mulDiv(s.owed, units, open);
    }

    /// @inheritdoc IMarketVaultState
    /// @dev liability = sum over active series of max(0, min(locked, intrinsic(spot) * openUnits) - premium).
    ///      Netting each series' own unearned premium keeps the vault's share price unchanged by a sale
    ///      (premium >= intrinsic is enforced at buy time), so an in-the-money sale cannot be used to push
    ///      the share price down ahead of a deposit. An invalid latest answer marks at spot 0 (worst case).
    function vaultState(uint32 underlyingId) external view returns (bool open, uint256 liability) {
        uint256[] storage list = _active[underlyingId];
        uint256 n = list.length;
        if (n == 0) return (true, 0);
        Underlying storage u = _underlyings[underlyingId];
        (, int256 answer,, uint256 updatedAt,) = u.feed.latestRoundData();
        bool valid = _valid(answer);
        uint256 spot = valid ? uint256(answer) : 0;
        open = valid && !isClosedAt(block.timestamp) && updatedAt + maxPriceAge >= block.timestamp && !_isPaused(u);
        for (uint256 i; i < n; ++i) {
            Series storage s = _series[list[i]];
            if (s.expiry <= block.timestamp) open = false;
            if (s.strike > spot) {
                uint256 mark = Math.min(s.locked, _toAsset(s.strike - spot, s.openUnits, Math.Rounding.Floor));
                if (mark > s.premium) liability += mark - s.premium;
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Core
    // ---------------------------------------------------------------------------------------------

    /// @notice Buy protection. Premium is pulled from the caller in the quote asset.
    /// @param maxPremium Slippage guard; reverts if the onchain quote exceeds it.
    function buyProtection(uint32 underlyingId, uint256 strike, uint64 expiry, uint256 units, uint256 maxPremium)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 id, uint256 premium)
    {
        (Underlying storage u, Quote memory q) = _quote(underlyingId, strike, expiry, units);
        premium = q.premium;
        if (premium > maxPremium) revert PremiumTooHigh(premium, maxPremium);
        uint256 fee = premium * protocolFeeBps / 10_000;
        uint256 net = premium - fee;

        id = seriesId(underlyingId, strike, expiry);
        Series storage s = _series[id];
        if (s.expiry == 0) _createSeries(id, s, underlyingId, strike, expiry);
        s.openUnits += units;
        s.locked += q.collateral;
        s.premium += net;

        // Interactions: reserve collateral + book unearned premium, move premium, then mint last.
        ProtectionVault vault = u.vault;
        vault.lock(q.collateral, net);
        asset.safeTransferFrom(msg.sender, address(vault), net);
        if (fee > 0) asset.safeTransferFrom(msg.sender, treasury, fee);

        emit ProtectionBought(id, msg.sender, underlyingId, strike, expiry, units, premium, fee, q.spot, q.vol);
        _mint(msg.sender, id, units, "");
    }

    /// @notice Settle a series at the first valid feed print at or after expiry. Anyone may call.
    /// @dev Walks back from the latest round; reverts SettleWalkTooLong if that takes more than
    ///      MAX_SETTLE_WALK reads or hits a gap, in which case callers use settleAt with a round hint.
    ///      With no post-expiry print, waits until expiry + grace and then uses the latest valid answer.
    function settle(uint256 id) external nonReentrant {
        (Series storage s, IAggregatorV3 feed) = _settleable(id);
        (uint80 roundId, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        uint64 expiry = s.expiry;
        if (updatedAt < expiry) {
            if (block.timestamp < uint256(expiry) + s.grace) revert AwaitingPostExpiryPrint(expiry, updatedAt);
            (uint80 rid, uint256 price) = _latestValid(feed, roundId, answer);
            _finalize(id, s, price, rid, true);
        } else {
            (uint80 rid, uint256 price) = _firstValidAtOrAfter(feed, roundId, answer, expiry);
            _finalize(id, s, price, rid, false);
        }
    }

    /// @notice Settle a series at `roundId`, which must be the first print at or after expiry: its answer is
    ///         valid, it is not newer than the latest round, and it is either the first round of its phase
    ///         or its predecessor exists and is older than expiry.
    function settleAt(uint256 id, uint80 roundId) external nonReentrant {
        (Series storage s, IAggregatorV3 feed) = _settleable(id);
        (uint80 latestId,,,,) = feed.latestRoundData();
        uint256 index = roundId & INDEX_MASK;
        if (roundId > latestId || index == 0) revert BadRoundHint();
        (bool found, int256 answer, uint256 updatedAt) = _tryRound(feed, roundId);
        uint64 expiry = s.expiry;
        if (!found || updatedAt < expiry || !_valid(answer)) revert BadRoundHint();
        if (index != 1) {
            (bool ok,, uint256 prevAt) = _tryRound(feed, roundId - 1);
            if (!ok || prevAt == 0 || prevAt >= expiry) revert BadRoundHint();
        }
        _finalize(id, s, uint256(answer), roundId, false);
    }

    /// @notice Burn settled positions and collect their pro-rata share of the escrowed payout.
    function claim(uint256 id, uint256 units) external nonReentrant returns (uint256 payout) {
        Series storage s = _series[id];
        if (!s.settled) revert NotSettled();
        if (units == 0) revert ZeroUnits();
        _burn(msg.sender, id, units);
        uint256 open = s.openUnits;
        uint256 owed = s.owed;
        payout = units == open ? owed : Math.mulDiv(owed, units, open);
        s.owed = owed - payout;
        s.openUnits = open - units;
        if (payout > 0) asset.safeTransfer(msg.sender, payout);
        emit Claimed(id, msg.sender, units, payout);
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _quote(uint32 underlyingId, uint256 strike, uint64 expiry, uint256 units)
        internal
        view
        returns (Underlying storage u, Quote memory q)
    {
        if (underlyingId == 0 || underlyingId > underlyingCount) revert UnknownUnderlying();
        u = _underlyings[underlyingId];
        if (!u.enabled) revert UnderlyingDisabled();
        if (isClosedAt(block.timestamp)) revert MarketClosed();
        if (units == 0) revert ZeroUnits();
        if (expiry < block.timestamp + minTenor || expiry > block.timestamp + maxTenor || isClosedAt(expiry)) {
            revert BadExpiry();
        }
        uint256 spot = _freshSpot(u);
        if (
            strike == 0 || strike % STRIKE_TICK != 0 || strike * 10_000 < spot * minStrikeBps
                || strike * 10_000 > spot * maxStrikeBps
        ) revert BadStrike();

        uint256 perUnit;
        (perUnit, q.vol, q.closedSeconds) = _price(u, strike, expiry, spot);
        q.spot = spot;
        q.premium = _toAsset(perUnit, units, Math.Rounding.Ceil);
        q.collateral = _toAsset(strike, units, Math.Rounding.Ceil);
    }

    /// @dev Ask the pricer, insist it priced off the same spot, and floor the premium at intrinsic + 5 bps.
    function _price(Underlying storage u, uint256 strike, uint64 expiry, uint256 spot)
        internal
        view
        returns (uint256 perUnit, uint256 vol, uint256 closedSeconds)
    {
        PricingParams memory p = u.params;
        uint256 pSpot;
        (perUnit, pSpot, vol, closedSeconds) = pricer.quotePut(
            address(u.feed), strike, expiry, p.lookback, p.volFloor, p.volCap, p.closedVolMult, p.spreadBps
        );
        if (pSpot != spot) revert PricerSpotMismatch(pSpot, spot);
        uint256 floor = (strike > spot ? strike - spot : 0) + spot * MIN_PREMIUM_BPS / 10_000;
        if (perUnit < floor) perUnit = floor;
    }

    function _createSeries(uint256 id, Series storage s, uint32 underlyingId, uint256 strike, uint64 expiry) internal {
        uint256[] storage list = _active[underlyingId];
        if (list.length >= MAX_ACTIVE_SERIES) revert TooManyActiveSeries();
        uint64 grace = settlementGrace;
        s.underlyingId = underlyingId;
        s.expiry = expiry;
        s.grace = grace;
        s.strike = strike;
        list.push(id);
        _activePos[id] = list.length;
        emit SeriesCreated(id, underlyingId, strike, expiry, grace);
    }

    function _settleable(uint256 id) internal view returns (Series storage s, IAggregatorV3 feed) {
        s = _series[id];
        if (s.expiry == 0) revert UnknownSeries();
        if (s.settled) revert AlreadySettled();
        if (block.timestamp < s.expiry) revert NotExpired();
        Underlying storage u = _underlyings[s.underlyingId];
        if (block.timestamp < uint256(s.expiry) + s.grace && _isPaused(u)) revert FeedPaused();
        feed = u.feed;
    }

    /// @dev Record the settlement, drop the series from the active list, then let the vault unlock its
    ///      collateral, earn its premium and send the owed payout here for escrow.
    function _finalize(uint256 id, Series storage s, uint256 price, uint80 roundId, bool fallbackUsed) internal {
        uint256 locked = s.locked;
        uint256 owed;
        if (s.strike > price) owed = Math.min(locked, _toAsset(s.strike - price, s.openUnits, Math.Rounding.Floor));
        s.settled = true;
        s.settlePrice = price;
        s.locked = 0;
        s.owed = owed;
        uint32 underlyingId = s.underlyingId;
        _removeActive(underlyingId, id);
        _underlyings[underlyingId].vault.settle(locked, owed, s.premium);
        emit SeriesSettled(id, price, roundId, fallbackUsed, owed, locked - owed);
    }

    function _removeActive(uint32 underlyingId, uint256 id) internal {
        uint256[] storage list = _active[underlyingId];
        uint256 pos = _activePos[id];
        uint256 last = list.length;
        if (pos != last) {
            uint256 moved = list[last - 1];
            list[pos - 1] = moved;
            _activePos[moved] = pos;
        }
        list.pop();
        delete _activePos[id];
    }

    /// @dev Starting at `roundId` (updatedAt >= expiry), step back while predecessors are still at/after
    ///      expiry and return the earliest *valid* round seen. Terminates on a predecessor older than expiry
    ///      or at aggregator index 1 (phase start); a missing predecessor or MAX_SETTLE_WALK reads revert.
    function _firstValidAtOrAfter(IAggregatorV3 feed, uint80 roundId, int256 answer, uint64 expiry)
        internal
        view
        returns (uint80 bestId, uint256 bestPrice)
    {
        if (_valid(answer)) (bestId, bestPrice) = (roundId, uint256(answer));
        for (uint256 i;; ++i) {
            if (roundId & INDEX_MASK <= 1) break;
            if (i == MAX_SETTLE_WALK) revert SettleWalkTooLong();
            (bool ok, int256 a, uint256 at) = _tryRound(feed, roundId - 1);
            if (!ok || at == 0) revert SettleWalkTooLong();
            if (at < expiry) break;
            --roundId;
            if (_valid(a)) (bestId, bestPrice) = (roundId, uint256(a));
        }
        if (bestPrice == 0) revert InvalidAnswer();
    }

    /// @dev Latest valid answer at or before `roundId`, stepping back over invalid rounds (bounded).
    function _latestValid(IAggregatorV3 feed, uint80 roundId, int256 answer) internal view returns (uint80, uint256) {
        for (uint256 i; !_valid(answer); ++i) {
            if (i == MAX_SETTLE_WALK || roundId & INDEX_MASK <= 1) revert InvalidAnswer();
            bool ok;
            (ok, answer,) = _tryRound(feed, --roundId);
            if (!ok) revert InvalidAnswer();
        }
        return (roundId, uint256(answer));
    }

    function _tryRound(IAggregatorV3 feed, uint80 roundId) internal view returns (bool, int256, uint256) {
        try feed.getRoundData(roundId) returns (uint80, int256 a, uint256, uint256 at, uint80) {
            return (true, a, at);
        } catch {
            return (false, 0, 0);
        }
    }

    function _freshSpot(Underlying storage u) internal view returns (uint256) {
        if (_isPaused(u)) revert FeedPaused();
        (, int256 answer,, uint256 updatedAt,) = u.feed.latestRoundData();
        if (!_valid(answer)) revert InvalidAnswer();
        if (updatedAt + maxPriceAge < block.timestamp) revert StalePrice(updatedAt);
        return uint256(answer);
    }

    function _isPaused(Underlying storage u) internal view returns (bool) {
        address token = u.stockToken;
        return _pausedFlag(address(u.feed)) || (token != address(0) && _pausedFlag(token));
    }

    /// @dev Low-level probe so a target without oraclePaused() (or an EOA) reads as "not paused".
    function _pausedFlag(address target) internal view returns (bool) {
        (bool ok, bytes memory data) = target.staticcall(abi.encodeCall(IPausableFeed.oraclePaused, ()));
        return ok && data.length >= 32 && abi.decode(data, (uint256)) != 0;
    }

    function _valid(int256 answer) internal pure returns (bool) {
        return answer > 0 && answer < MAX_ANSWER;
    }

    function _checkParams(PricingParams calldata p) internal pure {
        if (
            p.lookback < 10 || p.lookback > 240 || p.volFloor < 0.05e18 || p.volFloor > 5e18 || p.volCap < p.volFloor
                || p.volCap > 10e18 || p.closedVolMult < 1e18 || p.closedVolMult > 5e18 || p.spreadBps > 5_000
        ) revert BadParams();
    }

    /// @dev price (8 dec) * units (18 dec) -> asset units, with explicit rounding.
    function _toAsset(uint256 price8, uint256 units18, Math.Rounding rounding) internal view returns (uint256) {
        return Math.mulDiv(price8, units18, _unitDiv, rounding);
    }
}
