/**
 * Story 2.6 — lot occupants smoke spec.
 *
 * Until Convex test users + a seeded lot fixture land (Story 1.3
 * invitation flow + Story 1.13 deterministic seed), the
 * authenticated journey — "Office Staff opens a lot, clicks 'Add
 * occupant', records Maria Santos with Date unknown, sees the new
 * row flash amber" — cannot run end-to-end. The full add-occupant
 * cross-tab spec is queued for the next sprint with the test-user
 * seed (matches Story 1.11's deferral pattern).
 *
 * What this spec locks in today:
 *   - `/lots/<id>` redirects unauthenticated traffic to /login
 *     (the panel lives on that page, so route protection covers it).
 *   - The page-level redirect contract is exercised for a path-like
 *     id so the dynamic [lotId] segment isn't accidentally
 *     unmatched by the middleware.
 */

import { test, expect } from "@playwright/test";

test.describe("lot occupants — unauthenticated", () => {
  test("/lots/<id> redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/lots/lot_with_occupants_abc");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("/lots/<id> with a path-like id still redirects", async ({ page }) => {
    await page.goto("/lots/D-5-12");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});
