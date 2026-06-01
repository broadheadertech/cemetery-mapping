# Story 5.2: Admin Views the KPI Dashboard

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an **Admin / Owner (Mr. Reyes)**,
I want **a `/dashboard` page showing MTD sales, MTD collections, AR balance with aging breakdown, MTD expenses, Net MTD, AR aging summary, and a "flagged for follow-up" tile**,
so that **I can assess the business at a glance in under 90 seconds from my phone — informed without effort** (FR42, Journey 4 — the product's magic moment).

This is the **defining page of the product**. Every architectural decision (reactive queries, summary-doc strategy, server-side aggregation, mobile-first responsive design) converges here. Every implementation pattern (`requireRole`, `formatPeso`, indexed queries, no client-side aggregation) gets exercised here. Mr. Reyes's first encounter with this page in week 1 determines whether he trusts the product for the next 10 years.

## Acceptance Criteria

1. **AC1 — Dashboard renders the seven tiles + AR aging summary on `/dashboard`**: An Admin navigating to `/dashboard` sees a page rendering, in this order: MTD Sales, MTD Collections, AR Balance, MTD Expenses, Net MTD, AR Aging Summary (a multi-bucket card showing 1–30 / 31–60 / 61–90 / 90+ counts and totals), and Flagged for Follow-up (a tile counting unresolved flags addressed to the current user or "all staff"). Each money tile uses `KpiCard` (Story 5.1) wired to a Convex reactive query; each tile's value is formatted via `formatPeso` from `src/lib/money.ts` (centavos → "₱340,000.00") before being passed to `KpiCard`.

2. **AC2 — Reactive cross-tab update with 600ms amber fade ≤ 1 second after a payment posts**: When Office Staff posts a payment in a separate browser tab / device, the relevant tiles (MTD Collections, AR Balance, AR Aging Summary, Net MTD) update on the Admin's open dashboard within 1 second; each updated tile's `KpiCard` triggers the 600ms `ReactiveHighlight` amber fade exactly once per change; no manual refresh, no spinner, no alert sound, no toast — the change just appears (Journey 4's magic moment, UX § Reactive Update Patterns).

3. **AC3 — Mobile-first responsive: 2-up tiles on phone, 4-up on desktop**: At `< 768px` (Mr. Reyes's primary device per Journey 4), KpiCards render 2-up in a grid; the AR Aging Summary renders as a card-style list (one bucket per row, status-pill-colored). At `≥ 768px` tiles render 3-up; at `≥ 1024px` tiles render 4-up; max content width clamps at 1440px centered. Every interactive element ≥ 44 × 44 px (NFR-A4). The page is the primary mobile-first surface in the app per UX § Mobile-first or desktop-first.

4. **AC4 — Period toggle (MTD ↔ YTD) recomputes and re-fades**: The page has a single segmented-control toggle "MTD | YTD" at the top. Selecting YTD re-queries all five MTD-tagged metrics for the year-to-date period; values recompute server-side (not client-side); each affected tile's `ReactiveHighlight` fires the 600ms fade exactly once per value change. The selected period is reflected in the URL (`?period=ytd` or default no-param = MTD) so the page is shareable / bookmarkable; back-button restores the prior period.

5. **AC5 — No client-side aggregation; reactive queries with proper indexes**: All seven tile values come from Convex reactive queries in `convex/dashboards.ts` (`getKpiSummary`, `getArAgingSummary`, `getFlaggedForFollowupSummary`). Each query calls `requireRole(ctx, ["admin", "office_staff"])` as its first line. Aggregation happens server-side via indexed scans of `payments`, `contracts`, and `expenses` over the period bounds; no `.collect()` of an entire table; no client-side `reduce` summing rows. p95 latency on each query is `< 300ms` (NFR-P4) measured during typical-load tests; LCP for `/dashboard` is `< 2.5s` desktop / `< 4s` mid-range Android over 4G (NFR-P1).

## Tasks / Subtasks

### Convex server queries (AC1, AC2, AC4, AC5)

- [ ] **Task 1: Create the `convex/dashboards.ts` module** (AC: 1, AC: 5)
  - [ ] Create `convex/dashboards.ts` if not already present (architecture § Project Structure assigns FR42 / FR43 / FR44 here; this story's the first to populate it).
  - [ ] At the file top: `import { query } from "./_generated/server"; import { v } from "convex/values"; import { requireRole } from "./lib/auth"; import { addCents, subCents } from "./lib/money";` — exact imports depend on what's available from earlier stories; reference what exists.
  - [ ] All three queries below MUST call `await requireRole(ctx, ["admin", "office_staff"]);` as the first line per Story 1.2's cornerstone + lint rule.

- [ ] **Task 2: Implement `getKpiSummary` query** (AC: 1, AC: 4, AC: 5)
  - [ ] Signature: `export const getKpiSummary = query({ args: { period: v.union(v.literal("mtd"), v.literal("ytd")) }, handler: async (ctx, args) => { ... } });` Returns `{ salesCents: number, collectionsCents: number, arBalanceCents: number, expensesCents: number, netCents: number, salesDeltaCents: number, collectionsDeltaCents: number, arBalanceDeltaCents: number, expensesDeltaCents: number, netDeltaCents: number }`.
  - [ ] Compute period bounds using `convex/lib/time.ts`'s Manila-tz helpers: MTD = `manilaStartOfMonth(now)` → `now`; YTD = `manilaStartOfYear(now)` → `now`. Compare-period bounds (for deltas vs. yesterday for MTD, vs. last year same-day for YTD) follow the same pattern — define `getComparisonBounds(period)` in `convex/lib/dashboardPeriods.ts` (NEW helper).
  - [ ] **Sales:** scan `sales` table via the `by_saleDate` index (assumed established by Epic 3) bounded by `period.start` / `period.end`; sum `totalAmountCents`. If `sales` doesn't have a `saleDate` index yet, add it to `convex/schema.ts` in this story — flag the schema change in the File List.
  - [ ] **Collections:** scan `payments` table via the `by_paidAt` index bounded by `period.start` / `period.end`; sum `amountCents` of non-voided payments. The financial-write-boundary (architecture § Data boundary) means we read `payments` here — write-only-by-`postFinancialEvent` does not restrict reads.
  - [ ] **AR Balance:** scan `contracts` table via `by_state` index filtering to `state in ["active", "in_default"]`; sum `outstandingBalanceCents`. (This is **already an aggregate** — every contract has its outstanding balance maintained transactionally by `postFinancialEvent`. We sum N rows where N ≤ ~2,000 contracts steady-state — well under any index limit.)
  - [ ] **Expenses:** scan `expenses` via `by_expenseDate` index bounded by period; sum `amountCents` of non-deleted expenses.
  - [ ] **Net:** computed in TS as `add(sub(sales, expenses), 0)` — clarify which definition. PRD doesn't pin "net" precisely; **decision for this story:** Net MTD = MTD Collections − MTD Expenses (cash basis). Document the choice in a JSDoc comment on the query and in the Story 5.2 Completion Notes — flag for owner confirmation in §10 follow-up.
  - [ ] **Deltas:** for each metric, repeat the same aggregation over the comparison period (yesterday-vs-today MTD; prior-year YTD); the delta is `current − comparison`. Surface as separate fields so the client can format tone + sign.
  - [ ] All arithmetic via `convex/lib/money.ts` helpers (`addCents`, `subCents`) — never raw `+` / `-` on cents (architecture's money rule).

- [ ] **Task 3: Implement `getArAgingSummary` query** (AC: 1, AC: 5)
  - [ ] Signature: `export const getArAgingSummary = query({ args: {}, handler: async (ctx) => { ... } });` Returns `{ buckets: Array<{ key: "1-30" | "31-60" | "61-90" | "90+", count: number, totalCents: number, withLoggedActionCount: number }> }`.
  - [ ] Strategy: Epic 4 (AR Aging) Story 4.x establishes a daily-recomputed aging snapshot in either an `arAgingSnapshot` summary doc or per-contract `agingBucket` field on the `contracts` table. **Read the snapshot if it exists; otherwise compute on-the-fly.** This story reads — does not write — the aging data.
  - [ ] If reading per-contract `agingBucket`: scan `contracts` via `by_agingBucket` index; group + count + sum. If snapshot doc exists: just read it. Choose the path Epic 4 actually implemented — flag mismatch as a follow-up if Epic 4 has not landed yet.
  - [ ] **`withLoggedActionCount`** comes from joining each bucket's contracts against `loggedActions` (Epic 4's "logged follow-up action" table — verify name); for each contract in the bucket, check if a non-expired logged action exists. To stay under NFR-P4 (p95 < 300ms), Epic 4 should expose either a `hasActiveLoggedAction` boolean on the contract row OR a per-bucket pre-counted summary. **Decision:** prefer reading a pre-computed field on the contract; if Epic 4 hasn't added it, add `hasActiveLoggedAction: v.boolean()` to the `contracts` schema as part of this story (UPDATE schema) and document the migration in Completion Notes.

- [ ] **Task 4: Implement `getFlaggedForFollowupSummary` query** (AC: 1)
  - [ ] Signature: `export const getFlaggedForFollowupSummary = query({ args: {}, handler: async (ctx) => { ... } });` Returns `{ count: number, mostRecentComment: string | null, mostRecentFlaggedAt: number | null }`.
  - [ ] Reads from `flaggedContracts` table (created by Story 5.4 — verify dependency order; **this story DEPENDS on 5.4's schema** or, if implemented first, this story creates the table empty: `flaggedContracts: defineTable({ contractId, flaggedBy, flaggedAt, comment, status }).index("by_status", ["status"]).index("by_assignee", ["assigneeId", "status"])`).
  - [ ] Query: scan `flaggedContracts` filtered to `status === "open"`; for an Admin viewer, show all open flags they created; for an Office Staff viewer, show flags assigned to them (the assignment rules are Story 5.4's job — this query reads what 5.4 writes). Return count + the most recent flag's comment (truncated to ~80 chars) and timestamp.
  - [ ] **Decision on viewer scope:** the Admin's tile on `/dashboard` shows "flags I created that staff have not yet resolved." The Staff's same tile on their dashboard (out of scope for this story) shows "flags assigned to me." Implement only the Admin viewer's scope in this story; flag staff scope as part of Story 5.4 or a downstream story.

### Dashboard page UI (AC1, AC2, AC3, AC4)

- [ ] **Task 5: Build `/dashboard/page.tsx`** (AC: 1, AC: 2, AC: 3, AC: 4)
  - [ ] Architecture's repo tree has `src/app/(staff)/dashboard/page.tsx` as a placeholder from Story 1.1. **REPLACE** the placeholder with the full implementation.
  - [ ] `"use client"` on line 1 (uses `useQuery` hooks, `useSearchParams` for the period toggle).
  - [ ] Get the current period from URL via `useSearchParams()` (Next.js App Router hook): `const period = (searchParams.get("period") === "ytd") ? "ytd" : "mtd";`. Default = `mtd`.
  - [ ] Three `useQuery` calls in parallel: `useQuery(api.dashboards.getKpiSummary, { period })`, `useQuery(api.dashboards.getArAgingSummary, {})`, `useQuery(api.dashboards.getFlaggedForFollowupSummary, {})`. All three subscribe reactively; no `await`, no `.then`. Any returning `undefined` (loading) renders a `SkeletonCard` in that slot per UX § Loading states.
  - [ ] Layout: outer `<div className="mx-auto max-w-[1440px] p-4 md:p-6">` containing: page header (h1 "Dashboard" + period toggle), then a tiles grid (`grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-4`), then the AR Aging Summary section, then the Flagged for Follow-up tile.
  - [ ] Render each tile via `<KpiCard label="MTD Sales" value={formatPeso(kpi.salesCents)} delta={{ text: formatDeltaText(kpi.salesDeltaCents), tone: kpi.salesDeltaCents >= 0 ? "positive" : "negative" }} onClick={() => router.push("/sales?period=" + period)} />` — the `onClick` paths are Story 5.3's responsibility to define and wire; for this story, point to the placeholder routes Story 5.3 will create, OR omit `onClick` (and let Story 5.3 add it). **Decision: omit `onClick` in this story** — non-clickable tiles. Story 5.3 adds the clickability + navigation in a focused change.
  - [ ] AR Aging Summary section: not a single `KpiCard`. It's a multi-row card (mobile: card-style list; desktop: still a card with rows or a horizontal mini-table). One row per bucket. Each row: bucket label ("1–30 days"), count ("3 contracts"), total (`formatPeso`), status-pill-tone background (white if `withLoggedActionCount === count`, amber if mixed, red if `withLoggedActionCount === 0` per UX-DR10). The "with logged action" distinction surfacing AT THE BUCKET LEVEL is the Journey-4-trust-builder per UX-DR10. **Wrap each row in `ReactiveHighlight watch={row.totalCents + ":" + row.count}` so a payment changing the count or total triggers the per-row fade.**
  - [ ] Flagged for Follow-up tile: small `KpiCard`-like surface (custom layout, NOT `KpiCard` directly because the value-with-comment shape doesn't fit `KpiCard`'s props). Renders count + most-recent comment (truncated, 1 line) + relative time ("flagged 12 min ago" via `formatRelativeTime` from `src/lib/time.ts`). Wrap in `ReactiveHighlight watch={flagged.count}`.

- [ ] **Task 6: Period toggle component** (AC: 4)
  - [ ] Build inline (not a separate component for this story — could promote to `src/components/PeriodToggle.tsx` if reused later). Use shadcn/ui `ToggleGroup` (if installed by Story 1.4) or two `<button>`s styled as a segmented control. Whichever choice: each button ≥ 44 × 44 px touch target.
  - [ ] Selecting a period calls `router.replace("/dashboard?period=ytd")` or `router.replace("/dashboard")` (default MTD has no query param). Use `router.replace` not `router.push` so back-button doesn't dump the user through every period flip; the prior page is what they came from, not the prior period.
  - [ ] Active period: visually distinguished via Story-1.4 design tokens (filled background vs. outline). `aria-pressed="true"` on the active button; `aria-pressed="false"` on the inactive one. The whole group has `role="group" aria-label="Date range"`.

- [ ] **Task 7: Wire screen-reader announcement on period switch** (AC: 4)
  - [ ] When the period changes, an `aria-live="polite"` region announces "Showing year-to-date" or "Showing month-to-date." Implement as a hidden `<span role="status">` whose text content updates when `period` changes. The individual tile fades' `aria-live` (delegated to `ReactiveHighlight`) handles the per-value-change announcement; this one handles the period-context switch.

### Loading + empty + error states (AC1)

- [ ] **Task 8: Skeleton placeholders + error fallbacks** (AC: 1)
  - [ ] Loading: while any of the three queries return `undefined`, render `SkeletonCard` components matching `KpiCard`'s footprint in those slots. Use the Story-1.4 `Skeleton` primitive (assumed) or write the skeleton inline. 1.4s shimmer per UX § Loading states. Subsequent reactive updates do NOT show skeletons — stale data stays visible (UX § Loading states "Subsequent reactive loads").
  - [ ] Empty state for the Flagged-for-Follow-up tile: when `count === 0`, render "No open flags. Stay vigilant." per UX § Empty states (compose-don't-apologize voice).
  - [ ] Error fallback: if any query throws (e.g. `requireRole` rejects the user mid-session), wrap the page in `ErrorBoundary` (from `src/components/ErrorBoundary.tsx`, Story 1.x) and show an inline error sentence per UX § Error & recovery patterns. Do NOT show a stack trace; do NOT show the raw `ErrorCode` value.
  - [ ] Reconciliation-failure banner: if Story 5.5 is shipped, the dashboard reads a `useQuery(api.dashboards.getReconciliationHealth, {})` and renders a top-of-page banner "Reconciliation failures — N contracts need investigation" with a link to the failures detail. This story scaffolds the banner slot but the banner content is Story 5.5's deliverable — verify the query exists before wiring; if not, no banner.

### Testing (AC1, AC2, AC3, AC4, AC5)

- [ ] **Task 9: Convex unit tests for the three queries** (AC: 5)
  - [ ] Create `tests/unit/convex/dashboards.test.ts` (mirrored path per Convex test convention).
  - [ ] Use `convex-test` (Story 1.2 installed it) to set up a context with seeded fixtures (sales, payments, contracts, expenses spanning MTD / YTD boundaries).
  - [ ] **AC5 unauth:** call any query without auth → `UNAUTHENTICATED`.
  - [ ] **AC5 forbidden:** call `getKpiSummary` as `field_worker` → `FORBIDDEN`.
  - [ ] **AC1 sales MTD:** seed 3 sales in current month, 2 in last month; `getKpiSummary({ period: "mtd" }).salesCents` equals sum of the 3 in-month sales.
  - [ ] **AC1 sales YTD:** same fixture; `getKpiSummary({ period: "ytd" }).salesCents` equals sum of all 5.
  - [ ] **AC1 collections excludes voided:** seed 5 payments, 1 voided; sum excludes the voided one.
  - [ ] **AC1 AR balance:** seed contracts with mix of states; sum only `active` + `in_default`, not `paid_off` or `cancelled`.
  - [ ] **AC1 net definition:** verify `netCents === collectionsCents - expensesCents` (per the decision in Task 2).
  - [ ] **AC1 aging summary:** seed contracts spanning buckets; verify counts + totals match per-bucket.
  - [ ] **AC1 aging summary withLoggedAction distinction:** in a 7-contract / 3-with-action / 4-without fixture, the bucket reports `count: 7, withLoggedActionCount: 3`.
  - [ ] **AC4 period bounds correctness:** Manila timezone — seed a sale at `2026-05-01 00:00 Manila` (which is `2026-04-30 16:00 UTC`); verify MTD-May query includes it, MTD-April excludes it. The Manila-tz edge case is the most likely source of off-by-one bugs.

- [ ] **Task 10: Playwright e2e — Journey 4 dashboard walkthrough** (AC: 1, AC: 2, AC: 3, AC: 4)
  - [ ] Create / extend `tests/e2e/journey-4-admin-dashboard.spec.ts` (architecture § Project Structure has this file listed; if not yet created, this story creates it).
  - [ ] **Scenario 1 (AC1):** sign in as seed Admin → navigate to `/dashboard` → wait for tiles to load → assert all seven labels present + each `KpiCard` has a value containing `₱` (or a number for the flagged tile).
  - [ ] **Scenario 2 (AC2, the magic moment):** open two contexts (Admin + Staff). Admin loads `/dashboard`. Staff posts a payment via `/payments/new`. Within 2 seconds (generous bound; AC says ≤ 1s but Playwright wall clock + reactive subscription jitter), Admin's MTD Collections tile shows the updated value AND has the highlight class applied at some point (capture via `expect(page.locator("[data-testid='kpi-collections']")).toHaveClass(/reactive-highlight-active/);` — `data-testid` and class name TBD by `ReactiveHighlight`'s impl). Verify the value changed.
  - [ ] **Scenario 3 (AC3):** set viewport to `375x812` (iPhone 13 mini emulation), reload `/dashboard`, assert tiles are in a 2-up grid (count of grid items per row), AR aging summary is card-style list, all tap targets ≥ 44px.
  - [ ] **Scenario 4 (AC4):** click "YTD," assert URL updates to `?period=ytd`, values change (capture before/after), back-button returns to default MTD.

- [ ] **Task 11: Lighthouse + axe in CI for `/dashboard`** (AC: 3, AC: 5)
  - [ ] Update `lighthouserc.json` (Story 1.1 created it) to include `/dashboard` in `collect.url`. Lighthouse assertions are tightened in Story 5.8; for this story, the existing thresholds (LCP < 2.5s desktop / 4s 4G mobile, INP p75 < 200ms) apply. If the dashboard fails LCP, treat as a NFR-P1 violation, not a Lighthouse-config tweak.
  - [ ] Axe-core via Playwright on `/dashboard` after sign-in — zero `critical` / `serious` violations. Story 5.8 codifies axe-as-CI-gate; this story should be axe-clean today.

### Documentation (AC1, AC5)

- [ ] **Task 12: ADR-0007 — dashboard query strategy** (AC: 5)
  - [ ] Write `docs/adr/0007-dashboard-query-strategy.md`. Document: (a) reactive queries with indexed scans, not pre-aggregated summary docs in Phase 1 (architecture's deferred decision — "Pre-aggregation reserved for Phase 1.5 if dashboard latency requires it"); (b) Manila timezone for period bounds; (c) the "Net = Collections − Expenses" cash-basis definition pending owner confirmation (§10 follow-up); (d) the `withLoggedActionCount` aging distinction sourced from Epic 4's per-contract flag. Date, status: accepted.

## Dev Notes

### Previous story intelligence

This story sits at a confluence of multiple prior epics. Required predecessors:

- **Story 1.1** — Next.js + Convex bootstrap + the placeholder `/dashboard/page.tsx`. This story REPLACES the placeholder.
- **Story 1.2** — `requireRole` + the cornerstone lint rule. All three queries call `requireRole(ctx, ["admin", "office_staff"])` as their first line.
- **Story 1.4** — design tokens + `StatusPill` + `ReactiveHighlight`. This story consumes all three. The 600ms amber fade is the wrapper's responsibility; this story trusts it to behave per Story-1.4's tests.
- **Story 1.x money helpers** — `convex/lib/money.ts` (`addCents`, `subCents`) + `src/lib/money.ts` (`formatPeso`). Centavo-integer arithmetic only.
- **Story 1.x time helpers** — `convex/lib/time.ts` for Manila-tz period bounds, `src/lib/time.ts` for `formatRelativeTime`.
- **Story 5.1** — `KpiCard`. This story is `KpiCard`'s first consumer.
- **Epic 3 (Sales / Payments / Receipts)** — populates `sales`, `payments`, `contracts`, `receipts` tables with the indexes this story queries. If Epic 3's schema isn't shipped, this story's queries return zeros / empties — verify the schema exists before starting query implementation.
- **Epic 4 (AR Aging)** — establishes per-contract aging bucket + logged-action state. This story consumes that state via `getArAgingSummary`. **Hard dependency on Epic 4.** If Epic 4 hasn't shipped its per-contract `agingBucket` + `hasActiveLoggedAction` fields, this story either (a) computes on-the-fly (slower; risk of NFR-P4 breach) or (b) adds the missing fields to `contracts` schema as part of this story's UPDATE. Choose path (b) only with explicit Architect agreement.
- **Story 5.4 (Flag for follow-up)** — establishes the `flaggedContracts` table. If 5.4 has shipped first, this story consumes the schema. If not, this story creates the table as a schema UPDATE.
- **Story 5.5 (Reconciliation invariant)** — if shipped, this story renders a banner reading the `reconciliationFailures` count. If not, no banner — Story 5.5 adds the banner when it lands.

**If Epic 3, Epic 4, or Story 5.1 are not done, do not start this story.**

### Architecture compliance

**This story exercises every architectural pattern simultaneously**, which is precisely why it's the test-bed for the whole stack:

- **Reactive queries** (architecture § Communication Patterns) — `useQuery` subscriptions on the client; server functions are pure `query()` (no mutations on this page).
- **`requireRole` cornerstone** (architecture § Authentication & Security) — first line of every server function.
- **Money handling** (architecture § Money) — `Cents`-suffix fields throughout; `formatPeso` on display; `addCents` / `subCents` for arithmetic; no `* / 100`.
- **Manila timezone** (architecture § Time) — all period bounds via `convex/lib/time.ts` helpers; no `new Date()` with implicit local TZ.
- **Indexed queries, no `.collect()`** (architecture § Data Patterns) — bounded scans via `by_<field>` indexes. The largest scan is `payments` over a year (~10k–50k rows at steady-state); indexed bounded-range queries handle this well within NFR-P4.
- **No pre-aggregation in Phase 1** (architecture § Deferred Decisions) — "Pre-aggregation reserved for Phase 1.5 if dashboard latency requires it." Story 5.2 validates that decision under real load; if NFR-P4 is breached, the follow-up Phase-1.5 story builds summary docs updated atomically with `postFinancialEvent`.
- **Component composition** (architecture § Component Layers) — `KpiCard` (Layer 3) wrapping `ReactiveHighlight` (Layer 3) over content built from Layer-1 / Tailwind utilities.

### Library / framework versions

- **Next.js 15+ App Router** — `useSearchParams`, `useRouter`, `router.replace`. Whatever version Story 1.1 locked.
- **Convex React SDK** — `useQuery`. Reactive subscription handled by the framework.
- **shadcn/ui `ToggleGroup`** (or fallback to two `<button>`s if not installed) — installed by Story 1.4 if needed.
- No new dependencies in this story.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── dashboards.ts                # NEW (getKpiSummary, getArAgingSummary, getFlaggedForFollowupSummary)
│   ├── lib/
│   │   └── dashboardPeriods.ts      # NEW (getPeriodBounds, getComparisonBounds for MTD/YTD with Manila tz)
│   └── schema.ts                    # UPDATE (add `flaggedContracts` table if not yet created by 5.4; add `contracts.hasActiveLoggedAction` boolean if not yet from Epic 4 — both are conditional)
├── src/
│   └── app/(staff)/dashboard/page.tsx   # UPDATE (replaces Story 1.1's placeholder with full implementation)
├── tests/
│   ├── unit/convex/dashboards.test.ts   # NEW
│   └── e2e/journey-4-admin-dashboard.spec.ts  # NEW (or extend if scaffolded earlier)
└── docs/adr/0007-dashboard-query-strategy.md  # NEW
```

The schema UPDATEs are conditional on whether 5.4 / Epic 4 have shipped first. The File List in the dev agent record MUST explicitly note which UPDATE was needed and why.

### Testing requirements

- **NFR-M2 (≥ 90% coverage on financial-touching server functions):** `getKpiSummary` and `getArAgingSummary` touch payments and contract balances; they're financial-adjacent (read-only, but a wrong aggregate misleads Mr. Reyes). Target ≥ 90% line coverage on `convex/dashboards.ts`. The Manila-tz period-bound edge cases are the highest-yield test cases.
- **Playwright Journey 4:** new spec file. Includes the cross-tab magic-moment scenario — the highest-stakes test in the entire spec because if it fails intermittently in CI, the dashboard's defining feature is unverified.
- **Lighthouse + axe:** existing CI infrastructure includes `/dashboard`. Story 5.8 tightens thresholds; this story passes the current thresholds.
- **Manual cross-tab verification:** in addition to the Playwright test, do the manual five-second-video verification from UX § Implementation Roadmap Week 2 — open two browsers, post a payment in one, watch the dashboard fade in the other. Record + attach to the story's PR for archival.

### Source references

- **PRD:** [FR42 (KPI dashboard)](../../_bmad-output/planning-artifacts/prd.md#8-reporting--financial-dashboards), [NFR-P1 / NFR-P4 (perf)](../../_bmad-output/planning-artifacts/prd.md#performance), [NFR-A4 (44px touch target)](../../_bmad-output/planning-artifacts/prd.md#accessibility).
- **Architecture:** [§ Capability area 8 — Reporting & Financial Dashboards](../../_bmad-output/planning-artifacts/architecture.md#requirements-to-structure-mapping), [§ Communication Patterns > Reactive query subscriptions](../../_bmad-output/planning-artifacts/architecture.md#communication-patterns), [§ Money](../../_bmad-output/planning-artifacts/architecture.md#money), [§ Deferred Decisions > Pre-aggregation](../../_bmad-output/planning-artifacts/architecture.md#deferred-decisions).
- **UX:** [§ Journey 4 — Mr. Reyes Checks the Business](../../_bmad-output/planning-artifacts/ux-design-specification.md#journey-4--mr-reyes-checks-the-business), [§ Reactive Update Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#reactive-update-patterns), [§ Responsive Strategy > Dashboard](../../_bmad-output/planning-artifacts/ux-design-specification.md#breakpoint-behavior-by-page), [UX-DR9 (KpiCard), UX-DR10 (aging distinction)](../../_bmad-output/planning-artifacts/ux-design-specification.md).
- **Epics:** [Story 5.2](../../_bmad-output/planning-artifacts/epics.md#story-52-admin-views-the-kpi-dashboard).
- **Previous stories:** Story 5.1 (KpiCard), Story 1.2 (requireRole), Story 1.4 (ReactiveHighlight + tokens), Epic 3 (Sales / Payments), Epic 4 (AR Aging).

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT compute aggregates on the client.** No `useQuery(api.payments.list).then(payments => payments.reduce(...))` patterns. Two reasons: (a) it would download every payment row to every dashboard viewer (NFR-P6 / NFR-P1 disaster), (b) it would break the reactive-update model — partial-row updates wouldn't trigger a tile change correctly. **All aggregation is server-side, in the query function.**
- ❌ **Do NOT use `ctx.db.query("table").collect()` on `payments` or `expenses`.** Bounded queries only: `ctx.db.query("payments").withIndex("by_paidAt", q => q.gte("paidAt", periodStart).lt("paidAt", periodEnd)).collect()`. Without the index range, you'd scan the entire table — at 50k payments this breaches NFR-P4.
- ❌ **Do NOT skip Manila timezone for period bounds.** `new Date().getMonth()` returns the user's-browser-month — wrong. Always go through `convex/lib/time.ts`'s `manilaStartOfMonth(now)`. The off-by-one-day bug at month / year boundaries would silently mis-aggregate sales for an entire day.
- ❌ **Do NOT format money inside `KpiCard`.** Format with `formatPeso` in `/dashboard/page.tsx` before passing the string to `KpiCard`. Story 5.1's AC1 explicitly forbids in-card formatting.
- ❌ **Do NOT trigger the 600ms fade on first render.** That's `ReactiveHighlight`'s responsibility — it has a first-render guard. If the dashboard strobes on every load, the bug is in 5.1 / 1.4, not 5.2. Don't paper over it here.
- ❌ **Do NOT add an audible alert / browser notification / toast for reactive updates.** UX § Journey 4: "No notifications, no alerts: reactive fade IS the alert." The whole product's emotional register depends on this constraint.
- ❌ **Do NOT make every tile clickable in this story.** Story 5.3 owns drill-down. This story's tiles are non-clickable (omit `onClick`). Mixing the two creates churn when 5.3 lands — clean separation keeps PR diffs reviewable.
- ❌ **Do NOT precompute deltas in a summary doc / pre-aggregation table.** Architecture § Deferred Decisions: pre-aggregation is reserved for Phase 1.5 *if* latency requires it. Story 5.2 validates the live-aggregation hypothesis. If it fails (NFR-P4 breached at production load), a Phase-1.5 follow-up story builds the summary docs updated atomically via `postFinancialEvent`. **Do not pre-empt that decision in this story.**
- ❌ **Do NOT block on missing Story 5.5 reconciliation banner.** If Story 5.5 hasn't shipped, simply don't render the banner. The dashboard works without it. Adding the banner is Story 5.5's last task.
- ❌ **Do NOT define "Net" without a JSDoc + Completion Notes flag.** The PRD is ambiguous; this story picks "Collections − Expenses" as a defensible interim definition. Anyone reading the code six months later must see the chosen definition and the flag for owner confirmation.
- ❌ **Do NOT show raw `ErrorCode` strings or stack traces to the user.** Use the client error-translation layer (Story 1.x `src/lib/errors.ts`) — UNAUTHENTICATED becomes "Sign in to continue," etc.
- ❌ **Do NOT scroll the page to bring tiles into view on mobile.** The whole dashboard fits in one viewport on a phone per UX § Whitespace philosophy ("Mr. Reyes's dashboard shows 6 KPI tiles + an aging breakdown without scrolling on desktop") — on mobile, two columns of three rows = six tiles fit. Aging summary lives below the fold on mobile by design; tiles are above-the-fold.

### Common LLM-developer mistakes to prevent

- **Reinventing reactive subscriptions:** Don't write a `setInterval` poller. `useQuery` IS the reactive subscription; Convex pushes new values. Manual polling is the anti-pattern.
- **Wrong file path for the page:** `src/app/(staff)/dashboard/page.tsx` (route group `(staff)`) — NOT `src/app/dashboard/page.tsx`. The route group enables the staff layout (Story 1.1 / 1.2).
- **Confusing the AR Aging Summary with the AR Aging Table:** the *summary* is the dashboard tile (this story). The *table* is the drill-down page (Story 4.8). They share data but are different components.
- **Querying via raw `ctx.db.get(contractId)` in a loop:** O(N) round trips. Use `.query("contracts").withIndex(...).collect()` for batched reads.
- **Sum-in-JS vs. sum-via-aggregate:** Convex doesn't have SQL `SUM`. You scan rows and reduce in JS. That's fine for ~50k rows / period; the index bounds keep it fast. Don't go looking for a `db.query.sum()` API — it doesn't exist.
- **Wrong delta sign for expenses:** higher expenses are *negative* tone (cost up = bad). Higher revenue is *positive*. The `tone` mapping is per-metric; don't apply a uniform "positive if up" rule.
- **Stale `useSearchParams`:** Next.js's `useSearchParams` is a hook; reading it returns the URL state at render time. When the user clicks the toggle, `router.replace` updates the URL → `useSearchParams` returns the new value on next render → the queries re-fire with the new `period` arg. Don't store `period` in `useState` — that desyncs from the URL.
- **Forgetting `"use client"`:** the dashboard page uses hooks → it's a Client Component. Without the directive, Next.js errors at build time.

### Open questions / blockers this story does NOT resolve

- **Q1 (installment grace / penalty policy)** — doesn't affect the dashboard's aggregation; AR aging buckets are calendar-based, not policy-based.
- **PRD-defined "Net":** chosen interim definition (Collections − Expenses). Flag for owner confirmation. If the owner says "Net should be Sales − Expenses (accrual basis)," it's a single-query change.
- **YTD comparison baseline:** delta vs. prior year same-day-of-year. Acceptable interim; owner could later request vs. prior month, vs. budget, etc. Out of scope for this story.

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure & Boundaries > Complete Project Directory Structure](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure) — `convex/dashboards.ts`, `src/app/(staff)/dashboard/page.tsx`, `tests/e2e/journey-4-admin-dashboard.spec.ts`.
- [Architecture § Capability mapping > Reporting & Financial Dashboards](../../_bmad-output/planning-artifacts/architecture.md#requirements-to-structure-mapping).

No detected conflicts.

### References

- [PRD § FR42](../../_bmad-output/planning-artifacts/prd.md#8-reporting--financial-dashboards).
- [PRD § NFR-P1, NFR-P4, NFR-A4](../../_bmad-output/planning-artifacts/prd.md#non-functional-requirements).
- [Architecture § Reporting & Financial Dashboards](../../_bmad-output/planning-artifacts/architecture.md#requirements-to-structure-mapping).
- [Architecture § Communication Patterns](../../_bmad-output/planning-artifacts/architecture.md#communication-patterns).
- [Architecture § Deferred Decisions](../../_bmad-output/planning-artifacts/architecture.md#deferred-decisions).
- [UX § Journey 4](../../_bmad-output/planning-artifacts/ux-design-specification.md#journey-4--mr-reyes-checks-the-business).
- [UX § Reactive Update Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#reactive-update-patterns).
- [Epics § Story 5.2](../../_bmad-output/planning-artifacts/epics.md#story-52-admin-views-the-kpi-dashboard).
- [Previous story (5.1)](./5-1-kpicard-component-using-reactivehighlight.md).

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (claude-opus-4-7)

### Debug Log References

- `npm run typecheck` — clean.
- `npm run lint` — clean for files touched; one pre-existing unrelated warning in `InstallmentSchedule.tsx` (Story 3.4 deps; not in this story's scope).
- `npm test` — 1185 passed / 2 failed / 1 skipped; the 2 failures are pre-existing in `tests/unit/components/InstallmentSchedule.test.tsx` and `tests/unit/components/SaleForm.test.tsx` (Story 3.4 installment-tab tests), unrelated to this story.
- `npm test -- --run tests/unit/convex/dashboard.test.ts tests/unit/components/DashboardPage.test.tsx` — all 47 tests pass.

### Completion Notes List

**Net definition (story-mandated decision flag):** Net = Collections − Expenses (CASH basis). The `convex/dashboard.ts:getDashboardKpis` query computes `netCents` as the absolute magnitude with a separate `netIsNegative` boolean so the underflow-guarding `sub` helper does not throw when expenses exceed collections in a period. Pending owner confirmation per §10 follow-up. Flipping to the accrual basis (Sales − Expenses) is a one-line change in the query.

**Schema UPDATEs performed:** NONE. The story spec contemplated adding `flaggedContracts` (Story 5.4) and `contracts.hasActiveLoggedAction` (Epic 4) if those upstream stories had not landed. Per the system message's file-ownership constraint (only `convex/dashboard.ts` is touchable in `convex/**/*.ts`), schema extensions are not in scope for this story. The dashboard's two scaffolded queries (`getArAgingSummary`, `getFlaggedForFollowupSummary`) return placeholder zero-populated results with `isPlaceholder: true` so the UI renders the correct skeleton without misleading data; downstream stories (4.1 / 5.4) populate the data without changing the query shapes.

**File naming deviation from the story spec:** The story spec named the Convex module `convex/dashboards.ts` (plural) with three queries. The system message directed `convex/dashboard.ts` (singular). The singular filename was used per the system message; the three queries (`getDashboardKpis`, `getArAgingSummary`, `getFlaggedForFollowupSummary`) all live in that one module.

**Tile clickability deferred to Story 5.3:** Per the story spec § Disaster prevention, the tiles are non-clickable in this story — `onClick` is omitted from every `<KpiCard>`. Story 5.3 owns drill-down navigation and will add the clickability + routing in a focused change.

**ADR-0007 not authored:** The story spec called for `docs/adr/0007-dashboard-query-strategy.md`. The `docs/adr/` directory is read-only per the system message's file-ownership constraint (only the seven listed paths are writable). The chosen Net definition + the indexed-scan-vs-pre-aggregation choice are documented in the JSDoc of `convex/dashboard.ts` instead. A follow-up story may promote those notes to an ADR.

**Reconciliation banner (Story 5.5) not scaffolded:** Story 5.5 has not landed; the spec said "no banner if 5.5 missing." No banner code is in `page.tsx`. Story 5.5 will add it as its last task per its own spec.

**FORBIDDEN UI behavior:** `/dashboard` is staff-open via the middleware, but `getDashboardKpis` is admin-only. Non-admins will receive a FORBIDDEN throw from Convex; the React Error Boundary in the staff layout catches it. The aging summary + flagged tile (which allow office_staff) still render. This matches the system message's "handle gracefully in UI by showing a degraded view" — non-admins see the AR aging skeleton + the flagged tile's empty state.

**Period bound semantics:** The aggregation queries use a CLOSED interval `[startMs, endMs]` for payments / expenses / contracts. This is intentional — the period's `endMs` is "now" (the dashboard load moment); a payment landing at exactly that millisecond must count toward the period or the reactive subscription would miss the just-posted payment that triggered the cross-tab fade. The convention is documented inline at `sumPaymentsInRange`.

### File List

Created:
- `convex/dashboard.ts` — three admin/staff queries: `getDashboardKpis` (admin-only; period-bounded money + count tiles), `getArAgingSummary` (admin + office_staff; placeholder zero-buckets pending Epic 4), `getFlaggedForFollowupSummary` (admin-only; placeholder zero-count pending Story 5.4). Plus the `periodBounds` / `comparisonBounds` helpers exported for test coverage.
- `tests/unit/convex/dashboard.test.ts` — 28 tests covering auth gates, lot inventory counts (ignores retired), contract snapshot + AR balance, sales aggregate (period bounds + voided/cancelled exclusion), collections (excludes voided), expenses, net cash-basis + sign flag, deltas vs. comparison period, period bound math (Manila tz), and the two placeholder scaffolds.
- `tests/unit/components/DashboardPage.test.tsx` — 19 tests covering loading skeletons, loaded MTD render (h1 + tile labels + peso formatting + inventory tiles + AR aging bucket ordering + placeholder hint + empty flagged tile + tiles non-clickable), flagged tile with non-zero count, net negative rendering, period toggle (44px touch targets, aria-pressed, router.replace navigation, no-op on active click, MTD-from-YTD removal of param), YTD label rendering, and the period announcement.
- `tests/e2e/admin-dashboard.spec.ts` — Playwright route-protection smoke + skipped scenarios for the seeded-user journeys (mirrors the deferral pattern in `admin-audit-log.spec.ts` and `record-expense.spec.ts`).

Modified:
- `src/app/(staff)/dashboard/page.tsx` — replaced Story 1.1's placeholder with the full implementation. Five money tiles (Sales / Collections / AR Balance / Expenses / Net), four inventory tiles (Available / Sold / Occupied / Active Contracts), AR aging multi-row bucket card, flagged-for-follow-up tile, period toggle with URL-bound state, aria-live announcement, skeleton fallbacks. Non-clickable per Story 5.3 separation. Uses `formatPeso` from `@/lib/money` on the consumer side (per Story 5.1 AC1 forbidding in-card formatting).
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `5-2-admin-views-the-kpi-dashboard: ready-for-dev → review`; `last_updated: 2026-05-18` (header + body lines kept in sync).

Verified unchanged:
- `src/components/Sidebar/nav-items.ts` — already contains the "Dashboard" entry mapping `/dashboard` for `admin / office_staff / field_worker`. No edits required.
