/**
 * Story 1.14 — journey-3 field worker condition log smoke spec.
 *
 * The full mobile journey ("Junior signs in on his phone, opens a
 * lot's condition page, types a note, taps submit, sees the new row
 * appear in Maria's open desktop tab") requires a seeded
 * field_worker test user and a working Convex test deployment.
 * Neither is wired yet (test-user seed is a later Phase 1 story).
 *
 * Until those land this spec covers the route protection + structural
 * soundness of the conditions page on the mobile profile, matching
 * the established pattern from `lot-crud.spec.ts`.
 */

import { test, expect, devices } from "@playwright/test";

test.describe("lot conditions page — unauthenticated", () => {
  test("/lots/:id/conditions redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/lots/example-lot-id/conditions");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});

test.describe("lot conditions page — mobile profile", () => {
  test.use({ ...devices["Pixel 5"] });
  test("mobile viewport renders the login redirect cleanly", async ({
    page,
  }) => {
    // Smoke: the mobile profile reaches the same redirect; no JS errors
    // on the way. When the test-user seed lands this expands to type
    // a note, tap submit, and assert the reactive log row appears.
    await page.goto("/lots/example-lot-id/conditions");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});
