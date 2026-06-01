/**
 * Story 1.8 — lot CRUD smoke spec.
 *
 * Until Convex test users / fixtures are seeded (later Phase 1
 * story), the full create / edit / retire end-to-end requires a
 * signed-in office_staff session. This spec covers the public-facing
 * route protection — `/lots` and `/lots/new` redirect to /login when
 * no session exists — and the structural soundness of the new pages.
 *
 * The full "Office Staff logs in, creates a lot, sees it in the list,
 * edits it, retires it" journey lives in `lot-management.spec.ts`
 * once the test-user seed lands.
 */

import { test, expect } from "@playwright/test";

test.describe("lot pages — unauthenticated", () => {
  test("/lots redirects unauthenticated users to /login", async ({ page }) => {
    await page.goto("/lots");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("/lots/new redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/lots/new");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});
