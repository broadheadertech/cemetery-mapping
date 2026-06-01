/**
 * Client-side mirror of the server `Role` type from `convex/lib/auth.ts`.
 *
 * Why mirror instead of import: the client bundle must not pull from
 * `convex/lib/**` (those modules are server-internal and would drag in
 * Convex's server runtime). The two definitions are kept in sync by
 * convention; the values are the same string literals.
 *
 * If you add a new role here, add it to `convex/lib/auth.ts` and
 * vice-versa. The server is the authoritative source for *enforcement*;
 * this type only powers UI filtering (which nav items show for which
 * role).
 */
export type Role = "admin" | "office_staff" | "field_worker" | "customer";

/** Staff roles — anyone allowed in the (staff) route group. */
export const STAFF_ROLES: ReadonlyArray<Role> = [
  "admin",
  "office_staff",
  "field_worker",
];
