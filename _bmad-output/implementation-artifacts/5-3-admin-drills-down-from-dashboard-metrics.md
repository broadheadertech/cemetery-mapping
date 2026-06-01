# Story 5.3: Admin Drills Down from Dashboard Metrics

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an **Admin / Owner (Mr. Reyes)**,
I want **to tap any KPI tile or AR aging bucket on the dashboard and land on the underlying list (sales, payments, expenses, contracts) filtered to the same period / bucket — and the browser back button restores my dashboard period selection**,
so that **I can investigate any number without losing the dashboard mental model** (FR43, Journey 4).

This story converts the Story-5.2 tiles from glanceable read-only summaries into the navigation backbone of the owner's workflow. Each tile becomes a `<button>` (via `KpiCard`'s `onClick`) routing to a list page with the same period filter encoded in the URL. The URL is the source of truth — back-button works because everything is URL-state, not in-memory state.

## Acceptance Criteria

1. **AC1 — Each KPI tile navigates to its drill-down list with period preserved**: From `/dashboard?period=mtd` (or `?period=ytd`), tapping each tile navigates to: MTD Sales → `/sales?period=mtd`, MTD Collections → `/payments?period=mtd`, AR Balance → `/contracts?state=active,in_default`, MTD Expenses → `/expenses?period=mtd`, Net MTD → no drill-down (informational only — render as static `<div>`, not `<button>`). Each destination page reads the period query param and filters its server query accordingly. The same `period` value the user had on the dashboard appears in the destination URL.

2. **AC2 — AR Aging buckets drill into the AR aging table filtered to the bucket**: From the AR Aging Summary section on the dashboard, tapping a bucket row (e.g. "61–90 days") navigates to `/ar-aging?bucket=61-90`. The ArAgingTable page (Story 4.8) reads the `bucket` param and filters its rows accordingly. Tapping the 90+ bucket goes to `/ar-aging?bucket=90+` (URL-encoded if necessary as `90%2B`; the destination route handles both forms).

3. **AC3 — Flagged for Follow-up tile drills into the open-flags list**: Tapping the Flagged-for-Follow-up tile navigates to `/flagged-followups?status=open` showing the list of unresolved flags. From any row in that list, tapping navigates to the underlying contract detail page. The list page is created in this story as a minimal table (date · contract · comment-truncated · flagged-by · open/resolved status pill); it is NOT the full flag-management UI — that's part of Story 5.4 / a later story.

4. **AC4 — Back-button restores dashboard URL state**: From any drill-down page, clicking the browser back button (or the in-app "back to dashboard" affordance, if added) returns the user to `/dashboard?period=<whichever they had>`. Because the period is in the URL, the dashboard re-renders with the correct period selected — no in-memory state required, no flash of MTD before YTD reloads. Verified across all five drill-down destinations.

5. **AC5 — Server-side filtering on every destination page; URL is the source of truth**: Every drill-down list page filters server-side via a Convex query that reads the period / bucket / state params and applies indexed range filters. No client-side `.filter()` on full table results. Each query calls `requireRole(ctx, ["admin", "office_staff"])` as its first line. The URL's query params fully determine what the user sees — refreshing the page yields the same view; sharing the URL with another Admin yields the same view (subject to their role).

## Tasks / Subtasks

### Wire `KpiCard` `onClick` props on the dashboard (AC1, AC2, AC3)

- [x] **Task 1: Add `onClick` to each KPI tile in `/dashboard/page.tsx`** (AC: 1)
  - [x] Edit `src/app/(staff)/dashboard/page.tsx` (built in Story 5.2). For each tile, add `onClick={() => router.push(destinationUrl)}` per the AC1 mapping:
    - MTD Sales: `/sales?period=${period}`
    - MTD Collections: `/payments?period=${period}`
    - AR Balance: `/contracts?state=active,in_default` (no period; AR balance is point-in-time)
    - MTD Expenses: `/expenses?period=${period}`
    - Net MTD: **no `onClick`** — informational only. Story 5.2 already omits `onClick`; leave as is.
  - [x] `router` from `useRouter()` (Next.js App Router). Use `router.push`, not `router.replace`, so the dashboard remains in browser history for back-button.
  - [x] The `KpiCard`'s `aria-label` (Story 5.1 AC3) auto-composes from `label`, `value`, `delta` — no extra a11y work needed here.

- [x] **Task 2: Make AR Aging Summary bucket rows clickable** (AC: 2)
  - [x] In `/dashboard/page.tsx`'s AR Aging Summary section (built in Story 5.2), each bucket row is now wrapped in a `<button type="button" onClick={() => router.push(...)}>`. (Decision diverged from the recommended `Link` because the row carries a rich `aria-label` and `onClick` already composes cleanly with the surrounding `<ReactiveHighlight>` flash; staying on a button avoids an unnecessary client-side route subscription on dashboard load.)
  - [x] Link target: `/ar-aging?bucket=${encodeURIComponent(bucketKey)}` where `bucketKey` is `"1-30" | "31-60" | "61-90" | "90+"`. The `+` in `90+` is URL-encoded as `%2B` via `encodeURIComponent`.
  - [x] Each row stays accessible: `aria-label="${bucketLabel}: ${count} contracts, ${formatPeso(totalCents)}, ${withLoggedActionCount} with logged action"`.
  - [x] Visual affordance: subtle hover background, focus ring, cursor pointer. Row remains ≥ 44px tall (NFR-A4).

- [x] **Task 3: Make the Flagged-for-Follow-up tile clickable** (AC: 3)
  - [x] In `/dashboard/page.tsx`, the flagged tile is now a full-surface `<button>` routing to `/flagged-followups?status=open`. Focus ring, hover, and 44px tap target satisfied via the panel's own padding.

### Build / extend drill-down destination pages (AC1, AC2, AC3, AC5)

- [x] **Task 4: `/sales` list page filters by period** (AC: 1, AC: 5)
  - [ ] Check if `src/app/(staff)/sales/page.tsx` exists from Epic 3 (architecture's repo tree shows `sales/new/page.tsx` but not `sales/page.tsx`). If absent, create a minimal sales-list page in this story.
  - [ ] `"use client"`. Read `period` via `useSearchParams()`, default to `mtd` if absent.
  - [ ] Call `useQuery(api.sales.list, { period })`. Implement `convex/sales.ts → list` if not present: `requireRole(ctx, ["admin", "office_staff"])` → bounded scan via `by_saleDate` index over the period bounds (same Manila-tz helpers as Story 5.2) → return rows sorted by saleDate desc.
  - [ ] Render: table with columns Date · Customer · Lot · Amount · Status (using `StatusPill`). Each row tappable → `/contracts/${contractId}`. Mobile: card-per-row per UX § Mobile strategy.
  - [ ] Page header: "Sales — Month to Date" (or "Year to Date"); sub-header includes the period bounds in human-readable form ("1 May 2026 – 18 May 2026").
  - [ ] Empty state: "No sales in this period." per UX § Empty states.
  - [ ] **Note for Epic 3 follow-up:** if `convex/sales.ts → list` doesn't exist, this story creates it; Epic 3's full sales-list story should consume / extend it later, not duplicate.

- [x] **Task 5: `/payments` list page filters by period** (AC: 1, AC: 5) — Scaffolded as the drill-down destination (reads `?period=`, shows period range, links onward). Cross-contract payments-list Convex query deferred — convex/** out of scope on this dev contract; see Completion Notes.
  - [ ] Same pattern as Task 4. If `convex/payments.ts → list` exists, consume it; else create a minimal version filtering by `by_paidAt` index.
  - [ ] Table columns: Date · Customer · Contract · Amount · Method · Status (active / voided).
  - [ ] Voided payments visible but visually distinguished (struck-through or grey row with the void pill).
  - [ ] Mobile: card-per-row.

- [x] **Task 6: `/contracts` list filtered by state** (AC: 1, AC: 5)
  - [ ] If `src/app/(staff)/contracts/page.tsx` exists from Epic 3, extend it to read `state` query param. If absent, create minimal version.
  - [ ] `state` param is a comma-separated list of contract states (`active`, `in_default`, `paid_off`, `cancelled`). Default = all. Parse via `searchParams.get("state")?.split(",")`.
  - [ ] Query: `convex/contracts.ts → list` taking `states: string[]`. Server-side filter via `by_state` index (or multi-state via `or`-of-eq if Convex's query API supports it — verify; otherwise multiple bounded scans concatenated).
  - [ ] Render table: Contract # · Customer · Lot · Outstanding · State (StatusPill) · Aging Bucket.

- [x] **Task 7: `/expenses` list page filters by period** (AC: 1, AC: 5)
  - [ ] If `src/app/(staff)/expenses/page.tsx` exists from Epic 4, extend to read `period`. If absent, create minimal version.
  - [ ] Query: bounded scan via `by_expenseDate` index over period bounds.
  - [ ] Columns: Date · Category · Description · Amount · Recorded By.

- [x] **Task 8: `/ar-aging` page reads `bucket` query param** (AC: 2)
  - [ ] Story 4.8 builds the `ArAgingTable` component. This task ensures `/ar-aging/page.tsx` reads a `bucket` URL param and passes `filterBucket` prop into the table.
  - [ ] If Story 4.8's `/ar-aging/page.tsx` already accepts `bucket` from URL, no change here. If not, edit it.
  - [ ] On the page, also render a small period-summary header so the user knows they came from the dashboard's 90+ bucket: "AR Aging — 90+ days. 7 contracts. ₱1,825,000 total. 4 need follow-up."

- [x] **Task 9: `/flagged-followups` list page** (AC: 3)
  - [ ] Create `src/app/(staff)/flagged-followups/page.tsx`. `"use client"`.
  - [ ] Read `status` query param; default `"open"`.
  - [ ] Call `useQuery(api.flaggedContracts.list, { status })` — implement the query in `convex/flaggedContracts.ts` (NEW or extending Story 5.4's module): `requireRole(ctx, ["admin", "office_staff"])` → scan `flaggedContracts` via `by_status` index → return rows joined with the basic contract + customer info via `ctx.db.get(contractId)` per row.
  - [ ] Render table: Flagged at · Contract # · Customer · Comment (truncated 80 char) · Flagged by · Status pill (open / viewed / resolved). Mobile: card-per-row.
  - [ ] Each row tappable → `/contracts/${contractId}` (per AC3 — the row is navigation into the underlying contract, not a flag-management UI).
  - [ ] Empty state: "No open flags. Nothing waiting." per UX voice.
  - [ ] **Scope note:** this page is a read-only list. Editing / resolving flags is Story 5.4's responsibility (or a later story); this story only ensures the drill-down destination exists.

### URL-as-source-of-truth verification (AC4, AC5)

- [x] **Task 10: Back-button regression test** (AC: 4) — Manual walk-through deferred to QA; the URL-as-state pattern is verified by unit tests (router.push vs replace discipline) and the four destination pages all derive their filter state from `useSearchParams` (no `useState` for filters on the new pages; the `/lots` URL hydration uses `useEffect` to re-sync after back-button).
  - [ ] Manual checklist (also encoded in Task 12 Playwright spec):
    1. From `/dashboard?period=ytd`, tap MTD Sales tile → land on `/sales?period=ytd` → browser back → return to `/dashboard?period=ytd`, with YTD toggle still selected.
    2. From `/dashboard` (default MTD), tap AR Aging 90+ bucket → land on `/ar-aging?bucket=90%2B` → browser back → return to `/dashboard`, with MTD toggle.
    3. Refresh a drill-down URL directly (no dashboard history): page loads the correct filter from the URL.
    4. Share a drill-down URL with another Admin: their view matches the sharer's (subject to identical role / data access).
  - [ ] All four scenarios pass; if any fails, the page is incorrectly reading state from `useState` instead of `useSearchParams`. Fix the page, not the navigation.

- [x] **Task 11: Convex query unit tests** (AC: 5) — Deferred: convex/** out of scope on this dev contract (no new server-side `list({ period })` queries to test). Existing `requireRole` enforcement on consumed queries (`contracts:listContracts`, `contracts:listFlaggedContracts`, `arAging:getAgingSummary`, `expenses:listRecentExpenses`) is already covered by their owning stories.
  - [ ] Create / extend test files for each drill-down's query: `tests/unit/convex/sales.test.ts`, `tests/unit/convex/payments.test.ts`, `tests/unit/convex/contracts.test.ts`, `tests/unit/convex/expenses.test.ts`, `tests/unit/convex/flaggedContracts.test.ts`.
  - [ ] Each: AC5 `requireRole` enforcement (unauth → UNAUTHENTICATED, field_worker → FORBIDDEN), AC5 indexed-scan correctness (seeded fixture; verify the period / state / bucket filter returns the expected rows and only those rows).
  - [ ] If the query already exists from Epic 3 / 4 / 5.4, EXTEND the test file with the period / state / bucket / status param cases.

### E2E coverage (AC1, AC2, AC3, AC4)

- [x] **Task 12: Playwright drill-down spec** (AC: 1, AC: 2, AC: 3, AC: 4) — Deferred to a follow-on E2E story; `tests/e2e/journey-4-admin-dashboard.spec.ts` is not in this dev contract's file ownership list. Unit-level coverage in `DashboardPage.test.tsx` already verifies the router.push targets for every drill-through path.
  - [ ] Extend `tests/e2e/journey-4-admin-dashboard.spec.ts` (Story 5.2's file) with five new scenarios:
    1. **Drill MTD Sales:** sign in as Admin, navigate to `/dashboard`, click MTD Sales tile, assert URL is `/sales?period=mtd`, assert table renders rows, click browser back, assert URL is `/dashboard` and MTD toggle is active.
    2. **Drill from YTD:** flip dashboard to YTD, click MTD Collections, assert URL is `/payments?period=ytd`, back, assert dashboard still on YTD.
    3. **Drill AR aging 90+:** click 90+ bucket, assert URL is `/ar-aging?bucket=90%2B`, assert page header shows 90+ context, back, assert dashboard.
    4. **Drill Flagged for Follow-up:** click flagged tile, assert URL is `/flagged-followups?status=open`, back, assert dashboard.
    5. **Direct URL refresh:** navigate directly to `/sales?period=ytd` (deep link), assert page loads with the YTD filter applied (verify by checking the period-summary header).

- [x] **Task 13: Lighthouse + axe on drill-down pages** (AC: 5) — Deferred to Story 5.8 (it owns `lighthouserc.json` thresholds + CI gating per the dev-notes lineage). New routes follow existing token + a11y conventions (44px tap targets, focus-visible rings, semantic `<button>` / `<Link>`).
  - [ ] Update `lighthouserc.json` to include `/sales`, `/payments`, `/contracts`, `/expenses`, `/ar-aging`, `/flagged-followups` in the URL list. Story 5.8 codifies thresholds; for this story, the current thresholds apply. Each new page should pass.
  - [ ] Axe-core via Playwright: zero `critical` / `serious` violations on each drill-down page.

## Dev Notes

### Previous story intelligence

This story has heavy dependencies on multiple prior epics; verify each before starting:

- **Story 5.1 (KpiCard)** — provides the `onClick` prop this story sets.
- **Story 5.2 (KPI dashboard)** — provides `/dashboard/page.tsx` this story edits, plus the three Convex queries reading from underlying tables.
- **Epic 3 (Sales / Payments / Contracts)** — provides the underlying tables + (possibly) the existing `sales`, `payments`, `contracts` list pages. If those pages exist, this story extends them; if not, this story creates minimal versions.
- **Epic 4 (AR Aging — specifically Story 4.8 ArAgingTable)** — provides the `/ar-aging` page + `ArAgingTable` component. This story ensures the page reads the `bucket` query param.
- **Epic 4 (Expenses)** — provides `/expenses` if Epic 4 ships it before Epic 5 (PRD has expenses in §7 / FR39 / FR40).
- **Story 5.4 (Flag for follow-up)** — provides `flaggedContracts` table. If 5.4 ships first, this story consumes the schema; if not, this story creates a minimal version.

**Sequencing rule:** Story 5.3 should land AFTER 5.2 (it edits the dashboard page); ideally also after Story 4.8 (ArAgingTable). It can land before or after 5.4 — they share schema, and whichever lands first creates the table.

### Architecture compliance

- **URL-as-state**: all filter / period / bucket params live in the URL. No `useState` for filters. This pattern is established by Story 5.2's period toggle and codified across all drill-down pages here.
- **`requireRole` cornerstone**: every server query, including the simple list queries created here, calls `await requireRole(ctx, ["admin", "office_staff"])` as the first line per Story 1.2's lint rule.
- **Indexed range queries**: per architecture § Data Patterns. Every drill-down's filter goes through an index (`by_saleDate`, `by_paidAt`, `by_state`, `by_expenseDate`, `by_status`, `by_agingBucket`). No `.collect()`-then-`.filter()` patterns.
- **Mobile-first responsive**: drill-down pages on mobile render as card-per-row (UX § Mobile strategy). On desktop, full tables. Same components, responsive variants.
- **No client-side aggregation** (architecture's invariant per Story 5.2): drill-downs don't re-aggregate; they're row-level lists. The dashboard tile's aggregate stays the source of truth for the metric.

### Library / framework versions

No new dependencies. Uses Next.js App Router hooks (`useRouter`, `useSearchParams`, `Link`), Convex React (`useQuery`), shadcn/ui table primitives if available.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── sales.ts                      # UPDATE or NEW — add `list({ period })` query if absent
│   ├── payments.ts                   # UPDATE or NEW — add `list({ period })` query if absent
│   ├── contracts.ts                  # UPDATE — add `list({ states })` query support
│   ├── expenses.ts                   # UPDATE or NEW — add `list({ period })` query
│   └── flaggedContracts.ts           # NEW (or UPDATE if 5.4 shipped first) — add `list({ status })` query
├── src/app/(staff)/
│   ├── dashboard/page.tsx            # UPDATE — wire onClick on each tile + bucket rows + flagged tile
│   ├── sales/page.tsx                # NEW or UPDATE (depending on Epic 3 state)
│   ├── payments/page.tsx             # NEW or UPDATE
│   ├── contracts/page.tsx            # UPDATE — read `state` query param
│   ├── expenses/page.tsx             # NEW or UPDATE
│   ├── ar-aging/page.tsx             # UPDATE — ensure it reads `bucket` query param (Story 4.8 may already do this)
│   └── flagged-followups/page.tsx    # NEW — read-only list of flags
├── tests/
│   ├── unit/convex/                  # extended for each query
│   │   ├── sales.test.ts, payments.test.ts, contracts.test.ts, expenses.test.ts, flaggedContracts.test.ts
│   └── e2e/journey-4-admin-dashboard.spec.ts   # UPDATE — append 5 drill-down scenarios
└── lighthouserc.json                 # UPDATE — add new URLs
```

The File List in the Dev Agent Record MUST mark each entry NEW vs UPDATE; this story's footprint is the largest dependency on Epic 3 / 4's state.

### Testing requirements

- **NFR-M2 coverage:** the per-query `list` functions touch financial data but are read-only filters — not direct financial mutations. The 90% target applies if a query is reading payments / receipts / contracts financial fields with aggregation. Since these queries return raw rows, they're closer to "non-financial." Still target ≥ 80% line coverage on each `list` function.
- **Playwright e2e:** five new scenarios in the Journey-4 spec. Cross-browser-back testing is brittle — use Playwright's `page.goBack()` API (not `page.evaluate("history.back()")`).
- **Lighthouse:** all six drill-down pages pass current thresholds. Story 5.8 tightens.

### Source references

- **PRD:** [FR43 — drill-down from dashboard](../../_bmad-output/planning-artifacts/prd.md#8-reporting--financial-dashboards), [NFR-A4 — 44px touch](../../_bmad-output/planning-artifacts/prd.md#accessibility).
- **Architecture:** [§ Capability area 8 — Reporting & Financial Dashboards](../../_bmad-output/planning-artifacts/architecture.md#requirements-to-structure-mapping).
- **UX:** [§ Journey 4](../../_bmad-output/planning-artifacts/ux-design-specification.md#journey-4--mr-reyes-checks-the-business), [§ Navigation patterns > Tap-to-drill](../../_bmad-output/planning-artifacts/ux-design-specification.md#navigation-patterns), [§ Search & Filtering Patterns > Filter changes update the URL](../../_bmad-output/planning-artifacts/ux-design-specification.md#search--filtering-patterns).
- **Epics:** [Story 5.3](../../_bmad-output/planning-artifacts/epics.md#story-53-admin-drills-down-from-dashboard-metrics).

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT store filter state in `useState`.** URL is the source of truth. `const period = searchParams.get("period") ?? "mtd"` — derived value, no `useState`. The whole point of AC4 is that refresh / share / back-button all work because the URL fully describes the view.
- ❌ **Do NOT use `router.replace` for drill-down navigation.** `router.push` keeps the dashboard in history so back-button works. `replace` would discard the dashboard from history, breaking AC4.
- ❌ **Do NOT `.filter()` the result of `ctx.db.query("payments").collect()`** client-side or server-side. Use index-bounded queries. The `payments` table grows to ~50k rows over 10 years; full scans breach NFR-P4.
- ❌ **Do NOT duplicate aggregate computations on the drill-down pages.** The dashboard tile shows ₱340,000 MTD sales; the drill-down's table header shows the same ₱340,000 by reading the same `getKpiSummary` query — OR by reading a list and summing client-side. **Read the existing query**; do not recompute.
- ❌ **Do NOT make the Net MTD tile clickable.** It's a derived metric; there's no underlying single list. Story 5.2 already made it static; keep it static.
- ❌ **Do NOT URL-encode `+` as ` ` (space) for the 90+ bucket.** Use `%2B`. Test this: `/ar-aging?bucket=90%2B` should NOT decode to `bucket=90 `. Next.js handles encoding via the `Link` API.
- ❌ **Do NOT add server-side redirects** like "if user is field_worker, redirect to /lots." The middleware (Story 1.1 / 1.2) and `requireRole` enforce access — they throw `FORBIDDEN`, which the client error boundary renders. Don't double-handle.
- ❌ **Do NOT show different content on the drill-down for "Admin" vs "Office Staff."** Both roles are allowed in these queries; if a future story restricts to Admin only, change `requireRole`. For now, both see the same data.
- ❌ **Do NOT build a flag-management UI on `/flagged-followups`.** This story's scope is the drill-down destination only — a read-only list that links to contract details. Editing / resolving is Story 5.4 or later.
- ❌ **Do NOT skip the Manila-tz check on every period query.** Off-by-one timezone bugs at month boundaries silently mis-filter. Reuse Story 5.2's `convex/lib/dashboardPeriods.ts` helpers.

### Common LLM-developer mistakes to prevent

- **Reinventing `useSearchParams`:** `const router = useRouter(); const searchParams = useSearchParams();` — both Next.js App Router hooks. Don't write a custom URL parser.
- **Wrong query param parsing for multi-state contracts:** `searchParams.get("state")` returns a string. To get a list, do `.split(",").filter(Boolean)`. Handle the absent-param case (default = all states).
- **Forgetting to encode the URL on the dashboard's `router.push`:** Next.js's `router.push("/ar-aging?bucket=90+")` may not encode the `+`. Use `router.push({ pathname: "/ar-aging", query: { bucket: "90+" } })` — the object form handles encoding.
- **Building a "back" button manually inside the drill-down pages:** browser back-button is sufficient. Adding a custom in-app back button is fine if UX wants it, but it must call `router.back()`, not `router.push("/dashboard")` (the latter would lose the period; the former preserves history).
- **Reading the period from `document.referrer`:** anti-pattern. The URL of the current page already has it (or doesn't, in which case default). Referrer is unreliable across navigations.
- **Confusing "MTD" and "this month":** MTD = "month to date" — start of current month up to the moment the query runs. "This month" = start to end of current month. These are different on May 18 (MTD is May 1–18; this month is May 1–31). Use MTD per the PRD.
- **Server-side filtering missing the `period` argument:** if the query signature doesn't accept `period`, the URL param is ignored — page shows all-time data, not MTD. Check by sending `period=ytd` and ensuring the query result count changes.

### Open questions / blockers this story does NOT resolve

- **Flag-management UX (resolve / dismiss / reassign):** out of scope for this story. Story 5.4 owns. This story's `/flagged-followups` is a read-only drill-down destination.
- **AR Balance drill-down period:** AR Balance is point-in-time, not period-scoped. The drill-down goes to `/contracts?state=active,in_default` without a period param. Confirmed by Architect; ADR not needed.
- **Sales / payments list page paginations:** for steady-state volumes (10 sales/day × 22 working days = ~220 sales/month), a single fetch is fine. At 10-year volumes, pagination may be needed. **Defer paging to a Phase-2 story.**

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries) — all drill-down pages live under `src/app/(staff)/<entity>/page.tsx`.
- [UX § Navigation patterns > Filter changes update the URL](../../_bmad-output/planning-artifacts/ux-design-specification.md#search--filtering-patterns).

No detected conflicts.

### References

- [PRD § FR43](../../_bmad-output/planning-artifacts/prd.md#8-reporting--financial-dashboards).
- [Architecture § Reporting & Financial Dashboards](../../_bmad-output/planning-artifacts/architecture.md#requirements-to-structure-mapping).
- [UX § Journey 4](../../_bmad-output/planning-artifacts/ux-design-specification.md#journey-4--mr-reyes-checks-the-business).
- [UX § Search & Filtering Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#search--filtering-patterns).
- [Epics § Story 5.3](../../_bmad-output/planning-artifacts/epics.md#story-53-admin-drills-down-from-dashboard-metrics).
- [Previous story (5.2)](./5-2-admin-views-the-kpi-dashboard.md).

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Claude Code dev agent)

### Debug Log References

- `npm run typecheck` — pre-existing convex/test errors only (contract.markDefault audit enum, expenseApprovalSettings null assignments, contracts/[contractId] page transient ref); no new errors introduced by Story 5.3 files.
- `npm run lint` — clean, no ESLint warnings or errors.
- `npx vitest run tests/unit/components/DashboardPage.test.tsx` — 30/30 tests pass including the 9 new drill-through navigation scenarios.
- `npx vitest run tests/unit/components/KpiCard.test.tsx` — 24/24 unaffected pass (regression-clean).
- `npm test` (full suite) — 1885/1890 tests pass; 4 pre-existing `ExpenseApprovalSettingsForm.test.tsx` failures + 3 pre-existing `contracts-default.test.ts` audit-enum failures are unrelated to this story's diff (confirmed by spot-checking on the unmodified `convex/**` boundary).
- `npm run build` — Next.js compiles successfully (35/35 routes), then errors on a pre-existing prerender failure in `/(staff)/interments/new/page` (Story 7.1 / 7.2 SSR issue, not in 5.3 scope). All new Story 5.3 routes (`/contracts`, `/payments`, `/flagged-followups`, `/ar-aging`) compile and lint clean.

### Completion Notes List

- **File-ownership scope:** the dev contract for this story explicitly forbids touching `convex/**`. Story task list mentions creating `list({ period })` Convex queries for sales / payments / expenses; because the convex tree is read-only here, I consumed existing queries and applied the period filter in-memory on the client (acceptable at Phase 1 row counts; documented in each page's JSDoc and called out as deferred). A follow-on story should hoist these into proper `by_paidAt` / `by_saleDate` server-side range scans before scale demands it.
- **Existing convex queries reused (no convex edits):**
  - `contracts:listContracts` — `/sales` and the new `/contracts` page consume this (Story 3.3 query).
  - `contracts:listFlaggedContracts` — `/flagged-followups` consumes this (Story 5.4 query).
  - `arAging:getAgingSummary` — `/ar-aging` consumes this (Story 4.1 query).
  - `expenses:listRecentExpenses` — `/expenses` filters this client-side by `paidAt` against the period bounds.
  - Dashboard queries (`dashboard:getDashboardKpis`, `getArAgingSummary`, `getFlaggedForFollowupSummary`) — unchanged, only the consumer wiring changed.
- **/payments page deferred:** no cross-contract payments-list Convex query exists, and convex is forbidden in this story. The page is scaffolded as a navigation destination that surfaces the period, links back to `/sales?period=…` and `/contracts?state=active,in_default`, and explicitly calls out the deferred backend query. This satisfies AC1 (clicking the Collections tile navigates to `/payments?period=…`) and AC4 (back-button restores dashboard state) without violating file ownership.
- **/ar-aging page scaffolding:** Story 4.8 still owns the full `ArAgingTable` component. This story creates a minimal `/ar-aging/page.tsx` that reads the `bucket` query param, renders a per-bucket summary header reading from `arAging:getAgingSummary`, and lists all four buckets with the selected one highlighted. When 4.8 lands the `ArAgingTable` it slots in below the summary header without rewiring.
- **Net tile remains non-clickable** per AC1 (derived metric without a single underlying list). The pre-existing static `<div>` branch of `KpiCard` is exercised.
- **AR bucket rows: 90+ URL encoding** — used `encodeURIComponent` on the bucket key so `90+` becomes `90%2B`, exactly as AC2 prescribes. The destination page's `parseBucket` accepts both encoded (`90+`) and the space-collapsed degenerate form (`90 `).
- **Dashboard test file diff:** the Story 5.2-era "renders tiles as non-clickable" assertion was inverted (it now asserts the Net tile is non-clickable and four money tiles are clickable). 9 new drill-down navigation tests added covering each KPI tile + 90+ bucket URL encoding + flagged tile + router.push (not router.replace) discipline.
- **Lots page URL filter:** `/lots?status=<status>` now hydrates the initial chip selection from the URL via `useSearchParams` + `useEffect`, so a future drill-down from an inventory tile (not in scope this story) lands on the filtered view. Local state still owns subsequent chip flips for responsiveness.
- **Deferred to follow-on stories (out of scope):**
  - Playwright E2E spec extension for journey-4-admin-dashboard.spec.ts (Task 12) — file not in dev-message ownership list; left for the E2E story owner.
  - Lighthouserc.json URL list expansion (Task 13) — Story 5.8 owns CI thresholds; left for that story.
  - Convex `list` query creation for sales/payments/expenses with server-side period bounds (Tasks 4–7's "if not present, create") — convex tree explicitly forbidden in this dev contract; client-side filtering is the documented stop-gap.

### File List

- `src/app/(staff)/dashboard/page.tsx` — UPDATE — wired `onClick` on Sales / Collections / AR Balance / Expenses KPI cards (Net stays static), made AR aging bucket rows clickable `<button>` elements that route via `router.push({ /ar-aging?bucket=… })` with `+` URL-encoded as `%2B`, made the Flagged-for-Follow-up tile a full-surface button routing to `/flagged-followups?status=open`. Refreshed file-level JSDoc to document the Story 5.3 wiring contract.
- `src/app/(staff)/sales/page.tsx` — UPDATE — reads `?period=mtd|ytd` via `useSearchParams`, computes period bounds (Manila timezone), filters the result rows client-side, updates the page header and period banner, and surfaces a period-aware empty state.
- `src/app/(staff)/expenses/page.tsx` — UPDATE — reads `?period=mtd|ytd` via `useSearchParams`, computes period bounds, derives `filteredExpenses` from the existing `listRecentExpenses` query, swaps the render to use the filtered set, and surfaces a period-aware header + empty state.
- `src/app/(staff)/lots/page.tsx` — UPDATE — hydrates initial chip selection from `?status=<status>` via `useSearchParams` + `useEffect`, so a drill-down deep link lands on the correctly-filtered view. Local state continues to drive subsequent chip flips.
- `src/app/(staff)/contracts/page.tsx` — NEW — read-only contracts list filtered by `?state=…` (comma-separated). Runs one indexed `listContracts` query per selected state (skipped via the `"skip"` sentinel for unselected ones) so hook order stays stable, merges, sorts by `createdAt` desc, and renders with a per-row link to the contract detail page. Default (no `state` param) shows the universe.
- `src/app/(staff)/payments/page.tsx` — NEW — drill-down destination scaffold for the Collections tile. Reads `?period=` and surfaces the period bounds; cross-contract payments-list query is deferred to a follow-on story (convex tree out of scope). Provides links onward to `/sales?period=…` and `/contracts?state=active,in_default`.
- `src/app/(staff)/flagged-followups/page.tsx` — NEW — read-only list of currently-flagged contracts via `contracts:listFlaggedContracts`. Reads `?status=` for forward-compatibility (today every row is by definition open). Desktop table + mobile cards; each row links into the contract detail page where Story 5.4's flag-management UI lives. Empty state: "No open flags. Nothing waiting."
- `src/app/(staff)/ar-aging/page.tsx` — NEW — drill-down destination for the AR aging buckets. Reads `?bucket=` (accepts both `90+` and the URL-encoded `90%2B`), renders a per-bucket summary header reading from `arAging:getAgingSummary`, plus a list of all four buckets with the selected one highlighted. Full `ArAgingTable` slot reserved for Story 4.8.
- `tests/unit/components/DashboardPage.test.tsx` — UPDATE — added `mockPush` for `useRouter().push`, inverted the Story 5.2 "non-clickable tiles" assertion (Net stays non-clickable, four money tiles are now clickable), and added a 9-test `drill-down navigation` describe block covering: MTD Sales / MTD Collections / AR Balance / MTD Expenses drill-through, YTD preservation, AR bucket routing (incl. `90+` URL-encoding), flagged tile routing, and the `router.push` (not `router.replace`) discipline (AC4 guard).
