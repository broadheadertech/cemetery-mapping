# ADR 0017: Database Backups — Convex Managed, Verified Weekly

- **Status:** Accepted
- **Date:** 2026-05-18
- **Story:** 5.6
- **Deciders:** theundead (project owner) + Amelia (dev)

## Context

The cemetery's entire ledger — contracts, payments, receipts, ownership history,
audit log — lives in a single Convex deployment (`beaming-boar-935`). The data
is irreplaceable: a 24-hour outage of the application is recoverable; a 24-hour
loss of the ledger is not. The PRD's reliability NFRs commit to specific
restore targets:

- **NFR-R2** — daily point-in-time snapshot, retained ≥ 30 days, RPO ≤ 24h, RTO
  ≤ 4h, with a quarterly restore drill.
- **FR61** — daily database backup retained ≥ 30 days.

The architecture's **§ Backups (operational)** row commits the implementation
to Convex's managed daily backups with 30-day retention. This ADR records the
decision, the verification posture, and the boundary between operational
backups (this ADR) and BIR archival exports (Story 5.7 — separate concern,
separate retention, separate ADR).

Three failure modes the strategy must defend against:

1. **Backup drift** — Convex's free / starter tier default retention silently
   drops below 30 days during a plan / pricing change. The dashboard config
   is the source of truth, but nothing in the codebase notices when it
   shifts.
2. **Backup-but-no-restore** — a backup that has never been restored is an
   aspiration, not a backup. RTO ≤ 4h is unmeasured until a drill produces a
   wall-clock number.
3. **Single-vendor dependence** — Convex's managed backups live entirely
   inside Convex's infrastructure. If Convex itself is the failure mode
   (account compromise, vendor outage, contract dispute), operational backups
   do not help. Story 5.7's archival exports provide the vendor-independent
   recovery path.

## Decision

### 1. Convex managed daily backups with ≥ 30-day retention

The cemetery deployment uses Convex's built-in managed backup feature.
Verification is performed via the Convex dashboard at deployment time and
re-verified on a quarterly cadence (drill). No application-level backup
orchestration is added — operational backups are Convex's responsibility.

**Why not roll our own `convex export` cron:**

- More ops burden (a script to maintain, monitoring to wire, storage to
  provision).
- No point-in-time guarantee — `convex export` is snapshot-at-cron-tick;
  Convex's managed backups offer point-in-time restore inside the retention
  window.
- The architecture's "boring technology" principle (Winston's note in
  ADR-0001) favours the managed feature over a hand-rolled one when the
  managed feature meets the requirement.

**Why not a third-party backup tool:**

- Convex does not expose raw database access; the only supported backup path
  is Convex's own.
- A third-party tool would add a vendor + an attack surface for zero
  incremental coverage.

### 2. Verification is documented + runbook-driven, not programmatic

Convex does **not** currently expose backup metadata (last snapshot time,
retention setting, snapshot list) through its public TypeScript SDK or via
a documented HTTP / REST API. The dashboard is the system of record.

This ADR therefore commits to a **dual verification posture**:

- **At deploy time** — the dashboard is inspected and a screenshot of the
  verified config is committed to `docs/evidence/`. The screenshot is the
  point-in-time evidence; the ADR is the rationale.
- **On a recurring cadence** — a weekly CI workflow (`backup-check.yml`)
  reminds the on-call dev to re-verify the dashboard. The workflow itself
  cannot programmatically verify Convex backup metadata (no SDK / API
  surface for it). The workflow's job is to **make the verification due
  visible** — it fails (or creates an issue) until a human acknowledges the
  weekly check via the runbook procedure.

The `convex/healthCheck.ts` query (`verifyBackupHealth`) is the stub that
surfaces the same posture at the application layer: admin-only, returns the
manual-verification metadata, and points the caller at the runbook. When
Convex eventually ships a programmatic backup-metadata API (verify with each
Convex SDK release), this query becomes the real programmatic check and the
"manual verification required" flag flips off.

**Why not a screen-scraper:**

- Convex's dashboard HTML / auth flow is not a stable interface; a scraper
  would break on every dashboard redesign.
- The disaster-prevention note in Story 5.6 explicitly forbids unsupported
  API hacks. The dashboard-as-source-of-truth posture is intentional until a
  supported API exists.

### 3. Quarterly restore drill, logged in `docs/restore-drill-log.md`

Every 3 months, the on-call dev restores the most recent backup to a scratch
Convex deployment, runs a smoke check (login + dashboard load + contract
detail + receipt PDF render), and records the wall-clock RTO in the drill
log. The first drill is deferred until Phase 1 has meaningful production
data; the runbook section captures the procedure now so the first drill is a
mechanical run-through, not a design exercise.

Missing two consecutive drills is itself an incident — the empirical RTO
becomes unverified and NFR-R2 is in question.

### 4. Boundary with archival exports (Story 5.7)

Operational backups (this ADR) and archival exports (Story 5.7 → ADR-00XX,
forward reference) are **distinct concerns**:

| Aspect | Operational backups (this ADR) | Archival exports (Story 5.7) |
|---|---|---|
| Purpose | Restore from corruption / accidental loss | BIR 10-year retention compliance |
| Retention | ≥ 30 days | 10 years |
| Storage | Convex managed | External S3 mirror |
| Cadence | Daily | Monthly |
| Format | Convex internal (opaque) | JSON / CSV (BIR-readable) |
| Failure mode covered | Application-layer data loss | Vendor lock / Convex contract dispute |

A future reviewer must not collapse these into "the backup story" — the two
together cover NFR-R2 (operational restore) and NFR-C2 (BIR archival
retention). Either alone leaves a gap.

## Verification ledger

| Date | Verified by | Retention setting observed | Evidence |
|---|---|---|---|
| 2026-05-18 | Amelia (dev) | `[deferred]` — pending live deployment access during Phase 1 build | `docs/evidence/backup-config-YYYY-MM-DD.png` (placeholder) |

The 2026-05-18 row is a **deferred placeholder** — it records that the
procedure has been written and reviewed, but the first real dashboard
verification has not yet been performed against `beaming-boar-935`. The
deferred row keeps the weekly `backup-check.yml` workflow from failing on
every push while still flagging that real verification is outstanding.

The first non-deferred row is scheduled for the first Monday of Phase 1 +
60 days (calendar reminder set by the on-call dev). Each subsequent
quarterly drill confirmation appends a new row.

**Deferred-row rule:** the `[deferred]` marker is valid for **at most 180
days** (twice the normal cadence) from the ADR's acceptance date. After
180 days, the deferred row is no longer accepted by the check script and
the workflow fails until a real verification lands. This prevents the
deferred state from becoming the permanent posture.

## Consequences

### Positive

- Zero ops burden for daily backups — Convex owns the infrastructure.
- Point-in-time restore within the retention window — granularity better
  than a daily snapshot cron.
- Encryption at rest is inherited from Convex's storage layer (see ADR-0007).
- The boundary with Story 5.7 is explicit, so a future regression that
  conflates the two has an ADR to point at.

### Negative

- **Single-vendor dependence.** If Convex itself is the failure mode, this
  ADR alone does not recover the cemetery. Mitigated by Story 5.7's archival
  exports.
- **Manual verification.** Until Convex exposes a programmatic backup-status
  API, the weekly check is a reminder-to-a-human, not an automated assertion.
  The drift risk is real and the runbook's "When to invoke" section names it.
- **File Storage gap (open).** Convex File Storage blobs (receipt PDFs,
  ID-scan uploads) may or may not be covered by managed backups — the answer
  depends on Convex's current documentation and must be re-checked at
  deploy time. The runbook's "Known limitations" section captures this as a
  §10 follow-up; if File Storage is NOT covered, the archival export in
  Story 5.7 must include the blobs, not just the metadata.

## Alternatives considered

- **Hand-rolled `convex export` cron** — rejected (see § Decision item 1).
- **Third-party Convex backup tool** — rejected; no such tool exists with
  supported access to Convex's internals.
- **No backups, rely on Story 5.7's archival exports** — rejected; monthly
  archival is the wrong granularity for daily operational data loss (29-day
  RPO blows past NFR-R2's 24h ceiling).
- **Lower retention to 14 days to fit a cheaper tier** — explicitly rejected
  by Story 5.6's disaster-prevention note. NFR-R2 says ≥ 30. The answer is
  "upgrade the tier or amend the NFR with explicit owner approval," not
  "silently configure 14 days."

## Future revisit triggers

This ADR should be re-opened when any of the following land:

1. **Convex ships a programmatic backup-metadata API.** Update
   `convex/healthCheck.ts` to consume it; remove the "manual verification
   required" flag. Update the CI workflow to assert programmatically rather
   than remind a human.
2. **File Storage backup coverage is verified.** Add a row to the
   verification ledger and remove the runbook's "Known limitations" caveat
   (or, if File Storage is NOT covered, raise to §10 and expand Story 5.7's
   archival scope).
3. **The cemetery's data volume exceeds Convex's plan retention ceiling.**
   Negotiate plan upgrade or layer in a hand-rolled archival path; amend
   this ADR with the new tier and retention.
4. **A real (unplanned) restore is performed.** The drill log gains an
   entry; if the procedure had to be modified mid-flight, the runbook is
   updated in the same PR.

## References

- [PRD § FR61 (daily backup ≥ 30 days)](../../_bmad-output/planning-artifacts/prd.md#functional-requirements)
- [PRD § NFR-R2 (RPO ≤ 24h, RTO ≤ 4h, quarterly drill)](../../_bmad-output/planning-artifacts/prd.md#reliability--availability)
- [Architecture § Data architecture — Backups (operational)](../../_bmad-output/planning-artifacts/architecture.md#data-architecture)
- [Epics § Story 5.6](../../_bmad-output/planning-artifacts/epics.md#story-56-daily-database-backups-verified)
- [Story 5.6 — Daily database backups verified](../../_bmad-output/implementation-artifacts/5-6-daily-database-backups-verified.md)
- ADR-0007 (PII encryption — backups inherit the at-rest encryption posture)
- ADR-0014 (Reconciliation invariants — adjacent operational concern; runbook
  shares the same incident-response style)
- Story 5.7 — monthly archival exports (forward reference; companion ADR)
- Convex backup docs: https://docs.convex.dev/database/backup-restore (verify
  on each Convex SDK release)

## Superseded by

None.
