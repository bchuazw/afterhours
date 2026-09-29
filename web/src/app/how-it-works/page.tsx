import type { Metadata } from "next";
import { deployment, underlyingList, isZero } from "@/lib/deployment";
import { explorerAddress, CHAIN_NAME } from "@/lib/chain";
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
          equity session: they print 24/5 and go dark from Friday 20:00 ET until Sunday 20:00 ET. Anyone holding a Stock
          Token over the weekend is exposed to whatever happens between the last Friday print and the first print after
          the reopen, with no venue to hedge it. That gap is exactly what AfterHours prices and pays out.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          The market treats <span className="text-fg">Saturday 00:00 UTC to Monday 01:00 UTC</span> as its closed window.
          That is the union of the dark period in US daylight time (Sat 00:00 to Mon 00:00 UTC) and in standard time (Sat
          01:00 to Mon 01:00 UTC), so it stays conservative across DST changes. No protection is sold inside the window
          and no series may expire inside it, so every expiry is followed by a live print.
        </p>
      </section>

      <section className="card p-5">
        <h2 className="text-base font-semibold">Lifecycle</h2>
        <div className="mt-3">
          <LifecycleDiagram />
        </div>
        <ol className="mt-3 space-y-2 text-sm leading-relaxed text-muted">
          <li>
            <span className="text-fg">1. Buy.</span> Pick an underlying, a whole-dollar strike (e.g. 90% of spot on a $1
            tick) and an expiry outside the closed window. The market checks that the feed is fresh, valid and not paused,
            then asks the Stylus pricer for a premium. The pricer must price off the same spot as the feed. The market
            pulls the premium in tUSD and has the underlying&apos;s writer vault lock{" "}
            <span className="num">strike × tokens</span> of collateral, booking the premium as unearned. You receive an
            ERC-1155 position keyed by (underlying, strike, expiry); one unit protects one Stock Token.
          </li>
          <li>
            <span className="text-fg">2. Settle.</span> After expiry, anyone calls <span className="num">settle(id)</span>.
            The settle price is the feed&apos;s <em>first valid print at or after expiry</em>, found by walking back from
            the latest round. If the feed has not printed since expiry yet, settle reverts with{" "}
            <span className="num">AwaitingPostExpiryPrint</span>. Once the series&apos; own grace period has passed
            (snapshotted when the series is created, 5 days by default), the latest valid price is used so collateral never
            strands. If the walk back takes more than 300 rounds or hits a gap, settle reverts with{" "}
            <span className="num">SettleWalkTooLong</span> and the keeper settles with{" "}
            <span className="num">settleAt(id, roundId)</span>, a round hint the market verifies. At settlement the vault
            unlocks all of the series&apos; collateral, earns its premium and sends the payout owed to holders into the
            market&apos;s escrow.
          </li>
          <li>
            <span className="text-fg">3. Claim.</span> Burn your units and receive your pro-rata share of the escrow,
            which is <span className="num">max(strike − settle, 0)</span> per token. The last claimant receives the
            remainder, so claims add up to exactly what was escrowed. Out-of-the-money positions have nothing to claim:
            their collateral already went back to the writers at settlement.
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
          The writer spread is added on top of fair value, and the market floors the premium at intrinsic value plus 5 bps
          of spot, whatever the pricer returns. A weekend-spanning quote therefore carries more variance per calendar hour
          than a mid-week one, which is what the quote card shows as &quot;closed-market time&quot;. Everything the quote
          depends on (spot, vol, closed seconds) is returned by the contract so it can be verified. Replacing the pricer
          goes through a 2-day timelock (proposePricer, then acceptPricer).
        </p>
        <ul className="mt-3 grid gap-2 text-sm text-muted sm:grid-cols-2">
          <li className="rounded-lg border border-line p-3"><span className="text-fg">Spot / strike</span> · 8 decimals, from the feed; strikes on a $1 tick</li>
          <li className="rounded-lg border border-line p-3"><span className="text-fg">Vol</span> · annualized, 1e18 = 100%</li>
          <li className="rounded-lg border border-line p-3"><span className="text-fg">Premium / collateral</span> · tUSD, 6 decimals</li>
          <li className="rounded-lg border border-line p-3"><span className="text-fg">Units</span> · 1e18 = protection on one Stock Token</li>
        </ul>
        <p className="mt-3 text-xs leading-relaxed text-dim">
          The feed price is per token and already includes the Stock Token&apos;s uiMultiplier, so splits and other
          corporate actions do not change what a unit protects.
        </p>
      </section>

      <section className="card p-5">
        <h2 className="text-base font-semibold">Writers and the vault</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Each underlying has its own ERC-4626 vault. Its accounting keeps writers fair to each other:
        </p>
        <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-muted">
          <li>
            <span className="text-fg">Unearned premium.</span> Premium sits in the vault but is not writer equity until its
            series settles (<span className="num">capital = balance − unearned premium</span>), so a deposit made just
            before or after a sale does not share in its premium up front.
          </li>
          <li>
            <span className="text-fg">Mark-to-market.</span>{" "}
            <span className="num">totalAssets = capital − liability</span>, where liability is the intrinsic value of the
            open puts beyond each series&apos; own premium. A loss hits every writer&apos;s share price at once instead of
            whoever exits last, and a sale never moves the share price.
          </li>
          <li>
            <span className="text-fg">Settlement escrow.</span> At settlement the payout moves to the market&apos;s escrow
            and the rest of the collateral unlocks immediately, so writers never wait on holders to claim.
          </li>
          <li>
            <span className="text-fg">Gating.</span> Deposits and withdrawals pause (max = 0) while the vault has open
            exposure and the feed is dark, stale, invalid or paused, and while an expired series awaits settlement, because
            the share price cannot be marked fairly then. Sales and exits keep utilization (locked / capital) at or below
            90%.
          </li>
        </ul>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          A 6-decimal virtual share offset makes first-depositor inflation attacks uneconomic. The invariant: vault
          balance ≥ locked collateral + unearned premium, always.
        </p>
      </section>

      <section className="card p-5">
        <h2 className="text-base font-semibold">Safety rails</h2>
        <ul className="mt-2 space-y-1.5 text-sm text-muted">
          <li>No sales and no expiries in the closed window (Sat 00:00 to Mon 01:00 UTC).</li>
          <li>Quotes reject stale feeds (older than maxPriceAge, 26h) and invalid answers.</li>
          <li>
            Answers of 0 or less, or of $1,000,000 or more, are invalid and skipped, never rescaled. Early mainnet rounds
            carry 16-decimal answers (e.g. 3964149999900000000 for $396.41); settlement walks past them.
          </li>
          <li>
            oraclePaused() on the feed or the Stock Token (corporate actions) blocks buys, and blocks settlement until the
            series&apos; grace period ends.
          </li>
          <li>Strike on a $1 tick within [minStrikeBps, maxStrikeBps] of spot; tenor within [minTenor, maxTenor].</li>
          <li>maxPremium slippage guard on every buy (the UI uses +2%).</li>
          <li>At most 32 open series per underlying, which keeps mark-to-market bounded.</li>
          <li>Pricer changes wait out a 2-day timelock.</li>
          <li>
            The owner can pause the market or disable an underlying; both block new buys only. settle, settleAt and claim
            always remain open.
          </li>
        </ul>
      </section>

      <section className="card p-5">
        <h2 className="text-base font-semibold">Contracts · {CHAIN_NAME} (chainId {deployment.chainId})</h2>
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
          market sees the real 24/5 session including frozen weekend prices and the invalid genesis-era answers it must
          skip. On mainnet the market points straight at the Chainlink proxy.
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
