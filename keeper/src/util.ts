import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, ExecutionRevertedError } from "viem";

/// Chainlink proxy round ids carry the phase in the top 16 bits; the low 64 bits are the
/// aggregator's own round index, which starts at 1 in every phase.
export const PHASE_SHIFT = 64n;
export const INDEX_MASK = (1n << PHASE_SHIFT) - 1n;

/// An 8-decimal answer at or above 1e14 ($1,000,000 per share) is corrupt, e.g. the genesis-era
/// rounds reported at 16 decimals. Such rounds are skipped, never rescaled.
export const MAX_ANSWER = 10n ** 14n;

export const phaseOf = (roundId: bigint): bigint => roundId >> PHASE_SHIFT;
export const indexOf = (roundId: bigint): bigint => roundId & INDEX_MASK;
/// Id of aggregator index 0 in `roundId`'s phase (never a real round).
export const phaseBase = (roundId: bigint): bigint => phaseOf(roundId) << PHASE_SHIFT;
export const isValidAnswer = (answer: bigint): boolean => answer > 0n && answer < MAX_ANSWER;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const short = (id: bigint): string => `${id.toString(16).slice(0, 10)}…`;

function revertOf(e: unknown): ContractFunctionRevertedError | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
  return r instanceof ContractFunctionRevertedError ? r : undefined;
}

/** Custom error name of a contract revert (e.g. "SettleWalkTooLong"), if the ABI could decode it. */
export function revertName(e: unknown): string | undefined {
  return revertOf(e)?.data?.errorName;
}

/**
 * True when the call reached the contract and it reverted (or returned nothing). Transport and RPC
 * failures return false, so callers can tell "no such round" apart from a flaky endpoint.
 */
export function isRevert(e: unknown): boolean {
  if (!(e instanceof BaseError)) return false;
  return (
    e.walk(
      (x) =>
        x instanceof ContractFunctionRevertedError ||
        x instanceof ContractFunctionZeroDataError ||
        x instanceof ExecutionRevertedError,
    ) !== null
  );
}

/** One-line error description for logs. */
export function errMsg(e: unknown): string {
  const r = revertOf(e);
  if (r?.data) return `reverted ${r.data.errorName}(${(r.data.args ?? []).map(String).join(", ")})`;
  if (r?.reason) return `reverted: ${r.reason}`;
  if (e instanceof BaseError) return e.shortMessage;
  if (e instanceof Error) return e.message.split("\n")[0];
  return String(e);
}
