// Dump the HackQuest project setup page structure (buttons, progress widgets, header text).
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const PROJECT = "https://www.hackquest.io/projects/setup/dbaf7fa1-dc7d-4d86-868f-4c1224216f85";
const executablePath = ["C:/Program Files/Google/Chrome/Application/chrome.exe"].find((p) => existsSync(p));
const ctx = await chromium.launchPersistentContext(process.env.HQ_PROFILE, { headless: true, executablePath, viewport: { width: 1400, height: 900 } });
const page = ctx.pages()[0] ?? (await ctx.newPage());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await page.goto(PROJECT, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Save Edit" }).first().waitFor({ timeout: 30000 });
  await sleep(3000);
  const main = page.locator("main");
  const head = (await main.innerText()).slice(0, 700);
  const buttons = await main.locator("button").evaluateAll((els) => els.map((b) => b.innerText.trim().replace(/\s+/g, " ")).filter((t) => t && t.length < 60));
  const progress = await page.locator('[role="progressbar"], progress, [class*="progress" i]').evaluateAll((els) => els.map((e) => ({ tag: e.tagName, text: e.innerText?.trim().slice(0, 80), aria: e.getAttribute("aria-valuenow"), cls: (e.className || "").toString().slice(0, 80) })));
  // hover + click the first element whose text contains "Project" near the top bar, then diff
  const before = await page.locator("body").innerText();
  const cand = main.locator("button").filter({ hasText: /Project|%/ }).first();
  let added = [];
  if (await cand.count()) {
    await cand.hover().catch(() => {});
    await sleep(1200);
    let after = await page.locator("body").innerText();
    const b = new Set(before.split("\n"));
    added = after.split("\n").filter((l) => l.trim() && !b.has(l)).slice(0, 40);
    if (!added.length) {
      await cand.click({ force: true }).catch(() => {});
      await sleep(1500);
      after = await page.locator("body").innerText();
      added = after.split("\n").filter((l) => l.trim() && !b.has(l)).slice(0, 40);
    }
  }
  console.log(JSON.stringify({ head, buttons: buttons.slice(0, 40), progress, candidate: (await cand.innerText().catch(() => "-")).replace(/\n/g, " "), added }, null, 2));
} finally {
  await ctx.close();
}
