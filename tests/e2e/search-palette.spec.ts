/**
 * Story 1.10 — Cmd-K search palette E2E smoke.
 *
 * Until Convex test users / fixtures are seeded (deferred Phase 1
 * story), the full "Office Staff logs in, types D-5, lands on the lot
 * detail" journey requires a signed-in session. This spec covers the
 * unauthenticated route-protection contract: navigating to any
 * `(staff)/*` URL without a session lands on `/login`, so the palette
 * is not even mounted. Once the test-user seed lands, this file will
 * extend with the full keystroke-to-navigation flow.
 *
 * The middleware contract here is the load-bearing assertion: if the
 * palette mounted on `/login`, an unauthenticated user could fire
 * `searchAll` against the public Convex client. The redirect proves
 * mount-gating works at the middleware layer.
 */

import { test, expect } from "@playwright/test";

test.describe("Cmd-K palette — unauthenticated contract", () => {
  test("unauthenticated /dashboard does not mount the palette", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login(\?|$)/);
    // The palette's command input carries `cmdk-input` per shadcn/ui.
    // It must not appear on /login.
    await expect(page.locator("[cmdk-input]")).toHaveCount(0);
  });

  test("unauthenticated /lots → /login regardless of Ctrl-K attempts", async ({
    page,
  }) => {
    await page.goto("/lots");
    await page.keyboard.press("Control+K");
    await expect(page).toHaveURL(/\/login(\?|$)/);
    await expect(page.locator("[cmdk-input]")).toHaveCount(0);
  });

  test("login page has no palette", async ({ page }) => {
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: /sign in/i }),
    ).toBeVisible();
    await expect(page.locator("[cmdk-input]")).toHaveCount(0);
  });
});
