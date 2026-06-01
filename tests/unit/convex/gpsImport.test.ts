/**
 * Story 8.1 — `convex/gpsImport.ts` unit tests.
 *
 * Coverage target: ≥ 85% line coverage on the import handler (per
 * the story's "≥ 85% line coverage on convex/import.ts" guidance,
 * adapted to the actual file name).
 *
 * Test strategy: hand-mocked ctx (same pattern as `lots.test.ts` and
 * `users.test.ts`). `convex-test` is not used because it requires
 * `convex/_generated/` which this repo deliberately omits.
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
import { importGpsBatch } from "../../../convex/gpsImport";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const USER_ID = "users:admin1";
const SESSION_ID = "authSessions:sessAdmin";

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
  status:
    | "available"
    | "reserved"
    | "sold"
    | "occupied"
    | "cancelled"
    | "defaulted"
    | "transferred";
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

/**
 * Hand-rolled ctx mock — admin role by default (this file's handler
 * gates on `admin` only). `roles` override lets us exercise the
 * FORBIDDEN path for non-admin callers.
 */
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
    email: "admin@example.com",
  };
  const session = {
    _id: SESSION_ID,
    _creationTime: T0,
    userId: USER_ID,
    expirationTime: T0 + 30 * 24 * HOUR_MS,
  };
  const userRoles = (opts.roles ?? ["admin"]).map((role, idx) => ({
    _id: `userRoles:${idx}`,
    _creationTime: T0,
    userId: USER_ID,
    role,
    grantedAt: T0,
    grantedBy: USER_ID,
  }));

  function readDottedField(row: LotFixture, path: string): unknown {
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
          eq(field: string, value: unknown) {
            this.eqs[field] = value;
            return this;
          },
        };
        fn(q);
        for (const [field, value] of Object.entries(q.eqs)) {
          predicates.push((r) => readDottedField(r, field) === value);
        }
        return builder;
      },
      async first(): Promise<LotFixture | null> {
        if (table !== "lots") return null;
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

  interface IndexQuery {
    eqs: Record<string, unknown>;
    eq(field: string, value: unknown): IndexQuery;
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

/** Fixture builder — a placeholder-geometry lot with the given code. */
function makeLot(
  code: string,
  overrides: Partial<LotFixture> = {},
): LotFixture {
  return {
    _id: `lots:${code}`,
    _creationTime: T0,
    code,
    section: "D",
    block: "5",
    row: "12",
    type: "single",
    dimensions: { widthM: 1.5, depthM: 2.5 },
    basePriceCents: 100_000_00,
    status: "available",
    geometry: {
      centroid: { lat: 14.676, lng: 121.0437 },
      polygon: [],
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

/** A 4-vertex rectangle around the cemetery centroid (Manila-valid). */
function makeRectanglePolygon(): { lat: number; lng: number }[] {
  return [
    { lat: 14.6758, lng: 121.0398 },
    { lat: 14.6762, lng: 121.0398 },
    { lat: 14.6762, lng: 121.0402 },
    { lat: 14.6758, lng: 121.0402 },
  ];
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

describe("importGpsBatch", () => {
  const run = handlerOf(importGpsBatch);

  it("happy path: applies geometry to a matched placeholder lot, emits one audit row", async () => {
    const lot = makeLot("D-5-12");
    const { ctx, lots, inserts, patches } = makeCtx({
      initialLots: [lot],
    });

    const polygon = makeRectanglePolygon();
    const result = (await run(ctx, {
      items: [{ lotCode: "D-5-12", polygon }],
    })) as {
      totalItems: number;
      updated: number;
      skippedAlreadySurveyed: unknown[];
      errors: unknown[];
    };

    expect(result.totalItems).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.skippedAlreadySurveyed).toHaveLength(0);
    expect(result.errors).toHaveLength(0);

    const after = lots.get(lot._id)!;
    expect(after.geometryStatus).toBe("surveyed");
    expect(after.geometry.polygon).toEqual(polygon);
    expect(after.geometry.bboxMinLat).toBeCloseTo(14.6758);
    expect(after.geometry.bboxMaxLat).toBeCloseTo(14.6762);
    expect(after.geometry.bboxMinLng).toBeCloseTo(121.0398);
    expect(after.geometry.bboxMaxLng).toBeCloseTo(121.0402);
    // Vertex-average centroid
    expect(after.geometry.centroid.lat).toBeCloseTo(14.676, 4);
    expect(after.geometry.centroid.lng).toBeCloseTo(121.04, 4);

    expect(patches).toHaveLength(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.row.action).toBe("update");
    expect(inserts[0]!.row.entityType).toBe("lot");
    expect(inserts[0]!.row.before).toMatchObject({ geometryStatus: "placeholder" });
    expect(inserts[0]!.row.after).toMatchObject({ geometryStatus: "surveyed" });
    expect(inserts[0]!.row.reason).toBe("GPS survey import");
  });

  it("uses operator-supplied reason in the audit row", async () => {
    const lot = makeLot("D-5-12");
    const { ctx, inserts } = makeCtx({ initialLots: [lot] });
    await run(ctx, {
      items: [{ lotCode: "D-5-12", polygon: makeRectanglePolygon() }],
      reason: "Initial GPS import — ticket #487",
    });
    expect(inserts[0]!.row.reason).toBe("Initial GPS import — ticket #487");
  });

  it("uses the supplied centroid when one is provided per item", async () => {
    const lot = makeLot("D-5-12");
    const { ctx, lots } = makeCtx({ initialLots: [lot] });
    const explicitCentroid = { lat: 14.676, lng: 121.04 };
    await run(ctx, {
      items: [
        {
          lotCode: "D-5-12",
          polygon: makeRectanglePolygon(),
          centroid: explicitCentroid,
        },
      ],
    });
    expect(lots.get(lot._id)!.geometry.centroid).toEqual(explicitCentroid);
  });

  it("reports NOT_FOUND for an unknown lot code; no audit emitted", async () => {
    const { ctx, inserts, patches } = makeCtx({ initialLots: [] });
    const result = (await run(ctx, {
      items: [{ lotCode: "GHOST-1", polygon: makeRectanglePolygon() }],
    })) as { updated: number; errors: { lotCode: string; reason: string }[] };
    expect(result.updated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.lotCode).toBe("GHOST-1");
    expect(result.errors[0]!.reason).toBe("NOT_FOUND");
    expect(inserts).toHaveLength(0);
    expect(patches).toHaveLength(0);
  });

  it("reports INVALID_INPUT for an empty / whitespace lotCode", async () => {
    const { ctx } = makeCtx({ initialLots: [] });
    const result = (await run(ctx, {
      items: [
        { lotCode: "   ", polygon: makeRectanglePolygon() },
        { lotCode: "", polygon: makeRectanglePolygon() },
      ],
    })) as { updated: number; errors: { reason: string }[] };
    expect(result.updated).toBe(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.every((e) => e.reason === "INVALID_INPUT")).toBe(true);
  });

  it("reports INVALID_POLYGON for an empty polygon (import requires real shape)", async () => {
    const lot = makeLot("D-5-12");
    const { ctx, inserts, patches } = makeCtx({ initialLots: [lot] });
    const result = (await run(ctx, {
      items: [{ lotCode: "D-5-12", polygon: [] }],
    })) as { errors: { reason: string; details: string }[]; updated: number };
    expect(result.updated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.reason).toBe("INVALID_POLYGON");
    expect(result.errors[0]!.details).toMatch(/empty/i);
    expect(patches).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("reports INVALID_POLYGON for a 2-vertex polygon", async () => {
    const lot = makeLot("D-5-12");
    const { ctx } = makeCtx({ initialLots: [lot] });
    const result = (await run(ctx, {
      items: [
        {
          lotCode: "D-5-12",
          polygon: [
            { lat: 14.676, lng: 121.04 },
            { lat: 14.677, lng: 121.04 },
          ],
        },
      ],
    })) as { errors: { reason: string }[]; updated: number };
    expect(result.updated).toBe(0);
    expect(result.errors[0]!.reason).toBe("INVALID_POLYGON");
  });

  it("reports INVALID_POLYGON for coords outside the Manila sanity range", async () => {
    const lot = makeLot("D-5-12");
    const { ctx } = makeCtx({ initialLots: [lot] });
    const result = (await run(ctx, {
      items: [
        {
          lotCode: "D-5-12",
          polygon: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
            { lat: 2, lng: 2 },
          ],
        },
      ],
    })) as { errors: { reason: string }[]; updated: number };
    expect(result.updated).toBe(0);
    expect(result.errors[0]!.reason).toBe("INVALID_POLYGON");
  });

  it("skips an already-surveyed lot by default (no force), no audit emitted", async () => {
    const surveyed = makeLot("D-5-12", { geometryStatus: "surveyed" });
    const { ctx, inserts, patches } = makeCtx({ initialLots: [surveyed] });
    const result = (await run(ctx, {
      items: [{ lotCode: "D-5-12", polygon: makeRectanglePolygon() }],
    })) as {
      updated: number;
      skippedAlreadySurveyed: { lotCode: string; reason: string }[];
      errors: unknown[];
    };
    expect(result.updated).toBe(0);
    expect(result.skippedAlreadySurveyed).toHaveLength(1);
    expect(result.skippedAlreadySurveyed[0]!.lotCode).toBe("D-5-12");
    expect(result.skippedAlreadySurveyed[0]!.reason).toBe("ALREADY_SURVEYED");
    expect(result.errors).toHaveLength(0);
    expect(patches).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("re-applies an already-surveyed lot when force=true; counted in updated", async () => {
    const surveyed = makeLot("D-5-12", { geometryStatus: "surveyed" });
    const { ctx, lots, inserts } = makeCtx({ initialLots: [surveyed] });
    const newPolygon = [
      { lat: 14.6759, lng: 121.0399 },
      { lat: 14.6763, lng: 121.0399 },
      { lat: 14.6763, lng: 121.0403 },
      { lat: 14.6759, lng: 121.0403 },
    ];
    const result = (await run(ctx, {
      items: [{ lotCode: "D-5-12", polygon: newPolygon }],
      force: true,
    })) as { updated: number; skippedAlreadySurveyed: unknown[] };
    expect(result.updated).toBe(1);
    expect(result.skippedAlreadySurveyed).toHaveLength(0);
    expect(lots.get(surveyed._id)!.geometry.polygon).toEqual(newPolygon);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.row.before).toMatchObject({ geometryStatus: "surveyed" });
    expect(inserts[0]!.row.after).toMatchObject({ geometryStatus: "surveyed" });
  });

  it("processes a mixed batch: matched + unmatched + invalid + already-surveyed", async () => {
    const placeholder = makeLot("D-5-12");
    const surveyed = makeLot("D-5-13", { geometryStatus: "surveyed" });
    const { ctx, inserts, patches } = makeCtx({
      initialLots: [placeholder, surveyed],
    });

    const result = (await run(ctx, {
      items: [
        { lotCode: "D-5-12", polygon: makeRectanglePolygon() }, // matched -> updated
        { lotCode: "D-5-13", polygon: makeRectanglePolygon() }, // already surveyed -> skipped
        { lotCode: "GHOST-99", polygon: makeRectanglePolygon() }, // unmatched -> NOT_FOUND
        { lotCode: "D-5-14", polygon: [] }, // invalid polygon (empty)
        { lotCode: "", polygon: makeRectanglePolygon() }, // invalid input
      ],
    })) as {
      totalItems: number;
      updated: number;
      skippedAlreadySurveyed: { reason: string }[];
      errors: { lotCode: string; reason: string }[];
    };

    expect(result.totalItems).toBe(5);
    expect(result.updated).toBe(1);
    expect(result.skippedAlreadySurveyed).toHaveLength(1);
    expect(result.errors).toHaveLength(3);
    const reasons = result.errors.map((e) => e.reason).sort();
    expect(reasons).toEqual([
      "INVALID_INPUT",
      "INVALID_POLYGON",
      "NOT_FOUND",
    ]);
    expect(patches).toHaveLength(1);
    expect(inserts).toHaveLength(1);
  });

  it("rejects non-admin callers with FORBIDDEN", async () => {
    for (const role of ["office_staff", "field_worker", "customer"] as const) {
      const { ctx } = makeCtx({ roles: [role] });
      const thrown = await run(ctx, {
        items: [{ lotCode: "D-5-12", polygon: makeRectanglePolygon() }],
      }).catch((e) => e);
      expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
    }
  });

  it("rejects unauthenticated callers with UNAUTHENTICATED", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {
      items: [{ lotCode: "D-5-12", polygon: makeRectanglePolygon() }],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("rejects an empty batch with VALIDATION", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, { items: [] }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects an oversized batch (501 items) with VALIDATION", async () => {
    const { ctx } = makeCtx({});
    const items = Array.from({ length: 501 }, (_, i) => ({
      lotCode: `L-${i}`,
      polygon: makeRectanglePolygon(),
    }));
    const thrown = await run(ctx, { items }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("accepts the maximum batch size (500 items)", async () => {
    // Construct 500 lots; the handler must accept and process them.
    const lots = Array.from({ length: 500 }, (_, i) =>
      makeLot(`L-${i}`),
    );
    const { ctx } = makeCtx({ initialLots: lots });
    const items = lots.map((lot) => ({
      lotCode: lot.code,
      polygon: makeRectanglePolygon(),
    }));
    const result = (await run(ctx, { items })) as { updated: number };
    expect(result.updated).toBe(500);
  });
});
