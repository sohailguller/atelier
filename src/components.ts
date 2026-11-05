// Production component extraction (build-guide §12 step 1). Folds the verified `_spike.ts`
// capability into a real module: select the richest product-UI subtree(s) in the hero region,
// clone them with computed styles inlined + inline SVGs kept + MEASURED WIDTHS PINNED + absolute
// positioning preserved (this is what kills the ~90% reflow roughness), download any referenced
// img/background assets so each widget is self-contained, and capture the text-node SLOTS the
// builder will repopulate. A premium site's quality lives in these designed widgets — the token
// pipeline never captured them, so this is the breakthrough that makes the output non-generic.
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { sniffExtension, fileStemFromUrl } from "./util.js";

/** One extracted product-UI widget: self-contained markup + the metadata a consumer needs. */
export interface ComponentCapture {
  id: string; // stable slug, e.g. "hero-widget"
  role: string; // semantic role of the surface (currently the hero product-UI widget)
  html: string; // self-contained markup (computed styles inlined, asset refs rewritten to ./assets/…)
  width: number; // measured px width of the widget
  height: number; // measured px height
  nodes: number; // element count (fidelity signal)
  bg: string; // page background behind the widget, for a faithful standalone render
  slots: string[]; // distinct visible text strings — the repopulation targets
  assetUrls: string[]; // absolute source URLs referenced by the widget (downloaded on emit)
}

/** What a raw in-page capture returns before assets are downloaded. */
interface RawCapture {
  html: string;
  width: number;
  height: number;
  nodes: number;
  bg: string;
  slots: string[];
  assetUrls: string[];
  canvasArea: number; // rendered px² of canvas/WebGL inside the widget (the un-extractable boundary)
  totalArea: number;
}

export interface ComponentExtractionResult {
  components: ComponentCapture[];
  /** Set when the strongest candidate widget is dominated by canvas/WebGL (pixels, not markup).
   *  Policy (§12 step 7): the caller must pick a DIFFERENT base rather than approximate it. */
  canvasBlocked: { role: string; canvasRatio: number } | null;
  notes: string[];
}

// The properties we inline. getComputedStyle returns FINAL resolved values, so this re-renders the
// widget faithfully without lifting any runtime CSS/JS. The list is deliberately WIDE (no
// simplifying): every property that carries the reference's craft — background opacity, layered
// borders, elevation/shadow depth, gradient/clipped text, tab + button treatments, masks, blend
// modes — is captured, so the rebuild honors the design instead of smoothing it out.
export const CLONE_PROPS = [
  // box / layout
  "display", "position", "box-sizing", "top", "left", "right", "bottom", "z-index", "height",
  "min-height", "max-height", "width", "min-width", "max-width", "flex", "flex-grow", "flex-shrink",
  "flex-basis", "flex-direction", "flex-wrap", "align-items", "align-self", "justify-content",
  "justify-self", "gap", "row-gap", "column-gap", "grid-template-columns", "grid-template-rows",
  "grid-auto-flow", "grid-column", "grid-row", "margin", "padding", "aspect-ratio", "order",
  // fills, opacity, layering (the panel/elevation depth — do NOT flatten these)
  "color", "background-color", "background-image", "background-size", "background-position",
  "background-repeat", "background-clip", "-webkit-background-clip", "background-origin",
  "background-blend-mode", "mix-blend-mode", "opacity", "box-shadow",
  // borders + radius (individual corners so asymmetric radii survive) + outline
  "border-top", "border-right", "border-bottom", "border-left", "border-radius",
  "border-top-left-radius", "border-top-right-radius", "border-bottom-left-radius",
  "border-bottom-right-radius", "outline", "outline-offset",
  // typography (incl. gradient/clipped text + text elevation — the tells that get smoothed away)
  "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align",
  "text-transform", "font-style", "font-variant", "font-feature-settings", "text-decoration",
  "text-shadow", "-webkit-text-fill-color", "-webkit-text-stroke", "text-overflow", "white-space",
  // effects / clipping / media
  "overflow", "object-fit", "object-position", "transform", "transform-origin", "backdrop-filter",
  "-webkit-backdrop-filter", "filter", "mask", "-webkit-mask", "clip-path", "fill", "stroke",
  "stroke-width", "cursor",
];

// Pseudo-element props: Linear's hairline dividers, gradient borders and glows live in ::before/
// ::after, which are NOT DOM nodes. We read their computed styles and materialize them as real
// child spans so that layer survives. A subset of CLONE_PROPS that makes sense on a positioned box.
export const PSEUDO_PROPS = [
  "position", "top", "left", "right", "bottom", "width", "height", "z-index", "display",
  "background-color", "background-image", "background-size", "background-position", "background-repeat",
  "background-clip", "-webkit-background-clip", "opacity", "box-shadow", "border-top", "border-right",
  "border-bottom", "border-left", "border-radius", "transform", "transform-origin", "backdrop-filter",
  "-webkit-backdrop-filter", "filter", "mask", "-webkit-mask", "mix-blend-mode", "color",
];

/**
 * Extract product-UI component(s) from an already-navigated page. Pure DOM/CSSOM work — never
 * depends on the pixel channel. `maxComponents` caps how many distinct (non-nested) rich surfaces
 * we lift; the hero widget is always first.
 */
export async function extractComponents(page: Page, maxComponents = 6): Promise<ComponentExtractionResult> {
  const notes: string[] = [];

  // Scroll the WHOLE page first so lazy-loaded product screens below the fold actually render
  // (many premium sites defer their richest surfaces). Then return to top for stable geometry.
  await page.evaluate(async () => {
    const step = Math.round(innerHeight * 0.8);
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 300));
  });

  const raws: RawCapture[] = await page.evaluate(
    ({ PROPS, PSEUDO, MAX }) => {
      const vw = innerWidth;
      const docH = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const scrollY = window.scrollY;
      const DEFAULTS = new Set(["normal", "none", "auto", "0px", "0", "visible", "rgba(0, 0, 0, 0)", "static", "0% 0%", "repeat", "border-box"]);

      // ---- 1. score every plausible product-UI container ACROSS THE WHOLE PAGE ----
      // Rich = bordered/shadowed/filled container with many descendants. We rank the whole page
      // (not just the hero region) so EVERY section can get a real product surface, not just the top.
      interface Cand { el: Element; score: number; area: number; nodes: number; docTop: number; }
      const cands: Cand[] = [];
      document.querySelectorAll("div,section,main,article,aside").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 300 || r.height < 180) return;
        if (el.closest("header,nav,footer")) return;
        const s = getComputedStyle(el);
        const rich =
          s.borderTopWidth !== "0px" || s.boxShadow !== "none" || s.backgroundColor !== "rgba(0, 0, 0, 0)" ||
          s.backgroundImage !== "none";
        if (!rich) return;
        const nodes = el.querySelectorAll("*").length;
        if (nodes < 40) return;
        const area = r.width * r.height;
        if (area > vw * docH * 0.9) return; // a page wrapper, not a widget
        cands.push({ el, score: nodes * Math.sqrt(area), area, nodes, docTop: r.top + scrollY });
      });
      cands.sort((a, b) => b.score - a.score);

      // Take the top non-nested candidates (a chosen widget's ancestor/descendant is not a NEW widget).
      const picked: Cand[] = [];
      for (const c of cands) {
        if (picked.length >= MAX) break;
        if (picked.some((p) => p.el.contains(c.el) || c.el.contains(p.el))) continue;
        picked.push(c);
      }
      if (!picked.length) return [];
      // Order top-to-bottom so the first is the hero and the rest map to sections in reading order.
      const chosen = picked.sort((a, b) => a.docTop - b.docTop);

      // ---- 2. clone a chosen subtree into self-contained markup ---------------
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      const results: any[] = [];
      for (const { el: root } of chosen) {
        let count = 0;
        let canvasArea = 0;
        const assetUrls = new Set<string>();

        const esc = (t: string) => t.replace(/[<>&]/g, (m) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[m]!));
        const collectAssets = (bgImage: string, tag: string, node: Element) => {
          for (const m of bgImage.matchAll(/url\((['"]?)([^'")]+)\1\)/g)) {
            const u = m[2];
            if (u && !u.startsWith("data:")) { try { assetUrls.add(new URL(u, location.href).href); } catch {} }
          }
          if (tag === "img") {
            const src = (node as HTMLImageElement).currentSrc || (node as HTMLImageElement).src;
            if (src && !src.startsWith("data:")) { try { assetUrls.add(new URL(src, location.href).href); } catch {} }
          }
        };

        // Materialize a ::before/::after pseudo-element as a real <span> so decorative layers
        // (hairline dividers, gradient borders, glows) survive the clone instead of being smoothed
        // out. Returns "" when the pseudo isn't rendered.
        const pseudoSpan = (node: Element, which: "::before" | "::after"): string => {
          const ps = getComputedStyle(node, which);
          const content = ps.content;
          if (!content || content === "none" || content === "normal") return "";
          let style = "";
          for (const p of PSEUDO) {
            const v = ps.getPropertyValue(p);
            if (v && !DEFAULTS.has(v.trim())) style += `${p}:${v};`;
          }
          collectAssets(ps.backgroundImage, "", node);
          // A non-empty quoted content string becomes real text; url()/empty stays a styled box.
          let text = "";
          const q = content.match(/^"(.*)"$/s) || content.match(/^'(.*)'$/s);
          if (q && q[1]) text = esc(q[1]);
          if (!style && !text) return "";
          count++;
          return `<span style="${style}">${text}</span>`;
        };

        const clone = (node: Element): string => {
          const tag = node.tagName.toLowerCase();
          if (tag === "svg") { count++; return node.outerHTML; } // inline SVG kept verbatim
          if (tag === "script" || tag === "style" || tag === "noscript") return "";
          const s = getComputedStyle(node);
          if (s.display === "none" || s.visibility === "hidden") return "";
          const rect = node.getBoundingClientRect();
          if (tag === "canvas") { canvasArea += rect.width * rect.height; } // un-extractable: pixels, not markup
          count++;

          let style = "";
          for (const p of PROPS) {
            const v = s.getPropertyValue(p);
            if (v && !DEFAULTS.has(v.trim())) style += `${p}:${v};`;
          }
          // PIN the measured width so nothing reflows and longer repopulated text can't push
          // siblings out of alignment (misalignment is itself a vibe-coded tell). min/max-width are
          // forced to the same value so a captured min/max can't fight the pin. Non-inline boxes only.
          const pw = Math.round(rect.width);
          if (rect.width > 0 && !s.display.startsWith("inline")) style += `width:${pw}px;min-width:${pw}px;max-width:${pw}px;flex:0 0 auto;`;
          else if (rect.width > 0 && s.display === "inline-block") style += `width:${pw}px;min-width:${pw}px;max-width:${pw}px;`;
          // Text-bearing boxes must be free to GROW vertically when repopulated text is longer, or the
          // extra line overflows a captured fixed height and overlaps the next row. Drop height caps
          // on elements that directly contain text; pure layout boxes keep their measured height.
          const hasText = Array.from(node.childNodes).some((c) => c.nodeType === 3 && (c.textContent ?? "").trim());
          if (hasText) style += `height:auto;min-height:0;max-height:none;`;

          collectAssets(s.backgroundImage, tag, node);

          // Pseudo-elements (materialized). If a pseudo is absolutely positioned but this box is
          // static, anchor it by forcing position:relative so the decorative layer lands correctly.
          const before = count < 3800 ? pseudoSpan(node, "::before") : "";
          const after = count < 3800 ? pseudoSpan(node, "::after") : "";
          if ((before || after) && s.position === "static") style += "position:relative;";

          let inner = before;
          node.childNodes.forEach((c) => {
            if (c.nodeType === 3) {
              const t = c.textContent ?? "";
              if (t.trim()) inner += esc(t);
            } else if (c.nodeType === 1 && count < 4000) {
              inner += clone(c as Element);
            }
          });
          inner += after;

          const isVoid = /^(img|input|br|hr)$/.test(tag);
          const src = tag === "img" ? ` src="${(node as HTMLImageElement).currentSrc || (node as HTMLImageElement).src}"` : "";
          const alt = tag === "img" ? ` alt=""` : "";
          return isVoid ? `<${tag} style="${style}"${src}${alt}>` : `<${tag} style="${style}">${inner}</${tag}>`;
        };

        const html = clone(root);
        const r = root.getBoundingClientRect();

        // Distinct visible text strings = the repopulation slots.
        const slotSet = new Set<string>();
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let tn: Node | null;
        while ((tn = walker.nextNode())) {
          const t = (tn.textContent ?? "").trim();
          if (t && /[a-zA-Z0-9]/.test(t)) slotSet.add(t);
        }

        results.push({
          html,
          width: Math.round(r.width),
          height: Math.round(r.height),
          nodes: count,
          bg: bodyBg,
          slots: [...slotSet],
          assetUrls: [...assetUrls],
          canvasArea,
          totalArea: r.width * r.height,
        });
      }
      return results;
    },
    { PROPS: CLONE_PROPS, PSEUDO: PSEUDO_PROPS, MAX: maxComponents },
  );

  if (!raws.length) {
    notes.push("COMPONENT: no rich product-UI surface found on the page (site may be text-only marketing).");
    return { components: [], canvasBlocked: null, notes };
  }

  // Canvas/WebGL guard (§12 step 7): if the strongest widget is mostly canvas pixels, it is not
  // replicable as markup. Do NOT approximate — flag it so the caller picks a different base.
  const primary = raws[0];
  const canvasRatio = primary.totalArea > 0 ? primary.canvasArea / primary.totalArea : 0;
  let canvasBlocked: ComponentExtractionResult["canvasBlocked"] = null;
  if (canvasRatio > 0.4) {
    canvasBlocked = { role: "hero-widget", canvasRatio: Math.round(canvasRatio * 100) / 100 };
    notes.push(
      `COMPONENT[canvas]: the hero widget is ${Math.round(canvasRatio * 100)}% canvas/WebGL (pixels, not markup) — ` +
        `un-extractable. Policy: pick a DIFFERENT reference base rather than approximate it.`,
    );
  }

  // QUALITY GATE (post-clone, on RENDERED nodes): a hero-standard product widget is DENSE — many
  // designed elements per unit area. A sparse, tall marketing band (a headline over mostly-empty
  // space, or a blank canvas graph) has a low rendered-node density and is rejected, because it
  // would embed as flat slop rather than a rich visual. Uses the clone count, not the DOM
  // descendant count, so hidden/lazy nodes can't inflate a sparse surface past the gate.
  const MIN_DENSITY = 0.8; // rendered nodes per 10k px²
  // A hero-standard, repopulatable widget is dense AND text-bearing. Two failure modes to reject:
  //  - sparse marketing bands (low node density), and
  //  - decorative/JS-animated grids (a huge pile of nodes with almost no text — e.g. a dot-density
  //    counter whose digits are runtime-driven, so it extracts jumbled and carries no real content).
  const quality = (r: RawCapture) => {
    if (r.nodes / (Math.max(r.totalArea, 1) / 10000) < MIN_DENSITY) return false; // too sparse
    if (r.slots.length < 8) return false; // no real content to repopulate
    if (r.nodes / Math.max(r.slots.length, 1) > 25) return false; // ~all decorative nodes → texture/animated grid
    return true;
  };
  const notCanvas = (r: RawCapture) => (r.canvasArea / Math.max(r.totalArea, 1)) <= 0.4;
  const rejected = raws.filter((r) => notCanvas(r) && !quality(r)).length;
  if (rejected) notes.push(`COMPONENT: dropped ${rejected} surface(s) below the quality gate (sparse marketing bands or decorative/animated grids, not hero-standard product UI).`);

  const components: ComponentCapture[] = raws
    .filter(notCanvas) // drop any canvas-dominated surface
    .filter(quality) // only rich, repopulatable product widgets qualify
    .map((r, i) => ({
      id: i === 0 ? "hero-widget" : `product-surface-${i + 1}`,
      role: i === 0 ? "hero-widget" : "product-surface",
      html: r.html,
      width: r.width,
      height: r.height,
      nodes: r.nodes,
      bg: r.bg,
      slots: r.slots,
      assetUrls: r.assetUrls,
    }));

  notes.push(
    `COMPONENT: captured ${components.length} widget(s) — ` +
      components.map((c) => `${c.id} (${c.width}×${c.height}, ${c.nodes} nodes, ${c.slots.length} slots)`).join(", "),
  );
  return { components, canvasBlocked, notes };
}

// ---------------------------------------------------------------------------
// Emit: write each widget's self-contained HTML + download its assets into design-system/components/.
// Rewrites every asset URL in the markup to a local ./assets/<file> reference so no widget points
// at a dead URL (the same "never a dead url()" guarantee the token pipeline gives, applied to widgets).

const HEADERS = (referer: string) => ({
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Referer: referer,
  Accept: "*/*",
});

/** A component entry as recorded in the manifest (self-contained, file-relative). */
export interface EmittedComponent {
  id: string;
  role: string;
  file: string; // relative to components/, e.g. "hero-widget.html"
  width: number;
  height: number;
  nodes: number;
  bg: string;
  slots: string[];
  assets: string[]; // relative to components/assets/
}

async function downloadComponentAsset(
  url: string,
  destDir: string,
  referer: string,
  used: Set<string>,
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const res = await fetch(url, { headers: HEADERS(referer), signal: controller.signal, redirect: "follow" });
    clearTimeout(timer);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;
    const sniffed = sniffExtension(buf);
    if (!sniffed) return null; // an HTML error page, not a real asset
    // Trust the URL's extension only if it agrees with the bytes; else use the sniffed one. CDNs
    // auto-serve AVIF from a `.png` URL, so a mismatched extension would break static serving.
    const urlExt = (path.extname(new URL(url).pathname).replace(".", "") || "").toLowerCase();
    const ext = urlExt && urlExt === sniffed ? urlExt : sniffed;
    let name = `${fileStemFromUrl(url)}.${ext}`;
    let i = 1;
    while (used.has(name)) name = `${fileStemFromUrl(url)}-${i++}.${ext}`;
    used.add(name);
    await writeFile(path.join(destDir, name), buf);
    return name;
  } catch {
    return null;
  }
}

/**
 * Write captured components into `<dsDir>/components/`, downloading + rewriting their assets.
 * Returns the manifest entries. Never leaves a dead asset ref in the emitted markup.
 */
export async function emitComponents(
  dsDir: string,
  captures: ComponentCapture[],
  referer: string,
): Promise<{ entries: EmittedComponent[]; notes: string[] }> {
  const notes: string[] = [];
  const entries: EmittedComponent[] = [];
  if (!captures.length) return { entries, notes };

  const compDir = path.join(dsDir, "components");
  const assetDir = path.join(compDir, "assets");
  await mkdir(assetDir, { recursive: true });
  const usedNames = new Set<string>();

  for (const cap of captures) {
    let html = cap.html;
    const savedAssets: string[] = [];
    for (const url of cap.assetUrls) {
      const saved = await downloadComponentAsset(url, assetDir, referer, usedNames);
      if (saved) {
        savedAssets.push(saved);
        // Rewrite every occurrence of the source URL to the local relative path.
        html = html.split(url).join(`./assets/${saved}`);
      } else {
        // Drop a dead/un-fetchable reference: neutralize the bg-image so it never 404s at render.
        html = html.split(`url(${url})`).join("none").split(`url("${url}")`).join("none").split(`url('${url}')`).join("none");
      }
    }
    const file = `${cap.id}.html`;
    await writeFile(path.join(compDir, file), html + "\n");
    entries.push({
      id: cap.id,
      role: cap.role,
      file,
      width: cap.width,
      height: cap.height,
      nodes: cap.nodes,
      bg: cap.bg,
      slots: cap.slots,
      assets: savedAssets,
    });
    notes.push(`COMPONENT[emit]: ${file} (${savedAssets.length}/${cap.assetUrls.length} assets downloaded)`);
  }

  // A README so the folder is self-describing (how to render one standalone).
  await writeFile(
    path.join(compDir, "README.md"),
    `# Extracted product-UI components\n\n` +
      `Each \`*.html\` is a self-contained widget extracted from the reference: computed styles are inlined, ` +
      `inline SVGs kept, measured widths pinned (no reflow), and asset URLs rewritten to \`./assets/…\`. ` +
      `To render one faithfully, wrap it in a document that imports the design system's \`fonts.css\` and set ` +
      `the body background to the entry's \`bg\`. The builder repopulates the text nodes with the user's ` +
      `content (structure + styling preserved 100%), then embeds the widget.\n\n` +
      entries.map((e) => `- **${e.id}** — ${e.role}, ${e.width}×${e.height}px, ${e.nodes} nodes, ${e.slots.length} text slots`).join("\n") +
      "\n",
  );
  return { entries, notes };
}
