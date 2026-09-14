// Renders an HTML slide deck into a narrated MP4.
//   node build-video.mjs pitch          -> media/out/pitch.mp4
//   node build-video.mjs logo           -> media/out/logo.png (1024x1024)
// Requires: playwright (pnpm i), ffmpeg/ffprobe on PATH, python with edge-tts.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "out");
mkdirSync(OUT, { recursive: true });

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Users/bchua/AppData/Local/ms-playwright/mcp-chrome-b320712/chrome-win/chrome.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].filter(Boolean);
const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));

async function browser() {
  return chromium.launch({ executablePath, headless: true });
}

function run(cmd, args) {
  return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"] }).toString();
}

function duration(file) {
  return parseFloat(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]));
}

async function renderLogo() {
  const b = await browser();
  const page = await b.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  const svg = readFileSync(join(here, "logo.svg"), "utf8");
  await page.setContent(`<html><body style="margin:0;background:#0B0F19">${svg.replace('width="512" height="512"', 'width="1024" height="1024"')}</body></html>`);
  await page.screenshot({ path: join(OUT, "logo.png"), fullPage: false });
  await b.close();
  console.log("wrote", join(OUT, "logo.png"));
}

async function renderDeck(name) {
  const dir = join(here, name);
  const deck = JSON.parse(readFileSync(join(dir, "narration.json"), "utf8"));
  const b = await browser();
  const page = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(join(dir, "slides.html")).href);
  await page.waitForTimeout(300);

  const segments = [];
  for (const s of deck.slides) {
    const png = join(OUT, `${name}-${s.id}.png`);
    const mp3 = join(OUT, `${name}-${s.id}.mp3`);
    const seg = join(OUT, `${name}-${s.id}.mp4`);
    await page.locator(`#${s.id}`).screenshot({ path: png });
    if (!existsSync(mp3) || process.env.FORCE_TTS) {
      run("python", ["-m", "edge_tts", "--voice", deck.voice, "--rate", deck.rate ?? "+0%", "--text", s.text, "--write-media", mp3]);
    }
    const d = duration(mp3) + 0.8; // breathing room after each slide
    run("ffmpeg", [
      "-y", "-loglevel", "error",
      "-loop", "1", "-framerate", "30", "-i", png,
      "-i", mp3,
      "-af", "apad",
      "-c:v", "libx264", "-preset", "medium", "-tune", "stillimage", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-ar", "44100",
      "-t", d.toFixed(2), "-shortest",
      seg,
    ]);
    segments.push({ seg, d });
    console.log(`${s.id}: ${d.toFixed(1)}s`);
  }
  await b.close();

  const list = join(OUT, `${name}-concat.txt`);
  writeFileSync(list, segments.map((s) => `file '${s.seg.replace(/\\/g, "/")}'`).join("\n"));
  const final = join(OUT, `${name}.mp4`);
  run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", final]);
  const total = segments.reduce((a, s) => a + s.d, 0);
  console.log(`wrote ${final} (${total.toFixed(0)}s)`);
}

const what = process.argv[2] ?? "pitch";
if (what === "logo") await renderLogo();
else await renderDeck(what);
