// The DETERMINISTIC GATE (build-guide §8). This exists because a banned pattern written into the
// builder's system prompt is only a REQUEST to a model: it is obeyed most of the time and drifts some
// of the time, and re-asking never fixes that. The eyebrow/kicker pill kept coming back for exactly
// this reason — the rule was wired, but nothing verified it.
//
// So the rules that can be checked mechanically are checked mechanically, against the RENDERED page
// (not the source), and a violation blocks the build until it is repaired. Rules live here as code,
// not as prose, so a settled rule stays settled.
import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

export interface Violation {
  rule: string;
  detail: string;
  where: string; // a locator hint the repair pass can act on
}

/** Everything the critic needs from the reference to enforce DISCIPLINE (not a fixed threshold).
 *  Colour is judged as ratio + placement vs the reference; the headline font is judged against the
 *  design's own roles; spacing against the token scale. */
export interface RefProfile {
  colorCoveragePct: number; // % of the reference's painted area that is saturated
  colorCentroidY: number; // 0 = top-weighted, 1 = bottom-weighted
  colorInNav: boolean; // does the reference itself colour its nav?
  displayFont: string; // the headline family
  monoFont: string | null; // the mono/accent family — must NEVER be the headline
  spacingScale: number[]; // the allowed spacing steps (px)
}

/** Boot the workspace's dev server on an ephemeral port and resolve its URL. */
async function startDev(workspace: string): Promise<{ url: string; proc: ChildProcess }> {
  const proc = spawn("npm", ["run", "dev"], { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("dev server did not become ready in 90s")), 90_000);
    const onData = (b: Buffer) => {
      const m = /(http:\/\/localhost:\d+)/.exec(b.toString());
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("exit", (c) => reject(new Error(`dev server exited early (${c})`)));
  });
  return { url, proc };
}

/**
 * Render the built page and run the mechanical subset of `vibe-coded-patterns.md` against the live
 * DOM. Returns every violation found (empty = clean).
 */
export async function runGate(workspace: string, ref: RefProfile): Promise<Violation[]> {
  const { url, proc } = await startDev(workspace);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => {
      (globalThis as any).__name = (globalThis as any).__name || ((f: any) => f);
    });
    await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
    await page.waitForTimeout(1500);
    // Scroll the whole page so lazy content and below-the-fold colour are laid out before we measure.
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += Math.round(innerHeight * 0.8)) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 60));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(400);

    const violations: Violation[] = await page.evaluate((R: RefProfile) => {
      const out: { rule: string; detail: string; where: string }[] = [];
      const textOf = (el: Element) => (el.textContent ?? "").trim();
      // ABSOLUTE chroma (max−min / 255), matching the extractor — a dark brand tint (Sentry #1f1633,
      // Railway #13111c) is a neutral, not a colour wash; only real fills read as colour.
      const satOf = (col: string): number => {
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(col);
        if (!m) return 0;
        const r = +m[1], g = +m[2], b = +m[3], al = m[4] === undefined ? 1 : +m[4];
        if (al < 0.15) return 0;
        const chroma = Math.max(r, g, b) - Math.min(r, g, b);
        return chroma < 45 ? 0 : chroma / 255;
      };
      const relLum = (col: string): number | null => {
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(col);
        if (!m) return null;
        const lin = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * lin(+m[1]) + 0.7152 * lin(+m[2]) + 0.0722 * lin(+m[3]);
      };
      // The effective background behind an element (walk up until a non-transparent bg).
      const bgBehind = (el: Element): string => {
        let n: Element | null = el;
        while (n) {
          const c = getComputedStyle(n).backgroundColor;
          if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") return c;
          n = n.parentElement;
        }
        return "rgb(0, 0, 0)";
      };

      // --- 0. LIVENESS FLOOR (a "don't do X" gate cannot tell clean from EMPTY) --------
      // The builder sometimes writes all its sections into components/ but forgets to wire them into
      // app/page.tsx, so the page renders the scaffold placeholder and every ban trivially passes.
      // A real landing page has substance: real height, a headline, and the extracted widgets it was
      // handed. If those are missing, nothing else about the page is worth checking.
      const bodyText = document.body.innerText || "";
      if (/Builder has not run yet/i.test(bodyText) || document.body.scrollHeight < 1200) {
        out.push({ rule: "empty-page", detail: `The page is the scaffold placeholder or nearly empty (height ${document.body.scrollHeight}px) — app/page.tsx was never wired to the sections you built in components/. Import and render them.`, where: "app/page.tsx" });
        return out; // everything downstream is meaningless on an empty page
      }
      const widgetCount = document.querySelectorAll('[style*="transform: scale"],[style*="transform:scale"]').length;
      if (widgetCount === 0) {
        out.push({ rule: "no-widgets-placed", detail: `None of the extracted product widgets were placed on the page. Every major section's centrepiece must be one of the provided <…Widget /> components.`, where: "app/page.tsx" });
      }
      if (!document.querySelector("h1")) {
        out.push({ rule: "no-headline", detail: `The page has no <h1>. It needs a real hero headline.`, where: "components/Hero" });
      }
      const inChrome = (el: Element) => !!el.closest("header,nav,footer");
      // Extracted product widgets are the reference's own markup — they are NOT the builder's work
      // and must never be judged by these rules.
      const inWidget = (el: Element) => !!el.closest('[style*="transform: scale"],[style*="transform:scale"]');

      // --- 1. EYEBROW / KICKER above a headline (the recurring offender) -----------------
      // A small pill/badge/label sitting above an h1/h2 inside a content section. A section's label
      // is its heading; nothing floats above it.
      document.querySelectorAll("h1,h2").forEach((h) => {
        if (inChrome(h) || inWidget(h)) return;
        const section = h.closest("section,div,main") ?? document.body;
        const hTop = h.getBoundingClientRect().top;
        section.querySelectorAll("span,div,p,a,small,em,strong").forEach((el) => {
          if (el.contains(h) || inChrome(el) || inWidget(el)) return;
          const t = textOf(el);
          if (!t || t.length < 3 || t.length > 70) return;
          if (el.querySelector("h1,h2,h3,p")) return; // a wrapper, not a label
          const r = el.getBoundingClientRect();
          if (r.height === 0 || r.top >= hTop) return; // must sit ABOVE the heading
          if (hTop - r.bottom > 120) return; // and be attached to it, not a distant element
          const s = getComputedStyle(el);
          const radius = parseFloat(s.borderRadius) || 0;
          const pill = radius >= 12 && (s.backgroundColor !== "rgba(0, 0, 0, 0)" || s.borderTopWidth !== "0px");
          const label = s.textTransform === "uppercase" || /mono/i.test(s.fontFamily);
          if (pill || label) {
            out.push({
              rule: "no-eyebrow",
              detail: `An eyebrow/kicker "${t.slice(0, 50)}" sits above the headline "${textOf(h).slice(0, 40)}". Banned: a section's label is its heading.`,
              where: t.slice(0, 50),
            });
          }
        });
      });

      // --- 2. GENERIC ICON-CARD GRID ---------------------------------------------------
      // >=3 sibling bordered/filled boxes, each an icon + a short heading + a line of grey text.
      const parents = new Set<Element>();
      document.querySelectorAll("div,section,ul").forEach((p) => parents.add(p));
      parents.forEach((p) => {
        if (inChrome(p) || inWidget(p)) return;
        const kids = Array.from(p.children).filter((c) => c.getBoundingClientRect().height > 40);
        if (kids.length < 3) return;
        const cardish = kids.filter((c) => {
          const s = getComputedStyle(c);
          const boxed = s.borderTopWidth !== "0px" || s.backgroundColor !== "rgba(0, 0, 0, 0)";
          const hasIcon = !!c.querySelector("svg");
          const hasHeading = !!c.querySelector("h3,h4,h5,strong,b");
          const hasCopy = !!c.querySelector("p");
          return boxed && hasIcon && hasHeading && hasCopy;
        });
        if (cardish.length >= 3) {
          out.push({
            rule: "no-icon-card-grid",
            detail: `A row of ${cardish.length} bordered icon-cards (icon + label + grey text) — the canonical vibe-coded feature grid. Replace with a real visual (extracted widget, gradient surface, plane change or dense typographic treatment).`,
            where: textOf(cardish[0]).slice(0, 50),
          });
        }
      });

      // --- 3. EMOJI --------------------------------------------------------------------
      const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;
      document.querySelectorAll("h1,h2,h3,p,span,a,button,li").forEach((el) => {
        if (inWidget(el)) return;
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent ?? "").join("");
        if (emoji.test(own)) out.push({ rule: "no-emoji", detail: `Emoji in "${own.trim().slice(0, 40)}"`, where: own.trim().slice(0, 40) });
      });

      // --- 4. DEAD LINKS ---------------------------------------------------------------
      document.querySelectorAll("a").forEach((a) => {
        if (inWidget(a)) return;
        const href = a.getAttribute("href") ?? "";
        if (href === "#" || href === "") {
          out.push({ rule: "no-dead-link", detail: `Link "${textOf(a).slice(0, 30)}" has href="${href}"`, where: textOf(a).slice(0, 30) });
        }
      });

      // --- 5. PLACEHOLDER TEXT ---------------------------------------------------------
      const body = document.body.innerText;
      for (const bad of ["Lorem ipsum", "TODO", "PLACEHOLDER", "Your Company", "lorem"]) {
        if (body.includes(bad)) out.push({ rule: "no-placeholder", detail: `Placeholder text "${bad}" left in the page`, where: bad });
      }

      // --- 6. META FUNDAMENTALS --------------------------------------------------------
      const title = document.title ?? "";
      const desc = document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "";
      if (!title || /untitled|home$/i.test(title)) out.push({ rule: "meta-title", detail: `Page <title> is "${title}" — must be the real product`, where: "app/layout.tsx" });
      if (!desc || desc.length < 30) out.push({ rule: "meta-description", detail: `Meta description missing/too short`, where: "app/layout.tsx" });

      // --- 7. COLOUR: RATIO + PLACEMENT vs the reference (NOT a hue blocklist) ----------
      // The reference legitimately uses colour (Linear's lavender card). The failure is discipline:
      // the reference keeps colour to a small ratio, bottom-weighted, and never in the nav or a
      // full-bleed hero background. Measure the SAME on this page (excluding the extracted widgets,
      // whose internal colour is the reference's own) and reject a build that breaks that discipline.
      const docH = Math.max(document.documentElement.scrollHeight, 1);
      const vp = innerWidth * innerHeight;
      let colored = 0, painted = 0, weightedY = 0;
      let colorNav = false, colorTopBand = false, colorTopBandWhere = "";
      document.querySelectorAll("section,div,main,article,aside,header,footer,nav").forEach((el) => {
        if (inWidget(el)) return;
        const r = el.getBoundingClientRect();
        const a = r.width * r.height;
        if (a < 2000) return;
        const s = getComputedStyle(el);
        const grad = !!s.backgroundImage && s.backgroundImage.indexOf("gradient(") !== -1;
        const bgPaint = s.backgroundColor && s.backgroundColor !== "rgba(0, 0, 0, 0)" && s.backgroundColor !== "transparent";
        if (!grad && !bgPaint) return;
        painted += a;
        let sat = bgPaint ? satOf(s.backgroundColor) : 0;
        if (grad) for (const st of s.backgroundImage.match(/rgba?\([^)]+\)/g) ?? []) sat = Math.max(sat, satOf(st));
        if (sat <= 0) return; // satOf already zeroes sub-chroma dark tints
        colored += a;
        weightedY += a * ((r.top + window.scrollY + r.height / 2) / docH);
        if (el.closest("header,nav")) colorNav = true;
        // A large saturated fill sitting in the top 45% of the page = a coloured hero/background band.
        if (r.top + window.scrollY < docH * 0.45 && r.width >= innerWidth * 0.6 && a >= vp * 0.15) {
          colorTopBand = true;
          colorTopBandWhere = textOf(el).slice(0, 40) || el.tagName.toLowerCase();
        }
      });
      const pct = painted > 0 ? (colored / painted) * 100 : 0;
      const centroidY = colored > 0 ? weightedY / colored : 0;
      // Ratio: strict, relative to the reference — max(ref×1.75, ref+2pp).
      const ceiling = Math.max(R.colorCoveragePct * 1.75, R.colorCoveragePct + 2);
      if (pct > ceiling) {
        out.push({ rule: "colour-ratio", detail: `${pct.toFixed(1)}% of the page's painted area is saturated colour; the reference keeps it to ${R.colorCoveragePct.toFixed(1)}%. The page is over-coloured — pull colour back to one or two small surfaces and let the rest stay monochrome.`, where: "page" });
      }
      // Placement: the reference keeps its nav monochrome.
      if (colorNav && !R.colorInNav) {
        out.push({ rule: "colour-in-nav", detail: `The nav/header carries saturated colour, but the reference keeps its nav monochrome. Remove colour from the nav.`, where: "components/Nav" });
      }
      // Placement: no full-bleed coloured hero background when the reference is bottom-weighted.
      if (colorTopBand && R.colorCentroidY > 0.5) {
        out.push({ rule: "colour-top-band", detail: `A large saturated fill sits in the hero / top of the page ("${colorTopBandWhere}"). The reference's colour is bottom-weighted (a card low on the page), never a full-bleed coloured hero. Make that surface monochrome; move any accent colour to a small surface lower down.`, where: colorTopBandWhere });
      }

      // --- 8. HEADLINE FONT: never mono / accent / decorative --------------------------
      // The mono-headline bug and the GeistPixel-headline bug are the same failure: a face that is not
      // the display face becomes the headline. Compare the rendered h1 family to the design's roles.
      const norm = (f: string) => f.split(",")[0].replace(/['"]/g, "").trim().toLowerCase();
      const h1 = document.querySelector("h1");
      if (h1) {
        const fam = norm(getComputedStyle(h1).fontFamily);
        const decorative = /pixel|mono|dot|glitch|dammit|comic|display-alt|stencil/i.test(fam);
        const isMono = R.monoFont ? fam === norm(R.monoFont) : false;
        const isDisplay = fam === norm(R.displayFont);
        if (isMono || decorative || (!isDisplay && R.displayFont && fam !== "sans-serif" && fam !== "serif")) {
          out.push({ rule: "headline-font", detail: `The headline renders in "${getComputedStyle(h1).fontFamily}", which is not the display face ("${R.displayFont}"). A mono/accent/decorative font must never be the headline. Use font-display / text-h1 for the headline.`, where: "components/Hero h1" });
        }
      }

      // --- 9. OVERLAPPING / ILLEGIBLE TEXT (builder chrome; widgets are exempt) ---------
      let overflowN = 0, illegibleN = 0, overSample = "", illSample = "";
      document.querySelectorAll("h1,h2,h3,h4,p,span,a,button,li,strong,em,label").forEach((el) => {
        if (inWidget(el)) return;
        const t = textOf(el);
        if (t.length < 4) return;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return;
        // Overflow: real content spilling its box (a fixed height cutting text, or a nowrap overrun).
        if (el.scrollHeight - el.clientHeight > 10 || el.scrollWidth - el.clientWidth > 10) {
          if (!overSample) overSample = t.slice(0, 34);
          overflowN++;
        }
        // Illegible: text too low-contrast against its own background (WCAG large-text floor ~3:1).
        const fg = relLum(cs.color), bg = relLum(bgBehind(el));
        if (fg !== null && bg !== null) {
          const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
          if (ratio < 2.2) { if (!illSample) illSample = t.slice(0, 34); illegibleN++; }
        }
      });
      if (overflowN > 0) out.push({ rule: "overlapping-text", detail: `${overflowN} text element(s) overflow their box and collide (e.g. "${overSample}"). Fix the layout so text is never clipped or overlapping.`, where: overSample });
      if (illegibleN > 2) out.push({ rule: "illegible-text", detail: `${illegibleN} text element(s) are near-invisible against their background (e.g. "${illSample}"). Use text/muted on dark, and ensure real contrast.`, where: illSample });

      // --- 10. COLLAPSED LAYOUT --------------------------------------------------------
      if (document.documentElement.scrollWidth > innerWidth + 4) {
        out.push({ rule: "horizontal-overflow", detail: `The page scrolls horizontally (content wider than the viewport). A section is overflowing — constrain it to the container width.`, where: "page" });
      }
      // A top-level section that has children but almost no height = a collapsed/empty band.
      const main = document.querySelector("main") ?? document.body;
      Array.from(main.children).forEach((el) => {
        if (inWidget(el) || inChrome(el)) return;
        const r = el.getBoundingClientRect();
        if (el.children.length >= 2 && r.height > 0 && r.height < 32) {
          out.push({ rule: "collapsed-section", detail: `A section collapsed to ${Math.round(r.height)}px tall despite having content ("${textOf(el).slice(0, 30)}"). Its layout broke — likely a flex/grid or height issue.`, where: textOf(el).slice(0, 30) });
        }
      });

      return out;
    }, ref);

    // De-duplicate by rule+where so one bad pattern doesn't spam the repair prompt.
    const seen = new Set<string>();
    return violations.filter((v) => {
      const k = `${v.rule}|${v.where}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  } finally {
    await browser.close();
    proc.kill("SIGTERM");
  }
}

// ---------------------------------------------------------------------------
// SOURCE HOOKS — the cheap deterministic tier. Some rules are clearer in the source than the render:
// an arbitrary Tailwind value, an off-scale spacing step, or a hand-written weight/tracking class
// overriding a `text-<role>`. Scans the builder's own .tsx (never the extracted widgets).
function collectTsx(dir: string, skip: (p: string) => boolean, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e);
    if (skip(p)) continue;
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) collectTsx(p, skip, acc);
    else if (/\.tsx?$/.test(e)) acc.push(p);
  }
}

export function scanSource(workspace: string, spacingScale: number[]): Violation[] {
  const out: Violation[] = [];
  const scale = new Set(spacingScale.map((n) => String(n)));
  const files: string[] = [];
  for (const sub of ["app", "components"]) {
    collectTsx(path.join(workspace, sub), (p) => /[\\/](extracted|node_modules|\.next)[\\/]/.test(p), files);
  }
  const SPACING = "(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)";
  for (const file of files) {
    const rel = file.slice(workspace.length + 1);
    const src = readFileSync(file, "utf8");

    // Arbitrary values for anything on the design system (spacing/colour/radius/type) — banned outright.
    const arb = [...src.matchAll(/\b(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|w|h|text|bg|border|rounded|font|tracking|leading|from|to|via)-\[[^\]]+\]/g)];
    if (arb.length) {
      out.push({ rule: "arbitrary-value", detail: `${rel}: arbitrary Tailwind value(s) ${[...new Set(arb.map((m) => m[0]))].slice(0, 4).join(", ")}. Every value must come from the design tokens — no bracketed one-offs.`, where: rel });
    }

    // Off-scale spacing steps (a number that is not one of the token scale steps).
    const offScale = new Set<string>();
    for (const m of src.matchAll(new RegExp(`\\b${SPACING}-(\\d+)\\b`, "g"))) {
      if (!scale.has(m[1])) offScale.add(m[0]);
    }
    if (offScale.size) {
      out.push({ rule: "off-scale-spacing", detail: `${rel}: spacing off the token scale — ${[...offScale].slice(0, 5).join(", ")}. Allowed steps: ${spacingScale.join(", ")}. Snap to the nearest.`, where: rel });
    }

    // A hand-written weight/tracking class on an element that already uses a `text-<role>` utility —
    // that override is exactly what made body copy read generic.
    for (const m of src.matchAll(/className\s*=\s*(?:"([^"]*)"|`([^`]*)`|\{`([^`]*)`\})/g)) {
      const cls = m[1] || m[2] || m[3] || "";
      if (/\btext-(h1|h2|h3|body|lead|small|display)\b/.test(cls) && /\b(font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)|tracking-\w+)\b/.test(cls)) {
        out.push({ rule: "type-override", detail: `${rel}: a font-weight/tracking class is set on an element that already uses a text-<role> utility ("${cls.slice(0, 60)}"). The role already carries the extracted weight+tracking — remove the override.`, where: rel });
        break;
      }
    }

    // Dead links + placeholder text in source (also render-checked, but cheap to catch here).
    if (/href\s*=\s*(?:"#"|'#'|\{["'`]#["'`]\})/.test(src)) out.push({ rule: "dead-link-src", detail: `${rel}: an href="#" link. Every link must go somewhere real or be omitted.`, where: rel });
    for (const bad of ["Lorem ipsum", "lorem ipsum", "PLACEHOLDER", "TODO:"]) if (src.includes(bad)) out.push({ rule: "placeholder-src", detail: `${rel}: placeholder text "${bad}" left in source.`, where: rel });
  }
  // De-dupe per rule+file.
  const seen = new Set<string>();
  return out.filter((v) => {
    const k = `${v.rule}|${v.where}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Render the violations as a repair brief the builder subagent can act on directly. */
export function repairBrief(violations: Violation[]): string {
  const byRule = new Map<string, Violation[]>();
  for (const v of violations) {
    const arr = byRule.get(v.rule) ?? [];
    arr.push(v);
    byRule.set(v.rule, arr);
  }
  const lines: string[] = [
    `Your page was rendered and checked against the deterministic design gate. It FAILED ${violations.length} check(s).`,
    `These are hard rules, not suggestions. Fix every one of them in the source, then stop.`,
    ``,
  ];
  for (const [rule, vs] of byRule) {
    lines.push(`## ${rule} (${vs.length})`);
    for (const v of vs.slice(0, 6)) lines.push(`- ${v.detail}`);
    lines.push("");
  }
  lines.push(
    `Do NOT touch anything under components/extracted/ — those are the reference's own extracted widgets and are exempt.`,
    `Fix only what the gate flagged. Keep every other value on the design tokens.`,
  );
  return lines.join("\n");
}
