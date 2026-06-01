/**
 * Story 5.5 — `convex/reconciliation.ts` unit tests.
 *
 * Coverage targets (NFR-M2 ≥ 90% on financial-touching server code; this
 * file targets ≥ 95% on `convex/reconciliation.ts` since reconciliation
 * is safety-critical defense-in-depth code):
 *
 *   - `internal_runReconciliationCheck` for each of the three checkTypes:
 *     - `payments_match_allocations` — clean fixture (zero failures);
 *       deliberate-divergence fixture (non-zero, expected delta);
 *       voided-payments excluded.
 *     - `contract_total_ok` — clean fixture; over-applied contract
 *       (allocations sum exceeds totalPriceCents); voided-payment
 *       allocations excluded; both direct and installment-targeted
 *       allocations summed.
 *     - `installment_paid_bounded` — clean fixture; one installment
 *       with paidCents > principalCents.
 *   - `internal_runDailyReconciliation` (the cron's body) — emits one
 *     reconciliationRuns row per checkType, returns the per-check
 *     summary shape, and records triggeredBy: "cron" by default.
 *   - `runReconciliationNow` admin escape hatch — auth gate, records
 *     triggeredBy: "manual".
 *   - `getLatestReconciliation` admin-only public query — returns the
 *     most-recent row per checkType, null when no rows exist.
 *
 * The deliberate-divergence test (Story 5.5 AC4) is the single most
 * important assertion in this file: it proves the invariant DETECTS a
 * mismatch, not just that it passes on clean fixtures. A reconciliation
 * function with no proof it detects mismatches is worse than no function
 * at all — it gives false confidence.
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
  getLatestReconciliation,
  internal_runDailyReconciliation,
  internal_runReconciliationCheck,
  runReconciliationNow,
} from "../../../convex/reconciliation";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-05-20T12:00:00+08:00").getTime();
const USER_ID = "users:abc123";
const SESSION_ID = "authSessions:def456";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface PaymentFixture {
  _id: string;
  _creationTime: number;
  paymentNumber: string;
  amountCents: number;
  isVoided: boolean;
  contractId?: string;
}

interface AllocationFixture {
  _id: string;
  _creationTime: number;
  paymentId: string;
  targetType: "contract" | "installment" | "perpetualCare" | "credit";
  targetId: string;
  amountCents: number;
  sequence: number;
}

interface ContractFixture {
  _id: string;
  _creationTime: number;
  contractNumber: string;
  totalPriceCents: number;
  state: "active" | "paid_in_full" | "cancelled" | "voided" | "in_default";
}

interface InstallmentFixture {
  _id: string;
  _creationTime: number;
  contractId: string;
  installmentNumber: number;
  principalCents: number;
  paidCents: number;
  status: "pending" | "paid" | "overdue" | "waived";
  dueDate: number;
}

interface ReconciliationRunFixture {
  _id: string;
  _creationTime: number;
  runAt: number;
  checkType:
    | "payments_match_allocations"
    | "contract_total_ok"
    | "installment_paid_bounded";
  status: "ok" | "warn" | "fail";
  summary: Record<string, unknown>;
  triggeredBy?: "cron" | "manual";
}

interface CtxBag {
  payments: Map<string, PaymentFixture>;
  allocations: Map<string, AllocationFixture>;
  contracts: Map<string, ContractFixture>;
  installments: Map<string, InstallmentFixture>;
  runs: Map<string, ReconciliationRunFixture>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  payments?: PaymentFixture[];
  allocations?: AllocationFixture[];
  contracts?: ContractFixture[];
  installments?: InstallmentFixture[];
  runs?: ReconciliationRunFixture[];
  authenticated?: boolean;
}): CtxBag {
  const payments = new Map<string, PaymentFixture>(
    (opts.payments ?? []).map((p) => [p._id, p]),
  );
  const allocations = new Map<string, AllocationFixture>(
    (opts.allocations ?? []).map((a) => [a._id, a]),
  );
  const contracts = new Map<string, ContractFixture>(
    (opts.contracts ?? []).map((c) => [c._id, c]),
  );
  const installments = new Map<string, InstallmentFixture>(
    (opts.installments ?? []).map((i) => [i._id, i]),
  );
  const runs = new Map<string, ReconciliationRunFixture>(
    (opts.runs ?? []).map((r) => [r._id, r]),
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
    if (table === "payments") {
      return Array.from(payments.values()) as unknown as Record<
        string,
        unknown
      >[];
    }
    if (table === "paymentAllocations") {
      return Array.from(allocations.values()) as unknown as Record<
        string,
        unknown
      >[];
    }
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
    if (table === "reconciliationRuns") {
      return Array.from(runs.values()) as unknown as Record<string, unknown>[];
    }
    return [];
  }

  interface IndexQuery {
    eqs: Record<string, unknown>;
    eq(field: string, value: unknown): IndexQuery;
  }

  type SortDir = "asc" | "desc";

  function makeQueryBuilder(table: string) {
    const predicates: Predicate[] = [];
    let sortDir: SortDir = "asc";
    const indexFields: string[] = [];
    const builder = {
      withIndex(indexName: string, fn?: (q: IndexQuery) => IndexQuery) {
        if (fn !== undefined) {
          const q: IndexQuery = {
            eqs: {},
            eq(field, value) {
              this.eqs[field] = value;
              indexFields.push(field);
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
        // Capture the sort key for `.order("desc")` semantics. We
        // approximate the index sort order by the last field passed to
        // `.eq()` not being the sort key — Convex orders by the index
        // suffix. For our purposes, the only `.order("desc")` consumer
        // is `getLatestReconciliation` reading `by_checkType_runAt` with
        // `eq("checkType", ...)`; sort by `runAt` desc afterwards.
        if (
          table === "reconciliationRuns" &&
          indexName === "by_checkType_runAt"
        ) {
          // The non-eq suffix of the index is `runAt`.
          // Sort logic applied in `first()` / `collect()` based on sortDir.
        }
        return builder;
      },
      order(dir: SortDir) {
        sortDir = dir;
        return builder;
      },
      async first(): Promise<Record<string, unknown> | null> {
        const filtered = rowsForTable(table).filter((r) =>
          predicates.every((p) => p(r)),
        );
        if (table === "reconciliationRuns") {
          filtered.sort((a, b) => {
            const aRun = (a as Record<string, unknown>).runAt as number;
            const bRun = (b as Record<string, unknown>).runAt as number;
            return sortDir === "desc" ? bRun - aRun : aRun - bRun;
          });
        }
        return filtered[0] ?? null;
      },
      async collect(): Promise<Record<string, unknown>[]> {
        return rowsForTable(table).filter((r) => predicates.every((p) => p(r)));
      },
    };
    return builder;
  }

  function makeFullScan(table: string) {
    return {
      withIndex: (_: unknown) => makeFullScan(table),
      order: (_: unknown) => makeFullScan(table),
      async first() {
        return rowsForTable(table)[0] ?? null;
      },
      async collect() {
        return rowsForTable(table);
      },
    };
  }

  const ctx = {
    db: {
      get: vi.fn(async (id: string) => {
        if (id === USER_ID) return user;
        if (id === SESSION_ID) return session;
        if (payments.has(id)) return payments.get(id);
        if (allocations.has(id)) return allocations.get(id);
        if (contracts.has(id)) return contracts.get(id);
        if (installments.has(id)) return installments.get(id);
        if (runs.has(id)) return runs.get(id);
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
        // Both indexed and full-scan reads supported via the same
        // builder; an un-indexed `.collect()` returns the whole table.
        const builder = makeQueryBuilder(table);
        // Fallback so callers that do `query(table).collect()` directly
        // (no `.withIndex(...)`) get the full table.
        const wrapped = {
          ...builder,
          async collect() {
            return rowsForTable(table);
          },
        };
        // Preserve `.withIndex` returning the predicate-aware builder.
        return new Proxy(builder, {
          get(target, prop) {
            if (prop === "collect" && !("__sealed" in target)) {
              // If no `.withIndex` was chained yet, fall back to the
              // whole-table scan; otherwise the index-built collect.
              return target.collect.bind(target);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target as any)[prop];
          },
        }) as unknown as ReturnType<typeof makeQueryBuilder> &
          typeof wrapped;
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "reconciliationRuns") {
          const id = `reconciliationRuns:${nextId++}`;
          runs.set(id, {
            _id: id,
            _creationTime: Date.now(),
            ...row,
          } as ReconciliationRunFixture);
          return id;
        }
        return `${table}:?`;
      }),
    },
  };
  void makeFullScan;

  return { payments, allocations, contracts, installments, runs, ctx };
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

function makePayment(
  id: string,
  overrides: Partial<PaymentFixture> = {},
): PaymentFixture {
  return {
    _id: id,
    _creationTime: T0,
    paymentNumber: id.replace("payments:", "OR-"),
    amountCents: 10_000_00,
    isVoided: false,
    ...overrides,
  };
}

function makeAllocation(
  id: string,
  overrides: Partial<AllocationFixture> & {
    paymentId: string;
    targetType: AllocationFixture["targetType"];
    targetId: string;
    amountCents: number;
  },
): AllocationFixture {
  return {
    _id: id,
    _creationTime: T0,
    sequence: 0,
    ...overrides,
  };
}

function makeContract(
  id: string,
  overrides: Partial<ContractFixture> = {},
): ContractFixture {
  return {
    _id: id,
    _creationTime: T0,
    contractNumber: id.replace("contracts:", "C-"),
    totalPriceCents: 100_000_00,
    state: "active",
    ...overrides,
  };
}

function makeInstallment(
  id: string,
  overrides: Partial<InstallmentFixture> & { contractId: string },
): InstallmentFixture {
  return {
    _id: id,
    _creationTime: T0,
    installmentNumber: 1,
    principalCents: 10_000_00,
    paidCents: 0,
    status: "pending",
    dueDate: T0 + 30 * 24 * 60 * 60 * 1000,
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

// =====================================================================
// Invariant 1: payments_match_allocations
// =====================================================================

describe("internal_runReconciliationCheck — payments_match_allocations", () => {
  const run = handlerOf(internal_runReconciliationCheck);

  it("clean fixture: 5 payments with matching allocations → status ok, zero mismatches", async () => {
    const payments = [
      makePayment("payments:1", { amountCents: 5_000_00 }),
      makePayment("payments:2", { amountCents: 3_000_00 }),
      makePayment("payments:3", { amountCents: 7_500_00 }),
      makePayment("payments:4", { amountCents: 1_200_00 }),
      makePayment("payments:5", { amountCents: 8_888_00 }),
    ];
    const allocations: AllocationFixture[] = payments.flatMap((p, i) => [
      makeAllocation(`allocations:${i}-a`, {
        paymentId: p._id,
        targetType: "contract",
        targetId: `contracts:${i}`,
        amountCents: p.amountCents,
      }),
    ]);
    const bag = makeCtx({ payments, allocations });
    await run(bag.ctx, {
      checkType: "payments_match_allocations",
      triggeredBy: "manual",
    });
    expect(bag.runs.size).toBe(1);
    const row = Array.from(bag.runs.values())[0]!;
    expect(row.status).toBe("ok");
    expect(row.checkType).toBe("payments_match_allocations");
    expect(
      (row.summary as { checked: number; mismatches: number }).checked,
    ).toBe(5);
    expect(
      (row.summary as { mismatches: number }).mismatches,
    ).toBe(0);
  });

  it("DELIBERATE DIVERGENCE (AC4): payment.amountCents=10000.00 but allocations sum=8000.00 → status fail, mismatches=1, delta=-2000.00", async () => {
    const payment = makePayment("payments:1", { amountCents: 10_000_00 });
    const allocations = [
      makeAllocation("allocations:1", {
        paymentId: payment._id,
        targetType: "contract",
        targetId: "contracts:1",
        amountCents: 8_000_00,
      }),
    ];
    const bag = makeCtx({ payments: [payment], allocations });
    await run(bag.ctx, {
      checkType: "payments_match_allocations",
      triggeredBy: "manual",
    });
    const row = Array.from(bag.runs.values())[0]!;
    expect(row.status).toBe("fail");
    const summary = row.summary as {
      checked: number;
      mismatches: number;
      discrepancies: Array<{
        paymentId: string;
        expectedCents: number;
        actualCents: number;
        deltaCents: number;
      }>;
    };
    expect(summary.checked).toBe(1);
    expect(summary.mismatches).toBe(1);
    expect(summary.discrepancies).toHaveLength(1);
    expect(summary.discrepancies[0]!.paymentId).toBe("payments:1");
    expect(summary.discrepancies[0]!.expectedCents).toBe(10_000_00);
    expect(summary.discrepancies[0]!.actualCents).toBe(8_000_00);
    expect(summary.discrepancies[0]!.deltaCents).toBe(-2_000_00);
  });

  it("over-allocated payment: allocation sum > payment.amountCents also fails (positive delta)", async () => {
    const payment = makePayment("payments:1", { amountCents: 5_000_00 });
    const allocations = [
      makeAllocation("allocations:1", {
        paymentId: payment._id,
        targetType: "contract",
        targetId: "contracts:1",
        amountCents: 5_500_00,
      }),
    ];
    const bag = makeCtx({ payments: [payment], allocations });
    await run(bag.ctx, {
      checkType: "payments_match_allocations",
      triggeredBy: "manual",
    });
    const row = Array.from(bag.runs.values())[0]!;
    expect(row.status).toBe("fail");
    const summary = row.summary as {
      mismatches: number;
      discrepancies: Array<{ deltaCents: number }>;
    };
    expect(summary.mismatches).toBe(1);
    expect(summary.discrepancies[0]!.deltaCents).toBe(500_00);
  });

  it("voided payments are excluded from the check entirely (no false positive)", async () => {
    const payments = [
      makePayment("payments:1", { amountCents: 1_000_00, isVoided: true }),
      makePayment("payments:2", { amountCents: 2_000_00, isVoided: false }),
    ];
    // payments:1 has NO allocations (e.g. cleaned up by some unrelated path)
    // — but because it's voided, the check skips it.
    const allocations = [
      makeAllocation("allocations:1", {
        paymentId: "payments:2",
        targetType: "contract",
        targetId: "contracts:1",
        amountCents: 2_000_00,
      }),
    ];
    const bag = makeCtx({ payments, allocations });
    await run(bag.ctx, {
      checkType: "payments_match_allocations",
      triggeredBy: "manual",
    });
    const row = Array.from(bag.runs.values())[0]!;
    expect(row.status).toBe("ok");
    const summary = row.summary as { checked: number; mismatches: number };
    // Only the non-voided payment is counted.
    expect(summary.checked).toBe(1);
    expect(summary.mismatches).toBe(0);
  });
});

// =====================================================================
// Invariant 2: contract_total_ok
// =====================================================================

describe("internal_runReconciliationCheck — contract_total_ok", () => {
  const run = handlerOf(internal_runReconciliationCheck);

  it("clean fixture: contract with allocations summing exactly to totalPriceCents → ok", async () => {
    const contract = makeContract("contracts:1", { totalPriceCents: 50_000_00 });
    const payments = [
      makePayment("payments:1", { amountCents: 50_000_00 }),
    ];
    const allocations = [
      makeAllocation("allocations:1", {
        paymentId: "payments:1",
        targetType: "contract",
        targetId: contract._id,
        amountCents: 50_000_00,
      }),
    ];
    const bag = makeCtx({
      contracts: [contract],
      payments,
      allocations,
    });
    await run(bag.ctx, {
      checkType: "contract_total_ok",
      triggeredBy: "manual",
    });
    const row = Array.from(bag.runs.values())[0]!;
    expect(row.status).toBe("ok");
    const summary = row.summary as { checked: number; mismatches: number };
    expect(summary.checked).toBe(1);
    expect(summary.mismatches).toBe(0);
  });

  it("over-applied contract: allocations sum > totalPriceCents → fail (discrepancy with overByCents)", async () => {
    const contract = makeContract("contracts:1", { totalPriceCents: 40_000_00 });
    const payments = [
      makePayment("payments:1", { amountCents: 25_000_00 }),
      makePayment("payments:2", { amountCents: 25_000_00 }),
    ];
    const allocations = [
      makeAllocation("allocations:1", {
        paymentId: "payments:1",
        targetType: "contract",
        targetId: contract._id,
        amountCents: 25_000_00,
      }),
      makeAllocation("allocations:2", {
        paymentId: "payments:2",
        targetType: "contract",
        targetId: contract._id,
        amountCents: 25_000_00,
      }),
    ];
    const bag = makeCtx({
      contracts: [contract],
      payments,
      allocations,
    });
    await run(bag.ctx, {
      checkType: "contract_total_ok",
      triggeredBy: "manual",
    });
    const row = Array.from(bag.runs.values())[0]!;
    expect(row.status).toBe("fail");
    const summary = row.summary as {
      mismatches: number;
      discrepancies: Array<{
        contractId: string;
        totalPriceCents: number;
        appliedCents: number;
        overByCents: number;
      }>;
    };
    expect(summary.mismatches).toBe(1);
    expect(summary.discrepancies[0]!.contractId).toBe("contracts:1");
    expect(summary.discrepancies[0]!.totalPriceCents).toBe(40_000_00);
    expect(summary.discrepancies[0]!.appliedCents).toBe(50_000_00);
    expect(summary.discrepancies[0]!.overByCents).toBe(10_000_00);
  });

  it("installment-targeted allocations count toward the contract total", async () => {
    const contract = makeContract("contracts:1", { totalPriceCents: 30_000_00 });
    const installment = makeInstallment("installments:1", {
      contractId: contract._id,
      principalCents: 30_000_00,
      paidCents: 0,
    });
    const payments = [makePayment("payments:1", { amountCents: 31_000_00 })];
    const allocations = [
      makeAllocation("allocations:1", {
        paymentId: "payments:1",
        targetType: "installment",
        targetId: installment._id,
        amountCents: 31_000_00,
      }),
    ];
    const bag = makeCtx({
      contracts: [contract],
      installments: [installment],
      payments,
      allocations,
    });
    await run(bag.ctx, {
      checkType: "contract_total_ok",
      triggeredBy: "manual",
    });
    const row = Array.from(bag.runs.values())[0]!;
    expect(row.status).toBe("fail");
    const summary = row.summary as {
      discrepancies: Array<{ overByCents: number }>;
    };
    expect(summary.discrepancies[0]!.overByCents).toBe(1_000_00);
  });

  it("DELIBERATE DIVERGENCE (AC4): installments claim 40,000.00 paid but allocations sum to only 30,000.00 → fail (under-recording, delta -10,000.00)", async () => {
    // The canonical Story 5.5 AC4 scenario: a contract whose installment
    // rows claim more paid than the allocation ledger accounts for — a
    // dropped payment / bad restore. The PRE-fix one-sided
    // `appliedCents > totalPriceCents` check was BLIND to this (30,000 <
    // 50,000 total, so it passed clean). The bidirectional 2b invariant
    // now catches it.
    const contract = makeContract("contracts:1", { totalPriceCents: 50_000_00 });
    const installment = makeInstallment("installments:1", {
      contractId: contract._id,
      principalCents: 50_000_00,
      paidCents: 40_000_00, // ledger CLAIMS 40k paid
    });
    const payments = [makePayment("payments:1", { amountCents: 30_000_00 })];
    const allocations = [
      // ...but only 30k of allocations actually back it.
      makeAllocation("allocations:1", {
        paymentId: "payments:1",
        targetType: "installment",
        targetId: installment._id,
        amountCents: 30_000_00,
      }),
    ];
    const bag = makeCtx({
      contracts: [contract],
      installments: [installment],
      payments,
      allocations,
    });
    await run(bag.ctx, {
      checkType: "contract_total_ok",
      triggeredBy: "manual",
    });
    const row = Array.from(bag.runs.values())[0]!;
    expect(row.status).toBe("fail");
    const summary = row.summary as {
      mismatches: number;
      discrepancies: Array<{
        kind: string;
        installmentPaidCents: number;
        installmentAllocCents: number;
        deltaCents: number;
      }>;
    };
    expect(summary.mismatches).toBe(1);
    const under = summary.discrepancies.find(
      (d) => d.kind === "installment_paid_vs_allocations",
    )!;
    expect(under.installmentPaidCents).toBe(40_000_00);
    expect(under.installmentAllocCents).toBe(30_000_00);
    expect(under.deltaCents).toBe(-10_000_00);
  });

  it("voided-payment allocations are excluded from the contract total sum", async () => {
    const contract = makeContract("contracts:1", { totalPriceCents: 20_000_00 });
    const payments = [
      makePayment("payments:1", { amountCents: 15_000_00, isVoided: false }),
      makePayment("payments:2", { amountCents: 50_000_00, isVoided: true }),
    ];
    const allocations = [
      makeAllocation("allocations:1", {
        paymentId: "payments:1",
        targetType: "contract",
        targetId: contract._id,
        amountCents: 15_000_00,
      }),
      // This allocation's payment is voided; should NOT count.
      makeAllocation("allocations:2", {
        paymentId: "payments:2",
        targetType: "contract",
        targetId: contract._id,
        amountCents: 50_000_00,
      }),
    ];
    const bag = makeCtx({
      contracts: [contract],
      payments,
      allocations,
    });
    await run(bag.ctx, {
      checkType: "contract_total_ok",
      triggeredBy: "manual",
    });
    const row = Array.from(bag.runs.values())[0]!;
    expect(row.status).toBe("ok");
    const summary = row.summary as { mismatches: number };
    expect(summary.mismatches).toBe(0);
  });
});

// =====================================================================
// Invariant 3: installment_paid_bounded
// =====================================================================

describe("internal_runReconciliationCheck — installment_paid_bounded", () => {
  const run = handlerOf(internal_runReconciliationCheck);

  it("clean fixture: every installment paidCents <= principalCents → ok", async () => {
    const installments = [
      makeInstallment("installments:1", {
        contractId: "contracts:1",
        principalCents: 5_000_00,
        paidCents: 5_000_00,
      }),
      makeInstallment("installments:2", {
        contractId: "contracts:1",
        principalCents: 5_000_00,
        paidCents: 2_500_00,
      }),
      makeInstallment("installments:3", {
        contractId: "contracts:1",
        principalCents: 5_000_00,
        paidCents: 0,
      }),
    ];
    const bag = makeCtx({ installments });
    await run(bag.ctx, {
      checkType: "installment_paid_bounded",
      triggeredBy: "manual",
    });
    const row = Array.from(bag.runs.values())[0]!;
    expect(row.status).toBe("ok");
    const summary = row.summary as { checked: number; mismatches: number };
    expect(summary.checked).toBe(3);
    expect(summary.mismatches).toBe(0);
  });

  it("DELIBERATE DIVERGENCE: installment with paidCents > principalCents → fail with overByCents", async () => {
    const installments = [
      makeInstallment("installments:1", {
        contractId: "contracts:1",
        principalCents: 5_000_00,
        paidCents: 6_000_00, // over-payment by 1,000.00
      }),
      makeInstallment("installments:2", {
        contractId: "contracts:1",
        principalCents: 5_000_00,
        paidCents: 5_000_00, // clean
      }),
    ];
    const bag = makeCtx({ installments });
    await run(bag.ctx, {
      checkType: "installment_paid_bounded",
      triggeredBy: "manual",
    });
    const row = Array.from(bag.runs.values())[0]!;
    expect(row.status).toBe("fail");
    const summary = row.summary as {
      mismatches: number;
      discrepancies: Array<{
        installmentId: string;
        principalCents: number;
        paidCents: number;
        overByCents: number;
      }>;
    };
    expect(summary.mismatches).toBe(1);
    expect(summary.discrepancies[0]!.installmentId).toBe("installments:1");
    expect(summary.discrepancies[0]!.principalCents).toBe(5_000_00);
    expect(summary.discrepancies[0]!.paidCents).toBe(6_000_00);
    expect(summary.discrepancies[0]!.overByCents).toBe(1_000_00);
  });
});

// =====================================================================
// internal_runDailyReconciliation (cron body)
// =====================================================================

describe("internal_runDailyReconciliation — runs all three checks", () => {
  const run = handlerOf(internal_runDailyReconciliation);

  it("emits one reconciliationRuns row per checkType (3 total) on a clean ledger", async () => {
    const payment = makePayment("payments:1", { amountCents: 1_000_00 });
    const contract = makeContract("contracts:1", { totalPriceCents: 1_000_00 });
    const installment = makeInstallment("installments:1", {
      contractId: contract._id,
      principalCents: 1_000_00,
      paidCents: 1_000_00,
    });
    // Clean ledger: the paid installment is backed by a matching
    // installment-targeted allocation, so the paidCents (1,000.00) the
    // installment claims equals the non-voided allocation total — the
    // consistency invariant `contract_total_ok` now verifies (2b).
    const allocation = makeAllocation("allocations:1", {
      paymentId: payment._id,
      targetType: "installment",
      targetId: installment._id,
      amountCents: 1_000_00,
    });
    const bag = makeCtx({
      payments: [payment],
      contracts: [contract],
      allocations: [allocation],
      installments: [installment],
    });
    const result = (await run(bag.ctx, {})) as {
      paymentsMatchAllocations: { status: string; mismatches: number };
      contractTotalOk: { status: string; mismatches: number };
      installmentPaidBounded: { status: string; mismatches: number };
    };
    expect(result.paymentsMatchAllocations.status).toBe("ok");
    expect(result.contractTotalOk.status).toBe("ok");
    expect(result.installmentPaidBounded.status).toBe("ok");
    expect(bag.runs.size).toBe(3);
    const checkTypes = Array.from(bag.runs.values())
      .map((r) => r.checkType)
      .sort();
    expect(checkTypes).toEqual([
      "contract_total_ok",
      "installment_paid_bounded",
      "payments_match_allocations",
    ]);
  });

  it("records triggeredBy: 'cron' by default", async () => {
    const bag = makeCtx({});
    await run(bag.ctx, {});
    for (const r of bag.runs.values()) {
      expect(r.triggeredBy).toBe("cron");
    }
  });

  it("DELIBERATE DIVERGENCE end-to-end: a mismatched payment AND a mismatched installment both surface in the same run", async () => {
    const payments = [
      // Payment with allocations summing to less than amountCents.
      makePayment("payments:1", { amountCents: 10_000_00 }),
    ];
    const allocations = [
      makeAllocation("allocations:1", {
        paymentId: "payments:1",
        targetType: "contract",
        targetId: "contracts:1",
        amountCents: 7_000_00, // 3,000.00 short
      }),
    ];
    const contracts = [
      makeContract("contracts:1", { totalPriceCents: 10_000_00 }),
    ];
    const installments = [
      makeInstallment("installments:1", {
        contractId: "contracts:1",
        principalCents: 5_000_00,
        paidCents: 9_999_00, // over-paid by 4,999.00
      }),
    ];
    const bag = makeCtx({ payments, allocations, contracts, installments });
    const result = (await run(bag.ctx, {})) as {
      paymentsMatchAllocations: { status: string; mismatches: number };
      contractTotalOk: { status: string; mismatches: number };
      installmentPaidBounded: { status: string; mismatches: number };
    };
    expect(result.paymentsMatchAllocations.status).toBe("fail");
    expect(result.paymentsMatchAllocations.mismatches).toBe(1);
    expect(result.installmentPaidBounded.status).toBe("fail");
    expect(result.installmentPaidBounded.mismatches).toBe(1);
    // contract_total_ok ALSO surfaces the drift now (Epic 5 C1 fix): the
    // installment claims paidCents=9,999.00 but ZERO installment-targeted
    // allocations back it (the only allocation is contract-targeted at
    // 7,000.00), so the paid-vs-allocations consistency invariant (2b)
    // fails. Before the fix this returned "ok" — the exact blind spot
    // that gave false confidence on under-recorded money.
    expect(result.contractTotalOk.status).toBe("fail");
    expect(result.contractTotalOk.mismatches).toBe(1);
  });
});

// =====================================================================
// runReconciliationNow (admin escape hatch)
// =====================================================================

describe("runReconciliationNow — admin escape hatch", () => {
  const run = handlerOf(runReconciliationNow);

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

  it("admin: records all three runs with triggeredBy: 'manual'", async () => {
    const bag = makeCtx({ roles: ["admin"] });
    await run(bag.ctx, {});
    expect(bag.runs.size).toBe(3);
    for (const r of bag.runs.values()) {
      expect(r.triggeredBy).toBe("manual");
      expect(r.status).toBe("ok");
    }
  });
});

// =====================================================================
// getLatestReconciliation (public read)
// =====================================================================

describe("getLatestReconciliation — public read query", () => {
  const run = handlerOf(getLatestReconciliation);

  it("rejects office_staff with FORBIDDEN (admin-only diagnostics)", async () => {
    const bag = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(bag.ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("returns null for every checkType when no runs exist", async () => {
    const bag = makeCtx({ roles: ["admin"] });
    const result = (await run(bag.ctx, {})) as {
      paymentsMatchAllocations: ReconciliationRunFixture | null;
      contractTotalOk: ReconciliationRunFixture | null;
      installmentPaidBounded: ReconciliationRunFixture | null;
    };
    expect(result.paymentsMatchAllocations).toBeNull();
    expect(result.contractTotalOk).toBeNull();
    expect(result.installmentPaidBounded).toBeNull();
  });

  it("returns the most-recent row per checkType", async () => {
    const runs: ReconciliationRunFixture[] = [
      {
        _id: "reconciliationRuns:1",
        _creationTime: T0,
        runAt: T0 - 2 * 24 * HOUR_MS,
        checkType: "payments_match_allocations",
        status: "ok",
        summary: { checked: 10, mismatches: 0 },
        triggeredBy: "cron",
      },
      {
        _id: "reconciliationRuns:2",
        _creationTime: T0,
        runAt: T0 - 1 * 24 * HOUR_MS,
        checkType: "payments_match_allocations",
        status: "fail",
        summary: { checked: 12, mismatches: 1 },
        triggeredBy: "cron",
      },
      {
        _id: "reconciliationRuns:3",
        _creationTime: T0,
        runAt: T0 - 1 * 24 * HOUR_MS,
        checkType: "contract_total_ok",
        status: "ok",
        summary: { checked: 5, mismatches: 0 },
        triggeredBy: "cron",
      },
    ];
    const bag = makeCtx({ roles: ["admin"], runs });
    const result = (await run(bag.ctx, {})) as {
      paymentsMatchAllocations: ReconciliationRunFixture | null;
      contractTotalOk: ReconciliationRunFixture | null;
      installmentPaidBounded: ReconciliationRunFixture | null;
    };
    expect(result.paymentsMatchAllocations).not.toBeNull();
    // Most recent payments_match_allocations is the FAIL row.
    expect(result.paymentsMatchAllocations!.status).toBe("fail");
    expect(result.contractTotalOk).not.toBeNull();
    expect(result.contractTotalOk!.status).toBe("ok");
    expect(result.installmentPaidBounded).toBeNull();
  });
});
