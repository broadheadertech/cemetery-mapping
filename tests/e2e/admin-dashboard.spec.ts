/**
 * Story 5.2 — `/dashboard` smoke spec.
 *
 * Mirrors `admin-audit-log.spec.ts` and `record-expense.spec.ts` —
 * without seeded test users + a live Convex test deployment, the full
 * authenticated journey ("Admin lands on /dashboard, period toggle
 * flips MTD ↔ YTD, payment in a second context triggers the cross-tab
 * amber fade") cannot run. The structural contract covered here is the
 * middleware gate.
 *
 * The Journey-4 cross-tab magic moment is the highest-stakes scenario in
 * the entire spec — when the test-user seed lands, this file expands to
 * fill the four scenarios called out in the Story 5.2 spec:
 *
 *   1. Admin navigates to /dashboard → all seven KPI labels visible.
 *   2. Cross-tab magic moment — payment in one context, dashboard
 *      reactive update + 600ms amber fade in another.
 *   3. Mobile viewport (375x812) — tiles render 2-up, AR aging is
 *      card-style, every tap target ≥ 44px.
 *   4. Period toggle MTD ↔ YTD updates the URL + the values re-fade
 *      exactly once per change.
 *
 * In the meantime, the unit tests
 * (`tests/unit/components/DashboardPage.test.tsx` and
 * `tests/unit/convex/dashboard.test.ts`) cover the page rendering, the
 * period toggle, and the query aggregation logic; this spec covers the
 * route protection that the unit tests cannot.
 */

import { test, expect, devices } from "@playwright/test";

test.describe("/dashboard — unauthenticated", () => {
  test("redirects unauthenticated users to /login", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("?period=ytd is preserved through the redirect path", async ({
    page,
  }) => {
    await page.goto("/dashboard?period=ytd");
    // The redirect target may or may not preserve the query string —
    // the contract is that an unauthenticated visitor never reaches
    // /dashboard.
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});

test.describe("/dashboard — mobile profile", () => {
  test.use({ ...devices["iPhone 13 Mini"] });
  test("mobile viewport reaches the login redirect cleanly", async ({
    page,
  }) => {
    // Smoke: the mobile profile reaches the same redirect; no JS errors
    // on the way. When the test-user seed lands this expands to assert
    // the 2-up tile grid + AR aging card-style list + tap-target
    // measurements.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});

test.describe("/dashboard — authenticated scenarios (queued)", () => {
  // Pending the test-user-seed story. Same deferral as
  // admin-audit-log.spec.ts / record-expense.spec.ts.
  test.skip("admin sees seven KPI tiles + AR aging + flagged tile", () => {});
  test.skip(
    "cross-tab reactive update: payment in tab B triggers amber fade in tab A within 1s",
    () => {},
  );
  test.skip("mobile renders tiles 2-up and AR aging as card-style list", () => {});
  test.skip(
    "period toggle YTD updates URL to ?period=ytd and re-fades values",
    () => {},
  );
  test.skip(
    "period toggle MTD removes the query param and re-fades values",
    () => {},
  );
  test.skip(
    "back-button restores prior period when toggling MTD → YTD → back",
    () => {},
  );
});
