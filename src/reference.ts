// REFERENCE — make one reference site ready for the designer, from cache when possible. No model call.
//
//   npx tsx src/reference.ts <url> [--fresh]
//
// Ensures output/<host>/{design-system, site, OUTLINE.md} exist and are < 30 days old: extract (tokens/fonts/
// assets/screenshots), clone (the faithful page the outline is read from), outline (the section map). A cached
// reference costs nothing, which is why builds should prefer references already on disk.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const OUT = "./output";
const MAX_AGE_DAYS = 30;

export function hostOf(u: string): string {
  try { return new URL(/^https?:\/\//.test(u) ? u : "https://" + u).hostname.replace(/^www\./, ""); } catch { return u; }
}

const fresh = (p: string) => existsSync(p) && (Date.now() - statSync(p).mtimeMs) / 86400000 < MAX_AGE_DAYS;

function step(label: string, args: string[]): boolean {
  const t0 = Date.now();
  process.stdout.write(`  ${label}… `);
  const r = spawnSync("npx", ["tsx", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 240_000 });
  const ok = r.status === 0;
  console.log(ok ? `done (${((Date.now() - t0) / 1000).toFixed(0)}s)` : `FAILED`);
  if (!ok) console.log((r.stderr || r.stdout || "").split("\n").filter(Boolean).slice(-4).map((l) => "    " + l).join("\n"));
  return ok;
}

export function summary(dir: string): string {
  const lines: string[] = [];
  try {
    const t = JSON.parse(readFileSync(path.join(dir, "design-system", "tokens.json"), "utf8"));
    const c = t.color ?? {};
    lines.push(`  fonts: display "${t.font?.display}" · ui "${t.font?.ui}"${t.font?.mono ? ` · mono "${t.font.mono}"` : ""}`);
    lines.push(`  colors: ${Object.entries(c).slice(0, 7).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  } catch { /* tokens optional in summary */ }
  try {
    const o = JSON.parse(readFileSync(path.join(dir, "outline.json"), "utf8"));
    lines.push(`  sections: ${o.sections.map((s: any) => `${s.role}/${s.layout}`).join(" → ")}`);
  } catch { /* no outline */ }
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith("--"));
  const force = args.includes("--fresh");
  if (!url) { console.error("Usage: tsx src/reference.ts <url> [--fresh]"); process.exit(1); }
  const host = hostOf(url);
  const full = "https://" + host;
  const dir = path.join(OUT, host);
  const ds = path.join(dir, "design-system", "manifest.json");
  const site = path.join(dir, "site", "index.html");
  const outline = path.join(dir, "outline.json");

  console.log(`▸ ${host}`);
  let ok = true;
  if (force || !fresh(ds)) ok = step("extracting design system", ["src/extract.ts", full, "--out", OUT]) && ok;
  else console.log("  design system: cached");
  if (force || !fresh(site)) ok = step("cloning page", ["src/clone.ts", full, "--out", OUT]) && ok;
  else console.log("  clone: cached");
  if (existsSync(site) && (force || !fresh(outline) || statSync(outline).mtimeMs < statSync(site).mtimeMs)) ok = step("outlining sections", ["src/outline.ts", dir]) && ok;
  else if (existsSync(outline)) console.log("  outline: cached");

  if (!existsSync(ds) || !existsSync(outline)) { console.log(`✗ ${host} is not usable as a reference`); process.exit(1); }
  console.log(`✓ ready: ${dir}`);
  console.log(`  read: ${dir}/OUTLINE.md · ${dir}/design-system/SPEC.md · ${dir}/design-system/components.md · ${dir}/design-system/tailwind.tokens.js`);
  console.log(summary(dir));
  process.exit(ok ? 0 : 2);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
