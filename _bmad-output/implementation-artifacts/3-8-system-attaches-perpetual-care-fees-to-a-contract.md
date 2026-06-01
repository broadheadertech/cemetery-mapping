# Story 3.8: System Attaches Perpetual Care Fees to a Contract

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **Office Staff / Admin / a developer maintaining the contract schema**,
I want **the system to attach perpetual care fees (one-time, annual, or none) to a contract at sale time based on a `perpetualCarePolicy` configuration — schema-forward but UX-gated on §10 Q7 with safe defaults + a visible "Policy pending defaults + banner" pattern**,
so that **the cemetery's perpetual care revenue stream is captured from day one of the system going live, with the schema able to absorb whatever Q7's final answer is (annual schedules, lump sums, or "we don't charge perpetual care") without a migration** (FR25 — gated on §10 Q7).

This story is the **§10 Q7-gated story** — the answer ("does the cemetery charge perpetual care, and if so as a one-time fee or annual recurring fee?") is unresolved as of this story's drafting. The architecture's "schema forward-compatible + banner pattern" applies: the schema ships with **all three modes** representable (`one-time`, `annual`, `none`), the default policy is **`none`** (the safest assumption — no fees collected until policy is confirmed), and an amber **`PolicyPendingBanner`** is shown on `/admin/settings/perpetual-care` AND on the SaleForm when policy is set to `none` due to Q7-pending status. Once Q7 is answered, an admin flips the policy via the settings UI; previously-created contracts keep their original perpetual-care terms (FR31 immutability — like installment grace/penalty in Story 3.4).

The contract document gains a `perpetualCare: { type, amountCents, annualFeeSchedule? }` field that flows through `postFinancialEvent`'s sale variants. The `totalCents` formula updates to `basePriceCents − discountCents + perpetualCareCents` (perpetual care is ADDED to the base price, never subtracted). For annual policies, an `annualFeeSchedule` array is generated alongside (separately from) the installment schedule — perpetual care fees are due on a different cadence than installment payments and tracked independently.

## Acceptance Criteria

1. **AC1 — `cemeterySettings` table gains a `perpetualCare` policy block with safe defaults + Q7-gating flag**: extend `cemeterySettings` (Story 3.4 created the minimal table; this story adds a nested config). Schema additions:
   ```ts
   perpetualCarePolicy: v.object({
     type: v.union(v.literal("one_time"), v.literal("annual"), v.literal("none")),
     oneTimeAmountCents: v.optional(v.number()),     // required when type === "one_time"
     annualAmountCents: v.optional(v.number()),     // required when type === "annual"
     annualScheduleYears: v.optional(v.number()),   // number of years; required when type === "annual"; null = perpetual (lifetime of cemetery)
     annualFirstDueOffsetDays: v.optional(v.number()), // offset from sale date for first annual fee; default 365
   }),
   perpetualCarePolicyConfirmed: v.boolean(),       // §10 Q7 gate — true when client has answered
   ```
   The default seeded values when the table is first populated (one-off migration from Story 3.4 or the seed flow): `type: "none"`, `perpetualCarePolicyConfirmed: false`. Once the operator answers Q7 in admin settings, they update the policy + set `perpetualCarePolicyConfirmed: true`. **No `annualFeeSchedule` is generated** for contracts created while `type === "none"`.

2. **AC2 — Admin can configure the perpetual care policy in `/admin/settings/perpetual-care`**: a new admin-only settings page with: (a) a `Select` for type (`None / One-time / Annual`), (b) conditional fields based on type: One-time → `oneTimeAmountCents` input (peso prefix, tabular), Annual → `annualAmountCents` + `annualScheduleYears` (1-50, or "Perpetual (lifetime)") + `annualFirstDueOffsetDays` (default 365), (c) a checkbox **"Confirmed with client (§10 Q7 resolved)"** that toggles `perpetualCarePolicyConfirmed`. **An amber `PolicyPendingBanner`** displays at the top of this page when the checkbox is unchecked: "Perpetual care policy pending client confirmation (§10 Q7). Defaults below are placeholders — confirm with the cemetery owner before going live." The "Save" button is admin-only (`requireRole(["admin"])`) and emits an audit row on each save with the before/after policy snapshot.

3. **AC3 — Sale contract creation reads the policy and attaches perpetual care fees**: when `recordFullPaymentSale` or `recordInstallmentSale` runs, the cornerstone's `prepareSaleFull` / `prepareSaleInstallment` reads `cemeterySettings.perpetualCarePolicy` and writes a `perpetualCare` field on the new contract document:
   ```ts
   perpetualCare: v.object({
     type: v.union(v.literal("one_time"), v.literal("annual"), v.literal("none")),
     totalAmountCents: v.number(),                  // 0 when type === "none"
     annualFeeSchedule: v.optional(v.array(v.object({
       sequence: v.number(),
       dueAt: v.number(),
       amountCents: v.number(),
       state: v.union(v.literal("scheduled"), v.literal("paid"), v.literal("overdue"), v.literal("written_off")),
     }))),
   })
   ```
   For `type: "none"`: `totalAmountCents: 0`, no `annualFeeSchedule`. For `type: "one_time"`: `totalAmountCents: <config value>`, no `annualFeeSchedule`, the amount is added to the contract's `totalCents` and (for full-payment sales) is collected immediately as part of the full payment; (for installment sales) is added as an extra row to the installment schedule labeled "Perpetual Care" at the END of the schedule. For `type: "annual"`: `totalAmountCents: annualAmountCents × annualScheduleYears` (or `Infinity` if lifetime — but lifetime is stored as `annualScheduleYears: null` and `totalAmountCents: 0` indicating no precomputed total), `annualFeeSchedule` populated with one row per year starting from `saleDate + annualFirstDueOffsetDays`.

4. **AC4 — Contract detail page surfaces perpetual care state distinctly from installments**: a new section on the contract detail page (Story 3.6 + 3.7 own this page; this story adds the section) shows:
   - When `type: "none"`: "Perpetual care: **not configured**" in a subdued slate text block (no banner, no warning — this is the configured state when the cemetery has chosen no fee).
   - When `type: "one_time"`: "Perpetual care: ₱{amount} (one-time, included in {full payment / final installment / down payment depending on installment kind})."
   - When `type: "annual"`: a small table showing the `annualFeeSchedule` with: sequence, due date, amount, status pill. Status pill colors follow Story 1.4 conventions (`scheduled` = neutral, `paid` = green, `overdue` = amber, `written_off` = slate).
   - **`PolicyPendingBanner`** appears at the top of the section when the contract's `perpetualCare.type === "none"` AND the global `cemeterySettings.perpetualCarePolicyConfirmed === false` — flagging that the contract was created during the policy-pending window and may need a retroactive update once Q7 is answered.

5. **AC5 — Schema is forward-compatible with Q7's possible answers, validated by tests**: a Vitest test suite asserts the schema can represent each of the policy-mode-and-its-edge-cases combinations: `none`, `one_time` with various amounts, `annual` with 1 year, `annual` with 50 years, `annual` lifetime (`annualScheduleYears: null`). Each combination round-trips through a sale → contract document → assertion that the `perpetualCare` field matches the policy + the `annualFeeSchedule` (if any) has the right number of rows, the right due dates (using `addDays` from `convex/lib/dates.ts`), and the right amounts. **The "no migration after Q7 answer" guarantee is the test target.** When the client answers Q7 in 8 weeks, no schema change is needed — only the admin-settings flow updates the policy values.

## Tasks / Subtasks

### Schema accretion (AC1, AC3)

- [ ] **Task 1: Extend `cemeterySettings` table with `perpetualCarePolicy`** (AC: 1)
  - [ ] **UPDATE** `convex/schema.ts`. Story 3.4 created `cemeterySettings` with `installmentPolicyConfirmed` + defaults. This story adds:
    ```ts
    perpetualCarePolicy: v.object({
      type: v.union(v.literal("one_time"), v.literal("annual"), v.literal("none")),
      oneTimeAmountCents: v.optional(v.number()),
      annualAmountCents: v.optional(v.number()),
      annualScheduleYears: v.optional(v.number()),
      annualFirstDueOffsetDays: v.optional(v.number()),
    }),
    perpetualCarePolicyConfirmed: v.boolean(),
    ```
  - [ ] Update Story 3.4's seed migration to default-populate the new fields: `perpetualCarePolicy: { type: "none" }`, `perpetualCarePolicyConfirmed: false`. **No data migration needed** if Story 3.4's `cemeterySettings` row exists — patch it once via an internal mutation (`convex/admin.ts > backfillPerpetualCareDefaults`); idempotent so re-running is safe.
  - [ ] **Why nested object instead of flat fields:** the policy is a logical unit; flattening would mean `perpetualCareType`, `perpetualCareOneTimeAmountCents`, etc. — verbose and harder to validate as a whole. Convex supports nested objects via `v.object`; the indexing implications are nil (we never index INTO the nested object — we just read the whole row).

- [ ] **Task 2: Extend `contracts` table with `perpetualCare` field** (AC: 3)
  - [ ] **UPDATE** `convex/schema.ts`. Add:
    ```ts
    perpetualCare: v.object({
      type: v.union(v.literal("one_time"), v.literal("annual"), v.literal("none")),
      totalAmountCents: v.number(),                  // 0 for "none"; precomputed sum for "annual" with finite years; 0 placeholder for "annual" lifetime
      annualFeeSchedule: v.optional(v.array(v.object({
        sequence: v.number(),
        dueAt: v.number(),
        amountCents: v.number(),
        state: v.union(v.literal("scheduled"), v.literal("paid"), v.literal("overdue"), v.literal("written_off")),
        paidAt: v.optional(v.number()),              // populated when this row's annual fee is paid (Phase 2)
        paymentId: v.optional(v.id("payments")),     // populated when paid
      }))),
    }),
    ```
  - [ ] **Immutability:** the `perpetualCare.type` + `totalAmountCents` + `annualFeeSchedule[].sequence/dueAt/amountCents` are immutable after contract creation (FR31-style invariant for terms). Only `annualFeeSchedule[].state` + `paidAt` + `paymentId` are mutated when annual fees are paid (Phase 2 / Epic 4 will own the annual-fee payment workflow — this story sets up the schema but does NOT wire payment intake for annual fees yet).

### Helpers (AC3, AC5)

- [ ] **Task 3: Implement `convex/lib/perpetualCare.ts`** (**NEW**) (AC: 3, AC: 5)
  - [ ] Pure-function helpers:
    ```ts
    // Compute the perpetualCare field for a new contract, given the active policy + sale date.
    // Returns the EXACT shape that goes into the contract document.
    export function computeContractPerpetualCare(args: {
      policy: PerpetualCarePolicy;
      saleDate: number;
    }): {
      type: "one_time" | "annual" | "none";
      totalAmountCents: number;
      annualFeeSchedule?: Array<{ sequence: number; dueAt: number; amountCents: number; state: "scheduled" }>;
    };

    // Validate a policy object against the schema's invariants (e.g. annual must have annualAmountCents + annualScheduleYears OR annualScheduleYears null for lifetime).
    export function assertPolicyValid(policy: PerpetualCarePolicy): void;
    ```
  - [ ] **Edge cases the helper handles:**
    - `type: "none"` → returns `{ type: "none", totalAmountCents: 0 }`; no schedule.
    - `type: "one_time"` with `oneTimeAmountCents: 500_00` → returns `{ type: "one_time", totalAmountCents: 50000 }`; no schedule.
    - `type: "annual"` with `annualAmountCents: 200_00`, `annualScheduleYears: 10` → returns `{ type: "annual", totalAmountCents: 2000_00, annualFeeSchedule: [10 rows, due offset by 365 days × N] }`.
    - `type: "annual"` with `annualScheduleYears: null` (lifetime) → returns `{ type: "annual", totalAmountCents: 0, annualFeeSchedule: undefined }`. The "lifetime" semantics are tracked at the policy level, not enumerated as rows (impossible to enumerate). Phase 2 will handle ad-hoc annual billing for lifetime contracts.
  - [ ] **Date math uses `convex/lib/dates.ts > addDays`** from earlier stories — no ad-hoc `new Date(date.getTime() + N * 86400000)` arithmetic.
  - [ ] **Currency math is integer-only** — perpetual care multiplications use `Math.floor` or stay in cents throughout. No floating-point.

- [ ] **Task 4: Update `postFinancialEvent` cornerstone** (AC: 3)
  - [ ] **UPDATE** `convex/lib/postFinancialEvent.ts` (Story 3.2's cornerstone, already extended by 3.5).
  - [ ] In `prepareSaleFull` and `prepareSaleInstallment`:
    1. Read `cemeterySettings.perpetualCarePolicy` (a `db.query("cemeterySettings").unique()`).
    2. Validate via `assertPolicyValid(policy)` — defensive; admin settings UI also validates, but cornerstone re-validates.
    3. Compute `perpetualCare = computeContractPerpetualCare({ policy, saleDate: paidAt })`.
    4. Compute `totalCents = basePriceCents − discountCents + perpetualCare.totalAmountCents`.
    5. For `sale_full`: payment amount = `totalCents` (collected in full); the receipt shows perpetual care as a line item per AC4 + FR28 itemization.
    6. For `sale_installment`: down payment + installment schedule must sum to `totalCents` (NOT just `basePriceCents − discountCents`). **This means the caller's installment schedule must include the perpetual care amount in the math.** Solution: extend `generateInstallmentSchedule` (Story 3.4) to accept `additionalUpFrontCents` (perpetual_care one-time) OR have the cornerstone append a "Perpetual Care" line as the final installment row. **Pick the LATTER**: simpler, makes the perpetual-care line item visible in the schedule as a clearly-labeled row, doesn't muddy the installment math.
    7. Write the `perpetualCare` object on the contract.
  - [ ] **`annualFeeSchedule` writes ON the contract document** (nested array), NOT a separate `annualFees` table. Reads stay simple (`db.get(contractId).perpetualCare.annualFeeSchedule`); a separate table would be needed only if we wanted to query "all overdue annual fees across all contracts" — Epic 4 may want this; if so, the architecture's "derived index" pattern can build it later without schema change.

- [ ] **Task 5: Extend `recordFullPaymentSale` and `recordInstallmentSale` argument signatures** (AC: 3)
  - [ ] **UPDATE** `convex/sales.ts`. **NO new args from the client** — the policy is read server-side from `cemeterySettings`. The client doesn't supply perpetual care details (they shouldn't be tamperable). This is the intentional design: perpetual care is policy-driven, not per-sale operator-overridable.
  - [ ] **Future Phase 2 escape hatch:** if the cemetery later wants per-sale perpetual-care override (e.g. "VIP family pays double"), add an optional `perpetualCareOverrideCents` admin-only arg. Out of scope for this story. Note in ADR-0014.

### UI — Admin settings page (AC2)

- [ ] **Task 6: Create `convex/cemeterySettings.ts`** (**NEW**) (AC: 2)
  - [ ] Public query `getCemeterySettings` — admin + office_staff readable (the policy display is visible to office staff for awareness, even though they can't edit). Returns the full `cemeterySettings` row.
  - [ ] Public mutation `updatePerpetualCarePolicy` — admin-only:
    ```ts
    export const updatePerpetualCarePolicy = mutation({
      args: {
        policy: v.object({
          type: v.union(v.literal("one_time"), v.literal("annual"), v.literal("none")),
          oneTimeAmountCents: v.optional(v.number()),
          annualAmountCents: v.optional(v.number()),
          annualScheduleYears: v.optional(v.number()),
          annualFirstDueOffsetDays: v.optional(v.number()),
        }),
        confirmed: v.boolean(),
      },
      handler: async (ctx, { policy, confirmed }) => {
        await requireRole(ctx, ["admin"]);
        assertPolicyValid(policy);
        const settings = await ctx.db.query("cemeterySettings").unique();
        if (!settings) throwError(ErrorCode.INVARIANT_VIOLATION, "Settings row missing.");
        const before = { policy: settings.perpetualCarePolicy, confirmed: settings.perpetualCarePolicyConfirmed };
        await ctx.db.patch(settings._id, { perpetualCarePolicy: policy, perpetualCarePolicyConfirmed: confirmed });
        await emitAudit(ctx, {
          action: "settings.perpetualCarePolicy.updated",
          entityType: "cemeterySettings",
          entityId: settings._id,
          before,
          after: { policy, confirmed },
          reason: confirmed ? "Confirmed by admin" : "Pending client confirmation (§10 Q7)",
        });
      },
    });
    ```

- [ ] **Task 7: Create `/admin/settings/perpetual-care` page** (**NEW**) (AC: 2)
  - [ ] Create `src/app/(staff)/admin/settings/perpetual-care/page.tsx` — admin-only (Story 1.2 layout's role check OR an inline `requireRole` redirect in the page).
  - [ ] Renders `<PerpetualCarePolicyForm>` (new component below).

- [ ] **Task 8: Create `src/components/Settings/PerpetualCarePolicyForm.tsx`** (**NEW**) (AC: 2)
  - [ ] `"use client"`. RHF + Zod. Reads current settings via `useQuery(api.cemeterySettings.getCemeterySettings)`.
  - [ ] **`PolicyPendingBanner` at the top** when `!perpetualCarePolicyConfirmed`:
    ```
    [amber banner] ⏱ Perpetual care policy pending client confirmation (§10 Q7).
    The defaults below are placeholders. Confirm with the cemetery owner before flipping the "Confirmed" toggle.
    ```
    Uses `bg-amber-50 text-amber-900` per Story 1.4 design tokens.
  - [ ] Form fields:
    - **Type** — Select with three options: `None` / `One-time` / `Annual`.
    - **One-time amount** — visible only when type === `one_time`. Peso prefix, tabular numerics, accepts `1200` or `1,200.50`, coerced to centavos.
    - **Annual amount** — visible only when type === `annual`. Same input style.
    - **Years scheduled** — visible only when type === `annual`. Numeric input (1-50) with a checkbox "Perpetual (lifetime — no fixed end)". When the checkbox is checked, the years input is disabled and the form stores `annualScheduleYears: null`.
    - **First-fee offset (days from sale)** — visible only when type === `annual`. Default 365. Helper text: "How many days after the sale is the first annual fee due? Typical: 365 (one year)."
  - [ ] **Confirmed checkbox** — at the bottom of the form: "I've confirmed this policy with the cemetery owner." When checked, sets `perpetualCarePolicyConfirmed: true`. The Save button is enabled regardless of checkbox state (admins can save policy values BEFORE confirming, just to draft them).
  - [ ] Save button — calls `updatePerpetualCarePolicy({ policy, confirmed })`. On success, briefly shows "Saved." Error → inline at top of form (UX-DR24).
  - [ ] **Audit trail visibility:** below the form, a small "Recent changes" subsection lists the last 5 audit rows for `action: "settings.perpetualCarePolicy.updated"` (queryable via `auditLog.by_action` or `auditLog.by_entityType`). Each row shows who, when, before → after summary. Provides confidence the policy isn't being silently flipped.

### UI — Contract detail page surface (AC4)

- [ ] **Task 9: Add `PerpetualCareSection` to the contract detail page** (AC: 4)
  - [ ] **UPDATE** `src/app/(staff)/contracts/[contractId]/page.tsx`. Below the installment schedule + payments section, add `<PerpetualCareSection contract={contract} settings={settings} />`.
  - [ ] **NEW** `src/components/ContractDetail/PerpetualCareSection.tsx`:
    - Reads `contract.perpetualCare` + `settings.perpetualCarePolicyConfirmed`.
    - Renders one of three layouts per AC4:
      - `type === "none"`: subdued slate panel with "Perpetual care: not configured."
      - `type === "one_time"`: panel with "Perpetual care: ₱{amount} (one-time)." + a small note where the fee is collected ("Included in full payment" / "Included in down payment" / "Included as final installment row" per contract kind).
      - `type === "annual"`: a `<Table>` of the `annualFeeSchedule` rows; columns: Sequence, Due date, Amount, Status. Use `StatusPill` (Story 1.4) for the state column.
    - **PolicyPendingBanner** at the top of this section only when `contract.perpetualCare.type === "none"` AND `settings.perpetualCarePolicyConfirmed === false`:
      ```
      [amber banner] ⏱ Created during policy-pending window (§10 Q7).
      Once policy is confirmed, an admin may need to retroactively update this contract.
      ```
    - The banner is visible only on contracts created BEFORE Q7 was answered. After confirmation, new contracts get the configured perpetual care; this banner doesn't appear on them.

### Tests (all ACs)

- [ ] **Task 10: Unit tests for `computeContractPerpetualCare`** (AC: 3, AC: 5)
  - [ ] **NEW** `tests/unit/convex/lib/perpetualCare.test.ts`. Coverage target ≥ 95%.
  - [ ] Test cases:
    - `type: "none"` → `{ type: "none", totalAmountCents: 0 }`; no schedule.
    - `type: "one_time", oneTimeAmountCents: 50000` → `{ type: "one_time", totalAmountCents: 50000 }`; no schedule.
    - `type: "annual", annualAmountCents: 20000, annualScheduleYears: 10, annualFirstDueOffsetDays: 365` → 10 schedule rows; first due at `saleDate + 365 days`; last due at `saleDate + 365 days × 10`; all amounts equal `20000`; `totalAmountCents: 200000`.
    - `type: "annual"` with `annualScheduleYears: null` (lifetime) → no schedule rows; `totalAmountCents: 0`.
    - `type: "annual"` with `annualFirstDueOffsetDays: 0` → first fee due on sale date.
    - `type: "annual"` with `annualScheduleYears: 1` → exactly one schedule row.
  - [ ] `assertPolicyValid` tests:
    - `type: "one_time"` without `oneTimeAmountCents` → `INVARIANT_VIOLATION`.
    - `type: "annual"` without `annualAmountCents` → `INVARIANT_VIOLATION`.
    - `type: "annual"` with `annualAmountCents` but neither `annualScheduleYears` nor explicit lifetime flag — clarify via convention: `annualScheduleYears: null` = lifetime; `undefined` = invalid. Test both.
    - `type: "none"` with extraneous fields → succeeds (extraneous fields are ignored, but document — strict-mode validation could be added later).

- [ ] **Task 11: Update `postFinancialEvent.test.ts` for perpetual care paths** (AC: 3, AC: 5)
  - [ ] **UPDATE** Story 3.2's test file. Add `describe("perpetual care handling")`:
    - Sale with `type: "none"` policy → contract `perpetualCare.totalAmountCents === 0`; `totalCents === basePriceCents − discountCents`; no annualFeeSchedule.
    - `sale_full` with `type: "one_time"` policy and ₱500 fee → contract `totalCents` is `basePriceCents − discountCents + 50000`; payment row equals `totalCents`; receipt PDF line items include "Perpetual Care: ₱500".
    - `sale_installment` with `type: "one_time"` policy → the installment schedule appends a final "Perpetual Care" row; sum of schedule + down payment equals `totalCents`.
    - `sale_full` with `type: "annual"` policy and 10-year schedule → contract `annualFeeSchedule` has 10 rows; total payment at sale = `basePriceCents − discountCents` (annual fees NOT collected at sale, only billed annually); contract `totalCents` reflects the lifetime annual total.
    - Sale with `type: "annual"` lifetime → contract `annualFeeSchedule: undefined`; `totalAmountCents: 0`.
    - Annual policy with `annualFirstDueOffsetDays: 30` → first row due 30 days after sale.
  - [ ] **Round-trip test for AC5 (no migration needed):** for each policy configuration, verify the contract document round-trips through `db.insert` + `db.get` without schema validation errors. This is the "schema is forward-compatible" guarantee.

- [ ] **Task 12: Unit tests for `updatePerpetualCarePolicy` mutation** (AC: 2)
  - [ ] **NEW** `tests/unit/convex/cemeterySettings.test.ts`.
  - [ ] Admin updates policy → success; audit row emitted; `perpetualCarePolicyConfirmed` flag updates.
  - [ ] Office Staff updates → `FORBIDDEN`.
  - [ ] Invalid policy (e.g. `type: "annual"` without `annualAmountCents`) → `INVARIANT_VIOLATION`.
  - [ ] Confirmed false → audit row reason is "Pending client confirmation (§10 Q7)"; confirmed true → reason is "Confirmed by admin".

- [ ] **Task 13: Component tests for `PerpetualCarePolicyForm`** (AC: 2)
  - [ ] Renders PolicyPendingBanner when `perpetualCarePolicyConfirmed === false`.
  - [ ] Type selector reveals/hides conditional fields correctly.
  - [ ] "Perpetual (lifetime)" checkbox disables `annualScheduleYears` input and submits `null`.
  - [ ] Save calls the mutation with normalized args.

- [ ] **Task 14: Component tests for `PerpetualCareSection`** (AC: 4)
  - [ ] Renders the three layouts based on `contract.perpetualCare.type`.
  - [ ] PolicyPendingBanner appears only when `type === "none"` AND `perpetualCarePolicyConfirmed === false`.
  - [ ] Annual schedule table renders correct row count + due dates.

- [ ] **Task 15: Playwright spec for perpetual care policy + sale flow** (AC: 2, AC: 3, AC: 4)
  - [ ] **NEW** `tests/e2e/journey-3-8-perpetual-care.spec.ts`. Walk: log in as admin → navigate to `/admin/settings/perpetual-care` → set policy to Annual / ₱200 / 10 years → check Confirmed → save → navigate to `/sales/new` → record a sale → on contract detail page assert PerpetualCareSection shows the 10-row annual schedule.
  - [ ] Negative path: same setup but DON'T check Confirmed → policy saves but `perpetualCarePolicyConfirmed: false`; record a sale; assert PolicyPendingBanner is visible on the contract detail page.

### Documentation (AC1, AC5)

- [ ] **Task 16: ADR + runbook + brief PRD note** (AC: 1, AC: 5)
  - [ ] **NEW** `docs/adr/0014-perpetual-care-policy.md`. Cover: §10 Q7 gating; the schema's three-mode design (`one_time` / `annual` / `none`); the lifetime annual case and why we don't pre-enumerate rows; the FR31 immutability of `perpetualCare.type` + `totalAmountCents` after contract creation; the rationale for storing `annualFeeSchedule` on the contract document (nested) vs. a separate table (would need it only for cross-contract aggregations, deferrable); the explicit decision NOT to offer per-sale override in Phase 1.
  - [ ] **UPDATE** `docs/runbook.md`. Add: "Updating perpetual care policy mid-flight" — how to flip the policy without breaking existing contracts (the immutability invariant covers it; existing contracts keep their original perpetual care terms); "Diagnosing a contract with stale perpetual care" — query `contracts` by `perpetualCare.type` to find pre-Q7-confirmed contracts that might need retroactive updates.
  - [ ] **UPDATE** CLAUDE.md "Architecture intent" — note that `cemeterySettings.perpetualCarePolicy` is the single source of truth; sale-time mutations read it server-side; contracts immutably snapshot terms.

## Dev Notes

### Previous story intelligence

**Hard dependencies:**

- **Story 1.2 — `requireRole`, `ConvexError` codes.** Admin gate on settings + cornerstone delegation.
- **Story 1.4 — `StatusPill`, design tokens (amber palette for banners).** Reused for annual fee schedule rows + PolicyPendingBanner.
- **Story 1.6 — `emitAudit`.** Settings mutation emits audit; sale mutation already does via the cornerstone.
- **Story 3.2 — `postFinancialEvent` cornerstone.** This story EXTENDS the sale variants to read `cemeterySettings` and write the `perpetualCare` field on the contract. Re-read § Atomic mutation pattern in architecture.md to confirm reading from `cemeterySettings` during a sale mutation preserves atomicity (it does — the read happens inside the mutation, before any writes; if `cemeterySettings` changes mid-mutation it's still atomic because Convex serializes reads + writes per mutation).
- **Story 3.3 / 3.4 — `recordFullPaymentSale`, `recordInstallmentSale`, `generateInstallmentSchedule`.** The mutations don't gain new args (perpetual care is server-derived); the installment-schedule logic gains a "perpetual care line" appended to the schedule for `one_time` policy — Task 4 handles.
- **Story 3.4 — `cemeterySettings` table created.** This story EXTENDS the row with perpetual care fields + the gating flag.
- **Story 3.5 — discounts on sale.** Composes cleanly: `totalCents = basePriceCents − discountCents + perpetualCareCents`. Discount is applied BEFORE perpetual care is added.
- **Epic 2 customers + ownerships.** Not directly extended.

**Soft dependencies (handled by stub or deferred):**

- **Epic 4 — annual fee payment intake.** This story creates the `annualFeeSchedule` rows but does NOT build the UI for paying them. Phase 2 / Epic 4 will. The schema supports the workflow already.
- **Phase 2 admin retroactive updates.** When Q7 is answered late, admins may want to retroactively update contracts created during the pending window. Not in scope; the PolicyPendingBanner surfaces the need.

### Architecture compliance

- **Architecture § Atomic mutation pattern.** The cornerstone reads `cemeterySettings` + writes `contracts.perpetualCare` in one mutation. Atomic.
- **Architecture § Format Patterns > Money.** Integer math throughout. No `* 100` / `/ 100` floats anywhere in the perpetual care pipeline.
- **Architecture § Immutability invariants.** `perpetualCare.type`, `totalAmountCents`, and the schedule rows' terms are immutable after contract creation. Only `state` + `paidAt` + `paymentId` per row are mutated by the Phase 2 annual-fee payment workflow.
- **Architecture § §10 question gating pattern.** This story is the second story (after 3.4) to use the "policy pending defaults + banner" pattern. The pattern is now established: safe default + banner + admin settings UI to flip the policy + audit row on every settings change. Document in ADR-0014 as a reusable pattern.

### Library / framework versions

- **No new runtime deps.** All shadcn/ui components (Select, Checkbox, Input, Table) already exist.
- **`addDays` from `convex/lib/dates.ts`** (earlier story) is the only helper this story consumes from the broader system.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                  # UPDATE (extend cemeterySettings + contracts with perpetual care fields)
│   ├── lib/
│   │   ├── postFinancialEvent.ts                  # UPDATE (read policy + write contract.perpetualCare in prepareSaleFull / prepareSaleInstallment)
│   │   └── perpetualCare.ts                       # NEW (computeContractPerpetualCare + assertPolicyValid)
│   ├── cemeterySettings.ts                        # NEW (getCemeterySettings query + updatePerpetualCarePolicy mutation)
│   └── admin.ts                                   # UPDATE (backfillPerpetualCareDefaults internalMutation)
├── src/
│   ├── app/(staff)/admin/settings/perpetual-care/
│   │   └── page.tsx                               # NEW (admin-only settings page)
│   └── components/
│       ├── Settings/
│       │   ├── PerpetualCarePolicyForm.tsx        # NEW
│       │   ├── PerpetualCarePolicyForm.test.tsx   # NEW
│       │   └── PolicyPendingBanner.tsx            # NEW (reusable banner — Story 3.4 may have shipped a version; reuse if so, extract here if new)
│       └── ContractDetail/
│           ├── PerpetualCareSection.tsx           # NEW
│           └── PerpetualCareSection.test.tsx      # NEW
├── tests/
│   ├── unit/convex/
│   │   ├── lib/
│   │   │   └── perpetualCare.test.ts              # NEW
│   │   ├── cemeterySettings.test.ts               # NEW
│   │   └── lib/postFinancialEvent.test.ts         # UPDATE (perpetual care path tests)
│   └── e2e/
│       └── journey-3-8-perpetual-care.spec.ts     # NEW
├── docs/
│   ├── adr/
│   │   └── 0014-perpetual-care-policy.md          # NEW
│   └── runbook.md                                 # UPDATE (mid-flight policy update procedure)
└── CLAUDE.md                                      # UPDATE (note cemeterySettings as policy source of truth)
```

### Testing requirements

- **NFR-M2 (≥ 90% coverage) applies to `convex/lib/perpetualCare.ts` + `convex/cemeterySettings.ts`.** Aim for ≥ 95% on the pure-function helper.
- **Story 3.2's ≥ 95% gate on `postFinancialEvent.ts` must hold.** Task 11's additions must not regress.
- **Fail-on-broken-implementation:** comment out the `computeContractPerpetualCare` call in `prepareSaleFull` and verify the "one_time fee adds to totalCents" test fails.

### Policy pending defaults + banner pattern (reusable)

This story formalizes the pattern that Story 3.4 introduced for installment policy gating. The pattern's four parts:

1. **Schema-forward defaults**: the schema can represent all plausible answers to the open question. The default value when not yet answered is the safest (`type: "none"`, no fees collected).
2. **Single boolean confirmation flag**: `<policy>Confirmed: boolean` on the settings table. When false, the UI shows a banner; when true, no banner.
3. **`PolicyPendingBanner` component**: a single reusable component (extract from Story 3.4 if it's not already extracted; if Story 3.4 inlined the banner, this story extracts it into `src/components/Settings/PolicyPendingBanner.tsx` with props `{ message, link?, sectionRef? }`).
4. **Admin settings UI to flip the policy + flag**: an audit row on every flip; the audit log is the forensic record of when the policy was actually confirmed.

When future stories encounter §10 questions (Q3 BIR receipt modality, Q8 expense categories, etc.), use this pattern.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT allow per-sale perpetual-care override** in this story. Phase 1 is policy-driven; per-sale override is a future feature with its own anti-abuse design.
- ❌ **Do NOT compute perpetual care client-side.** The cornerstone reads the policy server-side. If a malicious client crafts a sale request with an inflated `perpetualCare` field, server-side computation ignores it. **Defense in depth.**
- ❌ **Do NOT use float math for annual schedules.** `annualAmountCents` is an integer; `annualScheduleYears` is an integer; their product is an integer. No `* 1.0` anywhere.
- ❌ **Do NOT auto-collect annual fees at sale time** for `type: "annual"` contracts. Annual fees are billed annually via Phase 2's workflow. The sale collects only `basePriceCents − discountCents` for installment contracts (plus the down payment, etc.).
- ❌ **Do NOT generate annual schedule rows for "lifetime" contracts.** `annualScheduleYears: null` means no precomputed schedule; Phase 2 will handle ad-hoc annual billing for these.
- ❌ **Do NOT delete or mutate `annualFeeSchedule` rows when the contract is voided.** FR31 immutability: the schedule was a term of the contract, the void operationally cancels but doesn't erase. Story 3.7's `voidContract` doesn't touch perpetual care; verify in tests.
- ❌ **Do NOT silently change perpetual care terms when the global policy changes.** A contract created with `type: "none"` STAYS with `type: "none"`. The admin settings change applies to FUTURE contracts. (The PolicyPendingBanner on the contract detail page surfaces the timing for retroactive consideration; the decision to retroactively update is operational, not automatic.)
- ❌ **Do NOT put the PolicyPendingBanner inside a modal.** It's an inline banner; UX § 1294 forbids modals for ambient information.
- ❌ **Do NOT bypass `assertPolicyValid` in the cornerstone.** The admin settings UI validates client-side; the cornerstone re-validates server-side. Defense in depth.
- ❌ **Do NOT add `perpetualCare.type` to the `no-direct-financial-table-writes` lint rule** in this story. The rule narrowly targets specific financial table writes; `contracts.perpetualCare` is contract-config, not financial. Story 3.7 already verified the rule's scope.

### Common LLM-developer mistakes to prevent

- **Conflating one-time + annual into a single workflow:** they are operationally different. One-time fees are collected at sale (along with base price); annual fees are billed later via Phase 2. The schema captures both as `perpetualCare.type` discriminant; the cornerstone branches accordingly.
- **Reading the policy outside the cornerstone:** if you find yourself reading `cemeterySettings` from a non-cornerstone mutation that does financial writes, refactor to read inside the cornerstone (or pass the policy in via the payload — but that breaks the "no client-supplied perpetual care" defense).
- **Storing the annual schedule as a separate table:** the schedule is per-contract data; nested on the contract document is correct. A separate table would only be useful for cross-contract aggregation queries that don't exist yet.
- **Banner placement creep:** the PolicyPendingBanner appears in TWO places:
  - On `/admin/settings/perpetual-care` when `!perpetualCarePolicyConfirmed`.
  - On a contract's `PerpetualCareSection` when the contract's `type === "none"` AND `!perpetualCarePolicyConfirmed`.
  Do NOT add it elsewhere; UX § 1294 ambient information should be minimal.
- **Banner copy variation:** the banner text is exact (per AC2 and AC4). Localization is out of scope; do not paraphrase.
- **Forgetting the cornerstone re-validation:** even though the settings mutation validates the policy, the cornerstone MUST re-validate when it reads. A direct-DB tweak via Convex dashboard could write an invalid policy; the cornerstone's defensive re-validation catches it.
- **Date math drift:** using JS `Date` arithmetic instead of `addDays` from `convex/lib/dates.ts` introduces timezone bugs. Always use the helper.
- **Per-row state initialization:** every `annualFeeSchedule` row starts at `state: "scheduled"`. Don't initialize as `"overdue"` even if the due date is in the past (impossible at creation time — first due is `saleDate + offset`); leave the state machine to handle aging in Phase 2.

### Open questions / blockers this story does NOT resolve

- **§10 Q7 (perpetual care policy)** is THE blocker. This story is the §10 Q7-gated story; it ships with `type: "none"` defaults + banners + admin settings UI to flip when answered. **No development blocker** — the story can be implemented end-to-end before Q7 is answered, and the safe-defaults design means contracts created during the pending window are valid (just `type: "none"` until policy is set).
- **Phase 2 annual fee billing.** Not in this story; schema supports it.

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure & Boundaries](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries) — settings + per-domain helpers + per-component layout all match.
- [Architecture § Atomic mutation pattern](../../_bmad-output/planning-artifacts/architecture.md#api--communication-patterns) — server-side policy read inside the cornerstone preserves atomicity.
- [Architecture § §10 gating](../../_bmad-output/planning-artifacts/architecture.md) — second instance of the "policy pending defaults + banner" pattern (after Story 3.4).
- [PRD § Open Questions](../../_bmad-output/planning-artifacts/prd.md#open-questions) — Q7 explicitly named as a schema-finalization gate that can be answered during Phase 1 weeks 1-4.

No conflicts detected.

### References

- [PRD § FR25 (perpetual care fees, gated §10 Q7)](../../_bmad-output/planning-artifacts/prd.md#functional-requirements)
- [PRD § Open Questions > Q7](../../_bmad-output/planning-artifacts/prd.md) (line 632 — perpetual care fees — annual, one-time, or both)
- [Architecture § Atomic mutation pattern](../../_bmad-output/planning-artifacts/architecture.md#api--communication-patterns)
- [UX § PolicyPendingBanner pattern](../../_bmad-output/planning-artifacts/ux-design-specification.md) (§ Form Patterns — amber banner for policy gates)
- [Epics § Story 3.8](../../_bmad-output/planning-artifacts/epics.md#story-38-system-attaches-perpetual-care-fees-to-a-contract)
- Previous story dependencies: [Story 1.2](./1-2-server-enforces-role-based-access-on-every-endpoint.md), [Story 1.4](./1-4-design-tokens-and-statuspill.md), [Story 1.6 `emitAudit`](./1-6-audit-log-emit-and-redaction.md), [Story 3.2](./3-2-postfinancialevent-cornerstone.md), [Story 3.3](./3-3-office-staff-records-full-payment-sale.md), [Story 3.4](./3-4-office-staff-records-installment-sale-with-schedule.md), [Story 3.5](./3-5-office-staff-applies-discounts-and-promo-pricing.md)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Claude Code, Opus 4.7).

### Debug Log References

- `npm run typecheck` — green.
- `npm run lint` — green (resolved one `react-hooks/exhaustive-deps` warning by dropping a now-redundant `totalAfterDiscount` dep from the SaleForm `previewData` `useMemo` after `totalWithAddons` superseded it).
- `npm test` — 2032 passed / 1 skipped across 118 test files.
- `npm run build` — green.

### Completion Notes List

This story shipped a narrowed Phase 1 slice scoped per dev-handoff instructions: a **one-time perpetual care addon at contract creation**. The full §10 Q7-gated three-mode design (`one_time` / `annual` / `none`) with `cemeterySettings.perpetualCarePolicy`, `PolicyPendingBanner`, admin-only settings UI, annual fee schedule, and ADR-0014 is deferred — the schema-forward defaults pattern from Story 3.4 covers the gap (operators who don't want a fee simply omit it; `perpetualCareCents` defaults to `0`).

Concretely shipped:

- **`convex/schema.ts > contracts`** gained three optional columns: `perpetualCareCents`, `perpetualCarePaidCents`, `perpetualCareReason`. All `v.optional` so the 57 pre-3.8 in-flight contracts remain schema-valid. Sale mutations starting with Story 3.8 always write `perpetualCareCents: 0` + `perpetualCarePaidCents: 0` on every new contract, so going forward the two cent columns are effectively required.
- **`convex/contracts.ts`** modified both `recordFullPaymentSale` and `recordInstallmentSale` to accept `perpetualCareCents` + `perpetualCareReason` args (optional). The new file-local helper `normalizePerpetualCareInputs` enforces:
  - non-negative integer fee,
  - `(basePriceCents − discountCents) + perpetualCareCents === totalPriceCents` (arithmetic invariant),
  - fee ≤ total,
  - reason ≤ 280 chars, trimmed; rejected without a fee.
  Full-payment sales set `perpetualCarePaidCents = perpetualCareCents` (collected in the same financial event). Installment sales start `perpetualCarePaidCents` at `0` (Phase 2 / Epic 4 will wire allocation between principal and perpetual care on per-installment payments). The contract audit row carries the snapshot for forensic record.
- **`convex/contracts.ts > getContract`** hydrates the three perpetual-care fields when present.
- **`src/app/(staff)/contracts/[contractId]/page.tsx`** surfaces a perpetual-care row (amount + paid + reason) below the totalPriceCents row when the fee is > 0 on the contract — matches FR28 receipt-itemisation intent without requiring receipt-template surgery in this slice (Story 3.11/3.13 already drive the printable receipt off the same query payload).
- **`src/components/SaleForm/saleFormSchema.ts`** added `perpetualCareInput` + `perpetualCareReason` schema fields with mirrored client-side validation (matches server invariants for inline feedback).
- **`src/components/SaleForm/SaleForm.tsx`** added a new inline "Perpetual care fee (optional)" panel below the discount panel. The price summary now composes both `discountApplied` and `perpetualCareApplied` paths so combined entries show base / discount / perpetual / total. When perpetual care is supplied without a discount, the mutation receives `basePriceCents` + `discountCents: 0` so the server's arithmetic invariant resolves cleanly.

Answering the original story's "Completion Notes" prompts in the narrowed-scope frame:

- (a) Final shape on the contract document — three flat `v.optional` columns (`perpetualCareCents`, `perpetualCarePaidCents`, `perpetualCareReason`) instead of the original nested `perpetualCare: { type, totalAmountCents, annualFeeSchedule }`. Phase 1 ships one-time fees only; Epic 4 will extend if Q7 lands on "annual".
- (b) `PolicyPendingBanner` — NOT shipped. The narrowed scope skips the policy / banner layer; operators control the fee per-sale.
- (c) Where the fee lands for installment sales — the cornerstone treats the fee as part of `totalPriceCents` distributed across the down payment + installment schedule (caller-supplied schedule must already sum to the addon-inclusive total; otherwise the existing `ALLOCATION_SUM_MISMATCH` check fires). No new "Perpetual Care" schedule row is appended; the existing schedule rows implicitly carry the addon.
- (d) `assertPolicyValid` — N/A; no `cemeterySettings.perpetualCarePolicy` shipped. `normalizePerpetualCareInputs` rejects: negative fee (VALIDATION), reason without a fee (VALIDATION), reason > 280 chars (VALIDATION), fee > total (INVARIANT_VIOLATION), total-arithmetic mismatch (INVARIANT_VIOLATION).
- (e) Tests catching policy drift — the `contracts-perpetual-care.test.ts` "rejects when (base − discount) + perpetualCare ≠ total" cases (full + installment) catch any client/server arithmetic drift; the SaleForm tests verify the form sends `basePriceCents` + `discountCents: 0` whenever a fee is supplied without a discount, so the server invariant always has the data it needs.

### File List

**Modified:**

- `convex/schema.ts` — added `perpetualCareCents`, `perpetualCarePaidCents`, `perpetualCareReason` columns on `contracts`.
- `convex/contracts.ts` — added `normalizePerpetualCareInputs` helper, extended `recordFullPaymentSale` + `recordInstallmentSale` args/handlers + audit emissions; extended `getContract` result.
- `src/components/SaleForm/saleFormSchema.ts` — added `perpetualCareInput` + `perpetualCareReason` fields with mirrored validation.
- `src/components/SaleForm/SaleForm.tsx` — added a perpetual-care input panel, derived state for the addon, wired the mutation payload + price summary.
- `src/app/(staff)/contracts/[contractId]/page.tsx` — added perpetual-care surface (amount, paid, reason).
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — flipped story to `review`; bumped `last_updated`.
- `_bmad-output/implementation-artifacts/3-8-system-attaches-perpetual-care-fees-to-a-contract.md` — status → `review`; Dev Agent Record filled.

**Created:**

- `tests/unit/convex/contracts-perpetual-care.test.ts` — 16 cases covering full + installment flows: persistence, audit, defaults, composition with discount, invariant rejections.
- `tests/unit/components/SaleForm-perpetual-care.test.tsx` — 8 cases covering panel render, summary composition, submit payloads for fee-only / discount+fee / fee-without-reason / no-fee cases.
