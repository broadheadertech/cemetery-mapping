import {
  type MutationCtx,
  type ReadableCtx,
  type TenantId,
  type UserId,
  type Role,
  type Id,
} from "./auth";
import { ErrorCode, throwError } from "./errors";
import { assertPositiveAmount, formatPeso } from "./money";
import { AuditAction, emitAudit } from "./audit";

/**
 * Cheque issuance and clearing — taxonomy §7.1 and §7.2.
 *
 * ---------------------------------------------------------------
 * THE UNIQUENESS PROBLEM
 * ---------------------------------------------------------------
 * §7.1 requires `cheque_no` to be unique per bank account, and calls
 * duplicate voucher entry "the most common recording error in a
 * retrospective workflow". On Postgres a unique index would catch it
 * for free. **Convex has no unique index.**
 *
 * So the check lives here, as a read-then-insert inside one mutation.
 * That is genuinely safe — Convex mutations are serializable, and a
 * concurrent duplicate loses the optimistic-concurrency race and
 * retries into this same check against fresh data.
 *
 * It is safe *only for writers that come through this function*. A lint
 * rule (`local-rules/no-direct-financial-write`) blocks direct inserts
 * into `chequeDetails` elsewhere, but a lint rule cannot prove every
 * future writer complied. Hence `findDuplicateChequeNumbers` below,
 * which a nightly cron runs as a backstop.
 *
 * Taxonomy §11.8 records this as a known, paid cost of the platform.
 */

/** §7.1's lifecycle. */
export type ChequeStatus =
  | "issued"
  | "released"
  | "cleared"
  | "cancelled"
  | "bounced";

/**
 * Legal transitions. A cheque that has cleared is terminal — money has
 * left the account and the ledger has a movement for it, so there is
 * nothing a status change could honestly represent afterwards.
 */
const ALLOWED_TRANSITIONS: Record<ChequeStatus, readonly ChequeStatus[]> = {
  issued: ["released", "cancelled"],
  released: ["cleared", "bounced", "cancelled"],
  cleared: [],
  cancelled: [],
  bounced: ["released"],
};

/**
 * Issues a cheque, refusing a number already used on that account.
 *
 * Note what this does NOT do: post a cash-out movement. Under
 * post-dated cheques (§7.2) cash does not leave on the issue date, and
 * posting here would desync the tracker from the bank by up to a month.
 * The movement is posted on clearing, by `markCleared`.
 */
export async function issueCheque(
  ctx: MutationCtx,
  args: {
    tenantId: TenantId;
    actorId: UserId;
    actorRole?: Role;
    chequeNo: string;
    bankAccountId: Id<"bankAccounts">;
    /** Frequently differs from the issue date (§7.1). */
    chequeDate: string;
    issuedOn: string;
    amountCents: number;
    payeeName: string;
    obligationId?: Id<"obligations">;
  },
): Promise<{ chequeId: Id<"chequeDetails"> }> {
  assertPositiveAmount("amountCents", args.amountCents);

  const normalized = args.chequeNo.trim();
  if (normalized.length === 0) {
    throwError(ErrorCode.VALIDATION, "Cheque number is required.");
  }

  // THE uniqueness check. Read-then-insert in one serializable mutation.
  const duplicate = await ctx.db
    .query("chequeDetails")
    .withIndex("by_tenant_account_number", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("bankAccountId", args.bankAccountId)
        .eq("chequeNo", normalized),
    )
    .first();
  if (duplicate !== null) {
    throwError(
      ErrorCode.DUPLICATE_CHEQUE_NO,
      `Cheque ${normalized} has already been recorded on this account.`,
      { chequeNo: normalized, existingChequeId: String(duplicate._id) },
    );
  }

  const chequeId = await ctx.db.insert("chequeDetails", {
    tenantId: args.tenantId,
    chequeNo: normalized,
    bankAccountId: args.bankAccountId,
    chequeDate: args.chequeDate,
    issuedOn: args.issuedOn,
    amountCents: args.amountCents,
    payeeName: args.payeeName,
    status: "issued",
    obligationId: args.obligationId,
    recordedBy: args.actorId,
    recordedAt: Date.now(),
  });

  await emitAudit(ctx, {
    tenantId: args.tenantId,
    action: AuditAction.CHEQUE_ISSUED,
    entityTable: "chequeDetails",
    entityId: String(chequeId),
    actorId: args.actorId,
    actorRole: args.actorRole,
    amountCents: args.amountCents,
    summary: `Cheque ${normalized} for ${formatPeso(args.amountCents)} to ${args.payeeName}, dated ${args.chequeDate}`,
  });

  return { chequeId };
}

/**
 * Moves a cheque through its lifecycle, rejecting illegal transitions.
 *
 * Clearing is handled by `markCleared` rather than here, because it has
 * a side effect this function must not have: it posts the cash-out.
 */
export async function transitionCheque(
  ctx: MutationCtx,
  args: {
    tenantId: TenantId;
    actorId: UserId;
    actorRole?: Role;
    chequeId: Id<"chequeDetails">;
    to: Exclude<ChequeStatus, "cleared">;
    reason?: string;
  },
): Promise<void> {
  const cheque = await ctx.db.get(args.chequeId);
  if (cheque === null) {
    throwError(ErrorCode.NOT_FOUND, "Cheque not found.");
  }
  if (cheque.tenantId !== args.tenantId) {
    throwError(ErrorCode.FORBIDDEN, "That record belongs to another tenant.");
  }
  assertTransitionAllowed(cheque.status as ChequeStatus, args.to);

  await ctx.db.patch(cheque._id, {
    status: args.to,
    voidReason:
      args.to === "cancelled" || args.to === "bounced" ? args.reason : undefined,
  });

  await emitAudit(ctx, {
    tenantId: args.tenantId,
    action:
      args.to === "cancelled"
        ? AuditAction.CHEQUE_VOIDED
        : AuditAction.CHEQUE_STATUS_CHANGED,
    entityTable: "chequeDetails",
    entityId: String(cheque._id),
    actorId: args.actorId,
    actorRole: args.actorRole,
    amountCents: cheque.amountCents,
    summary: `Cheque ${cheque.chequeNo}: ${cheque.status} → ${args.to}${
      args.reason ? ` (${args.reason})` : ""
    }`,
  });
}

export function assertTransitionAllowed(
  from: ChequeStatus,
  to: ChequeStatus,
): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throwError(
      ErrorCode.ILLEGAL_STATE_TRANSITION,
      `A cheque cannot go from ${from} to ${to}.`,
      { from, to },
    );
  }
}

/**
 * Duplicate-cheque backstop (§11.8).
 *
 * `issueCheque` prevents duplicates at the point of entry, but only for
 * callers that went through it. This scan is the safety net a unique
 * index would otherwise have been, and it is why §11.8 says the cost of
 * the platform choice has been *paid* rather than skipped.
 *
 * Intended for a nightly cron. Returns groups rather than throwing —
 * a duplicate found after the fact needs a human decision about which
 * row is real, not an automatic correction.
 *
 * Note this reads the whole cheque table for the tenant via an index
 * range. That is acceptable for a cron over a table that grows by tens
 * of rows a day; if cheque volume ever makes it not so, scan by
 * `issuedOn` range for the trailing window instead of everything.
 */
export async function findDuplicateChequeNumbers(
  ctx: ReadableCtx,
  tenantId: TenantId,
  bankAccountId: Id<"bankAccounts">,
): Promise<Array<{ chequeNo: string; chequeIds: string[] }>> {
  const rows = await ctx.db
    .query("chequeDetails")
    .withIndex("by_tenant_account_issued", (q) =>
      q.eq("tenantId", tenantId).eq("bankAccountId", bankAccountId),
    )
    .collect();

  const byNumber = new Map<string, string[]>();
  for (const row of rows) {
    const ids = byNumber.get(row.chequeNo) ?? [];
    ids.push(String(row._id));
    byNumber.set(row.chequeNo, ids);
  }

  return [...byNumber.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([chequeNo, chequeIds]) => ({ chequeNo, chequeIds }));
}
