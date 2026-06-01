# Restore Drill Log

This file is the empirical record of Convex backup-restore drills for the
`beaming-boar-935` deployment. The cadence and procedure are defined in
[`docs/runbook.md` § Database backups](./runbook.md#database-backups);
this log is where the verification *evidence* lands.

Each drill entry MUST capture:

- **Date** — when the drill was performed (ISO date, Manila timezone).
- **Operator** — the on-call dev who ran it.
- **Snapshot timestamp** — which backup was restored.
- **Wall-clock RTO** — minutes from "initiate restore" to "smoke check passed".
- **Smoke check outcome** — pass / fail with notes.
- **Evidence path** — link to any screenshots / logs filed under
  `docs/evidence/`.

Unplanned restores (real incidents, not drills) ALSO land here per the
runbook's "Post-restore actions" section, prefixed with `Unplanned`.

Missing two consecutive scheduled drills is itself an incident — the
empirical RTO becomes unverified and NFR-R2's ≤ 4h commitment is in
question.

---

## YYYY-MM-DD — [deferred until pilot completes]

Per Story 5.6 AC4 escape hatch: the first scheduled drill is **deferred
until Phase 1 has meaningful production data**. Until the first drill
lands, the restore procedure in [`docs/runbook.md`](./runbook.md) is
*specification, not practice* — and any reviewer asking "has this
actually worked?" deserves a straight "not yet" answer.

- **Status:** deferred
- **Reason:** Phase 1 pilot has not yet been deployed against the cemetery's
  real ledger. Restoring an empty deployment proves nothing meaningful
  about the procedure's correctness or wall-clock RTO.
- **Trigger to un-defer:** the first month after Phase 1 cuts over to
  production data (real customers, real contracts, real payments). At
  that point, schedule the next quarterly drill window and run the full
  procedure end-to-end.
- **Recorded by:** [on-call dev]
- **Recorded on:** 2026-05-24

> When this entry is replaced by a real drill, keep this `[deferred]`
> stub in the file's history (git) and append the real drill above it.
> Future operators should be able to read this log top-down and see the
> drill history without losing the deferral context.
