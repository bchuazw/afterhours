// Connect a wallet on the HackQuest project page by injecting an EIP-1193 provider backed by a
// private key (WALLET_KEY). Used for the "Wallet" field on the project (reward payout address).
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";

const PROJECT = "https://www.hackquest.io/projects/setup/dbaf7fa1-dc7d-4d86-868f-4c1224216f85";
const CHAIN_HEX = process.env.WALLET_CHAIN_HEX ?? "0xb626"; // Robinhood Chain testnet 46630
const account = privateKeyToAccount(process.env.WALLET_KEY);
console.log("wallet:", account.address);

const executablePath = ["C:/Program Files/Google/Chrome/Application/chrome.exe"].find((p) => existsSync(p));
const ctx = await chromium.launchPersistentContext(process.env.HQ_PROFILE, { headless: true, executablePath, viewport: { width: 1400, height: 900 } });
const page = ctx.pages()[0] ?? (await ctx.newPage());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await page.exposeFunction("__walletSign", async (method, params) => {
  if (method === "personal_sign") {
    const [data] = params; // hex or utf8
    const message = typeof data === "string" && data.startsWith("0x") ? { raw: data } : data;
    return account.signMessage({ message });
  }
  if (method === "eth_signTypedData_v4" || method === "eth_signTypedData") {
    const typed = JSON.parse(params[1]);
    const { EIP712Domain, ...types } = typed.types;
    return account.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message });
  }
  throw new Error(`unsupported ${method}`);
});
await ctx.addInitScript(({ address, chainHex }) => {
  const listeners = {};
  const provider = {
    isMetaMask: true,
    _metamask: { isUnlocked: async () => true },
    selectedAddress: address,
    chainId: chainHex,
    networkVersion: String(parseInt(chainHex, 16)),
    on(ev, fn) { (listeners[ev] ||= []).push(fn); return provider; },
    removeListener(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); return provider; },
    async request({ method, params }) {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts": return [address];
        case "eth_chainId": return chainHex;
        case "net_version": return String(parseInt(chainHex, 16));
        case "wallet_switchEthereumChain": return null;
        case "wallet_addEthereumChain": return null;
        case "personal_sign":
        case "eth_signTypedData":
        case "eth_signTypedData_v4": return window.__walletSign(method, params);
        case "eth_getBalance": return "0x0";
        default: throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
      }
    },
    enable: async () => [address],
    send: (m, p) => provider.request({ method: m, params: p }),
  };
  Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
  window.dispatchEvent(new Event("ethereum#initialized"));
  // EIP-6963 announce
  const info = { uuid: "3fa3b6d8-3f2e-4b1a-9c1d-afterhours0001", name: "MetaMask", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", rdns: "io.metamask" };
  window.addEventListener("eip6963:requestProvider", () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) })));
  window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
}, { address: account.address, chainHex: CHAIN_HEX });

try {
  await page.goto(PROJECT, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Save Edit" }).first().waitFor({ timeout: 30000 });
  await sleep(2500);
  const connect = page.getByRole("button", { name: "Connect Wallet" }).first();
  await connect.scrollIntoViewIfNeeded();
  await connect.click();
  await sleep(2500);
  const dialogText = await page.locator('[role="dialog"]').allInnerTexts().catch(() => []);
  console.log("dialog:", JSON.stringify(dialogText.map((t) => t.slice(0, 400))));
  // pick an injected/MetaMask option if a chooser opened
  const opt = page.locator('[role="dialog"] button, [role="dialog"] [role="button"]').filter({ hasText: /MetaMask|Injected|Browser Wallet|Detected/i }).first();
  if (await opt.count()) { await opt.click(); await sleep(3000); }
  const walletText = await page.locator("main").innerText().then((t) => t.slice(t.indexOf("Wallet"), t.indexOf("Wallet") + 260));
  console.log("wallet section:", JSON.stringify(walletText));
  await page.getByRole("button", { name: "Save Edit" }).first().click();
  await sleep(5000);
  console.log("saved, url:", page.url());
} finally {
  await ctx.close();
}
