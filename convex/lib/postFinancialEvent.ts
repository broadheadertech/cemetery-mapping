/**
 * Atomic financial-event cornerstone — Story 3.2 (FR28, FR29, FR32,
 * NFR-C1, NFR-C2, NFR-R5).
 *
 * Every money-touching mutation in cemetery-mapping routes through
 * `postFinancialEvent`. Sale, payment, void, refund, future
 * Epic-9 webhook intake — all of them, no exceptions. The helper is
 * the single point at which the cornerstone invariants of the
 * financial ledger are guaranteed:
 *
 *   1. Atomicity (FR32). Receipt + payment + allocations + audit row
 *      land in ONE Convex mutation = ONE transaction. A partially-
 *      committed financial event ("payment recorded but no receipt"
 *      / "receipt issued but no payment row") is structurally
 *      impossible because Convex rolls back the entire mutation on
 *      any throw.
 *
 *   2. Serial monotonicity + gap-freeness (FR28, NFR-C1). The
 *      cornerstone is the single call site of `allocateNextSerial`;
 *      every sanctioned receipt issuance produces exactly one
 *      strictly-monotonic, never-reused serial. Voids do NOT
 *      decrement the counter (FR29).
 *
 *   3. Allocation sum (ALLOCATION_SUM_MISMATCH). The sum of the
 *      payment's allocations must equal the payment's amount. The
 *      cornerstone refuses to write a partial allocation set — every
 *      centavo must be accounted for. This is the structural
 *      defence against a class of bookkeeping bugs that would
 *      otherwise only surface at month-end reconciliation.
 *
 *   4. Idempotency (NFR-R5). A client may safely re-submit the same
 *      payload under the same `idempotencyKey` — a double-click
 *      submit, a browser refresh after submit, a flaky network. The
 *      cornerstone dedupes via the `payments.by_idempotency` index:
 *      on a hit, it returns the previously-issued receipt without
 *      writing anything new. Re-submitting a DIFFERENT payload under
 *      the same key throws `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`
 *      (a programming bug, not a retry-friendly error).
 *
 *   5. Audit completeness. Every event emits exactly one audit row
 *      via `emitAudit` from Story 1.6 — never a direct insert into
 *      `auditLog` (`no-audit-log-direct-write` rule blocks the
 *      bypass).
 *
 * Boundary enforcement: the `no-direct-financial-write` ESLint rule
 * blocks `ctx.db.insert("payments" | "receipts" | "paymentAllocations",
 * ...)` and the void-flag patches anywhere except this file. A
 * determined developer with a dynamic table-name string can bypass
 * the rule; code review + this file's contract close the residual
 * gap. The architectural commitment is "ONE place where money
 * touches the database."
 *
 * Auth contract: this helper does NOT call `requireRole`. It trusts
 * that the calling mutation (Stories 3.3, 3.9, 3.12, future Epic-9
 * webhooks) has already authorised the caller. The
 * `require-role-first-line` rule enforces that on the calling-
 * mutation side; this helper is exempt because it lives under
 * `convex/lib/`. The cornerstone uses the authenticated user only
 * for the audit emission (`emitAudit` reads the identity itself).
 *
 * See `docs/adr/0012-postfinancialevent-cornerstone.md` for the full
 * decision record. Architectural source of truth: architecture's
 * "Atomic mutation pattern (cornerstone)" + "Financial-entity write
 * boundary" § Architectural Boundaries.
 *
 * Scope deviation from Story 3.2 spec (documented in Dev Agent
 * Record Completion Notes):
 *   - The story's full discriminated-union over `sale_full`,
 *     `sale_installment`, `payment`, `void_receipt`, `refund` is
 *     narrowed in this Phase-1 commit to the cornerstone's
 *     polymorphic-allocations API: `{ kind, paymentDetails,
 *     allocations[] }` where `kind` distinguishes the high-level
 *     event but the per-kind contract / installment / ownership
 *     plumbing is the responsibility of the calling mutation in
 *     Stories 3.3 / 3.4 / 3.9 / 3.12. This keeps the cornerstone
 *     table-agnostic and avoids touching files outside this story's
 *     strict ownership set (`convex/ownerships.ts`, `contracts`,
 *     `installments` tables — all owned by other stories or future
 *     stories). The lint rule, the schema tables, the test
 *     coverage, and the ADR all carry the cornerstone forward; the
 *     per-kind business logic adds on top.
 */

import {
  type DataModelFromSchemaDefinition,
} from "convex/server";

import schema from "../schema";
import { emitAudit, type AuditAction, type AuditEntityType } from "./audit";
import { type MutationCtx } from "./auth";
import { ErrorCode, throwError } from "./errors";
import { assertTransition } from "./stateMachines";
import {
  allocateNextSerial,
  formatSerial,
} from "./receiptCounter";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type PaymentId = DataModel["payments"]["document"]["_id"];
type ReceiptId = DataModel["receipts"]["document"]["_id"];
type UserId = DataModel["users"]["document"]["_id"];

/**
 * Payment-method literal union — mirrors the schema's `payments.paymentMethod`
 * validator. Adding a method requires a schema migration + an ADR
 * amendment; this re-export keeps callers from drifting.
 */
export type PaymentMethod =
  | "cash"
  | "check"
  | "bank_transfer"
  | "gcash"
  | "maya"
  | "card";

/**
 * Allocation-target discriminator — mirrors the schema's
 * `paymentAllocations.targetType` validator. The polymorphic shape
 * lets the cornerstone stay table-agnostic: a contract-level full-
 * payment allocates `{ targetType: "contract", targetId: contractId,
 * amountCents }`; an installment-touching payment allocates one row
 * per installment with `{ targetType: "installment", targetId:
 * installmentId, ...}`; perpetual-care payments (Story 3.8) carry
 * `targetType: "perpetualCare"`; overpayments that the caller decides
 * to credit forward carry `"credit"`.
 */
export type AllocationTargetType =
  | "contract"
  | "installment"
  | "perpetualCare"
  | "credit";

/**
 * Event-kind discriminator. Phase 1 surfaces three kinds:
 *
 *   - `"sale"` — full-payment OR installment-down-payment sale. The
 *     cornerstone issues a receipt; the calling mutation (Story 3.3 /
 *     3.4) wires the contract + ownership rows around it.
 *
 *   - `"payment"` — a mid-stream installment payment. The calling
 *     mutation (Story 3.9 / 3.10) computes the per-installment
 *     allocation array; the cornerstone validates the sum, writes
 *     the rows, and issues the receipt.
 *
 *   - `"void"` — voids a previously-issued receipt. The receipt's
 *     `isVoided` flag flips; the payment's `isVoided` flag flips;
 *     allocations stay in place (the audit trail requires preserving
 *     what the original payment paid). The serial is NOT released —
 *     FR29 explicit.
 *
 *   - `"refund"` — Phase-1 reserved; throws `NOT_IMPLEMENTED`. The
 *     full refund flow lands in Epic 4 (Story 4.x).
 */
export type FinancialEventKind = "sale" | "payment" | "void" | "refund";

/** One row of the caller-supplied allocation array. */
export interface AllocationInput {
  targetType: AllocationTargetType;
  targetId: string;
  amountCents: number;
  sequence?: number;
  note?: string;
}

/** Shared payment metadata across `sale` and `payment` kinds. */
export interface PaymentDetailsInput {
  amountCents: number;
  paymentMethod: PaymentMethod;
  reference?: string;
  receivedAt: number;
  receivedByUserId: UserId;
  contractId?: string;
  customerId?: string;
}

/** Discriminated-union payload accepted by the cornerstone. */
export type PostFinancialEventPayload =
  | {
      kind: "sale" | "payment";
      idempotencyKey: string;
      payment: PaymentDetailsInput;
      allocations: AllocationInput[];
    }
  | {
      kind: "void";
      idempotencyKey: string;
      receiptId: ReceiptId;
      voidReason: string;
      voidedByUserId: UserId;
      voidedAt: number;
    }
  | {
      kind: "refund";
      idempotencyKey: string;
    };

/** Cornerstone return shape. */
export interface PostFinancialEventResult {
  paymentId: PaymentId | null;
  receiptId: ReceiptId;
  receiptNumber: string;
}

/**
 * Internal: shape returned when the idempotency check hits. The
 * cornerstone returns this directly to the caller — no second write.
 */
async function lookupIdempotentResult(
  ctx: MutationCtx,
  idempotencyKey: string,
): Promise<PostFinancialEventResult | null> {
  // The dedup key lives on `payments.idempotencyKey` (indexed) for
  // event-kinds that produce a payment (`sale`, `payment`). The void
  // kind reuses the same idempotency mechanism via a synthetic
  // payment-side index lookup — voids do not produce a NEW payment,
  // but they DO write to the same idempotency space so a retried
  // void on the same receipt is a no-op. We achieve this by
  // namespacing void idempotency keys with the `voidReceipt:` prefix
  // inside the calling mutation — but the lookup here is generic on
  // the key alone, so the namespacing is the caller's discipline.
  const existing = await ctx.db
    .query("payments")
    .withIndex("by_idempotency", (q) => q.eq("idempotencyKey", idempotencyKey))
    .unique();
  if (existing === null) {
    return null;
  }
  // Find the receipt that was issued for this payment. One-to-one;
  // `by_payment` returns a single row.
  const receipt = await ctx.db
    .query("receipts")
    .withIndex("by_payment", (q) => q.eq("paymentId", existing._id))
    .unique();
  if (receipt === null) {
    // Should be unreachable: the cornerstone writes payment+receipt
    // in the same transaction. If we ever see this, the system has
    // been tampered with — surface loudly.
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      "Idempotency hit on payment with no receipt — financial ledger corrupted.",
      { paymentId: existing._id, idempotencyKey },
    );
  }
  return {
    paymentId: existing._id,
    receiptId: receipt._id,
    receiptNumber: receipt.receiptNumber,
  };
}

/**
 * Hash-equivalent comparison for the idempotency same-key-same-payload
 * check. We compare the structural fingerprint of the new payload to
 * the previously-recorded payment + allocations.
 *
 * Pragmatic Phase-1 implementation: compare the payment's
 * `amountCents`, `paymentMethod`, `receivedAt`, and the sum +
 * length of the allocations array. A perfect canonical-JSON hash
 * would also walk each allocation's targetType / targetId / amount,
 * which we do here in a per-row check. This is the structural
 * "did the caller submit the same financial intent twice" check
 * without the cryptographic overhead a full SHA-256 hash would
 * imply.
 */
async function assertIdempotencyKeyMatchesPayload(
  ctx: MutationCtx,
  idempotencyKey: string,
  payment: PaymentDetailsInput,
  allocations: readonly AllocationInput[],
): Promise<void> {
  const existing = await ctx.db
    .query("payments")
    .withIndex("by_idempotency", (q) => q.eq("idempotencyKey", idempotencyKey))
    .unique();
  if (existing === null) {
    return;
  }
  if (
    existing.amountCents !== payment.amountCents ||
    existing.paymentMethod !== payment.paymentMethod ||
    existing.receivedAt !== payment.receivedAt ||
    // Epic 3 H2 — the fingerprint previously ignored these payment-level
    // fields, so a reused key with a CHANGED cheque/transfer reference,
    // contract, or customer silently returned the original receipt
    // instead of rejecting. A receipt carrying an unverifiable reference
    // is a BIR problem; compare them too. (`?? undefined` normalises the
    // optional-absent vs optional-present cases so two genuinely-equal
    // payloads don't false-trip.)
    (existing.reference ?? undefined) !== (payment.reference ?? undefined) ||
    (existing.contractId ?? undefined) !==
      (payment.contractId ?? undefined) ||
    (existing.customerId ?? undefined) !== (payment.customerId ?? undefined)
  ) {
    throwError(
      ErrorCode.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD,
      "Idempotency key was previously used with a different payment payload. Generate a new key.",
      { idempotencyKey },
    );
  }
  const existingAllocations = await ctx.db
    .query("paymentAllocations")
    .withIndex("by_payment", (q) => q.eq("paymentId", existing._id))
    .collect();
  if (existingAllocations.length !== allocations.length) {
    throwError(
      ErrorCode.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD,
      "Idempotency key was previously used with a different allocation count. Generate a new key.",
      { idempotencyKey },
    );
  }
  // Sort both sides by sequence to compare positionally. The caller
  // may supply allocations in any order; the cornerstone wrote them
  // with assigned sequence numbers, so we read by sequence and the
  // new payload by its supplied (or implicit) ordering.
  const existingBySequence = [...existingAllocations].sort(
    (a, b) => a.sequence - b.sequence,
  );
  const newOrdered = allocations.map((a, i) => ({
    ...a,
    sequence: a.sequence ?? i,
  }));
  newOrdered.sort((a, b) => a.sequence - b.sequence);
  for (let i = 0; i < newOrdered.length; i++) {
    const existingRow = existingBySequence[i]!;
    const newRow = newOrdered[i]!;
    if (
      existingRow.targetType !== newRow.targetType ||
      existingRow.targetId !== newRow.targetId ||
      existingRow.amountCents !== newRow.amountCents
    ) {
      throwError(
        ErrorCode.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD,
        "Idempotency key was previously used with a different allocation. Generate a new key.",
        { idempotencyKey, sequence: newRow.sequence },
      );
    }
  }
}

/**
 * Validates the allocations array shape and sum.
 *
 * Throws:
 *   - `EMPTY_ALLOCATIONS` — `allocations.length === 0`. The
 *     cornerstone refuses to record a payment with nothing to apply
 *     it to. A "deposit" with no destination is a category error
 *     the caller must resolve before invoking.
 *   - `INVARIANT_VIOLATION` — an allocation has non-integer or
 *     negative `amountCents`. Money math is integer-only (ADR-0007).
 *   - `ALLOCATION_SUM_MISMATCH` — sum(allocations) !==
 *     payment.amountCents. Structural defence against the
 *     month-end-reconciliation class of bugs.
 */
function assertAllocationsValid(
  payment: PaymentDetailsInput,
  allocations: readonly AllocationInput[],
): void {
  if (allocations.length === 0) {
    throwError(
      ErrorCode.EMPTY_ALLOCATIONS,
      "Payment must have at least one allocation.",
      { paymentAmountCents: payment.amountCents },
    );
  }
  if (
    !Number.isInteger(payment.amountCents) ||
    payment.amountCents < 0
  ) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      "payment.amountCents must be a non-negative integer.",
      { amountCents: payment.amountCents },
    );
  }
  let total = 0;
  for (let i = 0; i < allocations.length; i++) {
    const a = allocations[i]!;
    if (!Number.isInteger(a.amountCents) || a.amountCents < 0) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "allocation.amountCents must be a non-negative integer.",
        { sequence: a.sequence ?? i, amountCents: a.amountCents },
      );
    }
    total += a.amountCents;
  }
  if (total !== payment.amountCents) {
    throwError(
      ErrorCode.ALLOCATION_SUM_MISMATCH,
      `Sum of allocations (${total}) does not equal payment amount (${payment.amountCents}).`,
      { allocationsSum: total, paymentAmountCents: payment.amountCents },
    );
  }
}

/**
 * Maps a `FinancialEventKind` to the audit-log action vocabulary.
 *
 * `sale` and `payment` are both "create" events from the audit's POV —
 * a new receipt comes into existence. `void` maps to "void", which
 * is the dedicated audit action for receipt voids (FR29).
 */
function auditActionForKind(
  kind: Exclude<FinancialEventKind, "refund">,
): AuditAction {
  if (kind === "void") return "void";
  return "create";
}

/**
 * The cornerstone helper.
 *
 * Step ordering is LOCKED (architectural commitment from ADR-0012):
 *
 *   1. Validate the payload shape (allocations sum, non-empty, non-
 *      negative). Cheapest checks first; an invalid payload must not
 *      burn a serial.
 *
 *   2. Idempotency check. If the key has been used with the SAME
 *      payload, short-circuit and return the previously-issued
 *      receipt. If used with a DIFFERENT payload, throw.
 *
 *   3. Allocate the serial. ONLY now — after validation passes —
 *      do we touch the receipt counter. A rejected payload must not
 *      consume a serial (would be an audit-traceable gap, NFR-C1
 *      violation).
 *
 *   4. Insert the payment row.
 *
 *   5. Insert the receipt row (links to the payment via
 *      `paymentId`).
 *
 *   6. Insert each allocation row (links to the payment via
 *      `paymentId`).
 *
 *   7. Emit the audit row via `emitAudit` (Story 1.6 cornerstone —
 *      handles PII redaction + the controlled vocabulary).
 *
 *   8. Return `{ paymentId, receiptId, receiptNumber }`.
 *
 * The void path is a separate code path:
 *
 *   a. Validate the receipt is not already voided.
 *
 *   b. Patch the receipt: `{ isVoided: true, voidedAt, voidReason,
 *      voidedByUserId }`.
 *
 *   c. Patch the linked payment: same fields.
 *
 *   d. Emit the audit row with `action: "void"`.
 *
 *   e. Return `{ paymentId, receiptId, receiptNumber }` — the
 *      receipt's existing serial (FR29: no re-allocation).
 *
 * Atomicity: every step inside this function runs inside the
 * enclosing Convex mutation's transaction. A throw anywhere rolls
 * back ALL writes. There is no "almost-committed" state.
 */
export async function postFinancialEvent(
  ctx: MutationCtx,
  payload: PostFinancialEventPayload,
): Promise<PostFinancialEventResult> {
  // Refund: deferred to Epic 4. Phase 1 throws explicitly so the
  // caller's error path is exercised in tests + the missing feature
  // is loudly visible at runtime (rather than a silent no-op).
  if (payload.kind === "refund") {
    throwError(
      ErrorCode.NOT_IMPLEMENTED,
      "Refund flow lands in Epic 4 — Phase 1 callers must not invoke kind: 'refund'.",
    );
  }

  if (payload.kind === "void") {
    return await voidReceiptPath(ctx, payload);
  }

  // sale / payment: same code path, different audit action implied.
  return await createPaymentAndReceiptPath(ctx, payload);
}

async function createPaymentAndReceiptPath(
  ctx: MutationCtx,
  payload: {
    kind: "sale" | "payment";
    idempotencyKey: string;
    payment: PaymentDetailsInput;
    allocations: AllocationInput[];
  },
): Promise<PostFinancialEventResult> {
  // Step 1: Validate the payload shape. Cheapest checks first.
  assertAllocationsValid(payload.payment, payload.allocations);

  // Step 2a: Idempotency short-circuit. Same key + same payload =>
  // return the previously-issued receipt without writing anything new.
  // Same key + different payload => throw IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD.
  await assertIdempotencyKeyMatchesPayload(
    ctx,
    payload.idempotencyKey,
    payload.payment,
    payload.allocations,
  );
  const idempotentHit = await lookupIdempotentResult(ctx, payload.idempotencyKey);
  if (idempotentHit !== null) {
    return idempotentHit;
  }

  // Step 3: Allocate the serial. Only after validation passes.
  const { serial, formatted } = await allocateNextSerial(ctx);
  // Capture the prefix portion of the formatted string — i.e. everything
  // before the final 7-digit run. Used to persist the `receiptSeries`
  // field on the receipt row for audit-export self-containment.
  const series = formatted.slice(0, formatted.length - 7);

  // Step 4: Insert the payment row.
  const paymentId = await ctx.db.insert("payments", {
    paymentNumber: formatted,
    contractId: payload.payment.contractId,
    customerId: payload.payment.customerId,
    amountCents: payload.payment.amountCents,
    paymentMethod: payload.payment.paymentMethod,
    reference: payload.payment.reference,
    receivedAt: payload.payment.receivedAt,
    receivedByUserId: payload.payment.receivedByUserId,
    idempotencyKey: payload.idempotencyKey,
    isVoided: false,
  });

  // Step 5: Insert the receipt row.
  const receiptId = await ctx.db.insert("receipts", {
    paymentId,
    receiptSeries: series,
    receiptNumber: formatted,
    receiptSerial: serial,
    contractId: payload.payment.contractId,
    customerId: payload.payment.customerId,
    amountCents: payload.payment.amountCents,
    issuedAt: payload.payment.receivedAt,
    issuedByUserId: payload.payment.receivedByUserId,
    isVoided: false,
  });

  // Step 6: Insert allocation rows. Sequence is assigned in caller-
  // supplied order (or implicit index order if the caller did not
  // supply per-row sequence numbers).
  for (let i = 0; i < payload.allocations.length; i++) {
    const a = payload.allocations[i]!;
    await ctx.db.insert("paymentAllocations", {
      paymentId,
      targetType: a.targetType,
      targetId: a.targetId,
      amountCents: a.amountCents,
      sequence: a.sequence ?? i,
      note: a.note,
    });
  }

  // Step 7: Emit audit. The entityType is "receipt" — the receipt is
  // the canonical record of the financial event; payment + allocations
  // are details. The audit's `entityId` resolves to the receipt; the
  // payment id is included in the `after` snapshot for forensic reach.
  const auditEntityType: AuditEntityType = "receipt";
  await emitAudit(ctx, {
    action: auditActionForKind(payload.kind),
    entityType: auditEntityType,
    entityId: receiptId,
    after: {
      kind: payload.kind,
      receiptNumber: formatted,
      receiptSerial: serial,
      paymentId,
      paymentAmountCents: payload.payment.amountCents,
      paymentMethod: payload.payment.paymentMethod,
      allocationCount: payload.allocations.length,
    },
  });

  // Step 8: Return.
  return { paymentId, receiptId, receiptNumber: formatted };
}

async function voidReceiptPath(
  ctx: MutationCtx,
  payload: {
    kind: "void";
    idempotencyKey: string;
    receiptId: ReceiptId;
    voidReason: string;
    voidedByUserId: UserId;
    voidedAt: number;
  },
): Promise<PostFinancialEventResult> {
  // Step a: Load the receipt and validate it is not already voided.
  const receipt = await ctx.db.get(payload.receiptId);
  if (receipt === null) {
    throwError(
      ErrorCode.NOT_FOUND,
      "Receipt not found.",
      { receiptId: payload.receiptId },
    );
  }
  if (receipt.isVoided === true) {
    // Epic 3 H1 — idempotent void retry. A void that already committed
    // with the SAME reason + actor is a safe re-delivery (network retry,
    // refresh after a committed-but-unacknowledged void, double submit):
    // return the prior result instead of throwing, honoring the
    // cornerstone's documented idempotency contract. A void recorded with
    // a DIFFERENT reason or by a different actor is a genuine conflict and
    // still rejects.
    if (
      receipt.voidReason === payload.voidReason &&
      receipt.voidedByUserId === payload.voidedByUserId
    ) {
      return {
        paymentId: receipt.paymentId,
        receiptId: payload.receiptId,
        receiptNumber: receipt.receiptNumber,
      };
    }
    throwError(
      ErrorCode.RECEIPT_VOIDED,
      "Receipt is already voided.",
      { receiptId: payload.receiptId },
    );
  }

  // Step b: Patch the receipt. NB: we do NOT call `allocateNextSerial`
  // here — voids consume the original serial (FR29).
  await ctx.db.patch(payload.receiptId, {
    isVoided: true,
    voidedAt: payload.voidedAt,
    voidReason: payload.voidReason,
    voidedByUserId: payload.voidedByUserId,
  });

  // Step c: Patch the linked payment.
  const payment = await ctx.db.get(receipt.paymentId);
  await ctx.db.patch(receipt.paymentId, {
    isVoided: true,
    voidedAt: payload.voidedAt,
    voidReason: payload.voidReason,
    voidedByUserId: payload.voidedByUserId,
  });

  // ------------------------------------------------------------------
  // Step c.1 — void-chain compensating writes (Stories 3.2 + 3.7 + 3.12,
  // post-Epic-3/4 adversarial-review fix). The original Story 3.12 ship
  // patched only the void flags and left financial state untouched: the
  // installment paidCents totals, contract perpetualCarePaidCents tally,
  // and (when it exists) contract outstandingBalanceCents all kept the
  // voided payment's contribution. The result was a silently-wrong AR
  // aging report and trial balance after every void.
  //
  // This block walks the voided payment's allocations and reverses
  // each one in the same mutation transaction so the void is
  // financially complete:
  //   - installment allocations  → decrement paidCents + recompute
  //                                 status ("paid" → "partial"/"open").
  //   - perpetualCare allocations → decrement contracts.perpetualCarePaidCents
  //                                 when the field is present (defensive
  //                                 — pre-Story 3.8 contract rows may
  //                                 not carry it).
  //   - contract allocations      → no-op here; the contract's
  //                                 outstandingBalanceCents would be
  //                                 patched if the field existed in the
  //                                 schema. The current schema does NOT
  //                                 carry an inline outstanding balance
  //                                 (per reconciliation.ts' Scope
  //                                 Deviation note — Story 5.5 reads
  //                                 outstanding by summing
  //                                 installments.paidCents on demand,
  //                                 NOT from a pre-aggregated field).
  //                                 The installment reversal above
  //                                 therefore correctly drives the
  //                                 derived outstanding back up.
  //
  // Audit: a single `void_compensation` audit row is emitted summarising
  // the per-installment / per-perpetual-care reversals. The cornerstone's
  // existing `void`-action receipt audit row continues to fire below;
  // the compensation row is a separate, greppable forensic trail.
  // ------------------------------------------------------------------
  const allocations = await ctx.db
    .query("paymentAllocations")
    .withIndex("by_payment", (q) => q.eq("paymentId", receipt.paymentId))
    .collect();

  interface InstallmentReversal {
    installmentId: string;
    amountCents: number;
    paidCentsBefore: number;
    paidCentsAfter: number;
    statusBefore: string;
    statusAfter: string;
  }
  interface PerpetualCareReversal {
    contractId: string;
    amountCents: number;
    perpetualCarePaidBefore: number;
    perpetualCarePaidAfter: number;
  }
  const installmentReversals: InstallmentReversal[] = [];
  const perpetualCareReversals: PerpetualCareReversal[] = [];
  // Every contract this voided payment touched — via installment
  // allocations (installment.contractId), perpetual-care / contract
  // allocations (targetId is the contractId), and the payment's own
  // contractId. After the reversal loop we walk this set and revert any
  // contract still sitting in the terminal `paid_in_full` state back to
  // `active` (Epic 3 C1) — the payment that closed it is now void.
  const affectedContractIds = new Set<string>();
  if (payment?.contractId != null) {
    affectedContractIds.add(payment.contractId as unknown as string);
  }

  for (const alloc of allocations) {
    if (alloc.targetType === "installment") {
      const installmentDoc = (await ctx.db.get(
        alloc.targetId as DataModel["installments"]["document"]["_id"],
      )) as DataModel["installments"]["document"] | null;
      if (installmentDoc === null) {
        // Defensive: an installment row was deleted out from under the
        // allocation. We skip rather than throw — the financial trail
        // is the cornerstone-anchored allocations + audit log; the
        // missing installment is a separate data-integrity bug surfaced
        // by `convex/reconciliation.ts`.
        continue;
      }
      affectedContractIds.add(installmentDoc.contractId as unknown as string);
      const paidCentsBefore = installmentDoc.paidCents;
      // Floor at 0 to prevent a tampered allocation set driving paidCents
      // negative. An over-reversal would itself be a programming bug;
      // we record the clamped value in the audit row for forensics.
      const paidCentsAfter = Math.max(0, paidCentsBefore - alloc.amountCents);
      // Recompute status from the new paidCents.
      //   paidCents == 0                     → "pending" (the schema's
      //                                         "open" equivalent — the
      //                                         `installments.status`
      //                                         validator union is
      //                                         pending|paid|overdue|waived;
      //                                         "open" is not in the
      //                                         vocabulary — pending is
      //                                         the cornerstone's fresh-
      //                                         insert default).
      //   0 < paidCents < principalCents     → "pending" (Phase 1 schema
      //                                         has no "partial" literal;
      //                                         the dashboard derives
      //                                         partial-paid via
      //                                         `paidCents > 0 && < principalCents`).
      //   paidCents == principalCents        → "paid"
      // The void-chain fix intentionally maps to the existing literal
      // union; promoting "partial" / "open" to first-class statuses is
      // a separate schema story (deferred — keeps this fix surface-
      // narrow and avoids the schema migration owned by other CRITs).
      let statusAfter: "pending" | "paid" | "overdue" | "waived";
      if (paidCentsAfter >= installmentDoc.principalCents) {
        statusAfter = "paid";
      } else {
        // Preserve `overdue` / `waived` semantics if they applied
        // before — voiding a payment shouldn't accidentally clear an
        // overdue flag. We only flip away from `paid` toward `pending`.
        if (
          installmentDoc.status === "overdue" ||
          installmentDoc.status === "waived"
        ) {
          statusAfter = installmentDoc.status;
        } else {
          statusAfter = "pending";
        }
      }
      // void-chain restoration: reverses paidCents AND derives installment
      // status from the new paid total. (No eslint-disable needed: this
      // file now imports from ./stateMachines for the contract-state
      // reversal below, so no-raw-status-patch trusts the whole module.)
      await ctx.db.patch(installmentDoc._id, {
        paidCents: paidCentsAfter,
        status: statusAfter,
      });
      installmentReversals.push({
        installmentId: installmentDoc._id as unknown as string,
        amountCents: alloc.amountCents,
        paidCentsBefore,
        paidCentsAfter,
        statusBefore: installmentDoc.status,
        statusAfter,
      });
    } else if (alloc.targetType === "perpetualCare") {
      // The allocation's `targetId` for a perpetual-care allocation is
      // the contract id (perpetual care lives as a per-contract running
      // tally, not as a per-row table). Defensive: only patch when the
      // contract row actually carries `perpetualCarePaidCents` — pre-
      // Story 3.8 contract rows did not carry the column, and Story 3.8
      // wrote it on every new contract. A void of a pre-3.8 payment
      // (vanishingly rare in practice) would skip this branch.
      const contractDoc = (await ctx.db.get(
        alloc.targetId as DataModel["contracts"]["document"]["_id"],
      )) as DataModel["contracts"]["document"] | null;
      if (contractDoc === null) continue;
      affectedContractIds.add(contractDoc._id as unknown as string);
      if (typeof contractDoc.perpetualCarePaidCents !== "number") continue;
      const before = contractDoc.perpetualCarePaidCents;
      const after = Math.max(0, before - alloc.amountCents);
      await ctx.db.patch(contractDoc._id, { perpetualCarePaidCents: after });
      perpetualCareReversals.push({
        contractId: contractDoc._id as unknown as string,
        amountCents: alloc.amountCents,
        perpetualCarePaidBefore: before,
        perpetualCarePaidAfter: after,
      });
    }
    // `contract` and `credit` targetTypes do not move per-row financial
    // state here, but a `contract` allocation (the full-payment-sale
    // shape) DOES tell us which contract this payment closed — record it
    // so the paid_in_full→active reversal below fires:
    // - `contract` allocations: the per-contract `outstandingBalanceCents`
    //   field is NOT in the current schema (the system derives
    //   outstanding from installments on demand — see reconciliation.ts).
    //   When the field lands in a future schema story, an analogous
    //   `if (typeof contractDoc.outstandingBalanceCents === "number")`
    //   patch belongs here. We still capture the contractId for the state
    //   reversal.
    // - `credit` allocations: a customer credit is a separate ledger
    //   concern; reversing it is a Phase-2 refund-flow story (Epic 4+).
    if (alloc.targetType === "contract") {
      affectedContractIds.add(alloc.targetId as unknown as string);
    }
  }

  // ------------------------------------------------------------------
  // Step c.3 — contract-state reversal (Epic 3 C1 fix). A receipt void
  // that removes the payment which closed a contract's balance must take
  // the contract OUT of the terminal `paid_in_full` state, or it is
  // stranded forever: paid_in_full has no outgoing edges, the lot stays
  // `sold` and can never be reclaimed, and revenue/AR reports keep
  // counting a sale whose only receipt is voided. We revert to `active`
  // (the schema-legal reversal edge added in stateMachines.ts) so an
  // admin can re-collect or void the contract to release the lot. We
  // only touch contracts that are CURRENTLY paid_in_full — an installment
  // contract that was still `active` stays active (its installment
  // paidCents were already rewound above); a contract already voided /
  // cancelled is left alone.
  // ------------------------------------------------------------------
  const contractReversals: Array<{ contractId: string }> = [];
  for (const contractIdStr of affectedContractIds) {
    const contractDoc = (await ctx.db.get(
      contractIdStr as DataModel["contracts"]["document"]["_id"],
    )) as DataModel["contracts"]["document"] | null;
    if (contractDoc === null) continue;
    if (contractDoc.state !== "paid_in_full") continue;
    // Validate the edge through the same guard every other transition
    // uses; the reason flows into the audit trail (FR-forensic).
    assertTransition({
      entityType: "contract",
      from: "paid_in_full",
      to: "active",
      reason: `receipt-void reversal: ${payload.voidReason}`,
    });
    // receipt-void reversal: guarded by assertTransition immediately
    // above + audited below. transitionContractState lives in
    // contracts.ts and importing it here would be a circular dependency,
    // so we apply the guarded patch inline.
    await ctx.db.patch(contractDoc._id, {
      state: "active",
    });
    await emitAudit(ctx, {
      action: "update",
      entityType: "contract",
      entityId: contractDoc._id as unknown as string,
      before: { state: "paid_in_full" },
      after: { state: "active" },
      reason: `receipt-void reversal (paid_in_full→active): ${payload.voidReason}`,
    });
    contractReversals.push({
      contractId: contractDoc._id as unknown as string,
    });
  }

  // Step c.2 — emit a single `void_compensation`-flavoured audit row
  // anchored to the voided receipt summarising the reversals. We use the
  // existing `"update"` AuditAction (the controlled enum does not
  // include a dedicated `void_compensation` literal) with a descriptive
  // `reason` prefix so audit queries can grep `void_compensation:` to
  // surface every compensating reversal. This pairs with the cornerstone's
  // own `void` audit row below — together they tell the full story:
  // "this receipt was voided AND here is what financial state moved as
  // a consequence".
  if (
    installmentReversals.length > 0 ||
    perpetualCareReversals.length > 0
  ) {
    await emitAudit(ctx, {
      action: "update",
      entityType: "receipt",
      entityId: payload.receiptId,
      before: {
        installmentsTouched: installmentReversals.map((r) => r.installmentId),
        contractsTouched: perpetualCareReversals.map((r) => r.contractId),
      },
      after: {
        installmentReversals: installmentReversals.map((r) => ({
          installmentId: r.installmentId,
          amountCents: r.amountCents,
          paidCentsBefore: r.paidCentsBefore,
          paidCentsAfter: r.paidCentsAfter,
          statusBefore: r.statusBefore,
          statusAfter: r.statusAfter,
        })),
        perpetualCareReversals: perpetualCareReversals.map((r) => ({
          contractId: r.contractId,
          amountCents: r.amountCents,
          perpetualCarePaidBefore: r.perpetualCarePaidBefore,
          perpetualCarePaidAfter: r.perpetualCarePaidAfter,
        })),
        paymentId: receipt.paymentId,
        paymentAmountCents: payment?.amountCents ?? null,
      },
      reason: `void_compensation: ${payload.voidReason}`,
    });
  }

  // Step d: Emit audit with action "void".
  await emitAudit(ctx, {
    action: "void",
    entityType: "receipt",
    entityId: payload.receiptId,
    before: { isVoided: false },
    after: {
      isVoided: true,
      voidedAt: payload.voidedAt,
      receiptNumber: receipt.receiptNumber,
      receiptSerial: receipt.receiptSerial,
      paymentId: receipt.paymentId,
      // Contracts taken out of `paid_in_full` by this void (Epic 3 C1).
      contractsRevertedToActive: contractReversals.map((r) => r.contractId),
    },
    reason: payload.voidReason,
  });

  // Step e: Return the existing serial — NOT re-allocated.
  return {
    paymentId: receipt.paymentId,
    receiptId: payload.receiptId,
    receiptNumber: receipt.receiptNumber,
  };
}

// Re-export for backward compatibility with the Story 3.1 scaffold's
// public surface — `convex/lib/postFinancialEvent.ts` was the
// designated import point for `allocateNextSerial` long before
// `postFinancialEvent` itself existed.
export { allocateNextSerial, formatSerial };
