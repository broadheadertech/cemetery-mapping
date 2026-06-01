# Story 3.13: Receipts Are Print/Email-able as PDF

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **Maria (Office Staff)**,
I want **to print a previously-issued receipt to the office printer and email it to the customer as a PDF — from anywhere I can see a receipt (contract detail, receipt detail page, audit log)**,
so that **customers who lost their copy or need it sent to their daughter overseas can get the official document quickly, without me having to re-record the payment** (FR30, FR31, UX-DR11).

This story builds the **`ReceiptViewer` component** that's referenced across the system (used at minimum in: contract detail's payments list, the receipt detail page, the receipt preview modal from Story 3.9, and Phase 2's audit log read UI). It also adds the **email side channel** for the first time — the receipt is the cemetery's first outbound email surface; the same email plumbing extends to Phase 3 reminders.

The cornerstone constraint is **FR31 immutability**: once issued, a receipt's underlying payment is immutable. This story exposes Print / Email / Download / View Void — all read or side-channel operations. Modifying a receipt is NOT in scope; the void workflow is Story 3.12's responsibility.

## Acceptance Criteria

1. **AC1 — `ReceiptViewer` component renders a receipt in two variants**: A new component at `src/components/ReceiptViewer/ReceiptViewer.tsx` accepts `{ receiptId: Id<"receipts">, mode: "inline" | "modal-preview" }`. **Inline mode** (full page): renders the receipt PDF in a `<iframe>` (browser-native PDF viewer, not an image render) with a toolbar above it containing Print, Email, Download, and (admin-only) Void actions, plus an issuance-metadata footer showing serial, issuance timestamp (Manila tz), and issued-by user name. **Modal-preview mode**: a compact rendering of the receipt content for the in-form preview before issuance (used by Story 3.9's receipt preview modal); no toolbar; no PDF iframe (uses styled-HTML preview since the PDF doesn't exist pre-issuance).

2. **AC2 — Print opens the browser native print dialog with the PDF loaded**: Clicking "Print" loads the PDF into a hidden `<iframe>` (or the existing visible iframe), waits for `onLoad`, then calls `iframe.contentWindow?.print()`. Browsers that block iframe-print fall back to `window.open(pdfUrl, "_blank")` and let the user trigger print from there. The print action is **always available** regardless of receipt status (voided receipts can be printed too — they print with the VOIDED watermark per Story 3.12).

3. **AC3 — Email sends the receipt PDF to a recipient address via the configured email provider**: Clicking "Email" opens a small `<Dialog>` with: recipient email field (pre-filled with the customer's email if on file via Convex query — fetched only when the dialog opens, with `requireRole` enforced server-side; uses `readPii` since the email is PII), optional message (textarea, 3 rows, default "Please find your official receipt attached"), and Send button. On submit, a Convex action `sendReceiptEmail(receiptId, recipientEmail, message?)` runs server-side: fetches the receipt PDF from Convex File Storage, calls the configured email provider's API, attaches the PDF, sends. On success, the dialog closes and an inline confirmation appears below the receipt toolbar: "Receipt #0001234 emailed to mrs.cruz@..." for 5 seconds before fading.

4. **AC4 — Download triggers a PDF file download**: Clicking "Download" calls `ctx.storage.getUrl(receipt.pdfStorageId)` and triggers a browser download via an `<a download>` element clicked programmatically. The downloaded filename is `receipt-{serial}-{customer-lastname}.pdf` (sanitized). Auth-gated per NFR-S3 — no public URL exposure.

5. **AC5 — Voided receipts render with VOIDED state visible AND immutability messages**: If `receipt.isVoided === true`, the iframe loads the regenerated PDF (with VOIDED watermark from Story 3.12), AND a banner above the iframe shows: "Voided on {date} by {actor} — reason: {reason category} ({reason text})." The Print / Email / Download buttons remain functional (users can still distribute the voided receipt for audit purposes), but a footer note clarifies: "This receipt is voided. The voided serial cannot be re-issued; if a replacement is needed, record a new payment." No "edit" or "amend" action is exposed (FR31 immutability).

6. **AC6 — Email failure surfaces inline and does NOT compromise the receipt**: If the email provider returns an error (provider down, invalid address, attachment too large), the action throws `ConvexError({ code: "EMAIL_SEND_FAILED", message: "Email could not be sent. Verify the address and try again." })`. The receipt itself is untouched (the email is a side channel — never part of the financial mutation). The email-attempt is logged in a new `emailDeliveryAttempts` audit-companion table with `{ receiptId, recipientEmail, status: "failed", errorReason, attemptedAt, attemptedBy }`. UX: the dialog stays open with the inline error; user can edit and retry.

7. **AC7 — `recordPayment` flow (Story 3.9) refactored to use `ReceiptViewer`**: Story 3.9's PaymentForm currently has its own iframe-print code. After this story, PaymentForm's post-submit flow opens `<ReceiptViewer mode="inline" receiptId={result.receiptId} />` in a Sheet (or full-page navigation) which provides the same Print / Email / Download surface. This eliminates code duplication and ensures Story 3.9's print flow uses the same component as every other receipt surface.

## Tasks / Subtasks

### Email infrastructure (AC3, AC6)

- [ ] **Task 1: Choose + configure the email provider** (AC: 3)
  - [ ] Architecture-locked decision is "Phase 3 — Resend, SendGrid, or similar." This story needs email in Phase 1. **Recommendation:** Resend (simplest API, ₱-friendly free tier of 3,000 emails/month, no Twilio-style merchant onboarding). Document the decision in `docs/adr/0010-email-provider-receipts.md`.
  - [ ] Add `npm install resend` (or chosen alternative).
  - [ ] Required env vars:
    - `RESEND_API_KEY` (or equivalent — server-side; Vercel + Convex env-var stores, never gitignored secret).
    - `RECEIPT_EMAIL_FROM` (e.g. `"Broadheader Memorial Park <receipts@broadheader.example.ph>"`) — requires the cemetery to verify their sending domain with Resend (one-time DNS records). **Flag this as client-side procurement: ~1 day from request to verified.**
  - [ ] If `RESEND_API_KEY` is unset in dev environments, the action throws a clear setup error: "Email provider not configured. Set RESEND_API_KEY in .env.local."
  - [ ] Update README's "Environment values" section.

- [ ] **Task 2: Implement `sendReceiptEmail` action in `convex/actions/sendReceiptEmail.ts`** (AC: 3, AC: 6)
  - [ ] Convex action with `"use node"` (Node runtime — needs to call Resend's SDK + handle Buffer for the PDF attachment).
  - [ ] First line: `await requireRole(ctx, ["office_staff", "admin"])`.
  - [ ] Args via `v.object`: `{ receiptId: v.id("receipts"), recipientEmail: v.string(), message: v.optional(v.string()) }`.
  - [ ] Validate `recipientEmail` matches a simple email regex (defense-in-depth; provider does its own validation).
  - [ ] Fetch receipt via `ctx.runQuery(internal.receipts.getReceiptForEmail, { receiptId })` — internal query that returns the receipt's serial, customer ID, pdfStorageId, isVoided status.
  - [ ] Fetch the PDF blob from Convex File Storage: `const pdfBlob = await ctx.storage.get(receipt.pdfStorageId);` then read to a Buffer.
  - [ ] Compose email:
    - `from`: `process.env.RECEIPT_EMAIL_FROM`.
    - `to`: `[args.recipientEmail]`.
    - `subject`: `"Receipt #" + serial + (receipt.isVoided ? " (VOIDED)" : "") + " — Broadheader Memorial Park"`.
    - `text`: a plain-text body including the message (default: "Please find your official receipt attached") + cemetery contact info.
    - `attachments`: `[{ filename: 'receipt-{serial}.pdf', content: pdfBuffer }]`.
  - [ ] Call Resend SDK; await response.
  - [ ] On success: `ctx.runMutation(internal.receipts.logEmailDelivery, { receiptId, recipientEmail, status: "sent", messageId: response.id, attemptedBy: callerUserId })`.
  - [ ] On failure: catch error, log via the same internal mutation with `status: "failed"` + `errorReason`, then re-throw as `ConvexError("EMAIL_SEND_FAILED", "Email could not be sent. Verify the address and try again.", { providerError: error.message })`.
  - [ ] Return `{ success: true, messageId }` or throw on failure.

- [ ] **Task 3: Add `emailDeliveryAttempts` table to `convex/schema.ts`** (AC: 6)
  - [ ] Fields: `receiptId: v.id("receipts")`, `recipientEmail: v.string()`, `status: v.union(v.literal("sent"), v.literal("failed"))`, `messageId: v.optional(v.string())` (provider's), `errorReason: v.optional(v.string())`, `attemptedAt: v.number()`, `attemptedBy: v.id("users")`.
  - [ ] Index: `.index("by_receipt", ["receiptId"])` for "show me all email attempts for this receipt" admin query.
  - [ ] Note: this is NOT the audit log (which is for financial mutations only). It's a side-channel delivery log.

- [ ] **Task 4: Add `logEmailDelivery` internal mutation** (AC: 6)
  - [ ] Location: `convex/receipts.ts` (UPDATE — file exists from Story 3.2/3.11).
  - [ ] `internalMutation` (server-to-server only; not callable from client).
  - [ ] Inserts into `emailDeliveryAttempts`.

### Receipt viewer component (AC1, AC2, AC4, AC5)

- [ ] **Task 5: Implement `ReceiptViewer` component** (AC: 1, AC: 5)
  - [ ] Location: `src/components/ReceiptViewer/ReceiptViewer.tsx` (folder per component).
  - [ ] Props: `{ receiptId: Id<"receipts">, mode: "inline" | "modal-preview" }`.
  - [ ] Inline mode layout:
    ```
    ┌─────────────────────────────────────────────────┐
    │ Receipt #{serial}                               │
    │ [Print] [Email] [Download] [Void (admin)]      │
    ├─────────────────────────────────────────────────┤
    │ (voided banner if applicable)                  │
    │ ┌─────────────────────────────────────────────┐│
    │ │ <iframe src={pdfUrl} title="Receipt PDF"/> ││
    │ │ (browser-native PDF viewer)                 ││
    │ └─────────────────────────────────────────────┘│
    ├─────────────────────────────────────────────────┤
    │ Issued: {date} by {user} | Status: {Active/Voided}│
    └─────────────────────────────────────────────────┘
    ```
  - [ ] Modal-preview mode: styled-HTML preview of the receipt content (no PDF — used before issuance per Story 3.9's flow). Reuses the same template-config-driven layout from Story 3.11.
  - [ ] Fetch the receipt + signed PDF URL via `useQuery(api.receipts.getReceiptForViewing, { receiptId })`. The query is reactive; void state changes propagate.
  - [ ] If `pdfStatus === "pending"` (PDF still being generated from Story 3.11's deferred action), show a `Skeleton` + "Receipt PDF is generating..." inline; auto-refreshes when query updates.
  - [ ] Below the iframe (inline mode), provide a collapsible "Text version" `<details>` element containing the receipt's key fields in plain text — for screen-reader users (PDF in iframe is not natively screen-reader-friendly; this is the NFR-A1 accessibility accommodation).

- [ ] **Task 6: Implement the Print button + iframe pattern** (AC: 2)
  - [ ] On click: ensure the iframe is fully loaded (`onLoad` fired); call `iframe.contentWindow?.print()`.
  - [ ] If `iframe.contentWindow` is null (cross-origin or browser quirk), fall back: `window.open(pdfUrl, "_blank")` and rely on the user to print from the new tab.
  - [ ] The "Print" button itself has the standard 44+px touch target; for keyboard users it's tab-focusable + Enter-activatable.

- [ ] **Task 7: Implement the Email dialog + send flow** (AC: 3, AC: 6)
  - [ ] On "Email" button click: open a `<Dialog>` with form (React Hook Form + Zod):
    ```ts
    const schema = z.object({
      recipientEmail: z.string().email("Please enter a valid email address"),
      message: z.string().max(500).optional(),
    });
    ```
  - [ ] Pre-fill `recipientEmail` from `useQuery(api.customers.getCustomerEmailForReceipt, { receiptId })` — server-side query that uses `readPii` to log the access and returns the customer's email if on file. If not on file, field starts empty.
  - [ ] On submit: `useAction(api.actions.sendReceiptEmail.sendReceiptEmail)` with args; await result.
  - [ ] On success: close dialog; show inline "Receipt emailed to {recipientEmail}" below the receipt toolbar for 5 seconds (fade out).
  - [ ] On failure: dialog stays open; show inline error (translated by `src/lib/errors.ts` translation layer); user can edit and retry.
  - [ ] Idempotency: Resend's API is idempotent on `idempotencyKey` header — pass a stable key generated per dialog mount (Resend allows up to 1-hour dedup).

- [ ] **Task 8: Implement the Download action** (AC: 4)
  - [ ] On click: fetch the signed PDF URL (already in query result); create an `<a>` element with `href={pdfUrl}` and `download={filename}`; programmatically `.click()` it; remove the element.
  - [ ] Filename helper: `receipt-{serial}-{customer-lastname-sanitized}.pdf`. Customer last name fetched from the same `getReceiptForViewing` query result; sanitize to ASCII alphanumeric + dashes only (avoids cross-platform filename issues).

- [ ] **Task 9: Render the voided state correctly** (AC: 5)
  - [ ] If `receipt.isVoided`, render a banner above the iframe with `bg-amber-50 text-amber-900 border border-amber-200` (per UX § Visual Foundation for voided/cancelled tone):
    ```
    ⓘ This receipt is voided.
    Voided on 17 May 2026 by Mr. Reyes — reason: data entry error
    The voided serial (#0001234) cannot be re-issued. To replace, record a new payment.
    ```
  - [ ] The PDF in the iframe already has the VOIDED watermark from Story 3.12.
  - [ ] No additional UI changes — Print / Email / Download all remain functional for the voided receipt (audit / customer copy use cases).

### Server-side queries (AC1, AC5)

- [ ] **Task 10: Add `getReceiptForViewing` query in `convex/receipts.ts`** (AC: 1, AC: 5)
  - [ ] First line: `await requireRole(ctx, ["office_staff", "admin"])` (customers fetch their receipts via `convex/customerPortal.ts` in Story 9.3 — different surface).
  - [ ] Args: `{ receiptId: v.id("receipts") }`.
  - [ ] Returns: `{ id, serial, issuedAt, issuedBy, isVoided, voidedReason?, voidedBy?, voidedAt?, pdfStorageId, pdfStatus, customerName, contractId, paymentAmountCents, paymentMethod, signedPdfUrl }`.
  - [ ] Build the signed PDF URL via `ctx.storage.getUrl(receipt.pdfStorageId)`.
  - [ ] Reactive — void status propagates to the UI when an admin voids the receipt elsewhere.

- [ ] **Task 11: Add `getCustomerEmailForReceipt` query in `convex/receipts.ts`** (AC: 3)
  - [ ] `requireRole(["office_staff", "admin"])`.
  - [ ] Args: `{ receiptId: v.id("receipts") }`.
  - [ ] Returns the customer's email if on file via `readPii(ctx, customerId, ["email"])` (Story 2.3's PII helper — logs access).
  - [ ] Returns `null` if no email on file.

- [ ] **Task 12: Add `internal.receipts.getReceiptForEmail` query** (AC: 3)
  - [ ] `internalQuery` — called by the `sendReceiptEmail` action only; not client-callable.
  - [ ] Returns the minimal data the action needs: `{ serial, pdfStorageId, isVoided, customerId }`. Customer name + email are NOT included — the action uses `recipientEmail` from the caller, not the customer record (allows sending to any address the user types, e.g. a daughter's email, not just the registered customer's email).

### Build the receipt detail page (AC1)

- [ ] **Task 13: Build `/receipts/[receiptId]` page** (AC: 1)
  - [ ] Location: `src/app/(staff)/receipts/[receiptId]/page.tsx`.
  - [ ] Server component does auth + URL-param parsing; renders `<ReceiptViewer mode="inline" receiptId={receiptId} />` as the page's main content.
  - [ ] Breadcrumb: `Receipts › #0001234` (per UX § Navigation Patterns).
  - [ ] Page is reactive — voiding the receipt from elsewhere (Story 3.12's void admin UI) updates this page live.

### Refactor PaymentForm to use ReceiptViewer (AC7)

- [ ] **Task 14: Refactor Story 3.9's post-submit flow** (AC: 7)
  - [ ] Story 3.9's PaymentForm currently opens the print dialog inline via an iframe after `recordPayment` succeeds. Update that flow:
    1. After `recordPayment` returns successfully with `{ paymentId, receiptId, receiptSerial }`.
    2. Navigate to `/receipts/[receiptId]` (the detail page from Task 13) — passes through the full `ReceiptViewer` flow.
    3. ReceiptViewer's effect on mount: auto-trigger Print if `?autoprint=true` query param is present (Story 3.9 passes this).
  - [ ] This eliminates the duplicate iframe-print code in PaymentForm. The "deliberate pause" pattern from Story 3.9 (the receipt-preview modal BEFORE submit) is unchanged — that modal still uses `<ReceiptViewer mode="modal-preview">`.

### Tests (AC1–AC7)

- [ ] **Task 15: Vitest unit tests** (AC: 3, AC: 6)
  - [ ] Location: extend `tests/unit/convex/receipts.test.ts` (UPDATE).
  - [ ] Cases for `sendReceiptEmail`:
    - **Happy path:** Mocked Resend SDK returns success → action returns `{ success: true }`; `emailDeliveryAttempts` row inserted with `status: "sent"`.
    - **Provider failure:** Mocked Resend throws → action throws `ConvexError("EMAIL_SEND_FAILED")`; `emailDeliveryAttempts` row inserted with `status: "failed"` and `errorReason`.
    - **Auth:** Customer role → `FORBIDDEN` (this query is staff/admin only — customers get receipts via Story 9.3's portal flow).
    - **Validation:** Invalid email format → `INVALID_EMAIL_FORMAT`.
    - **Voided receipt:** Action proceeds; subject includes "(VOIDED)".
  - [ ] Cases for `getReceiptForViewing`:
    - Returns expected shape; URL is non-empty; customer name resolved.
    - Voided receipt returns voidedReason + voidedBy + voidedAt populated.

- [ ] **Task 16: Vitest component test for `ReceiptViewer`** (AC: 1, AC: 5)
  - [ ] Location: `src/components/ReceiptViewer/ReceiptViewer.test.tsx`.
  - [ ] Render inline mode with a mocked receipt → asserts iframe with `src` matching the PDF URL, all four buttons visible.
  - [ ] Render inline mode with a voided receipt → asserts voided banner is visible with reason and timestamp.
  - [ ] Render modal-preview mode → asserts no iframe, no toolbar; just the styled-HTML preview.
  - [ ] axe-core scan → passes WCAG 2.1 AA.

- [ ] **Task 17: Playwright E2E spec** (AC: 2, AC: 3)
  - [ ] Location: `tests/e2e/journey-2-receipt-reprint.spec.ts`.
  - [ ] Steps:
    1. Seed: an existing issued receipt.
    2. Sign in as Office Staff.
    3. Navigate to `/receipts/{receiptId}`.
    4. Assert: iframe loads PDF; toolbar buttons visible.
    5. Click "Email"; modal opens with email field pre-filled (or empty).
    6. Type a test email; click Send.
    7. Mock the email provider via Playwright network interception OR use Resend's test mode if available.
    8. Assert: dialog closes; inline confirmation appears.
  - [ ] Second test: voided receipt rendering.
    1. Seed a voided receipt.
    2. Navigate to its page.
    3. Assert: voided banner visible with reason text; iframe still loads (with the voided-watermark PDF).

### Documentation

- [ ] **Task 18: ADR + README + runbook updates** (AC: 3)
  - [ ] Write `docs/adr/0010-email-provider-receipts.md`: documents the choice of Resend (or alternative), the env var contract, the sender-domain verification requirement, the trade-off vs deferring to Phase 3 (we needed email in Phase 1 for receipts; this is the smallest viable add).
  - [ ] README: add "Receipt email" section under Daily Workflows.
  - [ ] If `docs/runbook.md` exists, add: "If email delivery fails: check Resend dashboard for bounces; verify sender domain DNS; if widespread, set `EMAIL_PROVIDER_DISABLED=true` to surface a clear 'email temporarily disabled' message to staff."

## Dev Notes

### Previous story intelligence — Strong dependencies

- **Story 1.1** — auth + login + Vercel/Convex env-var infrastructure (where `RESEND_API_KEY` lives).
- **Story 1.2** — `requireRole`; mandatory first line of all functions.
- **Story 1.4** — `ReactiveHighlight` (used for the "Email sent" confirmation fade), `StatusPill` (for receipt status), Tailwind tokens, `useManilaNow`/`formatDate` helpers for issuance timestamp.
- **Story 1.6** — `emitAudit`. NOTE: emailing a receipt is a side channel, NOT a financial mutation; it doesn't write to `auditLog` (which is reserved for financial-touching ops per architecture's append-only invariant). Email delivery goes to its own `emailDeliveryAttempts` table.
- **Story 2.3** — `readPii(ctx, customerId, fields)` helper. `getCustomerEmailForReceipt` uses it; pre-filling the email field is a logged PII access.
- **Story 3.1** — `receiptCounter` (existing serials are immutable; this story can't issue new ones).
- **Story 3.2** — `postFinancialEvent` (already wrote the receipts this story displays).
- **Story 3.9** — PaymentForm + initial print dialog. THIS story refactors that print dialog to use `ReceiptViewer`. Verify 3.9 is complete before refactoring.
- **Story 3.11** — BIR receipt PDF generation. THIS story consumes the PDFs; if 3.11 is still pending, ReceiptViewer's "Receipt PDF is generating..." skeleton handles the wait.
- **Story 3.12** — Receipt void with reason. THIS story renders the voided state. Verify the `voidedReason`, `voidedBy`, `voidedAt` fields exist on the receipt record.

### Architecture compliance

- **No new financial writes** — this story is print + email + download + display. Receipts and payments are read-only here. FR31 immutability respected.
- **No public PDF URLs** (NFR-S3) — all PDF access via `ctx.storage.getUrl` which returns short-lived signed URLs.
- **PII access is logged** — pre-filling the recipient email triggers `readPii`; the email-send-attempt is logged in `emailDeliveryAttempts` (which is itself queryable by an admin if "we said we emailed this customer; here's the proof" is needed).
- **Idempotent email retry** — Resend's API supports idempotency keys; we use them. NFR-I3-adjacent (the Phase 3 NFR is for SMS/email reminders, but the same retry principle applies here).
- **Async, side-channel** — `sendReceiptEmail` is an action, not part of any financial mutation. It can fail; the receipt is untouched. NFR-R5-aligned (financial mutations atomic; side-channels separate).
- **`ReceiptViewer` is a domain component** per architecture's three-layer model (Layer 3: domain), composed of Layer 2 primitives (`Dialog`, `Button`, `Input`).

### Library / framework versions

- **Resend SDK** — `npm install resend`. Verify current API: https://resend.com/docs/api-reference/emails/send-email. The SDK supports attachments (`attachments: [{ filename, content: Buffer }]`).
- **Browser-native iframe printing** — `iframe.contentWindow.print()`. Modern browsers support this; some (Safari iOS) have quirks; Playwright tests should run cross-browser to catch.
- **`<a download>` attribute** — built-in.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── actions/
│   │   └── sendReceiptEmail.ts                        # NEW ("use node" action)
│   ├── receipts.ts                                    # UPDATE — add getReceiptForViewing,
│   │                                                  #          getCustomerEmailForReceipt,
│   │                                                  #          internal getReceiptForEmail,
│   │                                                  #          logEmailDelivery
│   └── schema.ts                                      # UPDATE — add emailDeliveryAttempts table + index
├── src/
│   ├── app/(staff)/receipts/[receiptId]/page.tsx      # NEW — receipt detail page
│   └── components/
│       └── ReceiptViewer/
│           ├── ReceiptViewer.tsx                      # NEW
│           ├── EmailReceiptDialog.tsx                 # NEW (sub-component, isolated for testability)
│           ├── VoidedBanner.tsx                       # NEW (small sub-component)
│           ├── ReceiptViewer.test.tsx                 # NEW
│           └── index.ts                               # NEW
├── tests/
│   ├── unit/convex/receipts.test.ts                   # UPDATE — extend with email + view tests
│   └── e2e/journey-2-receipt-reprint.spec.ts          # NEW
├── docs/adr/0010-email-provider-receipts.md           # NEW
└── README.md                                          # UPDATE — env vars section, Daily Workflows
```

**Refactor in Story 3.9 files:**

- `src/components/PaymentForm/PaymentForm.tsx` — UPDATE: replace the inline iframe-print logic with a navigate-to-receipt-page flow.

**Total: 9 NEW files, 4 UPDATE files (including 3.9 refactor).**

### Testing requirements

- **NFR-M2** (≥ 90% financial code coverage) does NOT apply here — email send is a side channel, not financial. Target ≥ 80% on `sendReceiptEmail` action; ≥ 90% on the queries (`getReceiptForViewing` is read-only but customer-facing).
- **axe-core** on the receipt detail page; the iframe needs `title` attribute, the voided banner needs proper role/landmark, the screen-reader-friendly text version `<details>` element needs to be discoverable.
- **Cross-browser print test** is essential; Safari/iOS iframe-print quirks are notorious.

### Source references

- [PRD § Functional Requirements > FR30 (print/email PDF), FR31 (immutability)](../../_bmad-output/planning-artifacts/prd.md)
- [PRD § Non-Functional Requirements > NFR-S3 (file storage auth-gated), NFR-I3 (provider retry pattern — applied here)](../../_bmad-output/planning-artifacts/prd.md)
- [Architecture § Core Architectural Decisions > Integration Requirements](../../_bmad-output/planning-artifacts/architecture.md#integration-requirements)
- [Architecture § Implementation Patterns > Form Patterns + Modal & Overlay Patterns](../../_bmad-output/planning-artifacts/architecture.md#implementation-patterns--consistency-rules)
- [UX § Component Strategy > ReceiptViewer (UX-DR11)](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [UX § UX Consistency Patterns > Modal & Overlay Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#ux-consistency-patterns)
- [Epics § Story 3.13](../../_bmad-output/planning-artifacts/epics.md)
- Previous stories: [3.2](./3-2-postfinancialevent-cornerstone.md) · [3.9](./3-9-office-staff-records-a-payment-with-auto-allocation.md) · [3.11](./3-11-system-generates-bir-compliant-receipts.md) · [3.12](./3-12-office-staff-voids-a-receipt-with-reason.md)
- Resend docs: https://resend.com/docs

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT generate the PDF in the email action.** The PDF already exists from Story 3.11 (or is being generated async). Fetch from Convex File Storage; never re-generate. Re-generation would produce a different file timestamp than the issued receipt, breaking the immutability principle.
- ❌ **Do NOT expose the raw PDF storage ID** in any URL or JSON response. Only `ctx.storage.getUrl` signed URLs leave the server (NFR-S3).
- ❌ **Do NOT write to `auditLog`** for email-send attempts. `auditLog` is reserved for financial-touching mutations per the append-only invariant (Story 1.6). Email attempts go to `emailDeliveryAttempts`.
- ❌ **Do NOT block the receipt page if email fails.** The receipt is a financial document; email is a side channel. If the provider is down, Print and Download still work. Disable only the Email button (with a tooltip) if `EMAIL_PROVIDER_DISABLED=true` env var is set.
- ❌ **Do NOT auto-send email on receipt issuance** in this story. Auto-email-on-issue might be a future feature, but for now Email is an explicit user action. (If the cemetery wants auto-email on issue, that's a config-driven Phase 2 enhancement, not a Phase 1 default.)
- ❌ **Do NOT include the receipt PDF inline in the email body.** Use attachment. Some clients (older Outlook) render inline PDFs poorly; the attachment is universal.
- ❌ **Do NOT use `mailto:` links** as a fallback. They route through the user's mail client, which doesn't have the PDF attachment in hand. Mailto would be downloading the PDF then asking the user to attach it — bad UX. Direct server-send only.
- ❌ **Do NOT skip the "Text version" `<details>` block.** PDFs in iframes are screen-reader hostile. WCAG 2.1 AA compliance (NFR-A1) requires an accessible alternative.
- ❌ **Do NOT remove the Print/Email/Download buttons for voided receipts.** They remain functional — voided receipts are legitimate documents that may need to be re-sent (e.g. a customer asks for proof of the void).
- ❌ **Do NOT use the customer's registered email without explicit confirmation.** Pre-fill is fine; sending requires the user to click Send (NOT auto-send to the pre-filled address).

### Common LLM-developer mistakes to prevent

- **Reinventing wheels:** Use the Resend SDK; do not hand-roll HTTP requests to their API. The SDK handles auth, retries, and error shapes.
- **Wrong action runtime:** `sendReceiptEmail` needs `"use node"` because Resend's SDK uses Buffer + fetch with multipart. V8 runtime would fail.
- **Wrong storage API:** `ctx.storage.get(storageId)` returns a Blob; you need to convert to a Buffer for Resend's attachment. Pattern: `const blob = await ctx.storage.get(id); const arrayBuf = await blob.arrayBuffer(); const buffer = Buffer.from(arrayBuf);`
- **Customer email leak in error messages:** If validation fails, the error message must not echo the email. "Invalid email address" not "Email 'mrs.cruz@bad.example' is invalid."
- **iframe sandbox attributes:** Don't add `sandbox` attribute to the iframe — it blocks `contentWindow.print()`. The iframe loads a same-origin (signed Convex URL); cross-origin print blocking doesn't apply.
- **Idempotency key generation:** Generate once per dialog mount with `useState(() => crypto.randomUUID())`. Multiple submit clicks reuse the same key; Resend dedups for 1 hour.
- **Filename sanitization:** Don't include the customer name verbatim — sanitize to ASCII alphanumeric + dashes. Otherwise non-Latin characters break some file systems.

### Open questions / blockers this story does NOT resolve

- **None block this story.** The §10 client gates don't affect receipt distribution (the receipt FORMAT is gated on Q3, handled in Story 3.11; the distribution mechanism is universal).
- **Client-side procurement noted:** Resend (or chosen provider) needs the cemetery to verify their sending domain via DNS. ~1 day end-to-end if the cemetery's IT can update DNS records quickly. **Flag this before dev starts.**
- **Phase 3 alignment:** This story's email plumbing extends naturally to Phase 3 reminders (Story 9.7/9.8). The `sendReceiptEmail` action pattern is reused as `sendReminderEmail`; the same provider config applies. No re-architecting at Phase 3 kickoff.

### Project-specific environment values

- **Existing (from Story 1.1):** `CONVEX_DEPLOYMENT`, `NEXT_PUBLIC_CONVEX_URL`, `SEED_ADMIN_PASSWORD`.
- **NEW in this story:**
  - `RESEND_API_KEY` (Convex env var; never client-side).
  - `RECEIPT_EMAIL_FROM` (Convex env var; e.g. `"Broadheader Memorial Park <receipts@broadheader.example.ph>"`).
- **Setup procedure:** The cemetery's IT/admin creates a Resend account, verifies the sending domain (DNS records), generates an API key, sets the env vars via `npx convex env set RESEND_API_KEY <value>`. Documented in README.

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure & Boundaries](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries) — `convex/actions/sendReceiptEmail.ts` lives in the existing actions folder; `src/components/ReceiptViewer/` is one of the named domain components.
- [Architecture § Implementation Patterns > Service Boundary](../../_bmad-output/planning-artifacts/architecture.md#implementation-patterns--consistency-rules) — Node-runtime actions for external services (Resend) is the correct boundary.

No conflicts.

### References

All references listed in § Source references above.

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (claude-opus-4-7) via Claude Code, 2026-05-20 session.

### Debug Log References

- `npm run typecheck` — clean (after fixing the `DataModel["_storage"]`
  reference; switched to
  `NonNullable<DataModel["receipts"]["document"]["pdfStorageId"]>` to
  match the existing pattern in
  `convex/actions/generateContractPdf.ts`).
- `npm run lint` — clean (no ESLint warnings or errors).
- `npx vitest run tests/unit/convex/receipts-pdf.test.ts` — 21 passed.
- `npx vitest run` (full suite) — 1559 passed, 1 skipped.
- `npm run build` — Next.js compiled successfully (~67s). The
  Windows-only `pages-manifest.json` ENOENT during `Collecting page
  data` is an unrelated Next.js infra warning that pre-existed; the
  compile step itself succeeds.

### Completion Notes List

**Scope narrowing — accepted as per the dispatch system message's
strict file-ownership list.** This slice ships the PDF generation +
download surface only. The email side-channel (AC3, AC6, AC7) and the
broader `ReceiptViewer` component / sub-components (AC1
modal-preview, AC5 inline voided banner above the iframe, AC7
PaymentForm refactor) remain as follow-up work — the system message
explicitly forbids creating
`convex/actions/sendReceiptEmail.ts`,
`src/components/ReceiptViewer/*`, or touching
`PaymentForm.tsx`. The PDF the email path will later attach is
produced by this story; the email writer can fetch the existing
`pdfStorageId` without re-generating.

**Scheduler / function-reference strategy.** Mirrors the architectural
pattern already established in `convex/actions/generateContractPdf.ts`
(Story 6.1): `makeFunctionReference` against bare path strings,
because the codegen `convex/_generated/api` is deliberately not
checked in. The path used here is
`"actions/generateReceiptPdf:generateReceiptPdf"` (the action's
exported name), and the internal mutation / query refs follow the same
file:`receipts:storeReceiptPdfBlob` / `receipts:getReceiptForPdf`
shape.

**Action runtime + Blob handling.** The action declares `"use node"`
at the top so PDFKit (Node-only) can load. The Convex
`ctx.storage.store(...)` API accepts a Blob; the action wraps the
PDFKit Buffer in a `new Blob([Uint8Array], { type: "application/pdf" })`
to satisfy that contract.

**Schema patch — no financial-write rule conflict.** The new
`pdfStorageId` / `pdfGeneratedAt` fields are reached via `ctx.db.patch`
in `storeReceiptPdfBlob`. The `local-rules/no-direct-financial-write`
ESLint rule only blocks `insert` / `replace` / `delete` against
`receipts` outside the cornerstone — `patch` is intentionally not
forbidden (the existing void path in Story 3.12's spec also patches
the receipt row). FR31 immutability is preserved: the patch surface
narrowly touches PDF-pointer fields, never the financial columns.

**Print stylesheet pairs with the existing inline print path.** The
`window.print()` button from Story 3.11 keeps working; the new
`print.css` (imported by the receipt detail page) hides the
surrounding chrome, removes background colours from non-essential
elements, and forces the voided / placeholder banner colours to stick
on a printed page (some browsers strip backgrounds by default).

**Renderer matches the HTML render's section order.** The PDF mirrors
`src/components/ReceiptDisplay/ReceiptDisplay.tsx`'s section sequence
(header → customer block → particulars table → total + words → VAT
block when applicable → payment method → signature → footer). The
same `convex/lib/birFormat.ts` helpers are used so a printed HTML
receipt and a downloaded PDF carry identical strings.

**Voided receipts: watermark + banner.** When `isVoided`, the PDF
includes (a) a top-of-page banner with the void reason / voided-by /
voided-on, and (b) a translucent diagonal "VOIDED" watermark across
the page (fill opacity 0.18, rotated -30°). The watermark is drawn
last so it overlays every section. Print / download remain functional
for voided receipts (audit / customer-copy use cases).

**Test coverage.** 21 new tests in `tests/unit/convex/receipts-pdf.test.ts`
cover the four new functions + the renderer:
- `generateReceiptPdfRequest`: idempotent "already ready" path,
  scheduler hand-off, all four auth gates (admin allowed,
  field_worker FORBIDDEN, customer FORBIDDEN, unauthenticated
  UNAUTHENTICATED), and the not-found case.
- `storeReceiptPdfBlob`: writes the two PDF fields, leaves financial
  fields untouched (defense for FR31), no-ops gracefully on a deleted
  receipt.
- `getReceiptPdfUrl`: returns signed URL when ready, returns
  `{ url: null, generatedAt: null }` while rendering, returns the
  same shape for a missing receipt, role-gated.
- `getReceiptForPdf`: hydrates the action's view-model, populates
  voided fields, returns null for a missing receipt.
- `renderReceiptPdf`: smoke tests for happy path, voided receipt,
  and VAT-registered template — each asserts the output starts with
  the PDF magic bytes (`%PDF`).

### File List

NEW:
- `convex/actions/generateReceiptPdf.ts` — `"use node"` action +
  pure `renderReceiptPdf` renderer (exported for tests).
- `src/components/ReceiptDisplay/print.css` — print-only stylesheet
  paired with Story 3.11's `window.print()` path.
- `tests/unit/convex/receipts-pdf.test.ts` — 21 unit tests.

MODIFIED:
- `convex/receipts.ts` — appended four new functions:
  `getReceiptForPdf` (internal query),
  `generateReceiptPdfRequest` (public mutation),
  `storeReceiptPdfBlob` (internal mutation),
  `getReceiptPdfUrl` (public query). Imports broadened to include
  `internalMutationGeneric` / `internalQueryGeneric` /
  `makeFunctionReference` / `mutationGeneric` / `MutationCtx`.
- `convex/schema.ts` — extended `receipts` table with optional
  `pdfStorageId: v.id("_storage")` and `pdfGeneratedAt: v.number()`.
- `src/app/(staff)/receipts/[receiptId]/page.tsx` — added the
  "Download PDF" button (alongside the existing "Print" button),
  the reactive URL subscription, and a small inline error surface
  for download failures.
- `package.json` — added `pdfkit` to `dependencies` and
  `@types/pdfkit` to `devDependencies`.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` —
  status flip to `review` and `last_updated` comment updated.

OUT OF SCOPE (deferred to a follow-up slice):
- `convex/actions/sendReceiptEmail.ts` and the
  `emailDeliveryAttempts` table (AC3 / AC6 — email side-channel).
- `src/components/ReceiptViewer/` and the iframe-based PDF viewer
  with inline-toolbar (AC1, AC5 inline voided banner above the
  iframe).
- Refactor of `PaymentForm` to navigate to `/receipts/[receiptId]`
  with `?autoprint=true` (AC7).
- Playwright e2e spec `tests/e2e/journey-2-receipt-reprint.spec.ts`
  (Task 17). Unit tests cover the server contract; the e2e test
  belongs to the same follow-up slice that lands the `ReceiptViewer`
  component so the test can drive the real download / email flow.
