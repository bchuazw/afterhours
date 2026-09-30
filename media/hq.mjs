// Drive HackQuest with the Playwright MCP's saved (logged-in) Chrome profile.
//   node hq.mjs status                          -> login state + project completeness
//   node hq.mjs upload-demo <mp4>               -> upload the demo video to the project
//   node hq.mjs progress <textfile>             -> replace "Progress During Hackathon"
//   node hq.mjs submit-form <json>              -> fill the hackathon submission form (no final click)
//   node hq.mjs submit-form <json> --submit     -> ... and press Submit
import { chromium } from "playwright";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PROFILE_ROOT = "C:/Users/bchua/AppData/Local/ms-playwright-mcp";
const PROJECT = "https://www.hackquest.io/projects/setup/dbaf7fa1-dc7d-4d86-868f-4c1224216f85";
const SUBMIT = "https://www.hackquest.io/hackathon/17bfad43-fdef-4432-a8d7-7595b7538c41/null/submit";

const executablePath = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].filter(Boolean).find((p) => existsSync(p));

const profiles = readdirSync(PROFILE_ROOT).filter((d) => d.startsWith("mcp-chrome"));
const userDataDir = process.env.HQ_PROFILE ?? join(PROFILE_ROOT, profiles.sort().at(-1));
console.log("profile:", userDataDir, executablePath ? "(system chrome)" : "(bundled chromium)");

const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  executablePath,
  viewport: { width: 1400, height: 900 },
  args: ["--disable-blink-features=AutomationControlled"],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [cmd, arg, flag] = process.argv.slice(2);

async function loggedIn() {
  await page.goto(PROJECT, { waitUntil: "domcontentloaded" });
  await sleep(4000);
  const t = await page.locator("body").innerText();
  return { loggedIn: !/Sign in/i.test(t.slice(0, 3000)) && /Save Edit/.test(t), text: t };
}

try {
  if (cmd === "status") {
    const { loggedIn: ok, text } = await loggedIn();
    const eds = await page.locator('[contenteditable="true"]').evaluateAll((els) => els.map((e) => e.innerText.trim().length));
    await page.getByRole("button", { name: "Demo Video" }).click().catch(() => {});
    await sleep(1000);
    const demo = await page.locator("main video, main source, main [src*='.mp4']").evaluateAll((els) => els.map((e) => (e.currentSrc || e.src || "").slice(-50)));
    console.log(JSON.stringify({ loggedIn: ok, editors: eds, images: (text.match(/Images \(\d\/4\)/) || [])[0], demoVideo: demo }, null, 2));
  } else if (cmd === "upload-demo") {
    const { loggedIn: ok } = await loggedIn();
    if (!ok) throw new Error("not logged in");
    await page.getByRole("button", { name: "Demo Video" }).click();
    await sleep(800);
    // With all 4 images uploaded the images input disappears, so pick the video input by its accept attribute.
    await page.locator('input[type=file][accept*="video"]').first().setInputFiles(arg);
    for (let i = 0; i < 60; i++) {
      await sleep(5000);
      const t = await page.locator("main").innerText();
      if (!/\d+% uploaded/.test(t)) break;
      if (i % 4 === 0) console.log((t.match(/\d+% uploaded/) || ["uploading"])[0]);
    }
    const demo = await page.locator("main video, main source, main [src*='.mp4']").evaluateAll((els) => els.map((e) => (e.currentSrc || e.src || "").slice(-60)));
    await page.getByRole("button", { name: "Save Edit" }).first().click();
    await sleep(5000);
    console.log(JSON.stringify({ demoVideo: demo, url: page.url() }));
  } else if (cmd === "progress") {
    const { loggedIn: ok } = await loggedIn();
    if (!ok) throw new Error("not logged in");
    const paras = readFileSync(arg, "utf8").split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    const ed = page.locator('[contenteditable="true"]').nth(1);
    await ed.scrollIntoViewIfNeeded();
    await ed.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Delete");
    for (let i = 0; i < paras.length; i++) {
      await page.keyboard.insertText(paras[i]);
      if (i < paras.length - 1) await page.keyboard.press("Enter");
    }
    // Let the editor's change handler flush before saving (a nudge keystroke + settle delay).
    await page.keyboard.type(" ");
    await page.keyboard.press("Backspace");
    await sleep(3000);
    const len = (await ed.innerText()).length;
    await page.getByRole("button", { name: "Save Edit" }).first().click();
    await sleep(6000);
    console.log(JSON.stringify({ progressLen: len, url: page.url() }));
  } else if (cmd === "inspect") {
    await page.goto(SUBMIT, { waitUntil: "domcontentloaded" });
    await sleep(5000);
    await page.getByRole("button", { name: /Please select|AfterHours/ }).first().click();
    await sleep(1000);
    const items = await page.getByRole("menuitem").evaluateAll((els) => els.map((e) => ({ text: e.innerText.split(String.fromCharCode(10)).join(" | "), disabled: e.getAttribute("aria-disabled"), title: e.getAttribute("title") })));
    await page.keyboard.press("Escape");
    await page.goto(PROJECT, { waitUntil: "domcontentloaded" });
    await sleep(4000);
    const badgeText = page.getByText(/Incomplete Project|Complete Project/).first();
    await badgeText.waitFor({ timeout: 20000 }).catch(() => {});
    const btn = badgeText.locator("xpath=ancestor-or-self::button[1]").first();
    const badge = await btn.innerText({ timeout: 5000 }).catch(() => "?");
    await btn.click({ force: true }).catch(() => {});
    await sleep(2000);
    const popover = await page.locator('[role="dialog"], [role="tooltip"], [data-radix-popper-content-wrapper], [data-state="open"]').allInnerTexts().catch(() => []);
    // Any inline hints about required fields.
    const hints = await page.locator("main").innerText().then((t) => (t.match(/[^\n]*(required|Required|missing|Missing|incomplete)[^\n]*/g) || []).slice(0, 12));
    popover.push(...hints);
    const walletSection = await page.locator("main").innerText().then((t) => t.slice(t.indexOf("Wallet"), t.indexOf("Wallet") + 200));
    console.log(JSON.stringify({ items, badge: badge.split(String.fromCharCode(10)).join(" "), popover: popover.map((p) => p.slice(0, 800)), walletSection }, null, 2));
  } else if (cmd === "checklist") {
    await page.goto(PROJECT, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Save Edit" }).first().waitFor({ timeout: 30000 });
    await sleep(2500);
    const before = await page.locator("body").innerText();
    const badge = page.locator("text=Incomplete Project").first();
    const html = await badge.evaluate((e) => (e.closest("button") || e.parentElement).outerHTML.slice(0, 600)).catch(() => "?");
    const box = await badge.boundingBox();
    if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await sleep(800); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); }
    await sleep(2000);
    const after = await page.locator("body").innerText();
    const beforeLines = new Set(before.split("\n"));
    const added = after.split("\n").filter((l) => l.trim() && !beforeLines.has(l)).slice(0, 60);
    const tabs = {};
    for (const tab of ["Checkpoints", "Team"]) {
      await page.getByRole("tab", { name: tab }).click().catch(() => {});
      await sleep(2000);
      tabs[tab] = (await page.locator("main").innerText()).slice(0, 1200);
    }
    console.log(JSON.stringify({ badgeHtml: html, added, tabs }, null, 2));
  } else if (cmd === "submit-form") {
    const f = JSON.parse(readFileSync(arg, "utf8"));
    await page.goto(SUBMIT, { waitUntil: "domcontentloaded" });
    await sleep(5000);
    const main = page.locator("body");
    // project selector
    await page.getByRole("button", { name: /Please select|AfterHours/ }).first().click();
    await sleep(800);
    await page.getByRole("menuitem", { name: /AfterHours/ }).first().click();
    await sleep(1500);
    await page.getByText(/contract address/i).first().waitFor({ timeout: 30000 });
    const inputs = main.locator('input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([placeholder*="Search"])');
    await inputs.first().fill(f.contractAddress);
    for (const track of f.tracks) {
      const cb = page.getByRole("checkbox", { name: track }).first();
      if ((await cb.getAttribute("aria-checked")) !== "true") await cb.click({ force: true });
    }
    const tas = main.locator("textarea");
    const texts = [f.frontend, f.core, f.factory, f.token, f.builtDuring];
    for (let i = 0; i < texts.length; i++) await tas.nth(i).fill(texts[i]);
    for (const tech of f.sponsorTech) {
      const cb = page.getByRole("checkbox", { name: tech }).first();
      if ((await cb.getAttribute("aria-checked")) !== "true") await cb.click({ force: true });
    }
    await sleep(500);
    const state = {
      project: await page.getByRole("button", { name: /AfterHours/ }).first().innerText().catch(() => "?"),
      checked: await page.locator('[role="checkbox"][aria-checked="true"]').allInnerTexts(),
      textareas: await tas.evaluateAll((els) => els.map((e) => e.value.length)),
      contract: await inputs.first().inputValue(),
    };
    console.log(JSON.stringify(state, null, 2));
    if (flag === "--submit") {
      await page.getByRole("button", { name: "Submit", exact: true }).click();
      await sleep(5000);
      // HackQuest's modal is a fixed full-screen overlay (not role=dialog): read it, then act only inside it.
      const overlay = page.locator("div.fixed.inset-0").last();
      const readOverlay = async () => ({
        text: (await overlay.innerText().catch(() => "")).replace(/\n+/g, " | ").slice(0, 700),
        buttons: await overlay.locator("button").allInnerTexts().catch(() => []),
      });
      let o = await readOverlay();
      console.log(JSON.stringify({ afterSubmitUrl: page.url(), overlay: o }, null, 2));
      for (let i = 0; i < 3 && o.buttons.length; i++) {
        const btn = overlay.locator("button").filter({ hasText: /confirm|yes|submit|ok|got it|done|continue|back to/i }).first();
        if (!(await btn.count())) break;
        const label = await btn.innerText();
        await btn.click();
        await sleep(6000);
        o = await readOverlay();
        console.log(JSON.stringify({ clicked: label, url: page.url(), overlay: o }, null, 2));
      }
      console.log(JSON.stringify({ finalUrl: page.url(), body: (await page.locator("body").innerText()).slice(0, 500).replace(/\n+/g, " | ") }, null, 2));
    }
  }
} finally {
  await ctx.close();
}
