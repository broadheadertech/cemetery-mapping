/**
 * /auth-error — destination when the middleware's role-lookup
 * `fetchRoles()` returns `{ kind: "fetch_failed" }`.
 *
 * The previous Story 1.5 implementation swallowed all errors and
 * returned an empty role array, which collapsed a customer's roles too
 * — a transient failure mis-routed customers to `/dashboard` (a staff
 * URL). The middleware now distinguishes "fetch failed" from "no roles
 * assigned" and redirects to this page on failure (Epic 1 review
 * HIGH-B).
 *
 * The page is intentionally framework-only (no Convex calls, no auth
 * lookups) so it remains renderable even when Convex is unreachable.
 * The retry affordance is a plain anchor back to the user's intended
 * destination — typically /, which re-enters the middleware and
 * re-attempts the role lookup.
 */
import Link from "next/link";

export default function AuthErrorPage() {
  return (
    <main className="bg-brand-cover flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-md border border-surface-border bg-surface-base p-8 shadow-sm">
        <h1 className="font-display text-2xl text-ink-strong">
          We could not verify your access right now
        </h1>
        <p className="mt-4 text-ink-body">
          The system that confirms which areas you can use is temporarily
          unavailable. Your account and data are unaffected.
        </p>
        <p className="mt-3 text-ink-body">
          Please try again in a moment. If the problem persists, contact
          the cemetery office.
        </p>
        <div className="mt-6 flex gap-3">
          <Link
            href="/"
            className="inline-flex h-11 items-center rounded-md bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            Try again
          </Link>
          <Link
            href="/login"
            className="inline-flex h-11 items-center rounded-md border border-surface-border bg-surface-base px-4 text-sm font-medium text-ink-strong hover:bg-surface-muted focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            Sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
