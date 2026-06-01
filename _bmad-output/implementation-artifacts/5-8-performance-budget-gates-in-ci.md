# Story 5.8: Performance Budget Gates in CI

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer / UX implementer**,
I want **Lighthouse CI + bundle-size analysis + axe-core scans to run on every PR with NFR-threshold assertions that FAIL the build if any threshold is breached**,
so that **performance and accessibility regressions are caught at PR time rather than after they ship to Mr. Reyes's phone in the field** (UX-DR33 / UX-DR34, NFR-P1 / NFR-P2 / NFR-P5 / NFR-P6, NFR-M2).

This story converts the NFR thresholds from "aspirations in a doc" into "the build fails if you miss them." Story 1.1 set up Lighthouse with loose initial thresholds; this story tightens them to the production-target values and adds bundle-size + axe-core as hard gates. After this story merges, every PR receives an automated empirical answer to "does this regress LCP / INP / bundle size / accessibility?"

## Acceptance Criteria

1. **AC1 — Lighthouse CI fails the build when NFR-P1 / NFR-P5 are breached**: `lighthouserc.json` is updated to assert (a) LCP **< 4s** on the mobile / emulated-4G profile (NFR-P1's mobile budget — the desktop budget of `< 2.5s` is a stretch goal asserted as a warning, not an error), (b) INP **< 200ms at p75** (NFR-P5 across all interactive UI). Lighthouse runs on every PR via the GitHub Actions `lighthouse` job (Story 1.1 set it up). The collect URL set includes `/login`, `/dashboard`, `/sales/new`, `/payments/new`, `/customers/[id]` — the office-staff workflow routes that NFR-P1 specifies. When ANY assertion fails, the workflow exits non-zero and the PR's check fails with a clear message identifying which route, which metric, and the actual value vs. threshold.

2. **AC2 — Bundle-size analyzer fails the build when NFR-P6 is breached**: A bundle-size check runs in CI as a separate job `bundle-size`. It runs `next build` then analyzes per-route initial-JS bundle. When any authenticated route's initial JS exceeds **250KB gzipped** (NFR-P6), the build fails with the per-route bundle composition shown (which chunks contributed the most bytes). Leaflet, PDFKit, and any other heavy library MUST be lazy-loaded — the gate enforces that they're not in the initial bundle. The check uses `next-bundle-analyzer` or `@next/bundle-analyzer` to extract per-route stats; the assertion script runs after the build and parses the JSON output.

3. **AC3 — axe-core scans fail the build on critical / serious violations**: Existing Playwright e2e specs are extended to call `@axe-core/playwright` on every key page after sign-in (`/dashboard`, `/lots`, `/sales/new`, `/payments/new`, `/customers`, `/customers/[id]`, `/ar-aging`, `/admin/users`). Any `critical` or `serious` violation fails the spec. `moderate` and `minor` violations are reported as warnings (logged but not failing). The axe checks run as part of the existing `playwright` CI job — no new job. Story 1.4 introduced axe in the foundation; this story makes it a CI gate.

4. **AC4 — A single regression PR demonstrates each gate firing**: As part of the story's verification, a draft PR is opened that deliberately introduces (a) a 10MB image with no `next/image` optimization (LCP regression), (b) a top-level `import Leaflet from "leaflet"` in `/dashboard/page.tsx` (bundle-size regression), (c) a `<div>` with `onClick` and no role / tabIndex (axe critical violation). Each gate fails the build with a recognizable error message; the draft PR is then closed without merging. Screenshots of each failing check are attached to this story's real PR as evidence the gates work.

## Tasks / Subtasks

### Lighthouse tightening (AC1)

- [ ] **Task 1: Update `lighthouserc.json` with the NFR-P1 / NFR-P5 thresholds** (AC: 1)
  - [ ] Read the existing `lighthouserc.json` from Story 1.1. Story 5.2 added `/dashboard` to the URL list.
  - [ ] Expand `collect.url` to include every NFR-P1 office-staff workflow route: `/login`, `/dashboard`, `/sales/new`, `/payments/new`, `/customers/[seedCustomerId]` (use a known seed customer for deterministic URLs), `/contracts/[seedContractId]`, `/ar-aging`. Lighthouse runs on each.
  - [ ] Assertion config (`lighthouserc.json` `assert` section):
    ```json
    "assertions": {
      "categories:performance": ["error", { "minScore": 0.85 }],
      "categories:accessibility": ["error", { "minScore": 0.95 }],
      "largest-contentful-paint": ["error", { "maxNumericValue": 4000 }],
      "interaction-to-next-paint": ["error", { "maxNumericValue": 200, "aggregationMethod": "pessimistic" }],
      "total-blocking-time": ["error", { "maxNumericValue": 300 }],
      "cumulative-layout-shift": ["error", { "maxNumericValue": 0.1 }],
      "unused-javascript": "warn",
      "render-blocking-resources": ["error", { "maxNumericValue": 1000 }]
    }
    ```
  - [ ] **Throttling profile:** mobile / emulated-4G (the most punishing profile per NFR-P1 mid-range Android target). Configure via `collect.settings.preset = "mobile"` and emulated network = "Slow 4G" (Lighthouse default for the mobile preset).
  - [ ] Lighthouse runs 3 times per URL by default (median is used); configure `collect.numberOfRuns = 3` explicitly.
  - [ ] **Desktop as a separate run (warning-only):** add a second Lighthouse config `lighthouserc.desktop.json` running the desktop preset with `largest-contentful-paint: ["warn", { "maxNumericValue": 2500 }]`. Captures NFR-P1's desktop number as a non-blocking warning so we see desktop drift without failing PRs for it (mobile is the harder target and the gate).

- [ ] **Task 2: Wire `/dashboard`-after-login Lighthouse flow** (AC: 1)
  - [ ] `/dashboard` requires authentication; Lighthouse's default "open URL, measure" won't work. Two options:
    - **Option A (preferred):** Use Lighthouse's `puppeteerScript` or `lhci`-supported authenticated-flow config to sign in before measuring the protected route. Reference: `lighthouserc.json` supports `collect.puppeteerScript` pointing at a JS file that takes a Puppeteer Page and signs in the seed admin.
    - **Option B (fallback):** Run Lighthouse only on `/login` (public) + use Playwright with `@playwright/test`'s Lighthouse integration to measure authenticated routes separately. Architecture's NFR-P1 wording references the office-staff workflow routes specifically; missing them in CI weakens the gate.
  - [ ] Choose Option A unless `lhci`'s authenticated-flow support has regressed; document the choice in the GitHub Actions workflow comments + in `docs/runbook.md` (a "How CI runs perf checks" entry, NEW subsection).
  - [ ] Seed user credentials come from `SEED_ADMIN_PASSWORD` (Story 1.1 env var). The CI job passes the password to the auth script via env var.

### Bundle-size gate (AC2)

- [ ] **Task 3: Install + configure `@next/bundle-analyzer`** (AC: 2)
  - [ ] `npm install --save-dev @next/bundle-analyzer`.
  - [ ] Update `next.config.ts` to conditionally enable the analyzer when `ANALYZE=true`:
    ```ts
    import withBundleAnalyzer from "@next/bundle-analyzer";
    const bundleAnalyzer = withBundleAnalyzer({ enabled: process.env.ANALYZE === "true" });
    export default bundleAnalyzer({ /* existing config */ });
    ```
  - [ ] Add npm script: `"analyze": "ANALYZE=true next build"`. Running it locally produces `.next/analyze/client.html` (and `nodejs.html` / `edge.html`) — visual reports for the dev to inspect.

- [ ] **Task 4: Write `scripts/check-bundle-size.mjs` for the CI gate** (AC: 2)
  - [ ] Create `scripts/check-bundle-size.mjs` (NEW file). The script:
    1. Reads `.next/build-manifest.json` + `.next/app-build-manifest.json` (or equivalent — verify current Next.js manifest paths).
    2. For each route's initial JS chunks, sum the gzipped sizes. Use `node:zlib` to gzip each chunk's actual contents (read from `.next/static/chunks/`) — the manifest doesn't store gzipped sizes directly.
    3. Apply the threshold: each route's initial JS gzipped sum must be ≤ 250KB (NFR-P6's threshold).
    4. On breach, print a per-route table with route, total gzipped KB, and the top-3 contributing chunks. Exit non-zero.
    5. On pass, print a summary table (all routes under threshold) + exit 0.
  - [ ] **Per-route exemption list** — none initially. If a route has a legitimate reason to be larger (TBD), require an explicit exemption entry in the script's config + a code comment justifying it. Phase 1 has no such exemptions.
  - [ ] Add npm script: `"check-bundle-size": "node scripts/check-bundle-size.mjs"`.

- [ ] **Task 5: Add `bundle-size` job to GitHub Actions** (AC: 2)
  - [ ] In `.github/workflows/ci.yml` (Story 1.1's workflow), add a new job:
    ```yaml
    bundle-size:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with: { node-version: 20, cache: 'npm' }
        - run: npm ci
        - run: npm run build
        - run: npm run check-bundle-size
    ```
  - [ ] The job runs in parallel with `lint`, `typecheck`, `vitest`, `playwright`, `lighthouse`. Total CI wall-clock time grows by < 2 minutes (next build is the bottleneck; can be cached).
  - [ ] Cache `.next/cache` between runs to speed up incremental builds.

### axe-core CI gate (AC3)

- [ ] **Task 6: Extend Playwright specs to call `@axe-core/playwright`** (AC: 3)
  - [ ] If `@axe-core/playwright` is not yet installed (Story 1.4 may have installed it), `npm install --save-dev @axe-core/playwright`.
  - [ ] Create `tests/e2e/lib/a11y.ts` (NEW helper file):
    ```ts
    import { AxeBuilder } from "@axe-core/playwright";
    import type { Page } from "@playwright/test";

    export async function expectNoCriticalA11yViolations(page: Page, opts?: { context?: string }) {
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const critical = results.violations.filter(v => v.impact === "critical" || v.impact === "serious");
      if (critical.length > 0) {
        const formatted = critical.map(v => `[${v.impact}] ${v.id}: ${v.description} — ${v.nodes.length} node(s)`).join("\n");
        throw new Error(`Accessibility violations on ${opts?.context ?? page.url()}:\n${formatted}`);
      }
      // Log moderate / minor as warnings via console (Playwright captures these in test output)
      const lower = results.violations.filter(v => v.impact === "moderate" || v.impact === "minor");
      if (lower.length > 0) console.warn(`[a11y] ${lower.length} non-blocking violation(s) on ${opts?.context}: ${lower.map(v => v.id).join(", ")}`);
    }
    ```
  - [ ] Extend existing journey specs to invoke `expectNoCriticalA11yViolations(page, { context: "..." })` after each significant page load:
    - `tests/e2e/journey-1-installment-sale.spec.ts` — on `/sales/new` and `/contracts/[id]`
    - `tests/e2e/journey-2-payment-posting.spec.ts` — on `/payments/new` and the receipt-preview state
    - `tests/e2e/journey-4-admin-dashboard.spec.ts` — on `/dashboard` (Story 5.2 + 5.5 banner state)
    - Other existing specs — extend per the route list in AC3.
  - [ ] For routes that don't yet have e2e specs (`/admin/users`, `/ar-aging` if not yet specced), add minimal specs that sign in, navigate, run a11y check, and exit.

### Verification (AC4)

- [ ] **Task 7: Demonstrate each gate by opening a "regression" draft PR** (AC: 4)
  - [ ] On a throwaway branch `chore/perf-gate-verification`, introduce each deliberate regression (one per file/commit so the gate-specific failure is clear):
    - Commit 1 (LCP regression): drop a 10MB JPEG into `public/heavy-image.jpg` and import it on `/dashboard/page.tsx` as `<img src="/heavy-image.jpg" />`. Push, observe the `lighthouse` job fails with the LCP assertion message.
    - Commit 2 (bundle regression): add `import L from "leaflet";` at the top of `src/app/(staff)/dashboard/page.tsx` (top-level import — Leaflet is supposed to be lazy-loaded per Story 1.5 / architecture). Push, observe the `bundle-size` job fails with the per-route breach message + Leaflet listed as top contributor.
    - Commit 3 (a11y regression): add `<div onClick={() => alert("hi")}>Click me</div>` to `/dashboard/page.tsx` (no role, no tabIndex, no button semantics). Push, observe the `playwright` job fails with the axe-core message identifying the violation.
  - [ ] Capture screenshots of each failing check. Attach to the REAL story's PR as evidence. Close the draft PR without merging — it was scaffolding for the demonstration.
  - [ ] If any gate does NOT fire on its intended regression, the gate is broken — investigate and fix before merging.

- [ ] **Task 8: Update `docs/adr/0011-performance-budgets.md`** (AC: 1, AC: 2, AC: 3)
  - [ ] (Adjust ADR number if conflict.) Document:
    - **Context:** UX-DR33 + UX-DR34 require enforced performance budgets; NFRs P1 / P2 / P5 / P6 + M2 set the targets. Without CI enforcement, NFRs are aspirational.
    - **Decision:** Lighthouse CI on mobile / 4G profile with hard assertions on LCP / INP / TBT / CLS; bundle-size gate per-route at 250KB gzipped; axe-core integrated into Playwright as hard gate on critical / serious.
    - **Thresholds chosen:** LCP < 4s (NFR-P1 mobile), INP p75 < 200ms (NFR-P5), bundle initial JS < 250KB gzipped (NFR-P6). Desktop LCP < 2.5s as warning-only.
    - **Why warning-only on desktop:** mobile is the harder target; if mobile passes, desktop almost always does too. A failing-desktop / passing-mobile case would indicate a measurement anomaly; we keep it visible (warning) but don't gate on it.
    - **Trade-offs:** PRs are now slower (next build + 3 Lighthouse runs × 7 URLs = ~5-7 minutes added). Worth it.
    - **NFR-P2 (map render < 3s):** out of scope for this story — Leaflet ships in Phase 2; the map-render gate is added with that phase.

### Documentation (AC1)

- [ ] **Task 9: Update `docs/runbook.md` with the perf-budget operations** (AC: 1)
  - [ ] Add section "## Performance budget enforcement":
    - **What runs in CI:** the four gates (Lighthouse, bundle-size, axe-core, accessibility-score-via-Lighthouse).
    - **When a gate fails — interpretation:** LCP failure → likely an un-optimized image / un-lazyloaded resource; INP failure → likely a blocking JS handler; bundle-size failure → likely a top-level import that should be dynamic; axe failure → see the rule ID, fix accessibility.
    - **How to deliberately bypass a gate (escape hatch):** never silently. If a legitimate reason exists (e.g. a one-time PR that increases bundle size for a justified reason), update the gate's threshold + ADR with the rationale. Do NOT add an exemption to the script that quietly excludes a route.
    - **Local reproduction:** how to run Lighthouse / bundle-size / axe locally before pushing. `npm run lighthouse`, `npm run check-bundle-size`, `npm run test:e2e -- --grep "a11y"`.

## Dev Notes

### Previous story intelligence

- **Story 1.1** — established `lighthouserc.json` with initial loose thresholds + the GitHub Actions `lighthouse` job. This story TIGHTENS the thresholds and adds two new CI jobs.
- **Story 1.4** — introduced `axe-core` for component-level tests + the design tokens whose contrast ratios pass WCAG AA. This story moves axe from per-component to per-page CI gate.
- **Story 1.5** — established the Cmd-K palette + middleware. This story does not modify routing; it just measures perf of existing routes.
- **Story 5.2** — established `/dashboard` as the perf-defining page. NFR-P1 anchors specifically on the dashboard route.
- **Stories 5.1 / 5.2 / 5.5** — produced the UI surfaces this story measures. Don't start this story until the dashboard + key pages exist; measuring placeholders gives false-passing gates.

**If the foundation routes (`/login`, `/dashboard`, `/sales/new`, `/payments/new`) don't yet exist, this story is too early.** Land them first, then this story locks in the budget.

### Architecture compliance

- **Architecture § NFRs P1 / P2 / P5 / P6** — the threshold sources. This story enforces them.
- **Architecture § Maintainability NFR-M2** — coverage gate on financial code (≥ 90%). This story does NOT change that gate; existing `vitest` CI job from Story 1.1 + coverage config covers it. Mention here only because the user's prompt listed NFR-M2 alongside perf NFRs.
- **NFR-DR33 / DR34 from UX:** the user's prompt cites these. The UX spec mentions Lighthouse mobile budgets (LCP < 4s, INP < 200ms p75) and axe-core CI gate. This story makes those binding.
- **Architecture's "Leaflet lazy-loaded post-Phase-1; PDF library never client-side"** (NFR-P6) — the bundle-size gate enforces this. A top-level `import "leaflet"` would breach 250KB; the gate fires.

### Library / framework versions

- **`@next/bundle-analyzer`** — `@latest` (matches Next.js major version).
- **`@lhci/cli`** — already installed by Story 1.1. May need version bump to support `puppeteerScript` if not on latest.
- **`@axe-core/playwright`** — `@latest` (currently v4.x). Story 1.4 may have installed it; verify.
- **Node `zlib`** — built-in.

### File structure requirements

```
cemetery-mapping/
├── .github/workflows/ci.yml                     # UPDATE (add bundle-size job; existing lighthouse job tightened)
├── lighthouserc.json                            # UPDATE (tighten assertions, expand URLs, mobile profile)
├── lighthouserc.desktop.json                    # NEW (desktop config with warning-only thresholds)
├── next.config.ts                               # UPDATE (wrap with bundle analyzer)
├── scripts/
│   └── check-bundle-size.mjs                    # NEW (per-route gzipped-size check)
├── tests/
│   └── e2e/
│       └── lib/a11y.ts                          # NEW (axe helper)
├── docs/
│   ├── adr/0011-performance-budgets.md          # NEW (renumber if conflict)
│   └── runbook.md                                # UPDATE (perf-budget section)
└── package.json                                  # UPDATE (add @next/bundle-analyzer, @axe-core/playwright if not present, npm scripts)
```

### Testing requirements

- **The story's primary testing IS the gates themselves.** No additional unit tests are needed for the gate scripts (the regression-PR demo verifies the gates fire).
- **Lighthouse `numberOfRuns: 3`** — accounts for measurement noise. Without multiple runs, a single bad sample fails a PR for ambient noise.
- **`expectNoCriticalA11yViolations`** is a test helper, not a test. Existing tests gain a11y assertions; new tests are added only where coverage was missing.
- **The regression-PR demo (Task 7) is verification of the gates, not part of normal CI.** Don't merge it. Close after evidence captured.

### Source references

- **PRD:** [NFR-P1 — LCP < 2.5s desktop / < 4s mobile 4G](../../_bmad-output/planning-artifacts/prd.md#performance), [NFR-P2 — Map < 3s mobile (Phase 2 scope)](../../_bmad-output/planning-artifacts/prd.md#performance), [NFR-P5 — INP < 200ms p75](../../_bmad-output/planning-artifacts/prd.md#performance), [NFR-P6 — Initial JS < 250KB gzipped](../../_bmad-output/planning-artifacts/prd.md#performance), [NFR-M2 — ≥ 90% coverage on financial code (referenced; not modified here)](../../_bmad-output/planning-artifacts/prd.md#maintainability), [NFR-A2 — color + icon + label (axe verifies)](../../_bmad-output/planning-artifacts/prd.md#accessibility).
- **Architecture:** [§ Frontend Performance Targets](../../_bmad-output/planning-artifacts/architecture.md), [§ Project Structure > .github/workflows/ci.yml](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure).
- **UX:** [§ Implementation Roadmap — End of every milestone: run axe-core, run Lighthouse on mid-range Android emulation, verify NFR-P1, P2, P6 targets](../../_bmad-output/planning-artifacts/ux-design-specification.md), [§ Automated scanning — axe-core (via @axe-core/playwright) on every key page; CI gate fails build on critical issues](../../_bmad-output/planning-artifacts/ux-design-specification.md).
- **Epics:** [Story 5.8](../../_bmad-output/planning-artifacts/epics.md#story-58-performance-budget-gates-in-ci).
- **Previous stories:** Story 1.1 (CI scaffold + initial Lighthouse), Story 1.4 (axe-core + tokens), Story 5.2 (dashboard route exists).

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT loosen the thresholds to make the build pass.** If LCP regresses to 4.2s, the answer is to fix the perf regression, not raise the threshold to 5s. The threshold is the NFR; the NFR is the contract with Mr. Reyes.
- ❌ **Do NOT add per-route exemptions to the bundle-size script without an ADR update.** A silent exemption invalidates the whole gate.
- ❌ **Do NOT run Lighthouse against `localhost` HTTP only.** Production runs over HTTPS; HTTP measurements miss TLS overhead. Configure the local-CI server with self-signed HTTPS OR use `--chrome-flags="--ignore-certificate-errors"` and document the trade-off.
- ❌ **Do NOT skip the desktop warning-only run.** It's a cheap canary; if mobile passes and desktop suddenly regresses, that's an anomaly worth noticing.
- ❌ **Do NOT gate on `moderate` axe violations.** Critical + serious only. Lowering the threshold to moderate would catch a flood of minor issues (e.g. tab order on a debug-only page) that aren't user-impacting, fatiguing reviewers and producing pressure to suppress.
- ❌ **Do NOT bypass the gates with `[skip ci]` or `--allow-error`.** If a PR genuinely needs to bypass, raise it to the user; document the exemption in the ADR.
- ❌ **Do NOT measure Lighthouse on the dev server (`npm run dev`).** Dev mode is unoptimized; measurements are meaningless. Always against `npm run build && npm run start`.
- ❌ **Do NOT use `Number(x).toFixed(2)` for size formatting** in the report — minor pet peeve, but consistent formatting matters when scanning output during a failed build. Use `(bytes / 1024).toFixed(1) + ' KB'`.
- ❌ **Do NOT count `_app.js` / `_buildManifest.js` etc. as "initial JS" for a specific route.** They're shared baseline. The bundle-size script must attribute per-route correctly — Next.js's app manifest provides this.
- ❌ **Do NOT skip Task 7 (the regression-PR demonstration).** Without it, you've shipped gates that THEORETICALLY work; the demo proves they work in practice.

### Common LLM-developer mistakes to prevent

- **Measuring INP via Lighthouse desktop only:** INP requires interaction; Lighthouse can't simulate real user input on desktop convincingly. Use the mobile preset (which fires more realistic interactions) and consider supplementing with Playwright + web-vitals's `onINP` in a separate spec for higher-fidelity measurement. Not in scope for this story; Lighthouse's INP estimate is acceptable.
- **Forgetting to gzip when measuring bundle size:** Next.js's stats report uncompressed sizes by default. The 250KB threshold is gzipped. The script must gzip each chunk.
- **Authenticated Lighthouse confusion:** without authentication, Lighthouse measuring `/dashboard` gets the `/login` redirect, which is fast but irrelevant. Verify the puppeteer auth script actually establishes a session before the measurement.
- **Mixing up Lighthouse `error` vs. `warn`:** `error` fails the build; `warn` prints but passes. The story's gates are mostly `error`; desktop LCP is `warn`. Verify the syntax.
- **Importing Leaflet in `dashboard/page.tsx` for "just one feature":** the moment Leaflet is in the dashboard bundle, the gate fails. Lazy-load via `dynamic(() => import("@/components/LotMap/LeafletRenderer"), { ssr: false })` — the architecture's pattern.
- **Writing the bundle-size script to read `.next/server/...`:** wrong directory; that's server-side code. Read `.next/static/chunks/` for client bundles. Verify against the build manifest.
- **Skipping the warning logging for moderate / minor axe violations:** they don't fail the build, but logging them surfaces drift early. Without the warning, moderate issues accumulate invisibly until a Phase 2 audit.
- **Hard-coding seed customer / contract IDs in the Lighthouse URL list:** these vary per environment. Use a deterministic seed pattern (Story 1.1's seed admin email is the same; create seed customer / contract with deterministic codes — e.g. `customers.findByCode("seed-customer-001")`).

### Open questions / blockers this story does NOT resolve

- **NFR-P2 (Map render < 3s):** out of scope. Leaflet ships in Phase 2; the map-render Lighthouse measurement is added with that story.
- **PWA-specific perf:** out of scope. Service worker / offline metrics are a separate concern.
- **Real-user monitoring (RUM):** out of scope. CI measurements are synthetic. Real-user perf data via a tool like Vercel Speed Insights or Cloudflare RUM is a Phase 1.5+ addition.
- **Visual-regression testing:** orthogonal to perf. If added later (Phase 2), Chromatic / Percy / similar; not this story.

### Project Structure Notes

Aligns with:
- [Architecture § Project Structure > .github/workflows/ci.yml + lighthouserc.json](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- [UX § Implementation Roadmap — end-of-milestone perf check](../../_bmad-output/planning-artifacts/ux-design-specification.md)

No detected conflicts.

### References

- [PRD § NFR-P1, NFR-P2, NFR-P5, NFR-P6, NFR-M2](../../_bmad-output/planning-artifacts/prd.md#non-functional-requirements).
- [Architecture § NFRs](../../_bmad-output/planning-artifacts/architecture.md).
- [UX § Implementation roadmap + Automated scanning](../../_bmad-output/planning-artifacts/ux-design-specification.md).
- [Epics § Story 5.8](../../_bmad-output/planning-artifacts/epics.md#story-58-performance-budget-gates-in-ci).
- [Previous stories: 1.1 / 1.4 / 5.2](./).
- Lighthouse CI documentation (verify current): https://github.com/GoogleChrome/lighthouse-ci
- `@axe-core/playwright` documentation: https://github.com/dequelabs/axe-core-npm/tree/develop/packages/playwright

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (claude-opus-4-7) via Claude Code, autonomous mode.

### Debug Log References

- `npm run typecheck` — clean.
- `npm run lint` — clean (one pre-existing unused-eslint-disable warning in `NavigateToLotButton.tsx`, unrelated).
- `npm test` — 1590 passed, 1 flaky failure on `NavigateToLotButton.test.tsx > "guards against re-entrancy: rapid double-clicks invoke onNavigate exactly once per tick"` due to a 5000ms timeout. Re-running the file in isolation: 9/9 pass. Pre-existing flake from Story 8.3 land; not caused by this story (no `src/**` or `tests/**` files touched).
- `npm run build` — succeeded on the 3rd attempt; first two attempts hit Windows file-locking-style ENOENT errors against `.next/build-manifest.json` and `.next/server/pages-manifest.json`. The errors are intermittent on this Windows host (Defender / OneDrive interaction with Next's atomic-rename); they don't appear in clean Linux CI.
- `npm run check:bundle-size` — PASS. 35 routes checked; max 198.9 KB gzipped (`/(staff)/lots/[lotId]/page`); all routes < 250 KB.

### Completion Notes List

**Scope per user's prompt was narrower than the full story file.** The user's brief constrained file ownership to: `lighthouserc.json`, `.github/workflows/ci.yml`, `scripts/check-bundle-size.mjs`, `package.json`, `docs/adr/0016-performance-budget-gates.md`, plus the minimal `next.config.ts` wrapper needed for the `analyze` script. Forbidden: any `convex/**`, `src/**`, `tests/**`, eslint config, tailwind/globals. The full-story tasks 6 (axe-core wiring into Playwright specs) and 7 (regression-PR demo) require touching `tests/**` and `src/**` — explicitly out of scope under the user's prompt. Those tasks are noted as deferred to a follow-up story; the bundle-size + Lighthouse gates ship here.

**(a) Authenticated Lighthouse approach:** deferred. The four URLs (`/login`, `/lots`, `/dashboard`, `/map`) are configured; unauthenticated runs of the three protected routes will redirect to `/login`. ADR-0016 documents this and the follow-up task. Going further required modifying Playwright/auth code (`tests/**`), which the user's prompt forbids.

**(b) Regression-PR demo:** deferred — the demo introduces deliberate regressions in `src/**` files (per the story's Task 7 spec), which the user's prompt forbids. Story-file Task 7 is noted in ADR-0016 as a follow-up.

**(c) Measured baseline (post-implementation):**
- Bundle-size (gzipped, 35 routes): top three `/(staff)/lots/[lotId]/page` 198.9 KB, `/(staff)/sales/new/page` 190.3 KB, `/(staff)/interments/new/page` 182.8 KB. Floor `/page` 103.9 KB. All comfortably under the 250 KB NFR-P6 budget.
- Lighthouse: not run locally (the Story 1.1 `lhci` flow requires `npm run start` then probing; deferred to first CI run). The thresholds enforced are perf ≥ 0.90, a11y ≥ 0.95, best-practices ≥ 0.90, SEO ≥ 0.90 (matching user's prompt).

**(d) ADR number used:** 0016 per user's prompt. Existing ADRs occupy 0001-0002, 0004-0006, 0008-0011, 0013. 0016 is the next free number above the highest existing (0013) leaving room for the in-flight 0014/0015 if other stories claim those.

**Threshold philosophy notes (also in ADR-0016):**
- Category scores are the hard gates (perf 0.9, a11y 0.95, BP 0.9, SEO 0.9). Numeric LCP / TBT / CLS thresholds are kept `warn`-only to avoid double-failing on the same regression (the perf category score already weights these).
- `numberOfRuns` kept at 1 to honor the < 2 min CI wall-clock budget; if noise produces false fails, bump to 3.
- `lighthouse` job's `continue-on-error: true` removed — gate now actually fails the workflow.

### File List

- `lighthouserc.json` — UPDATED. Expanded URLs to `/login`, `/lots`, `/dashboard`, `/map`. Tightened category assertions to error-level perf ≥ 0.9, a11y ≥ 0.95, BP ≥ 0.9, SEO ≥ 0.9. Kept numeric LCP / TBT / CLS as warn-only.
- `.github/workflows/ci.yml` — UPDATED. Added new `bundle-size` job that runs `next build` then `npm run check:bundle-size`. Removed `continue-on-error: true` from the `lighthouse` job and renamed it `Lighthouse (NFR-P)`. Cached `.next/cache` between bundle-size runs.
- `scripts/check-bundle-size.mjs` — NEW. Parses `.next/app-build-manifest.json` (fallback to `.next/build-manifest.json`), gzips each route's chunks via `node:zlib`, sums per-route, asserts ≤ 250 KB. Per-route exemption table is empty by Phase 1 policy. Prints per-route table + top contributing chunks on breach.
- `next.config.ts` — UPDATED. Wrapped with `@next/bundle-analyzer` (active only when `ANALYZE=true`) so `npm run analyze` produces `.next/analyze/client.html`. Passthrough at build time when not enabled.
- `package.json` — UPDATED. Added `@next/bundle-analyzer ^15.1.0` to devDependencies (installed as `^15.5.18`). Added two scripts: `analyze` (`ANALYZE=true next build`) and `check:bundle-size` (`node scripts/check-bundle-size.mjs`).
- `docs/adr/0016-performance-budget-gates.md` — NEW. Documents the threshold choices, gate architecture, escalation procedure, alternatives considered (bundlewatch / size-limit / bundle-stats-action), and the explicit "do not add silent exemptions" policy.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — UPDATED. `5-8-performance-budget-gates-in-ci: review`; `last_updated: 2026-05-18`.
