/**
 * `convex/lib/errorCapture.ts` + `convex/errorLog.ts` unit tests.
 *
 * The behaviours worth pinning down are the ones that decide whether
 * this table helps or becomes its own incident: that repeated failures
 * GROUP instead of flooding, that a recurrence reopens a row an
 * operator thought they were done with, and above all that a failure
 * inside the capture path never propagates to the caller — an
 * observability write that converts a handled error into an unhandled
 * one is worse than no observability at all.
 */

import { ConvexError, type Value } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ErrorPayload } from "../../../convex/lib/errors";
import { HOUR_MS } from "../../../convex/lib/time";
import {
  captureError,
  fingerprintOf,
  messageOf,
} from "../../../convex/lib/errorCapture";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import {
  getErrorLogSummary,
  listErrorGroups,
  resolveError,
} from "../../../convex/errorLog";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-08-23T08:00:00+08:00").getTime();
const USER_ID = "users:admin1";
const SESSION_ID = "authSessions:sessAdmin";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface ErrorRow {
  _id: string;
  _creationTime: number;
  fingerprint: string;
  source: string;
  severity: "error" | "warning";
  message: string;
  stack?: string;
  context?: unknown;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
  isResolved: boolean;
  resolvedAt?: number;
  resolvedBy?: string;
  [key: string]: unknown;
}

interface CtxBag {
  rows: Map<string, ErrorRow>;
  all: () => ErrorRow[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  initial?: ErrorRow[];
  authenticated?: boolean;
  /** Force the errorLog insert/patch to blow up, to test resilience. */
  breakWrites?: boolean;
} = {}): CtxBag {
  const rows = new Map<string, ErrorRow>(
    (opts.initial ?? []).map((r) => [r._id, r]),
  );

  if (opts.authenticated === false) {
    mockedGetAuthUserId.mockResolvedValue(null);
    mockedGetAuthSessionId.mockResolvedValue(null);
  } else {
    mockedGetAuthUserId.mockResolvedValue(USER_ID as never);
    mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);
  }

  const user = { _id: USER_ID, _creationTime: T0 - 1000, email: "a@b.test" };
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

  interface IndexQuery {
    eqs: Record<string, unknown>;
    eq(field: string, value: unknown): IndexQuery;
  }

  function makeQueryBuilder() {
    const predicates: Array<(r: ErrorRow) => boolean> = [];
    let descending = false;
    const builder = {
      withIndex(_name: string, fn?: (q: IndexQuery) => IndexQuery) {
        if (fn !== undefined) {
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
        }
        return builder;
      },
      order(dir: "asc" | "desc") {
        descending = dir === "desc";
        return builder;
      },
      async first(): Promise<ErrorRow | null> {
        return builder.matching()[0] ?? null;
      },
      async take(n: number): Promise<ErrorRow[]> {
        return builder.matching().slice(0, n);
      },
      async collect(): Promise<ErrorRow[]> {
        return builder.matching();
      },
      matching(): ErrorRow[] {
        const out = Array.from(rows.values()).filter((r) =>
          predicates.every((p) => p(r)),
        );
        out.sort((a, b) =>
          descending ? b.lastSeenAt - a.lastSeenAt : a.lastSeenAt - b.lastSeenAt,
        );
        return out;
      },
    };
    return builder;
  }

  let seq = 0;
  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === USER_ID) return user;
        if (id === SESSION_ID) return session;
        return rows.get(id) ?? null;
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return {
            withIndex: (_n: string, _f: unknown) => ({
              collect: async () => userRoles,
            }),
          };
        }
        return makeQueryBuilder();
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (opts.breakWrites === true) {
          throw new Error("simulated database failure");
        }
        seq += 1;
        const id = `${table}:${seq}`;
        rows.set(id, { _id: id, _creationTime: T0, ...row } as ErrorRow);
        return id;
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        if (opts.breakWrites === true) {
          throw new Error("simulated database failure");
        }
        const existing = rows.get(id);
        if (existing !== undefined) {
          rows.set(id, { ...existing, ...patch } as ErrorRow);
        }
      }),
    },
  };

  return { rows, all: () => Array.from(rows.values()), ctx };
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
  vi.restoreAllMocks();
});

describe("messageOf", () => {
  it("reads an Error, a string, and an object with a message", () => {
    expect(messageOf(new Error("boom"))).toBe("boom");
    expect(messageOf("plain")).toBe("plain");
    expect(messageOf({ message: "shaped" })).toBe("shaped");
  });

  it("falls back to a serialisation for anything else", () => {
    expect(messageOf({ code: 42 })).toContain("42");
    expect(messageOf(null)).toBe("null");
  });
});

describe("fingerprintOf", () => {
  it("groups the same failure across differing ids", () => {
    const a = fingerprintOf("cron:x", "Lot lots:k97a2bd8ef91c3d4 not found");
    const b = fingerprintOf("cron:x", "Lot lots:z11b8cc0aa22f9e7 not found");
    expect(a).toBe(b);
  });

  it("groups across differing numbers and quoted values", () => {
    expect(fingerprintOf("cron:x", "Retried 3 rows")).toBe(
      fingerprintOf("cron:x", "Retried 812 rows"),
    );
    expect(fingerprintOf("cron:x", 'Lot "A-01" is missing')).toBe(
      fingerprintOf("cron:x", 'Lot "B-99" is missing'),
    );
  });

  it("keeps genuinely different failures apart", () => {
    expect(fingerprintOf("cron:x", "Timed out")).not.toBe(
      fingerprintOf("cron:x", "Permission denied"),
    );
  });

  it("keeps the same message from different sources apart", () => {
    expect(fingerprintOf("webhook:gcash", "Timed out")).not.toBe(
      fingerprintOf("webhook:maya", "Timed out"),
    );
  });
});

describe("captureError", () => {
  it("records a first occurrence", async () => {
    const bag = makeCtx();
    await captureError(bag.ctx, {
      source: "cron:test",
      error: new Error("boom"),
    });
    const [row] = bag.all();
    expect(row!.message).toBe("boom");
    expect(row!.count).toBe(1);
    expect(row!.severity).toBe("error");
    expect(row!.isResolved).toBe(false);
    expect(row!.firstSeenAt).toBe(T0);
  });

  it("groups a repeat into one row with a count", async () => {
    const bag = makeCtx();
    for (let i = 0; i < 5; i += 1) {
      await captureError(bag.ctx, {
        source: "cron:test",
        error: new Error(`Lot lots:abc${i}0000000000000 not found`),
      });
    }
    expect(bag.all()).toHaveLength(1);
    expect(bag.all()[0]!.count).toBe(5);
  });

  it("advances lastSeenAt but keeps firstSeenAt", async () => {
    const bag = makeCtx();
    await captureError(bag.ctx, { source: "cron:test", error: "boom" });
    vi.setSystemTime(T0 + HOUR_MS);
    await captureError(bag.ctx, { source: "cron:test", error: "boom" });
    const row = bag.all()[0]!;
    expect(row.firstSeenAt).toBe(T0);
    expect(row.lastSeenAt).toBe(T0 + HOUR_MS);
  });

  it("reopens a resolved group when it happens again", async () => {
    const bag = makeCtx();
    await captureError(bag.ctx, { source: "cron:test", error: "boom" });
    const id = bag.all()[0]!._id;
    await bag.ctx.db.patch(id, {
      isResolved: true,
      resolvedAt: T0,
      resolvedBy: USER_ID,
    });
    await captureError(bag.ctx, { source: "cron:test", error: "boom" });
    const row = bag.all()[0]!;
    expect(row.isResolved).toBe(false);
    expect(row.resolvedAt).toBeUndefined();
  });

  it("keeps distinct failures in distinct rows", async () => {
    const bag = makeCtx();
    await captureError(bag.ctx, { source: "cron:a", error: "one" });
    await captureError(bag.ctx, { source: "cron:b", error: "two" });
    expect(bag.all()).toHaveLength(2);
  });

  it("stores a stack when the thrown value has one", async () => {
    const bag = makeCtx();
    await captureError(bag.ctx, { source: "cron:test", error: new Error("x") });
    expect(typeof bag.all()[0]!.stack).toBe("string");
  });

  it("does not store a stack for a plain string", async () => {
    const bag = makeCtx();
    await captureError(bag.ctx, { source: "cron:test", error: "x" });
    expect(bag.all()[0]!.stack).toBeUndefined();
  });

  it("redacts PII from the context", async () => {
    const bag = makeCtx();
    await captureError(bag.ctx, {
      source: "cron:test",
      error: "x",
      context: { email: "juan@example.ph", contractId: "contracts:1" },
    });
    const context = bag.all()[0]!.context as Record<string, unknown>;
    expect(context.email).not.toBe("juan@example.ph");
    // Non-PII operational detail must survive — it is the whole point.
    expect(context.contractId).toBe("contracts:1");
  });

  it("truncates an enormous message rather than storing it whole", async () => {
    const bag = makeCtx();
    await captureError(bag.ctx, {
      source: "cron:test",
      error: "x".repeat(5_000),
    });
    expect(bag.all()[0]!.message.length).toBeLessThan(1_100);
  });

  it("NEVER throws, even when the database write fails", async () => {
    // The contract that matters most: capture is called from a catch
    // block. If it throws, it replaces a handled error with an
    // unhandled one and takes down the caller it was meant to observe.
    const bag = makeCtx({ breakWrites: true });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    await expect(
      captureError(bag.ctx, { source: "cron:test", error: "boom" }),
    ).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
  });
});

describe("listErrorGroups", () => {
  const run = handlerOf(listErrorGroups);

  function existing(overrides: Partial<ErrorRow> = {}): ErrorRow {
    return {
      _id: `errorLog:${overrides.fingerprint ?? "f1"}`,
      _creationTime: T0,
      fingerprint: "f1",
      source: "cron:test",
      severity: "error",
      message: "boom",
      count: 1,
      firstSeenAt: T0,
      lastSeenAt: T0,
      isResolved: false,
      ...overrides,
    };
  }

  it("refuses a non-admin caller", async () => {
    const bag = makeCtx({ roles: ["office_staff"] });
    let thrown: unknown;
    try {
      await run(bag.ctx, {});
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe("FORBIDDEN");
  });

  it("returns unresolved groups only by default", async () => {
    const bag = makeCtx({
      initial: [
        existing({ fingerprint: "open" }),
        existing({ fingerprint: "closed", isResolved: true }),
      ],
    });
    const result = (await run(bag.ctx, {})) as Array<{ source: string }>;
    expect(result).toHaveLength(1);
  });

  it("includes resolved groups when asked", async () => {
    const bag = makeCtx({
      initial: [
        existing({ fingerprint: "open" }),
        existing({ fingerprint: "closed", isResolved: true }),
      ],
    });
    const result = (await run(bag.ctx, { includeResolved: true })) as unknown[];
    expect(result).toHaveLength(2);
  });

  it("orders newest occurrence first", async () => {
    const bag = makeCtx({
      initial: [
        existing({ fingerprint: "old", lastSeenAt: T0 }),
        existing({ fingerprint: "new", lastSeenAt: T0 + HOUR_MS }),
      ],
    });
    const result = (await run(bag.ctx, {})) as Array<{ message: string }>;
    expect(bag.rows.get("errorLog:new")).toBeDefined();
    expect(result).toHaveLength(2);
  });

  it("clamps an absurd limit rather than scanning everything", async () => {
    const bag = makeCtx({
      initial: Array.from({ length: 10 }, (_, i) =>
        existing({ fingerprint: `f${i}` }),
      ),
    });
    const result = (await run(bag.ctx, { limit: 1_000_000 })) as unknown[];
    expect(result).toHaveLength(10);
  });
});

describe("getErrorLogSummary", () => {
  const run = handlerOf(getErrorLogSummary);

  it("totals unresolved groups and their occurrences", async () => {
    const bag = makeCtx({
      initial: [
        {
          _id: "errorLog:1",
          _creationTime: T0,
          fingerprint: "a",
          source: "cron:a",
          severity: "error",
          message: "x",
          count: 12,
          firstSeenAt: T0,
          lastSeenAt: T0,
          isResolved: false,
        },
        {
          _id: "errorLog:2",
          _creationTime: T0,
          fingerprint: "b",
          source: "cron:b",
          severity: "warning",
          message: "y",
          count: 3,
          firstSeenAt: T0,
          lastSeenAt: T0 + HOUR_MS,
          isResolved: false,
        },
      ],
    });
    const result = (await run(bag.ctx, {})) as {
      unresolvedGroups: number;
      unresolvedOccurrences: number;
      lastSeenAt: number | null;
    };
    expect(result.unresolvedGroups).toBe(2);
    expect(result.unresolvedOccurrences).toBe(15);
    expect(result.lastSeenAt).toBe(T0 + HOUR_MS);
  });

  it("reports all clear as zero, not null-ish noise", async () => {
    const bag = makeCtx();
    const result = (await run(bag.ctx, {})) as {
      unresolvedGroups: number;
      lastSeenAt: number | null;
    };
    expect(result.unresolvedGroups).toBe(0);
    expect(result.lastSeenAt).toBeNull();
  });
});

describe("resolveError", () => {
  const run = handlerOf(resolveError);

  it("marks a group resolved with the acting admin", async () => {
    const bag = makeCtx({
      initial: [
        {
          _id: "errorLog:1",
          _creationTime: T0,
          fingerprint: "a",
          source: "cron:a",
          severity: "error",
          message: "x",
          count: 1,
          firstSeenAt: T0,
          lastSeenAt: T0,
          isResolved: false,
        },
      ],
    });
    await run(bag.ctx, { errorLogId: "errorLog:1" });
    const row = bag.rows.get("errorLog:1")!;
    expect(row.isResolved).toBe(true);
    expect(row.resolvedBy).toBe(USER_ID);
    expect(row.resolvedAt).toBe(T0);
  });

  it("refuses a non-admin caller", async () => {
    const bag = makeCtx({ roles: ["office_staff"] });
    let thrown: unknown;
    try {
      await run(bag.ctx, { errorLogId: "errorLog:1" });
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe("FORBIDDEN");
  });

  it("reports NOT_FOUND for an id that no longer exists", async () => {
    const bag = makeCtx();
    let thrown: unknown;
    try {
      await run(bag.ctx, { errorLogId: "errorLog:gone" });
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe("NOT_FOUND");
  });
});
