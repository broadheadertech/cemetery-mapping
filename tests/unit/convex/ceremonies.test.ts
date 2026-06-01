/**
 * Story 7.5 — `convex/ceremonies.ts` unit tests.
 *
 * Hand-mocked ctx pattern (matches `interments.test.ts`, `occupants.test.ts`).
 * Coverage:
 *   - scheduleCeremony: auth gating, happy path, defensive validators,
 *     contract / lot guards, lot conflict, chapel conflict, pathway
 *     conflict, no-conflict when one side doesn't reserve, audit shape.
 *   - completeCeremony: auth, status guard, status flip + audit.
 *   - cancelCeremony: admin-only, reason floor, status guard, audit.
 *   - getCeremony / listCeremonies: read-side projection sanity.
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
  scheduleCeremony,
  completeCeremony,
  cancelCeremony,
  getCeremony,
  listCeremonies,
} from "../../../convex/ceremonies";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const USER_ID = "users:abc123";
const SESSION_ID = "authSessions:def456";
const CONSULTANT_ID = "users:consultant1";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface LotFixture {
  _id: string;
  _creationTime: number;
  code: string;
  section: string;
  isRetired: boolean;
}

interface ContractFixture {
  _id: string;
  _creationTime: number;
  customerId: string;
  contractNumber: string;
  state: "active" | "paid_in_full" | "cancelled" | "voided" | "in_default";
  // Epic 7 H4: scheduleCeremony validates the lot belongs to the contract.
  lotId: string;
}

interface CustomerFixture {
  _id: string;
  fullName: string;
}

interface CeremonyFixture {
  _id: string;
  _creationTime: number;
  kind: "consecration" | "interment" | "memorial_anniversary";
  contractId: string;
  familyEstateId?: string;
  lotId: string;
  scheduledAt: number;
  durationMinutes: number;
  chapelReserved: boolean;
  pathwayReserved: boolean;
  consultantUserId?: string;
  notes?: string;
  status: "scheduled" | "completed" | "cancelled";
  scheduledBy: string;
  scheduledAt_createdAt: number;
  completedAt?: number;
  completedBy?: string;
  cancellationReason?: string;
}

interface IntermentFixture {
  _id: string;
  _creationTime: number;
  lotId: string;
  occupantId: string;
  scheduledAt: number;
  status: "scheduled" | "completed" | "cancelled";
  scheduledBy: string;
  scheduledAt_createdAt: number;
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
  contracts: Map<string, ContractFixture>;
  customers: Map<string, CustomerFixture>;
  ceremonies: Map<string, CeremonyFixture>;
  interments: Map<string, IntermentFixture>;
  auditInserts: AuditInsert[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  authenticated?: boolean;
  initialLots?: LotFixture[];
  initialContracts?: ContractFixture[];
  initialCustomers?: CustomerFixture[];
  initialCeremonies?: CeremonyFixture[];
  initialInterments?: IntermentFixture[];
  consultantUser?: { _id: string; name?: string };
}): CtxBag {
  const lots = new Map<string, LotFixture>(
    (opts.initialLots ?? []).map((l) => [l._id, l]),
  );
  const contracts = new Map<string, ContractFixture>(
    (opts.initialContracts ?? []).map((c) => [c._id, c]),
  );
  const customers = new Map<string, CustomerFixture>(
    (opts.initialCustomers ?? []).map((c) => [c._id, c]),
  );
  const ceremonies = new Map<string, CeremonyFixture>(
    (opts.initialCeremonies ?? []).map((c) => [c._id, c]),
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

  const consultant = opts.consultantUser;

  let nextId = 1;

  interface IndexQuery {
    eq(field: string, value: unknown): IndexQuery;
    gte(field: string, value: unknown): IndexQuery;
    lte(field: string, value: unknown): IndexQuery;
    gt(field: string, value: unknown): IndexQuery;
    lt(field: string, value: unknown): IndexQuery;
  }

  function makeBuilderFromMap<T>(map: Map<string, T>) {
    type Predicate = (r: T) => boolean;
    const predicates: Predicate[] = [];
    const builder = {
      withIndex(_indexName: string, fn?: (q: IndexQuery) => IndexQuery) {
        if (fn === undefined) return builder;
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
        return Array.from(map.values()).filter((r) =>
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
        if (consultant !== undefined && id === consultant._id) return consultant;
        if (lots.has(id)) return lots.get(id);
        if (contracts.has(id)) return contracts.get(id);
        if (customers.has(id)) return customers.get(id);
        if (ceremonies.has(id)) return ceremonies.get(id);
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
        if (table === "ceremonies") return makeBuilderFromMap(ceremonies);
        if (table === "interments") return makeBuilderFromMap(interments);
        return {
          withIndex: () => ({
            collect: async () => [],
            first: async () => null,
            take: async () => [],
          }),
        };
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "ceremonies") {
          const id = `ceremonies:${nextId++}`;
          const doc = {
            _id: id,
            _creationTime: T0,
            ...row,
          } as CeremonyFixture;
          ceremonies.set(id, doc);
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
      patch: vi.fn(async (id: string, partial: Record<string, unknown>) => {
        if (ceremonies.has(id)) {
          const existing = ceremonies.get(id)!;
          ceremonies.set(id, { ...existing, ...partial } as CeremonyFixture);
          return null;
        }
        return null;
      }),
    },
  };
  return { lots, contracts, customers, ceremonies, interments, auditInserts, ctx };
}

function makeLot(overrides: Partial<LotFixture> = {}): LotFixture {
  return {
    _id: overrides._id ?? "lots:1",
    _creationTime: T0,
    code: overrides.code ?? "A-1-1",
    section: overrides.section ?? "A",
    isRetired: overrides.isRetired ?? false,
  };
}
function makeContract(overrides: Partial<ContractFixture> = {}): ContractFixture {
  return {
    _id: overrides._id ?? "contracts:1",
    _creationTime: T0,
    customerId: overrides.customerId ?? "customers:1",
    contractNumber: overrides.contractNumber ?? "C-001",
    state: overrides.state ?? "active",
    // Epic 7 H4: scheduleCeremony now requires the lot to belong to the
    // contract. Default the contract's lot to the base ceremony lot so
    // happy-path fixtures satisfy the invariant; tests that exercise a
    // mismatch pass an explicit `lotId`.
    lotId: overrides.lotId ?? "lots:1",
  };
}
function makeCustomer(overrides: Partial<CustomerFixture> = {}): CustomerFixture {
  return {
    _id: overrides._id ?? "customers:1",
    fullName: overrides.fullName ?? "Santos Family",
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

describe("scheduleCeremony", () => {
  const run = handlerOf(scheduleCeremony);
  const baseArgs = {
    kind: "consecration" as const,
    contractId: "contracts:1",
    lotId: "lots:1",
    scheduledAt: T0 + 7 * DAY_MS,
    durationMinutes: 90,
    chapelReserved: true,
    pathwayReserved: true,
  };

  it("inserts a consecration row and emits audit on the happy path", async () => {
    const { ctx, ceremonies, auditInserts } = makeCtx({
      roles: ["office_staff"],
      initialLots: [makeLot()],
      initialContracts: [makeContract()],
      initialCustomers: [makeCustomer()],
    });
    const result = (await run(ctx, baseArgs)) as { ceremonyId: string };
    expect(ceremonies.size).toBe(1);
    const row = ceremonies.get(result.ceremonyId)!;
    expect(row.kind).toBe("consecration");
    expect(row.status).toBe("scheduled");
    expect(row.chapelReserved).toBe(true);
    expect(row.pathwayReserved).toBe(true);
    expect(row.scheduledBy).toBe(USER_ID);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]!.row.action).toBe("create");
    expect(auditInserts[0]!.row.entityType).toBe("lot");
    expect(auditInserts[0]!.row.entityId).toBe("lots:1");
    expect((auditInserts[0]!.row.after as { kind: string }).kind).toBe(
      "consecration",
    );
  });

  it("rejects unauthenticated callers", async () => {
    const { ctx } = makeCtx({
      authenticated: false,
      initialLots: [makeLot()],
      initialContracts: [makeContract()],
    });
    try {
      await run(ctx, baseArgs);
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.UNAUTHENTICATED);
    }
  });

  it("rejects field_worker role", async () => {
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      initialLots: [makeLot()],
      initialContracts: [makeContract()],
    });
    try {
      await run(ctx, baseArgs);
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.FORBIDDEN);
    }
  });

  it("rejects when the contract is voided", async () => {
    const { ctx } = makeCtx({
      initialLots: [makeLot()],
      initialContracts: [makeContract({ state: "voided" })],
    });
    try {
      await run(ctx, baseArgs);
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.INVARIANT_VIOLATION);
    }
  });

  it("rejects when the lot is retired", async () => {
    const { ctx } = makeCtx({
      initialLots: [makeLot({ isRetired: true })],
      initialContracts: [makeContract()],
    });
    try {
      await run(ctx, baseArgs);
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.INVARIANT_VIOLATION);
    }
  });

  it("Epic 7 H4: rejects when the lot does not belong to the contract", async () => {
    const { ctx } = makeCtx({
      initialLots: [makeLot()], // lots:1 (the ceremony's lot)
      // Contract is bound to a DIFFERENT lot — scheduling the ceremony on
      // lots:1 against this contract is an inconsistent join.
      initialContracts: [makeContract({ lotId: "lots:other" })],
    });
    try {
      await run(ctx, baseArgs); // baseArgs.lotId === "lots:1"
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.INVARIANT_VIOLATION);
    }
  });

  it("rejects bad durationMinutes", async () => {
    const { ctx } = makeCtx({
      initialLots: [makeLot()],
      initialContracts: [makeContract()],
    });
    try {
      await run(ctx, { ...baseArgs, durationMinutes: 5 });
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.VALIDATION);
    }
  });

  it("throws SCHEDULING_CONFLICT when same-lot ceremony overlaps", async () => {
    const existing: CeremonyFixture = {
      _id: "ceremonies:existing",
      _creationTime: T0,
      kind: "consecration",
      contractId: "contracts:1",
      lotId: "lots:1",
      scheduledAt: baseArgs.scheduledAt + 30 * MINUTE_MS,
      durationMinutes: 90,
      chapelReserved: false,
      pathwayReserved: false,
      status: "scheduled",
      scheduledBy: USER_ID,
      scheduledAt_createdAt: T0,
    };
    const { ctx } = makeCtx({
      initialLots: [makeLot()],
      initialContracts: [makeContract()],
      initialCeremonies: [existing],
    });
    try {
      await run(ctx, { ...baseArgs, chapelReserved: false, pathwayReserved: false });
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.SCHEDULING_CONFLICT);
      const data = (e as ConvexError<Value>).data as unknown as ErrorPayload;
      expect(data.details?.resource).toBe("lot");
    }
  });

  it("throws SCHEDULING_CONFLICT when chapel is already reserved (different lot)", async () => {
    const existing: CeremonyFixture = {
      _id: "ceremonies:other-lot",
      _creationTime: T0,
      kind: "consecration",
      contractId: "contracts:1",
      lotId: "lots:other",
      scheduledAt: baseArgs.scheduledAt + 30 * MINUTE_MS,
      durationMinutes: 90,
      chapelReserved: true,
      pathwayReserved: false,
      status: "scheduled",
      scheduledBy: USER_ID,
      scheduledAt_createdAt: T0,
    };
    const { ctx } = makeCtx({
      initialLots: [makeLot()],
      initialContracts: [makeContract()],
      initialCeremonies: [existing],
    });
    try {
      await run(ctx, baseArgs);
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.SCHEDULING_CONFLICT);
      const data = (e as ConvexError<Value>).data as unknown as ErrorPayload;
      expect(data.details?.resource).toBe("chapel");
    }
  });

  it("does NOT conflict when chapel is reserved by only one of two ceremonies", async () => {
    const existing: CeremonyFixture = {
      _id: "ceremonies:other-lot",
      _creationTime: T0,
      kind: "consecration",
      contractId: "contracts:1",
      lotId: "lots:other",
      scheduledAt: baseArgs.scheduledAt + 30 * MINUTE_MS,
      durationMinutes: 90,
      chapelReserved: false,
      pathwayReserved: false,
      status: "scheduled",
      scheduledBy: USER_ID,
      scheduledAt_createdAt: T0,
    };
    const { ctx, ceremonies } = makeCtx({
      initialLots: [makeLot()],
      initialContracts: [makeContract()],
      initialCeremonies: [existing],
    });
    await run(ctx, { ...baseArgs, chapelReserved: true, pathwayReserved: false });
    expect(ceremonies.size).toBe(2);
  });

  it("cross-kind: detects an interments-table row on the same lot", async () => {
    const legacy: IntermentFixture = {
      _id: "interments:1",
      _creationTime: T0,
      lotId: "lots:1",
      occupantId: "occupants:1",
      scheduledAt: baseArgs.scheduledAt + 15 * MINUTE_MS,
      status: "scheduled",
      scheduledBy: USER_ID,
      scheduledAt_createdAt: T0,
    };
    const { ctx } = makeCtx({
      initialLots: [makeLot()],
      initialContracts: [makeContract()],
      initialInterments: [legacy],
    });
    try {
      await run(ctx, { ...baseArgs, chapelReserved: false, pathwayReserved: false });
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.SCHEDULING_CONFLICT);
      const data = (e as ConvexError<Value>).data as unknown as ErrorPayload;
      expect(data.details?.resource).toBe("lot");
    }
  });

  it("validates consultantUserId when provided", async () => {
    const { ctx } = makeCtx({
      initialLots: [makeLot()],
      initialContracts: [makeContract()],
    });
    try {
      await run(ctx, { ...baseArgs, consultantUserId: "users:missing" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.NOT_FOUND);
    }
  });

  it("accepts a known consultantUserId", async () => {
    const { ctx, ceremonies } = makeCtx({
      initialLots: [makeLot()],
      initialContracts: [makeContract()],
      consultantUser: { _id: CONSULTANT_ID, name: "Maria de los Santos" },
    });
    const result = (await run(ctx, {
      ...baseArgs,
      consultantUserId: CONSULTANT_ID,
    })) as { ceremonyId: string };
    const row = ceremonies.get(result.ceremonyId)!;
    expect(row.consultantUserId).toBe(CONSULTANT_ID);
  });
});

describe("completeCeremony", () => {
  const run = handlerOf(completeCeremony);

  it("flips status to completed and emits audit", async () => {
    const existing: CeremonyFixture = {
      _id: "ceremonies:1",
      _creationTime: T0,
      kind: "consecration",
      contractId: "contracts:1",
      lotId: "lots:1",
      scheduledAt: T0 + DAY_MS,
      durationMinutes: 90,
      chapelReserved: true,
      pathwayReserved: true,
      status: "scheduled",
      scheduledBy: USER_ID,
      scheduledAt_createdAt: T0,
    };
    const { ctx, ceremonies, auditInserts } = makeCtx({
      roles: ["office_staff"],
      initialCeremonies: [existing],
    });
    await run(ctx, { ceremonyId: existing._id });
    expect(ceremonies.get(existing._id)!.status).toBe("completed");
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]!.row.action).toBe("transition");
  });

  it("rejects when ceremony is already completed", async () => {
    const existing: CeremonyFixture = {
      _id: "ceremonies:2",
      _creationTime: T0,
      kind: "consecration",
      contractId: "contracts:1",
      lotId: "lots:1",
      scheduledAt: T0 + DAY_MS,
      durationMinutes: 90,
      chapelReserved: true,
      pathwayReserved: true,
      status: "completed",
      scheduledBy: USER_ID,
      scheduledAt_createdAt: T0,
    };
    const { ctx } = makeCtx({ initialCeremonies: [existing] });
    try {
      await run(ctx, { ceremonyId: existing._id });
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.INVARIANT_VIOLATION);
    }
  });

  it("rejects field_worker callers", async () => {
    const existing: CeremonyFixture = {
      _id: "ceremonies:3",
      _creationTime: T0,
      kind: "consecration",
      contractId: "contracts:1",
      lotId: "lots:1",
      scheduledAt: T0 + DAY_MS,
      durationMinutes: 90,
      chapelReserved: true,
      pathwayReserved: true,
      status: "scheduled",
      scheduledBy: USER_ID,
      scheduledAt_createdAt: T0,
    };
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      initialCeremonies: [existing],
    });
    try {
      await run(ctx, { ceremonyId: existing._id });
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.FORBIDDEN);
    }
  });
});

describe("cancelCeremony", () => {
  const run = handlerOf(cancelCeremony);
  const existing: CeremonyFixture = {
    _id: "ceremonies:cancelme",
    _creationTime: T0,
    kind: "consecration",
    contractId: "contracts:1",
    lotId: "lots:1",
    scheduledAt: T0 + DAY_MS,
    durationMinutes: 90,
    chapelReserved: true,
    pathwayReserved: true,
    status: "scheduled",
    scheduledBy: USER_ID,
    scheduledAt_createdAt: T0,
  };

  it("admin can cancel with a valid reason", async () => {
    const { ctx, ceremonies, auditInserts } = makeCtx({
      roles: ["admin"],
      initialCeremonies: [{ ...existing }],
    });
    await run(ctx, {
      ceremonyId: existing._id,
      reason: "Family rescheduled to August",
    });
    const row = ceremonies.get(existing._id)!;
    expect(row.status).toBe("cancelled");
    expect(row.cancellationReason).toBe("Family rescheduled to August");
    expect(auditInserts).toHaveLength(1);
  });

  it("rejects office_staff role", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      initialCeremonies: [{ ...existing }],
    });
    try {
      await run(ctx, {
        ceremonyId: existing._id,
        reason: "Family rescheduled to August",
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.FORBIDDEN);
    }
  });

  it("rejects short reasons", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialCeremonies: [{ ...existing }],
    });
    try {
      await run(ctx, { ceremonyId: existing._id, reason: "short" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.VALIDATION);
    }
  });
});

describe("getCeremony + listCeremonies", () => {
  const get = handlerOf(getCeremony);
  const list = handlerOf(listCeremonies);

  const sample: CeremonyFixture = {
    _id: "ceremonies:sample",
    _creationTime: T0,
    kind: "consecration",
    contractId: "contracts:1",
    lotId: "lots:1",
    scheduledAt: T0 + 5 * DAY_MS,
    durationMinutes: 90,
    chapelReserved: true,
    pathwayReserved: true,
    status: "scheduled",
    scheduledBy: USER_ID,
    scheduledAt_createdAt: T0,
  };

  it("getCeremony returns enriched detail", async () => {
    const { ctx } = makeCtx({
      initialLots: [makeLot()],
      initialContracts: [makeContract()],
      initialCustomers: [makeCustomer()],
      initialCeremonies: [sample],
    });
    const result = (await get(ctx, { ceremonyId: sample._id })) as
      | { ceremonyId: string; customerName: string; lotCode: string }
      | null;
    expect(result).not.toBeNull();
    expect(result!.customerName).toBe("Santos Family");
    expect(result!.lotCode).toBe("A-1-1");
  });

  it("getCeremony returns null when not found", async () => {
    const { ctx } = makeCtx({});
    const result = await get(ctx, { ceremonyId: "ceremonies:missing" });
    expect(result).toBeNull();
  });

  it("listCeremonies returns rows in ascending order", async () => {
    const earlier: CeremonyFixture = { ...sample, _id: "ceremonies:a", scheduledAt: T0 + DAY_MS };
    const later: CeremonyFixture = { ...sample, _id: "ceremonies:b", scheduledAt: T0 + 10 * DAY_MS };
    const { ctx } = makeCtx({
      initialLots: [makeLot()],
      initialContracts: [makeContract()],
      initialCustomers: [makeCustomer()],
      initialCeremonies: [later, earlier],
    });
    const result = (await list(ctx, {})) as Array<{ scheduledAt: number }>;
    expect(result).toHaveLength(2);
    expect(result[0]!.scheduledAt).toBeLessThan(result[1]!.scheduledAt);
  });
});
