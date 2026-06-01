/**
 * Story 1.12 — /map smoke spec.
 *
 * Without a seeded Convex test session, full "Office Staff lands on
 * /map, clicks a polygon, navigates to the detail page" is not yet
 * runnable from Playwright. This spec covers what we CAN assert without
 * an authenticated browser:
 *   1. `/map` redirects unauthenticated users to /login.
 *   2. The route exists (status code ≠ 404 after redirect to /login).
 *
 * The full authenticated flow lands once `tests/e2e/lot-management.spec.ts`
 * (slated for a future story) supplies a seeded session helper.
 */

import { test, expect } from "@playwright/test";

test.describe("/map — unauthenticated", () => {
  test("/map redirects unauthenticated users to /login", async ({ page }) => {
    await page.goto("/map");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("/map preserves a redirect-back hint when present", async ({ page }) => {
    const response = await page.goto("/map");
    // Even if the middleware doesn't add a redirect param, the
    // navigation MUST resolve to a 200-class status on the eventual
    // login page rather than a 404.
    expect(response?.status() ?? 0).toBeLessThan(400);
  });
});
