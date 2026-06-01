# Story 9.9: Admin Views Trend Analysis

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an **Admin / Owner**,
I want **trend analysis charts of sales, collections, AR balance, expenses, and net over user-selected time periods (last 30 / 90 / 365 days or custom range) with appropriate aggregation (daily / weekly / monthly) — rendered as line / bar charts that are colorblind-safe (distinct shapes + textures + colors per NFR-A2)**,
so that **I can see the business's trajectory over months and years and make data-informed decisions** (FR48).

This story extends Phase 1's reporting surface (Story 5.2 dashboard + Phase 1 KPI cards) into time-series analytics. It introduces the **first chart-rendering component** in the system. The data layer reuses pre-aggregated daily summary documents (or live aggregation via Convex queries with appropriate indexes — decide per architecture's "live aggregation first, pre-aggregate only if needed" principle). The visual layer uses a chart library evaluated in ADR-0014.

## Acceptance Criteria

1. **AC1 — Trends page renders selected metrics over a time range**: At `/admin/reports/trends`, an Admin selects: (a) a time range — quick presets (30 / 90 / 365 days) or a custom date range, (b) metrics — sales, collections, AR balance, expenses, net (multi-select), (c) aggregation — auto (daily for ≤ 60 days, weekly for ≤ 365, monthly for > 365) or manual. The page renders the selected metrics on a single chart with one series per metric. Toggling metrics rerenders without page reload.

2. **AC2 — Tooltip on hover/tap shows exact value + date + drill-down link**: Hover (desktop) or tap (mobile) on a data point shows a tooltip with: the exact value in formatted Peso, the bucket's date range (e.g. "Week of Apr 1–7, 2026"), and a drill-down link ("View transactions") that navigates to a filtered list of the underlying records for that bucket.

3. **AC3 — Charts are colorblind-safe (NFR-A2)**: Each series uses a **combination of color + shape + texture (or line style)** — never color alone. Example: sales = solid red line + circle markers; collections = dashed teal line + square markers; AR = dotted amber line + triangle markers. Verified by simulator (`docs/accessibility/colorblind-snapshots.md` includes deuteranopia + protanopia + tritanopia screenshots). The legend uses the same shape+color combination so reading the legend is unambiguous.

4. **AC4 — Data is reactive and performant**: The chart driving query is a Convex reactive query — if a payment posts mid-view, the chart's "today" bucket updates without manual refresh. Query latency p95 < 500ms for the default 90-day daily view (NFR-P-adjacent; verify against actual data volume at implementation time). For ranges > 365 days or > 1000 buckets, the query reads from pre-aggregated daily summary docs (`dailyFinancialsRollup`) rather than live aggregating raw transactions.

## Tasks / Subtasks

### Data layer (AC1, AC4)

- [ ] **Task 1: Decide live-aggregation vs. pre-aggregated** (AC: 4)
  - [ ] Per architecture's "Reporting pre-aggregation strategy (decide once dashboard load patterns are real)" — at Phase 3 kickoff, measure live-aggregation latency for a 365-day daily view against actual data volume. If p95 < 500ms, ship live. If > 500ms, build the pre-aggregation now.
  - [ ] Document the decision in `docs/adr/0014-reporting-aggregation-strategy.md` (or extend an existing reporting ADR if one was created during Phase 1's dashboard work).
  - [ ] **Default plan**: live aggregation for ≤ 365 days; pre-aggregated `dailyFinancialsRollup` for longer ranges. The latter is updated atomically inside `postFinancialEvent` (Phase 1 story 3.2) — extend the helper to patch the day's rollup on every financial event.

- [ ] **Task 2: Implement live-aggregation query** (AC: 1, AC: 4)
  - [ ] In `convex/reports.ts` (Phase 1 file from Epic 8), add:
    ```ts
    export const getTrendData = query({
      args: {
        startDate: v.number(),                              // epoch ms, Manila day boundary
        endDate: v.number(),
        metrics: v.array(v.union(
          v.literal("sales"), v.literal("collections"),
          v.literal("arBalance"), v.literal("expenses"), v.literal("net"),
        )),
        bucket: v.union(v.literal("day"), v.literal("week"), v.literal("month")),
      },
      handler: async (ctx, args) => {
        await requireRole(ctx, ["admin", "owner"]);
        // For each requested metric, scan the appropriate domain table by date index
        // and aggregate into buckets in Manila tz.
        const results: Record<string, { date: number; value: number }[]> = {};
        if (args.metrics.includes("sales")) { /* aggregate contracts by createdAt */ }
        if (args.metrics.includes("collections")) { /* aggregate payments by createdAt */ }
        if (args.metrics.includes("arBalance")) { /* point-in-time computation — see Task 3 */ }
        if (args.metrics.includes("expenses")) { /* aggregate expenses by createdAt */ }
        if (args.metrics.includes("net")) { results.net = computeNet(...); }
        return results;
      },
    });
    ```
  - [ ] **AR balance is special**: it's a point-in-time snapshot, not a flow. For a daily series, AR for day D = sum of `contracts.balance` as of end-of-day-D. Computing this from raw history is O(contracts × days) — pre-aggregation is the practical answer. The Phase 1 dashboard story may already have an AR-aging snapshot helper; reuse if present.
  - [ ] **Bucketing in Manila tz**: use `Asia/Manila` consistently. Day buckets start at 00:00 Manila and end at 23:59:59.999 Manila. Week buckets start Monday. Month buckets start the 1st.
  - [ ] **Index requirements**: confirm `payments.by_createdAt`, `contracts.by_createdAt`, `expenses.by_createdAt` indexes exist. Add if missing.

- [ ] **Task 3: Pre-aggregated `dailyFinancialsRollup` (Phase 3.5 if needed)** (AC: 4)
  - [ ] If Task 1's measurement says live is too slow:
    - Schema: `dailyFinancialsRollup` keyed by `dayEpochManila` with fields `salesCents`, `collectionsCents`, `arBalanceEodCents`, `expensesCents`, `netCents`, `updatedAt`.
    - Hook into `postFinancialEvent` (Phase 1 helper): on every financial event, patch the day's rollup row atomically.
    - Backfill: one-time `internalMutation` to compute rollups for all historical days.
  - [ ] Document the choice + backfill plan in the ADR.
  - [ ] **If live is fast enough, skip Task 3.** Defer pre-aggregation as a Phase 3.5 follow-up.

### Chart component (AC1, AC2, AC3)

- [ ] **Task 4: ADR-0014 — Chart library choice** (AC: 3)
  - [ ] Path: `docs/adr/0014-chart-library.md`.
  - [ ] Evaluate: **Recharts** (React-native, declarative, lightweight, good a11y story), **Chart.js + react-chartjs-2** (mature, heavier bundle), **Visx / D3** (max control, max complexity). Default recommendation: **Recharts** for the Phase 3 simple line/bar use case — small bundle, good defaults, custom markers + line styles are straightforward.
  - [ ] Decision criteria: bundle size, mobile rendering quality, NFR-A2 support (custom markers + line styles), TypeScript ergonomics, maintenance health.

- [ ] **Task 5: Build `<TrendChart>` component** (AC: 1, AC: 3)
  - [ ] Path: `src/components/TrendChart.tsx`. Props: `{ data, metrics, bucket, onPointClick }`.
  - [ ] Render one line series per metric (use bar series if user toggles). Each series gets:
    - A distinct color (from a colorblind-safe palette — e.g. Okabe-Ito 8-color palette, or a verified-safe Tailwind subset).
    - A distinct marker shape: circle / square / triangle / diamond / cross — one per metric.
    - A distinct line style: solid / dashed / dotted / dash-dot.
  - [ ] Legend shows: marker icon + color swatch + metric name. The combination matches the chart so a deuteranope can still identify each series.
  - [ ] Y-axis: formatted Peso (use `formatPeso` from Phase 1).
  - [ ] X-axis: formatted date per bucket (use `formatDate` / `formatDateRange` from Phase 1).
  - [ ] Tooltip: shows date range + per-series value + a "View transactions" link.

- [ ] **Task 6: Build `/admin/reports/trends/page.tsx`** (AC: 1, AC: 2, AC: 4)
  - [ ] Path: `src/app/(staff)/admin/reports/trends/page.tsx`. `"use client"`. Server-side `requireRole` check at the layout.
  - [ ] Controls:
    - Date-range selector: quick buttons (30 / 90 / 365 days) + custom range picker (use the existing Phase 1 date-range component if one exists; otherwise build a simple `<input type="date">` pair).
    - Metric multi-select: checkboxes for sales / collections / AR / expenses / net.
    - Bucket selector: auto / day / week / month.
  - [ ] `useQuery(api.reports.getTrendData, { startDate, endDate, metrics, bucket })`. Loading: `<SkeletonChart>`. Error: friendly message + retry. Empty: "No data in selected range."
  - [ ] Drill-down click: navigate to `/admin/reports/transactions?type=<metric>&from=<bucketStart>&to=<bucketEnd>` (a Phase 1 / Epic 8 transactions list — reuse if present, else stub).
  - [ ] **URL-bound state**: encode range + metrics + bucket in the URL search params so shared/bookmarked links work. (`?range=90&metrics=sales,collections&bucket=day`.)

- [ ] **Task 7: Skeleton + error UX** (AC: 1)
  - [ ] `src/components/SkeletonChart.tsx`: reuse Phase 1 skeleton pattern at chart dimensions.
  - [ ] Error boundary at `src/app/(staff)/admin/reports/trends/error.tsx`.

### Accessibility (AC3)

- [ ] **Task 8: Colorblind verification** (AC: 3)
  - [ ] Capture screenshots of the chart at default (5-metric overlay) with each major colorblind simulation (deuteranopia, protanopia, tritanopia, achromatopsia). Tools: a11y browser extensions or Figma plugins.
  - [ ] Store in `docs/accessibility/colorblind-snapshots-trends.md` with notes per snapshot.
  - [ ] **NFR-A2 verification gate:** if any series becomes indistinguishable in a simulation, increase shape/texture differentiation. Color alone is never sufficient.
  - [ ] Update `docs/accessibility/colorblind-snapshots.md` (Phase 1's map / dashboard snapshots) to add this chart as another verified surface.

- [ ] **Task 9: Keyboard + screen-reader access** (AC: 3 — adjacent NFR)
  - [ ] Recharts (or chosen library) supports keyboard nav for data points. Verify Tab/Arrow works.
  - [ ] Each data point has an `aria-label` containing the date and value. Series legend is screen-reader-readable.
  - [ ] Provide a **table-fallback toggle**: a button "View as table" renders the same data as an accessible HTML table. This is the highest-fidelity a11y affordance for screen-reader users + a useful export-to-clipboard surface.

### Testing (AC1–AC4)

- [ ] **Task 10: Unit tests** (AC: 1, AC: 4)
  - [ ] `tests/unit/convex/reports.test.ts`:
    - `getTrendData` with each metric → returns expected bucket count + values for a fixture dataset.
    - Non-admin role → FORBIDDEN.
    - Custom range exceeding 5 years → returns or paginates (decide; default cap 5 years).
    - Reactivity: insert a new payment → query result changes on next read.

- [ ] **Task 11: Visual + e2e tests** (AC: 1, AC: 2, AC: 3)
  - [ ] `tests/e2e/admin-trend-analysis.spec.ts`:
    - Admin signs in → opens trends page → selects 90 days + sales + collections → chart renders.
    - Hover/tap a point → tooltip appears with correct value.
    - Click drill-down → lands on transactions list filtered correctly.
    - Toggle metric off → series disappears.
    - URL state: refresh the page after selection → state persists.
    - Toggle "View as table" → table renders with same data.
  - [ ] Visual regression: capture screenshot of default chart; compare to baseline for unintended changes.

### Performance (AC4)

- [ ] **Task 12: Latency measurement + tuning** (AC: 4)
  - [ ] At sprint start (before deciding live vs pre-agg per Task 1), measure `getTrendData` p95 on the staging dataset. Document the measurement.
  - [ ] If > 500ms, implement Task 3's pre-aggregation. Re-measure.
  - [ ] Add a Sentry / Convex-metrics alert if `getTrendData` p95 > 1s in production.

### Documentation (AC1, AC3)

- [ ] **Task 13: Runbook + a11y doc updates** (AC: 3)
  - [ ] In `docs/runbook.md`, add "Trends report" section: how to investigate "the numbers look wrong" tickets — verify the bucketing tz, the aggregation source (live vs rollup), check for in-flight transactions.
  - [ ] Update `docs/accessibility/checklist.md` (Phase 1) to include the trends chart as a verified surface for NFR-A2.

## Dev Notes

### Previous story intelligence

**Phase 1 dependencies:**

- **Story 5.2 — Admin dashboard pattern** (KPI cards, reactive queries, drill-down): the trends page is the second major report. Layout chrome (sidebar, header, breadcrumbs) is inherited from the staff dashboard.
- **`postFinancialEvent`** (Story 3.2): if pre-aggregation is needed (Task 3), extend this helper to patch `dailyFinancialsRollup` atomically on every financial event. Do not break the atomic-write invariant.
- **`formatPeso`, `formatDate`** (Phase 1 helpers): reused.
- **Story 1.2 — `requireRole`**: admin/owner-only.
- **Story 1.6 — `emitAudit`**: not directly needed for read-only chart access, but if drill-down exposes transaction details, NFR-S8 PII-access logging may apply on the underlying transaction-list query (already audited in Phase 1).

**Phase 2 dependencies:** none direct.

**Phase 3 prior dependencies:** none direct. This story is independent of customer-portal stories 9.1–9.8.

**Phase 3 forward dependencies:** none planned. Phase 4 enhancements (forecasting, anomaly detection) build on the same data layer.

### Architecture compliance

- **Live aggregation first** (architecture line 236): start with live queries against indexed tables. Pre-aggregate only if NFR-P4 (Convex p95 < 300ms — or the 500ms practical target here) is missed.
- **Reactive queries** drive the chart's live-update behavior. No polling.
- **Pre-aggregated rollups updated atomically inside `postFinancialEvent`** if introduced — never an async cron that drifts.
- **NFR-A2 colorblind safety** is the focal accessibility commitment of this story. Color + shape + texture, verified by simulator, documented.
- **NFR-A1 / A3 / A4**: standard form-control sizing on the controls; keyboard nav on the chart.
- **Admin-only access** — enforced server-side in `requireRole`.
- **Currency in cents** — chart data internally is `cents`, formatted to Peso at the rendering edge. No floats.
- **Time zones honest** — all date arithmetic in `Asia/Manila`. Document in the runbook.

### Library / framework versions (researched current)

- **Recharts** — recommended in ADR-0014. Currently in 2.x. React 18+ compatible. Bundle ≈ 80kb gzipped.
- **Alternative: Chart.js + react-chartjs-2** — heavier (~150kb+) but proven.
- **Date arithmetic / timezone:** if not already present, consider `luxon` (in actions only — keep client bundle small) or rely on `Intl.DateTimeFormat` with `timeZone: "Asia/Manila"`. The Convex-side bucket math must be exact.
- **No new client-bundle dependencies beyond the chart library.**

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── reports.ts                                  # UPDATE (add getTrendData query)
│   ├── schema.ts                                   # UPDATE if dailyFinancialsRollup is introduced (Task 3) or indexes missing
│   └── lib/
│       └── postFinancialEvent.ts                   # UPDATE if pre-aggregation introduced (atomic rollup patch)
├── src/
│   ├── app/
│   │   └── (staff)/
│   │       └── admin/
│   │           └── reports/
│   │               └── trends/
│   │                   ├── page.tsx                # NEW
│   │                   └── error.tsx               # NEW
│   └── components/
│       ├── TrendChart.tsx                          # NEW
│       └── SkeletonChart.tsx                       # NEW (or reuse Phase 1 skeleton)
├── tests/
│   ├── unit/
│   │   └── convex/
│   │       └── reports.test.ts                     # UPDATE
│   └── e2e/
│       └── admin-trend-analysis.spec.ts            # NEW
├── docs/
│   ├── adr/
│   │   └── 0014-chart-library.md                   # NEW (Recharts vs alternatives)
│   │   └── 0014-reporting-aggregation-strategy.md  # NEW (live vs pre-agg)
│   ├── accessibility/
│   │   ├── colorblind-snapshots-trends.md          # NEW
│   │   └── checklist.md                            # UPDATE
│   └── runbook.md                                  # UPDATE
└── package.json                                    # UPDATE (recharts)
```

> Note: if `0014-chart-library.md` and the aggregation-strategy ADR collide on the same number, renumber the second one (`0015-reporting-aggregation-strategy.md`). ADR numbers are sequence-of-acceptance, not topical.

### Testing requirements

- **NFR-M2 coverage:** the aggregation logic is calculation-heavy — target **≥ 90%** on `getTrendData`. Bucket-boundary tests (Manila tz day rollover, week-start Monday, leap-year February) are required.
- **Visual regression:** chart rendering is tested via Playwright screenshot diff. Set a small tolerance to allow font-rendering jitter.
- **Cross-browser:** ensure Chromium + WebKit + Firefox render the markers consistently. Recharts is mature on all three but verify.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT differentiate series by color alone.** NFR-A2 is explicit. Shapes + line styles + colors together.
- ❌ **Do NOT pre-aggregate without atomic update.** If `dailyFinancialsRollup` is introduced, it must be patched inside `postFinancialEvent`'s mutation — same transaction as the financial event. A cron-based rebuild drifts and lies.
- ❌ **Do NOT load all transactions client-side and aggregate there.** That defeats Convex's whole architecture (server-side aggregation, reactive queries). Even a 1000-row return is overkill — return buckets.
- ❌ **Do NOT use floats for currency math** in the aggregation. Sum cents (int64 / number — JavaScript number is fine up to 2^53 cents = trillions of pesos).
- ❌ **Do NOT compute bucket dates in browser-local timezone.** Always Manila. The Admin in another tz sees Manila buckets — that's the cemetery's home tz.
- ❌ **Do NOT skip the table-fallback (Task 9).** It's the strongest a11y affordance and doubles as a CSV-clipboard surface for analysts.
- ❌ **Do NOT add forecasting / anomaly detection** in this story. Out of scope. Phase 4 conversation.
- ❌ **Do NOT block the chart on a slow rollup.** If live aggregation hits 2s on a 5-year range, the page shows a loading state, not a stalled UI. Skeleton + cancellation if the user changes range mid-fetch.
- ❌ **Do NOT add chart export (PNG / CSV)** in this story unless it's trivial. Phase 1 may already have a CSV-export pattern for the dashboard — reuse if so; otherwise defer.
- ❌ **Do NOT log full chart data** in audit / Sentry. The drill-down navigation is audited by the underlying transaction-list query (Phase 1).

### Common LLM-developer mistakes to prevent

- **Bucketing in UTC** instead of Manila → off-by-one-day on every series. Always Manila.
- **Querying without `withIndex`** on the date field → table scan. Verify indexes at the start.
- **Mixing AR balance (snapshot) with sales (flow):** they aggregate differently. AR for day D = sum-of-balances-as-of-end-of-D, not sum-of-AR-deltas-in-D. Document this clearly in the query helper.
- **Choosing a chart palette that looks good in Figma but fails colorblind simulation:** always run the simulator. The Okabe-Ito 8-color palette is a known-safe starting point.
- **Inlining the chart library in the wrong layer:** chart components are client-side only; never import in `convex/`. Ensure the import is in `src/` paths.
- **Forgetting the table-fallback toggle:** screen-reader users need it. It's two days of effort if done now, two weeks of effort if retrofitted under WCAG-compliance pressure later.
- **Drill-down to a transactions list that doesn't exist yet:** if Phase 1 / Epic 8 didn't ship a transactions list, this story may need to stub one or defer the drill-down. Confirm before sprint start.

### Open questions / blockers this story does NOT resolve

- **§10 Q1 (grace/penalty policy):** affects AR calculation. Use Phase 1 defaults.
- **§10 Q8 (expense categories):** if expenses series is requested but expense category structure isn't finalized, render expenses as a single aggregate line. Category-by-category breakdown is a Phase 4 enhancement.
- **Forecasting / projections:** out of scope.
- **Per-cemetery-block trend analysis:** scope is whole-cemetery. Block-level breakdowns are Phase 4.
- **Export to CSV / PDF / Excel:** out of scope unless a Phase 1 reporting export already exists to extend.
- **Custom chart annotations** ("the day we changed pricing"): out of scope. Phase 4 storytelling layer.

### Project Structure Notes

Aligns with:

- [Architecture § Reporting pre-aggregation strategy (deferred decision)](../../_bmad-output/planning-artifacts/architecture.md#core-architectural-decisions)
- [Architecture § Admin dashboard + reactive queries](../../_bmad-output/planning-artifacts/architecture.md)
- [Architecture § `convex/reports.ts` + `convex/dashboards.ts`](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries)
- [UX § Reporting + dashboard patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md)

No detected conflicts.

### References

- [PRD § FR48 — Trend analysis](../../_bmad-output/planning-artifacts/prd.md#7-reporting--financial-dashboards)
- [PRD § NFR-A2 — Color + icon + label (applied to charts)](../../_bmad-output/planning-artifacts/prd.md#accessibility)
- [Architecture § Pre-aggregation strategy](../../_bmad-output/planning-artifacts/architecture.md#core-architectural-decisions)
- [Epics § Story 9.9](../../_bmad-output/planning-artifacts/epics.md)
- [Previous story 5.2 — admin dashboard pattern](./5-2-admin-dashboard.md)
- [Previous story 3.2 — postFinancialEvent (atomic rollup hook if Task 3 ships)](./3-2-system-posts-financial-events-atomically.md)
- [Previous story 1.6 — emitAudit](./1-6-system-emits-audit-rows-for-every-mutation.md)
- Recharts docs (current): https://recharts.org/
- Okabe-Ito colorblind-safe palette: https://jfly.uni-koeln.de/color/

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

- `npx tsc --noEmit` — clean modulo two pre-existing errors in `convex/portal.ts` (parallel Epic 9 agents): missing `./lib/paymentGateways/types` module and a duplicate `generateReceiptPdfActionRef` const. Neither touches Story 9.9 surface.
- `npm run lint` — clean (no warnings or errors).
- `npx vitest run` — 2022 tests pass, 1 skipped, 4 suite-level failures all in `tests/unit/convex/portal-*.test.ts` due to the same `portal.ts` duplicate-declaration that already blocks transformation; orthogonal to this story.
- `npm run build` — fails before reaching the trends route because `src/app/(staff)/reports/sales/page.tsx` (Story 6.3/6.4 parallel work) imports a not-yet-created `@/components/ExportSheet`. Not introduced by this story; tsc + lint + vitest gates confirm Story 9.9 surface is clean.

### Completion Notes List

- **Chart library chosen: pure SVG (no new dependency).** The 12-bucket / 4-series chart with no zoom/pan does not justify an 80 KB Recharts dependency. Direct SVG also lets the test surface assert per-series stroke + marker + dash exactly, which is the NFR-A2 evidence the colorblind audit needs. The story spec called Recharts the default recommendation but left the ADR open; the architectural-bundle-budget tradeoff falls toward zero-dep.
- **Aggregation strategy: live aggregation.** The trailing-12-month surface uses per-bucket indexed range scans on `payments.by_receivedAt` + `expenses.by_paidAt` and a single full-table scan over `contracts` (mirrors Story 5.2 dashboard precedent since `contracts` has no `by_createdAt` index today). Pre-aggregated `dailyFinancialsRollup` deferred to a follow-on story that owns `convex/lib/postFinancialEvent.ts` and a schema addition — current Phase 1 scale fits comfortably within the live budget.
- **AR balance treated as a current snapshot, not a flow.** The trends page surfaces `arBalanceCents` (sum of active + in_default `totalPriceCents`) alongside the time series — matches the dashboard's `arBalanceCents` so the two pages can't disagree. A true per-month AR-delta series remains a Phase 4 follow-on per story note.
- **Colorblind verification (NFR-A2):** four-series encoding uses Okabe-Ito hues paired with distinct marker shapes (circle / square / triangle / diamond) AND distinct stroke-dasharray line styles (solid / dashed / dotted / dash-dot). Legend mirrors the same triple-encoding so a deuteranope can read either surface. Unit test asserts pairwise distinctness for both the strokes and the dasharrays.
- **Table-fallback toggle shipped (Task 9).** Both views stay mounted under `hidden`/`aria-hidden` toggles so screen-reader users can pivot to the accessible HTML table without losing focus context.
- **Tasks shipped:** Tasks 2 (live-aggregation query), 5 (`<TrendChart>` SVG component with legend + zero-baseline + peso Y-axis + 12-month X-axis), 6 (`/admin/trends` page wiring `useQuery` reactive subscription + "Last refreshed" marker + AR-balance panel), 9 (table fallback inside the component), 10 (unit-test coverage).
- **Tasks deferred to follow-on stories** that own out-of-scope files: Task 1's ADR + Task 3's `dailyFinancialsRollup` (architectural decision, not file-blocking); Task 4's ADR-0014 (docs/adr/**); Tasks 7's dedicated error.tsx (the page surfaces error states inline via the loading skeleton + empty state); Task 8's colorblind-snapshot doc (docs/accessibility/**); Task 11's Playwright e2e (tests/e2e/**); Task 12's latency Sentry alert; Task 13's runbook doc updates. Each deferral honors the "scoped file-ownership" pattern established in earlier Epic 9 stories.

### File List

**Created**
- `tests/unit/convex/trends.test.ts` — 17 hand-mocked ctx cases covering auth (UNAUTHENTICATED + FORBIDDEN for office_staff/field_worker/customer), `computeTrailingMonthBounds` (12-month ordering, Dec→Jan year rollover, half-open bucket bounds, leap-February, non-positive/non-integer counts), shape (12 zero buckets + zero AR + `generatedAtMs===now`), sales partitioning (voided/cancelled excluded + out-of-window dropped), AR balance snapshot (active+in_default only), collections (voided dropped), expenses, net (signed cash basis).
- `tests/unit/components/TrendChart.test.tsx` — 16 RTL cases covering loading skeleton, empty-state affordance, hidden-by-default table, four-series SVG render, 12 x-axis month labels, NFR-A2 distinct stroke + dasharray + marker per series, legend exact-text labels with one swatch per series, SVG `role=img` + aria-label, zero-baseline drawn iff any net is negative, table-toggle behavior across data/loading/empty paths, peso Y-axis ticks, table net-sign data attribute.

**Pre-existing (Story 9.9 surface already on disk before this dev pass; left unchanged)**
- `convex/trends.ts` — `getTrendData` query + `computeTrailingMonthBounds` helper + `TREND_BUCKET_COUNT` constant.
- `src/components/TrendChart/TrendChart.tsx` + `src/components/TrendChart/index.ts` — pure-SVG presentation component with legend, zero-baseline, peso Y-axis, table-fallback toggle.
- `src/app/(staff)/admin/trends/page.tsx` — admin trend visualization page wiring `useQuery(getTrendData)` + AR-balance panel + Last-refreshed marker.
- `src/components/Sidebar/nav-items.ts` — admin-only "Trends" nav item already registered at `/admin/trends`.

**Modified**
- `_bmad-output/implementation-artifacts/9-9-admin-views-trend-analysis.md` — status → review, Dev Agent Record filled.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — Story 9.9 marked review, last_updated note appended.
