/**
 * State-machine cornerstone — Story 1.7.
 *
 * Declarative transition tables for every stateful entity in the
 * cemetery-mapping system. `assertTransition` is a pure validator that
 * throws `ILLEGAL_STATE_TRANSITION` when a caller proposes a move not
 * listed in the table, and `INVARIANT_VIOLATION` when a reason-required
 * transition is invoked without one.
 *
 * Architectural intent (see `docs/adr/0006-state-machine-transitions.md`):
 *
 *   1. The transition table is data, not code. New transitions land in
 *      their feature stories with an ADR amendment.
 *   2. `assertTransition` is *pure* — no DB access, no auth, no audit.
 *      Callers fetch the current state, pass it as `from`, then
 *      persist + emit audit themselves. This keeps the validator
 *      reusable from any layer (mutations, scheduled jobs, dev tools).
 *   3. State changes that touch persistence route through a domain
 *      helper (`transitionLotStatus`, `transitionContractState`, …).
 *      Those helpers chain: `requireRole → assertTransition → patch →
 *      emitAudit`. Story 1.8 fills in `transitionLotStatus`'s body
 *      once the `lots` table exists.
 *   4. The custom ESLint rule `local-rules/no-raw-status-patch` blocks
 *      `ctx.db.patch(..., { status: ... })` outside files that import
 *      from this module, catching most accidents at build time.
 *
 * Functional-requirement coverage:
 *   - FR23 (contract states), FR24 (admin void), FR37 (default
 *     transition), FR38 (reclaim defaulted lot) all depend on this.
 *   - NFR-M2 (≥ 90% coverage on financial-touching code) — receipt and
 *     contract transitions are financial.
 */

import { type DataModelFromSchemaDefinition } from "convex/server";

import schema from "../schema";
import { emitAudit } from "./audit";
import {
  shiftContractStateCounter,
  shiftLotStatusCounter,
} from "./dashboardCounters";
import { ErrorCode, throwError } from "./errors";
import type { ContractState, EntityWithState, LotStatus } from "./states";
import type { MutationCtx } from "./auth";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type LotId = DataModel["lots"]["document"]["_id"];
type LotDoc = DataModel["lots"]["document"];
type ContractId = DataModel["contracts"]["document"]["_id"];
type ContractDoc = DataModel["contracts"]["document"];

/**
 * Master transition table. Keys are entity types; values map each
 * possible `from` state to the list of allowed `to` states.
 *
 * Terminal states have an empty list. To re-introduce outgoing edges
 * from a terminal state, file an ADR amendment and update this table —
 * do not add transitions inline in a feature story without that
 * paper trail.
 *
 * `as const` makes the values readonly tuples so TypeScript exhausts
 * over each state in tests; `satisfies` enforces the shape without
 * widening the literal types.
 */
export const TRANSITIONS = {
  lot: {
    available: ["reserved", "sold"],
    reserved: ["sold", "available"],
    /**
     * `sold → available` is the void-contract / reclaim path.
     *
     * Story 3.7 `voidContract` and Story 4.5 `reclaimLot` both need to
     * return a sold lot to the inventory pool when the contract that
     * caused the sale is voided. Before this edge existed,
     * `transitionLotStatus(sold → available)` raised
     * ILLEGAL_STATE_TRANSITION on every void, crashing the void chain
     * 100% in production (caught in the Epic 3 + Epic 4 adversarial
     * review). `sold → occupied` and `sold → defaulted` remain the
     * normal forward edges; `sold → available` is reserved for the
     * deliberate void / reclaim flow.
     */
    sold: ["occupied", "defaulted", "available"],
    occupied: ["transferred"],
    defaulted: ["available"], // FR38: admin reclaim
    cancelled: [], // terminal
    transferred: ["sold"], // new owner re-sells
  },
  // Story 3.6 — contract state machine, schema-aligned vocabulary
  // (`paid_in_full` / `voided`; not `fully_paid` / `transferred`).
  //
  // Story 1.7's cornerstone shipped a stub here with `fully_paid` and
  // `transferred`; Story 3.3's `convex/schema.ts` shipped `paid_in_full`
  // and `voided`. Story 3.3's dev agent flagged the mismatch in
  // Completion Notes; Story 3.6 (this entry) reconciles by aligning the
  // transition table with the schema — `transitionContractState` reads
  // the contract's `state` from the DB and feeds it to `assertTransition`
  // unchanged, so any vocab divergence would surface as a spurious
  // ILLEGAL_STATE_TRANSITION at runtime.
  //
  // Legal edges per Story 3.6 AC1:
  //   active → paid_in_full   — auto-fired when a payment closes the
  //                             balance (full-payment sales also INSERT
  //                             directly to `paid_in_full`; no
  //                             transition runs in that path).
  //   active → in_default     — admin-flagged for non-payment (FR37,
  //                             Story 4.4).
  //   active → cancelled      — admin-cancelled pre-interment (Story
  //                             3.7's broader void flow extends).
  //   active → voided         — admin-voided post-sale (FR24, Story 3.7).
  //   in_default → active     — admin reinstates a recovered contract
  //                             (Epic 4 default-recovery).
  //   in_default → voided     — final void after recovery efforts fail.
  //   in_default → cancelled  — cancellation path post-default.
  //
  // All other source/target combinations are forbidden;
  // `assertTransition` throws ILLEGAL_STATE_TRANSITION for any. The
  // terminal states are `paid_in_full`, `cancelled`, `voided` — they
  // have empty outgoing-edge lists.
  contract: {
    active: ["paid_in_full", "in_default", "cancelled", "voided"],
    in_default: ["active", "voided", "cancelled"],
    // `paid_in_full → active` is the receipt-void reversal path (Epic 3
    // C1 fix). When the receipt that closed a contract's balance is
    // voided, the contract is no longer fully paid and MUST leave the
    // terminal `paid_in_full` state — otherwise it is stuck forever
    // (paid_in_full had no outgoing edges), the backing payment is
    // voided, revenue/AR reports double-count it, and the lot can never
    // be reclaimed. Reverting to `active` makes it recoverable: an admin
    // can then re-collect or void the contract (active → voided) to free
    // the lot. The reversal fires inside `postFinancialEvent`'s void path.
    paid_in_full: ["active"],
    cancelled: [], // terminal
    voided: [], // terminal
  },
  receipt: {
    issued: ["voided"],
    // FR29: voided receipts remain consumed (no renumber). The serial
    // counter logic in Epic 3 enforces no-renumber separately.
    voided: [], // terminal
  },
  // Story 7.4 — interment state machine. Both `completed` and
  // `cancelled` are terminal: once an interment finishes (the body is
  // in the ground) or is cancelled (the booking is voided) there is
  // no legitimate operational reason to flip back. A future Admin
  // "reversal" flow would require an ADR amendment + a new transition
  // edge (e.g. `completed → scheduled` with a reason), tracked in
  // Story 7.4's open questions list.
  interment: {
    scheduled: ["completed", "cancelled"],
    completed: [], // terminal
    cancelled: [], // terminal
  },
} as const satisfies Record<EntityWithState, Record<string, readonly string[]>>;

/**
 * The set of `entityType:from→to` strings whose execution requires a
 * non-empty `reason`. Driven by audit / regulatory needs:
 *
 *   - `lot:sold→defaulted` — FR37 mandates a default reason
 *   - `lot:defaulted→available` — FR38 mandates a reclaim reason
 *   - `contract:active→cancelled` — FR24 admin void requires a reason
 *   - `contract:active→in_default` — FR37 mandates a default reason
 *   - `receipt:issued→voided` — BIR rules require a void reason on
 *     every voided receipt
 *
 * Update in lockstep with the UI (Stories 3.x consume this list to
 * decide which transition buttons open a "reason" dialog).
 */
export const REASON_REQUIRED_TRANSITIONS: ReadonlySet<string> = new Set([
  "lot:sold→defaulted",
  "lot:sold→available", // void-contract / reclaim path — reason required for forensic trail
  "lot:defaulted→available",
  "contract:active→cancelled",
  "contract:active→in_default",
  "contract:active→voided", // Story 3.6 — FR24 admin void requires reason
  "contract:in_default→active", // Story 3.6 — admin reinstate requires audit reason
  "contract:paid_in_full→active", // Epic 3 C1 — receipt-void reversal requires the void reason for the forensic trail
  "contract:in_default→voided", // Story 3.6 — terminal void from default requires reason
  "contract:in_default→cancelled", // Story 3.6 — cancellation post-default requires reason
  "receipt:issued→voided",
]);

/**
 * Type-level helper: the union of valid `from` states for an entity.
 * Used by `assertTransition`'s param type to give callers compile-time
 * help when they pass a literal.
 */
type FromStateFor<E extends EntityWithState> = keyof (typeof TRANSITIONS)[E];

export interface AssertTransitionParams {
  entityType: EntityWithState;
  from: string;
  to: string;
  reason?: string;
}

/**
 * Pure validator. Returns its params on success; throws on failure.
 *
 * Throws:
 *   - `ILLEGAL_STATE_TRANSITION` — `to` is not in `TRANSITIONS[entityType][from]`
 *   - `INVARIANT_VIOLATION` — transition is in `REASON_REQUIRED_TRANSITIONS`
 *     but `reason` is missing / empty / whitespace-only
 *
 * Does NOT:
 *   - Access the database
 *   - Check the caller's role
 *   - Emit an audit log entry
 *   - Mutate any state
 *
 * Callers handle those side-effects; this helper is safe to call from
 * tests, dev tools, and dry-runs.
 */
export function assertTransition(
  params: AssertTransitionParams,
): AssertTransitionParams {
  const tableForEntity = TRANSITIONS[params.entityType] as Record<
    string,
    readonly string[]
  >;
  const allowed = tableForEntity[params.from] ?? [];
  if (!allowed.includes(params.to)) {
    throwError(
      ErrorCode.ILLEGAL_STATE_TRANSITION,
      `Cannot transition ${params.entityType} from "${params.from}" to "${params.to}". Allowed: [${allowed.join(", ")}].`,
      {
        entityType: params.entityType,
        from: params.from,
        to: params.to,
        allowed: [...allowed],
      },
    );
  }
  const key = `${params.entityType}:${params.from}→${params.to}`;
  if (REASON_REQUIRED_TRANSITIONS.has(key) && !params.reason?.trim()) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      `Transition ${key} requires a reason.`,
      {
        entityType: params.entityType,
        from: params.from,
        to: params.to,
      },
    );
  }
  return params;
}

/**
 * Re-exported for callers that want a single import.
 */
export type { EntityWithState, FromStateFor };

/**
 * Strongly-typed convenience wrapper around `assertTransition` for
 * callers that know the entity type at the call site. Useful in
 * domain helpers that handle a single entity type — e.g.,
 * `transitionLotStatus` will use `assertLotTransition`.
 */
export function assertLotTransition(params: {
  from: FromStateFor<"lot">;
  to: string;
  reason?: string;
}): AssertTransitionParams {
  return assertTransition({ entityType: "lot", ...params });
}

export function assertContractTransition(params: {
  from: FromStateFor<"contract">;
  to: string;
  reason?: string;
}): AssertTransitionParams {
  return assertTransition({ entityType: "contract", ...params });
}

export function assertReceiptTransition(params: {
  from: FromStateFor<"receipt">;
  to: string;
  reason?: string;
}): AssertTransitionParams {
  return assertTransition({ entityType: "receipt", ...params });
}

/**
 * Story 7.4 — typed convenience wrapper for the interment state
 * machine. Mirrors the lot / contract / receipt helpers above.
 */
export function assertIntermentTransition(params: {
  from: FromStateFor<"interment">;
  to: string;
  reason?: string;
}): AssertTransitionParams {
  return assertTransition({ entityType: "interment", ...params });
}

/**
 * Domain helper that applies a lot status transition end-to-end:
 *   1. Fetch the lot from `ctx.db`
 *   2. Validate the transition with `assertTransition`
 *   3. Patch the new status onto the lot
 *   4. Emit an audit-log entry via `convex/lib/audit.ts → emitAudit`
 *   5. Return the updated lot document
 *
 * Body implemented in Story 1.8 once the `lots` table landed in
 * `convex/schema.ts`. Callers (Story 1.8's `setLotStatusReserved`,
 * future Epic 3 sale flows, Epic 4 default / reclaim flows) supply a
 * `MutationCtx` and a strongly-typed `Id<"lots">`.
 *
 * Throws:
 *   - `NOT_FOUND` — the lot id does not resolve to a document.
 *   - `ILLEGAL_STATE_TRANSITION` — `assertTransition` rejects the move.
 *   - `INVARIANT_VIOLATION` — reason-required transition with no reason
 *     (e.g. `lot:sold→defaulted`, `lot:defaulted→available`).
 *
 * The patch in step 3 is the canonical raw `ctx.db.patch(..., { status })`
 * — this file is the ONLY one allowed to do that. The ESLint rule
 * `local-rules/no-raw-status-patch` exempts files that import from
 * `convex/lib/stateMachines` (i.e. `convex/lots.ts`), but enforces the
 * pattern by funnelling all status writes through THIS helper.
 *
 * The role check is the caller's responsibility — `transitionLotStatus`
 * itself does NOT call `requireRole`. That decision keeps the helper
 * reusable from scheduled jobs / actions where the role set differs
 * from the public mutation surface. Stories 3.x will call this from
 * `requireRole`-gated public mutations.
 */
export async function transitionLotStatus(
  ctx: MutationCtx,
  params: { lotId: LotId; to: LotStatus; reason?: string },
): Promise<LotDoc> {
  const lot = await ctx.db.get(params.lotId);
  if (lot === null) {
    throwError(ErrorCode.NOT_FOUND, "Lot not found.", {
      lotId: params.lotId,
    });
  }
  // `lot` is narrowed to the document type after the null guard.
  const from = lot.status;
  assertTransition({
    entityType: "lot",
    from,
    to: params.to,
    reason: params.reason,
  });
  // Canonical raw-status patch — exempt from `no-raw-status-patch`
  // because THIS file is the state-machine module the rule whitelists.
  await ctx.db.patch(params.lotId, { status: params.to });
  // Story 5.2 follow-up — keep the dashboard's per-status counter in
  // sync. Skip when the lot is retired (retired lots are not in the
  // counter set, regardless of `status`).
  if (!lot.isRetired) {
    await shiftLotStatusCounter(ctx, from, params.to);
  }
  await emitAudit(ctx, {
    action: "transition",
    entityType: "lot",
    entityId: params.lotId,
    before: { status: from },
    after: { status: params.to },
    reason: params.reason,
  });
  const updated = await ctx.db.get(params.lotId);
  if (updated === null) {
    // Defensive — the patch just succeeded, so this branch is
    // unreachable absent a concurrent delete (which we don't allow on
    // lots; soft-delete via `isRetired` does not remove the row).
    throwError(ErrorCode.NOT_FOUND, "Lot not found after transition.");
  }
  return updated;
}

/**
 * Domain helper that applies a contract state transition end-to-end —
 * Story 3.6 (FR23 / FR24 / FR37).
 *
 * Mirrors `transitionLotStatus`'s shape:
 *   1. Fetch the contract from `ctx.db`.
 *   2. Validate the transition with `assertTransition` (pure validator
 *      that throws `ILLEGAL_STATE_TRANSITION` for forbidden edges and
 *      `INVARIANT_VIOLATION` when a reason-required transition is
 *      called without one).
 *   3. Patch the new state onto the contract row.
 *   4. Emit a `transition` audit-log entry via `convex/lib/audit.ts →
 *      emitAudit` so every state change is forensically traceable
 *      (FR23 — "no contract changes state silently").
 *   5. Return the updated contract document.
 *
 * Vocabulary discipline: this helper consumes and emits the schema's
 * contract-state vocabulary (`active | paid_in_full | in_default |
 * cancelled | voided`). Story 1.7's original `fully_paid` /
 * `transferred` stubs were reconciled in Story 3.6 — see
 * `convex/lib/states.ts` for the rationale.
 *
 * Throws:
 *   - `NOT_FOUND` — the contract id does not resolve to a document.
 *   - `ILLEGAL_STATE_TRANSITION` — `assertTransition` rejects the move
 *     (forbidden edge in `TRANSITIONS.contract`).
 *   - `INVARIANT_VIOLATION` — reason-required transition with no
 *     reason. Per Story 3.6's `REASON_REQUIRED_TRANSITIONS` additions:
 *     all `active → {cancelled, in_default, voided}` and all
 *     `in_default → *` edges require a non-empty reason.
 *
 * Role check is the caller's responsibility — this helper does NOT
 * call `requireRole`. Public mutations that wrap this helper
 * (`convex/contracts.ts > transitionState`, `cancelContract`,
 * `markContractInDefault`) gate on `requireRole(ctx, ["admin"])`
 * before invoking. The helper stays role-agnostic so scheduled jobs
 * and dev tools can reuse it without inheriting an admin gate.
 *
 * Important: the `active → paid_in_full` auto-fire (when an
 * installment payment closes the balance, Story 3.2's
 * `postFinancialEvent` cornerstone) routes through this helper with
 * the user who posted the payment as the actor. There is no synthetic
 * "system" principal — auto-fired transitions still have a human
 * actor for audit-log attribution.
 *
 * This file is the ONLY one that may `ctx.db.patch(..., { state })`
 * for the contracts table — see `local-rules/no-raw-status-patch` for
 * the enforcement story (the rule covers `status`; the analogous
 * `state` patch discipline is enforced by code review + the
 * test-driven invariant that every state transition emits a paired
 * audit row).
 */
export async function transitionContractState(
  ctx: MutationCtx,
  params: { contractId: ContractId; to: ContractState; reason?: string },
): Promise<ContractDoc> {
  const contract = await ctx.db.get(params.contractId);
  if (contract === null) {
    throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
      contractId: params.contractId,
    });
  }
  // `contract` is narrowed to the document type after the null guard.
  const from = contract.state;
  // Pure validator. Throws ILLEGAL_STATE_TRANSITION for forbidden
  // edges; throws INVARIANT_VIOLATION when a reason-required
  // transition is called without a reason.
  assertTransition({
    entityType: "contract",
    from,
    to: params.to,
    reason: params.reason,
  });
  // Canonical state patch — this module is the only one allowed to
  // raw-patch the contracts.state field. Public mutations route
  // through this helper so the assertTransition gate is never
  // bypassed.
  await ctx.db.patch(params.contractId, { state: params.to });
  // Story 5.2 follow-up — keep the dashboard's per-state counter +
  // AR-balance sum in sync. The shift helper is a paired bump
  // (decrement `from`, increment `to`) so the running totals stay
  // consistent across the mutation boundary.
  await shiftContractStateCounter(
    ctx,
    from,
    params.to,
    contract.totalPriceCents,
  );
  await emitAudit(ctx, {
    action: "transition",
    entityType: "contract",
    entityId: params.contractId,
    before: { state: from },
    after: { state: params.to },
    reason: params.reason,
  });
  const updated = await ctx.db.get(params.contractId);
  if (updated === null) {
    // Defensive — the patch just succeeded, so this branch is
    // unreachable absent a concurrent delete (which we don't allow
    // on contracts; the immutability rule in FR31 forbids deletion
    // entirely).
    throwError(ErrorCode.NOT_FOUND, "Contract not found after transition.");
  }
  return updated;
}
