/**
 * Story 5.2 — `convex/dashboard.ts` unit tests.
 *
 * Coverage target: NFR-M2 ≥ 90% on financial-touching code. The
 * dashboard queries aggregate money fields the owner trusts — a wrong
 * aggregate would silently mislead Mr. Reyes about the business.
 *
 * Strategy: hand-mocked ctx (same pattern as `expenses.test.ts` /
 * `contracts.test.ts`). The mock supports the tables this module reads:
 *
 *   - `lots` (collect + iterate by `isRetired` / `status`)
 *   - `contracts` (collect + iterate by `state` / `createdAt`)
 *   - `payments` (withIndex `by_receivedAt` range + voided filter)
 *   - `expenses` (withIndex `by_paidAt` range)
 *   - `userRoles` (read for the auth helper)
 *   - `users` / `authSessions` (read for the auth helper)
 *
 * Tests cover:
 *   - Auth gates (unauth → UNAUTHENTICATED; office_staff /
 *     field_worker / customer → FORBIDDEN for getDashboardKpis).
 *   - Period bounds for MTD / YTD on Manila tz.
 *   - Money tile aggregates (sales, collections excluding voided,
 *     AR balance excluding paid_in_full, expenses).
 *   - Lot inventory counts ignore retired rows.
 *   - Active / paid_in_full / in_default contract counts.
 *   - Net = collections − expenses (cash basis), with sign flag when
 *     expenses exceed collections.
 *   - Delta computation vs. prior period slice.
 *   - getArAgingSummary returns placeholder zero-buckets (Epic 4
 *     dependency).
 *   - getFlaggedForFollowupSummary returns placeholder zero-count
 *     (Story 5.4 dependency).
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
  comparisonBounds,
  getArAgingSummary,
  getDashboardKpis,
  getFlaggedForFollowupSummary,
  periodBounds,
} from "../../../convex/dashboard";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

// 2026-05-15 noon Manila — middle of May 2026 so that the MTD window
// covers May 1 → T0 and the comparison window covers April 1 → April 15.
const T0 = new Date("2026-05-15T12:00:00+08:00").getTime();
const USER_ID = "users:abc123";
const SESSION_ID = "authSessions:def456";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface LotFixture {
  _id: string;
  _creationTime: number;
  status:
    | "available"
    | "reserved"
    | "sold"
    | "occupied"
    | "cancelled"
    | "defaulted"
    | "transferred";
  isRetired: boolean;
}

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
  // Story 5.4 — flag-for-follow-up fields, all optional so existing
  // fixtures don't need to set them. Used by the new
  // `getFlaggedForFollowupSummary` data-path tests.
  isFlagged?: boolean;
  flagReason?: string;
  flaggedAt?: number;
  flaggedBy?: string;
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
  /**
   * Story 6.6 follow-up — `sumExpensesInRange` must EXCLUDE rows
   * whose `approvalStatus` is `pending_approval` or `rejected`. The
   * field is optional so legacy fixtures (pre-6.6) keep working —
   * missing is treated as `approved` server-side.
   */
  approvalStatus?: "approved" | "pending_approval" | "rejected";
}

interface CtxBag {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  lots?: LotFixture[];
  contracts?: ContractFixture[];
  payments?: PaymentFixture[];
  expenses?: ExpenseFixture[];
  authenticated?: boolean;
}): CtxBag {
  const lots = opts.lots ?? [];
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
        if (table === "lots") return makeQueryBuilder(lots);
        if (table === "contracts") return makeQueryBuilder(contracts);
        if (table === "payments") return makeQueryBuilder(payments);
        if (table === "expenses") return makeQueryBuilder(expenses);
        // Story 4.1 wired the dashboard's `getArAgingSummary` to read the
        // `arAgingSnapshots` table directly via `.collect()`. The fallback
        // returns an empty array so existing dashboard tests continue to
        // exercise the placeholder branch (no snapshots → isPlaceholder:
        // true).
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

function makeLot(id: string, overrides: Partial<LotFixture>): LotFixture {
  return {
    _id: id,
    _creationTime: T0,
    status: "available",
    isRetired: false,
    ...overrides,
  };
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
    // Default: no approvalStatus → treated as approved by the server-
    // side `sumExpensesInRange` filter (back-compat with pre-Story
    // 6.6 fixtures). Tests that need to exercise the workflow override
    // explicitly.
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

describe("periodBounds", () => {
  it("MTD bounds the start at the first of the current Manila month", () => {
    const { startMs, endMs } = periodBounds("mtd", T0);
    expect(endMs).toBe(T0);
    expect(new Date(startMs).toISOString()).toBe(
      "2026-04-30T16:00:00.000Z", // May 1 00:00 +08:00 = Apr 30 16:00 UTC
    );
  });

  it("YTD bounds the start at Jan 1 of the current Manila year", () => {
    const { startMs, endMs } = periodBounds("ytd", T0);
    expect(endMs).toBe(T0);
    expect(new Date(startMs).toISOString()).toBe(
      "2025-12-31T16:00:00.000Z", // 2026-01-01 00:00 +08:00 = 2025-12-31 16:00 UTC
    );
  });
});

describe("comparisonBounds", () => {
  it("MTD comparison shifts backward by 24 hours (yesterday-same-time-of-day)", () => {
    // Adversarial-review fix: the MTD delta is "vs yesterday", not
    // "vs last month". Today T0 is May 15 noon Manila; the comparison
    // window should be May 14 noon back to May 1 noon — i.e. simply
    // T0 − 24h.
    const current = periodBounds("mtd", T0);
    const comparison = comparisonBounds("mtd", current.startMs, current.endMs);
    const DAY_MS = 24 * 60 * 60 * 1000;
    // endMs is exactly 24 hours before T0 (the dashboard "now").
    expect(comparison.endMs).toBe(T0 - DAY_MS);
    expect(new Date(comparison.endMs).toISOString()).toBe(
      "2026-05-14T04:00:00.000Z", // May 14 12:00 +08:00 = May 14 04:00 UTC
    );
    // startMs is current period start shifted back 24h as well so the
    // window LENGTH is preserved (apples-to-apples comparison).
    expect(comparison.startMs).toBe(current.startMs - DAY_MS);
  });

  it("YTD comparison shifts backward by one year", () => {
    const current = periodBounds("ytd", T0);
    const comparison = comparisonBounds("ytd", current.startMs, current.endMs);
    const lengthMs = current.endMs - current.startMs;
    expect(comparison.endMs - comparison.startMs).toBe(lengthMs);
    expect(new Date(comparison.startMs).toISOString()).toBe(
      "2024-12-31T16:00:00.000Z",
    );
  });
});

describe("getDashboardKpis — auth", () => {
  const run = handlerOf(getDashboardKpis);

  it("rejects unauthenticated callers with UNAUTHENTICATED", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, { period: "mtd" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("rejects office_staff with FORBIDDEN (admin-only KPI aggregate)", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(ctx, { period: "mtd" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    const thrown = await run(ctx, { period: "mtd" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects customer with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["customer"] });
    const thrown = await run(ctx, { period: "mtd" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("getDashboardKpis — lot inventory", () => {
  const run = handlerOf(getDashboardKpis);

  it("counts lots by status and ignores retired rows", async () => {
    const { ctx } = makeCtx({
      lots: [
        makeLot("lots:1", { status: "available" }),
        makeLot("lots:2", { status: "available" }),
        makeLot("lots:3", { status: "reserved" }),
        makeLot("lots:4", { status: "sold" }),
        makeLot("lots:5", { status: "occupied" }),
        makeLot("lots:6", { status: "available", isRetired: true }), // ignored
        makeLot("lots:7", { status: "cancelled" }), // counted in total only
      ],
    });
    const result = (await run(ctx, { period: "mtd" })) as {
      lotsTotal: number;
      lotsAvailable: number;
      lotsReserved: number;
      lotsSold: number;
      lotsOccupied: number;
    };
    expect(result.lotsTotal).toBe(6);
    expect(result.lotsAvailable).toBe(2);
    expect(result.lotsReserved).toBe(1);
    expect(result.lotsSold).toBe(1);
    expect(result.lotsOccupied).toBe(1);
  });
});

describe("getDashboardKpis — contract snapshot + AR balance", () => {
  const run = handlerOf(getDashboardKpis);

  it("sums active + in_default totalPriceCents into AR balance and counts states", async () => {
    const { ctx } = makeCtx({
      contracts: [
        makeContract("contracts:1", {
          state: "active",
          totalPriceCents: 100_000,
        }),
        makeContract("contracts:2", {
          state: "active",
          totalPriceCents: 200_000,
        }),
        makeContract("contracts:3", {
          state: "in_default",
          totalPriceCents: 50_000,
        }),
        makeContract("contracts:4", {
          state: "paid_in_full",
          totalPriceCents: 999_999, // does not count toward AR
        }),
        makeContract("contracts:5", {
          state: "cancelled",
          totalPriceCents: 12_345,
        }),
      ],
    });
    const result = (await run(ctx, { period: "mtd" })) as {
      arBalanceCents: number;
      contractsActive: number;
      contractsInDefault: number;
      contractsPaidInFull: number;
    };
    expect(result.arBalanceCents).toBe(350_000);
    expect(result.contractsActive).toBe(2);
    expect(result.contractsInDefault).toBe(1);
    expect(result.contractsPaidInFull).toBe(1);
  });
});

describe("getDashboardKpis — sales aggregate (period-bounded)", () => {
  const run = handlerOf(getDashboardKpis);

  it("sums contracts created within the MTD window, excluding voided / cancelled", async () => {
    const insideMay1 = makeContract("contracts:1", {
      state: "active",
      totalPriceCents: 100_000,
      createdAt: T0,
    });
    const insideMay2 = makeContract("contracts:2", {
      state: "paid_in_full",
      totalPriceCents: 200_000,
      createdAt: T0 - HOUR_MS, // earlier today
    });
    const cancelledInMay = makeContract("contracts:3", {
      state: "cancelled",
      totalPriceCents: 9_999_999,
      createdAt: T0 - 2 * HOUR_MS,
    });
    const voidedInMay = makeContract("contracts:4", {
      state: "voided",
      totalPriceCents: 9_999_999,
      createdAt: T0 - 3 * HOUR_MS,
    });
    const aprilContract = makeContract("contracts:5", {
      state: "active",
      totalPriceCents: 500_000,
      createdAt: new Date("2026-04-15T12:00:00+08:00").getTime(),
    });
    const { ctx } = makeCtx({
      contracts: [
        insideMay1,
        insideMay2,
        cancelledInMay,
        voidedInMay,
        aprilContract,
      ],
    });
    const result = (await run(ctx, { period: "mtd" })) as {
      salesCents: number;
    };
    expect(result.salesCents).toBe(300_000);
  });

  it("YTD includes contracts from earlier months in the year", async () => {
    const { ctx } = makeCtx({
      contracts: [
        makeContract("contracts:1", {
          state: "active",
          totalPriceCents: 100_000,
          createdAt: T0,
        }),
        makeContract("contracts:2", {
          state: "active",
          totalPriceCents: 250_000,
          createdAt: new Date("2026-02-10T12:00:00+08:00").getTime(),
        }),
        makeContract("contracts:3", {
          state: "active",
          totalPriceCents: 700_000,
          createdAt: new Date("2025-12-30T12:00:00+08:00").getTime(), // prior year
        }),
      ],
    });
    const result = (await run(ctx, { period: "ytd" })) as {
      salesCents: number;
    };
    expect(result.salesCents).toBe(350_000);
  });
});

describe("getDashboardKpis — collections (non-voided payments)", () => {
  const run = handlerOf(getDashboardKpis);

  it("sums non-voided payments received within the period and excludes voided", async () => {
    const { ctx } = makeCtx({
      payments: [
        makePayment("payments:1", {
          amountCents: 50_000,
          receivedAt: T0,
        }),
        makePayment("payments:2", {
          amountCents: 25_000,
          receivedAt: T0 - HOUR_MS,
        }),
        makePayment("payments:3", {
          amountCents: 999_999,
          receivedAt: T0,
          isVoided: true,
        }),
        makePayment("payments:4", {
          amountCents: 12_345,
          receivedAt: new Date("2026-04-15T12:00:00+08:00").getTime(),
        }),
      ],
    });
    const result = (await run(ctx, { period: "mtd" })) as {
      collectionsCents: number;
    };
    expect(result.collectionsCents).toBe(75_000);
  });
});

describe("getDashboardKpis — expenses", () => {
  const run = handlerOf(getDashboardKpis);

  it("sums expenses.paidAt within the MTD period", async () => {
    const { ctx } = makeCtx({
      expenses: [
        makeExpense("expenses:1", { amountCents: 30_000, paidAt: T0 }),
        makeExpense("expenses:2", {
          amountCents: 18_000,
          paidAt: T0 - HOUR_MS,
        }),
        makeExpense("expenses:3", {
          amountCents: 99_999,
          paidAt: new Date("2026-04-15T12:00:00+08:00").getTime(),
        }),
      ],
    });
    const result = (await run(ctx, { period: "mtd" })) as {
      expensesCents: number;
    };
    expect(result.expensesCents).toBe(48_000);
  });

  it("Story 6.6 follow-up: excludes pending_approval and rejected expenses, treats missing approvalStatus as approved", async () => {
    const { ctx } = makeCtx({
      expenses: [
        // Pre-6.6 row (no approvalStatus field) — counts as approved.
        makeExpense("expenses:legacy", { amountCents: 10_000, paidAt: T0 }),
        // Explicitly approved — counts.
        makeExpense("expenses:approved", {
          amountCents: 20_000,
          paidAt: T0,
          approvalStatus: "approved",
        }),
        // Pending approval — must be excluded.
        makeExpense("expenses:pending", {
          amountCents: 99_000,
          paidAt: T0,
          approvalStatus: "pending_approval",
        }),
        // Rejected — must be excluded.
        makeExpense("expenses:rejected", {
          amountCents: 88_000,
          paidAt: T0,
          approvalStatus: "rejected",
        }),
      ],
    });
    const result = (await run(ctx, { period: "mtd" })) as {
      expensesCents: number;
    };
    // 10k legacy + 20k approved = 30k; pending/rejected excluded.
    expect(result.expensesCents).toBe(30_000);
  });
});

describe("getDashboardKpis — net (cash basis) and sign flag", () => {
  const run = handlerOf(getDashboardKpis);

  it("netCents = collections − expenses when collections > expenses (positive)", async () => {
    const { ctx } = makeCtx({
      payments: [makePayment("p:1", { amountCents: 100_000, receivedAt: T0 })],
      expenses: [makeExpense("e:1", { amountCents: 40_000, paidAt: T0 })],
    });
    const result = (await run(ctx, { period: "mtd" })) as {
      netCents: number;
      netIsNegative: boolean;
    };
    expect(result.netCents).toBe(60_000);
    expect(result.netIsNegative).toBe(false);
  });

  it("netCents = expenses − collections (abs magnitude) when expenses > collections", async () => {
    const { ctx } = makeCtx({
      payments: [makePayment("p:1", { amountCents: 40_000, receivedAt: T0 })],
      expenses: [makeExpense("e:1", { amountCents: 100_000, paidAt: T0 })],
    });
    const result = (await run(ctx, { period: "mtd" })) as {
      netCents: number;
      netIsNegative: boolean;
    };
    expect(result.netCents).toBe(60_000);
    expect(result.netIsNegative).toBe(true);
  });
});

describe("getDashboardKpis — deltas", () => {
  const run = handlerOf(getDashboardKpis);

  it("salesDelta is signed: positive when current period > comparison (vs yesterday)", async () => {
    // Adversarial-review fix: MTD delta is "vs yesterday". The current
    // MTD window is [May 1, T0); the comparison window shifts that
    // back by 24h so it covers [April 30, T0 - 24h). Place the
    // comparison fixture in April 30 (outside the current MTD window,
    // inside the comparison window) so the assertion isolates the
    // delta math cleanly.
    const yesterdaySlice = new Date("2026-04-30T12:00:00+08:00").getTime();
    const { ctx } = makeCtx({
      contracts: [
        makeContract("contracts:current", {
          state: "active",
          totalPriceCents: 300_000,
          createdAt: T0,
        }),
        makeContract("contracts:prior", {
          state: "active",
          totalPriceCents: 100_000,
          createdAt: yesterdaySlice,
        }),
      ],
    });
    const result = (await run(ctx, { period: "mtd" })) as {
      salesCents: number;
      salesDeltaCents: number;
    };
    expect(result.salesCents).toBe(300_000);
    expect(result.salesDeltaCents).toBe(200_000);
  });

  it("expensesDelta is signed: positive when current > comparison (vs yesterday)", async () => {
    const yesterdaySlice = new Date("2026-04-30T12:00:00+08:00").getTime();
    const { ctx } = makeCtx({
      expenses: [
        makeExpense("e:current", { amountCents: 50_000, paidAt: T0 }),
        makeExpense("e:prior", { amountCents: 20_000, paidAt: yesterdaySlice }),
      ],
    });
    const result = (await run(ctx, { period: "mtd" })) as {
      expensesDeltaCents: number;
    };
    expect(result.expensesDeltaCents).toBe(30_000);
  });

  it("netDelta sign reflects signed net difference vs yesterday", async () => {
    const yesterdaySlice = new Date("2026-04-30T12:00:00+08:00").getTime();
    const { ctx } = makeCtx({
      // Current: collections 100k - expenses 40k = +60k
      payments: [
        makePayment("p:current", { amountCents: 100_000, receivedAt: T0 }),
        makePayment("p:prior", {
          amountCents: 80_000,
          receivedAt: yesterdaySlice,
        }),
      ],
      expenses: [
        makeExpense("e:current", { amountCents: 40_000, paidAt: T0 }),
        // Prior: collections 80k - expenses 30k = +50k
        makeExpense("e:prior", { amountCents: 30_000, paidAt: yesterdaySlice }),
      ],
    });
    const result = (await run(ctx, { period: "mtd" })) as {
      netCents: number;
      netIsNegative: boolean;
      netDeltaCents: number;
      netDeltaIsNegative: boolean;
    };
    expect(result.netCents).toBe(60_000);
    expect(result.netIsNegative).toBe(false);
    // 60k − 50k = +10k
    expect(result.netDeltaCents).toBe(10_000);
    expect(result.netDeltaIsNegative).toBe(false);
  });
});

describe("getDashboardKpis — period start/end echoed back", () => {
  const run = handlerOf(getDashboardKpis);

  it("returns the resolved MTD period bounds", async () => {
    const { ctx } = makeCtx({});
    const result = (await run(ctx, { period: "mtd" })) as {
      period: string;
      periodStartMs: number;
      periodEndMs: number;
    };
    expect(result.period).toBe("mtd");
    expect(result.periodEndMs).toBe(T0);
    expect(new Date(result.periodStartMs).toISOString()).toBe(
      "2026-04-30T16:00:00.000Z",
    );
  });

  it("returns the resolved YTD period bounds", async () => {
    const { ctx } = makeCtx({});
    const result = (await run(ctx, { period: "ytd" })) as {
      period: string;
      periodStartMs: number;
    };
    expect(result.period).toBe("ytd");
    expect(new Date(result.periodStartMs).toISOString()).toBe(
      "2025-12-31T16:00:00.000Z",
    );
  });
});

describe("getArAgingSummary", () => {
  const run = handlerOf(getArAgingSummary);

  it("returns four zero-buckets in the canonical order with isPlaceholder: true", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const result = (await run(ctx, {})) as {
      buckets: Array<{
        key: string;
        count: number;
        totalCents: number;
        withLoggedActionCount: number;
      }>;
      isPlaceholder: boolean;
    };
    expect(result.isPlaceholder).toBe(true);
    expect(result.buckets.map((b) => b.key)).toEqual([
      "1-30",
      "31-60",
      "61-90",
      "90+",
    ]);
    for (const bucket of result.buckets) {
      expect(bucket.count).toBe(0);
      expect(bucket.totalCents).toBe(0);
      expect(bucket.withLoggedActionCount).toBe(0);
    }
  });

  it("allows office_staff to read the aging summary (shared with staff page)", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const result = (await run(ctx, {})) as { isPlaceholder: boolean };
    expect(result.isPlaceholder).toBe(true);
  });

  it("rejects customer with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["customer"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});

describe("getFlaggedForFollowupSummary", () => {
  const run = handlerOf(getFlaggedForFollowupSummary);

  it("returns zero count + null comment + isPlaceholder: false when no contracts are flagged (Story 5.4)", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      contracts: [makeContract("contracts:1", { state: "active" })],
    });
    const result = (await run(ctx, {})) as {
      count: number;
      mostRecentComment: string | null;
      mostRecentFlaggedAt: number | null;
      isPlaceholder: boolean;
    };
    expect(result.count).toBe(0);
    expect(result.mostRecentComment).toBeNull();
    expect(result.mostRecentFlaggedAt).toBeNull();
    // Story 5.4 wired the query to real data — the placeholder branch
    // is gone; `isPlaceholder` is `false` whenever the query executes.
    expect(result.isPlaceholder).toBe(false);
  });

  it("counts flagged contracts and surfaces the most-recent comment + timestamp (Story 5.4)", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      contracts: [
        makeContract("contracts:1", {
          state: "active",
          isFlagged: true,
          flagReason: "Older flag",
          flaggedAt: T0 - 60_000,
        }),
        makeContract("contracts:2", {
          state: "active",
          isFlagged: true,
          flagReason: "Newest flag",
          flaggedAt: T0 - 1_000,
        }),
        makeContract("contracts:3", {
          state: "active",
          isFlagged: false,
        }),
      ],
    });
    const result = (await run(ctx, {})) as {
      count: number;
      mostRecentComment: string | null;
      mostRecentFlaggedAt: number | null;
      isPlaceholder: boolean;
    };
    expect(result.count).toBe(2);
    expect(result.mostRecentComment).toBe("Newest flag");
    expect(result.mostRecentFlaggedAt).toBe(T0 - 1_000);
    expect(result.isPlaceholder).toBe(false);
  });

  it("rejects office_staff with FORBIDDEN (admin-only viewer scope)", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});
