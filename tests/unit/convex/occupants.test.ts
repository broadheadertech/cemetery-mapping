/**
 * Story 2.6 — `convex/occupants.ts` unit tests.
 *
 * Hand-mocked ctx pattern (matches `lots.test.ts` and
 * `conditionLogs.test.ts`). `convex-test` requires `_generated/`,
 * which this repo deliberately avoids; we reproduce just enough of
 * `ctx.db` to drive the public mutations + queries end-to-end.
 *
 * Coverage focus:
 *   - addOccupant: happy paths (with and without date), validation
 *     errors (short name, missing relationship, future date, long
 *     notes), retired-lot guard, missing-lot, RBAC.
 *   - listLotOccupants: empty lot, sorted ascending, undated tail,
 *     removed-by-default filter, includeRemoved toggle, field_worker
 *     allowed, customer rejected.
 *   - removeOccupant: happy path, admin-only RBAC, reason validation,
 *     idempotency on already-removed row.
 */

import { ConvexError, type Value } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCode, type ErrorPayload } from "../../../convex/lib/errors";
import { DAY_MS, HOUR_MS } from "../../../convex/lib/time";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import {
  addOccupant,
  listLotOccupants,
  removeOccupant,
} from "../../../convex/occupants";

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

interface OccupantFixture {
  _id: string;
  _creationTime: number;
  lotId: string;
  name: string;
  dateOfInterment?: number;
  relationshipToOwner: string;
  notes?: string;
  createdAt: number;
  createdByUserId: string;
  isRemoved: boolean;
  removedAt?: number;
  removedByUserId?: string;
  removedReason?: string;
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
  auditInserts: AuditInsert[];
  patches: Array<{ id: string; patch: Record<string, unknown> }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  initialLots?: LotFixture[];
  initialOccupants?: OccupantFixture[];
  authenticated?: boolean;
}): CtxBag {
  const lots = new Map<string, LotFixture>(
    (opts.initialLots ?? []).map((l) => [l._id, l]),
  );
  const occupants = new Map<string, OccupantFixture>(
    (opts.initialOccupants ?? []).map((o) => [o._id, o]),
  );
  const auditInserts: AuditInsert[] = [];
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];

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
    name: "Maria Office",
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
    eqs: Record<string, unknown>;
    eq(field: string, value: unknown): IndexQuery;
  }

  function makeOccupantsQueryBuilder() {
    type Predicate = (r: OccupantFixture) => boolean;
    const predicates: Predicate[] = [];

    const builder = {
      withIndex(_indexName: string, fn: (q: IndexQuery) => IndexQuery) {
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
            (r) =>
              (r as unknown as Record<string, unknown>)[field] === value,
          );
        }
        return builder;
      },
      async collect() {
        return Array.from(occupants.values()).filter((r) =>
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
        if (occupants.has(id)) return occupants.get(id);
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
        if (table === "occupants") {
          return makeOccupantsQueryBuilder();
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
        if (table === "occupants") {
          const id = `occupants:${nextId++}`;
          const doc = {
            _id: id,
            _creationTime: T0,
            ...row,
          } as OccupantFixture;
          occupants.set(id, doc);
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
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        patches.push({ id, patch });
        const current = occupants.get(id);
        if (current !== undefined) {
          occupants.set(id, { ...current, ...patch } as OccupantFixture);
        }
        return null;
      }),
    },
  };

  return { lots, occupants, auditInserts, patches, ctx };
}

function makeLotFixture(overrides: Partial<LotFixture> = {}): LotFixture {
  return {
    _id: overrides._id ?? "lots:1",
    _creationTime: T0,
    isRetired: overrides.isRetired ?? false,
  };
}

function makeOccupantFixture(
  overrides: Partial<OccupantFixture> = {},
): OccupantFixture {
  return {
    _id: overrides._id ?? "occupants:base",
    _creationTime: T0,
    lotId: "lots:1",
    name: "Juan Santos",
    dateOfInterment: T0 - 30 * DAY_MS,
    relationshipToOwner: "Father",
    createdAt: T0 - 30 * DAY_MS,
    createdByUserId: USER_ID,
    isRemoved: false,
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

describe("addOccupant", () => {
  const run = handlerOf(addOccupant);

  it("inserts an occupant, emits audit, returns the new id (office_staff)", async () => {
    const lot = makeLotFixture();
    const { ctx, occupants, auditInserts } = makeCtx({
      roles: ["office_staff"],
      initialLots: [lot],
    });

    const result = (await run(ctx, {
      lotId: lot._id,
      name: "Maria Santos",
      dateOfInterment: T0 - 365 * DAY_MS,
      relationshipToOwner: "Spouse",
      notes: "Interred at sundown.",
    })) as { occupantId: string };

    expect(occupants.size).toBe(1);
    const row = occupants.get(result.occupantId)!;
    expect(row.name).toBe("Maria Santos");
    expect(row.relationshipToOwner).toBe("Spouse");
    expect(row.dateOfInterment).toBe(T0 - 365 * DAY_MS);
    expect(row.notes).toBe("Interred at sundown.");
    expect(row.isRemoved).toBe(false);
    expect(row.createdByUserId).toBe(USER_ID);

    expect(auditInserts).toHaveLength(1);
    const audit = auditInserts[0]!;
    expect(audit.row.action).toBe("create");
    expect(audit.row.entityType).toBe("lot");
    expect(audit.row.entityId).toBe(lot._id);
    expect(audit.row.after).toMatchObject({
      occupantId: result.occupantId,
      name: "Maria Santos",
      relationshipToOwner: "Spouse",
    });
  });

  it("accepts a missing dateOfInterment (legacy data, §10 Q4)", async () => {
    const lot = makeLotFixture();
    const { ctx, occupants, auditInserts } = makeCtx({
      initialLots: [lot],
    });

    const result = (await run(ctx, {
      lotId: lot._id,
      name: "Cruz Santos",
      relationshipToOwner: "Grandparent",
    })) as { occupantId: string };

    const row = occupants.get(result.occupantId)!;
    expect(row.dateOfInterment).toBeUndefined();
    expect(auditInserts[0]!.row.after).toMatchObject({
      dateOfInterment: undefined,
    });
  });

  it("trims whitespace on name, relationship, notes", async () => {
    const lot = makeLotFixture();
    const { ctx, occupants } = makeCtx({ initialLots: [lot] });

    const result = (await run(ctx, {
      lotId: lot._id,
      name: "   Spaced Name   ",
      relationshipToOwner: "  Spouse  ",
      notes: "  trimmed note  ",
    })) as { occupantId: string };

    const row = occupants.get(result.occupantId)!;
    expect(row.name).toBe("Spaced Name");
    expect(row.relationshipToOwner).toBe("Spouse");
    expect(row.notes).toBe("trimmed note");
  });

  it("allows admin role", async () => {
    const lot = makeLotFixture();
    const { ctx, occupants } = makeCtx({
      roles: ["admin"],
      initialLots: [lot],
    });
    await run(ctx, {
      lotId: lot._id,
      name: "Admin Add",
      relationshipToOwner: "Self",
    });
    expect(occupants.size).toBe(1);
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const lot = makeLotFixture();
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      initialLots: [lot],
    });
    const thrown = await run(ctx, {
      lotId: lot._id,
      name: "Should Not Insert",
      relationshipToOwner: "x",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const lot = makeLotFixture();
    const { ctx } = makeCtx({
      authenticated: false,
      initialLots: [lot],
    });
    const thrown = await run(ctx, {
      lotId: lot._id,
      name: "Anon Insert",
      relationshipToOwner: "x",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("rejects short name (< 2 chars) with VALIDATION", async () => {
    const lot = makeLotFixture();
    const { ctx } = makeCtx({ initialLots: [lot] });
    const thrown = await run(ctx, {
      lotId: lot._id,
      name: "X",
      relationshipToOwner: "Spouse",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects empty relationship with VALIDATION", async () => {
    const lot = makeLotFixture();
    const { ctx } = makeCtx({ initialLots: [lot] });
    const thrown = await run(ctx, {
      lotId: lot._id,
      name: "Real Name",
      relationshipToOwner: "   ",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects dateOfInterment in the future with VALIDATION", async () => {
    const lot = makeLotFixture();
    const { ctx } = makeCtx({ initialLots: [lot] });
    const thrown = await run(ctx, {
      lotId: lot._id,
      name: "Future Person",
      relationshipToOwner: "Self",
      dateOfInterment: T0 + 7 * DAY_MS,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("accepts dateOfInterment within 1-day clock-skew tolerance", async () => {
    const lot = makeLotFixture();
    const { ctx, occupants } = makeCtx({ initialLots: [lot] });
    // Half a day in the future — within the tolerance window.
    const halfDayFuture = T0 + 12 * HOUR_MS;
    await run(ctx, {
      lotId: lot._id,
      name: "Today Interred",
      relationshipToOwner: "Self",
      dateOfInterment: halfDayFuture,
    });
    expect(occupants.size).toBe(1);
  });

  it("rejects notes longer than 1000 chars with VALIDATION", async () => {
    const lot = makeLotFixture();
    const { ctx } = makeCtx({ initialLots: [lot] });
    const thrown = await run(ctx, {
      lotId: lot._id,
      name: "Long Notes",
      relationshipToOwner: "Self",
      notes: "a".repeat(1001),
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("throws NOT_FOUND when the lot id doesn't exist", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, {
      lotId: "lots:ghost",
      name: "Ghost Person",
      relationshipToOwner: "Self",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("refuses to add an occupant to a retired lot (INVARIANT_VIOLATION)", async () => {
    const lot = makeLotFixture({ _id: "lots:retired", isRetired: true });
    const { ctx } = makeCtx({ initialLots: [lot] });
    const thrown = await run(ctx, {
      lotId: lot._id,
      name: "On Retired Lot",
      relationshipToOwner: "Self",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });
});

describe("listLotOccupants", () => {
  const run = handlerOf(listLotOccupants);

  it("returns an empty array for a lot with no occupants", async () => {
    const { ctx } = makeCtx({});
    const result = (await run(ctx, { lotId: "lots:1" })) as unknown[];
    expect(result).toEqual([]);
  });

  it("returns occupants sorted ascending by dateOfInterment", async () => {
    const occupantsFixtures = [
      makeOccupantFixture({
        _id: "occupants:b",
        name: "B",
        dateOfInterment: T0 - 10 * DAY_MS,
      }),
      makeOccupantFixture({
        _id: "occupants:a",
        name: "A",
        dateOfInterment: T0 - 100 * DAY_MS,
      }),
      makeOccupantFixture({
        _id: "occupants:c",
        name: "C",
        dateOfInterment: T0 - 1 * DAY_MS,
      }),
    ];
    const { ctx } = makeCtx({ initialOccupants: occupantsFixtures });
    const result = (await run(ctx, { lotId: "lots:1" })) as Array<{
      name: string;
    }>;
    expect(result.map((r) => r.name)).toEqual(["A", "B", "C"]);
  });

  it("places undated rows at the tail, ordered by createdAt", async () => {
    const occupantsFixtures = [
      makeOccupantFixture({
        _id: "occupants:dated",
        name: "Dated",
        dateOfInterment: T0 - 50 * DAY_MS,
      }),
      makeOccupantFixture({
        _id: "occupants:undated2",
        name: "Undated2",
        dateOfInterment: undefined,
        createdAt: T0 - 5 * DAY_MS,
      }),
      makeOccupantFixture({
        _id: "occupants:undated1",
        name: "Undated1",
        dateOfInterment: undefined,
        createdAt: T0 - 10 * DAY_MS,
      }),
    ];
    const { ctx } = makeCtx({ initialOccupants: occupantsFixtures });
    const result = (await run(ctx, { lotId: "lots:1" })) as Array<{
      name: string;
    }>;
    expect(result.map((r) => r.name)).toEqual([
      "Dated",
      "Undated1",
      "Undated2",
    ]);
  });

  it("excludes removed rows by default", async () => {
    const occupantsFixtures = [
      makeOccupantFixture({ _id: "occupants:visible", name: "Visible" }),
      makeOccupantFixture({
        _id: "occupants:gone",
        name: "Gone",
        isRemoved: true,
      }),
    ];
    const { ctx } = makeCtx({ initialOccupants: occupantsFixtures });
    const result = (await run(ctx, { lotId: "lots:1" })) as Array<{
      name: string;
    }>;
    expect(result.map((r) => r.name)).toEqual(["Visible"]);
  });

  it("includes removed rows when includeRemoved is true", async () => {
    const occupantsFixtures = [
      makeOccupantFixture({ _id: "occupants:visible", name: "Visible" }),
      makeOccupantFixture({
        _id: "occupants:gone",
        name: "Gone",
        isRemoved: true,
      }),
    ];
    const { ctx } = makeCtx({ initialOccupants: occupantsFixtures });
    const result = (await run(ctx, {
      lotId: "lots:1",
      includeRemoved: true,
    })) as Array<{ name: string }>;
    expect(result.map((r) => r.name).sort()).toEqual(["Gone", "Visible"]);
  });

  it("returns a trimmed shape (no _id, no createdByUserId)", async () => {
    const { ctx } = makeCtx({
      initialOccupants: [makeOccupantFixture()],
    });
    const result = (await run(ctx, { lotId: "lots:1" })) as Array<
      Record<string, unknown>
    >;
    const row = result[0]!;
    expect(row).not.toHaveProperty("_id");
    expect(row).not.toHaveProperty("createdByUserId");
    expect(row).toHaveProperty("occupantId");
    expect(row).toHaveProperty("name");
    expect(row).toHaveProperty("relationshipToOwner");
  });

  it("allows field_worker to read the list (Story 8.3 burial-navigation)", async () => {
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      initialOccupants: [makeOccupantFixture()],
    });
    const result = (await run(ctx, { lotId: "lots:1" })) as unknown[];
    expect(result.length).toBe(1);
  });

  it("rejects customer role with FORBIDDEN", async () => {
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

describe("removeOccupant", () => {
  const run = handlerOf(removeOccupant);

  it("soft-deletes the occupant, patches the row, emits audit (admin)", async () => {
    const occ = makeOccupantFixture({ _id: "occupants:keep-history" });
    const { ctx, occupants, auditInserts, patches } = makeCtx({
      roles: ["admin"],
      initialOccupants: [occ],
    });
    await run(ctx, {
      occupantId: occ._id,
      reason: "Data entry mistake — wrong lot",
    });
    expect(patches).toHaveLength(1);
    expect(patches[0]!.patch).toMatchObject({
      isRemoved: true,
      removedAt: T0,
      removedByUserId: USER_ID,
      removedReason: "Data entry mistake — wrong lot",
    });
    // Row still present (soft delete).
    expect(occupants.size).toBe(1);
    expect(occupants.get(occ._id)!.isRemoved).toBe(true);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]!.row.action).toBe("delete");
    expect(auditInserts[0]!.row.entityType).toBe("lot");
    expect(auditInserts[0]!.row.entityId).toBe(occ.lotId);
    expect(auditInserts[0]!.row.reason).toBe(
      "Data entry mistake — wrong lot",
    );
  });

  it("rejects office_staff with FORBIDDEN (admin-only)", async () => {
    const occ = makeOccupantFixture();
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      initialOccupants: [occ],
    });
    const thrown = await run(ctx, {
      occupantId: occ._id,
      reason: "valid reason",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const occ = makeOccupantFixture();
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      initialOccupants: [occ],
    });
    const thrown = await run(ctx, {
      occupantId: occ._id,
      reason: "valid reason",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects short reason with VALIDATION", async () => {
    const occ = makeOccupantFixture();
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialOccupants: [occ],
    });
    const thrown = await run(ctx, {
      occupantId: occ._id,
      reason: "x",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects too-long reason with VALIDATION", async () => {
    const occ = makeOccupantFixture();
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialOccupants: [occ],
    });
    const thrown = await run(ctx, {
      occupantId: occ._id,
      reason: "a".repeat(501),
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("throws NOT_FOUND when the occupant id doesn't exist", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const thrown = await run(ctx, {
      occupantId: "occupants:ghost",
      reason: "valid reason",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("is idempotent on already-removed rows (no second patch / audit)", async () => {
    const occ = makeOccupantFixture({
      _id: "occupants:gone",
      isRemoved: true,
      removedAt: T0 - 1 * DAY_MS,
      removedByUserId: USER_ID,
      removedReason: "earlier",
    });
    const { ctx, patches, auditInserts } = makeCtx({
      roles: ["admin"],
      initialOccupants: [occ],
    });
    const result = (await run(ctx, {
      occupantId: occ._id,
      reason: "later attempt",
    })) as { occupantId: string };
    expect(result.occupantId).toBe(occ._id);
    expect(patches).toHaveLength(0);
    expect(auditInserts).toHaveLength(0);
  });
});
