/**
 * Story 2.5 — customer detail page smoke spec.
 *
 * Until Convex test users + a seeded customer fixture land (Story 1.3
 * invitation flow + seed customers in dev), the authenticated journey
 * — "Office Staff opens /customers/<id>, sees ownership history,
 * clicks Reveal, sees gov-ID for 30 s, auto-hides" — cannot run
 * end-to-end. That spec is queued for the next sprint with the
 * test-user seed.
 *
 * What this spec locks in today:
 *   - `/customers/<anyId>` redirects unauthenticated traffic to /login
 *     (defense-in-depth on top of the staff middleware).
 *   - The page-level redirect contract is exercised for a deeply
 *     nested id so the dynamic [customerId] segment isn't accidentally
 *     unmatched by the middleware.
 */

import { test, expect } from "@playwright/test";

test.describe("customer detail — unauthenticated", () => {
  test("/customers/<id> redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/customers/customers_abc123");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("/customers/<id> with a different-shaped id still redirects", async ({
    page,
  }) => {
    await page.goto("/customers/k57abc12345xyz");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});
