import { createConnector } from "wagmi";
import { createWalletClient, http, type Address, type Chain, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

const KEY_STORAGE = "afterhours.burner.key";
const CONNECTED_STORAGE = "afterhours.burner.connected";

function safeGet(k: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string | null) {
  try {
    if (typeof window === "undefined") return;
    if (v === null) window.localStorage.removeItem(k);
    else window.localStorage.setItem(k, v);
  } catch {
    /* private mode etc. */
  }
}

const isKey = (k: string | null): k is `0x${string}` => !!k && /^0x[0-9a-fA-F]{64}$/.test(k);

/** Load (or lazily create) the demo account. Persisted in localStorage so it survives reloads. */
export function loadBurnerAccount(): PrivateKeyAccount {
  const stored = safeGet(KEY_STORAGE);
  if (isKey(stored)) return privateKeyToAccount(stored);
  const fresh = generatePrivateKey();
  safeSet(KEY_STORAGE, fresh);
  return privateKeyToAccount(fresh);
}

export function burnerAddress(): Address | undefined {
  const key = safeGet(KEY_STORAGE);
  return isKey(key) ? privateKeyToAccount(key).address : undefined;
}

export function exportBurnerKey(): string | null {
  return safeGet(KEY_STORAGE);
}

export function resetBurner() {
  safeSet(KEY_STORAGE, null);
  safeSet(CONNECTED_STORAGE, null);
}

export const BURNER_ID = "afterhours-burner";

type Provider = { request: WalletClient["request"] };

/**
 * A wagmi connector backed by a local private-key account. Signs and sends transactions directly
 * over HTTP RPC, so the demo works with no browser extension. Implements `getClient` so wagmi
 * hands writeContract a fully-formed viem WalletClient.
 */
export function burnerConnector(rpcUrl: string) {
  let account: PrivateKeyAccount | undefined;
  const clients = new Map<number, WalletClient>();

  return createConnector<Provider>((config) => {
    const chainFor = (chainId?: number): Chain =>
      config.chains.find((c) => c.id === chainId) ?? config.chains[0];

    const clientFor = (chainId?: number): WalletClient => {
      const chain = chainFor(chainId);
      let c = clients.get(chain.id);
      if (!c) {
        if (!account) account = loadBurnerAccount();
        c = createWalletClient({ account, chain, transport: http(rpcUrl) });
        clients.set(chain.id, c);
      }
      return c;
    };

    return {
      id: BURNER_ID,
      name: "Demo wallet",
      type: "burner" as const,
      supportsSimulation: false,

      async setup() {},

      async connect<withCapabilities extends boolean = false>({
        chainId,
        withCapabilities,
      }: { chainId?: number; isReconnecting?: boolean; withCapabilities?: withCapabilities | boolean } = {}) {
        account = loadBurnerAccount();
        clients.clear();
        safeSet(CONNECTED_STORAGE, "1");
        const accounts = withCapabilities
          ? [{ address: account.address, capabilities: {} as Record<string, unknown> }]
          : [account.address];
        return {
          accounts: accounts as withCapabilities extends true
            ? readonly { address: Address; capabilities: Record<string, unknown> }[]
            : readonly Address[],
          chainId: chainFor(chainId).id,
        };
      },

      async disconnect() {
        safeSet(CONNECTED_STORAGE, null);
      },

      async getAccounts() {
        if (!account) account = loadBurnerAccount();
        return [account.address] as readonly Address[];
      },

      async getChainId() {
        return config.chains[0].id;
      },

      async getProvider({ chainId } = {}) {
        const client = clientFor(chainId);
        return { request: client.request } as Provider;
      },

      async getClient({ chainId } = {}) {
        return clientFor(chainId);
      },

      async isAuthorized() {
        return safeGet(CONNECTED_STORAGE) === "1";
      },

      async switchChain({ chainId }) {
        const chain = chainFor(chainId);
        config.emitter.emit("change", { chainId: chain.id });
        return chain;
      },

      onAccountsChanged() {},
      onChainChanged() {},
      onDisconnect() {
        safeSet(CONNECTED_STORAGE, null);
        config.emitter.emit("disconnect");
      },
    };
  });
}
