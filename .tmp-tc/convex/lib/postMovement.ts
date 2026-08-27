import {
  type MutationCtx,
  type TenantId,
  type UserId,
  type Role,
  type Id,
  type StorageId,
} from "./auth";
import { ErrorCode, throwError } from "./errors";
import { add, assertPositiveAmount, formatPeso } from "./money";
import { toBusinessDate } from "./time";
import { AuditAction, emitAudit } from "./audit";

/**
 * THE CORNERSTONE — the single point at which money touches the
 * database.
 *
 * Nothing else in this codebase may insert into `moneyMovements`, and
 * nothing at all may patch or delete a row in it. Taxonomy §11.1 calls
 * that non-negotiable; Convex cannot enforce it; so this file plus
 * `local-rules/no-direct-financial-write` is the enforcement, and there
 * is nothing behind it.
 *
 * What this helper owns, in order:
 *
 *   1. **Idempotency** (§11.1 in spirit, QUERY_PERFORMANCE §7.3) — a
 *      repeated key with the same payload returns the original row
 *      rather than posting twice.
 *   2. **Sealing** (§10) — a movement dated to a closed day posts to
 *      the OPEN day carrying `originalOccurredOn`. History is not
 *      rewritten.
 *   3. **Treatment/direction agreement** (§3) — a `revenue` category
 *      cannot be used on a cash-out. This is the check that stops
 *      capital injections from being summed into income.
 *   4. **Obligation settlement** (§1) — the recognition-side row is
 *      updated to reflect cash received, and only this helper may do it.
 *   5. **Audit** (§11.3) — an audit row in the same transaction.
 *
 * Corrections go through `reverseMovement`, which appends a compensating
 * row. There is no update path and no delete path, by design.
 */

type Direction = "in" | "out";
type Treatment =
  | "revenue"
  | "expense"
  | "capital"
  | "liability_draw"
  | "liability_repay"
  | "equity_draw"
  | "asset_purchase"
  | "advance_release"
  | "advance_return";

/**
 * Which direction each treatment is allowed to move money.
 *
 * This map is the machine-readable form of taxonomy §3 and §4, and it
 * is total: every treatment appears exactly once. A new treatment added
 * to the schema without adding it here is a TypeScript error, which is
 * the intended tripwire.
 */
const TREATMENT_DIRECTION: Record<Treatment, Direction> = {
  revenue: "in",
  capital: "in",
  liability_draw: "in",
  advance_return: "in",
  expense: "out",
  liability_repay: "out",
  equity_draw: "out",
  asset_purchase: "out",
  advance_release: "out",
};

export interface PostMovementInput {
  tenantId: TenantId;
  actorId: UserId;
  actorRole?: Role;
  direction: Direction;
  categoryId: Id<"categories">;
  entryPath: "SCHED" | "ADHOC" | "DAILY";
  amountCents: number;
  bankAccountId: Id<"bankAccounts">;
  /** Instant the cash moved. Defaults to now. */
  occurredAt?: number;
  obligationId?: Id<"obligations">;
  advanceId?: Id<"advances">;
  paymentMethod:
    | "cash"
    | "cheque"
    | "bank_transfer"
    | "ewallet"
    | "auto_debit";
  referenceNo?: string;
  chequeId?: Id<"chequeDetails">;
  personName?: string;
  dailyBatchId?: Id<"dailyBatches">;
  payeeName?: string;
  description?: string;
  receiptStorageId?: StorageId;
  idempotencyKey?: string;
  note?: string;
}

export interface PostMovementResult {
  movementId: Id<"moneyMovements">;
  /** True when an existing row was returned instead of a new insert. */
  deduplicated: boolean;
  /** True when the movement was redirected off a sealed day (§10). */
  backdated: boolean;
  occurredOn: string;
}

/**
 * Posts one money movement. The only sanctioned writer of
 * `moneyMovements`.
 */
export async function postMovement(
  ctx: MutationCtx,
  input: PostMovementInput,
): Promise<PostMovementResult> {
  assertPositiveAmount("amountCents", input.amountCents);

  // --- 1. Idempotency -------------------------------------------------
  // Read-then-insert inside one serializable mutation. A concurrent
  // duplicate loses the OCC race and retries into this same check, so
  // no unique index is required (taxonomy §11.8).
  if (input.idempotencyKey !== undefined) {
    const prior = await ctx.db
      .query("moneyMovements")
      .withIndex("by_tenant_idempotency_key", (q) =>
        q
          .eq("tenantId", input.tenantId)
          .eq("idempotencyKey", input.idempotencyKey),
      )
      .first();
    if (prior !== null) {
      // Same key, different money is a reused UUID with different
      // financial intent — a programming bug. Never silently dedupe it.
      if (
        prior.amountCents !== input.amountCents ||
        prior.direction !== input.direction ||
        prior.categoryId !== input.categoryId
      ) {
        throwError(
          ErrorCode.IDEMPOTENCY_KEY_REUSED,
          "This idempotency key was already used for a different amount or category.",
          { idempotencyKey: input.idempotencyKey },
        );
      }
      return {
        movementId: prior._id,
        deduplicated: true,
        backdated: prior.originalOccurredOn !== undefined,
        occurredOn: prior.occurredOn,
      };
    }
  }

  // --- 2. Category / treatment agreement (§3) -------------------------
  const category = await ctx.db.get(input.categoryId);
  if (category === null) {
    throwError(ErrorCode.NOT_FOUND, "Category not found.", {
      categoryId: input.categoryId,
    });
  }
  const treatment = category.treatment as Treatment;
  const expectedDirection = TREATMENT_DIRECTION[treatment];
  if (expectedDirection !== input.direction) {
    throwError(
      ErrorCode.TREATMENT_DIRECTION_MISMATCH,
      `Category '${category.slug}' is '${treatment}', which moves money ${expectedDirection}, not ${input.direction}.`,
      { categorySlug: category.slug, treatment, direction: input.direction },
    );
  }

  // --- 3. Sealing (§10) -----------------------------------------------
  const tenant = await ctx.db.get(input.tenantId);
  if (tenant === null) {
    throwError(ErrorCode.NO_TENANT, "Tenant not found.", {
      tenantId: String(input.tenantId),
    });
  }
  const requestedAt = input.occurredAt ?? Date.now();
  const requestedOn = toBusinessDate(requestedAt, tenant.timezone);
  const openOn = toBusinessDate(Date.now(), tenant.timezone);

  const { postOn, postAt, originalOccurredOn } = await resolvePostingDay(
    ctx,
    input.tenantId,
    requestedOn,
    requestedAt,
    openOn,
  );

  // --- 4. Insert -------------------------------------------------------
  const movementId = await ctx.db.insert("moneyMovements", {
    tenantId: input.tenantId,
    direction: input.direction,
    categoryId: input.categoryId,
    entryPath: input.entryPath,
    amountCents: input.amountCents,
    bankAccountId: input.bankAccountId,
    occurredAt: postAt,
    occurredOn: postOn,
    originalOccurredOn,
    obligationId: input.obligationId,
    advanceId: input.advanceId,
    paymentMethod: input.paymentMethod,
    referenceNo: input.referenceNo,
    chequeId: input.chequeId,
    personName: input.personName,
    dailyBatchId: input.dailyBatchId,
    payeeName: input.payeeName,
    description: input.description,
    receiptStorageId: input.receiptStorageId,
    postingStatus: "posted",
    idempotencyKey: input.idempotencyKey,
    recordedBy: input.actorId,
    recordedAt: Date.now(),
    note: input.note,
  });

  // --- 5. Settle the obligation (§1) ----------------------------------
  if (input.obligationId !== undefined) {
    await applySettlement(ctx, input.obligationId, input.amountCents);
  }

  // --- 6. Audit --------------------------------------------------------
  await emitAudit(ctx, {
    tenantId: input.tenantId,
    action:
      originalOccurredOn !== undefined
        ? AuditAction.BACKDATED_ENTRY
        : AuditAction.MOVEMENT_POSTED,
    entityTable: "moneyMovements",
    entityId: String(movementId),
    actorId: input.actorId,
    actorRole: input.actorRole,
    amountCents: input.amountCents,
    summary:
      originalOccurredOn !== undefined
        ? `${formatPeso(input.amountCents)} ${input.direction} dated ${originalOccurredOn}, posted to open day ${postOn} (day sealed)`
        : `${formatPeso(input.amountCents)} ${input.direction} via ${input.paymentMethod}`,
  });

  return {
    movementId,
    deduplicated: false,
    backdated: originalOccurredOn !== undefined,
    occurredOn: postOn,
  };
}

/**
 * Decides which day a movement actually lands on.
 *
 * Taxonomy §10: prior days are closed and immutable, and a backdated
 * entry posts to the current day carrying a reference to its original
 * date. So this never throws for an ordinary backdated entry — it
 * redirects. It throws only if the OPEN day is itself sealed, which
 * would mean the close ran without a new day being opened.
 */
async function resolvePostingDay(
  ctx: MutationCtx,
  tenantId: TenantId,
  requestedOn: string,
  requestedAt: number,
  openOn: string,
): Promise<{
  postOn: string;
  postAt: number;
  originalOccurredOn: string | undefined;
}> {
  const requestedDay = await ctx.db
    .query("dailyLedger")
    .withIndex("by_tenant_date", (q) =>
      q.eq("tenantId", tenantId).eq("ledgerOn", requestedOn),
    )
    .unique();

  if (requestedDay === null || !requestedDay.isSealed) {
    return {
      postOn: requestedOn,
      postAt: requestedAt,
      originalOccurredOn: undefined,
    };
  }

  const openDay = await ctx.db
    .query("dailyLedger")
    .withIndex("by_tenant_date", (q) =>
      q.eq("tenantId", tenantId).eq("ledgerOn", openOn),
    )
    .unique();

  if (openDay !== null && openDay.isSealed) {
    throwError(
      ErrorCode.DAY_SEALED,
      "Both the entry date and the current day are closed. Open the current day before recording.",
      { requestedOn, openOn },
    );
  }

  return {
    postOn: openOn,
    postAt: Date.now(),
    originalOccurredOn: requestedOn,
  };
}

/**
 * Advances an obligation's settled total. The ONLY writer of
 * `settledCents` / `status` — direct patches are blocked by
 * `local-rules/no-direct-financial-write`.
 *
 * Over-settlement throws rather than clamping. Paying more than is
 * owed is either a data-entry error or a genuine overpayment that needs
 * its own decision; silently absorbing it would hide both.
 */
async function applySettlement(
  ctx: MutationCtx,
  obligationId: Id<"obligations">,
  amountCents: number,
): Promise<void> {
  const obligation = await ctx.db.get(obligationId);
  if (obligation === null) {
    throwError(ErrorCode.NOT_FOUND, "Obligation not found.", {
      obligationId,
    });
  }
  const settled = add(obligation.settledCents, amountCents);
  if (settled > obligation.amountCents) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      `Settlement of ${formatPeso(amountCents)} exceeds the ${formatPeso(
        obligation.amountCents - obligation.settledCents,
      )} outstanding on this item.`,
      { settled, owed: obligation.amountCents },
    );
  }
  await ctx.db.patch(obligation._id, {
    settledCents: settled,
    status: settled === obligation.amountCents ? "settled" : "partially_settled",
  });
}

/**
 * Corrects a movement by appending a compensating entry (§11.1).
 *
 * The original row is left byte-for-byte as it was. The reversal is an
 * ordinary movement in the opposite direction, linked back via
 * `reversesMovementId`, and it posts to the open day like any other
 * entry — so reversing a movement from a sealed month does not reach
 * back into that month.
 */
export async function reverseMovement(
  ctx: MutationCtx,
  args: {
    tenantId: TenantId;
    actorId: UserId;
    actorRole?: Role;
    movementId: Id<"moneyMovements">;
    reason: string;
  },
): Promise<{ reversalMovementId: Id<"moneyMovements"> }> {
  const original = await ctx.db.get(args.movementId);
  if (original === null) {
    throwError(ErrorCode.NOT_FOUND, "Movement not found.");
  }
  if (original.tenantId !== args.tenantId) {
    throwError(ErrorCode.FORBIDDEN, "That record belongs to another tenant.");
  }

  const alreadyReversed = await ctx.db
    .query("moneyMovements")
    .withIndex("by_tenant_reverses", (q) =>
      q.eq("tenantId", args.tenantId).eq("reversesMovementId", original._id),
    )
    .first();
  if (alreadyReversed !== null) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      "This movement has already been reversed.",
    );
  }

  const tenant = await ctx.db.get(args.tenantId);
  if (tenant === null) {
    throwError(ErrorCode.NO_TENANT, "Tenant not found.");
  }
  const now = Date.now();
  const reversalId = await ctx.db.insert("moneyMovements", {
    tenantId: args.tenantId,
    direction: original.direction === "in" ? "out" : "in",
    categoryId: original.categoryId,
    entryPath: original.entryPath,
    amountCents: original.amountCents,
    bankAccountId: original.bankAccountId,
    occurredAt: now,
    occurredOn: toBusinessDate(now, tenant.timezone),
    obligationId: original.obligationId,
    advanceId: original.advanceId,
    paymentMethod: original.paymentMethod,
    referenceNo: original.referenceNo,
    personName: original.personName,
    payeeName: original.payeeName,
    description: `Reversal of ${original.description ?? "movement"}`,
    postingStatus: "posted",
    reversesMovementId: original._id,
    reversalReason: args.reason,
    recordedBy: args.actorId,
    recordedAt: now,
  });

  // Give back the settlement the original consumed, so the bill returns
  // to outstanding rather than looking paid by a reversed payment.
  if (original.obligationId !== undefined) {
    const obligation = await ctx.db.get(original.obligationId);
    if (obligation !== null) {
      const settled = obligation.settledCents - original.amountCents;
      await ctx.db.patch(obligation._id, {
        settledCents: settled,
        status: settled <= 0 ? "open" : "partially_settled",
      });
    }
  }

  await emitAudit(ctx, {
    tenantId: args.tenantId,
    action: AuditAction.MOVEMENT_REVERSED,
    entityTable: "moneyMovements",
    entityId: String(original._id),
    actorId: args.actorId,
    actorRole: args.actorRole,
    amountCents: original.amountCents,
    summary: `Reversed ${formatPeso(original.amountCents)}: ${args.reason}`,
  });

  return { reversalMovementId: reversalId };
}
