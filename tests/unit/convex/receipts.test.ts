/**
 * Story 3.11 — `convex/receipts.ts` unit tests.
 *
 * Hand-mocked-ctx pattern, same shape as `expenses.test.ts` and
 * `conditionLogs.test.ts`. Covers:
 *   - `requireRole` enforcement on every public query
 *   - the hydrated detail shape (`getReceipt`)
 *   - the list-view shape + `voidedOnly` filter (`listReceipts`)
 *   - graceful null-handling when joined rows (customer / contract /
 *     lot / user) are missing
 *
 * The placeholder BIR template is embedded directly in the detail
 * payload, so tests can assert its presence without mocking the
 * helper module.
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
import { getReceipt, listReceipts } from "../../../convex/receipts";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

// 2026-05-15 noon Manila.
const T0 = new Date("2026-05-15T12:00:00+08:00").getTime();
const USER_ID = "users:abc";
const SESSION_ID = "authSessions:def";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface ReceiptFixture {
  _id: string;
  _creationTime: number;
  paymentId: string;
  receiptSeries: string;
  receiptNumber: string;
  receiptSerial: number;
  contractId?: string;
  customerId?: string;
  amountCents: number;
  issuedAt: number;
  issuedByUserId: string;
  isVoided: boolean;
  voidedAt?: number;
  voidReason?: string;
  voidedByUserId?: string;
}

interface PaymentFixture {
  _id: string;
  paymentNumber: string;
  amountCents: number;
  paymentMethod: "cash" | "check" | "bank_transfer" | "gcash" | "maya" | "card";
  reference?: string;
  receivedAt: number;
  receivedByUserId: string;
  contractId?: string;
  customerId?: string;
  isVoided: boolean;
}

interface AllocationFixture {
  _id: string;
  paymentId: string;
  targetType: "contract" | "installment" | "perpetualCare" | "credit";
  targetId: string;
  amountCents: number;
  sequence: number;
  note?: string;
}

interface CustomerFixture {
  _id: string;
  fullName: string;
  address: {
    line1: string;
    barangay?: string;
    cityMunicipality?: string;
    province?: string;
    postalCode?: string;
  };
}

interface ContractFixture {
  _id: string;
  contractNumber: string;
  lotId: string;
}

interface LotFixture {
  _id: string;
  code: string;
}

function makeCtx(opts: {
  roles?: RoleName[];
  authenticated?: boolean;
  receipts?: ReceiptFixture[];
  payments?: PaymentFixture[];
  allocations?: AllocationFixture[];
  customers?: CustomerFixture[];
  contracts?: ContractFixture[];
  lots?: LotFixture[];
}) {
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

  const receipts = new Map<string, ReceiptFixture>(
    (opts.receipts ?? []).map((r) => [r._id, r]),
  );
  const payments = new Map<string, PaymentFixture>(
    (opts.payments ?? []).map((p) => [p._id, p]),
  );
  const allocations = opts.allocations ?? [];
  const customers = new Map<string, CustomerFixture>(
    (opts.customers ?? []).map((c) => [c._id, c]),
  );
  const contracts = new Map<string, ContractFixture>(
    (opts.contracts ?? []).map((c) => [c._id, c]),
  );
  const lots = new Map<string, LotFixture>(
    (opts.lots ?? []).map((l) => [l._id, l]),
  );

  function makeReceiptsBuilder() {
    let orderDesc = false;
    const builder = {
      withIndex(_indexName: string) {
        return builder;
      },
      order(direction: "asc" | "desc") {
        orderDesc = direction === "desc";
        return builder;
      },
      async take(limit: number) {
        const rows = Array.from(receipts.values()).sort((a, b) =>
          orderDesc ? b.issuedAt - a.issuedAt : a.issuedAt - b.issuedAt,
        );
        return rows.slice(0, limit);
      },
    };
    return builder;
  }

  function makeAllocationsBuilder(eqs: Record<string, unknown>) {
    return {
      async collect() {
        return allocations.filter((a) => {
          for (const [k, v] of Object.entries(eqs)) {
            if ((a as unknown as Record<string, unknown>)[k] !== v) {
              return false;
            }
          }
          return true;
        });
      },
    };
  }

  interface IndexQuery {
    eqs: Record<string, unknown>;
    eq(field: string, value: unknown): IndexQuery;
  }

  const ctx = {
    db: {
      get: vi.fn(async (id: string) => {
        if (id === USER_ID) return user;
        if (id === SESSION_ID) return session;
        if (receipts.has(id)) return receipts.get(id);
        if (payments.has(id)) return payments.get(id);
        if (customers.has(id)) return customers.get(id);
        if (contracts.has(id)) return contracts.get(id);
        if (lots.has(id)) return lots.get(id);
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
        if (table === "receipts") {
          return makeReceiptsBuilder();
        }
        if (table === "paymentAllocations") {
          return {
            withIndex: (_n: string, fn?: (q: IndexQuery) => IndexQuery) => {
              const q: IndexQuery = {
                eqs: {},
                eq(field, value) {
                  this.eqs[field] = value;
                  return this;
                },
              };
              if (fn !== undefined) fn(q);
              return makeAllocationsBuilder(q.eqs);
            },
          };
        }
        return {
          withIndex: () => ({
            collect: async () => [],
            first: async () => null,
            take: async () => [],
          }),
        };
      }),
    },
  };
  return { ctx, receipts, payments, allocations, customers, contracts, lots };
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

const sampleReceipt: ReceiptFixture = {
  _id: "receipts:1",
  _creationTime: T0,
  paymentId: "payments:1",
  receiptSeries: "OR-",
  receiptNumber: "OR-0000123",
  receiptSerial: 123,
  contractId: "contracts:1",
  customerId: "customers:1",
  amountCents: 250_000,
  issuedAt: T0,
  issuedByUserId: USER_ID,
  isVoided: false,
};

const samplePayment: PaymentFixture = {
  _id: "payments:1",
  paymentNumber: "OR-0000123",
  amountCents: 250_000,
  paymentMethod: "cash",
  reference: "REF-1",
  receivedAt: T0,
  receivedByUserId: USER_ID,
  contractId: "contracts:1",
  customerId: "customers:1",
  isVoided: false,
};

const sampleCustomer: CustomerFixture = {
  _id: "customers:1",
  fullName: "Juan Dela Cruz",
  address: {
    line1: "123 Sample St.",
    barangay: "Brgy. Sample",
    cityMunicipality: "Quezon City",
    province: "Metro Manila",
    postalCode: "1100",
  },
};

const sampleContract: ContractFixture = {
  _id: "contracts:1",
  contractNumber: "C-2026-0001",
  lotId: "lots:1",
};

const sampleLot: LotFixture = {
  _id: "lots:1",
  code: "D-5-12",
};

const sampleAllocations: AllocationFixture[] = [
  {
    _id: "alloc:1",
    paymentId: "payments:1",
    targetType: "contract",
    targetId: "contracts:1",
    amountCents: 250_000,
    sequence: 0,
  },
];

describe("getReceipt", () => {
  const run = handlerOf(getReceipt);

  it("returns the hydrated detail for office_staff", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      receipts: [sampleReceipt],
      payments: [samplePayment],
      customers: [sampleCustomer],
      contracts: [sampleContract],
      lots: [sampleLot],
      allocations: sampleAllocations,
    });

    const result = (await run(ctx, { receiptId: "receipts:1" })) as Record<
      string,
      unknown
    >;
    expect(result).not.toBeNull();
    expect(result.receiptNumber).toBe("OR-0000123");
    expect(result.receiptSerial).toBe(123);
    expect(result.amountCents).toBe(250_000);
    expect(result.isVoided).toBe(false);

    const customer = result.customer as Record<string, unknown>;
    expect(customer.fullName).toBe("Juan Dela Cruz");
    expect(customer.addressLine1).toBe("123 Sample St.");

    const payment = result.payment as Record<string, unknown>;
    expect(payment.paymentMethod).toBe("cash");
    expect(payment.reference).toBe("REF-1");
    expect(payment.receivedByName).toBe("Maria Office");

    const contract = result.contract as Record<string, unknown>;
    expect(contract.contractNumber).toBe("C-2026-0001");
    expect(contract.lotCode).toBe("D-5-12");

    const allocs = result.allocations as Array<Record<string, unknown>>;
    expect(allocs).toHaveLength(1);
    expect(allocs[0]!.targetType).toBe("contract");
    expect(allocs[0]!.amountCents).toBe(250_000);

    const template = result.template as Record<string, unknown>;
    expect(template.formatVersion).toBe("v1-placeholder");
    expect(result.templateIsPlaceholder).toBe(true);
  });

  it("allows admin", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      receipts: [sampleReceipt],
      payments: [samplePayment],
      customers: [sampleCustomer],
      contracts: [sampleContract],
      lots: [sampleLot],
      allocations: sampleAllocations,
    });
    const result = await run(ctx, { receiptId: "receipts:1" });
    expect(result).not.toBeNull();
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      receipts: [sampleReceipt],
    });
    const thrown = await run(ctx, { receiptId: "receipts:1" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects customer role with FORBIDDEN", async () => {
    const { ctx } = makeCtx({
      roles: ["customer"],
      receipts: [sampleReceipt],
    });
    const thrown = await run(ctx, { receiptId: "receipts:1" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, { receiptId: "receipts:1" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("returns null when the receipt is not found", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const result = await run(ctx, { receiptId: "receipts:999" });
    expect(result).toBeNull();
  });

  it("gracefully handles a missing customer record (post-deletion)", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      receipts: [sampleReceipt],
      payments: [samplePayment],
      // No customers seeded → customer is null
      contracts: [sampleContract],
      lots: [sampleLot],
      allocations: sampleAllocations,
    });
    const result = (await run(ctx, { receiptId: "receipts:1" })) as Record<
      string,
      unknown
    >;
    expect(result).not.toBeNull();
    const customer = result.customer as Record<string, unknown>;
    expect(customer.fullName).toBeNull();
  });

  it("surfaces void state when the receipt is voided", async () => {
    const voided: ReceiptFixture = {
      ...sampleReceipt,
      isVoided: true,
      voidedAt: T0 + 1000,
      voidReason: "Duplicate entry",
      voidedByUserId: USER_ID,
    };
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      receipts: [voided],
      payments: [samplePayment],
      customers: [sampleCustomer],
      contracts: [sampleContract],
      lots: [sampleLot],
      allocations: sampleAllocations,
    });
    const result = (await run(ctx, { receiptId: "receipts:1" })) as Record<
      string,
      unknown
    >;
    expect(result.isVoided).toBe(true);
    expect(result.voidReason).toBe("Duplicate entry");
    expect(result.voidedByName).toBe("Maria Office");
  });

  it("returns allocations sorted by sequence", async () => {
    const outOfOrder: AllocationFixture[] = [
      {
        _id: "a2",
        paymentId: "payments:1",
        targetType: "installment",
        targetId: "i2",
        amountCents: 50_000,
        sequence: 2,
      },
      {
        _id: "a0",
        paymentId: "payments:1",
        targetType: "installment",
        targetId: "i0",
        amountCents: 100_000,
        sequence: 0,
      },
      {
        _id: "a1",
        paymentId: "payments:1",
        targetType: "installment",
        targetId: "i1",
        amountCents: 100_000,
        sequence: 1,
      },
    ];
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      receipts: [sampleReceipt],
      payments: [samplePayment],
      customers: [sampleCustomer],
      contracts: [sampleContract],
      lots: [sampleLot],
      allocations: outOfOrder,
    });
    const result = (await run(ctx, { receiptId: "receipts:1" })) as Record<
      string,
      unknown
    >;
    const allocs = result.allocations as Array<{ sequence: number }>;
    expect(allocs.map((a) => a.sequence)).toEqual([0, 1, 2]);
  });
});

describe("listReceipts", () => {
  const run = handlerOf(listReceipts);

  it("returns the most-recent receipts for office_staff", async () => {
    const older: ReceiptFixture = {
      ...sampleReceipt,
      _id: "receipts:2",
      receiptNumber: "OR-0000122",
      receiptSerial: 122,
      issuedAt: T0 - 1000,
    };
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      receipts: [older, sampleReceipt],
      payments: [samplePayment],
      customers: [sampleCustomer],
      contracts: [sampleContract],
      lots: [sampleLot],
    });
    const rows = (await run(ctx, {})) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    // Newest first.
    expect(rows[0]!.receiptSerial).toBe(123);
    expect(rows[1]!.receiptSerial).toBe(122);
    expect(rows[0]!.customerFullName).toBe("Juan Dela Cruz");
    expect(rows[0]!.contractNumber).toBe("C-2026-0001");
  });

  it("respects limit + caps at the maximum", async () => {
    const many: ReceiptFixture[] = Array.from({ length: 5 }, (_, i) => ({
      ...sampleReceipt,
      _id: `receipts:${i}`,
      receiptNumber: `OR-000010${i}`,
      receiptSerial: 100 + i,
      issuedAt: T0 - i * 1000,
    }));
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      receipts: many,
      payments: [samplePayment],
      customers: [sampleCustomer],
      contracts: [sampleContract],
      lots: [sampleLot],
    });
    const rows = (await run(ctx, { limit: 2 })) as unknown[];
    expect(rows).toHaveLength(2);
  });

  it("filters to voided only when requested", async () => {
    const voided: ReceiptFixture = {
      ...sampleReceipt,
      _id: "receipts:v",
      receiptNumber: "OR-0000124",
      receiptSerial: 124,
      isVoided: true,
      voidedAt: T0,
      voidReason: "Test void",
      voidedByUserId: USER_ID,
    };
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      receipts: [sampleReceipt, voided],
      payments: [samplePayment],
      customers: [sampleCustomer],
      contracts: [sampleContract],
      lots: [sampleLot],
    });
    const rows = (await run(ctx, { voidedOnly: true })) as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isVoided).toBe(true);
    expect(rows[0]!.receiptSerial).toBe(124);
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("returns empty array when no receipts exist", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const rows = (await run(ctx, {})) as unknown[];
    expect(rows).toEqual([]);
  });
});
