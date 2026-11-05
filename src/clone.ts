// WHOLE-PAGE RESPONSIVE CLONE (post "rearchitect" decision — context.md).
//
// The previous approach inlined getComputedStyle() on every element. Those are PIXEL values resolved at a
// single (1440px) capture viewport, so the output was a fixed-width, non-responsive snapshot — the
// reference's media queries and fluid units were discarded, and it left-aligned with blank space on wider
// screens. This approach instead PRESERVES the reference's own CSS: keep the real DOM (classes, structure,
// and the display:none responsive variants like the mobile menu that the old walker dropped) and inline
// its stylesheets — same-origin via the CSSOM, cross-origin (CDN) sheets fetched server-side, which
// sidesteps the CORS cssRules block that originally drove the computed-style design. With the reference's
// @font-face, @media, and layout CSS intact plus its <meta viewport>, the clone reflows like the reference
// at every width. src/swap.ts then changes only the wording.
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { launch } from "./browser.js";
import { sniffExtension, fileStemFromUrl } from "./util.js";

export type TabGroup = { gid: string; htmls: string[]; media?: boolean; activeIdx?: number };

export interface ClonedPage {
  bodyHtml: string; // <body>…</body> with the reference's own classes/structure preserved
  htmlAttrs: string; // class/style on <html> (theme class + font CSS variables), pre-escaped
  css: string; // same-origin CSS, url() already resolved to absolute
  crossHrefs: string[]; // cross-origin stylesheet URLs, fetched + inlined at emit time
  assetUrls: string[]; // <img> sources (CSS url()s are extracted from the stylesheets at emit time)
  viewport: string; // the reference's <meta viewport> content (the responsiveness switch)
  title: string;
  lang: string;
  width: number;
  height: number;
  nodes: number;
  canvasCount: number;
  textCount: number; // distinct visible text strings (the swap targets)
  tabData: TabGroup[]; // per-tab content snapshots (or rasterised media frames) → the tab-switch runtime
  stickyCss: string; // scrolled-state rules for sticky headers, replayed by the runtime (see captureStickyStates)
}

/** Drive tabbed showcases so their per-tab imagery mounts and eager-loads, RECORD each tab's content
 *  (the "stage" HTML) so the static clone can re-wire the tabs to actually switch content, then leave the
 *  reference's default tab active. Deterministic + guarded: nav/menu chrome is excluded, links that would
 *  navigate are skipped, the initially-active tab is restored, and tabs/stage are tagged for the runtime. */
async function captureInteractiveStates(page: Page): Promise<{ groups: number; clicks: number; imgsLoaded: number; tabData: TabGroup[] }> {
  return await page.evaluate(async () => {
    // Upper bound on tabs captured per group — capture cost is ~0.5s each, and it also bounds the tagging
    // loop so no tab is ever wired without content behind it.
    const MAX_TABS = 16;
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

    let clicks = 0, imgsLoaded = 0, gc = 0;
    const tabData: TabGroup[] = [];
    for (const tabs of groups.slice(0, 8)) {
      const activeIdx = Math.max(0, tabs.findIndex((t) => t.getAttribute("aria-selected") === "true" || activeClass(t)));
      let panel: Element = tabs[0].parentElement || tabs[0];
      for (let k = 0; k < 6 && panel.parentElement; k++) { if (panel.querySelector("img,canvas,picture,video")) break; panel = panel.parentElement; }
      (panel as HTMLElement).scrollIntoView?.({ block: "center" });
      await sleep(150);

      // The "stage" = the content region that changes between tabs: a stable descendant of the panel that
      // holds the imagery and does NOT contain the tab buttons. We record its innerHTML per tab and swap
      // it on click in the emitted clone.
      const stageCands = [...panel.querySelectorAll("*")].filter((el) => el.querySelector("img,canvas,svg,video,picture") && !tabs.some((t) => el.contains(t) || t.contains(el)));
      stageCands.sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return rb.width * rb.height - ra.width * ra.height; });
      const stage = stageCands[0] || null;

      // Capture every tab we intend to wire. The cap and the tagging loop below MUST agree: capping capture
      // at 8 while tagging all 13 of a group's tabs leaves the last five as buttons that record no content,
      // so clicking them does nothing — exactly the "tabs that do not tab" tell.
      const htmls: string[] = [];
      for (let i = 0; i < Math.min(tabs.length, MAX_TABS); i++) {
        if (!activatable(tabs[i])) { htmls.push(""); continue; }
        try { (tabs[i] as HTMLElement).click(); clicks++; } catch { /* ignore */ }
        await sleep(420);
        imgsLoaded += forceLoad(panel);
        await sleep(120);
        htmls.push(stage ? (stage as HTMLElement).innerHTML : "");
      }
      // Restore the reference's default tab so the frozen snapshot matches its initial state.
      try { (tabs[activeIdx] as HTMLElement).click(); } catch { /* ignore */ }
      await sleep(350);
      imgsLoaded += forceLoad(panel);

      // Is this a MEDIA showcase (a big screenshot/carousel that the innerHTML snapshot can't reliably
      // reproduce because slides are clipped/positioned by JS)? If the panel's largest media is large but
      // the recorded stage HTML rendered (near-)no image, mark the FRAME for Node-side rasterisation.
      // Find THIS group's showcase media: among large media in the panel, the one physically CLOSEST to
      // the tab row (scroll-invariant document coords), and only if it actually adjoins the tabs. Choosing
      // by proximity (not largest-area) stops a group from grabbing a big screenshot in an adjacent section
      // (e.g. code-icon tabs stealing the dashboard image one section away).
      const absTop = (el: Element) => el.getBoundingClientRect().top + window.scrollY;
      const absBottom = (el: Element) => el.getBoundingClientRect().bottom + window.scrollY;
      const trTop = Math.min(...tabs.map(absTop)), trBottom = Math.max(...tabs.map(absBottom));
      const vgap = (el: Element) => { const t = absTop(el), bt = absBottom(el); return t >= trBottom ? t - trBottom : (trTop >= bt ? trTop - bt : 0); };
      // The media must live in the SAME section/container as the tabs (the frame is sandwiched between the
      // dashboard's own tabs above and the next section's tabs below, so section identity — not pixel gap —
      // is what disambiguates). Scope to the tabs' nearest sectioning ancestor.
      const container = tabs[0].closest("section,article,[class*=section]") || panel;
      const media = [...container.querySelectorAll("img,video,canvas")]
        .map((m) => { const r = m.getBoundingClientRect(); return { m, a: r.width * r.height, h: r.height, gap: vgap(m) }; })
        .filter((o) => o.a > 40000)
        .sort((x, y) => x.gap - y.gap)[0];
      let frame: Element | null = null;
      if (media && media.gap <= Math.max(media.h, 250)) {
        frame = media.m.parentElement;
        for (let k = 0; k < 6 && frame && frame !== panel; k++) {
          const c = getComputedStyle(frame); const fb = frame.getBoundingClientRect();
          if ((c.overflowX === "hidden" || c.overflowX === "clip" || c.overflowY === "hidden" || c.overflowY === "clip") && fb.width >= 200 && fb.height >= 120) break;
          frame = frame.parentElement;
        }
      }

      // Tag for the runtime AFTER interaction (so React re-renders don't strip the attributes), only if we
      // captured a real content difference between tabs OR it is a media showcase to rasterise.
      const contentDiffers = stage && htmls.some((h) => h && h !== htmls[activeIdx]);
      const isMedia = !!frame && tabs.length >= 2;
      if (contentDiffers || isMedia) {
        const gid = "g" + gc++;
        // For a media showcase the swap target is the FRAME (its screenshot); otherwise the content stage.
        const target = isMedia ? frame! : stage!;
        (target as HTMLElement).setAttribute("data-atl-stage", gid);
        if (frame) (frame as HTMLElement).setAttribute("data-atl-frame", gid);
        // Tag ONLY the tabs that will have real content behind them. A tagged tab with an empty snapshot is
        // worse than an untagged one: the runtime would blank the stage (or do nothing) on click.
        // A MEDIA showcase is the exception — its stage snapshot is empty BY DEFINITION (JS clips the
        // slides), so its tabs are tagged provisionally and Node-side rasterisation fills them in; any that
        // still come back empty are untagged afterwards.
        tabs.forEach((t, i) => {
          if (isMedia ? i < Math.min(tabs.length, MAX_TABS) : !!htmls[i]) t.setAttribute("data-atl-tab", gid + ":" + i);
        });
        tabData.push({ gid, htmls, media: isMedia, activeIdx });
      }
    }
    window.scrollTo(0, 0);
    await sleep(200);
    return { groups: groups.length, clicks, imgsLoaded, tabData };
  });
}

/**
 * STICKY-HEADER SCROLLED STATE. A sticky/fixed header that is transparent at the top of the page but
 * gains a solid/blurred background once you scroll is near-universal — and the clone froze the
 * top-of-page state, so the nav's links rendered directly on top of the content scrolling beneath them.
 * That is `vibe-coded-patterns.md` §1.9 AND the hard-reject "overlapping or illegible text".
 *
 * The obvious fix — find the CSS rule for the scrolled state — does not generalise. MEASURED on the live
 * references: Resend's header class list NEVER changes on scroll and it carries no style attribute; the
 * state is driven from somewhere else entirely (an ancestor attribute / JS), and only the RENDERED result
 * shows it (`::after` opacity 0 → 1 over a `oklab(0 0 0 / .6)` + `blur(12px)` layer). So measure the
 * render, exactly as the project does everywhere else: read each sticky header's computed style — self,
 * ::before and ::after — at the top of the page and again scrolled down, and keep whatever DIFFERS.
 *
 * It deliberately does NOT diff against the top-of-page state. That was the first cut, and it failed:
 * the interaction/rasterisation passes leave the reference latched in its scrolled state, so the "top"
 * reading came back already-scrolled for one pseudo-layer and the diff silently dropped it — emitting
 * `::before` while missing the `::after` that carries the actual background. Instead it ASSERTS the
 * measured scrolled appearance of any layer that actually paints something. When the reference's header
 * looks the same at both scroll positions the rule is a harmless no-op re-asserting existing values,
 * which is exactly why this version cannot silently lose a layer.
 *
 * The result is emitted as CSS scoped to `.atl-stuck` and applied by the runtime on scroll, so the clone
 * reproduces the reference's real behaviour (transparent over the hero, solid once scrolling) rather than
 * freezing either state. Pseudo-element styling cannot be set inline, which is why this is a CSS rule
 * rather than an inline style like the rest of the clone's fixups.
 */
const STICKY_PROPS = [
  "background-color", "background-image", "backdrop-filter", "-webkit-backdrop-filter",
  "opacity", "box-shadow", "border-bottom-color", "border-bottom-width", "border-bottom-style",
  "filter", "visibility",
] as const;

async function captureStickyStates(page: Page): Promise<{ css: string; count: number }> {
  // Measure while scrolled — this is the state that has to be reproduced.
  await page.evaluate(() => window.scrollTo(0, Math.min(900, document.body.scrollHeight)));
  await page.waitForTimeout(1200); // let the reference's own transition finish before measuring

  const layers = await page.evaluate((props: readonly string[]) => {
    const out: { i: number; layer: string; decls: string[] }[] = [];
    const els = [...document.querySelectorAll<HTMLElement>("header,nav,div")].filter((el) => {
      const s = getComputedStyle(el);
      if (s.position !== "sticky" && s.position !== "fixed") return false;
      const r = el.getBoundingClientRect();
      // A page-wide bar pinned to the very top — not a floating widget, sidebar or cookie bar.
      return r.top <= 2 && r.height >= 20 && r.height <= 220 && r.width >= innerWidth * 0.6;
    }).slice(0, 3);

    els.forEach((el, i) => {
      el.setAttribute("data-atl-stick", String(i));
      for (const pe of [null, "::before", "::after"] as const) {
        const cs = getComputedStyle(el, pe);
        // A pseudo-layer with no generated content renders nothing at all.
        if (pe && (cs.content === "none" || !cs.content)) continue;
        const alpha = (c: string) => { const m = /rgba?\([^)]*?([\d.]+)\s*\)/.exec(c); return c.includes("rgba") ? (m ? +m[1] : 1) : c && c !== "transparent" ? 1 : 0; };
        // Only layers that actually PAINT a surface matter — a fill, a gradient, a blur or an elevation.
        const paints =
          alpha(cs.backgroundColor) > 0.02 ||
          (cs.backgroundImage && cs.backgroundImage !== "none") ||
          (cs.backdropFilter && cs.backdropFilter !== "none") ||
          (cs.boxShadow && cs.boxShadow !== "none");
        if (!paints) continue;
        const decls = props
          .map((p) => [p, cs.getPropertyValue(p)] as const)
          .filter(([, v]) => v && v !== "none")
          .map(([p, v]) => `${p}:${v} !important`);
        if (decls.length) out.push({ i, layer: pe ?? "self", decls });
      }
    });
    return out;
  }, STICKY_PROPS as unknown as string[]);

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);

  let css = "";
  for (const l of layers) {
    css += `[data-atl-stick="${l.i}"].atl-stuck${l.layer === "self" ? "" : l.layer}{${l.decls.join(";")}}\n`;
  }
  return { css, count: layers.length };
}

/** Clone the whole page, preserving the reference's own CSS so the result is responsive. */
export async function clonePage(page: Page): Promise<ClonedPage> {
  // Reduced motion (set on the context before nav too) → static image fallbacks over autoplaying video.
  await page.emulateMedia({ reducedMotion: "reduce" }).catch(() => {});
  await page.addStyleTag({ content: `*{scroll-behavior:auto!important;caret-color:transparent!important}` }).catch(() => {});

  // Scroll through once to trigger reveal animations + lazy-loaded imagery, then return to top.
  await page.evaluate(async () => {
    const step = Math.round(innerHeight * 0.85);
    for (let y = 0; y < document.body.scrollHeight; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 180)); }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 400));
  });

  // INTERACTION-CAPTURE: click through tabbed showcases so every tab's content mounts + eager-loads
  // (else the panels clone empty), and RECORD each tab→panel mapping so the emitted page can re-wire the
  // tabs to actually switch content (see wireInteractivity / the injected runtime).
  const tabInfo = await captureInteractiveStates(page);
  // Report what was actually WIRED (tabData), not how many candidate clusters were found — a cluster whose
  // tabs change nothing is correctly left alone, and conflating the two hides whether tabs really work.
  if (tabInfo.groups) console.log(`  interaction: ${tabInfo.tabData.length}/${tabInfo.groups} tab group(s) wired, ${tabInfo.clicks} states, ${tabInfo.imgsLoaded} panel image(s) loaded`);

  // MEDIA showcases (a big screenshot/carousel whose slides JS clips/positions) can't be reproduced from
  // an innerHTML snapshot. With site JS still live, click each tab from Node, screenshot the frame, and
  // store that still as the tab's content — so the exact screenshot shows and the sub-tabs switch it.
  let rasterised = 0;
  for (const g of tabInfo.tabData) {
    if (!g.media) continue;
    const frame = await page.$(`[data-atl-frame="${g.gid}"]`);
    if (!frame) continue;
    // NEVER flatten page chrome or copy into pixels. Railway's tab group resolved to a frame spanning the
    // whole hero, so a 1408×1700 screenshot of the REFERENCE — its headline, wordmark and nav — was baked
    // in as a data-URI image. The wording swap only touches text nodes, so the reference's branding
    // survived in the raster while `innerText` (and therefore every brand/verify check) read as clean:
    // the page LOOKED like the reference while measuring perfectly. Rasterise only genuine media frames.
    const unsafe = await frame.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const ownsChrome = !!el.querySelector("header,nav,h1,h2");
      const isChrome = !!el.closest("header,nav");
      const tooTall = r.height > innerHeight * 1.15; // a showcase panel, not a whole page section
      return ownsChrome || isChrome || tooTall;
    });
    if (unsafe) {
      console.log(`  ⚠ raster: skipped tab group ${g.gid} — frame contains page chrome/headings or is full-page`);
      g.media = false;
      await page.evaluate((gid) => {
        document.querySelectorAll(`[data-atl-tab^="${gid}:"]`).forEach((t) => t.removeAttribute("data-atl-tab"));
      }, g.gid);
      continue;
    }
    const imgs: string[] = [];
    for (let i = 0; i < g.htmls.length; i++) {
      try {
        const tab = await page.$(`[data-atl-tab="${g.gid}:${i}"]`);
        if (tab) { await tab.click({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(500); }
        const box = await frame.boundingBox();
        if (!box || box.width < 100 || box.height < 80) { imgs.push(""); continue; }
        const buf = await frame.screenshot({ type: "png", timeout: 8000 });
        imgs.push(buf.length > 800 ? `<img src="data:image/png;base64,${buf.toString("base64")}" alt="" style="display:block;width:100%;height:100%;object-fit:contain">` : "");
      } catch { imgs.push(""); }
    }
    if (imgs.some((h) => h)) {
      g.htmls = imgs;
      rasterised++;
      // Drop the provisional tag from any tab whose screenshot came back empty, so no wired tab is dead.
      await page.evaluate(({ gid, empties }) => {
        for (const i of empties) document.querySelector(`[data-atl-tab="${gid}:${i}"]`)?.removeAttribute("data-atl-tab");
      }, { gid: g.gid, empties: imgs.map((h, i) => (h ? -1 : i)).filter((i) => i >= 0) });
      // The live frame renders empty (clipped carousel) — set its initial content to the default
      // screenshot so the default view shows the exact image, not a blank box.
      const def = imgs[g.activeIdx ?? 0] || imgs.find((h) => h) || "";
      await frame.evaluate((el, html) => { (el as HTMLElement).style.overflow = "hidden"; el.innerHTML = html; }, def);
    }
  }
  if (rasterised) console.log(`  rasterised ${rasterised} media showcase(s) → real per-tab screenshots (exact)`);

  // Record the sticky header's scrolled appearance BEFORE settling (this scrolls the page, and the settle
  // below returns to the top and re-finishes animations).
  const sticky = await captureStickyStates(page);
  if (sticky.count) console.log(`  sticky header: captured ${sticky.count} scrolled-state layer(s)`);

  // Settle CSS/WAAPI animations to their end frame, then wait for fonts.
  await page.evaluate(async () => {
    for (let pass = 0; pass < 3; pass++) {
      (document.getAnimations?.() ?? []).forEach((a) => { try { a.finish(); } catch { try { (a as any).pause?.(); } catch {} } });
      await new Promise((r) => setTimeout(r, 200));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 300));
  });
  await page.evaluate(() => (document as any).fonts?.ready).catch(() => {});

  // CAPTURE: keep the real DOM + classes, inline the reference's own stylesheets.
  const cap = await page.evaluate(() => {
    const esc = (s: string) => s.replace(/"/g, "&quot;");
    // Strip scripts + injected dev/consent junk. KEEP display:none elements — they are the responsive
    // variants (mobile menu, breakpoint-specific layouts); dropping them is what broke responsiveness.
    const JUNK = /cookie|consent|gdpr|onetrust|cookiebot|intercom|drift|crisp|livechat|beacon|__next-build-watcher|nextjs-portal|grammarly/i;
    document.querySelectorAll("script,noscript").forEach((e) => e.remove());
    document.querySelectorAll("*").forEach((e) => {
      const id = (e.id || "") + " " + (typeof e.className === "string" ? e.className : "");
      if (JUNK.test(id)) e.remove();
    });

    // Pin each <img> to the responsive source the browser actually chose (currentSrc), drop srcset so one
    // downloaded file backs every width, and drop lazy attrs so it shows immediately.
    const assetUrls = new Set<string>();
    document.querySelectorAll("img").forEach((im) => {
      const i = im as HTMLImageElement;
      const s = i.currentSrc || i.src;
      if (s && !s.startsWith("data:")) { try { assetUrls.add(new URL(s, location.href).href); } catch {} i.setAttribute("src", s); }
      i.removeAttribute("srcset"); i.removeAttribute("loading");
    });
    document.querySelectorAll("picture source").forEach((s) => s.remove());

    // Media (<video>/<audio>/<source>) is referenced by src too. Without this the clone keeps pointing at
    // the reference's own CDN for them — not self-contained, and a live request to the reference per view.
    document.querySelectorAll("video[src],audio[src],video source[src],audio source[src]").forEach((el) => {
      const s = el.getAttribute("src") || "";
      if (s && !s.startsWith("data:")) { try { assetUrls.add(new URL(s, location.href).href); } catch { /* ignore */ } }
    });

    // NO 404s. The static clone has no other pages, so internal links (same-origin or relative) that would
    // navigate away are neutralised to "#"; genuinely external links (github/twitter/docs on another host)
    // are kept and opened in a new tab. In-page #anchors are left alone.
    // Matching on ORIGIN is not enough: `docs.railway.com`, `dashboard.clerk.com` and
    // `status.supabase.com` are all a different origin from the reference's www host, so they were kept
    // as "genuinely external" and shipped the invented product linking straight back at the real company
    // (measured: 3 of 5 builds failed the audit on exactly this). Compare the REGISTRABLE domain instead,
    // so every subdomain of the reference is neutralised too.
    const registrable = (h: string) => {
      const p = h.replace(/^www\./, "").split(".");
      // Handle the common two-label public suffixes (co.uk, com.au) without shipping a full PSL.
      const twoLabelTld = p.length > 2 && /^(co|com|org|net|gov|edu|ac)$/.test(p[p.length - 2]);
      return p.slice(twoLabelTld ? -3 : -2).join(".");
    };
    const refDomain = registrable(location.hostname);
    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") || "";
      if (href.startsWith("#")) return;
      let u: URL | null = null; try { u = new URL(href, location.href); } catch { u = null; }
      const backAtReference = u && registrable(u.hostname) === refDomain;
      if (!u || u.origin === location.origin || backAtReference) {
        // Keep the reference's own target as a PATH before killing the link — this is what a later
        // multi-page pass needs in order to point the nav at real cloned sub-pages instead of "#".
        // Path only, never the host: the host would put the reference's domain back into the shipped HTML.
        if (u && (u.pathname !== "/" || u.search)) a.setAttribute("data-atl-href", u.pathname + u.search);
        a.setAttribute("href", "#"); a.removeAttribute("target");
      }
      else { a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener noreferrer"); }
    });

    // Same-origin stylesheets via CSSOM, url() resolved to absolute against each sheet's own base.
    // Cross-origin sheets throw on .cssRules → record their href for a server-side fetch at emit time.
    const resolveUrls = (cssText: string, base: string) =>
      cssText.replace(/url\((['"]?)([^'")]+)\1\)/g, (m, _q, u) => { if (!u || u.startsWith("data:")) return m; try { return `url("${new URL(u, base).href}")`; } catch { return m; } });
    let css = "";
    const crossHrefs: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | null = null;
      try { rules = sheet.cssRules; } catch { if (sheet.href) crossHrefs.push(sheet.href); continue; }
      if (!rules) { if (sheet.href) crossHrefs.push(sheet.href); continue; }
      const base = sheet.href || document.baseURI;
      for (const r of Array.from(rules)) css += resolveUrls((r as CSSRule).cssText, base) + "\n";
    }

    const set = new Set<string>();
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let tn: Node | null; while ((tn = w.nextNode())) { const t = (tn.textContent ?? "").trim(); if (t && /[a-zA-Z0-9]/.test(t)) set.add(t); }

    // Keep EVERY attribute on <html>, not just class/style. A site's whole palette is routinely scoped to
    // an attribute selector on the root — Linear defines its colour tokens under `[data-theme=dark]`, so
    // dropping `data-theme` leaves every `var(--color-*)` undefined, which computes text to initial black
    // on a dark page. Layout survives, so this reads as a mysteriously "dim" clone rather than a break.
    const de = document.documentElement;
    const htmlAttrs = Array.from(de.attributes)
      .filter((a) => a.name !== "lang") // re-emitted explicitly
      .map((a) => ` ${a.name}="${esc(a.value)}"`)
      .join("");
    return {
      bodyHtml: document.body.outerHTML,
      htmlAttrs,
      css,
      crossHrefs,
      assetUrls: [...assetUrls],
      viewport: document.querySelector("meta[name=viewport]")?.getAttribute("content") || "width=device-width, initial-scale=1",
      title: document.title || "",
      lang: de.getAttribute("lang") || "en",
      width: Math.round(innerWidth),
      height: Math.round(document.body.scrollHeight),
      nodes: document.querySelectorAll("*").length,
      canvasCount: document.querySelectorAll("canvas").length,
      textCount: set.size,
    };
  });
  return { ...cap, tabData: tabInfo.tabData, stickyCss: sticky.css } as ClonedPage;
}

// ---------------------------------------------------------------------------
const HEADERS = (referer: string) => ({
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Referer: referer,
  Accept: "*/*",
});

/** Resolve every url() in a stylesheet's text to an absolute URL against the sheet's own location. */
function resolveCssUrls(cssText: string, base: string): string {
  return cssText.replace(/url\((['"]?)([^'")]+)\1\)/g, (m, _q, u) => {
    if (!u || u.startsWith("data:")) return m;
    try { return `url("${new URL(u, base).href}")`; } catch { return m; }
  });
}

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
    if (kind === "font") { if (!/^(woff2?|otf|ttf|eot)$/.test(ext)) ext = "woff2"; }
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

/** Write the clone as a self-contained responsive static site: index.html + fonts/ + assets/. The
 *  reference's own CSS (same-origin + cross-origin, fetched here) is inlined so media queries survive. */
export async function emitClone(dir: string, cloned: ClonedPage, referer: string): Promise<{ html: string; assets: number; fonts: number }> {
  const assetsDir = path.join(dir, "assets");
  const fontsDir = path.join(dir, "fonts");
  await mkdir(assetsDir, { recursive: true });
  await mkdir(fontsDir, { recursive: true });

  // Fetch cross-origin stylesheets server-side (no CORS) and resolve their url()s to absolute.
  let css = cloned.css;
  for (const href of cloned.crossHrefs) {
    try {
      const r = await fetch(href, { headers: HEADERS(referer), redirect: "follow" });
      if (r.ok) { css += `\n/* ${href} */\n` + resolveCssUrls(await r.text(), href); }
    } catch { /* ignore */ }
  }
  // Append the sticky-header scrolled state LAST so it wins on source order, and — importantly — so its
  // url()s go through the same download-and-localise pass below. Emitting it as a separate <style> block
  // left a live `url(https://<reference>/…)` in the output, breaking the "every asset local" contract.
  if (cloned.stickyCss) css += `\n/* atelier: sticky-header scrolled state */\n${cloned.stickyCss}`;

  // Collect every url() (fonts + assets from the CSS) plus <img> srcs; download and rewrite to local.
  const urlSet = new Set<string>();
  for (const m of css.matchAll(/url\(["']?([^"')]+)["']?\)/g)) { const u = m[1]; if (u && !u.startsWith("data:")) urlSet.add(u); }
  for (const u of cloned.assetUrls) urlSet.add(u);

  const usedAssets = new Set<string>();
  const usedFonts = new Set<string>();
  const urlToLocal = new Map<string, string>();
  let assetCount = 0, fontCount = 0;
  for (const u of urlSet) {
    const isFont = /\.(woff2?|otf|ttf|eot)(\?|$)/i.test(u);
    const local = await download(u, isFont ? fontsDir : assetsDir, referer, isFont ? usedFonts : usedAssets, isFont ? "font" : "asset");
    if (local) { urlToLocal.set(u, (isFont ? "fonts/" : "assets/") + local); isFont ? fontCount++ : assetCount++; }
  }

  let bodyHtml = cloned.bodyHtml;
  const tabMap: Record<string, string[]> = {};
  for (const g of cloned.tabData) tabMap[g.gid] = g.htmls.slice();
  // The HTML we rewrite came from outerHTML/innerHTML, so the SERIALIZER has already escaped `&` in every
  // attribute: an <img src="…?w=72&q=95"> reads back as "…?w=72&amp;q=95". Splitting on the raw URL alone
  // therefore silently misses every asset whose URL carries query params, leaving the clone hotlinking the
  // reference's CDN (offline-broken, and a live request to the reference on every view). Rewrite BOTH forms.
  // CSS text is not HTML-escaped, so it only needs the raw form.
  const escAmp = (s: string) => s.replace(/&/g, "&amp;");
  for (const [u, local] of urlToLocal) {
    css = css.split(u).join(local);
    const forms = u.includes("&") ? [u, escAmp(u)] : [u];
    for (const f of forms) {
      bodyHtml = bodyHtml.split(f).join(local);
      for (const gid in tabMap) tabMap[gid] = tabMap[gid].map((h) => h.split(f).join(local));
    }
  }

  // Tab-switch runtime: the first of the clone's few tiny runtimes (sticky header below; the form runtime is
  // appended later by src/behavior.ts). None of the reference's own JS ships — these are ours, and each one
  // exists to make an affordance the reference really has work. On tab click it swaps the recorded content into the
  // stage and moves the active state — so tabs actually change component content (no site JS needed).
  const tabsJson = JSON.stringify(tabMap).replace(/<\//g, "<\\/");
  const tabBlock = cloned.tabData.length
    ? `<script id="atl-tabs" type="application/json">${tabsJson}</script>
<script>(function(){var d={};try{d=JSON.parse(document.getElementById("atl-tabs").textContent)}catch(e){return}
document.querySelectorAll("[data-atl-tab]").forEach(function(t){t.style.cursor="pointer";t.addEventListener("click",function(e){var p=(t.getAttribute("data-atl-tab")||"").split(":"),g=p[0],i=+p[1],s=document.querySelector('[data-atl-stage="'+g+'"]'),h=d[g];if(s&&h&&h[i]){e.preventDefault();s.innerHTML=h[i]}document.querySelectorAll('[data-atl-tab^="'+g+':"]').forEach(function(x){var on=x.getAttribute("data-atl-tab")===g+":"+i;x.setAttribute("aria-selected",on?"true":"false");x.setAttribute("data-state",on?"active":"inactive")})})})})();</script>`
    : "";

  // Sticky-header runtime: toggle `atl-stuck` past a small scroll offset so the captured scrolled state
  // (the solid/blurred background) applies exactly when the reference's own would — which is what keeps
  // the nav's links from rendering on top of the content passing underneath.
  const stickyBlock = cloned.stickyCss
    ? `<script>(function(){var h=document.querySelectorAll("[data-atl-stick]");if(!h.length)return;var on=false;function u(){var s=(window.scrollY||document.documentElement.scrollTop)>40;if(s===on)return;on=s;h.forEach(function(e){e.classList.toggle("atl-stuck",s)})}addEventListener("scroll",u,{passive:true});u()})();</script>`
    : "";

  const title = cloned.title.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
  const doc = `<!doctype html><html lang="${cloned.lang}"${cloned.htmlAttrs}><head><meta charset="utf-8">
<meta name="viewport" content="${cloned.viewport.replace(/"/g, "&quot;")}">
<title>${title}</title>
<style>
*{box-sizing:border-box}
img{max-width:100%}
ul,ol,li{list-style:none}
</style>
<style>
${css}
</style>
</head>
${bodyHtml}
${tabBlock}
${stickyBlock}
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
  console.log(`\n▸ Cloning whole page (responsive): ${url}\n  → ${dir}\n`);

  const { browser, page } = await launch(url);
  try {
    const t0 = Date.now();
    const cloned = await clonePage(page);
    console.log(`  cloned: ${cloned.nodes} nodes, viewport ${cloned.width}×${cloned.height}px, ${(cloned.bodyHtml.length / 1024).toFixed(0)}KB markup + ${(cloned.css.length / 1024).toFixed(0)}KB CSS, ${cloned.textCount} text strings, ${cloned.canvasCount} canvas`);
    const emitted = await emitClone(dir, cloned, url);
    await writeFile(path.join(dir, "clone.json"), JSON.stringify({ source: url, clonedAt: new Date().toISOString(), ...cloned, bodyHtml: undefined, css: undefined }, null, 2) + "\n");
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
