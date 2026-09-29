"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import type { Abi, ContractFunctionArgs, ContractFunctionName, TransactionReceipt } from "viem";
import { useToast } from "@/components/Toaster";
import { describeError, revertName } from "@/lib/errors";
import { CHAIN_NAME, explorerTx, targetChain } from "@/lib/chain";
import { shortHash } from "@/lib/format";
import { useMounted } from "./useNow";

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

export type TxFailure = { message: string; errorName?: string };

/**
 * True when a wallet is connected but on a chain other than the one AfterHours is deployed to.
 * Action buttons should be disabled while this holds.
 */
export function useWrongChain(): boolean {
  const mounted = useMounted();
  const { isConnected, chainId } = useAccount();
  return mounted && isConnected && chainId !== targetChain.id;
}

export const WRONG_CHAIN_HINT = `Your wallet is on another network. Switch to ${CHAIN_NAME} to continue.`;

/**
 * Sends a contract write with pending/confirmed/failed toasts and explorer links, waits for the
 * receipt, then invalidates all queries so balances/quotes refresh. Returns the receipt or null.
 * Every write is pinned to the target chain: if the wallet is elsewhere, wagmi/viem throw a chain
 * mismatch instead of signing on the wrong network.
 */
export function useTx() {
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient({ chainId: targetChain.id });
  const toast = useToast();
  const qc = useQueryClient();
  const wrongChain = useWrongChain();
  const [busy, setBusy] = useState(false);

  const send = useCallback(
    async <TAbi extends Abi, TFn extends ContractFunctionName<TAbi, "nonpayable" | "payable">>(
      label: string,
      params: WriteParams<TAbi, TFn>,
      opts?: { onError?: (f: TxFailure) => void },
    ): Promise<TransactionReceipt | null> => {
      if (wrongChain) {
        toast.push({ kind: "error", title: `${label} not sent`, description: WRONG_CHAIN_HINT });
        opts?.onError?.({ message: WRONG_CHAIN_HINT });
        return null;
      }
      setBusy(true);
      const id = toast.push({ kind: "pending", title: label, description: "Confirm in wallet…" });
      try {
        const hash = await writeContractAsync({
          address: params.address,
          abi: params.abi,
          functionName: params.functionName,
          args: params.args,
          value: params.value,
          chainId: targetChain.id,
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
          opts?.onError?.({ message: "Transaction reverted onchain." });
          return null;
        }
        toast.update(id, { kind: "success", title: `${label} confirmed`, description: `Block ${receipt.blockNumber.toString()}` });
        await qc.invalidateQueries();
        return receipt;
      } catch (err) {
        const message = describeError(err);
        toast.update(id, { kind: "error", title: `${label} failed`, description: message, link: undefined });
        opts?.onError?.({ message, errorName: revertName(err) });
        return null;
      } finally {
        setBusy(false);
      }
    },
    [writeContractAsync, client, toast, qc, wrongChain],
  );

  return { send, busy, wrongChain };
}
