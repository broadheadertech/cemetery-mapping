/**
 * Story 6.5 — `/admin/audit-log` smoke spec.
 *
 * Mirrors `admin-user-management.spec.ts` — without a seeded admin
 * session, the live end-to-end (apply filters, paginate, navigate to
 * entity detail page) cannot run. The structural contract covered
 * here is the route's middleware gate: an unauthenticated visitor
 * lands at /login. The full role / data flow ships once test-user
 * seeding lands.
 *
 * The role-gate defense in depth is also covered by:
 *   - `tests/unit/convex/auditLogQueries.test.ts` (FORBIDDEN for
 *     office_staff / field_worker / customer).
 *   - `src/middleware.ts` (Story 1.5) — redirects non-admins from
 *     /admin/* to /dashboard.
 */

import { test, expect } from "@playwright/test";

test.describe("/admin/audit-log — unauthenticated", () => {
  test("redirects unauthenticated users to /login", async ({ page }) => {
    await page.goto("/admin/audit-log");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});

test.describe("/admin/audit-log — middleware role gate", () => {
  // Pending the test-user-seed story (same gating as the user-management
  // spec).  These remain TODOs so the structural test plan is visible.
  test.skip("redirects authenticated non-admins to /dashboard", () => {});
  test.skip("admin sees the audit log table with paginated rows", () => {});
  test.skip("admin applies an entity filter and the table re-queries", () => {});
  test.skip("admin clicks an entity id and is routed to the detail page", () => {});
  test.skip("admin pages forward and back through cursor pagination", () => {});
});
