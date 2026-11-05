/** @type {import('tailwindcss').Config} */
// The single source of truth for every design value is `./design/tailwind.tokens.js`,
// which the atelier extractor produced from the reference site's real computed styles.
// It is merged via `theme.extend`, so the token-named utilities (bg-bg, text-text,
// bg-accent, rounded-full, text-h1, p-16, shadow-md, …) resolve to extracted values.
// Build ONLY from those utilities — do not hand-write raw hex, px, or off-scale classes.
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: require("./design/tailwind.tokens.js"),
  },
  plugins: [],
};
