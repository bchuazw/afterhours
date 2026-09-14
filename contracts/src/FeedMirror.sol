// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IAggregatorV3, IPausableFeed} from "./interfaces/IAggregatorV3.sol";

/// @title FeedMirror
/// @notice Chainlink-compatible aggregator that mirrors a mainnet tokenized-equity feed onto a network
///         where that feed does not exist (Robinhood Chain testnet). A relayer replays the mainnet
///         rounds verbatim (same roundId / answer / updatedAt), so consumers see the real 24/5 session
///         behaviour, including frozen weekend prices. On mainnet the market points straight at the
///         Chainlink proxy and this contract is not deployed.
contract FeedMirror is IAggregatorV3, IPausableFeed, Ownable {
    struct Round {
        int256 answer;
        uint64 updatedAt;
    }

    uint8 public immutable override decimals;
    string private _description;
    address public relayer;
    bool public override oraclePaused;
    uint80 public latestRound;
    mapping(uint80 => Round) private _rounds;

    event RoundPushed(uint80 indexed roundId, int256 answer, uint64 updatedAt);
    event RelayerUpdated(address indexed relayer);
    event PausedUpdated(bool paused);

    error NotRelayer();
    error BadRound();
    error NoData();

    constructor(string memory description_, uint8 decimals_, address relayer_) Ownable(msg.sender) {
        _description = description_;
        decimals = decimals_;
        relayer = relayer_;
    }

    modifier onlyRelayer() {
        if (msg.sender != relayer && msg.sender != owner()) revert NotRelayer();
        _;
    }

    function setRelayer(address relayer_) external onlyOwner {
        relayer = relayer_;
        emit RelayerUpdated(relayer_);
    }

    function setPaused(bool paused) external onlyRelayer {
        oraclePaused = paused;
        emit PausedUpdated(paused);
    }

    /// @notice Push a single round. Rounds may be backfilled out of order (historical replay), but
    ///         `latestRound` only ever moves forward.
    function pushRound(uint80 roundId, int256 answer, uint64 updatedAt) public onlyRelayer {
        if (roundId == 0 || answer <= 0 || updatedAt == 0) revert BadRound();
        _rounds[roundId] = Round(answer, updatedAt);
        if (roundId > latestRound) latestRound = roundId;
        emit RoundPushed(roundId, answer, updatedAt);
    }

    /// @notice Batch variant used for backfilling history.
    function pushRounds(uint80[] calldata roundIds, int256[] calldata answers, uint64[] calldata updatedAts)
        external
        onlyRelayer
    {
        uint256 n = roundIds.length;
        if (n != answers.length || n != updatedAts.length) revert BadRound();
        for (uint256 i; i < n; ++i) {
            pushRound(roundIds[i], answers[i], updatedAts[i]);
        }
    }

    function description() external view override returns (string memory) {
        return _description;
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return getRoundData(latestRound);
    }

    function getRoundData(uint80 roundId)
        public
        view
        override
        returns (uint80 roundId_, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        Round memory r = _rounds[roundId];
        if (r.updatedAt == 0) revert NoData();
        return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);
    }
}
