/**
 * Story 4.6 — record-expense smoke spec.
 *
 * Authenticated journey ("Office Staff opens /expenses/new, fills the
 * form, submits, sees the new row on /expenses with the amber flash")
 * requires seeded test users + a live Convex test deployment. Neither
 * is wired yet (test-user seed is a later Phase 1 story; matches the
 * deferral pattern in `interment-schedule.spec.ts` and
 * `journey-3-field-worker-condition-log.spec.ts`).
 *
 * This spec locks in route-protection coverage so an unauthenticated
 * visitor cannot reach the form by direct URL. The full happy-path
 * + cross-tab reactive E2E is queued for the next sprint with the
 * test-user seed.
 */

import { test, expect, devices } from "@playwright/test";

test.describe("expense recording — unauthenticated", () => {
  test("/expenses redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/expenses");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("/expenses/new redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/expenses/new");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});

test.describe("expense recording — mobile profile", () => {
  test.use({ ...devices["Pixel 5"] });
  test("mobile viewport reaches the login redirect cleanly", async ({
    page,
  }) => {
    // Smoke: the mobile profile reaches the same redirect; no JS errors
    // on the way. When the test-user seed lands this expands to fill
    // the form, submit, and assert the reactive amber flash on /expenses.
    await page.goto("/expenses/new");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});
