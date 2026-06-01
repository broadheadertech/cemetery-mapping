import { ConvexError, type Value } from "convex/values";

/**
 * Canonical error code constants for cemetery-mapping.
 *
 * Every server-thrown error MUST use one of these codes. The client
 * error-translation layer (lands in Story 1.4/1.5) maps these codes to
 * user-readable sentences — raw codes never appear in UI text, and raw
 * messages never reveal whether a record exists.
 *
 * Story 1.2 introduces the first four: UNAUTHENTICATED, FORBIDDEN,
 * INVALID_ROLE, SESSION_EXPIRED. The remaining codes are reserved here
 * to keep the namespace stable as later stories land their helpers
 * (1.7 state machines → ILLEGAL_STATE_TRANSITION; 3.x postFinancialEvent
 * → INVARIANT_VIOLATION).
 */
export const ErrorCode = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  INVALID_ROLE: "INVALID_ROLE",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  ILLEGAL_STATE_TRANSITION: "ILLEGAL_STATE_TRANSITION",
  INVARIANT_VIOLATION: "INVARIANT_VIOLATION",
  // Story 1.8 — lot CRUD codes.
  // NOT_FOUND is also consumed by transitionLotStatus (Story 1.7's
  // domain helper) once Story 1.8 fills its body.
  NOT_FOUND: "NOT_FOUND",
  CANNOT_RETIRE_WITH_HISTORY: "CANNOT_RETIRE_WITH_HISTORY",
  DUPLICATE_CODE: "DUPLICATE_CODE",
  VALIDATION: "VALIDATION",
  // Story 2.1 — customer-domain codes.
  // CUSTOMER_CONSENT_INVARIANT fires when a `customers.create` /
  // `customers.update` mutation receives `hasConsent: false` but
  // somehow also receives a `consentTimestamp` or
  // `consentCapturedByUserId` (the public arg surface doesn't accept
  // those today; this is the defense-in-depth invariant for an
  // internal-write path or a future hand-crafted args object that
  // bypasses Zod). See `convex/customers.ts:create`.
  //
  // CUSTOMER_DUPLICATE_GOV_ID is reserved for Story 2.7's transfer
  // flow — Story 2.1's dedupe is advisory (returned in the
  // `searchByName` query result), not blocking. The code is reserved
  // here so the future blocking path doesn't reshape the enum.
  CUSTOMER_CONSENT_INVARIANT: "CUSTOMER_CONSENT_INVARIANT",
  CUSTOMER_DUPLICATE_GOV_ID: "CUSTOMER_DUPLICATE_GOV_ID",
  // Story 3.2 — postFinancialEvent cornerstone codes.
  //
  // ALLOCATION_SUM_MISMATCH fires when the sum of a payment's
  // `paymentAllocations[].amountCents` does not equal the payment's
  // `amountCents`. The cornerstone refuses to write a partial
  // allocation set — every centavo of a payment must be accounted for
  // (or the payment must be rejected). This is the structural defence
  // against a class of bookkeeping bugs that would otherwise only
  // surface at month-end reconciliation. See ADR-0012.
  //
  // EMPTY_ALLOCATIONS fires when the caller passes a payment with
  // zero allocations. The cornerstone deliberately requires at least
  // one — a "payment with nothing to apply it to" is a category error
  // the caller (Story 3.3 / 3.9 / 3.12) MUST resolve before invoking.
  //
  // IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD per NFR-R5 / Story
  // 3.2 AC3: a client may safely re-submit the SAME payload under the
  // SAME idempotency key (browser refresh after submit, double-click
  // submit). Re-submitting a DIFFERENT payload under the same key is
  // a programming bug — the same UUID was reused with different
  // financial intent. Surface loudly; do not silently dedupe.
  //
  // RECEIPT_VOIDED fires when the void path is asked to void an
  // already-voided receipt. The receipt state machine in
  // `stateMachines.ts` would also reject this via
  // ILLEGAL_STATE_TRANSITION; the dedicated code lets the calling
  // mutation distinguish "void of already-voided" from the more
  // general state-machine rejection if it cares to.
  //
  // NOT_IMPLEMENTED is the Phase-1 fallback for `kind: "refund"`,
  // deferred to Epic 4. The cornerstone accepts the payload shape so
  // the discriminated union typechecks; the body throws.
  ALLOCATION_SUM_MISMATCH: "ALLOCATION_SUM_MISMATCH",
  EMPTY_ALLOCATIONS: "EMPTY_ALLOCATIONS",
  IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD:
    "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
  RECEIPT_VOIDED: "RECEIPT_VOIDED",
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
  // Story 3.4 — installment-sale defensive codes (Epic-3/4 adversarial-
  // review HIGH fix).
  //
  // ZERO_DOWN_NOT_SUPPORTED fires when a caller invokes
  // `recordInstallmentSale` with `downPaymentCents === 0` AND no
  // perpetual-care fee that would bundle into the down payment. The
  // dedupe path in `recordInstallmentSale` pivots on
  // `payments.by_idempotency`, which a zero-down sale never writes —
  // double-clicking submit therefore produces duplicate contracts. Until
  // a dedicated dedup table lands, zero-down installments are rejected
  // outright with this code.
  //
  // SCHEDULE_TAMPERED fires when the client-supplied installment
  // schedule does not match the server-side re-derivation (defense in
  // depth — a hostile client could otherwise supply due dates years in
  // the future). Details carry the first mismatch row + the server's
  // expected value for fast triage.
  ZERO_DOWN_NOT_SUPPORTED: "ZERO_DOWN_NOT_SUPPORTED",
  SCHEDULE_TAMPERED: "SCHEDULE_TAMPERED",
  // Story 7.2 — interment double-booking specifics (Epic-7 adversarial-
  // review HIGH fix).
  //
  // The original Story 7.2 implementation collapsed both conflict
  // shapes into a generic `INVARIANT_VIOLATION`, which prevented the
  // UI from switching on the failure reason. AC1/AC2 of the story
  // mandate distinct codes so the operator-facing error message can
  // distinguish "the same lot is already booked at this time" from
  // "a different lot's interment is busy at this time" (single-crew
  // assumption).
  //
  // - LOT_ALREADY_SCHEDULED fires when the new booking's window
  //   overlaps an existing scheduled interment AT THE SAME LOT.
  //   `details.conflictingIds` carries the conflicting interment ids.
  //
  // - TIMESLOT_ALREADY_BOOKED fires when the new booking's window
  //   overlaps an existing scheduled interment AT A DIFFERENT LOT.
  //   The cemetery is staffed by a single interment crew at a time
  //   (the "single-crew assumption" — load-bearing per the story).
  //   The check can be relaxed by setting the cemetery-settings
  //   `interments.allowConcurrent` flag to `true` once a second crew
  //   is hired. `details.conflictingIds` carries the conflicting ids.
  //
  // Both codes carry `conflictingIds: string[]` and `conflictWindowMs`
  // in `details`. The split is additive — existing callers that
  // switch on `INVARIANT_VIOLATION` still see those code paths; the
  // new codes are surfaced to UIs that want the finer signal.
  LOT_ALREADY_SCHEDULED: "LOT_ALREADY_SCHEDULED",
  TIMESLOT_ALREADY_BOOKED: "TIMESLOT_ALREADY_BOOKED",
  // Story 7.5 — ceremony scheduling conflict (kind-agnostic). Thrown by
  // `convex/lib/scheduling.ts:assertNoBookingConflict` when a new
  // ceremony's [scheduledAt, scheduledAt + durationMinutes) window
  // overlaps an existing scheduled row on the SAME lot OR (for chapel /
  // pathway reservations) the SAME singleton shared resource. The error
  // payload carries `resource: "lot" | "chapel" | "pathway"` so the UI
  // can render a resource-named banner.
  SCHEDULING_CONFLICT: "SCHEDULING_CONFLICT",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Convex's `Value` type is the JSON-compatible recursive shape that
 * `ConvexError` carries across the client boundary. `ErrorDetails` is
 * the loosely-typed bag callers can attach for audit / debugging
 * purposes; client-side error-handling code reads named fields out and
 * never blindly trusts the shape.
 */
export type ErrorDetails = { [key: string]: Value };

export interface ErrorPayload {
  code: ErrorCodeValue;
  message: string;
  details?: ErrorDetails;
}

/**
 * Throws a ConvexError with the discriminated payload shape the client
 * error layer expects. Always use this — never `throw new Error(...)`
 * inside a Convex function, because `Error` payloads cross the client
 * boundary as opaque strings and lose the `code` discriminator.
 */
export function throwError(
  code: ErrorCodeValue,
  message: string,
  details?: ErrorDetails,
): never {
  throw new ConvexError({ code, message, details });
}
