// COMPONENTIZE — turn an adapted clone (one self-contained index.html) into a real Next.js + React + TS project
// that renders IDENTICALLY. No model call.
//
//   npx tsx src/componentize.ts <adapted-dir> <workspace>
//
// Why this exists: rebuilding a page from a description of the reference loses everything that made the
// reference good (measured: the Rallypoint build). Converting the reference's REAL markup keeps it — the same
// DOM, classes and CSS — while the output is still editable React: one component per section, a page that
// composes them, real assets, the reference's stylesheet served as-is.
//
// Layout of the output:
//   app/layout.tsx            <html>/<body> attributes + <head> (title/meta) + /reference.css + runtime script
//   app/page.tsx              the page skeleton (the reference's wrappers) with <S03Features /> … in place
//   components/sections/*.tsx one server component per detected section (pure JSX, zero client JS)
//   components/custom/        where NEW work goes (Tailwind on the extracted tokens is scoped to this folder)
//   public/reference.css      the reference's CSS, untouched (bypasses PostCSS/Tailwind on purpose)
//   public/assets, public/fonts, public/atelier-runtime.js
//   SECTIONS.md               the coder's map: file → role → headings → copy
import { cp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { ensureSharedDeps } from "./scaffold-cli.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = path.join(ROOT, "templates", "next-tailwind");

interface Converted {
  htmlAttrs: Record<string, string>;
  bodyAttrs: Record<string, string>;
  title: string;
  description: string;
  css: string;
  scripts: string[];
  skeleton: string; // JSX for the body's children with section placeholders
  sections: { id: number; name: string; role: string; jsx: string; headings: string[]; copy: string[] }[];
}

/** Runs IN THE PAGE. Kept as one self-contained function so it can be shipped to the browser intact. */
function convertInPage(): Converted {
  // ---------- section detection (same rule as src/outline.ts) ----------
  const vis = (el: Element) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.height > 24 && r.width > 200 && cs.display !== "none" && cs.visibility !== "hidden"; };
  const kids = (el: Element) => Array.from(el.children).filter(vis);
  const blocks: Element[] = [];
  const expand = (el: Element, d: number) => {
    for (const c of kids(el)) {
      const h = c.getBoundingClientRect().height;
      const ck = kids(c).filter((x) => x.getBoundingClientRect().height > 40);
      if (d < 10 && h > innerHeight * 1.9 && ck.length >= 1 && c.tagName !== "SECTION") expand(c, d + 1);
      else if (d < 10 && h > innerHeight * 1.9 && c.tagName === "SECTION" && ck.length >= 3 && ck.every((x) => x.getBoundingClientRect().height > 300)) expand(c, d + 1);
      else if (c.getBoundingClientRect().height > 40) blocks.push(c);
    }
  };
  expand(document.body, 0);

  const clean = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim();
  const roleOf = (b: Element, i: number, n: number): string => {
    const w = clean(b.textContent).toLowerCase().slice(0, 1500);
    const tag = b.tagName.toLowerCase();
    const r = b.getBoundingClientRect();
    if (tag === "nav" || tag === "header" || (i === 0 && r.height < 160)) return "Nav";
    if (tag === "footer" || (i === n - 1 && /©|privacy|terms/.test(w))) return "Footer";
    if (i <= 2 && b.querySelector("h1")) return "Hero";
    if (b.querySelectorAll("img,svg").length >= 5 && w.length < 400 && !b.querySelector("h1,h2,h3")) return "Logos";
    if (/\$\d|per month|\/mo\b|pricing/.test(w)) return "Pricing";
    if (/frequently asked|faq/.test(w)) return "Faq";
    if (i >= n - 3 && b.querySelector("a,button") && w.length < 400) return "Cta";
    return "Section";
  };

  // ---------- HTML → JSX ----------
  const RENAME: Record<string, string> = {
    class: "className", for: "htmlFor", tabindex: "tabIndex", readonly: "readOnly", maxlength: "maxLength", minlength: "minLength",
    colspan: "colSpan", rowspan: "rowSpan", crossorigin: "crossOrigin", srcset: "srcSet", autocomplete: "autoComplete",
    autoplay: "autoPlay", playsinline: "playsInline", frameborder: "frameBorder", allowfullscreen: "allowFullScreen",
    enctype: "encType", contenteditable: "contentEditable", spellcheck: "spellCheck", datetime: "dateTime", novalidate: "noValidate",
    inputmode: "inputMode", referrerpolicy: "referrerPolicy", "accept-charset": "acceptCharset", "http-equiv": "httpEquiv",
    "xlink:href": "xlinkHref", "xml:space": "xmlSpace", "xmlns:xlink": "xmlnsXlink", "xml:lang": "xmlLang", viewbox: "viewBox",
    cellpadding: "cellPadding", cellspacing: "cellSpacing", usemap: "useMap", formaction: "formAction", accesskey: "accessKey",
  };
  const BOOL = new Set(["disabled", "checked", "hidden", "required", "selected", "multiple", "autoplay", "muted", "loop", "controls", "playsinline", "open", "readonly", "novalidate", "allowfullscreen", "default", "reversed"]);
  const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
  const NO_WS = new Set(["table", "thead", "tbody", "tfoot", "tr", "colgroup", "select", "datalist", "optgroup", "ul", "ol", "dl", "picture", "video", "audio", "svg", "g", "defs", "head", "html"]);
  const SKIP = new Set(["script", "noscript", "template", "link", "meta", "base"]);
  const camel = (s: string) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const fixUrl = (v: string) => v.replace(/(^|url\(\s*["']?)(assets|fonts)\//g, "$1/$2/");
  const q = (v: string) => JSON.stringify(v);
  // JSX attribute strings take no JS escapes: anything JSON had to escape goes in an expression container.
  const av = (v: string) => { const j = JSON.stringify(v); return j === `"${v}"` ? j : `{${j}}`; };

  const styleObj = (el: Element): string => {
    const st = (el as HTMLElement).style;
    if (!st || !st.length) return "";
    const parts: string[] = [];
    for (let i = 0; i < st.length; i++) {
      const prop = st[i];
      const val = fixUrl(st.getPropertyValue(prop));
      let key: string;
      if (prop.startsWith("--")) key = q(prop);
      else if (prop.startsWith("-ms-")) key = camel(prop.slice(1));
      else if (prop.startsWith("-")) { const k = camel(prop.slice(1)); key = k[0].toUpperCase() + k.slice(1); }
      else key = camel(prop);
      parts.push(`${key}: ${q(val)}`);
    }
    return `{{ ${parts.join(", ")} }}`;
  };

  const attrs = (el: Element): string => {
    const out: string[] = [];
    const tag = el.localName;
    for (const a of Array.from(el.attributes)) {
      const n = a.name;
      if (/^on/i.test(n) || n === "data-atl-sec") continue;
      if (n === "style") { const s = styleObj(el); if (s) out.push(`style=${s}`); continue; }
      let key = RENAME[n] ?? n;
      if (!(n in RENAME) && n.includes("-") && !n.startsWith("data-") && !n.startsWith("aria-")) key = camel(n);
      if (n.includes(":") && !(n in RENAME)) continue; // stray namespaced attrs
      if ((tag === "input" || tag === "select" || tag === "textarea") && n === "value") key = "defaultValue";
      if (tag === "input" && n === "checked") { out.push("defaultChecked"); continue; }
      if (BOOL.has(n)) { out.push(key); continue; }
      let v = a.value;
      if (n === "src" || n === "href" || n === "poster" || n === "xlink:href") v = fixUrl(v);
      if (/^(tabIndex|colSpan|rowSpan|maxLength|minLength|cellPadding|cellSpacing)$/.test(key) && /^-?\d+$/.test(v)) { out.push(`${key}={${v}}`); continue; }
      out.push(`${key}=${av(v)}`);
    }
    return out.length ? " " + out.join(" ") : "";
  };

  let sectionNames = new Map<Element, string>();
  const toJSX = (node: Node, parentTag: string, inSection: boolean): string => {
    if (node.nodeType === 3) {
      const t = node.textContent ?? "";
      if (!t.trim()) return NO_WS.has(parentTag) ? "" : /\n/.test(t) || t.length > 1 ? `{" "}` : `{" "}`;
      return `{${q(t.replace(/\s+/g, " "))}}`;
    }
    if (node.nodeType !== 1) return "";
    const el = node as Element;
    const tag = el.localName;
    if (SKIP.has(tag)) return "";
    if (!inSection && sectionNames.has(el)) return `<${sectionNames.get(el)} />`;
    if (tag === "style") return `<style dangerouslySetInnerHTML={{ __html: ${q(el.textContent ?? "")} }} />`;
    if (tag === "textarea") return `<textarea${attrs(el)} defaultValue={${q(el.textContent ?? "")}} />`;
    const a = attrs(el);
    if (VOID.has(tag)) return `<${tag}${a} />`;
    const inner = Array.from(el.childNodes).map((c) => toJSX(c, tag, inSection)).join("");
    return inner ? `<${tag}${a}>${inner}</${tag}>` : `<${tag}${a} />`;
  };

  // Name sections, then convert.
  const sections = blocks.map((b, i) => {
    const role = roleOf(b, i, blocks.length);
    const name = `S${String(i).padStart(2, "0")}${role}`;
    sectionNames.set(b, name);
    return { b, i, role, name };
  });
  const out = sections.map(({ b, i, role, name }) => ({
    id: i, name, role,
    jsx: toJSX(b, b.parentElement?.localName ?? "div", true),
    headings: Array.from(b.querySelectorAll("h1,h2,h3")).map((h) => clean(h.textContent)).filter(Boolean).slice(0, 4),
    copy: Array.from(b.querySelectorAll("p,a,button,li")).map((e) => clean(e.textContent)).filter((t) => t.length > 2 && t.length < 160).slice(0, 8),
  }));
  const skeleton = Array.from(document.body.childNodes).map((c) => toJSX(c, "body", false)).join("");

  const at = (el: Element) => { const r: Record<string, string> = {}; for (const a of Array.from(el.attributes)) r[a.name] = a.value; return r; };
  return {
    htmlAttrs: at(document.documentElement),
    bodyAttrs: at(document.body),
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "",
    css: Array.from(document.querySelectorAll("style")).filter((s) => !s.closest("body")).map((s) => s.textContent ?? "").join("\n"),
    scripts: Array.from(document.querySelectorAll("script")).filter((s) => !s.src && (s.textContent ?? "").trim()).map((s) => s.textContent ?? ""),
    skeleton,
    sections: out,
  };
}

/** html/body attribute map → JSX props for layout.tsx. */
function propsJSX(a: Record<string, string>): string {
  const out: string[] = [];
  for (const [n, v] of Object.entries(a)) {
    if (n === "class") out.push(`className={${JSON.stringify(v)}}`);
    else if (n === "style") {
      const obj = v.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
        const i = d.indexOf(":"); const k = d.slice(0, i).trim(); const val = d.slice(i + 1).trim();
        return `${k.startsWith("--") ? JSON.stringify(k) : k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}: ${JSON.stringify(val)}`;
      });
      if (obj.length) out.push(`style={{ ${obj.join(", ")} }}`);
    } else if (/^(lang|dir|data-[a-z0-9-]+|aria-[a-z-]+)$/.test(n)) out.push(`${n}={${JSON.stringify(v)}}`); // microdata etc. dropped
  }
  return out.length ? " " + out.join(" ") : "";
}

export async function componentize(adaptedDir: string, workspace: string, tokensPath?: string): Promise<{ sections: number; files: string[] }> {
  const index = path.join(adaptedDir, "index.html");
  if (!existsSync(index)) throw new Error(`no adapted page at ${index}`);

  const browser = await chromium.launch({ headless: true });
  let c: Converted;
  try {
    // JS OFF: convert the markup as shipped, not as some runtime script mutated it.
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto("file://" + path.resolve(index), { waitUntil: "load", timeout: 60_000 });
    await page.waitForTimeout(300);
    // Ship the converter as source text so tsx's __name helpers never reach the page.
    c = await page.evaluate(`(() => { var __name = (f) => f; return (${convertInPage.toString()})(); })()`) as Converted;
  } finally {
    await browser.close();
  }

  // ---- fresh workspace from the template, keeping only what componentized output needs ----
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  for (const f of ["package.json", "postcss.config.js", "tsconfig.json"]) await cp(path.join(TEMPLATE, f), path.join(workspace, f));
  await writeFile(path.join(workspace, "next.config.js"), `/** @type {import('next').NextConfig} */\nmodule.exports = { reactStrictMode: true, output: "export", images: { unoptimized: true } };\n`);
  await writeFile(path.join(workspace, "next-env.d.ts"), `/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n`);
  await writeFile(path.join(workspace, ".gitignore"), "node_modules\n.next\nout\n");

  // Tailwind is scoped to components/custom so it can never restyle the reference's own markup.
  const tokens = tokensPath ?? path.join(path.dirname(adaptedDir), "design-system", "tailwind.tokens.js");
  await mkdir(path.join(workspace, "design"), { recursive: true });
  if (existsSync(tokens)) await cp(tokens, path.join(workspace, "design", "tailwind.tokens.js"));
  else await writeFile(path.join(workspace, "design", "tailwind.tokens.js"), "module.exports = {};\n");
  await writeFile(path.join(workspace, "tailwind.config.js"),
    `/** @type {import('tailwindcss').Config} */\n// Utilities are generated ONLY for components/custom — the reference's own markup is styled by public/reference.css.\nmodule.exports = {\n  content: ["./components/custom/**/*.{ts,tsx}"],\n  corePlugins: { preflight: false },\n  theme: { extend: require("./design/tailwind.tokens.js") },\n  plugins: [],\n};\n`);

  // public/: the reference's CSS untouched, assets, fonts, runtime.
  const pub = path.join(workspace, "public");
  await mkdir(pub, { recursive: true });
  await writeFile(path.join(pub, "reference.css"), c.css);
  for (const d of ["assets", "fonts"]) if (existsSync(path.join(adaptedDir, d))) await cp(path.join(adaptedDir, d), path.join(pub, d), { recursive: true });
  const hasRuntime = c.scripts.length > 0;
  if (hasRuntime) await writeFile(path.join(pub, "atelier-runtime.js"), c.scripts.join("\n;\n"));

  // app/
  const app = path.join(workspace, "app");
  await mkdir(app, { recursive: true });
  await writeFile(path.join(app, "globals.css"), `/* New components (components/custom) use Tailwind on the extracted tokens. No preflight: the reference CSS owns the base. */\n@tailwind components;\n@tailwind utilities;\n`);
  const htmlProps = propsJSX(c.htmlAttrs);
  const bodyProps = propsJSX(c.bodyAttrs);
  await writeFile(path.join(app, "layout.tsx"), `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: ${JSON.stringify(c.title)},
  description: ${JSON.stringify(c.description)},
  openGraph: { title: ${JSON.stringify(c.title)}, description: ${JSON.stringify(c.description)}, type: "website" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html${htmlProps} suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <link rel="stylesheet" href="/reference.css" />
      </head>
      <body${bodyProps}>
        {children}${hasRuntime ? `\n        <script src="/atelier-runtime.js" defer />` : ""}
      </body>
    </html>
  );
}
`);

  const secDir = path.join(workspace, "components", "sections");
  await mkdir(secDir, { recursive: true });
  await mkdir(path.join(workspace, "components", "custom"), { recursive: true });
  await writeFile(path.join(workspace, "components", "custom", "README.md"), "New components go here. Tailwind utilities on the extracted tokens (bg-bg, text-text, font-display…) are generated only for this folder.\n");
  const files: string[] = [];
  for (const s of c.sections) {
    const f = path.join(secDir, `${s.name}.tsx`);
    await writeFile(f, `// @ts-nocheck — machine-converted markup; attribute types are the browser's, not React's.\n// Section ${s.id} (${s.role}) — converted from the reference's real markup. Edit copy in place.\nexport default function ${s.name}() {\n  return (\n    ${s.jsx}\n  );\n}\n`);
    files.push(path.relative(workspace, f));
  }
  const imports = c.sections.map((s) => `import ${s.name} from "@/components/sections/${s.name}";`).join("\n");
  await writeFile(path.join(app, "page.tsx"), `// @ts-nocheck — machine-converted markup.\n// The page skeleton: the reference's own wrappers, with each section as a component.\n// Remove a section by deleting its tag here; reorder by moving it.\n${imports}\n\nexport default function Page() {\n  return (\n    <>\n      ${c.skeleton}\n    </>\n  );\n}\n`);

  // tsconfig path alias
  const ts = JSON.parse(readFileSync(path.join(workspace, "tsconfig.json"), "utf8"));
  ts.compilerOptions = { ...ts.compilerOptions, baseUrl: ".", paths: { "@/*": ["./*"] } };
  await writeFile(path.join(workspace, "tsconfig.json"), JSON.stringify(ts, null, 2) + "\n");

  // The coder's map.
  const md = [`# Sections — top to bottom`, ``, `Each file in components/sections/ is one section of the page, converted from real markup.`, `Edit copy in place (strings are JSX literals like {"Plan your hiring"}). Remove/reorder sections in app/page.tsx.`, `New sections → components/custom/ (Tailwind on the extracted tokens). Never restyle the converted sections with new classes.`, ``];
  for (const s of c.sections) {
    md.push(`## ${s.name}  (${s.role})`);
    if (s.headings.length) md.push(`- headings: ${s.headings.map((h) => JSON.stringify(h.slice(0, 90))).join(" · ")}`);
    if (s.copy.length) md.push(`- copy: ${s.copy.slice(0, 5).map((t) => JSON.stringify(t.slice(0, 70))).join(" · ")}`);
    md.push("");
  }
  await writeFile(path.join(workspace, "SECTIONS.md"), md.join("\n"));

  const nm = ensureSharedDeps();
  await rm(path.join(workspace, "node_modules"), { recursive: true, force: true });
  await symlink(nm, path.join(workspace, "node_modules"), "dir");
  return { sections: c.sections.length, files };
}

async function main() {
  const [adapted, ws] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!adapted || !ws) { console.error("Usage: tsx src/componentize.ts <adapted-dir> <workspace>"); process.exit(1); }
  const r = await componentize(adapted, ws);
  console.log(`✓ ${r.sections} section components → ${ws}/components/sections`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("✗ componentize failed:", e); process.exit(1); });
}
