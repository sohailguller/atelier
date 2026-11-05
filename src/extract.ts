// CLI entry point. Orchestrates the §4 extraction pipeline and emits the §5 folder.
//   npx tsx src/extract.ts <url> [--out <dir>]
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { launch, healthCheck, captureScreenshots } from "./browser.js";
import { probe } from "./probes.js";
import { buildTokens } from "./tokens.js";
import { downloadAssets } from "./assets.js";
import { extractComponents, emitComponents } from "./components.js";
import { emit } from "./emit.js";
import { CURRENT_ARTIFACT_VERSION } from "./artifact/schema.js";

function parseArgs(argv: string[]): { url: string; out: string } {
  const args = argv.slice(2);
  let url = "";
  let out = "./output";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") out = args[++i];
    else if (!args[i].startsWith("--")) url = args[i];
  }
  if (!url) {
    console.error("Usage: tsx src/extract.ts <url> [--out <dir>]");
    process.exit(1);
  }
  if (!/^https?:\/\//.test(url)) url = "https://" + url;
  return { url, out };
}

function hostname(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "site";
  }
}

async function main() {
  const { url, out } = parseArgs(process.argv);
  const dsDir = path.join(out, hostname(url), "design-system");
  await mkdir(dsDir, { recursive: true });

  console.log(`\n▸ Extracting design system from ${url}`);
  console.log(`  → ${dsDir}\n`);

  const t0 = Date.now();
  const { browser, page, network } = await launch(url);
  try {
    // 1. Startup screenshot health check (recovery gate).
    const health = await healthCheck(page);
    console.log(`  health: visual channel ${health.visualChannel ? "UP" : "DOWN"} — ${health.reason}`);

    // 2. Screenshots (skipped/empty when channel is down).
    const screenshots = await captureScreenshots(page, path.join(dsDir, "screenshots"), health.visualChannel);
    console.log(`  screenshots: ${screenshots.length} captured`);

    // 3. Style probes (also the DOM-measurement channel — never depends on pixels).
    const raw = await probe(page, url);
    // Merge CORS-proof network-captured asset URLs into the measurements. Linear serves its
    // fonts/SVGs from cross-origin sheets the CSSOM can't read, so the network channel is the
    // reliable source; the CSSOM channel supplements it when readable.
    if (network.fonts.size) {
      const known = new Set(raw.fontFaces.flatMap((f) => f.urls));
      const fresh = [...network.fonts].filter((u) => !known.has(u));
      if (fresh.length) raw.fontFaces.push({ family: "(from-network)", weight: "", style: "", urls: fresh });
    }
    for (const svg of network.images) if (!raw.backgroundImages.includes(svg)) raw.backgroundImages.push(svg);
    console.log(
      `  probes: ${raw.fontFaces.length} font-face group(s), ${raw.spacingSamples.length} spacing samples, ` +
        `${raw.radii.length} radii, ${raw.boxShadows.length} shadow(s); ` +
        `network: ${network.fonts.size} font url(s), ${network.images.size} svg(s)`
    );

    // 4. Build tokens (recovery layer lives here).
    const { tokens, recovery, recipes, notes } = buildTokens(raw, health);

    // 5. Download + verify assets (no dead url()s).
    const assets = await downloadAssets(raw, dsDir);
    const okFonts = assets.reports.filter((r) => r.kind === "font" && r.ok).length;
    const okAssets = assets.reports.filter((r) => r.kind === "asset" && r.ok).length;
    console.log(`  assets: ${okFonts} font(s) + ${okAssets} asset(s) verified & downloaded`);

    // 5b. Extract the real product-UI widget(s) — the v1.2 breakthrough (§12). Pure DOM/CSSOM,
    //     self-contained markup, pinned widths. The canvas/WebGL guard flags an un-extractable base.
    const comp = await extractComponents(page);
    for (const n of comp.notes) console.log(`  ${n}`);
    if (comp.canvasBlocked) {
      console.error(
        `\n✗ Reference base is un-extractable: the hero widget is ${Math.round(comp.canvasBlocked.canvasRatio * 100)}% ` +
          `canvas/WebGL (pixels, not markup). Per §12 step 7, pick a DIFFERENT reference base — do not approximate.`,
      );
      process.exitCode = 1;
      return;
    }
    const emitted = await emitComponents(dsDir, comp.components, url);
    notes.push(...comp.notes, ...emitted.notes);

    // 6. Emit the folder — emit() self-validates against the artifact contract before returning.
    const validation = await emit({ url, dsDir, tokens, recovery, recipes, notes, health, raw, assets, screenshots, components: emitted.entries });

    const fired = Object.entries(recovery).filter(([k, v]) => k !== "visualChannel" && v).map(([k]) => k);
    console.log(`\n  recovery branches fired: ${fired.length ? fired.join(", ") : "none (happy path)"}`);
    for (const w of validation.warnings) console.log(`  ⚠ ${w}`);
    if (!validation.ok) {
      console.error(`\n✗ Emitted artifact FAILED self-validation:`);
      for (const e of validation.errors) console.error(`  - ${e}`);
      process.exitCode = 1;
      return;
    }
    console.log(`  ✓ artifact self-validated against contract v${CURRENT_ARTIFACT_VERSION}`);
    console.log(`\n✓ Done in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${path.join(dsDir, "tokens.json")}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("\n✗ Extraction failed:", e);
  process.exit(1);
});
