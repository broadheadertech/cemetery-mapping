/**
 * BIR receipt serial counter — Story 3.1 (FR28 / FR29 / NFR-C1).
 *
 * Strict monotonic, gap-free, unique-across-the-cemetery's-lifetime serial
 * numbers. This file owns the single point of allocation. The contract is
 * non-negotiable: every BIR receipt ever issued carries a serial produced
 * here, and no other code path may read or write the `receiptCounter`
 * table. The `no-direct-receipt-counter-access` ESLint rule blocks the
 * bypass at build time.
 *
 * Public surface:
 *   - `seedReceiptCounter` — `internalMutation`. Idempotent. Inserts the
 *     single counter row if absent; no-op otherwise. Production must run
 *     this exactly once with the BIR-registered starting serial (§10 Q3).
 *   - `allocateNextSerial` — `async` helper called from inside a Convex
 *     mutation (Story 3.2's `postFinancialEvent`). NOT exposed as a
 *     mutation — exposing it would let a malicious client burn serials
 *     to create intentional gaps (defeating FR28).
 *
 * Voids consume their serial (FR29): the void workflow (Story 3.12) flags
 * the receipt record, not the counter. The counter is never decremented.
 *
 * Convex per-document optimistic concurrency control (OCC): two concurrent
 * mutations that both touch the receiptCounter row contend at the row
 * level. The loser's transaction is automatically retried by the Convex
 * runtime — the resulting serials are sequential, never duplicated, never
 * gapped. We rely on Convex's runtime for the retry; we do NOT add a
 * manual retry loop here, because the calling mutation's atomicity scope
 * is what makes the receipt + payment + audit write together as one unit
 * of work. A manual retry inside this helper would break that scope.
 *
 * See `docs/adr/0010-receipt-counter-pattern.md` for the full decision
 * record. Architectural source of truth: architecture's "Receipt counter
 * boundary" § Architectural Boundaries.
 *
 * Only `convex/lib/postFinancialEvent.ts` may call `allocateNextSerial`.
 * Direct access from elsewhere is blocked by the
 * `no-direct-receipt-counter-access` ESLint rule.
 */

import { internalMutationGeneric } from "convex/server";
import { v } from "convex/values";

import { type MutationCtx } from "./auth";
import { ErrorCode, throwError } from "./errors";

/**
 * Pad width for the numeric portion of a formatted serial. 7 digits
 * covers up to 9,999,999 receipts — sufficient for any single cemetery's
 * lifetime. Widening later is a non-breaking change: the prefix carries
 * the visual separator, so display code keys off `formatted` directly
 * and never re-formats from the integer.
 */
const SERIAL_PAD_WIDTH = 7;

/**
 * Defensive validator for the BIR prefix. BIR-approved prefixes are
 * short, uppercase, alphanumeric (plus hyphen). The runtime regex is
 * gated on §10 Q3 — adjust here if BIR's CAS registration returns a
 * different shape (e.g. with year inserts). Empty string is allowed for
 * `prefix=""` deployments where the cemetery's receipts have no leading
 * code.
 */
const PREFIX_RE = /^[A-Z0-9-]{0,10}$/;

/**
 * Idempotent seed of the single `receiptCounter` row.
 *
 * Behavior:
 *   - First call: validates args, inserts the row at `currentSerial =
 *     startingSerial`, returns `{ alreadySeeded: false, currentSerial }`.
 *   - Subsequent calls: returns `{ alreadySeeded: true, currentSerial }`
 *     reflecting the EXISTING row. The second-call args are ignored;
 *     production cannot re-seed.
 *
 * Validation:
 *   - `startingSerial` must be a non-negative integer. Negatives, fractions,
 *     and NaN throw `INVARIANT_VIOLATION`.
 *   - `prefix` must match `/^[A-Z0-9-]{0,10}$/`. Anything else throws
 *     `INVARIANT_VIOLATION`. Empty string permitted.
 *
 * Audit emission: this function does NOT call `emitAudit`. Seeding the
 * counter is a one-shot infrastructure event, not a domain transition;
 * the production runbook captures the seed event in a higher-level
 * deployment log. The `seededAt` / `seededBy` fields on the row are the
 * in-table audit trail.
 */
export const seedReceiptCounter = internalMutationGeneric({
  args: {
    startingSerial: v.number(),
    prefix: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    args: { startingSerial: number; prefix: string },
  ): Promise<{ alreadySeeded: boolean; currentSerial: number }> => {
    const existing = await ctx.db.query("receiptCounter").collect();
    if (existing.length > 0) {
      // Idempotent — second-call args are ignored.
      return { alreadySeeded: true, currentSerial: existing[0]!.currentSerial };
    }
    if (
      !Number.isInteger(args.startingSerial) ||
      args.startingSerial < 0
    ) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "startingSerial must be a non-negative integer.",
        { startingSerial: args.startingSerial },
      );
    }
    if (!PREFIX_RE.test(args.prefix)) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "prefix must match /^[A-Z0-9-]{0,10}$/.",
        { prefix: args.prefix },
      );
    }
    await ctx.db.insert("receiptCounter", {
      currentSerial: args.startingSerial,
      startingSerial: args.startingSerial,
      prefix: args.prefix,
      seededAt: Date.now(),
      // `seededBy` intentionally omitted — internal mutations carry no
      // authenticated user. If a future admin-UI seed surface is added,
      // it should populate `seededBy` from `requireRole(["admin"])`.
    });
    return { alreadySeeded: false, currentSerial: args.startingSerial };
  },
});

/**
 * Format a serial integer into the canonical "PREFIX0000001" string.
 *
 * The format is the single source of truth for downstream rendering
 * (Story 3.11 PDF, Story 3.13 receipt-search UI). Callers must read
 * `formatted` from `allocateNextSerial`'s return value rather than
 * re-formatting the integer themselves — that would create display
 * drift the audit trail can't reconcile.
 */
export function formatSerial(prefix: string, serial: number): string {
  return `${prefix}${String(serial).padStart(SERIAL_PAD_WIDTH, "0")}`;
}

/**
 * Allocate the next BIR receipt serial.
 *
 * Algorithm:
 *   1. Read the single `receiptCounter` row.
 *   2. Bail if the row is missing — production must seed before issuing
 *      receipts; the missing-row case is a deployment defect, not a
 *      runtime fallback.
 *   3. Bail if `currentSerial` has been corrupted to a non-integer
 *      (defensive — should be unreachable through normal code paths).
 *   4. Increment and `patch`. `patch` (not `replace`) — `patch` is
 *      targeted and forward-compatible with future fields.
 *   5. Return both the integer `serial` and the formatted string.
 *
 * Atomicity: this helper does NOT open its own transaction. The atomicity
 * guarantee is provided by the enclosing mutation — the caller's
 * receipt + payment + audit writes must all live inside the same
 * mutation so that a single transaction commits the counter increment
 * together with the receipt insert. Convex's per-document OCC then
 * serialises concurrent mutations at the row level; the loser is
 * transparently retried by the runtime, producing strictly sequential
 * serials without duplicates or gaps.
 *
 * Throws:
 *   - `INVARIANT_VIOLATION` when the counter row is missing.
 *   - `INVARIANT_VIOLATION` when `currentSerial` is not an integer.
 *
 * Returns: `{ serial: number, formatted: string }`. The formatted value
 * is `<prefix><7-digit-zero-padded-serial>` — e.g. `"OR-0000001"`.
 */
export async function allocateNextSerial(
  ctx: MutationCtx,
): Promise<{ serial: number; formatted: string }> {
  const counter = await ctx.db.query("receiptCounter").first();
  if (counter === null) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      "receiptCounter row missing — seed it before issuing receipts.",
    );
  }
  if (!Number.isInteger(counter.currentSerial)) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      "receiptCounter.currentSerial is not an integer.",
      { currentSerial: counter.currentSerial },
    );
  }
  const next = counter.currentSerial + 1;
  await ctx.db.patch(counter._id, { currentSerial: next });
  return { serial: next, formatted: formatSerial(counter.prefix, next) };
}
