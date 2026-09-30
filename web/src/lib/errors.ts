import {
  BaseError,
  ChainMismatchError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  decodeErrorResult,
  type Abi,
  type Hex,
} from "viem";
import { erc20Abi, feedAbi, marketAbi, vaultAbi } from "@/abi";
import { CHAIN_NAME } from "./chain";
import { fmtPrice, fmtTime, fmtUsd } from "./format";

/**
 * Every custom error the app can hit, from all the contracts a call may pass through. A buy reverts
 * inside the vault (InsufficientFreeLiquidity) or the ERC-20 (allowance) while the wallet only knows
 * the market ABI, so reverts are always re-decoded against this combined list.
 */
const ERROR_ABI: Abi = (() => {
  const seen = new Set<string>();
  const out: Abi[number][] = [];
  for (const item of [...marketAbi, ...vaultAbi, ...erc20Abi, ...feedAbi] as Abi) {
    if (item.type !== "error") continue;
    const sig = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(item);
  }
  return out;
})();

type Args = readonly unknown[];
const big = (a: Args, i: number) => (typeof a[i] === "bigint" ? (a[i] as bigint) : 0n);

const FRIENDLY: Record<string, (a: Args) => string> = {
  // ---- market: buying ----
  MarketClosed: () =>
    "Sales are paused while the feeds are dark (Saturday 00:00 to Monday 01:00 UTC). Try again after Monday 01:00 UTC.",
  BadExpiry: () =>
    "Expiry must be within the allowed tenor (1h to 30d from now) and outside the closed window (Sat 00:00 to Mon 01:00 UTC).",
  BadStrike: () => "Strike must be a whole-dollar amount between 50% and 120% of the feed spot.",
  ZeroUnits: () => "Enter a non-zero number of tokens.",
  StalePrice: (a) =>
    `The feed has not printed since ${fmtTime(big(a, 0))}, which is too stale to quote against. Sales resume at the next print.`,
  FeedPaused: () =>
    "The price feed or Stock Token is paused (oraclePaused), usually for a corporate action. Try again once it resumes.",
  InvalidAnswer: () => "The feed's latest answer is invalid (zero or mis-scaled), so the market will not use it.",
  PricerSpotMismatch: (a) =>
    `The pricer quoted off ${fmtPrice(big(a, 0))} but the feed spot is ${fmtPrice(big(a, 1))}. Wait for the next print and retry.`,
  PremiumTooHigh: (a) =>
    `Premium moved above your max (${fmtUsd(big(a, 0))} > ${fmtUsd(big(a, 1))}). Re-quote and retry.`,
  TooManyActiveSeries: () =>
    "This underlying already has 32 open series. Join one of the open series listed under Expiry on the Protect tab, or wait for one to settle.",
  UnknownUnderlying: () => "Unknown underlying.",
  UnderlyingDisabled: () => "Sales for this underlying are currently disabled by the operator.",
  EnforcedPause: () => "The market is paused: new protection cannot be bought. Settlement and claims still work.",
  // ---- market: settlement / claims ----
  UnknownSeries: () => "Unknown series.",
  NotExpired: () => "This series has not expired yet.",
  AlreadySettled: () => "This series is already settled.",
  NotSettled: () => "This series has not been settled yet. Settle it first.",
  AwaitingPostExpiryPrint: (a) =>
    `Waiting for the first feed print after expiry (${fmtTime(big(a, 0))}). Last print: ${fmtTime(big(a, 1))}.`,
  SettleWalkTooLong: () =>
    "Settling here would walk back more than 300 feed rounds (or hit a gap in the feed). The keeper settles these with a round hint via settleAt, so check back shortly.",
  BadRoundHint: () => "That round is not the first valid print at or after expiry.",
  ReentrancyGuardReentrantCall: () => "Reentrant call rejected.",
  // ---- market: admin ----
  BadConfig: () => "Configuration value out of bounds.",
  BadParams: () => "Pricing parameters out of bounds.",
  BadFeed: () => "The feed must report 8 decimals.",
  BadVault: () => "The vault was not deployed for this market, asset and underlying id.",
  NoPendingPricer: () => "No pricer change is pending.",
  PricerTimelocked: (a) => `The new pricer cannot be activated before ${fmtTime(big(a, 0))} (2-day timelock).`,
  OwnableUnauthorizedAccount: () => "Only the owner can do that.",
  // ---- vault ----
  InsufficientFreeLiquidity: (a) =>
    `The vault lacks free liquidity to back this position (needs ${fmtUsd(big(a, 0))}, has ${fmtUsd(big(a, 1))}). Deposit on Earn to add capacity, or protect fewer tokens.`,
  UtilizationTooHigh: () =>
    "This sale would push vault utilization above the 90% cap. Protect fewer tokens or wait for writers to add capital.",
  OnlyMarket: () => "Only the market can call this vault function.",
  BadSettle: () => "Vault settlement accounting check failed.",
  ERC4626ExceededMaxDeposit: (a) =>
    big(a, 2) === 0n
      ? "The vault is closed to deposits right now (feed dark or stale with open exposure, or an expired series awaiting settlement)."
      : `Deposit exceeds the vault's current max (${fmtUsd(big(a, 2))}).`,
  ERC4626ExceededMaxMint: (a) =>
    big(a, 2) === 0n ? "The vault is closed to deposits right now." : "Mint exceeds the vault's current max.",
  ERC4626ExceededMaxWithdraw: (a) =>
    big(a, 2) === 0n
      ? "Withdrawals are paused right now (vault closed, or utilization is at the 90% cap)."
      : `Withdraw exceeds what you can take out now (${fmtUsd(big(a, 2))}); exits keep utilization at or below 90%.`,
  ERC4626ExceededMaxRedeem: (a) =>
    big(a, 2) === 0n
      ? "Withdrawals are paused right now (vault closed, or utilization is at the 90% cap)."
      : "Redeem exceeds what you can take out now; exits keep utilization at or below 90%.",
  // ---- tokens ----
  ERC20InsufficientAllowance: () => "Token allowance too low. Approve first.",
  ERC20InsufficientBalance: () => "Insufficient tUSD balance. Use the faucet to mint test funds.",
  SafeERC20FailedOperation: () => "Token transfer failed.",
  ERC1155InsufficientBalance: () => "You do not hold enough units of this series.",
  ERC1155MissingApprovalForAll: () => "Missing ERC-1155 operator approval.",
  // ---- feed ----
  NoData: () => "The feed has no data for that round.",
  BadRound: () => "Invalid feed round.",
  NotRelayer: () => "Only the feed relayer can push rounds.",
};

export type DecodedRevert = { name: string; args: Args };

const isHex = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v);

function decodeRaw(data: Hex | undefined): DecodedRevert | undefined {
  if (!data || data.length < 10) return undefined;
  try {
    const r = decodeErrorResult({ abi: ERROR_ABI, data });
    return { name: r.errorName, args: (r.args ?? []) as Args };
  } catch {
    return undefined;
  }
}

/** Decode a contract revert (custom error, Error(string) or Panic) from any viem/wagmi error. */
export function decodeRevert(err: unknown): DecodedRevert | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError) {
    const fromRaw = decodeRaw(revert.raw);
    if (fromRaw) return fromRaw;
    if (revert.data) return { name: revert.data.errorName, args: (revert.data.args ?? []) as Args };
    if (revert.reason) return { name: "Error", args: [revert.reason] };
  }
  // Errors that never got wrapped as a contract revert still carry the revert bytes somewhere.
  let found: DecodedRevert | undefined;
  err.walk((e) => {
    const data = (e as { data?: unknown }).data;
    const hex = isHex(data) ? data : isHex((data as { data?: unknown } | undefined)?.data) ? ((data as { data: Hex }).data) : undefined;
    found = decodeRaw(hex);
    return !!found;
  });
  return found;
}

/** Name of the custom error a call reverted with, if any. */
export function revertName(err: unknown): string | undefined {
  return decodeRevert(err)?.name;
}

function describeRevert(d: DecodedRevert): string {
  if (d.name === "Error") {
    const reason = typeof d.args[0] === "string" ? d.args[0] : "";
    return reason ? `Reverted: ${reason}` : "Reverted.";
  }
  if (d.name === "Panic") return `Contract panic (code ${String(d.args[0] ?? "?")}).`;
  const f = FRIENDLY[d.name];
  return f ? f(d.args) : `Reverted: ${d.name}`;
}

/** Turn any thrown error from viem/wagmi into a short human-readable line. */
export function describeError(err: unknown): string {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return "Transaction rejected in wallet.";
    if (err.walk((e) => e instanceof ChainMismatchError || (e as Error).name === "ConnectorChainMismatchError")) {
      return `Your wallet is on another network. Switch to ${CHAIN_NAME} and retry.`;
    }
    const decoded = decodeRevert(err);
    if (decoded) return describeRevert(decoded);
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.signature) {
      return `Reverted with an unknown error (${revert.signature}).`;
    }
    const short = err.shortMessage || err.message;
    if (/insufficient funds/i.test(short)) {
      return "Not enough ETH for gas. Fund this wallet with testnet ETH first.";
    }
    return short.split("\n")[0];
  }
  if (err instanceof Error) {
    if (err.name === "ConnectorChainMismatchError") return `Your wallet is on another network. Switch to ${CHAIN_NAME} and retry.`;
    return err.message.split("\n")[0];
  }
  return "Unknown error";
}
