/**
 * Story 2.7 — ownership-transfer smoke spec.
 *
 * Mirrors `customer-create.spec.ts`: until Convex test users / fixtures
 * are seeded (later Phase 1 follow-up), the full record-transfer round
 * trip requires a signed-in office_staff session. This spec covers
 * route protection — `/customers/<id>/transfer` redirects to /login
 * when no session exists — which is the meaningful Phase-1 assertion
 * the test infrastructure can reach today.
 */

import { test, expect } from "@playwright/test";

test.describe("ownership-transfer page — unauthenticated", () => {
  test("/customers/<id>/transfer redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/customers/customers:fakeid/transfer");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});

// TODO (Story 2.x, once seeded test users + a seeded lot/customer pair
// land): expand to the full happy path — log in as office_staff,
// navigate to the customer-detail page, click "Transfer ownership",
// pick a destination customer + reason + effective date, click Review,
// click Confirm. Assert: ownership history list shows the new owner
// at the top with `effectiveTo` undefined and the previous owner with
// `effectiveTo` populated to today.
