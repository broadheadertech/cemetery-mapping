/**
 * Payments domain (Story 3.9, FR26).
 *
 * Office-staff entry point for the cemetery's most-frequent daily
 * transaction: recording a mid-stream installment payment with the
 * system auto-allocating the amount FIFO to the oldest unpaid
 * installment first. Story 3.10 will extend the same mutation with a
 * caller-supplied `allocationOverride`; this story ships the happy
 * path only — `allocationOverride` is intentionally absent from the
 * public surface.
 *
 * Conventions every handler obeys (mirrored from `convex/contracts.ts`
 * and the wider Convex-handler discipline established in Stories 3.3 /
 * 3.4):
 *
 *   1. FIRST awaited statement is `await requireRole(ctx, [...])`. The
 *      ESLint rule `local-rules/require-role-first-line` enforces this
 *      on public functions; defense-in-depth here too.
 *   2. Financial-table writes (`payments`, `receipts`,
 *      `paymentAllocations`) NEVER happen directly here — they route
 *      through `postFinancialEvent` (Story 3.2 cornerstone). The
 *      `local-rules/no-direct-financial-write` rule enforces this at
 *      build time.
 *   3. Atomic multi-document writes: payment + allocations + receipt +
 *      audit + (potential) contract-state-transition all run inside the
 *      single Convex mutation transaction. A throw anywhere — e.g. the
 *      cornerstone's idempotency-mismatch check — rolls back EVERY
 *      preceding write.
 *   4. State-machine transitions go through `transitionContractState`
 *      (Story 1.7 + 3.6 cornerstone). The `active → paid_in_full`
 *      auto-fire when the last installment closes lives here.
 *   5. Money is stored as INTEGER centavos (`amountCents` /
 *      `principalCents` / `paidCents`). Float pesos are forbidden
 *      (ADR-0007).
 *
 * The `recordPaymentWithAutoAllocation` mutation orchestrates the
 * routine:
 *
 *   a. Validate inputs (amount > 0, contract exists + is `active`,
 *      reference required for non-cash, idempotency key non-empty).
 *   b. Load the contract and its installment schedule. Iterate
 *      installments ordered by `installmentNumber` ascending; allocate
 *      `min(remaining, installmentBalance)` to each unpaid row until
 *      `remaining === 0`. Build the allocation array for the
 *      cornerstone.
 *   c. Reject overpayment (CONTRACT_WOULD_OVERPAY) — until §10 Q1's
 *      credit-balance policy is decided, we do not silently apply
 *      overflow as a credit.
 *   d. Post the financial event via `postFinancialEvent`. The
 *      cornerstone writes the payment + receipt + one allocation row
 *      per touched installment + the receipt-create audit row, all
 *      inside the enclosing transaction.
 *   e. Patch each touched installment with its new `paidCents`,
 *      `paidAt` (when fully paid), and `status` (`paid` when
 *      `paidCents === principalCents`, else `pending`).
 *   f. If every installment now reads `paid`, transition the contract
 *      from `active` to `paid_in_full` via `transitionContractState`.
 *      The helper emits the transition audit row.
 *
 * Story callers:
 *   - `src/components/PaymentForm/PaymentForm.tsx` (Story 3.9 UI) calls
 *     `recordPaymentWithAutoAllocation` via `useMutation`.
 *   - Future Story 3.10 introduces `recordPaymentWithOverride`
 *     alongside this mutation.
 */

import {
  type DataModelFromSchemaDefinition,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import { ErrorCode, throwError } from "./lib/errors";
import { postFinancialEvent } from "./lib/postFinancialEvent";
import { transitionContractState } from "./lib/stateMachines";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ContractId = DataModel["contracts"]["document"]["_id"];
type PaymentId = DataModel["payments"]["document"]["_id"];
type ReceiptId = DataModel["receipts"]["document"]["_id"];
type UserId = DataModel["users"]["document"]["_id"];
type InstallmentDoc = DataModel["installments"]["document"];
type InstallmentId = InstallmentDoc["_id"];

/**
 * Payment-method literal union accepted by
 * `recordPaymentWithAutoAllocation`. Mirrors the narrow office-staff
 * surface from Stories 3.3 / 3.4 — cash / check / bank_transfer. The
 * wider e-wallet + card surface (gcash / maya / card) lands in Epic 9's
 * customer-portal flow on a different mutation.
 */
const paymentMethodValidator = v.union(
  v.literal("cash"),
  v.literal("check"),
  v.literal("bank_transfer"),
);

export type PaymentMethod = "cash" | "check" | "bank_transfer";

/**
 * Public arg shape for `recordPaymentWithAutoAllocation`. Mirrors the
 * validator below; exported for typechecking from the React form and
 * the Vitest suite.
 */
export interface RecordPaymentWithAutoAllocationArgs {
  contractId: ContractId;
  amountCents: number;
  paymentMethod: PaymentMethod;
  reference?: string;
  paidAt: number;
  idempotencyKey: string;
}

/**
 * Allocation breakdown returned to the caller alongside the payment +
 * receipt ids. Each row mirrors what the cornerstone wrote against the
 * `paymentAllocations` table; the UI uses it for the "applied to
 * installment N" rendering on the contract detail timeline.
 */
export interface RecordPaymentAllocationEntry {
  installmentId: InstallmentId;
  installmentNumber: number;
  amountAppliedCents: number;
  installmentMarkedPaid: boolean;
}

/**
 * Public return shape for `recordPaymentWithAutoAllocation`.
 */
export interface RecordPaymentWithAutoAllocationResult {
  paymentId: PaymentId;
  receiptId: ReceiptId;
  receiptNumber: string;
  contractClosed: boolean;
  allocations: RecordPaymentAllocationEntry[];
}

/**
 * Records a mid-stream installment payment with FIFO auto-allocation
 * (Story 3.9, FR26).
 *
 * Authorization: office_staff or admin. Field workers do NOT collect;
 * customer-role callers never have access to this surface.
 *
 * Validation (cheapest first):
 *   - `amountCents` must be a positive integer (basis: ADR-0007 +
 *     defense-in-depth against a malformed client).
 *   - `paymentMethod !== "cash"` implies a non-empty `reference`
 *     (cheque / bank-transfer number). Mirrors the sale flow's
 *     invariant; FR26 keeps the bookkeeping rule consistent across
 *     payment kinds.
 *   - `paidAt` must be a finite number not in the future beyond a
 *     5-minute clock-skew tolerance (catches a client with a wildly-
 *     wrong system clock).
 *   - `idempotencyKey` must be a non-empty trimmed string.
 *   - The contract must exist (NOT_FOUND).
 *   - The contract must be `kind: "installment"` (CONTRACT_NOT_ACTIVE
 *     when the kind is anything else — this mutation does not apply to
 *     full-payment sales).
 *   - The contract must be in state `active` (CONTRACT_NOT_ACTIVE when
 *     it is `paid_in_full`, `cancelled`, `voided`, or `in_default`).
 *
 * Side effects (in transaction order):
 *   1. Load the contract + all installments ordered by
 *      `installmentNumber` ascending.
 *   2. FIFO-allocate the amount across the unpaid installments:
 *      for each row with `status !== "paid"`, apply
 *      `min(remaining, principalCents - paidCents)` and accumulate the
 *      cornerstone-bound allocation array. Stop when `remaining === 0`.
 *   3. If `remaining > 0` after every installment is satisfied, throw
 *      `CONTRACT_WOULD_OVERPAY`. The UI surfaces this inline; the
 *      operator decides whether to reduce the amount or to escalate
 *      for a credit-balance workflow (deferred to a future story; §10
 *      Q1 area).
 *   4. Call `postFinancialEvent({ kind: "payment", ... })` with the
 *      assembled allocation array. The cornerstone writes the payment,
 *      receipt, paymentAllocation rows, and the receipt audit row.
 *      Idempotency dedup happens inside the cornerstone via the
 *      `payments.by_idempotency` index.
 *   5. Patch each touched installment with its new `paidCents`,
 *      `status`, and (when fully closed) `paidAt`. The installment-
 *      state transitions DO NOT route through `transitionContractState`
 *      — installments are not in the master state-machine table. The
 *      `pending → paid` change is a column-level write, not an
 *      entity-state transition.
 *   6. If every installment now reads `paid`, call
 *      `transitionContractState(ctx, { contractId, to: "paid_in_full",
 *      reason: "All installments paid" })`. The helper asserts the
 *      transition, patches the `state` field, and emits the transition
 *      audit row. The `active → paid_in_full` edge is NOT in
 *      `REASON_REQUIRED_TRANSITIONS`, but we supply a reason anyway
 *      for forensic clarity ("why did this contract close?").
 *
 * Atomicity: every step runs inside the single Convex mutation
 * transaction. A throw anywhere — cornerstone idempotency mismatch,
 * an installment patch hitting a race, the contract-transition
 * helper's invariant — rolls back the entire transaction. There is no
 * "payment landed but installments stayed pending" partial state.
 *
 * Idempotency: a retry with the same `idempotencyKey` + same payload
 * returns the previously-issued receipt without re-writing. Same key
 * + different payload throws `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`
 * from the cornerstone (the caller must mint a fresh UUID for the new
 * intent).
 *
 * Throws:
 *   - `UNAUTHENTICATED` / `FORBIDDEN` — auth gate.
 *   - `VALIDATION` — amount / reference / paidAt / idempotency key
 *     invariants.
 *   - `NOT_FOUND` — contract id does not resolve.
 *   - `CONTRACT_NOT_ACTIVE` — contract is not an installment contract
 *     in the `active` state. The UI surfaces this as "Contract is no
 *     longer active for payments."
 *   - `CONTRACT_WOULD_OVERPAY` — payment amount exceeds the
 *     outstanding balance on the contract. The UI inline-warns and
 *     asks the operator to reduce the amount.
 *   - `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD` — same key +
 *     different intent. Programming bug, surfaced loudly.
 */
export const recordPaymentWithAutoAllocation = mutationGeneric({
  args: {
    contractId: v.id("contracts"),
    amountCents: v.number(),
    paymentMethod: paymentMethodValidator,
    reference: v.optional(v.string()),
    paidAt: v.number(),
    idempotencyKey: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    args: RecordPaymentWithAutoAllocationArgs,
  ): Promise<RecordPaymentWithAutoAllocationResult> => {
    const auth = await requireRole(ctx, ["admin", "office_staff"]);

    // Step 1: Cheap defensive validation. The Zod-validated client
    // form already enforces these, but the cornerstone discipline is
    // "validate at the server boundary."
    if (
      !Number.isFinite(args.amountCents) ||
      !Number.isInteger(args.amountCents) ||
      args.amountCents <= 0
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "Amount must be a positive integer in centavos.",
        { amountCents: args.amountCents },
      );
    }
    const reference =
      args.reference !== undefined && args.reference.trim().length > 0
        ? args.reference.trim()
        : undefined;
    if (args.paymentMethod !== "cash" && reference === undefined) {
      throwError(
        ErrorCode.VALIDATION,
        "Reference number is required for cheque and bank transfer payments.",
        { paymentMethod: args.paymentMethod },
      );
    }
    if (!Number.isFinite(args.paidAt)) {
      throwError(ErrorCode.VALIDATION, "paidAt must be a finite epoch.", {
        paidAt: args.paidAt,
      });
    }
    // 5-minute clock-skew tolerance. A client with a wildly-wrong
    // system clock should fail fast rather than write a future-dated
    // payment.
    const now = Date.now();
    const FIVE_MIN_MS = 5 * 60 * 1000;
    if (args.paidAt > now + FIVE_MIN_MS) {
      throwError(
        ErrorCode.VALIDATION,
        "paidAt cannot be in the future.",
        { paidAt: args.paidAt, now },
      );
    }
    if (!args.idempotencyKey || args.idempotencyKey.trim().length === 0) {
      throwError(ErrorCode.VALIDATION, "Idempotency key is required.");
    }

    // Step 2: Load + validate the contract.
    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }
    if (contract.kind !== "installment") {
      // Mid-stream payments only apply to installment contracts; a
      // full-payment sale is already closed at insert time. Surface
      // via INVARIANT_VIOLATION — the existing error vocabulary covers
      // "contract is not in a state that accepts this operation"; a
      // dedicated `CONTRACT_NOT_ACTIVE` code would require a
      // `convex/lib/errors.ts` extension that belongs to a future
      // story.
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Mid-stream payments only apply to installment contracts.",
        { contractId: args.contractId, kind: contract.kind },
      );
    }
    if (contract.state !== "active") {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        `Contract is not active (current state: ${contract.state}).`,
        { contractId: args.contractId, state: contract.state },
      );
    }

    // Step 3: Load the installment schedule ordered by
    // `installmentNumber` ascending. The `by_contract` index does not
    // order by installment number; sort in-handler. Schedule size is
    // capped at 60 rows per Story 3.4's validator.
    const installmentRows = await ctx.db
      .query("installments")
      .withIndex("by_contract", (q) => q.eq("contractId", args.contractId))
      .collect();
    const ordered = [...installmentRows].sort(
      (a, b) => a.installmentNumber - b.installmentNumber,
    );

    // Step 4: FIFO-allocate the amount across unpaid installments. For
    // each row with `status !== "paid"` (i.e. `pending` / `overdue` /
    // `waived` — though `waived` rows have `paidCents === principalCents`
    // implicitly by an admin-level write and would not be touched
    // here), apply `min(remaining, principalCents - paidCents)`.
    let remaining = args.amountCents;
    interface PlannedAllocation {
      installment: InstallmentDoc;
      amountAppliedCents: number;
      newPaidCents: number;
      willMarkPaid: boolean;
    }
    const plannedAllocations: PlannedAllocation[] = [];
    for (const row of ordered) {
      if (remaining <= 0) break;
      if (row.status === "paid" || row.status === "waived") {
        continue;
      }
      const balance = row.principalCents - row.paidCents;
      if (balance <= 0) {
        // Defensive: a `pending` / `overdue` row should always have a
        // positive balance, but never trust the read. Skip the row so
        // we don't write a zero-amount allocation (cornerstone refuses
        // empty/zero allocations).
        continue;
      }
      const applied = Math.min(remaining, balance);
      remaining -= applied;
      const newPaidCents = row.paidCents + applied;
      plannedAllocations.push({
        installment: row,
        amountAppliedCents: applied,
        newPaidCents,
        willMarkPaid: newPaidCents === row.principalCents,
      });
    }

    // Step 4b: Story 3.8 rebuild (FR25) — perpetual-care follow-on.
    // After every installment is satisfied, route any remaining
    // payment amount to the contract's perpetual-care balance until
    // `perpetualCarePaidCents === perpetualCareCents`. Routine
    // operation: most installment sales bundle the perpetual-care
    // fee into the down payment (see `contracts.ts`), so the contract
    // arrives here with `perpetualCarePaidCents === perpetualCareCents`
    // and this branch is a no-op. The branch exists for (a) legacy
    // contracts that pre-date the rebuild and (b) the future annual-
    // billing surface where a perpetual-care top-up payment is routed
    // through this allocator.
    const perpetualCareTotal = contract.perpetualCareCents ?? 0;
    const perpetualCarePaid = contract.perpetualCarePaidCents ?? 0;
    const perpetualCareOutstanding = Math.max(
      perpetualCareTotal - perpetualCarePaid,
      0,
    );
    let perpetualCareApplied = 0;
    if (remaining > 0 && perpetualCareOutstanding > 0) {
      perpetualCareApplied = Math.min(remaining, perpetualCareOutstanding);
      remaining -= perpetualCareApplied;
    }

    // Step 5: Overpay guard. Until §10 Q1's credit-balance policy is
    // decided, surface an explicit error rather than silently applying
    // overflow as a credit. The UI inline-warns and asks the operator
    // to reduce the amount.
    if (remaining > 0) {
      // Surface via INVARIANT_VIOLATION — the cemetery's policy on
      // credit-balance handling is §10 Q1; until that lands, "would
      // overpay" is treated as a bookkeeping invariant violation. The
      // details bag carries `overpay: true` + `excessCents` so the UI
      // can distinguish overpay from the other invariants and render
      // the AC6 inline warning.
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Payment amount exceeds the contract's outstanding balance.",
        {
          contractId: args.contractId,
          overpay: true,
          excessCents: remaining,
        },
      );
    }
    if (plannedAllocations.length === 0 && perpetualCareApplied === 0) {
      // Either every installment is paid (contract should have been
      // closed already) or the amount routed through with no targets.
      // Both surface as "contract is not active for payments" from the
      // operator's POV.
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Contract has no unpaid installments to apply payment against.",
        { contractId: args.contractId },
      );
    }

    // Step 6: Build the cornerstone allocation array. One row per
    // touched installment; `targetType: "installment"` so the
    // cornerstone's polymorphic allocator records the installment id.
    // Sequence is the position in the planned-allocations array so the
    // cornerstone preserves FIFO order on read.
    //
    // Story 3.8 rebuild: appends a single `perpetualCare`-targeted
    // allocation row when `perpetualCareApplied > 0`. The target id
    // is the contract id (the perpetual-care balance lives on the
    // contract row).
    const cornerstoneAllocations: Array<{
      targetType: "installment" | "perpetualCare";
      targetId: string;
      amountCents: number;
      sequence: number;
      note?: string;
    }> = plannedAllocations.map((planned, index) => ({
      targetType: "installment" as const,
      targetId: planned.installment._id,
      amountCents: planned.amountAppliedCents,
      sequence: index,
    }));
    if (perpetualCareApplied > 0) {
      cornerstoneAllocations.push({
        targetType: "perpetualCare",
        targetId: args.contractId,
        amountCents: perpetualCareApplied,
        sequence: cornerstoneAllocations.length,
        note: "Perpetual care top-up",
      });
    }

    // Step 7: Post the financial event via the cornerstone. This
    // writes: payment + receipt + one allocation row per touched
    // installment + receipt audit row. Idempotency dedup is handled
    // inside the cornerstone.
    const financialResult = await postFinancialEvent(ctx, {
      kind: "payment",
      idempotencyKey: args.idempotencyKey,
      payment: {
        amountCents: args.amountCents,
        paymentMethod: args.paymentMethod,
        reference,
        receivedAt: args.paidAt,
        receivedByUserId: auth.userId,
        contractId: args.contractId,
        customerId: contract.customerId,
      },
      allocations: cornerstoneAllocations,
    });

    if (financialResult.paymentId === null) {
      // Defensive — `kind: "payment"` always returns a non-null
      // paymentId from the cornerstone. If we hit this branch the
      // cornerstone contract has drifted; fail loudly rather than
      // silently swallow the inconsistency.
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "postFinancialEvent returned null paymentId for a payment event.",
      );
    }

    // Step 8: Patch each touched installment with its new
    // `paidCents`, `status`, and (when fully closed) `paidAt`. The
    // `pending → paid` change is a column-level write — installments
    // are not in the master state-machine table, so we do not route
    // through `assertTransition` here. The audit trail of the payment
    // event already captures "what closed this installment" via the
    // paymentAllocations rows written by the cornerstone above.
    const allocationsResult: RecordPaymentAllocationEntry[] = [];
    for (const planned of plannedAllocations) {
      const patch: {
        paidCents: number;
        status?: "paid";
        paidAt?: number;
      } = {
        paidCents: planned.newPaidCents,
      };
      if (planned.willMarkPaid) {
        patch.status = "paid";
        patch.paidAt = args.paidAt;
      }
      await ctx.db.patch(planned.installment._id, patch);
      allocationsResult.push({
        installmentId: planned.installment._id,
        installmentNumber: planned.installment.installmentNumber,
        amountAppliedCents: planned.amountAppliedCents,
        installmentMarkedPaid: planned.willMarkPaid,
      });
    }

    // Step 8b: Story 3.8 rebuild — bump the contract's
    // `perpetualCarePaidCents` by the amount routed to perpetual care
    // above. This is the missing patch that the original 3.8 ship
    // forgot; without it, perpetual-care allocations land in
    // `paymentAllocations` but the contract's running tally never
    // moves, so reports + UI show ₱0 paid forever.
    if (perpetualCareApplied > 0) {
      await ctx.db.patch(args.contractId, {
        perpetualCarePaidCents: perpetualCarePaid + perpetualCareApplied,
      });
    }

    // Step 9: If every installment is now paid, transition the
    // contract from `active` to `paid_in_full`. We re-derive the
    // condition from the planned allocations + the prior installment
    // states rather than re-querying — the in-transaction read would
    // return the same patched rows we just wrote, but the explicit
    // derivation is safer (and faster).
    let contractClosed = false;
    const allInstallmentsNowPaid = ordered.every((row) => {
      // Was the row already paid before this transaction?
      if (row.status === "paid") return true;
      // Did this transaction close it?
      const planned = plannedAllocations.find(
        (p) => p.installment._id === row._id,
      );
      return planned !== undefined && planned.willMarkPaid;
    });
    if (allInstallmentsNowPaid) {
      await transitionContractState(ctx, {
        contractId: args.contractId,
        to: "paid_in_full",
        reason: "All installments paid",
      });
      contractClosed = true;
    }

    return {
      paymentId: financialResult.paymentId,
      receiptId: financialResult.receiptId,
      receiptNumber: financialResult.receiptNumber,
      contractClosed,
      allocations: allocationsResult,
    };
  },
});

/**
 * Story 3.10 — manual override allocation row (FR27).
 *
 * Office staff override the FIFO auto-allocation by supplying explicit
 * per-installment amounts. Each row references the installment id and
 * the centavos to apply against it. Rows with `amountCents === 0` are
 * dropped before reaching the cornerstone (the cornerstone refuses
 * zero-amount allocations).
 */
export interface CustomAllocationRow {
  installmentId: InstallmentId;
  amountCents: number;
}

/**
 * Public arg shape for `recordPaymentWithCustomAllocation` (Story 3.10).
 *
 * Identical to `recordPaymentWithAutoAllocation` plus the
 * `allocations` array. The form's "Custom allocation" toggle is the
 * only entry point in Phase 1 — auto-allocation remains the default and
 * still routes through the original mutation.
 */
export interface RecordPaymentWithCustomAllocationArgs {
  contractId: ContractId;
  amountCents: number;
  paymentMethod: PaymentMethod;
  reference?: string;
  paidAt: number;
  idempotencyKey: string;
  allocations: CustomAllocationRow[];
}

/**
 * Records a mid-stream installment payment with a caller-supplied
 * per-installment distribution (Story 3.10, FR27).
 *
 * The only structural difference from `recordPaymentWithAutoAllocation`
 * is the source of the per-installment plan: this mutation trusts the
 * caller's `allocations` array AFTER re-validating it server-side
 * against the installment schedule. The FIFO walk is replaced by a
 * direct lookup of each `installmentId`; everything downstream — the
 * cornerstone call, the installment patches, the contract-close
 * transition — is identical.
 *
 * Authorization: office_staff or admin. Customer / field_worker callers
 * are rejected with FORBIDDEN at the requireRole gate.
 *
 * Server-side validation order (defense in depth — the client's gate is
 * a UX nicety, this is the invariant):
 *
 *   1. requireRole (admin / office_staff).
 *   2. amountCents > 0 and a positive integer.
 *   3. paidAt is finite + within the 5-minute clock-skew tolerance.
 *   4. idempotencyKey is a non-empty trimmed string.
 *   5. allocations.length >= 1 (the cornerstone also enforces this; we
 *      surface it earlier so the error message is sharper).
 *   6. Each allocation row's amountCents is a positive integer.
 *   7. sum(allocations[].amountCents) === args.amountCents
 *      (ALLOCATION_SUM_MISMATCH).
 *   8. The contract exists, is `kind: "installment"`, and is in state
 *      `active`.
 *   9. Each `installmentId` belongs to `args.contractId` (no
 *      cross-contract allocation).
 *  10. No allocation targets a `paid` / `waived` installment.
 *  11. Each allocation row's `amountCents` is ≤ the installment's
 *      outstanding balance — Phase 1 forbids per-row credit-forward
 *      overpayment until §10 Q1's credit-balance policy is decided.
 *  12. No duplicate `installmentId` across rows (rolling up multiple
 *      rows onto a single installment is a category error — the UI
 *      should merge before submit).
 *
 * Side effects (in transaction order, mirroring the auto-allocation
 * mutation):
 *   - postFinancialEvent writes payment + receipt + one allocation row
 *     per touched installment + the receipt audit row.
 *   - Each touched installment is patched with its new paidCents,
 *     status, and (when fully closed) paidAt.
 *   - If every installment now reads `paid`, the contract transitions
 *     to `paid_in_full`.
 *
 * Atomicity + idempotency are inherited from the cornerstone exactly
 * as in `recordPaymentWithAutoAllocation`. Same key + same payload =>
 * previously-issued receipt. Same key + different payload =>
 * IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD.
 *
 * Throws:
 *   - UNAUTHENTICATED / FORBIDDEN — auth gate.
 *   - VALIDATION — amount / paidAt / idempotency key / per-row amount
 *     invariants.
 *   - NOT_FOUND — contract id does not resolve.
 *   - INVARIANT_VIOLATION — contract not active / installment doesn't
 *     belong to contract / installment already paid or waived / row
 *     exceeds outstanding balance / duplicate installment id.
 *   - ALLOCATION_SUM_MISMATCH — sum of allocations != amount.
 *   - EMPTY_ALLOCATIONS — empty allocations array.
 *   - IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD — same key, new
 *     payload.
 */
export const recordPaymentWithCustomAllocation = mutationGeneric({
  args: {
    contractId: v.id("contracts"),
    amountCents: v.number(),
    paymentMethod: paymentMethodValidator,
    reference: v.optional(v.string()),
    paidAt: v.number(),
    idempotencyKey: v.string(),
    allocations: v.array(
      v.object({
        installmentId: v.id("installments"),
        amountCents: v.number(),
      }),
    ),
  },
  handler: async (
    ctx: MutationCtx,
    args: RecordPaymentWithCustomAllocationArgs,
  ): Promise<RecordPaymentWithAutoAllocationResult> => {
    // Step 0: Auth FIRST — defense in depth + parity with the
    // auto-allocation mutation. Office staff and admin only.
    const auth = await requireRole(ctx, ["admin", "office_staff"]);

    // Step 1: Cheap defensive validation on the scalar args.
    if (
      !Number.isFinite(args.amountCents) ||
      !Number.isInteger(args.amountCents) ||
      args.amountCents <= 0
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "Amount must be a positive integer in centavos.",
        { amountCents: args.amountCents },
      );
    }
    const reference =
      args.reference !== undefined && args.reference.trim().length > 0
        ? args.reference.trim()
        : undefined;
    if (args.paymentMethod !== "cash" && reference === undefined) {
      throwError(
        ErrorCode.VALIDATION,
        "Reference number is required for cheque and bank transfer payments.",
        { paymentMethod: args.paymentMethod },
      );
    }
    if (!Number.isFinite(args.paidAt)) {
      throwError(ErrorCode.VALIDATION, "paidAt must be a finite epoch.", {
        paidAt: args.paidAt,
      });
    }
    const now = Date.now();
    const FIVE_MIN_MS = 5 * 60 * 1000;
    if (args.paidAt > now + FIVE_MIN_MS) {
      throwError(
        ErrorCode.VALIDATION,
        "paidAt cannot be in the future.",
        { paidAt: args.paidAt, now },
      );
    }
    if (!args.idempotencyKey || args.idempotencyKey.trim().length === 0) {
      throwError(ErrorCode.VALIDATION, "Idempotency key is required.");
    }
    if (args.allocations.length === 0) {
      throwError(
        ErrorCode.EMPTY_ALLOCATIONS,
        "Custom allocation requires at least one allocation row.",
      );
    }

    // Step 2: Per-row scalar validation + sum check. Drop zero-amount
    // rows BEFORE the sum check because the UI may submit a row for
    // every visible installment with `0` on the ones the staff didn't
    // touch (zero rows are a UX artifact; the cornerstone refuses
    // them). Track duplicates with a Set so the second occurrence of
    // an id throws.
    const seenInstallmentIds = new Set<string>();
    let runningSum = 0;
    const cleaned: CustomAllocationRow[] = [];
    for (let i = 0; i < args.allocations.length; i++) {
      const row = args.allocations[i]!;
      if (
        !Number.isFinite(row.amountCents) ||
        !Number.isInteger(row.amountCents) ||
        row.amountCents < 0
      ) {
        throwError(
          ErrorCode.VALIDATION,
          "Each allocation amount must be a non-negative integer in centavos.",
          { index: i, amountCents: row.amountCents },
        );
      }
      const idStr = row.installmentId as unknown as string;
      if (seenInstallmentIds.has(idStr)) {
        throwError(
          ErrorCode.INVARIANT_VIOLATION,
          "Duplicate installment id in custom allocation.",
          { installmentId: idStr },
        );
      }
      seenInstallmentIds.add(idStr);
      runningSum += row.amountCents;
      if (row.amountCents > 0) {
        cleaned.push(row);
      }
    }
    if (runningSum !== args.amountCents) {
      throwError(
        ErrorCode.ALLOCATION_SUM_MISMATCH,
        `Sum of allocations (${runningSum}) does not equal payment amount (${args.amountCents}).`,
        { allocationsSum: runningSum, paymentAmountCents: args.amountCents },
      );
    }
    if (cleaned.length === 0) {
      // Every row was zero — sum would have been zero, which fails the
      // sum-mismatch check above. Defensive belt-and-braces.
      throwError(
        ErrorCode.EMPTY_ALLOCATIONS,
        "Custom allocation must include at least one non-zero row.",
      );
    }

    // Step 3: Load + validate the contract. Same gates as
    // recordPaymentWithAutoAllocation.
    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }
    if (contract.kind !== "installment") {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Mid-stream payments only apply to installment contracts.",
        { contractId: args.contractId, kind: contract.kind },
      );
    }
    if (contract.state !== "active") {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        `Contract is not active (current state: ${contract.state}).`,
        { contractId: args.contractId, state: contract.state },
      );
    }

    // Step 4: Load the full installment schedule for the contract. We
    // need it to (a) verify each allocation's installment belongs to
    // the contract, (b) verify outstanding balance per row, (c) decide
    // whether the contract closes after this payment.
    const installmentRows = await ctx.db
      .query("installments")
      .withIndex("by_contract", (q) => q.eq("contractId", args.contractId))
      .collect();
    const installmentsById = new Map<string, InstallmentDoc>();
    for (const row of installmentRows) {
      installmentsById.set(row._id as unknown as string, row);
    }

    // Step 5: Per-row server-side validation against the schedule.
    interface PlannedAllocation {
      installment: InstallmentDoc;
      amountAppliedCents: number;
      newPaidCents: number;
      willMarkPaid: boolean;
    }
    const plannedAllocations: PlannedAllocation[] = [];
    for (const row of cleaned) {
      const installment = installmentsById.get(
        row.installmentId as unknown as string,
      );
      if (installment === undefined) {
        throwError(
          ErrorCode.INVARIANT_VIOLATION,
          "Allocation references an installment that does not belong to the contract.",
          {
            installmentId: row.installmentId,
            contractId: args.contractId,
          },
        );
      }
      if (installment.status === "paid" || installment.status === "waived") {
        throwError(
          ErrorCode.INVARIANT_VIOLATION,
          `Cannot allocate to installment #${installment.installmentNumber} — already ${installment.status}.`,
          {
            installmentId: row.installmentId,
            status: installment.status,
          },
        );
      }
      const outstanding = installment.principalCents - installment.paidCents;
      if (outstanding <= 0) {
        // Defensive: a non-paid / non-waived row should always have a
        // positive outstanding balance. Surface the inconsistency
        // rather than write a zero-applied row.
        throwError(
          ErrorCode.INVARIANT_VIOLATION,
          `Installment #${installment.installmentNumber} has no outstanding balance.`,
          { installmentId: row.installmentId },
        );
      }
      if (row.amountCents > outstanding) {
        throwError(
          ErrorCode.INVARIANT_VIOLATION,
          `Allocation to installment #${installment.installmentNumber} exceeds its outstanding balance.`,
          {
            installmentId: row.installmentId,
            amountCents: row.amountCents,
            outstandingCents: outstanding,
          },
        );
      }
      const newPaidCents = installment.paidCents + row.amountCents;
      plannedAllocations.push({
        installment,
        amountAppliedCents: row.amountCents,
        newPaidCents,
        willMarkPaid: newPaidCents === installment.principalCents,
      });
    }

    // Step 6: Build the cornerstone allocation array preserving the
    // CALLER'S row order — the override's "stated intent" is part of
    // the audit trail. The cornerstone writes one paymentAllocations
    // row per entry with `sequence` set to the array position.
    const cornerstoneAllocations = plannedAllocations.map(
      (planned, index) => ({
        targetType: "installment" as const,
        targetId: planned.installment._id,
        amountCents: planned.amountAppliedCents,
        sequence: index,
      }),
    );

    // Step 7: Post the financial event via the cornerstone. The
    // cornerstone's sum check is symmetric with ours; the dedupe path
    // returns the previously-issued receipt without writing if the
    // idempotency key has been seen with the same payload.
    const financialResult = await postFinancialEvent(ctx, {
      kind: "payment",
      idempotencyKey: args.idempotencyKey,
      payment: {
        amountCents: args.amountCents,
        paymentMethod: args.paymentMethod,
        reference,
        receivedAt: args.paidAt,
        receivedByUserId: auth.userId,
        contractId: args.contractId,
        customerId: contract.customerId,
      },
      allocations: cornerstoneAllocations,
    });

    if (financialResult.paymentId === null) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "postFinancialEvent returned null paymentId for a payment event.",
      );
    }

    // Step 8: Patch each touched installment.
    const allocationsResult: RecordPaymentAllocationEntry[] = [];
    for (const planned of plannedAllocations) {
      const patch: {
        paidCents: number;
        status?: "paid";
        paidAt?: number;
      } = {
        paidCents: planned.newPaidCents,
      };
      if (planned.willMarkPaid) {
        patch.status = "paid";
        patch.paidAt = args.paidAt;
      }
      await ctx.db.patch(planned.installment._id, patch);
      allocationsResult.push({
        installmentId: planned.installment._id,
        installmentNumber: planned.installment.installmentNumber,
        amountAppliedCents: planned.amountAppliedCents,
        installmentMarkedPaid: planned.willMarkPaid,
      });
    }

    // Step 9: Auto-close the contract when every installment now
    // reads `paid`. Same derivation as the auto-allocation mutation —
    // walk the loaded rows + overlay the planned changes.
    let contractClosed = false;
    const allInstallmentsNowPaid = installmentRows.every((row) => {
      if (row.status === "paid") return true;
      const planned = plannedAllocations.find(
        (p) => p.installment._id === row._id,
      );
      return planned !== undefined && planned.willMarkPaid;
    });
    if (allInstallmentsNowPaid) {
      await transitionContractState(ctx, {
        contractId: args.contractId,
        to: "paid_in_full",
        reason: "All installments paid",
      });
      contractClosed = true;
    }

    return {
      paymentId: financialResult.paymentId,
      receiptId: financialResult.receiptId,
      receiptNumber: financialResult.receiptNumber,
      contractClosed,
      allocations: allocationsResult,
    };
  },
});

/**
 * Public arg shape for `listPaymentsInPeriod` (HIGH-A fix, Epic 5
 * adversarial review — Story 5.3 drill-down).
 *
 * The dashboard's MTD / YTD Collections tile drills into `/payments`;
 * that page consumes this query to render the cross-contract list of
 * every payment whose `receivedAt` falls inside the period window.
 *
 * The bounds are Manila-tz half-open from the dashboard's
 * `periodBounds` helper (or the parallel client mirror in
 * `src/lib/time.ts`). Defaults: `period === "mtd"` if no `from` / `to`
 * supplied → server-side computes the MTD bounds at query-time so a
 * deep-link with no params still works without round-tripping the
 * bounds through the URL. Explicit `from` / `to` override the period.
 */
export interface ListPaymentsInPeriodArgs {
  period?: "mtd" | "ytd";
  from?: number;
  to?: number;
  limit?: number;
}

/**
 * Shape of each row returned by `listPaymentsInPeriod`. Cross-contract
 * — the list spans every contract that has at least one payment in the
 * window. Customer + contract names are hydrated server-side so the UI
 * does not need to fan out to `getContract` / `getCustomer` per row.
 */
export interface PaymentsListRow {
  paymentId: PaymentId;
  paymentNumber: string;
  receiptId?: ReceiptId;
  receiptNumber?: string;
  amountCents: number;
  paymentMethod:
    | "cash"
    | "check"
    | "bank_transfer"
    | "gcash"
    | "maya"
    | "card";
  reference?: string;
  receivedAt: number;
  isVoided: boolean;
  contractId?: ContractId;
  contractNumber?: string;
  customerId?: DataModel["customers"]["document"]["_id"];
  customerFullName?: string;
}

/**
 * Lists every payment received within a Manila-tz period window,
 * ordered by `receivedAt` descending. The query is admin / office_staff
 * gated server-side (same gate as the dashboard collections tile it
 * drills into).
 *
 * Index discipline: walks `payments.by_receivedAt` so the scan is
 * bounded to the period — the prior placeholder relied on a
 * "load everything and filter" pattern that AC5 explicitly forbids.
 *
 * Voided payments are surfaced with `isVoided: true` so the UI can
 * grey-out the row; they are NOT filtered out — operators need to see
 * voids in the period list so the totals reconcile against the
 * dashboard tile (which sums non-voided only).
 */
export const listPaymentsInPeriod = queryGeneric({
  args: {
    period: v.optional(v.union(v.literal("mtd"), v.literal("ytd"))),
    from: v.optional(v.number()),
    to: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx: QueryCtx,
    args: ListPaymentsInPeriodArgs,
  ): Promise<PaymentsListRow[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const limit = Math.min(args.limit ?? 200, 500);

    // Compute Manila-tz bounds. Explicit `from` / `to` win; otherwise
    // we resolve from `period` (defaulting to MTD). The bounds use the
    // same `+08:00` anchor as `convex/dashboard.ts:periodBounds` — PH
    // has no DST so the fixed offset is safe.
    let startMs: number;
    let endMs: number;
    if (args.from !== undefined && args.to !== undefined) {
      startMs = args.from;
      endMs = args.to;
    } else if (args.from !== undefined) {
      startMs = args.from;
      endMs = Date.now();
    } else if (args.to !== undefined) {
      // A trailing `to` with no `from` defaults to the period bounds'
      // start — falls back to MTD start if no period specified.
      const period = args.period ?? "mtd";
      startMs = computeManilaPeriodStart(period, args.to);
      endMs = args.to;
    } else {
      const period = args.period ?? "mtd";
      const now = Date.now();
      startMs = computeManilaPeriodStart(period, now);
      endMs = now;
    }

    const rows = await ctx.db
      .query("payments")
      .withIndex("by_receivedAt", (q) =>
        q.gte("receivedAt", startMs).lte("receivedAt", endMs),
      )
      .collect();
    // Descending so the most-recent payment is at the top of the list.
    const sorted = [...rows].sort((a, b) => b.receivedAt - a.receivedAt);
    const capped = sorted.slice(0, limit);

    const out: PaymentsListRow[] = [];
    for (const row of capped) {
      // Hydrate receipt (one per payment) — the receipt number is the
      // primary identifier shown to the operator.
      const receipt = await ctx.db
        .query("receipts")
        .withIndex("by_payment", (q) => q.eq("paymentId", row._id))
        .unique();
      // Contract + customer hydration. `payments.contractId` /
      // `payments.customerId` are optional on the schema — the historical
      // shape allows a payment without an attached contract (orphaned
      // legacy data). Defensive lookups so a missing FK does not crash
      // the query.
      let contractNumber: string | undefined;
      let customerFullName: string | undefined;
      let contractId: ContractId | undefined;
      let customerId: DataModel["customers"]["document"]["_id"] | undefined;
      if (row.contractId !== undefined) {
        const contract = await ctx.db.get(
          row.contractId as unknown as ContractId,
        );
        if (contract !== null) {
          contractId = contract._id;
          contractNumber = contract.contractNumber;
          // Prefer the contract's customer over the payment's mirror so
          // a payment row with a stale customer back-reference still
          // surfaces the correct name.
          if (customerId === undefined) {
            customerId = contract.customerId;
          }
        }
      }
      if (customerId === undefined && row.customerId !== undefined) {
        customerId = row.customerId as unknown as DataModel["customers"]["document"]["_id"];
      }
      if (customerId !== undefined) {
        // pii-read-ok: staff-facing payments drill-down (admin /
        // office_staff gated above). The customer name surfaces in the
        // table so an operator can reconcile a payment against the
        // person who paid — the same surface every receipt list page
        // already exposes (parity with `contracts:listContracts`).
        const customer = await ctx.db.get(customerId);
        if (customer !== null) {
          customerFullName = customer.fullName;
        }
      }
      const entry: PaymentsListRow = {
        paymentId: row._id,
        paymentNumber: row.paymentNumber,
        amountCents: row.amountCents,
        paymentMethod: row.paymentMethod,
        receivedAt: row.receivedAt,
        isVoided: row.isVoided,
      };
      if (row.reference !== undefined) entry.reference = row.reference;
      if (receipt !== null) {
        entry.receiptId = receipt._id;
        entry.receiptNumber = receipt.receiptNumber;
      }
      if (contractId !== undefined) entry.contractId = contractId;
      if (contractNumber !== undefined) entry.contractNumber = contractNumber;
      if (customerId !== undefined) entry.customerId = customerId;
      if (customerFullName !== undefined) {
        entry.customerFullName = customerFullName;
      }
      out.push(entry);
    }
    return out;
  },
});

/**
 * Manila-tz period start (MTD = first of month, YTD = first of year)
 * anchored at `now`. Local mirror of the dashboard's `periodBounds`
 * helper — `listPaymentsInPeriod` lives in `convex/payments.ts` and we
 * deliberately avoid cross-module imports from the dashboard (which is
 * owned by HIGH-B and is in the "do not touch" list).
 */
function computeManilaPeriodStart(period: "mtd" | "ytd", now: number): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(now));
  const year = parts.find((p) => p.type === "year")?.value ?? "0000";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const iso =
    period === "mtd"
      ? `${year}-${month}-01T00:00:00+08:00`
      : `${year}-01-01T00:00:00+08:00`;
  return new Date(iso).getTime();
}

/**
 * Public arg shape for `listContractPayments`.
 */
export interface ListContractPaymentsArgs {
  contractId: ContractId;
  limit?: number;
}

/**
 * Shape of each row returned by `listContractPayments`. The contract
 * detail page renders this list with a `ReactiveHighlight` per row so
 * new payments arrive with the signature 600ms amber fade.
 */
export interface ContractPaymentRow {
  paymentId: PaymentId;
  paymentNumber: string;
  amountCents: number;
  paymentMethod:
    | "cash"
    | "check"
    | "bank_transfer"
    | "gcash"
    | "maya"
    | "card";
  reference?: string;
  receivedAt: number;
  receivedByUserId: UserId;
  isVoided: boolean;
  receiptId?: ReceiptId;
  receiptNumber?: string;
  creationTime: number;
}

/**
 * Lists payments for a contract, ordered by `_creationTime` descending
 * so the most-recent row is at the top. Default limit is 20 — the
 * common case is a contract with a handful of payments at a time.
 *
 * Auth: admin or office_staff. The customer-portal read path (Epic 9)
 * will introduce a customer-scoped query on a separate function +
 * auth gate.
 *
 * Joins: the receipt row is small (one per payment); we hydrate the
 * receipt number in-handler so the UI does not need a secondary
 * lookup per row. Receipt voided-flag is also surfaced so the UI can
 * grey-out voided rows when Story 3.12 ships.
 */
export const listContractPayments = queryGeneric({
  args: {
    contractId: v.id("contracts"),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx: QueryCtx,
    args: ListContractPaymentsArgs,
  ): Promise<ContractPaymentRow[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const limit = Math.min(args.limit ?? 20, 100);
    const rows = await ctx.db
      .query("payments")
      .withIndex("by_contract", (q) =>
        q.eq("contractId", args.contractId as unknown as string),
      )
      .collect();
    // Sort descending by `_creationTime` so the latest payment is at
    // the top. Convex `_creationTime` is the server-side insert
    // timestamp and the canonical "row arrival order" key.
    const sorted = [...rows].sort(
      (a, b) => b._creationTime - a._creationTime,
    );
    const capped = sorted.slice(0, limit);
    const out: ContractPaymentRow[] = [];
    for (const row of capped) {
      const receipt = await ctx.db
        .query("receipts")
        .withIndex("by_payment", (q) => q.eq("paymentId", row._id))
        .unique();
      const entry: ContractPaymentRow = {
        paymentId: row._id,
        paymentNumber: row.paymentNumber,
        amountCents: row.amountCents,
        paymentMethod: row.paymentMethod,
        receivedAt: row.receivedAt,
        receivedByUserId: row.receivedByUserId,
        isVoided: row.isVoided,
        creationTime: row._creationTime,
      };
      if (row.reference !== undefined) entry.reference = row.reference;
      if (receipt !== null) {
        entry.receiptId = receipt._id;
        entry.receiptNumber = receipt.receiptNumber;
      }
      out.push(entry);
    }
    return out;
  },
});
