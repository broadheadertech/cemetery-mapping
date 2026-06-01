/**
 * Story 3.9 — `convex/payments.ts` unit tests.
 *
 * Coverage target: ≥ 95% line coverage on
 * `recordPaymentWithAutoAllocation` + `listContractPayments`. Story
 * 3.9's mutation is financial-touching (FR26, FR32) so NFR-M2's
 * cornerstone-adjacent threshold applies.
 *
 * Strategy: hand-mocked ctx, mirroring `contracts.test.ts` and the
 * cornerstone's own test harness (`postFinancialEvent.test.ts`).
 * `convex-test` requires `convex/_generated/`, which this repo
 * deliberately doesn't have until `npx convex dev` runs interactively.
 *
 * The harness exposes a `rows` bag per table so assertions can be
 * positional. Tests cover:
 *
 *   - Happy path: ₱4,000 against installment #3 (₱4,000 due) → payment
 *     written, receipt issued, installment closed.
 *   - Partial: ₱2,000 against ₱4,000 due → installment stays
 *     `pending` with `paidCents: 2000_00`.
 *   - Cascade: ₱6,000 across two installments.
 *   - Auto-close: payment that closes every installment transitions
 *     the contract to `paid_in_full`.
 *   - Idempotency: same key + same payload returns the previously-
 *     issued receipt; same key + different payload throws.
 *   - Auth: customer / field_worker role → FORBIDDEN.
 *   - Validation: amount = 0 / negative / non-integer →
 *     VALIDATION. Non-cash without reference → VALIDATION. Empty
 *     idempotency key → VALIDATION. paidAt in the future → VALIDATION.
 *   - Contract state: not `installment` kind / not `active` state →
 *     INVARIANT_VIOLATION.
 *   - Overpay: amount exceeds outstanding balance →
 *     INVARIANT_VIOLATION with `overpay: true` in the details.
 *   - `listContractPayments` returns rows in descending creation-time
 *     order with receipt joins.
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
  listContractPayments,
  recordPaymentWithAutoAllocation,
} from "../../../convex/payments";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const USER_ID = "users:abc123";
const SESSION_ID = "authSessions:def456";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface ContractFixture {
  _id: string;
  _creationTime: number;
  contractNumber: string;
  lotId: string;
  customerId: string;
  kind: "full_payment" | "installment";
  totalPriceCents: number;
  state: "active" | "paid_in_full" | "cancelled" | "voided" | "in_default";
  createdAt: number;
  createdBy: string;
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
  initialContracts?: ContractFixture[];
  initialInstallments?: InstallmentFixture[];
  authenticated?: boolean;
  counter?: { currentSerial: number; prefix: string };
}): CtxBag {
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
  receiptCounters.set("receiptCounter:1", {
    _id: "receiptCounter:1",
    _creationTime: T0 - 1000,
    currentSerial: opts.counter?.currentSerial ?? 100,
    startingSerial: 1,
    prefix: opts.counter?.prefix ?? "OR-",
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

  function rowsForTable(table: string): Record<string, unknown>[] {
    if (table === "contracts")
      return Array.from(contracts.values()) as unknown as Record<
        string,
        unknown
      >[];
    if (table === "installments")
      return Array.from(installments.values()) as unknown as Record<
        string,
        unknown
      >[];
    if (table === "payments")
      return Array.from(payments.values()) as unknown as Record<
        string,
        unknown
      >[];
    if (table === "receipts")
      return Array.from(receipts.values()) as unknown as Record<
        string,
        unknown
      >[];
    if (table === "paymentAllocations")
      return Array.from(paymentAllocations.values()) as unknown as Record<
        string,
        unknown
      >[];
    if (table === "receiptCounter")
      return Array.from(receiptCounters.values()) as unknown as Record<
        string,
        unknown
      >[];
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
          gte() {
            return q;
          },
          lte() {
            return q;
          },
        };
        fn(q);
        return builder;
      },
      async first(): Promise<Record<string, unknown> | null> {
        const rows = rowsForTable(table).filter((r) =>
          eqs.every((e) => r[e.field] === e.value),
        );
        return rows[0] ?? null;
      },
      async unique(): Promise<Record<string, unknown> | null> {
        const rows = rowsForTable(table).filter((r) =>
          eqs.every((e) => r[e.field] === e.value),
        );
        if (rows.length === 0) return null;
        if (rows.length > 1) {
          throw new Error(
            `unique() found ${rows.length} rows in ${table}`,
          );
        }
        return rows[0]!;
      },
      async collect(): Promise<Record<string, unknown>[]> {
        return rowsForTable(table).filter((r) =>
          eqs.every((e) => r[e.field] === e.value),
        );
      },
    };
    return builder;
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
  }

  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === USER_ID) return user;
        if (id === SESSION_ID) return session;
        if (contracts.has(id)) return contracts.get(id);
        if (installments.has(id)) return installments.get(id);
        if (payments.has(id)) return payments.get(id);
        if (receipts.has(id)) return receipts.get(id);
        if (receiptCounters.has(id)) return receiptCounters.get(id);
        return null;
      }),
      query: vi.fn((table: string) => tableQuery(table)),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
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
        return `${table}:?`;
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        patches.push({ id, patch });
        if (contracts.has(id)) {
          const existing = contracts.get(id)!;
          contracts.set(id, { ...existing, ...patch } as ContractFixture);
        } else if (installments.has(id)) {
          const existing = installments.get(id)!;
          installments.set(id, {
            ...existing,
            ...patch,
          } as InstallmentFixture);
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

function makeContract(
  overrides: Partial<ContractFixture> = {},
): ContractFixture {
  return {
    _id: overrides._id ?? "contracts:1",
    _creationTime: T0,
    contractNumber: "CON-20260601-A-1-1-1234",
    lotId: "lots:1",
    customerId: "customers:1",
    kind: "installment",
    totalPriceCents: 96_000_00,
    state: "active",
    createdAt: T0,
    createdBy: USER_ID,
    ...overrides,
  };
}

function makeInstallment(
  overrides: Partial<InstallmentFixture>,
): InstallmentFixture {
  return {
    _id: overrides._id ?? `installments:${overrides.installmentNumber ?? 1}`,
    _creationTime: T0,
    contractId: overrides.contractId ?? "contracts:1",
    installmentNumber: overrides.installmentNumber ?? 1,
    dueDate: overrides.dueDate ?? T0 + 30 * 24 * HOUR_MS,
    principalCents: overrides.principalCents ?? 4_000_00,
    paidCents: overrides.paidCents ?? 0,
    status: overrides.status ?? "pending",
    ...(overrides.paidAt !== undefined ? { paidAt: overrides.paidAt } : {}),
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

function getDetails(thrown: unknown): Record<string, unknown> | undefined {
  if (!(thrown instanceof ConvexError)) return undefined;
  const data = (thrown as ConvexError<Value>).data as unknown as ErrorPayload;
  return data?.details as Record<string, unknown> | undefined;
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

describe("recordPaymentWithAutoAllocation — happy path", () => {
  const run = handlerOf(recordPaymentWithAutoAllocation);

  function validArgs(
    overrides: Partial<{
      contractId: string;
      amountCents: number;
      paymentMethod: "cash" | "check" | "bank_transfer";
      reference?: string;
      paidAt: number;
      idempotencyKey: string;
    }> = {},
  ) {
    return {
      contractId: "contracts:1",
      amountCents: 4_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-pay-001",
      ...overrides,
    };
  }

  function basicSetup() {
    const contract = makeContract({});
    const installmentRows = [
      makeInstallment({
        _id: "installments:1",
        installmentNumber: 1,
        paidCents: 4_000_00,
        status: "paid",
      }),
      makeInstallment({
        _id: "installments:2",
        installmentNumber: 2,
        paidCents: 4_000_00,
        status: "paid",
      }),
      makeInstallment({ _id: "installments:3", installmentNumber: 3 }),
      makeInstallment({ _id: "installments:4", installmentNumber: 4 }),
    ];
    return makeCtx({
      initialContracts: [contract],
      initialInstallments: installmentRows,
    });
  }

  it("allocates ₱4,000 to the oldest unpaid installment (cascade not needed)", async () => {
    const bag = basicSetup();
    const result = (await run(bag.ctx, validArgs())) as {
      paymentId: string;
      receiptId: string;
      receiptNumber: string;
      contractClosed: boolean;
      allocations: Array<{
        installmentNumber: number;
        amountAppliedCents: number;
        installmentMarkedPaid: boolean;
      }>;
    };
    expect(result.receiptNumber).toBe("OR-0000101");
    expect(result.contractClosed).toBe(false);
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]!.installmentNumber).toBe(3);
    expect(result.allocations[0]!.amountAppliedCents).toBe(4_000_00);
    expect(result.allocations[0]!.installmentMarkedPaid).toBe(true);

    const installment3 = bag.installments.get("installments:3")!;
    expect(installment3.paidCents).toBe(4_000_00);
    expect(installment3.status).toBe("paid");
    expect(installment3.paidAt).toBe(T0);
    expect(bag.installments.get("installments:4")!.status).toBe("pending");

    // Payment + receipt + one allocation row written by the cornerstone.
    expect(bag.payments.size).toBe(1);
    expect(bag.receipts.size).toBe(1);
    expect(bag.paymentAllocations.size).toBe(1);
    const allocation = Array.from(bag.paymentAllocations.values())[0]!;
    expect(allocation.targetType).toBe("installment");
    expect(allocation.targetId).toBe("installments:3");
    expect(allocation.amountCents).toBe(4_000_00);
  });

  it("partial allocation leaves the installment pending with paidCents updated", async () => {
    const bag = basicSetup();
    await run(bag.ctx, validArgs({ amountCents: 2_000_00 }));
    const installment3 = bag.installments.get("installments:3")!;
    expect(installment3.paidCents).toBe(2_000_00);
    expect(installment3.status).toBe("pending");
    expect(installment3.paidAt).toBeUndefined();
  });

  it("cascades a ₱6,000 payment across installment #3 and #4", async () => {
    const bag = basicSetup();
    const result = (await run(
      bag.ctx,
      validArgs({ amountCents: 6_000_00, idempotencyKey: "idem-cascade" }),
    )) as { allocations: Array<{ installmentNumber: number; amountAppliedCents: number }> };
    expect(result.allocations).toHaveLength(2);
    expect(result.allocations[0]!.installmentNumber).toBe(3);
    expect(result.allocations[0]!.amountAppliedCents).toBe(4_000_00);
    expect(result.allocations[1]!.installmentNumber).toBe(4);
    expect(result.allocations[1]!.amountAppliedCents).toBe(2_000_00);
    expect(bag.installments.get("installments:3")!.status).toBe("paid");
    expect(bag.installments.get("installments:4")!.status).toBe("pending");
    expect(bag.installments.get("installments:4")!.paidCents).toBe(2_000_00);
    // Cornerstone wrote two allocation rows.
    expect(bag.paymentAllocations.size).toBe(2);
  });

  it("auto-closes the contract when the last installment is paid off", async () => {
    const contract = makeContract({});
    const installmentRows = [
      makeInstallment({
        _id: "installments:1",
        installmentNumber: 1,
        paidCents: 4_000_00,
        status: "paid",
      }),
      makeInstallment({ _id: "installments:2", installmentNumber: 2 }),
    ];
    const bag = makeCtx({
      initialContracts: [contract],
      initialInstallments: installmentRows,
    });
    const result = (await run(
      bag.ctx,
      validArgs({ amountCents: 4_000_00, idempotencyKey: "idem-close" }),
    )) as { contractClosed: boolean };
    expect(result.contractClosed).toBe(true);
    expect(bag.contracts.get("contracts:1")!.state).toBe("paid_in_full");
    // Two audit rows: receipt create + contract transition.
    const transitionAudits = bag.auditInserts.filter(
      (a) => (a.row as { action: string }).action === "transition",
    );
    expect(transitionAudits).toHaveLength(1);
    expect(transitionAudits[0]!.row).toMatchObject({
      entityType: "contract",
      after: { state: "paid_in_full" },
      reason: "All installments paid",
    });
  });

  it("trims a non-cash reference and stores it on the payment", async () => {
    const bag = basicSetup();
    await run(
      bag.ctx,
      validArgs({
        paymentMethod: "check",
        reference: "  CHK-7890  ",
        idempotencyKey: "idem-ref",
      }),
    );
    const payment = Array.from(bag.payments.values())[0]!;
    expect(payment.paymentMethod).toBe("check");
    expect(payment.reference).toBe("CHK-7890");
  });
});

describe("recordPaymentWithAutoAllocation — idempotency", () => {
  const run = handlerOf(recordPaymentWithAutoAllocation);

  function setupWithOneUnpaid() {
    const contract = makeContract({});
    const installmentRows = [
      makeInstallment({ _id: "installments:3", installmentNumber: 3 }),
    ];
    return makeCtx({
      initialContracts: [contract],
      initialInstallments: installmentRows,
    });
  }

  it("same key + same payload returns the previously-issued receipt", async () => {
    const bag = setupWithOneUnpaid();
    const args = {
      contractId: "contracts:1",
      amountCents: 4_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-dedup",
    };
    const first = (await run(bag.ctx, args)) as { receiptNumber: string };
    // Reset the contract back to active so the second call doesn't
    // get rejected as "not active" (cornerstone-dedup returns the
    // existing receipt before any state checks fire).
    bag.contracts.set("contracts:1", {
      ...bag.contracts.get("contracts:1")!,
      state: "active",
    });
    // Restore the installment back to pending so the second call has
    // something to allocate against if it tried to allocate (it
    // should NOT — the cornerstone returns early).
    bag.installments.set("installments:3", {
      ...bag.installments.get("installments:3")!,
      paidCents: 0,
      status: "pending",
    });
    const second = (await run(bag.ctx, args)) as { receiptNumber: string };
    expect(second.receiptNumber).toBe(first.receiptNumber);
    // Only one payment row / one receipt — the second call dedup'd
    // inside the cornerstone.
    expect(bag.payments.size).toBe(1);
    expect(bag.receipts.size).toBe(1);
  });

  it("same key + different payload throws IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", async () => {
    const bag = setupWithOneUnpaid();
    await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 4_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-collide",
    });
    // Reset the contract / installment so the second call can
    // theoretically allocate (it must throw at the dedup step
    // instead).
    bag.contracts.set("contracts:1", {
      ...bag.contracts.get("contracts:1")!,
      state: "active",
    });
    bag.installments.set("installments:3", {
      ...bag.installments.get("installments:3")!,
      paidCents: 0,
      status: "pending",
    });
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 2_000_00, // different amount → different payload
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-collide",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(
      ErrorCode.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD,
    );
  });
});

describe("recordPaymentWithAutoAllocation — validation", () => {
  const run = handlerOf(recordPaymentWithAutoAllocation);

  function bagWithUnpaid() {
    const contract = makeContract({});
    const installmentRows = [
      makeInstallment({ _id: "installments:1", installmentNumber: 1 }),
    ];
    return makeCtx({
      initialContracts: [contract],
      initialInstallments: installmentRows,
    });
  }

  it("rejects amount = 0 with VALIDATION", async () => {
    const bag = bagWithUnpaid();
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 0,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects negative amount with VALIDATION", async () => {
    const bag = bagWithUnpaid();
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: -100,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects non-integer amount with VALIDATION", async () => {
    const bag = bagWithUnpaid();
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 1.5,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects cheque without reference with VALIDATION", async () => {
    const bag = bagWithUnpaid();
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 1_000_00,
      paymentMethod: "check" as const,
      paidAt: T0,
      idempotencyKey: "idem",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects empty idempotency key with VALIDATION", async () => {
    const bag = bagWithUnpaid();
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 1_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "   ",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects paidAt in the future beyond the 5-minute skew with VALIDATION", async () => {
    const bag = bagWithUnpaid();
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 1_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0 + 6 * 60 * 1000, // 6 min in the future
      idempotencyKey: "idem-future",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("accepts paidAt within the 5-minute skew tolerance", async () => {
    const bag = bagWithUnpaid();
    const args = {
      contractId: "contracts:1",
      amountCents: 1_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0 + 60 * 1000,
      idempotencyKey: "idem-skew",
    };
    await expect(run(bag.ctx, args)).resolves.toBeTruthy();
  });
});

describe("recordPaymentWithAutoAllocation — auth", () => {
  const run = handlerOf(recordPaymentWithAutoAllocation);

  it("rejects customer role with FORBIDDEN", async () => {
    const contract = makeContract({});
    const installmentRows = [
      makeInstallment({ _id: "installments:1", installmentNumber: 1 }),
    ];
    const bag = makeCtx({
      roles: ["customer"],
      initialContracts: [contract],
      initialInstallments: installmentRows,
    });
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 1_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects field_worker role with FORBIDDEN", async () => {
    const contract = makeContract({});
    const bag = makeCtx({
      roles: ["field_worker"],
      initialContracts: [contract],
      initialInstallments: [
        makeInstallment({ _id: "installments:1", installmentNumber: 1 }),
      ],
    });
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 1_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const contract = makeContract({});
    const bag = makeCtx({
      authenticated: false,
      initialContracts: [contract],
      initialInstallments: [
        makeInstallment({ _id: "installments:1", installmentNumber: 1 }),
      ],
    });
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 1_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});

describe("recordPaymentWithAutoAllocation — contract state", () => {
  const run = handlerOf(recordPaymentWithAutoAllocation);

  it("rejects a full_payment contract with INVARIANT_VIOLATION", async () => {
    const contract = makeContract({ kind: "full_payment", state: "paid_in_full" });
    const bag = makeCtx({ initialContracts: [contract] });
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 1_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("rejects an in-default contract with INVARIANT_VIOLATION", async () => {
    const contract = makeContract({ state: "in_default" });
    const bag = makeCtx({
      initialContracts: [contract],
      initialInstallments: [
        makeInstallment({ _id: "installments:1", installmentNumber: 1 }),
      ],
    });
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 1_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("rejects a missing contract with NOT_FOUND", async () => {
    const bag = makeCtx({});
    const thrown = await run(bag.ctx, {
      contractId: "contracts:ghost",
      amountCents: 1_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("rejects a contract whose installments are all already paid", async () => {
    const contract = makeContract({});
    const installmentRows = [
      makeInstallment({
        _id: "installments:1",
        installmentNumber: 1,
        paidCents: 4_000_00,
        status: "paid",
      }),
    ];
    const bag = makeCtx({
      initialContracts: [contract],
      initialInstallments: installmentRows,
    });
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 1_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });
});

describe("recordPaymentWithAutoAllocation — overpay", () => {
  const run = handlerOf(recordPaymentWithAutoAllocation);

  it("rejects with INVARIANT_VIOLATION (overpay: true, excessCents)", async () => {
    const contract = makeContract({});
    const installmentRows = [
      makeInstallment({ _id: "installments:1", installmentNumber: 1 }),
    ];
    const bag = makeCtx({
      initialContracts: [contract],
      initialInstallments: installmentRows,
    });
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 100_000_00, // far above the ₱4,000 outstanding
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-overpay",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
    const details = getDetails(thrown)!;
    expect(details.overpay).toBe(true);
    expect(details.excessCents).toBe(96_000_00);
    // No partial writes — overpay short-circuits before
    // postFinancialEvent.
    expect(bag.payments.size).toBe(0);
    expect(bag.receipts.size).toBe(0);
  });
});

describe("listContractPayments", () => {
  const run = handlerOf(listContractPayments);

  it("returns payments for a contract in descending creation-time order", async () => {
    const bag = makeCtx({});
    // Seed two payment rows + their receipt rows directly so we don't
    // have to drive the full mutation path twice.
    const p1 = "payments:p1";
    const p2 = "payments:p2";
    bag.payments.set(p1, {
      _id: p1,
      _creationTime: T0,
      paymentNumber: "OR-0000101",
      contractId: "contracts:1",
      customerId: "customers:1",
      amountCents: 4_000_00,
      paymentMethod: "cash",
      receivedAt: T0,
      receivedByUserId: USER_ID,
      idempotencyKey: "idem-1",
      isVoided: false,
    });
    bag.payments.set(p2, {
      _id: p2,
      _creationTime: T0 + 1000,
      paymentNumber: "OR-0000102",
      contractId: "contracts:1",
      customerId: "customers:1",
      amountCents: 4_000_00,
      paymentMethod: "check",
      reference: "CHK-001",
      receivedAt: T0 + 1000,
      receivedByUserId: USER_ID,
      idempotencyKey: "idem-2",
      isVoided: false,
    });
    bag.receipts.set("receipts:r1", {
      _id: "receipts:r1",
      _creationTime: T0,
      paymentId: p1,
      receiptNumber: "OR-0000101",
      receiptSerial: 101,
      isVoided: false,
    });
    bag.receipts.set("receipts:r2", {
      _id: "receipts:r2",
      _creationTime: T0 + 1000,
      paymentId: p2,
      receiptNumber: "OR-0000102",
      receiptSerial: 102,
      isVoided: false,
    });

    const result = (await run(bag.ctx, {
      contractId: "contracts:1",
    })) as Array<{
      paymentId: string;
      receiptNumber?: string;
      paymentMethod: string;
    }>;
    expect(result).toHaveLength(2);
    expect(result[0]!.paymentId).toBe(p2);
    expect(result[0]!.receiptNumber).toBe("OR-0000102");
    expect(result[0]!.paymentMethod).toBe("check");
    expect(result[1]!.paymentId).toBe(p1);
  });

  it("caps the result at the supplied limit", async () => {
    const bag = makeCtx({});
    for (let i = 0; i < 5; i++) {
      const pid = `payments:p${i}`;
      bag.payments.set(pid, {
        _id: pid,
        _creationTime: T0 + i,
        paymentNumber: `OR-${i}`,
        contractId: "contracts:1",
        amountCents: 100_00,
        paymentMethod: "cash",
        receivedAt: T0,
        receivedByUserId: USER_ID,
        idempotencyKey: `idem-${i}`,
        isVoided: false,
      });
    }
    const result = (await run(bag.ctx, {
      contractId: "contracts:1",
      limit: 2,
    })) as unknown[];
    expect(result).toHaveLength(2);
  });
});
