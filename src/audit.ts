// AUDIT — the repeatable quality measurement for a clone-and-adapt build.
//
//   npx tsx src/audit.ts <build-dir> [--ref <reference-url>] [--json]
//
// The THIRD PIVOT (responsive CSS-preserving clone, exact fidelity, working tabs, de-brand) was tuned
// end-to-end against ONE site. This module turns the ad-hoc measurements taken there into one command
// so every reference is judged the same way and regressions are visible:
//
//   responsive   docW == innerW at 1920/1440/768/390 (+ body height, to catch a collapse)
//   links        dead/unresolvable hrefs, and links still pointing back at the reference
//   tabs         every tab group wired to a stage that exists and to real per-tab content
//   structure    page height + heading count vs the reference — catches removal rules deleting real sections
//   palette      computed base colours vs the reference — catches a lost theme hook (var(--…) gone invalid)
//   assets       what the reference paints vs what the clone paints, and whether any ref is still remote
//   brand        reference wordmark / aria-labels / customer logo walls, labelled AND unlabelled (HARD)
//   render       the same question asked of the PIXELS — src/render-audit.ts (HARD)
//   forms        the reference's own forms actually submit — src/behavior.ts (HARD)
//   swap         how much of the reference's copy actually got rewritten
//
// `brandLeakOnPage` is exported and used by adapt.ts's verify() so there is ONE implementation of the
// brand-leak walker, not two.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { openStatic, openLive } from "./browser.js";
import { renderCheck, marksSource, renderLines, type RenderReport } from "./render-audit.js";
import { inspectForms } from "./behavior.js";

const WIDTHS = [1920, 1440, 768, 390];

export interface ResponsiveRow { width: number; docW: number; innerW: number; ok: boolean; height: number }
export interface LinkReport { total: number; dead: string[]; refHost: string[]; external: number; anchors: number; hashed: number }
export interface TabReport { runtime: boolean; groups: number; wired: number; orphanTabs: number; problems: string[] }
export interface AssetReport { live: number; cloned: number; localised: number; remote: string[]; missing: string[] }
export interface PaletteReport { live: Palette; clone: Palette; ok: boolean }
export interface StructureReport { liveHeight: number; cloneHeight: number; liveHeadings: number; cloneHeadings: number; ok: boolean }
interface Palette { bg: string; text: string; heading: string }
export interface SwapReport { lines: number; changed: number; survivors: string[] }
export interface FormsReport { detectable: number; tagged: number; working: number; problems: string[]; notes: string[] }

export interface AuditResult {
  dir: string;
  responsive: ResponsiveRow[];
  links: LinkReport;
  tabs: TabReport;
  brandLeak: string[];
  render?: RenderReport;
  forms: FormsReport;
  assets?: AssetReport;
  palette?: PaletteReport;
  structure?: StructureReport;
  swap?: SwapReport;
}

/** The page's base colours. Cheap, and it is the single most diagnostic signal that a clone's CSS did not
 *  fully survive: a reference scopes its palette to a root selector (`[data-theme=dark]`, `.dark`), and if
 *  that hook is lost every `var(--color-*)` becomes invalid — layout still renders, so the failure shows up
 *  only as a mysteriously washed-out page. Comparing computed base colours catches it in one number. */
const paletteProbe = () => {
  const cs = getComputedStyle(document.body);
  const h = document.querySelector("h1,h2");
  return {
    bg: cs.backgroundColor,
    text: cs.color,
    heading: h ? getComputedStyle(h).color : cs.color,
  };
};

/** Page height + section-heading count. Removal passes (social proof, logo walls) operate on whole
 *  `<section>`s, so an over-eager rule deletes real product content and the page still looks internally
 *  consistent — nothing else in the audit notices. Comparing against the live reference does. */
const structureProbe = () => ({
  height: document.body.scrollHeight,
  headings: document.querySelectorAll("h1,h2").length,
});

/**
 * BRAND LEAK — the unshippable failure. The reference's identity does not live only in visible text:
 * it hides in SVG/img logos, aria-labels and a marquee of its real customers, which an innerText-only
 * check reports as clean. Shared with adapt.ts's verify().
 */
export async function brandLeakOnPage(page: Page, brand: string): Promise<string[]> {
  const out: string[] = [];
  const r = await page.evaluate((b: string) => {
    const re = b ? new RegExp("\\b" + b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i") : null;
    let textHits = 0, attrHits = 0;
    if (re) {
      if (re.test(document.body.innerText || "")) textHits++;
      document.querySelectorAll("[aria-label],[alt],[title]").forEach((el) => {
        for (const a of ["aria-label", "alt", "title"]) { const v = el.getAttribute(a); if (v && re.test(v)) attrHits++; }
      });
    }
    // A surviving third-party customer logo wall: a container of >=4 distinct company logos, low text.
    const isLogo = (el: Element) => { const l = (el.getAttribute("aria-label") || el.getAttribute("alt") || "").trim(); return !!l && l.length <= 30 && /^[A-Za-z0-9][A-Za-z0-9 .&_-]*$/.test(l); };
    const names = (c: Element) => new Set([...c.querySelectorAll("svg[aria-label],img[alt]")].filter(isLogo).map((x) => (x.getAttribute("aria-label") || x.getAttribute("alt") || "").toLowerCase()));
    let walls = 0; const done = new Set<Element>();
    [...document.querySelectorAll("svg[aria-label],img[alt]")].filter(isLogo).forEach((el) => {
      if (done.has(el)) return;
      let cont: Element | null = el, inner: Element | null = null;
      for (let i = 0; i < 7 && cont; i++) { if (names(cont).size >= 4) { inner = cont; break; } cont = cont.parentElement; }
      if (!inner) return;
      const n = names(inner).size, txt = (inner.textContent || "").replace(/\s+/g, " ").trim().length;
      [...inner.querySelectorAll("svg[aria-label],img[alt]")].forEach((x) => done.add(x));
      if (n >= 4 && txt <= n * 28 + 200) walls++;
    });
    // The same wall UNLABELLED. A reference may ship its customer marquee as bare inline <svg> with no
    // aria-label (Linear does), which the label-based scan above cannot see — so it shipped real companies
    // as the adapted product's customers and verification still reported clean. Structural signature:
    // >=4 sibling items in one horizontal band, each exactly one wordmark-shaped graphic and no text.
    let bandWalls = 0;
    const rows = new Set<Element>();
    document.querySelectorAll("svg,img").forEach((g) => {
      if (g.parentElement) rows.add(g.parentElement);
      if (g.parentElement?.parentElement) rows.add(g.parentElement.parentElement);
    });
    for (const row of rows) {
      const items = [...row.children].filter((c) => {
        const gs = c.matches("svg,img") ? [c] : [...c.querySelectorAll("svg,img")];
        if (gs.length !== 1 || (c.textContent || "").trim().length > 0) return false;
        const r = gs[0].getBoundingClientRect();
        // Wordmark-shaped (wider than tall) — a row of square social/feature icons is not a logo wall.
        return r.width >= 30 && r.width <= 260 && r.height >= 8 && r.height <= 70 && r.width / Math.max(1, r.height) >= 1.6;
      });
      if (items.length < 4) continue;
      const tops = items.map((c) => c.getBoundingClientRect().top);
      if (Math.max(...tops) - Math.min(...tops) > 60) continue;
      // Same geometry guard as the removal pass: a marquee is a page-wide, short band, not a cluster of
      // small images inside a cloned product widget.
      const rb = row.getBoundingClientRect();
      if (rb.width < document.body.clientWidth * 0.6 || rb.height > 200) continue;
      const lefts = items.map((c) => c.getBoundingClientRect().left);
      if (Math.max(...lefts) - Math.min(...lefts) < rb.width * 0.45) continue;
      bandWalls++;
    }
    return { textHits, attrHits, walls, bandWalls };
  }, brand);
  if (r.textHits > 0) out.push(`reference brand "${brand}" still appears in visible text`);
  if (r.attrHits > 0) out.push(`reference brand "${brand}" survives in ${r.attrHits} logo/aria label(s)`);
  if (r.walls > 0) out.push(`${r.walls} third-party customer logo wall(s) still present (someone else's customers)`);
  if (r.bandWalls > 0) out.push(`${r.bandWalls} unlabelled logo strip(s) still present (a band of ${"≥4"} third-party wordmarks)`);
  return out;
}

/** The responsive contract of the rearchitected clone: the document never exceeds the viewport, at any
 *  width, and the page does not collapse. A fixed-width computed-style snapshot fails this by design. */
async function checkResponsive(page: Page): Promise<ResponsiveRow[]> {
  const rows: ResponsiveRow[] = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(500);
    const m = await page.evaluate(() => ({
      docW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      height: document.body.scrollHeight,
    }));
    rows.push({ width, ...m, ok: m.docW <= m.innerW + 2 });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  return rows;
}

/** No 404s: same-origin/relative links become "#", cross-host links stay (new tab), in-page anchors must
 *  resolve. Anything else — a relative path with no file behind it, an anchor to a missing id, a link
 *  still pointing at the reference's own host — is a dead or leaking link. */
async function checkLinks(page: Page, dir: string, refHost: string): Promise<LinkReport> {
  const raw = await page.evaluate((rh: string) => {
    const dead: string[] = [], refs: string[] = [];
    let external = 0, anchors = 0, hashed = 0, total = 0;
    document.querySelectorAll("a[href]").forEach((a) => {
      const href = (a.getAttribute("href") || "").trim();
      total++;
      if (href === "#") { hashed++; return; }
      if (!href) { dead.push("(empty href)"); return; }
      if (href.startsWith("#")) {
        anchors++;
        if (!document.getElementById(href.slice(1)) && !document.querySelector(`[name="${CSS.escape(href.slice(1))}"]`)) dead.push(href);
        return;
      }
      if (/^(mailto:|tel:|javascript:)/i.test(href)) return;
      if (/^https?:\/\//i.test(href)) {
        try { if (rh && new URL(href).hostname.replace(/^www\./, "").endsWith(rh)) { refs.push(href); return; } } catch { /* malformed */ }
        external++;
        return;
      }
      dead.push(href); // relative path in a single-file static clone — nothing behind it
    });
    return { dead, refs, external, anchors, hashed, total };
  }, refHost);
  // A relative href is only truly dead if no such file was emitted next to index.html.
  const dead = raw.dead.filter((h) => h.startsWith("#") || h === "(empty href)" || !existsSync(path.join(dir, h.split("?")[0].split("#")[0])));
  return { total: raw.total, dead, refHost: raw.refs, external: raw.external, anchors: raw.anchors, hashed: raw.hashed };
}

/** Tabs must actually tab (vibe-coded-patterns §4.3). Every `data-atl-tab="gid:i"` needs a
 *  `[data-atl-stage="gid"]` that exists and a content snapshot at index i in the atl-tabs JSON —
 *  otherwise the button is an orphan (social-proof removal deleted its stage) or unwired. */
async function checkTabs(page: Page): Promise<TabReport> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const runtime = !!document.getElementById("atl-tabs");
    let data: Record<string, string[]> = {};
    try { data = JSON.parse(document.getElementById("atl-tabs")?.textContent || "{}"); } catch { problems.push("atl-tabs JSON does not parse"); }
    const byGroup = new Map<string, number[]>();
    document.querySelectorAll("[data-atl-tab]").forEach((t) => {
      const [g, i] = (t.getAttribute("data-atl-tab") || "").split(":");
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(Number(i));
    });
    let wired = 0, orphanTabs = 0;
    for (const [gid, idxs] of byGroup) {
      const stage = document.querySelector(`[data-atl-stage="${gid}"]`);
      const content = data[gid];
      if (!stage) { orphanTabs += idxs.length; problems.push(`group ${gid}: ${idxs.length} tab(s) with no stage element (orphan)`); continue; }
      if (!content || !content.length) { problems.push(`group ${gid}: stage exists but no captured content — clicking does nothing`); continue; }
      const missing = idxs.filter((i) => !content[i]); // absent OR empty — both mean a click does nothing
      if (missing.length) { problems.push(`group ${gid}: no content for tab index ${missing.join(",")}`); continue; }
      const distinct = new Set(idxs.map((i) => content[i]));
      if (distinct.size < 2 && idxs.length > 1) { problems.push(`group ${gid}: all ${idxs.length} tabs show identical content`); continue; }
      wired++;
    }
    return { runtime, groups: byGroup.size, wired, orphanTabs, problems };
  });
}

/** Collect every non-data asset URL a page actually PAINTS (visible <img> + background/mask images).
 *  Runs identically on the live reference and on the clone so the two are comparable. */
const paintedAssets = () => {
  const out: string[] = [];
  document.querySelectorAll("*").forEach((el) => {
    const b = el.getBoundingClientRect();
    if (b.width < 4 || b.height < 4) return;
    const cs = getComputedStyle(el);
    for (const src of [cs.backgroundImage, (cs as any).webkitMaskImage, (cs as any).maskImage]) {
      if (!src || src === "none") continue;
      for (const m of src.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
        // `url(#fadeMask)` is an in-document SVG reference, not a file.
        if (!m[1].startsWith("data:") && !m[1].startsWith("#")) out.push(m[1]);
      }
    }
  });
  document.querySelectorAll("img,video[src],audio[src],source[src]").forEach((el) => {
    const s = (el as HTMLImageElement).currentSrc || el.getAttribute("src") || "";
    const b = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (el.tagName === "IMG" && b && (b.width < 4 || b.height < 4)) return;
    if (s && !s.startsWith("data:")) out.push(s);
  });
  return [...new Set(out)];
};

/**
 * Live-vs-clone asset comparison (generalised from the supabase-only `_cmp.mjs`).
 *
 * Filename matching alone does not generalise: Linear serves every image through Cloudflare Images, whose
 * URLs end in transform PARAMS (`…/<uuid>/f=auto,dpr=2,…`) with no filename or extension at all — so a
 * stem diff reports either nothing or garbage. The measurement that holds for any reference is
 * SELF-CONTAINMENT: how many of the assets the clone paints resolve locally, and whether any still point
 * back at the reference's own CDN (a remote ref means an offline-broken clone that phones home on view).
 * The filename diff is kept as a secondary signal, restricted to URLs that really have a filename.
 */
async function checkAssets(browser: Browser, refUrl: string, dir: string): Promise<{ assets: AssetReport; palette: PaletteReport; structure: StructureReport }> {
  const page = await openLive(browser, refUrl);
  let live: string[] = [];
  let livePalette: Palette = { bg: "", text: "", heading: "" };
  let liveStruct = { height: 0, headings: 0 };
  let cloneStruct = { height: 0, headings: 0 };
  try {
    // Same scroll pass the clone runs — without it the reference's lazy imagery never mounts and the
    // comparison is against a near-empty "live" set.
    await page.evaluate(async () => {
      const step = Math.round(innerHeight * 0.85);
      for (let y = 0; y < document.body.scrollHeight; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 180)); }
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 600));
    });
    live = await page.evaluate(paintedAssets);
    livePalette = await page.evaluate(paletteProbe);
    liveStruct = await page.evaluate(structureProbe);
  } finally {
    await page.close();
  }

  const clonePage_ = await openStatic(browser, path.join(dir, "index.html"));
  let cloned: string[] = [];
  let clonePalette: Palette = { bg: "", text: "", heading: "" };
  try {
    clonePalette = await clonePage_.evaluate(paletteProbe);
    cloneStruct = await clonePage_.evaluate(structureProbe);
    await clonePage_.evaluate(async () => {
      const step = Math.round(innerHeight * 0.85);
      for (let y = 0; y < document.body.scrollHeight; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 400));
    });
    cloned = await clonePage_.evaluate(paintedAssets);
  } finally {
    await clonePage_.close();
  }

  const remote = cloned.filter((u) => /^https?:/i.test(u));
  const localised = cloned.length - remote.length;

  // Secondary: named files the reference paints that never landed in assets/.
  const named = (u: string) => {
    const n = u.split("?")[0].split("#")[0].split("/").pop() || "";
    return /\.(svg|png|jpe?g|webp|avif|gif|ico)$/i.test(n) ? n : "";
  };
  const localFiles = existsSync(path.join(dir, "assets")) ? readdirSync(path.join(dir, "assets")) : [];
  const missing = [...new Set(live.map(named).filter(Boolean))].filter((n) => {
    const stem = n.replace(/\.[a-z0-9]+$/i, "");
    return !localFiles.some((l) => l.startsWith(stem));
  });

  // Compare base colours channel-wise. A small delta is fine (the swap changes copy, not palette); a large
  // one means the reference's theme hook did not survive the clone.
  const rgb = (s: string) => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
  const near = (a: string, b: string) => {
    const [x, y] = [rgb(a), rgb(b)];
    if (x.length < 3 || y.length < 3) return a === b;
    return Math.max(...x.map((v, i) => Math.abs(v - y[i]))) <= 24;
  };
  const paletteOk = near(livePalette.text, clonePalette.text) && near(livePalette.heading, clonePalette.heading)
    // A transparent body background is legitimate when the paint sits on <html> or a wrapper — only compare
    // when the reference itself paints an opaque body.
    && (rgb(livePalette.bg).length < 3 || livePalette.bg.includes("rgba(0, 0, 0, 0)") || near(livePalette.bg, clonePalette.bg));

  // Social-proof removal legitimately shortens the page, so allow real slack — but losing a quarter of the
  // page's height or of its section headings means whole product sections were deleted.
  const structOk = cloneStruct.height >= liveStruct.height * 0.75 && cloneStruct.headings >= liveStruct.headings - Math.max(2, liveStruct.headings * 0.25);

  return {
    assets: { live: live.length, cloned: cloned.length, localised, remote: [...new Set(remote)], missing },
    palette: { live: livePalette, clone: clonePalette, ok: paletteOk },
    structure: { liveHeight: liveStruct.height, cloneHeight: cloneStruct.height, liveHeadings: liveStruct.headings, cloneHeadings: cloneStruct.headings, ok: structOk },
  };
}

/**
 * FORMS — does the reference's own form actually do anything? A submit that silently does nothing is the
 * §4.3 vibe-coded tell ("non functional interactive elements"), and it is exactly what a static clone ships
 * by default. Measured three ways, on the built page:
 *
 *   detectable  what src/behavior.ts's detector finds in the markup (shared code, so the build gate and the
 *               audit can never disagree about what a form is)
 *   tagged      how many of those carry the `data-atl-form` wiring markers
 *   working     how many, when filled with a valid synthetic payload and submitted, actually reach a
 *               success state
 *
 * The audit opens the build over file://, where no server can exist, so this exercises the runtime's local
 * fallback path (`data-atl-mode="local"`). The real POST path is covered by test/behavior.test.ts, which
 * boots the emitted server.
 */
export async function checkForms(browser: Browser, dir: string): Promise<FormsReport> {
  const page = await openStatic(browser, path.join(dir, "index.html"));
  try {
    const detected = await inspectForms(page);
    const tagged = await page.evaluate(() => document.querySelectorAll("[data-atl-form]").length);
    const problems: string[] = [];
    // A form the detector can see but the build never wired: the pass did not run, or it ran and disagreed
    // with itself. Either way the page ships a dead submit.
    if (detected.detected.length > tagged) {
      problems.push(`${detected.detected.length - tagged} detectable form(s) were never wired (dead submit — run the behaviour pass)`);
    }
    let working = 0;
    for (let i = 0; i < tagged; i++) {
      const r = await page.evaluate(async (idx: number) => {
        const root = document.querySelectorAll("[data-atl-form]")[idx] as HTMLElement | undefined;
        if (!root) return { ok: false, why: "container vanished" };
        const id = root.getAttribute("data-atl-form");
        // Fill every field with something valid for its role, then submit the way a person would.
        root.querySelectorAll("[data-atl-field]").forEach((f) => {
          const el = f as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
          const role = (el.getAttribute("data-atl-field") || "").split(":")[0];
          if (el.tagName === "SELECT") { const s = el as HTMLSelectElement; if (s.options.length > 1) s.selectedIndex = 1; return; }
          const input = el as HTMLInputElement;
          if (input.type === "checkbox" || input.type === "radio") { input.checked = true; return; }
          input.value = role === "email" ? "audit@example.com" : role === "password" ? "Aud1t-passw0rd!" : "Audit check";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        const btn = root.querySelector("[data-atl-submit]") as HTMLElement | null;
        if (btn) btn.click();
        else if (root.tagName === "FORM") root.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        else return { ok: false, why: `form ${id}: nothing to submit with` };
        await new Promise((res) => setTimeout(res, 400));
        const submitted = root.getAttribute("data-atl-submitted") === "1";
        const state = root.querySelector('[data-atl-state="success"]');
        const invalid = root.querySelector('[aria-invalid="true"]');
        if (submitted && state) return { ok: true, why: `mode=${root.getAttribute("data-atl-mode") || "?"}` };
        return { ok: false, why: `form ${id}: submit produced no success state${invalid ? " (a field was judged invalid)" : ""}` };
      }, i);
      if (r.ok) working++;
      else problems.push(r.why);
    }
    return { detectable: detected.detected.length, tagged, working, problems, notes: detected.notes };
  } finally {
    await page.close();
  }
}

/** Swap coverage — how much of the reference's copy actually became the user's. Measured against the
 *  untouched clone kept beside the output. Reported, not enforced (the hard gate is a separate item),
 *  but this is the number that gate will use. */
async function checkSwap(browser: Browser, dir: string): Promise<SwapReport | undefined> {
  const clonePath = path.join(dir, "index.clone.html");
  if (!existsSync(clonePath)) return undefined;
  // Copy only — text inside <pre>/<code> is a code sample, and rewriting it would produce nonsense, so
  // counting it as unswapped makes a code-heavy reference (Resend) look broken when it is not.
  const lines = async (p: string) => {
    const pg = await openStatic(browser, p);
    try {
      return await pg.evaluate(() => {
        const out: string[] = [];
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n: Node | null;
        while ((n = w.nextNode())) {
          const t = (n.textContent || "").trim();
          if (t.length < 12 || !/[a-zA-Z]/.test(t)) continue;
          const el = n.parentElement;
          if (el && el.closest("pre,code,[class*=code],[class*=Code]")) continue;
          out.push(t);
        }
        return out;
      });
    } finally { await pg.close(); }
  };
  const before = await lines(clonePath);
  const after = new Set(await lines(path.join(dir, "index.html")));
  const survivors = [...new Set(before.filter((l) => after.has(l)))];
  return { lines: before.length, changed: before.length - survivors.length, survivors };
}

export async function audit(dir: string, refUrl: string, opts: { vision?: boolean } = {}): Promise<AuditResult> {
  const indexPath = path.join(dir, "index.html");
  if (!existsSync(indexPath)) throw new Error(`no index.html in ${dir}`);
  const refHost = refUrl ? new URL(/^https?:\/\//.test(refUrl) ? refUrl : "https://" + refUrl).hostname.replace(/^www\./, "") : "";
  const brand = refHost ? refHost.split(".")[0].replace(/^./, (c) => c.toUpperCase()) : "";

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openStatic(browser, indexPath);
    const responsive = await checkResponsive(page);
    const links = await checkLinks(page, dir, refHost);
    const tabs = await checkTabs(page);
    const brandLeak = brand ? await brandLeakOnPage(page, brand) : [];
    await page.close();
    // The same question as `brand`, asked of the PIXELS. Everything above this line reads text and geometry,
    // which is why four different defects shipped green out of the 5-reference volume test.
    const render = brand ? await renderCheck({ browser, indexPath, marksFrom: marksSource(dir, refUrl), brand, vision: opts.vision }) : undefined;
    const forms = await checkForms(browser, dir);
    const swap = await checkSwap(browser, dir);
    const live = refUrl ? await checkAssets(browser, /^https?:\/\//.test(refUrl) ? refUrl : "https://" + refUrl, dir) : undefined;
    return { dir, responsive, links, tabs, brandLeak, render, forms, assets: live?.assets, palette: live?.palette, structure: live?.structure, swap };
  } finally {
    await browser.close();
  }
}

function report(r: AuditResult): boolean {
  const ok = (b: boolean) => (b ? "✓" : "✗");
  let clean = true;
  console.log(`\n▸ Audit — ${r.dir}\n`);

  const respOk = r.responsive.every((x) => x.ok) && r.responsive.every((x) => x.height > 1200);
  clean &&= respOk;
  console.log(`  ${ok(respOk)} responsive`);
  for (const x of r.responsive) console.log(`      ${ok(x.ok)} ${String(x.width).padStart(4)}px  docW ${x.docW} / innerW ${x.innerW}   height ${x.height}px`);

  const linksOk = r.links.dead.length === 0 && r.links.refHost.length === 0;
  clean &&= linksOk;
  console.log(`  ${ok(linksOk)} links — ${r.links.total} total: ${r.links.hashed} neutralised, ${r.links.anchors} in-page, ${r.links.external} external`);
  for (const d of r.links.dead.slice(0, 10)) console.log(`      ✗ dead: ${d}`);
  for (const d of r.links.refHost.slice(0, 10)) console.log(`      ✗ points back at the reference: ${d}`);

  const tabsOk = r.tabs.groups === 0 || (r.tabs.wired === r.tabs.groups && r.tabs.orphanTabs === 0);
  clean &&= tabsOk;
  console.log(`  ${ok(tabsOk)} tabs — ${r.tabs.wired}/${r.tabs.groups} groups wired${r.tabs.runtime ? "" : " (no runtime injected)"}`);
  for (const p of r.tabs.problems) console.log(`      ✗ ${p}`);

  clean &&= r.brandLeak.length === 0;
  console.log(`  ${ok(r.brandLeak.length === 0)} brand`);
  for (const b of r.brandLeak) console.log(`      ✗ ${b}`);

  if (r.render) {
    const renderOk = r.render.hard.length === 0;
    clean &&= renderOk;
    const v = r.render.vision;
    console.log(`  ${ok(renderOk)} render — ${r.render.marks} identity mark(s) vs ${r.render.candidates} rendered graphic(s); vision ${v.ran ? `${v.tiles} tiles` : `skipped (${v.skipped})`}`);
    for (const l of renderLines(r.render)) console.log(`      ${l}`);
  }

  {
    // No forms on the page is a PASS: most landing pages have none, and inventing one is not this pipeline's
    // job. What fails is a form that is there and does nothing.
    const f = r.forms;
    const formsOk = f.problems.length === 0 && f.working === f.tagged;
    clean &&= formsOk;
    console.log(`  ${ok(formsOk)} forms — ${f.detectable} detectable, ${f.tagged} wired, ${f.working} submitting${f.detectable === 0 ? " (page has no forms)" : ""}`);
    for (const p of f.problems) console.log(`      ✗ ${p}`);
    for (const n of f.notes) console.log(`      ! ${n}`);
  }

  if (r.structure) {
    clean &&= r.structure.ok;
    console.log(`  ${ok(r.structure.ok)} structure — ${r.structure.cloneHeight}px / ${r.structure.cloneHeadings} headings vs reference ${r.structure.liveHeight}px / ${r.structure.liveHeadings}`);
    if (!r.structure.ok) console.log(`      ✗ whole sections are missing — check the social-proof / logo-wall removal rules for over-reach`);
  }
  if (r.palette) {
    clean &&= r.palette.ok;
    console.log(`  ${ok(r.palette.ok)} palette — text ${r.palette.clone.text} vs ${r.palette.live.text} · bg ${r.palette.clone.bg} vs ${r.palette.live.bg}`);
    if (!r.palette.ok) console.log(`      ✗ the reference's theme hook did not survive — check <html>/<body> attributes and var(--…) definitions`);
  }
  if (r.assets) {
    // A remote reference is a hard failure: the clone is not self-contained and calls the reference on view.
    const aOk = r.assets.remote.length === 0;
    clean &&= aOk;
    console.log(`  ${ok(aOk)} assets — reference paints ${r.assets.live}, clone paints ${r.assets.cloned} (${r.assets.localised} local, ${r.assets.remote.length} remote)`);
    for (const m of r.assets.remote.slice(0, 10)) console.log(`      ✗ still remote: ${m.slice(0, 110)}`);
    for (const m of r.assets.missing.slice(0, 10)) console.log(`      ! never downloaded: ${m}`);
    if (r.assets.missing.length > 10) console.log(`      … ${r.assets.missing.length - 10} more never downloaded`);
  }
  if (r.swap) {
    const pct = r.swap.lines ? Math.round((r.swap.changed / r.swap.lines) * 100) : 0;
    console.log(`  ${pct >= 80 ? "✓" : "!"} swap — ${r.swap.changed}/${r.swap.lines} text lines rewritten (${pct}%)`);
    for (const s of r.swap.survivors.slice(0, 12)) console.log(`      ! kept from reference: ${JSON.stringify(s.slice(0, 90))}`);
    if (r.swap.survivors.length > 12) console.log(`      … ${r.swap.survivors.length - 12} more`);
  }
  console.log(`\n  ${clean ? "✓ PASS — no hard failures" : "✗ FAIL — see ✗ rows above"}\n`);
  return clean;
}

async function main() {
  const a = process.argv.slice(2);
  let dir = "", ref = "", json = false, vision = true;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--ref") ref = a[++i];
    else if (a[i] === "--json") json = true;
    else if (a[i] === "--no-vision") vision = false;
    else if (!a[i].startsWith("--") && !dir) dir = a[i];
  }
  if (!dir) { console.error('Usage: tsx src/audit.ts <build-dir> [--ref <reference-url>] [--no-vision] [--json]'); process.exit(1); }
  // With no --ref, recover it from the build dir name (adapt.ts writes "<brand>-clone").
  if (!ref) {
    const guess = path.basename(path.resolve(dir)).replace(/-clone$/, "");
    const map: Record<string, { references?: string[] }> = existsSync("./category-map.json") ? JSON.parse(readFileSync("./category-map.json", "utf8")) : {};
    for (const c of Object.values(map)) for (const r of c.references ?? []) if (r.split(".")[0] === guess) ref = r;
  }
  const r = await audit(dir, ref, { vision });
  if (json) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
  process.exit(report(r) ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("\n✗ audit failed:", e); process.exit(1); });
}
