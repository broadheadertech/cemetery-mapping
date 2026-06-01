import { test, expect } from "@playwright/test";

/**
 * Phase 1 Story 1.1 smoke spec.
 *
 * Verifies:
 *   - /login renders without throwing.
 *   - The form is visible with email + password fields.
 *   - Submitting invalid credentials shows the generic inline error
 *     ("Incorrect email or password") — never reveals whether the
 *     email exists (security requirement).
 *
 * Cross-browser + mobile + full Journey specs land in later stories.
 */
test.describe("login page — smoke", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
  });

  test("renders the sign-in form", async ({ page }) => {
    await expect(
      page.getByRole("heading", { name: /sign in/i }),
    ).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
  });

  test("invalid credentials show generic inline error", async ({ page }) => {
    await page.getByLabel(/email/i).fill("nonexistent@example.test");
    await page.getByLabel(/password/i).fill("wrong-password");
    await page.getByRole("button", { name: /sign in/i }).click();

    // Generic message — must NOT reveal whether the email exists.
    await expect(
      page.getByRole("alert").filter({ hasText: /incorrect email or password/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("email field is autofocused on load", async ({ page }) => {
    const emailField = page.getByLabel(/email/i);
    await expect(emailField).toBeFocused();
  });
});
