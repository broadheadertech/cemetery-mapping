import {
  type MutationCtx,
  type TenantId,
  type UserId,
  type Role,
  type Id,
  type StorageId,
} from "./auth";
import { ErrorCode, throwError } from "./errors";
import { add, assertPositiveAmount, formatPeso, sum } from "./money";
import { toBusinessDate, daysBetween } from "./time";
import { AuditAction, emitAudit } from "./audit";
import { postMovement } from "./postMovement";

/**
 * Advance release and liquidation — taxonomy §6.
 *
 * This is the part of the system most likely to be got wrong, and the
 * error is always the same one: booking the release as an expense and
 * then booking the liquidation as an expense, counting the same money
 * twice (§6.2).
 *
 * The shape of this file is what prevents it. `releaseAdvance` posts a
 * movement whose category treatment is `advance_release` — a treatment
 * that no P&L aggregate reads. `recordLiquidation` writes
 * `advanceLiquidationLines`, whose categories are ordinary `expense`
 * categories, and posts NO movement for the liquidated portion because
 * no cash moves at liquidation. The double count is not something we
 * remember not to do; it is not expressible.
 *
 * State is derived, never set by hand (§6.3):
 *
 *     liquidated + returned === released   →  closed
 *     liquidated + returned  >  0          →  partial
 *     otherwise                            →  open
 *
 * There is no manual "mark as closed". The arithmetic decides.
 */

export interface LiquidationLineInput {
  categoryId: Id<"categories">;
  amountCents: number;
  description: string;
  receiptStorageId?: StorageId;
  /** Date on the receipt, if it differs from the liquidation date. */
  spentOn?: string;
}

/**
 * Releases money to a custodian. Cash leaves; nothing is consumed.
 *
 * The caller supplies a category whose treatment is `advance_release`;
 * `postMovement` rejects anything else, so a release cannot be filed
 * against an expense category by mistake.
 */
export async function releaseAdvance(
  ctx: MutationCtx,
  args: {
    tenantId: TenantId;
    actorId: UserId;
    actorRole?: Role;
    custodianName: string;
    custodianUserId?: Id<"users">;
    releasedCents: number;
    categoryId: Id<"categories">;
    bankAccountId: Id<"bankAccounts">;
    paymentMethod: "cash" | "cheque" | "bank_transfer" | "ewallet" | "auto_debit";
    releasedAt?: number;
    purpose?: string;
    idempotencyKey?: string;
  },
): Promise<{
  advanceId: Id<"advances">;
  movementId: Id<"moneyMovements">;
}> {
  assertPositiveAmount("releasedCents", args.releasedCents);

  const tenant = await ctx.db.get(args.tenantId);
  if (tenant === null) {
    throwError(ErrorCode.NO_TENANT, "Tenant not found.");
  }
  const releasedAt = args.releasedAt ?? Date.now();
  const releasedOn = toBusinessDate(releasedAt, tenant.timezone);

  const advanceId = await ctx.db.insert("advances", {
    tenantId: args.tenantId,
    custodianUserId: args.custodianUserId,
    custodianName: args.custodianName,
    releasedCents: args.releasedCents,
    liquidatedCents: 0,
    returnedCents: 0,
    state: "open",
    releasedAt,
    releasedOn,
    purpose: args.purpose,
    recordedBy: args.actorId,
    recordedAt: Date.now(),
  });

  const { movementId } = await postMovement(ctx, {
    tenantId: args.tenantId,
    actorId: args.actorId,
    actorRole: args.actorRole,
    direction: "out",
    categoryId: args.categoryId,
    entryPath: "ADHOC",
    amountCents: args.releasedCents,
    bankAccountId: args.bankAccountId,
    occurredAt: releasedAt,
    advanceId,
    paymentMethod: args.paymentMethod,
    payeeName: args.custodianName,
    description: `Advance released to ${args.custodianName}`,
    idempotencyKey: args.idempotencyKey,
  });

  await ctx.db.patch(advanceId, { releaseMovementId: movementId });

  await emitAudit(ctx, {
    tenantId: args.tenantId,
    action: AuditAction.ADVANCE_RELEASED,
    entityTable: "advances",
    entityId: String(advanceId),
    actorId: args.actorId,
    actorRole: args.actorRole,
    amountCents: args.releasedCents,
    summary: `${formatPeso(args.releasedCents)} released to ${args.custodianName}`,
  });

  return { advanceId, movementId };
}

/**
 * Records a liquidation: the custodian accounts for what was spent and
 * returns any unspent balance.
 *
 * `liquidationId` is supplied by the caller (a client-generated id). It
 * groups the lines submitted in one Liquidate action AND makes the
 * submission idempotent — a double-tapped submit re-uses the id and is
 * rejected rather than double-recording the spend.
 */
export async function recordLiquidation(
  ctx: MutationCtx,
  args: {
    tenantId: TenantId;
    actorId: UserId;
    actorRole?: Role;
    advanceId: Id<"advances">;
    liquidationId: string;
    lines: readonly LiquidationLineInput[];
    returnedCents: number;
    /** Account the unspent cash goes back into. Required if returning. */
    returnBankAccountId?: Id<"bankAccounts">;
    /** Category with treatment `advance_return`. Required if returning. */
    returnCategoryId?: Id<"categories">;
    liquidatedAt?: number;
  },
): Promise<{ state: "open" | "partial" | "closed"; remainingCents: number }> {
  const advance = await ctx.db.get(args.advanceId);
  if (advance === null) {
    throwError(ErrorCode.NOT_FOUND, "Advance not found.");
  }
  if (advance.tenantId !== args.tenantId) {
    throwError(ErrorCode.FORBIDDEN, "That record belongs to another tenant.");
  }
  if (advance.state === "closed") {
    throwError(
      ErrorCode.ADVANCE_CLOSED,
      "This advance is already fully liquidated.",
    );
  }

  // Idempotency: the same liquidationId must not be recorded twice.
  const existing = await ctx.db
    .query("advanceLiquidationLines")
    .withIndex("by_tenant_liquidation", (q) =>
      q.eq("tenantId", args.tenantId).eq("liquidationId", args.liquidationId),
    )
    .first();
  if (existing !== null) {
    throwError(
      ErrorCode.IDEMPOTENCY_KEY_REUSED,
      "This liquidation has already been recorded.",
      { liquidationId: args.liquidationId },
    );
  }

  if (args.lines.length === 0 && args.returnedCents === 0) {
    throwError(
      ErrorCode.VALIDATION,
      "A liquidation needs at least one line item or a returned amount.",
    );
  }

  // Every line must name a category the taxonomy allows here (§6.4).
  for (const line of args.lines) {
    assertPositiveAmount("line.amountCents", line.amountCents);
    const category = await ctx.db.get(line.categoryId);
    if (category === null) {
      throwError(ErrorCode.NOT_FOUND, "Category not found.");
    }
    if (!category.allowedInLiquidation) {
      throwError(
        ErrorCode.CATEGORY_NOT_LIQUIDATABLE,
        `Category '${category.slug}' cannot be used on a liquidation.`,
        { categorySlug: category.slug },
      );
    }
  }

  const lineTotal = sum(args.lines.map((l) => l.amountCents));
  const newLiquidated = add(advance.liquidatedCents, lineTotal);
  const newReturned = add(advance.returnedCents, args.returnedCents);
  const accountedFor = add(newLiquidated, newReturned);

  // §6.3's close condition, checked as an upper bound. Accounting for
  // more than was released is arithmetically impossible in the real
  // world, so it is a data-entry error and must not be absorbed.
  if (accountedFor > advance.releasedCents) {
    throwError(
      ErrorCode.ADVANCE_OVER_LIQUIDATED,
      `Liquidating ${formatPeso(lineTotal)} plus ${formatPeso(
        args.returnedCents,
      )} returned exceeds the ${formatPeso(
        advance.releasedCents - advance.liquidatedCents - advance.returnedCents,
      )} outstanding on this advance.`,
      { accountedFor, released: advance.releasedCents },
    );
  }

  const tenant = await ctx.db.get(args.tenantId);
  if (tenant === null) {
    throwError(ErrorCode.NO_TENANT, "Tenant not found.");
  }
  const liquidatedAt = args.liquidatedAt ?? Date.now();
  const liquidatedOn = toBusinessDate(liquidatedAt, tenant.timezone);

  for (const line of args.lines) {
    await ctx.db.insert("advanceLiquidationLines", {
      tenantId: args.tenantId,
      advanceId: advance._id,
      liquidationId: args.liquidationId,
      categoryId: line.categoryId,
      amountCents: line.amountCents,
      description: line.description,
      receiptStorageId: line.receiptStorageId,
      spentOn: line.spentOn,
      liquidatedAt,
      liquidatedOn,
      recordedBy: args.actorId,
      recordedAt: Date.now(),
    });
  }

  // Unspent cash coming back IS a cash movement — and it is not income
  // (§6.2), which is why it needs a category whose treatment is
  // `advance_return`. postMovement rejects anything else.
  if (args.returnedCents > 0) {
    if (
      args.returnBankAccountId === undefined ||
      args.returnCategoryId === undefined
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "Returning unspent cash requires the account it goes back into and an advance-return category.",
      );
    }
    await postMovement(ctx, {
      tenantId: args.tenantId,
      actorId: args.actorId,
      actorRole: args.actorRole,
      direction: "in",
      categoryId: args.returnCategoryId,
      entryPath: "ADHOC",
      amountCents: args.returnedCents,
      bankAccountId: args.returnBankAccountId,
      occurredAt: liquidatedAt,
      advanceId: advance._id,
      paymentMethod: "cash",
      description: `Unspent advance returned by ${advance.custodianName}`,
      idempotencyKey: `${args.liquidationId}:return`,
    });
  }

  const state = deriveAdvanceState(
    advance.releasedCents,
    newLiquidated,
    newReturned,
  );

  await ctx.db.patch(advance._id, {
    liquidatedCents: newLiquidated,
    returnedCents: newReturned,
    state,
    liquidatedAt: advance.liquidatedAt ?? liquidatedAt,
    liquidatedOn: advance.liquidatedOn ?? liquidatedOn,
    closedAt: state === "closed" ? Date.now() : undefined,
  });

  await emitAudit(ctx, {
    tenantId: args.tenantId,
    action:
      state === "closed"
        ? AuditAction.ADVANCE_CLOSED
        : AuditAction.ADVANCE_LIQUIDATED,
    entityTable: "advances",
    entityId: String(advance._id),
    actorId: args.actorId,
    actorRole: args.actorRole,
    amountCents: lineTotal,
    summary: `${args.lines.length} line(s) totalling ${formatPeso(
      lineTotal,
    )}, ${formatPeso(args.returnedCents)} returned — advance now ${state}`,
  });

  return {
    state,
    remainingCents: advance.releasedCents - accountedFor,
  };
}

/**
 * §6.3's close condition, in one place.
 *
 * Exported so tests can exercise it directly and so any read path that
 * needs to display a state agrees with the write path by construction.
 */
export function deriveAdvanceState(
  releasedCents: number,
  liquidatedCents: number,
  returnedCents: number,
): "open" | "partial" | "closed" {
  const accountedFor = liquidatedCents + returnedCents;
  if (accountedFor >= releasedCents) return "closed";
  if (accountedFor > 0) return "partial";
  return "open";
}

/**
 * Days an advance has been outstanding (taxonomy §6.4).
 *
 * Computed at read time from `releasedOn` rather than stored, so it
 * cannot go stale — a stored counter would need a nightly job and would
 * be wrong between runs, which is precisely when someone is looking at
 * it.
 */
export function daysOutstanding(
  releasedOn: string,
  todayOn: string,
): number {
  return daysBetween(releasedOn, todayOn);
}

/**
 * Whether an open advance should be visually flagged (§6.4, §13 Q10).
 * A threshold of 0 means the tenant has not set one — never flag.
 */
export function isStale(
  releasedOn: string,
  todayOn: string,
  advanceStaleDays: number,
): boolean {
  if (advanceStaleDays <= 0) return false;
  return daysOutstanding(releasedOn, todayOn) >= advanceStaleDays;
}
