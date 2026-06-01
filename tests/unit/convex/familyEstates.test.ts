/**
 * Story 2.9 — `convex/familyEstates.ts` unit tests.
 *
 * Coverage target: ≥ 90% line + branch on the module (NFR-M2). The
 * cases mirror the ownership.test.ts pattern (hand-mocked ctx) so the
 * suite runs without `convex/_generated/`.
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
  addLotToEstate,
  createFamilyEstate,
  getEstateForLot,
  getFamilyEstate,
  listEstatesForCustomer,
  listFamilyEstates,
  removeLotFromEstate,
  retireEstate,
  transferEstateOwnership,
} from "../../../convex/familyEstates";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const CALLER_ID = "users:office1";
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
interface UserRoleFixture {
  _id: string;
  _creationTime: number;
  userId: string;
  role: RoleName;
  grantedAt: number;
  grantedBy: string;
}
interface CustomerFixture {
  _id: string;
  _creationTime: number;
  fullName: string;
}
interface LotFixture {
  _id: string;
  _creationTime: number;
  code: string;
  isRetired: boolean;
  status?: string;
  type?: string;
}
interface EstateFixture {
  _id: string;
  _creationTime: number;
  name: string;
  primaryOwnerCustomerId: string;
  secondaryOwnerCustomerIds: string[];
  lotIds: string[];
  notes?: string;
  createdAt: number;
  createdByUserId: string;
  retiredAt?: number;
  retiredByUserId?: string;
  retirementReason?: string;
}
interface OwnershipFixture {
  _id: string;
  _creationTime: number;
  lotId: string;
  customerId: string;
  effectiveFrom: number;
  effectiveTo?: number;
  transferType: string;
  createdAt: number;
  createdBy: string;
}
interface ContractFixture {
  _id: string;
  _creationTime: number;
  familyEstateId?: string;
  state: string;
}
interface MembershipFixture {
  _id: string;
  _creationTime: number;
  lotId: string;
  familyEstateId: string;
  isActive: boolean;
  addedAt: number;
  removedAt?: number;
}

function makeCtx(opts: {
  roles?: RoleName[];
  callerId?: string;
  initialEstates?: EstateFixture[];
  initialCustomers?: CustomerFixture[];
  initialLots?: LotFixture[];
  initialOwnerships?: OwnershipFixture[];
  initialContracts?: ContractFixture[];
  initialMemberships?: MembershipFixture[];
  authenticated?: boolean;
}) {
  const callerId = opts.callerId ?? CALLER_ID;
  const users = new Map<string, UserFixture>();
  const userRoles = new Map<string, UserRoleFixture>();
  const estates = new Map<string, EstateFixture>(
    (opts.initialEstates ?? []).map((e) => [e._id, e]),
  );
  const customers = new Map<string, CustomerFixture>(
    (opts.initialCustomers ?? []).map((c) => [c._id, c]),
  );
  const lots = new Map<string, LotFixture>(
    (opts.initialLots ?? []).map((l) => [l._id, l]),
  );
  const ownerships = new Map<string, OwnershipFixture>(
    (opts.initialOwnerships ?? []).map((o) => [o._id, o]),
  );
  const contracts = new Map<string, ContractFixture>(
    (opts.initialContracts ?? []).map((c) => [c._id, c]),
  );
  const memberships = new Map<string, MembershipFixture>(
    (opts.initialMemberships ?? []).map((m) => [m._id, m]),
  );
  const auditLog: Array<Record<string, unknown>> = [];

  users.set(callerId, {
    _id: callerId,
    _creationTime: T0 - 1000,
    name: "Caller",
    email: "caller@example.com",
    isActive: true,
  });
  const roles = opts.roles ?? ["office_staff"];
  roles.forEach((role, idx) => {
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

  interface IdxQuery {
    eq(field: string, value: unknown): IdxQuery;
  }

  let insertCounter = 0;

  function makeQueryBuilder(table: string) {
    type Pred = (r: Record<string, unknown>) => boolean;
    const predicates: Pred[] = [];
    const builder = {
      withIndex(_name: string, fn: (q: IdxQuery) => IdxQuery) {
        const q: IdxQuery = {
          eq(field: string, value: unknown) {
            predicates.push((r) => r[field] === value);
            return this;
          },
        };
        fn(q);
        return builder;
      },
      async collect(): Promise<unknown[]> {
        const source: Array<Record<string, unknown>> =
          table === "familyEstates"
            ? (Array.from(estates.values()) as unknown as Array<
                Record<string, unknown>
              >)
            : table === "ownerships"
              ? (Array.from(ownerships.values()) as unknown as Array<
                  Record<string, unknown>
                >)
              : table === "contracts"
                ? (Array.from(contracts.values()) as unknown as Array<
                    Record<string, unknown>
                  >)
                : table === "lotEstateMembership"
                  ? (Array.from(memberships.values()) as unknown as Array<
                      Record<string, unknown>
                    >)
                  : [];
        return source.filter((r) => predicates.every((p) => p(r)));
      },
      async first(): Promise<unknown | null> {
        const all = await builder.collect();
        return all.length > 0 ? all[0] : null;
      },
    };
    return builder;
  }

  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === callerId) return users.get(callerId);
        if (id === SESSION_ID) return session;
        if (users.has(id)) return users.get(id);
        if (estates.has(id)) return estates.get(id);
        if (customers.has(id)) return customers.get(id);
        if (lots.has(id)) return lots.get(id);
        if (ownerships.has(id)) return ownerships.get(id);
        if (contracts.has(id)) return contracts.get(id);
        return null;
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        insertCounter += 1;
        const id = `${table}:new${insertCounter}`;
        const stored = {
          _id: id,
          _creationTime: T0,
          ...row,
        } as Record<string, unknown>;
        if (table === "familyEstates") {
          estates.set(id, stored as unknown as EstateFixture);
        } else if (table === "ownerships") {
          ownerships.set(id, stored as unknown as OwnershipFixture);
        } else if (table === "lotEstateMembership") {
          memberships.set(id, stored as unknown as MembershipFixture);
        } else if (table === "auditLog") {
          auditLog.push(stored);
        }
        return id;
      }),
      patch: vi.fn(
        async (id: string, patch: Record<string, unknown>) => {
          if (estates.has(id)) {
            const existing = estates.get(id)!;
            estates.set(id, { ...existing, ...patch } as EstateFixture);
          } else if (ownerships.has(id)) {
            const existing = ownerships.get(id)!;
            ownerships.set(id, { ...existing, ...patch } as OwnershipFixture);
          } else if (memberships.has(id)) {
            const existing = memberships.get(id)!;
            memberships.set(id, { ...existing, ...patch } as MembershipFixture);
          }
        },
      ),
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

  return { ctx, estates, ownerships, memberships, auditLog };
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

function makeLot(overrides: Partial<LotFixture> & { _id: string }): LotFixture {
  return {
    _creationTime: T0,
    code: overrides.code ?? "A-1",
    isRetired: overrides.isRetired ?? false,
    status: overrides.status ?? "available",
    type: overrides.type ?? "single",
    ...overrides,
  };
}
function makeCustomer(_id: string, fullName: string): CustomerFixture {
  return { _id, _creationTime: T0, fullName };
}
function makeEstate(
  overrides: Partial<EstateFixture> & { _id: string },
): EstateFixture {
  return {
    _creationTime: T0,
    name: overrides.name ?? "de los Santos Family Estate",
    primaryOwnerCustomerId: overrides.primaryOwnerCustomerId ?? "customers:c1",
    secondaryOwnerCustomerIds: overrides.secondaryOwnerCustomerIds ?? [],
    lotIds: overrides.lotIds ?? ["lots:l1", "lots:l2"],
    createdAt: overrides.createdAt ?? T0,
    createdByUserId: overrides.createdByUserId ?? CALLER_ID,
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

describe("familyEstates.createFamilyEstate", () => {
  const run = handlerOf(createFamilyEstate);

  it("throws UNAUTHENTICATED when no session", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {
      name: "de los Santos",
      primaryOwnerCustomerId: "customers:c1",
      secondaryOwnerCustomerIds: [],
      lotIds: ["lots:l1", "lots:l2"],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("throws FORBIDDEN for field_worker", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    const thrown = await run(ctx, {
      name: "de los Santos",
      primaryOwnerCustomerId: "customers:c1",
      secondaryOwnerCustomerIds: [],
      lotIds: ["lots:l1", "lots:l2"],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects too-few lots", async () => {
    const { ctx } = makeCtx({
      initialCustomers: [makeCustomer("customers:c1", "Juan")],
      initialLots: [makeLot({ _id: "lots:l1" })],
    });
    const thrown = await run(ctx, {
      name: "de los Santos Family Estate",
      primaryOwnerCustomerId: "customers:c1",
      secondaryOwnerCustomerIds: [],
      lotIds: ["lots:l1"],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects too-many lots (>12)", async () => {
    const lotIds = Array.from({ length: 13 }, (_, i) => `lots:l${i + 1}`);
    const { ctx } = makeCtx({
      initialCustomers: [makeCustomer("customers:c1", "Juan")],
      initialLots: lotIds.map((id, i) => makeLot({ _id: id, code: `A-${i}` })),
    });
    const thrown = await run(ctx, {
      name: "Big Estate",
      primaryOwnerCustomerId: "customers:c1",
      secondaryOwnerCustomerIds: [],
      lotIds,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects when primary appears in secondaries", async () => {
    const { ctx } = makeCtx({
      initialCustomers: [
        makeCustomer("customers:c1", "Juan"),
        makeCustomer("customers:c2", "Maria"),
      ],
      initialLots: [
        makeLot({ _id: "lots:l1" }),
        makeLot({ _id: "lots:l2" }),
      ],
    });
    const thrown = await run(ctx, {
      name: "Estate",
      primaryOwnerCustomerId: "customers:c1",
      secondaryOwnerCustomerIds: ["customers:c1"],
      lotIds: ["lots:l1", "lots:l2"],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects when a lot is retired", async () => {
    const { ctx } = makeCtx({
      initialCustomers: [makeCustomer("customers:c1", "Juan")],
      initialLots: [
        makeLot({ _id: "lots:l1" }),
        makeLot({ _id: "lots:l2", isRetired: true }),
      ],
    });
    const thrown = await run(ctx, {
      name: "Estate",
      primaryOwnerCustomerId: "customers:c1",
      secondaryOwnerCustomerIds: [],
      lotIds: ["lots:l1", "lots:l2"],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("rejects when a lot is already in another active estate", async () => {
    const existing = makeEstate({
      _id: "familyEstates:e1",
      name: "Prior Estate",
      lotIds: ["lots:l1", "lots:l2"],
      primaryOwnerCustomerId: "customers:c1",
    });
    const { ctx } = makeCtx({
      initialEstates: [existing],
      initialCustomers: [makeCustomer("customers:c1", "Juan")],
      initialLots: [
        makeLot({ _id: "lots:l1" }),
        makeLot({ _id: "lots:l2" }),
        makeLot({ _id: "lots:l3" }),
      ],
    });
    const thrown = await run(ctx, {
      name: "New Estate",
      primaryOwnerCustomerId: "customers:c1",
      secondaryOwnerCustomerIds: [],
      lotIds: ["lots:l2", "lots:l3"],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("succeeds for office_staff with valid input (happy path)", async () => {
    const { ctx, estates, auditLog } = makeCtx({
      initialCustomers: [
        makeCustomer("customers:c1", "Juan"),
        makeCustomer("customers:c2", "Maria"),
        makeCustomer("customers:c3", "Pedro"),
      ],
      initialLots: [
        makeLot({ _id: "lots:l1", code: "A-1" }),
        makeLot({ _id: "lots:l2", code: "A-2" }),
        makeLot({ _id: "lots:l3", code: "A-3" }),
        makeLot({ _id: "lots:l4", code: "A-4" }),
      ],
    });
    const result = (await run(ctx, {
      name: "de los Santos Family Estate",
      primaryOwnerCustomerId: "customers:c1",
      secondaryOwnerCustomerIds: ["customers:c2", "customers:c3"],
      lotIds: ["lots:l1", "lots:l2", "lots:l3", "lots:l4"],
      notes: "Originally reserved 1987",
    })) as { estateId: string };
    expect(result.estateId).toMatch(/familyEstates:new/);
    const stored = estates.get(result.estateId)!;
    expect(stored.lotIds).toHaveLength(4);
    expect(stored.secondaryOwnerCustomerIds).toHaveLength(2);
    expect(auditLog.length).toBeGreaterThan(0);
  });

  it("allows reuse of lots from a retired estate", async () => {
    const retiredEstate = makeEstate({
      _id: "familyEstates:retired1",
      lotIds: ["lots:l1", "lots:l2"],
      primaryOwnerCustomerId: "customers:c1",
      retiredAt: T0 - 1000,
    });
    const { ctx } = makeCtx({
      initialEstates: [retiredEstate],
      initialCustomers: [makeCustomer("customers:c1", "Juan")],
      initialLots: [
        makeLot({ _id: "lots:l1" }),
        makeLot({ _id: "lots:l2" }),
      ],
    });
    const result = (await run(ctx, {
      name: "Successor Estate",
      primaryOwnerCustomerId: "customers:c1",
      secondaryOwnerCustomerIds: [],
      lotIds: ["lots:l1", "lots:l2"],
    })) as { estateId: string };
    expect(result.estateId).toMatch(/familyEstates:new/);
  });
});

describe("familyEstates.retireEstate", () => {
  const run = handlerOf(retireEstate);

  it("throws FORBIDDEN for office_staff (admin-only)", async () => {
    const estate = makeEstate({ _id: "familyEstates:e1" });
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      initialEstates: [estate],
    });
    const thrown = await run(ctx, {
      estateId: "familyEstates:e1",
      reason: "Household consolidated lots after inheritance settlement.",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects too-short reason", async () => {
    const estate = makeEstate({ _id: "familyEstates:e1" });
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialEstates: [estate],
    });
    const thrown = await run(ctx, {
      estateId: "familyEstates:e1",
      reason: "short",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects already-retired estate", async () => {
    const estate = makeEstate({
      _id: "familyEstates:e1",
      retiredAt: T0 - 1000,
    });
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialEstates: [estate],
    });
    const thrown = await run(ctx, {
      estateId: "familyEstates:e1",
      reason: "Household consolidated lots after inheritance settlement.",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("succeeds for admin with valid reason", async () => {
    const estate = makeEstate({ _id: "familyEstates:e1" });
    const { ctx, estates } = makeCtx({
      roles: ["admin"],
      initialEstates: [estate],
    });
    const result = (await run(ctx, {
      estateId: "familyEstates:e1",
      reason: "Family decided to split estate after settlement.",
    })) as { estateId: string; retiredAt: number };
    expect(result.retiredAt).toBe(T0);
    expect(estates.get("familyEstates:e1")!.retiredAt).toBe(T0);
  });
});

describe("familyEstates.addLotToEstate / removeLotFromEstate", () => {
  it("adds a lot to an active estate (happy path)", async () => {
    const estate = makeEstate({
      _id: "familyEstates:e1",
      lotIds: ["lots:l1", "lots:l2"],
    });
    const { ctx, estates } = makeCtx({
      initialEstates: [estate],
      initialCustomers: [makeCustomer("customers:c1", "Juan")],
      initialLots: [
        makeLot({ _id: "lots:l1" }),
        makeLot({ _id: "lots:l2" }),
        makeLot({ _id: "lots:l3" }),
      ],
    });
    const result = (await handlerOf(addLotToEstate)(ctx, {
      estateId: "familyEstates:e1",
      lotId: "lots:l3",
    })) as { lotCount: number };
    expect(result.lotCount).toBe(3);
    expect(estates.get("familyEstates:e1")!.lotIds).toHaveLength(3);
  });

  it("rejects adding a duplicate lot", async () => {
    const estate = makeEstate({
      _id: "familyEstates:e1",
      lotIds: ["lots:l1", "lots:l2"],
    });
    const { ctx } = makeCtx({
      initialEstates: [estate],
      initialLots: [
        makeLot({ _id: "lots:l1" }),
        makeLot({ _id: "lots:l2" }),
      ],
    });
    const thrown = await handlerOf(addLotToEstate)(ctx, {
      estateId: "familyEstates:e1",
      lotId: "lots:l1",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects removing below the 2-lot minimum", async () => {
    const estate = makeEstate({
      _id: "familyEstates:e1",
      lotIds: ["lots:l1", "lots:l2"],
    });
    const { ctx } = makeCtx({
      initialEstates: [estate],
      initialLots: [
        makeLot({ _id: "lots:l1" }),
        makeLot({ _id: "lots:l2" }),
      ],
    });
    const thrown = await handlerOf(removeLotFromEstate)(ctx, {
      estateId: "familyEstates:e1",
      lotId: "lots:l2",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("removes a lot when count is above the minimum", async () => {
    const estate = makeEstate({
      _id: "familyEstates:e1",
      lotIds: ["lots:l1", "lots:l2", "lots:l3"],
    });
    const { ctx, estates } = makeCtx({
      initialEstates: [estate],
      initialLots: [
        makeLot({ _id: "lots:l1" }),
        makeLot({ _id: "lots:l2" }),
        makeLot({ _id: "lots:l3" }),
      ],
    });
    const result = (await handlerOf(removeLotFromEstate)(ctx, {
      estateId: "familyEstates:e1",
      lotId: "lots:l3",
    })) as { lotCount: number };
    expect(result.lotCount).toBe(2);
    expect(estates.get("familyEstates:e1")!.lotIds).toEqual([
      "lots:l1",
      "lots:l2",
    ]);
  });

  it("refuses to remove a lot while an active contract references the estate", async () => {
    const estate = makeEstate({
      _id: "familyEstates:e1",
      lotIds: ["lots:l1", "lots:l2", "lots:l3"],
    });
    const contract: ContractFixture = {
      _id: "contracts:c1",
      _creationTime: T0,
      familyEstateId: estate._id,
      state: "active",
    };
    const { ctx } = makeCtx({
      initialEstates: [estate],
      initialContracts: [contract],
      initialLots: [
        makeLot({ _id: "lots:l1" }),
        makeLot({ _id: "lots:l2" }),
        makeLot({ _id: "lots:l3" }),
      ],
    });
    const thrown = await handlerOf(removeLotFromEstate)(ctx, {
      estateId: "familyEstates:e1",
      lotId: "lots:l3",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });
});

describe("familyEstates.transferEstateOwnership", () => {
  it("atomically rewrites the estate's owners and the per-lot ownership rows", async () => {
    const estate = makeEstate({
      _id: "familyEstates:e1",
      lotIds: ["lots:l1", "lots:l2", "lots:l3"],
      primaryOwnerCustomerId: "customers:c1",
      secondaryOwnerCustomerIds: ["customers:c2"],
    });
    const openOwnerships: OwnershipFixture[] = [
      {
        _id: "ownerships:o1",
        _creationTime: T0,
        lotId: "lots:l1",
        customerId: "customers:c1",
        effectiveFrom: T0 - 1000,
        transferType: "sale",
        createdAt: T0 - 1000,
        createdBy: CALLER_ID,
      },
      {
        _id: "ownerships:o2",
        _creationTime: T0,
        lotId: "lots:l2",
        customerId: "customers:c1",
        effectiveFrom: T0 - 1000,
        transferType: "sale",
        createdAt: T0 - 1000,
        createdBy: CALLER_ID,
      },
      {
        _id: "ownerships:o3",
        _creationTime: T0,
        lotId: "lots:l3",
        customerId: "customers:c1",
        effectiveFrom: T0 - 1000,
        transferType: "sale",
        createdAt: T0 - 1000,
        createdBy: CALLER_ID,
      },
    ];
    const { ctx, estates, ownerships, auditLog } = makeCtx({
      initialEstates: [estate],
      initialCustomers: [
        makeCustomer("customers:c1", "Juan (deceased)"),
        makeCustomer("customers:c2", "Maria"),
        makeCustomer("customers:c3", "Maria heir"),
      ],
      initialLots: [
        makeLot({ _id: "lots:l1" }),
        makeLot({ _id: "lots:l2" }),
        makeLot({ _id: "lots:l3" }),
      ],
      initialOwnerships: openOwnerships,
    });
    const result = (await handlerOf(transferEstateOwnership)(ctx, {
      estateId: "familyEstates:e1",
      newPrimaryOwnerCustomerId: "customers:c3",
      newSecondaryOwnerCustomerIds: [],
      transferReason: "Inheritance per affidavit dated 2026-06-01",
      transferDate: T0,
      transferType: "inheritance",
    })) as { affectedLotCount: number; newOwnershipIds: string[] };
    expect(result.affectedLotCount).toBe(3);
    expect(estates.get("familyEstates:e1")!.primaryOwnerCustomerId).toBe(
      "customers:c3",
    );
    // Every prior open ownership row was closed.
    for (const id of ["ownerships:o1", "ownerships:o2", "ownerships:o3"]) {
      expect(ownerships.get(id)!.effectiveTo).toBe(T0);
    }
    // A summary audit row was emitted for the estate transfer.
    expect(
      auditLog.some(
        (row) =>
          (row as { action?: string }).action === "transfer" &&
          (row as { entityId?: string }).entityId === "familyEstates:e1",
      ),
    ).toBe(true);
  });

  it("rejects self-transfer (new primary equals current primary)", async () => {
    const estate = makeEstate({
      _id: "familyEstates:e1",
      primaryOwnerCustomerId: "customers:c1",
    });
    const { ctx } = makeCtx({
      initialEstates: [estate],
      initialCustomers: [makeCustomer("customers:c1", "Juan")],
    });
    const thrown = await handlerOf(transferEstateOwnership)(ctx, {
      estateId: "familyEstates:e1",
      newPrimaryOwnerCustomerId: "customers:c1",
      newSecondaryOwnerCustomerIds: [],
      transferReason: "Will be rejected",
      transferDate: T0,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });
});

describe("familyEstates query surface", () => {
  it("getFamilyEstate hydrates owners + lot codes", async () => {
    const estate = makeEstate({
      _id: "familyEstates:e1",
      primaryOwnerCustomerId: "customers:c1",
      secondaryOwnerCustomerIds: ["customers:c2"],
      lotIds: ["lots:l1", "lots:l2"],
    });
    const { ctx } = makeCtx({
      initialEstates: [estate],
      initialCustomers: [
        makeCustomer("customers:c1", "Juan"),
        makeCustomer("customers:c2", "Maria"),
      ],
      initialLots: [
        makeLot({ _id: "lots:l1", code: "A-1" }),
        makeLot({ _id: "lots:l2", code: "A-2" }),
      ],
    });
    const out = (await handlerOf(getFamilyEstate)(ctx, {
      estateId: "familyEstates:e1",
    })) as {
      primaryOwnerFullName: string;
      lots: Array<{ code: string }>;
      isActive: boolean;
    };
    expect(out.primaryOwnerFullName).toBe("Juan");
    expect(out.lots.map((l) => l.code)).toEqual(["A-1", "A-2"]);
    expect(out.isActive).toBe(true);
  });

  it("listFamilyEstates filters retired by default", async () => {
    const e1 = makeEstate({ _id: "familyEstates:e1", lotIds: ["lots:l1", "lots:l2"] });
    const e2 = makeEstate({
      _id: "familyEstates:e2",
      lotIds: ["lots:l3", "lots:l4"],
      retiredAt: T0 - 1000,
    });
    const { ctx } = makeCtx({
      initialEstates: [e1, e2],
      initialCustomers: [makeCustomer("customers:c1", "Juan")],
      initialLots: [
        makeLot({ _id: "lots:l1" }),
        makeLot({ _id: "lots:l2" }),
        makeLot({ _id: "lots:l3" }),
        makeLot({ _id: "lots:l4" }),
      ],
    });
    const active = (await handlerOf(listFamilyEstates)(ctx, {})) as Array<{
      isActive: boolean;
    }>;
    expect(active.every((r) => r.isActive)).toBe(true);
    expect(active).toHaveLength(1);

    const all = (await handlerOf(listFamilyEstates)(ctx, {
      includeRetired: true,
    })) as Array<{ isActive: boolean }>;
    expect(all).toHaveLength(2);
  });

  it("listEstatesForCustomer returns primary + secondary memberships", async () => {
    const primary = makeEstate({
      _id: "familyEstates:e1",
      primaryOwnerCustomerId: "customers:c1",
      lotIds: ["lots:l1", "lots:l2"],
    });
    const secondary = makeEstate({
      _id: "familyEstates:e2",
      primaryOwnerCustomerId: "customers:c2",
      secondaryOwnerCustomerIds: ["customers:c1"],
      lotIds: ["lots:l3", "lots:l4"],
    });
    const { ctx } = makeCtx({
      initialEstates: [primary, secondary],
      initialCustomers: [
        makeCustomer("customers:c1", "Juan"),
        makeCustomer("customers:c2", "Maria"),
      ],
      initialLots: [
        makeLot({ _id: "lots:l1" }),
        makeLot({ _id: "lots:l2" }),
        makeLot({ _id: "lots:l3" }),
        makeLot({ _id: "lots:l4" }),
      ],
    });
    const out = (await handlerOf(listEstatesForCustomer)(ctx, {
      customerId: "customers:c1",
    })) as Array<{ estateId: string }>;
    const ids = out.map((r) => r.estateId).sort();
    expect(ids).toEqual(["familyEstates:e1", "familyEstates:e2"]);
  });

  it("getEstateForLot returns the matching active estate", async () => {
    const e1 = makeEstate({
      _id: "familyEstates:e1",
      lotIds: ["lots:l1", "lots:l2"],
    });
    const { ctx } = makeCtx({
      initialEstates: [e1],
      initialCustomers: [makeCustomer("customers:c1", "Juan")],
      initialLots: [
        makeLot({ _id: "lots:l1" }),
        makeLot({ _id: "lots:l2" }),
      ],
    });
    const match = (await handlerOf(getEstateForLot)(ctx, {
      lotId: "lots:l2",
    })) as { estateId: string } | null;
    expect(match?.estateId).toBe("familyEstates:e1");

    const miss = await handlerOf(getEstateForLot)(ctx, {
      lotId: "lots:l99",
    });
    expect(miss).toBeNull();
  });
});

/**
 * Story 2.9 adversarial-review fixes.
 *
 * Coverage:
 *   - CRITICAL: concurrent `createFamilyEstate` race rejected via the
 *     `lotEstateMembership` companion table.
 *   - H2: cross-customer attack rejected when a candidate lot's open
 *     ownership names a different customer than the estate's primary.
 *   - H3: `removeLotFromEstate` allows lot removal once the bound
 *     contract is `paid_in_full` (terminal financial state).
 */
describe("familyEstates adversarial-review fixes", () => {
  describe("CRITICAL — concurrent createFamilyEstate race", () => {
    it("rejects the second createFamilyEstate when membership row already exists for the lot", async () => {
      // Simulate the OCC-retried loser of a real race: the winner has
      // already inserted its membership row, and the loser's retried
      // transaction now re-reads `lotEstateMembership.by_lot_active`
      // and rejects.
      const winningEstate = makeEstate({
        _id: "familyEstates:winner",
        lotIds: ["lots:l1", "lots:l2"],
        primaryOwnerCustomerId: "customers:c1",
      });
      const winningMembership: MembershipFixture[] = [
        {
          _id: "lotEstateMembership:m1",
          _creationTime: T0,
          lotId: "lots:l1",
          familyEstateId: "familyEstates:winner",
          isActive: true,
          addedAt: T0,
        },
        {
          _id: "lotEstateMembership:m2",
          _creationTime: T0,
          lotId: "lots:l2",
          familyEstateId: "familyEstates:winner",
          isActive: true,
          addedAt: T0,
        },
      ];
      const { ctx } = makeCtx({
        initialEstates: [winningEstate],
        initialMemberships: winningMembership,
        initialCustomers: [
          makeCustomer("customers:c1", "Juan"),
          makeCustomer("customers:c2", "Maria"),
        ],
        initialLots: [
          makeLot({ _id: "lots:l1" }),
          makeLot({ _id: "lots:l2" }),
          makeLot({ _id: "lots:l3" }),
        ],
      });
      const thrown = await handlerOf(createFamilyEstate)(ctx, {
        name: "Losing concurrent attempt",
        primaryOwnerCustomerId: "customers:c2",
        secondaryOwnerCustomerIds: [],
        lotIds: ["lots:l1", "lots:l3"],
      }).catch((e) => e);
      expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
      const data = (thrown as ConvexError<Value>).data as unknown as
        | ErrorPayload
        | undefined;
      const details = data?.details as
        | { kind?: string }
        | undefined;
      expect(details?.kind).toBe("lot_in_other_active_estate");
    });

    it("writes membership rows on a successful createFamilyEstate", async () => {
      const { ctx, memberships } = makeCtx({
        initialCustomers: [makeCustomer("customers:c1", "Juan")],
        initialLots: [
          makeLot({ _id: "lots:l1" }),
          makeLot({ _id: "lots:l2" }),
          makeLot({ _id: "lots:l3" }),
        ],
      });
      const result = (await handlerOf(createFamilyEstate)(ctx, {
        name: "First estate",
        primaryOwnerCustomerId: "customers:c1",
        secondaryOwnerCustomerIds: [],
        lotIds: ["lots:l1", "lots:l2", "lots:l3"],
      })) as { estateId: string };
      // One active membership row per lot.
      const active = Array.from(memberships.values()).filter(
        (m) => m.familyEstateId === result.estateId && m.isActive === true,
      );
      expect(active).toHaveLength(3);
      const lotIds = active.map((m) => m.lotId).sort();
      expect(lotIds).toEqual(["lots:l1", "lots:l2", "lots:l3"]);
    });

    it("Convex OCC retry of the loser: second sequential createFamilyEstate referencing overlapping lots rejects", async () => {
      // Models the OCC retry semantics: after the winning transaction
      // commits its membership rows, the OCC layer re-runs the loser
      // from the post-commit state. The loser's
      // `findActiveMembershipForLot` now sees the winner's
      // `isActive: true` row and rejects with
      // `lot_in_other_active_estate`. This is the exact transaction
      // order Convex guarantees for two parallel mutations referencing
      // overlapping rows in the same index. Promise.all on the
      // hand-mocked ctx cannot simulate the OCC re-run (the mock has
      // no transaction layer), but sequential execution accurately
      // reflects the post-retry state observed by the loser.
      const { ctx } = makeCtx({
        initialCustomers: [
          makeCustomer("customers:c1", "Juan"),
          makeCustomer("customers:c2", "Maria"),
        ],
        initialLots: [
          makeLot({ _id: "lots:l1" }),
          makeLot({ _id: "lots:l2" }),
          makeLot({ _id: "lots:l3" }),
        ],
      });
      // Winning transaction commits.
      const winner = (await handlerOf(createFamilyEstate)(ctx, {
        name: "Estate A",
        primaryOwnerCustomerId: "customers:c1",
        secondaryOwnerCustomerIds: [],
        lotIds: ["lots:l1", "lots:l2"],
      })) as { estateId: string };
      expect(winner.estateId).toMatch(/^familyEstates:/);
      // Loser, OCC-retried after the winner committed, now hits the
      // post-commit state.
      const loser = await handlerOf(createFamilyEstate)(ctx, {
        name: "Estate B",
        primaryOwnerCustomerId: "customers:c2",
        secondaryOwnerCustomerIds: [],
        lotIds: ["lots:l2", "lots:l3"],
      }).catch((e) => e);
      expect(getCode(loser)).toBe(ErrorCode.INVARIANT_VIOLATION);
      const details = (
        (loser as ConvexError<Value>).data as unknown as ErrorPayload
      ).details as { kind?: string };
      expect(details.kind).toBe("lot_in_other_active_estate");
    });
  });

  describe("H2 — cross-customer attack on createFamilyEstate", () => {
    it("rejects when a candidate lot's open ownership names a different customer", async () => {
      // lots:l1 is owned by customer:cY; office_staff tries to compose
      // an estate naming customer:cX as primary while including l1.
      const openOwnership: OwnershipFixture = {
        _id: "ownerships:o1",
        _creationTime: T0,
        lotId: "lots:l1",
        customerId: "customers:cY", // owned by Y, not X
        effectiveFrom: T0 - 10000,
        transferType: "sale",
        createdAt: T0 - 10000,
        createdBy: CALLER_ID,
      };
      const { ctx } = makeCtx({
        initialCustomers: [
          makeCustomer("customers:cX", "Customer X"),
          makeCustomer("customers:cY", "Customer Y"),
        ],
        initialLots: [
          makeLot({ _id: "lots:l1" }),
          makeLot({ _id: "lots:l2" }),
        ],
        initialOwnerships: [openOwnership],
      });
      const thrown = await handlerOf(createFamilyEstate)(ctx, {
        name: "Stolen Estate",
        primaryOwnerCustomerId: "customers:cX",
        secondaryOwnerCustomerIds: [],
        lotIds: ["lots:l1", "lots:l2"],
      }).catch((e) => e);
      expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
      const details = (
        (thrown as ConvexError<Value>).data as unknown as ErrorPayload
      ).details as { kind?: string; lotId?: string };
      expect(details.kind).toBe("lot_owned_by_different_customer");
      expect(details.lotId).toBe("lots:l1");
    });

    it("allows estates composed only of lots owned by the primary or available lots", async () => {
      // l1: owned by primary (allowed).  l2: never sold (allowed).
      const open: OwnershipFixture = {
        _id: "ownerships:o1",
        _creationTime: T0,
        lotId: "lots:l1",
        customerId: "customers:cX",
        effectiveFrom: T0 - 10000,
        transferType: "sale",
        createdAt: T0 - 10000,
        createdBy: CALLER_ID,
      };
      const { ctx } = makeCtx({
        initialCustomers: [makeCustomer("customers:cX", "Customer X")],
        initialLots: [
          makeLot({ _id: "lots:l1" }),
          makeLot({ _id: "lots:l2" }),
        ],
        initialOwnerships: [open],
      });
      const result = (await handlerOf(createFamilyEstate)(ctx, {
        name: "Valid Estate",
        primaryOwnerCustomerId: "customers:cX",
        secondaryOwnerCustomerIds: [],
        lotIds: ["lots:l1", "lots:l2"],
      })) as { estateId: string };
      expect(result.estateId).toMatch(/^familyEstates:/);
    });
  });

  describe("H3 — removeLotFromEstate allows paid_in_full estates", () => {
    it("allows lot removal when bound contract is paid_in_full", async () => {
      const estate = makeEstate({
        _id: "familyEstates:e1",
        lotIds: ["lots:l1", "lots:l2", "lots:l3"],
      });
      const paidContract: ContractFixture = {
        _id: "contracts:paid",
        _creationTime: T0,
        familyEstateId: estate._id,
        state: "paid_in_full",
      };
      const membershipRows: MembershipFixture[] = ["lots:l1", "lots:l2", "lots:l3"].map(
        (lid, i) => ({
          _id: `lotEstateMembership:m${i + 1}`,
          _creationTime: T0,
          lotId: lid,
          familyEstateId: estate._id,
          isActive: true,
          addedAt: T0,
        }),
      );
      const { ctx, estates, memberships } = makeCtx({
        initialEstates: [estate],
        initialContracts: [paidContract],
        initialMemberships: membershipRows,
        initialLots: [
          makeLot({ _id: "lots:l1" }),
          makeLot({ _id: "lots:l2" }),
          makeLot({ _id: "lots:l3" }),
        ],
      });
      const result = (await handlerOf(removeLotFromEstate)(ctx, {
        estateId: estate._id,
        lotId: "lots:l3",
      })) as { lotCount: number };
      expect(result.lotCount).toBe(2);
      expect(estates.get(estate._id)!.lotIds).toEqual([
        "lots:l1",
        "lots:l2",
      ]);
      // Membership row for l3 was deactivated.
      const m3 = Array.from(memberships.values()).find(
        (m) => m.lotId === "lots:l3",
      );
      expect(m3?.isActive).toBe(false);
      expect(typeof m3?.removedAt).toBe("number");
    });

    it("still rejects lot removal when bound contract is active", async () => {
      const estate = makeEstate({
        _id: "familyEstates:e1",
        lotIds: ["lots:l1", "lots:l2", "lots:l3"],
      });
      const activeContract: ContractFixture = {
        _id: "contracts:active",
        _creationTime: T0,
        familyEstateId: estate._id,
        state: "active",
      };
      const { ctx } = makeCtx({
        initialEstates: [estate],
        initialContracts: [activeContract],
        initialLots: [
          makeLot({ _id: "lots:l1" }),
          makeLot({ _id: "lots:l2" }),
          makeLot({ _id: "lots:l3" }),
        ],
      });
      const thrown = await handlerOf(removeLotFromEstate)(ctx, {
        estateId: estate._id,
        lotId: "lots:l3",
      }).catch((e) => e);
      expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
    });
  });

  describe("membership lifecycle on retireEstate", () => {
    it("retireEstate deactivates every active membership row", async () => {
      const estate = makeEstate({
        _id: "familyEstates:e1",
        lotIds: ["lots:l1", "lots:l2"],
      });
      const memberships0: MembershipFixture[] = ["lots:l1", "lots:l2"].map(
        (lid, i) => ({
          _id: `lotEstateMembership:m${i + 1}`,
          _creationTime: T0,
          lotId: lid,
          familyEstateId: estate._id,
          isActive: true,
          addedAt: T0,
        }),
      );
      const { ctx, memberships } = makeCtx({
        roles: ["admin"],
        initialEstates: [estate],
        initialMemberships: memberships0,
      });
      await handlerOf(retireEstate)(ctx, {
        estateId: estate._id,
        reason: "Household consolidated lots after inheritance.",
      });
      const remainingActive = Array.from(memberships.values()).filter(
        (m) => m.isActive === true,
      );
      expect(remainingActive).toHaveLength(0);
    });
  });
});
