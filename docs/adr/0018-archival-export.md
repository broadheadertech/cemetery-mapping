# ADR 0018: Monthly Archival Export for BIR 10-Year Retention

- **Status:** Accepted
- **Date:** 2026-05-21
- **Story:** 5.7
- **Deciders:** theundead (project owner) + Amelia (dev)

## Context

The cemetery is a Philippine business subject to **BIR's 10-year financial-
record retention obligation** — receipts, payments, and the contracts that
back them must be reconstructible for at least ten years from issuance.

The operational backup posture (ADR-0017, Story 5.6) is Convex's managed
daily snapshots with ≥ 30-day retention. That covers RPO ≤ 24h and RTO
≤ 4h for application-layer corruption — but it does NOT satisfy the
10-year horizon, and it does NOT defend against a vendor-level failure
mode (Convex contract dispute, account compromise, or vendor outage).

NFR-R3 commits the architecture to a vendor-independent recovery path for
financial records: a periodic export the cemetery itself controls, in an
open format, retained on the cemetery's own storage. FR62 names the
specific surface: a monthly archival export.

Three threats this ADR's archive defends against:

1. **Vendor exit.** If the cemetery ever migrates away from Convex (or
   Convex sunsets its product) the operational backups are unreadable
   outside Convex. The archive must be self-describing and consumable by
   any JSON-literate tool.
2. **Long-tail audit.** A BIR examiner in 2034 needs receipts issued in
   2024. Convex's 30-day operational retention is the wrong granularity;
   the archive is the only artifact that survives ten years.
3. **Cemetery-ownership transfer.** If the cemetery changes hands, the
   new owner needs the historical receipt set in a portable format —
   not a Convex deployment they have to re-authenticate against.

## Decision

### 1. Monthly cron exports the prior month as compressed JSON

A Convex internal action — `monthlyArchivalExport` in
`convex/actions/archivalExport.ts` — runs on a cron expression
`0 20 28-31 * *` (20:00 UTC on each of the last four days of the month —
~ 04:00 Manila on the 1st of the following month; see § Cron syntax for
the rationale). Each run:

1. Computes the prior calendar month in Manila tz via
   `convex/lib/archivalPeriods.ts`.
2. Reads every receipt, payment, customer-referenced-by-them, and
   contract-referenced-by-them in the period via internal queries in
   `convex/lib/archivalQueries.ts`.
3. Builds a pretty-printed JSON payload (2-space indent for human
   readability), then gzips it with Node's `node:zlib`.
4. Computes SHA-256 of the gzipped blob (content-integrity hash).
5. Writes the blob to Convex File Storage with the deterministic
   filename `archives/{YYYY-MM}.json.gz`.
6. Optionally mirrors the blob to an S3-compatible bucket when
   `ARCHIVE_S3_BUCKET` is configured (see § Decision 3).
7. Inserts a row in the new `archivalExports` table indexing the
   blob + carrying the per-export metadata (sha256, sizes, record
   counts, S3 status).

### 2. JSON over CSV / XML / Parquet

JSON was chosen as the archival format because:

- **Human-readable.** A developer in 2034 opening a `.json.gz` file
  with `gunzip | less` can scan the contents without any tooling.
  This is the long-tail-audit superpower.
- **Schema-flexible.** Nested structures (line items, address
  sub-objects, multi-currency potential) survive round-tripping
  cleanly. CSV would flatten them into a fragile parallel-array
  encoding.
- **Universally inspectable.** Every language ships a JSON parser.
  Parquet would require a query engine; XML is verbose without
  compensating value.
- **`schemaVersion: 1` field.** Future schema changes bump the
  version so consumers can switch on the shape. Older versions
  remain readable indefinitely.

CSV is the right surface for the `birExports` table's narrow
receipts-only Excel-friendly export (the Phase-1 cemetery
operations need it for the BIR examiner's spreadsheet workflow);
JSON is the right surface for the full-ledger 10-year archive
that this ADR commits to. The two surfaces coexist.

### 3. Optional S3 mirror controlled by env var

The S3 mirror is **opt-in** — `ARCHIVE_S3_BUCKET` unset is the
default Phase-1 posture (the cemetery has not yet selected an S3
provider). When the env var is configured (together with
`ARCHIVE_S3_REGION` + `ARCHIVE_S3_ACCESS_KEY` + `ARCHIVE_S3_SECRET_KEY`
+ optional `ARCHIVE_S3_ENDPOINT`), every successful archival action
mirrors the gzipped blob to the bucket with key
`archives/{YYYY-MM}.json.gz`. The `s3Status` field on the
`archivalExports` row captures the result:

- `uploaded` — happy path; `s3Etag` carries S3's MD5.
- `failed`   — upload threw; `s3ErrorMessage` carries the captured
  error. The admin manually re-triggers from `/admin/archival-exports`
  once the misconfig is resolved.
- `skipped`  — env var unset; no SDK call was made.

**Supported S3-compatible providers.** The archival action uses
`@aws-sdk/client-s3` with `forcePathStyle: true` when a custom
endpoint is supplied. This works with:

- AWS S3 (default — no `ARCHIVE_S3_ENDPOINT` needed).
- Cloudflare R2 — `ARCHIVE_S3_ENDPOINT` = the R2 account URL.
- Backblaze B2 — `ARCHIVE_S3_ENDPOINT` = the B2 region endpoint.
- Wasabi — `ARCHIVE_S3_ENDPOINT` = the Wasabi region endpoint.

The cemetery chooses the provider based on cost, sovereignty
preference, and operational familiarity. No code change is
required to switch providers — only the env vars.

**10-year retention is NOT enforced from the application.** The S3
bucket's lifecycle policy — configured in the cemetery's S3
provider console — is the load-bearing artefact. The runbook
captures the recommended policy JSON. This dependency is
deliberate: the application's job is to write the file once; the
storage tier's job is to keep it readable for ten years.

### 4. PII handling — `govIdNumber` redacted to last-4

The archival payload preserves the BIR-required fields:

- `customer.fullName` — required for "who paid".
- `customer.phone` / `customer.email` / `customer.address` — required
  for the receipt's correspondence section.
- `customer.govIdNumberLast4` — last-4 alphanumeric chars only.

The full `govIdNumber` is **never** included. The BIR audit only
needs the last-4 for identification; the full number is sensitive
PII (NFR-S2 / Story 1.6's redaction policy) and out of scope for
archival. Story 1.6's `redactGovIdLast4` pattern is replicated in
`convex/lib/archivalQueries.ts:redactGovIdLast4`.

### 5. Idempotency — no duplicate exports per period

The action checks `archivalExports.by_period` at the start of every
run. If a row exists for the period AND its `s3Status` is not
`"failed"`, the action logs `[archivalExport] skipping {period} —
already exported` and returns. The cron's overshoot (firing on
each of days 28-31) collapses to a single successful export per
period.

A `failed` row IS overwritten on the next manual re-trigger —
that's the failure-recovery path. The story explicitly does NOT
implement automatic retry; manual re-trigger from
`/admin/archival-exports` is the Phase-1 surface.

### 6. Cron syntax — `0 20 28-31 * *` with self-guard in the action

Convex's `crons.monthly` requires a fixed `day` (UTC). The target
moment is "04:00 Manila on the 1st of every month" which is "20:00
UTC on the last day of the prior month" — that day shifts between
28 (Feb) and 31 depending on the month. A fixed `day: 30` would
silently miss February's archive.

The pragmatic choice is to fire on every candidate day (28, 29,
30, 31) at 20:00 UTC and rely on the action's idempotency check to
collapse the overshoot. Cost: a few seconds of cron startup per
day at month-end; benefit: portable across Convex's cron-expression
support without leaning on the non-portable `L` last-day-of-month
extension.

## Consequences

### Positive

- **Regulatory compliance.** NFR-R3 + FR62 are satisfied at the
  cron + archive blob layer; the S3 lifecycle policy completes the
  10-year horizon.
- **Vendor-independent recovery.** A `.json.gz` file on the
  cemetery's own S3 is readable without Convex.
- **Auditor-friendly format.** A BIR examiner can `gunzip` + open
  in a JSON viewer. No bespoke tooling required.
- **Negligible storage cost.** ~200KB / month compressed × 120
  months = ~24MB total per ten-year window. The S3 bill is in the
  noise.
- **Idempotent re-runs.** Manual re-trigger over a `failed` row
  reliably overwrites + retries.

### Negative

- **S3 lifecycle is out-of-band.** The 10-year retention depends on a
  policy the cemetery configures at the bucket's console — the
  application doesn't enforce it. The runbook documents the policy
  JSON; the deferred-row in the verification ledger is intended to
  catch drift.
- **PDF blobs NOT included.** The export carries receipt DATA; the
  rendered PDFs themselves (Story 3.13) are NOT bundled. If §10 Q3
  ever determines that PDF preservation is required by BIR, expand
  the export to include base64-encoded PDFs OR mirror Convex File
  Storage to S3 separately. Flagged as a §10 follow-up.
- **Automatic retry NOT implemented.** A failed S3 upload requires
  manual re-trigger by the admin. A future story can add backoff +
  retry queue.
- **No automated freshness check of old archives.** Nothing in the
  codebase verifies that 2026-05's file is still readable in 2036.
  The quarterly restore drill (ADR-0017) could be extended to also
  spot-check an old archival file annually. Flagged as a future
  enhancement.

## Alternatives considered

- **Real-time CDC to S3** (Convex change-data-capture stream → S3).
  Rejected: complex, beyond Phase 1 scope, and overkill for a
  retention surface that only needs monthly granularity.
- **Manual quarterly dump.** Rejected: error-prone (a forgotten
  quarter is a compliance gap); a cron-driven archive is the
  reliable shape.
- **Third-party backup tool.** Rejected: no Convex-integrated tool
  exists; a screen-scraper or migration runner would add a vendor
  + an attack surface.
- **CSV format instead of JSON.** Rejected: loses nested structure
  (line items, address sub-object). The narrower CSV surface lives
  on the `birExports` table for spreadsheet-friendly auditor
  workflows; the long-tail archive needs JSON.
- **Use `crons.monthly({ day: 1 })`.** Rejected: would fire at
  04:00 Manila on the 1st of every UTC month, which is mid-day in
  Manila and not the quiet-window-aligned moment we want. The 04:00
  Manila convention also keeps the cron co-aligned with the AR
  aging + reconciliation crons (off-peak).

## Forward links

- ADR-0017 — Database backups (Story 5.6). Companion ADR; the two
  together cover NFR-R2 (operational restore) and NFR-R3 / NFR-C2
  (BIR archival retention).
- Story 1.6 — `redactPii` / `redactGovIdLast4`. The archival
  redaction policy mirrors Story 1.6's pattern.
- Story 3.2 — `postFinancialEvent` cornerstone. This story
  consumes the `payments` + `receipts` tables that cornerstone
  populates.
- Story 3.13 — Receipt PDF generation. PDFs are NOT bundled in the
  archival JSON (see § Consequences).

## Future revisit triggers

This ADR should be re-opened when any of the following land:

1. **§10 Q3 (BIR receipt PDF retention) resolves.** If BIR
   mandates PDF preservation, expand the export to include the
   blobs or mirror File Storage separately.
2. **Automatic retry on S3 failure** becomes a stated requirement.
   Add a backoff + retry queue + a "last attempt" timestamp to the
   row.
3. **Convex File Storage retention guarantees change** (positively
   or negatively). The ADR assumes Convex's product-level retention
   indefinitely retains stored blobs; if Convex publishes a
   shorter retention floor, the S3 mirror becomes mandatory rather
   than optional.
4. **The cemetery's transaction volume exceeds the ~200KB / month
   gzipped envelope.** A future story may shift to chunked monthly
   archives (one blob per receipt batch) or a different
   compression algorithm (zstd) without breaking the JSON contract.
5. **A real BIR audit consumes the archive.** Capture the
   auditor's actual workflow + any format complaints in a follow-on
   story; iterate the schema if the JSON shape proved
   inconvenient.

## References

- [PRD § FR62 (archival export)](../../_bmad-output/planning-artifacts/prd.md#functional-requirements)
- [PRD § NFR-R3 (≥ 10-year retention)](../../_bmad-output/planning-artifacts/prd.md#reliability--availability)
- [PRD § NFR-C2 (BIR compliance)](../../_bmad-output/planning-artifacts/prd.md#compliance)
- [Architecture § Archival exports](../../_bmad-output/planning-artifacts/architecture.md#data-architecture)
- [Epics § Story 5.7](../../_bmad-output/planning-artifacts/epics.md#story-57-monthly-archival-export-for-bir-10-year-retention)
- ADR-0007 (PII encryption — the archive inherits the at-rest
  encryption posture)
- ADR-0017 (Database backups — operational counterpart)
- AWS SDK for JavaScript v3 docs: https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/
- Cloudflare R2 S3-compatibility docs: https://developers.cloudflare.com/r2/api/s3/
- Backblaze B2 S3-compatibility docs: https://www.backblaze.com/docs/cloud-storage-use-the-s3-compatible-api

## Superseded by

None.
