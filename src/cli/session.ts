// The Atelier session: runs the pipeline (scout → designer → copy → componentize → coder → verify → ≤1 repair) and turns
// every SDK message into a small UI event. The pipeline order is CODE, not an orchestrator model — that removes
// a whole agent's worth of tokens per build and makes the run predictable. Each phase is its own short query()
// with a minimal custom system prompt and only the tools it needs.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, rm, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, type SDKMessage, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { AGENTS, cachedRefs, categoryMap, type AgentSpec } from "../agents/index.js";
import { hostOf } from "../reference.js";
import { componentize } from "../componentize.js";
import { swapWording } from "../swap.js";
import { probeDomains, referenceBrands, deriveProductName } from "../name.js";
import { refBrand } from "../verify-site.js";

// The Atelier project root (src/cli/ → ../..), independent of where the user launched the command.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export type UIEvent =
  | { type: "user"; text: string }
  | { type: "phase"; phase: string; status: "start" | "done" | "fail"; detail?: string }
  | { type: "tool"; id: string; phase: string; name: string; arg: string; status: "run" | "ok" | "err"; result?: string }
  | { type: "text"; phase: string; text: string }
  | { type: "todos"; items: { label: string; state: "pending" | "active" | "done" | "fail" }[] }
  | { type: "usage"; usd: number; tokens: number }
  | { type: "notice"; text: string; tone?: "info" | "warn" | "error" | "success" };

export interface SessionOpts { model?: string; onEvent: (e: UIEvent) => void }

const STEPS = ["Scout references", "Creative brief", "Adapt copy + de-brand", "Convert to React", "Finishing pass", "Verify"];

export class Session {
  private emit: (e: UIEvent) => void;
  private model?: string;
  private abort: AbortController | null = null;
  workspace: string | null = null;
  ref: string | null = null;
  private coderSession: string | null = null;
  usd = 0;
  tokens = 0;
  busy = false;
  private todo = STEPS.map((label) => ({ label, state: "pending" as "pending" | "active" | "done" | "fail" }));

  constructor(o: SessionOpts) { this.emit = o.onEvent; this.model = o.model; }

  setModel(m: string) { this.model = m; }
  get modelLabel() { return this.model ?? "haiku · sonnet"; }

  interrupt() { this.abort?.abort(); }

  private step(i: number, state: "active" | "done" | "fail") {
    this.todo[i].state = state;
    this.emit({ type: "todos", items: this.todo.map((t) => ({ ...t })) });
  }

  /** Entry point for every prompt: a new site, or a change to the current one. */
  async submit(prompt: string) {
    if (this.busy) return;
    this.busy = true;
    this.emit({ type: "user", text: prompt });
    this.abort = new AbortController();
    try {
      if (this.workspace && this.coderSession) await this.change(prompt);
      else await this.build(prompt);
    } catch (e) {
      const msg = (e as Error).message || String(e);
      if (this.abort?.signal.aborted || /abort/i.test(msg)) this.emit({ type: "notice", text: "Interrupted · tell Atelier what to do instead", tone: "warn" });
      else this.emit({ type: "notice", text: msg.split("\n")[0], tone: "error" });
    } finally {
      this.busy = false;
      this.abort = null;
    }
  }

  private async build(prompt: string) {
    this.todo = STEPS.map((label) => ({ label, state: "pending" }));
    // 1. Scout — pick an elite reference (cached when possible) and make it ready.
    this.step(0, "active");
    const cached = cachedRefs();
    const scoutOut = await this.runAgent(AGENTS.scout, `Product: "${prompt}"\n\nCached references (free, ready): ${cached.join(", ") || "none"}\nCategory map:\n${categoryMap()}`, { model: AGENTS.scout.model });
    let pick: { primary?: string; category?: string; why?: string } = {};
    const m = scoutOut.text.match(/\{[^{}]*"primary"[^{}]*\}/g);
    if (m) try { pick = JSON.parse(m[m.length - 1]); } catch { /* fall through */ }
    const primary = pick.primary ? hostOf(pick.primary) : cached[0];
    const refDir = path.join(ROOT, "output", primary ?? "");
    if (!primary || !existsSync(path.join(refDir, "outline.json"))) { this.step(0, "fail"); throw new Error("Scout could not prepare a reference — try naming one, e.g. “like stripe.com”"); }
    this.ref = primary;
    this.step(0, "done");
    this.emit({ type: "phase", phase: "Scout", status: "done", detail: `${primary}${pick.why ? " — " + pick.why : ""}` });

    const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "site";
    const ws = path.join(ROOT, "build", slug);
    const work = path.join(ROOT, "build", ".work", slug); // intermediates (brief, adapted page) — outside the workspace
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });

    // 2. Designer — the creative brief (name, promise, voice, per-section plan).
    this.step(1, "active");
    await this.runAgent(AGENTS.designer, `Product: "${prompt}"\nReference: ${primary}\nOutline: ${path.join(refDir, "OUTLINE.md")} (crops in ${path.join(refDir, "outline")}/)\nWrite: ${path.join(work, "BRIEF.md")}`, { model: this.model ?? AGENTS.designer.model, cwd: work, effort: "low" });
    const briefPath = path.join(work, "BRIEF.md");
    if (!existsSync(briefPath)) { this.step(1, "fail"); throw new Error("Designer did not produce BRIEF.md"); }
    const brief = readFileSync(briefPath, "utf8");
    const name = await this.tool("Designer", "Name", "screen candidates against real companies", async () => this.pickName(brief, prompt));
    this.step(1, "done");

    // 3. Copy + de-brand over the faithful clone (the proven clone-and-adapt path).
    this.step(2, "active");
    const adapted = path.join(work, "adapted");
    await cp(path.join(refDir, "site"), adapted, { recursive: true });
    const swap = await this.tool("Copywriter", "Adapt", `rewrite every text slot for ${name} · remove ${refBrand("https://" + primary)} identity`, async () => {
      const r = await quietly(() => swapWording(path.join(adapted, "index.html"), `${prompt}\n\nCreative brief:\n${brief}`, name, this.model ?? "sonnet", refBrand("https://" + primary)));
      await rename(path.join(adapted, "index.html"), path.join(adapted, "index.clone.html"));
      writeFileSync(path.join(adapted, "index.html"), r.value.html);
      return [`${r.value.mapped} strings rewritten${r.value.unmapped ? ` · ${r.value.unmapped} left as-is` : ""}`, ...r.logs.filter((l) => /de-|removed|logo|wall|social/i.test(l)).slice(0, 3)].join("\n");
    });
    void swap;
    this.step(2, "done");

    // 4. Convert the adapted page into a real Next.js + React + TS project (deterministic).
    this.step(3, "active");
    await this.tool("Convert", "Componentize", `build/${slug}`, async () => {
      const r = await componentize(adapted, ws, path.join(refDir, "design-system", "tailwind.tokens.js"));
      await cp(briefPath, path.join(ws, "BRIEF.md"));
      writeFileSync(path.join(ws, ".atelier.json"), JSON.stringify({ mode: "componentized", ref: "https://" + primary, refDir, product: name, createdAt: new Date().toISOString() }, null, 2) + "\n");
      return `${r.sections} section components · app/page.tsx · reference CSS + assets + fonts`;
    });
    this.workspace = ws;
    this.step(3, "done");

    // 5. Coder — a finishing pass (drop sections, fix copy, build), not a rebuild.
    this.step(4, "active");
    const code = await this.runAgent(AGENTS.coder, `Workspace: ${ws}\nProduct: ${name} — "${prompt}"\nDo the finishing pass.`, { model: this.model ?? AGENTS.coder.model, cwd: ws, effort: "low" });
    this.coderSession = code.sessionId;
    this.step(4, "done");

    // 6. Verify (+ at most one repair round)
    await this.verifyAndRepair();
  }

  /** First designer name that is clear on the common TLDs and is not a reference brand; else generate one. */
  private async pickName(brief: string, prompt: string): Promise<string> {
    const line = brief.split("\n").find((l) => /^names?:/i.test(l.trim())) ?? "";
    const avoid = new Set(referenceBrands().map((b) => b.toLowerCase()));
    const cands = line.replace(/^[^:]*:/, "").split(/[,/|]/).map((s) => s.replace(/[*_`"]/g, "").trim()).filter((s) => s && s.length <= 24 && !avoid.has(s.toLowerCase()));
    for (const c of cands) {
      const v = await probeDomains(c);
      if (v.verdict !== "collision") return c;
    }
    return deriveProductName(prompt, "haiku", { quiet: true });
  }

  private async change(request: string) {
    const ws = this.workspace!;
    this.emit({ type: "phase", phase: "Coder", status: "start", detail: "applying change" });
    const r = await this.runAgent(AGENTS.coder, `Change request for ${ws}: ${request}\nChange only what is asked. Keep the converted sections' markup and classes; new elements go in components/custom with token utilities. Rebuild, stop.`, { model: this.model ?? AGENTS.coder.model, cwd: ws, resume: this.coderSession!, effort: "medium" });
    this.coderSession = r.sessionId;
    await this.verifyAndRepair(false);
  }

  private async verifyAndRepair(track = true) {
    const ws = this.workspace!;
    if (track) this.step(5, "active");
    let v = await this.verify(ws);
    if (!v.ok) {
      this.emit({ type: "notice", text: "Verify found issues — sending one repair pass to the coder", tone: "warn" });
      const r = await this.runAgent(AGENTS.coder, `REPAIR brief from the verifier:\n${v.brief}`, { model: this.model ?? AGENTS.coder.model, cwd: ws, resume: this.coderSession!, effort: "medium" });
      this.coderSession = r.sessionId;
      v = await this.verify(ws);
    }
    if (track) this.step(5, v.ok ? "done" : "fail");
    const rel = path.relative(ROOT, ws);
    this.emit({ type: "notice", tone: v.ok ? "success" : "warn", text: v.ok
      ? `Site ready → ${rel}  ·  /open to preview  ·  describe a change to keep iterating`
      : `Site built with open issues (see above) → ${rel}  ·  /open to preview` });
  }

  private async verify(ws: string): Promise<{ ok: boolean; brief: string }> {
    let out = "";
    const ok = await this.tool("Verify", "Verify", "build · design gate · brand · responsive", () => new Promise<string>((resolve, reject) => {
      const p = spawn("npx", ["tsx", "src/verify-site.ts", ws], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
      this.abort?.signal.addEventListener("abort", () => p.kill("SIGTERM"));
      p.stdout.on("data", (b) => (out += b));
      p.stderr.on("data", (b) => (out += b));
      p.on("close", (c) => {
        const rows = out.split("\n").filter((l) => /^\s+[✓✗·]/.test(l)).map((l) => l.trim()).join("\n");
        c === 0 ? resolve(rows) : reject(Object.assign(new Error(rows || out.slice(-400)), { soft: true }));
      });
    })).then(() => true, () => false);
    const i = out.search(/Your page was rendered|REPAIR:/);
    return { ok, brief: i >= 0 ? out.slice(i) : out.slice(-1500) };
  }

  /** Run a deterministic step and render it like a tool call. */
  private async tool(phase: string, name: string, arg: string, fn: () => Promise<string>): Promise<string> {
    const id = `${name}-${Date.now()}`;
    this.emit({ type: "tool", id, phase, name, arg, status: "run" });
    try {
      const r = await fn();
      this.emit({ type: "tool", id, phase, name, arg, status: "ok", result: r });
      return r;
    } catch (e) {
      this.emit({ type: "tool", id, phase, name, arg, status: "err", result: (e as Error).message });
      throw e;
    }
  }

  /** One agent turn-loop. Streams its tool calls and text as UI events. */
  private async runAgent(spec: AgentSpec, prompt: string, o: { model: string; cwd?: string; resume?: string; effort?: "low" | "medium" | "high" }): Promise<{ text: string; sessionId: string | null }> {
    const phase = spec.label;
    this.emit({ type: "phase", phase, status: "start", detail: o.model });
    const q = query({
      prompt,
      options: {
        model: o.model,
        systemPrompt: spec.system,
        tools: spec.tools,
        settingSources: [],
        cwd: ROOT,
        additionalDirectories: o.cwd ? [o.cwd] : [],
        maxTurns: spec.maxTurns,
        abortController: this.abort ?? undefined,
        canUseTool: guard(spec, o.cwd ?? ROOT),
        // canUseTool is only consulted when the runtime would ASK — read-only shell commands are auto-approved and
        // skip it. A PreToolUse hook sees every call, so the policy is enforced here too.
        hooks: { PreToolUse: [{ hooks: [async (input: any) => {
          const d: any = await guard(spec, o.cwd ?? ROOT)(input.tool_name, input.tool_input ?? {}, { signal: new AbortController().signal } as any);
          return d?.behavior === "deny" ? { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: d.message } } : {};
        }] }] },
        ...(o.resume ? { resume: o.resume } : {}),
        ...(o.effort && !/haiku/.test(o.model) ? { effort: o.effort } : {}),
      },
    });
    let text = "", sessionId: string | null = null;
    const names = new Map<string, { name: string; arg: string }>();
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === "assistant") {
        for (const b of (msg as any).message.content as any[]) {
          if (b.type === "text" && b.text.trim()) { text += b.text + "\n"; this.emit({ type: "text", phase, text: b.text.trim() }); }
          if (b.type === "tool_use") {
            const arg = describe(b.name, b.input, o.cwd);
            names.set(b.id, { name: b.name, arg });
            this.emit({ type: "tool", id: b.id, phase, name: b.name, arg, status: "run" });
          }
        }
      } else if (msg.type === "user") {
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) for (const b of content) if (b.type === "tool_result") {
          const n = names.get(b.tool_use_id);
          if (!n) continue;
          const raw = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => c.text ?? "").join("\n") : "";
          this.emit({ type: "tool", id: b.tool_use_id, phase, name: n.name, arg: n.arg, status: b.is_error ? "err" : "ok", result: brief(n.name, raw) });
        }
      } else if (msg.type === "result") {
        const r = msg as any;
        sessionId = r.session_id ?? sessionId;
        this.usd += r.total_cost_usd ?? 0;
        const u = r.usage ?? {};
        this.tokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        this.emit({ type: "usage", usd: this.usd, tokens: this.tokens });
        if (r.subtype !== "success" && r.subtype !== "error_max_turns") throw new Error(`${phase} stopped: ${r.subtype}`);
        if (r.subtype === "error_max_turns") this.emit({ type: "notice", text: `${phase} hit its turn cap — continuing with what it produced`, tone: "warn" });
      } else if (msg.type === "system" && (msg as any).subtype === "init") {
        sessionId = (msg as any).session_id;
      }
    }
    this.emit({ type: "phase", phase, status: "done" });
    return { text, sessionId };
  }
}

/** Permission policy: each agent may only do its own job. Decided in code, so a run never stops to ask. */
function guard(spec: AgentSpec, ws: string): CanUseTool {
  const inside = (p: unknown, root: string) => typeof p === "string" && path.resolve(root, p).startsWith(path.resolve(root));
  return async (tool, input) => {
    const deny = (message: string) => ({ behavior: "deny" as const, message });
    const allow = { behavior: "allow" as const, updatedInput: input };
    if (tool === "Read" || tool === "Glob" || tool === "Grep") return inside(input.file_path ?? input.path ?? ROOT, ROOT) ? allow : deny("Only files inside the Atelier project are readable.");
    if (tool === "Write" || tool === "Edit") return spec.name !== "scout" && inside(input.file_path, ws) ? allow : deny(`Writes are limited to ${ws}.`);
    if (tool === "Bash") {
      const cmd = String(input.command ?? "").trim();
      const body = cmd.replace(/^cd [^;&|]+ && /, "").replace(/\s+2>&1\s*\|\s*(tail|head) -n? ?\d+$/, "");
      if (/[;|`$]|&&|\brm\b|\bsudo\b|\bcurl\b|\bgit\b/.test(body)) return deny("Command not allowed in Atelier. Use the Read/Glob/Grep tools to look at files.");
      const ok = spec.name === "scout"
        ? /^npx tsx src\/(reference|discover)\.ts\b/.test(body)
        : /^(npm run build|npm --prefix \S+ run build|npx tsc --noEmit|ls\b|mkdir -p\b)/.test(body);
      return ok ? allow : deny(spec.name === "scout" ? "Scout may only run src/reference.ts and src/discover.ts." : "Coder may only run `npm run build`, `npx tsc --noEmit`, ls and mkdir -p — use Read/Glob/Grep to inspect files.");
    }
    return deny("Tool not available.");
  };
}

/** The one-line argument shown next to a tool name, Claude-Code style. */
function describe(name: string, input: any, ws?: string): string {
  const rel = (p: string) => { const r = ws && p?.startsWith(ws) ? path.relative(ws, p) : path.relative(ROOT, p ?? ""); return r || p; };
  if (name === "Bash") return String(input.command ?? "").replace(/^cd \S+ && /, "").slice(0, 80);
  if (name === "Read" || name === "Write" || name === "Edit") return rel(input.file_path);
  if (name === "Glob" || name === "Grep") return String(input.pattern ?? "");
  return Object.values(input ?? {}).map(String).join(" ").slice(0, 60);
}

/** A short result summary for the ⎿ line. */
function brief(name: string, raw: string): string {
  const lines = raw.split("\n").filter((l) => l.trim());
  if (name === "Read") return /\.(jpe?g|png|webp|gif)$/i.test(raw) || !lines.length ? "Viewed image" : `Read ${lines.length} lines`;
  if (name === "Write") return "Wrote file";
  if (name === "Edit") return "Updated";
  if (name === "Glob") return `${lines.length} files`;
  if (name === "Bash") {
    const key = lines.filter((l) => /✓|✗|error|Error|ready|Compiled|failed|sections|cached|done/.test(l)).slice(-3);
    return (key.length ? key : lines.slice(-2)).map((l) => l.trim().slice(0, 110)).join("\n") || "(no output)";
  }
  return lines.slice(0, 2).join("\n").slice(0, 160);
}

/** Run library code that prints progress with console.log without letting it scribble over the UI. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ value: T; logs: string[] }> {
  const logs: string[] = [];
  const orig = { log: console.log, warn: console.warn };
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ").trim()); };
  console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(" ").trim()); };
  try { return { value: await fn(), logs }; } finally { console.log = orig.log; console.warn = orig.warn; }
}
