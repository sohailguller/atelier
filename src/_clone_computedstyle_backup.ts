// WHOLE-PAGE CLONE (the second-pivot strip-back — see context.md).
//
// The pipeline used to extract tokens + a few widget subtrees and have the model REBUILD an original
// page around them. That is the opposite of a faithful clone, and it is what caused the recurring
// drift and the widget bugs (subtrees lifted out of their page context, repopulated, dropped into an
// invented shell). The spec is now: faithfully clone the WHOLE reference — layout, structure, styling,
// components, all of it — and only swap the wording for the user's product.
//
// So this module clones the entire page the same proven way a single widget was cloned (computed
// styles inlined → getComputedStyle returns final resolved values, so CSS-in-JS is a non-issue; inline
// SVGs kept; ::before/::after materialised; assets downloaded; the reference's own @font-face captured
// for exact type). The result re-renders as the reference at the captured width; `src/swap.ts` then
// replaces only the text.
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { launch } from "./browser.js";
import { sniffExtension, fileStemFromUrl } from "./util.js";
import { CLONE_PROPS, PSEUDO_PROPS } from "./components.js";

export interface ClonedPage {
  html: string; // the whole page as self-contained markup (asset refs still absolute here)
  bodyBg: string;
  bodyColor: string;
  bodyFont: string;
  width: number;
  height: number;
  nodes: number;
  assetUrls: string[]; // absolute URLs referenced by the markup
  fontFaces: Array<{ family: string; weight: string; style: string; urls: string[] }>;
  textCount: number; // distinct visible text strings (the swap targets)
  canvasCount: number; // canvas/WebGL surfaces (the un-clonable bits → diagram rule)
}

/** Drive tabbed showcases so their per-tab imagery mounts and eager-loads before the snapshot, then
 *  leave the reference's default tab active. Without this, panels whose screenshots only render on tab
 *  interaction clone as empty containers. Deterministic + guarded: nav/menu chrome is excluded, links
 *  that would navigate are skipped, and the initially-active tab is restored at the end. */
async function captureInteractiveStates(page: Page): Promise<{ groups: number; clicks: number; imgsLoaded: number }> {
  return await page.evaluate(async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const inChrome = (el: Element) => !!el.closest("header,nav,[role=navigation],[role=menu],[role=menubar]");
    // A tab we can safely activate: not a link that would navigate away from the page.
    const activatable = (el: Element) => {
      if (el.tagName === "A") { const h = el.getAttribute("href") || ""; if (h && !h.startsWith("#")) return false; }
      return true;
    };
    // Force any lazy <img> in a panel to load now (eager + promote data-src/srcset + decode).
    const forceLoad = (root: Element): number => {
      let n = 0;
      root.querySelectorAll("img").forEach((im) => {
        try {
          const i = im as HTMLImageElement;
          i.loading = "eager";
          const ds = i.getAttribute("data-src") || i.getAttribute("data-lazy-src");
          if (ds && (!i.getAttribute("src") || i.naturalWidth === 0)) i.setAttribute("src", ds);
          const dss = i.getAttribute("data-srcset");
          if (dss && !i.getAttribute("srcset")) i.setAttribute("srcset", dss);
          (i as any).decode?.().catch(() => {});
          n++;
        } catch { /* ignore */ }
      });
      return n;
    };
    const activeClass = (el: Element) => /(?:^|[\s_-])(active|selected|current)(?:[\s_-]|$)/i.test(typeof el.className === "string" ? el.className : "");

    // Collect tab groups: semantic tablists first, else a cluster of >=2 sibling buttons/tabs (outside
    // nav chrome) that has an associated imagery panel nearby.
    const groups: Element[][] = [];
    document.querySelectorAll('[role="tablist"]').forEach((tl) => {
      const tabs = [...tl.querySelectorAll('[role="tab"]')].filter((t) => !inChrome(t));
      if (tabs.length >= 2) groups.push(tabs);
    });
    if (!groups.length) {
      const seen = new Set<Element>();
      document.querySelectorAll("button,[role=tab]").forEach((b) => {
        if (seen.has(b) || inChrome(b)) return;
        const par = b.parentElement; if (!par) return;
        const sibs = [...par.children].filter((c) => (c.tagName === "BUTTON" || c.getAttribute("role") === "tab") && !!(c.textContent || "").trim() && (c.textContent || "").trim().length < 30);
        if (sibs.length < 2) return;
        let anc: Element | null = par, hasPanel = false;
        for (let k = 0; k < 5 && anc; k++) { if (anc.querySelector("img,canvas,picture,video")) { hasPanel = true; break; } anc = anc.parentElement; }
        if (!hasPanel) return;
        sibs.forEach((s) => seen.add(s)); groups.push(sibs);
      });
    }

    let clicks = 0, imgsLoaded = 0;
    for (const tabs of groups.slice(0, 8)) {
      const activeIdx = Math.max(0, tabs.findIndex((t) => t.getAttribute("aria-selected") === "true" || activeClass(t)));
      let panel: Element = tabs[0].parentElement || tabs[0];
      for (let k = 0; k < 6 && panel.parentElement; k++) { if (panel.querySelector("img,canvas,picture,video")) break; panel = panel.parentElement; }
      (panel as HTMLElement).scrollIntoView?.({ block: "center" });
      await sleep(150);
      for (let i = 0; i < Math.min(tabs.length, 8); i++) {
        if (!activatable(tabs[i])) continue;
        try { (tabs[i] as HTMLElement).click(); clicks++; } catch { /* ignore */ }
        await sleep(420);
        imgsLoaded += forceLoad(panel);
        await sleep(120);
      }
      // Restore the reference's default tab so the frozen snapshot matches its initial state.
      try { (tabs[activeIdx] as HTMLElement).click(); } catch { /* ignore */ }
      await sleep(350);
      imgsLoaded += forceLoad(panel);
      // These panels are AUTO-ADVANCING screenshot carousels (slides stacked in an overflow-hidden
      // frame). They can't be reproduced as clean DOM — off-window slides are clipped away and the
      // generic settle slides the active one out too. Their content is ALREADY a screenshot on the
      // reference, so mark the slide FRAME (the overflow-hidden window around the largest media) for
      // rasterisation in clonePage; the tab buttons stay real DOM so the swap can still relabel them.
      panel.setAttribute("data-clone-keepframe", "1");
      (document.getAnimations?.() ?? []).forEach((a) => { const t = (a.effect as any)?.target as Element | undefined; if (t && panel.contains(t)) { try { a.pause(); } catch { /* ignore */ } } });
      const med = [...panel.querySelectorAll("img,video,canvas")].map((m) => ({ m, a: m.getBoundingClientRect().width * m.getBoundingClientRect().height })).sort((x, y) => y.a - x.a)[0];
      if (med && med.a > 40000) {
        let frame: Element | null = med.m.parentElement;
        for (let k = 0; k < 6 && frame && frame !== panel; k++) {
          const c = getComputedStyle(frame); const fb = frame.getBoundingClientRect();
          if ((c.overflowX === "hidden" || c.overflowX === "clip" || c.overflowY === "hidden" || c.overflowY === "clip") && fb.width >= 200 && fb.height >= 120) break;
          frame = frame.parentElement;
        }
        (frame || med.m).setAttribute("data-clone-raster", "1");
      }
    }
    window.scrollTo(0, 0);
    await sleep(200);
    return { groups: groups.length, clicks, imgsLoaded };
  });
}

/** Clone the whole page in the browser and return self-contained markup + the assets/fonts it needs. */
export async function clonePage(page: Page): Promise<ClonedPage> {
  // TRANSIENT ANIMATIONS AS DIAGRAMS: a static clone of a JS-animated marketing page freezes whatever
  // frame existed at capture — a mid-transition highlight flash (a code block caught light-theme), a
  // cross-fading headline's hidden phrase. So SETTLE the page to each animation's FINAL frame instead
  // of a random mid-frame: scroll through to trigger reveal animations, then fast-forward every
  // running animation/transition to its end via the Web Animations API, and neutralise scroll-behavior.
  // Ask for reduced motion: premium sites serve a STATIC image fallback in place of autoplaying
  // <video>/animation showcases (e.g. an `img.reduce-motion` beside the video). A static clone wants
  // exactly those still fallbacks — the video element is not cloneable markup — so opt into them.
  await page.emulateMedia({ reducedMotion: "reduce" }).catch(() => {});
  await page.addStyleTag({ content: `*{scroll-behavior:auto!important;caret-color:transparent!important}` }).catch(() => {});
  await page.evaluate(async () => {
    const step = Math.round(innerHeight * 0.85);
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 180));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 400));
  });

  // INTERACTION-CAPTURE: a tabbed showcase (e.g. "Table Editor / SQL Editor / RLS Policies") renders its
  // panel as CROSSFADED <img> screenshots that only mount/load on tab interaction — so a first-paint clone
  // captures an EMPTY container. Click through every tab to mount + eager-load each state's imagery, then
  // restore the reference's default tab so the snapshot shows its initial state (now populated, not blank).
  const tabInfo = await captureInteractiveStates(page);
  if (tabInfo.groups) console.log(`  interaction: ${tabInfo.groups} tab group(s), ${tabInfo.clicks} states clicked, ${tabInfo.imgsLoaded} panel image(s) loaded`);

  // A product-screenshot showcase frame can't be honestly reproduced for a DIFFERENT product — it shows
  // the REFERENCE's own branded app UI, and rasterising it would bake that brand into pixels the swap and
  // brand-gate can't touch. So replace each marked frame's contents with a NEUTRAL SKELETON in the
  // reference's visual language: keep the frame's own border/radius/chrome, fill it with a muted app-shell
  // placeholder (toolbar dots, sidebar, content rows) toned to the page. No empty container, no brand leak.
  const placeholders = await page.evaluate(() => {
    const lum = (c: string): number => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c); return m ? (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255 : 1; };
    const dark = lum(getComputedStyle(document.body).backgroundColor) < 0.4;
    const surface = dark ? "rgb(22,24,30)" : "rgb(247,248,250)";
    const bar = dark ? "rgba(255,255,255,0.09)" : "rgba(17,24,39,0.07)";
    const weak = dark ? "rgba(255,255,255,0.05)" : "rgba(17,24,39,0.04)";
    const dot = dark ? "rgba(255,255,255,0.16)" : "rgba(17,24,39,0.11)";
    let n = 0;
    document.querySelectorAll("[data-clone-raster]").forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.width < 200 || b.height < 120) return;
      const d = `<span style="width:11px;height:11px;border-radius:50%;background:${dot}"></span>`;
      const rows = [70, 52, 84, 46, 63].map((w) => `<div style="height:12px;width:${w}%;border-radius:6px;background:${bar}"></div>`).join("");
      const e = el as HTMLElement;
      e.style.background = surface;
      e.innerHTML =
        `<div style="width:100%;height:100%;box-sizing:border-box;padding:4.5%;display:flex;flex-direction:column;gap:5%;overflow:hidden">` +
          `<div style="display:flex;align-items:center;gap:10px">${d}${d}${d}<span style="flex:1"></span><span style="width:22%;height:12px;border-radius:6px;background:${weak}"></span></div>` +
          `<div style="display:flex;gap:5%;flex:1;min-height:0">` +
            `<div style="width:24%;background:${weak};border-radius:10px"></div>` +
            `<div style="flex:1;display:flex;flex-direction:column;gap:14px;padding-top:1%">${rows}</div>` +
          `</div>` +
        `</div>`;
      el.removeAttribute("data-clone-raster");
      n++;
    });
    return n;
  });
  if (placeholders) console.log(`  placeholder: ${placeholders} product-screenshot frame(s) → neutral in-style skeleton (no brand leak)`);
  await page.evaluate(() => window.scrollTo(0, 0));

  await page.evaluate(async () => {
    // Jump every animation/transition to its END state, twice (finishing some can start others), and
    // pause infinite loops at their end so nothing is captured mid-flight.
    for (let pass = 0; pass < 3; pass++) {
      (document.getAnimations?.() ?? []).forEach((a) => {
        // Leave the paused resting frame of an interaction-captured carousel panel alone — finishing it
        // would slide its active slide out of the panel's clip window (see captureInteractiveStates).
        const t = (a.effect as any)?.target as Element | undefined;
        if (t && t.closest?.("[data-clone-keepframe]")) return;
        try { a.finish(); } catch { try { (a as any).pause?.(); a.currentTime = (a.effect as any)?.getComputedTiming?.().activeDuration ?? a.currentTime; } catch {} }
      });
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, 400));
  });
  await page.evaluate(() => (document as any).fonts?.ready).catch(() => {});

  // Mark elements that are visually hidden by OCCLUSION (a cross-fade's hidden duplicate sitting behind
  // the visible one). elementFromPoint only works for the current viewport, so we sweep the page in
  // steps and flag any text box whose centre is covered by an unrelated subtree. Flagged nodes are
  // dropped in the clone below. (Bounded: ~a dozen scroll steps.)
  await page.evaluate(async () => {
    const related = (a: Element | null, b: Element) => { while (a) { if (a === b) return true; a = a.parentElement; } return false; };
    const step = Math.round(innerHeight * 0.9);
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
      document.querySelectorAll("h1,h2,h3,p,span,a,li,strong").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8 || r.top < 0 || r.bottom > innerHeight) return;
        if (!(el.textContent ?? "").trim()) return;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!hit || related(hit, el) || related(el, hit)) return;
        // Ignore fixed/sticky occluders (the sticky nav covers the top of the viewport as we scroll —
        // that is not the element being hidden, it is just passing under the header).
        let anc: Element | null = hit;
        while (anc) { const p = getComputedStyle(anc).position; if (p === "fixed" || p === "sticky") return; anc = anc.parentElement; }
        el.setAttribute("data-clone-occluded", "1");
      });
    }
    window.scrollTo(0, 0);
  });

  // Two React-state-driven transient artifacts resist the settle above (they are not CSS/WAAPI
  // animations). Neutralise them structurally, guarded so they never touch real design:
  await page.evaluate(() => {
    const lum = (c: string): number | null => {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c); if (!m) return null;
      const L = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * L(+m[1]) + 0.7152 * L(+m[2]) + 0.0722 * L(+m[3]);
    };
    const chroma = (c: string) => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c); return m ? Math.max(+m[1], +m[2], +m[3]) - Math.min(+m[1], +m[2], +m[3]) : 0; };

    // (1) Hero cross-fade GHOST: the animation renders an extra headline phrase in a slot to the RIGHT,
    // beside the real headline. The real headline is anchored on the LEFT of the hero, so any big-font
    // text block in the RIGHT half of the hero band is the cross-fade slot → hide it (and its subtree).
    document.querySelectorAll("h1,h2,h3,span,div,p").forEach((el) => {
      const r = el.getBoundingClientRect(); const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 40 || r.top + window.scrollY > 760) return;
      if (!(el.textContent ?? "").trim()) return;
      if (r.left > 560) el.setAttribute("data-clone-occluded", "1");
    });

    // (2) Light-theme FLASH: a large near-white (low-chroma) block sitting inside a dark parent is a
    // reveal caught light-side. Dark-mode-ify it — clear the white fill and flip its near-black text to
    // light, leaving syntax/token colours. Guarded by chroma so the real colour testimonial cards
    // (lavender/lime, saturated) are never touched.
    // On an overwhelmingly-dark page (the only intentional light surfaces are small buttons and the
    // saturated testimonial cards, both excluded below), a LARGE, LOW-CHROMA, near-WHITE block is
    // always a light-theme flash. Clear its white fill and flip its near-black text to light.
    const pageDark = (lum(getComputedStyle(document.body).backgroundColor) ?? 0) < 0.25;
    if (pageDark) {
      document.querySelectorAll("*").forEach((el) => {
        const r = el.getBoundingClientRect(); if (r.width * r.height < 40000) return;
        const cs = getComputedStyle(el);
        const bg = cs.backgroundColor; const l = lum(bg);
        const colorWhite = l !== null && l >= 0.85 && chroma(bg) <= 25;
        // A background-image counts as a white flash only if EVERY colour stop is near-white/low-chroma
        // (a colour card's lavender/lime stops or the dark ambient glow's stops fail this → safe).
        const stops = cs.backgroundImage.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/gi) ?? [];
        const imgWhite = stops.length > 0 && stops.every((sp) => { const sl = lum(sp); return sl !== null && sl >= 0.82 && chroma(sp) <= 30; });
        if (!colorWhite && !imgWhite) return;
        (el as HTMLElement).style.setProperty("background", "transparent", "important");
        (el as HTMLElement).style.setProperty("box-shadow", "none", "important");
        el.querySelectorAll("*").forEach((d) => {
          const dc = getComputedStyle(d).color; const dl = lum(dc);
          if (dl !== null && dl < 0.35 && chroma(dc) < 40) (d as HTMLElement).style.setProperty("color", "rgb(226,228,233)", "important");
        });
      });
    }
  });

  const cap = await page.evaluate(
    ({ PROPS, PSEUDO }) => {
      const DEFAULTS = new Set(["normal", "none", "auto", "0px", "0", "visible", "rgba(0, 0, 0, 0)", "static", "0% 0%", "repeat", "border-box"]);
      // Junk that is not part of the design: consent bars, chat bubbles, dev overlays.
      const JUNK = /cookie|consent|gdpr|onetrust|cookiebot|intercom|drift|crisp|livechat|beacon|__next-build-watcher|nextjs-portal|grammarly/i;
      const isJunk = (el: Element) => {
        const id = (el.id || "") + " " + (typeof el.className === "string" ? el.className : "");
        return JUNK.test(id);
      };

      let count = 0;
      let canvasCount = 0;
      const assetUrls = new Set<string>();
      const collect = (val: string, base = location.href) => {
        for (const m of val.matchAll(/url\((['"]?)([^'")]+)\1\)/g)) {
          const u = m[2];
          if (u && !u.startsWith("data:")) { try { assetUrls.add(new URL(u, base).href); } catch {} }
        }
      };
      const esc = (t: string) => t.replace(/[<>&]/g, (m) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[m]!));
      // A style value can carry double-quotes — font-family:"Source Code Pro", url("…") — which would
      // terminate the style="…" attribute early and make the HTML parser drop every property declared
      // after it. Escape the quote (NOT &, so the emit-stage split(url) rewrite still matches).
      const escA = (t: string) => t.replace(/"/g, "&quot;");

      const pseudo = (node: Element, which: "::before" | "::after"): string => {
        const ps = getComputedStyle(node, which);
        if (!ps.content || ps.content === "none" || ps.content === "normal") return "";
        let style = "";
        for (const p of PSEUDO) { const v = ps.getPropertyValue(p); if (v && !DEFAULTS.has(v.trim())) style += `${p}:${v};`; }
        collect(ps.backgroundImage);
        let text = "";
        const q = ps.content.match(/^"(.*)"$/s) || ps.content.match(/^'(.*)'$/s);
        if (q && q[1]) text = esc(q[1]);
        if (!style && !text) return "";
        count++;
        return `<span style="${escA(style)}">${text}</span>`;
      };

      // `clip` is the visible rectangle imposed by overflow-hidden ancestors (viewport coords). It is
      // how the reference hides its animation slots — a duplicate headline phrase lives inside a tiny
      // overflow:hidden box and is clipped away. We reproduce that by dropping any element whose box
      // falls entirely outside the current clip, instead of letting its pinned children spill.
      type Clip = { l: number; t: number; r: number; b: number };
      const FULL: Clip = { l: -1e6, t: -1e6, r: 1e6, b: 1e6 };
      const clone = (node: Element, clip: Clip): string => {
        const tag = node.tagName.toLowerCase();
        if (tag === "script" || tag === "style" || tag === "noscript" || tag === "link" || tag === "meta") return "";
        if (isJunk(node)) return "";
        if (tag === "svg") { count++; collect((node as any).outerHTML); return (node as SVGElement).outerHTML; }
        if (node.getAttribute("data-clone-occluded") === "1") return ""; // a cross-fade's hidden duplicate
        const s = getComputedStyle(node);
        if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return "";
        const rect = node.getBoundingClientRect();
        // Clipped away by an overflow-hidden ancestor → not visible in the reference.
        if (rect.width > 0 && rect.height > 0 &&
            (rect.right <= clip.l + 0.5 || rect.left >= clip.r - 0.5 || rect.bottom <= clip.t + 0.5 || rect.top >= clip.b - 0.5)) return "";
        if (tag === "canvas") canvasCount++;
        count++;

        // This element clips its own overflow → tighten the clip for its descendants.
        let childClip = clip;
        const clipsX = s.overflowX === "hidden" || s.overflowX === "clip";
        const clipsY = s.overflowY === "hidden" || s.overflowY === "clip";
        if ((clipsX || clipsY) && rect.width > 0) {
          childClip = {
            l: clipsX ? Math.max(clip.l, rect.left) : clip.l,
            t: clipsY ? Math.max(clip.t, rect.top) : clip.t,
            r: clipsX ? Math.min(clip.r, rect.right) : clip.r,
            b: clipsY ? Math.min(clip.b, rect.bottom) : clip.b,
          };
        }

        let style = "";
        for (const p of PROPS) { const v = s.getPropertyValue(p); if (v && !DEFAULTS.has(v.trim())) style += `${p}:${v};`; }
        collect(s.backgroundImage);
        // PIXEL-EXACT snapshot: pin BOTH measured width and height (rounded up), reproducing the
        // reference exactly. At swap time, src/swap.ts frees the height of any text box whose copy it
        // changes so relabelled text grows instead of clipping.
        if (rect.width > 0 && !s.display.startsWith("inline")) {
          style += `width:${Math.ceil(rect.width)}px;`;
          if (rect.height > 0) style += `height:${Math.ceil(rect.height)}px;`;
        }
        // A box rendered to a sliver but still carrying content is a collapsed/animation slot the
        // reference clips (e.g. a hidden headline phrase in a 1×1 box). Force it to clip its own spill
        // — invisible, exactly as in the reference — rather than letting its pinned children overflow.
        // A real box is never this small, so this only ever touches genuinely-hidden slots.
        if ((rect.width < 8 || rect.height < 8) && (node.children.length > 0 || (node.textContent ?? "").trim().length > 0)) {
          style += "overflow:hidden;";
        }

        const before = count < 24000 ? pseudo(node, "::before") : "";
        const after = count < 24000 ? pseudo(node, "::after") : "";
        if ((before || after) && s.position === "static") style += "position:relative;";

        let inner = before;
        node.childNodes.forEach((c) => {
          if (c.nodeType === 3) { const t = c.textContent ?? ""; if (t.trim()) inner += esc(t); }
          else if (c.nodeType === 1 && count < 24000) inner += clone(c as Element, childClip);
        });
        inner += after;

        const isVoid = /^(img|input|br|hr|source)$/.test(tag);
        let attrs = "";
        if (tag === "img") {
          const src = (node as HTMLImageElement).currentSrc || (node as HTMLImageElement).src;
          if (src && !src.startsWith("data:")) { try { assetUrls.add(new URL(src, location.href).href); } catch {} }
          attrs = ` src="${src}" alt=""`;
        }
        return isVoid ? `<${tag} style="${escA(style)}"${attrs}>` : `<${tag} style="${escA(style)}">${inner}</${tag}>`;
      };

      const html = clone(document.body, FULL);

      // The reference's OWN @font-face rules → exact type (not a guessed token mapping).
      const fontFaces: Array<{ family: string; weight: string; style: string; urls: string[] }> = [];
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList | null = null;
        try { rules = sheet.cssRules; } catch { continue; }
        if (!rules) continue;
        const base = sheet.href ?? location.href;
        const walk = (list: CSSRuleList) => {
          for (const rule of Array.from(list)) {
            const any = rule as any;
            if (rule.type === CSSRule.FONT_FACE_RULE) {
              const st = any.style;
              const family = (st.getPropertyValue("font-family") || "").replace(/['"]/g, "").trim();
              const src = st.getPropertyValue("src") || "";
              const urls: string[] = [];
              for (const m of src.matchAll(/url\(([^)]+)\)/g)) {
                const c = m[1].replace(/['"]/g, "").trim();
                if (!c.startsWith("data:")) { try { urls.push(new URL(c, base).href); } catch {} }
              }
              if (family && urls.length) fontFaces.push({ family, weight: st.getPropertyValue("font-weight") || "400", style: st.getPropertyValue("font-style") || "normal", urls });
            } else if (any.cssRules) walk(any.cssRules);
          }
        };
        walk(rules);
      }
      // Also any web-font files seen on the wire (cross-origin sheets the CSSOM can't read).
      for (const e of performance.getEntriesByType("resource")) {
        const n = (e as PerformanceResourceTiming).name;
        if (/\.(woff2?|otf|ttf)(\?|$)/i.test(n) && !fontFaces.some((f) => f.urls.includes(n))) {
          // attach under a synthetic entry so it still gets downloaded and can back a family fallback
          fontFaces.push({ family: "(from-network)", weight: "", style: "", urls: [n] });
        }
      }

      // Distinct visible text strings — the swap targets.
      const set = new Set<string>();
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let tn: Node | null;
      while ((tn = w.nextNode())) { const t = (tn.textContent ?? "").trim(); if (t && /[a-zA-Z0-9]/.test(t)) set.add(t); }

      const b = getComputedStyle(document.body);
      const r = document.body.getBoundingClientRect();
      return {
        html,
        bodyBg: b.backgroundColor,
        bodyColor: b.color,
        bodyFont: b.fontFamily,
        width: Math.round(innerWidth),
        height: Math.round(document.body.scrollHeight),
        nodes: count,
        canvasCount,
        assetUrls: [...assetUrls],
        fontFaces,
        textCount: set.size,
      };
    },
    { PROPS: CLONE_PROPS, PSEUDO: PSEUDO_PROPS },
  );
  return cap as ClonedPage;
}

// ---------------------------------------------------------------------------
const HEADERS = (referer: string) => ({
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Referer: referer,
  Accept: "*/*",
});

async function download(url: string, destDir: string, referer: string, used: Set<string>, kind: "asset" | "font"): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    const res = await fetch(url, { headers: HEADERS(referer), signal: ctrl.signal, redirect: "follow" });
    clearTimeout(timer);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    let ext = (path.extname(new URL(url).pathname).replace(".", "") || "").toLowerCase();
    if (kind === "font") { if (!/^(woff2?|otf|ttf)$/.test(ext)) ext = "woff2"; }
    else { const sn = sniffExtension(buf); if (!sn) return null; if (!ext || (ext !== sn && !(ext === "jpg" && sn === "jpeg"))) ext = sn; }
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

/** Write the clone as a self-contained static site: index.html + fonts/ + assets/, all local. */
export async function emitClone(dir: string, cloned: ClonedPage, referer: string): Promise<{ html: string; assets: number; fonts: number }> {
  const assetsDir = path.join(dir, "assets");
  const fontsDir = path.join(dir, "fonts");
  await mkdir(assetsDir, { recursive: true });
  await mkdir(fontsDir, { recursive: true });

  // Fonts first — build @font-face pointing at local files, keeping the reference's family names.
  const usedFonts = new Set<string>();
  const urlToLocal = new Map<string, string>();
  const faceRules: string[] = ["/* Cloned @font-face — the reference's own web fonts, downloaded local. */"];
  const fmt: Record<string, string> = { woff2: "woff2", woff: "woff", ttf: "truetype", otf: "opentype" };
  for (const face of cloned.fontFaces) {
    const srcs: string[] = [];
    for (const u of face.urls) {
      let local = urlToLocal.get(u);
      if (local === undefined) { local = (await download(u, fontsDir, referer, usedFonts, "font")) ?? ""; urlToLocal.set(u, local); }
      if (local) srcs.push(`url('./fonts/${local}') format('${fmt[local.split(".").pop() || "woff2"] ?? "woff2"}')`);
    }
    if (srcs.length && face.family && face.family !== "(from-network)") {
      faceRules.push(`@font-face{font-family:'${face.family}';src:${srcs.join(",")};font-weight:${face.weight || "100 900"};font-style:${face.style || "normal"};font-display:swap;}`);
    }
  }
  const fontCount = new Set([...urlToLocal.values()].filter(Boolean)).size;

  // Assets — download and rewrite refs in the markup to ./assets/….
  const usedAssets = new Set<string>();
  let html = cloned.html;
  let assetCount = 0;
  for (const u of cloned.assetUrls) {
    const local = await download(u, assetsDir, referer, usedAssets, "asset");
    if (local) { html = html.split(u).join(`assets/${local}`); assetCount++; }
    else { html = html.split(`url(${u})`).join("none").split(`url("${u}")`).join("none").split(`url(&quot;${u}&quot;)`).join("none").split(`url('${u}')`).join("none"); }
  }

  const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
${faceRules.join("\n")}
*{box-sizing:border-box}
html,body{margin:0;padding:0;overflow-x:hidden}
body{background:${cloned.bodyBg};color:${cloned.bodyColor};font-family:${cloned.bodyFont};-webkit-font-smoothing:antialiased}
img{max-width:none}
/* The walker skips list-style:none as a "default", but the UA default for ul/ol is disc/decimal — so
   without this reset, cloned nav/menu <li>s sprout stray bullets. Real bullets on marketing pages are
   custom (icons/::before), which are inlined and unaffected. */
ul,ol,li{list-style:none}
</style></head>
${html}
</html>`;
  await writeFile(path.join(dir, "index.html"), doc);
  return { html: doc, assets: assetCount, fonts: fontCount };
}

// ---------------------------------------------------------------------------
function hostname(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return "site"; }
}

async function main() {
  const args = process.argv.slice(2);
  let url = "";
  let out = "./output";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") out = args[++i];
    else if (!args[i].startsWith("--")) url = args[i];
  }
  if (!url) { console.error("Usage: tsx src/clone.ts <url> [--out <dir>]"); process.exit(1); }
  if (!/^https?:\/\//.test(url)) url = "https://" + url;

  const dir = path.join(out, hostname(url), "site");
  await mkdir(dir, { recursive: true });
  console.log(`\n▸ Cloning whole page: ${url}\n  → ${dir}\n`);

  const { browser, page } = await launch(url);
  try {
    const t0 = Date.now();
    const cloned = await clonePage(page);
    console.log(`  cloned: ${cloned.nodes} nodes, ${cloned.width}×${cloned.height}px, ${(cloned.html.length / 1024).toFixed(0)}KB markup, ${cloned.textCount} text strings, ${cloned.canvasCount} canvas`);
    const emitted = await emitClone(dir, cloned, url);
    await writeFile(path.join(dir, "clone.json"), JSON.stringify({ source: url, clonedAt: new Date().toISOString(), ...cloned, html: undefined }, null, 2) + "\n");
    console.log(`  assets: ${emitted.assets} downloaded, fonts: ${emitted.fonts}`);
    console.log(`\n✓ Done in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${path.join(dir, "index.html")}\n`);
  } finally {
    await browser.close();
  }
}

// Run as a CLI (not when imported by the build path).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("\n✗ Clone failed:", e); process.exit(1); });
}
