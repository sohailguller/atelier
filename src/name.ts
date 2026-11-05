// PRODUCT NAMING + REAL-COMPANY COLLISION GUARD.
//
// The adapted page stamps ONE invented product name across everything (nav, wordmark, footer,
// in-page mentions), so if that name belongs to a REAL company the build ships a clone of one
// premium site branded as a different real company — a worse fabrication than the reference
// brand leak that already hard-fails the build. Asking the model for "an invented name" is not
// enough: it reproducibly returned "Uptrace" (a real observability product) for an uptime
// monitor and "Flagsmith" (a real feature-flag product) for a flags tool.
//
// So: generate a BATCH, then screen every candidate two independent ways and take the first
// survivor. Neither screen alone is sufficient (measured):
//   - domain probe    — flagsmith.com serves a live product page (caught); uptrace.com/.io/.ai
//                       time out and only uptrace.dev answers (fragile alone).
//   - model knowledge — knows both, but cannot know a company launched after its cutoff.
// Together they cover both failure modes. The pure core below is offline-testable so the rule
// can be probed in isolation before paying for a build (`npx tsx src/name.ts <names...>`).
import { readFileSync, existsSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";

const MAP_PATH = "./category-map.json";
const TLDS = ["com", "io", "ai", "dev"];
const PROBE_TIMEOUT_MS = 6_000;
const MAX_BODY = 200_000;
const CANDIDATES_PER_ROUND = 8;
const MAX_ROUNDS = 2;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** A screen's answer. `inconclusive` (a timeout, an unparseable response) must NEVER reject on
 *  its own — the other screen is the cover. Only `collision` rejects. */
export type Verdict = "collision" | "clear" | "inconclusive";

export interface NameVerdict {
  name: string;
  domain: Verdict;
  model: Verdict;
  keep: boolean;
  reason: string; // human-readable, printed on rejection so the guard is never silent
}

// ---------------------------------------------------------------------------
// PURE CORE — no network, no model. Unit-tested by test/name.test.ts.
// ---------------------------------------------------------------------------

/** "Pulse Grid" -> "pulsegrid". The form a domain would take. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Domain-parking / for-sale pages. These mean the name is AVAILABLE, not taken by a company —
 *  signalfy.com serves "SignalFy.com is for sale | HugeDomains" and must NOT count as a collision. */
export const PARKED_RE =
  /(hugedomains|afternic|sedo|dan\.com|namecheap|godaddy|domain broker|buy this domain|is for sale|domain for sale|this domain is|parked (free )?(at|by)|undeveloped\.com|squadhelp|brandbucket)/i;

/** Extract the <title> from a raw HTML string ("" when absent). */
export function titleOf(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

/** Extract og:site_name / og:title (order-independent attributes) — a company names itself here
 *  even when <title> is page-specific. */
export function ogNameOf(html: string): string {
  for (const prop of ["og:site_name", "og:title", "application-name"]) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`,
      "i"
    );
    const tag = re.exec(html)?.[0];
    if (!tag) continue;
    const c = /content=["']([^"']*)["']/i.exec(tag)?.[1];
    if (c && c.trim()) return c.replace(/\s+/g, " ").trim();
  }
  return "";
}

/** Web-server / host default pages. Not a company either. */
export const SERVER_DEFAULT_RE =
  /^(index of \/|welcome to nginx|apache2? (ubuntu )?default page|default web site page|it works!?|test page for|web server default page)/i;

/** Is this response a domain-parking page or an empty stub rather than a real site?
 *  Measured shapes: HugeDomains parking (title says "is for sale"); quantiva.com returned a
 *  114-byte body with an empty title. Neither is a company.
 *  NOTE: deliberately NO "body is short" rule. meterly.ai is a real product whose whole page is
 *  1.5KB, and a length floor silently let that collision through. An empty stub is caught by the
 *  missing <title>; everything else is decided by whether the site NAMES itself the candidate. */
export function isParkedOrStub(title: string, html: string): boolean {
  if (PARKED_RE.test(title) || PARKED_RE.test(html.slice(0, 4000))) return true;
  if (SERVER_DEFAULT_RE.test(title)) return true;
  if (!title) return true; // no <title> at all = stub/placeholder, not a shipped site
  if (html.length < 512) return true; // degenerate/empty response
  return false;
}

/**
 * Classify one fetched response for slug `slug`.
 * A collision requires a LIVE, non-parked, substantive site that actually NAMES itself the
 * candidate (title / og:site_name) — a random 200 on a squatted domain is not a company.
 */
export function looksLikeCompany(
  slug: string,
  status: number,
  html: string
): { verdict: Verdict; title: string } {
  const title = titleOf(html);
  if (status === 404 || status === 410) return { verdict: "clear", title };
  if (status < 200 || status >= 400) return { verdict: "inconclusive", title };
  if (isParkedOrStub(title, html)) return { verdict: "clear", title };
  const names = (title + " " + ogNameOf(html)).toLowerCase().replace(/[^a-z0-9]+/g, "");
  return { verdict: names.includes(slug) ? "collision" : "clear", title };
}

/**
 * First candidate — in the model's own preference order — that no screen flags as a collision.
 * Returns null when every candidate collides (caller runs another round / falls back).
 */
export function pickName(verdicts: NameVerdict[]): NameVerdict | null {
  return verdicts.find((v) => v.keep) ?? null;
}

/** Build the per-candidate verdict rows from the two screens. */
export function combine(
  candidates: string[],
  domain: Map<string, { verdict: Verdict; where: string }>,
  knownToModel: Set<string>
): NameVerdict[] {
  return candidates.map((name) => {
    const d = domain.get(name) ?? { verdict: "inconclusive" as Verdict, where: "" };
    const m: Verdict = knownToModel.has(name.toLowerCase()) ? "collision" : "clear";
    const keep = d.verdict !== "collision" && m !== "collision";
    const reason =
      d.verdict === "collision"
        ? `${d.where} is a live product site`
        : m === "collision"
          ? "the model knows it as an existing company/product"
          : d.verdict === "inconclusive"
            ? "no collision found (domain probe inconclusive)"
            : "no collision found";
    return { name, domain: d.verdict, model: m, keep, reason };
  });
}

/** Tolerant JSON-array extraction from a model response (fences / stray prose). Mirrors the
 *  object-flavoured extractor already proven in swap.ts. */
export function extractJsonArray(out: string): string[] | null {
  const s = out.indexOf("["), e = out.lastIndexOf("]");
  if (s === -1 || e <= s) return null;
  try {
    const a = JSON.parse(out.slice(s, e + 1));
    return Array.isArray(a) ? a.filter((x) => typeof x === "string") : null;
  } catch {
    return null;
  }
}

/** A generated name must be a short, plain-ASCII 1–2 word brand. Rejects taglines/sentences. */
export function isWellFormed(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9 .&'-]{1,29}$/.test(name) && name.trim().split(/\s+/).length <= 2;
}

// ---------------------------------------------------------------------------
// IO LAYER — network + model.
// ---------------------------------------------------------------------------

/** Fetch one URL and classify it. DNS failure = the name is free; abort/timeout = inconclusive. */
async function probeOne(slug: string, tld: string): Promise<{ verdict: Verdict; where: string }> {
  const url = `https://${slug}.${tld}/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "text/html,*/*" },
    });
    const html = (await res.text()).slice(0, MAX_BODY);
    const { verdict } = looksLikeCompany(slug, res.status, html);
    return { verdict, where: `${slug}.${tld}` };
  } catch (e) {
    // AbortError = timed out (unknown). Anything else (ENOTFOUND/DNS/TLS) = nothing is served.
    const aborted = (e as Error).name === "AbortError";
    return { verdict: aborted ? "inconclusive" : "clear", where: `${slug}.${tld}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe a name across the common product TLDs in parallel. Any single collision decides it. */
export async function probeDomains(name: string): Promise<{ verdict: Verdict; where: string }> {
  const slug = slugify(name);
  if (!slug) return { verdict: "inconclusive", where: "" };
  const results = await Promise.all(TLDS.map((t) => probeOne(slug, t)));
  const hit = results.find((r) => r.verdict === "collision");
  if (hit) return hit;
  if (results.every((r) => r.verdict === "inconclusive")) return { verdict: "inconclusive", where: slug };
  return { verdict: "clear", where: slug };
}

async function ask(prompt: string, model: string, systemPrompt: string): Promise<string> {
  const q = query({ prompt, options: { model, allowedTools: [], settingSources: [], systemPrompt } });
  let out = "";
  for await (const m of q) if (m.type === "result" && m.subtype === "success") out = m.result;
  return out;
}

/** ONE batched call: which of these names does the model recognise as real? Lowercased set. */
export async function screenWithModel(candidates: string[], model: string): Promise<Set<string>> {
  if (!candidates.length) return new Set();
  try {
    const out = await ask(
      `Which of these names are the name of an EXISTING real company, product, service, or well-known open-source project (including ones that are similar enough to be confused with it)? Be strict — if you have any recollection of the name being used commercially, include it.\n\n${JSON.stringify(candidates)}\n\nReturn ONLY a JSON array of the colliding names, exactly as spelled above. Return [] if none collide.`,
      model,
      "You output only the requested JSON array, nothing else."
    );
    const arr = extractJsonArray(out);
    if (!arr) return new Set(); // unparseable = inconclusive, never a blanket rejection
    return new Set(arr.map((s) => s.toLowerCase().trim()));
  } catch {
    return new Set();
  }
}

/** Reference brands already in the category map — naming the clone after the site it cloned is
 *  the worst possible collision, so they are named explicitly in the generation prompt. */
export function referenceBrands(mapPath = MAP_PATH): string[] {
  if (!existsSync(mapPath)) return [];
  try {
    const map: Record<string, { references?: string[] }> = JSON.parse(readFileSync(mapPath, "utf8"));
    const brands = new Set<string>();
    for (const c of Object.values(map))
      for (const r of c.references ?? []) {
        const host = r.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].split(".")[0];
        if (host) brands.add(host.charAt(0).toUpperCase() + host.slice(1));
      }
    return [...brands];
  } catch {
    return [];
  }
}

/** Ask for a batch of candidates in one call, most-preferred first. */
async function generateCandidates(
  productPrompt: string,
  model: string,
  n: number,
  avoid: string[]
): Promise<string[]> {
  const out = await ask(
    `Invent ${n} short, plausible product/brand names for this product: "${productPrompt}".

Rules:
- Each name is 1-2 words, plain ASCII, no tagline, no quotes, no domain suffix.
- CRITICAL: each must be INVENTED. It must NOT be the name of any existing company, product, service, or open-source project — not even a small or niche one. Do not use these or anything close to them: ${JSON.stringify(avoid)}.
- Order them best-first (the first is your strongest recommendation).

Return ONLY a JSON array of strings.`,
    model,
    "You output only the requested JSON array, nothing else."
  );
  const arr = extractJsonArray(out) ?? [];
  const seen = new Set<string>();
  return arr
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => isWellFormed(s))
    .filter((s) => (seen.has(s.toLowerCase()) ? false : (seen.add(s.toLowerCase()), true)));
}

/** Screen a batch: both screens in parallel, one verdict row per candidate. */
export async function screenCandidates(candidates: string[], model: string): Promise<NameVerdict[]> {
  const [domains, known] = await Promise.all([
    Promise.all(candidates.map(async (c) => [c, await probeDomains(c)] as const)),
    screenWithModel(candidates, model),
  ]);
  return combine(candidates, new Map(domains), known);
}

const FALLBACK_SUFFIXES = ["Labs", "Works", "Base", "Layer", "Stack"];

/**
 * ONE verified product name for the whole page. Generates a batch, screens it, and returns the
 * first survivor; retries once with the collisions named, then falls back to a deterministic
 * suffixed mutation (re-probed). There is deliberately NO hardcoded literal fallback — the old
 * ones ("Northstar", "Northbeam") are themselves real companies.
 */
export async function deriveProductName(
  productPrompt: string,
  model: string,
  opts: { quiet?: boolean } = {}
): Promise<string> {
  const log = (s: string) => { if (!opts.quiet) console.log(s); };
  const avoid = referenceBrands();
  const rejected: string[] = [];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const candidates = await generateCandidates(
      productPrompt,
      model,
      CANDIDATES_PER_ROUND,
      [...avoid, ...rejected]
    );
    if (!candidates.length) continue;
    const verdicts = await screenCandidates(candidates, model);
    for (const v of verdicts.filter((v) => !v.keep)) {
      rejected.push(v.name);
      log(`  ⚠ name: "${v.name}" rejected — ${v.reason}`);
    }
    const picked = pickName(verdicts);
    if (picked) return picked.name;
    log(`  ⚠ name: all ${candidates.length} candidates collided (round ${round}/${MAX_ROUNDS})`);
  }

  // Every candidate collided. Mutate the least-bad one deterministically rather than shipping a
  // real company's name, and verify the mutation is itself free.
  const base = (rejected[0] ?? "Atlas").split(/\s+/)[0];
  for (const suffix of FALLBACK_SUFFIXES) {
    const candidate = `${base} ${suffix}`;
    const d = await probeDomains(candidate);
    if (d.verdict !== "collision") {
      log(`  ⚠ name: fell back to "${candidate}" after ${rejected.length} collisions`);
      return candidate;
    }
  }
  const last = `${base} ${FALLBACK_SUFFIXES[0]}`;
  log(`  ⚠ name: fell back to "${last}" (unverified — every probe collided)`);
  return last;
}

// ---------------------------------------------------------------------------
// PROBE CLI — screen names in isolation before paying for a build.
//   npx tsx src/name.ts "Uptrace" "Flagsmith" "Signalfy" "Pulsegrid"
//   npx tsx src/name.ts --for "an uptime monitoring tool"
// ---------------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  let model = "claude-opus-4-8";
  let forPrompt = "";
  const names: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") model = argv[++i];
    else if (argv[i] === "--for") forPrompt = argv[++i];
    else names.push(argv[i]);
  }

  if (forPrompt) {
    console.log(`\n▸ Deriving a product name for: ${forPrompt}\n`);
    const name = await deriveProductName(forPrompt, model);
    console.log(`\n✓ product name: ${name}\n`);
    return;
  }
  if (!names.length) {
    console.error('Usage: tsx src/name.ts "<Name>" ["<Name>" ...]  |  tsx src/name.ts --for "<product prompt>"');
    process.exit(1);
  }

  console.log(`\n▸ Screening ${names.length} name(s)\n`);
  const verdicts = await screenCandidates(names, model);
  for (const v of verdicts) {
    const mark = v.keep ? "✓ keep  " : "✗ reject";
    console.log(`  ${mark} ${v.name.padEnd(14)} domain:${v.domain.padEnd(12)} model:${v.model.padEnd(12)} ${v.reason}`);
  }
  console.log("");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("\n✗ name screening failed:", e); process.exit(1); });
}
