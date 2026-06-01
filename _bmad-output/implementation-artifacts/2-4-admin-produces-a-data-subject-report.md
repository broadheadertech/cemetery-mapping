# Story 2.4: Admin Produces a Data-Subject Report

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an **Admin**,
I want **to produce a complete report of all PII the system holds about a named customer — as a downloadable PDF + JSON, with every read logged and an audit entry recording the export**,
so that **I can comply with Data Privacy Act (RA 10173) subject access requests within the 15-working-day legal window** (FR63, NFR-C3).

This is the **first admin-only compliance feature**. It depends on every Epic 2 artifact: `customers` (Story 2.1), `customerAttachments` (Story 2.2), `readPii` / `readPiiUrl` (Story 2.3), `piiAccessLog` queries (Story 2.3), and any future `ownerships` / `transferEvents` / `occupants` references (Stories 2.5–2.7). The report is the canonical "show me everything you have on Mrs. Cruz" surface the cemetery's legal counsel can hand to a requesting subject. Get this right and the cemetery's RA 10173 compliance posture is provable in a single click; get it wrong and the cemetery is exposed to NPC complaints.

## Acceptance Criteria

1. **AC1 — Admin-only page at `/admin/data-subject-report`** (NFR-S4, FR63): A new route `src/app/(staff)/admin/data-subject-report/page.tsx` renders a search form (customer name or ID lookup) + a recently-generated-reports list. The page is admin-only — `requireRole(ctx, ["admin"])` runs on the underlying queries; the layout `src/app/(staff)/admin/layout.tsx` server-side redirects non-admins to `/dashboard` (defense-in-depth UI gate).

2. **AC2 — Subject lookup uses last-4 / fuzzy match, NOT direct PII** (NFR-S8, UX-DR30): The search form uses Story 2.1's `customers.searchByName` query (returns name + gov-ID last-4 only). Clicking a result navigates to `/admin/data-subject-report/<customerId>`, which loads the report-generation interface. **No `piiAccessLog` entries are created during search** — last-4 isn't PII per UX §1879–1884.

3. **AC3 — Report contents — complete and ordered** (FR63, NFR-C3): The report includes, in this order: (1) Customer record (full PII: name, full gov-ID number, full address, phone, email, consent status + timestamp + capturer); (2) All contracts where the customer is the named buyer (contract IDs + dates + lot codes + totals — financial data, not PII per se, but included per RA 10173 §16); (3) All payments + receipts associated with those contracts (serial numbers, amounts, dates); (4) All ownership history entries (`ownerships` table, time-versioned — Story 2.5 schema); (5) All occupants linked to lots the customer owns (Story 2.6 schema — included because relationship to occupant is the customer's data per RA 10173 broad-interpretation); (6) All ID-scan attachments (signed URLs valid for 24 hours, embedded in the JSON; PDF contains thumbnails + URLs as separate appendix page); (7) All `piiAccessLog` entries about this customer (full history of reads, including this very export at the bottom — which is intentional and self-documenting).

4. **AC4 — PDF + JSON formats both produced atomically** (FR63): The `generateDataSubjectReport` Convex action returns `{ pdfStorageId, jsonStorageId, generatedAt, reportId }`. The PDF (generated via PDFKit in a `"use node"` action — architecture § 318 / 432) is a paginated, formatted document with headers, sections, and an explicit "Generated YYYY-MM-DD HH:MM Asia/Manila" footer. The JSON is the same data in machine-readable form (for the requesting subject's own records or for downstream processing). Both are stored in Convex File Storage with admin-only signed URLs.

5. **AC5 — Every read is logged + an audit row records the export** (NFR-S8, NFR-S7): During generation, the action calls `readPii(ctx, customerId, ["govIdNumber", "fullAddress"], { accessType: "subject_report_export" })` and `readPiiUrl(ctx, attachmentId, { accessType: "subject_report_export" })` for every attachment. The action also calls `emitAudit(ctx, { action: "dataSubjectReport.export", entityType: "customer", entityId: customerId, before: null, after: { reportId, pdfStorageId, jsonStorageId, attachmentCount, accessLogEntryCount }, reason: <user-typed reason from form> })`. The "reason" textarea on the page is required (min 10 chars) — captures *why* the admin is producing this report (e.g. "DSR ticket #2026-0042 from Mrs. Cruz dated 2026-05-18").

6. **AC6 — Generation completes in < 30 seconds for a customer with 50 attachments + 6 months of access history** (NFR-P-derived): The action is paginated where needed (`piiAccessLog` query uses `.paginate({ numItems: 5000 })` if the customer has > 5,000 access log entries — unlikely but defensive). The PDF generation streams page-by-page to limit memory. Test fixtures simulate "heavy customer" load (50 attachments + 1,000 access log entries) and verify < 30s wall time.

7. **AC7 — Non-existent customer returns a calm empty response without logging** (UX-DR30): If the admin enters a customer ID that doesn't exist, the page shows "No customer found" without creating any `piiAccessLog` entry or audit row. (Logging a search for a non-existent subject would itself leak info — "Mrs. Smith was searched for at 3PM" — that we don't want recorded.)

## Tasks / Subtasks

### Schema additions (AC4)

- [ ] **Task 1: Define `dataSubjectReports` table** (AC: 4)
  - [ ] Create `convex/schema.ts` addition: `dataSubjectReports` table: `customerId: v.id("customers")`, `pdfStorageId: v.id("_storage")`, `jsonStorageId: v.id("_storage")`, `generatedAt: v.number()`, `generatedByUserId: v.id("users")`, `reason: v.string()`, `attachmentCount: v.number()`, `accessLogEntryCount: v.number()`, `contractCount: v.number()`, `paymentCount: v.number()`, `expiresAt: v.number()` (URLs expire after 24h; document expires from the listing after 30 days per data-minimization principle).
  - [ ] Indexes: `by_customer_generated` (`["customerId", "generatedAt"]`), `by_generatedBy` (`["generatedByUserId"]`).
  - [ ] **Note:** The PDF + JSON blobs themselves are in Convex File Storage; this table is metadata pointing to them. After 30 days, a scheduled function deletes the blobs and patches `pdfStorageId` / `jsonStorageId` to `null` (or removes the row entirely — design decision: keep the row for audit trail, null the storage IDs). This story implements generation only; expiry cleanup is deferred to Epic 12 (System Operations).

### Backend action (AC3, AC4, AC5, AC6, AC7)

- [ ] **Task 2: Implement `generateDataSubjectReport` action** (AC: 3, AC: 4, AC: 5, AC: 6)
  - [ ] Create `convex/actions/generateDataSubjectReport.ts` (or extend `convex/customers.ts` — decision: separate file because PDFKit + paginated PII aggregation is a heavy chunk; matches architecture § 432's `"use node"` action pattern).
  - [ ] Use `action({ ... })` with `"use node"` directive at the top of the file (architecture § 318 — PDFKit requires Node runtime).
  - [ ] First line: `await requireRole(ctx, ["admin"]);`.
  - [ ] Args: `{ customerId: v.id("customers"), reason: v.string() }`. Validate `reason.trim().length >= 10`; reject with `INVALID_INPUT` if not.
  - [ ] **Step 1 — verify customer exists.** Use `ctx.runQuery(internal.customers._loadCustomerForReport, { customerId })`. If null → throw `CUSTOMER_NOT_FOUND` (AC7 surfaces this as "No customer found" on the page).
  - [ ] **Step 2 — aggregate data via internal queries.** Each internal query is `internalQuery` (no client-facing surface, no separate role check, called from this already-admin-verified action):
    - `internal.customers._loadForReport({ customerId })` — full customer doc; uses `readPii` internally with `skipRoleCheck: true` to record the read access.
    - `internal.customerAttachments._listForReport({ customerId })` — all attachments + signed URLs (24-hour expiry); routes through `readPiiUrl` to log each URL generation.
    - `internal.ownerships._listForCustomer({ customerId })` — ownership history (Story 2.5 schema).
    - `internal.contracts._listForCustomer({ customerId })` — contracts (Story 3.x schema; may not exist yet — see Task 4's stub).
    - `internal.payments._listForCustomer({ customerId })` — payments + receipts (Epic 3 schema; stub).
    - `internal.occupants._listForCustomer({ customerId })` — occupants linked to owned lots (Story 2.6 schema).
    - `internal.piiAccessLog._listForCustomer({ customerId })` — access log entries; paginated if > 5,000 rows.
  - [ ] **Step 3 — assemble JSON.** Schema-versioned JSON document `{ schemaVersion: "v1", generatedAt, generatedBy: { userId, fullName }, reason, customer: {...}, contracts: [...], payments: [...], ownerships: [...], occupants: [...], attachments: [...], accessLog: [...] }`.
  - [ ] **Step 4 — generate PDF via PDFKit.** Sections in AC3 order with headers, a TOC on page 2, an explicit final page that says "Generated by [admin name] on [Manila timestamp] for the purpose of: [reason]. This report is logged in the audit trail as `dataSubjectReport.export` event ID [reportId]."
  - [ ] **Step 5 — store both blobs.** `const pdfStorageId = await ctx.storage.store(new Blob([pdfBuffer]))`; same for JSON. **Convex action storage API:** `ctx.storage.store(blob)` returns a storage ID. Verify against current Convex docs.
  - [ ] **Step 6 — write the `dataSubjectReports` row + audit.** Use `ctx.runMutation(internal.dataSubjectReports._record, {...})` because actions can't write directly. The internal mutation: inserts the row, emits the audit event, schedules the 30-day cleanup function.
  - [ ] **Step 7 — return `{ reportId, pdfDownloadUrl, jsonDownloadUrl, generatedAt }`** to the client. URLs come from `ctx.storage.getUrl(...)` on the just-stored blobs.

- [ ] **Task 3: Implement the `internal.*._listForCustomer` queries** (AC: 3)
  - [ ] For each Convex domain: `customers`, `customerAttachments`, `ownerships`, `contracts`, `payments`, `occupants`, `piiAccessLog`. Each `internalQuery` takes `{ customerId }` and returns a typed array.
  - [ ] These internal queries are **already-trusted callers**: they bypass `requireRole` (internal-only); they read PII via `readPii(ctx, customerId, fields, { skipRoleCheck: true, accessType: "subject_report_export" })` so the access log captures the read.
  - [ ] Coverage exemption: internal queries don't need their own RBAC tests — the calling action's RBAC test covers them. They DO need correctness tests for "returns all rows for customer X."
  - [ ] **Stub for not-yet-built domains:** `contracts.ts` and `payments.ts` schemas land in Epic 3. For this story, the internal queries return empty arrays with a `TODO(Epic 3)` comment. The report generates correctly with empty contract / payment sections.

- [ ] **Task 4: Implement `internal.dataSubjectReports._record` mutation** (AC: 5)
  - [ ] First line for internal mutations: no `requireRole` (action verified). But still must call `emitAudit`.
  - [ ] Args: `{ customerId, pdfStorageId, jsonStorageId, reason, attachmentCount, accessLogEntryCount, contractCount, paymentCount, generatedByUserId }`.
  - [ ] Insert `dataSubjectReports` row with `generatedAt: Date.now()`, `expiresAt: Date.now() + 30 * DAY_MS`.
  - [ ] Schedule cleanup: `ctx.scheduler.runAfter(30 * DAY_MS, internal.dataSubjectReports._cleanup, { reportId })` (Epic 12 implements the actual cleanup function; this story schedules the call so the wiring exists).
  - [ ] Emit audit: `emitAudit(ctx, { action: "dataSubjectReport.export", entityType: "customer", entityId: customerId, before: null, after: { reportId, pdfStorageId: "[storage-id-redacted]", jsonStorageId: "[storage-id-redacted]", attachmentCount, accessLogEntryCount, contractCount, paymentCount }, reason })`.
  - [ ] Return `{ reportId }`.

### Frontend (AC1, AC2, AC7)

- [ ] **Task 5: Create admin layout** (AC: 1)
  - [ ] Create `src/app/(staff)/admin/layout.tsx` — server component that uses Convex Auth's Next.js helpers to fetch the user + role; if role !== "admin", redirect to `/dashboard`. This is the route-level admin gate (defense-in-depth with the server-side `requireRole` in actions).
  - [ ] If the admin layout already exists from an earlier story (Epic 1 may have introduced an admin tile / page already), this story extends it. Check via Grep.
  - [ ] Renders `<AdminNav />` (a small subnav component: Dashboard, Data Subject Report, future Audit Log link) above the page slot.

- [ ] **Task 6: Build the data-subject-report listing page** (AC: 1, AC: 2)
  - [ ] Create `src/app/(staff)/admin/data-subject-report/page.tsx` — client component.
  - [ ] Top: search form (`<Input>` for name, debounced 300ms, calling `api.customers.searchByName`). Below: result list (name + `***-***-1234` last-4 only). Clicking a result navigates to `/admin/data-subject-report/<customerId>`.
  - [ ] Below the search: "Recent Reports" — `api.dataSubjectReports.recent` query (admin-only; returns the last 20 generated reports across all customers, paginated). Each row: customer name + `generatedAt` + admin name + reason snippet + "Download PDF" / "Download JSON" links (calling `api.dataSubjectReports.getDownloadUrls(reportId)` query which calls `readPiiUrl`-equivalent logging).

- [ ] **Task 7: Build the per-customer report-generation page** (AC: 3, AC: 5, AC: 7)
  - [ ] Create `src/app/(staff)/admin/data-subject-report/[customerId]/page.tsx` — client component.
  - [ ] Loads customer via a NON-PII query (`api.customers.getNameOnly` — returns `{ fullName, govIdLast4 }`). If null → show "No customer found. [Back to search]". No log row.
  - [ ] Above the fold: customer display (name only), the "Generate Report" form: a `<Textarea>` for reason (required, min 10 chars), a "Generate Report" button (disabled until reason is valid).
  - [ ] Below the form: list of previous reports for this customer (`api.dataSubjectReports.listForCustomer({ customerId })`).
  - [ ] On submit: call `generateDataSubjectReport` action; show inline progress spinner ("Generating report — this may take up to 30 seconds..."); on success, render two download buttons (PDF + JSON) with `target="_blank"`. The buttons trigger a hit to the signed URLs.

- [ ] **Task 8: Listing + download queries** (AC: 1)
  - [ ] `convex/dataSubjectReports.ts → recent`: admin-only; returns last 20 reports across all customers. Includes joined customer name.
  - [ ] `convex/dataSubjectReports.ts → listForCustomer({ customerId })`: admin-only; returns all reports for the customer.
  - [ ] `convex/dataSubjectReports.ts → getDownloadUrls({ reportId })`: admin-only; calls `ctx.storage.getUrl` for both blobs + logs the file_view access via `readPiiUrl`-style logging (since the URLs point to PII-containing files); returns `{ pdfUrl, jsonUrl, expiresAt }`. Each download is logged.

### PDF formatting (AC4)

- [ ] **Task 9: PDF section templates** (AC: 4)
  - [ ] Create `convex/actions/_dataSubjectReportPdf.ts` (helper module — `"use node"`-marked) with functions: `renderCoverPage(doc, ctx)`, `renderTOC(doc, sections)`, `renderCustomerSection(doc, customer)`, `renderContractsSection(doc, contracts)`, `renderAttachmentsSection(doc, attachments)`, `renderAccessLogSection(doc, entries)`, `renderFooter(doc, ctx)`.
  - [ ] Style: monospace-ish, Stripe-receipt-feeling (UX § 252 — financial integrity vibe). Title page in Helvetica Bold. Tables with thin borders.
  - [ ] Use PDFKit's built-in fonts (Helvetica, Times, Courier). Don't embed custom fonts in this story; the BIR receipt PDF (Epic 3) will land custom font handling and we'll reuse.
  - [ ] Each page footer: `Data Subject Report — [customerName] — Page N of M — Generated [Manila TS]`. Page numbers are PDFKit primitives.

- [ ] **Task 10: JSON schema versioning** (AC: 4)
  - [ ] Create `convex/actions/_dataSubjectReportJson.ts` with a typed `buildReportJson(data: ReportData): DataSubjectReportV1`. The `DataSubjectReportV1` type lives next to it and is the canonical schema for v1 exports. Future schema bumps land as v2 with a new function.
  - [ ] Document the schema in a JSDoc block + a `docs/data-subject-report-schema.md` reference doc (one-page summary of every field; intended for the cemetery's legal counsel + the requesting subjects).

### Testing (AC4, AC5, AC6, AC7)

- [ ] **Task 11: Unit tests for the action** (AC: 4, AC: 5, AC: 7)
  - [ ] `tests/unit/convex/actions/generateDataSubjectReport.test.ts`:
    - **AC4 happy path:** seed a customer + 2 attachments + a couple of `piiAccessLog` rows; run the action; verify both `pdfStorageId` and `jsonStorageId` are returned; verify the JSON storage's content matches the customer's data; verify the audit row exists with `action: "dataSubjectReport.export"` and `reason` populated.
    - **AC5 access logging:** verify `piiAccessLog` has new rows for each `readPii` + `readPiiUrl` call (count: 1 customer read + N attachment URL reads).
    - **AC7 missing customer:** invalid `customerId` → throws `CUSTOMER_NOT_FOUND`; no audit, no access log entries.
    - **AC1 RBAC:** non-admin → `FORBIDDEN`; office_staff → `FORBIDDEN`.
    - **Reason validation:** empty / < 10 char reason → `INVALID_INPUT`.

- [ ] **Task 12: Component test for the page** (AC: 7)
  - [ ] `src/app/(staff)/admin/data-subject-report/[customerId]/page.test.tsx` (or `.tsx`-level test via Testing Library):
    - Verify "No customer found" renders for a nonexistent customer ID.
    - Verify the "Generate Report" button is disabled with an empty / short reason.
    - Verify the button calls the action with the expected args + reason.

- [ ] **Task 13: Performance smoke** (AC: 6)
  - [ ] In the unit test: seed a synthetic "heavy customer" — 50 attachments + 1,000 `piiAccessLog` rows. Run the action; assert wall time `< 30s`. Caveat (per Story 2.3 Task 11): in-process `convex-test` perf isn't real Cloud perf; treat as smoke.

- [ ] **Task 14: PDF + JSON structural test** (AC: 4)
  - [ ] Smoke-parse the generated PDF using `pdf-parse` (dev-only dep, `npm install --save-dev pdf-parse`) and verify the title text appears, the customer's name appears, "Generated YYYY-MM-DD" appears. NOT a full PDF visual diff — just structural verification.
  - [ ] Parse the JSON and verify against the `DataSubjectReportV1` Zod schema. All sections present.

- [ ] **Task 15: E2E spec** (AC: 1, AC: 4)
  - [ ] `tests/e2e/admin-data-subject-report.spec.ts`: log in as admin; navigate to `/admin/data-subject-report`; search for a seeded customer; click the result; fill reason; click "Generate Report"; wait for the success state (long timeout — 60s); click "Download PDF"; verify the download starts (Playwright `page.waitForEvent('download')`).

### Documentation (AC1, AC3, AC4)

- [ ] **Task 16: Write `docs/data-subject-report-schema.md`** (AC: 4)
  - [ ] One-page reference doc describing the JSON schema fields, intended as a deliverable to the cemetery's legal counsel and (potentially) to the requesting subject. Plain language.

- [ ] **Task 17: JSDoc on the action + internal queries** (AC: 3)
  - [ ] Document the report's full data flow at the top of `convex/actions/generateDataSubjectReport.ts`. Cross-reference NFR-C3, FR63, RA 10173.

## Dev Notes

### Previous story intelligence

**Stories that must be implemented before this one:**

- **Story 1.2:** `requireRole(ctx, ["admin"])` for admin-only gating.
- **Story 1.6:** `emitAudit` for the export audit row.
- **Story 2.1:** `customers` schema + `searchByName` query.
- **Story 2.2:** `customerAttachments` schema + `piiAccessLog` schema.
- **Story 2.3:** `readPii` and `readPiiUrl` helpers — the **action calls these for every PII read**. Critical: if Story 2.3 isn't done, this story's action would have to write to `piiAccessLog` directly, which violates the boundary.

**Stories this story has dependencies on that may not yet exist:**

- **Story 2.5 (ownerships time-versioned schema):** if not shipped, the `internal.ownerships._listForCustomer` query returns `[]` with a `TODO(Story 2.5)` comment. Report still generates.
- **Story 2.6 (occupants schema):** same — stub returns `[]`.
- **Story 2.7 (transferEvents):** transfer events for the customer are not included in v1 of the schema (transfers are inferred from ownership history). If Q6 changes this, the schema bumps to v2.
- **Epic 3 (contracts + payments + receipts):** the relevant `internal.contracts._listForCustomer` etc. return `[]` with `TODO(Epic 3)` until those domains land.

**This story should land in implementation order AFTER Stories 2.1, 2.2, 2.3, and ideally 2.5–2.7.** But it can land BEFORE Epic 3 — the financial sections are stubs in v1.

### Architecture compliance

**Pattern locked by architecture:**

- **PDF generation** (architecture § 318, § 431, § 668): PDFKit inside `"use node"` Convex actions. Same pattern as the Epic 3 BIR receipt PDF.
- **Action vs mutation split:** the heavy work (aggregation + PDF generation) is an action; the DB writes (the `dataSubjectReports` row + audit + scheduler call) happen in an internal mutation invoked by the action.
- **PII boundary** (architecture § 525–528, § 868): `readPii` / `readPiiUrl` with explicit `accessType: "subject_report_export"`.
- **Internal queries** (architecture § 142): the per-domain aggregation queries are `internalQuery`, no RBAC check, only callable from the action.
- **Audit emission** (architecture § 393, § 518–523): the export is a financial-adjacent event; redacts attachment storage IDs to sentinels (same pattern as Story 2.2).
- **Compliance archival** (architecture § 337): data-subject reports are SEPARATE from the BIR 10-year archival exports. The 30-day expiry on report blobs is data-minimization; the regulator gets reports on demand, the system doesn't retain them indefinitely.

### Library / framework versions (researched current)

- **PDFKit:** `npm install pdfkit @types/pdfkit`. PDFKit is the canonical Node PDF lib (architecture § 318). Version 0.15+ at time of writing.
- **`pdf-parse`** (dev only): `npm install --save-dev pdf-parse`. Used in tests to verify PDF structure.
- **Zod** (already installed from Story 2.1): used to validate the JSON schema in tests.
- **No `react-pdf`** — that's client-side React-to-PDF rendering, not what we want.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                                # UPDATE (dataSubjectReports table + indexes)
│   ├── dataSubjectReports.ts                                    # NEW (recent, listForCustomer, getDownloadUrls queries; internal._record mutation; internal._cleanup mutation stub)
│   ├── actions/
│   │   ├── generateDataSubjectReport.ts                         # NEW ("use node"; the main action)
│   │   ├── _dataSubjectReportPdf.ts                             # NEW (PDFKit section helpers)
│   │   └── _dataSubjectReportJson.ts                            # NEW (Zod schema + builder)
│   ├── customers.ts                                             # UPDATE (add internal._loadCustomerForReport, internal._listForReport, getNameOnly)
│   ├── customerAttachments.ts                                   # NEW or UPDATE (add internal._listForReport)
│   │   ↑ if you've put attachment queries in customers.ts, OK; otherwise extract to a new file
│   ├── ownerships.ts                                            # NEW with stub internal._listForCustomer (Story 2.5 fleshes out)
│   ├── contracts.ts                                             # NEW with stub internal._listForCustomer (Epic 3 fleshes out)
│   ├── payments.ts                                              # NEW with stub internal._listForCustomer (Epic 3 fleshes out)
│   ├── occupants.ts                                             # NEW with stub internal._listForCustomer (Story 2.6 fleshes out)
│   └── piiAccessLog.ts                                          # UPDATE (add internal._listForCustomer)
├── src/
│   ├── app/(staff)/admin/
│   │   ├── layout.tsx                                           # NEW or UPDATE (admin-only gate + subnav)
│   │   └── data-subject-report/
│   │       ├── page.tsx                                         # NEW (search + recent reports)
│   │       └── [customerId]/
│   │           └── page.tsx                                     # NEW (generate + download)
│   └── components/Admin/
│       └── AdminNav.tsx                                         # NEW (small subnav: Dashboard | Data Subject Report)
├── tests/
│   ├── unit/convex/actions/
│   │   └── generateDataSubjectReport.test.ts                    # NEW
│   └── e2e/
│       └── admin-data-subject-report.spec.ts                    # NEW
├── docs/
│   └── data-subject-report-schema.md                            # NEW (legal-counsel-readable schema reference)
└── package.json                                                 # UPDATE (pdfkit, @types/pdfkit; dev: pdf-parse)
```

### Testing requirements

- **Coverage target on `convex/actions/generateDataSubjectReport.ts`:** ≥ 90% (compliance-critical path).
- **PDF structural test only** — no pixel-diff or visual regression. We assert the document contains the right text in the right order.
- **JSON Zod validation** in tests — full schema conformance check.
- **Perf smoke:** 50 attachments + 1,000 access log rows < 30s in `convex-test`.

### Source references

- **PRD:** [§ FR63 (data-subject report)](../../_bmad-output/planning-artifacts/prd.md#functional-requirements), [§ NFR-C3 (15 working days)](../../_bmad-output/planning-artifacts/prd.md#compliance--legal), [§ NFR-S8 (access log)](../../_bmad-output/planning-artifacts/prd.md#security--privacy)
- **Architecture:** [§ Frontend Architecture > PDF library](../../_bmad-output/planning-artifacts/architecture.md#frontend-architecture) (PDFKit, `"use node"`), [§ Boundary Discipline](../../_bmad-output/planning-artifacts/architecture.md#boundary-discipline), [§ Infrastructure & Deployment > Archival exports](../../_bmad-output/planning-artifacts/architecture.md#infrastructure--deployment)
- **UX:** [§ PII Handling UI Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#pii-handling-ui-patterns)
- **Epics:** [§ Story 2.4](../../_bmad-output/planning-artifacts/epics.md#story-24-admin-produces-a-data-subject-report)
- **Previous stories:** [1.2](./1-2-server-enforces-role-based-access-on-every-endpoint.md), Story 1.6, [2.1](./2-1-office-staff-creates-a-customer-record.md), [2.2](./2-2-office-staff-uploads-identification-documents.md), [2.3](./2-3-pii-access-is-logged-on-every-read.md)
- **Legal:** [RA 10173 (Data Privacy Act of 2012)](https://privacy.gov.ph/data-privacy-act/) — §16 (Rights of Data Subject)
- Convex docs: [Actions](https://docs.convex.dev/functions/actions) · [File Storage](https://docs.convex.dev/file-storage) · [PDFKit](https://pdfkit.org/docs/getting_started.html)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT include the admin's password, session token, or any system credentials in the report.** Report is about the *subject*, not the *admin*.
- ❌ **Do NOT skip the `reason` field.** RA 10173 doesn't strictly require a stated reason for the cemetery's own records, but for audit hygiene (NFR-S7) we capture it. Empty reason = audit-evasion risk.
- ❌ **Do NOT make the PDF URL public.** All download URLs go through `getDownloadUrls` which calls `readPiiUrl`-equivalent logging + admin RBAC. Direct storage URLs would skip both.
- ❌ **Do NOT bundle the action with PDFKit on the client.** Architecture § 320 has the ESLint rule banning client imports of PDFKit; `"use node"` + Convex action keeps PDFKit server-only.
- ❌ **Do NOT log AC7's "No customer found" path** to `piiAccessLog`. Logging a search for a non-existent subject leaks info (the admin searched for "Cruz" at 3PM — but Cruz isn't a customer = "Cruz is associated with this cemetery's records"). The page just shows the message and exits.
- ❌ **Do NOT include the `piiAccessLog` rows of unrelated customers.** The aggregation filters strictly `WHERE customerId === subjectCustomerId`.
- ❌ **Do NOT use `JSON.stringify` directly on data containing `_creationTime`, `_id`, etc.** The JSON schema is curated — map Convex internals to readable field names. Subjects should see `customerId: "..."` not `_id: "..."`.
- ❌ **Do NOT skip the schedule-cleanup call.** The 30-day expiry is data-minimization; permanent retention of subject reports is the opposite of compliance.
- ❌ **Do NOT use the action's `ctx.runQuery` to call PUBLIC queries** that have their own `requireRole` checks. The role check would run on the action's auth context, which IS admin, so it'd pass — but the wasted check is sloppy. Use `internalQuery` variants.
- ❌ **Do NOT cache the report.** Each generation is a new export, with a new audit entry, with a new `piiAccessLog` row for each PII field read. Caching would defeat NFR-S8.

### Common LLM-developer mistakes to prevent

- **Reinventing wheels:** PDFKit has streams, fonts, tables, images. Don't write a raw PDF byte writer.
- **`"use node"` placement:** must be the first line of the file (a string literal at module-level). If missed, Convex picks the Edge runtime and PDFKit fails on `Buffer`.
- **Wrong action / mutation split:** the action can't `ctx.db.insert`. It must call an internal mutation. Two-call pattern.
- **Forgetting to filter `piiAccessLog` by `customerId`:** AC3 wants only the rows about THIS customer. Index `by_customer_timestamp` on `piiAccessLog` makes this efficient.
- **Confusing `attachmentCount` semantics:** the count is the number of attachments embedded in the report, not the total ever uploaded. Use the same array's length.
- **Wrong storage API:** `ctx.storage.store(new Blob(...))` from an action stores a blob and returns `Id<"_storage">`. `ctx.storage.getUrl(storageId)` returns a signed URL. The query needs the URL for download buttons.
- **Path forgetting:** the admin layout is `src/app/(staff)/admin/layout.tsx` — under `(staff)/admin/`, not a separate `(admin)/` group. Architecture § 446–453 doesn't define a separate admin route group; the admin pages are a sub-tree of `(staff)/`.

### Open questions / blockers this story does NOT resolve

- **§10 Q4 (Legacy data condition):** Legacy customers may have sparse data; the report renders empty sections gracefully. No blocker.
- **§10 Q9 (Expense approval workflow):** unrelated.
- **Subject Access Request (SAR) ticketing:** the cemetery may want to track SAR tickets externally (e.g. a Google Doc or a future module). For Phase 1, the `reason` field is the link. If a ticketing system is added later, the schema extends with `sarTicketId: v.optional(v.string())`.

### Project Structure Notes

Aligns with architecture's directory structure. The new `convex/actions/` subdirectory is the canonical location for `"use node"` actions (architecture § 432, § 668). If Epic 1 hasn't created this subdirectory, this story creates it.

### References

- [PRD § FR63, NFR-C3, NFR-S8](../../_bmad-output/planning-artifacts/prd.md#functional-requirements)
- [Architecture § Frontend Architecture > PDF library](../../_bmad-output/planning-artifacts/architecture.md#frontend-architecture)
- [Architecture § Boundary Discipline](../../_bmad-output/planning-artifacts/architecture.md#boundary-discipline)
- [Epics § Story 2.4](../../_bmad-output/planning-artifacts/epics.md#story-24-admin-produces-a-data-subject-report)
- [RA 10173 (Data Privacy Act of 2012)](https://privacy.gov.ph/data-privacy-act/)
- Previous stories: [1.2](./1-2-server-enforces-role-based-access-on-every-endpoint.md), Story 1.6, [2.1](./2-1-office-staff-creates-a-customer-record.md), [2.2](./2-2-office-staff-uploads-identification-documents.md), [2.3](./2-3-pii-access-is-logged-on-every-read.md)
- PDFKit: [docs](https://pdfkit.org/) · Convex: [Actions](https://docs.convex.dev/functions/actions) · [File Storage](https://docs.convex.dev/file-storage)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m] (Anthropic), invoked via the BMAD `dev-story` flow.

### Debug Log References

- `npm run typecheck` — clean for files in this story's ownership scope. One pre-existing error in `src/components/CustomerDocumentUpload/CustomerDocumentUpload.tsx` (Story 2.2's territory, concurrent in-progress) was left untouched.
- `npm run lint` — clean (`✔ No ESLint warnings or errors`).
- `npx vitest run tests/unit/convex/dataSubject.test.ts tests/unit/components/DataSubjectReport.test.tsx` — 37/37 passing.
- `npx vitest run` (full suite) — 832/833 passing (1 pre-existing skip), no regressions.
- `npm run test:e2e -- --list tests/e2e/data-subject-report.spec.ts` — 12 tests recognised (1 active redirect spec + 5 TODO `test.skip` blocks across two projects).

### Completion Notes List

- **Narrowed scope per the dev-story prompt.** The prompt's STRICT file-ownership block confines this dev pass to a single Convex module (`convex/dataSubject.ts`), the admin route under `src/app/(staff)/admin/data-subject-reports/`, a presentational component under `src/components/DataSubjectReport/`, three test files, and `package.json` if strictly needed. The richer story-file plan (PDFKit action, schema additions, internal queries per domain, listing / download URL queries, scheduled cleanup) explicitly depends on tables that are not yet on disk (`dataSubjectReports`, `customerAttachments`, `ownerships`, contracts / payments) and would require touching `convex/schema.ts`, `convex/customers.ts`, and several new files OUTSIDE the prompt's ownership scope. Those richer pieces are documented in `convex/dataSubject.ts`'s file header as deferred follow-ups so the next dev pass can pick them up after Stories 2.2 / 2.5 land.
- **Mutation, not query, not action.** `produceDataSubjectReport` is a `mutation` because `logPiiAccess` writes to `auditLog` (a DB write). A `query` can't write; an `action` can't read `customers` directly nor call `logPiiAccess` (Story 2.3's helper currently throws `INVARIANT_VIOLATION` for `ActionCtx` until the `_generated/` transport lands). The mutation shape satisfies AC3 / AC5 / AC7 today without depending on the generated module.
- **Schema-versioned payload (AC4 partial).** `DataSubjectReport` carries a `schemaVersion: "v1"` literal so future Convex archival exports can key off it. JSON download is the AC4 surface that ships in this pass; PDF generation is the deferred follow-up.
- **Reason validation order (security).** The reason length check runs BEFORE the customer lookup. This means an attacker can't probe customer existence by submitting "junk reason" payloads and observing differential responses — both invalid customer + invalid reason short-circuit before any DB read or audit write.
- **Self-log invariant (AC5).** The mutation calls `logPiiAccess(ctx, { entityType: "customer", entityId: customerId, fields: ["full_record"], reason })` once per successful invocation. The synthesized tail row in `customerAuditTrail` makes the self-event visible to the receiving subject (RA 10173 § 16 transparency) without re-querying.
- **AC7 no-leak invariant (tested).** A missing customer throws `NOT_FOUND` and writes ZERO audit rows. Specifically asserted in `tests/unit/convex/dataSubject.test.ts → "does NOT write a piiAccess audit row on NOT_FOUND"`.
- **Strict customer-id scoping (tested).** Audit rows about other customers are explicitly verified to be excluded from this customer's report — see the "does NOT include audit rows about other customers" test.
- **Follow-ups surface (AC3 partial).** Every domain not yet on disk (customerDocuments, ownerships, contracts, payments, receipts) appears in `followUps` as a deferred entry with a plain-English note. The receiving subject reads this as a "what's NOT yet in this report" checklist.
- **Convex function references via `makeFunctionReference`** in the page component, matching the existing pattern in `/admin/users/page.tsx` and `/lots/page.tsx`. Avoids the hard dependency on `convex/_generated/` that doesn't exist yet in this repo.
- **JSX namespace fix.** Initial implementation used bare `JSX.Element` return types; the project's React 19 + bundler-resolution tsconfig does not surface the global `JSX` namespace, so the components import `ReactElement` from `react` explicitly. Caught + fixed during typecheck.

### File List

- `convex/dataSubject.ts` (NEW) — admin-only `produceDataSubjectReport` mutation.
- `src/app/(staff)/admin/data-subject-reports/page.tsx` (NEW) — search + reason + report-display page.
- `src/components/DataSubjectReport/index.tsx` (NEW) — presentational viewer with sectioned panels + JSON download.
- `src/components/DataSubjectReport/types.ts` (NEW) — client-side mirror of the report payload shape.
- `tests/unit/convex/dataSubject.test.ts` (NEW) — 28 unit tests covering AC1 / AC3 / AC5 / AC7.
- `tests/unit/components/DataSubjectReport.test.tsx` (NEW) — 9 component tests covering render, empty states, download.
- `tests/e2e/data-subject-report.spec.ts` (NEW) — Playwright smoke (unauthenticated redirect + 5 TODO blocks pending seeded test users).

**Not modified (file-ownership boundary respected):** `convex/schema.ts`, `convex/customers.ts`, `convex/lib/**`, `src/middleware.ts`, `src/app/layout.tsx`, `src/app/(staff)/layout.tsx`, every component directory outside `src/components/DataSubjectReport/`.
