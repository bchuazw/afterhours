"use client";

import { useProtectionBought } from "@/lib/hooks/useLogs";
import { underlyingById } from "@/lib/deployment";
import { fmtPrice, fmtTimeShort, fmtUnits, fmtUsd, fmtVol, shortAddr } from "@/lib/format";
import { AddressLink, Skeleton, TxLink } from "@/components/ui";

export function RecentProtection({ underlyingId }: { underlyingId?: number }) {
  const { data, isLoading, error } = useProtectionBought(undefined, { underlyingId });
  const rows = (data ?? []).slice(0, 20);

  if (error) return <div className="text-xs text-neg">Could not load recent trades: {error.message.split("\n")[0]}</div>;

  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Underlying</th>
            <th className="r">Strike</th>
            <th>Expiry</th>
            <th className="r">Shares</th>
            <th className="r">Premium</th>
            <th className="r">Spot</th>
            <th className="r">Vol</th>
            <th>Buyer</th>
            <th>Tx</th>
          </tr>
        </thead>
        <tbody>
          {isLoading &&
            Array.from({ length: 4 }).map((_, i) => (
              <tr key={i}>
                {Array.from({ length: 9 }).map((_, j) => (
                  <td key={j}>
                    <Skeleton className="h-3 w-14" />
                  </td>
                ))}
              </tr>
            ))}
          {!isLoading && rows.length === 0 && (
            <tr>
              <td colSpan={9} className="py-6 text-center text-muted">
                No protection bought yet.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={`${r.txHash}-${r.seriesId.toString()}`}>
              <td className="font-medium">{underlyingById(r.underlyingId)?.symbol ?? `#${r.underlyingId}`}</td>
              <td className="num r">{fmtPrice(r.strike)}</td>
              <td className="text-muted">{fmtTimeShort(r.expiry)}</td>
              <td className="num r">{fmtUnits(r.units, 2)}</td>
              <td className="num r">{fmtUsd(r.premium)}</td>
              <td className="num r text-muted">{fmtPrice(r.spot)}</td>
              <td className="num r text-muted">{fmtVol(r.vol)}</td>
              <td>
                <AddressLink address={r.buyer} />
              </td>
              <td>{r.txHash !== "0x" ? <TxLink hash={r.txHash} /> : <span className="text-dim">{shortAddr("0x00000000")}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
