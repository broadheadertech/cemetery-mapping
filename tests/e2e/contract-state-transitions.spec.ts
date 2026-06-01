/**
 * Story 3.6 — contract state machine transitions smoke spec.
 *
 * Mirrors `full-payment-sale.spec.ts` / `installment-sale.spec.ts`:
 * until Convex test users + fixtures are seeded (later Phase 1
 * follow-up), the admin-driven contract-state transition round trip
 * requires a signed-in admin session. This spec covers the public
 * route protection — the contract detail page and the admin-only
 * cancel / void / mark-default flows redirect to /login when no
 * session exists.
 *
 * The richer happy-path walk (seed admin + active contract → log in
 * → navigate to /contracts/[id] → open Cancel / Mark in default
 * dialog → enter a reason ≥ 5 chars → confirm → assert the contract
 * status pill flashes amber and updates to "Cancelled" / "In
 * default") lands once the seeded test users infrastructure is in
 * place. Story 3.7's broader void flow extends the UI surface; the
 * structural mutation `transitionState` from Story 3.6 is the
 * foundation those E2E flows ride on.
 */

import { test, expect } from "@playwright/test";

test.describe("contract state transitions — unauthenticated", () => {
  test("/contracts/<id> redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/contracts/contracts:any");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("/sales redirects unauthenticated users to /login (contract list view)", async ({
    page,
  }) => {
    await page.goto("/sales");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});

// TODO (Story 3.x, once seeded test users land): expand to the full
// admin transition path —
//   1. Log in as admin.
//   2. Seed an `active` contract (full-payment or installment).
//   3. Navigate to /contracts/[contractId].
//   4. Click "Mark in default" — assert the dialog appears with a
//      reason textarea + Confirm/Cancel buttons.
//   5. Submit with a 5-char reason — assert the dialog closes, the
//      contract state pill flashes amber (600ms ReactiveHighlight),
//      and the pill text reads "In default" with rose-50 background.
//   6. Verify the audit log has a `transition` row attributed to the
//      admin user with `before.state: "active"`, `after.state:
//      "in_default"`, and the typed reason.
//   7. Click "Cancel contract" — submit with a reason — assert the
//      pill flips to "Cancelled" and a second audit row lands.
//   8. As office_staff: the Mark-in-default and Cancel-contract
//      buttons must NOT be visible (admin-only).
//
// Once Story 3.7's broader void flow lands, that spec covers the
// lot reversion + ownership closure paths; this spec stays focused
// on the structural state-machine half (FR23).
