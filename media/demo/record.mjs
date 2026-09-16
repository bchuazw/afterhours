// Records the AfterHours demo as narrated scenes against a running app (default http://127.0.0.1:3000).
//   BURNER_KEY=0x... node demo/record.mjs            -> media/out/demo.mp4
// Each scene is recorded in its own browser context (webm), then muxed with its narration and concatenated.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "out");
const RAW = join(OUT, "demo-raw");
mkdirSync(RAW, { recursive: true });
const BASE = process.env.APP_URL ?? "http://127.0.0.1:3000";
const deck = JSON.parse(readFileSync(join(here, "narration.json"), "utf8"));

const executablePath = [
  process.env.CHROME_PATH,
  "C:/Users/bchua/AppData/Local/ms-playwright/mcp-chrome-b320712/chrome-win/chrome.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].filter(Boolean).find((p) => existsSync(p));

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"] }).toString();
const duration = (f) => parseFloat(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A visible cursor so viewers can follow clicks (headless Chrome draws none).
const CURSOR_SCRIPT = `
  (() => {
    const c = document.createElement('div');
    c.id = '__cursor';
    c.style.cssText = 'position:fixed;z-index:2147483647;width:18px;height:18px;border-radius:50%;background:rgba(124,92,255,.85);box-shadow:0 0 0 4px rgba(124,92,255,.25);pointer-events:none;transform:translate(-50%,-50%);transition:transform .08s;left:-100px;top:-100px';
    const attach = () => document.body && document.body.appendChild(c);
    if (document.body) attach(); else document.addEventListener('DOMContentLoaded', attach);
    window.addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    window.addEventListener('mousedown', () => { c.style.transform = 'translate(-50%,-50%) scale(.7)'; }, true);
    window.addEventListener('mouseup', () => { c.style.transform = 'translate(-50%,-50%) scale(1)'; }, true);
  })();`;

async function newScene(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    recordVideo: { dir: RAW, size: { width: 1280, height: 720 } },
    colorScheme: "dark",
  });
  if (process.env.BURNER_KEY) {
    await ctx.addInitScript(
      ([k]) => {
        try {
          window.localStorage.setItem("afterhours.burner.key", k);
          window.localStorage.setItem("afterhours.burner.connected", "1");
        } catch {}
      },
      [process.env.BURNER_KEY],
    );
  }
  await ctx.addInitScript(CURSOR_SCRIPT);
  const page = await ctx.newPage();
  return { ctx, page };
}

async function ensureCursor(page) {
  await page.evaluate(() => {
    if (document.getElementById("__cursor")) return;
    const c = document.createElement("div");
    c.id = "__cursor";
    c.style.cssText =
      "position:fixed;z-index:2147483647;width:18px;height:18px;border-radius:50%;background:rgba(124,92,255,.85);box-shadow:0 0 0 4px rgba(124,92,255,.25);pointer-events:none;transform:translate(-50%,-50%);transition:transform .08s;left:-100px;top:-100px";
    document.documentElement.appendChild(c);
    window.addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
    window.addEventListener("mousedown", () => { c.style.transform = "translate(-50%,-50%) scale(.7)"; }, true);
    window.addEventListener("mouseup", () => { c.style.transform = "translate(-50%,-50%) scale(1)"; }, true);
  });
}

async function glide(page, locator, opts = {}) {
  await ensureCursor(page);
  await locator.scrollIntoViewIfNeeded();
  await sleep(250);
  const box = await locator.boundingBox();
  if (!box) throw new Error("no box for locator");
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 18 });
  await sleep(opts.pause ?? 350);
  if (opts.click !== false) await page.mouse.click(x, y);
}

async function waitToast(page, text, timeout = 90_000) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout });
}

// ---- scenes -------------------------------------------------------------------------------------

const scenes = {
  async d1(page) {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.getByText("Last print", { exact: false }).first().waitFor({ timeout: 30_000 });
    await sleep(3000);
    for (const sym of ["TSLA", "AMZN", "NVDA"]) {
      await glide(page, page.getByRole("button", { name: new RegExp(`^${sym}\\b`) }).first(), { click: false, pause: 2600 });
    }
    await glide(page, page.getByText("Quiet", { exact: true }).first(), { click: false, pause: 3000 }).catch(() => {});
    await glide(page, page.getByRole("button", { name: /^TSLA\b/ }).first(), { pause: 800 });
    await sleep(5000);
  },
  async d2(page) {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.getByText("Last print", { exact: false }).first().waitFor({ timeout: 30_000 });
    await sleep(1500);
    await glide(page, page.getByRole("button", { name: /^TSLA\b/ }).first(), { pause: 700 });
    await sleep(1500);
    await glide(page, page.getByRole("button", { name: "90%" }), { pause: 900 });
    await sleep(1500);
    await glide(page, page.getByRole("button", { name: "Monday open" }), { pause: 900 });
    await sleep(1500);
    const shares = page.getByRole("button", { name: "10", exact: true });
    if (await shares.count()) await glide(page, shares.first(), { pause: 900 });
    await page.getByText("Effective vol", { exact: false }).first().waitFor({ timeout: 30_000 });
    await sleep(1500);
    await glide(page, page.getByText("Premium", { exact: true }).first(), { click: false, pause: 3000 }).catch(() => {});
    await glide(page, page.getByText("Effective vol", { exact: false }).first(), { click: false, pause: 3500 });
    await glide(page, page.getByText("Closed-market time", { exact: false }).first(), { click: false, pause: 3500 });
    await glide(page, page.getByText("Collateral locked", { exact: false }).first(), { click: false, pause: 2500 });
    await glide(page, page.getByText("Breakeven", { exact: false }).first(), { click: false, pause: 3500 });
  },
  async d3(page) {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.getByText("Last print", { exact: false }).first().waitFor({ timeout: 30_000 });
    await glide(page, page.getByRole("button", { name: /^TSLA\b/ }).first(), { pause: 300 });
    await glide(page, page.getByRole("button", { name: "90%" }), { pause: 300 });
    await glide(page, page.getByRole("button", { name: "Monday open" }), { pause: 300 });
    const shares = page.getByRole("button", { name: "10", exact: true });
    if (await shares.count()) await glide(page, shares.first(), { pause: 300 });
    await page.getByText("Effective vol", { exact: false }).first().waitFor({ timeout: 30_000 });
    const buy = page.getByRole("button", { name: /buy protection/i });
    await buy.waitFor({ timeout: 30_000 });
    await glide(page, buy, { pause: 900 });
    await page.getByText(/Buy TSLA protection confirmed/i).first().waitFor({ timeout: 120_000 }).catch(() => {});
    await sleep(5000);
  },
  async d4(page) {
    await page.goto(BASE + "/positions", { waitUntil: "networkidle" });
    await page.getByText("put", { exact: false }).first().waitFor({ timeout: 60_000 });
    await sleep(2500);
    const settle = page.getByRole("button", { name: "Settle", exact: true });
    if (await settle.count()) {
      await glide(page, settle.first(), { pause: 1200 });
      await page.getByText(/Settle TSLA series confirmed/i).first().waitFor({ timeout: 120_000 }).catch(() => {});
      await page.getByRole("button", { name: /^Claim/ }).first().waitFor({ timeout: 60_000 }).catch(() => {});
      await sleep(3500);
    }
    const claim = page.getByRole("button", { name: /^Claim/ });
    if (await claim.count()) {
      await glide(page, claim.first(), { pause: 1200 });
      await page.getByText(/^Claim .*confirmed/i).first().waitFor({ timeout: 120_000 }).catch(() => {});
      await sleep(3000);
    }
    await sleep(4000);
  },
  async d5(page) {
    await page.goto(BASE + "/earn", { waitUntil: "networkidle" });
    await page.getByText("Earned premiums", { exact: false }).first().waitFor({ timeout: 60_000 });
    await sleep(1500);
    const card = page.locator("div", { has: page.getByText("TSLA vault", { exact: false }) }).filter({ has: page.getByPlaceholder("0.00") }).last();
    await glide(page, card.getByText("Earned premiums", { exact: false }).first(), { click: false, pause: 2500 });
    await glide(page, card.getByText("utilization", { exact: false }).first(), { click: false, pause: 2000 });
    const amount = card.getByPlaceholder("0.00").first();
    if (await amount.count()) {
      await glide(page, amount, { pause: 400 });
      await amount.fill("1000");
      await sleep(800);
      // The mode toggle is also labelled "Deposit"; the action button is the primary one.
      const btn = card.locator("button.btn-primary").filter({ hasText: /deposit/i }).first();
      await glide(page, btn, { pause: 800 });
      await page.getByText(/Deposit into TSLA vault/i).first().waitFor({ timeout: 120_000 }).catch(() => {});
      await sleep(6000);
    }
    await sleep(3000);
  },
};

// ---- main ---------------------------------------------------------------------------------------

const only = process.argv[2];
const browser = await chromium.launch({ executablePath, headless: true });
const segments = [];
for (const s of deck.scenes) {
  if (only && s.id !== only) continue;
  const { ctx, page } = await newScene(browser);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await scenes[s.id](page);
  } catch (e) {
    console.error(`[${s.id}] scene error:`, e.message);
  }
  const video = page.video();
  await ctx.close();
  const webm = await video.path();
  const named = join(RAW, `${s.id}.webm`);
  renameSync(webm, named);

  const mp3 = join(OUT, `demo-${s.id}.mp3`);
  if (!existsSync(mp3) || process.env.FORCE_TTS) {
    run("python", ["-m", "edge_tts", "--voice", deck.voice, "--rate", deck.rate ?? "+0%", "--text", s.text, "--write-media", mp3]);
  }
  const vd = duration(named), ad = duration(mp3);
  const target = Math.max(vd, ad + 0.8);
  const seg = join(OUT, `demo-${s.id}.mp4`);
  // Extend the last frame if narration outruns the footage; pad audio otherwise.
  run("ffmpeg", [
    "-y", "-loglevel", "error",
    "-i", named, "-i", mp3,
    "-filter_complex", `[0:v]scale=1280:720,fps=30,tpad=stop_mode=clone:stop_duration=${Math.max(0, target - vd + 0.5).toFixed(2)},format=yuv420p[v];[1:a]apad[a]`,
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    "-c:a", "aac", "-b:a", "160k", "-ar", "44100",
    "-t", target.toFixed(2), seg,
  ]);
  segments.push(seg);
  console.log(`${s.id}: video ${vd.toFixed(1)}s, narration ${ad.toFixed(1)}s -> ${target.toFixed(1)}s`);
  for (const e of [...new Set(errors)].slice(0, 3)) {
    const diff = e.split("\n").filter((l) => /^\s*[+-] /.test(l) || /<[A-Z][A-Za-z]+/.test(l)).slice(-14).join("\n");
    console.log(`  page error: ${e.split("\n")[0].slice(0, 160)}\n${diff}`);
  }
}
await browser.close();

if (!only) {
  const list = join(OUT, "demo-concat.txt");
  writeFileSync(list, segments.map((s) => `file '${s.replace(/\\/g, "/")}'`).join("\n"));
  const final = join(OUT, "demo.mp4");
  run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", final]);
  console.log("wrote", final, `(${duration(final).toFixed(0)}s)`);
}
