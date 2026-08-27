import {
  type DataModelFromSchemaDefinition,
  type GenericMutationCtx,
  type GenericQueryCtx,
} from "convex/server";
import { type GenericId } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

import schema from "../schema";
import { ErrorCode, throwError } from "./errors";

/**
 * Access control cornerstone.
 *
 * Every public Convex query / mutation / action calls `requireRole` (or
 * `requireAuth`) as its first action. The `local-rules/require-auth-first-line`
 * ESLint rule enforces this at build time — skipping it is a CI failure,
 * not a code-review smell.
 *
 * Exempt from the rule:
 *   - `convex/_generated/*` — generated, never edited
 *   - `convex/lib/*`        — server-internal helpers, no client surface
 *   - `convex/schema.ts`    — a declaration, not a function
 *   - `convex/http.ts`, `convex/auth.ts`, `convex/auth.config.ts`
 *   - any `internalQuery` / `internalMutation` / `internalAction` —
 *     server-to-server, no user context to authenticate
 *
 * ---------------------------------------------------------------
 * WHY THIS MATTERS MORE ON CONVEX
 * ---------------------------------------------------------------
 * On Postgres, row-level security was a second line of defence: a
 * forgotten tenant predicate still returned nothing. Convex has no RLS.
 * `requireTenant` below is the ONLY thing scoping a caller to their own
 * data, and it deliberately resolves the tenant from the authenticated
 * identity — never from a function argument. A `tenantId` accepted as
 * an argument is an authorization bug however carefully the index is
 * built.
 */

type DataModel = DataModelFromSchemaDefinition<typeof schema>;

/**
 * Ctx aliases driven off the schema rather than `./_generated/server`,
 * because that directory only exists after `npx convex dev` has run.
 * Same type safety, no hard dependency on codegen having happened.
 */
export type QueryCtx = GenericQueryCtx<DataModel>;
export type MutationCtx = GenericMutationCtx<DataModel>;
export type ReadableCtx = QueryCtx | MutationCtx;

/**
 * `Doc<"advances">` / `Id<"categories">` without depending on
 * `convex/_generated/dataModel`, which does not exist until codegen has
 * run. Derived from the schema, so they stay correct by construction.
 *
 * Helpers take these rather than `string`. That is not pedantry: an
 * `Id<"advances">` and an `Id<"categories">` are both strings at
 * runtime, so a `string`-typed API lets a caller pass the wrong one and
 * find out in production.
 */
export type TableNames = keyof DataModel & string;
export type Doc<T extends TableNames> = DataModel[T]["document"];
export type Id<T extends TableNames> = Doc<T>["_id"];
/** File storage ids are a system table, absent from the schema model. */
export type StorageId = GenericId<"_storage">;

export type UserId = Id<"users">;
export type TenantId = Id<"tenants">;
export type UserDoc = Doc<"users">;
export type CategoryDoc = Doc<"categories">;

export type Role = "admin" | "bookkeeper" | "encoder" | "payroll" | "viewer";

const ALL_ROLES: readonly Role[] = [
  "admin",
  "bookkeeper",
  "encoder",
  "payroll",
  "viewer",
];

/**
 * Roles permitted to read a category marked `isRestricted` — payroll
 * and government contributions (taxonomy §4, "Access-restricted").
 */
export const RESTRICTED_CATEGORY_ROLES: readonly Role[] = ["admin", "payroll"];

function isRole(value: unknown): value is Role {
  return (
    typeof value === "string" && (ALL_ROLES as readonly string[]).includes(value)
  );
}

export interface AuthPayload {
  userId: UserId;
  user: UserDoc;
  tenantId: TenantId;
  roles: Role[];
}

/**
 * Resolves the authenticated user, their tenant and their roles, or
 * `null` when there is no session. Use where "not signed in" is a legal
 * state; for "must be signed in", call `requireAuth`.
 *
 * Does no gating — resolution only. Gating is `requireRole`'s job.
 */
export async function getCurrentUserAndRoles(
  ctx: ReadableCtx,
): Promise<AuthPayload | null> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) return null;

  const user = await ctx.db.get(userId);
  if (user === null) return null;

  // The bootstrap admin exists before any tenant does, so `tenantId` is
  // optional on the schema. A user with no tenant cannot act on tenant
  // data — `requireTenant` turns that into a loud error at the point of
  // use rather than a silently empty result set here.
  if (user.tenantId === undefined) return null;

  const roleRows = await ctx.db
    .query("userRoles")
    .withIndex("by_tenant_user", (q) =>
      q.eq("tenantId", user.tenantId!).eq("userId", userId),
    )
    .collect();

  const roles = roleRows.map((r) => r.role).filter((r): r is Role => isRole(r));

  return { userId, user, tenantId: user.tenantId, roles };
}

/**
 * Asserts the caller is authenticated and active. Does NOT gate on role
 * membership — for that, use `requireRole`.
 */
export async function requireAuth(ctx: ReadableCtx): Promise<AuthPayload> {
  const payload = await getCurrentUserAndRoles(ctx);
  if (payload === null) {
    throwError(ErrorCode.UNAUTHENTICATED, "Sign in to continue.");
  }
  // `isActive` is optional so rows created before the field landed are
  // not locked out; `undefined` means active. Deactivation therefore
  // takes effect on the user's next request.
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
  return payload;
}

/**
 * Asserts the caller is authenticated AND holds at least one of
 * `allowedRoles`. The cornerstone — every public function starts here.
 */
export async function requireRole(
  ctx: ReadableCtx,
  allowedRoles: readonly Role[],
): Promise<AuthPayload> {
  const payload = await requireAuth(ctx);
  if (!payload.roles.some((r) => allowedRoles.includes(r))) {
    throwError(ErrorCode.FORBIDDEN, "Your role does not permit this action.", {
      allowedRoles: [...allowedRoles],
      callerRoles: [...payload.roles],
    });
  }
  return payload;
}

/**
 * The tenant the caller belongs to. **This is the isolation boundary.**
 *
 * Every indexed read in this codebase pins `tenantId` to the value this
 * returns. It is derived from the session, so a caller cannot reach
 * another tenant's data by passing a different id.
 */
export async function requireTenant(ctx: ReadableCtx): Promise<TenantId> {
  const { tenantId } = await requireAuth(ctx);
  return tenantId;
}

/**
 * Loads the tenant document, which carries the timezone every
 * business-date computation needs (see `convex/lib/time.ts`) and the
 * stale-advance threshold (taxonomy §6.4).
 */
export async function requireTenantDoc(ctx: ReadableCtx) {
  const tenantId = await requireTenant(ctx);
  const tenant = await ctx.db.get(tenantId);
  if (tenant === null) {
    throwError(ErrorCode.NO_TENANT, "Tenant not found.", { tenantId });
  }
  return tenant;
}

/**
 * Guards reads of an access-restricted category — payroll and
 * government contributions (taxonomy §4).
 *
 * Call this before returning ANY row that carries a `categoryId`, not
 * just when listing categories. The restriction is on the spending,
 * not on the label: a payroll movement is exactly as sensitive as the
 * payroll category itself.
 */
export function assertCategoryReadable(
  category: CategoryDoc,
  roles: readonly Role[],
): void {
  if (!category.isRestricted) return;
  if (roles.some((r) => RESTRICTED_CATEGORY_ROLES.includes(r))) return;
  throwError(
    ErrorCode.RESTRICTED_CATEGORY,
    "This category is restricted.",
    { categorySlug: category.slug },
  );
}

/**
 * Filters a list down to rows the caller may see, given the categories
 * they reference. Use for list endpoints, where throwing on the first
 * restricted row would hide the rest of a legitimate result set.
 */
export function filterReadableByCategory<T extends { categoryId: unknown }>(
  rows: readonly T[],
  categoriesById: ReadonlyMap<string, CategoryDoc>,
  roles: readonly Role[],
): T[] {
  const privileged = roles.some((r) => RESTRICTED_CATEGORY_ROLES.includes(r));
  if (privileged) return [...rows];
  return rows.filter((row) => {
    const category = categoriesById.get(String(row.categoryId));
    return category !== undefined && !category.isRestricted;
  });
}
