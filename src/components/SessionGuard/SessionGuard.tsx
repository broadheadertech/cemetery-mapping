"use client";

/**
 * Sends a signed-out user to the sign-in page instead of a crash screen.
 *
 * ## The problem
 *
 * Sessions expire on age — one hour for an admin, eight for office staff
 * and field workers (`SESSION_TIMEOUTS`). Once past it, every
 * `requireAuth` / `requireRole` query throws `SESSION_EXPIRED`. Convex's
 * `useQuery` surfaces a rejected query by THROWING during render, so
 * with nothing to catch it React tears the tree down and the person sees
 * "Application error: a client-side exception has occurred" — for the
 * entirely ordinary act of leaving a tab open over lunch.
 *
 * ## Why signing out first is not optional
 *
 * The obvious fix — redirect to `/login` — loops.
 *
 * Expiry is this application's own rule, layered on top of Convex Auth.
 * `getCurrentUserAndRoles`, which the server layout and the middleware
 * both rely on, checks only that a session ROW EXISTS; it does not apply
 * the age limit. So an expired-but-present session looks signed in to
 * the server and signed out to every query. Redirect to `/login` and the
 * middleware sends you straight back to `/dashboard`, whose queries
 * throw again.
 *
 * Clearing the session first is what breaks the cycle: after `signOut()`
 * the two views agree.
 *
 * ## What it does not do
 *
 * It does not swallow anything else. An error that is not an expired or
 * missing session is re-thrown on the next render, so real bugs still
 * reach the error surface rather than being quietly redirected away.
 */

import { Component, type ReactNode, useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuthActions } from "@convex-dev/auth/react";

import { extractErrorCode } from "@/lib/errors";

/** Codes that mean "this person needs to sign in again". */
const SIGNED_OUT_CODES = new Set(["SESSION_EXPIRED", "UNAUTHENTICATED"]);

export function isSignedOutError(error: unknown): boolean {
  const code = extractErrorCode(error);
  return code !== null && SIGNED_OUT_CODES.has(code);
}

/**
 * Clears the stale session and moves to the sign-in page.
 *
 * Split out from the boundary because an error boundary must be a class
 * component, and this needs hooks.
 */
function RedirectToSignIn({
  signInPath,
  reason,
}: {
  signInPath: string;
  reason: string;
}): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const { signOut } = useAuthActions();
  // React can render this twice; signing out twice would race.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const params = new URLSearchParams({ reason });
    // Bring them back to what they were looking at once they are in.
    if (pathname && pathname !== signInPath) params.set("next", pathname);
    const target = `${signInPath}?${params.toString()}`;

    void (async () => {
      try {
        await signOut();
      } catch {
        // Even if clearing the session fails, get them to the form —
        // stranding someone on a spinner is the worse outcome.
      }
      router.replace(target);
    })();
  }, [pathname, reason, router, signInPath, signOut]);

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="session-expired-redirect"
      className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <span className="h-8 w-8 animate-spin rounded-full border-2 border-surface-border border-t-primary" />
      <p className="font-display text-xl font-light text-text-default">
        Your session has ended.
      </p>
      <p className="text-sm text-text-muted">Taking you to the sign-in page…</p>
    </div>
  );
}

interface SessionGuardProps {
  children: ReactNode;
  /** Where this part of the app signs in. */
  signInPath?: string;
}

interface SessionGuardState {
  expired: boolean;
}

export class SessionGuard extends Component<
  SessionGuardProps,
  SessionGuardState
> {
  override state: SessionGuardState = { expired: false };

  static getDerivedStateFromError(error: unknown): SessionGuardState | null {
    // Only claim the errors this boundary exists for. Returning null
    // leaves the state untouched, so the error propagates to whatever
    // boundary is above and real failures stay visible.
    return isSignedOutError(error) ? { expired: true } : null;
  }

  override render(): ReactNode {
    if (this.state.expired) {
      return (
        <RedirectToSignIn
          signInPath={this.props.signInPath ?? "/login"}
          reason="expired"
        />
      );
    }
    return this.props.children;
  }
}
