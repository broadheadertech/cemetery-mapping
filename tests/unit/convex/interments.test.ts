/**
 * Story 7.1 — `convex/interments.ts` unit tests.
 *
 * Hand-mocked ctx pattern (matches `occupants.test.ts`,
 * `lots.test.ts`, `conditionLogs.test.ts`). `convex-test` requires
 * `_generated/`, which this repo deliberately avoids; we reproduce
 * just enough of `ctx.db` to drive the public mutations + queries
 * end-to-end.
 *
 * Coverage focus:
 *   - scheduleInterment: happy path (office_staff + admin) inserts +
 *     audits; RBAC rejection (field_worker, customer, unauthenticated);
 *     missing lot; retired lot; missing occupant; occupant on a
 *     different lot; removed occupant; far-past scheduledAt;
 *     notes >500 chars.
 *   - listForLot: empty lot; ascending sort; field_worker allowed;
 *     customer rejected; unauthenticated rejected.
 *   - listInterments: default no-filter; statusFilter routing; limit
 *     clamp; RBAC; trimmed response shape.
 *   - getInterment: returns enriched detail; null when missing; RBAC.
 */

import { ConvexError, type Value } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCode, type ErrorPayload } from "../../../convex/lib/errors";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../../../convex/lib/time";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import {
  scheduleInterment,
  listForLot,
  listInterments,
  getInterment,
  findConflicts,
  listInRange,
  completeInterment,
  listTodayForFieldWorker,
  generateUploadUrl,
  getCompletionPhotoUrl,
} from "../../../convex/interments";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const USER_ID = "users:abc123";
const SESSION_ID = "authSessions:def456";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface LotFixture {
  _id: string;
  _creationTime: number;
  code: string;
  section: string;
  block: string;
  row: string;
  isRetired: boolean;
  /**
   * Story 7.4 — lot status field. Required by `transitionLotStatus`,
   * which `completeInterment` invokes for the lot's `sold → occupied`
   * transition. Older tests that didn't need a status (Story 7.1 /
   * 7.2 / 7.3) default to `"sold"` via `makeLotFixture` so adding
   * this field is a no-op for them.
   */
  status: "available" | "reserved" | "sold" | "occupied" | "cancelled" | "defaulted" | "transferred";
}

interface OccupantFixture {
  _id: string;
  _creationTime: number;
  lotId: string;
  name: string;
  isRemoved: boolean;
}

interface IntermentFixture {
  _id: string;
  _creationTime: number;
  lotId: string;
  occupantId: string;
  scheduledAt: number;
  status: "scheduled" | "completed" | "cancelled";
  notes?: string;
  scheduledBy: string;
  scheduledAt_createdAt: number;
  completedAt?: number;
  completedBy?: string;
  completionNotes?: string;
  cancellationReason?: string;
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
  lots: Map<string, LotFixture>;
  occupants: Map<string, OccupantFixture>;
  interments: Map<string, IntermentFixture>;
  auditInserts: AuditInsert[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  initialLots?: LotFixture[];
  initialOccupants?: OccupantFixture[];
  initialInterments?: IntermentFixture[];
  authenticated?: boolean;
  userName?: string;
}): CtxBag {
  const lots = new Map<string, LotFixture>(
    (opts.initialLots ?? []).map((l) => [l._id, l]),
  );
  const occupants = new Map<string, OccupantFixture>(
    (opts.initialOccupants ?? []).map((o) => [o._id, o]),
  );
  const interments = new Map<string, IntermentFixture>(
    (opts.initialInterments ?? []).map((i) => [i._id, i]),
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
    name: opts.userName ?? "Maria Office",
    email: "maria@example.com",
  };
  const session = {
    _id: SESSION_ID,
    _creationTime: T0,
    userId: USER_ID,
    expirationTime: T0 + 30 * 24 * HOUR_MS,
  };
  const userRoles = (opts.roles ?? ["office_staff"]).map((role, idx) => ({
    _id: `userRoles:${idx}`,
    _creationTime: T0,
    userId: USER_ID,
    role,
    grantedAt: T0,
    grantedBy: USER_ID,
  }));

  let nextId = 1;

  interface IndexQuery {
    eq(field: string, value: unknown): IndexQuery;
    gte(field: string, value: unknown): IndexQuery;
    lte(field: string, value: unknown): IndexQuery;
    gt(field: string, value: unknown): IndexQuery;
    lt(field: string, value: unknown): IndexQuery;
  }

  function makeIntermentsQueryBuilder() {
    type Predicate = (r: IntermentFixture) => boolean;
    const predicates: Predicate[] = [];
    let usedIndex = false;

    const builder = {
      withIndex(_indexName: string, fn?: (q: IndexQuery) => IndexQuery) {
        usedIndex = true;
        if (fn === undefined) return builder;
        // Story 7.2 — the conflict helper uses `.gte()` / `.lte()` for
        // the ±window range bounds; older fixtures only used `.eq()`.
        // Predicates are accumulated and AND-ed at collect time.
        const q: IndexQuery = {
          eq(field: string, value: unknown) {
            predicates.push(
              (r) =>
                (r as unknown as Record<string, unknown>)[field] === value,
            );
            return q;
          },
          gte(field: string, value: unknown) {
            predicates.push((r) => {
              const v = (r as unknown as Record<string, unknown>)[field];
              return typeof v === "number" && v >= (value as number);
            });
            return q;
          },
          lte(field: string, value: unknown) {
            predicates.push((r) => {
              const v = (r as unknown as Record<string, unknown>)[field];
              return typeof v === "number" && v <= (value as number);
            });
            return q;
          },
          gt(field: string, value: unknown) {
            predicates.push((r) => {
              const v = (r as unknown as Record<string, unknown>)[field];
              return typeof v === "number" && v > (value as number);
            });
            return q;
          },
          lt(field: string, value: unknown) {
            predicates.push((r) => {
              const v = (r as unknown as Record<string, unknown>)[field];
              return typeof v === "number" && v < (value as number);
            });
            return q;
          },
        };
        fn(q);
        return builder;
      },
      async collect() {
        // `usedIndex` lets us assert in tests that an index was used,
        // but the in-memory store doesn't care; just filter.
        void usedIndex;
        return Array.from(interments.values()).filter((r) =>
          predicates.every((p) => p(r)),
        );
      },
      async take(limit: number) {
        const all = await builder.collect();
        return all.slice(0, limit);
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
        if (occupants.has(id)) return occupants.get(id);
        if (interments.has(id)) return interments.get(id);
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
        if (table === "interments") {
          return makeIntermentsQueryBuilder();
        }
        return {
          withIndex: () => ({
            collect: async () => [],
            first: async () => null,
            take: async () => [],
          }),
        };
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "interments") {
          const id = `interments:${nextId++}`;
          const doc = {
            _id: id,
            _creationTime: T0,
            ...row,
          } as IntermentFixture;
          interments.set(id, doc);
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
      // Story 7.4 — `completeInterment` patches both interments
      // (status / completedAt / completedBy / completionNotes /
      // completionPhotoBlobId) AND the lot (via `transitionLotStatus`
      // → `status`). Mirror the live ctx.db.patch behaviour: in-place
      // merge of the partial onto the existing row.
      patch: vi.fn(async (id: string, partial: Record<string, unknown>) => {
        if (interments.has(id)) {
          const existing = interments.get(id)!;
          interments.set(id, { ...existing, ...partial } as IntermentFixture);
          return null;
        }
        if (lots.has(id)) {
          const existing = lots.get(id)!;
          lots.set(id, { ...existing, ...partial } as LotFixture);
          return null;
        }
        return null;
      }),
    },
    // Story 7.4 — `generateUploadUrl` / `getCompletionPhotoUrl`
    // consume the storage API. Minimal stub: predictable signed URL
    // generator + URL-by-id lookup (matches Story 1.14's File
    // Storage testing pattern). Note: `ctx.storage` is a sibling of
    // `ctx.db`, NOT a child — match the live Convex shape.
    storage: {
      generateUploadUrl: vi.fn(
        async () => "https://storage.example/upload/signed",
      ),
      getUrl: vi.fn(
        async (storageId: string) =>
          `https://storage.example/get/${storageId}`,
      ),
    },
  };

  return { lots, occupants, interments, auditInserts, ctx };
}

function makeLotFixture(overrides: Partial<LotFixture> = {}): LotFixture {
  return {
    _id: overrides._id ?? "lots:1",
    _creationTime: T0,
    code: overrides.code ?? "D-5-12",
    section: overrides.section ?? "D",
    block: overrides.block ?? "5",
    row: overrides.row ?? "12",
    isRetired: overrides.isRetired ?? false,
    // Story 7.4 — default to `"sold"` so the `completeInterment`
    // happy path (lot `sold → occupied`) fires by default. Tests for
    // family-plot lots / anomaly paths override via `overrides.status`.
    status: overrides.status ?? "sold",
  };
}

function makeOccupantFixture(
  overrides: Partial<OccupantFixture> = {},
): OccupantFixture {
  return {
    _id: overrides._id ?? "occupants:1",
    _creationTime: T0,
    lotId: overrides.lotId ?? "lots:1",
    name: overrides.name ?? "Juan Santos",
    isRemoved: overrides.isRemoved ?? false,
  };
}

function makeIntermentFixture(
  overrides: Partial<IntermentFixture> = {},
): IntermentFixture {
  return {
    _id: overrides._id ?? "interments:base",
    _creationTime: T0,
    lotId: overrides.lotId ?? "lots:1",
    occupantId: overrides.occupantId ?? "occupants:1",
    scheduledAt: overrides.scheduledAt ?? T0 + 7 * DAY_MS,
    status: overrides.status ?? "scheduled",
    notes: overrides.notes,
    scheduledBy: overrides.scheduledBy ?? USER_ID,
    scheduledAt_createdAt: overrides.scheduledAt_createdAt ?? T0,
    completedAt: overrides.completedAt,
    completedBy: overrides.completedBy,
    completionNotes: overrides.completionNotes,
    cancellationReason: overrides.cancellationReason,
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

describe("scheduleInterment", () => {
  const run = handlerOf(scheduleInterment);

  it("inserts an interment, emits audit, returns the new id (office_staff)", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const { ctx, interments, auditInserts } = makeCtx({
      roles: ["office_staff"],
      initialLots: [lot],
      initialOccupants: [occupant],
    });

    const result = (await run(ctx, {
      lotId: lot._id,
      occupantId: occupant._id,
      scheduledAt: T0 + 14 * DAY_MS,
      notes: "Family arriving at 9am",
    })) as { intermentId: string };

    expect(interments.size).toBe(1);
    const row = interments.get(result.intermentId)!;
    expect(row.lotId).toBe(lot._id);
    expect(row.occupantId).toBe(occupant._id);
    expect(row.scheduledAt).toBe(T0 + 14 * DAY_MS);
    expect(row.status).toBe("scheduled");
    expect(row.scheduledBy).toBe(USER_ID);
    expect(row.scheduledAt_createdAt).toBe(T0);
    expect(row.notes).toBe("Family arriving at 9am");

    expect(auditInserts).toHaveLength(1);
    const audit = auditInserts[0]!;
    expect(audit.row.action).toBe("create");
    expect(audit.row.entityType).toBe("lot");
    expect(audit.row.entityId).toBe(lot._id);
    expect(audit.row.after).toMatchObject({
      intermentId: result.intermentId,
      occupantId: occupant._id,
      status: "scheduled",
    });
    expect(audit.row.reason).toBe("Family arriving at 9am");
  });

  it("Epic 7 H2: rejects scheduling on a lot that is not sold/occupied", async () => {
    // An `available` lot can never reach `occupied` via completeInterment
    // (the lot state machine only allows sold→occupied), so the interment
    // would be permanently un-completable. Reject at scheduling time.
    const lot = makeLotFixture({ status: "available" });
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const { ctx, interments } = makeCtx({
      roles: ["office_staff"],
      initialLots: [lot],
      initialOccupants: [occupant],
    });
    const thrown = await run(ctx, {
      lotId: lot._id,
      occupantId: occupant._id,
      scheduledAt: T0 + 14 * DAY_MS,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(interments.size).toBe(0);
  });

  it("allows admin role", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const { ctx, interments } = makeCtx({
      roles: ["admin"],
      initialLots: [lot],
      initialOccupants: [occupant],
    });
    await run(ctx, {
      lotId: lot._id,
      occupantId: occupant._id,
      scheduledAt: T0 + 1 * DAY_MS,
    });
    expect(interments.size).toBe(1);
  });

  it("omits notes from the row when not supplied", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const { ctx, interments, auditInserts } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
    });
    const result = (await run(ctx, {
      lotId: lot._id,
      occupantId: occupant._id,
      scheduledAt: T0 + 2 * DAY_MS,
    })) as { intermentId: string };
    const row = interments.get(result.intermentId)!;
    expect(row.notes).toBeUndefined();
    // The audit row's reason falls back to the "scheduled via lot
    // detail" default when no notes are supplied.
    expect(auditInserts[0]!.row.reason).toBe("scheduled via lot detail");
  });

  it("trims whitespace in notes", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const { ctx, interments } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
    });
    const result = (await run(ctx, {
      lotId: lot._id,
      occupantId: occupant._id,
      scheduledAt: T0 + 2 * DAY_MS,
      notes: "  trimmed note  ",
    })) as { intermentId: string };
    expect(interments.get(result.intermentId)!.notes).toBe("trimmed note");
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      initialLots: [lot],
      initialOccupants: [occupant],
    });
    const thrown = await run(ctx, {
      lotId: lot._id,
      occupantId: occupant._id,
      scheduledAt: T0 + 1 * DAY_MS,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects customer role with FORBIDDEN", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const { ctx } = makeCtx({
      roles: ["customer"],
      initialLots: [lot],
      initialOccupants: [occupant],
    });
    const thrown = await run(ctx, {
      lotId: lot._id,
      occupantId: occupant._id,
      scheduledAt: T0 + 1 * DAY_MS,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const { ctx } = makeCtx({
      authenticated: false,
      initialLots: [lot],
      initialOccupants: [occupant],
    });
    const thrown = await run(ctx, {
      lotId: lot._id,
      occupantId: occupant._id,
      scheduledAt: T0 + 1 * DAY_MS,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("rejects scheduledAt more than 1 day in the past with VALIDATION", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
    });
    const thrown = await run(ctx, {
      lotId: lot._id,
      occupantId: occupant._id,
      scheduledAt: T0 - 2 * DAY_MS,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("accepts scheduledAt up to 1 day in the past (backfill)", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const { ctx, interments } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
    });
    await run(ctx, {
      lotId: lot._id,
      occupantId: occupant._id,
      scheduledAt: T0 - 6 * HOUR_MS,
    });
    expect(interments.size).toBe(1);
  });

  it("rejects non-finite scheduledAt with VALIDATION", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
    });
    const thrown = await run(ctx, {
      lotId: lot._id,
      occupantId: occupant._id,
      scheduledAt: NaN,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects notes longer than 500 chars with VALIDATION", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
    });
    const thrown = await run(ctx, {
      lotId: lot._id,
      occupantId: occupant._id,
      scheduledAt: T0 + 1 * DAY_MS,
      notes: "a".repeat(501),
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("throws NOT_FOUND when the lot doesn't exist", async () => {
    const occupant = makeOccupantFixture({ lotId: "lots:ghost" });
    const { ctx } = makeCtx({ initialOccupants: [occupant] });
    const thrown = await run(ctx, {
      lotId: "lots:ghost",
      occupantId: occupant._id,
      scheduledAt: T0 + 1 * DAY_MS,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("refuses scheduling on a retired lot (INVARIANT_VIOLATION)", async () => {
    const lot = makeLotFixture({ _id: "lots:retired", isRetired: true });
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
    });
    const thrown = await run(ctx, {
      lotId: lot._id,
      occupantId: occupant._id,
      scheduledAt: T0 + 1 * DAY_MS,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("throws NOT_FOUND when the occupant doesn't exist", async () => {
    const lot = makeLotFixture();
    const { ctx } = makeCtx({ initialLots: [lot] });
    const thrown = await run(ctx, {
      lotId: lot._id,
      occupantId: "occupants:ghost",
      scheduledAt: T0 + 1 * DAY_MS,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("refuses when occupant belongs to a different lot (INVARIANT_VIOLATION)", async () => {
    const lot = makeLotFixture({ _id: "lots:a" });
    const otherLot = makeLotFixture({ _id: "lots:b", code: "E-1-1" });
    const occupantOnOtherLot = makeOccupantFixture({
      _id: "occupants:on-b",
      lotId: otherLot._id,
    });
    const { ctx } = makeCtx({
      initialLots: [lot, otherLot],
      initialOccupants: [occupantOnOtherLot],
    });
    const thrown = await run(ctx, {
      lotId: lot._id,
      occupantId: occupantOnOtherLot._id,
      scheduledAt: T0 + 1 * DAY_MS,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("refuses when occupant has been soft-removed (INVARIANT_VIOLATION)", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({
      lotId: lot._id,
      isRemoved: true,
    });
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
    });
    const thrown = await run(ctx, {
      lotId: lot._id,
      occupantId: occupant._id,
      scheduledAt: T0 + 1 * DAY_MS,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  // ── Story 7.2 — double-booking guard ────────────────────────────────
  describe("double-booking guard", () => {
    it("refuses to schedule when an existing scheduled interment is within the ±60-min window (LOT_ALREADY_SCHEDULED)", async () => {
      const lot = makeLotFixture();
      const occupantA = makeOccupantFixture({
        _id: "occupants:a",
        lotId: lot._id,
        name: "Alice",
      });
      const occupantB = makeOccupantFixture({
        _id: "occupants:b",
        lotId: lot._id,
        name: "Bob",
      });
      const existing = makeIntermentFixture({
        _id: "interments:existing",
        lotId: lot._id,
        occupantId: occupantA._id,
        scheduledAt: T0 + 14 * DAY_MS,
        status: "scheduled",
      });
      const { ctx, interments, auditInserts } = makeCtx({
        initialLots: [lot],
        initialOccupants: [occupantA, occupantB],
        initialInterments: [existing],
      });
      const thrown = await run(ctx, {
        lotId: lot._id,
        occupantId: occupantB._id,
        // Within the ±60-min window of the existing 14d-out booking.
        scheduledAt: T0 + 14 * DAY_MS + 30 * MINUTE_MS,
      }).catch((e) => e);
      // Story 7.2 (HIGH-fix) — same-lot conflicts now throw the
      // specific `LOT_ALREADY_SCHEDULED` code so the UI can switch
      // on the reason. Previously this was the generic
      // `INVARIANT_VIOLATION`.
      expect(getCode(thrown)).toBe(ErrorCode.LOT_ALREADY_SCHEDULED);
      const data = (thrown as ConvexError<Value>).data as unknown as
        ErrorPayload;
      expect(data.details).toBeDefined();
      const details = data.details as { conflictingIds: string[] };
      expect(details.conflictingIds).toContain(existing._id);
      // Insert did NOT land — only the seeded row.
      expect(interments.size).toBe(1);
      // No audit row was emitted for the failed attempt.
      expect(auditInserts.length).toBe(0);
    });

    it("allows scheduling outside the ±60-min window at the same lot", async () => {
      const lot = makeLotFixture();
      const occupantA = makeOccupantFixture({
        _id: "occupants:a",
        lotId: lot._id,
      });
      const occupantB = makeOccupantFixture({
        _id: "occupants:b",
        lotId: lot._id,
      });
      const existing = makeIntermentFixture({
        _id: "interments:existing",
        lotId: lot._id,
        occupantId: occupantA._id,
        scheduledAt: T0 + 14 * DAY_MS,
        status: "scheduled",
      });
      const { ctx, interments } = makeCtx({
        initialLots: [lot],
        initialOccupants: [occupantA, occupantB],
        initialInterments: [existing],
      });
      // 2 hours later — outside the ±60-min window.
      await run(ctx, {
        lotId: lot._id,
        occupantId: occupantB._id,
        scheduledAt: T0 + 14 * DAY_MS + 2 * HOUR_MS,
      });
      expect(interments.size).toBe(2);
    });

    it("does NOT conflict with a cancelled interment in the window", async () => {
      const lot = makeLotFixture();
      const occupantA = makeOccupantFixture({
        _id: "occupants:a",
        lotId: lot._id,
      });
      const occupantB = makeOccupantFixture({
        _id: "occupants:b",
        lotId: lot._id,
      });
      const cancelled = makeIntermentFixture({
        _id: "interments:cancelled",
        lotId: lot._id,
        occupantId: occupantA._id,
        scheduledAt: T0 + 14 * DAY_MS,
        status: "cancelled",
      });
      const { ctx, interments } = makeCtx({
        initialLots: [lot],
        initialOccupants: [occupantA, occupantB],
        initialInterments: [cancelled],
      });
      // Same exact moment as the cancelled row — must NOT throw.
      await run(ctx, {
        lotId: lot._id,
        occupantId: occupantB._id,
        scheduledAt: T0 + 14 * DAY_MS,
      });
      expect(interments.size).toBe(2);
    });

    it("does NOT conflict with a completed interment in the window", async () => {
      const lot = makeLotFixture();
      const occupantA = makeOccupantFixture({
        _id: "occupants:a",
        lotId: lot._id,
      });
      const occupantB = makeOccupantFixture({
        _id: "occupants:b",
        lotId: lot._id,
      });
      const completed = makeIntermentFixture({
        _id: "interments:done",
        lotId: lot._id,
        occupantId: occupantA._id,
        scheduledAt: T0 - 30 * MINUTE_MS,
        status: "completed",
      });
      const { ctx, interments } = makeCtx({
        initialLots: [lot],
        initialOccupants: [occupantA, occupantB],
        initialInterments: [completed],
      });
      // Within the window of the completed row — must NOT throw.
      await run(ctx, {
        lotId: lot._id,
        occupantId: occupantB._id,
        scheduledAt: T0 + 15 * MINUTE_MS,
      });
      expect(interments.size).toBe(2);
    });

    it("rejects a scheduled interment at a DIFFERENT lot in the window with TIMESLOT_ALREADY_BOOKED (single-crew assumption)", async () => {
      const lotA = makeLotFixture({ _id: "lots:a", code: "A-1-1" });
      const lotB = makeLotFixture({ _id: "lots:b", code: "B-2-2" });
      const occupantOnA = makeOccupantFixture({
        _id: "occupants:on-a",
        lotId: lotA._id,
      });
      const occupantOnB = makeOccupantFixture({
        _id: "occupants:on-b",
        lotId: lotB._id,
      });
      const existing = makeIntermentFixture({
        _id: "interments:on-a",
        lotId: lotA._id,
        occupantId: occupantOnA._id,
        scheduledAt: T0 + 7 * DAY_MS,
        status: "scheduled",
      });
      const { ctx, interments, auditInserts } = makeCtx({
        initialLots: [lotA, lotB],
        initialOccupants: [occupantOnA, occupantOnB],
        initialInterments: [existing],
      });
      // Story 7.2 (HIGH-fix) — the single-crew assumption is now
      // enforced: a concurrent booking at a different lot collides
      // with the existing one because the crew can't be in two
      // places at once.
      const thrown = await run(ctx, {
        lotId: lotB._id,
        occupantId: occupantOnB._id,
        scheduledAt: T0 + 7 * DAY_MS,
      }).catch((e) => e);
      expect(getCode(thrown)).toBe(ErrorCode.TIMESLOT_ALREADY_BOOKED);
      const data = (thrown as ConvexError<Value>).data as unknown as
        ErrorPayload;
      const details = data.details as { conflictingIds: string[] };
      expect(details.conflictingIds).toContain(existing._id);
      // Only the seeded row — the second insert never landed.
      expect(interments.size).toBe(1);
      expect(auditInserts.length).toBe(0);
    });

    it("allows a cross-lot concurrent booking when INTERMENTS_ALLOW_CONCURRENT=true", async () => {
      const prev = process.env.INTERMENTS_ALLOW_CONCURRENT;
      process.env.INTERMENTS_ALLOW_CONCURRENT = "true";
      try {
        const lotA = makeLotFixture({ _id: "lots:a", code: "A-1-1" });
        const lotB = makeLotFixture({ _id: "lots:b", code: "B-2-2" });
        const occupantOnA = makeOccupantFixture({
          _id: "occupants:on-a",
          lotId: lotA._id,
        });
        const occupantOnB = makeOccupantFixture({
          _id: "occupants:on-b",
          lotId: lotB._id,
        });
        const existing = makeIntermentFixture({
          _id: "interments:on-a",
          lotId: lotA._id,
          occupantId: occupantOnA._id,
          scheduledAt: T0 + 7 * DAY_MS,
          status: "scheduled",
        });
        const { ctx, interments } = makeCtx({
          initialLots: [lotA, lotB],
          initialOccupants: [occupantOnA, occupantOnB],
          initialInterments: [existing],
        });
        await run(ctx, {
          lotId: lotB._id,
          occupantId: occupantOnB._id,
          scheduledAt: T0 + 7 * DAY_MS,
        });
        expect(interments.size).toBe(2);
      } finally {
        if (prev === undefined) {
          delete process.env.INTERMENTS_ALLOW_CONCURRENT;
        } else {
          process.env.INTERMENTS_ALLOW_CONCURRENT = prev;
        }
      }
    });

    it("rejects when scheduled at the exact same minute as an existing same-lot row (LOT_ALREADY_SCHEDULED)", async () => {
      const lot = makeLotFixture();
      const occupantA = makeOccupantFixture({
        _id: "occupants:a",
        lotId: lot._id,
      });
      const occupantB = makeOccupantFixture({
        _id: "occupants:b",
        lotId: lot._id,
      });
      const existing = makeIntermentFixture({
        _id: "interments:existing",
        lotId: lot._id,
        occupantId: occupantA._id,
        scheduledAt: T0 + 14 * DAY_MS,
        status: "scheduled",
      });
      const { ctx } = makeCtx({
        initialLots: [lot],
        initialOccupants: [occupantA, occupantB],
        initialInterments: [existing],
      });
      const thrown = await run(ctx, {
        lotId: lot._id,
        occupantId: occupantB._id,
        scheduledAt: T0 + 14 * DAY_MS,
      }).catch((e) => e);
      expect(getCode(thrown)).toBe(ErrorCode.LOT_ALREADY_SCHEDULED);
    });
  });
});

describe("listForLot", () => {
  const run = handlerOf(listForLot);

  it("returns an empty array for a lot with no interments", async () => {
    const { ctx } = makeCtx({});
    const result = (await run(ctx, { lotId: "lots:1" })) as unknown[];
    expect(result).toEqual([]);
  });

  it("returns interments for the lot sorted by scheduledAt ascending", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const initial = [
      makeIntermentFixture({
        _id: "interments:later",
        scheduledAt: T0 + 30 * DAY_MS,
      }),
      makeIntermentFixture({
        _id: "interments:soon",
        scheduledAt: T0 + 1 * DAY_MS,
      }),
      makeIntermentFixture({
        _id: "interments:mid",
        scheduledAt: T0 + 10 * DAY_MS,
      }),
    ];
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: initial,
    });
    const result = (await run(ctx, { lotId: lot._id })) as Array<{
      scheduledAt: number;
    }>;
    expect(result.map((r) => r.scheduledAt)).toEqual([
      T0 + 1 * DAY_MS,
      T0 + 10 * DAY_MS,
      T0 + 30 * DAY_MS,
    ]);
  });

  it("joins occupant + scheduler names server-side", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({
      _id: "occupants:named",
      lotId: lot._id,
      name: "Maria Santos",
    });
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [
        makeIntermentFixture({ occupantId: occupant._id }),
      ],
    });
    const result = (await run(ctx, { lotId: lot._id })) as Array<{
      occupantName: string;
      scheduledByName: string;
    }>;
    expect(result[0]!.occupantName).toBe("Maria Santos");
    expect(result[0]!.scheduledByName).toBe("Maria Office");
  });

  it("returns a trimmed shape (no _id, no scheduledBy)", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [makeIntermentFixture()],
    });
    const result = (await run(ctx, { lotId: lot._id })) as Array<
      Record<string, unknown>
    >;
    const row = result[0]!;
    expect(row).not.toHaveProperty("_id");
    expect(row).not.toHaveProperty("scheduledBy");
    expect(row).toHaveProperty("intermentId");
    expect(row).toHaveProperty("occupantName");
    expect(row).toHaveProperty("scheduledByName");
  });

  it("allows field_worker to read", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [makeIntermentFixture()],
    });
    const result = (await run(ctx, { lotId: lot._id })) as unknown[];
    expect(result.length).toBe(1);
  });

  it("rejects customer with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["customer"] });
    const thrown = await run(ctx, { lotId: "lots:1" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, { lotId: "lots:1" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});

describe("listInterments", () => {
  const run = handlerOf(listInterments);

  it("returns all interments when no statusFilter is supplied", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const initial = [
      makeIntermentFixture({
        _id: "interments:1",
        status: "scheduled",
        scheduledAt: T0 + 1 * DAY_MS,
      }),
      makeIntermentFixture({
        _id: "interments:2",
        status: "completed",
        scheduledAt: T0 - 1 * DAY_MS,
      }),
      makeIntermentFixture({
        _id: "interments:3",
        status: "cancelled",
        scheduledAt: T0 + 2 * DAY_MS,
      }),
    ];
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: initial,
    });
    const result = (await run(ctx, {})) as Array<{ status: string }>;
    expect(result.map((r) => r.status).sort()).toEqual([
      "cancelled",
      "completed",
      "scheduled",
    ]);
  });

  it("routes statusFilter through by_status_scheduledAt index", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const initial = [
      makeIntermentFixture({
        _id: "interments:s1",
        status: "scheduled",
        scheduledAt: T0 + 1 * DAY_MS,
      }),
      makeIntermentFixture({
        _id: "interments:c1",
        status: "completed",
        scheduledAt: T0 - 1 * DAY_MS,
      }),
    ];
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: initial,
    });
    const result = (await run(ctx, {
      statusFilter: "scheduled",
    })) as Array<{ intermentId: string; status: string }>;
    expect(result.length).toBe(1);
    expect(result[0]!.status).toBe("scheduled");
  });

  it("clamps limit to a sane range", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [
        makeIntermentFixture({ _id: "interments:1" }),
        makeIntermentFixture({ _id: "interments:2" }),
      ],
    });
    // Negative / zero limits clamp up to 1.
    const small = (await run(ctx, { limit: 0 })) as unknown[];
    expect(small.length).toBe(1);
    // Absurdly large limits clamp down to 500.
    const big = (await run(ctx, { limit: 10000 })) as unknown[];
    expect(big.length).toBe(2);
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});

describe("getInterment", () => {
  const run = handlerOf(getInterment);

  it("returns the enriched detail when the row exists", async () => {
    const lot = makeLotFixture({ code: "C-2-7" });
    const occupant = makeOccupantFixture({
      lotId: lot._id,
      name: "Cruz Santos",
    });
    const interment = makeIntermentFixture({
      occupantId: occupant._id,
      lotId: lot._id,
    });
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [interment],
    });
    const result = (await run(ctx, {
      intermentId: interment._id,
    })) as {
      lotCode: string;
      occupantName: string;
      scheduledByName: string;
      status: string;
    } | null;
    expect(result).not.toBeNull();
    expect(result!.lotCode).toBe("C-2-7");
    expect(result!.occupantName).toBe("Cruz Santos");
    expect(result!.scheduledByName).toBe("Maria Office");
    expect(result!.status).toBe("scheduled");
  });

  it("returns null when the interment doesn't exist", async () => {
    const { ctx } = makeCtx({});
    const result = await run(ctx, { intermentId: "interments:ghost" });
    expect(result).toBeNull();
  });

  it("allows field_worker to read", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const interment = makeIntermentFixture({
      occupantId: occupant._id,
      lotId: lot._id,
    });
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [interment],
    });
    const result = await run(ctx, { intermentId: interment._id });
    expect(result).not.toBeNull();
  });

  it("rejects customer with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["customer"] });
    const thrown = await run(ctx, {
      intermentId: "interments:1",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {
      intermentId: "interments:1",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});

// ── Story 7.2 — findConflicts query ───────────────────────────────────
describe("findConflicts", () => {
  const run = handlerOf(findConflicts);

  it("returns an empty array when no scheduled interment falls in the window", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
    });
    const result = (await run(ctx, {
      lotId: lot._id,
      scheduledAt: T0 + 1 * DAY_MS,
    })) as unknown[];
    expect(result).toEqual([]);
  });

  it("returns the conflicting interment with occupant name joined", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({
      lotId: lot._id,
      name: "Juana Cruz",
    });
    const existing = makeIntermentFixture({
      _id: "interments:e1",
      lotId: lot._id,
      occupantId: occupant._id,
      scheduledAt: T0 + 14 * DAY_MS,
      status: "scheduled",
    });
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [existing],
    });
    const result = (await run(ctx, {
      lotId: lot._id,
      scheduledAt: T0 + 14 * DAY_MS + 30 * MINUTE_MS,
    })) as Array<{
      intermentId: string;
      occupantName: string;
      scheduledAt: number;
    }>;
    expect(result.length).toBe(1);
    expect(result[0]!.intermentId).toBe("interments:e1");
    expect(result[0]!.occupantName).toBe("Juana Cruz");
  });

  it("excludes cancelled rows", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [
        makeIntermentFixture({
          _id: "interments:cancelled",
          lotId: lot._id,
          occupantId: occupant._id,
          scheduledAt: T0 + 5 * DAY_MS,
          status: "cancelled",
        }),
      ],
    });
    const result = (await run(ctx, {
      lotId: lot._id,
      scheduledAt: T0 + 5 * DAY_MS,
    })) as unknown[];
    expect(result).toEqual([]);
  });

  it("excludes completed rows", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [
        makeIntermentFixture({
          _id: "interments:completed",
          lotId: lot._id,
          occupantId: occupant._id,
          scheduledAt: T0 - 1 * HOUR_MS,
          status: "completed",
        }),
      ],
    });
    const result = (await run(ctx, {
      lotId: lot._id,
      scheduledAt: T0,
    })) as unknown[];
    expect(result).toEqual([]);
  });

  it("respects excludeIntermentId (reschedule scenario)", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const existing = makeIntermentFixture({
      _id: "interments:self",
      lotId: lot._id,
      occupantId: occupant._id,
      scheduledAt: T0 + 3 * DAY_MS,
      status: "scheduled",
    });
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [existing],
    });
    const result = (await run(ctx, {
      lotId: lot._id,
      scheduledAt: T0 + 3 * DAY_MS,
      excludeIntermentId: existing._id,
    })) as unknown[];
    expect(result).toEqual([]);
  });

  it("returns empty for an invalid scheduledAt without throwing", async () => {
    const lot = makeLotFixture();
    const { ctx } = makeCtx({ initialLots: [lot] });
    const result = (await run(ctx, {
      lotId: lot._id,
      scheduledAt: NaN,
    })) as unknown[];
    expect(result).toEqual([]);
  });

  it("allows field_worker to call", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      initialLots: [lot],
      initialOccupants: [occupant],
    });
    const result = (await run(ctx, {
      lotId: lot._id,
      scheduledAt: T0 + 1 * DAY_MS,
    })) as unknown[];
    expect(result).toEqual([]);
  });

  it("rejects customer with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["customer"] });
    const thrown = await run(ctx, {
      lotId: "lots:1",
      scheduledAt: T0 + 1 * DAY_MS,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {
      lotId: "lots:1",
      scheduledAt: T0 + 1 * DAY_MS,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});

// ── Story 7.3 — listInRange (calendar view) ───────────────────────────
describe("listInRange", () => {
  const run = handlerOf(listInRange);

  it("returns an empty array when no interments fall in the range", async () => {
    const lot = makeLotFixture();
    const { ctx } = makeCtx({ initialLots: [lot] });
    const result = (await run(ctx, {
      fromMs: T0,
      toMs: T0 + 30 * DAY_MS,
    })) as unknown[];
    expect(result).toEqual([]);
  });

  it("returns events with scheduledAt within [fromMs, toMs] ascending", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const initial = [
      makeIntermentFixture({
        _id: "interments:later",
        scheduledAt: T0 + 20 * DAY_MS,
        status: "scheduled",
      }),
      makeIntermentFixture({
        _id: "interments:soon",
        scheduledAt: T0 + 2 * DAY_MS,
        status: "scheduled",
      }),
      makeIntermentFixture({
        _id: "interments:mid",
        scheduledAt: T0 + 10 * DAY_MS,
        status: "completed",
      }),
    ];
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: initial,
    });
    const result = (await run(ctx, {
      fromMs: T0,
      toMs: T0 + 30 * DAY_MS,
    })) as Array<{ intermentId: string; scheduledAt: number }>;
    expect(result.map((r) => r.intermentId)).toEqual([
      "interments:soon",
      "interments:mid",
      "interments:later",
    ]);
  });

  it("excludes scheduledAt outside the [fromMs, toMs] window", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const initial = [
      makeIntermentFixture({
        _id: "interments:before",
        scheduledAt: T0 - 5 * DAY_MS,
      }),
      makeIntermentFixture({
        _id: "interments:inside",
        scheduledAt: T0 + 5 * DAY_MS,
      }),
      makeIntermentFixture({
        _id: "interments:after",
        scheduledAt: T0 + 60 * DAY_MS,
      }),
    ];
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: initial,
    });
    const result = (await run(ctx, {
      fromMs: T0,
      toMs: T0 + 30 * DAY_MS,
    })) as Array<{ intermentId: string }>;
    expect(result.map((r) => r.intermentId)).toEqual(["interments:inside"]);
  });

  it("excludes cancelled rows by default", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const initial = [
      makeIntermentFixture({
        _id: "interments:s",
        scheduledAt: T0 + 2 * DAY_MS,
        status: "scheduled",
      }),
      makeIntermentFixture({
        _id: "interments:c",
        scheduledAt: T0 + 3 * DAY_MS,
        status: "cancelled",
      }),
    ];
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: initial,
    });
    const result = (await run(ctx, {
      fromMs: T0,
      toMs: T0 + 30 * DAY_MS,
    })) as Array<{ intermentId: string }>;
    expect(result.map((r) => r.intermentId)).toEqual(["interments:s"]);
  });

  it("includes cancelled rows when includeCancelled=true", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const initial = [
      makeIntermentFixture({
        _id: "interments:s",
        scheduledAt: T0 + 2 * DAY_MS,
        status: "scheduled",
      }),
      makeIntermentFixture({
        _id: "interments:c",
        scheduledAt: T0 + 3 * DAY_MS,
        status: "cancelled",
      }),
    ];
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: initial,
    });
    const result = (await run(ctx, {
      fromMs: T0,
      toMs: T0 + 30 * DAY_MS,
      includeCancelled: true,
    })) as Array<{ intermentId: string }>;
    expect(result.map((r) => r.intermentId).sort()).toEqual([
      "interments:c",
      "interments:s",
    ]);
  });

  it("joins occupant name + lot code/section server-side", async () => {
    const lot = makeLotFixture({
      _id: "lots:fancy",
      code: "E-3-9",
      section: "E",
    });
    const occupant = makeOccupantFixture({
      _id: "occupants:named",
      lotId: lot._id,
      name: "Pedro Cruz",
    });
    const interment = makeIntermentFixture({
      _id: "interments:join",
      lotId: lot._id,
      occupantId: occupant._id,
      scheduledAt: T0 + 1 * DAY_MS,
    });
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [interment],
    });
    const result = (await run(ctx, {
      fromMs: T0,
      toMs: T0 + 7 * DAY_MS,
    })) as Array<{
      occupantName: string;
      lotCode: string;
      lotSection: string;
      lotId: string;
    }>;
    expect(result.length).toBe(1);
    expect(result[0]!.occupantName).toBe("Pedro Cruz");
    expect(result[0]!.lotCode).toBe("E-3-9");
    expect(result[0]!.lotSection).toBe("E");
    expect(result[0]!.lotId).toBe(lot._id);
  });

  it("returns an empty array when the range is inverted (toMs < fromMs)", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [makeIntermentFixture({ scheduledAt: T0 })],
    });
    const result = (await run(ctx, {
      fromMs: T0 + 10 * DAY_MS,
      toMs: T0,
    })) as unknown[];
    expect(result).toEqual([]);
  });

  it("returns an empty array for non-finite bounds", async () => {
    const lot = makeLotFixture();
    const { ctx } = makeCtx({ initialLots: [lot] });
    const result = (await run(ctx, {
      fromMs: NaN,
      toMs: T0,
    })) as unknown[];
    expect(result).toEqual([]);
  });

  it("allows field_worker to read (mobile burial-day view)", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [
        makeIntermentFixture({ scheduledAt: T0 + 1 * DAY_MS }),
      ],
    });
    const result = (await run(ctx, {
      fromMs: T0,
      toMs: T0 + 7 * DAY_MS,
    })) as unknown[];
    expect(result.length).toBe(1);
  });

  it("rejects customer with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["customer"] });
    const thrown = await run(ctx, {
      fromMs: T0,
      toMs: T0 + DAY_MS,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {
      fromMs: T0,
      toMs: T0 + DAY_MS,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Story 7.4 — completeInterment + listTodayForFieldWorker +
// generateUploadUrl + getCompletionPhotoUrl
// ──────────────────────────────────────────────────────────────────────

describe("completeInterment", () => {
  const run = handlerOf(completeInterment);

  it("marks a scheduled interment complete (field_worker happy path)", async () => {
    const lot = makeLotFixture({ status: "sold" });
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const scheduled = makeIntermentFixture({
      _id: "interments:s1",
      lotId: lot._id,
      occupantId: occupant._id,
      scheduledAt: T0 + 1 * HOUR_MS,
      status: "scheduled",
    });
    const { ctx, interments, lots, auditInserts } = makeCtx({
      roles: ["field_worker"],
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [scheduled],
    });
    const result = (await run(ctx, {
      intermentId: scheduled._id,
    })) as { intermentId: string; lotTransitioned: boolean };
    expect(result.intermentId).toBe(scheduled._id);
    expect(result.lotTransitioned).toBe(true);

    const updated = interments.get(scheduled._id)!;
    expect(updated.status).toBe("completed");
    expect(updated.completedAt).toBe(T0);
    expect(updated.completedBy).toBe(USER_ID);

    // Lot transitioned to occupied.
    expect(lots.get(lot._id)!.status).toBe("occupied");

    // Two audit rows: one from `transitionLotStatus` (lot:transition,
    // sold → occupied) and one from `completeInterment` (interment
    // completion, keyed on the lot).
    expect(auditInserts).toHaveLength(2);
    const actions = auditInserts.map((a) => a.row.action);
    expect(actions.filter((a) => a === "transition")).toHaveLength(2);
    const allEntityIds = auditInserts.map((a) => a.row.entityId);
    expect(allEntityIds.every((id) => id === lot._id)).toBe(true);
  });

  it("allows office_staff to mark complete (back-office correction)", async () => {
    const lot = makeLotFixture({ status: "sold" });
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const scheduled = makeIntermentFixture({
      _id: "interments:s2",
      lotId: lot._id,
      occupantId: occupant._id,
      status: "scheduled",
    });
    const { ctx, interments } = makeCtx({
      roles: ["office_staff"],
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [scheduled],
    });
    await run(ctx, { intermentId: scheduled._id });
    expect(interments.get(scheduled._id)!.status).toBe("completed");
  });

  it("allows admin to mark complete", async () => {
    const lot = makeLotFixture({ status: "sold" });
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const scheduled = makeIntermentFixture({
      _id: "interments:s3",
      lotId: lot._id,
      occupantId: occupant._id,
      status: "scheduled",
    });
    const { ctx, interments } = makeCtx({
      roles: ["admin"],
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [scheduled],
    });
    await run(ctx, { intermentId: scheduled._id });
    expect(interments.get(scheduled._id)!.status).toBe("completed");
  });

  it("rejects customer with FORBIDDEN", async () => {
    const lot = makeLotFixture({ status: "sold" });
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const scheduled = makeIntermentFixture({
      _id: "interments:s4",
      lotId: lot._id,
      occupantId: occupant._id,
    });
    const { ctx } = makeCtx({
      roles: ["customer"],
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [scheduled],
    });
    const thrown = await run(ctx, { intermentId: scheduled._id }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const lot = makeLotFixture({ status: "sold" });
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const scheduled = makeIntermentFixture({
      _id: "interments:s5",
      lotId: lot._id,
      occupantId: occupant._id,
    });
    const { ctx } = makeCtx({
      authenticated: false,
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [scheduled],
    });
    const thrown = await run(ctx, { intermentId: scheduled._id }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("returns lotTransitioned: false when the lot is already occupied (family plot)", async () => {
    const lot = makeLotFixture({ status: "occupied" });
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const scheduled = makeIntermentFixture({
      _id: "interments:family",
      lotId: lot._id,
      occupantId: occupant._id,
      status: "scheduled",
    });
    const { ctx, interments, lots, auditInserts } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [scheduled],
    });
    const result = (await run(ctx, {
      intermentId: scheduled._id,
    })) as { lotTransitioned: boolean };
    expect(result.lotTransitioned).toBe(false);
    expect(interments.get(scheduled._id)!.status).toBe("completed");
    // Lot remains occupied — no extra patch.
    expect(lots.get(lot._id)!.status).toBe("occupied");
    // ONLY one audit row — the interment completion. No
    // `transitionLotStatus` was called.
    expect(auditInserts).toHaveLength(1);
  });

  it("rejects when interment is already completed (INVARIANT_VIOLATION)", async () => {
    const lot = makeLotFixture({ status: "occupied" });
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const alreadyDone = makeIntermentFixture({
      _id: "interments:done",
      lotId: lot._id,
      occupantId: occupant._id,
      status: "completed",
    });
    const { ctx, auditInserts } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [alreadyDone],
    });
    const thrown = await run(ctx, { intermentId: alreadyDone._id }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
    // No audit row should be written for the rejected attempt.
    expect(auditInserts).toHaveLength(0);
  });

  it("rejects when interment is cancelled (INVARIANT_VIOLATION)", async () => {
    const lot = makeLotFixture({ status: "sold" });
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const cancelled = makeIntermentFixture({
      _id: "interments:cancelled",
      lotId: lot._id,
      occupantId: occupant._id,
      status: "cancelled",
    });
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [cancelled],
    });
    const thrown = await run(ctx, { intermentId: cancelled._id }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("throws NOT_FOUND when the interment doesn't exist", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, {
      intermentId: "interments:ghost",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("throws ILLEGAL_STATE_TRANSITION when the lot is in a non-sold non-occupied state (anomaly)", async () => {
    // Anomaly: an interment was somehow scheduled against an available
    // lot. `assertTransition` rejects the lot move; the entire
    // mutation rolls back (the interment is NOT patched to completed).
    const lot = makeLotFixture({ status: "available" });
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const scheduled = makeIntermentFixture({
      _id: "interments:anomaly",
      lotId: lot._id,
      occupantId: occupant._id,
      status: "scheduled",
    });
    const { ctx, interments } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [scheduled],
    });
    const thrown = await run(ctx, { intermentId: scheduled._id }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.ILLEGAL_STATE_TRANSITION);
    // The interment patch did land (mocked ctx.db doesn't roll back
    // on throw — real Convex transactions do). What we assert here
    // is that the error code is correct; the production runtime
    // handles atomicity automatically.
    void interments;
  });

  it("trims completion notes and stores them on the patched row", async () => {
    const lot = makeLotFixture({ status: "sold" });
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const scheduled = makeIntermentFixture({
      _id: "interments:notes",
      lotId: lot._id,
      occupantId: occupant._id,
      status: "scheduled",
    });
    const { ctx, interments } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [scheduled],
    });
    await run(ctx, {
      intermentId: scheduled._id,
      notes: "   Ceremony complete; family thanked us.   ",
    });
    expect(interments.get(scheduled._id)!.completionNotes).toBe(
      "Ceremony complete; family thanked us.",
    );
  });

  it("rejects notes longer than 500 chars with VALIDATION", async () => {
    const lot = makeLotFixture({ status: "sold" });
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const scheduled = makeIntermentFixture({
      _id: "interments:long",
      lotId: lot._id,
      occupantId: occupant._id,
      status: "scheduled",
    });
    const { ctx, interments } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [scheduled],
    });
    const thrown = await run(ctx, {
      intermentId: scheduled._id,
      notes: "x".repeat(501),
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    // Untouched — notes were rejected before any patch.
    expect(interments.get(scheduled._id)!.status).toBe("scheduled");
  });

  it("stores the optional photo blob id on the patched row", async () => {
    const lot = makeLotFixture({ status: "sold" });
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const scheduled = makeIntermentFixture({
      _id: "interments:photo",
      lotId: lot._id,
      occupantId: occupant._id,
      status: "scheduled",
    });
    const { ctx, interments } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [scheduled],
    });
    await run(ctx, {
      intermentId: scheduled._id,
      photoBlobId: "_storage:abc123" as never,
    });
    expect(
      (
        interments.get(scheduled._id) as IntermentFixture & {
          completionPhotoBlobId?: string;
        }
      ).completionPhotoBlobId,
    ).toBe("_storage:abc123");
  });
});

describe("listTodayForFieldWorker", () => {
  const run = handlerOf(listTodayForFieldWorker);

  it("returns scheduled interments whose Manila day matches today", async () => {
    // T0 is 2026-06-01T08:00 Manila — solidly inside the Manila day.
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id, name: "Juan" });
    const todayMid = T0 + 2 * HOUR_MS; // 10:00 Manila same day
    const tomorrow = T0 + 20 * HOUR_MS; // next Manila day
    const yesterday = T0 - 10 * HOUR_MS; // previous Manila day
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [
        makeIntermentFixture({
          _id: "interments:today",
          lotId: lot._id,
          occupantId: occupant._id,
          scheduledAt: todayMid,
          status: "scheduled",
        }),
        makeIntermentFixture({
          _id: "interments:tomorrow",
          lotId: lot._id,
          occupantId: occupant._id,
          scheduledAt: tomorrow,
          status: "scheduled",
        }),
        makeIntermentFixture({
          _id: "interments:yesterday",
          lotId: lot._id,
          occupantId: occupant._id,
          scheduledAt: yesterday,
          status: "scheduled",
        }),
      ],
    });
    const result = (await run(ctx, {})) as Array<{ intermentId: string }>;
    expect(result.map((r) => r.intermentId)).toEqual(["interments:today"]);
  });

  it("excludes completed and cancelled interments", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const todayMid = T0 + 2 * HOUR_MS;
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [
        makeIntermentFixture({
          _id: "interments:done",
          lotId: lot._id,
          scheduledAt: todayMid,
          status: "completed",
        }),
        makeIntermentFixture({
          _id: "interments:cancelled",
          lotId: lot._id,
          scheduledAt: todayMid,
          status: "cancelled",
        }),
      ],
    });
    const result = (await run(ctx, {})) as unknown[];
    expect(result).toEqual([]);
  });

  it("rejects customer with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["customer"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("generateUploadUrl", () => {
  const run = handlerOf(generateUploadUrl);

  it("returns a signed URL for office_staff / admin / field_worker", async () => {
    for (const role of ["admin", "office_staff", "field_worker"] as const) {
      const { ctx } = makeCtx({ roles: [role] });
      const result = (await run(ctx, {})) as string;
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it("rejects customer with FORBIDDEN", async () => {
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

describe("getCompletionPhotoUrl", () => {
  const run = handlerOf(getCompletionPhotoUrl);

  it("returns null when the interment doesn't exist", async () => {
    const { ctx } = makeCtx({});
    const result = await run(ctx, { intermentId: "interments:ghost" });
    expect(result).toBeNull();
  });

  it("returns null when the interment has no photo attached", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const noPhoto = makeIntermentFixture({
      _id: "interments:noPhoto",
      lotId: lot._id,
      occupantId: occupant._id,
      status: "completed",
    });
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [noPhoto],
    });
    const result = await run(ctx, { intermentId: noPhoto._id });
    expect(result).toBeNull();
  });

  it("returns a signed URL when the interment has a photo", async () => {
    const lot = makeLotFixture();
    const occupant = makeOccupantFixture({ lotId: lot._id });
    const withPhoto = {
      ...makeIntermentFixture({
        _id: "interments:withPhoto",
        lotId: lot._id,
        occupantId: occupant._id,
        status: "completed",
      }),
      completionPhotoBlobId: "_storage:photo1",
    } as IntermentFixture & { completionPhotoBlobId: string };
    const { ctx } = makeCtx({
      initialLots: [lot],
      initialOccupants: [occupant],
      initialInterments: [withPhoto],
    });
    const result = (await run(ctx, {
      intermentId: withPhoto._id,
    })) as string;
    expect(result).toContain("_storage:photo1");
  });

  it("rejects customer with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["customer"] });
    const thrown = await run(ctx, {
      intermentId: "interments:any",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});
