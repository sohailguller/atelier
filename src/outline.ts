// OUTLINE — the designer's map of a reference's REAL parts. Deterministic, no model call.
//
//   npx tsx src/outline.ts <output/<host>> [--no-shots]
//
// Reads the faithful clone (<host>/site/index.html) and reduces 1–2MB of markup to a few-KB ordered list of
// sections: role guess, layout, headings, CTAs, media counts, and one small JPEG crop per section. The designer
// agent composes from THIS (keeping the reference's real section order and layout types) instead of reading
// the clone or inventing a composition, which is what keeps it cheap and keeps it from drifting.
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { openStatic } from "./browser.js";

export interface OutlineSection {
  i: number;
  role: string; // nav | hero | logos | features | product | testimonial | stats | pricing | faq | cta | footer | content
  layout: string; // stack | split | grid-N | marquee | full-bleed
  top: number; height: number;
  headings: string[];
  text: string; // first ~160 chars of body copy
  ctas: string[];
  media: { img: number; svg: number; video: number; canvas: number };
  forms: number;
  bg: string;
  shot?: string; // relative path to the crop
}

export interface Outline { source: string; width: number; height: number; bodyBg: string; sections: OutlineSection[] }

export async function buildOutline(refDir: string, shots = true): Promise<Outline> {
  const index = path.join(refDir, "site", "index.html");
  if (!existsSync(index)) throw new Error(`no clone at ${index} — run: npm run clone <url>`);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openStatic(browser, index, 1440);
    const raw = await page.evaluate(() => {
      const vis = (el: Element) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.height > 24 && r.width > 200 && cs.display !== "none" && cs.visibility !== "hidden"; };
      const kids = (el: Element) => [...el.children].filter(vis);
      // Recursively expand wrappers: anything much taller than a screen with several visible children is a
      // container of sections (#__next > div > main > div …), not a section itself.
      const blocks: Element[] = [];
      const expand = (el: Element, d: number) => {
        for (const c of kids(el)) {
          const h = c.getBoundingClientRect().height;
          const ck = kids(c).filter((x) => x.getBoundingClientRect().height > 40);
          if (d < 10 && h > innerHeight * 1.9 && ck.length >= 1 && c.tagName !== "SECTION") expand(c, d + 1);
          else if (d < 10 && h > innerHeight * 1.9 && c.tagName === "SECTION" && ck.length >= 3 && ck.every((x) => x.getBoundingClientRect().height > 300)) expand(c, d + 1);
          else blocks.push(c);
        }
      };
      expand(document.body, 0);

      const clean = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim();
      const keep = blocks.filter((b) => b.getBoundingClientRect().height > 40);
      return keep.map((b) => {
        const r = b.getBoundingClientRect();
        const heads = [...(b.matches("h1,h2,h3") ? [b] : []), ...b.querySelectorAll("h1,h2,h3")].filter(vis).map((h) => clean(h.textContent)).filter(Boolean).slice(0, 4);
        const ctas = [...b.querySelectorAll("a,button")].filter((a) => { const t = clean(a.textContent); const cs = getComputedStyle(a); return t.length > 1 && t.length < 28 && (cs.backgroundColor !== "rgba(0, 0, 0, 0)" || parseFloat(cs.borderTopWidth) > 0); }).map((a) => clean(a.textContent)).slice(0, 3);
        const ps = [...b.querySelectorAll("p")].map((p) => clean(p.textContent)).filter((t) => t.length > 30);
        // Layout: count distinct column x-positions among the largest repeated row of children.
        let layout = "stack";
        const inner = [...b.querySelectorAll("*")].filter((e) => e.children.length >= 2 && e.children.length <= 12 && e.getBoundingClientRect().width > r.width * 0.6).slice(0, 40);
        let bestCols = 1;
        for (const e of inner) {
          const xs = new Set([...e.children].filter(vis).map((c) => Math.round(c.getBoundingClientRect().left / 20)));
          const tops = new Set([...e.children].filter(vis).map((c) => Math.round(c.getBoundingClientRect().top / 20)));
          if (xs.size > bestCols && tops.size <= Math.ceil(e.children.length / xs.size) + 1) bestCols = xs.size;
        }
        const cs = getComputedStyle(b);
        if (/marquee|scroll|ticker/i.test(b.innerHTML.slice(0, 4000)) && b.querySelectorAll("img,svg").length >= 6) layout = "marquee";
        else if (bestCols === 2) layout = "split";
        else if (bestCols >= 3) layout = `grid-${Math.min(bestCols, 6)}`;
        else if (b.querySelector("img,video,canvas") && r.height > 500) layout = "full-bleed";
        return {
          tag: b.tagName.toLowerCase(), top: Math.round(r.top + scrollY), height: Math.round(r.height),
          headings: heads, text: (ps[0] || "").slice(0, 160), ctas,
          media: { img: b.querySelectorAll("img").length, svg: b.querySelectorAll("svg").length, video: b.querySelectorAll("video").length, canvas: b.querySelectorAll("canvas").length },
          forms: b.querySelectorAll("form,input[type=email]").length,
          bg: cs.backgroundColor, layout,
          words: clean(b.textContent).toLowerCase().slice(0, 1500),
        };
      });
    });

    const docH = await page.evaluate(() => document.documentElement.scrollHeight);
    const sections: OutlineSection[] = raw.map((s, i) => {
      const w = s.words;
      let role = "content";
      if (s.tag === "nav" || s.tag === "header" || (i === 0 && s.height < 160)) role = "nav";
      else if (s.tag === "footer" || (i === raw.length - 1 && /©|privacy|terms/.test(w))) role = "footer";
      else if (s.headings.length && s.top < 1100 && !raw.slice(0, i).some((p) => p.headings.length && p.tag !== "nav" && p.tag !== "header")) role = "hero";
      else if (s.layout === "marquee" || (s.media.img + s.media.svg >= 5 && w.length < 400 && !s.headings.length)) role = "logos";
      else if (/\$\d|per month|\/mo|pricing|enterprise plan/.test(w)) role = "pricing";
      else if (/frequently asked|faq/.test(w)) role = "faq";
      else if (/“|”|"[^"]{40,}"|— [A-Z]|ceo|cto|founder|head of/i.test(w) && s.headings.length <= 1) role = "testimonial";
      else if ((w.match(/\d+(\.\d+)?(%|x|k|m|\+)/g) || []).length >= 3 && w.length < 600) role = "stats";
      else if (s.ctas.length && w.length < 400 && i >= raw.length - 3) role = "cta";
      else if (s.layout.startsWith("grid")) role = "features";
      else if (s.media.img + s.media.video + s.media.canvas >= 1 && s.layout === "split") role = "product";
      return { i, role, layout: s.layout, top: s.top, height: s.height, headings: s.headings, text: s.text, ctas: s.ctas, media: s.media, forms: s.forms, bg: s.bg };
    });

    if (shots) {
      const dir = path.join(refDir, "outline");
      await mkdir(dir, { recursive: true });
      for (const s of sections) {
        const h = Math.min(s.height, 1100);
        if (h < 40) continue;
        const file = `s${String(s.i).padStart(2, "0")}-${s.role}.jpg`;
        await page.screenshot({ path: path.join(dir, file), type: "jpeg", quality: 55, fullPage: true, clip: { x: 0, y: s.top, width: 1440, height: h }, scale: "css" }).catch(() => {});
        if (existsSync(path.join(dir, file))) s.shot = `outline/${file}`;
      }
    }
    const meta = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    return { source: refDir, width: 1440, height: docH, bodyBg: meta, sections };
  } finally {
    await browser.close();
  }
}

export function outlineMarkdown(o: Outline): string {
  const lines = [`# Outline — ${path.basename(o.source)}`, ``, `page ${o.width}×${o.height}px · body bg ${o.bodyBg} · ${o.sections.length} sections (top→bottom)`, ``];
  for (const s of o.sections) {
    const m = s.media; const media = [m.img && `${m.img} img`, m.svg && `${m.svg} svg`, m.video && `${m.video} video`, m.canvas && `${m.canvas} canvas`].filter(Boolean).join(", ");
    lines.push(`## ${s.i}. ${s.role} — ${s.layout} (${s.height}px)`);
    if (s.headings.length) lines.push(`- headings: ${s.headings.map((h) => `"${h.slice(0, 90)}"`).join(" · ")}`);
    if (s.text) lines.push(`- copy: "${s.text}"`);
    if (s.ctas.length) lines.push(`- CTAs: ${s.ctas.map((c) => `[${c}]`).join(" ")}`);
    if (media) lines.push(`- media: ${media}`);
    if (s.forms) lines.push(`- forms: ${s.forms}`);
    lines.push(`- bg: ${s.bg}${s.shot ? ` · shot: ${s.shot}` : ""}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) { console.error("Usage: tsx src/outline.ts <output/<host>> [--no-shots]"); process.exit(1); }
  const o = await buildOutline(dir, !args.includes("--no-shots"));
  await writeFile(path.join(dir, "outline.json"), JSON.stringify(o, null, 2) + "\n");
  await writeFile(path.join(dir, "OUTLINE.md"), outlineMarkdown(o));
  console.log(`✓ outline: ${o.sections.length} sections → ${path.join(dir, "OUTLINE.md")}`);
  console.log(o.sections.map((s) => `  ${s.i}. ${s.role} (${s.layout})${s.headings[0] ? ` — ${s.headings[0].slice(0, 60)}` : ""}`).join("\n"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("✗ outline failed:", e); process.exit(1); });
}
