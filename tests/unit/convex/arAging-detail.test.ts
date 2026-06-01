/**
 * Story 4.8 — `listAgingDetail` unit tests.
 *
 * Covers the per-contract drill-down query that joins:
 *   - `arAgingSnapshots` (Story 4.1)
 *   - `contracts` (Story 3.3 / 3.4 / 3.6)
 *   - `customers` (Story 2.1)
 *   - `lots` (Story 1.8)
 *   - `installments` (Story 3.4)
 *   - `followUpActions` (Story 4.2 / 4.3)
 *   - `payments` (Story 3.9)
 *
 * Coverage:
 *   - Happy path: bucket="90+" with mixed-action snapshot rows returns
 *     all rows + correct `needsActionCount` (silently-overdue count
 *     across the bucket).
 *   - hasActiveFollowUp filter only honours `status === "open"` —
 *     completed / cancelled / expired rows are silent again.
 *   - Default sort returns biggest financial overdue first.
 *   - Contracts that have transitioned out of active / in_default are
 *     dropped defensively even if the snapshot row lags the cron.
 *   - Auth: admin + office_staff pass; field_worker / customer fail;
 *     unauthenticated rejects with UNAUTHENTICATED.
 *   - lastPaymentAt: most-recent non-voided payment surfaces; voided
 *     payments are ignored.
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
import { listAgingDetail } from "../../../convex/arAging";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-05-15T12:00:00+08:00").getTime();
const USER_ID = "users:abc123";
const SESSION_ID = "authSessions:def456";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface ContractFixture {
  _id: string;
  _creationTime: number;
  contractNumber: string;
  customerId: string;
  lotId: string;
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

interface CustomerFixture {
  _id: string;
  _creationTime: number;
  fullName: string;
}

interface LotFixture {
  _id: string;
  _creationTime: number;
  code: string;
}

interface FollowUpFixture {
  _id: string;
  _creationTime: number;
  installmentId: string;
  status: "open" | "completed" | "cancelled" | "expired";
  notes?: string;
  dueAt: number;
  createdAt: number;
}

interface PaymentFixture {
  _id: string;
  _creationTime: number;
  contractId: string;
  receivedAt: number;
  isVoided: boolean;
}

interface CtxBag {
  ctx: {
    db: {
      get: ReturnType<typeof vi.fn>;
      query: ReturnType<typeof vi.fn>;
    };
  };
}

function makeCtx(opts: {
  roles?: RoleName[];
  authenticated?: boolean;
  contracts?: ContractFixture[];
  installments?: InstallmentFixture[];
  snapshots?: SnapshotFixture[];
  customers?: CustomerFixture[];
  lots?: LotFixture[];
  followUps?: FollowUpFixture[];
  payments?: PaymentFixture[];
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
  const customers = new Map<string, CustomerFixture>(
    (opts.customers ?? []).map((c) => [c._id, c]),
  );
  const lots = new Map<string, LotFixture>(
    (opts.lots ?? []).map((l) => [l._id, l]),
  );
  const followUps = new Map<string, FollowUpFixture>(
    (opts.followUps ?? []).map((f) => [f._id, f]),
  );
  const payments = new Map<string, PaymentFixture>(
    (opts.payments ?? []).map((p) => [p._id, p]),
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
    if (table === "followUpActions") {
      return Array.from(followUps.values()) as unknown as Record<
        string,
        unknown
      >[];
    }
    if (table === "payments") {
      return Array.from(payments.values()) as unknown as Record<
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
        return rowsForTable(table).filter((r) =>
          predicates.every((p) => p(r)),
        );
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
        if (customers.has(id)) return customers.get(id);
        if (lots.has(id)) return lots.get(id);
        if (followUps.has(id)) return followUps.get(id);
        if (payments.has(id)) return payments.get(id);
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
    contractNumber: `CTR-${id.split(":")[1] ?? "X"}`,
    customerId: "customers:1",
    lotId: "lots:1",
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

function makeSnapshot(
  id: string,
  overrides: Partial<SnapshotFixture>,
): SnapshotFixture {
  return {
    _id: id,
    _creationTime: T0,
    contractId: "contracts:1",
    bucket: "90+",
    totalOverdueCents: 10_000_00,
    overdueCountSilent: 1,
    overdueCountWithAction: 0,
    recomputedAt: T0,
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

describe("listAgingDetail (Story 4.8)", () => {
  const run = handlerOf(listAgingDetail);

  it("rejects unauthenticated callers with UNAUTHENTICATED", async () => {
    const bag = makeCtx({ authenticated: false });
    const thrown = await run(bag.ctx, { bucket: "90+" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("rejects field_worker callers with FORBIDDEN", async () => {
    const bag = makeCtx({ roles: ["field_worker"] });
    const thrown = await run(bag.ctx, { bucket: "90+" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("admin AND office_staff are allowed", async () => {
    const adminBag = makeCtx({ roles: ["admin"] });
    const staffBag = makeCtx({ roles: ["office_staff"] });
    const adminResult = (await run(adminBag.ctx, { bucket: "90+" })) as {
      rows: unknown[];
      totalCount: number;
    };
    const staffResult = (await run(staffBag.ctx, { bucket: "90+" })) as {
      rows: unknown[];
      totalCount: number;
    };
    expect(adminResult.totalCount).toBe(0);
    expect(staffResult.totalCount).toBe(0);
  });

  it("returns an empty result + zero counts for an empty bucket", async () => {
    const bag = makeCtx({});
    const result = (await run(bag.ctx, { bucket: "90+" })) as {
      rows: unknown[];
      totalCount: number;
      needsActionCount: number;
    };
    expect(result.rows).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.needsActionCount).toBe(0);
  });

  it("joins customer + lot onto each row and sorts by totalOverdueCents desc by default", async () => {
    const contractA = makeContract("contracts:A", {
      customerId: "customers:A",
      lotId: "lots:A",
      contractNumber: "CTR-A",
      state: "active",
    });
    const contractB = makeContract("contracts:B", {
      customerId: "customers:B",
      lotId: "lots:B",
      contractNumber: "CTR-B",
      state: "in_default",
    });
    const bag = makeCtx({
      contracts: [contractA, contractB],
      customers: [
        { _id: "customers:A", _creationTime: T0, fullName: "Ana Reyes" },
        {
          _id: "customers:B",
          _creationTime: T0,
          fullName: "Benigno Lopez",
        },
      ],
      lots: [
        { _id: "lots:A", _creationTime: T0, code: "A-1-01" },
        { _id: "lots:B", _creationTime: T0, code: "B-2-04" },
      ],
      installments: [
        makeInstallment("inst:A1", {
          contractId: "contracts:A",
          dueDate: T0 - 100 * DAY_MS,
          principalCents: 5_000_00,
          paidCents: 0,
          status: "overdue",
        }),
        makeInstallment("inst:B1", {
          contractId: "contracts:B",
          dueDate: T0 - 120 * DAY_MS,
          principalCents: 20_000_00,
          paidCents: 0,
          status: "overdue",
        }),
      ],
      snapshots: [
        makeSnapshot("arAgingSnapshots:1", {
          contractId: "contracts:A",
          totalOverdueCents: 5_000_00,
          oldestDueDate: T0 - 100 * DAY_MS,
        }),
        makeSnapshot("arAgingSnapshots:2", {
          contractId: "contracts:B",
          totalOverdueCents: 20_000_00,
          oldestDueDate: T0 - 120 * DAY_MS,
        }),
      ],
    });
    const result = (await run(bag.ctx, { bucket: "90+" })) as {
      rows: Array<{
        contractId: string;
        customerFullName: string;
        lotCode: string;
        totalOverdueCents: number;
        daysOverdue: number;
      }>;
      totalCount: number;
      needsActionCount: number;
    };
    expect(result.totalCount).toBe(2);
    expect(result.rows[0]!.customerFullName).toBe("Benigno Lopez");
    expect(result.rows[0]!.lotCode).toBe("B-2-04");
    expect(result.rows[0]!.totalOverdueCents).toBe(20_000_00);
    expect(result.rows[1]!.customerFullName).toBe("Ana Reyes");
    // daysOverdue derived from oldestDueDate
    expect(result.rows[0]!.daysOverdue).toBe(120);
    expect(result.rows[1]!.daysOverdue).toBe(100);
  });

  it("derives hasActiveFollowUp + followUpActionNote from a status=open follow-up on any overdue installment", async () => {
    const contract = makeContract("contracts:A", {
      customerId: "customers:A",
      lotId: "lots:A",
      state: "active",
    });
    const bag = makeCtx({
      contracts: [contract],
      customers: [
        { _id: "customers:A", _creationTime: T0, fullName: "Cita Cruz" },
      ],
      lots: [{ _id: "lots:A", _creationTime: T0, code: "C-1-01" }],
      installments: [
        makeInstallment("inst:1", {
          contractId: "contracts:A",
          dueDate: T0 - 100 * DAY_MS,
          principalCents: 5_000_00,
          paidCents: 0,
          status: "overdue",
        }),
      ],
      snapshots: [
        makeSnapshot("arAgingSnapshots:1", {
          contractId: "contracts:A",
          totalOverdueCents: 5_000_00,
          oldestDueDate: T0 - 100 * DAY_MS,
        }),
      ],
      followUps: [
        {
          _id: "followUpActions:1",
          _creationTime: T0,
          installmentId: "inst:1",
          status: "open",
          notes: "Called Maria, will return Tuesday",
          dueAt: T0 + 3 * DAY_MS,
          createdAt: T0,
        },
      ],
    });
    const result = (await run(bag.ctx, { bucket: "90+" })) as {
      rows: Array<{ hasActiveFollowUp: boolean; followUpActionNote?: string }>;
      needsActionCount: number;
    };
    expect(result.rows[0]!.hasActiveFollowUp).toBe(true);
    expect(result.rows[0]!.followUpActionNote).toBe(
      "Called Maria, will return Tuesday",
    );
    expect(result.needsActionCount).toBe(0);
  });

  it("treats expired / cancelled / completed follow-ups as silent — counts them in needsActionCount", async () => {
    const contract = makeContract("contracts:A", {
      customerId: "customers:A",
      lotId: "lots:A",
      state: "active",
    });
    const bag = makeCtx({
      contracts: [contract],
      customers: [
        { _id: "customers:A", _creationTime: T0, fullName: "Diana Cruz" },
      ],
      lots: [{ _id: "lots:A", _creationTime: T0, code: "D-1-01" }],
      installments: [
        makeInstallment("inst:1", {
          contractId: "contracts:A",
          dueDate: T0 - 200 * DAY_MS,
          principalCents: 5_000_00,
          paidCents: 0,
          status: "overdue",
        }),
      ],
      snapshots: [
        makeSnapshot("arAgingSnapshots:1", {
          contractId: "contracts:A",
          totalOverdueCents: 5_000_00,
          oldestDueDate: T0 - 200 * DAY_MS,
        }),
      ],
      followUps: [
        {
          _id: "followUpActions:1",
          _creationTime: T0,
          installmentId: "inst:1",
          status: "expired",
          notes: "Letter sent",
          dueAt: T0 - 7 * DAY_MS,
          createdAt: T0 - 14 * DAY_MS,
        },
      ],
    });
    const result = (await run(bag.ctx, { bucket: "90+" })) as {
      rows: Array<{ hasActiveFollowUp: boolean }>;
      needsActionCount: number;
    };
    expect(result.rows[0]!.hasActiveFollowUp).toBe(false);
    expect(result.needsActionCount).toBe(1);
  });

  it("drops snapshot rows whose contract has transitioned out of active / in_default", async () => {
    const contract = makeContract("contracts:A", {
      customerId: "customers:A",
      lotId: "lots:A",
      state: "paid_in_full",
    });
    const bag = makeCtx({
      contracts: [contract],
      customers: [
        { _id: "customers:A", _creationTime: T0, fullName: "Edu Cruz" },
      ],
      lots: [{ _id: "lots:A", _creationTime: T0, code: "E-1-01" }],
      installments: [],
      snapshots: [
        makeSnapshot("arAgingSnapshots:1", {
          contractId: "contracts:A",
          totalOverdueCents: 5_000_00,
        }),
      ],
    });
    const result = (await run(bag.ctx, { bucket: "90+" })) as {
      rows: unknown[];
      totalCount: number;
    };
    expect(result.totalCount).toBe(0);
    expect(result.rows).toEqual([]);
  });

  it("surfaces the most-recent non-voided payment as lastPaymentAt; voided payments are ignored", async () => {
    const contract = makeContract("contracts:A", {
      customerId: "customers:A",
      lotId: "lots:A",
      state: "active",
    });
    const bag = makeCtx({
      contracts: [contract],
      customers: [
        { _id: "customers:A", _creationTime: T0, fullName: "Faye Mendoza" },
      ],
      lots: [{ _id: "lots:A", _creationTime: T0, code: "F-1-01" }],
      installments: [
        makeInstallment("inst:1", {
          contractId: "contracts:A",
          dueDate: T0 - 100 * DAY_MS,
          status: "overdue",
        }),
      ],
      snapshots: [
        makeSnapshot("arAgingSnapshots:1", {
          contractId: "contracts:A",
          totalOverdueCents: 5_000_00,
          oldestDueDate: T0 - 100 * DAY_MS,
        }),
      ],
      payments: [
        {
          _id: "payments:1",
          _creationTime: T0,
          contractId: "contracts:A",
          receivedAt: T0 - 30 * DAY_MS,
          isVoided: false,
        },
        {
          _id: "payments:2",
          _creationTime: T0,
          contractId: "contracts:A",
          // More recent — but voided — should be skipped.
          receivedAt: T0 - 10 * DAY_MS,
          isVoided: true,
        },
        {
          _id: "payments:3",
          _creationTime: T0,
          contractId: "contracts:A",
          receivedAt: T0 - 60 * DAY_MS,
          isVoided: false,
        },
      ],
    });
    const result = (await run(bag.ctx, { bucket: "90+" })) as {
      rows: Array<{ lastPaymentAt: number | undefined }>;
    };
    expect(result.rows[0]!.lastPaymentAt).toBe(T0 - 30 * DAY_MS);
  });

  it("returns all overdue buckets when bucket arg is omitted", async () => {
    const contracts: ContractFixture[] = ["contracts:A", "contracts:B"].map(
      (id) =>
        makeContract(id, {
          customerId: `customers:${id}`,
          lotId: `lots:${id}`,
          state: "active",
        }),
    );
    const bag = makeCtx({
      contracts,
      customers: contracts.map((c) => ({
        _id: c.customerId,
        _creationTime: T0,
        fullName: `Customer ${c._id}`,
      })),
      lots: contracts.map((c) => ({
        _id: c.lotId,
        _creationTime: T0,
        code: `L-${c.lotId}`,
      })),
      installments: contracts.map((c, idx) =>
        makeInstallment(`inst:${idx}`, {
          contractId: c._id,
          dueDate: T0 - 50 * DAY_MS,
          status: "overdue",
        }),
      ),
      snapshots: [
        makeSnapshot("arAgingSnapshots:1", {
          contractId: "contracts:A",
          bucket: "1-30",
          totalOverdueCents: 1_000_00,
          oldestDueDate: T0 - 10 * DAY_MS,
        }),
        makeSnapshot("arAgingSnapshots:2", {
          contractId: "contracts:B",
          bucket: "90+",
          totalOverdueCents: 2_000_00,
          oldestDueDate: T0 - 100 * DAY_MS,
        }),
      ],
    });
    const result = (await run(bag.ctx, {})) as {
      rows: Array<{ bucket: string }>;
      totalCount: number;
    };
    expect(result.totalCount).toBe(2);
    const buckets = result.rows.map((r) => r.bucket);
    expect(buckets).toContain("1-30");
    expect(buckets).toContain("90+");
  });
});
