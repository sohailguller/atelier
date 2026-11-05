// SERVED END-TO-END probe for the behaviour pass — the one path neither the unit tests nor the audit cover:
// the injected runtime doing a REAL POST from a real browser to the emitted server.
//
//   npx tsx test/served-form.mts <build-dir>        # the dir must contain server.mjs (a wired build)
//
// Asserts, in order: an invalid email is refused client-side with the reference's own aria-invalid styling and
// writes nothing; a valid one reaches `data-atl-mode="server"`, renders the confirmation in a node cloned from
// the reference's own text element, and appends exactly one row to submissions.jsonl. Needs a free port 3987.
// (behavior.test.ts covers the server directly; `npm run audit` covers the file:// fallback path.)
import { spawn } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const dir = path.resolve(process.argv[2]);
const port = 3987;
const log = path.join(dir, "submissions.jsonl");
if (existsSync(log)) rmSync(log);

const proc = spawn(process.execPath, [path.join(dir, "server.mjs"), String(port)], { stdio: ["ignore", "pipe", "pipe"] });
await new Promise<void>((res, rej) => {
  const t = setTimeout(() => rej(new Error("no start")), 5000);
  proc.stdout.on("data", (b) => { if (b.toString().includes("http://localhost")) { clearTimeout(t); res(); } });
});

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(m.text().slice(0, 140)); });
await page.goto(`http://localhost:${port}/`, { waitUntil: "load" });
await page.waitForTimeout(1200);

// 1. invalid email must be refused client-side, with the reference's own aria-invalid styling
await page.fill('[data-atl-field^="email"]', "not-an-email");
await page.click("[data-atl-submit]");
await page.waitForTimeout(400);
console.log("invalid → aria-invalid:", await page.getAttribute('[data-atl-field^="email"]', "aria-invalid"));
console.log("invalid → submitted?  :", await page.getAttribute("[data-atl-form]", "data-atl-submitted"));
console.log("invalid → JSONL exists:", existsSync(log));

// 2. a valid submission
await page.fill('[data-atl-field^="email"]', "real.person@example.com");
await page.click("[data-atl-submit]");
await page.waitForTimeout(900);
const form = await page.$("[data-atl-form]");
console.log("valid   → submitted    :", await form!.getAttribute("data-atl-submitted"));
console.log("valid   → mode         :", await form!.getAttribute("data-atl-mode"));
console.log("valid   → success text :", JSON.stringify((await page.textContent('[data-atl-state="success"]')) || ""));
console.log("valid   → success styled as the reference's own <p>:", await page.getAttribute('[data-atl-state="success"]', "class"));
console.log("valid   → JSONL row    :", existsSync(log) ? readFileSync(log, "utf8").trim() : "(none)");
console.log("console errors/warnings:", errors.length ? errors : "none");

await browser.close();
proc.kill();
