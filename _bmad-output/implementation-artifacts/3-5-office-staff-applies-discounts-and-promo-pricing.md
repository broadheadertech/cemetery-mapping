# Story 3.5: Office Staff Applies Discounts and Promo Pricing

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **Office Staff**,
I want **to apply a configurable discount (fixed-amount peso, percentage, or a validated promo code) to a sale from an inline `DiscountPanel` on the `SaleForm`, with a required note explaining the rationale, and have the discount flow transparently through `postFinancialEvent` so it shows up as a line item on the receipt and as an audit-logged field on the contract**,
so that **special pricing (family discount, anniversary promo, manager override) is recorded transparently as data — not as silent price adjustments that leave the receipt total mysteriously different from the lot's listed price** (FR22).

This story is the **first per-sale modifier** that consumes the cornerstone's already-existing `discountCents` payload field (Story 3.2 reserved it; Story 3.3 hard-coded `0`; this story replaces the zero with a real value). The scope is: a small `DiscountPanel` UI that the SaleForm's Full Payment + Installment tabs both consume, an `activePromos` config table for promo-code lookups, server-side validation of the discount against the lot's base price, and audit fields on the contract capturing the actor + reason + applied amount. The story extends Story 3.3's `FullPaymentTab` and Story 3.4's `InstallmentTab` to surface the discount above the schedule preview; the schedule preview (Story 3.4) automatically picks up the discounted total because it reads `totalCents = basePriceCents − discountCents` from the live form values.

## Acceptance Criteria

1. **AC1 — `DiscountPanel` opens inline from the SaleForm and supports three discount types**: an "Apply discount" button on the SaleForm (visible on both Full Payment and Installment tabs, positioned between the LotPicker / CustomerPicker block and the Method / Date block) expands an inline panel (NOT a modal — UX § 1294 "Inline > modal") with: (a) a discount type radio group (Fixed amount / Percentage / Promo code) defaulting to Fixed amount, (b) a value input that re-labels itself based on type (₱ prefix for Fixed amount, `%` suffix for Percentage, plain text for Promo code), (c) a required Note textarea (min 5 chars, max 280 chars) explaining the rationale ("Family loyalty," "Manager override per call with Mr. Reyes," etc.), (d) "Apply" and "Cancel" buttons. The panel collapses to a single chip — `Discount: ₱500.00 (Family loyalty) [Remove]` — once a discount is applied; clicking the chip re-opens the panel for edits.

2. **AC2 — Percentage discount + promo-code discount validate against `activePromos` table and the lot's base price**: Percentage values must be `0 < percent ≤ 50` (50% is the hard cap; an attempt to exceed throws an inline error "Discount cannot exceed 50% of base price. Contact admin for higher discounts."). Fixed-amount values must be `0 < amountCents ≤ basePriceCents` (cannot exceed the lot's listed price; an attempt throws inline error "Discount would make the price negative."). Promo codes are checked client-side via `useQuery(api.promos.validatePromo, { code })` against the `activePromos` config table; valid codes auto-populate the discount type + value from the code's record; expired or unknown codes show inline error "Promo code not found or expired." Promo code lookups are case-insensitive and trimmed.

3. **AC3 — Schedule preview + receipt preview reflect the discount as a line item, not a quietly-adjusted price**: with a discount applied, (a) the Full Payment tab's price summary block shows `Base price: ₱20,000.00`, `Discount: −₱2,000.00 (Family loyalty)`, `Total: ₱18,000.00` — all three rows visible, tabular numerics, the discount in red text. (b) The Installment tab's `SchedulePreview` (Story 3.4) re-renders with `(basePriceCents − discountCents − downPaymentCents) / termMonths` as the per-installment amount; a banner above the schedule reads "Discount applied: ₱2,000.00 — Family loyalty (Maria Santos, 17 May 2026)." (c) The receipt preview modal (Story 3.3 + 3.4) shows the discount as a line item between base price and total, preserving the BIR-receipt convention that itemized prices are visible.

4. **AC4 — Discount data is persisted on the contract and routed through `postFinancialEvent` audit emission**: the `recordFullPaymentSale` (Story 3.3) + `recordInstallmentSale` (Story 3.4) mutations now accept `discountCents`, `discountType` (`"fixed"` | `"percentage"` | `"promo_code"`), `discountNote`, and `promoCodeId?` arguments. They pass these through to `postFinancialEvent` via an extended sale-payload (Story 3.2 Task 5's `sale_full` + `sale_installment` discriminated union variants get the new fields added in this story's Task 1). The cornerstone (Story 3.2 Task 7 / 8) writes the discount fields onto the contract document AND includes the discount details in the `emitAudit` `after` snapshot. The contract document gains: `discountCents`, `discountType`, `discountNote`, `discountAppliedBy: Id<"users">`, `discountAppliedAt: number`, `promoCodeId: v.optional(v.id("activePromos"))`.

5. **AC5 — `activePromos` config table + admin seed flow**: a new `activePromos` table (one row per promo code) is created in `convex/schema.ts` with: `code`, `discountType` (fixed / percentage), `discountValue` (cents for fixed; basis points for percentage), `validFrom`, `validUntil` (optional, null = no expiry), `maxUses` (optional), `useCount`, `isActive`, `description`, `createdBy`, `createdAt`. Admins can seed initial promo codes via an internal mutation `convex/admin.ts > seedPromoCode` (one-off seeding utility — full admin UI for promo management is a Phase 2 backlog item, NOT this story). For Phase 1, the table ships with **zero rows** by default; promo codes are only available once an admin runs the seed mutation or inserts via the Convex dashboard. The Office Staff promo-code UI gracefully handles "no active promos exist" — the validation simply returns "Promo code not found or expired."

## Tasks / Subtasks

### Schema accretion (AC2, AC4, AC5)

- [ ] **Task 1: Extend `contracts` table with discount fields** (AC: 4)
  - [ ] **UPDATE** `convex/schema.ts`. Story 3.2 created the `contracts` table; Story 3.4 added installment fields. This story adds discount fields:
    ```ts
    discountCents: v.number(),                  // 0 if no discount; was already added in Story 3.2 stubbed at 0
    discountType: v.optional(v.union(           // null when discountCents === 0
      v.literal("fixed"),
      v.literal("percentage"),
      v.literal("promo_code"),
    )),
    discountNote: v.optional(v.string()),       // required when discountCents > 0
    discountAppliedBy: v.optional(v.id("users")),
    discountAppliedAt: v.optional(v.number()),
    promoCodeId: v.optional(v.id("activePromos")),
    ```
  - [ ] **Invariant:** when `discountCents > 0`, all of `discountType`, `discountNote`, `discountAppliedBy`, `discountAppliedAt` MUST be set. When `discountCents === 0`, all four MUST be `undefined`. Enforce in the cornerstone (Task 4) via `assertDiscountInvariant`.

- [ ] **Task 2: Create `activePromos` table** (AC: 5)
  - [ ] **NEW** in `convex/schema.ts`:
    ```ts
    activePromos: defineTable({
      code: v.string(),                           // case-insensitive lookup; stored upper-case
      discountType: v.union(v.literal("fixed"), v.literal("percentage")),
      discountValue: v.number(),                  // cents for fixed; basis points (200 = 2%) for percentage
      validFrom: v.number(),
      validUntil: v.optional(v.number()),         // null = no expiry
      maxUses: v.optional(v.number()),            // null = unlimited
      useCount: v.number(),                       // incremented on each successful sale that uses the code
      isActive: v.boolean(),
      description: v.string(),                    // shown in admin UI; also surfaces in audit log
      createdBy: v.id("users"),
      createdAt: v.number(),
    })
      .index("by_code", ["code"])
      .index("by_active", ["isActive"]),
    ```
  - [ ] **Why basis points for percentages and not a float**: avoids the `*100` / `/100` floating-point hazard the architecture's money-math rule (§ Format Patterns > Money) forbids. `200 bp = 2%`; computed as `basePriceCents * discountValueBp / 10000` with integer math throughout.

### Discount math helpers (AC2, AC3)

- [ ] **Task 3: Implement `convex/lib/discounts.ts`** (**NEW**) (AC: 2, AC: 3)
  - [ ] Pure-function helpers (no `ctx` access — testable in isolation):
    ```ts
    // Convert a discount form payload to its cents amount, given the lot's base price.
    export function computeDiscountCents(
      basePriceCents: number,
      discount: { type: "fixed"; valueCents: number } | { type: "percentage"; valueBp: number },
    ): number;

    // Validate a fully-formed discount payload (the form's submitted state).
    // Throws ConvexError(ErrorCode.INVARIANT_VIOLATION, message) for any rule break.
    export function assertDiscountValid(args: {
      basePriceCents: number;
      discountCents: number;
      discountType: "fixed" | "percentage" | "promo_code" | undefined;
      discountNote: string | undefined;
    }): void;

    // Invariant: discountCents > 0 ↔ all discount-* fields present.
    export function assertDiscountInvariant(contract: ContractDoc): void;
    ```
  - [ ] **Hard rules** the helper enforces:
    - `0 ≤ discountCents ≤ basePriceCents` (negative discount or discount exceeding base = `INVARIANT_VIOLATION`).
    - For percentage: `0 < valueBp ≤ 5000` (50% hard cap).
    - For percentage: `discountCents = Math.floor(basePriceCents * valueBp / 10000)` — integer math; the floor is intentional (round in the customer's favor when computing the **discount**, which is fine — the contract pays MORE, not less, on rounding).
    - When `discountCents > 0`, `discountNote.length ≥ 5` AND `discountNote.length ≤ 280`. Trim before checking.
    - For promo_code type: a `promoCodeId` must accompany; validated separately in Task 5.

- [ ] **Task 4: Update `postFinancialEvent` to consume discount fields** (AC: 4)
  - [ ] **UPDATE** `convex/lib/postFinancialEvent.ts` (Story 3.2's cornerstone). The `sale_full` and `sale_installment` payload variants gain:
    ```ts
    discountCents: number;                                   // 0 if no discount
    discountType?: "fixed" | "percentage" | "promo_code";
    discountNote?: string;
    promoCodeId?: Id<"activePromos">;
    ```
  - [ ] In `prepareSaleFull` and `prepareSaleInstallment`: call `assertDiscountValid` with the payload; if a `promoCodeId` is present, fetch the promo row, assert it is active + not expired + below maxUses, increment its `useCount` (this is a financial-table-adjacent write but happens INSIDE the same mutation — Convex atomicity covers it; the `useCount` increment + the contract write commit together or not at all), include the promo `description` in the audit `after` snapshot.
  - [ ] Compute `totalCents = basePriceCents − discountCents` (this replaces the earlier `totalCents = basePriceCents − 0`). For installments: `outstandingBalanceCents = totalCents − downPaymentCents`. Pass `discountCents` and `totalCents` down to the installment-schedule generator (Story 3.4's `generateInstallmentSchedule`) so the per-installment math uses the **discounted** total.
  - [ ] Persist `discountCents`, `discountType`, `discountNote`, `discountAppliedBy = ctx.userId`, `discountAppliedAt = Date.now()`, `promoCodeId` on the contract row.
  - [ ] **Audit emission:** the cornerstone already emits one audit row per `postFinancialEvent` call (Story 3.2 step 6). When a discount is applied, the `after` snapshot includes all six discount fields. Story 3.2's `emitAudit` redacts PII via `redactPii` — `discountNote` is not PII and is NOT redacted (it's a business reason, like "Family loyalty"). Verify this in a test: a discount note with "Maria's son's wedding" is stored verbatim in the audit; a customer-name field stored in the same `after` snapshot is redacted.

- [ ] **Task 5: Implement promo-code validation query** (AC: 2, AC: 5)
  - [ ] Create `convex/promos.ts` (**NEW**). Export:
    ```ts
    export const validatePromo = query({
      args: { code: v.string() },
      handler: async (ctx, { code }) => {
        await requireRole(ctx, ["office_staff", "admin"]);
        const normalized = code.trim().toUpperCase();
        const promo = await ctx.db
          .query("activePromos")
          .withIndex("by_code", q => q.eq("code", normalized))
          .unique();
        if (!promo) return { ok: false as const, reason: "not_found" };
        if (!promo.isActive) return { ok: false as const, reason: "inactive" };
        const now = Date.now();
        if (promo.validFrom > now) return { ok: false as const, reason: "not_yet_active" };
        if (promo.validUntil && promo.validUntil < now) return { ok: false as const, reason: "expired" };
        if (promo.maxUses && promo.useCount >= promo.maxUses) return { ok: false as const, reason: "exhausted" };
        return {
          ok: true as const,
          promoId: promo._id,
          discountType: promo.discountType,
          discountValue: promo.discountValue,
          description: promo.description,
        };
      },
    });
    ```
  - [ ] Also export `seedPromoCode` as an `internalMutation` (admin-only, called from Convex CLI / dashboard for Phase 1 — full admin UI is Phase 2 backlog).

### UI — DiscountPanel + SaleForm integration (AC1, AC2, AC3)

- [ ] **Task 6: Create `src/components/SaleForm/DiscountPanel.tsx`** (**NEW**) (AC: 1, AC: 2)
  - [ ] `"use client"`. Props: `{ basePriceCents, onApply, onCancel, currentDiscount? }`. React Hook Form sub-form (use `useFormContext` from the parent SaleForm so submission flows correctly).
  - [ ] Fields:
    - Discount type radio group: `Fixed amount` (default) / `Percentage` / `Promo code` — three options stacked vertically on mobile, horizontally on `≥sm` screens (UX § Form Patterns; uses `RadioGroup` from shadcn/ui).
    - Value input — re-labels based on type:
      - Fixed: `₱` prefix, tabular numerics, accepts `1,200` or `1200`, coerced to centavos.
      - Percentage: plain numeric input + `%` suffix, accepts `0.01` – `50` (two-decimal precision), coerced to basis points (`* 100` is FORBIDDEN per money-math rule; use a `pctToBp(pctString)` helper in `convex/lib/money.ts` that parses the string to integer basis points directly).
      - Promo code: plain text input; `onBlur` (300ms debounce) calls `useQuery(api.promos.validatePromo, { code })`.
    - Note textarea — `min 5 / max 280` chars; counter visible (`5/280`); error inline if too short.
    - Buttons: `Apply` (primary, disabled until form is valid), `Cancel` (secondary, ghost variant).
  - [ ] On Apply: `onApply({ discountCents, discountType, discountNote, promoCodeId? })` — parent collapses the panel into a chip.
  - [ ] **Reactive promo validation** (UX-DR21 — skeleton during query, not spinner): while `useQuery` is loading, the Apply button is disabled and the value-label area shows a 16px skeleton. On `ok: false`, render an inline error sentence ("Promo code not found or expired." / "This promo code has expired." / "Promo code limit reached.") below the value input. On `ok: true`, show a green check + the promo's `description` as helper text, and auto-populate the underlying `discountType` + `discountValue` from the promo row.
  - [ ] Keyboard: tab order radio → value → note → Apply; Esc cancels (matches modal-cancel pattern).

- [ ] **Task 7: Create `src/components/SaleForm/DiscountChip.tsx`** (**NEW**) (AC: 1)
  - [ ] When a discount is applied, the SaleForm renders this compact chip in place of the "Apply discount" button:
    ```
    [ Discount: ₱500.00 (Family loyalty)  [Edit]  [Remove] ]
    ```
  - [ ] Edit re-opens the DiscountPanel (parent passes `currentDiscount` so the panel pre-populates).
  - [ ] Remove resets the discount to zero (sets `discountCents: 0` + clears all discount-* fields on the form state).
  - [ ] Uses shadcn/ui `Badge` styling with `bg-amber-50 text-amber-900` (UX § Color > "Discount applied" hint — match the reactive flash palette so the chip reads as a deliberate intervention).

- [ ] **Task 8: Update `FullPaymentTab.tsx` to render the price summary block** (AC: 3)
  - [ ] **UPDATE** `src/components/SaleForm/FullPaymentTab.tsx` (Story 3.3). Between the LotPicker and the Method block, add:
    - The "Apply discount" button / DiscountChip (only one visible at a time).
    - When a discount is active: a three-row price summary:
      ```
      Base price          ₱20,000.00
      Discount           −₱ 2,000.00   (Family loyalty)
      Total               ₱18,000.00
      ```
    - All values use `formatPeso` (already shipped); tabular numerics; `text-rose-600` on the discount row (consistent with the architecture's debit / credit color hint).
  - [ ] When `discountCents === 0`: hide the entire summary block; only the LotPicker's "Price" field is visible (existing Story 3.3 behaviour).
  - [ ] When the SaleForm submits, include `discountCents`, `discountType`, `discountNote`, `promoCodeId?` in the mutation args.

- [ ] **Task 9: Update `InstallmentTab.tsx` to handle discount in the schedule** (AC: 3)
  - [ ] **UPDATE** `src/components/SaleForm/InstallmentTab.tsx` (Story 3.4). The discount panel + chip live in the same position as Full Payment.
  - [ ] When a discount is applied, the `SchedulePreview` re-renders with `totalCents = basePriceCents − discountCents`. The per-installment amount becomes `(totalCents − downPaymentCents) / termMonths` (Story 3.4's existing math, just with a different total). Remainder allocation logic (Story 3.4 AC3 — last installment gets the cents remainder) is unchanged.
  - [ ] Above the schedule, add a banner row when discount is active: `Discount applied: ₱2,000.00 — Family loyalty (Maria Santos, 17 May 2026)` — `Maria Santos` is the current user's displayName; the timestamp is `formatManilaDate(Date.now())`. **This banner is FYI only; the discount panel above is the editable source of truth.**

### Update calling mutations (AC4)

- [ ] **Task 10: Update `recordFullPaymentSale` mutation** (AC: 4)
  - [ ] **UPDATE** `convex/sales.ts` (Story 3.3). Add args:
    ```ts
    discountCents: v.number(),                   // 0 if no discount
    discountType: v.optional(v.union(
      v.literal("fixed"),
      v.literal("percentage"),
      v.literal("promo_code"),
    )),
    discountNote: v.optional(v.string()),
    promoCodeId: v.optional(v.id("activePromos")),
    ```
  - [ ] Handler stays two-lines-of-logic: `requireRole` then `postFinancialEvent({ kind: "sale_full", …args, discountCents, discountType, discountNote, promoCodeId })`. **All validation moves to the cornerstone's `assertDiscountValid` (Task 3).** Defensive duplication is forbidden by the architecture.

- [ ] **Task 11: Update `recordInstallmentSale` mutation** (AC: 4)
  - [ ] **UPDATE** `convex/sales.ts` (Story 3.4). Same arg additions as Task 10; same delegation pattern to `postFinancialEvent({ kind: "sale_installment", … })`.

### Tests (all ACs)

- [ ] **Task 12: Unit tests for `convex/lib/discounts.ts`** (AC: 2, AC: 3)
  - [ ] **NEW** `tests/unit/convex/lib/discounts.test.ts`. Coverage targets ≥ 95% (financial-adjacent logic).
  - [ ] Test cases:
    - `computeDiscountCents` with fixed `{ valueCents: 200000 }` → returns `200000`.
    - `computeDiscountCents` with percentage `{ valueBp: 1000 }` (10%) on `basePriceCents: 2000000` → returns `200000` (10% of ₱20,000 = ₱2,000).
    - `computeDiscountCents` with percentage `{ valueBp: 1234 }` (12.34%) on `basePriceCents: 100001` → returns `12340` (integer math; `Math.floor(100001 * 1234 / 10000) = Math.floor(12340.1234) = 12340`).
    - `assertDiscountValid` happy paths: zero discount with no other fields; valid fixed; valid percentage; valid promo_code with promoId.
    - `assertDiscountValid` error paths: `discountCents > basePriceCents` (INVARIANT_VIOLATION); `valueBp > 5000` (over 50% cap); `discountNote` length < 5 or > 280; `discountCents > 0` with no note; `discountCents === 0` with a note set (invariant violation — note without discount).
    - `assertDiscountInvariant` round-trip: a contract with `discountCents: 0` and all discount-* fields undefined passes; a contract with `discountCents: 200000` and `discountNote: undefined` throws.

- [ ] **Task 13: Update `postFinancialEvent.test.ts` for discount paths** (AC: 4)
  - [ ] **UPDATE** Story 3.2's test file `tests/unit/convex/lib/postFinancialEvent.test.ts`. Add `describe("discount handling")` block:
    - `sale_full` with `discountCents: 200000` → contract row has all six discount-* fields populated; `totalCents = basePriceCents − discountCents`; audit `after` snapshot contains `discountNote: "Family loyalty"` un-redacted.
    - `sale_full` with `discountCents: 0` → contract row's discount-* fields are all `undefined`; audit snapshot has no discount keys.
    - `sale_installment` with `discountCents: 200000` → installment amounts sum to `(basePriceCents − discountCents − downPaymentCents)`; remainder still in final installment.
    - `sale_full` with `promoCodeId` → after the mutation, the promo's `useCount` is incremented by 1; multiple sales with the same promoId increment correctly.
    - `sale_full` with `promoCodeId` pointing to an inactive promo → throws `INVARIANT_VIOLATION` ("Promo is inactive"); no writes occur (count rows pre/post).
    - `sale_full` with `promoCodeId` pointing to an expired promo → throws `INVARIANT_VIOLATION` ("Promo expired").
    - `sale_full` with `discountCents > basePriceCents` → throws `INVARIANT_VIOLATION`; no contract row written; no `useCount` increment.
  - [ ] **Critical pre-write guard test:** a discount that fails `assertDiscountValid` must NOT cause any writes — not even the serial counter increment. This re-confirms Story 3.2's "state-guard before serial allocation" ordering applies to discount validation too. Verify via row counts pre/post.

- [ ] **Task 14: Unit tests for `validatePromo` query** (AC: 5)
  - [ ] **NEW** `tests/unit/convex/promos.test.ts`.
  - [ ] Seed `activePromos` with a mix of: active+valid, active+expired, inactive, exhausted (useCount === maxUses), not-yet-active.
  - [ ] Test each branch returns the right `ok: false, reason: ...` discriminant.
  - [ ] Test case-insensitive lookup: `"family10"`, `"FAMILY10"`, `" family10 "` all resolve to the same row.
  - [ ] Test unauthenticated → `UNAUTHENTICATED`; customer role → `FORBIDDEN`.

- [ ] **Task 15: Component tests for `DiscountPanel`** (AC: 1, AC: 2)
  - [ ] **NEW** `src/components/SaleForm/DiscountPanel.test.tsx` (co-located).
  - [ ] Tests:
    - Renders three radio options; defaults to Fixed amount.
    - Switching to Percentage re-labels the value input to `%`.
    - Switching to Promo code triggers `useQuery(validatePromo)` after 300ms blur debounce; the Apply button is disabled while loading.
    - Promo validation success auto-populates the underlying discount type + value; failure shows inline error.
    - Apply with `discountCents: 0` is forbidden — the Apply button stays disabled.
    - Apply with note < 5 chars shows inline error.
    - Cancel resets the panel state without calling `onApply`.
    - Esc key cancels (matches keyboard test in Story 3.3).

- [ ] **Task 16: Playwright spec extension** (AC: 1, AC: 3, AC: 4)
  - [ ] **UPDATE** `tests/e2e/journey-3-3-full-payment-sale.spec.ts` (Story 3.3's spec) to add a discount path: log in → `/sales/new` → pick lot + customer → open DiscountPanel → enter 10% percentage + note "Family loyalty" → Apply → assert price summary shows `Base / Discount / Total` rows → submit + commit → assert contract detail shows the discount line item on the receipt preview HTML mock + the contract row's `discountCents` is `200000`.
  - [ ] Also extend `tests/e2e/journey-3-4-installment-sale.spec.ts` (Story 3.4) to apply a discount and verify the schedule re-renders with the discounted total.

### Documentation

- [ ] **Task 17: ADR + runbook update** (AC: 4, AC: 5)
  - [ ] **NEW** `docs/adr/0011-discount-pricing-model.md`. Cover: why basis points for percentages (no `*100`/`/100` floats); why fixed-amount cap = base price (no negative prices); why 50% percentage cap (manager-override threshold — anything higher needs an admin-settings flow that doesn't exist yet); why promo_code increments `useCount` inside the same mutation as the contract write (atomicity); why the discount note is non-PII and not redacted in audit logs.
  - [ ] **UPDATE** `docs/runbook.md`. Add: "Diagnosing a discount-mismatch complaint" — query the contract's `discountAppliedBy` + `discountAppliedAt` + audit log entry; cross-reference with the `auditLog` row's `after` snapshot to see the discount note verbatim.

## Dev Notes

### Previous story intelligence

**Hard dependencies:**

- **Story 3.1 — `receiptCounter` + `allocateNextSerial`.** Consumed transitively via the cornerstone.
- **Story 3.2 — `postFinancialEvent` cornerstone.** This story EXTENDS the `sale_full` and `sale_installment` payload variants with discount fields. Re-read § Atomic mutation pattern + § Receipt-serial allocation in architecture.md to confirm the additions preserve the cornerstone's invariants. The `useCount` increment on `activePromos` is a non-financial write inside the same mutation — it's atomic by Convex's mutation-atomicity guarantee, but you should add an explicit ADR note (Task 17) that this is the only allowed exception to "non-financial mutations don't go through postFinancialEvent" because it's read-modify-write of a single counter.
- **Story 3.3 — `recordFullPaymentSale` + `SaleForm` + `FullPaymentTab`.** Extended in Tasks 8 + 10.
- **Story 3.4 — `recordInstallmentSale` + `InstallmentTab` + `SchedulePreview` + `generateInstallmentSchedule`.** Extended in Tasks 9 + 11. The schedule helper continues to compute on the **post-discount** `totalCents` — no changes to the helper signature; the caller just passes a smaller number.
- **Story 1.2 — `requireRole`, `ConvexError` codes, `errors.ts`.** Used by `validatePromo` query + `seedPromoCode` mutation.
- **Story 1.4 — design tokens (`bg-amber-50`, `text-amber-900`).** Reused for the DiscountChip badge.
- **Story 1.6 — `emitAudit`.** Cornerstone calls it; this story expands the `after` snapshot to include discount fields. Verify `redactPii` does NOT redact `discountNote`.
- **Epic 2 customers** — the CustomerPicker in the SaleForm is unchanged; this story doesn't touch customer flow.

**Soft dependencies:**

- **Story 3.6** (state machine) — runs in parallel with this story; both extend `convex/sales.ts` and `contracts` schema, so the developer should pull in 3.6's schema additions if they land first (the `contracts.state` field is already present from Story 3.2's stub).
- **Phase 2 admin promo-management UI** — not in this story's scope. Phase 1 ships with `seedPromoCode` as the only path to insert promo rows.

### Architecture compliance

- **Architecture § Atomic mutation pattern (cornerstone).** Task 4's `useCount` increment on `activePromos` is the one exception to "non-financial writes belong outside the cornerstone." It's atomic with the contract write because both happen inside the same Convex mutation. Document in ADR-0011.
- **Architecture § Format Patterns > Money.** Tasks 3, 6 enforce integer-math discounts. **No `* 100` / `/ 100` floats** anywhere in the discount pipeline. Percentage stored as basis points; conversion via the `pctToBp` helper (or `bpToDecimalString` for display).
- **Architecture § Enforcement Guidelines #1.** Both `recordFullPaymentSale` and `recordInstallmentSale` call `requireRole` first — unchanged from Stories 3.3 / 3.4.
- **Architecture § Architectural Boundaries > Financial-entity write boundary.** All discount-bearing contract writes happen inside `postFinancialEvent`; the calling mutations never touch the `contracts` table directly. The `no-direct-financial-table-writes` rule (Story 3.2) still catches violations.

### Library / framework versions

- **No new runtime deps.** shadcn/ui `RadioGroup`, `Textarea`, `Badge` should already be in the registry from Story 3.3 / Story 1.4 — copy them per the shadcn/ui CLI flow if not yet present.
- **`convex-test`** + **React Testing Library** — unchanged.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                  # UPDATE (extend contracts with discount fields; add activePromos table)
│   ├── lib/
│   │   ├── postFinancialEvent.ts                  # UPDATE (discount handling in prepareSaleFull + prepareSaleInstallment; promo useCount increment)
│   │   ├── discounts.ts                           # NEW (computeDiscountCents, assertDiscountValid, assertDiscountInvariant)
│   │   └── money.ts                               # UPDATE (add pctToBp + bpToDecimalString helpers)
│   ├── sales.ts                                   # UPDATE (recordFullPaymentSale + recordInstallmentSale gain discount args)
│   ├── promos.ts                                  # NEW (validatePromo query + seedPromoCode internalMutation)
│   └── admin.ts                                   # UPDATE OR NEW (seedPromoCode lives here if not in promos.ts; final layout: dev's choice)
├── src/
│   └── components/SaleForm/
│       ├── DiscountPanel.tsx                      # NEW
│       ├── DiscountPanel.test.tsx                 # NEW
│       ├── DiscountChip.tsx                       # NEW
│       ├── FullPaymentTab.tsx                     # UPDATE (price summary block + discount button)
│       └── InstallmentTab.tsx                     # UPDATE (schedule banner + discount button)
├── tests/
│   ├── unit/convex/
│   │   ├── lib/
│   │   │   └── discounts.test.ts                  # NEW
│   │   ├── promos.test.ts                         # NEW
│   │   └── lib/postFinancialEvent.test.ts         # UPDATE (discount path tests)
│   └── e2e/
│       ├── journey-3-3-full-payment-sale.spec.ts  # UPDATE (discount path)
│       └── journey-3-4-installment-sale.spec.ts   # UPDATE (discount path)
├── docs/
│   ├── adr/
│   │   └── 0011-discount-pricing-model.md         # NEW
│   └── runbook.md                                 # UPDATE (discount-mismatch diagnosis)
```

### Testing requirements

- **NFR-M2 (≥ 90% line coverage on financial code) applies to `convex/lib/discounts.ts`.** Target ≥ 95% to match the cornerstone's bar.
- **The cornerstone's ≥ 95% coverage gate stays in force.** Task 13's additions must not drop coverage on `postFinancialEvent.ts`. Run `npm run test:coverage` before submitting and verify per-file thresholds still pass.
- **Fail-on-broken-implementation:** delete the `assertDiscountValid` call in `prepareSaleFull` and verify the over-100% discount test fails. This proves the guard is real, not perfunctory.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT use floats for percentage discounts.** `0.10 * basePriceCents` is forbidden by the architecture's money-math rule. Basis points + `Math.floor` integer math is the ONLY sanctioned path.
- ❌ **Do NOT allow discounts > 50%** without an admin-settings escape hatch. The 50% cap is the manager-override threshold; higher discounts require a flow that doesn't exist yet. If the user asks for "just this one 75% discount," surface that the cap is structural — not a config knob.
- ❌ **Do NOT compute the discounted price in two places.** The cornerstone's `prepareSaleFull` / `prepareSaleInstallment` is the single source of truth for `totalCents = basePriceCents − discountCents`. The client-side preview re-derives it from the same formula but never sends `totalCents` to the server — the server always recomputes.
- ❌ **Do NOT bypass `assertDiscountValid`** with a "we already validated client-side" comment. Server-side validation is mandatory; the lint rule + the test suite enforce it.
- ❌ **Do NOT skip the `useCount` increment.** A promo with `maxUses: 10` that doesn't increment `useCount` would allow unlimited uses — silently. Increment is atomic with the contract write inside the cornerstone.
- ❌ **Do NOT decrement `useCount` on contract void.** Promo codes are consumed on sale; void of the sale does NOT release the promo code back to the pool. Story 3.7 (void contract) leaves `useCount` unchanged. This is an intentional business rule — promo codes are "burned" at point of sale to keep accounting simple. Document in ADR-0011.
- ❌ **Do NOT put the DiscountPanel in a modal.** UX § 1294 explicitly forbids modals for inline-able interactions. The panel is inline; the receipt preview is the only modal in the sale flow.
- ❌ **Do NOT auto-apply a promo from the URL** (e.g. `/sales/new?promo=FAMILY10`). Phase 1 has no URL-promo flow; Office Staff types or selects codes manually. URL-based codes need anti-abuse design that's out of scope.
- ❌ **Do NOT cache the `validatePromo` query result client-side.** `useQuery` is reactive; let Convex handle freshness. If a promo's `useCount` hits `maxUses` between the office staff's input and submit, the server-side check in the cornerstone catches it.
- ❌ **Do NOT pass `discountValue` or `discountType` from the client when a `promoCodeId` is set.** The cornerstone re-reads the promo row and computes `discountCents` server-side — client values are ignored when `promoCodeId` is present. This prevents tampering ("I'll just send `discountType: percentage, valueBp: 9999`"). Defensive design.
- ❌ **Do NOT allow negative discount values.** `assertDiscountValid` rejects them. A "+₱500" surcharge is NOT a negative discount — it's a different concept (price markup) and is not in this story's scope.
- ❌ **Do NOT redact `discountNote` in the audit log.** It's a business reason, not PII. Story 1.6's `redactPii` operates on a whitelist of PII keys (`name`, `phone`, `govId`, etc.); `discountNote` is NOT on that list. Verify in Task 13.

### Common LLM-developer mistakes to prevent

- **Conflating "percentage" and "basis points":** The form input is `%` (human-readable: `10` means 10%). The DB stores basis points (`1000` means 10%). Conversion via `pctToBp("10") → 1000` happens in the DiscountPanel before submission. Never store the human-readable percent.
- **Floor vs. round for percentage math:** `Math.floor(basePriceCents * valueBp / 10000)` — floors the discount, which means the customer pays the **higher** of the two possible rounded prices. This is the architecture's "round in the business's favor on discount" convention. The opposite (round the discount up) would cost the business cents on every transaction.
- **Wrong field redaction in audit:** if you accidentally add `discountNote` to the PII whitelist in `redactPii`, every discount note becomes `[REDACTED]` and the audit trail becomes useless. The Task 13 test catches this.
- **Promo code typo handling:** Office Staff often types codes with leading/trailing whitespace. The normalization (`code.trim().toUpperCase()`) is in BOTH the client-side `useQuery` call AND the server-side `validatePromo` handler — defense-in-depth. Don't skip either.
- **Form submission with an unapplied discount:** if the DiscountPanel is open with values filled but Apply was never clicked, the submission should NOT include those values. The chip is the source of truth — only applied discounts flow to the mutation. Add a test for "open panel + fill + submit without applying" → mutation receives `discountCents: 0`.
- **Splitting the discount fields across two mutations:** No. The discount is applied atomically with the sale. There is no "apply discount" mutation; the discount lives in the `recordFullPaymentSale` / `recordInstallmentSale` payload.
- **Forgetting installment-tab discount banner timing:** the banner shows `formatManilaDate(Date.now())` at the time the discount is applied (in client memory), not the time the contract is finally created. The contract's `discountAppliedAt` is set server-side at mutation time and may differ by seconds — that's the authoritative value. Banner is informational.

### Open questions / blockers this story does NOT resolve

- **None blocking.** §10 questions:
  - Q1 (installment policy) — affects Story 3.4's banner; not this story's banner. Discounts compose cleanly with whatever installment policy is finalized.
  - Q7 (perpetual care) — affects Story 3.8. Discount applies to base price only; perpetual care fees (one-time or annual) are added AFTER discount per the cornerstone's `totalCents = (basePriceCents − discountCents) + perpetualCareCents` formula (Story 3.8 finalizes the formula).
- **Phase 2 admin promo-management UI** is intentionally out of scope. Phase 1 admins seed via `seedPromoCode` from the Convex dashboard or CLI; the description on the promo row is the only metadata for now.

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure & Boundaries](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries) — `convex/promos.ts`, `convex/lib/discounts.ts`, `src/components/SaleForm/DiscountPanel.tsx` all match the naming + layout conventions.
- [Architecture § Atomic mutation pattern](../../_bmad-output/planning-artifacts/architecture.md#api--communication-patterns) — the `useCount` increment + contract write atomicity is documented in ADR-0011.
- [Architecture § Format Patterns > Money](../../_bmad-output/planning-artifacts/architecture.md#format-patterns) — basis points instead of floats; integer math throughout.

No conflicts detected.

### References

- [PRD § FR22 (discount + promo pricing)](../../_bmad-output/planning-artifacts/prd.md#functional-requirements)
- [Architecture § Atomic mutation pattern](../../_bmad-output/planning-artifacts/architecture.md#api--communication-patterns)
- [Architecture § Architectural Boundaries > Financial-entity write boundary](../../_bmad-output/planning-artifacts/architecture.md#architectural-boundaries)
- [Architecture § Format Patterns > Money](../../_bmad-output/planning-artifacts/architecture.md#format-patterns)
- [UX § Form Patterns > Inline panels](../../_bmad-output/planning-artifacts/ux-design-specification.md#form-patterns) — "Inline > modal" (line 1294)
- [UX § Defining Experience > Receipt preview modal](../../_bmad-output/planning-artifacts/ux-design-specification.md) (lines 707–731 — discount as line item)
- [Epics § Story 3.5](../../_bmad-output/planning-artifacts/epics.md#story-35-office-staff-applies-discounts-and-promo-pricing)
- Previous story dependencies: [Story 3.1](./3-1-receipt-counter-with-optimistic-concurrent-serial-allocation.md), [Story 3.2](./3-2-postfinancialevent-cornerstone.md), [Story 3.3](./3-3-office-staff-records-full-payment-sale.md), [Story 3.4](./3-4-office-staff-records-installment-sale-with-schedule.md), [Story 1.2](./1-2-server-enforces-role-based-access-on-every-endpoint.md), [Story 1.6 `emitAudit`](./1-6-audit-log-emit-and-redaction.md), [Story 1.7 stateMachines](./1-7-state-machines-and-illegal-transition-guards.md)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Claude Code)

### Debug Log References

- `npm run typecheck` — clean (no errors).
- `npm run lint` — `✔ No ESLint warnings or errors`.
- `npx vitest run` — 1566 passed, 1 skipped (88 test files; 0 failures).
- `npm run build` — Next.js build + SW build both succeed.

### Completion Notes List

Scope: this iteration ships the **discount-amount + rationale** half of
the story per the dev-agent system message's narrowed file ownership
(only `convex/schema.ts`, `convex/contracts.ts`,
`src/components/SaleForm/*`, and tests). The wider promo-code +
`activePromos` table + `convex/promos.ts` query + `convex/lib/discounts.ts`
helper + ADR-0011 surface in the original AC1-AC5 spec was OUT OF
SCOPE for this iteration (the cornerstone + `convex/lib/**` are
explicitly listed as forbidden file changes in the dev system
message). What landed:

- **Schema accretion (AC4):** `contracts` table gained three optional
  columns — `basePriceCents`, `discountCents`, `discountReason`. All
  three are optional so Story 3.3 / 3.4 contracts written before this
  story remain schema-valid; the cornerstone backfills `basePriceCents
  = totalPriceCents` + `discountCents: 0` on every new write.
- **Server invariants:** new file-local helper
  `normalizeDiscountInputs` in `convex/contracts.ts` enforces:
  `basePriceCents − discountCents === totalPriceCents`,
  `0 ≤ discountCents ≤ basePriceCents`, `discountReason` trim-length
  ≥ 5 chars when `discountCents > 0`, ≤ 280 chars hard cap, and a
  defensive "no reason without a discount" guard. Both
  `recordFullPaymentSale` AND `recordInstallmentSale` route through
  this helper BEFORE touching the lot / customer / cornerstone, so a
  rejected discount rolls back nothing.
- **Audit (AC4):** the contract `create` audit row carries all three
  discount fields verbatim in `after`. `discountReason` is treated as
  business-reason text (NOT PII) so `emitAudit`'s existing `redactPii`
  whitelist already leaves it intact — verified by tests in
  `contracts-discount.test.ts`.
- **UI (AC1, AC3):** inline discount panel landed in
  `SaleForm.tsx` AND `InstallmentTermsPanel.tsx`. Per UX § 1294
  ("Inline > modal"), the panel is a card between the LotPicker block
  and the Method block; entering a positive discount + reason reveals
  the three-row Base / Discount / Total summary with the discount in
  `text-rose-600`. The installment tab's `InstallmentSchedule` re-
  derives per-installment principals on the post-discount total, so
  the schedule preview reflects the discount reactively.
- **Zod (AC1, AC2):** `saleFormSchema` and `installmentSaleFormSchema`
  gained `discountInput` + `discountReason` optional fields plus a
  shared superRefine that mirrors the server's invariants (discount
  ≤ price; reason ≥ 5 chars when discount > 0). The submit button
  stays disabled until the invariants hold — surfaces the issue
  before the server has to reject.
- **Tests:** `tests/unit/convex/contracts-discount.test.ts` (10 tests,
  all green) covers happy path, default no-discount path, every
  invariant rejection, and trim-on-write. `tests/unit/components/
  SaleForm-discount.test.tsx` (7 tests, all green) covers panel
  render, summary appearance, mutation-args shape (with + without
  discount), and the two submit-disable paths.
- **Out-of-scope for this iteration (deferred to a Story 3.5b or a
  follow-up):**
  - `activePromos` config table + `convex/promos.ts:validatePromo`
    query + `seedPromoCode` internal mutation (requires writing to
    `convex/lib/**` and a new `convex/promos.ts` — outside file
    ownership).
  - `convex/lib/discounts.ts` helper + `bpToDecimalString` /
    `pctToBp` additions to `convex/lib/money.ts` (forbidden by the
    dev system message).
  - ADR-0011 (`docs/adr/0011-discount-pricing-model.md`) + runbook
    update (no documentation files unless explicitly requested per
    the system message).
  - Percentage-discount + promo-code UI variants (the panel ships
    with fixed-amount only; percentage / promo additions can layer
    onto the same `discountCents` server payload without a schema
    change).
  - Playwright spec extensions (`tests/e2e/journey-3-3-*.spec.ts` +
    `journey-3-4-*.spec.ts`) — Playwright e2e is a separate gate not
    listed in the four-gate criteria for this iteration.

  These are clean follow-ups: the schema + server validation surface
  is forward-compatible (the optional fields stay optional; a future
  story can add `discountType` + `promoCodeId` alongside them).

### File List

- **Modified:** `convex/schema.ts` — added `basePriceCents`,
  `discountCents`, `discountReason` (all optional) to the `contracts`
  table.
- **Modified:** `convex/contracts.ts` — added
  `normalizeDiscountInputs` helper; extended
  `RecordFullPaymentSaleArgs` + `RecordInstallmentSaleArgs` interfaces
  + validators with the three discount fields; persist the discount
  triple on the contract row and the `create` audit row; surface the
  fields on `ContractDetailResult` via `getContract`.
- **Modified:** `src/components/SaleForm/saleFormSchema.ts` — added
  `discountInput` + `discountReason` optional fields to both Zod
  schemas; cross-field superRefine enforces discount bounds + reason
  length.
- **Modified:** `src/components/SaleForm/SaleForm.tsx` — inline
  discount panel + three-row price summary + post-discount
  `totalPriceCents` derivation + mutation-args wiring.
- **Modified:** `src/components/SaleForm/InstallmentTermsPanel.tsx` —
  same inline discount panel surface; schedule preview re-derives
  per-installment principals on the post-discount total.
- **Created:** `tests/unit/convex/contracts-discount.test.ts` —
  10 tests covering server-side discount invariants + audit stamping.
- **Created:** `tests/unit/components/SaleForm-discount.test.tsx` —
  7 tests covering UI panel, summary, mutation args, and submit-
  disable paths.
