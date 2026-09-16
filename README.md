# AfterHours

**Weekend-gap protection for tokenized stocks, priced onchain.**
Built on Robinhood Chain (Arbitrum) for the Arbitrum Open House Singapore Buildathon, Sept 2026.

> Stock Tokens trade 24/7 onchain. Their price feeds run 24/5.
> Every Friday night, holders of tokenized TSLA, NVDA or AMZN start carrying gap risk that nothing on the chain can hedge.
> AfterHours is the missing primitive: fully collateralized, cash-settled downside protection, quoted by a Rust/Stylus pricing engine straight from the feed's own history, and settled on the first print after the market reopens.

## The problem

Robinhood Chain brings US equities onchain as ERC-20 Stock Tokens. Uniswap pools for them never close. But the Chainlink tokenized-equity feeds that value them are **24/5**: they publish through the overnight session and go quiet from Friday 20:00 ET to Sunday 20:00 ET.

That creates a risk no existing venue prices:

- A holder cannot hedge Monday's open. Perps are leverage, not insurance; lending markets liquidate, they don't protect.
- Lending protocols using Stock Tokens as collateral are blind for ~52 hours a week.
- The TradFi answer (listed options) does not exist for the tokens.

## What AfterHours does

| Role | What they do | What they get |
|---|---|---|
| **Holder** | Picks a stock, a strike (e.g. 90% of spot) and an expiry (e.g. "Monday open"), pays a stablecoin premium | An ERC-1155 position that pays `max(strike − settle, 0)` per share in stablecoins |
| **Writer** | Deposits stablecoins into a per-stock ERC-4626 vault | Premiums flow into the vault and lift the share price |

Everything is fully collateralized at time of sale, so there is no liquidation engine, no leverage and no oracle-manipulation-to-liquidate surface.

### Settlement rule

A series settles at the **first feed print at or after expiry**. A "Monday open" put therefore settles on the first real Monday price, which is exactly the gap the buyer wanted covered. If the feed is paused for a corporate action, settlement waits. If no post-expiry print arrives within a grace window, the last price is used so collateral never strands.

### Pricing (Stylus, Rust)

The premium is computed onchain by [`afterhours-pricer`](contracts/stylus/pricer), an Arbitrum Stylus contract:

1. Walks `lookback` historical Chainlink rounds via `getRoundData`.
2. Derives annualized realized volatility over **open-market seconds** (so weekend freezes don't dilute it).
3. Splits the tenor into open and closed seconds and charges closed time at `closedVolMult × σ`:
   `σ_eff² · T = σ² · (T_open + m² · T_closed)`
4. Returns a Black-Scholes put premium plus the writer spread, floored at intrinsic.

Doing this in Solidity would be painful and gas-hungry; in Rust it is ~150 lines of `i128` fixed-point math with native unit tests.

## Architecture

```
                 ┌──────────────────────────┐
  mainnet        │ Chainlink RHTSLA/USD ...  │  24/5 tokenized-equity feeds
  (4663)         └────────────┬─────────────┘
                              │ replayed round-for-round by keeper/mirror.ts
                 ┌────────────▼─────────────┐
  testnet        │ FeedMirror (AggregatorV3) │  same roundIds / answers / timestamps
  (46630)        └────────────┬─────────────┘
                              │ latestRoundData / getRoundData
   ┌──────────────────────────┼──────────────────────────┐
   │ AfterHoursMarket (ERC-1155)                          │
   │   quote → buyProtection → settle → claim             │
   │        │                                             │
   │        ├── IPricer.quotePut ──► Stylus pricer (Rust) │
   │        └── lock / pay / release ──► ProtectionVault  │  ERC-4626 per underlying
   └──────────────────────────────────────────────────────┘
```

On mainnet the market points straight at the Chainlink proxies and `FeedMirror` is not deployed. The testnet mirror exists only because Chainlink's equity feeds are mainnet-only; it replays the real rounds so the demo runs on live market data with the real weekend freeze.

## Repository

| Path | What |
|---|---|
| `contracts/src/AfterHoursMarket.sol` | Market: series, ERC-1155 positions, quote/buy/settle/claim |
| `contracts/src/ProtectionVault.sol` | ERC-4626 writer vault with collateral locking and utilization cap |
| `contracts/src/FeedMirror.sol` | Chainlink-compatible mirror for testnet |
| `contracts/stylus/pricer/` | Stylus (Rust) pricing engine + native unit tests |
| `contracts/test/` | Foundry tests incl. fuzz: payout ≤ locked collateral |
| `contracts/script/Deploy.s.sol` | Testnet deployment |
| `keeper/` | Feed relayer + settlement bot (GitHub Actions cron) |
| `web/` | Next.js app (Protect / Earn / Positions) |

## Build & test

```bash
# Solidity
cd contracts && forge test -vv

# Stylus pricer (native tests, then on-chain validity check)
cd contracts/stylus/pricer
cargo test --release
cargo stylus check --endpoint https://rpc.testnet.chain.robinhood.com

# Keeper
cd keeper && pnpm install && pnpm mirror:once
```

## Local end-to-end (Nitro dev node)

Stylus needs a Nitro node, so the full stack can be exercised locally with the
[Arbitrum Nitro dev node](https://docs.arbitrum.io/run-arbitrum-node/run-nitro-dev-node):

```bash
docker run -d --name nitro-dev -p 8547:8547 offchainlabs/nitro-node:v3.7.1-926f1ab \
  --dev --http.addr 0.0.0.0 --http.api=net,web3,eth,debug --http.corsdomain='*' --http.vhosts='*'
# make the dev account chain owner and register a WASM cache manager (see nitro-devnode/run-dev-node.sh)

cd contracts/stylus/pricer && cargo stylus deploy --endpoint http://127.0.0.1:8547 --private-key $DEV_KEY --no-verify
cd contracts && PRICER=<pricer> PRIVATE_KEY=$DEV_KEY forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8547 --broadcast
cd keeper && CHAIN_ID=412346 TESTNET_RPC=http://127.0.0.1:8547 RELAYER_KEY=$DEV_KEY pnpm mirror:once   # real mainnet rounds
cp contracts/deployments/412346.json web/src/deployments.json && cd web && pnpm dev                     # UI on :3000
```

The keeper replays the real Robinhood Chain mainnet Chainlink rounds (via Multicall3) onto the local
`FeedMirror`s, so quotes, sparklines and settlement run on live TSLA/AMZN/NVDA history.

`media/` holds the pitch deck and the demo recorder (`node demo/record.mjs`, Playwright + edge-tts +
ffmpeg) used to produce the submission videos.

## Deployments

See [`contracts/deployments/46630.json`](contracts/deployments/46630.json) (Robinhood Chain testnet).

## Security notes

- Fully collateralized: `vault.balance ≥ lockedCollateral` is enforced on every lock and checked by fuzz tests.
- No upgradeability. Owner can only add/disable underlyings, tune pricing params and pause new sales; it cannot touch vault funds.
- Feed hygiene: staleness bound on quotes, `oraclePaused()` respected, 18-decimal genesis-round anomaly normalized, sequencer-uptime check is a mainnet TODO.
- Known limitations for a hackathon build: single-sided (puts only), realized-vol pricing (no implied surface), US-holiday calendar not modelled (weekends only).

## License

MIT
