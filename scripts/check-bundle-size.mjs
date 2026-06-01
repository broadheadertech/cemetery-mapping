// @ts-check
/**
 * Bundle-size gate (Story 5.8, NFR-P6).
 *
 * Parses Next.js's build manifests after `next build` and asserts that
 * each route's initial-JS bundle, **gzipped**, stays under the
 * NFR-P6 threshold of 250KB. The threshold defends the architecture's
 * "Leaflet lazy-loaded post-Phase-1; PDF library never client-side"
 * rule: a stray top-level `import "leaflet"` blows past 250KB and trips
 * this gate.
 *
 * What "initial JS" means for the App Router:
 *   - Each entry under `.next/app-build-manifest.json` `pages` lists the
 *     `static/chunks/*.js` files the browser must download before that
 *     route's interactive code runs. We sum the on-disk gzipped size of
 *     those chunks per route.
 *   - Shared baseline chunks (webpack runtime, framework, main-app, etc.)
 *     are deduplicated across routes — they are loaded once, so they
 *     count toward each route's initial JS but only contribute the cost
 *     of their single download. The gzipped-sum-per-route number is the
 *     "what does this user wait for to make THIS route interactive" cost,
 *     which is exactly the budget NFR-P6 caps.
 *   - The static `polyfills.js` lives outside `app-build-manifest.json`
 *     and is loaded only on legacy browsers — not counted.
 *
 * The script is intentionally framework-version-tolerant: it reads files
 * from `.next/static/chunks/` and falls back to the top-level
 * `build-manifest.json` if `app-build-manifest.json` is absent.
 *
 * Output on PASS: one-line-per-route table; exit 0.
 * Output on FAIL: per-route breach table with the top contributing
 * chunks; exit 1.
 *
 * The threshold and exemption list are at the top of the file so changes
 * are visible in code review. Phase 1 has no exemptions; if one becomes
 * necessary, also update `docs/adr/0016-performance-budget-gates.md`.
 */

import { gzipSync } from "node:zlib";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

/** NFR-P6: per-route initial JS, gzipped, must stay under this. */
const THRESHOLD_BYTES = 250 * 1024;

/**
 * Route-specific exemptions. KEEP EMPTY at Phase 1. If a route legitimately
 * needs more headroom, add an entry here AND update ADR 0016 with the
 * justification. Never add an exemption to make a failing build green.
 *
 * @type {Record<string, { limitBytes: number; reason: string }>}
 */
const EXEMPTIONS = {};

/** Soft-warn threshold: routes above this print a yellow warning even if under the hard limit. */
const WARN_BYTES = Math.floor(THRESHOLD_BYTES * 0.85);

const NEXT_DIR = path.join(ROOT, ".next");
const APP_MANIFEST = path.join(NEXT_DIR, "app-build-manifest.json");
const BUILD_MANIFEST = path.join(NEXT_DIR, "build-manifest.json");

function fail(msg) {
  console.error(`\n[check-bundle-size] FAIL: ${msg}`);
  process.exit(1);
}

if (!existsSync(NEXT_DIR)) {
  fail(
    `.next/ not found at ${NEXT_DIR}. Run \`npm run build\` before \`npm run check:bundle-size\`.`,
  );
}

/**
 * @returns {Record<string, string[]>}
 */
function loadRouteManifest() {
  if (existsSync(APP_MANIFEST)) {
    const j = JSON.parse(readFileSync(APP_MANIFEST, "utf8"));
    /** @type {Record<string, string[]>} */
    const out = {};
    for (const [page, files] of Object.entries(j.pages ?? {})) {
      // Filter to JS only — CSS files are also listed and count separately.
      const jsFiles = /** @type {string[]} */ (files).filter((f) =>
        f.endsWith(".js"),
      );
      if (jsFiles.length > 0) out[page] = jsFiles;
    }
    return out;
  }
  if (existsSync(BUILD_MANIFEST)) {
    const j = JSON.parse(readFileSync(BUILD_MANIFEST, "utf8"));
    /** @type {Record<string, string[]>} */
    const out = {};
    for (const [page, files] of Object.entries(j.pages ?? {})) {
      const jsFiles = /** @type {string[]} */ (files).filter((f) =>
        f.endsWith(".js"),
      );
      if (jsFiles.length > 0) out[page] = jsFiles;
    }
    return out;
  }
  fail(
    `Neither app-build-manifest.json nor build-manifest.json was found in ${NEXT_DIR}.`,
  );
  return {}; // unreachable
}

/** Cache gzipped sizes so we don't gzip the same chunk N times. */
const gzipCache = new Map();

/** @param {string} relPath chunk path relative to `.next/` (e.g. `static/chunks/abc.js`). */
function gzippedSize(relPath) {
  if (gzipCache.has(relPath)) return gzipCache.get(relPath);
  const abs = path.join(NEXT_DIR, relPath);
  if (!existsSync(abs)) {
    // Manifest lists a file the build didn't emit — fail loudly so the
    // gate can't be silently bypassed by a manifest / disk mismatch.
    fail(`Chunk referenced by manifest is missing on disk: ${relPath}`);
  }
  const raw = readFileSync(abs);
  const gz = gzipSync(raw, { level: 9 }).length;
  gzipCache.set(relPath, gz);
  return gz;
}

/** @param {number} bytes */
function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function pad(s, n) {
  return String(s).padEnd(n);
}

const manifest = loadRouteManifest();

/**
 * Pages we don't care about for the gate:
 *   - `/_not-found/page`  (404; rarely on the critical path)
 *   - `/layout`           (the layout chunks already roll into each page row)
 *   - `/_app`/`/_document` (pages-router boilerplate)
 */
const SKIP_PAGE = (page) =>
  page === "/_not-found/page" ||
  page === "/_app" ||
  page === "/_document" ||
  page.endsWith("/layout");

/** @type {Array<{ route: string; bytes: number; chunks: Array<{ name: string; bytes: number }> }>} */
const rows = [];

for (const [page, files] of Object.entries(manifest)) {
  if (SKIP_PAGE(page)) continue;

  /** @type {Array<{ name: string; bytes: number }>} */
  const chunks = [];
  for (const f of files) {
    const bytes = gzippedSize(f);
    chunks.push({ name: f.replace(/^static\/chunks\//, ""), bytes });
  }
  // Sort descending: biggest first for the failure report.
  chunks.sort((a, b) => b.bytes - a.bytes);
  const total = chunks.reduce((sum, c) => sum + c.bytes, 0);
  rows.push({ route: page, bytes: total, chunks });
}

rows.sort((a, b) => b.bytes - a.bytes);

console.log(
  `\n[check-bundle-size] NFR-P6 budget: ${kb(THRESHOLD_BYTES)} gzipped initial JS per route.\n`,
);

const ROUTE_COL = Math.max(40, ...rows.map((r) => r.route.length + 2));
console.log(`${pad("Route", ROUTE_COL)} ${pad("Gzipped JS", 12)} ${"Status"}`);
console.log("-".repeat(ROUTE_COL + 14 + 10));

const failures = [];
for (const r of rows) {
  const exemption = EXEMPTIONS[r.route];
  const limit = exemption?.limitBytes ?? THRESHOLD_BYTES;
  let status;
  if (r.bytes > limit) {
    status = `FAIL (> ${kb(limit)})`;
    failures.push({ ...r, limit });
  } else if (r.bytes > WARN_BYTES && !exemption) {
    status = "WARN";
  } else if (exemption) {
    status = `OK (exempt: ${kb(limit)})`;
  } else {
    status = "OK";
  }
  console.log(`${pad(r.route, ROUTE_COL)} ${pad(kb(r.bytes), 12)} ${status}`);
}

if (failures.length > 0) {
  console.error(
    `\n[check-bundle-size] ${failures.length} route(s) exceed the NFR-P6 budget:\n`,
  );
  for (const f of failures) {
    console.error(
      `  ${f.route}  →  ${kb(f.bytes)} (limit ${kb(f.limit)}, over by ${kb(f.bytes - f.limit)})`,
    );
    console.error(`    Top contributing chunks:`);
    for (const c of f.chunks.slice(0, 5)) {
      console.error(`      ${kb(c.bytes).padStart(9)}  ${c.name}`);
    }
  }
  console.error(
    `\nRemediation: lazy-load heavy libraries (Leaflet, PDFKit) via \`next/dynamic\` with \`{ ssr: false }\`.\n` +
      `Run \`npm run analyze\` locally to open the visual bundle report.\n` +
      `Do NOT add an exemption to make this pass without an ADR update.\n`,
  );
  process.exit(1);
}

console.log(
  `\n[check-bundle-size] PASS. ${rows.length} route(s) checked, all under ${kb(THRESHOLD_BYTES)}.\n`,
);
