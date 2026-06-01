"use client";

/**
 * /portal/accept-invite/[token] — Story 9.1 portal-invite acceptance.
 *
 * Token-bearing URL the cemetery operator pastes into an SMS / email
 * to a new customer. The page:
 *
 *   1. Reads the `token` route param.
 *   2. Prompts the customer for a password (twice, with a min-length
 *      gate matching the server-side `MIN_PASSWORD_LENGTH = 8`).
 *   3. Calls `portalInvites:acceptPortalInvite` to create the auth
 *      account + grant the customer role + consume the invite.
 *   4. On success, signs the customer in via Convex Auth's password
 *      provider and routes to `/portal`.
 *
 * The accept-invite path is unauthenticated by design — the invite
 * token IS the authentication anchor. The (customer)/ layout renders
 * children unwrapped when there is no auth token; the middleware
 * matcher exempts `/portal/accept-invite/*` from the redirect-to-login
 * branch (see `src/middleware.ts`).
 *
 * Error UX: per existence-enumeration policy, the server returns a
 * single generic `"Invalid or expired invitation."` message for every
 * failure mode (unknown / expired / consumed / customer missing email
 * / account already exists / password too short). The page surfaces
 * that sentence verbatim — the operator can re-issue an invite from
 * the customer detail page if the customer reports the link doesn't
 * work.
 */

import { FormEvent, useId, useState } from "react";
import Image from "next/image";
import { useRouter, useParams } from "next/navigation";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvex } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";

const acceptPortalInviteRef = makeFunctionReference<
  "mutation",
  { token: string; password: string },
  { userId: string; email: string }
>("portalInvites:acceptPortalInvite");

const MIN_PASSWORD_LENGTH = 8;

export default function AcceptInvitePage() {
  const router = useRouter();
  const params = useParams<{ token: string }>();
  const { signIn } = useAuthActions();
  const convex = useConvex();

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const errorId = useId();

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const token = params?.token ?? "";
    if (!token || token.length < 8) {
      setError("Invalid or expired invitation.");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      );
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    let email: string | null = null;
    try {
      const result = await convex.mutation(acceptPortalInviteRef, {
        token,
        password,
      });
      email = result.email;
    } catch (err) {
      // The server returns a generic VALIDATION message for every
      // failure mode (existence-enumeration defence). Surface it
      // verbatim.
      if (err instanceof ConvexError) {
        const data = (err as ConvexError<{ message?: string }>).data;
        const message =
          (data && typeof data === "object" && typeof data.message === "string"
            ? data.message
            : null) ?? "Invalid or expired invitation.";
        setError(message);
      } else {
        setError("Invalid or expired invitation.");
      }
      setSubmitting(false);
      return;
    }

    // Auto-sign-in for a smooth onboarding flow. If the sign-in fails
    // (transient), redirect to the login page so the customer can sign
    // in manually with the password they just chose.
    if (email !== null) {
      try {
        await signIn("password", {
          email,
          password,
          flow: "signIn",
        });
        router.push("/portal");
        return;
      } catch {
        router.push("/portal/login");
        return;
      }
    }
    router.push("/portal/login");
  }

  return (
    <div className="bg-brand-cover -mx-4 -my-12 flex min-h-[80vh] items-center justify-center px-4 py-12 sm:-mx-6">
      <div className="w-full max-w-md rounded-md border border-surface-border bg-surface-base p-8 shadow-sm">
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
          <span
            aria-hidden="true"
            className="mt-4 block h-px w-24 bg-accent-gold"
          />
        </div>

        <h2 className="font-display text-xl font-medium text-text-default">
          Set your portal password
        </h2>
        <p className="mt-1 text-sm text-text-muted">
          Choose a password to activate your customer portal access.
        </p>

        <form
          onSubmit={handleSubmit}
          className="mt-6 space-y-4"
          aria-describedby={error ? errorId : undefined}
        >
          <div>
            <label
              htmlFor="accept-password"
              className="mb-1.5 block text-xs font-medium text-text-default"
            >
              Password{" "}
              <span className="text-destructive" aria-hidden="true">
                *
              </span>
            </label>
            <input
              id="accept-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="min-h-[48px] w-full rounded-md border border-surface-border bg-surface-base px-3 py-3 text-base text-text-default focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
              aria-required="true"
            />
            <p className="mt-1 text-xs text-text-muted">
              At least {MIN_PASSWORD_LENGTH} characters.
            </p>
          </div>

          <div>
            <label
              htmlFor="accept-confirm"
              className="mb-1.5 block text-xs font-medium text-text-default"
            >
              Confirm password{" "}
              <span className="text-destructive" aria-hidden="true">
                *
              </span>
            </label>
            <input
              id="accept-confirm"
              name="confirm"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="min-h-[48px] w-full rounded-md border border-surface-border bg-surface-base px-3 py-3 text-base text-text-default focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
              aria-required="true"
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
            {submitting ? "Activating…" : "Activate portal access"}
          </button>
        </form>

        <p className="mt-6 border-t border-surface-border pt-4 text-xs text-text-muted">
          Already have an account?{" "}
          <a href="/portal/login" className="underline">
            Sign in
          </a>
          .
        </p>
      </div>
    </div>
  );
}
