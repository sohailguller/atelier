// Artifact-contract tests: a valid folder passes; specific injected gaps fail with specific
// messages; loadArtifact round-trips a valid folder and throws on an invalid one.
// Run: npx tsx test/artifact.test.ts
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateArtifact } from "../src/artifact/validate.js";
import { loadArtifact } from "../src/artifact/load.js";

let passed = 0;
const cleanup: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

const VALID_TOKENS = {
  color: { bg: "#08090a", surface: "#0f1011", accent: "#e5e5e6", text: "#f7f8f8", muted: "#8a8f98", border: "#141516" },
  font: { display: "Test Sans", ui: "Test Sans" },
  type: {
    body: { size: 16, line: 24, weight: 400, tracking: 0, case: "none" },
    h1: { size: 48, line: 52, weight: 600, tracking: -1, case: "none" },
    h2: { size: 32, line: 36, weight: 600, tracking: -0.5, case: "none" },
  },
  space: [4, 8, 16, 24],
  radius: [0, 8],
  shadow: { sm: "0 1px 2px rgba(0,0,0,.1)" },
  breakpoints: { sm: 640, md: 768 },
  layout: { containerMaxWidth: 1200, gutter: 24, contentWidthRatio: 0.83, sectionSpacing: 96, density: 0.35, heroViewportRatio: 0.8, grid: { columns: 3, gutter: 32 }, headlineAlign: "left" },
};

function makeValidFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "atelier-art-"));
  cleanup.push(dir);
  for (const sub of ["fonts", "assets", "screenshots"]) mkdirSync(path.join(dir, sub));
  writeFileSync(path.join(dir, "tokens.json"), JSON.stringify(VALID_TOKENS, null, 2));
  writeFileSync(path.join(dir, "tailwind.tokens.js"), `module.exports = ${JSON.stringify({ colors: VALID_TOKENS.color })};\n`);
  writeFileSync(path.join(dir, "fonts.css"), `@font-face{font-family:'Test Sans';src:url('./fonts/TestSans.woff2') format('woff2');font-weight:100 900;}`);
  writeFileSync(path.join(dir, "fonts", "TestSans.woff2"), Buffer.from("wOF2" + "0".repeat(40)));
  writeFileSync(path.join(dir, "assets", "mark.svg"), `<svg xmlns="http://www.w3.org/2000/svg"></svg>`);
  writeFileSync(path.join(dir, "components.md"), "# recipes\n");
  writeFileSync(path.join(dir, "SPEC.md"), "# spec\n");
  writeFileSync(path.join(dir, "screenshots", "desktop.png"), "PNGDATA");
  const manifest = {
    artifactVersion: "1.0",
    source: "https://example.com",
    extractedAt: new Date().toISOString(),
    visualChannel: true,
    recovery: { visualChannel: true, spacingInferred: false, radiusFlat: false, shadowSynthesized: false, shadowNone: false, accentFallback: false, breakpointsFallback: false },
    files: { tokens: "tokens.json", tailwind: "tailwind.tokens.js", fontsCss: "fonts.css", components: "components.md", spec: "SPEC.md", fonts: ["TestSans.woff2"], assets: ["mark.svg"], screenshots: ["desktop.png"] },
  };
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

/** Rewrite one JSON file inside a fixture via a mutator. */
function editJson(dir: string, file: string, mutate: (o: any) => void): void {
  const p = path.join(dir, file);
  const o = JSON.parse(readFileSync(p, "utf8"));
  mutate(o);
  writeFileSync(p, JSON.stringify(o, null, 2));
}

console.log("\nArtifact-contract self-test\n");

check("valid fixture passes with no errors", () => {
  const dir = makeValidFixture();
  const r = validateArtifact(dir);
  assert.ok(r.ok, `expected valid, got errors: ${r.errors.join("; ")}`);
  assert.strictEqual(r.warnings.length, 0, `unexpected warnings: ${r.warnings.join("; ")}`);
});

check("missing required color role (accent) fails with a schema error", () => {
  const dir = makeValidFixture();
  editJson(dir, "tokens.json", (t) => delete t.color.accent);
  const r = validateArtifact(dir);
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => e.includes("tokens.json") && e.includes("accent")), `errors: ${r.errors.join("; ")}`);
});

check("too-short space scale fails", () => {
  const dir = makeValidFixture();
  editJson(dir, "tokens.json", (t) => (t.space = [8]));
  const r = validateArtifact(dir);
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => e.includes("space")), `errors: ${r.errors.join("; ")}`);
});

check("dead font reference (fonts.css points at a missing file) fails", () => {
  const dir = makeValidFixture();
  rmSync(path.join(dir, "fonts", "TestSans.woff2"));
  const r = validateArtifact(dir);
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => e.includes("missing font file")), `errors: ${r.errors.join("; ")}`);
});

check("manifest listing a phantom asset fails", () => {
  const dir = makeValidFixture();
  editJson(dir, "manifest.json", (m) => m.files.assets.push("ghost.svg"));
  const r = validateArtifact(dir);
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => e.includes("ghost.svg")), `errors: ${r.errors.join("; ")}`);
});

check("incompatible artifactVersion fails", () => {
  const dir = makeValidFixture();
  editJson(dir, "manifest.json", (m) => (m.artifactVersion = "2.0"));
  const r = validateArtifact(dir);
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => e.includes("incompatible")), `errors: ${r.errors.join("; ")}`);
});

check("visualChannel=true with no screenshots fails", () => {
  const dir = makeValidFixture();
  rmSync(path.join(dir, "screenshots", "desktop.png"));
  editJson(dir, "manifest.json", (m) => (m.files.screenshots = []));
  const r = validateArtifact(dir);
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => e.includes("no screenshots")), `errors: ${r.errors.join("; ")}`);
});

check("visual-channel-down is OK when documented by screenshots/README.md", () => {
  const dir = makeValidFixture();
  rmSync(path.join(dir, "screenshots", "desktop.png"));
  writeFileSync(path.join(dir, "screenshots", "README.md"), "visual channel down");
  editJson(dir, "manifest.json", (m) => { m.visualChannel = false; m.files.screenshots = []; });
  const r = validateArtifact(dir);
  assert.ok(r.ok, `expected valid, got: ${r.errors.join("; ")}`);
});

check("font family with no @font-face produces a warning (not an error)", () => {
  const dir = makeValidFixture();
  editJson(dir, "tokens.json", (t) => (t.font.mono = "Ghost Mono"));
  const r = validateArtifact(dir);
  assert.ok(r.ok, "missing @font-face should warn, not error");
  assert.ok(r.warnings.some((w) => w.includes("Ghost Mono")), `warnings: ${r.warnings.join("; ")}`);
});

check("loadArtifact returns a typed, path-resolved DesignSystem", () => {
  const dir = makeValidFixture();
  const ds = loadArtifact(dir);
  assert.strictEqual(ds.tokens.color.accent, "#e5e5e6");
  assert.strictEqual(ds.tokens.font.display, "Test Sans");
  assert.strictEqual(ds.fontFiles.length, 1);
  assert.ok(path.isAbsolute(ds.fontFiles[0]) && existsSync(ds.fontFiles[0]), "font path must be absolute + exist");
  assert.ok(ds.fontsCssPath && path.isAbsolute(ds.fontsCssPath));
  assert.strictEqual(ds.manifest.source, "https://example.com");
});

check("loadArtifact throws on an invalid folder", () => {
  const dir = makeValidFixture();
  editJson(dir, "tokens.json", (t) => delete t.color.bg);
  assert.throws(() => loadArtifact(dir), /Invalid design-system artifact/);
});

// ---- v1.2 component group ---------------------------------------------------
/** Add a valid extracted-widget entry (HTML file + one asset) to a fixture. */
function addComponent(dir: string): void {
  mkdirSync(path.join(dir, "components", "assets"), { recursive: true });
  writeFileSync(path.join(dir, "components", "hero-widget.html"), `<div style="width:800px"><span>Inbox</span><img src="./assets/x.svg" alt=""></div>`);
  writeFileSync(path.join(dir, "components", "assets", "x.svg"), `<svg xmlns="http://www.w3.org/2000/svg"></svg>`);
  editJson(dir, "manifest.json", (m) => {
    m.components = [
      { id: "hero-widget", role: "hero-widget", file: "hero-widget.html", width: 800, height: 500, nodes: 3, bg: "#08090a", slots: ["Inbox"], assets: ["x.svg"] },
    ];
  });
}

check("valid component group passes + loadArtifact resolves it", () => {
  const dir = makeValidFixture();
  addComponent(dir);
  const r = validateArtifact(dir);
  assert.ok(r.ok, `expected valid, got: ${r.errors.join("; ")}`);
  const ds = loadArtifact(dir);
  assert.strictEqual(ds.components.length, 1);
  assert.ok(path.isAbsolute(ds.components[0].htmlPath) && existsSync(ds.components[0].htmlPath));
  assert.strictEqual(ds.components[0].assetPaths.length, 1);
});

check("component with a missing HTML file fails", () => {
  const dir = makeValidFixture();
  addComponent(dir);
  rmSync(path.join(dir, "components", "hero-widget.html"));
  const r = validateArtifact(dir);
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => e.includes("hero-widget")), `errors: ${r.errors.join("; ")}`);
});

check("component with an empty slot list fails schema", () => {
  const dir = makeValidFixture();
  addComponent(dir);
  editJson(dir, "manifest.json", (m) => (m.components[0].slots = []));
  const r = validateArtifact(dir);
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => e.includes("slot")), `errors: ${r.errors.join("; ")}`);
});

check("component referencing a live remote URL warns", () => {
  const dir = makeValidFixture();
  addComponent(dir);
  writeFileSync(path.join(dir, "components", "hero-widget.html"), `<div style="background-image:url(https://cdn.example.com/a.png)"><span>Inbox</span></div>`);
  const r = validateArtifact(dir);
  assert.ok(r.ok, `expected valid (warning only), got: ${r.errors.join("; ")}`);
  assert.ok(r.warnings.some((w) => w.includes("remote asset")), `warnings: ${r.warnings.join("; ")}`);
});

// Integration: if a real extractor output exists, it must satisfy the contract too.
const liveDir = path.join(process.cwd(), "output", "linear.app", "design-system");
if (existsSync(liveDir)) {
  check("live linear.app output satisfies the contract", () => {
    const r = validateArtifact(liveDir);
    assert.ok(r.ok, `live output invalid: ${r.errors.join("; ")}`);
  });
}

for (const d of cleanup) rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} checks passed${process.exitCode ? " (with failures above)" : ""}\n`);
