// @ts-check
/**
 * Bundles `src/sw.ts` → `public/sw.js` via esbuild (Story 1.13).
 *
 * Why a standalone build step:
 *   - Next.js's app-router pipeline does not bundle a top-level `sw.ts`
 *     into a root-scope `/sw.js`. Custom bundling is the simplest path
 *     and avoids the `next-pwa` dependency the architecture vetoed.
 *   - esbuild is already a transitive dep (Next.js / Convex use it); we
 *     pin it explicitly in `devDependencies` so the script is stable.
 *
 * The build is invoked from `npm run build` AFTER `next build`. Running
 * it in dev mode is unnecessary — `registerServiceWorker()` is a no-op
 * outside production. Running it manually (`npm run build:sw`) is fine
 * for local smoke-tests of the SW logic.
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const buildId =
  process.env.NEXT_PUBLIC_BUILD_ID ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  `local-${Date.now()}`;

const entryPoint = path.join(projectRoot, "src", "sw.ts");
const outFile = path.join(projectRoot, "public", "sw.js");

await build({
  entryPoints: [entryPoint],
  outfile: outFile,
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2020"],
  platform: "browser",
  // Replace the placeholder identifier at build time so the bundled SW
  // captures the deploy's build ID. Cache version derives from this →
  // a new deploy evicts the old cache.
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  logLevel: "info",
});

console.log(`[build-sw] wrote ${path.relative(projectRoot, outFile)} (buildId=${buildId})`);
