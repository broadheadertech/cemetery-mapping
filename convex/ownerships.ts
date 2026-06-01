/**
 * Ownership history domain (Story 2.5 scaffold; Story 2.7 extends with
 * the transfer flow, FR16 / FR17).
 *
 * First-time domain file. Story 2.5 introduces a single read query —
 * `listByCustomer` — that powers the customer detail page's ownership
 * history list. Story 2.7 will add the transfer mutation that closes
 * the prior `ownerships` row, opens a new one, and emits the linked
 * audit + transfer-event records.
 *
 * Soft foreign key to `lots`:
 *   When a lot is retired (Story 1.8) or deleted, the historical
 *   ownership row remains. `listByCustomer` falls back to
 *   `lotCode: "[retired]"` when the lot lookup returns null, so the
 *   customer's history stays intact across lot lifecycle changes.
 *   Legacy data (§10 Q4) may have ownership rows whose `lotId` does
 *   not resolve — the read path must not throw on those.
 *
 * Conventions every handler obeys (mirrored from `convex/customers.ts`):
 *   1. FIRST awaited statement is `await requireRole(ctx, [...])`.
 *      Enforced by the `local-rules/require-role-first-line` ESLint
 *      rule.
 *   2. Mutations (Story 2.7) call `emitAudit` — `auditLog` direct
 *      inserts are banned by `local-rules/no-audit-log-direct-write`.
 *   3. PII boundary: ownership rows do not carry PII directly. The
 *      `customerId` reference is non-identifying on its own; the
 *      customer's PII fields are read through `convex/customers.ts`
 *      and gated by `requireRole` + (where applicable) `logPiiAccess`.
 */

import {
  type DataModelFromSchemaDefinition,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import { emitAudit } from "./lib/audit";
import { ErrorCode, throwError } from "./lib/errors";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type OwnershipDoc = DataModel["ownerships"]["document"];
type OwnershipId = OwnershipDoc["_id"];
type CustomerId = DataModel["customers"]["document"]["_id"];
type LotId = DataModel["lots"]["document"]["_id"];

/**
 * Type-only mirror of the `transferType` literal union on the
 * `ownerships` table. Re-exported for client typechecking against the
 * `listByCustomer` payload without a `convex/_generated/` dependency.
 */
export type OwnershipTransferType =
  | "sale"
  | "inheritance"
  | "gift"
  | "court_order"
  | "initial";

/**
 * Shape of one row returned by `listByCustomer`. Each row joins the
 * raw `ownerships` doc with the dereferenced `lots.code` so the page
 * can render a clickable lot link without a second round-trip.
 *
 * `lotCode` is `"[retired]"` when the lot row no longer exists — see
 * the soft-foreign-key note in the file header.
 */
export interface OwnershipHistoryRow {
  ownershipId: OwnershipId;
  lotId: LotId;
  lotCode: string;
  effectiveFrom: number;
  effectiveTo?: number;
  transferType: OwnershipTransferType;
}

/**
 * Lists every ownership episode for a customer, most-recent first.
 *
 * Implementation:
 *   1. `requireRole` first — staff-only read (admins + office_staff;
 *      field workers and customer-role callers have no business
 *      reading ownership history per FR16's role design).
 *   2. Index lookup on `by_customer`. Convex returns rows in insert
 *      order via the index; we reverse in JS to honour the
 *      "most-recent first" UX requirement (sorting by `effectiveFrom`
 *      desc).
 *   3. For each row, dereference the lot to get its `code`. Falls
 *      back to `"[retired]"` when `ctx.db.get(lotId)` returns null —
 *      see file-header soft-foreign-key note.
 *
 * Returns `[]` for a customer with no ownership history. The page
 * renders the empty state ("No lot ownership recorded for this
 * customer.") without further branching.
 *
 * Throws ConvexError with one of:
 *   - UNAUTHENTICATED, FORBIDDEN — see `convex/lib/auth.ts`.
 */
export const listByCustomer = queryGeneric({
  args: { customerId: v.id("customers") },
  handler: async (
    ctx: QueryCtx,
    args: { customerId: CustomerId },
  ): Promise<OwnershipHistoryRow[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const rows = await ctx.db
      .query("ownerships")
      .withIndex("by_customer", (q) => q.eq("customerId", args.customerId))
      .collect();

    const out: OwnershipHistoryRow[] = [];
    for (const row of rows) {
      const lot = await ctx.db.get(row.lotId);
      const lotCode =
        lot !== null && typeof lot === "object" && "code" in lot
          ? ((lot as { code: string }).code ?? "[retired]")
          : "[retired]";
      const entry: OwnershipHistoryRow = {
        ownershipId: row._id,
        lotId: row.lotId,
        lotCode,
        effectiveFrom: row.effectiveFrom,
        transferType: row.transferType,
      };
      if (row.effectiveTo !== undefined) {
        entry.effectiveTo = row.effectiveTo;
      }
      out.push(entry);
    }
    // Sort by `effectiveFrom` descending — most-recent ownership first.
    out.sort((a, b) => b.effectiveFrom - a.effectiveFrom);
    return out;
  },
});

/**
 * Lists every ownership episode for a lot, most-recent first. Mirrors
 * `listByCustomer` for the lot detail page side (Story 1.11 leaves a
 * placeholder; future stories may consume this).
 *
 * Throws ConvexError with one of:
 *   - UNAUTHENTICATED, FORBIDDEN.
 */
export const listByLot = queryGeneric({
  args: { lotId: v.id("lots") },
  handler: async (
    ctx: QueryCtx,
    args: { lotId: LotId },
  ): Promise<OwnershipHistoryRow[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const rows = await ctx.db
      .query("ownerships")
      .withIndex("by_lot_effective", (q) => q.eq("lotId", args.lotId))
      .collect();

    const out: OwnershipHistoryRow[] = [];
    for (const row of rows) {
      const lot = await ctx.db.get(row.lotId);
      const lotCode =
        lot !== null && typeof lot === "object" && "code" in lot
          ? ((lot as { code: string }).code ?? "[retired]")
          : "[retired]";
      const entry: OwnershipHistoryRow = {
        ownershipId: row._id,
        lotId: row.lotId,
        lotCode,
        effectiveFrom: row.effectiveFrom,
        transferType: row.transferType,
      };
      if (row.effectiveTo !== undefined) {
        entry.effectiveTo = row.effectiveTo;
      }
      out.push(entry);
    }
    out.sort((a, b) => b.effectiveFrom - a.effectiveFrom);
    return out;
  },
});

/**
 * Field-length caps for `recordOwnershipTransfer` mirrored on the
 * client Zod schema (`src/components/OwnershipTransferForm/schema.ts`).
 * The transferReason participates in the audit trail and is therefore
 * required (FR17 / Story 2.7 AC5).
 */
export const TRANSFER_REASON_MIN_LENGTH = 3;
export const TRANSFER_REASON_MAX_LENGTH = 500;
/**
 * Backdated transfers (effectiveDate older than 24h) demand a fuller
 * justification — the audit record needs context for a legacy-migration
 * or post-hoc correction. Anything shorter is rejected with
 * `INVARIANT_VIOLATION`.
 */
export const BACKDATED_REASON_MIN_LENGTH = 10;

/**
 * Public arg shape for `recordOwnershipTransfer`. Mirrors the Convex
 * validator below. Exported so the React form can typecheck against
 * the mutation's contract.
 *
 * `transferType` defaults to `"sale"` on the server when the caller
 * omits it — the Phase 1 UI surfaces the four real transfer types
 * (sale / inheritance / gift / court order); §10 Q6 may expand or
 * refine the list, at which point this contract widens.
 */
export interface RecordOwnershipTransferArgs {
  fromCustomerId: string;
  toCustomerId: string;
  lotId: string;
  transferReason: string;
  transferDate: number;
  transferType?: "sale" | "inheritance" | "gift" | "court_order";
}

export interface RecordOwnershipTransferResult {
  newOwnershipId: OwnershipId;
  closedOwnershipId: OwnershipId;
}

/**
 * Records an ownership transfer for a lot — Story 2.7 (FR17).
 *
 * Time-versioning contract (architecture § 232): the previous open
 * ownership row is closed by patching `effectiveTo = transferDate`;
 * a new ownership row opens with `effectiveFrom = transferDate` and
 * `effectiveTo = undefined`. The two writes — plus the audit-log
 * emission — are wrapped in a single Convex mutation so the per-
 * mutation atomicity guarantee covers the entire transfer (no
 * half-state risk).
 *
 * §10 Q6 note: the per-transfer-type required-document workflow
 * (deed of sale, affidavit of self-adjudication, etc.) is gated on
 * client policy confirmation. This story ships the minimum-viable
 * atomic transfer (close prior + open new + audit). The richer
 * documentation gate lands when §10 Q6 resolves.
 *
 * Validation rules:
 *   - `transferReason.trim()` between 3 and 500 chars (audit log
 *     needs the operator's own words).
 *   - Backdated transfers (effective > 24h before now) demand a
 *     reason ≥ 10 chars — defensive against careless legacy imports.
 *   - The destination customer must exist.
 *   - The lot must exist and must not be retired.
 *   - The current open ownership row's `customerId` must match
 *     `fromCustomerId` — defense against stale-form submits that
 *     race against a concurrent transfer.
 *   - The current owner and the new owner must differ — self-
 *     transfers are a UX error, not a meaningful audit event.
 *
 * Authorization: `office_staff` or `admin`. Field workers do NOT
 * transfer ownership in Phase 1.
 *
 * Throws ConvexError with one of:
 *   - UNAUTHENTICATED, FORBIDDEN, SESSION_EXPIRED, INVALID_ROLE
 *   - VALIDATION — payload shape rules above.
 *   - INVARIANT_VIOLATION — backdated transfer without long-enough
 *     reason; or current owner mismatch; or self-transfer; or lot
 *     retired; or no current ownership row to transfer from.
 *   - NOT_FOUND — destination customer / lot does not exist.
 */
export const recordOwnershipTransfer = mutationGeneric({
  args: {
    fromCustomerId: v.id("customers"),
    toCustomerId: v.id("customers"),
    lotId: v.id("lots"),
    transferReason: v.string(),
    transferDate: v.number(),
    transferType: v.optional(
      v.union(
        v.literal("sale"),
        v.literal("inheritance"),
        v.literal("gift"),
        v.literal("court_order"),
      ),
    ),
  },
  handler: async (
    ctx: MutationCtx,
    args: RecordOwnershipTransferArgs,
  ): Promise<RecordOwnershipTransferResult> => {
    const auth = await requireRole(ctx, ["admin", "office_staff"]);

    const transferReason = args.transferReason.trim();
    const transferType: OwnershipTransferType = args.transferType ?? "sale";

    // ---- 1. Validate the reason payload (defense in depth — the
    // client Zod schema also enforces these bounds). -------------
    if (transferReason.length < TRANSFER_REASON_MIN_LENGTH) {
      throwError(
        ErrorCode.VALIDATION,
        `Transfer reason is required (min ${TRANSFER_REASON_MIN_LENGTH} characters).`,
      );
    }
    if (transferReason.length > TRANSFER_REASON_MAX_LENGTH) {
      throwError(
        ErrorCode.VALIDATION,
        `Transfer reason must be ${TRANSFER_REASON_MAX_LENGTH} characters or fewer.`,
      );
    }
    if (!Number.isFinite(args.transferDate) || args.transferDate <= 0) {
      throwError(
        ErrorCode.VALIDATION,
        "Transfer date must be a positive timestamp.",
      );
    }

    // Backdated transfers — anything older than 24h before now — need
    // a longer reason for the audit trail. The 24h slack absorbs
    // operator-typed dates that resolve to "earlier today" in Manila tz.
    const isBackdated = args.transferDate < Date.now() - 24 * 60 * 60 * 1000;
    if (isBackdated && transferReason.length < BACKDATED_REASON_MIN_LENGTH) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        `Backdated transfers require a reason of at least ${BACKDATED_REASON_MIN_LENGTH} characters.`,
        { transferDate: args.transferDate, now: Date.now() },
      );
    }

    // ---- 2. Reject self-transfers up front. ----------------------
    if (args.fromCustomerId === args.toCustomerId) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Cannot transfer ownership to the current owner.",
      );
    }

    // Adversarial-review HIGH (H1) — estate-aware transfer gate.
    //
    // Look up the contract bound to this lot. If the contract is
    // bound to a family estate (`familyEstateId !== undefined`),
    // refuse to rewrite the per-lot ownership row in isolation —
    // doing so would leave the estate's OTHER member lots stale
    // (per-lot ownership rows would still point at the old owner
    // while the estate row points at the new one). The operator
    // must use `transferEstateOwnership` (estate-wide flow), which
    // rewrites every member lot's ownership row + the estate
    // row in one atomic mutation.
    //
    // We pick the most-recent active contract bound to this lot
    // (state not in {voided, cancelled}). A paid_in_full contract
    // still gates this — the estate's ownership concept persists
    // beyond contract settlement (FR16 / FR17).
    const contractsForLot = await ctx.db
      .query("contracts")
      .withIndex("by_lot", (q) => q.eq("lotId", args.lotId as LotId))
      .collect();
    const liveContract = contractsForLot.find(
      (c) =>
        (c as { state: string }).state !== "voided" &&
        (c as { state: string }).state !== "cancelled",
    );
    if (
      liveContract !== undefined &&
      (liveContract as { familyEstateId?: string }).familyEstateId !== undefined
    ) {
      const estateId = (liveContract as { familyEstateId: string })
        .familyEstateId;
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        `This lot is part of a family estate. Use the estate-wide transfer flow at /family-estates/${estateId}.`,
        {
          kind: "estate_bound_use_transferEstateOwnership",
          lotId: args.lotId,
          contractId: (liveContract as { _id: string })._id,
          familyEstateId: estateId,
        },
      );
    }

    // ---- 3. Validate the destination customer + lot. -------------
    const toCustomer = await ctx.db.get(args.toCustomerId as CustomerId);
    if (toCustomer === null) {
      throwError(ErrorCode.NOT_FOUND, "Destination customer not found.", {
        toCustomerId: args.toCustomerId,
      });
    }

    const lot = await ctx.db.get(args.lotId as LotId);
    if (lot === null) {
      throwError(ErrorCode.NOT_FOUND, "Lot not found.", { lotId: args.lotId });
    }
    if (
      lot !== null &&
      typeof lot === "object" &&
      "isRetired" in lot &&
      (lot as { isRetired: boolean }).isRetired === true
    ) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Cannot transfer ownership of a retired lot.",
        { lotId: args.lotId },
      );
    }

    // ---- 4. Find the current open ownership row for this lot. -----
    // Convex's `by_lot_effective` index orders by `effectiveFrom`. We
    // collect + filter for the one row whose `effectiveTo` is
    // undefined (the open ownership). Phase 1 expects at most one
    // open row per lot; the time-versioning invariant is enforced
    // here by inspection rather than via a Convex UNIQUE constraint
    // (Convex has none).
    const lotOwnerships = await ctx.db
      .query("ownerships")
      .withIndex("by_lot_effective", (q) => q.eq("lotId", args.lotId as LotId))
      .collect();
    const currentOwnership = lotOwnerships.find(
      (row) => row.effectiveTo === undefined,
    );
    if (currentOwnership === undefined) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "This lot has no current owner to transfer from. Use the sales flow for initial ownership.",
        { lotId: args.lotId },
      );
    }
    if (currentOwnership.customerId !== args.fromCustomerId) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "The current lot owner does not match the supplied source customer. Reload the page and try again.",
        {
          expected: args.fromCustomerId,
          actual: currentOwnership.customerId,
        },
      );
    }

    // ---- 5. Atomic write block. Convex's per-mutation atomicity
    // guarantees that either ALL of the writes below land or NONE
    // do — there is no half-closed-half-opened state at any read
    // observable from another caller.
    await ctx.db.patch(currentOwnership._id, {
      effectiveTo: args.transferDate,
    });
    const newOwnershipId = await ctx.db.insert("ownerships", {
      lotId: args.lotId as LotId,
      customerId: args.toCustomerId as CustomerId,
      effectiveFrom: args.transferDate,
      transferType,
      createdAt: Date.now(),
      createdBy: auth.userId,
    });

    await emitAudit(ctx, {
      action: "transfer",
      entityType: "ownership",
      entityId: newOwnershipId,
      before: {
        ownerCustomerId: args.fromCustomerId,
        ownershipId: currentOwnership._id,
      },
      after: {
        ownerCustomerId: args.toCustomerId,
        ownershipId: newOwnershipId,
        transferType,
        effectiveDate: args.transferDate,
      },
      reason: transferReason,
    });

    return {
      newOwnershipId,
      closedOwnershipId: currentOwnership._id,
    };
  },
});
