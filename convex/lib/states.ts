/**
 * Server-side state type exports — Story 1.7.
 *
 * Single source of truth for entity-state string unions consumed by
 * Convex functions. Mirrored on the client by `src/types/lot-status.ts`
 * (LotStatus only); a Vitest test asserts the two arrays stay in sync.
 *
 * We mirror rather than cross-import because `src/` and `convex/` are
 * separate TypeScript projects — `convex/` cannot import from `src/`,
 * and `src/` can only import from `convex/` via `_generated/` (which is
 * built by `npx convex dev` and not committed). The sync test in
 * `tests/unit/convex/lib/stateMachines.test.ts` guards against drift.
 *
 * See `docs/adr/0006-state-machine-transitions.md`.
 */

export const LOT_STATUSES = [
  "available",
  "reserved",
  "sold",
  "occupied",
  "cancelled",
  "defaulted",
  "transferred",
] as const;

export type LotStatus = (typeof LOT_STATUSES)[number];

/**
 * Contract state vocabulary — schema-aligned for Story 3.6's
 * `transitionContractState` helper.
 *
 * Story 1.7's cornerstone shipped `fully_paid` and `transferred`;
 * Story 3.3's `convex/schema.ts` shipped `paid_in_full` and `voided`
 * (and no `transferred`). Story 3.3's dev agent flagged the mismatch
 * in its Completion Notes; Story 3.6 (this alignment) reconciles the
 * two so `transitionContractState` can read a contract's `state` field
 * from the DB and pass it straight to `assertTransition` without a
 * translation layer.
 *
 * The five canonical contract states are now:
 *   - `active`        — open contract, payments may flow.
 *   - `paid_in_full`  — terminal happy path (full-payment sales close
 *                       here at insert; installment sales transition
 *                       here when the final installment lands).
 *   - `in_default`    — admin-flagged for non-payment (FR37). May
 *                       return to `active` via admin reinstate (Epic 4
 *                       default-recovery) or move to `voided` /
 *                       `cancelled` for terminal closure.
 *   - `cancelled`     — admin-cancelled (terminal in Phase 1).
 *   - `voided`        — admin-voided post-sale (FR24). Terminal.
 *
 * `transferred` (Story 1.7's stub) is intentionally NOT here — the
 * Phase-1 schema does not include it. Epic 4's ownership transfer
 * flow models the change via the `ownerships` table + a new contract
 * row rather than a contract-state edge. If a future story needs
 * `transferred`, it lands here AND in the schema together via an
 * ADR amendment.
 */
export const CONTRACT_STATES = [
  "active",
  "paid_in_full",
  "in_default",
  "cancelled",
  "voided",
] as const;

export type ContractState = (typeof CONTRACT_STATES)[number];

export const RECEIPT_STATES = ["issued", "voided"] as const;

export type ReceiptState = (typeof RECEIPT_STATES)[number];

/**
 * Story 7.4 — interment state union. Mirrors the
 * `interments.status` v.union literal in `convex/schema.ts` (which is
 * also the table's status column type). Joining the EntityWithState
 * union below is what lets `assertTransition({ entityType: "interment",
 * ... })` typecheck and routes through the `TRANSITIONS` table.
 */
export const INTERMENT_STATES = [
  "scheduled",
  "completed",
  "cancelled",
] as const;

export type IntermentState = (typeof INTERMENT_STATES)[number];

export type EntityWithState = "lot" | "contract" | "receipt" | "interment";
