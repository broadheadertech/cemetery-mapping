/**
 * Story 7.3 — interment calendar smoke spec.
 *
 * Like the Story 7.1 / 7.2 specs, the full authenticated journey
 * (Office Staff opens /interments/calendar, sees scheduled events
 * land on the right day, drills in via a day cell) cannot run
 * end-to-end until Convex test users + seeded fixtures land
 * (Story 1.3 invitation flow + Story 1.13 deterministic seed). The
 * cross-tab reactive verification is queued for the kickoff sprint.
 *
 * What this spec locks in today:
 *   - `/interments/calendar` redirects unauthenticated traffic to /login.
 *
 * Route-protection coverage prevents the worst-case regression — an
 * unauthed visitor reaching the calendar via direct URL.
 */

import { test, expect } from "@playwright/test";

test.describe("interment calendar — unauthenticated", () => {
  test("/interments/calendar redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/interments/calendar");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});
