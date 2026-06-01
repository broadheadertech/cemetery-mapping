/**
 * Client-side error translation.
 *
 * Mirrors the server `ConvexError` codes from `convex/lib/errors.ts`
 * (Story 1.2) into user-facing copy. The mirror is deliberate: the
 * client bundle must not import from `convex/lib/**` (server-internal),
 * and the user-facing copy evolves independently from the server's
 * machine-readable code values.
 *
 * If a new code is added on the server side, add it here too. The two
 * files stay in sync by convention. The default branch covers anything
 * unrecognised — Mr. Reyes / Maria should never see a raw Convex stack
 * trace in the UI.
 *
 * UX § Feedback Patterns: 1-sentence user-facing copy. No exclamation
 * marks, no apologies. Tells the user what to do next where applicable.
 */

/**
 * Known error code values. Mirror of the server-side `ErrorCode` from
 * `convex/lib/errors.ts`. Treat as a closed enum on the server; on the
 * client the type is widened to `string` because the wire format is a
 * string and a future server release may add a code we don't yet know.
 */
export const CLIENT_ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  INVALID_ROLE: "INVALID_ROLE",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  ILLEGAL_STATE_TRANSITION: "ILLEGAL_STATE_TRANSITION",
  INVARIANT_VIOLATION: "INVARIANT_VIOLATION",
  // Story 1.8 — lot CRUD codes mirrored from `convex/lib/errors.ts`.
  NOT_FOUND: "NOT_FOUND",
  CANNOT_RETIRE_WITH_HISTORY: "CANNOT_RETIRE_WITH_HISTORY",
  DUPLICATE_CODE: "DUPLICATE_CODE",
  VALIDATION: "VALIDATION",
  // Story 1.13 — client-only code. The server never throws this; the
  // `useNetworkAwareMutation` wrapper short-circuits before a request
  // is dispatched. Mirrored on the server in a later story (defense in
  // depth) so a stray request still fails fast.
  OFFLINE_WRITE_BLOCKED: "OFFLINE_WRITE_BLOCKED",
  // Story 7.5 — ceremony scheduling conflict (kind-agnostic lot
  // overlap + chapel + pathway overlap). Mirrored from
  // `convex/lib/errors.ts:SCHEDULING_CONFLICT`.
  SCHEDULING_CONFLICT: "SCHEDULING_CONFLICT",
} as const;

export type ClientErrorCode =
  (typeof CLIENT_ERROR_CODES)[keyof typeof CLIENT_ERROR_CODES];

export interface TranslatedError {
  /** Short headline for toast / inline header. */
  headline: string;
  /** One-sentence explanation + suggested next action. */
  detail: string;
  /** Whether the action that produced this error is worth retrying. */
  retryable: boolean;
}

const MESSAGES: Record<ClientErrorCode, TranslatedError> = {
  UNAUTHENTICATED: {
    headline: "Sign in to continue",
    detail: "Your session has ended. Sign in again to resume.",
    retryable: false,
  },
  FORBIDDEN: {
    headline: "Action not permitted",
    detail: "Your role does not permit this action. Ask an admin for access.",
    retryable: false,
  },
  INVALID_ROLE: {
    headline: "Account role missing",
    detail:
      "Your account does not have a role assigned. Ask an admin to assign one.",
    retryable: false,
  },
  SESSION_EXPIRED: {
    headline: "Session expired",
    detail: "Sign in again to continue where you left off.",
    retryable: false,
  },
  ILLEGAL_STATE_TRANSITION: {
    headline: "That step is not allowed",
    detail:
      "The record cannot move to that state from its current state. Refresh and try again.",
    retryable: true,
  },
  INVARIANT_VIOLATION: {
    headline: "The system caught a data inconsistency",
    detail:
      "This action was blocked to protect record integrity. Contact support if it persists.",
    retryable: false,
  },
  NOT_FOUND: {
    headline: "Record not found",
    detail: "We couldn't find that record. It may have been deleted.",
    retryable: false,
  },
  CANNOT_RETIRE_WITH_HISTORY: {
    headline: "Cannot retire this lot",
    detail:
      "This lot has sales or payment history and cannot be retired. Transfer ownership or cancel contracts first.",
    retryable: false,
  },
  DUPLICATE_CODE: {
    headline: "Lot code already exists",
    detail: "A lot with that code already exists. Pick a unique code.",
    retryable: false,
  },
  VALIDATION: {
    headline: "Please check the form",
    detail: "Some fields need attention before this can be saved.",
    retryable: false,
  },
  OFFLINE_WRITE_BLOCKED: {
    headline: "No connection",
    detail: "Posting requires connection. Reconnect and try again.",
    retryable: true,
  },
  SCHEDULING_CONFLICT: {
    headline: "Booking conflict",
    detail:
      "Another ceremony already uses this lot, chapel, or pathway in that window. Pick a different time or release the resource.",
    retryable: false,
  },
};

const FALLBACK: TranslatedError = {
  headline: "Something went wrong",
  detail: "Please try again or contact support.",
  retryable: true,
};

/**
 * Extract a known error code from an unknown thrown value.
 *
 * Convex Auth + the ConvexError wrapper on the server stringify the
 * code into the error message. We try the structured `data` first
 * (modern Convex client surfaces it), then fall back to a regex on
 * the message.
 */
function extractCode(error: unknown): string | null {
  if (!error) return null;

  // Convex `ConvexError` instances expose `.data` with the original
  // payload. We don't have @types for it on the client; narrow safely.
  if (typeof error === "object" && error !== null) {
    const maybe = error as { data?: unknown; message?: unknown };
    if (
      typeof maybe.data === "object" &&
      maybe.data !== null &&
      "code" in maybe.data
    ) {
      const code = (maybe.data as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
    if (typeof maybe.data === "string") return maybe.data;
    if (typeof maybe.message === "string") {
      const match = maybe.message.match(/\b([A-Z_]{4,})\b/);
      if (match && match[1]) return match[1];
    }
  }

  if (typeof error === "string") {
    const match = error.match(/\b([A-Z_]{4,})\b/);
    if (match && match[1]) return match[1];
  }

  return null;
}

/**
 * Translate any thrown value into a user-facing message.
 *
 * Safe to call on `unknown` — never throws. Unknown codes fall back to
 * the generic FALLBACK message. Tests in `tests/unit/lib/errors.test.ts`
 * cover every defined code.
 */
export function translateError(error: unknown): TranslatedError {
  const code = extractCode(error);
  if (code && code in MESSAGES) {
    return MESSAGES[code as ClientErrorCode];
  }
  return FALLBACK;
}
