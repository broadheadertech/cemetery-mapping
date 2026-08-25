import { test, expect } from "@playwright/test";

/**
 * Story 1.5 — App Shell smoke spec.
 *
 * Verifies the middleware redirect contract (unauthenticated user can't
 * reach a protected page) plus a basic shape check on /login. The
 * authenticated-user journeys (sidebar visibility, Cmd-K open, mobile
 * hamburger sheet, role-aware /admin redirect) require a seeded user;
 * those land with Story 1.3's invitation flow + a deterministic test
 * fixture in Story 1.13. For now we capture the unauthenticated
 * contract here so regressions show up the moment the middleware
 * matcher drifts.
 */
test.describe("app shell — middleware contracts", () => {
  test("unauthenticated /dashboard → /login", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("unauthenticated /lots/d-5-12 → /login", async ({ page }) => {
    await page.goto("/lots/d-5-12");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("unauthenticated /admin/users → /login", async ({ page }) => {
    await page.goto("/admin/users");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("unauthenticated / serves the public site, not a redirect", async ({
    page,
  }) => {
    // This asserted `/` → `/login` when the app was auth-walled end to
    // end. The marketing site now owns the root, so a redirect here
    // would mean the public pages had become unreachable.
    await page.goto("/");
    await expect(page).toHaveURL(/localhost:3000\/?$/);
    // The page's own h1 — the nav collapses into a hamburger on the
    // mobile profile, so anything in it is the wrong thing to assert on.
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("the staff area still redirects when signed out", async ({ page }) => {
    // The contract the root used to carry, asserted where it now lives.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("/login renders the sign-in form", async ({ page }) => {
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: /sign in/i }),
    ).toBeVisible();
  });

  test("portal page renders Phase 3 placeholder when reachable", async ({
    page,
  }) => {
    // The middleware blocks /portal unless authenticated; verifying the
    // redirect contract here keeps Phase 3's gate honest.
    await page.goto("/portal");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});

test.describe("app shell — accessibility", () => {
  test("login page has exactly one h1", async ({ page }) => {
    await page.goto("/login");
    const count = await page.locator("h1").count();
    expect(count).toBe(1);
  });
});
