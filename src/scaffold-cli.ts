// SCAFFOLD — a ready-to-code Next.js + Tailwind + TS workspace wired to one reference's design system.
// No model call.
//
//   npx tsx src/scaffold-cli.ts <output/<host>> <workspace>
//
// Copies templates/next-tailwind, wires tokens/fonts/assets into design/ (tailwind.config reads them, so every
// value comes from the tokens), copies the reference's OUTLINE.md + section crops into design/ for the agents,
// and links node_modules to ONE shared install (templates/.deps) so a build never re-downloads Next (~200MB).
import { cp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadArtifact } from "./artifact/load.js";
import { copyTemplate, wireDesignSystem } from "./builder/scaffold.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = path.join(ROOT, "templates", "next-tailwind");
const DEPS = path.join(ROOT, "templates", ".deps");

/** One shared node_modules for every build: installed once, symlinked into each workspace. */
export function ensureSharedDeps(): string {
  const nm = path.join(DEPS, "node_modules");
  if (existsSync(path.join(nm, "next"))) return nm;
  console.log("  installing shared deps (first run only)…");
  spawnSync("mkdir", ["-p", DEPS]);
  spawnSync("cp", [path.join(TEMPLATE, "package.json"), DEPS]);
  const r = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: DEPS, stdio: "inherit" });
  if (r.status !== 0) throw new Error("shared npm install failed");
  return nm;
}

export async function scaffold(refDir: string, workspace: string): Promise<void> {
  const ds = loadArtifact(path.join(refDir, "design-system"));
  // Keep anything the agents already wrote at the workspace root (DESIGN.md) across a re-scaffold.
  const keep: Record<string, string> = {};
  for (const f of ["DESIGN.md"]) if (existsSync(path.join(workspace, f))) keep[f] = await readFile(path.join(workspace, f), "utf8");

  await copyTemplate(workspace);
  await wireDesignSystem(workspace, ds);
  for (const [f, c] of Object.entries(keep)) await writeFile(path.join(workspace, f), c);

  // Static export → verify-site and the user's preview can serve plain files; no server runtime needed.
  await writeFile(path.join(workspace, "next.config.js"),
    `/** @type {import('next').NextConfig} */\nmodule.exports = { reactStrictMode: true, output: "export", images: { unoptimized: true } };\n`);
  // Fonts/assets must be reachable at runtime: mirror design/assets under public/.
  await mkdir(path.join(workspace, "public"), { recursive: true });
  await cp(path.join(workspace, "design", "assets"), path.join(workspace, "public", "assets"), { recursive: true }).catch(() => {});

  // The agents' digests: the section map + crops + the reference's spec/recipes.
  const d = path.join(workspace, "design");
  if (existsSync(path.join(refDir, "OUTLINE.md"))) await cp(path.join(refDir, "OUTLINE.md"), path.join(d, "OUTLINE.md"));
  if (existsSync(path.join(refDir, "outline"))) await cp(path.join(refDir, "outline"), path.join(d, "outline"), { recursive: true });
  await cp(path.join(ds.dir, "SPEC.md"), path.join(d, "SPEC.md")).catch(() => {});

  const host = path.basename(path.resolve(refDir));
  await writeFile(path.join(workspace, ".atelier.json"), JSON.stringify({ ref: "https://" + host, refDir: path.resolve(refDir), scaffoldedAt: new Date().toISOString() }, null, 2) + "\n");

  const nm = ensureSharedDeps();
  await rm(path.join(workspace, "node_modules"), { recursive: true, force: true });
  await symlink(nm, path.join(workspace, "node_modules"), "dir");
}

async function main() {
  const [refDir, workspace] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!refDir || !workspace) { console.error("Usage: tsx src/scaffold-cli.ts <output/<host>> <workspace>"); process.exit(1); }
  await scaffold(refDir, workspace);
  console.log(`✓ scaffolded ${workspace} from ${refDir}`);
  console.log(`  tokens: ${workspace}/design/tailwind.tokens.js (Tailwind theme) · recipes: design/components.md · map: design/OUTLINE.md`);
  console.log(`  write: app/page.tsx + components/*.tsx · build: npm --prefix ${workspace} run build`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("✗ scaffold failed:", e.message ?? e); process.exit(1); });
}
