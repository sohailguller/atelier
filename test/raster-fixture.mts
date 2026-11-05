// ACCEPTANCE FIXTURE for the "railway class" — the reference's OWN marketing page baked into the clone as
// PIXELS, which every text-based check reports as clean (railway shipped a 1408×1700 data-URI screenshot of
// the reference's hero while innerText read perfectly swapped). Regenerate it beside a PASSING build and the
// rendered check must fail that build:
//
//   npx tsx test/raster-fixture.mts build/review/resend-clone
//   npx tsx src/render-audit.ts build/review/resend-clone --index build/review/resend-clone/index.fixture.html
//   → ✗ "the reference's own page is baked in as PIXELS" (the vision detector; the mark matcher does NOT see
//     this class — a wordmark inside a full-page raster is at the wrong scale for a template, which is
//     exactly why there are two detectors)
//   rm build/review/resend-clone/index.fixture.html
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2]);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => { (globalThis as any).__name = (globalThis as any).__name || ((f: unknown) => f); });
// The untouched clone IS the reference's page, pixel for pixel — no network needed to reproduce the defect.
await page.goto("file://" + path.join(dir, "index.clone.html"), { waitUntil: "load" });
await page.waitForTimeout(1500);
const shot = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1440, height: 900 } });
await browser.close();

const html = readFileSync(path.join(dir, "index.html"), "utf8");
const img = `<img src="data:image/png;base64,${shot.toString("base64")}" alt="" style="display:block;width:1100px;max-width:100%;margin:48px auto">`;
// Place it MID-PAGE (just before the footer), where railway's rasterised tab frame sat — putting it at the
// very top would let the header tile catch it and prove nothing about the body.
const out = html.includes("<footer") ? html.replace("<footer", `${img}<footer`) : html.replace(/(<body[^>]*>)/i, `$1${img}`);
writeFileSync(path.join(dir, "index.fixture.html"), out);
console.log(`fixture written: ${path.join(dir, "index.fixture.html")}  (+${Math.round(shot.length / 1024)}KB raster of the reference's own hero)`);
