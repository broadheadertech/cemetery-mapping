/**
 * Story 6.1 — Contract PDF generation tests (FR49).
 *
 * Scope:
 *   - `generateContractPdfRequest` mutation: auth gating, NOT_FOUND
 *     handling, audit emission, scheduler scheduling.
 *   - `getContractPdfUrl` query: auth gating, NOT_FOUND handling, the
 *     null-URL branch (contract has no PDF), the signed-URL branch
 *     (contract has a PDF).
 *   - Path-string parity: the action's exported function-path
 *     constants must match the path the mutation builds via
 *     `makeFunctionReference`. This is the load-bearing wiring that a
 *     refactor can silently break.
 *   - The pure `renderContractPdf` helper: smoke-renders a stub
 *     payload into a PDFKit document and asserts the produced buffer
 *     is non-empty + has a PDF header. No pixel diff (the architecture
 *     defers visual-fidelity testing to a Phase 2 BIR-confirmation
 *     follow-up).
 *
 * Strategy: hand-mocked ctx mirroring `contracts.test.ts` (the existing
 * Story 3.3 / 3.4 / 3.6 test pattern). `convex-test` requires
 * `convex/_generated/` which this repo deliberately avoids — see the
 * top-of-file rationale in `convex/gpsImport.ts`.
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
import { getFunctionName } from "convex/server";
import {
  generateContractPdfRequest,
  getContractPdfUrl,
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
  pdfStorageId?: string;
  pdfGeneratedAt?: number;
}

interface CtxBag {
  contracts: Map<string, ContractFixture>;
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
  authenticated?: boolean;
  storageUrlsByBlob?: Map<string, string>;
}): CtxBag {
  const contracts = new Map<string, ContractFixture>(
    (opts.initialContracts ?? []).map((c) => [c._id, c]),
  );
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
        // `makeFunctionReference(path)` returns an object branded with
        // the `functionName` symbol; `getFunctionName` unwraps it back
        // to the original path string. This recovers the scheduled
        // action's identity for assertion.
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

describe("generateContractPdfRequest", () => {
  const run = handlerOf(generateContractPdfRequest);

  it("schedules the PDF action and emits an audit row (office_staff)", async () => {
    const contract = makeContract();
    const bag = makeCtx({
      roles: ["office_staff"],
      initialContracts: [contract],
    });

    const result = (await run(bag.ctx, { contractId: contract._id })) as {
      contractId: string;
      status: "scheduled";
    };

    expect(result.status).toBe("scheduled");
    expect(result.contractId).toBe(contract._id);

    // Scheduler was called exactly once, with delay 0 and the action's
    // canonical function path.
    expect(bag.scheduledRuns).toHaveLength(1);
    const scheduled = bag.scheduledRuns[0]!;
    expect(scheduled.delayMs).toBe(0);
    expect(scheduled.functionPath).toBe("actions/generateContractPdf:run");
    expect(scheduled.args).toEqual({ contractId: contract._id });

    // Audit row recorded the regeneration request.
    expect(bag.auditInserts).toHaveLength(1);
    const auditRow = bag.auditInserts[0]!.row;
    expect(auditRow.action).toBe("update");
    expect(auditRow.entityType).toBe("contract");
    expect(auditRow.entityId).toBe(contract._id);
    expect(auditRow.reason).toBe("Contract PDF generation requested.");
  });

  it("permits admin callers", async () => {
    const contract = makeContract();
    const bag = makeCtx({
      roles: ["admin"],
      initialContracts: [contract],
    });
    const result = (await run(bag.ctx, { contractId: contract._id })) as {
      status: "scheduled";
    };
    expect(result.status).toBe("scheduled");
    expect(bag.scheduledRuns).toHaveLength(1);
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
    expect(bag.scheduledRuns).toHaveLength(0);
    expect(bag.auditInserts).toHaveLength(0);
  });

  it("rejects customer-role callers with FORBIDDEN", async () => {
    const contract = makeContract();
    const bag = makeCtx({
      roles: ["customer"],
      initialContracts: [contract],
    });
    const thrown = await run(bag.ctx, { contractId: contract._id }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const contract = makeContract();
    const bag = makeCtx({
      authenticated: false,
      initialContracts: [contract],
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
    expect(bag.auditInserts).toHaveLength(0);
  });

  it("allows regeneration even when a prior PDF exists", async () => {
    const contract = makeContract({
      pdfStorageId: "kg-existing-blob",
      pdfGeneratedAt: T0 - 60_000,
    });
    const bag = makeCtx({
      roles: ["office_staff"],
      initialContracts: [contract],
    });
    const result = (await run(bag.ctx, { contractId: contract._id })) as {
      status: "scheduled";
    };
    expect(result.status).toBe("scheduled");
    expect(bag.scheduledRuns).toHaveLength(1);
    // The audit row's `before` carries the prior blob id so reviewers
    // can tell this was a regeneration, not a first-time generation.
    const auditRow = bag.auditInserts[0]!.row as {
      before?: { pdfStorageId?: unknown };
    };
    expect(auditRow.before?.pdfStorageId).toBe("kg-existing-blob");
  });
});

describe("getContractPdfUrl", () => {
  const run = handlerOf(getContractPdfUrl);

  it("returns null url + null generatedAt when the contract has no PDF", async () => {
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

  it("returns a signed URL + generatedAt when the PDF exists", async () => {
    const contract = makeContract({
      pdfStorageId: "kg-signed-blob",
      pdfGeneratedAt: T0 - 30_000,
    });
    const bag = makeCtx({
      roles: ["office_staff"],
      initialContracts: [contract],
      storageUrlsByBlob: new Map([
        ["kg-signed-blob", "https://example.test/blob/kg-signed-blob"],
      ]),
    });
    const result = (await run(bag.ctx, { contractId: contract._id })) as {
      url: string | null;
      generatedAt: number | null;
    };
    expect(result.url).toBe("https://example.test/blob/kg-signed-blob");
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

describe("contract PDF action — render smoke test", () => {
  it("produces a non-empty PDF buffer with a valid PDF header", async () => {
    // We import the action module's testing surface lazily inside the
    // test so vitest's module graph doesn't try to load PDFKit at
    // suite-collection time on environments where the optional Node
    // deps aren't yet resolvable. The `"use node"` directive on the
    // file is a no-op outside the Convex runtime.
    const mod = await import(
      "../../../convex/actions/generateContractPdf"
    );
    const PDFKitDocument = (await import("pdfkit")).default;

    const doc = new PDFKitDocument({ size: "LETTER", margin: 50 });
    const chunks: Buffer[] = [];
    const closed = new Promise<void>((resolve) => {
      doc.on("end", () => resolve());
    });
    doc.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    mod.__testing.renderContractPdf(doc, {
      contractNumber: "CON-20260601-D-5-12-0000",
      contractKind: "installment",
      totalPriceCents: 150_000_00,
      state: "active",
      createdAt: T0,
      contractCreationTime: T0,
      downPaymentCents: 30_000_00,
      termMonths: 12,
      monthlyAmountCents: 10_000_00,
      firstDueDate: T0 + 30 * 24 * HOUR_MS,
      customerFullName: "Juan Dela Cruz",
      customerGovIdLast4: "1234",
      customerGovIdType: "tin",
      customerAddressLines: ["123 Main St", "Manila", "1000"],
      lotCode: "D-5-12",
      lotSection: "D",
      lotBlock: "5",
      lotRow: "12",
      lotType: "single",
      lotWidthM: 2.5,
      lotDepthM: 5,
      installments: Array.from({ length: 12 }, (_, i) => ({
        installmentNumber: i + 1,
        dueDate: T0 + (i + 1) * 30 * 24 * HOUR_MS,
        principalCents: 10_000_00,
        paidCents: 0,
        status: "pending" as const,
      })),
    });
    doc.end();
    await closed;

    const buffer = Buffer.concat(chunks);
    // PDF files start with "%PDF-" — the magic header. Asserting on
    // this is the minimum-bar fidelity check the story spec accepts
    // (pixel diffs are deferred to a Phase 2 BIR-confirmation
    // follow-up).
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("exposes the canonical function path constants", async () => {
    const mod = await import(
      "../../../convex/actions/generateContractPdf"
    );
    expect(mod.__testing.GENERATE_CONTRACT_PDF_FUNCTION_PATH).toBe(
      "actions/generateContractPdf:run",
    );
    expect(mod.__testing.GET_CONTRACT_FOR_PDF_RENDER_FUNCTION_PATH).toBe(
      "generateContractPdfInternal:_getContractForPdfRender",
    );
    expect(mod.__testing.RECORD_CONTRACT_PDF_READY_FUNCTION_PATH).toBe(
      "generateContractPdfInternal:_recordContractPdfReady",
    );
  });
});
