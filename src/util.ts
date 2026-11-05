// Shared helpers: color conversion, magic-byte sniffing, numeric clustering.
// Pure Node — no browser context here.

/** Parse a CSS color string (rgb/rgba/hex/named-ish) into {r,g,b,a} or null. */
export function parseColor(input: string | undefined | null): { r: number; g: number; b: number; a: number } | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  const rgb = s.match(/rgba?\(([^)]+)\)/);
  if (rgb) {
    const parts = rgb[1].split(/[,\/\s]+/).filter(Boolean);
    const r = clampByte(parseFloat(parts[0]));
    const g = clampByte(parseFloat(parts[1]));
    const b = clampByte(parseFloat(parts[2]));
    const a = parts[3] !== undefined ? clamp01(parseFloat(parts[3])) : 1;
    if ([r, g, b].some(Number.isNaN)) return null;
    return { r, g, b, a };
  }

  const hex = s.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length === 4) h = h.split("").map((c) => c + c).join("");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  return null;
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Convert a CSS color string to a normalized #rrggbb hex (drops alpha). Returns null if unparseable or fully transparent. */
export function toHex(input: string | undefined | null): string | null {
  const c = parseColor(input);
  if (!c || c.a === 0) return null;
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/**
 * Composite a (possibly translucent) foreground color over an opaque background and return
 * opaque hex. Essential for dark UIs where borders/surfaces are low-alpha white/black overlays
 * (e.g. rgba(255,255,255,0.08)) — dropping the alpha would give a wrong, glaring color.
 * Returns null if the foreground is unparseable.
 */
export function compositeHex(fg: string | undefined | null, bgHex: string): string | null {
  const f = parseColor(fg);
  const b = parseColor(bgHex);
  if (!f || !b) return null;
  const a = f.a;
  const mix = (x: number, y: number) => Math.round(x * a + y * (1 - a));
  const h = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  return `#${h(mix(f.r, b.r))}${h(mix(f.g, b.g))}${h(mix(f.b, b.b))}`;
}

/** Perceived luminance 0..1 (sRGB relative luminance). */
export function luminance(c: { r: number; g: number; b: number }): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

/** Saturation 0..1 in HSL space — used to tell "colorful accent" from grey chrome. */
export function saturation(c: { r: number; g: number; b: number }): number {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return 0;
  const d = max - min;
  return l > 0.5 ? d / (2 - max - min) : d / (max + min);
}

/** Is this color effectively neutral (near-grey / near-black / near-white)? */
export function isNeutral(hex: string): boolean {
  const c = parseColor(hex);
  if (!c) return true;
  const lum = luminance(c);
  const sat = saturation(c);
  // low saturation OR pinned to the extremes of the value range = neutral chrome.
  return sat < 0.15 || lum < 0.04 || lum > 0.96;
}

/** Parse the leading numeric px value from a computed style string ("16px" -> 16). */
export function px(v: string | undefined | null): number | null {
  if (!v) return null;
  const m = String(v).match(/^(-?[\d.]+)px/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Cluster a list of positive px values into an ascending scale.
 * Rounds to the nearest `grid` (default 4), histograms, and keeps buckets whose
 * frequency clears `minCount`. Returns [] when nothing survives (caller applies fallback).
 */
export function clusterScale(values: number[], grid = 4, minCount = 2, max = 200): number[] {
  const hist = new Map<number, number>();
  for (const raw of values) {
    if (!Number.isFinite(raw) || raw <= 0 || raw > max) continue;
    const bucket = Math.round(raw / grid) * grid;
    if (bucket <= 0) continue;
    hist.set(bucket, (hist.get(bucket) ?? 0) + 1);
  }
  const kept = [...hist.entries()]
    .filter(([, count]) => count >= minCount)
    .map(([bucket]) => bucket)
    .sort((a, b) => a - b);
  return kept;
}

/**
 * Histogram positive px values into `grid`-sized buckets. Returns bucket -> count,
 * so callers can keep the dominant rhythm (top-N by count) and drop rare noise.
 */
export function histogram(values: number[], grid = 4, max = 200): Map<number, number> {
  const hist = new Map<number, number>();
  for (const raw of values) {
    if (!Number.isFinite(raw) || raw <= 0 || raw > max) continue;
    const bucket = Math.round(raw / grid) * grid;
    if (bucket <= 0) continue;
    hist.set(bucket, (hist.get(bucket) ?? 0) + 1);
  }
  return hist;
}

/** The canonical 4/8-point fallback scale used when inference is too sparse. */
export const STANDARD_SCALE = [4, 8, 12, 16, 24, 32, 48, 64, 96, 128];

/** Pick the N most frequent items from a frequency map, most-common first. */
export function topByFrequency<T>(freq: Map<T, number>, n: number): T[] {
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}

/**
 * Magic-byte sniff for downloaded assets. Returns a file extension (no dot) when the
 * bytes match a known font/image/vector signature, else null (treated as a dead/invalid asset).
 */
export function sniffExtension(buf: Buffer): string | null {
  if (buf.length < 4) return null;
  const ascii4 = buf.toString("latin1", 0, 4);
  // Fonts
  if (ascii4 === "wOF2") return "woff2";
  if (ascii4 === "wOFF") return "woff";
  if (ascii4 === "OTTO") return "otf";
  if (ascii4 === "true" || ascii4 === "ttcf") return "ttf";
  if (buf[0] === 0x00 && buf[1] === 0x01 && buf[2] === 0x00 && buf[3] === 0x00) return "ttf";
  // Raster images
  if (buf[0] === 0x89 && ascii4.slice(1) === "PNG") return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (ascii4 === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (ascii4 === "GIF8") return "gif";
  // ISOBMFF-based images (AVIF/HEIC) and video (MP4): `....ftyp<brand>` — common now that CDNs auto-serve
  // AVIF, and MP4 is how a reference ships its product-demo clips.
  if (buf.length >= 12 && buf.toString("latin1", 4, 8) === "ftyp") {
    const brand = buf.toString("latin1", 8, 12);
    if (brand === "avif" || brand === "avis") return "avif";
    if (brand.startsWith("hei") || brand === "mif1" || brand === "msf1") return "heic";
    return "mp4";
  }
  // Other media a reference embeds directly (<video>/<audio> src) — without these the clone keeps
  // hotlinking the reference's CDN for them.
  if (ascii4.startsWith("ID3") || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return "mp3";
  if (ascii4 === "OggS") return "ogg";
  if (ascii4 === "RIFF" && buf.toString("latin1", 8, 12) === "WAVE") return "wav";
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "webm";
  // SVG / XML (may have BOM or leading whitespace)
  const head = buf.toString("utf8", 0, Math.min(buf.length, 256)).replace(/^﻿/, "").trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<svg") || head.includes("<svg")) return "svg";
  return null;
}

/** Slugify a URL path into a safe filename stem. */
export function fileStemFromUrl(u: string): string {
  try {
    const url = new URL(u);
    const base = url.pathname.split("/").filter(Boolean).pop() ?? "asset";
    return base.replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 60) || "asset";
  } catch {
    return "asset";
  }
}
