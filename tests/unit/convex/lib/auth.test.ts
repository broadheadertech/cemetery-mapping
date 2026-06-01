/**
 * Story 1.2 — RBAC cornerstone unit tests.
 *
 * Coverage target: 100% line + branch on `convex/lib/auth.ts`. This is
 * foundation-cornerstone code; every story from 1.3 onward depends on
 * `requireRole` doing exactly what these tests describe.
 *
 * Why hand-mocked ctx instead of `convex-test`:
 *   `convex-test` requires `convex/_generated/` to exist on disk, and
 *   that directory only appears after the user runs the interactive
 *   `npx convex dev` once. To keep CI green from the first commit, we
 *   construct minimal MutationCtx-shaped objects that satisfy the
 *   helper's runtime needs (auth identity, `db.get`, `db.query`),
 *   and we use `vi.mock` to control what Convex Auth's
 *   `getAuthUserId` / `getAuthSessionId` return. Once `_generated/` is
 *   present, a later story can swap in a `convex-test` round-trip suite
 *   in addition to this one — but the assertions here are sufficient
 *   to lock in the contract.
 */

import { ConvexError, type Value } from "convex/values";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  ErrorCode,
  throwError,
  type ErrorPayload,
} from "../../../../convex/lib/errors";
import { HOUR_MS } from "../../../../convex/lib/time";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import {
  getCurrentUserAndRoles,
  requireAuth,
  requireRole,
  SESSION_TIMEOUTS,
  type Role,
} from "../../../../convex/lib/auth";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();

interface UserRow {
  _id: string;
  _creationTime: number;
  email: string;
  isActive?: boolean;
}

interface UserRoleRow {
  _id: string;
  _creationTime: number;
  userId: string;
  role: Role;
  grantedAt: number;
  grantedBy: string;
}

interface SessionRow {
  _id: string;
  _creationTime: number;
  userId: string;
  expirationTime: number;
}

interface Fixtures {
  user: UserRow | null;
  session: SessionRow | null;
  userRoles: UserRoleRow[];
}

function makeCtx(fixtures: Fixtures) {
  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (fixtures.user && id === fixtures.user._id) return fixtures.user;
        if (fixtures.session && id === fixtures.session._id) return fixtures.session;
        return null;
      }),
      query: vi.fn((_table: string) => ({
        withIndex: (_indexName: string, _fn: unknown) => ({
          collect: async () => fixtures.userRoles,
        }),
      })),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ctx as any;
}

function makeFixtures(opts: {
  userExists?: boolean;
  roles?: Role[];
  sessionCreatedAt?: number;
  sessionExists?: boolean;
  isActive?: boolean;
}): Fixtures {
  const userId = "users:abc123";
  const sessionId = "authSessions:def456";
  return {
    user: opts.userExists === false
      ? null
      : {
          _id: userId,
          _creationTime: T0 - 1000,
          email: "test@example.com",
          // Default to undefined (treated as active) so the bulk of
          // the existing tests don't need to opt into the field; new
          // deactivation-branch tests pass `isActive: false` explicitly.
          isActive: opts.isActive,
        },
    session: opts.sessionExists === false
      ? null
      : {
          _id: sessionId,
          _creationTime: opts.sessionCreatedAt ?? T0,
          userId,
          expirationTime: T0 + 30 * 24 * HOUR_MS,
        },
    userRoles: (opts.roles ?? []).map((role, idx) => ({
      _id: `userRoles:${idx}`,
      _creationTime: T0,
      userId,
      role,
      grantedAt: T0,
      grantedBy: userId,
    })),
  };
}

function setAuth(opts: { authenticated: boolean }) {
  if (opts.authenticated) {
    mockedGetAuthUserId.mockResolvedValue("users:abc123" as never);
    mockedGetAuthSessionId.mockResolvedValue("authSessions:def456" as never);
  } else {
    mockedGetAuthUserId.mockResolvedValue(null);
    mockedGetAuthSessionId.mockResolvedValue(null);
  }
}

function expectConvexErrorCode(promise: Promise<unknown>, code: string) {
  return expect(promise).rejects.toMatchObject({
    data: { code },
  });
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

describe("ErrorCode + throwError", () => {
  it("throws a ConvexError carrying the given code, message, and details", () => {
    let thrown: unknown;
    try {
      throwError(ErrorCode.FORBIDDEN, "nope", { allowedRoles: ["admin"] });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConvexError);
    const data = (thrown as ConvexError<Value>).data as unknown as ErrorPayload;
    expect(data.code).toBe("FORBIDDEN");
    expect(data.message).toBe("nope");
    expect(data.details).toEqual({ allowedRoles: ["admin"] });
  });

  it("omits details when not provided", () => {
    let thrown: unknown;
    try {
      throwError(ErrorCode.UNAUTHENTICATED, "sign in");
    } catch (e) {
      thrown = e;
    }
    const data = (thrown as ConvexError<Value>).data as unknown as ErrorPayload;
    expect(data.details).toBeUndefined();
  });
});

describe("getCurrentUserAndRoles", () => {
  it("returns null when no auth identity is present", async () => {
    setAuth({ authenticated: false });
    const ctx = makeCtx(makeFixtures({}));
    expect(await getCurrentUserAndRoles(ctx)).toBeNull();
  });

  it("returns null when the user record was deleted but a token persists", async () => {
    setAuth({ authenticated: true });
    const ctx = makeCtx(makeFixtures({ userExists: false }));
    expect(await getCurrentUserAndRoles(ctx)).toBeNull();
  });

  it("returns user + single role on the happy path", async () => {
    setAuth({ authenticated: true });
    const ctx = makeCtx(makeFixtures({ roles: ["admin"] }));
    const result = await getCurrentUserAndRoles(ctx);
    expect(result).not.toBeNull();
    expect(result?.roles).toEqual(["admin"]);
  });

  it("returns multiple roles for multi-role users (FR3)", async () => {
    setAuth({ authenticated: true });
    const ctx = makeCtx(makeFixtures({ roles: ["admin", "office_staff"] }));
    const result = await getCurrentUserAndRoles(ctx);
    expect(result?.roles.sort()).toEqual(["admin", "office_staff"]);
  });

  it("filters out non-Role values defensively", async () => {
    setAuth({ authenticated: true });
    const fixtures = makeFixtures({ roles: ["admin"] });
    fixtures.userRoles.push({
      _id: "userRoles:bogus",
      _creationTime: T0,
      userId: "users:abc123",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      role: "owner" as any,
      grantedAt: T0,
      grantedBy: "users:abc123",
    });
    const ctx = makeCtx(fixtures);
    const result = await getCurrentUserAndRoles(ctx);
    expect(result?.roles).toEqual(["admin"]);
  });
});

describe("requireAuth", () => {
  it("throws UNAUTHENTICATED when no session", async () => {
    setAuth({ authenticated: false });
    const ctx = makeCtx(makeFixtures({}));
    await expectConvexErrorCode(requireAuth(ctx), ErrorCode.UNAUTHENTICATED);
  });

  it("throws INVALID_ROLE when user has no userRoles entries", async () => {
    setAuth({ authenticated: true });
    const ctx = makeCtx(makeFixtures({ roles: [] }));
    await expectConvexErrorCode(requireAuth(ctx), ErrorCode.INVALID_ROLE);
  });

  it("returns the auth payload on the happy path", async () => {
    setAuth({ authenticated: true });
    const ctx = makeCtx(makeFixtures({ roles: ["office_staff"] }));
    const result = await requireAuth(ctx);
    expect(result.roles).toEqual(["office_staff"]);
  });

  it("throws SESSION_EXPIRED when an admin session is older than 1h", async () => {
    setAuth({ authenticated: true });
    vi.setSystemTime(T0 + 90 * 60 * 1000); // 1.5h after creation
    const ctx = makeCtx(makeFixtures({
      roles: ["admin"],
      sessionCreatedAt: T0,
    }));
    await expectConvexErrorCode(requireAuth(ctx), ErrorCode.SESSION_EXPIRED);
  });

  it("uses the SHORTEST timeout when a user holds multiple roles", async () => {
    setAuth({ authenticated: true });
    vi.setSystemTime(T0 + 2 * HOUR_MS); // 2h after creation
    const ctx = makeCtx(makeFixtures({
      roles: ["admin", "office_staff"], // admin 1h vs office_staff 8h → 1h wins
      sessionCreatedAt: T0,
    }));
    await expectConvexErrorCode(requireAuth(ctx), ErrorCode.SESSION_EXPIRED);
  });

  it("accepts an 8h-old office_staff session", async () => {
    setAuth({ authenticated: true });
    vi.setSystemTime(T0 + 7 * HOUR_MS);
    const ctx = makeCtx(makeFixtures({
      roles: ["office_staff"],
      sessionCreatedAt: T0,
    }));
    await expect(requireAuth(ctx)).resolves.toBeDefined();
  });

  it("throws UNAUTHENTICATED if the session record is missing despite a valid user", async () => {
    setAuth({ authenticated: true });
    // No session row → session lookup returns null
    const ctx = makeCtx(makeFixtures({ roles: ["admin"], sessionExists: false }));
    await expectConvexErrorCode(requireAuth(ctx), ErrorCode.UNAUTHENTICATED);
  });

  it("throws UNAUTHENTICATED if Convex Auth has a user but no session id", async () => {
    mockedGetAuthUserId.mockResolvedValue("users:abc123" as never);
    mockedGetAuthSessionId.mockResolvedValue(null);
    const ctx = makeCtx(makeFixtures({ roles: ["admin"] }));
    await expectConvexErrorCode(requireAuth(ctx), ErrorCode.UNAUTHENTICATED);
  });

  it("throws UNAUTHENTICATED when the user is deactivated (Story 1.3, isActive: false)", async () => {
    setAuth({ authenticated: true });
    const ctx = makeCtx(
      makeFixtures({ roles: ["admin"], isActive: false }),
    );
    await expectConvexErrorCode(requireAuth(ctx), ErrorCode.UNAUTHENTICATED);
  });

  it("admits a user whose isActive is explicitly true", async () => {
    setAuth({ authenticated: true });
    const ctx = makeCtx(
      makeFixtures({ roles: ["office_staff"], isActive: true }),
    );
    await expect(requireAuth(ctx)).resolves.toBeDefined();
  });
});

describe("requireRole", () => {
  it("returns the auth payload when caller holds a permitted role", async () => {
    setAuth({ authenticated: true });
    const ctx = makeCtx(makeFixtures({ roles: ["admin"] }));
    const result = await requireRole(ctx, ["admin"]);
    expect(result.roles).toEqual(["admin"]);
  });

  it("returns the payload when caller holds ONE of several permitted roles", async () => {
    setAuth({ authenticated: true });
    const ctx = makeCtx(makeFixtures({ roles: ["office_staff"] }));
    const result = await requireRole(ctx, ["admin", "office_staff"]);
    expect(result.roles).toEqual(["office_staff"]);
  });

  it("throws FORBIDDEN when caller's roles don't intersect allowedRoles", async () => {
    setAuth({ authenticated: true });
    const ctx = makeCtx(makeFixtures({ roles: ["field_worker"] }));
    await expectConvexErrorCode(
      requireRole(ctx, ["admin"]),
      ErrorCode.FORBIDDEN,
    );
  });

  it("FORBIDDEN error includes allowedRoles + callerRoles in details", async () => {
    setAuth({ authenticated: true });
    const ctx = makeCtx(makeFixtures({ roles: ["field_worker"] }));
    const err = await requireRole(ctx, ["admin"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConvexError);
    const data = (err as ConvexError<Value>).data as unknown as ErrorPayload;
    expect(data).toMatchObject({
      code: ErrorCode.FORBIDDEN,
      details: {
        allowedRoles: ["admin"],
        callerRoles: ["field_worker"],
      },
    });
  });

  it("propagates UNAUTHENTICATED through requireAuth", async () => {
    setAuth({ authenticated: false });
    const ctx = makeCtx(makeFixtures({}));
    await expectConvexErrorCode(
      requireRole(ctx, ["admin"]),
      ErrorCode.UNAUTHENTICATED,
    );
  });
});

describe("SESSION_TIMEOUTS table", () => {
  it("matches NFR-S5 (admin 1h, staff 8h, customer 30d)", () => {
    expect(SESSION_TIMEOUTS.admin).toBe(HOUR_MS);
    expect(SESSION_TIMEOUTS.office_staff).toBe(8 * HOUR_MS);
    expect(SESSION_TIMEOUTS.field_worker).toBe(8 * HOUR_MS);
    expect(SESSION_TIMEOUTS.customer).toBe(30 * 24 * HOUR_MS);
  });
});
