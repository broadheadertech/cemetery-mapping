/**
 * Story 1.8 — `convex/lots.ts` unit tests.
 *
 * Coverage target: ≥ 90% (NFR-M2 — `basePriceCents` is financial).
 *
 * Strategy: hand-mocked ctx (same pattern as `auth.test.ts` and
 * `audit.test.ts`). We import the public Convex functions and pull
 * their `handler` out of the registration object so we can call them
 * directly without spinning up Convex's runtime — `convex-test`
 * requires `_generated/` which this repo deliberately avoids.
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
  createLot,
  getLot,
  listInBbox,
  listLots,
  retireLot,
  setLotStatusReserved,
  updateLot,
  updateLotGeometry,
} from "../../../convex/lots";

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
  type: "single" | "family" | "mausoleum" | "niche";
  dimensions: { widthM: number; depthM: number };
  basePriceCents: number;
  status: "available" | "reserved" | "sold" | "occupied" | "cancelled" | "defaulted" | "transferred";
  geometry: {
    centroid: { lat: number; lng: number };
    polygon: { lat: number; lng: number }[];
    bboxMinLat: number;
    bboxMaxLat: number;
    bboxMinLng: number;
    bboxMaxLng: number;
  };
  geometryStatus: "placeholder" | "surveyed";
  isRetired: boolean;
  createdAt: number;
  createdBy: string;
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
  inserts: AuditInsert[];
  patches: Array<{ id: string; patch: Record<string, unknown> }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  initialLots?: LotFixture[];
  authenticated?: boolean;
}): CtxBag {
  const lots = new Map<string, LotFixture>(
    (opts.initialLots ?? []).map((l) => [l._id, l]),
  );
  const inserts: AuditInsert[] = [];
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
    email: "office@example.com",
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

  function readDottedField(row: LotFixture, path: string): unknown {
    // Convex indexes can target dotted paths (e.g.
    // `geometry.bboxMinLat`). The mock supports the same notation so
    // Story 1.9's `listInBbox` tests can exercise the index.
    let cur: unknown = row;
    for (const part of path.split(".")) {
      if (cur === null || typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
  }

  function makeQueryBuilder(table: string) {
    type Predicate = (r: LotFixture) => boolean;
    const predicates: Predicate[] = [];

    const builder = {
      withIndex(_indexName: string, fn: (q: IndexQuery) => IndexQuery) {
        const q: IndexQuery = {
          eqs: {},
          ranges: [],
          eq(field: string, value: unknown) {
            this.eqs[field] = value;
            return this;
          },
          gte(field: string, value: number) {
            this.ranges.push({ field, op: "gte", value });
            return this;
          },
          lte(field: string, value: number) {
            this.ranges.push({ field, op: "lte", value });
            return this;
          },
        };
        fn(q);
        for (const [field, value] of Object.entries(q.eqs)) {
          predicates.push((r) => readDottedField(r, field) === value);
        }
        for (const range of q.ranges) {
          if (range.op === "gte") {
            predicates.push((r) => {
              const v = readDottedField(r, range.field);
              return typeof v === "number" && v >= range.value;
            });
          } else {
            predicates.push((r) => {
              const v = readDottedField(r, range.field);
              return typeof v === "number" && v <= range.value;
            });
          }
        }
        return builder;
      },
      async first(): Promise<LotFixture | null> {
        for (const row of lots.values()) {
          if (predicates.every((p) => p(row))) return row;
        }
        return null;
      },
      async collect(): Promise<LotFixture[]> {
        if (table !== "lots") return [];
        return Array.from(lots.values()).filter((r) =>
          predicates.every((p) => p(r)),
        );
      },
    };
    return builder;
  }

  interface IndexRange {
    field: string;
    op: "gte" | "lte";
    value: number;
  }

  interface IndexQuery {
    eqs: Record<string, unknown>;
    ranges: IndexRange[];
    eq(field: string, value: unknown): IndexQuery;
    gte(field: string, value: number): IndexQuery;
    lte(field: string, value: number): IndexQuery;
  }

  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === USER_ID) return user;
        if (id === SESSION_ID) return session;
        if (lots.has(id)) return lots.get(id);
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
        return makeQueryBuilder(table);
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "lots") {
          const id = `lots:${nextId++}`;
          const newLot = { _id: id, _creationTime: T0, ...row } as LotFixture;
          lots.set(id, newLot);
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
        const existing = lots.get(id);
        if (existing !== undefined) {
          lots.set(id, { ...existing, ...patch } as LotFixture);
        }
      }),
    },
  };

  return { lots, inserts, patches, ctx };
}

function makeLotFixture(overrides: Partial<LotFixture> = {}): LotFixture {
  return {
    _id: overrides._id ?? "lots:fixture",
    _creationTime: T0,
    code: "D-5-12",
    section: "D",
    block: "5",
    row: "12",
    type: "single",
    dimensions: { widthM: 1.5, depthM: 2.5 },
    basePriceCents: 100_000_00,
    status: "available",
    geometry: {
      centroid: { lat: 14.676, lng: 121.0437 },
      polygon: [{ lat: 14.676, lng: 121.0437 }],
      bboxMinLat: 14.676,
      bboxMaxLat: 14.676,
      bboxMinLng: 121.0437,
      bboxMaxLng: 121.0437,
    },
    geometryStatus: "placeholder",
    isRetired: false,
    createdAt: T0,
    createdBy: USER_ID,
    ...overrides,
  };
}

// Convenience accessors — Convex's registered functions wrap the
// handler in a small adapter; the underlying `_handler` is what we
// invoke directly in tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerOf(fn: any): (ctx: unknown, args: unknown) => Promise<unknown> {
  // The function returned by `mutationGeneric` / `queryGeneric` exposes
  // the original handler under several property names depending on
  // the Convex version; iterate the candidates.
  for (const key of ["_handler", "handler", "invokeMutation", "invokeQuery"]) {
    const v = fn[key];
    if (typeof v === "function") return v as never;
  }
  // Fallback: the function itself may be callable as the handler.
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

describe("createLot", () => {
  const run = handlerOf(createLot);

  it("creates a new lot, emits a `create` audit, and returns the new id", async () => {
    const { ctx, lots, inserts } = makeCtx({ roles: ["office_staff"] });
    const id = (await run(ctx, {
      code: "D-5-12",
      section: "D",
      block: "5",
      row: "12",
      type: "single",
      dimensions: { widthM: 1.5, depthM: 2.5 },
      basePriceCents: 100_000_00,
    })) as string;

    expect(lots.size).toBe(1);
    const lot = lots.get(id)!;
    expect(lot.status).toBe("available");
    expect(lot.isRetired).toBe(false);
    expect(lot.geometryStatus).toBe("placeholder");
    expect(lot.createdBy).toBe(USER_ID);

    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.row.action).toBe("create");
    expect(inserts[0]!.row.entityType).toBe("lot");
  });

  it("throws DUPLICATE_CODE when a lot with the same code exists", async () => {
    const existing = makeLotFixture({ _id: "lots:1", code: "D-5-12" });
    const { ctx } = makeCtx({ initialLots: [existing] });

    const thrown = await run(ctx, {
      code: "D-5-12",
      section: "D",
      block: "5",
      row: "13",
      type: "single",
      dimensions: { widthM: 1, depthM: 2 },
      basePriceCents: 100_00,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.DUPLICATE_CODE);
  });

  it("rejects non-office-staff / non-admin roles", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    const thrown = await run(ctx, {
      code: "D-5-13",
      section: "D",
      block: "5",
      row: "13",
      type: "single",
      dimensions: { widthM: 1, depthM: 2 },
      basePriceCents: 100_00,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects non-positive base price", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(ctx, {
      code: "D-5-14",
      section: "D",
      block: "5",
      row: "14",
      type: "single",
      dimensions: { widthM: 1, depthM: 2 },
      basePriceCents: 0,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects non-integer base price", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const thrown = await run(ctx, {
      code: "D-5-15",
      section: "D",
      block: "5",
      row: "15",
      type: "single",
      dimensions: { widthM: 1, depthM: 2 },
      basePriceCents: 100.5,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects empty code / section / block / row", async () => {
    const { ctx } = makeCtx({});
    for (const field of ["code", "section", "block", "row"] as const) {
      const args = {
        code: "X",
        section: "X",
        block: "X",
        row: "X",
        type: "single" as const,
        dimensions: { widthM: 1, depthM: 2 },
        basePriceCents: 100_00,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args as any)[field] = " ";
      const thrown = await run(ctx, args).catch((e) => e);
      expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    }
  });

  it("rejects non-positive dimensions", async () => {
    const { ctx } = makeCtx({});
    for (const dims of [
      { widthM: 0, depthM: 2 },
      { widthM: 2, depthM: 0 },
      { widthM: -1, depthM: 2 },
    ]) {
      const thrown = await run(ctx, {
        code: "D-5-99",
        section: "D",
        block: "5",
        row: "99",
        type: "single",
        dimensions: dims,
        basePriceCents: 100_00,
      }).catch((e) => e);
      expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    }
  });
});

describe("updateLot", () => {
  const run = handlerOf(updateLot);

  it("updates allowed fields and emits an `update` audit", async () => {
    const lot = makeLotFixture({ _id: "lots:U1", basePriceCents: 100_000_00 });
    const { ctx, lots, inserts } = makeCtx({ initialLots: [lot] });

    await run(ctx, {
      lotId: lot._id,
      fields: { basePriceCents: 150_000_00 },
    });

    expect(lots.get(lot._id)!.basePriceCents).toBe(150_000_00);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.row.action).toBe("update");
    expect(inserts[0]!.row.before).toEqual({ basePriceCents: 100_000_00 });
    expect(inserts[0]!.row.after).toEqual({ basePriceCents: 150_000_00 });
  });

  it("no-ops when no fields are supplied", async () => {
    const lot = makeLotFixture({ _id: "lots:U2" });
    const { ctx, inserts, patches } = makeCtx({ initialLots: [lot] });

    await run(ctx, { lotId: lot._id, fields: {} });

    expect(patches).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("throws NOT_FOUND when lot id doesn't exist", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, {
      lotId: "lots:ghost",
      fields: { basePriceCents: 200_00 },
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("refuses to edit a retired lot", async () => {
    const lot = makeLotFixture({ _id: "lots:U3", isRetired: true });
    const { ctx } = makeCtx({ initialLots: [lot] });
    const thrown = await run(ctx, {
      lotId: lot._id,
      fields: { basePriceCents: 200_00 },
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("validates new field values", async () => {
    const lot = makeLotFixture({ _id: "lots:U4" });
    const { ctx } = makeCtx({ initialLots: [lot] });
    const thrown = await run(ctx, {
      lotId: lot._id,
      fields: { basePriceCents: -1 },
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("captures only changed fields in audit before/after", async () => {
    const lot = makeLotFixture({
      _id: "lots:U5",
      section: "A",
      block: "1",
      row: "2",
    });
    const { ctx, inserts } = makeCtx({ initialLots: [lot] });
    await run(ctx, {
      lotId: lot._id,
      fields: { section: "B", row: "3" },
    });
    expect(inserts[0]!.row.before).toEqual({ section: "A", row: "2" });
    expect(inserts[0]!.row.after).toEqual({ section: "B", row: "3" });
  });

  it("updates dimensions and type", async () => {
    const lot = makeLotFixture({ _id: "lots:U6" });
    const { ctx, lots } = makeCtx({ initialLots: [lot] });
    await run(ctx, {
      lotId: lot._id,
      fields: {
        type: "family",
        dimensions: { widthM: 3, depthM: 4 },
        block: "Z",
      },
    });
    const updated = lots.get(lot._id)!;
    expect(updated.type).toBe("family");
    expect(updated.dimensions).toEqual({ widthM: 3, depthM: 4 });
    expect(updated.block).toBe("Z");
  });
});

describe("retireLot", () => {
  const run = handlerOf(retireLot);

  it("soft-deletes the lot, sets isRetired, and emits a deactivate audit", async () => {
    const lot = makeLotFixture({ _id: "lots:R1" });
    const { ctx, lots, inserts } = makeCtx({ initialLots: [lot] });

    await run(ctx, { lotId: lot._id });

    expect(lots.get(lot._id)!.isRetired).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.row.action).toBe("deactivate");
    expect(inserts[0]!.row.entityType).toBe("lot");
    expect(inserts[0]!.row.before).toEqual({ isRetired: false });
    expect(inserts[0]!.row.after).toEqual({ isRetired: true });
  });

  it("is idempotent when called on an already-retired lot", async () => {
    const lot = makeLotFixture({ _id: "lots:R2", isRetired: true });
    const { ctx, inserts, patches } = makeCtx({ initialLots: [lot] });

    await run(ctx, { lotId: lot._id });

    expect(patches).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("throws NOT_FOUND when lot id doesn't exist", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, { lotId: "lots:ghost" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });
});

describe("setLotStatusReserved", () => {
  const run = handlerOf(setLotStatusReserved);

  it("transitions an available lot to reserved via transitionLotStatus", async () => {
    const lot = makeLotFixture({ _id: "lots:S1", status: "available" });
    const { ctx, lots, inserts, patches } = makeCtx({
      initialLots: [lot],
    });

    await run(ctx, { lotId: lot._id });

    // patch should contain { status: "reserved" }
    const statusPatch = patches.find(
      (p) => "status" in p.patch && p.patch.status === "reserved",
    );
    expect(statusPatch).toBeDefined();
    expect(lots.get(lot._id)!.status).toBe("reserved");

    // audit should be a `transition` row
    const transitionAudit = inserts.find(
      (i) => i.row.action === "transition",
    );
    expect(transitionAudit).toBeDefined();
  });

  it("propagates ILLEGAL_STATE_TRANSITION when the lot is already sold", async () => {
    const lot = makeLotFixture({ _id: "lots:S2", status: "sold" });
    const { ctx } = makeCtx({ initialLots: [lot] });
    const thrown = await run(ctx, { lotId: lot._id }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.ILLEGAL_STATE_TRANSITION);
  });
});

describe("listLots", () => {
  const run = handlerOf(listLots);

  it("filters retired lots by default", async () => {
    const a = makeLotFixture({ _id: "lots:L1", code: "A-1", isRetired: false });
    const b = makeLotFixture({ _id: "lots:L2", code: "B-1", isRetired: true });
    const { ctx } = makeCtx({ initialLots: [a, b] });

    const result = (await run(ctx, {})) as Array<{ _id: string }>;
    expect(result.map((r) => r._id)).toEqual(["lots:L1"]);
  });

  it("includes retired when includeRetired: true", async () => {
    const a = makeLotFixture({ _id: "lots:L1", code: "A-1", isRetired: false });
    const b = makeLotFixture({ _id: "lots:L2", code: "B-1", isRetired: true });
    const { ctx } = makeCtx({ initialLots: [a, b] });

    const result = (await run(ctx, {
      includeRetired: true,
    })) as Array<{ _id: string }>;
    expect(result).toHaveLength(2);
  });

  it("filters by statusFilter using the by_status index", async () => {
    const a = makeLotFixture({
      _id: "lots:L1",
      code: "A-1",
      status: "available",
    });
    const b = makeLotFixture({
      _id: "lots:L2",
      code: "B-1",
      status: "reserved",
    });
    const { ctx } = makeCtx({ initialLots: [a, b] });

    const result = (await run(ctx, {
      statusFilter: "reserved",
    })) as Array<{ _id: string }>;
    expect(result.map((r) => r._id)).toEqual(["lots:L2"]);
  });

  it("sorts results by code ascending", async () => {
    const a = makeLotFixture({ _id: "lots:L1", code: "C-1" });
    const b = makeLotFixture({ _id: "lots:L2", code: "A-1" });
    const c = makeLotFixture({ _id: "lots:L3", code: "B-1" });
    const { ctx } = makeCtx({ initialLots: [a, b, c] });

    const result = (await run(ctx, {})) as Array<{ code: string }>;
    expect(result.map((r) => r.code)).toEqual(["A-1", "B-1", "C-1"]);
  });

  it("rejects unauthenticated callers", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});

describe("getLot", () => {
  const run = handlerOf(getLot);

  it("returns the lot document when found", async () => {
    const lot = makeLotFixture({ _id: "lots:G1" });
    const { ctx } = makeCtx({ initialLots: [lot] });
    const result = (await run(ctx, { lotId: lot._id })) as { _id: string };
    expect(result._id).toBe(lot._id);
  });

  it("returns null when not found", async () => {
    const { ctx } = makeCtx({});
    const result = await run(ctx, { lotId: "lots:ghost" });
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------
  // Story 8.3 — server-side coordinate redaction (NFR-S4, AC4).
  //
  // The server MUST redact polygon vertices and placeholder centroids
  // based on the caller's role; relying on UI-only hiding is explicitly
  // out-of-policy. These tests pin the redaction matrix:
  //
  //   role         | geometryStatus | expected geometry
  //   -------------+----------------+----------------------------------
  //   field_worker | placeholder    | null
  //   field_worker | surveyed       | centroid present, polygon null
  //   admin        | surveyed       | full geometry (centroid + polygon)
  //   office_staff | surveyed       | full geometry (centroid + polygon)
  //   any          | placeholder    | null (centroid would be misleading)
  // -------------------------------------------------------------------

  it("redacts geometry to null for a field_worker on a placeholder lot", async () => {
    const lot = makeLotFixture({
      _id: "lots:G_FW_PH",
      geometryStatus: "placeholder",
    });
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      initialLots: [lot],
    });
    const result = (await run(ctx, { lotId: lot._id })) as {
      _id: string;
      geometry: unknown;
    };
    expect(result._id).toBe(lot._id);
    expect(result.geometry).toBeNull();
  });

  it("exposes the centroid but redacts polygon for a field_worker on a surveyed lot", async () => {
    const polygon = [
      { lat: 14.6758, lng: 121.0398 },
      { lat: 14.6762, lng: 121.0398 },
      { lat: 14.6762, lng: 121.0402 },
      { lat: 14.6758, lng: 121.0402 },
    ];
    const lot = makeLotFixture({
      _id: "lots:G_FW_SV",
      geometryStatus: "surveyed",
      geometry: {
        centroid: { lat: 14.676, lng: 121.04 },
        polygon,
        bboxMinLat: 14.6758,
        bboxMaxLat: 14.6762,
        bboxMinLng: 121.0398,
        bboxMaxLng: 121.0402,
      },
    });
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      initialLots: [lot],
    });
    const result = (await run(ctx, { lotId: lot._id })) as {
      geometry: {
        centroid: { lat: number; lng: number };
        polygon: unknown;
        bboxMinLat: number;
        bboxMaxLat: number;
        bboxMinLng: number;
        bboxMaxLng: number;
      } | null;
    };
    expect(result.geometry).not.toBeNull();
    expect(result.geometry!.centroid).toEqual({ lat: 14.676, lng: 121.04 });
    expect(result.geometry!.polygon).toBeNull();
    // Bbox stays exposed — needed for any client-side rendering hint
    // and is derivable from the centroid anyway for placeholder lots.
    expect(result.geometry!.bboxMinLat).toBe(14.6758);
    expect(result.geometry!.bboxMaxLng).toBe(121.0402);
  });

  it("returns the full geometry for an admin on a surveyed lot", async () => {
    const polygon = [
      { lat: 14.6758, lng: 121.0398 },
      { lat: 14.6762, lng: 121.0398 },
      { lat: 14.6762, lng: 121.0402 },
      { lat: 14.6758, lng: 121.0402 },
    ];
    const lot = makeLotFixture({
      _id: "lots:G_AD_SV",
      geometryStatus: "surveyed",
      geometry: {
        centroid: { lat: 14.676, lng: 121.04 },
        polygon,
        bboxMinLat: 14.6758,
        bboxMaxLat: 14.6762,
        bboxMinLng: 121.0398,
        bboxMaxLng: 121.0402,
      },
    });
    const { ctx } = makeCtx({ roles: ["admin"], initialLots: [lot] });
    const result = (await run(ctx, { lotId: lot._id })) as {
      geometry: { centroid: unknown; polygon: unknown };
    };
    expect(result.geometry.centroid).toEqual({ lat: 14.676, lng: 121.04 });
    expect(result.geometry.polygon).toEqual(polygon);
  });

  it("returns the full geometry for office_staff on a surveyed lot", async () => {
    const polygon = [
      { lat: 14.6758, lng: 121.0398 },
      { lat: 14.6762, lng: 121.0398 },
      { lat: 14.6762, lng: 121.0402 },
      { lat: 14.6758, lng: 121.0402 },
    ];
    const lot = makeLotFixture({
      _id: "lots:G_OS_SV",
      geometryStatus: "surveyed",
      geometry: {
        centroid: { lat: 14.676, lng: 121.04 },
        polygon,
        bboxMinLat: 14.6758,
        bboxMaxLat: 14.6762,
        bboxMinLng: 121.0398,
        bboxMaxLng: 121.0402,
      },
    });
    const { ctx } = makeCtx({ roles: ["office_staff"], initialLots: [lot] });
    const result = (await run(ctx, { lotId: lot._id })) as {
      geometry: { centroid: unknown; polygon: unknown };
    };
    expect(result.geometry.centroid).toEqual({ lat: 14.676, lng: 121.04 });
    expect(result.geometry.polygon).toEqual(polygon);
  });

  it("redacts geometry to null for an admin on a placeholder lot", async () => {
    // Even admins should not get the misleading cemetery-centroid
    // placeholder via `getLot`. The map's `listInBbox` path is the
    // appropriate surface for aggregate placeholder rendering.
    const lot = makeLotFixture({
      _id: "lots:G_AD_PH",
      geometryStatus: "placeholder",
    });
    const { ctx } = makeCtx({ roles: ["admin"], initialLots: [lot] });
    const result = (await run(ctx, { lotId: lot._id })) as {
      geometry: unknown;
    };
    expect(result.geometry).toBeNull();
  });

  it("rejects unauthenticated callers with UNAUTHENTICATED", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, { lotId: "lots:ghost" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});

// ---------------------------------------------------------------------------
// Story 1.9 — listInBbox + updateLotGeometry
// ---------------------------------------------------------------------------
//
// The mock `makeQueryBuilder` above was extended in Story 1.9 to support
// `gte` / `lte` plus dotted-path field reads (`geometry.bboxMinLat`). The
// extension lets us exercise `listInBbox`'s `withIndex` call without a
// `convex-test` runtime (which still requires `_generated/`).

function makeBboxLotFixture(
  id: string,
  centroid: { lat: number; lng: number },
  polygon: Array<{ lat: number; lng: number }> | undefined,
  overrides: Partial<LotFixture> = {},
): LotFixture {
  const poly = polygon ?? [];
  let bboxMinLat = centroid.lat;
  let bboxMaxLat = centroid.lat;
  let bboxMinLng = centroid.lng;
  let bboxMaxLng = centroid.lng;
  if (poly.length > 0) {
    bboxMinLat = Math.min(...poly.map((p) => p.lat));
    bboxMaxLat = Math.max(...poly.map((p) => p.lat));
    bboxMinLng = Math.min(...poly.map((p) => p.lng));
    bboxMaxLng = Math.max(...poly.map((p) => p.lng));
  }
  return makeLotFixture({
    _id: id,
    code: id,
    geometry: {
      centroid,
      polygon: poly,
      bboxMinLat,
      bboxMaxLat,
      bboxMinLng,
      bboxMaxLng,
    },
    geometryStatus: poly.length > 0 ? "surveyed" : "placeholder",
    ...overrides,
  });
}

describe("listInBbox", () => {
  const run = handlerOf(listInBbox);

  // A viewport centred on Manila (lat 14.676, lng 121.04) with a small
  // window. Five lots are placed: two inside, two outside, one retired
  // inside.
  function seedFiveLots(): LotFixture[] {
    return [
      // INSIDE — surveyed
      makeBboxLotFixture(
        "lots:IN1",
        { lat: 14.676, lng: 121.04 },
        [
          { lat: 14.6758, lng: 121.0398 },
          { lat: 14.6762, lng: 121.0398 },
          { lat: 14.6762, lng: 121.0402 },
          { lat: 14.6758, lng: 121.0402 },
        ],
      ),
      // INSIDE — placeholder (zero-area bbox at the centroid)
      makeBboxLotFixture(
        "lots:IN2",
        { lat: 14.6765, lng: 121.0405 },
        [],
      ),
      // OUTSIDE — north of the viewport
      makeBboxLotFixture(
        "lots:OUT1",
        { lat: 14.78, lng: 121.04 },
        [],
      ),
      // OUTSIDE — east of the viewport
      makeBboxLotFixture(
        "lots:OUT2",
        { lat: 14.676, lng: 121.09 },
        [],
      ),
      // INSIDE but RETIRED — should be excluded
      makeBboxLotFixture(
        "lots:RET",
        { lat: 14.676, lng: 121.04 },
        [],
        { isRetired: true },
      ),
    ];
  }

  it("returns only lots whose bbox overlaps the viewport (happy path)", async () => {
    const lots = seedFiveLots();
    const { ctx } = makeCtx({ initialLots: lots });
    const result = (await run(ctx, {
      bboxMinLat: 14.6755,
      bboxMaxLat: 14.677,
      bboxMinLng: 121.039,
      bboxMaxLng: 121.041,
    })) as Array<{ _id: string }>;
    const ids = new Set(result.map((r) => r._id));
    expect(ids.has("lots:IN1")).toBe(true);
    expect(ids.has("lots:IN2")).toBe(true);
    expect(ids.has("lots:OUT1")).toBe(false);
    expect(ids.has("lots:OUT2")).toBe(false);
    expect(ids.has("lots:RET")).toBe(false);
  });

  it("excludes retired lots", async () => {
    const lots = [
      makeBboxLotFixture(
        "lots:A",
        { lat: 14.676, lng: 121.04 },
        [],
        { isRetired: true },
      ),
    ];
    const { ctx } = makeCtx({ initialLots: lots });
    const result = (await run(ctx, {
      bboxMinLat: 14.67,
      bboxMaxLat: 14.68,
      bboxMinLng: 121.03,
      bboxMaxLng: 121.05,
    })) as unknown[];
    expect(result).toHaveLength(0);
  });

  it("respects statusFilter", async () => {
    const lots = [
      makeBboxLotFixture("lots:A", { lat: 14.676, lng: 121.04 }, [], {
        status: "available",
      }),
      makeBboxLotFixture("lots:B", { lat: 14.676, lng: 121.041 }, [], {
        status: "reserved",
      }),
    ];
    const { ctx } = makeCtx({ initialLots: lots });
    const result = (await run(ctx, {
      bboxMinLat: 14.67,
      bboxMaxLat: 14.68,
      bboxMinLng: 121.03,
      bboxMaxLng: 121.05,
      statusFilter: "reserved",
    })) as Array<{ _id: string }>;
    expect(result.map((r) => r._id)).toEqual(["lots:B"]);
  });

  it("caps results at the supplied limit", async () => {
    const lots = Array.from({ length: 10 }, (_, i) =>
      makeBboxLotFixture(
        `lots:K${i}`,
        { lat: 14.676 + i * 0.0001, lng: 121.04 },
        [],
      ),
    );
    const { ctx } = makeCtx({ initialLots: lots });
    const result = (await run(ctx, {
      bboxMinLat: 14.67,
      bboxMaxLat: 14.68,
      bboxMinLng: 121.03,
      bboxMaxLng: 121.05,
      limit: 3,
    })) as unknown[];
    expect(result).toHaveLength(3);
  });

  it("clamps oversized limit to the 500 ceiling", async () => {
    // The clamp is a server-side invariant; we don't seed 500 lots,
    // we just confirm the cap doesn't throw and returns whatever the
    // candidate pool yields.
    const lots = [
      makeBboxLotFixture("lots:Z", { lat: 14.676, lng: 121.04 }, []),
    ];
    const { ctx } = makeCtx({ initialLots: lots });
    const result = (await run(ctx, {
      bboxMinLat: 14.67,
      bboxMaxLat: 14.68,
      bboxMinLng: 121.03,
      bboxMaxLng: 121.05,
      limit: 9999,
    })) as unknown[];
    expect(result).toHaveLength(1);
  });

  it("rejects customer-role callers with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["customer"] });
    const thrown = await run(ctx, {
      bboxMinLat: 14.67,
      bboxMaxLat: 14.68,
      bboxMinLng: 121.03,
      bboxMaxLng: 121.05,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("permits admin / office_staff / field_worker roles", async () => {
    for (const role of ["admin", "office_staff", "field_worker"] as const) {
      const { ctx } = makeCtx({ roles: [role] });
      await expect(
        run(ctx, {
          bboxMinLat: 14.67,
          bboxMaxLat: 14.68,
          bboxMinLng: 121.03,
          bboxMaxLng: 121.05,
        }),
      ).resolves.toBeDefined();
    }
  });
});

describe("updateLotGeometry", () => {
  const run = handlerOf(updateLotGeometry);

  it("happy path: rewrites geometry, recomputes bbox + centroid, emits update audit", async () => {
    const lot = makeBboxLotFixture(
      "lots:U1",
      { lat: 14.676, lng: 121.0437 },
      [],
    );
    const { ctx, lots, inserts } = makeCtx({ initialLots: [lot] });

    const polygon = [
      { lat: 14.6758, lng: 121.0398 },
      { lat: 14.6762, lng: 121.0398 },
      { lat: 14.6762, lng: 121.0402 },
      { lat: 14.6758, lng: 121.0402 },
    ];
    await run(ctx, {
      lotId: lot._id,
      polygon,
      geometryStatus: "surveyed",
    });

    const updated = lots.get(lot._id)!;
    expect(updated.geometryStatus).toBe("surveyed");
    expect(updated.geometry.polygon).toEqual(polygon);
    expect(updated.geometry.bboxMinLat).toBeCloseTo(14.6758);
    expect(updated.geometry.bboxMaxLat).toBeCloseTo(14.6762);
    expect(updated.geometry.bboxMinLng).toBeCloseTo(121.0398);
    expect(updated.geometry.bboxMaxLng).toBeCloseTo(121.0402);
    // Vertex-average centroid of the unit rectangle's corners.
    expect(updated.geometry.centroid.lat).toBeCloseTo(14.676, 4);
    expect(updated.geometry.centroid.lng).toBeCloseTo(121.04, 4);

    // Audit emitted; before/after both carry the geometry + status.
    expect(inserts).toHaveLength(1);
    const row = inserts[0]!.row;
    expect(row.action).toBe("update");
    expect(row.entityType).toBe("lot");
    expect(row.before).toMatchObject({ geometryStatus: "placeholder" });
    expect(row.after).toMatchObject({ geometryStatus: "surveyed" });
  });

  it("uses the supplied centroid when one is provided", async () => {
    const lot = makeBboxLotFixture(
      "lots:U2",
      { lat: 14.676, lng: 121.0437 },
      [],
    );
    const { ctx, lots } = makeCtx({ initialLots: [lot] });
    const explicitCentroid = { lat: 14.6759, lng: 121.04 };
    await run(ctx, {
      lotId: lot._id,
      polygon: [
        { lat: 14.6758, lng: 121.0398 },
        { lat: 14.6762, lng: 121.0398 },
        { lat: 14.6762, lng: 121.0402 },
        { lat: 14.6758, lng: 121.0402 },
      ],
      centroid: explicitCentroid,
      geometryStatus: "surveyed",
    });
    expect(lots.get(lot._id)!.geometry.centroid).toEqual(explicitCentroid);
  });

  it("accepts an empty polygon (status reset to placeholder)", async () => {
    const lot = makeBboxLotFixture(
      "lots:U3",
      { lat: 14.676, lng: 121.0437 },
      [
        { lat: 14.6758, lng: 121.0398 },
        { lat: 14.6762, lng: 121.0398 },
        { lat: 14.6762, lng: 121.0402 },
      ],
      { geometryStatus: "surveyed" },
    );
    const { ctx, lots } = makeCtx({ initialLots: [lot] });
    await run(ctx, {
      lotId: lot._id,
      polygon: [],
      geometryStatus: "placeholder",
    });
    const updated = lots.get(lot._id)!;
    expect(updated.geometry.polygon).toEqual([]);
    expect(updated.geometryStatus).toBe("placeholder");
  });

  it("rejects a 2-vertex polygon with INVARIANT_VIOLATION", async () => {
    const lot = makeBboxLotFixture(
      "lots:U4",
      { lat: 14.676, lng: 121.0437 },
      [],
    );
    const { ctx } = makeCtx({ initialLots: [lot] });
    const thrown = await run(ctx, {
      lotId: lot._id,
      polygon: [
        { lat: 14.676, lng: 121.04 },
        { lat: 14.677, lng: 121.04 },
      ],
      geometryStatus: "surveyed",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("rejects an unknown lot with NOT_FOUND", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, {
      lotId: "lots:ghost",
      polygon: [],
      geometryStatus: "placeholder",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("rejects out-of-range coords with INVARIANT_VIOLATION", async () => {
    const lot = makeBboxLotFixture(
      "lots:U5",
      { lat: 14.676, lng: 121.0437 },
      [],
    );
    const { ctx } = makeCtx({ initialLots: [lot] });
    const thrown = await run(ctx, {
      lotId: lot._id,
      polygon: [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
        { lat: 2, lng: 2 },
      ],
      geometryStatus: "surveyed",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });
});
