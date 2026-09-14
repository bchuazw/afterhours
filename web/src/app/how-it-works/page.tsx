import type { Metadata } from "next";
import { deployment, underlyingList, isZero } from "@/lib/deployment";
import { explorerAddress } from "@/lib/chain";
import { LifecycleDiagram } from "@/features/how/LifecycleDiagram";

export const metadata: Metadata = { title: "How it works · AfterHours" };

function Addr({ label, address }: { label: string; address: `0x${string}` }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-muted">{label}</span>
      {isZero(address) ? (
        <span className="num text-xs text-dim">not deployed</span>
      ) : (
        <a href={explorerAddress(address)} target="_blank" rel="noreferrer" className="num link text-xs break-all">
          {address}
        </a>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">How AfterHours works</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          A fully collateralized, cash-settled downside-protection market (European puts) for Robinhood Chain Stock
          Tokens, priced entirely onchain by a Rust/Stylus engine.
        </p>
      </div>

      <section className="card p-5">
        <h2 className="text-base font-semibold">The weekend-gap thesis</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Tokenized stocks like TSLA, AMZN and NVDA trade onchain 24/7, but their Chainlink price feeds follow the
          equity session: they print 24/5 and freeze from Friday 20:00 UTC until Sunday 22:00 UTC. Anyone holding a Stock
          Token over the weekend is exposed to whatever happens between the last Friday print and the first Monday
          print, with no venue to hedge it. That gap is exactly what AfterHours prices and pays out.
        </p>
      </section>

      <section className="card p-5">
        <h2 className="text-base font-semibold">Lifecycle</h2>
        <div className="mt-3">
          <LifecycleDiagram />
        </div>
        <ol className="mt-3 space-y-2 text-sm leading-relaxed text-muted">
          <li>
            <span className="text-fg">1. Buy.</span> Pick an underlying, a strike (e.g. 90% of spot) and an expiry. The market
            calls the Stylus pricer, pulls the premium in tUSD and locks <span className="num">strike × units</span> of
            collateral from that underlying&apos;s writer vault. You receive an ERC-1155 position keyed by (underlying,
            strike, expiry).
          </li>
          <li>
            <span className="text-fg">2. Settle.</span> After expiry, anyone calls <span className="num">settle(id)</span>.
            The settle price is the feed&apos;s <em>first print at or after expiry</em>. If the feed has not printed since
            expiry yet, settle reverts with <span className="num">AwaitingPostExpiryPrint</span>. If no print arrives within
            the grace period (feed outage or long halt), the last available price is used so collateral is never stuck.
            While the feed is paused for a corporate action, settlement waits.
          </li>
          <li>
            <span className="text-fg">3. Claim.</span> Burn your units and receive{" "}
            <span className="num">max(strike − settle, 0) × units</span> in tUSD. Any collateral not paid out is released
            back to the vault.
          </li>
        </ol>
      </section>

      <section className="card p-5">
        <h2 className="text-base font-semibold">Pricing</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          The pricer reads the underlying&apos;s own round history from the feed, computes realized volatility over the
          lookback window, clamps it to [volFloor, volCap], and prices a Black-Scholes put with an effective variance that
          weights closed-market time by a multiplier <span className="num">m</span> (the closed-market surcharge):
        </p>
        <div className="num mt-3 rounded-lg border border-line bg-bg px-4 py-3 text-center text-sm">
          σ<sub>eff</sub>² · T = σ² · (T<sub>open</sub> + m² · T<sub>closed</sub>)
        </div>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          The writer spread is added on top of fair value. A weekend-spanning quote therefore carries more variance per
          calendar hour than a mid-week one, which is what the quote card shows as &quot;closed-market time in tenor&quot;.
          Everything the quote depends on (spot, vol, closed seconds) is returned by the contract so it can be verified.
        </p>
        <ul className="mt-3 grid gap-2 text-sm text-muted sm:grid-cols-2">
          <li className="rounded-lg border border-line p-3"><span className="text-fg">Spot / strike</span> · 8 decimals, from the feed</li>
          <li className="rounded-lg border border-line p-3"><span className="text-fg">Vol</span> · annualized, 1e18 = 100%</li>
          <li className="rounded-lg border border-line p-3"><span className="text-fg">Premium / collateral</span> · tUSD, 6 decimals</li>
          <li className="rounded-lg border border-line p-3"><span className="text-fg">Units</span> · 1e18 = one share</li>
        </ul>
      </section>

      <section className="card p-5">
        <h2 className="text-base font-semibold">Writers and the vault</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Each underlying has its own ERC-4626 vault. Depositors receive shares; premiums are paid directly into the
          vault, raising the share price. Collateral for open positions is locked, withdrawals are limited to free
          liquidity, and utilization is capped at 90%. A 6-decimal virtual share offset makes first-depositor inflation
          attacks uneconomic. The invariant is simple: vault balance ≥ locked collateral, always.
        </p>
      </section>

      <section className="card p-5">
        <h2 className="text-base font-semibold">Safety rails</h2>
        <ul className="mt-2 space-y-1.5 text-sm text-muted">
          <li>Quotes reject stale feeds (older than maxPriceAge, comfortably above a 52h weekend).</li>
          <li>Strike bounded to [minStrikeBps, maxStrikeBps] of spot; tenor bounded to [minTenor, maxTenor].</li>
          <li>maxPremium slippage guard on every buy (the UI uses +2%).</li>
          <li>Genesis-era 18-decimal feed rounds are normalized to 8 decimals.</li>
          <li>Owner can pause new buys; settle and claim always remain open.</li>
        </ul>
      </section>

      <section className="card p-5">
        <h2 className="text-base font-semibold">Contracts · Robinhood Chain Testnet (chainId {deployment.chainId})</h2>
        <div className="mt-2 divide-y divide-line">
          <Addr label="AfterHoursMarket" address={deployment.market} />
          <Addr label="Stylus pricer" address={deployment.pricer} />
          <Addr label="tUSD (test quote asset)" address={deployment.usd} />
          {underlyingList.map((u) => (
            <div key={u.key} className="py-1">
              <Addr label={`${u.symbol} vault`} address={u.vault} />
              <Addr label={`${u.symbol} feed (FeedMirror)`} address={u.feed} />
              {!isZero(u.stockToken) && <Addr label={`${u.symbol} Stock Token`} address={u.stockToken} />}
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-dim">
          On testnet, FeedMirror replays the mainnet Chainlink rounds verbatim (same roundId, answer, updatedAt), so the
          market sees the real 24/5 session including frozen weekend prices. On mainnet the market points straight at the
          Chainlink proxy.
        </p>
      </section>

      <section className="card p-5">
        <h2 className="text-base font-semibold">Links</h2>
        <ul className="mt-2 space-y-1.5 text-sm">
          <li><a className="link" href="https://github.com/bchuazw/afterhours" target="_blank" rel="noreferrer">github.com/bchuazw/afterhours</a> · contracts, Stylus pricer, keeper, this app</li>
          <li><a className="link" href="https://docs.robinhood.com/chain" target="_blank" rel="noreferrer">Robinhood Chain docs</a></li>
          <li><a className="link" href="https://explorer.testnet.chain.robinhood.com" target="_blank" rel="noreferrer">Testnet explorer</a></li>
          <li><a className="link" href="https://docs.arbitrum.io/stylus/stylus-gentle-introduction" target="_blank" rel="noreferrer">Arbitrum Stylus</a></li>
        </ul>
      </section>
    </div>
  );
}
