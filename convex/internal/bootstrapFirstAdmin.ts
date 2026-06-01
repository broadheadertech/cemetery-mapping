/**
 * First-admin recovery bootstrap — Story 1.1 follow-up (Epic 1 review HIGH-A).
 *
 * The primary bootstrap path is automatic: the `afterUserCreatedOrUpdated`
 * callback in `convex/auth.ts` grants `admin` to the very first signed-up
 * account by checking that `userRoles` is empty. This file is the
 * **recovery path** for operators when the automatic path didn't fire (an
 * earlier signup raced, the callback was disabled mid-deploy, a manual
 * `users` row was inserted out-of-band, etc.).
 *
 * Invocation:
 *   npx convex run internal/bootstrapFirstAdmin:run --userId=<users:abc...>
 *
 * The mutation is `internal` — it is NOT exposed to the public client API,
 * so it cannot be triggered from a malicious browser session. The Convex
 * CLI invocation requires deployment-key access (the same access required
 * to deploy the backend in the first place), so the human-permission
 * gate is the dev's machine, not the running app's auth layer.
 *
 * Safety:
 *   - The mutation refuses to grant if `userRoles` already has ANY rows.
 *     That guard mirrors the auto-callback in `convex/auth.ts` and
 *     prevents the recovery path from being used to silently promote a
 *     second account after the system already has an admin.
 *   - The passed `userId` must reference an existing `users` row. We do
 *     not create the row — the user must have signed up first.
 *   - The grant uses the passed `userId` as `grantedBy` (the only
 *     principal that exists at first-admin time).
 *
 * Audit: this mutation does NOT call `emitAudit`. The `emitAudit` helper
 * requires an authenticated context and there is none at first-admin
 * time. The deployment runbook captures the bootstrap as an operational
 * event (`docs/runbook.md` § First-admin bootstrap). Every subsequent
 * role grant flows through `convex/users.ts:setUserRoles` which DOES
 * audit.
 */

import { internalMutationGeneric } from "convex/server";
import { v } from "convex/values";
import type { GenericId } from "convex/values";

import { type MutationCtx } from "../lib/auth";
import { ErrorCode, throwError } from "../lib/errors";

export const run = internalMutationGeneric({
  args: {
    userId: v.id("users"),
  },
  handler: async (
    ctx: MutationCtx,
    args: { userId: GenericId<"users"> },
  ): Promise<{ granted: boolean; reason: string }> => {
    // Refuse if the system already has an admin (or any role assignment
    // at all). The recovery path is a one-time escape hatch, not a
    // general role-grant tool.
    const existingRoles = await ctx.db.query("userRoles").take(1);
    if (existingRoles.length > 0) {
      return {
        granted: false,
        reason:
          "userRoles is not empty; use the admin UI (/admin/users) to grant roles.",
      };
    }
    const user = await ctx.db.get(args.userId);
    if (user === null) {
      throwError(ErrorCode.NOT_FOUND, "User not found.", {
        userId: args.userId,
      });
    }
    await ctx.db.insert("userRoles", {
      userId: args.userId,
      role: "admin",
      grantedAt: Date.now(),
      grantedBy: args.userId,
    });
    return { granted: true, reason: "First-admin bootstrap completed." };
  },
});
