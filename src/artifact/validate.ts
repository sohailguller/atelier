// Validate a design-system/ folder against the artifact contract (§5). This is what turns
// "the artifact is never left with silent gaps" from a convention into a mechanical guarantee:
// the extractor self-validates its own output, and any consumer (the builder) can trust a
// folder that passes. Errors block; warnings are advisory.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { TokensSchema, ManifestSchema, CURRENT_ARTIFACT_VERSION } from "./schema.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const majorOf = (v: string) => v.split(".")[0];

export function validateArtifact(dir: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rel = (...f: string[]) => path.join(dir, ...f);

  if (!existsSync(dir)) return { ok: false, errors: [`artifact directory does not exist: ${dir}`], warnings };

  // 1. Required files present.
  for (const f of ["tokens.json", "tailwind.tokens.js", "components.md", "SPEC.md", "manifest.json"]) {
    if (!existsSync(rel(f))) errors.push(`missing required file: ${f}`);
  }

  // 2. tokens.json parses and matches the schema (scales, required roles, no empties).
  let tokens: import("./schema.js").Tokens | null = null;
  if (existsSync(rel("tokens.json"))) {
    try {
      const parsed = TokensSchema.safeParse(JSON.parse(readFileSync(rel("tokens.json"), "utf8")));
      if (!parsed.success) for (const i of parsed.error.issues) errors.push(`tokens.json: ${i.path.join(".") || "(root)"} — ${i.message}`);
      else tokens = parsed.data;
    } catch (e) {
      errors.push(`tokens.json: not valid JSON (${(e as Error).message})`);
    }
  }

  // 3. manifest.json parses, matches schema, and is a compatible major version.
  let manifest: import("./schema.js").Manifest | null = null;
  if (existsSync(rel("manifest.json"))) {
    try {
      const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(rel("manifest.json"), "utf8")));
      if (!parsed.success) for (const i of parsed.error.issues) errors.push(`manifest.json: ${i.path.join(".") || "(root)"} — ${i.message}`);
      else {
        manifest = parsed.data;
        if (majorOf(manifest.artifactVersion) !== majorOf(CURRENT_ARTIFACT_VERSION)) {
          errors.push(`manifest.json: artifactVersion ${manifest.artifactVersion} is incompatible with this tool's ${CURRENT_ARTIFACT_VERSION}`);
        }
      }
    } catch (e) {
      errors.push(`manifest.json: not valid JSON (${(e as Error).message})`);
    }
  }

  // 4. No dead font references: every url(./fonts/X) in fonts.css must be a real file.
  if (existsSync(rel("fonts.css"))) {
    const css = readFileSync(rel("fonts.css"), "utf8");
    const refs = [...css.matchAll(/url\(['"]?\.\/fonts\/([^'")]+)['"]?\)/g)].map((m) => m[1]);
    if (refs.length === 0) warnings.push("fonts.css present but references no font files");
    for (const ref of refs) if (!existsSync(rel("fonts", ref))) errors.push(`fonts.css references a missing font file: fonts/${ref}`);
  }

  // 5. Each token font family should have an @font-face (else the builder can't actually use it).
  if (tokens && existsSync(rel("fonts.css"))) {
    const css = readFileSync(rel("fonts.css"), "utf8");
    for (const key of ["display", "ui", "mono"] as const) {
      const fam = tokens.font[key];
      if (fam && !css.includes(`'${fam}'`) && !css.includes(`"${fam}"`)) {
        warnings.push(`font.${key} "${fam}" has no @font-face in fonts.css (builder must supply it or fall back)`);
      }
    }
  }

  // 6. Manifest's file inventory must exist on disk (no phantom entries).
  if (manifest) {
    for (const f of manifest.files.fonts) if (!existsSync(rel("fonts", f))) errors.push(`manifest lists a missing font: fonts/${f}`);
    for (const a of manifest.files.assets) if (!existsSync(rel("assets", a))) errors.push(`manifest lists a missing asset: assets/${a}`);
    for (const s of manifest.files.screenshots) if (!existsSync(rel("screenshots", s))) errors.push(`manifest lists a missing screenshot: screenshots/${s}`);
    if (manifest.files.fontsCss && !existsSync(rel(manifest.files.fontsCss))) errors.push(`manifest lists fonts.css but it is missing`);
  }

  // 7. Screenshots present, OR the visual-channel-down gap is documented — never a silent empty dir.
  if (manifest) {
    const shotDir = rel("screenshots");
    const shots = existsSync(shotDir) ? readdirSync(shotDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)) : [];
    if (manifest.visualChannel && shots.length === 0) errors.push("manifest.visualChannel=true but no screenshots are present");
    if (!manifest.visualChannel && shots.length === 0 && !existsSync(path.join(shotDir, "README.md"))) {
      errors.push("visual channel was down but screenshots/README.md documenting the gap is missing");
    }
  }

  // 8. Tailwind fragment stays consistent with tokens.json (colors carried through).
  if (tokens && existsSync(rel("tailwind.tokens.js"))) {
    const tw = readFileSync(rel("tailwind.tokens.js"), "utf8");
    for (const [role, value] of Object.entries(tokens.color)) {
      if (!tw.includes(value)) warnings.push(`tailwind.tokens.js does not carry color.${role} (${value})`);
    }
  }

  // 9. Component group (v1.2): every listed widget's HTML + its assets must exist on disk, and the
  //    markup must not reference an asset URL that wasn't downloaded (no dead widget refs).
  if (manifest) {
    for (const c of manifest.components) {
      const html = rel("components", c.file);
      if (!existsSync(html)) {
        errors.push(`component "${c.id}" lists ${c.file} but it is missing from components/`);
        continue;
      }
      for (const a of c.assets) {
        if (!existsSync(rel("components", "assets", a))) errors.push(`component "${c.id}" references a missing asset: components/assets/${a}`);
      }
      // No live http(s) url() or img src should survive emit — they should be rewritten to ./assets/….
      const markup = readFileSync(html, "utf8");
      const liveBg = [...markup.matchAll(/url\(['"]?(https?:\/\/[^'")]+)['"]?\)/g)].map((m) => m[1]);
      const liveImg = [...markup.matchAll(/<img[^>]*\ssrc="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
      const live = [...liveBg, ...liveImg];
      if (live.length) warnings.push(`component "${c.id}" still references ${live.length} remote asset URL(s) (e.g. ${live[0].slice(0, 60)})`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
