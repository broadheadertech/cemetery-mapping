/**
 * Story 3.3 — full-payment sale smoke spec.
 *
 * Mirrors `customer-create.spec.ts` / `interment-schedule.spec.ts`:
 * until Convex test users / fixtures are seeded (later Phase 1
 * follow-up), the full sale round-trip requires a signed-in
 * office_staff session. This spec covers the public-facing route
 * protection — `/sales`, `/sales/new`, and `/contracts/<id>` redirect
 * to /login when no session exists.
 *
 * The richer happy-path walk (seed admin + available lot + customer →
 * log in → navigate to /sales/new → fill form → review receipt →
 * confirm → assert /contracts/[id] header) lands once the seeded test
 * users infrastructure is in place.
 */

import { test, expect } from "@playwright/test";

test.describe("sales pages — unauthenticated", () => {
  test("/sales redirects unauthenticated users to /login", async ({ page }) => {
    await page.goto("/sales");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("/sales/new redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/sales/new");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("/contracts/<id> redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/contracts/contracts:fake");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});

// TODO (Story 3.x, once seeded test users land): expand to the full
// happy path — log in as office_staff, seed an `available` lot and a
// customer, navigate to /sales/new, pick lot + customer, review the
// receipt preview, click Generate & Print, assert the redirect URL
// pattern `/contracts/<contractId>` and the contract detail page's
// state pill reads "Paid in full". Once Story 3.11's PDF lands, also
// assert the receipt iframe renders.
