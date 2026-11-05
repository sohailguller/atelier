#!/usr/bin/env node
// Atelier — the interactive CLI.
//   atelier                      interactive session
//   atelier "<prompt>"           start building immediately
//   atelier --print "<prompt>"   headless (plain log, no UI) — for scripts and CI
//   --model <sonnet|haiku|opus>  designer + coder model (scout is always haiku)
import React, { useCallback, useEffect, useRef, useState } from "react";
import { render, Box, Text, Static, useApp, useInput } from "ink";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { Session, ROOT, type UIEvent } from "./session.js";
import { cachedRefs } from "../agents/index.js";
import { serveStatic } from "../verify-site.js";
import { C, Welcome, UserLine, PhaseLine, ToolLine, TextLine, Notice, Spinner, Todos, InputBox, StatusBar, HELP } from "./ui/components.js";

type Item =
  | { id: string; kind: "welcome" }
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "phase"; phase: string; detail?: string }
  | { id: string; kind: "tool"; name: string; arg: string; status: "ok" | "err"; result?: string }
  | { id: string; kind: "text"; text: string }
  | { id: string; kind: "notice"; text: string; tone?: "info" | "warn" | "error" | "success" }
  | { id: string; kind: "lines"; lines: string[] };

function parseArgs() {
  const a = process.argv.slice(2);
  let model: string | undefined, print = false; const rest: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--model") model = a[++i];
    else if (a[i] === "--print" || a[i] === "-p") print = true;
    else rest.push(a[i]);
  }
  return { model, print, prompt: rest.join(" ").trim() };
}

let seq = 0;
const nid = () => `i${++seq}`;
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
const home = (p: string) => p.replace(os.homedir(), "~");

function App({ initialPrompt, model }: { initialPrompt: string; model?: string }) {
  const { exit } = useApp();
  const [items, setItems] = useState<Item[]>([{ id: "welcome", kind: "welcome" }]);
  const [active, setActive] = useState<Record<string, { name: string; arg: string }>>({});
  const [todos, setTodos] = useState<{ label: string; state: "pending" | "active" | "done" | "fail" }[]>([]);
  const [phase, setPhase] = useState("Scout");
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState(Date.now());
  const [usage, setUsage] = useState({ usd: 0, tokens: 0 });
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState(-1);
  const [ctrlC, setCtrlC] = useState(false);
  const preview = useRef<{ close: () => void } | null>(null);

  const push = useCallback((it: DistOmit<Item, "id"> & { id?: string }) => setItems((xs) => [...xs, { id: it.id ?? nid(), ...it } as Item]), []);

  const session = useRef<Session>(null as unknown as Session);
  if (!session.current) {
    session.current = new Session({
      model,
      onEvent: (e: UIEvent) => {
        switch (e.type) {
          case "user": push({ kind: "user", text: e.text }); break;
          case "phase":
            if (e.status === "start") { setPhase(e.phase); push({ kind: "phase", phase: e.phase, detail: e.detail }); }
            else if (e.detail) push({ kind: "notice", text: `${e.phase}: ${e.detail}`, tone: "info" });
            break;
          case "tool":
            if (e.status === "run") { if (["Name", "Adapt", "Componentize", "Verify"].includes(e.name)) setPhase(e.phase); setActive((a) => ({ ...a, [e.id]: { name: e.name, arg: e.arg } })); }
            else { setActive((a) => { const n = { ...a }; delete n[e.id]; return n; }); push({ kind: "tool", name: e.name, arg: e.arg, status: e.status, result: e.result }); }
            break;
          case "text": push({ kind: "text", text: e.text }); break;
          case "todos": setTodos(e.items); break;
          case "usage": setUsage({ usd: e.usd, tokens: e.tokens }); break;
          case "notice": push({ kind: "notice", text: e.text, tone: e.tone }); break;
        }
      },
    });
  }

  const run = useCallback(async (prompt: string) => {
    setBusy(true); setStartedAt(Date.now()); setActive({});
    await session.current.submit(prompt);
    setBusy(false); setActive({});
  }, []);

  useEffect(() => { if (initialPrompt) run(initialPrompt); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const command = useCallback(async (line: string) => {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const s = session.current;
    if (cmd === "help") push({ kind: "lines", lines: HELP });
    else if (cmd === "exit" || cmd === "quit") { preview.current?.close(); exit(); }
    else if (cmd === "cost") push({ kind: "notice", text: `Session usage: $${s.usd.toFixed(3)} (API-equivalent) · ${s.tokens.toLocaleString()} tokens`, tone: "info" });
    else if (cmd === "model") {
      const m = rest[0];
      if (!m) push({ kind: "notice", text: `Designer + coder model: ${s.modelLabel}`, tone: "info" });
      else { s.setModel(m); push({ kind: "notice", text: `Designer + coder now use ${m}${m === "opus" ? " — noticeably more expensive" : ""}`, tone: m === "opus" ? "warn" : "info" }); }
    }
    else if (cmd === "refs") push({ kind: "notice", text: `Cached references: ${cachedRefs().join(", ") || "none"}`, tone: "info" });
    else if (cmd === "new" || cmd === "clear") { s.workspace = null; (s as any).coderSession = null; setTodos([]); push({ kind: "notice", text: "Starting a fresh site — describe it.", tone: "info" }); }
    else if (cmd === "open") {
      const out = s.workspace ? path.join(s.workspace, "out") : "";
      if (!out || !existsSync(path.join(out, "index.html"))) { push({ kind: "notice", text: "Nothing built yet.", tone: "warn" }); return; }
      preview.current?.close();
      const { url, server } = await serveStatic(out);
      preview.current = server;
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
      push({ kind: "notice", text: `Preview at ${url}`, tone: "success" });
    }
    else push({ kind: "notice", text: `Unknown command /${cmd} — try /help`, tone: "warn" });
  }, [exit, push]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (busy) { session.current.interrupt(); return; }
      if (ctrlC) { preview.current?.close(); exit(); return; }
      setCtrlC(true); setTimeout(() => setCtrlC(false), 1500); return;
    }
    if (key.escape) { if (busy) session.current.interrupt(); else { setValue(""); setCursor(0); } return; }
    if (busy) return;
    if (key.return) {
      const line = value.trim();
      if (!line) return;
      setHistory((h) => [line, ...h]); setHIdx(-1); setValue(""); setCursor(0);
      if (line.startsWith("/")) command(line); else run(line);
      return;
    }
    if (key.upArrow) { const i = Math.min(hIdx + 1, history.length - 1); if (i >= 0) { setHIdx(i); setValue(history[i]); setCursor(history[i].length); } return; }
    if (key.downArrow) { const i = hIdx - 1; setHIdx(i); const v = i >= 0 ? history[i] : ""; setValue(v); setCursor(v.length); return; }
    if (key.leftArrow) { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.rightArrow) { setCursor((c) => Math.min(value.length, c + 1)); return; }
    if (key.backspace || key.delete) { if (cursor > 0) { setValue(value.slice(0, cursor - 1) + value.slice(cursor)); setCursor(cursor - 1); } return; }
    if (key.ctrl && input === "u") { setValue(""); setCursor(0); return; }
    if (key.ctrl && input === "a") { setCursor(0); return; }
    if (key.ctrl && input === "e") { setCursor(value.length); return; }
    if (input && !key.ctrl && !key.meta) {
      const clean = input.replace(/\r?\n/g, " ");
      setValue(value.slice(0, cursor) + clean + value.slice(cursor)); setCursor(cursor + clean.length);
    }
  });

  const s = session.current;
  const placeholder = s.workspace ? "Describe a change… (or /open to preview)" : 'Describe a site… e.g. "landing page for a recruiting CRM"';
  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(it) => {
          switch (it.kind) {
            case "welcome": return <Welcome key={it.id} cwd={home(ROOT)} models={s.modelLabel} />;
            case "user": return <UserLine key={it.id} text={it.text} />;
            case "phase": return <PhaseLine key={it.id} phase={it.phase} detail={it.detail} />;
            case "tool": return <ToolLine key={it.id} name={it.name} arg={it.arg} status={it.status} result={it.result} />;
            case "text": return <TextLine key={it.id} text={it.text} />;
            case "notice": return <Notice key={it.id} text={it.text} tone={it.tone} />;
            case "lines": return <Box key={it.id} flexDirection="column" marginLeft={2} marginY={1}>{it.lines.map((l, i) => <Text key={i} color={C.dim}>{l || " "}</Text>)}</Box>;
          }
        }}
      </Static>
      {Object.entries(active).map(([id, t]) => <ToolLine key={id} name={t.name} arg={t.arg} status="run" />)}
      {busy ? <Spinner phase={phase} startedAt={startedAt} tokens={usage.tokens} /> : null}
      {busy ? <Todos items={todos} /> : null}
      <InputBox value={value} cursor={cursor} placeholder={placeholder} disabled={busy} />
      <StatusBar model={s.modelLabel} usd={usage.usd} tokens={usage.tokens} hint={ctrlC ? "press ctrl+c again to exit" : busy ? "esc to interrupt" : "/help for commands"} />
    </Box>
  );
}

/** Headless mode: same pipeline, plain lines. */
async function headless(prompt: string, model?: string) {
  const t0 = Date.now();
  const s = new Session({
    model,
    onEvent: (e) => {
      const ts = `[${String(Math.floor((Date.now() - t0) / 1000)).padStart(4)}s]`;
      if (e.type === "phase" && e.status === "start") console.log(`${ts} ◆ ${e.phase}${e.detail ? "  " + e.detail : ""}`);
      else if (e.type === "phase" && e.detail) console.log(`${ts}   ${e.phase}: ${e.detail}`);
      else if (e.type === "tool" && e.status !== "run") console.log(`${ts}   ${e.status === "ok" ? "⏺" : "✗"} ${e.name}(${e.arg})${e.result ? "\n" + e.result.split("\n").slice(0, 4).map((l) => "         ⎿ " + l).join("\n") : ""}`);
      else if (e.type === "text") console.log(`${ts}   ${e.text.split("\n").join("\n         ")}`);
      else if (e.type === "notice") console.log(`${ts} ${e.text}`);
    },
  });
  await s.submit(prompt);
  console.log(`\nusage: $${s.usd.toFixed(3)} (API-equivalent) · ${s.tokens.toLocaleString()} tokens · ${Math.round((Date.now() - t0) / 1000)}s`);
}

const args = parseArgs();
process.chdir(ROOT);
if (args.print) {
  if (!args.prompt) { console.error('Usage: atelier --print "<prompt>"'); process.exit(1); }
  headless(args.prompt, args.model).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
} else {
  render(<App initialPrompt={args.prompt} model={args.model} />, { exitOnCtrlC: false });
}
