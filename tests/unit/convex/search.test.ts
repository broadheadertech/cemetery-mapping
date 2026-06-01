/**
 * Story 1.10 — `convex/search.ts` unit tests.
 *
 * Coverage target: ≥ 85% (NFR-M2 doesn't apply — search is read-only,
 * non-financial). We cover AC6: role enforcement, index path, fallback
 * substring scan, retired filtering, result cap, and scope restriction.
 *
 * Strategy: hand-rolled ctx (same pattern as `lots.test.ts`). The mock
 * extends the lots.test.ts `withIndex` builder with `.lt(...)` because
 * `searchLots`'s `by_code` prefix range uses `gte().lt()`.
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
import { searchAll } from "../../../convex/search";

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

function makeCtx(opts: {
  roles?: RoleName[];
  initialLots?: LotFixture[];
  authenticated?: boolean;
}) {
  const lots = new Map<string, LotFixture>(
    (opts.initialLots ?? []).map((l) => [l._id, l]),
  );

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

  // Index-aware query builder. Supports `withIndex` with eq / gte / lt
  // for the code-prefix range path, `collect`, and `first`.
  function makeQueryBuilder(table: string) {
    type Predicate = (r: LotFixture) => boolean;
    const predicates: Predicate[] = [];
    const builder = {
      withIndex(_name: string, fn: (q: IdxQuery) => IdxQuery) {
        const q: IdxQuery = {
          eq(field: string, value: unknown) {
            predicates.push(
              (r) => (r as unknown as Record<string, unknown>)[field] === value,
            );
            return this;
          },
          gte(field: string, value: string) {
            predicates.push((r) => {
              const v = (r as unknown as Record<string, unknown>)[field];
              return typeof v === "string" && v >= value;
            });
            return this;
          },
          lt(field: string, value: string) {
            predicates.push((r) => {
              const v = (r as unknown as Record<string, unknown>)[field];
              return typeof v === "string" && v < value;
            });
            return this;
          },
          lte(field: string, value: string) {
            predicates.push((r) => {
              const v = (r as unknown as Record<string, unknown>)[field];
              return typeof v === "string" && v <= value;
            });
            return this;
          },
        };
        fn(q);
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

  interface IdxQuery {
    eq(field: string, value: unknown): IdxQuery;
    gte(field: string, value: string): IdxQuery;
    lt(field: string, value: string): IdxQuery;
    lte(field: string, value: string): IdxQuery;
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
            withIndex: () => ({
              collect: async () => userRoles,
            }),
          };
        }
        return makeQueryBuilder(table);
      }),
    },
  };

  return { ctx };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerOf(fn: any): (ctx: unknown, args: unknown) => Promise<unknown> {
  for (const key of ["_handler", "handler", "invokeQuery"]) {
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

const run = handlerOf(searchAll);

describe("searchAll — auth gating", () => {
  it("throws UNAUTHENTICATED when no session", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    let caught: unknown = null;
    try {
      await run(ctx, { query: "D" });
    } catch (e) {
      caught = e;
    }
    expect(getCode(caught)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("throws FORBIDDEN for customer role", async () => {
    const { ctx } = makeCtx({ roles: ["customer"] });
    let caught: unknown = null;
    try {
      await run(ctx, { query: "D" });
    } catch (e) {
      caught = e;
    }
    expect(getCode(caught)).toBe(ErrorCode.FORBIDDEN);
  });

  it("succeeds for admin", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const out = await run(ctx, { query: "" });
    expect(out).toEqual({
      lots: [],
      customers: [],
      contracts: [],
      receipts: [],
    });
  });

  it("succeeds for office_staff", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const out = await run(ctx, { query: "" });
    expect(out).toBeDefined();
  });

  it("succeeds for field_worker", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    const out = await run(ctx, { query: "" });
    expect(out).toBeDefined();
  });
});

describe("searchAll — empty query", () => {
  it("returns all empty arrays for empty input", async () => {
    const { ctx } = makeCtx({
      initialLots: [makeLotFixture({ _id: "lots:1", code: "D-5-12" })],
    });
    const out = (await run(ctx, { query: "" })) as Record<string, unknown[]>;
    expect(out.lots).toEqual([]);
    expect(out.customers).toEqual([]);
    expect(out.contracts).toEqual([]);
    expect(out.receipts).toEqual([]);
  });

  it("returns all empty arrays for whitespace-only input", async () => {
    const { ctx } = makeCtx({
      initialLots: [makeLotFixture({ _id: "lots:1", code: "D-5-12" })],
    });
    const out = (await run(ctx, { query: "   " })) as Record<
      string,
      unknown[]
    >;
    expect(out.lots).toEqual([]);
  });
});

describe("searchAll — lot code prefix path", () => {
  it("finds lots by code prefix D-5", async () => {
    const { ctx } = makeCtx({
      initialLots: [
        makeLotFixture({ _id: "lots:1", code: "D-5-1" }),
        makeLotFixture({ _id: "lots:2", code: "D-5-2" }),
        makeLotFixture({ _id: "lots:3", code: "E-1-1", section: "E" }),
      ],
    });
    const out = (await run(ctx, { query: "D-5" })) as {
      lots: Array<{ _id: string; code: string }>;
    };
    expect(out.lots).toHaveLength(2);
    expect(out.lots.map((l) => l.code).sort()).toEqual(["D-5-1", "D-5-2"]);
  });

  it("lowercased input is uppercased before index lookup", async () => {
    const { ctx } = makeCtx({
      initialLots: [
        makeLotFixture({ _id: "lots:1", code: "D-5-1" }),
      ],
    });
    const out = (await run(ctx, { query: "d-5" })) as {
      lots: Array<{ _id: string; code: string }>;
    };
    expect(out.lots).toHaveLength(1);
    expect(out.lots[0]?.code).toBe("D-5-1");
  });
});

describe("searchAll — section prefix path", () => {
  it("finds lots by single-letter section prefix", async () => {
    const { ctx } = makeCtx({
      initialLots: [
        makeLotFixture({ _id: "lots:1", code: "D-5-1", section: "D" }),
        makeLotFixture({ _id: "lots:2", code: "D-5-2", section: "D" }),
        makeLotFixture({ _id: "lots:3", code: "E-1-1", section: "E" }),
      ],
    });
    const out = (await run(ctx, { query: "D" })) as {
      lots: Array<{ _id: string; code: string }>;
    };
    // Single-letter "D" hits the code-prefix path first (it matches
    // `/^[A-Z0-9-]+$/`), which still returns the right rows because
    // every D-section lot has a code starting with "D".
    expect(out.lots.length).toBeGreaterThan(0);
    out.lots.forEach((l) => expect(l.code.startsWith("D")).toBe(true));
  });
});

describe("searchAll — substring fallback path", () => {
  it("performs in-memory substring filter for free-text (non-code) queries", async () => {
    // Query contains a space → fails the `^[A-Z0-9-]+$` and `^[A-Z]$`
    // patterns → falls through to the in-memory substring scan.
    const { ctx } = makeCtx({
      initialLots: [
        makeLotFixture({ _id: "lots:1", code: "D-5-1", row: "row family" }),
        makeLotFixture({ _id: "lots:2", code: "E-1-1", row: "row other" }),
      ],
    });
    const out = (await run(ctx, { query: "row family" })) as {
      lots: Array<{ _id: string; code: string }>;
    };
    expect(out.lots).toHaveLength(1);
    expect(out.lots[0]?._id).toBe("lots:1");
  });
});

describe("searchAll — invariants", () => {
  it("excludes retired lots from results", async () => {
    const { ctx } = makeCtx({
      initialLots: [
        makeLotFixture({ _id: "lots:1", code: "D-5-1", isRetired: false }),
        makeLotFixture({ _id: "lots:2", code: "D-5-2", isRetired: true }),
      ],
    });
    const out = (await run(ctx, { query: "D-5" })) as {
      lots: Array<{ _id: string; code: string }>;
    };
    expect(out.lots).toHaveLength(1);
    expect(out.lots[0]?._id).toBe("lots:1");
  });

  it("caps lot results at 20", async () => {
    const many: LotFixture[] = [];
    for (let i = 0; i < 30; i++) {
      many.push(
        makeLotFixture({
          _id: `lots:${i}`,
          code: `D-9-${String(i).padStart(3, "0")}`,
        }),
      );
    }
    const { ctx } = makeCtx({ initialLots: many });
    const out = (await run(ctx, { query: "D-9" })) as {
      lots: Array<{ _id: string }>;
    };
    expect(out.lots.length).toBeLessThanOrEqual(20);
  });

  it("returns minimal projection (no PII, no geometry, no price)", async () => {
    const { ctx } = makeCtx({
      initialLots: [makeLotFixture({ _id: "lots:1", code: "D-5-1" })],
    });
    const out = (await run(ctx, { query: "D-5" })) as {
      lots: Array<Record<string, unknown>>;
    };
    const lot = out.lots[0]!;
    expect(Object.keys(lot).sort()).toEqual(
      ["_id", "block", "code", "row", "section", "status", "type"].sort(),
    );
  });

  it("respects scopes — lots-only excludes the customers stub", async () => {
    const { ctx } = makeCtx({
      initialLots: [makeLotFixture({ _id: "lots:1", code: "D-5-1" })],
    });
    const out = (await run(ctx, { query: "D-5", scopes: ["lots"] })) as {
      lots: unknown[];
      customers: unknown[];
    };
    expect(out.lots).toHaveLength(1);
    expect(out.customers).toEqual([]);
  });

  it("customers stub returns []", async () => {
    const { ctx } = makeCtx({});
    const out = (await run(ctx, { query: "anything" })) as {
      customers: unknown[];
    };
    expect(out.customers).toEqual([]);
  });

  it("contracts / receipts stub returns []", async () => {
    const { ctx } = makeCtx({});
    const out = (await run(ctx, { query: "anything" })) as {
      contracts: unknown[];
      receipts: unknown[];
    };
    expect(out.contracts).toEqual([]);
    expect(out.receipts).toEqual([]);
  });
});
