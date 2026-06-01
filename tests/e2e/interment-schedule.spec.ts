/**
 * Story 7.1 — interment scheduling smoke spec.
 *
 * Until Convex test users + a seeded lot fixture land (Story 1.3
 * invitation flow + Story 1.13 deterministic seed), the authenticated
 * journey — "Office Staff opens a lot, clicks 'Schedule interment',
 * fills the form, sees the new row appear on the lot detail card" —
 * cannot run end-to-end. The full happy-path cross-tab spec is queued
 * for the next sprint with the test-user seed (matches the
 * lot-occupants spec's deferral pattern).
 *
 * What this spec locks in today:
 *   - `/interments` redirects unauthenticated traffic to /login.
 *   - `/interments/new` redirects unauthenticated traffic to /login.
 *
 * Route-protection coverage prevents the worst-case regression — an
 * unauthed visitor reaching the form via direct URL.
 */

import { test, expect } from "@playwright/test";

test.describe("interment scheduling — unauthenticated", () => {
  test("/interments redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/interments");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("/interments/new redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/interments/new");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});
