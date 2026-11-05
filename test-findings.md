# Step-3 Test Findings — Trace/Vector output vs real Linear

Everything learned from comparing the first generated outputs against linear.app.
Recording so none of it lives only in chat. Grouped by: cheap builder fixes (do now),
and deferred workstreams (documented, scheduled later). Ranked by impact within each.

---

## What passed

- Both outputs (Trace, Vector) beat generic AI output — no purple, no sparkles, no
  emoji-as-UI, real structure, disciplined palettes. Core bet (rails beat no rails) holds.
- Trace inherited Linear's tokens faithfully; Vector drifted (invented a blue accent +
  faint gradient not in Linear's tokens). Palette fidelity needs enforcing — see below.

---

## CHEAP BUILDER FIXES (do now — builder-rule changes, no new capability)

1. **Eyebrow labels are FABRICATED — ban them.** The output puts a small mono label above
   almost every headline. Linear does NOT do this (its section labels are just headings;
   the mono text it uses is figure/index captioning inside content, not eyebrows). Remove
   eyebrow/kicker labels everywhere. Correction: earlier notes wrongly called these
   "faithful to Linear." They are not.

2. **Layout is monotonous — enforce variety.** Nearly every section is the same skeleton
   (headline → subhead → content-block-right). Rule: no section repeats the previous
   section's layout; ≥3 distinct layout types across the page. Types: text-left/visual-right,
   visual-left/text-right, full-bleed visual, full-width row of 3+ with captions,
   centered-heading/asymmetric-below.

3. **Editorial two-column header.** Linear often puts the heading LEFT and its supporting
   paragraph RIGHT (a split header row), not heading-stacked-over-subhead. Add this as a
   header option and use it sometimes.

4. **Subheadlines uniform — make optional + vary placement.** Every headline has a subhead.
   Make subheads optional (≥2 sections with none), and vary position (sometimes beneath,
   sometimes beside).

5. **Narrow centered column — use full width.** Output is trapped mid-screen with dead
   space both sides (a classic AI tell). Use full horizontal width; visuals/backgrounds
   may go edge-to-edge.

6. **Missing bands — add them:**
   - Logo marquee (via svgl for tech categories; real marks, never fabricated customer
     proof).
   - Testimonial cards — realistic name + title + company + specific quote. Never "Sarah P."
     with a vague line. Omit rather than fake a weak one. This is also the ONE place to use
     the extracted accent color, sparingly (as Linear does).
   - Changelog band (optional) — dated entries, signals a living product.

7. **Palette fidelity — enforce.** Vector invented a blue accent + gradient not in tokens.
   Builder must not introduce colors/gradients absent from tokens.json. (Also a job for the
   critic + hooks in step 4.)

8. **No emojis / no invented glyphs / no Lucide-Heroicons default.** Self-generated emojis
   render buggy and are a vibe-coded tell. Use a non-default icon library per category
   (Streamline primary pending license check for third-party redistribution; Phosphor free
   fallback). See category-map-schema.md.

9. **Two-tone headline.** Linear writes the first sentence white and the remainder gray in
   some headings. Small but signature; add as an option.

---

## DEFERRED WORKSTREAMS (documented now, built as their own later steps — ranked by impact)

1. **Bespoke visuals (biggest gap).** Linear's pages are carried by custom, unique visuals,
   NOT icon-cards: isometric line-art diagrams (thin monochrome strokes, subtle dotted
   detail, small FIG labels), syntax-highlighted code diffs (functional red/green), and a
   dense dot-density data-viz. Replace generic icon-card grids with generated bespoke SVG.
   This is the difference between "designed" and "templated." NOT a prompt tweak — needs
   real per-visual specs or a visual-template system. HARD, highest payoff.

2. **Hero treatment.** Large full-width product visual placed BELOW the headline (not a
   small box beside it), with edges FADED into the background (no hard border). Dense
   realistic UI inside.

3. **Full-width dense product screenshots** as each feature section's centerpiece — each one
   DIFFERENT (different real screens), sharing a system but never identical. Consistency in
   the system, variety in the content.

4. **Component extraction (appearance yes, behavior regenerated).** Extend the extractor to
   capture a signature component's appearance (HTML/CSS/SVG) as a reusable snippet; builder
   regenerates behavior fresh and FUNCTIONAL. Never lift compiled JS. Enables things like an
   editable diff or a working command palette.

5. **Category-appropriate richness — not every niche has product windows or diagrams.** A
   dev tool has product UI + diagrams; a skincare brand has photography + editorial type; a
   law firm has typographic authority. The KIND of rich visual is category-dependent and
   comes from the category map. Do NOT hardcode Linear's visual types as universal.

6. **Clean gradient background.** Linear uses a subtle, tasteful background gradient (esp.
   hero). Permitted (it's restrained, not decorative motion). Add where appropriate.

7. **Populate the category map.** The schema exists (category-map-schema.md) but no entries
   do. Build at least the dev-tool entry to keep testing, then expand.

---

## Interaction rule (universal, strict — applies to all of the above)

Permitted: (1) functional product behavior in a realistic product-UI surface (editable
diff, working command palette, clickable window rows); (2) subtle functional motion —
eased collapse/expand, gentle fade-in, clean gradient. BANNED everywhere: hover-lift,
float, bounce, scroll-triggered slide-in, wiggle, any decorative motion on marketing
elements. (The kind of motion the 500-site study defines as vibe-coded.)

---

## Standing principle: kill ambiguity

Vague design guidance ("vary the layout") makes the builder fall back to its bland generic
default. Convert every taste-judgment into a checkable rule ("no section repeats the
previous layout; ≥3 layout types"). The more taste becomes rules, the more reliable the
output. Apply this when writing every builder guideline.
