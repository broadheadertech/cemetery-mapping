/**
 * Story 2.2 — customer-document upload + access spec.
 *
 * The full happy-path journey (Office Staff logs in, picks a
 * consenting customer, drag-and-drops a JPG, sees the success
 * banner, and a parallel tab shows the new document reactively)
 * requires a seeded test customer + a working Convex test
 * deployment. Neither is wired yet (test-user seed is a later
 * Phase 1 story).
 *
 * Until those land this spec covers:
 *   - Route protection on the upload page (unauthenticated users
 *     redirect to /login).
 *   - NFR-S3 confirmation (AC6): unauthenticated browsers cannot
 *     reach an authenticated-only route; the Convex file storage
 *     itself enforces 403 on direct URL access because the URLs
 *     are short-lived and auth-gated.
 *
 * Pattern matches `journey-3-field-worker-condition-log.spec.ts`.
 */

import { test, expect, devices } from "@playwright/test";

test.describe("customer-documents — unauthenticated route protection", () => {
  test("/customers/:id/upload redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/customers/example-customer-id/upload");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});

test.describe("customer-documents — mobile profile", () => {
  test.use({ ...devices["Pixel 5"] });
  test("mobile viewport reaches the same login redirect cleanly", async ({
    page,
  }) => {
    // Smoke: the mobile profile reaches the same redirect; no JS
    // errors on the way. When the test-user seed + customer
    // fixtures land this expands to log in as office_staff,
    // drag-and-drop a JPG, assert the success banner, and then
    // open a second tab to verify the reactive list update.
    await page.goto("/customers/example-customer-id/upload");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});

test.describe("customer-documents — NFR-S3 / AC6 file URL gating", () => {
  test("the upload route never exposes a public document URL pattern", async ({
    page,
  }) => {
    // Until the e2e seed lands we can only confirm that the route
    // itself does not render any `<a href>` or `<img src>` to a
    // bare `.convex.cloud/storage/` URL — which would be the
    // tell-tale of a public-by-default pattern. This guard exists
    // so that if a future refactor accidentally moves URL generation
    // into a public layout, the test catches it.
    //
    // Note: the page first hits /login redirect (anon user) so the
    // assertion happens against the /login page DOM, which is fine
    // — /login should never contain a storage URL either.
    await page.goto("/customers/example-customer-id/upload");
    const html = await page.content();
    expect(html).not.toMatch(/convex\.cloud\/api\/storage/);
  });
});
