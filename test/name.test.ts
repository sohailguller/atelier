// Product-name collision-guard tests. The pure core of src/name.ts only — no network, no model,
// no API key — so the rule can be regression-tested offline. The fixtures below are the REAL
// response shapes measured while designing the guard (HugeDomains parking, a 114-byte stub, live
// flagsmith.com / uptrace.dev titles).
// Run: npx tsx test/name.test.ts
import assert from "node:assert";
import {
  slugify,
  titleOf,
  ogNameOf,
  isParkedOrStub,
  looksLikeCompany,
  combine,
  pickName,
  extractJsonArray,
  isWellFormed,
  type Verdict,
} from "../src/name.js";

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

const page = (title: string, body = "x".repeat(50_000), meta = "") =>
  `<!doctype html><html><head><title>${title}</title>${meta}</head><body>${body}</body></html>`;

console.log("\nname: slug + well-formedness");

check("slugify strips spaces and punctuation", () => {
  assert.equal(slugify("Pulse Grid"), "pulsegrid");
  assert.equal(slugify("Uptrace"), "uptrace");
  assert.equal(slugify("Signal.fy"), "signalfy");
});

check("isWellFormed accepts 1-2 word ASCII brands, rejects taglines", () => {
  assert.ok(isWellFormed("Pulsegrid"));
  assert.ok(isWellFormed("Pulse Grid"));
  assert.ok(!isWellFormed("Pulse Grid Monitoring Platform"), "3+ words is not a brand name");
  assert.ok(!isWellFormed("Here is a name: Pulsegrid"));
  assert.ok(!isWellFormed(""));
});

console.log("\nname: page classification (the domain screen)");

check("titleOf / ogNameOf read the site's self-description", () => {
  assert.equal(titleOf(page("Flagsmith - Open Source Feature Flag Service")), "Flagsmith - Open Source Feature Flag Service");
  assert.equal(titleOf("<html><body>no title</body></html>"), "");
  assert.equal(
    ogNameOf(`<meta content="Pulsegrid" property="og:site_name">`),
    "Pulsegrid",
    "attribute order must not matter"
  );
});

check("a domain-parking page is NOT a collision (the name is for sale)", () => {
  // Measured: signalfy.com serves exactly this title.
  assert.ok(isParkedOrStub("SignalFy.com is for sale | HugeDomains", page("SignalFy.com is for sale | HugeDomains")));
  const { verdict } = looksLikeCompany("signalfy", 200, page("SignalFy.com is for sale | HugeDomains"));
  assert.equal(verdict, "clear");
});

check("an empty stub page is NOT a collision", () => {
  // Measured: quantiva.com returned a 114-byte body with no <title>.
  const stub = "<html><body>coming soon</body></html>";
  assert.ok(isParkedOrStub(titleOf(stub), stub));
  assert.equal(looksLikeCompany("quantiva", 200, stub).verdict, "clear");
});

check("a server default page is NOT a collision", () => {
  assert.ok(isParkedOrStub("Welcome to nginx!", page("Welcome to nginx!")));
  assert.ok(isParkedOrStub("Index of /", page("Index of /")));
});

check("a SMALL real product page IS a collision (no body-length escape hatch)", () => {
  // Measured: meterly.ai is a live product whose entire page is ~1.5KB. An earlier 2KB
  // "substantive" floor let this collision through — the regression this test pins.
  const small = page("Meterly.AI - Usage Based Billing", "z".repeat(1200));
  assert.ok(small.length < 2000);
  assert.equal(looksLikeCompany("meterly", 200, small).verdict, "collision");
});

check("a live site that names itself the candidate IS a collision", () => {
  assert.equal(looksLikeCompany("flagsmith", 200, page("Flagsmith - Open Source Feature Flag Service")).verdict, "collision");
  assert.equal(looksLikeCompany("uptrace", 200, page("OpenTelemetry-Native Observability Platform | Uptrace")).verdict, "collision");
});

check("collision can be established via og:site_name alone", () => {
  const html = page("Home", "y".repeat(50_000), `<meta property="og:site_name" content="Pulsegrid">`);
  assert.equal(looksLikeCompany("pulsegrid", 200, html).verdict, "collision");
});

check("a live site that does NOT name itself the candidate is clear", () => {
  // A squatter/unrelated site on the domain is not a company using that name.
  assert.equal(looksLikeCompany("pulsegrid", 200, page("Cheap flights and hotels")).verdict, "clear");
});

check("404 is clear; 5xx is inconclusive (never a silent pass or reject)", () => {
  assert.equal(looksLikeCompany("pulsegrid", 404, page("Not Found")).verdict, "clear");
  assert.equal(looksLikeCompany("pulsegrid", 503, page("Service Unavailable")).verdict, "inconclusive");
});

console.log("\nname: verdict combination + picking");

const dom = (v: Verdict, where = "x.com") => ({ verdict: v, where });

check("either screen alone can reject", () => {
  const v = combine(
    ["Flagsmith", "Uptrace", "Pulsegrid"],
    new Map([
      ["Flagsmith", dom("collision", "flagsmith.com")], // domain caught it
      ["Uptrace", dom("inconclusive", "uptrace")],      // domain timed out
      ["Pulsegrid", dom("clear", "pulsegrid")],
    ]),
    new Set(["uptrace"]) // model knowledge caught the one the probe missed
  );
  assert.equal(v[0].keep, false);
  assert.equal(v[1].keep, false, "model screen must cover a domain timeout — this is the Uptrace case");
  assert.equal(v[2].keep, true);
  assert.match(v[0].reason, /flagsmith\.com/);
  assert.match(v[1].reason, /model/);
});

check("an inconclusive domain probe alone does NOT reject", () => {
  const v = combine(["Pulsegrid"], new Map([["Pulsegrid", dom("inconclusive")]]), new Set());
  assert.equal(v[0].keep, true, "a network timeout must not throw away a good name");
});

check("pickName takes the first survivor in the model's preference order", () => {
  const v = combine(
    ["Alpha", "Beta", "Gamma"],
    new Map([["Alpha", dom("collision")], ["Beta", dom("clear")], ["Gamma", dom("clear")]]),
    new Set()
  );
  assert.equal(pickName(v)!.name, "Beta");
});

check("pickName returns null when everything collides (caller retries/falls back)", () => {
  const v = combine(["Alpha", "Beta"], new Map([["Alpha", dom("collision")], ["Beta", dom("clear")]]), new Set(["beta"]));
  assert.equal(pickName(v), null);
});

console.log("\nname: model-response parsing");

check("extractJsonArray tolerates fences and prose", () => {
  assert.deepEqual(extractJsonArray('```json\n["Uptrace"]\n```'), ["Uptrace"]);
  assert.deepEqual(extractJsonArray('Here you go: ["A", "B"] — hope that helps'), ["A", "B"]);
  assert.deepEqual(extractJsonArray("[]"), []);
  assert.equal(extractJsonArray("no array here"), null, "unparseable = inconclusive, not a blanket reject");
});

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}\n`);
