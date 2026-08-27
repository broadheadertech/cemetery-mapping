import { ConvexError, type Value } from "convex/values";

/**
 * Canonical error codes for the Income & Expense Tracker.
 *
 * Every server-thrown error uses one of these. The client error layer
 * maps codes to user-readable sentences — raw codes never appear in UI
 * text, and raw messages never reveal whether a record exists.
 *
 * Why a code enum rather than `throw new Error("...")`: an `Error`
 * crosses the Convex client boundary as an opaque string and loses the
 * discriminator, so the UI cannot tell "you are not allowed" from "that
 * day is closed" and has to string-match. See `throwError` below.
 */
export const ErrorCode = {
  // --- auth / access ---
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  INVALID_ROLE: "INVALID_ROLE",
  NO_TENANT: "NO_TENANT",
  /**
   * Payroll and government contributions are access-restricted
   * (taxonomy §4). Distinct from FORBIDDEN so the UI can hide the row
   * entirely rather than showing a denied action.
   */
  RESTRICTED_CATEGORY: "RESTRICTED_CATEGORY",

  // --- generic ---
  NOT_FOUND: "NOT_FOUND",
  VALIDATION: "VALIDATION",
  /**
   * A rule this system considers structurally impossible was violated.
   * If one of these reaches a user, we have a bug, not a bad input.
   */
  INVARIANT_VIOLATION: "INVARIANT_VIOLATION",

  // --- money / ledger (taxonomy §11.1) ---
  /**
   * A write was attempted against a sealed day (taxonomy §10). The
   * caller should re-post to the open day carrying
   * `originalOccurredOn`; `postMovement` does this automatically, so
   * this code only escapes when a caller explicitly pinned a date.
   */
  DAY_SEALED: "DAY_SEALED",
  /** An attempt to mutate an append-only row. Always a programming bug. */
  APPEND_ONLY_VIOLATION: "APPEND_ONLY_VIOLATION",
  /**
   * The same idempotency key arrived with a different payload. A repeat
   * of the SAME payload is safe and returns the original row; a
   * different payload under the same key means the key was reused with
   * different financial intent. Surface loudly, never silently dedupe.
   */
  IDEMPOTENCY_KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",
  /**
   * `categories.treatment` disagrees with the movement's `direction` —
   * e.g. a `revenue` category on a cash-out. Taxonomy §3's warning
   * about capital injections inflating revenue is this check's reason
   * for existing.
   */
  TREATMENT_DIRECTION_MISMATCH: "TREATMENT_DIRECTION_MISMATCH",

  // --- advances (taxonomy §6) ---
  /** Liquidating more than was released. */
  ADVANCE_OVER_LIQUIDATED: "ADVANCE_OVER_LIQUIDATED",
  /** Any write against an advance already at zero balance. */
  ADVANCE_CLOSED: "ADVANCE_CLOSED",
  /**
   * A liquidation line named a category with
   * `allowedInLiquidation: false` (taxonomy §6.4).
   */
  CATEGORY_NOT_LIQUIDATABLE: "CATEGORY_NOT_LIQUIDATABLE",

  // --- cheques (taxonomy §7.1) ---
  /**
   * `chequeNo` already exists for this bank account. Convex has no
   * unique index, so this is thrown by the helper that owns the check.
   */
  DUPLICATE_CHEQUE_NO: "DUPLICATE_CHEQUE_NO",
  ILLEGAL_STATE_TRANSITION: "ILLEGAL_STATE_TRANSITION",

  // --- schedules (taxonomy §8) ---
  /** An edit was attempted on a schedule version in place. */
  SCHEDULE_NOT_AMENDABLE: "SCHEDULE_NOT_AMENDABLE",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * The JSON-compatible bag callers may attach for debugging and audit.
 * Client code reads named fields out and never blindly trusts the shape.
 */
export type ErrorDetails = { [key: string]: Value };

export interface ErrorPayload {
  code: ErrorCodeValue;
  message: string;
  details?: ErrorDetails;
}

/**
 * Throws a ConvexError carrying the discriminated payload the client
 * error layer expects. Always use this — never `throw new Error(...)`
 * inside a Convex function.
 */
export function throwError(
  code: ErrorCodeValue,
  message: string,
  details?: ErrorDetails,
): never {
  throw new ConvexError({ code, message, details });
}
