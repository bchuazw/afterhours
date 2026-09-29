import { createPublicClient, http, parseAbi } from "viem";
const client = createPublicClient({ chain: { id: 4663, name: "rh", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } }, contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } } }, transport: http() });
const abi = parseAbi(["function getRoundData(uint80) view returns (uint80,int256,uint256,uint256,uint80)", "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"]);
const feeds = { TSLA: "0x4A1166a659A55625345e9515b32adECea5547C38", AMZN: "0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C", NVDA: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15", PLTR: "0x820ABedFF239034956B7A9d2F0a331f9F075eB4c", AMD: "0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72" };
const base = 1n << 64n;
for (const [sym, f] of Object.entries(feeds)) {
  const [lid] = await client.readContract({ address: f, abi, functionName: "latestRoundData" });
  const n = lid - base;
  let invalid = [], missing = [], lastInvalid = null, firstValid = null;
  for (let s = 1n; s <= n; s += 200n) {
    const ids = []; for (let i = s; i < s + 200n && i <= n; i++) ids.push(base + i);
    const res = await client.multicall({ contracts: ids.map((id) => ({ address: f, abi, functionName: "getRoundData", args: [id] })), allowFailure: true });
    res.forEach((r, k) => {
      const idx = ids[k] - base;
      if (r.status !== "success") { missing.push(idx); return; }
      const [, a, , at] = r.result;
      if (at === 0n) { missing.push(idx); return; }
      if (a <= 0n || a >= 10n ** 14n) { invalid.push([idx, a, at]); }
      else if (firstValid === null) firstValid = [idx, at];
    });
  }
  const inv = invalid.map(([i, a, at]) => `#${i}@${new Date(Number(at) * 1000).toISOString()}`);
  console.log(sym, "latest idx", n, "invalid", invalid.length, "missing", missing.length, "firstValid", firstValid && `#${firstValid[0]}@${new Date(Number(firstValid[1])*1000).toISOString()}`);
  console.log("  invalid first/last:", inv.slice(0, 3).join(" "), "...", inv.slice(-3).join(" "));
  // any invalid after first valid?
  const late = invalid.filter(([i]) => firstValid && i > firstValid[0]);
  console.log("  invalid interleaved after first valid:", late.length, late.slice(0,5).map(([i,a,at])=>`#${i} a=${a} @${new Date(Number(at)*1000).toISOString()}`).join("; "));
}
