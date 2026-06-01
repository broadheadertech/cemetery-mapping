# ADR 0014: Daily reconciliation invariants

- Status: accepted
- Date: 2026-05-20
- Story: 5.5 (Daily Reconciliation Invariant Scheduled Function, FR60 / NFR-R4)
- Related: ADR 0012 (postFinancialEvent cornerstone), ADR 0013 (AR aging buckets)

## Context

`postFinancialEvent` (Story 3.2, ADR 0012) guarantees that every money-
touching mutation lands `payments` + `receipts` + `paymentAllocations` +
audit row atomically inside ONE Convex transaction. The cornerstone's
`ALLOCATION_SUM_MISMATCH` invariant proves at WRITE time that the sum of
a payment's allocations equals the payment amount; FR28 + FR29 + NFR-C1
nail down the per-write properties.

The cornerstone is the FIRST line of defense — it makes the bad state
structurally impossible at insert time. We still need a SECOND line of
defense because:

1. **Restore-from-backup** could resurrect rows from a state that
   pre-dates the cornerstone (or pre-dates a future schema migration).
2. **Direct database edits** by a developer with `ctx.db.patch` /
   `ctx.db.replace` access to the financial tables would bypass the
   cornerstone entirely. The `no-direct-financial-write` lint rule
   catches the easy case (literal table names); a dynamic table-name
   string slips through.
3. **Storage-tier corruption** (a hardware-induced bit flip) is not
   detected by application-layer validators.
4. **Future Epic-9 webhook payment intake** (GCash, Maya, card) will
   land through the cornerstone, but the third-party gateway's
   reconciliation report is the truth of "what was actually paid" —
   we need a way to compare our ledger against theirs without writing
   ad-hoc one-off scripts.

At 2,000+ contracts × 60-month installment schedules × 10-year horizon,
even a 0.01% silent drift rate produces material discrepancies. NFR-R4
budgets ≤ 2 hours from drift to detection; the architecture's
"Compliance — daily reconciliation invariant" section commits to a
scheduled function that re-verifies the ledger nightly.

## Decision

Ship a daily Convex cron at 02:00 Manila (18:00 UTC) that runs three
independent invariant checks against the live ledger:

### Invariant 1 — `payments_match_allocations`

For every non-voided `payments` row P:

```
sum(paymentAllocations.amountCents WHERE paymentId === P._id)
  === P.amountCents
```

Voided payments are excluded — the cornerstone's void path preserves
allocation rows (audit trail) and only flips the `isVoided` flag, so
their allocation sum still matches the original amount; counting them
would inflate `checked` without changing the failure surface.

### Invariant 2 — `contract_total_ok`

For every `contracts` row C:

```
sum(paymentAllocations.amountCents WHERE
      (targetType === "contract" AND targetId === C._id)
   OR (targetType === "installment" AND targetId IN
         installments WHERE contractId === C._id))
   AND payment.isVoided !== true
  <= C.totalPriceCents
```

Over-application (allocations summing to more than the contract price)
is the failure case. Under-application is normal — a contract in
`active` state has un-applied principal pending future payments.

### Invariant 3 — `installment_paid_bounded`

For every `installments` row I:

```
I.paidCents <= I.principalCents
```

The Story 3.9 allocator should keep this true; the cheapest of the
three checks (single table scan, no joins) re-verifies.

### Persistence

Each invariant writes one row to `reconciliationRuns`:

```ts
{
  runAt: number,            // unix ms of run start
  checkType: "payments_match_allocations" | "contract_total_ok" | "installment_paid_bounded",
  status: "ok" | "warn" | "fail",
  summary: {
    checked: number,
    mismatches: number,
    discrepancies: Array<{...}>,  // ≤ 50 entries; row truncates beyond
    truncated: boolean,
    durationMs: number,
  },
  triggeredBy: "cron" | "manual",
}
```

The table is append-only by convention; no soft-delete UI, no admin
edit path. A future story may add an `acknowledged` status workflow
without a schema migration.

## Why we deliberately deviate from the original story spec

The Story 5.5 brief named a `reconciliationFailures` table and an
invariant of the form `sum(payments) === originalAmountCents −
outstandingBalanceCents`. The actually-shipped schema (per Stories 3.3
and 3.4 as of 2026-05-20) has:

- `contracts.totalPriceCents` only — no `originalAmountCents`, no
  `outstandingBalanceCents`. The contract's "outstanding balance" is
  computed on-demand from installment rows; no inline aggregate field.
- `paymentAllocations` as the source of truth for "what this payment
  paid for," not a contract-level running balance.

We therefore re-expressed the invariant in terms of the schema we
have. The three checks above cover the same structural risk surface
(silent payment / contract / installment drift) without requiring a
schema migration that no other Epic-3 story ships. The deliberate-
divergence test (see `tests/unit/convex/reconciliation.test.ts`)
proves the invariant DETECTS a mismatch, not just that it passes on
clean fixtures — Story 5.5 AC4 satisfied.

## Why three separate rows per run, not one

Each check is its own audit unit. A single failed check (e.g. an
exception thrown mid-loop on the contract_total_ok scan) does not
prevent the other two checks' results from being recorded. The
dashboard tile can show "last run: 3/3 ok" or "last run: 2/3 ok, one
check failed" by reading the most-recent row per `checkType` — the
`by_checkType_runAt` index makes this O(3) regardless of run history
length.

## Why 02:00 Manila

- Off-peak hour. The cemetery's office staff is asleep; database
  contention from interactive queries is at its minimum.
- Spaced 1 hour after the AR aging cron (01:00 Manila). The two crons
  do not share tables (reconciliation reads `payments` / `contracts` /
  `installments`; AR aging writes `arAgingSnapshots`), but the
  staggered schedule keeps log review tractable.
- Mr. Reyes opens the dashboard at ~07:00 Manila when he starts his
  day. A 5-hour buffer between the cron run and the morning login
  gives Convex's reactive query layer plenty of time to settle and
  ensures the dashboard banner (when a failure occurs) is visible
  immediately on first paint.
- Manila has no DST, so 02:00 ↔ 18:00 UTC is constant year-round.
  Convex's `crons.daily` schedules in UTC; the registration is
  `{ hourUTC: 18, minuteUTC: 0 }`.

## Why we accept the on-demand mutation surface

`runReconciliationNow` (admin-only) lets Mr. Reyes force a
reconciliation from the dashboard after a manual data correction
without waiting for the next nightly cron. The mutation runs the
exact same logic as the cron path; the only difference is the
recorded `triggeredBy: "manual"`. The Story 5.5 spec did not require
this mutation, but shipping it costs ~15 LOC and unblocks the
runbook's "I just hand-fixed a payment; recompute the invariants"
operational flow.

## What this invariant does NOT prove

- **A payment correctly applied to the right contract.** A payment
  recorded against contract A when it should have been recorded
  against contract B passes all three checks. Detecting this requires
  receipt-level reconciliation against the customer's intent — a
  human operator audit, not an algorithmic invariant.
- **A receipt issued to the wrong customer.** The cornerstone's
  serial allocation is correct; the receipt-to-customer link is the
  operator's responsibility.
- **Floating-point drift.** All money is INTEGER centavos (ADR 0007);
  the invariants would catch a bit flip, but they do not measure
  rounding error because none exists in integer arithmetic.
- **Performance regressions.** The checks read every row in
  `payments`, `contracts`, `installments`, and `paymentAllocations`.
  At 5,000+ contracts the cron will need to be re-shaped into a
  fan-out of per-contract mutations; this is a future story when the
  dataset grows past the per-mutation budget.

## Alternatives considered

1. **Real-time invariant on every write.** Rejected — already covered
   by the cornerstone's `ALLOCATION_SUM_MISMATCH`. Re-running the
   full ledger scan on every write would be O(N) per mutation,
   destroying the system's responsiveness for 2,000+ contracts.

2. **Weekly instead of daily.** Rejected — NFR-R4 budgets ≤ 2 hours
   from drift detection. Weekly cadence would let drift accumulate
   for 7 days before detection.

3. **Compute on the client.** Hard reject. The dashboard's
   `getLatestReconciliation` returns the precomputed summary; the
   heavy work is the nightly cron. A client-side computation would
   leak the entire financial ledger to the browser.

4. **A `reconciliationFailures` table with row-level status
   transitions.** Deferred. The current shape (`reconciliationRuns`
   with embedded `discrepancies` array) covers the dashboard tile
   and the runbook's triage flow. A row-level acknowledge / resolve
   workflow can land as a future story without a schema migration —
   the embedded array gives the data; a `reconciliationFailures`
   table would give the workflow on top.

## Consequences

- Storage: 3 rows per day × 365 days/year = ~1,100 rows/year.
  Negligible.
- Compute: one mutation per day, ~30-60s at Phase-1 scale. Convex's
  free-tier per-mutation budget handles this comfortably.
- Detection latency: ≤ 24h from drift to surface (NFR-R4 satisfied).
  Convex's reactive query layer propagates the dashboard banner
  within seconds of the row being inserted.
- Operational: the `runReconciliationNow` admin mutation provides the
  manual escape hatch. The cron's `npx convex logs` output captures
  the per-run summary for forensic review.

## References

- [Story 5.5](../../_bmad-output/implementation-artifacts/5-5-daily-reconciliation-invariant-scheduled-function.md)
- [ADR 0012 — postFinancialEvent cornerstone](./0012-postfinancialevent-cornerstone.md) (referenced; file is the implementing cornerstone)
- [Architecture — Scheduled functions catalog](../../_bmad-output/planning-artifacts/architecture.md)
- [PRD FR60 / NFR-R4](../../_bmad-output/planning-artifacts/prd.md)
