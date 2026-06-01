/**
 * Story 2.5 — `convex/ownerships.ts` unit tests.
 *
 * Coverage target: ≥ 90% line + branch on the module (NFR-M2). The
 * file is read-side only (the transfer mutation lands in Story 2.7),
 * so the cases focus on:
 *   - auth gating (UNAUTHENTICATED, FORBIDDEN)
 *   - sort order (most-recent `effectiveFrom` first)
 *   - empty customer (zero ownership rows)
 *   - retired-lot fallback (`lotCode: "[retired]"`)
 *
 * Strategy: hand-mocked ctx, same pattern as `customers.test.ts`.
 * `convex-test` would require `convex/_generated/` which isn't built
 * in this repo; the hand-mock is small enough to maintain.
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
import { listByCustomer, listByLot } from "../../../convex/ownerships";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const CALLER_ID = "users:office1";
const SESSION_ID = "authSessions:s1";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface UserFixture {
  _id: string;
  _creationTime: number;
  name?: string;
  email?: string;
  isActive?: boolean;
}

interface UserRoleFixture {
  _id: string;
  _creationTime: number;
  userId: string;
  role: RoleName;
  grantedAt: number;
  grantedBy: string;
}

interface OwnershipFixture {
  _id: string;
  _creationTime: number;
  lotId: string;
  customerId: string;
  effectiveFrom: number;
  effectiveTo?: number;
  transferType: "sale" | "inheritance" | "gift" | "court_order" | "initial";
  transferEventId?: string;
  createdAt: number;
  createdBy: string;
}

interface LotFixture {
  _id: string;
  _creationTime: number;
  code: string;
  isRetired: boolean;
}

function makeCtx(opts: {
  roles?: RoleName[];
  initialOwnerships?: OwnershipFixture[];
  initialLots?: LotFixture[];
  authenticated?: boolean;
}) {
  const users = new Map<string, UserFixture>();
  const userRoles = new Map<string, UserRoleFixture>();
  const ownerships = new Map<string, OwnershipFixture>(
    (opts.initialOwnerships ?? []).map((o) => [o._id, o]),
  );
  const lots = new Map<string, LotFixture>(
    (opts.initialLots ?? []).map((l) => [l._id, l]),
  );

  users.set(CALLER_ID, {
    _id: CALLER_ID,
    _creationTime: T0 - 1000,
    name: "Office Staff",
    email: "office@example.com",
    isActive: true,
  });
  const roles = opts.roles ?? ["office_staff"];
  roles.forEach((role, idx) => {
    const rid = `userRoles:caller-${idx}`;
    userRoles.set(rid, {
      _id: rid,
      _creationTime: T0,
      userId: CALLER_ID,
      role,
      grantedAt: T0,
      grantedBy: CALLER_ID,
    });
  });

  if (opts.authenticated === false) {
    mockedGetAuthUserId.mockResolvedValue(null);
    mockedGetAuthSessionId.mockResolvedValue(null);
  } else {
    mockedGetAuthUserId.mockResolvedValue(CALLER_ID as never);
    mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);
  }

  const session = {
    _id: SESSION_ID,
    _creationTime: T0,
    userId: CALLER_ID,
    expirationTime: T0 + 30 * 24 * HOUR_MS,
  };

  interface IdxQuery {
    eq(field: string, value: unknown): IdxQuery;
  }

  function makeQueryBuilder(table: string) {
    type Pred = (r: OwnershipFixture) => boolean;
    const predicates: Pred[] = [];
    const builder = {
      withIndex(_name: string, fn: (q: IdxQuery) => IdxQuery) {
        const q: IdxQuery = {
          eq(field: string, value: unknown) {
            predicates.push(
              (r) => (r as unknown as Record<string, unknown>)[field] === value,
            );
            return this;
          },
        };
        fn(q);
        return builder;
      },
      async collect(): Promise<OwnershipFixture[]> {
        if (table !== "ownerships") return [];
        return Array.from(ownerships.values()).filter((r) =>
          predicates.every((p) => p(r)),
        );
      },
    };
    return builder;
  }

  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === CALLER_ID) return users.get(CALLER_ID);
        if (id === SESSION_ID) return session;
        if (users.has(id)) return users.get(id);
        if (lots.has(id)) return lots.get(id);
        if (ownerships.has(id)) return ownerships.get(id);
        return null;
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return {
            withIndex: () => ({
              collect: async () => Array.from(userRoles.values()),
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

const CUSTOMER_ID = "customers:c1";

function makeOwnership(
  overrides: Partial<OwnershipFixture> & { _id: string },
): OwnershipFixture {
  return {
    _creationTime: T0,
    lotId: overrides.lotId ?? "lots:l1",
    customerId: overrides.customerId ?? CUSTOMER_ID,
    effectiveFrom: overrides.effectiveFrom ?? T0,
    transferType: overrides.transferType ?? "sale",
    createdAt: overrides.createdAt ?? T0,
    createdBy: overrides.createdBy ?? CALLER_ID,
    ...overrides,
  };
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

describe("ownerships.listByCustomer — auth gating", () => {
  const run = handlerOf(listByCustomer);

  it("throws UNAUTHENTICATED when no session", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, { customerId: CUSTOMER_ID }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("throws FORBIDDEN for field_worker", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    const thrown = await run(ctx, { customerId: CUSTOMER_ID }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("throws FORBIDDEN for customer role", async () => {
    const { ctx } = makeCtx({ roles: ["customer"] });
    const thrown = await run(ctx, { customerId: CUSTOMER_ID }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("succeeds for office_staff", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const out = await run(ctx, { customerId: CUSTOMER_ID });
    expect(out).toEqual([]);
  });

  it("succeeds for admin", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const out = await run(ctx, { customerId: CUSTOMER_ID });
    expect(out).toEqual([]);
  });
});

describe("ownerships.listByCustomer — query behaviour", () => {
  const run = handlerOf(listByCustomer);

  it("returns [] for a customer with no ownerships", async () => {
    const { ctx } = makeCtx({});
    const out = (await run(ctx, { customerId: CUSTOMER_ID })) as unknown[];
    expect(out).toEqual([]);
  });

  it("returns rows sorted by effectiveFrom descending (most recent first)", async () => {
    const fromOld = T0 - 5 * 24 * HOUR_MS * 30; // ~5 months ago
    const fromMid = T0 - 2 * 24 * HOUR_MS * 30; // ~2 months ago
    const fromNew = T0 - 1 * 24 * HOUR_MS;
    const { ctx } = makeCtx({
      initialOwnerships: [
        makeOwnership({
          _id: "ownerships:1",
          lotId: "lots:l1",
          effectiveFrom: fromOld,
          effectiveTo: fromMid,
          transferType: "initial",
        }),
        makeOwnership({
          _id: "ownerships:2",
          lotId: "lots:l2",
          effectiveFrom: fromMid,
          effectiveTo: fromNew,
          transferType: "sale",
        }),
        makeOwnership({
          _id: "ownerships:3",
          lotId: "lots:l3",
          effectiveFrom: fromNew,
          transferType: "inheritance",
        }),
      ],
      initialLots: [
        { _id: "lots:l1", _creationTime: T0, code: "A-1", isRetired: false },
        { _id: "lots:l2", _creationTime: T0, code: "B-2", isRetired: false },
        { _id: "lots:l3", _creationTime: T0, code: "C-3", isRetired: false },
      ],
    });
    const out = (await run(ctx, {
      customerId: CUSTOMER_ID,
    })) as Array<{ ownershipId: string; effectiveFrom: number; lotCode: string }>;
    expect(out).toHaveLength(3);
    // Most recent first.
    expect(out[0]!.ownershipId).toBe("ownerships:3");
    expect(out[1]!.ownershipId).toBe("ownerships:2");
    expect(out[2]!.ownershipId).toBe("ownerships:1");
    // effectiveFrom monotonically decreasing.
    expect(out[0]!.effectiveFrom).toBeGreaterThan(out[1]!.effectiveFrom);
    expect(out[1]!.effectiveFrom).toBeGreaterThan(out[2]!.effectiveFrom);
  });

  it("falls back to lotCode: '[retired]' when the lot row is missing", async () => {
    const { ctx } = makeCtx({
      initialOwnerships: [
        makeOwnership({
          _id: "ownerships:1",
          lotId: "lots:gone",
          effectiveFrom: T0 - 1000,
          transferType: "sale",
        }),
      ],
      // No matching `lots:gone` row in `initialLots` → soft FK fallback.
      initialLots: [],
    });
    const out = (await run(ctx, {
      customerId: CUSTOMER_ID,
    })) as Array<{ lotCode: string; lotId: string }>;
    expect(out).toHaveLength(1);
    expect(out[0]!.lotCode).toBe("[retired]");
    expect(out[0]!.lotId).toBe("lots:gone");
  });

  it("returns active rows with effectiveTo absent (open ownership)", async () => {
    const { ctx } = makeCtx({
      initialOwnerships: [
        makeOwnership({
          _id: "ownerships:1",
          lotId: "lots:l1",
          effectiveFrom: T0 - 1000,
          transferType: "sale",
        }),
      ],
      initialLots: [
        { _id: "lots:l1", _creationTime: T0, code: "A-1", isRetired: false },
      ],
    });
    const out = (await run(ctx, {
      customerId: CUSTOMER_ID,
    })) as Array<{ effectiveTo?: number; transferType: string }>;
    expect(out).toHaveLength(1);
    expect(out[0]!.effectiveTo).toBeUndefined();
    expect(out[0]!.transferType).toBe("sale");
  });

  it("scopes results to the given customerId (does not leak rows for other customers)", async () => {
    const { ctx } = makeCtx({
      initialOwnerships: [
        makeOwnership({
          _id: "ownerships:1",
          customerId: CUSTOMER_ID,
          lotId: "lots:l1",
        }),
        makeOwnership({
          _id: "ownerships:2",
          customerId: "customers:other",
          lotId: "lots:l2",
        }),
      ],
      initialLots: [
        { _id: "lots:l1", _creationTime: T0, code: "A-1", isRetired: false },
        { _id: "lots:l2", _creationTime: T0, code: "B-2", isRetired: false },
      ],
    });
    const out = (await run(ctx, {
      customerId: CUSTOMER_ID,
    })) as Array<{ ownershipId: string }>;
    expect(out).toHaveLength(1);
    expect(out[0]!.ownershipId).toBe("ownerships:1");
  });
});

describe("ownerships.listByLot — auth gating", () => {
  const run = handlerOf(listByLot);

  it("throws FORBIDDEN for field_worker", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    const thrown = await run(ctx, { lotId: "lots:l1" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("returns rows sorted by effectiveFrom descending", async () => {
    const fromOld = T0 - 5 * 24 * HOUR_MS;
    const fromNew = T0 - 1 * 24 * HOUR_MS;
    const { ctx } = makeCtx({
      initialOwnerships: [
        makeOwnership({
          _id: "ownerships:1",
          lotId: "lots:l1",
          effectiveFrom: fromOld,
          effectiveTo: fromNew,
          transferType: "initial",
        }),
        makeOwnership({
          _id: "ownerships:2",
          lotId: "lots:l1",
          effectiveFrom: fromNew,
          transferType: "sale",
        }),
      ],
      initialLots: [
        { _id: "lots:l1", _creationTime: T0, code: "A-1", isRetired: false },
      ],
    });
    const out = (await run(ctx, { lotId: "lots:l1" })) as Array<{
      ownershipId: string;
    }>;
    expect(out).toHaveLength(2);
    expect(out[0]!.ownershipId).toBe("ownerships:2");
    expect(out[1]!.ownershipId).toBe("ownerships:1");
  });
});
