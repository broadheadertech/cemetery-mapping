/**
 * The cemetery's offers — payment plans and promotions.
 *
 * Read `convex/lib/pricing.ts` first; the arithmetic lives there and is
 * tested there. This module is the storage and the gate around it:
 * who may change an offer, what shapes are refusable, and the one query
 * the sale desk calls to turn a lot into a figure.
 *
 * A plan is NOT a trusted path into the money. `recordFullPaymentSale`
 * and `recordInstallmentSale` still take explicit centavo amounts and
 * re-validate every one of them. A plan fills the form correctly; the
 * sale mutations remain the authority on what may be written.
 *
 * Only an admin may create or change an offer. Office staff read them
 * all day and must never be able to invent a ninety-per-cent discount
 * on the way to closing a sale.
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
import {
  checkPromo,
  planAppliesToLotType,
  quote,
  type Adjustment,
  type PlanKind,
} from "./lib/pricing";
import { readAppSettings } from "./reports";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type PlanId = DataModel["paymentPlans"]["document"]["_id"];
type PromoId = DataModel["promos"]["document"]["_id"];
type LotId = DataModel["lots"]["document"]["_id"];

const NAME_MIN = 2;
const NAME_MAX = 80;
const DESCRIPTION_MAX = 400;

const lotTypeValidator = v.union(
  v.literal("single"),
  v.literal("family"),
  v.literal("mausoleum"),
  v.literal("niche"),
);
const planKindValidator = v.union(
  v.literal("full_payment"),
  v.literal("installment"),
);

type LotType = "single" | "family" | "mausoleum" | "niche";

// --- plans ------------------------------------------------------------

export interface PlanRow {
  _id: PlanId;
  name: string;
  description?: string;
  kind: PlanKind;
  discountPercent?: number;
  downPaymentPercent?: number;
  termMonths?: number;
  surchargePercent?: number;
  appliesToLotTypes: LotType[];
  isDefault: boolean;
  sortOrder: number;
  isRetired: boolean;
}

/**
 * Every plan on offer, ordered as the cemetery arranged them.
 *
 * Office staff read this to fill the sale form, so they may run it.
 * Retired plans are included only when asked for — the admin screen
 * needs them, the sale form must not show them.
 */
export const listPaymentPlans = queryGeneric({
  args: { includeRetired: v.optional(v.boolean()) },
  handler: async (
    ctx: QueryCtx,
    args: { includeRetired?: boolean },
  ): Promise<PlanRow[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const rows = await ctx.db.query("paymentPlans").collect();
    return rows
      .filter((r) => args.includeRetired === true || !r.isRetired)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map(toPlanRow);
  },
});

export const createPaymentPlan = mutationGeneric({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    kind: planKindValidator,
    discountPercent: v.optional(v.number()),
    downPaymentPercent: v.optional(v.number()),
    termMonths: v.optional(v.number()),
    surchargePercent: v.optional(v.number()),
    appliesToLotTypes: v.optional(v.array(lotTypeValidator)),
    isDefault: v.optional(v.boolean()),
    sortOrder: v.optional(v.number()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      name: string;
      description?: string;
      kind: PlanKind;
      discountPercent?: number;
      downPaymentPercent?: number;
      termMonths?: number;
      surchargePercent?: number;
      appliesToLotTypes?: LotType[];
      isDefault?: boolean;
      sortOrder?: number;
    },
  ): Promise<{ planId: PlanId }> => {
    const auth = await requireRole(ctx, ["admin"]);

    const name = args.name.trim();
    assertName(name);
    const description = trimmedDescription(args.description);
    assertPlanShape(args);

    const now = Date.now();
    const row: Record<string, unknown> = {
      name,
      kind: args.kind,
      appliesToLotTypes: args.appliesToLotTypes ?? [],
      isDefault: args.isDefault === true,
      sortOrder: args.sortOrder ?? now,
      isRetired: false,
      createdAt: now,
      createdByUserId: auth.userId,
      updatedAt: now,
    };
    if (description !== undefined) row.description = description;
    for (const key of [
      "discountPercent",
      "downPaymentPercent",
      "termMonths",
      "surchargePercent",
    ] as const) {
      const value = args[key];
      if (value !== undefined) row[key] = value;
    }

    const planId = await ctx.db.insert("paymentPlans", row as never);

    // At most one default per kind. Cleared here rather than trusted to
    // the caller: two defaults means the sale form picks whichever the
    // sort happens to surface, which is the kind of bug nobody reports
    // and everybody works around.
    if (args.isDefault === true) {
      await clearOtherDefaults(ctx, args.kind, planId);
    }

    await emitAudit(ctx, {
      action: "create",
      entityType: "payment_plan",
      entityId: planId,
      after: { name, kind: args.kind, isDefault: args.isDefault === true },
      reason: `Payment plan "${name}" created`,
    });

    return { planId };
  },
});

export const updatePaymentPlan = mutationGeneric({
  args: {
    planId: v.id("paymentPlans"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    discountPercent: v.optional(v.number()),
    downPaymentPercent: v.optional(v.number()),
    termMonths: v.optional(v.number()),
    surchargePercent: v.optional(v.number()),
    appliesToLotTypes: v.optional(v.array(lotTypeValidator)),
    isDefault: v.optional(v.boolean()),
    sortOrder: v.optional(v.number()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      planId: PlanId;
      name?: string;
      description?: string;
      discountPercent?: number;
      downPaymentPercent?: number;
      termMonths?: number;
      surchargePercent?: number;
      appliesToLotTypes?: LotType[];
      isDefault?: boolean;
      sortOrder?: number;
    },
  ): Promise<{ planId: PlanId }> => {
    const auth = await requireRole(ctx, ["admin"]);

    const existing = await ctx.db.get(args.planId);
    if (existing === null) {
      throwError(ErrorCode.NOT_FOUND, "Payment plan not found.", {
        planId: args.planId,
      });
    }

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    patch.updatedByUserId = auth.userId;

    if (args.name !== undefined) {
      const name = args.name.trim();
      assertName(name);
      patch.name = name;
    }
    if (args.description !== undefined) {
      patch.description = trimmedDescription(args.description) ?? "";
    }
    // Shape is validated against the MERGED plan, not the patch alone —
    // clearing a term on an instalment plan is only detectable once you
    // look at what the row will become.
    assertPlanShape({
      kind: existing.kind,
      discountPercent: args.discountPercent ?? existing.discountPercent,
      downPaymentPercent:
        args.downPaymentPercent ?? existing.downPaymentPercent,
      termMonths: args.termMonths ?? existing.termMonths,
      surchargePercent: args.surchargePercent ?? existing.surchargePercent,
    });
    for (const key of [
      "discountPercent",
      "downPaymentPercent",
      "termMonths",
      "surchargePercent",
      "appliesToLotTypes",
      "sortOrder",
    ] as const) {
      const value = args[key];
      if (value !== undefined) patch[key] = value;
    }
    if (args.isDefault !== undefined) patch.isDefault = args.isDefault;

    await ctx.db.patch(args.planId, patch as never);
    if (args.isDefault === true) {
      await clearOtherDefaults(ctx, existing.kind, args.planId);
    }

    await emitAudit(ctx, {
      action: "update",
      entityType: "payment_plan",
      entityId: args.planId,
      before: { name: existing.name, isDefault: existing.isDefault },
      after: {
        name: (patch.name as string | undefined) ?? existing.name,
        isDefault: (patch.isDefault as boolean | undefined) ?? existing.isDefault,
      },
      reason: `Payment plan "${existing.name}" updated`,
    });

    return { planId: args.planId };
  },
});

/**
 * Retire a plan, or bring one back.
 *
 * Never a delete. Contracts point at plans, and a contract has to go on
 * being able to say what it was sold under long after the cemetery
 * stopped offering it.
 */
export const setPaymentPlanRetired = mutationGeneric({
  args: { planId: v.id("paymentPlans"), isRetired: v.boolean() },
  handler: async (
    ctx: MutationCtx,
    args: { planId: PlanId; isRetired: boolean },
  ): Promise<{ planId: PlanId }> => {
    const auth = await requireRole(ctx, ["admin"]);

    const existing = await ctx.db.get(args.planId);
    if (existing === null) {
      throwError(ErrorCode.NOT_FOUND, "Payment plan not found.", {
        planId: args.planId,
      });
    }

    // Retiring the default would leave the sale form opening on
    // nothing. Drop the flag with it and say so in the audit trail.
    const patch: Record<string, unknown> = {
      isRetired: args.isRetired,
      updatedAt: Date.now(),
      updatedByUserId: auth.userId,
    };
    if (args.isRetired && existing.isDefault) patch.isDefault = false;

    await ctx.db.patch(args.planId, patch as never);
    await emitAudit(ctx, {
      action: "update",
      entityType: "payment_plan",
      entityId: args.planId,
      before: { isRetired: existing.isRetired },
      after: { isRetired: args.isRetired },
      reason: `Payment plan "${existing.name}" ${
        args.isRetired ? "retired" : "reinstated"
      }`,
    });

    return { planId: args.planId };
  },
});

// --- promotions -------------------------------------------------------

export interface PromoRow {
  _id: PromoId;
  name: string;
  code?: string;
  description?: string;
  discountPercent?: number;
  discountCents?: number;
  startsAt: number;
  endsAt: number;
  appliesToLotTypes: LotType[];
  appliesToSections: string[];
  appliesToPlanKinds: PlanKind[];
  maxRedemptions?: number;
  redemptionCount: number;
  isRetired: boolean;
  /** Whether it is inside its window right now. */
  isLive: boolean;
}

export const listPromos = queryGeneric({
  args: { includeRetired: v.optional(v.boolean()) },
  handler: async (
    ctx: QueryCtx,
    args: { includeRetired?: boolean },
  ): Promise<PromoRow[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const now = Date.now();
    const rows = await ctx.db.query("promos").collect();
    return rows
      .filter((r) => args.includeRetired === true || !r.isRetired)
      .sort((a, b) => b.endsAt - a.endsAt)
      .map((r) => toPromoRow(r, now));
  },
});

export const createPromo = mutationGeneric({
  args: {
    name: v.string(),
    code: v.optional(v.string()),
    description: v.optional(v.string()),
    discountPercent: v.optional(v.number()),
    discountCents: v.optional(v.number()),
    startsAt: v.number(),
    endsAt: v.number(),
    appliesToLotTypes: v.optional(v.array(lotTypeValidator)),
    appliesToSections: v.optional(v.array(v.string())),
    appliesToPlanKinds: v.optional(v.array(planKindValidator)),
    maxRedemptions: v.optional(v.number()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      name: string;
      code?: string;
      description?: string;
      discountPercent?: number;
      discountCents?: number;
      startsAt: number;
      endsAt: number;
      appliesToLotTypes?: LotType[];
      appliesToSections?: string[];
      appliesToPlanKinds?: PlanKind[];
      maxRedemptions?: number;
    },
  ): Promise<{ promoId: PromoId }> => {
    const auth = await requireRole(ctx, ["admin"]);

    const name = args.name.trim();
    assertName(name);
    const description = trimmedDescription(args.description);
    const code = args.code?.trim().toUpperCase();
    assertPromoShape(args);

    if (code !== undefined && code.length > 0) {
      const clash = await ctx.db
        .query("promos")
        .withIndex("by_code", (q) => q.eq("code", code))
        .first();
      if (clash !== null && !clash.isRetired) {
        throwError(
          ErrorCode.VALIDATION,
          `The code ${code} is already in use by "${clash.name}".`,
          { code },
        );
      }
    }

    const now = Date.now();
    const row: Record<string, unknown> = {
      name,
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      appliesToLotTypes: args.appliesToLotTypes ?? [],
      appliesToSections: args.appliesToSections ?? [],
      appliesToPlanKinds: args.appliesToPlanKinds ?? [],
      redemptionCount: 0,
      isRetired: false,
      createdAt: now,
      createdByUserId: auth.userId,
      updatedAt: now,
    };
    if (description !== undefined) row.description = description;
    if (code !== undefined && code.length > 0) row.code = code;
    if (args.discountPercent !== undefined) {
      row.discountPercent = args.discountPercent;
    }
    if (args.discountCents !== undefined) {
      row.discountCents = args.discountCents;
    }
    if (args.maxRedemptions !== undefined) {
      row.maxRedemptions = args.maxRedemptions;
    }

    const promoId = await ctx.db.insert("promos", row as never);
    await emitAudit(ctx, {
      action: "create",
      entityType: "promo",
      entityId: promoId,
      after: {
        name,
        code: code ?? null,
        startsAt: args.startsAt,
        endsAt: args.endsAt,
      },
      reason: `Promotion "${name}" created`,
    });

    return { promoId };
  },
});

export const setPromoRetired = mutationGeneric({
  args: { promoId: v.id("promos"), isRetired: v.boolean() },
  handler: async (
    ctx: MutationCtx,
    args: { promoId: PromoId; isRetired: boolean },
  ): Promise<{ promoId: PromoId }> => {
    const auth = await requireRole(ctx, ["admin"]);

    const existing = await ctx.db.get(args.promoId);
    if (existing === null) {
      throwError(ErrorCode.NOT_FOUND, "Promotion not found.", {
        promoId: args.promoId,
      });
    }

    await ctx.db.patch(args.promoId, {
      isRetired: args.isRetired,
      updatedAt: Date.now(),
      updatedByUserId: auth.userId,
    } as never);
    await emitAudit(ctx, {
      action: "update",
      entityType: "promo",
      entityId: args.promoId,
      before: { isRetired: existing.isRetired },
      after: { isRetired: args.isRetired },
      reason: `Promotion "${existing.name}" ${
        args.isRetired ? "withdrawn" : "reinstated"
      }`,
    });

    return { promoId: args.promoId };
  },
});

// --- the quote --------------------------------------------------------

export interface QuoteOption {
  planId: PlanId;
  planName: string;
  planDescription?: string;
  kind: PlanKind;
  isDefault: boolean;
  listPriceCents: number;
  netPriceCents: number;
  totalDiscountCents: number;
  totalSurchargeCents: number;
  downPaymentCents: number;
  termMonths: number;
  indicativeMonthlyCents: number;
  adjustments: Adjustment[];
  promoId?: PromoId;
  promoName?: string;
  cappedNote?: string;
  warnings: string[];
}

export interface LotQuote {
  lotId: LotId;
  lotCode: string;
  lotType: string;
  section: string;
  listPriceCents: number;
  options: QuoteOption[];
  /** Promotions that exist but did not apply, and why. */
  promosNotApplied: Array<{ name: string; reason: string }>;
  /** True when the cemetery has configured no plans at all. */
  noPlansConfigured: boolean;
}

/**
 * Every way this lot can be bought today, priced.
 *
 * One query returning all the options rather than one per plan: the
 * office reads them side by side across a desk, and options that
 * settled at different moments could disagree about which promotion was
 * still running.
 *
 * The best promotion for each plan is chosen automatically — a family
 * is never quoted a worse price because the operator did not know an
 * offer existed. Promotions that did NOT apply come back with a reason,
 * so "the All Souls offer ended on 5 November" can be said out loud
 * instead of an unexplained absence.
 */
export const quoteLot = queryGeneric({
  args: {
    lotId: v.id("lots"),
    /** A code the family produced. Applied only if it is valid. */
    promoCode: v.optional(v.string()),
    manualDiscountCents: v.optional(v.number()),
  },
  handler: async (
    ctx: QueryCtx,
    args: {
      lotId: LotId;
      promoCode?: string;
      manualDiscountCents?: number;
    },
  ): Promise<LotQuote> => {
    await requireRole(ctx, ["admin", "office_staff"]);

    const lot = await ctx.db.get(args.lotId);
    if (lot === null) {
      throwError(ErrorCode.NOT_FOUND, "Lot not found.", { lotId: args.lotId });
    }

    const { maxDiscountPercent } = await readAppSettings(ctx);
    const now = Date.now();

    const plans = (await ctx.db.query("paymentPlans").collect())
      .filter((p) => !p.isRetired)
      .filter((p) => planAppliesToLotType(p.appliesToLotTypes, lot.type))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

    const allPromos = (await ctx.db.query("promos").collect()).filter(
      (p) => !p.isRetired,
    );

    // A code the family produced narrows the field to that one offer.
    // Without a code, every uncoded promotion is a candidate and the
    // best is chosen — but a coded offer is never applied by accident,
    // which is the point of having a code.
    const typed = args.promoCode?.trim().toUpperCase();
    const candidates =
      typed !== undefined && typed.length > 0
        ? allPromos.filter((p) => p.code === typed)
        : allPromos.filter((p) => p.code === undefined || p.code.length === 0);

    const notApplied = new Map<string, string>();
    const options: QuoteOption[] = [];

    for (const plan of plans) {
      const eligible = candidates.filter((p) => {
        const check = checkPromo(
          {
            name: p.name,
            startsAt: p.startsAt,
            endsAt: p.endsAt,
            appliesToLotTypes: p.appliesToLotTypes,
            appliesToSections: p.appliesToSections,
            appliesToPlanKinds: p.appliesToPlanKinds,
            ...(p.maxRedemptions !== undefined
              ? { maxRedemptions: p.maxRedemptions }
              : {}),
            redemptionCount: p.redemptionCount,
          },
          {
            now,
            lotType: lot.type,
            section: lot.section,
            planKind: plan.kind,
          },
        );
        if (!check.eligible && check.reason !== undefined) {
          notApplied.set(p.name, check.reason);
        }
        return check.eligible;
      });

      // Best for the family, computed rather than assumed: a flat
      // ₱5,000 beats 5% on a cheap lot and loses on an expensive one,
      // and nobody should have to work that out at a counter.
      let best: (typeof eligible)[number] | undefined;
      let bestQuote = quote({
        listPriceCents: lot.basePriceCents,
        plan: toPlanTerms(plan),
        ...(args.manualDiscountCents !== undefined
          ? { manualDiscountCents: args.manualDiscountCents }
          : {}),
        maxDiscountPercent,
      });

      for (const promo of eligible) {
        const withPromo = quote({
          listPriceCents: lot.basePriceCents,
          plan: toPlanTerms(plan),
          promo: {
            name: promo.name,
            ...(promo.discountPercent !== undefined
              ? { discountPercent: promo.discountPercent }
              : {}),
            ...(promo.discountCents !== undefined
              ? { discountCents: promo.discountCents }
              : {}),
          },
          ...(args.manualDiscountCents !== undefined
            ? { manualDiscountCents: args.manualDiscountCents }
            : {}),
          maxDiscountPercent,
        });
        if (withPromo.netPriceCents < bestQuote.netPriceCents) {
          bestQuote = withPromo;
          best = promo;
        }
      }

      const option: QuoteOption = {
        planId: plan._id,
        planName: plan.name,
        kind: plan.kind,
        isDefault: plan.isDefault,
        listPriceCents: bestQuote.listPriceCents,
        netPriceCents: bestQuote.netPriceCents,
        totalDiscountCents: bestQuote.totalDiscountCents,
        totalSurchargeCents: bestQuote.totalSurchargeCents,
        downPaymentCents: bestQuote.downPaymentCents,
        termMonths: bestQuote.termMonths,
        indicativeMonthlyCents: bestQuote.indicativeMonthlyCents,
        adjustments: bestQuote.adjustments,
        warnings: bestQuote.warnings,
      };
      if (plan.description !== undefined) {
        option.planDescription = plan.description;
      }
      if (best !== undefined) {
        option.promoId = best._id;
        option.promoName = best.name;
      }
      if (bestQuote.cappedNote !== undefined) {
        option.cappedNote = bestQuote.cappedNote;
      }
      options.push(option);
    }

    // A promotion applied to at least one plan is not "not applied",
    // whatever a stricter plan said about it.
    for (const o of options) {
      if (o.promoName !== undefined) notApplied.delete(o.promoName);
    }

    return {
      lotId: lot._id,
      lotCode: lot.code,
      lotType: lot.type,
      section: lot.section,
      listPriceCents: lot.basePriceCents,
      options,
      promosNotApplied: [...notApplied.entries()].map(([name, reason]) => ({
        name,
        reason,
      })),
      noPlansConfigured: plans.length === 0,
    };
  },
});

// --- helpers ----------------------------------------------------------

function toPlanRow(row: DataModel["paymentPlans"]["document"]): PlanRow {
  const out: PlanRow = {
    _id: row._id,
    name: row.name,
    kind: row.kind,
    appliesToLotTypes: row.appliesToLotTypes,
    isDefault: row.isDefault,
    sortOrder: row.sortOrder,
    isRetired: row.isRetired,
  };
  if (row.description !== undefined) out.description = row.description;
  if (row.discountPercent !== undefined) {
    out.discountPercent = row.discountPercent;
  }
  if (row.downPaymentPercent !== undefined) {
    out.downPaymentPercent = row.downPaymentPercent;
  }
  if (row.termMonths !== undefined) out.termMonths = row.termMonths;
  if (row.surchargePercent !== undefined) {
    out.surchargePercent = row.surchargePercent;
  }
  return out;
}

function toPromoRow(
  row: DataModel["promos"]["document"],
  now: number,
): PromoRow {
  const out: PromoRow = {
    _id: row._id,
    name: row.name,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    appliesToLotTypes: row.appliesToLotTypes,
    appliesToSections: row.appliesToSections,
    appliesToPlanKinds: row.appliesToPlanKinds,
    redemptionCount: row.redemptionCount,
    isRetired: row.isRetired,
    isLive: !row.isRetired && now >= row.startsAt && now < row.endsAt,
  };
  if (row.code !== undefined) out.code = row.code;
  if (row.description !== undefined) out.description = row.description;
  if (row.discountPercent !== undefined) {
    out.discountPercent = row.discountPercent;
  }
  if (row.discountCents !== undefined) out.discountCents = row.discountCents;
  if (row.maxRedemptions !== undefined) {
    out.maxRedemptions = row.maxRedemptions;
  }
  return out;
}

function toPlanTerms(row: {
  name: string;
  kind: PlanKind;
  discountPercent?: number;
  downPaymentPercent?: number;
  termMonths?: number;
  surchargePercent?: number;
}) {
  return {
    name: row.name,
    kind: row.kind,
    ...(row.discountPercent !== undefined
      ? { discountPercent: row.discountPercent }
      : {}),
    ...(row.downPaymentPercent !== undefined
      ? { downPaymentPercent: row.downPaymentPercent }
      : {}),
    ...(row.termMonths !== undefined ? { termMonths: row.termMonths } : {}),
    ...(row.surchargePercent !== undefined
      ? { surchargePercent: row.surchargePercent }
      : {}),
  };
}

async function clearOtherDefaults(
  ctx: MutationCtx,
  kind: PlanKind,
  keepId: PlanId,
): Promise<void> {
  const siblings = await ctx.db
    .query("paymentPlans")
    .withIndex("by_kind", (q) => q.eq("kind", kind))
    .collect();
  for (const s of siblings) {
    if (s._id !== keepId && s.isDefault) {
      await ctx.db.patch(s._id, { isDefault: false } as never);
    }
  }
}

function assertName(name: string): void {
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    throwError(
      ErrorCode.VALIDATION,
      `Name must be between ${NAME_MIN} and ${NAME_MAX} characters.`,
    );
  }
}

function trimmedDescription(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > DESCRIPTION_MAX) {
    throwError(
      ErrorCode.VALIDATION,
      `Description must be ${DESCRIPTION_MAX} characters or fewer.`,
    );
  }
  return trimmed;
}

/**
 * Refuse a plan that cannot produce a sale.
 *
 * The pricing module warns about these so the operator sees WHICH plan
 * is wrong; this refuses to store them in the first place. Both are
 * worth having — the warning covers rows that already exist.
 */
function assertPlanShape(plan: {
  kind: PlanKind;
  discountPercent?: number;
  downPaymentPercent?: number;
  termMonths?: number;
  surchargePercent?: number;
}): void {
  for (const [label, value] of [
    ["Discount", plan.discountPercent],
    ["Down payment", plan.downPaymentPercent],
    ["Surcharge", plan.surchargePercent],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throwError(
        ErrorCode.VALIDATION,
        `${label} must be a percentage between 0 and 100.`,
        { value },
      );
    }
  }

  if (plan.kind === "installment") {
    const term = plan.termMonths;
    if (
      term === undefined ||
      !Number.isInteger(term) ||
      term < 1 ||
      term > 60
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "An instalment plan needs a term between 1 and 60 months.",
        { termMonths: term ?? null },
      );
    }
    // The sale mutation refuses a zero-down instalment outright, so a
    // plan that asks for one can never close a sale. Better to refuse
    // it here than to ship a plan that fails at the counter.
    const down = plan.downPaymentPercent;
    if (down === undefined || down <= 0) {
      throwError(
        ErrorCode.VALIDATION,
        "An instalment plan needs a down payment above zero — the sale flow refuses a zero-deposit contract.",
        { downPaymentPercent: down ?? null },
      );
    }
    if (down >= 100) {
      throwError(
        ErrorCode.VALIDATION,
        "A down payment of the whole price is a full payment, not an instalment plan.",
        { downPaymentPercent: down },
      );
    }
  }
}

function assertPromoShape(promo: {
  discountPercent?: number;
  discountCents?: number;
  startsAt: number;
  endsAt: number;
  maxRedemptions?: number;
}): void {
  const pct = promo.discountPercent;
  const cents = promo.discountCents;

  if (pct === undefined && cents === undefined) {
    throwError(
      ErrorCode.VALIDATION,
      "A promotion needs either a percentage or a peso amount off.",
    );
  }
  if (pct !== undefined && cents !== undefined) {
    throwError(
      ErrorCode.VALIDATION,
      "A promotion carries a percentage or a peso amount, not both.",
    );
  }
  if (pct !== undefined && (!Number.isFinite(pct) || pct <= 0 || pct > 100)) {
    throwError(
      ErrorCode.VALIDATION,
      "The percentage off must be between 0 and 100.",
      { discountPercent: pct },
    );
  }
  if (
    cents !== undefined &&
    (!Number.isInteger(cents) || cents <= 0)
  ) {
    throwError(
      ErrorCode.VALIDATION,
      "The amount off must be a positive whole number of centavos.",
      { discountCents: cents },
    );
  }
  if (
    !Number.isInteger(promo.startsAt) ||
    !Number.isInteger(promo.endsAt) ||
    promo.endsAt <= promo.startsAt
  ) {
    throwError(
      ErrorCode.VALIDATION,
      "The promotion must end after it starts.",
      { startsAt: promo.startsAt, endsAt: promo.endsAt },
    );
  }
  const cap = promo.maxRedemptions;
  if (cap !== undefined && (!Number.isInteger(cap) || cap < 1)) {
    throwError(
      ErrorCode.VALIDATION,
      "A redemption limit must be a whole number of at least one.",
      { maxRedemptions: cap },
    );
  }
}
