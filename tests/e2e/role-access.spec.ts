/**
 * What each signed-in role can actually reach.
 *
 * This is the gap that let a real bug through. The dashboard called
 * three admin-only queries, and because a rejected `useQuery` throws
 * during render rather than resolving to `undefined`, every office
 * staffer and field worker who signed in got an exception instead of a
 * dashboard. The suite could not have caught it: nothing here had ever
 * signed in as anyone.
 *
 * So these are not "does the page look right" tests. They are: does the
 * app work at all for someone who is not an administrator.
 *
 * Requires a seeded demo deployment — see `helpers/auth.ts`.
 */

import {
  expect,
  requireAuthFixture,
  test,
  type DemoRole,
} from "./helpers/auth";

/**
 * Run this file in one worker, in order.
 *
 * The three demo logins are shared accounts, and signing into the same
 * account from several browser contexts at once makes the sessions
 * fight — every one of these passes alone and all sixteen fail together
 * under the default `fullyParallel`. Per-role storage state reused
 * across workers would be the faster answer if this file grows; at
 * sixteen tests, serial costs about a minute and needs no machinery.
 */
test.describe.configure({ mode: "serial" });

/** Fail the test on any uncaught page error, not just a bad assertion. */
function watchForCrashes(page: import("@playwright/test").Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

/**
 * Open a page and let it settle before judging it.
 *
 * This matters more than it looks. A rejected Convex query rejects
 * asynchronously, so the page renders normally for an instant and only
 * then collapses into React's "Application error" fallback. Playwright's
 * web-first assertions retry until they PASS, so a naive
 * `expect(h1).toBeVisible()` catches that first instant and calls it a
 * success on a page that is about to break. This guard was written that
 * way first, and passed cheerfully against the very bug it exists to
 * catch — verified by rebuilding with the broken code.
 */
async function openSettled(
  page: import("@playwright/test").Page,
  route: string,
): Promise<void> {
  await page.goto(route, { waitUntil: "networkidle" });
  // Room for a late rejection to surface.
  await page.waitForTimeout(1200);
}

/** Assert the page is usable, not React's client-side crash fallback. */
async function expectNotCrashed(
  page: import("@playwright/test").Page,
): Promise<void> {
  await expect(
    page.getByText(/Application error/i),
    "the page fell back to React's client-side error screen",
  ).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

test.describe("every staff role can use the dashboard", () => {
  requireAuthFixture();

  for (const role of ["admin", "office", "field"] as DemoRole[]) {
    test(`${role} reaches /dashboard without an uncaught error`, async ({
      page,
      signInAs,
    }) => {
      const errors = watchForCrashes(page);
      await signInAs(role);

      await openSettled(page, "/dashboard");
      await expectNotCrashed(page);
      // Something that belongs to the dashboard, so a fallback that
      // happened to carry an h1 could not pass for the real page.
      await expect(page.getByTestId("dashboard-inventory-tiles")).toBeVisible();

      // The regression, stated plainly: a FORBIDDEN from a query the
      // page should never have issued used to land here.
      const forbidden = errors.filter((e) => /FORBIDDEN/i.test(e));
      expect(forbidden, forbidden.join("\n")).toEqual([]);
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }

  test("office staff see receivables but not the financial tiles", async ({
    page,
    signInAs,
  }) => {
    await signInAs("office");
    await openSettled(page, "/dashboard");
    await expectNotCrashed(page);

    await expect(page.getByTestId("dashboard-ar-aging")).toBeVisible();
    // Restricted, not perpetually loading — a skeleton that never
    // resolves reads as a broken page.
    await expect(
      page.getByTestId("dashboard-restricted-notice").first(),
    ).toBeVisible();
    await expect(page.getByTestId("dashboard-skeleton-card")).toHaveCount(0);
  });

  test("admins see the financial tiles", async ({ page, signInAs }) => {
    await signInAs("admin");
    await openSettled(page, "/dashboard");
    await expectNotCrashed(page);
    await expect(page.getByTestId("dashboard-money-tiles")).toBeVisible();
    await expect(
      page.getByTestId("dashboard-restricted-notice"),
    ).toHaveCount(0);
  });
});

test.describe("admin-only routes turn other roles away", () => {
  requireAuthFixture();

  // Each of these is gated by `isAdminRoute` in src/middleware.ts. A
  // non-admin should be redirected, never shown a broken page — the
  // failure mode we are guarding against is a route that renders and
  // then throws on its first privileged query.
  const adminRoutes = [
    "/admin",
    "/admin/users",
    "/admin/audit-log",
    "/admin/reconciliation",
    "/admin/settings/payment-gateways",
    "/reports",
    "/reports/exports",
  ];

  for (const route of adminRoutes) {
    test(`office staff are redirected away from ${route}`, async ({
      page,
      signInAs,
    }) => {
      const errors = watchForCrashes(page);
      await signInAs("office");
      await openSettled(page, route);

      await expect(page).not.toHaveURL(new RegExp(`${route}/?$`));
      await expectNotCrashed(page);
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }

  test("an admin reaches the admin hub", async ({ page, signInAs }) => {
    await signInAs("admin");
    await openSettled(page, "/admin");
    await expect(page).toHaveURL(/\/admin\/?$/);
    await expectNotCrashed(page);
  });
});

test.describe("the staff pages a field worker actually uses", () => {
  requireAuthFixture();

  for (const route of ["/lots", "/map", "/dashboard"]) {
    test(`field worker opens ${route} cleanly`, async ({ page, signInAs }) => {
      const errors = watchForCrashes(page);
      await signInAs("field");
      await openSettled(page, route);
      await expectNotCrashed(page);
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }
});

test.describe("the office desk flows", () => {
  requireAuthFixture();

  // Both of these call office-only queries. They are NOT admin routes,
  // so the middleware lets a field worker walk right in — which means
  // the page itself has to decide what to ask for. Get that wrong and
  // the render throws FORBIDDEN, exactly as /dashboard once did.
  const officeRoutes = [
    { route: "/interments/quick", denied: "quick-not-permitted" },
    { route: "/lots/suggest", denied: "suggest-not-permitted" },
  ];

  for (const { route, denied } of officeRoutes) {
    test(`office staff open ${route} cleanly`, async ({ page, signInAs }) => {
      const errors = watchForCrashes(page);
      await signInAs("office");
      await openSettled(page, route);
      await expectNotCrashed(page);
      await expect(page.getByTestId(denied)).toHaveCount(0);
      expect(errors, errors.join("\n")).toEqual([]);
    });

    test(`a field worker is told no on ${route}, not crashed`, async ({
      page,
      signInAs,
    }) => {
      const errors = watchForCrashes(page);
      await signInAs("field");
      await openSettled(page, route);
      await expectNotCrashed(page);
      // The distinction that matters: a sentence they can read, not
      // React's error screen.
      await expect(page.getByTestId(denied)).toBeVisible();
      const forbidden = errors.filter((e) => /FORBIDDEN/i.test(e));
      expect(forbidden, forbidden.join("\n")).toEqual([]);
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }
});

test.describe("office desk routes turn field workers away", () => {
  requireAuthFixture();

  /**
   * The sweep that found these: twenty-five staff pages called queries
   * gated `["admin", "office_staff"]`, nothing kept a field worker off
   * them, and a rejected `useQuery` throws during render. Each one was
   * the FORBIDDEN crash screen reported from a field account.
   *
   * They are gated in `isOfficeRoute` now. A redirect is the pass
   * condition — landing on the page at all means the gate is gone,
   * whether or not the page happens to render this second.
   */
  const officeRoutes = [
    "/customers",
    "/contracts",
    "/payments",
    "/receipts",
    "/ar-aging",
    "/expenses",
    "/family-estates",
    "/follow-ups",
    "/enquiries",
    "/sales",
    "/phase-planning",
    "/analytics",
    "/interments",
  ];

  for (const route of officeRoutes) {
    test(`a field worker is redirected off ${route}`, async ({
      page,
      signInAs,
    }) => {
      const errors = watchForCrashes(page);
      await signInAs("field");
      await openSettled(page, route);

      await expect(page).not.toHaveURL(new RegExp(`${route}/?$`));
      await expectNotCrashed(page);
      const forbidden = errors.filter((e) => /FORBIDDEN/i.test(e));
      expect(forbidden, forbidden.join("\n")).toEqual([]);
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }

  test("office staff still reach them", async ({ page, signInAs }) => {
    // The gate has to keep the right people IN. A rule that redirects
    // everyone passes every test above and breaks the cemetery.
    await signInAs("office");
    for (const route of ["/customers", "/payments"]) {
      await openSettled(page, route);
      await expect(page).toHaveURL(new RegExp(`${route}/?$`));
      await expectNotCrashed(page);
    }
  });

  test("a field worker keeps their own interment screens", async ({
    page,
    signInAs,
  }) => {
    // `/interments` is gated by exact path precisely so this branch
    // stays open. Sweeping the whole family would have taken away the
    // screen a field worker opens every morning.
    await signInAs("field");
    await openSettled(page, "/interments/today");
    await expect(page).toHaveURL(/\/interments\/today\/?$/);
    await expectNotCrashed(page);
  });
});
