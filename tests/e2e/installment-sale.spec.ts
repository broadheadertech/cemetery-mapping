/**
 * Story 3.4 — installment-sale smoke spec.
 *
 * Mirrors `full-payment-sale.spec.ts`: until Convex test users +
 * fixtures are seeded (later Phase 1 follow-up), the full installment
 * round-trip requires a signed-in office_staff session. This spec
 * covers the route-level boundary — `/sales/new` (with the Installment
 * tab in scope) redirects to /login when no session exists.
 *
 * The richer happy-path walk (seed admin + available lot + customer →
 * log in → /sales/new → Installment tab → fill terms → live schedule
 * preview → review receipt → confirm → contract detail shows N
 * installments + down-payment receipt) lands once seeded test users
 * are in place. The TODO below tracks the follow-up.
 */

import { test, expect } from "@playwright/test";

test.describe("installment-sale page — unauthenticated", () => {
  test("/sales/new redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/sales/new");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});

// TODO (Story 3.x, once seeded test users land): expand to the full
// happy path — log in as office_staff, seed an `available` lot and a
// customer, navigate to /sales/new, switch to the Installment tab,
// fill in total price + down payment + term + first due date, verify
// the live `SchedulePreview` table updates as inputs change, review
// the receipt preview, click Generate & Print, assert the redirect
// URL pattern `/contracts/<contractId>` and the contract detail page
// renders the inserted installment rows.
