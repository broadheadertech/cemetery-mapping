/**
 * Story 3.3 — `convex/contracts.ts` unit tests.
 *
 * Coverage target: ≥ 90% (NFR-M2 — `recordFullPaymentSale` is the
 * primary public consumer of the postFinancialEvent cornerstone and is
 * financial code).
 *
 * Strategy: hand-mocked ctx (same pattern as `lots.test.ts` /
 * `customers.test.ts`). We import the public Convex functions and pull
 * their `handler` out so we can call them directly without spinning up
 * Convex's runtime — `convex-test` requires `_generated/` which this
 * repo deliberately avoids.
 *
 * The mock supports the tables `recordFullPaymentSale` touches:
 *   - `lots` (read + status patch via transitionLotStatus)
 *   - `customers` (read)
 *   - `contracts` (insert + patch)
 *   - `payments` (insert via the cornerstone)
 *   - `receipts` (insert via the cornerstone)
 *   - `paymentAllocations` (insert via the cornerstone)
 *   - `receiptCounter` (read + patch via allocateNextSerial)
 *   - `auditLog` (insert via emitAudit + transition)
 *   - `userRoles` (read for the auth helper)
 *   - `users` / `authSessions` (read for the auth helper)
 *
 * Tests cover:
 *   - Happy path: contract row inserted, lot transitioned to sold,
 *     payment + receipt + allocation + audit emitted, return shape.
 *   - Role gating: field_worker FORBIDDEN.
 *   - Unauthenticated rejected.
 *   - Lot not available → INVARIANT_VIOLATION.
 *   - Customer missing → NOT_FOUND.
 *   - Price zero / negative → VALIDATION.
 *   - Non-cash without reference → VALIDATION.
 *   - `listContracts` filters by state.
 *   - `getContract` hydrates lot + customer + receipt.
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
  getContract,
  listContracts,
  recordFullPaymentSale,
  transitionState,
} from "../../../convex/contracts";

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
  initialContracts?: ContractFixture[];
  authenticated?: boolean;
  seedCounter?: boolean;
}): CtxBag {
  const lots = new Map<string, LotFixture>(
    (opts.initialLots ?? []).map((l) => [l._id, l]),
  );
  const customers = new Map<string, CustomerFixture>(
    (opts.initialCustomers ?? []).map((c) => [c._id, c]),
  );
  const contracts = new Map<string, ContractFixture>(
    (opts.initialContracts ?? []).map((c) => [c._id, c]),
  );
  const payments = new Map<string, Record<string, unknown>>();
  const receipts = new Map<string, Record<string, unknown>>();
  const paymentAllocations = new Map<string, Record<string, unknown>>();
  const receiptCounters = new Map<string, ReceiptCounterFixture>();
  if (opts.seedCounter !== false) {
    receiptCounters.set("receiptCounter:1", {
      _id: "receiptCounter:1",
      _creationTime: T0 - 1000,
      currentSerial: 100,
      startingSerial: 1,
      prefix: "OR-",
      seededAt: T0 - 1000,
    });
  }
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
      withIndex(_indexName: string, fn: (q: IndexQuery) => IndexQuery) {
        const q: IndexQuery = {
          eqs: {},
          ranges: [],
          eq(field: string, value: unknown) {
            this.eqs[field] = value;
            return this;
          },
          gte(field: string, value: number) {
            this.ranges.push({ field, op: "gte", value });
            return this;
          },
          lte(field: string, value: number) {
            this.ranges.push({ field, op: "lte", value });
            return this;
          },
        };
        fn(q);
        for (const [field, value] of Object.entries(q.eqs)) {
          predicates.push((r) => readDottedField(r, field) === value);
        }
        for (const range of q.ranges) {
          if (range.op === "gte") {
            predicates.push((r) => {
              const v = readDottedField(r, range.field);
              return typeof v === "number" && v >= range.value;
            });
          } else {
            predicates.push((r) => {
              const v = readDottedField(r, range.field);
              return typeof v === "number" && v <= range.value;
            });
          }
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

  function readDottedField(
    row: Record<string, unknown>,
    path: string,
  ): unknown {
    let cur: unknown = row;
    for (const part of path.split(".")) {
      if (cur === null || typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
  }

  interface IndexRange {
    field: string;
    op: "gte" | "lte";
    value: number;
  }

  interface IndexQuery {
    eqs: Record<string, unknown>;
    ranges: IndexRange[];
    eq(field: string, value: unknown): IndexQuery;
    gte(field: string, value: number): IndexQuery;
    lte(field: string, value: number): IndexQuery;
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
      // The receipt-counter helper reads via `query("receiptCounter").first()`
      // — no index needed.
      return {
        withIndex: (_n: string, _f: unknown) => ({
          first: async (): Promise<Record<string, unknown> | null> => {
            const row = receiptCounters.get("receiptCounter:1");
            return row !== undefined ? (row as unknown as Record<string, unknown>) : null;
          },
        }),
        first: async (): Promise<Record<string, unknown> | null> => {
          const row = receiptCounters.get("receiptCounter:1");
          return row !== undefined ? (row as unknown as Record<string, unknown>) : null;
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
        if (table === "receiptCounter") {
          const id = `receiptCounter:${nextId++}`;
          receiptCounters.set(id, {
            _id: id,
            _creationTime: T0,
            ...row,
          } as ReceiptCounterFixture);
          return id;
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
          receiptCounters.set(id, {
            ...existing,
            ...patch,
          } as ReceiptCounterFixture);
        } else if (payments.has(id)) {
          const existing = payments.get(id)!;
          payments.set(id, { ...existing, ...patch });
        } else if (receipts.has(id)) {
          const existing = receipts.get(id)!;
          receipts.set(id, { ...existing, ...patch });
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

describe("recordFullPaymentSale", () => {
  const run = handlerOf(recordFullPaymentSale);

  function validArgs(
    overrides: Partial<{
      lotId: string;
      customerId: string;
      totalPriceCents: number;
      method: "cash" | "check" | "bank_transfer";
      reference?: string;
      paidAt: number;
      idempotencyKey: string;
    }> = {},
  ) {
    return {
      lotId: "lots:1",
      customerId: "customers:1",
      totalPriceCents: 150_000_00,
      method: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-abc-123",
      ...overrides,
    };
  }

  it("records a full-payment sale end-to-end (happy path)", async () => {
    const lot = makeLot({ _id: "lots:1" });
    const customer = makeCustomer({ _id: "customers:1" });
    const bag = makeCtx({
      roles: ["office_staff"],
      initialLots: [lot],
      initialCustomers: [customer],
    });

    const result = (await run(bag.ctx, validArgs())) as {
      contractId: string;
      contractNumber: string;
      paymentId: string;
      receiptId: string;
      receiptNumber: string;
    };

    // Contract row inserted in state paid_in_full with back-pointers
    expect(bag.contracts.size).toBe(1);
    const contract = bag.contracts.get(result.contractId)!;
    expect(contract.state).toBe("paid_in_full");
    expect(contract.kind).toBe("full_payment");
    expect(contract.totalPriceCents).toBe(150_000_00);
    expect(contract.paymentId).toBe(result.paymentId);
    expect(contract.receiptId).toBe(result.receiptId);
    expect(contract.contractNumber).toBe(result.contractNumber);
    expect(contract.contractNumber).toMatch(/^CON-\d{8}-D-5-12-\d{4}$/);

    // Lot transitioned to sold
    expect(bag.lots.get("lots:1")!.status).toBe("sold");

    // One payment + one receipt + one allocation
    expect(bag.payments.size).toBe(1);
    expect(bag.receipts.size).toBe(1);
    expect(bag.paymentAllocations.size).toBe(1);
    const payment = Array.from(bag.payments.values())[0]!;
    expect(payment.amountCents).toBe(150_000_00);
    expect(payment.paymentMethod).toBe("cash");
    expect(payment.idempotencyKey).toBe("idem-abc-123");
    const receipt = Array.from(bag.receipts.values())[0]!;
    expect(receipt.receiptNumber).toBe(result.receiptNumber);
    expect(receipt.receiptSerial).toBe(101); // counter started at 100
    const allocation = Array.from(bag.paymentAllocations.values())[0]!;
    expect(allocation.targetType).toBe("contract");
    expect(allocation.targetId).toBe(result.contractId);
    expect(allocation.amountCents).toBe(150_000_00);

    // Audit rows: lot transition + receipt create + contract create
    const actions = bag.auditInserts.map((a) => ({
      action: a.row.action,
      entityType: a.row.entityType,
    }));
    expect(actions).toContainEqual({ action: "transition", entityType: "lot" });
    expect(actions).toContainEqual({
      action: "create",
      entityType: "receipt",
    });
    expect(actions).toContainEqual({
      action: "create",
      entityType: "contract",
    });
  });

  it("rejects field_worker callers with FORBIDDEN", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      roles: ["field_worker"],
      initialLots: [lot],
      initialCustomers: [customer],
    });
    const thrown = await run(bag.ctx, validArgs()).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      authenticated: false,
      initialLots: [lot],
      initialCustomers: [customer],
    });
    const thrown = await run(bag.ctx, validArgs()).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("rejects a non-available lot with INVARIANT_VIOLATION", async () => {
    const lot = makeLot({ status: "sold" });
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });
    const thrown = await run(bag.ctx, validArgs()).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(bag.contracts.size).toBe(0);
    expect(bag.payments.size).toBe(0);
  });

  it("rejects a retired lot with INVARIANT_VIOLATION", async () => {
    const lot = makeLot({ isRetired: true });
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });
    const thrown = await run(bag.ctx, validArgs()).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("rejects a missing lot with NOT_FOUND", async () => {
    const customer = makeCustomer();
    const bag = makeCtx({ initialCustomers: [customer] });
    const thrown = await run(
      bag.ctx,
      validArgs({ lotId: "lots:ghost" }),
    ).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("rejects a missing customer with NOT_FOUND", async () => {
    const lot = makeLot();
    const bag = makeCtx({ initialLots: [lot] });
    const thrown = await run(
      bag.ctx,
      validArgs({ customerId: "customers:ghost" }),
    ).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("rejects zero or negative price with VALIDATION", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });
    for (const price of [0, -100, 1.5]) {
      const thrown = await run(
        bag.ctx,
        validArgs({ totalPriceCents: price }),
      ).catch((e) => e);
      expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    }
  });

  it("rejects cheque without reference with VALIDATION", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });
    const thrown = await run(
      bag.ctx,
      validArgs({ method: "check", reference: "" }),
    ).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("accepts cheque with a reference and stores it on the payment", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });
    await run(
      bag.ctx,
      validArgs({ method: "check", reference: "  CHK-7890  " }),
    );
    const payment = Array.from(bag.payments.values())[0]!;
    expect(payment.paymentMethod).toBe("check");
    // Trimmed by the handler
    expect(payment.reference).toBe("CHK-7890");
  });

  it("rejects empty idempotency key with VALIDATION", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });
    const thrown = await run(
      bag.ctx,
      validArgs({ idempotencyKey: "" }),
    ).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });
});

describe("getContract", () => {
  const run = handlerOf(getContract);

  it("returns the contract with hydrated lot + customer fields", async () => {
    const lot = makeLot({ _id: "lots:1", code: "A-1-1" });
    const customer = makeCustomer({ _id: "customers:1", fullName: "Maria" });
    const contract: ContractFixture = {
      _id: "contracts:1",
      _creationTime: T0,
      contractNumber: "CON-20260601-A-1-1-1234",
      lotId: "lots:1",
      customerId: "customers:1",
      kind: "full_payment",
      totalPriceCents: 100_000_00,
      state: "paid_in_full",
      createdAt: T0,
      createdBy: USER_ID,
    };
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
      initialContracts: [contract],
    });

    const result = (await run(bag.ctx, {
      contractId: "contracts:1",
    })) as {
      contractNumber: string;
      lotCode: string;
      customerFullName: string;
      state: string;
    };
    expect(result.contractNumber).toBe(contract.contractNumber);
    expect(result.lotCode).toBe("A-1-1");
    expect(result.customerFullName).toBe("Maria");
    expect(result.state).toBe("paid_in_full");
  });

  it("throws NOT_FOUND when the contract id does not exist", async () => {
    const bag = makeCtx({});
    const thrown = await run(bag.ctx, {
      contractId: "contracts:ghost",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });
});

describe("listContracts", () => {
  const run = handlerOf(listContracts);

  it("returns all contracts when no state filter is provided", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const a: ContractFixture = {
      _id: "contracts:A",
      _creationTime: T0,
      contractNumber: "CON-A",
      lotId: lot._id,
      customerId: customer._id,
      kind: "full_payment",
      totalPriceCents: 50_000_00,
      state: "paid_in_full",
      createdAt: T0 - 100,
      createdBy: USER_ID,
    };
    const b: ContractFixture = {
      _id: "contracts:B",
      _creationTime: T0,
      contractNumber: "CON-B",
      lotId: lot._id,
      customerId: customer._id,
      kind: "installment",
      totalPriceCents: 200_000_00,
      state: "active",
      createdAt: T0,
      createdBy: USER_ID,
    };
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
      initialContracts: [a, b],
    });
    const result = (await run(bag.ctx, {})) as Array<{
      contractId: string;
      createdAt: number;
    }>;
    expect(result).toHaveLength(2);
    // Newest first
    expect(result[0]!.contractId).toBe("contracts:B");
    expect(result[1]!.contractId).toBe("contracts:A");
  });

  it("filters by state when stateFilter is provided", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const a: ContractFixture = {
      _id: "contracts:A",
      _creationTime: T0,
      contractNumber: "CON-A",
      lotId: lot._id,
      customerId: customer._id,
      kind: "full_payment",
      totalPriceCents: 50_000_00,
      state: "paid_in_full",
      createdAt: T0,
      createdBy: USER_ID,
    };
    const b: ContractFixture = {
      _id: "contracts:B",
      _creationTime: T0,
      contractNumber: "CON-B",
      lotId: lot._id,
      customerId: customer._id,
      kind: "installment",
      totalPriceCents: 200_000_00,
      state: "active",
      createdAt: T0,
      createdBy: USER_ID,
    };
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
      initialContracts: [a, b],
    });
    const result = (await run(bag.ctx, {
      stateFilter: "active",
    })) as Array<{ contractId: string }>;
    expect(result.map((r) => r.contractId)).toEqual(["contracts:B"]);
  });
});

/**
 * Story 3.6 — `transitionState` mutation tests.
 *
 * Covers the admin-only state-machine mutation:
 *   - Happy path: admin + valid reason → contract patched, audit emitted.
 *   - Role gating: office_staff returns FORBIDDEN.
 *   - Validation: short / blank reason rejected.
 *   - NOT_FOUND when contract id does not resolve.
 *   - ILLEGAL_STATE_TRANSITION when admin attempts a forbidden edge
 *     (e.g. paid_in_full → cancelled — refund flow is out of Phase 1).
 *   - Defense in depth: paid_in_full target is rejected at the
 *     validator union level (the public surface excludes it; admins
 *     cannot manually close out an unpaid contract).
 */
describe("transitionState", () => {
  const run = handlerOf(transitionState);

  it("admin transitions active → cancelled with a reason; contract patched + audit emitted", async () => {
    const lot = makeLot({ status: "sold" });
    const customer = makeCustomer();
    const contract: ContractFixture = {
      _id: "contracts:1",
      _creationTime: T0,
      contractNumber: "CON-2026-1",
      lotId: lot._id,
      customerId: customer._id,
      kind: "installment",
      totalPriceCents: 200_000_00,
      state: "active",
      createdAt: T0,
      createdBy: USER_ID,
    };
    const bag = makeCtx({
      roles: ["admin"],
      initialLots: [lot],
      initialCustomers: [customer],
      initialContracts: [contract],
    });

    const result = (await run(bag.ctx, {
      contractId: contract._id,
      to: "cancelled",
      reason: "Customer requested cancellation pre-interment",
    })) as { contractId: string; from: string; to: string };

    expect(result.from).toBe("active");
    expect(result.to).toBe("cancelled");
    // Contract was patched in-place.
    expect(bag.contracts.get(contract._id)!.state).toBe("cancelled");
    // One audit row emitted with action=transition.
    const transitionAudits = bag.auditInserts.filter(
      (r) => (r.row as { action: string }).action === "transition",
    );
    expect(transitionAudits).toHaveLength(1);
    expect(transitionAudits[0]!.row).toMatchObject({
      action: "transition",
      entityType: "contract",
      entityId: contract._id,
      before: { state: "active" },
      after: { state: "cancelled" },
      reason: "Customer requested cancellation pre-interment",
    });
  });

  it("admin transitions active → in_default (FR37 admin default)", async () => {
    const lot = makeLot({ status: "sold" });
    const customer = makeCustomer();
    const contract: ContractFixture = {
      _id: "contracts:2",
      _creationTime: T0,
      contractNumber: "CON-2026-2",
      lotId: lot._id,
      customerId: customer._id,
      kind: "installment",
      totalPriceCents: 200_000_00,
      state: "active",
      createdAt: T0,
      createdBy: USER_ID,
    };
    const bag = makeCtx({
      roles: ["admin"],
      initialLots: [lot],
      initialCustomers: [customer],
      initialContracts: [contract],
    });

    await run(bag.ctx, {
      contractId: contract._id,
      to: "in_default",
      reason: "Three missed installments past grace period",
    });

    expect(bag.contracts.get(contract._id)!.state).toBe("in_default");
  });

  it("admin transitions active → voided (FR24)", async () => {
    const lot = makeLot({ status: "sold" });
    const customer = makeCustomer();
    const contract: ContractFixture = {
      _id: "contracts:3",
      _creationTime: T0,
      contractNumber: "CON-2026-3",
      lotId: lot._id,
      customerId: customer._id,
      kind: "full_payment",
      totalPriceCents: 200_000_00,
      state: "active",
      createdAt: T0,
      createdBy: USER_ID,
    };
    const bag = makeCtx({
      roles: ["admin"],
      initialLots: [lot],
      initialCustomers: [customer],
      initialContracts: [contract],
    });

    await run(bag.ctx, {
      contractId: contract._id,
      to: "voided",
      reason: "Duplicate contract entry — voiding per BIR process",
    });

    expect(bag.contracts.get(contract._id)!.state).toBe("voided");
  });

  it("admin transitions in_default → active (Epic 4 reinstate)", async () => {
    const lot = makeLot({ status: "sold" });
    const customer = makeCustomer();
    const contract: ContractFixture = {
      _id: "contracts:4",
      _creationTime: T0,
      contractNumber: "CON-2026-4",
      lotId: lot._id,
      customerId: customer._id,
      kind: "installment",
      totalPriceCents: 200_000_00,
      state: "in_default",
      createdAt: T0,
      createdBy: USER_ID,
    };
    const bag = makeCtx({
      roles: ["admin"],
      initialLots: [lot],
      initialCustomers: [customer],
      initialContracts: [contract],
    });

    await run(bag.ctx, {
      contractId: contract._id,
      to: "active",
      reason: "Customer paid arrears in full; resuming installments",
    });

    expect(bag.contracts.get(contract._id)!.state).toBe("active");
  });

  it("returns FORBIDDEN when caller is office_staff (not admin)", async () => {
    const lot = makeLot({ status: "sold" });
    const customer = makeCustomer();
    const contract: ContractFixture = {
      _id: "contracts:5",
      _creationTime: T0,
      contractNumber: "CON-2026-5",
      lotId: lot._id,
      customerId: customer._id,
      kind: "full_payment",
      totalPriceCents: 200_000_00,
      state: "active",
      createdAt: T0,
      createdBy: USER_ID,
    };
    const bag = makeCtx({
      roles: ["office_staff"],
      initialLots: [lot],
      initialCustomers: [customer],
      initialContracts: [contract],
    });

    const thrown = await run(bag.ctx, {
      contractId: contract._id,
      to: "cancelled",
      reason: "Should be rejected before any work happens",
    }).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
    // No state change.
    expect(bag.contracts.get(contract._id)!.state).toBe("active");
    // No transition audit row.
    const transitionAudits = bag.auditInserts.filter(
      (r) => (r.row as { action: string }).action === "transition",
    );
    expect(transitionAudits).toHaveLength(0);
  });

  it("returns FORBIDDEN when caller is field_worker", async () => {
    const lot = makeLot({ status: "sold" });
    const customer = makeCustomer();
    const contract: ContractFixture = {
      _id: "contracts:6",
      _creationTime: T0,
      contractNumber: "CON-2026-6",
      lotId: lot._id,
      customerId: customer._id,
      kind: "full_payment",
      totalPriceCents: 200_000_00,
      state: "active",
      createdAt: T0,
      createdBy: USER_ID,
    };
    const bag = makeCtx({
      roles: ["field_worker"],
      initialLots: [lot],
      initialCustomers: [customer],
      initialContracts: [contract],
    });

    const thrown = await run(bag.ctx, {
      contractId: contract._id,
      to: "cancelled",
      reason: "Field workers cannot transition contracts",
    }).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("throws VALIDATION when reason is under 5 chars after trim", async () => {
    const lot = makeLot({ status: "sold" });
    const customer = makeCustomer();
    const contract: ContractFixture = {
      _id: "contracts:7",
      _creationTime: T0,
      contractNumber: "CON-2026-7",
      lotId: lot._id,
      customerId: customer._id,
      kind: "full_payment",
      totalPriceCents: 200_000_00,
      state: "active",
      createdAt: T0,
      createdBy: USER_ID,
    };
    const bag = makeCtx({
      roles: ["admin"],
      initialLots: [lot],
      initialCustomers: [customer],
      initialContracts: [contract],
    });

    const thrown = await run(bag.ctx, {
      contractId: contract._id,
      to: "cancelled",
      reason: "x", // too short
    }).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    expect(bag.contracts.get(contract._id)!.state).toBe("active");
  });

  it("throws VALIDATION when reason is whitespace-only", async () => {
    const lot = makeLot({ status: "sold" });
    const customer = makeCustomer();
    const contract: ContractFixture = {
      _id: "contracts:8",
      _creationTime: T0,
      contractNumber: "CON-2026-8",
      lotId: lot._id,
      customerId: customer._id,
      kind: "full_payment",
      totalPriceCents: 200_000_00,
      state: "active",
      createdAt: T0,
      createdBy: USER_ID,
    };
    const bag = makeCtx({
      roles: ["admin"],
      initialLots: [lot],
      initialCustomers: [customer],
      initialContracts: [contract],
    });

    const thrown = await run(bag.ctx, {
      contractId: contract._id,
      to: "cancelled",
      reason: "      \t  ",
    }).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("throws NOT_FOUND when the contract id does not resolve", async () => {
    const bag = makeCtx({ roles: ["admin"] });
    const thrown = await run(bag.ctx, {
      contractId: "contracts:missing",
      to: "cancelled",
      reason: "Should fail before the transition runs",
    }).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("throws ILLEGAL_STATE_TRANSITION when admin attempts paid_in_full → cancelled (terminal source)", async () => {
    const lot = makeLot({ status: "sold" });
    const customer = makeCustomer();
    const contract: ContractFixture = {
      _id: "contracts:9",
      _creationTime: T0,
      contractNumber: "CON-2026-9",
      lotId: lot._id,
      customerId: customer._id,
      kind: "full_payment",
      totalPriceCents: 200_000_00,
      state: "paid_in_full",
      createdAt: T0,
      createdBy: USER_ID,
    };
    const bag = makeCtx({
      roles: ["admin"],
      initialLots: [lot],
      initialCustomers: [customer],
      initialContracts: [contract],
    });

    const thrown = await run(bag.ctx, {
      contractId: contract._id,
      to: "cancelled",
      reason: "Refund flow out of Phase 1 scope — illegal edge",
    }).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.ILLEGAL_STATE_TRANSITION);
    // No state change; no transition audit.
    expect(bag.contracts.get(contract._id)!.state).toBe("paid_in_full");
    const transitionAudits = bag.auditInserts.filter(
      (r) => (r.row as { action: string }).action === "transition",
    );
    expect(transitionAudits).toHaveLength(0);
  });

  it("throws ILLEGAL_STATE_TRANSITION when admin attempts voided → active (terminal source)", async () => {
    const lot = makeLot({ status: "sold" });
    const customer = makeCustomer();
    const contract: ContractFixture = {
      _id: "contracts:10",
      _creationTime: T0,
      contractNumber: "CON-2026-10",
      lotId: lot._id,
      customerId: customer._id,
      kind: "full_payment",
      totalPriceCents: 200_000_00,
      state: "voided",
      createdAt: T0,
      createdBy: USER_ID,
    };
    const bag = makeCtx({
      roles: ["admin"],
      initialLots: [lot],
      initialCustomers: [customer],
      initialContracts: [contract],
    });

    const thrown = await run(bag.ctx, {
      contractId: contract._id,
      to: "active",
      reason: "Cannot un-void a voided contract",
    }).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.ILLEGAL_STATE_TRANSITION);
  });

  it("throws ILLEGAL_STATE_TRANSITION when admin attempts cancelled → active (terminal source)", async () => {
    const lot = makeLot({ status: "sold" });
    const customer = makeCustomer();
    const contract: ContractFixture = {
      _id: "contracts:11",
      _creationTime: T0,
      contractNumber: "CON-2026-11",
      lotId: lot._id,
      customerId: customer._id,
      kind: "installment",
      totalPriceCents: 200_000_00,
      state: "cancelled",
      createdAt: T0,
      createdBy: USER_ID,
    };
    const bag = makeCtx({
      roles: ["admin"],
      initialLots: [lot],
      initialCustomers: [customer],
      initialContracts: [contract],
    });

    const thrown = await run(bag.ctx, {
      contractId: contract._id,
      to: "active",
      reason: "Cannot un-cancel a cancelled contract",
    }).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.ILLEGAL_STATE_TRANSITION);
  });
});
