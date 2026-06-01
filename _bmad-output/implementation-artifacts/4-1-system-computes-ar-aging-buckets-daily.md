# Story 4.1: System Computes AR Aging Buckets Daily

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an **Admin / Owner**,
I want **the system to recompute AR aging buckets (current / 30 / 60 / 90+ days) for every active contract on a daily schedule**,
so that **the dashboard always reflects current receivables without manual calculation and Mr. Reyes's "₱X in 90+ days, Y% with logged follow-up" reassurance line is always truthful within a 24-hour window** (FR34, NFR-P3 dashboard freshness).

This story stands up the **first Convex scheduled function** in the codebase and the **`arAgingSnapshots` summary doc pattern** that the dashboard (Story 5.2) and the AR aging drill-down table (Story 4.8) read against. Every subsequent collections story (4.2, 4.3, 4.5) writes to or invalidates these snapshots; getting the schema + cron + idempotent recompute right here means later stories just enqueue a recompute and trust it.

## Acceptance Criteria

1. **AC1 — Daily cron fires at 02:00 Manila time**: `convex/scheduled.ts` registers a `crons` entry `"recompute-ar-aging"` that calls `internalAction(api.scheduled.internal_recomputeArAgingDaily)` daily at 18:00 UTC (= 02:00 Asia/Manila, no DST in PH). The cron is the only call site that runs on a schedule; the action is also exposed for manual replay via `npx convex run scheduled:internal_recomputeArAgingDaily`. Cron registration is verified by `npx convex dev` output and by inspecting `convex/scheduled.ts`'s `crons.daily(...)` call.

2. **AC2 — Recompute writes one snapshot row per active contract**: The internal action iterates every contract in state `active` or `in_default`, computes per-installment `daysOverdue = max(0, floor((now - installment.dueAt) / DAY_MS))` for each unpaid installment, derives the **single most-overdue bucket** for the contract (current → days_30 → days_60 → days_90Plus precedence), sums the contract's `totalOverdueCents` across all unpaid installments, counts overdue installments with vs. without an active (non-expired) `followUpAction`, and writes / updates a row in the `arAgingSnapshots` table keyed by `contractId`. After the run, every active / in-default contract has exactly one snapshot row; no orphans, no duplicates.

3. **AC3 — Snapshot row is the dashboard's source of truth for AR aging**: The `arAgingSnapshots` table schema includes `contractId` (indexed), `bucket: "current" | "days_30" | "days_60" | "days_90Plus"`, `totalOverdueCents`, `overdueCountWithAction`, `overdueCountSilent`, `recomputedAt` (unix ms). A new public query `api.arAging.getAgingSummary` (Admin-gated) aggregates the table into `{ currentCents, days30Cents, days60Cents, days90PlusCents, totalSilentCount, totalWithActionCount, oldestSnapshotAt }` — the shape Story 5.2 / 4.8 will consume. Bucket totals **sum to the total AR** with no double-counting (each contract appears in exactly one bucket).

4. **AC4 — Recompute is idempotent and append-safe**: Running the action twice in succession produces identical snapshot rows (no extra inserts, no diverging values for the same `(contractId, dueAt set)`). The action does NOT call `postFinancialEvent` and does NOT mutate `payments`, `receipts`, `contracts.balance`, or any financial table — it only reads them and patches `arAgingSnapshots`. The ESLint rule from Story 3.2 protecting financial-table writes must continue to pass.

5. **AC5 — Backfill on first run + recovery on missed run**: When the action runs against a deployment that has no `arAgingSnapshots` rows yet (first run), it inserts rows for every active / in-default contract. When a previous day's run was missed (e.g. Convex Cloud outage), the next run produces the same correct snapshot it would have produced — there is no "catch-up" semantics; today's snapshot is today's snapshot. The action logs the start, the contract count processed, and the end timestamp to console output (visible via `npx convex logs`).

## Tasks / Subtasks

### Schema + helper foundation (AC2, AC3)

- [ ] **Task 1: Add `arAgingSnapshots` table to schema** (AC: 2, 3)
  - [ ] In `convex/schema.ts`, add:
    ```ts
    arAgingSnapshots: defineTable({
      contractId: v.id("contracts"),
      bucket: v.union(
        v.literal("current"),
        v.literal("days_30"),
        v.literal("days_60"),
        v.literal("days_90Plus"),
      ),
      totalOverdueCents: v.number(),         // sum of all unpaid + overdue installment principals
      overdueCountWithAction: v.number(),    // installments overdue AND with an active (non-expired) followUpAction
      overdueCountSilent: v.number(),        // installments overdue AND with no active followUpAction
      oldestDueAt: v.optional(v.number()),   // unix ms of the oldest unpaid installment's due date, if any
      recomputedAt: v.number(),              // unix ms when this row was last written
    })
      .index("by_contract", ["contractId"])
      .index("by_bucket", ["bucket"])
      .index("by_bucket_overdue_desc", ["bucket", "totalOverdueCents"]),
    ```
  - [ ] The `by_contract` index supports upsert lookups. The `by_bucket` and `by_bucket_overdue_desc` indexes are reserved for Story 4.8's drill-down table query — defining them here avoids a future schema migration.
  - [ ] Run `npx convex dev` and confirm `_generated/dataModel.d.ts` picks up the new table.

- [ ] **Task 2: Day-bucket helper in `convex/lib/arAging.ts`** (AC: 2, 3)
  - [ ] Create `convex/lib/arAging.ts` exporting a pure function:
    ```ts
    export function bucketFromDaysOverdue(daysOverdue: number):
      "current" | "days_30" | "days_60" | "days_90Plus" {
      if (daysOverdue <= 0) return "current";
      if (daysOverdue < 30) return "current"; // <30 days late still considered "current" bucket per UX-DR aging definition
      if (daysOverdue < 60) return "days_30";
      if (daysOverdue < 90) return "days_60";
      return "days_90Plus";
    }
    ```
  - [ ] Document the bucket boundaries inline. **The "current" bucket means "no installment more than 30 days overdue"** — it is the not-yet-alarming bucket. Confirm with PM if the cemetery needs a separate "0–29 day" bucket later; for now we collapse it into `current` because the AR aging UX only distinguishes 30 / 60 / 90+.
  - [ ] Export `pickMostOverdueBucket(installments: { dueAt: number, paidAt?: number }[], nowMs: number)` that returns the highest-precedence bucket across all unpaid installments (`days_90Plus > days_60 > days_30 > current`).
  - [ ] All time math uses `DAY_MS` from `convex/lib/time.ts` (Story 1.2 introduced `HOUR_MS`/`DAY_MS`).

- [ ] **Task 3: Per-contract recompute helper** (AC: 2, 3, 4)
  - [ ] In `convex/lib/arAging.ts`, add `export async function recomputeAgingForContract(ctx: MutationCtx, contractId: Id<"contracts">, nowMs: number): Promise<void>`.
  - [ ] Implementation:
    1. Fetch the contract; bail if state is not `active` or `in_default`.
    2. Query the `installments` table by `by_contract` index for this `contractId`.
    3. Filter unpaid installments (`installment.paidAt === undefined` OR `installment.status !== "paid"` — match Story 3.4 / 3.9's installment schema; if the field name differs, defer to whatever Story 3.4 named it and update this helper).
    4. For each unpaid installment, compute `daysOverdue` from `dueAt`.
    5. Sum `totalOverdueCents` from installments where `daysOverdue > 0`.
    6. Pick `bucket` via `pickMostOverdueBucket`.
    7. Query `followUpActions` by `by_installment` index for each overdue installment; an installment counts as "with action" if any `followUpAction` exists with `status === "active"` and `targetDate >= now` (Story 4.2 introduces this table).
    8. Count `overdueCountWithAction` and `overdueCountSilent`.
    9. Compute `oldestDueAt` (min of unpaid `dueAt` values, or undefined if none).
    10. Look up existing snapshot via `by_contract` index. If exists → `ctx.db.patch(existing._id, { ...computed, recomputedAt: nowMs })`. Else → `ctx.db.insert("arAgingSnapshots", { contractId, ...computed, recomputedAt: nowMs })`.
  - [ ] **This helper is invoked from three places** (define the call sites, do not implement them outside this story unless trivial): (a) the daily cron action, (b) Story 4.2's mutation after a `followUpAction` is created, (c) Story 4.3's expiry action. It must therefore be safe to call mid-mutation with a single `contractId`.

### Scheduled action wiring (AC1, AC2, AC4, AC5)

- [ ] **Task 4: Create / extend `convex/scheduled.ts` with cron registration** (AC: 1)
  - [ ] If `convex/scheduled.ts` does not yet exist, create it (it doesn't — this is the first scheduled function in the codebase per architecture § Project Structure).
  - [ ] Structure:
    ```ts
    import { cronJobs } from "convex/server";
    import { internal } from "./_generated/api";
    import { internalAction } from "./_generated/server";

    const crons = cronJobs();

    crons.daily(
      "recompute-ar-aging",
      { hourUTC: 18, minuteUTC: 0 },   // 02:00 Asia/Manila (UTC+8, no DST)
      internal.scheduled.internal_recomputeArAgingDaily,
    );

    export default crons;
    ```
  - [ ] Add `internal_recomputeArAgingDaily` as an `internalAction` in the same file. Action body: read every contract in state `active` or `in_default` via `ctx.runQuery`, then for each one call `ctx.runMutation(internal.arAging.internal_recomputeAgingForContractMutation, { contractId })`. Loop is sequential (cap ~2,000 contracts in Phase 1 — well under the action 10-min timeout). Log `console.log("[arAging] start", contractCount)` at start and `console.log("[arAging] end", { processed, elapsedMs })` at end.
  - [ ] **Internal functions are exempt from the `require-role-first-line` ESLint rule** (Story 1.2's lint rule excludes `internal*`). Document this explicitly in a JSDoc on the action: `/** Internal action: invoked by cron only; no user context to authenticate. */`

- [ ] **Task 5: Create internal wrapper mutation** (AC: 2, 4)
  - [ ] In `convex/arAging.ts` (new file), export `internal_recomputeAgingForContractMutation = internalMutation({ args: { contractId: v.id("contracts") }, handler: async (ctx, { contractId }) => recomputeAgingForContract(ctx, contractId, Date.now()) })`.
  - [ ] Per architecture's "internal functions exempt from `requireRole`": JSDoc the function as internal-only.
  - [ ] **Why an internal mutation rather than running the loop body inline in the action?** Convex actions cannot do DB writes directly; they call mutations. Wrapping per-contract recompute in its own mutation also gives us per-contract atomicity — a failed contract write rolls back only that contract's snapshot, not the whole run.

### Public query for dashboard consumers (AC3)

- [ ] **Task 6: Add `api.arAging.getAgingSummary` public query** (AC: 3)
  - [ ] In `convex/arAging.ts`, export:
    ```ts
    export const getAgingSummary = query({
      args: {},
      handler: async (ctx) => {
        await requireRole(ctx, ["admin", "office_staff"]);
        const rows = await ctx.db.query("arAgingSnapshots").collect();
        const init = { currentCents: 0, days30Cents: 0, days60Cents: 0, days90PlusCents: 0, totalSilentCount: 0, totalWithActionCount: 0, oldestSnapshotAt: undefined as number | undefined };
        return rows.reduce((acc, row) => {
          if (row.bucket === "current")     acc.currentCents     += row.totalOverdueCents;
          if (row.bucket === "days_30")     acc.days30Cents      += row.totalOverdueCents;
          if (row.bucket === "days_60")     acc.days60Cents      += row.totalOverdueCents;
          if (row.bucket === "days_90Plus") acc.days90PlusCents  += row.totalOverdueCents;
          acc.totalSilentCount      += row.overdueCountSilent;
          acc.totalWithActionCount  += row.overdueCountWithAction;
          if (acc.oldestSnapshotAt === undefined || row.recomputedAt < acc.oldestSnapshotAt) acc.oldestSnapshotAt = row.recomputedAt;
          return acc;
        }, init);
      },
    });
    ```
  - [ ] The query must start with `await requireRole(...)` (Story 1.2 lint rule).
  - [ ] **No client-facing query for individual snapshots in this story** — Story 4.8 introduces the drill-down query that paginates `by_bucket_overdue_desc`. This story only ships the summary aggregation.

- [ ] **Task 7: Add `api.arAging.getSnapshotForContract` public query** (AC: 3)
  - [ ] Convenience query: `query({ args: { contractId: v.id("contracts") }, handler: async (ctx, { contractId }) => { await requireRole(ctx, ["admin", "office_staff"]); return ctx.db.query("arAgingSnapshots").withIndex("by_contract", q => q.eq("contractId", contractId)).first(); }})`.
  - [ ] Used by the contract detail page (Story 3.6 already shipped the page; this query just adds an additional reactive tile). Not load-bearing for this story's ACs but trivially scoped here.

### Testing (AC1, AC2, AC3, AC4, AC5)

- [ ] **Task 8: Unit tests for `bucketFromDaysOverdue` + `pickMostOverdueBucket`** (AC: 2)
  - [ ] Create `tests/unit/convex/lib/arAging.test.ts` (mirrors source per architecture's test convention).
  - [ ] Coverage:
    - `daysOverdue = 0` → `"current"`
    - `daysOverdue = 29` → `"current"`
    - `daysOverdue = 30` → `"days_30"`
    - `daysOverdue = 59` → `"days_30"`
    - `daysOverdue = 60` → `"days_60"`
    - `daysOverdue = 90` → `"days_90Plus"`
    - `daysOverdue = 365` → `"days_90Plus"`
    - `pickMostOverdueBucket` with one `days_90Plus` installment + several `current` → returns `"days_90Plus"`.
    - `pickMostOverdueBucket` with empty installment list → returns `"current"`.

- [ ] **Task 9: Convex-test integration tests for `recomputeAgingForContract`** (AC: 2, 3, 4)
  - [ ] In `tests/unit/convex/arAging.test.ts`, build a fixture contract with 4 installments (1 paid, 1 unpaid current, 1 unpaid 45 days overdue, 1 unpaid 100 days overdue). Call the helper. Assert:
    - The snapshot row is created with `bucket = "days_90Plus"` (highest precedence).
    - `totalOverdueCents` sums only the unpaid + overdue installments (excludes the paid one and the current one).
    - `overdueCountSilent = 2`, `overdueCountWithAction = 0` (no followUpActions seeded).
    - Calling the helper a second time produces the **same** snapshot row (idempotency: one row, identical values modulo `recomputedAt`).
  - [ ] **Test follow-up-action counting** (depends on Story 4.2's `followUpActions` table existing — if Story 4.2 has not yet shipped at the time this story is implemented, gate this test with `it.skip` and a TODO note linking to Story 4.2). Seed a `followUpAction` with `status: "active"` and `targetDate: now + 7 days` on one of the overdue installments; re-run; assert `overdueCountWithAction = 1, overdueCountSilent = 1`.
  - [ ] **Test scheduled-action driver** (`internal_recomputeArAgingDaily`): seed 3 contracts (1 active, 1 in_default, 1 cancelled). Run the action via `convex-test`'s action invocation helper. Assert exactly 2 snapshot rows exist after (cancelled contracts produce no snapshot).

- [ ] **Task 10: Test the `getAgingSummary` query** (AC: 3)
  - [ ] Seed 5 snapshots across buckets. Call the query. Assert the returned `{currentCents, days30Cents, days60Cents, days90PlusCents}` matches the sum of input rows by bucket and `totalSilentCount + totalWithActionCount` equals the sum of those fields.
  - [ ] Assert calling the query without auth throws `UNAUTHENTICATED`. Calling as `field_worker` throws `FORBIDDEN`.

### Documentation (AC1, AC5)

- [ ] **Task 11: ADR-0007 (or next available number) — Scheduled function pattern** (AC: 1, 5)
  - [ ] Write `docs/adr/000X-scheduled-functions-and-summary-docs.md` capturing the decision: "Scheduled functions live in `convex/scheduled.ts`; per-contract recompute logic lives in `convex/lib/arAging.ts`; daily AR aging materializes into the `arAgingSnapshots` summary table (pre-aggregation, per architecture's exception to the reactive-queries-default rule). UTC 18:00 = Asia/Manila 02:00, no DST. Recompute is idempotent — safe to manually re-run."
  - [ ] Note the architecture decision-impact section (line 102, 234, 236): pre-aggregated summary docs are the documented escape hatch from "live aggregation queries only"; AR aging is exactly the use case that justified that escape hatch.

- [ ] **Task 12: Update `docs/runbook.md`** (AC: 5)
  - [ ] Add a "Scheduled functions" section listing `recompute-ar-aging` with: cron expression, expected run time on a 2,000-contract dataset (estimate < 60s based on Convex per-mutation budget), how to view logs (`npx convex logs`), how to manually re-run (`npx convex run scheduled:internal_recomputeArAgingDaily`), what to check if the daily run is missing (Convex dashboard cron history).

## Dev Notes

### Previous story intelligence

**Epic 1 foundation (Stories 1.1–1.9):**
- `convex/lib/auth.ts` already exports `requireRole(ctx, [...])` (Story 1.2). All public queries in this story call it.
- `convex/lib/errors.ts` has the `ErrorCode` constants (Story 1.2). No new error codes are needed here.
- `convex/lib/time.ts` exposes `HOUR_MS`, `DAY_MS` (Story 1.2). Reuse — do not redefine.
- `convex/lib/audit.ts` is available (Story 1.6) but **NOT called from this story** — aging recompute is a read + summary-table-only write; it does not touch financial tables and does not need audit entries per architecture's audit-emission boundary.
- `convex/lib/stateMachines.ts` is available (Story 1.7) — also not called here; aging recompute doesn't transition contracts.

**Epic 3 dependencies (must be shipped before this story implements):**
- **Story 3.2 (`postFinancialEvent`)** — installed the lint rule "no direct writes to `payments` / `receipts` / `paymentAllocations`." This story doesn't write to those tables; it reads `installments` and writes `arAgingSnapshots` only. Lint rule should not fire.
- **Story 3.4 (Office Staff records installment sale with schedule)** — created the `installments` table with `contractId`, `dueAt`, `amountCents`, `status` (or equivalent). This story's `recomputeAgingForContract` reads via the `by_contract` index on `installments`. **If Story 3.4's installment field names diverge from this story's assumptions (`dueAt`, `paidAt`, `status: "paid"`), align with Story 3.4 — do not invent your own.**
- **Story 3.6 (Contract state machine transitions)** — established the contract states `active | fully_paid | cancelled | in_default | transferred`. This story filters on `active` + `in_default`.

**Story 4.2 (next sibling, may ship in parallel):** Introduces the `followUpActions` table. This story's `recomputeAgingForContract` references it. **If 4.2 ships first**, the helper works as written. **If 4.1 ships first**, the follow-up-action counting code in Task 3 step 7 must conditionally check for the table's existence — Convex's `ctx.db.query("followUpActions")` will throw if the table doesn't exist. **Recommended sequencing: implement 4.2's schema addition first (just the `defineTable` call, no UI), then implement 4.1 in full.** Or merge the schema additions into a single PR. Surface this to PM if the sprint sequencing is unclear.

### Architecture compliance

- **Pre-aggregated summary doc pattern** (architecture § Tech Stack rationale line 102, § Design Patterns line 234–236): AR aging is the canonical use case for pre-aggregation. Live aggregation over `installments` × `contracts` × `followUpActions` would not meet NFR-P3 dashboard freshness without the snapshot table.
- **Scheduled function location** (architecture § Project Structure line 444, 695): cron registrations live in `convex/scheduled.ts`; per-contract logic lives in `convex/lib/arAging.ts`; domain queries live in `convex/arAging.ts`. This story creates all three.
- **Internal vs public function boundary** (architecture § Internal-only functions line 851; § Communication Patterns line 897): the recompute body is `internalMutation` (server-to-server only, exempt from the `require-role-first-line` lint rule); the dashboard-facing aggregation is a public `query` with `requireRole`.
- **Centavo arithmetic** (architecture § Format Patterns line 482–486): all `totalOverdueCents` math is integer sums; no division, no floating-point. The `money.ts` helpers from Story 3.x are available if needed but are overkill for a simple sum loop.
- **Manila timezone** (architecture § Format Patterns line 488–493): the cron is scheduled in UTC; the comment documents the Manila-time intent. No DST adjustment needed (Philippines has no DST).

### Library / framework versions (researched current)

- **`convex/server`'s `cronJobs()`** — built-in to the `convex` package. No additional dependency.
- **`convex-test`** — Story 1.2 installed. Use its action / mutation invocation harness here; the package documents `t.action(...)` and `t.mutation(...)` helpers.
- **No new external dependencies are introduced by this story.**

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                          # UPDATE (add arAgingSnapshots table + 3 indexes)
│   ├── arAging.ts                         # NEW (public queries + internal_recomputeAgingForContractMutation)
│   ├── scheduled.ts                       # NEW (crons registration + internal_recomputeArAgingDaily action)
│   └── lib/
│       └── arAging.ts                     # NEW (pure helpers: bucketFromDaysOverdue, pickMostOverdueBucket, recomputeAgingForContract)
├── tests/
│   └── unit/
│       └── convex/
│           ├── lib/
│           │   └── arAging.test.ts        # NEW (pure helper tests)
│           └── arAging.test.ts            # NEW (convex-test integration tests for query + scheduled action)
├── docs/
│   ├── adr/
│   │   └── 000X-scheduled-functions-and-summary-docs.md  # NEW (next available ADR number)
│   └── runbook.md                          # UPDATE (add Scheduled functions section)
└── _bmad-output/implementation-artifacts/   # this story file
```

**Naming clarification:** there are two `arAging.ts` files by design — `convex/arAging.ts` holds Convex queries / mutations (matches the per-domain file convention in architecture line 442); `convex/lib/arAging.ts` holds shared helpers (matches `convex/lib/<helper>.ts` convention in architecture line 399). The split is canonical for this codebase.

### Testing requirements

- **NFR-M2 financial-code coverage** does NOT apply directly (the helper does not touch `payments`/`receipts`/`contracts.balance`). However, the bucket-math logic is load-bearing for FR34 and Mr. Reyes's trust in the dashboard. Target: **≥ 90% line coverage** on `convex/lib/arAging.ts` and `convex/arAging.ts`; **100% branch coverage** on `bucketFromDaysOverdue` (the boundary conditions at 29/30/59/60/89/90 are exactly the kind of thing that breaks silently).
- **Convex-test action invocation:** use `t.action(internal.scheduled.internal_recomputeArAgingDaily, {})`. Document the harness pattern in a comment at the top of the test file so future scheduled-function tests (Stories 4.3, 5.7) can copy it.
- **No e2e test in this story** — the cron's effect is verified visually on the dashboard in Story 5.2's e2e spec. Re-running the cron from the office staff UI is not a Phase 1 feature.

### Source references

- **PRD:** [FR34](../../_bmad-output/planning-artifacts/prd.md#functional-requirements) (AR aging buckets daily); [NFR-P3](../../_bmad-output/planning-artifacts/prd.md#performance) (dashboard freshness)
- **Architecture:** [§ Tech Stack rationale > Reactive query subscriptions](../../_bmad-output/planning-artifacts/architecture.md#tech-stack) (pre-aggregated summary docs exception); [§ Design Patterns > Pre-aggregation](../../_bmad-output/planning-artifacts/architecture.md#design-patterns); [§ Project Structure](../../_bmad-output/planning-artifacts/architecture.md#project-structure) (file locations for `convex/arAging.ts`, `convex/scheduled.ts`, `convex/lib/arAging.ts`); [§ Communication Patterns > Scheduled triggers](../../_bmad-output/planning-artifacts/architecture.md#communication-patterns); [§ Pattern Examples > Internal-only functions](../../_bmad-output/planning-artifacts/architecture.md#internal-only-functions)
- **UX:** [§ Mr. Reyes journey > AR-aging surfacing](../../_bmad-output/planning-artifacts/ux-design-specification.md) (the "₱X with logged follow-up" framing this story enables); [§ Reactive change indicator](../../_bmad-output/planning-artifacts/ux-design-specification.md) (the snapshot drives the dashboard tile's reactive update)
- **Convex docs (current):** [Cron jobs](https://docs.convex.dev/scheduling/cron-jobs) · [Internal functions](https://docs.convex.dev/functions/internal-functions) · [Scheduled functions in actions](https://docs.convex.dev/scheduling/scheduled-functions)
- **Epics:** [§ Story 4.1](../../_bmad-output/planning-artifacts/epics.md#story-41-system-computes-ar-aging-buckets-daily)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT register the cron more than once.** `crons.daily("recompute-ar-aging", ...)` — one entry, named uniquely. Convex deduplicates by cron name, but having two callers writing to the same snapshot row would not produce wrong data (idempotent helper) but would burn schedule slots and confuse the runbook.
- ❌ **Do NOT mutate financial tables from inside the recompute action.** The action must not call `postFinancialEvent`, must not write to `payments` / `receipts` / `paymentAllocations` / `contracts.balance`. The aging recompute is **read-only over financial data** + write-only over `arAgingSnapshots`. The Story 3.2 ESLint rule will catch this; do not `// eslint-disable` it.
- ❌ **Do NOT count one contract in multiple buckets.** Each contract appears in exactly its most-overdue bucket. Buckets must sum to the total AR. Test for this explicitly.
- ❌ **Do NOT call `requireRole` in `internalAction` or `internalMutation` handlers.** Internal functions have no user context. The ESLint rule from Story 1.2 already exempts `internal*` functions; do not undermine that exemption by adding "for safety" calls.
- ❌ **Do NOT add a `ctx.scheduler.runAfter(...)` loop** that re-queues itself. Use `crons.daily(...)` for the schedule. A self-rescheduling action drifts and is harder to monitor.
- ❌ **Do NOT compute `daysOverdue` using `new Date(...)` or `Date.parse(...)` in the helper.** All time math is integer milliseconds — `Math.floor((nowMs - dueAt) / DAY_MS)`. Using `Date` math in a server function risks DST / timezone bugs even though Manila has no DST (defense in depth for the day someone runs the code elsewhere).
- ❌ **Do NOT skip the empty-table case.** First-run behavior: no snapshots yet → action inserts one row per contract. Test for this — the harness defaults to an empty table.
- ❌ **Do NOT block the cron on a single slow contract.** Run the per-contract recompute via `ctx.runMutation` inside a sequential loop; one failed mutation logs and continues. (Use `try { await runMutation(...) } catch (e) { console.error(...); }` inside the action.) The cron's job is "best-effort daily refresh"; one bad contract should not stop the other 1,999 from updating.

### Common LLM-developer mistakes to prevent

- **Reinventing the cron API:** Use `cronJobs()` from `convex/server` exactly as the [Convex docs](https://docs.convex.dev/scheduling/cron-jobs) show. Do not write a `setInterval` or a self-rescheduling `ctx.scheduler.runAfter` loop.
- **Wrong file split:** `convex/arAging.ts` is Convex queries / mutations only (with `requireRole`); `convex/lib/arAging.ts` is pure helpers (no `ctx` types in the function signatures unless explicitly typed `MutationCtx`). Don't lump everything into one file.
- **Floating-point AR sums:** `totalOverdueCents` is `number` but always an integer. Don't introduce `Number.parseFloat` or `Math.round` — the inputs are already integer cents from the `installments` table.
- **Querying without an index:** `ctx.db.query("installments").filter(q => q.eq(q.field("contractId"), id))` is **wrong** — use `.withIndex("by_contract", q => q.eq("contractId", id))`. Convex's `filter` does a table scan; `withIndex` uses the index. NFR-P4 (query p95 < 300ms) requires the indexed path.
- **Forgetting the new public query needs `requireRole`:** Story 1.2's lint rule will fail the build if you omit it. The internal helpers don't need it, but `getAgingSummary` and `getSnapshotForContract` do.
- **Treating the action as a query:** Convex `internalAction` runs in a Node-equivalent context and **cannot write to the DB directly**. It must call `ctx.runQuery` / `ctx.runMutation`. The body of the action loops contracts and dispatches one internal mutation per contract.
- **Computing `now` once per contract:** Pass `nowMs` into the helper as a parameter from the action's body (computed once via `Date.now()` at the start of the action). Do NOT call `Date.now()` per contract — minor inconsistency creeps in across long runs.

### Open questions / blockers this story does NOT resolve

- **None.** This story is fully unblocked by the answered questions (the bucket boundaries are conventional; aging recompute is policy-independent). It does NOT depend on §10 Q1 (installment policy) — that question affects schedule generation (Story 3.4) and reclaim (Story 4.5), not aging math.
- One sequencing note: Story 4.2 introduces `followUpActions`. If 4.2's schema lands before 4.1, the follow-up-action counting in Task 3 step 7 works as written. If 4.1 lands first, gate that counting code behind a feature check and document the gap.

### Project Structure Notes

Aligns with:
- [Architecture § Project Structure & Boundaries > Complete Project Directory Structure](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure) — `convex/arAging.ts` (line 680), `convex/scheduled.ts` (line 695), `convex/lib/arAging.ts` (implied by the `convex/lib/<helper>.ts` pattern at line 399).
- [Architecture § Tech Stack > Reactive query subscriptions](../../_bmad-output/planning-artifacts/architecture.md#tech-stack) — pre-aggregation is an explicit, documented exception for AR aging and dashboard summaries.

No detected conflicts.

### References

- [PRD § Functional Requirements > FR34](../../_bmad-output/planning-artifacts/prd.md#financial--contracts)
- [Architecture § Tech Stack > Reactive query subscriptions](../../_bmad-output/planning-artifacts/architecture.md#tech-stack)
- [Architecture § Project Structure & Boundaries](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries)
- [Architecture § Communication Patterns > Scheduled triggers](../../_bmad-output/planning-artifacts/architecture.md#communication-patterns)
- [UX § Mr. Reyes journey](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [Epics § Story 4.1](../../_bmad-output/planning-artifacts/epics.md#story-41-system-computes-ar-aging-buckets-daily)
- [Previous story (3.6)](./3-6-contract-state-machine-transitions.md) — established `active` / `in_default` states that this story filters on
- Convex docs (current): [Cron jobs](https://docs.convex.dev/scheduling/cron-jobs) · [Internal functions](https://docs.convex.dev/functions/internal-functions)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Claude Code dev-story workflow)

### Debug Log References

- `convex/arAging.ts` written end-to-end (helpers + internal mutations + public queries) instead of the originally planned `convex/lib/arAging.ts` split, because the user-supplied file-ownership boundary marked `convex/lib/**` READ-ONLY for this story. Behavior is identical; the pure helpers (`bucketFromDaysOverdue`, `pickMostOverdueBucket`) are still exported from `convex/arAging.ts` so the unit tests can exercise them in isolation.
- `convex/crons.ts` written instead of `convex/scheduled.ts` per the user task's explicit filename. Functionally equivalent — single `crons.daily(...)` registration.
- Cron time is **01:00 Manila / 17:00 UTC** per the user task ("Daily cron at 1 AM Manila"). The story brief said "02:00 Manila / 18:00 UTC"; the implementation follows the dev-task instruction.
- Bucket vocabulary is `current | 1-30 | 31-60 | 61-90 | 90+` (5 literals) per the user task and the existing dashboard `ArAgingBucketKey` union — diverges from the story brief's `current | days_30 | days_60 | days_90Plus` (4 literals collapsing 1-30 into current) to keep the schema consistent with the already-shipped dashboard contract.
- The `convex/crons.ts` registration uses a try/catch dynamic import of `./_generated/api` because that codegen directory is created by `npx convex dev` (which has not been run in this repo). The pattern mirrors the `_generated/`-gated branches in `convex/lib/audit.ts` and `convex/lib/piiAccess.ts`.

### Completion Notes List

- **Schema:** Added `arAgingSnapshots` table to `convex/schema.ts` with three indexes (`by_contract`, `by_bucket`, `by_bucket_overdue_desc`). The Story 4.8 drill-down indexes are defined now to avoid a future schema migration.
- **Helpers:** `bucketFromDaysOverdue` (5-bucket classifier with closed upper bounds) and `pickMostOverdueBucket` (highest-precedence picker; ignores `paid` / `waived` installments).
- **Recompute mutation:** `internal_recomputeAgingForContractMutation` upserts by `by_contract` index — insert when absent, patch when present, **delete when the contract is no longer active / in_default** (so stale snapshots do not pollute the dashboard).
- **Cron body:** `internal_recomputeAllAging` queries the `contracts.by_state` index twice (`active` + `in_default`), then loops per-contract with per-iteration try/catch so one bad row does not break the run. Logs `start` / `end` with `processed` / `skipped` counts.
- **Admin escape hatch:** `recomputeNow` mutation (admin-only) for on-demand recompute from the runbook.
- **Public queries:** `getAgingSummary` (dashboard tile + drill-down — aggregates buckets, excludes `current` from the tile array but exposes `currentCount` / `currentCents` separately), `getSnapshotForContract` (contract detail page), `getCurrentAging` (last-recompute lookup for the "stale data" hint).
- **Dashboard update:** `convex/dashboard.ts:getArAgingSummary` now reads `arAgingSnapshots` rows and returns `isPlaceholder: true` only when the table is empty (vs. always-`true` placeholder before). Shape of the return value is backward-compatible — the existing `tests/unit/convex/dashboard.test.ts` still passes because the placeholder branch fires with no snapshot rows in the fixtures.
- **Tests:** `tests/unit/convex/arAging.test.ts` covers boundary classification, idempotency, contract-state filtering, the cron body's two-state scan, the admin escape hatch's auth gate, and the public-read shape including the "current bucket is excluded from the dashboard tile" invariant. The `overdueCountWithAction` field stays at zero for now (Story 4.2 introduces `followUpActions` and will flip the recompute helper to a real split — schema is stable so it's a one-line code change).
- **ADR:** `docs/adr/0013-ar-aging-buckets.md` captures the pre-aggregation rationale, the bucket vocabulary, the cron time, the alternatives considered, and the deferred follow-ups (Story 4.2 hook, Story 4.8 drill-down, runbook section).
- **Deferred follow-ups:** (a) Once `convex/_generated/` is produced by `npx convex dev`, replace the dynamic-import branch in `convex/crons.ts` with the static `import { internal } from "./_generated/api"` and an unconditional `crons.daily(...)`. (b) Story 4.2 wires `internal_recomputeAgingForContractMutation` into the follow-up-action create / expire mutations so the snapshot reflects new actions without waiting for the next cron. (c) Runbook section (story §Task 12) documenting manual replay and Convex dashboard cron history — deferred to the cross-cutting runbook story.

### File List

- **Modified:** `convex/schema.ts` (added `arAgingSnapshots` table + 3 indexes)
- **Modified:** `convex/dashboard.ts` (`getArAgingSummary` reads real snapshots)
- **Modified:** `_bmad-output/implementation-artifacts/sprint-status.yaml` (4-1 status → review)
- **Created:** `convex/arAging.ts` (helpers, internal mutations, public queries)
- **Created:** `convex/crons.ts` (daily cron registration; `_generated/`-gated)
- **Created:** `tests/unit/convex/arAging.test.ts` (helper + handler tests)
- **Created:** `docs/adr/0013-ar-aging-buckets.md` (decision record)
