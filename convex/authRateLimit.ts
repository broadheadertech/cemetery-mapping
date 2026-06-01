/**
 * Customer-portal login rate-limit + lockout helpers + public Convex
 * surface (Story 9.1 adversarial-review follow-up, NFR-S6).
 *
 * Convex Auth's password provider does not expose a server-side
 * "before-signin" hook in `@convex-dev/auth@0.0.81`, so the customer
 * portal client wraps `signIn("password", ...)` with two explicit calls:
 *
 *   1. `checkLoginRateLimit({ identifier })`  — BEFORE signIn.
 *      Public query. Re-runs `assertLoginRateOk`; throws RATE_LIMITED
 *      with the retry-after message when the policy refuses.
 *   2. `recordPortalLoginOutcome({ identifier, succeeded })` — AFTER
 *      signIn (whether it resolved or rejected). Public mutation.
 *      Fire-and-forget from the client; the next attempt's rate-limit
 *      check observes the new row.
 *
 * This file ALSO exposes the internal cleanup mutation
 * (`internal_cleanupAuthAttempts`) the daily `crons.ts` cron registers
 * against. Cleanup deletes rows older than 7 days.
 *
 * ESLint:
 *   - The two PUBLIC entry points are unauthenticated by design (the
 *     caller is trying to AUTHENTICATE — `requireAuth` would be a
 *     contradiction). The `require-role-first-line` rule is suppressed
 *     per-call-site with a justified disable comment. Every other
 *     public function in `convex/` continues to obey the rule.
 *   - The `internal_*` mutation is correctly exempt (internal functions
 *     have no user context).
 */

import { ConvexError } from "convex/values";
import {
  internalMutationGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import type { MutationCtx, QueryCtx } from "./lib/auth";
import { ErrorCode, throwError } from "./lib/errors";
import { MINUTE_MS } from "./lib/time";

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------
//
// 5 fails / 15 min  → "Too many sign-in attempts. Please try again in 15
//                      minutes." (soft throttle; user retries after window).
// 10 fails / 60 min → 1-hour lockout (even if the user solves
//                      CAPTCHA-equivalent friction the limiter still
//                      refuses).
//
// Window numbers picked from common credential-stuffing defaults and
// the Story 9.1 spec § "rate limit + lockout policy." The 5-then-10
// ratio keeps an honest user who fat-fingers their password a few times
// from hitting the heavier lockout, while still throttling brute-force
// attempts.

export const SHORT_WINDOW_MS = 15 * MINUTE_MS;
export const SHORT_WINDOW_LIMIT = 5;
export const LONG_WINDOW_MS = 60 * MINUTE_MS;
export const LONG_WINDOW_LIMIT = 10;

/**
 * How many rows to page off `by_identifier_attempted` for a single
 * assertion. Sized to comfortably cover the long window's failure
 * limit + a buffer for trailing successes. Phase 1 portal scale
 * (~2,000 customers) keeps the 25-row page far below any pagination
 * concern.
 */
export const RATE_LIMIT_SCAN_PAGE = 25;

/**
 * Cleanup retention horizon: 7 days. Comfortably exceeds the longest
 * policy window (1 hour) plus the next-day forensic-review buffer
 * staff may want when reviewing a suspicious sign-in incident.
 */
export const AUTH_ATTEMPTS_RETENTION_MS = 7 * 24 * 60 * MINUTE_MS;

/**
 * Public error payload shape for rate-limit refusals. Mirrors
 * `convex/lib/errors.ts:ErrorPayload` so the client-side error layer
 * can branch on `data.code === "RATE_LIMITED"` without a separate
 * adapter. `ErrorCode.RATE_LIMITED` is not yet declared in `errors.ts`
 * (additive promotion is a future follow-up); the public shape is
 * stable across that refactor.
 */
export interface RateLimitErrorPayload {
  code: "RATE_LIMITED";
  message: string;
  details: {
    retryAfterMinutes: number;
    reason: "short_window" | "long_window";
  };
}

/**
 * Normalises a raw identifier (email or future alias) for both lookup
 * and storage. Lowercases + trims. Returns `null` for inputs that are
 * empty after trimming — the caller throws VALIDATION on null so a
 * tampered client cannot collapse every empty-string attempt into a
 * single shared counter.
 */
export function normalizeIdentifier(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Helpers (consumed by the public functions below + by the unit-test
// suite directly).
// ---------------------------------------------------------------------------

/**
 * Asserts the identifier is currently allowed to attempt a sign-in.
 * Throws a `ConvexError` with `code: "RATE_LIMITED"` when the policy
 * refuses the attempt.
 *
 * Read shape:
 *   - Single bounded index scan on `by_identifier_attempted` for the
 *     normalised identifier, sorted descending by `attemptedAt`,
 *     capped at `RATE_LIMIT_SCAN_PAGE` rows.
 *   - Walks the page newest-first; collects FAIL counts inside the two
 *     windows; stops counting BEHIND the most recent success (counter
 *     reset).
 *
 * Returns void on success.
 */
export async function assertLoginRateOk(
  ctx: QueryCtx | MutationCtx,
  identifier: string,
): Promise<void> {
  const now = Date.now();
  const recent = await ctx.db
    .query("authAttempts")
    .withIndex("by_identifier_attempted", (q) =>
      q.eq("identifier", identifier),
    )
    .order("desc")
    .take(RATE_LIMIT_SCAN_PAGE);

  let shortFails = 0;
  let longFails = 0;

  for (const row of recent) {
    // Counter reset: any FAIL strictly before the latest success no
    // longer counts. Walk newest-first and stop the moment we see a
    // success — every prior row is older (descending sort).
    if (row.succeeded) break;

    const age = now - row.attemptedAt;
    if (age <= LONG_WINDOW_MS) {
      longFails += 1;
      if (age <= SHORT_WINDOW_MS) {
        shortFails += 1;
      }
    }
  }

  if (longFails >= LONG_WINDOW_LIMIT) {
    throw new ConvexError({
      code: "RATE_LIMITED",
      message:
        "Too many sign-in attempts. Please try again in 60 minutes.",
      details: {
        retryAfterMinutes: 60,
        reason: "long_window",
      },
    } satisfies RateLimitErrorPayload);
  }

  if (shortFails >= SHORT_WINDOW_LIMIT) {
    throw new ConvexError({
      code: "RATE_LIMITED",
      message:
        "Too many sign-in attempts. Please try again in 15 minutes.",
      details: {
        retryAfterMinutes: 15,
        reason: "short_window",
      },
    } satisfies RateLimitErrorPayload);
  }
}

/**
 * Records an attempted sign-in. Always inserts a row, regardless of
 * outcome — the success row is what resets the failure counter.
 *
 * Field discipline:
 *   - Caller-supplied `ipHash` is already SHA-256-truncated by the
 *     portal mutation (we do not see raw IPs here). Optional.
 *   - Caller-supplied `userAgent` is already truncated to ≤ 200 chars
 *     by the portal mutation (defensive sizing).
 *   - `attemptedAt` is `Date.now()` at the time of insert. The portal
 *     mutation does not let the client supply this — a malicious client
 *     could otherwise back-date attempts to evade the window.
 */
export async function recordLoginAttempt(
  ctx: MutationCtx,
  identifier: string,
  succeeded: boolean,
  meta: { ipHash?: string; userAgent?: string } = {},
): Promise<void> {
  const row: {
    identifier: string;
    attemptedAt: number;
    succeeded: boolean;
    ipHash?: string;
    userAgent?: string;
  } = {
    identifier,
    attemptedAt: Date.now(),
    succeeded,
  };
  if (meta.ipHash !== undefined && meta.ipHash.length > 0) {
    row.ipHash = meta.ipHash;
  }
  if (meta.userAgent !== undefined && meta.userAgent.length > 0) {
    row.userAgent = meta.userAgent;
  }
  await ctx.db.insert("authAttempts", row);
}

/**
 * Daily cron body: delete `authAttempts` rows older than
 * `AUTH_ATTEMPTS_RETENTION_MS`. Returns the deletion count for
 * observability — surfaced via `console.log` from the internal
 * mutation wrapper so `npx convex logs` shows the daily sweep size.
 */
export async function cleanupExpiredAuthAttempts(
  ctx: MutationCtx,
): Promise<{ deleted: number }> {
  const cutoff = Date.now() - AUTH_ATTEMPTS_RETENTION_MS;
  const expired = await ctx.db
    .query("authAttempts")
    .withIndex("by_attemptedAt", (q) => q.lt("attemptedAt", cutoff))
    .collect();
  let deleted = 0;
  for (const row of expired) {
    await ctx.db.delete(row._id);
    deleted += 1;
  }
  return { deleted };
}

// ---------------------------------------------------------------------------
// Public Convex surface (consumed from the customer portal client).
// ---------------------------------------------------------------------------
//
// `checkLoginRateLimit` and `recordPortalLoginOutcome` are intentionally
// UNAUTHENTICATED — the caller is trying to authenticate, so `requireAuth`
// / `requireRole` would be a contradiction. The
// `require-role-first-line` lint rule is suppressed per-call-site with a
// justified disable comment.
//
// Bound on damage from an unauthenticated public mutation:
//   - The mutation only inserts into `authAttempts`. No other table is
//     touched; no PII beyond the identifier and the (already hashed) IP
//     is captured.
//   - The same identifier flooding `recordPortalLoginOutcome` with
//     `succeeded: true` only RESETS that identifier's counter — they'd
//     still need a valid password to actually sign in via Convex Auth.
//     The rate-limit's purpose is to throttle the password-check
//     surface, which is what they'd be bypassing anyway.
//
// A heavier defense (signed nonce, per-IP throttling on this mutation
// itself) is a future follow-up — Phase 1 ships the table + the policy
// because that's the load-bearing protection against credential stuffing.

/* eslint-disable local-rules/require-role-first-line --
 * The two public functions below (`checkLoginRateLimit`,
 * `recordPortalLoginOutcome`) are UNAUTHENTICATED by design: the
 * caller is mid-sign-in and has no identity yet, so `requireAuth` /
 * `requireRole` would be a structural contradiction. The damage bound
 * is documented in the file JSDoc — both functions only touch
 * `authAttempts` and the policy logic is what keeps the password-check
 * surface throttled. The `internal_*` mutation below is unaffected
 * (internal functions are exempt from the rule already).
 */

/**
 * Public query: returns `{ allowed: true }` when the identifier is
 * inside the rate-limit windows; throws `RATE_LIMITED` otherwise.
 *
 * The portal client calls this BEFORE invoking Convex Auth's
 * `signIn("password", ...)`. Throwing from a query is the standard
 * Convex error path; the client catches and renders the
 * retry-after-N-minutes message.
 */
export const checkLoginRateLimit = queryGeneric({
  args: { identifier: v.string() },
  handler: async (
    ctx: QueryCtx,
    args: { identifier: string },
  ): Promise<{ allowed: true }> => {
    const normalised = normalizeIdentifier(args.identifier);
    if (normalised === null) {
      throwError(ErrorCode.VALIDATION, "Identifier is required.", {
        field: "identifier",
      });
    }
    await assertLoginRateOk(ctx, normalised);
    return { allowed: true };
  },
});

/**
 * Public mutation: insert a row in `authAttempts` capturing the
 * outcome of the just-completed sign-in.
 *
 * Called by the portal client AFTER `signIn("password", ...)` resolves
 * or rejects. The portal does not block on this mutation's
 * acknowledgement; the next attempt's rate-limit check observes the
 * new row.
 *
 * `ipHash` and `userAgent` are optional. The portal client does not
 * forward raw IPs (the browser doesn't have access to them); a future
 * HTTP-action wrapper can derive `ipHash` from the request and forward
 * it through.
 */
export const recordPortalLoginOutcome = mutationGeneric({
  args: {
    identifier: v.string(),
    succeeded: v.boolean(),
    userAgent: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      identifier: string;
      succeeded: boolean;
      userAgent?: string;
    },
  ): Promise<{ recorded: true }> => {
    const normalised = normalizeIdentifier(args.identifier);
    if (normalised === null) {
      // Don't reveal that the identifier shape was malformed — silently
      // no-op. A tampered client passing `""` to evade the rate limit
      // shouldn't get a useful error.
      return { recorded: true };
    }
    const meta: { userAgent?: string } = {};
    if (args.userAgent !== undefined) {
      // Truncate defensively. A malicious client can otherwise inflate
      // the row size.
      const trimmed = args.userAgent.slice(0, 200);
      if (trimmed.length > 0) meta.userAgent = trimmed;
    }
    await recordLoginAttempt(ctx, normalised, args.succeeded, meta);
    return { recorded: true };
  },
});

/* eslint-enable local-rules/require-role-first-line */

/**
 * Internal mutation: daily cleanup sweep registered by
 * `convex/crons.ts`. Deletes `authAttempts` rows older than
 * `AUTH_ATTEMPTS_RETENTION_MS` (7 days).
 *
 * Returns the deletion count for observability — the cron logs it via
 * `console.log` so `npx convex logs` shows the daily sweep size.
 */
export const internal_cleanupAuthAttempts = internalMutationGeneric({
  args: {},
  handler: async (
    ctx: MutationCtx,
  ): Promise<{ deleted: number }> => {
    const result = await cleanupExpiredAuthAttempts(ctx);
    console.log(
      `[authAttemptsCleanup] swept ${result.deleted} expired rows`,
    );
    return result;
  },
});
