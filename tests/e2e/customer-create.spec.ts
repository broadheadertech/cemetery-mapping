/**
 * Story 2.1 — customer-create smoke spec.
 *
 * Mirrors `lot-crud.spec.ts`: until Convex test users / fixtures
 * are seeded (later Phase 1 follow-up), the full create-with-real-
 * Convex round-trip requires a signed-in office_staff session. This
 * spec covers the public-facing route protection — `/customers/new`
 * and `/customers/<id>` redirect to /login when no session exists
 * — and asserts the URL pattern after successful submit will be
 * `/customers/<customerId>` (assertion noted in a TODO; the
 * detail page itself is a placeholder until Story 2.5).
 */

import { test, expect } from "@playwright/test";

test.describe("customer pages — unauthenticated", () => {
  test("/customers/new redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/customers/new");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("/customers/<id> placeholder redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/customers/customers:fakeid");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});

// TODO (Story 2.x, once seeded test users land): expand to the full
// happy path — log in as office_staff, navigate to /customers/new,
// fill all required fields including consent, submit, assert
// redirect URL pattern `/customers/<customerId>`. The detail page
// arrives in Story 2.5; this spec will then also assert the
// detail-page header.
