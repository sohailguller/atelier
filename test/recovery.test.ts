// Recovery-layer self-test. Linear's clean site never triggers the recovery branches, but
// they are the whole point of this stage (build-guide §4/§11). This feeds synthetic
// measurements that FORCE each branch and asserts it fires + fills the token, never leaving
// a silent gap. Run: npx tsx test/recovery.test.ts
import assert from "node:assert";
import { buildTokens } from "../src/tokens.js";
import type { RawMeasurements, HealthCheck } from "../src/types.js";

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

// A minimal "clean" baseline we then break in specific ways per test.
function baseRaw(overrides: Partial<RawMeasurements> = {}): RawMeasurements {
  return {
    url: "https://example.com",
    fontFaces: [],
    roles: {
      body: { found: true, fontFamily: "Inter", fontSize: "16px", lineHeight: "24px", fontWeight: "400", letterSpacing: "normal", textTransform: "none", color: "rgb(20,20,20)", backgroundColor: "rgb(255,255,255)" },
      h1: { found: true, fontFamily: "Inter", fontSize: "48px", lineHeight: "52px", fontWeight: "600", letterSpacing: "-1px", textTransform: "none", color: "rgb(20,20,20)" },
      h2: { found: true, fontFamily: "Inter", fontSize: "32px", lineHeight: "36px", fontWeight: "600", letterSpacing: "-0.5px", textTransform: "none" },
      h3: { found: true, fontFamily: "Inter", fontSize: "20px", lineHeight: "26px", fontWeight: "600", letterSpacing: "0px", textTransform: "none" },
      a: { found: true },
      button: { found: true, fontFamily: "Inter", fontSize: "14px", lineHeight: "20px", fontWeight: "500" },
      nav: { found: true },
      mono: { found: false },
    },
    buttonCandidates: [],
    colorFrequency: [],
    bgColorFrequency: [],
    blockBgFrequency: [],
    borderColorFrequency: [],
    pageBg: "rgb(255,255,255)",
    clipPaths: [],
    backgroundImages: [],
    inlineSvgs: [],
    spacingSamples: [],
    radii: [],
    boxShadows: [],
    sectionRects: [],
    mediaBreakpoints: [],
    domStats: { elementCount: 500, textLength: 2000 },
    ...overrides,
  };
}

const HEALTH_UP: HealthCheck = { visualChannel: true, screenshotBytes: 50000, reason: "ok" };
const HEALTH_DOWN: HealthCheck = { visualChannel: false, screenshotBytes: 0, reason: "forced" };

console.log("\nRecovery-layer self-test\n");

// 1. Spacing inference fallback (too few stable buckets → canonical 4/8 scale).
check("spacing: sparse samples fall back to canonical 4/8-pt scale", () => {
  const r = baseRaw({ spacingSamples: [16, 16, 16] }); // one bucket, < 4 distinct
  const { tokens, recovery } = buildTokens(r, HEALTH_UP);
  assert.strictEqual(recovery.spacingInferred, true, "spacingInferred should be true");
  assert.deepStrictEqual(tokens.space, [4, 8, 12, 16, 24, 32, 48, 64, 96, 128]);
});

// 1b. Spacing inference SUCCEEDS when there's a real distribution (no fallback).
check("spacing: rich distribution is clustered, not fallen back", () => {
  const samples: number[] = [];
  for (const v of [8, 16, 24, 32, 48]) for (let i = 0; i < 5; i++) samples.push(v);
  const { tokens, recovery } = buildTokens(baseRaw({ spacingSamples: samples }), HEALTH_UP);
  assert.strictEqual(recovery.spacingInferred, false, "should not fall back with a rich distribution");
  assert.ok(tokens.space.includes(8) && tokens.space.includes(48), `got ${tokens.space}`);
});

// 2. Radius flat: no radii + no pill → [0] recorded intentionally.
check("radius: flat site records [0] intentionally", () => {
  const { tokens, recovery } = buildTokens(baseRaw({ radii: [] }), HEALTH_UP);
  assert.strictEqual(recovery.radiusFlat, true);
  assert.deepStrictEqual(tokens.radius, [0]);
});

// 3. Shadow absence: none found → record "none" AND synthesize one restrained "md".
check("shadow: flat site records none + synthesizes one restrained md", () => {
  const { tokens, recovery } = buildTokens(baseRaw({ boxShadows: [] }), HEALTH_UP);
  assert.strictEqual(recovery.shadowNone, true);
  assert.strictEqual(recovery.shadowSynthesized, true);
  assert.strictEqual(tokens.shadow.none, "none");
  assert.ok(tokens.shadow.md && tokens.shadow.md.includes("rgba"), "should synthesize an md elevation");
});

// 4. Accent fallback: monochrome site (no colorful colors) → accent set to text, flagged.
check("accent: monochrome site falls back to text color, flagged", () => {
  const r = baseRaw({
    colorFrequency: [{ color: "rgb(20,20,20)", count: 10, area: 5000 }],
    bgColorFrequency: [{ color: "rgb(255,255,255)", count: 10, area: 5000 }],
  });
  const { tokens, recovery } = buildTokens(r, HEALTH_UP);
  assert.strictEqual(recovery.accentFallback, true);
  assert.strictEqual(tokens.color.accent, "#141414");
});

// 4b. Accent found: a colorful fill covering real area wins as the accent (no fallback).
check("accent: colorful fill with real area is picked as accent", () => {
  const r = baseRaw({ bgColorFrequency: [{ color: "rgb(94,106,210)", count: 6, area: 8000 }] });
  const { tokens, recovery } = buildTokens(r, HEALTH_UP);
  assert.strictEqual(recovery.accentFallback, false);
  assert.strictEqual(tokens.color.accent, "#5e6ad2");
});

// 4c. THE LINEAR CASE: a tiny colorful status dot must NOT become the accent; a monochrome
// site with a white pill primary should resolve accent to the white pill fill.
check("accent: tiny colorful dot ignored, accent = white pill fill (Linear case)", () => {
  const r = baseRaw({
    pageBg: "rgb(8,9,10)",
    roles: { ...baseRaw().roles, body: { ...baseRaw().roles.body, color: "rgb(247,248,248)", backgroundColor: "rgb(8,9,10)" } },
    // lime appears only on a ~14x14 status dot -> tiny area, below the floor
    bgColorFrequency: [{ color: "rgb(228,242,34)", count: 3, area: 500 }],
    buttonCandidates: [
      { text: "Sign up", inHeader: true, top: 40, w: 92, h: 40, hasFill: true, isPill: true, backgroundColor: "rgb(247,248,248)", color: "rgb(8,9,10)", borderRadius: "20px", padding: "8px 16px", border: "0px none", fontFamily: "Inter", fontSize: "14px", fontWeight: "500", boxShadow: "none", clipPath: "none" },
      { text: "Log in", inHeader: true, top: 40, w: 60, h: 40, hasFill: false, isPill: false, backgroundColor: "rgba(0, 0, 0, 0)", color: "rgb(247,248,248)", borderRadius: "0px", padding: "8px", border: "0px none", fontFamily: "Inter", fontSize: "14px", fontWeight: "400", boxShadow: "none", clipPath: "none" },
    ],
  });
  const { tokens, recovery, recipes } = buildTokens(r, HEALTH_UP);
  assert.strictEqual(recovery.accentFallback, true, "lime dot must not count as accent");
  assert.notStrictEqual(tokens.color.accent, "#e4f222", "must not pick the lime status dot");
  assert.strictEqual(tokens.color.accent, "#f7f8f8", "accent should be the white pill fill");
  // and the CTA recipe must be the white pill, not a lime box
  assert.ok(recipes.cta, "should capture a primary button");
  assert.strictEqual(recipes.cta!.background, "#f7f8f8");
  assert.strictEqual(recipes.cta!.color, "#08090a");
  assert.ok(recipes.cta!.borderRadius.includes("pill"), "primary should be a pill");
});

// 4e. One large decorative element (a single lime customer card, count=1) must NOT define
// the accent, even though its area is huge. Systematic use requires recurrence.
check("accent: single large colorful card (count=1) is not the accent", () => {
  const r = baseRaw({
    pageBg: "rgb(8,9,10)",
    roles: { ...baseRaw().roles, body: { ...baseRaw().roles.body, color: "rgb(247,248,248)", backgroundColor: "rgb(8,9,10)" } },
    bgColorFrequency: [{ color: "rgb(228,242,34)", count: 1, area: 207360 }],
    buttonCandidates: [
      { text: "Sign up", inHeader: true, top: 40, w: 92, h: 40, hasFill: true, isPill: true, backgroundColor: "rgb(229,229,230)", color: "rgb(8,9,10)", borderRadius: "20px", padding: "0px 12px", border: "1px solid rgb(229,229,230)", fontFamily: "Inter", fontSize: "13px", fontWeight: "510", boxShadow: "none", clipPath: "none" },
    ],
  });
  const { tokens, recovery } = buildTokens(r, HEALTH_UP);
  assert.strictEqual(recovery.accentFallback, true, "a single big card must not be the accent");
  assert.notStrictEqual(tokens.color.accent, "#e4f222");
  assert.strictEqual(tokens.color.accent, "#e5e5e6", "accent = white pill fill");
});

// 4d. Radius de-noise: rare sub-pixel radii dropped; card recipe uses the favored ~8px.
check("radius: sub-pixel artifacts dropped, card uses dominant ~8px", () => {
  const r = baseRaw({
    radii: [
      { value: 1, count: 1 }, { value: 2, count: 1 }, { value: 4, count: 8 },
      { value: 7, count: 1 }, { value: 8, count: 40 }, { value: 12, count: 6 },
    ],
  });
  const { tokens, recipes } = buildTokens(r, HEALTH_UP);
  assert.ok(!tokens.radius.includes(1) && !tokens.radius.includes(7), `artifacts should be gone: ${tokens.radius}`);
  assert.strictEqual(recipes.card.borderRadius, "8px", "card should use Linear's favored 8px, not the smallest");
});

// 5. Breakpoints fallback: none in CSSOM → standard sm/md/lg defaults.
check("breakpoints: none readable falls back to standard defaults", () => {
  const { tokens, recovery } = buildTokens(baseRaw({ mediaBreakpoints: [] }), HEALTH_UP);
  assert.strictEqual(recovery.breakpointsFallback, true);
  assert.deepStrictEqual(tokens.breakpoints, { sm: 640, md: 768, lg: 1024 });
});

// 6. Visual-channel down: tokens still built from DOM measurement; recorded in notes.
check("visual channel down: tokens still produced, recovery noted", () => {
  const { tokens, recovery, notes } = buildTokens(baseRaw({ spacingSamples: [8, 8, 8, 16, 16, 16, 24, 24, 24, 32, 32, 32] }), HEALTH_DOWN);
  assert.strictEqual(recovery.visualChannel, false);
  assert.ok(tokens.type.h1.size > 0 && tokens.color.text.startsWith("#"), "tokens must still be complete");
  assert.ok(notes.some((n) => n.includes("visual-channel")), "should note the visual-channel recovery");
});

// 7. Translucent border overlay flattens over bg (not dropped to opaque white).
check("border: translucent white overlay flattens over dark bg", () => {
  const r = baseRaw({
    pageBg: "rgb(8,9,10)",
    roles: { ...baseRaw().roles, body: { ...baseRaw().roles.body, color: "rgb(247,248,248)", backgroundColor: "rgb(8,9,10)" } },
    borderColorFrequency: [{ color: "rgba(255,255,255,0.08)", count: 20 }],
  });
  const { tokens } = buildTokens(r, HEALTH_UP);
  assert.notStrictEqual(tokens.color.border, "#ffffff", "must not drop alpha to opaque white");
  assert.ok(tokens.color.border < "#333333", `expected a dark composited border, got ${tokens.color.border}`);
});

// 8. Missing heading roles are synthesized so the type ramp is never incomplete.
check("type ramp: missing h1/h2/h3 synthesized from body scale", () => {
  const roles = baseRaw().roles;
  const { tokens, notes } = buildTokens(baseRaw({ roles: { ...roles, h1: { found: false }, h2: { found: false }, h3: { found: false } } }), HEALTH_UP);
  assert.ok(tokens.type.h1.size > tokens.type.body.size, "h1 must be larger than body");
  assert.ok(tokens.type.h2.size > tokens.type.h3.size, "ramp must be ordered");
  assert.ok(notes.some((n) => n.includes("type-ramp")), "should note the synthesis");
});

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures above)" : ""}\n`);
