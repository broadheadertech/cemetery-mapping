/**
 * Story 6.4 — `convex/exports.ts` unit tests.
 *
 * Hand-mocked-ctx pattern (mirrors `expenseApprovalSettings.test.ts`).
 *
 * Coverage:
 *   - Auth gates on every public surface.
 *   - `requestExport` inserts a pending row + schedules the action +
 *     emits a `read_pii` audit row.
 *   - `listMyExports` orders most-recent-first + scopes to caller.
 *   - `getExportById` returns null for cross-owner reads.
 *   - `getExportDownloadUrl` only returns a URL for `ready` rows owned
 *     by the caller; increments `downloadCount`.
 *   - `internal_markReady` flips status to `ready` + sets blobId.
 *   - `internal_markFailed` increments `retryCount` + sets `lastError`.
 *   - `internal_retrySweep` only reschedules rows under the retry cap.
 *   - `internal_cleanupSweep` only marks expired rows + persists the
 *     row (does NOT delete it).
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
import {
  getExportById,
  getExportDownloadUrl,
  internal_cleanupSweep,
  internal_markFailed,
  internal_markReady,
  internal_retrySweep,
  listMyExports,
  MAX_RETRY_COUNT,
  requestExport,
} from "../../../convex/exports";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-05-15T12:00:00+08:00").getTime();
const USER_ID = "users:admin1";
const OTHER_USER_ID = "users:admin2";
const SESSION_ID = "authSessions:s1";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface ExportFixture {
  _id: string;
  _creationTime: number;
  reportType: "sales_by_dimension" | "ar_aging" | "audit_log";
  args: unknown;
  format: "xlsx" | "pdf";
  status: "pending" | "ready" | "failed" | "expired";
  blobId?: string;
  requestedBy: string;
  requestedAt: number;
  readyAt?: number;
  downloadCount: number;
  retryCount: number;
  lastError?: string;
  scheduledAt?: number;
}

interface AuditInsert {
  row: {
    actor: string;
    action: string;
    entityType: string;
    entityId: string;
    after?: unknown;
  };
}

interface SchedulerCall {
  fn: unknown;
  args: Record<string, unknown>;
}

interface StorageCall {
  op: "delete" | "getUrl";
  blobId: string;
}

interface CtxBag {
  exports: Map<string, ExportFixture>;
  audits: AuditInsert[];
  scheduled: SchedulerCall[];
  storageCalls: StorageCall[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  caller?: string;
  exports?: ExportFixture[];
  authenticated?: boolean;
  storageUrls?: Record<string, string | null>;
  /**
   * When supplied, the mock's `ctx.storage.delete` will throw for any
   * blobId in this set. P1-5 cleanup test wires this to verify the
   * row still moves to `expired`.
   */
  failDeleteForBlobIds?: string[];
}): CtxBag {
  const exports = new Map<string, ExportFixture>(
    (opts.exports ?? []).map((e) => [e._id, e]),
  );
  const audits: AuditInsert[] = [];
  const scheduled: SchedulerCall[] = [];
  const storageCalls: StorageCall[] = [];
  const storageUrls = opts.storageUrls ?? {};
  const callerId = opts.caller ?? USER_ID;

  if (opts.authenticated === false) {
    mockedGetAuthUserId.mockResolvedValue(null);
    mockedGetAuthSessionId.mockResolvedValue(null);
  } else {
    mockedGetAuthUserId.mockResolvedValue(callerId as never);
    mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);
  }

  const user = {
    _id: callerId,
    _creationTime: T0 - 1000,
    name: "Admin Reyes",
    email: "admin@example.com",
  };
  const session = {
    _id: SESSION_ID,
    _creationTime: T0,
    userId: callerId,
    expirationTime: T0 + 30 * DAY_MS,
  };
  const userRoles = (opts.roles ?? ["admin"]).map((role, idx) => ({
    _id: `userRoles:${idx}`,
    _creationTime: T0,
    userId: callerId,
    role,
    grantedAt: T0,
    grantedBy: callerId,
  }));

  let nextId = exports.size + 1;

  interface IndexQuery {
    eqs: Record<string, unknown>;
    eq(field: string, value: unknown): IndexQuery;
  }
  interface ChainState {
    predicates: Array<(r: ExportFixture) => boolean>;
    order?: "asc" | "desc";
  }

  function makeExportsQueryBuilder() {
    const state: ChainState = { predicates: [] };
    const builder = {
      withIndex(_idx: string, fn?: (q: IndexQuery) => IndexQuery) {
        if (fn !== undefined) {
          const q: IndexQuery = {
            eqs: {},
            eq(field, value) {
              this.eqs[field] = value;
              return this;
            },
          };
          fn(q);
          for (const [field, value] of Object.entries(q.eqs)) {
            state.predicates.push(
              (r) => (r as unknown as Record<string, unknown>)[field] === value,
            );
          }
        }
        return builder;
      },
      order(dir: "asc" | "desc") {
        state.order = dir;
        return builder;
      },
      async collect() {
        let rows = Array.from(exports.values()).filter((r) =>
          state.predicates.every((p) => p(r)),
        );
        if (state.order === "desc") {
          rows = rows.sort((a, b) => b.requestedAt - a.requestedAt);
        }
        return rows;
      },
      async take(n: number) {
        let rows = Array.from(exports.values()).filter((r) =>
          state.predicates.every((p) => p(r)),
        );
        if (state.order === "desc") {
          rows = rows.sort((a, b) => b.requestedAt - a.requestedAt);
        } else if (state.order === "asc") {
          rows = rows.sort((a, b) => a.requestedAt - b.requestedAt);
        }
        return rows.slice(0, n);
      },
      async first(): Promise<ExportFixture | null> {
        const all = Array.from(exports.values()).filter((r) =>
          state.predicates.every((p) => p(r)),
        );
        return all[0] ?? null;
      },
    };
    return builder;
  }

  const ctx = {
    db: {
      get: vi.fn(async (id: string) => {
        if (id === callerId) return user;
        if (id === SESSION_ID) return session;
        if (exports.has(id)) return exports.get(id);
        return null;
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return {
            withIndex: () => ({ collect: async () => userRoles }),
          };
        }
        if (table === "exports") {
          return makeExportsQueryBuilder();
        }
        return {
          collect: async (): Promise<unknown[]> => [],
          first: async (): Promise<unknown | null> => null,
          withIndex: () => ({
            collect: async (): Promise<unknown[]> => [],
            first: async (): Promise<unknown | null> => null,
          }),
        };
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "exports") {
          const id = `exports:${nextId++}`;
          exports.set(id, {
            _id: id,
            _creationTime: T0,
            ...row,
          } as ExportFixture);
          return id;
        }
        if (table === "auditLog") {
          audits.push({ row: row as AuditInsert["row"] });
          return `auditLog:${audits.length}`;
        }
        return `${table}:?`;
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        const existing = exports.get(id);
        if (existing !== undefined) {
          exports.set(id, { ...existing, ...patch } as ExportFixture);
        }
        return null;
      }),
    },
    scheduler: {
      runAfter: vi.fn(
        async (
          _delay: number,
          fn: unknown,
          args: Record<string, unknown>,
        ) => {
          scheduled.push({ fn, args });
          return "scheduledId:1";
        },
      ),
    },
    storage: {
      getUrl: vi.fn(async (blobId: string) => {
        storageCalls.push({ op: "getUrl", blobId });
        return storageUrls[blobId] ?? null;
      }),
      delete: vi.fn(async (blobId: string) => {
        storageCalls.push({ op: "delete", blobId });
        if (
          opts.failDeleteForBlobIds !== undefined &&
          opts.failDeleteForBlobIds.includes(blobId)
        ) {
          throw new Error(`simulated storage.delete failure for ${blobId}`);
        }
        return null;
      }),
    },
  };

  return { exports, audits, scheduled, storageCalls, ctx };
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

function makeExport(
  overrides: Partial<ExportFixture> = {},
): ExportFixture {
  return {
    _id: overrides._id ?? "exports:fixture",
    _creationTime: T0,
    reportType: "sales_by_dimension",
    args: { from: T0 - 14 * DAY_MS, to: T0 },
    format: "pdf",
    status: "pending",
    requestedBy: USER_ID,
    requestedAt: T0,
    downloadCount: 0,
    retryCount: 0,
    ...overrides,
  };
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

describe("requestExport", () => {
  const run = handlerOf(requestExport);

  it("admin creates a pending row + schedules action + emits audit", async () => {
    const { ctx, exports, scheduled, audits } = makeCtx({ roles: ["admin"] });
    const result = (await run(ctx, {
      reportType: "sales_by_dimension",
      args: { from: T0 - 14 * DAY_MS, to: T0 },
      format: "pdf",
    })) as { exportId: string };

    expect(exports.size).toBe(1);
    const row = exports.get(result.exportId)!;
    expect(row.status).toBe("pending");
    expect(row.reportType).toBe("sales_by_dimension");
    expect(row.format).toBe("pdf");
    expect(row.requestedBy).toBe(USER_ID);
    expect(row.downloadCount).toBe(0);
    expect(row.retryCount).toBe(0);

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.args.exportId).toBe(result.exportId);

    expect(audits).toHaveLength(1);
    expect(audits[0]!.row.action).toBe("read_pii");
    expect(audits[0]!.row.entityType).toBe("piiAccess");
    expect(audits[0]!.row.after).toMatchObject({
      kind: "reportExport",
      reportType: "sales_by_dimension",
      format: "pdf",
    });
  });

  it("rejects office_staff with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(ctx, {
      reportType: "ar_aging",
      args: {},
      format: "xlsx",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {
      reportType: "ar_aging",
      args: {},
      format: "xlsx",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});

describe("listMyExports", () => {
  const run = handlerOf(listMyExports);

  it("returns the caller's exports most-recent-first", async () => {
    const fix1 = makeExport({
      _id: "exports:1",
      requestedAt: T0 - 2 * HOUR_MS,
    });
    const fix2 = makeExport({
      _id: "exports:2",
      requestedAt: T0 - HOUR_MS,
    });
    const otherFix = makeExport({
      _id: "exports:3",
      requestedAt: T0 - 30 * 60 * 1000,
      requestedBy: OTHER_USER_ID,
    });
    const { ctx } = makeCtx({
      roles: ["admin"],
      exports: [fix1, fix2, otherFix],
    });
    const result = (await run(ctx, {})) as { exports: Array<{ _id: string }> };
    expect(result.exports.map((r) => r._id)).toEqual([
      "exports:2",
      "exports:1",
    ]);
  });

  it("rejects non-admin", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("getExportById", () => {
  const run = handlerOf(getExportById);

  it("returns the caller's own export", async () => {
    const fix = makeExport({ _id: "exports:1" });
    const { ctx } = makeCtx({ roles: ["admin"], exports: [fix] });
    const result = (await run(ctx, { exportId: "exports:1" })) as {
      _id: string;
    } | null;
    expect(result?._id).toBe("exports:1");
  });

  it("returns null for another admin's export (defense in depth)", async () => {
    const fix = makeExport({
      _id: "exports:1",
      requestedBy: OTHER_USER_ID,
    });
    const { ctx } = makeCtx({ roles: ["admin"], exports: [fix] });
    const result = await run(ctx, { exportId: "exports:1" });
    expect(result).toBeNull();
  });

  it("returns null for missing row", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const result = await run(ctx, { exportId: "exports:nope" });
    expect(result).toBeNull();
  });
});

describe("getExportDownloadUrl", () => {
  const run = handlerOf(getExportDownloadUrl);

  it("returns the signed URL + increments downloadCount on ready rows", async () => {
    const fix = makeExport({
      _id: "exports:1",
      status: "ready",
      blobId: "_storage:blob1",
      readyAt: T0,
    });
    const { ctx, exports } = makeCtx({
      roles: ["admin"],
      exports: [fix],
      storageUrls: { "_storage:blob1": "https://example.com/sig" },
    });
    const result = (await run(ctx, { exportId: "exports:1" })) as {
      url: string | null;
    };
    expect(result.url).toBe("https://example.com/sig");
    expect(exports.get("exports:1")!.downloadCount).toBe(1);
  });

  it("returns null when row is not ready", async () => {
    const fix = makeExport({ _id: "exports:1", status: "pending" });
    const { ctx } = makeCtx({ roles: ["admin"], exports: [fix] });
    const result = (await run(ctx, { exportId: "exports:1" })) as {
      url: string | null;
    };
    expect(result.url).toBeNull();
  });

  it("returns null for cross-owner read", async () => {
    const fix = makeExport({
      _id: "exports:1",
      status: "ready",
      blobId: "_storage:blob1",
      requestedBy: OTHER_USER_ID,
    });
    const { ctx } = makeCtx({
      roles: ["admin"],
      exports: [fix],
      storageUrls: { "_storage:blob1": "https://example.com/sig" },
    });
    const result = (await run(ctx, { exportId: "exports:1" })) as {
      url: string | null;
    };
    expect(result.url).toBeNull();
  });

  it("rejects non-admin", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(ctx, { exportId: "exports:1" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("internal_markReady", () => {
  const run = handlerOf(internal_markReady);

  it("flips status to ready + sets blobId + readyAt", async () => {
    const fix = makeExport({ _id: "exports:1", status: "pending" });
    const { ctx, exports } = makeCtx({ exports: [fix] });
    await run(ctx, {
      exportId: "exports:1",
      blobId: "_storage:blob1",
    });
    const after = exports.get("exports:1")!;
    expect(after.status).toBe("ready");
    expect(after.blobId).toBe("_storage:blob1");
    expect(after.readyAt).toBe(T0);
  });
});

describe("internal_markFailed", () => {
  const run = handlerOf(internal_markFailed);

  it("flips status to failed + bumps retryCount + sets lastError", async () => {
    const fix = makeExport({
      _id: "exports:1",
      status: "pending",
      retryCount: 1,
    });
    const { ctx, exports } = makeCtx({ exports: [fix] });
    await run(ctx, { exportId: "exports:1", error: "PDF render exploded" });
    const after = exports.get("exports:1")!;
    expect(after.status).toBe("failed");
    expect(after.retryCount).toBe(2);
    expect(after.lastError).toBe("PDF render exploded");
  });
});

describe("internal_retrySweep", () => {
  const run = handlerOf(internal_retrySweep);

  it("reschedules failed rows under the retry cap; skips ancient rows", async () => {
    const recent = makeExport({
      _id: "exports:1",
      status: "failed",
      retryCount: 1,
      requestedAt: T0 - 30 * 60 * 1000, // 30 min ago
    });
    const capped = makeExport({
      _id: "exports:2",
      status: "failed",
      retryCount: MAX_RETRY_COUNT, // at the cap
      requestedAt: T0 - 30 * 60 * 1000,
    });
    const ancient = makeExport({
      _id: "exports:3",
      status: "failed",
      retryCount: 0,
      requestedAt: T0 - 2 * HOUR_MS, // > 1h ago
    });
    const pending = makeExport({
      _id: "exports:4",
      status: "pending",
      retryCount: 0,
      requestedAt: T0 - 10 * 60 * 1000,
    });
    const { ctx, scheduled, exports } = makeCtx({
      exports: [recent, capped, ancient, pending],
    });
    const result = (await run(ctx, {})) as { retried: number; skipped: number };
    expect(result.retried).toBe(2);
    expect(scheduled.map((s) => s.args.exportId).sort()).toEqual([
      "exports:1",
      "exports:4",
    ]);
    expect(exports.get("exports:1")!.status).toBe("pending");
    // P1-3: scheduledAt claim stamped on each rescheduled row.
    expect(exports.get("exports:1")!.scheduledAt).toBe(T0);
    expect(exports.get("exports:4")!.scheduledAt).toBe(T0);
  });

  it("does not double-schedule when invoked twice back-to-back (P1-3)", async () => {
    // First sweep: pending row with no scheduledAt → gets scheduled
    // and the row picks up `scheduledAt = T0`. Second sweep: same row
    // is still pending but `scheduledAt` is fresh, so the sweep skips
    // it (the in-flight action is presumed working).
    const stuck = makeExport({
      _id: "exports:1",
      status: "pending",
      retryCount: 0,
      requestedAt: T0 - 10 * 60 * 1000,
    });
    const { ctx, scheduled, exports } = makeCtx({ exports: [stuck] });
    const firstResult = (await run(ctx, {})) as {
      retried: number;
      skipped: number;
    };
    expect(firstResult.retried).toBe(1);
    expect(scheduled).toHaveLength(1);
    expect(exports.get("exports:1")!.scheduledAt).toBe(T0);

    // Second sweep, simulated to fire moments later (claim window still
    // fresh) — should NOT schedule another action invocation.
    const secondResult = (await run(ctx, {})) as {
      retried: number;
      skipped: number;
    };
    expect(secondResult.retried).toBe(0);
    expect(secondResult.skipped).toBe(1);
    expect(scheduled).toHaveLength(1);
  });
});

describe("internal_cleanupSweep", () => {
  const run = handlerOf(internal_cleanupSweep);

  it("marks ready rows older than 30 days as expired; preserves the row", async () => {
    const old = makeExport({
      _id: "exports:1",
      status: "ready",
      blobId: "_storage:blob1",
      readyAt: T0 - 31 * DAY_MS,
    });
    const recent = makeExport({
      _id: "exports:2",
      status: "ready",
      blobId: "_storage:blob2",
      readyAt: T0 - 1 * DAY_MS,
    });
    const { ctx, exports, storageCalls } = makeCtx({
      exports: [old, recent],
    });
    const result = (await run(ctx, {})) as { expired: number };
    expect(result.expired).toBe(1);
    const after = exports.get("exports:1")!;
    expect(after.status).toBe("expired");
    expect(after.blobId).toBeUndefined();
    // Row stays — audit trail preservation.
    expect(exports.size).toBe(2);
    expect(
      storageCalls.find(
        (c) => c.op === "delete" && c.blobId === "_storage:blob1",
      ),
    ).toBeDefined();
  });

  it("still flips the row to expired when storage.delete throws (P1-5)", async () => {
    const old = makeExport({
      _id: "exports:1",
      status: "ready",
      blobId: "_storage:blob1",
      readyAt: T0 - 31 * DAY_MS,
    });
    const { ctx, exports, storageCalls } = makeCtx({
      exports: [old],
      failDeleteForBlobIds: ["_storage:blob1"],
    });
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const result = (await run(ctx, {})) as { expired: number; skipped: number };
    errorSpy.mockRestore();
    // Storage delete was attempted (and threw); the row is still
    // patched to `expired` so getExportDownloadUrl stops minting URLs.
    expect(
      storageCalls.find(
        (c) => c.op === "delete" && c.blobId === "_storage:blob1",
      ),
    ).toBeDefined();
    expect(result.expired).toBe(1);
    const after = exports.get("exports:1")!;
    expect(after.status).toBe("expired");
    expect(after.blobId).toBeUndefined();
  });
});

describe("requestExport — retry cap (P1-4)", () => {
  const run = handlerOf(requestExport);

  it("rejects with INVARIANT_VIOLATION when a prior failed row for the same reportType is at the cap", async () => {
    const cappedFailure = makeExport({
      _id: "exports:capped",
      reportType: "sales_by_dimension",
      status: "failed",
      retryCount: MAX_RETRY_COUNT,
      requestedBy: USER_ID,
      requestedAt: T0 - HOUR_MS,
    });
    const { ctx } = makeCtx({
      roles: ["admin"],
      exports: [cappedFailure],
    });
    const thrown = await run(ctx, {
      reportType: "sales_by_dimension",
      args: { from: T0 - 14 * DAY_MS, to: T0 },
      format: "pdf",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("admits a fresh request when prior failed row is for a DIFFERENT reportType", async () => {
    const otherCapped = makeExport({
      _id: "exports:other",
      reportType: "ar_aging",
      status: "failed",
      retryCount: MAX_RETRY_COUNT,
      requestedBy: USER_ID,
      requestedAt: T0 - HOUR_MS,
    });
    const { ctx, exports } = makeCtx({
      roles: ["admin"],
      exports: [otherCapped],
    });
    const result = (await run(ctx, {
      reportType: "sales_by_dimension",
      args: { from: T0 - 14 * DAY_MS, to: T0 },
      format: "pdf",
    })) as { exportId: string };
    expect(exports.get(result.exportId)).toBeDefined();
  });
});

describe("requestExport — args validator (P1-6)", () => {
  const run = handlerOf(requestExport);

  it("rejects sales_by_dimension missing from/to", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const thrown = await run(ctx, {
      reportType: "sales_by_dimension",
      args: {},
      format: "pdf",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("rejects sales_by_dimension when from > to", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const thrown = await run(ctx, {
      reportType: "sales_by_dimension",
      args: { from: T0, to: T0 - 1 },
      format: "pdf",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("rejects audit_log args with a non-numeric from", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const thrown = await run(ctx, {
      reportType: "audit_log",
      args: { from: "yesterday" },
      format: "xlsx",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("accepts ar_aging with an empty args bag", async () => {
    const { ctx, exports } = makeCtx({ roles: ["admin"] });
    const result = (await run(ctx, {
      reportType: "ar_aging",
      args: {},
      format: "pdf",
    })) as { exportId: string };
    expect(exports.get(result.exportId)).toBeDefined();
  });

  it("persists a sanitized argsSummary (no opaque keys) in the audit row", async () => {
    const { ctx, audits } = makeCtx({ roles: ["admin"] });
    await run(ctx, {
      reportType: "audit_log",
      args: { from: T0 - DAY_MS, to: T0, malicious: "<script>" },
      format: "xlsx",
    });
    expect(audits).toHaveLength(1);
    const after = audits[0]!.row.after as Record<string, unknown>;
    expect(after.argsSummary).toBeDefined();
    const summary = after.argsSummary as Record<string, unknown>;
    expect(summary.from).toBe(T0 - DAY_MS);
    expect(summary.to).toBe(T0);
    expect(summary.malicious).toBeUndefined();
  });
});
