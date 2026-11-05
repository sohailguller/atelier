// Multi-site SYNTHESIS (build-guide §9 multi-site test). Combine N extracted design systems into
// ONE original, internally-coherent design-system/ artifact — the same contract the extractor emits,
// so the existing build loop consumes it unchanged.
//
//   npx tsx src/synthesize.ts <ds-dir> <ds-dir> [<ds-dir>...] --out <dir> [--polarity dark|light] [--name <n>]
//
// Method (see the synthesis logic recorded with the user): synthesize WITHIN a category; coherence
// over completeness; never fabricate a value. IDENTITY tokens (polarity/palette, radius, elevation)
// come from ONE coherent base — never merged. COMPOSABLE tokens combine across sources with guards:
// spacing = union of the (4/8-compatible) ladders; the font PAIRING is assembled from real binaries
// across references (e.g. a serif display from one, sans UI + mono from another); accent stays
// grounded (the most usable extracted fallback — never an invented brand colour).
import { readFileSync, existsSync } from "node:fs";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { loadArtifact, type DesignSystem } from "./artifact/load.js";
import { tailwindFragment } from "./emit.js";
import { validateArtifact } from "./artifact/validate.js";
import { CURRENT_ARTIFACT_VERSION, type Manifest, type Tokens, type ComponentEntry } from "./artifact/schema.js";
import { parseColor, luminance } from "./util.js";

const SERIF = /serif|plex serif|georgia|times|garamond|fraunces|playfair|lora|source serif|noto serif/i;

// ---- seeded variation ------------------------------------------------------
// Deterministic PRNG so a run is reproducible from its seed (logged in SPEC), but different seeds
// produce a FAMILY of coherent looks — the category never renders one repeated template.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rank-weighted pick from a best→worst sorted list: favors the top candidate but doesn't always
 *  take it, so assignments rotate run-to-run while staying inside the FEASIBLE set (never junk).
 *  Scale-independent (weights by rank, not raw score). k caps how deep it will reach. */
function pick<T>(sortedBestFirst: T[], rng: () => number, k = 3): T {
  const n = Math.min(k, sortedBestFirst.length);
  if (n <= 1) return sortedBestFirst[0];
  const weights = Array.from({ length: n }, (_, i) => n - i); // [n, n-1, …, 1]
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < n; i++) {
    r -= weights[i];
    if (r <= 0) return sortedBestFirst[i];
  }
  return sortedBestFirst[0];
}

/** Seeded Fisher–Yates so section-visual assignment order also rotates run-to-run. */
function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

interface Source {
  ds: DesignSystem;
  host: string;
  familyFiles: Map<string, string[]>; // @font-face family -> downloaded file names (self-hosted only)
}

/** Parse a design system's fonts.css into family -> [file] so we know which families are self-hosted. */
function familyFilesFromCss(cssPath: string | null): Map<string, string[]> {
  const m = new Map<string, string[]>();
  if (!cssPath || !existsSync(cssPath)) return m;
  const css = readFileSync(cssPath, "utf8");
  for (const block of css.split("@font-face").slice(1)) {
    const fam = block.match(/font-family:\s*['"]([^'"]+)['"]/);
    const url = block.match(/url\(\s*['"]?\.\/fonts\/([^'")]+)['"]?\s*\)/);
    if (fam && url) {
      const arr = m.get(fam[1]) ?? [];
      if (!arr.includes(url[1])) arr.push(url[1]);
      m.set(fam[1], arr);
    }
  }
  return m;
}

const isDark = (ds: DesignSystem) => luminance(parseColor(ds.tokens.color.bg)!) < 0.5;

/** Rank same-polarity sources for the identity base: cleanest + most-complete extraction wins. */
function baseScore(s: Source): number {
  let sc = 0;
  if (s.familyFiles.size) sc += 2; // has self-hosted fonts at all
  if (s.familyFiles.has(s.ds.tokens.font.display)) sc += 1; // display is self-hosted
  if (s.familyFiles.has(s.ds.tokens.font.ui)) sc += 1; // ui is self-hosted (Railway's Inter is NOT)
  sc += s.ds.tokens.space.length * 0.1; // wider spacing coverage
  const flags = Object.entries(s.ds.manifest.recovery).filter(([k, v]) => k !== "visualChannel" && v).length;
  sc -= flags * 0.5; // fewer recovery fallbacks = more faithful
  return sc;
}

interface FontPick {
  family: string;
  from: Source;
  files: string[];
}

interface Synthesis {
  tokens: Tokens;
  base: Source; // identity base (colour/mood source) — supplies component recipes
  componentBase: Source; // source whose hero product-UI widget leads (may differ from the mood base)
  componentPool: Array<{ from: Source; comp: Source["ds"]["components"][number] }>; // same-polarity widgets, all sources
  fonts: FontPick[];
  provenance: Record<string, string>;
  contributors: string[];
  seed: number;
}

/** Resolve a font family to real files: prefer the source that declares it; else the same
 *  typeface self-hosted elsewhere (Inter → Linear's "Inter Variable"); else a system stack. */
function resolveFamily(family: string, preferred: Source, all: Source[]): { family: string; files: string[]; from: Source } | null {
  if (preferred.familyFiles.has(family)) return { family, files: preferred.familyFiles.get(family)!, from: preferred };
  const base = family.split(/\s+/)[0].toLowerCase();
  for (const s of all) for (const [fam, files] of s.familyFiles) {
    if (fam.toLowerCase().startsWith(base)) return { family: fam, files, from: s };
  }
  if (/mono|monospace|system|ui-|serif|sans/i.test(family)) return { family, files: [], from: preferred }; // system stack, no file
  return null;
}

function synthesize(sources: Source[], polarity: "dark" | "light", seed: number): Synthesis {
  const rng = mulberry32(seed);
  const wantDark = polarity === "dark";
  const samePol = sources.filter((s) => isDark(s.ds) === wantDark);
  const pool = samePol.length ? samePol : sources;

  // The unit of assignment is the finest-grained INDEPENDENT dimension: split when axes are truly
  // independent (horizontal vs vertical spacing; type vs colour), keep intact only when splitting
  // would break a coherent whole (a font pairing). Each dimension goes to a strong source for it —
  // but chosen by SEEDED rank-weighted sampling, not always the argmax, so different seeds rotate
  // which reference owns which dimension → a family of coherent looks, not one repeated template.
  const colorSrc = pick([...pool].sort((a, b) => baseScore(b) - baseScore(a)), rng); // colour/mood + radius + elevation + micro-spacing
  const vertSrc = pick([...pool].sort((a, b) => b.ds.tokens.layout.sectionSpacing - a.ds.tokens.layout.sectionSpacing), rng); // generous VERTICAL rhythm
  const horizSrc = pick([...sources].sort((a, b) => a.ds.tokens.layout.density - b.ds.tokens.layout.density), rng); // confident HORIZONTAL composition
  // TYPOGRAPHY (intact pairing): serif-display sources rank first (more distinctive), but any source
  // with a self-hosted display is feasible — sampled so type isn't always the same face.
  const typeCands = [...sources]
    .filter((s) => s.familyFiles.has(s.ds.tokens.font.display) || SERIF.test(s.ds.tokens.font.display))
    .sort((a, b) => (SERIF.test(b.ds.tokens.font.display) ? 1 : 0) - (SERIF.test(a.ds.tokens.font.display) ? 1 : 0));
  const typeSrc = typeCands.length ? pick(typeCands, rng) : colorSrc;

  // Typography pairing, intact from typeSrc — real files resolved (Inter binary may come from another source).
  const display = resolveFamily(typeSrc.ds.tokens.font.display, typeSrc, sources);
  const ui = resolveFamily(typeSrc.ds.tokens.font.ui, typeSrc, sources);
  const mono = typeSrc.ds.tokens.font.mono ? resolveFamily(typeSrc.ds.tokens.font.mono, typeSrc, sources) : null;
  const font: Tokens["font"] = { display: display?.family ?? typeSrc.ds.tokens.font.display, ui: ui?.family ?? typeSrc.ds.tokens.font.ui };
  if (mono) font.mono = mono.family;

  const hl = horizSrc.ds.tokens.layout;
  const tokens: Tokens = {
    color: colorSrc.ds.tokens.color, // colour/mood — one source, never merged
    // Gradients + the colour-restraint ratio belong to the MOOD source: they are the same decision as
    // the palette (how dimensional the surfaces are, and how sparingly colour is allowed to appear).
    effects: colorSrc.ds.tokens.effects,
    radius: colorSrc.ds.tokens.radius, // ONE policy — mixing radii is a vibe-coded tell
    shadow: colorSrc.ds.tokens.shadow, // one elevation
    breakpoints: colorSrc.ds.tokens.breakpoints,
    space: colorSrc.ds.tokens.space, // micro-spacing scale
    type: typeSrc.ds.tokens.type, // ramp intact from the typography source (tuned to its own serif)
    font,
    layout: {
      // horizontal composition + vertical rhythm are INDEPENDENT axes → each from its best source
      containerMaxWidth: hl.containerMaxWidth,
      gutter: hl.gutter,
      contentWidthRatio: hl.contentWidthRatio,
      grid: hl.grid,
      headlineAlign: hl.headlineAlign,
      heroViewportRatio: hl.heroViewportRatio,
      density: hl.density,
      sectionSpacing: vertSrc.ds.tokens.layout.sectionSpacing, // vertical rhythm from the roomiest source
    },
  };

  const fonts: FontPick[] = [];
  for (const fp of [display, ui, mono]) {
    if (fp && fp.files.length && !fonts.some((f) => f.family === fp.family)) fonts.push(fp);
  }

  // ---- components (multi-source, ANY polarity — they get RECOLOURED) ------
  // Widgets used to be restricted to same-polarity sources, because an extracted widget carries its
  // source's colours inlined and a light widget would clash on a dark page. That restriction is what
  // welded the output to one site: the richest component came from Linear, so the palette had to stay
  // Linear's too, and every build read as Linear.
  //
  // `src/builder/recolor.ts` removes that constraint — a widget is remapped onto the synthesized
  // palette at build time (per-property, contrast-from-ground, so it inverts across polarities and
  // keeps semantic reds/greens). So ANY source's widgets may now join the pool, and which reference
  // leads the product visuals genuinely rotates run to run.
  const compSources = sources.filter((s) => s.ds.components.length > 0);
  const componentBase = compSources.length
    ? pick([...compSources].sort((a, b) => b.ds.components.length - a.ds.components.length), rng)
    : colorSrc;
  // Section-visual pool = the base's widgets first (hero leads), then every OTHER same-polarity
  // source's widgets, shuffled so section assignment varies. Deduped by source+id.
  const seen = new Set<string>();
  const componentPool: Synthesis["componentPool"] = [];
  const pushComps = (s: Source) => {
    for (const comp of s.ds.components) {
      const key = `${s.host}:${comp.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      componentPool.push({ from: s, comp });
    }
  };
  pushComps(componentBase);
  for (const s of shuffle(compSources.filter((s) => s !== componentBase), rng)) pushComps(s);

  const provenance: Record<string, string> = {
    "colour / mood + radius + elevation + micro-spacing": colorSrc.host,
    "vertical rhythm (sectionSpacing)": `${vertSrc.host} (${vertSrc.ds.tokens.layout.sectionSpacing}px)`,
    "horizontal composition (container/gutter/grid/align/hero)": `${horizSrc.host} (density ${hl.density})`,
    "typography (ramp + font pairing, intact)": typeSrc.host,
    "font.display": `${font.display} — ${display?.from.host ?? typeSrc.host}`,
    "font.ui": `${font.ui}${ui?.files.length ? " — " + ui.from.host + " (same typeface)" : ""}`,
    "font.mono": font.mono ? `${font.mono}${mono?.files.length ? " — " + mono.from.host : " (system)"}` : "(none)",
    accent: `${colorSrc.ds.tokens.color.accent} — grounded (${colorSrc.host} fallback); not fabricated`,
    "product widgets (hero leads)": `${componentBase.host} + ${[...new Set(componentPool.map((c) => c.from.host))].join(", ")} (${componentPool.length} surfaces)`,
  };

  const contributors = [...new Set([colorSrc.host, vertSrc.host, horizSrc.host, typeSrc.host, componentBase.host, ...fonts.map((f) => f.from.host)])];
  return { tokens, base: colorSrc, componentBase, componentPool, fonts, provenance, contributors, seed };
}

// ---------------------------------------------------------------------------
function synthFontCss(fonts: FontPick[]): string {
  const fmt: Record<string, string> = { woff2: "woff2", woff: "woff", ttf: "truetype", otf: "opentype" };
  const out = ["/* Synthesized @font-face rules — real font binaries assembled from multiple references. */", ""];
  for (const { family, files } of fonts) {
    for (const file of files) {
      const ext = (file.split(".").pop() || "woff2").toLowerCase();
      const variable = /variable|-var(\b|[._-])/i.test(file);
      out.push(
        `@font-face {`,
        `  font-family: '${family}';`,
        `  src: url('./fonts/${file}') format('${fmt[ext] ?? "woff2"}');`,
        `  font-weight: ${variable ? "100 900" : "400"};`,
        `  font-style: normal;`,
        `  font-display: swap;`,
        `}`,
        ""
      );
    }
  }
  return out.join("\n");
}

function synthSpec(syn: Synthesis, sources: Source[], polarity: string): string {
  const inert = sources.filter((s) => !syn.contributors.includes(s.host)).map((s) => s.host);
  const L: string[] = [];
  L.push(`# Synthesized Design System`, "");
  L.push(`- **Sources:** ${sources.map((s) => s.host).join(", ")}`);
  L.push(`- **Polarity:** ${polarity}`);
  L.push(`- **Identity base (colour/mood):** ${syn.base.host}`);
  L.push(`- **Seed:** \`${syn.seed}\` — re-run with \`--seed ${syn.seed}\` to reproduce this exact look; a different seed rotates the dimension→source assignment for a different-but-coherent look.`);
  L.push(`- **Synthesized:** ${new Date().toISOString()}`, "");
  L.push(`## Provenance (which reference each dimension came from)`, "");
  for (const [k, v] of Object.entries(syn.provenance)) L.push(`- **${k}:** ${v}`);
  L.push("");
  L.push(`## Notes`, "");
  L.push(
    `- The unit of assignment is the finest-grained INDEPENDENT dimension. Horizontal composition and ` +
      `vertical rhythm are independent axes, so each is taken from the source that owns it; typography is ` +
      `kept intact (a font pairing would break if split). Nothing is averaged.`
  );
  if (inert.length) {
    L.push(`- ${inert.join(", ")} did not win any dimension for this ${polarity} synthesis, but corroborates the shared grammar.`);
  }
  L.push(
    `- Accent is monochrome/grounded, not fabricated. This under-sells a truly source-faithful palette ` +
      `because a real brand accent (e.g. Railway's pink) is not yet extracted — see build-guide §4 known items.`
  );
  L.push("");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
function parseArgs(argv: string[]): { dirs: string[]; out: string; polarity: "dark" | "light"; name: string; seed: number } {
  const args = argv.slice(2);
  const dirs: string[] = [];
  let out = "./output/synthesized";
  let polarity: "dark" | "light" = "dark";
  let name = "synthesized";
  let seed = (Math.random() * 0xffffffff) >>> 0; // random per run; pass --seed to reproduce a look
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out") out = args[++i];
    else if (a === "--polarity") polarity = args[++i] === "light" ? "light" : "dark";
    else if (a === "--name") name = args[++i];
    else if (a === "--seed") seed = (parseInt(args[++i], 10) || 0) >>> 0;
    else if (!a.startsWith("--")) dirs.push(a);
  }
  if (dirs.length < 2) {
    console.error("Usage: tsx src/synthesize.ts <ds-dir> <ds-dir> [<ds-dir>...] --out <dir> [--polarity dark|light] [--name <n>] [--seed <n>]");
    process.exit(1);
  }
  return { dirs, out, polarity, name, seed };
}

function hostOf(ds: DesignSystem): string {
  try {
    return new URL(ds.manifest.source).hostname.replace(/^www\./, "");
  } catch {
    return ds.manifest.source;
  }
}

async function main() {
  const { dirs, out, polarity, name, seed } = parseArgs(process.argv);
  const dsDir = path.join(out, "design-system");

  const sources: Source[] = dirs.map((d) => {
    const ds = loadArtifact(d); // validated typed handoff — a bad folder never reaches synthesis
    return { ds, host: hostOf(ds), familyFiles: familyFilesFromCss(ds.fontsCssPath) };
  });

  console.log(`\n▸ Synthesizing ${sources.length} design systems (${polarity}, seed ${seed}) → ${dsDir}`);
  console.log(`  sources: ${sources.map((s) => `${s.host}${isDark(s.ds) ? " [dark]" : " [light]"} (${s.ds.components.length} widget${s.ds.components.length === 1 ? "" : "s"})`).join(", ")}`);

  const syn = synthesize(sources, polarity, seed);
  for (const [k, v] of Object.entries(syn.provenance)) console.log(`  ${k}: ${v}`);
  console.log(`  layout: container ${syn.tokens.layout.containerMaxWidth} · gutter ${syn.tokens.layout.gutter} · vRhythm ${syn.tokens.layout.sectionSpacing} · hero ${syn.tokens.layout.heroViewportRatio} · align ${syn.tokens.layout.headlineAlign}`);
  console.log(`  fonts: ${syn.fonts.map((f) => `${f.family}(${f.from.host}, ${f.files.length}f)`).join(", ")}`);

  // Emit the standard artifact.
  await mkdir(path.join(dsDir, "fonts"), { recursive: true });
  await mkdir(path.join(dsDir, "assets"), { recursive: true });
  await mkdir(path.join(dsDir, "screenshots"), { recursive: true });

  // Copy the chosen real font binaries in from their source design systems.
  const fontFiles: string[] = [];
  for (const f of syn.fonts) {
    for (const file of f.files) {
      await copyFile(path.join(f.from.ds.dir, "fonts", file), path.join(dsDir, "fonts", file));
      if (!fontFiles.includes(file)) fontFiles.push(file);
    }
  }

  await writeFile(path.join(dsDir, "tokens.json"), JSON.stringify(syn.tokens, null, 2) + "\n");
  await writeFile(path.join(dsDir, "tailwind.tokens.js"), tailwindFragment(syn.tokens));
  await writeFile(path.join(dsDir, "fonts.css"), synthFontCss(syn.fonts));
  await writeFile(
    path.join(dsDir, "components.md"),
    `# Signature Component Recipes (synthesized)\n\n` +
      `Button and card recipes are inherited from the identity base (${syn.base.host}); every value ` +
      `resolves through the synthesized \`tokens.json\`. The display font is a serif borrowed from another ` +
      `reference — headings use \`font-display\`, body/UI use \`font-ui\`.\n\n---\n\n` +
      syn.base.ds.componentsMd
  );

  const hostSlug = (h: string) => h.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
  await writeFile(path.join(dsDir, "SPEC.md"), synthSpec(syn, sources, polarity));
  await writeFile(
    path.join(dsDir, "screenshots", "README.md"),
    `# No screenshots\n\nThis is a SYNTHESIZED system with no single reference render. The critic ` +
      `stage should judge it against the synthesized tokens + component recipes, and against each source's ` +
      `screenshots (${sources.map((s) => s.host).join(", ")}).\n`
  );

  // Carry the MULTI-SOURCE, same-polarity product-UI widget pool through (§12 step 5 + variation).
  // The hero widget leads from the seeded componentBase; additional section visuals come from every
  // same-polarity source, so the site draws its rich visuals from more than one reference — not a
  // pure single-site clone. Files/assets are namespaced by source host to avoid collisions.
  const components: ComponentEntry[] = [];
  if (syn.componentPool.length) {
    const compDir = path.join(dsDir, "components");
    const assetDst = path.join(compDir, "assets");
    await mkdir(assetDst, { recursive: true });
    for (const { from, comp } of syn.componentPool) {
      const slug = hostSlug(from.host);
      const id = `${slug}-${comp.id}`;
      const file = `${id}.html`;
      // Rewrite this widget's asset refs to namespaced filenames so two sources' assets never clash.
      let html = readFileSync(comp.htmlPath, "utf8");
      const outAssets: string[] = [];
      for (const abs of comp.assetPaths) {
        const nsName = `${slug}-${path.basename(abs)}`;
        await copyFile(abs, path.join(assetDst, nsName));
        html = html.split(`./assets/${path.basename(abs)}`).join(`./assets/${nsName}`);
        outAssets.push(nsName);
      }
      await writeFile(path.join(compDir, file), html);
      components.push({
        id, role: comp.role, file, width: comp.width, height: comp.height,
        nodes: comp.nodes, bg: comp.bg, slots: comp.slots, assets: outAssets,
      });
    }
    const bySource = [...new Set(syn.componentPool.map((c) => c.from.host))];
    await writeFile(
      path.join(compDir, "README.md"),
      `# Extracted product-UI components (multi-source, carried through synthesis)\n\nHero leads from ` +
        `${syn.componentBase.host}; the section-visual pool spans same-polarity sources: ${bySource.join(", ")}. ` +
        `Each widget is self-contained; the builder repopulates its text with the user's content and places ` +
        `one per section (a different real screen each). Seed: ${seed}.\n`,
    );
    console.log(`  components: pooled ${components.length} widget(s) from ${bySource.join(", ")} (hero base: ${syn.componentBase.host})`);
  } else {
    console.log(`  components: no same-polarity source has extractable widgets`);
  }

  const manifest: Manifest = {
    artifactVersion: CURRENT_ARTIFACT_VERSION,
    source: `synthesized (${polarity}): ${sources.map((s) => s.host).join(" + ")}`,
    extractedAt: new Date().toISOString(),
    visualChannel: false, // synthesized — no rendered reference of its own
    recovery: { synthesized: true, monochromeAccent: true },
    files: {
      tokens: "tokens.json",
      tailwind: "tailwind.tokens.js",
      fontsCss: "fonts.css",
      components: "components.md",
      spec: "SPEC.md",
      fonts: fontFiles,
      assets: [],
      screenshots: [],
    },
    components,
  };
  await writeFile(path.join(dsDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const v = validateArtifact(dsDir);
  if (v.warnings.length) v.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
  if (!v.ok) {
    console.error(`\n✗ synthesized artifact FAILED contract validation:\n  - ${v.errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(`\n✓ synthesized artifact self-validated against contract v${CURRENT_ARTIFACT_VERSION}`);
  console.log(`  → ${dsDir}  (name: ${name})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
