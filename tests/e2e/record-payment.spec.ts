/**
 * Story 3.9 — record-payment smoke spec.
 *
 * Mirrors `full-payment-sale.spec.ts` / `installment-sale.spec.ts`:
 * until Convex test users / fixtures are seeded (later Phase 1
 * follow-up), the full payment round-trip requires a signed-in
 * office_staff session. This spec covers the public-facing route
 * protection — `/payments/new` and `/payments/new?contractId=…`
 * redirect to /login when no session exists.
 *
 * The richer happy-path walk (seed admin + active installment contract
 * with overdue installment #3 → log in → navigate to
 * /payments/new?contractId=… → type "4000" → observe allocation
 * preview → "Review receipt" → "Generate & Print" → assert the
 * redirect URL pattern `/contracts/[contractId]`) lands once the
 * seeded test users + contract fixtures infrastructure is in place
 * (the same precondition Stories 3.3 and 3.4 carry).
 */

import { test, expect } from "@playwright/test";

test.describe("/payments/new — unauthenticated", () => {
  test("redirects unauthenticated users to /login when no contractId", async ({
    page,
  }) => {
    await page.goto("/payments/new");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("redirects unauthenticated users to /login with contractId", async ({
    page,
  }) => {
    await page.goto("/payments/new?contractId=contracts:fake");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});

// TODO (Story 3.x, once seeded test users + installment-contract
// fixtures land): expand to the full Journey 2 happy path.
//
//   1. Seed: an existing installment contract with 24 installments,
//      installment #3 overdue, #4 current.
//   2. Sign in as office_staff.
//   3. Navigate to /payments/new?contractId=<seeded>.
//   4. Type "4000" into the amount field.
//   5. Observe: AllocationPreview shows installment #3 will close.
//   6. Click "Review receipt"; observe the modal opens with the
//      receipt preview body visible.
//   7. Click "Generate & Print"; observe the modal closes and the URL
//      redirects to `/contracts/<seeded>`.
//   8. Assert NFR-P7: total time from page load to redirect < 90s in
//      the test environment (the real-world target is for the full
//      human-typing flow).
//
// Cross-tab reactive E2E (Story 3.9 Task 14) — two-context Playwright
// pattern — is best-effort and may be marked `.fixme` in CI to avoid
// flakiness; manual QA is the backup gate.
