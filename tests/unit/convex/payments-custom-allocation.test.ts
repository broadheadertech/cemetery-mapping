/**
 * Story 3.10 — `convex/payments.ts` `recordPaymentWithCustomAllocation`
 * unit tests.
 *
 * Coverage target: ≥ 95% line coverage on the manual-override branch.
 * Story 3.10 is financial-touching (FR27, FR32) so NFR-M2's
 * cornerstone-adjacent threshold applies.
 *
 * Strategy mirrors `payments.test.ts` (Story 3.9): a hand-mocked ctx
 * keyed off `convex/_generated/` (which the repo deliberately doesn't
 * have until `npx convex dev` runs interactively). The harness exposes
 * a `rows` bag per table so assertions can be positional.
 *
 * Test cases:
 *
 *   - Happy path: redistributes a ₱4,000 payment from oldest-unpaid to
 *     a newer installment.
 *   - Multi-row split: a ₱4,000 payment splits across two installments.
 *   - Allocation-sum mismatch: sum != amount → ALLOCATION_SUM_MISMATCH.
 *   - Per-row exceeds outstanding: a row that overpays an installment
 *     → INVARIANT_VIOLATION.
 *   - Targets an already-paid installment → INVARIANT_VIOLATION.
 *   - Allocation references an installment that doesn't belong to the
 *     contract → INVARIANT_VIOLATION.
 *   - Duplicate installmentId across rows → INVARIANT_VIOLATION.
 *   - Empty `allocations` array → EMPTY_ALLOCATIONS.
 *   - Zero-only `allocations` (every row 0 amountCents) →
 *     ALLOCATION_SUM_MISMATCH (the sum check fires first).
 *   - Validation: amount = 0 / negative / non-integer → VALIDATION.
 *   - Auth: customer / field_worker / unauthenticated → FORBIDDEN /
 *     UNAUTHENTICATED.
 *   - Closes the contract when the last installment is paid off.
 *   - Idempotency: same key + same payload returns the previously-
 *     issued receipt; same key + different payload throws.
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
import { recordPaymentWithCustomAllocation } from "../../../convex/payments";

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

function basicSetup() {
  // Two unpaid installments: #3 (overdue ₱4,000) + #4 (pending ₱4,000).
  // Installments #1 + #2 are already paid.
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
    makeInstallment({
      _id: "installments:3",
      installmentNumber: 3,
      status: "overdue",
    }),
    makeInstallment({ _id: "installments:4", installmentNumber: 4 }),
  ];
  return makeCtx({
    initialContracts: [contract],
    initialInstallments: installmentRows,
  });
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

describe("recordPaymentWithCustomAllocation — happy path", () => {
  const run = handlerOf(recordPaymentWithCustomAllocation);

  it("redistributes ₱4,000 to installment #4 instead of the FIFO default (#3)", async () => {
    const bag = basicSetup();
    const result = (await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 4_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-custom-001",
      allocations: [
        { installmentId: "installments:4", amountCents: 4_000_00 },
      ],
    })) as {
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
    expect(result.allocations[0]!.installmentNumber).toBe(4);
    expect(result.allocations[0]!.amountAppliedCents).toBe(4_000_00);
    expect(result.allocations[0]!.installmentMarkedPaid).toBe(true);

    // Installment #3 stays overdue, #4 is closed.
    expect(bag.installments.get("installments:3")!.status).toBe("overdue");
    expect(bag.installments.get("installments:3")!.paidCents).toBe(0);
    expect(bag.installments.get("installments:4")!.status).toBe("paid");
    expect(bag.installments.get("installments:4")!.paidCents).toBe(4_000_00);

    // Cornerstone wrote payment + receipt + one allocation row.
    expect(bag.payments.size).toBe(1);
    expect(bag.receipts.size).toBe(1);
    expect(bag.paymentAllocations.size).toBe(1);
    const allocation = Array.from(bag.paymentAllocations.values())[0]!;
    expect(allocation.targetType).toBe("installment");
    expect(allocation.targetId).toBe("installments:4");
    expect(allocation.amountCents).toBe(4_000_00);
  });

  it("splits a ₱4,000 payment across installment #3 (₱1,500) and #4 (₱2,500)", async () => {
    const bag = basicSetup();
    const result = (await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 4_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-split",
      allocations: [
        { installmentId: "installments:3", amountCents: 1_500_00 },
        { installmentId: "installments:4", amountCents: 2_500_00 },
      ],
    })) as {
      allocations: Array<{
        installmentNumber: number;
        amountAppliedCents: number;
        installmentMarkedPaid: boolean;
      }>;
    };
    expect(result.allocations).toHaveLength(2);
    expect(bag.installments.get("installments:3")!.paidCents).toBe(1_500_00);
    expect(bag.installments.get("installments:3")!.status).toBe("overdue");
    expect(bag.installments.get("installments:4")!.paidCents).toBe(2_500_00);
    expect(bag.installments.get("installments:4")!.status).toBe("pending");
    expect(bag.paymentAllocations.size).toBe(2);
  });

  it("drops zero-amount rows but counts them in the sum check", async () => {
    const bag = basicSetup();
    // A row with 0 + a row with 4,000 sums to 4,000 — should succeed
    // and only one paymentAllocations row is written.
    await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 4_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-zero",
      allocations: [
        { installmentId: "installments:3", amountCents: 0 },
        { installmentId: "installments:4", amountCents: 4_000_00 },
      ],
    });
    expect(bag.paymentAllocations.size).toBe(1);
    expect(bag.installments.get("installments:3")!.paidCents).toBe(0);
    expect(bag.installments.get("installments:4")!.status).toBe("paid");
  });

  it("trims a non-cash reference and stores it on the payment", async () => {
    const bag = basicSetup();
    await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 4_000_00,
      paymentMethod: "check" as const,
      reference: "  CHK-2222  ",
      paidAt: T0,
      idempotencyKey: "idem-ref",
      allocations: [
        { installmentId: "installments:4", amountCents: 4_000_00 },
      ],
    });
    const payment = Array.from(bag.payments.values())[0]!;
    expect(payment.paymentMethod).toBe("check");
    expect(payment.reference).toBe("CHK-2222");
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
    const result = (await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 4_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-close",
      allocations: [
        { installmentId: "installments:2", amountCents: 4_000_00 },
      ],
    })) as { contractClosed: boolean };
    expect(result.contractClosed).toBe(true);
    expect(bag.contracts.get("contracts:1")!.state).toBe("paid_in_full");
  });
});

describe("recordPaymentWithCustomAllocation — server-side validation", () => {
  const run = handlerOf(recordPaymentWithCustomAllocation);

  it("rejects sum mismatch with ALLOCATION_SUM_MISMATCH", async () => {
    const bag = basicSetup();
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 4_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-mismatch",
      allocations: [
        { installmentId: "installments:3", amountCents: 1_000_00 },
        { installmentId: "installments:4", amountCents: 1_500_00 },
      ],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.ALLOCATION_SUM_MISMATCH);
    // No financial writes when validation fails.
    expect(bag.payments.size).toBe(0);
    expect(bag.receipts.size).toBe(0);
    expect(bag.paymentAllocations.size).toBe(0);
  });

  it("rejects a row that exceeds the installment outstanding balance with INVARIANT_VIOLATION", async () => {
    const bag = basicSetup();
    // Installment #4 has ₱4,000 outstanding — a ₱5,000 row exceeds.
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 5_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-overflow",
      allocations: [
        { installmentId: "installments:4", amountCents: 5_000_00 },
      ],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("rejects an allocation that targets an already-paid installment with INVARIANT_VIOLATION", async () => {
    const bag = basicSetup();
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 1_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-paid",
      allocations: [
        // Installment #1 is already paid.
        { installmentId: "installments:1", amountCents: 1_000_00 },
      ],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("rejects an allocation that references a non-existent installment with INVARIANT_VIOLATION", async () => {
    const bag = basicSetup();
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 1_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-ghost",
      allocations: [
        { installmentId: "installments:9999", amountCents: 1_000_00 },
      ],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("rejects duplicate installmentId across rows with INVARIANT_VIOLATION", async () => {
    const bag = basicSetup();
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 4_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-dup",
      allocations: [
        { installmentId: "installments:4", amountCents: 2_000_00 },
        { installmentId: "installments:4", amountCents: 2_000_00 },
      ],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("rejects an empty allocations array with EMPTY_ALLOCATIONS", async () => {
    const bag = basicSetup();
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 4_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-empty",
      allocations: [],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.EMPTY_ALLOCATIONS);
  });

  it("rejects a negative per-row amount with VALIDATION", async () => {
    const bag = basicSetup();
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 4_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-neg",
      allocations: [
        { installmentId: "installments:3", amountCents: -100 },
        { installmentId: "installments:4", amountCents: 4_000_00 + 100 },
      ],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects a non-integer per-row amount with VALIDATION", async () => {
    const bag = basicSetup();
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 4_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-frac",
      allocations: [
        { installmentId: "installments:4", amountCents: 4_000_00 + 0.5 },
      ],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects amount = 0 with VALIDATION", async () => {
    const bag = basicSetup();
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 0,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-zero-amt",
      allocations: [
        { installmentId: "installments:4", amountCents: 0 },
      ],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects cheque without reference with VALIDATION", async () => {
    const bag = basicSetup();
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 4_000_00,
      paymentMethod: "check" as const,
      paidAt: T0,
      idempotencyKey: "idem-no-ref",
      allocations: [
        { installmentId: "installments:4", amountCents: 4_000_00 },
      ],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects paidAt in the future beyond the 5-minute skew with VALIDATION", async () => {
    const bag = basicSetup();
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 4_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0 + 6 * 60 * 1000,
      idempotencyKey: "idem-future",
      allocations: [
        { installmentId: "installments:4", amountCents: 4_000_00 },
      ],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects empty idempotency key with VALIDATION", async () => {
    const bag = basicSetup();
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 4_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "   ",
      allocations: [
        { installmentId: "installments:4", amountCents: 4_000_00 },
      ],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });
});

describe("recordPaymentWithCustomAllocation — contract state", () => {
  const run = handlerOf(recordPaymentWithCustomAllocation);

  it("rejects a full_payment contract with INVARIANT_VIOLATION", async () => {
    const contract = makeContract({
      kind: "full_payment",
      state: "paid_in_full",
    });
    const bag = makeCtx({ initialContracts: [contract] });
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 4_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem",
      allocations: [
        { installmentId: "installments:1", amountCents: 4_000_00 },
      ],
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
      amountCents: 4_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem",
      allocations: [
        { installmentId: "installments:1", amountCents: 4_000_00 },
      ],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("rejects a missing contract with NOT_FOUND", async () => {
    const bag = makeCtx({});
    const thrown = await run(bag.ctx, {
      contractId: "contracts:ghost",
      amountCents: 4_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem",
      allocations: [
        { installmentId: "installments:1", amountCents: 4_000_00 },
      ],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });
});

describe("recordPaymentWithCustomAllocation — auth", () => {
  const run = handlerOf(recordPaymentWithCustomAllocation);

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
      amountCents: 4_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem",
      allocations: [
        { installmentId: "installments:1", amountCents: 4_000_00 },
      ],
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
      amountCents: 4_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem",
      allocations: [
        { installmentId: "installments:1", amountCents: 4_000_00 },
      ],
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
      amountCents: 4_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem",
      allocations: [
        { installmentId: "installments:1", amountCents: 4_000_00 },
      ],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});

describe("recordPaymentWithCustomAllocation — idempotency", () => {
  const run = handlerOf(recordPaymentWithCustomAllocation);

  it("same key + same payload returns the previously-issued receipt", async () => {
    const bag = basicSetup();
    const args = {
      contractId: "contracts:1",
      amountCents: 4_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-dedup",
      allocations: [
        { installmentId: "installments:4", amountCents: 4_000_00 },
      ],
    };
    const first = (await run(bag.ctx, args)) as { receiptNumber: string };
    // Reset contract back to active + installment back to pending so
    // the second call has something to write IF it tried to (it must
    // dedup before that).
    bag.contracts.set("contracts:1", {
      ...bag.contracts.get("contracts:1")!,
      state: "active",
    });
    bag.installments.set("installments:4", {
      ...bag.installments.get("installments:4")!,
      paidCents: 0,
      status: "pending",
    });
    const second = (await run(bag.ctx, args)) as { receiptNumber: string };
    expect(second.receiptNumber).toBe(first.receiptNumber);
    expect(bag.payments.size).toBe(1);
    expect(bag.receipts.size).toBe(1);
  });

  it("same key + different payload throws IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", async () => {
    const bag = basicSetup();
    await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 4_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-collide",
      allocations: [
        { installmentId: "installments:4", amountCents: 4_000_00 },
      ],
    });
    bag.contracts.set("contracts:1", {
      ...bag.contracts.get("contracts:1")!,
      state: "active",
    });
    bag.installments.set("installments:4", {
      ...bag.installments.get("installments:4")!,
      paidCents: 0,
      status: "pending",
    });
    const thrown = await run(bag.ctx, {
      contractId: "contracts:1",
      amountCents: 2_000_00,
      paymentMethod: "cash" as const,
      paidAt: T0,
      idempotencyKey: "idem-collide",
      allocations: [
        { installmentId: "installments:4", amountCents: 2_000_00 },
      ],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(
      ErrorCode.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD,
    );
  });
});
