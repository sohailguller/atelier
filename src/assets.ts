// Asset acquisition. Recovery branch #4: fonts/SVGs/bg-images must be REAL files in the
// workspace, never dead url()s. Everything is fetched server-side (avoids page CORS),
// verified by magic bytes, and saved with a correct extension. Anything that fails
// verification is dropped and reported — no emitted token points at a dead URL.
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { RawMeasurements, AssetReport } from "./types.js";
import { sniffExtension, fileStemFromUrl } from "./util.js";

const HEADERS = (referer: string) => ({
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Referer: referer,
  Accept: "*/*",
});

const FONT_EXTS = new Set(["woff2", "woff", "otf", "ttf"]);

async function fetchBinary(
  url: string,
  kind: "font" | "asset",
  destDir: string,
  referer: string,
  usedNames: Set<string>
): Promise<AssetReport> {
  const base: AssetReport = { kind, sourceUrl: url, savedAs: null, bytes: 0, ok: false, reason: "" };
  if (url.startsWith("data:")) return { ...base, reason: "data: URI (inline, not downloaded)" };

  let buf: Buffer;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const res = await fetch(url, { headers: HEADERS(referer), signal: controller.signal, redirect: "follow" });
    clearTimeout(timer);
    if (!res.ok) return { ...base, reason: `HTTP ${res.status}` };
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return { ...base, reason: `fetch failed: ${(e as Error).message}` };
  }

  if (buf.length === 0) return { ...base, bytes: 0, reason: "empty body" };

  // Verify by magic bytes — the actual guard against dead / HTML-error-page url()s.
  const sniffed = sniffExtension(buf);
  if (!sniffed) {
    return { ...base, bytes: buf.length, reason: `unrecognized bytes (likely an error page, not a real asset)` };
  }
  // A font URL that returns image bytes (or vice-versa) is treated as a mismatch/dead.
  if (kind === "font" && !FONT_EXTS.has(sniffed)) {
    return { ...base, bytes: buf.length, reason: `expected a font, got ${sniffed}` };
  }

  // Preserve a sensible extension: trust the URL's if it matches, else the sniffed one.
  const urlExt = (path.extname(new URL(url).pathname).replace(".", "") || "").toLowerCase();
  const ext = urlExt && (urlExt === sniffed || (FONT_EXTS.has(urlExt) && FONT_EXTS.has(sniffed))) ? urlExt : sniffed;

  let name = `${fileStemFromUrl(url)}.${ext}`;
  let i = 1;
  while (usedNames.has(name)) name = `${fileStemFromUrl(url)}-${i++}.${ext}`;
  usedNames.add(name);

  await writeFile(path.join(destDir, name), buf);
  return { kind, sourceUrl: url, savedAs: name, bytes: buf.length, ok: true, reason: "verified" };
}

export interface AssetResult {
  fontsDir: string;
  assetsDir: string;
  reports: AssetReport[];
  fontFiles: string[];
  assetFiles: string[];
}

export async function downloadAssets(raw: RawMeasurements, dsDir: string): Promise<AssetResult> {
  const fontsDir = path.join(dsDir, "fonts");
  const assetsDir = path.join(dsDir, "assets");
  await mkdir(fontsDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });

  const referer = raw.url;
  const reports: AssetReport[] = [];
  const fontNames = new Set<string>();
  const assetNames = new Set<string>();

  // --- fonts (dedupe URLs across all @font-face entries) ---
  const fontUrls = [...new Set(raw.fontFaces.flatMap((f) => f.urls))].filter((u) => !u.startsWith("data:"));
  // Prefer woff2 when the same face ships multiple formats, to keep the folder lean.
  for (const url of fontUrls) {
    reports.push(await fetchBinary(url, "font", fontsDir, referer, fontNames));
  }

  // --- assets (background images / SVGs) ---
  const assetUrls = [...new Set(raw.backgroundImages)].filter((u) => !u.startsWith("data:"));
  for (const url of assetUrls) {
    reports.push(await fetchBinary(url, "asset", assetsDir, referer, assetNames));
  }

  // --- inline SVGs pulled from the DOM (logos / signature marks) ---
  let svgIdx = 0;
  for (const svg of raw.inlineSvgs) {
    const buf = Buffer.from(svg.markup, "utf8");
    const sniffed = sniffExtension(buf);
    if (sniffed !== "svg") {
      reports.push({ kind: "asset", sourceUrl: `inline-svg#${svgIdx}`, savedAs: null, bytes: buf.length, ok: false, reason: "not valid svg markup" });
      svgIdx++;
      continue;
    }
    let name = `${svg.context}-mark-${svg.w}x${svg.h}.svg`;
    let i = 1;
    while (assetNames.has(name)) name = `${svg.context}-mark-${svg.w}x${svg.h}-${i++}.svg`;
    assetNames.add(name);
    await writeFile(path.join(assetsDir, name), buf);
    reports.push({ kind: "asset", sourceUrl: `inline-svg (${svg.context})`, savedAs: name, bytes: buf.length, ok: true, reason: "extracted from DOM" });
    svgIdx++;
  }

  const fontFiles = reports.filter((r) => r.kind === "font" && r.ok).map((r) => r.savedAs!);
  const assetFiles = reports.filter((r) => r.kind === "asset" && r.ok).map((r) => r.savedAs!);
  return { fontsDir, assetsDir, reports, fontFiles, assetFiles };
}
