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
import {ProtectionVault} from "./ProtectionVault.sol";

/// @title AfterHoursMarket
/// @notice Fully collateralized, cash-settled downside protection (European puts) on Robinhood Chain
///         Stock Tokens. Stock Tokens trade 24/7 onchain while their Chainlink feeds run 24/5, so a
///         holder carries unhedgeable gap risk every weekend. AfterHours lets them buy protection
///         priced onchain from the feed's own history, and lets stablecoin writers earn the premium.
///
///         Lifecycle:
///           buyProtection -> (expiry) -> settle (first feed print at/after expiry) -> claim
///
///         Positions are ERC-1155 tokens keyed by (underlying, strike, expiry) so they are
///         transferable and composable. 1e18 position units = protection on 1 Stock Token (1 share).
contract AfterHoursMarket is ERC1155, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

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
        address stockToken; // informational (UI balance display); protection is cash-settled
        IAggregatorV3 feed;
        ProtectionVault vault;
        PricingParams params;
        bool enabled;
    }

    struct Series {
        uint32 underlyingId;
        uint64 expiry;
        uint256 strike; // 8 decimals
        uint256 openUnits; // 1e18 units outstanding (not yet claimed)
        uint256 settlePrice; // 8 decimals, 0 until settled
        bool settled;
    }

    // ---------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------

    IERC20 public immutable asset; // quote asset (USDG / test USD)
    uint256 internal immutable _assetScale; // 10 ** asset decimals
    IPricer public pricer;
    address public treasury;
    uint16 public protocolFeeBps; // taken from premium

    uint64 public minTenor = 1 hours;
    uint64 public maxTenor = 30 days;
    /// @notice A quote is rejected if the feed's latest print is older than this. Weekends freeze the
    ///         feed for ~52h, so this must comfortably exceed that.
    uint64 public maxPriceAge = 4 days;
    /// @notice If no post-expiry print arrives within this window (feed outage / long halt), the
    ///         series may be settled at the last available price so collateral is never stuck.
    uint64 public settlementGrace = 5 days;
    /// @notice Strike bounds relative to spot, in bps (e.g. 5000 = 50% .. 15000 = 150%).
    uint16 public minStrikeBps = 5_000;
    uint16 public maxStrikeBps = 12_000;

    uint32 public underlyingCount;
    mapping(uint32 => Underlying) internal _underlyings;
    mapping(uint256 => Series) internal _series;

    // ---------------------------------------------------------------------------------------------
    // Events / errors
    // ---------------------------------------------------------------------------------------------

    event UnderlyingAdded(uint32 indexed id, string symbol, address feed, address vault, address stockToken);
    event UnderlyingUpdated(uint32 indexed id, bool enabled, PricingParams params);
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
    event SeriesSettled(uint256 indexed seriesId, uint256 settlePrice, bool fallbackUsed);
    event Claimed(uint256 indexed seriesId, address indexed holder, uint256 units, uint256 payout);
    event PricerUpdated(address pricer);
    event ConfigUpdated();

    error UnknownUnderlying();
    error UnderlyingDisabled();
    error BadExpiry();
    error BadStrike();
    error ZeroUnits();
    error StalePrice(uint256 updatedAt);
    error FeedPaused();
    error PremiumTooHigh(uint256 premium, uint256 maxPremium);
    error NotExpired();
    error AlreadySettled();
    error NotSettled();
    error AwaitingPostExpiryPrint(uint64 expiry, uint256 lastUpdate);
    error InvalidAnswer();

    // ---------------------------------------------------------------------------------------------
    // Constructor / admin
    // ---------------------------------------------------------------------------------------------

    constructor(IERC20 asset_, IPricer pricer_, address treasury_, string memory uri_)
        ERC1155(uri_)
        Ownable(msg.sender)
    {
        asset = asset_;
        _assetScale = 10 ** IERC20Metadata(address(asset_)).decimals();
        pricer = pricer_;
        treasury = treasury_;
    }

    /// @notice Register a new underlying. Deploys a dedicated writer vault for it.
    function addUnderlying(
        string calldata symbol,
        address stockToken,
        IAggregatorV3 feed,
        PricingParams calldata params,
        string calldata vaultName,
        string calldata vaultSymbol
    ) external onlyOwner returns (uint32 id) {
        require(feed.decimals() == 8, "feed must be 8 decimals");
        id = ++underlyingCount;
        ProtectionVault vault = new ProtectionVault(asset, vaultName, vaultSymbol, address(this));
        _underlyings[id] = Underlying({
            symbol: symbol,
            stockToken: stockToken,
            feed: feed,
            vault: vault,
            params: params,
            enabled: true
        });
        emit UnderlyingAdded(id, symbol, address(feed), address(vault), stockToken);
    }

    function setUnderlying(uint32 id, bool enabled, PricingParams calldata params) external onlyOwner {
        if (id == 0 || id > underlyingCount) revert UnknownUnderlying();
        _underlyings[id].enabled = enabled;
        _underlyings[id].params = params;
        emit UnderlyingUpdated(id, enabled, params);
    }

    function setPricer(IPricer pricer_) external onlyOwner {
        pricer = pricer_;
        emit PricerUpdated(address(pricer_));
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
        require(protocolFeeBps_ <= 2_000 && minTenor_ < maxTenor_ && minStrikeBps_ < maxStrikeBps_, "bad config");
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

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

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

    /// @notice Quote protection for `units` (1e18 = 1 share) of `underlyingId` at `strike` until `expiry`.
    /// @return premium   Total premium in asset units (before protocol fee is carved out of it).
    /// @return collateral Collateral the vault must lock (strike * units), asset units.
    /// @return spot      Spot used, 8 decimals.
    /// @return vol       Effective annualized vol, 1e18 = 100%.
    /// @return closedSeconds Closed-market seconds until expiry.
    function quote(uint32 underlyingId, uint256 strike, uint64 expiry, uint256 units)
        public
        view
        returns (uint256 premium, uint256 collateral, uint256 spot, uint256 vol, uint256 closedSeconds)
    {
        Underlying storage u = _underlyingChecked(underlyingId);
        if (units == 0) revert ZeroUnits();
        if (expiry < block.timestamp + minTenor || expiry > block.timestamp + maxTenor) revert BadExpiry();
        _requireFreshFeed(u.feed);

        uint256 premiumPerUnit;
        PricingParams memory p = u.params;
        (premiumPerUnit, spot, vol, closedSeconds) =
            pricer.quotePut(address(u.feed), strike, expiry, p.lookback, p.volFloor, p.volCap, p.closedVolMult, p.spreadBps);

        if (strike * 10_000 < spot * minStrikeBps || strike * 10_000 > spot * maxStrikeBps) revert BadStrike();

        premium = _toAsset(premiumPerUnit, units);
        collateral = _toAsset(strike, units);
    }

    /// @notice Intrinsic payout per the settled price for `units` of a series, in asset units.
    function payoutOf(uint256 id, uint256 units) public view returns (uint256) {
        Series storage s = _series[id];
        if (!s.settled) revert NotSettled();
        if (s.settlePrice >= s.strike) return 0;
        return _toAsset(s.strike - s.settlePrice, units);
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
        uint256 collateral;
        uint256 spot;
        uint256 vol;
        (premium, collateral, spot, vol,) = quote(underlyingId, strike, expiry, units);
        if (premium > maxPremium) revert PremiumTooHigh(premium, maxPremium);
        require(premium > 0, "premium rounds to zero");

        Underlying storage u = _underlyings[underlyingId];
        id = seriesId(underlyingId, strike, expiry);
        Series storage s = _series[id];
        if (s.expiry == 0) {
            s.underlyingId = underlyingId;
            s.expiry = expiry;
            s.strike = strike;
        }
        s.openUnits += units;

        // Effects before interactions: reserve collateral, then move premium.
        u.vault.lock(collateral);
        uint256 fee = premium * protocolFeeBps / 10_000;
        asset.safeTransferFrom(msg.sender, address(u.vault), premium - fee);
        if (fee > 0) asset.safeTransferFrom(msg.sender, treasury, fee);

        _mint(msg.sender, id, units, "");
        emit ProtectionBought(id, msg.sender, underlyingId, strike, expiry, units, premium, fee, spot, vol);
    }

    /// @notice Settle a series at the first feed print at or after expiry. Anyone may call.
    /// @dev If the feed is paused for a corporate action, settlement waits. If no post-expiry print
    ///      arrives within `settlementGrace`, the last available price is used so funds never strand.
    function settle(uint256 id) external nonReentrant {
        Series storage s = _series[id];
        if (s.expiry == 0) revert NotSettled();
        if (s.settled) revert AlreadySettled();
        if (block.timestamp < s.expiry) revert NotExpired();

        Underlying storage u = _underlyings[s.underlyingId];
        if (_isPaused(u.feed)) revert FeedPaused();
        (, int256 answer,, uint256 updatedAt,) = u.feed.latestRoundData();
        if (answer <= 0) revert InvalidAnswer();

        bool fallbackUsed;
        if (updatedAt < s.expiry) {
            if (block.timestamp < uint256(s.expiry) + settlementGrace) {
                revert AwaitingPostExpiryPrint(s.expiry, updatedAt);
            }
            fallbackUsed = true;
        }
        s.settled = true;
        s.settlePrice = _normalize(answer);
        emit SeriesSettled(id, s.settlePrice, fallbackUsed);
    }

    /// @notice Burn settled positions and collect the payout. Releases remaining collateral to writers.
    function claim(uint256 id, uint256 units) external nonReentrant returns (uint256 payout) {
        Series storage s = _series[id];
        if (!s.settled) revert NotSettled();
        if (units == 0) revert ZeroUnits();
        _burn(msg.sender, id, units);
        s.openUnits -= units;

        uint256 collateral = _toAsset(s.strike, units);
        payout = s.settlePrice >= s.strike ? 0 : _toAsset(s.strike - s.settlePrice, units);
        ProtectionVault vault = _underlyings[s.underlyingId].vault;
        if (payout > 0) vault.pay(msg.sender, payout);
        if (collateral > payout) vault.release(collateral - payout);
        emit Claimed(id, msg.sender, units, payout);
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _underlyingChecked(uint32 id) internal view returns (Underlying storage u) {
        if (id == 0 || id > underlyingCount) revert UnknownUnderlying();
        u = _underlyings[id];
        if (!u.enabled) revert UnderlyingDisabled();
    }

    function _requireFreshFeed(IAggregatorV3 feed) internal view {
        if (_isPaused(feed)) revert FeedPaused();
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0) revert InvalidAnswer();
        if (updatedAt + maxPriceAge < block.timestamp) revert StalePrice(updatedAt);
    }

    function _isPaused(IAggregatorV3 feed) internal view returns (bool) {
        (bool ok, bytes memory data) = address(feed).staticcall(abi.encodeCall(IPausableFeed.oraclePaused, ()));
        return ok && data.length >= 32 && abi.decode(data, (bool));
    }

    /// @dev Robinhood Chain feeds reported a handful of genesis-era rounds scaled at 18 decimals
    ///      instead of 8. Anything above $1,000,000/share is treated as an 18-decimal answer.
    function _normalize(int256 answer) internal pure returns (uint256) {
        uint256 a = uint256(answer);
        return a >= 1e14 ? a / 1e10 : a;
    }

    /// @dev price (8 dec) * units (18 dec) -> asset units (assetDecimals).
    function _toAsset(uint256 price8, uint256 units18) internal view returns (uint256) {
        return Math.mulDiv(price8 * units18, _assetScale, 1e26);
    }
}
