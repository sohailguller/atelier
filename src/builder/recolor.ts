// RECOLOUR extracted product-UI widgets onto the synthesized palette.
//
// Why this exists: an extracted widget carries its SOURCE's colours inlined (Linear's dashboard has
// ~34 hard-coded Linear greys in it). That welds the page's identity to whichever site produced the
// richest component — pick Linear's dashboard and the whole page reads as Linear no matter what the
// other references contributed. It also made the palette effectively un-synthesizable: a Railway mood
// would clash with a Linear-coloured widget, so the mood had to stay Linear too.
//
// The fix decouples WHO BUILT the widget from WHAT THE SITE LOOKS LIKE. The widget's craft — layout,
// density, alignment, elevation, micro-typography — is what we inherit. Its palette is not.
//
// Two things make this actually work rather than just "swap the hex codes":
//  1. Colours are remapped PER PROPERTY. A mid-grey used as TEXT is a foreground and must land on a
//     text/muted token; the same grey used as a FILL is a surface. Remapping literals blindly turns
//     secondary copy into a border colour and the widget becomes unreadable.
//  2. Position is measured as CONTRAST FROM THE GROUND, not raw luminance — so a dark widget
//     correctly INVERTS onto a light palette instead of staying dark.
import { parseColor, luminance, saturation, toHex } from "../util.js";
import type { Tokens } from "../artifact/schema.js";

type RGBA = { r: number; g: number; b: number; a: number };

/** Semantic colours carry MEANING, not brand: a diff's red/green, a status amber. Never re-map them. */
function isSemantic(c: RGBA): boolean {
  if (saturation(c) < 0.35) return false; // greys/near-greys are brand chrome, safe to remap
  const { r, g, b } = c;
  const max = Math.max(r, g, b);
  const isRed = r === max && r > 120 && g < r * 0.75 && b < r * 0.75;
  const isGreen = g === max && g > 100 && r < g * 0.8 && b < g * 0.85;
  const isAmber = r > 150 && g > 110 && b < 110 && r >= g;
  return isRed || isGreen || isAmber;
}

/** Which palette roles a given CSS property is allowed to land on. */
type Kind = "fg" | "bg" | "border";

function kindOf(prop: string): Kind | null {
  const p = prop.trim().toLowerCase();
  if (p === "color" || p === "-webkit-text-fill-color" || p === "fill" || p === "stroke" || p === "caret-color") return "fg";
  if (p.startsWith("background")) return "bg";
  if (p.startsWith("border") || p === "outline" || p.startsWith("outline-")) return "border";
  if (p === "box-shadow" || p === "text-shadow") return "border"; // shadow tints follow the line/edge tone
  return null;
}

const COLOR_RE = /rgba?\([^)]*\)|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g;

/** Map a set of source colours of ONE kind onto the ordered anchors for that kind. */
function mapKind(srcColors: string[], anchors: Array<{ hex: string; d: number }>, srcGroundLum: number): Map<string, string> {
  const out = new Map<string, string>();
  const parsed = srcColors
    .map((raw) => ({ raw, c: parseColor(raw) }))
    .filter((x): x is { raw: string; c: RGBA } => !!x.c)
    .filter((x) => x.c.a > 0.02 && !isSemantic(x.c));
  if (!parsed.length || !anchors.length) return out;

  const srcMax = Math.max(...parsed.map((p) => Math.abs(luminance(p.c) - srcGroundLum)), 0.0001);
  const dstMax = anchors[anchors.length - 1].d || 1;

  for (const { raw, c } of parsed) {
    // Where does this colour sit on its own ground→foreground ramp? (0 = the ground, 1 = max contrast.)
    const t = Math.abs(luminance(c) - srcGroundLum) / srcMax;
    const want = t * dstMax;
    let best = anchors[0];
    let bestD = Infinity;
    for (const a of anchors) {
      const d = Math.abs(a.d - want);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    const dst = parseColor(best.hex);
    if (!dst) continue;
    // Preserve alpha — the widget's translucent overlays are a real part of its depth.
    out.set(raw, c.a < 0.99 ? `rgba(${dst.r}, ${dst.g}, ${dst.b}, ${c.a})` : (toHex(best.hex) ?? best.hex));
  }
  return out;
}

/**
 * Recolour one widget's markup onto the synthesized palette.
 * `sourceBg` is the page colour the widget was extracted against — its own ground.
 */
export function recolorWidget(
  html: string,
  tokens: Tokens,
  sourceBg: string,
): { html: string; remapped: number; kept: number } {
  const t = tokens.color;
  const ground = parseColor(t.bg);
  const srcGround = parseColor(sourceBg);
  if (!ground || !srcGround) return { html, remapped: 0, kept: 0 };
  const gl = luminance(ground);
  const srcGroundLum = luminance(srcGround);

  // Contrast-from-ground for each role, so the ladders work in either polarity.
  const anch = (hex: string) => {
    const c = parseColor(hex);
    return { hex, d: c ? Math.abs(luminance(c) - gl) : 0 };
  };
  const byD = (a: { d: number }, b: { d: number }) => a.d - b.d;

  const muted = (t.muted as string) ?? t.text;
  const border = (t.border as string) ?? t.surface;
  // Foreground text may only become a readable text tone — never a border/fill (that is what turned
  // secondary copy invisible when colours were remapped blindly).
  const fgAnchors = [anch(muted), anch(t.text)].sort(byD);
  const bgAnchors = [anch(t.bg), anch(t.surface), anch(border)].sort(byD);
  const borderAnchors = [anch(border), anch(t.surface), anch(muted)].sort(byD);

  // Collect the widget's colours per property kind, from its inline styles.
  const byKind: Record<Kind, Set<string>> = { fg: new Set(), bg: new Set(), border: new Set() };
  for (const m of html.matchAll(/style="([^"]*)"/g)) {
    for (const decl of m[1].split(";")) {
      const i = decl.indexOf(":");
      if (i < 0) continue;
      const k = kindOf(decl.slice(0, i));
      if (!k) continue;
      for (const col of decl.slice(i + 1).match(COLOR_RE) ?? []) byKind[k].add(col);
    }
  }

  const maps: Record<Kind, Map<string, string>> = {
    fg: mapKind([...byKind.fg], fgAnchors, srcGroundLum),
    bg: mapKind([...byKind.bg], bgAnchors, srcGroundLum),
    border: mapKind([...byKind.border], borderAnchors, srcGroundLum),
  };

  // Rewrite each declaration with the map for ITS kind.
  const out = html.replace(/style="([^"]*)"/g, (_full, body: string) => {
    const rebuilt = body
      .split(";")
      .map((decl) => {
        const i = decl.indexOf(":");
        if (i < 0) return decl;
        const prop = decl.slice(0, i);
        const k = kindOf(prop);
        if (!k) return decl;
        const map = maps[k];
        const value = decl.slice(i + 1).replace(COLOR_RE, (c) => map.get(c) ?? c);
        return `${prop}:${value}`;
      })
      .join(";");
    return `style="${rebuilt}"`;
  });

  // Count DISTINCT source colours remapped — the same grey can appear as both a fill and a border, and
  // summing the per-kind maps double-counts it (which reported a negative "semantic kept").
  const mapped = new Set([...maps.fg.keys(), ...maps.bg.keys(), ...maps.border.keys()]);
  const allSrc = new Set([...byKind.fg, ...byKind.bg, ...byKind.border]);
  return { html: out, remapped: mapped.size, kept: allSrc.size - mapped.size };
}
