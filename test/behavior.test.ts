// BEHAVIOUR pass (src/behavior.ts + templates/form-server.mjs) — the decision layer and the real endpoint.
//
// Two halves, both offline and browser-free:
//   1. the PURE detection rules over descriptor fixtures, including the shapes the current reference pool
//      does NOT contain (a multi-field signup form, a <form>-less capture cluster, a search box) and the one
//      it does (supabase's newsletter form, and the 1×1px a11y stubs resend/linear ship);
//   2. the emitted server, booted for real on an ephemeral port.
// The browser end-to-end (fill → submit → success state) is the audit's `checkForms`, run by `npm run audit`.
//
// Run: npx tsx test/behavior.test.ts
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, copyFile, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isRealField, isSearchField, fieldRole, isSubmitControl, detectForms,
  type FieldDesc, type ControlDesc, type Candidates,
} from "../src/behavior.js";

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}
async function acheck(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

const field = (o: Partial<FieldDesc> = {}): FieldDesc => ({
  ref: "c0", tag: "input", type: "text", name: "", id: "", autocomplete: "", ariaLabel: "", placeholder: "",
  role: "", required: false, ariaHidden: false, tabindex: "", clipped: false, w: 240, h: 34,
  formRef: "", clusterRef: "", ...o,
});
const control = (o: Partial<ControlDesc> = {}): ControlDesc => ({
  ref: "b0", tag: "button", type: "", text: "Submit", formRef: "", clusterRefs: [], disabled: false, ...o,
});

console.log("\nbehavior: is this a real field?");

check("supabase's newsletter email input is real", () => {
  assert.ok(isRealField(field({ type: "email", placeholder: "Your email", ariaLabel: "Email for newsletter", required: true, w: 288, h: 24 })));
});

check("the measured Base-UI a11y stub is NOT a field (resend + linear ship 3 and 2 of these)", () => {
  // clip-path: inset(50%), 1×1px, aria-hidden, tabindex=-1 — the exact shape found in both clones.
  assert.ok(!isRealField(field({ clipped: true, w: 1, h: 1, ariaHidden: true, tabindex: "-1" })));
  assert.ok(!isRealField(field({ w: 1, h: 1, clipped: true })), "1×1px alone is enough to disqualify");
  assert.ok(!isRealField(field({ tabindex: "-1" })), "unfocusable is not typeable");
});

check("hidden/submit/button inputs are not fields", () => {
  for (const type of ["hidden", "submit", "button", "reset", "image"]) assert.ok(!isRealField(field({ type })));
});

check("a checkbox is real at checkbox size, where a text input would be too small", () => {
  assert.ok(isRealField(field({ type: "checkbox", w: 16, h: 16 })));
  assert.ok(!isRealField(field({ type: "text", w: 16, h: 16 })));
});

console.log("\nbehavior: search boxes are left alone");

check("search is detected by type, role and wording", () => {
  assert.ok(isSearchField(field({ type: "search" })));
  assert.ok(isSearchField(field({ role: "searchbox" })));
  assert.ok(isSearchField(field({ placeholder: "Search docs" })));
  assert.ok(isSearchField(field({ name: "q", ariaLabel: "Site search" })));
  assert.ok(!isSearchField(field({ type: "email", placeholder: "Your email" })));
});

check("a search-only form is skipped with a note, never wired", () => {
  const f = field({ ref: "s1", type: "search", formRef: "F1", placeholder: "Search" });
  const r = detectForms({ forms: [{ ref: "F1", fieldRefs: ["s1"], controlRefs: ["b0"] }], fields: [f], controls: [control({ formRef: "F1" })] });
  assert.equal(r.detected.length, 0, "wiring a search box to a capture endpoint would be wrong behaviour");
  assert.ok(r.notes.some((n) => /search/i.test(n)), "the skip must be reported, not silent");
});

console.log("\nbehavior: field roles");

check("roles come from type, name, autocomplete, aria-label or placeholder", () => {
  assert.equal(fieldRole(field({ type: "email" })), "email");
  assert.equal(fieldRole(field({ placeholder: "you@work.com", name: "work_email" })), "email");
  assert.equal(fieldRole(field({ autocomplete: "email" })), "email");
  assert.equal(fieldRole(field({ type: "password" })), "password");
  assert.equal(fieldRole(field({ tag: "textarea" })), "textarea");
  assert.equal(fieldRole(field({ tag: "select" })), "select");
  assert.equal(fieldRole(field({ type: "checkbox" })), "checkbox");
  assert.equal(fieldRole(field({ name: "full_name" })), "text");
});

console.log("\nbehavior: which control submits");

check("an explicit submit wins; a bare <button> in a form submits by the HTML contract", () => {
  assert.ok(isSubmitControl(control({ type: "submit", text: "Subscribe" })));
  assert.ok(isSubmitControl(control({ tag: "button", text: "Anything", formRef: "F1" })));
  assert.ok(!isSubmitControl(control({ tag: "button", type: "button", text: "Learn more" })), "a generic CTA is not a submit");
  assert.ok(!isSubmitControl(control({ type: "submit", disabled: true })));
});

check("outside a form only submit-shaped copy counts", () => {
  for (const text of ["Subscribe", "Sign up", "Join", "Get started", "Notify me", "Request a demo", "Send"]) {
    assert.ok(isSubmitControl(control({ type: "button", text })), `"${text}" should read as a submit`);
  }
  for (const text of ["Learn more", "Read the docs", "View pricing", "Watch the video"]) {
    assert.ok(!isSubmitControl(control({ type: "button", text })), `"${text}" must NOT be wired`);
  }
});

console.log("\nbehavior: what gets wired");

check("supabase's shape — one email field + type=submit — is one email-capture form", () => {
  const r = detectForms({
    forms: [{ ref: "F1", fieldRefs: ["c0"], controlRefs: ["b0"] }],
    fields: [field({ ref: "c0", type: "email", required: true, name: "email", formRef: "F1" })],
    controls: [control({ ref: "b0", type: "submit", text: "Subscribe", formRef: "F1" })],
  });
  assert.equal(r.detected.length, 1);
  assert.equal(r.detected[0].kind, "form");
  assert.equal(r.detected[0].emailOnly, true, "an email-only capture gets the subscribe confirmation");
  assert.equal(r.detected[0].controlRef, "b0");
  assert.deepEqual(r.detected[0].fieldRefs.map((f) => f.role), ["email"]);
});

check("a multi-field signup form wires every field and is not treated as email capture", () => {
  const fields = [
    field({ ref: "c0", type: "text", name: "name", required: true, formRef: "F1" }),
    field({ ref: "c1", type: "email", name: "email", required: true, formRef: "F1" }),
    field({ ref: "c2", type: "password", name: "password", required: true, formRef: "F1" }),
    field({ ref: "c3", type: "checkbox", name: "terms", w: 16, h: 16, formRef: "F1" }),
    field({ ref: "c4", type: "hidden", name: "csrf", formRef: "F1" }),
  ];
  const r = detectForms({
    forms: [{ ref: "F1", fieldRefs: fields.map((f) => f.ref), controlRefs: ["b0"] }],
    fields, controls: [control({ ref: "b0", type: "submit", text: "Create account", formRef: "F1" })],
  });
  assert.equal(r.detected.length, 1);
  assert.deepEqual(r.detected[0].fieldRefs.map((f) => f.role), ["text", "email", "password", "checkbox"], "the hidden csrf input is not a field");
  assert.equal(r.detected[0].emailOnly, false);
});

check("a <form>-less capture cluster (input + submit-shaped button in one container) is wired", () => {
  const r = detectForms({
    forms: [],
    fields: [field({ ref: "c0", type: "email", clusterRef: "D9", placeholder: "Enter your email" })],
    controls: [control({ ref: "b0", type: "button", text: "Join the waitlist", clusterRefs: ["D9"] })],
  });
  assert.equal(r.detected.length, 1);
  assert.equal(r.detected[0].kind, "cluster");
  assert.equal(r.detected[0].containerRef, "D9");
});

check("a lone input with no submit control anywhere is left alone, with a note", () => {
  const r = detectForms({ forms: [], fields: [field({ ref: "c0", type: "email", ariaLabel: "Email" })], controls: [] });
  assert.equal(r.detected.length, 0);
  assert.ok(r.notes.some((n) => /no submit control/i.test(n)));
});

check("a form of nothing but a11y stubs is skipped, with a note (resend / linear)", () => {
  const r = detectForms({
    forms: [{ ref: "F1", fieldRefs: ["c0"], controlRefs: [] }],
    fields: [field({ ref: "c0", clipped: true, w: 1, h: 1, ariaHidden: true, tabindex: "-1", formRef: "F1" })],
    controls: [],
  });
  assert.equal(r.detected.length, 0);
  assert.ok(r.notes.some((n) => /none real/i.test(n)));
});

check("a form field is never double-counted as a cluster", () => {
  const r = detectForms({
    forms: [{ ref: "F1", fieldRefs: ["c0"], controlRefs: ["b0"] }],
    fields: [field({ ref: "c0", type: "email", formRef: "F1", clusterRef: "D9" })],
    controls: [control({ ref: "b0", type: "submit", formRef: "F1", clusterRefs: ["D9"] })],
  });
  assert.equal(r.detected.length, 1);
  assert.equal(r.wired, 1);
});

check("ids are stable and sequential so the runtime, the audit and the payload agree", () => {
  const many: Candidates = {
    forms: [
      { ref: "F1", fieldRefs: ["c0"], controlRefs: ["b0"] },
      { ref: "F2", fieldRefs: ["c1"], controlRefs: ["b1"] },
    ],
    fields: [field({ ref: "c0", type: "email", formRef: "F1" }), field({ ref: "c1", type: "email", formRef: "F2" })],
    controls: [control({ ref: "b0", type: "submit", formRef: "F1" }), control({ ref: "b1", type: "submit", formRef: "F2" })],
  };
  assert.deepEqual(detectForms(many).detected.map((f) => f.id), [0, 1]);
});

// ---------------------------------------------------------------------------
console.log("\nbehavior: the emitted endpoint (templates/form-server.mjs, booted for real)");

const SERVER_TEMPLATE = path.resolve("templates/form-server.mjs");

async function withServer(fn: (base: string, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "atelier-forms-"));
  await copyFile(SERVER_TEMPLATE, path.join(dir, "server.mjs"));
  await writeFile(path.join(dir, "index.html"), "<!doctype html><title>t</title><p>hello");
  const port = 3900 + Math.floor(Math.random() * 90);
  const proc = spawn(process.execPath, [path.join(dir, "server.mjs"), String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("server did not start in 5s")), 5000);
      proc.stdout.on("data", (b) => { if (b.toString().includes("http://localhost")) { clearTimeout(t); resolve(); } });
      proc.on("error", reject);
    });
    await fn(`http://localhost:${port}`, dir);
  } finally {
    proc.kill();
  }
}

await acheck("the template exists and is emitted next to a build", () => {
  assert.ok(existsSync(SERVER_TEMPLATE), "templates/form-server.mjs must exist — behavior.ts copies it verbatim");
  return Promise.resolve();
});

await acheck("POST /api/submit stores one JSON line per submission", async () => {
  await withServer(async (base, dir) => {
    const res = await fetch(base + "/api/submit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ form: "0", fields: { email: "person@example.com" } }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    const log = await readFile(path.join(dir, "submissions.jsonl"), "utf8");
    const rows = log.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].fields.email, "person@example.com");
    assert.ok(Date.parse(rows[0].ts) > 0, "each row is timestamped");
  });
});

await acheck("it still serves the clone statically", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    assert.match(await res.text(), /hello/);
  });
});

await acheck("GET /api/submit is 405, and a malformed body is 400", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(base + "/api/submit")).status, 405);
    const bad = await fetch(base + "/api/submit", { method: "POST", headers: { "content-type": "application/json" }, body: "not json" });
    assert.equal(bad.status, 400);
    const noFields = await fetch(base + "/api/submit", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(noFields.status, 400, "a submission with no fields is not a submission");
  });
});

await acheck("path traversal and the submission log itself are refused", async () => {
  await withServer(async (base) => {
    const up = await fetch(base + "/../../../etc/passwd");
    assert.ok(up.status === 403 || up.status === 404, `escaping the build dir must not serve a file (got ${up.status})`);
    await fetch(base + "/api/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ form: "0", fields: { email: "a@b.co" } }) });
    assert.equal((await fetch(base + "/submissions.jsonl")).status, 403, "captured submissions must not be readable over HTTP");
    assert.equal((await fetch(base + "/server.mjs")).status, 403);
  });
});

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}\n`);
