// DISCOVERY + SCREENING (Decision 3) — auto-populate the category map with VETTED references.
//
//   npx tsx src/discover.ts <category> [--n <count>] [--map ./category-map.json] [--fresh]
//
// The moat is taste-as-data: which real sites a given product should clone. But the best sites are also
// where the tells hide — plenty of YC/Fortune-500 sites are themselves vibe-coded or dated, and some are
// canvas/WebGL with no readable structure to clone. So: DISCOVER candidate companies for a category
// (model knowledge of category leaders), SCREEN each against two bars — (a) extractable (readable DOM,
// not canvas-dominated) and (b) NOT vibe-coded (measured tells + a model quality judgement) — and write
// only the winners into category-map.json. Runs on demand and CACHES; builds pull one vetted ref at
// random, so a build never pays for discovery or gambles on an unvetted site.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { launch } from "./browser.js";

const MODEL = "claude-opus-4-8";
const CACHE = "./output/screening-cache.json";
const CACHE_DAYS = 30;

interface Candidate { name: string; url: string }
interface Signals {
  ok: boolean; // page loaded with a real DOM
  canvasRatio: number; // canvas area / hero area (un-clonable if high)
  textLen: number; sections: number;
  emojiInHeadings: number;
  colorCoveragePct: number; colorInNav: boolean; // purple-wash tells (chroma-based)
  radiiCount: number; // distinct radii on cards/buttons (chaos tell)
  selfHostedFont: boolean; displayFont: string;
  hasTitle: boolean; hasDesc: boolean;
  palette: string[];
}
interface Verdict {
  url: string; extractable: boolean; premium: boolean; keep: boolean;
  score: number; reasons: string[]; screenedAt: string;
}

/** Ask the model for the category's real leaders (YC-backed, Fortune-500, category leaders). */
async function discoverCandidates(category: string, n: number): Promise<Candidate[]> {
  const q = query({
    prompt: `List the ${n} best real companies whose MARKETING WEBSITE is a top example of premium design in the "${category}" category (think YC-backed leaders, category-defining companies, Fortune-500 where relevant). For each give the exact primary marketing-site domain. Prefer well-designed, current sites. Return ONLY a JSON array [{"name":"...","url":"domain.com"}, ...]. No prose.`,
    options: { model: MODEL, allowedTools: [], settingSources: [], systemPrompt: "You output only the requested JSON array." },
  });
  let out = ""; for await (const m of q) if (m.type === "result" && m.subtype === "success") out = m.result;
  const s = out.indexOf("["), e = out.lastIndexOf("]");
  if (s === -1 || e === -1) return [];
  try {
    return (JSON.parse(out.slice(s, e + 1)) as Candidate[])
      .filter((c) => c.url)
      .map((c) => ({ name: c.name ?? c.url, url: c.url.replace(/^https?:\/\//, "").replace(/\/$/, "") }));
  } catch { return []; }
}

/** Measure the extractability + vibe-coded signals of a loaded page. */
async function measure(pageUrl: string): Promise<Signals> {
  const { browser, page, network } = await launch(pageUrl);
  try {
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += innerHeight) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } window.scrollTo(0, 0); });
    // A site loading ANY web font (seen on the wire — reliable even for cross-origin CDN sheets the
    // CSSOM can't read) is using a custom/self-hosted face, a premium signal.
    const usesWebFont = network.fonts.size > 0;
    const s = await page.evaluate(() => {
      const chroma = (c: string) => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(c); if (!m || (m[4] !== undefined && +m[4] < 0.15)) return 0; return Math.max(+m[1], +m[2], +m[3]) - Math.min(+m[1], +m[2], +m[3]); };
      const vp = innerWidth * innerHeight;
      // canvas coverage in the hero region
      let canvasArea = 0;
      document.querySelectorAll("canvas").forEach((c) => { const r = c.getBoundingClientRect(); if (r.top < innerHeight * 1.5) canvasArea += Math.max(0, r.width) * Math.max(0, r.height); });
      // colour discipline (chroma-based, matching the extractor/critic)
      let colored = 0, painted = 0; let colorInNav = false;
      document.querySelectorAll("section,div,main,header,footer,nav").forEach((el) => { const r = el.getBoundingClientRect(); const a = r.width * r.height; if (a < 2000) return; const s = getComputedStyle(el); const grad = s.backgroundImage.indexOf("gradient(") !== -1; const bg = s.backgroundColor !== "rgba(0, 0, 0, 0)"; if (!grad && !bg) return; painted += a; let ch = bg ? chroma(s.backgroundColor) : 0; if (grad) for (const st of s.backgroundImage.match(/rgba?\([^)]+\)/g) ?? []) ch = Math.max(ch, chroma(st)); if (ch >= 45) { colored += a; if (el.closest("header,nav")) colorInNav = true; } });
      // radii chaos
      const radii = new Set<string>();
      document.querySelectorAll("button,[class*='btn'],[class*='card'],[class*='button']").forEach((el) => { const br = getComputedStyle(el).borderRadius; if (br && br !== "0px") radii.add(br.split(" ")[0]); });
      // emoji in headings
      const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
      let emojiHeadings = 0; document.querySelectorAll("h1,h2,h3").forEach((h) => { if (emoji.test(h.textContent || "")) emojiHeadings++; });
      // fonts: is the display face self-hosted (a premium signal) vs a bare system/Google default?
      const h1 = document.querySelector("h1");
      const displayFont = h1 ? getComputedStyle(h1).fontFamily.split(",")[0].replace(/['"]/g, "").trim() : "";
      let selfHosted = false; for (const sheet of Array.from(document.styleSheets)) { try { for (const r of Array.from(sheet.cssRules)) if ((r as any).type === CSSRule.FONT_FACE_RULE && (r as any).style.getPropertyValue("font-family").replace(/['"]/g, "").trim().toLowerCase().includes(displayFont.toLowerCase())) selfHosted = true; } catch {} }
      // palette: the dominant surface colours
      const freq = new Map<string, number>(); document.querySelectorAll("*").forEach((el) => { const c = getComputedStyle(el).backgroundColor; if (c && c !== "rgba(0, 0, 0, 0)") freq.set(c, (freq.get(c) ?? 0) + 1); });
      const palette = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c]) => c);
      return {
        ok: document.querySelectorAll("*").length > 60,
        canvasRatio: vp > 0 ? canvasArea / vp : 0,
        textLen: (document.body.innerText || "").length,
        sections: document.querySelectorAll("section,[class*='section' i]").length,
        emojiInHeadings: emojiHeadings,
        colorCoveragePct: painted > 0 ? (colored / painted) * 100 : 0,
        colorInNav,
        radiiCount: radii.size,
        selfHostedFont: selfHosted,
        displayFont,
        hasTitle: !!document.title && !/^(home|untitled)?$/i.test(document.title.trim()),
        hasDesc: !!document.querySelector('meta[name="description"]')?.getAttribute("content"),
        palette,
      };
    });
    return { ...s, selfHostedFont: usesWebFont || s.selfHostedFont };
  } finally {
    await browser.close();
  }
}

/** Turn the measured signals into a verdict: extractable AND not-vibe-coded → keep. A model quality
 *  judgement backs up the mechanical tells for the borderline "looks premium / current" call. */
async function judge(url: string, s: Signals, useModel = true): Promise<Verdict> {
  const reasons: string[] = [];
  // Extractability (hard): canvas-dominated or too little DOM → cannot be cloned as markup.
  const extractable = s.ok && s.canvasRatio < 0.4 && s.textLen > 400;
  if (!s.ok) reasons.push("page did not load a real DOM");
  if (s.canvasRatio >= 0.4) reasons.push(`hero is ${(s.canvasRatio * 100).toFixed(0)}% canvas/WebGL — not clonable as markup`);
  if (s.textLen <= 400) reasons.push("almost no readable text");

  // Mechanical vibe-coded tells.
  const tells: string[] = [];
  if (s.emojiInHeadings > 0) tells.push(`${s.emojiInHeadings} emoji in headings`);
  if (s.colorCoveragePct > 25) tells.push(`${s.colorCoveragePct.toFixed(0)}% of the page is saturated colour (a wash)`);
  if (s.colorInNav && s.colorCoveragePct > 12) tells.push("saturated colour smeared into the nav");
  // Premium sites legitimately use ~4-6 radii (sm/md/lg card, pill, circle avatar, input). Only a
  // genuinely chaotic count (7+) is a tell — 5 flagged Linear, the gold standard, as inconsistent.
  if (s.radiiCount > 6) tells.push(`${s.radiiCount} different border-radii (inconsistent)`);
  if (!s.hasTitle || !s.hasDesc) tells.push("missing title/description meta");

  // Model quality judgement from the measured signals (image-free, robust).
  // --no-model: the calling agent supplies the taste judgement itself; mechanical tells alone decide here.
  let modelScore = useModel ? 5 : 8; let modelNote = "";
  if (useModel) try {
    const q = query({
      prompt: `Judge whether a website is PREMIUM and CURRENT (a top design example) or DATED/TEMPLATED/vibe-coded, from these measured signals of its marketing page:
- dominant palette: ${JSON.stringify(s.palette)}
- headline font: "${s.displayFont}" (self-hosted custom font: ${s.selfHostedFont})
- saturated-colour coverage: ${s.colorCoveragePct.toFixed(0)}% (premium sites are mostly monochrome with a little accent)
- distinct border-radii: ${s.radiiCount} (premium uses a small consistent set ~2-6; only 8+ is chaotic)
- emoji in headings: ${s.emojiInHeadings}; sections: ${s.sections}; has meta: ${s.hasTitle && s.hasDesc}
Return ONLY JSON {"score": <1-10 premium>, "note": "<8 words>"}. 8+ = clearly premium/current; <=5 = dated or vibe-coded.`,
      options: { model: MODEL, allowedTools: [], settingSources: [], systemPrompt: "You output only the requested JSON object." },
    });
    let out = ""; for await (const m of q) if (m.type === "result" && m.subtype === "success") out = m.result;
    const j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    modelScore = Math.max(1, Math.min(10, +j.score || 5)); modelNote = String(j.note || "");
  } catch { /* keep default */ }

  // Score: model judgement, docked for each mechanical tell.
  const score = Math.max(0, modelScore - tells.length * 1.5);
  const premium = tells.length <= 1 && score >= 6.5;
  if (tells.length) reasons.push(...tells);
  if (modelNote) reasons.push(`model: "${modelNote}" (${modelScore}/10)`);

  return { url, extractable, premium, keep: extractable && premium, score: Math.round(score * 10) / 10, reasons, screenedAt: new Date().toISOString() };
}

function loadJson<T>(p: string, dflt: T): T { try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : dflt; } catch { return dflt; } }
const daysAgo = (iso: string) => (Date.now() - new Date(iso).getTime()) / 86400000;

async function main() {
  const args = process.argv.slice(2);
  let category = "", n = 8, mapPath = "./category-map.json", fresh = false, useModel = true, urls: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--n") n = parseInt(args[++i], 10) || 8;
    else if (args[i] === "--map") mapPath = args[++i];
    else if (args[i] === "--fresh") fresh = true;
    else if (args[i] === "--no-model") useModel = false;
    else if (args[i] === "--urls") urls = args[++i].split(",").map((u) => u.trim().replace(/^https?:\/\//, "").replace(/\/$/, "")).filter(Boolean);
    else if (!args[i].startsWith("--") && !category) category = args[i];
  }
  if (!category) { console.error("Usage: tsx src/discover.ts <category> [--n <count>] [--map <file>] [--fresh] [--urls a.com,b.com] [--no-model]"); process.exit(1); }

  const cache = loadJson<Record<string, Verdict>>(CACHE, {});
  const map = loadJson<Record<string, any>>(mapPath, {});

  console.log(`\n▸ Discovering + screening "${category}" (target ${n})\n`);
  // --urls: the caller (the scout agent) already chose candidates from its own knowledge — no model call here.
  const candidates = urls.length ? urls.map((u) => ({ name: u, url: u })) : await discoverCandidates(category, n);
  console.log(`  candidates: ${candidates.map((c) => c.url).join(", ")}\n`);

  const kept: string[] = [];
  for (const c of candidates) {
    // Cache: skip a recently-screened URL (a build never re-pays; discovery is idempotent).
    const cached = cache[c.url];
    if (cached && !fresh && daysAgo(cached.screenedAt) < CACHE_DAYS) {
      console.log(`  · ${c.url}: cached ${cached.keep ? "KEEP" : "reject"} (${cached.score})`);
      if (cached.keep) kept.push(c.url);
      continue;
    }
    let verdict: Verdict;
    try {
      const s = await measure("https://" + c.url);
      verdict = await judge(c.url, s, useModel);
    } catch (e) {
      verdict = { url: c.url, extractable: false, premium: false, keep: false, score: 0, reasons: [`load/screen failed: ${(e as Error).message.slice(0, 60)}`], screenedAt: new Date().toISOString() };
    }
    cache[c.url] = verdict;
    console.log(`  · ${c.url}: ${verdict.keep ? "✓ KEEP" : "✗ reject"} (${verdict.score}) — ${verdict.reasons.slice(0, 2).join("; ")}`);
    if (verdict.keep) kept.push(c.url);
  }

  // Write winners into the category map. Merge with existing refs, but REMOVE any ref this run
  // screened and rejected (e.g. a canvas-heavy or washed site that was hand-curated earlier) —
  // otherwise a build could randomly pick a ref the screener just failed. Un-screened existing refs
  // are kept as-is. Normalise (strip scheme/trailing slash) so pre-existing and discovered dedupe.
  const norm = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const rejected = new Set(candidates.map((c) => c.url).filter((u) => cache[u] && !cache[u].keep).map(norm));
  const entry = map[category] ?? { references: [] };
  const existingKept = (entry.references ?? []).map(norm).filter((r: string) => !rejected.has(r));
  entry.references = [...new Set([...existingKept, ...kept.map(norm)])];
  entry.screenedAt = new Date().toISOString();
  map[category] = entry;
  writeFileSync(mapPath, JSON.stringify(map, null, 2) + "\n");
  writeFileSync(CACHE, JSON.stringify(cache, null, 2) + "\n");

  console.log(`\n✓ ${kept.length}/${candidates.length} kept → ${category}.references now [${entry.references.join(", ")}]`);
  console.log(`  map: ${mapPath} · cache: ${CACHE}\n`);
  process.exit(0);
}

main().catch((e) => { console.error("\n✗ discover failed:", e); process.exit(1); });
