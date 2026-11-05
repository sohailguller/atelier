// Emit the self-contained design-system/ folder (build-guide §5).
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Tokens, RecoveryFlags, HealthCheck, RawMeasurements, AssetReport } from "./types.js";
import type { ComponentRecipes } from "./tokens.js";
import type { AssetResult } from "./assets.js";
import { CURRENT_ARTIFACT_VERSION, type Manifest } from "./artifact/schema.js";
import { validateArtifact } from "./artifact/validate.js";
import type { EmittedComponent } from "./components.js";

export interface EmitInput {
  url: string;
  dsDir: string;
  tokens: Tokens;
  recovery: RecoveryFlags;
  recipes: ComponentRecipes;
  notes: string[];
  health: HealthCheck;
  raw: RawMeasurements;
  assets: AssetResult;
  screenshots: string[];
  components: EmittedComponent[]; // v1.2 — extracted product-UI widgets (already written to components/)
}

export async function emit(input: EmitInput): Promise<ValidationOutcome> {
  const { dsDir, tokens } = input;
  await mkdir(dsDir, { recursive: true });
  await mkdir(path.join(dsDir, "screenshots"), { recursive: true });

  await writeFile(path.join(dsDir, "tokens.json"), JSON.stringify(tokens, null, 2) + "\n");
  await writeFile(path.join(dsDir, "tailwind.tokens.js"), tailwindFragment(tokens));
  await writeFile(path.join(dsDir, "components.md"), componentsDoc(input));
  await writeFile(path.join(dsDir, "SPEC.md"), specDoc(input));
  const css = fontFaceCss(tokens, input.assets.fontFiles);
  if (css) await writeFile(path.join(dsDir, "fonts.css"), css);

  // If the visual channel was down, leave a note in screenshots/ instead of blank files.
  if (input.screenshots.length === 0) {
    await writeFile(
      path.join(dsDir, "screenshots", "README.md"),
      `# No screenshots captured\n\nThe startup screenshot health check reported the visual channel as ` +
        `**down** (${input.health.reason}). Extraction ran on DOM measurement alone. ` +
        `The critic stage should reconstruct visual comparison from tokens + component recipes.\n`
    );
  }

  // Machine-readable manifest: version + provenance + a full file inventory the loader/validator use.
  const manifest: Manifest = {
    artifactVersion: CURRENT_ARTIFACT_VERSION,
    source: input.url,
    extractedAt: new Date().toISOString(),
    visualChannel: input.health.visualChannel,
    recovery: { ...input.recovery },
    files: {
      tokens: "tokens.json",
      tailwind: "tailwind.tokens.js",
      fontsCss: css ? "fonts.css" : null,
      components: "components.md",
      spec: "SPEC.md",
      fonts: input.assets.fontFiles,
      assets: input.assets.assetFiles,
      screenshots: input.screenshots,
    },
    components: input.components, // v1.2 widget inventory (files live under components/)
  };
  await writeFile(path.join(dsDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  // Self-validate: the producer refuses to declare success on an incomplete/inconsistent folder.
  const validation = validateArtifact(dsDir);
  return { ok: validation.ok, errors: validation.errors, warnings: validation.warnings };
}

export interface ValidationOutcome {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Generate @font-face rules mapping the downloaded woff2 files to their families, so the
// folder is actually USABLE — a builder can `@import './fonts.css'` and reference the family.
function fontFaceCss(t: Tokens, fontFiles: string[]): string {
  if (fontFiles.length === 0) return "";
  const fmt: Record<string, string> = { woff2: "woff2", woff: "woff", ttf: "truetype", otf: "opentype" };
  const rules: string[] = [
    "/* Auto-generated @font-face rules for the downloaded fonts. */",
    "/* Usage: import this file, then use the families named in tokens.json (font.display / font.ui / font.mono). */",
    "",
  ];
  for (const file of fontFiles) {
    const ext = (file.split(".").pop() || "woff2").toLowerCase();
    const isMono = /mono|berkeley|consol|courier|menlo/i.test(file);
    const isVariable = /variable|-var(\b|[._-])/i.test(file);
    const family = isMono && t.font.mono ? t.font.mono : t.font.display;
    rules.push(
      `@font-face {`,
      `  font-family: '${family}';`,
      `  src: url('./fonts/${file}') format('${fmt[ext] ?? "woff2"}');`,
      `  font-weight: ${isVariable ? "100 900" : "400"};`,
      `  font-style: normal;`,
      `  font-display: swap;`,
      `}`,
      ""
    );
  }
  return rules.join("\n");
}

// ---------------------------------------------------------------------------
// Exported so the synthesize step (src/synthesize.ts) emits an identical Tailwind fragment —
// the build template consumes the same shape whether the artifact came from one site or three.
export function tailwindFragment(t: Tokens): string {
  const spacing: Record<string, string> = {};
  t.space.forEach((n) => (spacing[String(n)] = `${n}px`));
  const radius: Record<string, string> = {};
  t.radius.forEach((n, i) => {
    const name = n === 0 ? "none" : n >= 9999 ? "full" : i === t.radius.length - 1 ? "lg" : `r${n}`;
    radius[name] = n >= 9999 ? "9999px" : `${n}px`;
  });
  // The FULL extracted type spec per role — not just size/line-height. Weight and tracking were
  // being dropped here, so `text-body`/`text-h1` applied a default weight and zero tracking and the
  // copy read generic no matter how faithfully the family was extracted. Tailwind supports the
  // 4-tuple form, so one `text-<role>` utility now carries size + leading + tracking + weight.
  const fontSize: Record<string, [string, { lineHeight: string; letterSpacing?: string; fontWeight?: string }]> = {};
  for (const [role, v] of Object.entries(t.type)) {
    const spec: { lineHeight: string; letterSpacing?: string; fontWeight?: string } = {
      lineHeight: `${v.line}px`,
      fontWeight: String(v.weight),
    };
    if (v.tracking) spec.letterSpacing = `${v.tracking}px`;
    fontSize[role] = [`${v.size}px`, spec];
  }
  const fontFamily: Record<string, string[]> = {
    display: [t.font.display, "sans-serif"],
    ui: [t.font.ui, "sans-serif"],
  };
  if (t.font.mono) fontFamily.mono = [t.font.mono, "ui-monospace", "monospace"];
  // Real extracted gradients as named utilities (bg-grad-surface-1, bg-grad-ambient) so the builder
  // can use the reference's actual dimensional fills without hand-writing an arbitrary value.
  const backgroundImage: Record<string, string> = {};
  let s = 0;
  let a = 0;
  for (const g of t.effects?.gradients ?? []) {
    const name =
      g.kind === "ambient" ? "grad-ambient"
      : g.kind === "text" ? "grad-text"
      : g.kind === "accent" ? `grad-accent-${++a}` // the RARE colourful fill
      : `grad-surface-${++s}`; // subtle monochrome depth
    if (!backgroundImage[name]) backgroundImage[name] = g.css;
  }

  const theme: Record<string, unknown> = {
    colors: t.color,
    fontFamily,
    fontSize,
    spacing,
    borderRadius: radius,
    boxShadow: t.shadow,
    screens: Object.fromEntries(Object.entries(t.breakpoints).map(([k, v]) => [k, `${v}px`])),
    // The measured content column, so the builder can `max-w-container` instead of guessing a width.
    maxWidth: { container: `${t.layout.containerMaxWidth}px` },
  };
  if (Object.keys(backgroundImage).length) theme.backgroundImage = backgroundImage;
  return (
    `// Auto-generated Tailwind theme fragment from tokens.json. Single source of truth.\n` +
    `// Drop into tailwind.config: { theme: { extend: require('./tailwind.tokens.js') } }\n` +
    `module.exports = ${JSON.stringify(theme, null, 2)};\n`
  );
}

// ---------------------------------------------------------------------------
function componentsDoc(input: EmitInput): string {
  const { recipes, tokens } = input;
  const lines: string[] = ["# Signature Component Recipes", ""];
  lines.push(`Derived from the reference's real computed styles. Values reference \`tokens.json\`.`, "");

  lines.push("## Primary button (CTA)", "");
  if (recipes.cta) {
    lines.push("```");
    for (const [k, v] of Object.entries(recipes.cta)) lines.push(`${k}: ${v}`);
    lines.push("```");
    lines.push("", "Reproduce the CTA with these exact values; keep the border-radius on the tokens' radius scale.", "");
  } else {
    lines.push("_No filled CTA button was captured on the reference page._", "");
  }

  lines.push("## Card / surface", "");
  lines.push("```");
  for (const [k, v] of Object.entries(recipes.card)) lines.push(`${k}: ${v}`);
  lines.push("```");
  lines.push("", "Use one elevation (`shadow.md`) for all cards; do not introduce new shadows.", "");

  lines.push("## Signature shapes (clip-path)", "");
  if (recipes.clipPathSignatures.length) {
    lines.push("The reference uses non-rectangular clip-paths. Reuse sparingly as accent shapes:", "```");
    recipes.clipPathSignatures.slice(0, 8).forEach((c) => lines.push(c));
    lines.push("```", "");
  } else {
    lines.push("_None detected — the reference relies on rectangular geometry._", "");
  }

  lines.push("## Type ramp", "", "| role | size | line | weight | tracking | case |", "|---|---|---|---|---|---|");
  for (const [role, v] of Object.entries(tokens.type)) {
    lines.push(`| ${role} | ${v.size}px | ${v.line}px | ${v.weight} | ${v.tracking} | ${v.case} |`);
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
function specDoc(input: EmitInput): string {
  const { url, tokens, recovery, notes, health, raw, assets, screenshots } = input;
  const firedRaw = Object.entries(recovery).filter(([k, v]) => k !== "visualChannel" && v === true);
  const L: string[] = [];
  L.push(`# Design System Spec`, "");
  L.push(`- **Source:** ${url}`);
  L.push(`- **Extracted:** ${new Date().toISOString()}`);
  L.push(`- **Visual channel:** ${health.visualChannel ? "UP (screenshots used)" : "DOWN (DOM measurement only)"} — ${health.reason}`);
  L.push(`- **Screenshot bytes (startup check):** ${health.screenshotBytes}`);
  L.push(`- **DOM:** ${raw.domStats.elementCount} elements, ${raw.domStats.textLength} chars of text`);
  L.push("");

  L.push(`## Recovery branches fired`, "");
  if (firedRaw.length === 0 && health.visualChannel) {
    L.push(`_Happy path — no recovery branch was needed._`, "");
  } else {
    if (!health.visualChannel) L.push(`- \`visual-channel\`: screenshot channel DOWN, ran on DOM measurement`);
    for (const [k] of firedRaw) L.push(`- \`${k}\``);
    L.push("");
  }
  if (notes.length) {
    L.push(`### Notes`, "");
    notes.forEach((n) => L.push(`- ${n}`));
    L.push("");
  }

  L.push(`## Token summary`, "");
  L.push("```json");
  L.push(JSON.stringify(tokens, null, 2));
  L.push("```", "");

  L.push(`## Fonts`, "");
  if (assets.fontFiles.length) {
    raw.fontFaces
      .filter((f) => f.family !== "(from-resource-timing)")
      .forEach((f) => L.push(`- **${f.family}** ${f.weight} ${f.style}`));
    L.push("", `Downloaded & verified: ${assets.fontFiles.map((f) => "`" + f + "`").join(", ")}`, "");
  } else {
    L.push(`_No font files were verified/downloaded._`, "");
  }

  L.push(`## Asset download report`, "");
  L.push(`| kind | source | saved | bytes | ok | reason |`);
  L.push(`|---|---|---|---|---|---|`);
  const shortUrl = (u: string) => (u.length > 60 ? u.slice(0, 57) + "…" : u);
  const report = assets.reports.length ? assets.reports : ([] as AssetReport[]);
  for (const r of report) {
    L.push(`| ${r.kind} | ${shortUrl(r.sourceUrl)} | ${r.savedAs ?? "—"} | ${r.bytes} | ${r.ok ? "✓" : "✗"} | ${r.reason} |`);
  }
  const okCount = report.filter((r) => r.ok).length;
  L.push("", `**${okCount}/${report.length} assets verified.** Failed URLs are dropped — no token points at a dead URL.`, "");

  L.push(`## Screenshots`, "");
  L.push(screenshots.length ? screenshots.map((s) => "`" + s + "`").join(", ") : "_none (visual channel down)_");
  L.push("");

  L.push(`## Provenance / how to use`, "");
  L.push(`This folder is the handoff interface between EXTRACT and BUILD. The builder receives`);
  L.push(`\`tokens.json\` + \`fonts/\` + \`components.md\` only — never the source's page structure —`);
  L.push(`and composes an original site whose every value comes from these scales.`);
  L.push("");
  return L.join("\n");
}
