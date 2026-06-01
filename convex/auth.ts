import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";

/**
 * Convex Auth wiring for cemetery-mapping.
 *
 * Phase 1 Story 1.1: Password provider only.
 *   - Email verification disabled (no email provider configured yet).
 *   - Password reset deferred to a follow-up story.
 *   - No Google OAuth in Story 1.1 — can be added later by appending
 *     to the `providers` array.
 *
 * Story 1.2 introduced the `userRoles` table joined to `users` and
 * the `requireRole` cornerstone. Without ANY rows in `userRoles`, the
 * first signed-up account is role-less — `requireAuth` throws
 * `INVALID_ROLE` and the user can never reach `/dashboard`. That
 * violates Story 1.1 AC2 ("self-signup bootstraps a working admin").
 *
 * The `afterUserCreatedOrUpdated` callback below is the auto-bootstrap
 * fix (Epic 1 HIGH-A review finding). When a brand-new user lands and
 * the system has zero `userRoles` rows, we promote them to `admin`.
 * Every subsequent sign-up runs the same callback but the count check
 * short-circuits — no further auto-promotions.
 *
 * Why "zero rows" and not "first user record": multiple `users` rows
 * could exist with zero roles (e.g. an earlier signup that errored
 * mid-flow before the audit fence). Anchoring the check to `userRoles`
 * count = 0 captures the "system has no admin yet" condition exactly,
 * which is what we want to guard against.
 *
 * Defense-in-depth note: the auto-promotion path emits NO audit row.
 * `emitAudit` requires an authenticated context, and this callback
 * runs INSIDE the Convex Auth credential creation mutation BEFORE the
 * session token exists. The runbook's deployment checklist captures
 * the first-admin bootstrap as a one-time operational event; further
 * admin grants flow through `convex/users.ts:setUserRoles` which DOES
 * audit. See `docs/runbook.md` § First-admin bootstrap.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password],
  callbacks: {
    async afterUserCreatedOrUpdated(ctx, args) {
      // Only fire on first-time creation, not on subsequent re-auths
      // for the same account (which also route through this callback
      // with `existingUserId !== null`).
      if (args.existingUserId !== null) return;

      // Scan `userRoles` once. At first-admin time the table is empty
      // (the whole point); at every other time it has at least one row
      // and the check short-circuits without granting anything. The
      // scan cost is O(table size) which is bounded by staff headcount
      // (10–20 per the brief § scale assumptions); fine to pay on
      // every signup.
      const existing = await ctx.db.query("userRoles").take(1);
      if (existing.length > 0) return;

      // First-admin bootstrap. `grantedBy` is `args.userId` itself —
      // there is no other authenticated principal at this moment.
      // The runbook documents that this self-grant is expected for the
      // first admin only; all subsequent role grants have a real
      // human admin as `grantedBy`.
      await ctx.db.insert("userRoles", {
        userId: args.userId,
        role: "admin",
        grantedAt: Date.now(),
        grantedBy: args.userId,
      });
    },
  },
});
