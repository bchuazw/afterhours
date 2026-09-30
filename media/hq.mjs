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
    await page.locator("input[type=file]").nth(2).setInputFiles(arg);
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
    const len = (await ed.innerText()).length;
    await page.getByRole("button", { name: "Save Edit" }).first().click();
    await sleep(5000);
    console.log(JSON.stringify({ progressLen: len, url: page.url() }));
  } else if (cmd === "inspect") {
    await page.goto(SUBMIT, { waitUntil: "domcontentloaded" });
    await sleep(5000);
    await page.getByRole("button", { name: /Please select|AfterHours/ }).first().click();
    await sleep(1000);
    const items = await page.getByRole("menuitem").evaluateAll((els) => els.map((e) => ({ text: e.innerText.replace(/
/g, " | "), disabled: e.getAttribute("aria-disabled"), title: e.getAttribute("title") })));
    await page.keyboard.press("Escape");
    await page.goto(PROJECT, { waitUntil: "domcontentloaded" });
    await sleep(4000);
    const btn = page.getByRole("button", { name: /Incomplete Project|Complete/ }).first();
    const badge = await btn.innerText().catch(() => "?");
    await btn.click().catch(() => {});
    await sleep(1500);
    const popover = await page.locator('[role="dialog"], [role="tooltip"], [data-radix-popper-content-wrapper]').allInnerTexts().catch(() => []);
    const walletSection = await page.locator("main").innerText().then((t) => t.slice(t.indexOf("Wallet"), t.indexOf("Wallet") + 200));
    console.log(JSON.stringify({ items, badge: badge.replace(/
/g, " "), popover: popover.map((p) => p.slice(0, 800)), walletSection }, null, 2));
  } else if (cmd === "submit-form") {
    const f = JSON.parse(readFileSync(arg, "utf8"));
    await page.goto(SUBMIT, { waitUntil: "domcontentloaded" });
    await sleep(5000);
    const main = page.locator("body");
    // project selector
    await page.getByRole("button", { name: /Please select|AfterHours/ }).first().click();
    await sleep(800);
    await page.getByRole("menuitem", { name: /AfterHours/ }).first().click();
    await sleep(800);
    const inputs = main.locator("input[type=text]");
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
      await sleep(6000);
      const dlg = await page.locator('[role="dialog"]').allInnerTexts().catch(() => []);
      console.log(JSON.stringify({ afterSubmitUrl: page.url(), dialog: dlg.map((d) => d.slice(0, 500)), body: (await page.locator("body").innerText()).slice(0, 600) }, null, 2));
      // confirm dialogs, if any
      const confirm = page.getByRole("button", { name: /^(Confirm|Yes|Submit|OK)$/ }).first();
      if (await confirm.count()) {
        await confirm.click();
        await sleep(6000);
        console.log(JSON.stringify({ afterConfirmUrl: page.url(), body: (await page.locator("body").innerText()).slice(0, 600) }, null, 2));
      }
    }
  }
} finally {
  await ctx.close();
}
