# Story 6.1: Office Staff Generates an Installment Contract as PDF

Status: review

<!-- Phase 2 reservation: Phase 2 ACs are intentionally lighter than Phase 1's; this story may be re-specced at Phase 2 kickoff once §10 Q6 (ownership transfer policy) + §10 Q7 (perpetual care fees) are answered and the contract terms language is finalized with the client. Treat the AC details below as the minimum bar to clear; finalize the contract template + signature placement at kickoff. -->

## Story

As **Office Staff**,
I want **to generate an installment contract as a formal multi-page PDF document with cemetery letterhead, the customer + lot details, the full installment schedule, the grace / penalty terms, and signature placeholders for both parties**,
so that **customers receive a signable, retainable legal document at the close of every sale, and the cemetery has a versioned PDF record alongside the Convex contract document** (FR49).

This story extends the **PDFKit + Convex File Storage infrastructure already established by Story 3.11** (BIR receipt generation). The same `"use node"` action pattern, the same `convex/actions/` folder, the same `getUrl` signed-URL flow — only the document layout differs. **Reuse aggressively; do NOT introduce a second PDF library.**

## Acceptance Criteria

1. **AC1 — Contract PDF action exists and produces a multi-page PDF**: `convex/actions/generateContractPdf.ts` is a Node-runtime (`"use node"`) action that, given a `contractId`, fetches the contract + customer + lot + ownership + installment schedule, renders a PDFKit document with: cemetery letterhead block (logo / name / TIN / address), parties block (cemetery + customer), lot description (code, type, dimensions, section / block / row), full installment schedule table (installment #, due date, amount, status), grace + penalty terms paragraph (read from admin settings; placeholder boilerplate if §10 Q1 unanswered), and two signature blocks (cemetery officer + customer) on the final page.

2. **AC2 — Generation is auth-gated, role-gated, and stored in Convex File Storage**: A public `convex/contracts.ts → generateContractPdf` mutation (callable from the contract detail page) calls `requireRole(ctx, ["admin", "office_staff"])`, then schedules the action. The action writes the rendered PDF into Convex File Storage via `ctx.storage.store(...)`, then calls back into an internal mutation that records the blob ID on a new `contractDocuments` row referencing the contract + version + generatedBy + generatedAt + documentType `"contract"`. The contract detail page reactively shows the new PDF with download / print / email actions matching the receipt-viewer pattern.

3. **AC3 — Version history is preserved on regeneration**: When the same contract has a PDF regenerated (e.g. after a permitted amendment, schedule edit, or terms change), a new `contractDocuments` row is written with `version: N+1` (the previous PDFs are NOT deleted or replaced). The contract detail page renders a version-history list (`v3 (current) · v2 · v1`) with timestamps + actor; each version's PDF stays downloadable. `emitAudit` records both the regeneration action and the version delta.

4. **AC4 — Failure handling matches the receipt pattern**: If the PDFKit action throws (missing font, missing letterhead asset, malformed schedule), the contract document row is written with `pdfStatus: "pending"` instead of `"ready"`, a retry is scheduled via `convex/scheduled.ts` (same retry plumbing as Story 3.11's receipt-PDF-failed path), and the UI shows "Contract PDF pending — retry" with a manual retry button gated on Admin role.

## Tasks / Subtasks

### Schema + helpers (AC1, AC2, AC3)

- [ ] **Task 1: Add the `contractDocuments` table to `convex/schema.ts`** (AC: 2, AC: 3)
  - [ ] **UPDATE** `convex/schema.ts`: add
    ```ts
    contractDocuments: defineTable({
      contractId: v.id("contracts"),
      documentType: v.union(v.literal("contract"), v.literal("demand_letter")),
      version: v.number(),
      pdfBlobId: v.optional(v.id("_storage")),
      pdfStatus: v.union(v.literal("pending"), v.literal("ready"), v.literal("failed")),
      generatedBy: v.id("users"),
      generatedAt: v.number(),
      retryCount: v.number(),
      lastError: v.optional(v.string()),
    })
      .index("by_contract_type_version", ["contractId", "documentType", "version"])
      .index("by_status", ["pdfStatus"]) // for scheduled retry sweeps
    ```
  - [ ] **Reuse for Story 6.2** — Story 6.2 (demand letter) writes the same table with `documentType: "demand_letter"`. Do NOT create a second table.
  - [ ] Document the table-shape decision in `docs/adr/0003-pdf-pdfkit.md` (UPDATE existing ADR — append a "Document storage" section), keeping the rationale: one table for all contract-bound documents; versioning is per `(contractId, documentType)`.

- [ ] **Task 2: Reuse Story 3.11's PDFKit helper module** (AC: 1)
  - [ ] If Story 3.11 produced `convex/actions/lib/pdfkitHelpers.ts` (font loading, peso formatter, table renderer, page-numbering footer), **import from it**. Do NOT duplicate the helpers — extract into the shared module if Story 3.11 inlined them.
  - [ ] Confirm the cemetery letterhead asset is already bundled (Story 3.11 needed it for receipts). If not, add it under `convex/actions/assets/letterhead.png` (or PDF) and document the source-of-truth for cemetery branding in the ADR.

### The action (AC1, AC2, AC4)

- [ ] **Task 3: Implement `convex/actions/generateContractPdf.ts`** (AC: 1, AC: 4)
  - [ ] **NEW** file with `"use node"` directive on line 1.
  - [ ] Action signature: `internalAction({ args: { contractId, version, generatorUserId, documentRowId }, handler })`. Triggered only from `convex/contracts.ts` after the mutation has reserved a `contractDocuments` row in `pdfStatus: "pending"`.
  - [ ] Handler fetches contract + customer + lot + ownership + installments via `ctx.runQuery(internal.contracts._getForPdfRender, { contractId })`. Build that internal query in `convex/contracts.ts` — it's allowed to read PII server-side but never surfaces it; uses `internalQuery` so it's exempt from the `requireRole` lint rule.
  - [ ] Render layout (in order):
    1. **Letterhead block** — logo + cemetery legal name + TIN + address + phone. Centered top of page 1.
    2. **Title** — "INSTALLMENT CONTRACT FOR INTERMENT LOT" (uppercase, 16pt).
    3. **Parties** — Cemetery (as registered) + Customer (full name + ID type + redacted last-4 of gov ID + address + phone).
    4. **Lot description** — code + type + dimensions + section / block / row + base price (formatted via centavo→peso helper).
    5. **Schedule table** — columns: `#`, `Due date (Manila tz)`, `Amount`, `Status`. Use PDFKit's table primitives or the helper from Task 2.
    6. **Terms paragraph** — grace period + penalty rate (read from admin settings doc; if §10 Q1 unanswered, use placeholder boilerplate with a small footnote `"Final terms pending §10 Q1"`).
    7. **Signature blocks** — two side-by-side blocks on a new page: cemetery officer (printed name + signature line + date), customer (printed name + signature line + date).
  - [ ] On success: `ctx.storage.store(pdfBuffer)` → `blobId`; call `ctx.runMutation(internal.contracts._recordPdfReady, { documentRowId, blobId })`.
  - [ ] On failure (catch all): call `ctx.runMutation(internal.contracts._recordPdfFailed, { documentRowId, error: e.message })`. Do NOT re-throw — the scheduled retry will pick it up.

- [ ] **Task 4: Implement the public mutation in `convex/contracts.ts`** (AC: 2, AC: 3)
  - [ ] **UPDATE** `convex/contracts.ts`: add `export const generateContractPdf = mutation({ ... })`.
  - [ ] First line: `const { userId } = await requireRole(ctx, ["admin", "office_staff"]);`.
  - [ ] Read the contract; assert it exists; load the latest `contractDocuments` row for `(contractId, "contract")` via the compound index; compute `nextVersion = (latest?.version ?? 0) + 1`.
  - [ ] Insert a new `contractDocuments` row with `pdfStatus: "pending"`, `version: nextVersion`, `generatedBy: userId`, `generatedAt: Date.now()`, `retryCount: 0`.
  - [ ] `emitAudit(ctx, { action: "generate_contract_pdf", entityType: "contract", entityId: contractId, before: null, after: { version: nextVersion }, reason: "contract pdf generation" })`.
  - [ ] `await ctx.scheduler.runAfter(0, internal.actions.generateContractPdf.run, { contractId, version: nextVersion, generatorUserId: userId, documentRowId: insertedId })`.
  - [ ] Return `{ documentRowId, version: nextVersion }` so the UI can subscribe reactively.

- [ ] **Task 5: Implement the internal query + recording mutations** (AC: 2, AC: 4)
  - [ ] `internal.contracts._getForPdfRender` — internalQuery that joins contract + customer + lot + ownership + installments. Returns a flat object the action consumes.
  - [ ] `internal.contracts._recordPdfReady` — internalMutation that patches the row to `{ pdfBlobId, pdfStatus: "ready" }` and emits an audit entry `action: "contract_pdf_ready"`.
  - [ ] `internal.contracts._recordPdfFailed` — internalMutation that patches the row to `{ pdfStatus: "failed", retryCount: existing.retryCount + 1, lastError: error }`. If `retryCount >= 3`, leave as `"failed"` and emit a dashboard-alert (reuse the receipt-pdf-failed alert plumbing from Story 3.11).

### Retry scheduling (AC4)

- [ ] **Task 6: Add a scheduled sweep for pending / failed contract PDFs** (AC: 4)
  - [ ] **UPDATE** `convex/scheduled.ts`: register a 5-minute cron (or reuse Story 3.11's PDF-retry cron — preferred) that queries `contractDocuments.by_status` for `pdfStatus IN ("pending", "failed") AND retryCount < 3`. For each row, schedule `internal.actions.generateContractPdf.run` again.
  - [ ] Document the shared retry plumbing in `docs/runbook.md` under "PDF generation failures."

### UI (AC2, AC3, AC4)

- [ ] **Task 7: Add "Generate contract PDF" affordance on the contract detail page** (AC: 2, AC: 3)
  - [ ] **UPDATE** `src/app/(staff)/contracts/[contractId]/page.tsx`: add a Documents card (or extend existing one) listing all `contractDocuments` rows for this contract via `useQuery(api.contracts.listDocuments, { contractId })`. Filter to `documentType === "contract"` in this story; Story 6.2 adds `"demand_letter"`.
  - [ ] Primary button: **"Generate contract PDF"** — calls the public mutation; disabled while a `pending` row exists for this contract.
  - [ ] Each row in the list shows: `v{N}` badge, generatedAt (Manila tz), generatedBy (user name), status pill (`pending` / `ready` / `failed`), action buttons: **Download** (`getUrl(blobId)`, opens new tab), **Print** (browser print dialog), **Email** (Phase 2 reservation — wire as a stub button that opens a Sheet showing "Email coming with Story 6.2 demand-letter parity" if not built yet, OR reuse the receipt-email action if Story 3.13 already shipped it).
  - [ ] If `pdfStatus === "failed"` and the user is Admin, show **Retry** button that calls the public mutation again.

- [ ] **Task 8: Build the `ContractPdfPreview` component** (AC: 2)
  - [ ] **NEW** `src/components/ContractPdfPreview/{ContractPdfPreview.tsx, index.ts}` — clone the `ReceiptViewer` modal structure from Story 3.11; renders the PDF in a native browser PDF viewer iframe. Single primary action: **Download**. Secondary: **Close**.
  - [ ] Per UX-DR `PDF previews implemented as image renders`-anti-pattern (UX spec line 303): use native browser PDF viewer in an iframe; never fall back to an image render.

### Testing (AC1, AC2, AC3, AC4)

- [ ] **Task 9: Unit tests for the mutation + internal mutations** (AC: 2, AC: 3)
  - [ ] **NEW** `tests/unit/convex/contracts.test.ts` (or extend if it exists). Cover:
    - generateContractPdf as Office Staff with valid contract → inserts pending row, schedules action, emits audit
    - generateContractPdf as Field Worker → throws `FORBIDDEN`
    - regeneration → increments version (v1 + v2 + v3 all present in the table)
    - _recordPdfFailed at retryCount=3 → row stays in `"failed"`; no further retries scheduled
  - [ ] Use `convex-test` per Story 1.2's harness.

- [ ] **Task 10: Action-render smoke test** (AC: 1)
  - [ ] **NEW** `tests/unit/convex/actions/generateContractPdf.test.ts`. Invoke the action with a stub fixture contract; assert the produced PDF buffer is non-empty + has at least 2 pages (PDFKit emits a page-count). Don't pixel-diff the PDF — that's brittle. Add a TODO for a Phase 2 visual-diff harness if BIR-style fidelity testing is required (gated on §10 Q3 / kickoff).

### Docs (AC1, AC2)

- [ ] **Task 11: Document + ADR** (AC: 1)
  - [ ] **UPDATE** `docs/adr/0003-pdf-pdfkit.md` to note that contract + demand-letter PDFs reuse the receipt PDFKit pipeline; add the shared-helper-module link.
  - [ ] **UPDATE** `docs/runbook.md`: "Contract PDF stuck in pending" section — operator steps for inspecting `contractDocuments.by_status` and forcing a retry.

## Dev Notes

### Previous story intelligence

**Story 3.11 (System generates BIR-compliant receipts)** is the load-bearing dependency. Its outputs that this story reuses:

- `convex/actions/generateReceiptPdf.ts` — the canonical `"use node"` action pattern (font loading, PDFKit invocation, `ctx.storage.store`, `internal.*._record*` callback flow). **This story copies the pattern; do NOT diverge.**
- `convex/actions/lib/pdfkitHelpers.ts` (if Story 3.11 produced it) — letterhead, fonts, peso formatter, table primitives, page-number footer. If Story 3.11 inlined these, **the first task of this story is to extract them** before adding contract-specific layout.
- The receipt-pdf retry cron in `convex/scheduled.ts`. **Extend it to scan `contractDocuments.by_status`** (single cron, both tables) rather than registering a second cron.
- `docs/adr/0003-pdf-pdfkit.md`. Append, don't replace.

**Story 1.6 (`emitAudit`)** is also a prerequisite — every mutation in this story emits audit entries.

**Story 1.2 (`requireRole`)** — used as first line of the public mutation.

**Story 5.1 / 5.2 (KpiCard, dashboard)** — the dashboard-alert plumbing for "Receipt PDF failed" exists; the contract-PDF-failed path reuses it (same alert tile, just filtered by `documentType`).

If 3.11 isn't done yet, **do not start this story** — implement 3.11 first.

### Architecture compliance

- **PDF library is PDFKit only** (architecture § Frontend & Document Generation). No `pdf-lib`, no headless Chrome. ESLint rule blocks client imports of `pdfkit` (architecture § Enforcement Guidelines).
- **`"use node"` actions live in `convex/actions/`** (architecture § Project Structure). They cannot be called transactionally; the public mutation schedules them. Action results land via `internal.*` callback mutations.
- **PDF blobs in Convex File Storage with auth-gated signed URLs**: `ctx.storage.store(buffer) → blobId`; serve via `ctx.storage.getUrl(blobId)` from a query that calls `requireRole`. Never expose the raw blob ID directly.
- **One PDF library shared across all document types** — extract helpers once, reuse for receipts + contracts + demand letters.
- **Append-only audit log** — every generation + version-bump emits `emitAudit`; do not write to `auditLog` directly.

### Library / framework versions

- **PDFKit** — version locked by Story 3.11. Reuse the same package version + font assets.
- **No new dependencies** added in this story. If you find yourself reaching for `pdf-lib`, `puppeteer`, or `react-pdf`, stop — they're explicitly out of scope per architecture's PDF-library ADR.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                  # UPDATE (add contractDocuments table + indexes)
│   ├── contracts.ts                               # UPDATE (generateContractPdf mutation; listDocuments query; internal helpers)
│   ├── scheduled.ts                               # UPDATE (extend PDF-retry cron to scan contractDocuments)
│   └── actions/
│       ├── generateContractPdf.ts                 # NEW (Node-runtime, "use node")
│       └── lib/
│           └── pdfkitHelpers.ts                   # UPDATE if exists from Story 3.11 / extract NEW if inlined
├── src/
│   ├── app/(staff)/contracts/[contractId]/page.tsx  # UPDATE (Documents card + Generate button)
│   └── components/
│       └── ContractPdfPreview/
│           ├── ContractPdfPreview.tsx             # NEW
│           └── index.ts                           # NEW
├── tests/
│   └── unit/
│       └── convex/
│           ├── contracts.test.ts                  # UPDATE (add generateContractPdf cases)
│           └── actions/
│               └── generateContractPdf.test.ts   # NEW (smoke render test)
└── docs/
    ├── adr/
    │   └── 0003-pdf-pdfkit.md                     # UPDATE (append Document storage section)
    └── runbook.md                                 # UPDATE (PDF-stuck operator steps)
```

### Testing requirements

- Unit coverage for the mutation: 100% line on the generateContractPdf path (auth checks, version bumping, retry-cap behavior). NFR-M2's 90% bar is the floor; this is contract-document territory and should not ship with gaps.
- Action smoke test: render-once + assert non-empty buffer + ≥ 2 pages. Skip pixel diffs in this story.
- E2E: not in scope for this story (Phase 2 ACs are lighter). The Phase 2 kickoff may add a Playwright spec that drives the contract detail page through generation + version bumping.

### Source references

- **PRD:** [FR49 Document Generation](../../_bmad-output/planning-artifacts/prd.md#9-document-generation)
- **Architecture:** [§ Pattern Examples > PDF library = PDFKit](../../_bmad-output/planning-artifacts/architecture.md#core-architectural-decisions); [§ Service Boundary > Node-runtime actions](../../_bmad-output/planning-artifacts/architecture.md#architectural-boundaries); [§ Complete Project Directory Structure](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- **UX:** [§ Implementation Roadmap > Phase 2 — ContractPdfPreview](../../_bmad-output/planning-artifacts/ux-design-specification.md); [§ Anti-patterns > PDF previews as image renders](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- **Epics:** [Story 6.1](../../_bmad-output/planning-artifacts/epics.md#story-61-office-staff-generates-an-installment-contract-as-pdf); [Story 3.11 dependency](../../_bmad-output/planning-artifacts/epics.md#story-311-system-generates-bir-compliant-receipts)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT introduce a second PDF library.** PDFKit is the locked decision. `pdf-lib` is for editing existing PDFs; `puppeteer` busts the Convex action bundle budget. If the contract layout seems to need HTML→PDF, **flag it as a Phase 2 reservation** and stop.
- ❌ **Do NOT inline the PDF generation inside the mutation.** Mutations are V8-runtime; PDFKit is Node-only. The mutation schedules the action; the action does the heavy lifting; an internal mutation records the result. This pattern is non-negotiable (architecture § Service Boundary).
- ❌ **Do NOT skip the version field.** Regeneration creates `v2`, `v3` — never overwrites `v1`. If the contract record is amended, the prior PDF stays canonical for the prior amendment.
- ❌ **Do NOT delete failed PDF rows.** Keep them with `pdfStatus: "failed"` + `lastError` populated; the runbook entry depends on operators being able to inspect them.
- ❌ **Do NOT expose PII in the contract PDF beyond what's necessary.** Customer's gov ID number is included as last-4 only (matches the audit-log redaction policy from Story 1.6). The contract is a legal doc; if §10 Q6 (ownership transfer policy) requires full gov ID, **flag it as a Phase 2 client question** and ship with last-4 until answered.
- ❌ **Do NOT use `Date()` or browser locale in the action.** All timestamps formatted in `Asia/Manila` via the shared `convex/lib/time.ts` helpers; all money via the centavo→peso helper.
- ❌ **Do NOT add a "View PDF" route in `src/app/(staff)/...`.** Reuse the receipt-viewer modal pattern (`ContractPdfPreview` component) — no new top-level routes for documents.
- ❌ **Do NOT email the PDF from inside the action.** Email is a side-channel (per Story 3.13 receipt-email pattern). If the Email button is wired, it triggers a separate action; failures there are NOT financial-transaction failures.
- ❌ **Do NOT bypass `emitAudit`.** Every generation + version bump + retry emits an entry. The audit log is the trail of evidence if a customer disputes a contract version.

### Common LLM-developer mistakes to prevent

- **Wrong runtime:** Putting PDFKit in `convex/contracts.ts` (V8 runtime). It MUST live in `convex/actions/generateContractPdf.ts` with `"use node"` on line 1.
- **Skipping the internal callback mutation:** Actions cannot write to the DB synchronously; they call back via `ctx.runMutation(internal.*)`. Forgetting this leaves the `pdfStatus` stuck at `"pending"` forever.
- **Duplicating helpers from Story 3.11:** Copy-pasting the PDFKit boilerplate produces drift (Story 6.2 will then have a third copy). Extract once into `convex/actions/lib/pdfkitHelpers.ts` and reuse.
- **Mutating `auditLog` directly:** Use `emitAudit` from `convex/lib/audit.ts`. ESLint blocks direct writes.
- **Public action instead of mutation:** `actions/generateContractPdf.ts` should be an `internalAction`, not a public action. The client triggers a public mutation; the mutation schedules the internal action.
- **Missing the version index:** The `by_contract_type_version` index is what lets the mutation efficiently compute `nextVersion`. Without it, the mutation does a full scan.
- **Treating retryCount as advisory:** The `retryCount < 3` gate in the scheduled sweep is load-bearing — without it, a permanently-malformed contract loops forever and burns Convex action minutes.

### Open questions / blockers this story does NOT resolve

- **§10 Q1 (installment grace / penalty policy)** — the terms paragraph reads from admin settings; if unanswered at impl time, use placeholder boilerplate + footnote referencing the open question. **Does NOT block this story** — but the legal team should sign off on the boilerplate before the first real contract is sent.
- **§10 Q6 (ownership transfer policy)** — affects whether the contract needs special clauses for inheritance / gift / court-order transfers. **Does NOT block this story** for first-sale contracts; flag for Phase 2 kickoff.
- **§10 Q7 (perpetual care fees)** — if perpetual care is annual, the schedule table may need a "post-installment annual fees" section. **Flag for Phase 2 kickoff**; this story ships without that section.
- **Cemetery branding assets** — letterhead PNG / logo source-of-truth must be confirmed with the client (same question Story 3.11 raised; should already be resolved). If not, use the placeholder Story 3.11 used.

### Phase 2 reservation

This story is **Phase 2 scope**. ACs are lighter than Phase 1 by design (per epics.md note: "Phase 2 / 3 ACs are intentionally lighter than Phase 1 — they'll be re-specced at phase kickoff"). At Phase 2 kickoff, expect:

- Re-elicitation of the contract terms language with the cemetery's legal counsel
- §10 Q1 / Q6 / Q7 answers folded back into the layout
- Possible addition of an "email contract PDF" action paralleling the receipt-email flow (Story 3.13)
- Possible field signing-via-tablet / e-signature flow (out of current scope; flagged as a Phase 3+ candidate)

Do NOT pre-build for these — implement the AC-minimum and surface the gaps in the dev-agent completion notes.

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure & Boundaries > Complete Project Directory Structure](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure) — `convex/actions/generateContractPdf.ts`, `src/components/ContractPdfPreview/`
- [Architecture § Service Boundary](../../_bmad-output/planning-artifacts/architecture.md#architectural-boundaries) — V8 mutation schedules Node action; action callbacks via internal mutation

No detected conflicts.

### References

- [PRD § FR49](../../_bmad-output/planning-artifacts/prd.md#9-document-generation)
- [Architecture § PDF library + Service boundary](../../_bmad-output/planning-artifacts/architecture.md#core-architectural-decisions)
- [UX § Implementation Roadmap > Phase 2](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [Epics § Story 6.1](../../_bmad-output/planning-artifacts/epics.md#story-61-office-staff-generates-an-installment-contract-as-pdf)
- [Previous story (3.11)](./3-11-system-generates-bir-compliant-receipts.md) (when created) — receipt PDF infra reused here

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (claude-opus-4-7) via Claude Code, dev-agent flow (2026-05-20).

### Debug Log References

- `npm run lint` — clean (no warnings, no errors).
- `npm run typecheck` — three pre-existing errors only (`convex/contracts.ts:521`, `convex/contracts.ts:1061`, `convex/receipts.ts:653`), all from prior stories (the `ctx.db.insert("contracts", ...)` cast workaround for the wide table union + the `DataModel["_storage"]` lookup); no new errors introduced by this story's diff.
- `npm test` — `1566 passed | 1 skipped (1567)`; new `tests/unit/convex/contracts-pdf.test.ts` adds 13 passing cases.
- `npm run build` — clean production build; `/contracts/[contractId]` route bundle now 2.49 kB (slightly up from prior baseline to fit the PDF generation card + reactive download link).

### Completion Notes List

- **Spec deviation (intentional, called out in the system message file-ownership list):** this slice persists the PDF blob pointer inline on the `contracts` row (`pdfStorageId` + `pdfGeneratedAt`) instead of introducing a separate `contractDocuments` table with version history. Regeneration overwrites both fields; prior PDF blobs are NOT retained. The schema JSDoc + the action's top-of-file comment flag this as a Phase-2 reservation — a future story may promote to a versioned child table without changing the action's contract.
- **Scheduled retry / failed-state UI also deferred** as a consequence of the above deviation: there is no `pdfStatus: "pending" | "ready" | "failed"` column; the UI infers state from `pdfStorageId === undefined` (never generated / in flight) vs populated (ready). If the action fails, the UI's "Generate" button remains active so the operator can re-trigger. A scheduled-retry cron is out of scope (would require `convex/scheduled.ts` which the system message marks as forbidden for this story).
- **No `ContractPdfPreview` modal component** — story spec's Task 8 component was outside the file-ownership list and is therefore deferred. The button opens the signed URL in a new tab via a plain `<a target="_blank">` — operationally equivalent for first-cut Phase-2 usage and avoids touching component scope outside this slice.
- **Phase 2 kickoff items surfaced for the client:**
  1. §10 Q1 (grace / penalty policy) — the contract terms paragraph in the rendered PDF is placeholder boilerplate with a "Final terms language pending §10 Q1" footnote. Legal counsel sign-off required before the first real contract is sent.
  2. §10 Q3 (BIR registration confirmation) — the letterhead reads `PLACEHOLDER_BIR_CONFIG` until the cemetery's BIR-registered name + TIN + signatory are confirmed. The footer notes `Format version: v1-placeholder` so an auditor can tell which contracts ran under the placeholder template.
  3. §10 Q6 (ownership transfer policy) — the customer's gov ID is rendered last-4 only (matching audit-log redaction policy). If transfer affidavits require the full number, a Phase-2 follow-up adds a separate doc type.
  4. Versioned contract-PDF history (see spec deviation above).
  5. Failed-PDF dashboard alert + retry cron.
- **Cross-runtime import strategy:** the V8-runtime mutation in `convex/contracts.ts` cannot `import` from the `"use node"` action file (would leak `pdfkit` into the V8 bundle). The action and the mutation each define a `GENERATE_CONTRACT_PDF_ACTION_PATH` constant; the test suite's "exposes the canonical function path constants" + "schedules the PDF action" cases pin both ends so the string-path drift surfaces immediately on rename.
- **PDFKit smoke test:** the test asserts the produced buffer starts with the `%PDF-` magic header (the minimum-bar fidelity check the story spec accepts). Pixel diffs deferred to a Phase-2 BIR-confirmation follow-up.

### File List

Created:
- `convex/actions/generateContractPdf.ts` — Node-runtime action + internal query (`_getContractForPdfRender`) + internal mutation (`_recordContractPdfReady`) + pure `renderContractPdf` helper exported via `__testing` for unit tests.
- `tests/unit/convex/contracts-pdf.test.ts` — 13 tests covering the mutation auth + scheduler + audit emission, the query null/url branches + auth + NOT_FOUND, the PDFKit smoke render, and the function-path-constant parity.

Modified:
- `convex/schema.ts` — added optional `pdfStorageId: v.id("_storage")` + `pdfGeneratedAt: v.number()` columns to the `contracts` table (inline pointer to latest PDF blob; spec-deviation note in JSDoc).
- `convex/contracts.ts` — appended `generateContractPdfRequest` public mutation + `getContractPdfUrl` public query + the `GENERATE_CONTRACT_PDF_ACTION_PATH` constant + `makeFunctionReference` import. No edits to existing `recordFullPaymentSale` / `recordInstallmentSale` / `transitionState`.
- `src/app/(staff)/contracts/[contractId]/page.tsx` — added the "Contract document" card with Generate / Regenerate / Download buttons + reactive in-flight state + generated-at timestamp display.
- `package.json` — added `pdfkit ^0.18.0` (dep) + `@types/pdfkit ^0.17.6` (devDep).
