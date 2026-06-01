/**
 * Story 9.3 — `convex/portal.ts` receipt-download tests.
 *
 * Three Convex surfaces under test:
 *
 *   1. `listCustomerReceipts` — receipt index for the calling customer.
 *      Asserts role gating, ownership scoping (only the customer's own
 *      receipts surface), voided-contract filtering, and the newest-
 *      first sort order.
 *
 *   2. `getCustomerReceiptPdfUrl` — ownership-gated signed-URL bridge
 *      to Story 3.13's `pdfStorageId`. Asserts the receipt → payment →
 *      contract → customer ownership walk, the `ready` flag behaviour
 *      while the PDF is still rendering, and 404-over-403 on non-
 *      ownership.
 *
 *   3. `requestCustomerReceiptPdf` — customer-side wrapper that
 *      schedules the Story 3.13 action. Asserts the same ownership
 *      walk, the `"ready" | "scheduled" | "not_found"` outcomes, and
 *      that the scheduler is only kicked when ownership passes.
 *
 * Coverage target: ≥ 95% line + branch (NFR-M2 commitment carried over
 * from Story 9.1 / 9.2). Hand-mocked ctx mirrors
 * `portal-contracts.test.ts` so the four tables we touch — contracts
 * (by_customer), payments (by_contract), receipts (by_payment), plus
 * the `_id`-level `ctx.db.get` lookups — all behave consistently.
 *
 * The mock also exposes `ctx.storage.getUrl` (so the URL query can
 * return a signed-URL string) and `ctx.scheduler.runAfter` (so the
 * mutation can record the PDF-generation kick).
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
  getCustomerReceiptPdfUrl,
  listCustomerReceipts,
  requestCustomerReceiptPdf,
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
}

interface PaymentFixture {
  _id: string;
  _creationTime: number;
  paymentNumber: string;
  contractId?: string;
  customerId?: string;
  amountCents: number;
  paymentMethod: "cash";
  receivedAt: number;
  isVoided: boolean;
}

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
  pdfStorageId?: string;
  pdfGeneratedAt?: number;
}

function makeCtx(opts: {
  roles?: RoleName[];
  callerEmail?: string;
  authenticated?: boolean;
  customers?: CustomerFixture[];
  contracts?: ContractFixture[];
  payments?: PaymentFixture[];
  receipts?: ReceiptFixture[];
  storageUrls?: Record<string, string | null>;
}) {
  const customers = new Map<string, CustomerFixture>(
    (opts.customers ?? []).map((c) => [c._id, c]),
  );
  const contracts = new Map<string, ContractFixture>(
    (opts.contracts ?? []).map((c) => [c._id, c]),
  );
  const payments = new Map<string, PaymentFixture>(
    (opts.payments ?? []).map((p) => [p._id, p]),
  );
  const receipts = new Map<string, ReceiptFixture>(
    (opts.receipts ?? []).map((r) => [r._id, r]),
  );

  const storageUrls = opts.storageUrls ?? {};
  const scheduled: Array<{
    delayMs: number;
    args: unknown;
  }> = [];

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
    if (table === "contracts") return Array.from(contracts.values()) as never;
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

  // Capture audit-log writes + receipt patches so the Story 9.3
  // NFR-S8-fix mutation paths can be asserted on.
  const auditInserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const receiptPatches: Array<{ id: string; patch: Record<string, unknown> }> =
    [];

  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === CALLER_ID) return callerUser;
        if (id === SESSION_ID) return session;
        if (customers.has(id)) return customers.get(id);
        if (contracts.has(id)) return contracts.get(id);
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
      insert: vi.fn(
        async (table: string, row: Record<string, unknown>) => {
          if (table === "auditLog") {
            auditInserts.push({ table, row });
            return `auditLog:${auditInserts.length}`;
          }
          return `${table}:?`;
        },
      ),
      patch: vi.fn(
        async (id: string, patch: Record<string, unknown>) => {
          receiptPatches.push({ id, patch });
          const existing = receipts.get(id);
          if (existing !== undefined) {
            receipts.set(id, { ...existing, ...patch } as ReceiptFixture);
          }
        },
      ),
    },
    storage: {
      getUrl: vi.fn(async (sid: string) => {
        if (sid in storageUrls) return storageUrls[sid];
        return `https://example/signed/${sid}`;
      }),
    },
    scheduler: {
      runAfter: vi.fn(
        async (delayMs: number, _fnRef: unknown, args: unknown) => {
          scheduled.push({ delayMs, args });
        },
      ),
      runAt: vi.fn(),
    },
  };

  return { ctx, receipts, scheduled, auditInserts, receiptPatches };
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

function makeContract(
  id: string,
  customerId: string,
  overrides: Partial<ContractFixture> = {},
): ContractFixture {
  return {
    _id: id,
    _creationTime: T0 - 500,
    contractNumber: `CN-${id}`,
    lotId: LOT_ID,
    customerId,
    kind: "full_payment",
    totalPriceCents: 1_000_000,
    state: overrides.state ?? "active",
    createdAt: overrides.createdAt ?? T0 - 1000,
    ...overrides,
  };
}

function makePayment(
  id: string,
  contractId: string,
  receivedAt = T0 - 500,
): PaymentFixture {
  return {
    _id: id,
    _creationTime: receivedAt,
    paymentNumber: `P-${id}`,
    contractId,
    customerId: CALLER_CUSTOMER_ID,
    amountCents: 100_000,
    paymentMethod: "cash",
    receivedAt,
    isVoided: false,
  };
}

function makeReceipt(
  id: string,
  paymentId: string,
  overrides: Partial<ReceiptFixture> = {},
): ReceiptFixture {
  return {
    _id: id,
    _creationTime: T0,
    paymentId,
    receiptSeries: "OR-",
    receiptNumber: overrides.receiptNumber ?? `OR-${id}`,
    receiptSerial: overrides.receiptSerial ?? 1,
    amountCents: overrides.amountCents ?? 100_000,
    issuedAt: overrides.issuedAt ?? T0,
    issuedByUserId: "users:staff",
    isVoided: overrides.isVoided ?? false,
    ...(overrides.voidedAt !== undefined ? { voidedAt: overrides.voidedAt } : {}),
    ...(overrides.pdfStorageId !== undefined
      ? { pdfStorageId: overrides.pdfStorageId }
      : {}),
    ...(overrides.pdfGeneratedAt !== undefined
      ? { pdfGeneratedAt: overrides.pdfGeneratedAt }
      : {}),
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

// ---------------------------------------------------------------------------
// listCustomerReceipts
// ---------------------------------------------------------------------------

describe("portal.listCustomerReceipts — auth", () => {
  const run = handlerOf(listCustomerReceipts);

  it("throws FORBIDDEN for office_staff", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      callerEmail: "staff@example.com",
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("throws FORBIDDEN for admin", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      callerEmail: "admin@example.com",
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("throws UNAUTHENTICATED when no session", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("throws NOT_FOUND when no customer row links to the auth email", async () => {
    const { ctx } = makeCtx({
      callerEmail: "nobody@example.com",
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });
});

describe("portal.listCustomerReceipts — ownership scoping", () => {
  const run = handlerOf(listCustomerReceipts);

  it("returns [] when the customer has 0 contracts", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    const result = (await run(ctx, {})) as unknown[];
    expect(result).toEqual([]);
  });

  it("returns [] when the customer's contracts have no receipts yet", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      contracts: [makeContract("contracts:c1", CALLER_CUSTOMER_ID)],
      payments: [makePayment("payments:p1", "contracts:c1")],
      // no receipts
    });
    const result = (await run(ctx, {})) as unknown[];
    expect(result).toEqual([]);
  });

  it("returns ONLY the calling customer's receipts (other customers' receipts MUST NOT leak)", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer(), otherCustomer()],
      contracts: [
        makeContract("contracts:mine", CALLER_CUSTOMER_ID),
        makeContract("contracts:theirs", OTHER_CUSTOMER_ID),
      ],
      payments: [
        makePayment("payments:p-mine", "contracts:mine"),
        makePayment("payments:p-theirs", "contracts:theirs"),
      ],
      receipts: [
        makeReceipt("receipts:r-mine", "payments:p-mine"),
        makeReceipt("receipts:r-theirs", "payments:p-theirs"),
      ],
    });
    const result = (await run(ctx, {})) as { receiptId: string }[];
    expect(result).toHaveLength(1);
    expect(result[0]!.receiptId).toBe("receipts:r-mine");
  });

  it("filters out receipts on voided contracts", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      contracts: [
        makeContract("contracts:active", CALLER_CUSTOMER_ID),
        makeContract("contracts:voided", CALLER_CUSTOMER_ID, {
          state: "voided",
        }),
      ],
      payments: [
        makePayment("payments:p-active", "contracts:active"),
        makePayment("payments:p-voided-contract", "contracts:voided"),
      ],
      receipts: [
        makeReceipt("receipts:r-active", "payments:p-active"),
        makeReceipt("receipts:r-on-voided", "payments:p-voided-contract"),
      ],
    });
    const result = (await run(ctx, {})) as { receiptId: string }[];
    const ids = result.map((r) => r.receiptId);
    expect(ids).toEqual(["receipts:r-active"]);
  });

  it("INCLUDES voided RECEIPTS (only voided CONTRACTS are filtered)", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      contracts: [makeContract("contracts:c1", CALLER_CUSTOMER_ID)],
      payments: [makePayment("payments:p1", "contracts:c1")],
      receipts: [
        makeReceipt("receipts:r-voided", "payments:p1", {
          isVoided: true,
          voidedAt: T0 - 100,
        }),
      ],
    });
    const result = (await run(ctx, {})) as {
      receiptId: string;
      isVoided: boolean;
      voidedAt: number | null;
    }[];
    expect(result).toHaveLength(1);
    expect(result[0]!.isVoided).toBe(true);
    expect(result[0]!.voidedAt).toBe(T0 - 100);
  });

  it("sorts results newest-first by issuedAt", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      contracts: [makeContract("contracts:c1", CALLER_CUSTOMER_ID)],
      payments: [
        makePayment("payments:p1", "contracts:c1"),
        makePayment("payments:p2", "contracts:c1"),
      ],
      receipts: [
        makeReceipt("receipts:older", "payments:p1", {
          issuedAt: T0 - 10_000,
          receiptSerial: 1,
        }),
        makeReceipt("receipts:newer", "payments:p2", {
          issuedAt: T0 - 100,
          receiptSerial: 2,
        }),
      ],
    });
    const result = (await run(ctx, {})) as { receiptId: string }[];
    expect(result[0]!.receiptId).toBe("receipts:newer");
    expect(result[1]!.receiptId).toBe("receipts:older");
  });

  it("hydrates the contract number on each row", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      contracts: [
        makeContract("contracts:c1", CALLER_CUSTOMER_ID, {
          contractNumber: "CN-0042",
        } as Partial<ContractFixture>),
      ],
      payments: [makePayment("payments:p1", "contracts:c1")],
      receipts: [makeReceipt("receipts:r1", "payments:p1")],
    });
    const result = (await run(ctx, {})) as { contractNumber: string | null }[];
    expect(result[0]!.contractNumber).toBe("CN-0042");
  });

  it("derives pdfReady from pdfStorageId presence", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      contracts: [makeContract("contracts:c1", CALLER_CUSTOMER_ID)],
      payments: [
        makePayment("payments:p-ready", "contracts:c1"),
        makePayment("payments:p-pending", "contracts:c1"),
      ],
      receipts: [
        makeReceipt("receipts:r-ready", "payments:p-ready", {
          pdfStorageId: "_storage:s1",
          pdfGeneratedAt: T0 - 100,
        }),
        makeReceipt("receipts:r-pending", "payments:p-pending"),
      ],
    });
    const result = (await run(ctx, {})) as {
      receiptId: string;
      pdfReady: boolean;
    }[];
    const byId = new Map(result.map((r) => [r.receiptId, r.pdfReady]));
    expect(byId.get("receipts:r-ready")).toBe(true);
    expect(byId.get("receipts:r-pending")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getCustomerReceiptPdfUrl
// ---------------------------------------------------------------------------

describe("portal.getCustomerReceiptPdfUrl — auth + ownership", () => {
  const run = handlerOf(getCustomerReceiptPdfUrl);

  it("throws FORBIDDEN for office_staff", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      callerEmail: "staff@example.com",
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, {
      receiptId: "receipts:r1",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("returns null when the receipt does not exist", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    const result = await run(ctx, { receiptId: "receipts:missing" });
    expect(result).toBeNull();
  });

  it("returns null when the receipt belongs to another customer (404, not 403)", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer(), otherCustomer()],
      contracts: [makeContract("contracts:theirs", OTHER_CUSTOMER_ID)],
      payments: [makePayment("payments:p-theirs", "contracts:theirs")],
      receipts: [
        makeReceipt("receipts:r-theirs", "payments:p-theirs", {
          pdfStorageId: "_storage:s-theirs",
        }),
      ],
    });
    const result = await run(ctx, { receiptId: "receipts:r-theirs" });
    expect(result).toBeNull();
  });

  it("returns null when the receipt's payment row is missing", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      receipts: [
        makeReceipt("receipts:orphan", "payments:gone", {
          pdfStorageId: "_storage:s1",
        }),
      ],
    });
    const result = await run(ctx, { receiptId: "receipts:orphan" });
    expect(result).toBeNull();
  });

  it("returns null when the payment has no contractId", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      payments: [
        {
          _id: "payments:no-contract",
          _creationTime: T0,
          paymentNumber: "P-orphan",
          // contractId intentionally absent
          amountCents: 1000,
          paymentMethod: "cash",
          receivedAt: T0,
          isVoided: false,
        },
      ],
      receipts: [
        makeReceipt("receipts:r1", "payments:no-contract", {
          pdfStorageId: "_storage:s1",
        }),
      ],
    });
    const result = await run(ctx, { receiptId: "receipts:r1" });
    expect(result).toBeNull();
  });
});

describe("portal.getCustomerReceiptPdfUrl — pdf ready state", () => {
  const run = handlerOf(getCustomerReceiptPdfUrl);

  it("returns ready=false with url=null while the PDF has not been generated yet", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      contracts: [makeContract("contracts:c1", CALLER_CUSTOMER_ID)],
      payments: [makePayment("payments:p1", "contracts:c1")],
      receipts: [
        makeReceipt("receipts:r-pending", "payments:p1", {
          receiptNumber: "OR-0000001",
        }),
      ],
    });
    const result = (await run(ctx, {
      receiptId: "receipts:r-pending",
    })) as {
      url: string | null;
      ready: boolean;
      receiptNumber: string;
    };
    expect(result).not.toBeNull();
    expect(result.ready).toBe(false);
    expect(result.url).toBeNull();
    expect(result.receiptNumber).toBe("OR-0000001");
  });

  it("returns the signed URL when the PDF is ready and owned by the caller", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      contracts: [makeContract("contracts:c1", CALLER_CUSTOMER_ID)],
      payments: [makePayment("payments:p1", "contracts:c1")],
      receipts: [
        makeReceipt("receipts:r-ready", "payments:p1", {
          pdfStorageId: "_storage:pdf-ready",
          pdfGeneratedAt: T0 - 100,
        }),
      ],
      storageUrls: { "_storage:pdf-ready": "https://signed/pdf-ready" },
    });
    const result = (await run(ctx, {
      receiptId: "receipts:r-ready",
    })) as {
      url: string | null;
      ready: boolean;
      generatedAt: number | null;
    };
    expect(result.url).toBe("https://signed/pdf-ready");
    expect(result.ready).toBe(true);
    expect(result.generatedAt).toBe(T0 - 100);
  });

  it("returns ready=false when storage.getUrl resolves to null (defensive)", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      contracts: [makeContract("contracts:c1", CALLER_CUSTOMER_ID)],
      payments: [makePayment("payments:p1", "contracts:c1")],
      receipts: [
        makeReceipt("receipts:r1", "payments:p1", {
          pdfStorageId: "_storage:gone",
        }),
      ],
      storageUrls: { "_storage:gone": null },
    });
    const result = (await run(ctx, {
      receiptId: "receipts:r1",
    })) as { url: string | null; ready: boolean };
    expect(result.url).toBeNull();
    expect(result.ready).toBe(false);
  });

  it("only calls ctx.storage.getUrl AFTER the ownership check passes", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer(), otherCustomer()],
      contracts: [makeContract("contracts:theirs", OTHER_CUSTOMER_ID)],
      payments: [makePayment("payments:p-theirs", "contracts:theirs")],
      receipts: [
        makeReceipt("receipts:r-theirs", "payments:p-theirs", {
          pdfStorageId: "_storage:premint",
        }),
      ],
      storageUrls: { "_storage:premint": "https://signed/premint" },
    });
    const result = await run(ctx, { receiptId: "receipts:r-theirs" });
    expect(result).toBeNull();
    expect(ctx.storage.getUrl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// requestCustomerReceiptPdf
// ---------------------------------------------------------------------------

describe("portal.requestCustomerReceiptPdf — auth + ownership", () => {
  const run = handlerOf(requestCustomerReceiptPdf);

  it("throws FORBIDDEN for office_staff", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      callerEmail: "staff@example.com",
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, {
      receiptId: "receipts:r1",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("returns not_found when the receipt does not exist", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    const result = (await run(ctx, { receiptId: "receipts:missing" })) as {
      status: string;
    };
    expect(result.status).toBe("not_found");
  });

  it("returns not_found when the receipt belongs to another customer", async () => {
    const { ctx, scheduled } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer(), otherCustomer()],
      contracts: [makeContract("contracts:theirs", OTHER_CUSTOMER_ID)],
      payments: [makePayment("payments:p-theirs", "contracts:theirs")],
      receipts: [makeReceipt("receipts:r-theirs", "payments:p-theirs")],
    });
    const result = (await run(ctx, {
      receiptId: "receipts:r-theirs",
    })) as { status: string };
    expect(result.status).toBe("not_found");
    // Non-ownership MUST NOT enqueue any scheduler work.
    expect(scheduled).toHaveLength(0);
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });

  it("returns not_found when the payment row is missing", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      receipts: [makeReceipt("receipts:orphan", "payments:gone")],
    });
    const result = (await run(ctx, {
      receiptId: "receipts:orphan",
    })) as { status: string };
    expect(result.status).toBe("not_found");
  });

  it("returns not_found when the payment has no contractId", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      payments: [
        {
          _id: "payments:no-contract",
          _creationTime: T0,
          paymentNumber: "P-orphan",
          amountCents: 1000,
          paymentMethod: "cash",
          receivedAt: T0,
          isVoided: false,
        },
      ],
      receipts: [makeReceipt("receipts:r1", "payments:no-contract")],
    });
    const result = (await run(ctx, {
      receiptId: "receipts:r1",
    })) as { status: string };
    expect(result.status).toBe("not_found");
  });

  it("returns not_found when the contract row is missing", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      payments: [makePayment("payments:p1", "contracts:gone")],
      receipts: [makeReceipt("receipts:r1", "payments:p1")],
    });
    const result = (await run(ctx, {
      receiptId: "receipts:r1",
    })) as { status: string };
    expect(result.status).toBe("not_found");
  });
});

describe("portal.requestCustomerReceiptPdf — happy path", () => {
  const run = handlerOf(requestCustomerReceiptPdf);

  it("returns 'ready' (no scheduler kick) when the receipt already has a pdfStorageId", async () => {
    const { ctx, scheduled } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      contracts: [makeContract("contracts:c1", CALLER_CUSTOMER_ID)],
      payments: [makePayment("payments:p1", "contracts:c1")],
      receipts: [
        makeReceipt("receipts:r-ready", "payments:p1", {
          pdfStorageId: "_storage:s1",
          pdfGeneratedAt: T0 - 100,
        }),
      ],
    });
    const result = (await run(ctx, {
      receiptId: "receipts:r-ready",
    })) as { status: string };
    expect(result.status).toBe("ready");
    expect(scheduled).toHaveLength(0);
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });

  it("returns 'scheduled' and kicks the scheduler when no PDF exists yet", async () => {
    const { ctx, scheduled } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      contracts: [makeContract("contracts:c1", CALLER_CUSTOMER_ID)],
      payments: [makePayment("payments:p1", "contracts:c1")],
      receipts: [makeReceipt("receipts:r-pending", "payments:p1")],
    });
    const result = (await run(ctx, {
      receiptId: "receipts:r-pending",
    })) as { status: string; receiptId: string };
    expect(result.status).toBe("scheduled");
    expect(result.receiptId).toBe("receipts:r-pending");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.delayMs).toBe(0);
    expect(scheduled[0]!.args).toEqual({ receiptId: "receipts:r-pending" });
  });
});

// ---------------------------------------------------------------------------
// Story 9.3 NFR-S8 fix — receipt-download audit + downloadCount bump.
// ---------------------------------------------------------------------------

describe("portal.getCustomerReceiptPdfUrl — audit + downloadCount (Story 9.3 NFR-S8 fix)", () => {
  const run = handlerOf(getCustomerReceiptPdfUrl);

  it("emits a read_pii audit row + bumps downloadCount on success", async () => {
    const { ctx, auditInserts, receiptPatches } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      contracts: [makeContract("contracts:c1", CALLER_CUSTOMER_ID)],
      payments: [makePayment("payments:p1", "contracts:c1")],
      receipts: [
        makeReceipt("receipts:r-ready", "payments:p1", {
          pdfStorageId: "_storage:pdf-ready",
          pdfGeneratedAt: T0 - 100,
        }),
      ],
      storageUrls: { "_storage:pdf-ready": "https://signed/pdf-ready" },
    });
    const out = (await run(ctx, { receiptId: "receipts:r-ready" })) as {
      url: string | null;
    };
    expect(out.url).toBe("https://signed/pdf-ready");
    // Audit row.
    expect(auditInserts).toHaveLength(1);
    const audit = auditInserts[0]!.row;
    expect(audit.action).toBe("read_pii");
    expect(audit.entityType).toBe("receipt");
    expect(audit.entityId).toBe("receipts:r-ready");
    // Counter bump.
    expect(receiptPatches).toHaveLength(1);
    expect(receiptPatches[0]!.id).toBe("receipts:r-ready");
    expect(receiptPatches[0]!.patch.downloadCount).toBe(1);
  });

  it("emits a read_pii audit row but does NOT bump downloadCount when PDF not yet generated", async () => {
    const { ctx, auditInserts, receiptPatches } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      contracts: [makeContract("contracts:c1", CALLER_CUSTOMER_ID)],
      payments: [makePayment("payments:p1", "contracts:c1")],
      receipts: [makeReceipt("receipts:r-pending", "payments:p1")],
    });
    const out = (await run(ctx, { receiptId: "receipts:r-pending" })) as {
      ready: boolean;
    };
    expect(out.ready).toBe(false);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]!.row.action).toBe("read_pii");
    expect(auditInserts[0]!.row.entityType).toBe("receipt");
    // No counter bump on a pending render.
    expect(receiptPatches).toHaveLength(0);
  });

  it("does NOT emit audit on ownership miss (existence-enumeration defence)", async () => {
    const { ctx, auditInserts, receiptPatches } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer(), otherCustomer()],
      contracts: [makeContract("contracts:theirs", OTHER_CUSTOMER_ID)],
      payments: [makePayment("payments:p-theirs", "contracts:theirs")],
      receipts: [
        makeReceipt("receipts:r-theirs", "payments:p-theirs", {
          pdfStorageId: "_storage:s",
        }),
      ],
    });
    const result = await run(ctx, { receiptId: "receipts:r-theirs" });
    expect(result).toBeNull();
    expect(auditInserts).toHaveLength(0);
    expect(receiptPatches).toHaveLength(0);
  });
});

describe("portal.requestCustomerReceiptPdf — audit (Story 9.3 NFR-S8 fix)", () => {
  const run = handlerOf(requestCustomerReceiptPdf);

  it("emits a create audit row when scheduling a fresh render", async () => {
    const { ctx, auditInserts } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      contracts: [makeContract("contracts:c1", CALLER_CUSTOMER_ID)],
      payments: [makePayment("payments:p1", "contracts:c1")],
      receipts: [makeReceipt("receipts:r-fresh", "payments:p1")],
    });
    await run(ctx, { receiptId: "receipts:r-fresh" });
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]!.row.action).toBe("create");
    expect(auditInserts[0]!.row.entityType).toBe("receipt");
    expect(auditInserts[0]!.row.entityId).toBe("receipts:r-fresh");
  });

  it("emits a create audit row on the 'ready' short-circuit too", async () => {
    const { ctx, auditInserts } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      contracts: [makeContract("contracts:c1", CALLER_CUSTOMER_ID)],
      payments: [makePayment("payments:p1", "contracts:c1")],
      receipts: [
        makeReceipt("receipts:r-already", "payments:p1", {
          pdfStorageId: "_storage:s",
          pdfGeneratedAt: T0,
        }),
      ],
    });
    const out = (await run(ctx, { receiptId: "receipts:r-already" })) as {
      status: string;
    };
    expect(out.status).toBe("ready");
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]!.row.action).toBe("create");
  });
});
