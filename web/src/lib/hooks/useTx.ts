"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePublicClient, useWriteContract } from "wagmi";
import type { Abi, ContractFunctionArgs, ContractFunctionName, TransactionReceipt } from "viem";
import { useToast } from "@/components/Toaster";
import { describeError } from "@/lib/errors";
import { explorerTx } from "@/lib/chain";
import { shortHash } from "@/lib/format";

type WriteParams<
  TAbi extends Abi,
  TFn extends ContractFunctionName<TAbi, "nonpayable" | "payable">,
> = {
  address: `0x${string}`;
  abi: TAbi;
  functionName: TFn;
  args: ContractFunctionArgs<TAbi, "nonpayable" | "payable", TFn>;
  value?: bigint;
};

/**
 * Sends a contract write with pending/confirmed/failed toasts and explorer links, waits for the
 * receipt, then invalidates all queries so balances/quotes refresh. Returns the receipt or null.
 */
export function useTx() {
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const send = useCallback(
    async <TAbi extends Abi, TFn extends ContractFunctionName<TAbi, "nonpayable" | "payable">>(
      label: string,
      params: WriteParams<TAbi, TFn>,
    ): Promise<TransactionReceipt | null> => {
      setBusy(true);
      const id = toast.push({ kind: "pending", title: label, description: "Confirm in wallet…" });
      try {
        const hash = await writeContractAsync({
          address: params.address,
          abi: params.abi,
          functionName: params.functionName,
          args: params.args,
          value: params.value,
        } as Parameters<typeof writeContractAsync>[0]);
        const txUrl = explorerTx(hash);
        toast.update(id, {
          description: `Submitted ${shortHash(hash)}. Waiting for confirmation…`,
          ...(txUrl ? { link: { href: txUrl, label: "View on explorer" } } : {}),
        });
        if (!client) throw new Error("No RPC client");
        const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (receipt.status !== "success") {
          toast.update(id, { kind: "error", title: `${label} failed`, description: "Transaction reverted onchain." });
          return null;
        }
        toast.update(id, { kind: "success", title: `${label} confirmed`, description: `Block ${receipt.blockNumber.toString()}` });
        await qc.invalidateQueries();
        return receipt;
      } catch (err) {
        toast.update(id, { kind: "error", title: `${label} failed`, description: describeError(err), link: undefined });
        return null;
      } finally {
        setBusy(false);
      }
    },
    [writeContractAsync, client, toast, qc],
  );

  return { send, busy };
}
