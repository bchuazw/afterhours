// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Chainlink AggregatorV3Interface (the subset AfterHours reads).
/// @dev Proxy round ids carry the phase in the top 16 bits: `roundId = (phaseId << 64) | aggregatorRoundId`.
///      Aggregator round index 1 is the first round of a phase and has no predecessor in that phase.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80 roundId_, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice Pause flag raised while a corporate action is applied. Robinhood Chain Stock Tokens expose it on
///         the token itself (alongside uiMultiplier / newUIMultiplier / effectiveAt); the testnet FeedMirror
///         exposes it on the feed. AfterHours probes both with a low-level staticcall and treats a missing
///         function as "not paused".
interface IPausableFeed {
    function oraclePaused() external view returns (bool);
}
