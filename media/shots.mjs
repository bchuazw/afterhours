// Screenshot pages at 1280x720 (HackQuest image size).
//   node shots.mjs http://localhost:4173 protect=/ earn=/earn positions=/positions how=/how-it-works
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "out", "shots");
mkdirSync(OUT, { recursive: true });

const [base, ...pairs] = process.argv.slice(2);
const executablePath = [
  process.env.CHROME_PATH,
  "C:/Users/bchua/AppData/Local/ms-playwright/mcp-chrome-b320712/chrome-win/chrome.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].filter(Boolean).find((p) => existsSync(p));
const b = await chromium.launch({ headless: true, executablePath });
const page = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));
for (const pair of pairs) {
  const [name, path] = pair.split("=");
  await page.goto(base + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log("wrote", file);
}
await b.close();
if (errors.length) console.log("console errors:\n" + [...new Set(errors)].slice(0, 10).join("\n"));
