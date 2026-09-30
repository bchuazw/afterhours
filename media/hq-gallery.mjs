// Pull every submission in the hackathon's Project Gallery by capturing the gallery GraphQL query
// and replaying it page by page. Writes out/gallery.json.
import { chromium } from "playwright";
import { existsSync, writeFileSync } from "node:fs";

const HACK = "https://www.hackquest.io/hackathons/Arbitrum-Open-House-Singapore-Online-Buildathon";
const executablePath = ["C:/Program Files/Google/Chrome/Application/chrome.exe"].find((p) => existsSync(p));
const ctx = await chromium.launchPersistentContext(process.env.HQ_PROFILE, { headless: true, executablePath, viewport: { width: 1400, height: 900 } });
const page = ctx.pages()[0] ?? (await ctx.newPage());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const reqs = [];
page.on("request", (req) => {
  if (req.url().includes("graphql") && req.method() === "POST") {
    const body = req.postData() || "";
    if (/project/i.test(body)) reqs.push({ url: req.url(), headers: req.headers(), body });
  }
});

try {
  await page.goto(HACK, { waitUntil: "domcontentloaded" });
  await sleep(5000);
  await page.getByRole("tab", { name: "Project Gallery" }).click();
  await sleep(6000);
  const listReq = reqs.find((r) => /listProjects|projects\(|ListProjects/i.test(r.body) && !/BySelf|Validate/i.test(r.body)) ?? reqs[reqs.length - 1];
  if (!listReq) throw new Error("gallery query not captured; bodies: " + reqs.map((r) => r.body.slice(0, 120)).join(" || "));
  console.log("captured op:", (listReq.body.match(/"operationName"\s*:\s*"([^"]+)"/) || [])[1], "vars:", (listReq.body.match(/"variables"\s*:\s*(\{.*?\})\s*[,}]/) || [])[1]?.slice(0, 200));
  const parsed = JSON.parse(listReq.body);
  const vars = parsed.variables || {};
  // Replay with a large page size, paging until fewer than requested come back.
  const all = [];
  let pageNo = 1;
  for (; pageNo <= 30; pageNo++) {
    const v = { ...vars };
    for (const k of Object.keys(v)) {
      if (/limit|take|pageSize/i.test(k)) v[k] = 50;
      if (/^page$/i.test(k)) v[k] = pageNo;
      if (/skip|offset/i.test(k)) v[k] = (pageNo - 1) * 50;
    }
    const res = await page.evaluate(async ({ url, headers, body }) => {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: headers.authorization || "" }, body, credentials: "include" });
      return r.text();
    }, { url: listReq.url, headers: listReq.headers, body: JSON.stringify({ ...parsed, variables: v }) });
    let j;
    try { j = JSON.parse(res); } catch { console.log("bad json page", pageNo, res.slice(0, 200)); break; }
    const data = j.data && Object.values(j.data)[0];
    const items = (data && (data.data || data.items || data.list)) || (Array.isArray(data) ? data : []);
    if (pageNo === 1) console.log("page1 keys:", data ? Object.keys(data) : Object.keys(j), "total:", data && data.total);
    if (!items.length) break;
    all.push(...items);
    if (items.length < 50) break;
  }
  writeFileSync("out/gallery.json", JSON.stringify(all, null, 2));
  console.log(`saved ${all.length} projects to out/gallery.json`);
  if (all[0]) console.log("sample keys:", Object.keys(all[0]).join(", "));
} finally {
  await ctx.close();
}
