/**
 * Story 9.2 — `convex/portal.ts` contract-scoped queries (unit tests).
 *
 * Coverage target: ≥ 95% line + branch on the three Story 9.2 query
 * handlers (`listCustomerContracts`, `getCustomerContractDetail`,
 * `listCustomerPayments`). The ownership-scoping branch is the
 * cornerstone Phase 3 invariant — every "request another customer's
 * row" path is explicitly asserted to return the silently-scoped
 * shape (404 / empty / scoped list) rather than leaking another
 * customer's data.
 *
 * Strategy: hand-mocked ctx, mirroring the pattern used in
 * `tests/unit/convex/portal.test.ts` and `contracts.test.ts`. We
 * support the `.withIndex(name, q => q.eq(field, value)).collect()`
 * shape for the four tables Story 9.2 reads — contracts (by_customer),
 * installments (by_contract), payments (by_contract), receipts
 * (by_payment) — and the `.unique()` shape for the receipt one-to-one
 * lookup.
 *
 * Cases (high-level):
 *   - listCustomerContracts:
 *       • FORBIDDEN for staff roles.
 *       • Returns [] when the customer has 0 contracts.
 *       • Returns N rows scoped to the customer (other customers'
 *         contracts MUST NOT appear).
 *       • Filters out voided contracts.
 *       • Computes outstandingBalance = total − Σ non-voided payments.
 *       • Voided payments DO NOT reduce the balance.
 *       • Installment contracts surface nextDueDate +
 *         remainingInstallments.
 *       • Newest contract first (createdAt desc).
 *   - getCustomerContractDetail:
 *       • Returns null for unknown contract id.
 *       • Returns null when the contract belongs to another customer
 *         (404 path, not throw FORBIDDEN).
 *       • Happy path returns header + lot + schedule.
 *       • Lot ref scrubs the polygon vertex array.
 *   - listCustomerPayments:
 *       • Returns [] for unknown contract id.
 *       • Returns [] when the contract belongs to another customer.
 *       • Happy path returns payments in latest-first order.
 *       • Receipt number hydrated from the receipts table.
 *       • Honours the optional `limit` arg.
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
  listCustomerContracts,
  getCustomerContractDetail,
  listCustomerPayments,
} from "../../../convex/portal";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const CALLER_ID = "users:u1";
const SESSION_ID = "authSessions:s1";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface CustomerFixture {
  _id: string;
  _creationTime: number;
  fullName: string;
  email?: string;
}

interface LotFixture {
  _id: string;
  _creationTime: number;
  code: string;
  section: string;
  block: string;
  row: string;
  geometry: {
    centroid: { lat: number; lng: number };
    polygon: { lat: number; lng: number }[];
    bboxMinLat: number;
    bboxMaxLat: number;
    bboxMinLng: number;
    bboxMaxLng: number;
  };
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
  termMonths?: number;
  monthlyAmountCents?: number;
  downPaymentCents?: number;
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

interface PaymentFixture {
  _id: string;
  _creationTime: number;
  paymentNumber: string;
  contractId?: string;
  customerId?: string;
  amountCents: number;
  paymentMethod:
    | "cash"
    | "check"
    | "bank_transfer"
    | "gcash"
    | "maya"
    | "card";
  reference?: string;
  receivedAt: number;
  isVoided: boolean;
}

interface ReceiptFixture {
  _id: string;
  _creationTime: number;
  paymentId: string;
  receiptNumber: string;
}

function makeCtx(opts: {
  roles?: RoleName[];
  callerEmail?: string;
  authenticated?: boolean;
  customers?: CustomerFixture[];
  lots?: LotFixture[];
  contracts?: ContractFixture[];
  installments?: InstallmentFixture[];
  payments?: PaymentFixture[];
  receipts?: ReceiptFixture[];
}) {
  const customers = new Map<string, CustomerFixture>(
    (opts.customers ?? []).map((c) => [c._id, c]),
  );
  const lots = new Map<string, LotFixture>(
    (opts.lots ?? []).map((l) => [l._id, l]),
  );
  const contracts = new Map<string, ContractFixture>(
    (opts.contracts ?? []).map((c) => [c._id, c]),
  );
  const installments = new Map<string, InstallmentFixture>(
    (opts.installments ?? []).map((i) => [i._id, i]),
  );
  const payments = new Map<string, PaymentFixture>(
    (opts.payments ?? []).map((p) => [p._id, p]),
  );
  const receipts = new Map<string, ReceiptFixture>(
    (opts.receipts ?? []).map((r) => [r._id, r]),
  );

  const userRoles = (opts.roles ?? ["customer"]).map((role, idx) => ({
    _id: `userRoles:caller-${idx}`,
    _creationTime: T0,
    userId: CALLER_ID,
    role,
    grantedAt: T0,
    grantedBy: CALLER_ID,
  }));

  const callerUser = {
    _id: CALLER_ID,
    _creationTime: T0 - 1000,
    email: opts.callerEmail,
    name: undefined,
    isActive: true,
  };
  const session = {
    _id: SESSION_ID,
    _creationTime: T0,
    userId: CALLER_ID,
    expirationTime: T0 + 30 * 24 * HOUR_MS,
  };

  if (opts.authenticated === false) {
    mockedGetAuthUserId.mockResolvedValue(null);
    mockedGetAuthSessionId.mockResolvedValue(null);
  } else {
    mockedGetAuthUserId.mockResolvedValue(CALLER_ID as never);
    mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);
  }

  type Predicate = (r: Record<string, unknown>) => boolean;

  function rowsFor(table: string): Record<string, unknown>[] {
    if (table === "customers") return Array.from(customers.values()) as never;
    if (table === "lots") return Array.from(lots.values()) as never;
    if (table === "contracts") return Array.from(contracts.values()) as never;
    if (table === "installments") {
      return Array.from(installments.values()) as never;
    }
    if (table === "payments") return Array.from(payments.values()) as never;
    if (table === "receipts") return Array.from(receipts.values()) as never;
    return [];
  }

  function makeBuilder(table: string) {
    const predicates: Predicate[] = [];
    const builder = {
      withIndex(
        _name: string,
        fn: (q: {
          eqs: Record<string, unknown>;
          eq: (f: string, v: unknown) => unknown;
        }) => unknown,
      ) {
        const q = {
          eqs: {} as Record<string, unknown>,
          eq(f: string, v: unknown) {
            this.eqs[f] = v;
            return this;
          },
        };
        fn(q);
        for (const [f, v] of Object.entries(q.eqs)) {
          predicates.push((r) => r[f] === v);
        }
        return builder;
      },
      async collect() {
        return rowsFor(table).filter((r) => predicates.every((p) => p(r)));
      },
      async unique() {
        const matches = rowsFor(table).filter((r) =>
          predicates.every((p) => p(r)),
        );
        if (matches.length === 0) return null;
        if (matches.length > 1) {
          throw new Error(`unique() in test ctx found ${matches.length} rows`);
        }
        return matches[0];
      },
    };
    return builder;
  }

  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === CALLER_ID) return callerUser;
        if (id === SESSION_ID) return session;
        if (customers.has(id)) return customers.get(id);
        if (lots.has(id)) return lots.get(id);
        if (contracts.has(id)) return contracts.get(id);
        if (installments.has(id)) return installments.get(id);
        if (payments.has(id)) return payments.get(id);
        if (receipts.has(id)) return receipts.get(id);
        return null;
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return {
            withIndex: () => ({ collect: async () => userRoles }),
          };
        }
        if (table === "customers") {
          return { collect: async () => Array.from(customers.values()) };
        }
        return makeBuilder(table);
      }),
    },
  };

  return ctx;
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

const CALLER_EMAIL = "maria@example.com";
const CALLER_CUSTOMER_ID = "customers:c1";
const OTHER_CUSTOMER_ID = "customers:c2";
const LOT_ID = "lots:l1";
const OTHER_LOT_ID = "lots:l2";

function callerCustomer(): CustomerFixture {
  return {
    _id: CALLER_CUSTOMER_ID,
    _creationTime: T0 - 1000,
    fullName: "Maria Cruz",
    email: CALLER_EMAIL,
  };
}

function otherCustomer(): CustomerFixture {
  return {
    _id: OTHER_CUSTOMER_ID,
    _creationTime: T0 - 1000,
    fullName: "Pedro Garcia",
    email: "pedro@example.com",
  };
}

function lot(id: string, code: string): LotFixture {
  return {
    _id: id,
    _creationTime: T0 - 2000,
    code,
    section: "D",
    block: "12",
    row: "3",
    geometry: {
      centroid: { lat: 14.5, lng: 121.0 },
      polygon: [
        { lat: 14.5001, lng: 121.0001 },
        { lat: 14.5002, lng: 121.0002 },
        { lat: 14.5003, lng: 121.0003 },
      ],
      bboxMinLat: 14.5,
      bboxMaxLat: 14.5005,
      bboxMinLng: 121.0,
      bboxMaxLng: 121.0005,
    },
  };
}

function makeContract(
  id: string,
  customerId: string,
  overrides: Partial<ContractFixture> = {},
): ContractFixture {
  return {
    _id: id,
    _creationTime: T0 - 500,
    contractNumber: `CN-${id}`,
    lotId: overrides.lotId ?? LOT_ID,
    customerId,
    kind: overrides.kind ?? "installment",
    totalPriceCents: overrides.totalPriceCents ?? 1_000_000,
    state: overrides.state ?? "active",
    createdAt: overrides.createdAt ?? T0 - 1000,
    ...(overrides.termMonths !== undefined
      ? { termMonths: overrides.termMonths }
      : { termMonths: 12 }),
    ...(overrides.monthlyAmountCents !== undefined
      ? { monthlyAmountCents: overrides.monthlyAmountCents }
      : { monthlyAmountCents: 83_333 }),
    ...(overrides.downPaymentCents !== undefined
      ? { downPaymentCents: overrides.downPaymentCents }
      : {}),
    ...(overrides.firstDueDate !== undefined
      ? { firstDueDate: overrides.firstDueDate }
      : {}),
  };
}

function makeInstallment(
  id: string,
  contractId: string,
  num: number,
  due: number,
  status: InstallmentFixture["status"] = "pending",
  paidCents = 0,
): InstallmentFixture {
  return {
    _id: id,
    _creationTime: T0,
    contractId,
    installmentNumber: num,
    dueDate: due,
    principalCents: 100_000,
    paidCents,
    status,
  };
}

function makePayment(
  id: string,
  contractId: string,
  amountCents: number,
  isVoided = false,
  receivedAt = T0 - 500,
): PaymentFixture {
  return {
    _id: id,
    _creationTime: receivedAt,
    paymentNumber: `OR-${id}`,
    contractId,
    customerId: CALLER_CUSTOMER_ID,
    amountCents,
    paymentMethod: "cash",
    receivedAt,
    isVoided,
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

describe("portal.listCustomerContracts — auth", () => {
  const run = handlerOf(listCustomerContracts);

  it("throws FORBIDDEN for office_staff", async () => {
    const ctx = makeCtx({
      roles: ["office_staff"],
      callerEmail: "staff@example.com",
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("throws FORBIDDEN for admin", async () => {
    const ctx = makeCtx({
      roles: ["admin"],
      callerEmail: "admin@example.com",
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("throws UNAUTHENTICATED when no session", async () => {
    const ctx = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("throws NOT_FOUND when no customer row links to the auth email", async () => {
    const ctx = makeCtx({
      callerEmail: "nobody@example.com",
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });
});

describe("portal.listCustomerContracts — ownership scoping", () => {
  const run = handlerOf(listCustomerContracts);

  it("returns [] when the customer has no contracts", async () => {
    const ctx = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      lots: [lot(LOT_ID, "A-1")],
      contracts: [],
    });
    const result = (await run(ctx, {})) as unknown[];
    expect(result).toEqual([]);
  });

  it("returns only the calling customer's contracts (not other customers')", async () => {
    const ctx = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer(), otherCustomer()],
      lots: [lot(LOT_ID, "A-1"), lot(OTHER_LOT_ID, "B-2")],
      contracts: [
        makeContract("contracts:c1", CALLER_CUSTOMER_ID, {
          kind: "full_payment",
        }),
        makeContract("contracts:c2", OTHER_CUSTOMER_ID, {
          lotId: OTHER_LOT_ID,
          kind: "full_payment",
        }),
      ],
    });
    const result = (await run(ctx, {})) as { contractId: string }[];
    expect(result).toHaveLength(1);
    expect(result[0]!.contractId).toBe("contracts:c1");
  });

  it("filters out voided contracts (cancelled / in_default DO surface)", async () => {
    const ctx = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      lots: [lot(LOT_ID, "A-1")],
      contracts: [
        makeContract("contracts:c1", CALLER_CUSTOMER_ID, {
          kind: "full_payment",
          state: "active",
          createdAt: T0 - 1000,
        }),
        makeContract("contracts:c2", CALLER_CUSTOMER_ID, {
          kind: "full_payment",
          state: "voided",
          createdAt: T0 - 2000,
        }),
        makeContract("contracts:c3", CALLER_CUSTOMER_ID, {
          kind: "full_payment",
          state: "cancelled",
          createdAt: T0 - 3000,
        }),
      ],
    });
    const result = (await run(ctx, {})) as {
      contractId: string;
      state: string;
    }[];
    const ids = result.map((r) => r.contractId).sort();
    expect(ids).toEqual(["contracts:c1", "contracts:c3"]);
  });

  it("sorts results newest-first by createdAt", async () => {
    const ctx = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      lots: [lot(LOT_ID, "A-1")],
      contracts: [
        makeContract("contracts:older", CALLER_CUSTOMER_ID, {
          kind: "full_payment",
          createdAt: T0 - 10_000,
        }),
        makeContract("contracts:newer", CALLER_CUSTOMER_ID, {
          kind: "full_payment",
          createdAt: T0 - 1000,
        }),
      ],
    });
    const result = (await run(ctx, {})) as { contractId: string }[];
    expect(result[0]!.contractId).toBe("contracts:newer");
    expect(result[1]!.contractId).toBe("contracts:older");
  });
});

describe("portal.listCustomerContracts — balance + schedule", () => {
  const run = handlerOf(listCustomerContracts);

  it("computes outstandingBalance = total − Σ non-voided payments", async () => {
    const ctx = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      lots: [lot(LOT_ID, "A-1")],
      contracts: [
        makeContract("contracts:c1", CALLER_CUSTOMER_ID, {
          kind: "full_payment",
          totalPriceCents: 500_000,
        }),
      ],
      payments: [
        makePayment("payments:p1", "contracts:c1", 150_000, false),
        makePayment("payments:p2", "contracts:c1", 100_000, false),
        makePayment("payments:pVoided", "contracts:c1", 999_999, true),
      ],
    });
    const result = (await run(ctx, {})) as {
      outstandingBalanceCents: number;
    }[];
    expect(result[0]!.outstandingBalanceCents).toBe(250_000);
  });

  it("never returns a negative balance (cap at 0)", async () => {
    const ctx = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      lots: [lot(LOT_ID, "A-1")],
      contracts: [
        makeContract("contracts:c1", CALLER_CUSTOMER_ID, {
          kind: "full_payment",
          totalPriceCents: 100_000,
        }),
      ],
      payments: [
        makePayment("payments:p1", "contracts:c1", 999_999, false),
      ],
    });
    const result = (await run(ctx, {})) as {
      outstandingBalanceCents: number;
    }[];
    expect(result[0]!.outstandingBalanceCents).toBe(0);
  });

  it("surfaces nextDueDate and remainingInstallments for installment contracts", async () => {
    const due1 = T0 + 30 * 24 * HOUR_MS;
    const due2 = T0 + 60 * 24 * HOUR_MS;
    const due3 = T0 + 90 * 24 * HOUR_MS;
    const ctx = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      lots: [lot(LOT_ID, "A-1")],
      contracts: [
        makeContract("contracts:c1", CALLER_CUSTOMER_ID, {
          kind: "installment",
        }),
      ],
      installments: [
        makeInstallment(
          "installments:i1",
          "contracts:c1",
          1,
          due1,
          "paid",
          100_000,
        ),
        makeInstallment("installments:i2", "contracts:c1", 2, due2, "pending"),
        makeInstallment("installments:i3", "contracts:c1", 3, due3, "pending"),
      ],
    });
    const result = (await run(ctx, {})) as {
      nextDueDate?: number;
      remainingInstallments?: number;
      totalInstallments?: number;
    }[];
    expect(result[0]!.totalInstallments).toBe(3);
    expect(result[0]!.remainingInstallments).toBe(2);
    expect(result[0]!.nextDueDate).toBe(due2);
  });

  it("omits nextDueDate / remainingInstallments for full-payment contracts", async () => {
    const ctx = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      lots: [lot(LOT_ID, "A-1")],
      contracts: [
        makeContract("contracts:c1", CALLER_CUSTOMER_ID, {
          kind: "full_payment",
        }),
      ],
    });
    const result = (await run(ctx, {})) as Record<string, unknown>[];
    expect(result[0]!.nextDueDate).toBeUndefined();
    expect(result[0]!.remainingInstallments).toBeUndefined();
    expect(result[0]!.totalInstallments).toBeUndefined();
  });
});

describe("portal.getCustomerContractDetail — ownership + 404", () => {
  const run = handlerOf(getCustomerContractDetail);

  it("returns null for unknown contract id (404 path)", async () => {
    const ctx = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    const result = await run(ctx, { contractId: "contracts:missing" });
    expect(result).toBeNull();
  });

  it("returns null when the contract belongs to ANOTHER customer (404, not 403)", async () => {
    const ctx = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer(), otherCustomer()],
      lots: [lot(OTHER_LOT_ID, "B-2")],
      contracts: [
        makeContract("contracts:c2", OTHER_CUSTOMER_ID, {
          lotId: OTHER_LOT_ID,
          kind: "full_payment",
        }),
      ],
    });
    const result = await run(ctx, { contractId: "contracts:c2" });
    expect(result).toBeNull();
  });

  it("returns the header + lot + schedule for an owned contract", async () => {
    const ctx = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      lots: [lot(LOT_ID, "A-1")],
      contracts: [
        makeContract("contracts:c1", CALLER_CUSTOMER_ID, {
          kind: "installment",
          totalPriceCents: 400_000,
        }),
      ],
      installments: [
        makeInstallment(
          "installments:i1",
          "contracts:c1",
          1,
          T0 + 30 * 24 * HOUR_MS,
        ),
        makeInstallment(
          "installments:i2",
          "contracts:c1",
          2,
          T0 + 60 * 24 * HOUR_MS,
        ),
      ],
      payments: [makePayment("payments:p1", "contracts:c1", 100_000)],
    });
    const result = (await run(ctx, { contractId: "contracts:c1" })) as {
      contract: { contractId: string; outstandingBalanceCents: number };
      lot: { lotId: string; code: string } | null;
      schedule: { installmentNumber: number }[];
    };
    expect(result.contract.contractId).toBe("contracts:c1");
    expect(result.contract.outstandingBalanceCents).toBe(300_000);
    expect(result.lot?.code).toBe("A-1");
    expect(result.schedule.map((s) => s.installmentNumber)).toEqual([1, 2]);
  });

  it("lot ref does NOT include the polygon vertex array (customer-portal scope reduction)", async () => {
    const ctx = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      lots: [lot(LOT_ID, "A-1")],
      contracts: [
        makeContract("contracts:c1", CALLER_CUSTOMER_ID, {
          kind: "full_payment",
        }),
      ],
    });
    const result = (await run(ctx, { contractId: "contracts:c1" })) as {
      lot: Record<string, unknown> | null;
    };
    expect(result.lot).not.toBeNull();
    expect(Object.keys(result.lot!).sort()).toEqual(
      ["block", "centroid", "code", "lotId", "row", "section"].sort(),
    );
    expect("polygon" in (result.lot as object)).toBe(false);
  });

  it("returns an empty schedule for full-payment contracts", async () => {
    const ctx = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      lots: [lot(LOT_ID, "A-1")],
      contracts: [
        makeContract("contracts:c1", CALLER_CUSTOMER_ID, {
          kind: "full_payment",
        }),
      ],
    });
    const result = (await run(ctx, { contractId: "contracts:c1" })) as {
      schedule: unknown[];
    };
    expect(result.schedule).toEqual([]);
  });
});

describe("portal.listCustomerPayments — ownership + sort", () => {
  const run = handlerOf(listCustomerPayments);

  it("returns [] when the contract belongs to another customer", async () => {
    const ctx = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer(), otherCustomer()],
      lots: [lot(OTHER_LOT_ID, "B-2")],
      contracts: [
        makeContract("contracts:c2", OTHER_CUSTOMER_ID, {
          lotId: OTHER_LOT_ID,
          kind: "full_payment",
        }),
      ],
      payments: [makePayment("payments:p1", "contracts:c2", 50_000)],
    });
    const result = (await run(ctx, { contractId: "contracts:c2" })) as unknown[];
    expect(result).toEqual([]);
  });

  it("returns [] for unknown contract id", async () => {
    const ctx = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    const result = (await run(ctx, {
      contractId: "contracts:missing",
    })) as unknown[];
    expect(result).toEqual([]);
  });

  it("returns payments newest-first by _creationTime", async () => {
    const ctx = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      lots: [lot(LOT_ID, "A-1")],
      contracts: [
        makeContract("contracts:c1", CALLER_CUSTOMER_ID, {
          kind: "installment",
        }),
      ],
      payments: [
        makePayment("payments:older", "contracts:c1", 50_000, false, T0 - 5000),
        makePayment("payments:newer", "contracts:c1", 60_000, false, T0 - 100),
      ],
    });
    const result = (await run(ctx, { contractId: "contracts:c1" })) as {
      paymentId: string;
    }[];
    expect(result[0]!.paymentId).toBe("payments:newer");
    expect(result[1]!.paymentId).toBe("payments:older");
  });

  it("hydrates receiptNumber from the receipts table when present", async () => {
    const ctx = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      lots: [lot(LOT_ID, "A-1")],
      contracts: [
        makeContract("contracts:c1", CALLER_CUSTOMER_ID, {
          kind: "installment",
        }),
      ],
      payments: [makePayment("payments:p1", "contracts:c1", 50_000)],
      receipts: [
        {
          _id: "receipts:r1",
          _creationTime: T0,
          paymentId: "payments:p1",
          receiptNumber: "OR-0000123",
        },
      ],
    });
    const result = (await run(ctx, { contractId: "contracts:c1" })) as {
      receiptNumber?: string;
      receiptId?: string;
    }[];
    expect(result[0]!.receiptNumber).toBe("OR-0000123");
    expect(result[0]!.receiptId).toBe("receipts:r1");
  });

  it("honours the optional limit arg", async () => {
    const payments = Array.from({ length: 25 }, (_, i) =>
      makePayment(`payments:p${i}`, "contracts:c1", 10_000, false, T0 - i),
    );
    const ctx = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      lots: [lot(LOT_ID, "A-1")],
      contracts: [
        makeContract("contracts:c1", CALLER_CUSTOMER_ID, {
          kind: "installment",
        }),
      ],
      payments,
    });
    const result = (await run(ctx, {
      contractId: "contracts:c1",
      limit: 5,
    })) as unknown[];
    expect(result).toHaveLength(5);
  });

  it("does NOT include the staff-internal receivedByUserId in the row shape", async () => {
    const ctx = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      lots: [lot(LOT_ID, "A-1")],
      contracts: [
        makeContract("contracts:c1", CALLER_CUSTOMER_ID, {
          kind: "installment",
        }),
      ],
      payments: [makePayment("payments:p1", "contracts:c1", 50_000)],
    });
    const result = (await run(ctx, { contractId: "contracts:c1" })) as Record<
      string,
      unknown
    >[];
    expect(result[0]!.receivedByUserId).toBeUndefined();
  });
});
