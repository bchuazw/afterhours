// Inspect (and optionally replace) the project's videos on HackQuest.
//   node hq-videos.mjs inspect
//   node hq-videos.mjs replace pitch <mp4>   |   node hq-videos.mjs replace demo <mp4>
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const PROJECT = "https://www.hackquest.io/projects/setup/dbaf7fa1-dc7d-4d86-868f-4c1224216f85";
const executablePath = ["C:/Program Files/Google/Chrome/Application/chrome.exe"].find((p) => existsSync(p));
const ctx = await chromium.launchPersistentContext(process.env.HQ_PROFILE, { headless: true, executablePath, viewport: { width: 1400, height: 900 } });
const page = ctx.pages()[0] ?? (await ctx.newPage());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [cmd, which, file] = process.argv.slice(2);

async function videosSection() {
  // The Videos heading's enclosing block.
  const h = page.getByRole("heading", { name: "Videos" }).first();
  const block = h.locator("xpath=ancestor::div[2]");
  return block;
}

try {
  await page.goto(PROJECT, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Save Edit" }).first().waitFor({ timeout: 30000 });
  await sleep(2500);
  await page.getByRole("button", { name: which === "demo" ? "Demo Video" : "Pitch Video" }).click();
  await sleep(1200);
  const block = await videosSection();
  const dump = async () => ({
    text: (await block.innerText()).replace(/\n+/g, " | ").slice(0, 300),
    buttons: await block.locator("button").evaluateAll((els) => els.map((b) => ({ text: b.innerText.trim(), aria: b.getAttribute("aria-label"), title: b.getAttribute("title"), svg: !!b.querySelector("svg"), cls: (b.className || "").toString().slice(0, 60) }))),
    fileInputs: await block.locator("input[type=file]").count(),
    videos: await block.locator("video, source").evaluateAll((els) => els.map((v) => (v.currentSrc || v.src || "").slice(-45))),
  });
  console.log("before:", JSON.stringify(await dump(), null, 2));
  if (cmd === "replace") {
    // Remove the existing video: an icon-only button inside the block (not the tab buttons).
    const removeBtn = block.locator("button[class*='border-2']").filter({ has: page.locator("svg") }).first();
    if (await removeBtn.count()) {
      await removeBtn.hover();
      await sleep(500);
      await removeBtn.click();
      await sleep(2000);
      const overlay = page.locator('[role="dialog"], div.fixed.inset-0').last();
      console.log("overlay:", JSON.stringify((await overlay.innerText().catch(() => "")).replace(/\n+/g, " | ").slice(0, 300)));
      const confirm = overlay.locator("button").filter({ hasText: /confirm|yes|delete|remove|ok/i }).first();
      if (await confirm.count()) { await confirm.click(); await sleep(2000); }
    }
    console.log("after remove:", JSON.stringify(await dump(), null, 2));
    const input = block.locator("input[type=file]").first();
    await input.waitFor({ state: "attached", timeout: 15000 });
    await input.setInputFiles(file);
    for (let i = 0; i < 60; i++) {
      await sleep(5000);
      const t = await page.locator("main").innerText();
      if (!/\d+% uploaded/.test(t)) break;
    }
    console.log("after upload:", JSON.stringify(await dump(), null, 2));
    await page.getByRole("button", { name: "Save Edit" }).first().click();
    await sleep(6000);
    console.log("saved:", page.url());
  }
} finally {
  await ctx.close();
}
