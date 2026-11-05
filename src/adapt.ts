// THE DEFAULT BUILD (post second-pivot): single-site CLONE-AND-ADAPT.
//
//   npx tsx src/adapt.ts "<one-line product prompt>" --ref <reference-url> [--out <dir>] [--model <id>]
//
// Faithfully clone ONE reference page (layout/structure/styling/components — src/clone.ts), then change
// only the wording for the user's product (src/swap.ts). No synthesis, no randomization, no recolour, no
// builder-composed layout — those pulled the pipeline away from faithful reproduction and are retired
// (the code stays in src/, just off the default path). Variety comes from many references, not blending.
import { rm, mkdir, rename } from "node:fs/promises";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { launch, openStatic } from "./browser.js";
import { clonePage, emitClone } from "./clone.js";
import { deriveProductName, swapWording } from "./swap.js";
import { brandLeakOnPage, checkForms } from "./audit.js";
import { renderCheck, marksSource } from "./render-audit.js";
import { wireForms, emitFormServer } from "./behavior.js";

const DEFAULT_MODEL = "claude-opus-4-8";
const MAP_PATH = "./category-map.json";

function parseArgs(argv: string[]) {
  const a = argv.slice(2);
  let prompt = "", ref = "", out = "./build", model = DEFAULT_MODEL, name = "", vision = true;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--ref") ref = a[++i];
    else if (a[i] === "--out") out = a[++i];
    else if (a[i] === "--model") model = a[++i];
    else if (a[i] === "--name") name = a[++i];
    else if (a[i] === "--no-vision") vision = false;
    else if (!a[i].startsWith("--") && !prompt) prompt = a[i];
  }
  if (!prompt) { console.error('Usage: tsx src/adapt.ts "<product prompt>" [--ref <url>] [--out <dir>] [--model <id>] [--name <product name>] [--no-vision]\n  With no --ref, the prompt is routed to a category and a vetted reference is chosen at random.\n  With --name, naming (and its real-company screening) is skipped — useful for cheap re-runs.\n  With --no-vision, the rendered check runs on its deterministic mark matcher only (no model call).'); process.exit(1); }
  if (ref && !/^https?:\/\//.test(ref)) ref = "https://" + ref;
  return { prompt, ref, out, model, name, vision };
}

/** Route a product prompt to a vetted reference: classify into a category-map category, then pick one
 *  of that category's screened references at random. This is what makes variety come from MANY vetted
 *  references (Decision 3) rather than blending — each build clones a different real, vetted site. */
async function routeToReference(prompt: string, model: string): Promise<{ ref: string; category: string }> {
  const map: Record<string, { references?: string[] }> = existsSync(MAP_PATH) ? JSON.parse(readFileSync(MAP_PATH, "utf8")) : {};
  const cats = Object.keys(map).filter((c) => (map[c].references ?? []).length > 0);
  if (!cats.length) throw new Error(`no vetted references in ${MAP_PATH}. Run: npx tsx src/discover.ts <category>  (or pass --ref <url>)`);
  const q = query({
    prompt: `Classify this product into exactly ONE of these categories: ${JSON.stringify(cats)}.\nProduct: "${prompt}"\nReturn ONLY the category string.`,
    options: { model, allowedTools: [], settingSources: [], systemPrompt: "You output only one category string from the list." },
  });
  let out = ""; for await (const m of q) if (m.type === "result" && m.subtype === "success") out = m.result;
  const picked = cats.find((c) => out.trim().toLowerCase().includes(c.toLowerCase())) ?? cats[0];
  const refs = map[picked].references!;
  const ref = refs[Math.floor(Math.random() * refs.length)];
  return { ref: /^https?:\/\//.test(ref) ? ref : "https://" + ref, category: picked };
}

function refBrand(url: string): string {
  try { const h = new URL(url).hostname.replace(/^www\./, "").split(".")[0]; return h.charAt(0).toUpperCase() + h.slice(1); } catch { return ""; }
}

interface VerifyResult { brandLeak: string[]; layout: string[]; renderNotes: string[]; behavior: string[] }

/** Verify a clone+swap output. BRAND LEAK is a hard failure — shipping the reference's identity or its
 *  customers' logos makes the output unusable — so it is checked exhaustively (not just innerText: the
 *  brand lives in SVG/img logos, aria-labels and customer marquees) and fails the build. Layout issues
 *  (overflow / empty page) are soft warnings.
 *  The brand walker itself lives in audit.ts, and the RENDERED check in render-audit.ts, so the build gate
 *  and `npm run audit` can never disagree.
 *
 *  The rendered check is the reason the text walker is not enough: clerk's nav logo is an unlabelled <svg>
 *  whose letters are path geometry, so it shipped under `verify: clean`. Its hits are appended to brandLeak,
 *  which means a rendered leak exits 1 exactly like a text leak. */
async function verify(opts: { indexHtmlPath: string; brand: string; dir: string; ref: string; productName: string; vision: boolean }): Promise<VerifyResult> {
  const { indexHtmlPath, brand, dir, ref, productName, vision } = opts;
  const layout: string[] = [];
  let brandLeak: string[] = [];
  let renderNotes: string[] = [];
  let behavior: string[] = [];
  const browser = await chromium.launch({ headless: true });
  try {
    // `openStatic` (browser.ts) is deliberately not a hard `networkidle` gate: with several clones rendering
    // at once a page that settles in ~700ms standalone can blow the deadline, and a build that cloned +
    // swapped perfectly then exits 1 for no design reason (measured: the clerk run).
    const page = await openStatic(browser, indexHtmlPath);
    brandLeak = await brandLeakOnPage(page, brand);
    const r = await page.evaluate(() => ({
      height: document.body.scrollHeight,
      hoverflow: document.documentElement.scrollWidth > innerWidth + 2,
    }));
    if (r.height < 1500) layout.push(`page looks empty (height ${r.height}px)`);
    if (r.hoverflow) layout.push(`horizontal overflow (a relabelled string widened a box)`);
    await page.close();

    const render = await renderCheck({ browser, indexPath: indexHtmlPath, marksFrom: marksSource(dir, ref), brand, productName, vision });
    console.log(`  render : ${render.marks} identity mark(s) vs ${render.candidates} rendered graphic(s)${render.vision.ran ? `, vision over ${render.vision.tiles} tiles` : ` (vision skipped: ${render.vision.skipped})`}`);
    brandLeak = brandLeak.concat(render.hard);
    renderNotes = render.notes;

    // A form that is on the page and does nothing is the §4.3 tell. `checkForms` lives in audit.ts so the
    // build gate and `npm run audit` run the identical test — the same discipline as brandLeakOnPage.
    const f = await checkForms(browser, dir);
    console.log(`  forms  : ${f.detectable} detectable, ${f.tagged} wired, ${f.working} submitting`);
    behavior = f.problems;
  } finally {
    await browser.close();
  }
  return { brandLeak, layout, renderNotes, behavior };
}

async function main() {
  const args = parseArgs(process.argv);
  const { prompt, out, model } = args;
  if (!process.env.ANTHROPIC_API_KEY) console.warn("  ⚠ ANTHROPIC_API_KEY not set — the swap needs credentials (or an ambient Claude Code login).");

  // Bring-your-own reference, else route the prompt to a vetted one at random.
  let ref = args.ref;
  let routedCategory = "";
  if (!ref) { const r = await routeToReference(prompt, model); ref = r.ref; routedCategory = r.category; }

  const dir = path.resolve(out, refBrand(ref).toLowerCase() + "-clone");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  console.log(`\n▸ Clone-and-adapt`);
  console.log(`  reference: ${ref}${routedCategory ? `  (routed → ${routedCategory}, random vetted pick)` : "  (bring-your-own)"}`);
  console.log(`  product:   ${prompt}`);
  console.log(`  → ${dir}\n`);

  // 1. Clone the whole reference page.
  const { browser, page } = await launch(ref);
  let clonedInfo;
  try {
    const cloned = await clonePage(page);
    clonedInfo = { nodes: cloned.nodes, w: cloned.width, h: cloned.height, canvas: cloned.canvasCount };
    const emitted = await emitClone(dir, cloned, ref);
    console.log(`  cloned: ${cloned.nodes} nodes, ${cloned.width}×${cloned.height}px, ${cloned.textCount} text strings, ${emitted.assets} assets, ${emitted.fonts} fonts`);
  } finally {
    await browser.close();
  }

  // 2. Swap the wording for the user's product. The name is screened against real companies
  //    (src/name.ts) — an unscreened name shipped real brands as the invented product.
  const productName = args.name || (await deriveProductName(prompt, model));
  console.log(`  product name: ${productName}${args.name ? "  (pinned via --name, unscreened)" : ""}`);
  const res = await swapWording(path.join(dir, "index.html"), prompt, productName, model, refBrand(ref));
  // Overwrite the clone's index.html with the adapted one (keep a copy of the untouched clone).
  await rename(path.join(dir, "index.html"), path.join(dir, "index.clone.html"));
  writeFileSync(path.join(dir, "index.html"), res.html);
  console.log(`  wording: ${res.mapped} slots rewritten for "${productName}"`);

  // 3. BEHAVIOUR. Wire the forms the reference already ships so they actually submit — the reference's own UI
  //    stays the spec (nothing invented, no model call). Runs AFTER the swap so the copy it wires, including
  //    each `placeholder`, is already the product's. Capture only: no fake account, no fake session.
  const wired = await wireForms(path.join(dir, "index.html"));
  if (wired.report.detected.length) {
    writeFileSync(path.join(dir, "index.html"), wired.html);
    const served = await emitFormServer(dir);
    console.log(`  behaviour: ${wired.report.detected.length} form(s) wired to ${served ? "POST /api/submit (server.mjs emitted)" : "the local fallback (server template missing)"}`);
  } else {
    console.log(`  behaviour: no wirable forms on this page (nothing invented)`);
  }
  for (const n of wired.report.notes) console.log(`             ! ${n}`);

  // 4. Verify. Brand leak — text OR rendered — = HARD FAIL (unshippable); layout issues = soft warnings.
  const { brandLeak, layout, renderNotes, behavior } = await verify({
    indexHtmlPath: path.join(dir, "index.html"), brand: refBrand(ref), dir, ref, productName, vision: args.vision,
  });
  console.log(`\n──────────────────────────────────────────────`);
  console.log(`output : ${path.join(dir, "index.html")}`);
  if (brandLeak.length) { console.log(`verify : ✗ BRAND LEAK — build FAILED (unshippable):`); for (const i of brandLeak) console.log(`         ✗ ${i}`); }
  if (behavior.length) { console.log(`${brandLeak.length ? "       " : "verify"} : ✗ DEAD INTERACTION — build FAILED:`); for (const i of behavior) console.log(`         ✗ ${i}`); }
  if (layout.length) { console.log(`${brandLeak.length || behavior.length ? "       " : "verify"} : ${layout.length} layout warning(s):`); for (const i of layout) console.log(`         ⚠ ${i}`); }
  if (renderNotes.length) { console.log(`render : ${renderNotes.length} note(s) (not failures):`); for (const i of renderNotes) console.log(`         ! ${i}`); }
  if (!brandLeak.length && !behavior.length && !layout.length) console.log(`verify : clean (no brand leak in the text OR the render, no dead form, no layout break)`);
  console.log(`\nopen it:  open "${path.join(dir, "index.html")}"`);
  if (existsSync(path.join(dir, "server.mjs"))) console.log(`serve it (forms really submit): node "${path.join(dir, "server.mjs")}" 3000`);
  process.exit(brandLeak.length || behavior.length ? 1 : 0);
}

main().catch((e) => { console.error("\n✗ adapt failed:", e); process.exit(1); });
