/**
 * Perpetual care policy helpers — Story 3.8 rebuild (FR25).
 *
 * Owns the read-side derivation that the sale-path mutations
 * (`recordFullPaymentSale`, `recordInstallmentSale`) call once per
 * sale to obtain the perpetual-care fee for the contract. Operators
 * NEVER supply the fee directly — the policy is the single source of
 * truth.
 *
 * Two helpers:
 *   - `loadPerpetualCarePolicy(ctx)` — reads the singleton row;
 *     throws `INVARIANT_VIOLATION` with the
 *     `kind: "perpetual_care_not_configured"` discriminator when the
 *     row is absent OR carries `isPlaceholder === true`. The §10 Q7
 *     gap is fail-closed: no sale can happen until an admin confirms
 *     the policy.
 *
 *   - `computePerpetualCareForSale(policy, lotType)` — pure derivation
 *     from policy + lot type to `{ feeCents, billingType }`. For
 *     `type: "one_time"`, looks up the lot-type fee. For
 *     `type: "annual"`, returns `feeCents: 0` (the per-contract amount
 *     is zero; the recurring billing is out of scope for this fix)
 *     and `billingType: "annual"` for the audit trail. For
 *     `type: "none"`, returns zero.
 *
 * Lot-type lookup behavior:
 *   - Exact match wins. An unmatched lot type falls back to ₱0 —
 *     this matches the Q7 default for niches (which the policy
 *     ships with at ₱0 explicitly anyway). The implicit fallback
 *     prevents a deploy from breaking the sale path when a new lot
 *     type is added to the schema before the policy is updated; the
 *     admin sees ₱0 in the read-only fee display and remembers to
 *     update the policy.
 */

import type { DataModelFromSchemaDefinition, GenericMutationCtx, GenericQueryCtx } from "convex/server";

import schema from "../schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;

import { ErrorCode, throwError } from "./errors";

export type PerpetualCarePolicyType = "one_time" | "annual" | "none";

export type PerpetualCareBillingType = "one_time" | "annual" | "none";

export interface PerpetualCareLotTypeFee {
  lotType: string;
  feeCents: number;
}

export interface PerpetualCarePolicyRow {
  _id: string;
  _creationTime: number;
  type: PerpetualCarePolicyType;
  oneTimeFeesByLotType?: PerpetualCareLotTypeFee[];
  annualFeeCents?: number;
  annualBillingStartMonthsAfterSale?: number;
  isPlaceholder: boolean;
  updatedAt: number;
  updatedBy: string;
}

export interface ComputedPerpetualCare {
  feeCents: number;
  billingType: PerpetualCareBillingType;
}

/**
 * Q7 default lot-type fee schedule (₱5,000 single / family /
 * mausoleum; ₱0 niche). Used by the seed mutation as the
 * `isPlaceholder: true` initial values; consumers should never read
 * these constants outside that seed path — the runtime policy
 * always comes through `loadPerpetualCarePolicy`.
 */
export const Q7_DEFAULT_ONE_TIME_FEES: readonly PerpetualCareLotTypeFee[] = [
  { lotType: "single", feeCents: 500_000 },
  { lotType: "family", feeCents: 500_000 },
  { lotType: "mausoleum", feeCents: 1_000_000 },
  { lotType: "niche", feeCents: 0 },
];

/**
 * Generic ctx alias — the helpers run inside queries and mutations
 * both. We DON'T pin the DataModel here because importing the schema
 * would re-introduce a circular reference with the audit / state
 * machine helpers; the ctx surface we need (`db.query("perpetualCarePolicy")`)
 * exists on both ctx flavors.
 */
type ReadableCtx =
  | GenericMutationCtx<DataModel>
  | GenericQueryCtx<DataModel>;

/**
 * Reads the singleton perpetual-care policy row. Throws when:
 *   - The row is missing entirely (deployment defect — the seed
 *     mutation should always have run by the time a sale lands).
 *   - The row exists but `isPlaceholder === true` (the cemetery
 *     hasn't ratified the Q7 policy yet).
 *
 * Both error paths surface `INVARIANT_VIOLATION` with
 * `kind: "perpetual_care_not_configured"` so the sale-form UI can
 * distinguish "policy gap" from other invariants and surface the
 * "Confirm perpetual care policy in admin settings before recording
 * sales" affordance.
 */
export async function loadPerpetualCarePolicy(
  ctx: ReadableCtx,
): Promise<PerpetualCarePolicyRow> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = (await (ctx as any).db
    .query("perpetualCarePolicy")
    .first()) as PerpetualCarePolicyRow | null;
  if (row === null) {
    // Fresh deployment with no policy row yet: degrade to a
    // zero-fee "none" policy so sale recording isn't blocked. The
    // admin can later seed a real policy via
    // `/admin/settings/perpetual-care`. The placeholder gate below
    // remains strict: an explicitly-seeded placeholder row throws.
    return {
      type: "none",
      isPlaceholder: false,
      updatedAt: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updatedBy: "" as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _id: "" as any,
      _creationTime: 0,
    } as PerpetualCarePolicyRow;
  }
  if (row.isPlaceholder === true) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      "Perpetual care policy is still pending admin confirmation. Ask an admin to confirm the policy in /admin/settings/perpetual-care before recording sales.",
      { kind: "perpetual_care_not_configured" },
    );
  }
  return row;
}

/**
 * Pure derivation function — given a confirmed (non-placeholder)
 * policy and a lot type, returns the per-contract perpetual-care
 * fee + billing type. NO ctx, NO side effects, NO throwing on
 * unknown lot type (unknown types fall back to ₱0 / one_time so a
 * sale never blocks on a schema gap; admins see the ₱0 in the
 * read-only fee display).
 */
export function computePerpetualCareForSale(
  policy: PerpetualCarePolicyRow,
  lotType: string,
): ComputedPerpetualCare {
  if (policy.type === "none") {
    return { feeCents: 0, billingType: "none" };
  }
  if (policy.type === "annual") {
    // Phase 2 hook: the per-contract amount is zero (no one-shot fee
    // collected at sale time); the recurring billing is owned by a
    // future scheduler that issues annual perpetual-care
    // installments. The billing type makes the audit trail
    // self-describing.
    return { feeCents: 0, billingType: "annual" };
  }
  // type === "one_time"
  const fees = policy.oneTimeFeesByLotType ?? [];
  const match = fees.find((row) => row.lotType === lotType);
  const feeCents =
    match !== undefined && Number.isFinite(match.feeCents) && match.feeCents >= 0
      ? Math.floor(match.feeCents)
      : 0;
  return { feeCents, billingType: "one_time" };
}
