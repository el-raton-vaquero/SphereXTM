import type { Metadata, Viewport } from "next";
import { Figtree, Fraunces, JetBrains_Mono } from "next/font/google";
import HtmlLang from "../components/site/HtmlLang";
import { en } from "../lib/i18n/en";
import "./prism-tokens.css";
import "./globals.css";
import "./site.css";

// StarChord type system (prism-tokens.css): Fraunces (display, titles only) / Figtree (UI, body) /
// JetBrains Mono (data). Each loads into a --p-font-*-loaded variable consumed by the tokens.
const display = Fraunces({ subsets: ["latin"], axes: ["opsz"], variable: "--p-font-display-loaded", display: "swap" });
const body = Figtree({ subsets: ["latin", "latin-ext"], variable: "--p-font-body-loaded", display: "swap" });
const data = JetBrains_Mono({ subsets: ["latin", "greek"], variable: "--p-font-data-loaded", display: "swap" });

export const metadata: Metadata = {
  title: en.common.metaTitle,
  description: en.common.metaDescription,
  applicationName: en.common.brand,
};

export const viewport: Viewport = {
  themeColor: "#0b0a09",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const fonts = [display, body, data].map((f) => f.variable).join(" ");
  return (
    <html lang="en" className={fonts}>
      <body>
        <HtmlLang />
        {children}
      </body>
    </html>
  );
}
