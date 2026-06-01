/**
 * Story 4.6 — `convex/expenses.ts` unit tests.
 *
 * Hand-mocked-ctx pattern (same as `conditionLogs.test.ts`). Covers
 * the recordExpense mutation's auth, validation, idempotency, audit
 * emission, the photo upload-URL action, the photo URL read, the
 * recent-list query, and the MTD aggregate.
 *
 * Coverage target: NFR-M2 ≥ 90% on financial-touching code; expenses
 * affect the owner dashboard's MTD / net-position tiles.
 */

import { ConvexError, type Value } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCode, type ErrorPayload } from "../../../convex/lib/errors";
import { DAY_MS, HOUR_MS } from "../../../convex/lib/time";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import {
  generateExpensePhotoUploadUrl,
  getActiveCategoriesForForm,
  getExpense,
  getExpensePhotoUrl,
  getExpensesMtdTotal,
  listRecentExpenses,
  recordExpense,
} from "../../../convex/expenses";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

// 2026-05-15 noon Manila — middle of May 2026 so backdate windows have
// room in both directions.
const T0 = new Date("2026-05-15T12:00:00+08:00").getTime();
const USER_ID = "users:abc123";
const SESSION_ID = "authSessions:def456";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface ExpenseFixture {
  _id: string;
  _creationTime: number;
  paidAt: number;
  amountCents: number;
  vendor: string;
  category: string;
  photoStorageId?: string;
  recordedBy: string;
  recordedAt: number;
  idempotencyKey?: string;
  approvalStatus?: "approved" | "pending_approval" | "rejected";
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

interface CtxBag {
  expenses: Map<string, ExpenseFixture>;
  auditInserts: AuditInsert[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  initialExpenses?: ExpenseFixture[];
  authenticated?: boolean;
  storageUrls?: Record<string, string | null>;
}): CtxBag {
  const expenses = new Map<string, ExpenseFixture>(
    (opts.initialExpenses ?? []).map((e) => [e._id, e]),
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
    ranges: Array<{ field: string; op: "gte" | "lte"; value: number }>;
    eq(field: string, value: unknown): IndexQuery;
    gte(field: string, value: number): IndexQuery;
    lte(field: string, value: number): IndexQuery;
  }

  function makeExpensesQueryBuilder() {
    type Predicate = (r: ExpenseFixture) => boolean;
    const predicates: Predicate[] = [];
    let orderDesc = false;
    let indexKey: string | null = null;

    const builder = {
      withIndex(indexName: string, fn?: (q: IndexQuery) => IndexQuery) {
        indexKey = indexName;
        if (fn !== undefined) {
          const q: IndexQuery = {
            eqs: {},
            ranges: [],
            eq(field, value) {
              this.eqs[field] = value;
              return this;
            },
            gte(field, value) {
              this.ranges.push({ field, op: "gte", value });
              return this;
            },
            lte(field, value) {
              this.ranges.push({ field, op: "lte", value });
              return this;
            },
          };
          fn(q);
          for (const [field, value] of Object.entries(q.eqs)) {
            predicates.push(
              (r) =>
                (r as unknown as Record<string, unknown>)[field] === value,
            );
          }
          for (const range of q.ranges) {
            if (range.op === "gte") {
              predicates.push((r) => {
                const v = (r as unknown as Record<string, unknown>)[
                  range.field
                ];
                return typeof v === "number" && v >= range.value;
              });
            } else {
              predicates.push((r) => {
                const v = (r as unknown as Record<string, unknown>)[
                  range.field
                ];
                return typeof v === "number" && v <= range.value;
              });
            }
          }
        }
        return builder;
      },
      order(direction: "asc" | "desc") {
        orderDesc = direction === "desc";
        return builder;
      },
      async take(limit: number) {
        let rows = Array.from(expenses.values()).filter((r) =>
          predicates.every((p) => p(r)),
        );
        if (indexKey === "by_paidAt") {
          rows = rows.sort((a, b) =>
            orderDesc ? b.paidAt - a.paidAt : a.paidAt - b.paidAt,
          );
        }
        return rows.slice(0, limit);
      },
      async collect() {
        return Array.from(expenses.values()).filter((r) =>
          predicates.every((p) => p(r)),
        );
      },
      async first(): Promise<ExpenseFixture | null> {
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
        if (expenses.has(id)) return expenses.get(id);
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
        if (table === "expenses") {
          return makeExpensesQueryBuilder();
        }
        // Default table mock. Story 4.7's `assertValidCategory` calls
        // `.query("expenseCategories")` with and without `.withIndex(...)`
        // chained — we expose both shapes so the bootstrap fallback path
        // (table empty → returns hardcoded defaults) compiles cleanly in
        // tests that don't seed the table.
        return {
          withIndex: () => ({
            collect: async (): Promise<unknown[]> => [],
            first: async (): Promise<unknown | null> => null,
            take: async (): Promise<unknown[]> => [],
          }),
          first: async (): Promise<unknown | null> => null,
          collect: async (): Promise<unknown[]> => [],
          take: async (): Promise<unknown[]> => [],
        };
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "expenses") {
          const id = `expenses:${nextId++}`;
          expenses.set(id, {
            _id: id,
            _creationTime: T0,
            ...row,
          } as ExpenseFixture);
          return id;
        }
        if (table === "auditLog") {
          auditInserts.push({ table, row: row as AuditInsert["row"] });
          return `auditLog:${auditInserts.length}`;
        }
        return `${table}:?`;
      }),
    },
    storage: {
      generateUploadUrl: vi.fn(async () => "https://example/upload/exp"),
      getUrl: vi.fn(async (sid: string) => {
        const map = opts.storageUrls ?? {};
        return map[sid] ?? `https://example/signed/${sid}`;
      }),
    },
  };

  return { expenses, auditInserts, ctx };
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

describe("recordExpense", () => {
  const run = handlerOf(recordExpense);

  it("inserts an expense, emits audit, and returns the new id (office_staff)", async () => {
    const { ctx, expenses, auditInserts } = makeCtx({
      roles: ["office_staff"],
    });
    const result = (await run(ctx, {
      paidAt: T0,
      amountCents: 250_000,
      vendor: "Meralco",
      category: "Utilities",
      idempotencyKey: "uuid-1",
    })) as { expenseId: string };

    expect(expenses.size).toBe(1);
    const row = expenses.get(result.expenseId)!;
    expect(row.amountCents).toBe(250_000);
    expect(row.vendor).toBe("Meralco");
    expect(row.category).toBe("Utilities");
    expect(row.recordedBy).toBe(USER_ID);
    expect(row.recordedAt).toBe(T0);
    expect(row.approvalStatus).toBe("approved");

    expect(auditInserts).toHaveLength(1);
    const audit = auditInserts[0]!;
    expect(audit.row.action).toBe("create");
    expect(audit.row.entityType).toBe("expense");
    expect(audit.row.entityId).toBe(result.expenseId);
    expect(audit.row.after).toMatchObject({
      amountCents: 250_000,
      vendor: "Meralco",
      category: "Utilities",
      hasPhoto: false,
    });
  });

  it("stores the photoStorageId when provided and reports hasPhoto in audit", async () => {
    const { ctx, expenses, auditInserts } = makeCtx({});
    const result = (await run(ctx, {
      paidAt: T0,
      amountCents: 50_000,
      vendor: "Hardware",
      category: "Maintenance",
      photoStorageId: "_storage:p1",
      idempotencyKey: "uuid-p",
    })) as { expenseId: string };
    const row = expenses.get(result.expenseId)!;
    expect(row.photoStorageId).toBe("_storage:p1");
    expect(auditInserts[0]!.row.after).toMatchObject({ hasPhoto: true });
  });

  it("allows admin to record an expense", async () => {
    const { ctx, expenses } = makeCtx({ roles: ["admin"] });
    await run(ctx, {
      paidAt: T0,
      amountCents: 10_000,
      vendor: "Misc",
      category: "Other",
      idempotencyKey: "k-admin",
    });
    expect(expenses.size).toBe(1);
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    const thrown = await run(ctx, {
      paidAt: T0,
      amountCents: 10_000,
      vendor: "x",
      category: "Other",
      idempotencyKey: "k-fw",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects customer with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["customer"] });
    const thrown = await run(ctx, {
      paidAt: T0,
      amountCents: 10_000,
      vendor: "x",
      category: "Other",
      idempotencyKey: "k-cust",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {
      paidAt: T0,
      amountCents: 10_000,
      vendor: "x",
      category: "Other",
      idempotencyKey: "k-unauth",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("rejects amountCents <= 0 with VALIDATION", async () => {
    const { ctx } = makeCtx({});
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const thrown = await run(ctx, {
        paidAt: T0,
        amountCents: bad,
        vendor: "x",
        category: "Other",
        idempotencyKey: `k-${bad}`,
      }).catch((e) => e);
      expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    }
  });

  it("rejects empty or oversized vendor with VALIDATION", async () => {
    const { ctx } = makeCtx({});
    for (const vendor of ["", "   ", "v".repeat(201)]) {
      const thrown = await run(ctx, {
        paidAt: T0,
        amountCents: 10_000,
        vendor,
        category: "Other",
        idempotencyKey: `k-${vendor.length}`,
      }).catch((e) => e);
      expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    }
  });

  it("rejects an unknown category with VALIDATION", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, {
      paidAt: T0,
      amountCents: 10_000,
      vendor: "x",
      category: "Bribe Fund",
      idempotencyKey: "k-bad-cat",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects future-dated paidAt with VALIDATION", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, {
      paidAt: T0 + DAY_MS,
      amountCents: 10_000,
      vendor: "x",
      category: "Other",
      idempotencyKey: "k-future",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects office_staff backdating beyond 7 days with VALIDATION", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(ctx, {
      paidAt: T0 - 8 * DAY_MS,
      amountCents: 10_000,
      vendor: "x",
      category: "Other",
      idempotencyKey: "k-old-staff",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("admin can backdate up to 30 days but not 31", async () => {
    {
      const { ctx, expenses } = makeCtx({ roles: ["admin"] });
      await run(ctx, {
        paidAt: T0 - 29 * DAY_MS,
        amountCents: 10_000,
        vendor: "x",
        category: "Other",
        idempotencyKey: "k-admin-29",
      });
      expect(expenses.size).toBe(1);
    }
    {
      const { ctx } = makeCtx({ roles: ["admin"] });
      const thrown = await run(ctx, {
        paidAt: T0 - 31 * DAY_MS,
        amountCents: 10_000,
        vendor: "x",
        category: "Other",
        idempotencyKey: "k-admin-31",
      }).catch((e) => e);
      expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    }
  });

  it("dedupes by idempotencyKey — second call returns the same id", async () => {
    const { ctx, expenses, auditInserts } = makeCtx({});
    const r1 = (await run(ctx, {
      paidAt: T0,
      amountCents: 10_000,
      vendor: "x",
      category: "Other",
      idempotencyKey: "stable-uuid",
    })) as { expenseId: string };
    const r2 = (await run(ctx, {
      paidAt: T0,
      amountCents: 99_999,
      vendor: "different",
      category: "Other",
      idempotencyKey: "stable-uuid",
    })) as { expenseId: string };
    expect(r1.expenseId).toBe(r2.expenseId);
    expect(expenses.size).toBe(1);
    expect(auditInserts).toHaveLength(1);
  });

  it("treats missing idempotency key as no-dedup", async () => {
    const { ctx, expenses } = makeCtx({});
    await run(ctx, {
      paidAt: T0,
      amountCents: 1000,
      vendor: "a",
      category: "Other",
    });
    await run(ctx, {
      paidAt: T0,
      amountCents: 2000,
      vendor: "b",
      category: "Other",
    });
    expect(expenses.size).toBe(2);
  });
});

describe("generateExpensePhotoUploadUrl", () => {
  const run = handlerOf(generateExpensePhotoUploadUrl);

  it("returns a short-lived upload URL for office_staff", async () => {
    const { ctx } = makeCtx({});
    const url = (await run(ctx, {})) as string;
    expect(url).toBe("https://example/upload/exp");
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});

describe("getExpensePhotoUrl", () => {
  const run = handlerOf(getExpensePhotoUrl);

  it("returns the signed URL when the expense has a photo", async () => {
    const exp: ExpenseFixture = {
      _id: "expenses:photo",
      _creationTime: T0,
      paidAt: T0,
      amountCents: 1000,
      vendor: "x",
      category: "Other",
      photoStorageId: "_storage:e1",
      recordedBy: USER_ID,
      recordedAt: T0,
    };
    const { ctx } = makeCtx({
      initialExpenses: [exp],
      storageUrls: { "_storage:e1": "https://signed/e1" },
    });
    const url = await run(ctx, { expenseId: exp._id });
    expect(url).toBe("https://signed/e1");
  });

  it("returns null when the expense has no photo", async () => {
    const exp: ExpenseFixture = {
      _id: "expenses:nophoto",
      _creationTime: T0,
      paidAt: T0,
      amountCents: 1000,
      vendor: "x",
      category: "Other",
      recordedBy: USER_ID,
      recordedAt: T0,
    };
    const { ctx } = makeCtx({ initialExpenses: [exp] });
    const url = await run(ctx, { expenseId: exp._id });
    expect(url).toBeNull();
  });

  it("returns null when the expense doesn't exist", async () => {
    const { ctx } = makeCtx({});
    const url = await run(ctx, { expenseId: "expenses:ghost" });
    expect(url).toBeNull();
  });

  it("rejects customer with FORBIDDEN", async () => {
    const exp: ExpenseFixture = {
      _id: "expenses:1",
      _creationTime: T0,
      paidAt: T0,
      amountCents: 1000,
      vendor: "x",
      category: "Other",
      photoStorageId: "_storage:e1",
      recordedBy: USER_ID,
      recordedAt: T0,
    };
    const { ctx } = makeCtx({ roles: ["customer"], initialExpenses: [exp] });
    const thrown = await run(ctx, { expenseId: exp._id }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("listRecentExpenses", () => {
  const run = handlerOf(listRecentExpenses);

  it("returns rows ordered by paidAt desc with recordedByName resolved", async () => {
    const rows: ExpenseFixture[] = [1, 2, 3].map((i) => ({
      _id: `expenses:${i}`,
      _creationTime: T0 + i,
      paidAt: T0 + i * 1000,
      amountCents: 100 * i,
      vendor: `v${i}`,
      category: "Other",
      recordedBy: USER_ID,
      recordedAt: T0 + i,
    }));
    const { ctx } = makeCtx({ initialExpenses: rows });
    const result = (await run(ctx, {})) as Array<{
      _id: string;
      recordedByName: string | null;
    }>;
    expect(result.map((r) => r._id)).toEqual([
      "expenses:3",
      "expenses:2",
      "expenses:1",
    ]);
    expect(result[0]!.recordedByName).toBe("Maria Office");
  });

  it("respects the limit argument and clamps to 200 max", async () => {
    const rows: ExpenseFixture[] = Array.from({ length: 300 }, (_, i) => ({
      _id: `expenses:${i + 1}`,
      _creationTime: T0 + i,
      paidAt: T0 + i,
      amountCents: 1,
      vendor: "v",
      category: "Other",
      recordedBy: USER_ID,
      recordedAt: T0 + i,
    }));
    const { ctx } = makeCtx({ initialExpenses: rows });
    const clamped = (await run(ctx, { limit: 500 })) as unknown[];
    expect(clamped.length).toBeLessThanOrEqual(200);
  });

  it("defaults limit to 50 when not provided", async () => {
    const rows: ExpenseFixture[] = Array.from({ length: 75 }, (_, i) => ({
      _id: `expenses:${i + 1}`,
      _creationTime: T0 + i,
      paidAt: T0 + i,
      amountCents: 1,
      vendor: "v",
      category: "Other",
      recordedBy: USER_ID,
      recordedAt: T0 + i,
    }));
    const { ctx } = makeCtx({ initialExpenses: rows });
    const result = (await run(ctx, {})) as unknown[];
    expect(result).toHaveLength(50);
  });

  it("rejects customer with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["customer"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("getExpensesMtdTotal", () => {
  const run = handlerOf(getExpensesMtdTotal);

  it("sums expenses inside the requested Manila month", async () => {
    // May 2026: paidAt at T0 should be inside [May 1, June 1) Manila.
    const insideMay: ExpenseFixture = {
      _id: "expenses:may",
      _creationTime: T0,
      paidAt: T0,
      amountCents: 100_000,
      vendor: "v",
      category: "Other",
      recordedBy: USER_ID,
      recordedAt: T0,
    };
    const aprilBoundary: ExpenseFixture = {
      _id: "expenses:april",
      _creationTime: T0,
      paidAt: new Date("2026-04-15T12:00:00+08:00").getTime(),
      amountCents: 500_000,
      vendor: "v",
      category: "Other",
      recordedBy: USER_ID,
      recordedAt: T0,
    };
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialExpenses: [insideMay, aprilBoundary],
    });
    const result = (await run(ctx, { month: "2026-05" })) as {
      totalCents: number;
      count: number;
      month: string;
    };
    expect(result.totalCents).toBe(100_000);
    expect(result.count).toBe(1);
    expect(result.month).toBe("2026-05");
  });

  it("defaults to the current Manila month when month is omitted", async () => {
    const exp: ExpenseFixture = {
      _id: "expenses:now",
      _creationTime: T0,
      paidAt: T0,
      amountCents: 42_00,
      vendor: "v",
      category: "Other",
      recordedBy: USER_ID,
      recordedAt: T0,
    };
    const { ctx } = makeCtx({ roles: ["admin"], initialExpenses: [exp] });
    const result = (await run(ctx, {})) as { totalCents: number; month: string };
    expect(result.totalCents).toBe(42_00);
    expect(result.month).toBe("2026-05");
  });

  it("rejects office_staff with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects malformed month with VALIDATION", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const thrown = await run(ctx, { month: "not-a-month" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects out-of-range month with VALIDATION", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const thrown = await run(ctx, { month: "2026-13" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });
});

describe("getExpense", () => {
  const run = handlerOf(getExpense);

  it("returns the row when present", async () => {
    const exp: ExpenseFixture = {
      _id: "expenses:1",
      _creationTime: T0,
      paidAt: T0,
      amountCents: 1000,
      vendor: "x",
      category: "Other",
      recordedBy: USER_ID,
      recordedAt: T0,
    };
    const { ctx } = makeCtx({ initialExpenses: [exp] });
    const row = (await run(ctx, { expenseId: exp._id })) as { vendor: string };
    expect(row.vendor).toBe("x");
  });

  it("returns null when the id doesn't exist", async () => {
    const { ctx } = makeCtx({});
    const row = await run(ctx, { expenseId: "expenses:ghost" });
    expect(row).toBeNull();
  });
});

describe("getActiveCategoriesForForm", () => {
  const run = handlerOf(getActiveCategoriesForForm);

  it("returns the bootstrap defaults + placeholder=false post-Story-4.7", async () => {
    // Story 4.7 swapped `convex/lib/expenseCategories.ts` from
    // hardcoded-constant to DB-backed. The form-facing query now
    // returns `isPlaceholder: false` permanently — the admin owns
    // the taxonomy through `/admin/expense-categories`. When the
    // table is empty (this test mocks it as empty), the helper
    // falls back to the hardcoded defaults so office staff can
    // still record expenses against the bootstrap set.
    const { ctx } = makeCtx({});
    const result = (await run(ctx, {})) as {
      categories: string[];
      isPlaceholder: boolean;
    };
    expect(result.isPlaceholder).toBe(false);
    expect(result.categories).toEqual(
      expect.arrayContaining(["Utilities", "Maintenance", "Supplies", "Salaries", "Other"]),
    );
  });

  it("rejects customer with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["customer"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});
