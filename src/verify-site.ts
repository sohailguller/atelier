// VERIFY-SITE — the deterministic acceptance check for a coded workspace. No model call.
//
//   npx tsx src/verify-site.ts <workspace> [--ref <url>] [--no-build] [--no-gate]
//
// 1. `next build` (static export → out/).  2. Source hooks + rendered design gate (src/builder/gate.ts).
// 3. Brand leak in text/attrs/logo walls (src/audit.ts) and in PIXELS via the identity-mark matcher
//    (src/render-audit.ts, vision off — the agent can look at screenshots itself if it wants a second opinion).
// 4. Responsive: no horizontal overflow at 1440/768/390; template placeholders gone.
// Prints a compact report + a repair brief the coder acts on. Exit 0 = shippable, 1 = fix the listed items.
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { loadArtifact } from "./artifact/load.js";
import { runGate, scanSource, repairBrief, type RefProfile, type Violation } from "./builder/gate.js";
import { brandLeakOnPage } from "./audit.js";
import { renderCheck } from "./render-audit.js";
import { openLive } from "./browser.js";

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".txt": "text/plain", ".ico": "image/x-icon" };

/** Serve a static export on an ephemeral port. */
export function serveStatic(root: string): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let p = decodeURIComponent((req.url || "/").split("?")[0]);
    let f = path.join(root, p);
    if (!f.startsWith(root)) { res.writeHead(403).end(); return; }
    if (existsSync(f) && statSync(f).isDirectory()) f = path.join(f, "index.html");
    if (!existsSync(f) && existsSync(f + ".html")) f = f + ".html";
    if (!existsSync(f)) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(f).toLowerCase()] ?? "application/octet-stream" });
    res.end(readFileSync(f));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const a = server.address(); resolve({ url: `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/`, server });
  }));
}

export function refBrand(url: string): string {
  try { const h = new URL(url).hostname.replace(/^www\./, "").split(".")[0]; return h.charAt(0).toUpperCase() + h.slice(1); } catch { return ""; }
}

function refProfile(refDir: string): RefProfile | null {
  try {
    const ds = loadArtifact(path.join(refDir, "design-system"));
    const fx = ds.tokens.effects;
    return { colorCoveragePct: fx?.colorfulAreaPct ?? 3, colorCentroidY: fx?.colorCentroidY ?? 0.5, colorInNav: fx?.colorInNav ?? false, displayFont: ds.tokens.font.display, monoFont: ds.tokens.font.mono ?? null, spacingScale: ds.tokens.space };
  } catch { return null; }
}

async function main() {
  const args = process.argv.slice(2);
  const ws = path.resolve(args.find((a) => !a.startsWith("--")) ?? "");
  if (!ws || !existsSync(path.join(ws, "package.json"))) { console.error("Usage: tsx src/verify-site.ts <workspace> [--ref <url>] [--no-build] [--no-gate]"); process.exit(1); }
  const meta = existsSync(path.join(ws, ".atelier.json")) ? JSON.parse(readFileSync(path.join(ws, ".atelier.json"), "utf8")) : {};
  const ri = args.indexOf("--ref");
  const ref: string = ri >= 0 ? args[ri + 1] : meta.ref ?? "";
  const refDir: string = meta.refDir ?? "";
  const brand = refBrand(ref);
  const problems: Violation[] = [];
  const notes: string[] = [];
  const row = (k: string, ok: boolean, d = "") => console.log(`  ${ok ? "✓" : "✗"} ${k}${d ? " — " + d : ""}`);

  // 1. Build.
  if (!args.includes("--no-build")) {
    const t0 = Date.now();
    const r = spawnSync("npm", ["run", "build"], { cwd: ws, encoding: "utf8" });
    const ok = r.status === 0;
    row("build", ok, ok ? `${((Date.now() - t0) / 1000).toFixed(0)}s` : "next build failed");
    if (!ok) {
      const err = (r.stdout + "\n" + r.stderr).split("\n").filter((l) => /error|Error|failed|Type /.test(l)).slice(0, 12).join("\n");
      console.log(err.split("\n").map((l) => "    " + l).join("\n"));
      console.log("\nREPAIR: fix the build errors above, then re-run verify.");
      process.exit(1);
    }
  }
  const outDir = path.join(ws, "out");
  if (!existsSync(path.join(outDir, "index.html"))) { row("export", false, "out/index.html missing (next.config must have output: 'export')"); process.exit(1); }

  // 2. Source hooks + rendered gate.
  const prof = refDir ? refProfile(refDir) : null;
  // A componentized build IS the reference's design, so the synthesis-era gate (which polices invented markup)
  // does not apply — it would flag the reference's own classes. Brand, responsive and integrity checks still do.
  if (prof && !args.includes("--no-gate") && meta.mode !== "componentized") {
    const src = scanSource(ws, prof.spacingScale);
    let rendered: Violation[] = [];
    try { rendered = await runGate(ws, prof); } catch (e) { notes.push(`rendered gate could not run: ${(e as Error).message}`); }
    // no-widgets-placed belongs to the retired widget-embedding path: this pipeline builds product UI in JSX.
    const all = [...src, ...rendered].filter((v) => v.rule !== "no-widgets-placed");
    problems.push(...all);
    row("design gate", all.length === 0, all.length ? `${all.length} violation(s)` : "no banned patterns");
  }

  // 3 + 4. Rendered checks on the served export.
  const { url, server } = await serveStatic(outDir);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openLive(browser, url); // carries the tsx __name shim (see browser.ts)

    const pageText = await page.evaluate(() => document.body.innerText || "");
    const title = await page.title();
    const placeholders = [/Untitled Product/i, /Builder has not run/i, /lorem ipsum/i, /Replace this with/i].filter((re) => re.test(pageText) || re.test(title)).map(String);
    if (placeholders.length) problems.push({ rule: "placeholder", detail: `template/placeholder text still present: ${placeholders.join(", ")} (set metadata in app/layout.tsx)`, where: "app/layout.tsx" });
    row("copy", !placeholders.length, placeholders.length ? "placeholders remain" : `title "${title}"`);

    if (brand) {
      const leaks = await brandLeakOnPage(page, brand);
      for (const l of leaks) problems.push({ rule: "brand-leak", detail: l, where: "page" });
      row("brand (text)", !leaks.length, leaks.length ? leaks.slice(0, 2).join("; ") : `no "${brand}"`);
    }

    for (const w of [1440, 768, 390]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(250);
      const docW = await page.evaluate(() => document.documentElement.scrollWidth);
      if (docW > w + 2) problems.push({ rule: "responsive", detail: `horizontal overflow at ${w}px (document is ${docW}px wide) — find the fixed-width element`, where: `${w}px` });
    }
    row("responsive", !problems.some((p) => p.rule === "responsive"), "1440/768/390");

    // Integrity: every image actually loads (a broken conversion or a dropped asset shows up here first).
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 800) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); } scrollTo(0, 0); });
    await page.waitForTimeout(600);
    const broken = await page.evaluate(() => Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 0 && i.getAttribute("src") && !i.getAttribute("src")!.startsWith("data:")).map((i) => i.getAttribute("src")!).slice(0, 5));
    for (const b of broken) problems.push({ rule: "broken-image", detail: `image does not load: ${b}`, where: b });
    row("images", !broken.length, broken.length ? `${broken.length} broken` : "all load");
    await page.close();

    const marksFrom = refDir && existsSync(path.join(refDir, "site", "index.html")) ? path.join(refDir, "site", "index.html") : ref;
    if (brand && marksFrom) {
      try {
        const r = await renderCheck({ browser, indexPath: url, marksFrom, brand, vision: false });
        for (const h of r.hard) problems.push({ rule: "brand-mark", detail: h, where: "rendered page" });
        notes.push(...r.notes);
        row("brand (pixels)", !r.hard.length, `${r.marks} reference marks checked against ${r.candidates} graphics`);
      } catch (e) { notes.push(`mark check could not run: ${(e as Error).message}`); }
    }
  } finally {
    await browser.close();
    server.close();
  }

  for (const n of notes.slice(0, 5)) console.log(`  · ${n}`);
  if (!problems.length) { console.log(`\n✓ SHIPPABLE — preview: npx serve ${outDir}  (or: npm --prefix ${ws} run dev)`); process.exit(0); }
  console.log("\n" + repairBrief(problems));
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("✗ verify failed:", e); process.exit(1); });
}
