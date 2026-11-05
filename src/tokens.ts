// Transform raw measurements into a scales-based tokens.json.
// This module owns the RECOVERY LAYER (build-guide §4): every branch that fills, infers,
// or explicitly records the absence of a token lives here, and each sets a RecoveryFlag
// so SPEC.md can report exactly which recoveries fired.
import type { RawMeasurements, Tokens, RecoveryFlags, TypeRampEntry, HealthCheck } from "./types.js";
import type { Layout } from "./artifact/schema.js";
import {
  toHex,
  compositeHex,
  parseColor,
  isNeutral,
  saturation,
  luminance,
  px,
  histogram,
  STANDARD_SCALE,
} from "./util.js";

export interface ComponentRecipes {
  cta: Record<string, string> | null;
  card: Record<string, string>;
  clipPathSignatures: string[];
}

export interface BuildResult {
  tokens: Tokens;
  recovery: RecoveryFlags;
  recipes: ComponentRecipes;
  notes: string[];
}

export function buildTokens(raw: RawMeasurements, health: HealthCheck): BuildResult {
  const notes: string[] = [];
  const recovery: RecoveryFlags = {
    visualChannel: health.visualChannel,
    spacingInferred: false,
    radiusFlat: false,
    shadowSynthesized: false,
    shadowNone: false,
    accentFallback: false,
    breakpointsFallback: false,
    fontRoleGuarded: false,
  };
  if (!health.visualChannel) {
    notes.push(
      `RECOVERY[visual-channel]: screenshot health check FAILED (${health.reason}). ` +
        `Type ramp, spacing, colors and shadows were reconstructed from CSSOM + computed styles + ` +
        `getBoundingClientRect alone. No pixel channel was used.`
    );
  }

  // ---- colors ------------------------------------------------------------
  const bg = toHex(raw.pageBg) ?? toHex(raw.roles.body?.backgroundColor) ?? "#ffffff";
  const text = toHex(raw.roles.body?.color) ?? (luminance(parseColor(bg)!) < 0.5 ? "#ffffff" : "#111111");

  // Identify the real primary action first — it informs both the accent and the CTA recipe.
  const primaryBtn = derivePrimaryButton(raw, notes);
  const accent = deriveAccent(raw, bg, text, primaryBtn, recovery, notes);
  const surface = deriveSurface(raw, bg, notes);
  const border = deriveBorder(raw, bg, text, notes);
  const muted = deriveMuted(raw, bg, text, notes);

  // Object literal (not Record<string,string>) so the contract's required color roles are checked.
  const color = { bg, surface, accent, text, muted, border };

  // ---- fonts (ROLES: headline / body / mono-accent, with a hard guard) ----
  // The pipeline captures which fonts EXIST but must also capture which ROLE each plays. The
  // long-standing mono-headline bug: a mono/secondary/accent face (Geist Mono, Berkeley Mono)
  // resolved on h1 gets promoted to the primary headline. Hard rule (§12 step 4): a mono or
  // code face must NEVER be the display/headline family when a genuine text face is available.
  const firstFamily = (ff?: string) =>
    (ff ?? "").split(",")[0].replace(/['"]/g, "").trim() || "";
  const MONO_RE = /mono|consol|courier|menlo|berkeley|jetbrains|fira.?code|ibm.?plex.?mono/i;
  const isMonoLike = (fam: string) => !!fam && MONO_RE.test(fam);

  // body/UI role = the primary reading face (the safe, non-decorative default).
  const ui =
    firstFamily(raw.roles.body?.fontFamily) ||
    firstFamily(raw.roles.button?.fontFamily) ||
    firstFamily(raw.roles.h1?.fontFamily) ||
    "sans-serif";

  // headline/display role = the most prominent heading face — but GUARDED: skip any mono/accent
  // candidate and fall down the heading→body chain to the first genuine text face. If EVERY
  // candidate is mono-like the site is genuinely monospace, so headline-mono is then faithful.
  const h1Fam = firstFamily(raw.roles.h1?.fontFamily);
  const headlineChain = [h1Fam, firstFamily(raw.roles.h2?.fontFamily), firstFamily(raw.roles.h3?.fontFamily), ui].filter(Boolean);
  const display = headlineChain.find((f) => !isMonoLike(f)) || ui || "sans-serif";
  if (h1Fam && isMonoLike(h1Fam) && display !== h1Fam) {
    recovery.fontRoleGuarded = true;
    notes.push(
      `RECOVERY[font-roles]: the h1 computed family "${h1Fam}" is a mono/accent face — GUARDED against ` +
        `becoming the headline (the mono-headline bug). Headline role assigned to "${display}" instead; ` +
        `"${h1Fam}" is kept as the mono-accent role only.`,
    );
  }

  const font: { display: string; ui: string; mono?: string } = { display, ui };
  // mono-accent role: prefer the computed <code>/<pre> family; else infer from a downloaded mono
  // font file (we have the binary, so it's real) so the family is never mislabeled.
  const monoFam = firstFamily(raw.roles.mono?.fontFamily);
  if (raw.roles.mono?.found && monoFam && monoFam !== ui && MONO_RE.test(monoFam)) {
    font.mono = monoFam;
  } else if (isMonoLike(h1Fam) && h1Fam !== ui) {
    // The face wrongly used on h1 is a real mono/accent face — preserve it in its correct role.
    font.mono = h1Fam;
  } else {
    const monoUrl = raw.fontFaces.flatMap((f) => f.urls).find((u) => MONO_RE.test(u.split("/").pop() ?? ""));
    if (monoUrl) font.mono = prettifyFontName(monoUrl);
  }

  // ---- type ramp ---------------------------------------------------------
  const type = buildTypeRamp(raw, notes);

  // ---- spacing (recovery: infer / fall back to 4-8pt scale) --------------
  const space = buildSpacing(raw, recovery, notes);

  // ---- radius (recovery: flat -> [0] intentionally) ----------------------
  const radius = buildRadius(raw, recovery, notes);

  // ---- shadow (recovery: none -> record + synthesize one restrained) -----
  const shadow = buildShadow(raw, recovery, notes);

  // ---- breakpoints (recovery: none -> standard defaults) -----------------
  const breakpoints = buildBreakpoints(raw, recovery, notes);

  // ---- layout / composition (measured skeleton; fallback if the probe was absent) ----
  const layout = buildLayout(raw, notes);

  // ---- effects: real gradients + how sparingly the reference uses colour --------
  const effects = buildEffects(raw, notes);

  const tokens: Tokens = { color, font, type, space, radius, shadow, breakpoints, layout, effects };
  const recipes = buildRecipes(raw, tokens, primaryBtn);
  return { tokens, recovery, recipes, notes };
}

// ---------------------------------------------------------------------------
// Primary-button detection: which button is the real primary action?
// Not "biggest colored box" (that grabs promo cards) — prefer a compact, filled control
// in the header with call-to-action text. This is what a builder must reproduce faithfully.
// ---------------------------------------------------------------------------
import type { ButtonCandidate } from "./types.js";
const CTA_TEXT = /\b(sign up|signup|get started|start|try|start building|sign in|log in|login|get demo|book|contact|join|subscribe|download)\b/i;

export function derivePrimaryButton(raw: RawMeasurements, notes: string[]): ButtonCandidate | null {
  const cands = raw.buttonCandidates ?? [];
  if (cands.length === 0) return null;
  const score = (b: ButtonCandidate) => {
    let s = 0;
    if (b.hasFill) s += 400; // primary actions are filled, not ghost/outline
    if (b.inHeader) s += 500; // the persistent nav CTA is the canonical primary
    if (CTA_TEXT.test(b.text)) s += 350;
    if (b.isPill) s += 120;
    if (b.top < 900) s += 120; // above the fold
    // prefer compact controls; penalize very wide/tall ones
    if (b.w <= 200 && b.h <= 56) s += 80;
    return s;
  };
  const ranked = [...cands].sort((a, b) => score(b) - score(a));
  const best = ranked[0];
  if (score(best) < 300) {
    notes.push(`NOTE[primary-button]: no confident primary CTA (best score ${score(best)}); using the most prominent filled control.`);
  } else {
    notes.push(`NOTE[primary-button]: primary = "${best.text || "(icon)"}" ${best.inHeader ? "[header]" : ""} ${best.isPill ? "[pill]" : ""} fill=${best.hasFill ? best.backgroundColor : "none"}.`);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Color derivation
// ---------------------------------------------------------------------------
// A color is the brand accent only if it is used SYSTEMATICALLY: it must clear a rendered-area
// floor (not a tiny status dot) AND appear on multiple elements (not one big decorative card).
// Both guards are needed: area alone lets a single lime customer-card masquerade as the accent;
// count alone lets scattered status dots do the same.
const ACCENT_AREA_FLOOR = 2000; // ~ a 45×45 patch
const ACCENT_MIN_ELEMENTS = 2; // must recur — one-off elements are decoration, not the accent
const ACCENT_MIN_SAT = 0.25; // must be clearly colorful, not a faintly-tinted grey (e.g. #d0d6e0)
const MIN_ACCENT_CONTRAST = 2; // a fallback accent must stand out from the page bg to be usable

/** WCAG-style contrast ratio between two opaque hex colors (1 = identical, 21 = black/white). */
function contrastRatio(a: string, b: string): number {
  const la = luminance(parseColor(a)!);
  const lb = luminance(parseColor(b)!);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function deriveAccent(
  raw: RawMeasurements,
  bg: string,
  text: string,
  primaryBtn: ButtonCandidate | null,
  recovery: RecoveryFlags,
  notes: string[]
): string {
  const stat = new Map<string, { area: number; count: number }>();
  for (const { color, area, count } of [...raw.bgColorFrequency, ...raw.colorFrequency]) {
    const hex = compositeHex(color, bg);
    // must be clearly colorful — a faintly-tinted grey (low saturation) is chrome, not an accent
    if (!hex || isNeutral(hex) || saturation(parseColor(hex)!) < ACCENT_MIN_SAT) continue;
    const cur = stat.get(hex) ?? { area: 0, count: 0 };
    stat.set(hex, { area: cur.area + area, count: cur.count + count });
  }
  const ranked = [...stat.entries()].sort((a, b) => b[1].area - a[1].area);
  const top3 = ranked.slice(0, 3).map(([c, v]) => `${c}(${v.area}px², ${v.count}×)`).join(", ") || "none";
  const systematic = ranked.filter(([, v]) => v.area >= ACCENT_AREA_FLOOR && v.count >= ACCENT_MIN_ELEMENTS);

  if (systematic.length) {
    notes.push(`NOTE[accent]: systematic colorful accent ${systematic[0][0]} (area + recurrence). Top colorful: ${top3}.`);
    return systematic[0][0];
  }

  // RECOVERY: monochrome system. The colorful colors present are incidental (below the area
  // floor). The real "accent" a builder should use for primary actions is the primary
  // button's fill (e.g. Linear's white pill), or the text color if there's no filled primary.
  recovery.accentFallback = true;
  let fallback = text;
  let via = "text color";
  if (primaryBtn?.hasFill) {
    const btnHex = compositeHex(primaryBtn.backgroundColor, bg);
    // A primary-action fill is usable AS an accent only if it stands out from the page bg. A
    // near-invisible pick (e.g. Vercel's white "Log In" fill on a #fafafa page — contrast ~1.0)
    // is worse than useless; fall through to the text color, which contrasts by construction.
    if (btnHex && contrastRatio(btnHex, bg) >= MIN_ACCENT_CONTRAST) {
      fallback = btnHex;
      via = `primary button fill ("${primaryBtn.text || "button"}")`;
    } else if (btnHex) {
      via = `text color (primary fill ${btnHex} fails contrast ${contrastRatio(btnHex, bg).toFixed(2)} vs bg)`;
    }
  }
  notes.push(
    `RECOVERY[accent]: monochrome system — no colorful color is used systematically ` +
      `(needs ≥${ACCENT_AREA_FLOOR}px² AND ≥${ACCENT_MIN_ELEMENTS} elements; top colorful: ${top3}). ` +
      `Accent set to ${fallback} via ${via}.`
  );
  return fallback;
}

function deriveSurface(raw: RawMeasurements, bg: string, notes: string[]): string {
  // Largest-area block background that differs from the page bg = the card/surface color.
  // Composite over bg so translucent overlay surfaces flatten to their real rendered color.
  const ranked = raw.blockBgFrequency
    .map((b) => ({ hex: compositeHex(b.color, bg), area: b.area }))
    .filter((b): b is { hex: string; area: number } => !!b.hex && b.hex !== bg)
    .sort((a, b) => b.area - a.area);
  if (ranked.length > 0) return ranked[0].hex;

  // No distinct surface: lift the page bg slightly toward the opposite end.
  const surf = shiftToward(bg, luminance(parseColor(bg)!) < 0.5 ? "#ffffff" : "#000000", 0.05);
  notes.push(`RECOVERY[surface]: no distinct card background found; synthesized ${surf} by lifting the page bg 5%.`);
  return surf;
}

function deriveBorder(raw: RawMeasurements, bg: string, text: string, notes: string[]): string {
  // Borders on dark UIs are typically low-alpha white/black overlays; composite over bg
  // rather than dropping alpha (which would yield a glaring opaque #ffffff).
  const ranked = raw.borderColorFrequency
    .map((b) => ({ hex: compositeHex(b.color, bg), count: b.count }))
    .filter((b): b is { hex: string; count: number } => !!b.hex && b.hex !== bg)
    .sort((a, b) => b.count - a.count);
  if (ranked.length > 0) return ranked[0].hex;

  const synth = shiftToward(bg, text, 0.12);
  notes.push(`RECOVERY[border]: no visible border color captured; synthesized ${synth} (12% text over bg).`);
  return synth;
}

function deriveMuted(raw: RawMeasurements, bg: string, text: string, notes: string[]): string {
  // A neutral text color distinct from the main text = the muted/secondary tone.
  // Composite over bg so translucent secondary text flattens to its real rendered tone.
  const neutrals = raw.colorFrequency
    .map((c) => ({ hex: compositeHex(c.color, bg), count: c.count }))
    .filter((c): c is { hex: string; count: number } => !!c.hex && isNeutral(c.hex) && c.hex !== text && c.hex !== bg)
    .sort((a, b) => b.count - a.count);
  if (neutrals.length > 0) {
    // prefer one with contrast between text and bg (a real secondary tone)
    const target = neutrals.find((n) => {
      const l = luminance(parseColor(n.hex)!);
      const lb = luminance(parseColor(bg)!);
      const lt = luminance(parseColor(text)!);
      return (l - Math.min(lb, lt)) * (Math.max(lb, lt) - l) > 0;
    });
    if (target) return target.hex;
    return neutrals[0].hex;
  }
  const synth = shiftToward(text, bg, 0.4);
  notes.push(`RECOVERY[muted]: no secondary text tone captured; synthesized ${synth} (text blended 40% toward bg).`);
  return synth;
}

/** Blend `from` toward `to` by t (0..1) and return hex. */
function shiftToward(from: string, to: string, t: number): string {
  const a = parseColor(from)!;
  const b = parseColor(to)!;
  const mix = (x: number, y: number) => Math.round(x + (y - x) * t);
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(mix(a.r, b.r))}${h(mix(a.g, b.g))}${h(mix(a.b, b.b))}`;
}

// ---------------------------------------------------------------------------
// Type ramp
// ---------------------------------------------------------------------------
function buildTypeRamp(raw: RawMeasurements, notes: string[]): Record<string, TypeRampEntry> {
  const ramp: Record<string, TypeRampEntry> = {};
  const roleFor = (name: string): TypeRampEntry | null => {
    const r = (raw.roles as any)[name];
    if (!r?.found) return null;
    const size = px(r.fontSize) ?? 16;
    let line = px(r.lineHeight);
    if (line === null) {
      // "normal" or unitless — approximate a sensible leading
      const ratio = /^[\d.]+$/.test(r.lineHeight ?? "") ? parseFloat(r.lineHeight) : 1.4;
      line = Math.round(size * ratio);
    }
    const weight = parseInt(r.fontWeight ?? "400", 10) || 400;
    const tracking = r.letterSpacing === "normal" ? 0 : px(r.letterSpacing) ?? 0;
    const caseVal = r.textTransform && r.textTransform !== "none" ? r.textTransform : "none";
    return { size: Math.round(size), line: Math.round(line), weight, tracking: round2(tracking), case: caseVal };
  };

  const body = roleFor("body") ?? { size: 16, line: 24, weight: 400, tracking: 0, case: "none" };
  ramp.body = body;
  ramp.button = roleFor("button") ?? { ...body, weight: 500 };

  // Headings: use captured values; synthesize any missing from a modular scale off body.
  const RATIOS: Record<string, number> = { h1: 3.5, h2: 2.25, h3: 1.5 };
  let synthesized: string[] = [];
  for (const h of ["h1", "h2", "h3"]) {
    const found = roleFor(h);
    if (found) {
      ramp[h] = found;
    } else {
      const size = Math.round(body.size * RATIOS[h]);
      ramp[h] = { size, line: Math.round(size * 1.05), weight: 600, tracking: -0.5, case: "none" };
      synthesized.push(h);
    }
  }
  if (synthesized.length) {
    notes.push(
      `RECOVERY[type-ramp]: no visible ${synthesized.join(", ")} element(s) on the page; ` +
        `synthesized from a modular scale off the ${body.size}px body size.`
    );
  }

  // ---- the SECONDARY tier (the gap that made body/secondary copy read generic) ----
  // Tag-based roles only recover body/h1/h2/h3, so every caption, meta line and muted paragraph fell
  // back to a default. Recover the real tiers from the usage-weighted text-style histogram: the most-
  // used style SMALLER than body is `small`, the most-used style between body and h3 is `lead`.
  const styles = raw.textStyles ?? [];
  const entryOf = (t: (typeof styles)[number]): TypeRampEntry => {
    const size = px(t.fontSize) ?? 16;
    let line = px(t.lineHeight);
    if (line === null) line = Math.round(size * 1.4);
    return {
      size: Math.round(size),
      line: Math.round(line),
      weight: parseInt(t.fontWeight, 10) || 400,
      tracking: round2(t.letterSpacing === "normal" ? 0 : (px(t.letterSpacing) ?? 0)),
      case: t.textTransform && t.textTransform !== "none" ? t.textTransform : "none",
    };
  };
  const bySize = (lo: number, hi: number) =>
    styles.filter((t) => { const s = px(t.fontSize) ?? 0; return s >= lo && s < hi; }).sort((a, b) => b.chars - a.chars)[0];

  const small = bySize(9, body.size - 0.5);
  if (small) ramp.small = entryOf(small);
  const lead = bySize(body.size + 0.5, ramp.h3.size);
  if (lead) ramp.lead = entryOf(lead);
  if (small || lead) {
    notes.push(
      `TYPE: recovered secondary tier(s) from the usage-weighted text histogram — ` +
        `${small ? `small ${ramp.small.size}px/${ramp.small.weight}` : ""}${small && lead ? ", " : ""}` +
        `${lead ? `lead ${ramp.lead.size}px/${ramp.lead.weight}` : ""}. These carry real weight/tracking, ` +
        `so secondary copy no longer falls back to a generic default.`
    );
  }
  return ramp;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// EFFECTS: the dimensional treatment (real gradient CSS) + the RESTRAINT ratio.
// A premium reference is never flat black, but it is also not smeared with colour: Linear runs ~95%
// monochrome and lets colour appear on two gradient-washed cards; Vercel adds one soft ambient glow.
// Both halves must be extracted — the gradient values AND how little of the page they are allowed to
// cover — because over-applying colour is itself the vibe-coded tell.
function buildEffects(raw: RawMeasurements, notes: string[]): import("./artifact/schema.js").Effects {
  const samples = raw.gradients ?? [];

  // Does any colour stop in this gradient actually carry saturation? That is what separates the RARE
  // colourful card (Linear's lavender testimonial) from a faint monochrome depth glow — and the
  // builder must know the difference, because colour is only allowed on the former.
  const isColourful = (css: string): boolean => {
    const stops = css.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/gi) ?? [];
    return stops.some((s) => {
      const c = parseColor(s);
      return c ? saturation(c) > 0.22 && c.a > 0.15 : false;
    });
  };

  const gradients = samples
    .map((g) => {
      // An ambient glow is one huge soft wash behind the page; anything colourful is an accent
      // surface; everything else is a subtle monochrome dimensional fill.
      const kind: "surface" | "ambient" | "text" | "accent" = g.clipsText
        ? "text"
        : g.maxViewportRatio >= 0.5
          ? "ambient"
          : isColourful(g.css)
            ? "accent"
            : "surface";
      return { css: g.css, kind, w: g.w, h: g.h, count: g.count };
    })
    // Keep the strongest few of each kind — enough vocabulary, not a dumping ground.
    .slice(0, 6);

  // Restraint: what share of the painted area is actually a saturated colour, and on how many
  // distinct surfaces? This is the ratio the builder must respect.
  let colorfulArea = 0;
  let totalArea = 0;
  let colorfulSurfaces = 0;
  for (const b of raw.blockBgFrequency ?? []) {
    const c = parseColor(b.color);
    if (!c || c.a < 0.1) continue;
    totalArea += b.area;
    if (saturation(c) > 0.22) {
      colorfulArea += b.area;
      colorfulSurfaces += b.count;
    }
  }
  for (const g of samples) {
    totalArea += g.area;
    // A gradient counts as colourful if any of its colour stops is saturated.
    const stops = g.css.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/gi) ?? [];
    const colorful = stops.some((s) => {
      const c = parseColor(s);
      return c ? saturation(c) > 0.22 && c.a > 0.1 : false;
    });
    if (colorful) {
      colorfulArea += g.area;
      colorfulSurfaces += g.count;
    }
  }
  let colorfulAreaPct = totalArea > 0 ? Math.min(100, round2((colorfulArea / totalArea) * 100)) : 0;

  // Placement + subtlety, straight from the probe (the probe has the DOM positions). Prefer the
  // probe's own coverage measurement (it counts every painted element, not just block backgrounds).
  const cs = raw.colorStats;
  const colorCentroidY = cs ? round2(cs.centroidY) : undefined;
  const maxSaturation = cs ? round2(cs.maxSaturation) : undefined;
  const colorInNav = cs ? cs.colorInNav : undefined;
  const coverage = cs ? round2(cs.coverageRatio) : colorfulAreaPct;
  // The critic measures coverage the same way the probe does (every painted element), so the reference
  // number it compares against must be that one, not the older block-background estimate.
  if (cs) colorfulAreaPct = coverage;

  notes.push(
    `EFFECTS: ${gradients.length} real gradient(s) extracted ` +
      `(${["surface", "accent", "ambient", "text"].map((k) => `${gradients.filter((g) => g.kind === k).length} ${k}`).join(", ")}). ` +
      `Colour DISCIPLINE: ${coverage}% of painted area is saturated${cs ? `, centroidY ${colorCentroidY} (${(colorCentroidY ?? 0) > 0.55 ? "bottom-weighted" : "spread"}), max-saturation ${maxSaturation}, nav-coloured ${colorInNav}` : ""}. ` +
      `The critic rejects any build that exceeds this ratio, colours a zone the reference keeps clean, or is more saturated.`
  );

  return { gradients, colorfulAreaPct, colorfulSurfaces, colorCentroidY, maxSaturation, colorInNav };
}

/** Turn a font file URL into a display family name, e.g. "Berkeley-Mono-Variable.woff2" -> "Berkeley Mono". */
function prettifyFontName(url: string): string {
  const base = (url.split("/").pop() ?? "").replace(/\.[a-z0-9]+(\?.*)?$/i, "");
  return base
    .replace(/[-_]?(variable|var|regular|vf)\b/gi, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || "Mono";
}

// ---------------------------------------------------------------------------
// Spacing (recovery: infer / fall back)
// ---------------------------------------------------------------------------
function buildSpacing(raw: RawMeasurements, recovery: RecoveryFlags, notes: string[]): number[] {
  const samples = raw.spacingSamples.filter((v) => v > 0 && v <= 220);
  const total = samples.length;
  // Snap to a canonical 4/8-point ladder, grounded in the site's real usage: a step is "on the
  // scale" when enough measured gaps land near it. This keeps the scale ON-GRID (no jagged 28/36)
  // AND spanning the full range — a flat frequency floor silently truncated the top (Vercel first
  // extracted as [4,8,12,16,20], no section-level rhythm at all), because large paddings recur on
  // far fewer elements than small gaps.
  const LADDER = [4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128];
  const band = (step: number) => Math.max(2, step * 0.12); // snap nearby measured values into the step
  const REF = 16; // large steps recur on fewer elements, so discount their floor by magnitude
  const floorFor = (step: number) => Math.max(3, total * 0.01 * (REF / Math.max(step, REF)));
  const support = (step: number) => samples.filter((v) => Math.abs(v - step) <= band(step)).length;

  // Walk the ladder upward; keep contiguous supported steps and stop the top after two unsupported
  // rungs, so a lone far-outlier (e.g. a single hero margin at 128) can't create a 32→128 gap.
  const kept: number[] = [];
  let misses = 0;
  for (const step of LADDER) {
    if (support(step) >= floorFor(step)) {
      kept.push(step);
      misses = 0;
    } else if (kept.length > 0 && ++misses >= 2) {
      break;
    }
  }
  if (kept.length >= 4) {
    if (!kept.includes(4)) kept.unshift(4); // guarantee a small base step
    return dedupeSorted(kept);
  }
  recovery.spacingInferred = true;
  notes.push(
    `RECOVERY[spacing]: only ${kept.length} spacing step(s) recovered from ${total} ` +
      `samples — too sparse to trust. Fell back to the canonical 4/8-point scale.`
  );
  return [...STANDARD_SCALE];
}
function dedupeSorted(arr: number[]): number[] {
  return [...new Set(arr)].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Radius (recovery: flat -> [0])
// ---------------------------------------------------------------------------
function buildRadius(raw: RawMeasurements, recovery: RecoveryFlags, notes: string[]): number[] {
  // De-noise: drop rarely-used radii (sub-pixel/hairline artifacts like 1px/7px) by frequency,
  // then merge near-duplicates so 6/7/8 collapse to the one the site actually favors.
  const small = raw.radii.filter((r) => r.value > 0 && r.value < 100);
  const total = small.reduce((s, r) => s + r.count, 0);
  const floor = Math.max(3, total * 0.02);
  const frequent = small.filter((r) => r.count >= floor);
  const kept = mergeCloseRadii(frequent, 2);
  const droppedCount = small.length - frequent.length;

  const hasPill = raw.radii.some((r) => r.value >= 100) || (raw.buttonCandidates?.some((b) => b.isPill) ?? false);
  if (kept.length === 0 && !hasPill) {
    recovery.radiusFlat = true;
    notes.push(`RECOVERY[radius]: site uses no corner rounding — recorded [0] intentionally (a sharp-corner system).`);
    return [0];
  }
  const out = [0, ...kept];
  if (hasPill) out.push(9999); // sentinel for "fully rounded / pill" (e.g. Linear's Sign-up button)
  if (droppedCount > 0) notes.push(`NOTE[radius]: dropped ${droppedCount} rare sub-pixel radius artifact(s); kept the dominant scale.`);
  if (hasPill) notes.push(`NOTE[radius]: a pill/fully-rounded radius is in use (recorded as 9999 sentinel).`);
  return dedupeSorted(out).slice(0, 6);
}

/** Group sorted radii within `gap` px and keep the most-used representative of each group. */
function mergeCloseRadii(entries: Array<{ value: number; count: number }>, gap: number): number[] {
  const sorted = [...entries].sort((a, b) => a.value - b.value);
  const groups: Array<Array<{ value: number; count: number }>> = [];
  for (const e of sorted) {
    const g = groups[groups.length - 1];
    if (g && e.value - g[g.length - 1].value <= gap) g.push(e);
    else groups.push([e]);
  }
  return groups.map((g) => g.reduce((m, e) => (e.count > m.count ? e : m)).value);
}

/** The radius a builder should use for cards/inputs — the site's favored mid-range corner. */
function dominantRadius(raw: RawMeasurements, radiusScale: number[]): number {
  const mid = raw.radii.filter((r) => r.value >= 3 && r.value <= 20);
  if (mid.length) return mid.reduce((m, r) => (r.count > m.count ? r : m)).value;
  const real = radiusScale.filter((r) => r > 0 && r < 100);
  return real.length ? real[Math.floor(real.length / 2)] : radiusScale[0] ?? 0;
}

// ---------------------------------------------------------------------------
// Shadow (recovery: none -> record + synthesize one restrained elevation)
// ---------------------------------------------------------------------------
function buildShadow(raw: RawMeasurements, recovery: RecoveryFlags, notes: string[]): Record<string, string> {
  const real = raw.boxShadows
    .filter((s) => s.shadow && s.shadow !== "none")
    .map((s) => ({ shadow: normalizeShadow(s.shadow), blur: shadowBlur(s.shadow), count: s.count }))
    .filter((s) => s.shadow.length > 0);

  if (real.length === 0) {
    // §4: record "none" intentionally AND synthesize one restrained elevation.
    recovery.shadowNone = true;
    recovery.shadowSynthesized = true;
    notes.push(
      `RECOVERY[shadow]: no box-shadows found on any surface — this is a flat system. Recorded "none" ` +
        `intentionally, and synthesized one restrained elevation ("md") so the builder has a single reusable lift.`
    );
    return { none: "none", md: "0 1px 2px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.08)" };
  }

  const byBlur = [...real].sort((a, b) => a.blur - b.blur);
  const sm = byBlur[0].shadow;
  const md = byBlur[byBlur.length - 1].shadow;
  const out: Record<string, string> = { sm };
  if (md !== sm) out.md = md;
  else notes.push(`NOTE[shadow]: only one distinct elevation found; recorded as "sm".`);
  return out;
}
function normalizeShadow(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
function shadowBlur(s: string): number {
  // crude: sum the numeric px in the shadow as a proxy for "how big" it is
  const nums = [...s.matchAll(/(-?[\d.]+)px/g)].map((m) => Math.abs(parseFloat(m[1])));
  return nums.reduce((a, b) => a + b, 0);
}

// ---------------------------------------------------------------------------
// Layout / composition — finalize the measured skeleton (or a sane fallback).
// ---------------------------------------------------------------------------
function buildLayout(raw: RawMeasurements, notes: string[]): Layout {
  const L = raw.layout;
  if (!L) {
    notes.push(`RECOVERY[layout]: no layout probe available; used sensible composition defaults.`);
    return { containerMaxWidth: 1200, gutter: 24, contentWidthRatio: 0.83, sectionSpacing: 96, density: 0.4, heroViewportRatio: 0.8, grid: { columns: 3, gutter: 24 }, headlineAlign: "left" };
  }
  // Section rhythm: the dominant GENEROUS section padding (ignore tiny inner paddings).
  const generous = L.sectionPaddings.filter((v) => v >= 24 && v <= 260).sort((a, b) => a - b);
  const sectionSpacing = generous.length ? Math.round(generous[Math.floor(generous.length / 2)]) : 64;
  const grid =
    L.grid && L.grid.columns >= 2
      ? { columns: L.grid.columns, gutter: Math.max(0, Math.min(L.grid.gutter, 96)) }
      : { columns: 3, gutter: sectionSpacing >= 48 ? 32 : 24 };
  return {
    containerMaxWidth: Math.max(320, Math.min(Math.round(L.containerMaxWidth), 1920)),
    gutter: Math.max(0, Math.min(Math.round(L.gutter), 400)),
    contentWidthRatio: Math.max(0, Math.min(1, Math.round(L.contentWidthRatio * 100) / 100)),
    sectionSpacing,
    density: Math.max(0, Math.min(1, Math.round(L.density * 100) / 100)),
    heroViewportRatio: Math.max(0.2, Math.min(3, Math.round(L.heroViewportRatio * 100) / 100)),
    grid,
    headlineAlign: L.headlineAlign,
  };
}

// ---------------------------------------------------------------------------
// Breakpoints (recovery: none -> standard)
// ---------------------------------------------------------------------------
function buildBreakpoints(raw: RawMeasurements, recovery: RecoveryFlags, notes: string[]): Record<string, number> {
  const bps = raw.mediaBreakpoints;
  if (bps.length === 0) {
    recovery.breakpointsFallback = true;
    notes.push(`RECOVERY[breakpoints]: no width media queries readable from CSSOM; used standard sm/md/lg defaults.`);
    return { sm: 640, md: 768, lg: 1024 };
  }
  // Snap the real breakpoints to sm/md/lg by nearest canonical target.
  const nearest = (target: number) => bps.reduce((best, n) => (Math.abs(n - target) < Math.abs(best - target) ? n : best), bps[0]);
  const result = { sm: nearest(640), md: nearest(768), lg: nearest(1024) };
  // guard against collapsing all three onto one value
  if (new Set(Object.values(result)).size < 2 && bps.length >= 2) {
    const sorted = [...new Set(bps)].sort((a, b) => a - b);
    return { sm: sorted[0], md: sorted[Math.floor(sorted.length / 2)], lg: sorted[sorted.length - 1] };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Component recipes
// ---------------------------------------------------------------------------
function buildRecipes(raw: RawMeasurements, tokens: Tokens, primary: ButtonCandidate | null): ComponentRecipes {
  let cta: Record<string, string> | null = null;
  if (primary) {
    cta = {
      background: compositeHex(primary.backgroundColor, tokens.color.bg) ?? (primary.hasFill ? primary.backgroundColor : "transparent"),
      color: compositeHex(primary.color, tokens.color.bg) ?? tokens.color.text,
      borderRadius: primary.isPill ? "9999px (pill)" : primary.borderRadius || "0px",
      padding: primary.padding || "",
      border: primary.border && !primary.border.startsWith("0px") ? primary.border : "none",
      fontFamily: (primary.fontFamily || "").split(",")[0].replace(/['"]/g, "").trim(),
      fontWeight: primary.fontWeight || "",
      fontSize: primary.fontSize || "",
      boxShadow: primary.boxShadow && primary.boxShadow !== "none" ? primary.boxShadow : "none",
    };
    if (primary.clipPath && /^(polygon|inset|circle|ellipse|path)\s*\(/.test(primary.clipPath)) cta.clipPath = primary.clipPath;
  }

  const cardRadius = dominantRadius(raw, tokens.radius);
  const card: Record<string, string> = {
    background: tokens.color.surface,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: `${cardRadius}px`,
    boxShadow: tokens.shadow.md ?? tokens.shadow.sm ?? "none",
    padding: `${tokens.space[Math.min(4, tokens.space.length - 1)]}px`,
  };

  return { cta, card, clipPathSignatures: raw.clipPaths };
}
