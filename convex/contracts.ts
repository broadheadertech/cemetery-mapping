/**
 * Contract domain (Story 3.3, FR19 / FR23).
 *
 * Public surface for the `contracts` table — the aggregate that ties a
 * lot, a customer, and the financial events that paid for it together.
 * This story (3.3) introduces the table and the first consumer flow:
 * the full-payment sale.
 *
 * Conventions every handler obeys (mirrored from `convex/lots.ts` and
 * `convex/customers.ts`):
 *
 *   1. FIRST awaited statement is `await requireRole(ctx, [...])`. The
 *      ESLint rule `local-rules/require-role-first-line` enforces this.
 *   2. Mutations call `emitAudit` — direct `auditLog` inserts are
 *      banned by `local-rules/no-audit-log-direct-write`.
 *   3. Financial-table writes (`payments`, `receipts`,
 *      `paymentAllocations`) NEVER happen directly here — they route
 *      through `postFinancialEvent` (Story 3.2 cornerstone). The
 *      `local-rules/no-direct-financial-write` rule enforces this.
 *   4. Lot status transitions route through `transitionLotStatus`
 *      (Story 1.7 / 1.8). Direct `ctx.db.patch(..., { status })` is
 *      banned by `local-rules/no-raw-status-patch`.
 *   5. Money is stored as INTEGER centavos (`totalPriceCents`).
 *
 * The `recordFullPaymentSale` mutation orchestrates the one-shot sale:
 *
 *   a. Validate inputs (lot is `available`, customer exists, price > 0,
 *      reference required for non-cash methods).
 *   b. Insert the contract row (state `paid_in_full` for full-payment
 *      sales — the matching payment + receipt are written in the same
 *      Convex mutation transaction, so the contract IS paid in full the
 *      moment the transaction commits).
 *   c. Transition the lot from `available` to `sold` via
 *      `transitionLotStatus`.
 *   d. Post the financial event (payment + receipt + allocation + audit)
 *      via `postFinancialEvent`. The allocation targets the contract
 *      we just created.
 *   e. Patch the contract row with the resulting `paymentId` /
 *      `receiptId` back-pointers.
 *   f. Emit a `create` audit row for the contract itself.
 *
 * Atomicity: every step inside `recordFullPaymentSale` runs inside the
 * enclosing Convex mutation's transaction. A throw anywhere (e.g. the
 * lot was concurrently sold to another customer and the
 * `assertTransition` inside `transitionLotStatus` raises
 * `ILLEGAL_STATE_TRANSITION`) rolls back ALL writes: no contract row,
 * no payment, no receipt, no audit. The UI catches the error and
 * surfaces it inline.
 *
 * Idempotency: the cornerstone's `idempotencyKey` mechanism handles a
 * double-submitted sale. A retry with the same key + same payload
 * returns the same `{ paymentId, receiptId }`; the contract row is
 * patched again with the same back-pointers (no-op). A retry with the
 * same key + a different payload throws
 * `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD` from the cornerstone.
 *
 * Story callers:
 *   - `src/components/SaleForm/SaleForm.tsx` (Full Payment tab) calls
 *     `recordFullPaymentSale` via `useMutation`.
 *   - `src/app/(staff)/contracts/[contractId]/page.tsx` calls
 *     `getContract` via `useQuery` for the contract detail view.
 *   - `src/app/(staff)/sales/page.tsx` calls `listContracts` via
 *     `useQuery` for the sales / contracts list view.
 *   - Future Story 3.4 (installment sale) introduces
 *     `recordInstallmentSale` alongside this mutation; the contract
 *     table is the shared substrate.
 */

import {
  type DataModelFromSchemaDefinition,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import { emitAudit } from "./lib/audit";
import { ErrorCode, throwError } from "./lib/errors";
import { generateInstallmentSchedule } from "./lib/installmentSchedule";
import {
  computePerpetualCareForSale,
  loadPerpetualCarePolicy,
} from "./lib/perpetualCare";
import { postFinancialEvent } from "./lib/postFinancialEvent";
import {
  transitionContractState,
  transitionLotStatus,
} from "./lib/stateMachines";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ContractDoc = DataModel["contracts"]["document"];
type ContractId = ContractDoc["_id"];
type LotId = DataModel["lots"]["document"]["_id"];
type CustomerId = DataModel["customers"]["document"]["_id"];
type PaymentId = DataModel["payments"]["document"]["_id"];
type ReceiptId = DataModel["receipts"]["document"]["_id"];

/**
 * Payment-method literal union accepted by `recordFullPaymentSale`.
 *
 * Phase 1 surfaces three methods on the office-staff sale flow: cash,
 * check, and bank transfer. The cornerstone's `payments.paymentMethod`
 * union also accepts `gcash` / `maya` / `card` — those land in Epic 9's
 * customer-portal flow, not the office-staff sale flow. Keeping the
 * surface narrow here forces a deliberate choice in Epic 9 about which
 * roles can record card / e-wallet payments.
 */
const saleMethodValidator = v.union(
  v.literal("cash"),
  v.literal("check"),
  v.literal("bank_transfer"),
);

export type SaleMethod = "cash" | "check" | "bank_transfer";

/**
 * Public arg shape for `recordFullPaymentSale`. Mirrors the validator
 * below. Exported so the React form + tests can typecheck against the
 * mutation's contract.
 */
export interface RecordFullPaymentSaleArgs {
  lotId: LotId;
  customerId: CustomerId;
  totalPriceCents: number;
  method: SaleMethod;
  reference?: string;
  paidAt: number;
  idempotencyKey: string;
  /**
   * Story 3.5 (FR22) — optional discount + rationale.
   *
   * `basePriceCents` is the lot's listed price BEFORE the discount;
   * `discountCents` is the absolute peso (cent) amount removed from
   * the base; `discountReason` is the office-staff-supplied
   * justification (≥ 5 chars when discountCents > 0). When omitted,
   * the cornerstone treats the sale as discount-free and writes
   * `basePriceCents = totalPriceCents`, `discountCents = 0`.
   *
   * Server-side invariants:
   *   - `basePriceCents - discountCents === totalPriceCents`.
   *   - `0 <= discountCents <= basePriceCents`.
   *   - When `discountCents > 0`, `discountReason` length ≥ 5 chars
   *     (trimmed); when `discountCents === 0`, `discountReason` MUST
   *     be undefined or empty (defensive — a reason without a
   *     discount is a programming bug).
   */
  basePriceCents?: number;
  discountCents?: number;
  discountReason?: string;
  // Story 3.8 rebuild (FR25): perpetual-care fee is DERIVED server-side
  // from the `perpetualCarePolicy` singleton + the lot's type. Operators
  // can NO LONGER supply the fee or its reason via this arg surface —
  // doing so was the original 3.8 adversarial-review defect. The
  // `basePriceCents` field above is the LOT'S LISTED price (after any
  // operator discount); the server adds the perpetual-care derivation
  // on top and writes the post-addon total into `totalPriceCents`.
  // `totalPriceCents` from the client is the pre-addon expected total
  // (basePriceCents − discountCents); the server then writes the
  // contract row with `totalPriceCents + derivedPerpetualCare`.

  // Story 2.9 (FR15 brand-tier extension) — estate-mode opt-in.
  //
  // When set, the contract is bound to a family estate: every member
  // lot in `familyEstates.lotIds` is transitioned to `sold` atomically.
  // The caller MUST still supply `lotId` — it is validated to be a
  // member of the estate's lot list (the SaleForm uses
  // `estate.lotIds[0]` as the canonical anchor) and serves as the
  // contract row's `lotId`. The mutation rejects with VALIDATION when
  // the supplied lot is not in the estate, and rejects with
  // ILLEGAL_STATE_TRANSITION if any OTHER member lot is not currently
  // `available`. Single-lot semantics are unchanged when this field is
  // omitted.
  familyEstateId?: string;
}

/**
 * Public return shape for `recordFullPaymentSale`. The UI uses these
 * fields to: (a) route to `/contracts/[contractId]`, (b) render the
 * receipt number in the success dialog, (c) open the print dialog
 * against the printable receipt.
 */
export interface RecordFullPaymentSaleResult {
  contractId: ContractId;
  contractNumber: string;
  paymentId: PaymentId;
  receiptId: ReceiptId;
  receiptNumber: string;
}

/**
 * Story 3.5 — discount payload normalisation + validation (FR22).
 *
 * Resolves the three optional discount inputs against the (already
 * validated, positive integer) `totalPriceCents` and returns the
 * canonical record-shaped triple the contract row will store. Throws
 * `ConvexError(VALIDATION | INVARIANT_VIOLATION)` on any rule break;
 * callers invoke this BEFORE touching the lot / customer / cornerstone
 * so a failed invariant rolls back nothing.
 *
 * Rules (mirror the schema doc-comment on `contracts.basePriceCents` /
 * `contracts.discountCents` / `contracts.discountReason`):
 *
 *   - When NONE of `basePriceCents` / `discountCents` / `discountReason`
 *     are supplied: default to `basePriceCents = totalPriceCents`,
 *     `discountCents = 0`, `discountReason = undefined`. This is the
 *     "no discount" path Story 3.3 / 3.4 sales travel.
 *
 *   - When `basePriceCents` is supplied (or `discountCents > 0`):
 *     - `basePriceCents` MUST be a positive integer.
 *     - `discountCents` MUST be a non-negative integer (defaults to 0).
 *     - `0 <= discountCents <= basePriceCents` — server-side guard
 *       against negative discounts and discounts that drive the price
 *       below zero (an attempt to do so is a programming bug or a
 *       hostile client).
 *     - `basePriceCents - discountCents === totalPriceCents` — the
 *       arithmetic invariant the UI's price summary depends on. A
 *       mismatch means the client computed the total differently than
 *       the server expects; we reject rather than silently coerce.
 *     - When `discountCents > 0`, `discountReason` (after trim) MUST
 *       be ≥ 5 chars — every applied discount needs a recorded
 *       business rationale. The reason is free text; the UI guidance
 *       is "Family loyalty," "Manager override per Mr. Reyes," etc.
 *     - When `discountCents === 0`, `discountReason` MUST be undefined
 *       or empty (a reason without a discount is a programming bug;
 *       we reject defensively so the contract row never gains a stray
 *       reason field).
 */
interface NormalisedDiscount {
  basePriceCents: number;
  discountCents: number;
  discountReason: string | undefined;
}

function normalizeDiscountInputs(args: {
  totalPriceCents: number;
  basePriceCents: number | undefined;
  discountCents: number | undefined;
  discountReason: string | undefined;
}): NormalisedDiscount {
  const trimmedReason =
    typeof args.discountReason === "string"
      ? args.discountReason.trim()
      : "";
  const reasonProvided = trimmedReason.length > 0;
  const baseProvided = args.basePriceCents !== undefined;
  const discountProvided = args.discountCents !== undefined;

  // No-discount default path. Callers that omit every field land here.
  if (!baseProvided && !discountProvided && !reasonProvided) {
    return {
      basePriceCents: args.totalPriceCents,
      discountCents: 0,
      discountReason: undefined,
    };
  }

  // Once any discount field is supplied, the cornerstone enforces all
  // three invariants (base + discount + reason) consistently.
  const basePriceCents = baseProvided
    ? (args.basePriceCents as number)
    : args.totalPriceCents;
  const discountCents = discountProvided
    ? (args.discountCents as number)
    : 0;

  if (
    !Number.isFinite(basePriceCents) ||
    !Number.isInteger(basePriceCents) ||
    basePriceCents <= 0
  ) {
    throwError(
      ErrorCode.VALIDATION,
      "Base price must be a positive integer in centavos.",
      { basePriceCents },
    );
  }
  if (
    !Number.isFinite(discountCents) ||
    !Number.isInteger(discountCents) ||
    discountCents < 0
  ) {
    throwError(
      ErrorCode.VALIDATION,
      "Discount must be a non-negative integer in centavos.",
      { discountCents },
    );
  }
  if (discountCents > basePriceCents) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      "Discount cannot exceed the base price.",
      { discountCents, basePriceCents },
    );
  }
  if (basePriceCents - discountCents !== args.totalPriceCents) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      "Base price minus discount must equal total price.",
      {
        basePriceCents,
        discountCents,
        totalPriceCents: args.totalPriceCents,
        expectedTotal: basePriceCents - discountCents,
      },
    );
  }
  if (discountCents > 0) {
    if (trimmedReason.length < 5) {
      throwError(
        ErrorCode.VALIDATION,
        "Discount reason must be at least 5 characters.",
        { reasonLength: trimmedReason.length },
      );
    }
    if (trimmedReason.length > 280) {
      throwError(
        ErrorCode.VALIDATION,
        "Discount reason must be at most 280 characters.",
        { reasonLength: trimmedReason.length },
      );
    }
  } else if (reasonProvided) {
    // Defensive: a reason without a discount is a programming bug. We
    // reject so the contract row never gains a stray reason field.
    throwError(
      ErrorCode.VALIDATION,
      "Discount reason can only accompany a discount (discountCents > 0).",
      { reasonLength: trimmedReason.length },
    );
  }

  return {
    basePriceCents,
    discountCents,
    discountReason: discountCents > 0 ? trimmedReason : undefined,
  };
}

/**
 * Generates a human-readable contract number for a freshly-created
 * full-payment sale.
 *
 * Phase 1 format: `CON-YYYYMMDD-<lotCode>-<rand4>` where `rand4` is a
 * 4-digit random suffix derived from `Date.now()` so concurrent sales
 * of different lots in the same second do not collide.
 *
 * The contract number is for HUMAN reference (cemetery's paper books,
 * BIR audit lookups); the database join key is the Convex `_id`. A
 * collision on this number is not a data-integrity issue — the
 * `by_contractNumber` index supports duplicate keys — but the rand4
 * suffix makes the chance vanishingly small in practice.
 */
function makeContractNumber(now: number, lotCode: string): string {
  const date = new Date(now);
  const yyyy = date.getUTCFullYear().toString().padStart(4, "0");
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = date.getUTCDate().toString().padStart(2, "0");
  const rand4 = (now % 10000).toString().padStart(4, "0");
  // Strip non-alphanumeric chars from the lot code for safety; the
  // contract number ends up on PDFs and downstream report exports.
  const safeLotCode = lotCode.replace(/[^A-Za-z0-9-]/g, "") || "LOT";
  return `CON-${yyyy}${mm}${dd}-${safeLotCode}-${rand4}`;
}

/**
 * Records a full-payment sale (Story 3.3, FR19).
 *
 * Authorization: office_staff or admin. Field workers do NOT sell;
 * customer-role callers never have access to this surface. The
 * `require-role-first-line` rule (Story 1.2) verifies `requireRole` is
 * the handler's first action.
 *
 * Validation (in order, cheapest first):
 *   - `totalPriceCents` must be a positive integer (basis: money math
 *     is integer-only — ADR-0007).
 *   - `method !== "cash"` implies a non-empty `reference` (mirrors the
 *     cemetery's BIR-recording practice — every cheque / bank transfer
 *     needs a reference number for reconciliation).
 *   - The lot must exist and be in status `available`. If the lot has
 *     already been sold to someone else (concurrent sale), the
 *     `transitionLotStatus` call below raises `ILLEGAL_STATE_TRANSITION`
 *     and the entire transaction rolls back. We surface the error
 *     pre-transition with a friendlier message when the lot is already
 *     non-available at read time; the state-machine catch covers the
 *     race window between read and transition.
 *   - The customer must exist (we read the row to surface a clear
 *     `NOT_FOUND` error rather than the opaque cornerstone error
 *     `recordFullPaymentSale` would otherwise produce).
 *
 * Side effects (in transaction order):
 *   1. Insert the contract row in state `paid_in_full`. The state is
 *      `paid_in_full` (not `active`) because the matching payment
 *      lands in the same transaction; the contract is fully paid the
 *      moment the transaction commits.
 *   2. Transition the lot from `available` to `sold` via
 *      `transitionLotStatus`. The helper emits a transition audit row
 *      for the lot.
 *   3. Post the financial event via `postFinancialEvent`:
 *        - Payment row with method + reference + idempotency key.
 *        - Receipt row with a serial allocated from the receipt
 *          counter (Story 3.1).
 *        - One allocation row targeting the contract we just created.
 *        - Audit row with action `create` for the receipt.
 *   4. Patch the contract row with `paymentId` + `receiptId`
 *      back-pointers from the cornerstone result.
 *   5. Emit a `create` audit row for the contract itself.
 *
 * Throws:
 *   - `UNAUTHENTICATED` / `FORBIDDEN` — auth gate.
 *   - `VALIDATION` — price / reference invariants.
 *   - `NOT_FOUND` — lot or customer does not exist.
 *   - `INVARIANT_VIOLATION` — lot is not available; or any other
 *     pre-transition invariant fails (e.g. lot is retired).
 *   - `ILLEGAL_STATE_TRANSITION` — concurrent sale between our read
 *     and our transition. The UI catches this and instructs the user
 *     to refresh.
 *   - `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD` — programming
 *     bug; the same UUID was reused with a different financial intent.
 */
export const recordFullPaymentSale = mutationGeneric({
  args: {
    lotId: v.id("lots"),
    customerId: v.id("customers"),
    totalPriceCents: v.number(),
    method: saleMethodValidator,
    reference: v.optional(v.string()),
    paidAt: v.number(),
    idempotencyKey: v.string(),
    // Story 3.5 (FR22) — optional discount fields.
    basePriceCents: v.optional(v.number()),
    discountCents: v.optional(v.number()),
    discountReason: v.optional(v.string()),
    // Story 3.8 rebuild (FR25): perpetual-care fee + reason are NO
    // LONGER accepted from the client. Server derives the fee from
    // `perpetualCarePolicy` + lot type.
    // Story 2.9 (FR15 brand-tier extension) — optional estate-mode FK.
    familyEstateId: v.optional(v.id("familyEstates")),
  },
  handler: async (
    ctx: MutationCtx,
    args: RecordFullPaymentSaleArgs,
  ): Promise<RecordFullPaymentSaleResult> => {
    const auth = await requireRole(ctx, ["admin", "office_staff"]);

    // Step 1: Cheap defensive validation. `totalPriceCents` from the
    // client is the PRE-PERPETUAL-CARE total — i.e. `basePriceCents
    // − discountCents`. The server adds the policy-derived perpetual-
    // care fee on top to produce the final contract `totalPriceCents`.
    if (
      !Number.isFinite(args.totalPriceCents) ||
      !Number.isInteger(args.totalPriceCents) ||
      args.totalPriceCents <= 0
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "Total price must be a positive integer in centavos.",
        { totalPriceCents: args.totalPriceCents },
      );
    }
    const reference =
      args.reference !== undefined && args.reference.trim().length > 0
        ? args.reference.trim()
        : undefined;
    if (args.method !== "cash" && reference === undefined) {
      throwError(
        ErrorCode.VALIDATION,
        "Reference number is required for cheque and bank transfer payments.",
        { method: args.method },
      );
    }
    if (!args.idempotencyKey || args.idempotencyKey.trim().length === 0) {
      throwError(
        ErrorCode.VALIDATION,
        "Idempotency key is required.",
      );
    }

    // Step 1b: Story 3.5 (FR22) — discount invariants. The client's
    // `totalPriceCents` is the post-discount, PRE-perpetual-care net
    // — i.e. `basePriceCents − discountCents`. The normaliser asserts
    // that arithmetic before we touch the lot / cornerstone.
    const fullDiscount = normalizeDiscountInputs({
      totalPriceCents: args.totalPriceCents,
      basePriceCents: args.basePriceCents,
      discountCents: args.discountCents,
      discountReason: args.discountReason,
    });

    // Step 2: Load + validate the lot.
    const lot = await ctx.db.get(args.lotId);
    if (lot === null) {
      throwError(ErrorCode.NOT_FOUND, "Lot not found.", { lotId: args.lotId });
    }
    if (lot.isRetired) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Cannot sell a retired lot.",
        { lotId: args.lotId },
      );
    }
    if (lot.status !== "available") {
      // Pre-transition friendly error. The state-machine call below
      // covers the race-window case (lot read as available, transitioned
      // by another mutation before our patch lands).
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        `Lot is not available for sale (current status: ${lot.status}).`,
        { lotId: args.lotId, status: lot.status },
      );
    }

    // Step 3: Load + validate the customer.
    // pii-read-ok: validation lookup in sale path — customer fields not returned to caller; only existence is asserted
    const customer = await ctx.db.get(args.customerId);
    if (customer === null) {
      throwError(ErrorCode.NOT_FOUND, "Customer not found.", {
        customerId: args.customerId,
      });
    }

    // Step 3a: Story 2.9 (FR15) — estate-mode validation. When the
    // caller supplies `familyEstateId`, we verify the estate exists,
    // is active, contains the supplied `lotId`, and every OTHER member
    // lot is currently `available` (otherwise the atomic group sale
    // cannot proceed). We capture the sibling lot ids here; the
    // transitions happen alongside the canonical-anchor lot transition
    // below so the whole bulk move stays inside one transaction.
    let estateSiblingLotIds: LotId[] = [];
    if (args.familyEstateId !== undefined) {
      const estate = await ctx.db.get(
        args.familyEstateId as unknown as DataModel["familyEstates"]["document"]["_id"],
      );
      if (estate === null) {
        throwError(ErrorCode.NOT_FOUND, "Family estate not found.", {
          familyEstateId: args.familyEstateId,
        });
      }
      if (estate!.retiredAt !== undefined) {
        throwError(
          ErrorCode.INVARIANT_VIOLATION,
          "Cannot sell a retired family estate.",
          { familyEstateId: args.familyEstateId },
        );
      }
      const memberIdStrs = estate!.lotIds.map(
        (id) => id as unknown as string,
      );
      if (!memberIdStrs.includes(args.lotId as unknown as string)) {
        throwError(
          ErrorCode.VALIDATION,
          "Supplied lotId is not a member of the family estate.",
          { lotId: args.lotId, familyEstateId: args.familyEstateId },
        );
      }
      // Defense in depth: re-assert the estate's primary owner matches
      // the customer we're selling to. The SaleForm gates on this, but
      // a hand-crafted payload should not slip past.
      if (
        (estate!.primaryOwnerCustomerId as unknown as string) !==
        (args.customerId as unknown as string)
      ) {
        throwError(
          ErrorCode.VALIDATION,
          "Customer must be the estate's primary owner.",
          {
            customerId: args.customerId,
            primaryOwnerCustomerId: estate!.primaryOwnerCustomerId,
          },
        );
      }
      // Walk every sibling lot up front: they must exist, be non-
      // retired, and be `available`. Mirrors the per-lot check the
      // canonical anchor already passed above.
      estateSiblingLotIds = estate!.lotIds.filter(
        (id) => (id as unknown as string) !== (args.lotId as unknown as string),
      ) as LotId[];
      for (const sibling of estateSiblingLotIds) {
        const sLot = await ctx.db.get(sibling);
        if (sLot === null) {
          throwError(ErrorCode.NOT_FOUND, "Estate member lot not found.", {
            lotId: sibling,
          });
        }
        if (sLot!.isRetired) {
          throwError(
            ErrorCode.INVARIANT_VIOLATION,
            "Estate member lot is retired.",
            { lotId: sibling },
          );
        }
        if (sLot!.status !== "available") {
          throwError(
            ErrorCode.INVARIANT_VIOLATION,
            `Estate member lot is not available for sale (current status: ${sLot!.status}).`,
            { lotId: sibling, status: sLot!.status },
          );
        }
      }
    }

    // Step 3b: Story 3.8 rebuild (FR25) — derive perpetual-care fee
    // from the policy + lot type. `loadPerpetualCarePolicy` throws
    // `INVARIANT_VIOLATION { kind: "perpetual_care_not_configured" }`
    // when the singleton row is missing OR still flagged
    // `isPlaceholder: true`, so a sale CANNOT happen until an admin
    // has confirmed the policy. The derived `feeCents` is added to
    // the client's `totalPriceCents` to produce the final contract
    // total — operators can no longer supply the fee directly.
    //
    // Annual-billing carve-out: `computePerpetualCareForSale` returns
    // `feeCents: 0` for `type: "annual"` policies; the per-contract
    // amount is zero and the recurring billing scheduler (out of
    // scope for this fix) owns the per-year invoicing.
    const perpetualCarePolicy = await loadPerpetualCarePolicy(ctx);
    const derivedPerpetualCare = computePerpetualCareForSale(
      perpetualCarePolicy,
      lot.type,
    );
    const contractTotalCents =
      args.totalPriceCents + derivedPerpetualCare.feeCents;
    const derivedReason =
      derivedPerpetualCare.feeCents > 0
        ? `Per ${perpetualCarePolicy.type} policy (lot type ${lot.type})`
        : undefined;

    const now = Date.now();
    const contractNumber = makeContractNumber(now, lot.code);

    // Step 4: Insert the contract row. State is `paid_in_full` for
    // full-payment sales — the matching payment + receipt write in the
    // same transaction, so by the time the transaction commits the
    // contract IS fully paid.
    //
    // Story 3.5 (FR22): every contract row carries the discount triple
    // (`basePriceCents`, `discountCents`, `discountReason`). The
    // no-discount path writes `basePriceCents = totalPriceCents` and
    // `discountCents = 0`; the discount path writes the real values
    // and a trimmed rationale.
    //
    // Story 3.8 rebuild (FR25): `perpetualCareCents` carries the
    // policy-derived fee. Full payment sales collect the addon in the
    // same financial event as the base price, so `perpetualCarePaidCents`
    // equals `perpetualCareCents` from the moment the contract row lands.
    type ContractInsert = DataModel["contracts"]["document"] extends infer Doc
      ? Omit<Doc, "_id" | "_creationTime">
      : never;
    const contractRow: ContractInsert = {
      contractNumber,
      lotId: args.lotId,
      customerId: args.customerId,
      kind: "full_payment",
      totalPriceCents: contractTotalCents,
      state: "paid_in_full",
      createdAt: now,
      createdBy: auth.userId,
      basePriceCents: fullDiscount.basePriceCents,
      discountCents: fullDiscount.discountCents,
      perpetualCareCents: derivedPerpetualCare.feeCents,
      perpetualCarePaidCents: derivedPerpetualCare.feeCents,
    };
    if (fullDiscount.discountReason !== undefined) {
      contractRow.discountReason = fullDiscount.discountReason;
    }
    if (derivedReason !== undefined) {
      contractRow.perpetualCareReason = derivedReason;
    }
    // Story 2.9 — bind the contract to the estate when estate-mode is
    // active. Downstream queries (AR aging rollup, receipt PDF, contract
    // detail) read this field to switch into the estate surface.
    if (args.familyEstateId !== undefined) {
      contractRow.familyEstateId =
        args.familyEstateId as unknown as DataModel["familyEstates"]["document"]["_id"];
    }
    const contractId = await ctx.db.insert("contracts", contractRow);

    // Step 5: Transition the lot from `available` to `sold`. The helper
    // re-reads the lot inside the same transaction, so a concurrent
    // sale that landed between our read above and this transition will
    // raise `ILLEGAL_STATE_TRANSITION`, rolling back the entire
    // transaction (the contract insert above is undone).
    await transitionLotStatus(ctx, {
      lotId: args.lotId,
      to: "sold",
      // The lot transition table (stateMachines.ts) does not REQUIRE a
      // reason for `available → sold`. We pass a descriptive reason
      // anyway so the audit log distinguishes sale-induced transitions
      // from manual admin transitions (when the latter ship).
      reason: args.familyEstateId !== undefined
        ? `Estate-bound sale (contract ${contractNumber}, anchor lot)`
        : `Full-payment sale (contract ${contractNumber})`,
    });

    // Story 2.9 — fan out the same transition across every sibling lot
    // in the estate. Each `transitionLotStatus` call is inside the same
    // mutation transaction; a failure on any sibling rolls back the
    // anchor transition + the contract insert above.
    for (const sibling of estateSiblingLotIds) {
      await transitionLotStatus(ctx, {
        lotId: sibling,
        to: "sold",
        reason: `Estate-bound sale (contract ${contractNumber}, sibling lot)`,
      });
    }

    // Step 6: Post the financial event via the cornerstone. This
    // writes: payment + receipt + 1 allocation + receipt audit.
    //
    // Story 3.8 rebuild: the payment amount is the post-addon
    // contract total (`contractTotalCents`) — the customer pays the
    // base + the derived perpetual-care fee in the same lump sum.
    const financialResult = await postFinancialEvent(ctx, {
      kind: "sale",
      idempotencyKey: args.idempotencyKey,
      payment: {
        amountCents: contractTotalCents,
        paymentMethod: args.method,
        reference,
        receivedAt: args.paidAt,
        receivedByUserId: auth.userId,
        contractId: contractId,
        customerId: args.customerId,
      },
      allocations: [
        {
          targetType: "contract",
          targetId: contractId,
          amountCents: contractTotalCents,
          sequence: 0,
        },
      ],
    });

    // Step 7: Patch the contract row with the payment + receipt
    // back-pointers. The cornerstone returned non-null paymentId for
    // `kind: "sale"` (the void path returns null; we're not in that
    // path here).
    if (financialResult.paymentId === null) {
      // Defensive — the cornerstone only returns null for the void
      // path. If we reach this branch, the cornerstone contract has
      // drifted; fail loudly rather than write a half-linked contract.
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "postFinancialEvent returned null paymentId for a sale event.",
      );
    }
    await ctx.db.patch(contractId, {
      paymentId: financialResult.paymentId,
      receiptId: financialResult.receiptId,
    });

    // Step 8: Emit a `create` audit row for the contract itself. The
    // receipt audit row already landed inside `postFinancialEvent`;
    // the contract is a separate aggregate and deserves its own row.
    //
    // Story 3.5 (FR22): the audit `after` snapshot carries the
    // discount triple verbatim. `discountReason` is business reason —
    // NOT PII — so `emitAudit`'s `redactPii` whitelist intentionally
    // leaves it intact.
    const auditAfter: Record<string, unknown> = {
      contractNumber,
      lotId: args.lotId,
      customerId: args.customerId,
      kind: "full_payment",
      totalPriceCents: contractTotalCents,
      state: "paid_in_full",
      paymentId: financialResult.paymentId,
      receiptId: financialResult.receiptId,
      receiptNumber: financialResult.receiptNumber,
      basePriceCents: fullDiscount.basePriceCents,
      discountCents: fullDiscount.discountCents,
      // Story 3.8 rebuild (FR25) — derived perpetual-care snapshot.
      // The reason is operational context (policy reference), NOT PII,
      // so `emitAudit`'s redaction whitelist leaves it intact.
      perpetualCareCents: derivedPerpetualCare.feeCents,
      perpetualCarePaidCents: derivedPerpetualCare.feeCents,
      perpetualCareBillingType: derivedPerpetualCare.billingType,
    };
    if (fullDiscount.discountReason !== undefined) {
      auditAfter.discountReason = fullDiscount.discountReason;
    }
    if (derivedReason !== undefined) {
      auditAfter.perpetualCareReason = derivedReason;
    }
    // Story 2.9 — record the estate binding in the audit row so the
    // breach-impact / reconciliation queries can correlate the contract
    // with the estate without a secondary join.
    if (args.familyEstateId !== undefined) {
      auditAfter.familyEstateId = args.familyEstateId;
      auditAfter.estateSiblingLotIds = estateSiblingLotIds;
    }
    await emitAudit(ctx, {
      action: "create",
      entityType: "contract",
      entityId: contractId,
      after: auditAfter,
    });

    return {
      contractId,
      contractNumber,
      paymentId: financialResult.paymentId,
      receiptId: financialResult.receiptId,
      receiptNumber: financialResult.receiptNumber,
    };
  },
});

/**
 * Public arg shape for `recordInstallmentSale` (Story 3.4, FR20 / FR21).
 *
 * Mirrors the validator below; exported so the React form + Vitest
 * suite can typecheck against the mutation's contract.
 */
export interface InstallmentInput {
  installmentNumber: number;
  dueDate: number;
  principalCents: number;
}

export interface RecordInstallmentSaleArgs {
  lotId: LotId;
  customerId: CustomerId;
  totalPriceCents: number;
  downPaymentCents: number;
  termMonths: number;
  monthlyAmountCents: number;
  firstDueDate: number;
  installments: InstallmentInput[];
  method: SaleMethod;
  reference?: string;
  paidAt: number;
  idempotencyKey: string;
  /**
   * Story 3.5 (FR22) — optional discount + rationale.
   *
   * Same semantics as `RecordFullPaymentSaleArgs`: `totalPriceCents`
   * is the net-of-discount amount the customer ultimately pays across
   * the down payment + installment schedule;
   * `basePriceCents - discountCents === totalPriceCents` is the
   * arithmetic invariant the cornerstone enforces. The discount is
   * applied to the lot's base price BEFORE the installment schedule
   * is generated, so each row in `installments` reflects the
   * post-discount remainder.
   */
  basePriceCents?: number;
  discountCents?: number;
  discountReason?: string;
  // Story 3.8 rebuild (FR25): perpetual-care fee + reason are NO
  // LONGER accepted from the client. Server derives the fee from
  // `perpetualCarePolicy` + lot type. The derived fee is COLLECTED
  // VIA THE DOWN PAYMENT — the down-payment row absorbs the addon.
  // Rationale: cash-flow predictability for the cemetery; the
  // perpetual-care fee is collected up front rather than spread
  // across installments where a defaulted contract would leave the
  // cemetery with an unfunded perpetual-care obligation.
  //
  // Operationally: the client's `totalPriceCents` is the PRE-addon
  // total (base − discount). The client's `downPaymentCents` must
  // be the pre-addon down payment; the server adds the derived
  // perpetual-care fee to BOTH the contract total AND the down
  // payment before posting the financial event. Installment-schedule
  // principals reflect the pre-addon remainder and are unchanged.

  // Story 2.9 (FR15 brand-tier extension) — optional estate-mode FK.
  // Same semantics as on `RecordFullPaymentSaleArgs`: when set, every
  // member lot in `familyEstates.lotIds` is transitioned to `sold` in
  // the same transaction as the canonical-anchor `lotId`. Validation
  // is identical.
  familyEstateId?: string;
}

/**
 * Public return shape for `recordInstallmentSale`.
 *
 * Mirrors `RecordFullPaymentSaleResult` plus a count of inserted
 * installment rows so the UI can confirm the schedule landed before
 * navigating away. `paymentId` / `receiptId` are populated only when
 * the down payment is non-zero — a zero-down installment sale skips
 * the financial event entirely (no receipt for ₱0) and leaves both
 * fields undefined on the contract row.
 */
export interface RecordInstallmentSaleResult {
  contractId: ContractId;
  contractNumber: string;
  installmentCount: number;
  paymentId: PaymentId | null;
  receiptId: ReceiptId | null;
  receiptNumber: string | null;
}

/**
 * Records an installment sale (Story 3.4, FR20 / FR21).
 *
 * Authorization: office_staff or admin. Mirrors `recordFullPaymentSale`'s
 * gate (Story 3.3).
 *
 * Validation (in order, cheapest first):
 *   - `totalPriceCents`, `downPaymentCents`, `monthlyAmountCents` must
 *     each be non-negative integers (`totalPriceCents` strictly > 0).
 *   - `termMonths` must be a positive integer in [1, 60].
 *   - `downPaymentCents` must be strictly less than `totalPriceCents`
 *     (otherwise the caller wants `recordFullPaymentSale`).
 *   - `installments.length === termMonths` — the caller must send the
 *     full schedule it computed client-side; the cornerstone re-checks
 *     the math rather than re-deriving it from `firstDueDate` alone.
 *     This is defense-in-depth: an attacker can supply a different
 *     schedule than what `SchedulePreview` showed, and we reject it.
 *   - Each installment row's `installmentNumber` is unique in [1..N];
 *     `principalCents` is a positive integer; `dueDate` is monotonically
 *     increasing (so the schedule is well-ordered).
 *   - `downPaymentCents + sum(installments.principalCents) === totalPriceCents`
 *     — every centavo is accounted for. Failure throws
 *     `ALLOCATION_SUM_MISMATCH` (re-using the cornerstone's vocabulary
 *     for "sum doesn't add up").
 *   - The lot must exist, be non-retired, and be in status `available`.
 *   - The customer must exist.
 *   - `method !== "cash"` implies a non-empty `reference` (only when a
 *     down payment is being recorded; ₱0 down skips the payment event
 *     entirely and so skips this check).
 *
 * Side effects (in transaction order):
 *   1. Insert the contract row (state `active`, kind `installment`).
 *      `paymentId` / `receiptId` are filled in after the down-payment
 *      event lands; the contract's installment-specific columns
 *      (`downPaymentCents`, `termMonths`, `monthlyAmountCents`,
 *      `firstDueDate`) are written here.
 *   2. Transition the lot from `available` to `sold` via
 *      `transitionLotStatus`. Per the system-message clarification —
 *      `sold` is the canonical Phase 1 lot-state for any signed sale;
 *      `available → sold` is in the lot state machine. A future Epic 4
 *      default flow may flip the lot back to `defaulted` per FR37.
 *   3. If `downPaymentCents > 0`: post the down-payment financial event
 *      via `postFinancialEvent`. The allocation targets the contract
 *      we just created. Patch the contract row with the resulting
 *      `paymentId` / `receiptId` back-pointers.
 *   4. Insert each installment row in order. `installmentNumber` is
 *      taken from the caller's array (already validated above);
 *      `paidCents` starts at 0; `status` starts at `pending`.
 *   5. Emit a `create` audit row for the contract aggregate (separate
 *      from the cornerstone's receipt audit row + the lot transition
 *      audit row).
 *
 * Atomicity: every step runs inside the enclosing Convex mutation
 * transaction. A throw anywhere rolls back every insert / patch /
 * audit emission. There is no "almost-committed" installment contract.
 *
 * Idempotency: a retried call with the same `idempotencyKey` + same
 * payload is deduped INSIDE the cornerstone (`postFinancialEvent`).
 * The contract row + installments would be inserted twice on a naive
 * retry — to prevent that, the caller-supplied `idempotencyKey` is
 * ALSO checked against the existing-contract surface here via the
 * down-payment lookup: if a payment with this key already exists and
 * its contract back-pointer is set, we return the existing contract's
 * id instead of inserting a duplicate. ₱0-down sales used to skip the
 * payment step and so could not dedupe through the cornerstone —
 * Epic-3/4 adversarial-review HIGH fix: such sales now hard-reject
 * with `ZERO_DOWN_NOT_SUPPORTED` (see the inline guard at the top of
 * the handler). A future dedicated dedup table would allow lifting
 * the rejection.
 *
 * Schedule tampering defense (Epic-3/4 HIGH): after the row-shape
 * validation passes, the server re-derives the canonical schedule via
 * `generateInstallmentSchedule` (shared lib at
 * `convex/lib/installmentSchedule.ts`) and compares the client's
 * supplied dueDates / principals row-by-row. Any mismatch throws
 * `SCHEDULE_TAMPERED` with `details.kind === "schedule_tampered"`
 * carrying the first divergent row + the server's expected value. A
 * faithful client (the SaleForm) never trips this gate because it
 * uses the same shared helper.
 *
 * Throws:
 *   - `UNAUTHENTICATED` / `FORBIDDEN` — auth gate.
 *   - `VALIDATION` — price / term / reference / installment-array
 *     shape invariants.
 *   - `ZERO_DOWN_NOT_SUPPORTED` — `downPaymentCents === 0`. See
 *     idempotency block above for the rationale.
 *   - `SCHEDULE_TAMPERED` — client schedule does not match the
 *     server-derived schedule (defense in depth).
 *   - `NOT_FOUND` — lot or customer does not exist.
 *   - `INVARIANT_VIOLATION` — lot is not available / is retired.
 *   - `ALLOCATION_SUM_MISMATCH` — down payment + installments
 *     principal sum does not equal `totalPriceCents`.
 *   - `ILLEGAL_STATE_TRANSITION` — concurrent sale between our read
 *     and our transition.
 *   - `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD` — same key with
 *     a different down-payment payload.
 */
export const recordInstallmentSale = mutationGeneric({
  args: {
    lotId: v.id("lots"),
    customerId: v.id("customers"),
    totalPriceCents: v.number(),
    downPaymentCents: v.number(),
    termMonths: v.number(),
    monthlyAmountCents: v.number(),
    firstDueDate: v.number(),
    installments: v.array(
      v.object({
        installmentNumber: v.number(),
        dueDate: v.number(),
        principalCents: v.number(),
      }),
    ),
    method: saleMethodValidator,
    reference: v.optional(v.string()),
    paidAt: v.number(),
    idempotencyKey: v.string(),
    // Story 3.5 (FR22) — optional discount fields.
    basePriceCents: v.optional(v.number()),
    discountCents: v.optional(v.number()),
    discountReason: v.optional(v.string()),
    // Story 3.8 rebuild (FR25): perpetual-care fee + reason are NO
    // LONGER accepted from the client. Server derives the fee from
    // `perpetualCarePolicy` + lot type.
    // Story 2.9 (FR15 brand-tier extension) — optional estate-mode FK.
    familyEstateId: v.optional(v.id("familyEstates")),
  },
  handler: async (
    ctx: MutationCtx,
    args: RecordInstallmentSaleArgs,
  ): Promise<RecordInstallmentSaleResult> => {
    const auth = await requireRole(ctx, ["admin", "office_staff"]);

    // Step 1: Cheap defensive validation.
    if (
      !Number.isFinite(args.totalPriceCents) ||
      !Number.isInteger(args.totalPriceCents) ||
      args.totalPriceCents <= 0
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "Total price must be a positive integer in centavos.",
        { totalPriceCents: args.totalPriceCents },
      );
    }
    if (
      !Number.isFinite(args.downPaymentCents) ||
      !Number.isInteger(args.downPaymentCents) ||
      args.downPaymentCents < 0
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "Down payment must be a non-negative integer in centavos.",
        { downPaymentCents: args.downPaymentCents },
      );
    }
    if (args.downPaymentCents >= args.totalPriceCents) {
      throwError(
        ErrorCode.VALIDATION,
        "Down payment must be less than the total price. Use the full-payment flow instead.",
        {
          downPaymentCents: args.downPaymentCents,
          totalPriceCents: args.totalPriceCents,
        },
      );
    }
    // Epic-3/4 adversarial-review HIGH fix: reject zero-down installment
    // sales as a hard rule (`ZERO_DOWN_NOT_SUPPORTED`).
    //
    // Background: this mutation's idempotency short-circuit pivots on
    // `payments.by_idempotency`. Zero-down sales skip the down-payment
    // financial event entirely (no payment row is written), so a
    // double-click on submit bypasses dedupe and produces a duplicate
    // contract + duplicate installment rows. The original spec assumed
    // zero-down was non-functional; until a dedicated
    // `recordInstallmentSale` dedup table lands, the safer behaviour
    // is to reject zero-down at the boundary with a clear,
    // operator-facing error.
    //
    // Note: a non-zero policy-derived perpetual-care fee may be ADDED
    // to the down-payment slot later (Story 3.8 bundle-into-down
    // semantics) and CREATE a payment row that does dedupe through
    // the cornerstone. The hard-rule rejection here fires BEFORE the
    // perpetual-care derivation runs — operators are expected to
    // capture at least a customer-deposit down payment for every
    // installment sale, even when the cemetery policy is "annual"
    // perpetual-care (zero up-front addon). If a future product
    // decision re-enables zero-down sales, this guard relaxes to "&&
    // adjustedDownPaymentCents === 0" once the dedup table ships.
    if (args.downPaymentCents === 0) {
      throwError(
        ErrorCode.ZERO_DOWN_NOT_SUPPORTED,
        "Zero down-payment installment sales are not supported. Capture at least a customer deposit before submitting.",
        {
          downPaymentCents: args.downPaymentCents,
          totalPriceCents: args.totalPriceCents,
        },
      );
    }
    if (
      !Number.isInteger(args.termMonths) ||
      args.termMonths < 1 ||
      args.termMonths > 60
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "Term must be a whole number of months between 1 and 60.",
        { termMonths: args.termMonths },
      );
    }
    if (
      !Number.isInteger(args.monthlyAmountCents) ||
      args.monthlyAmountCents <= 0
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "Monthly amount must be a positive integer in centavos.",
        { monthlyAmountCents: args.monthlyAmountCents },
      );
    }
    if (
      !Number.isFinite(args.firstDueDate) ||
      args.firstDueDate <= args.paidAt
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "First due date must be after the sale date.",
        { firstDueDate: args.firstDueDate, paidAt: args.paidAt },
      );
    }
    if (args.installments.length !== args.termMonths) {
      throwError(
        ErrorCode.VALIDATION,
        `Installments array length (${args.installments.length}) must equal termMonths (${args.termMonths}).`,
        {
          installmentsLength: args.installments.length,
          termMonths: args.termMonths,
        },
      );
    }
    const seenNumbers = new Set<number>();
    let lastDueDate = -Infinity;
    let installmentTotal = 0;
    for (const row of args.installments) {
      if (
        !Number.isInteger(row.installmentNumber) ||
        row.installmentNumber < 1 ||
        row.installmentNumber > args.termMonths
      ) {
        throwError(
          ErrorCode.VALIDATION,
          `Installment number ${row.installmentNumber} is out of range [1..${args.termMonths}].`,
          { installmentNumber: row.installmentNumber },
        );
      }
      if (seenNumbers.has(row.installmentNumber)) {
        throwError(
          ErrorCode.VALIDATION,
          `Duplicate installment number ${row.installmentNumber}.`,
          { installmentNumber: row.installmentNumber },
        );
      }
      seenNumbers.add(row.installmentNumber);
      if (
        !Number.isInteger(row.principalCents) ||
        row.principalCents <= 0
      ) {
        throwError(
          ErrorCode.VALIDATION,
          "Each installment principal must be a positive integer in centavos.",
          {
            installmentNumber: row.installmentNumber,
            principalCents: row.principalCents,
          },
        );
      }
      if (row.dueDate <= lastDueDate) {
        throwError(
          ErrorCode.VALIDATION,
          "Installment dueDate values must be strictly increasing.",
          { installmentNumber: row.installmentNumber, dueDate: row.dueDate },
        );
      }
      lastDueDate = row.dueDate;
      installmentTotal += row.principalCents;
    }
    if (args.downPaymentCents + installmentTotal !== args.totalPriceCents) {
      throwError(
        ErrorCode.ALLOCATION_SUM_MISMATCH,
        `Down payment + installments total (${args.downPaymentCents + installmentTotal}) does not equal total price (${args.totalPriceCents}).`,
        {
          downPaymentCents: args.downPaymentCents,
          installmentsTotalCents: installmentTotal,
          totalPriceCents: args.totalPriceCents,
        },
      );
    }

    // Epic-3/4 adversarial-review HIGH fix: server-side schedule
    // re-derivation (`SCHEDULE_TAMPERED`).
    //
    // The validation block above checks installment-row SHAPE (unique
    // numbers, positive principals, well-ordered dueDates, sum equals
    // total). What it does NOT check is whether the per-row dueDates
    // / principals actually match the schedule a faithful client
    // would generate from `(totalPriceCents, downPaymentCents,
    // termMonths, firstDueDate)`. A hostile client could pass a
    // shape-valid array with due dates in 2099, principals reshuffled
    // across rows, or both — and the original validator accepted
    // those.
    //
    // Defense in depth: re-derive the schedule from the same shared
    // helper the client uses (`convex/lib/installmentSchedule.ts`)
    // and reject if any row disagrees. The first mismatch surfaces
    // in `details` for fast operator triage.
    const expectedSchedule = generateInstallmentSchedule({
      totalPriceCents: args.totalPriceCents,
      downPaymentCents: args.downPaymentCents,
      termMonths: args.termMonths,
      firstDueDate: args.firstDueDate,
    });
    // The expectedSchedule rows are 1-indexed by installmentNumber.
    // Build a Map for O(1) lookup; the client array is already
    // validated above to have unique installmentNumbers in [1..N].
    const expectedByNumber = new Map<number, { dueDate: number; principalCents: number }>(
      expectedSchedule.rows.map((row) => [
        row.installmentNumber,
        { dueDate: row.dueDate, principalCents: row.principalCents },
      ]),
    );
    for (const row of args.installments) {
      const expected = expectedByNumber.get(row.installmentNumber);
      if (expected === undefined) {
        // Defensive — the above shape check guarantees a 1:1 mapping;
        // this branch is unreachable in practice but keeps the
        // exhaustive-check honest.
        throwError(
          ErrorCode.SCHEDULE_TAMPERED,
          `Installment number ${row.installmentNumber} has no server-derived counterpart.`,
          {
            kind: "schedule_tampered",
            installmentNumber: row.installmentNumber,
          },
        );
      }
      if (row.dueDate !== expected.dueDate) {
        throwError(
          ErrorCode.SCHEDULE_TAMPERED,
          `Installment ${row.installmentNumber} dueDate (${row.dueDate}) does not match the server-derived value (${expected.dueDate}).`,
          {
            kind: "schedule_tampered",
            installmentNumber: row.installmentNumber,
            field: "dueDate",
            clientValue: row.dueDate,
            serverValue: expected.dueDate,
          },
        );
      }
      if (row.principalCents !== expected.principalCents) {
        throwError(
          ErrorCode.SCHEDULE_TAMPERED,
          `Installment ${row.installmentNumber} principalCents (${row.principalCents}) does not match the server-derived value (${expected.principalCents}).`,
          {
            kind: "schedule_tampered",
            installmentNumber: row.installmentNumber,
            field: "principalCents",
            clientValue: row.principalCents,
            serverValue: expected.principalCents,
          },
        );
      }
    }

    const reference =
      args.reference !== undefined && args.reference.trim().length > 0
        ? args.reference.trim()
        : undefined;
    // Reference-required check uses the CLIENT's down-payment value
    // here — the policy-derived perpetual-care fee may bundle into
    // the down payment later (server-side), but the cemetery's
    // operational rule is "non-cash sales need a reference." A
    // zero-down sale with only a perpetual-care fee STILL needs a
    // reference for non-cash; that check fires below after we know
    // the adjusted down-payment value.
    if (
      args.downPaymentCents > 0 &&
      args.method !== "cash" &&
      reference === undefined
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "Reference number is required for cheque and bank transfer payments.",
        { method: args.method },
      );
    }
    if (!args.idempotencyKey || args.idempotencyKey.trim().length === 0) {
      throwError(
        ErrorCode.VALIDATION,
        "Idempotency key is required.",
      );
    }

    // Story 3.5 (FR22) — discount invariants. Mirrors the full-payment
    // path: any failure throws BEFORE we touch the lot / customer /
    // cornerstone, so a rejected discount rolls back nothing. The
    // client's `totalPriceCents` is the post-discount, PRE-perpetual-
    // care total (the discount normaliser asserts
    // `basePriceCents − discountCents === totalPriceCents`).
    const instDiscount = normalizeDiscountInputs({
      totalPriceCents: args.totalPriceCents,
      basePriceCents: args.basePriceCents,
      discountCents: args.discountCents,
      discountReason: args.discountReason,
    });

    // Step 2: Load + validate the lot.
    const lot = await ctx.db.get(args.lotId);
    if (lot === null) {
      throwError(ErrorCode.NOT_FOUND, "Lot not found.", {
        lotId: args.lotId,
      });
    }
    if (lot.isRetired) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Cannot sell a retired lot.",
        { lotId: args.lotId },
      );
    }
    if (lot.status !== "available") {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        `Lot is not available for sale (current status: ${lot.status}).`,
        { lotId: args.lotId, status: lot.status },
      );
    }

    // Step 3: Load + validate the customer.
    // pii-read-ok: validation lookup in sale path — customer fields not returned to caller; only existence is asserted
    const customer = await ctx.db.get(args.customerId);
    if (customer === null) {
      throwError(ErrorCode.NOT_FOUND, "Customer not found.", {
        customerId: args.customerId,
      });
    }

    // Step 3a: Story 2.9 (FR15) — estate-mode validation. Same shape
    // as the full-payment path; the sibling-lot transitions happen
    // alongside the canonical-anchor transition below.
    let estateSiblingLotIdsInst: LotId[] = [];
    if (args.familyEstateId !== undefined) {
      const estate = await ctx.db.get(
        args.familyEstateId as unknown as DataModel["familyEstates"]["document"]["_id"],
      );
      if (estate === null) {
        throwError(ErrorCode.NOT_FOUND, "Family estate not found.", {
          familyEstateId: args.familyEstateId,
        });
      }
      if (estate!.retiredAt !== undefined) {
        throwError(
          ErrorCode.INVARIANT_VIOLATION,
          "Cannot sell a retired family estate.",
          { familyEstateId: args.familyEstateId },
        );
      }
      const memberIdStrs = estate!.lotIds.map(
        (id) => id as unknown as string,
      );
      if (!memberIdStrs.includes(args.lotId as unknown as string)) {
        throwError(
          ErrorCode.VALIDATION,
          "Supplied lotId is not a member of the family estate.",
          { lotId: args.lotId, familyEstateId: args.familyEstateId },
        );
      }
      if (
        (estate!.primaryOwnerCustomerId as unknown as string) !==
        (args.customerId as unknown as string)
      ) {
        throwError(
          ErrorCode.VALIDATION,
          "Customer must be the estate's primary owner.",
          {
            customerId: args.customerId,
            primaryOwnerCustomerId: estate!.primaryOwnerCustomerId,
          },
        );
      }
      estateSiblingLotIdsInst = estate!.lotIds.filter(
        (id) => (id as unknown as string) !== (args.lotId as unknown as string),
      ) as LotId[];
      for (const sibling of estateSiblingLotIdsInst) {
        const sLot = await ctx.db.get(sibling);
        if (sLot === null) {
          throwError(ErrorCode.NOT_FOUND, "Estate member lot not found.", {
            lotId: sibling,
          });
        }
        if (sLot!.isRetired) {
          throwError(
            ErrorCode.INVARIANT_VIOLATION,
            "Estate member lot is retired.",
            { lotId: sibling },
          );
        }
        if (sLot!.status !== "available") {
          throwError(
            ErrorCode.INVARIANT_VIOLATION,
            `Estate member lot is not available for sale (current status: ${sLot!.status}).`,
            { lotId: sibling, status: sLot!.status },
          );
        }
      }
    }

    // Step 3b: Story 3.8 rebuild (FR25) — derive perpetual-care fee
    // from policy + lot type. Same fail-closed semantics as the full-
    // payment path. For installment sales the addon is BUNDLED INTO
    // THE DOWN PAYMENT (cash-flow predictability: a defaulted
    // contract shouldn't leave the cemetery with an unfunded
    // perpetual-care obligation), so we increase `downPaymentCents`
    // and the contract `totalPriceCents` by the derived fee before
    // the schedule sum-check + insert.
    //
    // Edge: ₱0 down + non-zero perpetual care: we still bundle the
    // fee into the down payment slot, which means a "zero down"
    // installment sale with perpetual care actually has a non-zero
    // down (= the perpetual care fee). The form copy says "down
    // payment" but the underlying financial event is "policy-derived
    // perpetual care + customer-supplied deposit."
    const perpetualCarePolicy = await loadPerpetualCarePolicy(ctx);
    const derivedPerpetualCare = computePerpetualCareForSale(
      perpetualCarePolicy,
      lot.type,
    );
    const adjustedDownPaymentCents =
      args.downPaymentCents + derivedPerpetualCare.feeCents;
    const adjustedTotalCents =
      args.totalPriceCents + derivedPerpetualCare.feeCents;
    const derivedReason =
      derivedPerpetualCare.feeCents > 0
        ? `Per ${perpetualCarePolicy.type} policy (lot type ${lot.type})`
        : undefined;

    // Step 4: Idempotency short-circuit — if a payment with this
    // idempotency key already exists, return the contract it already
    // built. This protects against the "browser refresh after submit"
    // case where the cornerstone would dedupe the payment but we'd
    // otherwise insert a duplicate contract + duplicate installments.
    if (adjustedDownPaymentCents > 0) {
      const existingPayment = await ctx.db
        .query("payments")
        .withIndex("by_idempotency", (q) =>
          q.eq("idempotencyKey", args.idempotencyKey),
        )
        .unique();
      if (existingPayment !== null && existingPayment.contractId !== undefined) {
        const existingContract = await ctx.db.get(
          existingPayment.contractId as ContractId,
        );
        if (existingContract !== null && existingContract.kind === "installment") {
          const existingInstallments = await ctx.db
            .query("installments")
            .withIndex("by_contract", (q) =>
              q.eq("contractId", existingContract._id),
            )
            .collect();
          const existingReceipt =
            existingContract.receiptId !== undefined
              ? await ctx.db.get(existingContract.receiptId)
              : null;
          return {
            contractId: existingContract._id,
            contractNumber: existingContract.contractNumber,
            installmentCount: existingInstallments.length,
            paymentId: existingPayment._id,
            receiptId: existingContract.receiptId ?? null,
            receiptNumber: existingReceipt?.receiptNumber ?? null,
          };
        }
      }
    }

    // Story 3.8 rebuild: when the policy-derived perpetual-care fee
    // bundles the customer into a non-zero down payment but the
    // operator selected a non-cash method without a reference, fail
    // with the same VALIDATION code the simple non-cash check uses.
    if (
      adjustedDownPaymentCents > 0 &&
      args.method !== "cash" &&
      reference === undefined
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "Reference number is required for cheque and bank transfer payments.",
        { method: args.method },
      );
    }

    const now = Date.now();
    const contractNumber = makeContractNumber(now, lot.code);

    // Step 5: Insert the contract row. State is `active` — the contract
    // is alive but not yet paid in full; subsequent installment-targeted
    // payments (Stories 3.9 / 3.10) drive it toward `paid_in_full` once
    // every row's `paidCents === principalCents`.
    //
    // Story 3.5 (FR22): discount triple is written alongside the
    // installment terms. The schedule itself was computed against the
    // post-discount `totalPriceCents`, so the per-installment principals
    // already reflect the discounted price.
    //
    // Story 3.8 rebuild: `totalPriceCents` is the adjusted total
    // (client total + derived perpetual-care fee). `downPaymentCents`
    // is the adjusted down (client down + derived perpetual-care
    // fee). `perpetualCareCents` is the derived fee;
    // `perpetualCarePaidCents` is also the derived fee because the
    // addon is collected up front via the bundled down payment.
    type ContractInsert = DataModel["contracts"]["document"] extends infer Doc
      ? Omit<Doc, "_id" | "_creationTime">
      : never;
    const contractRow: ContractInsert = {
      contractNumber,
      lotId: args.lotId,
      customerId: args.customerId,
      kind: "installment",
      totalPriceCents: adjustedTotalCents,
      state: "active",
      createdAt: now,
      createdBy: auth.userId,
      downPaymentCents: adjustedDownPaymentCents,
      termMonths: args.termMonths,
      monthlyAmountCents: args.monthlyAmountCents,
      firstDueDate: args.firstDueDate,
      basePriceCents: instDiscount.basePriceCents,
      discountCents: instDiscount.discountCents,
      perpetualCareCents: derivedPerpetualCare.feeCents,
      perpetualCarePaidCents: derivedPerpetualCare.feeCents,
    };
    if (instDiscount.discountReason !== undefined) {
      contractRow.discountReason = instDiscount.discountReason;
    }
    if (derivedReason !== undefined) {
      contractRow.perpetualCareReason = derivedReason;
    }
    // Story 2.9 — bind the contract to the estate when estate-mode is active.
    if (args.familyEstateId !== undefined) {
      contractRow.familyEstateId =
        args.familyEstateId as unknown as DataModel["familyEstates"]["document"]["_id"];
    }
    const contractId = await ctx.db.insert("contracts", contractRow);

    // Step 6: Transition the lot from `available` to `sold`. A concurrent
    // sale that landed between our read and this transition raises
    // `ILLEGAL_STATE_TRANSITION` and rolls back every preceding insert.
    await transitionLotStatus(ctx, {
      lotId: args.lotId,
      to: "sold",
      reason: args.familyEstateId !== undefined
        ? `Estate-bound installment sale (contract ${contractNumber}, anchor lot)`
        : `Installment sale (contract ${contractNumber})`,
    });

    // Story 2.9 — fan out the same transition across every sibling lot
    // in the estate. Same atomic-mutation rules as the full-payment path.
    for (const sibling of estateSiblingLotIdsInst) {
      await transitionLotStatus(ctx, {
        lotId: sibling,
        to: "sold",
        reason: `Estate-bound installment sale (contract ${contractNumber}, sibling lot)`,
      });
    }

    // Step 7: Optional down-payment financial event. The down payment
    // here is the ADJUSTED down (client down + derived perpetual-care
    // fee). ₱0-adjusted-down skips the cornerstone entirely. When
    // the perpetual-care fee is the entire down payment (e.g. client
    // sent `downPaymentCents: 0` and policy fee is ₱5,000), the
    // allocation is split between a contract-targeted row (the
    // customer's actual down) and a perpetualCare-targeted row (the
    // derived fee). When the customer's down is also > 0, both rows
    // appear; when the customer's down is 0, only the perpetualCare
    // row appears.
    let paymentId: PaymentId | null = null;
    let receiptId: ReceiptId | null = null;
    let receiptNumber: string | null = null;
    if (adjustedDownPaymentCents > 0) {
      const allocations: Array<{
        targetType: "contract" | "perpetualCare";
        targetId: string;
        amountCents: number;
        sequence: number;
        note?: string;
      }> = [];
      let seq = 0;
      if (args.downPaymentCents > 0) {
        allocations.push({
          targetType: "contract",
          targetId: contractId,
          amountCents: args.downPaymentCents,
          sequence: seq++,
          note: "Down payment",
        });
      }
      if (derivedPerpetualCare.feeCents > 0) {
        allocations.push({
          targetType: "perpetualCare",
          targetId: contractId,
          amountCents: derivedPerpetualCare.feeCents,
          sequence: seq++,
          note: derivedReason,
        });
      }
      const financialResult = await postFinancialEvent(ctx, {
        kind: "sale",
        idempotencyKey: args.idempotencyKey,
        payment: {
          amountCents: adjustedDownPaymentCents,
          paymentMethod: args.method,
          reference,
          receivedAt: args.paidAt,
          receivedByUserId: auth.userId,
          contractId: contractId,
          customerId: args.customerId,
        },
        allocations,
      });
      if (financialResult.paymentId === null) {
        throwError(
          ErrorCode.INVARIANT_VIOLATION,
          "postFinancialEvent returned null paymentId for an installment-down-payment event.",
        );
      }
      paymentId = financialResult.paymentId;
      receiptId = financialResult.receiptId;
      receiptNumber = financialResult.receiptNumber;
      await ctx.db.patch(contractId, {
        paymentId: financialResult.paymentId,
        receiptId: financialResult.receiptId,
      });
    }

    // Step 8: Insert each installment row in caller-supplied order. The
    // caller's array was validated above (well-ordered, unique numbers,
    // positive principals, sum equals total − down payment). The
    // perpetual-care addon does NOT split out a separate installment
    // — it was bundled into the down payment above.
    for (const row of args.installments) {
      await ctx.db.insert("installments", {
        contractId,
        installmentNumber: row.installmentNumber,
        dueDate: row.dueDate,
        principalCents: row.principalCents,
        paidCents: 0,
        status: "pending",
      });
    }

    // Step 9: Emit a `create` audit row for the contract aggregate.
    //
    // Story 3.5 (FR22): the audit `after` snapshot carries the
    // discount triple verbatim. `discountReason` is a business reason
    // (NOT PII) so `emitAudit`'s `redactPii` whitelist intentionally
    // leaves it intact — the cemetery's audit trail wants
    // "Family loyalty" verbatim, not "[REDACTED]".
    const auditAfter: Record<string, unknown> = {
      contractNumber,
      lotId: args.lotId,
      customerId: args.customerId,
      kind: "installment",
      totalPriceCents: adjustedTotalCents,
      downPaymentCents: adjustedDownPaymentCents,
      termMonths: args.termMonths,
      monthlyAmountCents: args.monthlyAmountCents,
      firstDueDate: args.firstDueDate,
      installmentCount: args.installments.length,
      state: "active",
      paymentId,
      receiptId,
      receiptNumber,
      basePriceCents: instDiscount.basePriceCents,
      discountCents: instDiscount.discountCents,
      // Story 3.8 rebuild (FR25) — derived perpetual-care snapshot.
      perpetualCareCents: derivedPerpetualCare.feeCents,
      perpetualCarePaidCents: derivedPerpetualCare.feeCents,
      perpetualCareBillingType: derivedPerpetualCare.billingType,
    };
    if (instDiscount.discountReason !== undefined) {
      auditAfter.discountReason = instDiscount.discountReason;
    }
    if (derivedReason !== undefined) {
      auditAfter.perpetualCareReason = derivedReason;
    }
    // Story 2.9 — estate binding snapshot.
    if (args.familyEstateId !== undefined) {
      auditAfter.familyEstateId = args.familyEstateId;
      auditAfter.estateSiblingLotIds = estateSiblingLotIdsInst;
    }
    await emitAudit(ctx, {
      action: "create",
      entityType: "contract",
      entityId: contractId,
      after: auditAfter,
    });

    return {
      contractId,
      contractNumber,
      installmentCount: args.installments.length,
      paymentId,
      receiptId,
      receiptNumber,
    };
  },
});

/**
 * Public arg shape for `getContract`.
 */
export interface GetContractArgs {
  contractId: ContractId;
}

/**
 * Public return shape for `getContract`. Includes the contract row plus
 * the related lot + customer rows so the detail page renders in one
 * round-trip.
 */
export interface ContractDetailResult {
  contractId: ContractId;
  contractNumber: string;
  lotId: LotId;
  lotCode: string;
  customerId: CustomerId;
  customerFullName: string;
  kind: "full_payment" | "installment";
  totalPriceCents: number;
  state:
    | "active"
    | "paid_in_full"
    | "cancelled"
    | "voided"
    | "in_default";
  createdAt: number;
  paymentId?: PaymentId;
  receiptId?: ReceiptId;
  receiptNumber?: string;
  /**
   * Story 3.5 (FR22) — discount triple hydrated from the contract row.
   * Present on Story 3.5+ contracts; absent on legacy rows written
   * before the schema accretion. UI consumers should treat absence as
   * "no discount" (a `basePriceCents` equal to `totalPriceCents`).
   */
  basePriceCents?: number;
  discountCents?: number;
  discountReason?: string;
  /**
   * Story 3.8 (FR25) — perpetual care snapshot hydrated from the
   * contract row. Present on Story 3.8+ contracts; absent on
   * legacy rows. UI consumers should treat absence as "no perpetual
   * care fee applied" (`perpetualCareCents` defaults to 0). The
   * receipt + contract detail surfaces use these fields to render the
   * perpetual-care line item per AC4.
   */
  perpetualCareCents?: number;
  perpetualCarePaidCents?: number;
  perpetualCareReason?: string;
  /**
   * Story 5.4 (FR44) — follow-up flag fields. `isFlagged` is always
   * present (false when the contract is not flagged); the other three
   * are absent when not flagged. The contract detail page reads these
   * to render the "Flagged for staff follow-up" indicator + the
   * Flag-for-follow-up / Clear-flag admin controls.
   */
  isFlagged: boolean;
  flagReason?: string;
  flaggedAt?: number;
  flaggedByName?: string;
  /**
   * Story 2.9 (FR15) — when the contract is estate-bound, the detail
   * page renders the "Family estate" card with the estate label + the
   * full member-lot list. Absent on every single-lot contract.
   */
  familyEstateId?: string;
  familyEstateName?: string;
  familyEstateLotCount?: number;
}

/**
 * Loads a contract by id for the `/contracts/[contractId]` page.
 *
 * Hydrates the lot's `code` and the customer's `fullName` so the page
 * renders the human-readable references without secondary fetches. The
 * receipt number is hydrated via the `receiptId` back-pointer when the
 * contract has been closed (full-payment sales always have one).
 *
 * Throws:
 *   - `UNAUTHENTICATED` / `FORBIDDEN` — auth gate (admin / office_staff).
 *   - `NOT_FOUND` — contract id does not resolve.
 */
export const getContract = queryGeneric({
  args: { contractId: v.id("contracts") },
  handler: async (
    ctx: QueryCtx,
    args: GetContractArgs,
  ): Promise<ContractDetailResult> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }
    // Hydrate lot + customer + receipt. Each `get` is O(1); for a
    // single-row detail page these three round-trips are cheap.
    const lot = await ctx.db.get(contract.lotId);
    // pii-read-ok: contract detail view projects fullName only — address/email/phone/govId not returned; staff-facing surface gated by requireRole earlier in the handler
    const customer = await ctx.db.get(contract.customerId);
    const result: ContractDetailResult = {
      contractId: contract._id,
      contractNumber: contract.contractNumber,
      lotId: contract.lotId,
      lotCode: lot?.code ?? "[retired]",
      customerId: contract.customerId,
      customerFullName: customer?.fullName ?? "[deleted customer]",
      kind: contract.kind,
      totalPriceCents: contract.totalPriceCents,
      state: contract.state,
      createdAt: contract.createdAt,
      isFlagged: false,
    };
    if (contract.paymentId !== undefined) {
      result.paymentId = contract.paymentId;
    }
    if (contract.receiptId !== undefined) {
      result.receiptId = contract.receiptId;
      const receipt = await ctx.db.get(contract.receiptId);
      if (receipt !== null) {
        result.receiptNumber = receipt.receiptNumber;
      }
    }
    // Story 3.5 (FR22) — surface the discount triple when present.
    if (contract.basePriceCents !== undefined) {
      result.basePriceCents = contract.basePriceCents;
    }
    if (contract.discountCents !== undefined) {
      result.discountCents = contract.discountCents;
    }
    if (contract.discountReason !== undefined) {
      result.discountReason = contract.discountReason;
    }
    // Story 3.8 (FR25) — surface perpetual-care snapshot when present.
    if (contract.perpetualCareCents !== undefined) {
      result.perpetualCareCents = contract.perpetualCareCents;
    }
    if (contract.perpetualCarePaidCents !== undefined) {
      result.perpetualCarePaidCents = contract.perpetualCarePaidCents;
    }
    if (contract.perpetualCareReason !== undefined) {
      result.perpetualCareReason = contract.perpetualCareReason;
    }
    // Story 5.4 (FR44) — surface the flag triple when the contract is
    // currently flagged. `isFlagged` is normalised to a boolean so the
    // UI doesn't need to discriminate between `undefined` and `false`.
    if (contract.isFlagged === true) {
      result.isFlagged = true;
      if (contract.flagReason !== undefined) {
        result.flagReason = contract.flagReason;
      }
      if (contract.flaggedAt !== undefined) {
        result.flaggedAt = contract.flaggedAt;
      }
      if (contract.flaggedBy !== undefined) {
        const flaggedByUser = await ctx.db.get(contract.flaggedBy);
        result.flaggedByName =
          (flaggedByUser?.name as string | undefined) ??
          (flaggedByUser?.email as string | undefined) ??
          "Unknown admin";
      }
    }
    // Story 2.9 (FR15) — surface estate binding when present.
    if (contract.familyEstateId !== undefined) {
      const estate = await ctx.db.get(contract.familyEstateId);
      result.familyEstateId = contract.familyEstateId as unknown as string;
      if (estate !== null) {
        result.familyEstateName = (estate as { name: string }).name;
        result.familyEstateLotCount = (estate as { lotIds: unknown[] }).lotIds.length;
      }
    }
    return result;
  },
});

/**
 * Public arg shape for `listContracts`.
 *
 * `fromMs` / `toMs` (HIGH-D fix, Epic 5 adversarial review): optional
 * inclusive `createdAt` range bounds for the dashboard's drill-down
 * filter and the Sales-by-dimension report (FR45). When both are
 * `undefined` the query falls back to the all-time scan it ships
 * historically. When at least one bound is set we walk
 * `contracts.by_createdAt` (Story 6.3's index addition) for a bounded
 * index range scan — the cemetery's sales volume can comfortably fit
 * in-memory at Phase 1 scale, but pushing the filter to the index
 * avoids the prior pattern of "load 100 rows then `.filter()` on the
 * client", which was a server-side-filter violation (Story 5.3 AC5).
 */
export interface ListContractsArgs {
  stateFilter?:
    | "active"
    | "paid_in_full"
    | "cancelled"
    | "voided"
    | "in_default";
  fromMs?: number;
  toMs?: number;
  limit?: number;
}

/**
 * Shape of each row returned by `listContracts`. Intentionally narrow —
 * the list view shows the contract number, lot code, customer name,
 * state, and total price; the detail page (`getContract`) hydrates the
 * rest.
 */
export interface ContractListRow {
  contractId: ContractId;
  contractNumber: string;
  lotId: LotId;
  lotCode: string;
  customerId: CustomerId;
  customerFullName: string;
  kind: "full_payment" | "installment";
  totalPriceCents: number;
  state:
    | "active"
    | "paid_in_full"
    | "cancelled"
    | "voided"
    | "in_default";
  createdAt: number;
}

/**
 * Lists contracts for the `/sales` (a.k.a. `/contracts`) list view.
 *
 * Defaults to all states sorted by `createdAt` descending. When
 * `stateFilter` is supplied, queries via the `by_state` index. Caps at
 * 100 rows per page — Phase 1 has only a few hundred contracts at
 * steady state; cursor pagination lands when the row count justifies
 * it.
 */
export const listContracts = queryGeneric({
  args: {
    stateFilter: v.optional(
      v.union(
        v.literal("active"),
        v.literal("paid_in_full"),
        v.literal("cancelled"),
        v.literal("voided"),
        v.literal("in_default"),
      ),
    ),
    fromMs: v.optional(v.number()),
    toMs: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx: QueryCtx,
    args: ListContractsArgs,
  ): Promise<ContractListRow[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const limit = Math.min(args.limit ?? 100, 200);
    const hasRange = args.fromMs !== undefined || args.toMs !== undefined;
    let rows: ContractDoc[];
    if (hasRange) {
      // HIGH-D (Epic 5 review): when a `createdAt` range is supplied,
      // walk `by_createdAt` so the scan is bounded to the period rather
      // than loading the full table and discarding everything outside
      // the window on the client. State filtering layers on top in
      // memory — Convex indexes are positional, so we cannot combine
      // `by_state` + `by_createdAt` in a single index walk. State is a
      // low-cardinality filter; for Phase 1 sales volume the in-memory
      // pass after the range scan is negligible.
      // Convex's IndexRangeBuilder is progressively narrowed — after a
      // `.gte(...)` call the returned builder only exposes upper-bound
      // operators (`.lt`/`.lte`). We branch explicitly on the three
      // legal combinations (from-only / to-only / both) so the
      // narrowed types compose cleanly without a `let`-reassignment
      // pattern that the compiler can't follow.
      const fromMs = args.fromMs;
      const toMs = args.toMs;
      rows = (await ctx.db
        .query("contracts")
        .withIndex("by_createdAt", (q) => {
          if (fromMs !== undefined && toMs !== undefined) {
            return q.gte("createdAt", fromMs).lte("createdAt", toMs);
          }
          if (fromMs !== undefined) {
            return q.gte("createdAt", fromMs);
          }
          if (toMs !== undefined) {
            return q.lte("createdAt", toMs);
          }
          return q;
        })
        .collect()) as ContractDoc[];
      if (args.stateFilter !== undefined) {
        const stateFilter = args.stateFilter;
        rows = rows.filter((r) => r.state === stateFilter);
      }
    } else if (args.stateFilter !== undefined) {
      const stateFilter = args.stateFilter;
      rows = await ctx.db
        .query("contracts")
        .withIndex("by_state", (q) => q.eq("state", stateFilter))
        .collect();
    } else {
      rows = await ctx.db.query("contracts").collect();
    }
    // Sort by createdAt descending — most-recent-first matches operator
    // expectation for the sales list view.
    const sorted = [...rows].sort((a, b) => b.createdAt - a.createdAt);
    const capped = sorted.slice(0, limit);
    const out: ContractListRow[] = [];
    for (const row of capped) {
      const lot = await ctx.db.get(row.lotId);
      // pii-read-ok: contract list projects fullName only — address/email/phone/govId not returned
      const customer = await ctx.db.get(row.customerId);
      out.push({
        contractId: row._id,
        contractNumber: row.contractNumber,
        lotId: row.lotId,
        lotCode: lot?.code ?? "[retired]",
        customerId: row.customerId,
        customerFullName: customer?.fullName ?? "[deleted customer]",
        kind: row.kind,
        totalPriceCents: row.totalPriceCents,
        state: row.state,
        createdAt: row.createdAt,
      });
    }
    return out;
  },
});

/**
 * Public arg shape for `transitionState` (Story 3.6, FR23 / FR24 / FR37).
 *
 * Mirrors the validator below. Exported so the React UI and tests can
 * typecheck against the mutation's contract. The `to` parameter accepts
 * only the four admin-driven targets — `paid_in_full` is reachable
 * exclusively via the cornerstone's auto-fire (Story 3.2's
 * `postFinancialEvent` running through `transitionContractState`
 * directly) and is intentionally excluded from this public surface so
 * admins cannot manually close out a contract with an unpaid balance.
 */
export interface TransitionContractStateArgs {
  contractId: ContractId;
  to: "cancelled" | "voided" | "in_default" | "active";
  reason: string;
}

/**
 * Public return shape for `transitionState`. The UI uses these fields
 * to (a) flash the contract state pill via `ReactiveHighlight`, (b)
 * surface the post-transition state in a toast confirmation.
 */
export interface TransitionContractStateResult {
  contractId: ContractId;
  from:
    | "active"
    | "paid_in_full"
    | "cancelled"
    | "voided"
    | "in_default";
  to:
    | "active"
    | "paid_in_full"
    | "cancelled"
    | "voided"
    | "in_default";
}

/**
 * Admin-only public mutation that drives a contract through one of
 * the four admin-discretion state edges (Story 3.6 AC3 / AC4):
 *
 *   - `active → cancelled`     (admin cancel; Story 3.7's broader void
 *                                flow extends with lot reversion).
 *   - `active → voided`        (admin void post-sale, FR24).
 *   - `active → in_default`    (admin mark default, FR37; Story 4.4's
 *                                AR-aging workflow consumes this).
 *   - `in_default → active`    (admin reinstate after partial recovery;
 *                                Epic 4 default-recovery flow).
 *   - `in_default → voided`    (terminal void after failed recovery).
 *   - `in_default → cancelled` (terminal cancellation after default).
 *
 * `active → paid_in_full` is intentionally NOT routed through this
 * mutation — that transition is system-fired by
 * `postFinancialEvent` (Story 3.2's cornerstone) when a payment
 * closes the contract's balance. Surfacing a manual admin path
 * would let an admin close out an unpaid contract, which is the
 * financial-integrity bug FR23 forbids.
 *
 * Authorization: admin only. Office Staff calling this gets
 * `FORBIDDEN`. The first-line `requireRole` call satisfies Story
 * 1.2's `require-role-first-line` lint rule.
 *
 * Validation:
 *   - Contract must exist (NOT_FOUND otherwise).
 *   - `reason` MUST be a non-empty trimmed string of ≥ 5 characters.
 *     All admin-driven contract transitions are reason-required per
 *     `REASON_REQUIRED_TRANSITIONS` (Story 3.6's additions); the
 *     5-char floor is a defensive minimum atop the
 *     "non-empty / non-whitespace" floor `assertTransition` enforces.
 *
 * Side effects (in transaction order):
 *   1. Fetch the contract; surface NOT_FOUND if missing.
 *   2. Delegate to `transitionContractState`, which (a) asserts the
 *      transition is legal via `assertTransition`, (b) patches the
 *      `state` field on the contract row, (c) emits a `transition`
 *      audit-log entry with `before.state`, `after.state`, and
 *      `reason`.
 *   3. Return the from-state and to-state to the caller.
 *
 * Atomicity: the state patch + audit emission both happen inside the
 * enclosing Convex mutation transaction. If `emitAudit` throws after
 * the state patch lands, the entire transaction rolls back — no
 * silent state change without an audit row (FR23).
 *
 * NOT this mutation's responsibility:
 *   - Lot status reversion (Story 3.7's `cancelContract` handles).
 *   - Ownership-row closure (Story 3.7).
 *   - Payment/receipt voiding (Story 3.7 + Story 3.12).
 *   - Installment-aging side effects (Epic 4 daily aging scheduler).
 *
 * This mutation is intentionally structural — it flips the contract
 * state and logs the reason, letting Stories 3.7 / 4.4 / 4.5 build
 * atop the foundation. The state machine is the gate; orchestration
 * lives in the higher-level mutations those stories own.
 *
 * Throws:
 *   - `UNAUTHENTICATED` / `FORBIDDEN` — auth gate.
 *   - `VALIDATION` — reason missing or under 5 chars after trim.
 *   - `NOT_FOUND` — contract id does not resolve.
 *   - `ILLEGAL_STATE_TRANSITION` — proposed transition is not a legal
 *     edge in `TRANSITIONS.contract`. The error's `details.allowed`
 *     enumerates the legal targets from the current state so the UI
 *     can render a precise message ("This contract is already
 *     cancelled / paid in full / voided.").
 *   - `INVARIANT_VIOLATION` — reason failed the floor check inside
 *     `assertTransition` (whitespace-only after trim).
 */
export const transitionState = mutationGeneric({
  args: {
    contractId: v.id("contracts"),
    to: v.union(
      v.literal("cancelled"),
      v.literal("voided"),
      v.literal("in_default"),
      v.literal("active"),
    ),
    reason: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    args: TransitionContractStateArgs,
  ): Promise<TransitionContractStateResult> => {
    // First action — Story 1.2's require-role-first-line rule.
    await requireRole(ctx, ["admin"]);

    // Defensive validation: the `reason` floor is 5 chars after trim.
    // `assertTransition` itself rejects empty / whitespace-only
    // reasons via INVARIANT_VIOLATION; this VALIDATION layer surfaces
    // a friendlier error for the common "user clicked Confirm with
    // a one-word reason" case.
    const trimmedReason =
      typeof args.reason === "string" ? args.reason.trim() : "";
    if (trimmedReason.length < 5) {
      throwError(
        ErrorCode.VALIDATION,
        "Reason is required and must be at least 5 characters.",
        { reasonLength: trimmedReason.length },
      );
    }

    // Fetch the contract up front so we can return the from-state
    // (the cornerstone helper also fetches; the second `get` is O(1)
    // and the duplication keeps the helper signature clean).
    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }
    const from = contract.state;

    // Delegate to the cornerstone helper. The helper:
    //   1. Re-fetches the contract (defense against a hypothetical
    //      concurrent mutation that changed state between our read
    //      and the transition).
    //   2. Runs `assertTransition` — throws
    //      ILLEGAL_STATE_TRANSITION on a forbidden edge or
    //      INVARIANT_VIOLATION on a reason-required edge with no
    //      reason (we already enforced a 5-char floor above; the
    //      helper's "non-empty trimmed" floor is the safety net).
    //   3. Patches `state` and emits the transition audit row.
    await transitionContractState(ctx, {
      contractId: args.contractId,
      to: args.to,
      reason: trimmedReason,
    });

    return {
      contractId: args.contractId,
      from,
      to: args.to,
    };
  },
});

/**
 * Public arg shape for `generateContractPdfRequest` (Story 6.1, FR49).
 *
 * Epic-3/4 adversarial-review HIGH fix — `idempotencyKey` is now an
 * optional arg. When supplied AND the contract row's
 * `pdfIdempotencyKey` matches, the mutation short-circuits to the
 * already-cached storage id (or "still generating" status when the
 * prior call is in flight) rather than scheduling a second action.
 * Clients (the UI "Generate PDF" button) generate a fresh UUID per
 * deliberate request and reuse it across rapid double-clicks within
 * the same render frame.
 */
export interface GenerateContractPdfRequestArgs {
  contractId: ContractId;
  idempotencyKey?: string;
}

/**
 * Public return shape for `generateContractPdfRequest`.
 *
 * Status semantics (Epic-3/4 HIGH fix — was "scheduled" only):
 *   - `"scheduled"`         — fresh request enqueued; `pdfStatus`
 *                              transitioned to `"pending"` on the row.
 *   - `"already_generating"` — a prior request with the same
 *                              idempotency key is still in flight; no
 *                              additional action scheduled.
 *   - `"ready"`             — the contract already has a PDF (matching
 *                              idempotency key); the UI can proceed to
 *                              `getContractPdfUrl` immediately.
 */
export interface GenerateContractPdfRequestResult {
  contractId: ContractId;
  status: "scheduled" | "already_generating" | "ready";
}

/**
 * Function-reference path for the `actions/generateContractPdf:run`
 * Convex action. Mirrors the path constant in
 * `convex/actions/generateContractPdf.ts`; duplicated here as a string
 * because this V8-runtime mutation file cannot `import` from the
 * `"use node"` action module (Convex bundles V8 and Node functions into
 * separate runtimes; cross-runtime imports leak Node-only deps like
 * `pdfkit` into the V8 bundle and break the build).
 *
 * If the action ever moves, change this constant and the matching
 * `GENERATE_CONTRACT_PDF_FUNCTION_PATH` export in the action file
 * together; the unit test in `tests/unit/convex/contracts-pdf.test.ts`
 * pins both ends so drift surfaces fast.
 */
const GENERATE_CONTRACT_PDF_ACTION_PATH =
  "actions/generateContractPdf:run";

/**
 * Schedules a contract-PDF generation for the given contract (Story 6.1,
 * FR49). The mutation transaction:
 *
 *   1. Gates on `["admin", "office_staff"]` — Story 1.2's
 *      `require-role-first-line` lint rule is satisfied by the first
 *      `await requireRole(...)` below.
 *   2. Asserts the contract exists (so the UI surfaces NOT_FOUND
 *      synchronously rather than failing silently inside the action).
 *   3. Emits an audit row recording the regeneration request — both
 *      first-generation and re-generation produce a row. The audit
 *      trail captures WHO asked for a PDF + WHEN, separate from the
 *      action's own success / failure (the audit row lands BEFORE the
 *      action runs, so a failed action still leaves the "we asked" row
 *      in the log).
 *   4. Schedules the action via `ctx.scheduler.runAfter(0, ...)` so
 *      the heavyweight Node-runtime work happens after this V8
 *      transaction commits. The action callback (an internal mutation)
 *      patches the contract row with the resulting `pdfStorageId` +
 *      `pdfGeneratedAt`.
 *
 * Atomicity: the mutation's writes (audit row + scheduled-function
 * insert) commit together. The action that runs afterwards is OUT of
 * the mutation transaction by design — Node-runtime code cannot
 * participate in V8 transactions. The `pdfStorageId` field becomes
 * visible to reactive queries when the action's callback mutation
 * commits.
 *
 * Idempotency: scheduling the same contract again before the prior
 * action completes is permitted — the UI's "Generate PDF" button is
 * the operator's intent to refresh the blob. Each request emits its
 * own audit row + schedules its own action; the most recent action to
 * complete wins on the `pdfStorageId` field. Operationally rare (the
 * button is disabled while a generation is in flight; this is the
 * defense-in-depth path).
 *
 * Throws:
 *   - `UNAUTHENTICATED` / `FORBIDDEN` — auth gate.
 *   - `NOT_FOUND` — contract id does not resolve.
 */
export const generateContractPdfRequest = mutationGeneric({
  args: {
    contractId: v.id("contracts"),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: GenerateContractPdfRequestArgs,
  ): Promise<GenerateContractPdfRequestResult> => {
    await requireRole(ctx, ["admin", "office_staff"]);

    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }

    // Epic-3/4 adversarial-review HIGH fix — idempotency short-circuit.
    // When the caller supplies an `idempotencyKey` that matches the
    // contract row's last-stored `pdfIdempotencyKey`, the mutation
    // returns the cached status rather than scheduling another action.
    // Two cases:
    //   - `pdfStatus === "ready"`  → return "ready"; UI proceeds to
    //                                 the URL query immediately.
    //   - `pdfStatus === "pending"`→ return "already_generating"; UI
    //                                 keeps polling the URL query.
    // A "failed" status with the same key REQUEUES — the operator's
    // intent on a "Retry" click is to re-attempt the generation, so
    // we fall through to the schedule branch below.
    const trimmedKey =
      typeof args.idempotencyKey === "string"
        ? args.idempotencyKey.trim()
        : "";
    const idempotencyKey = trimmedKey.length > 0 ? trimmedKey : null;
    if (
      idempotencyKey !== null &&
      contract.pdfIdempotencyKey === idempotencyKey
    ) {
      if (contract.pdfStatus === "ready") {
        return { contractId: args.contractId, status: "ready" };
      }
      if (contract.pdfStatus === "pending") {
        return {
          contractId: args.contractId,
          status: "already_generating",
        };
      }
      // Failed status falls through — operator intent is to retry.
    }

    // Emit an "update" audit row to mark the regeneration request.
    // `AuditAction` (convex/lib/audit.ts) does not currently contain a
    // dedicated `generate_pdf` action; `"update"` is the closest fit
    // because the contract row's `pdfStorageId` field is about to
    // change. The `reason` string makes the intent unambiguous on
    // audit-log review. A future audit-vocabulary extension may
    // introduce a dedicated `pdf_generate` action; this story keeps
    // the audit transport minimal so the existing enum suffices.
    await emitAudit(ctx, {
      action: "update",
      entityType: "contract",
      entityId: args.contractId,
      before: {
        pdfStorageId: contract.pdfStorageId ?? null,
        pdfStatus: contract.pdfStatus ?? null,
      },
      after: { pdfStorageId: "(pending action)", pdfStatus: "pending" },
      reason: "Contract PDF generation requested.",
    });

    // Patch the row with the pending state + idempotency key BEFORE
    // scheduling the action. The retry-sweep cron in
    // `convex/crons.ts` reads `pdfStatus` to decide what to re-attempt;
    // a row stuck on "pending" past the next sweep window indicates a
    // dropped action or a runtime crash, and the sweep re-schedules.
    await ctx.db.patch(args.contractId, {
      pdfStatus: "pending",
      pdfRetryCount: 0,
      pdfLastError: undefined,
      pdfIdempotencyKey: idempotencyKey ?? undefined,
    });

    // Schedule the Node-runtime action. The reference is built via
    // `makeFunctionReference` against the action's function path — see
    // the constant's JSDoc for the cross-runtime-import rationale.
    const actionRef = makeFunctionReference<
      "action",
      { contractId: ContractId },
      { storageId: string }
    >(GENERATE_CONTRACT_PDF_ACTION_PATH);
    await ctx.scheduler.runAfter(0, actionRef, {
      contractId: args.contractId,
    });

    return {
      contractId: args.contractId,
      status: "scheduled",
    };
  },
});

/**
 * Public arg shape for `getContractPdfUrl`.
 */
export interface GetContractPdfUrlArgs {
  contractId: ContractId;
}

/**
 * Public return shape for `getContractPdfUrl`. `url` is `null` when the
 * contract has never had a PDF generated, or when the storage blob has
 * been garbage-collected (shouldn't happen in Phase 1 — there is no
 * GC story — but the UI handles `null` gracefully).
 */
export interface GetContractPdfUrlResult {
  url: string | null;
  generatedAt: number | null;
}

/**
 * Returns an auth-gated signed URL for the contract's most-recently
 * generated PDF (Story 6.1, FR49 / NFR-S3). Office Staff / Admin only —
 * field workers do not see contract documents. Customer-portal Epic 9
 * adds a separate query for customers viewing their own contracts.
 *
 * Behavior:
 *   - Contract not found → throws `NOT_FOUND` (the UI navigates to a
 *     contract detail page; if the contract was deleted between the
 *     route load and this query the page surfaces the error).
 *   - Contract has no `pdfStorageId` → returns `{ url: null,
 *     generatedAt: null }` so the UI renders "No PDF yet — click
 *     Generate".
 *   - Contract has a `pdfStorageId` → returns a signed URL plus the
 *     `pdfGeneratedAt` timestamp for display.
 *
 * The signed URL is short-lived (Convex's storage URLs default to ~1
 * hour); the UI does not cache it across navigations.
 *
 * Throws:
 *   - `UNAUTHENTICATED` / `FORBIDDEN` — auth gate.
 *   - `NOT_FOUND` — contract id does not resolve.
 */
export const getContractPdfUrl = queryGeneric({
  args: { contractId: v.id("contracts") },
  handler: async (
    ctx: QueryCtx,
    args: GetContractPdfUrlArgs,
  ): Promise<GetContractPdfUrlResult> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }
    if (contract.pdfStorageId === undefined) {
      return { url: null, generatedAt: null };
    }
    const url = await ctx.storage.getUrl(contract.pdfStorageId);
    return {
      url,
      generatedAt: contract.pdfGeneratedAt ?? null,
    };
  },
});

// ---------------------------------------------------------------------------
// Story 5.4 — Admin flags a contract for staff follow-up (FR44).
// ---------------------------------------------------------------------------

/**
 * Maximum length of a `flagReason` after trim. Mirrors the UX
 * specification's 280-char limit (Journey 4 climax popover); a single
 * tweet-length sentence is enough context to direct staff attention
 * without turning the flag into a ticketing system.
 *
 * Server-side enforcement is the authoritative gate per NFR-S4 — UI
 * `maxLength` is cosmetic. A curl client can post arbitrary length; this
 * mutation rejects.
 */
const FLAG_REASON_MAX_LENGTH = 280;

/**
 * Public arg shape for `flagContract` (Story 5.4, FR44).
 */
export interface FlagContractArgs {
  contractId: ContractId;
  reason: string;
}

/**
 * Public return shape for `flagContract`. The UI uses `flaggedAt` to
 * drive the StatusPill amber fade timing on the cross-tab subscriber's
 * dashboard tile (Journey 4 climax).
 */
export interface FlagContractResult {
  contractId: ContractId;
  flaggedAt: number;
}

/**
 * Admin flags a contract for staff follow-up (Story 5.4, FR44).
 *
 * The owner-driven "single mutation Mr. Reyes performs from his phone
 * in a typical week" — a calm, single-tap, single-comment, reactive
 * cross-role sync. Office Staff sees the flag appear on their dashboard
 * tile within ~1 second via Convex's reactive subscription (no
 * notification system, no toasts).
 *
 * Authorization: ADMIN ONLY. Office Staff calling this gets `FORBIDDEN`.
 * The "Admin instructs Staff via flag" semantic is the core of Journey
 * 4; if both roles could create flags, the audit trail loses meaning.
 * Server enforcement is the truth; the UI button is hidden for
 * non-Admins, but that's the cosmetic layer (NFR-S4).
 *
 * Validation:
 *   - `reason` MUST be a non-empty trimmed string of 1 to 280 chars.
 *     Whitespace-only is rejected (`VALIDATION`). Over-length is
 *     rejected (`VALIDATION`).
 *   - Contract must exist (`NOT_FOUND`).
 *
 * Side effects (in transaction order):
 *   1. Verify the contract exists.
 *   2. Patch the contract row with `{ isFlagged: true, flagReason,
 *      flaggedAt: now, flaggedBy: callerUserId }`. Flagging an already-
 *      flagged contract REPLACES the prior reason and timestamp (this
 *      is the "update the comment" path — Mr. Reyes can refine an
 *      existing flag without unflagging first).
 *   3. Emit an `update` audit row capturing `before` (the prior flag
 *      state) + `after` (the new flag state) so reviewers can see flag
 *      history without scanning the contract row.
 *
 * Atomicity: every step lands inside the enclosing Convex mutation
 * transaction. If `emitAudit` throws after the patch, the entire
 * transaction rolls back — no silent flag without an audit row.
 *
 * Throws:
 *   - `UNAUTHENTICATED` / `FORBIDDEN` — auth gate.
 *   - `VALIDATION` — reason missing / whitespace-only / over 280 chars.
 *   - `NOT_FOUND` — contract id does not resolve.
 */
export const flagContract = mutationGeneric({
  args: {
    contractId: v.id("contracts"),
    reason: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    args: FlagContractArgs,
  ): Promise<FlagContractResult> => {
    // First action — Story 1.2's require-role-first-line rule.
    // Admin-only per AC3 / Story 5.4 disaster-prevention.
    const { userId } = await requireRole(ctx, ["admin"]);

    const trimmedReason =
      typeof args.reason === "string" ? args.reason.trim() : "";
    if (trimmedReason.length < 1) {
      throwError(
        ErrorCode.VALIDATION,
        "Flag reason is required.",
        { reasonLength: trimmedReason.length },
      );
    }
    if (trimmedReason.length > FLAG_REASON_MAX_LENGTH) {
      throwError(
        ErrorCode.VALIDATION,
        `Flag reason must be at most ${FLAG_REASON_MAX_LENGTH} characters.`,
        { reasonLength: trimmedReason.length },
      );
    }

    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }

    const now = Date.now();
    const before = {
      isFlagged: contract.isFlagged ?? false,
      flagReason: contract.flagReason ?? null,
      flaggedAt: contract.flaggedAt ?? null,
      flaggedBy: contract.flaggedBy ?? null,
    };
    await ctx.db.patch(args.contractId, {
      isFlagged: true,
      flagReason: trimmedReason,
      flaggedAt: now,
      flaggedBy: userId,
    });
    const after = {
      isFlagged: true,
      flagReason: trimmedReason,
      flaggedAt: now,
      flaggedBy: userId,
    };

    await emitAudit(ctx, {
      action: "update",
      entityType: "contract",
      entityId: args.contractId,
      before,
      after,
      reason: "Contract flagged for staff follow-up.",
    });

    return {
      contractId: args.contractId,
      flaggedAt: now,
    };
  },
});

/**
 * Public arg shape for `unflagContract` (Story 5.4).
 */
export interface UnflagContractArgs {
  contractId: ContractId;
}

/**
 * Public return shape for `unflagContract`.
 */
export interface UnflagContractResult {
  contractId: ContractId;
}

/**
 * Admin clears the follow-up flag on a contract (Story 5.4).
 *
 * Counterpart to `flagContract` — once Maria (or Mr. Reyes himself) has
 * dealt with the situation, the admin clears the flag, which removes
 * it from the staff dashboard tile via the same reactive subscription.
 *
 * Authorization: ADMIN ONLY (mirrors `flagContract` — symmetry keeps the
 * audit-trail semantics clean; the staff don't "resolve" their own
 * directive without admin confirmation).
 *
 * Idempotent: clearing an already-unflagged contract is a no-op. The
 * mutation still emits an audit row (`update` with the no-op before/
 * after) so reviewers can see the clear was attempted, but does not
 * raise an error — the operator's intent ("make sure this is not
 * flagged") is satisfied either way.
 *
 * Throws:
 *   - `UNAUTHENTICATED` / `FORBIDDEN` — auth gate.
 *   - `NOT_FOUND` — contract id does not resolve.
 */
export const unflagContract = mutationGeneric({
  args: {
    contractId: v.id("contracts"),
  },
  handler: async (
    ctx: MutationCtx,
    args: UnflagContractArgs,
  ): Promise<UnflagContractResult> => {
    await requireRole(ctx, ["admin"]);

    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }

    const before = {
      isFlagged: contract.isFlagged ?? false,
      flagReason: contract.flagReason ?? null,
      flaggedAt: contract.flaggedAt ?? null,
      flaggedBy: contract.flaggedBy ?? null,
    };
    // Patch clears the four fields back to absent. Convex's `patch`
    // semantics treat `undefined` as "leave existing" — for an explicit
    // clear we set them to `undefined` via the typed object, which the
    // server recognises as removal.
    await ctx.db.patch(args.contractId, {
      isFlagged: false,
      flagReason: undefined,
      flaggedAt: undefined,
      flaggedBy: undefined,
    });
    const after = {
      isFlagged: false,
      flagReason: null,
      flaggedAt: null,
      flaggedBy: null,
    };

    await emitAudit(ctx, {
      action: "update",
      entityType: "contract",
      entityId: args.contractId,
      before,
      after,
      reason: "Contract follow-up flag cleared.",
    });

    return { contractId: args.contractId };
  },
});

/**
 * Shape of each row returned by `listFlaggedContracts`. Mirrors the
 * `ContractListRow` shape so the same list UI primitives can render the
 * flagged queue without bespoke types, plus the flag-specific fields.
 */
export interface FlaggedContractRow {
  contractId: ContractId;
  contractNumber: string;
  lotId: LotId;
  lotCode: string;
  customerId: CustomerId;
  customerFullName: string;
  kind: "full_payment" | "installment";
  totalPriceCents: number;
  state:
    | "active"
    | "paid_in_full"
    | "cancelled"
    | "voided"
    | "in_default";
  createdAt: number;
  flagReason: string;
  flaggedAt: number;
  /** Display name of the admin who flagged; falls back to email. */
  flaggedByName: string;
}

/**
 * Lists all currently-flagged contracts (Story 5.4 — staff queue + admin
 * review). Admin and office_staff can read; staff use this to power the
 * "Flagged for me" drill-down (Story 5.3 consumes), admin uses it as the
 * "open work I've routed to staff" view.
 *
 * Ordering: most-recently-flagged first (`flaggedAt` desc).
 *
 * Performance: uses the `by_isFlagged` index to bound the scan to the
 * flagged subset (typical-load steady state ≤ 50 open flags). Per-row
 * joins for lot code, customer name, and flagger name are fine at this
 * scale; if the queue grows to thousands, refactor to a snapshot doc.
 */
export const listFlaggedContracts = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<FlaggedContractRow[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const rows = (await ctx.db
      .query("contracts")
      .withIndex("by_isFlagged", (q) => q.eq("isFlagged", true))
      .collect()) as ContractDoc[];
    const sorted = [...rows].sort(
      (a, b) => (b.flaggedAt ?? 0) - (a.flaggedAt ?? 0),
    );
    const out: FlaggedContractRow[] = [];
    for (const row of sorted) {
      // Defensive: an index match without the corresponding fields would
      // indicate a partial patch — skip rather than emit a malformed row.
      if (
        row.isFlagged !== true ||
        row.flagReason === undefined ||
        row.flaggedAt === undefined ||
        row.flaggedBy === undefined
      ) {
        continue;
      }
      const lot = await ctx.db.get(row.lotId);
      // pii-read-ok: flagged-contracts list projects fullName only — address/email/phone/govId not returned
      const customer = await ctx.db.get(row.customerId);
      const flaggedByUser = await ctx.db.get(row.flaggedBy);
      const flaggedByName =
        (flaggedByUser?.name as string | undefined) ??
        (flaggedByUser?.email as string | undefined) ??
        "Unknown admin";
      out.push({
        contractId: row._id,
        contractNumber: row.contractNumber,
        lotId: row.lotId,
        lotCode: lot?.code ?? "[retired]",
        customerId: row.customerId,
        customerFullName: customer?.fullName ?? "[deleted customer]",
        kind: row.kind,
        totalPriceCents: row.totalPriceCents,
        state: row.state,
        createdAt: row.createdAt,
        flagReason: row.flagReason,
        flaggedAt: row.flaggedAt,
        flaggedByName,
      });
    }
    return out;
  },
});

/**
 * Story 3.7 — public arg shape for `voidContract`. Mirrors the
 * validator below. The reason is mandatory (≥ 10 chars after trim);
 * the UI's `VoidContractDialog` enforces the floor as well so the
 * server rejection is the safety net.
 */
export interface VoidContractArgs {
  contractId: ContractId;
  reason: string;
}

/**
 * Story 3.7 — return shape for `voidContract`. The UI uses
 * `contractId` to navigate back to the contracts list after the
 * mutation succeeds; `from` / `to` mirrors the `transitionState`
 * return so the toast / `ReactiveHighlight` flash share the same
 * shape across the two mutations.
 */
export interface VoidContractResult {
  contractId: ContractId;
  from: "active" | "paid_in_full" | "cancelled" | "voided" | "in_default";
  to: "voided";
}

/**
 * Admin-only pre-interment void workflow (Story 3.7, FR24).
 *
 * Wraps `transitionContractState` + `transitionLotStatus` to drive the
 * full operational void in a single atomic mutation:
 *
 *   1. `requireRole(["admin"])` — first awaited statement per Story
 *      1.2's `require-role-first-line` rule.
 *   2. Validate `reason` (≥ 10 chars after trim) — the UI dialog
 *      enforces the same floor; this is the server-side safety net.
 *   3. Load the contract (NOT_FOUND if missing) and assert the state
 *      is `active`. Paid-in-full, cancelled, voided, and in_default
 *      contracts cannot be voided through this workflow — paid-in-full
 *      specifically because the cemetery's books would silently lose
 *      a closed sale (the refund path lives in Phase 2 / Epic 4).
 *   4. Delegate the contract state change to `transitionContractState`
 *      (Story 1.7 helper). The helper patches `state: "voided"` and
 *      emits the `transition` audit row with the operator's reason.
 *   5. Revert the lot to `available` via `transitionLotStatus` so a
 *      future sale can pick the lot up again. Phase 1 lot lifecycle
 *      treats voided contracts as "lot was never sold" from the
 *      pickability standpoint; the audit log + the voided contract
 *      row preserve the historical record.
 *   6. Emit a `void` audit row anchored to the contract — this is the
 *      operator-facing "void" event distinct from the structural
 *      `transition` row Step 4 produced, so the audit timeline shows
 *      both the state machine edge and the void event with a single
 *      `reason` snapshot for cross-reference.
 *
 * Atomicity: every write happens inside the enclosing mutation
 * transaction. A throw anywhere (e.g. the lot is in `occupied` and the
 * lot state machine refuses the revert) rolls back the contract state
 * patch + every audit row.
 *
 * Immutability (FR31): this mutation does NOT touch `payments`,
 * `receipts`, or `paymentAllocations`. Receipts the customer already
 * holds remain valid official documents; refunds are a separate
 * out-of-band workflow.
 *
 * Throws:
 *   - `UNAUTHENTICATED` / `FORBIDDEN` — auth gate.
 *   - `VALIDATION` — reason missing or under 10 chars after trim.
 *   - `NOT_FOUND` — contract id does not resolve.
 *   - `INVARIANT_VIOLATION` — contract state is not `active` (cannot
 *     void paid_in_full / cancelled / voided / in_default).
 *   - `ILLEGAL_STATE_TRANSITION` — propagated from
 *     `transitionContractState` or `transitionLotStatus` if a forbidden
 *     edge is reached (defense-in-depth; the state check at step 3
 *     should catch this first).
 */
export const voidContract = mutationGeneric({
  args: {
    contractId: v.id("contracts"),
    reason: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    args: VoidContractArgs,
  ): Promise<VoidContractResult> => {
    await requireRole(ctx, ["admin"]);

    const trimmedReason =
      typeof args.reason === "string" ? args.reason.trim() : "";
    if (trimmedReason.length < 10) {
      throwError(
        ErrorCode.VALIDATION,
        "Void reason is required and must be at least 10 characters.",
        { reasonLength: trimmedReason.length },
      );
    }

    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }

    if (contract.state !== "active") {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        `Only active contracts can be voided (current state: ${contract.state}).`,
        { contractId: args.contractId, state: contract.state },
      );
    }

    const from = contract.state;

    // Step 1 — drive the contract through `active → voided`. The helper
    // patches `state` and emits a `transition` audit row with the
    // operator's reason. Failure rolls back the whole mutation.
    await transitionContractState(ctx, {
      contractId: args.contractId,
      to: "voided",
      reason: trimmedReason,
    });

    // Step 2 — revert the lot to `available` so it can be re-sold.
    // The lot state machine is the authority on whether the current
    // status is reversible; if not, this throws ILLEGAL_STATE_TRANSITION
    // and rolls back the contract state patch above. The lot SM's
    // `sold → available` edge requires a reason (see
    // `REASON_REQUIRED_TRANSITIONS` in `convex/lib/stateMachines.ts`)
    // — we pass the operator-supplied void reason verbatim for the
    // audit trail.
    await transitionLotStatus(ctx, {
      lotId: contract.lotId,
      to: "available",
      reason: `Contract voided: ${trimmedReason}`,
    });

    // Step 3 — close any open ownership row for this lot inside the
    // same mutation transaction (Epic-3/4 adversarial-review fix —
    // void-chain CRIT). Mirrors the `reclaimLot` closure: without it,
    // a voided-then-resold lot would carry overlapping open ownership
    // rows. Phase 1 expects at most one open ownership row per lot;
    // the `by_lot_effective` index (lotId + effectiveFrom) scans the
    // lot's ownership history, and the open row is the one whose
    // `effectiveTo === undefined`.
    const lotOwnerships = await ctx.db
      .query("ownerships")
      .withIndex("by_lot_effective", (q) =>
        q.eq("lotId", contract.lotId),
      )
      .collect();
    const openOwnership = lotOwnerships.find(
      (row) => row.effectiveTo === undefined,
    );
    if (openOwnership !== undefined) {
      const closeAt = Date.now();
      await ctx.db.patch(openOwnership._id, { effectiveTo: closeAt });
      await emitAudit(ctx, {
        action: "update",
        entityType: "ownership",
        entityId: openOwnership._id,
        before: { effectiveTo: null },
        after: { effectiveTo: closeAt },
        reason: `ownership_close_on_void: ${trimmedReason}`,
      });
    }

    // Step 4 — emit a `void` audit row anchored to the contract. The
    // `transition` row from `transitionContractState` captures the
    // state-machine edge; this row captures the operator-facing void
    // event with the same reason for cross-reference. Together they
    // give admins a complete forensic trail.
    await emitAudit(ctx, {
      action: "void",
      entityType: "contract",
      entityId: args.contractId,
      before: { state: from },
      after: { state: "voided" },
      reason: trimmedReason,
    });

    return {
      contractId: args.contractId,
      from,
      to: "voided",
    };
  },
});

/**
 * Story 4.4 — public arg shape for `markContractInDefault` (FR37).
 *
 * Mirrors the validator below. The reason is mandatory (≥ 10 chars
 * after trim); the UI's `MarkInDefaultDialog` enforces the floor
 * separately so the server rejection is the safety net.
 */
export interface MarkContractInDefaultArgs {
  contractId: ContractId;
  reason: string;
}

/**
 * Story 4.4 — return shape for `markContractInDefault`. The UI uses
 * `contractId` for post-mutation navigation / toast wiring; `from` /
 * `to` mirror the `transitionState` / `voidContract` shape so the
 * shared toast + `ReactiveHighlight` flash component is reusable
 * across all admin-driven contract state transitions.
 */
export interface MarkContractInDefaultResult {
  contractId: ContractId;
  from: "active" | "paid_in_full" | "cancelled" | "voided" | "in_default";
  to: "in_default";
}

/**
 * Admin-only "mark contract in default" workflow (Story 4.4, FR37).
 *
 * Wraps `transitionContractState` to drive the `active → in_default`
 * edge with the operator's reason captured in the audit log. The
 * lot status, ownership row, payments, receipts, and installments
 * are **deliberately untouched** — Story 4.4's central architectural
 * invariant is "default ≠ reclaim": defaulting flags a contract for
 * collections but the lot stays sold (per FR37 / FR38 separation)
 * until the separate admin reclaim action ships in Story 4.5.
 *
 * Why this lives alongside `transitionState` rather than replacing
 * it: `transitionState` is a generic state-edge mutation surface
 * (covers `active → cancelled`, `active → voided`, `active →
 * in_default`, reinstate, etc.); this mutation is the named,
 * user-facing entry point for the specific FR37 default workflow. UI
 * components hit this name explicitly so the audit trail and the
 * UX-level error mapping are pinned to a single dot-namespaced
 * `contract.markDefault` event rather than a generic transition.
 *
 * Pipeline (every step inside the enclosing mutation transaction):
 *
 *   1. `requireRole(ctx, ["admin"])` — first awaited statement per
 *      Story 1.2's `require-role-first-line` rule. Office Staff +
 *      Field Workers receive `FORBIDDEN` before any DB read.
 *   2. Validate `reason` (≥ 10 chars after trim). The UI dialog
 *      enforces the same floor; this is defense in depth.
 *   3. Load the contract (NOT_FOUND if missing). Assert state is
 *      `active`. paid_in_full / cancelled / voided / in_default
 *      contracts raise `INVARIANT_VIOLATION`; the state machine
 *      table also forbids these edges, but the explicit guard gives
 *      the dialog a friendlier error message ("This contract is no
 *      longer active. Refresh to view current status.").
 *   4. Delegate the state change to `transitionContractState`
 *      (Story 1.7 cornerstone helper). The helper:
 *        - Re-fetches the contract (race-safe re-read).
 *        - Calls `assertTransition({ entityType: "contract", from,
 *          to: "in_default", reason })`. The reason-required
 *          enforcement in `REASON_REQUIRED_TRANSITIONS` (Story 3.6)
 *          double-covers our defensive 10-char floor above.
 *        - Patches `contracts.state = "in_default"`.
 *        - Emits a `transition` audit row.
 *   5. Schedule `internal_recomputeAgingForContractMutation` via
 *      `ctx.scheduler.runAfter(0, ...)` so the `arAgingSnapshots`
 *      row for this contract is re-categorised under the
 *      `in_default` bucket within seconds rather than waiting for
 *      the next daily cron (Story 4.1). The recompute helper is
 *      idempotent — re-running yields the same snapshot row modulo
 *      `recomputedAt`. Scheduling-rather-than-inlining keeps the
 *      mutation transaction lean; the snapshot upsert runs in its
 *      own internal-mutation transaction immediately afterwards.
 *   6. Emit a `contract.markDefault` audit row anchored to the
 *      contract. The `transition` row from step 4 captures the
 *      state-machine edge; this row captures the operator-facing
 *      default event with the same reason for cross-reference.
 *      Together they give admins a complete forensic trail for the
 *      AR aging / collections audit (FR37).
 *
 * Atomicity & rollback: every write happens inside the enclosing
 * Convex mutation transaction. A throw anywhere (e.g. the state
 * machine refuses the edge) rolls back the state patch + every
 * audit row. The scheduled recompute fires only on commit — if the
 * mutation rolls back, the scheduler entry is rolled back too, so
 * the snapshot remains in its pre-default state.
 *
 * Invariants verified by unit tests (Story 4.4 AC4):
 *   - Lot status is UNCHANGED (lot stays `sold`).
 *   - Ownership row is UNCHANGED (no `effectiveTo` patch).
 *   - Receipts are UNCHANGED (FR31 immutability).
 *   - Payments are UNCHANGED.
 *   - Installments are UNCHANGED (they remain `overdue` /
 *     `pending` / etc.; the AR aging snapshot re-categorises the
 *     contract via the `state === "in_default"` filter).
 *
 * Throws:
 *   - `UNAUTHENTICATED` — no session.
 *   - `FORBIDDEN` — caller is not admin.
 *   - `VALIDATION` — reason missing or under 10 chars after trim.
 *   - `NOT_FOUND` — contract id does not resolve.
 *   - `INVARIANT_VIOLATION` — contract state is not `active`
 *     (paid_in_full / cancelled / voided / in_default).
 *   - `ILLEGAL_STATE_TRANSITION` — propagated from
 *     `transitionContractState` if the state machine refuses
 *     `active → in_default` (defense-in-depth; the explicit state
 *     check at step 3 should catch every case in practice).
 */
export const markContractInDefault = mutationGeneric({
  args: {
    contractId: v.id("contracts"),
    reason: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    args: MarkContractInDefaultArgs,
  ): Promise<MarkContractInDefaultResult> => {
    await requireRole(ctx, ["admin"]);

    const trimmedReason =
      typeof args.reason === "string" ? args.reason.trim() : "";
    if (trimmedReason.length < 10) {
      throwError(
        ErrorCode.VALIDATION,
        "Default reason is required and must be at least 10 characters.",
        { reasonLength: trimmedReason.length },
      );
    }

    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }

    if (contract.state !== "active") {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        `Only active contracts can be marked in-default (current state: ${contract.state}).`,
        { contractId: args.contractId, state: contract.state },
      );
    }

    const from = contract.state;

    // Step 1 — drive the contract through `active → in_default` via
    // the cornerstone helper. The helper re-fetches the contract
    // (race-safe), runs `assertTransition` (throws
    // ILLEGAL_STATE_TRANSITION on forbidden edges and
    // INVARIANT_VIOLATION on reason-required edges with no reason),
    // patches `state`, and emits the `transition` audit row with
    // the operator's reason. Failure rolls back the whole
    // mutation.
    await transitionContractState(ctx, {
      contractId: args.contractId,
      to: "in_default",
      reason: trimmedReason,
    });

    // Step 2 — schedule the AR aging snapshot recompute for this
    // contract so the dashboard's `in_default` bucket reflects the
    // new state within seconds rather than waiting for the next
    // daily cron run. The internal mutation is idempotent — it
    // upserts the snapshot row keyed by `contractId`. Scheduling
    // (rather than inlining) keeps this mutation's transaction
    // lean and matches the pattern used by Story 6.1's contract
    // PDF generation.
    const recomputeAgingActionRef = makeFunctionReference<
      "mutation",
      { contractId: ContractId },
      void
    >("arAging:internal_recomputeAgingForContractMutation");
    await ctx.scheduler.runAfter(0, recomputeAgingActionRef, {
      contractId: args.contractId,
    });

    // Step 3 — emit an operator-facing audit row that pairs with the
    // structural `transition` row from step 1. We use the defined
    // `"update"` audit action (the `AuditAction` enum in
    // `convex/lib/audit.ts` does not include a default-specific
    // namespace; the convention `voidContract` uses is to emit a
    // second audit row with a defined action plus a descriptive
    // `reason` so the operator-facing event is greppable from the
    // structural transition). The `reason` carries the user-supplied
    // text and a "markDefault:" prefix so audit-log queries can
    // filter on the prefix to surface every default event.
    await emitAudit(ctx, {
      action: "update",
      entityType: "contract",
      entityId: args.contractId,
      before: { state: from },
      after: { state: "in_default" },
      reason: `markDefault: ${trimmedReason}`,
    });

    return {
      contractId: args.contractId,
      from,
      to: "in_default",
    };
  },
});

// ---------------------------------------------------------------------------
// Story 6.2 — Office staff generates a demand letter for an overdue
// contract as a PDF (FR50). Sibling of the Story 6.1 contract-PDF flow
// above; same scheduler+callback shape, different action path, and a
// hard server-side gate that the contract must actually be overdue
// before the action is enqueued.
// ---------------------------------------------------------------------------

/**
 * Public arg shape for `generateDemandLetterRequest` (Story 6.2, FR50).
 *
 * Epic-3/4 adversarial-review HIGH fix — `idempotencyKey` is now an
 * optional arg. Same semantics as `generateContractPdfRequest`: when
 * supplied AND the contract row's `demandLetterIdempotencyKey`
 * matches, the mutation short-circuits to the cached status rather
 * than scheduling another action.
 */
export interface GenerateDemandLetterRequestArgs {
  contractId: ContractId;
  idempotencyKey?: string;
}

/**
 * Public return shape for `generateDemandLetterRequest`. Mirrors the
 * contract-PDF mutation:
 *   - `"scheduled"`         — fresh request enqueued.
 *   - `"already_generating"` — prior request with the same key in
 *                              flight.
 *   - `"ready"`             — cached PDF available for the matching
 *                              idempotency key.
 */
export interface GenerateDemandLetterRequestResult {
  contractId: ContractId;
  status: "scheduled" | "already_generating" | "ready";
}

/**
 * Function-reference path for the `actions/generateDemandLetterPdf:run`
 * Convex action. Mirrors `GENERATE_DEMAND_LETTER_PDF_FUNCTION_PATH` in
 * the action file; duplicated here as a string because the V8-runtime
 * mutation file cannot `import` from the `"use node"` action module
 * (cross-runtime imports leak Node-only deps like `pdfkit` into the V8
 * bundle and break the build). Drift between the two ends surfaces in
 * the dedicated `contracts-demand-letter.test.ts` unit test that pins
 * both strings to the same value.
 */
const GENERATE_DEMAND_LETTER_PDF_ACTION_PATH =
  "actions/generateDemandLetterPdf:run";

/**
 * Schedules a demand-letter PDF generation for the given contract
 * (Story 6.2, FR50). Mirrors the Story 6.1 contract-PDF mutation with
 * one critical addition — a server-side overdue gate per AC2 / NFR-S4.
 *
 * The mutation transaction:
 *
 *   1. Gates on `["admin", "office_staff"]` — Story 1.2's
 *      `require-role-first-line` rule is satisfied by the first
 *      `await requireRole(...)` below.
 *   2. Asserts the contract exists (so the UI surfaces NOT_FOUND
 *      synchronously rather than failing silently inside the action).
 *   3. Asserts the contract has at least one OVERDUE installment.
 *      "Overdue" is defined inline here as `installment.dueDate < now
 *      && status ∉ ["paid", "waived"] && (principalCents - paidCents)
 *      > 0`. This matches the AR-aging classifier in
 *      `convex/arAging.ts` (it considers the same set of rows when
 *      computing the bucket); the inline check avoids a cross-table
 *      read of `arAgingSnapshots` so the demand letter can be generated
 *      even on days where the daily AR-aging recompute hasn't run yet
 *      (Story 4.1's cron is once-daily; the demand letter is a manual
 *      operator action that should not wait for the next snapshot).
 *      If no overdue installments exist, the mutation throws
 *      `VALIDATION` (the system message specifies `VALIDATION`; the
 *      story spec called for `CONTRACT_NOT_OVERDUE` but the existing
 *      error vocabulary doesn't have that code — staying in-vocabulary
 *      keeps the error-translation layer honest, and the `message`
 *      string carries the operator-facing detail).
 *   4. Emits an audit row recording the generation request. Both
 *      first-generation and re-generation produce a row.
 *   5. Schedules the action via `ctx.scheduler.runAfter(0, ...)`.
 *
 * Atomicity: mirrors Story 6.1 — audit row + scheduled-function insert
 * commit together; the action is OUT of the mutation transaction.
 *
 * Idempotency: scheduling the same contract again before the prior
 * action completes is permitted — the most-recent-to-complete action
 * wins on the `demandLetterStorageId` field. The UI disables the
 * button while a generation is in flight; this is the defense-in-depth
 * path.
 *
 * Throws:
 *   - `UNAUTHENTICATED` / `FORBIDDEN` — auth gate.
 *   - `NOT_FOUND` — contract id does not resolve.
 *   - `VALIDATION` — contract has no overdue installments.
 */
export const generateDemandLetterRequest = mutationGeneric({
  args: {
    contractId: v.id("contracts"),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: GenerateDemandLetterRequestArgs,
  ): Promise<GenerateDemandLetterRequestResult> => {
    await requireRole(ctx, ["admin", "office_staff"]);

    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }

    // Epic-3/4 adversarial-review HIGH fix — idempotency short-circuit
    // mirrors `generateContractPdfRequest`. The overdue gate still
    // runs above the short-circuit at the next step because the
    // operator's intent on a "Retry" click after the contract was
    // paid off is "skip the letter, don't re-spam," so we'd rather
    // re-evaluate overdue status every call.
    const trimmedKey =
      typeof args.idempotencyKey === "string"
        ? args.idempotencyKey.trim()
        : "";
    const idempotencyKey = trimmedKey.length > 0 ? trimmedKey : null;
    if (
      idempotencyKey !== null &&
      contract.demandLetterIdempotencyKey === idempotencyKey
    ) {
      if (contract.demandLetterStatus === "ready") {
        return { contractId: args.contractId, status: "ready" };
      }
      if (contract.demandLetterStatus === "pending") {
        return {
          contractId: args.contractId,
          status: "already_generating",
        };
      }
    }

    // Overdue gate (AC2). Read all installment rows for the contract
    // and check whether at least one is currently overdue. We do this
    // inline (rather than reading `arAgingSnapshots`) so the operator
    // can generate a letter on a day the daily AR-aging recompute
    // hasn't yet run — the snapshot can be up to 24 hours stale by
    // design, but the demand letter must reflect the *current* state.
    const now = Date.now();
    const installments = await ctx.db
      .query("installments")
      .withIndex("by_contract", (q) => q.eq("contractId", args.contractId))
      .collect();
    let overdueCount = 0;
    let totalOverdueCents = 0;
    for (const row of installments) {
      if (row.status === "paid" || row.status === "waived") continue;
      if (row.dueDate >= now) continue;
      const remaining = row.principalCents - row.paidCents;
      if (remaining > 0) {
        overdueCount += 1;
        totalOverdueCents += remaining;
      }
    }
    if (overdueCount === 0) {
      throwError(
        ErrorCode.VALIDATION,
        "Demand letter is only available for overdue contracts.",
        {
          contractId: args.contractId,
          state: contract.state,
        },
      );
    }

    // Emit an "update" audit row to mark the regeneration request — the
    // contract row's `demandLetterStorageId` field is about to change.
    // `AuditAction` does not (yet) include a dedicated
    // `generate_demand_letter` action; `"update"` is the closest fit
    // and the `reason` string disambiguates on review. Future audit-
    // vocabulary extensions can introduce a dedicated action without
    // changing this call's shape.
    await emitAudit(ctx, {
      action: "update",
      entityType: "contract",
      entityId: args.contractId,
      before: {
        demandLetterStorageId: contract.demandLetterStorageId ?? null,
        demandLetterStatus: contract.demandLetterStatus ?? null,
      },
      after: {
        demandLetterStorageId: "(pending action)",
        demandLetterStatus: "pending",
        overdueCount,
        totalOverdueCents,
      },
      reason: "Contract demand letter generation requested.",
    });

    // Epic-3/4 HIGH fix — patch lifecycle bookkeeping BEFORE
    // scheduling the action. The retry-sweep cron reads
    // `demandLetterStatus` to decide what to re-attempt.
    await ctx.db.patch(args.contractId, {
      demandLetterStatus: "pending",
      demandLetterRetryCount: 0,
      demandLetterLastError: undefined,
      demandLetterIdempotencyKey: idempotencyKey ?? undefined,
    });

    // Schedule the Node-runtime action.
    const actionRef = makeFunctionReference<
      "action",
      { contractId: ContractId },
      { storageId: string }
    >(GENERATE_DEMAND_LETTER_PDF_ACTION_PATH);
    await ctx.scheduler.runAfter(0, actionRef, {
      contractId: args.contractId,
    });

    return {
      contractId: args.contractId,
      status: "scheduled",
    };
  },
});

/**
 * Public arg shape for `getDemandLetterUrl`.
 */
export interface GetDemandLetterUrlArgs {
  contractId: ContractId;
}

/**
 * Public return shape for `getDemandLetterUrl`. Mirrors the contract-
 * PDF query: `url` is `null` when the contract has never had a demand
 * letter generated (or when the blob has been GC'd — not a Phase 1
 * concern but the UI handles `null` gracefully).
 */
export interface GetDemandLetterUrlResult {
  url: string | null;
  generatedAt: number | null;
}

/**
 * Returns an auth-gated signed URL for the contract's most-recently
 * generated demand-letter PDF (Story 6.2, FR50 / NFR-S3). Office staff
 * + admin only — field workers do not see demand letters.
 *
 * Behavior:
 *   - Contract not found → throws `NOT_FOUND`.
 *   - Contract has no `demandLetterStorageId` → returns `{ url: null,
 *     generatedAt: null }` so the UI renders "No letter generated yet".
 *   - Contract has a `demandLetterStorageId` → returns a signed URL
 *     plus the `demandLetterGeneratedAt` timestamp for display.
 *
 * The signed URL is short-lived (Convex's storage URLs default to ~1
 * hour); the UI does not cache it across navigations.
 */
export const getDemandLetterUrl = queryGeneric({
  args: { contractId: v.id("contracts") },
  handler: async (
    ctx: QueryCtx,
    args: GetDemandLetterUrlArgs,
  ): Promise<GetDemandLetterUrlResult> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }
    if (contract.demandLetterStorageId === undefined) {
      return { url: null, generatedAt: null };
    }
    const url = await ctx.storage.getUrl(contract.demandLetterStorageId);
    return {
      url,
      generatedAt: contract.demandLetterGeneratedAt ?? null,
    };
  },
});

/**
 * Public return shape for `getContractOverdueSummary`. The UI uses this
 * to decide whether to show the "Generate demand letter" button in an
 * enabled state. `isOverdue` is `true` when at least one installment is
 * currently overdue (matches the gate enforced by
 * `generateDemandLetterRequest`); `overdueCount` and
 * `totalOverdueCents` surface the same numbers the demand letter will
 * print so the operator sees a preview before they click.
 */
export interface ContractOverdueSummary {
  contractId: ContractId;
  isOverdue: boolean;
  overdueCount: number;
  totalOverdueCents: number;
}

/**
 * Returns a per-contract overdue summary for the UI's demand-letter
 * affordance (Story 6.2). Office staff + admin only.
 *
 * The query reads installment rows directly (rather than consulting
 * `arAgingSnapshots`) so the UI agrees with the
 * `generateDemandLetterRequest` mutation's gate even between daily AR-
 * aging recomputes. The cost is one `by_contract` index scan per
 * contract detail page load — bounded by the per-contract installment
 * count (≤ 60 per the validator in `recordInstallmentSale`).
 */
export const getContractOverdueSummary = queryGeneric({
  args: { contractId: v.id("contracts") },
  handler: async (
    ctx: QueryCtx,
    args: { contractId: ContractId },
  ): Promise<ContractOverdueSummary> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }
    const now = Date.now();
    const installments = await ctx.db
      .query("installments")
      .withIndex("by_contract", (q) => q.eq("contractId", args.contractId))
      .collect();
    let overdueCount = 0;
    let totalOverdueCents = 0;
    for (const row of installments) {
      if (row.status === "paid" || row.status === "waived") continue;
      if (row.dueDate >= now) continue;
      const remaining = row.principalCents - row.paidCents;
      if (remaining > 0) {
        overdueCount += 1;
        totalOverdueCents += remaining;
      }
    }
    return {
      contractId: args.contractId,
      isOverdue: overdueCount > 0,
      overdueCount,
      totalOverdueCents,
    };
  },
});

/**
 * Story 4.5 — public arg shape for `reclaimLot` (FR38).
 *
 * The compacted Phase 1 reclaim flow accepts only the contract id +
 * a reason. The richer multi-policy shape (forfeit / refund / credit
 * + forfeitedPayments summary row) from the original story spec is a
 * follow-up that owns `convex/schema.ts` — this story stays within
 * the scoped file ownership brief (contracts.ts + lots.ts + the
 * contract detail page + the new ReclaimLotDialog component).
 */
export interface ReclaimLotArgs {
  contractId: ContractId;
  reason: string;
}

/**
 * Story 4.5 — return shape for `reclaimLot`. The UI uses
 * `contractId` for post-mutation navigation / toast wiring; `from`
 * / `to` mirror `voidContract` / `markContractInDefault` so the
 * shared toast + `ReactiveHighlight` flash component is reusable
 * across every admin-driven contract state transition.
 */
export interface ReclaimLotResult {
  contractId: ContractId;
  from: "in_default";
  to: "voided";
  lotId: LotId;
  lotFrom: "sold" | "defaulted";
  lotTo: "available";
}

/**
 * Admin-only "reclaim defaulted lot" workflow (Story 4.5, FR38).
 *
 * Closes the loop on the "default ≠ reclaim" risk-mitigation principle
 * (FR37 + FR38 separation). Story 4.4 ships the default-only flow that
 * flags a contract for collections WITHOUT touching the lot; this
 * mutation is the intentional separate action that returns the lot to
 * inventory once the cemetery owner has decided the defaulted contract
 * is unrecoverable.
 *
 * Pipeline (every step inside the enclosing mutation transaction):
 *
 *   1. `requireRole(ctx, ["admin"])` — first awaited statement per
 *      Story 1.2's `require-role-first-line` rule. Office Staff +
 *      Field Workers receive `FORBIDDEN` before any DB read.
 *   2. Validate `reason` (≥ 10 chars after trim). Mirrors
 *      `voidContract` / `markContractInDefault`'s server-side floor.
 *      `assertTransition` enforces a separate non-empty-reason guard
 *      via `REASON_REQUIRED_TRANSITIONS` — the explicit 10-char floor
 *      here is the defense-in-depth + operator-friendly error message
 *      path.
 *   3. Load the contract (NOT_FOUND if missing). Assert state is
 *      `in_default`. Active / paid_in_full / cancelled / voided
 *      contracts raise `INVARIANT_VIOLATION` — reclaim is only valid
 *      after a contract has been explicitly flagged for default via
 *      Story 4.4's `markContractInDefault`. Pre-interment cancellation
 *      runs through Story 3.7's `voidContract`, not this mutation.
 *   4. Drive the contract through `in_default → voided` via
 *      `transitionContractState` (Story 1.7 / 3.6 cornerstone).
 *      The helper patches `state` and emits the `transition` audit
 *      row with the operator's reason. The legal edge is in the
 *      contract transition table (Story 3.6):
 *        contract.in_default → ["active", "voided", "cancelled"].
 *   5. Drive the lot back to `available`. The lot transition table
 *      (Story 1.7) only legalises `defaulted → available`. When the
 *      contract was defaulted via Story 4.4, the lot was left at
 *      `sold` (default ≠ reclaim). Reclaim therefore walks the lot
 *      through two transitions in sequence — `sold → defaulted` first
 *      (legal: `lot.sold → ["occupied", "defaulted"]`), then
 *      `defaulted → available` (legal: `lot.defaulted → ["available"]`)
 *      — within a single mutation. If the lot is already `defaulted`
 *      (e.g. an admin manually flipped it via a future tool), the
 *      first step is skipped. Any other lot status (occupied,
 *      reserved, available, cancelled, transferred) raises
 *      `ILLEGAL_STATE_TRANSITION` and rolls the entire mutation back
 *      — occupied lots are deliberately non-reclaimable per Story 4.5
 *      Dev Notes (interred remains require a separate workflow).
 *   6. Emit an operator-facing `void` audit row anchored to the
 *      contract with a `reclaim:` prefix on the reason. Mirrors the
 *      Story 3.7 `voidContract` audit-emission shape — both reclaim
 *      and pre-interment void are operator-facing "void" events on a
 *      contract; the `reclaim:` reason prefix distinguishes them in
 *      audit queries without needing a new `AuditAction` enum value.
 *   7. Schedule `internal_recomputeAgingForContractMutation` via
 *      `ctx.scheduler.runAfter(0, ...)` (Epic 4 adversarial-review
 *      fix — 2026-05-24) so the AR aging snapshot for this contract
 *      is recomputed within seconds rather than waiting for the next
 *      daily cron. The contract transitioned to `voided`, which the
 *      recompute helper treats as "drop the snapshot row" — every
 *      reclaimed contract therefore disappears from the dashboard's
 *      `in_default` bucket reactively.
 *
 * Atomicity & rollback: every write happens inside the enclosing
 * Convex mutation transaction. A throw anywhere (e.g. the lot
 * transition refuses an `occupied` lot) rolls back the contract
 * state patch + every audit row. The scheduled recompute fires only
 * on commit — if the mutation rolls back, the scheduler entry is
 * rolled back too, so the snapshot remains in its pre-reclaim state.
 *
 * Immutability (FR31): this mutation does NOT touch `payments`,
 * `receipts`, `paymentAllocations`, or `installments`. Receipts the
 * customer already holds remain valid official documents; payment
 * rows stay immutable; installment rows remain in their last-known
 * state (paid / overdue / pending). The refund / credit policy
 * decision around prior payments is a follow-up that owns
 * `convex/schema.ts` (`forfeitedPayments` summary table) — see the
 * Story 4.5 spec for the full multi-policy shape that follow-up will
 * land.
 *
 * Throws:
 *   - `UNAUTHENTICATED` — no session.
 *   - `FORBIDDEN` — caller is not admin.
 *   - `VALIDATION` — reason missing or under 10 chars after trim.
 *   - `NOT_FOUND` — contract id does not resolve.
 *   - `INVARIANT_VIOLATION` — contract state is not `in_default`
 *     (active / paid_in_full / cancelled / voided).
 *   - `ILLEGAL_STATE_TRANSITION` — propagated from
 *     `transitionContractState` or `transitionLotStatus` if a forbidden
 *     edge is reached (notably: lot in `occupied` / `cancelled` /
 *     `transferred` / `reserved` / `available` states).
 */
export const reclaimLot = mutationGeneric({
  args: {
    contractId: v.id("contracts"),
    reason: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    args: ReclaimLotArgs,
  ): Promise<ReclaimLotResult> => {
    await requireRole(ctx, ["admin"]);

    const trimmedReason =
      typeof args.reason === "string" ? args.reason.trim() : "";
    if (trimmedReason.length < 10) {
      throwError(
        ErrorCode.VALIDATION,
        "Reclaim reason is required and must be at least 10 characters.",
        { reasonLength: trimmedReason.length },
      );
    }

    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }

    if (contract.state !== "in_default") {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        `Only in_default contracts can be reclaimed (current state: ${contract.state}).`,
        { contractId: args.contractId, state: contract.state },
      );
    }

    const lot = await ctx.db.get(contract.lotId);
    if (lot === null) {
      throwError(ErrorCode.NOT_FOUND, "Lot not found for this contract.", {
        contractId: args.contractId,
        lotId: contract.lotId,
      });
    }

    const lotFrom = lot.status;
    if (lotFrom !== "sold" && lotFrom !== "defaulted") {
      throwError(
        ErrorCode.ILLEGAL_STATE_TRANSITION,
        `Cannot reclaim lot from status "${lotFrom}". Only sold or defaulted lots can be reclaimed.`,
        { lotId: lot._id, status: lotFrom },
      );
    }

    const from = contract.state; // "in_default"

    // Step 1 — drive the contract through `in_default → voided` via
    // the cornerstone helper. The helper re-fetches the contract
    // (race-safe), runs `assertTransition` (throws
    // ILLEGAL_STATE_TRANSITION on forbidden edges and
    // INVARIANT_VIOLATION on reason-required edges with no reason —
    // `contract:in_default→voided` is in REASON_REQUIRED_TRANSITIONS
    // per Story 3.6), patches `state`, and emits the `transition`
    // audit row with the operator's reason. Failure rolls back the
    // whole mutation.
    await transitionContractState(ctx, {
      contractId: args.contractId,
      to: "voided",
      reason: trimmedReason,
    });

    // Step 2 — drive the lot back to `available`. The lot transition
    // table (Story 1.7) only legalises `defaulted → available`. When
    // the contract was defaulted via Story 4.4, the lot stayed `sold`
    // (default ≠ reclaim). Reclaim therefore walks the lot through
    // `sold → defaulted` first when needed, then `defaulted →
    // available`. The intermediate `sold → defaulted` step is
    // bookkeeping that mirrors what an admin would do manually if
    // they marked the lot defaulted before reclaiming — keeping the
    // audit trail honest about the lot's transition history.
    if (lotFrom === "sold") {
      await transitionLotStatus(ctx, {
        lotId: lot._id,
        to: "defaulted",
        reason: `Lot reclaimed — ${trimmedReason}`,
      });
    }
    await transitionLotStatus(ctx, {
      lotId: lot._id,
      to: "available",
      reason: `Lot reclaimed — ${trimmedReason}`,
    });

    // Step 3 — close any open ownership row for this lot inside the
    // same mutation transaction (Epic-3/4 adversarial-review fix —
    // void-chain CRIT). Without this, a reclaimed lot that gets
    // re-sold would land a second open ownership row alongside the
    // unclosed original — overlapping open ownership rows are a data
    // integrity bug (the "current owner of lot X" query relies on
    // exactly one open row per lot). We use the `by_lot_effective`
    // index (lotId + effectiveFrom) to scan ownership rows for the
    // lot; the open row is the one whose `effectiveTo === undefined`.
    // Phase 1 expects at most one open row per lot.
    const lotOwnerships = await ctx.db
      .query("ownerships")
      .withIndex("by_lot_effective", (q) =>
        q.eq("lotId", lot._id),
      )
      .collect();
    const openOwnership = lotOwnerships.find(
      (row) => row.effectiveTo === undefined,
    );
    if (openOwnership !== undefined) {
      const closeAt = Date.now();
      await ctx.db.patch(openOwnership._id, { effectiveTo: closeAt });
      await emitAudit(ctx, {
        action: "update",
        entityType: "ownership",
        entityId: openOwnership._id,
        before: { effectiveTo: null },
        after: { effectiveTo: closeAt },
        reason: `ownership_close_on_reclaim: ${trimmedReason}`,
      });
    }

    // Step 4 — emit an operator-facing `void` audit row anchored to
    // the contract. This pairs with the structural `transition` row
    // from step 1: the transition row captures the state-machine edge,
    // and this `void` row captures the reclaim event itself. The
    // `reason` carries the user-supplied text with a "reclaim:" prefix
    // so audit-log queries can filter on the prefix to surface every
    // reclaim event independent of pre-interment voids (Story 3.7),
    // which use the same `"void"` action with no prefix.
    await emitAudit(ctx, {
      action: "void",
      entityType: "contract",
      entityId: args.contractId,
      before: { state: from },
      after: { state: "voided" },
      reason: `reclaim: ${trimmedReason}`,
    });

    // Step 5 — schedule the AR aging snapshot recompute for this
    // contract (Epic 4 adversarial-review fix — 2026-05-24). The
    // contract's state changed from `in_default` → `voided`, so the
    // snapshot row this contract owns must be DROPPED — the
    // `computeContractAging` helper filters to `active` /
    // `in_default` and returns `null` for `voided`, which causes
    // the upsert path to delete the existing snapshot. Without this
    // hook the snapshot lingered in the `in_default` bucket until
    // the next 01:00 Manila cron, inflating the dashboard count by
    // every reclaimed-but-not-yet-recomputed contract.
    //
    // Mirrors the `makeFunctionReference` shape used by
    // `markContractInDefault` above — same internal mutation, same
    // string path; `_generated/` is not required at typecheck time.
    const reclaimRecomputeRef = makeFunctionReference<
      "mutation",
      { contractId: ContractId },
      void
    >("arAging:internal_recomputeAgingForContractMutation");
    await ctx.scheduler.runAfter(0, reclaimRecomputeRef, {
      contractId: args.contractId,
    });

    return {
      contractId: args.contractId,
      from,
      to: "voided",
      lotId: lot._id,
      lotFrom,
      lotTo: "available",
    };
  },
});
