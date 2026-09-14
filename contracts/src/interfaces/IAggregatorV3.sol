// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Chainlink AggregatorV3Interface (the subset AfterHours reads).
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

/// @notice Robinhood Chain tokenized-equity feeds expose a pause flag while corporate actions are applied.
interface IPausableFeed {
    function oraclePaused() external view returns (bool);
}
