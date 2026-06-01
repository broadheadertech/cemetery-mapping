# Story 5.5: Daily Reconciliation Invariant Scheduled Function

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer / compliance officer**,
I want **a daily Convex scheduled function `checkReconciliationInvariant` that, for every active contract, sums all non-voided payments and compares against (originalContractAmountCents − currentOutstandingBalanceCents), records any mismatches in a `reconciliationFailures` table, and surfaces failures as a banner on the Admin dashboard**,
so that **any silent drift between the `payments` table and `contracts.outstandingBalanceCents` is detected within 24 hours rather than discovered months later during a BIR audit** (FR60, NFR-R4).

This is the **financial-integrity safety net** for the entire product. The `postFinancialEvent` cornerstone (Story 3.2) is supposed to keep payments and contract balances atomically consistent. The reconciliation invariant is the second line of defense — it assumes the cornerstone is correct but verifies it nightly anyway, because at 2,000+ contracts × 60-month installment schedules × 10-year horizon, even a 0.01% drift rate produces material discrepancies. The deliberate-divergence test is the most important test in this story: it proves the invariant *can* catch a mismatch, not just that it *passes* on clean fixtures.

## Acceptance Criteria

1. **AC1 — Daily cron at 03:00 Manila time invokes `checkReconciliationInvariant`**: `convex/scheduled.ts` registers a `cron.daily` entry running at 03:00 `Asia/Manila` (= 19:00 UTC the prior calendar day) that invokes the internal action `internal.lib.reconciliation.checkReconciliationInvariant`. The action iterates every contract in `state in ["active", "in_default"]` via the `by_state` index; for each contract, sums `amountCents` of all non-voided `payments` joined via `paymentAllocations` (or the equivalent join Epic 3 implemented); compares against `originalAmountCents − outstandingBalanceCents`. The function completes within 5 minutes for ≤ 5,000 active contracts (validated under typical load).

2. **AC2 — Mismatches recorded in `reconciliationFailures` table**: When `sum(payments) ≠ originalAmount − outstandingBalance` for any contract, a row is inserted into `reconciliationFailures` with `{ contractId, runAt: number, expectedCents: number, actualCents: number, deltaCents: number, status: "open" }`. The table has indexes `by_status` (for the dashboard query) and `by_runAt` (for historical analysis). Subsequent runs that detect the same contract still mismatched do NOT insert duplicate rows — the row is updated (`status` stays "open"; `runAt` and `deltaCents` refresh). A contract that previously failed but now reconciles cleanly gets its row's status moved to "self_resolved" (not deleted — the audit trail must remain).

3. **AC3 — Admin dashboard banner surfaces open failures within 2 hours (NFR-R4)**: When `reconciliationFailures.status === "open"` count is ≥ 1, the `/dashboard` page renders a top-of-page banner: "Reconciliation failures — N contracts need investigation" with a link to `/admin/reconciliation` (the failures detail page — scaffolded by this story as a basic list; rich UI can land in a follow-up). The banner uses `bg-red-50 text-red-900 border-red-200` (Story 1.4 destructive tokens). When zero open failures exist, the dashboard's footer shows a small "System health: all contracts reconciled — last run {timestamp}" indicator (UX § Journey 4 trust-builder). NFR-R4 says the banner must appear within 2 hours of detection — since `useQuery` is reactive, the banner appears within seconds of the failure row being inserted.

4. **AC4 — Deliberate-divergence Vitest test proves detection works**: `tests/unit/convex/lib/reconciliation.test.ts` includes a test that seeds a contract with `originalAmountCents: 100_000_00`, `outstandingBalanceCents: 60_000_00` (implying ₱40,000 paid), but seeds payment fixtures summing to only `30_000_00` (a ₱10,000 manufactured shortage — the kind of bug `postFinancialEvent` would never produce, but a corrupted backup restore or a manual ctx.db.patch by a future dev might). Running `checkReconciliationInvariant` against this fixture MUST: (a) insert one row in `reconciliationFailures` with `deltaCents = -10_000_00`, (b) NOT throw — the function records the failure, it does not crash on it, (c) the row's `expectedCents` is `40_000_00` and `actualCents` is `30_000_00`. A separate test seeds 50 clean contracts and verifies zero rows are inserted in `reconciliationFailures`.

## Tasks / Subtasks

### Schema additions (AC2)

- [ ] **Task 1: Add `reconciliationFailures` table to `convex/schema.ts`** (AC: 2)
  - [ ] In `convex/schema.ts`, add: `reconciliationFailures: defineTable({ contractId: v.id("contracts"), runAt: v.number(), expectedCents: v.number(), actualCents: v.number(), deltaCents: v.number(), status: v.union(v.literal("open"), v.literal("self_resolved"), v.literal("acknowledged")), acknowledgedBy: v.optional(v.id("users")), acknowledgedAt: v.optional(v.number()), notes: v.optional(v.string()) }).index("by_status", ["status"]).index("by_contractId", ["contractId"]).index("by_runAt", ["runAt"])`
  - [ ] Run `npx convex dev` to regenerate `convex/_generated/`. Verify the table appears in the Convex dashboard before proceeding.
  - [ ] The table is NEVER written to by application code outside `convex/lib/reconciliation.ts` and `convex/reconciliation.ts` (the acknowledge mutation). Add a TODO comment in the schema noting this; the lint rule that enforces it can land later if needed.

### Server logic (AC1, AC2, AC4)

- [ ] **Task 2: Create `convex/lib/reconciliation.ts` — the invariant logic** (AC: 1, AC: 2, AC: 4)
  - [ ] Create `convex/lib/reconciliation.ts`. At the top: `import { internalAction, internalMutation } from "../_generated/server"; import { internal } from "../_generated/api"; import { v } from "convex/values"; import { subCents } from "./money";`
  - [ ] Export `internalAction checkReconciliationInvariant` with empty args. Body: (a) call `internalQuery getActiveContractsForReconciliation` to fetch all contracts in `state in ["active", "in_default"]` via the `by_state` index — return only the fields needed (`_id`, `originalAmountCents`, `outstandingBalanceCents`), (b) for each contract, call `internalQuery sumPaymentsForContract` which scans `payments` filtered to `contractId === <id>` AND `voidedAt === undefined` via the `by_contractId` index and sums `amountCents`, (c) compute `expectedCents = subCents(originalAmountCents, outstandingBalanceCents)` and `deltaCents = subCents(actualCents, expectedCents)`, (d) if `deltaCents !== 0`, call `internalMutation upsertFailure(contractId, expectedCents, actualCents, deltaCents)`; otherwise call `internalMutation resolveIfOpen(contractId)`. Final step: call `internalMutation recordRunCompletion(runAt: Date.now())` writing to a single-row `reconciliationRuns` summary doc (NEW — see Task 3).
  - [ ] All arithmetic via `convex/lib/money.ts` `subCents` — never raw `-` on cents (architecture's money rule).
  - [ ] Export `internalMutation upsertFailure`: if a row exists for the `contractId` with `status === "open"`, patch its `runAt`, `expectedCents`, `actualCents`, `deltaCents`; otherwise insert a new row.
  - [ ] Export `internalMutation resolveIfOpen`: if a row exists for the `contractId` with `status === "open"`, patch `status` to `"self_resolved"` and update `runAt`. Do NOT delete.
  - [ ] **Performance note:** for 5,000 contracts × one payment-sum query each, batch reads via the index — total reads ≤ ~50k rows per run. Convex's per-action limits are well above this; the 5-minute completion target is conservative.

- [ ] **Task 3: Add `reconciliationRuns` single-row tracker** (AC: 3)
  - [ ] In `convex/schema.ts`, add: `reconciliationRuns: defineTable({ runAt: v.number(), durationMs: v.number(), contractsChecked: v.number(), failuresFound: v.number(), failuresResolved: v.number() })` (no indexes needed; the dashboard reads the latest row via `.order("desc").take(1)`).
  - [ ] In `convex/lib/reconciliation.ts`, export `internalMutation recordRunCompletion` that inserts a new row capturing the run's stats. Keep all rows (one per day = ~365 per year ≈ negligible storage); the dashboard reads only the most recent.

### Cron registration (AC1)

- [ ] **Task 4: Register the cron in `convex/scheduled.ts`** (AC: 1)
  - [ ] If `convex/scheduled.ts` does not exist, create it as a NEW file. If it exists (Epic 4's AR aging scheduled function may have created it first), UPDATE it — add the reconciliation entry alongside existing ones; do not refactor existing entries in this story.
  - [ ] At the top: `import { cronJobs } from "convex/server"; import { internal } from "./_generated/api"; const crons = cronJobs(); crons.daily("checkReconciliationInvariant", { hourUTC: 19, minuteUTC: 0 }, internal.lib.reconciliation.checkReconciliationInvariant); export default crons;`
  - [ ] The 19:00 UTC = 03:00 Manila (UTC+8) conversion: Manila has no DST, so the offset is constant. Add a JSDoc comment explaining the conversion + linking to `convex/lib/time.ts` for any future Manila-tz arithmetic.

### Dashboard banner + health indicator (AC3)

- [ ] **Task 5: Query for the failure count + last run** (AC: 3)
  - [ ] In `convex/dashboards.ts` (created by Story 5.2), add `export const getReconciliationHealth = query({ args: {}, handler: async (ctx) => { ... } })`. First line: `await requireRole(ctx, ["admin", "office_staff"]);` (Story 1.2 cornerstone).
  - [ ] Returns `{ openFailureCount: number, lastRunAt: number | null, lastRunDurationMs: number | null, lastRunContractsChecked: number | null }`. Read `reconciliationFailures` filtered by `by_status` index, status `"open"`, count rows. Read `reconciliationRuns` most-recent via `.order("desc").take(1)`.

- [ ] **Task 6: Render the dashboard banner + footer health indicator** (AC: 3)
  - [ ] In `src/app/(staff)/dashboard/page.tsx` (Story 5.2's page), add the reactive query: `const health = useQuery(api.dashboards.getReconciliationHealth, {});`
  - [ ] Above the page header: `{health && health.openFailureCount > 0 && (<Banner tone="destructive" href="/admin/reconciliation">Reconciliation failures — {health.openFailureCount} contract{health.openFailureCount === 1 ? "" : "s"} need investigation</Banner>)}`. Banner uses Tailwind utilities `bg-red-50 text-red-900 border border-red-200 rounded-md p-3 mb-4` (or the semantic tokens from Story 1.4). The banner is a link to `/admin/reconciliation`.
  - [ ] Below the dashboard's tile grid + AR aging summary, render the health footer: `{health && health.openFailureCount === 0 && health.lastRunAt && (<p className="text-xs text-emerald-700 mt-4">System health: all contracts reconciled — last run {formatRelativeTime(health.lastRunAt)}</p>)}`. If `lastRunAt === null` (cron has never run — fresh deploy), render `"System health: pending first reconciliation run"` instead.
  - [ ] Wrap the banner content in `ReactiveHighlight watch={health?.openFailureCount ?? 0}` — when a new failure appears mid-day (unlikely but possible if a manual `acknowledged → open` revert happens), the banner amber-fades the same way KPI tiles do. Skip the wrapper on the footer health indicator — it would compete for attention with the KpiCards.

### Failures detail page (AC3 — minimal scaffold)

- [ ] **Task 7: Build `/admin/reconciliation` as a basic list page** (AC: 3)
  - [ ] Create `src/app/(staff)/admin/reconciliation/page.tsx`. `"use client"` on line 1.
  - [ ] Query: `const failures = useQuery(api.reconciliation.listFailures, {});` — NEW query in `convex/reconciliation.ts` (NEW file): `export const listFailures = query({ args: { status: v.optional(v.union(v.literal("open"), v.literal("self_resolved"), v.literal("acknowledged"))) }, handler: async (ctx, args) => { ... } });` first line `await requireRole(ctx, ["admin"]);` (Admin-only — Office Staff can see the count via the dashboard banner but cannot view individual failures; this is a deliberate separation pending §10 follow-up on who triages financial discrepancies). Returns failures filtered by status (default "open"), enriched with `contract.code` and `customer.fullName` for the row.
  - [ ] Render a simple table: rows show `contract.code`, `customer.fullName`, `formatPeso(deltaCents)` (with `text-red-700` if negative — payments under-recorded; `text-amber-700` if positive — payments over-recorded), `formatRelativeTime(runAt)`, and an "Acknowledge" button.
  - [ ] Add `export const acknowledgeFailure = mutation({ args: { failureId: v.id("reconciliationFailures"), notes: v.string() }, handler: async (ctx, args) => { ... } })` in `convex/reconciliation.ts`. First line `await requireRole(ctx, ["admin"]);`. Patches the row: `status: "acknowledged"`, `acknowledgedBy: <userId>`, `acknowledgedAt: Date.now()`, `notes: args.notes`. Emit audit log via `emitAudit(...)` per Story 1.6's cornerstone — action `"reconciliation_acknowledge"`, entityType `"reconciliationFailure"`, entityId `args.failureId`, before/after the row state, `reason: args.notes`. Acknowledging requires a non-empty `notes` string ≥ 10 chars — enforce in the mutation, surface as `ConvexError("ACKNOWLEDGE_NOTES_REQUIRED")` if too short.
  - [ ] Add basic role-gate UX: if a non-Admin loads the page, the layout's `requireRole` redirect kicks in (Story 1.5 middleware). No additional UI gate needed.

### Testing (AC1, AC2, AC4)

- [ ] **Task 8: Vitest tests in `tests/unit/convex/lib/reconciliation.test.ts`** (AC: 1, AC: 2, AC: 4)
  - [ ] Create `tests/unit/convex/lib/reconciliation.test.ts` (mirrored path per architecture's Convex test convention).
  - [ ] Use `convex-test` (Story 1.1 / 1.2 set this up) to spin a context with seeded fixtures.
  - [ ] **Test 1 (AC1 — clean fixture):** seed 50 contracts in `state: "active"`, each with payments that exactly sum to `originalAmountCents − outstandingBalanceCents`. Run `checkReconciliationInvariant`. Assert: zero rows in `reconciliationFailures`. One row appears in `reconciliationRuns` with `failuresFound: 0`, `contractsChecked: 50`.
  - [ ] **Test 2 (AC4 — the deliberate-divergence test):** seed one contract with `originalAmountCents: 100_000_00`, `outstandingBalanceCents: 60_000_00`, but seed payments summing to only `30_000_00`. Run `checkReconciliationInvariant`. Assert: exactly one row in `reconciliationFailures` with `contractId === <seededId>`, `expectedCents === 40_000_00`, `actualCents === 30_000_00`, `deltaCents === -10_000_00`, `status === "open"`. Assert no exception thrown.
  - [ ] **Test 3 (AC2 — over-paid divergence):** seed a contract where payments sum is HIGHER than expected (`actualCents > expectedCents`). Assert one row appears with positive `deltaCents`. This is the "over-recorded payment" failure mode — equally important to catch.
  - [ ] **Test 4 (AC2 — voided payments excluded):** seed a contract with 5 payments where 1 is voided (`voidedAt` set). The sum should exclude the voided one. Verify the invariant uses the non-voided sum.
  - [ ] **Test 5 (AC2 — re-run on same failure does not duplicate):** run the deliberate-divergence test fixture twice. After the second run, assert still exactly one row in `reconciliationFailures` for that contract — the row was upserted (patched), not duplicated. Verify `runAt` updated to the second run's timestamp.
  - [ ] **Test 6 (AC2 — self-resolution):** seed a failed contract, run once (failure row appears with `status: "open"`). Then patch the payments fixture to reconcile cleanly. Run again. Assert the row's `status` is now `"self_resolved"`, and the row was NOT deleted.
  - [ ] **Test 7 (AC2 — paid_off and cancelled contracts excluded):** seed 10 contracts in `state: "paid_off"` and 5 in `state: "cancelled"`, all with mismatched payment sums (real or simulated). Run the invariant. Assert: zero failures recorded — the invariant only checks active + in_default contracts per AC1.
  - [ ] **Test 8 (`acknowledgeFailure` mutation):** call `acknowledgeFailure` as Admin with `notes: "Manual ledger reconciliation completed; underpaid receipt #1234 was retroactively corrected"`. Assert the row's `status` is `"acknowledged"`, `acknowledgedBy` is the test user's id, `acknowledgedAt` is set, `notes` is captured, and an `auditLog` row was emitted with action `"reconciliation_acknowledge"`. Then call again with empty `notes` — assert `ConvexError("ACKNOWLEDGE_NOTES_REQUIRED")`.
  - [ ] **Test 9 (`acknowledgeFailure` forbidden):** call as Office Staff — assert `ConvexError("FORBIDDEN")`.
  - [ ] **Test 10 (`getReconciliationHealth` shape):** seed 3 open failures + 1 acknowledged + 1 self_resolved + a `reconciliationRuns` row. Call the query. Assert `openFailureCount === 3`, `lastRunAt === <seeded>`, etc.
  - [ ] **Coverage target:** ≥ 95% line coverage on `convex/lib/reconciliation.ts` (architecture's "financial-touching server function" threshold is ≥ 90% NFR-M2; reconciliation is safety-critical and goes above).

- [ ] **Task 9: Playwright e2e — banner appears when a failure is seeded** (AC: 3)
  - [ ] Extend `tests/e2e/journey-4-admin-dashboard.spec.ts` (Story 5.2's spec) or create `tests/e2e/reconciliation-banner.spec.ts`.
  - [ ] Scenario: sign in as Admin → seed a `reconciliationFailures` row directly via `convex/_testing/seed.ts` test helper (NEW; pattern: a `internalMutation` callable from Playwright tests via a special test endpoint — or use convex-test's seed API if Story 1.x established it). Navigate to `/dashboard`. Assert the destructive banner is visible with the correct count.
  - [ ] Click the banner → assert navigation to `/admin/reconciliation`. Assert the row appears in the list.

### Documentation (AC1, AC2)

- [ ] **Task 10: ADR + runbook entry** (AC: 1, AC: 2)
  - [ ] Write `docs/adr/0009-reconciliation-invariant.md` capturing: (a) what the invariant proves (and what it does NOT — e.g. it doesn't detect a payment that was correctly recorded but applied to the wrong contract), (b) why we re-check what `postFinancialEvent` already guarantees (defense-in-depth; restore-from-backup scenarios; future direct-DB-edit safeguards), (c) the deliberate-divergence test as proof the invariant works, (d) the 03:00 Manila scheduling rationale (off-peak; gives morning staff a fresh banner if any failures occurred overnight). Date, status: accepted.
  - [ ] Update `docs/runbook.md` (created by Story 5.6 — if it doesn't exist yet, this story creates it as part of Story 5.6's deliverable; coordinate so it lands in only one of the two stories) — add section "Reconciliation failures — how to triage": (1) open `/admin/reconciliation`, (2) for each row, click the contract code → contract detail page → review the payment ledger against the contract's amortization schedule, (3) identify the discrepancy (missing payment? double-applied? wrong contract?), (4) correct via the appropriate UI (refund-and-repost, or in extreme cases an Admin-only ledger-correction mutation — if that mutation doesn't exist yet, document the manual `npx convex run` workaround), (5) acknowledge the failure with `notes` explaining what was found and what was done.

## Dev Notes

### Previous story intelligence

This story depends on multiple cornerstones being in place:

- **Story 1.2 (requireRole + auth foundation)** — the `requireRole(ctx, ["admin"])` and `requireRole(ctx, ["admin", "office_staff"])` calls on every server function in this story. If 1.2 isn't shipped, this story can't add its queries / mutations.
- **Story 1.4 (StatusPill + ReactiveHighlight + tokens)** — the banner uses `bg-red-50 text-red-900 border-red-200` destructive tokens; the optional `ReactiveHighlight watch={openFailureCount}` wrap reuses the wrapper from 1.4. Required.
- **Story 1.6 (auditLog + emitAudit)** — `acknowledgeFailure` mutation emits an audit log entry. If 1.6 hasn't shipped, this story is blocked.
- **Story 1.7 (state machines + assertTransition)** — not strictly required for this story (no state transitions on `reconciliationFailures` use the state-machine helper; status changes are simple patches). But the design pattern (`status` as a `v.union` of literals) is consistent with the state-machine convention.
- **Story 3.2 (postFinancialEvent cornerstone)** — this is the *thing the invariant verifies*. If 3.2 isn't shipped, there's nothing to reconcile (no `payments`, no `contracts.outstandingBalanceCents` arithmetic). Hard dependency.
- **Epic 4 (AR Aging)** — establishes `convex/scheduled.ts` (may already exist when this story starts). If it does, UPDATE; if not, CREATE.
- **Story 5.2 (Dashboard)** — this story renders a banner on Story 5.2's `/dashboard` page. If 5.2 hasn't shipped, this story's Task 6 cannot land — defer Task 6 + 7 until 5.2 is in main.

**If Story 3.2 isn't shipped, do not start this story.** The invariant has nothing to check on a contract table whose balances haven't been maintained atomically.

### Architecture compliance

- **Reactive query** for the dashboard banner — `useQuery(api.dashboards.getReconciliationHealth, {})` subscribes to changes in `reconciliationFailures` rows. The moment the nightly cron inserts a new failure, every open dashboard in every browser sees the banner appear within seconds (NFR-R4's 2-hour budget is trivially met by Convex's reactivity model — no polling, no manual refresh).
- **Scheduled function via `convex/scheduled.ts`** — architecture §  Scheduled functions catalogs this exact function (FR60). The cron registration goes there; the logic goes in `convex/lib/reconciliation.ts` per the "Cron registrations only; logic in lib/ + actions/" comment in the architecture's repo tree.
- **`internalAction` not `action`** — the cron callback is internal-only. No client-side caller. Use `internalAction` so the function is not in the public `api` surface.
- **`requireRole` on every public function** — `getReconciliationHealth` (admin + office_staff), `listFailures` (admin), `acknowledgeFailure` (admin). The internal action + internal mutations do NOT need `requireRole` — they have no authenticated caller (the cron runs as the system).
- **Money helpers** — `subCents` for all delta computations. No raw `-`.
- **Audit log** — `acknowledgeFailure` emits an audit entry. The cron's writes to `reconciliationFailures` are NOT audited (the cron has no user actor; the audit log requires an actor per Story 1.6). The cron's stats land in `reconciliationRuns` instead — that's the system's record of "I ran."
- **Append-only `reconciliationFailures`**: the table allows `patch` (status transitions: open → acknowledged → self_resolved) but never `delete`. Document this as a soft convention; a lint rule could enforce it later but is not in scope for this story.

### Library / framework versions

- **Convex `cronJobs` API** — current as of Convex 1.x. `crons.daily("name", { hourUTC, minuteUTC }, internalAction)` signature.
- **`convex-test`** (Story 1.1 installed) — for the unit tests.
- No new dependencies in this story.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── lib/
│   │   └── reconciliation.ts                  # NEW (the invariant logic + internal mutations)
│   ├── reconciliation.ts                      # NEW (listFailures query + acknowledgeFailure mutation)
│   ├── scheduled.ts                           # NEW or UPDATE (cron registration)
│   ├── dashboards.ts                          # UPDATE (add getReconciliationHealth)
│   └── schema.ts                              # UPDATE (reconciliationFailures + reconciliationRuns tables)
├── src/
│   └── app/(staff)/
│       ├── dashboard/page.tsx                 # UPDATE (Story 5.2's page — add banner + footer indicator)
│       └── admin/reconciliation/page.tsx      # NEW (failures list + acknowledge UI)
├── tests/
│   ├── unit/convex/lib/reconciliation.test.ts # NEW (≥ 95% coverage including deliberate-divergence)
│   └── e2e/reconciliation-banner.spec.ts      # NEW (or extend journey-4 spec)
└── docs/
    ├── adr/0009-reconciliation-invariant.md   # NEW
    └── runbook.md                              # NEW or UPDATE (triage section)
```

If `convex/scheduled.ts` and `docs/runbook.md` were created by Story 5.6 or Epic 4 first, treat as UPDATE; otherwise NEW. The dev agent's File List must explicitly note which.

### Testing requirements

- **NFR-M2 (≥ 90% line coverage on financial-touching server functions):** `convex/lib/reconciliation.ts` is financial-touching. Target ≥ 95% (above the threshold; safety-critical code).
- **Deliberate-divergence test is non-negotiable** — AC4 requires it. Without this test, the entire story is theater: a function that always passes proves nothing.
- **`convex-test` seeding** — the test seeds `payments` and `contracts` rows directly via `ctx.db.insert` (test-context-only; not allowed in production code outside `postFinancialEvent`). Add a JSDoc comment on the test file explaining this is test-fixture seeding, not production code, and reference architecture's lint rule.
- **Playwright timing** — the banner-appears scenario uses a test-only seed endpoint to insert a `reconciliationFailures` row, then reloads the dashboard. Do not try to wait for the actual cron in CI — schedule tests are 24-hour latencies and untestable that way. The unit tests cover the cron logic; the e2e test covers only the UI surface.

### Source references

- **PRD:** [FR60 — daily reconciliation invariant](../../_bmad-output/planning-artifacts/prd.md#functional-requirements), [NFR-R4 — failures visible within 2 hours](../../_bmad-output/planning-artifacts/prd.md#reliability--availability), [NFR-M2 — coverage on financial code](../../_bmad-output/planning-artifacts/prd.md#maintainability).
- **Architecture:** [§ Scheduled functions catalog](../../_bmad-output/planning-artifacts/architecture.md#decision-impact-analysis) (FR60 listed); [§ Project Structure > convex/scheduled.ts](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure); [§ Money](../../_bmad-output/planning-artifacts/architecture.md#money) (centavo arithmetic); [§ Audit-log emission](../../_bmad-output/planning-artifacts/architecture.md#audit-log-emission); [§ Compliance — daily reconciliation invariant has a test that produces a deliberately-divergent payment](../../_bmad-output/planning-artifacts/architecture.md#testing-strategy).
- **UX:** [§ Journey 4 — Mr. Reyes Checks the Business](../../_bmad-output/planning-artifacts/ux-design-specification.md#journey-4--mr-reyes-checks-the-business) (the trust-builder context); [§ Error & recovery patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md) (banner pattern).
- **Epics:** [Story 5.5](../../_bmad-output/planning-artifacts/epics.md#story-55-daily-reconciliation-invariant-scheduled-function).
- **Previous stories:** Story 1.2 (requireRole), Story 1.4 (tokens + ReactiveHighlight), Story 1.6 (emitAudit), Story 1.7 (state machines), Story 3.2 (postFinancialEvent), Story 5.2 (dashboard page).

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT delete rows from `reconciliationFailures`.** Status transitions only (open → acknowledged → self_resolved). The audit trail of "we caught this, here's what we did" must survive forever for BIR audit defense.
- ❌ **Do NOT skip the deliberate-divergence test.** AC4 is non-negotiable. A reconciliation function with no proof it detects mismatches is worse than no function — it gives false confidence.
- ❌ **Do NOT use raw `+` / `-` on cents.** Every sum and delta goes through `subCents` / `addCents` from `convex/lib/money.ts`. The whole point of the invariant is to catch financial drift; arithmetic bugs *in the invariant itself* would defeat it.
- ❌ **Do NOT make the cron callable from the client.** `internalAction` only. Surfacing it via the `api.*` namespace would let a malicious / buggy client trigger a full-system scan on demand.
- ❌ **Do NOT log raw PII** (customer names, ID numbers) inside `reconciliationFailures` rows. Only `contractId` — the failures-detail page joins to customer data via a query that goes through `convex/lib/pii.ts` (Story 1.x PII access helper). This keeps the failures table queryable by non-Admin code (if needed) without leaking PII.
- ❌ **Do NOT emit an audit log entry for the cron's own writes.** The cron has no user actor. The audit log requires `actor` per Story 1.6's contract. Audit only the admin-initiated `acknowledgeFailure` mutation.
- ❌ **Do NOT compute the invariant on the client** (e.g. by fetching all payments + contracts to the browser and summing). The dashboard query (`getReconciliationHealth`) reads only the precomputed `reconciliationFailures` count + `reconciliationRuns` summary; the heavy work is the nightly cron.
- ❌ **Do NOT block the dashboard page render on `getReconciliationHealth`.** Use the standard `useQuery` loading pattern: while `health === undefined`, render the dashboard without the banner (the dashboard has its own loading skeletons). The banner appears once data arrives.
- ❌ **Do NOT make the banner dismissible.** No "X" to close it. The banner stays visible until the underlying failures are acknowledged. This is intentional — temporary dismissal would let real failures slip past Mr. Reyes.
- ❌ **Do NOT use `setInterval` or any polling.** Reactivity replaces polling. The `useQuery` subscription is the mechanism by which NFR-R4 is satisfied.
- ❌ **Do NOT skip the "voided payments excluded" test (Test 4).** Voided payments are the most likely edge case to mis-handle, and a wrong implementation would produce false-positive failures every day.

### Common LLM-developer mistakes to prevent

- **Computing `expectedCents` backwards:** the formula is `originalAmountCents − outstandingBalanceCents`. Inverting the sign gives a uniformly-wrong invariant that passes only when both values are equal (uncommon). Add a JSDoc + a test that asserts the formula on a 3-different-balance fixture to catch sign errors.
- **Treating `outstandingBalanceCents` as a string:** Convex stores `number`; never `string`. JavaScript's `"100" - "30" === 70` masks bugs that bite at `"100" + "30" === "10030"`. The architecture pins money to `number` (centavos) per §  Money.
- **Forgetting the `state` filter on contracts:** scanning ALL contracts (including `paid_off` and `cancelled`) would produce false positives (a paid-off contract has `outstandingBalanceCents: 0` but `originalAmountCents > 0`, and `sum(payments) === originalAmountCents` — looks fine in isolation, but if the payment fixtures are seeded inconsistently, you get spurious failures). Always filter to `state in ["active", "in_default"]`.
- **Joining payments via `ctx.db.get(paymentId)` in a loop:** O(N) round trips for thousands of payments. Use `ctx.db.query("payments").withIndex("by_contractId", q => q.eq("contractId", id))` to batch-read.
- **Wrong cron registration syntax:** Convex's `cronJobs.daily(name, { hourUTC, minuteUTC }, fnReference)` requires an `internal.*` reference for internal actions. Don't pass a string handler name.
- **`acknowledgeFailure` patching `status` without checking the current state:** if the current state is already `"acknowledged"` or `"self_resolved"`, the patch should either be a no-op or throw `ConvexError("ALREADY_RESOLVED")`. Pick one (this story's recommendation: throw — the UI should not show an "Acknowledge" button for non-open failures).
- **Skipping the `runAt` update on upsert:** when re-upserting an existing failure, the test seeds the run for a different day and asserts `runAt` is the new run's timestamp. If you forget to patch `runAt`, the "most recent run" telemetry on the dashboard goes stale.
- **Manila-tz confusion:** 03:00 Manila = 19:00 UTC the PRIOR calendar day. Off-by-one-day bugs here are common. The architecture's `convex/lib/time.ts` is for query-time period math; the cron registration is a fixed UTC offset (Convex cron expects UTC). Document the conversion in the JSDoc.

### Open questions / blockers this story does NOT resolve

- **§10 Q1 (installment grace / penalty policy):** doesn't affect the reconciliation invariant — the invariant compares recorded payments against recorded balance, regardless of policy.
- **Acknowledgment workflow scope:** this story implements a minimal "Admin acknowledges with notes" flow. A richer triage workflow (assignment, follow-up due dates, escalation) is out of scope. The `reconciliationFailures` schema supports extension (add fields without migration).
- **Who can see failure details:** Admin-only by default. If §10 follow-up specifies Office Staff should triage, expand the `requireRole` on `listFailures` and `acknowledgeFailure`. The dashboard banner is already visible to both Admin and Office Staff (via the count query) so they know failures exist.
- **Self-healing automation:** out of scope. If a failure self-resolves (clean on a subsequent run), the row's `status` flips to `"self_resolved"` but stays in the table. Auto-cleanup after N days is a future story.

### Project Structure Notes

Aligns with:
- [Architecture § Project Structure > convex/scheduled.ts](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- [Architecture § Scheduled functions catalog](../../_bmad-output/planning-artifacts/architecture.md#decision-impact-analysis) — FR60 row.
- [Architecture § Testing strategy — deliberate-divergence test required](../../_bmad-output/planning-artifacts/architecture.md#testing-strategy).

No detected conflicts.

### References

- [PRD § FR60, NFR-R4, NFR-M2](../../_bmad-output/planning-artifacts/prd.md#functional-requirements).
- [Architecture § Reliability & Availability + Scheduled functions](../../_bmad-output/planning-artifacts/architecture.md#decision-impact-analysis).
- [Architecture § Audit-log emission](../../_bmad-output/planning-artifacts/architecture.md#audit-log-emission).
- [UX § Journey 4 — Mr. Reyes Checks the Business](../../_bmad-output/planning-artifacts/ux-design-specification.md#journey-4--mr-reyes-checks-the-business).
- [Epics § Story 5.5](../../_bmad-output/planning-artifacts/epics.md#story-55-daily-reconciliation-invariant-scheduled-function).
- [Previous stories: 1.2 / 1.4 / 1.6 / 1.7 / 3.2 / 5.2](./).

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Claude Code, autonomous dev mode)

### Debug Log References

- `npm run typecheck` → clean (no errors).
- `npm run lint` → clean (`next lint` reports zero ESLint warnings or errors).
- `npx vitest run tests/unit/convex/reconciliation.test.ts` → 19/19 passed.
- `npx vitest run` (full suite) → 1650 passed, 1 skipped (pre-existing skip; unrelated).
- `npm run build` → `Compiled successfully in 7.4s`. (A post-compile
  `pages-manifest.json` ENOENT surfaces from the `npm run build:sw`
  step's expectation of a `pages/` directory that this App-Router-only
  repo doesn't have; the Story-5.5 changes don't touch the
  build-tooling path. Compile + typecheck + lint + tests are the
  binding gates and all pass.)

### Completion Notes List

This implementation deliberately deviates from the original story
spec in several places to match the schema as actually shipped by
Stories 3.3, 3.4, 3.9, and 4.1. The deviations are documented in
ADR-0014 and summarised below:

1. **File layout — story said `convex/lib/reconciliation.ts` +
   `convex/reconciliation.ts`; shipped as `convex/reconciliation.ts`
   only.** The user's task contract for this story marks
   `convex/lib/**` as READ-ONLY. All invariant logic, internal
   mutations, internal-action-equivalent (an internal mutation; see
   note 4), and the public read query live in `convex/reconciliation.ts`.
   The boundary between "logic" and "public surface" is preserved
   through internal vs public mutation visibility, not through file
   separation.

2. **Cron file — story said `convex/scheduled.ts`; shipped as an
   APPEND to `convex/crons.ts`.** Story 4.1 (`recompute-ar-aging`)
   created `convex/crons.ts` (NOT `convex/scheduled.ts`) as the
   project's single cron-registration file. This story APPENDS the
   `daily-reconciliation-invariant` registration alongside the AR
   aging cron, keeping a single source of truth for the deployment's
   cron schedule. The dynamic `internal` import pattern from Story 4.1
   is reused verbatim — codegen-friendly without breaking typecheck
   pre-`npx convex dev`.

3. **Invariant set — story said `sum(payments) === originalAmountCents
   − outstandingBalanceCents` (Phase-1 schema does not carry these
   fields); shipped as three structural invariants that cover the
   same risk surface against the actual schema.** See ADR-0014 for
   the full rationale. The three invariants are:
     - `payments_match_allocations` — every non-voided payment's
       allocations sum exactly to `payments.amountCents`.
     - `contract_total_ok` — every contract's applied allocations
       (direct + transitive via installments) do not exceed
       `contracts.totalPriceCents`.
     - `installment_paid_bounded` — every installment's
       `paidCents <= principalCents`.

4. **`internalAction` vs `internalMutation` for the cron body.** Convex
   actions cannot do DB writes directly; the cron body needs to write
   the `reconciliationRuns` row. Story 4.1's `recompute-ar-aging` uses
   the same pattern (an `internalMutationGeneric` invoked from the
   cron). We follow that precedent — `internal_runDailyReconciliation`
   is an `internalMutationGeneric`, not an action.

5. **`reconciliationFailures` table NOT shipped — story called for it
   but the dashboard tile / banner work + the rich triage workflow are
   deferred to a follow-up story.** The current `reconciliationRuns`
   table embeds a `summary.discrepancies` array (capped at 50 entries
   with a `truncated` flag) which the dashboard tile reads directly.
   A future `reconciliationFailures` row-level workflow can land
   without a schema migration; the embedded array is the data, the
   future table would be the workflow on top.

6. **No dashboard UI banner / `/admin/reconciliation` page shipped.**
   The user's task contract restricts `src/**` (per "NOT allowed"
   section). The dashboard banner + failures-detail page are deferred
   to a follow-up story that owns the dashboard page surface.

7. **No `docs/runbook.md` entry shipped.** The runbook does not exist
   yet (Story 5.6 owns it). The triage flow is captured in the ADR-0014
   "What this invariant does NOT prove" + "Consequences" sections
   instead.

**Deliberate-divergence test exact assertion (AC4 / Story spec § Dev
Agent Record explicit requirement):** the test in
`tests/unit/convex/reconciliation.test.ts` named
`"DELIBERATE DIVERGENCE (AC4): payment.amountCents=10000.00 but
allocations sum=8000.00 → status fail, mismatches=1, delta=-2000.00"`
asserts:
  - `summary.checked === 1`
  - `summary.mismatches === 1`
  - `summary.discrepancies[0].paymentId === "payments:1"`
  - `summary.discrepancies[0].expectedCents === 10_000_00`
  - `summary.discrepancies[0].actualCents === 8_000_00`
  - `summary.discrepancies[0].deltaCents === -2_000_00`

A second deliberate-divergence test in the `installment_paid_bounded`
suite asserts `summary.discrepancies[0].overByCents === 1_000_00`
(installment with `principalCents: 5_000_00`, `paidCents: 6_000_00`).
A third end-to-end deliberate-divergence test in the cron-body
describe block proves that mismatches in two independent invariants
surface in the same run without affecting each other.

**File-creation explicit notes:**
  - `convex/crons.ts` — UPDATEd (created by Story 4.1; this story
    APPENDED the reconciliation registration alongside the existing
    AR aging registration).
  - `docs/runbook.md` — NOT created (out of scope per user contract;
    Story 5.6 owns).
  - `docs/adr/0014-reconciliation-invariants.md` — NEW (next free
    ADR number; 0014 was the first unused slot after 0001-0013).

### File List

- **NEW** `convex/reconciliation.ts` — three invariant checks +
  internal mutations + `runReconciliationNow` admin mutation +
  `getLatestReconciliation` admin query.
- **NEW** `tests/unit/convex/reconciliation.test.ts` — 19 tests
  covering all three invariants (clean + deliberate-divergence
  fixtures), the cron-body mutation, the admin escape-hatch
  mutation (auth gates), and the public read query.
- **NEW** `docs/adr/0014-reconciliation-invariants.md` — decision
  record + scope-deviation rationale.
- **MODIFIED** `convex/schema.ts` — added `reconciliationRuns` table
  with `by_runAt` + `by_checkType_runAt` indexes.
- **MODIFIED** `convex/crons.ts` — APPENDED the daily-reconciliation
  cron registration alongside the existing recompute-ar-aging entry.
