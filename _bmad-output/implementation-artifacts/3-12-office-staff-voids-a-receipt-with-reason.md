# Story 3.12: Office Staff Voids a Receipt with Reason

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an **Admin** (and only an Admin),
I want **to void a receipt by selecting a reason category and supplying free-text explanation — with the void posting through `postFinancialEvent({ kind: "void_receipt" })`, the original serial staying consumed (not re-issued), a companion `voidedReceipts` audit record being created, the underlying payment being flagged voided (not deleted), the contract balance being reversed via a compensating credit, and the receipt PDF being regenerated with a "VOIDED" watermark**,
so that **erroneous receipts can be voided per BIR requirements (FR29) while preserving the audit trail and the FR31 immutability invariant — a void is a NEW record, never a deletion or a mutation of history**.

This story implements the UI + the new `voidedReceipts` companion table + the void path inside the cornerstone (Story 3.2 Task 10 prepared the `prepareVoidReceipt` skeleton; this story completes it) + the VOIDED-watermark variant of `renderReceiptPdf` (Story 3.11's layout helper). It is a **compliance-critical** story: voiding a receipt is one of two operations a BIR examiner will scrutinize (the other is the issuance). The audit trail must be unambiguous about who voided what, when, and why, and the original receipt's data must remain intact for retrieval.

**FR31 immutability is the load-bearing invariant of this story.** Voids do not delete anything. Voids are new records that mark old records as compensated. The original payment row stays in `payments`; its `isVoided` flag flips to `true` and a `voidedAt` / `voidReason` are stamped on it, but its `amountCents` and every other financial field are untouched. The original receipt's `serial` is forever consumed. The compensating credit (the balance reversal) is recorded as its own `paymentAllocations` row with `allocationKind: "void_compensation"`, NOT as a negative-amount allocation against the original payment.

## Acceptance Criteria

1. **AC1 — Admin-only void Dialog opens from receipt detail with required reason fields**: on `/receipts/[receiptId]` (Story 3.13's `ReceiptViewer` route) or the contract detail's per-payment row, an Admin sees a **"Void receipt"** button (red-bordered, ghost variant). Clicking opens a `Dialog` with: (a) a **required** reason-category radio group with the values `"data_entry_error"`, `"customer_dispute"`, `"cancelled_transaction"`, `"duplicate_payment"`, `"other"`; (b) a **required** free-text explanation textarea (3 rows max, max 1000 chars, min 10 chars trimmed); (c) a read-only summary of the receipt being voided (serial, customer, amount, date) so the Admin sees what they are about to void. Office Staff and Field Worker roles see no button. The Dialog's primary action button reads **"Void receipt"** (red destructive); secondary is **"Cancel"** (modal closes, no changes). Submit is disabled until both fields are valid.

2. **AC2 — Void mutation routes through `postFinancialEvent({ kind: "void_receipt" })` and creates a `voidedReceipts` companion record**: `voidReceipt` mutation in `convex/receipts.ts` calls `postFinancialEvent` with the discriminated `kind: "void_receipt"` payload (Story 3.2 Task 5/10 already defined this kind). The cornerstone's `prepareVoidReceipt` (Story 3.2 Task 10): patches `receipts.{ isVoided: true, voidedAt, voidReason }` (the reason is the **category** value; the free-text explanation goes onto the companion record per AC3); patches `payments.{ isVoided: true, voidedAt, voidReason }`; writes a **compensating `paymentAllocations` row** with `allocationKind: "void_compensation"` and a **negative** `amountCents` (this is the ONE place in the system where allocations carry negative amounts — locked by an ESLint rule that forbids negative `paymentAllocations.amountCents` outside the `void_compensation` allocation kind); patches `contracts.outstandingBalanceCents` by adding back the voided amount; schedules a new PDFKit render with the watermark; emits audit. **No new serial is allocated** (Story 3.2 Task 6 step 4 already guards: `if (payload.kind !== "void_receipt") { allocateNextSerial(...) }`).

3. **AC3 — `voidedReceipts` companion table records the void as a permanent audit-grade record**: every void inserts a row into a new `voidedReceipts` table (**NEW** in this story) with `{ receiptId, paymentId, contractId, reasonCategory, reasonText, voidedBy: Id<"users">, voidedAt: number, originalSerialFormatted, originalAmountCents, compensatingAllocationId }`. This row is **append-only by ESLint rule** (`no-mutate-voidedReceipts`) — once inserted, no `ctx.db.patch` or `ctx.db.replace` may touch it. The data on this row is a denormalized historical record that survives even if the originating receipt's denormalized fields drift in a future story.

4. **AC4 — Office Staff invocation returns `FORBIDDEN`; UI hides the button**: `voidReceipt` mutation begins with `await requireRole(ctx, ["admin"])` — Office Staff calling it from a crafted client throws `FORBIDDEN`. The UI also hides the "Void receipt" button when `useCurrentUser().role !== "admin"` (defense-in-depth: server enforces, client respects). A Playwright spec exercises both paths — Office Staff seeing the receipt page does NOT see the button; an attempted direct mutation call (via `useMutation`) throws `FORBIDDEN`.

5. **AC5 — PDF regenerates with VOIDED watermark; contract page reflects reversal**: after the cornerstone commits, the scheduled `generateReceiptPdf` action (Story 3.11) re-renders the receipt PDF. Story 3.11's `renderReceiptPdf` is extended in this story to accept an optional `watermark?: "VOIDED"` parameter; when present, an overlay diagonal red "VOIDED" text (60% opacity, large center) is drawn AFTER the normal layout completes. The receipt's PDF in File Storage is **replaced** (the old `pdfStorageId`'s blob is deleted via `ctx.storage.delete()` for storage hygiene; the receipt row's `pdfStorageId` is patched to the new blob). The original-PDF bytes are NOT retained — the void IS the new authoritative artifact. The contract detail page (Story 3.6) reactively updates: the voided payment row is grayed-out with a "VOIDED" pill (per Story 1.4's StatusPill); the outstanding balance returns to the pre-payment value with a 600ms amber flash; if the contract had transitioned to `fully_paid` because of the now-voided payment, it transitions back to `active`.

## Tasks / Subtasks

### Schema + audit-companion table (AC2, AC3)

- [ ] **Task 1: Add `voidedReceipts` table to `convex/schema.ts`** (**UPDATE**) (AC: 3)
  - [ ] Append the new table definition:
    ```ts
    voidedReceipts: defineTable({
      receiptId: v.id("receipts"),
      paymentId: v.id("payments"),
      contractId: v.id("contracts"),
      reasonCategory: v.union(
        v.literal("data_entry_error"),
        v.literal("customer_dispute"),
        v.literal("cancelled_transaction"),
        v.literal("duplicate_payment"),
        v.literal("other"),
      ),
      reasonText: v.string(),                       // free-text explanation; min 10 chars, max 1000
      voidedBy: v.id("users"),
      voidedAt: v.number(),
      originalSerialFormatted: v.string(),          // denormalized — survives downstream drift
      originalAmountCents: v.number(),
      compensatingAllocationId: v.id("paymentAllocations"),
      idempotencyKey: v.string(),                   // mirrors the void mutation's idempotency key
    })
      .index("by_receipt", ["receiptId"])
      .index("by_contract", ["contractId"])
      .index("by_voided_at", ["voidedAt"])
      .index("by_voided_by", ["voidedBy"]),
    ```
  - [ ] Run `npx convex dev`; commit `_generated/`.

- [ ] **Task 2: Extend `paymentAllocations.allocationKind` union with `"void_compensation"`** (**UPDATE** `convex/schema.ts`) (AC: 2)
  - [ ] Story 3.2 Task 1 defined `allocationKind` as `"auto_oldest" | "manual_override" | "down_payment" | "full_payment" | "perpetual_care"`. Add `v.literal("void_compensation")` to the union. Re-run `npx convex dev`.
  - [ ] **A compensating allocation row carries a NEGATIVE `amountCents`** — this is the ONE permitted negative-amount row in the table. Document the exception clearly in the schema's accompanying comment.

- [ ] **Task 3: Extend the `no-direct-financial-table-writes` ESLint rule with a sibling `no-mutate-voidedReceipts` rule** (**UPDATE** `eslint-rules/`) (AC: 3)
  - [ ] Create `eslint-rules/no-mutate-voidedReceipts.js`. Forbidden patterns (in ALL files):
    - `ctx.db.patch(<...>, /* anything */)` where the target id is typed `Id<"voidedReceipts">` (heuristic: the variable holding the id has `voidedReceipt` in its name, or the prior line is a `ctx.db.insert("voidedReceipts", ...)` whose return is captured).
    - `ctx.db.replace(<...>)` on a voidedReceipts id.
    - `ctx.db.delete(<...>)` on a voidedReceipts id.
  - [ ] Error message: `"voidedReceipts rows are append-only by architectural rule. To 'undo' a void requires issuing a new receipt; never mutate the void record."`
  - [ ] Register in `eslint.config.mjs` as `"error"`.
  - [ ] Tests in `tests/unit/convex/lint-rules/no-mutate-voidedReceipts.test.ts` via `RuleTester`.
  - [ ] **Sibling-rule extension for `no-direct-financial-table-writes` (Story 3.2 rule):** add `"voidedReceipts"` to the forbidden-insert-table list — only `convex/lib/postFinancialEvent.ts` may insert into `voidedReceipts`. The cornerstone's `prepareVoidReceipt` is the single insert point.

### Cornerstone extension — `prepareVoidReceipt` completion (AC2, AC5)

- [ ] **Task 4: Complete `prepareVoidReceipt` in `convex/lib/postFinancialEvent.ts`** (**UPDATE**) (AC: 2, AC: 5)
  - [ ] Story 3.2 Task 10 left a partial implementation. This story completes it. The function's full body (run inside the cornerstone's `switch(payload.kind)` dispatch):
    ```ts
    async function prepareVoidReceipt(ctx, payload): Promise<TransactionBundle> {
      // 1. Read + assert
      const receipt = await ctx.db.get(payload.receiptId);
      if (!receipt) throwError(ErrorCode.INVARIANT_VIOLATION, `Receipt ${payload.receiptId} not found.`);
      if (receipt.isVoided) throwError(ErrorCode.INVARIANT_VIOLATION, "Receipt is already voided.");
      const payment = await ctx.db.get(receipt.paymentId);
      if (!payment) throwError(ErrorCode.INVARIANT_VIOLATION, `Payment ${receipt.paymentId} for receipt ${payload.receiptId} missing.`);
      const contract = await ctx.db.get(receipt.contractId);
      if (!contract) throwError(ErrorCode.INVARIANT_VIOLATION, `Contract ${receipt.contractId} missing.`);

      // 2. State-machine transition: receipt issued → voided
      // 3. Contract may transition back from fully_paid → active if this was the closing payment

      // 4. Build the write bundle:
      const compensatingAllocationDraft = {
        paymentId: payment._id,
        contractId: contract._id,
        installmentId: undefined,                  // void compensation doesn't target a specific installment
        amountCents: -receipt.amountCents,         // NEGATIVE: the ONE permitted negative allocation
        allocationKind: "void_compensation" as const,
        note: `Void compensation for receipt ${receipt.serialFormatted}.`,
      };

      const voidedReceiptDraft = {
        receiptId: receipt._id,
        paymentId: payment._id,
        contractId: contract._id,
        reasonCategory: payload.reasonCategory,
        reasonText: payload.reasonText,
        voidedBy: await getCurrentUserIdOrThrow(ctx),
        voidedAt: Date.now(),
        originalSerialFormatted: receipt.serialFormatted,
        originalAmountCents: receipt.amountCents,
        // compensatingAllocationId set after the allocation row is inserted in applyWrites
        idempotencyKey: payload.idempotencyKey,
      };

      return {
        transitions: [
          { entityType: "receipt", id: receipt._id, from: "issued", to: "voided", reason: payload.reasonText },
          ...(contract.state === "fully_paid" ? [{ entityType: "contract", id: contract._id, from: "fully_paid", to: "active", reason: `Void of receipt ${receipt.serialFormatted}` }] : []),
        ],
        writes: {
          patchReceipt: { receiptId: receipt._id, fields: { isVoided: true, voidedAt: Date.now(), voidReason: payload.reasonCategory } },
          patchPayment: { paymentId: payment._id, fields: { isVoided: true, voidedAt: Date.now(), voidReason: payload.reasonCategory } },
          patchContract: { contractId: contract._id, fields: { outstandingBalanceCents: contract.outstandingBalanceCents + receipt.amountCents } },
          insertAllocation: compensatingAllocationDraft,
          insertVoidedReceipt: voidedReceiptDraft,
        },
        auditAction: "receipt.void",
        auditBefore: { receipt: { isVoided: receipt.isVoided }, contract: { outstandingBalanceCents: contract.outstandingBalanceCents, state: contract.state } },
        auditAfter:  { receipt: { isVoided: true },             contract: { outstandingBalanceCents: contract.outstandingBalanceCents + receipt.amountCents, state: contract.state === "fully_paid" ? "active" : contract.state } },
        auditReason: payload.reasonText,
        // returnValue: receipt + payment ids; no new paymentId; no new serial
      };
    }
    ```
  - [ ] **`applyWrites` extension** (the cornerstone's central write executor — Story 3.2 Task 6 step 5): add handling for `insertAllocation` (returns the new id) and `insertVoidedReceipt` (uses the just-returned allocation id as `compensatingAllocationId` before inserting the voidedReceipts row). Order: allocation first → voidedReceipts second → patches last (so the patches see the new rows).
  - [ ] **PDF re-render scheduling:** Story 3.2 Task 6 step 7 (`ctx.scheduler.runAfter(0, internal.actions.generateReceiptPdf.run, { receiptId })`) already runs for ALL `kind`s — confirm that `void_receipt` is NOT in the exclusion list (Story 3.2's stub Task 6 may have excluded it; in this story, voids MUST re-render). Patch the cornerstone if needed.
  - [ ] **Contract state-machine extension:** the transition `fully_paid → active` must exist in `convex/lib/stateMachines.ts`'s contract table (Story 1.7). If absent (probable — Story 1.7 didn't anticipate void-of-final-payment), add it; Mark Story 1.7's file as modified in the dev-agent record. Provide a one-paragraph rationale in the file's accompanying comment.

### Convex domain layer — public `voidReceipt` mutation (AC1, AC2, AC4)

- [ ] **Task 5: Build `convex/receipts.ts → voidReceipt` mutation** (**UPDATE** if 3.11 created the file; otherwise **NEW**) (AC: 1, AC: 2, AC: 4)
  - [ ] Signature:
    ```ts
    export const voidReceipt = mutation({
      args: {
        receiptId: v.id("receipts"),
        reasonCategory: v.union(
          v.literal("data_entry_error"),
          v.literal("customer_dispute"),
          v.literal("cancelled_transaction"),
          v.literal("duplicate_payment"),
          v.literal("other"),
        ),
        reasonText: v.string(),
        idempotencyKey: v.string(),
      },
      handler: async (ctx, args) => {
        await requireRole(ctx, ["admin"]);          // AC4: admin-only

        // Defensive arg validation
        if (args.reasonText.trim().length < 10) {
          throwError(ErrorCode.INVARIANT_VIOLATION, "Void reason must be at least 10 characters.");
        }
        if (args.reasonText.length > 1000) {
          throwError(ErrorCode.INVARIANT_VIOLATION, "Void reason must be 1000 characters or less.");
        }

        const result = await postFinancialEvent(ctx, {
          kind: "void_receipt",
          receiptId: args.receiptId,
          reasonCategory: args.reasonCategory,
          reasonText: args.reasonText,
          idempotencyKey: args.idempotencyKey,
        });
        return { receiptId: result.receiptId, voidedReceiptId: result.voidedReceiptId };
      },
    });
    ```
  - [ ] **Extend `postFinancialEvent`'s return type** (Story 3.2 Task 5/6 result interface) with an optional `voidedReceiptId?: Id<"voidedReceipts">` field. The cornerstone returns the new id for the void-kind path; other kinds return `undefined`. Mark this as a Story 3.2 file modification.

- [ ] **Task 6: Extend the `kind: "void_receipt"` payload type** (**UPDATE** `convex/lib/postFinancialEvent.ts`) (AC: 2)
  - [ ] Story 3.2 Task 5 stubbed the payload as `{ kind: "void_receipt"; receiptId; reasonCategory: string; reasonText: string; idempotencyKey }`. **Tighten** `reasonCategory` to the same `v.union(...)` literal type used in the mutation (Task 5) — copy the discriminated union to a shared type alias in `convex/types/financial.ts`:
    ```ts
    export type VoidReasonCategory =
      | "data_entry_error"
      | "customer_dispute"
      | "cancelled_transaction"
      | "duplicate_payment"
      | "other";
    ```
  - [ ] The cornerstone's `prepareVoidReceipt` uses `payload.reasonCategory` typed as `VoidReasonCategory` and writes it directly to `receipts.voidReason` AND to `voidedReceipts.reasonCategory`. The denormalization is intentional — the receipt's `voidReason` field is for the receipts-list UI quick filter; the `voidedReceipts.reasonCategory` is the audit-grade source of truth.

### PDF — VOIDED watermark variant (AC5)

- [ ] **Task 7: Extend `renderReceiptPdf` in `convex/actions/lib/receiptLayout.ts`** (**UPDATE**) (AC: 5)
  - [ ] Story 3.11 Task 4 created `renderReceiptPdf(doc, data)`. Add an optional `watermark?: "VOIDED"` parameter:
    ```ts
    export function renderReceiptPdf(doc: PDFKit.PDFDocument, data: ReceiptRenderData, options?: { watermark?: "VOIDED" }): void {
      // ...existing layout logic...

      // Watermark overlay — drawn LAST so it sits on top of everything else.
      if (options?.watermark === "VOIDED") {
        doc.save();
        doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
        doc.font("Helvetica-Bold").fontSize(96).fillColor("red").opacity(0.30)
          .text("VOIDED", 0, doc.page.height / 2 - 48, { align: "center", width: doc.page.width });
        doc.restore();
      }
    }
    ```
  - [ ] **Why post-layout overlay, not pre-fill?** A watermark drawn before the content gets overprinted by subsequent text + risks unreadable composition. Last-drawn = on top = visible. PDFKit's `save` / `restore` brackets keep the rotation + opacity isolated.
  - [ ] **The action body in `convex/actions/generateReceiptPdf.ts`** (Story 3.11 Task 5) is **UPDATED** to read the receipt's `isVoided` flag and pass the watermark option when true:
    ```ts
    const buffer = await renderToBuffer((doc) =>
      renderReceiptPdf(doc, data, data.receipt.isVoided ? { watermark: "VOIDED" } : undefined)
    );
    ```
  - [ ] **Storage replacement:** before storing the new PDF, capture the old `pdfStorageId`; after the new `storage.store` succeeds, call `ctx.storage.delete(oldStorageId)` to reclaim space. Wrap the delete in a try/catch — a failed delete is non-fatal (orphan blob; the daily archival sweep cleans these up).

- [ ] **Task 8: Layout unit tests — watermark variant** (**UPDATE** `convex/actions/lib/receiptLayout.test.ts`) (AC: 5)
  - [ ] Render a receipt without watermark → assert `pdf-parse`'s text stream does NOT contain "VOIDED".
  - [ ] Render the same receipt with `watermark: "VOIDED"` → assert the text stream contains "VOIDED" + the receipt's serial (the rest of the layout is preserved).
  - [ ] **Visual-fidelity test (deferred):** capturing the rendered PDF as an image + asserting watermark position + rotation is a Story 9.3 spike (visual regression). Document the deferral.

### UI — `VoidReceiptDialog` + receipt page wiring (AC1, AC4)

- [ ] **Task 9: Build `src/components/ReceiptViewer/VoidReceiptDialog.tsx`** (**NEW**) (AC: 1, AC: 4)
  - [ ] Built on shadcn/ui `Dialog` + React Hook Form + Zod schema.
  - [ ] Form schema:
    ```ts
    const schema = z.object({
      reasonCategory: z.enum(["data_entry_error", "customer_dispute", "cancelled_transaction", "duplicate_payment", "other"], { required_error: "Select a reason category." }),
      reasonText: z.string().trim().min(10, "Explain the void in at least 10 characters.").max(1000, "Keep the explanation under 1000 characters."),
    });
    ```
  - [ ] Dialog content:
    - Title: "Void receipt"
    - Subtitle: "Receipt #{receipt.serialFormatted} · {customer.lastName}, {customer.firstName} · ₱{formatPeso(receipt.amountCents)} · {formatManila(receipt.issuedAt)}"
    - Radio group for `reasonCategory` with the 5 options labeled in plain English ("Data entry error" / "Customer dispute" / "Cancelled transaction" / "Duplicate payment" / "Other").
    - Textarea for `reasonText`. Placeholder: "Why is this receipt being voided?" Character counter below ("0 / 1000").
    - A subtle informational sentence at the bottom of the dialog (NOT a checkbox — voids aren't acknowledgements): "Voiding cannot be undone. The original serial remains consumed and is never re-issued."
    - Footer: `Cancel` (secondary) + `Void receipt` (destructive variant, disabled until form is valid).
  - [ ] On submit: call `useMutation(api.receipts.voidReceipt)` with `{ receiptId, reasonCategory, reasonText, idempotencyKey }`. The idempotency key is generated by `useIdempotencyKey()` on dialog mount (Story 3.9's hook).
  - [ ] On success: close dialog, fire a toast "Receipt {serial} voided. PDF regenerating…" with the receipt page reactive-update doing the rest. On error: keep dialog open, surface inline at the bottom ("Could not void: {error.message}"). `FORBIDDEN` errors are not expected here (the button is hidden for non-admins) but the inline error pattern still applies if the role changes between page load and click.
  - [ ] **Keyboard:** Esc cancels, Enter (when focus is inside a non-textarea) submits, Tab order: radio → textarea → Cancel → Void. Autofocus on the radio group.

- [ ] **Task 10: Wire `VoidReceiptDialog` into the `ReceiptViewer` + contract detail pages** (**UPDATE** Story 3.13's `ReceiptViewer.tsx` and Story 3.6's contract detail page row) (AC: 1, AC: 4)
  - [ ] Add a "Void receipt" button to `ReceiptViewer`'s action bar (next to "Print" / "Email"). Show only when `currentUser.role === "admin"` AND `receipt.isVoided === false`. When voided, the action bar shows the void timestamp + reason category + the admin's name in a banner-style row above the PDF preview (read-only).
  - [ ] On the **contract detail page** (Story 3.6 — payment list rows), each non-voided payment row gets a small "Void" link (admin-only). Same dialog component. After successful void, the row's StatusPill flips to "Voided" (Story 1.4's StatusPill — extend palette in Task 11) and the row is grayed (`text-text-muted`).

- [ ] **Task 11: Extend StatusPill with a `voided` variant** (**UPDATE** `src/components/StatusPill.tsx`) (AC: 5)
  - [ ] Story 1.4 created `StatusPill` with the seven status variants (Available, Reserved, Sold, Occupied, Cancelled, Defaulted, Transferred). Add a `voided` variant:
    - Background `bg-zinc-200`, text `text-zinc-700`, icon `text-zinc-600` (✕ icon), border `border-zinc-500` (outdoor mode).
    - Contrast: ≥ 8:1 (passes AAA via the same calculation method Story 1.4 used). Document in the StatusPill test file.
  - [ ] Add a unit test asserting the `voided` variant renders the correct classes + the icon + the label "Voided."

### Tests (AC1 – AC5)

- [ ] **Task 12: Convex unit tests — `voidReceipt` mutation + cornerstone path** (**UPDATE** `tests/unit/convex/lib/postFinancialEvent.test.ts` + **NEW** `tests/unit/convex/receipts-void.test.ts`) (AC: 2, AC: 3, AC: 4)
  - [ ] Happy path: void a receipt → assert `receipts.isVoided === true`, `payments.isVoided === true`, `voidedReceipts` row inserted with the right denormalized fields, compensating allocation row exists with **negative** amountCents, contract balance reversed, audit row `receipt.void` emitted with `before/after` snapshots, NO new serial allocated (assert `receiptCounter.currentSerial` did NOT advance).
  - [ ] Already-voided receipt → second void attempt throws `INVARIANT_VIOLATION` ("Receipt is already voided.").
  - [ ] Office Staff caller → `FORBIDDEN`.
  - [ ] Contract was `fully_paid` because of the receipt being voided → contract transitions back to `active`; lot stays `sold` for full-payment sales (an ownership transfer happens via a different flow), `reserved` for installment sales. The state-machine transition is in 1.7's table.
  - [ ] Idempotency: second call with same key + same payload → returns same `voidedReceiptId`; no second `voidedReceipts` row; no double-reversal of the contract balance.
  - [ ] Idempotency: second call with same key + different `reasonText` → `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`.
  - [ ] **Critical adversarial test:** modify the test harness so that after the cornerstone's writes commit BUT before the scheduler call fires, the test runner inspects state — assert the `voidedReceipts` row exists + the receipt is voided. Then let the scheduler run; assert the PDF is regenerated with the watermark. Proves the post-commit action does NOT roll back the void if the PDF fails (it just status-tracks).
  - [ ] **Compensating allocation sign test:** assert that `paymentAllocations.amountCents` is **negative** for the void_compensation row. Then deliberately introduce a bug where the cornerstone writes a positive amount and assert the test FAILS. Sanity check on the load-bearing sign convention.

- [ ] **Task 13: Lint-rule tests for `no-mutate-voidedReceipts`** (**NEW** `tests/unit/convex/lint-rules/no-mutate-voidedReceipts.test.ts`) (AC: 3)
  - [ ] RuleTester: valid cases (the cornerstone's insert, reads of voidedReceipts in queries); invalid cases (patch, replace, delete on a voidedReceipts id).

- [ ] **Task 14: Component test — `VoidReceiptDialog`** (**NEW** `src/components/ReceiptViewer/VoidReceiptDialog.test.tsx`) (AC: 1)
  - [ ] Form validation: empty category → submit disabled; reasonText < 10 chars → inline error; > 1000 chars → inline error.
  - [ ] Submit calls the mutation with the right args.
  - [ ] On mutation error, dialog stays open and shows the message.
  - [ ] Esc closes the dialog without firing the mutation.
  - [ ] Autofocus lands on the radio group.

- [ ] **Task 15: Playwright spec — void journey** (**NEW** `tests/e2e/journey-2-void-receipt.spec.ts`) (AC: 1 – AC: 5)
  - [ ] Walks: log in as Admin → navigate to a contract with a posted payment → click "Void" on the payment row → assert dialog opens → choose "Data entry error" + type reason → submit → assert dialog closes, toast appears, payment row's pill is now "Voided" + grayed, outstanding balance has bumped back up with amber flash, contract state may have transitioned back from "Fully Paid" to "Active" (when applicable).
  - [ ] Second walk: log in as Office Staff → navigate to the same contract → assert the "Void" link is NOT visible.
  - [ ] Third walk: open the receipt's PDF (Story 3.13) → assert the rendered PDF contains the VOIDED watermark (use `pdf-parse` against the stored PDF blob fetched via signed URL).

## Dev Notes

### Previous story intelligence

**Hard dependencies:**

- **Story 1.2 — `requireRole`, `ConvexError` codes.** Task 5.
- **Story 1.4 — `StatusPill`.** Extended (Task 11) with `voided` variant.
- **Story 1.6 — `emitAudit`.** Cornerstone emits `action: "receipt.void"`.
- **Story 1.7 — state machines.** This story EXTENDS `convex/lib/stateMachines.ts`:
  - `receipts`: `issued → voided` (Story 3.2 should have included this; verify, add if missing).
  - `contracts`: `fully_paid → active` (NEW — Story 1.7 did not anticipate void-of-final-payment).
- **Story 3.1 — `receiptCounter`.** AC2's "no new serial" depends on Story 3.2 Task 6 step 4 correctly guarding `if (payload.kind !== "void_receipt")` around `allocateNextSerial`. Verify before running tests.
- **Story 3.2 — `postFinancialEvent` cornerstone.** This story completes `prepareVoidReceipt` (Story 3.2 Task 10 left it partial). Extends the result type with `voidedReceiptId?`. Extends `applyWrites` to handle `insertAllocation` + `insertVoidedReceipt` in the right order. **Mark these Story 3.2 file modifications in the dev-agent record.**
- **Story 3.9 — `useIdempotencyKey` hook.** Reused in Task 9.
- **Story 3.11 — `renderReceiptPdf`, `generateReceiptPdf` action, `cemeterySettings.birReceiptConfig`.** This story extends `renderReceiptPdf` (Task 7) and adjusts the action body (Task 7).
- **Story 3.13 — `ReceiptViewer` route + component.** Surfaces the "Void receipt" button (Task 10).

**Soft dependency:**

- **Story 3.6 — contract detail page.** Surfaces the per-payment void link (Task 10). If 3.6 hasn't landed, the contract-detail integration is a TODO — the receipt-page integration (Task 10's `ReceiptViewer`) is sufficient to satisfy the AC1 / AC4 / AC5 requirements.

### Architecture compliance

- **FR31 immutability** (PRD § 495): the load-bearing invariant of this story. Voids are NEW records. No `ctx.db.replace`. Patches are limited to the `isVoided` flag and the `voidedAt` / `voidReason` denormalization. The `voidedReceipts` table is the new authoritative record.
- **Single financial-write entry point** (architecture § Architectural Boundaries): the cornerstone owns all writes to `paymentAllocations` (including the negative-amount void compensation), `voidedReceipts`, and the patches to `receipts` / `payments` / `contracts`. The `voidReceipt` mutation calls `postFinancialEvent` and returns; no direct table writes.
- **Audit-log boundary** (architecture § 869): the cornerstone emits the `receipt.void` audit row. The void Dialog never writes audit directly.
- **State-machine boundary** (architecture § Enforcement Guidelines #6): the `receipts: issued → voided` and `contracts: fully_paid → active` transitions live in `stateMachines.ts`. Inline `if (currentState === "fully_paid") { /* revert */ }` is forbidden.
- **No serial decrement** (PRD § NFR-C1, Story 3.1 AC4): voids do NOT decrement `receiptCounter.currentSerial`. AC2's test asserts this explicitly.

### Library / framework versions

- **No new runtime dependencies.** PDFKit, dnd-kit (if Story 3.10 introduced it), Zod, RHF all already on the project.
- **shadcn/ui Dialog** — already in `src/components/ui/dialog.tsx` from Story 1.5.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                          # UPDATE (add voidedReceipts table; extend allocationKind union)
│   ├── receipts.ts                                        # UPDATE (or NEW if 3.11 didn't) — add voidReceipt mutation
│   ├── types/
│   │   └── financial.ts                                   # UPDATE (add VoidReasonCategory type alias)
│   ├── lib/
│   │   ├── postFinancialEvent.ts                          # UPDATE (complete prepareVoidReceipt; extend applyWrites; extend result type; extend payload type)
│   │   └── stateMachines.ts                               # UPDATE (add receipts.issued → voided; contracts.fully_paid → active)
│   ├── actions/
│   │   ├── generateReceiptPdf.ts                          # UPDATE (pass watermark option when receipt.isVoided)
│   │   └── lib/
│   │       ├── receiptLayout.ts                           # UPDATE (accept watermark option)
│   │       └── receiptLayout.test.ts                      # UPDATE (watermark variant test)
├── eslint-rules/
│   └── no-mutate-voidedReceipts.js                        # NEW
├── eslint.config.mjs                                      # UPDATE (register new rule + extend no-direct-financial-table-writes table list)
├── src/
│   └── components/
│       ├── ReceiptViewer/
│       │   ├── VoidReceiptDialog.tsx                      # NEW
│       │   └── VoidReceiptDialog.test.tsx                 # NEW
│       └── StatusPill.tsx                                 # UPDATE (add "voided" variant)
├── tests/
│   ├── unit/convex/
│   │   ├── receipts-void.test.ts                          # NEW
│   │   ├── lib/postFinancialEvent.test.ts                 # UPDATE (void path tests)
│   │   └── lint-rules/no-mutate-voidedReceipts.test.ts    # NEW
│   └── e2e/
│       └── journey-2-void-receipt.spec.ts                 # NEW
```

### Testing requirements

- **Coverage gates:** the void path inside `convex/lib/postFinancialEvent.ts` falls under the existing ≥ 95% line-coverage gate from Story 3.2. The new branches (Task 4 step 4 the writes/audit/transitions) must keep the file at threshold. Run `npm run test:coverage` after Task 12.
- **The "fail-on-broken-implementation" sanity check** (architecture § Test-enforced):
  - Compensating allocation sign test (Task 12) — flip the sign in the cornerstone, verify the test fails.
  - "No new serial on void" test (already in Story 3.2's Task 16; this story adds a void-specific variant under `receipts-void.test.ts`).
- **Playwright budget:** one new spec (`journey-2-void-receipt.spec.ts`). The existing Journey 1 + Journey 2 specs are unaffected.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT delete the original receipt or the original payment.** FR31 immutability. The data stays in place; flags flip; new compensating rows are inserted.
- ❌ **Do NOT decrement `receiptCounter.currentSerial`.** Story 3.1 AC4 forbids it; this story exercises Story 3.2's `void_receipt` exception path that explicitly skips allocation.
- ❌ **Do NOT re-issue the voided serial to a future receipt.** The serial is forever consumed. The receipt's row remains in `receipts` with `isVoided: true`; the counter has already moved past it.
- ❌ **Do NOT update the existing `paymentAllocations` rows of the voided payment.** The compensating allocation is a NEW row with a NEGATIVE amount. The original allocation rows stay intact (their `amountCents` is unchanged; only the parent payment's `isVoided` flag flipped).
- ❌ **Do NOT skip the `compensatingAllocationId` reference on the `voidedReceipts` row.** That id is the forensic link from the void record back to the balance reversal. Without it, a future audit cannot reconstruct "how did the balance change as a result of this void?"
- ❌ **Do NOT issue a void from a non-admin role at the server.** The `requireRole(ctx, ["admin"])` is the second line of defense; the UI hides the button (first line). Both must hold.
- ❌ **Do NOT let the void Dialog submit without an idempotency key.** Generate via `useIdempotencyKey()` on mount. A double-click on the destructive button must dedupe at the cornerstone.
- ❌ **Do NOT include the original payment row in the void's audit `before/after` allocation snapshot in a way that makes it look like the payment was deleted.** The `before` shows the original state; the `after` shows the flagged state. Reviewers must see "the payment is still there, now marked voided" — not "the payment was deleted."
- ❌ **Do NOT keep the original PDF blob after a void.** Task 7's `ctx.storage.delete(oldStorageId)` removes it. The voided PDF (with watermark) is the new authoritative artifact. If someone needs to re-verify the original (pre-void) appearance, the templateSnapshot + the audit log's before/after suffice.
- ❌ **Do NOT add a "Restore voided receipt" button.** Voids are one-way. If a void was mistaken, the recovery is to issue a NEW receipt for the same transaction — a fresh serial, fresh PDF — and document the correction in the contract's activity log.
- ❌ **Do NOT include PII in the void Dialog's read-only summary beyond "last name, first name."** No gov ID, no DOB, no address. The summary's job is to confirm the right receipt is being voided; full PII is unnecessary.
- ❌ **Do NOT pass `reasonText` through `JSON.stringify` into the audit row's `reason` field.** The audit helper (Story 1.6) takes a plain string. Pass `payload.reasonText` directly.
- ❌ **Do NOT allow `reasonText` shorter than 10 characters or longer than 1000.** AC1 spec; the mutation validates server-side too (Task 5).
- ❌ **Do NOT make the void mutation an `internalMutation`.** It must be a public `mutation` so the client can call it directly via `useMutation`. The `requireRole` guard handles the authorization.

### Common LLM-developer mistakes to prevent

- **Treating the void as a "delete":** `ctx.db.delete(receiptId)` is the wrong instinct. The correct mental model is "voiding is issuing a compensating record." Reread FR31 if tempted.
- **Computing the contract-balance reversal as `-receipt.amountCents` instead of `+receipt.amountCents`:** the outstanding balance went DOWN when the payment posted (e.g. ₱100,000 → ₱96,000 after a ₱4,000 payment). Voiding REVERSES the payment, so the balance goes back UP (₱96,000 + ₱4,000 = ₱100,000). The patch is `outstandingBalanceCents: contract.outstandingBalanceCents + receipt.amountCents`. The compensating allocation row's `amountCents` is `-receipt.amountCents` (negative — represents the reversal as a signed delta).
- **Wiring the watermark as a CSS overlay on the PDF preview component:** the watermark MUST be IN THE PDF BYTES. A CSS overlay only appears in the in-browser preview; the printed / emailed PDF would lack the watermark = compliance failure. Task 7's PDFKit `doc.text("VOIDED", ...)` is the only correct path.
- **Forgetting that `voidedReceipts` is append-only:** if the staff needs to correct the reason text of a void (typo, etc.), the answer is "no, you can't." The architecturally-correct flow is: void was wrong → issue a corrective audit log entry via a separate admin tool (not in this story's scope) → never patch the original `voidedReceipts` row.
- **Conflating `voidedReceipts` (this story's audit-companion table) with `auditLog` (Story 1.6's generic audit table):** they are different. The auditLog row for a void carries the standard before/after snapshot. The voidedReceipts row carries the denormalized historical receipt data (serial, amount, reason, by-whom) for fast retrieval without joins. Both exist; both serve.
- **Building the void Dialog without a confirmation step but treating the modal itself as the confirmation:** the Dialog IS the deliberate-pause confirmation per UX (the same pattern as the receipt preview modal). No second "are you sure?" dialog. The destructive variant of the button + the warning copy + the read-only summary are sufficient.
- **Missing the contract state revert:** if the voided receipt's payment was the closing payment that flipped the contract to `fully_paid`, the void must flip it back to `active`. Task 4 step 2 handles this. Forgetting it means the contract appears fully paid but the balance is non-zero — an inconsistent state.
- **Using `formatPesoInWords` from Story 3.11 with a negative number in any way:** the compensating allocation's amountCents is negative, but the receipt being re-rendered references the ORIGINAL (positive) `receipt.amountCents`. The PDF shows the original amount + the VOIDED watermark, not a negative amount. Do not feed negative cents into `formatPesoInWords` (Story 3.11 Task 6 throws on negatives — confirm).

### Open questions / blockers this story does NOT resolve

- **§10 Q3 — BIR receipt modality.** Voiding semantics are the same across the three modality options (CAS / accredited-POS / manual). The watermark rendering is independent of the locked format. **No gate here.**
- **Retention of the original PDF blob.** This story chooses storage hygiene (delete old, keep voided) over preservation. If BIR examiners ever require the original-pre-void PDF, the templateSnapshot + audit log's before/after suffice for reconstruction. If not — re-evaluate in a Phase 2 retention-policy story.
- **Bulk-void operations** (e.g. "void all receipts issued between dates X and Y because the printer was misconfigured"). Not in scope. Would require: a separate admin tool, per-receipt audit attribution, and almost certainly a §10 Q3 follow-up consultation. ADR-0006's addendum log tracks this for future planning.

### Project Structure Notes

Aligns with:

- [Architecture § Architectural Boundaries](../../_bmad-output/planning-artifacts/architecture.md#architectural-boundaries) — voids flow through the financial-write boundary like any other event.
- [Architecture § Pattern Examples > Good payment posting](../../_bmad-output/planning-artifacts/architecture.md#pattern-examples) — the `voidReceipt` mutation follows the same `requireRole → postFinancialEvent → return` shape.
- [Architecture § Project Structure & Boundaries](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries) — `convex/receipts.ts` is the documented home for receipt-related public functions.

No detected conflicts.

### References

- [PRD § FR29 (void with reason), FR31 (immutability)](../../_bmad-output/planning-artifacts/prd.md#5-payments--bir-receipts)
- [PRD § NFR-C1 (no serial gaps; voids consume their serial), NFR-C2 (immutability)](../../_bmad-output/planning-artifacts/prd.md#compliance--audit)
- [Architecture § Architectural Boundaries > Financial-entity write boundary](../../_bmad-output/planning-artifacts/architecture.md#architectural-boundaries)
- [Architecture § ADR-0006 — postFinancialEvent pattern](../../_bmad-output/planning-artifacts/architecture.md#core-architectural-decisions)
- [UX § Receipt detail surface — Void affordance](../../_bmad-output/planning-artifacts/ux-design-specification.md) (lines 1517–1525 — receipt actions row)
- [Epics § Story 3.12](../../_bmad-output/planning-artifacts/epics.md#story-312-office-staff-voids-a-receipt-with-reason)
- Previous story dependencies: [Story 3.1](./3-1-receipt-counter-with-optimistic-concurrent-serial-allocation.md), [Story 3.2](./3-2-postfinancialevent-cornerstone.md), [Story 3.11](./3-11-system-generates-bir-compliant-receipts.md), [Story 3.13](./3-13-receipts-are-print-emailable-as-pdf.md), Stories 1.2, 1.4, 1.6, 1.7

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (claude-opus-4-7) via Claude Code.

### Debug Log References

- Four-gate run on 2026-05-18:
  - `npx vitest run tests/unit/convex/receipts-void.test.ts tests/unit/components/VoidReceiptDialog.test.tsx` — 17/17 green.
  - `npm test` — 1995 passed, 1 skipped (suite-wide).
  - `npx tsc --noEmit` — 1 pre-existing error in `tests/unit/convex/portal-account.test.ts` (unrelated to this story; predates the slice).
  - `npm run lint` — 2 pre-existing errors in `src/components/SaleForm/SaleForm.tsx` (unused vars `watchedPerpetualCareInput` / `watchedPerpetualCareReason`; predate this story).
  - `npm run build` — succeeded; `/receipts/[receiptId]` route bundle increased from ~5.0 kB to 6.7 kB (the dialog + admin-gate wiring).

### Completion Notes List

This commit ships a narrower slice than the story's full spec — see
"Deviations from the story spec" below. The capabilities required by
the parent task brief (admin-only void with reason ≥ 10 chars, audit
emission, no serial reuse) are fully covered; the larger architectural
surface (companion `voidedReceipts` table, compensating
`paymentAllocations` row, PDF watermark variant, StatusPill `voided`
variant, contract balance reversal + state-machine extension, the
`no-mutate-voidedReceipts` ESLint rule) is intentionally deferred to a
follow-up that owns the files those changes would touch.

(a) **State-machine extension (1.7 contracts: `fully_paid → active`)**:
deferred. This slice does NOT reverse the contract balance on void; per
the parent task brief's policy decision (Task brief item 3), voiding
invalidates the receipt but the underlying payment + its allocations
remain intact, and a refund / correction flow handles the balance side
out-of-band. Consequently the `fully_paid → active` transition is not
exercised here. When the balance-reversal slice lands, it will need to
add the transition to `convex/lib/stateMachines.ts` per the story's
Task 4 step 4 guidance.

(b) **Original PDF blob deletion**: deferred. The PDF regeneration with
the VOIDED watermark is owned by Story 3.11's `generateReceiptPdf`
action — voided receipts already render the watermark per Story 3.11's
implementation (the `ReceiptDisplay` component carries the voided
banner; the PDF action's watermark branch was provisioned in 3.11). This
story does NOT schedule a fresh PDF re-render on void; the existing
PDF stays cached and a follow-up story owning
`convex/actions/generateReceiptPdf.ts` will wire the re-render. No
orphan-blob handling was needed because no blob deletion was performed.

(c) **`voidedReceipts.compensatingAllocationId` insert order**: not
applicable — the `voidedReceipts` companion table is NOT created in
this slice. The audit-grade record of the void lives in the standard
`auditLog` row emitted by the cornerstone (`action: "void"`,
`entityType: "receipt"`, reason text), which carries the receipt id,
serial, payment id, and the operator's typed reason. When the
companion table is added, the insert order Task 4 prescribes
(allocation → voidedReceipts → patches) is documented for the
follow-up.

(d) **Negative-amountCents convention for void_compensation**: not
applicable — the compensating-allocation row is not written in this
slice. The cornerstone's existing `void` path patches the void flags
on receipts + payments and emits the audit row; it does NOT insert a
compensating allocation. The negative-amountCents convention remains
the contract for the follow-up that ships the balance reversal.

(e) **`no-mutate-voidedReceipts` lint rule dogfooding**: not applicable
— the rule is not added in this slice (no `voidedReceipts` table to
protect).

(f) **StatusPill `voided` variant**: not added in this slice. The
voided banner inside `ReceiptDisplay` (added by 3.11) is the
operator-facing voided indicator on the receipt page; the StatusPill
extension is deferred to a follow-up that owns
`src/components/StatusPill.tsx`. No contrast measurement was needed.

#### Deviations from the story spec

- **No `voidedReceipts` companion table.** The story specifies a new
  append-only audit-grade companion table (`reasonCategory`,
  `reasonText`, `voidedBy`, `voidedAt`, `originalSerialFormatted`,
  `originalAmountCents`, `compensatingAllocationId`, `idempotencyKey`).
  This slice relies on the existing `auditLog` row + the `receipts` /
  `payments` row patches for the audit trail. The `auditLog` row
  emitted by the Story 3.2 cornerstone carries `action: "void"`,
  `entityType: "receipt"`, the receipt id, and the operator's reason —
  sufficient for the BIR examiner's "who voided what, when, why"
  question, narrower than the spec's denormalized companion record.
  Rationale: adding the table requires a schema migration + the
  cornerstone's `applyWrites` extension + the negative-amount
  allocation exception, all of which exceed this slice's file-ownership
  scope.
- **No `reasonCategory` UI / persistence.** The dialog collects only
  free-text reason (≥ 10 chars, trimmed; ≤ 1000 chars) — the
  category radio group is deferred. The audit row carries the free-text
  reason verbatim; downstream BIR filtering by category becomes
  possible when the companion table lands.
- **No PDF re-render scheduling on void.** Per (b) above, the existing
  PDF stays as-is until the next manual download triggers a re-render
  through `generateReceiptPdfRequest`. Story 3.11's action already
  watermarks voided receipts when it re-renders; this slice does not
  push a fresh render.
- **No contract-balance reversal / state revert.** Per the parent task
  brief's policy decision (item 3): voiding invalidates the receipt
  but the underlying payment row stays. A refund / correction lives
  in a separate flow that owns `convex/contracts.ts` and the state
  machines.
- **No contract-detail per-payment void link.** The dialog is wired to
  the receipt detail page only; the contract-detail integration is
  deferred to the follow-up that owns
  `src/app/(staff)/contracts/[contractId]/page.tsx`.
- **No Playwright spec.** Tests cover the mutation handler (9 cases)
  and the dialog component (8 cases). The full UI journey would
  require a Convex test-mode harness for the void path + a seeded
  receipt; that wiring belongs in a Playwright-owning follow-up.

#### Implementation notes

- **Auth gate** lives at the first awaited statement of the
  `voidReceipt` mutation (`requireRole(ctx, ["admin"])`) — admin-only.
  Office Staff and Field Worker callers hit `FORBIDDEN` before any
  read or write happens (tested).
- **Reason validation** is duplicated client-side (the dialog gates
  the submit button) and server-side (the mutation throws
  `VALIDATION`). The trim is performed before the floor check so
  whitespace padding does not satisfy the floor.
- **Idempotency** key is accepted from the client; when omitted the
  mutation synthesises `voidReceipt:<receiptId>` so a double-click on
  the destructive button dedupes at the cornerstone's
  `payments.by_idempotency` lookup. The cornerstone's existing
  same-key-same-payload contract handles the dedupe semantics.
- **Cornerstone routing**: the mutation calls
  `postFinancialEvent({ kind: "void", ... })`. The cornerstone's
  existing `voidReceiptPath` patches the receipt + linked payment
  with the void-flag bundle, emits the audit row, and returns the
  original `receiptNumber` (FR29: no serial re-allocation; the test
  asserts `receiptCounter.currentSerial` does not advance).
- **UI**: the receipt detail page reads
  `useQuery(getCurrentUserOrNullRef)` to determine admin role and
  renders the "Void receipt" button only when `isAdmin === true` AND
  `receipt.isVoided === false`. The `VoidReceiptDialog` swallows
  Enter keystrokes (UX § 1050 confidence-loop) and reads the
  receipt's `amountCents` + `issuedAt` + customer full name into a
  PII-narrow summary block.
- **Voided banner** in `ReceiptDisplay` was verified already present
  from 3.11 — no changes needed to that component.

### File List

Created:
- `src/components/VoidReceiptDialog/VoidReceiptDialog.tsx`
- `src/components/VoidReceiptDialog/index.ts`
- `tests/unit/convex/receipts-void.test.ts`
- `tests/unit/components/VoidReceiptDialog.test.tsx`

Modified:
- `convex/receipts.ts` — appended `voidReceipt` mutation +
  imports (`ErrorCode`, `throwError`, `postFinancialEvent`).
- `src/app/(staff)/receipts/[receiptId]/page.tsx` — added admin-only
  "Void receipt" button + dialog wiring, void handler, void status
  banner, and `formatPesoAmount` / `formatIssuedDateTime` imports.
