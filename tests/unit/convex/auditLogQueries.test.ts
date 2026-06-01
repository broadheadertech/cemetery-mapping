/**
 * Story 6.5 — `convex/auditLogQueries.ts` unit tests.
 *
 * Hand-mocked ctx, same pattern as `users.test.ts` / `interments.test.ts`
 * (convex-test requires `_generated/` which is not built in this repo).
 * The mock implements just enough of `ctx.db` to drive the three
 * queries end-to-end: `query(table).withIndex(...).order(...).paginate(...)`
 * plus `db.get(userId)` for actor-name projection.
 *
 * Coverage focus (per Story 6.5 read-only scope):
 *   - `requireRole(ctx, ["admin"])` is the first line of every handler
 *     (FORBIDDEN for non-admin, UNAUTHENTICATED for missing session)
 *   - `listRecent` returns rows newest-first, projects actorName,
 *     respects pagination clamp, surfaces continuation cursor.
 *   - `listByEntity` filters by entityType + entityId.
 *   - `listByActor` filters by actor.
 *   - Pagination size is clamped to MAX_PAGE_SIZE.
 *   - The handlers NEVER call `ctx.db.insert / patch / replace /
 *     delete` against `auditLog` — append-only invariant.
 *
 * The PII redaction test is in the Story 1.6 emitAudit unit spec —
 * the read path here just returns the stored (already-redacted)
 * values, so verifying that here would be a tautology.
 */

import { ConvexError, type Value } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCode, type ErrorPayload } from "../../../convex/lib/errors";
import { HOUR_MS } from "../../../convex/lib/time";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import {
  listByActor,
  listByEntity,
  listRecent,
  MAX_PAGE_SIZE,
} from "../../../convex/auditLogQueries";

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
}

interface AuditLogFixture {
  _id: string;
  _creationTime: number;
  actor: string;
  timestamp: number;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

interface UserRoleFixture {
  _id: string;
  _creationTime: number;
  userId: string;
  role: RoleName;
  grantedAt: number;
  grantedBy: string;
}

interface CtxBag {
  users: Map<string, UserFixture>;
  userRoles: Map<string, UserRoleFixture>;
  auditLog: Map<string, AuditLogFixture>;
  inserts: Array<{ table: string; row: Record<string, unknown> }>;
  patches: Array<{ id: string; patch: Record<string, unknown> }>;
  deletes: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  callerRoles?: RoleName[];
  callerId?: string;
  callerIsActive?: boolean;
  authenticated?: boolean;
  initialUsers?: UserFixture[];
  initialAuditRows?: AuditLogFixture[];
}): CtxBag {
  const users = new Map<string, UserFixture>();
  const userRoles = new Map<string, UserRoleFixture>();
  const auditLog = new Map<string, AuditLogFixture>(
    (opts.initialAuditRows ?? []).map((r) => [r._id, r]),
  );

  const callerId = opts.callerId ?? ADMIN_ID;
  const callerRoles = opts.callerRoles ?? ["admin"];

  users.set(callerId, {
    _id: callerId,
    _creationTime: T0 - 1000,
    name: "Caller Admin",
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

  type Predicate = (r: AuditLogFixture) => boolean;
  type Comparator = (a: AuditLogFixture, b: AuditLogFixture) => number;

  function makeQueryBuilder(table: string) {
    const predicates: Predicate[] = [];
    let comparator: Comparator = (a, b) =>
      (b.timestamp ?? 0) - (a.timestamp ?? 0); // default newest-first

    let rows: Map<string, AuditLogFixture | UserFixture | UserRoleFixture>;
    if (table === "auditLog")
      rows = auditLog as Map<
        string,
        AuditLogFixture | UserFixture | UserRoleFixture
      >;
    else if (table === "users")
      rows = users as Map<string, AuditLogFixture | UserFixture | UserRoleFixture>;
    else if (table === "userRoles")
      rows = userRoles as Map<
        string,
        AuditLogFixture | UserFixture | UserRoleFixture
      >;
    else rows = new Map();

    const builder = {
      withIndex(
        indexName: string,
        fn?: (q: IndexQuery) => IndexQuery,
      ) {
        const q: IndexQuery = {
          eqs: {},
          eq(field: string, value: unknown) {
            this.eqs[field] = value;
            return this;
          },
        };
        if (fn) fn(q);
        for (const [field, value] of Object.entries(q.eqs)) {
          predicates.push(
            (r) => (r as unknown as Record<string, unknown>)[field] === value,
          );
        }
        // Pre-set the default order: by_timestamp index sorts by
        // timestamp asc; by_entity / by_actor end on timestamp asc.
        if (
          indexName === "by_timestamp" ||
          indexName === "by_entity" ||
          indexName === "by_actor"
        ) {
          comparator = (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0);
        }
        return builder;
      },
      order(direction: "asc" | "desc") {
        if (direction === "desc") {
          const prev = comparator;
          comparator = (a, b) => -prev(a, b);
        }
        return builder;
      },
      async first(): Promise<AuditLogFixture | null> {
        const filtered = filterRows();
        const sorted = filtered.sort(comparator);
        return sorted[0] ?? null;
      },
      async collect(): Promise<AuditLogFixture[]> {
        const filtered = filterRows();
        return filtered.sort(comparator);
      },
      async take(n: number): Promise<AuditLogFixture[]> {
        const filtered = filterRows();
        return filtered.sort(comparator).slice(0, n);
      },
      async paginate(opts: {
        numItems: number;
        cursor: string | null;
      }): Promise<{
        page: AuditLogFixture[];
        isDone: boolean;
        continueCursor: string;
      }> {
        const filtered = filterRows();
        const sorted = filtered.sort(comparator);
        // Cursor is the index into the sorted list (encoded as string).
        const start =
          opts.cursor === null ? 0 : Number.parseInt(opts.cursor, 10);
        const end = start + opts.numItems;
        const page = sorted.slice(start, end);
        const isDone = end >= sorted.length;
        return {
          page,
          isDone,
          continueCursor: String(end),
        };
      },
    };

    function filterRows(): AuditLogFixture[] {
      return Array.from(rows.values()).filter((r) =>
        predicates.every((p) => p(r as AuditLogFixture)),
      ) as AuditLogFixture[];
    }
    return builder;
  }

  interface IndexQuery {
    eqs: Record<string, unknown>;
    eq(field: string, value: unknown): IndexQuery;
  }

  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const deletes: string[] = [];

  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === SESSION_ID) return session;
        if (users.has(id)) return users.get(id);
        if (userRoles.has(id)) return userRoles.get(id);
        if (auditLog.has(id)) return auditLog.get(id);
        return null;
      }),
      query: vi.fn((table: string) => makeQueryBuilder(table)),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        inserts.push({ table, row });
        return `${table}:inserted`;
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        patches.push({ id, patch });
      }),
      delete: vi.fn(async (id: string) => {
        deletes.push(id);
      }),
    },
  };

  return { users, userRoles, auditLog, inserts, patches, deletes, ctx };
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

function seedAuditRows(count: number, opts?: {
  actorOverride?: (i: number) => string;
  entityTypeOverride?: (i: number) => string;
  entityIdOverride?: (i: number) => string;
}): AuditLogFixture[] {
  const rows: AuditLogFixture[] = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      _id: `auditLog:${i}`,
      _creationTime: T0 - i * 1000,
      actor: opts?.actorOverride?.(i) ?? ADMIN_ID,
      timestamp: T0 - i * 1000,
      action: "update",
      entityType: opts?.entityTypeOverride?.(i) ?? "lot",
      entityId: opts?.entityIdOverride?.(i) ?? `lots:${i}`,
      before: { status: "available" },
      after: { status: "sold" },
    });
  }
  return rows;
}

describe("listRecent", () => {
  const run = handlerOf(listRecent);

  it("rejects non-admin callers with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ callerRoles: ["office_staff"] });
    const thrown = await run(ctx, {
      paginationOpts: { numItems: 50, cursor: null },
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers with UNAUTHENTICATED", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {
      paginationOpts: { numItems: 50, cursor: null },
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("returns rows newest-first with actor name projected", async () => {
    const auditRows = seedAuditRows(3);
    const { ctx } = makeCtx({ initialAuditRows: auditRows });
    const result = (await run(ctx, {
      paginationOpts: { numItems: 50, cursor: null },
    })) as { page: Array<{ _id: string; actorName: string | null; timestamp: number }> };
    expect(result.page).toHaveLength(3);
    // Newest first — the seed creates rows with descending timestamps
    // (i=0 newest, i=2 oldest).
    expect(result.page[0]!._id).toBe("auditLog:0");
    expect(result.page[2]!._id).toBe("auditLog:2");
    // Actor name is projected from the user table.
    expect(result.page[0]!.actorName).toBe("Caller Admin");
  });

  it("returns null actorName when the user document is missing", async () => {
    const ghostId = "users:ghost";
    const auditRows = seedAuditRows(1, { actorOverride: () => ghostId });
    const { ctx } = makeCtx({ initialAuditRows: auditRows });
    const result = (await run(ctx, {
      paginationOpts: { numItems: 50, cursor: null },
    })) as { page: Array<{ actorName: string | null }> };
    expect(result.page[0]!.actorName).toBeNull();
  });

  it("falls back to email when name is absent", async () => {
    const auditRows = seedAuditRows(1, { actorOverride: () => "users:onlyEmail" });
    const { ctx } = makeCtx({
      initialAuditRows: auditRows,
      initialUsers: [
        {
          _id: "users:onlyEmail",
          _creationTime: T0,
          email: "fallback@example.com",
        },
      ],
    });
    const result = (await run(ctx, {
      paginationOpts: { numItems: 50, cursor: null },
    })) as { page: Array<{ actorName: string | null }> };
    expect(result.page[0]!.actorName).toBe("fallback@example.com");
  });

  it("clamps numItems above MAX_PAGE_SIZE", async () => {
    const auditRows = seedAuditRows(150);
    const { ctx } = makeCtx({ initialAuditRows: auditRows });
    const result = (await run(ctx, {
      paginationOpts: { numItems: 9999, cursor: null },
    })) as { page: unknown[]; isDone: boolean };
    expect(result.page.length).toBe(MAX_PAGE_SIZE);
    expect(result.isDone).toBe(false);
  });

  it("clamps numItems below 1 to at least 1", async () => {
    const auditRows = seedAuditRows(3);
    const { ctx } = makeCtx({ initialAuditRows: auditRows });
    const result = (await run(ctx, {
      paginationOpts: { numItems: 0, cursor: null },
    })) as { page: unknown[] };
    expect(result.page.length).toBe(1);
  });

  it("paginates via continuation cursor", async () => {
    const auditRows = seedAuditRows(5);
    const { ctx } = makeCtx({ initialAuditRows: auditRows });
    const first = (await run(ctx, {
      paginationOpts: { numItems: 2, cursor: null },
    })) as { page: Array<{ _id: string }>; isDone: boolean; continueCursor: string };
    expect(first.page.map((r) => r._id)).toEqual([
      "auditLog:0",
      "auditLog:1",
    ]);
    expect(first.isDone).toBe(false);
    const second = (await run(ctx, {
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    })) as { page: Array<{ _id: string }>; isDone: boolean };
    expect(second.page.map((r) => r._id)).toEqual([
      "auditLog:2",
      "auditLog:3",
    ]);
    expect(second.isDone).toBe(false);
  });

  it("never writes to auditLog (append-only invariant)", async () => {
    const auditRows = seedAuditRows(2);
    const { ctx, inserts, patches, deletes } = makeCtx({
      initialAuditRows: auditRows,
    });
    await run(ctx, {
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(inserts).toHaveLength(0);
    expect(patches).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  });
});

describe("listByEntity", () => {
  const run = handlerOf(listByEntity);

  it("rejects non-admin with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ callerRoles: ["office_staff"] });
    const thrown = await run(ctx, {
      entityType: "lot",
      entityId: "lots:1",
      paginationOpts: { numItems: 50, cursor: null },
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("filters to the matching entity and returns newest-first", async () => {
    const auditRows = seedAuditRows(6, {
      entityIdOverride: (i) => (i < 3 ? "lots:target" : "lots:other"),
    });
    const { ctx } = makeCtx({ initialAuditRows: auditRows });
    const result = (await run(ctx, {
      entityType: "lot",
      entityId: "lots:target",
      paginationOpts: { numItems: 50, cursor: null },
    })) as { page: Array<{ _id: string; entityId: string }> };
    expect(result.page).toHaveLength(3);
    for (const row of result.page) {
      expect(row.entityId).toBe("lots:target");
    }
    // Newest first.
    expect(result.page[0]!._id).toBe("auditLog:0");
  });

  it("returns empty when no rows match the entity filter", async () => {
    const auditRows = seedAuditRows(3);
    const { ctx } = makeCtx({ initialAuditRows: auditRows });
    const result = (await run(ctx, {
      entityType: "customer",
      entityId: "customers:doesnotexist",
      paginationOpts: { numItems: 50, cursor: null },
    })) as { page: unknown[]; isDone: boolean };
    expect(result.page).toHaveLength(0);
    expect(result.isDone).toBe(true);
  });
});

describe("listByActor", () => {
  const run = handlerOf(listByActor);

  it("rejects non-admin with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ callerRoles: ["office_staff"] });
    const thrown = await run(ctx, {
      actorUserId: ADMIN_ID,
      paginationOpts: { numItems: 50, cursor: null },
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("filters to rows by the requested actor", async () => {
    const actorA = "users:alpha";
    const actorB = "users:beta";
    const auditRows = seedAuditRows(6, {
      actorOverride: (i) => (i % 2 === 0 ? actorA : actorB),
    });
    const { ctx } = makeCtx({
      initialAuditRows: auditRows,
      initialUsers: [
        { _id: actorA, _creationTime: T0, name: "Alpha" },
        { _id: actorB, _creationTime: T0, name: "Beta" },
      ],
    });
    const result = (await run(ctx, {
      actorUserId: actorA,
      paginationOpts: { numItems: 50, cursor: null },
    })) as { page: Array<{ actor: string; actorName: string | null }> };
    expect(result.page.length).toBe(3);
    for (const row of result.page) {
      expect(row.actor).toBe(actorA);
      expect(row.actorName).toBe("Alpha");
    }
  });

  it("returns empty for an actor with no rows", async () => {
    const auditRows = seedAuditRows(3);
    const { ctx } = makeCtx({ initialAuditRows: auditRows });
    const result = (await run(ctx, {
      actorUserId: "users:nobody",
      paginationOpts: { numItems: 50, cursor: null },
    })) as { page: unknown[]; isDone: boolean };
    expect(result.page).toHaveLength(0);
    expect(result.isDone).toBe(true);
  });
});
