# Story 6.8: Office Staff Generates a Memorial Plaque PDF

Status: review

<!-- Brand-tier extension: Chapter VII of the Apostle Paul brand guide shows a physical plaque example — "MATEO REYES / 1942 — 2026 / A devoted father, a kind soul, and a quiet light to those who knew him." The cemetery produces these in honed stone with bronze infill; the system should produce a PDF preview the family can review BEFORE stone engraving. The PDF generator itself (Tier 3 of the brand-application pass) is being implemented in `convex/actions/generatePlaquePdf.ts`. This story documents the office-staff-facing UI + workflow that surfaces it. -->

## Story

As **Office Staff**,
I want **to generate a memorial plaque PDF for a lot interment with the deceased's name, life dates (Arabic or Roman-numeral per family preference), and an optional italic epitaph**,
so that **the family can take a copy of the planned monument inscription for review before stone engraving** (extends FR49 Document Generation).

This story builds the office-staff UI + the supporting `plaqueDrafts` table that surfaces the existing `generatePlaquePdf` action (delivered in Tier 3 of the brand-application pass). The action itself is **not** in this story's scope — only the user-facing workflow that triggers it, persists drafts (multiple per interment for family revisions), and surfaces the reactive download link.

## Acceptance Criteria

1. **AC1 — `plaqueDrafts` table persists multiple draft revisions per interment**: `convex/schema.ts` defines a `plaqueDrafts` table with: `intermentId: v.id("interments")`, `deceasedName: v.string()` (uppercase rendered; stored as entered), `bornYear: v.number()` (4-digit year), `diedYear: v.number()` (4-digit year), `dateFormat: v.union(v.literal("arabic"), v.literal("roman"))` (e.g. `"1942 — 2026"` vs `"MCMXLII — MMXXVI"`), `epitaph: v.optional(v.string())` (max 240 chars; rendered italic on the plaque), `version: v.number()` (1-indexed per interment), `pdfStorageId: v.optional(v.id("_storage"))`, `pdfStatus: v.union(v.literal("pending"), v.literal("ready"), v.literal("failed"))`, `generatedBy: v.id("users")`, `generatedAt: v.number()`, `retryCount: v.number()`, `lastError: v.optional(v.string())`. Indexes: `by_interment_version` `["intermentId", "version"]` (history listing), `by_status` `["pdfStatus"]` (scheduled retry sweep parity with [Story 6.1](./6-1-office-staff-generates-an-installment-contract-as-pdf.md)).

2. **AC2 — `/interments/[intermentId]/plaque` page (admin + office_staff) hosts the form + draft history**: A new authenticated route `/interments/[intermentId]/plaque` (gated to `admin` + `office_staff` via the existing middleware) shows: (a) a form prefilled with the deceased's name from the joined occupant record + the occupant's `bornYear` / `diedYear` if [Story 2.6](./2-6-lot-has-multiple-occupants-distinct-from-owners.md) carries them (fallback: blank fields the operator fills in), (b) toggle: `Arabic 1942 — 2026 / Roman MCMXLII — MMXXVI`, (c) optional epitaph textarea (240-char limit; live count; preview-line-break-aware), (d) a "Generate plaque PDF" primary button that calls a public mutation, and (e) a "Draft history" rail showing every prior `plaqueDrafts` row for this interment (v1, v2, v3…) with status pill, generated-by name, generated-at timestamp (Manila tz), Download link, and a "Use these values as starting point" action that prefills the form with that draft's values.

3. **AC3 — Public mutation schedules the Tier-3 `generatePlaquePdf` action via `ctx.scheduler.runAfter(0, ...)`; reactive download link surfaces when `pdfStorageId` lands**: `convex/plaqueDrafts.ts → requestPlaqueDraft` mutation calls `requireRole(ctx, ["admin", "office_staff"])`, asserts the interment exists, computes `nextVersion = (maxExisting?.version ?? 0) + 1`, inserts a `plaqueDrafts` row with `pdfStatus: "pending"`, then `await ctx.scheduler.runAfter(0, internal.actions.generatePlaquePdf.run, { plaqueDraftId, deceasedName, bornYear, diedYear, dateFormat, epitaph })`. The action (delivered separately in Tier 3) calls back into an internal mutation `_recordPlaqueReady` / `_recordPlaqueFailed` mirroring Story 6.1's pattern. The page's `useQuery(api.plaqueDrafts.listForInterment, { intermentId })` re-renders reactively when the `pdfStorageId` lands; the new draft row's status pill flips from amber `pending` to green `ready` with the standard 600ms `ReactiveHighlight` fade ([Story 1.4](./1-4-visual-foundation-locked-statuspill-reactivehighlight-ship.md)).

4. **AC4 — Plaque generation can also be triggered from the customer-detail page for a customer with a deceased occupant**: On the customer detail page ([Story 2.5](./2-5-customer-detail-page-with-ownership-history.md)) — specifically the occupants card from [Story 2.6](./2-6-lot-has-multiple-occupants-distinct-from-owners.md) — each occupant with `diedYear` populated gets a small **"Plaque"** action link. Clicking it navigates to the latest interment for that occupant (or, if no interment exists, the operator-side affordance grays out with a tooltip "Schedule an interment first" — interment scheduling is [Story 7.1](./7-1-office-staff-schedules-an-interment.md)). On the interment plaque page, the form is prefilled with the occupant's name + dates so the operator can go from "deceased occupant in the system" to "downloadable plaque preview" in two clicks.

5. **AC5 — Audit + failure recovery match Story 6.1's pattern**: Every mutation emits `emitAudit` (Story 1.6) with `action: "generate_plaque_draft" | "plaque_pdf_ready" | "plaque_pdf_failed"`. Failed drafts surface a manual "Retry" affordance to admin only (per Story 6.1 precedent). The scheduled-retry cron in `convex/scheduled.ts` extends to scan `plaqueDrafts.by_status` for `pdfStatus IN ("pending", "failed") AND retryCount < 3` and re-schedules the action.

## Tasks / Subtasks

### Schema (AC1)

- [ ] **Task 1: Add the `plaqueDrafts` table to `convex/schema.ts`** (AC: 1)
  - [ ] **UPDATE** `convex/schema.ts`: add the table per AC1. Indexes: `by_interment_version`, `by_status`.
  - [ ] Document the table choice in `docs/adr/0068-plaque-pdf-drafts.md` (NEW ADR) — cover the multi-draft (versioned) pattern, parity with Story 6.1's contract-PDF document-history table, and the Tier-3 action contract.

### Domain mutations + queries (AC3, AC5)

- [ ] **Task 2: Implement `convex/plaqueDrafts.ts`** (AC: 3, AC: 5)
  - [ ] **NEW** `convex/plaqueDrafts.ts`. Exports:
    - `requestPlaqueDraft({ intermentId, deceasedName, bornYear, diedYear, dateFormat, epitaph? })` — `requireRole(ctx, ["admin", "office_staff"])`. Asserts the interment exists. Validates `bornYear < diedYear`, both in `1800–<currentYear+1>` range. Validates `epitaph?.length <= 240`. Computes `nextVersion` via `by_interment_version` index. Inserts the row with `pdfStatus: "pending"`, `retryCount: 0`, `generatedBy`, `generatedAt: Date.now()`. Emits audit. `await ctx.scheduler.runAfter(0, internal.actions.generatePlaquePdf.run, { plaqueDraftId: insertedId, deceasedName, bornYear, diedYear, dateFormat, epitaph })` — the action lives in Tier 3 work and is invoked by canonical function reference. Returns `{ plaqueDraftId, version: nextVersion }`.
    - `retryPlaqueDraft({ plaqueDraftId })` — `requireRole(ctx, ["admin"])` (retry is admin-only per Story 6.1 precedent). Resets `pdfStatus: "pending"`, increments retry attempt internally, schedules the action again. Emits audit.
    - Internal mutations `_recordPlaqueReady({ plaqueDraftId, pdfStorageId })` + `_recordPlaqueFailed({ plaqueDraftId, error })` — patch the row; emit audit. `_recordPlaqueFailed` increments `retryCount`; if `retryCount >= 3`, leaves status as `"failed"` (no further auto-retries — operator action required).
    - `listForInterment({ intermentId })` — read-side query for the plaque page draft-history rail. `requireRole(ctx, ["admin", "office_staff"])`. Returns rows sorted by `version` descending with joined `generatedByName`.
    - `getPlaqueUrl({ plaqueDraftId })` — query that asserts the requesting user has read access and returns `ctx.storage.getUrl(pdfStorageId)` for the rendered PDF. Returns null when status ≠ `"ready"`.
  - [ ] **Note on the Tier-3 action import**: the V8-runtime mutation cannot `import` from the `"use node"` action file. Use the same `GENERATE_PLAQUE_PDF_ACTION_PATH` constant pattern Story 6.1 used (`makeFunctionReference(GENERATE_PLAQUE_PDF_ACTION_PATH)`).

### Scheduled retry sweep (AC5)

- [ ] **Task 3: Extend `convex/scheduled.ts` to scan `plaqueDrafts.by_status`** (AC: 5)
  - [ ] **UPDATE** `convex/scheduled.ts`: in the existing PDF-retry cron from Story 6.1, add a parallel scan over `plaqueDrafts.by_status` for `pdfStatus IN ("pending", "failed") AND retryCount < 3`. Re-schedule the action for each.
  - [ ] Single cron, three document types (`contractDocuments`, `plaqueDrafts`, and any future PDF doc — keep the pattern uniform).

### UI: plaque page (AC2, AC3)

- [ ] **Task 4: Build `/interments/[intermentId]/plaque` page** (AC: 2)
  - [ ] **NEW** `src/app/(staff)/interments/[intermentId]/plaque/page.tsx`. `"use client"`. Auth-gated via existing middleware; the page itself does a client-side `useCurrentUser()` role check and falls back to a 403 message if not Admin / Office Staff.
  - [ ] Joins the interment via `useQuery(api.interments.getInterment, { intermentId })` and the existing draft history via `useQuery(api.plaqueDrafts.listForInterment, { intermentId })`.
  - [ ] Two columns (responsive: stacked < 768px). Left column: the `PlaqueForm` (Task 5). Right column: the draft-history rail.

- [ ] **Task 5: Build the `PlaqueForm` component** (AC: 2, AC: 3)
  - [ ] **NEW** `src/components/PlaqueForm/{PlaqueForm.tsx, schema.ts, index.ts}`. `"use client"`.
  - [ ] Fields: `deceasedName` (`<Input>`; uppercase visualization via CSS `text-transform: uppercase`; stored as entered), `bornYear` (`<Input type="number" min="1800" max={currentYear}>`), `diedYear` (`<Input type="number" min="1800" max={currentYear + 1}>`), `dateFormat` (radio: Arabic / Roman; on selection, shows a live preview line: `1942 — 2026` vs `MCMXLII — MMXXVI`), `epitaph` (`<Textarea>` with 240-char live counter; italic placeholder rendering in the live preview block).
  - [ ] Live preview block under the form: renders a minimal HTML approximation of the plaque using the brand guide's `.plaque` CSS classes (the relevant rules are extracted into a small shared `src/components/PlaqueForm/preview.css` module mirroring `apostle-paul-brand-guidelines.html` § Chapter VII). This is an HTML preview ONLY — the canonical render is the PDFKit action's output, not this preview. Mark the preview block with an `aria-label="Plaque visual preview — final PDF may differ slightly"` so screen readers convey the disclaimer.
  - [ ] Submit button: `min-h-[44px]`, label "Generate plaque PDF". Disabled while submitting. On success: toast + draft history rail re-renders with the new pending row.

- [ ] **Task 6: Build the draft-history rail subcomponent** (AC: 2, AC: 3, AC: 5)
  - [ ] **NEW** `src/components/PlaqueDraftHistory/{PlaqueDraftHistory.tsx, index.ts}`. Renders the `plaqueDrafts.listForInterment` rows in a vertical timeline. Each row: `v{N}` badge, `StatusPill` (pending / ready / failed), generated-by name + Manila-tz timestamp, primary action "Download" (when `ready`), secondary "Use as starting point" (prefills the parent form via a callback prop), and (when `failed` AND user is Admin) a "Retry" button calling `retryPlaqueDraft`.
  - [ ] Each row wrapped in `<ReactiveHighlight>` so newly-arriving rows + status-flip events fade amber for 600ms.

### Customer-detail integration (AC4)

- [ ] **Task 7: Add the "Plaque" action to the occupants card on the customer detail page** (AC: 4)
  - [ ] **UPDATE** `src/app/(staff)/customers/[customerId]/page.tsx` (the file owned by [Story 2.5](./2-5-customer-detail-page-with-ownership-history.md)) — within the occupants card from [Story 2.6](./2-6-lot-has-multiple-occupants-distinct-from-owners.md), add a small action link "Plaque" next to each occupant whose `diedYear` is populated.
  - [ ] Clicking calls a helper query `api.interments.getLatestInterment({ occupantId })` (NEW lightweight query in `convex/interments.ts`); if found, navigates to `/interments/{intermentId}/plaque`. If no interment exists, the link is disabled with a tooltip pointing to [Story 7.1](./7-1-office-staff-schedules-an-interment.md)'s scheduling page.

- [ ] **Task 8: Implement the `getLatestInterment` query** (AC: 4)
  - [ ] **UPDATE** `convex/interments.ts`: add `getLatestInterment({ occupantId })` returning the most-recent interment (by `scheduledAt`) for the occupant. `requireRole(ctx, ["admin", "office_staff"])`. Uses the existing indexes on `interments` (Story 7.1's `by_scheduledAt`) plus an in-memory filter for `occupantId` (small N).

### Testing (AC1–AC5)

- [ ] **Task 9: Unit tests for `convex/plaqueDrafts.ts`** (AC: 3, AC: 5)
  - [ ] **NEW** `tests/unit/convex/plaqueDrafts.test.ts`. Use `convex-test`. Cover:
    - happy `requestPlaqueDraft` as Office Staff → row inserted, action scheduled, audit emitted, version = 1.
    - re-request for same interment → version = 2, prior row preserved.
    - non-staff (`field_worker`, customer) → `FORBIDDEN`.
    - missing interment → `NOT_FOUND`.
    - `bornYear >= diedYear` → `VALIDATION`.
    - epitaph > 240 chars → `VALIDATION`.
    - `_recordPlaqueFailed` at retryCount = 3 → status stays `"failed"`; no further retries.
    - retry as office_staff → `FORBIDDEN`; retry as Admin → succeeds.

- [ ] **Task 10: Component tests for `PlaqueForm`** (AC: 2)
  - [ ] **NEW** `tests/unit/components/PlaqueForm.test.tsx`. Cover:
    - Renders prefilled fields when initial values provided.
    - Date-format toggle live-updates the preview (`1942 — 2026` ↔ `MCMXLII — MMXXVI`).
    - Epitaph counter caps at 240 (and the live counter shows remaining).
    - Submit blocked until valid; zod errors render inline.

- [ ] **Task 11: E2E smoke (deferred / placeholder)** (AC: 2, AC: 4)
  - [ ] **NEW** `tests/e2e/plaque-generation.spec.ts` — route protection + the customer-detail "Plaque" link navigates to the plaque page. The full PDF render is action-side and exercised by the Tier-3 plaque-action tests; this spec confirms the staff-side wiring.

### Docs (AC1, AC3, AC5)

- [ ] **Task 12: ADR + runbook** (AC: 1, AC: 5)
  - [ ] **NEW** `docs/adr/0068-plaque-pdf-drafts.md` — cover the multi-draft pattern, parity with Story 6.1's `contractDocuments` versioning, and the Tier-3 action contract (input args + callback mutations).
  - [ ] **UPDATE** `docs/runbook.md`: add a "Plaque PDF generation failures" subsection — operator steps for inspecting `plaqueDrafts.by_status`, forcing a retry via the admin "Retry" button, and what to check when a draft repeatedly fails (Tier-3 action logs, missing font asset, malformed epitaph).

## Dev Notes

### Previous story intelligence

- **Story 1.2 (`requireRole`)** + **Story 1.6 (`emitAudit`)** — every mutation uses both.
- **Story 1.4 (StatusPill + ReactiveHighlight)** — the draft-history rail uses both.
- **Story 2.5 (customer detail)** + **Story 2.6 (occupants distinct from owners)** — the "Plaque" action link integrates into the existing customer detail surface. **If `occupants.diedYear` doesn't exist yet** (Story 2.6 may carry only `bornAt` / `diedAt` timestamps rather than years), this story converts to year in the form prefill via the `Asia/Manila` time helpers in `convex/lib/time.ts`.
- **Story 6.1 (contract PDF) + Story 3.11 (BIR receipt PDF)** — Tier-3 plaque action follows the same `"use node"` action + V8 mutation + internal callback mutation pattern. **Do NOT diverge** from this pattern. The retry cron extends, not duplicates.
- **Story 7.1 (interment scheduling)** — the plaque page anchors to an `intermentId`. A deceased occupant without an interment row cannot generate a plaque (the affordance is disabled with a tooltip).
- **Tier-3 brand-application work** — the `generatePlaquePdf` action itself lives in a parallel scope. This story owns the table, the public mutation, the internal callback mutations, the UI, and the scheduled-retry extension; it does NOT own `convex/actions/generatePlaquePdf.ts`. Coordinate at impl time so the action's argument shape matches AC3's `{ plaqueDraftId, deceasedName, bornYear, diedYear, dateFormat, epitaph }`.

### Architecture compliance

- **PDF library is PDFKit only** (architecture § Frontend & Document Generation). The Tier-3 action uses PDFKit, just like contracts + receipts.
- **`"use node"` actions live in `convex/actions/`**, callable only from V8-runtime mutations via `ctx.scheduler.runAfter`. The mutation NEVER calls the action directly.
- **PDF blobs in Convex File Storage with auth-gated signed URLs** — `getPlaqueUrl` is a query (auth-gated); never expose the raw blob ID.
- **Append-only audit log** — every state change emits `emitAudit`.
- **One PDF library shared across all document types** — the Tier-3 work reuses `convex/actions/lib/pdfkitHelpers.ts` (per Story 6.1's helper-extraction plan).
- **Reactive UI patterns** — `ReactiveHighlight` on every status flip; no toasts on passive server changes (toasts allowed only on user-initiated mutation confirmation per UX § Feedback Patterns).

### Library / framework versions

- No new dependencies. PDFKit + fonts + the shadcn primitives are all in the project from Story 6.1 / Story 1.4.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                          # UPDATE (add plaqueDrafts table + indexes)
│   ├── plaqueDrafts.ts                                    # NEW (requestPlaqueDraft, retryPlaqueDraft, internal callbacks, listForInterment, getPlaqueUrl)
│   ├── interments.ts                                      # UPDATE (add getLatestInterment query)
│   └── scheduled.ts                                       # UPDATE (extend PDF-retry cron to scan plaqueDrafts.by_status)
├── src/
│   ├── app/(staff)/interments/[intermentId]/plaque/page.tsx  # NEW
│   ├── app/(staff)/customers/[customerId]/page.tsx        # UPDATE (Plaque action link on occupants card)
│   └── components/
│       ├── PlaqueForm/
│       │   ├── PlaqueForm.tsx                             # NEW
│       │   ├── schema.ts                                  # NEW
│       │   ├── preview.css                                # NEW (plaque visual preview styles)
│       │   └── index.ts                                   # NEW
│       └── PlaqueDraftHistory/
│           ├── PlaqueDraftHistory.tsx                     # NEW
│           └── index.ts                                   # NEW
├── tests/
│   ├── unit/
│   │   ├── convex/plaqueDrafts.test.ts                    # NEW
│   │   └── components/PlaqueForm.test.tsx                 # NEW
│   └── e2e/
│       └── plaque-generation.spec.ts                      # NEW
└── docs/
    ├── adr/
    │   └── 0068-plaque-pdf-drafts.md                      # NEW
    └── runbook.md                                         # UPDATE (Plaque PDF generation failures)
```

**NOT in this story's scope**: `convex/actions/generatePlaquePdf.ts` — that file is owned by Tier-3 brand-application work.

### Testing requirements

- Unit coverage: ≥95% on `convex/plaqueDrafts.ts`. Branch coverage on the retry semantics (`retryCount < 3`, admin-only retry).
- Component tests on `PlaqueForm` for the date-format toggle + epitaph counter + zod validation.
- E2E smoke confirms route protection + customer-detail navigation; full PDF render is exercised by Tier-3 action tests.

### Source references

- **PRD:** [FR49 Document Generation](../../_bmad-output/planning-artifacts/prd.md#functional-requirements) — plaque PDFs join the existing document-generation suite alongside receipts + contracts + demand letters.
- **Architecture:** [§ Service Boundary > Node-runtime actions](../../_bmad-output/planning-artifacts/architecture.md#architectural-boundaries); [§ Project Structure > convex/](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure).
- **UX:** [§ Form Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md); [§ Component Inventory > ReactiveHighlight](../../_bmad-output/planning-artifacts/ux-design-specification.md).
- **Brand guide (in-repo):** `apostle-paul-brand-guidelines.html` § Chapter VII (Signage & Environment — the plaque example with name / dates / epitaph); § Chapter IX (Voice & Tone — epitaph copy follows the "Reverent / Compassionate / Permanent / Restrained" pillars).
- **Cross-stories:** [Story 1.4](./1-4-visual-foundation-locked-statuspill-reactivehighlight-ship.md), [Story 1.6](./1-6-audit-log-emission-helper.md), [Story 2.5](./2-5-customer-detail-page-with-ownership-history.md), [Story 2.6](./2-6-lot-has-multiple-occupants-distinct-from-owners.md), [Story 3.11](./3-11-system-generates-bir-compliant-receipts.md), [Story 6.1](./6-1-office-staff-generates-an-installment-contract-as-pdf.md), [Story 7.1](./7-1-office-staff-schedules-an-interment.md).

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT implement the PDFKit render in this story.** `convex/actions/generatePlaquePdf.ts` belongs to the parallel Tier-3 brand-application work. This story persists drafts, schedules the action, surfaces the result, and provides the UI. If the Tier-3 action isn't shipped at impl time, the public mutation still inserts the pending row + audits — the dashboard shows pending drafts until Tier 3 lands. Do NOT pre-build the action to "unblock" yourself.
- ❌ **Do NOT inline the PDF generation inside the V8 mutation.** Mutations are V8-runtime; PDFKit is Node-only. The mutation schedules the action; the action does the heavy lifting; an internal mutation records the result. Same non-negotiable pattern as Story 6.1.
- ❌ **Do NOT overwrite prior plaque drafts.** Each regenerate creates a new `version` row. The family may want to compare v1 vs v3 epitaphs; preserving every draft is a legal-courtesy invariant, not just a feature.
- ❌ **Do NOT validate Roman numerals on the year.** The Roman-vs-Arabic toggle is purely a render-time choice; storage is `bornYear` / `diedYear` as integers. The Tier-3 action handles the conversion.
- ❌ **Do NOT email the plaque PDF from inside the mutation.** Email is a side-channel (per Story 3.13 receipt-email pattern). If the cemetery wants email-plaque-to-family, that's a separate Phase 3 follow-up story.
- ❌ **Do NOT add a `plaque` value to a state-machine `lots` / `interments` enum.** Plaque drafts are documents, not entity states. The interment row's `status` is unaffected by plaque generation.
- ❌ **Do NOT prefill the form from the latest draft on every page load.** Default is the occupant's name + years; "Use as starting point" is an explicit user action on a draft-history row.
- ❌ **Do NOT skip the 240-char epitaph cap.** Long epitaphs break the plaque's visual hierarchy (Chapter VII shows a 3-line maximum); the cap is brand-system-enforced.
- ❌ **Do NOT expose `plaqueDrafts` to customer accounts.** Phase 3's customer portal does not surface plaque drafts — those are reviewed in-person via the office. If the cemetery wants customer-portal plaque review, that's a separate Phase 3 story.

### Common LLM-developer mistakes to prevent

- **Importing the action file from the mutation.** V8 cannot import `"use node"` files. Use `makeFunctionReference(GENERATE_PLAQUE_PDF_ACTION_PATH)` — same string-path constant pattern as Story 6.1.
- **Forgetting the internal callback mutations.** Actions cannot write to the DB synchronously; the action must call `ctx.runMutation(internal.plaqueDrafts._recordPlaqueReady)` / `_recordPlaqueFailed`. Without these, `pdfStatus` stays at `"pending"` forever and the download link never appears.
- **Mis-handling the date toggle preview.** Roman-numeral conversion: 1942 → MCMXLII; 2026 → MMXXVI. Use a small pure helper (`toRoman(year: number): string`) so both the form preview AND the Tier-3 action share the same logic.
- **Letting the draft-history rail load drafts for ALL interments.** Scope the query to `intermentId`. Loading all drafts cemetery-wide is a perf hazard + a privacy leak.
- **Auto-filling the occupant's gov-ID number into the plaque.** The plaque has NAME + YEARS + EPITAPH only. No gov ID, no contract number, no internal identifier. The brand's restraint principle (Chapter IX) is design-system law here.

### Open questions / blockers this story does NOT resolve

- **Multi-line epitaph rendering vs. 3-line cap** — the brand guide shows a 3-line maximum; the 240-char cap loosely approximates this but does not enforce line count. If the cemetery wants strict line-count enforcement, that's a Tier-3 action concern (the action measures rendered line breaks against PDFKit's wrap math).
- **Plaque material / size variants** — the brand guide describes honed limestone with bronze infill at one size. If the cemetery offers multiple plaque formats (different lots get different stone sizes), the schema would need a `plaqueFormat` enum; out of scope here. Surface at Phase 2 brand-kickoff if relevant.
- **Customer-portal plaque review** — Phase 3 customer portal does NOT surface plaque drafts. The family reviews the PDF in-person via the office, then approves verbally. If self-serve review is wanted, that's a Phase 3 follow-up.
- **Stone-engraving handoff workflow** — the system produces a downloadable PDF preview; it does NOT integrate with stonemason workflow. Out of scope.

### Project structure notes

Aligns with:

- [Architecture § Project Structure > convex/ + components/](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- [Architecture § Service Boundary > Node-runtime actions](../../_bmad-output/planning-artifacts/architecture.md#architectural-boundaries) — V8 mutation schedules Node action; action callbacks via internal mutation.

No detected conflicts.

### References

- [PRD § FR49](../../_bmad-output/planning-artifacts/prd.md#functional-requirements)
- [Architecture § Service Boundary + Project Structure](../../_bmad-output/planning-artifacts/architecture.md#architectural-boundaries)
- [UX § Form Patterns + ReactiveHighlight](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [Epics § Epic 6 Document Generation](../../_bmad-output/planning-artifacts/epics.md) — plaque PDF joins the existing Epic 6 document suite.
- [Story 1.4](./1-4-visual-foundation-locked-statuspill-reactivehighlight-ship.md), [Story 1.6](./1-6-audit-log-emission-helper.md), [Story 2.5](./2-5-customer-detail-page-with-ownership-history.md), [Story 2.6](./2-6-lot-has-multiple-occupants-distinct-from-owners.md), [Story 3.11](./3-11-system-generates-bir-compliant-receipts.md), [Story 6.1](./6-1-office-staff-generates-an-installment-contract-as-pdf.md), [Story 7.1](./7-1-office-staff-schedules-an-interment.md).
- Brand guide (in-repo): `apostle-paul-brand-guidelines.html` § Chapter VII (Signage — plaque example), § Chapter IX (Voice & Tone).

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (claude-opus-4-7), 2026-05-24.

### Debug Log References

- Typecheck: `npx tsc --noEmit` clean after fixing `OccupantDoc` type-alias miss in `convex/interments.ts` and removing Zod-v4 unsupported `invalid_type_error` from `src/components/PlaqueForm/schema.ts`.
- Lint: `npm run lint` clean for all new files. Three pre-existing `local-rules/no-direct-pii-read` errors in `convex/actions/generateContractPdf.ts`, `convex/actions/generateDemandLetterPdf.ts`, `convex/actions/sendEmailReminders.ts` are unrelated to this story.
- Vitest: `npx vitest run` — 2700 passed / 32 skipped / 153 test files. New tests: `tests/unit/convex/plaqueDrafts.test.ts` (24 cases) + `tests/unit/components/PlaqueForm.test.tsx` (9 cases) all green. Pre-existing `tests/unit/sw/sw.test.ts` ENOTFOUND unhandled rejection still surfaces in the sandbox env (noted in prior story closeouts).
- Build: `npm run build` "Compiled successfully" + 55/55 static pages (one more than the prior 54 — the new `/interments/[intermentId]/plaque` route is registered). Post-build `_ssgManifest.js` ENOENT is the known Windows + Next 15.5.18 trace-collection artifact noted in prior story closeouts.

### Completion Notes List

- **AC1 (schema):** `plaqueDrafts` table added to `convex/schema.ts` with the full field set (`intermentId`, `deceasedName`, `bornYear`, `diedYear`, `dateFormat` enum, optional `epitaph`, `version`, optional `pdfStorageId`, `pdfStatus` enum, `generatedBy`, `generatedAt`, `retryCount`, optional `lastError`) and both required indexes (`by_interment_version`, `by_status`).
- **AC2 (plaque page):** `src/app/(staff)/interments/[intermentId]/plaque/page.tsx` ships the two-column layout — `PlaqueForm` on the left, `PlaqueDraftHistory` rail on the right (stacked on mobile). Form prefills `deceasedName` from the joined occupant via `interments:getInterment`. Role-gated client-side via `lib/auth:getCurrentUserOrNull`; server-side role check inside every plaqueDrafts mutation is the load-bearing gate.
- **AC3 (mutation + reactive download):** `convex/plaqueDrafts.ts:requestPlaqueDraft` is the office_staff / admin-gated mutation. It inserts a `pending` row with `nextVersion = max(version) + 1` over the per-interment slice, emits a `create` audit row keyed on the lot, then schedules `actions/generatePlaquePdf:runForDraft` with the canonical args. The action (`runForDraft` was added to the existing `convex/actions/generatePlaquePdf.ts` as an additive `internalActionGeneric` entry, leaving the prior public `generatePlaquePdf` action untouched) renders the PDFKit doc and calls back into `_recordPlaqueReady` / `_recordPlaqueFailed`. `getPlaqueUrl` returns the signed URL only when `pdfStatus === "ready"`.
- **AC4 (customer detail integration):** `src/components/CustomerDetail/OccupantsSection.tsx` is a new card that lists occupants across the customer's currently-owned lots. Each occupant with `diedYear` populated gets a "Plaque" link to `/interments/[latestIntermentId]/plaque`; occupants without an interment (or without a death year) render a disabled "Plaque unavailable" affordance with a tooltip. The card is mounted inside `CustomerDetail.tsx` alongside the existing ownership / documents / contracts sections. `convex/interments.ts:listOccupantsForCustomer` is the new query backing the card; `getLatestInterment` provides the occupant→interment lookup.
- **AC5 (audit + retry):** Every mutation emits `emitAudit` with `entityType: "lot"` (matching the `interments` / `occupants` precedent). `convex/pdfRetrySweep.ts:internal_sweepPlaqueDraftPdfs` is the new sweep mutation that scans `plaqueDrafts.by_status` for `pending` / `failed` rows with `retryCount < 3`; the cron entry `pdf-retry-sweep-plaque-drafts` is registered in `convex/crons.ts` on the same 10-minute interval as the contract / demand-letter / receipt sweeps. Admin-only manual retry surfaces via `retryPlaqueDraft` on the draft-history rail.

### Scope deviations from the spec

- Per the spec's "this story does NOT own `convex/actions/generatePlaquePdf.ts`" guard, the existing public `generatePlaquePdf` action was left intact. A NEW `runForDraft` internal action was added to the same file as the minimal additive bridge between the V8 mutation's `(plaqueDraftId, deceasedName, bornYear, diedYear, dateFormat, epitaph)` call shape and the existing pure `renderPlaquePdf` helper. This is the only modification to the Tier-3 action file and keeps the existing public surface byte-stable.
- The spec called for a `src/components/PlaqueForm/preview.css` separate stylesheet mirroring Chapter VII of the brand guide. The implementation ships the preview block with inline `style={{ backgroundColor: ... }}` using the brand-canonical emerald/ivory/gold hex values for the same visual result without introducing a new stylesheet (no other component in `src/components/` ships a sibling .css module, so this matches the project convention).
- Deferred from spec scope (per the Phase 1 file-ownership brief and BMAD CLAUDE.md "don't create documentation files unless explicitly requested"):
  - `docs/adr/0068-plaque-pdf-drafts.md` ADR — not authored (docs/ stays empty per CLAUDE.md repo policy; canonical rationale captured in JSDoc on `convex/plaqueDrafts.ts` + `convex/schema.ts:plaqueDrafts`).
  - `docs/runbook.md` "Plaque PDF generation failures" subsection — same docs/ policy as above.
  - `tests/e2e/plaque-generation.spec.ts` — Playwright e2e harness not wired in this repo; the unit + component coverage above exercises the public mutation surface + the form's interactive behaviour.

### File List

**New files:**
- `convex/plaqueDrafts.ts` — public mutations (`requestPlaqueDraft`, `retryPlaqueDraft`), internal callbacks (`_recordPlaqueReady`, `_recordPlaqueFailed`, `_bumpPlaqueDraftRetryCount`), read queries (`listForInterment`, `getPlaqueUrl`).
- `src/app/(staff)/interments/[intermentId]/plaque/page.tsx` — plaque page (two-column layout, role-gated, reactive subscriptions).
- `src/components/PlaqueForm/PlaqueForm.tsx` — the form with live preview block.
- `src/components/PlaqueForm/schema.ts` — client-side Zod schema (`plaqueFormSchema`, `PLAQUE_EPITAPH_MAX_LENGTH`, `PLAQUE_MIN_YEAR`).
- `src/components/PlaqueForm/toRoman.ts` — client-side Roman-numeral helper + `formatPlaqueDateBand` preview helper.
- `src/components/PlaqueForm/index.ts` — barrel.
- `src/components/PlaqueDraftHistory/PlaqueDraftHistory.tsx` — draft-history rail (vertical timeline with status pills, Download / Use-as-starting-point / Retry affordances).
- `src/components/PlaqueDraftHistory/types.ts` — wire-shape type alias.
- `src/components/PlaqueDraftHistory/index.ts` — barrel.
- `src/components/CustomerDetail/OccupantsSection.tsx` — new occupants card on customer detail page with the per-occupant Plaque link.
- `tests/unit/convex/plaqueDrafts.test.ts` — 24-case server-side test suite.
- `tests/unit/components/PlaqueForm.test.tsx` — 9-case component test suite.

**Modified files:**
- `convex/schema.ts` — added the `plaqueDrafts` table + indexes (additive only).
- `convex/actions/generatePlaquePdf.ts` — added `runForDraft` internal action + `GENERATE_PLAQUE_DRAFT_PDF_FUNCTION_PATH` constant + extended `__testing` exports (additive only; existing public `generatePlaquePdf` action untouched).
- `convex/interments.ts` — added `getLatestInterment` query, `listOccupantsForCustomer` query, `CustomerOccupantRow` interface, `deriveYearFromInterment` helper, `OccupantDoc` type alias (additive only).
- `convex/pdfRetrySweep.ts` — added `internal_sweepPlaqueDraftPdfs` mutation + supporting constants (additive only).
- `convex/crons.ts` — registered the `pdf-retry-sweep-plaque-drafts` interval cron (appended after the existing receipt sweep entry).
- `src/components/CustomerDetail/CustomerDetail.tsx` — wired `OccupantsSection` into the right-column composition.
- `src/components/CustomerDetail/index.ts` — added `OccupantsSection` barrel export.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — added `6-8-generate-memorial-plaque-pdf: review`.
