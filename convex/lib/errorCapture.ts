/**
 * Server-side error capture — the write half of the `errorLog` table.
 *
 * The problem this solves: a cron that throws at 02:00, a gateway
 * webhook rejected for a bad signature, an email provider returning
 * 500 — all of it currently lands in `npx convex logs` and nowhere a
 * person will look. There is no on-call engineer here. The cemetery
 * finds out when a customer asks why they never got a receipt.
 *
 * Design constraints, in priority order:
 *
 *   1. **Capture must never break the caller.** Every entry point
 *      swallows its own failures. An observability write that turns a
 *      recoverable error into an unhandled one is strictly worse than
 *      no observability. `captureError` returns void and never throws.
 *
 *   2. **Grouped, not append-only.** Rows are keyed by fingerprint and
 *      carry a count. A cron failing every 10 minutes over a weekend
 *      is one row at `count: 288`, not 288 rows.
 *
 *   3. **PII stays out.** `context` goes through the same `redactPii`
 *      used by `emitAudit` (ADR-0007). Error messages themselves are
 *      not redacted, per the existing convention that they carry
 *      codes and identifiers rather than customer data.
 *
 * Mutation contexts call `captureError` directly. Actions have no
 * `ctx.db` and must go through `errorLog:internal_captureError` via
 * `ctx.runMutation` — the same shape the rest of this codebase uses
 * to get from an action to a write (see `convex/actions/*`), and the
 * reason `emitAuditFromAction` throws rather than pretending.
 */

import { type DataModelFromSchemaDefinition } from "convex/server";

import schema from "../schema";
import type { MutationCtx } from "./auth";
import { redactPii } from "./audit";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type UserId = DataModel["users"]["document"]["_id"];

export type ErrorSeverity = "error" | "warning";

export interface CaptureErrorParams {
  /**
   * Where it happened, as `kind:name` — `cron:reflagExpired`,
   * `webhook:gcash`, `action:sendEmailReminder`. Part of the
   * fingerprint, so keep it stable: a source string built from a
   * changing value (an id, a timestamp) defeats grouping entirely.
   */
  source: string;
  /** The thrown value, or a message string. */
  error: unknown;
  severity?: ErrorSeverity;
  /**
   * Structured detail — ids, counts, the gateway's status code.
   * Redacted at write. Keep it small; this is a debugging aid, not a
   * payload archive.
   */
  context?: Record<string, unknown>;
}

/** Longest message we store. Stack traces get their own, larger cap. */
const MAX_MESSAGE_LENGTH = 1_000;
const MAX_STACK_LENGTH = 4_000;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[truncated]`;
}

/** Pull a message out of whatever was thrown. */
export function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function stackOf(error: unknown): string | undefined {
  if (error instanceof Error && typeof error.stack === "string") {
    return truncate(error.stack, MAX_STACK_LENGTH);
  }
  return undefined;
}

/**
 * Reduce a message to its stable shape so occurrences of the same
 * failure group together.
 *
 * Without this, a message like `Lot lots:abc123 not found` fingerprints
 * differently for every lot, and the table fills with one row per id —
 * exactly the outcome grouping exists to prevent. Digits, hex ids, and
 * quoted values are the parts that vary; everything else is the shape
 * of the failure.
 *
 * Exported for tests: the grouping behaviour IS the feature, so it is
 * worth asserting directly rather than inferring from row counts.
 */
export function fingerprintOf(source: string, message: string): string {
  const normalized = message
    .toLowerCase()
    // Convex ids and other long alphanumeric blobs.
    .replace(/\b[a-z0-9]{16,}\b/g, "<id>")
    // table:id references.
    .replace(/\b\w+:[a-z0-9_-]+\b/g, "<ref>")
    // Anything quoted — codes, names, values.
    .replace(/"[^"]*"/g, "<value>")
    .replace(/'[^']*'/g, "<value>")
    // Bare numbers.
    .replace(/\b\d+(\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
  return `${source}|${truncate(normalized, 200)}`;
}

/**
 * Record an error against its group. Never throws.
 *
 * A repeat occurrence bumps the count, refreshes the message / stack /
 * context to the latest, and REOPENS a resolved row — an operator who
 * marked something handled needs to see that it came back.
 */
export async function captureError(
  ctx: MutationCtx,
  params: CaptureErrorParams,
): Promise<void> {
  try {
    const message = truncate(messageOf(params.error), MAX_MESSAGE_LENGTH);
    const fingerprint = fingerprintOf(params.source, message);
    const now = Date.now();
    const severity: ErrorSeverity = params.severity ?? "error";
    const stack = stackOf(params.error);
    const context =
      params.context === undefined
        ? undefined
        : (redactPii(params.context) as unknown);

    const existing = await ctx.db
      .query("errorLog")
      .withIndex("by_fingerprint", (q) => q.eq("fingerprint", fingerprint))
      .first();

    if (existing === null) {
      const row: {
        fingerprint: string;
        source: string;
        severity: ErrorSeverity;
        message: string;
        stack?: string;
        context?: unknown;
        count: number;
        firstSeenAt: number;
        lastSeenAt: number;
        isResolved: boolean;
      } = {
        fingerprint,
        source: params.source,
        severity,
        message,
        count: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        isResolved: false,
      };
      if (stack !== undefined) row.stack = stack;
      if (context !== undefined) row.context = context;
      await ctx.db.insert("errorLog", row);
      return;
    }

    const patch: {
      count: number;
      lastSeenAt: number;
      message: string;
      severity: ErrorSeverity;
      stack?: string;
      context?: unknown;
      isResolved: boolean;
      resolvedAt?: undefined;
      resolvedBy?: undefined;
    } = {
      count: existing.count + 1,
      lastSeenAt: now,
      message,
      severity,
      // Reopen: it happened again, whatever the operator thought.
      isResolved: false,
    };
    if (stack !== undefined) patch.stack = stack;
    if (context !== undefined) patch.context = context;
    if (existing.isResolved) {
      patch.resolvedAt = undefined;
      patch.resolvedBy = undefined;
    }
    await ctx.db.patch(existing._id, patch);
  } catch (captureFailure) {
    // Last resort. If the observability write itself fails we must not
    // take the caller down with it — the original error is the one that
    // matters, and it is already propagating.
    console.error(
      "[errorCapture] failed to record an error",
      messageOf(captureFailure),
    );
  }
}

/**
 * Mark a group handled. Returns false when the row is already gone.
 * Kept here beside the write path so the reopen-on-recurrence rule and
 * its inverse live in one file.
 */
export async function resolveErrorGroup(
  ctx: MutationCtx,
  errorLogId: DataModel["errorLog"]["document"]["_id"],
  userId: UserId,
): Promise<boolean> {
  const existing = await ctx.db.get(errorLogId);
  if (existing === null) return false;
  await ctx.db.patch(errorLogId, {
    isResolved: true,
    resolvedAt: Date.now(),
    resolvedBy: userId,
  });
  return true;
}
