"use client";

import { useState, FormEvent, useId } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useAuthActions } from "@convex-dev/auth/react";

/**
 * /login — the system's only public surface in Phase 1 + 2.
 *
 * Supports both sign-in (returning user) and sign-up (first-admin
 * bootstrap). Story 1.3 will REMOVE the sign-up affordance — by then
 * an admin exists to issue invitations and self-signup is forbidden.
 *
 * Apostle Paul brand application (Tier 1):
 *   - Ivory page background (set on the public layout's gradient
 *     wrapper) + ivory-deep card surface for ceremonial weight.
 *   - Cormorant Garamond wordmark, Manrope body, JetBrains Mono
 *     eyebrow label.
 *   - Emerald primary button + emerald focus ring. Gold appears only
 *     as the masthead hairline (rationed).
 *
 * UX rules applied (story 1.1 ACs + UX § Form Patterns):
 *   - Label above field (no placeholder-as-label).
 *   - Required indicator is the asterisk + aria-required.
 *   - Inline error sentence ("Incorrect email or password") — never
 *     reveals whether the email exists.
 *   - 44+px touch targets on inputs and submit.
 *   - Enter submits from any field.
 *   - Focus auto-lands on email field.
 *   - aria-describedby links error to inputs for screen readers.
 */
export default function LoginPage() {
  const router = useRouter();
  const { signIn } = useAuthActions();
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const errorId = useId();

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await signIn("password", {
        email,
        password,
        flow: mode,
      });
      router.push("/dashboard");
    } catch {
      // Convex Auth throws on any failure (wrong creds, duplicate email,
      // weak password, network error, etc.). For security we surface the
      // same generic message on signIn regardless — never reveal whether
      // the email is registered. For signUp, give a slightly more useful
      // hint since the user IS trying to register an account.
      setError(
        mode === "signIn"
          ? "Incorrect email or password."
          : "Could not create account. The email may already be registered, or the password may not meet requirements.",
      );
      setSubmitting(false);
    }
  }

  return (
    <div className="w-full max-w-md rounded-md border border-surface-border bg-surface-base p-8 shadow-sm">
      {/* Brand lockup. The mark + wordmark identify the institution
          before any operational copy. Centred above the form so the
          login surface reads as a doorway rather than a tool. */}
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
        {mode === "signIn" ? "Sign in" : "Create first admin account"}
      </h2>
      <p className="mt-1 text-sm text-text-muted">
        Estate office — internal staff system
      </p>

      <form
        onSubmit={handleSubmit}
        className="mt-6 space-y-4"
        aria-describedby={error ? errorId : undefined}
        noValidate={false}
      >
        <div>
          <label
            htmlFor="email"
            className="mb-1.5 block text-xs font-medium text-text-default"
          >
            Email{" "}
            <span className="text-destructive" aria-hidden="true">
              *
            </span>
            <span className="sr-only">required</span>
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="min-h-[44px] w-full rounded-md border border-surface-border bg-surface-base px-3 py-3 text-base text-text-default focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
            aria-required="true"
            aria-invalid={error ? true : undefined}
          />
        </div>

        <div>
          <label
            htmlFor="password"
            className="mb-1.5 block text-xs font-medium text-text-default"
          >
            Password{" "}
            <span className="text-destructive" aria-hidden="true">
              *
            </span>
            <span className="sr-only">required</span>
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={
              mode === "signIn" ? "current-password" : "new-password"
            }
            required
            minLength={mode === "signUp" ? 8 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="min-h-[44px] w-full rounded-md border border-surface-border bg-surface-base px-3 py-3 text-base text-text-default focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
            aria-required="true"
            aria-invalid={error ? true : undefined}
          />
          {mode === "signUp" && (
            <p className="mt-1 text-xs text-text-muted">
              At least 8 characters.
            </p>
          )}
        </div>

        {error && (
          <p id={errorId} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="min-h-[44px] w-full rounded-md bg-primary px-5 py-2.5 text-base font-medium text-primary-fg hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting
            ? mode === "signIn"
              ? "Signing in…"
              : "Creating account…"
            : mode === "signIn"
              ? "Sign in"
              : "Create account"}
        </button>

        <div className="pt-2 text-center">
          {mode === "signIn" ? (
            <button
              type="button"
              onClick={() => {
                setMode("signUp");
                setError(null);
              }}
              className="rounded text-sm text-primary underline hover:text-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
            >
              First-time setup? Create the admin account
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setMode("signIn");
                setError(null);
              }}
              className="rounded text-sm text-primary underline hover:text-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
            >
              Already have an account? Sign in
            </button>
          )}
        </div>
      </form>

      {mode === "signUp" && (
        <p className="mt-6 border-t border-surface-border pt-4 text-xs text-text-muted">
          Story 1.3 will remove the self-signup option once admin-issued
          invitations are wired up. For now, use this to provision the
          first-admin account.
        </p>
      )}

      <address className="mt-6 border-t border-surface-border pt-4 text-[11px] not-italic leading-relaxed text-text-muted">
        Apostle Paul Memorial Park · Cases Land Inc.
        <br />
        Zone 1, San Eugenio
        <br />
        Aringay, La Union 2503 · Philippines
      </address>
    </div>
  );
}
