/**
 * Story 1.14 — `convex/conditionLogs.ts` unit tests.
 *
 * Same hand-mocked-ctx pattern as `lots.test.ts` (Story 1.8). The
 * Convex `convex-test` harness needs `convex/_generated/`, which this
 * repo deliberately doesn't commit; we reproduce just enough ctx
 * surface area (db.get / db.query / db.insert / storage) to exercise
 * the public mutation + queries end-to-end.
 *
 * Coverage focus:
 *   - Happy-path insert with note + photo + audit emission.
 *   - Role gating (customer rejected, field_worker allowed).
 *   - Validation (empty note, length cap).
 *   - Lot-retired guard.
 *   - Idempotency: same `idempotencyKey` returns the original id with
 *     no duplicate insert and no duplicate audit row.
 *   - `getLotConditionLogPhotoUrl` returns null when no photo, signed
 *     URL when present, throws when called by a customer.
 *   - `listLotConditionLogs` returns the most-recent N rows in order.
 */

import { ConvexError, type Value } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ErrorCode,
  type ErrorPayload,
} from "../../../convex/lib/errors";
import { HOUR_MS } from "../../../convex/lib/time";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import {
  generateLotConditionPhotoUploadUrl,
  getLotConditionLogPhotoUrl,
  listLotConditionLogs,
  logLotCondition,
} from "../../../convex/conditionLogs";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const USER_ID = "users:abc123";
const SESSION_ID = "authSessions:def456";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface LotFixture {
  _id: string;
  _creationTime: number;
  isRetired: boolean;
}

interface LogFixture {
  _id: string;
  _creationTime: number;
  lotId: string;
  loggedBy: string;
  loggedAt: number;
  note: string;
  photoStorageId?: string;
  idempotencyKey?: string;
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
  };
}

interface CtxBag {
  lots: Map<string, LotFixture>;
  logs: Map<string, LogFixture>;
  auditInserts: AuditInsert[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  initialLots?: LotFixture[];
  initialLogs?: LogFixture[];
  authenticated?: boolean;
  storageUrls?: Record<string, string | null>;
}): CtxBag {
  const lots = new Map<string, LotFixture>(
    (opts.initialLots ?? []).map((l) => [l._id, l]),
  );
  const logs = new Map<string, LogFixture>(
    (opts.initialLogs ?? []).map((l) => [l._id, l]),
  );
  const auditInserts: AuditInsert[] = [];

  if (opts.authenticated === false) {
    mockedGetAuthUserId.mockResolvedValue(null);
    mockedGetAuthSessionId.mockResolvedValue(null);
  } else {
    mockedGetAuthUserId.mockResolvedValue(USER_ID as never);
    mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);
  }

  const user = {
    _id: USER_ID,
    _creationTime: T0 - 1000,
    name: "Junior Field",
    email: "junior@example.com",
  };
  const session = {
    _id: SESSION_ID,
    _creationTime: T0,
    userId: USER_ID,
    expirationTime: T0 + 30 * 24 * HOUR_MS,
  };
  const userRoles = (opts.roles ?? ["field_worker"]).map((role, idx) => ({
    _id: `userRoles:${idx}`,
    _creationTime: T0,
    userId: USER_ID,
    role,
    grantedAt: T0,
    grantedBy: USER_ID,
  }));

  let nextId = 1;

  interface IndexQuery {
    eqs: Record<string, unknown>;
    eq(field: string, value: unknown): IndexQuery;
  }

  function makeLogsQueryBuilder() {
    type Predicate = (r: LogFixture) => boolean;
    const predicates: Predicate[] = [];
    let orderDesc = false;
    let indexKey: string | null = null;

    const builder = {
      withIndex(indexName: string, fn: (q: IndexQuery) => IndexQuery) {
        indexKey = indexName;
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
            (r) => (r as unknown as Record<string, unknown>)[field] === value,
          );
        }
        return builder;
      },
      order(direction: "asc" | "desc") {
        orderDesc = direction === "desc";
        return builder;
      },
      async take(limit: number) {
        let rows = Array.from(logs.values()).filter((r) =>
          predicates.every((p) => p(r)),
        );
        if (indexKey === "by_lot_loggedAt") {
          rows = rows.sort((a, b) =>
            orderDesc ? b.loggedAt - a.loggedAt : a.loggedAt - b.loggedAt,
          );
        }
        return rows.slice(0, limit);
      },
      async collect() {
        return Array.from(logs.values()).filter((r) =>
          predicates.every((p) => p(r)),
        );
      },
      async first() {
        const rows = await builder.collect();
        return rows[0] ?? null;
      },
    };
    return builder;
  }

  const ctx = {
    db: {
      get: vi.fn(async (id: string) => {
        if (id === USER_ID) return user;
        if (id === SESSION_ID) return session;
        if (lots.has(id)) return lots.get(id);
        if (logs.has(id)) return logs.get(id);
        return null;
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return {
            withIndex: (_n: string, _f: unknown) => ({
              collect: async () => userRoles,
            }),
          };
        }
        if (table === "lotConditionLogs") {
          return makeLogsQueryBuilder();
        }
        // Fallback for unknown tables
        return {
          withIndex: () => ({
            collect: async () => [],
            first: async () => null,
            take: async () => [],
          }),
        };
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "lotConditionLogs") {
          const id = `lotConditionLogs:${nextId++}`;
          const log = {
            _id: id,
            _creationTime: T0,
            ...row,
          } as LogFixture;
          logs.set(id, log);
          return id;
        }
        if (table === "auditLog") {
          auditInserts.push({
            table,
            row: row as AuditInsert["row"],
          });
          return `auditLog:${auditInserts.length}`;
        }
        return `${table}:?`;
      }),
    },
    storage: {
      generateUploadUrl: vi.fn(async () => "https://example/upload/abc"),
      getUrl: vi.fn(async (sid: string) => {
        const map = opts.storageUrls ?? {};
        return map[sid] ?? `https://example/signed/${sid}`;
      }),
    },
  };

  return { lots, logs, auditInserts, ctx };
}

function makeLotFixture(overrides: Partial<LotFixture> = {}): LotFixture {
  return {
    _id: overrides._id ?? "lots:1",
    _creationTime: T0,
    isRetired: overrides.isRetired ?? false,
    ...overrides,
  };
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

describe("logLotCondition", () => {
  const run = handlerOf(logLotCondition);

  it("inserts a log, emits audit, and returns the new id (field_worker)", async () => {
    const lot = makeLotFixture({ _id: "lots:1" });
    const { ctx, logs, auditInserts } = makeCtx({
      roles: ["field_worker"],
      initialLots: [lot],
    });

    const id = (await run(ctx, {
      lotId: lot._id,
      note: "Lot freshly cleaned, ready for visit.",
      photoStorageId: "_storage:s1",
      idempotencyKey: "uuid-1",
    })) as string;

    expect(logs.size).toBe(1);
    const log = logs.get(id)!;
    expect(log.note).toBe("Lot freshly cleaned, ready for visit.");
    expect(log.photoStorageId).toBe("_storage:s1");
    expect(log.loggedAt).toBe(T0);
    expect(log.loggedBy).toBe(USER_ID);

    expect(auditInserts).toHaveLength(1);
    const audit = auditInserts[0]!;
    expect(audit.row.action).toBe("create");
    expect(audit.row.entityType).toBe("lot");
    expect(audit.row.entityId).toBe(lot._id);
    expect(audit.row.after).toMatchObject({
      hasPhoto: true,
      logId: id,
    });
  });

  it("allows office_staff and admin to log conditions", async () => {
    const lot = makeLotFixture();
    for (const role of ["office_staff", "admin"] as const) {
      const { ctx, logs } = makeCtx({ roles: [role], initialLots: [lot] });
      await run(ctx, {
        lotId: lot._id,
        note: "office check",
        idempotencyKey: `k-${role}`,
      });
      expect(logs.size).toBe(1);
    }
  });

  it("rejects customer role with FORBIDDEN", async () => {
    const lot = makeLotFixture();
    const { ctx } = makeCtx({ roles: ["customer"], initialLots: [lot] });
    const thrown = await run(ctx, {
      lotId: lot._id,
      note: "should not insert",
      idempotencyKey: "k-cust",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const lot = makeLotFixture();
    const { ctx } = makeCtx({ authenticated: false, initialLots: [lot] });
    const thrown = await run(ctx, {
      lotId: lot._id,
      note: "x",
      idempotencyKey: "k-unauth",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("rejects empty / whitespace-only note with VALIDATION", async () => {
    const lot = makeLotFixture();
    const { ctx } = makeCtx({ initialLots: [lot] });
    for (const note of ["", "   ", "\t\n  "]) {
      const thrown = await run(ctx, {
        lotId: lot._id,
        note,
        idempotencyKey: `k-${note}`,
      }).catch((e) => e);
      expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    }
  });

  it("rejects notes longer than 2000 chars with VALIDATION", async () => {
    const lot = makeLotFixture();
    const { ctx } = makeCtx({ initialLots: [lot] });
    const note = "a".repeat(2001);
    const thrown = await run(ctx, {
      lotId: lot._id,
      note,
      idempotencyKey: "k-long",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("throws NOT_FOUND when the lot id doesn't exist", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, {
      lotId: "lots:ghost",
      note: "anything",
      idempotencyKey: "k-ghost",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("refuses to log on a retired lot (INVARIANT_VIOLATION)", async () => {
    const lot = makeLotFixture({ _id: "lots:retired", isRetired: true });
    const { ctx } = makeCtx({ initialLots: [lot] });
    const thrown = await run(ctx, {
      lotId: lot._id,
      note: "x",
      idempotencyKey: "k-retired",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("dedupes on idempotencyKey — second call returns the same id", async () => {
    const lot = makeLotFixture();
    const { ctx, logs, auditInserts } = makeCtx({ initialLots: [lot] });

    const id1 = (await run(ctx, {
      lotId: lot._id,
      note: "first call",
      idempotencyKey: "stable-uuid",
    })) as string;
    const id2 = (await run(ctx, {
      lotId: lot._id,
      note: "second call",
      idempotencyKey: "stable-uuid",
    })) as string;

    expect(id1).toBe(id2);
    expect(logs.size).toBe(1);
    expect(auditInserts).toHaveLength(1);
  });

  it("treats empty idempotency key as no-dedup (back-to-back inserts both land)", async () => {
    const lot = makeLotFixture();
    const { ctx, logs } = makeCtx({ initialLots: [lot] });

    await run(ctx, {
      lotId: lot._id,
      note: "first",
      idempotencyKey: "",
    });
    await run(ctx, {
      lotId: lot._id,
      note: "second",
      idempotencyKey: "",
    });

    expect(logs.size).toBe(2);
  });
});

describe("getLotConditionLogPhotoUrl", () => {
  const run = handlerOf(getLotConditionLogPhotoUrl);

  it("returns the signed URL when the log has a photo", async () => {
    const log: LogFixture = {
      _id: "lotConditionLogs:withPhoto",
      _creationTime: T0,
      lotId: "lots:1",
      loggedBy: USER_ID,
      loggedAt: T0,
      note: "see attached",
      photoStorageId: "_storage:p1",
    };
    const { ctx } = makeCtx({
      initialLogs: [log],
      storageUrls: { "_storage:p1": "https://signed/p1" },
    });
    const url = (await run(ctx, { logId: log._id })) as string | null;
    expect(url).toBe("https://signed/p1");
  });

  it("returns null when the log has no photo", async () => {
    const log: LogFixture = {
      _id: "lotConditionLogs:noPhoto",
      _creationTime: T0,
      lotId: "lots:1",
      loggedBy: USER_ID,
      loggedAt: T0,
      note: "no photo",
    };
    const { ctx } = makeCtx({ initialLogs: [log] });
    const url = await run(ctx, { logId: log._id });
    expect(url).toBeNull();
  });

  it("returns null when the log id doesn't exist", async () => {
    const { ctx } = makeCtx({});
    const url = await run(ctx, { logId: "lotConditionLogs:ghost" });
    expect(url).toBeNull();
  });

  it("rejects customer-role callers with FORBIDDEN", async () => {
    const log: LogFixture = {
      _id: "lotConditionLogs:withPhoto",
      _creationTime: T0,
      lotId: "lots:1",
      loggedBy: USER_ID,
      loggedAt: T0,
      note: "see attached",
      photoStorageId: "_storage:p1",
    };
    const { ctx } = makeCtx({
      roles: ["customer"],
      initialLogs: [log],
    });
    const thrown = await run(ctx, { logId: log._id }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("listLotConditionLogs", () => {
  const run = handlerOf(listLotConditionLogs);

  it("returns the most-recent N rows in descending loggedAt order", async () => {
    const logs: LogFixture[] = [1, 2, 3].map((i) => ({
      _id: `lotConditionLogs:${i}`,
      _creationTime: T0 + i * 1000,
      lotId: "lots:1",
      loggedBy: USER_ID,
      loggedAt: T0 + i * 1000,
      note: `note-${i}`,
    }));
    const { ctx } = makeCtx({ initialLogs: logs });
    const result = (await run(ctx, {
      lotId: "lots:1",
      limit: 10,
    })) as Array<{ _id: string }>;
    expect(result.map((r) => r._id)).toEqual([
      "lotConditionLogs:3",
      "lotConditionLogs:2",
      "lotConditionLogs:1",
    ]);
  });

  it("augments each row with loggedByName from the user record", async () => {
    const log: LogFixture = {
      _id: "lotConditionLogs:1",
      _creationTime: T0,
      lotId: "lots:1",
      loggedBy: USER_ID,
      loggedAt: T0,
      note: "x",
    };
    const { ctx } = makeCtx({ initialLogs: [log] });
    const result = (await run(ctx, { lotId: "lots:1" })) as Array<{
      loggedByName: string | null;
    }>;
    expect(result[0]?.loggedByName).toBe("Junior Field");
  });

  it("defaults limit to 10 when not provided", async () => {
    const logs: LogFixture[] = Array.from({ length: 15 }, (_, i) => ({
      _id: `lotConditionLogs:${i + 1}`,
      _creationTime: T0 + i,
      lotId: "lots:1",
      loggedBy: USER_ID,
      loggedAt: T0 + i,
      note: "x",
    }));
    const { ctx } = makeCtx({ initialLogs: logs });
    const result = (await run(ctx, { lotId: "lots:1" })) as unknown[];
    expect(result).toHaveLength(10);
  });

  it("rejects customer role", async () => {
    const { ctx } = makeCtx({ roles: ["customer"] });
    const thrown = await run(ctx, { lotId: "lots:1" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("generateLotConditionPhotoUploadUrl", () => {
  const run = handlerOf(generateLotConditionPhotoUploadUrl);

  it("returns a short-lived upload URL for field workers", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    const url = (await run(ctx, {})) as string;
    expect(url).toBe("https://example/upload/abc");
  });

  it("rejects customer role with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["customer"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});
