/**
 * Story 9.1 — customer portal login smoke spec.
 *
 * Mirrors `admin-dashboard.spec.ts` and `customer-create.spec.ts`:
 * without seeded test users + a live Convex test deployment, the full
 * authenticated journey (sign in as a customer, land on /portal,
 * verify greeting renders the customer's name) cannot run. The
 * structural contract covered here is the middleware gate plus the
 * login-page render.
 *
 * Once Phase-3 customer seeding lands, this spec expands to:
 *   1. Visit /portal/login → fill credentials → submit → land on
 *      /portal → "Welcome, <name>" header visible.
 *   2. Reload /portal → still authenticated, same greeting.
 *   3. Click "Sign out" → land on /portal/login.
 *   4. Visit /dashboard while signed in as customer → redirected to
 *      /portal (staff routes are forbidden to customers).
 *   5. Mobile profile (Pixel 5): touch targets ≥ 48px on sign-in
 *      button and form inputs.
 */

import { test, expect, devices } from "@playwright/test";

test.describe("/portal/login — unauthenticated render", () => {
  test("renders the customer sign-in form", async ({ page }) => {
    await page.goto("/portal/login");
    await expect(
      page.getByRole("heading", { name: /customer portal/i }),
    ).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^sign in$/i }),
    ).toBeVisible();
  });

  test("email field is autofocused on load", async ({ page }) => {
    await page.goto("/portal/login");
    await expect(page.getByLabel(/email/i)).toBeFocused();
  });

  test("invalid credentials show the generic inline error", async ({ page }) => {
    await page.goto("/portal/login");
    await page.getByLabel(/email/i).fill("nobody@example.test");
    await page.getByLabel(/password/i).fill("wrong-password");
    await page.getByRole("button", { name: /^sign in$/i }).click();

    // NFR-S1: one generic sentence regardless of "no such email" vs
    // "wrong password". Must NEVER reveal whether the email is
    // registered.
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: /incorrect email or password/i }),
    ).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("/portal — route protection", () => {
  test("unauthenticated /portal redirects to /portal/login", async ({
    page,
  }) => {
    await page.goto("/portal");
    await expect(page).toHaveURL(/\/portal\/login(\?|$)/);
  });

  test("unauthenticated /portal/contracts redirects to /portal/login", async ({
    page,
  }) => {
    // Story 9.2 will introduce /portal/contracts; the middleware's
    // matcher already covers the customer-route prefix, so this URL
    // round-trips to login today.
    await page.goto("/portal/contracts");
    await expect(page).toHaveURL(/\/portal\/login(\?|$)/);
  });
});

test.describe("/portal/login — mobile profile", () => {
  test.use({ ...devices["Pixel 5"] });

  test("renders without horizontal overflow", async ({ page }) => {
    await page.goto("/portal/login");
    await expect(
      page.getByRole("heading", { name: /customer portal/i }),
    ).toBeVisible();

    // No horizontal scroll: the document scrollWidth shouldn't exceed
    // the viewport width by more than 1px (rounding).
    const overflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth -
        document.documentElement.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

// TODO (Phase 3 customer-seeding follow-up): expand to the full
// authenticated journey once test customers can be provisioned in CI.
// Cases to add:
//   - Sign in as a seeded customer → land on /portal → assert
//     "Welcome, <fullName>" h1.
//   - Reload → still authenticated.
//   - /dashboard while signed in as customer → redirected to /portal.
//   - Sign out → land on /portal/login.
