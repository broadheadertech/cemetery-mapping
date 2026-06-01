# ADR 0006: State-Machine Transition Guards via Declarative Tables

- **Status:** Accepted
- **Date:** 2026-05-18
- **Story:** 1.7

## Context

The Cemetery Management System has at least three entity types whose lifecycle is regulated by business rules: **lots** (`available | reserved | sold | occupied | cancelled | defaulted | transferred`), **contracts** (`active | fully_paid | in_default | cancelled | transferred`), and **receipts** (`issued | voided`). Several requirements pin the lifecycle explicitly:

- **FR23** — contract state transitions
- **FR24** — admin void / cancel
- **FR37** — transition to `in_default` (lot or contract)
- **FR38** — reclaim a defaulted lot
- **FR29** — voided receipt serials remain consumed

Across ~70 stories, dozens of mutations will touch these state fields. Without a single point of enforcement, the failure mode is well known: one careless `ctx.db.patch(lotId, { status: "occupied" })` from `available` skips a sale, an installment, an audit log, and a reason field. The system would lose its ability to reconstruct *why* an entity is where it is.

Several patterns considered:

1. **Third-party state-machine library** (`xstate`, `robot`). Rejected — overweight for the size of these state graphs (≤ 7 nodes each), pulls in runtime + types, and obscures the table behind a constructor API.
2. **Hand-rolled class per entity.** Rejected — encourages each entity's "transition method" to also pull in DB + audit, conflating validation with persistence.
3. **A single `assertTransition()` helper backed by a declarative table.** Chosen. The table is plain data, serializable, easy to read, and the helper is a 30-line pure function.

## Decision

### 1. Declarative transition table in `convex/lib/stateMachines.ts`

```ts
export const TRANSITIONS = {
  lot: {
    available: ["reserved", "sold"],
    reserved: ["sold", "available"],
    sold: ["occupied", "defaulted"],
    occupied: ["transferred"],
    defaulted: ["available"],
    cancelled: [],
    transferred: ["sold"],
  },
  contract: {
    active: ["fully_paid", "in_default", "cancelled", "transferred"],
    fully_paid: [],
    in_default: ["cancelled", "active"],
    cancelled: [],
    transferred: [],
  },
  receipt: {
    issued: ["voided"],
    voided: [],
  },
} as const satisfies Record<EntityWithState, Record<string, readonly string[]>>;
```

Terminal states list `[]`. The shape is enforced at compile time by `satisfies`.

### 2. `assertTransition` is a pure validator

It takes `{ entityType, from, to, reason? }`, throws `ILLEGAL_STATE_TRANSITION` (with `allowed: [...]` in `details`) if the move isn't in the table, throws `INVARIANT_VIOLATION` if the move is in `REASON_REQUIRED_TRANSITIONS` and `reason` is missing or whitespace-only, returns the params otherwise.

**No DB access. No auth. No audit.** Callers fetch state, call this, then persist + emit audit themselves. This keeps the validator reusable from any layer — mutations, scheduled jobs, dev tooling, dry-run scripts.

### 3. `REASON_REQUIRED_TRANSITIONS`

A `Set<string>` of `"entityType:from→to"` keys whose execution must capture a reason:

- `lot:sold→defaulted` — FR37
- `lot:defaulted→available` — FR38 reclaim
- `contract:active→cancelled` — FR24 admin void
- `contract:active→in_default` — FR37
- `receipt:issued→voided` — BIR void requires a reason

The Phase-2 UI (Stories 3.x) consumes this set to decide which transition buttons open a "reason" dialog before submitting.

### 4. Domain helpers own the side-effects

A per-entity helper (`transitionLotStatus`, future `transitionContractState`, `voidReceipt`) chains:

1. `requireRole(...)`
2. `ctx.db.get(entityId)` → resolve current state
3. `assertTransition({ entityType, from, to, reason })`
4. `ctx.db.patch(entityId, { status: to })`
5. `emitAudit({ action: "transition", before, after, reason })` (from Story 1.6)
6. Return the updated doc

Story 1.7 ships the **scaffold** for `transitionLotStatus` — its body throws an inline `NOT_IMPLEMENTED` `ConvexError` because the `lots` table arrives in Story 1.8. Story 1.8's task list explicitly includes "fill in `transitionLotStatus` using the Story 1.7 scaffold."

We deliberately did NOT add `NOT_IMPLEMENTED` to `convex/lib/errors.ts`'s `ErrorCode` constants. Keeping the canonical error list stable means there is nothing to clean up when Story 1.8 lands — the inline throw simply disappears.

### 5. ESLint rule `local-rules/no-raw-status-patch`

A custom rule (`eslint-rules/no-raw-status-patch.js`) fails the build if any `ctx.db.patch(<id>, { status: <value>, ... })` appears in a Convex file that does NOT import from `convex/lib/stateMachines`. Exemptions:

- `convex/lib/stateMachines.ts` itself (defines the helpers).
- `convex/seed.ts` (seeding may set initial statuses without going through the state machine — initial assignment is *creation*, not *transition*).

The rule is a heuristic, not a proof. A file that imports `stateMachines` for an unrelated reason can still patch raw status without calling `assertTransition`. The unit-test exhaustiveness on the table + the audit-log invariants in Story 5.5 close the gap. The heuristic catches the common case and signals intent to readers.

### 6. Client/server type mirror

`LotStatus` (and the `LOT_STATUSES` array) is duplicated:

- `convex/lib/states.ts` — server-side, consumed by Convex functions and the transition table.
- `src/types/lot-status.ts` — client-side, consumed by `StatusPill` and other UI.

A Vitest sync test in `tests/unit/convex/lib/stateMachines.test.ts` asserts the two arrays are equal. We mirror rather than cross-import because the `convex/` isolate and the Next.js `src/` tree are different TypeScript projects; cross-imports would couple the build graphs unnecessarily.

## Consequences

- **Positive:** Every illegal status change becomes a typed `ConvexError` instead of a corrupted row. Audit-log entries for transitions all include `before / after / reason`, making the customer-record timeline reliable.
- **Positive:** Future entities (e.g. `expense.approvalState` in Epic 4) extend the table with a single PR; the helper signature does not change.
- **Positive:** The ESLint rule catches the most common drive-by mistake (raw `status` patch) before it lands. Story authors are guided into the helper path.
- **Negative:** Mirroring `LotStatus` server/client doubles the source of truth. Mitigated by the sync test; drift fails CI.
- **Negative:** `assertTransition` accepts `from: string` rather than the entity's literal-union type because the value at the call site comes from the DB and is widened to `string`. Type-narrow at the call site (`if (lot.status === "available")`) if you need stricter checks before the call.
- **Negative:** The ESLint rule has false-positive and false-negative risk (importing stateMachines for an unrelated reason; destructured aliases of `ctx.db`). Accepted; documented in the rule file.

## Implementation plan

| Story | Deliverable |
|-------|-------------|
| 1.7 (this) | `convex/lib/stateMachines.ts` with `TRANSITIONS`, `REASON_REQUIRED_TRANSITIONS`, `assertTransition`, typed wrappers, `transitionLotStatus` stub; `convex/lib/states.ts`; client mirror; ESLint rule + tests; ADR. |
| 1.8 | Fill `transitionLotStatus` body using the scaffold (DB get + assertTransition + patch + emitAudit); first real consumer. |
| 3.6 | `transitionContractState` helper consuming the contract block of the table. |
| 3.12 | `voidReceipt` helper consuming the receipt block, with BIR-compliant reason capture. |
| 4.4 | Admin-driven `contract:active→in_default` transition wired into the UI. |
| 4.5 | Admin-driven lot reclaim `lot:defaulted→available`. |

## Future amendments

Adding a state or transition is an ADR amendment, not a drive-by edit:

1. Open an ADR amendment (or new ADR) referencing this one.
2. Update `TRANSITIONS` and, if needed, `REASON_REQUIRED_TRANSITIONS`.
3. Add tests for the new edges.
4. If the new state is terminal, document why the table entry is `[]`.

## References

- [PRD § Functional Requirements > 4. Sales & Installment Contracts](../../_bmad-output/planning-artifacts/prd.md)
- [Architecture § API & Communication Patterns > State-machine guards](../../_bmad-output/planning-artifacts/architecture.md)
- [Story 1.2](../../_bmad-output/implementation-artifacts/1-2-server-enforces-role-based-access-on-every-endpoint.md) — `ErrorCode`, ESLint plugin scaffolding.
- [Story 1.6](../../_bmad-output/implementation-artifacts/1-6-audit-log-emission-helper.md) — `emitAudit`, the consumer this scaffold defers to.
- [Story 1.8](../../_bmad-output/implementation-artifacts/1-8-office-staff-creates-and-edits-lot-records.md) — fills `transitionLotStatus`.
