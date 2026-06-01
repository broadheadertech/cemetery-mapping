# Story 3.10: Office Staff Overrides Default Allocation

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **Office Staff**,
I want **to override the default oldest-unpaid allocation on a payment by manually redistributing the amount across one or more installments — and, when the override leaves an installment overdue, to capture an inline follow-up action without leaving the form**,
so that **customer wishes ("apply this to next month, not the overdue one") are honored while the audit trail stays intact and an installment that was overdue stays distinguishable from a silently-overdue one** (FR27, supports FR35 / Story 4.2's "overdue with logged action" semantics).

This story extends Story 3.9's `PaymentForm` by surfacing an inline **AllocationEditor** behind the "Allocate manually" affordance, wiring an explicit `manual_override` allocation kind through the cornerstone, and stitching the **overdue-with-logged-action prompt** into the same form (no second modal, no second submit). The two interactions are joined because they share a question: *"You're knowingly leaving installment N overdue — is there a follow-up action we should log against it?"* The UX answers that question once, in line, and the mutation posts both the payment **and** the follow-up action in one round-trip.

## Acceptance Criteria

1. **AC1 — "Allocate manually" opens an inline editor; collapsing it restores the auto-allocation**: on the PaymentForm (Story 3.9, `/payments/new?contractId=…`), a secondary button **"Allocate manually"** lives next to the default Allocation preview. Click expands an `AllocationEditor` panel below the form fields, listing every unpaid installment with a per-row amount input (peso prefix, tabular numerics), a drag handle for re-ordering allocation order, and a "Reset to default" link. Click "Allocate manually" again (or "Reset to default") restores the oldest-unpaid auto-allocation and collapses the editor. The editor is **part of the form**, not a modal — Tab order continues from the form fields into the rows.

2. **AC2 — Submit is gated by sum-equals-amount**: while the editor is open, the form's submit button ("Review receipt") is disabled until `sum(perRowAmountCents) === paymentAmountCents`. A live sum row at the bottom of the editor shows "Allocated: ₱X,XXX.XX of ₱Y,YYY.YY" with a red text and inline error sentence when the totals diverge ("Allocate the remaining ₱Z.ZZ or change the payment amount"). Overpayment of any single installment beyond its outstanding due triggers an inline warning on that row ("Installment #4 only has ₱4,000.00 due — extra ₱1,000.00 would credit forward"). Phase 1 forbids the credit-forward path — the row is invalid, submit stays disabled — until the cornerstone's `credit` allocation kind ships (Story 3.2 Task 9 decision; revisit in a later story).

3. **AC3 — Overdue-with-logged-action prompt appears inline before submit**: if the AllocationEditor leaves at least one installment in an `overdue` state after the proposed allocation (i.e. an overdue installment was deliberately not allocated to, or was only partially covered while a newer installment was fully paid), an **inline reason capture** section appears between the editor and the submit button. It reads: "Installment #N will remain overdue. Add a logged follow-up action?" with two affordances: (a) a free-text reason textarea (3 rows max, max 500 chars), (b) a target-date picker (defaults to today + 7 days, Manila tz, editable, must be `> now`). The section is **collapsible** — staff can dismiss without logging — but the dismiss state is recorded on submit so the audit log knows whether the prompt was shown-and-skipped or never shown.

4. **AC4 — `recordPayment` accepts an explicit `allocations` array + optional `followUpAction` payload and routes through `postFinancialEvent`**: the existing `recordPayment` mutation (Story 3.9, `convex/payments.ts`) is **EXTENDED** to accept `allocations: Array<{ installmentId, amountCents, allocationKind }>` and `followUpAction?: { installmentId, reasonText, targetDate }`. The mutation passes `allocations` through to `postFinancialEvent({ kind: "payment", allocations })` exactly as supplied (server re-validates sums + ownership), and, after a successful post, inserts the `followUpAction` row via the same atomic mutation (consuming Story 4.2's `addFollowUpAction` helper directly, NOT calling out to its public mutation — composition not invocation). The `allocationKind` for manual rows is `"manual_override"`; rows the editor left untouched stay `"auto_oldest"`.

5. **AC5 — Audit captures the override + the inline action**: every manual override emits an `auditLog` row with `action: "payment.allocate.override"`, `reason: <staff-supplied or "(no reason given)">`, and a `before/after` snapshot of the allocation distribution (which installments would have been touched by auto vs. which actually were). When the inline follow-up action is captured, a **second** audit entry is emitted with `action: "followUpAction.add"` referencing the just-created follow-up record and the payment that produced it. Both entries share the same `correlationId` (Story 1.6 `emitAudit` already supports this) so forensic queries can reconstruct the override+action pair.

## Tasks / Subtasks

### UI — AllocationEditor + inline reason capture (AC1, AC2, AC3)

- [ ] **Task 1: Build `src/components/PaymentForm/AllocationEditor.tsx`** (**NEW**) (AC: 1, AC: 2)
  - [ ] Props: `{ paymentAmountCents, installments: UnpaidInstallment[], value: AllocationRow[], onChange(rows): void, onResetToDefault(): void, disabled?: boolean }`.
  - [ ] Renders a single `<table>` (shadcn/ui `Table` registry copy) with columns: drag-handle, sequence, due date, outstanding (read-only), allocated amount (editable peso input), warning slot.
  - [ ] Drag-and-drop reordering: **dnd-kit** (already on the dependency list — `@dnd-kit/core`, `@dnd-kit/sortable`; if not yet installed in an earlier story, **add as a runtime dep here** and pin the version). Reordering affects the **persisted order of `allocations` rows** passed to the cornerstone (it does NOT renumber installment sequences — the row's `installmentId` and `sequence` stay bound). The order matters for the audit-log snapshot (the "stated intent" of the override — apply newest-first vs. oldest-first).
  - [ ] Per-row amount input: peso-prefix, tabular numerics, blur-coerces to cents, accepts `0` (means "no allocation for this installment in this payment"). Inline warning slot below the row if `amount > outstanding`.
  - [ ] Footer row: "Allocated: ₱X of ₱Y" with `text-destructive` when sums diverge, `text-emerald-700` (matches `Available` status palette in UX §) when equal. Emit a numeric `validity` field via `onChange` for the parent form to gate the submit button.
  - [ ] "Reset to default" — a small text link beside the "Allocate manually" toggle in the parent form; clicking calls `onResetToDefault` and the parent collapses the editor.
  - [ ] Empty state: if `installments.length === 0` (contract fully paid), the editor doesn't render (parent should not have shown the "Allocate manually" button either).
  - [ ] **Accessibility:** drag-handle is a `<button>` with `aria-label="Move installment N up/down"` + keyboard reordering via `ArrowUp` / `ArrowDown` (dnd-kit supports this — verify in current docs); `aria-live="polite"` on the footer sum so screen readers announce sum changes; each row's warning slot uses `aria-describedby` on the amount input.

- [ ] **Task 2: Build `src/components/PaymentForm/OverdueFollowUpInline.tsx`** (**NEW**) (AC: 3)
  - [ ] Props: `{ overdueInstallmentsRemaining: Installment[], value: { reasonText: string, targetDate: number, skipped: boolean } | undefined, onChange(v): void }`.
  - [ ] Renders **only when** `overdueInstallmentsRemaining.length > 0`. Above the form's submit button, after the AllocationEditor.
  - [ ] Layout: a soft-amber surface (`bg-amber-50 border-amber-200 border rounded-md p-4`) with copy: "Installment #N will remain overdue. Add a logged follow-up action?" If multiple overdue installments remain, the copy lists each ("Installments #3, #5 will remain overdue. Add a logged follow-up action for each?"). For the multi case, the inline form captures **one reason + target date applied to all listed installments** — keeps the staff flow fast; per-installment differentiation is a Story 4.2 follow-up.
  - [ ] Inside the surface: textarea (`name="reasonText"`, 3 rows, `max-length=500`, placeholder "Why is this installment being left overdue?"), date picker (`name="targetDate"`, default `Date.now() + 7d` in Manila tz, min `Date.now()`), and a dismiss link ("Skip — do not log an action").
  - [ ] Dismiss is **explicit** (not implicit by leaving fields blank) — sets `skipped: true` on the form value. The auditLog records `skipped: true` so we know "the staff saw the prompt and chose not to act," distinct from "the prompt was never shown."
  - [ ] Validation: if `skipped === false` (the form is open and the staff intends to log), `reasonText.trim().length > 0` is required; `targetDate > Date.now()` is required. Inline error sentences via `aria-describedby`. If `skipped === true`, both fields are ignored.

- [ ] **Task 3: Wire AllocationEditor + OverdueFollowUpInline into `PaymentForm.tsx`** (**UPDATE**) (AC: 1, AC: 2, AC: 3)
  - [ ] Story 3.9 created `src/components/PaymentForm/PaymentForm.tsx` with auto-allocation logic via `computeAutoAllocation(unpaidInstallments, amountCents)` (single source of truth — Story 3.9 puts this helper at `convex/lib/allocations.ts`). This story EXTENDS the form:
    - Add a controlled toggle state `mode: "auto" | "manual"`. Default `"auto"`.
    - Add an array state `manualRows: AllocationRow[]` initialized from the auto-computed default the first time the user clicks "Allocate manually" — so the manual editor opens populated with the auto distribution and the user redistributes from there (much friendlier than a blank slate).
    - Render `<AllocationEditor>` when `mode === "manual"`; otherwise render the existing read-only auto-allocation preview.
    - Compute `overdueRemaining` reactively from `mode === "auto" ? autoRows : manualRows` — an installment is "overdue remaining" if its state is `overdue` AND `sum(allocations for that installmentId).amountCents < installment.outstandingCents`. Pass to `<OverdueFollowUpInline>`.
    - Combine three submit gates into a single `canSubmit` derived value: (a) amount > 0, (b) sum-of-allocations equals amount (when `mode === "manual"`), (c) follow-up form is either skipped or valid (when overdue remaining is non-empty).
  - [ ] On submit, build the `recordPayment` args:
    ```ts
    {
      contractId,
      amountCents,
      method,
      reference,
      paidAt,
      idempotencyKey,
      allocations: (mode === "manual" ? manualRows : autoRows).map(r => ({
        installmentId: r.installmentId,
        amountCents: r.amountCents,
        allocationKind: mode === "manual" ? "manual_override" : "auto_oldest",
      })),
      followUpAction: (overdueRemaining.length > 0 && !followUp.skipped)
        ? { installmentIds: overdueRemaining.map(i => i._id), reasonText: followUp.reasonText, targetDate: followUp.targetDate }
        : undefined,
      manualOverrideContext: (mode === "manual") ? { autoAllocationSnapshot: autoRows, manualAllocationSnapshot: manualRows } : undefined,
    }
    ```
  - [ ] Keep the ReceiptPreviewModal flow from Story 3.9 unchanged — modal is opened on form submit, mutation runs on modal confirm. The override + follow-up data are bundled into the same mutation call.

### Convex domain — extending `recordPayment` + `postFinancialEvent` (AC4, AC5)

- [ ] **Task 4: Extend `recordPayment` mutation args + handler in `convex/payments.ts`** (**UPDATE**) (AC: 4)
  - [ ] Update the `args` validator to accept the new optional fields:
    ```ts
    args: {
      contractId: v.id("contracts"),
      amountCents: v.number(),
      method: v.union(/* … */),
      reference: v.optional(v.string()),
      paidAt: v.number(),
      idempotencyKey: v.string(),
      allocations: v.array(v.object({
        installmentId: v.id("installments"),
        amountCents: v.number(),
        allocationKind: v.union(v.literal("auto_oldest"), v.literal("manual_override"), v.literal("perpetual_care")),
      })),
      followUpAction: v.optional(v.object({
        installmentIds: v.array(v.id("installments")),
        reasonText: v.string(),
        targetDate: v.number(),
      })),
      manualOverrideContext: v.optional(v.object({
        autoAllocationSnapshot: v.array(/* AllocationRow shape */),
        manualAllocationSnapshot: v.array(/* AllocationRow shape */),
      })),
    },
    ```
  - [ ] Handler order (LOCKED — defense-in-depth + atomicity guarantees):
    1. `await requireRole(ctx, ["office_staff", "admin"])`.
    2. **Server-side allocation sanity:** sum of `allocations[].amountCents` must equal `args.amountCents`. Each `installmentId` must belong to `args.contractId`. Each `amountCents` must be `> 0` and `≤ installment.outstandingCents` (no overpayment per-row in Phase 1). Throw `INVARIANT_VIOLATION` on mismatch — never trust the client's distribution.
    3. **followUpAction validation** (if present): each `installmentId` must belong to the contract, must still be `overdue` after the proposed allocation, `reasonText.length > 0`, `targetDate > Date.now()`.
    4. **Post the financial event:**
       ```ts
       const result = await postFinancialEvent(ctx, {
         kind: "payment",
         contractId: args.contractId,
         amountCents: args.amountCents,
         method: args.method,
         reference: args.reference,
         paidAt: args.paidAt,
         allocations: args.allocations,
         idempotencyKey: args.idempotencyKey,
       });
       ```
    5. **Audit the override** (if `manualOverrideContext` present): call `emitAudit(ctx, { action: "payment.allocate.override", entityType: "payments", entityId: result.paymentId!, before: manualOverrideContext.autoAllocationSnapshot, after: manualOverrideContext.manualAllocationSnapshot, reason: args.followUpAction?.reasonText ?? "(no reason given)", correlationId: result.receiptId })`. Re-use `result.receiptId` as the `correlationId` so the override + follow-up + the cornerstone's own `receipt.issued` audit row all link.
    6. **Insert the follow-up action(s)** (if `args.followUpAction` present): for each `installmentId` in the array, insert a `followUpActions` row via a private helper (NOT `addFollowUpAction` — the public mutation does its own `requireRole`; we want internal composition). Each insert emits its own audit via `emitAudit` with the shared `correlationId`. Story 4.2's `followUpActions` table + indexes are required (hard dependency).
    7. Return `{ receiptId, serialFormatted, contractId, paymentId, followUpActionIds: [...] }`.

- [ ] **Task 5: Verify the cornerstone's `preparePayment` accepts `manual_override` allocations** (**check + UPDATE if needed in `convex/lib/postFinancialEvent.ts`**) (AC: 4)
  - [ ] Story 3.2 Task 1 defined the `AllocationKind` union as `"auto_oldest" | "manual_override" | "down_payment" | "full_payment" | "perpetual_care"`. The discriminated kind is already in the schema; verify `prepareSaleInstallment` / `preparePayment` accept `"manual_override"` rows without special branching (they should — the kind is metadata on the allocation, the math is identical). If branching is missing, add a passthrough.
  - [ ] Add a server-side defensive check inside `preparePayment`: if **any** allocation row has `allocationKind === "manual_override"`, assert that the calling mutation supplied a `manualOverrideContext` payload to the cornerstone — extend the `kind: "payment"` payload type with an optional `overrideContext: { autoSnapshot, manualSnapshot }` field; the cornerstone passes it through to the audit emitter. This makes "manual override was performed" impossible to hide.

- [ ] **Task 6: Create private follow-up helper `convex/lib/followUpAction.ts → insertFollowUpActionInternal`** (**NEW**) (AC: 4, AC: 5)
  - [ ] Story 4.2's `addFollowUpAction` is the public mutation; this helper is the **composition primitive** that bypasses the public mutation's `requireRole` (the caller is already authenticated and authorized in `recordPayment`). Signature:
    ```ts
    export async function insertFollowUpActionInternal(
      ctx: MutationCtx,
      args: { installmentId: Id<"installments">, contractId: Id<"contracts">, reasonText: string, targetDate: number, paymentId: Id<"payments">, correlationId: string, actorId: Id<"users"> }
    ): Promise<Id<"followUpActions">>
    ```
  - [ ] The function inserts the row, emits audit (`action: "followUpAction.add"`, `correlationId` propagated), returns the id. Story 4.2's public `addFollowUpAction` mutation refactors to **also** call this helper internally so the two paths share one code path. Mark this as a Story 4.2 file modification in the dev-agent record.

### Audit (AC5)

- [ ] **Task 7: Extend `emitAudit` action vocabulary** (**UPDATE** `convex/lib/audit.ts`) (AC: 5)
  - [ ] Add `"payment.allocate.override"` to the `auditLog.action` enum (Story 1.6 should have left this open as a string; if it's an enum, extend). Re-run `npx convex dev` to regenerate types.
  - [ ] Verify the redaction helper (Story 1.6's `redactPii`) handles the `before/after` allocation snapshots correctly — these are arrays of `{ installmentId, amountCents, allocationKind }` with no PII; the helper should pass them through unchanged. Add a unit test confirming no false-positive redaction.

### Tests (AC1 – AC5)

- [ ] **Task 8: Component tests for `AllocationEditor`** (**NEW**) (AC: 1, AC: 2)
  - [ ] Create `src/components/PaymentForm/AllocationEditor.test.tsx` (co-located, Vitest + Testing Library):
    - Renders one row per unpaid installment with correct `outstandingCents` displayed.
    - Editing a row's amount fires `onChange` with the updated array.
    - Footer shows red text when sums diverge, emerald when equal.
    - Per-row warning surfaces when amount exceeds outstanding.
    - Keyboard reorder via `ArrowUp` / `ArrowDown` on the drag handle (use `@dnd-kit/utilities` test helpers or simulate via fireEvent).
    - "Reset to default" link triggers `onResetToDefault`.
    - Disabled state: all inputs become read-only.

- [ ] **Task 9: Component tests for `OverdueFollowUpInline`** (**NEW**) (AC: 3)
  - [ ] Create `src/components/PaymentForm/OverdueFollowUpInline.test.tsx`:
    - Hidden when `overdueInstallmentsRemaining` is empty.
    - Shown with default `targetDate = now + 7d` (Manila tz — assert via `formatManilaDate`).
    - Dismiss link sets `skipped: true` and the form's submit is no longer gated by this section.
    - Submitting with empty reasonText surfaces inline error when `skipped === false`.
    - Submitting with `targetDate <= now` surfaces inline error.

- [ ] **Task 10: Convex unit tests — `recordPayment` with override + follow-up** (**UPDATE** `tests/unit/convex/payments.test.ts`) (AC: 4, AC: 5)
  - [ ] Happy path with `manual_override` allocations:
    - Two unpaid installments (#3 overdue ₱4,000, #4 current ₱4,000). Payment ₱4,000 with `manualRows = [{ #4, 4000 }]`. Expected: #4 transitions to `paid`, #3 stays `overdue`, contract balance −₱4,000, audit row `payment.allocate.override` exists with before/after snapshots, no follow-up action row (none supplied).
  - [ ] Override + follow-up bundle:
    - Same setup + `followUpAction: { installmentIds: [#3], reasonText: "Customer requested next-month-first", targetDate: <future> }`. Expected: one `followUpActions` row tied to #3, audit row `followUpAction.add` with shared `correlationId = receipt.id`, the override audit row also shares that `correlationId`.
  - [ ] Sum mismatch:
    - `allocations = [{ #4, 4000 }]` but `amountCents = 5000` → `INVARIANT_VIOLATION`. No writes, no idempotency-row write.
  - [ ] Over-allocate a single installment:
    - #4 outstanding ₱4,000, row says ₱5,000 → `INVARIANT_VIOLATION` (Phase 1 forbids credit-forward).
  - [ ] Follow-up references an installment that is NOT overdue → `INVARIANT_VIOLATION` ("Cannot log a follow-up action on a non-overdue installment").
  - [ ] Office Staff with manual override succeeds; Customer role calling → `FORBIDDEN`.
  - [ ] Idempotency: second call with same key + same payload → same receipt + same payment + same follow-up action ids (no duplicate rows in any table); second call with same key + different `manualRows` → `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`.

- [ ] **Task 11: Playwright spec — Journey 2 manual override** (**UPDATE** or **NEW** `tests/e2e/journey-2-payment-override.spec.ts`) (AC: 1 – AC: 5)
  - [ ] Walks: log in → contract detail → "Record Payment" → enter ₱4,000 → assert default allocation lands on #3 → click "Allocate manually" → redistribute to #4 → assert footer sum turns emerald → assert `OverdueFollowUpInline` appears (because #3 stays overdue) → enter reason + accept default target date → submit → confirm receipt preview → assert: (a) payment row visible on contract page, (b) installment #4 pill flipped to `Paid`, (c) installment #3 pill reads "Overdue · follow-up logged" (Story 4.2 display rule), (d) follow-up note visible in the installment's drill-down.

## Dev Notes

### Previous story intelligence

**Hard dependencies:**

- **Story 3.1 — `receiptCounter`, `allocateNextSerial`.** Consumed via cornerstone.
- **Story 3.2 — `postFinancialEvent` cornerstone.** This story does NOT modify the cornerstone's discriminated-union signature for `kind: "payment"` (allocations are already an array of `{ installmentId, amountCents, allocationKind }`), but it DOES extend the payload with an optional `overrideContext` field so the cornerstone can pass the auto-vs-manual snapshot through to the audit row (Task 5). Mark this Story 3.2 file modification in the dev-agent record.
- **Story 3.9 — `PaymentForm`, `recordPayment` mutation, `computeAutoAllocation` helper, `ReceiptPreviewModal`.** This story EXTENDS the form (new AllocationEditor + inline follow-up section) and the mutation (new args + handler steps). Reuses the modal verbatim.
- **Story 4.2 — `followUpActions` table + `addFollowUpAction` mutation.** Hard dep on the schema. This story bypasses the public mutation by calling the new internal helper (Task 6); Story 4.2's public mutation is refactored to share the same helper. **If Story 4.2 has not landed yet when this story starts, sequence them: 4.2 first, then 3.10.** Story 4.2 is in Epic 4 (sprint plan permitting) — flag this dependency to the SM if Epic 3 lands before Epic 4 in the sprint sequence.
- **Story 1.2 — `requireRole`, `ConvexError` codes.** Task 4 step 1.
- **Story 1.6 — `emitAudit` + `correlationId` support.** Tasks 4, 6, 7.
- **Story 1.7 — state machines.** Installment transitions `overdue → paid` (when an override fully covers an overdue row) and `overdue → partial` (when it partially covers). These transitions are already in Story 1.7's table from Story 3.2's Task 1 schema work — verify, extend if missing.
- **Story 1.4 — design tokens, StatusPill, ReactiveHighlight.** Reused for the AllocationEditor's row warnings + footer sum colors.

**Soft dependencies:**

- **dnd-kit** (`@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`) — if not already installed by an earlier story (e.g. SchedulePreview Task 4 of Story 3.4 didn't need it; the Lot Map in Phase 2 might), **add as runtime deps here** + pin versions in `package.json`. Document in ADR-0008 (new) — "dnd-kit for sortable allocation editor."

### Architecture compliance

- **Single financial-write entry point** (architecture § Architectural Boundaries → Financial-entity write boundary). This story routes manual overrides through `postFinancialEvent` exactly the same as auto-allocated payments. The `allocationKind` field is **metadata**, not a control-flow branch; the cornerstone's math is identical.
- **No direct `ctx.db.insert("paymentAllocations", …)`** in `recordPayment`'s handler — the cornerstone owns those writes. The ESLint rule `no-direct-financial-table-writes` from Story 3.2 enforces this.
- **Audit composition via `correlationId`** (architecture § Audit-log boundary). Story 1.6's `emitAudit` already supports `correlationId`; this story is the first place to **use it** (override + follow-up are sibling rows linked by the receipt id).
- **Atomic multi-row writes** (architecture § API & Communication Patterns → Atomic mutation pattern). The override audit + follow-up insert + audit live inside the same Convex mutation as the cornerstone call. The scheduler-fire-after-commit pattern (Story 3.2 Task 6 step 7) still owns the PDF action; this story doesn't change that.
- **No new state-machine transitions.** Story 1.7's `installments` table already covers `overdue → paid` and `overdue → partial`.

### Library / framework versions

- **dnd-kit** — `@latest` at install time; `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`. Tree-shakeable, ~10kb gzipped. Verify against Phase-1 bundle budget (NFR-P6 < 250KB) — should be comfortably under.
- **No other new deps.** Validation reuses Zod (already on the project); date math reuses `convex/lib/time.ts` Manila helpers.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── payments.ts                              # UPDATE (extend recordPayment args + handler)
│   ├── lib/
│   │   ├── postFinancialEvent.ts                # UPDATE (extend kind: "payment" payload with optional overrideContext; verify manual_override passthrough)
│   │   ├── followUpAction.ts                    # NEW (insertFollowUpActionInternal helper)
│   │   └── audit.ts                             # UPDATE (add "payment.allocate.override" to action vocabulary)
│   └── _generated/                              # regenerated on convex dev
├── src/
│   ├── components/PaymentForm/
│   │   ├── PaymentForm.tsx                      # UPDATE (mount AllocationEditor + OverdueFollowUpInline; combined submit gates)
│   │   ├── AllocationEditor.tsx                 # NEW
│   │   ├── AllocationEditor.test.tsx            # NEW
│   │   ├── OverdueFollowUpInline.tsx            # NEW
│   │   └── OverdueFollowUpInline.test.tsx       # NEW
│   └── lib/
│       └── allocations.ts                       # (no change — Story 3.9 owns computeAutoAllocation)
├── tests/
│   ├── unit/convex/
│   │   └── payments.test.ts                     # UPDATE (override + follow-up cases)
│   └── e2e/
│       └── journey-2-payment-override.spec.ts   # NEW (or UPDATE if Story 3.9 created a base)
├── docs/
│   └── adr/
│       └── 0008-dnd-kit-allocation-editor.md    # NEW (if dnd-kit is first introduced here)
└── package.json                                 # UPDATE (add @dnd-kit/* deps + pin versions if first introduced here)
```

### Testing requirements

- **Coverage target on `convex/lib/followUpAction.ts`** — 100% lines (it's a 25-line helper; trivial to hit).
- **Coverage gate on the override path of `recordPayment`** — NFR-M2 ≥ 90% (financial-touching path). The test cases in Task 10 hit every branch of the new arg validation.
- **The "fail-on-broken-implementation" sanity check from Story 3.2** applies here: deliberately swap `manual_override` for `auto_oldest` in the allocation passthrough and verify Task 10's audit assertion FAILS. Proves the override-tracking test is actually exercising the branch.
- **No new Playwright budget.** Reuse Story 3.9's `journey-2-payment.spec.ts` browser context; Task 11 adds one spec to it.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT submit the manual override and the follow-up action as two separate mutations.** They MUST land inside one Convex mutation (Task 4 step 6 inside the same handler as Task 4 step 4). Two separate mutations would create a window where the payment is recorded but the follow-up is missing — exactly the "silently overdue" anti-state FR35 forbids.
- ❌ **Do NOT trust the client's `allocations` distribution.** Task 4 step 2 re-validates the sum, the per-row ownership, and the per-row ceiling. The UI's gating is a UX nicety; the server's gate is the actual invariant.
- ❌ **Do NOT call `addFollowUpAction` (the public mutation) from inside `recordPayment`.** That would: (a) duplicate `requireRole`, (b) double-emit audit rows, (c) break the `correlationId` chain because the public mutation generates its own. Use the internal helper from Task 6.
- ❌ **Do NOT inline the `followUpAction` row insert** in `recordPayment`. The helper exists so Story 4.2's public mutation and this story's composition share the same code path.
- ❌ **Do NOT show the OverdueFollowUpInline modal-style** (i.e. a Dialog component). It is **inline** per the brief — "no separate modal" (AC3 of the epics doc, restated in this story's AC3). The form stays one screen.
- ❌ **Do NOT pre-fill `reasonText` with placeholder text.** Empty + placeholder attribute only. Pre-filled values get committed by accident.
- ❌ **Do NOT allow `targetDate <= now`.** The follow-up action is forward-looking; a same-day or past date is a UX bug + breaks Story 4.3's `expireFollowUpActions` scheduler logic.
- ❌ **Do NOT use `Array.prototype.sort`** on the allocations array inside the cornerstone — the **client's stated order** is part of the audit trail (the override's "intent"). The cornerstone preserves the array order verbatim. If sorting is needed for per-installment math, do it on a copy.
- ❌ **Do NOT add a "Save as default for this contract" affordance** to the manual editor. Allocation overrides are per-payment, not per-contract; a per-contract default is a different feature.
- ❌ **Do NOT allow drag-and-drop on a touch device without a non-drag keyboard fallback.** dnd-kit has built-in keyboard support; wire it. The architecture's mobile field-worker context (NFR-A4 — 44px tap target) means single-finger taps must be able to reorder via the keyboard-accessible drag-handle button.
- ❌ **Do NOT make the override audit row's `reason` field optional in the audit schema.** Story 1.6 already requires reason; the default value when staff skip the inline prompt is the literal string `"(no reason given)"`, NOT `null` or `undefined`.

### Common LLM-developer mistakes to prevent

- **Recomputing `overdueRemaining` from server-side state instead of the proposed allocation:** the prompt asks "after this payment posts, what will be overdue?" — that's a function of the **proposed** allocation, not the current DB state. The form computes it client-side from `manualRows` (or `autoRows`) + the unpaid-installments query. The server re-validates symmetrically (Task 4 step 3 checks "installment still overdue after allocation").
- **Forgetting the `correlationId` on the second audit row:** Task 4 step 6 emits one audit per follow-up insert; each MUST include `correlationId: result.receiptId`. The override audit row (step 5) also uses that id. Without the correlation, the audit log can't reconstruct the override+action pair.
- **Wiring the editor as a controlled component without memoizing the `value` array:** every keystroke would re-render every row. Use `React.useMemo` on the rows array keyed by `(paymentAmountCents, manualRowsJsonHash)` and `React.useCallback` for the onChange handlers.
- **Mixing `installmentId` (id) with `sequence` (display number):** users see "#3" but the data references `installmentId`. The row UI shows `#${installment.sequence}`; the persisted allocation uses `installmentId`. Don't conflate.
- **Letting the AllocationEditor's drag re-numbering affect the cornerstone's math:** drag-order is metadata-only (audit trail). The cornerstone allocates against the `installmentId`s in whatever order it iterates; the per-installment amounts are deterministic regardless of array order. Test Task 10's "same allocations in different order → same result" case.
- **Showing the inline follow-up prompt for installments that were `paid` before this payment:** the prompt is for **remaining overdue** after the proposed allocation; an installment that was already `paid` is not in scope. The reactive computation filters to `state === "overdue" && remainingAfterAllocation > 0`.
- **Confusing `skipped: true` with "form was never shown":** the auditLog's `before/after` snapshot for the override row should include `followUpPromptShown: true, followUpSkipped: <bool>` so we can later answer "did we ever show staff the prompt and they declined?" — a real compliance question Mr. Reyes will ask.

### Open questions / blockers this story does NOT resolve

- **§10 Q1 (installment policy) — no impact here.** Override semantics are policy-neutral.
- **§10 Q3 (BIR receipt modality) — no impact.** This story does not change the receipt format or the PDF action; it changes the allocation that feeds the receipt's "applied to:" lines.
- **Credit-forward overpayment** (Story 3.2 Task 9 strict-fail decision) — this story stays strict-fail. If a future story flips to "credit" semantics, the AllocationEditor's per-row overpayment warning becomes a non-blocking notice and a new `allocationKind: "credit"` row appears. Track in `docs/adr/0006-postFinancialEvent-pattern.md`'s addendum log.

### Project-specific environment values

No new env vars. dnd-kit needs no configuration.

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure & Boundaries](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries) — `src/components/PaymentForm/` is the Journey 2 component home (architecture line 761).
- [Architecture § Audit-log boundary](../../_bmad-output/planning-artifacts/architecture.md#architectural-boundaries) — composition pattern (helper + audit per write) preserved.
- [Architecture § API & Communication Patterns > Atomic mutation pattern](../../_bmad-output/planning-artifacts/architecture.md#api--communication-patterns) — override + follow-up land in one mutation.

No detected conflicts with the planned tree.

### References

- [PRD § FR27 (manual allocation override)](../../_bmad-output/planning-artifacts/prd.md#5-payments--bir-receipts)
- [PRD § FR35 (logged follow-up actions)](../../_bmad-output/planning-artifacts/prd.md#6-ar-aging-collections--expenses)
- [Architecture § Architectural Boundaries](../../_bmad-output/planning-artifacts/architecture.md#architectural-boundaries)
- [Architecture § Pattern Examples > Good payment posting](../../_bmad-output/planning-artifacts/architecture.md#pattern-examples)
- [UX § Journey 2 — Payment with manual allocation override](../../_bmad-output/planning-artifacts/ux-design-specification.md#defining-experience) (lines 661–700: allocation preview, "Allocate manually" expansion, inline overdue-with-action prompt)
- [Epics § Story 3.10](../../_bmad-output/planning-artifacts/epics.md#story-310-office-staff-overrides-default-allocation)
- Previous story dependencies: [Story 3.1](./3-1-receipt-counter-with-optimistic-concurrent-serial-allocation.md), [Story 3.2](./3-2-postfinancialevent-cornerstone.md), [Story 3.9 — `PaymentForm` + `recordPayment`], [Story 4.2 — `followUpActions` table + `addFollowUpAction`](./4-2-office-staff-attaches-logged-follow-up-actions-to-overdue-installments.md), [Stories 1.2, 1.4, 1.6, 1.7]
- dnd-kit docs (verify current): https://dndkit.com/

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (claude-opus-4-7) — autonomous dev pass under the bmad-dev-story skill.

### Debug Log References

- `npm run typecheck` — clean (0 errors).
- `npm run lint` — clean ("No ESLint warnings or errors").
- `npx vitest run` (full suite) — 1953 passing, 1 skipped, 0 failing.
- `npx vitest run tests/unit/convex/payments-custom-allocation.test.ts tests/unit/components/PaymentForm-custom.test.tsx` — 43 passing across the two new files.
- `npm run build` — clean (Next.js production build + `build:sw` PWA bundle, no errors).

### Completion Notes List

This dev pass implemented a **narrowed slice** of Story 3.10's scope, scoped down by the orchestrator brief to the cornerstone of FR27 (the manual-override path) without the inline follow-up-action capture (AC3 + Task 2 + Task 6 + Task 7), the dnd-kit drag-reorder UX (Task 1 dnd-kit work), and the e2e Playwright spec (Task 11). The shipped surface is:

- A new public mutation `recordPaymentWithCustomAllocation` in `convex/payments.ts` that mirrors `recordPaymentWithAutoAllocation` (Story 3.9) — same auth gate, validation order, cornerstone routing, installment patches, contract auto-close — but replaces the FIFO walk with a caller-supplied `allocations: Array<{ installmentId, amountCents }>` array. Server-side defenses re-validate every invariant the UI gates: sum-equals-amount (ALLOCATION_SUM_MISMATCH), per-row ceiling vs. outstanding balance (INVARIANT_VIOLATION), no targeting paid/waived rows, no duplicate `installmentId`, contract belongs-check, empty/zero-only array rejection.
- A new pure helper `validateCustomAllocation` in `src/components/PaymentForm/allocation.ts` that powers the form's submit gate. Returns a discriminated `ok` + `rowErrors` + `formErrors` + `remainderCents` shape so the form can drive per-row warnings and the global sum-mismatch banner independently.
- A "Custom allocation" toggle + editable per-row table appended to `PaymentForm.tsx`. Toggle-on seeds the inputs from the FIFO default (so the staff *redistributes* rather than starts blank — directly addressing the "common LLM-developer mistake" in Dev Notes about a blank-slate manual editor). Submit dispatches to the new mutation when the toggle is on; the existing auto path remains the default. Submit stays disabled until `validateCustomAllocation().ok === true`.

(a) **dnd-kit drag-reorder UX (Task 1) was NOT introduced this pass.** No new runtime deps were added; the orchestrator brief scoped the editor to plain editable rows. ADR-0008 was not created — defer to a future story if the drag-order audit-trail intent is reintroduced.

(b) **`insertFollowUpActionInternal` (Task 6) was NOT created.** The orchestrator's allowed-file set explicitly locked `convex/lib/**` as READ-ONLY and excluded other `convex/**/*.ts` files. The inline OverdueFollowUpInline UX (AC3) + the audit override semantics (AC5) + the `convex/lib/audit.ts` extension (Task 7) are correspondingly absent. A follow-up story should pick these up against Story 4.2's `followUpActions` table once both 4.2 and 3.10's UI surface are ready to be composed together.

(c) **No deviation from the locked handler order** in `recordPaymentWithCustomAllocation`: auth → scalar validation → per-row scalar validation + sum check → contract load + state gate → installment schedule load → per-row server-side validation against schedule → cornerstone post → installment patches → contract auto-close transition.

(d) **`correlationId` was NOT wired in this pass** because Task 5/Task 7's `manual_override` allocationKind metadata + the `overrideContext` cornerstone payload extension were out of scope (cornerstone is READ-ONLY per the brief). The audit row the cornerstone already emits for the receipt covers the financial event; the override-vs-auto distinction in the audit log is a future enhancement when the cornerstone payload is extended.

(e) **Multi-overdue-installments UX iteration (AC3) was NOT exercised** — the OverdueFollowUpInline component is not in scope this pass.

### File List

Modified:
- `convex/payments.ts` — appended `CustomAllocationRow`, `RecordPaymentWithCustomAllocationArgs`, and the `recordPaymentWithCustomAllocation` mutation (handler order locked + commented).
- `src/components/PaymentForm/allocation.ts` — appended `CustomAllocationRow`, `CustomAllocationValidationResult`, and the `validateCustomAllocation` pure helper.
- `src/components/PaymentForm/PaymentForm.tsx` — appended the "Custom allocation" toggle, the per-row editable rows section (with per-row error slots + sum-mismatch banner), the seed-from-FIFO toggle behavior, the dispatcher branching between the auto and custom mutations on commit.
- `_bmad-output/implementation-artifacts/3-10-office-staff-overrides-default-allocation.md` — status: review + this Dev Agent Record.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `3-10-office-staff-overrides-default-allocation: review`; `last_updated: 2026-05-18`.

Created:
- `tests/unit/convex/payments-custom-allocation.test.ts` — 25 cases (happy path, multi-row split, zero-row drop, reference trim, contract auto-close, all validation branches, contract state gates, auth, idempotency same/different payload).
- `tests/unit/components/PaymentForm-custom.test.tsx` — 18 cases (`validateCustomAllocation` exhaustive cases + toggle rendering + seed from FIFO + submit gating + per-row warnings + mutation dispatcher routing).
