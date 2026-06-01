/**
 * Story 3.4 — `recordInstallmentSale` + `listContractInstallments`
 * unit tests.
 *
 * Coverage target: ≥ 90% on the new code (NFR-M2; the mutation is
 * financial-touching).
 *
 * Strategy mirrors `contracts.test.ts` — hand-mocked Convex ctx; we
 * import the public functions and pull their handlers off. The mock
 * supports the tables `recordInstallmentSale` writes:
 *
 *   - lots (read + status transition)
 *   - customers (read)
 *   - contracts (insert + patch)
 *   - installments (insert + read via by_contract)
 *   - payments / receipts / paymentAllocations (cornerstone writes)
 *   - receiptCounter (read + patch)
 *   - auditLog (insert via emitAudit + lot transition)
 *   - userRoles / users / authSessions (auth helper)
 *
 * Tests cover:
 *   - Happy path: 12-month installment with down payment → contract
 *     inserted in state `active`, 12 installment rows, lot transitioned
 *     to `sold`, payment + receipt + allocation created.
 *   - Zero down payment: no payment/receipt; installments inserted.
 *   - Term outside [1, 60] → VALIDATION.
 *   - Down payment >= total price → VALIDATION.
 *   - Installments length != termMonths → VALIDATION.
 *   - Duplicate installmentNumber → VALIDATION.
 *   - dueDates not strictly increasing → VALIDATION.
 *   - Sum mismatch → ALLOCATION_SUM_MISMATCH.
 *   - Non-cash without reference (with down payment) → VALIDATION.
 *   - Non-cash without reference (zero down) → succeeds (no payment).
 *   - Lot not available → INVARIANT_VIOLATION.
 *   - Lot missing → NOT_FOUND.
 *   - Customer missing → NOT_FOUND.
 *   - field_worker role → FORBIDDEN.
 *   - Unauthenticated → UNAUTHENTICATED.
 *   - listContractInstallments returns rows sorted by installmentNumber.
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
import { recordInstallmentSale } from "../../../convex/contracts";
import { generateInstallmentSchedule } from "../../../convex/lib/installmentSchedule";
import { listContractInstallments } from "../../../convex/installments";

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
}

interface ContractFixture {
  _id: string;
  _creationTime: number;
  contractNumber: string;
  lotId: string;
  customerId: string;
  kind: "full_payment" | "installment";
  totalPriceCents: number;
  state: string;
  createdAt: number;
  createdBy: string;
  paymentId?: string;
  receiptId?: string;
  downPaymentCents?: number;
  termMonths?: number;
  monthlyAmountCents?: number;
  firstDueDate?: number;
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
  paidAt?: number;
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
  installments: Map<string, InstallmentFixture>;
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
  initialInstallments?: InstallmentFixture[];
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
  const installments = new Map<string, InstallmentFixture>(
    (opts.initialInstallments ?? []).map((i) => [i._id, i]),
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

  type Predicate = (r: Record<string, unknown>) => boolean;

  function makeQueryBuilder(table: string) {
    const predicates: Predicate[] = [];
    const builder = {
      withIndex(_indexName: string, fn: (q: IndexQuery) => IndexQuery) {
        const q: IndexQuery = {
          eqs: {},
          eq(field: string, value: unknown) {
            this.eqs[field] = value;
            return this;
          },
        };
        fn(q);
        for (const [field, value] of Object.entries(q.eqs)) {
          predicates.push((r) => readField(r, field) === value);
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
    if (table === "lots")
      return Array.from(lots.values()) as unknown as Record<string, unknown>[];
    if (table === "customers")
      return Array.from(customers.values()) as unknown as Record<string, unknown>[];
    if (table === "contracts")
      return Array.from(contracts.values()) as unknown as Record<string, unknown>[];
    if (table === "installments")
      return Array.from(installments.values()) as unknown as Record<string, unknown>[];
    if (table === "payments")
      return Array.from(payments.values()) as unknown as Record<string, unknown>[];
    if (table === "receipts")
      return Array.from(receipts.values()) as unknown as Record<string, unknown>[];
    if (table === "paymentAllocations") {
      return Array.from(paymentAllocations.values()) as unknown as Record<string, unknown>[];
    }
    if (table === "receiptCounter") {
      return Array.from(receiptCounters.values()) as unknown as Record<string, unknown>[];
    }
    return [];
  }

  function readField(row: Record<string, unknown>, path: string): unknown {
    let cur: unknown = row;
    for (const part of path.split(".")) {
      if (cur === null || typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
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
        withIndex: () => ({
          first: async () => receiptCounters.get("receiptCounter:1") ?? null,
        }),
        first: async () => receiptCounters.get("receiptCounter:1") ?? null,
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
        if (installments.has(id)) return installments.get(id);
        if (payments.has(id)) return payments.get(id);
        if (receipts.has(id)) return receipts.get(id);
        if (receiptCounters.has(id)) return receiptCounters.get(id);
        return null;
      }),
      query: vi.fn((table: string) => tableQuery(table)),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "contracts") {
          const id = `contracts:${nextId++}`;
          contracts.set(id, { _id: id, _creationTime: T0, ...row } as ContractFixture);
          return id;
        }
        if (table === "installments") {
          const id = `installments:${nextId++}`;
          installments.set(id, {
            _id: id,
            _creationTime: T0,
            ...row,
          } as InstallmentFixture);
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
          paymentAllocations.set(id, { _id: id, _creationTime: T0, ...row });
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
        } else if (installments.has(id)) {
          const existing = installments.get(id)!;
          installments.set(id, { ...existing, ...patch } as InstallmentFixture);
        } else if (receiptCounters.has(id)) {
          const existing = receiptCounters.get(id)!;
          receiptCounters.set(id, { ...existing, ...patch } as ReceiptCounterFixture);
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
    installments,
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

/**
 * Helper: build a valid installments array of length termMonths whose
 * principals sum to `principalCents`. Spreads the principal evenly with
 * any remainder on the FINAL row, mirroring the
 * `generateInstallmentSchedule` math.
 */
/**
 * Build an installment-schedule row array that matches the server's
 * canonical re-derivation (`convex/lib/installmentSchedule.ts`). The
 * Epic-3/4 adversarial-review HIGH fix introduced server-side
 * re-derivation with `SCHEDULE_TAMPERED` rejection — tests that hand-
 * craft a naive `+30d` schedule would now fail that gate. We delegate
 * to the shared helper so the fixture stays in sync.
 *
 * `principalCents` is the amount to spread across `termMonths` rows
 * (i.e. `totalPriceCents - downPaymentCents`); we build a schedule
 * with downPayment=0 against `principalCents` to get the same row
 * shape the server expects to see for a sale whose down-payment was
 * carved off the front.
 */
function makeInstallments(
  termMonths: number,
  principalCents: number,
  firstDueDate: number,
): Array<{ installmentNumber: number; dueDate: number; principalCents: number }> {
  const schedule = generateInstallmentSchedule({
    totalPriceCents: principalCents,
    downPaymentCents: 0,
    termMonths,
    firstDueDate,
  });
  return schedule.rows.map((row) => ({
    installmentNumber: row.installmentNumber,
    dueDate: row.dueDate,
    principalCents: row.principalCents,
  }));
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

describe("recordInstallmentSale", () => {
  const run = handlerOf(recordInstallmentSale);
  const FIRST_DUE = T0 + 30 * 24 * 60 * 60 * 1000;

  function validArgs(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      lotId: "lots:1",
      customerId: "customers:1",
      totalPriceCents: 120_000_00,
      downPaymentCents: 20_000_00,
      termMonths: 12,
      monthlyAmountCents: 8_333_33,
      firstDueDate: FIRST_DUE,
      installments: makeInstallments(12, 100_000_00, FIRST_DUE),
      method: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-installment-1",
      ...overrides,
    };
  }

  it("records an installment sale end-to-end (happy path)", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      roles: ["office_staff"],
      initialLots: [lot],
      initialCustomers: [customer],
    });

    const result = (await run(bag.ctx, validArgs())) as {
      contractId: string;
      contractNumber: string;
      installmentCount: number;
      paymentId: string | null;
      receiptId: string | null;
      receiptNumber: string | null;
    };

    // Contract row inserted as installment, state active
    expect(bag.contracts.size).toBe(1);
    const contract = bag.contracts.get(result.contractId)!;
    expect(contract.state).toBe("active");
    expect(contract.kind).toBe("installment");
    expect(contract.totalPriceCents).toBe(120_000_00);
    expect(contract.downPaymentCents).toBe(20_000_00);
    expect(contract.termMonths).toBe(12);

    // 12 installments inserted
    expect(bag.installments.size).toBe(12);
    expect(result.installmentCount).toBe(12);
    const sum = Array.from(bag.installments.values()).reduce(
      (acc, r) => acc + r.principalCents,
      0,
    );
    expect(sum).toBe(100_000_00);
    for (const row of bag.installments.values()) {
      expect(row.status).toBe("pending");
      expect(row.paidCents).toBe(0);
      expect(row.contractId).toBe(result.contractId);
    }

    // Down payment financial event posted
    expect(bag.payments.size).toBe(1);
    expect(bag.receipts.size).toBe(1);
    expect(bag.paymentAllocations.size).toBe(1);
    const payment = Array.from(bag.payments.values())[0]!;
    expect(payment.amountCents).toBe(20_000_00);
    const allocation = Array.from(bag.paymentAllocations.values())[0]!;
    expect(allocation.targetType).toBe("contract");
    expect(allocation.amountCents).toBe(20_000_00);

    // Lot transitioned to sold
    expect(bag.lots.get("lots:1")!.status).toBe("sold");

    // Audit rows present
    const actions = bag.auditInserts.map((a) => ({
      action: a.row.action,
      entityType: a.row.entityType,
    }));
    expect(actions).toContainEqual({ action: "transition", entityType: "lot" });
    expect(actions).toContainEqual({ action: "create", entityType: "receipt" });
    expect(actions).toContainEqual({
      action: "create",
      entityType: "contract",
    });
  });

  it("rejects zero down payment with ZERO_DOWN_NOT_SUPPORTED", async () => {
    // Epic-3/4 adversarial-review HIGH fix: zero-down installment sales
    // cannot dedupe through `payments.by_idempotency`, so a
    // double-click on submit would otherwise produce duplicate
    // contracts. Until a dedicated dedup table lands, zero-down is
    // a hard reject at the API boundary.
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });

    const thrown = await run(
      bag.ctx,
      validArgs({
        downPaymentCents: 0,
        installments: makeInstallments(12, 120_000_00, FIRST_DUE),
        idempotencyKey: "idem-installment-zero-down",
      }),
    ).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.ZERO_DOWN_NOT_SUPPORTED);
    // No side effects on rejection.
    expect(bag.contracts.size).toBe(0);
    expect(bag.installments.size).toBe(0);
    expect(bag.payments.size).toBe(0);
    expect(bag.receipts.size).toBe(0);
  });

  it("rejects term out of range with VALIDATION", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });

    for (const term of [0, -3, 61]) {
      const thrown = await run(
        bag.ctx,
        validArgs({ termMonths: term, idempotencyKey: `idem-bad-term-${term}` }),
      ).catch((e) => e);
      expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    }
  });

  it("rejects downPayment >= totalPrice with VALIDATION", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });

    const thrown = await run(
      bag.ctx,
      validArgs({
        downPaymentCents: 120_000_00,
        installments: [],
        idempotencyKey: "idem-bad-down",
      }),
    ).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects installments.length != termMonths with VALIDATION", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });

    const thrown = await run(
      bag.ctx,
      validArgs({
        termMonths: 12,
        installments: makeInstallments(11, 100_000_00, FIRST_DUE),
        idempotencyKey: "idem-bad-len",
      }),
    ).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects duplicate installmentNumber with VALIDATION", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });

    const rows = makeInstallments(12, 100_000_00, FIRST_DUE);
    rows[1]!.installmentNumber = 1; // duplicate
    const thrown = await run(
      bag.ctx,
      validArgs({ installments: rows, idempotencyKey: "idem-dup" }),
    ).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects non-monotonic dueDates with VALIDATION", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });

    const rows = makeInstallments(12, 100_000_00, FIRST_DUE);
    rows[5]!.dueDate = rows[0]!.dueDate - 1; // earlier than the first
    const thrown = await run(
      bag.ctx,
      validArgs({ installments: rows, idempotencyKey: "idem-monotonic" }),
    ).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects sum mismatch with ALLOCATION_SUM_MISMATCH", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });

    const rows = makeInstallments(12, 100_000_00, FIRST_DUE);
    rows[0]!.principalCents += 100; // sum drifts by 1 peso
    const thrown = await run(
      bag.ctx,
      validArgs({ installments: rows, idempotencyKey: "idem-sum" }),
    ).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.ALLOCATION_SUM_MISMATCH);
  });

  it("rejects non-cash without reference when down payment > 0 (VALIDATION)", async () => {
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });

    const thrown = await run(
      bag.ctx,
      validArgs({ method: "check", idempotencyKey: "idem-no-ref" }),
    ).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("non-cash with zero down still hits ZERO_DOWN_NOT_SUPPORTED before the reference check", async () => {
    // Pre-Epic-3/4-fix behaviour was "zero-down + non-cash + no reference
    // is allowed because no payment is created." With the zero-down hard
    // reject in place, the zero-down rejection trips first regardless of
    // the method / reference combination.
    const lot = makeLot();
    const customer = makeCustomer();
    const bag = makeCtx({
      initialLots: [lot],
      initialCustomers: [customer],
    });

    const thrown = await run(
      bag.ctx,
      validArgs({
        method: "check",
        downPaymentCents: 0,
        installments: makeInstallments(12, 120_000_00, FIRST_DUE),
        idempotencyKey: "idem-zero-no-ref",
      }),
    ).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.ZERO_DOWN_NOT_SUPPORTED);
    expect(bag.contracts.size).toBe(0);
    expect(bag.payments.size).toBe(0);
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
    expect(bag.installments.size).toBe(0);
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

  it("rejects unauthenticated callers with UNAUTHENTICATED", async () => {
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
});

describe("listContractInstallments", () => {
  const run = handlerOf(listContractInstallments);
  const FIRST_DUE = T0 + 30 * 24 * 60 * 60 * 1000;

  it("returns installment rows sorted by installmentNumber", async () => {
    const contract: ContractFixture = {
      _id: "contracts:install-1",
      _creationTime: T0,
      contractNumber: "CON-X",
      lotId: "lots:1",
      customerId: "customers:1",
      kind: "installment",
      totalPriceCents: 120_000_00,
      state: "active",
      createdAt: T0,
      createdBy: USER_ID,
    };
    // Insert in scrambled order to exercise the in-handler sort.
    const installmentFixtures: InstallmentFixture[] = [
      {
        _id: "installments:3",
        _creationTime: T0,
        contractId: contract._id,
        installmentNumber: 3,
        dueDate: FIRST_DUE + 60 * 24 * 60 * 60 * 1000,
        principalCents: 10_000_00,
        paidCents: 0,
        status: "pending",
      },
      {
        _id: "installments:1",
        _creationTime: T0,
        contractId: contract._id,
        installmentNumber: 1,
        dueDate: FIRST_DUE,
        principalCents: 10_000_00,
        paidCents: 0,
        status: "pending",
      },
      {
        _id: "installments:2",
        _creationTime: T0,
        contractId: contract._id,
        installmentNumber: 2,
        dueDate: FIRST_DUE + 30 * 24 * 60 * 60 * 1000,
        principalCents: 10_000_00,
        paidCents: 0,
        status: "pending",
      },
    ];

    const bag = makeCtx({
      initialContracts: [contract],
      initialInstallments: installmentFixtures,
    });

    const result = (await run(bag.ctx, {
      contractId: contract._id,
    })) as Array<{ installmentNumber: number }>;
    expect(result.map((r) => r.installmentNumber)).toEqual([1, 2, 3]);
  });

  it("throws NOT_FOUND for an unknown contract", async () => {
    const bag = makeCtx({});
    const thrown = await run(bag.ctx, {
      contractId: "contracts:ghost",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("throws INVARIANT_VIOLATION for a full-payment contract", async () => {
    const contract: ContractFixture = {
      _id: "contracts:full-1",
      _creationTime: T0,
      contractNumber: "CON-FULL",
      lotId: "lots:1",
      customerId: "customers:1",
      kind: "full_payment",
      totalPriceCents: 120_000_00,
      state: "paid_in_full",
      createdAt: T0,
      createdBy: USER_ID,
    };
    const bag = makeCtx({ initialContracts: [contract] });
    const thrown = await run(bag.ctx, {
      contractId: contract._id,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });
});
