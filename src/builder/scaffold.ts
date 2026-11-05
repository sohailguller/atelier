// Scaffolds a build workspace from the committed Next.js + Tailwind template, then wires the
// extracted design system into it as deterministic code — BEFORE the builder model runs. This
// is what makes "every value from tokens" structural rather than a request the model might
// ignore: tailwind.config.js reads design/tailwind.tokens.js, globals.css imports the real
// fonts, and the token JSON + component recipes sit in design/ for the builder to read.
import { cp, mkdir, writeFile, rm, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DesignSystem } from "../artifact/load.js";
import type { RepopulatedComponent } from "./repopulate.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// src/builder/ -> repo root -> templates/next-tailwind
const TEMPLATE_DIR = path.resolve(HERE, "..", "..", "templates", "next-tailwind");

/** Copy the base template into a fresh workspace dir (wiping any prior contents). */
export async function copyTemplate(workspace: string): Promise<void> {
  if (!existsSync(TEMPLATE_DIR)) {
    throw new Error(`Template not found at ${TEMPLATE_DIR}`);
  }
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); // tolerate a stale .next
  await mkdir(workspace, { recursive: true });
  // node_modules/.next never exist in the committed template, but guard anyway.
  await cp(TEMPLATE_DIR, workspace, {
    recursive: true,
    filter: (src) => !/(\/node_modules\/|\/\.next\/)/.test(src),
  });
}

/**
 * Wire a validated DesignSystem into the workspace's design/ folder so the template's
 * tailwind.config.js and globals.css resolve to real extracted values + fonts.
 */
export async function wireDesignSystem(workspace: string, ds: DesignSystem): Promise<void> {
  const design = path.join(workspace, "design");
  await mkdir(path.join(design, "fonts"), { recursive: true });
  await mkdir(path.join(design, "assets"), { recursive: true });

  // Tailwind theme fragment (the single source of truth the config requires).
  await copyFile(ds.tailwindPath, path.join(design, "tailwind.tokens.js"));

  // fonts.css maps @font-face -> the families named in tokens.json.
  if (ds.fontsCssPath) {
    await copyFile(ds.fontsCssPath, path.join(design, "fonts.css"));
  } else {
    // No downloaded fonts: emit an empty stylesheet so globals.css's @import still resolves.
    await writeFile(path.join(design, "fonts.css"), "/* No web fonts extracted. */\n");
  }

  // Real font + asset binaries (never dead url()s).
  for (const f of ds.fontFiles) {
    await copyFile(f, path.join(design, "fonts", path.basename(f)));
  }
  for (const a of ds.assetFiles) {
    await copyFile(a, path.join(design, "assets", path.basename(a)));
  }

  // Machine-readable tokens + human recipes for the builder to read.
  await writeFile(path.join(design, "tokens.json"), JSON.stringify(ds.tokens, null, 2) + "\n");
  await writeFile(path.join(design, "components.md"), ds.componentsMd);
}

export const PUBLIC_ASSET_PREFIX = "/component-assets";

/** id -> PascalCase React component name, e.g. "hero-widget" -> "HeroWidget". */
export function widgetComponentName(id: string): string {
  const base = id.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  return /^[A-Za-z]/.test(base) ? base : "Widget" + base;
}

/**
 * Wire the REPOPULATED product-UI widgets into the workspace as ready-to-embed React components
 * (build-guide §12 step 6). Their assets are served from /public/component-assets, and each widget
 * is emitted as a component that renders the reference-crafted markup verbatim (styling + structure
 * preserved 100%). The builder imports and PLACES these — it never rebuilds or restyles them.
 */
export async function wireExtractedComponents(
  workspace: string,
  ds: DesignSystem,
  repopulated: RepopulatedComponent[],
): Promise<{ names: { id: string; name: string; role: string; width: number; height: number }[] }> {
  const names: { id: string; name: string; role: string; width: number; height: number }[] = [];
  if (!repopulated.length) return { names };

  // Serve widget assets from public/ so the injected markup's url(/component-assets/…) resolves.
  const publicDir = path.join(workspace, "public", "component-assets");
  await mkdir(publicDir, { recursive: true });
  const byId = new Map(ds.components.map((c) => [c.id, c]));
  for (const r of repopulated) {
    const src = byId.get(r.id);
    if (!src) continue;
    for (const abs of src.assetPaths) await copyFile(abs, path.join(publicDir, path.basename(abs)));
  }

  const outDir = path.join(workspace, "components", "extracted");
  await mkdir(outDir, { recursive: true });

  // The faithful, responsive wrapper. Width-pinning is what preserves the extraction's fidelity
  // (no reflow), so we NEVER unpin it. Instead we render the widget at its native size and
  // transform:scale() it down to fit whatever column it lands in — the internals stay byte-for-byte
  // the reference's at any viewport (a faithful snapshot that fits, not a smoothed-out rebuild).
  await writeFile(
    path.join(outDir, "FaithfulWidget.tsx"),
    `"use client";
// AUTO-GENERATED. Renders an extracted product-UI widget at its native pinned size and scales it to
// fit the container width (never upscales past 1). Fidelity is 100% preserved — only the scale
// changes, never the layout. Do not edit.
import React, { useLayoutEffect, useRef, useState } from "react";

export function FaithfulWidget({ html, width, height, className }: { html: string; width: number; height: number; className?: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = outer.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const fit = () => setScale(Math.min(1, parent.clientWidth / width));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [width]);
  return (
    <div ref={outer} className={className} style={{ width: width * scale, height: height * scale, overflow: "hidden", maxWidth: "100%" }}>
      <div style={{ width, height, transformOrigin: "top left", transform: \`scale(\${scale})\`, flex: "0 0 auto" }} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
`,
  );

  // One generated module exporting a named component per widget, each backed by FaithfulWidget.
  const parts: string[] = [
    `// AUTO-GENERATED — real product-UI widgets extracted from the reference design system and`,
    `// repopulated with this product's content. The reference's structure + styling are preserved`,
    `// 100% (only text changed) and scaled to fit via FaithfulWidget. Import and PLACE these as each`,
    `// section's product visual; do NOT restyle or rebuild them. Fonts resolve via app/globals.css.`,
    `// Assets are served from ${PUBLIC_ASSET_PREFIX}/.`,
    `import React from "react";`,
    `import { FaithfulWidget } from "./FaithfulWidget";`,
    ``,
  ];
  for (const r of repopulated) {
    const name = widgetComponentName(r.id);
    names.push({ id: r.id, name, role: r.role, width: r.width, height: r.height });
    parts.push(
      `const ${name}_HTML = ${JSON.stringify(r.html)};`,
      `/** ${r.role} — ${r.width}×${r.height}px, extracted + repopulated; scales to fit its container. */`,
      `export function ${name}({ className }: { className?: string }) {`,
      `  return <FaithfulWidget html={${name}_HTML} width={${r.width}} height={${r.height}} className={className} />;`,
      `}`,
      ``,
    );
  }
  await writeFile(path.join(outDir, "widgets.tsx"), parts.join("\n"));
  return { names };
}

/**
 * Baseline (raw Claude Code control): no design system. Rewrite the two template files that
 * reference design/ so the workspace builds on stock Tailwind — the fair "no rails" comparison.
 */
export async function wirePlainBaseline(workspace: string): Promise<void> {
  await writeFile(
    path.join(workspace, "tailwind.config.js"),
    `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: [],
};
`,
  );
  await writeFile(
    path.join(workspace, "app", "globals.css"),
    `@tailwind base;
@tailwind components;
@tailwind utilities;
`,
  );
}
