# Build Guide — Design-Aware AI Coder (CLI)

A working CLI you run yourself. You type one prompt ("build a prediction market app")
and it produces a genuinely premium-looking site — not the generic "vibe-coded" output
that Claude Code, Lovable, and v0 produce by default.

It works by NOT letting the model improvise design. It borrows from real, proven
reference sites, extracts their design systems, builds something original constrained by
those tokens, and reviews the result against the vibe-coded checklist
(`vibe-coded-patterns.md`) before finishing.

This is not a research project. The extraction process below already works reliably
across projects when done by hand. The job here is to automate it into one command —
including the recovery steps that already happen every time (see §4), so the tool handles
them without a human in the loop.

---

## 1. What it is, mechanically

A wrapper around the **Claude Agent SDK** (Claude Code exposed as a TypeScript/Python
library) that runs a four-stage pipeline from a single CLI command:

1. **Route** — turn the prompt into a category, map that category to 2–3 canonical real
   reference sites (prediction market → Polymarket, Kalshi).
2. **Extract** — pull a real design system (tokens + assets) from those sites, using the
   proven procedure in §4.
3. **Build** — generate an ORIGINAL site constrained hard by the extracted tokens;
   inherit the visual grammar, never clone the source's structure.
4. **Critic** — render the result, run the `vibe-coded-patterns.md` checklist against it,
   revise until clean, then present.

Claude does the actual coding at every stage. The harness is the manager encoding your
process and taste; Claude is the engineer executing each step. Same model everyone else
uses — the edge is the rails, not the model.

---

## 2. The core bet

Not a better model — the same Claude. The bet is that **our rails beat no rails.** Generic
tools are Claude Code with nothing clamped on, so they improvise the exact things that
look cheap. Ours is the identical engine with rails built from real design-system
extraction plus the 500-site research. The rails live in four places:

- Pipeline ORDER (route → extract → build → critic) = the process.
- Builder subagent system prompt (inherit grammar, never clone skeleton, every value from
  tokens.json) = the instructions.
- Extractor procedure + recovery steps (§4) = the extraction method.
- Category map (which real sites a product borrows from) = the taste, and the moat.
- `vibe-coded-patterns.md` = the "avoid" rubric the critic enforces.

---

## 3. Stack

- **Claude Agent SDK** (TypeScript — pairs naturally with Playwright and the web output).
  Bundles the Claude Code binary; no separate CLI install needed.
- **Playwright** for the browser: navigation, CSSOM/computed-style probes, screenshots.
- **Next.js + Tailwind** as the build target. Tailwind's `theme.extend` is a clean place
  to inject extracted tokens as the single source of truth.
- **The `frontend-design` skill** (already in Claude Code) as the builder's styling
  discipline layer.
- **MCP** to expose the extractor as tools the orchestrator calls (SDK supports it
  natively).

Surface: a **CLI you run yourself.** No auth, no hosting, no web UI. Type a prompt, get a
site. Wrapping it for other people is a separate later job once the engine is proven.

Setup:

```bash
mkdir design-coder && cd design-coder
npm init -y
npm install @anthropic-ai/claude-agent-sdk
npm install -D typescript @types/node tsx
npm install playwright && npx playwright install chromium
export ANTHROPIC_API_KEY=your-api-key
```

---

## 4. The extraction procedure (the proven core)

This is the process that already works by hand across projects. Two layers: the happy
path (same every time), and the recovery layer (the same snags recur every time and get
routed around). Both must be automated so the tool never needs a human to catch a snag.

### Happy path (runs the same every project)

1. Open the reference site in a real browser (Playwright).
2. Take screenshots for the visual channel.
3. Run the style probes off the CSSOM / computed styles:
   - `@font-face` enumeration + resolve absolute font URLs (`new URL(src, sheet.href)`).
   - Per-role computed styles (body/h1/h2/h3/a/button/nav): fontFamily, fontSize,
     fontWeight, lineHeight, letterSpacing, textTransform, color, backgroundColor.
   - Color-frequency count across links/buttons/headings → the true accent color.
   - CTA rule capture: border, borderRadius, padding from the real button.
   - Pseudo-element `::before`/`::after` clipPath → signature components.
   - `backgroundImage` enumeration → asset URLs.
   - Spacing sample across sections → cluster into a scale.
   - `boxShadow` on cards/surfaces/buttons → elevation.
   - Media queries from the CSSOM → breakpoints.
4. Download all referenced fonts and SVGs into the workspace; verify them.
5. Emit a self-contained `design-system/` folder (see §5).
6. Rebuild from those tokens — original composition, not a structural copy.

### Recovery layer (the snags that recur EVERY project — automate each)

These happen every time when done by hand and get worked around manually. The tool must
detect and handle each automatically:

- **Screenshots fail / come back empty** → fall back to DOM measurement
  (`getBoundingClientRect`, CSSOM rule text, pseudo-element computed styles) to reconstruct
  the visual channel. Also: run a startup screenshot health check so the tool KNOWS
  whether it has the visual channel or is running on measurement alone.
- **Spacing scale doesn't come through cleanly** → infer a sensible 4/8-point scale from
  the sampled paddings/margins rather than leaving it blank.
- **Shadows / other tokens don't extract** (e.g. flat sites report none) → detect the
  absence explicitly and either record "none" intentionally or synthesize one restrained
  elevation style, rather than silently omitting it.
- **Assets resolve to dead `url()`s** → the download+verify step must actually fetch the
  binaries into the workspace so no token points at a dead URL.

The point: when you drive this by hand, you notice each snag and route around it. The
one-prompt tool has no human watching, so each recovery becomes a coded branch. This
recovery layer is most of the engineering work — the happy path is straightforward.

### When a reference resists: diagnose and fix, never swap (policy)

The product's value is borrowing from the BEST sites, and the best sites are often the hardest
to extract. So when a chosen reference resists extraction, do NOT swap it for an easier target.
Diagnose the cause and classify it:

- **Fixable extractor gap** — heavy CSS-in-JS, lazy-loaded styles, a dismissible consent gate, a
  sparse sample that truncates a scale, a mis-scored primary button. Fix it, so the extractor
  gets stronger for every future site. (Step-3 example: Vercel's spacing scale first truncated at
  20px because a flat frequency floor dropped rare section-level paddings — fixed with a
  magnitude-weighted canonical-ladder selection in `buildSpacing`.)
- **Fundamental limitation** — pure canvas/WebGL or video-only rendering with no readable DOM, an
  auth wall, a hard bot block. Document it as a known boundary rather than pretend it works, and
  pick the reference knowing the limit.

Judge every extracted token against the rendered screenshot, not just the DOM numbers — a token
can be "real" but not faithful (see `context.md`).

**Known extraction-hardening items (open):**

- **Accent extraction** misses real brand accents that aren't used over a large enough area — e.g.
  Railway's pink/purple reads as monochrome because its colour lives in gradients/incidental UI, so
  it falls back to white. This also *undersells synthesis*: a multi-site synthesized palette is more
  monochrome than the sources truly are. Improving accent extraction (detect gradient/brand accents,
  not just large flat fills) unlocks more distinctive synthesized palettes — worth doing, deferred.
- **Primary-button detection** can mis-score a ghost header button (e.g. Vercel's white "Log In")
  over the real filled CTA, which then drives a wrong accent/CTA recipe. A contrast guard on the
  accent fallback now prevents an *unusable* accent; scoring the filled dark CTA above a ghost one
  is a separate, deliberate improvement (not yet done).
- **Section-level spacing** is inherently sparse in the sample set, so the very top of a large
  site's scale can still be undersold (Vercel tops out ~48px). The deeper lever is sampling
  section spacing explicitly in the probe; deferred until a real build looks wrong.

---

## 5. The standard artifact (the handoff interface)

The extractor emits a self-contained folder. This is the interface between extract and
build, so standardize it first.

```
/design-system/
  tokens.json          # machine-readable SCALES — single source of truth
  tailwind.tokens.js    # tokens compiled into a Tailwind theme fragment
  fonts/               # the actual downloaded font files (never dead url()s)
  assets/              # extracted SVGs / textures, real files
  components.md        # signature component recipes (e.g. a clipPath button)
  screenshots/         # reference captures for the critic to compare against
  SPEC.md              # human-readable spec + provenance (which site, when)
```

`tokens.json` must carry SCALES, not one-off values:

```jsonc
{
  "color":       { "bg": "...", "surface": "...", "accent": "...", "text": "..." },
  "font":        { "display": "...", "ui": "..." },
  "type":        { "h1": { "size": 60, "line": 60, "weight": 500, "tracking": 1, "case": "upper" }, "...": {} },
  "space":       [4, 8, 12, 16, 24, 32, 48, 64],
  "radius":      [0],                      // capture what the site actually uses; don't guess
  "shadow":      { "sm": "...", "md": "..." },
  "breakpoints": { "sm": 640, "md": 768, "lg": 1024 }
}
```

If a probe returns nothing, the recovery layer (§4) fills or explicitly records it — the
artifact is never left with silent gaps.

---

## 6. The category map (the moat)

Not the model, not the SDK. The defensible asset is taste encoded as data: which real
sites a given kind of product should borrow from. Ship 8–12 categories, 2–3 canonical
references each. A weekend of curation.

- Prediction / trading → Polymarket, Kalshi
- Dev tool / infra → Linear, Vercel, Railway
- Fintech / banking → Stripe, Mercury
- Dashboard / analytics → Linear, Retool
- Marketplace → (2–3 clean ones)
- Portfolio / personal → (a more expressive set)
- Docs → Stripe docs, Linear docs
- E-commerce → (clean DTC references)
- SaaS landing → (a restrained set)

Curate for EXTRACTABILITY, not just beauty: low-entropy systems win — one accent, a
consistent radius policy, a clear two-font role split, repeatable components, self-hosted
fonts at predictable URLs, tokens expressed as real CSS the CSSOM can read (not obfuscated
CSS-in-JS). Messy sites with nine accents, random radii, and runtime-injected styles fight
the extractor.

It's just a JSON file the router reads.

---

## 7. The builder subagent (original, not clone)

The builder receives the design system by calling `loadArtifact(dir)` (`src/artifact/load.ts`) —
the typed, contract-validated handoff (see `ARTIFACT.md`, artifact v1.0). It never reads the
raw folder directly; a folder that fails validation never reaches the builder.

Rules baked into its system prompt:

- You receive tokens + fonts + signature components only. You do NOT receive, and must not
  reconstruct, the source site's section order or page skeleton.
- Build the information architecture from the USER'S product, not the reference. Ask (or
  clearly flag an assumption) about what the product actually is.
- Inherit the visual grammar (palette, type ramp, radius policy, signature component).
  Invent the composition.
- Every value comes from `tokens.json`. No off-scale spacing, no new radii, no new accents.
- Feed tokens through the `frontend-design` skill for styling discipline.
- Apply the `vibe-coded-patterns.md` builder prompt as your design discipline.

Refined by the step-3 test (`test-findings.md`). Vague guidance makes the builder fall back
to a bland generic default, so every taste judgment below is written as a **checkable rule** —
keep it that way when adding more. These are the UNIVERSAL premium rules. Category-specific
content types and aesthetics — which visual KINDS, header styles, content bands, icon/logo
libraries, product-UI surfaces — come from the category map (`category-map-schema.md`), never
hardcoded here. A rule that describes how one specific site looks does not belong in this list.

**Composition (no monotony, no AI tells):**

- No section repeats the previous section's layout. Use ≥3 distinct layout types across the
  page: text-left/visual-right, visual-left/text-right, full-bleed visual, full-width row of
  3+ with captions, centered-heading/asymmetric-below.
- Use the full horizontal width. Do not trap content in a narrow centered column with dead
  space on both sides (a classic AI tell); visuals and backgrounds may go edge-to-edge.
- Vary the section header treatment — do not stack heading-over-subhead in every section.
- Subheadlines are OPTIONAL — at least 2 sections have none — and their placement varies
  (beneath or beside the heading).

**Content bands (add real ones, never fake proof):**

- Add real content variety beyond feature lists where it fits. Testimonials must be specific
  and plausible — full name + title + company + a concrete quote — omit rather than fake a weak
  "Sarah P." line. Never fabricate customer proof. (Which bands suit a given category — logo
  marquee, changelog, and the like — comes from the category map, not from here.)

**Banned (vibe-coded tells):**

- No eyebrow / kicker labels (a small mono/uppercase label above a headline). A section's label
  is just its heading.
- No emojis, no self-invented glyphs, no Lucide/Heroicons default icon set. Use the category's
  icon library (`category-map-schema.md`); if none is wired yet, use text and shapes, not emoji.
- No color, gradient, or accent absent from `tokens.json`. Use the extracted accent sparingly.
  Palette fidelity is what makes a monochrome reference render monochrome and a colorful one
  render in its own palette — do not prescribe a look. (Also enforced by the critic + hooks, §8.)

**Interaction rule (universal, strict):** Permitted — subtle, FUNCTIONAL motion only (eased
collapse/expand, gentle fade-in, a clean static gradient), plus functional product behavior when
the category calls for a product-UI surface (the specific surfaces are category vocabulary — see
the category map). BANNED everywhere on marketing elements: hover-lift, float, bounce,
scroll-triggered slide-in, wiggle, any decorative motion. (From the 500-site study; see
`vibe-coded-patterns.md`.)

---

## 8. The critic subagent + hooks

**Critic loop:**

1. Run the dev server, navigate, screenshot every page + key breakpoints.
2. Run the `vibe-coded-patterns.md` Section 5 checklist against the live render.
3. Clone check: compare built structure to the reference's captured structure — if the
   section order/skeleton is too similar, reject and rebuild the IA.
4. Return specific located fixes to the builder. Loop until clean.
5. Only then present.

**Deterministic hooks** (PreToolUse/PostToolUse — regex/AST gates, more reliable than
asking the model to self-police):

- Reject any CSS radius not in `tokens.radius`.
- Reject `href="#"`, bare social URLs, links resolving to 404.
- Reject `TODO`, `Lorem`, placeholder/test text in final output.
- Reject missing `<title>`, meta description, OG image, favicon.
- Reject spacing values not on the scale.

---

## 9. Build sequence

Assemble in this order. Each phase leaves you with something more complete; the end state
is the working CLI. These are the order of assembly, not permission gates — build straight
toward the product.

1. **Get extraction working automated.** Implement §4 (happy path + all recovery
   branches) against one real site (e.g. Linear). Confirm it emits a clean, buildable
   `design-system/` folder per §5. This is the core and the trickiest stage, so it's worth
   getting solid before wrapping the rest around it — same as testing an engine before
   building the car.
2. **Standardize the artifact** (§5).
3. **Wire the minimal Agent SDK loop**: read artifact → build one landing page from a
   one-line prompt. Compare to raw Claude Code on the same prompt. If it's not visibly
   better, the extractor/artifact needs work first.
4. **Add the critic + hooks** (§8).
5. **Build the category map + router** (§6). Now it's one-prompt end to end from the CLI.
6. **"Bring your own reference" mode** — user passes a URL, skip the router.

### Builder-hardening workstreams (surfaced by the step-3 test — deferred)

The step-3 test (`test-findings.md`) proved the loop and the core bet (rails beat no rails),
but showed the builder is still templated where Linear is designed. The cheap, prompt-level
fixes fold into §7 above (applied as part of step-3 hardening). The workstreams below need real
new capability. **They are ranked by IMPACT, which is NOT the execution order — see below.**

**Execution order (dependency-driven; the authoritative bookmark):**

1. Cheap builder fixes (§7) — now, no dependencies.
2. Critic + hooks (§9 step 4) — next: the automated grader every later builder change is
   verified against (without it, each change needs manual eyeballing, as step 3 did), and it
   absorbs the mechanical enforcement of the cheap fixes (palette fidelity, banned tells). Do it
   BEFORE the hard builder work, not after.
3. Category-map population (§9 step 5), at least the dev-tool entry — next: the map must exist
   before bespoke visuals, since which visual KINDS/icons/interactions to use is category-driven
   (impact item 5 below). Populating dev-tool keeps the Linear test loop running.
4. Bespoke visuals + the remaining builder-hardening items (impact items 1–6 below) — LAST in
   this arc: highest impact but hardest, and it depends on both the critic (to grade it) and the
   map (to know which visual kinds). So "builder hardening" is not one block — the cheap half runs
   before step 4, the bespoke-visuals half runs after steps 4 and 5.

**Impact ranking (what to build within the bespoke-visuals arc, highest payoff first):**

1. **Bespoke visuals (biggest gap, hardest).** Replace generic icon-card grids with generated
   bespoke SVG: isometric thin-stroke line-art diagrams (small FIG labels), syntax-highlighted
   code diffs (functional red/green), dense dot-density data-viz. The line between "designed"
   and "templated." Not a prompt tweak — needs per-visual specs or a visual-template system.
2. **Hero treatment.** A large full-width product visual BELOW the headline (not a small box
   beside it), edges faded into the background (no hard border), dense realistic UI inside.
3. **Full-width dense product screenshots** as each feature section's centerpiece — each a
   DIFFERENT real screen, sharing a system but never identical (consistency in the system,
   variety in the content).
4. **Component extraction (appearance yes, behavior regenerated).** Extend the extractor to
   capture a signature component's appearance (HTML/CSS/SVG) as a reusable snippet; the builder
   regenerates behavior fresh and functional. Never lift compiled JS. See the component-reuse
   rule in `category-map-schema.md`.
5. **Category-appropriate richness.** The KIND of rich visual is category-dependent (dev tool →
   product UI + diagrams; skincare → photography + editorial type; law firm → typographic
   authority). Comes from the category map — do NOT hardcode Linear's visual types as universal.
6. **Clean gradient background.** A subtle, tasteful background gradient (esp. hero) is
   permitted — restrained, not decorative motion.
7. **Populate the category map.** The schema exists (`category-map-schema.md`); no entries do.
   Build the dev-tool entry first to keep testing, then expand. Feeds §6 / step 5 above.

The category map is now the keystone (`category-map-schema.md`): per-category visual vocabulary,
icon/logo libraries, and permitted interactions — so the builder reaches for the right KIND of
richness instead of guessing. This upgrades §6 from "category → reference sites" to "category →
full visual + interaction vocabulary."

---

## 10. How you know it works

Your bar: beat Claude Code + Lovable + v0, and match paid-site quality. You can't judge
this by eyeballing your own output — build a blind eval:

- ~10 prompts across the range (SaaS landing, portfolio, docs, dashboard, marketplace,
  prediction market, e-commerce, dev tool, fintech, personal).
- For each: generate with your CLI, raw Claude Code, Lovable, v0.
- Blind-rank — you plus a few people whose design taste you trust.
- `vibe-coded-patterns.md` is the rubric for the "avoid" column; the paid sites you admire
  are the rubric for the "match" column.

This is both the go/no-go gate and the regression test when you later change the extractor
or the map.

---

## 11. The two things that make or break it

1. **The recovery layer (§4) is the real work.** The happy path is easy; the value of a
   one-prompt tool is that it handles the recurring snags automatically that you currently
   catch by hand. Get every recovery branch solid.
2. **The category map is taste, and taste is the moat.** The SDK and extractor become
   commodity once built. The defensible thing is which real sites a given product should
   borrow from — curated for extractability. Spend disproportionate care here.

---

## 12. Component extraction — the next build-out (THE current priority)

**Why this supersedes the §9 builder-hardening ordering.** Two tests proved tokens alone are not
enough: multi-site token synthesis produced generic "Linear-lite," and a holistic single-site
clone-and-adapt control (now retired) *also* looked vibe-coded — both **improvised the product
widgets**. A premium site's quality lives in its designed product-UI widgets (Linear's dashboard,
runs table, schedule editor) — real HTML/CSS/SVG that the token pipeline never captured. The fix,
**empirically proven on Linear's dashboard (~97% fidelity)**: extract those components as reusable
markup, pin widths so nothing reflows, and repopulate them with the user's content. This is the
right answer to "bespoke visuals" — inherited from the reference, not approximated.

Verified prototypes to fold into real modules, then delete: **`src/_spike.ts`** (subtree select →
clone with computed styles + inline SVG + pinned measured widths + preserved absolute positioning →
render) and **`src/_repop.ts`** (extract the text nodes → model returns a semantic mapping →
swap only text content, structure/styling preserved 100% by construction → render).

### The 7 steps, in order

1. **`src/components.ts`** — production extractor. Select the product-UI subtree(s) (the hero
   widget + any other rich product surfaces; the spike's "richest bordered/shadowed container with
   many descendants in the hero region" heuristic worked first try on Linear). Clone with computed
   styles inlined, inline SVGs kept, **measured widths pinned** (`width:Npx; flex:0 0 auto`) and
   absolute positioning preserved (`top/left/right/bottom/z-index`) — this is what kills the reflow.
   **Download referenced assets** (img/background-image) so the component is self-contained.
2. **Artifact schema → v1.2** (`src/artifact/schema.ts`). Add a `components` group to the contract:
   the component HTML files + a manifest of them + the identified content slots. `emit` writes them
   to `design-system/components/`; the extractor self-validates them (no dead asset refs, renders).
3. **`src/extract.ts` wiring.** Call component extraction in the pipeline and emit the folder.
4. **Font ROLES fix** (`src/tokens.ts`). The mono-headline bug: the pipeline captures which fonts
   exist but not which ROLE each plays, so a mono/secondary/accent face (Geist Mono, Berkeley Mono)
   gets promoted to the headline. Extract and preserve `headline` / `body` / `mono-accent` roles,
   and **hard-guard: a mono or secondary/accent font must NEVER be the primary headline family.**
5. **Synthesis carry-through** (`src/synthesize.ts`). Components come from the reference whose
   product-UI craft is being inherited (the identity/colour base, typically) — carry that base's
   components through into the synthesized artifact.
6. **Builder repopulation** (`src/builder/`). Hand the builder the real extracted components and
   have it **repopulate them with the user's content** (the proven round-trip: keep structure +
   styling, swap text/data) — instead of improvising widgets.
7. **Canvas/WebGL → pick a different base.** If a chosen reference has a genuinely un-extractable
   element (canvas/WebGL = pixels, not markup), pick a different base rather than approximate it.
   Everything DOM-based is HTML/CSS/SVG and IS replicable — "can't replicate" means "solve it."

### Open must-fixes (do not lose)

- **Font ROLES** (step 4) — mono/accent must never become the headline.
- **Width-pinning** (step 1) — proven; it must ship, because slightly-off alignment is itself a
  vibe-coded tell (90% is not the standard).
- **Canvas/WebGL → different base** (step 7) — the one genuine boundary; solve, don't skip, for
  everything else.

Do this as a **fresh, single clean sweep** — component extraction touches the extractor, the
contract, synthesis, and the builder; a half-wired state is worse than none.
