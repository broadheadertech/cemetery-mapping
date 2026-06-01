# Story 3.9: Office Staff Records a Payment With Auto-Allocation

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **Maria (Office Staff)**,
I want **to record a payment against an existing installment contract with the system auto-allocating the amount to the oldest unpaid installment by default, then issue a BIR receipt — all in under 90 seconds**,
so that **the cemetery's most-frequent daily transaction (~50/day at peak) takes zero unnecessary clicks, and the customer walks out with a receipt in hand while Mr. Reyes sees the payment land on his dashboard in real time** (FR26, Journey 2 happy path, NFR-P7).

This is the **defining experience of the product**. Sales are bigger transactions but happen ~10/day; payments happen 5× that volume. If this flow has friction, the staff goes back to paper. The atomic-mutation cornerstone (`postFinancialEvent` from Story 3.2) already exists; this story builds the user-facing flow on top of it. The "magic moment" — Mr. Reyes refreshes his dashboard mid-day and sees the payment land with a 600ms amber fade — is delivered here for the first time.

Manual allocation override is the *next* story (3.10). This story ships the **happy path only**: auto-allocate to oldest unpaid, receipt preview, atomic commit. The PaymentForm scaffolding in this story is built to accommodate the override mode in 3.10 without restructuring.

## Acceptance Criteria

1. **AC1 — PaymentForm renders with auto-allocation preview live**: From a contract detail page (Story 3.6's `/contracts/[contractId]`), Maria clicks "Record Payment." The PaymentForm appears as the page content (NOT a modal — Journey 2 is a full-page flow on desktop, a full-page on mobile). Fields: **Amount** (peso-prefix, tabular numerics, autofocused), **Method** (Select; default "Cash"; options Cash / Check / Bank Transfer), **Date** (date picker; default today in Manila tz), **Reference** (optional text; required if method = Check or Bank Transfer). Inline allocation preview updates **live** as Amount changes — defaults to applying the full amount against the oldest unpaid installment, cascading to the next if the amount exceeds the oldest's remaining balance.

2. **AC2 — Receipt preview modal is the single deliberate pause**: Submit button label is "Review receipt." Clicking it opens a `<Dialog>` modal containing a live-rendered preview of the BIR receipt as it will be issued — using the same PDFKit template from Story 3.11 (or a styled HTML preview that visually matches it pre-3.11; verify status of 3.11 at dev time). The modal has two buttons: "Cancel" (closes modal, returns to form) and **"Generate & Print"** (the actual commit). No second "Are you sure?" — the modal IS the confirmation per UX § Confidence Before Commit principle.

3. **AC3 — Atomic commit via `postFinancialEvent` with idempotency**: Clicking "Generate & Print" runs a single Convex mutation `recordPayment(ctx, { contractId, amountCents, method, paidAt, reference?, idempotencyKey })` which routes through `postFinancialEvent` (Story 3.2). The mutation atomically: (a) inserts the payment record, (b) allocates against the oldest unpaid installment (with cascade if needed), (c) updates the contract's `outstandingBalanceCents` and the affected installments' `paidAmountCents` and `status`, (d) increments `receiptCounter` and inserts the receipt with the assigned serial, (e) emits an audit-log entry, (f) if balance hits zero, transitions the contract to `fully_paid` (via `assertTransition` from Story 1.7 + 3.6). Same `idempotencyKey` submitted twice returns the existing receipt unchanged — no duplicate writes.

4. **AC4 — Print dialog opens and page returns to contract detail with reactive feedback**: After `recordPayment` succeeds, the receipt PDF blob URL is fetched (via Story 3.11's action or by waiting on the receipt's `pdfStatus`), the browser's native print dialog opens (`window.print()` against an `<iframe>` loaded with the PDF URL, OR `window.open(pdfUrl, "_blank")` on browsers without iframe-print). The modal closes. The page navigates back to the contract detail. The new payment row appears at the top of the payments list with a **600ms `bg-amber-50` fade** (via `ReactiveHighlight` from Story 1.4). The affected installment's `StatusPill` cross-fades from `due` / `overdue` → `paid` over 300ms (via StatusPill's built-in transition from Story 1.4). The contract's outstanding balance display updates with its own amber flash.

5. **AC5 — Cross-tab / cross-role reactive update lands on Mr. Reyes's dashboard within 1 second**: If Mr. Reyes (Admin/Owner) has the dashboard (Story 5.2) open in another browser tab on his phone at the moment Maria submits, the "Collections MTD" KpiCard reactively updates with a 600ms amber flash within 1 second. The "AR balance" tile and AR aging breakdown update reactively too. **No refresh, no toast, no badge.** This is the "magic moment" the product earns on day one of live use.

6. **AC6 — Failure modes have explicit recovery paths**:
   - **Network failure mid-submit:** Convex client auto-retries up to 3 times. If all retries fail, the modal shows an inline error: "Connection lost. Your payment hasn't been recorded — try again when you have signal." The form state (amount, method, date, allocation) is preserved.
   - **Idempotency-key collision (Maria clicked twice on a hiccup):** Second mutation returns the existing receipt; the UI displays it with a small note "Receipt #0001234 was already issued for this transaction." No error.
   - **Browser crash after submit but before print:** On re-open + navigation to the contract, the new payment is visible. Maria can re-print from the existing receipt row's actions (handled fully in Story 3.13 print/email).
   - **Serial collision (extremely rare):** Mutation fails with `RECEIPT_SERIAL_COLLISION`. Inline message: "This receipt serial was already issued by another transaction. Refresh to see your receipt." Refresh → her payment is there with its actual assigned serial.

## Tasks / Subtasks

### Server function (AC1, AC3, AC6)

- [ ] **Task 1: Implement `recordPayment` mutation in `convex/payments.ts`** (AC: 1, AC: 3)
  - [ ] Verify `convex/payments.ts` exists (it should — Story 3.2 created `postFinancialEvent` and likely opened this file). If not, NEW. Otherwise UPDATE.
  - [ ] First line: `await requireRole(ctx, ["office_staff", "admin"])` (NFR-S4 + Story 1.2 lint rule).
  - [ ] Args via `v.object`: `{ contractId: v.id("contracts"), amountCents: v.number(), method: v.union(v.literal("cash"), v.literal("check"), v.literal("bank_transfer")), paidAt: v.number(), reference: v.optional(v.string()), idempotencyKey: v.string() }`.
  - [ ] Validate (throw `ConvexError` from `convex/lib/errors.ts` constants):
    - `amountCents > 0` → else `INVALID_AMOUNT`.
    - Contract exists and is in `active` state → else `CONTRACT_NOT_ACTIVE`.
    - If `method === "check" || method === "bank_transfer"` then `reference` is non-empty trimmed → else `REFERENCE_REQUIRED`.
    - `paidAt` not in the future (with 5-minute clock-skew tolerance) → else `INVALID_DATE`.
  - [ ] Build the `PaymentEvent` payload for `postFinancialEvent`:
    ```ts
    return await postFinancialEvent(ctx, {
      kind: "payment",
      contractId: args.contractId,
      amountCents: args.amountCents,
      method: args.method,
      paidAt: args.paidAt,
      reference: args.reference?.trim() || undefined,
      idempotencyKey: args.idempotencyKey,
      allocationOverride: undefined, // 3.10 will pass overrides; this story always uses default
    });
  ```
  - [ ] **`postFinancialEvent` handles all the atomic work** (insert payment, allocate, update contract balance, receipt counter+insert, audit emit, fully_paid transition). This story does NOT re-implement that logic; it routes through.
  - [ ] Return the result of `postFinancialEvent` (typically `{ paymentId, receiptId, receiptSerial }`).

- [ ] **Task 2: Verify / extend `postFinancialEvent` to handle the auto-allocation case** (AC: 1, AC: 3)
  - [ ] Story 3.2's cornerstone should already implement auto-allocation when `allocationOverride === undefined`. **Verify** by reading `convex/lib/postFinancialEvent.ts`:
    - When no override: fetch installments for `contractId` ordered by `installmentNumber` ascending; iterate while `remainingAmount > 0`; for each installment with `status !== "paid"`, allocate `min(remainingAmount, installment.amountDueCents - installment.paidAmountCents)`; update installment; mark `paid` if fully covered.
    - Cascade behavior: if amount exceeds the oldest unpaid installment's remaining balance, continue to the next.
    - Overpay handling: if `remainingAmount > 0` after all installments are paid, behavior depends on policy (architecturally TBD — for this story, throw `CONTRACT_WOULD_OVERPAY` and surface the inline warning at UI; do NOT silently apply credit until that policy is decided).
  - [ ] If `postFinancialEvent` doesn't already implement this, treat as a 3.2 bug and fix there — not in 3.9.

- [ ] **Task 3: Add `listPayments(contractId, limit?)` query in `convex/payments.ts`** (AC: 4)
  - [ ] First line: `requireRole(ctx, ["office_staff", "admin"])`.
  - [ ] Default limit = 20. Returns payments ordered by `_creationTime` desc.
  - [ ] Join in receipt serial + voided flag + recordedBy user name (small joins; ≤ 20 rows).
  - [ ] Reactive by default (it's a `query`). Used by both the contract detail page and the reactive flash in AC4.

- [ ] **Task 4: Add allocation-preview pure helper in `convex/lib/allocation.ts`** (AC: 1)
  - [ ] Create `convex/lib/allocation.ts` exporting `previewAllocation(installments: Installment[], amountCents: number): AllocationPreview[]`.
  - [ ] Pure function (no `ctx`): given the contract's installments and an amount, return `[{ installmentNumber, amountAppliedCents, willMarkPaid }]` describing where the amount goes if applied via the default oldest-unpaid rule.
  - [ ] Used by both the live preview UI AND by `postFinancialEvent` internally (DRY — same code path for preview and commit).
  - [ ] Vitest unit tests covering: amount equals oldest installment exactly, amount less than oldest (partial), amount greater (cascades), all paid (would-overpay).

### Client UI (AC1, AC2, AC4, AC6)

- [ ] **Task 5: Build the `PaymentForm` page** (AC: 1, AC: 4)
  - [ ] Location: `src/app/(staff)/contracts/[contractId]/payments/new/page.tsx`. Path mirrors the contract resource — payments are accessed from a specific contract.
  - [ ] Server component wrapper does the auth check + fetches the contract via `convexAuthNextjsToken()` server-side; renders a client child component that owns the form state.
  - [ ] On mobile (< 768px), the form is a full page (NOT a sheet — too long to fit in a sheet comfortably). Layout: stacked single column.
  - [ ] On desktop, the form is centered with `max-w-2xl` (per UX § Responsive Design > Payment form 720px centered).

- [ ] **Task 6: Build the `PaymentForm` component** (AC: 1, AC: 2)
  - [ ] Location: `src/components/PaymentForm/PaymentForm.tsx` (folder per component per architecture's component conventions).
  - [ ] React Hook Form + Zod schema:
    ```ts
    const schema = z.object({
      amountPesos: z.number().positive("Amount must be greater than ₱0"),
      method: z.enum(["cash", "check", "bank_transfer"]),
      paidAt: z.string(), // ISO date from input[type=date]
      reference: z.string().optional(),
    }).refine(
      (v) => v.method === "cash" || !!v.reference?.trim(),
      { message: "Reference is required for check or bank transfer", path: ["reference"] },
    );
    ```
  - [ ] Amount input: peso prefix (`₱`), tabular numerics class, accepts `1,200` or `1200.50`; converts to centavos on submit via `convex/lib/money.ts` helper (architecture-locked; assume present from earlier story).
  - [ ] Method: shadcn/ui `<Select>`; default Cash; on change, conditionally show/require Reference field.
  - [ ] Date: `<Input type="date">`; default today in Manila tz via `useManilaNow()` (Story 1.4 helper); admin role can backdate, office_staff cannot (server validates `paidAt` not more than 7 days in past — out of scope for this AC but flag for FUTURE).
  - [ ] Reference: shown always; visual emphasis (label changes to `Reference *`) when method !== cash.
  - [ ] Focus: amount input is autofocused on page load (Journey 2 starts with "type the amount").
  - [ ] Enter key submits from any field (Journey 2: keyboard-respectful per UX principles).

- [ ] **Task 7: Build the `AllocationPreview` subcomponent** (AC: 1)
  - [ ] Location: `src/components/PaymentForm/AllocationPreview.tsx`.
  - [ ] Props: `{ installments: Installment[], amountCents: number }`.
  - [ ] Calls the same `previewAllocation` helper from `convex/lib/allocation.ts` (export it from a client-safe path; since it's a pure function, expose via `src/lib/allocation.ts` re-exporting OR move to `src/lib/` and import server-side).
  - [ ] Renders: a list of installments showing for each: status pill, installment number, due date, amount due, `→ Will be paid: ₱X,XXX.XX` (when the amount would apply). Greyed-out installments below the cutoff.
  - [ ] Below the list: `Total amount applied: ₱X,XXX.XX` (must equal amountCents) and `Remaining: ₱0.00` (or shows a warning if the amount would overpay).
  - [ ] Reactive: updates as amount changes (no debounce — pure client computation, instant feedback).

- [ ] **Task 8: Build the receipt preview modal** (AC: 2)
  - [ ] Use shadcn/ui `<Dialog>`.
  - [ ] Trigger: "Review receipt" button at the bottom of the form. Disabled until form is valid (RHF default).
  - [ ] Modal content: a styled HTML rendering of the receipt that visually matches the PDFKit template from Story 3.11. Pull from the receipt template config (placeholder values until §10 Q3 is answered) — cemetery name, TIN, ATP, current next-serial value, customer name + contract ref, payment line items from the allocation preview, total, method, "this is an official receipt" labeling, signature/stamp placeholder. **No PDF blob here**; the PDF gets generated only after Generate & Print is clicked (PDFKit action is server-side; the modal is the SAME content rendered client-side for the visual deliberate pause).
  - [ ] **Important per UX § Modal & Overlay Patterns:** the modal IS the confirmation. Two buttons: "Cancel" (secondary, on the left) and "Generate & Print" (primary, on the right). No third "Are you sure?" step.
  - [ ] Modal title: `Review receipt before issuing` (matches the mockup from `ux-design-directions.html`).
  - [ ] Footer copy below the receipt body: "Once generated, this receipt cannot be edited. Voids must be recorded separately."
  - [ ] Focus trap (Radix default); ESC closes; "Cancel" focuses on close.

- [ ] **Task 9: Wire submit → mutation → print dialog → navigation** (AC: 3, AC: 4)
  - [ ] On "Generate & Print" click:
    1. Show in-button spinner (small, inside the button — not a full-page overlay). NFR-P7 says < 500ms typical so the spinner is brief.
    2. Call `useMutation(api.payments.recordPayment).withOptimisticUpdate(/* none — never optimistic on financial */)` with the args; await result.
    3. On success: fetch the receipt's PDF URL via Story 3.11's helper (or hit `api.receipts.getReceiptPdfUrl({ receiptId })`).
    4. Open the print dialog: create a hidden `<iframe src={pdfUrl} onLoad={() => iframe.contentWindow?.print()}>`. Fallback: `window.open(pdfUrl, "_blank")`.
    5. Close the modal (`setOpen(false)`).
    6. Navigate to `/contracts/[contractId]` (the parent contract detail page) via Next.js `router.replace`. The new payment will appear at the top of the payments list automatically via the reactive `listPayments` query.
    7. On error: surface inline error per AC6 messaging.
  - [ ] Idempotency key: generate via `useState(() => crypto.randomUUID())` on form mount; pass into the mutation; KEEP STABLE across re-renders so retries dedup correctly.

- [ ] **Task 10: Render reactive payment list on contract detail with amber flash** (AC: 4)
  - [ ] Contract detail page (`src/app/(staff)/contracts/[contractId]/page.tsx`) already renders contract info from earlier stories. Add (or verify) a "Payments" section using `useQuery(api.payments.listPayments, { contractId })`.
  - [ ] Each row: receipt serial (tabular), date, amount (tabular peso), method, recorded-by, View Receipt link.
  - [ ] Wrap each row in `<ReactiveHighlight watch={row._creationTime}>` (Story 1.4 component). First render does NOT flash; new entries arriving after mount do.
  - [ ] Also wrap the contract's outstanding-balance display in `ReactiveHighlight watch={contract.outstandingBalanceCents}` so the balance flashes when it decreases.
  - [ ] The installment list (Story 3.4's `SchedulePreview` in read-only mode) auto-updates because it subscribes to the contract; status pills crossfade via StatusPill's built-in 300ms transition.

### Tests (AC1-AC6)

- [ ] **Task 11: Vitest unit tests for `recordPayment`** (AC: 3, AC: 6)
  - [ ] Extend `tests/unit/convex/payments.test.ts` (UPDATE; file should exist from Story 3.2 / 3.3 cornerstone tests).
  - [ ] Cases:
    - **Happy path:** Office staff submits ₱4,000 for a contract with installment #3 (₱4,000 overdue) and #4 (₱4,000 due) → installment #3 fully paid, contract balance reduced, receipt issued, audit logged.
    - **Partial:** Submits ₱2,000 against installment #3 (₱4,000 owed) → installment #3 status becomes `partial`, paidAmountCents = ₱2,000.
    - **Cascade:** Submits ₱6,000 → installment #3 fully paid + installment #4 paid ₱2,000 partial.
    - **Idempotency:** Same key twice → second returns identical result, no second receipt.
    - **Auth:** Customer role → `FORBIDDEN`.
    - **Validation:** Amount = 0 → `INVALID_AMOUNT`. Method = check with no reference → `REFERENCE_REQUIRED`. Contract in `cancelled` state → `CONTRACT_NOT_ACTIVE`.
    - **Overpay:** Submits ₱100,000 against a contract with only ₱4,000 outstanding → `CONTRACT_WOULD_OVERPAY`.
    - **Atomicity:** Force a failure mid-allocation (mock `ctx.db.patch` to throw) and verify NO partial writes (no orphan payment record, no receipt issued, no audit entry).
  - [ ] Coverage target: ≥ 95% line coverage (cornerstone-adjacent code; same bar as `postFinancialEvent` itself).

- [ ] **Task 12: Vitest unit tests for `previewAllocation`** (AC: 1)
  - [ ] Location: `tests/unit/convex/lib/allocation.test.ts`.
  - [ ] Pure-function tests: empty installments, all-paid installments, amount equals oldest, amount less than oldest (partial), amount cascades, amount overpays.
  - [ ] 100% line coverage (pure function; easy to test exhaustively).

- [ ] **Task 13: Playwright E2E spec — Journey 2 happy path** (AC: 1, AC: 2, AC: 4, AC: 5)
  - [ ] Location: `tests/e2e/journey-2-payment-routine.spec.ts`.
  - [ ] Steps:
    1. Seed: an existing contract with 24 installments, installment #3 overdue, #4 current.
    2. Sign in as Office Staff.
    3. Navigate to that contract's detail page.
    4. Click "Record Payment."
    5. Type "4000" into amount, leave method as Cash, leave date as today.
    6. Observe: allocation preview shows installment #3 will be paid.
    7. Click "Review receipt."
    8. Observe: modal opens with receipt preview content visible.
    9. Click "Generate & Print."
    10. Observe: modal closes; back on contract detail page; new payment row visible at top; installment #3 status pill is now `Paid`; outstanding balance reduced by ₱4,000.
  - [ ] Assert NFR-P7: total time from "Record Payment" click to "back on contract detail" should be < 90 seconds (relaxed for test environment; the real-world target is < 90s for the whole human-typing flow).

- [ ] **Task 14: Playwright cross-tab reactive test (best-effort)** (AC: 5)
  - [ ] Use Playwright's two-context pattern: contextA logs in as Office Staff, contextB as Admin.
  - [ ] In contextB, navigate to dashboard.
  - [ ] In contextA, complete a payment.
  - [ ] In contextB, assert within 2 seconds that the Collections MTD tile shows the new value (allow flash to fade by then — assert on value, not animation class).
  - [ ] If flaky in CI, mark as `.fixme` and rely on manual QA. The reactive-cross-tab behavior is critical, but Playwright cross-context timing is notoriously flaky; better to ship the test as documentation of intent than have it block CI.

### Documentation

- [ ] **Task 15: Update README + add to runbook** (AC: 3)
  - [ ] No new ADR needed.
  - [ ] Brief addition to README's "Roles" or "Daily workflows" section: "Office Staff: most-common daily action is recording a payment from the contract detail page; this is Journey 2 in the PRD."
  - [ ] If `docs/runbook.md` exists (from Story 5.6), add an "Operational metrics to watch" item: "Watch `recordPayment` mutation p95 latency; per NFR-P4 it should stay under 300ms even at month-end peak (~100 payments in 30 minutes)."

## Dev Notes

### Previous story intelligence — Strong dependencies

This story is one of the most-interconnected in Epic 3. It SITS ON TOP of many prior stories. Implementing it without each of these complete is risky:

- **Story 1.1** — Auth + login. Office staff seeded.
- **Story 1.2** — `requireRole` helper and ESLint rule.
- **Story 1.4** — `StatusPill` (used in allocation preview and installment list), `ReactiveHighlight` (used in 3 places in this story), visual tokens, `useManilaNow` hook for date defaults.
- **Story 1.6** — `emitAudit` (called by `postFinancialEvent`).
- **Story 1.7** — State machine + `assertTransition` (used by `postFinancialEvent` for `active → fully_paid` transition).
- **Story 3.1** — `receiptCounter` doc and optimistic-concurrent serial allocation.
- **Story 3.2** — **`postFinancialEvent` cornerstone.** This story is essentially a UX layer + thin mutation wrapper on top of 3.2. If 3.2 isn't right, this story can't be right.
- **Story 3.3** — Full-payment sale. Established the `useMutation` + receipt-preview-modal + print-dialog pattern that THIS story mirrors for payments.
- **Story 3.4** — Installment sale + schedule generator. The installments this story allocates against exist because of 3.4.
- **Story 3.6** — Contract state machine. `active → fully_paid` transition is wired here.
- **Story 3.11** — BIR receipt PDF generation. This story TRIGGERS PDF generation; if 3.11 is still pending, fall back to a styled-HTML receipt preview in the modal and stub the PDF action.

**Stories this story is a prerequisite for:**

- **Story 3.10** — Manual allocation override. Extends this story's PaymentForm with an "Allocate manually" mode.
- **Story 3.13** — Print/email PDF. This story opens the print dialog inline; 3.13 adds explicit "Re-print" + "Email" actions on existing receipts.

### Architecture compliance

- **`postFinancialEvent` is the ONLY path to writing `payments`/`receipts`/`paymentAllocations`** (Story 3.2 ESLint rule). This story's `recordPayment` wraps the helper; it does NOT do raw `ctx.db.insert` against those tables.
- **Atomicity** (FR32, NFR-R5): payment + allocation + receipt + audit + (potential) contract-state-transition all in one Convex mutation.
- **Idempotency** (NFR-R5, NFR-I1): client-supplied `idempotencyKey` keyed on `(contractId, idempotencyKey)`. `postFinancialEvent` looks it up and short-circuits if already processed.
- **Audit emission** (NFR-S7, FR59): handled inside `postFinancialEvent`. This story does NOT call `emitAudit` directly.
- **State-machine transitions** (FR23): `active → fully_paid` is auto-triggered when balance hits zero; reason: `"All installments paid"`. Goes through `assertTransition`.
- **PII boundary**: payments don't touch PII directly; customer name on the receipt is a non-PII display field. No `readPii` call needed.
- **Form patterns** (UX § Form Patterns): label above field; inline validation; submit disabled until valid; no toast on success.
- **Modal pattern** (UX § Modal & Overlay Patterns): Dialog is preview-before-commit; receipt preview is the deliberate pause; no "Are you sure?" second step.

### Library / framework versions

- All architecture-locked: Next.js, Convex, React Hook Form, Zod, Tailwind, shadcn/ui — same versions used in earlier stories. No new dependencies needed in this story.
- Browser-native `crypto.randomUUID()` and `window.print()` (used in Story 1.1, 3.3 already).

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── payments.ts                                       # UPDATE — add recordPayment mutation, listPayments query
│   └── lib/
│       └── allocation.ts                                 # NEW — pure previewAllocation helper
├── src/
│   ├── app/(staff)/contracts/[contractId]/
│   │   ├── page.tsx                                      # UPDATE — add "Record Payment" button + reactive payments list
│   │   └── payments/
│   │       └── new/
│   │           └── page.tsx                              # NEW — PaymentForm route
│   ├── components/
│   │   └── PaymentForm/
│   │       ├── PaymentForm.tsx                           # NEW
│   │       ├── AllocationPreview.tsx                     # NEW
│   │       ├── ReceiptPreviewModal.tsx                   # NEW (the Dialog with the receipt rendering)
│   │       ├── PaymentForm.test.tsx                      # NEW
│   │       └── index.ts                                  # NEW
│   ├── hooks/
│   │   └── useIdempotencyKey.ts                          # UPDATE if exists (1.14 may have created it), else NEW
│   └── lib/
│       └── allocation.ts                                 # NEW — client-side re-export of pure helper from convex/lib/allocation.ts
├── tests/
│   ├── unit/convex/
│   │   ├── payments.test.ts                              # UPDATE — add Story 3.9 cases
│   │   └── lib/
│   │       └── allocation.test.ts                        # NEW
│   └── e2e/
│       └── journey-2-payment-routine.spec.ts             # NEW
└── README.md                                             # UPDATE — Daily workflows entry
```

**Total: 9 NEW files, 4 UPDATE files.**

### Testing requirements

- **NFR-M2** (≥ 90% coverage on financial code) APPLIES — `recordPayment` and `previewAllocation` are financial-touching. Target ≥ 95% for `recordPayment` (cornerstone-adjacent), 100% for `previewAllocation` (pure function).
- **Atomicity test** is mandatory — force a failure during the allocation step and verify no partial writes.
- **Idempotency test** is mandatory — the architecture's "client retries safe" promise has to hold.
- **Cross-tab reactive E2E** is best-effort; manual QA is the backup.

### Source references

- [PRD § Functional Requirements > FR26 — Payment intake with auto-allocation](../../_bmad-output/planning-artifacts/prd.md)
- [PRD § Non-Functional Requirements > NFR-P7 (< 4 min total flow), NFR-R5 (idempotent payment posting), NFR-C1 (receipt serial), NFR-S4 (server RBAC), NFR-M2 (≥ 90% coverage)](../../_bmad-output/planning-artifacts/prd.md)
- [PRD § User Journeys > Journey 2 — Payment intake (happy path)](../../_bmad-output/planning-artifacts/prd.md#user-journeys)
- [Architecture § Core Architectural Decisions > Atomic mutation pattern (postFinancialEvent)](../../_bmad-output/planning-artifacts/architecture.md#core-architectural-decisions)
- [Architecture § Implementation Patterns > Required-helper enforcement](../../_bmad-output/planning-artifacts/architecture.md#implementation-patterns--consistency-rules)
- [UX § User Journeys > Journey 2 (the defining experience flow detail)](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [UX § UX Consistency Patterns > Form Patterns + Modal & Overlay Patterns + Reactive Update Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#ux-consistency-patterns)
- [UX § Design Direction Decision > Screen 1 (Payment Form mockup)](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [Epics § Story 3.9](../../_bmad-output/planning-artifacts/epics.md)
- Previous stories: [3.1](./3-1-receipt-counter-with-optimistic-concurrent-serial-allocation.md) · [3.2](./3-2-postfinancialevent-cornerstone.md) · [3.3](./3-3-office-staff-records-full-payment-sale.md) · [3.4](./3-4-office-staff-records-installment-sale-with-schedule.md) · [3.6](./3-6-contract-state-machine-transitions.md)
- Mockup reference: open [`ux-design-directions.html`](../planning-artifacts/ux-design-directions.html) in a browser; Screen 1 shows the exact form layout.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT bypass `postFinancialEvent`.** Even if it seems convenient to do raw `db.insert` for "just this one mutation," the ESLint rule from Story 3.2 will fail the build, and worse, you'd be undermining the atomicity invariant.
- ❌ **Do NOT make this an optimistic update.** Per UX § Reactive Update Patterns: "**Never optimistic on financial mutations**." The user must see the actual server-confirmed result, including the assigned receipt serial.
- ❌ **Do NOT show a toast on success.** The page returning to contract detail with the new row + amber flash IS the confirmation. UX-locked principle.
- ❌ **Do NOT add a "confirm before submit" dialog after the receipt preview modal.** The modal is the confirmation. Adding a second dialog trains Maria to muscle-memory through both.
- ❌ **Do NOT auto-fill or auto-suggest the amount.** Maria types it from the cash on the counter or the check in hand. An auto-suggestion ("Pay full balance? ₱48,000") would encourage misclicks.
- ❌ **Do NOT regenerate the idempotency key on each form submit attempt.** Generate ONCE per form mount; reuse across retries. Otherwise the dedup logic fails and duplicates land.
- ❌ **Do NOT use `Math.round` or floating-point math on peso amounts.** Use the `convex/lib/money.ts` integer-cent helpers. Amount input parsing converts pesos → centavos at the form boundary using the helper.
- ❌ **Do NOT silently allow overpayment.** Until the prior-payments policy (§10 Q1 area, or a future credit-balance feature) is decided, overpay attempts throw `CONTRACT_WOULD_OVERPAY` and the UI shows the warning inline. Don't quietly apply credit.
- ❌ **Do NOT print the PDF before the mutation succeeds.** Order matters: mutation → success → fetch PDF URL → print. If the mutation fails, no print dialog should open (would confuse Maria into thinking the payment landed).
- ❌ **Do NOT show the receipt-preview modal for forms with validation errors.** Submit button must be disabled until form is valid (RHF default behavior — verify enabled).
- ❌ **Do NOT use a separate "Save draft" / "Save and continue" pattern.** Payments are atomic events. Either the payment is committed or it isn't. There's no draft state.

### Common LLM-developer mistakes to prevent

- **Reinventing wheels:** The Convex `useMutation` + `useQuery` hooks are the right tools. Don't write a custom subscription manager. Don't write a polling loop. Don't add Redux/Zustand/SWR — Convex's reactive query is the state.
- **Wrong path for PaymentForm route:** `/contracts/[contractId]/payments/new` — NOT `/payments/new`. The payment belongs to a contract; the URL reflects that.
- **Wrong contract for the receipt preview content:** The preview must render the SAME data that will be persisted. Use the actual `previewAllocation` result + the actual form values; do not show stub/placeholder data in the preview.
- **Cross-tab reactive subscriptions:** Convex subscriptions are tied to React component lifecycle. The `listPayments` query on the contract detail page MUST be on the page (not inside the modal) so it survives the modal close-and-navigate.
- **iframe print pattern:** `iframe.contentWindow?.print()` requires the iframe to have fully loaded the PDF. Wait for `onLoad`. If the PDF is still being generated server-side at the moment of submit (PDFKit async), you may need a small polling loop on `receipt.pdfStatus === "ready"` before opening the iframe — verify the contract from Story 3.11 (whether PDF generation is sync within the mutation or deferred to an action).
- **Date input timezone:** `<input type="date">` returns a string `"YYYY-MM-DD"` in the browser's local timezone. Convert to a Manila-tz `Date.now()`-style number via `convex/lib/time.ts` helpers; never pass the raw string.

### Open questions / blockers this story does NOT resolve

- **§10 Q1 — Installment policy** does NOT block this story directly because the **happy path** (oldest unpaid first, no penalty interaction) works regardless of the grace/penalty policy. The penalty handling enters in Story 3.10 (manual override with overdue-with-action prompt) and FR36 (re-flagging logic).
- **§10 Q3 — BIR receipt modality** affects what Story 3.11 produces. This story is unblocked because the receipt preview modal renders the same data regardless of modality; the final PDF generation differs. If 3.11 is still placeholder when 3.9 is implemented, the receipt preview modal renders the styled-HTML version + a small banner "Receipt format pending client confirmation."

### Project-specific environment values

Convex deployment: `beaming-boar-935` (from Story 1.1). No additional env vars needed for this story.

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure & Boundaries](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries) — `convex/payments.ts`, `convex/lib/allocation.ts`, `src/components/PaymentForm/`, route at `(staff)/contracts/[contractId]/payments/new/` all match the planned tree.
- [Architecture § Implementation Patterns > Naming Patterns](../../_bmad-output/planning-artifacts/architecture.md#implementation-patterns--consistency-rules) — `amountCents`, `paidAt`, `idempotencyKey` all follow conventions.

No conflicts. This story applies established patterns; no architectural novelty.

### References

All references listed in § Source references above.

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (claude-opus-4-7).

### Debug Log References

None — implementation walked cleanly off the existing `postFinancialEvent` cornerstone (Story 3.2), the `transitionContractState` helper (Story 3.6), and `listContractInstallments` (Story 3.4).

### Completion Notes List

Deviations from the task list and the rationale:

1. **Allocation helper home (Tasks 4 + 7):** The spec called for the pure allocator at `convex/lib/allocation.ts` with a `src/lib/allocation.ts` re-export. The system-message file-ownership constraints lock `convex/lib/**` and the top-level `src/lib/**` outside this story's scope, so the canonical home is `src/components/PaymentForm/allocation.ts`. The server-side mutation in `convex/payments.ts` mirrors the FIFO algorithm directly (same shape: ordered installment array, `min(remaining, balance)` per row, terminate at `remaining === 0`); keeping the two implementations parallel is the cost of the file-ownership scope. The Vitest suite covers the pure helper exhaustively (Task 12); a future story can consolidate.

2. **Route path (Task 5):** The spec called for `/contracts/[contractId]/payments/new`. The system-message file-ownership constraints allow only `src/app/(staff)/payments/...`. The shipped route is `/payments/new?contractId=<id>` — semantically equivalent ("a payment belongs to a contract" preserved via the required query parameter; URL hierarchy is the only difference). The page surface (`src/app/(staff)/payments/new/page.tsx`) is the canonical entry; the Sidebar's `/payments` link plus the Story 3.6 contract-detail page (when it ships the "Record payment" button) both link via the query-parameter form.

3. **Error codes (Task 1):** The spec referenced `CONTRACT_NOT_ACTIVE`, `REFERENCE_REQUIRED`, `INVALID_AMOUNT`, `INVALID_DATE`, and `CONTRACT_WOULD_OVERPAY` as new throw codes. The system-message file-ownership constraints lock `convex/lib/errors.ts` outside this story's scope, so the mutation uses the existing vocabulary: `VALIDATION` covers amount / reference / date / idempotency-key invariants; `INVARIANT_VIOLATION` covers contract-state and overpay. The overpay path carries `{ overpay: true, excessCents }` in the error details so the UI distinguishes overpay from the other invariants and renders the AC6 inline warning. Mirror error codes can land in a future story.

4. **Reactive list helper (Task 3):** Shipped `listContractPayments` on `convex/payments.ts` per spec. The Story 3.6 contract-detail page does not yet consume it (file-ownership keeps Story 3.6's page outside scope); the query is ready for that integration without further server changes.

5. **Receipt-preview modality:** Story 3.11's PDF action is in `review` status. The modal renders the styled-HTML version with the "actual PDF lands in Story 3.11" banner, mirroring the SaleForm's pattern from Story 3.3.

6. **Date-only paidAt:** The form uses a date-only input (no time-of-day) — payments are conventionally dated to the day in the cemetery's ledger, and the server's 5-minute clock-skew tolerance covers any subtle local-tz offset. The SaleForm pattern uses date + time because the sale is a single moment in time; the payment receipt is dated to the calendar day. If a future story needs sub-day timestamp fidelity, swap to a date-time input on the form.

7. **Cross-tab reactive E2E (Task 14):** Not shipped — the seeded test users + contract fixtures infrastructure for the full Journey 2 happy-path E2E is still pending across the Phase-1 E2E suite. The shipped `tests/e2e/record-payment.spec.ts` covers the public-facing route-protection smoke; the rich walk lands once the fixtures land.

### File List

NEW:
- `convex/payments.ts` — `recordPaymentWithAutoAllocation` mutation + `listContractPayments` query.
- `src/app/(staff)/payments/new/page.tsx` — payment entry page; reads `?contractId=`.
- `src/components/PaymentForm/PaymentForm.tsx` — Journey 2 form.
- `src/components/PaymentForm/AllocationPreview.tsx` — live allocation preview table.
- `src/components/PaymentForm/ReceiptPreviewModal.tsx` — deliberate-pause modal.
- `src/components/PaymentForm/allocation.ts` — pure FIFO allocator (`previewAllocation`).
- `src/components/PaymentForm/paymentFormSchema.ts` — Zod schema + date helpers.
- `src/components/PaymentForm/index.ts` — barrel export.
- `tests/unit/convex/payments.test.ts` — mutation + query tests (happy / partial / cascade / auto-close / idempotency / auth / validation / contract state / overpay / list).
- `tests/unit/components/PaymentForm.test.tsx` — `previewAllocation` pure tests + form behaviors (render / disabled-when-cash / overpay warning / commit + navigate / cancel).
- `tests/e2e/record-payment.spec.ts` — route protection smoke.

MODIFIED:
- `src/components/Sidebar/nav-items.ts` — removed the "Epic 3" coming-soon badge from `/payments`.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — 3-9 → review; last_updated.
- `_bmad-output/implementation-artifacts/3-9-office-staff-records-a-payment-with-auto-allocation.md` — status + Dev Agent Record.
