import { type MutationCtx, type TenantId, type UserId, type Role } from "./auth";

/**
 * Append-only audit log writer.
 *
 * Taxonomy §11.3 says `recordedBy` / `recordedAt` on every row is most
 * of the audit trail. It is not all of it: attribution answers "who
 * created this row" but cannot answer questions about events that touch
 * money **without** creating a money row —
 *
 *   - who sealed day 2026-03-14
 *   - who amended the electricity schedule, and from what to what
 *   - who voided cheque 004512
 *   - who granted someone the payroll role
 *
 * Those go here.
 *
 * ---------------------------------------------------------------
 * ENFORCEMENT
 * ---------------------------------------------------------------
 * Convex has no append-only constraint. Three things enforce it, and
 * all three are required:
 *
 *   1. This helper is the only sanctioned writer.
 *   2. `local-rules/no-audit-log-direct-write` fails the build on any
 *      `ctx.db.insert("auditLog", …)` outside this file.
 *   3. `local-rules/no-audit-log-mutation` fails the build on any
 *      `patch` / `replace` / `delete` touching an auditLog row,
 *      anywhere, including this file.
 *
 * Note what rule 3 means: **there is no sanctioned way to modify or
 * delete an audit row.** That is the point. If a row is wrong, the
 * correct response is another row recording the correction.
 */

/** Actions that are worth a row. Keep this list closed and meaningful. */
export const AuditAction = {
  // --- ledger (taxonomy §10) ---
  DAY_SEALED: "day.sealed",
  MOVEMENT_POSTED: "movement.posted",
  MOVEMENT_REVERSED: "movement.reversed",
  BACKDATED_ENTRY: "movement.backdated",

  // --- obligations (taxonomy §5, §8) ---
  OBLIGATION_RECOGNIZED: "obligation.recognized",
  OBLIGATION_ACTUAL_ENTERED: "obligation.actual_entered",
  OBLIGATION_VOIDED: "obligation.voided",

  // --- advances (taxonomy §6) ---
  ADVANCE_RELEASED: "advance.released",
  ADVANCE_LIQUIDATED: "advance.liquidated",
  ADVANCE_CLOSED: "advance.closed",

  // --- cheques (taxonomy §7.1) ---
  CHEQUE_ISSUED: "cheque.issued",
  CHEQUE_STATUS_CHANGED: "cheque.status_changed",
  CHEQUE_VOIDED: "cheque.voided",

  // --- schedules (taxonomy §8) ---
  SCHEDULE_CREATED: "schedule.created",
  SCHEDULE_AMENDED: "schedule.amended",
  SCHEDULE_DEACTIVATED: "schedule.deactivated",

  // --- access ---
  ROLE_GRANTED: "role.granted",
  ROLE_REVOKED: "role.revoked",
  USER_DEACTIVATED: "user.deactivated",
  RESTRICTED_CATEGORY_READ: "category.restricted_read",
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntry {
  tenantId: TenantId;
  action: AuditActionValue;
  /** Table the affected row lives in, e.g. `"moneyMovements"`. */
  entityTable: string;
  /** Stringified document id of the affected row. */
  entityId: string;
  actorId: UserId;
  actorRole?: Role;
  /**
   * Money amount involved, where one is meaningful. Lets a reviewer
   * scan for large events without joining back to the source row.
   */
  amountCents?: number;
  /**
   * Short human-readable summary of what changed — "expected ₱4,200 →
   * actual ₱4,655", "status released → cleared".
   *
   * Deliberately a summary and NOT the full before/after document:
   * a full copy would duplicate restricted payroll figures into a table
   * with different read rules, quietly defeating
   * `assertCategoryReadable`. Keep it to what a reviewer needs.
   */
  summary?: string;
}

/**
 * Writes one audit row. Call inside the same mutation as the change it
 * describes — Convex mutations are serializable transactions, so the
 * audit row and the change it records commit together or not at all.
 *
 * That property is worth stating plainly: on this platform you cannot
 * end up with a change that has no audit row, or an audit row for a
 * change that was rolled back, **provided the call is in the same
 * mutation.** Scheduling it to an action would break exactly that.
 */
export async function emitAudit(
  ctx: MutationCtx,
  entry: AuditEntry,
): Promise<void> {
  await ctx.db.insert("auditLog", {
    tenantId: entry.tenantId,
    action: entry.action,
    entityTable: entry.entityTable,
    entityId: entry.entityId,
    actorId: entry.actorId,
    actorRole: entry.actorRole,
    at: Date.now(),
    amountCents: entry.amountCents,
    summary: entry.summary,
  });
}
