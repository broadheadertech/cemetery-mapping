/**
 * Story 3.5 — discount payload tests for `convex/contracts.ts`.
 *
 * Targets the invariants enforced by `normalizeDiscountInputs` (the
 * file-local helper) AND the contract-row + audit emissions that flow
 * from the public `recordFullPaymentSale` mutation. Mirrors the
 * mocking strategy of `contracts.test.ts` (Story 3.3) — `convex-test`
 * is unavailable because this repo deliberately avoids `_generated/`.
 *
 * Coverage:
 *   - Happy path: discount fields persisted on contract + audit row.
 *   - No-discount default path: base = total, discount = 0, no
 *     reason stamped.
 *   - Validation: discount > base → INVARIANT_VIOLATION; no writes.
 *   - Validation: base − discount ≠ total → INVARIANT_VIOLATION.
 *   - Validation: discount > 0 with no reason → VALIDATION.
 *   - Validation: discount > 0 with short reason → VALIDATION.
 *   - Validation: reason without discount → VALIDATION.
 *   - Validation: negative discount → VALIDATION.
 *
 * Why a separate file: keeps the Story 3.3 / 3.6 test surface stable
 * and groups the FR22 invariants in one place for future audits.
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
import { recordFullPaymentSale } from "../../../convex/contracts";

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
  status:
    | "available"
    | "reserved"
    | "sold"
    | "occupied"
    | "cancelled"
    | "defaulted"
    | "transferred";
  basePriceCents: number;
  isRetired: boolean;
}

interface CustomerFixture {
  _id: string;
  _creationTime: number;
  fullName: string;
  govIdNumber: string;
  address: { line1: string };
}

interface ContractFixture {
  _id: string;
  _creationTime: number;
  contractNumber: string;
  lotId: string;
  customerId: string;
  kind: "full_payment" | "installment";
  totalPriceCents: number;
  state:
    | "active"
    | "paid_in_full"
    | "cancelled"
    | "voided"
    | "in_default";
  createdAt: number;
  createdBy: string;
  paymentId?: string;
  receiptId?: string;
  basePriceCents?: number;
  discountCents?: number;
  discountReason?: string;
}

interface ReceiptCounterFixture {
  _id: string;
  _creationTime: number;
  currentSerial: number;
  startingSerial: number;
  prefix: string;
  seededAt: number;
}

interface CtxBag {
  lots: Map<string, LotFixture>;
  customers: Map<string, CustomerFixture>;
  contracts: Map<string, ContractFixture>;
  payments: Map<string, Record<string, unknown>>;
  receipts: Map<string, Record<string, unknown>>;
  paymentAllocations: Map<string, Record<string, unknown>>;
  receiptCounters: Map<string, ReceiptCounterFixture>;
  auditInserts: Array<{ row: Record<string, unknown> }>;
  patches: Array<{ id: string; patch: Record<string, unknown> }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  initialLots?: LotFixture[];
  initialCustomers?: CustomerFixture[];
  authenticated?: boolean;
}): CtxBag {
  const lots = new Map<string, LotFixture>(
    (opts.initialLots ?? []).map((l) => [l._id, l]),
  );
  const customers = new Map<string, CustomerFixture>(
    (opts.initialCustomers ?? []).map((c) => [c._id, c]),
  );
  const contracts = new Map<string, ContractFixture>();
  const payments = new Map<string, Record<string, unknown>>();
  const receipts = new Map<string, Record<string, unknown>>();
  const paymentAllocations = new Map<string, Record<string, unknown>>();
  const receiptCounters = new Map<string, ReceiptCounterFixture>();
  receiptCounters.set("receiptCounter:1", {
    _id: "receiptCounter:1",
    _creationTime: T0 - 1000,
    currentSerial: 100,
    startingSerial: 1,
    prefix: "OR-",
    seededAt: T0 - 1000,
  });
  const auditInserts: Array<{ row: Record<string, unknown> }> = [];
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
    email: "office@example.com",
    isActive: true,
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

  let nextId = 1;

  function makeQueryBuilder(table: string) {
    type Predicate = (r: Record<string, unknown>) => boolean;
    const predicates: Predicate[] = [];

    const builder = {
      withIndex(_n: string, fn: (q: IndexQuery) => IndexQuery) {
        const q: IndexQuery = {
          eqs: {},
          eq(field: string, value: unknown) {
            this.eqs[field] = value;
            return this;
          },
        };
        fn(q);
        for (const [field, value] of Object.entries(q.eqs)) {
          predicates.push((r) => (r as Record<string, unknown>)[field] === value);
        }
        return builder;
      },
      async first(): Promise<Record<string, unknown> | null> {
        for (const row of rowsForTable(table)) {
          if (predicates.every((p) => p(row))) return row;
        }
        return null;
      },
      async unique(): Promise<Record<string, unknown> | null> {
        const matches = rowsForTable(table).filter((r) =>
          predicates.every((p) => p(r)),
        );
        if (matches.length === 0) return null;
        if (matches.length > 1) {
          throw new Error(`unique() found ${matches.length} rows in ${table}`);
        }
        return matches[0] ?? null;
      },
      async collect(): Promise<Record<string, unknown>[]> {
        return rowsForTable(table).filter((r) =>
          predicates.every((p) => p(r)),
        );
      },
    };
    return builder;
  }

  function rowsForTable(table: string): Record<string, unknown>[] {
    if (table === "lots") return Array.from(lots.values()) as unknown as Record<string, unknown>[];
    if (table === "customers") return Array.from(customers.values()) as unknown as Record<string, unknown>[];
    if (table === "contracts") return Array.from(contracts.values()) as unknown as Record<string, unknown>[];
    if (table === "payments") return Array.from(payments.values()) as unknown as Record<string, unknown>[];
    if (table === "receipts") return Array.from(receipts.values()) as unknown as Record<string, unknown>[];
    if (table === "paymentAllocations") {
      return Array.from(paymentAllocations.values()) as unknown as Record<string, unknown>[];
    }
    if (table === "receiptCounter") {
      return Array.from(receiptCounters.values()) as unknown as Record<string, unknown>[];
    }
    return [];
  }

  interface IndexQuery {
    eqs: Record<string, unknown>;
    eq(field: string, value: unknown): IndexQuery;
  }

  function tableQuery(table: string) {
    if (table === "userRoles") {
      return {
        withIndex: () => ({
          collect: async () => userRoles,
        }),
      };
    }
    if (table === "receiptCounter") {
      return {
        withIndex: (_n: string, _f: unknown) => ({
          first: async (): Promise<Record<string, unknown> | null> => {
            const r = receiptCounters.get("receiptCounter:1");
            return r !== undefined ? (r as unknown as Record<string, unknown>) : null;
          },
        }),
        first: async (): Promise<Record<string, unknown> | null> => {
          const r = receiptCounters.get("receiptCounter:1");
          return r !== undefined ? (r as unknown as Record<string, unknown>) : null;
        },
        async collect() {
          return Array.from(receiptCounters.values()) as unknown as Record<string, unknown>[];
        },
      };
    }
    return makeQueryBuilder(table);
  }

  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === USER_ID) return user;
        if (id === SESSION_ID) return session;
        if (lots.has(id)) return lots.get(id);
        if (customers.has(id)) return customers.get(id);
        if (contracts.has(id)) return contracts.get(id);
        if (payments.has(id)) return payments.get(id);
        if (receipts.has(id)) return receipts.get(id);
        if (receiptCounters.has(id)) return receiptCounters.get(id);
        return null;
      }),
      query: vi.fn((table: string) => tableQuery(table)),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "contracts") {
          const id = `contracts:${nextId++}`;
          contracts.set(id, {
            _id: id,
            _creationTime: T0,
            ...row,
          } as ContractFixture);
          return id;
        }
        if (table === "payments") {
          const id = `payments:${nextId++}`;
          payments.set(id, { _id: id, _creationTime: T0, ...row });
          return id;
        }
        if (table === "receipts") {
          const id = `receipts:${nextId++}`;
          receipts.set(id, { _id: id, _creationTime: T0, ...row });
          return id;
        }
        if (table === "paymentAllocations") {
          const id = `paymentAllocations:${nextId++}`;
          paymentAllocations.set(id, {
            _id: id,
            _creationTime: T0,
            ...row,
          });
          return id;
        }
        if (table === "auditLog") {
          auditInserts.push({ row });
          return `auditLog:${auditInserts.length}`;
        }
        return `${table}:?`;
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        patches.push({ id, patch });
        if (lots.has(id)) {
          const existing = lots.get(id)!;
          lots.set(id, { ...existing, ...patch } as LotFixture);
        } else if (contracts.has(id)) {
          const existing = contracts.get(id)!;
          contracts.set(id, { ...existing, ...patch } as ContractFixture);
        } else if (receiptCounters.has(id)) {
          const existing = receiptCounters.get(id)!;
          receiptCounters.set(id, { ...existing, ...patch } as ReceiptCounterFixture);
        }
      }),
    },
  };

  return {
    lots,
    customers,
    contracts,
    payments,
    receipts,
    paymentAllocations,
    receiptCounters,
    auditInserts,
    patches,
    ctx,
  };
}

function makeLot(overrides: Partial<LotFixture> = {}): LotFixture {
  return {
    _id: overrides._id ?? "lots:1",
    _creationTime: T0,
    code: "D-5-12",
    section: "D",
    block: "5",
    row: "12",
    status: "available",
    basePriceCents: 150_000_00,
    isRetired: false,
    ...overrides,
  };
}

function makeCustomer(overrides: Partial<CustomerFixture> = {}): CustomerFixture {
  return {
    _id: overrides._id ?? "customers:1",
    _creationTime: T0,
    fullName: "Juan Dela Cruz",
    govIdNumber: "1234-5678-9012",
    address: { line1: "123 Main St" },
    ...overrides,
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

describe("recordFullPaymentSale — discount payload (Story 3.5 / FR22)", () => {
  const run = handlerOf(recordFullPaymentSale);

  function baseArgs(
    overrides: Partial<{
      lotId: string;
      customerId: string;
      totalPriceCents: number;
      method: "cash" | "check" | "bank_transfer";
      reference?: string;
      paidAt: number;
      idempotencyKey: string;
      basePriceCents?: number;
      discountCents?: number;
      discountReason?: string;
    }> = {},
  ) {
    return {
      lotId: "lots:1",
      customerId: "customers:1",
      totalPriceCents: 150_000_00,
      method: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-abc-discount",
      ...overrides,
    };
  }

  it("persists base, discount, and reason on the contract row + audit when a discount is applied", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });

    const result = (await run(
      bag.ctx,
      baseArgs({
        totalPriceCents: 135_000_00,
        basePriceCents: 150_000_00,
        discountCents: 15_000_00,
        discountReason: "Family loyalty — 3rd contract",
      }),
    )) as { contractId: string };

    const contract = bag.contracts.get(result.contractId)!;
    expect(contract.totalPriceCents).toBe(135_000_00);
    expect(contract.basePriceCents).toBe(150_000_00);
    expect(contract.discountCents).toBe(15_000_00);
    expect(contract.discountReason).toBe("Family loyalty — 3rd contract");

    const contractAudit = bag.auditInserts.find(
      (a) => (a.row as { entityType?: string }).entityType === "contract",
    )!;
    expect((contractAudit.row as { after: Record<string, unknown> }).after).toMatchObject({
      basePriceCents: 150_000_00,
      discountCents: 15_000_00,
      discountReason: "Family loyalty — 3rd contract",
    });
  });

  it("trims whitespace from the discount reason before persisting", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });

    const result = (await run(
      bag.ctx,
      baseArgs({
        totalPriceCents: 100_000_00,
        basePriceCents: 150_000_00,
        discountCents: 50_000_00,
        discountReason: "   Manager override per call   ",
      }),
    )) as { contractId: string };

    const contract = bag.contracts.get(result.contractId)!;
    expect(contract.discountReason).toBe("Manager override per call");
  });

  it("defaults to base=total, discount=0, no reason when no discount fields are supplied", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });

    const result = (await run(bag.ctx, baseArgs())) as { contractId: string };
    const contract = bag.contracts.get(result.contractId)!;
    expect(contract.basePriceCents).toBe(150_000_00);
    expect(contract.discountCents).toBe(0);
    expect(contract.discountReason).toBeUndefined();
  });

  it("rejects discountCents > basePriceCents with INVARIANT_VIOLATION and writes nothing", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });
    const thrown = await run(
      bag.ctx,
      baseArgs({
        totalPriceCents: 50_000_00,
        basePriceCents: 150_000_00,
        discountCents: 200_000_00,
        discountReason: "Should be rejected before any write",
      }),
    ).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(bag.contracts.size).toBe(0);
    expect(bag.payments.size).toBe(0);
    expect(bag.receipts.size).toBe(0);
  });

  it("rejects when base − discount ≠ total with INVARIANT_VIOLATION", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });
    const thrown = await run(
      bag.ctx,
      baseArgs({
        totalPriceCents: 130_000_00,
        basePriceCents: 150_000_00,
        discountCents: 15_000_00, // 150k − 15k = 135k, not 130k
        discountReason: "Math drift",
      }),
    ).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(bag.contracts.size).toBe(0);
  });

  it("rejects negative discountCents with VALIDATION", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });
    const thrown = await run(
      bag.ctx,
      baseArgs({
        totalPriceCents: 150_000_00,
        basePriceCents: 150_000_00,
        discountCents: -100,
        discountReason: "Should reject",
      }),
    ).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects discount > 0 without a reason (VALIDATION)", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });
    const thrown = await run(
      bag.ctx,
      baseArgs({
        totalPriceCents: 145_000_00,
        basePriceCents: 150_000_00,
        discountCents: 5_000_00,
      }),
    ).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects discount > 0 with a reason shorter than 5 chars (VALIDATION)", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });
    const thrown = await run(
      bag.ctx,
      baseArgs({
        totalPriceCents: 145_000_00,
        basePriceCents: 150_000_00,
        discountCents: 5_000_00,
        discountReason: "ok",
      }),
    ).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects a reason without a discount (VALIDATION)", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });
    const thrown = await run(
      bag.ctx,
      baseArgs({
        totalPriceCents: 150_000_00,
        basePriceCents: 150_000_00,
        discountCents: 0,
        discountReason: "Stray reason without any discount applied",
      }),
    ).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects discount reason longer than 280 chars (VALIDATION)", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });
    const overlong = "x".repeat(281);
    const thrown = await run(
      bag.ctx,
      baseArgs({
        totalPriceCents: 145_000_00,
        basePriceCents: 150_000_00,
        discountCents: 5_000_00,
        discountReason: overlong,
      }),
    ).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });
});
