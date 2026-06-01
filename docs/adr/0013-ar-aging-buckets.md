# ADR 0013: AR Aging Buckets via Daily Pre-Aggregated Snapshots

- **Status:** Accepted
- **Date:** 2026-05-18
- **Story:** 4.1

## Context

**FR34** requires the dashboard to surface an accurate AR aging breakdown (current / 1-30 / 31-60 / 61-90 / 90+ days) for every active and in-default contract, and **NFR-P3** caps dashboard staleness at 24 hours so Mr. Reyes's "₱X in 90+ days" line is never lying by more than a day.

Two architectural facts shape the decision:

1. **Live aggregation breaches the freshness budget cheaply.** A naive `getArAgingSummary` that joins `contracts` × `installments` × (future) `followUpActions` on every dashboard load would do an O(unpaid-installments) scan per visit. At Phase 1 scale (~2,000 contracts × ~12-60 installments each) that is well past the NFR-P4 query budget (p95 < 300ms) and grows linearly with the cemetery's lifetime.
2. **The architecture already names this exception.** § Tech Stack > Reactive query subscriptions and § Design Patterns > Pre-aggregation explicitly call out AR aging as the canonical pre-aggregated summary doc — the documented escape hatch from "live aggregation by default."

There is also a category of subtle bugs to avoid in any aging implementation:
- **Double-counting** a contract in multiple buckets (sum-of-buckets ≠ total AR).
- **`Date`-based math** introducing timezone or DST drift (Manila has no DST today but the helper must not assume the deployment timezone stays put).
- **Coupling** the financial cornerstone (`postFinancialEvent`) to the aging recompute — aging math should never write to `payments` / `receipts` / `paymentAllocations` / `contracts`.

## Decision

### 1. Pre-aggregated `arAgingSnapshots` table — one row per active / in-default contract

The schema (in `convex/schema.ts`) defines `arAgingSnapshots` with `contractId`, `bucket`, `totalOverdueCents`, `overdueCountSilent`, `overdueCountWithAction`, `oldestDueDate?`, and `recomputedAt`. Three indexes: `by_contract` (upsert path), `by_bucket` (Story 4.8 drill-down), `by_bucket_overdue_desc` (Story 4.8 sort).

Each contract appears in exactly **one** bucket — its most-overdue. Buckets therefore sum to total AR with no double-counting. Story 4.1 AC2 enforces this invariant and the unit tests assert it.

### 2. Bucket vocabulary: `current | 1-30 | 31-60 | 61-90 | 90+`

Five literal values matching the dashboard's `ArAgingBucketKey` union in `convex/dashboard.ts`. The `"current"` bucket is the "not yet alarming" implicit category — a contract whose every unpaid installment is either not due yet or paid on time. The dashboard tile renders only the four overdue buckets; the `"current"` snapshot rows are tallied separately as `currentCount` / `currentCents` in the summary payload.

Boundary semantics (closed at the upper bound, open at zero):
- `daysOverdue ≤ 0` → `current`
- `1 ≤ d ≤ 30` → `1-30`
- `31 ≤ d ≤ 60` → `31-60`
- `61 ≤ d ≤ 90` → `61-90`
- `d > 90` → `90+`

`daysOverdue` is computed as `Math.floor((nowMs - installment.dueDate) / DAY_MS)` — integer milliseconds, no `Date` math.

### 3. Daily cron at 17:00 UTC = 01:00 Asia/Manila

`convex/crons.ts` registers a single `crons.daily("recompute-ar-aging", { hourUTC: 17, minuteUTC: 0 }, internal.arAging.internal_recomputeAllAging)` entry. Manila is UTC+8 with no DST, so the UTC hour is stable year-round.

The cron is named uniquely (single name = single slot — Convex dedupes by name) so the runbook can find the run history on the dashboard in one place.

### 4. Per-contract internal mutation; iteration inside the cron's own internal mutation

`internal_recomputeAgingForContractMutation` is the per-contract upsert. `internal_recomputeAllAging` is the cron body — it queries active + in_default contracts (via the `contracts.by_state` index), then loops and writes one snapshot row per contract.

At Phase 1 scale (~2,000 contracts × small installment count) the full loop fits inside one mutation's budget. If the dataset later grows past that budget, the file's JSDoc documents the split path: turn `internal_recomputeAllAging` into an action that fan-outs per-contract mutations. The public read surface is unchanged either way.

The cron's loop catches per-contract failures (`try { ... } catch (e) { console.error(...); }`) so one bad contract does not stop the other 1,999 from updating. The next day's cron retries.

### 5. Idempotency via `by_contract` upsert

The recompute helper looks up the existing snapshot row via the `by_contract` index. If present → `ctx.db.patch`; if absent → `ctx.db.insert`. Running the cron twice in succession produces identical row contents (modulo `recomputedAt`). Story 4.1 AC4 + unit tests assert this.

When a contract transitions out of `active` / `in_default` (paid_in_full, cancelled, voided, transferred), the recompute helper deletes any stale snapshot row so the dashboard immediately stops counting the contract.

### 6. Read-only over financial data + write-only over `arAgingSnapshots`

The recompute helper never touches `payments` / `receipts` / `paymentAllocations` / `contracts`. The Story 3.2 `no-direct-financial-write` ESLint rule fires on any attempt, no escape hatch (and the test file does not seed financial tables, by design).

### 7. Admin escape hatch — `arAging:recomputeNow`

A public `mutation` gated on `requireRole(["admin"])` that runs the same loop body on demand. Used from the runbook ("the cron is late — refresh now") and from the dashboard "Refresh aging" button (Phase 2). Story 4.1 ships the mutation; the dashboard button is downstream.

### 8. Public read surface

Three queries on `convex/arAging.ts`:
- `getAgingSummary` — bucket-keyed aggregate consumed by the dashboard tile (Story 5.2) and the staff drill-down (Story 4.8).
- `getSnapshotForContract` — per-contract row for the contract detail page.
- `getCurrentAging` — last-recompute lookup for the "data stale > 24h" inline hint.

All three call `requireRole(ctx, ["admin", "office_staff"])` as the first awaited statement (lint-enforced).

## Consequences

- **Positive:** Dashboard reads a fixed-size aggregation (≤ ~2,000 rows). p95 sits well inside NFR-P4's 300ms budget.
- **Positive:** Sum-of-buckets is mathematically guaranteed to equal total AR (single-bucket-per-contract invariant; unit-tested).
- **Positive:** The internal mutation is reusable — Story 4.2 (follow-up actions) and Story 4.3 (expired follow-up scan) will both call `internal_recomputeAgingForContractMutation` for the touched contract so the snapshot row reflects the new `overdueCountWithAction` / `overdueCountSilent` split without waiting for the next cron.
- **Positive:** Idempotent recompute — manual replay (`npx convex run arAging:internal_recomputeAllAging`) is a safe operation; the runbook documents it as the missed-cron recovery path.
- **Positive:** No DST risk — Manila has no DST and the helper uses integer millisecond arithmetic instead of `Date` math even if the deployment timezone changes.
- **Negative:** A contract that transitions from `paid_in_full → active` (via an admin transition; Story 4.5 default-reclaim reopens a defaulted lot but does NOT reopen a paid contract — so this is hypothetical) would not produce a snapshot row until the next cron run. Mitigation: the state-transition mutation can call `internal_recomputeAgingForContractMutation` directly when this branch lands.
- **Negative:** The `convex/crons.ts` registration requires `convex/_generated/api` which only exists after `npx convex dev` runs interactively. The file is written with a try/catch dynamic import so `tsc --noEmit` passes today; the cron is wired at deploy time once the codegen exists. Same gate as the `ActionCtx` branches in `convex/lib/audit.ts` and `convex/lib/piiAccess.ts`.
- **Negative:** Story 4.2 (follow-up actions) has not yet shipped — `overdueCountWithAction` is always 0 in the snapshot rows produced today. The schema reserves the field so 4.2's swap is a one-line change in the recompute helper, not a schema migration.

## Alternatives Considered

### A. Live aggregation on every dashboard load

Rejected. Would re-scan `installments` on every dashboard render, breaching NFR-P4 at Phase 1 scale and growing linearly with the cemetery's lifetime. The architecture's pre-aggregation exception specifically names this case.

### B. Per-mutation incremental updates (no cron)

Rejected. Every payment / contract-state-change mutation would have to recompute the touched contract's snapshot. Workable in theory, but creates fragile invariants — a missed call site silently drifts the snapshot from the underlying installments. The daily cron is the floor of correctness; per-mutation hooks (Story 4.2's follow-up actions) layer on top of it as freshness optimisations, not as the source of truth.

### C. Single bucket per installment (not per contract)

Rejected. Story 5.2's tile aggregates "contracts in the 90+ bucket" — the cardinal unit Mr. Reyes asks about ("how many contracts have someone 90+ days late?"). One row per installment would force the dashboard to do the contract-level aggregation client-side and would not let Story 4.8 page through the 90+ contracts by overdue amount.

## Implementation status

| Component | File | Status |
|-----------|------|--------|
| Schema | `convex/schema.ts` (`arAgingSnapshots` table) | Implemented |
| Helpers + queries + internal mutations | `convex/arAging.ts` | Implemented |
| Cron registration | `convex/crons.ts` | Implemented (deploy-time wiring once `_generated/` exists) |
| Dashboard integration | `convex/dashboard.ts` (`getArAgingSummary`) | Implemented |
| Unit tests | `tests/unit/convex/arAging.test.ts` | Implemented |
| ADR | `docs/adr/0013-ar-aging-buckets.md` | This document |
| Story 4.2 hook (`overdueCountWithAction`) | — | Deferred to Story 4.2 |
| Story 4.8 drill-down query | — | Deferred to Story 4.8 (uses the `by_bucket_overdue_desc` index defined here) |
| Runbook section | `docs/runbook.md` | Deferred follow-up — story §Task 12 |

## References

- [PRD § FR34](../../_bmad-output/planning-artifacts/prd.md) — AR aging buckets daily
- [PRD § NFR-P3](../../_bmad-output/planning-artifacts/prd.md) — dashboard freshness ≤ 24h
- [PRD § NFR-P4](../../_bmad-output/planning-artifacts/prd.md) — query p95 < 300ms
- [Architecture § Tech Stack > Reactive query subscriptions](../../_bmad-output/planning-artifacts/architecture.md) — pre-aggregation exception
- [Architecture § Design Patterns > Pre-aggregation](../../_bmad-output/planning-artifacts/architecture.md)
- [Architecture § Communication Patterns > Scheduled triggers](../../_bmad-output/planning-artifacts/architecture.md)
- [Story 4.1](../../_bmad-output/implementation-artifacts/4-1-system-computes-ar-aging-buckets-daily.md) — this story
- [ADR 0002 — RBAC pattern](./0002-rbac-pattern.md) — `requireRole` cornerstone
- [ADR 0006 — State machine transitions](./0006-state-machine-transitions.md) — `active` / `in_default` filter origin
- Convex docs: [Cron jobs](https://docs.convex.dev/scheduling/cron-jobs) · [Internal Functions](https://docs.convex.dev/functions/internal-functions)
