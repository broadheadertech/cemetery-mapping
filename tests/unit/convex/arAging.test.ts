/**
 * Story 4.1 — `convex/arAging.ts` unit tests.
 *
 * Coverage:
 *   - `bucketFromDaysOverdue` boundary classifier (0 / 1 / 30 / 31 / 60 /
 *     61 / 90 / 91 / 365).
 *   - `pickMostOverdueBucket` precedence (empty / mixed / all-paid).
 *   - `internal_recomputeAgingForContractMutation`:
 *     - Inserts a row when none exists; patches the existing row
 *       otherwise (idempotency: running twice produces identical row).
 *     - Drops the snapshot row when the contract transitions out of
 *       active / in_default (paid_in_full, cancelled).
 *     - Skips waived + paid installments when summing.
 *     - Picks the most-overdue bucket across multiple installments.
 *   - `internal_recomputeAllAging` (the cron's mutation body):
 *     - Iterates active + in_default contracts; skips others.
 *     - Returns `{ processed, skipped }` counts.
 *   - `recomputeNow` admin escape hatch — auth gate + same write path.
 *   - `getAgingSummary` public query — sums across buckets, respects
 *     the `"current"` exclusion, and returns the correct shape.
 *   - `getCurrentAging` last-recompute lookup.
 *   - `getSnapshotForContract` — returns null for unknown contract,
 *     row for a known one.
 *   - Auth gates for every public surface.
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
  bucketFromDaysOverdue,
  getAgingSummary,
  getCurrentAging,
  getSnapshotForContract,
  internal_recomputeAgingForContractMutation,
  internal_recomputeAllAging,
  pickMostOverdueBucket,
  recomputeNow,
} from "../../../convex/arAging";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-05-15T12:00:00+08:00").getTime();
const USER_ID = "users:abc123";
const SESSION_ID = "authSessions:def456";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface ContractFixture {
  _id: string;
  _creationTime: number;
  state:
    | "active"
    | "paid_in_full"
    | "cancelled"
    | "voided"
    | "in_default";
}

interface InstallmentFixture {
  _id: string;
  _creationTime: number;
  contractId: string;
  installmentNumber: number;
  dueDate: number;
  principalCents: number;
  paidCents: number;
  status: "pending" | "paid" | "overdue" | "waived";
}

interface SnapshotFixture {
  _id: string;
  _creationTime: number;
  contractId: string;
  bucket: "current" | "1-30" | "31-60" | "61-90" | "90+";
  totalOverdueCents: number;
  overdueCountWithAction: number;
  overdueCountSilent: number;
  oldestDueDate?: number;
  recomputedAt: number;
}

interface CtxBag {
  contracts: Map<string, ContractFixture>;
  installments: Map<string, InstallmentFixture>;
  snapshots: Map<string, SnapshotFixture>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  contracts?: ContractFixture[];
  installments?: InstallmentFixture[];
  snapshots?: SnapshotFixture[];
  authenticated?: boolean;
}): CtxBag {
  const contracts = new Map<string, ContractFixture>(
    (opts.contracts ?? []).map((c) => [c._id, c]),
  );
  const installments = new Map<string, InstallmentFixture>(
    (opts.installments ?? []).map((i) => [i._id, i]),
  );
  const snapshots = new Map<string, SnapshotFixture>(
    (opts.snapshots ?? []).map((s) => [s._id, s]),
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
    email: "admin@example.com",
    isActive: true,
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

  let nextId = 1;

  type Predicate = (r: Record<string, unknown>) => boolean;

  function rowsForTable(table: string): Record<string, unknown>[] {
    if (table === "contracts") {
      return Array.from(contracts.values()) as unknown as Record<
        string,
        unknown
      >[];
    }
    if (table === "installments") {
      return Array.from(installments.values()) as unknown as Record<
        string,
        unknown
      >[];
    }
    if (table === "arAgingSnapshots") {
      return Array.from(snapshots.values()) as unknown as Record<
        string,
        unknown
      >[];
    }
    return [];
  }

  interface IndexQuery {
    eqs: Record<string, unknown>;
    eq(field: string, value: unknown): IndexQuery;
  }

  function makeQueryBuilder(table: string) {
    const predicates: Predicate[] = [];
    const builder = {
      withIndex(_indexName: string, fn?: (q: IndexQuery) => IndexQuery) {
        if (fn !== undefined) {
          const q: IndexQuery = {
            eqs: {},
            eq(field, value) {
              this.eqs[field] = value;
              return this;
            },
          };
          fn(q);
          for (const [field, value] of Object.entries(q.eqs)) {
            predicates.push(
              (r) => (r as Record<string, unknown>)[field] === value,
            );
          }
        }
        return builder;
      },
      async first(): Promise<Record<string, unknown> | null> {
        for (const r of rowsForTable(table)) {
          if (predicates.every((p) => p(r))) return r;
        }
        return null;
      },
      async collect(): Promise<Record<string, unknown>[]> {
        return rowsForTable(table).filter((r) => predicates.every((p) => p(r)));
      },
    };
    return builder;
  }

  const ctx = {
    db: {
      get: vi.fn(async (id: string) => {
        if (id === USER_ID) return user;
        if (id === SESSION_ID) return session;
        if (contracts.has(id)) return contracts.get(id);
        if (installments.has(id)) return installments.get(id);
        if (snapshots.has(id)) return snapshots.get(id);
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
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "arAgingSnapshots") {
          const id = `arAgingSnapshots:${nextId++}`;
          snapshots.set(id, {
            _id: id,
            _creationTime: T0,
            ...row,
          } as SnapshotFixture);
          return id;
        }
        return `${table}:?`;
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        if (snapshots.has(id)) {
          const existing = snapshots.get(id)!;
          snapshots.set(id, { ...existing, ...patch } as SnapshotFixture);
        }
      }),
      delete: vi.fn(async (id: string) => {
        snapshots.delete(id);
      }),
    },
  };

  return { contracts, installments, snapshots, ctx };
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

function makeContract(
  id: string,
  overrides: Partial<ContractFixture> = {},
): ContractFixture {
  return {
    _id: id,
    _creationTime: T0,
    state: "active",
    ...overrides,
  };
}

function makeInstallment(
  id: string,
  overrides: Partial<InstallmentFixture>,
): InstallmentFixture {
  return {
    _id: id,
    _creationTime: T0,
    contractId: "contracts:1",
    installmentNumber: 1,
    dueDate: T0 - DAY_MS,
    principalCents: 10_000_00,
    paidCents: 0,
    status: "pending",
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

describe("bucketFromDaysOverdue — pure classifier (AC2)", () => {
  it("0 (and negative) days returns current", () => {
    expect(bucketFromDaysOverdue(0)).toBe("current");
    expect(bucketFromDaysOverdue(-5)).toBe("current");
  });
  it("1..30 days returns 1-30", () => {
    expect(bucketFromDaysOverdue(1)).toBe("1-30");
    expect(bucketFromDaysOverdue(15)).toBe("1-30");
    expect(bucketFromDaysOverdue(30)).toBe("1-30");
  });
  it("31..60 days returns 31-60", () => {
    expect(bucketFromDaysOverdue(31)).toBe("31-60");
    expect(bucketFromDaysOverdue(45)).toBe("31-60");
    expect(bucketFromDaysOverdue(60)).toBe("31-60");
  });
  it("61..90 days returns 61-90", () => {
    expect(bucketFromDaysOverdue(61)).toBe("61-90");
    expect(bucketFromDaysOverdue(75)).toBe("61-90");
    expect(bucketFromDaysOverdue(90)).toBe("61-90");
  });
  it("> 90 days returns 90+", () => {
    expect(bucketFromDaysOverdue(91)).toBe("90+");
    expect(bucketFromDaysOverdue(180)).toBe("90+");
    expect(bucketFromDaysOverdue(365)).toBe("90+");
  });
});

describe("pickMostOverdueBucket — precedence (AC2)", () => {
  it("empty installments list returns current", () => {
    expect(pickMostOverdueBucket([], T0)).toBe("current");
  });
  it("mix of paid + 90+ overdue returns 90+", () => {
    const result = pickMostOverdueBucket(
      [
        { dueDate: T0 - 100 * DAY_MS, status: "pending" },
        { dueDate: T0 - 5 * DAY_MS, status: "pending" },
        { dueDate: T0 - 999 * DAY_MS, status: "paid" }, // ignored
      ],
      T0,
    );
    expect(result).toBe("90+");
  });
  it("all installments not yet due returns current", () => {
    const result = pickMostOverdueBucket(
      [
        { dueDate: T0 + 10 * DAY_MS, status: "pending" },
        { dueDate: T0 + 30 * DAY_MS, status: "pending" },
      ],
      T0,
    );
    expect(result).toBe("current");
  });
  it("waived installments are ignored (treated like paid)", () => {
    const result = pickMostOverdueBucket(
      [
        { dueDate: T0 - 100 * DAY_MS, status: "waived" },
        { dueDate: T0 - 10 * DAY_MS, status: "pending" },
      ],
      T0,
    );
    expect(result).toBe("1-30");
  });
});

describe("internal_recomputeAgingForContractMutation", () => {
  const run = handlerOf(internal_recomputeAgingForContractMutation);

  it("inserts a snapshot row when none exists; classifies the most-overdue bucket", async () => {
    const contract = makeContract("contracts:1", { state: "active" });
    const installments = [
      makeInstallment("inst:1", {
        contractId: contract._id,
        installmentNumber: 1,
        dueDate: T0 - 100 * DAY_MS,
        principalCents: 5_000_00,
        paidCents: 0,
        status: "overdue",
      }),
      makeInstallment("inst:2", {
        contractId: contract._id,
        installmentNumber: 2,
        dueDate: T0 - 45 * DAY_MS,
        principalCents: 5_000_00,
        paidCents: 0,
        status: "pending",
      }),
      makeInstallment("inst:3", {
        contractId: contract._id,
        installmentNumber: 3,
        dueDate: T0 + 5 * DAY_MS,
        principalCents: 5_000_00,
        paidCents: 0,
        status: "pending",
      }),
      makeInstallment("inst:4", {
        contractId: contract._id,
        installmentNumber: 4,
        dueDate: T0 - 200 * DAY_MS,
        principalCents: 5_000_00,
        paidCents: 5_000_00,
        status: "paid",
      }),
    ];
    const bag = makeCtx({
      contracts: [contract],
      installments,
    });
    await run(bag.ctx, { contractId: contract._id });
    expect(bag.snapshots.size).toBe(1);
    const snapshot = Array.from(bag.snapshots.values())[0]!;
    expect(snapshot.bucket).toBe("90+");
    // Two overdue unpaid installments: 5,000.00 + 5,000.00 = 10,000.00
    expect(snapshot.totalOverdueCents).toBe(10_000_00);
    expect(snapshot.overdueCountSilent).toBe(2);
    expect(snapshot.overdueCountWithAction).toBe(0);
    expect(snapshot.oldestDueDate).toBe(T0 - 100 * DAY_MS);
  });

  it("is idempotent — running twice patches the existing row, no duplicate", async () => {
    const contract = makeContract("contracts:1", { state: "active" });
    const installment = makeInstallment("inst:1", {
      contractId: contract._id,
      dueDate: T0 - 40 * DAY_MS,
      principalCents: 3_000_00,
      paidCents: 0,
      status: "pending",
    });
    const bag = makeCtx({
      contracts: [contract],
      installments: [installment],
    });
    await run(bag.ctx, { contractId: contract._id });
    await run(bag.ctx, { contractId: contract._id });
    expect(bag.snapshots.size).toBe(1);
    const snapshot = Array.from(bag.snapshots.values())[0]!;
    expect(snapshot.bucket).toBe("31-60");
    expect(snapshot.totalOverdueCents).toBe(3_000_00);
  });

  it("drops the snapshot row when the contract transitions to paid_in_full", async () => {
    const contract = makeContract("contracts:1", { state: "paid_in_full" });
    const bag = makeCtx({
      contracts: [contract],
      snapshots: [
        {
          _id: "arAgingSnapshots:1",
          _creationTime: T0,
          contractId: contract._id,
          bucket: "31-60",
          totalOverdueCents: 1_000,
          overdueCountSilent: 1,
          overdueCountWithAction: 0,
          recomputedAt: T0 - DAY_MS,
        },
      ],
    });
    await run(bag.ctx, { contractId: contract._id });
    expect(bag.snapshots.size).toBe(0);
  });

  it("skips contracts that are not active or in_default", async () => {
    const contract = makeContract("contracts:1", { state: "cancelled" });
    const bag = makeCtx({ contracts: [contract] });
    await run(bag.ctx, { contractId: contract._id });
    expect(bag.snapshots.size).toBe(0);
  });

  it("returns current bucket when no installments are overdue", async () => {
    const contract = makeContract("contracts:1", { state: "active" });
    const installment = makeInstallment("inst:1", {
      contractId: contract._id,
      dueDate: T0 + 5 * DAY_MS,
      status: "pending",
    });
    const bag = makeCtx({
      contracts: [contract],
      installments: [installment],
    });
    await run(bag.ctx, { contractId: contract._id });
    const snapshot = Array.from(bag.snapshots.values())[0]!;
    expect(snapshot.bucket).toBe("current");
    expect(snapshot.totalOverdueCents).toBe(0);
    expect(snapshot.overdueCountSilent).toBe(0);
    expect(snapshot.oldestDueDate).toBeUndefined();
  });
});

describe("internal_recomputeAllAging (cron body)", () => {
  const run = handlerOf(internal_recomputeAllAging);

  it("processes active + in_default contracts and skips others", async () => {
    const contracts = [
      makeContract("contracts:1", { state: "active" }),
      makeContract("contracts:2", { state: "in_default" }),
      makeContract("contracts:3", { state: "cancelled" }),
      makeContract("contracts:4", { state: "paid_in_full" }),
    ];
    const installments = [
      makeInstallment("inst:1", {
        contractId: "contracts:1",
        dueDate: T0 - 10 * DAY_MS,
        principalCents: 1_000_00,
      }),
      makeInstallment("inst:2", {
        contractId: "contracts:2",
        dueDate: T0 - 100 * DAY_MS,
        principalCents: 2_000_00,
      }),
    ];
    const bag = makeCtx({ contracts, installments });
    const result = (await run(bag.ctx, {})) as {
      processed: number;
      skipped: number;
    };
    expect(result.processed).toBe(2);
    // contracts:3 / contracts:4 not in active/in_default index scan,
    // so they aren't even considered (skipped count covers `null`-returning
    // computes inside the loop, which is 0 here).
    expect(result.skipped).toBe(0);
    expect(bag.snapshots.size).toBe(2);
    const buckets = Array.from(bag.snapshots.values()).map((s) => s.bucket);
    expect(buckets).toContain("1-30");
    expect(buckets).toContain("90+");
  });

  it("produces identical rows on a second run (idempotent across the cron)", async () => {
    const contract = makeContract("contracts:1", { state: "active" });
    const installment = makeInstallment("inst:1", {
      contractId: contract._id,
      dueDate: T0 - 70 * DAY_MS,
      principalCents: 5_000_00,
    });
    const bag = makeCtx({
      contracts: [contract],
      installments: [installment],
    });
    await run(bag.ctx, {});
    const firstSnapshot = { ...Array.from(bag.snapshots.values())[0]! };
    await run(bag.ctx, {});
    expect(bag.snapshots.size).toBe(1);
    const secondSnapshot = Array.from(bag.snapshots.values())[0]!;
    expect(secondSnapshot.bucket).toBe(firstSnapshot.bucket);
    expect(secondSnapshot.totalOverdueCents).toBe(
      firstSnapshot.totalOverdueCents,
    );
    expect(secondSnapshot.overdueCountSilent).toBe(
      firstSnapshot.overdueCountSilent,
    );
  });
});

describe("recomputeNow — public admin escape hatch", () => {
  const run = handlerOf(recomputeNow);

  it("rejects office_staff with FORBIDDEN (admin-only)", async () => {
    const bag = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(bag.ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const bag = makeCtx({ authenticated: false });
    const thrown = await run(bag.ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("admin can force a recompute on demand", async () => {
    const contract = makeContract("contracts:1", { state: "active" });
    const installment = makeInstallment("inst:1", {
      contractId: contract._id,
      dueDate: T0 - 30 * DAY_MS,
      principalCents: 2_500_00,
    });
    const bag = makeCtx({
      roles: ["admin"],
      contracts: [contract],
      installments: [installment],
    });
    const result = (await run(bag.ctx, {})) as {
      processed: number;
      skipped: number;
    };
    expect(result.processed).toBe(1);
    expect(bag.snapshots.size).toBe(1);
  });
});

describe("getAgingSummary public query", () => {
  const run = handlerOf(getAgingSummary);

  it("aggregates buckets across snapshot rows and excludes current from the dashboard tile array", async () => {
    const now = T0;
    const snapshots: SnapshotFixture[] = [
      {
        _id: "arAgingSnapshots:1",
        _creationTime: T0,
        contractId: "contracts:1",
        bucket: "current",
        totalOverdueCents: 0,
        overdueCountSilent: 0,
        overdueCountWithAction: 0,
        recomputedAt: now,
      },
      {
        _id: "arAgingSnapshots:2",
        _creationTime: T0,
        contractId: "contracts:2",
        bucket: "1-30",
        totalOverdueCents: 1_000_00,
        overdueCountSilent: 1,
        overdueCountWithAction: 0,
        recomputedAt: now,
      },
      {
        _id: "arAgingSnapshots:3",
        _creationTime: T0,
        contractId: "contracts:3",
        bucket: "1-30",
        totalOverdueCents: 500_00,
        overdueCountSilent: 1,
        overdueCountWithAction: 0,
        recomputedAt: now,
      },
      {
        _id: "arAgingSnapshots:4",
        _creationTime: T0,
        contractId: "contracts:4",
        bucket: "90+",
        totalOverdueCents: 20_000_00,
        overdueCountSilent: 3,
        overdueCountWithAction: 0,
        recomputedAt: now,
      },
    ];
    const bag = makeCtx({ snapshots });
    const result = (await run(bag.ctx, {})) as {
      buckets: Array<{ key: string; count: number; totalCents: number }>;
      currentCents: number;
      currentCount: number;
      totalOverdueCents: number;
      totalOverdueCount: number;
      oldestSnapshotAt: number;
    };
    expect(result.buckets.map((b) => b.key)).toEqual([
      "1-30",
      "31-60",
      "61-90",
      "90+",
    ]);
    const oneToThirty = result.buckets.find((b) => b.key === "1-30")!;
    expect(oneToThirty.count).toBe(2);
    expect(oneToThirty.totalCents).toBe(1_500_00);
    const ninetyPlus = result.buckets.find((b) => b.key === "90+")!;
    expect(ninetyPlus.count).toBe(1);
    expect(ninetyPlus.totalCents).toBe(20_000_00);
    expect(result.currentCount).toBe(1);
    expect(result.totalOverdueCount).toBe(3);
    expect(result.totalOverdueCents).toBe(21_500_00);
    expect(result.oldestSnapshotAt).toBe(now);
  });

  it("returns zero-buckets when no snapshots exist", async () => {
    const bag = makeCtx({ roles: ["office_staff"] });
    const result = (await run(bag.ctx, {})) as {
      buckets: Array<{ count: number; totalCents: number }>;
      totalOverdueCount: number;
      oldestSnapshotAt: number | null;
    };
    for (const b of result.buckets) {
      expect(b.count).toBe(0);
      expect(b.totalCents).toBe(0);
    }
    expect(result.totalOverdueCount).toBe(0);
    expect(result.oldestSnapshotAt).toBeNull();
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const bag = makeCtx({ roles: ["field_worker"] });
    const thrown = await run(bag.ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const bag = makeCtx({ authenticated: false });
    const thrown = await run(bag.ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});

describe("getCurrentAging", () => {
  const run = handlerOf(getCurrentAging);

  it("returns null + 0 when no snapshots exist", async () => {
    const bag = makeCtx({});
    const result = (await run(bag.ctx, {})) as {
      lastRecomputedAt: number | null;
      snapshotCount: number;
    };
    expect(result.lastRecomputedAt).toBeNull();
    expect(result.snapshotCount).toBe(0);
  });

  it("returns the latest recomputedAt across all rows", async () => {
    const bag = makeCtx({
      snapshots: [
        {
          _id: "arAgingSnapshots:1",
          _creationTime: T0,
          contractId: "contracts:1",
          bucket: "1-30",
          totalOverdueCents: 0,
          overdueCountSilent: 0,
          overdueCountWithAction: 0,
          recomputedAt: T0 - 2 * HOUR_MS,
        },
        {
          _id: "arAgingSnapshots:2",
          _creationTime: T0,
          contractId: "contracts:2",
          bucket: "current",
          totalOverdueCents: 0,
          overdueCountSilent: 0,
          overdueCountWithAction: 0,
          recomputedAt: T0,
        },
      ],
    });
    const result = (await run(bag.ctx, {})) as {
      lastRecomputedAt: number;
      snapshotCount: number;
    };
    expect(result.lastRecomputedAt).toBe(T0);
    expect(result.snapshotCount).toBe(2);
  });
});

describe("getSnapshotForContract", () => {
  const run = handlerOf(getSnapshotForContract);

  it("returns null when no snapshot exists for the contract", async () => {
    const bag = makeCtx({});
    const result = await run(bag.ctx, { contractId: "contracts:ghost" });
    expect(result).toBeNull();
  });

  it("returns the snapshot row for a known contract", async () => {
    const bag = makeCtx({
      snapshots: [
        {
          _id: "arAgingSnapshots:1",
          _creationTime: T0,
          contractId: "contracts:1",
          bucket: "61-90",
          totalOverdueCents: 7_500_00,
          overdueCountSilent: 2,
          overdueCountWithAction: 0,
          recomputedAt: T0,
        },
      ],
    });
    const result = (await run(bag.ctx, {
      contractId: "contracts:1",
    })) as { bucket: string; totalOverdueCents: number };
    expect(result.bucket).toBe("61-90");
    expect(result.totalOverdueCents).toBe(7_500_00);
  });

  it("rejects unauthenticated callers", async () => {
    const bag = makeCtx({ authenticated: false });
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});
