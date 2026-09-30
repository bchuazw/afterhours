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
///         Friday 20:00 ET -> Sunday 20:00 ET window across US daylight saving). Expiries sit on a
///         30-minute grid and may not fall from Friday 20:00 UTC (the regular-session close, after which
///         the live feeds print at most once) to Monday 01:00 UTC, so every expiry is followed by a
///         live print before the weekend gap and is never settled on the Monday reopen.
///
///         Admin changes that can make writers' exposure riskier (pricer, pricing parameters, config,
///         a lower series minimum) are scheduled with `schedule` and executed after ADMIN_DELAY of
///         open-market time, within ADMIN_WINDOW. Changes that only reduce risk apply at once.
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

    /// @dev `timeValue` and `accrualRate` are appended after the v2 fields so positional decoders of
    ///      getSeries keep working.
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
        uint256 timeValue; // net premium above the intrinsic value collected at sale (asset units)
        uint256 accrualRate; // sum over buys of ceil(timeValue_b * 1e18 / (expiry - t_b)); see unearnedOf
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
    /// @notice Expiries sit on a 30-minute grid so buyers share series instead of opening one per minute.
    uint256 public constant EXPIRY_GRID = 30 minutes;
    /// @notice Premium floor enforced independently of the pricer: intrinsic + 5 bps of spot per unit.
    uint256 public constant MIN_PREMIUM_BPS = 5;
    /// @notice Bound on open series per underlying (keeps vault mark-to-market O(32)).
    uint256 public constant MAX_ACTIVE_SERIES = 32;
    /// @notice Open-market time (outside isClosedAt) between scheduling a risk-increasing admin change
    ///         and executing it. Writers can always exit during this time.
    uint256 public constant ADMIN_DELAY = 2 days;
    /// @notice Wall-clock window after a scheduled change's eta in which it may still be executed.
    uint256 public constant ADMIN_WINDOW = 3 days;
    /// @dev 8-decimal answers at or above $1,000,000 are invalid (e.g. mis-scaled genesis-era rounds).
    int256 internal constant MAX_ANSWER = 1e14;
    uint256 internal constant INDEX_MASK = type(uint64).max;
    uint256 internal constant WAD = 1e18;

    IERC20 public immutable asset; // quote asset (USDG / test USD)
    /// @dev price8 * units18 / _unitDiv = asset units; _unitDiv = 10 ** (26 - asset decimals).
    uint256 internal immutable _unitDiv;
    /// @dev One dollar in asset units.
    uint256 internal immutable _usdUnit;
    IPricer public pricer;
    address public treasury;
    /// @notice Protocol fee in bps, taken from the *time value* of each premium (never from the intrinsic
    ///         value, which the vault must be able to pay back at expiry).
    uint16 public protocolFeeBps;

    uint64 public minTenor = 1 hours;
    uint64 public maxTenor = 30 days;
    /// @notice Buys are rejected and the vault closes if the feed's latest print is older than this. Capped
    ///         at 36 hours so a Friday print can never count as fresh at the Monday 01:00 UTC reopen (the
    ///         shortest Friday-print-to-reopen gap is 48 hours).
    uint64 public maxPriceAge = 26 hours;
    /// @notice If no post-expiry print arrives within a series' grace (snapshot of this at creation), the
    ///         series may be settled at the latest valid price so collateral never strands.
    uint64 public settlementGrace = 5 days;
    /// @notice Strike bounds relative to the feed spot, in bps.
    uint16 public minStrikeBps = 5_000;
    uint16 public maxStrikeBps = 12_000;
    /// @notice Smallest (gross) premium a buy that opens a new series must pay, asset units. Top-ups of an
    ///         existing series have no minimum. Stops dust buys from filling MAX_ACTIVE_SERIES for free.
    uint256 public minSeriesPremium;

    /// @notice keccak256(calldata) of a scheduled admin change => timestamp from which it may execute.
    mapping(bytes32 => uint64) public scheduledEta;

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
    event ChangeScheduled(bytes32 indexed id, bytes data, uint64 eta);
    event ChangeCancelled(bytes32 indexed id);
    event ChangeExecuted(bytes32 indexed id);
    event PricerUpdated(address pricer);
    event ConfigUpdated();
    event MinSeriesPremiumUpdated(uint256 minSeriesPremium);

    error UnknownUnderlying();
    error UnderlyingDisabled();
    error UnknownSeries();
    error MarketClosed();
    error BadExpiry();
    error BadStrike();
    error ZeroUnits();
    error SeriesTooSmall(uint256 premium, uint256 minimum);
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
    error NotScheduled(bytes32 id);
    error Timelocked(bytes32 id, uint64 eta);
    error ScheduleExpired(bytes32 id, uint64 eta);

    // ---------------------------------------------------------------------------------------------
    // Constructor / admin
    // ---------------------------------------------------------------------------------------------

    constructor(IERC20 asset_, IPricer pricer_, address treasury_, string memory uri_)
        ERC1155(uri_)
        Ownable(msg.sender)
    {
        if (treasury_ == address(0)) revert BadConfig();
        asset = asset_;
        uint256 unitDiv = 10 ** (26 - uint256(IERC20Metadata(address(asset_)).decimals()));
        _unitDiv = unitDiv;
        _usdUnit = 1e26 / unitDiv;
        minSeriesPremium = 5 * (1e26 / unitDiv);
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

    /// @notice Schedule a risk-increasing admin change: `data` is the exact calldata of the later call
    ///         (setPricer, setConfig, setUnderlying or setMinSeriesPremium). It becomes executable once
    ///         ADMIN_DELAY of open-market time has passed and lapses ADMIN_WINDOW after that.
    function schedule(bytes calldata data) external onlyOwner returns (bytes32 id, uint64 eta) {
        id = keccak256(data);
        eta = uint64(etaAfterOpenSeconds(block.timestamp, ADMIN_DELAY));
        scheduledEta[id] = eta;
        emit ChangeScheduled(id, data, eta);
    }

    /// @notice Drop a scheduled change.
    function cancel(bytes32 id) external onlyOwner {
        delete scheduledEta[id];
        emit ChangeCancelled(id);
    }

    /// @notice Swap the pricing engine. Always scheduled: the delay is writers' notice of a repricing.
    function setPricer(IPricer newPricer) external onlyOwner {
        if (address(newPricer) == address(0)) revert BadConfig();
        _executeScheduled();
        pricer = newPricer;
        emit PricerUpdated(address(newPricer));
    }

    /// @notice Enable/disable sales and update pricing parameters. Disabling only blocks new buys;
    ///         settle / settleAt / claim always work. Parameter changes that can only raise premiums
    ///         (higher volFloor / volCap / closedVolMult / spreadBps, same lookback) apply at once; any
    ///         other change must have been scheduled.
    function setUnderlying(uint32 id, bool enabled, PricingParams calldata params) external onlyOwner {
        if (id == 0 || id > underlyingCount) revert UnknownUnderlying();
        _checkParams(params);
        Underlying storage u = _underlyings[id];
        PricingParams memory old = u.params;
        bool safer = params.lookback == old.lookback && params.volFloor >= old.volFloor && params.volCap >= old.volCap
            && params.closedVolMult >= old.closedVolMult && params.spreadBps >= old.spreadBps;
        if (!safer) _executeScheduled();
        u.enabled = enabled;
        u.params = params;
        emit UnderlyingUpdated(id, enabled, params);
    }

    /// @notice Update market config. A change that only tightens the market for buyers (lower fee, shorter
    ///         maxTenor, narrower strikes, longer minTenor, fresher prices, same treasury and grace) applies
    ///         at once; any other change must have been scheduled.
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
                || maxTenor_ < minTenor_ || maxTenor_ > 90 days || maxPriceAge_ < 1 hours || maxPriceAge_ > 36 hours
                || settlementGrace_ < 4 days || settlementGrace_ > 14 days || minStrikeBps_ < 3_000
                || minStrikeBps_ > 10_000 || maxStrikeBps_ < minStrikeBps_ || maxStrikeBps_ > 15_000
        ) revert BadConfig();
        bool safer = treasury_ == treasury && protocolFeeBps_ <= protocolFeeBps && minTenor_ >= minTenor
            && maxTenor_ <= maxTenor && maxPriceAge_ <= maxPriceAge && settlementGrace_ == settlementGrace
            && minStrikeBps_ >= minStrikeBps && maxStrikeBps_ <= maxStrikeBps;
        if (!safer) _executeScheduled();
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

    /// @notice Set the premium a series-opening buy must pay (asset units, at most $1,000). Raising it
    ///         applies at once; lowering it must have been scheduled.
    function setMinSeriesPremium(uint256 minSeriesPremium_) external onlyOwner {
        if (minSeriesPremium_ > 1_000 * _usdUnit) revert BadConfig();
        if (minSeriesPremium_ < minSeriesPremium) _executeScheduled();
        minSeriesPremium = minSeriesPremium_;
        emit MinSeriesPremiumUpdated(minSeriesPremium_);
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

    /// @notice True while the feeds are dark in practice: Friday 20:00 UTC (the regular-session close in
    ///         US daylight time, after which the live feeds print at most once) through Monday 01:00 UTC.
    ///         A superset of isClosedAt. No expiry may fall in here: it would be priced with no
    ///         closed-market time yet settle on the Monday reopen print.
    function isDarkAt(uint256 ts) public pure returns (bool) {
        uint256 dow = (ts / 1 days + 4) % 7;
        return (dow == 5 && ts % 1 days >= 20 hours) || isClosedAt(ts);
    }

    /// @notice First timestamp at or after `from` by which `openSeconds` of open-market time (outside
    ///         isClosedAt) have elapsed.
    function etaAfterOpenSeconds(uint256 from, uint256 openSeconds) public pure returns (uint256 t) {
        t = from;
        while (openSeconds > 0) {
            if (isClosedAt(t)) {
                t = _nextOpen(t);
            } else {
                uint256 step = Math.min(openSeconds, _nextClose(t) - t);
                t += step;
                openSeconds -= step;
            }
        }
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

    /// @notice Time value of `id` not yet earned by writers: each buy's net time value is earned linearly
    ///         from its sale to expiry, so unearned = min(timeValue, (expiry - now) * accrualRate / 1e18).
    function unearnedOf(uint256 id) public view returns (uint256) {
        return _unearned(_series[id]);
    }

    /// @notice Quote protection for `units` (1e18 = 1 Stock Token) of `underlyingId` at `strike` until
    ///         `expiry`. Runs every check buyProtection runs.
    /// @return premium       Total premium in asset units (rounded up; protocol fee is carved out of its
    ///                       time value).
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
    /// @dev liability = sum over active series of unearned time value + min(locked, intrinsic(spot) * openUnits).
    ///      A sale adds exactly its net premium to both the vault balance and the liability (intrinsic at
    ///      sale + time value), so the share price never moves on a buy, however far in the money, and a
    ///      just-in-time deposit around a buy earns nothing. The time value is then released to writers
    ///      linearly until expiry, so a deposit or exit just before expiry neither captures nor forfeits
    ///      the premium of the risk period it did not carry. An invalid latest answer marks at spot 0.
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
            liability += _unearned(s);
            if (s.strike > spot) {
                liability += Math.min(s.locked, _toAsset(s.strike - spot, s.openUnits, Math.Rounding.Floor));
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
        uint256 fee;
        id = seriesId(underlyingId, strike, expiry);
        {
            uint256 netTimeValue;
            (fee, netTimeValue) = _split(strike, q.spot, units, premium);
            Series storage s = _series[id];
            if (s.expiry == 0) _createSeries(id, s, underlyingId, strike, expiry);
            _book(s, units, q.collateral, premium - fee, netTimeValue);
        }

        // Interactions: reserve collateral + book unearned premium, move premium, then mint last.
        {
            ProtectionVault vault = u.vault;
            vault.lock(q.collateral, premium - fee);
            asset.safeTransferFrom(msg.sender, address(vault), premium - fee);
            if (fee > 0) asset.safeTransferFrom(msg.sender, treasury, fee);
        }

        emit ProtectionBought(id, msg.sender, underlyingId, strike, expiry, units, premium, fee, q.spot, q.vol);
        _mint(msg.sender, id, units, "");
    }

    /// @dev Split a premium into the protocol fee and the net time value. The premium is floored at
    ///      intrinsic + 5 bps per unit and both are rounded up, so it always covers the intrinsic value; the
    ///      fee is taken from the time value only, so the vault keeps at least the intrinsic value it has to
    ///      pay back at expiry.
    function _split(uint256 strike, uint256 spot, uint256 units, uint256 premium)
        internal
        view
        returns (uint256 fee, uint256 netTimeValue)
    {
        uint256 intrinsic = strike > spot ? _toAsset(strike - spot, units, Math.Rounding.Ceil) : 0;
        uint256 timeValue = premium - intrinsic;
        fee = timeValue * protocolFeeBps / 10_000;
        netTimeValue = timeValue - fee;
    }

    /// @dev Add a buy to its series. The accrual rate is rounded up so that the series' unearned time value
    ///      equals its time value right after the sale (a JIT deposit around a buy gains nothing).
    function _book(Series storage s, uint256 units, uint256 collateral, uint256 net, uint256 netTimeValue) internal {
        s.openUnits += units;
        s.locked += collateral;
        s.premium += net;
        if (netTimeValue > 0) {
            s.timeValue += netTimeValue;
            s.accrualRate += Math.mulDiv(netTimeValue, WAD, s.expiry - block.timestamp, Math.Rounding.Ceil);
        }
    }

    /// @notice Settle a series at the first valid feed print at or after expiry. Anyone may call.
    /// @dev Walks back from the latest round within its phase; reverts SettleWalkTooLong if that takes
    ///      more than MAX_SETTLE_WALK reads or hits a gap, in which case callers use settleAt with a round
    ///      hint. With no post-expiry print, waits until expiry + grace and then uses the latest valid
    ///      answer. Settlement is always taken within the feed's latest phase.
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

    /// @notice Settle a series at `roundId`, which must be the round settle() would pick: a valid print at
    ///         or after expiry in the latest round's phase, with every earlier print of that phase at or
    ///         after expiry invalid (walked back, bounded by MAX_SETTLE_WALK) down to a print older than
    ///         expiry or the phase start.
    function settleAt(uint256 id, uint80 roundId) external nonReentrant {
        (Series storage s, IAggregatorV3 feed) = _settleable(id);
        (uint80 latestId,,,,) = feed.latestRoundData();
        if (roundId > latestId || roundId & INDEX_MASK == 0 || roundId >> 64 != latestId >> 64) revert BadRoundHint();
        (bool found, int256 answer, uint256 updatedAt) = _tryRound(feed, roundId);
        uint64 expiry = s.expiry;
        if (!found || updatedAt < expiry || !_valid(answer)) revert BadRoundHint();
        uint80 r = roundId;
        for (uint256 i; r & INDEX_MASK != 1; ++i) {
            if (i == MAX_SETTLE_WALK) revert SettleWalkTooLong();
            (bool ok, int256 a, uint256 at) = _tryRound(feed, r - 1);
            if (!ok || at == 0) revert BadRoundHint();
            if (at < expiry) break;
            if (_valid(a)) revert BadRoundHint(); // an earlier valid post-expiry print exists
            --r;
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
        if (
            expiry % EXPIRY_GRID != 0 || expiry < block.timestamp + minTenor || expiry > block.timestamp + maxTenor
                || isDarkAt(expiry)
        ) revert BadExpiry();
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
        if (_series[seriesId(underlyingId, strike, expiry)].expiry == 0 && q.premium < minSeriesPremium) {
            revert SeriesTooSmall(q.premium, minSeriesPremium);
        }
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

    /// @dev Time value of `s` not yet earned (0 once expired or settled).
    function _unearned(Series storage s) internal view returns (uint256) {
        uint64 expiry = s.expiry;
        if (expiry <= block.timestamp || s.settled) return 0;
        return Math.min(s.timeValue, (expiry - block.timestamp) * s.accrualRate / WAD);
    }

    /// @dev Consume the schedule entry for the current call (keccak256 of its calldata).
    function _executeScheduled() internal {
        bytes32 id = keccak256(msg.data);
        uint64 eta = scheduledEta[id];
        if (eta == 0) revert NotScheduled(id);
        if (block.timestamp < eta) revert Timelocked(id, eta);
        if (block.timestamp > eta + ADMIN_WINDOW) revert ScheduleExpired(id, eta);
        delete scheduledEta[id];
        emit ChangeExecuted(id);
    }

    /// @dev End of the closed window containing `t` (Monday 01:00 UTC). `t` must be closed.
    function _nextOpen(uint256 t) internal pure returns (uint256) {
        uint256 dow = (t / 1 days + 4) % 7;
        uint256 day = t - t % 1 days;
        return day + (dow == 6 ? 2 days : dow == 0 ? 1 days : 0) + 1 hours;
    }

    /// @dev Start of the next closed window after `t` (Saturday 00:00 UTC). `t` must be open.
    function _nextClose(uint256 t) internal pure returns (uint256) {
        uint256 dow = (t / 1 days + 4) % 7; // 1..5
        return t - t % 1 days + (6 - dow) * 1 days;
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
