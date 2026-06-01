import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { fetchQuery } from "convex/nextjs";
import { makeFunctionReference } from "convex/server";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";

import { CustomerPortalSignOut } from "@/components/CustomerPortal/CustomerPortalSignOut";

/**
 * Customer route group layout (Story 9.1, FR5).
 *
 * Story 1.5 stubbed this layout so the middleware's `/portal/*` matcher
 * had a destination. Story 9.1 (this rewrite) wires:
 *
 *   1. Server-side auth gate — unauthenticated visitors and visitors
 *      to nested customer paths who aren't authenticated are redirected
 *      to the customer-portal login at `/portal/login`. Defense in
 *      depth: the middleware also blocks this path; the layout's check
 *      is the backup (NFR-S4).
 *
 *   2. Role-based redirect — staff users who land here (e.g. an admin
 *      who pasted a customer-portal URL) are pushed to `/dashboard`
 *      instead. Mixing chrome confuses users and would leak that the
 *      portal exists to non-customer staff. The middleware enforces
 *      this primarily; the layout is the second gate.
 *
 *   3. Minimum chrome — per UX § "customer portal primary: minimum
 *      chrome", we ship a small branded header (cemetery name +
 *      sign-out) and nothing else. No sidebar, no Cmd-K palette, no
 *      outdoor-mode toggle. The full mobile-first portal UI lands
 *      across Stories 9.2 – 9.6.
 *
 * The login page itself is nested under this layout group (it lives at
 * `src/app/(customer)/login/page.tsx` and renders at `/portal/login`).
 * The layout therefore must NOT redirect to `/portal/login` from
 * `/portal/login` itself — we detect that the request is for the
 * login page (no auth token required) and render `{children}` plain.
 *
 * Implementation note on the unauthenticated-on-login flow:
 *   Server components can't read `pathname` directly. Instead the
 *   layout checks for the token; when there is none we treat the
 *   request as the login flow (render children unauthenticated). The
 *   middleware ensures that the only customer-route a logged-out user
 *   can reach is `/portal/login`, so this fallback is safe.
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

export default async function CustomerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const token = await convexAuthNextjsToken();

  // Unauthenticated → render the login form unwrapped. The middleware
  // has already ensured that the only customer-group route an
  // unauthenticated request can reach is /portal/login.
  if (!token) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-surface-muted px-4 py-12">
        {children}
      </main>
    );
  }

  // Token present — resolve the user + roles. Token may be stale (the
  // server kept it but the session is gone server-side); a null
  // payload means "treat as unauthenticated".
  const payload = await fetchQuery(getCurrentUserOrNull, {}, { token });
  if (payload === null) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-surface-muted px-4 py-12">
        {children}
      </main>
    );
  }

  // Staff role hit a customer URL — bounce to the staff dashboard. We
  // do NOT render the customer chrome for staff (avoids cross-surface
  // confusion). An admin who genuinely needs to view the customer
  // portal as part of QA can sign out and re-sign in as a test
  // customer.
  const roles = payload.roles ?? [];
  const isCustomer = roles.includes("customer");
  if (!isCustomer) {
    redirect("/dashboard");
  }

  const displayName = payload.user.name ?? payload.user.email ?? "";

  return (
    <div className="min-h-screen bg-surface-muted">
      <header className="border-b border-accent-gold bg-surface-base">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <Link
            href="/portal"
            className="flex items-center gap-3 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
          >
            <Image
              src="/brand/mark.svg"
              alt=""
              width={32}
              height={32}
              priority
              aria-hidden="true"
              className="h-8 w-8 shrink-0"
            />
            <span className="flex min-w-0 flex-col leading-none">
              <span className="font-display text-[13px] font-medium tracking-ceremonial text-primary">
                APOSTLE PAUL
              </span>
              <span className="mt-1 font-display text-[10px] font-medium tracking-wide-mark text-support-forest">
                MEMORIAL PARK
              </span>
            </span>
          </Link>
          <CustomerPortalSignOut displayName={displayName} />
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>
    </div>
  );
}
