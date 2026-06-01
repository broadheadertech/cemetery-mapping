/**
 * Story 1.3 — `convex/users.ts` unit tests.
 *
 * Coverage target: ≥ 90% (per Story 1.3 § Testing requirements — admin-
 * touching even though not financial).
 *
 * Strategy: hand-mocked ctx, same pattern as `lots.test.ts` and
 * `auth.test.ts`. `convex-test` requires `convex/_generated/` which
 * isn't built in this repo yet; the hand-mock satisfies all the
 * runtime needs of `requireRole`, `emitAudit`, and the `users` /
 * `authAccounts` / `userRoles` table reads + writes that the
 * handlers perform.
 */

import { ConvexError, type Value } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCode, type ErrorPayload } from "../../../convex/lib/errors";
import { HOUR_MS } from "../../../convex/lib/time";

// Mock Convex Auth's session helpers — same pattern as auth.test.ts.
vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

// Mock Scrypt so tests don't burn CPU on real password hashing — we
// only care that the secret is stored, not that it's a real hash.
vi.mock("lucia", () => ({
  Scrypt: class {
    async hash(password: string): Promise<string> {
      return `scrypt:${password}`;
    }
    async verify(_hash: string, _password: string): Promise<boolean> {
      return true;
    }
  },
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import {
  createUser,
  getCurrentUserRoles,
  listUsers,
  setUserActive,
  setUserRoles,
} from "../../../convex/users";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const ADMIN_ID = "users:admin1";
const SESSION_ID = "authSessions:s1";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface UserFixture {
  _id: string;
  _creationTime: number;
  name?: string;
  email?: string;
  isActive?: boolean;
  createdAt?: number;
  createdBy?: string;
}

interface UserRoleFixture {
  _id: string;
  _creationTime: number;
  userId: string;
  role: RoleName;
  grantedAt: number;
  grantedBy: string;
}

interface AuthAccountFixture {
  _id: string;
  _creationTime: number;
  userId: string;
  provider: string;
  providerAccountId: string;
  secret?: string;
}

interface AuditInsert {
  table: string;
  row: {
    actor: string;
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
    reason?: string;
  };
}

interface CtxBag {
  users: Map<string, UserFixture>;
  userRoles: Map<string, UserRoleFixture>;
  authAccounts: Map<string, AuthAccountFixture>;
  inserts: AuditInsert[];
  patches: Array<{ id: string; patch: Record<string, unknown> }>;
  deletes: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  callerRoles?: RoleName[];
  callerId?: string;
  callerIsActive?: boolean;
  initialUsers?: UserFixture[];
  initialUserRoles?: UserRoleFixture[];
  initialAuthAccounts?: AuthAccountFixture[];
  authenticated?: boolean;
}): CtxBag {
  const users = new Map<string, UserFixture>();
  const userRoles = new Map<string, UserRoleFixture>();
  const authAccounts = new Map<string, AuthAccountFixture>();
  const inserts: AuditInsert[] = [];
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const deletes: string[] = [];

  const callerId = opts.callerId ?? ADMIN_ID;
  const callerRoles = opts.callerRoles ?? ["admin"];

  // Seed the caller user + their roles so requireRole succeeds.
  users.set(callerId, {
    _id: callerId,
    _creationTime: T0 - 1000,
    name: "Caller",
    email: "caller@example.com",
    isActive: opts.callerIsActive !== false,
  });
  callerRoles.forEach((role, idx) => {
    const rid = `userRoles:caller-${idx}`;
    userRoles.set(rid, {
      _id: rid,
      _creationTime: T0,
      userId: callerId,
      role,
      grantedAt: T0,
      grantedBy: callerId,
    });
  });

  for (const u of opts.initialUsers ?? []) users.set(u._id, u);
  for (const r of opts.initialUserRoles ?? []) userRoles.set(r._id, r);
  for (const a of opts.initialAuthAccounts ?? []) authAccounts.set(a._id, a);

  if (opts.authenticated === false) {
    mockedGetAuthUserId.mockResolvedValue(null);
    mockedGetAuthSessionId.mockResolvedValue(null);
  } else {
    mockedGetAuthUserId.mockResolvedValue(callerId as never);
    mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);
  }

  const session = {
    _id: SESSION_ID,
    _creationTime: T0,
    userId: callerId,
    expirationTime: T0 + 30 * 24 * HOUR_MS,
  };

  let nextId = 1;
  function newId(prefix: string): string {
    return `${prefix}:${nextId++}`;
  }

  type Predicate = (r: Record<string, unknown>) => boolean;

  function makeQueryBuilder(table: string) {
    const predicates: Predicate[] = [];
    let rows: Map<string, unknown>;
    if (table === "users") rows = users as Map<string, unknown>;
    else if (table === "userRoles") rows = userRoles as Map<string, unknown>;
    else if (table === "authAccounts")
      rows = authAccounts as Map<string, unknown>;
    else rows = new Map();

    const builder = {
      withIndex(_idx: string, fn: (q: IndexQuery) => IndexQuery) {
        const q: IndexQuery = {
          eqs: {},
          eq(field: string, value: unknown) {
            this.eqs[field] = value;
            return this;
          },
        };
        fn(q);
        for (const [field, value] of Object.entries(q.eqs)) {
          predicates.push(
            (r) => (r as Record<string, unknown>)[field] === value,
          );
        }
        return builder;
      },
      async first(): Promise<unknown | null> {
        for (const r of rows.values()) {
          if (predicates.every((p) => p(r as Record<string, unknown>)))
            return r;
        }
        return null;
      },
      async unique(): Promise<unknown | null> {
        return await builder.first();
      },
      async collect(): Promise<unknown[]> {
        return Array.from(rows.values()).filter((r) =>
          predicates.every((p) => p(r as Record<string, unknown>)),
        );
      },
    };
    return builder;
  }

  interface IndexQuery {
    eqs: Record<string, unknown>;
    eq(field: string, value: unknown): IndexQuery;
  }

  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === SESSION_ID) return session;
        if (users.has(id)) return users.get(id);
        if (userRoles.has(id)) return userRoles.get(id);
        if (authAccounts.has(id)) return authAccounts.get(id);
        return null;
      }),
      query: vi.fn((table: string) => makeQueryBuilder(table)),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "users") {
          const id = newId("users");
          users.set(id, { _id: id, _creationTime: T0, ...row } as UserFixture);
          return id;
        }
        if (table === "userRoles") {
          const id = newId("userRoles");
          userRoles.set(id, {
            _id: id,
            _creationTime: T0,
            ...row,
          } as UserRoleFixture);
          return id;
        }
        if (table === "authAccounts") {
          const id = newId("authAccounts");
          authAccounts.set(id, {
            _id: id,
            _creationTime: T0,
            ...row,
          } as AuthAccountFixture);
          return id;
        }
        if (table === "auditLog") {
          inserts.push({ table, row: row as AuditInsert["row"] });
          return `auditLog:${inserts.length}`;
        }
        return `${table}:?`;
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        patches.push({ id, patch });
        if (users.has(id)) {
          const existing = users.get(id)!;
          users.set(id, { ...existing, ...patch } as UserFixture);
        }
      }),
      delete: vi.fn(async (id: string) => {
        deletes.push(id);
        userRoles.delete(id);
        users.delete(id);
        authAccounts.delete(id);
      }),
    },
  };

  return { users, userRoles, authAccounts, inserts, patches, deletes, ctx };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerOf(fn: any): (ctx: unknown, args: unknown) => Promise<unknown> {
  for (const key of ["_handler", "handler", "invokeMutation", "invokeQuery"]) {
    const v = fn[key];
    if (typeof v === "function") return v as never;
  }
  if (typeof fn === "function") return fn as never;
  throw new Error("Cannot locate handler on Convex function");
}

function getCode(thrown: unknown): string | undefined {
  if (!(thrown instanceof ConvexError)) return undefined;
  const data = (thrown as ConvexError<Value>).data as unknown as ErrorPayload;
  return data?.code;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  mockedGetAuthUserId.mockReset();
  mockedGetAuthSessionId.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("listUsers", () => {
  const run = handlerOf(listUsers);

  it("requires admin role; office_staff is FORBIDDEN", async () => {
    const { ctx } = makeCtx({ callerRoles: ["office_staff"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("returns all users with their roles, sorted by createdAt desc", async () => {
    const olderUser: UserFixture = {
      _id: "users:older",
      _creationTime: T0,
      name: "Older",
      email: "older@example.com",
      isActive: true,
      createdAt: T0 - 2000,
    };
    const newerUser: UserFixture = {
      _id: "users:newer",
      _creationTime: T0,
      name: "Newer",
      email: "newer@example.com",
      isActive: true,
      createdAt: T0 - 1000,
    };
    const role1: UserRoleFixture = {
      _id: "userRoles:r1",
      _creationTime: T0,
      userId: "users:older",
      role: "office_staff",
      grantedAt: T0,
      grantedBy: ADMIN_ID,
    };
    const role2: UserRoleFixture = {
      _id: "userRoles:r2",
      _creationTime: T0,
      userId: "users:newer",
      role: "field_worker",
      grantedAt: T0,
      grantedBy: ADMIN_ID,
    };
    const { ctx } = makeCtx({
      initialUsers: [olderUser, newerUser],
      initialUserRoles: [role1, role2],
    });
    const result = (await run(ctx, {})) as Array<{
      _id: string;
      roles: string[];
    }>;
    // Caller is also in `users`, so result includes them too.
    const newerIndex = result.findIndex((r) => r._id === "users:newer");
    const olderIndex = result.findIndex((r) => r._id === "users:older");
    expect(newerIndex).toBeGreaterThan(-1);
    expect(olderIndex).toBeGreaterThan(-1);
    expect(newerIndex).toBeLessThan(olderIndex); // newer comes first
    const newerRow = result[newerIndex]!;
    expect(newerRow.roles).toEqual(["field_worker"]);
  });
});

describe("createUser", () => {
  const run = handlerOf(createUser);

  it("creates user + authAccount + userRoles atomically, returns temp password", async () => {
    const { ctx, users, userRoles, authAccounts, inserts } = makeCtx({});
    const result = (await run(ctx, {
      name: "  Maria  ",
      email: "  MARIA@EXAMPLE.COM ",
      roles: ["office_staff"],
    })) as { userId: string; temporaryPassword: string };

    expect(result.temporaryPassword).toMatch(/^[A-Za-z2-9]{14}$/);
    // User row exists, with normalised email + active flag.
    const created = users.get(result.userId)!;
    expect(created.name).toBe("Maria");
    expect(created.email).toBe("maria@example.com");
    expect(created.isActive).toBe(true);
    expect(created.createdBy).toBe(ADMIN_ID);
    // authAccount row references the new user with hashed secret.
    const account = Array.from(authAccounts.values()).find(
      (a) => a.userId === result.userId,
    );
    expect(account).toBeDefined();
    expect(account!.providerAccountId).toBe("maria@example.com");
    expect(account!.secret).toBe(`scrypt:${result.temporaryPassword}`);
    // userRoles row written.
    const roleRow = Array.from(userRoles.values()).find(
      (r) => r.userId === result.userId,
    );
    expect(roleRow?.role).toBe("office_staff");
    // Audit log: a single `create` row.
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.row.action).toBe("create");
    expect(inserts[0]!.row.entityType).toBe("user");
  });

  it("rejects duplicate email via users.email index", async () => {
    const existing: UserFixture = {
      _id: "users:dup",
      _creationTime: T0,
      email: "dup@example.com",
      isActive: true,
    };
    const { ctx } = makeCtx({ initialUsers: [existing] });
    const thrown = await run(ctx, {
      name: "Other",
      email: "dup@example.com",
      roles: ["office_staff"],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects duplicate email via authAccounts index", async () => {
    const existingAccount: AuthAccountFixture = {
      _id: "authAccounts:dup",
      _creationTime: T0,
      userId: "users:ghost",
      provider: "password",
      providerAccountId: "ghost@example.com",
    };
    const { ctx } = makeCtx({ initialAuthAccounts: [existingAccount] });
    const thrown = await run(ctx, {
      name: "Ghost",
      email: "ghost@example.com",
      roles: ["office_staff"],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects empty roles array", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, {
      name: "Alice",
      email: "alice@example.com",
      roles: [],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects empty name", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, {
      name: "   ",
      email: "alice@example.com",
      roles: ["office_staff"],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects malformed email", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, {
      name: "Alice",
      email: "no-at-sign",
      roles: ["office_staff"],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects duplicate roles in the args array", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, {
      name: "Alice",
      email: "alice@example.com",
      roles: ["office_staff", "office_staff"],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects non-admin callers (FORBIDDEN)", async () => {
    const { ctx } = makeCtx({ callerRoles: ["office_staff"] });
    const thrown = await run(ctx, {
      name: "Alice",
      email: "alice@example.com",
      roles: ["office_staff"],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("creates a user with multiple roles", async () => {
    const { ctx, userRoles } = makeCtx({});
    const result = (await run(ctx, {
      name: "Multi",
      email: "multi@example.com",
      roles: ["admin", "office_staff"],
    })) as { userId: string };
    const rolesForUser = Array.from(userRoles.values()).filter(
      (r) => r.userId === result.userId,
    );
    expect(rolesForUser.map((r) => r.role).sort()).toEqual([
      "admin",
      "office_staff",
    ]);
  });
});

describe("setUserActive", () => {
  const run = handlerOf(setUserActive);

  it("deactivates a user and emits a deactivate audit", async () => {
    const target: UserFixture = {
      _id: "users:target",
      _creationTime: T0,
      email: "target@example.com",
      isActive: true,
    };
    const targetRole: UserRoleFixture = {
      _id: "userRoles:t1",
      _creationTime: T0,
      userId: "users:target",
      role: "office_staff",
      grantedAt: T0,
      grantedBy: ADMIN_ID,
    };
    const { ctx, users, inserts } = makeCtx({
      initialUsers: [target],
      initialUserRoles: [targetRole],
    });
    await run(ctx, {
      userId: target._id,
      isActive: false,
      reason: "left the company",
    });
    expect(users.get(target._id)!.isActive).toBe(false);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.row.action).toBe("deactivate");
    expect(inserts[0]!.row.reason).toBe("left the company");
    expect(inserts[0]!.row.before).toEqual({ isActive: true });
    expect(inserts[0]!.row.after).toEqual({ isActive: false });
  });

  it("refuses self-deactivation", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, {
      userId: ADMIN_ID,
      isActive: false,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("permits deactivating another admin when there are still other active admins", async () => {
    // Caller is active admin. Other admin to deactivate. After the
    // change, caller remains as an active admin so the guard does
    // not fire. (The last-active-admin guard is exercised more
    // directly under `setUserRoles` where an admin demotes
    // themselves — that path is testable; the `setUserActive` path
    // is only reachable when the caller is themselves inactive,
    // which `requireAuth`'s isActive check rejects first.)
    const otherAdmin: UserFixture = {
      _id: "users:otheradmin",
      _creationTime: T0,
      email: "other@example.com",
      isActive: true,
    };
    const otherAdminRole: UserRoleFixture = {
      _id: "userRoles:other",
      _creationTime: T0,
      userId: "users:otheradmin",
      role: "admin",
      grantedAt: T0,
      grantedBy: ADMIN_ID,
    };
    const { ctx, users } = makeCtx({
      initialUsers: [otherAdmin],
      initialUserRoles: [otherAdminRole],
    });
    await run(ctx, { userId: otherAdmin._id, isActive: false });
    expect(users.get(otherAdmin._id)!.isActive).toBe(false);
  });

  it("is idempotent when called with the current value", async () => {
    const target: UserFixture = {
      _id: "users:idle",
      _creationTime: T0,
      isActive: true,
    };
    const { ctx, patches, inserts } = makeCtx({ initialUsers: [target] });
    await run(ctx, { userId: target._id, isActive: true });
    expect(patches).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("reactivation emits a reactivate audit", async () => {
    const target: UserFixture = {
      _id: "users:back",
      _creationTime: T0,
      isActive: false,
    };
    const { ctx, inserts } = makeCtx({ initialUsers: [target] });
    await run(ctx, { userId: target._id, isActive: true });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.row.action).toBe("reactivate");
  });

  it("throws NOT_FOUND for an unknown user id", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, {
      userId: "users:ghost",
      isActive: false,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });
});

describe("setUserRoles", () => {
  const run = handlerOf(setUserRoles);

  it("diffs roles — inserts new, deletes removed", async () => {
    const target: UserFixture = {
      _id: "users:multi",
      _creationTime: T0,
      isActive: true,
    };
    const oldRole: UserRoleFixture = {
      _id: "userRoles:old",
      _creationTime: T0,
      userId: "users:multi",
      role: "office_staff",
      grantedAt: T0,
      grantedBy: ADMIN_ID,
    };
    const { ctx, userRoles, deletes, inserts } = makeCtx({
      initialUsers: [target],
      initialUserRoles: [oldRole],
    });
    await run(ctx, {
      userId: target._id,
      roles: ["field_worker"],
    });
    // Old role row deleted, new one inserted.
    expect(deletes).toContain("userRoles:old");
    const remaining = Array.from(userRoles.values()).filter(
      (r) => r.userId === target._id,
    );
    expect(remaining.map((r) => r.role).sort()).toEqual(["field_worker"]);
    // Audit captures before/after.
    const auditRow = inserts.find((i) => i.row.entityType === "user");
    expect(auditRow).toBeDefined();
    expect(auditRow!.row.before).toEqual({ roles: ["office_staff"] });
    expect(auditRow!.row.after).toEqual({ roles: ["field_worker"] });
  });

  it("refuses empty roles array", async () => {
    const target: UserFixture = {
      _id: "users:t",
      _creationTime: T0,
      isActive: true,
    };
    const { ctx } = makeCtx({ initialUsers: [target] });
    const thrown = await run(ctx, {
      userId: target._id,
      roles: [],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("refuses to remove admin from the last active admin", async () => {
    // Caller is the only active admin. Removing `admin` from the
    // caller via setUserRoles must fail. We send the call as the
    // caller themselves.
    const callerRole: UserRoleFixture = {
      _id: "userRoles:caller-admin",
      _creationTime: T0,
      userId: ADMIN_ID,
      role: "admin",
      grantedAt: T0,
      grantedBy: ADMIN_ID,
    };
    const { ctx } = makeCtx({
      // Caller's own admin role lives in initialUserRoles, not via
      // the caller-roles seed (which writes its own ids).
      initialUserRoles: [callerRole],
    });
    const thrown = await run(ctx, {
      userId: ADMIN_ID,
      roles: ["office_staff"],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("no-ops when the diff is empty", async () => {
    const target: UserFixture = {
      _id: "users:same",
      _creationTime: T0,
      isActive: true,
    };
    const existing: UserRoleFixture = {
      _id: "userRoles:same",
      _creationTime: T0,
      userId: target._id,
      role: "office_staff",
      grantedAt: T0,
      grantedBy: ADMIN_ID,
    };
    const { ctx, inserts, deletes } = makeCtx({
      initialUsers: [target],
      initialUserRoles: [existing],
    });
    await run(ctx, {
      userId: target._id,
      roles: ["office_staff"],
    });
    expect(deletes).toHaveLength(0);
    expect(inserts).toHaveLength(0); // no audit row
  });

  it("throws NOT_FOUND for unknown user", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, {
      userId: "users:ghost",
      roles: ["office_staff"],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("rejects non-admin callers", async () => {
    const { ctx } = makeCtx({ callerRoles: ["office_staff"] });
    const thrown = await run(ctx, {
      userId: "users:any",
      roles: ["office_staff"],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("getCurrentUserRoles", () => {
  const run = handlerOf(getCurrentUserRoles);

  it("returns the caller's id, roles, and isActive flag", async () => {
    const { ctx } = makeCtx({ callerRoles: ["office_staff"] });
    const result = (await run(ctx, {})) as {
      userId: string;
      roles: string[];
      isActive: boolean;
    };
    expect(result.userId).toBe(ADMIN_ID);
    expect(result.roles).toEqual(["office_staff"]);
    expect(result.isActive).toBe(true);
  });

  it("throws UNAUTHENTICATED for anonymous callers", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("throws UNAUTHENTICATED for deactivated callers (Story 1.3 branch)", async () => {
    const { ctx } = makeCtx({ callerIsActive: false });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});
