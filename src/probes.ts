// Style probes. The heavy function runs INSIDE the page via page.evaluate, so it must be
// fully self-contained (no imports, no external refs). It returns raw measurements; all
// interpretation / scale-building happens later in tokens.ts.
import type { Page } from "playwright";
import type { RawMeasurements } from "./types.js";

export async function probe(page: Page, url: string): Promise<RawMeasurements> {
  const raw = await page.evaluate(() => {
    // ---- helpers (in-page) -------------------------------------------------
    const isVisible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const s = getComputedStyle(el);
      return s.visibility !== "hidden" && s.display !== "none" && parseFloat(s.opacity || "1") > 0.05;
    };
    const area = (el: Element): number => {
      const r = el.getBoundingClientRect();
      return r.width * r.height;
    };
    // Most prominent (largest visible) element matching selector.
    const prominent = (selector: string): Element | null => {
      let best: Element | null = null;
      let bestArea = -1;
      document.querySelectorAll(selector).forEach((el) => {
        if (!isVisible(el)) return;
        const a = area(el);
        if (a > bestArea) {
          bestArea = a;
          best = el;
        }
      });
      return best;
    };
    const roleStyle = (selector: string) => {
      const el = selector === "body" ? document.body : prominent(selector);
      if (!el) return { found: false };
      const s = getComputedStyle(el);
      return {
        found: true,
        sample: (el.textContent ?? "").trim().slice(0, 60),
        fontFamily: s.fontFamily,
        fontSize: s.fontSize,
        fontWeight: s.fontWeight,
        lineHeight: s.lineHeight,
        letterSpacing: s.letterSpacing,
        textTransform: s.textTransform,
        color: s.color,
        backgroundColor: s.backgroundColor,
      };
    };
    const pushPx = (arr: number[], v: string) => {
      const m = /^(-?[\d.]+)px/.exec(v);
      if (m) {
        const n = parseFloat(m[1]);
        if (Number.isFinite(n)) arr.push(n);
      }
    };

    // ---- @font-face enumeration + resource timing (cross-origin-safe) -------
    const fontFacesMap = new Map<string, { family: string; weight: string; style: string; urls: Set<string> }>();
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | null = null;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // cross-origin sheet: rules unreadable, resource timing will still catch URLs
      }
      if (!rules) continue;
      const base = sheet.href ?? location.href;
      const walk = (list: CSSRuleList) => {
        for (const rule of Array.from(list)) {
          const anyRule = rule as any;
          if (rule.type === CSSRule.FONT_FACE_RULE) {
            const st = anyRule.style;
            const family = (st.getPropertyValue("font-family") || "").replace(/['"]/g, "").trim();
            const weight = st.getPropertyValue("font-weight") || "400";
            const style = st.getPropertyValue("font-style") || "normal";
            const src = st.getPropertyValue("src") || "";
            const urls = new Set<string>();
            for (const m of src.matchAll(/url\(([^)]+)\)/g)) {
              const cleaned = m[1].replace(/['"]/g, "").trim();
              try {
                urls.add(new URL(cleaned, base).href);
              } catch {
                /* skip data: and malformed */
              }
            }
            const key = `${family}|${weight}|${style}`;
            const existing = fontFacesMap.get(key);
            if (existing) urls.forEach((u) => existing.urls.add(u));
            else fontFacesMap.set(key, { family, weight, style, urls });
          } else if (anyRule.cssRules) {
            walk(anyRule.cssRules); // e.g. @media / @supports wrappers
          }
        }
      };
      walk(rules);
    }
    // Supplement with actually-loaded font resources (catches cross-origin sheets).
    const looseFontUrls = new Set<string>();
    for (const e of performance.getEntriesByType("resource")) {
      const name = (e as PerformanceResourceTiming).name;
      if (/\.(woff2?|otf|ttf)(\?|$)/i.test(name)) looseFontUrls.add(name);
    }
    const fontFaces = Array.from(fontFacesMap.values()).map((f) => ({
      family: f.family,
      weight: f.weight,
      style: f.style,
      urls: Array.from(f.urls),
    }));
    // Attach loose URLs not already covered, under a synthetic entry.
    const covered = new Set(fontFaces.flatMap((f) => f.urls));
    const orphanFontUrls = Array.from(looseFontUrls).filter((u) => !covered.has(u));
    if (orphanFontUrls.length) {
      fontFaces.push({ family: "(from-resource-timing)", weight: "", style: "", urls: orphanFontUrls });
    }

    // ---- per-role computed styles ------------------------------------------
    const roles: Record<string, any> = {
      body: roleStyle("body"),
      h1: roleStyle("h1"),
      h2: roleStyle("h2"),
      h3: roleStyle("h3"),
      a: roleStyle("a"),
      button: roleStyle("button, [role='button'], a.button, .btn"),
      nav: roleStyle("nav"),
      mono: roleStyle("code, pre, kbd, [class*='mono'], [class*='code']"),
    };

    // ---- the REAL text scale (every distinct text style actually used) ------
    // Tag selectors alone miss the secondary/caption tier a premium site leans on, which is why
    // body/secondary copy came out generic. Histogram every visible run of text by its full computed
    // style, weighted by how many characters it sets, so the dominant tiers fall out by usage.
    const textStyleMap = new Map<string, any>();
    document.querySelectorAll("p,span,div,li,a,td,th,label,figcaption,small,dd,dt,blockquote").forEach((el) => {
      if (!isVisible(el)) return;
      let chars = 0;
      el.childNodes.forEach((c) => {
        if (c.nodeType === 3) chars += (c.textContent ?? "").trim().length;
      });
      if (chars < 3) return; // ignore stray glyphs
      const s = getComputedStyle(el);
      const key = `${s.fontSize}|${s.fontWeight}|${s.lineHeight}|${s.letterSpacing}|${s.textTransform}|${s.color}`;
      const cur = textStyleMap.get(key) ?? {
        fontSize: s.fontSize,
        fontWeight: s.fontWeight,
        lineHeight: s.lineHeight,
        letterSpacing: s.letterSpacing,
        textTransform: s.textTransform,
        color: s.color,
        fontFamily: s.fontFamily,
        chars: 0,
      };
      cur.chars += chars;
      textStyleMap.set(key, cur);
    });
    const textStyles = Array.from(textStyleMap.values())
      .sort((a, b) => b.chars - a.chars)
      .slice(0, 14);

    // ---- gradients / glow (REAL CSS values) + where colour is allowed to appear ----
    // A premium reference is not flat: it uses dimensional gradient fills on a FEW surfaces (Linear's
    // testimonial cards) and a soft ambient glow behind the page (Vercel). Crucially colour appears
    // ONLY there — the page is otherwise monochrome, and that RATIO is the design, not an accident.
    // So capture both the gradient CSS AND how much of the painted area is actually colourful.
    const gradMap = new Map<string, any>();
    const vpArea = innerWidth * innerHeight;
    document.querySelectorAll("*").forEach((el) => {
      if (!isVisible(el)) return;
      const r = el.getBoundingClientRect();
      const a = r.width * r.height;
      if (a < 600) return;
      const s = getComputedStyle(el);
      const bi = s.backgroundImage;
      if (!bi || bi.indexOf("gradient(") === -1) return;
      const cur = gradMap.get(bi) ?? {
        css: bi,
        area: 0,
        count: 0,
        w: 0,
        h: 0,
        radius: s.borderRadius,
        maxViewportRatio: 0,
        clipsText: s.webkitBackgroundClip === "text" || (s as any).backgroundClip === "text",
      };
      cur.area += a;
      cur.count++;
      if (r.width * r.height > cur.w * cur.h) { cur.w = Math.round(r.width); cur.h = Math.round(r.height); }
      cur.maxViewportRatio = Math.max(cur.maxViewportRatio, a / vpArea);
      gradMap.set(bi, cur);
    });
    const gradients = Array.from(gradMap.values()).sort((a, b) => b.area - a.area).slice(0, 10);

    // ---- colour PLACEMENT + SUBTLETY (the discipline, not the hue) ----------
    // The failure mode is never "the reference uses purple" — both Linear and Railway do. It is RATIO
    // and PLACEMENT: Linear's colour covers ~2% of the page, bottom-weighted, against full monochrome,
    // and it never colours the nav or a full-bleed hero background. So measure exactly that, the same
    // way density/spacing are measured, so the critic can reject a build that exceeds the reference's
    // discipline (a purple-washed page) even though the hue is legitimately in the palette.
    // Colourfulness = ABSOLUTE chroma (max−min over 0–255), NOT (max−min)/max. The ratio form
    // over-reads dark colours: a near-black brand tint like Sentry's #1f1633 or Railway's #13111c
    // scores high as a ratio but is perceptually a dark neutral, not a colour wash. Absolute chroma
    // treats those as neutral (chroma ~11–29) while a real fill (lavender 77, vivid purple ~98,
    // magenta ~200) reads as colour. Returned 0–1 (chroma/255).
    const CHROMA_MIN = 45; // below this = neutral / a dark tint, not a colour surface
    const satOf = (col: string): number => {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(col);
      if (!m) return 0;
      const r = +m[1], g = +m[2], b = +m[3], al = m[4] === undefined ? 1 : +m[4];
      if (al < 0.15) return 0;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      return chroma < CHROMA_MIN ? 0 : chroma / 255;
    };
    const docH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 1);
    const bigSurface = vpArea * 0.02; // a real coloured SURFACE, not a status dot
    let coloredArea = 0, paintedArea = 0, weightedY = 0, maxSaturation = 0;
    let colorInNav = false;
    document.querySelectorAll("*").forEach((el) => {
      if (!isVisible(el)) return;
      const r = el.getBoundingClientRect();
      const a = r.width * r.height;
      if (a < 400) return;
      const s = getComputedStyle(el);
      const bi = s.backgroundImage;
      const hasGrad = !!bi && bi.indexOf("gradient(") !== -1;
      const bgPainted = s.backgroundColor && s.backgroundColor !== "rgba(0, 0, 0, 0)" && s.backgroundColor !== "transparent";
      if (!hasGrad && !bgPainted) return;
      paintedArea += a;
      // saturation = the most-saturated stop (gradient) or the flat fill
      let sat = bgPainted ? satOf(s.backgroundColor) : 0;
      if (hasGrad) for (const stop of bi.match(/rgba?\([^)]+\)/g) ?? []) sat = Math.max(sat, satOf(stop));
      if (sat > 0) { // satOf already zeroes out sub-chroma dark tints
        coloredArea += a;
        const centerY = r.top + window.scrollY + r.height / 2;
        weightedY += a * (centerY / docH); // 0 = top of page, 1 = bottom
        // Subtlety is about big fills (a magenta hero band), not a 6px status dot.
        if (a >= bigSurface) maxSaturation = Math.max(maxSaturation, sat);
        if (el.closest("header,nav")) colorInNav = true;
      }
    });
    const colorStats = {
      coverageRatio: paintedArea > 0 ? (coloredArea / paintedArea) * 100 : 0, // % of painted area saturated
      centroidY: coloredArea > 0 ? weightedY / coloredArea : 0, // vertical centre of mass of colour (higher = bottom-weighted)
      maxSaturation, // most-saturated surface on the page (0..1)
      colorInNav, // does the reference put colour in its own nav/header?
    };

    // ---- color usage across links / buttons / headings (AREA-weighted) -----
    // Area-weighting is what keeps a tiny lime status dot from being mistaken for the brand
    // accent: a color's weight is the rendered area it covers, not how many nodes use it.
    const bump = (m: Map<string, { count: number; area: number }>, key: string, a: number) => {
      const cur = m.get(key) ?? { count: 0, area: 0 };
      m.set(key, { count: cur.count + 1, area: cur.area + a });
    };
    const colorMap = new Map<string, { count: number; area: number }>();
    const bgMap = new Map<string, { count: number; area: number }>();
    const colorEls = document.querySelectorAll(
      "a, button, [role='button'], h1, h2, h3, .btn, [class*='button'], [class*='cta'], [class*='badge'], [class*='tag']"
    );
    let colorScanned = 0;
    colorEls.forEach((el) => {
      if (colorScanned > 1200 || !isVisible(el)) return;
      colorScanned++;
      const s = getComputedStyle(el);
      const rr = el.getBoundingClientRect();
      const a = rr.width * rr.height;
      // text color: weight by the glyph coverage, not the whole box (approx via text length x fontSize^2)
      const txtLen = Math.min((el.textContent ?? "").trim().length, 60);
      const fs = parseFloat(s.fontSize) || 14;
      const textArea = txtLen * fs * fs * 0.35;
      if (s.color) bump(colorMap, s.color, textArea);
      const bg = s.backgroundColor;
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") bump(bgMap, bg, a);
    });
    const colorFrequency = [...colorMap.entries()].map(([color, v]) => ({ color, count: v.count, area: Math.round(v.area) }));
    const bgColorFrequency = [...bgMap.entries()].map(([color, v]) => ({ color, count: v.count, area: Math.round(v.area) }));

    // ---- button candidates (pick the real primary later, in tokens.ts) -----
    // Capture the field of buttons with enough context (header? pill? CTA text? fill?) so the
    // token stage can identify the primary action instead of grabbing the biggest colored box.
    const buttonCandidates: any[] = [];
    document.querySelectorAll("a, button, [role='button'], .btn, [class*='button']").forEach((el) => {
      if (buttonCandidates.length > 30 || !isVisible(el)) return;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      // skip full-width bars / huge cards — real buttons are compact controls
      if (r.width > 420 || r.height > 90 || r.width < 24 || r.height < 20) return;
      const bg = s.backgroundColor;
      const hasFill = !!bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
      const radiusPx = parseFloat(s.borderTopLeftRadius) || 0;
      const isPill = radiusPx >= r.height / 2 - 1 && r.height > 0;
      const before = getComputedStyle(el, "::before");
      buttonCandidates.push({
        text: (el.textContent ?? "").trim().slice(0, 40),
        inHeader: !!el.closest("header, nav"),
        top: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
        hasFill,
        isPill,
        backgroundColor: bg,
        color: s.color,
        borderRadius: s.borderRadius,
        padding: s.padding,
        border: s.border,
        fontFamily: s.fontFamily,
        fontSize: s.fontSize,
        fontWeight: s.fontWeight,
        boxShadow: s.boxShadow,
        clipPath: before.clipPath !== "none" ? before.clipPath : s.clipPath,
      });
    });

    // ---- pseudo-element clipPaths (signature shapes) -----------------------
    // Only keep real geometry (polygon/inset/circle/ellipse/path). `url(#…)` values are
    // internal SVG clip references — not reusable CSS shapes — so they are dropped as noise.
    const isShapeClip = (cp: string) => /^(polygon|inset|circle|ellipse|path)\s*\(/.test(cp.trim());
    const clipSet = new Set<string>();
    let clipScanned = 0;
    document.querySelectorAll("*").forEach((el) => {
      if (clipScanned > 1500) return;
      clipScanned++;
      for (const pseudo of ["::before", "::after", ""]) {
        const cp = getComputedStyle(el, pseudo || undefined).clipPath;
        if (cp && cp !== "none" && isShapeClip(cp)) clipSet.add(cp);
      }
    });

    // ---- background images -------------------------------------------------
    const bgImages = new Set<string>();
    let bgScanned = 0;
    document.querySelectorAll("*").forEach((el) => {
      if (bgScanned > 2000) return;
      bgScanned++;
      const bi = getComputedStyle(el).backgroundImage;
      if (bi && bi !== "none") {
        for (const m of bi.matchAll(/url\(([^)]+)\)/g)) {
          const cleaned = m[1].replace(/['"]/g, "").trim();
          if (cleaned.startsWith("data:")) continue;
          try {
            bgImages.add(new URL(cleaned, location.href).href);
          } catch {
            /* skip */
          }
        }
      }
    });

    // ---- inline SVGs (logos / signature marks live in the DOM, not on the wire) ----
    const svgSeen = new Set<string>();
    const inlineSvgs: Array<{ markup: string; w: number; h: number; context: string }> = [];
    document.querySelectorAll("svg").forEach((svg) => {
      if (inlineSvgs.length > 20) return;
      const r = svg.getBoundingClientRect();
      // skip tiny decorative glyphs; keep logos / marks / illustrations
      if (r.width < 20 || r.height < 20) return;
      let markup = svg.outerHTML;
      if (markup.length > 20000) return; // skip huge inline illustrations
      // dedupe identical marks (icon reused many times)
      const key = markup.replace(/\s+/g, "").slice(0, 200);
      if (svgSeen.has(key)) return;
      svgSeen.add(key);
      if (!/xmlns=/.test(markup)) markup = markup.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
      // note where it sits, for naming
      const inHeader = !!svg.closest("header, nav");
      const context = inHeader ? "header" : svg.closest("footer") ? "footer" : "body";
      inlineSvgs.push({ markup, w: Math.round(r.width), h: Math.round(r.height), context });
    });

    // ---- spacing samples + radii + shadows ---------------------------------
    const spacingSamples: number[] = [];
    const radiiFreq = new Map<number, number>(); // radius px -> occurrence count (for de-noising)
    const shadowFreq = new Map<string, number>();
    let spScanned = 0;
    document.querySelectorAll("section, div, header, footer, main, article, nav, li, a, button, input, img, [class*='card']").forEach((el) => {
      if (spScanned > 1200 || !isVisible(el)) return;
      spScanned++;
      const s = getComputedStyle(el);
      pushPx(spacingSamples, s.paddingTop);
      pushPx(spacingSamples, s.paddingBottom);
      pushPx(spacingSamples, s.paddingLeft);
      pushPx(spacingSamples, s.paddingRight);
      pushPx(spacingSamples, s.marginTop);
      pushPx(spacingSamples, s.marginBottom);
      if (s.gap && s.gap !== "normal") s.gap.split(" ").forEach((g) => pushPx(spacingSamples, g));
      // radius: round to whole px, count occurrences so rare sub-pixel artifacts can be dropped
      const br = /^(-?[\d.]+)px/.exec(s.borderTopLeftRadius);
      if (br) {
        const n = Math.round(parseFloat(br[1]));
        if (n >= 0 && n < 400) radiiFreq.set(n, (radiiFreq.get(n) ?? 0) + 1);
      }
      if (s.boxShadow && s.boxShadow !== "none") {
        shadowFreq.set(s.boxShadow, (shadowFreq.get(s.boxShadow) ?? 0) + 1);
      }
    });
    const boxShadows = [...shadowFreq.entries()].map(([shadow, count]) => ({ shadow, count }));
    const radii = [...radiiFreq.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => a.value - b.value);

    // ---- page background + block-level surface / border colors -------------
    // Resolve the true page background: walk body -> html, first opaque wins.
    let pageBg = "rgba(0, 0, 0, 0)";
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") {
        pageBg = bg;
        break;
      }
    }
    // Backgrounds of large block elements => surface/card candidates, area-weighted.
    const blockBg = new Map<string, { count: number; area: number }>();
    const borderFreq = new Map<string, number>();
    let blkScanned = 0;
    document.querySelectorAll("div, section, header, footer, main, article, aside, li, [class*='card'], [class*='panel']").forEach((el) => {
      if (blkScanned > 2500 || !isVisible(el)) return;
      blkScanned++;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const a = r.width * r.height;
      const bg = s.backgroundColor;
      if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)" && a > 4000) {
        const cur = blockBg.get(bg) ?? { count: 0, area: 0 };
        blockBg.set(bg, { count: cur.count + 1, area: cur.area + a });
      }
      // visible borders => border-token candidates
      const bw = parseFloat(s.borderTopWidth || "0");
      if (bw > 0 && s.borderTopColor && s.borderTopStyle !== "none") {
        borderFreq.set(s.borderTopColor, (borderFreq.get(s.borderTopColor) ?? 0) + 1);
      }
    });
    const blockBgFrequency = [...blockBg.entries()].map(([color, v]) => ({ color, count: v.count, area: Math.round(v.area) }));
    const borderColorFrequency = [...borderFreq.entries()].map(([color, count]) => ({ color, count }));

    // ---- section rects (feeds DOM-measurement fallback) --------------------
    const sectionRects: Array<{ tag: string; w: number; h: number; top: number }> = [];
    document.querySelectorAll("section, header, footer, main > div").forEach((el) => {
      if (!isVisible(el) || sectionRects.length > 60) return;
      const r = el.getBoundingClientRect();
      sectionRects.push({ tag: el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top + window.scrollY) });
    });

    // ---- media-query breakpoints from CSSOM --------------------------------
    const bpSet = new Set<number>();
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | null = null;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        if (rule.type === CSSRule.MEDIA_RULE) {
          const txt = (rule as CSSMediaRule).media.mediaText;
          for (const m of txt.matchAll(/(min|max)-width:\s*([\d.]+)px/g)) {
            const n = Math.round(parseFloat(m[2]));
            if (n >= 320 && n <= 1920) bpSet.add(n);
          }
        }
      }
    }

    // ---- layout / composition structure (measured, not described) ----------
    // Reproduce the reference's spatial discipline from real numbers so the builder stops
    // improvising layout (past builds' failure: cramped/centered mush).
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Top-level horizontal bands: full-width, tall, and not nested inside another band.
    const bandEls: Element[] = [];
    document.querySelectorAll("section, header, footer, main > div, main > section, [class*='section' i]").forEach((el) => {
      if (bandEls.length > 40 || !isVisible(el)) return;
      const tag = el.tagName.toLowerCase();
      if (tag === "main" || tag === "body") return;
      const r = el.getBoundingClientRect();
      // real horizontal bands: full-width and section-tall, but NOT a page-level wrapper
      if (r.width < vw * 0.85 || r.height < 160 || r.height > vh * 2.2) return;
      if (bandEls.some((b) => b.contains(el) || el.contains(b))) return; // keep outermost per band
      bandEls.push(el);
    });
    const bands = bandEls
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .sort((a, b) => a.r.top - b.r.top);

    const hasOwnText = (el: Element) =>
      Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 1);
    const contentWidths: number[] = [];
    const leftInsets: number[] = [];
    const densities: number[] = [];
    const sectionPaddings: number[] = [];
    for (const { el, r } of bands.slice(0, 12)) {
      const cs = getComputedStyle(el);
      pushPx(sectionPaddings, cs.paddingTop);
      pushPx(sectionPaddings, cs.paddingBottom);
      let minL = Infinity, maxR = -Infinity, minT = Infinity, maxB = -Infinity, leaves = 0;
      el.querySelectorAll("*").forEach((c) => {
        if (leaves > 2000 || !isVisible(c)) return;
        const tag = c.tagName.toLowerCase();
        const media = tag === "img" || tag === "svg" || tag === "video" || tag === "canvas";
        if (!media && !hasOwnText(c)) return; // only real content leaves
        const cr = c.getBoundingClientRect();
        const l = Math.max(cr.left, r.left), rt = Math.min(cr.right, r.right);
        const t = Math.max(cr.top, r.top), b = Math.min(cr.bottom, r.bottom);
        if (rt - l < 2 || b - t < 2) return;
        minL = Math.min(minL, l); maxR = Math.max(maxR, rt);
        minT = Math.min(minT, t); maxB = Math.max(maxB, b);
        leaves++;
      });
      const secArea = r.width * r.height || 1;
      if (leaves > 0) {
        const cw = maxR - minL;
        if (cw > 40 && cw <= vw * 0.98) contentWidths.push(cw); // constrained columns only
        leftInsets.push(Math.max(0, minL - r.left));
        // Real vertical breathing room = gap from content to band edges (captures margin-based
        // whitespace, not just CSS padding — Vercel's emptiness lives here, not in band padding).
        sectionPaddings.push(Math.max(0, minT - r.top), Math.max(0, r.bottom - maxB));
        // density = content ELEMENTS per viewport-sized area. Count, not ink coverage: one big
        // focal image is low density; a dense product UI of many rows/labels is high. This is
        // what actually separates Vercel's emptiness from Linear's density.
        densities.push(leaves / Math.max(0.25, secArea / (vw * vh)));
      }
    }
    const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
    const containerMaxWidth = contentWidths.length ? Math.round(Math.max(...contentWidths)) : Math.round(vw);
    const gutter = Math.round(median(leftInsets));
    // normalize leaves-per-screen to 0..1 (~40 content leaves in a viewport reads as very dense)
    const density = densities.length ? Math.round(Math.min(1, median(densities) / 40) * 100) / 100 : 0.3;
    const heroViewportRatio = bands.length ? Math.round((bands[0].r.height / vh) * 100) / 100 : 1;

    // Hero headline alignment: the largest visible text element in the first band.
    let headlineAlign: "left" | "center" | "right" = "left";
    if (bands[0]) {
      const secR = bands[0].r;
      let maxFs = 0, alignEl: Element | null = null;
      bands[0].el.querySelectorAll("h1, h2, [class*='title' i], [class*='head' i], p, span, div").forEach((el) => {
        if (!isVisible(el) || !hasOwnText(el)) return;
        const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
        if (fs > maxFs) { maxFs = fs; alignEl = el; }
      });
      if (alignEl) {
        // Trust the declared text-align. A wide LEFT headline has its box center near page-center,
        // so a geometric centering test misclassifies it as centered (Linear read "center" that way).
        const ta = getComputedStyle(alignEl).textAlign;
        headlineAlign = ta === "center" ? "center" : ta === "right" || ta === "end" ? "right" : "left";
      }
    }

    // Primary feature grid: the widest multi-column CSS grid.
    let grid: { columns: number; gutter: number } | null = null;
    let gridScan = 0;
    document.querySelectorAll("*").forEach((el) => {
      if (gridScan > 3000 || (grid && grid.columns >= 3)) return;
      gridScan++;
      if (!isVisible(el)) return;
      const s = getComputedStyle(el);
      if (s.display !== "grid" && s.display !== "inline-grid") return;
      const cols = s.gridTemplateColumns.split(/\s+/).filter((x) => x && !/^0px?$/.test(x)).length;
      const r = el.getBoundingClientRect();
      if (cols >= 2 && cols <= 6 && r.width > vw * 0.5 && (!grid || cols > grid.columns)) {
        grid = { columns: cols, gutter: Math.round(parseFloat(s.columnGap) || parseFloat(s.gap) || 0) };
      }
    });

    const layout = {
      viewport: { w: vw, h: vh },
      containerMaxWidth,
      gutter,
      contentWidthRatio: Math.round((containerMaxWidth / vw) * 100) / 100,
      density,
      heroViewportRatio,
      headlineAlign,
      grid,
      sectionPaddings,
    };

    return {
      fontFaces,
      roles,
      textStyles,
      gradients,
      colorStats,
      buttonCandidates,
      colorFrequency,
      bgColorFrequency,
      blockBgFrequency,
      borderColorFrequency,
      pageBg,
      clipPaths: Array.from(clipSet).slice(0, 20),
      backgroundImages: Array.from(bgImages).slice(0, 40),
      inlineSvgs,
      spacingSamples,
      radii,
      boxShadows,
      sectionRects,
      mediaBreakpoints: Array.from(bpSet).sort((a, b) => a - b),
      layout,
      domStats: {
        elementCount: document.querySelectorAll("*").length,
        textLength: (document.body?.innerText ?? "").trim().length,
      },
    };
  });

  return { url, ...(raw as Omit<RawMeasurements, "url">) };
}
