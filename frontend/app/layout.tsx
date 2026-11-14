import type { Metadata } from "next";
import { DM_Serif_Display, IBM_Plex_Mono, IBM_Plex_Sans, Instrument_Serif, Inter } from "next/font/google";
import "./tailwind.css";
import "./globals.css";

// PRISM type system (prism-tokens.css): Instrument Serif / IBM Plex Sans / IBM Plex Mono.
const display = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--p-font-display-loaded", display: "swap" });
const body = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--p-font-body-loaded", display: "swap" });
const data = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--p-font-data-loaded", display: "swap" });
// Classic observatory (/classic) keeps its original faces.
const classicDisplay = DM_Serif_Display({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-classic-display", display: "swap" });
const classicBody = Inter({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-classic-body", display: "swap" });

export const metadata: Metadata = {
  title: "PRISM · SPHEREx Time Machine",
  description: "Cada cuadro de SPHEREx es de un color distinto. PRISM separa color y movimiento con observaciones reales de SPHEREx (NASA/IPAC IRSA).",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const fonts = [display, body, data, classicDisplay, classicBody].map((f) => f.variable).join(" ");
  return (
    <html lang="es" className={`h-full ${fonts}`}>
      <body
        style={{
          minHeight: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: "var(--bg)",
          color: "var(--ink)",
          margin: 0,
        }}
      >
        {children}
      </body>
    </html>
  );
}
