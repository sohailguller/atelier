// Shared type definitions across the extractor.

/** Computed styles captured for one semantic role (h1, body, etc.). */
export interface RoleStyle {
  found: boolean;
  sample?: string; // trimmed text sample, for provenance
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  lineHeight?: string;
  letterSpacing?: string;
  textTransform?: string;
  color?: string;
  backgroundColor?: string;
}

/** One candidate button captured from the page; the primary is chosen later in tokens.ts. */
export interface ButtonCandidate {
  text: string;
  inHeader: boolean;
  top: number;
  w: number;
  h: number;
  hasFill: boolean;
  isPill: boolean;
  backgroundColor: string;
  color: string;
  borderRadius: string;
  padding: string;
  border: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  boxShadow: string;
  clipPath: string;
}

/** Raw, measured composition/layout structure — the SKELETON a builder must reproduce so it
 * stops improvising layout (the dimension past builds got wrong: cramped, centered, mush). */
export interface LayoutRaw {
  viewport: { w: number; h: number };
  containerMaxWidth: number; // px — width of the real constrained content column
  gutter: number; // px — side inset between content and viewport edge
  contentWidthRatio: number; // containerMaxWidth / viewport width (0..1)
  density: number; // 0..1 — mean content ink-coverage per section (low = empty/confident)
  heroViewportRatio: number; // first section height / viewport height (0..1)
  headlineAlign: "left" | "center" | "right"; // hero headline alignment
  grid: { columns: number; gutter: number } | null; // primary feature grid, if any
  sectionPaddings: number[]; // vertical padding (top/bottom) of top-level sections
}

/** One distinct text style actually used on the page, weighted by how many characters it sets.
 *  This is how the real type SCALE (incl. the secondary/caption tier) is recovered — tag selectors
 *  alone only find body/h1/h2/h3 and leave secondary copy to a generic default. */
export interface TextStyleSample {
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
  textTransform: string;
  color: string;
  fontFamily: string;
  chars: number;
}

/** A real CSS gradient found on the page, with enough context to know HOW it is used. */
export interface GradientSample {
  css: string; // the literal background-image value — never invented
  area: number; // total rendered px² it covers
  count: number; // how many elements use it
  w: number;
  h: number;
  radius: string;
  maxViewportRatio: number; // largest single instance / viewport → separates an ambient glow from a card
  clipsText: boolean; // background-clip:text → a gradient TEXT treatment
}

/** Raw, unprocessed measurements pulled from the page in a single evaluate call. */
export interface RawMeasurements {
  url: string;
  fontFaces: Array<{ family: string; weight: string; style: string; urls: string[] }>;
  roles: Record<string, RoleStyle>;
  textStyles?: TextStyleSample[]; // optional so older fixtures/tests still build
  gradients?: GradientSample[];
  colorStats?: { coverageRatio: number; centroidY: number; maxSaturation: number; colorInNav: boolean };
  buttonCandidates: ButtonCandidate[];
  colorFrequency: Array<{ color: string; count: number; area: number }>;
  bgColorFrequency: Array<{ color: string; count: number; area: number }>;
  blockBgFrequency: Array<{ color: string; count: number; area: number }>;
  borderColorFrequency: Array<{ color: string; count: number }>;
  pageBg: string;
  clipPaths: string[];
  backgroundImages: string[];
  inlineSvgs: Array<{ markup: string; w: number; h: number; context: string }>;
  spacingSamples: number[];
  radii: Array<{ value: number; count: number }>;
  boxShadows: Array<{ shadow: string; count: number }>;
  sectionRects: Array<{ tag: string; w: number; h: number; top: number }>;
  mediaBreakpoints: number[];
  layout?: LayoutRaw; // optional so DOM-measurement fallbacks / tests without a full page still build
  domStats: { elementCount: number; textLength: number };
}

/** Screenshot health result from the startup check. */
export interface HealthCheck {
  visualChannel: boolean;
  screenshotBytes: number;
  reason: string;
}

// The tokens.json shape is now owned by the artifact contract (single source of truth).
// Re-exported here so existing extractor modules keep importing from ./types.
export type { Tokens, TypeRampEntry } from "./artifact/schema.js";

/** Records which recovery branches fired, for the SPEC. */
export interface RecoveryFlags {
  visualChannel: boolean;
  spacingInferred: boolean;
  radiusFlat: boolean;
  shadowSynthesized: boolean;
  shadowNone: boolean;
  accentFallback: boolean;
  breakpointsFallback: boolean;
  fontRoleGuarded: boolean; // a mono/accent face was blocked from becoming the headline (§12 step 4)
}

export interface AssetReport {
  kind: "font" | "asset";
  sourceUrl: string;
  savedAs: string | null;
  bytes: number;
  ok: boolean;
  reason: string;
}
