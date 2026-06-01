# Story 3.4: Office Staff Records Installment Sale with Schedule

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **Office Staff**,
I want **to record an installment sale by entering down payment, term (months), due-day, grace period, and penalty rate, then have the system live-render the resulting schedule of installments and post the down payment + contract + schedule atomically through `postFinancialEvent`**,
so that **the cemetery can sell lots on installments and the contract carries every installment row from day one (FR20, FR21) — with the cents-precise math verified, and the schedule visible in a preview before commit**.

This story extends Story 3.3's `SaleForm` by replacing the stubbed Installment tab with the full installment flow + adds the `installments` table's real fields (Story 3.2 stubbed the table; this story fills it). The schedule generator is the largest single piece of net-new logic in this story; it runs client-side for live preview and server-side for the authoritative copy. **Story is gated on §10 Q1** (installment policy: grace period, penalty rate, lot-reclaim conditions); ships with **placeholder defaults + a "Defaults pending client policy confirmation" banner** so the build flows through development without blocking on the answer, but the banner makes it obvious to anyone running the system that the values are not final.

## Acceptance Criteria

1. **AC1 — Installment tab in `SaleForm` renders all required fields**: choosing the "Installment" tab on `/sales/new` reveals: Down Payment (cents), Term in Months (12 – 48, validated), Due Day (1 – 28; calendar-safe — no 29/30/31 to avoid month-rollover ambiguities), Grace Period (days, default **5** — placeholder), Penalty Rate (percent per month, default **2%** — placeholder), plus the Method / Reference / Date fields shared with Full Payment. Above the form, an amber **`PolicyPendingBanner`** displays: "Grace period and penalty rate defaults shown below pending client policy confirmation (§10 Q1)." The banner is dismissable per session but defaults to visible on every page mount.

2. **AC2 — `SchedulePreview` re-renders live as inputs change** (FR21): below the form fields, a `SchedulePreview` table shows: row 0 = down payment (sequence 0, due today), rows 1 – N = monthly installments computed from `(basePriceCents − downPaymentCents) / termMonths`, with the remainder cents added to the **final** installment (never the first — keeps later UX of "your installment is ₱X every month" honest). Each row shows: sequence, due date (next occurrence of the due-day starting from sale date + 1 month), amount (`formatPeso`). Total row at bottom matches `basePriceCents`. Updates run client-side with `useMemo`; no server roundtrip.

3. **AC3 — Schedule math is cents-precise and tested**: a Vitest test covers `generateInstallmentSchedule({ basePriceCents, downPaymentCents, termMonths, dueDay, startDate })` with inputs that exercise remainder allocation: `100,001` cents / 12 months → 11 rows of `8,333` cents + 1 row of `8,338` cents (sum equals `100,001`); never floating-point arithmetic; never `* 100` / `/ 100` on monetary values. Helper lives in `convex/lib/installments.ts` and is consumed identically by the client preview and the server mutation (single source of truth — never duplicate the math).

4. **AC4 — Submit posts the installment sale atomically via `postFinancialEvent`**: the receipt-preview modal opens showing **only the down payment receipt** (not the full contract — the receipt is for what was paid today, not the entire promise). On confirm, `recordInstallmentSale` mutation calls `postFinancialEvent({ kind: "sale_installment", … })`. The cornerstone (Story 3.2 Task 8 `prepareSaleInstallment`) creates: contract (state `active`, totalCents, outstandingBalanceCents = total − downPayment), all installment rows from the schedule array, payment for down payment, allocation row (kind `down_payment`), receipt with next serial, ownership row, audit. Lot transitions `available → reserved` (not `sold` — `sold` is reserved for fully-paid lots).

5. **AC5 — Banner state + defaults survive across the staff session, and final values are stored on the contract**: the contract row records `gracePeriodDays` and `penaltyRateBp` (basis points — 200 = 2%) as fields, captured at sale time from the form. Once §10 Q1 is answered, an admin-settings flow (separate future story) updates the default values; previously-created contracts keep their original values (NFR-C2 immutability per FR31). The banner reads from a single config flag — `installmentPolicyConfirmed: boolean` on a `cemeterySettings` table (created in this story as a minimal scaffold; full admin settings UI is later).

## Tasks / Subtasks

### Schema updates (AC1, AC4, AC5)

- [ ] **Task 1: Extend `installments` table in `convex/schema.ts`** (AC: 4)
  - [ ] Story 3.2 stubbed the table with `sequence`, `dueAt`, `amountCents`, `paidAmountCents`, `state`, `by_contract`, `by_contract_due` index. **UPDATE** to add:
    ```ts
    isDownPayment: v.boolean(),                  // true for sequence 0 only
    gracePeriodDays: v.number(),                 // captured from contract at install creation
    penaltyRateBp: v.number(),                   // basis points; 200 = 2%
    overdueFlaggedAt: v.optional(v.number()),    // populated by Epic 4 daily aging scheduler
    ```
  - [ ] **Run `npx convex dev`** + commit the regenerated `_generated/`.

- [ ] **Task 2: Extend `contracts` table** (AC: 5)
  - [ ] Add the installment-specific fields (these are present only on `kind: "installment"` contracts; nullable on full-payment):
    ```ts
    downPaymentCents: v.optional(v.number()),
    termMonths: v.optional(v.number()),
    dueDay: v.optional(v.number()),              // 1..28
    gracePeriodDays: v.optional(v.number()),
    penaltyRateBp: v.optional(v.number()),
    ```
  - [ ] These fields capture the contract's installment terms at sale-time and are **immutable** afterwards (architecture's FR31 immutability — only `outstandingBalanceCents` + `state` ever change post-sale).

- [ ] **Task 3: Add `cemeterySettings` table (minimal)** (AC: 5)
  - [ ] **NEW** table — single-row, similar pattern to `receiptCounter`:
    ```ts
    cemeterySettings: defineTable({
      installmentPolicyConfirmed: v.boolean(),   // §10 Q1 gate
      defaultGracePeriodDays: v.number(),        // 5 until confirmed
      defaultPenaltyRateBp: v.number(),          // 200 (= 2%) until confirmed
      // Story 3.8 adds perpetual-care config fields here; Story 3.11 adds BIR config.
      seededAt: v.number(),
    }),
    ```
  - [ ] Seed via `convex/seed.ts` extension (single-row pattern from Story 3.1): one row with `installmentPolicyConfirmed: false`, defaults `5` and `200`. Idempotent — re-running the seed never inserts a duplicate row.
  - [ ] **Add a public query** `getInstallmentPolicy` in `convex/contracts.ts` (NEW file; or **UPDATE** if Story 3.6 created it first):
    ```ts
    export const getInstallmentPolicy = query({
      args: {},
      handler: async (ctx) => {
        await requireAuth(ctx);
        const settings = await ctx.db.query("cemeterySettings").first();
        return settings ?? { installmentPolicyConfirmed: false, defaultGracePeriodDays: 5, defaultPenaltyRateBp: 200 };
      },
    });
    ```

### Schedule-generator helper (AC2, AC3)

- [ ] **Task 4: Create `convex/lib/installments.ts`** (**NEW**) (AC: 2, AC: 3)
  - [ ] Export a pure function (no Convex `ctx` dependency — runs identically client-side and server-side):
    ```ts
    export interface ScheduleInput {
      basePriceCents: number;
      downPaymentCents: number;
      termMonths: number;                        // 12..48
      dueDay: number;                            // 1..28
      startDate: number;                         // Unix ms; the sale date (Manila tz)
    }
    export interface ScheduleRow {
      sequence: number;
      dueAt: number;                             // Unix ms
      amountCents: number;
      isDownPayment: boolean;
    }
    export function generateInstallmentSchedule(input: ScheduleInput): ScheduleRow[] {
      // 1. Validate
      // 2. Compute per-installment base amount via integer division
      // 3. Add remainder cents to the FINAL installment
      // 4. Compute due dates: each row's dueAt is the dueDay of (saleMonth + sequence) in Manila tz
      // 5. Return down-payment row (seq 0) + installment rows (seq 1..termMonths)
    }
    ```
  - [ ] Implementation rules:
    - All math uses integer cents via `convex/lib/money.ts` helpers (`sub`, `mul` — and a new `divFloor(cents, divisor): { quotient, remainder }` helper added here as a one-liner).
    - Due dates use `convex/lib/time.ts` Manila-tz helpers (extend with `addMonths(ms, n)` + `setDayOfMonth(ms, day)` if not already present; both must respect Asia/Manila timezone for the date-only semantics; the milliseconds value points to local midnight on the due day).
    - The function is **side-effect-free**: no I/O, no `ctx`, no `Date.now()` — `startDate` is supplied by the caller.
  - [ ] **Mirror import in client**: create `src/lib/installments.ts` that re-exports the same function from `@/convex/lib/installments` (Convex's V8 functions are importable in browser code as long as they don't touch `ctx`). If cross-tree imports are awkward, copy-paste with a comment "Mirror of `convex/lib/installments.ts` — keep in sync; tested by the same suite." The architecture's preference is **single source**; pick the cleanest of the two depending on `tsconfig.json` path-alias rules.

- [ ] **Task 5: Vitest tests for the schedule generator** (AC: 3)
  - [ ] Create `tests/unit/convex/lib/installments.test.ts`. Cover:
    - **Cents-precise remainder allocation:** `100,001 cents / 12` → 11 × `8,333` + 1 × `8,338` (final row); sum equals `100,001`.
    - **Zero down payment + 24-month term:** `120,000 / 24` → 24 × `5,000`; first row is sequence 1 (no down payment in seq 0; the function omits the down-payment row if `downPaymentCents === 0`).
    - **Down payment + 12-month term + 13th-of-month due:** sequence 0 = down payment due today; seq 1 due Mar 13 if sale was Feb 17, etc. Verify Manila timezone (DST is irrelevant — PH has no DST, but document the assumption).
    - **Boundary: dueDay = 1, sale on Jan 31:** seq 1 dues Feb 1, NOT Mar 1 (the "next occurrence of dueDay" rule; not "+30 days").
    - **Boundary: termMonths = 48, basePrice = 1,000,001 cents:** remainder distribution still works at the upper bound.
    - **Invalid inputs:** termMonths < 12 or > 48 → throw `INVARIANT_VIOLATION`. dueDay < 1 or > 28 → throw. Negative cents → throw.

### Convex domain layer (AC4, AC5)

- [ ] **Task 6: Create `recordInstallmentSale` mutation in `convex/sales.ts`** (AC: 4)
  - [ ] **UPDATE** `convex/sales.ts` (created in Story 3.3 with `recordFullPaymentSale`).
  - [ ] Signature:
    ```ts
    export const recordInstallmentSale = mutation({
      args: {
        lotId: v.id("lots"),
        customerId: v.id("customers"),
        basePriceCents: v.number(),
        downPaymentCents: v.number(),
        termMonths: v.number(),
        dueDay: v.number(),
        gracePeriodDays: v.number(),
        penaltyRateBp: v.number(),
        method: v.union(v.literal("cash"), v.literal("check"), v.literal("bank")),
        reference: v.optional(v.string()),
        paidAt: v.number(),
        idempotencyKey: v.string(),
      },
      handler: async (ctx, args) => {
        await requireRole(ctx, ["office_staff", "admin"]);
        // 1. Defensive validation (cornerstone re-validates; defense-in-depth)
        if (args.termMonths < 12 || args.termMonths > 48) throwError(ErrorCode.INVARIANT_VIOLATION, "Term must be 12–48 months.");
        if (args.dueDay < 1 || args.dueDay > 28) throwError(ErrorCode.INVARIANT_VIOLATION, "Due day must be 1–28.");
        if (args.downPaymentCents >= args.basePriceCents) throwError(ErrorCode.INVARIANT_VIOLATION, "Down payment must be less than base price (use Full Payment flow).");

        // 2. Generate schedule (server-side authoritative copy)
        const schedule = generateInstallmentSchedule({
          basePriceCents: args.basePriceCents,
          downPaymentCents: args.downPaymentCents,
          termMonths: args.termMonths,
          dueDay: args.dueDay,
          startDate: args.paidAt,
        });
        const installments = schedule.filter(r => !r.isDownPayment).map(r => ({ sequence: r.sequence, dueAt: r.dueAt, amountCents: r.amountCents }));

        // 3. Hand to cornerstone
        return await postFinancialEvent(ctx, {
          kind: "sale_installment",
          lotId: args.lotId,
          customerId: args.customerId,
          basePriceCents: args.basePriceCents,
          discountCents: 0,                       // Story 3.5
          downPaymentCents: args.downPaymentCents,
          installments,
          method: args.method,
          reference: args.reference,
          paidAt: args.paidAt,
          idempotencyKey: args.idempotencyKey,
          // contract terms passed through for storage on the contract row
          termMonths: args.termMonths,
          dueDay: args.dueDay,
          gracePeriodDays: args.gracePeriodDays,
          penaltyRateBp: args.penaltyRateBp,
        });
      },
    });
    ```
  - [ ] **Story 3.2 extension needed:** the `sale_installment` payload type in `postFinancialEvent.ts` (Task 5 of Story 3.2) currently lists `lotId, customerId, basePriceCents, discountCents, downPaymentCents, installments, method, reference, paidAt, idempotencyKey`. This story EXTENDS the payload type to also accept `termMonths, dueDay, gracePeriodDays, penaltyRateBp` — and Story 3.2 Task 8 `prepareSaleInstallment` writes them onto the new `contracts` columns added in Task 2. Mark this as a Story 3.2 file modification in the dev-agent record.

### UI — Installment tab + SchedulePreview (AC1, AC2, AC4)

- [ ] **Task 7: Build `src/components/SaleForm/InstallmentTab.tsx`** (**NEW**) (AC: 1)
  - [ ] Replaces Story 3.3's stub. Renders: LotPicker + CustomerPicker (shared from Story 3.3), then advanced terms section:
    - Down Payment (peso-prefix input)
    - Term Months (number input, min 12 max 48, default 24)
    - Due Day (number input, min 1 max 28, default 5)
    - Grace Period Days (default from `getInstallmentPolicy.defaultGracePeriodDays`, editable)
    - Penalty Rate % per month (default from `defaultPenaltyRateBp / 100`, editable)
    - Method / Reference / Date (shared)
  - [ ] **Above the form**, render `<PolicyPendingBanner />` only when `getInstallmentPolicy().installmentPolicyConfirmed === false`. Once confirmed (future admin flow), the banner disappears automatically (reactive query).
  - [ ] Submit button label: **"Review receipt"** (same as Full Payment).

- [ ] **Task 8: Build `src/components/SaleForm/SchedulePreview.tsx`** (**NEW**) (AC: 2)
  - [ ] Props: `{ basePriceCents, downPaymentCents, termMonths, dueDay, startDate }`. Internally calls `generateInstallmentSchedule(...)` via `useMemo` keyed on the inputs.
  - [ ] Renders a table:
    | Seq | Due Date | Amount |
    |---|---|---|
    | DP | Today (17 May 2026) | ₱25,000.00 |
    | 1 | 5 Jun 2026 | ₱8,333.33 |
    | … | … | … |
    | 12 | 5 May 2027 | ₱8,338.00 |
    | **Total** | | **₱125,000.00** |
  - [ ] Tabular numerics for the Amount column. Bold final total. Diff-friendly: if inputs change, only the affected rows reflow (React reconciliation).
  - [ ] Empty state: when `basePriceCents === 0` or `termMonths === 0`, show "Fill in price + term to preview the schedule." No skeleton — this is informational, not data-loading.
  - [ ] **Reactive grace+penalty footer:** "Grace period: 5 days. Penalty: 2% per month on overdue amounts." Reflects the live form values (so the staff sees what the contract will actually capture, not just the defaults).

- [ ] **Task 9: Build `src/components/SaleForm/PolicyPendingBanner.tsx`** (**NEW**) (AC: 1)
  - [ ] Amber background (`bg-amber-50 border-amber-200`), info icon, copy: "Installment policy pending client confirmation (§10 Q1). Grace period and penalty rate use placeholder defaults (5 days / 2% per month). Final values will be locked once policy is confirmed."
  - [ ] Dismiss button — stores `installmentBannerDismissed: true` in `sessionStorage`; cleared on logout. Default state on page mount: visible.
  - [ ] `aria-live="polite"` — screen readers announce.
  - [ ] **Make this component reusable**: Story 3.8 (perpetual care) needs a similar banner gated on §10 Q7; refactor `PolicyPendingBanner` to accept `{ topic: "installments" | "perpetualCare" | "birReceipt", message, dismissKey }` props in this story so 3.8 reuses without duplication.

- [ ] **Task 10: Wire submit + receipt preview modal to installment flow** (AC: 4)
  - [ ] Reuse Story 3.3's `ReceiptPreviewModal` — the receipt content for an installment sale shows **only the down payment**: customer, lot, "Down Payment for Contract #N", method, amount. The full installment schedule appears on the contract detail page (Story 3.6) — the receipt is a record of money received today, nothing more.
  - [ ] On commit success, route to `/contracts/[contractId]` and trigger `window.print()` for the receipt PDF (placeholder — Story 3.13 finishes the print integration).
  - [ ] Error handling matches Story 3.3 (`ILLEGAL_STATE_TRANSITION` → "lot just sold by someone else"; `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD` → "Form changed during retry").

### Tests (AC1, AC4)

- [ ] **Task 11: Convex tests for `recordInstallmentSale`** (AC: 4)
  - [ ] Add cases to `tests/unit/convex/sales.test.ts` (created by Story 3.3 with full-payment tests):
    - Happy path: 12-month installment, valid inputs → returns receipt; lot is `reserved`; contract exists with state `active`, `kind: "installment"`, `termMonths: 12`, etc.; 12 installment rows exist; payment for down payment exists; allocation row `down_payment` exists; receipt issued.
    - Term out of range (8 months) → `INVARIANT_VIOLATION`.
    - Due day out of range (30) → `INVARIANT_VIOLATION`.
    - Down payment ≥ base price → `INVARIANT_VIOLATION` ("use Full Payment flow").
    - Customer role calling → `FORBIDDEN`.
    - Idempotency: second call same key → same receipt; only one set of installment rows in DB (not 24).

- [ ] **Task 12: Component tests for `SchedulePreview`** (AC: 2)
  - [ ] Co-located `src/components/SaleForm/SchedulePreview.test.tsx`. Cover:
    - Renders the correct number of rows for various term inputs.
    - Total equals basePriceCents.
    - Updates live when basePriceCents or termMonths changes.
    - Tabular numerics class applied.
    - Empty-state copy when inputs are 0.

- [ ] **Task 13: Playwright spec for installment journey** (AC: 1 – AC: 5)
  - [ ] **UPDATE** `tests/e2e/journey-1-installment-sale.spec.ts` (the canonical Journey 1 spec from architecture's test layout; if not yet created, **NEW**).
  - [ ] Walks: log in → /sales/new → Installment tab → fill form → verify SchedulePreview updates as inputs change → review receipt → confirm → assert contract detail shows 12 installment rows + down payment posted + 600ms amber flash on the down-payment row.

## Dev Notes

### Previous story intelligence

**Hard dependencies:**

- **Story 3.1 — `receiptCounter`, `allocateNextSerial`.** Consumed via cornerstone.
- **Story 3.2 — `postFinancialEvent` cornerstone.** This story extends the `sale_installment` payload type with contract-term fields (Task 6 note) and exercises Story 3.2's `prepareSaleInstallment` (Task 8 of 3.2). Mark the cross-story Story-3.2 file modification clearly in the dev agent record.
- **Story 3.3 — `SaleForm` shell, LotPicker, CustomerPicker, ReceiptPreviewModal, /sales/new route.** This story EXTENDS by filling in the Installment tab.
- **Story 1.7 — state machines.** `lot: available → reserved` transition must exist. If Story 1.7 didn't include this transition, this story EXTENDS `stateMachines.ts`.
- **Story 1.4 — design tokens, StatusPill, ReactiveHighlight.** Reused.
- **Story 1.something — `convex/lib/time.ts`** with Manila tz helpers + `convex/lib/money.ts` with cents arithmetic. Both are extended slightly here (Task 4 — `divFloor`, `addMonths`, `setDayOfMonth`).

**TODOs this story creates:**

- The `cemeterySettings` table grows in Stories 3.8 (perpetual care) and 3.11 (BIR config). Document the schema-accretion plan in `convex/schema.ts` near the table definition.
- The "admin settings UI" that flips `installmentPolicyConfirmed: true` (and updates default values) is **out of scope** here — a future Epic 6 admin-settings story handles it. Until then, the only way to change the values is via `npx convex run` against the seed function.

### Architecture compliance

- **PRD § FR20 + FR21 (installment + auto-schedule).** Tasks 4 + 8 implement them; Task 5 verifies cents-precision (NFR-M2 ≥ 90% on financial code).
- **PRD § Open Questions Q1 — installment policy.** Story is gated; the banner pattern (Task 9) is the architecturally-blessed "ship safely with placeholder defaults" approach.
- **Architecture § Pattern Examples > Good payment posting** — Task 6 follows the same `requireRole` → `postFinancialEvent` template.
- **Architecture § Format Patterns > Money / Time** — all monetary math via `convex/lib/money.ts` helpers (cents integers); all due-date math via `convex/lib/time.ts` Manila-tz helpers. Tasks 4 + 5 enforce.

### Library / framework versions

- **No new runtime deps.** React Hook Form's array fields are used for nothing here; the schedule is computed, not edited row-by-row. (Story 3.10 introduces editable allocations — different shape.)
- **shadcn/ui Table** — for SchedulePreview. Copy from registry if not yet present.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                    # UPDATE (extend installments + contracts; add cemeterySettings)
│   ├── seed.ts                                      # UPDATE (seed cemeterySettings)
│   ├── sales.ts                                     # UPDATE (add recordInstallmentSale)
│   ├── contracts.ts                                 # NEW (or UPDATE if Story 3.6 created) — add getInstallmentPolicy query
│   ├── lib/
│   │   ├── installments.ts                          # NEW (generateInstallmentSchedule pure helper)
│   │   ├── postFinancialEvent.ts                    # UPDATE (extend sale_installment payload + prepareSaleInstallment storage)
│   │   ├── money.ts                                 # UPDATE (add divFloor)
│   │   └── time.ts                                  # UPDATE (add addMonths, setDayOfMonth)
├── src/
│   ├── components/SaleForm/
│   │   ├── InstallmentTab.tsx                       # NEW (replaces Story 3.3's stub TabsContent)
│   │   ├── SchedulePreview.tsx                      # NEW
│   │   ├── SchedulePreview.test.tsx                 # NEW
│   │   ├── PolicyPendingBanner.tsx                  # NEW (reusable; Stories 3.8, 3.11 reuse)
│   │   └── SaleForm.tsx                             # UPDATE (mount InstallmentTab + read getInstallmentPolicy + render banner)
│   └── lib/installments.ts                          # NEW (re-export of the Convex helper, or pinned copy)
├── tests/
│   ├── unit/convex/
│   │   ├── sales.test.ts                            # UPDATE (add installment cases)
│   │   └── lib/installments.test.ts                 # NEW
│   └── e2e/
│       └── journey-1-installment-sale.spec.ts       # NEW or UPDATE (Journey 1 canonical spec)
```

### Testing requirements

- **NFR-M2 ≥ 90% on `convex/lib/installments.ts`** — the schedule generator is financial-touching by definition. Hit 100% if practical (it's a pure function).
- **The cents-precision test is the most important assertion in this story.** A failure here = customer overpayments or arrears that don't balance = audit findings = trust erosion.
- **Test the FAIL mode** of `generateInstallmentSchedule`: pass `{ basePriceCents: 100_001, downPaymentCents: 0, termMonths: 12 }` and assert sum equals 100_001. Then deliberately mutate the helper to use `Math.floor(x / n)` without remainder allocation in a branch; verify the test FAILS.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT use floating-point arithmetic** on monetary values. `100001 / 12` produces `8333.4166…` — using JS division and then `Math.floor` works **only if** you also explicitly track the remainder. Use `divFloor` (Task 4) — never raw `/`.
- ❌ **Do NOT add remainder cents to the FIRST installment.** UX trust: customer expectation is "₱X every month until the last one settles up." Adding remainder to seq 1 means the first invoice they see is odd-cents; adding to the final makes the schedule legible.
- ❌ **Do NOT allow `dueDay > 28`.** February (28 / 29 days) makes 29 / 30 / 31 a month-rollover problem. Lock the input.
- ❌ **Do NOT allow `termMonths < 12` or `> 48`** — these are the policy bounds per FR20. Wider ranges need an ADR + §10 Q1 answer.
- ❌ **Do NOT compute the schedule client-side AND server-side independently.** Single source of truth (`generateInstallmentSchedule`). Server re-runs the math from the same inputs — never trusts the client's `installments` array (defense-in-depth).
- ❌ **Do NOT skip the `installmentPolicyConfirmed` banner.** Even if the §10 Q1 answer arrives during the story's implementation, the banner pattern is correct — once the answer lands, an admin flips the flag and the banner disappears reactively.
- ❌ **Do NOT make the grace period or penalty rate immutable post-confirmation.** Each contract captures its values at sale-time; the policy flag affects defaults for NEW contracts, not existing ones (FR31 immutability).
- ❌ **Do NOT roll the down payment into the receipt's "installments paid" section.** The receipt records "Down Payment" as a distinct line item; the cornerstone's `allocationKind: "down_payment"` is the sanctioned label.
- ❌ **Do NOT transition the lot to `sold` on installment sale.** The lot is `reserved` until the final installment posts (then Story 3.6's state machine transitions it to `sold` — or the architecture's chosen lot-state semantics for "fully paid installment"; verify with Story 1.7's state tables).
- ❌ **Do NOT add a "Save draft" button.** This story commits atomically; drafts would create state-machine pre-states that nobody else's code expects. If "draft sales" is needed later, it's an ADR.
- ❌ **Do NOT copy-paste `generateInstallmentSchedule` into `src/lib/installments.ts` if `tsconfig.json` paths allow direct import.** Single source.

### Common LLM-developer mistakes to prevent

- **Computing dueAt via `new Date(saleDate).setMonth(saleMonth + n)`:** JS Date's `setMonth` rolls overflow days in a way that depends on the day-of-month. Use the dedicated `addMonths` helper which uses `Intl.DateTimeFormat` or a small custom routine that pegs to `dueDay` directly.
- **Mixing days-vs-months in grace + penalty fields:** grace is in days, penalty rate is per-month. Don't conflate.
- **Forgetting to clamp `dueDay` ≤ 28:** the form's number input must enforce this; the server validation re-asserts.
- **Showing the banner once and treating it as "user acknowledged":** the banner is per-mount + dismissable-per-session, not per-user-forever. The compliance officer's whole reason for wanting it is that it appears every session until policy is confirmed.
- **Hard-coding the defaults in two places:** `5` and `200` live in `cemeterySettings` (Task 3 seed). The form reads them via query. Do not hardcode `5` / `200` in the form component file.
- **Wrong field type for `penaltyRateBp`:** basis points (200 = 2%), NOT percentage (2.0 = 2%). The form displays `2.0%` to the user but stores `200` bp. Conversion happens in the form layer via React Hook Form's `controller`.
- **Mounting the InstallmentTab inside Form provider but using stale watched values:** RHF's `useWatch({ name })` re-renders correctly; don't fall back to `getValues()` for the SchedulePreview, which would not re-render.

### Open questions / blockers this story does NOT resolve

- **§10 Q1 (installment policy) — partial gate.** This story ships with placeholder defaults + the banner. Once §10 Q1 is answered:
  - The cemetery confirms grace + penalty values (could be different than `5` / `2%`).
  - An admin updates `cemeterySettings.defaultGracePeriodDays` + `defaultPenaltyRateBp` and flips `installmentPolicyConfirmed: true`.
  - The banner disappears reactively for all staff.
  - **Existing contracts are unaffected** — each captures its values at creation (Task 2 + Task 6).
- **Lot reclaim conditions** (§10 Q1's third sub-question) are a Story 4.5 concern (Epic 4 Admin reclaims defaulted lot). Not blocked here.

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure & Boundaries](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries) — file paths match. `convex/lib/installments.ts` is a new helper at the `lib/` level (single source for shared client+server math).
- [Architecture § Format Patterns > Money + Time](../../_bmad-output/planning-artifacts/architecture.md#format-patterns) — strict adherence in Tasks 4 + 5.

### References

- [PRD § FR20 (installment sale), FR21 (schedule generation), Q1 (installment policy)](../../_bmad-output/planning-artifacts/prd.md#functional-requirements)
- [Architecture § Pattern Examples](../../_bmad-output/planning-artifacts/architecture.md#pattern-examples)
- [Architecture § Format Patterns > Money + Time](../../_bmad-output/planning-artifacts/architecture.md#format-patterns)
- [UX § Defining Experience > SchedulePreview pattern](../../_bmad-output/planning-artifacts/ux-design-specification.md) — UX-DR8 reference; the SchedulePreview component is also called out in the UX system inventory
- [Epics § Story 3.4](../../_bmad-output/planning-artifacts/epics.md#story-34-office-staff-records-installment-sale-with-schedule)
- Previous story dependencies: [Story 3.1](./3-1-receipt-counter-with-optimistic-concurrent-serial-allocation.md), [Story 3.2](./3-2-postfinancialevent-cornerstone.md), [Story 3.3](./3-3-office-staff-records-full-payment-sale.md), Stories 1.2, 1.4, 1.7

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Claude Code dev agent, autonomous run 2026-05-18).

### Debug Log References

None — fresh feature surface; no inherited debug threads.

### Completion Notes List

The shipped implementation deliberately diverges from the original spec
in several places to keep the change inside the file-ownership scope
the system message granted (and to keep the surface honest about
which §10 questions are gating later work). Each divergence is
flagged here so the reviewer can decide whether to re-elicit:

1. **Schema shape — `installments` table.** Adopted the simpler shape
   from the system-message handoff:
   `installmentNumber` / `principalCents` / `paidCents` / `status`
   (pending / paid / overdue / waived) — not the richer Story-3.4-doc
   shape (`sequence` / `dueAt` / `amountCents` / `paidAmountCents` /
   gracePeriodDays / penaltyRateBp / overdueFlaggedAt). Indexes
   landed as `by_contract` + `by_dueDate`. The Epic 4 aging story
   will extend the table with grace-period + penalty + flagged-at
   fields once §10 Q1 is answered. The `monthlyAmountCents` and
   `firstDueDate` terms are stored on the **contract** row rather
   than spread across every installment, which is the lighter-weight
   shape compatible with the system-message handoff.

2. **`cemeterySettings` table + `PolicyPendingBanner` — DEFERRED.**
   The Story-3.4 doc specifies a new single-row `cemeterySettings`
   table + a `getInstallmentPolicy` query + a reusable
   `PolicyPendingBanner` component. The system-message handoff scope
   for this story did NOT include these — and seeding the new table
   would require touching `convex/seed.ts`, which is outside the
   allowed file set. The grace-period / penalty-rate fields are
   therefore NOT yet captured at sale time. Implementing them is
   a one-story follow-up that wires the new table + admin seed +
   UI banner together as a coherent change.

3. **`convex/lib/installments.ts` — NOT CREATED.** `convex/lib/**`
   is read-only in this story's file ownership. The schedule
   generator (`generateInstallmentSchedule` + `addMonthsClamped`)
   therefore lives at
   `src/components/InstallmentSchedule/generateSchedule.ts`. The
   server mutation does NOT regenerate the schedule from
   `firstDueDate` — it validates the caller-supplied installments
   array's shape and cents-sum invariant, then inserts it verbatim.
   This is defense-in-depth (the server still rejects any malformed
   schedule) but it does NOT enforce the dueDate-calendar-math at
   the server boundary. A future hoist of the generator into
   `convex/lib/` would tighten this.

4. **Lot state target on installment sale — `sold`, not `reserved`.**
   The system-message handoff explicitly states "Transitions lot to
   'sold'" for `recordInstallmentSale`; this implementation honors
   that. The Story-3.4 doc proposes `available → reserved`. Both
   transitions exist in the Story 1.7 state machine, so either
   would lint clean; the divergence is a policy choice that needs
   an ADR or epic-retro decision.

5. **Day-of-month math.** `addMonthsClamped` uses Date.UTC field
   arithmetic with explicit clamping (Jan 31 → Feb 28 in 2026,
   Feb 29 in 2028). It is NOT timezone-aware in the strict sense —
   it operates on UTC fields; the caller is responsible for
   composing the `firstDueDate` at Manila midnight (UTC+8) so the
   resulting due dates land on the right calendar day for the
   cemetery's operators. The Philippines has no DST, so the simple
   `+08:00` offset never drifts.

6. **`recomputeInstallmentAging` — NOT shipped.** The system
   message flagged this as "optionally" addressed here, with
   Epic 4 as the canonical owner. We name-checked it in the
   `convex/installments.ts` docstring but ship no implementation —
   shipping a stub would invite future drift.

### File List

Created:
- `convex/installments.ts` — `listContractInstallments` query.
- `src/components/InstallmentSchedule/generateSchedule.ts` — pure
  schedule generator + `addMonthsClamped` helper.
- `src/components/InstallmentSchedule/InstallmentSchedule.tsx` —
  read-only preview table consumed by `InstallmentTermsPanel`.
- `src/components/InstallmentSchedule/index.ts`.
- `src/components/SaleForm/InstallmentTermsPanel.tsx` — full
  installment-tab form, generator → mutation handoff.
- `tests/unit/components/InstallmentSchedule.test.tsx`.
- `tests/unit/convex/installments.test.ts`.
- `tests/e2e/installment-sale.spec.ts` (route-protection smoke;
  full happy path TODO).

Modified:
- `convex/schema.ts` — added `installments` table + `by_contract`
  / `by_dueDate` indexes; added installment-term columns
  (`downPaymentCents`, `termMonths`, `monthlyAmountCents`,
  `firstDueDate`) to `contracts`.
- `convex/contracts.ts` — appended `recordInstallmentSale` mutation
  + `RecordInstallmentSaleArgs` / `RecordInstallmentSaleResult` /
  `InstallmentInput` types.
- `src/components/SaleForm/SaleForm.tsx` — replaced the Story 3.3
  Installment-tab stub with `<InstallmentTermsPanel />`.
- `src/components/SaleForm/saleFormSchema.ts` — added
  `installmentSaleFormSchema` + `composeFirstDueDateMs`.
- `src/components/SaleForm/index.ts` — re-exports.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` —
  flipped 3-4 to `review`.
- `_bmad-output/implementation-artifacts/3-4-office-staff-records-installment-sale-with-schedule.md`
  — status to `review`, Dev Agent Record filled in.
