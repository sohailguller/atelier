# Category Map Schema — the keystone

The category map is no longer just "category → reference sites." It carries the full
visual + interaction vocabulary per category, so the builder reaches for the right kind
of richness instead of guessing (guessing produces emojis, Lucide icons, and product
windows on a bakery site).

## The schema (fields per category)

```jsonc
{
  "dev-tool": {
    "references": ["linear.app", "vercel.com"],       // sites to extract tokens from
    "visualVocabulary": ["product-ui", "line-art-diagram", "code-diff", "data-viz"],
                                                        // what KIND of rich visual this
                                                        // category uses. Others: "photography",
                                                        // "editorial-type", "credentials", "none"
    "iconLibrary": { "primary": "streamline", "fallback": "phosphor" },
                                                        // primary needs license check for
                                                        // third-party redistribution; phosphor
                                                        // is free/MIT fallback. NEVER lucide/
                                                        // heroicons (the AI-default tell), NEVER emoji
    "logoSource": "svgl",                               // brand-logo library for marquees.
                                                        // real trademarks — use as recognizable
                                                        // marks, never as fabricated customer proof.
                                                        // null for categories that don't use logos
    "interactions": ["functional-product", "subtle-fade", "smooth-collapse"],
                                                        // PERMITTED interaction types only.
                                                        // functional product behavior + restrained
                                                        // motion. Banned everywhere: hover-lift,
                                                        // float, bounce, scroll-slide-in, any
                                                        // decorative motion
    "accent": "from-tokens"                             // accent color comes from extraction;
                                                        // used sparingly (e.g. testimonials only)
  },

  "skincare-dtc": {
    "references": ["aesop.com", "glossier.com"],
    "visualVocabulary": ["photography", "editorial-type"],   // NO product-ui, NO diagrams
    "iconLibrary": { "primary": "phosphor", "fallback": "phosphor" }, // minimal/thin, or none
    "logoSource": null,                                 // no tech-logo marquee
    "interactions": ["subtle-fade"],                    // even more restrained
    "accent": "from-tokens"
  }
}
```

## Live data + fields moved here from the global builder (step-3 split)

The first populated entry now lives in **`category-map.json`** (dev-tool: linear.app, vercel.com,
railway.app). Three fields were added to hold content types that were wrongly hardcoded into the
GLOBAL builder rules and moved out during the step-3 split (they are dev-tool *content types*, not
universal aesthetics — see build-guide §7):

- `productSurfaces` — the functional product-UI surfaces this category may render (e.g.
  `editable-diff`, `command-palette`, `clickable-window-rows`). Behavior is regenerated functional,
  never lifted (see the component-reuse rule below).
- `compositionPatterns` — signature layout treatments (e.g. `editorial-split-header` = heading LEFT,
  supporting paragraph RIGHT).
- `contentBands` — category-appropriate bands beyond a feature list (e.g. `logo-marquee`,
  `changelog`). Testimonials are universal (they live in the global builder rules); these are the
  category-specific ones.

Removed entirely rather than moved (they described how one site *looks*, not a content type):
two-tone headline, monochrome-default. Palette fidelity already yields monochrome when the tokens
are monochrome and colour when they are not — the global builder must not prescribe a look.

These fields are data-at-rest until the router + builder consume the map (build-guide §9 step 5).
Until then the global builder applies universal rules only.

## The two-layer principle this encodes

- **Universal premium rules** (always on, in the builder): full-width usage, layout
  variety, no decorative motion, restrained accent, bespoke-not-generic visuals, no
  emojis, no eyebrow labels, no Lucide/Heroicons.
- **Category-specific vocabulary** (from this map): which references, which visual KINDS,
  which icon/logo libraries, which interactions. Linear's product-windows/diagrams are
  ONE category's answer, not universal. A category with "visualVocabulary: none" gets no
  mockups or diagrams at all.

## Interaction rule (universal, strict)

Permitted: (1) functional product behavior inside a realistic product-UI surface (e.g.
an editable diff, a working command palette, clickable window rows); (2) subtle functional
motion — smooth eased collapse/expand, gentle fade-in, clean gradient backgrounds.
Banned everywhere: hover-lift, float, bounce, scroll-triggered slide-ins, wiggle, any
decorative motion on marketing elements. (Directly from the 500-site study.)

## Component reuse rule (appearance yes, behavior regenerated)

The extractor may capture a signature component's APPEARANCE (HTML structure + CSS + SVG)
as a reusable snippet. The builder regenerates its BEHAVIOR fresh with simple functional
code. Never lift the reference's compiled/bundled JS — that's copying app code, not
extracting a design system. Extract the look; rebuild the behavior; keep behavior
functional, never decorative.
