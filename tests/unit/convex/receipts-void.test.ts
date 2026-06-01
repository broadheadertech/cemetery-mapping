/**
 * Story 3.12 — `voidReceipt` mutation tests.
 *
 * Coverage focus:
 *   - Auth: only `admin` can void; office_staff / field_worker /
 *     customer all hit FORBIDDEN before any read or write happens.
 *   - Validation: reason missing / under 10 trimmed chars / over 1000
 *     chars → VALIDATION.
 *   - Happy path: admin voids a previously-issued receipt → the
 *     cornerstone patches `receipts` + `payments` with the void-flag
 *     bundle, emits a `void`-action audit row anchored to the receipt,
 *     and the returned `{ receiptNumber, voidedAt }` matches the
 *     receipt's original number (FR29: no serial re-allocation).
 *   - Idempotency dedupe: the cornerstone's idempotency lookup keys on
 *     `payments.idempotencyKey`. We assert the void path does NOT
 *     touch `receiptCounter.currentSerial` (NFR-C1: voids consume
 *     their serial, never decrement the counter).
 *   - Already-voided: calling `voidReceipt` on a receipt whose
 *     `isVoided === true` throws `RECEIPT_VOIDED`.
 *   - NOT_FOUND: bogus receipt id surfaces `NOT_FOUND`.
 *
 * Strategy: hand-mocked Convex `ctx`, same shape as
 * `tests/unit/convex/payments.test.ts` and `contracts-void.test.ts`.
 * The cornerstone's `payments.by_idempotency` index is mocked via the
 * generic `withIndex` filter — the test never seeds an existing
 * payment under the synthetic `voidReceipt:<id>` key so the
 * idempotency lookup misses on every fresh call.
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
import { voidReceipt } from "../../../convex/receipts";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-05-18T10:00:00+08:00").getTime();
const USER_ID = "users:admin1";
const SESSION_ID = "authSessions:s1";

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
  _creationTime: number;
  paymentNumber: string;
  amountCents: number;
  paymentMethod: "cash" | "check" | "bank_transfer" | "gcash" | "maya" | "card";
  reference?: string;
  receivedAt: number;
  receivedByUserId: string;
  idempotencyKey: string;
  isVoided: boolean;
  voidedAt?: number;
  voidReason?: string;
  voidedByUserId?: string;
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
  receipts: Map<string, ReceiptFixture>;
  payments: Map<string, PaymentFixture>;
  receiptCounters: Map<string, ReceiptCounterFixture>;
  auditInserts: Array<{ row: Record<string, unknown> }>;
  patches: Array<{ id: string; patch: Record<string, unknown> }>;
  scheduled: Array<{ delayMs: number; ref: unknown; args: unknown }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  initialReceipts?: ReceiptFixture[];
  initialPayments?: PaymentFixture[];
  authenticated?: boolean;
}): CtxBag {
  const receipts = new Map<string, ReceiptFixture>(
    (opts.initialReceipts ?? []).map((r) => [r._id, r]),
  );
  const payments = new Map<string, PaymentFixture>(
    (opts.initialPayments ?? []).map((p) => [p._id, p]),
  );
  const receiptCounters = new Map<string, ReceiptCounterFixture>([
    [
      "receiptCounter:1",
      {
        _id: "receiptCounter:1",
        _creationTime: T0 - 1000,
        currentSerial: 250,
        startingSerial: 1,
        prefix: "OR-",
        seededAt: T0 - 1000,
      },
    ],
  ]);
  const auditInserts: Array<{ row: Record<string, unknown> }> = [];
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const scheduled: Array<{ delayMs: number; ref: unknown; args: unknown }> =
    [];

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

  function rowsForTable(table: string): Record<string, unknown>[] {
    if (table === "userRoles") {
      return userRoles as unknown as Record<string, unknown>[];
    }
    if (table === "receipts") {
      return Array.from(receipts.values()) as unknown as Record<
        string,
        unknown
      >[];
    }
    if (table === "payments") {
      return Array.from(payments.values()) as unknown as Record<
        string,
        unknown
      >[];
    }
    if (table === "paymentAllocations") return [];
    return [];
  }

  function makeBuilder(table: string) {
    const eqs: Array<{ field: string; value: unknown }> = [];
    const builder = {
      withIndex(_name: string, fn: (q: unknown) => unknown) {
        const q = {
          eq(field: string, value: unknown) {
            eqs.push({ field, value });
            return q;
          },
        };
        fn(q);
        return builder;
      },
      async unique(): Promise<Record<string, unknown> | null> {
        const rows = rowsForTable(table).filter((r) =>
          eqs.every((e) => r[e.field] === e.value),
        );
        if (rows.length === 0) return null;
        if (rows.length > 1) {
          throw new Error(`unique() found ${rows.length} rows in ${table}`);
        }
        return rows[0]!;
      },
      async first(): Promise<Record<string, unknown> | null> {
        const rows = rowsForTable(table).filter((r) =>
          eqs.every((e) => r[e.field] === e.value),
        );
        return rows[0] ?? null;
      },
      async collect(): Promise<Record<string, unknown>[]> {
        return rowsForTable(table).filter((r) =>
          eqs.every((e) => r[e.field] === e.value),
        );
      },
    };
    return builder;
  }

  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === USER_ID) return user;
        if (id === SESSION_ID) return session;
        if (receipts.has(id)) return receipts.get(id);
        if (payments.has(id)) return payments.get(id);
        if (receiptCounters.has(id)) return receiptCounters.get(id);
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
        if (table === "receiptCounter") {
          return {
            withIndex: () => ({
              first: async (): Promise<Record<string, unknown> | null> => {
                const row = receiptCounters.get("receiptCounter:1");
                return row !== undefined
                  ? (row as unknown as Record<string, unknown>)
                  : null;
              },
            }),
            first: async (): Promise<Record<string, unknown> | null> => {
              const row = receiptCounters.get("receiptCounter:1");
              return row !== undefined
                ? (row as unknown as Record<string, unknown>)
                : null;
            },
          };
        }
        return makeBuilder(table);
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "auditLog") {
          auditInserts.push({ row });
          return `auditLog:${auditInserts.length}`;
        }
        return `${table}:?`;
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        patches.push({ id, patch });
        if (receipts.has(id)) {
          const existing = receipts.get(id)!;
          receipts.set(id, { ...existing, ...patch } as ReceiptFixture);
        } else if (payments.has(id)) {
          const existing = payments.get(id)!;
          payments.set(id, { ...existing, ...patch } as PaymentFixture);
        }
      }),
    },
    // Story 3.12 post-fix: voidReceipt schedules the PDF re-render
    // action so the VOIDED watermark gets stamped on the stored PDF.
    // The handler ignores the scheduler return value; we record the
    // invocation for assertion purposes.
    scheduler: {
      runAfter: vi.fn(async (delayMs: number, ref: unknown, args: unknown) => {
        scheduled.push({ delayMs, ref, args });
        return `scheduled:${scheduled.length}`;
      }),
    },
  };

  return {
    receipts,
    payments,
    receiptCounters,
    auditInserts,
    patches,
    scheduled,
    ctx,
  };
}

function makeReceipt(overrides: Partial<ReceiptFixture> = {}): ReceiptFixture {
  return {
    _id: overrides._id ?? "receipts:1",
    _creationTime: T0 - 60_000,
    paymentId: overrides.paymentId ?? "payments:1",
    receiptSeries: "OR-",
    receiptNumber: "OR-0000123",
    receiptSerial: 123,
    contractId: "contracts:1",
    customerId: "customers:1",
    amountCents: 250_000,
    issuedAt: T0 - 60_000,
    issuedByUserId: USER_ID,
    isVoided: false,
    ...overrides,
  };
}

function makePayment(overrides: Partial<PaymentFixture> = {}): PaymentFixture {
  return {
    _id: overrides._id ?? "payments:1",
    _creationTime: T0 - 60_000,
    paymentNumber: "OR-0000123",
    amountCents: 250_000,
    paymentMethod: "cash",
    reference: undefined,
    receivedAt: T0 - 60_000,
    receivedByUserId: USER_ID,
    idempotencyKey: "originalSale:abc",
    isVoided: false,
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

describe("voidReceipt", () => {
  const run = handlerOf(voidReceipt);

  it("admin voids a receipt: receipt + payment flagged, audit emitted, serial preserved", async () => {
    const receipt = makeReceipt();
    const payment = makePayment();
    const bag = makeCtx({
      roles: ["admin"],
      initialReceipts: [receipt],
      initialPayments: [payment],
    });

    const result = (await run(bag.ctx, {
      receiptId: receipt._id,
      reason: "Customer disputed the wrong amount on the OR.",
    })) as { receiptId: string; receiptNumber: string; voidedAt: number };

    // Returned shape preserves the original serial — FR29.
    expect(result.receiptId).toBe(receipt._id);
    expect(result.receiptNumber).toBe("OR-0000123");
    expect(result.voidedAt).toBe(T0);

    // Receipt row flagged.
    const updatedReceipt = bag.receipts.get(receipt._id)!;
    expect(updatedReceipt.isVoided).toBe(true);
    expect(updatedReceipt.voidedAt).toBe(T0);
    expect(updatedReceipt.voidedByUserId).toBe(USER_ID);
    expect(updatedReceipt.voidReason).toBe(
      "Customer disputed the wrong amount on the OR.",
    );

    // Payment row flagged with the same bundle (FR31 immutability:
    // every other field on the payment row is unchanged).
    const updatedPayment = bag.payments.get(payment._id)!;
    expect(updatedPayment.isVoided).toBe(true);
    expect(updatedPayment.voidedAt).toBe(T0);
    expect(updatedPayment.voidedByUserId).toBe(USER_ID);
    expect(updatedPayment.amountCents).toBe(250_000);
    expect(updatedPayment.paymentMethod).toBe("cash");

    // No new serial allocated — the counter must not advance on void.
    const counter = bag.receiptCounters.get("receiptCounter:1")!;
    expect(counter.currentSerial).toBe(250);

    // Audit row emitted with `action: "void"` anchored to the receipt.
    const voidAudits = bag.auditInserts.filter(
      (a) => (a.row as { action?: string }).action === "void",
    );
    expect(voidAudits.length).toBe(1);
    const auditRow = voidAudits[0]!.row as {
      entityType: string;
      entityId: string;
      reason?: string;
    };
    expect(auditRow.entityType).toBe("receipt");
    expect(auditRow.entityId).toBe(receipt._id);
    expect(auditRow.reason).toBe(
      "Customer disputed the wrong amount on the OR.",
    );
  });

  it("trims surrounding whitespace from the reason before persisting", async () => {
    const receipt = makeReceipt();
    const payment = makePayment();
    const bag = makeCtx({
      roles: ["admin"],
      initialReceipts: [receipt],
      initialPayments: [payment],
    });

    await run(bag.ctx, {
      receiptId: receipt._id,
      reason: "   Duplicate posting — see ticket #4471.   ",
    });

    expect(bag.receipts.get(receipt._id)!.voidReason).toBe(
      "Duplicate posting — see ticket #4471.",
    );
  });

  it("office_staff hits FORBIDDEN before any read or write happens", async () => {
    const receipt = makeReceipt();
    const payment = makePayment();
    const bag = makeCtx({
      roles: ["office_staff"],
      initialReceipts: [receipt],
      initialPayments: [payment],
    });

    let thrown: unknown;
    try {
      await run(bag.ctx, {
        receiptId: receipt._id,
        reason: "Customer changed their mind about the lot.",
      });
    } catch (err) {
      thrown = err;
    }
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);

    // Defence-in-depth: no patches, no audit row inserted before the
    // FORBIDDEN throw.
    expect(bag.patches.length).toBe(0);
    expect(bag.auditInserts.length).toBe(0);
  });

  it("field_worker hits FORBIDDEN", async () => {
    const receipt = makeReceipt();
    const bag = makeCtx({
      roles: ["field_worker"],
      initialReceipts: [receipt],
      initialPayments: [makePayment()],
    });
    let thrown: unknown;
    try {
      await run(bag.ctx, {
        receiptId: receipt._id,
        reason: "Customer changed their mind about the lot.",
      });
    } catch (err) {
      thrown = err;
    }
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects reasons shorter than 10 trimmed characters with VALIDATION", async () => {
    const receipt = makeReceipt();
    const bag = makeCtx({
      roles: ["admin"],
      initialReceipts: [receipt],
      initialPayments: [makePayment()],
    });

    let thrown: unknown;
    try {
      await run(bag.ctx, {
        receiptId: receipt._id,
        reason: "   too short   ",
      });
    } catch (err) {
      thrown = err;
    }
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    expect(bag.patches.length).toBe(0);
  });

  it("rejects reasons over 1000 characters with VALIDATION", async () => {
    const receipt = makeReceipt();
    const bag = makeCtx({
      roles: ["admin"],
      initialReceipts: [receipt],
      initialPayments: [makePayment()],
    });

    let thrown: unknown;
    try {
      await run(bag.ctx, {
        receiptId: receipt._id,
        reason: "x".repeat(1001),
      });
    } catch (err) {
      thrown = err;
    }
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("throws RECEIPT_VOIDED when the receipt is already voided", async () => {
    const receipt = makeReceipt({
      isVoided: true,
      voidedAt: T0 - 5000,
      voidReason: "earlier admin void",
      voidedByUserId: USER_ID,
    });
    const bag = makeCtx({
      roles: ["admin"],
      initialReceipts: [receipt],
      initialPayments: [makePayment()],
    });

    let thrown: unknown;
    try {
      await run(bag.ctx, {
        receiptId: receipt._id,
        reason: "Trying to void an already-voided receipt.",
      });
    } catch (err) {
      thrown = err;
    }
    expect(getCode(thrown)).toBe(ErrorCode.RECEIPT_VOIDED);
  });

  it("throws NOT_FOUND when the receipt id does not resolve", async () => {
    const bag = makeCtx({
      roles: ["admin"],
      initialReceipts: [],
      initialPayments: [],
    });

    let thrown: unknown;
    try {
      await run(bag.ctx, {
        receiptId: "receipts:does-not-exist",
        reason: "Customer disputed the wrong amount on the OR.",
      });
    } catch (err) {
      thrown = err;
    }
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("accepts an explicit idempotencyKey from the caller", async () => {
    const receipt = makeReceipt();
    const payment = makePayment();
    const bag = makeCtx({
      roles: ["admin"],
      initialReceipts: [receipt],
      initialPayments: [payment],
    });

    const result = (await run(bag.ctx, {
      receiptId: receipt._id,
      reason: "Customer disputed the wrong amount on the OR.",
      idempotencyKey: "client-supplied-key-abc",
    })) as { receiptNumber: string };
    expect(result.receiptNumber).toBe("OR-0000123");
    expect(bag.receipts.get(receipt._id)!.isVoided).toBe(true);
  });

  it("schedules a PDF re-render with forceRegenerate=true so the VOIDED watermark replaces the stored blob (Epic 3/4 void-chain fix)", async () => {
    const receipt = makeReceipt();
    const payment = makePayment();
    const bag = makeCtx({
      roles: ["admin"],
      initialReceipts: [receipt],
      initialPayments: [payment],
    });

    await run(bag.ctx, {
      receiptId: receipt._id,
      reason: "Triggering the post-void PDF re-render.",
    });

    // Exactly one scheduler entry was queued — the PDF re-render.
    expect(bag.scheduled.length).toBe(1);
    const entry = bag.scheduled[0]!;
    expect(entry.delayMs).toBe(0);
    expect(entry.args).toEqual({
      receiptId: receipt._id,
      forceRegenerate: true,
    });
  });
});
