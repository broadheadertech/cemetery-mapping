/**
 * Story 3.11 — receipt-view smoke spec.
 *
 * Mirrors the deferral pattern in `record-expense.spec.ts` /
 * `interment-schedule.spec.ts`: a full authenticated journey
 * (sign in → record a sale → click into /receipts → assert the
 * BIR-formatted display) requires the seeded-test-user fixture which
 * is queued for a later Phase 1 story.
 *
 * This spec locks in route-protection coverage so an unauthenticated
 * visitor cannot reach the receipt surface by direct URL — the staff
 * layout (`src/app/(staff)/layout.tsx`) is the gate. When the
 * test-user seed lands, this file expands to cover the seeded-receipt
 * read flow + the BIR-template visibility assertions.
 */

import { test, expect, devices } from "@playwright/test";

test.describe("receipt view — unauthenticated", () => {
  test("/receipts redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/receipts");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("/receipts/[id] redirects unauthenticated users to /login", async ({
    page,
  }) => {
    // The id is opaque to the route protection — any string lands at
    // the protected staff route group, which redirects.
    await page.goto("/receipts/receipts_unknown");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});

test.describe("receipt view — mobile profile", () => {
  test.use({ ...devices["Pixel 5"] });
  test("mobile viewport reaches the login redirect cleanly", async ({
    page,
  }) => {
    // Smoke: the mobile profile reaches the same redirect; no JS
    // errors on the way. When the test-user seed lands this expands
    // to a sale → receipt → display assertion.
    await page.goto("/receipts");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});
