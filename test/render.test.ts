// Rendered brand/content check — the PURE scoring core of src/render-audit.ts only (no browser, no model,
// no network), so the number the gate is built on can be regression-tested offline.
//
// The live calibration that set MARK_THRESHOLD ran against the clones in build/review:
//   FAIL  clerk   1.000 nav wordmark · 0.996 its mobile twin · 0.890 a "Powered by <Clerk>" badge in a mockup
//   PASS  linear  0.637 top score (avatars vs its 20×20 footer logomark) · supabase 0.192 · resend 0.098
// Reproduce with: npx tsx src/render-audit.ts build/review/<x>-clone --no-vision
// Run: npx tsx test/render.test.ts
import assert from "node:assert";
import { normalise, ncc, aspectClose, matchMarks, GRID_W, GRID_H, MARK_THRESHOLD, type Mark, type Graphic } from "../src/render-audit.js";

let passed = 0;
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

const N = GRID_W * GRID_H;
/** A deterministic "logo": a few bright bands over a dark field, plus a seeded wobble so it is not periodic. */
const logo = (seed: number) =>
  Array.from({ length: N }, (_, i) => {
    const x = i % GRID_W, y = Math.floor(i / GRID_W);
    const band = (x * 7 + y * 13 + seed * 31) % 17;
    return band < 4 ? 230 - band * 9 : 20 + ((x * seed) % 11);
  });
const invert = (g: number[]) => g.map((v) => 255 - v);
const jitter = (g: number[], amp = 6) => g.map((v, i) => Math.max(0, Math.min(255, v + ((i * 37 + 11) % (amp * 2)) - amp)));
const flat = (v = 128) => new Array(N).fill(v);

console.log("\nrender: normalise");

check("normalise returns a zero-mean, unit-variance vector", () => {
  const v = normalise(logo(1))!;
  assert.ok(v, "expected a vector");
  const mean = [...v].reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt([...v].reduce((a, b) => a + b * b, 0) / v.length);
  assert.ok(Math.abs(mean) < 1e-9, `mean ${mean} should be ~0`);
  assert.ok(Math.abs(sd - 1) < 1e-9, `sd ${sd} should be ~1`);
});

check("a FLAT crop normalises to null — a solid block correlates with anything", () => {
  assert.equal(normalise(flat()), null);
  assert.equal(normalise(flat(0)), null);
  assert.equal(normalise([]), null);
  assert.equal(normalise(null), null);
});

console.log("\nrender: ncc");

check("identical crops score 1", () => {
  const g = logo(2);
  assert.ok(ncc(normalise(g), normalise(g)) > 0.9999);
});

check("INVERTED crop still scores 1 — a theme-recoloured logo is the same shape", () => {
  const g = logo(3);
  assert.ok(ncc(normalise(g), normalise(invert(g))) > 0.9999, "this is what survives a lost/forced theme hook");
});

check("brightness and contrast changes do not move the score", () => {
  const g = logo(4);
  const dimmed = g.map((v) => Math.round(v * 0.45 + 30));
  assert.ok(ncc(normalise(g), normalise(dimmed)) > 0.999);
});

check("small rendering differences stay above threshold; a different mark falls far below", () => {
  const g = logo(5);
  const same = ncc(normalise(g), normalise(jitter(g)));
  const other = ncc(normalise(g), normalise(logo(9)));
  assert.ok(same >= MARK_THRESHOLD, `a jittered re-render scored ${same.toFixed(3)}, below the ${MARK_THRESHOLD} gate`);
  assert.ok(other < MARK_THRESHOLD, `an unrelated mark scored ${other.toFixed(3)}, at or above the gate`);
  assert.ok(same - other > 0.2, "the gap the threshold sits in must stay wide");
});

check("ncc is 0 for a missing or mismatched-length vector", () => {
  assert.equal(ncc(null, normalise(logo(1))), 0);
  assert.equal(ncc(normalise(logo(1)), null), 0);
  assert.equal(ncc(normalise(logo(1)), normalise([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17])), 0);
});

console.log("\nrender: aspect gate");

check("aspectClose keeps same-shaped marks comparable and rejects a square vs a wordmark", () => {
  assert.ok(aspectClose(62 / 18, 66 / 20), "the same wordmark rendered slightly larger");
  assert.ok(!aspectClose(62 / 18, 20 / 20), "a square icon must never be scored against a wordmark");
  assert.ok(!aspectClose(0, 3));
});

console.log("\nrender: verdict zoning");

const mark = (id: string, gray: number[], w = 62, h = 18): Mark => ({ id, why: "test", w, h, gray });
const graphic = (id: string, gray: number[], zone: Graphic["zone"], raster = false, w = 62, h = 18): Graphic =>
  ({ id, label: "", zone, raster, w, h, gray });

check("a matching mark in the page's chrome is HARD (the clerk failure)", () => {
  const g = logo(11);
  const { hits } = matchMarks([mark("navLogo", g)], [graphic("header>a>svg", g, "chrome")]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].hard, true);
  assert.ok(hits[0].score > 0.99);
});

check("a matching mark in the page BODY is HARD too (decorative brand repetition)", () => {
  const g = logo(12);
  const { hits } = matchMarks([mark("navLogo", g)], [graphic("section>div>svg", g, "body")]);
  assert.equal(hits[0].hard, true);
});

check("a match inside a product-demo media frame is a NOTE, not a failure (decision 3f)", () => {
  const g = logo(13);
  const { hits } = matchMarks([mark("navLogo", g)], [graphic("[data-atl-stage]>img", g, "media")]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].hard, false, "the reference's own app UI inside a kept screenshot must not fail a build");
});

check("a raster sub-crop match is a NOTE — the flattened-page class is the vision detector's call", () => {
  const g = logo(14);
  const { hits } = matchMarks([mark("navLogo", g)], [graphic("img [logo-slot]", g, "body", true)]);
  assert.equal(hits[0].hard, false);
});

check("unrelated graphics produce no hits and are reported as top misses for calibration", () => {
  const { hits, topMisses } = matchMarks([mark("navLogo", logo(15))], [graphic("svg.icon", logo(21), "chrome")]);
  assert.equal(hits.length, 0);
  assert.equal(topMisses.length, 1);
  assert.ok(topMisses[0].score < MARK_THRESHOLD);
});

check("a flat graphic is skipped rather than scored", () => {
  const { hits, topMisses } = matchMarks([mark("navLogo", logo(16))], [graphic("div.solid", flat(), "chrome")]);
  assert.equal(hits.length, 0);
  assert.equal(topMisses.length, 0, "a solid block must not even appear as a near-miss");
});

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}\n`);
