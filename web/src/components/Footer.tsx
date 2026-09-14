import { deployment, underlyingList, isZero } from "@/lib/deployment";
import { explorerAddress } from "@/lib/chain";
import { shortAddr } from "@/lib/format";

function Addr({ label, address }: { label: string; address: `0x${string}` }) {
  const zero = isZero(address);
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted">{label}</span>
      {zero ? (
        <span className="num text-dim">not deployed</span>
      ) : (
        <a href={explorerAddress(address)} target="_blank" rel="noreferrer" className="num link" title={address}>
          {shortAddr(address, 6)}
        </a>
      )}
    </div>
  );
}

export function Footer() {
  return (
    <footer className="mt-10 border-t border-line">
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-8 sm:px-6 md:grid-cols-[1.2fr_1fr_1fr]">
        <div>
          <div className="text-sm font-semibold">AfterHours</div>
          <p className="mt-2 max-w-sm text-xs leading-relaxed text-muted">
            Fully collateralized, cash-settled downside protection for Robinhood Chain Stock Tokens. Priced onchain by a
            Rust/Stylus engine from the feed&apos;s own history.
          </p>
          <p className="mt-3 text-xs text-dim">Built on Robinhood Chain · Arbitrum Stylus</p>
          <div className="mt-2 flex gap-3 text-xs">
            <a className="link" href="https://github.com/bchuazw/afterhours" target="_blank" rel="noreferrer">GitHub</a>
            <a className="link" href="https://explorer.testnet.chain.robinhood.com" target="_blank" rel="noreferrer">Explorer</a>
            <a className="link" href="https://docs.robinhood.com/chain" target="_blank" rel="noreferrer">Robinhood Chain docs</a>
          </div>
        </div>
        <div className="space-y-1.5">
          <div className="label mb-2">Core contracts</div>
          <Addr label="Market" address={deployment.market} />
          <Addr label="Pricer (Stylus)" address={deployment.pricer} />
          <Addr label="tUSD" address={deployment.usd} />
        </div>
        <div className="space-y-1.5">
          <div className="label mb-2">Vaults · feeds</div>
          {underlyingList.map((u) => (
            <div key={u.key} className="flex items-center justify-between gap-3 text-xs">
              <span className="text-muted">{u.symbol}</span>
              <span className="flex gap-2">
                {isZero(u.vault) ? (
                  <span className="num text-dim">vault —</span>
                ) : (
                  <a className="num link" href={explorerAddress(u.vault)} target="_blank" rel="noreferrer" title={u.vault}>vault</a>
                )}
                {isZero(u.feed) ? (
                  <span className="num text-dim">feed —</span>
                ) : (
                  <a className="num link" href={explorerAddress(u.feed)} target="_blank" rel="noreferrer" title={u.feed}>feed</a>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
    </footer>
  );
}
