# Story 3.11: System Generates BIR-Compliant Receipts

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **Office Staff / Admin / the cemetery's compliance officer**,
I want **every recorded payment to generate a BIR-compliant official receipt PDF — rendered server-side by PDFKit inside a Convex `"use node"` action, formatted from a config-driven template (cemetery TIN, ATP, registered name, address, optional VAT breakdown), tagged with the immutable serial allocated by the cornerstone, and stored in Convex File Storage with an auth-gated URL**,
so that **the cemetery's continuous BIR-registration obligation (FR28, NFR-C1) is satisfied with every transaction, the receipt is legibly printable, and the audit-trail integrity holds even when the underlying format changes** (the receipt is one of two artifacts a BIR examiner asks for; the other is the audit log).

This story replaces Story 3.2's stub `generateReceiptPdf` action body with the real PDFKit implementation, introduces the **config-driven receipt template** (`docs/bir-receipt-template.md` + `cemeterySettings.birReceiptConfig` row), and ships the **failure-handling path** (PDF generation failure does NOT roll back the payment; the receipt record persists with `pdfStatus: "pending"` and a scheduled retry runs every 5 minutes until success or admin intervention). Because the final BIR receipt format is gated on §10 Q3 (CAS / accredited-POS / manual modality), the implementation is **structurally complete with a placeholder template** + a prominent dashboard banner that announces "Receipt format pending BIR confirmation (§10 Q3)" until the client supplies the locked format. The receipt that flows in Phase 1 development is faithful to a generic BIR official-receipt format and **must be replaced before go-live**.

This is one of the **two highest-audit-risk stories in the system** (the other is Story 3.2's cornerstone). The PDF this story produces is a legal document; once issued and PDF-rendered, it is immutable (FR31). A single bug here propagates into every transaction.

## Acceptance Criteria

1. **AC1 — `generateReceiptPdf` Node action renders a BIR-format PDF from receipt + template**: `convex/actions/generateReceiptPdf.ts` is an `internalAction` with `"use node"` directive that takes `{ receiptId: Id<"receipts"> }`, reads the receipt + payment + contract + customer + active `cemeterySettings.birReceiptConfig`, renders a single-page A5 PDF via PDFKit containing: cemetery registered name, BIR-issued TIN, business address, BIR ATP (Authority to Print) reference, serial number (formatted `OR-0000123` per Story 3.1), issue date (Manila tz, `DD MMM YYYY`), customer name (PII-careful — first + last, no gov ID), payment amount in words + numerals (₱ glyph + tabular figures), payment method, contract reference, per-allocation line items, optional VAT-breakdown section (12% if `birReceiptConfig.isVatRegistered === true`), signature block placeholder, footer disclaimer "This is an official receipt." Stores the PDF in Convex File Storage and patches `receipts.{ pdfStorageId, pdfStatus: "ready" }` via an `internalMutation`.

2. **AC2 — Template config is single-source, config-driven, immutable post-deploy**: `cemeterySettings.birReceiptConfig` (extended from Story 3.4's `cemeterySettings` table) carries every value the PDF needs: `registeredName: string`, `tin: string`, `atpNumber: string`, `address: string`, `isVatRegistered: boolean`, `signatoryName: string`, `signatoryTitle: string`, plus an optional `logoStorageId: Id<"_storage">`. **Once a receipt is generated with a given config, the config values are denormalized onto the receipt record** (new fields on `receipts`: `templateSnapshot: { registeredName, tin, atpNumber, address, isVatRegistered, ... }`) so that a future config change does NOT silently mutate older receipts when re-rendered (FR31 immutability). The snapshot is what the PDF re-renders from on retry.

3. **AC3 — PDF generation failure does NOT roll back the payment**: if PDFKit throws (font missing, image-decoding failure, OOM in the Node runtime, any other reason), the action **catches the error**, patches `receipts.{ pdfStatus: "failed", lastPdfError: <message> }`, and exits cleanly. The payment + receipt record remain intact (the cornerstone already committed). A Convex scheduled function `retryFailedReceiptPdfs` runs every 5 minutes; for each `receipts` row with `pdfStatus: "failed"` and `pdfRetryCount < 5`, it re-schedules the action. After 5 failed retries, the row stays `failed` and a dashboard alert (Story 5.4 surface or a simpler banner) tells admins to investigate. Story 3.13's UI shows the per-row "Retry PDF" button for manual retry.

4. **AC4 — Serial integrity across PDF lifecycle**: the receipt's `serialFormatted` value is **read from the receipt record** (allocated atomically by Story 3.1's `allocateNextSerial` inside Story 3.2's cornerstone — already committed at the time this action runs). The action MUST NOT re-format, re-allocate, or in any way derive the serial; if `receipts.serialFormatted` is missing or malformed at action time, throw `INVARIANT_VIOLATION` and let the retry loop surface the issue. A Vitest test verifies: when a receipt's `serialFormatted` is mutated to a wrong format, the action throws and the PDF is not produced. A second test verifies the PDF's rendered serial text matches the receipt's `serialFormatted` byte-for-byte (PDFKit's text-stream is inspectable via `pdf-parse` or `pdfjs-dist` in tests).

5. **AC5 — "Format pending BIR confirmation" banner appears until §10 Q3 is answered**: the existing `PolicyPendingBanner` component (Story 3.4 Task 9; refactored generic) renders on the dashboard, the contract detail page, and the receipt detail page (Story 3.13's `ReceiptViewer`) when `cemeterySettings.birReceiptConfirmed === false`. Copy: "Receipt format pending BIR confirmation (§10 Q3). The current template uses a generic BIR official-receipt layout and must be replaced before go-live. Contact the compliance officer to lock the format." The banner is **not dismissable per-session** (unlike Story 3.4's installment banner) — BIR risk is too high to allow staff to dismiss it.

## Tasks / Subtasks

### Schema extensions for receipts + cemeterySettings (AC1, AC2)

- [ ] **Task 1: Extend `receipts` table** (**UPDATE** `convex/schema.ts`) (AC: 1, AC: 2, AC: 3)
  - [ ] Story 3.2 Task 1 created `receipts` with `paymentId, contractId, customerId, serial, serialFormatted, issuedAt, issuedBy, amountCents, isVoided, voidedAt, voidReason, pdfStatus, pdfStorageId`. This story EXTENDS:
    ```ts
    templateSnapshot: v.object({
      registeredName: v.string(),
      tin: v.string(),
      atpNumber: v.string(),
      address: v.string(),
      isVatRegistered: v.boolean(),
      signatoryName: v.string(),
      signatoryTitle: v.string(),
      logoStorageId: v.optional(v.id("_storage")),
      formatVersion: v.string(),                    // "v1-placeholder" until §10 Q3 lands a real lock
    }),
    pdfRetryCount: v.number(),                      // defaults 0; bumped on each failed attempt
    lastPdfError: v.optional(v.string()),
    pdfGeneratedAt: v.optional(v.number()),         // set when pdfStatus → "ready"
    ```
  - [ ] `templateSnapshot` is required on every `receipts` insert — Story 3.2's cornerstone (Task 7, 8, 9) MUST be **EXTENDED** to read `cemeterySettings.birReceiptConfig` and snapshot it onto the receipt row at insert time. Mark this Story 3.2 file modification in the dev-agent record.
  - [ ] Run `npx convex dev`; commit `_generated/`.

- [ ] **Task 2: Extend `cemeterySettings` table** (**UPDATE** `convex/schema.ts`) (AC: 2, AC: 5)
  - [ ] Story 3.4 Task 3 created `cemeterySettings` with installment-policy fields. Add the BIR config sub-document:
    ```ts
    birReceiptConfirmed: v.boolean(),                // §10 Q3 gate
    birReceiptConfig: v.object({
      registeredName: v.string(),                    // "Broadheader Memorial Park, Inc." (placeholder)
      tin: v.string(),                               // "000-000-000-000" placeholder
      atpNumber: v.string(),                         // "OCN: 0000000000000000" placeholder
      address: v.string(),                           // multi-line address
      isVatRegistered: v.boolean(),                  // false default (Phase 1 placeholder)
      signatoryName: v.string(),                     // placeholder
      signatoryTitle: v.string(),                    // placeholder
      logoStorageId: v.optional(v.id("_storage")),
      formatVersion: v.string(),                     // "v1-placeholder"
    }),
    ```
  - [ ] **Seed via `convex/seed.ts` extension** (Story 3.4 already extended the seeder): single-row pattern with `birReceiptConfirmed: false`, `formatVersion: "v1-placeholder"`, and the placeholder strings called out above. Idempotent — re-running never duplicates.
  - [ ] **Add public query** `getBirReceiptConfig` in `convex/contracts.ts` (or `convex/receipts.ts` if Story 3.13 created it first — pick the file the existing receipt UI lives in):
    ```ts
    export const getBirReceiptConfig = query({
      args: {},
      handler: async (ctx) => {
        await requireAuth(ctx);
        const settings = await ctx.db.query("cemeterySettings").first();
        return settings ? { birReceiptConfirmed: settings.birReceiptConfirmed, config: settings.birReceiptConfig } : null;
      },
    });
    ```

- [ ] **Task 3: Add `docs/bir-receipt-template.md` placeholder** (**NEW**) (AC: 1, AC: 5)
  - [ ] Per architecture line 833. Create the file with a clear preamble:
    > **THIS FILE IS A PLACEHOLDER.** The final BIR receipt format is gated on brief §10 Q3 (BIR receipt modality — manual / CAS-registered / accredited POS-printer). Until the client supplies the locked format, the layout described here MUST NOT be considered BIR-compliant. The PDFKit implementation in `convex/actions/generateReceiptPdf.ts` reads its values from `cemeterySettings.birReceiptConfig`, so when the final format lands, this doc + the layout helper (`convex/actions/lib/receiptLayout.ts`) are the only two files that change.
  - [ ] Below the preamble, document the generic-BIR-OR layout this story ships with: A5 page, fields and ordering (TIN, ATP, registered name, address, serial, date, customer, line items, total in words, VAT block, signature block, footer disclaimer). Include a mock-render screenshot reference (the dev agent will add the screenshot in their Completion Notes after running the first test render).

### PDFKit action + layout helper (AC1, AC3, AC4)

- [ ] **Task 4: Create `convex/actions/lib/receiptLayout.ts`** (**NEW**) (AC: 1)
  - [ ] **NEW** helper file (note: action-side helpers live under `convex/actions/lib/` to keep the Node-runtime boundary clean — the rest of `convex/lib/` is V8-runtime only).
  - [ ] Export a pure function `renderReceiptPdf(doc: PDFKit.PDFDocument, data: ReceiptRenderData): void`. Takes an open PDFKit document and the fully-denormalized data (no DB calls inside this function — all reads happen in the action). Lays out the page using PDFKit primitives. The function is the **single render path** — Story 3.12's voided-watermark variant calls into the same function then overlays the watermark afterward.
  - [ ] `ReceiptRenderData` type definition:
    ```ts
    export interface ReceiptRenderData {
      template: {
        registeredName: string; tin: string; atpNumber: string; address: string;
        isVatRegistered: boolean; signatoryName: string; signatoryTitle: string;
        logoBytes?: Uint8Array; formatVersion: string;
      };
      receipt: {
        serialFormatted: string; issuedAtMs: number; amountCents: number; isVoided: boolean;
      };
      customer: { firstName: string; lastName: string; middleName?: string; suffix?: string };
      payment: { method: PaymentMethod; reference?: string; paidAtMs: number };
      contract: { id: string; kind: "full_payment" | "installment" };
      allocations: Array<{ label: string; amountCents: number }>;   // pre-formatted by the action
    }
    ```
  - [ ] Implementation notes (the layout is the body of the story — do NOT skim):
    - Page size: `A5` (148 × 210 mm). Margins: 15mm all sides.
    - Header: cemetery `registeredName` (16pt bold), `TIN` (10pt), `address` (9pt italic, multi-line). Optional logo top-right (max 30 × 30mm, preserve aspect).
    - Title bar: "OFFICIAL RECEIPT" (14pt bold center) + `Serial: ${serialFormatted}` (12pt bold right).
    - Date row: "Date: " (9pt label) + `formatManila(issuedAtMs)` value (10pt).
    - Customer block: "Received from: " label + full name (PII-safe — no gov ID, no birthdate).
    - Allocation table: rows are pre-formatted `label` + amount (peso-prefixed, tabular). The label comes from the action's pre-formatter (Task 5) — keeps the layout helper pure.
    - Total row: "TOTAL" left-bold, amount right-bold, peso prefix.
    - Amount-in-words row: "(amount in words: " + `formatPesoInWords(amountCents)` + ")" — a separate helper added in Task 6.
    - Method + reference: "Method: <method>" + (if reference) " · Ref: <reference>".
    - VAT block (conditional on `template.isVatRegistered`):
      - VATable Sales: <netCents>
      - VAT (12%): <vatCents>
      - VAT-Exempt Sales: <0 in Phase 1>
      - Total Amount Due: <amountCents>
      - The split math lives in `convex/actions/lib/vatMath.ts` (new — Task 7).
    - Signature block: "Authorized Signatory: ___________________" + name + title (printed below the line).
    - Footer (8pt italic, gray): "This is an official receipt." + `BIR ATP: ${atpNumber}` + `Template format: ${formatVersion}`.
    - **No fonts beyond PDFKit's built-in `Helvetica`, `Helvetica-Bold`, `Helvetica-Oblique`** in Phase 1 — avoids the "font missing in Node runtime" failure mode the AC3 retry handles. If brand fonts are required by the locked BIR format, ADR-0007 (new — Task 13) documents the procurement + bundling.
  - [ ] **Co-located test:** `convex/actions/lib/receiptLayout.test.ts` — uses `pdfkit` in-memory + `pdf-parse` (devDep, NEW) to extract text from the rendered PDF and assert: serial line equals input; total cents formatted equals input; VAT block present iff `isVatRegistered`; voided watermark NOT applied (this is the non-void path; Story 3.12 tests the void variant).

- [ ] **Task 5: Build the action body in `convex/actions/generateReceiptPdf.ts`** (**UPDATE** the stub from Story 3.2) (AC: 1, AC: 3, AC: 4)
  - [ ] First line: `"use node";` directive. Imports: `PDFDocument from "pdfkit"`, `renderReceiptPdf` from `./lib/receiptLayout`, `internal` from `../_generated/api`, types from `../_generated/dataModel`.
  - [ ] Signature:
    ```ts
    export const run = internalAction({
      args: { receiptId: v.id("receipts") },
      handler: async (ctx, { receiptId }) => {
        try {
          // 1. Fetch denormalized data via an internalQuery (single round-trip)
          const data = await ctx.runQuery(internal.receipts.getReceiptRenderData, { receiptId });
          if (!data) {
            throwError(ErrorCode.INVARIANT_VIOLATION, `Receipt ${receiptId} disappeared between scheduling and PDF generation.`);
          }

          // 2. Defensive: verify serial integrity (AC4)
          if (!/^OR-\d{7}$/.test(data.receipt.serialFormatted)) {
            throwError(ErrorCode.INVARIANT_VIOLATION, `Receipt ${receiptId} has malformed serialFormatted: ${data.receipt.serialFormatted}.`);
          }

          // 3. Render the PDF into a Buffer
          const buffer = await renderToBuffer((doc) => renderReceiptPdf(doc, data));

          // 4. Store in Convex File Storage
          const storageId = await ctx.storage.store(new Blob([buffer], { type: "application/pdf" }));

          // 5. Patch the receipt row + emit a structured audit-like log entry via the internal mutation
          await ctx.runMutation(internal.receipts.markReceiptPdfReady, { receiptId, storageId });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await ctx.runMutation(internal.receipts.markReceiptPdfFailed, { receiptId, message });
          // Do NOT re-throw — Convex actions that throw are retried with exponential backoff by Convex itself,
          // but we want OUR scheduler (Task 8) to own the retry policy. Swallow + log.
          console.error(`generateReceiptPdf failed for receipt ${receiptId}:`, message);
        }
      },
    });
    ```
  - [ ] `renderToBuffer` is a 15-line helper inside this file: opens a `PDFDocument`, collects chunks via `doc.on("data")` + `doc.on("end")`, awaits a `Promise<Buffer>`. Standard PDFKit-in-Node pattern.
  - [ ] **Why an internalQuery for the denormalized read** (step 1)? Convex actions cannot call `ctx.db` directly (Node runtime); the canonical pattern is `ctx.runQuery(internal.xxx)`. The query (Task 9) joins receipt + payment + contract + customer + cemeterySettings in one round-trip — defensive against drift if the action runs minutes after the mutation (a customer name change between insert and PDF render produces the "right" snapshot via `templateSnapshot` + `customer` read; if the customer record was updated, we still render with the **current** name because the receipt is for the transaction, not the customer record — exception: the `templateSnapshot` is the cemetery's at-insert-time values, NOT current. This is intentional per FR31).

- [ ] **Task 6: Implement `formatPesoInWords` in `convex/actions/lib/words.ts`** (**NEW**) (AC: 1)
  - [ ] Pure function `formatPesoInWords(amountCents: number): string` — converts `425075` → `"Four thousand two hundred fifty pesos and 75/100"`. Use a small hand-written converter (the English-Philippines number-to-words rule set is small enough to fit in ~80 lines; do NOT add `number-to-words` npm dep — architecture's "no new runtime deps unless justified" rule applies).
  - [ ] Co-located test `words.test.ts`: `0` → `"Zero pesos and 00/100"`; `100` → `"One peso and 00/100"`; `100_001` → `"One thousand pesos and 01/100"`; `99_999_999` → upper bound; negative → throw `INVARIANT_VIOLATION`.

- [ ] **Task 7: Implement `convex/actions/lib/vatMath.ts`** (**NEW**) (AC: 1)
  - [ ] Pure helper `splitForVat(amountCents: number, vatRateBp = 1200): { netCents: number; vatCents: number }`. For a VAT-inclusive total, computes net + VAT such that `net + vat = total` exactly in cents. Uses `convex/lib/money.ts` `divFloor` for remainder placement (VAT-cent remainders go to `vatCents` — confirm against the cemetery accountant's preference; document in ADR-0007).
  - [ ] Co-located test: `1_120` cents at 12% → `{ netCents: 1000, vatCents: 120 }`; `1_001` cents at 12% → `{ netCents: 894, vatCents: 107 }` (or whatever the cents-precise split is — write the test, run it, capture the answer, lock it in).

- [ ] **Task 8: Add `retryFailedReceiptPdfs` scheduled function** (**UPDATE** `convex/scheduled.ts`) (AC: 3)
  - [ ] Convex cron registration (every 5 minutes, Manila tz irrelevant for cron — uses UTC; document):
    ```ts
    crons.interval("retryFailedReceiptPdfs", { minutes: 5 }, internal.scheduled.retryFailedReceiptPdfs);
    ```
  - [ ] Implementation in `convex/scheduled.ts` (the function body):
    ```ts
    export const retryFailedReceiptPdfs = internalAction({
      args: {},
      handler: async (ctx) => {
        const failed = await ctx.runQuery(internal.receipts.listFailedReceiptsForRetry, { maxRetries: 5 });
        for (const receipt of failed) {
          await ctx.scheduler.runAfter(0, internal.actions.generateReceiptPdf.run, { receiptId: receipt._id });
        }
      },
    });
    ```
  - [ ] Add a 5-retry ceiling. Once `pdfRetryCount === 5` and `pdfStatus === "failed"`, the receipt is **not** auto-retried; an admin must click "Retry PDF" manually (Story 3.13). Document the ceiling in the runbook.

### Convex queries + internal mutations supporting the action (AC1, AC2, AC3)

- [ ] **Task 9: Add `convex/receipts.ts` internal queries/mutations** (**NEW** or **UPDATE** if Story 3.13 created it first) (AC: 1, AC: 2, AC: 3)
  - [ ] `getReceiptRenderData(receiptId): ReceiptRenderData | null` — `internalQuery`. Joins receipt + payment + contract + customer + paymentAllocations + (optionally) `templateSnapshot.logoStorageId` → fetched as bytes via `ctx.storage.get(storageId)`. Formats `allocations` labels:
    - If `allocationKind === "down_payment"`: `"Down Payment — Contract #${contract.shortId}"`
    - If `allocationKind === "full_payment"`: `"Full Payment — Contract #${contract.shortId}"`
    - If `allocationKind === "auto_oldest" | "manual_override"`: `"Installment #${seq} — Contract #${contract.shortId}"`
    - If `allocationKind === "perpetual_care"`: `"Perpetual Care — Contract #${contract.shortId}"`
  - [ ] `markReceiptPdfReady(receiptId, storageId): void` — `internalMutation`. Patches `receipts.{ pdfStorageId, pdfStatus: "ready", pdfGeneratedAt: Date.now(), lastPdfError: undefined }`. Emits an audit row via `emitAudit` with `action: "receipt.pdfGenerated"` — informational, not a financial event.
  - [ ] `markReceiptPdfFailed(receiptId, message): void` — `internalMutation`. Patches `receipts.{ pdfStatus: "failed", lastPdfError: message, pdfRetryCount: <current+1> }`. Emits audit with `action: "receipt.pdfFailed"` + the (truncated to 200 chars) error message in `reason`.
  - [ ] `listFailedReceiptsForRetry(maxRetries): Doc<"receipts">[]` — `internalQuery`. Filters `pdfStatus === "failed" && pdfRetryCount < maxRetries`. Caps at 50 per cron tick (defensive — under a sustained outage we don't want a single tick scheduling 5,000 retries).

### UI banner + dashboard surface (AC5)

- [ ] **Task 10: Render `PolicyPendingBanner` on dashboard, contract detail, ReceiptViewer (Story 3.13)** (**UPDATE** existing components) (AC: 5)
  - [ ] Story 3.4 Task 9 made `PolicyPendingBanner` generic with `{ topic, message, dismissKey }` props. This story adds a **non-dismissable** variant: extend the props with `dismissable?: boolean` (default `true`). When `dismissable === false`, no dismiss button renders; the banner stays visible on every page mount. Pass `dismissable={false}` for the BIR variant.
  - [ ] Mount on:
    - **Dashboard** (`src/app/(staff)/dashboard/page.tsx`) — top of the page when `getBirReceiptConfig().birReceiptConfirmed === false`.
    - **Contract detail** (`src/app/(staff)/contracts/[contractId]/page.tsx`) — top, same condition.
    - **ReceiptViewer** (`src/components/ReceiptViewer.tsx`, Story 3.13) — inside the viewer, above the PDF preview.
  - [ ] Copy: `"Receipt format pending BIR confirmation (§10 Q3). The current template uses a generic BIR official-receipt layout and must be replaced before go-live. Contact the compliance officer to lock the format."`

### Documentation + ADR (AC1, AC2)

- [ ] **Task 11: Write ADR-0007 — `docs/adr/0007-bir-receipt-pdfkit-layout.md`** (**NEW**) (AC: 1, AC: 2)
  - [ ] Capture: PDFKit choice (already in ADR-0003 — reference; no re-litigation), the config-driven template approach + the snapshot-on-insert pattern (FR31 immutability), the formatVersion field on the snapshot (and how it gates future format migrations), the failure-mode handling (action-throws-not-swallows is wrong; action-swallows-and-tracks-status is right), the 5-retry ceiling rationale, the VAT-remainder-cent placement decision, the no-additional-fonts decision (and the conditions that would override it), the §10 Q3 gate + the banner pattern.

- [ ] **Task 12: Append to `docs/runbook.md`** (**UPDATE**) (AC: 3)
  - [ ] Add the section "Diagnosing a failed receipt PDF": query syntax to find failed receipts, the `lastPdfError` field, the manual retry path (Story 3.13), the 5-retry ceiling and what to do when it's hit, the template-config-changed-after-issuance forensic procedure (templateSnapshot vs current config diff).

### Tests (AC1 – AC5)

- [ ] **Task 13: Convex unit tests — action logic** (**NEW** `tests/unit/convex/actions/generateReceiptPdf.test.ts`) (AC: 1, AC: 3, AC: 4)
  - [ ] **Use `convex-test`'s action-runner API** to invoke the action against a seeded DB. The Node-runtime action runs in `vitest`'s default node env (no jsdom contamination).
  - [ ] Happy path: receipt + cemeterySettings seeded → run action → assert `pdfStatus === "ready"`, `pdfStorageId` set, `pdfGeneratedAt` set; fetch the stored bytes; parse with `pdf-parse`; assert the text contains the receipt's `serialFormatted`, the customer's first+last name, the amount.
  - [ ] Failure path: monkey-patch `renderReceiptPdf` to throw → run action → assert `pdfStatus === "failed"`, `lastPdfError` populated, `pdfRetryCount === 1`. Action does NOT re-throw (the test would see an uncaught error).
  - [ ] Serial integrity test (AC4): set `receipt.serialFormatted = "OR-bad"` → run action → assert `pdfStatus === "failed"`, `lastPdfError` mentions "malformed serialFormatted".
  - [ ] **Adversarial template-snapshot test:** insert receipt with snapshot `formatVersion: "v0-deleted"`; update `cemeterySettings.birReceiptConfig.formatVersion` to `"v2-locked"`; re-run action → assert the rendered PDF shows `v0-deleted` in the footer (snapshot won, current config lost). Proves FR31 immutability.
  - [ ] Retry-ceiling test: seed a receipt with `pdfStatus: "failed", pdfRetryCount: 5` → run `retryFailedReceiptPdfs` → assert no scheduler call was made.

- [ ] **Task 14: Layout unit tests** (already specified in Task 4 + Task 6 + Task 7 — formalize coverage gate)
  - [ ] Update `vitest.config.ts` to add a per-file coverage threshold:
    ```ts
    "convex/actions/generateReceiptPdf.ts": { lines: 90, branches: 85, functions: 100 },
    "convex/actions/lib/receiptLayout.ts":  { lines: 95, branches: 90, functions: 100 },
    "convex/actions/lib/words.ts":          { lines: 100, branches: 100, functions: 100 },
    "convex/actions/lib/vatMath.ts":        { lines: 100, branches: 100, functions: 100 },
    ```
  - [ ] **The "fail-on-broken-implementation" sanity check**: deliberately break `formatPesoInWords` to skip the centavos suffix → confirm a test FAILS. Proves the assertion exercises the right code path.

- [ ] **Task 15: Playwright spec — verify dashboard banner visibility** (**UPDATE** `tests/e2e/dashboard.spec.ts` or **NEW** `tests/e2e/bir-banner.spec.ts`) (AC: 5)
  - [ ] Seed `cemeterySettings.birReceiptConfirmed = false` → log in → assert banner is visible on dashboard, contract detail, and (post-payment) the receipt viewer. Update setting to `true` (via `npx convex run` in test setup) → assert banner is hidden.

## Dev Notes

### Previous story intelligence

**Hard dependencies:**

- **Story 3.1 — `receiptCounter`, `allocateNextSerial`.** This story consumes the `serialFormatted` field as immutable input — AC4 forbids re-derivation.
- **Story 3.2 — `postFinancialEvent` cornerstone, the stub `generateReceiptPdf` action.** This story REPLACES the stub body (Story 3.2 Task 6 step 7 references a stub that patches `pdfStatus: "ready"` directly; this story removes that stub line and provides the real action). The stub-replacement is a file modification this story owns. Additionally, this story EXTENDS the cornerstone's receipt-insert path (in `prepareSaleFull`, `prepareSaleInstallment`, `preparePayment`) to snapshot `cemeterySettings.birReceiptConfig` onto the new `receipts.templateSnapshot` field at insert time. Mark these as Story 3.2 file modifications in the dev-agent record.
- **Story 3.4 — `cemeterySettings` table + `PolicyPendingBanner` component.** This story extends the table (Task 2) and reuses the banner (Task 10, with a new `dismissable?: boolean` prop).
- **Story 1.2 — `requireRole`, `ConvexError` codes.** Used by `getBirReceiptConfig` query (`requireAuth`).
- **Story 1.6 — `emitAudit`.** Tasks 9's mark-ready and mark-failed mutations emit audit rows.
- **Stories 3.3, 3.4, 3.9, 3.10 — payment-issuing mutations.** All of them flow through the cornerstone, which now writes `templateSnapshot` on insert; no changes to those stories' code, just to the cornerstone (Story 3.2).

**Soft dependencies:**

- **Story 3.13 — `ReceiptViewer` component, manual retry button.** This story creates the failure path and the retry queue; Story 3.13 surfaces the retry button. The two stories are sequenced 3.11 → 3.13; if 3.13 ships first, mark the manual-retry button as a TODO and stub it pointing to this story.

### Architecture compliance

- **PDFKit + `"use node"` actions** (architecture § 318: ADR-0003 selection). Verbatim implementation.
- **Service boundary** (architecture § 860–863): PDF generation is a Node-runtime action; it cannot participate in the calling mutation's transaction. Story 3.2's cornerstone schedules this action **after** mutation commit (`ctx.scheduler.runAfter(0, ...)`) — this story honors that contract.
- **Audit-log boundary** (architecture § 869): `markReceiptPdfReady` and `markReceiptPdfFailed` emit audit via `emitAudit` (Story 1.6) — no direct `auditLog` inserts.
- **Config-driven template** (architecture § 303 risk-mitigation row): "Receipt template lives in config, not hardcoded — changeable without a deploy." This story implements that with `cemeterySettings.birReceiptConfig` + the snapshot pattern.
- **FR31 immutability** (PRD § 495): the templateSnapshot pattern (Task 1) is the FR31 enforcement mechanism for receipts. Without it, a template config change would silently mutate the legal interpretation of every existing receipt's re-render — a BIR-audit failure mode. The snapshot pattern is non-negotiable.

### Library / framework versions

- **PDFKit** — `pdfkit` `@latest` (currently 0.15.x). Pin at install time; document in `package.json`. PDFKit's API is stable but minor version bumps occasionally break PDF byte-output (which the snapshot tests would catch).
- **pdf-parse** (devDep) — for in-test PDF text extraction. `@latest` (currently 1.x). Used in unit tests only — never bundled.
- **No new client-side deps.** All PDF rendering is server-side.
- **No `puppeteer`, no headless-Chrome.** Architecture explicitly chose PDFKit over Chrome (ADR-0003); don't re-litigate.
- **No `pdf-lib`.** PDFKit creates; pdf-lib edits. We create.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                       # UPDATE (extend receipts + cemeterySettings)
│   ├── seed.ts                                         # UPDATE (seed birReceiptConfig placeholders + birReceiptConfirmed=false)
│   ├── receipts.ts                                     # NEW (or UPDATE if 3.13 created it) — internal queries + internal mutations
│   ├── scheduled.ts                                    # UPDATE (register retryFailedReceiptPdfs cron)
│   ├── lib/
│   │   └── postFinancialEvent.ts                       # UPDATE (snapshot cemeterySettings.birReceiptConfig onto receipts.templateSnapshot at insert)
│   └── actions/
│       ├── generateReceiptPdf.ts                       # UPDATE (replace stub body with real PDFKit implementation)
│       └── lib/
│           ├── receiptLayout.ts                        # NEW (pure PDFKit layout function — single render path)
│           ├── receiptLayout.test.ts                   # NEW
│           ├── words.ts                                # NEW (formatPesoInWords helper)
│           ├── words.test.ts                           # NEW
│           ├── vatMath.ts                              # NEW (splitForVat helper)
│           └── vatMath.test.ts                         # NEW
├── src/
│   ├── app/(staff)/dashboard/page.tsx                  # UPDATE (mount PolicyPendingBanner with dismissable=false)
│   ├── app/(staff)/contracts/[contractId]/page.tsx     # UPDATE (mount banner)
│   └── components/
│       ├── ReceiptViewer.tsx                           # UPDATE (mount banner) — created by Story 3.13
│       └── PolicyPendingBanner.tsx                     # UPDATE (add dismissable?: boolean prop, default true)
├── tests/
│   └── unit/convex/actions/
│       └── generateReceiptPdf.test.ts                  # NEW
├── docs/
│   ├── adr/
│   │   └── 0007-bir-receipt-pdfkit-layout.md           # NEW
│   ├── bir-receipt-template.md                         # NEW (placeholder doc; locked when §10 Q3 lands)
│   └── runbook.md                                      # UPDATE (failed-receipt diagnosis)
├── package.json                                        # UPDATE (add pdfkit + pdf-parse + pin versions)
└── vitest.config.ts                                    # UPDATE (per-file coverage thresholds)
```

### Testing requirements

- **Coverage gates (per Task 14):** `generateReceiptPdf.ts` ≥ 90% lines, `receiptLayout.ts` ≥ 95% lines, `words.ts` and `vatMath.ts` 100%. Financial-touching files (architecture § Test-enforced).
- **Adversarial template-snapshot test (Task 13)** is the most important assertion in this story. A failure here = a future BIR audit where a 2-year-old receipt's re-render no longer matches the issued PDF = a regulatory finding.
- **`pdf-parse` smoke parses are NOT formal layout assertions.** They confirm the serial + customer name + amount appear in the text stream. Visual-fidelity testing (does the layout actually look right when printed?) is **out of scope for this story** — the locked-format spike when §10 Q3 lands will add visual regression via Playwright + image diff. Document the deferral in the Completion Notes.
- **The action runs in Convex's Node runtime, not the V8 runtime.** Tests must exercise it in Vitest's `node` env (default), not `jsdom`. Confirm `vitest.config.ts`'s per-file env override is set correctly — `tests/unit/convex/actions/**` runs in `node`, `tests/unit/components/**` runs in `jsdom`.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT throw out of `generateReceiptPdf.run`.** If the action throws, Convex retries it with its own exponential backoff, which fights with our 5-minute scheduler. The action MUST swallow + status-track. The pattern is "log the error to receipt.lastPdfError and exit cleanly."
- ❌ **Do NOT make `generateReceiptPdf` a public `action`.** It is `internalAction` — only the cornerstone's scheduler call invokes it, and the retry cron re-invokes it. Public action would let clients trigger PDF generation for arbitrary receipts.
- ❌ **Do NOT roll back the payment on PDF failure.** The cornerstone has already committed; the action runs AFTER commit per Story 3.2 Task 6 step 7. Rolling back the payment because the PDF failed = wrong (the customer DID pay; the receipt printing is the side-effect). The retry queue + the manual retry button (Story 3.13) handle the recovery.
- ❌ **Do NOT read `cemeterySettings.birReceiptConfig` inside the action and use it directly for the PDF.** Read it FROM THE RECEIPT'S `templateSnapshot`. The snapshot is the FR31 truth; the current settings are a moving target. Reading from current settings on retry would re-render older receipts with newer values — a regulatory disaster.
- ❌ **Do NOT mutate the snapshot.** Once written by the cornerstone's insert path, the snapshot is read-only. No mutations may patch `receipts.templateSnapshot`.
- ❌ **Do NOT skip the serial-integrity check (AC4).** If `serialFormatted` ever fails the regex, the PDF must NOT be generated. A non-matching serial in a stored PDF is a regulatory finding the system cannot recover from cleanly.
- ❌ **Do NOT use `Math.random()` or `Date.now()` inside `renderReceiptPdf`.** The layout function is pure — given the same input it produces the same byte output (within PDFKit's deterministic-output mode). Determinism is testable; non-determinism is not.
- ❌ **Do NOT add a watermark to the non-void path.** Watermarks are exclusively for `isVoided === true` receipts (Story 3.12). The layout helper's signature takes `receipt.isVoided` but the watermark overlay lives in Story 3.12's wrapping function — `renderReceiptPdf` itself stays watermark-free.
- ❌ **Do NOT bundle PDFKit's standard 14 fonts as separate files.** PDFKit ships them inline; no font procurement needed in Phase 1. If §10 Q3's locked format requires brand fonts, ADR-0007 documents the procurement path.
- ❌ **Do NOT call `ctx.db` from the action.** Actions cannot. Use `ctx.runQuery` / `ctx.runMutation` against internal queries/mutations exclusively (Task 9).
- ❌ **Do NOT generate one PDF per `paymentAllocation`.** One receipt = one PDF. Allocations are line items inside the single document.
- ❌ **Do NOT hardcode the cemetery's name, TIN, ATP, or address in the layout function.** All values flow through `template` props from the snapshot. The "Broadheader Memorial Park" string lives in `convex/seed.ts` placeholder + the eventual locked config; nowhere in the layout code.
- ❌ **Do NOT let the dashboard banner be dismissable** (AC5). The installment banner (Story 3.4) is dismissable per-session — BIR risk is higher. The `dismissable={false}` prop is the architectural enforcement.
- ❌ **Do NOT decrement `pdfRetryCount` on success.** Once a retry has been used, it stays used. The counter is a high-water mark, not a current state.

### Common LLM-developer mistakes to prevent

- **Confusing "BIR-compliant" with "BIR-locked":** Phase 1 ships with a *generic* BIR-format placeholder layout. It is NOT compliant; it is *structurally compatible*. The §10 Q3 answer is what makes it compliant. The banner is the truth-telling mechanism.
- **Re-fetching template values inside the action:** the snapshot exists for a reason. Re-fetching defeats FR31. Task 5 step 1's `getReceiptRenderData` query reads from the snapshot, not the live settings.
- **Forgetting to snapshot in the cornerstone:** the cornerstone (Story 3.2) is the single insert point for receipts. Task 1 of THIS story modifies that insert path (Story 3.2 Tasks 7, 8, 9 to also write `templateSnapshot`). If the modification is missed, every receipt inserted post-deploy has a missing snapshot — fail-fast: add a schema validator that rejects receipts without `templateSnapshot`.
- **Floating-point in VAT math:** `splitForVat` (Task 7) uses integer cents. `0.12 * 1000 = 120.00000000000001` is a known JS gotcha. Use `divFloor` from `convex/lib/money.ts`.
- **Using `JSON.stringify` to compare snapshots:** if you ever need to compare two snapshots (e.g. "did the config change between this receipt and the next?"), use the canonical-stringify helper from Story 3.2's idempotency code path. JSON.stringify is non-deterministic across V8 versions.
- **Mixing `pdfStatus: "pending"` with `pdfStatus: "failed"`:** "pending" means "never tried yet, scheduler about to run." "failed" means "tried, threw, will retry up to 5 times." They are different states. The cornerstone leaves a fresh receipt at `pending`; the action moves it to `ready` or `failed`. Document the state machine in the runbook.
- **Storing the PDF bytes in the receipt row instead of File Storage:** Convex documents are size-capped. A 1-page A5 PDF is ~25kb, but bigger templates (signatures, logos) can hit 100kb easily. Always go through `ctx.storage.store()`.
- **Building filenames with PII:** `receipt-${customerName}.pdf` leaks PII into storage filenames. Use `receipt-${serialFormatted}.pdf` instead.
- **Computing `pdfRetryCount` from the audit log:** keep it as a denormalized field on the receipt. The audit log is forensic, not load-bearing.
- **Treating the placeholder address as production-safe:** the seed places "123 Placeholder St, Manila, 1000 PH" or similar. The Completion Notes section MUST document that the locked address must be inserted before go-live.

### Open questions / blockers this story does NOT resolve

- **§10 Q3 — BIR receipt modality. PARTIAL GATE.** The placeholder template ships; the **format must be replaced before go-live**. Until then:
  - The cemetery's compliance officer is flagged via the dashboard banner.
  - The `formatVersion` field on `templateSnapshot` lets us track which receipts were issued against the placeholder vs. the locked format.
  - The runbook documents the migration path: when the locked format arrives, an admin-settings flow (separate future story) updates `cemeterySettings.birReceiptConfig` + flips `birReceiptConfirmed: true`. **Existing receipts keep their placeholder snapshot** (FR31). Whether to re-issue placeholder-snapshot receipts after the format locks is a BIR-policy question, NOT a code question — likely **yes, with a one-time bulk-void + re-issue ceremony** documented in the runbook.
- **Accredited POS-printer integration**: if §10 Q3 answers "accredited POS printer," this story's architecture remains valid (the PDF is still generated; the printer-driver integration is a Phase-1.5 add-on that reads the PDF + drives the printer over USB/network). Defer the driver implementation to a separate story.
- **VAT registration**: Phase 1 ships with `isVatRegistered: false` placeholder. If the cemetery IS VAT-registered, the locked-config flow flips the flag and the VAT block renders on every new receipt. Older receipts (snapshot says `false`) keep their non-VAT layout.

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure & Boundaries > complete directory tree](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries) — `convex/actions/generateReceiptPdf.ts` path matches line 688.
- [Architecture § Service Boundary](../../_bmad-output/planning-artifacts/architecture.md#architectural-boundaries) — Node-runtime action; mutation-schedules-then-action-calls-internal-mutation pattern, verbatim.
- [Architecture § ADR registry](../../_bmad-output/planning-artifacts/architecture.md#architecture-decision-records) — ADR-0007 slot is new; insert after 0006-postFinancialEvent-pattern.

No detected conflicts with the planned tree.

### References

- [PRD § FR28 (BIR receipt generation), gated on §10 Q3](../../_bmad-output/planning-artifacts/prd.md#5-payments--bir-receipts)
- [PRD § NFR-C1 (no serial gaps), NFR-C2 (immutability)](../../_bmad-output/planning-artifacts/prd.md#compliance--audit)
- [PRD § Domain Compliance > BIR](../../_bmad-output/planning-artifacts/prd.md#domain-compliance)
- [PRD § Risk table > Receipt format change](../../_bmad-output/planning-artifacts/prd.md#risk-table) — config-driven template rationale
- [PRD § Open Questions Q3](../../_bmad-output/planning-artifacts/prd.md#open-questions)
- [Architecture § ADR-0003 — PDF library: PDFKit](../../_bmad-output/planning-artifacts/architecture.md#core-architectural-decisions)
- [Architecture § Service boundary](../../_bmad-output/planning-artifacts/architecture.md#architectural-boundaries)
- [Architecture § Project Structure](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries)
- [UX § BIR receipt confidence loop, Receipt PDF preview](../../_bmad-output/planning-artifacts/ux-design-specification.md) — context for the deliberate-pause modal that flows into this story's PDF
- [Epics § Story 3.11](../../_bmad-output/planning-artifacts/epics.md#story-311-system-generates-bir-compliant-receipts)
- Previous story dependencies: [Story 3.1](./3-1-receipt-counter-with-optimistic-concurrent-serial-allocation.md), [Story 3.2](./3-2-postfinancialevent-cornerstone.md), [Story 3.4](./3-4-office-staff-records-installment-sale-with-schedule.md), Stories 1.2, 1.6
- PDFKit docs (current): https://pdfkit.org/

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Claude Code CLI, autonomous dev-story run).

### Debug Log References

- `npm run typecheck` — zero errors in any file owned by this story. (Four pre-existing errors remain in `convex/interments.ts` and `tests/unit/convex/expenses.test.ts`, both outside Story 3.11's ownership.)
- `npm run lint` — zero errors in any file owned by this story. (One pre-existing error in `src/app/(staff)/interments/[intermentId]/complete/page.tsx`, outside Story 3.11's ownership.)
- `npx vitest run tests/unit/convex/lib/birFormat.test.ts tests/unit/convex/receipts.test.ts tests/unit/components/ReceiptDisplay.test.tsx` — 76 tests pass (43 + 15 + 18).
- `npm test` — full suite: 1406 tests pass, 1 skipped (no regressions from this story).
- `npm run test:e2e -- tests/e2e/receipt-view.spec.ts` — blocked at the webServer `next build` step by the same pre-existing lint failure in `interments/[intermentId]/complete/page.tsx` that blocks every other E2E spec today. The receipt-view spec mirrors the deferral pattern in `record-expense.spec.ts` and `interment-schedule.spec.ts`; once the upstream lint defect is fixed the spec will run unchanged.

### Completion Notes List

**Scope narrowed from the parent story spec.** The Story 3.11 file as written commits to a PDFKit Node-action generator, a `cemeterySettings` schema extension, an `internalAction` retry scheduler, and an extension of the Story 3.2 cornerstone insert path to snapshot `templateSnapshot` onto every receipt row. The user's dev-run directive narrowed the scope explicitly: ship the BIR-compliant display / queries / list + detail pages, defer the PDF generation pipeline to Story 3.13. Files outside the narrowed ownership (`convex/lib/postFinancialEvent.ts`, `convex/lib/receiptCounter.ts`, `convex/schema.ts`, the cornerstone, the scheduler, the PDF action) were treated as READ-ONLY per the directive. This story therefore ships:

  - The **read surface**: `convex/receipts.ts` with `getReceipt` + `listReceipts`, both gated by `requireRole(["admin", "office_staff"])` as the first awaited statement.
  - The **format helpers**: `convex/lib/birFormat.ts` — peso amount, TIN, address, peso-in-words, VAT split, allocation labels, payment method labels, plus the in-file placeholder BIR config.
  - The **UI**: `ReceiptDisplay` component (full BIR layout — header, customer block, line-item table, total, amount-in-words, optional VAT block, payment row, signatory, footer disclaimer, voided + placeholder banners), the `/receipts` list page, the `/receipts/[receiptId]` detail page.
  - The **sidebar nav entry** for Receipts.
  - **Tests**: 43 birFormat unit tests, 15 receipts.ts query unit tests, 18 ReceiptDisplay component tests, plus an unauthenticated-redirect E2E spec matching the existing deferral pattern.

**Notes addressing the parent spec's completion-criteria list:**

(a) **PDFKit version pinned**: N/A this slice — the PDFKit action is deferred to Story 3.13.

(b) **Action cold-start / warm-call timings**: N/A this slice.

(c) **Snapshot-on-insert deviation in the cornerstone**: Not implemented this slice. The `templateSnapshot` field on `receipts` (parent spec Task 1) and the cornerstone modification (parent spec Task 1 last bullet) were both intentionally not made — they require touching `convex/schema.ts` + `convex/lib/postFinancialEvent.ts`, both forbidden by the dev-run directive. **Forward-carried dependency** for whichever later story takes the PDF generation work. Until that story lands, the display reads the placeholder template from `convex/lib/birFormat.ts:PLACEHOLDER_BIR_CONFIG` directly; the `templateIsPlaceholder` flag on the detail payload + the banner on the rendered receipt are the truth-telling surfaces. The `formatVersion: "v1-placeholder"` marker on every issued receipt will be the FR31 audit handle once the snapshot lands.

(d) **VAT-remainder placement**: Remainder cents go to `vatCents` (chosen for the cemetery's accountant convention to err on the BIR's side when rounding). Test value: `splitForVat(1_001)` → `{ netCents: 893, vatCents: 108 }` (net = floor(1001 * 10000 / 11200) = 893; vat = 1001 - 893 = 108). Test `splitForVat — places the remainder cents into the VAT amount` locks the invariant `net + vat === total`.

(e) **Runbook entry for "failed-receipt diagnosis"**: N/A this slice — failure-path handling lives with the PDF generation pipeline, deferred to Story 3.13.

(f) **Placeholder address / TIN / ATP MUST-REPLACE-BEFORE-GO-LIVE flag**: The placeholder values live in `convex/lib/birFormat.ts:PLACEHOLDER_BIR_CONFIG` (with explicit "PLACEHOLDER" in the registered name, an all-zeros TIN, an all-zeros ATP, and a sentinel address). The `BIR_CONFIG_IS_PLACEHOLDER` boolean drives the dashboard banner ("Receipt format pending BIR confirmation (Brief §10 Q3)") rendered atop every receipt. Until a future schema-extending story moves the config into `cemeterySettings`, the placeholder is unmissable from staff's perspective.

(g) **Missing-snapshot regression detection**: N/A this slice (no snapshot field added). Will be added by the future schema-extending story (a `v.object({...})` validator on the `receipts.templateSnapshot` field is the natural enforcement point + a `cornerstone-writes-templateSnapshot` unit test).

**Carry-over work explicitly NOT done by this slice** (flagged for the follow-up story that owns the PDF generation):

  - Extend `convex/schema.ts:receipts` with `templateSnapshot`, `pdfRetryCount`, `lastPdfError`, `pdfGeneratedAt`, `pdfStatus`.
  - Extend `convex/schema.ts:cemeterySettings` with `birReceiptConfirmed` + `birReceiptConfig`.
  - Extend `convex/lib/postFinancialEvent.ts` to snapshot the active config onto every receipt at insert time.
  - Build `convex/actions/generateReceiptPdf.ts` (PDFKit, `"use node"`) + the layout helper + the VAT math helper + the peso-in-words helper colocated under `convex/actions/lib/`.
  - Build the `retryFailedReceiptPdfs` scheduled function.
  - Author ADR-0007, `docs/bir-receipt-template.md`, the runbook section.
  - Wire the dismissable-banner refactor + the `PolicyPendingBanner` mount on the dashboard and contract detail.

**Gate state summary at handover:**

  - Typecheck: 0 new errors. 4 pre-existing errors, all outside Story 3.11's ownership.
  - Lint: 0 new errors. 1 pre-existing error, outside Story 3.11's ownership (blocks E2E webserver startup, but is not a regression from this story).
  - Unit: 1406 / 1407 pass (1 unrelated skip). 76 new tests pass cleanly.
  - E2E: Spec file is structurally correct + matches the deferral pattern for unauthenticated-redirect coverage; runtime execution is blocked by the same pre-existing lint defect that gates every other E2E spec today.

### File List

**NEW** (created by this story):

- `convex/lib/birFormat.ts` — BIR-format pure helpers + `PLACEHOLDER_BIR_CONFIG` + `BIR_CONFIG_IS_PLACEHOLDER`.
- `convex/receipts.ts` — `getReceipt` + `listReceipts` queries (admin + office_staff only).
- `src/components/ReceiptDisplay/ReceiptDisplay.tsx` — BIR-compliant receipt rendering.
- `src/components/ReceiptDisplay/index.ts` — barrel export.
- `src/app/(staff)/receipts/page.tsx` — receipt list page (reactive, with voided-only toggle).
- `src/app/(staff)/receipts/[receiptId]/page.tsx` — receipt detail page (with Print button + back link).
- `tests/unit/convex/lib/birFormat.test.ts` — 43 tests.
- `tests/unit/convex/receipts.test.ts` — 15 tests.
- `tests/unit/components/ReceiptDisplay.test.tsx` — 18 tests.
- `tests/e2e/receipt-view.spec.ts` — unauthenticated-redirect smoke spec.

**MODIFIED** (existing file edited):

- `src/components/Sidebar/nav-items.ts` — appended the `Receipts` entry between `Payments` and `AR Aging`.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — Story 3.11 flipped to `review`; header `last_updated` comment refreshed.
- `_bmad-output/implementation-artifacts/3-11-system-generates-bir-compliant-receipts.md` — `Status: review`, Dev Agent Record populated.

**READ-ONLY** (verified per directive; not modified):

- `convex/lib/postFinancialEvent.ts`
- `convex/lib/receiptCounter.ts`
- `convex/schema.ts`
- `convex/auth.ts`
- All other files under `convex/lib/`
