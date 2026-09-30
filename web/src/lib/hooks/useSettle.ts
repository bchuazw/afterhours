"use client";

import { useCallback, useState } from "react";
import { marketAbi } from "@/abi";
import { deployment } from "@/lib/deployment";
import { useTx, type TxFailure } from "./useTx";

/** Errors from settle() that deserve a note on the card, not just a toast. */
export const SETTLE_NOTES = new Set(["SettleWalkTooLong", "AwaitingPostExpiryPrint", "FeedPaused"]);

/**
 * `settle(id)` for anyone: an expired series can be settled by any wallet, not only its holders.
 * Reverts the caller can do nothing about right now (no post-expiry print yet, feed paused, walk
 * too long) are kept as a per-series note so the card can explain them; everything else is a toast.
 * Also exposes the underlying `send`, `busy` and `wrongChain` so a page needs only one useTx.
 */
export function useSettle() {
  const { send, busy, wrongChain } = useTx();
  const [notes, setNotes] = useState<Record<string, string>>({});

  const settle = useCallback(
    (seriesId: bigint, symbol?: string) => {
      const key = seriesId.toString();
      setNotes((n) => {
        const next = { ...n };
        delete next[key];
        return next;
      });
      return send(
        `Settle ${symbol ? `${symbol} ` : ""}series`,
        { address: deployment.market, abi: marketAbi, functionName: "settle", args: [seriesId] },
        {
          onError: (f: TxFailure) => {
            if (f.errorName && SETTLE_NOTES.has(f.errorName)) setNotes((n) => ({ ...n, [key]: f.message }));
          },
        },
      );
    },
    [send],
  );

  return { settle, notes, send, busy, wrongChain };
}
