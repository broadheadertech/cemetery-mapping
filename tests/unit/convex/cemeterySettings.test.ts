/**
 * `convex/cemeterySettings.ts` — admin BIR receipt config CRUD tests.
 *
 * Validates:
 *   - `getBirReceiptConfig` returns the singleton row (or null) and
 *     gates by role.
 *   - `setBirReceiptConfig` upserts, validates, and emits the audit
 *     row (create on first save, update with before/after on
 *     subsequent saves).
 *   - The destructive "Mark production-ready" flow (toggle
 *     `isPlaceholder: false`) flows through the same mutation; audit
 *     payload captures the diff.
 *
 * Mock-ctx pattern mirrors `expenseApprovalSettings.test.ts` —
 * hand-rolled Maps + vi.fn() stubs (the repo does not use convex-test
 * directly for these handler-level tests because the auth-helper
 * mock pattern is faster and matches the rest of the suite).
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
  getBirReceiptConfig,
  setBirReceiptConfig,
} from "../../../convex/cemeterySettings";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-05-15T12:00:00+08:00").getTime();
const USER_ID = "users:admin1";
const SESSION_ID = "authSessions:s1";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface BirConfigFixture {
  _id: string;
  _creationTime: number;
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

interface AuditInsert {
  table: string;
  row: {
    actor: string;
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
  };
}

function makeCtx(opts: {
  roles?: RoleName[];
  initial?: BirConfigFixture | null;
  authenticated?: boolean;
}) {
  const rows = new Map<string, BirConfigFixture>();
  if (opts.initial !== null && opts.initial !== undefined) {
    rows.set(opts.initial._id, opts.initial);
  }
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
    name: "Admin Reyes",
    email: "admin@example.com",
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

  const ctx = {
    db: {
      get: vi.fn(async (id: string) => {
        if (id === USER_ID) return user;
        if (id === SESSION_ID) return session;
        if (rows.has(id)) return rows.get(id);
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
        if (table === "birReceiptConfig") {
          return {
            first: async () => {
              const arr = Array.from(rows.values());
              return arr[0] ?? null;
            },
            collect: async () => Array.from(rows.values()),
            withIndex: () => ({
              first: async () => {
                const arr = Array.from(rows.values());
                return arr[0] ?? null;
              },
              collect: async () => Array.from(rows.values()),
            }),
          };
        }
        return {
          withIndex: () => ({
            collect: async (): Promise<unknown[]> => [],
            first: async (): Promise<unknown | null> => null,
          }),
        };
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "birReceiptConfig") {
          const id = `birReceiptConfig:${nextId++}`;
          rows.set(id, {
            _id: id,
            _creationTime: T0,
            ...row,
          } as BirConfigFixture);
          return id;
        }
        if (table === "auditLog") {
          auditInserts.push({ table, row: row as AuditInsert["row"] });
          return `auditLog:${auditInserts.length}`;
        }
        return `${table}:?`;
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        const existing = rows.get(id);
        if (existing === undefined) {
          throw new Error(`patch: ${id} not found`);
        }
        rows.set(id, { ...existing, ...patch } as BirConfigFixture);
      }),
    },
  };

  return { ctx, rows, auditInserts };
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

const VALID_ARGS = {
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
  isPlaceholder: true,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  mockedGetAuthUserId.mockReset();
  mockedGetAuthSessionId.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getBirReceiptConfig", () => {
  const run = handlerOf(getBirReceiptConfig);

  it("returns the row when seeded", async () => {
    const { ctx } = makeCtx({
      initial: {
        _id: "birReceiptConfig:1",
        _creationTime: T0,
        ...VALID_ARGS,
        updatedAt: T0,
        updatedBy: USER_ID,
      },
    });
    const result = await run(ctx, {});
    expect(result).not.toBeNull();
    expect((result as { registeredName: string }).registeredName).toBe(
      "Cases Land Inc.",
    );
  });

  it("returns null when no row exists", async () => {
    const { ctx } = makeCtx({});
    const result = await run(ctx, {});
    expect(result).toBeNull();
  });

  it("rejects non-admin callers", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});

describe("setBirReceiptConfig", () => {
  const run = handlerOf(setBirReceiptConfig);

  it("inserts the singleton row + emits a create audit row on first save", async () => {
    const { ctx, rows, auditInserts } = makeCtx({});
    const result = (await run(ctx, VALID_ARGS)) as { configId: string };
    expect(result.configId).toMatch(/^birReceiptConfig:/);
    expect(rows.size).toBe(1);
    const inserted = Array.from(rows.values())[0]!;
    expect(inserted.registeredName).toBe("Cases Land Inc.");
    expect(inserted.tin).toBe("123456789000");
    expect(inserted.isPlaceholder).toBe(true);
    expect(inserted.updatedBy).toBe(USER_ID);

    expect(auditInserts).toHaveLength(1);
    const audit = auditInserts[0]!.row;
    expect(audit.action).toBe("create");
    expect(audit.entityType).toBe("user");
    expect((audit.after as { kind: string }).kind).toBe("birReceiptConfig");
  });

  it("updates the existing row + emits an update audit row with before/after", async () => {
    const { ctx, auditInserts } = makeCtx({
      initial: {
        _id: "birReceiptConfig:1",
        _creationTime: T0,
        ...VALID_ARGS,
        updatedAt: T0 - 1000,
        updatedBy: USER_ID,
      },
    });
    await run(ctx, {
      ...VALID_ARGS,
      registeredName: "Cases Land Inc. (Updated)",
    });
    expect(auditInserts).toHaveLength(1);
    const audit = auditInserts[0]!.row;
    expect(audit.action).toBe("update");
    expect((audit.before as { registeredName: string }).registeredName).toBe(
      "Cases Land Inc.",
    );
    expect((audit.after as { registeredName: string }).registeredName).toBe(
      "Cases Land Inc. (Updated)",
    );
  });

  it("flips isPlaceholder to false when admin marks production-ready", async () => {
    const { ctx, rows, auditInserts } = makeCtx({
      initial: {
        _id: "birReceiptConfig:1",
        _creationTime: T0,
        ...VALID_ARGS,
        updatedAt: T0,
        updatedBy: USER_ID,
      },
    });
    await run(ctx, { ...VALID_ARGS, isPlaceholder: false });
    const updated = Array.from(rows.values())[0]!;
    expect(updated.isPlaceholder).toBe(false);
    const audit = auditInserts[0]!.row;
    expect((audit.before as { isPlaceholder: boolean }).isPlaceholder).toBe(true);
    expect((audit.after as { isPlaceholder: boolean }).isPlaceholder).toBe(false);
  });

  it("rejects non-admin callers (office_staff)", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(ctx, VALID_ARGS).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, VALID_ARGS).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("rejects empty registeredName with VALIDATION", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, {
      ...VALID_ARGS,
      registeredName: "   ",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects TIN with wrong digit count", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, {
      ...VALID_ARGS,
      tin: "12345",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("strips separators from TIN before storing", async () => {
    const { ctx, rows } = makeCtx({});
    await run(ctx, { ...VALID_ARGS, tin: "123-456-789-000" });
    expect(Array.from(rows.values())[0]!.tin).toBe("123456789000");
  });

  it("rejects empty registered address lines", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, {
      ...VALID_ARGS,
      registeredAddressLines: ["   ", ""],
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects ATP expiry more than a year in the past", async () => {
    const { ctx } = makeCtx({});
    const veryOld = T0 - 400 * 24 * 60 * 60 * 1000;
    const thrown = await run(ctx, {
      ...VALID_ARGS,
      atpExpiryDate: veryOld,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects vatRate out of range", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, {
      ...VALID_ARGS,
      vatRate: 150,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });
});
