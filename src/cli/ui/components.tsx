import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";

// Atelier's own palette — a warm ochre accent on neutral greys.
export const C = {
  accent: "#D8A657",
  accentDim: "#9C7A44",
  ok: "#7FB685",
  err: "#E06C75",
  warn: "#E5C07B",
  dim: "gray",
  text: "white",
};

export function Welcome({ cwd, models }: { cwd: string; models: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor={C.accent} paddingX={1} flexDirection="column" width={64}>
        <Text><Text color={C.accent}>◆</Text> <Text bold>Welcome to Atelier</Text></Text>
        <Text> </Text>
        <Text color={C.dim}>  Design-grade websites from one prompt.</Text>
        <Text color={C.dim}>  /help for commands · esc to interrupt</Text>
        <Text> </Text>
        <Text color={C.dim}>  cwd: {cwd}</Text>
        <Text color={C.dim}>  agents: scout · designer · coder  ({models})</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={C.dim}> Tips for getting started:</Text>
        <Text color={C.dim}> 1. Describe the product — "landing page for a recruiting CRM"</Text>
        <Text color={C.dim}> 2. Name a vibe or reference — "…feels like linear.app"</Text>
        <Text color={C.dim}> 3. Keep iterating — "make the hero tighter", then /open</Text>
      </Box>
    </Box>
  );
}

export function UserLine({ text }: { text: string }) {
  return (
    <Box marginTop={1} marginBottom={1}>
      <Text color={C.dim}>❯ </Text><Text>{text}</Text>
    </Box>
  );
}

export function PhaseLine({ phase, detail }: { phase: string; detail?: string }) {
  return (
    <Box marginTop={1}>
      <Text color={C.accent} bold>◆ {phase}</Text>
      {detail ? <Text color={C.dim}>  {detail}</Text> : null}
    </Box>
  );
}

export function ToolLine({ name, arg, status, result }: { name: string; arg: string; status: "run" | "ok" | "err"; result?: string }) {
  const dot = status === "run" ? <Blink /> : <Text color={status === "ok" ? C.ok : C.err}>⏺</Text>;
  const lines = (result ?? "").split("\n").filter(Boolean).slice(0, 6);
  return (
    <Box flexDirection="column">
      <Box>
        {dot}<Text> </Text><Text bold>{name}</Text><Text color={C.dim}>(</Text><Text>{arg}</Text><Text color={C.dim}>)</Text>
      </Box>
      {status !== "run" && lines.length ? (
        <Box flexDirection="column" marginLeft={2}>
          {lines.map((l, i) => (
            <Text key={i} color={status === "err" ? C.err : C.dim} wrap="truncate-end">{i === 0 ? "⎿  " : "   "}{l}</Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

export function TextLine({ text }: { text: string }) {
  return (
    <Box>
      <Text>⏺ </Text><Text wrap="wrap">{text}</Text>
    </Box>
  );
}

export function Notice({ text, tone = "info" }: { text: string; tone?: "info" | "warn" | "error" | "success" }) {
  const color = tone === "error" ? C.err : tone === "warn" ? C.warn : tone === "success" ? C.ok : C.dim;
  const glyph = tone === "error" ? "✗" : tone === "warn" ? "!" : tone === "success" ? "✓" : "·";
  return <Box marginTop={tone === "success" ? 1 : 0}><Text color={color}>{glyph} {text}</Text></Box>;
}

function Blink() {
  const [on, setOn] = useState(true);
  useEffect(() => { const t = setInterval(() => setOn((v) => !v), 500); return () => clearInterval(t); }, []);
  return <Text color={on ? C.text : C.dim}>⏺</Text>;
}

const FRAMES = ["◇", "◈", "◆", "◈"];
const VERBS: Record<string, string[]> = {
  Scout: ["Scouting", "Surveying", "Curating"],
  Copywriter: ["Writing copy", "Rewriting", "De-branding"],
  Convert: ["Converting", "Componentizing"],
  Designer: ["Directing", "Sketching", "Naming"],
  Coder: ["Polishing", "Refining", "Compiling"],
  Verify: ["Inspecting", "Verifying"],
};

export function Spinner({ phase, startedAt, tokens }: { phase: string; startedAt: number; tokens: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((v) => v + 1), 120); return () => clearInterval(t); }, []);
  const verbs = VERBS[phase] ?? ["Working"];
  const verb = verbs[Math.floor(tick / 40) % verbs.length];
  const secs = Math.floor((Date.now() - startedAt) / 1000);
  const tk = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
  return (
    <Box marginTop={1}>
      <Text color={C.accent}>{FRAMES[Math.floor(tick / 2) % FRAMES.length]} {verb}…</Text>
      <Text color={C.dim}> ({secs}s · {tk} tokens · <Text bold>esc</Text> to interrupt)</Text>
    </Box>
  );
}

export function Todos({ items }: { items: { label: string; state: "pending" | "active" | "done" | "fail" }[] }) {
  if (!items.length) return null;
  return (
    <Box flexDirection="column" marginLeft={2}>
      {items.map((t, i) => {
        const g = t.state === "done" ? "☒" : t.state === "active" ? "◼" : t.state === "fail" ? "☒" : "☐";
        const color = t.state === "done" ? C.ok : t.state === "active" ? C.accent : t.state === "fail" ? C.err : C.dim;
        return (
          <Text key={i} color={color} strikethrough={t.state === "done"}>{i === 0 ? "⎿  " : "   "}{g} {t.label}</Text>
        );
      })}
    </Box>
  );
}

export function InputBox({ value, cursor, placeholder, disabled }: { value: string; cursor: number; placeholder: string; disabled: boolean }) {
  const before = value.slice(0, cursor);
  const at = value[cursor] ?? " ";
  const after = value.slice(cursor + 1);
  return (
    <Box borderStyle="round" borderColor={disabled ? C.dim : C.accentDim} paddingX={1} marginTop={1}>
      <Text color={disabled ? C.dim : C.accent}>❯ </Text>
      {value.length === 0
        ? <Text><Text inverse> </Text><Text color={C.dim}>{placeholder}</Text></Text>
        : <Text>{before}<Text inverse>{at}</Text>{after}</Text>}
    </Box>
  );
}

export function StatusBar({ model, usd, tokens, hint }: { model: string; usd: number; tokens: number; hint: string }) {
  const tk = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
  return (
    <Box justifyContent="space-between" paddingX={2}>
      <Text color={C.dim}>atelier · {model} · ${usd.toFixed(2)} · {tk} tokens</Text>
      <Text color={C.dim}>{hint}</Text>
    </Box>
  );
}

export const HELP = [
  "Describe a website and Atelier scouts real references, designs from their parts, and codes a Next.js site.",
  "After a build, any message is a change request to the same site.",
  "",
  "/open            preview the current site in your browser",
  "/new             start a fresh site (keeps the session cost)",
  "/model <name>    designer + coder model: sonnet (default) · haiku (cheapest) · opus",
  "/cost            usage so far",
  "/refs            cached references (free to reuse)",
  "/exit            quit",
  "",
  "esc interrupts a running step · ↑/↓ prompt history · ctrl+c twice to quit",
];
