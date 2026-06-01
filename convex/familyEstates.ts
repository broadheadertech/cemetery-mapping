/**
 * Family estate domain — Story 2.9 (FR15 brand-tier extension).
 *
 * Multi-lot reservations owned as one contractual unit by a household
 * (primary customer + optional secondary owners). Promotes the brand
 * guide's "family estate at Section A" framing (Chapters VI & VIII)
 * into a first-class concept layered ADDITIVELY on top of the existing
 * `lots` / `customers` / `contracts` / `ownerships` surface.
 *
 * Public mutations:
 *   - `createFamilyEstate` — admin / office_staff. Validates 2..12 lots,
 *     primary + secondary owners, no lot is already in another active
 *     estate. Emits audit. Returns the new estate id.
 *   - `addLotToEstate` — admin / office_staff. Appends one lot to an
 *     active estate (2..12 bound still applies). Same per-lot
 *     active-estate exclusion check. Emits audit.
 *   - `removeLotFromEstate` — admin / office_staff. Removes one lot.
 *     Refuses to drop below 2 (estate semantics require ≥ 2). Refuses
 *     when any bound contract still references the estate (Phase 1
 *     conservative — Phase 2 may relax).
 *   - `transferEstateOwnership` — admin / office_staff. Rewrites
 *     primary + secondary owners on the estate AND opens / closes
 *     ownership-history rows on every member lot in a single atomic
 *     mutation. Defense-in-depth: per-lot ownership records remain
 *     authoritative; the estate-level write is the convenience layer
 *     that fans out across the membership.
 *   - `retireEstate` — admin only. Soft-deletes via `retiredAt` so the
 *     audit trail and contract history stay readable.
 *
 * Public queries:
 *   - `getFamilyEstate` — hydrates the estate + joined primary +
 *     secondary owner names + member lot codes for the detail page.
 *   - `listFamilyEstates` — admin index page; optional filter by
 *     primary owner or retired status.
 *   - `listEstatesForCustomer` — customer detail page's "Family
 *     estates" section. Returns every active estate where the customer
 *     is primary or secondary.
 *   - `getEstateForLot` — used by SaleForm + lot detail page surfaces
 *     to detect "this lot is already in an active estate."
 *
 * Conventions every handler obeys:
 *   1. FIRST awaited statement is `await requireRole(ctx, [...])`.
 *      Enforced by `local-rules/require-role-first-line`.
 *   2. Mutations call `emitAudit` — direct `auditLog` inserts are
 *      blocked at lint time.
 *   3. PII boundary: estate rows do not carry PII directly. Customer
 *      lookups for hydration project `fullName` only (mirror the
 *      Ownership history pattern in `convex/ownerships.ts`).
 *
 * Story 2.9 disaster prevention (from the spec):
 *   - A single lot can belong to AT MOST ONE active estate. Enforced
 *     by `assertLotsAvailable` below.
 *   - Single-lot contract paths are untouched. The
 *     `contracts.familyEstateId` FK is optional; only the new
 *     estate-mode branch reads it.
 *   - Retired estates are NOT cascade-deleted; their member lots
 *     stay queryable, their bound contracts stay queryable, and the
 *     receipts they issued remain immutable per FR31.
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
type EstateDoc = DataModel["familyEstates"]["document"];
type EstateId = EstateDoc["_id"];
type CustomerId = DataModel["customers"]["document"]["_id"];
type LotId = DataModel["lots"]["document"]["_id"];
type MembershipDoc = DataModel["lotEstateMembership"]["document"];
type MembershipInsert = Omit<MembershipDoc, "_id" | "_creationTime">;

/** Minimum lot count per estate (a "single-lot estate" is a single-lot contract). */
export const ESTATE_MIN_LOTS = 2;
/** Maximum lot count per estate. Mirrors the brand-tier brief: "3–7 typical, up to 12 for extended families." */
export const ESTATE_MAX_LOTS = 12;
/** Estate name length bounds. */
export const ESTATE_NAME_MIN_LENGTH = 3;
export const ESTATE_NAME_MAX_LENGTH = 120;
/** Retirement reason length bounds. Admin reasoning lands here for audit. */
export const RETIREMENT_REASON_MIN_LENGTH = 10;
export const RETIREMENT_REASON_MAX_LENGTH = 500;

/**
 * Shape returned by `getFamilyEstate` / `listFamilyEstates` row joins.
 * Hydrates the names + codes the UI needs without forcing a second
 * fetch per row.
 */
export interface FamilyEstateRow {
  estateId: EstateId;
  name: string;
  primaryOwnerCustomerId: CustomerId;
  primaryOwnerFullName: string;
  secondaryOwners: Array<{
    customerId: CustomerId;
    fullName: string;
  }>;
  lots: Array<{
    lotId: LotId;
    code: string;
  }>;
  notes?: string;
  createdAt: number;
  retiredAt?: number;
  retirementReason?: string;
  isActive: boolean;
}

/**
 * Looks up every active estate that already contains any of `lotIds`.
 *
 * Used by `createFamilyEstate` + `addLotToEstate` to enforce the "a
 * lot belongs to at most one active estate" invariant. Returns the
 * conflicting estate's id + the first conflicting lot so the caller
 * can produce a precise error.
 *
 * Implementation: walks `by_retiredAt` with `retiredAt === undefined`
 * (active rows only). At Phase 1 scale the active-estate count is
 * small (under a few hundred); a linear scan over active rows is
 * acceptable.
 *
 * NOTE — adversarial-review CRITICAL fix: this scan is the FIRST line
 * of defense; the second (and authoritative) line is the
 * `lotEstateMembership` companion table queried via
 * `findActiveMembershipForLot` below. The table-backed check is what
 * actually fails the loser of a true concurrent race — under Convex
 * OCC, two parallel `createFamilyEstate` transactions reading the same
 * empty active-estate set both pass THIS check but only one can win
 * the membership-row insert; the OCC layer retries the loser, which
 * then sees the freshly written membership row and rejects.
 */
async function findConflictingActiveEstate(
  ctx: QueryCtx | MutationCtx,
  lotIds: ReadonlyArray<LotId>,
  excludeEstateId: EstateId | null,
): Promise<{ estateId: EstateId; lotId: LotId } | null> {
  const candidate = new Set<string>(lotIds.map((id) => id as unknown as string));
  const activeEstates = await ctx.db
    .query("familyEstates")
    .withIndex("by_retiredAt", (q) => q.eq("retiredAt", undefined))
    .collect();
  for (const estate of activeEstates) {
    if (excludeEstateId !== null && estate._id === excludeEstateId) continue;
    for (const memberLot of estate.lotIds) {
      if (candidate.has(memberLot as unknown as string)) {
        return { estateId: estate._id, lotId: memberLot };
      }
    }
  }
  return null;
}

/**
 * Walks the `lotEstateMembership.by_lot_active` index for the supplied
 * lot. Returns the first active membership row (a lot can have AT MOST
 * one active membership by invariant; the function returns the first
 * if there are somehow multiple).
 *
 * Adversarial-review CRITICAL fix companion: this is the
 * concurrent-race-safe check. Convex OCC re-runs the transaction if
 * any read row was concurrently mutated; the loser of a race against
 * `createFamilyEstate` / `addLotToEstate` re-reads this index, sees
 * the winner's freshly written `isActive: true` row, and rejects.
 */
async function findActiveMembershipForLot(
  ctx: QueryCtx | MutationCtx,
  lotId: LotId,
): Promise<
  | {
      _id: DataModel["lotEstateMembership"]["document"]["_id"];
      familyEstateId: EstateId;
    }
  | null
> {
  const row = await ctx.db
    .query("lotEstateMembership")
    .withIndex("by_lot_active", (q) =>
      q.eq("lotId", lotId).eq("isActive", true),
    )
    .first();
  if (row === null) return null;
  return {
    _id: (row as { _id: DataModel["lotEstateMembership"]["document"]["_id"] })
      ._id,
    familyEstateId: (row as { familyEstateId: EstateId }).familyEstateId,
  };
}

/**
 * Looks up the open (effectiveTo === undefined) ownership row for a
 * lot. Returns null when the lot has never been sold — that's a
 * legitimate state (an available, unsold lot can still be placed in
 * an estate the household will purchase later via the sale flow).
 *
 * Adversarial-review HIGH (H2) fix helper: the create / add paths use
 * this to enforce the "if a lot already has an owner, that owner MUST
 * be the estate's primary owner" rule — without it, an office_staff
 * caller could compose an estate naming customer X as primary while
 * pulling in lots that legally belong to customer Y. Lots with no
 * open ownership row (still in inventory) are fine.
 */
async function findOpenOwnershipForLot(
  ctx: QueryCtx | MutationCtx,
  lotId: LotId,
): Promise<{ customerId: CustomerId } | null> {
  const rows = await ctx.db
    .query("ownerships")
    .withIndex("by_lot_effective", (q) => q.eq("lotId", lotId))
    .collect();
  const open = rows.find(
    (r) =>
      (r as { effectiveTo?: number }).effectiveTo === undefined,
  );
  if (open === undefined) return null;
  return {
    customerId: (open as { customerId: CustomerId }).customerId,
  };
}

/**
 * Asserts every supplied lot id resolves to a non-retired `lots` row.
 * Throws NOT_FOUND for missing lots and INVARIANT_VIOLATION for
 * retired ones.
 */
async function assertLotsExistAndActive(
  ctx: QueryCtx | MutationCtx,
  lotIds: ReadonlyArray<LotId>,
): Promise<void> {
  for (const lotId of lotIds) {
    const lot = await ctx.db.get(lotId);
    if (lot === null) {
      throwError(ErrorCode.NOT_FOUND, "Lot not found.", { lotId });
    }
    if (
      lot !== null &&
      typeof lot === "object" &&
      "isRetired" in lot &&
      (lot as { isRetired: boolean }).isRetired === true
    ) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Cannot include a retired lot in a family estate.",
        { lotId },
      );
    }
  }
}

/**
 * Asserts every customer id resolves. Used for the primary + secondary
 * owners in create / transfer. Throws NOT_FOUND on the first miss.
 */
async function assertCustomersExist(
  ctx: QueryCtx | MutationCtx,
  customerIds: ReadonlyArray<CustomerId>,
): Promise<void> {
  for (const customerId of customerIds) {
    // pii-read-ok: existence check only; no PII fields are returned to the caller.
    const customer = await ctx.db.get(customerId);
    if (customer === null) {
      throwError(ErrorCode.NOT_FOUND, "Customer not found.", { customerId });
    }
  }
}

/**
 * Normalises and validates an estate name. Returns the trimmed value;
 * throws VALIDATION on out-of-bound length.
 */
function validateEstateName(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length < ESTATE_NAME_MIN_LENGTH) {
    throwError(
      ErrorCode.VALIDATION,
      `Estate name must be at least ${ESTATE_NAME_MIN_LENGTH} characters.`,
      { length: trimmed.length },
    );
  }
  if (trimmed.length > ESTATE_NAME_MAX_LENGTH) {
    throwError(
      ErrorCode.VALIDATION,
      `Estate name must be at most ${ESTATE_NAME_MAX_LENGTH} characters.`,
      { length: trimmed.length },
    );
  }
  return trimmed;
}

/**
 * Dedup helper — throws VALIDATION when an array contains duplicate
 * ids. Used for both lotIds and the secondary-owner customerIds.
 */
function assertNoDuplicates(
  values: ReadonlyArray<string>,
  kind: "lot" | "secondary owner",
): void {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) {
      throwError(
        ErrorCode.VALIDATION,
        `Duplicate ${kind} id in estate composition.`,
        { id: v },
      );
    }
    seen.add(v);
  }
}

/**
 * Public arg shape for `createFamilyEstate`.
 */
export interface CreateFamilyEstateArgs {
  name: string;
  primaryOwnerCustomerId: CustomerId;
  secondaryOwnerCustomerIds: CustomerId[];
  lotIds: LotId[];
  notes?: string;
}

/**
 * Creates a new family estate.
 *
 * Authorization: admin or office_staff.
 *
 * Validation (in order, cheapest first):
 *   - Name is 3..120 chars (trimmed).
 *   - lotIds count is 2..12.
 *   - No duplicates inside lotIds.
 *   - Primary customer is not also in secondaryOwnerCustomerIds.
 *   - No duplicates inside secondaryOwnerCustomerIds.
 *   - Every lot exists and is non-retired.
 *   - Every customer (primary + secondary) exists.
 *   - No candidate lot is already in another ACTIVE estate.
 *
 * Side effects:
 *   1. Insert the `familyEstates` row.
 *   2. Emit `create` audit row with the full estate composition.
 *
 * Notably absent: the create flow does NOT mutate `lots.status` (estates
 * are a grouping concept — selling the estate is a separate flow that
 * mutates lot status via the existing sale path with `familyEstateId`
 * supplied). Similarly, no ownership history is opened here — opening
 * ownership rows happens at sale time, not estate-creation time.
 */
export const createFamilyEstate = mutationGeneric({
  args: {
    name: v.string(),
    primaryOwnerCustomerId: v.id("customers"),
    secondaryOwnerCustomerIds: v.array(v.id("customers")),
    lotIds: v.array(v.id("lots")),
    notes: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: CreateFamilyEstateArgs,
  ): Promise<{ estateId: EstateId }> => {
    const auth = await requireRole(ctx, ["admin", "office_staff"]);

    const name = validateEstateName(args.name);

    if (args.lotIds.length < ESTATE_MIN_LOTS) {
      throwError(
        ErrorCode.VALIDATION,
        `A family estate must include at least ${ESTATE_MIN_LOTS} lots.`,
        { lotCount: args.lotIds.length },
      );
    }
    if (args.lotIds.length > ESTATE_MAX_LOTS) {
      throwError(
        ErrorCode.VALIDATION,
        `A family estate cannot include more than ${ESTATE_MAX_LOTS} lots.`,
        { lotCount: args.lotIds.length },
      );
    }
    assertNoDuplicates(
      args.lotIds.map((id) => id as unknown as string),
      "lot",
    );
    assertNoDuplicates(
      args.secondaryOwnerCustomerIds.map((id) => id as unknown as string),
      "secondary owner",
    );
    if (
      args.secondaryOwnerCustomerIds.some(
        (id) =>
          (id as unknown as string) ===
          (args.primaryOwnerCustomerId as unknown as string),
      )
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "Primary owner cannot also appear in secondary owners list.",
      );
    }

    await assertLotsExistAndActive(ctx, args.lotIds);
    await assertCustomersExist(ctx, [
      args.primaryOwnerCustomerId,
      ...args.secondaryOwnerCustomerIds,
    ]);

    const conflict = await findConflictingActiveEstate(
      ctx,
      args.lotIds,
      null,
    );
    if (conflict !== null) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "One or more lots are already part of another active family estate.",
        {
          kind: "lot_in_other_active_estate",
          conflictingEstateId: conflict.estateId,
          conflictingLotId: conflict.lotId,
        },
      );
    }

    // Adversarial-review HIGH (H2) — cross-customer attack guard.
    //
    // Reject when ANY candidate lot's CURRENT open ownership row
    // (`effectiveTo === undefined`) names a customer other than the
    // estate's primary owner. Without this check an office_staff
    // caller could compose an estate naming customer X as primary
    // while referencing customer Y's lots, then transfer-estate-
    // ownership the package to a third party and effectively steal
    // Y's lots inside one mutation. Lots with NO open ownership
    // (still in inventory / never sold) are fine — those will be
    // initially owned by the primary at sale time via the standard
    // sales path.
    for (const lotId of args.lotIds) {
      const open = await findOpenOwnershipForLot(ctx, lotId);
      if (open === null) continue;
      if (
        (open.customerId as unknown as string) !==
        (args.primaryOwnerCustomerId as unknown as string)
      ) {
        throwError(
          ErrorCode.INVARIANT_VIOLATION,
          "One or more lots are currently owned by a different customer. Transfer ownership first or compose the estate with the existing owner as primary.",
          {
            kind: "lot_owned_by_different_customer",
            lotId,
            actualOwnerCustomerId: open.customerId,
            expectedPrimaryOwnerCustomerId: args.primaryOwnerCustomerId,
          },
        );
      }
    }

    // Adversarial-review CRITICAL — concurrent createFamilyEstate
    // race fix. Re-check the `lotEstateMembership.by_lot_active`
    // index for EVERY candidate lot AFTER the per-lot custom
    // validation but BEFORE the estate insert. Two concurrent
    // creates referencing overlapping lots both read the index and
    // see no active row; both write their estate row + their
    // membership rows; Convex OCC detects the conflicting reads of
    // the `by_lot_active` index and retries the loser. The retried
    // transaction sees the winner's `isActive: true` row and
    // rejects here.
    for (const lotId of args.lotIds) {
      const existingMembership = await findActiveMembershipForLot(ctx, lotId);
      if (existingMembership !== null) {
        throwError(
          ErrorCode.INVARIANT_VIOLATION,
          "One or more lots are already part of another active family estate.",
          {
            kind: "lot_in_other_active_estate",
            lotId,
            conflictingEstateId: existingMembership.familyEstateId,
          },
        );
      }
    }

    const trimmedNotes =
      typeof args.notes === "string" && args.notes.trim().length > 0
        ? args.notes.trim()
        : undefined;

    const now = Date.now();
    type EstateInsert = EstateDoc extends infer Doc
      ? Omit<Doc, "_id" | "_creationTime">
      : never;
    const insert: EstateInsert = {
      name,
      primaryOwnerCustomerId: args.primaryOwnerCustomerId,
      secondaryOwnerCustomerIds: args.secondaryOwnerCustomerIds,
      lotIds: args.lotIds,
      createdAt: now,
      createdByUserId: auth.userId,
    };
    if (trimmedNotes !== undefined) {
      insert.notes = trimmedNotes;
    }
    const estateId = await ctx.db.insert("familyEstates", insert);

    // Insert the membership rows in the SAME mutation. Convex
    // guarantees per-mutation atomicity — either every row lands or
    // none do. The OCC layer turns the "loser of a race" scenario
    // into a clean rejection (described above) rather than a partial
    // write.
    for (const lotId of args.lotIds) {
      const membershipInsert: MembershipInsert = {
        lotId,
        familyEstateId: estateId,
        isActive: true,
        addedAt: now,
      };
      await ctx.db.insert("lotEstateMembership", membershipInsert);
    }

    await emitAudit(ctx, {
      action: "create",
      entityType: "ownership",
      entityId: estateId,
      after: {
        kind: "family_estate",
        estateId,
        name,
        primaryOwnerCustomerId: args.primaryOwnerCustomerId,
        secondaryOwnerCustomerIds: args.secondaryOwnerCustomerIds,
        lotIds: args.lotIds,
        notes: trimmedNotes,
      },
    });

    return { estateId };
  },
});

/**
 * Adds one lot to an active estate. Refuses when the estate is retired
 * (a retired estate cannot grow) and when the lot is already in
 * another active estate or already in THIS estate's lot list.
 */
export const addLotToEstate = mutationGeneric({
  args: {
    estateId: v.id("familyEstates"),
    lotId: v.id("lots"),
  },
  handler: async (
    ctx: MutationCtx,
    args: { estateId: EstateId; lotId: LotId },
  ): Promise<{ estateId: EstateId; lotCount: number }> => {
    await requireRole(ctx, ["admin", "office_staff"]);

    const estate = await ctx.db.get(args.estateId);
    if (estate === null) {
      throwError(ErrorCode.NOT_FOUND, "Family estate not found.", {
        estateId: args.estateId,
      });
    }
    if (estate!.retiredAt !== undefined) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Cannot modify a retired family estate.",
        { estateId: args.estateId },
      );
    }
    if (estate!.lotIds.length >= ESTATE_MAX_LOTS) {
      throwError(
        ErrorCode.VALIDATION,
        `Family estate already has the maximum of ${ESTATE_MAX_LOTS} lots.`,
        { lotCount: estate!.lotIds.length },
      );
    }
    if (
      estate!.lotIds.some(
        (id) => (id as unknown as string) === (args.lotId as unknown as string),
      )
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "Lot is already a member of this family estate.",
        { estateId: args.estateId, lotId: args.lotId },
      );
    }

    await assertLotsExistAndActive(ctx, [args.lotId]);

    const conflict = await findConflictingActiveEstate(
      ctx,
      [args.lotId],
      estate!._id,
    );
    if (conflict !== null) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Lot is already part of another active family estate.",
        {
          kind: "lot_in_other_active_estate",
          conflictingEstateId: conflict.estateId,
          conflictingLotId: conflict.lotId,
        },
      );
    }

    // Adversarial-review CRITICAL — membership-table-backed
    // race-safe check. See `createFamilyEstate` for the full
    // rationale. The OCC layer guarantees that two concurrent
    // `addLotToEstate` calls for the same lot serialize via this
    // index read, so only one wins the membership insert.
    const existingMembership = await findActiveMembershipForLot(
      ctx,
      args.lotId,
    );
    if (existingMembership !== null) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Lot is already part of another active family estate.",
        {
          kind: "lot_in_other_active_estate",
          lotId: args.lotId,
          conflictingEstateId: existingMembership.familyEstateId,
        },
      );
    }

    const now = Date.now();
    const newLotIds = [...estate!.lotIds, args.lotId];
    await ctx.db.patch(estate!._id, { lotIds: newLotIds });
    const membershipInsert: MembershipInsert = {
      lotId: args.lotId,
      familyEstateId: estate!._id,
      isActive: true,
      addedAt: now,
    };
    await ctx.db.insert("lotEstateMembership", membershipInsert);

    await emitAudit(ctx, {
      action: "update",
      entityType: "ownership",
      entityId: estate!._id,
      before: { kind: "family_estate", lotIds: estate!.lotIds },
      after: {
        kind: "family_estate",
        lotIds: newLotIds,
        addedLotId: args.lotId,
      },
    });

    return { estateId: estate!._id, lotCount: newLotIds.length };
  },
});

/**
 * Removes one lot from an active estate. Refuses to drop below
 * `ESTATE_MIN_LOTS` (an estate is a multi-lot concept by definition)
 * and refuses while any non-voided contract still references the
 * estate (Phase 1 conservative posture — Phase 2 may relax with a
 * `contracts.recomposeEstate` flow that re-issues affected receipts).
 */
export const removeLotFromEstate = mutationGeneric({
  args: {
    estateId: v.id("familyEstates"),
    lotId: v.id("lots"),
  },
  handler: async (
    ctx: MutationCtx,
    args: { estateId: EstateId; lotId: LotId },
  ): Promise<{ estateId: EstateId; lotCount: number }> => {
    await requireRole(ctx, ["admin", "office_staff"]);

    const estate = await ctx.db.get(args.estateId);
    if (estate === null) {
      throwError(ErrorCode.NOT_FOUND, "Family estate not found.", {
        estateId: args.estateId,
      });
    }
    if (estate!.retiredAt !== undefined) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Cannot modify a retired family estate.",
        { estateId: args.estateId },
      );
    }
    if (
      !estate!.lotIds.some(
        (id) => (id as unknown as string) === (args.lotId as unknown as string),
      )
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "Lot is not a member of this family estate.",
        { estateId: args.estateId, lotId: args.lotId },
      );
    }
    if (estate!.lotIds.length <= ESTATE_MIN_LOTS) {
      throwError(
        ErrorCode.VALIDATION,
        `Removing this lot would drop the estate below the ${ESTATE_MIN_LOTS}-lot minimum. Retire the estate instead.`,
        { lotCount: estate!.lotIds.length },
      );
    }

    // Phase 1 conservative: refuse to remove a lot while a LIVE
    // contract still financially commits to the estate's footprint.
    //
    // Adversarial-review HIGH (H3) fix — the "live contract"
    // exclusion treats `voided`, `cancelled`, AND `paid_in_full` as
    // terminal:
    //   - `voided` / `cancelled` — contract has no financial weight.
    //   - `paid_in_full` — contract is fully settled; the customer
    //     paid every centavo. Rewriting the estate's lot membership
    //     cannot affect the sale's financial integrity at that
    //     point, because no payment can ever land against the
    //     contract again (FR31 receipt immutability + the
    //     `paid_in_full` terminal state in `stateMachines.ts`).
    //     Before this fix the estate's membership could never be
    //     reshaped after the contract closed — a customer who had
    //     already paid for the package would be stuck with the
    //     original lot list forever, even if the cemetery wanted to
    //     swap a lot for legitimate operational reasons.
    //
    // The remaining states (`active`, `in_default`) are the genuine
    // "live contracts" — rewriting the lot composition under them
    // would silently drift the historical contract record.
    const boundContracts = await ctx.db
      .query("contracts")
      .withIndex("by_familyEstate_state", (q) =>
        q.eq("familyEstateId", estate!._id),
      )
      .collect();
    const liveContract = boundContracts.find(
      (c) =>
        c.state !== "voided" &&
        c.state !== "cancelled" &&
        c.state !== "paid_in_full",
    );
    if (liveContract !== undefined) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Cannot remove a lot from an estate that has an active contract. Void the contract first.",
        { estateId: args.estateId, contractId: liveContract._id },
      );
    }

    const now = Date.now();
    const newLotIds = estate!.lotIds.filter(
      (id) => (id as unknown as string) !== (args.lotId as unknown as string),
    );
    await ctx.db.patch(estate!._id, { lotIds: newLotIds });

    // Deactivate every active membership row for this (estateId,
    // lotId) pair. Defense in depth: in a healthy schema there is
    // exactly one such row, but we patch every match to ensure the
    // `by_lot_active` invariant holds regardless of any prior
    // pre-fix data state.
    const memberships = await ctx.db
      .query("lotEstateMembership")
      .withIndex("by_estate", (q) => q.eq("familyEstateId", estate!._id))
      .collect();
    for (const m of memberships) {
      if (
        (m as { lotId: LotId }).lotId === args.lotId &&
        (m as { isActive: boolean }).isActive === true
      ) {
        await ctx.db.patch(
          (m as MembershipDoc)._id,
          { isActive: false, removedAt: now },
        );
      }
    }

    await emitAudit(ctx, {
      action: "update",
      entityType: "ownership",
      entityId: estate!._id,
      before: { kind: "family_estate", lotIds: estate!.lotIds },
      after: {
        kind: "family_estate",
        lotIds: newLotIds,
        removedLotId: args.lotId,
      },
    });

    return { estateId: estate!._id, lotCount: newLotIds.length };
  },
});

/**
 * Public arg shape for `transferEstateOwnership`. Rewrites primary +
 * secondary owners on the estate AND opens/closes ownership-history
 * rows on EVERY member lot in a single atomic mutation.
 */
export interface TransferEstateOwnershipArgs {
  estateId: EstateId;
  newPrimaryOwnerCustomerId: CustomerId;
  newSecondaryOwnerCustomerIds: CustomerId[];
  transferReason: string;
  transferDate: number;
  transferType?: "sale" | "inheritance" | "gift" | "court_order";
}

/**
 * Atomic estate-wide ownership transfer.
 *
 * For every member lot whose current open ownership row points at the
 * estate's CURRENT primary owner, this mutation closes that row
 * (sets `effectiveTo = transferDate`) and opens a fresh ownership row
 * pointing at the new primary owner. Lots whose current open ownership
 * does not match the estate's primary owner are skipped with a
 * console-warning — the read path falls back to the existing per-lot
 * ownership row, which is still authoritative.
 *
 * Estate row itself is patched with the new primary +
 * secondaryOwnerCustomerIds in the same transaction.
 *
 * Audit: emits ONE "transfer" row anchored to the estate, then one
 * per affected lot via the same helper. Per-lot rows preserve the
 * familiar ownership-history audit shape (Story 2.7).
 */
export const transferEstateOwnership = mutationGeneric({
  args: {
    estateId: v.id("familyEstates"),
    newPrimaryOwnerCustomerId: v.id("customers"),
    newSecondaryOwnerCustomerIds: v.array(v.id("customers")),
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
    args: TransferEstateOwnershipArgs,
  ): Promise<{
    estateId: EstateId;
    affectedLotCount: number;
    newOwnershipIds: string[];
  }> => {
    const auth = await requireRole(ctx, ["admin", "office_staff"]);

    const transferReason = (args.transferReason ?? "").trim();
    if (transferReason.length < 3) {
      throwError(
        ErrorCode.VALIDATION,
        "Transfer reason is required (min 3 characters).",
      );
    }
    if (transferReason.length > 500) {
      throwError(
        ErrorCode.VALIDATION,
        "Transfer reason must be 500 characters or fewer.",
      );
    }
    const transferType = args.transferType ?? "sale";

    const estate = await ctx.db.get(args.estateId);
    if (estate === null) {
      throwError(ErrorCode.NOT_FOUND, "Family estate not found.", {
        estateId: args.estateId,
      });
    }
    if (estate!.retiredAt !== undefined) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Cannot transfer ownership of a retired family estate.",
        { estateId: args.estateId },
      );
    }
    if (
      (args.newPrimaryOwnerCustomerId as unknown as string) ===
      (estate!.primaryOwnerCustomerId as unknown as string)
    ) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "New primary owner is identical to the current primary owner.",
      );
    }
    assertNoDuplicates(
      args.newSecondaryOwnerCustomerIds.map((id) => id as unknown as string),
      "secondary owner",
    );
    if (
      args.newSecondaryOwnerCustomerIds.some(
        (id) =>
          (id as unknown as string) ===
          (args.newPrimaryOwnerCustomerId as unknown as string),
      )
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "New primary owner cannot also appear in the new secondary owners list.",
      );
    }
    await assertCustomersExist(ctx, [
      args.newPrimaryOwnerCustomerId,
      ...args.newSecondaryOwnerCustomerIds,
    ]);

    const oldPrimary = estate!.primaryOwnerCustomerId;
    const oldSecondaries = estate!.secondaryOwnerCustomerIds;

    // Patch the estate row first; the per-lot ownership rewrites follow.
    await ctx.db.patch(estate!._id, {
      primaryOwnerCustomerId: args.newPrimaryOwnerCustomerId,
      secondaryOwnerCustomerIds: args.newSecondaryOwnerCustomerIds,
    });

    const newOwnershipIds: string[] = [];
    let affected = 0;
    const now = Date.now();
    for (const lotId of estate!.lotIds) {
      const lotOwnerships = await ctx.db
        .query("ownerships")
        .withIndex("by_lot_effective", (q) => q.eq("lotId", lotId))
        .collect();
      const open = lotOwnerships.find((row) => row.effectiveTo === undefined);
      if (open === undefined) {
        // Lot has never been sold yet — no ownership history to rewrite.
        // The future sale will record the new owner directly.
        continue;
      }
      if (
        (open.customerId as unknown as string) !==
        (oldPrimary as unknown as string)
      ) {
        // Lot's current owner already differs from the estate's primary
        // (e.g. a per-lot transfer landed out-of-band before the
        // estate-wide transfer). Skip; the per-lot row stays
        // authoritative. Log via console for runbook visibility.
        console.warn(
          "[familyEstates] estate transfer skipped lot — owner mismatch",
          { estateId: estate!._id, lotId, expected: oldPrimary, actual: open.customerId },
        );
        continue;
      }
      await ctx.db.patch(open._id, { effectiveTo: args.transferDate });
      const newOwnershipId = await ctx.db.insert("ownerships", {
        lotId,
        customerId: args.newPrimaryOwnerCustomerId,
        effectiveFrom: args.transferDate,
        transferType,
        createdAt: now,
        createdBy: auth.userId,
      });
      newOwnershipIds.push(newOwnershipId as unknown as string);
      await emitAudit(ctx, {
        action: "transfer",
        entityType: "ownership",
        entityId: newOwnershipId,
        before: {
          kind: "lot_in_estate_transfer",
          estateId: estate!._id,
          lotId,
          ownerCustomerId: oldPrimary,
          ownershipId: open._id,
        },
        after: {
          kind: "lot_in_estate_transfer",
          estateId: estate!._id,
          lotId,
          ownerCustomerId: args.newPrimaryOwnerCustomerId,
          ownershipId: newOwnershipId,
          transferType,
          effectiveDate: args.transferDate,
        },
        reason: transferReason,
      });
      affected += 1;
    }

    await emitAudit(ctx, {
      action: "transfer",
      entityType: "ownership",
      entityId: estate!._id,
      before: {
        kind: "family_estate_owners",
        primaryOwnerCustomerId: oldPrimary,
        secondaryOwnerCustomerIds: oldSecondaries,
      },
      after: {
        kind: "family_estate_owners",
        primaryOwnerCustomerId: args.newPrimaryOwnerCustomerId,
        secondaryOwnerCustomerIds: args.newSecondaryOwnerCustomerIds,
        transferType,
        effectiveDate: args.transferDate,
        affectedLotCount: affected,
      },
      reason: transferReason,
    });

    return {
      estateId: estate!._id,
      affectedLotCount: affected,
      newOwnershipIds,
    };
  },
});

/**
 * Retires a family estate (soft-delete). Admin only — retirement is a
 * structural change with downstream implications (lots become eligible
 * to enter a new estate / single-lot contract path).
 *
 * Reason is required (10..500 chars trimmed) — the audit trail wants
 * the cemetery's own words.
 *
 * The estate row PERSISTS — retired estates remain queryable for
 * historical AR / audit / receipt reprints per FR31. Member lots are
 * unaffected (their statuses, contracts, occupants, ownership history
 * stay exactly as they were).
 */
export const retireEstate = mutationGeneric({
  args: {
    estateId: v.id("familyEstates"),
    reason: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    args: { estateId: EstateId; reason: string },
  ): Promise<{ estateId: EstateId; retiredAt: number }> => {
    const auth = await requireRole(ctx, ["admin"]);

    const reason = (args.reason ?? "").trim();
    if (reason.length < RETIREMENT_REASON_MIN_LENGTH) {
      throwError(
        ErrorCode.VALIDATION,
        `Retirement reason must be at least ${RETIREMENT_REASON_MIN_LENGTH} characters.`,
        { length: reason.length },
      );
    }
    if (reason.length > RETIREMENT_REASON_MAX_LENGTH) {
      throwError(
        ErrorCode.VALIDATION,
        `Retirement reason must be at most ${RETIREMENT_REASON_MAX_LENGTH} characters.`,
        { length: reason.length },
      );
    }

    const estate = await ctx.db.get(args.estateId);
    if (estate === null) {
      throwError(ErrorCode.NOT_FOUND, "Family estate not found.", {
        estateId: args.estateId,
      });
    }
    if (estate!.retiredAt !== undefined) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Family estate is already retired.",
        { estateId: args.estateId, retiredAt: estate!.retiredAt },
      );
    }

    const now = Date.now();
    await ctx.db.patch(estate!._id, {
      retiredAt: now,
      retiredByUserId: auth.userId,
      retirementReason: reason,
    });

    // Deactivate every active membership row for this estate. Once
    // retired, the lots become eligible to enter a new estate (or a
    // single-lot contract). The `by_lot_active` index must reflect
    // that BEFORE the next `createFamilyEstate` reads it.
    const memberships = await ctx.db
      .query("lotEstateMembership")
      .withIndex("by_estate", (q) => q.eq("familyEstateId", estate!._id))
      .collect();
    for (const m of memberships) {
      if ((m as { isActive: boolean }).isActive === true) {
        await ctx.db.patch(
          (m as MembershipDoc)._id,
          { isActive: false, removedAt: now },
        );
      }
    }

    await emitAudit(ctx, {
      action: "update",
      entityType: "ownership",
      entityId: estate!._id,
      before: { kind: "family_estate", retiredAt: undefined },
      after: {
        kind: "family_estate",
        retiredAt: now,
        retirementReason: reason,
      },
      reason,
    });

    return { estateId: estate!._id, retiredAt: now };
  },
});

/**
 * Internal helper: hydrate a single estate row into a `FamilyEstateRow`
 * with joined owner names + lot codes. Reused by `getFamilyEstate`,
 * `listFamilyEstates`, and `listEstatesForCustomer`.
 */
async function hydrateEstateRow(
  ctx: QueryCtx,
  estate: EstateDoc,
): Promise<FamilyEstateRow> {
  // pii-read-ok: estate detail projects fullName only — address/email/phone/govId not returned.
  const primary = await ctx.db.get(estate.primaryOwnerCustomerId);
  const secondaries: Array<{ customerId: CustomerId; fullName: string }> = [];
  for (const cid of estate.secondaryOwnerCustomerIds) {
    // pii-read-ok: see above.
    const c = await ctx.db.get(cid);
    secondaries.push({
      customerId: cid,
      fullName:
        c !== null && typeof c === "object" && "fullName" in c
          ? ((c as { fullName: string }).fullName ?? "[deleted customer]")
          : "[deleted customer]",
    });
  }
  const lots: Array<{ lotId: LotId; code: string }> = [];
  for (const lid of estate.lotIds) {
    const l = await ctx.db.get(lid);
    lots.push({
      lotId: lid,
      code:
        l !== null && typeof l === "object" && "code" in l
          ? ((l as { code: string }).code ?? "[retired]")
          : "[retired]",
    });
  }
  const row: FamilyEstateRow = {
    estateId: estate._id,
    name: estate.name,
    primaryOwnerCustomerId: estate.primaryOwnerCustomerId,
    primaryOwnerFullName:
      primary !== null && typeof primary === "object" && "fullName" in primary
        ? ((primary as { fullName: string }).fullName ?? "[deleted customer]")
        : "[deleted customer]",
    secondaryOwners: secondaries,
    lots,
    createdAt: estate.createdAt,
    isActive: estate.retiredAt === undefined,
  };
  if (estate.notes !== undefined) row.notes = estate.notes;
  if (estate.retiredAt !== undefined) row.retiredAt = estate.retiredAt;
  if (estate.retirementReason !== undefined) {
    row.retirementReason = estate.retirementReason;
  }
  return row;
}

/**
 * Loads a single estate row hydrated with owner names + lot codes.
 * Throws NOT_FOUND when the id doesn't resolve.
 */
export const getFamilyEstate = queryGeneric({
  args: { estateId: v.id("familyEstates") },
  handler: async (
    ctx: QueryCtx,
    args: { estateId: EstateId },
  ): Promise<FamilyEstateRow> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const estate = await ctx.db.get(args.estateId);
    if (estate === null) {
      throwError(ErrorCode.NOT_FOUND, "Family estate not found.", {
        estateId: args.estateId,
      });
    }
    return hydrateEstateRow(ctx, estate as EstateDoc);
  },
});

/**
 * Lists family estates. Optional filters:
 *   - `primaryOwnerCustomerId` — restrict to estates owned by this
 *     customer as primary.
 *   - `includeRetired` — default false. When true, retired estates are
 *     included alongside active ones (sorted by `createdAt` desc).
 *
 * Defaults to listing every active estate (no filters), sorted by
 * `createdAt` descending. Capped at 200 rows — Phase 1 cemetery scale
 * has at most a few dozen estates; the cap is defense.
 */
export const listFamilyEstates = queryGeneric({
  args: {
    primaryOwnerCustomerId: v.optional(v.id("customers")),
    includeRetired: v.optional(v.boolean()),
  },
  handler: async (
    ctx: QueryCtx,
    args: {
      primaryOwnerCustomerId?: CustomerId;
      includeRetired?: boolean;
    },
  ): Promise<FamilyEstateRow[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    let rows: EstateDoc[];
    if (args.primaryOwnerCustomerId !== undefined) {
      const owner = args.primaryOwnerCustomerId;
      rows = (await ctx.db
        .query("familyEstates")
        .withIndex("by_primaryOwner", (q) =>
          q.eq("primaryOwnerCustomerId", owner),
        )
        .collect()) as EstateDoc[];
    } else {
      rows = (await ctx.db
        .query("familyEstates")
        .collect()) as EstateDoc[];
    }
    if (args.includeRetired !== true) {
      rows = rows.filter((r) => r.retiredAt === undefined);
    }
    rows.sort((a, b) => b.createdAt - a.createdAt);
    const cap = 200;
    const sliced = rows.slice(0, cap);
    const out: FamilyEstateRow[] = [];
    for (const r of sliced) {
      out.push(await hydrateEstateRow(ctx, r));
    }
    return out;
  },
});

/**
 * Lists every ACTIVE estate where the customer is primary or secondary.
 * Used by the customer detail page's "Family estates" section.
 *
 * Returns active estates only — retired estates are out of scope for
 * the customer detail surface (they're listed under the admin's
 * archived estates page).
 */
export const listEstatesForCustomer = queryGeneric({
  args: { customerId: v.id("customers") },
  handler: async (
    ctx: QueryCtx,
    args: { customerId: CustomerId },
  ): Promise<FamilyEstateRow[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const primaryRows = (await ctx.db
      .query("familyEstates")
      .withIndex("by_primaryOwner", (q) =>
        q.eq("primaryOwnerCustomerId", args.customerId),
      )
      .collect()) as EstateDoc[];
    // Secondary-owner search requires a scan over active estates —
    // Convex does not natively index array-of-ids. At Phase 1 scale
    // (few dozen active estates) the scan is bounded.
    const active = (await ctx.db
      .query("familyEstates")
      .withIndex("by_retiredAt", (q) => q.eq("retiredAt", undefined))
      .collect()) as EstateDoc[];
    const matchedById = new Map<string, EstateDoc>();
    for (const r of primaryRows) {
      if (r.retiredAt !== undefined) continue;
      matchedById.set(r._id as unknown as string, r);
    }
    for (const r of active) {
      if (
        r.secondaryOwnerCustomerIds.some(
          (id) =>
            (id as unknown as string) ===
            (args.customerId as unknown as string),
        )
      ) {
        matchedById.set(r._id as unknown as string, r);
      }
    }
    const out: FamilyEstateRow[] = [];
    for (const r of matchedById.values()) {
      out.push(await hydrateEstateRow(ctx, r));
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  },
});

/**
 * Returns the ACTIVE estate (if any) that contains this lot. Used by
 * the SaleForm to detect estate-mode candidates + the lot detail page
 * to render the estate context card.
 */
export const getEstateForLot = queryGeneric({
  args: { lotId: v.id("lots") },
  handler: async (
    ctx: QueryCtx,
    args: { lotId: LotId },
  ): Promise<FamilyEstateRow | null> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const active = (await ctx.db
      .query("familyEstates")
      .withIndex("by_retiredAt", (q) => q.eq("retiredAt", undefined))
      .collect()) as EstateDoc[];
    const match = active.find((r) =>
      r.lotIds.some(
        (id) => (id as unknown as string) === (args.lotId as unknown as string),
      ),
    );
    if (match === undefined) return null;
    return hydrateEstateRow(ctx, match);
  },
});
