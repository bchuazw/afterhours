// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FeedMirror} from "../src/FeedMirror.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @dev The v1 FeedMirror round layout (int256 answer + uint64 updatedAt = two slots), for gas comparison.
contract LegacyTwoSlotMirror {
    struct Round {
        int256 answer;
        uint64 updatedAt;
    }

    event RoundPushed(uint80 indexed roundId, int256 answer, uint64 updatedAt);

    mapping(uint80 => Round) internal _rounds;
    uint80 public latestRound;

    function pushRound(uint80 roundId, int256 answer, uint64 updatedAt) external {
        if (roundId == 0 || answer <= 0 || updatedAt == 0) revert();
        _rounds[roundId] = Round(answer, updatedAt);
        if (roundId > latestRound) latestRound = roundId;
        emit RoundPushed(roundId, answer, updatedAt);
    }
}

contract FeedMirrorTest is Test {
    /// @dev Storage slot of FeedMirror._rounds (see `forge inspect FeedMirror storageLayout`).
    uint256 internal constant ROUNDS_SLOT = 3;

    FeedMirror internal feed;
    address internal relayer = makeAddr("relayer");

    function setUp() public {
        vm.warp(1_789_400_000);
        feed = new FeedMirror("RHTSLA / USD", 8, relayer);
    }

    function _slot(uint80 roundId) internal pure returns (bytes32) {
        return keccak256(abi.encode(roundId, ROUNDS_SLOT));
    }

    function test_roundIsPackedIntoOneSlot() public {
        int256 answer = 36_012_345_678;
        uint64 at = uint64(block.timestamp);
        vm.prank(relayer);
        feed.pushRound(7, answer, at);
        bytes32 word = vm.load(address(feed), _slot(7));
        assertEq(uint256(word), (uint256(at) << 192) | uint256(answer));
        assertEq(vm.load(address(feed), bytes32(uint256(_slot(7)) + 1)), bytes32(0), "second slot unused");
    }

    function test_pushRound_savesOneFreshSlotVersusV1Layout() public {
        LegacyTwoSlotMirror legacy = new LegacyTwoSlotMirror();
        legacy.pushRound(1, 1, 1);
        vm.prank(relayer);
        feed.pushRound(1, 1, 1);

        uint256 g = gasleft();
        legacy.pushRound(2, 36_000_000_000, uint64(block.timestamp));
        uint256 legacyGas = g - gasleft();
        vm.prank(relayer);
        g = gasleft();
        feed.pushRound(2, 36_000_000_000, uint64(block.timestamp));
        uint256 packedGas = g - gasleft();
        // A fresh storage slot costs ~22k; the packed layout writes one instead of two per round.
        assertLt(packedGas + 18_000, legacyGas);
    }

    function test_roundTripAndVerbatimGenesisAnswers() public {
        int256 genesis = 3_964_149_999_900_000_000; // 16-decimal-scaled $396.41, replayed verbatim
        vm.startPrank(relayer);
        feed.pushRound(1, genesis, 100);
        feed.pushRound(2, int256(type(int192).max), 200);
        vm.stopPrank();
        (uint80 id, int256 a, uint256 startedAt, uint256 updatedAt, uint80 answeredIn) = feed.getRoundData(1);
        assertEq(id, 1);
        assertEq(a, genesis);
        assertEq(startedAt, 100);
        assertEq(updatedAt, 100);
        assertEq(answeredIn, 1);
        (id, a,, updatedAt,) = feed.latestRoundData();
        assertEq(id, 2);
        assertEq(a, int256(type(int192).max));
        assertEq(updatedAt, 200);
    }

    function test_rejectsAnswersThatDoNotFit() public {
        vm.startPrank(relayer);
        vm.expectRevert(FeedMirror.BadRound.selector);
        feed.pushRound(1, int256(type(int192).max) + 1, 1);
        vm.expectRevert(FeedMirror.BadRound.selector);
        feed.pushRound(1, type(int256).max, 1);
        vm.expectRevert(FeedMirror.BadRound.selector);
        feed.pushRound(1, 0, 1);
        vm.expectRevert(FeedMirror.BadRound.selector);
        feed.pushRound(1, -1, 1);
        vm.expectRevert(FeedMirror.BadRound.selector);
        feed.pushRound(0, 1, 1);
        vm.expectRevert(FeedMirror.BadRound.selector);
        feed.pushRound(1, 1, 0);
        vm.stopPrank();
    }

    function test_latestOnlyMovesForwardAndBackfill() public {
        vm.startPrank(relayer);
        feed.pushRound(10, 100, 1_000);
        feed.pushRound(5, 50, 500); // backfill
        vm.stopPrank();
        assertEq(feed.latestRound(), 10);
        (, int256 a,,,) = feed.getRoundData(5);
        assertEq(a, 50);
        vm.expectRevert(FeedMirror.NoData.selector);
        feed.getRoundData(6);
    }

    function test_noDataBeforeFirstRound() public {
        vm.expectRevert(FeedMirror.NoData.selector);
        feed.latestRoundData();
    }

    function test_pushRounds_batchAndLengthCheck() public {
        uint80[] memory ids = new uint80[](3);
        int256[] memory answers = new int256[](3);
        uint64[] memory ats = new uint64[](3);
        for (uint256 i; i < 3; ++i) {
            ids[i] = uint80(i + 1);
            answers[i] = int256(100 + i);
            ats[i] = uint64(1_000 + i);
        }
        vm.prank(relayer);
        feed.pushRounds(ids, answers, ats);
        assertEq(feed.latestRound(), 3);
        (, int256 a,, uint256 at,) = feed.getRoundData(2);
        assertEq(a, 101);
        assertEq(at, 1_001);

        uint64[] memory short = new uint64[](2);
        vm.prank(relayer);
        vm.expectRevert(FeedMirror.BadRound.selector);
        feed.pushRounds(ids, answers, short);
    }

    function test_accessControlAndPause() public {
        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        vm.expectRevert(FeedMirror.NotRelayer.selector);
        feed.pushRound(1, 1, 1);
        vm.expectRevert(FeedMirror.NotRelayer.selector);
        feed.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        feed.setRelayer(stranger);
        vm.stopPrank();

        feed.pushRound(1, 1, 1); // owner may relay too
        vm.prank(relayer);
        feed.setPaused(true);
        assertTrue(feed.oraclePaused());
        feed.setRelayer(stranger);
        assertEq(feed.relayer(), stranger);
        assertEq(feed.decimals(), 8);
        assertEq(feed.description(), "RHTSLA / USD");
    }
}
