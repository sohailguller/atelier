// BEHAVIOUR ADAPTATION, v1 — make the forms the reference already ships actually work.
//
//   npx tsx src/behavior.ts <build-dir> [--index <file>] [--json]      (probe: detect only, no writes)
//
// Clone-and-adapt has so far adapted VISUAL + COPY: clone.ts reproduces the reference's page and swap.ts
// changes only the wording. Every interactive affordance in the output is dead — which is itself on the
// avoid list (`vibe-coded-patterns.md` §4.3 "tabs that do not tab, buttons that do not respond", §2.1 "no
// loading states"). This pass extends what gets adapted to VISUAL + COPY + BEHAVIOUR, using the reference's
// own UI as the spec: nothing is invented, no model is called, and only what is really in the markup is wired.
//
// SCOPE (v1, deliberate): capture forms only. A cloned signup form is treated as capture — validate, store,
// confirm. It never fakes an account, a session or a logged-in view, because a static clone cannot honestly
// have one.
//
// SHAPE OF THE CODE. The DOM side only COLLECTS descriptors and later APPLIES tags; every decision
// (is this a real field, is it a search box, what role does it play, which control submits it) is a pure
// function over those descriptors, so the rules are unit-testable offline (test/behavior.test.ts) — the same
// split render-audit.ts uses for its scoring.
import { readFileSync, existsSync } from "node:fs";
import { writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { openStatic } from "./browser.js";

// ---------------------------------------------------------------------------
// Descriptors (collected in the page) + the pure decision layer (tested offline)
// ---------------------------------------------------------------------------

export type FieldRole = "email" | "password" | "text" | "textarea" | "select" | "checkbox";

export interface FieldDesc {
  ref: string;
  tag: string;              // input | textarea | select
  type: string;             // the input's type attribute, lowercased
  name: string;
  id: string;
  autocomplete: string;
  ariaLabel: string;
  placeholder: string;
  role: string;             // explicit role attribute
  required: boolean;
  ariaHidden: boolean;
  tabindex: string;
  clipped: boolean;         // clip-path/opacity/visibility/display say it is not really on screen
  w: number;
  h: number;
  formRef: string;          // enclosing <form>'s ref, or "" when there is none
  clusterRef: string;       // nearest ancestor that also holds a submit-shaped control, or ""
}

export interface ControlDesc {
  ref: string;
  tag: string;              // button | input | a
  type: string;
  text: string;
  formRef: string;
  clusterRefs: string[];    // ancestors that could serve as a capture cluster container
  disabled: boolean;
}

export interface FormDesc { ref: string; fieldRefs: string[]; controlRefs: string[] }

export interface Candidates { forms: FormDesc[]; fields: FieldDesc[]; controls: ControlDesc[] }

export interface DetectedForm {
  id: number;
  kind: "form" | "cluster";
  containerRef: string;     // the <form>, or the cluster container to wire
  fieldRefs: Array<{ ref: string; role: FieldRole; name: string; required: boolean }>;
  controlRef: string;       // "" = submit only via Enter / the form's own submit event
  emailOnly: boolean;
}

export interface FormReport {
  detected: DetectedForm[];
  notes: string[];
  wired: number;
}

/** Submit-shaped copy. Deliberately narrow: these are the words a capture control actually uses. A generic
 *  "Learn more" CTA is NOT a submit control, and treating it as one would wire buttons that were never
 *  meant to send anything. */
const SUBMIT_TEXT = /^(subscribe|sign ?up|join|get started|get updates|notify me|submit|send|request (a )?(demo|access|invite)|start (free|trial)|create account|continue|book a demo|talk to sales|contact (us|sales))\b/i;
const SEARCH_HINT = /search|query|find/i;

/** A field is REAL only if a person could actually type in it. Measured need: resend and linear each ship
 *  hidden Base-UI a11y stubs (`clip-path: inset(50%)`, 1×1px, aria-hidden, tabindex=-1) — without this
 *  filter both would report phantom forms and the whole pass would wire nothing that exists. */
export function isRealField(f: FieldDesc): boolean {
  if (f.tag === "input" && /^(hidden|submit|button|reset|image)$/.test(f.type)) return false;
  if (f.ariaHidden || f.tabindex === "-1") return false;
  if (f.clipped) return false;
  if (f.type === "checkbox" || f.type === "radio") return f.w >= 8 && f.h >= 8; // a real checkbox is small
  return f.w >= 40 && f.h >= 12;
}

/** A search box must be left alone. Wiring it to a capture endpoint would be WRONG behaviour, which is worse
 *  than the missing behaviour we are fixing. */
export function isSearchField(f: FieldDesc): boolean {
  if (f.type === "search" || f.role === "searchbox") return true;
  return SEARCH_HINT.test([f.name, f.id, f.ariaLabel, f.placeholder].join(" "));
}

export function fieldRole(f: FieldDesc): FieldRole {
  if (f.tag === "textarea") return "textarea";
  if (f.tag === "select") return "select";
  if (f.type === "checkbox" || f.type === "radio") return "checkbox";
  if (f.type === "password") return "password";
  const hay = [f.type, f.name, f.id, f.autocomplete, f.ariaLabel, f.placeholder].join(" ").toLowerCase();
  // Substring, not `\bemail\b`: the common real names are `work_email` / `user_email` / `email_address`, and
  // `_` is a word character, so a word-boundary test misses every one of them (caught by the fixture test).
  // A placeholder containing "@" is the other reliable tell ("you@work.com").
  if (f.type === "email" || /email|e-mail/.test(hay) || f.placeholder.includes("@")) return "email";
  return "text";
}

/** Does this control submit? Inside a form a bare <button> submits by default (that is the HTML contract), so
 *  it counts; outside one, only submit-shaped copy does. */
export function isSubmitControl(c: ControlDesc): boolean {
  if (c.disabled) return false;
  if (c.type === "submit") return true;
  if (c.formRef && c.tag === "button" && c.type !== "button" && c.type !== "reset") return true;
  return SUBMIT_TEXT.test(c.text.trim());
}

/** Prefer the explicit submit, then submit-shaped copy, then nothing (the form still submits on Enter). */
function pickControl(controls: ControlDesc[]): string {
  const usable = controls.filter(isSubmitControl);
  return (usable.find((c) => c.type === "submit") ?? usable.find((c) => SUBMIT_TEXT.test(c.text.trim())) ?? usable[0])?.ref ?? "";
}

/**
 * Decide what to wire. Two shapes:
 *   form    — a real <form> holding at least one real, non-search field (the HTML contract does the work).
 *   cluster — the same thing without a <form>: a real field plus a submit-shaped control in one small
 *             container. Marketing pages do this constantly for email capture.
 */
export function detectForms(c: Candidates): FormReport {
  const byRef = new Map(c.fields.map((f) => [f.ref, f]));
  const notes: string[] = [];
  const detected: DetectedForm[] = [];
  const used = new Set<string>();
  let id = 0;

  const entry = (kind: DetectedForm["kind"], containerRef: string, fields: FieldDesc[], controlRef: string): DetectedForm => {
    const roles = fields.map((f) => ({ ref: f.ref, role: fieldRole(f), name: f.name || fieldRole(f), required: f.required }));
    return {
      id: id++, kind, containerRef, fieldRefs: roles, controlRef,
      emailOnly: roles.length === 1 && roles[0].role === "email",
    };
  };

  for (const form of c.forms) {
    const all = form.fieldRefs.map((r) => byRef.get(r)).filter(Boolean) as FieldDesc[];
    const real = all.filter(isRealField);
    const searchy = real.filter(isSearchField);
    const fields = real.filter((f) => !isSearchField(f));
    if (searchy.length) notes.push(`search field ignored in a <form> (${searchy.length})`);
    if (!fields.length) {
      if (all.length) notes.push(`<form> skipped — ${all.length} field(s), none real+non-search (a11y stub or search-only)`);
      continue;
    }
    fields.forEach((f) => used.add(f.ref));
    detected.push(entry("form", form.ref, fields, pickControl(c.controls.filter((x) => x.formRef === form.ref))));
  }

  // Clusters: group the leftover real fields by the container that also holds a submit-shaped control.
  const loose = c.fields.filter((f) => !used.has(f.ref) && !f.formRef && isRealField(f));
  const groups = new Map<string, FieldDesc[]>();
  for (const f of loose) {
    if (isSearchField(f)) { notes.push(`search input ignored (no <form>): ${f.ariaLabel || f.placeholder || f.name || f.id}`); continue; }
    if (!f.clusterRef) { notes.push(`input with no submit control nearby, left alone: ${f.ariaLabel || f.placeholder || f.name || f.id}`); continue; }
    if (!groups.has(f.clusterRef)) groups.set(f.clusterRef, []);
    groups.get(f.clusterRef)!.push(f);
  }
  for (const [containerRef, fields] of groups) {
    const controls = c.controls.filter((x) => x.clusterRefs.includes(containerRef));
    const controlRef = pickControl(controls);
    if (!controlRef) { notes.push(`capture cluster skipped — no usable submit control in ${containerRef}`); continue; }
    detected.push(entry("cluster", containerRef, fields, controlRef));
  }

  return { detected, notes, wired: detected.length };
}

// ---------------------------------------------------------------------------
// The DOM side: collect, then tag
// ---------------------------------------------------------------------------

/** Collect candidate descriptors. Marks every candidate with a temporary `data-atl-cand` so the second pass
 *  can find the exact same nodes without inventing selectors. */
async function collectCandidates(page: Page): Promise<Candidates> {
  return page.evaluate(() => {
    let n = 0;
    const tag = (el: Element) => {
      let r = el.getAttribute("data-atl-cand");
      if (!r) { r = "c" + n++; el.setAttribute("data-atl-cand", r); }
      return r;
    };
    const attr = (el: Element, a: string) => (el.getAttribute(a) || "").trim();
    const clippedOf = (el: Element) => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity || "1") < 0.05) return true;
      // The measured a11y-stub shape: visually hidden via clip-path while staying focusable.
      if ((cs.clipPath || "").includes("inset(50%")) return true;
      const r = el.getBoundingClientRect();
      return r.width <= 2 || r.height <= 2;
    };
    const SUBMITISH = "button,input[type=submit],input[type=button],a[role=button]";

    const fields: any[] = [];
    const controls: any[] = [];
    const forms: any[] = [];

    document.querySelectorAll("input,textarea,select").forEach((el) => {
      const r = el.getBoundingClientRect();
      const form = el.closest("form");
      // The cluster container: the nearest ancestor (within 4 hops) that also holds a submit-shaped control.
      let clusterRef = "";
      if (!form) {
        let p: Element | null = el.parentElement;
        for (let i = 0; i < 4 && p && p.tagName !== "BODY"; i++, p = p.parentElement) {
          if (p.querySelector(SUBMITISH)) { clusterRef = tag(p); break; }
        }
      }
      fields.push({
        ref: tag(el), tag: el.tagName.toLowerCase(), type: attr(el, "type").toLowerCase(),
        name: attr(el, "name"), id: el.id || "", autocomplete: attr(el, "autocomplete"),
        ariaLabel: attr(el, "aria-label"), placeholder: attr(el, "placeholder"), role: attr(el, "role"),
        required: el.hasAttribute("required"), ariaHidden: attr(el, "aria-hidden") === "true",
        tabindex: attr(el, "tabindex"), clipped: clippedOf(el),
        w: Math.round(r.width), h: Math.round(r.height),
        formRef: form ? tag(form) : "", clusterRef,
      });
    });

    document.querySelectorAll(SUBMITISH).forEach((el) => {
      if (clippedOf(el)) return;
      const form = el.closest("form");
      const clusterRefs: string[] = [];
      let p: Element | null = el.parentElement;
      for (let i = 0; i < 5 && p && p.tagName !== "BODY"; i++, p = p.parentElement) {
        const existing = p.getAttribute("data-atl-cand");
        if (existing) clusterRefs.push(existing);
      }
      controls.push({
        ref: tag(el), tag: el.tagName.toLowerCase(), type: attr(el, "type").toLowerCase(),
        text: (el.textContent || attr(el, "value") || attr(el, "aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 60),
        formRef: form ? tag(form) : "", clusterRefs,
        disabled: (el as HTMLButtonElement).disabled === true || el.hasAttribute("disabled"),
      });
    });

    document.querySelectorAll("form").forEach((f) => {
      forms.push({
        ref: tag(f),
        fieldRefs: [...f.querySelectorAll("input,textarea,select")].map((x) => x.getAttribute("data-atl-cand") || tag(x)),
        controlRefs: [...f.querySelectorAll(SUBMITISH)].map((x) => x.getAttribute("data-atl-cand") || tag(x)),
      });
    });

    return { forms, fields, controls };
  });
}

/** Apply the decisions: `data-atl-form` on each wired container, `data-atl-field="<role>[:name]"` on each
 *  field, `data-atl-submit` on the control — the same `data-atl-*` marker convention the tab and sticky
 *  runtimes already use — then drop the temporary candidate marks. */
async function applyTags(page: Page, report: FormReport): Promise<void> {
  await page.evaluate((forms) => {
    const find = (ref: string) => document.querySelector(`[data-atl-cand="${ref}"]`);
    for (const f of forms) {
      const container = find(f.containerRef);
      if (!container) continue;
      container.setAttribute("data-atl-form", String(f.id));
      container.setAttribute("data-atl-kind", f.kind);
      if (f.emailOnly) container.setAttribute("data-atl-capture", "email");
      for (const fld of f.fieldRefs) find(fld.ref)?.setAttribute("data-atl-field", fld.role + (fld.name ? ":" + fld.name : ""));
      if (f.controlRef) find(f.controlRef)?.setAttribute("data-atl-submit", String(f.id));
    }
    document.querySelectorAll("[data-atl-cand]").forEach((el) => el.removeAttribute("data-atl-cand"));
  }, report.detected);
}

// ---------------------------------------------------------------------------
// The injected runtime
// ---------------------------------------------------------------------------

export const FORM_ENDPOINT = "/api/submit";

/** Copy for the states the reference never had to render (it had a live backend). Deterministic and plain —
 *  the model is not called here, and anything cheerier would read as filler. */
export const FORM_COPY = {
  pending: "Sending…",
  successEmail: "You're subscribed.",
  success: "Thanks — we'll be in touch.",
  error: "Something went wrong. Please try again.",
};

/**
 * One script, appended before </html> exactly like clone.ts's tab and sticky runtimes.
 *
 * The honest bit: over http it really POSTs, and a failure shows the ERROR state. Only `file://` — where no
 * server can exist — falls back to localStorage, and it records `data-atl-mode="local"` plus a console line
 * so a reader (and the audit) can always tell which path ran.
 */
function formRuntime(): string {
  const c = JSON.stringify(FORM_COPY);
  return `<script id="atl-forms" type="application/json">${JSON.stringify({ endpoint: FORM_ENDPOINT, copy: FORM_COPY }).replace(/<\//g, "<\\/")}</script>
<script>(function(){
var CFG={endpoint:"${FORM_ENDPOINT}",copy:${c}};
try{var el=document.getElementById("atl-forms");if(el)CFG=JSON.parse(el.textContent)}catch(e){}
var LOCAL=location.protocol==="file:";
function fields(root){return [].slice.call(root.querySelectorAll("[data-atl-field]"))}
function value(f){return f.type==="checkbox"||f.type==="radio"?(f.checked?"yes":"no"):(f.value||"")}
function valid(root){
  var ok=true;
  fields(root).forEach(function(f){
    var v=value(f).trim(),role=(f.getAttribute("data-atl-field")||"").split(":")[0],bad=false;
    if(f.hasAttribute("required")&&!v)bad=true;
    if(!bad&&v&&role==="email"&&!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test(v))bad=true;
    if(!bad&&typeof f.checkValidity==="function"&&!f.checkValidity())bad=true;
    if(bad){ok=false;f.setAttribute("aria-invalid","true")}else{f.removeAttribute("aria-invalid")}
  });
  return ok;
}
function tell(root,msg,isError){
  // Clone a text element the reference already styled, so the confirmation inherits its typography.
  var tmpl=root.querySelector("p,span,label,div");
  var node;
  if(tmpl&&(tmpl.textContent||"").trim().length>4&&!tmpl.querySelector("input,textarea,select,button")){node=tmpl.cloneNode(false)}
  else{node=document.createElement("p")}
  node.removeAttribute&&node.removeAttribute("data-atl-field");
  node.textContent=msg;
  node.setAttribute("data-atl-state",isError?"error":"success");
  node.setAttribute("role",isError?"alert":"status");
  return node;
}
function done(root,msg,mode){
  root.setAttribute("data-atl-submitted","1");
  if(mode)root.setAttribute("data-atl-mode",mode);
  var note=tell(root,msg,false);
  [].slice.call(root.children).forEach(function(ch){ch.style.display="none"});
  root.appendChild(note);
}
function fail(root,btn,label){
  root.setAttribute("data-atl-error","1");
  if(!root.querySelector('[data-atl-state="error"]'))root.appendChild(tell(root,CFG.copy.error,true));
  restore(btn,label);
}
function restore(btn,label){if(!btn)return;btn.disabled=false;btn.removeAttribute("aria-busy");if(label!==null&&label!==undefined)btn.textContent=label}
function send(root){
  if(root.getAttribute("data-atl-submitted")==="1"||root.getAttribute("data-atl-busy")==="1")return;
  if(!valid(root)){var bad=root.querySelector('[aria-invalid="true"]');if(bad&&bad.focus)bad.focus();return}
  var btn=root.querySelector("[data-atl-submit]"),label=btn?btn.textContent:null;
  var payload={form:root.getAttribute("data-atl-form"),fields:{}};
  fields(root).forEach(function(f,i){var p=(f.getAttribute("data-atl-field")||"").split(":");payload.fields[p[1]||p[0]+(i?i:"")]=value(f)});
  var msg=root.getAttribute("data-atl-capture")==="email"?CFG.copy.successEmail:CFG.copy.success;
  if(LOCAL){
    try{var k="atl:submissions",all=JSON.parse(localStorage.getItem(k)||"[]");all.push({ts:new Date().toISOString(),form:payload.form,fields:payload.fields});localStorage.setItem(k,JSON.stringify(all))}catch(e){}
    console.log("[atelier] no server on file:// — submission stored in localStorage['atl:submissions']",payload);
    done(root,msg,"local");return;
  }
  root.setAttribute("data-atl-busy","1");
  if(btn){btn.disabled=true;btn.setAttribute("aria-busy","true");btn.textContent=CFG.copy.pending}
  fetch(CFG.endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)})
    .then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.json()})
    .then(function(){root.removeAttribute("data-atl-busy");done(root,msg,"server")})
    .catch(function(err){root.removeAttribute("data-atl-busy");console.warn("[atelier] submit failed",err);fail(root,btn,label)});
}
document.querySelectorAll("[data-atl-form]").forEach(function(root){
  if(root.tagName==="FORM")root.addEventListener("submit",function(e){e.preventDefault();send(root)});
  var btn=root.querySelector("[data-atl-submit]");
  if(btn)btn.addEventListener("click",function(e){e.preventDefault();send(root)});
  fields(root).forEach(function(f){
    f.addEventListener("input",function(){f.removeAttribute("aria-invalid")});
    f.addEventListener("keydown",function(e){if(e.key==="Enter"&&f.tagName!=="TEXTAREA"){e.preventDefault();send(root)}});
  });
});
})();</script>`;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "form-server.mjs");

/** Copy the endpoint server next to the build so a submission has somewhere real to go. Zero dependencies,
 *  so it runs with plain `node server.mjs` from the build dir. */
export async function emitFormServer(dir: string): Promise<boolean> {
  if (!existsSync(TEMPLATE)) return false;
  await copyFile(TEMPLATE, path.join(dir, "server.mjs"));
  return true;
}

/** Detect without touching anything — the probe path (and what the audit reuses). */
export async function inspectForms(page: Page): Promise<FormReport> {
  const report = detectForms(await collectCandidates(page));
  await page.evaluate(() => document.querySelectorAll("[data-atl-cand]").forEach((el) => el.removeAttribute("data-atl-cand")));
  return report;
}

/**
 * Wire the adapted page's own forms. Runs AFTER the wording swap, so the copy (including `placeholder`,
 * which swap.ts rewrites) is already the user's product's — we are only adding behaviour.
 */
export async function wireForms(indexHtmlPath: string): Promise<{ html: string; report: FormReport }> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openStatic(browser, indexHtmlPath);
    const report = detectForms(await collectCandidates(page));
    if (!report.detected.length) {
      await page.evaluate(() => document.querySelectorAll("[data-atl-cand]").forEach((el) => el.removeAttribute("data-atl-cand")));
      return { html: readFileSync(indexHtmlPath, "utf8"), report };
    }
    await applyTags(page, report);
    const doc = await page.evaluate(() => "<!doctype html>" + document.documentElement.outerHTML);
    // Append the runtime the same way emitClone appends its tab/sticky runtimes: before </html>.
    const html = doc.replace(/<\/html>\s*$/i, `${formRuntime()}\n</html>`);
    return { html, report };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// CLI — probe the detector in isolation against the clones already on disk, before paying for a build.
// ---------------------------------------------------------------------------

async function main() {
  const a = process.argv.slice(2);
  let dir = "", index = "", json = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--index") index = a[++i];
    else if (a[i] === "--json") json = true;
    else if (!a[i].startsWith("--") && !dir) dir = a[i];
  }
  if (!dir) { console.error("Usage: tsx src/behavior.ts <build-dir> [--index <file>] [--json]"); process.exit(1); }
  const indexPath = index ? path.resolve(index) : path.join(dir, "index.html");
  if (!existsSync(indexPath)) { console.error(`no index.html in ${dir}`); process.exit(1); }

  const browser = await chromium.launch({ headless: true });
  let report: FormReport;
  try {
    const page = await openStatic(browser, indexPath);
    report = await inspectForms(page);
  } finally {
    await browser.close();
  }
  if (json) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
  console.log(`\n▸ Form wiring — ${indexPath}`);
  console.log(`  ${report.detected.length} wirable form(s)`);
  for (const f of report.detected) {
    console.log(`      #${f.id} ${f.kind}${f.emailOnly ? " (email capture)" : ""} — ${f.fieldRefs.map((x) => x.role + (x.required ? "*" : "")).join(", ")}${f.controlRef ? "" : "  [no submit control — Enter only]"}`);
  }
  for (const n of report.notes) console.log(`      ! ${n}`);
  console.log("");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("\n✗ form inspection failed:", e); process.exit(1); });
}
