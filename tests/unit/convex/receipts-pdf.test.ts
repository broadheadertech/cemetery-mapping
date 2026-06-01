/**
 * Story 3.13 — receipt PDF generation + download surface tests.
 *
 * Three surfaces under test:
 *   1. `generateReceiptPdfRequest` (public mutation) — role gating,
 *      idempotent "already ready" path, scheduler hand-off.
 *   2. `storeReceiptPdfBlob` (internal mutation) — narrow patch
 *      writeback that only touches the PDF fields, never financial
 *      ones.
 *   3. `getReceiptPdfUrl` (public query) — auth-gated signed-URL
 *      lookup; returns null while the PDF is still rendering.
 *
 * Plus an integration smoke test for the renderer
 * (`renderReceiptPdf`) — feeds a fixture through PDFKit and asserts
 * the output starts with the PDF magic bytes (`%PDF`). Full visual
 * regression of the PDF is out of scope for unit tests; the
 * Playwright suite covers the end-to-end download flow in a future
 * follow-up.
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
  generateReceiptPdfRequest,
  getReceiptForPdf,
  getReceiptPdfUrl,
  storeReceiptPdfBlob,
} from "../../../convex/receipts";
import {
  renderReceiptPdf,
  type ReceiptForPdf,
} from "../../../convex/actions/generateReceiptPdf";
import { PLACEHOLDER_BIR_CONFIG } from "../../../convex/lib/birFormat";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-05-15T12:00:00+08:00").getTime();
const USER_ID = "users:abc";
const SESSION_ID = "authSessions:def";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface ReceiptRow {
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
  pdfStorageId?: string;
  pdfGeneratedAt?: number;
}

interface PaymentRow {
  _id: string;
  paymentNumber: string;
  amountCents: number;
  paymentMethod: "cash" | "check" | "bank_transfer" | "gcash" | "maya" | "card";
  reference?: string;
  receivedAt: number;
  receivedByUserId: string;
  contractId?: string;
  customerId?: string;
  isVoided: boolean;
}

interface AllocationRow {
  _id: string;
  paymentId: string;
  targetType: "contract" | "installment" | "perpetualCare" | "credit";
  targetId: string;
  amountCents: number;
  sequence: number;
  note?: string;
}

interface CustomerRow {
  _id: string;
  fullName: string;
  address: {
    line1: string;
    barangay?: string;
    cityMunicipality?: string;
    province?: string;
    postalCode?: string;
  };
}

interface ContractRow {
  _id: string;
  contractNumber: string;
  lotId: string;
}

interface LotRow {
  _id: string;
  code: string;
}

interface BirConfigRow {
  _id: string;
  registeredName: string;
  tradeName?: string;
  tin: string;
  registeredAddressLines: string[];
  atpNumber: string;
  atpExpiryDate: number;
  serialRangeStart: string;
  serialRangeEnd: string;
  vatRate?: number;
  isVatRegistered: boolean;
  isPlaceholder: boolean;
  updatedAt: number;
  updatedBy: string;
}

const sampleBirConfig: BirConfigRow = {
  _id: "birReceiptConfig:1",
  registeredName: "Cases Land Inc.",
  tradeName: "Apostle Paul Memorial Park",
  tin: "123456789000",
  registeredAddressLines: [
    "Zone 1, San Eugenio",
    "Aringay, La Union 2503",
    "Philippines",
  ],
  atpNumber: "OCN-12345678901234",
  atpExpiryDate: new Date("2030-01-01T00:00:00+08:00").getTime(),
  serialRangeStart: "0000001",
  serialRangeEnd: "9999999",
  isVatRegistered: false,
  isPlaceholder: false,
  updatedAt: 0,
  updatedBy: "users:abc",
};

function makeCtx(opts: {
  roles?: RoleName[];
  authenticated?: boolean;
  receipts?: ReceiptRow[];
  payments?: PaymentRow[];
  allocations?: AllocationRow[];
  customers?: CustomerRow[];
  contracts?: ContractRow[];
  lots?: LotRow[];
  storageUrls?: Record<string, string | null>;
  /** When set, the birReceiptConfig singleton-by-index query returns
   * this row. When `null`, the query returns null (simulating an
   * un-seeded deployment). When `undefined`, defaults to
   * `sampleBirConfig` (a production-ready row) so existing tests don't
   * have to opt in. */
  birReceiptConfig?: BirConfigRow | null;
}) {
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
    name: "Maria Office",
    email: "maria@example.com",
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

  const receipts = new Map<string, ReceiptRow>(
    (opts.receipts ?? []).map((r) => [r._id, r]),
  );
  const payments = new Map<string, PaymentRow>(
    (opts.payments ?? []).map((p) => [p._id, p]),
  );
  const allocations = opts.allocations ?? [];
  const customers = new Map<string, CustomerRow>(
    (opts.customers ?? []).map((c) => [c._id, c]),
  );
  const contracts = new Map<string, ContractRow>(
    (opts.contracts ?? []).map((c) => [c._id, c]),
  );
  const lots = new Map<string, LotRow>(
    (opts.lots ?? []).map((l) => [l._id, l]),
  );

  const storageUrls = opts.storageUrls ?? {};
  const scheduled: Array<{ delayMs: number; functionName: string; args: unknown }> =
    [];

  interface IndexQuery {
    eqs: Record<string, unknown>;
    eq(field: string, value: unknown): IndexQuery;
  }

  function makeAllocationsBuilder(eqs: Record<string, unknown>) {
    return {
      async collect() {
        return allocations.filter((a) => {
          for (const [k, v] of Object.entries(eqs)) {
            if ((a as unknown as Record<string, unknown>)[k] !== v) {
              return false;
            }
          }
          return true;
        });
      },
    };
  }

  const ctx = {
    db: {
      get: vi.fn(async (id: string) => {
        if (id === USER_ID) return user;
        if (id === SESSION_ID) return session;
        if (receipts.has(id)) return receipts.get(id);
        if (payments.has(id)) return payments.get(id);
        if (customers.has(id)) return customers.get(id);
        if (contracts.has(id)) return contracts.get(id);
        if (lots.has(id)) return lots.get(id);
        return null;
      }),
      patch: vi.fn(async (id: string, patch: Partial<ReceiptRow>) => {
        const existing = receipts.get(id);
        if (existing === undefined) {
          throw new Error(`patch: receipt ${id} not found in fixture`);
        }
        receipts.set(id, { ...existing, ...patch });
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return {
            withIndex: () => ({
              collect: async () => userRoles,
            }),
          };
        }
        if (table === "paymentAllocations") {
          return {
            withIndex: (_n: string, fn?: (q: IndexQuery) => IndexQuery) => {
              const q: IndexQuery = {
                eqs: {},
                eq(field, value) {
                  this.eqs[field] = value;
                  return this;
                },
              };
              if (fn !== undefined) fn(q);
              return makeAllocationsBuilder(q.eqs);
            },
          };
        }
        if (table === "birReceiptConfig") {
          const cfg =
            opts.birReceiptConfig === undefined
              ? sampleBirConfig
              : opts.birReceiptConfig;
          return {
            first: async () => cfg,
            collect: async () => (cfg === null ? [] : [cfg]),
            withIndex: () => ({
              first: async () => cfg,
              collect: async () => (cfg === null ? [] : [cfg]),
            }),
          };
        }
        return {
          withIndex: () => ({
            collect: async () => [],
            first: async () => null,
            take: async () => [],
          }),
        };
      }),
    },
    storage: {
      getUrl: vi.fn(async (sid: string) => {
        if (sid in storageUrls) return storageUrls[sid];
        return `https://example/signed/${sid}`;
      }),
    },
    scheduler: {
      runAfter: vi.fn(
        async (delayMs: number, fnRef: unknown, args: unknown) => {
          // The fnRef is opaque from the test's perspective (it's a
          // ConvexFunctionReference). We record its existence so the
          // test can assert "the scheduler was kicked" without
          // round-tripping the action.
          scheduled.push({
            delayMs,
            functionName: String(
              (fnRef as { name?: string } | undefined)?.name ?? "<ref>",
            ),
            args,
          });
        },
      ),
      runAt: vi.fn(),
    },
  };

  return { ctx, receipts, scheduled };
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

const sampleReceipt: ReceiptRow = {
  _id: "receipts:1",
  _creationTime: T0,
  paymentId: "payments:1",
  receiptSeries: "OR-",
  receiptNumber: "OR-0000123",
  receiptSerial: 123,
  contractId: "contracts:1",
  customerId: "customers:1",
  amountCents: 250_000,
  issuedAt: T0,
  issuedByUserId: USER_ID,
  isVoided: false,
};

const samplePayment: PaymentRow = {
  _id: "payments:1",
  paymentNumber: "OR-0000123",
  amountCents: 250_000,
  paymentMethod: "cash",
  reference: "REF-1",
  receivedAt: T0,
  receivedByUserId: USER_ID,
  contractId: "contracts:1",
  customerId: "customers:1",
  isVoided: false,
};

const sampleCustomer: CustomerRow = {
  _id: "customers:1",
  fullName: "Juan Dela Cruz",
  address: {
    line1: "123 Sample St.",
    barangay: "Brgy. Sample",
    cityMunicipality: "Quezon City",
    province: "Metro Manila",
    postalCode: "1100",
  },
};

const sampleContract: ContractRow = {
  _id: "contracts:1",
  contractNumber: "C-2026-0001",
  lotId: "lots:1",
};

const sampleLot: LotRow = {
  _id: "lots:1",
  code: "D-5-12",
};

const sampleAllocations: AllocationRow[] = [
  {
    _id: "alloc:1",
    paymentId: "payments:1",
    targetType: "contract",
    targetId: "contracts:1",
    amountCents: 250_000,
    sequence: 0,
  },
];

// =====================================================================
// generateReceiptPdfRequest — public mutation
// =====================================================================

describe("generateReceiptPdfRequest", () => {
  const run = handlerOf(generateReceiptPdfRequest);

  it("schedules the action and returns 'scheduled' for a fresh receipt", async () => {
    const { ctx, scheduled } = makeCtx({
      roles: ["office_staff"],
      receipts: [sampleReceipt],
    });
    const result = (await run(ctx, { receiptId: "receipts:1" })) as {
      status: string;
    };
    expect(result.status).toBe("scheduled");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.delayMs).toBe(0);
  });

  it("returns 'ready' without scheduling when the PDF is already stored", async () => {
    const withPdf: ReceiptRow = {
      ...sampleReceipt,
      pdfStorageId: "_storage:pdf-1",
      pdfGeneratedAt: T0 - 1000,
    };
    const { ctx, scheduled } = makeCtx({
      roles: ["office_staff"],
      receipts: [withPdf],
    });
    const result = (await run(ctx, { receiptId: "receipts:1" })) as {
      status: string;
    };
    expect(result.status).toBe("ready");
    expect(scheduled).toHaveLength(0);
  });

  it("returns 'not_found' when the receipt does not exist", async () => {
    const { ctx, scheduled } = makeCtx({ roles: ["office_staff"] });
    const result = (await run(ctx, { receiptId: "receipts:404" })) as {
      status: string;
    };
    expect(result.status).toBe("not_found");
    expect(scheduled).toHaveLength(0);
  });

  it("allows admin", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      receipts: [sampleReceipt],
    });
    const result = (await run(ctx, { receiptId: "receipts:1" })) as {
      status: string;
    };
    expect(result.status).toBe("scheduled");
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      receipts: [sampleReceipt],
    });
    const thrown = await run(ctx, { receiptId: "receipts:1" }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects customer role with FORBIDDEN", async () => {
    const { ctx } = makeCtx({
      roles: ["customer"],
      receipts: [sampleReceipt],
    });
    const thrown = await run(ctx, { receiptId: "receipts:1" }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, { receiptId: "receipts:1" }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});

// =====================================================================
// storeReceiptPdfBlob — internal mutation
// =====================================================================

describe("storeReceiptPdfBlob", () => {
  const run = handlerOf(storeReceiptPdfBlob);

  it("patches pdfStorageId + pdfGeneratedAt on the receipt", async () => {
    const { ctx, receipts } = makeCtx({
      roles: ["office_staff"],
      receipts: [sampleReceipt],
    });
    const generatedAt = T0 + 5000;
    await run(ctx, {
      receiptId: "receipts:1",
      storageId: "_storage:new-pdf",
      generatedAt,
    });
    const patched = receipts.get("receipts:1")!;
    expect(patched.pdfStorageId).toBe("_storage:new-pdf");
    expect(patched.pdfGeneratedAt).toBe(generatedAt);
  });

  it("does NOT touch financial fields", async () => {
    const { ctx, receipts } = makeCtx({
      roles: ["office_staff"],
      receipts: [sampleReceipt],
    });
    await run(ctx, {
      receiptId: "receipts:1",
      storageId: "_storage:new-pdf",
      generatedAt: T0 + 1,
    });
    const patched = receipts.get("receipts:1")!;
    expect(patched.amountCents).toBe(sampleReceipt.amountCents);
    expect(patched.receiptSerial).toBe(sampleReceipt.receiptSerial);
    expect(patched.receiptNumber).toBe(sampleReceipt.receiptNumber);
    expect(patched.isVoided).toBe(sampleReceipt.isVoided);
    expect(patched.paymentId).toBe(sampleReceipt.paymentId);
  });

  it("no-ops gracefully when the receipt was deleted before writeback", async () => {
    const { ctx, receipts } = makeCtx({ roles: ["office_staff"] });
    await expect(
      run(ctx, {
        receiptId: "receipts:gone",
        storageId: "_storage:orphan",
        generatedAt: T0,
      }),
    ).resolves.toBeNull();
    expect(receipts.size).toBe(0);
  });
});

// =====================================================================
// getReceiptPdfUrl — public query
// =====================================================================

describe("getReceiptPdfUrl", () => {
  const run = handlerOf(getReceiptPdfUrl);

  it("returns the signed URL when the PDF is ready", async () => {
    const withPdf: ReceiptRow = {
      ...sampleReceipt,
      pdfStorageId: "_storage:pdf-ready",
      pdfGeneratedAt: T0 - 5000,
    };
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      receipts: [withPdf],
      storageUrls: { "_storage:pdf-ready": "https://signed/pdf-ready" },
    });
    const result = (await run(ctx, { receiptId: "receipts:1" })) as {
      url: string | null;
      generatedAt: number | null;
    };
    expect(result.url).toBe("https://signed/pdf-ready");
    expect(result.generatedAt).toBe(T0 - 5000);
  });

  it("returns null URL when the PDF has not been generated yet", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      receipts: [sampleReceipt],
    });
    const result = (await run(ctx, { receiptId: "receipts:1" })) as {
      url: string | null;
      generatedAt: number | null;
    };
    expect(result.url).toBeNull();
    expect(result.generatedAt).toBeNull();
  });

  it("returns null URL when the receipt does not exist", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const result = (await run(ctx, { receiptId: "receipts:404" })) as {
      url: string | null;
    };
    expect(result.url).toBeNull();
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      receipts: [sampleReceipt],
    });
    const thrown = await run(ctx, { receiptId: "receipts:1" }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, { receiptId: "receipts:1" }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});

// =====================================================================
// getReceiptForPdf — internal query (hydrates the action's view-model)
// =====================================================================

describe("getReceiptForPdf", () => {
  const run = handlerOf(getReceiptForPdf);

  it("returns the hydrated view-model for the action", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      receipts: [sampleReceipt],
      payments: [samplePayment],
      customers: [sampleCustomer],
      contracts: [sampleContract],
      lots: [sampleLot],
      allocations: sampleAllocations,
    });
    const result = (await run(ctx, {
      receiptId: "receipts:1",
    })) as ReceiptForPdf;
    expect(result.receiptNumber).toBe("OR-0000123");
    expect(result.amountCents).toBe(250_000);
    expect(result.customer.fullName).toBe("Juan Dela Cruz");
    expect(result.contract.contractNumber).toBe("C-2026-0001");
    expect(result.contract.lotCode).toBe("D-5-12");
    expect(result.allocations).toHaveLength(1);
    // The format-version surfaces "v1" when reading from a real
    // production-ready row (formerly "v1-placeholder" while the
    // hard-coded placeholder constant was the source of truth).
    expect(result.template.formatVersion).toBe("v1");
    // The canonical birConfig surfaces on the payload.
    expect(result.birConfig.registeredName).toBe(sampleBirConfig.registeredName);
    expect(result.birConfig.isPlaceholder).toBe(false);
    expect(result.templateIsPlaceholder).toBe(false);
    // PLACEHOLDER_BIR_CONFIG should be marked deprecated but still
    // importable for back-compat.
    expect(PLACEHOLDER_BIR_CONFIG.registeredName).toContain("PLACEHOLDER");
  });

  it("throws INVARIANT_VIOLATION with kind:bir_not_configured when the row is missing", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      receipts: [sampleReceipt],
      payments: [samplePayment],
      customers: [sampleCustomer],
      contracts: [sampleContract],
      lots: [sampleLot],
      allocations: sampleAllocations,
      birReceiptConfig: null,
    });
    const thrown = await run(ctx, { receiptId: "receipts:1" }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
    const details = (thrown as ConvexError<Value>).data as unknown as {
      details?: { kind?: string };
    };
    expect(details.details?.kind).toBe("bir_not_configured");
  });

  it("throws INVARIANT_VIOLATION when the row is in placeholder mode", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      receipts: [sampleReceipt],
      payments: [samplePayment],
      customers: [sampleCustomer],
      contracts: [sampleContract],
      lots: [sampleLot],
      allocations: sampleAllocations,
      birReceiptConfig: { ...sampleBirConfig, isPlaceholder: true },
    });
    const thrown = await run(ctx, { receiptId: "receipts:1" }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("returns null for a missing receipt", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const result = await run(ctx, { receiptId: "receipts:404" });
    expect(result).toBeNull();
  });

  it("populates voided fields when isVoided", async () => {
    const voided: ReceiptRow = {
      ...sampleReceipt,
      isVoided: true,
      voidedAt: T0 + 1000,
      voidReason: "Duplicate entry",
      voidedByUserId: USER_ID,
    };
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      receipts: [voided],
      payments: [samplePayment],
      customers: [sampleCustomer],
      contracts: [sampleContract],
      lots: [sampleLot],
      allocations: sampleAllocations,
    });
    const result = (await run(ctx, {
      receiptId: "receipts:1",
    })) as ReceiptForPdf;
    expect(result.isVoided).toBe(true);
    expect(result.voidReason).toBe("Duplicate entry");
    expect(result.voidedByName).toBe("Maria Office");
  });
});

// =====================================================================
// renderReceiptPdf — renderer smoke test
// =====================================================================

describe("renderReceiptPdf", () => {
  function makeFixture(overrides: Partial<ReceiptForPdf> = {}): ReceiptForPdf {
    return {
      receiptId: "receipts:1",
      receiptCreationTime: T0,
      receiptSeries: "OR-",
      receiptNumber: "OR-0000123",
      receiptSerial: 123,
      issuedAt: T0,
      amountCents: 250_000,
      isVoided: false,
      voidedAt: null,
      voidReason: null,
      voidedByName: null,
      customer: {
        fullName: "Juan Dela Cruz",
        addressLine1: "123 Sample St.",
        addressBarangay: "Brgy. Sample",
        addressCityMunicipality: "Quezon City",
        addressProvince: "Metro Manila",
        addressPostalCode: "1100",
      },
      payment: {
        paymentMethod: "cash",
        reference: "REF-1",
        receivedAt: T0,
        receivedByName: "Maria Office",
      },
      contract: {
        contractNumber: "C-2026-0001",
        lotCode: "D-5-12",
      },
      allocations: [
        {
          targetType: "contract",
          amountCents: 250_000,
          sequence: 0,
          note: null,
        },
      ],
      template: PLACEHOLDER_BIR_CONFIG,
      birConfig: {
        registeredName: sampleBirConfig.registeredName,
        tradeName: sampleBirConfig.tradeName,
        tin: sampleBirConfig.tin,
        registeredAddressLines: sampleBirConfig.registeredAddressLines,
        atpNumber: sampleBirConfig.atpNumber,
        atpExpiryDate: sampleBirConfig.atpExpiryDate,
        serialRangeStart: sampleBirConfig.serialRangeStart,
        serialRangeEnd: sampleBirConfig.serialRangeEnd,
        vatRate: sampleBirConfig.vatRate,
        isVatRegistered: sampleBirConfig.isVatRegistered,
        isPlaceholder: sampleBirConfig.isPlaceholder,
        updatedAt: sampleBirConfig.updatedAt,
      },
      templateIsPlaceholder: false,
      ...overrides,
    };
  }

  it("renders a PDF buffer starting with the %PDF magic bytes", async () => {
    // Renderer uses real wall-clock + PDFKit internals (date metadata);
    // disable fake timers locally to avoid PDFKit's `new Date()` calls
    // tripping over `vi.useFakeTimers`'s frozen system time when the
    // library reads the OS time directly.
    vi.useRealTimers();
    const buf = await renderReceiptPdf(makeFixture());
    expect(buf.length).toBeGreaterThan(500); // a real PDF is many KB
    const header = buf.subarray(0, 4).toString("ascii");
    expect(header).toBe("%PDF");
  });

  it("renders a voided receipt without throwing", async () => {
    vi.useRealTimers();
    const buf = await renderReceiptPdf(
      makeFixture({
        isVoided: true,
        voidedAt: T0 + 5000,
        voidReason: "Duplicate entry",
        voidedByName: "Mr. Reyes",
      }),
    );
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 4).toString("ascii")).toBe("%PDF");
  });

  it("renders with the VAT block when template is VAT-registered", async () => {
    vi.useRealTimers();
    const buf = await renderReceiptPdf(
      makeFixture({
        template: { ...PLACEHOLDER_BIR_CONFIG, isVatRegistered: true },
      }),
    );
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 4).toString("ascii")).toBe("%PDF");
  });
});
