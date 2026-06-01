# ADR 0016: Performance Budget Gates in CI

- **Status:** Accepted
- **Date:** 2026-05-18
- **Story:** 5.8

## Context

The architecture commits to four hard performance numbers (NFR-P targets):

- **NFR-P1** — LCP < 2.5s on desktop, < 4s on mid-range Android over emulated 4G.
- **NFR-P5** — INP < 200ms at p75 across all interactive UI.
- **NFR-P6** — initial JS per route < 250 KB **gzipped** (Leaflet + PDFKit must be lazy-loaded; never on the initial bundle).
- **NFR-A2 / WCAG-AA** — color + icon + label, axe-clean on critical / serious violations.

These were aspirational until Story 1.1 wired a Lighthouse job into CI on `continue-on-error: true` with loose `warn`-only thresholds (perf / a11y / best-practices ≥ 0.8). A loose warn-only gate catches nothing; the project shipped 42 stories of features on top of that scaffold and the budgets had no enforcement.

Three failure modes the gate must prevent:

1. **Silent bundle bloat** — a developer adds `import L from "leaflet"` to a non-map route. The map page works; the dashboard quietly grows 150 KB. Mr. Reyes (the office admin on a mid-range Android) waits an extra 600ms-1s per first paint. There is no review signal because the diff "just imports a library."
2. **Drive-by Lighthouse score regressions** — a refactor adds a render-blocking script or breaks an aria-label. The component renders correctly in tests; the perf / a11y score drops by 5 points. With no gate, this lands.
3. **Lighthouse on the dev server / wrong profile** — a dev runs `npx lhci autorun` locally on `npm run dev` (Turbopack, unoptimized) and concludes "perf is fine." Production builds tell a different story.

## Decision

### 1. Lighthouse CI on a production build, hard-asserts on category scores

`lighthouserc.json` is tightened from Story 1.1's loose baseline:

- **URLs covered:** `/login`, `/lots`, `/dashboard`, `/map`. These are the most-used office-staff entry points and the perf-critical map route. Unauthenticated runs of `/lots`, `/dashboard`, `/map` redirect to `/login`; the gate therefore measures the redirect+login flow for those routes. Adding authenticated-flow measurement via a Puppeteer login script is a follow-up (NFR-P1's office-staff flow specifically; out of scope here to keep the gate landing this sprint).
- **Hard assertions (error-level — fail the build):**
  - `categories:performance` ≥ 0.90
  - `categories:accessibility` ≥ 0.95
  - `categories:best-practices` ≥ 0.90
  - `categories:seo` ≥ 0.90
- **Warn-only assertions** (logged, don't fail): LCP < 4000ms, TBT < 300ms, CLS < 0.1, `unused-javascript`. These are kept warn-only because they're sensitive to single-run noise. The composite category score (the hard gate) already weights these heavily — a 4.2s LCP cratering the perf category to 0.88 fails the build via the perf-category gate, not the LCP-numeric gate. This avoids double-failing on the same regression and reduces false positives.
- **Profile:** Lighthouse `desktop` preset with simulated 4G throttling (`rttMs: 150`, `throughputKbps: 1638.4`, `cpuSlowdownMultiplier: 4`). The Story 1.1 settings are kept; the gate's strictness comes from the score floors, not the throttling profile. A mobile-emulation second run is on the follow-up list (see Story 5.8 task notes).
- **Run count:** `numberOfRuns: 1`. Lighthouse's docs recommend 3+ for noise floors; we accept the single-run risk to keep CI wall-clock under 5 min total. If flakes appear, bump to 3.
- **`continue-on-error` is removed.** The lighthouse job now fails the workflow.

### 2. Bundle-size gate enforces NFR-P6 per route

A new `bundle-size` CI job runs `next build` then `scripts/check-bundle-size.mjs`. The script:

1. Reads `.next/app-build-manifest.json` (App Router) — falls back to `.next/build-manifest.json` if absent (Pages Router compatibility).
2. For each route, sums the **gzipped** disk size of every JS chunk the manifest lists for that route. Gzipping is done in-process via `node:zlib.gzipSync` at level 9 (matches Next.js's production assumption that the CDN serves brotli/gzip).
3. Asserts per-route total ≤ **250 KB gzipped** (NFR-P6).
4. On breach, prints a per-route table with the top-5 contributing chunks so the offending import is obvious.
5. Routes between 85% and 100% of the limit print a `WARN` row — early-warning before a hard breach lands.

**Why on-disk gzip and not the `webpack-stats` `size` field:** Next.js's manifest reports uncompressed sizes by default. The NFR-P6 threshold is gzipped — measuring uncompressed and "estimating" gzip ratio invites drift. Gzipping the actual bytes is deterministic.

**Why one gate per route, not aggregate:** the architecture's lazy-loading rule is per-route. A route that doesn't render the map shouldn't ship Leaflet bytes. An aggregate gate (e.g. "total app ≤ X MB") would let a heavy library hide on every page.

**No exemptions at Phase 1.** The script supports a per-route exemption table but it's empty. Adding an entry requires updating this ADR with the justification — a silent exemption invalidates the whole gate. The disaster-prevention note in the story explicitly forbids quiet exemptions.

### 3. `@next/bundle-analyzer` available via `npm run analyze`

Wrapping `next.config.ts` with `@next/bundle-analyzer` (active only when `ANALYZE=true`) gives developers a visual treemap (`./.next/analyze/client.html`) for diagnosing breaches. The analyzer is dev-only — it does not affect CI builds. The CI gate is the bundle-size script; the analyzer is the diagnostic tool a developer runs after the gate fires.

### 4. Axe-core / Playwright a11y gate — deferred but tracked

Story 5.8's full scope includes adding `@axe-core/playwright` calls to every key page after sign-in as a hard CI gate. The PR landing this ADR ships the Lighthouse + bundle-size gates and defers the per-page axe wiring to a follow-up (the Playwright specs are the right place; the test files are owned by the test sprint, not this infra sprint). The Lighthouse `accessibility ≥ 0.95` score gate already catches the most common a11y regressions at the page level. The follow-up sharpens the gate with rule-level axe assertions.

## Thresholds chosen — why these specific numbers

| Metric | Threshold | Source |
|---|---|---|
| Perf score | ≥ 0.90 | NFR-P1 / P5 + UX-DR33 — a 0.85 score routinely passes with LCP > 4s on real devices; 0.90 holds the line. |
| A11y score | ≥ 0.95 | NFR-A2 + WCAG-AA — 0.95 catches missing labels / contrast issues; 1.00 fails too often on Lighthouse-internal quirks not actionable by the team. |
| Best practices | ≥ 0.90 | Standard floor — catches HTTPS, deprecation, vulnerable lib usage. |
| SEO | ≥ 0.90 | Defensive — even though `/login` etc. are `noindex,nofollow`, the meta-tag and viewport checks catch broken meta. The Phase 3 customer portal page will need these clean. |
| Initial JS per route | ≤ 250 KB gzipped | NFR-P6 directly. |
| Bundle warn threshold | 85% of 250 KB = ~212 KB | Early-warning so PRs that creep toward the limit get visibility before the hard fail. |

## Trade-offs

- **Slower PRs.** The `bundle-size` job runs `next build` (~60-90s on warm cache, ~3 min cold) + the gzip pass (< 5s). It runs in parallel with the existing `playwright` and `lighthouse` jobs, so wall-clock CI grows by < 90s on warm cache.
- **Single-run Lighthouse is noisy.** A 0.89 perf score from ambient runner noise will fail a PR that's actually fine. The mitigation is the developer can re-run the workflow; if the same PR fails three times the regression is real. If this becomes a frequent papercut, raise `numberOfRuns` to 3.
- **Authenticated routes measure the login redirect.** Until the Puppeteer auth flow is added, `/dashboard`'s perf number is really `/login`'s perf number. This is acceptable for landing the gate: it locks in the public-route NFRs and prevents `/login` regressions immediately. The follow-up adds true authenticated measurement.
- **Bundle gate is gzipped, not brotli.** Real production CDNs likely serve brotli (smaller). We gzip to be conservative — gzip is the worst-case modern compression, so passing the gzipped gate guarantees the brotli-served reality is better. No reason to measure two compressions.

## Alternatives considered

- **`bundlewatch` / `bundle-stats-action` / `size-limit`** — third-party tools. All add a new dep with its own config format. `@next/bundle-analyzer` is already a Next.js sister package; combined with a 200-line house script we get the same enforcement without taking on a new dependency surface area or maintenance contract.
- **Lighthouse `assertMatrix` per-URL** — useful if `/login` and `/dashboard` need different thresholds. Currently they don't (all four URLs target the same NFR scores). If a route legitimately needs a different floor, switch to `assertMatrix` at that time.
- **Skipping the SEO gate** — `/login` is `noindex,nofollow`; some argued SEO doesn't apply. Counter: SEO 0.90 also catches missing `<meta name="viewport">`, missing `<title>`, and a few accessibility-adjacent checks that the a11y category misses. It's nearly free and catches real bugs.

## NFRs out of scope for this ADR

- **NFR-P2 — map render < 3s mobile.** Leaflet ships in Phase 2; the map-render Lighthouse measurement and its specific threshold is added with that phase.
- **NFR-M2 — ≥ 90% coverage on financial code.** Already enforced by Story 1.1's `vitest` CI job + coverage config; not modified here.
- **RUM (real-user monitoring).** Synthetic CI measurements are necessary but not sufficient. A Phase 1.5+ addition (Vercel Speed Insights or similar) layers on top of these gates.

## How to escalate when a gate fires

1. **Bundle-size FAIL:** run `npm run analyze` locally; open `./.next/analyze/client.html`; identify the unexpected import; convert it to `dynamic(() => import("..."), { ssr: false })`. Re-run `npm run build && npm run check:bundle-size` until green.
2. **Lighthouse perf score FAIL:** open the workflow artifact (Lighthouse uploads its report to `temporary-public-storage`). The Lighthouse report names the failing audits with remediation steps. Common causes: un-optimized images (use `next/image`), blocking third-party scripts, top-level imports of heavy libs (handled by gate 1).
3. **Lighthouse a11y score FAIL:** the report lists the failing audit IDs. Cross-reference with axe rule docs. Fix the underlying issue — never disable the rule.
4. **Legitimate threshold change** — extremely rare. Requires a new ADR amending this one with the rationale and the new threshold. Lowering a threshold to make a regression pass is explicitly forbidden by Story 5.8.

## References

- [PRD § Performance NFRs](../../_bmad-output/planning-artifacts/prd.md)
- [Architecture § Frontend Performance Targets](../../_bmad-output/planning-artifacts/architecture.md)
- [UX § Implementation Roadmap — end-of-milestone perf check](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- Story 1.1 — CI scaffold (loose baseline this ADR tightens)
- Story 1.4 — design tokens + initial axe integration (used by the deferred follow-up)
- Story 5.2 — dashboard route (one of the URLs the gate measures)
- Lighthouse CI docs: https://github.com/GoogleChrome/lighthouse-ci
- `@next/bundle-analyzer`: https://www.npmjs.com/package/@next/bundle-analyzer
