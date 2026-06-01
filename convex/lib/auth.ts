/**
 * RBAC cornerstone — Story 1.2.
 *
 * Every public Convex query / mutation / action MUST call `requireRole`
 * or `requireAuth` as its first action. The ESLint rule
 * `local-rules/require-role-first-line` enforces this at build time —
 * skipping the call is a CI failure, not a code-review smell.
 *
 * Files exempt from the rule (and therefore allowed to skip the call):
 *   - convex/_generated/*  — Convex-generated, never edited
 *   - convex/lib/*         — server-internal helpers, no client surface
 *   - convex/http.ts       — webhook routes; signature-validated instead
 *   - convex/auth.ts       — Convex Auth provider config; calling
 *                            requireRole here is a circular dep
 *   - convex/auth.config.ts
 *   - convex/schema.ts     — schema definition, not a function
 *   - any internalQuery / internalMutation / internalAction — server-
 *     to-server, no user context to authenticate
 *
 * Server-side Next.js auth (in `src/app/.../layout.tsx`) uses Convex
 * Auth's Next.js helpers (`convexAuthNextjsToken`,
 * `fetchQuery(api.lib.auth.getCurrentUserOrNull, ...)`) — the ESLint
 * rule does NOT apply to Next.js server components because they are
 * not Convex functions.
 *
 * See `docs/adr/0002-rbac-pattern.md` for the full decision context.
 */

import {
  type DataModelFromSchemaDefinition,
  type GenericMutationCtx,
  type GenericQueryCtx,
  queryGeneric,
} from "convex/server";
import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";

import schema from "../schema";
import { ErrorCode, throwError } from "./errors";
import { DAY_MS, HOUR_MS } from "./time";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;

/**
 * Local Ctx aliases. We don't import these from `./_generated/server`
 * because that directory only exists after the user runs `npx convex
 * dev` interactively. Driving the types off the schema directly gives
 * us the same type safety without a hard dependency on codegen.
 */
export type QueryCtx = GenericQueryCtx<DataModel>;
export type MutationCtx = GenericMutationCtx<DataModel>;
export type ReadableCtx = QueryCtx | MutationCtx;

export type Role = "admin" | "office_staff" | "field_worker" | "customer";

const ALL_ROLES: readonly Role[] = [
  "admin",
  "office_staff",
  "field_worker",
  "customer",
];

/**
 * Per-role session timeouts per NFR-S5.
 *
 * Enforced inside `requireRole` (and `requireAuth`) by comparing the
 * session's creation timestamp against the timeout for the user's
 * most-permissive role. Convex Auth's static config can't express
 * per-role timeouts directly, so we enforce in code.
 *
 * Multi-role precedence: if a user holds multiple roles, we apply the
 * SHORTEST timeout among them. This is the safe default — a user who
 * holds both `admin` and `office_staff` must re-auth on the admin
 * cadence (1h) even when only acting as office_staff. ADR-0002.
 */
export const SESSION_TIMEOUTS: Record<Role, number> = {
  admin: 1 * HOUR_MS,
  office_staff: 8 * HOUR_MS,
  field_worker: 8 * HOUR_MS,
  customer: 30 * DAY_MS,
};

function isRole(value: unknown): value is Role {
  return (
    typeof value === "string" && (ALL_ROLES as readonly string[]).includes(value)
  );
}

export interface AuthPayload {
  userId: DataModel["users"]["document"]["_id"];
  user: DataModel["users"]["document"];
  roles: Role[];
}

/**
 * Loads the authenticated user + their roles. Returns `null` when no
 * session is present (use this when "not signed in" is a legal state —
 * e.g. a public landing query). For "must be signed in" semantics call
 * `requireAuth` instead.
 *
 * The function is intentionally narrow: it does no role gating, just
 * resolution. Role gating is `requireRole`'s job.
 */
export async function getCurrentUserAndRoles(
  ctx: ReadableCtx,
): Promise<AuthPayload | null> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    return null;
  }
  const user = await ctx.db.get(userId);
  if (user === null) {
    return null;
  }
  const roleRows = await ctx.db
    .query("userRoles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  const roles = roleRows
    .map((r) => r.role)
    .filter((r): r is Role => isRole(r));
  return { userId, user, roles };
}

/**
 * Asserts the caller is authenticated and the session hasn't exceeded
 * its role-based timeout. Returns the resolved auth payload. Does NOT
 * gate on role membership — for that, use `requireRole`.
 *
 * Throws ConvexError with one of:
 *   - UNAUTHENTICATED — no session token or session not found, OR the
 *     user record has `isActive: false` (Story 1.3 deactivation lands
 *     here on the deactivated user's NEXT request — see ADR-0005)
 *   - INVALID_ROLE — user record exists but has zero role assignments
 *   - SESSION_EXPIRED — session older than the role-based timeout
 */
export async function requireAuth(ctx: ReadableCtx): Promise<AuthPayload> {
  const payload = await getCurrentUserAndRoles(ctx);
  if (payload === null) {
    throwError(ErrorCode.UNAUTHENTICATED, "Sign in to continue.");
  }
  // Deactivation check (Story 1.3). `isActive` is optional on the
  // schema for back-compat with rows created before the field landed
  // (Convex Auth's `authTables.users` had no `isActive`); we treat
  // `undefined` as "active" so existing accounts are not locked out
  // by the schema change. `convex/users.ts:createUser` writes the
  // field explicitly going forward.
  if (payload.user.isActive === false) {
    throwError(
      ErrorCode.UNAUTHENTICATED,
      "Account deactivated. Contact an admin.",
    );
  }
  if (payload.roles.length === 0) {
    throwError(
      ErrorCode.INVALID_ROLE,
      "Your account has no role assigned. Contact an admin.",
    );
  }
  await assertSessionWithinTimeout(ctx, payload.roles);
  return payload;
}

/**
 * Asserts the caller is authenticated, the session hasn't timed out,
 * AND the caller holds at least one of `allowedRoles`. The cornerstone
 * helper — every public Convex function calls this as its first line.
 *
 * Throws ConvexError with one of:
 *   - UNAUTHENTICATED, INVALID_ROLE, SESSION_EXPIRED — see requireAuth
 *   - FORBIDDEN — authenticated but no role overlaps with allowedRoles
 */
export async function requireRole(
  ctx: ReadableCtx,
  allowedRoles: readonly Role[],
): Promise<AuthPayload> {
  const payload = await requireAuth(ctx);
  const hasAllowedRole = payload.roles.some((r) => allowedRoles.includes(r));
  if (!hasAllowedRole) {
    throwError(
      ErrorCode.FORBIDDEN,
      "Your role does not permit this action.",
      { allowedRoles: [...allowedRoles], callerRoles: [...payload.roles] },
    );
  }
  return payload;
}

async function assertSessionWithinTimeout(
  ctx: ReadableCtx,
  roles: readonly Role[],
): Promise<void> {
  const sessionId = await getAuthSessionId(ctx);
  if (sessionId === null) {
    throwError(ErrorCode.UNAUTHENTICATED, "Sign in to continue.");
  }
  const session = await ctx.db.get(sessionId);
  if (session === null) {
    throwError(ErrorCode.UNAUTHENTICATED, "Sign in to continue.");
  }
  const timeout = Math.min(...roles.map((r) => SESSION_TIMEOUTS[r]));
  const sessionAge = Date.now() - session._creationTime;
  if (sessionAge > timeout) {
    throwError(ErrorCode.SESSION_EXPIRED, "Your session has expired. Sign in again.");
  }
}

/**
 * Public read used by Next.js server components (e.g. (staff)/layout.tsx)
 * to get the current user without redirecting. Returns null when no
 * session exists — the layout decides whether to redirect.
 *
 * This is a query, not a helper, because Next.js server components call
 * it via `fetchQuery(api.lib.auth.getCurrentUserOrNull)`. It is exempt
 * from the require-role lint rule because its purpose is to *report*
 * auth state, not to gate on it — callers (the layout) gate themselves.
 */
export const getCurrentUserOrNull = queryGeneric({
  args: {},
  handler: async (ctx: ReadableCtx) => {
    return await getCurrentUserAndRoles(ctx);
  },
});
