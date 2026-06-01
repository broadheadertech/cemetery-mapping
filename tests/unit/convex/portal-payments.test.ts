/**
 * Story 9.5 + 9.6 — `convex/portal.ts` payment-intent + webhook tests.
 *
 * Three Convex surfaces under test:
 *
 *   1. `createGatewayPaymentIntent` — customer-role mutation. Asserts
 *      role gating, ownership scoping (cross-customer contract → 404
 *      via NOT_FOUND), amount validation (positive integer ≤
 *      outstanding balance), contract-state guard, intent-id minting,
 *      audit emission, and the deferred action schedule.
 *
 *   2. `getCustomerPaymentIntent` — customer-role reactive query.
 *      Asserts the ownership filter (other customer's intent → null),
 *      the narrow projection shape, and the redirectUrl hiding on
 *      non-pending state.
 *
 *   3. `handleGatewayWebhook` — internal mutation. Asserts:
 *      - idempotency: re-running with the same intent does NOT
 *        double-post (single payment + single receipt + single audit
 *        row).
 *      - cross-gateway defence: a webhook arriving with
 *        `gateway: "maya"` against a `gcash` intent throws
 *        INVARIANT_VIOLATION.
 *      - amount-mismatch defence: webhook amount ≠ intent amount
 *        throws INVARIANT_VIOLATION.
 *      - failure path: failed status patches the row without writing
 *        a payment.
 *      - unknown status: no state change, no financial write.
 *      - happy path: payment + receipt + allocation rows inserted via
 *        postFinancialEvent; row patched to succeeded.
 *
 * Coverage target: ≥ 95% line + branch on `handleGatewayWebhook` and
 * the two customer-facing mutations (NFR-M2 commitment carried over
 * from Stories 9.1 / 9.2 / 9.3 / 9.4).
 *
 * The hand-mocked ctx mirrors the `portal-receipts.test.ts` shape so
 * the test fixture style stays consistent across the Story 9.x test
 * files. We mock the receipt-counter helpers so `postFinancialEvent`
 * can mint serials without touching the real `convex/lib/receiptCounter`
 * module (whose helpers expect a fully-fledged Convex env).
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
  createGatewayPaymentIntent,
  getCustomerPaymentIntent,
  handleGatewayWebhook,
} from "../../../convex/portal";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const CALLER_ID = "users:u1";
const SESSION_ID = "authSessions:s1";
const CALLER_EMAIL = "maria@example.com";
const CALLER_CUSTOMER_ID = "customers:c1";
const OTHER_CUSTOMER_ID = "customers:c2";

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

interface PaymentIntentFixture {
  _id: string;
  _creationTime: number;
  provider: "gcash" | "maya" | "card";
  intentId: string;
  customerId: string;
  contractId: string;
  amountCents: number;
  status: "pending" | "succeeded" | "failed" | "expired";
  createdAt: number;
  completedAt?: number;
  paymentId?: string;
  gatewayTransactionId?: string;
  redirectUrl?: string;
  gatewayIntentId?: string;
  failureReason?: string;
}

interface PaymentFixture {
  _id: string;
  _creationTime: number;
  paymentNumber: string;
  contractId?: string;
  customerId?: string;
  amountCents: number;
  paymentMethod: string;
  reference?: string;
  receivedAt: number;
  receivedByUserId: string;
  idempotencyKey: string;
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
}

interface AllocationFixture {
  _id: string;
  _creationTime: number;
  paymentId: string;
  targetType: string;
  targetId: string;
  amountCents: number;
  sequence: number;
}

interface AuditRow {
  actor: string;
  timestamp: number;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

interface ReceiptCounterRow {
  _id: string;
  _creationTime: number;
  currentSerial: number;
  startingSerial: number;
  prefix: string;
  seededAt: number;
}

let nextId = 1;
function freshId(table: string): string {
  return `${table}:${nextId++}`;
}

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
    lotId: "lots:l1",
    customerId,
    kind: "full_payment",
    totalPriceCents: 1_000_000,
    state: "active",
    createdAt: T0 - 1000,
    ...overrides,
  };
}

interface CtxOpts {
  roles?: RoleName[];
  callerEmail?: string;
  authenticated?: boolean;
  customers?: CustomerFixture[];
  contracts?: ContractFixture[];
  paymentIntents?: PaymentIntentFixture[];
  payments?: PaymentFixture[];
  receipts?: ReceiptFixture[];
  paymentAllocations?: AllocationFixture[];
  receiptCounter?: ReceiptCounterRow;
}

function makeCtx(opts: CtxOpts) {
  const customers = new Map<string, CustomerFixture>(
    (opts.customers ?? []).map((c) => [c._id, c]),
  );
  const contracts = new Map<string, ContractFixture>(
    (opts.contracts ?? []).map((c) => [c._id, c]),
  );
  const paymentIntents = new Map<string, PaymentIntentFixture>(
    (opts.paymentIntents ?? []).map((p) => [p._id, p]),
  );
  const payments = new Map<string, PaymentFixture>(
    (opts.payments ?? []).map((p) => [p._id, p]),
  );
  const receipts = new Map<string, ReceiptFixture>(
    (opts.receipts ?? []).map((r) => [r._id, r]),
  );
  const allocations = new Map<string, AllocationFixture>(
    (opts.paymentAllocations ?? []).map((a) => [a._id, a]),
  );
  const counter: ReceiptCounterRow = opts.receiptCounter ?? {
    _id: "receiptCounter:1",
    _creationTime: T0 - 10_000,
    currentSerial: 0,
    startingSerial: 0,
    prefix: "OR-",
    seededAt: T0 - 10_000,
  };
  const counterMap = new Map<string, ReceiptCounterRow>([[counter._id, counter]]);
  const auditRows: AuditRow[] = [];
  const scheduled: Array<{ delayMs: number; args: unknown }> = [];

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
    if (table === "paymentIntents")
      return Array.from(paymentIntents.values()) as never;
    if (table === "payments") return Array.from(payments.values()) as never;
    if (table === "receipts") return Array.from(receipts.values()) as never;
    if (table === "paymentAllocations")
      return Array.from(allocations.values()) as never;
    if (table === "receiptCounter")
      return Array.from(counterMap.values()) as never;
    if (table === "users") return [callerUser as never];
    return [];
  }

  function makeBuilder(table: string) {
    const predicates: Predicate[] = [];
    const builder = {
      withIndex(
        _name: string,
        fn?: (q: {
          eqs: Record<string, unknown>;
          eq: (f: string, v: unknown) => unknown;
        }) => unknown,
      ) {
        if (fn !== undefined) {
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
        }
        return builder;
      },
      async first() {
        const matches = rowsFor(table).filter((r) =>
          predicates.every((p) => p(r)),
        );
        return matches[0] ?? null;
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
        if (contracts.has(id)) return contracts.get(id);
        if (paymentIntents.has(id)) return paymentIntents.get(id);
        if (payments.has(id)) return payments.get(id);
        if (receipts.has(id)) return receipts.get(id);
        if (counterMap.has(id)) return counterMap.get(id);
        return null;
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return {
            withIndex: () => ({ collect: async () => userRoles }),
          };
        }
        // For every other table, makeBuilder returns a builder that
        // supports both `.collect()` (resolveCurrentCustomer reads
        // `customers` without an index) AND `withIndex(...).collect()`.
        // The builder's own `collect` walks every row in the table
        // when no predicates have been registered.
        return makeBuilder(table);
      }),
      insert: vi.fn(
        async (table: string, row: Record<string, unknown>) => {
          if (table === "auditLog") {
            auditRows.push(row as unknown as AuditRow);
            return `auditLog:${auditRows.length}`;
          }
          const id = freshId(table);
          const stamped = { ...row, _id: id, _creationTime: Date.now() } as never;
          if (table === "paymentIntents") {
            paymentIntents.set(id, stamped as unknown as PaymentIntentFixture);
          } else if (table === "payments") {
            payments.set(id, stamped as unknown as PaymentFixture);
          } else if (table === "receipts") {
            receipts.set(id, stamped as unknown as ReceiptFixture);
          } else if (table === "paymentAllocations") {
            allocations.set(id, stamped as unknown as AllocationFixture);
          }
          return id;
        },
      ),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        if (paymentIntents.has(id)) {
          const existing = paymentIntents.get(id)!;
          paymentIntents.set(id, { ...existing, ...patch });
        } else if (payments.has(id)) {
          const existing = payments.get(id)!;
          payments.set(id, { ...existing, ...patch });
        } else if (counterMap.has(id)) {
          const existing = counterMap.get(id)!;
          counterMap.set(id, { ...existing, ...patch });
        }
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

  return {
    ctx,
    customers,
    contracts,
    paymentIntents,
    payments,
    receipts,
    allocations,
    counterMap,
    auditRows,
    scheduled,
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
  nextId = 1;
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// createGatewayPaymentIntent
// ---------------------------------------------------------------------------

describe("portal.createGatewayPaymentIntent — auth gating", () => {
  const run = handlerOf(createGatewayPaymentIntent);

  it("throws UNAUTHENTICATED when no session", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {
      contractId: "contracts:c1",
      amountCents: 100_000,
      gateway: "gcash",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("throws FORBIDDEN for admin role", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      callerEmail: "admin@example.com",
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, {
      contractId: "contracts:c1",
      amountCents: 100_000,
      gateway: "gcash",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("throws FORBIDDEN for office_staff role", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      callerEmail: "staff@example.com",
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, {
      contractId: "contracts:c1",
      amountCents: 100_000,
      gateway: "gcash",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("throws NOT_FOUND when contract does not exist", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, {
      contractId: "contracts:ghost",
      amountCents: 100_000,
      gateway: "gcash",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("returns NOT_FOUND when contract belongs to another customer (existence-enumeration defence)", async () => {
    const otherContract = makeContract("contracts:other", OTHER_CUSTOMER_ID);
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer(), otherCustomer()],
      contracts: [otherContract],
    });
    const thrown = await run(ctx, {
      contractId: otherContract._id,
      amountCents: 100_000,
      gateway: "gcash",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });
});

describe("portal.createGatewayPaymentIntent — validation", () => {
  const run = handlerOf(createGatewayPaymentIntent);

  it("throws INVARIANT_VIOLATION when the contract is not active", async () => {
    const contract = makeContract("contracts:closed", CALLER_CUSTOMER_ID, {
      state: "paid_in_full",
    });
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      contracts: [contract],
    });
    const thrown = await run(ctx, {
      contractId: contract._id,
      amountCents: 100_000,
      gateway: "gcash",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("throws VALIDATION on a zero / negative amount", async () => {
    const contract = makeContract("contracts:c1", CALLER_CUSTOMER_ID);
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      contracts: [contract],
    });
    const thrown = await run(ctx, {
      contractId: contract._id,
      amountCents: 0,
      gateway: "gcash",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("throws VALIDATION when amount exceeds outstanding balance", async () => {
    const contract = makeContract("contracts:c1", CALLER_CUSTOMER_ID, {
      totalPriceCents: 100_000,
    });
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      contracts: [contract],
    });
    const thrown = await run(ctx, {
      contractId: contract._id,
      amountCents: 200_000,
      gateway: "gcash",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });
});

describe("portal.createGatewayPaymentIntent — happy path", () => {
  const run = handlerOf(createGatewayPaymentIntent);

  it("inserts a pending paymentIntent and schedules the action", async () => {
    const contract = makeContract("contracts:c1", CALLER_CUSTOMER_ID);
    const { ctx, paymentIntents, scheduled, auditRows } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      contracts: [contract],
    });
    const result = (await run(ctx, {
      contractId: contract._id,
      amountCents: 100_000,
      gateway: "gcash",
    })) as { paymentIntentId: string };

    expect(result.paymentIntentId).toEqual(expect.any(String));
    expect(result.paymentIntentId.length).toBeGreaterThan(0);

    const inserted = Array.from(paymentIntents.values())[0];
    expect(inserted).toBeDefined();
    expect(inserted?.status).toBe("pending");
    expect(inserted?.amountCents).toBe(100_000);
    expect(inserted?.provider).toBe("gcash");
    expect(inserted?.customerId).toBe(CALLER_CUSTOMER_ID);
    expect(inserted?.intentId).toBe(result.paymentIntentId);

    // Audit emission.
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.action).toBe("create");
    expect(auditRows[0]?.entityType).toBe("payment");

    // Action scheduled.
    expect(scheduled).toHaveLength(1);
    const args = scheduled[0]?.args as Record<string, unknown>;
    expect(args.paymentIntentId).toBe(result.paymentIntentId);
    expect(args.gateway).toBe("gcash");
    expect(args.amountCents).toBe(100_000);
    expect(args.returnUrl).toContain(result.paymentIntentId);
  });

  it("supports maya + card gateways", async () => {
    const contract = makeContract("contracts:c1", CALLER_CUSTOMER_ID);
    for (const gateway of ["maya", "card"] as const) {
      const { ctx, paymentIntents } = makeCtx({
        callerEmail: CALLER_EMAIL,
        customers: [callerCustomer()],
        contracts: [contract],
      });
      await run(ctx, {
        contractId: contract._id,
        amountCents: 50_000,
        gateway,
      });
      const inserted = Array.from(paymentIntents.values())[0];
      expect(inserted?.provider).toBe(gateway);
    }
  });
});

// ---------------------------------------------------------------------------
// getCustomerPaymentIntent
// ---------------------------------------------------------------------------

describe("portal.getCustomerPaymentIntent", () => {
  const run = handlerOf(getCustomerPaymentIntent);

  function makeIntent(
    overrides: Partial<PaymentIntentFixture> = {},
  ): PaymentIntentFixture {
    return {
      _id: "paymentIntents:i1",
      _creationTime: T0,
      provider: "gcash",
      intentId: "intent-abc",
      customerId: CALLER_CUSTOMER_ID,
      contractId: "contracts:c1",
      amountCents: 100_000,
      status: "pending",
      createdAt: T0,
      ...overrides,
    };
  }

  it("throws FORBIDDEN for non-customer role", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      callerEmail: "admin@example.com",
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, {
      paymentIntentId: "intent-abc",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("returns null when the intent does not exist", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    const result = await run(ctx, { paymentIntentId: "intent-nope" });
    expect(result).toBeNull();
  });

  it("returns null when the intent belongs to another customer", async () => {
    const otherIntent = makeIntent({ customerId: OTHER_CUSTOMER_ID });
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer(), otherCustomer()],
      paymentIntents: [otherIntent],
    });
    const result = await run(ctx, { paymentIntentId: otherIntent.intentId });
    expect(result).toBeNull();
  });

  it("returns the narrow projection for the calling customer's intent", async () => {
    const intent = makeIntent({ redirectUrl: "/redir/abc" });
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      paymentIntents: [intent],
    });
    const result = (await run(ctx, {
      paymentIntentId: intent.intentId,
    })) as Record<string, unknown> | null;
    expect(result).not.toBeNull();
    expect(result?.paymentIntentId).toBe(intent.intentId);
    expect(result?.provider).toBe("gcash");
    expect(result?.status).toBe("pending");
    expect(result?.amountCents).toBe(100_000);
    expect(result?.redirectUrl).toBe("/redir/abc");
  });

  it("hides redirectUrl on non-pending intents", async () => {
    const intent = makeIntent({
      status: "succeeded",
      redirectUrl: "/redir/abc",
    });
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      paymentIntents: [intent],
    });
    const result = (await run(ctx, {
      paymentIntentId: intent.intentId,
    })) as Record<string, unknown> | null;
    expect(result?.status).toBe("succeeded");
    expect(result?.redirectUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleGatewayWebhook
// ---------------------------------------------------------------------------

describe("portal.handleGatewayWebhook", () => {
  const run = handlerOf(handleGatewayWebhook);

  function makeIntent(
    overrides: Partial<PaymentIntentFixture> = {},
  ): PaymentIntentFixture {
    return {
      _id: "paymentIntents:i1",
      _creationTime: T0,
      provider: "gcash",
      intentId: "intent-abc",
      customerId: CALLER_CUSTOMER_ID,
      contractId: "contracts:c1",
      amountCents: 100_000,
      status: "pending",
      createdAt: T0,
      ...overrides,
    };
  }

  function event(overrides: Partial<{
    paymentIntentId: string;
    gatewayTransactionId: string;
    status: "succeeded" | "failed" | "expired" | "unknown";
    amountCents: number;
    currency: string;
    failureReason?: string;
    rawEventId?: string;
  }> = {}) {
    return {
      paymentIntentId: "intent-abc",
      gatewayTransactionId: "gateway-tx-1",
      status: "succeeded" as const,
      amountCents: 100_000,
      currency: "PHP",
      ...overrides,
    };
  }

  it("throws NOT_FOUND on unknown intent id", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, {
      gateway: "gcash",
      event: event({ paymentIntentId: "intent-ghost" }),
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("throws INVARIANT_VIOLATION on gateway mismatch (cross-gateway defence)", async () => {
    const intent = makeIntent({ provider: "gcash" });
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      paymentIntents: [intent],
    });
    const thrown = await run(ctx, {
      gateway: "maya",
      event: event(),
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("no-ops on duplicate delivery (idempotency anchor)", async () => {
    const intent = makeIntent({
      status: "succeeded",
      completedAt: T0 - 100,
    });
    const { ctx, payments, receipts, auditRows } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      paymentIntents: [intent],
    });
    await run(ctx, { gateway: "gcash", event: event() });
    expect(payments.size).toBe(0);
    expect(receipts.size).toBe(0);
    expect(auditRows).toHaveLength(0);
  });

  it("treats unknown status as a no-op (forward compat) with an audit row", async () => {
    const intent = makeIntent();
    const { ctx, payments, paymentIntents, auditRows } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      paymentIntents: [intent],
    });
    await run(ctx, {
      gateway: "gcash",
      event: event({ status: "unknown", rawEventId: "evt-99" }),
    });
    expect(payments.size).toBe(0);
    expect(Array.from(paymentIntents.values())[0]?.status).toBe("pending");
    expect(auditRows).toHaveLength(1);
  });

  it("marks the intent failed on a failure event without writing a payment", async () => {
    const intent = makeIntent();
    const { ctx, payments, paymentIntents, auditRows } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      paymentIntents: [intent],
    });
    await run(ctx, {
      gateway: "gcash",
      event: event({ status: "failed", failureReason: "insufficient_funds" }),
    });
    const updated = Array.from(paymentIntents.values())[0]!;
    expect(updated.status).toBe("failed");
    expect(updated.completedAt).toBeTypeOf("number");
    expect(updated.failureReason).toBe("insufficient_funds");
    expect(payments.size).toBe(0);
    expect(auditRows).toHaveLength(1);
  });

  it("marks the intent expired on an expired event", async () => {
    const intent = makeIntent();
    const { ctx, paymentIntents } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      paymentIntents: [intent],
    });
    await run(ctx, {
      gateway: "gcash",
      event: event({ status: "expired" }),
    });
    expect(Array.from(paymentIntents.values())[0]?.status).toBe("expired");
  });

  it("throws INVARIANT_VIOLATION on amount mismatch", async () => {
    const intent = makeIntent({ amountCents: 100_000 });
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      paymentIntents: [intent],
    });
    const thrown = await run(ctx, {
      gateway: "gcash",
      event: event({ amountCents: 50_000 }),
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("posts the payment + receipt + audit atomically on success (FR32)", async () => {
    const intent = makeIntent();
    const {
      ctx,
      payments,
      receipts,
      allocations,
      paymentIntents,
      auditRows,
      scheduled,
    } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      paymentIntents: [intent],
    });
    await run(ctx, { gateway: "gcash", event: event() });
    expect(payments.size).toBe(1);
    expect(receipts.size).toBe(1);
    expect(allocations.size).toBe(1);
    const payment = Array.from(payments.values())[0]!;
    expect(payment.paymentMethod).toBe("gcash");
    expect(payment.amountCents).toBe(100_000);
    expect(payment.reference).toBe("gateway-tx-1");
    const receipt = Array.from(receipts.values())[0]!;
    expect(receipt.amountCents).toBe(100_000);
    const updatedIntent = Array.from(paymentIntents.values())[0]!;
    expect(updatedIntent.status).toBe("succeeded");
    expect(updatedIntent.paymentId).toBe(payment._id);
    expect(updatedIntent.gatewayTransactionId).toBe("gateway-tx-1");
    // postFinancialEvent emits the receipt-create audit row; we get
    // 1 audit row total.
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.entityType).toBe("receipt");
    // PDF action deferred.
    expect(scheduled).toHaveLength(1);
  });

  it("is idempotent across multiple deliveries (single payment posted)", async () => {
    const intent = makeIntent();
    const { ctx, payments, receipts } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      paymentIntents: [intent],
    });
    await run(ctx, { gateway: "gcash", event: event() });
    // Second delivery — same event payload, same intent.
    await run(ctx, { gateway: "gcash", event: event() });
    expect(payments.size).toBe(1);
    expect(receipts.size).toBe(1);
  });

  // P1-2 adversarial review: dropped the "any customer-role user"
  // fallback when the email-link resolution misses. Mis-attributing a
  // financial event to an arbitrary customer breaks the audit trail;
  // the handler now throws INVARIANT_VIOLATION so the gateway
  // retries while ops is alerted.
  it("throws INVARIANT_VIOLATION when the email-link resolution fails (P1-2)", async () => {
    const intent = makeIntent();
    // The customer's email does NOT match the caller user's email,
    // so the `query("users").withIndex("email", ...)` collect returns
    // empty. The handler previously would have fallen back to "first
    // user with the customer role" — that fallback is now removed.
    const customerWithDifferentEmail = {
      ...callerCustomer(),
      email: "no-match-with-any-user@example.com",
    };
    const { ctx, payments, receipts } = makeCtx({
      callerEmail: CALLER_EMAIL, // the user's email
      customers: [customerWithDifferentEmail],
      paymentIntents: [intent],
    });
    const thrown = await run(ctx, {
      gateway: "gcash",
      event: event(),
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
    // Critically: no payment / receipt was written despite the throw
    // coming after the financial event would have started. The
    // mutation aborts atomically.
    expect(payments.size).toBe(0);
    expect(receipts.size).toBe(0);
  });

  it("throws INVARIANT_VIOLATION when the customer has no email at all (P1-2)", async () => {
    const intent = makeIntent();
    const customerWithoutEmail = { ...callerCustomer(), email: undefined };
    const { ctx, payments } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [customerWithoutEmail],
      paymentIntents: [intent],
    });
    const thrown = await run(ctx, {
      gateway: "gcash",
      event: event(),
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(payments.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cancelSandboxPaymentIntent — P1-3
// ---------------------------------------------------------------------------

import { cancelSandboxPaymentIntent } from "../../../convex/portal";

describe("portal.cancelSandboxPaymentIntent (P1-3)", () => {
  const run = handlerOf(cancelSandboxPaymentIntent);

  function makeIntent(
    overrides: Partial<PaymentIntentFixture> = {},
  ): PaymentIntentFixture {
    return {
      _id: "paymentIntents:i1",
      _creationTime: T0,
      provider: "gcash",
      intentId: "intent-cancel",
      customerId: CALLER_CUSTOMER_ID,
      contractId: "contracts:c1",
      amountCents: 100_000,
      status: "pending",
      createdAt: T0,
      ...overrides,
    };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to run in production (the real gateway emits its own cancel webhook)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const intent = makeIntent();
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      paymentIntents: [intent],
    });
    const thrown = await run(ctx, {
      paymentIntentId: intent.intentId,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("flips a pending intent to expired in dev/sandbox", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const intent = makeIntent();
    const { ctx, paymentIntents, auditRows } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      paymentIntents: [intent],
    });
    await run(ctx, { paymentIntentId: intent.intentId });
    const updated = Array.from(paymentIntents.values())[0]!;
    expect(updated.status).toBe("expired");
    expect(updated.completedAt).toBeTypeOf("number");
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.action).toBe("update");
  });

  it("no-ops when the intent is already terminal", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const intent = makeIntent({ status: "succeeded", completedAt: T0 - 1 });
    const { ctx, paymentIntents } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
      paymentIntents: [intent],
    });
    await run(ctx, { paymentIntentId: intent.intentId });
    const updated = Array.from(paymentIntents.values())[0]!;
    // Status unchanged.
    expect(updated.status).toBe("succeeded");
  });

  it("silently no-ops when the intent belongs to another customer (404-over-403)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const otherIntent = makeIntent({ customerId: OTHER_CUSTOMER_ID });
    const { ctx, paymentIntents } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer(), otherCustomer()],
      paymentIntents: [otherIntent],
    });
    await run(ctx, { paymentIntentId: otherIntent.intentId });
    const updated = Array.from(paymentIntents.values())[0]!;
    // Status unchanged — caller doesn't own this intent.
    expect(updated.status).toBe("pending");
  });
});
