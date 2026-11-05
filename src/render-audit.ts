// RENDERED BRAND/CONTENT CHECK — the gate that judges the PIXELS, not the text.
//
//   npx tsx src/render-audit.ts <build-dir> [--marks-from <file|url>] [--ref <url>]
//                               [--name <product>] [--no-vision] [--json] [--threshold <0..1>]
//
// WHY THIS EXISTS. The 5-reference volume test produced four different defects and all four reached the
// reviewer for ONE shared reason: every gate measures text or geometry, so a leak that exists only as
// RENDERED PIXELS ships under `verify: clean`. Two measured instances:
//
//   clerk   — the nav logo is a bare inline <svg viewBox="0 0 62 18" aria-hidden="true"> whose letters are
//             PATH GEOMETRY. swap.ts de-brand keys on aria-label/alt/title, so it logged `0 logo(s)→wordmark`
//             while the anchor's own label WAS swapped ("Insightling Home Page") — every text check clean,
//             the real `clerk` wordmark on screen.
//   railway — the reference's whole hero (nav + headline + wordmark) stored as a 1408×1700 data-URI
//             screenshot. innerText returned perfectly swapped copy; the page rendered as the reference.
//
// TWO INDEPENDENT DETECTORS, both region-aware (decision 3f deliberately KEEPS the reference's own app UI
// inside product-demo screenshots, so brand inside an accepted media frame is a NOTE, never a FAIL):
//
//   1. MARK MATCH (deterministic, no API, always on). Harvest the reference's identity marks (its nav/footer
//      logo) as pixels, then score every logo-shaped graphic the adapted page paints against them. Scoring is
//      |normalised cross-correlation| on a fixed grid, which is invariant to brightness, contrast AND
//      inversion — a logo recoloured by the reference's theme hook is still the same shape. Catches the clerk
//      class exactly, and it is a repeatable NUMBER, not a judgement.
//   2. VISION PASS (one model call). Tiles of the rendered page → "which real companies are visible, and does
//      any tile look like a screenshot of a different company's marketing page?". Catches what a template
//      cannot: brand/content baked into pixels at an arbitrary scale (the railway class). The VERDICT RULES
//      LIVE HERE IN CODE, not in the model's answer.
//
// Used by `npm run audit` (a `render` row that fails the audit) and by adapt.ts verify() (hits are appended
// to brandLeak, so a rendered leak exits 1) — one implementation, exactly like brandLeakOnPage.
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { openStatic, openLive, openScratch } from "./browser.js";

// ---------------------------------------------------------------------------
// Pure scoring core. Kept free of Playwright so it is unit-testable offline (test/render.test.ts).
// ---------------------------------------------------------------------------

/** Comparison grid. Every crop is squashed to this size, so aspect is handled by `aspectClose` (below)
 *  rather than by the pixels — two same-aspect marks then line up sample-for-sample. */
export const GRID_W = 64;
export const GRID_H = 24;

/**
 * MATCH THRESHOLD, calibrated in isolation against the clones in build/review before any build was paid for.
 * Measured scores, marks harvested from each build's own index.clone.html:
 *
 *   LEAKS (clerk)      1.000  nav wordmark · 0.996  its mobile-variant twin · 0.890  a "Powered by <Clerk>"
 *                             badge inside a product mockup (a third leak nothing had ever reported)
 *   NON-LEAKS          0.637  linear (avatar images vs its 20×20 footer logomark) · 0.192 supabase · 0.098 resend
 *
 * 0.78 sits in the middle of the 0.637 → 0.890 gap. A false positive BLOCKS a good build, so that gap is the
 * number to re-measure before nudging this — never move it without re-running the probe on all four clones.
 */
export const MARK_THRESHOLD = 0.78;

/** Aspect tolerance. A wordmark must not be compared against a square icon: without this, squashing both to
 *  the grid makes unrelated shapes look alike. Ratio-of-ratios within 1.25 keeps 62×18 vs 66×20 comparable. */
export function aspectClose(a: number, b: number, tol = 1.25): boolean {
  if (!(a > 0) || !(b > 0)) return false;
  const r = a > b ? a / b : b / a;
  return r <= tol;
}

/** Zero-mean, unit-variance vector. Returns null for a FLAT crop (a solid colour block) — those correlate
 *  with anything and would be pure noise in the match. */
export function normalise(gray: number[] | null | undefined): Float64Array | null {
  if (!gray || gray.length < 16) return null;
  const n = gray.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += gray[i];
  mean /= n;
  const out = new Float64Array(n);
  let ss = 0;
  for (let i = 0; i < n; i++) { const d = gray[i] - mean; out[i] = d; ss += d * d; }
  const sd = Math.sqrt(ss / n);
  if (sd < 3) return null; // near-flat: less than ~1% of the 0..255 range of structure
  for (let i = 0; i < n; i++) out[i] /= sd;
  return out;
}

/** |normalised cross-correlation| in 0..1. The absolute value is what makes the match theme-invariant: a
 *  dark-on-light logo and its light-on-dark twin correlate at -1, which is the same shape. */
export function ncc(a: Float64Array | null, b: Float64Array | null): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.min(1, Math.abs(dot / a.length));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Zone = "chrome" | "body" | "media";

interface Rect { x: number; y: number; w: number; h: number }
interface RawGraphic extends Rect { id: string; label: string; zone: Zone; raster: boolean; why: string }

export interface Mark { id: string; why: string; w: number; h: number; gray: number[] }
export interface Graphic { id: string; label: string; zone: Zone; raster: boolean; w: number; h: number; gray: number[] }
export interface MarkHit { mark: string; graphic: string; zone: Zone; raster: boolean; score: number; hard: boolean }

export interface VisionFinding { name: string; where: string; what: string; confidence: string }
export interface RasterPageFinding { company: string; detail: string }
export interface WordmarkReading { tile: number; reads: string; company: string }
export interface VisionReport { ran: boolean; skipped?: string; tiles: number; wordmarks: WordmarkReading[]; findings: VisionFinding[]; rasterPage: RasterPageFinding[]; raw?: string }
export interface RenderReport {
  marks: number;
  /** What was harvested as identity, for calibration — a wrong mark here is what would fail a good build. */
  markList: Array<{ id: string; why: string; w: number; h: number }>;
  candidates: number;
  hits: MarkHit[];
  topMisses: Array<{ graphic: string; score: number }>;
  vision: VisionReport;
  hard: string[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// Browser-side collection
// ---------------------------------------------------------------------------

/** Geometry a rendered logo can plausibly have. Below this it is a bullet/hairline; above it is artwork. */
const MIN_H = 9, MAX_H = 120, MIN_AREA = 150;

/**
 * Enumerate graphics in document coordinates.
 *
 * `identity: true` (run against the REFERENCE) harvests only the site's own identity marks. This filter is
 * the whole ballgame: harvesting every header graphic would turn a faithful clone's legitimately-inherited
 * nav icons into "brand marks" and fail every build. So an identity mark must be the first graphic-bearing
 * link of a chrome region (the universal logo slot — measured on all five references), or be labelled with
 * the brand / logo / home, and must never be a social icon.
 *
 * `identity: false` (run against the ADAPTED page) enumerates every logo-shaped graphic anywhere, plus — for
 * large rasters — the sub-crops where a baked-in wordmark would sit (top-left slot, top band), which is how a
 * mark hiding inside a screenshot gets seen at all.
 */
async function enumerateGraphics(page: Page, brand: string, identity: boolean): Promise<{ rects: RawGraphic[]; docWidth: number }> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
  return page.evaluate(({ brand, identity, MIN_H, MAX_H, MIN_AREA }) => {
    const CHROME = 'header,nav,footer,[role="banner"],[role="contentinfo"],[id*="header" i],[id*="footer" i],[class*="header" i],[class*="footer" i],[class*="navbar" i]';
    const MEDIA = "[data-atl-stage],[data-atl-frame]";
    const SOCIAL = /(twitter|x)\.com|github\.com|linkedin\.com|youtube\.com|discord|instagram|facebook|threads\.net|bsky|t\.me|reddit/i;
    const LOGOISH = /logo|wordmark|brandmark|logotype|home/i;
    const brandRe = brand ? new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;

    const visible = (el: Element) => {
      const cs = getComputedStyle(el);
      return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity || "1") > 0.05;
    };
    const zoneOf = (el: Element): "chrome" | "body" | "media" => {
      if (el.closest(MEDIA)) return "media";
      // Our own rasterised media frames are emitted as <img src="data:image/png…"> — brand inside one of
      // those is the accepted product-demo case (decision 3f), not the page's identity.
      const img = el.tagName === "IMG" ? (el as HTMLImageElement) : null;
      if (img && (img.getAttribute("src") || "").startsWith("data:image")) return "media";
      if (el.closest(CHROME)) return "chrome";
      return "body";
    };
    const labelOf = (el: Element) =>
      (el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || "").trim();
    const pathOf = (el: Element) => {
      const bits: string[] = [];
      let e: Element | null = el;
      for (let i = 0; i < 3 && e && e.tagName !== "BODY"; i++, e = e.parentElement) {
        const cls = (e.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 1).join(".");
        bits.unshift(e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (cls ? "." + cls : ""));
      }
      return bits.join(">");
    };
    const rectOf = (el: Element): { x: number; y: number; w: number; h: number } => {
      const r = el.getBoundingClientRect();
      return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
    };

    const out: Array<{ id: string; label: string; zone: "chrome" | "body" | "media"; raster: boolean; why: string; x: number; y: number; w: number; h: number }> = [];
    const seen = new Set<Element>();
    const push = (el: Element, why: string, raster = false, sub?: { x: number; y: number; w: number; h: number }, tag = "") => {
      const r = sub || rectOf(el);
      if (r.w < 6 || r.h < 6) return;
      out.push({ id: pathOf(el) + (tag ? ` [${tag}]` : "") + (labelOf(el) ? ` "${labelOf(el).slice(0, 24)}"` : ""), label: labelOf(el), zone: zoneOf(el), raster, why, ...r });
    };

    const graphics = [...document.querySelectorAll("svg,img")].filter((el) => {
      if (!visible(el)) return false;
      const r = el.getBoundingClientRect();
      return r.height >= MIN_H && r.height <= MAX_H && r.width * r.height >= MIN_AREA;
    });

    // Is this graphic plausibly the site's IDENTITY, rather than an icon that merely sits in the same region?
    // Measured need for this guard: without it clerk's footer contributed a 16×16 social icon and a 28×28
    // product thumbnail as "marks", and an unrelated nav glyph then scored 0.89 against them — i.e. the
    // false-positive risk that would fail a faithful build lives entirely in the HARVEST, not the scoring.
    // A wordmark is wide; a square asset qualifies only if it says it is a logo.
    const plausibleMark = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width * r.height < 400 || r.height > 60) return false;
      const hay = labelOf(el) + " " + (el.getAttribute("class") || "") + " " + (el.getAttribute("id") || "");
      return r.width / Math.max(1, r.height) >= 1.6 || LOGOISH.test(hay);
    };

    if (identity) {
      // (1) The logo slot: the first graphic-bearing link of each chrome region. Verified as the identity
      //     slot on clerk ("Clerk Home Page"), linear ("Navigate to home"), resend ("Resend"), supabase
      //     (unlabelled) — the pattern is universal enough to key on, and it excludes the icon rows that
      //     come later in the same header.
      document.querySelectorAll(CHROME).forEach((region) => {
        const link = [...region.querySelectorAll("a")].find((a) => {
          const href = a.getAttribute("href") || "";
          if (SOCIAL.test(href)) return false; // a footer's first link is often a social icon — never identity
          return !!a.querySelector("svg,img") && visible(a);
        });
        if (!link) return;
        const g = [...link.querySelectorAll("svg,img")]
          .filter((el) => visible(el) && el.getBoundingClientRect().height >= MIN_H)
          .sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
        if (!g || seen.has(g) || !plausibleMark(g)) return;
        seen.add(g);
        push(g, "logo slot (first link of " + region.tagName.toLowerCase() + ")");
      });
      // (2) Anything explicitly labelled/classed as the brand or as a logo. Catches references whose
      //     wordmark is not inside a link, and the labelled case de-brand already handles (harvest it anyway
      //     — the mark is what proves the swap actually removed it).
      graphics.forEach((el) => {
        if (seen.has(el)) return;
        const hay = labelOf(el) + " " + (el.getAttribute("class") || "") + " " + (el.getAttribute("id") || "");
        const hit = (brandRe && brandRe.test(hay)) || (LOGOISH.test(hay) && !!el.closest(CHROME));
        if (!hit || !plausibleMark(el)) return;
        if (el.closest("a") && SOCIAL.test(el.closest("a")!.getAttribute("href") || "")) return;
        seen.add(el);
        push(el, brandRe && brandRe.test(hay) ? "labelled with the brand" : "labelled as a logo, in chrome");
      });
      return { rects: out.slice(0, 8), docWidth: document.documentElement.clientWidth };
    }

    // Candidate side: every logo-shaped graphic, anywhere.
    graphics.forEach((el) => push(el, "graphic"));
    // Background-painted logos (CSS sprite / background-image wordmarks) with no text of their own.
    document.querySelectorAll("*").forEach((el) => {
      const cs = getComputedStyle(el);
      if (!cs.backgroundImage || cs.backgroundImage === "none" || cs.backgroundImage.startsWith("linear") || cs.backgroundImage.startsWith("radial")) return;
      if ((el.textContent || "").trim().length) return;
      if (!visible(el)) return;
      const r = el.getBoundingClientRect();
      if (r.height < MIN_H || r.height > MAX_H || r.width * r.height < MIN_AREA) return;
      push(el, "background-image");
    });
    // Large rasters: a mark baked into a screenshot is invisible to element-level cropping, so also sample
    // the two places a page's wordmark actually sits — the top-left slot and the top band.
    [...document.querySelectorAll("img,[style*='background-image']")].forEach((el) => {
      if (!visible(el)) return;
      const r = rectOf(el);
      if (r.w < 300 || r.h < 200) return;
      push(el, "raster top-left slot", true, { x: r.x + 4, y: r.y + 4, w: Math.min(260, r.w * 0.35), h: Math.min(56, r.h * 0.14) }, "logo-slot");
      push(el, "raster top band", true, { x: r.x, y: r.y, w: r.w, h: Math.min(72, r.h * 0.12) }, "top-band");
    });
    return { rects: out.slice(0, 600), docWidth: document.documentElement.clientWidth };
  }, { brand, identity, MIN_H, MAX_H, MIN_AREA });
}

/** One full-page capture per page, JPEG so a 10 000px-tall clone stays a few MB over the wire. Alpha is not
 *  needed: NCC works on the composited render, which is what a visitor sees. */
async function fullPageShot(page: Page): Promise<string> {
  const buf = await page.screenshot({ fullPage: true, type: "jpeg", quality: 85, timeout: 60_000 });
  return buf.toString("base64");
}

/** Crop every rect out of one full-page capture and return a normalised grayscale vector per rect. Done in a
 *  scratch page via canvas — no image dependency, and it matches the repo's browser-side idiom. A data: URI
 *  is used deliberately: a file:// image would taint the canvas and getImageData would throw. */
async function grayVectors(scratch: Page, shot: string, docWidth: number, rects: Rect[]): Promise<Array<number[] | null>> {
  return scratch.evaluate(async ({ shot, docWidth, rects, gw, gh }) => {
    const img = new Image();
    img.src = "data:image/jpeg;base64," + shot;
    await img.decode();
    const scale = img.naturalWidth / Math.max(1, docWidth); // device-pixel-ratio proof
    const c = document.createElement("canvas");
    c.width = gw; c.height = gh;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    const out: Array<number[] | null> = [];
    for (const r of rects) {
      const sx = Math.max(0, Math.round(r.x * scale)), sy = Math.max(0, Math.round(r.y * scale));
      const sw = Math.min(img.naturalWidth - sx, Math.round(r.w * scale)), sh = Math.min(img.naturalHeight - sy, Math.round(r.h * scale));
      if (sw < 4 || sh < 4) { out.push(null); continue; }
      ctx.clearRect(0, 0, gw, gh);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, gw, gh);
      const d = ctx.getImageData(0, 0, gw, gh).data;
      const g: number[] = new Array(gw * gh);
      for (let i = 0, p = 0; i < d.length; i += 4, p++) g[p] = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      out.push(g);
    }
    return out;
  }, { shot, docWidth, rects, gw: GRID_W, gh: GRID_H });
}

/** Where the page's own chrome actually sits, so the vision tiles frame the identity slot instead of guessing.
 *  Measured need: clerk renders an announcement banner above its header, so a fixed "top 120px" tile showed
 *  the banner and cropped the wordmark out — and the vision pass then could not report the logo it was asked
 *  to read. */
async function chromeBands(page: Page): Promise<{ headerBottom: number; footerTop: number }> {
  return page.evaluate(() => {
    let headerBottom = 120;
    document.querySelectorAll('header,nav,[role="banner"]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top + scrollY < 240 && r.height > 20 && r.height < 220) headerBottom = Math.max(headerBottom, r.bottom + scrollY + 16);
    });
    const f = document.querySelector('footer,[role="contentinfo"]');
    const fr = f?.getBoundingClientRect();
    const footerTop = fr && fr.height > 40 ? fr.top + scrollY : Math.max(0, document.body.scrollHeight - 320);
    return { headerBottom: Math.min(360, headerBottom), footerTop };
  });
}

/** Tiles for the vision pass, cut from the SAME capture (no second screenshot). The header and footer bands
 *  are kept at native scale because that is where a wordmark lives and a downscaled 62×18 mark is
 *  unreadable; the body is covered by four downscaled tiles. */
async function visionTiles(scratch: Page, shot: string, docWidth: number, bands: { headerBottom: number; footerTop: number }): Promise<string[]> {
  return scratch.evaluate(async ({ shot, docWidth, bands }) => {
    const img = new Image();
    img.src = "data:image/jpeg;base64," + shot;
    await img.decode();
    const scale = img.naturalWidth / Math.max(1, docWidth);
    const H = img.naturalHeight;
    const cut = (sx: number, sy: number, sw: number, sh: number, outW: number) => {
      sw = Math.min(sw, img.naturalWidth - sx); sh = Math.min(sh, H - sy);
      if (sw < 8 || sh < 8) return "";
      const c = document.createElement("canvas");
      const k = Math.min(1, outW / sw);
      c.width = Math.round(sw * k); c.height = Math.round(sh * k);
      c.getContext("2d")!.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.75).split(",")[1];
    };
    const tiles: string[] = [];
    // [1] the real header band (native scale, left 900 CSS px — the logo slot lives there) and [2] the footer.
    tiles.push(cut(0, 0, Math.round(900 * scale), Math.round(bands.headerBottom * scale), 900));
    tiles.push(cut(0, Math.round(bands.footerTop * scale), Math.round(900 * scale), Math.round(420 * scale), 900));
    // [3]-[6] four body tiles spread over the page.
    const bodyTop = Math.round(bands.headerBottom * scale), bodyH = Math.max(1, H - bodyTop);
    for (let i = 0; i < 4; i++) {
      const sy = bodyTop + Math.round((bodyH / 4) * i);
      tiles.push(cut(0, sy, img.naturalWidth, Math.round(bodyH / 4), 1000));
    }
    return tiles.filter(Boolean);
  }, { shot, docWidth, bands });
}

// ---------------------------------------------------------------------------
// Detector 1 — mark match
// ---------------------------------------------------------------------------

/** Harvest identity marks from a reference page (the live site, or index.clone.html — the untouched clone the
 *  build keeps beside its output, which IS the reference's own DOM and makes the whole check runnable offline). */
export async function collectMarks(refPage: Page, scratch: Page, brand: string): Promise<Mark[]> {
  const { rects, docWidth } = await enumerateGraphics(refPage, brand, true);
  if (!rects.length) return [];
  const shot = await fullPageShot(refPage);
  const grays = await grayVectors(scratch, shot, docWidth, rects);
  const marks: Mark[] = [];
  for (let i = 0; i < rects.length; i++) {
    const g = grays[i];
    if (!normalise(g)) continue; // flat crop — no structure to match on
    const m: Mark = { id: rects[i].id, why: rects[i].why, w: rects[i].w, h: rects[i].h, gray: g! };
    // Dedupe: the same logo is usually reachable via both harvest rules (slot + label).
    if (marks.some((p) => aspectClose(p.w / p.h, m.w / m.h) && ncc(normalise(p.gray), normalise(m.gray)) > 0.97)) continue;
    marks.push(m);
  }
  return marks;
}

/** Every logo-shaped graphic the adapted page paints, with its zone. */
export async function collectGraphics(page: Page, scratch: Page, brand: string): Promise<{ graphics: Graphic[]; shot: string; docWidth: number }> {
  const { rects, docWidth } = await enumerateGraphics(page, brand, false);
  const shot = await fullPageShot(page);
  const grays = await grayVectors(scratch, shot, docWidth, rects);
  const graphics: Graphic[] = [];
  for (let i = 0; i < rects.length; i++) {
    if (!grays[i]) continue;
    graphics.push({ id: rects[i].id, label: rects[i].label, zone: rects[i].zone, raster: rects[i].raster, w: rects[i].w, h: rects[i].h, gray: grays[i]! });
  }
  return { graphics, shot, docWidth };
}

/**
 * Score every candidate against every mark.
 *
 * A hit in `chrome` or `body` is HARD — the reference's identity mark is still being painted as the page's
 * own. A hit inside a `media` frame, or found by a raster sub-crop, is a NOTE: decision 3f deliberately keeps
 * the reference's app UI inside product-demo screenshots, and hard-failing those would fail every faithful
 * build. The railway class (a whole marketing page baked into pixels) is the vision pass's job.
 */
export function matchMarks(marks: Mark[], graphics: Graphic[], threshold = MARK_THRESHOLD): { hits: MarkHit[]; topMisses: Array<{ graphic: string; score: number }> } {
  const nMarks = marks.map((m) => ({ m, v: normalise(m.gray), a: m.w / m.h }));
  const hits: MarkHit[] = [];
  const scored: Array<{ graphic: string; score: number }> = [];
  for (const g of graphics) {
    const gv = normalise(g.gray);
    if (!gv) continue;
    let best = 0, bestMark = "";
    for (const { m, v, a } of nMarks) {
      if (!aspectClose(a, g.w / g.h)) continue;
      const s = ncc(v, gv);
      if (s > best) { best = s; bestMark = m.id; }
    }
    if (!bestMark) continue;
    scored.push({ graphic: g.id, score: best });
    if (best >= threshold) hits.push({ mark: bestMark, graphic: g.id, zone: g.zone, raster: g.raster, score: best, hard: g.zone !== "media" && !g.raster });
  }
  scored.sort((a, b) => b.score - a.score);
  return { hits: hits.sort((a, b) => b.score - a.score), topMisses: scored.filter((s) => s.score < threshold).slice(0, 5) };
}

// ---------------------------------------------------------------------------
// Detector 2 — vision pass
// ---------------------------------------------------------------------------

function extractJson(out: string): any {
  let t = out.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s === -1 || e <= s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
}

/**
 * Ask the model what real companies are VISIBLE in the render. This is the only detector that can see brand
 * or content that exists purely as pixels at an arbitrary scale — the railway class, where the reference's
 * own nav + headline shipped as a screenshot while innerText read perfectly swapped.
 *
 * The model reports observations; the VERDICT is computed in code below, so a chatty or over-cautious answer
 * cannot change what fails.
 */
export async function visionScan(tiles: string[], opts: { brand: string; productNames: string[]; model: string }): Promise<VisionReport> {
  const empty: VisionReport = { ran: false, tiles: tiles.length, wordmarks: [], findings: [], rasterPage: [] };
  if (!tiles.length) return { ...empty, skipped: "no tiles captured" };
  const own = opts.productNames.filter(Boolean);
  // Deliberately NOT told which reference this was cloned from: naming the brand would tell the model what
  // answer to give. It reports what is legible; the code below decides what that means.
  //
  // `wordmarks` is a separate TRANSCRIPTION field, not an entry in `companies`, because of a measured failure:
  // asked to list companies while being told the page belongs to "Insightling", the model twice omitted the
  // `clerk` wordmark that is plainly legible in tile [1] — it resolved the contradiction by treating the
  // wordmark as the page's own identity and filtering it out. Reading lettering back is a task it does not
  // second-guess, and the code decides what the reading means.
  const instruction = `These images are screenshots of ONE web page, in order: [1] the top-left header band, [2] the footer band, [3]-[6] the body from top to bottom.

The page is supposed to belong to ${own.length ? `a product called ${own.map((n) => `"${n}"`).join(" / ")}` : "one single product"} and nothing else. Report what you can actually SEE.

Return ONLY this JSON:
{"wordmarks":[{"tile":<1 or 2>,"reads":"<transcribe the lettering of the logo/wordmark in that band VERBATIM, exactly as printed; empty string if there is no lettering>","company":"<whose brand that wordmark is, or unknown>"}],
 "companies":[{"name":"<company or product name visible>","where":"chrome|body|product-screenshot","what":"<where/how it appears, e.g. wordmark in the top-left nav>","confidence":"high|medium|low"}],
 "rasterMarketingPage":[{"tile":<1-6>,"company":"<whose landing page it is, or unknown>","detail":"<why this region looks like a flattened image of that company's own marketing page>"}]}

Rules:
- "wordmarks" is a TRANSCRIPTION task and must always have an entry for tile [1] and for tile [2]. Copy the letters you see in the logo, even if they contradict the product name you were given above. Do not correct, translate or normalise them.
- List a company only if you can identify it by name from its wordmark, logo or text. Do NOT list ${own.length ? own.map((n) => `"${n}"`).join(" or ") : "this page's own product name"} — that is this page's own product. Do not guess from styling alone.
- "where": "chrome" = the page's own header/nav/footer identity; "product-screenshot" = inside a screenshot/mockup of an application UI; "body" = anywhere else in the page content.
- rasterMarketingPage is for a region that is clearly a flattened IMAGE of some company's own landing page (its nav bar plus a big marketing headline baked into one picture) — not an app screenshot, not a product panel. Set "company" to the name legible in that image, or "unknown".
- No prose outside the JSON.`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const content: any[] = tiles.map((b64) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } }));
      content.push({ type: "text", text: instruction });
      async function* input() {
        yield { type: "user" as const, message: { role: "user" as const, content }, parent_tool_use_id: null, session_id: "" };
      }
      const q = query({
        prompt: input(),
        options: { model: opts.model, allowedTools: [], settingSources: [], systemPrompt: "You are a precise visual inspector. Output only the requested JSON object, nothing else." },
      });
      let out = "";
      for await (const m of q) if (m.type === "result" && m.subtype === "success") out = m.result;
      const parsed = extractJson(out);
      if (!parsed) continue;
      const wordmarks: WordmarkReading[] = (Array.isArray(parsed.wordmarks) ? parsed.wordmarks : [])
        .filter((w: any) => w && (String(w.reads || "").trim() || String(w.company || "").trim()))
        .map((w: any) => ({ tile: Number(w.tile) || 0, reads: String(w.reads || "").trim(), company: String(w.company || "unknown").trim() }));
      const findings: VisionFinding[] = (Array.isArray(parsed.companies) ? parsed.companies : [])
        .filter((c: any) => c && typeof c.name === "string" && c.name.trim())
        .map((c: any) => ({ name: String(c.name).trim(), where: String(c.where || "body"), what: String(c.what || ""), confidence: String(c.confidence || "medium") }));
      const rasterPage: RasterPageFinding[] = (Array.isArray(parsed.rasterMarketingPage) ? parsed.rasterMarketingPage : [])
        .filter((r: any) => r && (r.detail || r.tile !== undefined))
        .map((r: any) => ({
          company: String(r.company || "unknown"),
          detail: `tile ${r.tile ?? "?"}: ${String(r.detail || "a landing page flattened into an image")}`,
        }));
      // ATELIER_VISION_RAW=1 keeps the model's own words for calibration — the prompt is the part of this
      // detector that needs tuning, and it cannot be tuned blind.
      return { ran: true, tiles: tiles.length, wordmarks, findings, rasterPage, raw: process.env.ATELIER_VISION_RAW === "1" ? out : undefined };
    } catch (e) {
      if (attempt === 2) return { ...empty, skipped: `vision call failed: ${(e as Error).message}` };
    }
  }
  return { ...empty, skipped: "vision response did not parse" };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-opus-4-8";

export interface RenderCheckOptions {
  browser: Browser;
  /** The adapted page to judge — <build-dir>/index.html. */
  indexPath: string;
  /** Where the reference's identity marks come from: a local index.clone.html (preferred — offline and
   *  deterministic) or the live reference URL. */
  marksFrom: string;
  brand: string;
  productName?: string;
  model?: string;
  vision?: boolean;
  threshold?: number;
}

/**
 * Read the adapted page's own product name(s) off the page, so a caller that does not know it (the audit) can
 * still tell the vision pass what to IGNORE. Getting this wrong is not cosmetic: on the first clerk run the
 * name was missed and the vision pass reported the page's own product, "Insightling", as a third-party
 * company. Three independent sources, because the de-brand wordmark is absent on exactly the builds that
 * leak (clerk shipped 0 wordmark spans).
 */
async function productNamesFrom(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll("[data-debrand-wordmark]").forEach((w) => { const t = (w.textContent || "").trim(); if (t) out.push(t); });
    const title = (document.title || "").split(/[|–—·]/)[0].trim();
    if (title) out.push(title.split(/\s+/).slice(0, 2).join(" "));
    // "© 2026 Insightling, Inc." — the footer copyright names the product on essentially every landing page.
    const foot = (document.querySelector("footer")?.textContent || "").replace(/\s+/g, " ");
    const m = foot.match(/(?:©|\(c\)|copyright)\s*\d{0,4}\s*([A-Z][A-Za-z0-9]{2,}(?:\s[A-Z][A-Za-z0-9]+)?)/i);
    if (m) out.push(m[1].trim());
    return [...new Set(out.map((s) => s.replace(/[.,]$/, "").trim()).filter((s) => s.length >= 3))];
  });
}

export async function renderCheck(opts: RenderCheckOptions): Promise<RenderReport> {
  const { browser, indexPath, marksFrom, brand } = opts;
  const threshold = opts.threshold ?? MARK_THRESHOLD;
  const scratch = await openScratch(browser); // the canvas compute surface
  // indexPath may be a served URL (a Next static export needs http for its absolute /_next/ paths).
  const clone = /^https?:\/\//.test(indexPath) ? await openLive(browser, indexPath) : await openStatic(browser, indexPath);
  const productNames = opts.productName ? [opts.productName] : await productNamesFrom(clone);

  let marks: Mark[] = [];
  const refIsUrl = /^https?:\/\//.test(marksFrom) || !existsSync(marksFrom);
  const refPage = refIsUrl ? await openLive(browser, marksFrom) : await openStatic(browser, marksFrom);
  try {
    marks = await collectMarks(refPage, scratch, brand);
  } finally {
    await refPage.close();
  }

  const { graphics, shot, docWidth } = await collectGraphics(clone, scratch, brand);
  const { hits, topMisses } = matchMarks(marks, graphics, threshold);

  // The vision pass is attempted rather than gated on an env var: the pipeline is normally run against an
  // ambient Claude Code login, not ANTHROPIC_API_KEY (adapt.ts only WARNS about the key for the same reason).
  // A call that cannot authenticate degrades to the deterministic detector alone and says so — the
  // deterministic half is never optional.
  let vision: VisionReport = { ran: false, tiles: 0, wordmarks: [], findings: [], rasterPage: [], skipped: "disabled (--no-vision)" };
  if (opts.vision !== false) {
    const tiles = await visionTiles(scratch, shot, docWidth, await chromeBands(clone));
    vision = await visionScan(tiles, { brand, productNames, model: opts.model || DEFAULT_MODEL });
  }
  await clone.close();
  await scratch.close();

  // ---- verdict, computed here so neither detector's own wording decides what fails ----
  const hard: string[] = [];
  const notes: string[] = [];
  for (const h of hits) {
    const line = `the reference's identity mark still RENDERS (${h.zone}${h.raster ? ", inside a raster" : ""}, match ${h.score.toFixed(3)}): ${h.graphic}`;
    if (h.hard) hard.push(line);
    else notes.push(line + " — inside a product-demo frame, accepted per decision 3f; review");
  }
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const brandRe = brand ? new RegExp(esc(brand), "i") : null;
  const isOwn = (name: string) => !!name && productNames.some((p) => new RegExp(esc(p), "i").test(name) || new RegExp(esc(name), "i").test(p));
  // The page's own wordmark, transcribed from the render. If it spells the reference, the build is showing a
  // real company's logo as its own identity — the clerk failure, and the single most unshippable outcome.
  for (const w of vision.wordmarks) {
    const reading = [w.reads, w.company].filter((s) => s && s.toLowerCase() !== "unknown").join(" / ");
    if (!reading) continue;
    if (brandRe && (brandRe.test(w.reads) || brandRe.test(w.company))) {
      hard.push(`the page's own wordmark READS AS THE REFERENCE — tile ${w.tile} logo transcribes to "${reading}"`);
    } else if (!isOwn(w.reads) && !isOwn(w.company) && w.reads) {
      notes.push(`tile ${w.tile} wordmark transcribes to "${reading}", which is neither the product name nor the reference — check the de-brand`);
    }
  }
  for (const f of vision.findings) {
    if (isOwn(f.name)) continue; // the page's own product
    const isRef = brandRe && brandRe.test(f.name);
    const where = f.where.toLowerCase();
    const desc = `${f.name} visible in the render (${where}${f.confidence ? ", " + f.confidence + " confidence" : ""}): ${f.what}`;
    if (isRef && where !== "product-screenshot" && f.confidence !== "low") hard.push(`the reference's brand is VISIBLE — ${desc}`);
    else if (isRef) notes.push(`reference brand inside a product screenshot (accepted per 3f): ${desc}`);
    else notes.push(`third-party company in the render: ${desc}`);
  }
  // The model sometimes NAMES the reference inside its own description of another sighting ("the Clerk
  // sign-up widget mockup") without listing it as a company — measured, twice. That is real evidence, so it is
  // surfaced as a note; the hard call on marks stays with the deterministic detector, which cannot be talked
  // out of a 1.000 match.
  if (brandRe) {
    const mentioned = vision.findings.filter((f) => !brandRe.test(f.name) && brandRe.test(f.what)).map((f) => f.what);
    for (const m of [...new Set(mentioned)]) notes.push(`the vision pass names the reference while describing the render: "${m}"`);
  }
  // The railway class: the REFERENCE's own marketing page flattened into pixels. A mockup of a *fictional*
  // customer's site ("Acme, Inc." in clerk's billing section) is the reference's own design and must not fail
  // the build — measured on the first clerk run, where a blanket rule flagged exactly that. So the rule keys
  // on WHOSE page the image is: the reference's (or a name the page also claims as its own) → FAIL.
  for (const r of vision.rasterPage) {
    const line = `a region is a flattened image of a landing page — ${r.detail} (reads as: ${r.company})`;
    if (brandRe && brandRe.test(r.company)) hard.push(`the reference's own page is baked in as PIXELS — ${r.detail}`);
    else notes.push(line + " — a mockup of a fictional/other company, not the reference; review");
  }

  return {
    marks: marks.length,
    markList: marks.map((m) => ({ id: m.id, why: m.why, w: Math.round(m.w), h: Math.round(m.h) })),
    candidates: graphics.length, hits, topMisses, vision, hard, notes,
  };
}

/** Where a build's marks should come from: the untouched clone beside the output when it exists (offline,
 *  free, and it is the reference's own DOM), else the live reference. Shared by audit.ts and adapt.ts so the
 *  two can never disagree about what the ground truth is. */
export function marksSource(dir: string, refUrl: string): string {
  const raw = path.join(dir, "index.clone.html");
  return existsSync(raw) ? raw : refUrl;
}

export function renderLines(r: RenderReport): string[] {
  const out: string[] = [];
  for (const h of r.hard) out.push(`✗ ${h}`);
  for (const n of r.notes) out.push(`! ${n}`);
  return out;
}

// ---------------------------------------------------------------------------
// CLI — probe the detector IN ISOLATION against the clones already on disk, before paying for a build.
// (The standing calibration lesson: test any new detector against the raw clones first.)
// ---------------------------------------------------------------------------

async function main() {
  const a = process.argv.slice(2);
  let dir = "", ref = "", marksFrom = "", name = "", index = "", json = false, vision = true, threshold = MARK_THRESHOLD;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--ref") ref = a[++i];
    else if (a[i] === "--index") index = a[++i];
    else if (a[i] === "--marks-from") marksFrom = a[++i];
    else if (a[i] === "--name") name = a[++i];
    else if (a[i] === "--json") json = true;
    else if (a[i] === "--no-vision") vision = false;
    else if (a[i] === "--threshold") threshold = Number(a[++i]);
    else if (!a[i].startsWith("--") && !dir) dir = a[i];
  }
  if (!dir) {
    console.error('Usage: tsx src/render-audit.ts <build-dir> [--index <file>] [--marks-from <index.clone.html|url>] [--ref <url>] [--name <product>] [--no-vision] [--json] [--threshold 0.78]');
    process.exit(1);
  }
  // --index judges a file other than index.html in the same directory (so relative assets still resolve) —
  // that is how a defect fixture gets probed without touching a real build.
  const indexPath = index ? path.resolve(index) : path.join(dir, "index.html");
  if (!existsSync(indexPath)) { console.error(`no index.html in ${dir}`); process.exit(1); }
  if (!ref) ref = path.basename(path.resolve(dir)).replace(/-clone$/, "") + ".com";
  const brand = (ref.replace(/^https?:\/\//, "").replace(/^www\./, "").split(".")[0] || "").replace(/^./, (c) => c.toUpperCase());
  if (!marksFrom) marksFrom = marksSource(dir, ref);

  const browser = await chromium.launch({ headless: true });
  let r: RenderReport;
  try {
    r = await renderCheck({ browser, indexPath, marksFrom, brand, productName: name, vision, threshold });
  } finally {
    await browser.close();
  }
  if (json) { console.log(JSON.stringify(r, null, 2)); process.exit(r.hard.length ? 1 : 0); }

  console.log(`\n▸ Rendered brand/content check — ${dir}`);
  console.log(`  brand "${brand}" · marks from ${marksFrom}`);
  console.log(`  ${r.marks} identity mark(s) harvested · ${r.candidates} rendered graphic(s) scored · threshold ${threshold}`);
  for (const m of r.markList) console.log(`      mark ${m.w}×${m.h} — ${m.why} — ${m.id}`);
  for (const h of r.hits) console.log(`      ✗ MATCH ${h.score.toFixed(3)} [${h.zone}${h.raster ? "/raster" : ""}] ${h.graphic}  ←  ${h.mark}`);
  for (const m of r.topMisses) console.log(`      · next best ${m.score.toFixed(3)} ${m.graphic}`);
  console.log(`  vision: ${r.vision.ran ? `${r.vision.tiles} tiles, ${r.vision.findings.length} company sighting(s)` : `skipped — ${r.vision.skipped}`}`);
  for (const w of r.vision.wordmarks) console.log(`      · tile ${w.tile} wordmark reads "${w.reads}" (${w.company})`);
  for (const f of r.vision.findings) console.log(`      · ${f.name} [${f.where}, ${f.confidence}] ${f.what}`);
  for (const l of renderLines(r)) console.log(`  ${l}`);
  console.log(`\n  ${r.hard.length ? "✗ FAIL — the render still shows the reference" : "✓ PASS — nothing of the reference is rendered"}\n`);
  process.exit(r.hard.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("\n✗ render check failed:", e); process.exit(1); });
}
