/**
 * Story 7.4 — interment completion smoke spec.
 *
 * Until Convex test users + a seeded interment fixture land (Story
 * 1.3 invitation + Story 1.13 deterministic seed), the authenticated
 * burial-day journey — "Field worker opens /interments/today, taps
 * Mark complete, fills the sheet, sees the row drop off the list +
 * the office staff calendar flip colour" — cannot run end-to-end. The
 * full happy-path cross-tab spec is queued for the next sprint
 * (matches Story 7.1 / 7.2 / 7.3 deferral pattern).
 *
 * What this spec locks in today:
 *   - `/interments/today` redirects unauthenticated traffic to /login.
 *   - `/interments/[id]` redirects unauthenticated traffic to /login.
 *   - `/interments/[id]/complete` redirects unauthenticated traffic
 *     to /login.
 *
 * Route-protection coverage prevents the worst-case regression — an
 * unauthed visitor reaching the completion sheet via direct URL.
 */

import { test, expect } from "@playwright/test";

test.describe("interment completion — unauthenticated", () => {
  test("/interments/today redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/interments/today");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("/interments/<id> redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/interments/jzz-fake-id");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("/interments/<id>/complete redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/interments/jzz-fake-id/complete");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});
