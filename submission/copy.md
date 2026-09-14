# HackQuest submission copy

## Name
AfterHours

## Intro (≤200 chars)
Weekend-gap protection for Robinhood Chain Stock Tokens. Fully collateralized puts, priced onchain by a Stylus (Rust) engine from the feed's own history, settled on the first Monday print.

## Sectors
DeFi · RWA · Infra

## Tech tags
Solidity · Rust · Next · React · Web3 · Node

## Links
- MVP: https://bchuazw.github.io/afterhours/
- GitHub: https://github.com/bchuazw/afterhours

## Description

**The gap nobody prices.** Robinhood Chain brings US equities onchain as ERC-20 Stock Tokens, and their Uniswap pools never close. But the Chainlink tokenized-equity feeds that value them are 24/5: they go quiet from Friday 20:00 ET to Sunday 20:00 ET. For ~52 hours a week, every holder of tokenized TSLA, NVDA or AMZN carries gap risk that nothing on the chain can hedge. Perps are leverage, not insurance. Lending markets liquidate; they don't protect. Listed options don't exist for the tokens.

**AfterHours is the missing primitive.** A holder picks a stock, a strike (say 90% of spot) and an expiry ("Monday open", "Friday close", 7 or 30 days), and pays a stablecoin premium. They receive an ERC-1155 position that pays `max(strike − settle, 0)` per share in stablecoins. Writers deposit stablecoins into a per-stock ERC-4626 vault; every premium lands in the vault and lifts the share price. Every position is fully collateralized at the moment of sale, so there is no liquidation engine, no leverage and no oracle-manipulation-to-liquidate surface.

**Priced onchain, in Rust.** The premium is computed by an Arbitrum Stylus contract. It walks the underlying's Chainlink round history with `getRoundData`, derives annualized realized volatility over open-market seconds (so weekend freezes don't dilute it), splits the tenor into open and closed seconds, charges closed time at a configurable multiple of vol (σ_eff²·T = σ²·(T_open + m²·T_closed)), and returns a Black-Scholes put premium plus the writer spread. The same math in Solidity would be a gas-hungry mess; in Rust it is ~150 lines of fixed-point `i128` with native unit tests.

**Settled on the first print after expiry.** A "Monday open" put settles on the first feed print at or after expiry, not whatever price is convenient hours later: `settle()` walks back the round history to the earliest post-expiry round. If the feed is paused for a corporate action, settlement waits; if no print arrives within a grace window, the last price is used so collateral never strands.

**Built for Robinhood Chain.** Stock Tokens, Chainlink equity feeds and Stylus only exist together on Robinhood Chain. The testnet deployment mirrors the real mainnet Chainlink rounds (same roundIds, answers and timestamps) onto Chainlink-compatible `FeedMirror` contracts, so the demo runs on live market data with the real weekend freeze. On mainnet the market points straight at the Chainlink proxies and the mirror is not needed.

**What's in the repo.** `AfterHoursMarket` (ERC-1155 series, quote/buy/settle/claim), `ProtectionVault` (ERC-4626 with collateral locking and a utilization cap), `FeedMirror`, the Stylus pricer, 24 Foundry tests including a fuzz that payout never exceeds locked collateral, a keeper (feed relayer + settlement bot on a GitHub Actions cron), and a Next.js app with Protect / Earn / Positions views.

## Progress during hackathon
Everything was designed and built during the buildathon, starting 14 Sep 2026: the market and vault contracts, the Stylus pricing engine, the feed mirror and keeper, the test suite, the frontend, and the testnet deployment. Commit history is public.

## Fundraising status
Not currently fundraising. Prototype stage; seeking Founder House feedback on the writer-side economics and a path to mainnet with USDG and native Chainlink feeds.

## Submission form: "Which parts of your code have been produced during the Buildathon?"
All of it. Contracts (`contracts/src/*`), Stylus pricer (`contracts/stylus/pricer`), tests, deployment scripts, keeper and web app were written from scratch between 14 Sep and submission; the only external code is OpenZeppelin Contracts v5 and the Stylus SDK as dependencies.

## Submission form: sponsor tech
Robinhood Chain · OpenZeppelin (· Alchemy if the RPC is switched to Alchemy)
