import {
  convexAuthNextjsMiddleware,
  createRouteMatcher,
  nextjsMiddlewareRedirect,
  convexAuthNextjsToken,
} from "@convex-dev/auth/nextjs/server";
import { fetchQuery } from "convex/nextjs";
import { makeFunctionReference } from "convex/server";

/**
 * Auth-gate middleware.
 *
 * Routes:
 *   - (public)/*    → /, /login — no auth required
 *   - (staff)/*     → /dashboard, /lots, /customers, /contracts,
 *                     /payments, /admin — authenticated staff
 *   - (customer)/*  → /portal/* — authenticated customer
 *
 * Story 1.1 established the basic /login ↔ /dashboard swap.
 * Story 1.5 added role-aware redirects for /admin/*, customer / staff
 * split on `/`, and an explicit matcher list aligned with the route
 * groups.
 *
 * Story 9.1 (this rewrite) adds the **customer / staff isolation
 * rules** the Phase 3 portal needs:
 *   - `/portal/login` is the customer-portal sign-in surface (separate
 *     from staff `/login`). Authenticated customers landing here are
 *     bounced to `/portal`; authenticated staff are bounced to
 *     `/dashboard` so staff never see the customer login chrome.
 *   - `/portal/*` (other than the login page) is customer-only.
 *     Authenticated staff visiting these paths are bounced to
 *     `/dashboard` (do not leak the portal's existence by serving
 *     it to staff).
 *   - Staff routes (`/dashboard`, `/lots`, `/customers`, …) are
 *     customer-forbidden. A customer who reaches one is bounced to
 *     `/portal`. The middleware is the first gate; per-handler
 *     `requireRole` in Convex remains the lock on the safe (NFR-S4).
 *
 * Defense in depth: the middleware is the front door. Server-side
 * `requireRole` (Story 1.2) is the lock on the safe. Both layers are
 * required by NFR-S4 — relying on the middleware alone would leave us
 * exposed if a future page is added without a role check on its
 * Convex calls.
 */

const isLoginRoute = createRouteMatcher(["/login", "/login/(.*)"]);
const isCustomerLoginRoute = createRouteMatcher([
  "/portal/login",
  "/portal/login/(.*)",
  // Story 9.1 portal-invite — accept-invite lands on a token-bearing
  // URL the operator pastes into an SMS/email; the visiting customer
  // is unauthenticated by definition. Treated like the login surface:
  // unauthenticated visits render the page; authenticated visitors
  // are redirected to /portal so they don't accidentally double-
  // accept against a stale invite tab.
  "/portal/accept-invite",
  "/portal/accept-invite/(.*)",
]);
const isAuthErrorRoute = createRouteMatcher(["/auth-error"]);
const isStaffRoute = createRouteMatcher([
  "/dashboard",
  "/dashboard/(.*)",
  "/lots",
  "/lots/(.*)",
  "/customers",
  "/customers/(.*)",
  "/contracts",
  "/contracts/(.*)",
  "/sales",
  "/sales/(.*)",
  "/payments",
  "/payments/(.*)",
  "/ar-aging",
  "/ar-aging/(.*)",
  "/expenses",
  "/expenses/(.*)",
  "/reports",
  "/reports/(.*)",
]);
const isAdminRoute = createRouteMatcher(["/admin", "/admin/(.*)"]);
const isCustomerRoute = createRouteMatcher(["/portal", "/portal/(.*)"]);

interface AuthUserDoc {
  email?: string;
  name?: string;
}

interface AuthPayload {
  userId: string;
  user: AuthUserDoc;
  roles: string[];
}

// Untyped function reference to dodge the `convex/_generated/api`
// dependency — the generated module only exists once the developer has
// run `npx convex dev` interactively. The reference shape and path
// match `convex/lib/auth.ts:getCurrentUserOrNull`.
const getCurrentUserOrNull = makeFunctionReference<
  "query",
  Record<string, never>,
  AuthPayload | null
>("lib/auth:getCurrentUserOrNull");

/**
 * Result of resolving the caller's roles in middleware.
 *
 * - `{ kind: "ok", roles }`     — fetch succeeded; the array may be empty
 *                                 (legitimate "no roles assigned" state).
 * - `{ kind: "anonymous" }`     — no auth token; the caller is not signed in.
 * - `{ kind: "fetch_failed" }`  — fetch threw (transient network, schema
 *                                 drift mid-deploy, Convex outage). The
 *                                 caller MUST distinguish this from
 *                                 "empty roles" because the former is a
 *                                 server-side failure (where collapsing
 *                                 customer roles to `[]` would mis-route
 *                                 a customer to `/dashboard`), while the
 *                                 latter is a legitimate not-yet-granted
 *                                 staff account.
 *
 * Epic 1 review HIGH-B fix: the previous implementation swallowed ALL
 * errors and returned `[]`. A transient role-fetch failure collapsed
 * customer roles too, so the "customer-only → /portal" rule fell
 * through and the customer landed on `/dashboard` (a staff URL). The
 * tri-state result makes the failure mode explicit so middleware can
 * route to a dedicated error surface instead.
 */
type RolesResult =
  | { kind: "ok"; roles: ReadonlyArray<string> }
  | { kind: "anonymous" }
  | { kind: "fetch_failed" };

async function fetchRoles(): Promise<RolesResult> {
  const token = await convexAuthNextjsToken();
  if (!token) return { kind: "anonymous" };
  try {
    const payload = await fetchQuery(getCurrentUserOrNull, {}, { token });
    // `payload === null` is a legitimate signed-out / deleted-user
    // state — treat it as "no roles" so the existing fall-through
    // logic applies; do NOT promote it to `fetch_failed`.
    return { kind: "ok", roles: payload?.roles ?? [] };
  } catch {
    // Transient network failure, schema drift mid-deploy, Convex
    // outage. We do NOT fall back to `[]` here — see RolesResult
    // docstring for the customer-leak rationale.
    return { kind: "fetch_failed" };
  }
}

function isCustomerOnlyRoles(roles: ReadonlyArray<string>): boolean {
  return roles.length > 0 && roles.every((r) => r === "customer");
}

/**
 * Marketing surface (the public-facing apostlepaul.ph site).
 *
 * Story 11.1 — split `/` and the brochure pages out of the auth gate.
 * Previously `/` always 30x-redirected based on auth; with the new
 * marketing site, anonymous visitors land on the brochure home and
 * staff/customers see the same site but with a "Sign in" CTA that
 * already knows where to send them. Authentication only kicks in
 * when they click into `/dashboard`, `/portal`, etc.
 *
 * Every path listed here is rendered by `src/app/(marketing)/...`.
 * The list is closed: any path not in this matcher (and not in a
 * staff/customer matcher above) still falls through the default
 * gate at the bottom of the middleware.
 */
const isMarketingRoute = createRouteMatcher([
  "/",
  "/about",
  "/services",
  "/pricing",
  "/find-a-grave",
  "/plan-ahead",
  "/resources",
  "/news",
  "/contact",
]);

export default convexAuthNextjsMiddleware(async (request, { convexAuth }) => {
  const authed = await convexAuth.isAuthenticated();

  // /auth-error is the dedicated surface for role-fetch failures
  // (RolesResult `fetch_failed`). Allow it through unconditionally —
  // redirecting it would re-enter the same failure branch.
  if (isAuthErrorRoute(request)) {
    return;
  }

  // Marketing brochure: public for everyone. We deliberately do NOT
  // redirect authenticated users away — they may want to read the
  // About page or pricing the same as anyone else; the in-nav
  // "Owner Portal" / "Dashboard" CTA is what carries them back into
  // the application.
  if (isMarketingRoute(request)) {
    return;
  }

  // Customer-portal login: separate from staff /login.
  //   - authenticated customer → /portal
  //   - authenticated staff    → /dashboard (don't render the customer
  //                              chrome for staff)
  //   - unauthenticated        → render the login page (no redirect)
  if (isCustomerLoginRoute(request)) {
    if (authed) {
      const result = await fetchRoles();
      if (result.kind === "fetch_failed") {
        return nextjsMiddlewareRedirect(request, "/auth-error");
      }
      const roles = result.kind === "ok" ? result.roles : [];
      return nextjsMiddlewareRedirect(
        request,
        isCustomerOnlyRoles(roles) ? "/portal" : "/dashboard",
      );
    }
    return; // render /portal/login
  }

  // Staff login (/login):
  //   - authenticated customer → /portal (customers don't sign in here)
  //   - authenticated staff    → /dashboard
  //   - unauthenticated        → render the login page
  if (isLoginRoute(request) && authed) {
    const result = await fetchRoles();
    if (result.kind === "fetch_failed") {
      return nextjsMiddlewareRedirect(request, "/auth-error");
    }
    const roles = result.kind === "ok" ? result.roles : [];
    return nextjsMiddlewareRedirect(
      request,
      isCustomerOnlyRoles(roles) ? "/portal" : "/dashboard",
    );
  }

  // Unauthenticated user hitting a staff path → /login.
  // Unauthenticated user hitting a customer path (not /portal/login,
  // handled above) → /portal/login.
  if (!authed) {
    if (isStaffRoute(request) || isAdminRoute(request)) {
      return nextjsMiddlewareRedirect(request, "/login");
    }
    if (isCustomerRoute(request)) {
      return nextjsMiddlewareRedirect(request, "/portal/login");
    }
    return;
  }

  // Authenticated from here.
  const result = await fetchRoles();
  if (result.kind === "fetch_failed") {
    // The role lookup itself failed (transient outage, etc.). We
    // cannot safely route — collapsing to `[]` here would mis-route a
    // customer to a staff URL (the original Story 1.5 bug). Send the
    // user to a dedicated error page that explains the situation and
    // offers a retry; the page itself is unauthenticated-safe.
    return nextjsMiddlewareRedirect(request, "/auth-error");
  }
  // `kind: "anonymous"` is unreachable here because `authed` is true,
  // but TypeScript can't see across `convexAuth.isAuthenticated()` so
  // we narrow explicitly. Treat "anonymous" as a degenerate empty
  // roles set so the existing fall-through routing applies.
  const roles = result.kind === "ok" ? result.roles : [];
  const customerOnly = isCustomerOnlyRoles(roles);

  // Customer-only user hitting any staff or admin path → /portal.
  // Hides the staff surface from customer accounts and prevents URL
  // probing.
  if (customerOnly && (isStaffRoute(request) || isAdminRoute(request))) {
    return nextjsMiddlewareRedirect(request, "/portal");
  }

  // Authenticated non-admin hitting /admin/* → /dashboard (don't leak
  // that the page exists to non-admins). Customer was already handled
  // above; this branch covers office_staff / field_worker.
  if (isAdminRoute(request) && !roles.includes("admin")) {
    return nextjsMiddlewareRedirect(request, "/dashboard");
  }

  // Authenticated staff (any non-customer role) hitting /portal/* →
  // /dashboard. Customers stay on /portal; staff never see the
  // customer chrome. This is the second leak-prevention rule for the
  // portal: if office_staff is curious about the portal's URL, they
  // get the staff dashboard instead of a half-rendered customer view.
  if (isCustomerRoute(request) && !customerOnly) {
    return nextjsMiddlewareRedirect(request, "/dashboard");
  }
});

export const config = {
  // Match everything except static assets, Next internals, and the
  // Story 1.4 visual-foundation dev page (which is intentionally
  // standalone and unauthenticated for inspecting tokens).
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|visual-foundation|.*\\.svg).*)",
  ],
};
