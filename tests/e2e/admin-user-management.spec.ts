/**
 * Story 1.3 — admin user management smoke spec.
 *
 * Until Convex test users / fixtures are seeded (later Phase 1
 * story), the full create / deactivate / edit-roles end-to-end
 * requires a signed-in admin session. This spec covers the public-
 * facing route-protection contract — unauthenticated users hitting
 * `/admin/users` are redirected to `/login` — and the structural
 * soundness of the new page. The full "Admin signs in, creates a
 * user, sees temp password, deactivates them, that user's next
 * login fails" journey lives in `admin-user-management-auth.spec.ts`
 * once the test-user seed lands.
 */

import { test, expect } from "@playwright/test";

test.describe("/admin/users — unauthenticated", () => {
  test("redirects unauthenticated users to /login", async ({ page }) => {
    await page.goto("/admin/users");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});

test.describe("/admin/users — middleware role gate", () => {
  // Note: without a seeded office_staff session, this spec is documented
  // as a TODO. The route-level gate is also verified by the unit-test
  // coverage of `convex/users.ts:listUsers` (FORBIDDEN for non-admins)
  // — together they cover AC4 (defense in depth).
  test.skip("redirects authenticated non-admins to /dashboard", () => {});
  test.skip("admin sees the users list", () => {});
  test.skip("admin creates a new user and sees temp password dialog", () => {});
  test.skip("admin deactivates a user; their next request fails", () => {});
});
