/**
 * Story 8.3 — lot navigate (Open in Maps) smoke spec.
 *
 * Until Convex test users + a deterministic seeded lot fixture exist,
 * the authenticated journey ("Junior opens /lots/<surveyed-lot>, taps
 * Open in Maps, the OS handler fires") cannot run end-to-end in
 * Playwright. Playwright also cannot drive `geo:` / `maps:` schemes
 * to a real native handler — that case is documented as a manual
 * mobile-device test in the runbook.
 *
 * What this spec locks in today:
 *   - `/lots/<anyId>` redirects unauthenticated traffic to /login (the
 *     button never renders to a guest, defending the coordinate
 *     surface at the routing layer).
 *
 * Full UI assertion ("button visible, disabled tooltip, click handoff")
 * is exhaustively covered by the component unit tests; this spec is
 * the deployment-level smoke gate.
 */

import { test, expect } from "@playwright/test";

test.describe("lot navigate — unauthenticated guard", () => {
  test("/lots/<id> redirects unauthenticated users to /login (navigate surface hidden)", async ({
    page,
  }) => {
    await page.goto("/lots/lot_navigate_smoke");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});
