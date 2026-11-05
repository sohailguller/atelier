# Atelier

A CLI that takes a one-line prompt like "build a prediction market app" and builds a website that actually looks designed, instead of the generic AI-website look (purple gradients, sparkle emojis, mismatched corner radii, "Revolutionize your workflow" hero copy). The list of what it avoids comes from Aftermark AI's [Vibe Coded Website Report](https://docs.google.com/document/d/e/2PACX-1vTnLEdwSF1HPkuwOkuNneXGCaQAw5N2nnRf7cX_B4zuBLf2VTMi4Yh59gqS-eeVqYpa11iFQYmRjVBW/pub), their analysis of 500+ sites. Their research is what Atelier's checks are built on (copy in [`vibe-coded-patterns.md`](vibe-coded-patterns.md)).

The trick is not letting the model make up the design. It:

1. routes the prompt to a category and picks 2–3 real reference sites for it (prediction market → Polymarket, Kalshi)
2. extracts a design system from those sites (colors, type, spacing, radii)
3. builds an original site that sticks to those tokens. It borrows the visual grammar, never the structure.
4. audits its own output against the checklist before it's done

It runs as a scout → designer → coder pipeline. `build-guide.md` goes into the details.

```
npm install
npm link
atelier                                   # interactive session
atelier --print "build a prediction market app"   # one-shot
```

Generated sites and the reference material it pulls are kept out of the repo.

This lived on my laptop for a while before I put it on GitHub.
