import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";
import { fmtUsd, fmtTime } from "./format";

const FRIENDLY: Record<string, (args: readonly unknown[]) => string> = {
  BadExpiry: () => "Expiry is outside the allowed tenor window (1h to 30d from now).",
  BadStrike: () => "Strike must be between 50% and 120% of spot.",
  StalePrice: (a) => `The feed has not printed since ${fmtTime(a[0] as bigint)}; too stale to quote against.`,
  FeedPaused: () => "The price feed is paused for a corporate action. Try again once it resumes.",
  PremiumTooHigh: (a) =>
    `Premium moved above your max (${fmtUsd(a[0] as bigint)} > ${fmtUsd(a[1] as bigint)}). Re-quote and retry.`,
  AwaitingPostExpiryPrint: (a) =>
    `Waiting for the first feed print after expiry (${fmtTime(a[0] as bigint)}). Last print: ${fmtTime(a[1] as bigint)}.`,
  NotExpired: () => "This series has not expired yet.",
  NotSettled: () => "This series has not been settled yet. Settle it first.",
  AlreadySettled: () => "This series is already settled.",
  InsufficientFreeLiquidity: (a) =>
    `The vault lacks free liquidity to back this position (needs ${fmtUsd(a[0] as bigint)}, has ${fmtUsd(a[1] as bigint)}). Deposit on Earn to add capacity.`,
  UtilizationTooHigh: () => "This trade would push vault utilization above the 90% cap.",
  UnknownUnderlying: () => "Unknown underlying.",
  UnderlyingDisabled: () => "This underlying is currently disabled.",
  ZeroUnits: () => "Enter a non-zero number of shares.",
  InvalidAnswer: () => "The feed returned an invalid price.",
  EnforcedPause: () => "The market is paused.",
  ERC20InsufficientAllowance: () => "Token allowance too low. Approve first.",
  ERC20InsufficientBalance: () => "Insufficient tUSD balance. Use the faucet to mint test funds.",
  ERC4626ExceededMaxWithdraw: () => "Withdraw exceeds free liquidity or your balance.",
  ERC4626ExceededMaxRedeem: () => "Redeem exceeds free liquidity or your balance.",
  ERC4626ExceededMaxDeposit: () => "Deposit exceeds the vault cap.",
  ERC1155InsufficientBalance: () => "You do not hold enough units of this series.",
  NoData: () => "The feed has no data for that round.",
};

/** Turn any thrown error from viem/wagmi into a short human-readable line. */
export function describeError(err: unknown): string {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return "Transaction rejected in wallet.";
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      if (revert.data) {
        const name = revert.data.errorName;
        const f = FRIENDLY[name];
        if (f) return f(revert.data.args ?? []);
        return `Reverted: ${name}`;
      }
      if (revert.reason) return revert.reason;
    }
    const short = err.shortMessage || err.message;
    if (/insufficient funds/i.test(short)) {
      return "Not enough ETH for gas. Fund this wallet with testnet ETH first.";
    }
    return short.split("\n")[0];
  }
  if (err instanceof Error) return err.message.split("\n")[0];
  return "Unknown error";
}
