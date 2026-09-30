// Capture HackQuest GraphQL responses on the submit page and the project setup page to find the
// exact completeness rule that disables the project in the submission dropdown.
import { chromium } from "playwright";
import { existsSync, writeFileSync } from "node:fs";

const PROJECT = "https://www.hackquest.io/projects/setup/dbaf7fa1-dc7d-4d86-868f-4c1224216f85";
const SUBMIT = "https://www.hackquest.io/hackathon/17bfad43-fdef-4432-a8d7-7595b7538c41/null/submit";
const executablePath = ["C:/Program Files/Google/Chrome/Application/chrome.exe"].find((p) => existsSync(p));
const ctx = await chromium.launchPersistentContext(process.env.HQ_PROFILE, { headless: true, executablePath, viewport: { width: 1400, height: 900 } });
const page = ctx.pages()[0] ?? (await ctx.newPage());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const captured = [];
page.on("response", async (res) => {
  try {
    if (!res.url().includes("graphql")) return;
    const req = res.request();
    const body = req.postData() || "";
    const opName = (body.match(/"operationName"\s*:\s*"([^"]+)"/) || [])[1] || (body.match(/(query|mutation)\s+(\w+)/) || [])[2] || "?";
    const text = await res.text();
    captured.push({ opName, size: text.length, text });
  } catch {}
});
try {
  await page.goto(SUBMIT, { waitUntil: "domcontentloaded" });
  await sleep(7000);
  await page.getByRole("button", { name: /Please select|AfterHours/ }).first().click().catch(() => {});
  await sleep(2000);
  await page.goto(PROJECT, { waitUntil: "domcontentloaded" });
  await sleep(7000);
} finally {
  await ctx.close();
}
writeFileSync("out/hq-capture.json", JSON.stringify(captured.map((c) => ({ opName: c.opName, size: c.size })), null, 2));
const KEYS = /complet|progress|require|missing|status|percent|standard|wallet|checkpoint|team|isSubmit|submitted|video/i;
for (const c of captured) {
  if (!/AfterHours|dbaf7fa1/.test(c.text)) continue;
  console.log(`\n=== ${c.opName} (${c.size} bytes) ===`);
  try {
    const j = JSON.parse(c.text);
    const walk = (o, path) => {
      if (o && typeof o === "object") {
        if (Array.isArray(o)) o.forEach((v, i) => walk(v, `${path}[${i}]`));
        else for (const [k, v] of Object.entries(o)) {
          if (KEYS.test(k) && (typeof v !== "object" || v === null || Array.isArray(v) || Object.keys(v).length < 12)) console.log(`${path}.${k} = ${JSON.stringify(v).slice(0, Number(process.env.SLICE ?? 300))}`);
          walk(v, `${path}.${k}`);
        }
      }
    };
    walk(j, "$");
  } catch { console.log(c.text.slice(0, 500)); }
}
