// Repopulate the real extracted product-UI widgets with the USER'S content (build-guide §12 step 6).
// Folds the verified `_repop.ts` round-trip into a production module. The insight, proven on
// Linear's dashboard: swap ONLY text-node content via a model-generated semantic mapping
// (sidebar→nav, issue rows→job rows, labels→statuses). Structure + styling are preserved 100% by
// construction — the designed widget carries the user's content with the reference's craft intact.
// The builder then EMBEDS these widgets rather than improvising its own (which always looks generic).
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { LoadedComponent } from "../artifact/load.js";

export interface RepopulatedComponent {
  id: string;
  role: string;
  html: string; // the widget markup with text nodes swapped for the product's content
  width: number;
  height: number;
  bg: string;
  assets: string[]; // relative asset file names (design/components/assets/…)
  mapped: number; // slots the model mapped
  unmapped: number; // slots left as-is (structural / numeric)
}

/** Pick ONE short product/brand name up front so every widget AND the page use it consistently
 *  (closes the cross-widget brand-incoherence gap when the pool has many widgets). Screened against
 *  real companies in src/name.ts — re-exported so this module's call sites are unchanged. */
export { deriveProductName } from "../name.js";

/** Ask the model for a semantic string→string mapping that reroles the widget for the product. */
async function getMapping(slots: string[], productPrompt: string, productName: string, model: string): Promise<Record<string, string>> {
  const prompt = `A designed product-UI widget was extracted from a premium reference site. Below are its visible text strings. Repopulate them so the SAME widget presents a DIFFERENT product: "${productPrompt}". The product's name is exactly "${productName}" — use it VERBATIM wherever a workspace / app / logo / brand name appears (never invent a different name).

Map EACH string to a coherent equivalent that preserves its semantic ROLE and, importantly, its approximate LENGTH (the layout widths are pinned — a much longer string will look wrong):
- sidebar / nav labels -> this product's nav labels
- primary item titles (e.g. an issue or record title) -> this product's primary records
- statuses, tags, labels, priorities -> this product's equivalents
- people names / @mentions -> plausible names for this product's users
- activity-feed / log lines -> this product's activity ("deploy started", "run passed", etc.)
- IDs (e.g. ENG-2703) -> this product's ID style
- counts / timestamps -> realistic short values
Keep pure-structural strings (a lone "/", bare numbers, "…") mapped to themselves. Never invent fake customer names as testimonials — these are IN-PRODUCT strings, so realistic operational data is correct.

Hard constraints:
- Use PLAIN ASCII / Latin characters only. No other scripts (no Devanagari/CJK/etc.), no emoji, no decorative glyphs.
- The workspace / app / logo brand-name slot (the reference's product name, e.g. "Linear") must map to "${productName}" every time it appears. Do not stylize it or invent a different name.
- A replacement's length must stay close to the original's (the layout widths are pinned).

Return ONLY a JSON object {"<original>":"<replacement>", ...} covering EVERY string. No prose, no markdown fence.

Strings:
${JSON.stringify(slots)}`;

  // The model occasionally returns truncated or non-JSON output. One malformed mapping must never
  // destroy an entire build: retry once, and if it still fails fall back to an IDENTITY mapping —
  // the widget then keeps the reference's original copy, which is a visible imperfection but an
  // infinitely better outcome than losing the run.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const q = query({
      prompt,
      options: {
        model,
        allowedTools: [],
        settingSources: [],
        systemPrompt: "You are a precise data-transformation tool. Output only the requested JSON object, nothing else.",
      },
    });
    let out = "";
    for await (const m of q) if (m.type === "result" && m.subtype === "success") out = m.result;
    const start = out.indexOf("{");
    const end = out.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(out.slice(start, end + 1));
      } catch {
        /* fall through to retry */
      }
    }
    console.warn(`  ⚠ repopulation mapping was not valid JSON (attempt ${attempt}/2)`);
  }
  console.warn(`  ⚠ falling back to identity mapping — this widget keeps the reference's original copy.`);
  return {};
}

/**
 * Repopulate ONE widget. Loads the self-contained markup in a headless page, gets the mapping,
 * swaps text nodes, and returns the widget's outerHTML with the product's content — styling and
 * structure byte-for-byte the reference's. Asset refs are rewritten from ./assets/… to the public
 * path the workspace will serve them from.
 */
export async function repopulateComponent(
  component: LoadedComponent,
  productPrompt: string,
  productName: string,
  model: string,
  publicAssetPrefix: string,
): Promise<RepopulatedComponent> {
  const map = await getMapping(component.slots, productPrompt, productName, model);
  const widgetHtml = readFileSync(component.htmlPath, "utf8");

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      (globalThis as any).__name = (globalThis as any).__name || ((f: any) => f);
    });
    // Minimal wrapper doc — we only need the DOM to do a structure-preserving text swap.
    await page.setContent(`<!doctype html><html><head><meta charset="utf8"></head><body>${widgetHtml}</body></html>`, {
      waitUntil: "domcontentloaded",
    });

    const { html, mapped, unmapped } = await page.evaluate((m: Record<string, string>) => {
      // NOTE: no nested named functions in this body — tsx/esbuild would wrap them with __name(),
      // which isn't defined in the page context (ReferenceError). Cap logic is inlined instead.
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      let mapped = 0;
      let unmapped = 0;
      while ((n = walker.nextNode())) {
        const raw = n.textContent ?? "";
        const t = raw.trim();
        if (!t || !/[a-zA-Z0-9]/.test(t)) continue;
        if (m[t] !== undefined) {
          // Cap the replacement to ~the original's length (word boundary, no ellipsis) so longer
          // copy can't overflow a pinned box and overlap its neighbours — the residual pin roughness.
          let rep = m[t];
          const max = Math.ceil(t.length * 1.25) + 2;
          if (rep.length > max) {
            const cut = rep.slice(0, max);
            const sp = cut.lastIndexOf(" ");
            rep = (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/\s+$/, "");
          }
          n.textContent = raw.replace(t, rep);
          mapped++;
        } else {
          unmapped++;
        }
      }

      // ROOT FIX for widget text collisions. The extractor pins EVERY box to the source's measured
      // size. That is correct for STRUCTURAL dimensions but wrong for CONTENT-DRIVEN ones: when the
      // repopulated text differs in length it overflows its pinned slot and collides. The split is:
      //
      //   WIDTH  = structural → stays PINNED. (Unpinning it was the earlier mistake: a text box then
      //            shrink-fits to a narrower parent, wraps onto MORE lines, and overflows.)
      //   HEIGHT = content-driven → freed. A pinned height becomes a floor (min-height), never a
      //            ceiling, so a box GROWS to fit its text instead of spilling over the next row.
      //
      // Text may wrap inside its (still width-pinned) box and push the box taller; ancestors grow with
      // it. Flex is the other height trap: `flex-basis:0` / `flex:1` items take a distributed height
      // rather than their content's, so text overflows them — force those to size to content instead.
      // Media/SVG are untouched (their size is intrinsic, not content-driven).
      document.body.querySelectorAll("*").forEach((el) => {
        const tag = el.tagName.toLowerCase();
        if (tag === "svg" || el.closest("svg")) return;
        if (tag === "img" || tag === "canvas" || tag === "video" || tag === "input") return;
        const st = (el as HTMLElement).style;
        const cs = getComputedStyle(el);

        // Height: ceiling → floor, so every box can grow to fit its content.
        const h = st.height;
        if (h && h.indexOf("px") !== -1) { st.minHeight = h; st.height = "auto"; st.maxHeight = "none"; }
        else { st.maxHeight = "none"; }

        // A flex item in a COLUMN must size to its content, or a grown child overflows its slot.
        const parent = el.parentElement;
        if (parent) {
          const pcs = getComputedStyle(parent);
          if (pcs.display.indexOf("flex") !== -1 && pcs.flexDirection.indexOf("column") !== -1) {
            st.flexShrink = "0";
            st.flexBasis = "auto";
          }
        }

        let hasText = false;
        el.childNodes.forEach((c) => { if (c.nodeType === 3 && (c.textContent || "").trim()) hasText = true; });
        if (!hasText) return;

        // Is this box's WIDTH structural or content-driven? Decide from the ORIGINAL geometry: a box
        // that FILLED its parent was sized by the layout (structural → keep it pinned), while a box
        // narrower than its parent was shrink-wrapped to its own text (content-driven → it must
        // resize, or any longer replacement wraps or spills over the text beside it). This is the
        // distinction that was missing: a nav label, a status pill and an inline code chip are all
        // shrink-wrapped, so pinning them to the source's text width is exactly what broke them.
        const ownW = parseFloat(st.width); // the pinned width the extractor measured
        const parentContentW = el.parentElement ? el.parentElement.clientWidth : 0;
        const stretched = isFinite(ownW) && parentContentW > 0 && ownW >= parentContentW * 0.92;
        const floating = cs.position === "absolute" || cs.position === "fixed";

        if (floating) {
          // Out-of-flow label (e.g. a timeline milestone caption): nothing sits beside it to push, so
          // it sizes to its text and stays on one line.
          st.width = "max-content";
          st.maxWidth = "none";
          st.minHeight = "0";
          st.whiteSpace = "nowrap";
        } else if (stretched) {
          // A full-width block (a paragraph, a description): the width IS the column → keep it pinned
          // and let the text wrap inside it, growing the box taller.
          st.whiteSpace = "normal";
        } else {
          // Shrink-wrapped to its own text → size to content, capped at the parent so it can never
          // spill sideways; if the content genuinely exceeds the parent it wraps instead.
          st.width = "max-content";
          st.minWidth = "0";
          st.maxWidth = "100%";
          st.whiteSpace = "normal";
        }
        st.overflow = "visible";
        st.textOverflow = "clip";
      });

      const root = document.body.firstElementChild;
      return { html: root ? root.outerHTML : document.body.innerHTML, mapped, unmapped };
    }, map);

    // Rewrite the widget's local asset refs to the workspace's served path.
    const rewritten = html.split("./assets/").join(publicAssetPrefix.endsWith("/") ? publicAssetPrefix : publicAssetPrefix + "/");

    return {
      id: component.id,
      role: component.role,
      html: rewritten,
      width: component.width,
      height: component.height,
      bg: component.bg,
      assets: component.assets,
      mapped,
      unmapped,
    };
  } finally {
    await browser.close();
  }
}

/** Repopulate every widget in a design system, in sequence (keeps model calls orderly). All widgets
 *  share ONE productName so the whole library is brand-consistent (and consistent with the page). */
export async function repopulateAll(
  components: LoadedComponent[],
  productPrompt: string,
  productName: string,
  model: string,
  publicAssetPrefix: string,
): Promise<RepopulatedComponent[]> {
  const out: RepopulatedComponent[] = [];
  for (const c of components) {
    out.push(await repopulateComponent(c, productPrompt, productName, model, publicAssetPrefix));
  }
  return out;
}
