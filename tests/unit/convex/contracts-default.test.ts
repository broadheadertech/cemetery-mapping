/**
 * Story 4.4 — `markContractInDefault` mutation tests (FR37).
 *
 * Coverage focus:
 *   - Happy path: admin marks an active contract in-default with a
 *     valid reason. Contract transitions to `in_default`; the lot's
 *     status, ownership rows, payments, receipts, and installments
 *     remain UNCHANGED (Story 4.4 AC4 invariant — default ≠ reclaim).
 *   - Audit trail contains BOTH the structural `transition` row (from
 *     `transitionContractState`) AND the operator-facing
 *     `contract.markDefault` row.
 *   - The mutation schedules
 *     `internal_recomputeAgingForContractMutation` for the contract.
 *   - Role gating: office_staff / field_worker / unauthenticated
 *     callers are rejected before any writes happen.
 *   - VALIDATION: reasons under 10 chars (after trim) are rejected.
 *   - NOT_FOUND: bogus contract id surfaces a NOT_FOUND error.
 *   - INVARIANT_VIOLATION: cannot default a contract whose state is
 *     not `active` (paid_in_full / cancelled / voided / in_default).
 *
 * The fixture mirrors `tests/unit/convex/contracts-void.test.ts` —
 * same hand-mocked Convex `ctx`, same `handlerOf` extraction trick.
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
import { markContractInDefault } from "../../../convex/contracts";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const USER_ID = "users:abc123";
const SESSION_ID = "authSessions:def456";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

type LotStatus =
  | "available"
  | "reserved"
  | "sold"
  | "occupied"
  | "cancelled"
  | "defaulted"
  | "transferred";

interface LotFixture {
  _id: string;
  _creationTime: number;
  code: string;
  section: string;
  block: string;
  row: string;
  status: LotStatus;
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
}

interface PaymentFixture {
  _id: string;
  _creationTime: number;
  contractId: string;
  amountCents: number;
  paymentMethod: string;
  isVoided: boolean;
}

interface ReceiptFixture {
  _id: string;
  _creationTime: number;
  receiptNumber: string;
  receiptSerial: number;
  isVoided: boolean;
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
}

interface OwnershipFixture {
  _id: string;
  _creationTime: number;
  contractId: string;
  customerId: string;
  lotId: string;
  effectiveFrom: number;
  effectiveTo?: number;
}

interface CtxBag {
  lots: Map<string, LotFixture>;
  customers: Map<string, CustomerFixture>;
  contracts: Map<string, ContractFixture>;
  payments: Map<string, PaymentFixture>;
  receipts: Map<string, ReceiptFixture>;
  installments: Map<string, InstallmentFixture>;
  ownerships: Map<string, OwnershipFixture>;
  auditInserts: Array<{ row: Record<string, unknown> }>;
  patches: Array<{ id: string; patch: Record<string, unknown> }>;
  scheduled: Array<{ delayMs: number; ref: unknown; args: unknown }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  initialLots?: LotFixture[];
  initialCustomers?: CustomerFixture[];
  initialContracts?: ContractFixture[];
  initialPayments?: PaymentFixture[];
  initialReceipts?: ReceiptFixture[];
  initialInstallments?: InstallmentFixture[];
  initialOwnerships?: OwnershipFixture[];
  authenticated?: boolean;
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
  const payments = new Map<string, PaymentFixture>(
    (opts.initialPayments ?? []).map((p) => [p._id, p]),
  );
  const receipts = new Map<string, ReceiptFixture>(
    (opts.initialReceipts ?? []).map((r) => [r._id, r]),
  );
  const installments = new Map<string, InstallmentFixture>(
    (opts.initialInstallments ?? []).map((i) => [i._id, i]),
  );
  const ownerships = new Map<string, OwnershipFixture>(
    (opts.initialOwnerships ?? []).map((o) => [o._id, o]),
  );
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

  let nextId = 1;

  function tableRows(table: string): Record<string, unknown>[] {
    if (table === "userRoles") {
      return userRoles as unknown as Record<string, unknown>[];
    }
    if (table === "lots")
      return Array.from(lots.values()) as unknown as Record<string, unknown>[];
    if (table === "customers")
      return Array.from(customers.values()) as unknown as Record<
        string,
        unknown
      >[];
    if (table === "contracts")
      return Array.from(contracts.values()) as unknown as Record<
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
    if (table === "installments")
      return Array.from(installments.values()) as unknown as Record<
        string,
        unknown
      >[];
    if (table === "ownerships")
      return Array.from(ownerships.values()) as unknown as Record<
        string,
        unknown
      >[];
    return [];
  }

  interface IndexQuery {
    eqs: Record<string, unknown>;
    eq(field: string, value: unknown): IndexQuery;
  }

  function makeQueryBuilder(table: string) {
    type Predicate = (r: Record<string, unknown>) => boolean;
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
          predicates.push((r) => r[field] === value);
        }
        return builder;
      },
      async first(): Promise<Record<string, unknown> | null> {
        for (const row of tableRows(table)) {
          if (predicates.every((p) => p(row))) return row;
        }
        return null;
      },
      async unique(): Promise<Record<string, unknown> | null> {
        const matches = tableRows(table).filter((r) =>
          predicates.every((p) => p(r)),
        );
        if (matches.length === 0) return null;
        if (matches.length > 1) {
          throw new Error(`unique() found ${matches.length} rows in ${table}`);
        }
        return matches[0] ?? null;
      },
      async collect(): Promise<Record<string, unknown>[]> {
        return tableRows(table).filter((r) =>
          predicates.every((p) => p(r)),
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
        if (lots.has(id)) return lots.get(id);
        if (customers.has(id)) return customers.get(id);
        if (contracts.has(id)) return contracts.get(id);
        if (payments.has(id)) return payments.get(id);
        if (receipts.has(id)) return receipts.get(id);
        if (installments.has(id)) return installments.get(id);
        if (ownerships.has(id)) return ownerships.get(id);
        return null;
      }),
      query: vi.fn((table: string) => makeQueryBuilder(table)),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "auditLog") {
          auditInserts.push({ row });
          return `auditLog:${auditInserts.length}`;
        }
        return `${table}:${nextId++}`;
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        patches.push({ id, patch });
        if (lots.has(id)) {
          const existing = lots.get(id)!;
          lots.set(id, { ...existing, ...patch } as LotFixture);
        } else if (contracts.has(id)) {
          const existing = contracts.get(id)!;
          contracts.set(id, { ...existing, ...patch } as ContractFixture);
        } else if (payments.has(id)) {
          const existing = payments.get(id)!;
          payments.set(id, { ...existing, ...patch } as PaymentFixture);
        } else if (receipts.has(id)) {
          const existing = receipts.get(id)!;
          receipts.set(id, { ...existing, ...patch } as ReceiptFixture);
        } else if (installments.has(id)) {
          const existing = installments.get(id)!;
          installments.set(id, {
            ...existing,
            ...patch,
          } as InstallmentFixture);
        } else if (ownerships.has(id)) {
          const existing = ownerships.get(id)!;
          ownerships.set(id, {
            ...existing,
            ...patch,
          } as OwnershipFixture);
        }
      }),
    },
    scheduler: {
      runAfter: vi.fn(async (delayMs: number, ref: unknown, args: unknown) => {
        scheduled.push({ delayMs, ref, args });
        return `scheduled:${scheduled.length}`;
      }),
    },
  };

  return {
    lots,
    customers,
    contracts,
    payments,
    receipts,
    installments,
    ownerships,
    auditInserts,
    patches,
    scheduled,
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
    status: "sold",
    basePriceCents: 150_000_00,
    isRetired: false,
    ...overrides,
  };
}

function makeCustomer(
  overrides: Partial<CustomerFixture> = {},
): CustomerFixture {
  return {
    _id: overrides._id ?? "customers:1",
    _creationTime: T0,
    fullName: "Juan Dela Cruz",
    govIdNumber: "1234-5678-9012",
    address: { line1: "123 Main St" },
    ...overrides,
  };
}

function makeContract(
  overrides: Partial<ContractFixture> = {},
): ContractFixture {
  return {
    _id: overrides._id ?? "contracts:1",
    _creationTime: T0,
    contractNumber: "CON-2026-1",
    lotId: "lots:1",
    customerId: "customers:1",
    kind: "installment",
    totalPriceCents: 200_000_00,
    state: "active",
    createdAt: T0,
    createdBy: USER_ID,
    ...overrides,
  };
}

function makeInstallment(
  overrides: Partial<InstallmentFixture> = {},
): InstallmentFixture {
  return {
    _id: overrides._id ?? "installments:1",
    _creationTime: T0,
    contractId: overrides.contractId ?? "contracts:1",
    installmentNumber: overrides.installmentNumber ?? 1,
    dueDate: overrides.dueDate ?? T0,
    principalCents: overrides.principalCents ?? 10_000_00,
    paidCents: overrides.paidCents ?? 0,
    status: overrides.status ?? "overdue",
  };
}

function makeOwnership(
  overrides: Partial<OwnershipFixture> = {},
): OwnershipFixture {
  return {
    _id: overrides._id ?? "ownerships:1",
    _creationTime: T0,
    contractId: overrides.contractId ?? "contracts:1",
    customerId: overrides.customerId ?? "customers:1",
    lotId: overrides.lotId ?? "lots:1",
    effectiveFrom: T0,
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

describe("markContractInDefault", () => {
  const run = handlerOf(markContractInDefault);

  it("admin marks an active contract in-default: state flips, lot/ownership/installments untouched, audit + recompute scheduled", async () => {
    const lot = makeLot({ status: "sold" });
    const customer = makeCustomer();
    const contract = makeContract({ state: "active" });
    const overdue = makeInstallment({
      _id: "installments:1",
      status: "overdue",
      paidCents: 0,
    });
    const ownership = makeOwnership();
    const bag = makeCtx({
      roles: ["admin"],
      initialLots: [lot],
      initialCustomers: [customer],
      initialContracts: [contract],
      initialInstallments: [overdue],
      initialOwnerships: [ownership],
    });

    const result = (await run(bag.ctx, {
      contractId: contract._id,
      reason: "Customer has not responded after 3 follow-ups.",
    })) as { contractId: string; from: string; to: string };

    expect(result.from).toBe("active");
    expect(result.to).toBe("in_default");
    expect(bag.contracts.get(contract._id)!.state).toBe("in_default");

    // AC4 invariants — default ≠ reclaim.
    expect(bag.lots.get(lot._id)!.status).toBe("sold");
    expect(bag.ownerships.get(ownership._id)!.effectiveTo).toBeUndefined();
    expect(bag.installments.get(overdue._id)!.status).toBe("overdue");
    expect(bag.installments.get(overdue._id)!.paidCents).toBe(0);

    // Audit trail — both the structural transition row AND the
    // operator-facing `update` row (prefixed `markDefault:` in the
    // reason) are present. The dot-namespaced "contract.markDefault"
    // action isn't supported by the AuditAction enum, so we follow
    // the voidContract pattern of pairing a structural transition
    // with a defined-action update + a descriptive reason prefix.
    const actions = bag.auditInserts.map((a) => ({
      action: a.row.action,
      entityType: a.row.entityType,
    }));
    expect(actions).toContainEqual({
      action: "transition",
      entityType: "contract",
    });
    expect(actions).toContainEqual({
      action: "update",
      entityType: "contract",
    });

    // No lot transition fired.
    expect(actions).not.toContainEqual({
      action: "transition",
      entityType: "lot",
    });

    // The reason is propagated to the audit row (the markDefault:
    // prefix is what distinguishes this update from generic updates).
    const markDefaultRow = bag.auditInserts.find(
      (a) =>
        a.row.action === "update" &&
        typeof a.row.reason === "string" &&
        (a.row.reason as string).startsWith("markDefault:"),
    );
    expect(markDefaultRow).toBeDefined();
    expect(markDefaultRow?.row.reason).toContain(
      "Customer has not responded after 3 follow-ups.",
    );

    // The AR aging recompute is scheduled for this contract.
    expect(bag.scheduled).toHaveLength(1);
    expect(bag.scheduled[0]!.delayMs).toBe(0);
    expect(bag.scheduled[0]!.args).toEqual({ contractId: contract._id });
  });

  it("trims the reason before persisting and propagates the trimmed value to audit", async () => {
    const lot = makeLot({ status: "sold" });
    const customer = makeCustomer();
    const contract = makeContract({ state: "active" });
    const bag = makeCtx({
      roles: ["admin"],
      initialLots: [lot],
      initialCustomers: [customer],
      initialContracts: [contract],
    });

    await run(bag.ctx, {
      contractId: contract._id,
      reason: "   Severely overdue — escalate.   ",
    });

    const markDefaultRow = bag.auditInserts.find(
      (a) =>
        a.row.action === "update" &&
        typeof a.row.reason === "string" &&
        (a.row.reason as string).startsWith("markDefault:"),
    );
    expect(markDefaultRow?.row.reason).toBe(
      "markDefault: Severely overdue — escalate.",
    );
  });

  it("rejects office_staff callers with FORBIDDEN; no writes occur", async () => {
    const lot = makeLot({ status: "sold" });
    const customer = makeCustomer();
    const contract = makeContract({ state: "active" });
    const bag = makeCtx({
      roles: ["office_staff"],
      initialLots: [lot],
      initialCustomers: [customer],
      initialContracts: [contract],
    });

    const thrown = await run(bag.ctx, {
      contractId: contract._id,
      reason: "Should never run — gated by requireRole.",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
    expect(bag.contracts.get(contract._id)!.state).toBe("active");
    expect(bag.lots.get(lot._id)!.status).toBe("sold");
    expect(bag.auditInserts).toHaveLength(0);
    expect(bag.scheduled).toHaveLength(0);
  });

  it("rejects field_worker callers with FORBIDDEN", async () => {
    const lot = makeLot({ status: "sold" });
    const customer = makeCustomer();
    const contract = makeContract({ state: "active" });
    const bag = makeCtx({
      roles: ["field_worker"],
      initialLots: [lot],
      initialCustomers: [customer],
      initialContracts: [contract],
    });

    const thrown = await run(bag.ctx, {
      contractId: contract._id,
      reason: "Field workers cannot mark contracts in default.",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
    expect(bag.contracts.get(contract._id)!.state).toBe("active");
  });

  it("rejects unauthenticated callers", async () => {
    const lot = makeLot({ status: "sold" });
    const customer = makeCustomer();
    const contract = makeContract({ state: "active" });
    const bag = makeCtx({
      authenticated: false,
      initialLots: [lot],
      initialCustomers: [customer],
      initialContracts: [contract],
    });

    const thrown = await run(bag.ctx, {
      contractId: contract._id,
      reason: "Auth gate should reject this caller.",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
    expect(bag.scheduled).toHaveLength(0);
  });

  it("throws VALIDATION when reason is under 10 chars after trim", async () => {
    const lot = makeLot({ status: "sold" });
    const customer = makeCustomer();
    const contract = makeContract({ state: "active" });
    const bag = makeCtx({
      roles: ["admin"],
      initialLots: [lot],
      initialCustomers: [customer],
      initialContracts: [contract],
    });

    const thrown = await run(bag.ctx, {
      contractId: contract._id,
      reason: "too short",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    expect(bag.contracts.get(contract._id)!.state).toBe("active");
    expect(bag.auditInserts).toHaveLength(0);
    expect(bag.scheduled).toHaveLength(0);
  });

  it("throws VALIDATION when reason is whitespace-only", async () => {
    const lot = makeLot({ status: "sold" });
    const customer = makeCustomer();
    const contract = makeContract({ state: "active" });
    const bag = makeCtx({
      roles: ["admin"],
      initialLots: [lot],
      initialCustomers: [customer],
      initialContracts: [contract],
    });

    const thrown = await run(bag.ctx, {
      contractId: contract._id,
      reason: "                ",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("throws NOT_FOUND when the contract id does not resolve", async () => {
    const bag = makeCtx({ roles: ["admin"] });
    const thrown = await run(bag.ctx, {
      contractId: "contracts:ghost",
      reason: "Looking up a contract that does not exist.",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it.each(["paid_in_full", "cancelled", "voided", "in_default"] as const)(
    "throws INVARIANT_VIOLATION when contract state is %s (only active can be marked in-default)",
    async (state) => {
      const lot = makeLot({ status: "sold" });
      const customer = makeCustomer();
      const contract = makeContract({ state });
      const bag = makeCtx({
        roles: ["admin"],
        initialLots: [lot],
        initialCustomers: [customer],
        initialContracts: [contract],
      });

      const thrown = await run(bag.ctx, {
        contractId: contract._id,
        reason: "Trying to default a non-active contract should fail.",
      }).catch((e) => e);
      expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
      // No mutation of contract, lot, or schedule.
      expect(bag.contracts.get(contract._id)!.state).toBe(state);
      expect(bag.auditInserts).toHaveLength(0);
      expect(bag.scheduled).toHaveLength(0);
    },
  );

  it("does not touch payments or receipts (FR31 immutability)", async () => {
    const lot = makeLot({ status: "sold" });
    const customer = makeCustomer();
    const contract = makeContract({ state: "active" });
    const payment: PaymentFixture = {
      _id: "payments:1",
      _creationTime: T0,
      contractId: contract._id,
      amountCents: 50_000_00,
      paymentMethod: "cash",
      isVoided: false,
    };
    const receipt: ReceiptFixture = {
      _id: "receipts:1",
      _creationTime: T0,
      receiptNumber: "OR-0000007",
      receiptSerial: 7,
      isVoided: false,
    };
    const bag = makeCtx({
      roles: ["admin"],
      initialLots: [lot],
      initialCustomers: [customer],
      initialContracts: [contract],
      initialPayments: [payment],
      initialReceipts: [receipt],
    });

    await run(bag.ctx, {
      contractId: contract._id,
      reason: "Defaulting with prior payment on the contract record.",
    });

    const postPayment = bag.payments.get(payment._id)!;
    const postReceipt = bag.receipts.get(receipt._id)!;

    expect(postPayment.isVoided).toBe(false);
    expect(postPayment.amountCents).toBe(50_000_00);
    expect(postReceipt.isVoided).toBe(false);
    expect(postReceipt.receiptNumber).toBe("OR-0000007");
    expect(postReceipt.receiptSerial).toBe(7);

    const touchedFinancials = bag.patches.filter(
      (p) => p.id.startsWith("payments:") || p.id.startsWith("receipts:"),
    );
    expect(touchedFinancials).toHaveLength(0);
  });
});
