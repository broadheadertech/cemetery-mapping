import { redirect } from "next/navigation";
import { fetchQuery } from "convex/nextjs";
import { makeFunctionReference } from "convex/server";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";

import { CustomerPortalGreeting } from "@/components/CustomerPortal";

/**
 * Customer portal landing (Story 9.1, FR5).
 *
 * The first page a customer sees after signing in. Story 9.1 ships the
 * authenticated-and-greeted experience; Stories 9.2 – 9.6 progressively
 * fill in the contracts list, receipts, payments, and contact-info
 * surfaces inside this same page.
 *
 * Server-side responsibilities here:
 *
 *   1. Defense-in-depth auth check — the (customer) layout has already
 *      verified the token + role, but this page re-runs the cheap
 *      `convexAuthNextjsToken()` check so a future layout refactor
 *      can't accidentally reach an unauthenticated page render.
 *   2. Pass a server-resolved fallback name into the client greeting
 *      so the page never flashes "Welcome" before hydration.
 *
 * The page hosts the `<h1>` directly (per the
 * `local-rules/single-h1-per-page` lint rule, which scans this file
 * and does not traverse into imported components). The reactive
 * sub-content (greeting body + contracts placeholder) lives in
 * `CustomerPortalGreeting`.
 */

interface AuthUserDoc {
  email?: string;
  name?: string;
}

interface AuthPayload {
  userId: string;
  user: AuthUserDoc;
  roles: string[];
}

const getCurrentUserOrNull = makeFunctionReference<
  "query",
  Record<string, never>,
  AuthPayload | null
>("lib/auth:getCurrentUserOrNull");

export default async function CustomerPortalPage() {
  const token = await convexAuthNextjsToken();
  if (!token) {
    redirect("/portal/login");
  }

  const payload = await fetchQuery(getCurrentUserOrNull, {}, { token });
  if (payload === null) {
    redirect("/portal/login");
  }

  const fallbackName = payload.user.name ?? payload.user.email ?? "";

  return (
    <section
      aria-labelledby="customer-portal-heading"
      className="rounded-md border border-surface-border bg-surface-base p-6 shadow-sm"
    >
      <h1
        id="customer-portal-heading"
        className="text-2xl font-semibold tracking-tight text-text-default"
      >
        In remembrance{fallbackName ? `, ${fallbackName}` : ""}
      </h1>
      <CustomerPortalGreeting fallbackName={fallbackName} />
    </section>
  );
}
