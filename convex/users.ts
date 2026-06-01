/**
 * User management domain (Story 1.3, FR2 / FR3 / FR4).
 *
 * Public surface — the admin-only CRUD for staff accounts plus the
 * self-read `getCurrentUserRoles` consumed by the Next.js (staff)
 * layout (Story 1.1 / 1.5) and the AppShell sidebar role-filter.
 *
 * Conventions every handler obeys (mirrored from `convex/lots.ts`):
 *
 *   1. FIRST awaited statement is `await requireRole(ctx, [...])` (or
 *      `requireAuth` for the self-read). The ESLint rule
 *      `local-rules/require-role-first-line` enforces this.
 *   2. Mutations call `emitAudit` — direct `auditLog` inserts are banned
 *      by Story 1.6's `no-audit-log-direct-write` rule.
 *   3. Money / state-machine concerns N/A here.
 *   4. Deletion is soft (`isActive: false`) — never `ctx.db.delete`.
 *      `requireAuth` (Story 1.2, extended in this story) bounces a
 *      deactivated user on their next request. The user row persists
 *      for audit / re-activation. See ADR-0005.
 *
 * Architectural notes:
 *
 *   - **Atomic user creation.** A new staff account requires three
 *     writes that MUST land together: the `users` row, the
 *     `authAccounts` row that lets Convex Auth's Password provider
 *     authenticate the email, and one or more `userRoles` rows. We
 *     do them all inside the `createUser` MutationCtx. Convex Auth
 *     ships a `createAccount(actionCtx, ...)` helper that is
 *     action-only — using it would force a `ctx.scheduler.runAfter`
 *     handoff and split the writes across two mutations, leaving the
 *     window for partial state. Instead we replicate Convex Auth's
 *     minimal credential-account row shape directly (verified via the
 *     `upsertUserAndAccount` source in @convex-dev/auth) and hash the
 *     password with Lucia's `Scrypt` — the same implementation
 *     `Password.crypto.hashSecret` uses internally, so a user we
 *     create here can sign in via Convex Auth's normal flow.
 *
 *   - **Temporary password handoff.** Phase 1 has no email service
 *     (per the brief § 7). The mutation returns the cleartext
 *     temporary password to the caller; the admin UI displays it
 *     once in a copy-to-clipboard dialog and the admin hands it to
 *     the new user out-of-band. The cleartext is never persisted —
 *     only the Scrypt hash lands in `authAccounts.secret`. See
 *     ADR-0005 for the deactivation-semantics decision and the
 *     "no email service in Phase 1" residual.
 *
 *   - **Email uniqueness.** Convex has no DB-level UNIQUE constraint.
 *     We check via the Convex Auth `authAccounts.providerAndAccountId`
 *     index AND the `users.email` index. The double check covers the
 *     edge case where someone manually creates a user row without an
 *     account (no production path does that today).
 *
 *   - **Last-admin guard.** `setUserActive(false)` and `setUserRoles`
 *     both refuse to drop the system's active-admin count to zero.
 *     The check is a count-the-admins scan over `userRoles` — at the
 *     story's scale (10–20 staff) the scan is fine; if user count
 *     ever exceeds 100 we revisit with an aggregated counter.
 */

import {
  type DataModelFromSchemaDefinition,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";
import { Scrypt } from "lucia";

import schema from "./schema";
import {
  requireAuth,
  requireRole,
  type MutationCtx,
  type QueryCtx,
} from "./lib/auth";
import { emitAudit } from "./lib/audit";
import { ErrorCode, throwError } from "./lib/errors";
import { generateTemporaryPassword } from "./lib/passwords";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type UserDoc = DataModel["users"]["document"];
type UserId = UserDoc["_id"];
type UserRoleDoc = DataModel["userRoles"]["document"];

/**
 * Roles assignable through the admin UI. `customer` is intentionally
 * excluded — Phase 3's customer-portal flow creates customer accounts
 * via a separate path; the staff admin UI should never grant the
 * `customer` role to a staff member.
 */
const STAFF_ROLE_VALUES = ["admin", "office_staff", "field_worker"] as const;
type StaffRole = (typeof STAFF_ROLE_VALUES)[number];

const staffRoleValidator = v.union(
  v.literal("admin"),
  v.literal("office_staff"),
  v.literal("field_worker"),
);

/**
 * Shape returned to the admin UI. Mirrors the union of fields the
 * `/admin/users` table needs; we deliberately do NOT expose the
 * password hash or any auth-internal field.
 */
export interface UserListRow {
  _id: UserId;
  name: string;
  email: string;
  isActive: boolean;
  createdAt: number;
  createdBy: UserId | null;
  roles: StaffRole[];
}

/**
 * Self-read used by the Next.js middleware and the AppShell sidebar
 * (Story 1.5). Returns the caller's user id + roles only — never a
 * different user's data. Exempt from `requireRole` because the answer
 * is "who am I" which is implicit in `requireAuth`.
 *
 * The shape mirrors `getCurrentUserOrNull` in `convex/lib/auth.ts` to
 * minimise client-side fan-out, but this one ALSO covers the
 * deactivated branch — calling it on a deactivated session throws
 * `UNAUTHENTICATED` (Story 1.3 Task 2 added the `isActive` check to
 * `requireAuth`).
 */
export const getCurrentUserRoles = queryGeneric({
  args: {},
  handler: async (
    ctx: QueryCtx,
  ): Promise<{ userId: UserId; roles: StaffRole[]; isActive: boolean }> => {
    const auth = await requireAuth(ctx);
    const roles = auth.roles.filter(isStaffRole);
    return {
      userId: auth.userId,
      roles,
      // `isActive` may be undefined for pre-Story-1.3 rows; treat
      // undefined as active for back-compat.
      isActive: auth.user.isActive !== false,
    };
  },
});

/**
 * Admin user list. Returns all users (active and inactive) sorted by
 * createdAt desc — newest first so freshly-added accounts are
 * obvious. Performance: at 10–20 staff a full-table scan is well
 * inside Convex's default query budget; if user count grows past
 * ~100 we add pagination + viewport queries.
 */
export const listUsers = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<UserListRow[]> => {
    await requireRole(ctx, ["admin"]);
    const users = await ctx.db.query("users").collect();
    // Build the per-user roles map in a single batched pass to avoid
    // an N+1 query. The `userRoles` table is small (≤4 rows per
    // user), so collecting once and grouping in memory is cheaper
    // than N calls to `withIndex("by_user", ...)`.
    const allRoleRows = await ctx.db.query("userRoles").collect();
    const rolesByUser = new Map<string, StaffRole[]>();
    for (const r of allRoleRows) {
      if (!isStaffRole(r.role)) continue;
      const list = rolesByUser.get(r.userId) ?? [];
      list.push(r.role);
      rolesByUser.set(r.userId, list);
    }
    const rows: UserListRow[] = users.map((u) => ({
      _id: u._id,
      name: u.name ?? "",
      email: u.email ?? "",
      isActive: u.isActive !== false,
      createdAt: u.createdAt ?? u._creationTime,
      createdBy: u.createdBy ?? null,
      roles: rolesByUser.get(u._id) ?? [],
    }));
    // Sort newest-first. `localeCompare` not needed — these are
    // numeric epoch timestamps; a straight subtraction is fine.
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  },
});

/**
 * Creates a new staff user. Atomic — user row, auth-account row, and
 * userRoles rows all land inside a single Convex mutation. Returns
 * the new user id PLUS the cleartext temporary password (one-time;
 * never persisted in cleartext).
 *
 * Validation:
 *   - `name` trimmed; non-empty.
 *   - `email` trimmed + lowercased; non-empty; not already used.
 *   - `roles` non-empty array of staff roles (no `customer`).
 *
 * Returns: `{ userId, temporaryPassword }`. The client copies the
 * password to a one-time-display dialog; logging it is a hard NO.
 */
export const createUser = mutationGeneric({
  args: {
    name: v.string(),
    email: v.string(),
    roles: v.array(staffRoleValidator),
  },
  handler: async (
    ctx: MutationCtx,
    args: { name: string; email: string; roles: StaffRole[] },
  ): Promise<{ userId: UserId; temporaryPassword: string }> => {
    const auth = await requireRole(ctx, ["admin"]);
    const name = args.name.trim();
    const email = args.email.trim().toLowerCase();
    validateCreateUserPayload({ name, email, roles: args.roles });
    // Email uniqueness: check both the user table (Convex-Auth's
    // `email` index) and the `authAccounts` table (the primary auth
    // surface). The two checks are belt-and-suspenders — production
    // never has one without the other.
    const existingUser = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first();
    if (existingUser !== null) {
      throwError(
        ErrorCode.VALIDATION,
        "A user with that email already exists.",
        { email },
      );
    }
    const existingAccount = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) =>
        q.eq("provider", "password").eq("providerAccountId", email),
      )
      .first();
    if (existingAccount !== null) {
      throwError(
        ErrorCode.VALIDATION,
        "A user with that email already exists.",
        { email },
      );
    }

    const temporaryPassword = generateTemporaryPassword();
    // Scrypt — the same hash function Convex Auth's Password provider
    // uses internally (verified in @convex-dev/auth Password.ts).
    // Hashing on the same V8 runtime that runs the mutation keeps
    // everything in a single atomic operation.
    const secret = await new Scrypt().hash(temporaryPassword);

    const now = Date.now();
    const userId = await ctx.db.insert("users", {
      name,
      email,
      isActive: true,
      createdAt: now,
      createdBy: auth.userId,
    });

    // Auth-account row — Convex Auth looks up the credential via the
    // `providerAndAccountId` index when the user signs in. The shape
    // is replicated from `authTables.authAccounts` in `convex/schema.ts`.
    await ctx.db.insert("authAccounts", {
      userId,
      provider: "password",
      providerAccountId: email,
      secret,
    });

    // userRoles — one row per role per user. `grantedBy` is the
    // current admin per `userRoles` validator (Story 1.2 schema).
    for (const role of args.roles) {
      await ctx.db.insert("userRoles", {
        userId,
        role,
        grantedAt: now,
        grantedBy: auth.userId,
      });
    }

    await emitAudit(ctx, {
      action: "create",
      entityType: "user",
      entityId: userId,
      after: {
        name,
        email,
        isActive: true,
        roles: args.roles,
      },
    });

    return { userId, temporaryPassword };
  },
});

/**
 * Activates / deactivates a user. Soft — the user row persists, and
 * `requireAuth` rejects the deactivated user on their next request.
 *
 * Guards:
 *   - An admin cannot deactivate themselves (no last-locked-out-key
 *     scenario where the only admin shuts themselves out).
 *   - Deactivating an admin must not drop the system's active-admin
 *     count to zero.
 *
 * Reactivation has no guard — re-enabling an account is always safe.
 */
export const setUserActive = mutationGeneric({
  args: {
    userId: v.id("users"),
    isActive: v.boolean(),
    reason: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: { userId: UserId; isActive: boolean; reason?: string },
  ): Promise<void> => {
    const auth = await requireRole(ctx, ["admin"]);
    if (args.userId === auth.userId && args.isActive === false) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "You cannot deactivate your own account.",
        { userId: args.userId },
      );
    }
    const target = await ctx.db.get(args.userId);
    if (target === null) {
      throwError(ErrorCode.NOT_FOUND, "User not found.", {
        userId: args.userId,
      });
    }
    const oldActive = target.isActive !== false;
    if (oldActive === args.isActive) {
      // Idempotent — already in the desired state. No-op, no audit.
      return;
    }
    if (args.isActive === false) {
      await assertNotLastActiveAdmin(ctx, args.userId);
    }
    await ctx.db.patch(args.userId, { isActive: args.isActive });
    await emitAudit(ctx, {
      action: args.isActive ? "reactivate" : "deactivate",
      entityType: "user",
      entityId: args.userId,
      before: { isActive: oldActive },
      after: { isActive: args.isActive },
      reason: args.reason,
    });
  },
});

/**
 * Replaces a user's set of roles. Diffs against the existing
 * `userRoles` rows: inserts new ones, deletes removed ones, leaves
 * unchanged ones alone. Atomic per Convex mutation semantics.
 *
 * Guards:
 *   - At least one staff role required (passing an empty array is
 *     equivalent to "no role" which `requireAuth` treats as
 *     INVALID_ROLE — we refuse it earlier with a clearer message).
 *   - Removing `admin` from the last remaining active admin is
 *     blocked. Same scan as `setUserActive`.
 *
 * Change semantics: the user's CURRENT session is NOT invalidated.
 * Role changes take effect on the user's next Convex call because
 * `requireRole` re-reads `userRoles` on every call.
 */
export const setUserRoles = mutationGeneric({
  args: {
    userId: v.id("users"),
    roles: v.array(staffRoleValidator),
  },
  handler: async (
    ctx: MutationCtx,
    args: { userId: UserId; roles: StaffRole[] },
  ): Promise<void> => {
    await requireRole(ctx, ["admin"]);
    if (args.roles.length === 0) {
      throwError(
        ErrorCode.VALIDATION,
        "Select at least one role.",
        { userId: args.userId },
      );
    }
    const target = await ctx.db.get(args.userId);
    if (target === null) {
      throwError(ErrorCode.NOT_FOUND, "User not found.", {
        userId: args.userId,
      });
    }
    const existingRows = await ctx.db
      .query("userRoles")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    const existingRoles = new Set(
      existingRows
        .map((r) => r.role)
        .filter((r): r is StaffRole => isStaffRole(r)),
    );
    const nextRoles = new Set<StaffRole>(args.roles);
    // Last-admin guard — if this change would remove `admin` from
    // the only remaining active admin in the system, refuse.
    if (existingRoles.has("admin") && !nextRoles.has("admin")) {
      await assertNotLastActiveAdmin(ctx, args.userId);
    }
    const toDelete = existingRows.filter(
      (r) => !isStaffRole(r.role) || !nextRoles.has(r.role),
    );
    const toInsert: StaffRole[] = [];
    for (const role of nextRoles) {
      if (!existingRoles.has(role)) toInsert.push(role);
    }
    for (const row of toDelete) {
      await ctx.db.delete(row._id);
    }
    const now = Date.now();
    const auth = await getActingAdmin(ctx);
    for (const role of toInsert) {
      await ctx.db.insert("userRoles", {
        userId: args.userId,
        role,
        grantedAt: now,
        grantedBy: auth.userId,
      });
    }
    if (toDelete.length === 0 && toInsert.length === 0) {
      // No-op diff; skip audit to avoid noise.
      return;
    }
    await emitAudit(ctx, {
      action: "update",
      entityType: "user",
      entityId: args.userId,
      before: { roles: Array.from(existingRoles).sort() },
      after: { roles: Array.from(nextRoles).sort() },
    });
  },
});

/**
 * Last-admin guard shared by `setUserActive` and `setUserRoles`.
 * Throws `INVARIANT_VIOLATION` if removing `userId` from the active-
 * admin set would drop the count to zero. The scan walks every
 * `admin`-role `userRoles` row and checks the associated user's
 * `isActive` flag — small N, no index needed at the story's scale.
 */
async function assertNotLastActiveAdmin(
  ctx: MutationCtx,
  userId: UserId,
): Promise<void> {
  const adminRoleRows = await ctx.db.query("userRoles").collect();
  const adminUserIds = new Set<string>();
  for (const row of adminRoleRows) {
    if (row.role === "admin") adminUserIds.add(row.userId);
  }
  let otherActiveAdmins = 0;
  for (const otherId of adminUserIds) {
    if (otherId === userId) continue;
    const u = (await ctx.db.get(otherId as UserId)) as UserDoc | null;
    if (u !== null && u.isActive !== false) otherActiveAdmins += 1;
  }
  if (otherActiveAdmins === 0) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      "Cannot remove the last active admin from the system.",
      { userId },
    );
  }
}

/**
 * Helper — pulls the acting admin's id without re-running
 * `requireRole` (which we've already done in the handler).
 * Kept separate so the diff logic in `setUserRoles` reads as a
 * straight-line sequence of writes.
 */
async function getActingAdmin(ctx: MutationCtx): Promise<{ userId: UserId }> {
  // We can re-resolve via `requireRole` here without an additional
  // session round-trip because Convex caches reads inside a single
  // mutation invocation.
  const auth = await requireRole(ctx, ["admin"]);
  return { userId: auth.userId };
}

/**
 * Stateless validation for `createUser`. Centralises invariants so
 * the handler reads as a happy-path narrative.
 */
function validateCreateUserPayload(payload: {
  name: string;
  email: string;
  roles: StaffRole[];
}): void {
  if (payload.name.length === 0) {
    throwError(ErrorCode.VALIDATION, "Name is required.");
  }
  if (payload.email.length === 0) {
    throwError(ErrorCode.VALIDATION, "Email is required.");
  }
  if (!isPlausibleEmail(payload.email)) {
    throwError(ErrorCode.VALIDATION, "Email is not a valid address.");
  }
  if (payload.roles.length === 0) {
    throwError(ErrorCode.VALIDATION, "Select at least one role.");
  }
  // Defensive: reject duplicates within the same call.
  const unique = new Set(payload.roles);
  if (unique.size !== payload.roles.length) {
    throwError(ErrorCode.VALIDATION, "Duplicate roles are not allowed.");
  }
}

/**
 * Permissive email check — we're not the address validator, the user
 * will receive the temporary password out-of-band so a bad address
 * is human-recoverable. We just rule out the obviously-malformed
 * inputs that a tired admin might paste.
 */
function isPlausibleEmail(value: string): boolean {
  if (value.length < 3) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at === value.length - 1) return false;
  if (value.includes(" ")) return false;
  return value.lastIndexOf(".") > at;
}

function isStaffRole(role: string): role is StaffRole {
  return (STAFF_ROLE_VALUES as readonly string[]).includes(role);
}

// Re-export for tests so they don't have to reach into local consts.
export { STAFF_ROLE_VALUES };
// Re-export the doc type for downstream consumers (admin UI, tests).
export type { UserRoleDoc };
