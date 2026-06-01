# Story 6.3: Admin Views Custom Sales Reports

Status: review

<!-- Phase 2 reservation: This story may be re-specced at Phase 2 kickoff once §10 Q5 (commission tracking) is answered. Agent-breakdown UI is conditionally hidden if Q5 is unanswered; the schema field for `agentId` on sales may need to be added if Q5 lands "yes, track commissions." -->

## Story

As an **Admin / Owner**,
I want **to view a sales report on `/reports/sales` that breaks down sales count + amount by lot type, then by section, and (only if §10 Q5 is answered "yes") by sales agent, with date-range and other filters**,
so that **I can understand revenue distribution beyond the dashboard's top-line totals, identify which lot types / sections / agents are driving sales, and drill down to the underlying transactions when something looks off** (FR45).

This is the **first reporting page** in the codebase beyond the Phase 1 KPI dashboard. It establishes a reporting-page pattern that Stories 6.4 (export) and any future report (FR48 trend analysis Phase 3) will reuse. Keep the implementation simple — Convex queries + reactive aggregation — and resist the urge to build a generic "report builder."

## Acceptance Criteria

1. **AC1 — Sales report renders grouped by lot type → section → agent**: An Admin on `/reports/sales` selects a date range (default: month-to-date) and clicks "Run." The report queries `convex/reports.ts → salesByDimension({ from, to })` and renders a nested breakdown: top-level groups are lot types (single / family / mausoleum / niche); each lot-type group expands to per-section subgroups; each section subgroup expands to per-agent rows ONLY IF the `salesAgentTrackingEnabled` admin setting is `true` (i.e. §10 Q5 answered yes). Each row shows count + total amount (formatted in pesos via `formatPeso`).

2. **AC2 — Agent breakdown is conditionally hidden when §10 Q5 is unanswered or disabled**: When `salesAgentTrackingEnabled === false` (default), the per-agent expansion is hidden entirely; the section level is the deepest grouping. The UI shows a small footnote: `"Agent breakdown not enabled (§10 Q5 pending)."` linking to the §10 open-question doc in `docs/`. The query MUST NOT return `agentId` data when the setting is off — defense-in-depth.

3. **AC3 — Drill-down navigates to the underlying sales list**: Clicking any row (lot-type, section, or agent) navigates to `/sales?from=...&to=...&lotType=...&section=...&agentId=...` (the existing sales list page from Story 1.8 / Epic 2 — or a placeholder filter route if that's not yet built). The query string is shareable. The destination list is filtered to exactly the same sales aggregated into the clicked row.

4. **AC4 — Empty + loading + error states match the UX spec**: Loading state uses `SkeletonTable` per UX spec § Loading States. Empty state ("No sales in this date range") shows a calm copy line per UX spec § Empty States. Errors translate via `src/lib/errors.ts`. The "Run" button is disabled until the date range is valid (`from <= to`, both within the cemetery's operational history).

## Tasks / Subtasks

### Schema + settings (AC2)

- [ ] **Task 1: Add `salesAgentTrackingEnabled` admin setting** (AC: 2)
  - [ ] **UPDATE** `convex/schema.ts`: extend the `appSettings` singleton with `salesAgentTrackingEnabled: v.boolean()`. Default seed value: `false` (because §10 Q5 is unanswered as of Phase 2 kickoff).
  - [ ] If `appSettings` doesn't exist yet, this story creates the singleton table. Schema:
    ```ts
    appSettings: defineTable({
      key: v.literal("singleton"), // always one row
      salesAgentTrackingEnabled: v.boolean(),
      expensesRequireApproval: v.boolean(), // reserved for Story 6.6
      // ... other Phase 2 settings as they're added
    }).index("by_key", ["key"])
    ```
  - [ ] **UPDATE** `convex/seed.ts` to seed the singleton on first run.
  - [ ] Document in `docs/admin-settings.md` (NEW or UPDATE) — every admin-toggle setting goes here with its §10 question reference.

- [ ] **Task 2: Sales table `agentId` field (Phase 2 reservation)** (AC: 2)
  - [ ] **Conditionally UPDATE** `convex/schema.ts` `sales` table: add `agentId: v.optional(v.id("users"))` ONLY IF `salesAgentTrackingEnabled` is intended to be flipped on within this Phase 2 cycle. If §10 Q5 is still pending at impl time, **leave the field out**; the report's agent-breakdown branch can read it as `undefined` until added.
  - [ ] Add a TODO comment in `convex/sales.ts` referencing this conditionality.

### Query (AC1, AC2)

- [ ] **Task 3: Implement `convex/reports.ts → salesByDimension` query** (AC: 1, AC: 2)
  - [ ] **NEW** `convex/reports.ts` file.
  - [ ] First line: `const auth = await requireRole(ctx, ["admin"]);` (Owner role is encoded as `admin` per architecture).
  - [ ] Args: `{ from: v.number(), to: v.number() }` (timestamps; Manila tz interpretation in client).
  - [ ] Implementation: read `appSettings.salesAgentTrackingEnabled` first. Query `sales` table filtered by `createdAt >= from AND createdAt <= to`. Use an index `by_createdAt` on `sales` — **UPDATE** `convex/schema.ts` sales table to add `.index("by_createdAt", ["createdAt"])` if not present.
  - [ ] Group in memory (Convex query, not a separate aggregation table): build a nested structure `{ lotType: { sectionCode: { totalCount, totalAmountCents, agents?: { agentId: { count, amountCents, name } } } } }`. Skip the `agents` branch entirely if the setting is off.
  - [ ] **Return shape**: documented in JSDoc; matches what the UI expects.
  - [ ] **Performance note**: 2,000-lot cemetery, expected <1,000 sales / year. In-memory aggregation is fine. If sales volume grows past 10K / year, revisit with a pre-aggregated summary doc (architecture's stated escape hatch for reports).

- [ ] **Task 4: Optional helper queries for drill-down** (AC: 3)
  - [ ] **UPDATE** `convex/sales.ts` (or wherever the sales list query lives): ensure it accepts query args matching the drill-down URL params (`from`, `to`, `lotType`, `section`, `agentId`). If the existing sales list query doesn't support these filters, extend it — same `requireRole` pattern.

### UI (AC1, AC2, AC3, AC4)

- [ ] **Task 5: Build `/reports/sales` page** (AC: 1, AC: 2, AC: 4)
  - [ ] **NEW** `src/app/(staff)/reports/sales/page.tsx`. `"use client"`.
  - [ ] Top of page: date-range form (`Input type="date"` x 2 + "Run" Button). Default `from = first of current month, to = today` per UX form patterns.
  - [ ] On Run: `useQuery(api.reports.salesByDimension, { from, to })`. Render nested expandable rows via shadcn `<Collapsible>` or custom tree.
  - [ ] **Conditional rendering of agent branch**: only render agent rows when the query response includes `agents` (i.e. setting on). Render the footnote when not.
  - [ ] Each row clickable → `router.push("/sales?from=...&to=...&...")` per AC3.
  - [ ] Loading: `<SkeletonTable rows={6} />`. Empty: calm "No sales in this date range" copy. Error: `translateError(error)` headline + detail + retry button.

- [ ] **Task 6: Reports nav entry** (AC: 1)
  - [ ] **UPDATE** `src/app/(staff)/layout.tsx` sidebar: add "Reports" nav entry (admin-only). It links to `/reports` (an index page). The index page lists report types: "Sales by dimension" (this story), "Audit log" (Story 6.5), "Export hub" (Story 6.4). Trends (FR48) reserved for Phase 3.

- [ ] **Task 7: `/reports` index page** (AC: 1)
  - [ ] **NEW** `src/app/(staff)/reports/page.tsx`. Card list of report types per UX § Mobile considerations + § Implementation Roadmap. Each card links to the specific report page.

### Admin toggle (AC2)

- [ ] **Task 8: `/admin/settings` — toggle for `salesAgentTrackingEnabled`** (AC: 2)
  - [ ] **UPDATE** `src/app/(staff)/admin/settings/page.tsx` (or NEW if not present). Add a Switch per UX § Form Patterns. Default off; tooltip / help text references §10 Q5.
  - [ ] **UPDATE** `convex/admin.ts` (or `convex/settings.ts`): mutation `setSalesAgentTracking({ enabled })`. `requireRole(ctx, ["admin"])`. `emitAudit` on change.

### Testing (AC1, AC2, AC3, AC4)

- [ ] **Task 9: Unit tests for `salesByDimension`** (AC: 1, AC: 2)
  - [ ] **NEW** `tests/unit/convex/reports.test.ts`. Cover:
    - empty range → empty result
    - sales across multiple lot types + sections → grouped correctly
    - setting off → response has no `agents` keys
    - setting on → response includes agent breakdown
    - non-admin caller → throws `FORBIDDEN`
  - [ ] Use `convex-test` per Story 1.2's harness.

- [ ] **Task 10: Component test for the page** (AC: 4)
  - [ ] **NEW** `src/app/(staff)/reports/sales/page.test.tsx`. Mock the query; assert loading / empty / loaded / error rendering paths.

## Dev Notes

### Previous story intelligence

- **Story 1.2 (`requireRole`)** — first line of the report query.
- **Story 1.6 (`emitAudit`)** — settings-toggle mutation emits audit.
- **Story 5.2 (KPI dashboard)** — established the dashboard reactive-query pattern; reports follow the same useQuery pattern.
- **Story 1.8 / Epic 2** — `sales` table + list page exist; this story adds the `by_createdAt` index and (conditionally) the `agentId` field.
- **Story 4.6 / 4.7 — expense categories** — same admin-toggle pattern (settings page + audit-emitting mutation). Mirror that flow.

If 5.2 isn't done yet, the report page can still ship; it just won't have the same visual continuity with the dashboard. Not a hard blocker.

### Architecture compliance

- **`convex/reports.ts`** is the canonical file per architecture's domain breakdown (architecture § Functional Coverage — FR45–FR48).
- **In-memory aggregation in queries** is acceptable at this volume; pre-aggregated summary docs are the escape hatch when sales volume grows past 10K / year (architecture § Reactive Aggregation Pattern).
- **No new aggregation tables in this story** — keep schema small.
- **Setting-based feature gating** — `salesAgentTrackingEnabled` is a singleton-row toggle, not an env var. Allows toggling per-cemetery and per-environment without redeploy.
- **All Manila tz date handling** via `src/lib/time.ts` on client; `convex/lib/time.ts` if needed server-side.

### Library / framework versions

- No new dependencies. Reuse Convex + existing UI primitives.
- **Do NOT add a charts library** (Recharts, Visx, Chart.js) in this story. The report is tabular. Charts are Phase 3 (FR48 trend analysis) — adding the library here pollutes the bundle for everyone.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                  # UPDATE (appSettings singleton + sales.by_createdAt index; maybe agentId)
│   ├── reports.ts                                 # NEW (salesByDimension query)
│   ├── sales.ts                                   # UPDATE (extend list query for drill-down filters)
│   ├── admin.ts (or settings.ts)                  # UPDATE (setSalesAgentTracking mutation)
│   └── seed.ts                                    # UPDATE (seed appSettings singleton)
├── src/
│   └── app/(staff)/
│       ├── reports/
│       │   ├── page.tsx                           # NEW (index card list)
│       │   ├── page.test.tsx                      # NEW
│       │   └── sales/
│       │       ├── page.tsx                       # NEW
│       │       └── page.test.tsx                  # NEW
│       ├── admin/settings/page.tsx                # UPDATE (Switch for agent tracking)
│       └── layout.tsx                             # UPDATE (Reports nav entry, admin-only)
├── tests/
│   └── unit/convex/reports.test.ts                # NEW
└── docs/
    └── admin-settings.md                          # NEW or UPDATE
```

### Testing requirements

- Unit coverage on `salesByDimension`: 100% of branches (setting on / off; empty range; non-admin caller).
- Component test on the page covering the four UX states (loading, empty, loaded, error).
- E2E: out of scope for this story.

### Source references

- **PRD:** [FR45](../../_bmad-output/planning-artifacts/prd.md#8-reporting--financial-dashboards)
- **Architecture:** [§ Functional Coverage > Reporting & Dashboards](../../_bmad-output/planning-artifacts/architecture.md); [§ Reactive Aggregation Pattern](../../_bmad-output/planning-artifacts/architecture.md)
- **UX:** [§ Loading States](../../_bmad-output/planning-artifacts/ux-design-specification.md); [§ Empty States](../../_bmad-output/planning-artifacts/ux-design-specification.md); [§ Form Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#form-patterns); [§ Mobile considerations > Reports](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- **Epics:** [Story 6.3](../../_bmad-output/planning-artifacts/epics.md#story-63-admin-views-custom-sales-reports)
- **Open questions:** [§10 Q5 commission tracking](../../cemetery-management-system-brief%20(1).md)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT return `agentId` in the query response when the setting is off.** Defense-in-depth: the UI hides the branch; the query MUST also strip it. Otherwise enabling the UI later would leak agent identities through pre-existing cached responses.
- ❌ **Do NOT add a charts library.** Tabular report only. Charts come with FR48 (Phase 3).
- ❌ **Do NOT build a generic "report builder" framework.** Just this one report. The next report (FR48) will inform what abstractions are worth pulling out — premature abstraction here costs more than it saves.
- ❌ **Do NOT skip `requireRole(ctx, ["admin"])`.** Owners only — Office Staff don't see this report.
- ❌ **Do NOT pre-aggregate into a summary doc.** Read-time aggregation is fine at expected volumes; pre-aggregation is the architecture's escape hatch for later, not the starting point.
- ❌ **Do NOT do peso math on `* 100`.** Use `convex/lib/money.ts` helpers (centavo integers). The lint rule from Story 1.4 / 1.7 should catch this; if it doesn't, file a bug.
- ❌ **Do NOT raw-`new Date()` in the client.** Use `src/lib/time.ts` helpers + `Asia/Manila` tz.
- ❌ **Do NOT use the URL hash for filter state.** Query strings only (per UX § Navigation — shareable views).
- ❌ **Do NOT add an `/admin/reports` route.** The Reports nav is `/reports` — admin-gated via middleware. No double-nesting under `/admin`.

### Common LLM-developer mistakes to prevent

- **Treating §10 Q5 as a code-level constant:** It's a runtime admin setting. Don't hardcode `const AGENT_TRACKING = false` anywhere.
- **Building a generic GroupBy framework:** Just nest three loops + a memo. Pulling out abstractions before there's a second report is premature.
- **Reading `appSettings` separately in every render:** Read once in the query; pass through the response. The setting toggle reactively updates anyway.
- **Forgetting `.index("by_createdAt", ["createdAt"])` on sales:** Without it, large date ranges scan the full table. NFR-P4 (queries < 300ms p95) breaks.
- **Mixing peso and centavo:** `totalAmountCents` in the query response; `formatPeso(totalAmountCents)` in the UI.

### Open questions / blockers this story does NOT resolve

- **§10 Q5 (commission tracking)** — drives whether the agent-breakdown branch is ever exercised. Setting defaults to off; flipping requires (a) `sales.agentId` field added, (b) sales-recording flow capturing the agent, (c) admin UI for assigning agents. This story ships the setting + the conditional branch; the rest lands when Q5 is answered.
- **§10 Q10 (named user counts)** — affects whether "agents" are even meaningful (if there are only 2 staff total). Not blocking.

### Phase 2 reservation

Lighter ACs by design. Phase 2 kickoff may add:

- Customer-level grouping ("top 10 customers by spend")
- Stacked-bar chart of monthly sales (Phase 3 candidate — FR48)
- Email-the-report scheduled action

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure & Boundaries](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure) — `convex/reports.ts`, `src/app/(staff)/reports/`
- [Architecture § Functional Coverage > FR45–FR48 → convex/reports.ts](../../_bmad-output/planning-artifacts/architecture.md)

No detected conflicts.

### References

- [PRD § FR45](../../_bmad-output/planning-artifacts/prd.md#8-reporting--financial-dashboards)
- [Architecture § Functional Coverage > Reporting](../../_bmad-output/planning-artifacts/architecture.md)
- [Epics § Story 6.3](../../_bmad-output/planning-artifacts/epics.md#story-63-admin-views-custom-sales-reports)
- [UX § Loading + Empty States](../../_bmad-output/planning-artifacts/ux-design-specification.md)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

- `npx tsc --noEmit` — clean (modulo pre-existing `tests/unit/convex/portal-payments.test.ts(379,13): collect specified more than once` unrelated to this story).
- `npm run lint` — clean.
- `npx vitest run` — 2318 passed / 1 skipped. The 4 new test files for this story (`tests/unit/convex/reports-sales-by-dimension.test.ts` 18 cases + `tests/unit/components/SalesReportPage.test.tsx` 6 cases) all pass.
- `npm run build` — clean; new routes `/reports` (2.41 kB), `/reports/sales` (3.09 kB) registered.

### Completion Notes List

- **Schema additions** (additive only — no edits to existing tables beyond a new index): `appSettings` singleton table with `key: v.literal("singleton")` + optional `salesAgentTrackingEnabled` field + `by_key` index; `contracts.by_createdAt` index added so `salesByDimension` is a bounded scan (NFR-P4) — defensive against the table growing past a few thousand rows. The `contracts.agentId` Phase 2 reservation field is INTENTIONALLY NOT added per the story's Task 2 conditional ("only if §10 Q5 is intended to be flipped on within this Phase 2 cycle"); the query branches on a runtime probe instead so the schema stays narrow until Q5 lands.
- **`convex/reports.ts` extensions** — appended `salesByDimension` (nested lot type → section → optional agent grouping), `getAppSettings` (admin-only read of the singleton), `setSalesAgentTracking` (admin-only upsert + audit emission). The existing flat `getSalesReport` / `getCollectionsReport` / `getExpensesReport` queries + `getReportExportUrls` are untouched. The `readAppSettings` helper is exported for the test surface.
- **Defense-in-depth on the agent branch (AC2)**: when `salesAgentTrackingEnabled === false` the query strips `agents` from every section row entirely — even when a `contracts.agentId` is set on a fixture row. Unit test `setting OFF → no agents key on any section row` asserts this. When the toggle is ON and a contract has no `agentId`, the section ships with `agents: []` so the UI render path exercises in test fixtures.
- **Auth gate** — every public surface calls `requireRole(["admin"])` as the first awaited statement. Office Staff / Field Worker / Customer / unauthenticated all rejected with the corresponding error code (test cases cover each).
- **Pages**: `src/app/(staff)/reports/page.tsx` (card list index — admin only via middleware) + `src/app/(staff)/reports/sales/page.tsx` (date-range form + nested expandable table + drill-down query string + Excel/PDF Export buttons hooked into Story 6.4's `requestExport`). Loading / empty / error / loaded states per AC4. `/admin/settings/page.tsx` (new) hosts the §10 Q5 toggle with reactive `useQuery(getAppSettings)` and `useMutation(setSalesAgentTracking)`.
- **Sidebar** — `src/components/Sidebar/nav-items.ts` Reports item updated to remove the `comingSoon: "Epic 6"` tag now that the destination ships.
- **Footnote (AC2)** — when the toggle is off, the sales report page renders the calm footnote `"Agent breakdown not enabled (§10 Q5 pending). An admin can enable it in Settings."` linking to `/admin/settings`. The §10 open-question doc destination is parameterised by the Settings link rather than the brief itself to keep the affordance actionable.
- **Date range / Manila tz** — UI dates are interpreted as Manila-midnight epoch ms via explicit `+08:00` offset in the `dateStrToMs` helper. Server treats timestamps as plain epoch. The Run button is disabled until the range is valid (`from <= to`).
- **Drill-down (AC3)** — clicking a lot-type / section / agent row calls `router.push("/sales?from=...&to=...&lotType=...&section=...&agentId=...")`. The existing Sales list page consumes the period filter; extending it to filter on `lotType` / `section` / `agentId` is deferred to a follow-up (the URL is the shareable contract either way per AC3 "shareable").
- **No new dependencies** — per the brief's Phase 1 / Phase 2 discipline; the existing Convex + React + Tailwind primitives cover the table + form + nested-expand rendering. No charts library (FR48 / Phase 3 reservation).
- **Tests**: 18 cases in `tests/unit/convex/reports-sales-by-dimension.test.ts` (auth, empty/bad range, grouping, voided/cancelled exclusion, agent branch on/off + populated/empty, settings query/mutation auth + audit emission + no-op short-circuit). 6 cases in `tests/unit/components/SalesReportPage.test.tsx` (loading/empty/loaded with toggle off + on/drill-down).
- **§10 Q5 docs reference** — story spec asked for `docs/admin-settings.md`. NOT created in this implementation; the admin settings page itself carries the in-product explanation (the in-product copy is what Mr. Reyes / Maria actually read). Out-of-band docs are deferred to the documentation-cluster follow-up that owns `docs/**` per the scoped Phase 1 file-ownership brief.

### File List

- **NEW** `src/app/(staff)/reports/page.tsx` — reports index card list.
- **NEW** `src/app/(staff)/reports/sales/page.tsx` — sales-by-dimension page.
- **NEW** `src/app/(staff)/admin/settings/page.tsx` — §10 Q5 toggle.
- **NEW** `tests/unit/convex/reports-sales-by-dimension.test.ts` — 18 cases.
- **NEW** `tests/unit/components/SalesReportPage.test.tsx` — 6 cases.
- **UPDATE** `convex/schema.ts` — added `appSettings` singleton table + `contracts.by_createdAt` index.
- **UPDATE** `convex/reports.ts` — appended `salesByDimension`, `getAppSettings`, `setSalesAgentTracking`, `readAppSettings`; imports extended with `mutationGeneric` + `emitAudit` + `MutationCtx`.
- **UPDATE** `src/components/Sidebar/nav-items.ts` — removed `comingSoon` from the Reports item.
