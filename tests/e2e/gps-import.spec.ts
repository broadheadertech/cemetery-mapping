/**
 * Story 8.1 — `/admin/gps-import` route-protection smoke spec.
 *
 * Until Convex test users / fixtures are seeded (later Phase 1 story),
 * the full upload → run → see-report end-to-end requires a signed-in
 * admin session. This spec covers the public-facing contract:
 *
 *   - Unauthenticated users hitting `/admin/gps-import` are redirected
 *     to `/login` (the same middleware gate that protects every other
 *     `/admin/*` route — see `admin-user-management.spec.ts` for the
 *     established convention).
 *
 *   - The signed-in-non-admin → /dashboard redirect, and the signed-in
 *     admin's full workflow (file upload, force toggle, result panel),
 *     live in `gps-import-auth.spec.ts` once the test-user seed lands.
 *
 * Defense in depth: the route gate is also enforced server-side by
 * `requireRole(["admin"])` inside `convex/gpsImport.ts:importGpsBatch`,
 * covered by the unit tests in `tests/unit/convex/gpsImport.test.ts`.
 */

import { test, expect } from "@playwright/test";

test.describe("/admin/gps-import — unauthenticated", () => {
  test("redirects unauthenticated users to /login", async ({ page }) => {
    await page.goto("/admin/gps-import");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});

test.describe("/admin/gps-import — middleware role gate", () => {
  // Same documented-TODO pattern as `admin-user-management.spec.ts` —
  // the full flow requires seeded admin / office-staff accounts.
  test.skip("redirects authenticated non-admins to /dashboard", () => {});
  test.skip("admin sees the GPS-import workflow", () => {});
  test.skip("admin uploads a valid GeoJSON batch and sees the result panel", () => {});
  test.skip("admin's force toggle propagates to the import call", () => {});
});
