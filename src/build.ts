// CLI entry point for build-guide §9 step 3: the minimal Agent SDK build loop.
//   npx tsx src/build.ts "<one-line prompt>" --ds <design-system-dir> [--out <dir>] [--baseline] [--model <id>]
//
// loadArtifact() -> scaffold a Next.js+Tailwind workspace wired to the extracted tokens ->
// run a builder subagent (rails: §7 rules + vibe-coded-patterns.md + tokens) -> verify it
// builds. With --baseline, also runs the same prompt with NO design system (the raw-Claude-Code
// control) so you can A/B "our rails" vs "no rails" side by side.
import path from "node:path";
import { spawn } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadArtifact } from "./artifact/load.js";
import {
  copyTemplate,
  wireDesignSystem,
  wirePlainBaseline,
  wireExtractedComponents,
  widgetComponentName,
  PUBLIC_ASSET_PREFIX,
} from "./builder/scaffold.js";
import { composeBuilderPrompt, composeBaselinePrompt, taskPrompt, readVibePrompt, type WiredWidget } from "./builder/prompt.js";
import { repopulateAll, deriveProductName } from "./builder/repopulate.js";
import { runGate, scanSource, repairBrief, type RefProfile } from "./builder/gate.js";
import { recolorWidget } from "./builder/recolor.js";

const DEFAULT_MODEL = "claude-opus-4-8";
/** How many times the gate may send the builder back to fix banned patterns before giving up. */
const MAX_REPAIR_ROUNDS = 2;

interface Args {
  prompt: string;
  ds: string;
  out: string;
  baseline: boolean;
  model: string;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let prompt = "";
  let ds = "";
  let out = "./build";
  let baseline = false;
  let model = DEFAULT_MODEL;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--ds") ds = args[++i];
    else if (a === "--out") out = args[++i];
    else if (a === "--model") model = args[++i];
    else if (a === "--baseline") baseline = true;
    else if (!a.startsWith("--") && !prompt) prompt = a;
  }
  if (!prompt || !ds) {
    console.error('Usage: tsx src/build.ts "<one-line prompt>" --ds <design-system-dir> [--out <dir>] [--baseline] [--model <id>]');
    process.exit(1);
  }
  return { prompt, ds, out, baseline, model };
}

/** Distil the reference's DISCIPLINE from its tokens, for the critic to enforce (colour ratio +
 *  placement, the headline face, the spacing scale). */
function buildRefProfile(ds: import("./artifact/load.js").DesignSystem): RefProfile {
  const fx = ds.tokens.effects;
  return {
    colorCoveragePct: fx?.colorfulAreaPct ?? 3,
    colorCentroidY: fx?.colorCentroidY ?? 0.5,
    colorInNav: fx?.colorInNav ?? false,
    displayFont: ds.tokens.font.display,
    monoFont: ds.tokens.font.mono ?? null,
    spacingScale: ds.tokens.space,
  };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "site";
}

/** Run a shell command in a workspace, streaming output; resolve with the exit code. */
function run(cmd: string, cmdArgs: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { cwd, stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", (err) => {
      console.error(`  ! failed to spawn ${cmd}: ${err.message}`);
      resolve(1);
    });
  });
}

/** Drive the builder subagent to completion, logging progress. Returns success + cost. */
async function runBuilder(
  workspace: string,
  systemPrompt: string,
  userPrompt: string,
  model: string,
): Promise<{ ok: boolean; costUsd: number }> {
  const q = query({
    prompt: taskPrompt(userPrompt),
    options: {
      systemPrompt, // string = fully custom prompt (replaces the claude_code preset)
      model,
      cwd: workspace,
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: [], // isolation: do NOT load the atelier repo's own settings/CLAUDE.md
    },
  });

  for await (const m of q) {
    if (m.type === "assistant") {
      for (const block of m.message.content as Array<{ type: string; text?: string; name?: string }>) {
        if (block.type === "text" && block.text?.trim()) {
          console.log(block.text.trim());
        } else if (block.type === "tool_use") {
          console.log(`  · ${block.name}`);
        }
      }
    } else if (m.type === "result") {
      if (m.subtype === "success") {
        console.log(`\n  ✓ builder done — ${m.num_turns} turns, $${m.total_cost_usd.toFixed(4)}`);
        return { ok: true, costUsd: m.total_cost_usd };
      }
      console.error(`\n  ✗ builder failed (${m.subtype}): ${m.errors?.join("; ") ?? "unknown"}`);
      return { ok: false, costUsd: m.total_cost_usd };
    }
  }
  return { ok: false, costUsd: 0 };
}

/** Scaffold + install + build one workspace. `wire` injects the design system (or the plain baseline). */
async function buildOne(
  label: string,
  workspace: string,
  systemPrompt: string,
  userPrompt: string,
  model: string,
  wire: (ws: string) => Promise<void>,
  ref: RefProfile | null, // null = no gate (the no-rails baseline is deliberately ungated)
): Promise<{ ok: boolean; buildOk: boolean; costUsd: number; violations: number }> {
  console.log(`\n▸ [${label}] scaffolding → ${workspace}`);
  await copyTemplate(workspace);
  await wire(workspace);

  console.log(`  installing deps…`);
  const installCode = await run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], workspace);
  if (installCode !== 0) {
    console.error(`  ! npm install failed (exit ${installCode})`);
    return { ok: false, buildOk: false, costUsd: 0, violations: -1 };
  }

  console.log(`  running builder subagent (${model})…\n`);
  let { ok, costUsd } = await runBuilder(workspace, systemPrompt, userPrompt, model);

  console.log(`\n  verifying build…`);
  let buildCode = await run("npm", ["run", "build"], workspace);
  let buildOk = buildCode === 0;
  console.log(buildOk ? `  ✓ [${label}] builds cleanly` : `  ✗ [${label}] build failed (exit ${buildCode})`);

  // ---- THE DETERMINISTIC GATE (build-guide §8) ----------------------------
  // A banned pattern in the system prompt is only a REQUEST to the model; it drifts. The gate is the
  // constraint: render the page, check the mechanical rules, and REPAIR until it passes. This is why
  // a settled rule (no eyebrow labels) now stays settled instead of regressing every few runs.
  let violations = 0;
  if (ref !== null && buildOk) {
    for (let round = 1; round <= MAX_REPAIR_ROUNDS + 1; round++) {
      console.log(`\n  running design gate (round ${round})…`);
      // Cheap source hooks first (regex/AST), then the rendered critic. Combined into one repair pass.
      let found;
      try {
        const source = scanSource(workspace, ref.spacingScale);
        const rendered = await runGate(workspace, ref);
        found = [...source, ...rendered];
      } catch (e) {
        console.warn(`  ⚠ gate could not run (${(e as Error).message}) — shipping unverified.`);
        break;
      }
      violations = found.length;
      if (violations === 0) {
        console.log(`  ✓ [${label}] design gate PASSED — no banned patterns`);
        break;
      }
      for (const v of found) console.log(`  ✗ [${v.rule}] ${v.detail}`);
      if (round > MAX_REPAIR_ROUNDS) {
        console.error(`  ✗ [${label}] gate still failing after ${MAX_REPAIR_ROUNDS} repair round(s)`);
        break;
      }
      console.log(`\n  repairing ${violations} violation(s)…\n`);
      const repair = await runBuilder(workspace, systemPrompt, repairBrief(found), model);
      costUsd += repair.costUsd;
      buildCode = await run("npm", ["run", "build"], workspace);
      buildOk = buildCode === 0;
      if (!buildOk) {
        console.error(`  ✗ repair broke the build (exit ${buildCode})`);
        break;
      }
    }
  }
  return { ok, buildOk, costUsd, violations };
}

async function main() {
  const { prompt, ds: dsDir, out, baseline, model } = parseArgs(process.argv);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("  ⚠ ANTHROPIC_API_KEY is not set — the builder needs credentials to run.");
  }

  // Validated, typed handoff. Throws on an invalid folder, so a bad artifact never reaches the builder.
  const designSystem = loadArtifact(dsDir);
  console.log(`▸ design system: ${designSystem.manifest.source} (artifact v${designSystem.manifest.artifactVersion})`);
  if (designSystem.warnings.length) {
    console.log(`  advisories: ${designSystem.warnings.join("; ")}`);
  }

  const vibe = readVibePrompt();
  const slug = slugify(prompt);

  // One product name up front, shared by every widget AND the page — so the whole site (nav, logo,
  // metadata, and every embedded widget) is brand-consistent, not each part inventing its own name.
  const productName = await deriveProductName(prompt, model);
  console.log(`\n▸ product name: ${productName}`);

  // Repopulate the real extracted product-UI widgets with THIS product's content (§12 step 6) —
  // the proven round-trip: structure + styling preserved, only text swapped. Done once, up front.
  let repopulated: Awaited<ReturnType<typeof repopulateAll>> = [];
  if (designSystem.components.length) {
    console.log(`▸ repopulating ${designSystem.components.length} extracted widget(s) for the product…`);
    repopulated = await repopulateAll(designSystem.components, prompt, productName, model, PUBLIC_ASSET_PREFIX);

    // RECOLOUR onto the synthesized palette. The widget's craft is what we inherit; its colours are
    // not. Without this the site's identity is welded to whichever reference produced the richest
    // component (every page came out reading as Linear, because Linear owned the hero widget).
    for (const r of repopulated) {
      const rc = recolorWidget(r.html, designSystem.tokens, r.bg);
      r.html = rc.html;
      console.log(
        `  · ${r.id}: ${r.mapped} slots repopulated, ${r.unmapped} kept · recoloured ${rc.remapped} brand colour(s) ` +
          `(${rc.kept} semantic kept) → <${widgetComponentName(r.id)} />`,
      );
    }
  } else {
    console.log(`▸ no extracted widgets in this design system — building without embedded product UI.`);
  }
  const widgets: WiredWidget[] = repopulated.map((r) => ({
    id: r.id,
    name: widgetComponentName(r.id),
    role: r.role,
    width: r.width,
    height: r.height,
  }));

  // Rails build (the product).
  const railsWs = path.resolve(out, slug);
  const rails = await buildOne(
    "rails",
    railsWs,
    composeBuilderPrompt(designSystem, vibe, widgets, productName),
    prompt,
    model,
    async (ws) => {
      await wireDesignSystem(ws, designSystem);
      await wireExtractedComponents(ws, designSystem, repopulated);
    },
    buildRefProfile(designSystem),
  );

  // Optional no-rails control for the A/B. Deliberately UNGATED — it stands in for raw Claude Code,
  // and gating it would hide exactly the difference the comparison exists to show.
  let base: Awaited<ReturnType<typeof buildOne>> | null = null;
  if (baseline) {
    const baseWs = path.resolve(out, `${slug}-baseline`);
    base = await buildOne("baseline", baseWs, composeBaselinePrompt(), prompt, model, wirePlainBaseline, null);
  }

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`rails    : ${railsWs}`);
  console.log(
    `           builder ${rails.ok ? "ok" : "FAILED"}, build ${rails.buildOk ? "ok" : "FAILED"}, ` +
      `gate ${rails.violations === 0 ? "PASSED" : `FAILED (${rails.violations} violation(s))`}, $${rails.costUsd.toFixed(4)}`,
  );
  if (base) {
    console.log(`baseline : ${path.resolve(out, `${slug}-baseline`)}`);
    console.log(`           builder ${base.ok ? "ok" : "FAILED"}, build ${base.buildOk ? "ok" : "FAILED"}, $${base.costUsd.toFixed(4)}`);
  }
  console.log(`\nrun a site:  cd <dir> && npm run dev`);
  if (baseline) console.log(`A/B: open both and compare — ours must read visibly more premium (build-guide §9 step 3 gate).`);

  process.exit(rails.ok && rails.buildOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
