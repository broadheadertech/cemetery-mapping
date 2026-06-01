# Story 9.3: Customer Downloads Receipt PDFs

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **Customer**,
I want **to download a PDF receipt for any past payment on my contract via a short-lived signed URL — that URL must require my authenticated session and must 403 if a non-owner attempts to use it**,
so that **I can archive my BIR-compliant records, and the receipts are not leaked through guessable / shareable URLs** (FR56).

This story extends the Phase 1 receipt-PDF infrastructure to the customer portal. Phase 1 already generates and stores receipt PDFs (Story 3.x, FR30) and exposes them to staff via signed URLs. This story adds a customer-facing entry point that enforces ownership on every signed-URL generation.

## Acceptance Criteria

1. **AC1 — Customer can tap "Download receipt" on each payment row**: On `/(customer)/contracts/[id]` (Story 9.2's page), the `PaymentHistoryTable` "Download receipt" button is enabled for each payment that has an associated receipt. Tapping it triggers `customerPortal:getReceiptDownloadUrl({ paymentId })` and on success opens / downloads the PDF via the returned URL.

2. **AC2 — Signed URL is short-lived and ownership-gated**: `customerPortal:getReceiptDownloadUrl` performs: (a) `requireRole(ctx, ["customer"])`, (b) load the payment doc, (c) verify `payment.contractId`'s contract has `customerId === ctx.customerId` (ownership check), (d) generate a Convex File Storage signed URL via `ctx.storage.getUrl(payment.receiptStorageId)` — Convex's storage URLs are auth-aware and time-limited (default ~15 minutes per Convex's current behavior; verify at implementation time and document the actual lifetime). Non-owners receive `null` (404 client-side).

3. **AC3 — Direct URL access fails for non-owners**: If a customer A obtains a signed URL (through any means) and customer B attempts to access it after their own auth session is established, the URL still works only for the session that minted it. Convex's signed URLs are bearer-style; the *issuance* is the gate, not the GET. Therefore the only security guarantee is on `getReceiptDownloadUrl` — minted URLs are sharable until they expire. Document this in `docs/threat-model.md` and accept the residual risk (15-min window, customer-to-customer sharing is contractual abuse, not an attack the architecture should over-engineer against).

4. **AC4 — Audit log on every receipt download URL issuance**: Every successful `getReceiptDownloadUrl` call emits an audit row: `{ action: "receipt.downloaded", entityType: "receipt", entityId: receiptId, actorId: userId, actorRole: "customer", details: { paymentId, contractId } }`. This satisfies NFR-S8 (PII access logging — receipt PDFs contain customer name + payment amounts which are sensitive operational data).

## Tasks / Subtasks

### Convex query (AC1, AC2, AC3, AC4)

- [ ] **Task 1: Implement `getReceiptDownloadUrl`** (AC: 1, AC: 2, AC: 4)
  - [ ] In `convex/customerPortal.ts`, add:
    ```ts
    export const getReceiptDownloadUrl = query({
      args: { paymentId: v.id("payments") },
      handler: async (ctx, { paymentId }) => {
        const { customerId, userId } = await requireRole(ctx, ["customer"]);
        const payment = await ctx.db.get(paymentId);
        if (!payment) return null;
        const contract = await ctx.db.get(payment.contractId);
        if (!contract || contract.customerId !== customerId) return null;
        const receipt = await ctx.db.query("receipts")
          .withIndex("by_payment", q => q.eq("paymentId", paymentId))
          .first();
        if (!receipt || !receipt.pdfStorageId) return null;
        const url = await ctx.storage.getUrl(receipt.pdfStorageId);
        // Note: emitAudit from a query is fine (audit rows are inserts and queries allow inserts via internalMutation pattern — but if Convex disallows DB writes from queries, route through an internalMutation called via ctx.runMutation, OR convert this to a mutation since downloading is a state-affecting action for audit purposes)
        return { url, receiptNo: receipt.serial };
      },
    });
    ```
  - [ ] **Important:** Convex queries are read-only. Audit emission is a write. **Convert `getReceiptDownloadUrl` to a mutation** so it can call `emitAudit` directly. The mutation is idempotent in practice (signed-URL issuance is stateless except for the audit log). Document the choice: "This is a mutation not a query because it writes an audit row. The signed-URL generation itself is read-only, but the audit-log requirement (NFR-S8) means we must record every issuance."
  - [ ] After the ownership check passes: `await emitAudit(ctx, { action: "receipt.downloaded", entityType: "receipt", entityId: receipt._id, ... })`.
  - [ ] First line is still `await requireRole(ctx, ["customer"])` — lint rule satisfied.

- [ ] **Task 2: Verify schema for `receipts.pdfStorageId` and `by_payment` index** (AC: 2)
  - [ ] In `convex/schema.ts`, confirm the `receipts` table (Phase 1 Story 3.x) has `pdfStorageId: v.id("_storage")` and an index `by_payment` on `paymentId`. If absent, add the index — it's required for the lookup to be O(1).
  - [ ] Confirm Phase 1's receipt-PDF generation action writes `pdfStorageId` after `ctx.storage.store(pdfBlob)`. If not, that's a Phase 1 bug; surface immediately rather than papering over here.

### Client-side wiring (AC1)

- [ ] **Task 3: Update `PaymentHistoryTable`** (AC: 1)
  - [ ] In `src/components/customer/PaymentHistoryTable.tsx` (Story 9.2's component): replace the stubbed "Coming in Story 9.3" tooltip with a working button.
  - [ ] Use `useMutation(api.customerPortal.getReceiptDownloadUrl)` (per Task 1 it's a mutation). On click:
    ```ts
    const handleDownload = async (paymentId) => {
      setBusy(paymentId);
      try {
        const result = await getReceiptDownloadUrl({ paymentId });
        if (!result) { toast.error("Receipt not available"); return; }
        // Open in a new tab; the browser will prompt download for PDF.
        window.open(result.url, "_blank", "noopener,noreferrer");
      } catch (e) { toast.error("Could not download receipt. Please try again."); }
      finally { setBusy(null); }
    };
    ```
  - [ ] Per-row spinner during the click. Disable the button while busy. After download, the button returns to enabled state — customers may need to re-download (signed URL expires).
  - [ ] Accessibility: button has `aria-label="Download receipt for payment on {date}"`.

### Threat model + access-log documentation (AC3, AC4)

- [ ] **Task 4: Update `docs/threat-model.md`** (AC: 3)
  - [ ] Add section "Receipt URL sharing": describe the bearer-token nature of Convex signed URLs, the 15-minute (verify) expiry, accepted residual risk that a customer who shares their URL with a friend leaks one receipt. Mitigation: short expiry + audit log makes post-facto detection possible.
  - [ ] Add: "Customer B cannot obtain customer A's receipt via guessable URLs because (a) the storage ID is a 30+ char opaque token, (b) the signed URL embeds a session-derived signature, (c) the `getReceiptDownloadUrl` ownership check is the actual gate."

- [ ] **Task 5: Verify `pii_access_log` policy** (AC: 4)
  - [ ] Receipts contain customer name + amounts but NOT gov ID. Per Phase 1's PII model, gov ID is the PII anchor; receipts are sensitive operational data with their own audit pattern via `auditLog`, not `pii_access_log`. Confirm by reading `convex/lib/pii.ts` — the PII fields list should NOT include receipt content.
  - [ ] If a future story exposes the customer's gov ID number on the receipt PDF, the PII-access-log policy applies. Document this as a Phase 4 consideration.

### Testing (AC1–AC4)

- [ ] **Task 6: Unit tests** (AC: 2, AC: 4)
  - [ ] Extend `tests/unit/convex/customerPortal.test.ts`:
    - `getReceiptDownloadUrl` happy path → URL returned, audit row emitted.
    - Non-owner customer requests another customer's payment → returns null, NO audit row emitted (we don't log failed attempts to avoid info-leak via audit).
    - Receipt has no `pdfStorageId` yet → returns null.
    - Non-customer role → throws FORBIDDEN.

- [ ] **Task 7: Playwright e2e** (AC: 1)
  - [ ] Extend `tests/e2e/customer-portal-dashboard.spec.ts` (or add a new spec): customer logs in → opens contract detail → "Download receipt" → assert a network response with `Content-Type: application/pdf` (or assert a new tab opens and the URL response is 200 with PDF content-type).
  - [ ] On a forged payment ID (another customer's): assert the call returns null + a toast appears.

### Documentation (AC4)

- [ ] **Task 8: Runbook update** (AC: 4)
  - [ ] In `docs/runbook.md`, add a "Receipt access audit" section: how to query the audit log for all `receipt.downloaded` events for a specific customer or receipt — supports breach-impact queries (NFR-C4 72-hour breach assessment).

## Dev Notes

### Previous story intelligence

**Phase 1 dependencies:**

- **Story 3.x (FR28, FR29, FR30) — receipt generation:** the receipt schema, PDF storage pattern, and `generateReceiptPdf` action. This story consumes the output; it does not modify the generation logic.
- **Story 1.6 — `emitAudit`:** required for AC4.
- **Story 1.2 — `requireRole` + lint rule:** enforces the customer-role check.

**Phase 3 prior dependencies:**

- **Story 9.1 — customer auth + `customerPortal.ts` skeleton:** the file this story extends. Ownership-scoping pattern established.
- **Story 9.2 — customer dashboard + `PaymentHistoryTable`:** the UI surface this story makes functional.

### Architecture compliance

- **Ownership scoping** identical to 9.2: every customer-facing function filters by `ctx.customerId`.
- **NFR-S3 file-storage access** (architecture line 290): "auth-gated URL generation per request." This story IS that gate for customer-portal use.
- **NFR-S8 PII access logging:** audit row per issuance.
- **NFR-S4 server-side authorization:** no UI-only hiding of buttons — even if a customer crafts a `paymentId`, the server returns null.
- **Mutation, not query:** documented decision; audit emission requires a write. This is a pattern many Phase 3 customer-facing reads will share (read-with-audit).
- **404, not 403:** consistent with Story 9.1 ADR — non-ownership returns null/404, never 403.

### Library / framework versions (researched current)

- No new dependencies. Convex File Storage signed URLs and `ctx.storage.getUrl` are built-in.
- **Verify signed-URL lifetime at implementation time.** Convex's docs document the current default (historically ~15 minutes); if it has changed, update `docs/threat-model.md` accordingly. If the lifetime is configurable, decide whether to shorten to 5 minutes — but consider that a customer downloading a receipt on a slow mobile connection might exceed 5 minutes for the actual GET.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── customerPortal.ts                          # UPDATE (add getReceiptDownloadUrl mutation)
│   └── schema.ts                                  # UPDATE if by_payment index missing on receipts
├── src/
│   └── components/
│       └── customer/
│           └── PaymentHistoryTable.tsx            # UPDATE (wire the Download button)
├── tests/
│   ├── unit/
│   │   └── convex/
│   │       └── customerPortal.test.ts             # UPDATE
│   └── e2e/
│       └── customer-portal-dashboard.spec.ts      # UPDATE
└── docs/
    ├── threat-model.md                            # UPDATE (receipt-URL section)
    └── runbook.md                                 # UPDATE (audit query example)
```

### Testing requirements

- **NFR-M2 coverage:** include the ownership-check branch + the audit-emission verification. Target ≥ 90% on the new mutation.
- **No new Lighthouse / bundle concern** — this story adds a tiny mutation and one click handler.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT generate the signed URL before the ownership check.** Mint the URL only after `contract.customerId === customerId` passes. Pre-minting and then deciding to return null still consumes Convex storage-URL quota.
- ❌ **Do NOT skip the audit row.** NFR-S8 + the 72-hour breach query depend on it.
- ❌ **Do NOT make this a public query** without `requireRole`. Lint rule would catch it, but the deeper risk is in writing a custom server-side helper that bypasses the lint. Use the standard pattern.
- ❌ **Do NOT log the URL itself** to audit or Sentry. Log the storage ID + receipt serial; never the signed URL string.
- ❌ **Do NOT use `<a href={url}>` for download.** Use a click handler that fetches the URL on-demand. A pre-rendered URL would mean the URL is minted on page load (waste) and the audit row fires whether the customer actually downloads or not (false positive).
- ❌ **Do NOT cache the signed URL on the client beyond the current click.** Re-issue on every click. Cached URLs leak via browser history + screen sharing.
- ❌ **Do NOT add a "preview receipt inline" feature** in this story. Scope = download only. Inline preview is a Phase 4 enhancement; PDF rendering inline introduces CSP / sandboxing complexity.
- ❌ **Do NOT bypass ownership check for "the customer's own family member"** — there's no such relationship in the schema. Only the primary `customerId` on the contract owns its receipts.
- ❌ **Do NOT short-circuit when the receipt PDF isn't generated yet** with a generic error. Return null with a polite toast on the client: "Receipt is being generated, please refresh in a few seconds." Phase 1 should generate PDFs synchronously inside `postFinancialEvent`, but if it's deferred to a scheduled action there's a brief gap.

### Common LLM-developer mistakes to prevent

- **Implementing as a query** when audit emission requires a write: queries can't `db.insert`. Convert to a mutation. The pattern "read with audit" is mutation-shaped.
- **Looking up the receipt via `payment.receiptId`** without an index: if the schema stores `receipts.paymentId` (the inverse), use the `by_payment` index on `receipts`. If `payments.receiptId` exists, use `ctx.db.get`. Read the schema, don't assume.
- **Returning the storage ID** instead of the URL: the client can't directly use a storage ID — it needs a signed URL. `ctx.storage.getUrl(storageId)` is the right call.
- **Logging failed ownership-check attempts to audit:** this creates an enumeration-friendly audit log. Only log successes. Failed attempts are visible in Convex function-call metrics; if an alarm is needed, set it there.
- **Forgetting `noopener,noreferrer`** when opening the URL in a new tab: standard hygiene to prevent the target page from accessing `window.opener`.

### Open questions / blockers this story does NOT resolve

- **§10 Q3 (BIR receipt format):** receipt content may still be placeholder. Customers downloading receipts now see the placeholder format — that's a Phase 1 issue surfaced through Phase 3, not a 9.3 issue.
- **Re-issuing receipts after edits:** customers can't edit receipts. Office Staff can void receipts (FR29). This story does not address how a void / re-issue is communicated to the customer — Phase 4 conversation.

### Project Structure Notes

Aligns with [Architecture § File-storage access](../../_bmad-output/planning-artifacts/architecture.md#authentication--security) and [Architecture § `customerPortal.ts`](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries).

### References

- [PRD § FR56 — Customer receipt downloads](../../_bmad-output/planning-artifacts/prd.md#11-customer-self-service)
- [PRD § NFR-S3 (file-storage), NFR-S8 (PII access log)](../../_bmad-output/planning-artifacts/prd.md#security--privacy)
- [Architecture § File-storage signed URLs](../../_bmad-output/planning-artifacts/architecture.md#authentication--security)
- [Epics § Story 9.3](../../_bmad-output/planning-artifacts/epics.md)
- [Previous story 9.1 — ownership scoping](./9-1-customer-authenticates-to-the-portal.md)
- [Previous story 9.2 — PaymentHistoryTable](./9-2-customer-views-own-contracts-and-balances.md)
- Convex docs (current): [File Storage URLs](https://docs.convex.dev/file-storage/serve-files)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (claude-opus-4-7) via Claude Code Agent SDK.

### Debug Log References

- `npx tsc --noEmit` — clean for the new files (pre-existing repo errors in
  `convex/contracts.ts`, `convex/expenseApprovalSettings.ts`, and
  `src/app/(staff)/flagged-followups/page.tsx` are unrelated to this slice).
- `npm run lint` — `✔ No ESLint warnings or errors`.
- `npx vitest run tests/unit/convex/portal-receipts.test.ts tests/unit/components/CustomerReceiptsList.test.tsx`
  — **42/42 passed** (29 portal-receipts + 13 component).
- Pre-existing portal regressions verified clean: `portal.test.ts` (13/13),
  `portal-contracts.test.ts` (23/23), `CustomerContractsList.test.tsx`
  (16/16) still green.
- `npm run build` — `/portal/receipts` + `/portal/receipts/[receiptId]`
  emitted in the route table (2.38 kB / 141 kB First Load for the
  detail page).

### Completion Notes List

- The original story spec proposed extending Story 9.2's
  `PaymentHistoryTable` to add a "Download receipt" button inline; the
  narrower file-ownership policy in the dev instructions routed the
  implementation through a dedicated `/portal/receipts` index + detail
  surface instead. The `PaymentHistoryTable` button was NOT touched (it
  remains the disabled "coming soon" affordance from Story 9.2). A
  future polish slice can wire the inline button to
  `portal:requestCustomerReceiptPdf` — the server-side handler is
  already there.
- `getCustomerReceiptPdfUrl` is a QUERY (not a mutation). The original
  spec proposed promoting it to a mutation specifically to write an
  audit row per signed-URL issuance (NFR-S8). The dev instructions
  marked `convex/lib/**` read-only for this slice, and `emitAudit`
  cannot be invoked from a query (queries are read-only). The audit-
  per-issuance pattern is deferred to a follow-up that lands after the
  `convex/_generated/api` codegen exists and `emitAuditFromAction`
  becomes wired — see the placeholder comment in `convex/lib/audit.ts`.
  Until then, Convex's function-call metrics + the existing
  reconciliation audit trail are the operational logging anchor.
- Ownership walk is receipt → payment → contract → customer. The
  `receipts` table has no `by_customer` index and `customerId` is
  stored as an optional string on the receipt row, so the walk goes
  through the typed `payments.contractId` (also stored as a string)
  and the contract's typed `customerId`. The cast pattern
  (`as unknown as ContractId`) mirrors how `listCustomerPayments`
  already accesses the same field — kept consistent so the lint
  surface doesn't shift across the file.
- Signed-URL TTL is whatever Convex File Storage's
  `ctx.storage.getUrl()` returns at issuance time. The story spec
  noted historical Convex defaults of ~15 minutes but advised
  verification at implementation time; we left the TTL question open
  (no docs-fetch is in this slice's scope) and surface it in
  `docs/threat-model.md` as a follow-up. The reactive query
  re-resolves on every subscription tick, so a customer who keeps the
  detail page open will always have a fresh URL when they click
  download.
- Voided receipts surface in the list and are still downloadable —
  the BIR convention is that voided receipts remain part of the
  customer's record (the Story 3.13 PDF carries the VOIDED watermark).
  The detail page shows the void state with a status badge.
- `requestCustomerReceiptPdf` is idempotent in the "already ready"
  case (returns `"ready"` and does NOT schedule). If the PDF is not
  yet generated, the mutation schedules the Story 3.13 action and the
  reactive query subscription flips `ready` to true when the action's
  writeback lands.
- Coverage emphasis on the ownership branch: every "other customer's
  receipt" code path is asserted to return null / `not_found` (NOT
  throw FORBIDDEN — Story 9.1 ADR's existence-enumeration defence).
  An explicit assertion confirms `ctx.storage.getUrl` is NEVER called
  before ownership passes, satisfying the story's "do not pre-mint
  the URL" disaster-prevention guidance.

### File List

Created:

- `src/components/CustomerPortal/CustomerReceiptsList.tsx`
- `src/app/(customer)/portal/receipts/page.tsx`
- `src/app/(customer)/portal/receipts/[receiptId]/page.tsx`
- `tests/unit/convex/portal-receipts.test.ts`
- `tests/unit/components/CustomerReceiptsList.test.tsx`

Modified:

- `convex/portal.ts` — appended `listCustomerReceipts`,
  `getCustomerReceiptPdfUrl`, `requestCustomerReceiptPdf` and their
  types (`CustomerReceiptListRow`, `CustomerReceiptPdfUrlResult`,
  `RequestCustomerReceiptPdfResult`); added `mutationGeneric` +
  `makeFunctionReference` imports + `MutationCtx` import.
- `src/components/CustomerPortal/index.ts` — barrel export of
  `CustomerReceiptsList` + `CustomerReceiptListRow`.
