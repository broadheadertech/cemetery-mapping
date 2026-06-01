import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";

/**
 * Story 5.8: when `ANALYZE=true`, wrap the Next config with
 * `@next/bundle-analyzer` so `npm run analyze` writes a visual treemap
 * to `.next/analyze/client.html`. Disabled by default so production /
 * CI builds aren't slowed down.
 */
const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

/**
 * Build-time identifier used to version the service-worker cache
 * (Story 1.13). Order of preference:
 *
 *   1. `NEXT_PUBLIC_BUILD_ID`  — explicitly set in CI / Vercel.
 *   2. `VERCEL_GIT_COMMIT_SHA` — automatically set by Vercel builds.
 *   3. `GITHUB_SHA`            — set by GitHub Actions.
 *   4. Falls back to the package version + `local-dev`.
 *
 * Exposed to the client bundle so the SW build script (`scripts/build-sw.mjs`)
 * and any client-side debug surfaces can read the same string.
 */
const BUILD_ID =
  process.env.NEXT_PUBLIC_BUILD_ID ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  "local-dev";

const nextConfig: NextConfig = {
  // Strict mode helps catch issues during development.
  reactStrictMode: true,

  // The `noindex,nofollow` posture for Phase 1 + 2 is set per-route via
  // metadata exports in the (staff) and (public) layouts. The Phase 3
  // customer portal landing page will explicitly opt in to indexing.

  // PWA registration is set up via a hand-rolled service worker
  // (src/sw.ts) registered only in production builds — see Story 1.13.
  // No `next-pwa` dependency per the architecture decision.

  // Image domains: ID-scan files and receipt photos live in Convex File
  // Storage and are served via signed URLs from `*.convex.cloud` and
  // `*.convex.site`. Add explicit allow-listing once Convex's signed-URL
  // domain pattern is verified at integration time.

  env: {
    NEXT_PUBLIC_BUILD_ID: BUILD_ID,
  },

  // Story 7.5 — the ceremony calendar superseded the interments-only
  // calendar surface. Bookmarks + emailed deep-links to the original
  // /interments/calendar location land at the new combined view via a
  // 308 (permanent, preserves the HTTP method) redirect. We keep the
  // /interments/[intermentId] detail and /interments list pages intact
  // so Story 6.8 (memorial plaque PDF) deep-links still resolve.
  async redirects() {
    return [
      {
        source: "/interments/calendar",
        destination: "/ceremonies/calendar",
        permanent: true,
      },
    ];
  },

  // Long-lived caching for the manifest + PWA icons. The service worker
  // itself MUST NOT be aggressively cached by the CDN — fresh `sw.js`
  // delivery is what kicks off the cache eviction on new deploys. The
  // headers below leave `sw.js` on the default (no Cache-Control) so
  // the browser only relies on the HTTP cache for a short window.
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=3600" },
          { key: "Content-Type", value: "application/manifest+json" },
        ],
      },
    ];
  },
};

export default withBundleAnalyzer(nextConfig);
