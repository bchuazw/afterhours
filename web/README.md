# AfterHours web

Frontend for AfterHours: fully collateralized, cash-settled downside protection for Robinhood Chain Stock Tokens.
Next.js 15 (App Router, static export) + TypeScript + Tailwind v4 + wagmi v2 + viem v2 + TanStack Query.

## Run

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm build        # static export to ./out
pnpm lint
pnpm typecheck
```

Serve the static build locally with `npx serve out`.

## Configure

- `src/deployments.json` holds all contract addresses. Until it is filled in (market is the zero address), the app
  renders a "Contracts not deployed yet" banner and every onchain read is disabled. Copy the JSON written by the
  contracts deploy script (`contracts/deployments/46630.json`) over it and rebuild.
- `NEXT_PUBLIC_RPC_URL` (optional) overrides the default `https://rpc.testnet.chain.robinhood.com`. See `.env.example`.
- ABIs live in `src/abi/*.ts` as `as const` exports. Regenerate from Foundry artifacts with `pnpm abi`
  (reads `../contracts/out/<Name>.sol/<Name>.json`). The Stylus pricer ABI in `src/abi/pricer.ts` is hand-written.

## Wallets

- **Browser wallet** via wagmi `injected()` (MetaMask, Rabby, ...). The network badge offers a one-click
  `wallet_addEthereumChain` + switch to Robinhood Chain Testnet (chainId 46630).
- **Demo wallet**: a burner private key generated once and kept in `localStorage`, exposed as a custom wagmi connector
  that signs over HTTP RPC. No extension required. Copy its address from the wallet modal, fund it with testnet ETH for
  gas, and mint tUSD with the "Get 10,000 tUSD" faucet button (open `mint` on the MockERC20).

No RainbowKit / WalletConnect, so no API keys.

## Deploy to GitHub Pages

The site is served from `https://bchuazw.github.io/afterhours/`, so the build needs `basePath`/`assetPrefix`:

```bash
pnpm build:pages      # GH_PAGES=true next build  -> ./out
```

Publish the `out/` directory (e.g. GitHub Actions `actions/upload-pages-artifact` + `actions/deploy-pages`, or push
`out/` to a `gh-pages` branch). `public/.nojekyll` is included so `_next/` assets are served. `trailingSlash: true`
makes every route resolve to `<route>/index.html` on Pages.

## Structure

```
src/
  abi/            market, vault, feed, erc20 (generated), pricer (hand-written)
  deployments.json
  lib/            chain, deployment loader, wagmi config, burner connector, formatters, market-hours, error decoding
  lib/hooks/      feed, feed history, market config, logs (events), token, tx wrapper (toasts), clock, debounce
  components/     nav, footer, wallet modal, network badge, faucet, toasts, small UI primitives
  features/       protect (quote + buy), earn (vaults), positions, how (diagram)
  app/            routes: / (Protect), /earn, /positions, /how-it-works
```

## Notes

- All reads go through the wagmi public client (`http()` on the testnet RPC), so the app works before a wallet connects.
- Feed status: a print older than 30 minutes on a Saturday/Sunday (UTC) is shown as "Market closed - feed frozen";
  expiry presets are the next Monday 13:30 UTC and next Friday 20:00 UTC.
- Event queries try one `eth_getLogs` call from `deployBlock`; if the RPC rejects the range they fall back to 20k-block
  chunks walking back from head.
