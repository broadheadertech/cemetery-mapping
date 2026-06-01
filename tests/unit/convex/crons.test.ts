/**
 * Story 4.1 adversarial-review fix — `convex/crons.ts` unit tests.
 *
 * The original cron-registration body wrapped every `crons.daily(...)`
 * call inside a `try { require("./_generated/api") } catch {}` block.
 * On a fresh checkout (no codegen) the gate evaluated `false` and ALL
 * crons silently unregistered — the deploy succeeded with zero
 * scheduled functions and the runtime defect was invisible until the
 * next day's AR aging snapshot went stale.
 *
 * These tests pin the invariant that the file ALWAYS produces a non-
 * empty registry, regardless of whether `_generated/` exists. The
 * registration shape uses `makeFunctionReference` (string-path form)
 * instead of the dynamic-require gate; the function paths still
 * resolve at deploy time when Convex links them against the
 * deployment's function table.
 *
 * Mocking note: the file doesn't reach into `_generated/api` anymore,
 * so the only mock required is `convex/server`'s `cronJobs` factory
 * (we use the real factory — it's a pure in-memory record builder).
 */

import { describe, expect, it } from "vitest";

import crons, { assertCronsRegistered } from "../../../convex/crons";

describe("convex/crons.ts registry", () => {
  it("registers at least one cron at module-load time (non-empty registry)", () => {
    // `cronJobs()` exposes a `crons: Record<string, CronJob>` map; the
    // registry must have at least one entry for the deployment to do
    // anything useful overnight.
    const registry = (crons as unknown as { crons: Record<string, unknown> })
      .crons;
    const names = Object.keys(registry);
    expect(names.length).toBeGreaterThan(0);
  });

  it("registers every Story-promised cron name (no silent dropouts)", () => {
    const registry = (crons as unknown as { crons: Record<string, unknown> })
      .crons;
    const names = new Set(Object.keys(registry));
    // The contract list every deployed Convex environment MUST have —
    // each entry traces back to a story-level requirement (AR aging,
    // reconciliation, follow-up expiry, reminder dispatch, archival,
    // exports retry/cleanup, auth-attempts cleanup).
    const required = [
      "recompute-ar-aging",
      "daily-reconciliation-invariant",
      "reflag-expired-follow-up-actions",
      "send-reminders",
      // "send-email-reminders" retired at cut-over — the Phase 1
      // `emailReminderLog` stub was superseded by the `send-reminders`
      // cadence scan + `reminderDeliveries`/Resend pipeline.
      "monthly-archival-export",
      "exports-retry-sweep",
      "exports-cleanup-sweep",
      "authAttemptsCleanup",
    ];
    for (const name of required) {
      expect(names.has(name)).toBe(true);
    }
  });

  it("assertCronsRegistered returns the same count as the registry", () => {
    const result = assertCronsRegistered();
    const registry = (crons as unknown as { crons: Record<string, unknown> })
      .crons;
    expect(result.count).toBe(Object.keys(registry).length);
    expect(result.names).toEqual(Object.keys(registry));
  });
});
