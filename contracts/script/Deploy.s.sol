// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AfterHoursMarket} from "../src/AfterHoursMarket.sol";
import {ProtectionVault} from "../src/ProtectionVault.sol";
import {FeedMirror} from "../src/FeedMirror.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {IPricer} from "../src/interfaces/IPricer.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";

/// @notice Testnet deployment (Robinhood Chain testnet, chain id 46630).
///
/// Env:
///   PRIVATE_KEY   deployer key
///   PRICER        address of the deployed Stylus pricer
///   RELAYER       (optional) feed-mirror relayer; defaults to deployer
///   SEED_USD      (optional) tUSD (6 dec) to seed into each writer vault; default 250_000e6
///
/// Underlyings mirror real Robinhood Chain mainnet Chainlink feeds. Stock Token addresses are the
/// testnet faucet tokens where they exist (informational only — protection is cash-settled).
contract Deploy is Script {
    struct U {
        string symbol;
        string feedDesc;
        address stockToken;
    }

    MockERC20 internal usd;
    AfterHoursMarket internal market;
    address internal relayer;
    uint256 internal seed;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address pricer = vm.envAddress("PRICER");
        relayer = vm.envOr("RELAYER", deployer);
        seed = vm.envOr("SEED_USD", uint256(250_000e6));

        U[3] memory us = [
            U("TSLA", "RHTSLA / USD", 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E),
            U("AMZN", "RHAMZN / USD", 0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02),
            U("NVDA", "RHNVDA / USD", address(0))
        ];

        vm.startBroadcast(pk);
        usd = new MockERC20("AfterHours Test USD", "tUSD", 6);
        market = new AfterHoursMarket(
            IERC20(address(usd)), IPricer(pricer), deployer, "https://afterhours.bchua.dev/meta/{id}.json"
        );
        usd.mint(deployer, seed * us.length + 1_000_000e6);

        string memory usOut;
        for (uint256 i; i < us.length; ++i) {
            usOut = _deployUnderlying(us[i], i, deployer);
        }
        vm.stopBroadcast();

        string memory json = "deploy";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "deployer", deployer);
        vm.serializeAddress(json, "usd", address(usd));
        vm.serializeAddress(json, "pricer", pricer);
        vm.serializeAddress(json, "market", address(market));
        vm.serializeUint(json, "deployBlock", block.number);
        string memory out = vm.serializeString(json, "underlyings", usOut);
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, path);
        console.log("market", address(market));
        console.log("usd", address(usd));
        console.log("wrote", path);
    }

    function _params() internal pure returns (AfterHoursMarket.PricingParams memory) {
        return AfterHoursMarket.PricingParams({
            lookback: 120,
            volFloor: 0.35e18,
            volCap: 3e18,
            closedVolMult: 1.5e18,
            spreadBps: 1_000
        });
    }

    function _deployUnderlying(U memory u, uint256 i, address deployer) internal returns (string memory usOut) {
        FeedMirror feed = new FeedMirror(u.feedDesc, 8, relayer);
        uint32 id = market.addUnderlying(
            u.symbol,
            u.stockToken,
            IAggregatorV3(address(feed)),
            _params(),
            string.concat("AfterHours ", u.symbol, " Writer"),
            string.concat("ah", u.symbol)
        );
        ProtectionVault vault = market.getUnderlying(id).vault;
        usd.approve(address(vault), seed);
        vault.deposit(seed, deployer);
        console.log(u.symbol, "feed", address(feed));
        console.log(u.symbol, "vault", address(vault));

        string memory one = string.concat("u", vm.toString(i));
        vm.serializeUint(one, "id", id);
        vm.serializeString(one, "symbol", u.symbol);
        vm.serializeAddress(one, "feed", address(feed));
        vm.serializeAddress(one, "vault", address(vault));
        string memory oneOut = vm.serializeAddress(one, "stockToken", u.stockToken);
        usOut = vm.serializeString("underlyings", u.symbol, oneOut);
    }
}
