import { expect, type Page, test as base } from "@playwright/test";

/**
 * Signing in for the authenticated journeys.
 *
 * Most of this suite asserts the signed-out contract — which route
 * bounces to which sign-in — because when it was written there was no
 * way to become a user. Thirty-odd specs sat as `test.skip` stubs
 * "pending the test-user-seed story".
 *
 * That seed exists now (`convex/seed.ts`), so those journeys can run.
 * The cost of them not running was demonstrated in production: the
 * dashboard threw for every role except admin, and nothing here could
 * have noticed, because nothing here had ever been anyone.
 *
 * ## These need a deployment
 *
 * Unlike the signed-out specs, they talk to a real Convex backend that
 * has been seeded. Set `E2E_AUTH=1` to run them:
 *
 *     npx convex run seed:seedDemo      # once, on a demo deployment
 *     E2E_AUTH=1 npx playwright test
 *
 * Without it they skip, so a CI run with no seeded backend stays green
 * and honest rather than red for a reason that is not a defect. The
 * skip is loud in the report — it does not pretend to have run.
 *
 * NEVER point this at a deployment holding the cemetery's real records.
 * It signs in as the demo accounts, which must not exist there.
 */

/** Seeded demo logins. Password is shared; see `convex/seed.ts`. */
export const DEMO_PASSWORD = process.env.E2E_PASSWORD ?? "Demo!2026";

export const DEMO_USERS = {
  admin: process.env.E2E_ADMIN_EMAIL ?? "admin@apostlepaul.test",
  office: process.env.E2E_OFFICE_EMAIL ?? "office@apostlepaul.test",
  field: process.env.E2E_FIELD_EMAIL ?? "field@apostlepaul.test",
} as const;

export type DemoRole = keyof typeof DEMO_USERS;

/** Whether the authenticated journeys should run at all. */
export const authEnabled = process.env.E2E_AUTH === "1";

/**
 * Sign in through the real form — no cookie injection.
 *
 * The point of these tests is the whole path: middleware, the auth
 * provider, role resolution, and what the page then renders. Forging a
 * session would skip the part that broke.
 */
export async function signIn(page: Page, role: DemoRole): Promise<void> {
  await page.goto("/login");
  await page.fill("#email", DEMO_USERS[role]);
  await page.fill("#password", DEMO_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  // Landing anywhere off /login means the credentials took.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 45_000,
  });
}

/**
 * `test` for authenticated specs — skips the whole file when the
 * fixture is not enabled, so the reason is stated once.
 */
export const test = base.extend<{ signInAs: (role: DemoRole) => Promise<void> }>(
  {
    signInAs: async ({ page }, use) => {
      await use((role: DemoRole) => signIn(page, role));
    },
  },
);

/** Call at the top of an authenticated describe block. */
export function requireAuthFixture(): void {
  test.skip(
    !authEnabled,
    "Set E2E_AUTH=1 (and seed a demo deployment) to run the signed-in journeys.",
  );
}

export { expect };
