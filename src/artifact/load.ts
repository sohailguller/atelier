// Load a design-system/ folder into a typed, path-resolved object — the entry point a
// consumer (the builder subagent, step 3) uses to read the artifact. Validates first and
// throws on hard errors, so a returned DesignSystem is guaranteed complete and self-consistent.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { validateArtifact } from "./validate.js";
import { TokensSchema, ManifestSchema, type Tokens, type Manifest, type ComponentEntry } from "./schema.js";

/** A resolved extracted product-UI widget — absolute paths + the markup ready to repopulate. */
export interface LoadedComponent extends ComponentEntry {
  htmlPath: string; // absolute path to the widget's self-contained HTML
  assetPaths: string[]; // absolute paths to its downloaded assets
}

export interface DesignSystem {
  dir: string; // absolute
  tokens: Tokens;
  manifest: Manifest;
  fontsCssPath: string | null; // absolute, for @import
  fontFiles: string[]; // absolute
  assetFiles: string[]; // absolute
  screenshots: string[]; // absolute
  tailwindPath: string; // absolute path to the Tailwind theme fragment
  componentsMd: string; // signature component recipes (content)
  components: LoadedComponent[]; // v1.2 — extracted product-UI widgets (absolute paths resolved)
  spec: string; // provenance + recovery log (content)
  warnings: string[]; // non-fatal advisories from validation
}

/** Read + validate + resolve a design-system folder. Throws if it fails hard validation. */
export function loadArtifact(dir: string): DesignSystem {
  const result = validateArtifact(dir);
  if (!result.ok) {
    throw new Error(`Invalid design-system artifact at ${dir}:\n  - ${result.errors.join("\n  - ")}`);
  }
  const rel = (...f: string[]) => path.join(dir, ...f);
  const tokens = TokensSchema.parse(JSON.parse(readFileSync(rel("tokens.json"), "utf8")));
  const manifest = ManifestSchema.parse(JSON.parse(readFileSync(rel("manifest.json"), "utf8")));

  return {
    dir: path.resolve(dir),
    tokens,
    manifest,
    fontsCssPath: existsSync(rel("fonts.css")) ? path.resolve(rel("fonts.css")) : null,
    fontFiles: manifest.files.fonts.map((f) => path.resolve(rel("fonts", f))),
    assetFiles: manifest.files.assets.map((f) => path.resolve(rel("assets", f))),
    screenshots: manifest.files.screenshots.map((f) => path.resolve(rel("screenshots", f))),
    tailwindPath: path.resolve(rel("tailwind.tokens.js")),
    componentsMd: readFileSync(rel("components.md"), "utf8"),
    components: manifest.components.map((c) => ({
      ...c,
      htmlPath: path.resolve(rel("components", c.file)),
      assetPaths: c.assets.map((a) => path.resolve(rel("components", "assets", a))),
    })),
    spec: readFileSync(rel("SPEC.md"), "utf8"),
    warnings: result.warnings,
  };
}
