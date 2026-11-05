// Browser lifecycle: launch, navigate, startup screenshot health check, screenshots.
import { chromium, type Browser, type Page } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { HealthCheck } from "./types.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface NetworkAssets {
  fonts: Set<string>;
  images: Set<string>; // svg / raster design assets seen on the wire
}

export interface Session {
  browser: Browser;
  page: Page;
  network: NetworkAssets;
}

export async function launch(url: string): Promise<Session> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    // Set before navigation so components that read matchMedia at mount render their STATIC image
    // fallbacks instead of autoplaying <video>/canvas showcases — a static clone can only reproduce
    // the still image, not the video element. (clonePage re-asserts this for good measure.)
    reducedMotion: "reduce",
    // Pin the colour scheme so the clone is deterministic (a theme-toggling site otherwise freezes
    // whatever theme happened to be active at capture — often dark — which mutes fine light-theme
    // details). Light matches what a fresh visitor sees on most marketing pages.
    colorScheme: "light",
  });
  const page = await context.newPage();

  // Capture real asset URLs off the wire. This is CORS/CSSOM-proof: it catches fonts and
  // SVGs even when the stylesheet that references them is a cross-origin CDN sheet whose
  // cssRules throw (exactly Linear's case). Feeds the download step.
  const network: NetworkAssets = { fonts: new Set(), images: new Set() };
  page.on("response", (res) => {
    const u = res.url();
    if (u.startsWith("data:")) return;
    const ct = (res.headers()["content-type"] || "").toLowerCase();
    if (ct.includes("font") || /\.(woff2?|otf|ttf)(\?|$)/i.test(u)) network.fonts.add(u.split("#")[0]);
    else if (ct === "image/svg+xml" || /\.svg(\?|$)/i.test(u)) network.images.add(u.split("#")[0]);
  });

  // tsx/esbuild compiles our probe functions with `keepNames`, which injects a `__name`
  // helper. When Playwright ships those functions into the page for evaluate(), that helper
  // doesn't exist in the browser context. Define a no-op shim in every page context so the
  // injected `__name(fn, "...")` calls resolve. Must be set before navigation.
  await page.addInitScript(() => {
    (globalThis as any).__name = (globalThis as any).__name || ((fn: unknown) => fn);
  });

  // networkidle can hang on sites with long-poll/analytics; race it against a cap.
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await Promise.race([
    page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {}),
    page.waitForTimeout(15_000),
  ]);
  // Let webfonts settle so computed styles report the real family.
  await page.evaluate(() => (document as any).fonts?.ready).catch(() => {});
  await page.waitForTimeout(800);

  return { browser, page, network };
}

/** tsx compiles our evaluate() callbacks with keepNames, which injects a `__name` helper that does not exist
 *  in a page context (see the tsx+Playwright evaluate gotcha). Every page we measure in needs the shim, and it
 *  only runs on navigation — hence the goto in each helper below. */
async function shim(page: Page): Promise<void> {
  await page.addInitScript(() => { (globalThis as any).__name = (globalThis as any).__name || ((fn: unknown) => fn); });
}

/**
 * Open a page for MEASUREMENT (audit / verify / rendered check), as opposed to `launch()` which sets up a
 * capture session. `networkidle` is never a hard gate here: a build that cloned and swapped perfectly must not
 * fail because several browsers were contending (measured — it cost a whole clerk build). Load, then chase
 * idle opportunistically.
 */
export async function openStatic(browser: Browser, file: string, width = 1440): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await shim(page);
  await page.goto("file://" + path.resolve(file), { waitUntil: "load", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(700);
  return page;
}

/** The same, for a live URL — a light read of a reference page (no network capture, no clone settling). */
export async function openLive(browser: Browser, url: string, width = 1440): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await shim(page);
  await page.goto(/^https?:\/\//.test(url) ? url : "https://" + url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return page;
}

/** A blank page used purely as a compute surface (canvas work in the rendered check). */
export async function openScratch(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await shim(page);
  await page.goto("about:blank");
  return page;
}

/**
 * Recovery branch #1 (gate): decide whether we actually have a visual channel.
 * Take a startup screenshot; the channel is healthy only if the PNG is non-trivial
 * AND the page rendered real content. When unhealthy, the pipeline runs on DOM
 * measurement alone (see probes.ts / tokens.ts), and this is recorded in SPEC.
 */
export async function healthCheck(page: Page): Promise<HealthCheck> {
  // Test hook: force the visual channel down to exercise the DOM-measurement fallback
  // end-to-end against any real site.
  if (process.env.ATELIER_FORCE_NO_VISUAL === "1") {
    return { visualChannel: false, screenshotBytes: 0, reason: "forced down via ATELIER_FORCE_NO_VISUAL (test hook)" };
  }
  let bytes = 0;
  try {
    const buf = await page.screenshot({ type: "png", timeout: 15_000 });
    bytes = buf.length;
  } catch (e) {
    return { visualChannel: false, screenshotBytes: 0, reason: `screenshot threw: ${(e as Error).message}` };
  }

  const dom = await page
    .evaluate(() => ({
      elements: document.querySelectorAll("*").length,
      text: (document.body?.innerText ?? "").trim().length,
    }))
    .catch(() => ({ elements: 0, text: 0 }));

  const BYTE_FLOOR = 8 * 1024; // a blank/near-blank capture compresses tiny
  const domOk = dom.elements > 50 && dom.text > 200;
  const byteOk = bytes > BYTE_FLOOR;

  if (byteOk && domOk) {
    return { visualChannel: true, screenshotBytes: bytes, reason: "screenshot + DOM both healthy" };
  }
  const why: string[] = [];
  if (!byteOk) why.push(`screenshot only ${bytes}B (< ${BYTE_FLOOR}B floor)`);
  if (!domOk) why.push(`DOM sparse (${dom.elements} els, ${dom.text} chars)`);
  return { visualChannel: false, screenshotBytes: bytes, reason: why.join("; ") };
}

const BREAKPOINTS: Array<{ name: string; width: number }> = [
  { name: "mobile", width: 390 },
  { name: "tablet", width: 768 },
  { name: "laptop", width: 1280 },
  { name: "desktop", width: 1440 },
];

/**
 * Capture screenshots at each breakpoint (viewport + one full-page). Returns the list
 * of files actually written. If the visual channel is down, we skip and return [] —
 * the caller records that instead of writing broken/blank files.
 */
export async function captureScreenshots(page: Page, dir: string, visualChannel: boolean): Promise<string[]> {
  if (!visualChannel) return [];
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (const bp of BREAKPOINTS) {
    try {
      await page.setViewportSize({ width: bp.width, height: 900 });
      await page.waitForTimeout(400);
      const file = path.join(dir, `${bp.name}-${bp.width}.png`);
      const buf = await page.screenshot({ type: "png", timeout: 15_000 });
      if (buf.length > 2000) {
        await writeFile(file, buf);
        written.push(path.basename(file));
      }
    } catch (e) {
      console.warn(`    ! screenshot ${bp.name} failed: ${(e as Error).message}`);
    }
  }
  // one full-page capture at desktop for the critic's later structural comparison
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(400);
    const file = path.join(dir, "desktop-fullpage.png");
    const buf = await page.screenshot({ type: "png", fullPage: true, timeout: 30_000 });
    if (buf.length > 2000) {
      await writeFile(file, buf);
      written.push(path.basename(file));
    }
  } catch (e) {
    console.warn(`    ! full-page screenshot failed: ${(e as Error).message}`);
  }
  return written;
}
