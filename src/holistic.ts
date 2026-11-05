// HOLISTIC clone-and-adapt (the control against the synthesis pipeline). Study ONE excellent
// reference site as a whole — from its real screenshots — and reproduce its design quality and
// coherence for a new product, with content adapted. NO token extraction, NO synthesis, NO
// design-system contract. Just: look at a great site, build something with the same taste.
//
//   npx tsx src/holistic.ts "<prompt>" --ref <screenshots-dir> [--out <dir>] [--model <id>]
import path from "node:path";
import { spawn } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { mkdir, copyFile } from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { copyTemplate, wirePlainBaseline } from "./builder/scaffold.js";
import { readVibePrompt } from "./builder/prompt.js";

const DEFAULT_MODEL = "claude-opus-4-8";

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let prompt = "", ref = "", out = "./build-holistic", model = DEFAULT_MODEL;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--ref") ref = args[++i];
    else if (a === "--out") out = args[++i];
    else if (a === "--model") model = args[++i];
    else if (!a.startsWith("--") && !prompt) prompt = a;
  }
  if (!prompt || !ref) {
    console.error('Usage: tsx src/holistic.ts "<prompt>" --ref <screenshots-dir> [--out <dir>]');
    process.exit(1);
  }
  return { prompt, ref, out, model };
}

function run(cmd: string, cmdArgs: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { cwd, stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

function holisticPrompt(vibe: string): string {
  return `You are a senior product designer and front-end engineer with world-class taste.

In ./reference/ are screenshots of ONE excellent, real website. FIRST, actually Read those images and study the site HOLISTICALLY — not as a list of values, but as a whole:
- Typography: the exact character of the fonts (serif/sans/mono, weight, the scale and rhythm of headings vs body), and how type carries the brand.
- Colour & mood: the palette, the background, the overall feeling (calm/precise/warm/confident/atmospheric).
- Composition: how space is used — column widths, whitespace, where things sit, the confidence (or density) of the layout, how sections differ from each other.
- Craft: real designed containers/cards, elevation, borders, the product-UI surface, the little details that make it read as premium and intentional.
- The GESTALT: the thing a great designer would call this site's "taste." Name it to yourself, then hit that bar.

THEN build a landing page for THIS product:

  "%PRODUCT%"

Reproduce the reference's DESIGN QUALITY, COHERENCE and SENSIBILITY — the same level of craft and the same design language — but invent ALL content (copy, section structure, product UI, data, testimonials) adapted to our product. Do NOT copy the reference's words or clone its exact product; reproduce its design quality, not its text. Where the reference shows a rich product-UI surface, DESIGN A REAL, DENSE, BELIEVABLE product-UI surface for OUR product (not a placeholder, not line-dividers faking a box — real designed components).

You have full creative freedom to match the reference's quality:
- Choose fonts to match the reference's type character. Use next/font (Google fonts like the real ones, or the closest equivalent) or self-host — do NOT settle for a monospace headline unless the reference actually uses one.
- Choose colours, spacing, layout, containers, elevation to match the reference's craft.
- Build genuinely designed sections that differ from one another — not one repeated skeleton.

Then apply this discipline so nothing reads as cheap or "vibe-coded":

${vibe}

Deliverable: rewrite app/page.tsx as the full landing page, split into real components under components/, update app/layout.tsx metadata (load your chosen fonts there), and run \`npm run build\` to verify it compiles. node_modules is already installed. Fix any errors. When done, briefly describe the reference's gestalt in one line and how you reproduced it.`;
}

async function main() {
  const { prompt, ref, out, model } = parseArgs(process.argv);
  if (!existsSync(ref)) { console.error(`reference dir not found: ${ref}`); process.exit(1); }

  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "site";
  const ws = path.resolve(out, slug);

  console.log(`\n▸ [holistic] scaffolding plain Next.js+Tailwind → ${ws}`);
  await copyTemplate(ws);
  await wirePlainBaseline(ws); // stock Tailwind, NO token wiring

  // Give the agent the reference to study.
  const refOut = path.join(ws, "reference");
  await mkdir(refOut, { recursive: true });
  const shots = readdirSync(ref).filter((f) => /\.(png|jpe?g)$/i.test(f));
  for (const f of shots) await copyFile(path.join(ref, f), path.join(refOut, f));
  console.log(`  reference: ${shots.length} screenshot(s) copied for holistic study`);

  console.log(`  installing deps…`);
  if ((await run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], ws)) !== 0) { console.error("npm install failed"); process.exit(1); }

  console.log(`  running holistic builder (${model})…\n`);
  const q = query({
    prompt: `The reference screenshots are in ./reference/. Study them, then build the product landing page.`,
    options: {
      systemPrompt: holisticPrompt(readVibePrompt()).replace("%PRODUCT%", prompt),
      model, cwd: ws,
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, settingSources: [],
    },
  });
  let cost = 0;
  for await (const m of q) {
    if (m.type === "assistant") {
      for (const b of m.message.content as Array<{ type: string; text?: string; name?: string }>) {
        if (b.type === "text" && b.text?.trim()) console.log(b.text.trim());
        else if (b.type === "tool_use") console.log(`  · ${b.name}`);
      }
    } else if (m.type === "result") {
      cost = m.total_cost_usd;
      console.log(m.subtype === "success" ? `\n  ✓ holistic done — ${m.num_turns} turns, $${cost.toFixed(4)}` : `\n  ✗ failed (${m.subtype})`);
    }
  }

  console.log(`\n  verifying build…`);
  const buildOk = (await run("npm", ["run", "build"], ws)) === 0;
  console.log(`\n──────────────────────────────────────────────`);
  console.log(`holistic: ${ws}\n          build ${buildOk ? "ok" : "FAILED"}, $${cost.toFixed(4)}`);
  console.log(`run: cd ${ws} && npm run dev`);
  process.exit(buildOk ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
