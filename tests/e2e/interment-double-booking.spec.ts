/**
 * Story 7.2 — interment double-booking smoke spec.
 *
 * Until Convex test users + a seeded interment fixture land (Story 1.3
 * invitation flow + Story 1.13 deterministic seed), the authenticated
 * journey — "Office Staff opens the schedule form for a lot that
 * already has an interment in the conflict window, sees the warning
 * banner, attempts to submit, sees the INVARIANT_VIOLATION error" —
 * cannot run end-to-end. The full happy-path cross-tab spec is queued
 * for the next sprint with the test-user seed (matches the
 * `interment-schedule.spec.ts` deferral pattern from Story 7.1).
 *
 * What this spec locks in today:
 *   - `/interments/new` (the conflict-preview form host) redirects
 *     unauthenticated traffic to /login. Prevents an unauthed visitor
 *     from reaching the form via direct URL — the worst-case
 *     regression for the conflict guard.
 *   - The Story 7.2 server guard runs on `scheduleInterment`; route
 *     protection is the necessary precondition for the server check
 *     to be the source of truth.
 *
 * Phase-2-kickoff candidates (NOT in scope here):
 *   - Authenticated journey: seed a lot + an existing scheduled
 *     interment, then attempt a second schedule inside the ±60-min
 *     window and assert the banner + disabled submit + server error.
 *   - Admin override flow (when added): assert the override checkbox
 *     surfaces only for admins and records the override reason.
 */

import { test, expect } from "@playwright/test";

test.describe("interment double-booking — unauthenticated", () => {
  test("/interments/new redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/interments/new");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("/interments redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/interments");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});
