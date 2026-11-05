// Builds the two system prompts the loop uses:
//   - composeBuilderPrompt(): the RAILS prompt — §7 rules + the vibe-coded-patterns.md LLM
//     prompt (verbatim) + the concrete extracted token facts and the exact Tailwind utility
//     names available. This is where "our rails beat no rails" lives.
//   - composeBaselinePrompt(): the NO-RAILS control — a plain senior-engineer instruction with
//     no design system and no rubric, standing in for raw Claude Code on the same prompt.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DesignSystem } from "../artifact/load.js";
import type { Tokens, Layout } from "../artifact/schema.js";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

/**
 * Pull the "## LLM Prompt" section out of vibe-coded-patterns.md verbatim (build-guide §2/§8:
 * this is the builder's design-discipline rubric). Falls back to a short stub if the marker
 * moves, so the loop never silently ships without the discipline layer.
 */
export function readVibePrompt(): string {
  const md = readFileSync(path.join(REPO_ROOT, "vibe-coded-patterns.md"), "utf8");
  const start = md.indexOf("You are a senior product designer");
  if (start === -1) {
    return "Design clean, premium, intentional UI. Avoid every hallmark of rushed 'vibe-coded' work.";
  }
  return md.slice(start).trim();
}

/** The exact Tailwind utility names the workspace exposes, derived from the real token fragment. */
function tailwindUtilityFacts(ds: DesignSystem): string {
  const frag = require(ds.tailwindPath) as {
    colors?: Record<string, string>;
    fontFamily?: Record<string, unknown>;
    fontSize?: Record<string, unknown>;
    spacing?: Record<string, string>;
    borderRadius?: Record<string, string>;
    boxShadow?: Record<string, string>;
    screens?: Record<string, string>;
  };
  const keys = (o?: Record<string, unknown>) => (o ? Object.keys(o) : []);
  const colors = keys(frag.colors);
  const fonts = keys(frag.fontFamily);
  const type = keys(frag.fontSize);
  const space = keys(frag.spacing);
  const radius = keys(frag.borderRadius);
  const shadow = keys(frag.boxShadow);
  const screens = keys(frag.screens);

  const roundedName = (k: string) => (k === "DEFAULT" ? "rounded" : `rounded-${k}`);
  return [
    `Colors → bg-<c> / text-<c> / border-<c>, where <c> ∈ { ${colors.join(", ")} }.`,
    `Fonts → font-<f>, where <f> ∈ { ${fonts.join(", ")} }.`,
    `Type ramp → text-<role>, where <role> ∈ { ${type.join(", ")} } (each carries its extracted size + line-height).`,
    `Spacing (padding/margin/gap/width/height/inset) → the ONLY scale steps are { ${space.join(", ")} } (px). e.g. p-16, gap-8, mt-32. No other numbers, no arbitrary values like p-[13px].`,
    `Radius → ${radius.map(roundedName).join(", ")}. Nothing else.`,
    `Shadow → ${shadow.map((s) => `shadow-${s}`).join(", ")}. Use one elevation; do not invent others.`,
    `Breakpoints → ${screens.map((s) => `${s}:`).join(", ")} prefixes for responsive variants.`,
  ].join("\n");
}

/** The extracted dimensional treatment: real gradient fills, the ambient glow, and — just as
 *  important — how sparingly the reference allows colour to appear. */
function effectsFacts(t: Tokens): string {
  const fx = t.effects;
  if (!fx || !fx.gradients.length) {
    return `# Surfaces & colour
No gradients were extracted from this reference. Keep surfaces flat but NEVER dead-flat black: use \`bg-surface\` vs \`bg-bg\` and the extracted \`border\` colour to separate planes. Use the accent colour sparingly.`;
  }
  const ambient = fx.gradients.find((g) => g.kind === "ambient");
  const names: string[] = [];
  let s = 0;
  let a = 0;
  for (const g of fx.gradients) {
    names.push(
      g.kind === "ambient" ? "bg-grad-ambient"
      : g.kind === "text" ? "bg-grad-text"
      : g.kind === "accent" ? `bg-grad-accent-${++a}`
      : `bg-grad-surface-${++s}`,
    );
  }
  const accents = names.filter((n) => n.startsWith("bg-grad-accent"));
  const surfaces = names.filter((n) => n.startsWith("bg-grad-surface"));
  return `# Surfaces & colour — DIMENSIONAL, and colour is RARE (both halves are the design)
The reference is NOT dead-flat black, and it is NOT colourful either. Both facts are extracted and binding:

1) Real dimensional gradients — the reference's ACTUAL CSS, pre-wired as utilities. Use these; never hand-write a gradient:
${fx.gradients.map((g, i) => `   - \`${names[i]}\` — ${g.kind}, ~${g.w}×${g.h}px, on ${g.count} element(s) in the reference.`).join("\n")}

2) **Colour is deliberately rare: only ${fx.colorfulAreaPct}% of the reference's painted area is saturated, across ~${fx.colorfulSurfaces} surface(s).** The page is essentially monochrome and colour lands on one or two surfaces and NOWHERE else. That ratio IS the design; smearing colour around is the loudest vibe-coded tell there is.

How to apply it:
- ${ambient ? `\`bg-grad-ambient\` ONCE, as a soft page/hero background glow — large, subtle, no hard edge. This is what stops the page reading as dead-flat black.` : `No ambient glow was extracted; separate planes with \`bg-surface\` against \`bg-bg\` instead so sections are never flat.`}
- ${accents.length ? `${accents.join(" / ")} = the RARE COLOURFUL fill (in the reference this is a single colour-washed card, e.g. a testimonial). Use it on **exactly one, at most two** small surfaces — a testimonial/quote card is its natural home. This is the ONLY place colour appears on your page.` : `No colourful accent fill was extracted — keep the page monochrome and rely on plane changes for interest.`}
- ${surfaces.length ? `${surfaces.slice(0, 3).join(" / ")} = SUBTLE, MONOCHROME depth fills. These are not colour — use them to give cards/panels dimension. Safe to use on a few surfaces.` : ``}
- Everything else stays monochrome (bg / surface / border / text / muted). Do NOT tint sections, do NOT gradient the headline, do NOT put a coloured glow on every card.
- NEVER leave a section as dead-flat black with only text on it. Every section carries a product widget, a gradient/plane change, or a real visual.`;
}

/** The measured layout skeleton, as concrete builder constraints (numbers, not adjectives). */
function layoutFacts(L: Layout): string {
  const density =
    L.density < 0.45
      ? "SPARSE and confident — few elements per section, lots of empty space; do NOT fill every gap with filler"
      : L.density > 0.8
        ? "information-dense where content genuinely warrants it (e.g. a product-UI surface), but always aligned and precise"
        : "balanced — neither sparse nor cramped";
  const hero =
    L.heroViewportRatio >= 0.9
      ? `a tall hero (~${Math.round(L.heroViewportRatio * 100)}% of viewport height) with generous room around the headline`
      : `a hero ~${Math.round(L.heroViewportRatio * 100)}% of viewport height`;
  return [
    `- Content column: max-width ${L.containerMaxWidth}px — put section inner-wrappers in \`max-w-container\` (already wired), centered, with ~${L.gutter}px side gutters. The column is WIDE (${Math.round(L.contentWidthRatio * 100)}% of viewport); NEVER trap content in a narrow centered strip with dead space either side.`,
    `- Vertical rhythm: ~${L.sectionSpacing}px between major sections — use the token step \`py-${L.sectionSpacing}\` (it is on the spacing scale). This generous rhythm is the measured antidote to cramped; apply it consistently.`,
    `- Hero: ${hero}; headline ${L.headlineAlign}-aligned.`,
    `- Primary grid: ${L.grid.columns} columns${L.grid.gutter ? `, ${L.grid.gutter}px gutter` : ""} for feature rows.`,
    `- Density: ${density}.`,
  ].join("\n");
}

function typeRampTable(tokens: Tokens): string {
  const rows = Object.entries(tokens.type).map(
    ([role, t]) => `  ${role}: ${t.size}px / line ${t.line} / weight ${t.weight} / tracking ${t.tracking} / case ${t.case}`,
  );
  return rows.join("\n");
}

/** Info about the wired extracted widgets, so the builder embeds (never rebuilds) them. */
export interface WiredWidget {
  id: string;
  name: string; // React component name exported from @/components/extracted/widgets
  role: string;
  width: number;
  height: number;
}

/** The extracted-widgets section of the builder prompt (empty when a reference yielded none). */
function widgetFacts(widgets: WiredWidget[]): string {
  if (!widgets.length) {
    return `# Extracted product-UI widgets
None were extracted from this reference (it is text-only marketing, or its product UI was un-extractable). Do NOT fabricate a fake dashboard/product screenshot to compensate — compose with type, layout, and restrained inline-SVG line art instead.`;
  }
  const hero = widgets[0];
  const rest = widgets.slice(1);
  const list = widgets
    .map(
      (w, i) =>
        `- \`<${w.name} />\`${i === 0 ? " (HERO)" : ""} — a real ${w.role} (${w.width}×${w.height}px), already repopulated with THIS product's content and self-scaling to fit its container.`,
    )
    .join("\n");
  return `# Extracted product-UI widgets — a LIBRARY, one per section (THE differentiator)
This is the single most important asset you have: ${widgets.length} REAL, designed product-UI screens lifted from premium references as self-contained markup and repopulated with this product's content. Each is a DIFFERENT screen (e.g. a dashboard, a board, a timeline, a code/diff view). Their craft — layout, density, alignment, micro-typography, elevation — is exactly the references' and you cannot reproduce it by hand. Import them all:
\`import { ${widgets.map((w) => w.name).join(", ")} } from "@/components/extracted/widgets";\`

${list}

HARD RULES (this is what fixes "one great hero then flat slop below"):
- EVERY major content section gets a real product visual as its centerpiece — use these widgets, each roughly ONCE, spread DOWN the page. Do not cluster them all at the top. ${rest.length ? `Place \`<${hero.name} />\` in the hero; distribute ${rest.map((w) => `\`<${w.name} />\``).join(", ")} across the sections below as each section's main visual.` : ""}
- EMBED each as-is. Do NOT restyle, wrap in an extra border/frame, re-implement, or "improve" them. They self-scale — just drop each into a centered container (e.g. \`max-w-container mx-auto\`) and let it fill.
- BANNED as section visuals: flat text-only sections, tiny mockups, empty black bands, and generic icon-card grids standing in for product imagery. If a section has no widget, give it a real extracted visual anyway or fold it into a section that has one — never ship a flat filler section.
- The hero widget is the hero's centerpiece: a large product visual BELOW the headline (not a small box beside it), centered.
- Everything you compose (nav, copy, sections, footer) must read as the SAME product as what's inside these widgets — read their content and stay consistent (brand name, domain, terminology).`;
}

/** The RAILS system prompt: §7 rules + the vibe rubric + concrete token facts. */
export function composeBuilderPrompt(ds: DesignSystem, vibePrompt: string, widgets: WiredWidget[] = [], productName = ""): string {
  const t = ds.tokens;
  const palette = Object.entries(t.color)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");

  return `You are the atelier builder — a senior product designer and front-end engineer. You build an ORIGINAL landing page constrained hard by a design system that was extracted from a real, premium reference site. The whole point is that you do NOT improvise design: you inherit a proven visual grammar and invent only the composition.

# The single most important rule
Every visual value — every color, font, type size, spacing step, radius, shadow — comes from the design system below, expressed through the pre-wired Tailwind utilities. Never hand-write a raw hex, a raw px value, an arbitrary Tailwind value (e.g. bg-[#8b5cf6], p-[13px]), or a utility whose scale step is not listed. If you need a value that isn't available, you are wrong about the design — pick the closest token.

# What you inherit vs. what you invent (build-guide §7)
- You inherit: the palette, the type ramp, the radius policy, the shadow/elevation, the signature components (see design/components.md).
- You do NOT receive and must NOT reconstruct the reference site's section order or page skeleton. Build the information architecture from the USER'S product, not from any reference. Invent the composition.
- Where the product's specifics are ambiguous, make one clear, grounded assumption and proceed — do not stall.
${productName ? `- The product is named "${productName}". Use this EXACT name everywhere — nav/logo, page metadata (title/description), and body copy. The embedded product widgets already use "${productName}" internally, so the page and the widgets must match.` : ""}

# The design system (source of truth)
Palette:
${palette}

Type ramp:
${typeRampTable(t)}

Fonts: display="${t.font.display}", ui="${t.font.ui}"${t.font.mono ? `, mono="${t.font.mono}"` : ""}.

The exact Tailwind utilities available (use ONLY these):
${tailwindUtilityFacts(ds)}

Signature component recipes are in design/components.md — read it and reproduce the primary button and card faithfully. The full machine-readable tokens are in design/tokens.json.

# Layout (MEASURED from the references — reproduce this spatial skeleton, do NOT improvise it)
Layout is where generic builds fail: cramped, trapped in a narrow centered column, tight vertical spacing. These are REAL MEASURED values from premium sites. Treat them as hard constraints — they are the difference between confident and cramped:
${layoutFacts(t.layout)}

${effectsFacts(t)}

${widgetFacts(widgets)}

# The workspace
A Next.js (App Router) + Tailwind v3 project is already scaffolded in the current directory. tailwind.config.js already loads the tokens; app/globals.css already imports the real fonts and sets the base background/text. Your job:
- Rewrite app/page.tsx as the landing page. Split meaningful sections into components under components/ (e.g. Nav, Hero, Features, CTA, Footer) — real, product-specific sections, not the reference's.
- Update the metadata export in app/layout.tsx (title + description, grounded and specific to the product — replace the placeholder defaults).
- Real, specific copy grounded in what the product actually does. No filler taglines, no Lorem, no placeholder text. Testimonials, if any, must read as real (or omit them). Every link must go somewhere real or be omitted — no href="#".
- You may run \`npm run build\` (or \`npx tsc --noEmit\`) via bash to check your work; node_modules is already installed. Fix any errors before finishing.

# Composition, content & interaction rules (CHECKABLE — these override any generic default)
Hard rules from the step-3 test. Vague taste makes you fall back to a bland generic default, so each rule is checkable — satisfy every one. These are UNIVERSAL; none of them describes how one specific site looks.

Composition (no monotony, no AI tells):
- Use ≥3 DISTINCT layout types across the page, and NO section repeats the previous section's layout. Types: text-left/visual-right, visual-left/text-right, full-bleed visual, full-width row of 3+ with captions, centered-heading/asymmetric-below.
- Use the FULL horizontal width. Do not trap content in a narrow centered column with dead space on both sides (a classic AI tell). Visuals and backgrounds may go edge-to-edge.
- Vary the section header treatment — do not stack heading-over-subhead in every section.
- Subheadlines are OPTIONAL: at least 2 sections have NO subhead, and vary placement (sometimes beneath the heading, sometimes beside it).

Content bands (add real ones — never fake proof):
- Include real content variety beyond a feature list where it fits. Testimonials must be specific and plausible — full name + title + company + a concrete quote about a real outcome. Never a vague "Sarah P." line. Omit a band rather than ship a weak or fake one, and never fabricate customer "proof".

Banned (vibe-coded tells — never emit):
- **NO generic icon-card grid.** A row of plain bordered boxes, each with a small icon above a bold label and two lines of grey text, is THE canonical vibe-coded feature section. Never build one. If a section has no extracted widget, give it a real visual instead: a gradient surface card, a full-bleed plane change, a dense typographic/number treatment, or fold it into a neighbouring section that does have a widget. Every section earns its visual.
- NO eyebrow / kicker labels: no small mono or uppercase label sitting above a headline. A section's label is just its heading.
- NO emojis, NO self-invented glyphs, NO Lucide/Heroicons. If you need iconography, draw simple inline SVG line shapes consistent with the extracted grammar (thin strokes, currentColor). Prefer text and shapes over icons when in doubt.
- NO color, gradient, or accent that is not in tokens.json / the pre-wired gradient utilities. Use the extracted accent SPARINGLY (see the colour-restraint ratio above). Palette fidelity is the rule: if the tokens are monochrome the page reads monochrome, with colour only where the reference puts it.
- NO dead-flat black sections. Flat everywhere is as wrong as colourful everywhere.

Typography (the FULL extracted system — do not improvise):
- Every text element uses a \`text-<role>\` utility. Each one now carries the reference's real size, line-height, letter-spacing AND weight together — so do NOT add your own \`font-*\` weight or \`tracking-*\` class on top; that overrides the extracted type and is what makes copy read generic.
- Use the secondary tiers where they belong: \`text-small\` for captions/meta/muted lines, \`text-lead\` for an intro paragraph, if those roles exist in the ramp below. Body copy is \`text-body\`. Do not use raw Tailwind sizes (text-sm/text-lg/etc.) — they are not the extracted type.

Interaction rule (STRICT — applies to everything):
- Permitted: subtle FUNCTIONAL motion only — eased collapse/expand, a gentle fade-in, a clean static gradient background — plus functional (never decorative) behavior on any interactive element (a tab must switch, an accordion must open and close).
- BANNED everywhere on marketing elements: hover-lift, card float, bounce, scroll-triggered slide-in, wiggle, or ANY decorative motion. When in doubt, no motion.

# Design discipline (apply this rubric to everything you produce)
${vibePrompt}

Build the complete landing page now. When done, briefly report the file structure you created.`;
}

/** The NO-RAILS control: generic instruction, no design system, no rubric. */
export function composeBaselinePrompt(): string {
  return `You are a senior front-end engineer. A blank Next.js (App Router) + Tailwind CSS project is scaffolded in the current directory. Build a good-looking landing page for the product described by the user.

- Rewrite app/page.tsx and split sections into components under components/ as you see fit.
- Update the metadata in app/layout.tsx.
- You may run \`npm run build\` via bash to check your work; node_modules is already installed. Fix any errors before finishing.

Build the landing page now.`;
}

/** The user/task message for a given product prompt. */
export function taskPrompt(userPrompt: string): string {
  return `The product to build a landing page for: "${userPrompt}".`;
}
