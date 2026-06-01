/**
 * Story 2.3 — PII-access logging side-effect helper unit tests.
 *
 * Coverage target: 100% line + branch on `convex/lib/piiAccess.ts`.
 * The helper is a thin delegation onto `emitAudit`, but it is
 * compliance-cornerstone (FR64, NFR-S8) — every PII-surfacing query /
 * mutation downstream relies on it doing exactly what these tests
 * describe.
 *
 * Why hand-mocked ctx instead of `convex-test`:
 *   Mirrors the pattern in `tests/unit/convex/lib/audit.test.ts` —
 *   `convex-test` requires `convex/_generated/` to exist on disk, and
 *   that directory only appears after the user runs the interactive
 *   `npx convex dev` once. Hand-mocked ctx keeps CI green from the
 *   first commit and is sufficient to lock in the contract.
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
  type ErrorPayload,
} from "../../../../convex/lib/errors";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { logPiiAccess } from "../../../../convex/lib/piiAccess";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const USER_ID = "users:abc123";
const SESSION_ID = "authSessions:def456";

interface InsertedRow {
  actor: string;
  timestamp: number;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

interface MutationCtxMock {
  inserts: Array<{ table: string; row: InsertedRow }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeMutationCtx(opts: {
  authenticated?: boolean;
  userExists?: boolean;
}): MutationCtxMock {
  const inserts: Array<{ table: string; row: InsertedRow }> = [];
  const fixtures = {
    user:
      opts.userExists === false
        ? null
        : { _id: USER_ID, _creationTime: T0 - 1000, email: "test@example.com" },
    session: {
      _id: SESSION_ID,
      _creationTime: T0,
      userId: USER_ID,
      expirationTime: T0 + 30 * 24 * 60 * 60 * 1000,
    },
    userRoles: [
      {
        _id: "userRoles:0",
        _creationTime: T0,
        userId: USER_ID,
        role: "office_staff" as const,
        grantedAt: T0,
        grantedBy: USER_ID,
      },
    ],
  };

  if (opts.authenticated === false) {
    mockedGetAuthUserId.mockResolvedValue(null);
    mockedGetAuthSessionId.mockResolvedValue(null);
  } else {
    mockedGetAuthUserId.mockResolvedValue(USER_ID as never);
    mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);
  }

  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (fixtures.user && id === fixtures.user._id) return fixtures.user;
        if (id === fixtures.session._id) return fixtures.session;
        return null;
      }),
      query: vi.fn((_table: string) => ({
        withIndex: (_indexName: string, _fn: unknown) => ({
          collect: async () => fixtures.userRoles,
        }),
      })),
      insert: vi.fn(async (table: string, row: InsertedRow) => {
        inserts.push({ table, row });
        return `${table}:row${inserts.length}`;
      }),
    },
  };

  return { inserts, ctx };
}

function makeActionCtx() {
  return {
    runMutation: vi.fn(),
    runQuery: vi.fn(),
    runAction: vi.fn(),
    auth: { getUserIdentity: vi.fn() },
    scheduler: { runAfter: vi.fn(), runAt: vi.fn() },
    storage: { generateUploadUrl: vi.fn(), getUrl: vi.fn() },
  };
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

describe("logPiiAccess — MutationCtx happy path", () => {
  it("inserts a piiAccess audit row with the canonical entity ref", async () => {
    const { ctx, inserts } = makeMutationCtx({});
    await logPiiAccess(ctx, {
      entityType: "customer",
      entityId: "abc123",
      fields: ["govIdNumber"],
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toEqual({
      table: "auditLog",
      row: {
        actor: USER_ID,
        timestamp: T0,
        action: "read_pii",
        entityType: "piiAccess",
        entityId: "customer:abc123",
        after: { fieldsRead: ["govIdNumber"] },
      },
    });
  });

  it("writes multiple fields under fieldsRead", async () => {
    const { ctx, inserts } = makeMutationCtx({});
    await logPiiAccess(ctx, {
      entityType: "customer",
      entityId: "xyz789",
      fields: ["govIdNumber", "fullAddress"],
    });
    expect(inserts[0]!.row.after).toEqual({
      fieldsRead: ["govIdNumber", "fullAddress"],
    });
  });

  it("defaults fieldsRead to [] when fields is omitted (file-view case)", async () => {
    const { ctx, inserts } = makeMutationCtx({});
    await logPiiAccess(ctx, {
      entityType: "customerAttachment",
      entityId: "att555",
    });
    expect(inserts[0]!.row.after).toEqual({ fieldsRead: [] });
  });

  it("passes `reason` through verbatim (never redacted — caller-controlled)", async () => {
    const { ctx, inserts } = makeMutationCtx({});
    await logPiiAccess(ctx, {
      entityType: "customer",
      entityId: "abc123",
      fields: ["govIdNumber"],
      reason: "customer detail page open",
    });
    expect(inserts[0]!.row.reason).toBe("customer detail page open");
  });

  it("omits reason from the inserted row when not provided", async () => {
    const { ctx, inserts } = makeMutationCtx({});
    await logPiiAccess(ctx, {
      entityType: "customer",
      entityId: "abc123",
      fields: ["govIdNumber"],
    });
    expect("reason" in inserts[0]!.row).toBe(false);
  });

  it("supports polymorphic entity types via the entityId ref", async () => {
    // Any future entity that surfaces PII can call the helper without
    // a schema migration — the `auditLog.entityType` stays "piiAccess"
    // and the caller-domain type lives in the entityId prefix.
    const { ctx, inserts } = makeMutationCtx({});
    await logPiiAccess(ctx, {
      entityType: "contract",
      entityId: "cont001",
      fields: ["govIdNumber"],
    });
    await logPiiAccess(ctx, {
      entityType: "ownership",
      entityId: "own042",
      fields: ["fullAddress"],
    });
    expect(inserts.map((i) => i.row.entityId)).toEqual([
      "contract:cont001",
      "ownership:own042",
    ]);
    expect(inserts.every((i) => i.row.entityType === "piiAccess")).toBe(true);
  });

  it("uses `read_pii` as the action so AUDIT_ACTIONS validation passes", async () => {
    const { ctx, inserts } = makeMutationCtx({});
    await logPiiAccess(ctx, {
      entityType: "customer",
      entityId: "abc123",
      fields: ["govIdNumber"],
    });
    expect(inserts[0]!.row.action).toBe("read_pii");
  });

  it("uses `Date.now()` for the timestamp on the underlying audit row", async () => {
    const { ctx, inserts } = makeMutationCtx({});
    vi.setSystemTime(T0 + 12345);
    await logPiiAccess(ctx, {
      entityType: "customer",
      entityId: "abc123",
      fields: ["govIdNumber"],
    });
    expect(inserts[0]!.row.timestamp).toBe(T0 + 12345);
  });

  it("returns void (resolves with undefined)", async () => {
    const { ctx } = makeMutationCtx({});
    const result = await logPiiAccess(ctx, {
      entityType: "customer",
      entityId: "abc123",
      fields: ["govIdNumber"],
    });
    expect(result).toBeUndefined();
  });
});

describe("logPiiAccess — error paths", () => {
  it("throws UNAUTHENTICATED when no auth identity", async () => {
    const { ctx } = makeMutationCtx({ authenticated: false });
    await expectConvexErrorCode(
      logPiiAccess(ctx, {
        entityType: "customer",
        entityId: "abc123",
        fields: ["govIdNumber"],
      }),
      ErrorCode.UNAUTHENTICATED,
    );
  });

  it("throws UNAUTHENTICATED when the user record is missing", async () => {
    const { ctx } = makeMutationCtx({ userExists: false });
    await expectConvexErrorCode(
      logPiiAccess(ctx, {
        entityType: "customer",
        entityId: "abc123",
        fields: ["govIdNumber"],
      }),
      ErrorCode.UNAUTHENTICATED,
    );
  });

  it("does NOT write a row when auth fails", async () => {
    const { ctx, inserts } = makeMutationCtx({ authenticated: false });
    await logPiiAccess(ctx, {
      entityType: "customer",
      entityId: "abc123",
      fields: ["govIdNumber"],
    }).catch(() => undefined);
    expect(inserts).toHaveLength(0);
  });

  it("surfaces an explicit error message on UNAUTHENTICATED so audit operators know why", async () => {
    const { ctx } = makeMutationCtx({ authenticated: false });
    const err = await logPiiAccess(ctx, {
      entityType: "customer",
      entityId: "abc123",
      fields: ["govIdNumber"],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConvexError);
    const data = (err as ConvexError<Value>).data as unknown as ErrorPayload;
    expect(data.code).toBe(ErrorCode.UNAUTHENTICATED);
    expect(data.message).toMatch(/unauthenticated/i);
  });
});

describe("logPiiAccess — ActionCtx transport gap", () => {
  it("throws INVARIANT_VIOLATION until convex/_generated/ exists (Story 2.3 follow-up)", async () => {
    const actionCtx = makeActionCtx();
    const err = await logPiiAccess(
      // Cast: the test deliberately exercises the ActionCtx branch
      // with a structurally minimal mock. The runtime branch only
      // checks for the absence of `db`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      actionCtx as any,
      {
        entityType: "customer",
        entityId: "abc123",
        fields: ["govIdNumber"],
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConvexError);
    const data = (err as ConvexError<Value>).data as unknown as ErrorPayload;
    expect(data.code).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(data.message).toMatch(/internal-mutation/i);
  });
});
