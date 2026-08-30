/**
 * Someone has died and the family is at the desk.
 *
 * This is the worst moment to be paging through inventory. The office
 * needs one question answered — where can this person be buried, today
 * — and the answer has three possible sources and no others:
 *
 *   1. A lot the family already owns, with room left.
 *   2. A lot their family owns, through a family estate.
 *   3. An empty lot they can buy.
 *
 * Nothing else is offered. A lot belonging to another family is never a
 * candidate, whatever its capacity.
 *
 * Every option is returned with the reason it can or cannot be used
 * right now — room, and whether an installment contract has been paid
 * far enough to permit an interment. A lot that cannot take the burial
 * today is still shown, with what is standing in the way, because
 * "₱30,000 more on the contract" is something a family can decide about
 * at the counter. Hiding it would send them away to buy a second plot
 * they do not need.
 */

import {
  type DataModelFromSchemaDefinition,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import { ErrorCode, throwError } from "./lib/errors";
import { createOccupant } from "./occupants";
import { createScheduledInterment } from "./interments";
import { capacityReport } from "./lib/lotCapacity";
import { checkIntermentEligibility } from "./lib/intermentEligibility";
import { readAppSettings } from "./reports";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type CustomerId = DataModel["customers"]["document"]["_id"];
type LotId = DataModel["lots"]["document"]["_id"];
type OccupantId = DataModel["occupants"]["document"]["_id"];
type IntermentId = DataModel["interments"]["document"]["_id"];

/** How the family is connected to a lot. */
export type LotRelation = "owned" | "family_estate";

export interface ExistingLotOption {
  lotId: LotId;
  code: string;
  section: string;
  status: string;
  relation: LotRelation;
  /** Which estate, when the claim comes through one. */
  estateName?: string;
  bodiesRemaining: number;
  bonesRemaining: number;
  hasRoom: boolean;
  /** Whether an interment may be scheduled here today. */
  canInterNow: boolean;
  /** What is standing in the way, when it cannot. */
  blockedReason?: string;
  /** Outstanding amount needed to reach the payment threshold. */
  shortfallCents?: number;
}

export interface QuickIntermentOptions {
  customerName: string;
  /** Lots the family can use, best first. */
  existing: ExistingLotOption[];
  /** True when none of their lots can take the burial today. */
  needsNewLot: boolean;
  /**
   * Why buying is being suggested — so the office can explain it rather
   * than appearing to upsell a grieving family.
   */
  needsNewLotReason?: string;
}

/** A lot the family may use, and how they reach it. */
export interface LotClaim {
  relation: LotRelation;
  estateName?: string;
}

/**
 * Every lot this customer's family may bury in, and nothing else.
 *
 * This is the authority for the user's rule — a quick interment goes
 * into an empty lot they buy, a lot they own, or a lot their family
 * owns. It is shared by the query that lists options and the mutation
 * that books one, deliberately: a UI that filters the list is a
 * convenience, and the mutation re-runs this so a hand-made request
 * cannot bury someone in a stranger's plot.
 */
export async function resolveFamilyClaims(
  ctx: QueryCtx,
  customerId: CustomerId,
): Promise<Map<string, LotClaim>> {
  const claims = new Map<string, LotClaim>();

  const ownerships = await ctx.db
    .query("ownerships")
    .withIndex("by_customer", (q) => q.eq("customerId", customerId))
    .collect();
  for (const o of ownerships) {
    // A transferred-away lot is not theirs any more.
    if (o.effectiveTo !== undefined) continue;
    claims.set(o.lotId, { relation: "owned" });
  }

  // Family estates: theirs if they are the primary owner or named on
  // it. Walked rather than looked up, because membership lives in
  // `secondaryOwnerCustomerIds` — an array, which Convex cannot index
  // by element. The `by_retiredAt` index at least narrows this to the
  // live estates; a cemetery has tens of them, not thousands.
  //
  // Collected in full rather than capped: a `take(n)` here would
  // silently drop an estate, and the family would be told they own
  // nothing while their plot sits in the ground.
  const estates = await ctx.db
    .query("familyEstates")
    .withIndex("by_retiredAt", (q) => q.eq("retiredAt", undefined))
    .collect();
  for (const estate of estates) {
    const isMember =
      estate.primaryOwnerCustomerId === customerId ||
      estate.secondaryOwnerCustomerIds.includes(customerId);
    if (!isMember) continue;
    for (const lotId of estate.lotIds) {
      // A lot they own outright stays labelled as theirs; the estate
      // claim only fills in lots they would not otherwise reach.
      if (claims.has(lotId)) continue;
      claims.set(lotId, { relation: "family_estate", estateName: estate.name });
    }
  }

  return claims;
}

/**
 * Where can this family bury someone?
 *
 * Ordered so the option requiring nothing of them comes first: a lot
 * with room that is already paid for, then one blocked only by a
 * balance, then one that is simply full.
 */
export const findLotsForFamily = queryGeneric({
  args: { customerId: v.id("customers") },
  handler: async (
    ctx: QueryCtx,
    args: { customerId: CustomerId },
  ): Promise<QuickIntermentOptions> => {
    await requireRole(ctx, ["admin", "office_staff"]);

    const customer = await ctx.db.get(args.customerId);
    const customerName = customer?.fullName ?? "This customer";

    const claims = await resolveFamilyClaims(ctx, args.customerId);

    // --- assess each one -------------------------------------------
    const { intermentPaymentThresholdPercent } = await readAppSettings(ctx);
    const existing: ExistingLotOption[] = [];

    for (const [lotId, claim] of claims) {
      const lot = await ctx.db.get(lotId as LotId);
      if (lot === null || lot.isRetired) continue;

      const occupants = await ctx.db
        .query("occupants")
        .withIndex("by_lot", (q) => q.eq("lotId", lot._id))
        .collect();
      const room = capacityReport(lot, occupants);

      const option: ExistingLotOption = {
        lotId: lot._id,
        code: lot.code,
        section: lot.section,
        status: lot.status,
        relation: claim.relation,
        bodiesRemaining: room.bodiesRemaining,
        bonesRemaining: room.bonesRemaining,
        hasRoom: room.bodiesRemaining > 0,
        canInterNow: false,
      };
      if (claim.estateName !== undefined) option.estateName = claim.estateName;

      if (!option.hasRoom) {
        option.blockedReason =
          room.bonesRemaining > 0
            ? `No room for a burial — space remains only for transferred remains.`
            : `This lot is full.`;
        existing.push(option);
        continue;
      }

      // An interment needs the lot sold or already in use; an available
      // lot they own has not been contracted yet.
      if (lot.status !== "sold" && lot.status !== "occupied") {
        option.blockedReason = `The lot is ${lot.status} — it needs a contract before an interment can be scheduled.`;
        existing.push(option);
        continue;
      }

      const contracts = await ctx.db
        .query("contracts")
        .withIndex("by_lot", (q) => q.eq("lotId", lot._id))
        .collect();
      const open = contracts.find(
        (c) => c.state === "active" || c.state === "in_default",
      );

      if (open === undefined) {
        option.canInterNow = true;
        existing.push(option);
        continue;
      }

      const installments = await ctx.db
        .query("installments")
        .withIndex("by_contract", (q) => q.eq("contractId", open._id))
        .collect();
      const paidCents = installments.reduce((t, i) => t + i.paidCents, 0);

      const eligibility = checkIntermentEligibility(
        {
          totalPriceCents: open.totalPriceCents,
          paidCents,
          state: open.state,
        },
        intermentPaymentThresholdPercent,
      );
      option.canInterNow = eligibility.eligible;
      if (!eligibility.eligible) {
        option.blockedReason = eligibility.reason;
        option.shortfallCents = eligibility.shortfallCents;
      }
      existing.push(option);
    }

    // Usable first; then blocked only by money; then full.
    existing.sort((a, b) => {
      if (a.canInterNow !== b.canInterNow) return a.canInterNow ? -1 : 1;
      if (a.hasRoom !== b.hasRoom) return a.hasRoom ? -1 : 1;
      return a.code.localeCompare(b.code);
    });

    const usable = existing.filter((o) => o.canInterNow);
    const result: QuickIntermentOptions = {
      customerName,
      existing,
      needsNewLot: usable.length === 0,
    };

    if (usable.length === 0) {
      result.needsNewLotReason =
        existing.length === 0
          ? `${customerName} holds no lot, so one will need to be chosen.`
          : `None of the family's lots can take a burial today — see what each one needs below.`;
    }

    return result;
  },
});

/**
 * Record the deceased and book their interment, in one transaction.
 *
 * The desk flow is two facts — who died, and which lot — and the office
 * should not have to perform two mutations that can half-succeed. A
 * partial failure here leaves an occupant recorded in a lot with no
 * burial booked, which reads to the next staffer as a person already
 * buried. Convex mutations are transactional, so this either records
 * both or neither.
 *
 * The ownership rule is enforced HERE, not in the page. The query that
 * lists options is a convenience; this is the gate. Everything after it
 * — capacity, lot state, the payment threshold, double-booking across
 * interments and ceremonies — comes from the same helpers the ordinary
 * booking path uses, so nothing about being quick makes it laxer.
 */
export const bookQuickInterment = mutationGeneric({
  args: {
    customerId: v.id("customers"),
    lotId: v.id("lots"),
    deceasedName: v.string(),
    dateOfDeath: v.number(),
    relationshipToOwner: v.string(),
    intermentKind: v.optional(
      v.union(v.literal("body"), v.literal("bones")),
    ),
    scheduledAt: v.number(),
    notes: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      customerId: CustomerId;
      lotId: LotId;
      deceasedName: string;
      dateOfDeath: number;
      relationshipToOwner: string;
      intermentKind?: "body" | "bones";
      scheduledAt: number;
      notes?: string;
    },
  ): Promise<{ occupantId: OccupantId; intermentId: IntermentId }> => {
    const auth = await requireRole(ctx, ["admin", "office_staff"]);

    // The rule, restated server-side: an empty lot they have bought, a
    // lot they own, or a lot their family owns. A lot belonging to
    // someone else is refused however it arrived in the request.
    const claims = await resolveFamilyClaims(ctx, args.customerId);
    const claim = claims.get(args.lotId);
    if (claim === undefined) {
      const customer = await ctx.db.get(args.customerId);
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        `This lot does not belong to ${customer?.fullName ?? "this customer"} or their family. Record the sale or the transfer first.`,
        {
          kind: "LOT_NOT_CLAIMED_BY_FAMILY",
          lotId: args.lotId,
          customerId: args.customerId,
        },
      );
    }

    // A burial cannot precede the death. Cheap to check, and the kind
    // of transposed date that is very hard to spot once it is in the
    // record and printed on a plaque.
    if (args.scheduledAt < startOfDay(args.dateOfDeath)) {
      throwError(
        ErrorCode.VALIDATION,
        "The interment cannot be scheduled before the date of death.",
        { scheduledAt: args.scheduledAt, dateOfDeath: args.dateOfDeath },
      );
    }

    const { occupantId } = await createOccupant(ctx, auth, {
      lotId: args.lotId,
      name: args.deceasedName,
      dateOfDeath: args.dateOfDeath,
      relationshipToOwner: args.relationshipToOwner,
      ...(args.intermentKind !== undefined
        ? { intermentKind: args.intermentKind }
        : {}),
      ...(args.notes !== undefined ? { notes: args.notes } : {}),
    });

    const { intermentId } = await createScheduledInterment(ctx, auth, {
      lotId: args.lotId,
      occupantId,
      scheduledAt: args.scheduledAt,
      notes: args.notes ?? "booked at the desk (quick response)",
    });

    return { occupantId, intermentId };
  },
});

/**
 * Midnight of the day a timestamp falls on, in Manila.
 *
 * The comparison is between a date the family reports (a day, from a
 * certificate) and a booking (a day and a time). Comparing the raw
 * values would reject a burial scheduled at 8am on the day of death —
 * unusual, but it happens, and the system should not be the thing that
 * says no.
 */
function startOfDay(ms: number): number {
  const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const local = ms + MANILA_OFFSET_MS;
  return local - (local % DAY_MS) - MANILA_OFFSET_MS;
}
