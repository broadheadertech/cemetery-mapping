/**
 * Story 2.2 — `convex/customerDocuments.ts` unit tests.
 *
 * Hand-mocked ctx, same pattern as `conditionLogs.test.ts` and
 * `customers.test.ts`. Covers:
 *   - `generateCustomerDocumentUploadUrl` — role gate + URL return.
 *   - `uploadCustomerDocument` — happy path, role gates, size + MIME
 *     allowlist, consent gate (per-doctype), per-customer cap,
 *     audit emission with redacted `storageId`.
 *   - `getCustomerDocumentUrl` — auth gate, soft-deleted rows,
 *     missing rows.
 *   - `listCustomerDocuments` — sort order, `includeDeleted` toggle,
 *     metadata-only contract (no URLs).
 *   - `softDeleteCustomerDocument` — happy path, idempotency,
 *     missing rows.
 *
 * Coverage target: ≥ 90% on `convex/customerDocuments.ts` (PII-
 * adjacent code per NFR-M2).
 */

import { ConvexError, type Value } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ErrorCode,
  type ErrorPayload,
} from "../../../convex/lib/errors";
import { HOUR_MS } from "../../../convex/lib/time";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import {
  generateCustomerDocumentUploadUrl,
  getCustomerDocumentUrl,
  listCustomerDocuments,
  softDeleteCustomerDocument,
  uploadCustomerDocument,
  MAX_DOCUMENTS_PER_CUSTOMER,
  MAX_FILE_BYTES,
} from "../../../convex/customerDocuments";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const USER_ID = "users:office1";
const SESSION_ID = "authSessions:s1";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface CustomerFixture {
  _id: string;
  _creationTime: number;
  fullName: string;
  hasConsent: boolean;
}

interface DocumentFixture {
  _id: string;
  _creationTime: number;
  customerId: string;
  docType: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageId: string;
  uploadedAt: number;
  uploadedByUserId: string;
  notes?: string;
  isDeleted: boolean;
  deletedAt?: number;
  deletedByUserId?: string;
  deletedReason?: string;
}

interface AuditInsert {
  table: string;
  row: {
    actor: string;
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
    reason?: string;
  };
}

interface CtxBag {
  customers: Map<string, CustomerFixture>;
  documents: Map<string, DocumentFixture>;
  auditInserts: AuditInsert[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  initialCustomers?: CustomerFixture[];
  initialDocuments?: DocumentFixture[];
  authenticated?: boolean;
  storageUrls?: Record<string, string | null>;
}): CtxBag {
  const customers = new Map<string, CustomerFixture>(
    (opts.initialCustomers ?? []).map((c) => [c._id, c]),
  );
  const documents = new Map<string, DocumentFixture>(
    (opts.initialDocuments ?? []).map((d) => [d._id, d]),
  );
  const auditInserts: AuditInsert[] = [];

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

  let nextId = 1;

  interface IndexQuery {
    eqs: Record<string, unknown>;
    eq(field: string, value: unknown): IndexQuery;
  }

  function makeDocsQueryBuilder() {
    type Predicate = (r: DocumentFixture) => boolean;
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
          predicates.push(
            (r) => (r as unknown as Record<string, unknown>)[field] === value,
          );
        }
        return builder;
      },
      async collect() {
        return Array.from(documents.values()).filter((r) =>
          predicates.every((p) => p(r)),
        );
      },
      async first() {
        const rows = await builder.collect();
        return rows[0] ?? null;
      },
    };
    return builder;
  }

  const ctx = {
    db: {
      get: vi.fn(async (id: string) => {
        if (id === USER_ID) return user;
        if (id === SESSION_ID) return session;
        if (customers.has(id)) return customers.get(id);
        if (documents.has(id)) return documents.get(id);
        return null;
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return {
            withIndex: (_n: string, _f: unknown) => ({
              collect: async () => userRoles,
            }),
          };
        }
        if (table === "customerDocuments") {
          return makeDocsQueryBuilder();
        }
        return {
          withIndex: () => ({
            collect: async () => [],
            first: async () => null,
            take: async () => [],
          }),
        };
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "customerDocuments") {
          const id = `customerDocuments:${nextId++}`;
          const doc = {
            _id: id,
            _creationTime: T0,
            ...row,
          } as DocumentFixture;
          documents.set(id, doc);
          return id;
        }
        if (table === "auditLog") {
          auditInserts.push({
            table,
            row: row as AuditInsert["row"],
          });
          return `auditLog:${auditInserts.length}`;
        }
        return `${table}:?`;
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        const existing = documents.get(id);
        if (existing === undefined) return;
        documents.set(id, { ...existing, ...patch } as DocumentFixture);
      }),
    },
    storage: {
      generateUploadUrl: vi.fn(async () => "https://example/upload/abc"),
      getUrl: vi.fn(async (sid: string) => {
        const map = opts.storageUrls ?? {};
        return map[sid] ?? `https://example/signed/${sid}`;
      }),
    },
  };

  return { customers, documents, auditInserts, ctx };
}

function makeCustomerFixture(
  overrides: Partial<CustomerFixture> = {},
): CustomerFixture {
  return {
    _id: overrides._id ?? "customers:1",
    _creationTime: T0,
    fullName: overrides.fullName ?? "Juan dela Cruz",
    hasConsent: overrides.hasConsent ?? true,
    ...overrides,
  };
}

function makeDocFixture(
  overrides: Partial<DocumentFixture> = {},
): DocumentFixture {
  return {
    _id: overrides._id ?? "customerDocuments:fixture",
    _creationTime: T0,
    customerId: overrides.customerId ?? "customers:1",
    docType: overrides.docType ?? "national_id",
    fileName: overrides.fileName ?? "id.jpg",
    mimeType: overrides.mimeType ?? "image/jpeg",
    sizeBytes: overrides.sizeBytes ?? 1024 * 100,
    storageId: overrides.storageId ?? "_storage:abc",
    uploadedAt: overrides.uploadedAt ?? T0,
    uploadedByUserId: overrides.uploadedByUserId ?? USER_ID,
    isDeleted: overrides.isDeleted ?? false,
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

// ---------------------------------------------------------------------------
// generateCustomerDocumentUploadUrl
// ---------------------------------------------------------------------------

describe("generateCustomerDocumentUploadUrl", () => {
  const run = handlerOf(generateCustomerDocumentUploadUrl);

  it("returns a short-lived upload URL for office_staff", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const url = (await run(ctx, {})) as string;
    expect(url).toBe("https://example/upload/abc");
  });

  it("returns a short-lived upload URL for admin", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const url = (await run(ctx, {})) as string;
    expect(url).toBe("https://example/upload/abc");
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects customer role with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["customer"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});

// ---------------------------------------------------------------------------
// uploadCustomerDocument
// ---------------------------------------------------------------------------

describe("uploadCustomerDocument", () => {
  const run = handlerOf(uploadCustomerDocument);

  const baseArgs = {
    customerId: "customers:1",
    docType: "national_id" as const,
    fileName: "id.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 1024 * 1024,
    storageId: "_storage:new",
  };

  it("inserts a document, emits audit with redacted storageId, returns the id", async () => {
    const customer = makeCustomerFixture({ hasConsent: true });
    const { ctx, documents, auditInserts } = makeCtx({
      initialCustomers: [customer],
    });

    const result = (await run(ctx, baseArgs)) as { documentId: string };
    expect(result.documentId).toMatch(/^customerDocuments:/);
    expect(documents.size).toBe(1);
    const doc = documents.get(result.documentId)!;
    expect(doc.docType).toBe("national_id");
    expect(doc.fileName).toBe("id.jpg");
    expect(doc.isDeleted).toBe(false);
    expect(doc.uploadedByUserId).toBe(USER_ID);

    expect(auditInserts).toHaveLength(1);
    const audit = auditInserts[0]!;
    expect(audit.row.action).toBe("create");
    expect(audit.row.entityType).toBe("customer");
    expect(audit.row.entityId).toBe(customer._id);
    // Critical: storageId is redacted in the audit `after` payload.
    expect(audit.row.after).toMatchObject({
      storageId: "[storage-id-redacted]",
      docType: "national_id",
    });
    expect(
      (audit.row.after as { storageId: string }).storageId,
    ).not.toBe("_storage:new");
  });

  it("allows office_staff and admin to upload", async () => {
    const customer = makeCustomerFixture();
    for (const role of ["office_staff", "admin"] as const) {
      const { ctx, documents } = makeCtx({
        roles: [role],
        initialCustomers: [customer],
      });
      await run(ctx, { ...baseArgs, fileName: `${role}.jpg` });
      expect(documents.size).toBe(1);
    }
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const customer = makeCustomerFixture();
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      initialCustomers: [customer],
    });
    const thrown = await run(ctx, baseArgs).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const customer = makeCustomerFixture();
    const { ctx } = makeCtx({
      authenticated: false,
      initialCustomers: [customer],
    });
    const thrown = await run(ctx, baseArgs).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("refuses gov-ID family docs when customer has not consented (INVARIANT_VIOLATION)", async () => {
    const customer = makeCustomerFixture({ hasConsent: false });
    const { ctx } = makeCtx({ initialCustomers: [customer] });

    for (const docType of [
      "national_id",
      "drivers_license",
      "passport",
      "voters_id",
      "other",
    ] as const) {
      const thrown = await run(ctx, { ...baseArgs, docType }).catch(
        (e) => e,
      );
      expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
    }
  });

  it("allows non-gov-ID docs (affidavit, court_order, death_certificate) without consent", async () => {
    const customer = makeCustomerFixture({ hasConsent: false });
    const { ctx, documents } = makeCtx({ initialCustomers: [customer] });

    for (const docType of [
      "affidavit",
      "court_order",
      "death_certificate",
    ] as const) {
      const result = (await run(ctx, {
        ...baseArgs,
        docType,
        fileName: `${docType}.pdf`,
        mimeType: "application/pdf",
      })) as { documentId: string };
      expect(result.documentId).toMatch(/^customerDocuments:/);
    }
    expect(documents.size).toBe(3);
  });

  it("rejects files larger than 10MB with VALIDATION", async () => {
    const customer = makeCustomerFixture();
    const { ctx } = makeCtx({ initialCustomers: [customer] });
    const thrown = await run(ctx, {
      ...baseArgs,
      sizeBytes: MAX_FILE_BYTES + 1,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects zero or negative size with VALIDATION", async () => {
    const customer = makeCustomerFixture();
    const { ctx } = makeCtx({ initialCustomers: [customer] });
    for (const sizeBytes of [0, -1]) {
      const thrown = await run(ctx, { ...baseArgs, sizeBytes }).catch(
        (e) => e,
      );
      expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    }
  });

  it("rejects disallowed MIME types with VALIDATION", async () => {
    const customer = makeCustomerFixture();
    const { ctx } = makeCtx({ initialCustomers: [customer] });
    for (const mimeType of [
      "image/gif",
      "image/heic",
      "application/javascript",
      "text/html",
    ]) {
      const thrown = await run(ctx, { ...baseArgs, mimeType }).catch(
        (e) => e,
      );
      expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    }
  });

  it("accepts every allowed MIME type", async () => {
    const customer = makeCustomerFixture();
    for (const mimeType of [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
    ]) {
      const { ctx, documents } = makeCtx({ initialCustomers: [customer] });
      await run(ctx, {
        ...baseArgs,
        mimeType,
        fileName: `file.${mimeType.split("/")[1]}`,
      });
      expect(documents.size).toBe(1);
    }
  });

  it("rejects empty / whitespace-only file names with VALIDATION", async () => {
    const customer = makeCustomerFixture();
    const { ctx } = makeCtx({ initialCustomers: [customer] });
    for (const fileName of ["", "   ", "\t\n  "]) {
      const thrown = await run(ctx, { ...baseArgs, fileName }).catch(
        (e) => e,
      );
      expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    }
  });

  it("rejects file names longer than 255 chars with VALIDATION", async () => {
    const customer = makeCustomerFixture();
    const { ctx } = makeCtx({ initialCustomers: [customer] });
    const fileName = "a".repeat(256) + ".jpg";
    const thrown = await run(ctx, { ...baseArgs, fileName }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("throws NOT_FOUND when the customer doesn't exist", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, {
      ...baseArgs,
      customerId: "customers:ghost",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("enforces the per-customer cap of 10 active documents", async () => {
    const customer = makeCustomerFixture();
    const initialDocuments: DocumentFixture[] = Array.from(
      { length: MAX_DOCUMENTS_PER_CUSTOMER },
      (_, i) =>
        makeDocFixture({
          _id: `customerDocuments:existing-${i}`,
          customerId: customer._id,
        }),
    );
    const { ctx } = makeCtx({
      initialCustomers: [customer],
      initialDocuments,
    });
    const thrown = await run(ctx, baseArgs).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("does NOT count soft-deleted documents toward the cap", async () => {
    const customer = makeCustomerFixture();
    const initialDocuments: DocumentFixture[] = [
      ...Array.from({ length: MAX_DOCUMENTS_PER_CUSTOMER - 1 }, (_, i) =>
        makeDocFixture({
          _id: `customerDocuments:active-${i}`,
          customerId: customer._id,
          isDeleted: false,
        }),
      ),
      // Five extra soft-deleted rows that should NOT count.
      ...Array.from({ length: 5 }, (_, i) =>
        makeDocFixture({
          _id: `customerDocuments:deleted-${i}`,
          customerId: customer._id,
          isDeleted: true,
        }),
      ),
    ];
    const { ctx, documents } = makeCtx({
      initialCustomers: [customer],
      initialDocuments,
    });
    const result = (await run(ctx, baseArgs)) as { documentId: string };
    expect(result.documentId).toMatch(/^customerDocuments:/);
    // 9 active + 5 deleted + 1 new = 15 total rows.
    expect(documents.size).toBe(MAX_DOCUMENTS_PER_CUSTOMER + 5);
  });

  it("trims and stores the optional notes field", async () => {
    const customer = makeCustomerFixture();
    const { ctx, documents } = makeCtx({ initialCustomers: [customer] });
    const result = (await run(ctx, {
      ...baseArgs,
      notes: "   captured at front desk   ",
    })) as { documentId: string };
    const doc = documents.get(result.documentId)!;
    expect(doc.notes).toBe("captured at front desk");
  });

  it("omits notes from the inserted row when empty / whitespace", async () => {
    const customer = makeCustomerFixture();
    const { ctx, documents } = makeCtx({ initialCustomers: [customer] });
    const result = (await run(ctx, { ...baseArgs, notes: "   " })) as {
      documentId: string;
    };
    const doc = documents.get(result.documentId)!;
    expect(doc.notes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getCustomerDocumentUrl
// ---------------------------------------------------------------------------

describe("getCustomerDocumentUrl", () => {
  const run = handlerOf(getCustomerDocumentUrl);

  it("returns the signed URL + metadata when the document exists and isn't deleted", async () => {
    const doc = makeDocFixture({
      _id: "customerDocuments:abc",
      storageId: "_storage:p1",
      fileName: "scan.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 12345,
      docType: "national_id",
    });
    const { ctx } = makeCtx({
      initialDocuments: [doc],
      storageUrls: { "_storage:p1": "https://signed/p1" },
    });
    const result = (await run(ctx, { documentId: doc._id })) as {
      url: string | null;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      docType: string;
    } | null;
    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://signed/p1");
    expect(result!.fileName).toBe("scan.jpg");
    expect(result!.mimeType).toBe("image/jpeg");
    expect(result!.sizeBytes).toBe(12345);
    expect(result!.docType).toBe("national_id");
  });

  it("returns null when the document is soft-deleted", async () => {
    const doc = makeDocFixture({
      _id: "customerDocuments:gone",
      isDeleted: true,
    });
    const { ctx } = makeCtx({ initialDocuments: [doc] });
    const result = await run(ctx, { documentId: doc._id });
    expect(result).toBeNull();
  });

  it("returns null when the document id doesn't exist", async () => {
    const { ctx } = makeCtx({});
    const result = await run(ctx, {
      documentId: "customerDocuments:ghost",
    });
    expect(result).toBeNull();
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const doc = makeDocFixture();
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      initialDocuments: [doc],
    });
    const thrown = await run(ctx, { documentId: doc._id }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects customer role with FORBIDDEN", async () => {
    const doc = makeDocFixture();
    const { ctx } = makeCtx({
      roles: ["customer"],
      initialDocuments: [doc],
    });
    const thrown = await run(ctx, { documentId: doc._id }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const doc = makeDocFixture();
    const { ctx } = makeCtx({
      authenticated: false,
      initialDocuments: [doc],
    });
    const thrown = await run(ctx, { documentId: doc._id }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});

// ---------------------------------------------------------------------------
// listCustomerDocuments
// ---------------------------------------------------------------------------

describe("listCustomerDocuments", () => {
  const run = handlerOf(listCustomerDocuments);

  it("returns documents in newest-first order, excluding deleted by default", async () => {
    const docs: DocumentFixture[] = [
      makeDocFixture({
        _id: "customerDocuments:a",
        uploadedAt: T0 + 1000,
      }),
      makeDocFixture({
        _id: "customerDocuments:b",
        uploadedAt: T0 + 2000,
      }),
      makeDocFixture({
        _id: "customerDocuments:c",
        uploadedAt: T0 + 3000,
        isDeleted: true,
      }),
    ];
    const { ctx } = makeCtx({ initialDocuments: docs });
    const result = (await run(ctx, {
      customerId: "customers:1",
    })) as Array<{ documentId: string }>;
    expect(result.map((r) => r.documentId)).toEqual([
      "customerDocuments:b",
      "customerDocuments:a",
    ]);
  });

  it("includes deleted documents when includeDeleted is true", async () => {
    const docs: DocumentFixture[] = [
      makeDocFixture({
        _id: "customerDocuments:active",
        uploadedAt: T0 + 1000,
      }),
      makeDocFixture({
        _id: "customerDocuments:archived",
        uploadedAt: T0 + 2000,
        isDeleted: true,
      }),
    ];
    const { ctx } = makeCtx({ initialDocuments: docs });
    const result = (await run(ctx, {
      customerId: "customers:1",
      includeDeleted: true,
    })) as Array<{ documentId: string; isDeleted: boolean }>;
    expect(result).toHaveLength(2);
    expect(result[0]!.documentId).toBe("customerDocuments:archived");
    expect(result[0]!.isDeleted).toBe(true);
  });

  it("does NOT include URLs in the listing (metadata only)", async () => {
    const doc = makeDocFixture();
    const { ctx } = makeCtx({ initialDocuments: [doc] });
    const result = (await run(ctx, {
      customerId: "customers:1",
    })) as Array<Record<string, unknown>>;
    expect(result[0]).not.toHaveProperty("url");
    expect(result[0]).not.toHaveProperty("storageId");
  });

  it("augments each row with the uploader's name", async () => {
    const doc = makeDocFixture();
    const { ctx } = makeCtx({ initialDocuments: [doc] });
    const result = (await run(ctx, {
      customerId: "customers:1",
    })) as Array<{ uploadedByName: string | null }>;
    expect(result[0]!.uploadedByName).toBe("Maria Office");
  });

  it("returns an empty array when the customer has no documents", async () => {
    const { ctx } = makeCtx({});
    const result = (await run(ctx, {
      customerId: "customers:empty",
    })) as unknown[];
    expect(result).toEqual([]);
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    const thrown = await run(ctx, { customerId: "customers:1" }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

// ---------------------------------------------------------------------------
// softDeleteCustomerDocument
// ---------------------------------------------------------------------------

describe("softDeleteCustomerDocument", () => {
  const run = handlerOf(softDeleteCustomerDocument);

  it("flips isDeleted, records metadata, emits a delete audit row", async () => {
    const doc = makeDocFixture({ _id: "customerDocuments:doomed" });
    const { ctx, documents, auditInserts } = makeCtx({
      initialDocuments: [doc],
    });

    const result = (await run(ctx, {
      documentId: doc._id,
      reason: "uploaded by mistake",
    })) as { documentId: string };
    expect(result.documentId).toBe(doc._id);

    const updated = documents.get(doc._id)!;
    expect(updated.isDeleted).toBe(true);
    expect(updated.deletedAt).toBe(T0);
    expect(updated.deletedByUserId).toBe(USER_ID);
    expect(updated.deletedReason).toBe("uploaded by mistake");

    expect(auditInserts).toHaveLength(1);
    const audit = auditInserts[0]!;
    expect(audit.row.action).toBe("delete");
    expect(audit.row.entityType).toBe("customer");
    expect(audit.row.entityId).toBe(doc.customerId);
    expect(audit.row.reason).toBe("uploaded by mistake");
  });

  it("is idempotent: a second call on a deleted row is a no-op (no extra audit)", async () => {
    const doc = makeDocFixture({
      _id: "customerDocuments:already",
      isDeleted: true,
    });
    const { ctx, documents, auditInserts } = makeCtx({
      initialDocuments: [doc],
    });

    const result = (await run(ctx, { documentId: doc._id })) as {
      documentId: string;
    };
    expect(result.documentId).toBe(doc._id);
    // No second audit row emitted.
    expect(auditInserts).toHaveLength(0);
    // The original row is unchanged.
    expect(documents.get(doc._id)!.isDeleted).toBe(true);
  });

  it("throws NOT_FOUND when the document doesn't exist", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, {
      documentId: "customerDocuments:ghost",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const doc = makeDocFixture();
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      initialDocuments: [doc],
    });
    const thrown = await run(ctx, { documentId: doc._id }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const doc = makeDocFixture();
    const { ctx } = makeCtx({
      authenticated: false,
      initialDocuments: [doc],
    });
    const thrown = await run(ctx, { documentId: doc._id }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("omits the deletedReason field when not provided", async () => {
    const doc = makeDocFixture({ _id: "customerDocuments:noReason" });
    const { ctx, documents } = makeCtx({ initialDocuments: [doc] });
    await run(ctx, { documentId: doc._id });
    const updated = documents.get(doc._id)!;
    expect(updated.deletedReason).toBeUndefined();
  });
});
