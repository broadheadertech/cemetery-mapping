import { test, expect } from "@playwright/test";

/**
 * Story 1.13 — Field worker reads cached lot data offline.
 *
 * This spec exercises the production-only service worker path: it
 * requires `npm run build && npm run start`, which the existing
 * `playwright.config.ts` `webServer` block already provides.
 *
 * SKIPPED in this run: the spec needs a seeded Convex deployment with at
 * least one lot AND a logged-in office staff user. That harness lands
 * with Story 1.10 + the integration test runbook. The `test.describe.skip`
 * here keeps the file present so the configuration is greppable; a
 * follow-up story flips the skip to a regular `describe` once the auth
 * + seed fixtures are in place.
 *
 * Manual repro for now:
 *   1. `npm run build && npm run start`
 *   2. Open http://localhost:3000/lots in DevTools.
 *   3. Application → Service Workers → confirm "activated".
 *   4. Network tab → set to Offline.
 *   5. Reload /lots → cached HTML renders + amber pill appears.
 *   6. Try to retire a lot → "Posting requires connection" message.
 */

test.describe.skip("offline mode — field worker reads cached lot data", () => {
  test("serves cached /lots after going offline", async ({ page, context }) => {
    await page.goto("/lots");
    await expect(page.getByRole("heading", { name: "Lots" })).toBeVisible();

    // Visit a lot detail page to seed the per-lot cache.
    const firstLotLink = page.locator("a[href^='/lots/']").first();
    await firstLotLink.click();
    await page.waitForLoadState("networkidle");

    // Simulate offline.
    await context.setOffline(true);
    await page.goto("/lots");

    await expect(page.getByTestId("lots-offline-banner")).toBeVisible();
    await expect(page.getByTestId("cache-freshness-pill")).toBeVisible();

    // Retire mutation must be blocked.
    const retireButton = page.getByRole("button", { name: /retire/i }).first();
    await retireButton.click();
    // The page surfaces translateError's OFFLINE_WRITE_BLOCKED detail.
    await expect(
      page.getByText(/Posting requires connection|reconnect/i),
    ).toBeVisible();

    // Going back online clears the pill.
    await context.setOffline(false);
    await page.reload();
    await expect(page.getByTestId("lots-offline-banner")).toBeHidden();
  });

  test("dev mode does NOT register a service worker", async ({ page }) => {
    // Dev-mode assertion. Requires running against `next dev`.
    await page.goto("/lots");
    const controller = await page.evaluate(
      () => navigator.serviceWorker?.controller ?? null,
    );
    expect(controller).toBeNull();
  });
});
