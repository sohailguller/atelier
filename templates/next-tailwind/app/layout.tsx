import type { Metadata } from "next";
import "./globals.css";

// Technical fundamentals shipped by construction so the "missing meta tags" vibe-coded
// tell can never appear. The builder MUST replace title/description (and ideally add an
// openGraph image) with the real product's specifics — never leave these defaults.
export const metadata: Metadata = {
  title: "Untitled Product",
  description: "Replace this with a specific, grounded description of the product.",
  openGraph: {
    title: "Untitled Product",
    description: "Replace this with a specific, grounded description of the product.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
