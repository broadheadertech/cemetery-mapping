/**
 * Story 6.2 — Demand-letter PDF generation tests (FR50).
 *
 * Scope:
 *   - `generateDemandLetterRequest` mutation: auth gating, NOT_FOUND
 *     handling, overdue gate (the core new constraint vs. Story 6.1's
 *     contract-PDF mutation), audit emission, scheduler scheduling.
 *   - `getDemandLetterUrl` query: auth gating, NOT_FOUND handling, the
 *     null-URL branch (contract has no demand letter), the signed-URL
 *     branch (contract has a demand letter).
 *   - `getContractOverdueSummary` query: returns `isOverdue: true` when
 *     at least one installment is overdue; `false` otherwise; auth gate.
 *   - Path-string parity: the action's exported function-path constants
 *     must match the path the mutation builds via
 *     `makeFunctionReference` — pinned so a refactor surfaces drift.
 *   - The pure `renderDemandLetterPdf` helper: smoke-renders a stub
 *     payload into a PDFKit document and asserts non-empty output with
 *     the `%PDF-` magic header. No pixel diff (deferred to Phase 2).
 *
 * Strategy: hand-mocked ctx mirroring `contracts-pdf.test.ts` — same
 * pattern Story 6.1's tests use; `convex-test` requires
 * `convex/_generated/` which this repo deliberately avoids (see the
 * top-of-file rationale in `convex/gpsImport.ts`).
 */

import { ConvexError, type Value } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCode, type ErrorPayload } from "../../../convex/lib/errors";
import { HOUR_MS, DAY_MS } from "../../../convex/lib/time";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { getFunctionName } from "convex/server";
import {
  generateDemandLetterRequest,
  getDemandLetterUrl,
  getContractOverdueSummary,
} from "../../../convex/contracts";

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
  demandLetterStorageId?: string;
  demandLetterGeneratedAt?: number;
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

interface CtxBag {
  contracts: Map<string, ContractFixture>;
  installments: Map<string, InstallmentFixture[]>;
  auditInserts: Array<{ row: Record<string, unknown> }>;
  scheduledRuns: Array<{
    delayMs: number;
    functionPath: string;
    args: Record<string, unknown>;
  }>;
  storageUrlsByBlob: Map<string, string>;
  patches: Array<{ id: string; patch: Record<string, unknown> }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  initialContracts?: ContractFixture[];
  initialInstallments?: InstallmentFixture[];
  authenticated?: boolean;
  storageUrlsByBlob?: Map<string, string>;
}): CtxBag {
  const contracts = new Map<string, ContractFixture>(
    (opts.initialContracts ?? []).map((c) => [c._id, c]),
  );
  // Group installments by contractId for the `by_contract` index lookup.
  const installments = new Map<string, InstallmentFixture[]>();
  for (const row of opts.initialInstallments ?? []) {
    const existing = installments.get(row.contractId) ?? [];
    existing.push(row);
    installments.set(row.contractId, existing);
  }
  const auditInserts: Array<{ row: Record<string, unknown> }> = [];
  const scheduledRuns: Array<{
    delayMs: number;
    functionPath: string;
    args: Record<string, unknown>;
  }> = [];
  const storageUrlsByBlob =
    opts.storageUrlsByBlob ?? new Map<string, string>();
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

  function tableQuery(table: string) {
    if (table === "userRoles") {
      return {
        withIndex: () => ({
          collect: async () => userRoles,
        }),
      };
    }
    if (table === "installments") {
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        withIndex: (_index: string, fn: any) => {
          // Capture the contractId from the `q.eq("contractId", id)` call.
          let captured: string | undefined;
          fn({
            eq: (_field: string, value: string) => {
              captured = value;
              return {};
            },
          });
          return {
            collect: async () =>
              captured === undefined ? [] : installments.get(captured) ?? [],
          };
        },
      };
    }
    return {
      withIndex: () => ({
        collect: async () => [],
        first: async () => null,
        unique: async () => null,
      }),
      collect: async () => [],
    };
  }

  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === USER_ID) return user;
        if (id === SESSION_ID) return session;
        if (contracts.has(id)) return contracts.get(id);
        return null;
      }),
      query: vi.fn((table: string) => tableQuery(table)),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
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
        }
      }),
    },
    scheduler: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runAfter: vi.fn(async (delayMs: number, ref: any, args: any) => {
        let functionPath: string;
        try {
          functionPath = getFunctionName(ref);
        } catch {
          functionPath = typeof ref === "string" ? ref : "(unknown)";
        }
        scheduledRuns.push({ delayMs, functionPath, args });
        return "scheduledFunctions:1";
      }),
    },
    storage: {
      getUrl: vi.fn(async (blobId: string) => {
        return storageUrlsByBlob.get(blobId) ?? null;
      }),
    },
  };

  return {
    contracts,
    installments,
    auditInserts,
    scheduledRuns,
    storageUrlsByBlob,
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
    contractNumber: "CON-20260601-D-5-12-0000",
    lotId: "lots:1",
    customerId: "customers:1",
    kind: "installment",
    totalPriceCents: 150_000_00,
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
    contractId: "contracts:1",
    installmentNumber: 1,
    dueDate: T0 - 31 * DAY_MS, // 31 days overdue by default
    principalCents: 10_000_00,
    paidCents: 0,
    status: "overdue",
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

describe("generateDemandLetterRequest", () => {
  const run = handlerOf(generateDemandLetterRequest);

  it("schedules the demand-letter action and emits an audit row (office_staff)", async () => {
    const contract = makeContract();
    const overdue = makeInstallment({
      _id: "installments:1",
      contractId: contract._id,
      dueDate: T0 - 31 * DAY_MS,
      principalCents: 10_000_00,
      paidCents: 0,
      status: "overdue",
    });
    const bag = makeCtx({
      roles: ["office_staff"],
      initialContracts: [contract],
      initialInstallments: [overdue],
    });

    const result = (await run(bag.ctx, { contractId: contract._id })) as {
      contractId: string;
      status: "scheduled";
    };

    expect(result.status).toBe("scheduled");
    expect(result.contractId).toBe(contract._id);

    expect(bag.scheduledRuns).toHaveLength(1);
    const scheduled = bag.scheduledRuns[0]!;
    expect(scheduled.delayMs).toBe(0);
    expect(scheduled.functionPath).toBe(
      "actions/generateDemandLetterPdf:run",
    );
    expect(scheduled.args).toEqual({ contractId: contract._id });

    expect(bag.auditInserts).toHaveLength(1);
    const auditRow = bag.auditInserts[0]!.row;
    expect(auditRow.action).toBe("update");
    expect(auditRow.entityType).toBe("contract");
    expect(auditRow.entityId).toBe(contract._id);
    expect(auditRow.reason).toBe(
      "Contract demand letter generation requested.",
    );
    const after = auditRow.after as { overdueCount?: number };
    expect(after.overdueCount).toBe(1);
  });

  it("permits admin callers", async () => {
    const contract = makeContract();
    const overdue = makeInstallment({ contractId: contract._id });
    const bag = makeCtx({
      roles: ["admin"],
      initialContracts: [contract],
      initialInstallments: [overdue],
    });
    const result = (await run(bag.ctx, { contractId: contract._id })) as {
      status: "scheduled";
    };
    expect(result.status).toBe("scheduled");
    expect(bag.scheduledRuns).toHaveLength(1);
  });

  it("rejects field_worker callers with FORBIDDEN", async () => {
    const contract = makeContract();
    const overdue = makeInstallment({ contractId: contract._id });
    const bag = makeCtx({
      roles: ["field_worker"],
      initialContracts: [contract],
      initialInstallments: [overdue],
    });
    const thrown = await run(bag.ctx, { contractId: contract._id }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
    expect(bag.scheduledRuns).toHaveLength(0);
    expect(bag.auditInserts).toHaveLength(0);
  });

  it("rejects unauthenticated callers", async () => {
    const contract = makeContract();
    const overdue = makeInstallment({ contractId: contract._id });
    const bag = makeCtx({
      authenticated: false,
      initialContracts: [contract],
      initialInstallments: [overdue],
    });
    const thrown = await run(bag.ctx, { contractId: contract._id }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
    expect(bag.scheduledRuns).toHaveLength(0);
  });

  it("throws NOT_FOUND when the contract does not exist", async () => {
    const bag = makeCtx({
      roles: ["office_staff"],
      initialContracts: [],
    });
    const thrown = await run(bag.ctx, {
      contractId: "contracts:ghost",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
    expect(bag.scheduledRuns).toHaveLength(0);
  });

  it("throws VALIDATION when the contract has no overdue installments (all current)", async () => {
    const contract = makeContract();
    const future = makeInstallment({
      _id: "installments:future",
      contractId: contract._id,
      dueDate: T0 + 5 * DAY_MS, // due in the future — not overdue
      status: "pending",
    });
    const bag = makeCtx({
      roles: ["office_staff"],
      initialContracts: [contract],
      initialInstallments: [future],
    });
    const thrown = await run(bag.ctx, { contractId: contract._id }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    expect(bag.scheduledRuns).toHaveLength(0);
    expect(bag.auditInserts).toHaveLength(0);
  });

  it("throws VALIDATION when the contract has no installments at all", async () => {
    const contract = makeContract();
    const bag = makeCtx({
      roles: ["office_staff"],
      initialContracts: [contract],
      initialInstallments: [],
    });
    const thrown = await run(bag.ctx, { contractId: contract._id }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    expect(bag.scheduledRuns).toHaveLength(0);
  });

  it("ignores paid installments when computing overdue count", async () => {
    const contract = makeContract();
    // Past-due but PAID — should not count.
    const paidPast = makeInstallment({
      _id: "installments:paid",
      contractId: contract._id,
      dueDate: T0 - 60 * DAY_MS,
      principalCents: 10_000_00,
      paidCents: 10_000_00,
      status: "paid",
    });
    const bag = makeCtx({
      roles: ["office_staff"],
      initialContracts: [contract],
      initialInstallments: [paidPast],
    });
    const thrown = await run(bag.ctx, { contractId: contract._id }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    expect(bag.scheduledRuns).toHaveLength(0);
  });

  it("ignores waived installments when computing overdue count", async () => {
    const contract = makeContract();
    const waivedPast = makeInstallment({
      _id: "installments:waived",
      contractId: contract._id,
      dueDate: T0 - 60 * DAY_MS,
      principalCents: 10_000_00,
      paidCents: 0,
      status: "waived",
    });
    const bag = makeCtx({
      roles: ["office_staff"],
      initialContracts: [contract],
      initialInstallments: [waivedPast],
    });
    const thrown = await run(bag.ctx, { contractId: contract._id }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("counts overdue installment even when status is 'pending' (cron lag tolerance)", async () => {
    // The daily AR-aging cron flips `pending → overdue` once a day. If
    // an installment's dueDate is in the past but the cron hasn't yet
    // flipped its status, the mutation should still treat it as overdue
    // so the operator isn't blocked by a stale snapshot.
    const contract = makeContract();
    const stalePending = makeInstallment({
      _id: "installments:stale",
      contractId: contract._id,
      dueDate: T0 - 31 * DAY_MS,
      principalCents: 10_000_00,
      paidCents: 0,
      status: "pending", // cron hasn't run yet
    });
    const bag = makeCtx({
      roles: ["office_staff"],
      initialContracts: [contract],
      initialInstallments: [stalePending],
    });
    const result = (await run(bag.ctx, { contractId: contract._id })) as {
      status: "scheduled";
    };
    expect(result.status).toBe("scheduled");
    expect(bag.scheduledRuns).toHaveLength(1);
  });

  it("allows regeneration even when a prior demand letter exists", async () => {
    const contract = makeContract({
      demandLetterStorageId: "kg-existing-letter",
      demandLetterGeneratedAt: T0 - 60_000,
    });
    const overdue = makeInstallment({ contractId: contract._id });
    const bag = makeCtx({
      roles: ["office_staff"],
      initialContracts: [contract],
      initialInstallments: [overdue],
    });
    const result = (await run(bag.ctx, { contractId: contract._id })) as {
      status: "scheduled";
    };
    expect(result.status).toBe("scheduled");
    expect(bag.scheduledRuns).toHaveLength(1);
    const auditRow = bag.auditInserts[0]!.row as {
      before?: { demandLetterStorageId?: unknown };
    };
    expect(auditRow.before?.demandLetterStorageId).toBe(
      "kg-existing-letter",
    );
  });

  it("aggregates overdue amount across multiple overdue installments", async () => {
    const contract = makeContract();
    const overdueA = makeInstallment({
      _id: "installments:a",
      contractId: contract._id,
      installmentNumber: 1,
      dueDate: T0 - 60 * DAY_MS,
      principalCents: 10_000_00,
      paidCents: 0,
      status: "overdue",
    });
    const overdueB = makeInstallment({
      _id: "installments:b",
      contractId: contract._id,
      installmentNumber: 2,
      dueDate: T0 - 31 * DAY_MS,
      principalCents: 10_000_00,
      paidCents: 2_500_00, // partial payment applied
      status: "overdue",
    });
    const bag = makeCtx({
      roles: ["office_staff"],
      initialContracts: [contract],
      initialInstallments: [overdueA, overdueB],
    });
    const result = (await run(bag.ctx, { contractId: contract._id })) as {
      status: "scheduled";
    };
    expect(result.status).toBe("scheduled");
    const auditRow = bag.auditInserts[0]!.row as {
      after?: { overdueCount?: number; totalOverdueCents?: number };
    };
    expect(auditRow.after?.overdueCount).toBe(2);
    // overdueA principal (10000_00) + overdueB remaining (10000_00 - 2500_00 = 7500_00) = 17500_00
    expect(auditRow.after?.totalOverdueCents).toBe(17_500_00);
  });
});

describe("getDemandLetterUrl", () => {
  const run = handlerOf(getDemandLetterUrl);

  it("returns null url + null generatedAt when the contract has no demand letter", async () => {
    const contract = makeContract();
    const bag = makeCtx({
      roles: ["office_staff"],
      initialContracts: [contract],
    });

    const result = (await run(bag.ctx, { contractId: contract._id })) as {
      url: string | null;
      generatedAt: number | null;
    };
    expect(result.url).toBeNull();
    expect(result.generatedAt).toBeNull();
  });

  it("returns a signed URL + generatedAt when the demand letter exists", async () => {
    const contract = makeContract({
      demandLetterStorageId: "kg-signed-letter",
      demandLetterGeneratedAt: T0 - 30_000,
    });
    const bag = makeCtx({
      roles: ["office_staff"],
      initialContracts: [contract],
      storageUrlsByBlob: new Map([
        ["kg-signed-letter", "https://example.test/blob/kg-signed-letter"],
      ]),
    });
    const result = (await run(bag.ctx, { contractId: contract._id })) as {
      url: string | null;
      generatedAt: number | null;
    };
    expect(result.url).toBe(
      "https://example.test/blob/kg-signed-letter",
    );
    expect(result.generatedAt).toBe(T0 - 30_000);
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const contract = makeContract();
    const bag = makeCtx({
      roles: ["field_worker"],
      initialContracts: [contract],
    });
    const thrown = await run(bag.ctx, { contractId: contract._id }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("throws NOT_FOUND when the contract does not exist", async () => {
    const bag = makeCtx({
      roles: ["office_staff"],
      initialContracts: [],
    });
    const thrown = await run(bag.ctx, {
      contractId: "contracts:ghost",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });
});

describe("getContractOverdueSummary", () => {
  const run = handlerOf(getContractOverdueSummary);

  it("returns isOverdue: true with counts when overdue installments exist", async () => {
    const contract = makeContract();
    const overdueA = makeInstallment({
      _id: "installments:a",
      contractId: contract._id,
      installmentNumber: 1,
      dueDate: T0 - 60 * DAY_MS,
      principalCents: 10_000_00,
      paidCents: 0,
      status: "overdue",
    });
    const overdueB = makeInstallment({
      _id: "installments:b",
      contractId: contract._id,
      installmentNumber: 2,
      dueDate: T0 - 31 * DAY_MS,
      principalCents: 10_000_00,
      paidCents: 0,
      status: "overdue",
    });
    const bag = makeCtx({
      roles: ["office_staff"],
      initialContracts: [contract],
      initialInstallments: [overdueA, overdueB],
    });

    const result = (await run(bag.ctx, { contractId: contract._id })) as {
      isOverdue: boolean;
      overdueCount: number;
      totalOverdueCents: number;
    };
    expect(result.isOverdue).toBe(true);
    expect(result.overdueCount).toBe(2);
    expect(result.totalOverdueCents).toBe(20_000_00);
  });

  it("returns isOverdue: false when all installments are current or paid", async () => {
    const contract = makeContract();
    const futurePending = makeInstallment({
      _id: "installments:future",
      contractId: contract._id,
      dueDate: T0 + 5 * DAY_MS,
      status: "pending",
    });
    const paidPast = makeInstallment({
      _id: "installments:paidpast",
      contractId: contract._id,
      dueDate: T0 - 60 * DAY_MS,
      principalCents: 10_000_00,
      paidCents: 10_000_00,
      status: "paid",
    });
    const bag = makeCtx({
      roles: ["office_staff"],
      initialContracts: [contract],
      initialInstallments: [futurePending, paidPast],
    });

    const result = (await run(bag.ctx, { contractId: contract._id })) as {
      isOverdue: boolean;
      overdueCount: number;
      totalOverdueCents: number;
    };
    expect(result.isOverdue).toBe(false);
    expect(result.overdueCount).toBe(0);
    expect(result.totalOverdueCents).toBe(0);
  });

  it("rejects field_worker callers with FORBIDDEN", async () => {
    const contract = makeContract();
    const bag = makeCtx({
      roles: ["field_worker"],
      initialContracts: [contract],
    });
    const thrown = await run(bag.ctx, { contractId: contract._id }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("throws NOT_FOUND when the contract does not exist", async () => {
    const bag = makeCtx({
      roles: ["office_staff"],
      initialContracts: [],
    });
    const thrown = await run(bag.ctx, {
      contractId: "contracts:ghost",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });
});

describe("demand-letter PDF action — render smoke test", () => {
  it("produces a non-empty PDF buffer with a valid PDF header", async () => {
    const mod = await import(
      "../../../convex/actions/generateDemandLetterPdf"
    );
    const PDFKitDocument = (await import("pdfkit")).default;

    const doc = new PDFKitDocument({ size: "LETTER", margin: 72 });
    const chunks: Buffer[] = [];
    const closed = new Promise<void>((resolve) => {
      doc.on("end", () => resolve());
    });
    doc.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    mod.__testing.renderDemandLetterPdf(doc, {
      contractNumber: "CON-20260601-D-5-12-0000",
      contractCreatedAt: T0 - 180 * DAY_MS,
      contractCreationTime: T0 - 180 * DAY_MS,
      customerFullName: "Juan Dela Cruz",
      customerGovIdLast4: "1234",
      customerGovIdType: "tin",
      customerAddressLines: ["123 Main St", "Manila", "1000"],
      lotCode: "D-5-12",
      lotSection: "D",
      lotBlock: "5",
      lotRow: "12",
      overdueInstallments: [
        {
          installmentNumber: 1,
          dueDate: T0 - 60 * DAY_MS,
          principalCents: 10_000_00,
          paidCents: 0,
        },
        {
          installmentNumber: 2,
          dueDate: T0 - 31 * DAY_MS,
          principalCents: 10_000_00,
          paidCents: 2_500_00,
        },
      ],
      totalOverdueCents: 17_500_00,
      oldestMissedDate: T0 - 60 * DAY_MS,
      generatedAt: T0,
    });
    doc.end();
    await closed;

    const buffer = Buffer.concat(chunks);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("exposes the canonical function path constants", async () => {
    const mod = await import(
      "../../../convex/actions/generateDemandLetterPdf"
    );
    expect(
      mod.__testing.GENERATE_DEMAND_LETTER_PDF_FUNCTION_PATH,
    ).toBe("actions/generateDemandLetterPdf:run");
    expect(
      mod.__testing.GET_CONTRACT_FOR_DEMAND_LETTER_RENDER_FUNCTION_PATH,
    ).toBe(
      "generateDemandLetterPdfInternal:_getContractForDemandLetterRender",
    );
    expect(
      mod.__testing.RECORD_DEMAND_LETTER_PDF_READY_FUNCTION_PATH,
    ).toBe("generateDemandLetterPdfInternal:_recordDemandLetterPdfReady");
  });

  it("uses a 30-day payment window per the story spec", async () => {
    const mod = await import(
      "../../../convex/actions/generateDemandLetterPdf"
    );
    expect(mod.__testing.DEMAND_PAYMENT_WINDOW_DAYS).toBe(30);
  });
});
