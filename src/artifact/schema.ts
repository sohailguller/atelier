// The artifact contract — the single source of truth for the design-system handoff (§5).
// Both the extractor (emit) and any consumer (the builder, step 3) depend on these schemas.
// zod gives us one definition that yields BOTH the runtime validator and the TS types.
import { z } from "zod";

/** Bump the MAJOR when the shape changes incompatibly; consumers check major compatibility.
 *  v1.1 adds the measured `layout` token group (composition is now extracted, not improvised).
 *  v1.2 adds the `components` group: real product-UI widgets extracted as self-contained markup
 *  (the breakthrough — tokens alone produced generic "Linear-lite"; the designed widgets carry the
 *  craft). The manifest now inventories each extracted component and its repopulation slots. */
export const CURRENT_ARTIFACT_VERSION = "1.2";

const Hex = z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "must be a hex color like #08090a");

// ---- tokens.json ----------------------------------------------------------
export const ColorScaleSchema = z
  .object({
    bg: Hex,
    surface: Hex,
    accent: Hex,
    text: Hex,
    muted: Hex.optional(),
    border: Hex.optional(),
  })
  .catchall(z.string()); // allow extra brand roles without breaking the contract

export const TypeRampEntrySchema = z.object({
  size: z.number().positive(),
  line: z.number().positive(),
  weight: z.number().int(),
  tracking: z.number(),
  case: z.string(),
});

export const FontSchema = z.object({
  display: z.string().min(1),
  ui: z.string().min(1),
  mono: z.string().min(1).optional(),
});

// Measured composition skeleton — the builder reproduces the reference's spatial discipline
// from these numbers instead of improvising layout (the dimension past builds got wrong).
export const LayoutSchema = z.object({
  containerMaxWidth: z.number().positive(), // px — real constrained content column width
  gutter: z.number().nonnegative(), // px — side inset
  contentWidthRatio: z.number().min(0).max(1), // column / viewport
  sectionSpacing: z.number().positive(), // px — vertical rhythm unit between/within sections
  density: z.number().min(0).max(1), // content ink-coverage per section (low = confident emptiness)
  heroViewportRatio: z.number().min(0).max(3), // hero height / viewport height
  grid: z.object({ columns: z.number().int().positive(), gutter: z.number().nonnegative() }),
  headlineAlign: z.enum(["left", "center", "right"]),
});

// Dimensional treatment — the difference between a premium surface and a flat black box. `surface`
// gradients are the few dimensional fills the reference actually uses (Linear's colour-washed
// testimonial cards); `ambient` is the soft page-level glow (Vercel). `colorfulAreaPct` is the
// RESTRAINT signal: the reference is ~monochrome and colour appears only on a couple of surfaces —
// that ratio IS the design, and over-applying colour is the vibe-coded tell.
// kind:
//   ambient — one big soft page/hero glow (what stops the page reading as dead-flat black)
//   accent  — a COLOURFUL fill (Linear's lavender testimonial card). These are the rare ones; the
//             whole point is that they appear on one or two surfaces and nowhere else.
//   surface — a subtle, monochrome dimensional fill (a faint white radial giving a card depth)
//   text    — a gradient clipped to text
export const GradientSchema = z.object({
  css: z.string().min(1), // literal extracted CSS — never invented
  kind: z.enum(["surface", "ambient", "text", "accent"]),
  w: z.number().nonnegative(),
  h: z.number().nonnegative(),
  count: z.number().int().nonnegative(),
});

export const EffectsSchema = z.object({
  gradients: z.array(GradientSchema),
  colorfulAreaPct: z.number().min(0).max(100), // % of painted area that is a saturated colour
  colorfulSurfaces: z.number().int().nonnegative(), // how many distinct surfaces carry colour
  // Placement + subtlety — so the critic enforces the reference's DISCIPLINE, not just the ratio.
  // Optional for back-compat with v1.2 artifacts extracted before this was measured.
  colorCentroidY: z.number().min(0).max(1).optional(), // vertical centre of mass of colour (1 = bottom-weighted)
  maxSaturation: z.number().min(0).max(1).optional(), // most-saturated surface on the reference
  colorInNav: z.boolean().optional(), // does the reference itself colour its nav?
});

export const TokensSchema = z.object({
  color: ColorScaleSchema,
  font: FontSchema,
  // Optional so v1.2 artifacts stay valid; the extractor always emits it going forward.
  effects: EffectsSchema.optional(),
  type: z
    .record(z.string(), TypeRampEntrySchema)
    .refine((r) => "body" in r, { error: "type ramp must include a 'body' role" })
    .refine((r) => Object.keys(r).length >= 3, { error: "type ramp needs at least 3 roles (e.g. body + two headings)" }),
  space: z.array(z.number().nonnegative()).min(3, { error: "space scale needs at least 3 steps" }),
  radius: z.array(z.number().nonnegative()).min(1, { error: "radius must record at least one value (use [0] for a sharp system)" }),
  shadow: z
    .record(z.string(), z.string())
    .refine((r) => Object.keys(r).length >= 1, { error: "shadow must have at least one entry (record 'none' intentionally if flat)" }),
  breakpoints: z
    .record(z.string(), z.number())
    .refine((r) => Object.keys(r).length >= 1, { error: "breakpoints must have at least one entry" }),
  layout: LayoutSchema,
});

// ---- components/ (v1.2 — real extracted product-UI widgets) ---------------
// Each entry is a self-contained widget (computed styles inlined, SVGs kept, widths pinned, asset
// refs rewritten local). `slots` are the visible text strings the builder repopulates with the
// user's content (structure + styling preserved 100% by construction). `file`/`assets` are paths
// relative to components/ — validation guarantees they exist (no dead widget refs).
export const ComponentEntrySchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  file: z.string().min(1), // relative to components/, e.g. "hero-widget.html"
  width: z.number().positive(),
  height: z.number().positive(),
  nodes: z.number().int().positive(),
  bg: z.string().min(1), // page background behind the widget, for a faithful standalone render
  slots: z.array(z.string()).min(1, { error: "a component with no text slots is not a repopulatable widget" }),
  assets: z.array(z.string()), // relative to components/assets/
});

// ---- manifest.json (machine-readable inventory + provenance) --------------
export const ArtifactFilesSchema = z.object({
  tokens: z.string(),
  tailwind: z.string(),
  fontsCss: z.string().nullable(),
  components: z.string(),
  spec: z.string(),
  fonts: z.array(z.string()),
  assets: z.array(z.string()),
  screenshots: z.array(z.string()),
});

export const ManifestSchema = z.object({
  artifactVersion: z.string(),
  source: z.string(),
  extractedAt: z.string(),
  visualChannel: z.boolean(),
  recovery: z.record(z.string(), z.boolean()),
  files: ArtifactFilesSchema,
  // v1.2: the extracted product-UI widgets. May be empty (a text-only marketing reference, or a
  // canvas/WebGL base that was correctly rejected) — but the field is always present, never silent.
  components: z.array(ComponentEntrySchema).default([]),
});

// ---- inferred types (shared by producer and consumer) ---------------------
export type Tokens = z.infer<typeof TokensSchema>;
export type Effects = z.infer<typeof EffectsSchema>;
export type Gradient = z.infer<typeof GradientSchema>;
export type Layout = z.infer<typeof LayoutSchema>;
export type TypeRampEntry = z.infer<typeof TypeRampEntrySchema>;
export type ArtifactFiles = z.infer<typeof ArtifactFilesSchema>;
export type ComponentEntry = z.infer<typeof ComponentEntrySchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
