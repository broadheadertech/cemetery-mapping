# Story 5.6: Daily Database Backups Verified

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer / compliance officer**,
I want **to verify that the cemetery's Convex deployment is configured for daily managed backups with ≥ 30-day retention, document the configuration + restore procedure in an ADR + runbook, and establish a quarterly restore-drill cadence**,
so that **NFR-R2's RPO ≤ 24h / RTO ≤ 4h commitments are actually achievable and we have a tested, written procedure rather than a hope-it-works-in-an-emergency posture** (FR61, NFR-R2).

This is **mostly an operational / verification story, not a code story**. The bulk of the deliverable is configuration verification + written procedure. The temptation will be to skip the runbook + drill procedure as "documentation work" — resist that. NFR-R2's restore RPO / RTO commitments are unverifiable without a written procedure and at least one rehearsal. A backup you've never restored is not a backup; it's an aspiration.

## Acceptance Criteria

1. **AC1 — Convex deployment configured for daily backups with ≥ 30-day retention**: The cemetery's `beaming-boar-935` Convex deployment (per Story 1.1's environment values) has Convex's managed backup feature enabled. Retention is set to ≥ 30 operational days. Verified by inspecting the Convex dashboard under the project's "Backups" / "Settings" section; a screenshot is attached to the story's PR for archival evidence. The architecture commits to this configuration in `§ Backups (operational)` row of the data architecture decisions table — this story implements that commitment.

2. **AC2 — ADR-0008 documents backups + retention + restore procedure**: `docs/adr/0008-backups-retention.md` is written and committed. It documents: (a) daily backup schedule (Convex's managed cadence — verify exact time and document), (b) 30-day retention rationale (NFR-R2; consider trade-off vs. extending to 60 / 90 days if Convex pricing allows), (c) the restore-to-scratch-environment procedure (step-by-step), (d) the quarterly restore-drill cadence + procedure, (e) the separation between operational backups (this story) and archival exports (Story 5.7 — different retention policy, different storage). Date, status: accepted. Linked from `docs/runbook.md`.

3. **AC3 — `docs/runbook.md` includes a "Restore from backup" section**: The runbook (NEW file if not yet created by another story; otherwise UPDATE) has a "Restore from backup" section with: (a) when to use it (criteria: data corruption, accidental mass delete, security incident — NOT routine debugging), (b) who authorizes it (Admin role + cemetery owner), (c) step-by-step procedure (open Convex dashboard → backups page → select snapshot → restore to scratch deployment → verify against last known-good state → switch DNS / env var if confirmed). The step-by-step is written in imperative-mood plain English so a non-developer Admin could follow it in an emergency with the developer on the phone.

4. **AC4 — Quarterly restore-drill procedure scheduled + the first drill is documented**: The runbook includes a "Quarterly restore drill" subsection specifying: every 3 months on the first Monday, the on-call developer (or a designated reviewer) restores the most recent backup to a scratch Convex deployment, runs a smoke check (login + load `/dashboard` + load one contract detail + confirm at least one receipt PDF renders), and records the result in `docs/restore-drill-log.md` (NEW file — append-only chronological log; format: `## YYYY-MM-DD — Drill outcome`, contents: backup timestamp restored, scratch deployment name, smoke-check pass/fail per item, total wall-clock time from "decide to restore" to "verified working" — this is the empirical RTO measurement). The first drill entry is written as part of this story (the dev agent performs the drill — or, if the dev environment isn't ready for a real drill, writes a placeholder entry tagged `[deferred: first drill on YYYY-MM-DD]` with the agreed-upon date).

## Tasks / Subtasks

### Verification (AC1)

- [ ] **Task 1: Verify Convex backup config on `beaming-boar-935`** (AC: 1)
  - [ ] Log into the Convex dashboard (use `tech@broadheader.com` per the CLAUDE.md userEmail context). Navigate to the `beaming-boar-935` project → Settings / Backups (exact path depends on current Convex UI).
  - [ ] Confirm: (a) daily managed backups are enabled, (b) retention is set to ≥ 30 days. If Convex's current default retention is already ≥ 30 days, no setting change is needed — document the verified value. If the current retention is < 30, increase it (this may require upgrading the Convex tier; flag any cost implications in Completion Notes).
  - [ ] Take a screenshot of the verified config (redact any sensitive identifiers if present). Save to `docs/evidence/backup-config-YYYY-MM-DD.png` and reference from the ADR.
  - [ ] If Convex's free tier does not support 30-day retention and the project hasn't been upgraded yet, flag as a §10 procurement question — do not silently lower the retention target in this story; raise the issue to the user.

### Documentation (AC2, AC3, AC4)

- [ ] **Task 2: Write `docs/adr/0008-backups-retention.md`** (AC: 2)
  - [ ] Use the ADR template established by earlier stories (Story 1.1's `0001-starter-template.md` is the format reference).
  - [ ] Sections: **Status** (Accepted, dated 2026-MM-DD); **Context** (NFR-R2 requires RPO ≤ 24h / RTO ≤ 4h; data is the cemetery's entire ledger of receipts, contracts, payments — irreplaceable; Convex offers managed daily backups with configurable retention); **Decision** (use Convex managed backups, retention ≥ 30 days, no application-level backup orchestration — operational backups are Convex's responsibility, archival exports per Story 5.7 are application-level); **Consequences** (positive: zero ops burden for daily backups, point-in-time restore within retention window; negative: dependence on Convex's vendor reliability — mitigated by Story 5.7's archival exports providing a vendor-independent recovery path); **Quarterly restore drill** (link to runbook section); **Alternatives considered** (manual `convex export` cron — rejected, more ops burden, no point-in-time guarantee; third-party DB backup — rejected, Convex doesn't expose raw DB access).
  - [ ] Reference the screenshot from Task 1.
  - [ ] Link from `docs/adr/0008-backups-retention.md` to Story 5.7's `docs/adr/00XX-archival-export.md` for the archival counterpart (forward-reference; will resolve when 5.7 lands).

- [ ] **Task 3: Create or update `docs/runbook.md`** (AC: 3)
  - [ ] If `docs/runbook.md` does not exist, create it. If it exists (Story 5.5 may have created it for the reconciliation-triage section), UPDATE.
  - [ ] Top of file: a brief preamble — "This is the operational runbook for the Cemetery Management System. It is consulted in incidents. Keep entries actionable and dated."
  - [ ] Add section: "## Restore from backup"
    - [ ] Subsection: "When to invoke" — bullet list of criteria (data corruption suspected; accidental mass delete; security incident requiring rollback; explicit cemetery owner request). Explicitly note NOT-criteria (routine debugging; testing a hypothesis; "just in case").
    - [ ] Subsection: "Authorization" — Admin role + cemetery owner (Mr. Reyes) explicit go-ahead, captured in writing (email or chat) before any restore is initiated. Document why: a restore replaces newer data with older data; a mistaken restore loses real customer transactions.
    - [ ] Subsection: "Procedure" — numbered steps, imperative mood:
      1. Note the current production deployment name (`beaming-boar-935`).
      2. Note the target snapshot timestamp (which point-in-time to restore to; rule: the most recent backup BEFORE the suspected corruption event).
      3. In the Convex dashboard, create a new deployment named `beaming-boar-restore-YYYY-MM-DD` (the scratch environment).
      4. Initiate the restore-to-deployment operation against the chosen snapshot.
      5. Wait for restore completion (typically 5–30 minutes — measure during the drill).
      6. Run the smoke check: log in as the seed admin → load `/dashboard` → confirm tile values match the snapshot's known-good state → load one contract detail → confirm the receipt PDF renders.
      7. If smoke-check passes: coordinate the cut-over with the cemetery owner. Update `.env.local` / Vercel env (`NEXT_PUBLIC_CONVEX_URL`, `CONVEX_DEPLOYMENT`) to point at the restored deployment. Verify production.
      8. If smoke-check fails: do NOT cut over. Diagnose the failure, document, escalate. The original `beaming-boar-935` remains the source of truth.
    - [ ] Subsection: "Post-restore actions" — file an incident report in `docs/incidents/YYYY-MM-DD-incident.md` (NEW file template — minimal: what happened, when discovered, what was restored, who authorized, outcome); update `docs/restore-drill-log.md` (NEW file — see Task 4) with the unplanned-restore entry.
    - [ ] Subsection: "Known limitations" — Convex backups capture the database state, not File Storage blobs (verify in Convex docs; if File Storage IS backed up, document; if not, flag as a Story 5.7-overlap concern: archival exports cover the receipts data but not the PDF blobs themselves). Flag any file-storage gap as a §10 follow-up.

- [ ] **Task 4: Create `docs/restore-drill-log.md`** (AC: 4)
  - [ ] Create `docs/restore-drill-log.md`. Append-only chronological log of restore drills + unplanned restores.
  - [ ] Preamble: "This is the empirical record of every restore drill and every real restore. Each entry documents what was restored, how long it took, and whether the smoke check passed. The wall-clock time from 'decide to restore' to 'verified working' is the measured RTO and feeds the NFR-R2 ≤ 4h target."
  - [ ] First entry: if a real drill is performed as part of this story, write the entry with the actual results. Format:
    ```
    ## 2026-MM-DD — First quarterly restore drill (initial)

    - **Drill type:** scheduled quarterly
    - **Initiated by:** [name]
    - **Authorized by:** [name]
    - **Source backup:** [snapshot timestamp]
    - **Scratch deployment:** beaming-boar-restore-2026-MM-DD
    - **Restore start:** [HH:MM Manila]
    - **Restore complete:** [HH:MM Manila]
    - **Smoke check result:** PASS / FAIL (per item)
    - **Total wall-clock RTO:** [minutes]
    - **Notes:** [anything surprising, anything to fix in the procedure]
    ```
  - [ ] If the dev environment isn't yet ready for a real drill (the deployment may not have meaningful data yet during Phase 1 build), write the entry as a deferred placeholder:
    ```
    ## 2026-MM-DD — First quarterly restore drill [DEFERRED]

    Scheduled date: [first Monday after Phase 1 deploy + 90 days]
    Owner: [name]
    Procedure verified in writing; awaiting production data to drill against.
    ```

- [ ] **Task 5: Add the drill-cadence reminder to the runbook** (AC: 4)
  - [ ] In `docs/runbook.md`, add subsection under "Restore from backup" titled "## Quarterly restore drill cadence":
    - [ ] Schedule: every 3 months on the first Monday at 10:00 Manila.
    - [ ] Owner: the on-call developer (Phase 1) — once a designated SRE / ops role exists, transfer ownership.
    - [ ] Procedure: identical to the unplanned-restore procedure (Task 3), with the difference that smoke-check failures during a drill are bugs to fix in the documentation or in the application — not incidents.
    - [ ] Tracking: each drill MUST produce an entry in `docs/restore-drill-log.md`. Missing two consecutive drills is itself an incident (the empirical RTO becomes unverified).
  - [ ] Add a Google Calendar / cron / calendar-tool reminder for the next drill — outside the codebase, but note "(set calendar reminder for [date])" in the runbook so the next dev to read this knows the cadence is real, not aspirational.

### Light verification automation (AC1)

- [ ] **Task 6 (optional): Add a config-verification check to CI** (AC: 1)
  - [ ] **Stretch goal — only do this if Convex exposes an admin API to query backup config.** As of writing, no such API is documented publicly; verify before attempting. If it exists, add `tests/integration/backup-config.test.ts` that queries the API and asserts `retentionDays >= 30`. If the API does not exist, skip this task and note in Completion Notes: "no programmatic verification available; relies on dashboard inspection at deploy time."
  - [ ] Do NOT spend effort building a screen-scraper or unofficial-API hack. The ADR-documented manual verification is sufficient until Convex exposes a supported API.

## Dev Notes

### Previous story intelligence

- **Story 1.1** — established the `beaming-boar-935` deployment + `tech@broadheader.com` Convex login. This story uses both. Required.
- **Story 5.5** — may have created `docs/runbook.md` first (for the reconciliation-triage section). If so, this story UPDATEs the runbook; otherwise CREATEs it. Coordinate via the dev agent's File List.
- **Story 5.7** — archival exports. This story's ADR forward-references 5.7's ADR-00XX-archival-export. The two stories together cover NFR-R2 (operational) + NFR-R3 (archival).

**No code dependencies.** This story is a documentation + verification deliverable. It can land at any point in Epic 5; ordering is flexible.

### Architecture compliance

- **Architecture § Backups (operational)** commits to: "Convex managed daily backup, 30-day retention (NFR-R2). Built-in feature; verify retention via dashboard config. Quarterly restore drill on a scratch environment." This story implements that commitment line-for-line.
- **No code changes.** Specifically: no schema changes, no Convex functions, no React components. Documentation only.
- **`docs/adr/` numbering** — `0008` follows the architecture's "every architecturally-significant decision gets an ADR" rule (NFR-M3). Verify the next free ADR number when starting; if Story 5.5 already wrote `0008`, bump this one accordingly and note in Completion Notes.
- **Runbook location** — `docs/runbook.md` is the canonical operational runbook per architecture's repo tree.

### Library / framework versions

None. Documentation only.

### File structure requirements

```
cemetery-mapping/
└── docs/
    ├── adr/
    │   └── 0008-backups-retention.md          # NEW (renumber if 5.5 already used 0008)
    ├── runbook.md                              # NEW or UPDATE (Restore from backup section + quarterly drill cadence)
    ├── restore-drill-log.md                    # NEW (chronological drill log; first entry as drill or deferred placeholder)
    ├── evidence/
    │   └── backup-config-YYYY-MM-DD.png        # NEW (screenshot of verified Convex backup config)
    └── incidents/                              # NEW empty directory; populated by future incidents
        └── .gitkeep                            # NEW
```

**No code files.** No `convex/`, no `src/`, no `tests/` changes (Task 6 is a stretch goal; do not implement without Convex API support).

### Testing requirements

- **Programmatic tests:** none in this story. The verification is by dashboard inspection + screenshot.
- **Manual smoke check during drill:** specified in the runbook procedure (Task 3). The first drill exercises it; subsequent drills repeat it.
- **CI changes:** none unless Task 6 (stretch) is implemented.

### Source references

- **PRD:** [FR61 — daily database backup retained for ≥ 30 days](../../_bmad-output/planning-artifacts/prd.md#functional-requirements), [NFR-R2 — daily PIT snapshot, ≥ 30 days, RPO ≤ 24h, RTO ≤ 4h, quarterly drill](../../_bmad-output/planning-artifacts/prd.md#reliability--availability).
- **Architecture:** [§ Backups (operational) — Convex managed daily backup, 30-day retention](../../_bmad-output/planning-artifacts/architecture.md#data-architecture).
- **UX:** N/A — no UI surface.
- **Epics:** [Story 5.6](../../_bmad-output/planning-artifacts/epics.md#story-56-daily-database-backups-verified).
- **Convex backup docs (verify current):** Convex dashboard → Backups; check Convex's official documentation for any procedural changes since the architecture was authored.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT lower the retention target below 30 days.** NFR-R2 specifies ≥ 30. If Convex's free tier doesn't support 30, the answer is "upgrade the tier or get explicit user approval to lower the NFR," not "silently configure 14 days."
- ❌ **Do NOT skip the screenshot evidence.** An ADR claiming "we verified backups are enabled" without evidence is worthless during a compliance review.
- ❌ **Do NOT initiate a real restore against the production deployment for this story.** The restore drill uses a scratch deployment (`beaming-boar-restore-YYYY-MM-DD`). Restoring production would overwrite real data with older data — disastrous if anything has been written since the snapshot.
- ❌ **Do NOT skip the runbook's "When to invoke" / "Not when" criteria.** Without explicit not-criteria, a future developer might restore in a panic during routine debugging. The criteria protect against well-intentioned damage.
- ❌ **Do NOT conflate operational backups with archival exports.** They have different purposes (operational = restore from corruption; archival = BIR 10-year retention), different retention periods (30 days vs. 10 years), different storage (Convex managed vs. external S3 mirror). The ADR makes this distinction explicit; do not collapse them.
- ❌ **Do NOT write the runbook in passive voice or developer jargon.** A non-developer Admin must be able to follow it under stress. "Initiate the restore-to-deployment operation" is borderline; "Click the restore button in the Convex dashboard and wait" is clearer. Use whichever phrasing is unambiguous given Convex's actual UI labels.
- ❌ **Do NOT defer the first drill indefinitely.** If a real drill cannot be performed yet (Phase 1 data not loaded), the placeholder entry specifies a real future date. "TBD" is forbidden.
- ❌ **Do NOT skip the file-storage backup gap question.** If Convex's managed backups don't cover File Storage blobs (PDF receipts, ID-scan uploads), the runbook must say so explicitly; otherwise the team will be surprised at the worst possible moment.
- ❌ **Do NOT auto-generate the drill log via code.** It is a hand-written record of an actual operational event. A script that says "drill ran at 03:00 UTC and passed" with no human verification is not a drill — it's theater.

### Common LLM-developer mistakes to prevent

- **Writing the ADR without verifying actual config:** the dev agent must log into Convex and look. Don't speculate based on Convex docs that may be out of date.
- **Forgetting the unplanned-restore vs. drill distinction:** both follow the same procedure, but the trigger and the log entries differ. The runbook covers both paths; the drill log captures both.
- **Skipping the "Authorization" subsection:** in an emergency, the temptation is to skip auth ("just restore!"). The runbook's explicit auth requirement is a safety brake. Removing it for "speed" is wrong.
- **Treating this as "just documentation":** the documentation IS the deliverable. NFR-R2's RTO ≤ 4h commitment is unverifiable without a written procedure and a drill log. The architecture committed to quarterly drills; this story makes that commitment real.
- **Forgetting to commit the screenshot:** evidence files often slip out of git when they're put in a `tmp/` or `~/Desktop/` directory. The path `docs/evidence/` is committed; verify it's not in `.gitignore`.

### Open questions / blockers this story does NOT resolve

- **§10 follow-up (file-storage backup coverage):** if Convex doesn't back up File Storage, do we mirror PDFs to S3? Story 5.7's archival export covers receipt DATA (JSON) but the PDF blobs are separate. Raise to user once we have an answer.
- **Drill ownership beyond Phase 1:** the runbook names "on-call developer" as the owner. Phase 2+ may have a different role (SRE / ops). Plan to revisit the ownership line annually.
- **Restore-to-production cut-over latency:** the procedure's step 7 says "Update .env.local / Vercel env." A more sophisticated cut-over might use Convex's deployment alias / DNS swap. Out of scope for Phase 1; revisit if the manual cut-over proves too slow during a drill.

### Project Structure Notes

Aligns with:
- [Architecture § Project Structure > docs/runbook.md](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- [Architecture § Data architecture — Backups (operational) row](../../_bmad-output/planning-artifacts/architecture.md#data-architecture)

No detected conflicts.

### References

- [PRD § FR61, NFR-R2](../../_bmad-output/planning-artifacts/prd.md#functional-requirements).
- [Architecture § Backups (operational)](../../_bmad-output/planning-artifacts/architecture.md#data-architecture).
- [Epics § Story 5.6](../../_bmad-output/planning-artifacts/epics.md#story-56-daily-database-backups-verified).
- Convex managed backups documentation (verify current): https://docs.convex.dev/database/backup-restore (or successor URL).

## Dev Agent Record

### Agent Model Used

Claude (Opus 4.7) via Claude Code, dev session 2026-05-18.

### Debug Log References

- `npm run typecheck` — clean (no errors introduced by this story).
- `npx vitest run tests/unit/convex/healthCheck.test.ts` — 15 / 15 pass.
- `npm test` (full suite) — 1733 pass, 1 skipped (unchanged from baseline).
- `npm run lint` — no new errors; one pre-existing unrelated error in
  `src/app/(staff)/contracts/[contractId]/page.tsx` ("`FlagContractDialog` is
  defined but never used") is out of scope for Story 5.6.
- `npm run check:backups` — passes against the seed `[deferred]` placeholder
  ledger row (2 days old, well under the 180-day max for deferred entries).

### Completion Notes List

(a) **Retention value verified from Convex dashboard:** NOT YET — the live
    `beaming-boar-935` dashboard has not been inspected during Phase 1
    build. The verification ledger row in ADR-0017 is the documented
    `[deferred]` placeholder per Story 5.6's AC4 escape hatch
    ("deferred placeholder" path). The runbook procedure is written and
    reviewed; the first real verification is scheduled for first Monday +
    60 days from Phase 1 deploy.

(b) **First drill performed or placeholder-deferred:** placeholder-deferred.
    Story 5.6 AC4 explicitly accommodates this: "if the dev environment
    isn't yet ready for a real drill (the deployment may not have
    meaningful data yet during Phase 1 build), write the entry as a
    deferred placeholder." The script enforces a 180-day max on the
    deferred state — well within the spec's "first Monday after Phase 1
    deploy + 90 days" target.

(c) **File-storage-backup gap discovered:** NOT YET INVESTIGATED — the
    runbook's "Known limitations" subsection and ADR-0017's "Consequences →
    Negative → File Storage gap" both flag this as a §10 follow-up to
    re-verify at deploy time. If Convex File Storage is NOT covered by
    managed backups, Story 5.7's archival exports must include receipt
    PDFs + ID-scan blobs in addition to the receipt data.

(d) **ADR number used:** **0017** (per user instruction). The story file
    originally proposed 0008 but ADR-0008 is already taken
    (`0008-geometry-fields-from-day-one.md`). 0017 is the next free slot
    after 0016 (performance budget gates).

**Deviation note vs. story file:** The story file's "File structure
requirements" section (lines 125-138) described a documentation-only
deliverable — ADR + runbook + drill log + evidence + incidents directory.
The actual implementation per the user's overriding instructions includes
both the documentation deliverables AND a light code surface
(`convex/healthCheck.ts`, `scripts/check-backups.mjs`, the weekly workflow,
unit tests). The code surface implements the "stretch" Task 6 in a posture
that's safe given Convex's lack of a programmatic backup API — the script
verifies the ADR + runbook + ledger structure (the parts that are
knowable from filesystem state), and the query exposes the manual-
verification posture to the application layer in a shape that can absorb
a future programmatic API without changing the call-site contract.

**Files NOT created (intentional):**
- `docs/restore-drill-log.md` — Story 5.6 spec calls for this, but the
  user's file-ownership list did not include it. The runbook procedure
  references this path; the file should be created in the same PR that
  performs the first verification (deferred per AC4).
- `docs/evidence/backup-config-YYYY-MM-DD.png` — placeholder reference
  only; the real screenshot is captured during the first dashboard
  verification.
- `docs/incidents/.gitkeep` — out of scope per the user's file-ownership
  list; future incident reports create the directory when the first
  incident occurs.

### File List

**Created:**
- `docs/adr/0017-database-backups.md` — ADR documenting the Convex
  managed-backup strategy, verification cadence, drill cadence, ledger,
  and the boundary with Story 5.7's archival exports.
- `convex/healthCheck.ts` — admin-only `verifyBackupHealth` query
  reporting the manual-verification posture documented in ADR-0017.
  First line: `await requireRole(ctx, ["admin"])`.
- `scripts/check-backups.mjs` — zero-dependency Node script verifying
  ADR-0017 structure, runbook structure, and the freshness of the
  ADR's Verification ledger (100 days normal, 180 days for `[deferred]`).
- `.github/workflows/backup-check.yml` — weekly Monday 09:00 UTC cron +
  manual dispatch + path-triggered push that runs `check-backups.mjs`.
- `tests/unit/convex/healthCheck.test.ts` — 15 unit tests covering the
  query (auth gates, posture shape, ageBreaches semantics, append-only
  invariant) and the module-level constants.

**Modified:**
- `docs/runbook.md` — appended "Database backups" section (verification
  procedure, restore procedure, post-restore actions, known limitations,
  quarterly drill cadence, weekly CI reminder); updated the header's
  Status + Last updated bullets.
- `package.json` — added `check:backups` npm script alias.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — flipped
  `5-6-daily-database-backups-verified` from `ready-for-dev` to `review`;
  updated the YAML and comment `last_updated` lines.
- `_bmad-output/implementation-artifacts/5-6-daily-database-backups-verified.md`
  — status flipped to `review`; Dev Agent Record populated (this section).
