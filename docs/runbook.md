# Operations Runbook

- **Status:** Starter (Story 2.8 created the PII-encryption section; Story 5.6 added the Database backups section; Stories 5.5+, 5.7+, 6.x will continue to expand this file).
- **Last updated:** 2026-05-18

This document is the on-call / operator-of-record reference for the cemetery-mapping system. It is meant to be opened DURING an incident or compliance request, not read end-to-end on a regular cadence.

Sections are added by the stories that introduce the operational concern. As of 2026-05-18 it carries the PII-encryption section (Story 2.8) and the Database backups section (Story 5.6); future sections will cover reconciliation invariant failures (Story 5.5), BIR archival exports (Story 5.7), expense approval workflow exceptions (Story 6.6), etc.

## First-admin bootstrap

The Phase 1 deployment has **no seed script**. The first admin is bootstrapped automatically on the FIRST successful signup at `/login` via the `afterUserCreatedOrUpdated` callback in `convex/auth.ts`. The callback's guard is "no rows exist in `userRoles`" — once the first admin lands, every subsequent signup gets ZERO roles and must be granted access via `/admin/users` by the existing admin.

### Deployment checklist (first-admin bootstrap)

1. Deploy the backend (`npx convex deploy`) and the Next.js app.
2. Open `/login` and switch to the **Create account** tab.
3. Sign up with the cemetery's primary admin email + a strong password.
4. The auto-bootstrap callback grants the `admin` role on the same mutation that creates the account. Sign-in completes and the redirect lands on `/dashboard`.
5. Verify the admin role landed by opening `/admin/users` — the new account should appear with the `admin` chip.
6. (Optional, recovery only) If the auto-bootstrap fails or the account is created without a role for any reason, run:
   ```bash
   npx convex run internal/bootstrapFirstAdmin:run --userId=<user id from /admin/users or the Convex dashboard>
   ```
   The internal mutation re-runs the same "only when `userRoles` is empty" guard, then grants `admin` to the passed `userId`.

After the bootstrap, **disable self-signup in the UI** (Story 1.3 will remove the affordance entirely; until then, do not advertise the link to non-admin staff).

## PII encryption posture

### What's encrypted

All customer PII and customer-document blobs are encrypted at rest by Convex's managed infrastructure:

- `customers.govIdNumber`, `customers.address`, `customers.phone`, `customers.email` — encrypted at rest as part of the standard Convex table-row storage.
- `customerDocuments` rows + their backing `_storage` blobs (ID scans, affidavits, death certificates) — encrypted at rest as part of Convex File Storage.

Keys are held in Convex's managed key infrastructure (not customer-managed in Phase 1).

The application layer does NOT add field-level encryption on top. See **[ADR-0007](./adr/0007-pii-encryption.md)** for the decision record, alternatives considered, and revisit triggers.

### Auditor request: "Prove PII is encrypted at rest"

When an auditor / regulator / compliance reviewer asks to see proof of NFR-S2 compliance:

1. **Point to ADR-0007** (`docs/adr/0007-pii-encryption.md`). The Verification section cites Convex's published security documentation with the verified-by date.
2. **Point to the threat model** (`docs/threat-model.md` § A4 "Exfiltrated database backup") for the threat-model context.
3. If they need stronger evidence, the cemetery's Convex contract / SOC 2 report (held in the operator-of-record's secure document store, NOT in the code repo) contains Convex's third-party-audited attestation of the encryption posture.

**Do NOT** invent technical detail beyond what ADR-0007 documents. The architectural posture is the boundary; deeper claims belong to Convex, not to the application.

### Incident: suspected PII breach

When a PII breach is suspected (compromised account, unexpected access pattern, third-party report):

1. **Snapshot the suspected window.** Identify the start and end time of the suspicious activity.
2. **Run the breach-impact query.** Story 2.4's data-subject report + Story 2.3's `auditLog.by_actor` + `by_timestamp` indexes answer "which customer rows were touched in window X". The query is designed to return within 2 hours of the request (NFR-C4) on the full audit log set.
3. **Identify affected data subjects.** The query returns `customerId` values; cross-reference to `customers.fullName` + `customers.email` for the NPC notification cohort.
4. **NPC notification window: 72 hours.** From the moment the breach is confirmed, the operator-of-record has 72 hours to notify the National Privacy Commission and affected data subjects. The data-subject-report tooling in Story 2.4 produces the per-subject summary required by NPC's notification template.
5. **Audit log integrity check.** Verify the audit log was not tampered with — the `local-rules/no-audit-log-mutation` ESLint rule + the `auditLog`'s lack of any `patch` / `replace` / `delete` call sites are the design-time guards; runtime verification is per-row inspection by an admin.
6. **Convex security incident escalation.** If the breach is suspected at the Convex-storage layer (not at the application layer), escalate to Convex support — this is the § Future revisit trigger for ADR-0007. Document the response in the post-incident retrospective.

### Incident: ADR-0007 needs to change

If a § Future revisit trigger fires (multi-tenancy, PCI scope, NPC guidance shift, Convex posture change):

1. **Do NOT edit ADR-0007 in place.** Per ADR-0001's convention, decisions are immutable.
2. **Write a new ADR** that supersedes ADR-0007 with an explicit `Supersedes: ADR-0007` header.
3. **Plan the implementation story.** Changes to PII encryption posture are NOT drive-by edits; they touch schema, mutations, and the customer detail page's reveal flow. A dedicated story is required.
4. **The CI compliance check (`scripts/check-adr-0007.js`)** continues to enforce that ADR-0007 exists. If the new ADR truly supersedes it, the check needs to be updated to point at the new ADR number — that update is part of the superseding story's scope.

## Database backups

The cemetery's ledger lives in a single Convex deployment (`beaming-boar-935`).
Convex's managed daily backup feature is the canonical operational-recovery
path. **ADR-0017** records the strategy; this section is the procedure.

### Companion artifacts

These three files form the backup posture's documentation set. Keep them in
sync when the procedure changes:

| Artifact | What it carries |
|---|---|
| [`docs/runbook.md`](./runbook.md) (this file) | The procedure operators follow. |
| [`docs/restore-drill-log.md`](./restore-drill-log.md) | The empirical record of drills + unplanned restores. Story 5.6 AC4 requires this file to exist with at least a `[deferred]` first entry until the pilot lands real production data. |
| [`docs/evidence/`](./evidence/) | Quarterly backup-config screenshots filed as `backup-config-YYYY-MM-DD.png`. Story 5.6 AC1 requires this folder to exist and document the convention; the screenshots themselves accumulate as the quarterly verification runs. |

### Quick-reference verification checklist

The checklist below is the operator's hand-rail for the quarterly
verification — run through it top-to-bottom on the first Monday of each
quarter. The fuller procedure is below; this is the at-a-glance form.

- [ ] Signed in to Convex dashboard with `tech@broadheader.com`
- [ ] `beaming-boar-935` → **Settings → Backups** is reachable
- [ ] **Daily backups: enabled** ✓
- [ ] **Retention: ≥ 30 days** ✓
- [ ] Screenshot saved to `docs/evidence/backup-config-YYYY-MM-DD.png` (redacted)
- [ ] New row appended to ADR-0017 § Verification ledger (date, observer, retention value, evidence path)
- [ ] Latest entry in [`docs/restore-drill-log.md`](./restore-drill-log.md) is ≤ 100 days old (otherwise schedule a drill)
- [ ] `backup-check.yml` weekly workflow is passing

### Backup configuration verification (quarterly)

**Schedule:** every 3 months on the first Monday at 10:00 Manila, the on-call
developer verifies the Convex backup configuration. The CI workflow
`backup-check.yml` runs every Monday and is a reminder that the verification
is due; the verification itself happens in the dashboard, not in CI.

**Procedure:**

1. Sign in to the Convex dashboard at https://dashboard.convex.dev with
   `tech@broadheader.com`.
2. Open the `beaming-boar-935` project → **Settings → Backups** (the exact
   nav label may shift; look for "Backups" or "Snapshots").
3. Confirm:
   - **Daily backups: enabled.** If disabled, enable immediately and flag as
     an incident (the empirical RPO has been unbounded since the last
     verified-enabled date).
   - **Retention: ≥ 30 days.** If lower, raise the retention setting. If the
     current Convex plan does not support 30-day retention, do NOT silently
     lower the NFR-R2 target — raise to the project owner as a procurement
     question (per §10 follow-up).
4. Take a screenshot of the verified configuration. Save to
   `docs/evidence/backup-config-YYYY-MM-DD.png` (redact any deployment URLs
   or identifiers that aren't already public).
5. Append a row to the **ADR-0017 § Verification ledger** with the
   verification date, observer, retention value, and evidence path.
6. Close the corresponding `backup-check.yml` workflow run / issue (whichever
   the workflow opened — see "Weekly CI reminder" below).

### Restore from backup

#### When to invoke

Restore only when one of the following is true:

- Data corruption is suspected (an audit shows mass-deleted rows, an admin
  reports rows that should not exist, a reconciliation invariant fires for
  reasons that cannot be explained by a recent mutation).
- Accidental mass-delete or mass-update has been confirmed (an admin /
  office staff member acknowledges they ran a mutation against a wider
  scope than intended).
- A security incident requires rollback to a known-good state (per the PII
  breach procedure above and per ADR-0007's revisit triggers).
- The cemetery owner (Mr. Reyes) explicitly requests a restore in writing.

**NOT-criteria** — do NOT restore for:

- Routine debugging.
- "Testing what the data looked like yesterday."
- "Just in case." Out of an abundance of caution is not a reason to overwrite
  newer data with older data.

#### Authorization

Every restore — drill or unplanned — requires:

1. The on-call dev's go-ahead (admin role).
2. The cemetery owner's explicit authorization, captured in writing (email
   or chat). The chat / email is filed alongside the incident report.

A restore overwrites newer data with older data. A mistaken restore loses
real customer transactions. The authorization step is the safety brake;
removing it for "speed" is wrong.

#### Procedure (numbered, imperative)

1. Note the current production deployment name (`beaming-boar-935`) and the
   target snapshot timestamp. The target is **the most recent backup BEFORE
   the suspected corruption event** — NOT the most recent backup overall.
2. In the Convex dashboard, create a new scratch deployment named
   `beaming-boar-restore-YYYY-MM-DD`. The scratch deployment is the restore
   target — production is left untouched until the smoke check passes.
3. In the dashboard's Backups view, select the target snapshot and initiate
   the restore-to-deployment operation against the scratch deployment.
4. Wait for restore completion. Typical wall-clock: 5–30 minutes (measure
   during the drill and update this estimate).
5. Run the smoke check against the scratch deployment:
   - Sign in as the seed admin.
   - Load `/dashboard` — confirm tile values match the snapshot's expected
     state (e.g. lot inventory counts, AR balance).
   - Open one contract detail page — confirm it loads.
   - Generate or open one receipt PDF — confirm it renders.
   - Run the reconciliation invariant on-demand (`npx convex run
     reconciliation:runReconciliationNow`) — confirm it passes.
6. **If smoke-check passes:** coordinate cut-over with the cemetery owner.
   Update `.env.local` and the Vercel environment variables
   (`NEXT_PUBLIC_CONVEX_URL`, `CONVEX_DEPLOYMENT`) to point at the restored
   deployment. Verify production. File an incident report.
7. **If smoke-check fails:** do NOT cut over. Diagnose, document, escalate.
   The original `beaming-boar-935` remains the source of truth. The scratch
   deployment can be retained for forensic analysis or deleted.

#### Post-restore actions

1. File an incident report in `docs/incidents/YYYY-MM-DD-incident.md` (create
   the file). Minimum content: what happened, when discovered, what was
   restored (snapshot timestamp), who authorized, smoke-check outcome,
   wall-clock RTO.
2. Append a `## YYYY-MM-DD — Unplanned restore` entry to
   `docs/restore-drill-log.md` with the same fields as a drill entry plus
   the link to the incident report.
3. If the procedure had to be modified during the restore (the dashboard UI
   changed, a step took longer than the documented estimate, the smoke
   check missed a regression), update this runbook section in the same PR
   as the incident report.

#### Known limitations

- **File Storage coverage is unverified.** Convex's managed backups cover
  database tables; whether they also cover File Storage blobs (receipt PDFs,
  ID-scan uploads from Story 2.2) depends on Convex's current
  documentation. Re-verify at deploy time and update ADR-0017's
  verification ledger. If File Storage is NOT covered, Story 5.7's archival
  exports must include the blobs.
- **Cut-over is manual.** Step 7 of the procedure points the application at
  the restored deployment by editing environment variables. A more
  sophisticated cut-over (deployment alias, DNS swap) is out of scope for
  Phase 1; revisit if the manual cut-over proves too slow during a drill.
- **Manual verification of backup config.** Convex does not expose backup
  metadata via the SDK or a documented API. The weekly `backup-check.yml`
  workflow and the quarterly verification (above) are reminder-to-a-human
  procedures, not programmatic assertions. The `verifyBackupHealth` query
  in `convex/healthCheck.ts` returns this posture and points back here.

### Quarterly restore drill cadence

**Schedule:** every 3 months on the first Monday at 10:00 Manila. Tracked in
`docs/restore-drill-log.md`. Set a calendar reminder; the cadence is real,
not aspirational.

**Owner:** Phase 1 — the on-call developer. Phase 2+ — transferred to the
designated SRE / ops role once it exists.

**Procedure:** identical to the unplanned-restore procedure above, with the
following differences:

- The trigger is the calendar, not an incident. No incident report is filed.
- A smoke-check failure during a drill is a bug to fix — in the procedure,
  in the application, or in the data — **not** an incident.
- The cut-over step (step 7) is **skipped** during a drill. The scratch
  deployment is verified, the wall-clock RTO is recorded, then the scratch
  is deleted (or retained for additional verification).
- Each drill MUST produce an entry in `docs/restore-drill-log.md`. Missing
  two consecutive drills is itself an incident — the empirical RTO becomes
  unverified and NFR-R2's ≤ 4h commitment is in question.

**First drill:** deferred until Phase 1 has meaningful production data. Until
the first drill lands, the procedure above is **specification, not
practice** — and any reviewer asking "has this actually worked?" deserves a
straight "not yet" answer.

### Weekly CI reminder (`backup-check.yml`)

A GitHub Actions workflow runs every Monday at 09:00 UTC (17:00 Manila). It
invokes `scripts/check-backups.mjs` which:

1. Reads `docs/adr/0017-database-backups.md` and confirms the ADR is in
   place + names the required headings (Decision, Verification ledger).
2. Reads this runbook section and confirms the "Restore from backup"
   procedure is present.
3. Parses the ADR's verification ledger table and asserts the most recent
   entry is no older than 100 days (a quarter + grace). Older → workflow
   fails.
4. Returns exit 0 if all checks pass, exit 1 with a per-failure message
   otherwise.

The workflow failure shows up in the repository's Actions tab and emails the
configured admin (per GitHub's default notification settings). The
remediation is: perform the quarterly verification (above), append a row to
the verification ledger, commit, push. The next run goes green.

**The workflow does NOT programmatically verify Convex's backup config** —
no supported API for that exists at the time ADR-0017 was written. The
workflow's job is to make a missed quarterly verification visible.

## Archival exports (BIR 10-year retention)

Distinct from the operational backups above. Archival exports are the
**vendor-independent** 10-year regulatory archive that satisfies NFR-R3 +
FR62 — they cover the long-tail BIR audit horizon that Convex's 30-day
operational retention does NOT reach. See **ADR-0018** for the decision
record + threat model.

The shipped surface is two-tiered:

- **`/admin/bir-exports`** — narrow per-month CSV of receipts only, for
  the BIR examiner's spreadsheet workflow. Lives in the `birExports`
  table (Story 5.7 narrowed Phase-1 surface).
- **`/admin/archival-exports`** — full-ledger monthly archive (receipts
  + payments + customers + contracts) as compressed JSON. Lives in the
  `archivalExports` table. This is the 10-year regulatory archive
  proper.

### Schedule

The monthly archival action runs unattended at approximately **04:00
Manila on the 1st of each month** (20:00 UTC on the last day of the
prior month). The cron in `convex/crons.ts` fires the action on each of
days 28–31 at 20:00 UTC; the action's idempotency guard collapses the
overshoot into a single export per period.

### Where the file lives

- **Convex File Storage** — every archival export is stored as
  `archives/{YYYY-MM}.json.gz`. The blob is referenced from the
  `archivalExports.storageId` field and served to admins via the
  short-lived signed URL returned by `archivalExports:getDownloadUrl`
  (NFR-S3).
- **Optional S3 mirror** — when `ARCHIVE_S3_BUCKET` is configured (see
  § S3 configuration below), the action ALSO writes the gzipped blob
  to the bucket with the same key. The S3 ETag + upload timestamp are
  captured on the `archivalExports` row.

### How to verify monthly export succeeded

1. Sign in as Admin.
2. Open `/admin/archival-exports`.
3. Confirm the latest period (e.g. `2026-05` on the first business day
   of June) appears at the top of the table with `s3Status: uploaded`
   (when S3 is configured) or `s3Status: skipped` (when it is not).
4. Open the **Download** button to confirm the signed URL serves the
   gzipped blob (the browser downloads `2026-05.json.gz` ≈ 200KB).

If a period is missing entirely, manually trigger it (next section).
If the period is present but `s3Status: failed`, the S3 misconfig
needs investigating before retrying (env vars, IAM, network).

### How to manually trigger an export

The `/admin/archival-exports` page exposes a **Re-run for period**
form at the top. Enter the `YYYY-MM` period and submit. The form
calls the `archivalExports:triggerArchivalExport` mutation, which
schedules the internal action via `ctx.scheduler.runAfter(0, ...)`.
Within a few seconds the row appears (or updates, on a failed-row
retry) in the table below.

Equivalently from the CLI:

```bash
npx convex run actions/archivalExport:monthlyArchivalExport \
  --arg overridePeriod=2026-05
```

The action's idempotency check makes the manual trigger safe:
re-running over a `ready` row is a no-op; re-running over a `failed`
row overwrites + retries S3.

### S3 configuration

The S3 mirror is **opt-in via env var**. Set the following in the
Convex dashboard's environment-variables panel (NOT in
`.env.local` — those are gitignored and not visible to the deployed
action):

| Env var | Required | Purpose |
|---|---|---|
| `ARCHIVE_S3_BUCKET` | yes (to enable) | Destination bucket name |
| `ARCHIVE_S3_REGION` | when bucket is set | e.g. `us-east-1`, `eu-central-1`, `auto` (R2) |
| `ARCHIVE_S3_ACCESS_KEY` | when bucket is set | IAM access key id |
| `ARCHIVE_S3_SECRET_KEY` | when bucket is set | IAM secret access key |
| `ARCHIVE_S3_ENDPOINT` | optional | Custom endpoint for non-AWS providers |

**Supported providers** (any S3-compatible API):

- **AWS S3** — no `ARCHIVE_S3_ENDPOINT` needed.
- **Cloudflare R2** — set `ARCHIVE_S3_ENDPOINT` to the R2 account
  URL (`https://<account>.r2.cloudflarestorage.com`).
- **Backblaze B2** — set `ARCHIVE_S3_ENDPOINT` to the B2 region
  endpoint (`https://s3.<region>.backblazeb2.com`).
- **Wasabi** — set `ARCHIVE_S3_ENDPOINT` to the Wasabi region
  endpoint (`https://s3.<region>.wasabisys.com`).

### S3 bucket lifecycle policy (10-year retention)

**Critical:** the 10-year retention horizon is enforced at the
**bucket lifecycle layer**, not from this codebase. The application
writes the file once; the bucket's lifecycle policy keeps it
readable for 10 years. Configure the policy at the provider's
console.

Example AWS S3 lifecycle policy JSON (paste into the bucket's
*Management → Lifecycle rules → JSON* editor):

```json
{
  "Rules": [
    {
      "ID": "cemetery-archive-10-year-retention",
      "Status": "Enabled",
      "Filter": { "Prefix": "archives/" },
      "Expiration": { "Days": 3700 },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 3700 }
    }
  ]
}
```

`3700 days ≈ 10 years 2 months` — the small grace bonus keeps a
late-clock-drifted file readable past the regulatory floor.

For Cloudflare R2 / Backblaze B2 / Wasabi, the lifecycle policy
syntax differs but the same shape applies (prefix filter
`archives/`, retention ≥ 3700 days).

**Bucket versioning** is recommended but not required. With
versioning enabled, accidental delete/overwrite produces a
recoverable noncurrent version; without it, an overwrite is final.

### What is NOT in the archive

The archive carries **data**, not rendered PDFs. Specifically:

- ✅ Every receipt's `receiptNumber`, `receiptSerial`, `issuedAt`,
  `amountCents`, `paymentMethod`, `isVoided`, and back-pointers to
  the payment / contract / customer.
- ✅ Every payment's `paymentNumber`, `amountCents`, `paymentMethod`,
  `receivedAt`, void state.
- ✅ Every customer referenced by the period's payments / receipts
  — with `govIdNumber` **REDACTED to last-4** (BIR audit needs the
  last-4 for identification; the full number is sensitive PII and
  out of scope for the archive).
- ✅ Every contract referenced by the period's payments — with its
  total / state / kind.
- ❌ **Receipt PDF blobs** themselves (Story 3.13). Those are in
  Convex File Storage but NOT bundled into the JSON.
- ❌ **Customer ID-document scans** (Story 2.2). Those are in
  Convex File Storage; archival is governed by Story 2.4's
  data-subject-report tooling, NOT by this monthly archive.

If §10 Q3 (BIR receipt PDF retention requirement) ever determines
that PDFs themselves must be archived, expand the export to bundle
base64-encoded blobs OR mirror Convex File Storage to S3
separately. Flagged as a §10 follow-up — see ADR-0018 § Future
revisit triggers.

### What to do if a monthly export fails

1. Open `/admin/archival-exports`. Look for the period's row.
2. **Row missing entirely.** The cron may not have fired (Convex
   deployment outage at the time?) OR the action failed before
   inserting the row. Manually trigger via the "Re-run for period"
   form OR the `npx convex run` command above.
3. **Row present, `s3Status: failed`.** Investigate the
   `s3ErrorMessage` field. Common causes:
   - Invalid IAM credentials → rotate + redeploy env vars.
   - Bucket does not exist → create it + verify the bucket name
     matches `ARCHIVE_S3_BUCKET`.
   - Custom endpoint typo → re-check `ARCHIVE_S3_ENDPOINT`.
   - Region mismatch → check `ARCHIVE_S3_REGION` against the
     bucket's actual region.
4. After fixing, manually re-trigger. The action's idempotency
   check tolerates the re-run — the existing storage blob + row
   are overwritten + the S3 upload retried.

### Long-tail verification (annual spot check)

Once per year, the on-call admin should download a randomly-
selected archive that is at least 12 months old and confirm:

- The gzipped blob unpacks cleanly (`gunzip -t archives/YYYY-MM.json.gz`).
- The JSON parses successfully (`jq . archives/YYYY-MM.json` exits 0).
- The `schemaVersion`, `period`, and `recordCounts` match the
  metadata on the `archivalExports` row.

This is the long-tail-readability drill — analogous to ADR-0017's
quarterly restore drill but at a yearly cadence and against the
archival surface rather than the operational backups.

## Convex deployment URLs

The provisioned deployment for this project is **beaming-boar-935**. Convex exposes it under two distinct origins:

| URL | Purpose | Where it's set |
|---|---|---|
| `https://beaming-boar-935.convex.cloud` | Backend (queries, mutations, actions). The React client connects here. | `NEXT_PUBLIC_CONVEX_URL` env var (consumed by `src/lib/convexClient.ts`). |
| `https://beaming-boar-935.convex.site` | HTTP routes registered in `convex/http.ts`. External providers POST here. | `CONVEX_SITE_URL` env var (operational reference only — no code reads it today). |

### Webhook endpoints to register with each provider

Each external provider that posts callbacks to this system must be configured in its own dashboard with the full URL below:

| Provider | URL to paste into the provider's webhook config |
|---|---|
| GCash (Story 9.5) | `https://beaming-boar-935.convex.site/api/gcash-webhook` |
| Maya (Story 9.6) | `https://beaming-boar-935.convex.site/api/maya-webhook` |
| Card processor (Story 9.6) | `https://beaming-boar-935.convex.site/api/card-webhook` |
| Resend / SendGrid / Postmark email bounces (Story 9.8) | `https://beaming-boar-935.convex.site/api/email-bounce-webhook` |

Every webhook route verifies an HMAC signature before accepting the payload. Each provider has its own signing secret — store them as `GCASH_WEBHOOK_SECRET`, `MAYA_WEBHOOK_SECRET`, `CARD_WEBHOOK_SECRET`, and `EMAIL_WEBHOOK_SECRET` respectively (via `npx convex env set …` for production; `.env.local` for dev).

### Convex env-var management

- **Dev** — `.env.local` (gitignored). Created from `.env.example`. Convex CLI picks them up automatically.
- **Prod / preview** — `npx convex env set KEY value` (writes to the Convex dashboard). Vercel env vars cover anything Next.js reads at build/runtime (`NEXT_PUBLIC_*` + server-side Next runtime).
- **Never commit secrets** — the gitignore covers `.env`, `.env.local`, `.env.*.local`.

---

## Brand application

The cemetery is **Apostle Paul Memorial Park · Cases Land Inc.** at Zone 1, San Eugenio, Aringay, La Union 2503, Philippines. The brand is defined in `apostle-paul-brand-guidelines.html` at the repo root. Applied 2026-05-22.

### Where each brand surface lives

| Surface | File | What it controls |
|---|---|---|
| Color tokens (Tailwind) | `tailwind.config.ts` | Emerald, Forest, Moss, Ivory, Stone, Gold, Ink hex values. Status pill colors stay semantic (overdue red, available emerald — NOT brand) |
| CSS variables (themable) | `src/app/globals.css` | `--page-bg`, `--text-base`, `--focus-ring-color`, font variables. Outdoor-mode swap preserved for accessibility. |
| Fonts | `src/app/layout.tsx` | `next/font/google` loaders for Cormorant Garamond + Manrope + JetBrains Mono. Replaces Inter. |
| Logo + wordmark | `public/brand/mark.svg`, `public/brand/wordmark.svg` | Placeholder dove-within-laurel. Replace with final asset before go-live. |
| Masthead | `src/components/AppShell/*` | Renders mark + wordmark in the staff app sidebar header. |
| Customer portal masthead | `src/app/(customer)/portal/**` | Same brand mark; ivory background. |
| Voice / customer copy | `convex/lib/reminderTemplates.ts`, `src/app/(customer)/portal/**`, `src/components/CustomerPortal/*` | SMS + email reminder bodies, portal copy, status pill labels customer-visible. |
| Branded PDFs | `convex/actions/generate{Receipt,Contract,DemandLetter,Plaque}Pdf.ts` | Letterhead, gold hairline, Cormorant display, "With reverence" sign-off. New plaque PDF generator. |
| Embedded brand assets (PDF runtime) | `convex/lib/brandAssets.ts` | Base64-bundled mark SVG that the "use node" PDF actions consume — Convex actions can't read `public/`. |
| Cemetery address (single source) | `convex/lib/brandAddress.ts` | One canonical string consumed by PDFs, portal, footers. |

### Voice pillars (Chapter IX of the brand guide)

1. **Reverent** — "honour", "remembrance", "legacy". Never "product", "package", "deal".
2. **Compassionate** — short sentences, patient pauses, never urgent, never bright.
3. **Permanent** — present and future tense. The estate "holds", "keeps", "remembers". Avoid past-tense around the deceased.
4. **Restrained** — no superlatives, no urgency markers, no exclamation marks.

Forbidden phrasing (audit any new copy against this list):

- "Premium packages now available"
- "Book your peace today!"
- "Limited estate plots — secure yours"
- "Don't miss our 2026 promo rates"
- The best/biggest/cheapest anything in La Union

### What needs cemetery client sign-off before go-live

- Final logo asset (current SVG is a placeholder; the dove-laurel motif is correct but a designer should produce the final mark).
- Final business cards / letterhead per stationery spec (Chapter VI of the brand guide — 350gsm cotton, blind deboss, gold foil).
- Confirmation of canonical postal address + corporate name.
- Confirmation that "Cases Land Inc." is the correct legal entity for receipt / contract identification.

### When to update this section

- A new branded surface lands (e.g. a new PDF template type, a new customer-facing email): add a row to the table above with the file + what it controls.
- The brand guide HTML revises a commitment (palette change, new font, new sign-off pattern): apply the change to every file in the table and update this section accordingly.
- The cemetery's address or legal entity name changes: update `convex/lib/brandAddress.ts` first; every consumer derives from there.

---

## References

- [ADR-0007 — PII encryption at rest](./adr/0007-pii-encryption.md)
- [ADR-0017 — Database backups](./adr/0017-database-backups.md)
- [ADR-0018 — Archival exports](./adr/0018-archival-export.md)
- [Threat model](./threat-model.md)
- [Story 2.3 — PII access logged on every read](../_bmad-output/implementation-artifacts/2-3-pii-access-is-logged-on-every-read.md)
- [Story 2.4 — admin produces a data-subject report](../_bmad-output/implementation-artifacts/2-4-admin-produces-a-data-subject-report.md)
- [Story 2.8 — PII fields encrypted at rest](../_bmad-output/implementation-artifacts/2-8-pii-fields-encrypted-at-rest.md)
- [Story 5.6 — Daily database backups verified](../_bmad-output/implementation-artifacts/5-6-daily-database-backups-verified.md)
- [Story 5.7 — Monthly archival export for BIR 10-year retention](../_bmad-output/implementation-artifacts/5-7-monthly-archival-export-for-bir-10-year-retention.md)
