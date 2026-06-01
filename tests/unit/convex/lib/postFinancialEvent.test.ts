/**
 * Story 3.2 — `postFinancialEvent` cornerstone unit tests.
 *
 * Coverage target: 100% lines + branches on
 * `convex/lib/postFinancialEvent.ts`. NFR-M2's published threshold is
 * 90%; this cornerstone targets 100% because every Phase-1 financial
 * mutation routes through it, and every uncovered branch is an
 * audit-traceable bug waiting to surface in production.
 *
 * Strategy: hand-mocked Convex `MutationCtx`, mirroring
 * `tests/unit/convex/lib/receiptCounter.test.ts` and
 * `tests/unit/convex/lib/audit.test.ts`. `convex-test` requires
 * `convex/_generated/`, which this repo deliberately doesn't have
 * until `npx convex dev` runs interactively. The hand-mocked harness
 * exercises every code path the helper hits — payments, receipts,
 * paymentAllocations, the receiptCounter (via `allocateNextSerial`),
 * the audit-log insert (via `emitAudit`).
 *
 * The harness exposes a `rows` bag per table so assertions can be
 * positional (`rows.payments[0]!.amountCents` etc.) rather than
 * relying on Convex-test's eventually-consistent read API.
 */

import { ConvexError, type Value } from "convex/values";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  ErrorCode,
  type ErrorPayload,
} from "../../../../convex/lib/errors";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";

import {
  postFinancialEvent,
  type PostFinancialEventPayload,
} from "../../../../convex/lib/postFinancialEvent";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const USER_ID = "users:abc123";
const SESSION_ID = "authSessions:def456";
const COUNTER_ID = "receiptCounter:row1";
const HOUR_MS = 60 * 60 * 1000;

// Generic id-bag shape — every inserted row carries an `_id`.
type Row = Record<string, unknown> & { _id: string };

interface CtxState {
  rows: {
    receiptCounter: Row[];
    payments: Row[];
    receipts: Row[];
    paymentAllocations: Row[];
    auditLog: Row[];
    users: Row[];
    authSessions: Row[];
    userRoles: Row[];
  };
  inserts: Array<{ table: string; row: Row }>;
  patches: Array<{ id: string; patch: Record<string, unknown> }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
  nextIdSeq: { value: number };
}

interface CtxOpts {
  counter?: { currentSerial: number; prefix: string };
  authenticated?: boolean;
}

function makeCtx(opts: CtxOpts = {}): CtxState {
  const counterRow: Row = {
    _id: COUNTER_ID,
    _creationTime: T0,
    currentSerial: opts.counter?.currentSerial ?? 0,
    startingSerial: 0,
    prefix: opts.counter?.prefix ?? "OR-",
    seededAt: T0,
  };
  const userRow: Row = {
    _id: USER_ID,
    _creationTime: T0 - 1000,
    email: "staff@example.com",
    name: "Staff User",
    isActive: true,
  };
  const sessionRow: Row = {
    _id: SESSION_ID,
    _creationTime: T0,
    userId: USER_ID,
    expirationTime: T0 + 30 * 24 * HOUR_MS,
  };
  const roleRow: Row = {
    _id: "userRoles:1",
    _creationTime: T0,
    userId: USER_ID,
    role: "office_staff",
    grantedAt: T0,
    grantedBy: USER_ID,
  };

  const state: CtxState = {
    rows: {
      receiptCounter: [counterRow],
      payments: [],
      receipts: [],
      paymentAllocations: [],
      auditLog: [],
      users: [userRow],
      authSessions: [sessionRow],
      userRoles: [roleRow],
    },
    inserts: [],
    patches: [],
    nextIdSeq: { value: 1 },
    ctx: undefined,
  };

  if (opts.authenticated === false) {
    mockedGetAuthUserId.mockResolvedValue(null);
    mockedGetAuthSessionId.mockResolvedValue(null);
  } else {
    mockedGetAuthUserId.mockResolvedValue(USER_ID as never);
    mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);
  }

  function nextId(table: string): string {
    return `${table}:${state.nextIdSeq.value++}`;
  }

  function rowsFor(table: string): Row[] {
    const bag = state.rows as unknown as Record<string, Row[]>;
    if (!(table in bag)) {
      bag[table] = [];
    }
    return bag[table]!;
  }

  state.ctx = {
    db: {
      get: vi.fn(async (id: string) => {
        for (const bag of Object.values(state.rows)) {
          const found = bag.find((r) => r._id === id);
          if (found !== undefined) return found;
        }
        return null;
      }),
      query: vi.fn((table: string) => {
        const bag = rowsFor(table);
        // Builder supporting: first(), unique(), collect(), withIndex(name, fn).collect()/unique().
        const makeBuilder = (filtered: Row[]) => ({
          async first(): Promise<Row | null> {
            return filtered[0] ?? null;
          },
          async unique(): Promise<Row | null> {
            if (filtered.length === 0) return null;
            if (filtered.length > 1) {
              throw new Error(
                `Mock ctx: .unique() found ${filtered.length} rows in ${table}.`,
              );
            }
            return filtered[0]!;
          },
          async collect(): Promise<Row[]> {
            return [...filtered];
          },
          withIndex(_indexName: string, fn: (q: unknown) => unknown) {
            // The query DSL is approximated as filter-by-fields the
            // index implies. We let the caller's filter function call
            // `.eq(field, value)` on a tiny stub recorder; we then
            // filter the bag.
            const eqs: Array<{ field: string; value: unknown }> = [];
            const q = {
              eq(field: string, value: unknown) {
                eqs.push({ field, value });
                return q;
              },
            };
            fn(q);
            const next = filtered.filter((r) =>
              eqs.every((e) => r[e.field] === e.value),
            );
            return makeBuilder(next);
          },
        });
        return makeBuilder(bag);
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        const id = nextId(table);
        const fullRow: Row = { ...row, _id: id, _creationTime: T0 };
        rowsFor(table).push(fullRow);
        state.inserts.push({ table, row: fullRow });
        return id;
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        state.patches.push({ id, patch });
        for (const bag of Object.values(state.rows)) {
          const row = bag.find((r) => r._id === id);
          if (row !== undefined) {
            Object.assign(row, patch);
            return;
          }
        }
        throw new Error(`Mock ctx: patch target ${id} not found.`);
      }),
    },
  };
  return state;
}

function expectConvexErrorCode(promise: Promise<unknown>, code: string) {
  return expect(promise).rejects.toMatchObject({ data: { code } });
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("Expected promise to reject");
  } catch (e) {
    return e;
  }
}

function basePayment(overrides: Partial<{
  amountCents: number;
  paymentMethod:
    | "cash" | "check" | "bank_transfer" | "gcash" | "maya" | "card";
  reference: string;
  receivedAt: number;
  contractId: string;
  customerId: string;
}> = {}) {
  return {
    amountCents: 100_00,
    paymentMethod: "cash" as const,
    receivedAt: T0,
    receivedByUserId: USER_ID as never,
    ...overrides,
  };
}

function salePayload(overrides: Partial<{
  idempotencyKey: string;
  amountCents: number;
  allocations: PostFinancialEventPayload extends { kind: "sale"; allocations: infer A } ? A : never;
}> = {}): PostFinancialEventPayload {
  return {
    kind: "sale",
    idempotencyKey: overrides.idempotencyKey ?? "idem-sale-001",
    payment: basePayment({ amountCents: overrides.amountCents ?? 100_00 }),
    allocations:
      overrides.allocations ?? [
        {
          targetType: "contract",
          targetId: "contracts:1",
          amountCents: overrides.amountCents ?? 100_00,
        },
      ],
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

describe("postFinancialEvent — kind: 'sale' happy path", () => {
  it("inserts payment + receipt + allocation in one transaction", async () => {
    const state = makeCtx();
    const result = await postFinancialEvent(state.ctx, salePayload());
    expect(result.paymentId).toMatch(/^payments:/);
    expect(result.receiptId).toMatch(/^receipts:/);
    expect(result.receiptNumber).toBe("OR-0000001");

    expect(state.rows.payments).toHaveLength(1);
    expect(state.rows.receipts).toHaveLength(1);
    expect(state.rows.paymentAllocations).toHaveLength(1);
  });

  it("allocates a strictly monotonic serial", async () => {
    const state = makeCtx({ counter: { currentSerial: 41, prefix: "OR-" } });
    const result = await postFinancialEvent(state.ctx, salePayload());
    expect(result.receiptNumber).toBe("OR-0000042");
    expect(state.rows.receiptCounter[0]!.currentSerial).toBe(42);
  });

  it("writes the formatted serial as the payment number too", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, salePayload());
    expect(state.rows.payments[0]!.paymentNumber).toBe("OR-0000001");
  });

  it("writes the receipt with the prefix-snapshot as receiptSeries", async () => {
    const state = makeCtx({ counter: { currentSerial: 0, prefix: "AR-" } });
    await postFinancialEvent(state.ctx, salePayload());
    expect(state.rows.receipts[0]!.receiptSeries).toBe("AR-");
    expect(state.rows.receipts[0]!.receiptNumber).toBe("AR-0000001");
    expect(state.rows.receipts[0]!.receiptSerial).toBe(1);
  });

  it("mirrors amountCents from payment onto receipt for self-containment", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, salePayload({ amountCents: 250_00 }));
    expect(state.rows.payments[0]!.amountCents).toBe(250_00);
    expect(state.rows.receipts[0]!.amountCents).toBe(250_00);
  });

  it("threads contractId / customerId from payment onto receipt", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, {
      kind: "sale",
      idempotencyKey: "idem-001",
      payment: {
        ...basePayment(),
        contractId: "contracts:42",
        customerId: "customers:99",
      },
      allocations: [
        {
          targetType: "contract",
          targetId: "contracts:42",
          amountCents: 100_00,
        },
      ],
    });
    expect(state.rows.receipts[0]!.contractId).toBe("contracts:42");
    expect(state.rows.receipts[0]!.customerId).toBe("customers:99");
  });

  it("threads the reference field through to the payment row", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, {
      kind: "sale",
      idempotencyKey: "idem-001",
      payment: { ...basePayment(), reference: "BPI-CHK-987" },
      allocations: [
        {
          targetType: "contract",
          targetId: "contracts:1",
          amountCents: 100_00,
        },
      ],
    });
    expect(state.rows.payments[0]!.reference).toBe("BPI-CHK-987");
  });

  it("uses the operator-supplied receivedAt as issuedAt on the receipt", async () => {
    const state = makeCtx();
    const customReceivedAt = T0 + 3 * HOUR_MS;
    await postFinancialEvent(state.ctx, {
      kind: "sale",
      idempotencyKey: "idem-001",
      payment: basePayment({ receivedAt: customReceivedAt }),
      allocations: [
        {
          targetType: "contract",
          targetId: "contracts:1",
          amountCents: 100_00,
        },
      ],
    });
    expect(state.rows.payments[0]!.receivedAt).toBe(customReceivedAt);
    expect(state.rows.receipts[0]!.issuedAt).toBe(customReceivedAt);
  });

  it("writes payment isVoided=false on initial insert", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, salePayload());
    expect(state.rows.payments[0]!.isVoided).toBe(false);
    expect(state.rows.receipts[0]!.isVoided).toBe(false);
  });

  it("records the idempotency key on the payment row", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, salePayload({ idempotencyKey: "uuid-1234" }));
    expect(state.rows.payments[0]!.idempotencyKey).toBe("uuid-1234");
  });

  it("emits exactly one audit row per posted financial event", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, salePayload());
    expect(state.rows.auditLog).toHaveLength(1);
    expect(state.rows.auditLog[0]!.action).toBe("create");
    expect(state.rows.auditLog[0]!.entityType).toBe("receipt");
  });

  it("emits the audit row with entityId set to the receipt id", async () => {
    const state = makeCtx();
    const result = await postFinancialEvent(state.ctx, salePayload());
    expect(state.rows.auditLog[0]!.entityId).toBe(result.receiptId);
  });

  it("emits audit's `after` snapshot with the financial event details", async () => {
    const state = makeCtx();
    await postFinancialEvent(
      state.ctx,
      salePayload({ amountCents: 500_00 }),
    );
    const auditAfter = state.rows.auditLog[0]!.after as Record<
      string,
      unknown
    >;
    expect(auditAfter).toMatchObject({
      kind: "sale",
      receiptNumber: "OR-0000001",
      receiptSerial: 1,
      paymentAmountCents: 500_00,
      paymentMethod: "cash",
      allocationCount: 1,
    });
  });
});

describe("postFinancialEvent — kind: 'payment' happy path", () => {
  it("treats payment kind identically to sale at the cornerstone level", async () => {
    const state = makeCtx();
    const result = await postFinancialEvent(state.ctx, {
      kind: "payment",
      idempotencyKey: "idem-pay-001",
      payment: basePayment({ amountCents: 50_00 }),
      allocations: [
        {
          targetType: "installment",
          targetId: "installments:5",
          amountCents: 50_00,
        },
      ],
    });
    expect(result.receiptNumber).toBe("OR-0000001");
    expect(state.rows.payments).toHaveLength(1);
    expect(state.rows.receipts).toHaveLength(1);
    expect(state.rows.paymentAllocations).toHaveLength(1);
  });

  it("audit action is 'create' for kind=payment (same as sale)", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, {
      kind: "payment",
      idempotencyKey: "idem-pay-001",
      payment: basePayment({ amountCents: 50_00 }),
      allocations: [
        {
          targetType: "installment",
          targetId: "installments:5",
          amountCents: 50_00,
        },
      ],
    });
    expect(state.rows.auditLog[0]!.action).toBe("create");
  });

  it("kind='payment' is stored in the audit after snapshot", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, {
      kind: "payment",
      idempotencyKey: "idem-pay-001",
      payment: basePayment({ amountCents: 50_00 }),
      allocations: [
        {
          targetType: "installment",
          targetId: "installments:5",
          amountCents: 50_00,
        },
      ],
    });
    const auditAfter = state.rows.auditLog[0]!.after as Record<string, unknown>;
    expect(auditAfter.kind).toBe("payment");
  });
});

describe("postFinancialEvent — allocations", () => {
  it("writes multiple allocation rows in sequence order", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, {
      kind: "payment",
      idempotencyKey: "idem-multi-001",
      payment: basePayment({ amountCents: 300_00 }),
      allocations: [
        {
          targetType: "installment",
          targetId: "installments:1",
          amountCents: 100_00,
        },
        {
          targetType: "installment",
          targetId: "installments:2",
          amountCents: 100_00,
        },
        {
          targetType: "installment",
          targetId: "installments:3",
          amountCents: 100_00,
        },
      ],
    });
    expect(state.rows.paymentAllocations).toHaveLength(3);
    const sequences = state.rows.paymentAllocations.map((r) => r.sequence);
    expect(sequences).toEqual([0, 1, 2]);
  });

  it("respects caller-supplied sequence numbers on allocations", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, {
      kind: "payment",
      idempotencyKey: "idem-seq-001",
      payment: basePayment({ amountCents: 200_00 }),
      allocations: [
        {
          targetType: "installment",
          targetId: "installments:1",
          amountCents: 100_00,
          sequence: 10,
        },
        {
          targetType: "installment",
          targetId: "installments:2",
          amountCents: 100_00,
          sequence: 20,
        },
      ],
    });
    const sequences = state.rows.paymentAllocations.map((r) => r.sequence);
    expect(sequences).toEqual([10, 20]);
  });

  it("threads allocation note through to the row", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, {
      kind: "payment",
      idempotencyKey: "idem-note-001",
      payment: basePayment({ amountCents: 100_00 }),
      allocations: [
        {
          targetType: "installment",
          targetId: "installments:1",
          amountCents: 100_00,
          note: "Manual override — customer requested ahead-application",
        },
      ],
    });
    expect(state.rows.paymentAllocations[0]!.note).toBe(
      "Manual override — customer requested ahead-application",
    );
  });

  it("supports all four allocation target types", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, {
      kind: "payment",
      idempotencyKey: "idem-targets-001",
      payment: basePayment({ amountCents: 400_00 }),
      allocations: [
        {
          targetType: "contract",
          targetId: "contracts:1",
          amountCents: 100_00,
        },
        {
          targetType: "installment",
          targetId: "installments:1",
          amountCents: 100_00,
        },
        {
          targetType: "perpetualCare",
          targetId: "contracts:1",
          amountCents: 100_00,
        },
        {
          targetType: "credit",
          targetId: "customers:1",
          amountCents: 100_00,
        },
      ],
    });
    expect(state.rows.paymentAllocations).toHaveLength(4);
    expect(state.rows.paymentAllocations.map((r) => r.targetType)).toEqual([
      "contract",
      "installment",
      "perpetualCare",
      "credit",
    ]);
  });
});

describe("postFinancialEvent — allocation-sum invariant", () => {
  it("throws ALLOCATION_SUM_MISMATCH when sum > payment amount", async () => {
    const state = makeCtx();
    await expectConvexErrorCode(
      postFinancialEvent(state.ctx, {
        kind: "payment",
        idempotencyKey: "idem-bad-001",
        payment: basePayment({ amountCents: 100_00 }),
        allocations: [
          {
            targetType: "installment",
            targetId: "installments:1",
            amountCents: 200_00,
          },
        ],
      }),
      ErrorCode.ALLOCATION_SUM_MISMATCH,
    );
  });

  it("throws ALLOCATION_SUM_MISMATCH when sum < payment amount", async () => {
    const state = makeCtx();
    await expectConvexErrorCode(
      postFinancialEvent(state.ctx, {
        kind: "payment",
        idempotencyKey: "idem-bad-002",
        payment: basePayment({ amountCents: 100_00 }),
        allocations: [
          {
            targetType: "installment",
            targetId: "installments:1",
            amountCents: 50_00,
          },
        ],
      }),
      ErrorCode.ALLOCATION_SUM_MISMATCH,
    );
  });

  it("does NOT allocate a serial when allocation sum fails", async () => {
    const state = makeCtx({ counter: { currentSerial: 5, prefix: "OR-" } });
    await postFinancialEvent(state.ctx, {
      kind: "payment",
      idempotencyKey: "idem-bad-003",
      payment: basePayment({ amountCents: 100_00 }),
      allocations: [
        {
          targetType: "installment",
          targetId: "installments:1",
          amountCents: 50_00,
        },
      ],
    }).catch(() => undefined);
    expect(state.rows.receiptCounter[0]!.currentSerial).toBe(5);
  });

  it("does NOT write any payment / receipt / allocation row on sum mismatch", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, {
      kind: "payment",
      idempotencyKey: "idem-bad-004",
      payment: basePayment({ amountCents: 100_00 }),
      allocations: [
        {
          targetType: "installment",
          targetId: "installments:1",
          amountCents: 50_00,
        },
      ],
    }).catch(() => undefined);
    expect(state.rows.payments).toHaveLength(0);
    expect(state.rows.receipts).toHaveLength(0);
    expect(state.rows.paymentAllocations).toHaveLength(0);
    expect(state.rows.auditLog).toHaveLength(0);
  });

  it("attaches the offending sums to the error details", async () => {
    const state = makeCtx();
    const err = await captureError(
      postFinancialEvent(state.ctx, {
        kind: "payment",
        idempotencyKey: "idem-bad-005",
        payment: basePayment({ amountCents: 100_00 }),
        allocations: [
          {
            targetType: "installment",
            targetId: "installments:1",
            amountCents: 75_00,
          },
        ],
      }),
    );
    expect(err).toBeInstanceOf(ConvexError);
    const data = (err as ConvexError<Value>).data as unknown as ErrorPayload;
    expect(data.details).toMatchObject({
      allocationsSum: 75_00,
      paymentAmountCents: 100_00,
    });
  });
});

describe("postFinancialEvent — empty / invalid allocations", () => {
  it("throws EMPTY_ALLOCATIONS when allocations is empty", async () => {
    const state = makeCtx();
    await expectConvexErrorCode(
      postFinancialEvent(state.ctx, {
        kind: "payment",
        idempotencyKey: "idem-empty-001",
        payment: basePayment({ amountCents: 100_00 }),
        allocations: [],
      }),
      ErrorCode.EMPTY_ALLOCATIONS,
    );
  });

  it("throws INVARIANT_VIOLATION when an allocation has negative amount", async () => {
    const state = makeCtx();
    await expectConvexErrorCode(
      postFinancialEvent(state.ctx, {
        kind: "payment",
        idempotencyKey: "idem-neg-001",
        payment: basePayment({ amountCents: 100_00 }),
        allocations: [
          {
            targetType: "installment",
            targetId: "installments:1",
            amountCents: -50_00,
          },
        ],
      }),
      ErrorCode.INVARIANT_VIOLATION,
    );
  });

  it("throws INVARIANT_VIOLATION when an allocation has non-integer amount", async () => {
    const state = makeCtx();
    await expectConvexErrorCode(
      postFinancialEvent(state.ctx, {
        kind: "payment",
        idempotencyKey: "idem-frac-001",
        payment: basePayment({ amountCents: 100_00 }),
        allocations: [
          {
            targetType: "installment",
            targetId: "installments:1",
            amountCents: 50.5,
          },
        ],
      }),
      ErrorCode.INVARIANT_VIOLATION,
    );
  });

  it("throws INVARIANT_VIOLATION when payment amount is negative", async () => {
    const state = makeCtx();
    await expectConvexErrorCode(
      postFinancialEvent(state.ctx, {
        kind: "payment",
        idempotencyKey: "idem-pneg-001",
        payment: basePayment({ amountCents: -100 }),
        allocations: [
          {
            targetType: "installment",
            targetId: "installments:1",
            amountCents: -100,
          },
        ],
      }),
      ErrorCode.INVARIANT_VIOLATION,
    );
  });

  it("throws INVARIANT_VIOLATION when payment amount is non-integer", async () => {
    const state = makeCtx();
    await expectConvexErrorCode(
      postFinancialEvent(state.ctx, {
        kind: "payment",
        idempotencyKey: "idem-pfrac-001",
        payment: basePayment({ amountCents: 100.5 }),
        allocations: [
          {
            targetType: "installment",
            targetId: "installments:1",
            amountCents: 50_00,
          },
        ],
      }),
      ErrorCode.INVARIANT_VIOLATION,
    );
  });
});

describe("postFinancialEvent — idempotency", () => {
  it("returns the existing receipt on second call with same key + same payload", async () => {
    const state = makeCtx();
    const first = await postFinancialEvent(state.ctx, salePayload());
    const second = await postFinancialEvent(state.ctx, salePayload());
    expect(second.paymentId).toBe(first.paymentId);
    expect(second.receiptId).toBe(first.receiptId);
    expect(second.receiptNumber).toBe(first.receiptNumber);
  });

  it("does NOT write a second payment row on idempotent retry", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, salePayload());
    await postFinancialEvent(state.ctx, salePayload());
    expect(state.rows.payments).toHaveLength(1);
  });

  it("does NOT write a second receipt row on idempotent retry", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, salePayload());
    await postFinancialEvent(state.ctx, salePayload());
    expect(state.rows.receipts).toHaveLength(1);
  });

  it("does NOT write a second allocation set on idempotent retry", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, salePayload());
    await postFinancialEvent(state.ctx, salePayload());
    expect(state.rows.paymentAllocations).toHaveLength(1);
  });

  it("does NOT burn a second serial on idempotent retry", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, salePayload());
    const serialAfterFirst = state.rows.receiptCounter[0]!.currentSerial;
    await postFinancialEvent(state.ctx, salePayload());
    expect(state.rows.receiptCounter[0]!.currentSerial).toBe(serialAfterFirst);
  });

  it("does NOT emit a second audit row on idempotent retry", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, salePayload());
    await postFinancialEvent(state.ctx, salePayload());
    expect(state.rows.auditLog).toHaveLength(1);
  });

  it("different keys + same payload produce two distinct receipts", async () => {
    const state = makeCtx();
    const a = await postFinancialEvent(
      state.ctx,
      salePayload({ idempotencyKey: "key-A" }),
    );
    const b = await postFinancialEvent(
      state.ctx,
      salePayload({ idempotencyKey: "key-B" }),
    );
    expect(a.receiptId).not.toBe(b.receiptId);
    expect(a.receiptNumber).toBe("OR-0000001");
    expect(b.receiptNumber).toBe("OR-0000002");
  });

  it("throws IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD on same key + different amount", async () => {
    const state = makeCtx();
    await postFinancialEvent(
      state.ctx,
      salePayload({ idempotencyKey: "key-X", amountCents: 100_00 }),
    );
    await expectConvexErrorCode(
      postFinancialEvent(
        state.ctx,
        salePayload({ idempotencyKey: "key-X", amountCents: 200_00 }),
      ),
      ErrorCode.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD,
    );
  });

  it("throws on same key + different payment method", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, {
      kind: "sale",
      idempotencyKey: "key-Y",
      payment: basePayment({ amountCents: 100_00 }),
      allocations: [
        {
          targetType: "contract",
          targetId: "contracts:1",
          amountCents: 100_00,
        },
      ],
    });
    await expectConvexErrorCode(
      postFinancialEvent(state.ctx, {
        kind: "sale",
        idempotencyKey: "key-Y",
        payment: basePayment({ amountCents: 100_00, paymentMethod: "gcash" }),
        allocations: [
          {
            targetType: "contract",
            targetId: "contracts:1",
            amountCents: 100_00,
          },
        ],
      }),
      ErrorCode.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD,
    );
  });

  it("throws on same key + different receivedAt", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, {
      kind: "sale",
      idempotencyKey: "key-Z",
      payment: basePayment({ amountCents: 100_00, receivedAt: T0 }),
      allocations: [
        {
          targetType: "contract",
          targetId: "contracts:1",
          amountCents: 100_00,
        },
      ],
    });
    await expectConvexErrorCode(
      postFinancialEvent(state.ctx, {
        kind: "sale",
        idempotencyKey: "key-Z",
        payment: basePayment({ amountCents: 100_00, receivedAt: T0 + 1 }),
        allocations: [
          {
            targetType: "contract",
            targetId: "contracts:1",
            amountCents: 100_00,
          },
        ],
      }),
      ErrorCode.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD,
    );
  });

  it("throws on same key + different allocation count", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, {
      kind: "payment",
      idempotencyKey: "key-AC",
      payment: basePayment({ amountCents: 100_00 }),
      allocations: [
        {
          targetType: "installment",
          targetId: "installments:1",
          amountCents: 100_00,
        },
      ],
    });
    await expectConvexErrorCode(
      postFinancialEvent(state.ctx, {
        kind: "payment",
        idempotencyKey: "key-AC",
        payment: basePayment({ amountCents: 100_00 }),
        allocations: [
          {
            targetType: "installment",
            targetId: "installments:1",
            amountCents: 50_00,
          },
          {
            targetType: "installment",
            targetId: "installments:2",
            amountCents: 50_00,
          },
        ],
      }),
      ErrorCode.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD,
    );
  });

  it("throws on same key + same count but different per-row allocation", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, {
      kind: "payment",
      idempotencyKey: "key-AR",
      payment: basePayment({ amountCents: 100_00 }),
      allocations: [
        {
          targetType: "installment",
          targetId: "installments:1",
          amountCents: 100_00,
        },
      ],
    });
    await expectConvexErrorCode(
      postFinancialEvent(state.ctx, {
        kind: "payment",
        idempotencyKey: "key-AR",
        payment: basePayment({ amountCents: 100_00 }),
        allocations: [
          {
            targetType: "installment",
            targetId: "installments:2", // different targetId
            amountCents: 100_00,
          },
        ],
      }),
      ErrorCode.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD,
    );
  });
});

describe("postFinancialEvent — kind: 'void'", () => {
  async function seedReceipt(state: CtxState) {
    return await postFinancialEvent(state.ctx, salePayload());
  }

  it("flips isVoided on the receipt and the linked payment", async () => {
    const state = makeCtx();
    const seeded = await seedReceipt(state);
    await postFinancialEvent(state.ctx, {
      kind: "void",
      idempotencyKey: "void-key-001",
      receiptId: seeded.receiptId as never,
      voidReason: "Wrong customer charged",
      voidedByUserId: USER_ID as never,
      voidedAt: T0 + HOUR_MS,
    });
    expect(state.rows.receipts[0]!.isVoided).toBe(true);
    expect(state.rows.payments[0]!.isVoided).toBe(true);
  });

  it("does NOT allocate a new serial on void (FR29)", async () => {
    const state = makeCtx();
    const seeded = await seedReceipt(state);
    const serialBeforeVoid = state.rows.receiptCounter[0]!.currentSerial;
    await postFinancialEvent(state.ctx, {
      kind: "void",
      idempotencyKey: "void-key-002",
      receiptId: seeded.receiptId as never,
      voidReason: "Cashier error",
      voidedByUserId: USER_ID as never,
      voidedAt: T0 + HOUR_MS,
    });
    expect(state.rows.receiptCounter[0]!.currentSerial).toBe(serialBeforeVoid);
  });

  it("returns the original receipt number (no re-allocation)", async () => {
    const state = makeCtx();
    const seeded = await seedReceipt(state);
    const result = await postFinancialEvent(state.ctx, {
      kind: "void",
      idempotencyKey: "void-key-003",
      receiptId: seeded.receiptId as never,
      voidReason: "Cashier error",
      voidedByUserId: USER_ID as never,
      voidedAt: T0 + HOUR_MS,
    });
    expect(result.receiptNumber).toBe(seeded.receiptNumber);
    expect(result.receiptId).toBe(seeded.receiptId);
    expect(result.paymentId).toBe(seeded.paymentId);
  });

  it("records voidedAt / voidReason / voidedByUserId on the receipt", async () => {
    const state = makeCtx();
    const seeded = await seedReceipt(state);
    await postFinancialEvent(state.ctx, {
      kind: "void",
      idempotencyKey: "void-key-004",
      receiptId: seeded.receiptId as never,
      voidReason: "Refund processed manually",
      voidedByUserId: USER_ID as never,
      voidedAt: T0 + 2 * HOUR_MS,
    });
    expect(state.rows.receipts[0]!.voidedAt).toBe(T0 + 2 * HOUR_MS);
    expect(state.rows.receipts[0]!.voidReason).toBe("Refund processed manually");
    expect(state.rows.receipts[0]!.voidedByUserId).toBe(USER_ID);
  });

  it("records voidedAt / voidReason / voidedByUserId on the linked payment", async () => {
    const state = makeCtx();
    const seeded = await seedReceipt(state);
    await postFinancialEvent(state.ctx, {
      kind: "void",
      idempotencyKey: "void-key-005",
      receiptId: seeded.receiptId as never,
      voidReason: "Refund processed manually",
      voidedByUserId: USER_ID as never,
      voidedAt: T0 + 2 * HOUR_MS,
    });
    expect(state.rows.payments[0]!.voidedAt).toBe(T0 + 2 * HOUR_MS);
    expect(state.rows.payments[0]!.voidReason).toBe("Refund processed manually");
    expect(state.rows.payments[0]!.voidedByUserId).toBe(USER_ID);
  });

  it("emits exactly one audit row with action='void'", async () => {
    const state = makeCtx();
    const seeded = await seedReceipt(state);
    await postFinancialEvent(state.ctx, {
      kind: "void",
      idempotencyKey: "void-key-006",
      receiptId: seeded.receiptId as never,
      voidReason: "Cashier error",
      voidedByUserId: USER_ID as never,
      voidedAt: T0 + HOUR_MS,
    });
    expect(state.rows.auditLog).toHaveLength(2); // sale + void
    expect(state.rows.auditLog[1]!.action).toBe("void");
  });

  it("audit row carries the void reason", async () => {
    const state = makeCtx();
    const seeded = await seedReceipt(state);
    await postFinancialEvent(state.ctx, {
      kind: "void",
      idempotencyKey: "void-key-007",
      receiptId: seeded.receiptId as never,
      voidReason: "Customer cancelled within 24h",
      voidedByUserId: USER_ID as never,
      voidedAt: T0 + HOUR_MS,
    });
    expect(state.rows.auditLog[1]!.reason).toBe(
      "Customer cancelled within 24h",
    );
  });

  it("audit row carries before/after isVoided snapshots", async () => {
    const state = makeCtx();
    const seeded = await seedReceipt(state);
    await postFinancialEvent(state.ctx, {
      kind: "void",
      idempotencyKey: "void-key-008",
      receiptId: seeded.receiptId as never,
      voidReason: "Test",
      voidedByUserId: USER_ID as never,
      voidedAt: T0 + HOUR_MS,
    });
    expect(state.rows.auditLog[1]!.before).toEqual({ isVoided: false });
    const auditAfter = state.rows.auditLog[1]!.after as Record<
      string,
      unknown
    >;
    expect(auditAfter.isVoided).toBe(true);
  });

  it("throws RECEIPT_VOIDED when voiding an already-voided receipt", async () => {
    const state = makeCtx();
    const seeded = await seedReceipt(state);
    await postFinancialEvent(state.ctx, {
      kind: "void",
      idempotencyKey: "void-key-009a",
      receiptId: seeded.receiptId as never,
      voidReason: "First void",
      voidedByUserId: USER_ID as never,
      voidedAt: T0 + HOUR_MS,
    });
    await expectConvexErrorCode(
      postFinancialEvent(state.ctx, {
        kind: "void",
        idempotencyKey: "void-key-009b",
        receiptId: seeded.receiptId as never,
        voidReason: "Second void attempt",
        voidedByUserId: USER_ID as never,
        voidedAt: T0 + 2 * HOUR_MS,
      }),
      ErrorCode.RECEIPT_VOIDED,
    );
  });

  it("throws NOT_FOUND when voiding a non-existent receipt", async () => {
    const state = makeCtx();
    await expectConvexErrorCode(
      postFinancialEvent(state.ctx, {
        kind: "void",
        idempotencyKey: "void-key-010",
        receiptId: "receipts:999" as never,
        voidReason: "Test",
        voidedByUserId: USER_ID as never,
        voidedAt: T0 + HOUR_MS,
      }),
      ErrorCode.NOT_FOUND,
    );
  });
});

describe("postFinancialEvent — kind: 'refund'", () => {
  it("throws NOT_IMPLEMENTED for refund payload (Epic 4 deferred)", async () => {
    const state = makeCtx();
    await expectConvexErrorCode(
      postFinancialEvent(state.ctx, {
        kind: "refund",
        idempotencyKey: "refund-key-001",
      }),
      ErrorCode.NOT_IMPLEMENTED,
    );
  });

  it("does NOT write any rows when refund is invoked", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, {
      kind: "refund",
      idempotencyKey: "refund-key-002",
    }).catch(() => undefined);
    expect(state.rows.payments).toHaveLength(0);
    expect(state.rows.receipts).toHaveLength(0);
    expect(state.rows.paymentAllocations).toHaveLength(0);
    expect(state.rows.auditLog).toHaveLength(0);
    expect(state.rows.receiptCounter[0]!.currentSerial).toBe(0);
  });
});

describe("postFinancialEvent — counter integration", () => {
  it("burns serials in strict 1..N order across N sales", async () => {
    const state = makeCtx();
    const serials: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const r = await postFinancialEvent(
        state.ctx,
        salePayload({ idempotencyKey: `key-${i}` }),
      );
      serials.push(r.receiptNumber);
    }
    expect(serials).toEqual([
      "OR-0000001",
      "OR-0000002",
      "OR-0000003",
      "OR-0000004",
      "OR-0000005",
    ]);
    expect(state.rows.receiptCounter[0]!.currentSerial).toBe(5);
  });

  it("a void between two sales preserves the serial sequence (no gap, no decrement)", async () => {
    const state = makeCtx();
    const sale1 = await postFinancialEvent(
      state.ctx,
      salePayload({ idempotencyKey: "k1" }),
    );
    await postFinancialEvent(state.ctx, {
      kind: "void",
      idempotencyKey: "void-k1",
      receiptId: sale1.receiptId as never,
      voidReason: "test",
      voidedByUserId: USER_ID as never,
      voidedAt: T0,
    });
    const sale2 = await postFinancialEvent(
      state.ctx,
      salePayload({ idempotencyKey: "k2" }),
    );
    expect(sale1.receiptNumber).toBe("OR-0000001");
    expect(sale2.receiptNumber).toBe("OR-0000002");
    expect(state.rows.receiptCounter[0]!.currentSerial).toBe(2);
  });

  it("propagates INVARIANT_VIOLATION when the counter row is missing", async () => {
    const state = makeCtx();
    state.rows.receiptCounter.length = 0;
    await expectConvexErrorCode(
      postFinancialEvent(state.ctx, salePayload()),
      ErrorCode.INVARIANT_VIOLATION,
    );
  });
});

describe("postFinancialEvent — audit emission", () => {
  it("propagates UNAUTHENTICATED from emitAudit when no auth identity", async () => {
    const state = makeCtx({ authenticated: false });
    await expectConvexErrorCode(
      postFinancialEvent(state.ctx, salePayload()),
      ErrorCode.UNAUTHENTICATED,
    );
  });

  it("the audit row's actor is the authenticated user", async () => {
    const state = makeCtx();
    await postFinancialEvent(state.ctx, salePayload());
    expect(state.rows.auditLog[0]!.actor).toBe(USER_ID);
  });
});

// =================================================================
// Epic 3/4 void-chain CRITICAL fix — compensating writes on void.
// Pre-fix the void path only patched isVoided flags; installment
// paidCents totals and contract perpetualCarePaidCents tallies kept
// the voided payment's contribution. After the fix the void path
// walks the original allocations and reverses each one in the same
// transaction.
// =================================================================
describe("postFinancialEvent — kind: 'void' compensating writes", () => {
  it("reverses installment paidCents on void and flips status back to pending", async () => {
    const state = makeCtx();
    // Seed an installment row in 'paid' state with paidCents = 50_00.
    state.rows.payments.push({
      _id: "payments:1",
      _creationTime: T0,
      paymentNumber: "OR-0000001",
      contractId: "contracts:1",
      customerId: "customers:1",
      amountCents: 50_00,
      paymentMethod: "cash",
      receivedAt: T0,
      receivedByUserId: USER_ID,
      idempotencyKey: "k1",
      isVoided: false,
    });
    state.rows.receipts.push({
      _id: "receipts:1",
      _creationTime: T0,
      paymentId: "payments:1",
      receiptSeries: "OR-",
      receiptNumber: "OR-0000001",
      receiptSerial: 1,
      contractId: "contracts:1",
      customerId: "customers:1",
      amountCents: 50_00,
      issuedAt: T0,
      issuedByUserId: USER_ID,
      isVoided: false,
    });
    state.rows.paymentAllocations.push({
      _id: "paymentAllocations:1",
      _creationTime: T0,
      paymentId: "payments:1",
      targetType: "installment",
      targetId: "installments:1",
      amountCents: 50_00,
      sequence: 0,
    });
    (state.rows as unknown as { installments: Row[] }).installments = [
      {
        _id: "installments:1",
        _creationTime: T0,
        contractId: "contracts:1",
        installmentNumber: 1,
        dueDate: T0,
        principalCents: 50_00,
        paidCents: 50_00,
        status: "paid",
      },
    ];

    await postFinancialEvent(state.ctx, {
      kind: "void",
      idempotencyKey: "void-k1",
      receiptId: "receipts:1" as never,
      voidReason: "Cashier mis-keyed amount",
      voidedByUserId: USER_ID as never,
      voidedAt: T0 + HOUR_MS,
    });

    const installment = (
      state.rows as unknown as { installments: Row[] }
    ).installments[0]!;
    expect(installment.paidCents).toBe(0);
    expect(installment.status).toBe("pending");
  });

  it("partial reversal: when allocation < paidCents, status becomes pending and paidCents drops by allocation amount", async () => {
    const state = makeCtx();
    state.rows.payments.push({
      _id: "payments:1",
      _creationTime: T0,
      paymentNumber: "OR-0000001",
      contractId: "contracts:1",
      customerId: "customers:1",
      amountCents: 30_00,
      paymentMethod: "cash",
      receivedAt: T0,
      receivedByUserId: USER_ID,
      idempotencyKey: "k1",
      isVoided: false,
    });
    state.rows.receipts.push({
      _id: "receipts:1",
      _creationTime: T0,
      paymentId: "payments:1",
      receiptSeries: "OR-",
      receiptNumber: "OR-0000001",
      receiptSerial: 1,
      contractId: "contracts:1",
      customerId: "customers:1",
      amountCents: 30_00,
      issuedAt: T0,
      issuedByUserId: USER_ID,
      isVoided: false,
    });
    state.rows.paymentAllocations.push({
      _id: "paymentAllocations:1",
      _creationTime: T0,
      paymentId: "payments:1",
      targetType: "installment",
      targetId: "installments:1",
      amountCents: 30_00,
      sequence: 0,
    });
    (state.rows as unknown as { installments: Row[] }).installments = [
      {
        _id: "installments:1",
        _creationTime: T0,
        contractId: "contracts:1",
        installmentNumber: 1,
        dueDate: T0,
        principalCents: 50_00,
        paidCents: 30_00, // partial
        status: "pending",
      },
    ];

    await postFinancialEvent(state.ctx, {
      kind: "void",
      idempotencyKey: "void-k1",
      receiptId: "receipts:1" as never,
      voidReason: "Voiding the partial installment payment.",
      voidedByUserId: USER_ID as never,
      voidedAt: T0 + HOUR_MS,
    });

    const installment = (
      state.rows as unknown as { installments: Row[] }
    ).installments[0]!;
    expect(installment.paidCents).toBe(0);
    expect(installment.status).toBe("pending");
  });

  it("reverses contract perpetualCarePaidCents when allocation targets perpetualCare", async () => {
    const state = makeCtx();
    state.rows.payments.push({
      _id: "payments:1",
      _creationTime: T0,
      paymentNumber: "OR-0000001",
      contractId: "contracts:1",
      customerId: "customers:1",
      amountCents: 20_00,
      paymentMethod: "cash",
      receivedAt: T0,
      receivedByUserId: USER_ID,
      idempotencyKey: "k1",
      isVoided: false,
    });
    state.rows.receipts.push({
      _id: "receipts:1",
      _creationTime: T0,
      paymentId: "payments:1",
      receiptSeries: "OR-",
      receiptNumber: "OR-0000001",
      receiptSerial: 1,
      contractId: "contracts:1",
      customerId: "customers:1",
      amountCents: 20_00,
      issuedAt: T0,
      issuedByUserId: USER_ID,
      isVoided: false,
    });
    state.rows.paymentAllocations.push({
      _id: "paymentAllocations:1",
      _creationTime: T0,
      paymentId: "payments:1",
      targetType: "perpetualCare",
      targetId: "contracts:1",
      amountCents: 20_00,
      sequence: 0,
    });
    (state.rows as unknown as { contracts: Row[] }).contracts = [
      {
        _id: "contracts:1",
        _creationTime: T0,
        state: "active",
        perpetualCareCents: 50_00,
        perpetualCarePaidCents: 20_00,
      },
    ];

    await postFinancialEvent(state.ctx, {
      kind: "void",
      idempotencyKey: "void-k1",
      receiptId: "receipts:1" as never,
      voidReason: "Voiding the perpetual-care payment.",
      voidedByUserId: USER_ID as never,
      voidedAt: T0 + HOUR_MS,
    });

    const contract = (state.rows as unknown as { contracts: Row[] })
      .contracts[0]!;
    expect(contract.perpetualCarePaidCents).toBe(0);
  });

  it("emits a void_compensation audit row in addition to the void row when installments are touched", async () => {
    const state = makeCtx();
    state.rows.payments.push({
      _id: "payments:1",
      _creationTime: T0,
      paymentNumber: "OR-0000001",
      contractId: "contracts:1",
      customerId: "customers:1",
      amountCents: 50_00,
      paymentMethod: "cash",
      receivedAt: T0,
      receivedByUserId: USER_ID,
      idempotencyKey: "k1",
      isVoided: false,
    });
    state.rows.receipts.push({
      _id: "receipts:1",
      _creationTime: T0,
      paymentId: "payments:1",
      receiptSeries: "OR-",
      receiptNumber: "OR-0000001",
      receiptSerial: 1,
      contractId: "contracts:1",
      customerId: "customers:1",
      amountCents: 50_00,
      issuedAt: T0,
      issuedByUserId: USER_ID,
      isVoided: false,
    });
    state.rows.paymentAllocations.push({
      _id: "paymentAllocations:1",
      _creationTime: T0,
      paymentId: "payments:1",
      targetType: "installment",
      targetId: "installments:1",
      amountCents: 50_00,
      sequence: 0,
    });
    (state.rows as unknown as { installments: Row[] }).installments = [
      {
        _id: "installments:1",
        _creationTime: T0,
        contractId: "contracts:1",
        installmentNumber: 1,
        dueDate: T0,
        principalCents: 50_00,
        paidCents: 50_00,
        status: "paid",
      },
    ];

    await postFinancialEvent(state.ctx, {
      kind: "void",
      idempotencyKey: "void-k1",
      receiptId: "receipts:1" as never,
      voidReason: "Triggering compensation audit.",
      voidedByUserId: USER_ID as never,
      voidedAt: T0 + HOUR_MS,
    });

    const compensationRows = state.rows.auditLog.filter(
      (r) =>
        r.action === "update" &&
        r.entityType === "receipt" &&
        typeof r.reason === "string" &&
        (r.reason as string).startsWith("void_compensation:"),
    );
    expect(compensationRows.length).toBe(1);
    // The plain `void` row is still emitted separately.
    const voidRows = state.rows.auditLog.filter((r) => r.action === "void");
    expect(voidRows.length).toBe(1);
  });

  it("contract-only allocations do NOT emit a void_compensation row (nothing to reverse)", async () => {
    // The current schema does not carry an inline outstandingBalanceCents
    // field, and `targetType: "contract"` is a no-op for the
    // compensation walk. The void path should NOT emit a
    // compensation audit row when nothing structurally moved.
    const state = makeCtx();
    const sale = await postFinancialEvent(state.ctx, salePayload());
    await postFinancialEvent(state.ctx, {
      kind: "void",
      idempotencyKey: "void-k1",
      receiptId: sale.receiptId as never,
      voidReason: "Voiding a contract-allocation-only payment.",
      voidedByUserId: USER_ID as never,
      voidedAt: T0 + HOUR_MS,
    });
    const compensationRows = state.rows.auditLog.filter(
      (r) =>
        r.action === "update" &&
        typeof r.reason === "string" &&
        (r.reason as string).startsWith("void_compensation:"),
    );
    expect(compensationRows).toHaveLength(0);
  });
});

describe("postFinancialEvent — defensive invariants", () => {
  it("throws INVARIANT_VIOLATION when an idempotent payment exists but its receipt is missing", async () => {
    // Set up a payment without a corresponding receipt — simulates a
    // corrupted ledger state the cornerstone should refuse to silently
    // dedupe against. This branch is unreachable through normal code
    // paths but covered for completeness.
    const state = makeCtx();
    state.rows.payments.push({
      _id: "payments:orphan",
      _creationTime: T0,
      paymentNumber: "OR-0000001",
      contractId: "contracts:1",
      customerId: "customers:1",
      amountCents: 100_00,
      paymentMethod: "cash",
      receivedAt: T0,
      receivedByUserId: USER_ID,
      idempotencyKey: "orphan-key",
      isVoided: false,
    });
    // Also seed the allocation so the payload-equality check passes —
    // this is precisely the "ledger corrupted: payment+allocations OK,
    // receipt missing" defensive case.
    state.rows.paymentAllocations.push({
      _id: "paymentAllocations:orphan",
      _creationTime: T0,
      paymentId: "payments:orphan",
      targetType: "contract",
      targetId: "contracts:1",
      amountCents: 100_00,
      sequence: 0,
    });
    await expectConvexErrorCode(
      postFinancialEvent(state.ctx, {
        kind: "sale",
        idempotencyKey: "orphan-key",
        payment: basePayment({
          amountCents: 100_00,
          contractId: "contracts:1",
          customerId: "customers:1",
        }),
        allocations: [
          {
            targetType: "contract",
            targetId: "contracts:1",
            amountCents: 100_00,
          },
        ],
      }),
      ErrorCode.INVARIANT_VIOLATION,
    );
  });
});
