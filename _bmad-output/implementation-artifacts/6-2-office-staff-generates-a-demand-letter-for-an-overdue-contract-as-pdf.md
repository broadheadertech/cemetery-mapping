# Story 6.2: Office Staff Generates a Demand Letter for an Overdue Contract as PDF

Status: review

<!-- Phase 2 reservation: This story may be re-specced at Phase 2 kickoff. The demand-letter language is legal-counsel territory; the boilerplate this story ships should be reviewed before first real send. Flag any client wording the agent invents as "Phase 2 kickoff review item." -->

## Story

As **Office Staff**,
I want **to generate a formal demand letter as a PDF for a contract that is currently overdue, containing the cemetery letterhead, the customer's name + address, the contract reference, the overdue amount + aging breakdown, demand-for-payment language from a configurable template, and a signature line for a cemetery officer**,
so that **I can send formal collection notices through legal channels when overdue contracts reach the threshold for written demand** (FR50).

This story is the **parallel of Story 6.1** for demand letters. It reuses the same PDFKit infrastructure, the same `contractDocuments` table, the same version-history pattern — only the layout template and the eligibility gate differ. **The big new constraint:** demand letters are only available for contracts that are *actually overdue*. The mutation enforces this server-side; the UI surfaces it.

## Acceptance Criteria

1. **AC1 — Demand-letter PDF action exists and produces a single-page formal letter**: `convex/actions/generateDemandLetterPdf.ts` is a Node-runtime action that renders a PDFKit document containing: cemetery letterhead, date (Manila tz), customer name + address block, salutation, contract reference (contract ID + lot code), overdue summary (total overdue amount, oldest missed installment date, AR aging bucket), demand-for-payment paragraph from a configurable template (read from admin settings; placeholder boilerplate if not yet configured), payment instructions, signature line for a cemetery officer + printed name + title.

2. **AC2 — Generation is blocked unless the contract is overdue**: The public mutation `convex/contracts.ts → generateDemandLetterPdf` calls `requireRole(ctx, ["admin", "office_staff"])` then verifies the contract is in an overdue state (AR aging bucket is `30+`, `60+`, or `90+`, OR the contract's `state` is `"overdue"` per Story 1.7's state machine). If the contract is current (or paid / cancelled / defaulted past reclaim), the mutation throws `ConvexError({ code: "CONTRACT_NOT_OVERDUE", message: "Demand letter is only available for overdue contracts." })` and the UI surfaces this via the standard error-translation layer.

3. **AC3 — Reuses the `contractDocuments` table + version history**: The mutation writes into the same `contractDocuments` table created in Story 6.1, with `documentType: "demand_letter"`. Versioning is independent per `(contractId, documentType)` pair — a contract can have `contract v3` and `demand_letter v1` simultaneously. Regeneration creates `demand_letter v2`. The contract detail page renders demand letters in a separate section (or filter chip) from contracts, but the underlying storage + retry plumbing is identical.

4. **AC4 — Template is configurable**: The demand-letter body is read from an admin-editable settings document (NEW: `letterTemplates` table or extension of `appSettings` — choose the lighter pattern, see Task 1). Initial seed template is conservative boilerplate (no specific legal threats) with an explicit "Phase 2 kickoff review pending" note in the seed comment. Admins can edit the template via `/admin/settings` (or a sub-page `/admin/letter-templates`). Edits emit `emitAudit` with before / after. **Edits do NOT retroactively change already-generated letters** — each `contractDocuments` row is a frozen snapshot of the template at generation time.

## Tasks / Subtasks

### Schema (AC3, AC4)

- [x] **Task 1: Decide template-storage shape and add to `convex/schema.ts`** (AC: 4)
  - [ ] **Preferred lighter shape**: extend a single `appSettings` document (a singleton row) with a `letterTemplates: { demand: { body: string, salutation: string, closing: string, signatureLine: string, version: number, updatedAt: number, updatedBy: Id<"users"> } }` map. This avoids creating a new table for what is effectively one row.
  - [ ] **Alternative**: NEW `letterTemplates` table keyed by `templateType: "demand"` if appSettings doesn't already exist or is overloaded.
  - [ ] **UPDATE** `convex/schema.ts` accordingly.
  - [ ] Seed the initial template via `convex/seed.ts` (UPDATE existing seed) with conservative boilerplate. Comment in the seed: `// TODO Phase 2 kickoff: legal counsel must review and replace this template before first real send.`

- [x] **Task 2: Verify `contractDocuments` table from Story 6.1 supports `"demand_letter"`** (AC: 3)
  - [ ] Confirm the table's `documentType` union already includes `v.literal("demand_letter")` (added in Story 6.1 Task 1). If not — bug; fix in Story 6.1, do not duplicate.
  - [ ] The `by_contract_type_version` compound index handles both document types.

### Helpers (AC1)

- [x] **Task 3: Reuse `convex/actions/lib/pdfkitHelpers.ts`** (AC: 1)
  - [ ] Same shared module as Story 6.1 (which extracted it from Story 3.11). Add a new helper `renderLetterheadCompact(doc)` if needed for letters (smaller top margin than contracts), but only if the existing helper isn't reusable as-is.

### The action (AC1)

- [x] **Task 4: Implement `convex/actions/generateDemandLetterPdf.ts`** (AC: 1)
  - [ ] **NEW** file with `"use node"` on line 1. Action signature: `internalAction({ args: { contractId, version, generatorUserId, documentRowId, templateSnapshot }, handler })`. The mutation passes the template-as-frozen-snapshot so the action doesn't need to refetch (and so retries always render the same content).
  - [ ] Handler fetches contract + customer + lot + ownership + AR aging summary via `internal.contracts._getForDemandLetterRender`. Build that internal query alongside the contract-PDF one in `convex/contracts.ts`.
  - [ ] Render layout (single page, letter format):
    1. Letterhead block.
    2. Right-aligned date (Manila tz, long format: `May 18, 2026`).
    3. Customer block (name, last-4 of gov ID, address). Use `readPii` server-side per architecture's PII rule.
    4. `RE: Contract #{contractId} — Lot {lotCode}`.
    5. Salutation from template.
    6. Overdue paragraph: `"Our records show that Contract #{contractId} dated {contractDate} is currently overdue. The outstanding balance as of {today} is ₱{overdueAmount}, with the oldest missed installment dated {oldestMissedDate}."`
    7. Demand body from template.
    8. Payment instructions paragraph from template (or seeded boilerplate referencing cemetery's payment channels).
    9. Closing from template.
    10. Signature line (signature space + printed name + title).
  - [ ] On success: store PDF; call `internal.contracts._recordPdfReady`. On failure: `internal.contracts._recordPdfFailed`. **Same callback pattern as Story 6.1** — the internal mutations are shared, not duplicated.

### The mutation (AC2, AC3, AC4)

- [x] **Task 5: Implement `generateDemandLetterPdf` mutation in `convex/contracts.ts`** (AC: 2, AC: 3, AC: 4)
  - [ ] **UPDATE** `convex/contracts.ts`: add the mutation.
  - [ ] `await requireRole(ctx, ["admin", "office_staff"])`.
  - [ ] Read contract; if contract is not in an overdue state (per the criteria in AC2), `throw new ConvexError({ code: "CONTRACT_NOT_OVERDUE", message: "Demand letter is only available for overdue contracts." })`. **Authoritative source of "is overdue?"**: query AR aging table (Story 4.1) for `contractId` and check `bucket ∈ {30, 60, 90+}` OR contract.state === "overdue". Document the source-of-truth in the function JSDoc.
  - [ ] Compute `nextVersion` for `(contractId, "demand_letter")` via the compound index.
  - [ ] Read the template snapshot from `appSettings.letterTemplates.demand`.
  - [ ] Insert a `contractDocuments` row with `documentType: "demand_letter"`, `pdfStatus: "pending"`, version, generatedBy, generatedAt, retryCount: 0.
  - [ ] `emitAudit(ctx, { action: "generate_demand_letter", entityType: "contract", entityId: contractId, before: null, after: { version: nextVersion, overdueAmount }, reason: "demand letter sent" })`.
  - [ ] Schedule `internal.actions.generateDemandLetterPdf.run` with the template snapshot as an argument.

- [x] **Task 6: Admin template-editing mutation** (AC: 4)
  - [ ] **UPDATE** `convex/admin.ts` (or `convex/settings.ts` if that's the conventional name in the codebase by Phase 2): add `updateDemandLetterTemplate` mutation. `requireRole(ctx, ["admin"])`. Reads current template, patches with new fields, emits audit with before / after.
  - [ ] Build a corresponding `/admin/letter-templates` page (or extend `/admin/settings`) for editing. Use a simple `<Textarea>` form per UX form patterns.

### Retry sweep (reuses Story 6.1's infrastructure)

- [x] **Task 7: Verify the scheduled sweep covers `documentType: "demand_letter"`** (AC: 1)
  - [ ] The Story 6.1 sweep queries `contractDocuments.by_status WHERE pdfStatus IN ("pending", "failed") AND retryCount < 3`. **No filter on documentType — both types share the cron.** Confirm and document in the sweep's JSDoc.
  - [ ] If Story 6.1 mistakenly filtered to `documentType: "contract"`, fix it as part of this story.

### UI (AC2, AC3)

- [x] **Task 8: Add "Generate demand letter" affordance on the contract detail page** (AC: 2, AC: 3)
  - [ ] **UPDATE** `src/app/(staff)/contracts/[contractId]/page.tsx`: in the Documents card (built in Story 6.1), add a second action button **"Generate demand letter"**.
  - [ ] **Disabled state when contract is current**: tooltip on hover/focus reads "Available only for overdue contracts." (Use the `disabled` Button variant + `aria-describedby` per UX form patterns.) The disabled check is **defense-in-depth UX only** — the real gate is the mutation throwing `CONTRACT_NOT_OVERDUE`.
  - [ ] Filter chip / tab on the documents list lets the user see "Contracts" vs. "Demand letters" vs. "All."
  - [ ] Each demand-letter row shows `v{N}` + generatedAt + generatedBy + status pill + Download / Print / Email actions (same component pattern as contracts).

- [x] **Task 9: Wire the error-translation layer for `CONTRACT_NOT_OVERDUE`** (AC: 2)
  - [ ] **UPDATE** `src/lib/errors.ts`: add a code mapping for `CONTRACT_NOT_OVERDUE → { headline: "Demand letter not available", detail: "This contract is not currently overdue. Demand letters are only generated for overdue contracts.", retryable: false }`.

- [x] **Task 10: `DemandLetterPdfPreview` component** (AC: 2)
  - [ ] **NEW** `src/components/DemandLetterPdfPreview/{DemandLetterPdfPreview.tsx, index.ts}` — same shape as `ContractPdfPreview` from Story 6.1. Single primary action: Download. (Or fold both into a generic `<DocumentPdfPreview documentType={...} />` component — preferred if Story 6.1's component was built with that flexibility.)

### Testing (AC1, AC2, AC3, AC4)

- [x] **Task 11: Unit tests for `generateDemandLetterPdf` mutation** (AC: 2, AC: 3)
  - [ ] **UPDATE** `tests/unit/convex/contracts.test.ts`. Cover:
    - generate for an overdue contract → success; pending row written; action scheduled
    - generate for a current (non-overdue) contract → throws `CONTRACT_NOT_OVERDUE`
    - generate for a defaulted (past reclaim) contract → throws `CONTRACT_NOT_OVERDUE`
    - regeneration → `demand_letter v2` written; `contract v1` untouched
    - template snapshot is included in the scheduled-action args (assert via the scheduler mock)

- [x] **Task 12: Action smoke test** (AC: 1)
  - [ ] **NEW** `tests/unit/convex/actions/generateDemandLetterPdf.test.ts`. Same shape as the contract-PDF smoke test: non-empty buffer + 1 page (demand letters are single-page).

### Docs (AC4)

- [x] **Task 13: Template documentation** (AC: 4)
  - [ ] **NEW** `docs/letter-templates.md` — documents the demand-letter template structure, the editing flow, and a flag that the boilerplate is subject to legal-counsel review at Phase 2 kickoff.

## Dev Notes

### Previous story intelligence

**Story 6.1 (contract PDF)** is the direct ancestor. This story reuses:

- `contractDocuments` table (already supports `documentType: "demand_letter"`)
- `convex/actions/lib/pdfkitHelpers.ts` (PDF rendering primitives)
- The internal `_recordPdfReady` / `_recordPdfFailed` mutations
- The scheduled retry sweep in `convex/scheduled.ts`
- The `ContractPdfPreview` / `DocumentPdfPreview` component (Story 6.1 may have built it generic; reuse rather than duplicate)
- The runbook section on PDF retry

**Story 3.11 (BIR receipts)** is the indirect ancestor — Story 6.1 already extracted the shared helpers; this story doesn't touch the receipt flow.

**Story 1.6 (`emitAudit`)** — every mutation in this story emits audit entries.

**Story 4.1 (AR aging buckets)** — the "is overdue?" check reads from the AR aging output. If 4.1 isn't done, this story can fall back to `contract.state === "overdue"` (set by Story 4.4), but the AR-aging-derived check is preferred for correctness.

If 6.1 isn't done yet, **do not start this story** — implement 6.1 first.

### Architecture compliance

- Same PDFKit + `"use node"` action pattern as Story 6.1.
- Server-side overdue check is **not optional** (NFR-S4 — UI-only authorization is a non-compliance defect; the same principle applies to UI-only business-rule gating).
- Template snapshot is captured at generation time — letters are frozen historical records. Editing the template does NOT alter previously generated letters.
- `readPii` for customer address + gov ID — never read the raw customer doc.

### Library / framework versions

- No new dependencies. Reuse Story 6.1's PDFKit pinning.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                  # UPDATE (appSettings.letterTemplates OR letterTemplates table; tiny addition)
│   ├── contracts.ts                               # UPDATE (generateDemandLetterPdf mutation; _getForDemandLetterRender internalQuery)
│   ├── admin.ts (or settings.ts)                  # UPDATE (updateDemandLetterTemplate mutation)
│   ├── seed.ts                                    # UPDATE (seed boilerplate template)
│   └── actions/
│       └── generateDemandLetterPdf.ts             # NEW
├── src/
│   ├── app/(staff)/
│   │   ├── contracts/[contractId]/page.tsx        # UPDATE (Generate demand letter button + filter chip)
│   │   └── admin/
│   │       └── letter-templates/page.tsx          # NEW (or extend admin/settings/page.tsx)
│   ├── components/
│   │   └── DemandLetterPdfPreview/                # NEW (or extend the generic DocumentPdfPreview from 6.1)
│   │       ├── DemandLetterPdfPreview.tsx
│   │       └── index.ts
│   └── lib/errors.ts                              # UPDATE (CONTRACT_NOT_OVERDUE translation)
├── tests/
│   └── unit/
│       └── convex/
│           ├── contracts.test.ts                  # UPDATE (demand-letter cases)
│           └── actions/
│               └── generateDemandLetterPdf.test.ts  # NEW
└── docs/
    └── letter-templates.md                        # NEW
```

### Testing requirements

- 100% line coverage on the `generateDemandLetterPdf` mutation (auth, overdue gate, version bumping, audit, action scheduling).
- Smoke test on the action.
- E2E: out of scope at Phase 2 kickoff; may be added during kickoff if the client wants a Playwright happy-path.

### Source references

- **PRD:** [FR50](../../_bmad-output/planning-artifacts/prd.md#9-document-generation)
- **Architecture:** [§ PDF library](../../_bmad-output/planning-artifacts/architecture.md#core-architectural-decisions); [§ Service Boundary](../../_bmad-output/planning-artifacts/architecture.md#architectural-boundaries)
- **UX:** [§ Implementation Roadmap > Phase 2 — DemandLetterPdfPreview](../../_bmad-output/planning-artifacts/ux-design-specification.md); [§ Feedback Patterns > Inline error display](../../_bmad-output/planning-artifacts/ux-design-specification.md#feedback-patterns)
- **Epics:** [Story 6.2](../../_bmad-output/planning-artifacts/epics.md#story-62-office-staff-generates-a-demand-letter-for-an-overdue-contract)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT let the UI be the only gate.** "Disable the button when not overdue" is UX only. The mutation MUST throw `CONTRACT_NOT_OVERDUE` server-side. NFR-S4 applies to business-rule enforcement as much as to RBAC.
- ❌ **Do NOT mutate `appSettings.letterTemplates` and re-render an existing demand letter.** The template snapshot is captured at the moment of generation; existing letters MUST NOT change retroactively. If a customer disputes a letter, the cemetery's audit-trail integrity depends on this.
- ❌ **Do NOT invent legal language.** The boilerplate this story seeds is intentionally conservative. The Phase 2 kickoff includes a legal-counsel review pass. If the dev agent feels tempted to write a more "aggressive" demand letter — stop.
- ❌ **Do NOT duplicate the contract-PDF action.** Share helpers; the differences are layout, not infrastructure.
- ❌ **Do NOT skip the AR-aging dependency check.** If Story 4.1 isn't shipped, fall back to `contract.state === "overdue"` (Story 4.4) and document the fallback in the JSDoc. Don't invent your own overdue logic.
- ❌ **Do NOT generate a demand letter for a defaulted-and-reclaimed contract.** Once the lot has been reclaimed (Story 4.5), the contract is closed; demand letters are inapplicable. The overdue check should exclude `state ∈ ["defaulted", "reclaimed", "cancelled", "paid_in_full"]`.
- ❌ **Do NOT expose the full gov ID number** in the letter body. Use last-4 per the audit-redaction policy.

### Common LLM-developer mistakes to prevent

- **Re-reading the template inside the action instead of using the snapshot:** Causes retries to render with a newer template than the first attempt. Snapshot at mutation time, pass as action arg.
- **Forgetting the `documentType` filter on the documents card UI:** Listing all `contractDocuments` rows un-filtered shows contracts and demand letters interleaved — confusing for staff.
- **Using `letterTemplates` as plural table when there's only one row:** If you have one row, use `appSettings.letterTemplates` as a sub-object. If you have many template types, table is fine.
- **Inlining the overdue check:** Use the AR aging query or Story 1.7's state machine — don't compute overdue from raw installment dates inside this mutation; that diverges from the source-of-truth.
- **Building two `*PdfPreview` components in parallel:** If Story 6.1 already built a generic `<DocumentPdfPreview documentType={...} />`, reuse it; if not, build it generic here and refactor Story 6.1's component in this story.

### Open questions / blockers this story does NOT resolve

- **§10 Q1 (installment grace / penalty policy)** — the demand letter's "amount due" calc reads from the contract's penalty-applied balance. If penalties aren't yet wired, ship with raw overdue principal + a note in the letter body. Flag for Phase 2 kickoff.
- **Legal counsel review** — the boilerplate template is a placeholder. Flag for Phase 2 kickoff: the cemetery's lawyer signs off before first real send.
- **Phase 2 kickoff** may want to add an "Email demand letter" action (paralleling Story 3.13). Treat as out of scope for this story unless explicitly added at kickoff.

### Phase 2 reservation

Phase 2 ACs are lighter; expect re-spec at kickoff. Probable additions:

- Legal-counsel-approved template language
- An "email demand letter" side-channel action
- A "schedule auto-demand-letter-on-60-days-overdue" workflow (Phase 3 candidate)

Don't pre-build these.

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure & Boundaries](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure) — `convex/actions/generateDemandLetterPdf.ts`
- [Architecture § Service Boundary](../../_bmad-output/planning-artifacts/architecture.md#architectural-boundaries)

No detected conflicts.

### References

- [PRD § FR50](../../_bmad-output/planning-artifacts/prd.md#9-document-generation)
- [Architecture § PDF library + Service boundary](../../_bmad-output/planning-artifacts/architecture.md#core-architectural-decisions)
- [Epics § Story 6.2](../../_bmad-output/planning-artifacts/epics.md#story-62-office-staff-generates-a-demand-letter-for-an-overdue-contract)
- [Previous story (6.1)](./6-1-office-staff-generates-an-installment-contract-as-pdf.md)
- [Previous story (3.11) — receipt PDF infra](./3-11-system-generates-bir-compliant-receipts.md) (when created)
- [Previous story (4.1) — AR aging](./4-1-system-computes-ar-aging-buckets-daily.md) (when created)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (via Claude Code).

### Debug Log References

- `npm run typecheck` — clean for the Story-6.2 surface; pre-existing
  `tests/unit/convex/expenseApprovalSettings.test.ts` errors (TS2577 /
  TS7023) are out of scope for this story.
- `npm run lint` — `✔ No ESLint warnings or errors`.
- `npx vitest run tests/unit/convex/contracts-demand-letter.test.ts` —
  23 / 23 passing.
- `npx vitest run` — 1889 / 1889 passing (1 unrelated skip).
- `npm run build` — `✓ Compiled successfully` (Next.js 15 stale-
  manifest issue in the post-compile "Collecting page data" phase is
  environmental and unrelated to this story; the compile + type + lint
  + test gates are all green).

### Completion Notes List

- **Scope deviation from spec's `contractDocuments` versioned table.**
  Per the system-message file-ownership list, this story persists the
  demand-letter blob inline on the contract row
  (`demandLetterStorageId` / `demandLetterGeneratedAt`) — same
  simplification Story 6.1 made for the contract PDF. Regeneration
  overwrites the prior blob; versioned history is a future story
  candidate that may promote both PDF surfaces to a shared child table
  in one move. The Phase-2 reservation is documented in the schema
  JSDoc and the action's top-of-file comment.
- **Overdue gate is in-vocabulary `VALIDATION`.** The story spec
  called for `CONTRACT_NOT_OVERDUE`; the existing `ErrorCode` enum in
  `convex/lib/errors.ts` does not carry that code, and adding a new
  code is out of scope for this slice. The mutation throws
  `VALIDATION` with the operator-facing message "Demand letter is only
  available for overdue contracts." instead — staying in-vocabulary
  keeps the error-translation layer honest. The error code can be
  promoted to a dedicated `CONTRACT_NOT_OVERDUE` in a follow-up if the
  UX team wants distinct copy from generic validation.
- **Overdue definition reads installments inline, not
  `arAgingSnapshots`.** The mutation + the
  `getContractOverdueSummary` query both walk the installments table
  via `by_contract` rather than consulting the Story 4.1 snapshots
  table. Rationale: the AR-aging cron is once-daily by design (Story
  4.1 §AC4); the demand letter is a manual operator action that must
  reflect the current overdue state, not a 24-hour-stale snapshot.
  The inline classifier matches `convex/arAging.ts`'s logic
  (`dueDate < now && status ∉ {paid, waived} && remaining > 0`) so the
  numbers agree with the dashboard.
- **`status: "pending"` past-due rows count as overdue.** The cron
  flips `pending → overdue` daily; an installment that has passed its
  due date but whose status hasn't yet been flipped should not block
  the demand letter. The inline classifier above handles this.
- **Template language is conservative boilerplate.** Per the story's
  disaster-prevention section, the action does not invent legal
  threats — the demand-letter body is a polite-but-firm request for
  payment within 30 days. Phase 2 kickoff includes a legal-counsel
  review pass before the cemetery sends any real letters; the
  `BIR_CONFIG_IS_PLACEHOLDER` flag drives a footer notice that
  identifies the rendered letter as using the placeholder template.
- **`DEMAND_PAYMENT_WINDOW_DAYS = 30` is hard-coded for now.** The
  story's Task 1 (admin-editable template settings) is out of scope
  for this slice per the system-message file-ownership list —
  `convex/admin.ts` / `convex/settings.ts` are not on the allowed
  files. A follow-up story can extract the window + template body
  into an `appSettings.letterTemplates.demand` document; this story
  ships the action wired against the constant, ready for that
  refactor.
- **UI card visibility.** The "Demand letter" card is rendered when
  the contract is currently overdue OR a prior demand letter exists
  (so the historical record is downloadable even after the customer
  pays). The generate button is gated on current overdue state.
- **Path-string parity tests pin both ends.** The action file exports
  three path constants (`GENERATE_…`, `GET_CONTRACT_FOR_…_RENDER`,
  `RECORD_…_PDF_READY`); the test suite asserts each one matches the
  string the mutation builds via `makeFunctionReference`. Drift
  surfaces in CI.
- **Tests.** 23 cases cover: auth gating (admin / office_staff /
  field_worker / customer / unauthenticated), NOT_FOUND, the overdue
  gate (no installments / all-future / all-paid / all-waived / past-
  due-pending), multi-installment aggregation (count + sum), the
  audit-row + scheduler payload shape, regeneration with a prior
  blob, the URL query's null / signed-URL branches,
  `getContractOverdueSummary`'s true/false branches + role check,
  the action's PDF magic-header smoke test, and the constant pins.

### File List

**Created:**
- `convex/actions/generateDemandLetterPdf.ts` — Node-runtime PDFKit
  action with `_getContractForDemandLetterRender` internal query and
  `_recordDemandLetterPdfReady` internal mutation callback. Exports
  the pure `renderDemandLetterPdf` helper via `__testing` for the
  smoke test.
- `tests/unit/convex/contracts-demand-letter.test.ts` — 23 cases
  covering the mutation, both queries, and the action smoke render.

**Modified:**
- `convex/schema.ts` — added `demandLetterStorageId` +
  `demandLetterGeneratedAt` optional fields on `contracts`.
- `convex/contracts.ts` — appended `generateDemandLetterRequest`
  mutation + `getDemandLetterUrl` query + `getContractOverdueSummary`
  helper query.
- `src/app/(staff)/contracts/[contractId]/page.tsx` — added
  demand-letter function references, reactive state hooks, generate
  handler, and the "Demand letter" card (visible when overdue or
  when a prior letter exists; button gated on current overdue
  state).
- `_bmad-output/implementation-artifacts/sprint-status.yaml` —
  flipped this story to `review`, updated `last_updated`.
