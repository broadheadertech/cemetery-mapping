/**
 * Health-check surface — Story 5.6 (FR61, NFR-R2).
 *
 * Admin-only queries that report the cemetery deployment's operational
 * posture. Story 5.6 ships ONE query — `verifyBackupHealth` — that
 * reports the state of Convex managed backups + the most recent manual
 * verification recorded in ADR-0017.
 *
 * Why this query exists even though it can't programmatically verify:
 *   Convex does not currently expose backup metadata (last snapshot
 *   timestamp, retention setting, snapshot list) via its TypeScript SDK
 *   or via a documented HTTP / REST API. The dashboard is the source of
 *   truth. This query therefore returns the "manual verification
 *   required" posture documented in ADR-0017 — it does NOT silently
 *   pretend the backup is healthy. The shape of the response is
 *   designed so that, when Convex eventually ships a programmatic
 *   backup-status API, the body of this query becomes the real check
 *   without an API shape change at the call site.
 *
 * What the query returns today:
 *   {
 *     status: "manual-verification-required",
 *     deploymentName: "beaming-boar-935",  // documented; verified at deploy time
 *     retentionDaysTarget: 30,             // NFR-R2 floor
 *     lastVerifiedAt: number | null,       // null until the first dashboard check is logged
 *     ageMs: number | null,                // Date.now() - lastVerifiedAt, or null
 *     ageThresholdMs: 100 * DAY_MS,        // quarter + grace
 *     ageBreaches: boolean,                // true if ageMs > ageThresholdMs (or null)
 *     runbookSection: "docs/runbook.md#database-backups",
 *     adr: "docs/adr/0017-database-backups.md",
 *     notes: "...",
 *   }
 *
 * The 25-hour assertion (per Story 5.6's spec) is enforced by treating
 * `ageBreaches` as a HARD signal — UI / CI consumers MUST treat
 * `ageBreaches: true` as a failure. Today the field is computed from
 * `lastVerifiedAt`, which only the runbook updates; once Convex exposes
 * the actual last-snapshot timestamp we swap it in and the same field
 * starts reflecting real backup age.
 *
 * Admin-only — `requireRole(ctx, ["admin"])` is the first awaited
 * statement (lint-enforced via local-rules/require-role-first-line).
 *
 * Tests: tests/unit/convex/healthCheck.test.ts.
 */

import { queryGeneric } from "convex/server";

import { requireRole, type QueryCtx } from "./lib/auth";
import { DAY_MS, HOUR_MS } from "./lib/time";

/**
 * Backup health snapshot returned to the client. Shape is intentionally
 * verbose (named fields rather than a numeric code) so UI / runbook
 * consumers don't have to decode magic numbers.
 *
 * Re-exported as a top-level interface so the unit test can assert on
 * it without re-declaring the shape.
 */
export interface BackupHealthReport {
  /**
   * Posture marker. Today only one value exists: `manual-verification-required`.
   * When Convex ships a programmatic backup API, additional values can
   * be added (`healthy` / `stale` / `disabled`) WITHOUT removing this
   * literal — the call-site stays back-compat.
   */
  status: "manual-verification-required";
  /** Documented deployment name (from ADR-0017). */
  deploymentName: string;
  /** NFR-R2 retention floor (operational days). */
  retentionDaysTarget: number;
  /** Wall-clock of the last quarterly dashboard verification, or null. */
  lastVerifiedAt: number | null;
  /** `Date.now() - lastVerifiedAt`, or null when never verified. */
  ageMs: number | null;
  /** Age beyond which a verification is overdue (quarter + grace = 100 days). */
  ageThresholdMs: number;
  /**
   * `true` when `ageMs > ageThresholdMs` OR `lastVerifiedAt` is null.
   * Consumers (CI workflow, dashboard tile) MUST treat this as a hard
   * failure signal.
   */
  ageBreaches: boolean;
  /** Runbook anchor for the verification procedure. */
  runbookSection: string;
  /** ADR path for the strategy rationale. */
  adr: string;
  /** Human-readable note for runbook readers. */
  notes: string;
}

/**
 * The Story 5.6 spec calls for "asserts age < 25 hours" against the
 * latest Convex backup metadata. Convex does not expose that metadata
 * today, so the assertion is instead applied to the most recent manual
 * verification logged in the ADR — and the threshold is widened to the
 * quarterly cadence (100 days = a quarter + grace).
 *
 * When the programmatic backup API ships:
 *   1. Replace the source of `lastVerifiedAt` with the latest Convex
 *      snapshot's `createdAt`.
 *   2. Drop `ageThresholdMs` to `25 * HOUR_MS` (the original spec).
 *   3. Flip the `status` literal to `"healthy"` / `"stale"` / etc.
 * The call-site (`scripts/check-backups.mjs`, dashboard tile) keeps
 * working because the shape is unchanged.
 */
export const AGE_THRESHOLD_MS = 100 * DAY_MS;

/**
 * Documented deployment name from Story 1.1 + ADR-0017. Kept as a
 * module-level constant so a future deployment rename only updates one
 * line.
 */
export const DEPLOYMENT_NAME = "beaming-boar-935";

/** NFR-R2 retention floor. */
export const RETENTION_DAYS_TARGET = 30;

/**
 * Last dashboard verification timestamp. `null` until the first
 * quarterly verification is logged in the ADR's verification ledger
 * and reflected here. Updating this constant is part of the runbook's
 * "Backup configuration verification (quarterly)" step 5 — same PR
 * that appends to the ADR ledger appends here.
 *
 * Kept in code (rather than read from the ADR markdown) so the unit
 * test can stub it without parsing markdown, and so the typecheck
 * catches a malformed update.
 */
export const LAST_VERIFIED_AT: number | null = null;

/**
 * Reference both `HOUR_MS` and the original 25-hour spec value here so
 * future maintainers searching for "25 hour" / "25h" find the trail
 * back to Story 5.6's original requirement and the reason it was
 * widened to a quarter.
 */
export const ORIGINAL_25H_THRESHOLD_MS = 25 * HOUR_MS;

function computeReport(now: number): BackupHealthReport {
  const ageMs =
    LAST_VERIFIED_AT === null ? null : Math.max(0, now - LAST_VERIFIED_AT);
  const ageBreaches = ageMs === null ? true : ageMs > AGE_THRESHOLD_MS;
  return {
    status: "manual-verification-required",
    deploymentName: DEPLOYMENT_NAME,
    retentionDaysTarget: RETENTION_DAYS_TARGET,
    lastVerifiedAt: LAST_VERIFIED_AT,
    ageMs,
    ageThresholdMs: AGE_THRESHOLD_MS,
    ageBreaches,
    runbookSection: "docs/runbook.md#database-backups",
    adr: "docs/adr/0017-database-backups.md",
    notes:
      "Convex does not expose backup metadata via SDK/API. " +
      "Verification is by dashboard inspection on a quarterly cadence; " +
      "see runbook 'Backup configuration verification (quarterly)' and " +
      "ADR-0017 'Verification ledger'. ageBreaches=true means the " +
      "quarterly check is overdue OR has never been performed.",
  };
}

/**
 * Admin-only health check for Convex managed backups.
 *
 * Returns the manual-verification posture documented in ADR-0017.
 * `ageBreaches: true` is the actionable signal — see the runbook's
 * Database backups section for remediation (perform the quarterly
 * dashboard verification, append to the ADR ledger, update
 * `LAST_VERIFIED_AT` in this file).
 *
 * Why no `args`: the query reports the global posture of the single
 * cemetery deployment; there is no per-record filter that would make
 * sense at the call site.
 *
 * Why admin-only: backup health is an operational concern. The dashboard
 * tile that consumes this query lives behind admin auth (per Story 5.2
 * dashboard scope). Surface broadening (e.g. office_staff visibility)
 * is intentionally not in Phase 1 scope.
 */
export const verifyBackupHealth = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<BackupHealthReport> => {
    await requireRole(ctx, ["admin"]);
    return computeReport(Date.now());
  },
});

// Re-export the report-building helper for the unit test. The handler
// itself depends on `Date.now()` which the test stubs via fake timers;
// `computeReport` is exposed so a test can also pass an arbitrary `now`
// directly without re-implementing the body.
export { computeReport };
