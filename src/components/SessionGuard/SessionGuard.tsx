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

import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
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

/**
 * Deliberate sign-out, as distinct from an expired one.
 *
 * Clicking "Sign out" tears down auth while the page is still mounted.
 * Every `useQuery` under it then rejects, and `useQuery` surfaces a
 * rejected query by THROWING during render — so the ordinary act of
 * logging out raced a tree full of live subscriptions and landed on
 * React's crash screen.
 *
 * Redirecting first does not fix it: `router.push` is asynchronous, and
 * the dashboard keeps rendering until the new route commits.
 *
 * The fix is to stop rendering the queries BEFORE clearing the session.
 * `beginSignOut()` swaps the whole guarded subtree for a message, which
 * unmounts every subscription synchronously; only then is `signOut()`
 * called. Nothing is left mounted to throw.
 */
interface SignOutControls {
  beginSignOut: () => void;
  signingOut: boolean;
}

const SignOutContext = createContext<SignOutControls>({
  beginSignOut: () => {},
  signingOut: false,
});

/**
 * Start a clean sign-out. Safe to call outside a guard — it degrades to
 * a no-op rather than throwing, so a component can use it without
 * knowing where it is mounted.
 */
export function useSignOut(): SignOutControls {
  return useContext(SignOutContext);
}

/**
 * Clears the session and leaves, once nothing is left rendering
 * queries.
 *
 * A hard navigation rather than `router.replace`: the whole point is
 * that no React tree survives the transition holding a stale token.
 */
function SigningOut({ signInPath }: { signInPath: string }): ReactNode {
  const { signOut } = useAuthActions();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        await signOut();
      } catch {
        // A failed sign-out leaves a token the next request rejects
        // anyway. Getting the person to the form matters more.
      }
      window.location.assign(signInPath);
    })();
  }, [signInPath, signOut]);

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="signing-out"
      className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <span className="h-8 w-8 animate-spin rounded-full border-2 border-surface-border border-t-primary" />
      <p className="font-display text-xl font-light text-text-default">
        Signing you out…
      </p>
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

/**
 * Wraps the error boundary with the deliberate-sign-out state.
 *
 * Two different situations that look the same to a user and must not be
 * conflated: a session that ran out (the boundary catches a rejected
 * query and says "your session has ended"), and a person choosing to
 * leave (nothing has gone wrong, and they should not be told it has).
 */
export function SessionGuard({
  children,
  signInPath = "/login",
}: SessionGuardProps): ReactNode {
  const [signingOut, setSigningOut] = useState(false);
  const beginSignOut = useCallback(() => setSigningOut(true), []);

  if (signingOut) return <SigningOut signInPath={signInPath} />;

  return (
    <SignOutContext.Provider value={{ beginSignOut, signingOut }}>
      <SessionExpiryBoundary signInPath={signInPath}>
        {children}
      </SessionExpiryBoundary>
    </SignOutContext.Provider>
  );
}

class SessionExpiryBoundary extends Component<
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
