/**
 * Story 4.7 — admin expense categories smoke spec.
 *
 * Authenticated journey (Admin creates "Insurance" via the dialog,
 * deactivates "Maintenance", verifies the office_staff dropdown no
 * longer offers the deactivated category, etc.) requires seeded test
 * users + a live Convex test deployment. Neither is wired yet
 * (test-user seed is a later Phase 1 story; matches the deferral
 * pattern in `record-expense.spec.ts` and `admin-user-management.spec.ts`).
 *
 * This spec locks in route-protection coverage so an unauthenticated
 * visitor cannot reach the admin page by direct URL. The full
 * create / deactivate / delete + cross-flow assertion is queued for
 * the next sprint with the test-user seed.
 */

import { test, expect } from "@playwright/test";

test.describe("/admin/expense-categories — unauthenticated", () => {
  test("redirects unauthenticated users to /login", async ({ page }) => {
    await page.goto("/admin/expense-categories");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});

test.describe("/admin/expense-categories — middleware role gate", () => {
  // The route-level gate is also verified by the unit-test coverage
  // of `convex/expenseCategories.ts` (FORBIDDEN for non-admins) —
  // together they cover defense in depth (NFR-S4).
  test.skip("redirects authenticated non-admins to /dashboard", () => {});
  test.skip("admin sees the categories list", () => {});
  test.skip(
    "admin creates 'Insurance' via dialog; row appears in the table",
    () => {},
  );
  test.skip(
    "admin deactivates 'Maintenance'; StatusPill flips; Delete is hidden",
    () => {},
  );
  test.skip(
    "after deactivation, ExpenseForm dropdown excludes the category; existing rows still display it",
    () => {},
  );
});
