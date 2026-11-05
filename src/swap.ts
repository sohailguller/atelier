// GLOBAL WORDING SWAP over a whole-page clone (the second half of the strip-back spec).
//
// The clone in src/clone.ts reproduces the reference's layout/structure/styling/components exactly.
// This module changes ONLY the words: it asks the model to write the USER's OWN product copy for each
// of the reference's text slots (same role, similar length), then swaps the text nodes in place. The
// structure and styling are preserved 100% by construction — nothing is recomposed. Diagrams that are
// just labelled visuals get relabelled by the same swap; genuinely-different diagrams are the separate
// in-style-recreation case (not handled here).
//
// The reference's original copy never appears in the output — it is entirely replaced by the user's
// product content the model generates.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { query } from "@anthropic-ai/claude-agent-sdk";

/** One product name up front so the whole page (nav, logo, footer, in-page mentions) is consistent.
 *  Lives in src/name.ts, which screens the generated name against real companies before returning it
 *  (an unscreened name shipped real brands — "Uptrace", "Flagsmith" — as the invented product).
 *  Re-exported here so existing call sites keep importing it from ./swap.js. */
export { deriveProductName } from "./name.js";
import { deriveProductName } from "./name.js";

/**
 * Ask the model to rewrite the page's copy for the user's product. Input strings are the reference's
 * text slots (so roles + lengths are known); output is the user's own content. Chunked so a large
 * page stays within a comfortable response size, but every chunk shares the product + name so the
 * narrative stays coherent.
 */
/** Parse the model's JSON object out of a response, tolerating markdown fences / stray prose. */
function extractJsonObject(out: string): Record<string, string> | null {
  let t = out.trim().replace(/^```(?:json)?/i, "").replace(/```$/,"").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s === -1 || e <= s) return null;
  try { const o = JSON.parse(t.slice(s, e + 1)); return o && typeof o === "object" ? o : null; } catch { return null; }
}

/** Map one slice of strings, retrying; on repeated failure SPLIT and recurse so a single bad response
 *  can't strand a whole section (the hero) in the reference's original copy. Bottoms out at identity. */
async function mapSlice(slice: string[], productPrompt: string, productName: string, model: string, depth = 0): Promise<Record<string, string>> {
  const prompt = `You are rewriting a cloned landing page so it presents a DIFFERENT product, keeping the exact same design. Below are the page's visible text strings, in reading order. Rewrite EACH one as copy for this product: "${productPrompt}". The product's name is exactly "${productName}".

Rules:
- Preserve each string's ROLE and approximate LENGTH (headline stays a headline of similar length, a nav label stays one short word, a stat stays a stat, a testimonial quote stays a quote, code stays plausible code). The layout is fixed, so a much longer string will break it.
- Wherever the original names the reference product, use "${productName}". Use plausible, specific, grounded copy for THIS product — never generic filler, never fabricated customer names as if real.
- Plain ASCII only. Keep pure-structural strings (a lone "/", bare numbers, punctuation, single letters) mapped to themselves.

Return ONLY a JSON object {"<original>":"<replacement>", ...} covering EVERY string. No prose, no markdown fence.

Strings:
${JSON.stringify(slice)}`;
  const result: Record<string, string> = {};
  const missing = () => slice.filter((s) => !(s in result));
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const q = query({ prompt, options: { model, allowedTools: [], settingSources: [], systemPrompt: "You are a precise data-transformation tool. Output only the requested JSON object, nothing else." } });
      let out = "";
      for await (const m of q) if (m.type === "result" && m.subtype === "success") out = m.result;
      const parsed = extractJsonObject(out);
      if (parsed) for (const k of Object.keys(parsed)) if (slice.includes(k) && typeof parsed[k] === "string") result[k] = parsed[k];
      if (missing().length === 0) return result;
    } catch { /* retry */ }
  }
  // Still-missing slots after retries → split them and recurse so one bad response never strands a whole
  // section (the hero) in the reference's original copy. Bottoms out at identity for a lone stubborn slot.
  const left = missing();
  if (left.length && depth < 6) {
    if (left.length === 1) { result[left[0]] = left[0]; console.warn(`  ⚠ swap: 1 slot kept as-is after retries.`); }
    else {
      const mid = Math.ceil(left.length / 2);
      const [a, b] = await Promise.all([
        mapSlice(left.slice(0, mid), productPrompt, productName, model, depth + 1),
        mapSlice(left.slice(mid), productPrompt, productName, model, depth + 1),
      ]);
      Object.assign(result, a, b);
    }
  } else {
    for (const s of left) result[s] = s;
  }
  return result;
}

async function getMapping(strings: string[], productPrompt: string, productName: string, model: string): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const CHUNK = 80; // smaller chunks fail less often and a failure isolates faster
  const chunks: string[][] = [];
  for (let i = 0; i < strings.length; i += CHUNK) chunks.push(strings.slice(i, i + CHUNK));
  const results = await Promise.all(chunks.map((c) => mapSlice(c, productPrompt, productName, model)));
  for (const r of results) Object.assign(map, r);
  return map;
}

export interface SwapResult { html: string; mapped: number; unmapped: number; productName: string }

/**
 * Swap the wording in a cloned index.html for the user's product, preserving structure + styling.
 * Returns the rewritten full-document HTML.
 */
export async function swapWording(indexHtmlPath: string, productPrompt: string, productName: string, model: string, brand = ""): Promise<SwapResult> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => { (globalThis as any).__name = (globalThis as any).__name || ((f: any) => f); });
    await page.goto("file://" + path.resolve(indexHtmlPath), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);

    // 0. DE-SMEAR. The reference decorates its feature illustrations with an "aurora" of its OWN wordmark
    //    repeated many times (absolute-positioned, cross-fading). With JS off those frozen copies stack,
    //    and the wording swap would turn each into the product name → a "FlagportFlagport" smear. The real
    //    nav/footer logo is an SVG (handled by de-brand), so brand-TEXT leaves here are all decorative →
    //    remove them before swapping. (Runs while the text is still the reference brand.)
    if (brand) {
      const n = await page.evaluate((b: string) => {
        const re = new RegExp("^" + b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i");
        const hits = [...document.querySelectorAll("body *")].filter((el) => el.children.length === 0 && re.test((el.textContent || "").trim()));
        if (hits.length < 3) return 0;
        let r = 0;
        hits.forEach((el) => { if (el.closest('header,nav,footer,a[href="/"],[class*=logo]')) return; el.remove(); r++; });
        return r;
      }, brand);
      if (n) console.log(`  de-smear: removed ${n} decorative brand-wordmark repetition(s)`);
    }

    // 0b. MARK social-proof sections while the copy is STILL THE REFERENCE'S. The removal pass (D) runs
    //     after the wording swap, so by then its text signals ("trusted by", "customers", a CEO title) have
    //     already been rewritten into the user's product copy and no longer match — Linear's testimonial
    //     band survived that way and shipped real named people (Gabriel Peal, Kaz Nejatian) endorsing an
    //     invented product. Detect on the original text here; (D) then removes whatever is marked.
    const marked = await page.evaluate(() => {
      const SOCIAL = /industry leaders|customer|testimonial|loved by|trusted by|community|success stor|what .* say|shipping with|in good company|join thousands/i;
      const ROLE = /\b(CEO|CTO|COO|Founder|Co-?founder|Head of|VP|President|Staff|Engineer|Director|Manager|Lead)\b/;
      const NAME = /^[A-Z][a-z]+(?: [A-Z][a-z'’.-]+){1,2}$/;
      let n = 0;
      const mark = (el: Element) => { if (!el.hasAttribute("data-atl-social")) { el.setAttribute("data-atl-social", "1"); n++; } };

      // (i) Section-level: an explicit social-proof band.
      [...document.querySelectorAll("section")].forEach((sec) => {
        const heading = [...sec.querySelectorAll("h1,h2,h3")][0]?.textContent || "";
        const txt = sec.textContent || "";
        const quotes = sec.querySelectorAll("blockquote,figure,q").length;
        if (ROLE.test(txt) && (SOCIAL.test(heading + " " + txt.slice(0, 400)) || quotes >= 2)) mark(sec);
      });

      // (ii) Attribution CLUSTERS, which are not always inside a <section> — Linear's testimonial carousel
      //      is a bare div, so a section-scoped rule alone still shipped "Gabriel Peal · OpenAI" endorsing
      //      an invented product. An attribution is a person-name leaf whose immediate parent adds only a
      //      short company/role tail ("Nik KoblovHead of Engineering, Ramp"). Three of them in one modest
      //      container is a testimonial wall; climb to that container and mark it.
      const attributions = [...document.querySelectorAll("body *")].filter((el) => {
        if (el.children.length !== 0) return false;
        const t = (el.textContent || "").trim();
        if (!NAME.test(t)) return false;
        const par = (el.parentElement?.textContent || "").trim();
        return par.length > t.length && par.length <= 80; // name + a short role/company tail
      });
      const seen = new Set<Element>();
      for (const leaf of attributions) {
        if (seen.has(leaf)) continue;
        let el: Element | null = leaf.parentElement;
        for (let i = 0; i < 8 && el && el.tagName !== "BODY"; i++) {
          const inside = attributions.filter((a) => el!.contains(a));
          const len = (el.textContent || "").replace(/\s+/g, " ").trim().length;
          if (inside.length >= 3 && len <= 3000) {
            // PROPORTIONALITY GUARD. A testimonial wall carries about one avatar per attribution. If the
            // smallest container holding these names is stuffed with graphics, it is a product/feature
            // region that merely happens to contain names — removing it deleted 83 of Resend's 92 images.
            // Climbing further only makes that worse, so abandon the cluster instead.
            const graphics = el.querySelectorAll("img,svg").length;
            const tall = el.getBoundingClientRect().height > 2000;
            if (graphics <= inside.length * 4 && !tall) { inside.forEach((a) => seen.add(a)); mark(el); }
            break;
          }
          if (len > 3000) break; // never climb into the whole page
          el = el.parentElement;
        }
      }
      return n;
    });
    if (marked) console.log(`  marked ${marked} social-proof section(s) (detected on the reference's own copy)`);

    // 1. Collect the distinct visible text strings — from the live DOM AND from the recorded tab snapshots
    //    (the non-default tabs' content lives only in the atl-tabs JSON, not the DOM, so it must be
    //    collected here or clicking a tab would reveal the reference's original, unswapped copy).
    const strings: string[] = await page.evaluate(() => {
      const set = new Set<string>();
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = w.nextNode())) { const t = (n.textContent ?? "").trim(); if (t && /[a-zA-Z0-9]/.test(t)) set.add(t); }
      const tabs = document.getElementById("atl-tabs");
      if (tabs) {
        try {
          const data = JSON.parse(tabs.textContent || "{}");
          const tmp = document.createElement("div");
          for (const gid in data) for (const html of data[gid]) {
            tmp.innerHTML = html;
            const tw = document.createTreeWalker(tmp, NodeFilter.SHOW_TEXT);
            let t2: Node | null; while ((t2 = tw.nextNode())) { const t = (t2.textContent ?? "").trim(); if (t && /[a-zA-Z0-9]/.test(t)) set.add(t); }
          }
        } catch { /* ignore */ }
      }
      return [...set];
    });

    // 2. Get the user's product copy for each slot.
    const map = await getMapping(strings, productPrompt, productName, model);

    // 3. Swap the text nodes + free the height of every box whose text changed, so the reference's
    //    fixed layout (built for its own copy) can grow rather than clip if a replacement runs longer.
    const { mapped, unmapped } = await page.evaluate((m: Record<string, string>) => {
      const changed = new Set<Element>();
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      let mapped = 0, unmapped = 0;
      while ((n = w.nextNode())) {
        const raw = n.textContent ?? "";
        const t = raw.trim();
        if (!t || !/[a-zA-Z0-9]/.test(t)) continue;
        if (m[t] !== undefined) {
          // Cap the replacement near the original length (word boundary) so a fixed box can't overflow.
          let rep = m[t];
          const max = Math.ceil(t.length * 1.3) + 3;
          if (rep.length > max) { const cut = rep.slice(0, max); const sp = cut.lastIndexOf(" "); rep = (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/\s+$/, ""); }
          n.textContent = raw.replace(t, rep);
          if (n.parentElement) changed.add(n.parentElement);
          mapped++;
        } else unmapped++;
      }
      // Free heights up the ancestor chain of every changed text node so grown copy is never clipped.
      changed.forEach((leaf) => {
        let el: Element | null = leaf;
        for (let i = 0; i < 4 && el; i++) {
          const st = (el as HTMLElement).style;
          const h = st.height;
          // Unpin height so grown copy grows instead of clipping, and free ONLY the vertical axis.
          // Never touch overflow-x: the reference's horizontal scroll containers (code viewers,
          // carousels) must keep clipping — freeing them lets a wide child drag the whole page wide.
          if (h && h.indexOf("px") !== -1) { st.minHeight = h; st.height = "auto"; st.maxHeight = "none"; st.overflowY = "visible"; }
          st.whiteSpace = st.whiteSpace === "nowrap" ? "normal" : st.whiteSpace;
          el = el.parentElement;
        }
      });
      return { mapped, unmapped };
    }, map);

    // 3b. Apply the SAME mapping to the recorded tab snapshots (the non-default tabs' content), so clicking
    //     a tab shows the swapped product copy — not the reference's original.
    await page.evaluate((m: Record<string, string>) => {
      const el = document.getElementById("atl-tabs"); if (!el) return;
      let data: Record<string, string[]> = {};
      try { data = JSON.parse(el.textContent || "{}"); } catch { return; }
      const tmp = document.createElement("div");
      const swapText = (html: string) => {
        tmp.innerHTML = html;
        const w = document.createTreeWalker(tmp, NodeFilter.SHOW_TEXT);
        let n: Node | null;
        while ((n = w.nextNode())) {
          const raw = n.textContent ?? ""; const t = raw.trim();
          if (t && m[t] !== undefined) {
            let rep = m[t]; const max = Math.ceil(t.length * 1.3) + 3;
            if (rep.length > max) { const cut = rep.slice(0, max); const sp = cut.lastIndexOf(" "); rep = (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/\s+$/, ""); }
            n.textContent = raw.replace(t, rep);
          }
        }
        return tmp.innerHTML;
      };
      for (const gid in data) data[gid] = data[gid].map(swapText);
      el.textContent = JSON.stringify(data).replace(/<\//g, "<\\/");
    }, map);

    // 4. DE-BRAND. The wording swap only touches text nodes, so the reference's IDENTITY — which lives in
    //    SVG/img LOGOS and aria-labels, not text — leaks through untouched (its own wordmark in nav/footer,
    //    and a marquee of its real customers' logos). Neutralise all of it deterministically: the ref's own
    //    logo → a product wordmark; third-party customer logo walls → removed (we can't claim someone
    //    else's customers); any residual brand string in text/attrs → the product name.
    const debr = await page.evaluate(({ brand, productName }) => {
      let logos = 0, walls = 0, text = 0, social = 0, decor = 0, smear = 0;
      const isLogo = (el: Element) => { const l = (el.getAttribute("aria-label") || el.getAttribute("alt") || "").trim(); return !!l && l.length <= 30 && /^[A-Za-z0-9][A-Za-z0-9 .&_-]*$/.test(l); };
      const names = (c: Element) => new Set([...c.querySelectorAll("svg[aria-label],img[alt]")].filter(isLogo).map((x) => (x.getAttribute("aria-label") || x.getAttribute("alt") || "").toLowerCase()));

      if (brand) {
        const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const brandRe = new RegExp(escRe(brand), "i");
        const rep = (s: string) => s.replace(new RegExp(escRe(brand), "gi"), productName);

        // (A) The reference's OWN logo (svg/img labelled with the brand) → a product wordmark in the
        //     nav + footer. BUT the reference also repeats its logo as DECORATIVE aurora inside feature
        //     illustrations (a "logo cloud" behind the cards); those aren't identity, and converting each
        //     to a wordmark produces a "FlagpoleFlagpole" smear. So only the logos in the header/nav/footer
        //     chrome become a wordmark; brand logos anywhere else are decorative repetition → removed.
        document.querySelectorAll("svg,img").forEach((el) => {
          const lbl = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || "";
          if (!brandRe.test(lbl)) return;
          if (!el.closest("header,nav,footer")) { el.remove(); smear++; return; } // decorative logo-aurora
          const box = el.getBoundingClientRect();
          const span = document.createElement("span");
          span.textContent = productName;
          span.setAttribute("data-debrand-wordmark", "1");
          const fs = Math.max(15, Math.min(22, Math.round((box.height || 24) * 0.8)));
          span.style.cssText = `display:inline-block;font-weight:700;font-size:${fs}px;line-height:1;white-space:nowrap;color:currentColor;letter-spacing:-0.02em;`;
          el.replaceWith(span); logos++;
        });

        // (B) Third-party CUSTOMER LOGO WALLS ("trusted by …" marquees) → remove the strip. A wall = a
        //     container of >=4 distinct company logos whose own text is short (a pure logo strip).
        const done = new Set<Element>();
        [...document.querySelectorAll("svg[aria-label],img[alt]")].filter(isLogo).forEach((el) => {
          if (done.has(el)) return;
          let cont: Element | null = el, inner: Element | null = null;
          for (let i = 0; i < 7 && cont; i++) { if (names(cont).size >= 4) { inner = cont; break; } cont = cont.parentElement; }
          if (!inner) return;
          let target: Element = inner;
          for (let i = 0; i < 3; i++) { const p = target.parentElement; if (!p) break; const txt = (p.textContent || "").replace(/\s+/g, " ").trim().length; if (names(p).size >= 4 && txt <= names(p).size * 25 + 140) target = p; else break; }
          const n = names(target).size, txt = (target.textContent || "").replace(/\s+/g, " ").trim().length;
          if (n >= 4 && txt <= n * 28 + 200) { [...target.querySelectorAll("svg[aria-label],img[alt]")].forEach((x) => done.add(x)); target.remove(); walls++; }
        });

        // (B2) The SAME wall, unlabelled. (B) keys on aria-label/alt, but a reference is free to ship its
        //      customer marquee as bare inline <svg> with no label at all (Linear does) — and then the
        //      wall sails through de-brand AND through verify, putting real third-party companies on the
        //      page as the fake product's customers. Detect it STRUCTURALLY instead: >=4 sibling items in
        //      one horizontal band, each holding exactly one wordmark-shaped graphic and NO text of its own.
        //      The "no text per item" rule is what separates a logo strip from a feature/icon grid, which
        //      always labels its icons.
        const bandWalls = () => {
          const cands = new Set<Element>();
          document.querySelectorAll("svg,img").forEach((g) => {
            if (g.parentElement) cands.add(g.parentElement);               // logos as direct children of the row
            if (g.parentElement?.parentElement) cands.add(g.parentElement.parentElement); // logo → item → row
          });
          for (const row of cands) {
            if (!row.isConnected) continue;
            const items = [...row.children].filter((c) => {
              const gs = c.matches("svg,img") ? [c] : [...c.querySelectorAll("svg,img")];
              if (gs.length !== 1) return false;
              if ((c.textContent || "").trim().length > 0) return false;
              const r = gs[0].getBoundingClientRect();
              // Wordmark-shaped: clearly wider than tall. This is what separates a customer logo strip from
              // a row of square social/feature icons, which must not be removed.
              return r.width >= 30 && r.width <= 260 && r.height >= 8 && r.height <= 70 && r.width / Math.max(1, r.height) >= 1.6;
            });
            if (items.length < 4) continue;
            const tops = items.map((c) => c.getBoundingClientRect().top);
            if (Math.max(...tops) - Math.min(...tops) > 60) continue; // must be one horizontal band
            // GEOMETRY GUARD. Item shape alone is far too weak: a cloned product widget (a mock email
            // client, a dashboard) is full of small wide images with no text, and matching on shape swept
            // 83 of Resend's 92 images. A customer marquee is a PAGE-WIDE, SHORT band — require that.
            const rb = row.getBoundingClientRect();
            if (rb.width < document.body.clientWidth * 0.6 || rb.height > 200) continue;
            const lefts = items.map((c) => c.getBoundingClientRect().left);
            if (Math.max(...lefts) - Math.min(...lefts) < rb.width * 0.45) continue; // spread across the band
            // Climb to the strip's own wrapper (a marquee usually duplicates the row) while it stays textless.
            let target: Element = row;
            for (let i = 0; i < 3; i++) {
              const p = target.parentElement;
              if (!p || p.tagName === "BODY") break;
              if ((p.textContent || "").trim().length > 40) break;
              target = p;
            }
            const par = target.parentElement;
            target.remove(); walls++;
            for (let i = 0, e: Element | null = par; i < 8 && e; i++, e = e.parentElement) {
              const s = (e as HTMLElement).style; s.height = "auto"; s.minHeight = "0"; s.maxHeight = "none";
            }
          }
        };
        bandWalls();

        // (C) Any residual brand string — text nodes + attributes.
        const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let nn: Node | null; while ((nn = tw.nextNode())) { if (brandRe.test(nn.textContent || "")) { nn.textContent = rep(nn.textContent || ""); text++; } }
        document.querySelectorAll("[aria-label],[alt],[title],[placeholder]").forEach((el) => {
          for (const a of ["aria-label", "alt", "title", "placeholder"]) { const v = el.getAttribute(a); if (v && brandRe.test(v)) { el.setAttribute(a, rep(v)); text++; } }
        });
      }

      // (D) SOCIAL-PROOF sections built on real third-party identities — tweet walls of real @handles,
      //     customer-story carousels of real companies/people — can't be cloned truthfully for a different
      //     product (they'd fabricate endorsements from real people). Remove them, and FREE ancestor
      //     heights so the pinned-height clone reflows up instead of leaving a gap where they were.
      const handleOf = (el: Element) => { const t = (el.textContent || "").trim(); return el.children.length === 0 && /^@[A-Za-z0-9_]{2,20}$/.test(t) ? t.toLowerCase() : null; };
      const SOCIAL = /industry leaders|customer|testimonial|loved by|trusted by|community|success stor|what .* say|shipping with|in good company|join thousands/i;
      const ROLE = /\b(CEO|CTO|COO|Founder|Co-?founder|Head of|VP|President)\b/;
      const freeUp = (el: Element | null) => { for (let i = 0; i < 8 && el; i++) { const s = (el as HTMLElement).style; s.height = "auto"; s.minHeight = "0"; s.maxHeight = "none"; el = el.parentElement; } };
      // Anything step 0b marked, section or not (the testimonial carousel is a bare div).
      [...document.querySelectorAll("[data-atl-social]")].forEach((el) => {
        if (!el.isConnected) return;
        const par = el.parentElement; el.remove(); freeUp(par); social++;
      });
      [...document.querySelectorAll("section")].forEach((sec) => {
        if (!sec.isConnected) return;
        const handles = new Set([...sec.querySelectorAll("*")].map(handleOf).filter(Boolean)).size;
        const logoN = names(sec).size;
        const heading = [...sec.querySelectorAll("h1,h2,h3")][0]?.textContent || "";
        const txt = sec.textContent || "";
        const len = txt.replace(/\s+/g, " ").trim().length;
        // A bare logo COUNT is not evidence of social proof: a product-feature section legitimately shows
        // integration marks (Slack, GitHub, Zendesk) inside its illustration. Keying on `logoN >= 3` alone
        // deleted Linear's two richest feature sections — the exact designed product-UI this pipeline exists
        // to preserve. A real customer wall has many logos AND almost no prose, so require both (the same
        // ratio rule the logo-wall pass uses); a section carrying feature copy is never a wall.
        const logoWall = logoN >= 4 && len <= logoN * 28 + 200;
        const preMarked = sec.hasAttribute("data-atl-social"); // decided in step 0b, on the original copy
        if (preMarked || handles >= 3 || logoWall || (ROLE.test(txt) && SOCIAL.test(heading + " " + txt.slice(0, 300)))) { const par = sec.parentElement; sec.remove(); freeUp(par); social++; }
      });

      // (E) Decorative graphics (the reference's own dot-map / illustrations) are KEPT for exact fidelity
      //     — the responsive CSS clone renders them correctly (unlike the old computed-style smudge).

      // (F) DE-SMEAR the product name. The reference decorates its feature illustrations with an "aurora"
      //     of its own wordmark repeated (absolute overlays, cross-fading); JS-off leaves the copies
      //     stacked and the swap turned each into the PRODUCT NAME → a "FlagpoleFlagpole" smear. Remove
      //     leaf elements whose text is exactly the product name and that repeat (>=3), keeping the real
      //     nav/footer wordmark (the de-brand span, or any in header/nav/footer).
      const pn = (productName || "").trim();
      if (pn) {
        const leaves = [...document.querySelectorAll("body *")].filter((el) => el.children.length === 0 && (el.textContent || "").trim() === pn);
        if (leaves.length >= 3) {
          leaves.forEach((el) => {
            if ((el as HTMLElement).hasAttribute("data-debrand-wordmark") || el.closest("header,nav,footer,[data-debrand-wordmark]")) return;
            el.remove(); smear++;
          });
        }
      }

      return { html: "<!doctype html>" + document.documentElement.outerHTML, logos, walls, text, social, decor, smear };
    }, { brand, productName });

    console.log(`  de-brand: ${debr.logos} logo(s)→wordmark, ${debr.walls} logo wall(s) + ${debr.social} social-proof section(s) removed, ${debr.decor} decorative graphic(s) + ${debr.smear} name-smear span(s) removed, ${debr.text} brand string(s) replaced`);
    const html = debr.html;
    return { html, mapped, unmapped, productName };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  let prompt = "";
  let site = "";
  let model = "claude-opus-4-8";
  let brand = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--site") site = args[++i];
    else if (args[i] === "--model") model = args[++i];
    else if (args[i] === "--brand") brand = args[++i];
    else if (!args[i].startsWith("--") && !prompt) prompt = args[i];
  }
  if (!prompt || !site) { console.error('Usage: tsx src/swap.ts "<product prompt>" --site <dir-with-index.html> [--model <id>]'); process.exit(1); }

  const indexPath = path.join(site, "index.html");
  console.log(`\n▸ Swapping wording in ${indexPath}\n  product: ${prompt}`);
  const productName = await deriveProductName(prompt, model);
  console.log(`  product name: ${productName}`);
  const res = await swapWording(indexPath, prompt, productName, model, brand);
  const outPath = path.join(site, "index.swapped.html");
  writeFileSync(outPath, res.html);
  console.log(`  ${res.mapped} slots rewritten, ${res.unmapped} kept as-is`);
  console.log(`\n✓ → ${outPath}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("\n✗ Swap failed:", e); process.exit(1); });
}
