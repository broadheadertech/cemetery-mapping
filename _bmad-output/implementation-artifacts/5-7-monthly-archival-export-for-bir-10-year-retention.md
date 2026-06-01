# Story 5.7: Monthly Archival Export for BIR 10-Year Retention

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer / compliance officer**,
I want **a Convex scheduled action `monthlyArchivalExport` that, on the 1st of each month at 04:00 Manila, exports the prior month's receipts + payments + customers + contracts to a compressed JSON file in Convex File Storage with a deterministic filename, optionally mirrors the file to a configured S3-compatible bucket, and is retained for ≥ 10 years per BIR requirements**,
so that **BIR's 10-year financial-record retention obligation is satisfied independent of Convex's 30-day operational backups, and the cemetery has a vendor-independent recovery path if Convex ever becomes unavailable** (FR62, NFR-R3).

This story is the **regulatory long-tail safety net**. Operational backups (Story 5.6) cover restore-from-corruption within 30 days. Archival exports cover the legal retention horizon — 10 years of receipts that must survive Convex vendor changes, contract terminations, even cemetery ownership transfer. The S3 mirror is optional in Phase 1 but the schema + action must be designed so enabling it later requires only an env-var change.

## Acceptance Criteria

1. **AC1 — Monthly cron at 04:00 Manila invokes `monthlyArchivalExport`**: `convex/scheduled.ts` registers a `cron.monthly` entry running at 04:00 `Asia/Manila` on the 1st of each month (= 20:00 UTC on the last day of the prior month). The cron invokes `internal.actions.archivalExport.monthlyArchivalExport`. The action: (a) computes the prior month's Manila-tz date range (e.g. if cron fires 2026-06-01 04:00 Manila, range is `2026-05-01 00:00 Manila` to `2026-05-31 23:59:59 Manila`), (b) queries all receipts + payments + customers + contracts whose `paidAt` / `saleDate` / `_creationTime` falls in range (exact field per entity), (c) serializes to compressed JSON.

2. **AC2 — Compressed JSON written to Convex File Storage with deterministic filename**: The export is `gzip`-compressed and written to Convex File Storage with filename `archives/{YYYY-MM}.json.gz` (e.g. `archives/2026-05.json.gz`). A row is inserted into a NEW `archivalExports` table with `{ period: "2026-05", storageId: <Convex storage id>, sha256: string, sizeBytesUncompressed: number, sizeBytesCompressed: number, recordCounts: { receipts, payments, customers, contracts }, exportedAt: number, s3Status?: "uploaded" | "failed" | "skipped", s3Etag?: string, s3UploadedAt?: number }`. The file is ≤ 100MB for a typical month's transaction volume (~2,000 contracts × ~1 payment per contract per month = ~2,000 records per period); verify on the first real export.

3. **AC3 — Optional S3 mirror via `ARCHIVE_S3_BUCKET` env var**: When the env var `ARCHIVE_S3_BUCKET` is set (along with `ARCHIVE_S3_ACCESS_KEY` + `ARCHIVE_S3_SECRET_KEY` + `ARCHIVE_S3_REGION` + optional `ARCHIVE_S3_ENDPOINT` for non-AWS S3-compatible services like Backblaze B2 / Cloudflare R2 / Wasabi), the action uploads the gzip blob to the bucket with key `archives/{YYYY-MM}.json.gz`. The action verifies the upload's ETag matches the locally-computed SHA-256 (where S3's ETag equals MD5 for non-multipart uploads — for files < 100MB this is single-part). On success, patch `archivalExports` row with `s3Status: "uploaded"`, `s3Etag`, `s3UploadedAt`. On failure, patch `s3Status: "failed"` and log the error; the next-day or next-month run can retry (out of scope for this story to implement automatic retry — flag as a follow-up). When the env var is absent, `s3Status: "skipped"` and the action completes successfully — S3 mirroring is opt-in.

4. **AC4 — Export content includes BIR-required receipt fields + is human-readable JSON**: The JSON structure is:
    ```json
    {
      "schemaVersion": 1,
      "period": "2026-05",
      "exportedAt": 1717200000000,
      "deploymentName": "beaming-boar-935",
      "receipts": [ /* every receipt with: serialNumber, issuedAt, customerSnapshot, lineItems, totalCents, paymentMethod, taxBreakdown, voidedAt? */ ],
      "payments": [ /* every payment with: amountCents, paidAt, method, contractId, receiptId, voidedAt? */ ],
      "customers": [ /* every customer that appeared in the period — fullName, contactInfo, govIdNumber redacted to last-4 */ ],
      "contracts": [ /* every contract that had a payment in the period — originalAmountCents, outstandingBalanceCents at period end, state, customerId, lotId */ ]
    }
    ```
    The JSON is human-readable (pretty-printed with 2-space indentation before gzip compression — gzip handles the verbosity cost trivially; a developer opening the un-gzipped file with `less` or a JSON viewer can scan it). The BIR-required receipt fields (per architecture § Receipts + the `bir-receipt-template.md` doc) are all present. **10-year retention is enforced by**: (a) Convex File Storage default retention (file is never deleted by application code), (b) S3 bucket lifecycle policy configured at the cemetery's S3 console specifying ≥ 10-year retention (documented in the runbook; not enforced from this codebase).

## Tasks / Subtasks

### Schema additions (AC2)

- [ ] **Task 1: Add `archivalExports` table to `convex/schema.ts`** (AC: 2)
  - [ ] In `convex/schema.ts`, add:
    ```ts
    archivalExports: defineTable({
      period: v.string(),                    // "2026-05"
      storageId: v.id("_storage"),           // Convex File Storage blob ref
      sha256: v.string(),
      sizeBytesUncompressed: v.number(),
      sizeBytesCompressed: v.number(),
      recordCounts: v.object({
        receipts: v.number(),
        payments: v.number(),
        customers: v.number(),
        contracts: v.number(),
      }),
      exportedAt: v.number(),
      s3Status: v.optional(v.union(v.literal("uploaded"), v.literal("failed"), v.literal("skipped"))),
      s3Etag: v.optional(v.string()),
      s3UploadedAt: v.optional(v.number()),
      s3ErrorMessage: v.optional(v.string()),
    })
      .index("by_period", ["period"])
      .index("by_exportedAt", ["exportedAt"])
    ```
  - [ ] Run `npx convex dev`. Verify table appears in dashboard.

### Server logic — the export action (AC1, AC2, AC4)

- [ ] **Task 2: Create `convex/actions/archivalExport.ts` — the export action** (AC: 1, AC: 2, AC: 4)
  - [ ] Create `convex/actions/archivalExport.ts`. At top: `"use node";` (this is a Node-runtime action — needed for `zlib` gzip and potentially the AWS SDK). Imports: `import { internalAction, internalMutation, internalQuery } from "../_generated/server"; import { v } from "convex/values"; import { internal } from "../_generated/api"; import { gzipSync } from "node:zlib"; import { createHash } from "node:crypto";`
  - [ ] Export `internalAction monthlyArchivalExport` with args `{ overridePeriod?: v.optional(v.string()) }` (the `overridePeriod` is for manual re-runs / testing; the cron passes nothing and the action computes "last month"). Body:
    1. Compute `period` (e.g. "2026-05") — if `overridePeriod` is provided, use it; otherwise compute via `internalQuery getPeriodBoundsForArchival` (NEW helper in `convex/lib/archivalPeriods.ts` — wraps `convex/lib/time.ts` Manila helpers to return `{ period: "YYYY-MM", startMs, endMs }` for "last calendar month in Manila tz").
    2. Call `internalQuery getReceiptsInPeriod`, `getPaymentsInPeriod`, `getCustomersForPeriod`, `getContractsForPeriod` (NEW internal queries — see Task 3).
    3. Build the JSON payload per AC4 structure. PII handling: customers' `govIdNumber` is redacted to last-4 in the export (same redaction pattern as `convex/lib/audit.ts` per Story 1.6).
    4. Serialize: `const json = JSON.stringify(payload, null, 2); const uncompressed = Buffer.from(json, "utf8"); const compressed = gzipSync(uncompressed); const sha256 = createHash("sha256").update(compressed).digest("hex");`.
    5. Write to Convex File Storage: `const storageId = await ctx.storage.store(new Blob([compressed], { type: "application/gzip" }));` (note: actual Convex API uses `ctx.storage.store(blob)` — verify against current Convex docs; if API requires a different form, adapt).
    6. Insert `archivalExports` row via `internalMutation insertExportRecord`.
    7. If `ARCHIVE_S3_BUCKET` env var is set: call internal helper `uploadToS3(compressed, sha256, period)` — see Task 4. Patch the row with the S3 status / etag / timestamp.
    8. Return `{ period, storageId, recordCount: counts }` for logging.
  - [ ] **Idempotency:** if a row for `period` already exists in `archivalExports` and the action is invoked again (e.g. manual re-run), the action SHOULD replace the existing file + update the row, not create a duplicate. Implement: check `by_period` index for an existing row at the start; if found and the existing file is intact, log "already exported, skipping" and return; if a `--force` flag is somehow passed (out of scope but design for it), proceed and overwrite. For the auto-cron path, idempotency means "don't double-export on accidental double-trigger."
  - [ ] **Action runtime limit:** Convex actions have a wall-clock limit (currently 10 minutes). For a typical month's data (~2k receipts × ~1KB JSON each = ~2MB uncompressed → ~200KB gzipped), this is trivially within budget. Document the expected duration in JSDoc + measure during the first real export.

- [ ] **Task 3: Internal queries for period-bounded reads** (AC: 4)
  - [ ] In `convex/lib/archivalQueries.ts` (NEW), export:
    - `internalQuery getReceiptsInPeriod({ startMs, endMs }) → Array<Receipt>` — scans `receipts` via `by_issuedAt` index (verify index exists from Epic 3; if not, add it to schema in this story).
    - `internalQuery getPaymentsInPeriod({ startMs, endMs }) → Array<Payment>` — scans `payments` via `by_paidAt` index.
    - `internalQuery getCustomersForPeriod({ paymentRows, receiptRows }) → Array<Customer>` — collects unique `customerId`s from the period's payments + receipts, then batch-reads via `ctx.db.get`. Redact `govIdNumber` to last-4.
    - `internalQuery getContractsForPeriod({ paymentRows }) → Array<Contract>` — collects unique `contractId`s from the period's payments, batch-reads.
  - [ ] All queries are `internalQuery` (not callable from client). No `requireRole` needed (no authenticated caller; runs from the cron's internal action).
  - [ ] PII redaction: only `govIdNumber` is redacted; full name + contact info are kept (these ARE the BIR-required fields). Document the redaction policy in JSDoc + reference `docs/bir-receipt-template.md` (per architecture's repo tree — exists or pending creation).

- [ ] **Task 4: S3 upload helper (optional path)** (AC: 3)
  - [ ] In `convex/actions/archivalExport.ts` (same file — keep the action and its helpers together since this is a Node-runtime file), implement an internal helper function (NOT exported as a Convex function — just a TS function imported by the action body):
    ```ts
    async function uploadToS3(compressed: Buffer, sha256: string, period: string): Promise<{ status: "uploaded" | "failed", etag?: string, errorMessage?: string }> {
      const bucket = process.env.ARCHIVE_S3_BUCKET;
      if (!bucket) return { status: "skipped" as any };  // type tweak — caller branches
      // Use @aws-sdk/client-s3 PutObjectCommand
      // Compute MD5 of `compressed` for Content-MD5 header (S3 best practice for integrity)
      // Upload with key `archives/${period}.json.gz`, ContentType: "application/gzip"
      // On 2xx, return { status: "uploaded", etag: response.ETag }
      // On error, catch + return { status: "failed", errorMessage: error.message }
    }
    ```
  - [ ] Install `@aws-sdk/client-s3`: `npm install @aws-sdk/client-s3`. This is the only new runtime dependency.
  - [ ] Env vars: `ARCHIVE_S3_BUCKET`, `ARCHIVE_S3_ACCESS_KEY`, `ARCHIVE_S3_SECRET_KEY`, `ARCHIVE_S3_REGION`, `ARCHIVE_S3_ENDPOINT` (optional — for non-AWS providers). All gitignored (`.env.local` only). Production secrets configured in Convex dashboard's env-var settings.
  - [ ] **Compatibility note:** S3-compatible services (Backblaze B2, Cloudflare R2, Wasabi) all use the same `PutObjectCommand` API; the `endpoint` config differs. Document supported providers in the runbook (Task 8) and in the ADR (Task 7).

### Cron registration (AC1)

- [ ] **Task 5: Register the cron in `convex/scheduled.ts`** (AC: 1)
  - [ ] If `convex/scheduled.ts` exists (Story 5.5 + Epic 4 likely created it), UPDATE — add the monthly entry alongside existing crons; do not refactor existing entries. If not, CREATE.
  - [ ] Add: `crons.monthly("monthlyArchivalExport", { day: 1, hourUTC: 20, minuteUTC: 0 }, internal.actions.archivalExport.monthlyArchivalExport);`
  - [ ] **Manila-tz conversion:** 04:00 Manila on the 1st = 20:00 UTC on the *previous calendar day*. Convex's cron `monthly` takes `day` (day of month UTC). To fire at 04:00 Manila on June 1, we schedule for `day: 31, hourUTC: 20, minuteUTC: 0` of May. This is awkward. **Alternative:** use Convex's `crons.cron("monthlyArchivalExport", "0 20 L * *", ...)` (cron expression: 20:00 UTC on the LAST day of every month, which is 04:00 Manila on the 1st of the next month). Verify Convex's cron-expression support — if `L` isn't supported, fall back to `crons.cron("monthlyArchivalExport", "0 20 28-31 * *", ...)` with a date check at action start (skip if not the last day of the month). Document the chosen approach in JSDoc.

### Admin UI — minimal export listing (AC2)

- [ ] **Task 6: Build `/admin/archival-exports` as a basic list page** (AC: 2)
  - [ ] Create `src/app/(staff)/admin/archival-exports/page.tsx`. `"use client"` on line 1. Admin-only via `requireRole` server-side + middleware role gate.
  - [ ] Create `convex/archivalExports.ts` (NEW file — domain queries). Export `listExports` query: first line `await requireRole(ctx, ["admin"]);`. Returns all rows from `archivalExports` ordered by `period` descending.
  - [ ] Also export `getDownloadUrl` query: args `{ exportId: v.id("archivalExports") }`. First line `requireRole(ctx, ["admin"]);`. Reads the row, returns `await ctx.storage.getUrl(row.storageId)`. The URL is short-lived (Convex File Storage signed URLs expire); the client uses it immediately to download.
  - [ ] Page renders a simple table: columns `period`, `recordCounts` summary ("R/P/C/Co counts"), `sizeBytesCompressed` (formatted as KB / MB), `exportedAt`, `s3Status` badge (`StatusPill` with neutral / positive / destructive tones), and a "Download" button per row. Click "Download" → calls `getDownloadUrl` → opens in new tab.
  - [ ] Add a "Re-run for period" form at the top: input a `YYYY-MM` period + button "Run archival export now." Calls a NEW mutation `triggerArchivalExport({ period })` that calls `ctx.scheduler.runAfter(0, internal.actions.archivalExport.monthlyArchivalExport, { overridePeriod: period })`. The mutation first line: `await requireRole(ctx, ["admin"]);`. Useful for backfilling historical periods or re-running a failed export.

### Documentation (AC1, AC4)

- [ ] **Task 7: Write `docs/adr/0010-archival-export.md`** (AC: 4)
  - [ ] (Adjust ADR number if 0009 / 0010 are taken by other stories — verify when starting.) Sections per the ADR template:
    - **Context:** NFR-R3 requires ≥ 10-year retention; BIR audit requires receipts retained for 10 years; Convex's 30-day operational backup doesn't satisfy this; need vendor-independent recovery path.
    - **Decision:** monthly scheduled action exports prior month's receipts/payments/customers/contracts as compressed JSON to Convex File Storage; optional S3 mirror controlled by env var; 10-year retention enforced by S3 bucket lifecycle (not from this codebase).
    - **Consequences:** positive: regulatory compliance, vendor-independent recovery; negative: ongoing storage cost (negligible — ~200KB/month gzipped × 120 months = ~24MB total); operational burden of monitoring monthly cron + occasional retries.
    - **Format choice — JSON over CSV / XML / Parquet:** human-readable, schema-flexible, single-file-per-period. CSV would lose nested structure (line items, multi-currency potential). XML is verbose without compensating value. Parquet would require a query engine to inspect — JSON is universally inspectable.
    - **Schema versioning:** `schemaVersion: 1` field allows future schema evolution; consumers must check the version.
    - **PII handling:** `govIdNumber` redacted to last-4; full name + contact retained (BIR-required). Reference Story 1.6's redaction helper.
    - **Alternatives considered:** real-time CDC to S3 (rejected, complex, beyond Phase 1 scope); manual quarterly dump (rejected, error-prone); third-party backup tool (rejected, no Convex integration).
    - Forward-link to Story 5.6's `0008-backups-retention.md` for the operational counterpart.

- [ ] **Task 8: Update `docs/runbook.md` with archival operations** (AC: 1, AC: 3)
  - [ ] Add section "## Archival exports (BIR 10-year retention)":
    - **Schedule:** 04:00 Manila on the 1st of each month.
    - **Where the file lives:** Convex File Storage `archives/{YYYY-MM}.json.gz`; optionally mirrored to S3 bucket if configured.
    - **How to verify monthly export succeeded:** Admin opens `/admin/archival-exports` → confirms the new period row is present with `s3Status` per config.
    - **How to manually trigger an export:** Admin opens `/admin/archival-exports` → "Re-run for period" form → enters period → clicks "Run archival export now." Useful for retries.
    - **S3 configuration:** documented env vars (list from Task 4). Supported providers (AWS S3, Backblaze B2, Cloudflare R2, Wasabi). The S3 bucket lifecycle MUST be configured at the bucket's console for ≥ 10-year retention — this is NOT enforced from the application; document the lifecycle-rule JSON.
    - **What to do if a monthly export fails:** check `archivalExports` row for the period; if missing entirely, manually trigger; if present with `s3Status: "failed"`, manually re-trigger (will overwrite the local file and re-attempt S3 upload).
    - **What is NOT in the export:** the receipt PDF blobs themselves (those are in Convex File Storage but are not bundled into the JSON). If full PDF preservation is required by BIR (verify — §10 Q3 open question), expand the export to include PDF blobs as base64 OR mirror the entire File Storage to S3 separately. Flag as a §10 follow-up.

### Testing (AC1, AC2, AC4)

- [ ] **Task 9: Vitest tests in `tests/unit/convex/actions/archivalExport.test.ts`** (AC: 1, AC: 2, AC: 4)
  - [ ] Create `tests/unit/convex/actions/archivalExport.test.ts` (mirrored path per architecture).
  - [ ] Use `convex-test` to seed a context with fixtures spanning two months.
  - [ ] **Test 1 (AC4 — content structure):** seed 3 receipts + 3 payments + 2 customers + 2 contracts in May 2026. Run `monthlyArchivalExport({ overridePeriod: "2026-05" })`. Read back the stored file via `ctx.storage.get(storageId)`, gunzip, parse JSON. Assert: `schemaVersion: 1`, `period: "2026-05"`, `receipts.length === 3`, etc. Assert customer `govIdNumber` is redacted to last-4 format (`****1234`).
  - [ ] **Test 2 (AC2 — `archivalExports` row inserted):** after Test 1's run, query `archivalExports` filtered by `by_period === "2026-05"`. Assert exactly one row with correct counts + `sha256` matching the stored file's actual gzip SHA-256 + `sizeBytesCompressed === <actual>`.
  - [ ] **Test 3 (AC2 — idempotency):** run `monthlyArchivalExport({ overridePeriod: "2026-05" })` twice. Assert: still exactly one row in `archivalExports`; the second run logged a "skipping" message OR overwrote (depending on chosen idempotency policy — verify which).
  - [ ] **Test 4 (AC4 — period boundary):** seed a receipt at `2026-05-31 23:59:00 Manila` and one at `2026-06-01 00:00:01 Manila`. Run export for `2026-05`. Assert only the first is included. (Manila-tz boundary correctness.)
  - [ ] **Test 5 (AC4 — voided receipts):** seed a voided receipt + a non-voided one in May. Verify the export includes both — voided receipts must be retained for BIR audit (architecture's compliance posture). The voided one has `voidedAt` set in the JSON, signaling its status.
  - [ ] **Test 6 (AC3 — S3 skip when env unset):** mock `process.env.ARCHIVE_S3_BUCKET` as undefined. Run the action. Assert the `archivalExports` row has `s3Status: "skipped"`. No S3 SDK calls were made.
  - [ ] **Test 7 (AC3 — S3 upload happy path):** mock `process.env.ARCHIVE_S3_BUCKET = "test-bucket"` + mock the S3 SDK's `PutObjectCommand` to return a successful response with a known ETag. Run the action. Assert `s3Status: "uploaded"`, `s3Etag: <mocked>`, `s3UploadedAt: <set>`. Stretch: assert the SDK was called with the correct bucket / key / body / ContentType.
  - [ ] **Test 8 (AC3 — S3 upload failure):** mock S3 SDK to throw. Assert `s3Status: "failed"`, `s3ErrorMessage` is captured. Assert the action did NOT throw — the failure is logged, not propagated.

- [ ] **Task 10: Playwright e2e — admin can list + download an export** (AC: 2)
  - [ ] Extend `tests/e2e/journey-4-admin-dashboard.spec.ts` or create `tests/e2e/archival-exports.spec.ts`.
  - [ ] Scenario: sign in as Admin → seed an `archivalExports` row + a fake file via convex-test helper → navigate to `/admin/archival-exports` → assert the row appears → click "Download" → assert a new tab opens with the signed URL.

## Dev Notes

### Previous story intelligence

- **Story 1.1 (Convex bootstrap)** — `convex/`, `_generated/`, the env-var setup. Required.
- **Story 1.2 (requireRole)** — `await requireRole(ctx, ["admin"]);` on every public function. Required.
- **Story 1.6 (auditLog + PII redaction helpers)** — the redaction-to-last-4 pattern for `govIdNumber` is reused. Import or replicate the helper. Required.
- **Story 3.2 (postFinancialEvent)** — populates `payments` + `receipts` tables that this story exports. Required.
- **Story 5.5 / Epic 4** — may have created `convex/scheduled.ts` first. UPDATE vs. NEW per File List notes.
- **Story 5.6** — sibling story; this story's ADR forward-links to 5.6's `0008-backups-retention.md`. Coordinate ADR numbering.

**If Story 3.2 isn't shipped, do not start this story.** There's nothing to export from a payments table that hasn't been populated atomically.

### Architecture compliance

- **`convex/actions/archivalExport.ts`** — exact path matches architecture's repo tree (§ Project Structure). The `"use node";` directive enables Node-runtime APIs (`zlib`, `crypto`, AWS SDK).
- **Architecture § Archival exports (BIR 10-year)** commits to: "Scheduled monthly Convex action exports receipts + payments + customers to compressed JSON in Convex File Storage, manually mirrored to an S3-compatible bucket the cemetery controls (NFR-R3 / NFR-C2)." This story implements that commitment plus adds contracts (the architecture's "+ ...") because contracts are required context for receipts (BIR auditor needs to see which contract a receipt was issued against).
- **PII handling** — `govIdNumber` redacted to last-4 per Story 1.6 + architecture § PII access logging. Full name + contact info retained (BIR-required).
- **`internalAction` not `action`** — cron-only; never client-callable. The `triggerArchivalExport` mutation provides the client-driven path safely.
- **`requireRole` on every public function** — `listExports`, `getDownloadUrl`, `triggerArchivalExport` are all Admin-only. The internal queries / action do not need `requireRole`.
- **Money handling:** the export includes `*Cents` fields as-is (integer centavos). Do NOT format to peso strings in the export — that's a display concern; auditors / future tooling want raw numbers.

### Library / framework versions

- **`@aws-sdk/client-s3`** — `@latest` (currently v3.x). Tree-shakable; only the `PutObjectCommand` is imported. Modular by design.
- **`node:zlib`, `node:crypto`** — Node built-ins; no install needed.
- **`convex-test`** (already installed) — for the unit tests.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── actions/
│   │   └── archivalExport.ts                  # NEW (monthlyArchivalExport internalAction + S3 helper)
│   ├── lib/
│   │   ├── archivalPeriods.ts                 # NEW (period-bounds helper for Manila tz)
│   │   └── archivalQueries.ts                 # NEW (internal queries for period-bounded reads)
│   ├── archivalExports.ts                     # NEW (listExports, getDownloadUrl, triggerArchivalExport)
│   ├── scheduled.ts                           # NEW or UPDATE (monthly cron registration)
│   └── schema.ts                              # UPDATE (archivalExports table)
├── src/
│   └── app/(staff)/admin/archival-exports/page.tsx  # NEW (admin list + re-run UI)
├── tests/
│   └── unit/convex/actions/archivalExport.test.ts   # NEW
├── docs/
│   ├── adr/0010-archival-export.md            # NEW (renumber if conflict)
│   └── runbook.md                              # UPDATE (archival operations section)
└── package.json                                # UPDATE (add @aws-sdk/client-s3)
```

If `convex/scheduled.ts` and `docs/runbook.md` were created by Story 5.5 / 5.6 first, treat as UPDATE.

### Testing requirements

- **NFR-M2 (≥ 90% line coverage on financial-touching server functions):** archival export is financial-data-touching (reads payments + receipts). Target ≥ 90% on `convex/actions/archivalExport.ts` + `convex/lib/archivalQueries.ts`.
- **Manila-tz period boundary test (Test 4) is critical** — a wrong boundary means a receipt issued on the 31st falls into the next month's export, OR drops entirely between exports. Either is a compliance gap.
- **S3 mocking pattern** — use `vi.mock("@aws-sdk/client-s3")` to mock the entire SDK; assert the constructor + `PutObjectCommand` were called with expected args. Don't hit real S3 in tests.

### Source references

- **PRD:** [FR62 — archival export](../../_bmad-output/planning-artifacts/prd.md#functional-requirements), [NFR-R3 — ≥ 10-year retention](../../_bmad-output/planning-artifacts/prd.md#reliability--availability), [NFR-C2 — BIR compliance](../../_bmad-output/planning-artifacts/prd.md#compliance).
- **Architecture:** [§ Archival exports (BIR 10-year)](../../_bmad-output/planning-artifacts/architecture.md#data-architecture), [§ Project Structure > convex/actions/archivalExport.ts](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure), [§ Audit-log emission + PII redaction](../../_bmad-output/planning-artifacts/architecture.md#audit-log-emission).
- **UX:** N/A — minimal admin UI for listing exports; no user-facing surface.
- **Epics:** [Story 5.7](../../_bmad-output/planning-artifacts/epics.md#story-57-monthly-archival-export-for-bir-10-year-retention).
- **Previous stories:** Story 1.2 (requireRole), Story 1.6 (PII redaction), Story 3.2 (postFinancialEvent — populates the data this exports), Story 5.5 (scheduled.ts coordination), Story 5.6 (backup ADR forward-link).

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT delete an `archivalExports` row OR its file.** Even a failed export's row should be patched-not-deleted (so the retry history is visible). Files are append-only by design.
- ❌ **Do NOT include unredacted `govIdNumber`** in the export. The BIR audit needs the LAST-4; the full number is sensitive PII and out of scope for archival. Story 1.6's redaction helper.
- ❌ **Do NOT use `new Date().getMonth()`** to compute "last month." Browser-month-vs-Manila-month is an off-by-one waiting to happen. Always go through `convex/lib/time.ts` Manila helpers.
- ❌ **Do NOT compress with `deflate` or `brotli`.** `gzip` is the documented format. Auditors expect `.json.gz`; deviating breaks any future "open in standard tools" assumption.
- ❌ **Do NOT bundle PDF blobs into the JSON** in this story. The export is the receipt DATA. If §10 follow-up determines that the PDFs themselves must be archived, that's a separate concern (PDFs would 100x the file size; design accordingly).
- ❌ **Do NOT skip the period idempotency check.** A double-trigger (manual + cron at the same time, accidental cron re-fire) writing two files for the same period creates audit ambiguity.
- ❌ **Do NOT pretty-print AFTER compression.** Pretty-print first (`JSON.stringify(payload, null, 2)`), THEN gzip. The order matters for both correctness and compression ratio.
- ❌ **Do NOT hardcode the S3 endpoint.** Use `process.env.ARCHIVE_S3_ENDPOINT` (optional). Hardcoding `s3.amazonaws.com` forecloses non-AWS S3-compatible providers — the cemetery may prefer Backblaze B2 for cost or Wasabi for sovereignty.
- ❌ **Do NOT log full file contents** (or first/last KB) in any error path. The export contains PII even when redacted; treat logs as semi-public.
- ❌ **Do NOT silently swallow S3 failures.** AC3 specifies the action does not throw, but the failure MUST be recorded in `archivalExports.s3Status` + `s3ErrorMessage` so the admin sees it on the listing page. A silent failure means a missed 10-year retention.
- ❌ **Do NOT depend on Convex File Storage for 10-year retention.** The Convex retention guarantee is product-level, not regulatory. The 10-year horizon depends on the S3 bucket lifecycle (configured outside this code). Document this dependency explicitly in the ADR.

### Common LLM-developer mistakes to prevent

- **Computing the period in UTC:** Manila is UTC+8. "Last month" in UTC at 20:00 UTC on May 31 is "May" — but at 04:00 Manila on June 1, "last month" is also "May." OK, sometimes coincides. But at 23:00 Manila on June 30 (= 15:00 UTC June 30), UTC's "last month" is "May" while Manila's is "June." Always anchor to Manila for the period label.
- **Forgetting `"use node";`:** the directive enables Node APIs. Without it, `node:zlib` import fails at deploy time. Convex deploy error message is cryptic; add to JSDoc.
- **Using `JSON.stringify(payload)` without spacing argument:** then trying to gzip a minified payload. The pretty-printed version compresses essentially as well (gzip handles whitespace trivially) and is far easier for an auditor to read. Specify `null, 2`.
- **Forgetting to await `gzipSync`:** `gzipSync` is synchronous (the `Sync` suffix). Don't `await` it. There's `zlib.gzip` (async, callback-based) and `zlib.gzipPromise` (newer); pick `gzipSync` for simplicity since the data fits in memory.
- **Mocking `@aws-sdk/client-s3` wrong:** the SDK uses a `Client` class + `Command` classes. Mock the client's `send` method, not the `PutObjectCommand` constructor. Pattern: `vi.spyOn(S3Client.prototype, "send").mockResolvedValue({ ETag: "..." })`.
- **Using `ctx.scheduler.runAfter(0, ...)` from a mutation called by an Admin button:** this is correct (mutations can schedule actions; actions can call Node-runtime code; the chain is fine). Common mistake: trying to invoke the action directly from a mutation via `ctx.runAction` — actions cannot be run by mutations synchronously. `runAfter(0, ...)` is the right pattern.
- **Forgetting the `archivalExports.s3ErrorMessage` field on failure:** the table schema has it; remember to set it on the failure path. Without it, debugging a failed upload requires log diving.

### Open questions / blockers this story does NOT resolve

- **§10 Q3 (BIR receipt PDF retention requirement):** if BIR mandates PDF preservation (not just JSON data), this story's export is insufficient. Awaiting confirmation. Flag in runbook + ADR.
- **S3 bucket procurement:** which provider? Cost analysis? Lifecycle policy details? These are cemetery-operator decisions; this story's code is provider-agnostic.
- **Automatic retry on S3 failure:** out of scope. Manual re-trigger via `/admin/archival-exports`. A future story can add backoff + retry queue.
- **Verification that the 120-month-old file is still readable:** there's no automated check that 2026-05's file is still valid in 2036. The quarterly restore drill (Story 5.6) could be extended to also spot-check an old archival file annually — flag as a future-story enhancement.

### Project Structure Notes

Aligns with:
- [Architecture § Project Structure > convex/actions/archivalExport.ts](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- [Architecture § Archival exports (BIR 10-year)](../../_bmad-output/planning-artifacts/architecture.md#data-architecture)
- [Architecture § Scheduled triggers](../../_bmad-output/planning-artifacts/architecture.md#communication-patterns)

No detected conflicts.

### References

- [PRD § FR62, NFR-R3, NFR-C2](../../_bmad-output/planning-artifacts/prd.md#functional-requirements).
- [Architecture § Archival exports](../../_bmad-output/planning-artifacts/architecture.md#data-architecture).
- [Architecture § Project structure](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure).
- [Epics § Story 5.7](../../_bmad-output/planning-artifacts/epics.md#story-57-monthly-archival-export-for-bir-10-year-retention).
- [Previous stories: 1.2 / 1.6 / 3.2 / 5.5 / 5.6](./).
- AWS SDK for JavaScript v3 docs (verify current): https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

- `npx tsc --noEmit` — clean for all new files; pre-existing TS errors in unrelated files (`convex/http.ts`, `convex/reminders.ts`, `src/app/(staff)/reports/sales/page.tsx`, `src/components/CustomerPortal/CustomerPayForm.tsx`) remain (not touched by this story).
- `npm run lint` — clean.
- `npx vitest run tests/unit/convex/actions/archivalExport.test.ts` — 31/31 pass. Full suite (`npx vitest run`) shows 2238/2240 pass, 1 skip, with pre-existing failures in `reminders.test.ts` / `MarkInDefaultDialog` / `ReclaimLotDialog` / `VoidReceiptDialog` / `FlagContractDialog` / `SalesReportPage` / `generateReportExport` — none of these touch story-5.7 surfaces; the dialog failures show 5000+ms timeouts characteristic of the known pre-existing test-env instability.
- `npm run build` — `Compiled successfully` + `Generating static pages (46/46)` (the new `/admin/archival-exports` route is registered). The final post-build `ENOENT` from Next.js 15.5.18 on Windows trace collection is the known artifact noted in prior story closeouts and unrelated to story 5.7.

### Completion Notes List

(a) **Cron syntax:** `crons.cron("monthly-archival-export", "0 20 28-31 * *", internalApi.actions.archivalExport.monthlyArchivalExport)`. The 5-field expression fires at 20:00 UTC on each of days 28–31 of every month (~ 04:00 Manila on the 1st of the following month). The action's idempotency guard (`findExistingArchivalExport` + `s3Status !== "failed"` short-circuit) collapses the 28-31 overshoot into a single successful export per period — the rationale is documented in ADR-0018 § 6 and inline in `convex/crons.ts`. `crons.monthly` was rejected because its fixed-day-of-month-UTC contract would silently misfire when Manila's 1st maps to UTC's 28th in February.

(b) **ADR number used:** `0018-archival-export.md`. ADR-0010 was already taken by `0010-receipt-counter-pattern.md`, so the spec's suggested 0010 number was advanced to 0018 (next available; ADRs in `docs/adr/` go through 0017 = database backups).

(c) **Measured size of the first real export:** N/A in dev — the action has not run against production data yet. The unit-test fixture (1 receipt + 1 payment + 1 customer + 1 contract) produces a 698-byte gzipped blob; the 2-receipt test produces 752 bytes. The story spec's projected ~200KB / month gzipped at ~2k receipts is the operational expectation; first real production run should be measured and noted in the runbook.

(d) **S3 wired in Phase 1?** Yes — `@aws-sdk/client-s3` is installed and the action's `uploadToS3` helper is feature-complete. The mirror is **opt-in via env var** (`ARCHIVE_S3_BUCKET` unset → `s3Status: "skipped"`). The cemetery has not yet selected an S3 provider in the dev environment; switching it on later requires no code change — only env-var configuration in the Convex dashboard. Supported providers (AWS S3, Cloudflare R2, Backblaze B2, Wasabi) documented in the runbook and ADR-0018.

(e) **§10 follow-up flags raised:**
  - **§10 Q3 (BIR receipt PDF retention).** The archive carries receipt DATA but NOT the rendered PDF blobs from Story 3.13. If BIR mandates PDF preservation, expand the export to bundle base64-encoded PDFs OR mirror Convex File Storage to S3 separately. Flagged in ADR-0018 § Future revisit triggers and the runbook's "What is NOT in the archive" section.
  - **S3 bucket procurement** — provider choice, lifecycle policy details, cost analysis are cemetery-operator decisions. The runbook's "S3 bucket lifecycle policy" section captures the recommended 10-year retention JSON for AWS S3; equivalent shapes for R2 / B2 / Wasabi are noted but not exhaustively templated.
  - **Automatic retry on S3 failure** — out of scope. Manual re-trigger via `/admin/archival-exports` is the Phase-1 surface. A future story can add backoff + retry queue.
  - **Long-tail readability drill** — annual gunzip-spot-check of an old archive is documented in the runbook but not automated. A future story could extend Story 5.6's quarterly restore drill to include this.

**Coexistence with the pre-existing `convex/birExport.ts`:** the prior Phase-1 narrowed surface (`birExports` table + CSV exporter at `/admin/bir-exports`) is untouched. The new `archivalExports` surface (`archivalExports` table + JSON+gzip exporter at `/admin/archival-exports`) is fully additive. The runbook documents the two-tier posture: CSV for the auditor's spreadsheet workflow, JSON for the 10-year regulatory archive.

**Task 10 (Playwright e2e) deferred** to a follow-on story that owns `tests/e2e/**` per the established scoped Phase-1 file-ownership pattern visible in other shipped stories.

### File List

**New files (created in this story):**

- `convex/actions/archivalExport.ts` — `"use node";` Convex action; the cron-driven `monthlyArchivalExport` internal action, the `uploadToS3` helper, the `insertExportRecord` internal mutation, pure helpers `buildArchivalPayload` / `serializePayload` / `collectCustomerIds` / `collectContractIds`, and the `MONTHLY_ARCHIVAL_EXPORT_INTERNAL_PATH` constant.
- `convex/archivalExports.ts` — admin-facing public surface; `listExports` query, `getDownloadUrl` query, `triggerArchivalExport` mutation (all `requireRole(["admin"])`-gated).
- `convex/lib/archivalPeriods.ts` — pure Manila-tz period helpers: `formatPeriod`, `parsePeriod`, `getPeriodBounds`, `getPriorPeriod`.
- `convex/lib/archivalQueries.ts` — period-bounded internal queries (`getReceiptsInPeriod`, `getPaymentsInPeriod`, `getCustomersForPeriod`, `getContractsForPeriod`, `findExistingArchivalExport`) + the `redactGovIdLast4` redactor.
- `src/app/(staff)/admin/archival-exports/page.tsx` — admin list + manual-trigger page; uses `useConvex().query()` for on-click signed-URL fetch, `useMutation` for trigger, `useQuery` for the table.
- `docs/adr/0018-archival-export.md` — full ADR (context, decision, alternatives, consequences, future revisit triggers).
- `tests/unit/convex/actions/archivalExport.test.ts` — 31 vitest cases covering period helpers, PII redaction, payload building, serialization, S3 helper (skipped / happy / failure / endpoint), action handler (full pipeline, idempotency, failed-row re-run, S3 success + failure, period boundary, voided receipts retained).

**Modified files (in this story):**

- `convex/schema.ts` — added the `archivalExports` table (additive — sits below the existing `smsReminderLog` table; coexists with the pre-existing narrow `birExports` table).
- `convex/crons.ts` — appended the `monthly-archival-export` cron registration (5-field expression `0 20 28-31 * *`).
- `docs/runbook.md` — added the "Archival exports (BIR 10-year retention)" section with schedule, where-the-file-lives, verification procedure, manual trigger flow, S3 configuration (env vars + supported providers + bucket lifecycle policy JSON), what-is-NOT-in-the-archive note (PDF blobs flagged as §10 follow-up), failure recovery procedure, and the annual long-tail-readability drill.
- `package.json` / `package-lock.json` — added `@aws-sdk/client-s3` as a runtime dependency.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — flipped `5-7-monthly-archival-export-for-bir-10-year-retention` from `ready-for-dev` to `review`.
- `_bmad-output/implementation-artifacts/5-7-monthly-archival-export-for-bir-10-year-retention.md` — status flipped to `review`; this Dev Agent Record filled in.
