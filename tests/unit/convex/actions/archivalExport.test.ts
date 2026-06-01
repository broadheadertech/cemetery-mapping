/**
 * Story 5.7 — monthly archival export tests (FR62 / NFR-R3 / NFR-C2).
 *
 * Scope:
 *   - Pure helpers: period parsing, period bounds (Manila tz boundary),
 *     prior-period rollover (year-end edge), payload building,
 *     serialization (gzip + sha256), customer + contract id collection.
 *   - PII redaction: `govIdNumber` is reduced to last-4 in the export
 *     payload — full ID never crosses the action boundary.
 *   - S3 upload helper: skipped path (env unset), happy path (mocked
 *     SDK returns ETag), failure path (mocked SDK throws — error
 *     captured without propagation).
 *   - Action handler shape: idempotent skip on existing `ready` row,
 *     overwrite path on `failed` row, full export flow with mocked
 *     storage + scheduler.
 *
 * Strategy: hand-mocked ctx mirroring
 * `tests/unit/convex/followUpActions-reflagExpired.test.ts`. The repo
 * deliberately ships no `convex/_generated/` (Convex codegen is a deploy-
 * time artifact); we reproduce just enough of the action ctx surface
 * (`ctx.runQuery`, `ctx.runMutation`, `ctx.storage.store`) to drive the
 * handler end-to-end.
 *
 * Coverage targets (NFR-M2: ≥ 90% line coverage on financial-touching
 * server functions): the action plus the period + queries helpers are
 * the financial-data-touching reachable surface; the S3 helper is
 * covered via mocked SDK.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { getFunctionName } from "convex/server";

import {
  formatPeriod,
  getPeriodBounds,
  getPriorPeriod,
  parsePeriod,
} from "../../../../convex/lib/archivalPeriods";
import { redactGovIdLast4 } from "../../../../convex/lib/archivalQueries";
import {
  __testing,
  monthlyArchivalExport,
} from "../../../../convex/actions/archivalExport";

const {
  ARCHIVAL_SCHEMA_VERSION,
  buildArchivalPayload,
  serializePayload,
  collectCustomerIds,
  collectContractIds,
  uploadToS3,
} = __testing;

// ---------------------------------------------------------------------------
// Period helpers — Manila-tz boundary discipline
// ---------------------------------------------------------------------------

describe("formatPeriod", () => {
  it("formats year + month as YYYY-MM", () => {
    expect(formatPeriod(2026, 5)).toBe("2026-05");
    expect(formatPeriod(2026, 12)).toBe("2026-12");
    expect(formatPeriod(2026, 1)).toBe("2026-01");
  });

  it("rejects invalid year / month", () => {
    expect(() => formatPeriod(1969, 5)).toThrow();
    expect(() => formatPeriod(2026, 0)).toThrow();
    expect(() => formatPeriod(2026, 13)).toThrow();
    expect(() => formatPeriod(2026, 1.5)).toThrow();
  });
});

describe("parsePeriod", () => {
  it("parses a valid YYYY-MM string", () => {
    expect(parsePeriod("2026-05")).toEqual({ year: 2026, month: 5 });
    expect(parsePeriod("2026-12")).toEqual({ year: 2026, month: 12 });
  });

  it("rejects malformed strings", () => {
    expect(() => parsePeriod("2026")).toThrow();
    expect(() => parsePeriod("2026-5")).toThrow();
    expect(() => parsePeriod("26-05")).toThrow();
    expect(() => parsePeriod("2026-13")).toThrow();
    expect(() => parsePeriod("")).toThrow();
  });
});

describe("getPeriodBounds (Manila tz)", () => {
  it("anchors the start of 2026-05 to 2026-04-30 16:00 UTC (= 2026-05-01 00:00 Manila)", () => {
    const bounds = getPeriodBounds("2026-05");
    expect(bounds.period).toBe("2026-05");
    // 2026-04-30T16:00:00Z = 2026-05-01T00:00:00+08:00
    expect(bounds.startMs).toBe(Date.UTC(2026, 3, 30, 16, 0, 0));
    // 2026-05-31T16:00:00Z = 2026-06-01T00:00:00+08:00
    expect(bounds.endMs).toBe(Date.UTC(2026, 4, 31, 16, 0, 0));
  });

  it("handles December-to-January rollover (next-year endMs)", () => {
    const bounds = getPeriodBounds("2026-12");
    // 2026-11-30T16:00:00Z = 2026-12-01T00:00:00+08:00
    expect(bounds.startMs).toBe(Date.UTC(2026, 10, 30, 16, 0, 0));
    // 2026-12-31T16:00:00Z = 2027-01-01T00:00:00+08:00
    expect(bounds.endMs).toBe(Date.UTC(2026, 11, 31, 16, 0, 0));
  });

  it("[end is exclusive] a receipt at endMs falls in the NEXT period", () => {
    const mayBounds = getPeriodBounds("2026-05");
    const juneBounds = getPeriodBounds("2026-06");
    expect(mayBounds.endMs).toBe(juneBounds.startMs);
  });
});

describe("getPriorPeriod", () => {
  it("returns the prior month for a mid-month Manila instant", () => {
    // 2026-06-15 08:00 Manila = 2026-06-15 00:00 UTC
    const now = Date.UTC(2026, 5, 15, 0, 0, 0);
    const result = getPriorPeriod(now);
    expect(result.period).toBe("2026-05");
  });

  it("rolls back across year boundary (Jan → prior December)", () => {
    // 2026-01-05 08:00 Manila = 2026-01-05 00:00 UTC
    const now = Date.UTC(2026, 0, 5, 0, 0, 0);
    const result = getPriorPeriod(now);
    expect(result.period).toBe("2025-12");
  });

  it("a cron firing at 20:00 UTC on May 31 resolves to Manila wall-clock June 1 — prior month is May", () => {
    // 2026-05-31 20:00 UTC = 2026-06-01 04:00 Manila
    const now = Date.UTC(2026, 4, 31, 20, 0, 0);
    const result = getPriorPeriod(now);
    expect(result.period).toBe("2026-05");
  });
});

// ---------------------------------------------------------------------------
// PII redaction — govIdNumber to last-4
// ---------------------------------------------------------------------------

describe("redactGovIdLast4", () => {
  it("returns the last-4 alphanumeric chars", () => {
    expect(redactGovIdLast4("123456789")).toBe("6789");
    expect(redactGovIdLast4("AB1234CD5678")).toBe("5678");
    expect(redactGovIdLast4("123-456-789")).toBe("6789");
  });

  it("returns the input verbatim when ≤ 4 alphanumeric chars", () => {
    expect(redactGovIdLast4("ABC")).toBe("ABC");
    expect(redactGovIdLast4("12")).toBe("12");
    expect(redactGovIdLast4("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Payload building + serialization (gzip + sha256)
// ---------------------------------------------------------------------------

const SAMPLE_RECEIPTS = [
  {
    _id: "receipts:r1",
    paymentId: "payments:p1",
    receiptSeries: "OR-",
    receiptNumber: "OR-0000123",
    receiptSerial: 123,
    contractId: "contracts:c1",
    customerId: "customers:cu1",
    amountCents: 50000,
    issuedAt: Date.UTC(2026, 4, 15, 6, 0, 0),
    issuedByUserId: "users:u1",
    isVoided: false,
    voidedAt: null,
    voidReason: null,
    voidedByUserId: null,
  },
];

const SAMPLE_PAYMENTS = [
  {
    _id: "payments:p1",
    paymentNumber: "OR-0000123",
    contractId: "contracts:c1",
    customerId: "customers:cu1",
    amountCents: 50000,
    paymentMethod: "cash" as const,
    reference: null,
    receivedAt: Date.UTC(2026, 4, 15, 6, 0, 0),
    receivedByUserId: "users:u1",
    isVoided: false,
    voidedAt: null,
    voidReason: null,
    voidedByUserId: null,
  },
];

const SAMPLE_CUSTOMERS = [
  {
    _id: "customers:cu1",
    fullName: "Juan Dela Cruz",
    phone: "+639171234567",
    email: "juan@example.test",
    address: {
      line1: "123 Main St",
      barangay: "San Vicente",
      cityMunicipality: "Quezon City",
      province: "Metro Manila",
      postalCode: "1100",
    },
    govIdType: "sss" as const,
    govIdNumberLast4: "6789",
    relationshipToOccupant: null,
    hasConsent: true,
    createdAt: Date.UTC(2026, 0, 1),
  },
];

const SAMPLE_CONTRACTS = [
  {
    _id: "contracts:c1",
    contractNumber: "C-2026-001",
    lotId: "lots:l1",
    customerId: "customers:cu1",
    kind: "full_payment" as const,
    totalPriceCents: 50000,
    state: "paid_in_full" as const,
    createdAt: Date.UTC(2026, 4, 15, 6, 0, 0),
    basePriceCents: null,
    discountCents: null,
    perpetualCareCents: null,
    perpetualCarePaidCents: null,
  },
];

describe("buildArchivalPayload", () => {
  it("assembles the payload with schemaVersion, period, counts, and rows", () => {
    const payload = buildArchivalPayload({
      period: "2026-05",
      exportedAt: 1717200000000,
      deploymentName: "beaming-boar-935",
      receipts: SAMPLE_RECEIPTS,
      payments: SAMPLE_PAYMENTS,
      customers: SAMPLE_CUSTOMERS,
      contracts: SAMPLE_CONTRACTS,
    });
    expect(payload.schemaVersion).toBe(ARCHIVAL_SCHEMA_VERSION);
    expect(payload.period).toBe("2026-05");
    expect(payload.exportedAt).toBe(1717200000000);
    expect(payload.deploymentName).toBe("beaming-boar-935");
    expect(payload.recordCounts).toEqual({
      receipts: 1,
      payments: 1,
      customers: 1,
      contracts: 1,
    });
    expect(payload.receipts).toHaveLength(1);
    expect(payload.payments).toHaveLength(1);
    expect(payload.customers).toHaveLength(1);
    expect(payload.contracts).toHaveLength(1);
  });

  it("customer rows carry redacted govIdNumberLast4 — full govIdNumber is absent", () => {
    const payload = buildArchivalPayload({
      period: "2026-05",
      exportedAt: 1717200000000,
      deploymentName: "test",
      receipts: SAMPLE_RECEIPTS,
      payments: SAMPLE_PAYMENTS,
      customers: SAMPLE_CUSTOMERS,
      contracts: SAMPLE_CONTRACTS,
    });
    const customer = payload.customers[0]!;
    expect(customer.govIdNumberLast4).toBe("6789");
    expect(
      (customer as unknown as Record<string, unknown>).govIdNumber,
    ).toBeUndefined();
  });
});

describe("serializePayload", () => {
  it("pretty-prints JSON THEN gzips THEN hashes", () => {
    const payload = buildArchivalPayload({
      period: "2026-05",
      exportedAt: 1717200000000,
      deploymentName: "test",
      receipts: SAMPLE_RECEIPTS,
      payments: SAMPLE_PAYMENTS,
      customers: SAMPLE_CUSTOMERS,
      contracts: SAMPLE_CONTRACTS,
    });
    const { uncompressed, compressed, sha256 } = serializePayload(payload);
    // The uncompressed bytes are pretty-printed JSON (2-space indent).
    const text = uncompressed.toString("utf8");
    expect(text).toContain('  "schemaVersion": 1');
    expect(text).toContain('  "period": "2026-05"');
    // Gunzip + parse round-trips.
    const roundTripped = JSON.parse(gunzipSync(compressed).toString("utf8"));
    expect(roundTripped.schemaVersion).toBe(1);
    expect(roundTripped.period).toBe("2026-05");
    expect(roundTripped.receipts).toHaveLength(1);
    // SHA-256 is a 64-char hex string.
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a deterministic gzip + sha256 for the same payload", () => {
    const payload = buildArchivalPayload({
      period: "2026-05",
      exportedAt: 1717200000000,
      deploymentName: "test",
      receipts: SAMPLE_RECEIPTS,
      payments: SAMPLE_PAYMENTS,
      customers: SAMPLE_CUSTOMERS,
      contracts: SAMPLE_CONTRACTS,
    });
    const a = serializePayload(payload);
    const b = serializePayload(payload);
    expect(a.sha256).toBe(b.sha256);
    expect(a.compressed.equals(b.compressed)).toBe(true);
  });
});

describe("collectCustomerIds + collectContractIds", () => {
  it("collects unique customer ids from receipts + payments", () => {
    const ids = collectCustomerIds({
      receipts: [
        { ...SAMPLE_RECEIPTS[0]!, customerId: "customers:a" },
        { ...SAMPLE_RECEIPTS[0]!, customerId: "customers:b" },
      ],
      payments: [
        { ...SAMPLE_PAYMENTS[0]!, customerId: "customers:a" },
        { ...SAMPLE_PAYMENTS[0]!, customerId: "customers:c" },
      ],
    });
    expect(ids.sort()).toEqual(["customers:a", "customers:b", "customers:c"]);
  });

  it("ignores null customer ids", () => {
    const ids = collectCustomerIds({
      receipts: [{ ...SAMPLE_RECEIPTS[0]!, customerId: null }],
      payments: [{ ...SAMPLE_PAYMENTS[0]!, customerId: "customers:a" }],
    });
    expect(ids).toEqual(["customers:a"]);
  });

  it("collects unique contract ids from payments AND receipts (union)", () => {
    const ids = collectContractIds({
      payments: [
        { ...SAMPLE_PAYMENTS[0]!, contractId: "contracts:c1" },
        { ...SAMPLE_PAYMENTS[0]!, contractId: "contracts:c2" },
        { ...SAMPLE_PAYMENTS[0]!, contractId: "contracts:c1" },
      ],
      receipts: [
        // Receipt for a contract that has NO in-period payment row —
        // the P1-fix scenario.  Must still appear in the union.
        { ...SAMPLE_RECEIPTS[0]!, contractId: "contracts:c3" },
        { ...SAMPLE_RECEIPTS[0]!, contractId: "contracts:c1" },
      ],
    });
    expect(ids.sort()).toEqual([
      "contracts:c1",
      "contracts:c2",
      "contracts:c3",
    ]);
  });

  it("ignores null contract ids on both receipts and payments", () => {
    const ids = collectContractIds({
      payments: [{ ...SAMPLE_PAYMENTS[0]!, contractId: null }],
      receipts: [
        { ...SAMPLE_RECEIPTS[0]!, contractId: "contracts:c1" },
        { ...SAMPLE_RECEIPTS[0]!, contractId: null },
      ],
    });
    expect(ids).toEqual(["contracts:c1"]);
  });
});

// ---------------------------------------------------------------------------
// S3 upload helper — env-gated + SDK-mocked
// ---------------------------------------------------------------------------

// Mock the @aws-sdk/client-s3 module so the tests can drive happy /
// failure paths without touching the network.
const mockSend = vi.fn();
const mockPutObjectCommand = vi.fn(function PutObjectCommand(args: unknown) {
  // Capture the constructor args so the test can assert the body.
  return { __isPutObjectCommand: true, args };
});

vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    constructor(public readonly config: unknown) {}
    send = mockSend;
  }
  return {
    S3Client,
    PutObjectCommand: mockPutObjectCommand,
  };
});

beforeEach(() => {
  mockSend.mockReset();
  mockPutObjectCommand.mockClear();
  // Default: env vars unset.
  delete process.env.ARCHIVE_S3_BUCKET;
  delete process.env.ARCHIVE_S3_REGION;
  delete process.env.ARCHIVE_S3_ACCESS_KEY;
  delete process.env.ARCHIVE_S3_SECRET_KEY;
  delete process.env.ARCHIVE_S3_ENDPOINT;
});

afterEach(() => {
  delete process.env.ARCHIVE_S3_BUCKET;
  delete process.env.ARCHIVE_S3_REGION;
  delete process.env.ARCHIVE_S3_ACCESS_KEY;
  delete process.env.ARCHIVE_S3_SECRET_KEY;
  delete process.env.ARCHIVE_S3_ENDPOINT;
});

describe("uploadToS3", () => {
  it("returns { status: 'skipped' } when ARCHIVE_S3_BUCKET is unset", async () => {
    const result = await uploadToS3(Buffer.from("test"), "2026-05");
    expect(result).toEqual({ status: "skipped" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns { status: 'failed' } when bucket is set but other vars are missing", async () => {
    process.env.ARCHIVE_S3_BUCKET = "test-bucket";
    // region / key / secret intentionally absent.
    const result = await uploadToS3(Buffer.from("test"), "2026-05");
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("REGION");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("uploads + returns { status: 'uploaded', etag } on success", async () => {
    process.env.ARCHIVE_S3_BUCKET = "test-bucket";
    process.env.ARCHIVE_S3_REGION = "us-east-1";
    process.env.ARCHIVE_S3_ACCESS_KEY = "AKIA-TEST";
    process.env.ARCHIVE_S3_SECRET_KEY = "secret-test";
    mockSend.mockResolvedValueOnce({ ETag: '"abc123def456"' });

    const result = await uploadToS3(Buffer.from("test"), "2026-05");
    expect(result.status).toBe("uploaded");
    // Quoted ETag is unwrapped.
    expect(result.etag).toBe("abc123def456");
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockPutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: "test-bucket",
        Key: "archives/2026-05.json.gz",
        ContentType: "application/gzip",
      }),
    );
  });

  it("captures the SDK error message in { status: 'failed' } without throwing", async () => {
    process.env.ARCHIVE_S3_BUCKET = "test-bucket";
    process.env.ARCHIVE_S3_REGION = "us-east-1";
    process.env.ARCHIVE_S3_ACCESS_KEY = "AKIA-TEST";
    process.env.ARCHIVE_S3_SECRET_KEY = "secret-test";
    mockSend.mockRejectedValueOnce(new Error("AccessDenied: bucket not found"));

    const result = await uploadToS3(Buffer.from("test"), "2026-05");
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("AccessDenied: bucket not found");
  });

  it("threads ARCHIVE_S3_ENDPOINT into the client config when set (non-AWS providers)", async () => {
    process.env.ARCHIVE_S3_BUCKET = "test-bucket";
    process.env.ARCHIVE_S3_REGION = "auto";
    process.env.ARCHIVE_S3_ACCESS_KEY = "AKIA-TEST";
    process.env.ARCHIVE_S3_SECRET_KEY = "secret-test";
    process.env.ARCHIVE_S3_ENDPOINT = "https://accountid.r2.cloudflarestorage.com";
    mockSend.mockResolvedValueOnce({ ETag: "etag" });

    const result = await uploadToS3(Buffer.from("test"), "2026-05");
    expect(result.status).toBe("uploaded");
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// `monthlyArchivalExport` action handler — hand-mocked ctx
// ---------------------------------------------------------------------------

interface ScheduledMutation {
  mutationPath: string;
  args: Record<string, unknown>;
}

interface ActionCtxBag {
  storedBlobs: Map<string, Buffer>;
  rows: Array<Record<string, unknown>>;
  scheduledMutations: ScheduledMutation[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeActionCtx(opts: {
  receipts?: ReturnType<typeof buildArchivalPayload>["receipts"];
  payments?: ReturnType<typeof buildArchivalPayload>["payments"];
  customers?: ReturnType<typeof buildArchivalPayload>["customers"];
  contracts?: ReturnType<typeof buildArchivalPayload>["contracts"];
  existingRow?: {
    _id: string;
    period: string;
    storageId: string;
    s3Status: "uploaded" | "failed" | "skipped" | undefined;
    recordCounts?: {
      receipts: number;
      payments: number;
      customers: number;
      contracts: number;
    };
  } | null;
}): ActionCtxBag {
  const storedBlobs = new Map<string, Buffer>();
  const rows: Array<Record<string, unknown>> = [];
  const scheduledMutations: ScheduledMutation[] = [];
  let blobCounter = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runQuery = async (ref: any, args: any): Promise<unknown> => {
    // `makeFunctionReference` wraps the path string behind the
    // `functionName` symbol; `getFunctionName` unwraps it.
    const path = getFunctionName(ref);
    if (path.includes("findExistingArchivalExport")) {
      if (opts.existingRow === undefined || opts.existingRow === null) {
        return null;
      }
      if ((args as { period: string }).period === opts.existingRow.period) {
        // The real internal query always returns a `recordCounts`
        // object (the schema field is non-optional). Default to zeros
        // when a test omitted it — covers the older test cases that
        // pre-date the P1 fix.
        return {
          ...opts.existingRow,
          recordCounts: opts.existingRow.recordCounts ?? {
            receipts: 0,
            payments: 0,
            customers: 0,
            contracts: 0,
          },
        };
      }
      return null;
    }
    if (path.includes("getReceiptsInPeriod")) {
      return opts.receipts ?? [];
    }
    if (path.includes("getPaymentsInPeriod")) {
      return opts.payments ?? [];
    }
    if (path.includes("getCustomersForPeriod")) {
      return opts.customers ?? [];
    }
    if (path.includes("getContractsForPeriod")) {
      // Filter the seed set by the ids the action actually requested
      // so tests can assert which contracts the action resolved
      // (mirrors what the real query does: only ids passed in get
      // returned).
      const all = opts.contracts ?? [];
      const requested = new Set(
        (args as { contractIds: string[] }).contractIds,
      );
      return all.filter((c) => requested.has(c._id));
    }
    throw new Error(`Unexpected runQuery path: ${path}`);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runMutation = async (ref: any, args: any): Promise<unknown> => {
    const path = getFunctionName(ref);
    scheduledMutations.push({
      mutationPath: path,
      args: args as Record<string, unknown>,
    });
    if (path.includes("insertExportRecord")) {
      const row = { _id: `archivalExports:${rows.length + 1}`, ...args };
      rows.push(row);
      return row._id;
    }
    throw new Error(`Unexpected runMutation path: ${path}`);
  };

  const storage = {
    store: vi.fn(async (blob: Blob): Promise<string> => {
      blobCounter += 1;
      const id = `_storage:${blobCounter}`;
      // jsdom's `Blob` doesn't implement `arrayBuffer()` reliably;
      // round-trip via the `Response` wrapper, which does.
      const arrayBuffer = await new Response(blob).arrayBuffer();
      storedBlobs.set(id, Buffer.from(arrayBuffer));
      return id;
    }),
  };

  return {
    storedBlobs,
    rows,
    scheduledMutations,
    ctx: { runQuery, runMutation, storage },
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

describe("monthlyArchivalExport action handler", () => {
  it("runs the full pipeline and inserts an archivalExports row when no prior exists", async () => {
    const run = handlerOf(monthlyArchivalExport);
    const bag = makeActionCtx({
      receipts: SAMPLE_RECEIPTS,
      payments: SAMPLE_PAYMENTS,
      customers: SAMPLE_CUSTOMERS,
      contracts: SAMPLE_CONTRACTS,
      existingRow: null,
    });

    const result = (await run(bag.ctx, {
      overridePeriod: "2026-05",
    })) as {
      period: string;
      storageId: string;
      recordCounts: {
        receipts: number;
        payments: number;
        customers: number;
        contracts: number;
      };
      status: "ready" | "skipped";
      s3Status: "uploaded" | "failed" | "skipped";
    };

    expect(result.period).toBe("2026-05");
    expect(result.status).toBe("ready");
    expect(result.s3Status).toBe("skipped"); // env var unset
    expect(result.recordCounts).toEqual({
      receipts: 1,
      payments: 1,
      customers: 1,
      contracts: 1,
    });

    // Blob was stored.
    expect(bag.storedBlobs.size).toBe(1);
    // archivalExports row was inserted.
    expect(bag.rows).toHaveLength(1);
    const row = bag.rows[0]!;
    expect(row.period).toBe("2026-05");
    expect(row.s3Status).toBe("skipped");
    expect((row.recordCounts as { receipts: number }).receipts).toBe(1);

    // Verify the stored row carries the expected sha256 + sizes.
    // (We exercise the blob -> JSON round-trip via the
    // `serializePayload` test above; here we rely on the recorded
    // metadata to confirm the action wrote what we expected.)
    expect(typeof row.sha256).toBe("string");
    expect((row.sha256 as string).length).toBe(64);
    expect(typeof row.sizeBytesUncompressed).toBe("number");
    expect(typeof row.sizeBytesCompressed).toBe("number");
    // Sanity check: gzipped should be smaller than uncompressed.
    expect(row.sizeBytesCompressed as number).toBeLessThan(
      row.sizeBytesUncompressed as number,
    );
  });

  it("idempotent — short-circuits when an existing ready row is present", async () => {
    const run = handlerOf(monthlyArchivalExport);
    const bag = makeActionCtx({
      receipts: SAMPLE_RECEIPTS,
      payments: SAMPLE_PAYMENTS,
      customers: SAMPLE_CUSTOMERS,
      contracts: SAMPLE_CONTRACTS,
      existingRow: {
        _id: "archivalExports:existing",
        period: "2026-05",
        storageId: "_storage:existing",
        s3Status: "uploaded",
      },
    });

    const result = (await run(bag.ctx, {
      overridePeriod: "2026-05",
    })) as { status: "ready" | "skipped"; storageId: string };

    expect(result.status).toBe("skipped");
    expect(result.storageId).toBe("_storage:existing");
    // No blob was stored.
    expect(bag.storedBlobs.size).toBe(0);
    // No row was inserted (the upsert mutation was not scheduled).
    expect(bag.scheduledMutations).toHaveLength(0);
  });

  it("re-runs the export when an existing row has s3Status: 'failed'", async () => {
    const run = handlerOf(monthlyArchivalExport);
    const bag = makeActionCtx({
      receipts: SAMPLE_RECEIPTS,
      payments: SAMPLE_PAYMENTS,
      customers: SAMPLE_CUSTOMERS,
      contracts: SAMPLE_CONTRACTS,
      existingRow: {
        _id: "archivalExports:existing",
        period: "2026-05",
        storageId: "_storage:existing",
        s3Status: "failed",
      },
    });

    const result = (await run(bag.ctx, {
      overridePeriod: "2026-05",
    })) as { status: "ready" | "skipped" };

    expect(result.status).toBe("ready");
    // Fresh blob was stored AND upsert was called.
    expect(bag.storedBlobs.size).toBe(1);
    expect(bag.scheduledMutations).toHaveLength(1);
  });

  it("uploads to S3 when ARCHIVE_S3_BUCKET is set + records the ETag", async () => {
    process.env.ARCHIVE_S3_BUCKET = "test-bucket";
    process.env.ARCHIVE_S3_REGION = "us-east-1";
    process.env.ARCHIVE_S3_ACCESS_KEY = "AKIA-TEST";
    process.env.ARCHIVE_S3_SECRET_KEY = "secret-test";
    mockSend.mockResolvedValueOnce({ ETag: '"deadbeef"' });

    const run = handlerOf(monthlyArchivalExport);
    const bag = makeActionCtx({
      receipts: SAMPLE_RECEIPTS,
      payments: SAMPLE_PAYMENTS,
      customers: SAMPLE_CUSTOMERS,
      contracts: SAMPLE_CONTRACTS,
      existingRow: null,
    });

    const result = (await run(bag.ctx, {
      overridePeriod: "2026-05",
    })) as { s3Status: "uploaded" | "failed" | "skipped" };

    expect(result.s3Status).toBe("uploaded");
    const row = bag.rows[0]!;
    expect(row.s3Status).toBe("uploaded");
    expect(row.s3Etag).toBe("deadbeef");
    expect(typeof row.s3UploadedAt).toBe("number");
  });

  it("records the S3 failure on the row WITHOUT throwing", async () => {
    process.env.ARCHIVE_S3_BUCKET = "test-bucket";
    process.env.ARCHIVE_S3_REGION = "us-east-1";
    process.env.ARCHIVE_S3_ACCESS_KEY = "AKIA-TEST";
    process.env.ARCHIVE_S3_SECRET_KEY = "secret-test";
    mockSend.mockRejectedValueOnce(new Error("NetworkUnreachable"));

    const run = handlerOf(monthlyArchivalExport);
    const bag = makeActionCtx({
      receipts: SAMPLE_RECEIPTS,
      payments: SAMPLE_PAYMENTS,
      customers: SAMPLE_CUSTOMERS,
      contracts: SAMPLE_CONTRACTS,
      existingRow: null,
    });

    const result = (await run(bag.ctx, {
      overridePeriod: "2026-05",
    })) as { s3Status: "uploaded" | "failed" | "skipped"; status: string };

    expect(result.s3Status).toBe("failed");
    expect(result.status).toBe("ready");
    // The local archive was still stored (the action completes despite S3 failure).
    expect(bag.storedBlobs.size).toBe(1);
    const row = bag.rows[0]!;
    expect(row.s3Status).toBe("failed");
    expect(row.s3ErrorMessage).toBe("NetworkUnreachable");
  });

  it("respects period boundary — a receipt with issuedAt at endMs is NOT included (caller responsibility, but verify the action wires the bounds correctly)", async () => {
    // This test exercises the bounds computation by capturing the args
    // that the action passes to `getReceiptsInPeriod`. We verify the
    // action requests `[startMs, endMs)` matching the Manila tz period.
    const run = handlerOf(monthlyArchivalExport);
    let capturedBounds: { startMs: number; endMs: number } | null = null;

    const bag = makeActionCtx({});
    // Override runQuery to capture the bounds.
    const originalRunQuery = bag.ctx.runQuery;
    bag.ctx.runQuery = async (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ref: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: any,
    ) => {
      const name = getFunctionName(ref);
      if (name.includes("getReceiptsInPeriod")) {
        capturedBounds = {
          startMs: (args as { startMs: number }).startMs,
          endMs: (args as { endMs: number }).endMs,
        };
      }
      return originalRunQuery(ref, args);
    };

    await run(bag.ctx, { overridePeriod: "2026-05" });
    expect(capturedBounds).not.toBeNull();
    const bounds = capturedBounds as unknown as {
      startMs: number;
      endMs: number;
    };
    // Manila tz bounds — start = 2026-04-30 16:00 UTC, end = 2026-05-31 16:00 UTC.
    expect(bounds.startMs).toBe(Date.UTC(2026, 3, 30, 16, 0, 0));
    expect(bounds.endMs).toBe(Date.UTC(2026, 4, 31, 16, 0, 0));
  });

  it("voided receipts are PRESERVED in the export (BIR audit retention)", async () => {
    const run = handlerOf(monthlyArchivalExport);
    const voidedReceipt = {
      ...SAMPLE_RECEIPTS[0]!,
      _id: "receipts:v1",
      isVoided: true,
      voidedAt: Date.UTC(2026, 4, 20),
      voidReason: "Issued in error",
      voidedByUserId: "users:admin1",
    };
    const bag = makeActionCtx({
      receipts: [SAMPLE_RECEIPTS[0]!, voidedReceipt],
      payments: SAMPLE_PAYMENTS,
      customers: SAMPLE_CUSTOMERS,
      contracts: SAMPLE_CONTRACTS,
      existingRow: null,
    });

    await run(bag.ctx, { overridePeriod: "2026-05" });

    // Both receipts are in the period query result → both flow into
    // the payload (the action does not filter voided rows). Assert
    // the row's count reflects the inclusion + assert the pure
    // serializer would have emitted both.
    const row = bag.rows[0]!;
    expect((row.recordCounts as { receipts: number }).receipts).toBe(2);
    // Independent check: re-build the payload from the same inputs
    // and confirm the voided receipt's voidReason survives.
    const payload = buildArchivalPayload({
      period: "2026-05",
      exportedAt: Date.now(),
      deploymentName: "test",
      receipts: [SAMPLE_RECEIPTS[0]!, voidedReceipt],
      payments: SAMPLE_PAYMENTS,
      customers: SAMPLE_CUSTOMERS,
      contracts: SAMPLE_CONTRACTS,
    });
    const voidedInPayload = payload.receipts.find((r) => r.isVoided === true);
    expect(voidedInPayload).toBeDefined();
    expect(voidedInPayload?.voidReason).toBe("Issued in error");
  });

  it("[P1] resolves a receipt-only contract — a May receipt whose contractId has NO May payment still appears in contracts[]", async () => {
    // Scenario: a receipt is issued in May 2026 against `contracts:c2`,
    // but the matching payment was received in April (out of period).
    // The May export must STILL carry `contracts:c2` so the archival
    // blob is referentially closed for the BIR audit.
    const receiptOnlyContractId = "contracts:c2";
    const receiptOnly = {
      ...SAMPLE_RECEIPTS[0]!,
      _id: "receipts:r2",
      contractId: receiptOnlyContractId,
      customerId: "customers:cu1",
    };
    const orphanContract = {
      ...SAMPLE_CONTRACTS[0]!,
      _id: receiptOnlyContractId,
      contractNumber: "C-2026-002",
    };

    const run = handlerOf(monthlyArchivalExport);
    const bag = makeActionCtx({
      // Receipts: one tied to c1 (also has a May payment) + one tied
      // to c2 (no May payment — only receipts reference it).
      receipts: [SAMPLE_RECEIPTS[0]!, receiptOnly],
      // Payments: only the c1 payment is in-period.
      payments: SAMPLE_PAYMENTS,
      customers: SAMPLE_CUSTOMERS,
      // Seed both contracts in the mocked db — the action's collected
      // contractIds drives which actually flow into the export.
      contracts: [SAMPLE_CONTRACTS[0]!, orphanContract],
      existingRow: null,
    });

    // Intercept the contracts query to capture exactly which ids the
    // action requested.
    let requestedContractIds: string[] | null = null;
    const originalRunQuery = bag.ctx.runQuery;
    bag.ctx.runQuery = async (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ref: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: any,
    ) => {
      if (getFunctionName(ref).includes("getContractsForPeriod")) {
        requestedContractIds = [...(args as { contractIds: string[] }).contractIds];
      }
      return originalRunQuery(ref, args);
    };

    await run(bag.ctx, { overridePeriod: "2026-05" });

    // The action requested BOTH contract ids (union of payment +
    // receipt contractIds).
    expect(requestedContractIds).not.toBeNull();
    expect((requestedContractIds as unknown as string[]).sort()).toEqual(
      ["contracts:c1", receiptOnlyContractId].sort(),
    );

    // And the inserted row's recordCounts.contracts === 2 — the
    // export blob will carry both contract docs in `contracts[]`.
    const row = bag.rows[0]!;
    expect((row.recordCounts as { contracts: number }).contracts).toBe(2);
  });

  it("[P1] idempotency short-circuit returns the EXISTING row's recordCounts (not zeros)", async () => {
    // First run: produce a real export with non-zero counts.
    const firstRun = handlerOf(monthlyArchivalExport);
    const firstBag = makeActionCtx({
      receipts: SAMPLE_RECEIPTS,
      payments: SAMPLE_PAYMENTS,
      customers: SAMPLE_CUSTOMERS,
      contracts: SAMPLE_CONTRACTS,
      existingRow: null,
    });
    const firstResult = (await firstRun(firstBag.ctx, {
      overridePeriod: "2026-05",
    })) as {
      status: "ready" | "skipped";
      storageId: string;
      recordCounts: {
        receipts: number;
        payments: number;
        customers: number;
        contracts: number;
      };
    };
    expect(firstResult.status).toBe("ready");
    expect(firstResult.recordCounts).toEqual({
      receipts: 1,
      payments: 1,
      customers: 1,
      contracts: 1,
    });

    // Second run: the existing row's `recordCounts` must come back
    // — NOT a zeroed-out skeleton.
    const secondRun = handlerOf(monthlyArchivalExport);
    const secondBag = makeActionCtx({
      receipts: SAMPLE_RECEIPTS,
      payments: SAMPLE_PAYMENTS,
      customers: SAMPLE_CUSTOMERS,
      contracts: SAMPLE_CONTRACTS,
      existingRow: {
        _id: "archivalExports:1",
        period: "2026-05",
        storageId: firstResult.storageId,
        s3Status: "skipped",
        recordCounts: firstResult.recordCounts,
      },
    });
    const secondResult = (await secondRun(secondBag.ctx, {
      overridePeriod: "2026-05",
    })) as {
      status: "ready" | "skipped";
      storageId: string;
      recordCounts: {
        receipts: number;
        payments: number;
        customers: number;
        contracts: number;
      };
    };

    expect(secondResult.status).toBe("skipped");
    expect(secondResult.storageId).toBe(firstResult.storageId);
    // Counts MIRROR the first run — not zeros.
    expect(secondResult.recordCounts).toEqual(firstResult.recordCounts);
    expect(secondResult.recordCounts.receipts).toBeGreaterThan(0);
    // And no new write happened on the skip path.
    expect(secondBag.storedBlobs.size).toBe(0);
    expect(secondBag.scheduledMutations).toHaveLength(0);
  });
});
