/**
 * Story 1.11 — lot detail page smoke spec.
 *
 * Until Convex test users + a seeded lot fixture land (Story 1.3
 * invitation flow + Story 1.13 deterministic seed), the
 * authenticated journeys — "Office Staff navigates to /lots/<id>,
 * sees the full layout, opens Cmd-K, finds the lot in RECENT,
 * watches a cross-tab status change flash the StatusPill" — cannot
 * run end-to-end. The full cross-tab spec is queued for the next
 * sprint with the test-user seed.
 *
 * What this spec locks in today:
 *   - `/lots/<anyId>` redirects unauthenticated traffic to /login
 *     (defense-in-depth on top of the middleware).
 *   - The page-level redirect contract is exercised for a deeply
 *     nested id so the dynamic [lotId] segment isn't accidentally
 *     unmatched by the middleware.
 */

import { test, expect } from "@playwright/test";

test.describe("lot detail — unauthenticated", () => {
  test("/lots/<id> redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/lots/lot_abc123");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("/lots/<id> with a path-like id still redirects", async ({ page }) => {
    await page.goto("/lots/D-5-12");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});
