/**
 * Story 9.9 — `convex/trends.ts` unit tests.
 *
 * The trends query (`getTrendData`) aggregates trailing-12-month
 * sales / collections / expenses / net + a current AR balance snapshot
 * over Manila-tz calendar months. Wrong aggregation would silently
 * mislead owners about the business trajectory, so the tests mirror
 * the rigor of `dashboard.test.ts`:
 *
 *   - Auth gate (admin-only; office_staff / field_worker / customer /
 *     unauthenticated all rejected).
 *   - Bucket-bound math: `computeTrailingMonthBounds` over Manila
 *     month rollovers including the Dec → Jan year boundary and a
 *     leap-February (2024).
 *   - Sales partitioning by `createdAt` with voided / cancelled rows
 *     excluded; contracts outside the 12-month window ignored.
 *   - Collections aggregated by `payments.receivedAt`, voided rows
 *     skipped.
 *   - Expenses aggregated by `expenses.paidAt`.
 *   - Net = collections − expenses per bucket (cash basis); may go
 *     negative.
 *   - AR balance snapshot: sum of `active` + `in_default`
 *     `totalPriceCents`; ignores `paid_in_full` / `cancelled` /
 *     `voided`.
 *
 * Hand-mocked ctx mirrors `dashboard.test.ts` so the test surface is
 * portable when this module migrates to convex-test.
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
  computeTrailingMonthBounds,
  getTrendData,
  TREND_BUCKET_COUNT,
} from "../../../convex/trends";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

// 2026-05-15 noon Manila — middle of May 2026. The trailing-12-month
// window therefore runs from 2025-06-01 00:00 Manila through
// 2026-06-01 00:00 Manila (exclusive), with the current month at
// bucket index 11.
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
  totalPriceCents: number;
  createdAt: number;
}

interface PaymentFixture {
  _id: string;
  _creationTime: number;
  amountCents: number;
  receivedAt: number;
  isVoided: boolean;
}

interface ExpenseFixture {
  _id: string;
  _creationTime: number;
  amountCents: number;
  paidAt: number;
}

interface CtxBag {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  contracts?: ContractFixture[];
  payments?: PaymentFixture[];
  expenses?: ExpenseFixture[];
  authenticated?: boolean;
}): CtxBag {
  const contracts = opts.contracts ?? [];
  const payments = opts.payments ?? [];
  const expenses = opts.expenses ?? [];

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

  interface IndexQuery {
    eqs: Record<string, unknown>;
    ranges: Array<{
      field: string;
      op: "gte" | "lt" | "lte";
      value: number;
    }>;
    eq(field: string, value: unknown): IndexQuery;
    gte(field: string, value: number): IndexQuery;
    lt(field: string, value: number): IndexQuery;
    lte(field: string, value: number): IndexQuery;
  }

  function makeQueryBuilder<T extends object>(rows: T[]) {
    const predicates: Array<(r: T) => boolean> = [];
    const builder = {
      withIndex(_indexName: string, fn?: (q: IndexQuery) => IndexQuery) {
        if (fn !== undefined) {
          const q: IndexQuery = {
            eqs: {},
            ranges: [],
            eq(field, value) {
              this.eqs[field] = value;
              return this;
            },
            gte(field, value) {
              this.ranges.push({ field, op: "gte", value });
              return this;
            },
            lt(field, value) {
              this.ranges.push({ field, op: "lt", value });
              return this;
            },
            lte(field, value) {
              this.ranges.push({ field, op: "lte", value });
              return this;
            },
          };
          fn(q);
          for (const [field, value] of Object.entries(q.eqs)) {
            predicates.push(
              (r) => (r as Record<string, unknown>)[field] === value,
            );
          }
          for (const range of q.ranges) {
            predicates.push((r) => {
              const v = (r as Record<string, unknown>)[range.field];
              if (typeof v !== "number") return false;
              if (range.op === "gte") return v >= range.value;
              if (range.op === "lt") return v < range.value;
              return v <= range.value;
            });
          }
        }
        return builder;
      },
      async collect(): Promise<T[]> {
        return rows.filter((r) => predicates.every((p) => p(r)));
      },
      async first(): Promise<T | null> {
        for (const r of rows) {
          if (predicates.every((p) => p(r))) return r;
        }
        return null;
      },
    };
    return builder;
  }

  const ctx = {
    db: {
      get: vi.fn(async (id: string) => {
        if (id === USER_ID) return user;
        if (id === SESSION_ID) return session;
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
        if (table === "contracts") return makeQueryBuilder(contracts);
        if (table === "payments") return makeQueryBuilder(payments);
        if (table === "expenses") return makeQueryBuilder(expenses);
        return {
          collect: async () => [] as unknown[],
          first: async () => null,
          withIndex: () => ({
            collect: async () => [],
            first: async () => null,
          }),
        };
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
  overrides: Partial<ContractFixture>,
): ContractFixture {
  return {
    _id: id,
    _creationTime: T0,
    state: "active",
    totalPriceCents: 0,
    createdAt: T0,
    ...overrides,
  };
}

function makePayment(
  id: string,
  overrides: Partial<PaymentFixture>,
): PaymentFixture {
  return {
    _id: id,
    _creationTime: T0,
    amountCents: 0,
    receivedAt: T0,
    isVoided: false,
    ...overrides,
  };
}

function makeExpense(
  id: string,
  overrides: Partial<ExpenseFixture>,
): ExpenseFixture {
  return {
    _id: id,
    _creationTime: T0,
    amountCents: 0,
    paidAt: T0,
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

describe("computeTrailingMonthBounds", () => {
  it("returns 12 sequential Manila calendar months ending at the current month", () => {
    const bounds = computeTrailingMonthBounds(T0, 12);
    expect(bounds).toHaveLength(12);
    expect(bounds[0]!.monthLabel).toBe("2025-06");
    expect(bounds[11]!.monthLabel).toBe("2026-05");
    // First bucket starts at 2025-06-01 00:00 Manila = 2025-05-31 16:00 UTC.
    expect(new Date(bounds[0]!.startMs).toISOString()).toBe(
      "2025-05-31T16:00:00.000Z",
    );
    // Last bucket ends at 2026-06-01 00:00 Manila = 2026-05-31 16:00 UTC.
    expect(new Date(bounds[11]!.endMs).toISOString()).toBe(
      "2026-05-31T16:00:00.000Z",
    );
  });

  it("walks across the Dec → Jan year rollover correctly", () => {
    // Jan 2026 noon Manila — current month is Jan 2026, so the
    // trailing 12 starts at Feb 2025.
    const ms = new Date("2026-01-10T12:00:00+08:00").getTime();
    const bounds = computeTrailingMonthBounds(ms, 12);
    expect(bounds[0]!.monthLabel).toBe("2025-02");
    expect(bounds[11]!.monthLabel).toBe("2026-01");
    // The Dec 2025 → Jan 2026 step: bucket 10 ends where bucket 11
    // starts, exactly Manila Jan 1 midnight.
    expect(bounds[10]!.endMs).toBe(bounds[11]!.startMs);
    expect(new Date(bounds[11]!.startMs).toISOString()).toBe(
      "2025-12-31T16:00:00.000Z",
    );
  });

  it("treats half-open [start, end) bounds so the boundary never double-counts", () => {
    const bounds = computeTrailingMonthBounds(T0, 12);
    // Every bucket's endMs equals the next bucket's startMs.
    for (let i = 0; i < bounds.length - 1; i++) {
      expect(bounds[i]!.endMs).toBe(bounds[i + 1]!.startMs);
    }
  });

  it("handles leap-February correctly", () => {
    // Mar 1 2024 noon Manila — current month March 2024, previous Feb
    // 2024 was a leap month with 29 days.
    const ms = new Date("2024-03-15T12:00:00+08:00").getTime();
    const bounds = computeTrailingMonthBounds(ms, 12);
    const febBucket = bounds.find((b) => b.monthLabel === "2024-02")!;
    // Feb 1 → Mar 1 spans exactly 29 days in Manila.
    const days = (febBucket.endMs - febBucket.startMs) / (24 * 60 * 60 * 1000);
    expect(days).toBe(29);
  });

  it("returns an empty array on non-positive or non-integer counts", () => {
    expect(computeTrailingMonthBounds(T0, 0)).toEqual([]);
    expect(computeTrailingMonthBounds(T0, -1)).toEqual([]);
    expect(computeTrailingMonthBounds(T0, 1.5)).toEqual([]);
  });

  it("exposes TREND_BUCKET_COUNT as the canonical 12 used by the query", () => {
    expect(TREND_BUCKET_COUNT).toBe(12);
  });
});

describe("getTrendData — auth gate", () => {
  const run = handlerOf(getTrendData);

  it("rejects unauthenticated callers with UNAUTHENTICATED", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("rejects office_staff with FORBIDDEN (admin-only trend surface)", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects customer with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["customer"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

interface TrendBucket {
  monthLabel: string;
  startMs: number;
  endMs: number;
  salesCents: number;
  collectionsCents: number;
  expensesCents: number;
  netCents: number;
}

interface TrendDataResult {
  buckets: TrendBucket[];
  arBalanceCents: number;
  generatedAtMs: number;
}

describe("getTrendData — shape + reactivity surface", () => {
  const run = handlerOf(getTrendData);

  it("returns 12 buckets ordered oldest → newest with zero values for an empty database", async () => {
    const { ctx } = makeCtx({});
    const result = (await run(ctx, {})) as TrendDataResult;
    expect(result.buckets).toHaveLength(12);
    expect(result.buckets[0]!.monthLabel).toBe("2025-06");
    expect(result.buckets[11]!.monthLabel).toBe("2026-05");
    expect(result.arBalanceCents).toBe(0);
    expect(result.generatedAtMs).toBe(T0);
    for (const b of result.buckets) {
      expect(b.salesCents).toBe(0);
      expect(b.collectionsCents).toBe(0);
      expect(b.expensesCents).toBe(0);
      expect(b.netCents).toBe(0);
    }
  });
});

describe("getTrendData — sales partitioning", () => {
  const run = handlerOf(getTrendData);

  it("partitions contracts.createdAt into Manila-month buckets and excludes voided / cancelled", async () => {
    const may2026 = new Date("2026-05-10T12:00:00+08:00").getTime();
    const apr2026 = new Date("2026-04-05T12:00:00+08:00").getTime();
    const jun2025 = new Date("2025-06-20T12:00:00+08:00").getTime();
    const outsideMay2025 = new Date("2025-05-30T12:00:00+08:00").getTime(); // before window
    const { ctx } = makeCtx({
      contracts: [
        makeContract("contracts:1", {
          state: "active",
          totalPriceCents: 100_000,
          createdAt: may2026,
        }),
        makeContract("contracts:2", {
          state: "paid_in_full",
          totalPriceCents: 200_000,
          createdAt: may2026,
        }),
        makeContract("contracts:3", {
          state: "active",
          totalPriceCents: 50_000,
          createdAt: apr2026,
        }),
        makeContract("contracts:4", {
          state: "active",
          totalPriceCents: 25_000,
          createdAt: jun2025,
        }),
        makeContract("contracts:5", {
          state: "cancelled",
          totalPriceCents: 999_999,
          createdAt: may2026,
        }),
        makeContract("contracts:6", {
          state: "voided",
          totalPriceCents: 999_999,
          createdAt: may2026,
        }),
        makeContract("contracts:7", {
          state: "active",
          totalPriceCents: 999_999,
          createdAt: outsideMay2025,
        }),
      ],
    });
    const result = (await run(ctx, {})) as TrendDataResult;
    const byLabel = Object.fromEntries(
      result.buckets.map((b) => [b.monthLabel, b]),
    );
    expect(byLabel["2026-05"]!.salesCents).toBe(300_000);
    expect(byLabel["2026-04"]!.salesCents).toBe(50_000);
    expect(byLabel["2025-06"]!.salesCents).toBe(25_000);
    // Out-of-window contract must not leak into any bucket.
    const totalSales = result.buckets.reduce((s, b) => s + b.salesCents, 0);
    expect(totalSales).toBe(375_000);
  });
});

describe("getTrendData — AR balance snapshot", () => {
  const run = handlerOf(getTrendData);

  it("sums active + in_default contracts into arBalanceCents and ignores other states", async () => {
    const { ctx } = makeCtx({
      contracts: [
        makeContract("contracts:1", {
          state: "active",
          totalPriceCents: 100_000,
        }),
        makeContract("contracts:2", {
          state: "in_default",
          totalPriceCents: 50_000,
        }),
        makeContract("contracts:3", {
          state: "paid_in_full",
          totalPriceCents: 999_999,
        }),
        makeContract("contracts:4", {
          state: "cancelled",
          totalPriceCents: 999_999,
        }),
        makeContract("contracts:5", {
          state: "voided",
          totalPriceCents: 999_999,
        }),
      ],
    });
    const result = (await run(ctx, {})) as TrendDataResult;
    expect(result.arBalanceCents).toBe(150_000);
  });

  it("counts contracts in all states across the FULL table for the AR balance snapshot, even when their createdAt is outside the trailing-12-month window", async () => {
    // The sales partition uses an indexed range scan bounded by the
    // window; AR uses a full-table scan precisely so that older still-
    // open contracts continue to count toward AR. This test seeds an
    // ancient active contract (createdAt ~ 5 years ago) plus a
    // recently-defaulted contract (also pre-window) and asserts both
    // land in `arBalanceCents` but NOT in any sales bucket.
    const ancientActive = new Date("2021-01-15T12:00:00+08:00").getTime();
    const preWindowDefault = new Date("2025-03-20T12:00:00+08:00").getTime();
    const { ctx } = makeCtx({
      contracts: [
        makeContract("contracts:ancient", {
          state: "active",
          totalPriceCents: 250_000,
          createdAt: ancientActive,
        }),
        makeContract("contracts:preDefault", {
          state: "in_default",
          totalPriceCents: 75_000,
          createdAt: preWindowDefault,
        }),
        makeContract("contracts:inWindow", {
          state: "active",
          totalPriceCents: 40_000,
          createdAt: new Date("2026-05-10T12:00:00+08:00").getTime(),
        }),
      ],
    });
    const result = (await run(ctx, {})) as TrendDataResult;
    // AR balance picks up ALL three (full-scan path).
    expect(result.arBalanceCents).toBe(250_000 + 75_000 + 40_000);
    // Sales only picks up the in-window row (indexed-range path).
    const totalSales = result.buckets.reduce((s, b) => s + b.salesCents, 0);
    expect(totalSales).toBe(40_000);
    const byLabel = Object.fromEntries(
      result.buckets.map((b) => [b.monthLabel, b]),
    );
    expect(byLabel["2026-05"]!.salesCents).toBe(40_000);
  });
});

describe("getTrendData — sales uses indexed window range", () => {
  const run = handlerOf(getTrendData);

  it("excludes contracts whose createdAt falls BEFORE the trailing-12-month window from every sales bucket", async () => {
    // Window for T0 = 2026-05-15 is [2025-06-01, 2026-06-01) Manila.
    const justBefore = new Date("2025-05-31T23:00:00+08:00").getTime();
    const firstMonth = new Date("2025-06-01T00:30:00+08:00").getTime();
    const { ctx } = makeCtx({
      contracts: [
        makeContract("contracts:before", {
          state: "active",
          totalPriceCents: 999_999,
          createdAt: justBefore,
        }),
        makeContract("contracts:firstMonth", {
          state: "active",
          totalPriceCents: 10_000,
          createdAt: firstMonth,
        }),
      ],
    });
    const result = (await run(ctx, {})) as TrendDataResult;
    const totalSales = result.buckets.reduce((s, b) => s + b.salesCents, 0);
    // Only the in-window contract is summed — the pre-window row is
    // filtered out by the indexed range, never reaching the partition
    // loop.
    expect(totalSales).toBe(10_000);
    const byLabel = Object.fromEntries(
      result.buckets.map((b) => [b.monthLabel, b]),
    );
    expect(byLabel["2025-06"]!.salesCents).toBe(10_000);
  });

  it("excludes contracts whose createdAt falls AFTER the trailing-12-month window from every sales bucket", async () => {
    // Window upper bound is 2026-06-01 00:00 Manila (exclusive).
    const onUpperBound = new Date("2026-06-01T00:00:00+08:00").getTime();
    const wellAfter = new Date("2026-08-15T12:00:00+08:00").getTime();
    const { ctx } = makeCtx({
      contracts: [
        makeContract("contracts:onBound", {
          state: "active",
          totalPriceCents: 999_999,
          createdAt: onUpperBound,
        }),
        makeContract("contracts:future", {
          state: "active",
          totalPriceCents: 999_999,
          createdAt: wellAfter,
        }),
      ],
    });
    const result = (await run(ctx, {})) as TrendDataResult;
    const totalSales = result.buckets.reduce((s, b) => s + b.salesCents, 0);
    expect(totalSales).toBe(0);
  });
});

describe("getTrendData — collections aggregation", () => {
  const run = handlerOf(getTrendData);

  it("sums non-voided payments by receivedAt into the right Manila month", async () => {
    const may10 = new Date("2026-05-10T12:00:00+08:00").getTime();
    const apr2 = new Date("2026-04-02T08:00:00+08:00").getTime();
    const { ctx } = makeCtx({
      payments: [
        makePayment("payments:1", { amountCents: 50_000, receivedAt: may10 }),
        makePayment("payments:2", { amountCents: 25_000, receivedAt: may10 }),
        makePayment("payments:3", {
          amountCents: 999_999,
          receivedAt: may10,
          isVoided: true,
        }),
        makePayment("payments:4", { amountCents: 12_345, receivedAt: apr2 }),
      ],
    });
    const result = (await run(ctx, {})) as TrendDataResult;
    const byLabel = Object.fromEntries(
      result.buckets.map((b) => [b.monthLabel, b]),
    );
    expect(byLabel["2026-05"]!.collectionsCents).toBe(75_000);
    expect(byLabel["2026-04"]!.collectionsCents).toBe(12_345);
  });
});

describe("getTrendData — expenses aggregation", () => {
  const run = handlerOf(getTrendData);

  it("sums expenses.paidAt into the right Manila month", async () => {
    const may10 = new Date("2026-05-10T12:00:00+08:00").getTime();
    const mar15 = new Date("2026-03-15T12:00:00+08:00").getTime();
    const { ctx } = makeCtx({
      expenses: [
        makeExpense("expenses:1", { amountCents: 30_000, paidAt: may10 }),
        makeExpense("expenses:2", { amountCents: 18_000, paidAt: may10 }),
        makeExpense("expenses:3", { amountCents: 7_500, paidAt: mar15 }),
      ],
    });
    const result = (await run(ctx, {})) as TrendDataResult;
    const byLabel = Object.fromEntries(
      result.buckets.map((b) => [b.monthLabel, b]),
    );
    expect(byLabel["2026-05"]!.expensesCents).toBe(48_000);
    expect(byLabel["2026-03"]!.expensesCents).toBe(7_500);
  });
});

describe("getTrendData — net (collections − expenses)", () => {
  const run = handlerOf(getTrendData);

  it("computes netCents per bucket from the bucket's collections − expenses", async () => {
    const may10 = new Date("2026-05-10T12:00:00+08:00").getTime();
    const apr10 = new Date("2026-04-10T12:00:00+08:00").getTime();
    const { ctx } = makeCtx({
      payments: [
        makePayment("payments:1", { amountCents: 100_000, receivedAt: may10 }),
        makePayment("payments:2", { amountCents: 20_000, receivedAt: apr10 }),
      ],
      expenses: [
        makeExpense("expenses:1", { amountCents: 40_000, paidAt: may10 }),
        makeExpense("expenses:2", { amountCents: 60_000, paidAt: apr10 }),
      ],
    });
    const result = (await run(ctx, {})) as TrendDataResult;
    const byLabel = Object.fromEntries(
      result.buckets.map((b) => [b.monthLabel, b]),
    );
    expect(byLabel["2026-05"]!.netCents).toBe(60_000);
    // April: collections − expenses = 20_000 − 60_000 = −40_000.
    expect(byLabel["2026-04"]!.netCents).toBe(-40_000);
  });

  it("permits net to be negative when expenses exceed collections (cash basis)", async () => {
    const may10 = new Date("2026-05-10T12:00:00+08:00").getTime();
    const { ctx } = makeCtx({
      expenses: [makeExpense("expenses:1", { amountCents: 5_000, paidAt: may10 })],
    });
    const result = (await run(ctx, {})) as TrendDataResult;
    const may = result.buckets.find((b) => b.monthLabel === "2026-05")!;
    expect(may.netCents).toBe(-5_000);
  });
});
