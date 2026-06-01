"use client";

import { useState, FormEvent, useId } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvex } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";

/**
 * /portal/login — customer-portal sign-in page (Story 9.1, FR5).
 *
 * Distinct from staff `/login` (owned by Story 1.1) — the route group
 * separation is part of the architecture's
 * "(customer)/ + (staff)/ + (public)/" split.
 *
 * Apostle Paul brand application (Tier 1):
 *   - Ivory cover gradient background applied locally (the customer
 *     layout's logged-out fallback wraps this page in a plain ivory
 *     surface; we paint the ceremonial gradient inside the card hero).
 *   - Cormorant Garamond wordmark, Manrope body. Emerald primary
 *     button, emerald focus ring. Gold appears only as a hairline
 *     under the wordmark (rationed).
 *
 * UX rules applied (Story 9.1 AC2 + UX § Customer portal patterns):
 *   - Mobile-first: single-column, max-width ~28rem.
 *   - 48px touch targets (lg button per UX § customer-portal `lg`
 *     button spec).
 *   - Visible labels (no placeholder-as-label).
 *   - **No enumeration** (NFR-S1): one generic error sentence for
 *     "wrong email", "wrong password", "account doesn't exist",
 *     network failures, etc. NEVER reveal whether the email is
 *     registered.
 *   - Enter submits from any field; focus auto-lands on email.
 *
 * Rate-limit + lockout (Story 9.1 adversarial review #232, NFR-S6):
 *   - BEFORE calling `signIn`, the page asks Convex via
 *     `authRateLimit:checkLoginRateLimit` whether the (lowercased)
 *     email is currently allowed to attempt a sign-in. The server
 *     throws `RATE_LIMITED` with a `retryAfterMinutes` payload when
 *     the policy refuses; the page renders the retry-after message
 *     INSTEAD of the generic credential error so the customer sees
 *     why their attempt was refused.
 *   - AFTER `signIn` resolves (success or failure), the page records
 *     the outcome via `authRateLimit:recordPortalLoginOutcome`. The
 *     record path is fire-and-forget — the success/failure UI does
 *     not block on the acknowledgement (the next attempt's rate-limit
 *     check observes the new row).
 *   - The pre-check is intentionally OUTSIDE the password-check
 *     surface: we want to refuse the brute-force attempt before
 *     Convex Auth's password provider even fires, so even a known-bad
 *     password can't be guessed at rate.
 *
 * Auth provider: Convex Auth Password (shared with staff Story 1.1).
 * On success: redirect to `/portal`.
 */

type RateLimitErrorPayload = {
  code: "RATE_LIMITED";
  message: string;
  details: {
    retryAfterMinutes: number;
    reason: "short_window" | "long_window";
  };
};

const checkLoginRateLimitRef = makeFunctionReference<
  "query",
  { identifier: string },
  { allowed: true }
>("authRateLimit:checkLoginRateLimit");

const recordPortalLoginOutcomeRef = makeFunctionReference<
  "mutation",
  { identifier: string; succeeded: boolean; userAgent?: string },
  { recorded: true }
>("authRateLimit:recordPortalLoginOutcome");

/**
 * Best-effort extraction of a `RATE_LIMITED` payload from a thrown
 * value. Convex serialises thrown `ConvexError` payloads onto
 * `error.data`. We narrow on `code === "RATE_LIMITED"` to avoid
 * displaying any unrelated server-side validation message.
 */
function extractRateLimitMessage(thrown: unknown): string | null {
  if (!(thrown instanceof ConvexError)) return null;
  const data = (thrown as ConvexError<RateLimitErrorPayload>).data;
  if (!data || typeof data !== "object") return null;
  if ((data as { code?: string }).code !== "RATE_LIMITED") return null;
  const message = (data as { message?: string }).message;
  if (typeof message === "string" && message.length > 0) {
    return message;
  }
  // Defensive fallback if the message field is missing — the policy
  // copy still surfaces a useful sentence the customer can act on.
  return "Too many sign-in attempts. Please try again later.";
}

export default function CustomerLoginPage() {
  const router = useRouter();
  const { signIn } = useAuthActions();
  const convex = useConvex();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const errorId = useId();

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const identifier = email.trim().toLowerCase();
    const userAgent =
      typeof navigator !== "undefined" && typeof navigator.userAgent === "string"
        ? navigator.userAgent
        : undefined;

    // Step 1: rate-limit pre-check. Throws RATE_LIMITED when the
    // policy refuses. We surface the policy message verbatim (it
    // already carries the retry-after-N-minutes copy).
    try {
      await convex.query(checkLoginRateLimitRef, { identifier });
    } catch (err) {
      const rateLimitMessage = extractRateLimitMessage(err);
      if (rateLimitMessage !== null) {
        setError(rateLimitMessage);
        setSubmitting(false);
        return;
      }
      // Any other error from the pre-check (network, validation): fall
      // through to the generic error so we don't leak server internals
      // and don't deny a legitimate sign-in attempt just because the
      // pre-check experienced a transient failure. The actual signIn
      // call below will either succeed or fall into the same generic
      // error branch.
    }

    // Step 2: the actual sign-in.
    let succeeded = false;
    try {
      await signIn("password", {
        email,
        password,
        flow: "signIn",
      });
      succeeded = true;
    } catch {
      // Convex Auth throws on any failure (wrong creds, account
      // doesn't exist, weak password, network error). Per NFR-S1, the
      // customer-facing error message is generic and identical for
      // every cause — never reveal whether the email is registered.
      succeeded = false;
    }

    // Step 3: record the outcome regardless of result. Fire-and-forget
    // — the UI does not block on the acknowledgement. We swallow any
    // error from the recording mutation; failing to record an attempt
    // is strictly less bad than refusing a legitimate sign-in because
    // a side-channel failed.
    void convex
      .mutation(recordPortalLoginOutcomeRef, {
        identifier,
        succeeded,
        ...(userAgent !== undefined ? { userAgent } : {}),
      })
      .catch(() => {
        // Intentional swallow — see note above.
      });

    if (succeeded) {
      router.push("/portal");
    } else {
      setError("Incorrect email or password.");
      setSubmitting(false);
    }
  }

  return (
    <div className="bg-brand-cover -mx-4 -my-12 flex min-h-[80vh] items-center justify-center px-4 py-12 sm:-mx-6">
      <div className="w-full max-w-md rounded-md border border-surface-border bg-surface-base p-8 shadow-sm">
        {/* Brand lockup — identifies the institution before any
            operational copy. Centred to give the surface gravity. */}
        <div className="flex flex-col items-center pb-6">
          <Image
            src="/brand/mark.svg"
            alt=""
            width={72}
            height={72}
            priority
            aria-hidden="true"
            className="h-16 w-16"
          />
          <h1 className="mt-4 font-display text-2xl font-medium tracking-ceremonial text-primary">
            APOSTLE PAUL
          </h1>
          <p className="mt-1 font-display text-sm font-medium tracking-wide-mark text-support-forest">
            MEMORIAL PARK
          </p>
          <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.4em] text-support-moss">
            EST · ARINGAY · LA UNION
          </p>
          <span
            aria-hidden="true"
            className="mt-4 block h-px w-24 bg-accent-gold"
          />
        </div>

        <h2 className="font-display text-xl font-medium text-text-default">
          Customer portal
        </h2>
        <p className="mt-1 text-sm text-text-muted">
          Sign in to view your contracts and receipts.
        </p>

        <form
          onSubmit={handleSubmit}
          className="mt-6 space-y-4"
          aria-describedby={error ? errorId : undefined}
        >
          <div>
            <label
              htmlFor="customer-email"
              className="mb-1.5 block text-xs font-medium text-text-default"
            >
              Email{" "}
              <span className="text-destructive" aria-hidden="true">
                *
              </span>
              <span className="sr-only">required</span>
            </label>
            <input
              id="customer-email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="min-h-[48px] w-full rounded-md border border-surface-border bg-surface-base px-3 py-3 text-base text-text-default focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
              aria-required="true"
              aria-invalid={error ? true : undefined}
            />
          </div>

          <div>
            <label
              htmlFor="customer-password"
              className="mb-1.5 block text-xs font-medium text-text-default"
            >
              Password{" "}
              <span className="text-destructive" aria-hidden="true">
                *
              </span>
              <span className="sr-only">required</span>
            </label>
            <input
              id="customer-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="min-h-[48px] w-full rounded-md border border-surface-border bg-surface-base px-3 py-3 text-base text-text-default focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
              aria-required="true"
              aria-invalid={error ? true : undefined}
            />
          </div>

          {error && (
            <p id={errorId} role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="min-h-[48px] w-full rounded-md bg-primary px-5 py-3 text-base font-medium text-primary-fg hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-6 border-t border-surface-border pt-4 text-xs text-text-muted">
          Need access? Contact the estate office for an invitation.
        </p>

        <address className="mt-4 text-[11px] not-italic leading-relaxed text-text-muted">
          Apostle Paul Memorial Park · Cases Land Inc.
          <br />
          Zone 1, San Eugenio
          <br />
          Aringay, La Union 2503 · Philippines
        </address>
      </div>
    </div>
  );
}
