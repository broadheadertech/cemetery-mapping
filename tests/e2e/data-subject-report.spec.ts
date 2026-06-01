/**
 * Story 2.4 — admin data-subject-report E2E smoke.
 *
 * Until seeded test users + a seeded test customer land in a later
 * Phase 1 story, this spec covers the public route-protection
 * contract — unauthenticated users hitting `/admin/data-subject-reports`
 * get redirected to `/login`. The full "admin signs in, searches for
 * Mrs. Cruz, types a reason, clicks Generate, sees the report, clicks
 * Download JSON" journey lives in `data-subject-report-auth.spec.ts`
 * once the test-user + test-customer seed lands.
 *
 * Server-side enforcement of the admin-only contract is covered by
 * `tests/unit/convex/dataSubject.test.ts` (FORBIDDEN for non-admins,
 * UNAUTHENTICATED for no session) — together with this spec they
 * cover AC1 (defense in depth).
 */

import { test, expect } from "@playwright/test";

test.describe("/admin/data-subject-reports — unauthenticated", () => {
  test("redirects unauthenticated users to /login", async ({ page }) => {
    await page.goto("/admin/data-subject-reports");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});

test.describe("/admin/data-subject-reports — middleware role gate", () => {
  // Without a seeded office_staff session, this spec is a TODO. The
  // server-side check is locked in unit tests; the middleware gate is
  // exercised by `app-shell.spec.ts` and `admin-user-management.spec.ts`
  // (same matcher block in `src/middleware.ts` covers both).
  test.skip("redirects authenticated non-admins to /dashboard", () => {});
  test.skip("admin searches by name, selects a customer, sees last-4 only", () => {});
  test.skip("admin types a reason, clicks Generate, sees the report", () => {});
  test.skip("clicking Download JSON downloads a JSON blob", () => {});
  test.skip("admin sees their report appear at the tail of customer audit trail", () => {});
});
