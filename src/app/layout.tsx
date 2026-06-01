import type { Metadata } from "next";
import { Cormorant_Garamond, Manrope, JetBrains_Mono } from "next/font/google";
import { ConvexAuthNextjsServerProvider } from "@convex-dev/auth/nextjs/server";
import { ConvexClientProvider } from "./ConvexClientProvider";
import "./globals.css";

/**
 * Apostle Paul Memorial Park type system (brand guide §IV Typography):
 *
 *   - Cormorant Garamond — display serif. Wordmark, headings, ceremonial
 *     copy. Always set wide, never bold, never below 16px.
 *   - Manrope — humanist sans. Wayfinding, body copy, operational text.
 *   - JetBrains Mono — eyebrow labels, tabular numerics, codes.
 *
 * Each font is exposed as a CSS custom property so Tailwind's
 * `font-display` / `font-sans` / `font-mono` resolves cleanly and the
 * SSR-time fallback chain (declared in globals.css) is overridden once
 * next/font ships the self-hosted face.
 */
const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  variable: "--font-cormorant",
  weight: ["300", "400", "500", "600"],
  display: "swap",
});

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-manrope",
  weight: ["300", "400", "500", "600"],
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  weight: ["300", "400"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Apostle Paul Memorial Park",
  description:
    "Apostle Paul Memorial Park — Cases Land Inc. cemetery management system.",
  // Phase 1 + 2: auth-walled application, no SEO. The Phase 3 customer
  // portal landing page (when it ships) will override these metadata
  // to be indexable.
  robots: {
    index: false,
    follow: false,
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <ConvexAuthNextjsServerProvider>
      <html
        lang="en-PH"
        className={`${cormorant.variable} ${manrope.variable} ${jetbrains.variable}`}
      >
        <body className="font-sans antialiased">
          <ConvexClientProvider>{children}</ConvexClientProvider>
        </body>
      </html>
    </ConvexAuthNextjsServerProvider>
  );
}
