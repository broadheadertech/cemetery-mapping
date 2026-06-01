# ADR 0010: BIR Receipt Counter — Single-Row Table with Optimistic Concurrency

- **Status:** Accepted
- **Date:** 2026-05-18
- **Story:** 3.1
- **Supersedes:** none
- **Related:** ADR-0002 (RBAC), ADR-0004 (audit log), ADR-0006 (state machines)

## Context

The Bureau of Internal Revenue (BIR) registers each cemetery's receipt-issuing infrastructure ("CAS Permit to Use" or its successor regimes) against a starting serial number and a prefix. From that point on, every receipt the cemetery emits must:

1. Carry a **unique** serial. No two receipts may share a serial — duplicates trigger BIR audit findings two years downstream when nobody who remembers the bug is still on the project.
2. Be **strictly sequential** with no gaps. Voids consume their serial (FR29) — a voided receipt's serial is "used" forever; the next allocation steps past it.
3. Be **strictly monotonic**. Issued serials only grow. Decrements are a compliance defect.

Functional requirements: **FR28** (BIR receipt issuance), **FR29** (void semantics), **FR32** (atomic financial event). Non-functional: **NFR-C1** (serial uniqueness), **NFR-C2** (audit-trail immutability).

The system has at most one cemetery's worth of receipt traffic per deployment (Phase 1 PRD § Scope). Daily issuance volume is on the order of dozens-to-hundreds, not millions. Concurrent writers exist (multiple staff posting payments simultaneously from different terminals; future customer-portal payments in Epic 9), but contention on any single receipt-issuance window is bounded.

### Patterns considered

1. **Sharded counter (one row per year, per cashier, per prefix variant).** Common in high-throughput billing systems where a single row would bottleneck. Rejected for cemetery-mapping — sharding fragments the "strictly sequential, no gaps" guarantee. A sharded scheme would either (a) hand out non-contiguous ranges (audit-confusing) or (b) require a coordinator to assemble shards into the final sequence (defeats the point of sharding). Single-cemetery write volume does not justify the complexity.
2. **Postgres-style sequence / Convex auto-increment.** Convex has no built-in sequence primitive. We could simulate one with a separate counter row, which is what we end up with anyway. The "sequence" abstraction would only repackage the same shape.
3. **UUID / nanoid / timestamp-derived serial.** Rejected by FR28 — BIR requires *sequential* integers, not opaque identifiers. UUIDs are not monotonic.
4. **Application-level optimistic concurrency control (read-version, compare-and-swap, retry loop in user code).** Convex already provides per-document OCC at the runtime layer; the loser of a contended `patch` is retried transparently. Layering our own retry loop inside the helper would (a) double-retry on conflicts, (b) sit inside the calling mutation's transaction in a way that breaks the all-or-nothing atomicity contract of the cornerstone helper (Story 3.2's `postFinancialEvent`), and (c) require a `version` column we don't otherwise need. Rejected.
5. **Single-row table + Convex per-document OCC + `ctx.db.patch` inside the calling mutation.** Chosen.

## Decision

### 1. Schema — single row, no index

```ts
receiptCounter: defineTable({
  currentSerial: v.number(),
  startingSerial: v.number(),
  prefix: v.string(),
  seededAt: v.number(),
  seededBy: v.optional(v.id("users")),
}),
```

No index. Queries always go through `ctx.db.query("receiptCounter").first()`. Adding an index would imply more than one row could exist; the `seedReceiptCounter` idempotency check (which `.collect()`-s and bails if `length > 0`) guarantees the cardinality is exactly one after the first seed.

`currentSerial` is the last-issued serial. The next allocation is `currentSerial + 1`. `startingSerial` is captured at seed time and remains immutable — it documents what the cemetery registered with BIR. `prefix` is similarly immutable; it lets us widen the format later (e.g. add a year segment) without losing the original registration's prefix string.

### 2. `seedReceiptCounter` — idempotent internal mutation

`internalMutation` (not `mutation`) — the seed surface is server-internal only. A public-mutation seed would let a malicious client poke the counter, which is the failure we're explicitly preventing. Production seeding happens via `npx convex run lib:receiptCounter:seedReceiptCounter '{...}'` once per deployment, gated by §10 Q3 (the BIR-registered starting serial).

Idempotency: the handler first runs `ctx.db.query("receiptCounter").collect()`. If the row already exists, the second-call args are ignored and the function returns `{ alreadySeeded: true, currentSerial }`. This is intentional — re-running the seed accidentally cannot corrupt the counter.

Validation: `startingSerial` must be a non-negative integer; `prefix` must match `/^[A-Z0-9-]{0,10}$/`. Both invariants throw `INVARIANT_VIOLATION` with the offending value in `details`.

### 3. `allocateNextSerial` — internal helper, not a Convex mutation

```ts
export async function allocateNextSerial(ctx: MutationCtx): Promise<{
  serial: number;
  formatted: string;
}> {
  const counter = await ctx.db.query("receiptCounter").first();
  if (counter === null) {
    throwError(ErrorCode.INVARIANT_VIOLATION, "...");
  }
  if (!Number.isInteger(counter.currentSerial)) {
    throwError(ErrorCode.INVARIANT_VIOLATION, "...");
  }
  const next = counter.currentSerial + 1;
  await ctx.db.patch(counter._id, { currentSerial: next });
  return { serial: next, formatted: formatSerial(counter.prefix, next) };
}
```

The helper is a plain `async function`, NOT a Convex mutation. It is called from inside other mutations (Story 3.2's `postFinancialEvent`); the **atomicity scope** is the enclosing mutation. This matters because the cornerstone helper writes the receipt + payment + audit rows in the same transaction as the counter patch — a partial commit (counter incremented but receipt insert failed) would leave a gap.

Exposing the helper as a public mutation would let a malicious client invoke it directly to burn serials, producing intentional gaps. The `no-direct-receipt-counter-access` ESLint rule bans the bypass.

### 4. Convex per-document optimistic concurrency

Two concurrent mutations both read `currentSerial = 5` and both patch to 6. Convex's runtime detects the conflict at commit time, aborts one of the transactions, and retries the loser's entire mutation. The retry re-reads `currentSerial` (now 6) and patches to 7. Result: no duplicates, no gaps, both receipts issued.

We **do not add** a manual retry loop in our code. Manual retries:

- Would happen inside the calling mutation's transaction scope, which is the wrong place — a retry inside an already-failing transaction can't undo the partial work.
- Would double-retry on conflicts (Convex retries + our retry = 2x), producing worse latency under contention.
- Require a `version` column or `expectedVersion` argument we don't otherwise have. The Convex layer's OCC is keyed on the document's internal version field, not application data.

The cost is that the cornerstone's `postFinancialEvent` mutation may run multiple times under contention. That's fine — the mutation is idempotent at the receipt-record level (a duplicate insert would be caught by uniqueness checks in Story 3.2's body) and the audit log captures only the committed attempt.

### 5. Format — `PREFIX0000001`, 7-digit zero-padded

`formatSerial(prefix, serial)` produces `${prefix}${String(serial).padStart(7, "0")}`. Seven digits covers 9,999,999 receipts before the format widens; widening is non-breaking because downstream code (Story 3.11 PDF, Story 3.13 receipt search) reads the `formatted` field directly and never re-formats the integer.

A separate `formatted` field is returned so that downstream rendering can't drift from the canonical format. The audit trail captures both `serial` (for integer comparisons) and `formatted` (for human display).

### 6. Boundary enforcement — `no-direct-receipt-counter-access` ESLint rule

Custom rule at `eslint-rules/no-direct-receipt-counter-access.js`. Flags any `ctx.db.<method>("receiptCounter", ...)` call expression in a file other than:

- `convex/lib/receiptCounter.ts` — the implementation.
- `convex/lib/postFinancialEvent.ts` — the only sanctioned caller of `allocateNextSerial`.
- `convex/lib/receiptCounterTesting.ts` — test-only internalMutation wrapper.
- `convex/schema.ts` — the table declaration is data, not runtime access.

Limitation: the rule cannot statically detect `ctx.db.patch(counterId, {...})` calls where `counterId` was obtained from a `receiptCounter` query in the same file. The literal-string detector catches the common drive-by mistake; the boundary doc + code review catch the rest. Test coverage exercises both the valid and invalid cases via `RuleTester`.

### 7. Voids consume their serial (FR29)

A voided receipt remains in the `receipts` table with `isVoided: true` and the original `serial` / `formatted` values. The void workflow (Story 3.12) flags the row and emits an audit log entry. The `receiptCounter.currentSerial` value is **not** decremented. A unit test in `tests/unit/convex/lib/receiptCounter.test.ts` exercises this directly.

This is the BIR-required behavior: a voided receipt's serial is "used" — it appears on the printed copy, on the audit trail, and on the BIR-compliance export. Re-using the serial would let a fraudulent cashier void a real receipt and re-issue under the same serial.

### 8. Hand-mocked tests, with a path to `convex-test`

The Story 3.1 test suite uses the same hand-mocked ctx pattern as `tests/unit/convex/lib/audit.test.ts` and `tests/unit/convex/lots.test.ts`. `convex-test` requires `convex/_generated/` which this repo deliberately doesn't have until `npx convex dev` runs interactively.

The hand-mocked harness exposes a `simulateConflictOnFirstPatch` switch that mimics the Convex OCC behavior: the first `patch` throws a synthetic `ConvexError`, subsequent patches succeed normally. The test exercises both the conflict path (first call throws; row unchanged; retry succeeds) and the gap-free invariant across N sequential allocations.

When `_generated/` exists in a future deployment, the empirical 100-fan-out `convex-test` stress test described in the Story 3.1 spec § Task 9 can drop in without rewiring — `convex/lib/receiptCounterTesting.ts` already exports the `_testAllocate` `internalMutation` wrapper that `convex-test` would drive.

## Consequences

### Positive

- **Compliance is structural.** The counter primitive's contract is enforced by lint + types + tests; a careless drive-by edit cannot produce duplicates or gaps.
- **Atomicity is real.** The serial allocation, receipt insert, payment insert, and audit emission all live in one Convex mutation = one transaction. There is no "almost-committed" state to recover from.
- **Single-cemetery scale fits the design.** The counter row's write rate (≤ a few per minute under normal load, with rare burst spikes) is well inside Convex's per-document throughput envelope.
- **Future flexibility.** Adding a `year` field, a `permitNumber` field, or a `lastVoidedAt` audit hint is a non-breaking schema change. The pad-width can widen the day we hit 10M receipts.

### Negative

- **Single point of contention.** Every receipt issuance reads + patches the same row. Under sustained high load (which a single cemetery does not have, but a multi-tenant SaaS variant would), this becomes a bottleneck. The migration path is to shard per tenant — a future ADR would address that.
- **Production seeding is a runbook step, not an automation step.** §10 Q3 must be resolved (BIR registration confirms starting serial + prefix) before the seed can run safely. The seed is idempotent, so re-running with the *correct* args after the placeholder seed is harmless — but re-seeding with the wrong args is a no-op (the placeholder row sticks). If the placeholder serial is wrong in production, the only remedy is to wipe and re-seed before any receipts are issued.
- **Lint rule is a heuristic.** The rule catches `ctx.db.<method>("receiptCounter", ...)` literally. A determined developer could destructure `ctx.db` or alias `"receiptCounter"` and bypass detection. Code review + the audit-log invariants in Story 5.5 close the residual gap.

### Future work

- **Story 3.2 (`postFinancialEvent`)** consumes `allocateNextSerial` via the `convex/lib/postFinancialEvent.ts` re-export.
- **Story 3.11 (BIR-compliant receipts)** reads the `formatted` field for PDF rendering. Must not re-format from the integer.
- **Story 3.12 (void workflow)** writes `isVoided: true` on the receipt row; MUST NOT decrement the counter. Story 3.12's ADR amendment should cite this ADR's §7.
- **Story 5.5 (daily reconciliation invariant)** must include "no duplicate `receipts.serial` values" and "no gaps in the `receipts.serial` sequence between `startingSerial` and `currentSerial`" as daily-run invariants. Failures alert the on-call admin.
- **Epic 8 / multi-cemetery (out of Phase 1 scope):** if the system ever serves multiple cemeteries, the counter shards by tenant. The ADR amendment would document the per-tenant key, the cross-tenant invariants, and how the BIR-registration mapping changes.

## Implementation plan

| Story | Deliverable |
|-------|-------------|
| 3.1 (this) | `receiptCounter` schema + `seedReceiptCounter` + `allocateNextSerial` + `no-direct-receipt-counter-access` lint rule + tests + ADR. |
| 3.2 | `postFinancialEvent` cornerstone — consumes `allocateNextSerial` from the re-export. |
| 3.11 | BIR-compliant receipt PDFs read the `formatted` field from receipts. |
| 3.12 | Void workflow flags `isVoided: true` on the receipt row WITHOUT decrementing the counter. |
| 5.5 | Daily reconciliation includes counter-invariant checks. |

## Production seeding runbook

Until `docs/runbook.md` lands (deferred to a later story), the seed procedure is documented inline here:

1. Confirm the BIR-registered starting serial and prefix with the cemetery's accountant. See PRD §10 Q3.
2. With the Convex dev/prod deployment URL set in the operator's environment, run:
   ```
   npx convex run lib:receiptCounter:seedReceiptCounter '{"startingSerial": <NUMBER>, "prefix": "<PREFIX>"}'
   ```
3. Verify via `npx convex run` query (Story 3.11 will add a read-only admin query):
   ```
   npx convex run lib:receiptCounter:_debugReadCounter  # added in 3.11
   ```
   For Story 3.1, the verification is "the seed returned `{ alreadySeeded: false, currentSerial: <NUMBER> }`".
4. If the seed accidentally ran with wrong args BEFORE any receipts were issued: wipe the row via the Convex dashboard (admin-only access) and re-run the seed. The audit trail will show the wipe.
5. If the seed ran wrong AFTER receipts were issued: BIR re-registration is required. This is why §10 Q3 is a hard gate on Epic 3 production deploys.

## References

- [PRD § Functional Requirements > FR28, FR29, FR32](../../_bmad-output/planning-artifacts/prd.md)
- [PRD § Non-Functional Requirements > NFR-C1, NFR-C2](../../_bmad-output/planning-artifacts/prd.md)
- [PRD § Open Questions > Q3 (BIR receipt modality)](../../_bmad-output/planning-artifacts/prd.md)
- [Architecture § Core Architectural Decisions > Receipt-serial allocation](../../_bmad-output/planning-artifacts/architecture.md)
- [Architecture § Architectural Boundaries > Receipt counter boundary](../../_bmad-output/planning-artifacts/architecture.md)
- [Story 3.1](../../_bmad-output/implementation-artifacts/3-1-receipt-counter-with-optimistic-concurrent-serial-allocation.md)
- [Story 3.2](../../_bmad-output/implementation-artifacts/3-2-postfinancialevent-cornerstone.md) — consumer
- [Story 3.12](../../_bmad-output/implementation-artifacts/3-12-office-staff-voids-a-receipt-with-reason.md) — void workflow
- [Story 5.5](../../_bmad-output/implementation-artifacts/5-5-daily-reconciliation-invariant-scheduled-function.md) — daily invariants
- Convex docs: [Atomicity & optimistic concurrency](https://docs.convex.dev/database/atomicity)
