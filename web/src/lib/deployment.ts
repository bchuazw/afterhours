import type { Address } from "viem";
import { isAddressEqual, zeroAddress } from "viem";
import raw from "../deployments.json";

export type UnderlyingKey = "TSLA" | "AMZN" | "NVDA";

export type UnderlyingDeployment = {
  key: UnderlyingKey;
  id: number;
  symbol: string;
  feed: Address;
  vault: Address;
  stockToken: Address;
};

export type Deployment = {
  chainId: number;
  deployer: Address;
  usd: Address;
  pricer: Address;
  market: Address;
  deployBlock: number;
  underlyings: Record<UnderlyingKey, UnderlyingDeployment>;
};

type RawDeployment = {
  chainId: number;
  deployer: string;
  usd: string;
  pricer: string;
  market: string;
  deployBlock: number;
  underlyings: Record<string, { id: number; symbol: string; feed: string; vault: string; stockToken: string }>;
};

function asAddress(v: unknown, label: string): Address {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new Error(`deployments.json: ${label} is not an address (got ${String(v)})`);
  }
  return v as Address;
}

export const UNDERLYING_KEYS: readonly UnderlyingKey[] = ["TSLA", "AMZN", "NVDA"];

function load(): Deployment {
  const r = raw as unknown as RawDeployment;
  const underlyings = {} as Record<UnderlyingKey, UnderlyingDeployment>;
  for (const key of UNDERLYING_KEYS) {
    const u = r.underlyings[key];
    if (!u) throw new Error(`deployments.json: missing underlying ${key}`);
    underlyings[key] = {
      key,
      id: u.id,
      symbol: u.symbol,
      feed: asAddress(u.feed, `${key}.feed`),
      vault: asAddress(u.vault, `${key}.vault`),
      stockToken: asAddress(u.stockToken, `${key}.stockToken`),
    };
  }
  return {
    chainId: r.chainId,
    deployer: asAddress(r.deployer, "deployer"),
    usd: asAddress(r.usd, "usd"),
    pricer: asAddress(r.pricer, "pricer"),
    market: asAddress(r.market, "market"),
    deployBlock: r.deployBlock,
    underlyings,
  };
}

export const deployment: Deployment = load();
export const underlyingList: readonly UnderlyingDeployment[] = UNDERLYING_KEYS.map((k) => deployment.underlyings[k]);

export const isZero = (a: Address) => isAddressEqual(a, zeroAddress);
/** True once the market contract address has been filled in. */
export const isDeployed = !isZero(deployment.market);

export function underlyingById(id: number): UnderlyingDeployment | undefined {
  return underlyingList.find((u) => u.id === id);
}

export const COMPANY: Record<UnderlyingKey, string> = {
  TSLA: "Tesla",
  AMZN: "Amazon",
  NVDA: "NVIDIA",
};
