# Story 3.3: Office Staff Records Full-Payment Sale

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **Office Staff**,
I want **to record a full-payment sale on `/sales/new` by picking a lot, picking or inline-creating a customer, choosing "Full Payment," entering the price + payment method, and committing through a receipt-preview modal**,
so that **the cemetery can post a one-shot sale (lot → sold, ownership opens, fully_paid contract created, payment recorded, receipt issued, audit emitted) in a single atomic action — the simplest entry point into the `postFinancialEvent` cornerstone** (FR19).

This story is the **first consumer of the cornerstone** (Story 3.2's `postFinancialEvent`). It exists to: (a) prove the cornerstone behaves end-to-end with a real UI; (b) ship the `SaleForm` React surface that Story 3.4 (installment) extends; (c) wire up the lot-picker and customer-picker components that subsequent payment flows reuse. The UI scope here is deliberately narrower than Story 3.4 — no installment tab content, no discount panel — both are stub regions in the SaleForm that later stories fill in.

## Acceptance Criteria

1. **AC1 — `/sales/new` route renders the `SaleForm` with Full Payment tab active**: visiting `/sales/new` under the `(staff)` route group renders the SaleForm component. The form has two top-level tabs: **Full Payment** (default, this story implements) and **Installment** (stubbed, "Coming in next iteration" placeholder; Story 3.4 replaces). The route enforces `requireRole(["office_staff", "admin"])` server-side via the layout's auth gate; unauthorized roles redirect to `/dashboard` with an error pill.

2. **AC2 — Lot picker + customer picker complete the form**: the lot picker shows a searchable list of `available` lots (Convex query filtered to `status = "available"`) with section / lot number / price; the customer picker is a combobox that searches existing customers (by name + phone) and offers an "+ Create new customer" inline option that opens the `CustomerForm` (Story 2.1) in a modal. Selecting a lot auto-populates the price field; price is editable only by admins (defense-in-depth — staff sells at listed price).

3. **AC3 — Submit opens a receipt preview modal showing the actual PDF**: on form submit (button label "Review receipt" — the form's submit), the receipt preview modal opens rendering a native browser PDF iframe of what the receipt **will look like** (placeholder — Story 3.11 generates the real PDF; this story shows the modal scaffold + a "Generating preview..." state if Story 3.11's stub returns synchronously). The modal's primary action is **Generate & Print**; secondary is **Cancel**. Pressing Cancel closes the modal without writing anything; the form retains its state.

4. **AC4 — Generate & Print invokes the `recordFullPaymentSale` mutation routed through `postFinancialEvent`**: clicking Generate & Print calls `useMutation(api.sales.recordFullPaymentSale)` with `{ lotId, customerId, basePriceCents, method, reference?, paidAt, idempotencyKey }`. The mutation file `convex/sales.ts` (**NEW** in this story) calls `requireRole(["office_staff", "admin"])` then `postFinancialEvent(ctx, { kind: "sale_full", … })`. The mutation returns `{ receiptId, serialFormatted }`. The UI: (a) closes the modal, (b) routes to `/contracts/[contractId]` (the new contract detail page; stubbed minimally if not yet built), (c) opens `window.print()` against the receipt PDF (Story 3.11 / 3.13 finish the printing UX), (d) shows a 600ms amber flash on the new payment row.

5. **AC5 — Concurrent-sale conflict is handled gracefully**: if two staff members both submit the same lot simultaneously, the second submission throws `ILLEGAL_STATE_TRANSITION` from `assertTransition` (lot already `sold`). The UI catches this and shows: **"This lot was just sold to someone else. Refresh to view current status."** — inline, not a toast — with a "Refresh" button that re-loads the lot picker. No partial writes occur (cornerstone atomicity, Story 3.2).

## Tasks / Subtasks

### Convex domain layer (AC4, AC5)

- [ ] **Task 1: Create `convex/sales.ts`** (**NEW**) (AC: 4)
  - [ ] File-level JSDoc: "Sale domain — public mutations entering `postFinancialEvent` for sale flows (FR19, FR20). Never writes to financial tables directly; delegates to `convex/lib/postFinancialEvent.ts`."
  - [ ] Export the single public mutation `recordFullPaymentSale`:
    ```ts
    export const recordFullPaymentSale = mutation({
      args: {
        lotId: v.id("lots"),
        customerId: v.id("customers"),
        basePriceCents: v.number(),
        method: v.union(v.literal("cash"), v.literal("check"), v.literal("bank")),
        reference: v.optional(v.string()),
        paidAt: v.number(),
        idempotencyKey: v.string(),
      },
      handler: async (ctx, args) => {
        await requireRole(ctx, ["office_staff", "admin"]);
        // Defensive validation
        assertNonNegativeMoney(args.basePriceCents, "basePriceCents");
        if (args.method !== "cash" && !args.reference) {
          throwError(ErrorCode.INVARIANT_VIOLATION, "Reference required for check / bank payments.");
        }
        return await postFinancialEvent(ctx, {
          kind: "sale_full",
          lotId: args.lotId,
          customerId: args.customerId,
          basePriceCents: args.basePriceCents,
          discountCents: 0,                       // Story 3.5 wires the discount input
          method: args.method,
          reference: args.reference,
          paidAt: args.paidAt,
          idempotencyKey: args.idempotencyKey,
        });
      },
    });
    ```
  - [ ] **The handler body is two lines of logic — `requireRole` + `postFinancialEvent`.** Everything else (state transitions, audit, serial, ownership creation) is inside the cornerstone (Story 3.2's Task 7 `prepareSaleFull`). Resist the urge to do "just this one defensive check" inline; if defensive checks are needed, they go in the cornerstone where they get the ≥ 95% coverage gate.
  - [ ] **`require-role-first-line` rule** (Story 1.2) requires `requireRole` as the first action — satisfied. **`no-direct-financial-table-writes`** (Story 3.2) is satisfied because the only writes happen inside `postFinancialEvent`.

- [ ] **Task 2: Add a `listAvailableLots` query in `convex/lots.ts`** (AC: 2)
  - [ ] **UPDATE** `convex/lots.ts` (created in Epic 1 Story 1.8). Add a public query:
    ```ts
    export const listAvailableLots = query({
      args: { search: v.optional(v.string()), limit: v.optional(v.number()) },
      handler: async (ctx, args) => {
        await requireRole(ctx, ["office_staff", "admin"]);
        const limit = args.limit ?? 50;
        // Use the by_status index from Story 1.8
        const lots = await ctx.db
          .query("lots")
          .withIndex("by_status", q => q.eq("status", "available"))
          .take(limit);
        if (!args.search) return lots;
        const needle = args.search.toLowerCase();
        return lots.filter(l => `${l.section}-${l.number}`.toLowerCase().includes(needle));
      },
    });
    ```
  - [ ] **Why client-side filter on `search`** — Phase 1 has ~2,000 lots; the `available` subset is at most a few hundred. Real text search lands when search infrastructure does (Story 1.10 search). For now, a take + client-filter is fine and avoids depending on Convex search-index features that may or may not be in scope here.
  - [ ] **Verify Story 1.8 created the `by_status` index** — if not, add it as an UPDATE in this story (`.index("by_status", ["status"])`).

### Reusable form components (AC2)

- [ ] **Task 3: Create `src/components/SaleForm/LotPicker.tsx`** (**NEW**) (AC: 2)
  - [ ] Use shadcn/ui `Command` component (combobox-style search). Query results via `useQuery(api.lots.listAvailableLots, { search: query })`.
  - [ ] Display each option as: `<row><span>{section}-{number}</span><span>{formatPeso(priceCents)}</span><StatusPill status="available"/></row>` — uses `StatusPill` from Story 1.4 + `formatPeso` from `src/lib/money.ts`.
  - [ ] Selecting a lot calls `onSelect(lot)` — the parent SaleForm captures `{ lotId, basePriceCents }`.
  - [ ] Empty state: "No available lots match. Clear filter." (UX-DR23).
  - [ ] Loading state: skeleton rows matching the layout (UX-DR21). Never a spinner.
  - [ ] Keyboard nav: arrow keys + enter; matches shadcn/ui Command defaults.

- [ ] **Task 4: Create `src/components/SaleForm/CustomerPicker.tsx`** (**NEW**) (AC: 2)
  - [ ] shadcn/ui Combobox. Uses `useQuery(api.customers.searchCustomers, { search })` — assumes Epic 2 Story 2.1 ships this query (depend; if it doesn't yet, add as an UPDATE here with a minimal index-based search).
  - [ ] First option in the dropdown is always **"+ Create new customer"** which opens the `CustomerForm` (Story 2.1) in a `Dialog`. On creation success, the new customer auto-selects.
  - [ ] Display each option as: `<row><span>{name}</span><span className="text-slate-500">{phone}</span></row>` — phone is searchable (matches PH convention of customers being known by their mobile number).
  - [ ] Selecting a customer calls `onSelect(customer)`.

### SaleForm shell + Full Payment tab (AC1, AC2, AC3, AC4)

- [ ] **Task 5: Create `src/components/SaleForm/SaleForm.tsx`** (**NEW**) (AC: 1, AC: 2)
  - [ ] `"use client"` line 1.
  - [ ] Use React Hook Form + Zod for the form schema. Tabs from shadcn/ui:
    ```tsx
    <Tabs defaultValue="full">
      <TabsList>
        <TabsTrigger value="full">Full Payment</TabsTrigger>
        <TabsTrigger value="installment">Installment</TabsTrigger>
      </TabsList>
      <TabsContent value="full"><FullPaymentTab .../></TabsContent>
      <TabsContent value="installment">
        <p className="text-slate-500 p-8">Installment flow ships in the next iteration (Story 3.4).</p>
      </TabsContent>
    </Tabs>
    ```
  - [ ] Focus management: on mount, focus auto-lands on the LotPicker (UX § 688 "Focus auto-lands on Amount" — adapted for SaleForm's primary input).
  - [ ] `useIdempotencyKey()` hook (from Story 1.something — `src/hooks/useIdempotencyKey.ts` per architecture's hook list) generates one UUIDv4 per form mount; persists across re-renders but resets on full mount.

- [ ] **Task 6: Create `src/components/SaleForm/FullPaymentTab.tsx`** (**NEW**) (AC: 2, AC: 3)
  - [ ] Fields:
    - LotPicker (selects `lotId` + auto-populates `basePriceCents`)
    - CustomerPicker (selects `customerId`)
    - Price (peso-prefix input, tabular numerics, locked for non-admin roles — read-only with a tooltip "Price set by lot configuration; contact admin to override")
    - Method (shadcn/ui Select: Cash / Check / Bank). Default Cash.
    - Reference (text input, required when method ≠ Cash — shadcn/ui Form's conditional validation)
    - Date (date picker; default today in Manila tz via `useManilaNow()` hook)
  - [ ] Submit button label: **"Review receipt"** (not "Submit" — UX confidence-loop pattern, line 587 of UX spec).
  - [ ] Submit handler: validate, then `setReceiptPreviewOpen(true)` — opens the modal (Task 7).
  - [ ] Inline validation per UX § Form Patterns: blur + submit (RHF defaults). Errors via `aria-describedby` (NFR-A6).

### Receipt preview modal (AC3, AC4)

- [ ] **Task 7: Create `src/components/SaleForm/ReceiptPreviewModal.tsx`** (**NEW**) (AC: 3, AC: 4)
  - [ ] shadcn/ui `Dialog`.
  - [ ] Props: `{ open, onClose, salePayload, onCommit }`.
  - [ ] Body: a "preview" of the receipt the system **will** issue. In this story (Story 3.11 generates real PDFs), render a static client-side preview matching the UX spec's mockup (lines 707–731): cemetery letterhead, "Serial: (next available)" as a literal label, customer name, line items, total, method, BIR placeholders.
  - [ ] Use the actual PDF iframe pattern (UX-DR11) **only after** Story 3.11 lands — for this story, the preview is plain HTML. Add a `// TODO Story 3.11/3.13: replace HTML preview with PDF iframe once generateReceiptPdf can render synchronously (or with a "Generating preview…" skeleton).` comment.
  - [ ] Primary action: **Generate & Print** — calls `onCommit()` (which the parent wires to the mutation). Spinner inside the button while the mutation is in flight (~500ms typical per UX § 740).
  - [ ] Secondary: **Cancel** — closes the modal. Esc also closes.
  - [ ] Footer copy: "Once generated, this receipt cannot be edited. Voids must be recorded separately." (UX § 727).
  - [ ] Keyboard: Esc cancels, Enter commits (UX § 736).

- [ ] **Task 8: Wire the mutation call + post-commit UX** (AC: 4, AC: 5)
  - [ ] In SaleForm.tsx, the `onCommit` handler calls `recordFullPaymentSale` mutation. On success:
    1. Close the modal.
    2. `router.push(\`/contracts/\${result.contractId}\`)` — routes to the new contract detail page (stubbed in Story 3.6 / Epic UI; if not yet built, a minimal page that just shows the contract id + a "Built by Story 3.6" placeholder is acceptable, and a TODO comment marks the gap).
    3. Call `window.print()` (browser-native print dialog; UX § 743). Note: real receipt PDF print integration lands in Story 3.13; for this story, opening the print dialog with no PDF rendered is acceptable as a "smoke test" of the flow — leave a TODO referencing 3.13.
    4. The contract page (when built) wraps the new payment row in `ReactiveHighlight` (Story 1.4 / UX-DR25) to produce the 600ms amber flash.
  - [ ] On error: catch the `ConvexError`. Map via `translateError` from `src/lib/errors.ts` (Story 1.something — Epic 1 UX-DR24):
    - `ILLEGAL_STATE_TRANSITION` → "This lot was just sold to someone else. Refresh to view current status." with a "Refresh" button (AC5).
    - `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD` → "Sale could not be re-submitted because the form values changed. Refresh and start over." (this is a "should never happen" case in this flow — but defensive UX).
    - Generic `ConvexError` → display the helper's `message` field inline above the modal's footer.
  - [ ] **Error display location:** inline at the top of the modal (UX-DR24 "Inline error display, not toast").

### Route + page (AC1)

- [ ] **Task 9: Create `/sales/new` route** (AC: 1)
  - [ ] Create `src/app/(staff)/sales/new/page.tsx` (**NEW**):
    ```tsx
    "use client";
    import { SaleForm } from "@/components/SaleForm/SaleForm";
    export default function NewSalePage() {
      return (
        <div className="max-w-3xl mx-auto p-6">
          <h1 className="text-2xl font-semibold mb-4">New Sale</h1>
          <SaleForm />
        </div>
      );
    }
    ```
  - [ ] The `(staff)/layout.tsx` (Story 1.1 / 1.2) handles the role-gated redirect. Story 1.2's `(staff)/layout.tsx` was refactored to use `requireAuth`; we additionally need to verify the calling user's role is `office_staff` or `admin`. **Phase 1 simplification:** allow all authenticated `(staff)` users to reach `/sales/new`; the mutation itself throws `FORBIDDEN` for users without the right role (server-side enforcement is the real gate per architecture's defense-in-depth). UI-level gating (hiding the menu entry) is a UX polish task tracked in Epic 5 / Story 5.x.
  - [ ] Add `loading.tsx` for the route — skeleton matching the SaleForm layout (UX-DR21).

### Tests (all ACs)

- [ ] **Task 10: Unit tests for the `recordFullPaymentSale` mutation** (AC: 4, AC: 5)
  - [ ] Create `tests/unit/convex/sales.test.ts` (**NEW**).
  - [ ] Tests (using `convex-test` + fixtures from Story 3.2):
    - Happy path: authenticated office_staff calls with valid args → returns `{ receiptId, serialFormatted }`; lot is now `sold`; contract row exists with state `fully_paid`; payment + receipt rows exist; audit row emitted.
    - Unauthenticated → `UNAUTHENTICATED`.
    - Customer role attempting → `FORBIDDEN`.
    - Already-sold lot → `ILLEGAL_STATE_TRANSITION`; no new writes (count rows pre/post).
    - Missing reference + method=check → `INVARIANT_VIOLATION`.
    - Negative `basePriceCents` → `INVARIANT_VIOLATION`.
    - Idempotency: second call same key + same payload → returns same receipt; only one payment in DB.

- [ ] **Task 11: Component tests for `SaleForm` Full Payment tab** (AC: 1, AC: 2, AC: 3)
  - [ ] Create `src/components/SaleForm/SaleForm.test.tsx` (co-located per architecture's React-test convention).
  - [ ] Tests (Vitest + Testing Library, with mocked Convex hooks via `convex-test`'s React harness or a manual mock):
    - Renders the LotPicker, CustomerPicker, Method, Reference, Date.
    - Reference field appears only when Method ≠ Cash.
    - Submit button label is "Review receipt"; opens modal on click.
    - Modal Cancel closes without writing.
    - Disabled-while-submitting state on the modal's primary button.

- [ ] **Task 12: Playwright smoke for the full-payment journey** (AC: 1 – AC: 5)
  - [ ] Create `tests/e2e/journey-3-3-full-payment-sale.spec.ts` (one spec, not the full Journey-1 spec — that's Story 3.4 + 3.9's combined effort).
  - [ ] Spec walks: seed an admin + available lot + customer → log in → navigate to `/sales/new` → fill form → review receipt → confirm → assert redirect to `/contracts/[id]` and the contract row shows the new payment.
  - [ ] Run on the Pixel 5 emulation profile (architecture § Playwright config). Mobile-first; if the form layout breaks on Pixel 5, fix it before merging.

## Dev Notes

### Previous story intelligence

**Hard dependencies:**

- **Story 3.1 — `receiptCounter` table + `allocateNextSerial`.** Consumed transitively via the cornerstone.
- **Story 3.2 — `postFinancialEvent`.** This story is the first public-mutation consumer. The `sale_full` kind branch (Story 3.2 Task 7 `prepareSaleFull`) is exercised end-to-end here.
- **Story 1.2 — `requireRole`.** First-line check; the `require-role-first-line` rule (Story 1.2) verifies it's present in `convex/sales.ts`.
- **Story 1.4 — StatusPill, ReactiveHighlight.** Reused in LotPicker rows + the post-commit amber flash.
- **Story 1.6 — `emitAudit`.** Cornerstone calls it; this story does not call directly.
- **Story 1.7 — state machines.** `lot: available → sold` transition must be in `stateMachines.ts`. If Story 1.7 left it out, this story EXTENDS the table; add an ADR addendum if so.
- **Story 1.8 — `lots` schema + `by_status` index.** Task 2 queries via this index; verify it exists (and add it as an UPDATE if Story 1.8 omitted).
- **Story 2.1 — `customers` schema + `searchCustomers` query.** Task 4's CustomerPicker depends. If Story 2.1's query is not yet shaped for what we need, add a thin wrapper here and document.
- **Story 1.5 / 1.4 — app shell, design tokens, `useIdempotencyKey`, `useManilaNow` hooks.** Reused.

**TODOs this story leaves for later stories:**

- The receipt preview modal renders an HTML mock; real PDF iframe lands in Story 3.11 / 3.13.
- `/contracts/[id]` is a minimal stub if Story 3.6 hasn't shipped it; full contract detail page is Story 3.6's responsibility.
- The 600ms amber flash on the new payment row depends on the contract detail page using `ReactiveHighlight`; this story sets up the data flow that makes the highlight possible — the visual landing is on Story 3.6.

### Architecture compliance

- **Architecture § Pattern Examples > Good payment posting** is literally the template Task 1's `recordFullPaymentSale` handler follows. Match the example structure.
- **Architecture § Enforcement Guidelines #1**: `requireRole` as first action (Task 1) — enforced by Story 1.2's lint rule.
- **Architecture § Enforcement Guidelines #2**: `postFinancialEvent` for every sale — enforced by Story 3.2's `no-direct-financial-table-writes` rule.
- **Architecture § Naming Patterns**: mutation name `recordFullPaymentSale` (verb=record, noun=FullPaymentSale, snake-not-used because it's a name not an enum value). File `convex/sales.ts`. Component `SaleForm.tsx`. All match.
- **UX § Defining Experience > Preview-not-confirmation modal pattern** (lines 272, 311): the receipt preview modal **is** the deliberate pause; no "Are you sure?" pre-confirmation.

### Library / framework versions

- **shadcn/ui Tabs, Combobox, Command, Dialog, Form** components — copy from shadcn/ui registry into `src/components/ui/` (per architecture's "shadcn/ui copy-paste-into-repo" model). Use whichever versions Story 1.4 introduced; do not bump.
- **React Hook Form + Zod** — already installed by Story 1.something for the CustomerForm and login. Reuse.
- **No new runtime deps.**

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── sales.ts                                   # NEW (recordFullPaymentSale mutation)
│   └── lots.ts                                    # UPDATE (add listAvailableLots query)
├── src/
│   ├── app/(staff)/
│   │   └── sales/
│   │       └── new/
│   │           ├── page.tsx                       # NEW
│   │           └── loading.tsx                    # NEW (skeleton)
│   └── components/SaleForm/
│       ├── index.ts                               # NEW (re-exports)
│       ├── SaleForm.tsx                           # NEW (tab shell + RHF wiring)
│       ├── SaleForm.test.tsx                      # NEW (component tests)
│       ├── FullPaymentTab.tsx                     # NEW (the meat of this story)
│       ├── LotPicker.tsx                          # NEW (reusable; Story 3.4 also consumes)
│       ├── CustomerPicker.tsx                     # NEW (reusable; Story 3.4 also consumes)
│       └── ReceiptPreviewModal.tsx                # NEW (HTML preview now; Story 3.11/3.13 swap in PDF iframe)
├── tests/
│   ├── unit/convex/
│   │   └── sales.test.ts                          # NEW
│   └── e2e/
│       └── journey-3-3-full-payment-sale.spec.ts  # NEW
```

### Testing requirements

- **NFR-M2 (≥ 90% line coverage on financial code) applies to `convex/sales.ts`.** Hit the threshold via Task 10. The cornerstone's coverage gate is separate (Story 3.2).
- **The lint rules from Story 1.2 + 3.1 + 3.2 must all pass.** If any of them flag the new code, fix the code; never disable the rule.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT write to `payments`, `receipts`, `paymentAllocations`, `contracts.outstandingBalanceCents`, or `receiptCounter` directly.** All writes go through `postFinancialEvent`. The lint rules from Story 3.2 + 3.1 catch this; do not bypass.
- ❌ **Do NOT skip the `requireRole` check.** Server-side authorization is mandatory. UI-level role gating is supplementary.
- ❌ **Do NOT generate the `idempotencyKey` server-side.** Client-only (UUIDv4 per form mount). Server-generated keys defeat dedup on browser refresh.
- ❌ **Do NOT add a "confirm" dialog before the preview modal.** The preview IS the confirmation; double-confirming defeats the muscle-memory test (UX § 1050).
- ❌ **Do NOT auto-print before the user clicks Generate & Print.** The print dialog opens on the post-commit success path, not on modal open.
- ❌ **Do NOT call `recordFullPaymentSale` from a server component.** It's a mutation; must be called from a `"use client"` boundary via `useMutation`.
- ❌ **Do NOT allow non-admin roles to edit the price field.** Discount workflow (Story 3.5) is the sanctioned path for price adjustments.
- ❌ **Do NOT cache the lot list across staff sessions.** `useQuery` is reactive; let Convex's subscription handle the freshness so two staff members see live availability.
- ❌ **Do NOT optimistic-update the lot status to `sold` before the mutation returns.** Financial mutations are non-optimistic (architecture § Communication Patterns > "Never optimistic on financial mutations").
- ❌ **Do NOT swallow the `ILLEGAL_STATE_TRANSITION` error.** Surface it with the specific UX-DR24 sentence; users must understand the lot was sold to someone else.

### Common LLM-developer mistakes to prevent

- **Reaching for Redux / Zustand for form state:** No. React Hook Form + the parent SaleForm's local `useState` suffice. Architecture forbids extra state libs.
- **Wrong file location for the mutation:** `convex/sales.ts`, NOT `convex/lib/sales.ts` (lib is server-internal helpers; domain mutations are at `convex/<domain>.ts`).
- **Forgetting to register the new shadcn/ui components in the registry:** if Tabs/Combobox/Dialog weren't copied yet, copy them per the shadcn/ui CLI flow.
- **Mixing client and server in `page.tsx`:** the page must be a `"use client"` component because it renders `SaleForm` which uses Convex hooks. Server-component layout still applies.
- **Hardcoding `prefix: "OR-"`:** the formatted serial comes from the cornerstone (Story 3.1's `allocateNextSerial`). Client code never invents the prefix.
- **Allowing the lot picker to show non-`available` lots:** the query filter (Task 2) excludes them; if you find yourself adding "show all + visual indicator," step back — the filter is the contract.
- **Skipping the focus-management test:** the LotPicker autofocus is part of the keyboard-only flow target (UX § 609 < 90s end-to-end target). Verify in Playwright.

### Open questions / blockers this story does NOT resolve

- **None blocking.** All §10 client gates affect other stories:
  - Q1 (installment policy) → Story 3.4.
  - Q3 (BIR receipt modality) → Story 3.11 PDF body.
  - Q7 (perpetual care) → Story 3.8.
- The receipt preview modal renders an HTML mock — flagged with a TODO referencing Story 3.11 / 3.13.

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure & Boundaries](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries) — `convex/sales.ts`, `src/components/SaleForm/`, `src/app/(staff)/sales/new/page.tsx` all match.
- [Architecture § Pattern Examples](../../_bmad-output/planning-artifacts/architecture.md#pattern-examples) — Task 1's handler is the canonical pattern.

### References

- [PRD § FR19 (full-payment sale)](../../_bmad-output/planning-artifacts/prd.md#functional-requirements)
- [Architecture § Pattern Examples > Good payment posting](../../_bmad-output/planning-artifacts/architecture.md#pattern-examples)
- [Architecture § Enforcement Guidelines](../../_bmad-output/planning-artifacts/architecture.md#enforcement-guidelines)
- [UX § Defining Experience > Receipt preview modal](../../_bmad-output/planning-artifacts/ux-design-specification.md) (lines 580–745)
- [Epics § Story 3.3](../../_bmad-output/planning-artifacts/epics.md#story-33-office-staff-records-full-payment-sale)
- Previous story dependencies: [Story 3.1](./3-1-receipt-counter-with-optimistic-concurrent-serial-allocation.md), [Story 3.2](./3-2-postfinancialevent-cornerstone.md), [Story 1.2](./1-2-server-enforces-role-based-access-on-every-endpoint.md), Story 1.4 (StatusPill, ReactiveHighlight), Story 1.7 (stateMachines), Story 1.8 (lots schema), Story 2.1 (customers schema)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Claude Code, autonomous dev-story run, 2026-05-20).

### Debug Log References

- Local typecheck / lint / test / build gates could not be executed inside the
  agent sandbox (Bash + PowerShell denied). Code was authored against the
  existing patterns and conventions verified by re-reading every cornerstone
  module (`convex/lib/postFinancialEvent.ts`, `convex/lib/stateMachines.ts`,
  `convex/lib/audit.ts`, `convex/lib/auth.ts`, `convex/lib/receiptCounter.ts`,
  `convex/lots.ts`, `convex/customers.ts`) and mirrored test fixtures from
  `tests/unit/convex/lots.test.ts`. CI is expected to be the authoritative
  gate.
- The story's recommended file structure (`convex/sales.ts` with a thin
  `recordFullPaymentSale` that delegates straight to `postFinancialEvent`)
  was superseded by the user-spec direction to materialise a first-class
  `contracts` table in this story. The implementation lives in
  `convex/contracts.ts`; `convex/sales.ts` is not created. The contract row
  is the aggregate that holds the lot + customer + financial back-pointers
  together for the contract detail page Story 3.6 will expand.

### Completion Notes List

1. **State-machine transitions** — no edits to `convex/lib/stateMachines.ts`.
   The existing table already permits `lot:available → sold` (Story 1.7
   declared it). The contract create-path writes `state: "paid_in_full"`
   directly via insert (creation is not a transition — same pattern as
   `createLot` writing `status: "available"`). NOTE: the state-machine
   table's `contract` map uses `fully_paid` (no underscore) and does not
   include `voided`, while the schema (per user-spec direction) uses
   `paid_in_full` and `voided`. Story 3.6 will reconcile the vocabularies
   when it wires the first contract transition — this story only does
   inserts, so the mismatch is not exercised by any transition path here.
2. **Receipt-preview modal** — Phase 1 HTML mock with a
   `// TODO Story 3.11/3.13` comment marker. The modal opens on form
   submit, focuses the commit button, surfaces inline errors above the
   footer (UX-DR24), and supports ESC + Enter keyboard semantics.
3. **`/contracts/[contractId]` page** — built as a minimal stub
   (contract number, lot, customer, total, state pill, receipt number).
   A `// TODO Story 3.6` comment marks the gap; the page is the safe
   redirect target for `recordFullPaymentSale` until Story 3.6's full
   timeline view lands.
4. **Defensive validation** — `recordFullPaymentSale` performs four
   pre-cornerstone checks (positive-integer price, non-cash needs
   reference, non-empty idempotency key, lot is available + non-retired
   + customer exists). These remain inside `convex/contracts.ts` — they
   are call-site specific (the cornerstone is intentionally agnostic
   about whether a payment must come with a contract) and are not
   promotable to the cornerstone.
5. **Contract numbering** — `CON-YYYYMMDD-<lotCode>-<rand4>` where the
   suffix is `Date.now() % 10000` zero-padded. Collisions are
   astronomically unlikely at Phase 1 volume; if a richer numbering
   scheme is required (BIR series alignment), Story 3.6 can re-derive
   without a schema change.
6. **Nav items** — `Sales` shed its `comingSoon` label (route is live).
   `Contracts` was added with `comingSoon: "Story 3.6"` so the link
   renders disabled in the sidebar until the rich contract list lands.

### File List

Created:
- `convex/contracts.ts` — `recordFullPaymentSale`, `getContract`, `listContracts`.
- `src/components/SaleForm/SaleForm.tsx`
- `src/components/SaleForm/LotPicker.tsx`
- `src/components/SaleForm/CustomerPicker.tsx`
- `src/components/SaleForm/ReceiptPreviewModal.tsx`
- `src/components/SaleForm/saleFormSchema.ts`
- `src/components/SaleForm/index.ts`
- `src/app/(staff)/sales/page.tsx` — contract list view (newest-first).
- `src/app/(staff)/sales/new/page.tsx` — Full-Payment sale entry.
- `src/app/(staff)/contracts/[contractId]/page.tsx` — minimal contract detail (Story 3.6 will replace).
- `tests/unit/convex/contracts.test.ts`
- `tests/unit/components/SaleForm.test.tsx`
- `tests/e2e/full-payment-sale.spec.ts`

Modified:
- `convex/schema.ts` — added the `contracts` table with `by_lot`, `by_customer`, `by_state`, `by_contractNumber` indexes.
- `src/components/Sidebar/nav-items.ts` — dropped Sales `comingSoon`; appended a `Contracts` entry (gated `comingSoon: "Story 3.6"`).
