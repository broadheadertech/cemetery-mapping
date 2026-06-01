/**
 * Convex scheduled-function registry — Story 4.1 (FR34, NFR-P3).
 *
 * Single source of truth for every cron entry the deployment runs. New
 * scheduled functions land here, not in their domain file — the domain
 * file owns the internal mutation; this file is the registration index.
 *
 * Cron registration uses the `cronJobs()` factory from `convex/server`
 * exactly as documented in the Convex docs (https://docs.convex.dev/
 * scheduling/cron-jobs). The exported default is the `Crons` instance;
 * Convex picks it up automatically when the project deploys.
 *
 * Timezone discipline:
 *   - Convex `crons.daily(...)` schedules in UTC. Manila (Asia/Manila) is
 *     UTC+8 with no DST, so 17:00 UTC ↔ 01:00 Manila. The story's
 *     "1 AM Manila" requirement therefore maps to `hourUTC: 17`.
 *   - PH has no daylight-saving transitions; the same UTC hour holds
 *     year-round.
 *
 * Why a single name `"recompute-ar-aging"` and not multiple slots:
 *   Convex deduplicates cron entries by name. Having a single, stable
 *   entry name lets us see the run history in one place on the Convex
 *   dashboard and avoids accidentally double-scheduling the same job
 *   when the file is edited.
 *
 * Function-reference shape:
 *   Cron registration accepts a `SchedulableFunctionReference`. We build
 *   each reference via `makeFunctionReference` (string-path form) rather
 *   than importing from `convex/_generated/api`. `_generated/` only
 *   exists AFTER `npx convex dev` runs interactively, and `tsconfig.json`
 *   excludes that directory from typecheck — so a static
 *   `import { internal } from "./_generated/api"` would break
 *   `npx tsc --noEmit` for the unit-test suite. The string-path form
 *   matches the rest of the codebase (`convex/contracts.ts:2711`,
 *   `convex/birExport.ts:547`, `convex/actions/gatewayCreateIntent.ts:67`)
 *   and resolves to the same runtime function reference at deploy time.
 *
 *   CRITICAL: previously this file gated every `crons.daily(...)` call
 *   behind a `try { require("./_generated/api") } catch {}` block — when
 *   `_generated/` was absent (fresh checkout, CI), the gate evaluated
 *   `false` and ALL crons silently unregistered. The deploy succeeded
 *   with zero scheduled functions and the runtime defect was invisible
 *   until the first day's AR aging snapshot went stale. The
 *   `makeFunctionReference` form eliminates the gate entirely: every
 *   call is unconditional, so a fresh checkout that builds cleanly
 *   carries every cron entry. The `assertCronsRegistered()` invariant
 *   below is the belt-and-suspenders deploy-time tripwire.
 *
 * Manual replay path (documented in `docs/runbook.md`):
 *   `npx convex run arAging:internal_recomputeAllAging`
 *   The cron only differs in that it runs unattended once per day.
 */

import { cronJobs, makeFunctionReference } from "convex/server";

const crons = cronJobs();

/**
 * Helper: build a zero-arg mutation/action reference from a string
 * function path. Convex's `crons.daily(...)` accepts any
 * `SchedulableFunctionReference = FunctionReference<"mutation" |
 * "action", "public" | "internal">`, so `makeFunctionReference`'s
 * default "public" visibility satisfies the slot at typecheck time
 * AND resolves to the underlying internal function at deploy time
 * (Convex resolves by path, not by visibility-typed reference shape).
 *
 * The named wrappers exist for readability — `mutationRef("foo:bar")`
 * is grep-able and the type ascription documents the intent without
 * forcing an `_generated/api` dependency.
 */
function mutationRef(path: string) {
  return makeFunctionReference<"mutation", Record<string, never>, unknown>(
    path,
  );
}

function actionRef(path: string) {
  return makeFunctionReference<"action", Record<string, never>, unknown>(
    path,
  );
}

// Story 4.1 — daily AR aging snapshot recompute (FR34, NFR-P3).
//
// 17:00 UTC == 01:00 Asia/Manila (UTC+8, no DST).
crons.daily(
  "recompute-ar-aging",
  { hourUTC: 17, minuteUTC: 0 },
  mutationRef("arAging:internal_recomputeAllAging"),
);

// Story 5.5 — daily reconciliation invariant (FR60, NFR-R4).
//
// The reconciliation cron runs 1 hour after AR aging (02:00 Manila vs
// 01:00 Manila) so the aging snapshot rows are settled before the
// invariant checks run — not strictly required for correctness (the
// three reconciliation checks read `payments` / `contracts` /
// `installments`, not `arAgingSnapshots`), but the spacing keeps
// log review tractable and gives each cron a dedicated quiet window.
//
// 18:00 UTC == 02:00 Asia/Manila (UTC+8, no DST). Same timezone
// discipline as the AR aging registration above; Manila has no DST,
// so the offset is constant year-round.
//
// Manual replay path (documented in `docs/adr/0014-reconciliation-invariants.md`):
//   `npx convex run reconciliation:runReconciliationNow`
// The on-demand mutation is admin-gated and records the run with
// `triggeredBy: "manual"`; the cron registration here records the
// run with `triggeredBy: "cron"` via the internal mutation's default.
crons.daily(
  "daily-reconciliation-invariant",
  // 18:00 UTC == 02:00 Asia/Manila (UTC+8, no DST).
  { hourUTC: 18, minuteUTC: 0 },
  mutationRef("reconciliation:internal_runDailyReconciliation"),
);

// Story 4.3 — daily re-flag of expired follow-up actions (FR36).
//
// Runs at 03:00 Manila — sits AFTER the 02:00 reconciliation invariant
// and the 01:00 AR aging recompute so the previous-day snapshot has
// settled before this sweep flips any rows. Convex crons do not provide
// ordering guarantees between distinct entries; the hour-of-day
// separation is the load-bearing contract.
//
// 19:00 UTC == 03:00 Asia/Manila (UTC+8, no DST). Same timezone
// discipline as the AR aging registration above; Manila has no DST,
// so the offset is constant year-round.
//
// Manual replay path (documented in `docs/runbook.md`):
//   `npx convex run followUpActions:internal_reflagExpired`
// The internal mutation logs scanned / expired / elapsed-ms counters
// to `npx convex logs` for observability.
crons.daily(
  "reflag-expired-follow-up-actions",
  // 19:00 UTC == 03:00 Asia/Manila (UTC+8, no DST).
  { hourUTC: 19, minuteUTC: 0 },
  mutationRef("followUpActions:internal_reflagExpired"),
);

// Stories 9.7 + 9.8 — daily reminder scan (FR57, NFR-I3).
//
// Single cron entry that walks `reminderConfig.rules` for the day and
// dispatches both SMS (Story 9.7) and email (Story 9.8) reminders.
// The scan deduplicates via `reminderDeliveries.by_installment_rule`
// so re-running on the same day is a no-op. The per-row action
// (`sendSmsReminder.send` / `sendEmailReminder.send`) is scheduled by
// the scan mutation; retries / backoff live inside that action's
// result-routing path.
//
// Runs at 09:00 Manila — sits AFTER the 03:00 follow-up re-flag sweep
// + the 02:00 reconciliation invariant + the 01:00 AR aging recompute
// so the prior-day snapshots have settled before this scan walks
// installments. Convex crons do not provide cross-entry ordering
// guarantees; the hour-of-day separation is the load-bearing contract.
//
// 01:00 UTC == 09:00 Asia/Manila (UTC+8, no DST).
//
// Cut-over note: the Phase 1 `emailReminderLog` stub
// (`convex/actions/sendEmailReminders.ts` + its `send-email-reminders`
// cron) was RETIRED once this cadence-driven scan + the
// `reminderDeliveries`/Resend pipeline went live. The stub could not be
// migrated in place — it exported an `internalMutation` yet lived under
// `convex/actions/`, where Convex now requires a `"use node"` directive
// that is illegal in a module exporting mutations. The legacy
// `emailReminderLog` table is left in the schema (empty, no writer)
// pending a later drop.
//
// Manual replay path (documented in `docs/runbook.md`):
//   `npx convex run reminders:internal_runDailyReminderScan`
crons.daily(
  "send-reminders",
  // 01:00 UTC == 09:00 Asia/Manila (UTC+8, no DST).
  { hourUTC: 1, minuteUTC: 0 },
  mutationRef("reminders:internal_runDailyReminderScan"),
);

// Story 5.7 — monthly archival export for BIR 10-year retention
// (FR62, NFR-R3, NFR-C2).
//
// The action body in `convex/actions/archivalExport.ts` is invoked once
// per month. Each run exports the PRIOR calendar month's receipts +
// payments + customers + contracts as compressed JSON to Convex File
// Storage (and optionally mirrors to a configured S3 bucket).
//
// Cron syntax choice — `crons.cron(...)` with a 5-field expression:
//   `0 20 28-31 * *` fires at 20:00 UTC on every day 28..31 of every
//   month. The action then SELF-GUARDS: when invoked it always
//   computes the PRIOR month in Manila tz (via
//   `convex/lib/archivalPeriods.ts:getPriorPeriod`) and the
//   idempotency check on `archivalExports.by_period` makes accidental
//   second-run invocations within the same period a no-op.
//
// Why this choice over `crons.monthly`:
//   - `crons.monthly({ day, ... })` requires a fixed day-of-month in
//     UTC. The target moment is "04:00 Manila on the 1st" which is
//     20:00 UTC on the LAST day of the prior month — that day shifts
//     between 28 and 31 depending on the month. A fixed `day: 30`
//     would silently misfire in February.
//   - `0 20 28-31 * *` overshoots most months (it fires on each of
//     days 28-31), but the action's idempotency guard collapses the
//     extra invocations into a single export per period. The cost is
//     a few seconds of cron startup per month — negligible.
//   - Convex's cron expression format follows the standard 5-field
//     POSIX cron (`minute hour day-of-month month day-of-week`). The
//     `L` (last-day-of-month) extension is not portable across Convex
//     versions; the 28-31 range is the universal substitute.
//
// Timezone discipline:
//   - 20:00 UTC ↔ 04:00 Asia/Manila (UTC+8, no DST). The Manila day-
//     of-month shift means firing at 20:00 UTC on May 31 produces an
//     action invocation that sees Manila wall-clock = June 1. The
//     `getPriorPeriod(Date.now())` helper resolves to "2026-05" in
//     that case, which is the period we intend to archive.
//
// Manual replay path (documented in `docs/runbook.md`):
//   `npx convex run actions/archivalExport:monthlyArchivalExport`
//   or from the admin UI: `/admin/archival-exports` → "Re-run for
//   period" form. Both paths converge on the same internal action.
crons.cron(
  "monthly-archival-export",
  // 5-field cron expression: 20:00 UTC on days 28..31 of every
  // month (~ 04:00 Manila on the 1st of the following month).
  "0 20 28-31 * *",
  actionRef("actions/archivalExport:monthlyArchivalExport"),
);

// Story 6.4 — report-export retry + cleanup sweeps (FR46).
//
// `internal_retrySweep` runs every 5 minutes. It walks the
// `exports.by_status_requestedAt` index for rows stuck in
// `pending` / `failed` with `retryCount < 3` AND `requestedAt > now -
// 1h`, and reschedules the Node action for each. The per-row retry
// cap stops infinite retries; failed exports surface as a "Retry"
// affordance in the UI.
//
// `internal_cleanupSweep` runs daily at 04:00 Manila. It marks `ready`
// rows older than 30 days as `expired` and deletes the underlying
// blob. The export row PERSISTS — the audit trail of "Admin X
// exported Y on date Z" is itself a compliance artefact (NFR-S7 /
// NFR-C4).
//
// 20:00 UTC == 04:00 Asia/Manila (UTC+8, no DST). Sits after the
// 03:00 follow-up re-flag sweep and before the 09:30 email reminders;
// the load-bearing contract is hour-of-day separation, since Convex
// crons offer no cross-entry ordering guarantees.
//
// Manual replay paths (documented in `docs/runbook.md`):
//   `npx convex run exports:internal_retrySweep`
//   `npx convex run exports:internal_cleanupSweep`
crons.interval(
  "exports-retry-sweep",
  { minutes: 5 },
  mutationRef("exports:internal_retrySweep"),
);
crons.daily(
  "exports-cleanup-sweep",
  // 20:00 UTC == 04:00 Asia/Manila (UTC+8, no DST).
  { hourUTC: 20, minuteUTC: 0 },
  mutationRef("exports:internal_cleanupSweep"),
);

// Story 9.1 adversarial-review follow-up — login rate-limit cleanup
// sweep (NFR-S6).
//
// Deletes `authAttempts` rows older than 7 days. The retention window
// comfortably exceeds the longest policy window (1 hour lockout) plus
// the next-day forensic-review buffer staff may want when reviewing a
// suspicious sign-in incident.
//
// Runs at 05:00 Manila — sits AFTER the 04:00 exports-cleanup sweep
// and stays clear of the morning reminder scans (09:00 / 09:30). The
// load-bearing contract is hour-of-day separation; Convex crons do
// not provide cross-entry ordering guarantees.
//
// 21:00 UTC == 05:00 Asia/Manila (UTC+8, no DST). Same timezone
// discipline as the other registrations above.
//
// Manual replay path (documented in `docs/runbook.md` when the file
// reaches that section):
//   `npx convex run authRateLimit:internal_cleanupAuthAttempts`
crons.daily(
  "authAttemptsCleanup",
  // 21:00 UTC == 05:00 Asia/Manila (UTC+8, no DST).
  { hourUTC: 21, minuteUTC: 0 },
  mutationRef("authRateLimit:internal_cleanupAuthAttempts"),
);

// Epic-3/4 adversarial-review HIGH fix — PDF retry sweep (Stories
// 3.13 / 6.1 / 6.2).
//
// Three interval crons (one per PDF surface) walk the contract /
// demand-letter / receipt rows whose `*Status` is `pending` (action
// dropped before writeback) or `failed` (action threw and the
// failed-state callback patched the row), bump the per-row retry
// counter, and re-schedule the generation action. The per-row retry
// cap (3) lives in `convex/pdfRetrySweep.ts`; rows past the cap stay
// `failed` and the sweep skips them — operators retry manually via
// the public `generate*PdfRequest` mutations (which reset the
// counter to 0 when called with a fresh idempotency key).
//
// Cadence: every 10 minutes. PDF generation is operator-latency-
// sensitive (the staff member wants the download link within the
// same admin session); 10 minutes is the sweet spot between
// "recovers within the session for transient failures" and "doesn't
// stampede the action queue on a sustained outage."
//
// Manual replay paths (documented in `docs/runbook.md`):
//   `npx convex run pdfRetrySweep:internal_sweepContractPdfs`
//   `npx convex run pdfRetrySweep:internal_sweepDemandLetterPdfs`
//   `npx convex run pdfRetrySweep:internal_sweepReceiptPdfs`
crons.interval(
  "pdf-retry-sweep-contracts",
  { minutes: 10 },
  mutationRef("pdfRetrySweep:internal_sweepContractPdfs"),
);
crons.interval(
  "pdf-retry-sweep-demand-letters",
  { minutes: 10 },
  mutationRef("pdfRetrySweep:internal_sweepDemandLetterPdfs"),
);
crons.interval(
  "pdf-retry-sweep-receipts",
  { minutes: 10 },
  mutationRef("pdfRetrySweep:internal_sweepReceiptPdfs"),
);

// Story 6.8 — memorial plaque draft retry sweep.
//
// Same cadence + cap pattern as the contract / demand-letter / receipt
// sweeps above. Scans `plaqueDrafts.by_status` for `pending` / `failed`
// rows whose `retryCount < 3`, bumps the counter, then reschedules the
// renderer action. Past the cap rows stay `failed` and require an
// admin manual "Retry" click via the plaque-page draft-history rail.
crons.interval(
  "pdf-retry-sweep-plaque-drafts",
  { minutes: 10 },
  mutationRef("pdfRetrySweep:internal_sweepPlaqueDraftPdfs"),
);

/**
 * Deploy-time invariant: if this file successfully imports but the
 * `crons` registry is empty, surface a loud `console.error` so the
 * deployment defect is visible in `npx convex logs` (and Sentry, when
 * wired). A zero-cron deploy was the silent-failure mode the original
 * dynamic-require gate produced; this check is the belt-and-suspenders
 * tripwire that catches any future refactor that re-introduces a
 * similar gate.
 *
 * Exported so tests can assert "the registry has at least one entry"
 * without needing to spin up the full Convex runtime. See
 * `tests/unit/convex/crons.test.ts`.
 */
export function assertCronsRegistered(): { count: number; names: string[] } {
  // `Crons` exposes `crons` as a record-of-CronJob; cast to a typed
  // index signature so we can enumerate keys safely under the
  // `noUncheckedIndexedAccess` tsconfig flag.
  const registry = (crons as unknown as { crons: Record<string, unknown> })
    .crons;
  const names = Object.keys(registry);
  if (names.length === 0) {
    console.error(
      "[crons] 0 crons registered — this is a deployment defect. " +
        "Check `convex/crons.ts` for a guard that silently no-ops on " +
        "fresh checkouts (the original Story 4.1 defect).",
    );
  }
  return { count: names.length, names };
}

// Run the invariant once at module evaluation so any deploy that
// imports this file with an empty registry surfaces the error
// immediately. Tests import `assertCronsRegistered` to verify the
// count without depending on console output ordering.
assertCronsRegistered();

export default crons;
