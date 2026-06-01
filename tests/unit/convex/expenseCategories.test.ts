/**
 * Story 4.7 — `convex/expenseCategories.ts` unit tests.
 *
 * Hand-mocked-ctx pattern (matches `expenses.test.ts`). Covers each
 * exported mutation/query: list, checkNameAvailability, create,
 * update, setActive, delete. Verifies auth gating, validation,
 * case-insensitive uniqueness, deactivate-not-delete invariant, and
 * audit emission on every change.
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
  checkNameAvailability,
  createExpenseCategory,
  deleteExpenseCategory,
  listExpenseCategories,
  setExpenseCategoryActive,
  updateExpenseCategory,
} from "../../../convex/expenseCategories";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-05-15T12:00:00+08:00").getTime();
const USER_ID = "users:admin1";
const SESSION_ID = "authSessions:s1";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface CategoryFixture {
  _id: string;
  _creationTime: number;
  name: string;
  nameLowercased: string;
  description?: string;
  isActive: boolean;
  displayOrder?: number;
  createdAt: number;
  createdBy: string;
  lastModifiedAt?: number;
  lastModifiedBy?: string;
}

interface ExpenseFixture {
  _id: string;
  _creationTime: number;
  category: string;
  amountCents: number;
  vendor: string;
  paidAt: number;
  recordedBy: string;
  recordedAt: number;
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
  categories: Map<string, CategoryFixture>;
  expenses: Map<string, ExpenseFixture>;
  auditInserts: AuditInsert[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  initialCategories?: CategoryFixture[];
  initialExpenses?: ExpenseFixture[];
  authenticated?: boolean;
}): CtxBag {
  const categories = new Map<string, CategoryFixture>(
    (opts.initialCategories ?? []).map((c) => [c._id, c]),
  );
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

  function makeCategoriesQueryBuilder() {
    type Predicate = (r: CategoryFixture) => boolean;
    const predicates: Predicate[] = [];

    const builder = {
      withIndex(_indexName: string, fn?: (q: IndexQuery) => IndexQuery) {
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
            predicates.push(
              (r) =>
                (r as unknown as Record<string, unknown>)[field] === value,
            );
          }
        }
        return builder;
      },
      async collect() {
        return Array.from(categories.values()).filter((r) =>
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

  function makeExpensesQueryBuilder() {
    type Predicate = (r: ExpenseFixture) => boolean;
    const predicates: Predicate[] = [];

    const builder = {
      withIndex(_indexName: string, fn?: (q: IndexQuery) => IndexQuery) {
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
            predicates.push(
              (r) =>
                (r as unknown as Record<string, unknown>)[field] === value,
            );
          }
        }
        return builder;
      },
      async collect() {
        return Array.from(expenses.values()).filter((r) =>
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

  interface IndexQuery {
    eqs: Record<string, unknown>;
    eq(field: string, value: unknown): IndexQuery;
  }

  const ctx = {
    db: {
      get: vi.fn(async (id: string) => {
        if (id === USER_ID) return user;
        if (id === SESSION_ID) return session;
        if (categories.has(id)) return categories.get(id);
        if (expenses.has(id)) return expenses.get(id);
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
        if (table === "expenseCategories") {
          return makeCategoriesQueryBuilder();
        }
        if (table === "expenses") {
          return makeExpensesQueryBuilder();
        }
        return {
          withIndex: () => ({
            collect: async () => [],
            first: async () => null,
          }),
        };
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "expenseCategories") {
          const id = `expenseCategories:${nextId++}`;
          categories.set(id, {
            _id: id,
            _creationTime: T0,
            ...row,
          } as CategoryFixture);
          return id;
        }
        if (table === "auditLog") {
          auditInserts.push({ table, row: row as AuditInsert["row"] });
          return `auditLog:${auditInserts.length}`;
        }
        return `${table}:?`;
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        const existing = categories.get(id);
        if (existing !== undefined) {
          categories.set(id, { ...existing, ...patch } as CategoryFixture);
        }
        return null;
      }),
      delete: vi.fn(async (id: string) => {
        categories.delete(id);
        return null;
      }),
    },
  };

  return { categories, expenses, auditInserts, ctx };
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

function getKind(thrown: unknown): string | undefined {
  if (!(thrown instanceof ConvexError)) return undefined;
  const data = (thrown as ConvexError<Value>).data as unknown as ErrorPayload;
  const details = data?.details as { kind?: string } | undefined;
  return details?.kind;
}

function makeCategory(overrides: Partial<CategoryFixture> = {}): CategoryFixture {
  const name = overrides.name ?? "Utilities";
  return {
    _id: overrides._id ?? `expenseCategories:seed-${name}`,
    _creationTime: T0,
    name,
    nameLowercased: name.toLowerCase(),
    isActive: overrides.isActive ?? true,
    createdAt: T0,
    createdBy: USER_ID,
    ...overrides,
  };
}

function makeExpense(overrides: Partial<ExpenseFixture> = {}): ExpenseFixture {
  return {
    _id: overrides._id ?? "expenses:1",
    _creationTime: T0,
    category: overrides.category ?? "Utilities",
    amountCents: overrides.amountCents ?? 50_000,
    vendor: overrides.vendor ?? "Meralco",
    paidAt: overrides.paidAt ?? T0,
    recordedBy: overrides.recordedBy ?? USER_ID,
    recordedAt: overrides.recordedAt ?? T0,
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

describe("createExpenseCategory", () => {
  const run = handlerOf(createExpenseCategory);

  it("admin can create a new category; row inserted with isActive=true; audit emitted", async () => {
    const { ctx, categories, auditInserts } = makeCtx({ roles: ["admin"] });
    const result = (await run(ctx, {
      name: "Insurance",
      description: "Monthly insurance premiums",
    })) as { categoryId: string };

    expect(categories.size).toBe(1);
    const row = categories.get(result.categoryId)!;
    expect(row.name).toBe("Insurance");
    expect(row.nameLowercased).toBe("insurance");
    expect(row.isActive).toBe(true);
    expect(row.description).toBe("Monthly insurance premiums");
    expect(row.createdBy).toBe(USER_ID);
    expect(row.createdAt).toBe(T0);

    expect(auditInserts).toHaveLength(1);
    const audit = auditInserts[0]!;
    expect(audit.row.action).toBe("create");
    expect(audit.row.entityType).toBe("expense");
    expect(audit.row.entityId).toBe(result.categoryId);
    expect(audit.row.after).toMatchObject({
      kind: "expenseCategory",
      name: "Insurance",
      isActive: true,
    });
  });

  it("trims the name + description before insert", async () => {
    const { ctx, categories } = makeCtx({ roles: ["admin"] });
    const result = (await run(ctx, {
      name: "  Travel  ",
      description: "  Trip expenses  ",
    })) as { categoryId: string };
    const row = categories.get(result.categoryId)!;
    expect(row.name).toBe("Travel");
    expect(row.description).toBe("Trip expenses");
  });

  it("rejects an empty name with VALIDATION", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    for (const bad of ["", "   "]) {
      const thrown = await run(ctx, { name: bad }).catch((e) => e);
      expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    }
  });

  it("rejects a 51-char name with VALIDATION", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const thrown = await run(ctx, { name: "a".repeat(51) }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects a 201-char description with VALIDATION", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const thrown = await run(ctx, {
      name: "OK",
      description: "x".repeat(201),
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects a duplicate (exact case) with DUPLICATE_CATEGORY_NAME kind", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialCategories: [makeCategory({ name: "Utilities" })],
    });
    const thrown = await run(ctx, { name: "Utilities" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    expect(getKind(thrown)).toBe("DUPLICATE_CATEGORY_NAME");
  });

  it("rejects a duplicate with different case (case-insensitive)", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialCategories: [makeCategory({ name: "Utilities" })],
    });
    const thrown = await run(ctx, { name: "UTILITIES" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    expect(getKind(thrown)).toBe("DUPLICATE_CATEGORY_NAME");
  });

  it("rejects a duplicate with surrounding whitespace", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialCategories: [makeCategory({ name: "Utilities" })],
    });
    const thrown = await run(ctx, { name: "  Utilities  " }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    expect(getKind(thrown)).toBe("DUPLICATE_CATEGORY_NAME");
  });

  it("treats an inactive duplicate as a conflict too", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialCategories: [
        makeCategory({ name: "Utilities", isActive: false }),
      ],
    });
    const thrown = await run(ctx, { name: "utilities" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    expect(getKind(thrown)).toBe("DUPLICATE_CATEGORY_NAME");
  });

  it("rejects office_staff with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(ctx, { name: "Insurance" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, { name: "Insurance" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});

describe("updateExpenseCategory", () => {
  const run = handlerOf(updateExpenseCategory);

  it("renames a category; emits audit; does NOT touch existing expenses", async () => {
    const { ctx, categories, expenses, auditInserts } = makeCtx({
      roles: ["admin"],
      initialCategories: [
        makeCategory({ _id: "expenseCategories:u", name: "Utilities" }),
      ],
      initialExpenses: [
        makeExpense({ _id: "expenses:e1", category: "Utilities" }),
      ],
    });
    await run(ctx, {
      categoryId: "expenseCategories:u",
      name: "Public Utilities",
    });
    const row = categories.get("expenseCategories:u")!;
    expect(row.name).toBe("Public Utilities");
    expect(row.nameLowercased).toBe("public utilities");

    // Existing expense unchanged.
    expect(expenses.get("expenses:e1")!.category).toBe("Utilities");

    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]!.row.action).toBe("update");
    expect(auditInserts[0]!.row.before).toMatchObject({ name: "Utilities" });
    expect(auditInserts[0]!.row.after).toMatchObject({
      name: "Public Utilities",
    });
  });

  it("rejects a rename that collides with another category", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialCategories: [
        makeCategory({ _id: "expenseCategories:u", name: "Utilities" }),
        makeCategory({ _id: "expenseCategories:m", name: "Maintenance" }),
      ],
    });
    const thrown = await run(ctx, {
      categoryId: "expenseCategories:m",
      name: "utilities",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    expect(getKind(thrown)).toBe("DUPLICATE_CATEGORY_NAME");
  });

  it("allows renaming to the same case-insensitive name (own row)", async () => {
    const { ctx, categories } = makeCtx({
      roles: ["admin"],
      initialCategories: [
        makeCategory({ _id: "expenseCategories:u", name: "Utilities" }),
      ],
    });
    await run(ctx, {
      categoryId: "expenseCategories:u",
      name: "utilities",
    });
    expect(categories.get("expenseCategories:u")!.name).toBe("utilities");
  });

  it("updates description without changing name", async () => {
    const { ctx, categories } = makeCtx({
      roles: ["admin"],
      initialCategories: [makeCategory({ _id: "expenseCategories:u" })],
    });
    await run(ctx, {
      categoryId: "expenseCategories:u",
      description: "Electricity and water",
    });
    const row = categories.get("expenseCategories:u")!;
    expect(row.name).toBe("Utilities");
    expect(row.description).toBe("Electricity and water");
  });

  it("rejects NOT_FOUND when the row is missing", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const thrown = await run(ctx, {
      categoryId: "expenseCategories:missing",
      name: "X",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("rejects office_staff with FORBIDDEN", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      initialCategories: [makeCategory({ _id: "expenseCategories:u" })],
    });
    const thrown = await run(ctx, {
      categoryId: "expenseCategories:u",
      name: "X",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("setExpenseCategoryActive", () => {
  const run = handlerOf(setExpenseCategoryActive);

  it("deactivates a category and emits a deactivate audit row", async () => {
    const { ctx, categories, auditInserts } = makeCtx({
      roles: ["admin"],
      initialCategories: [makeCategory({ _id: "expenseCategories:u" })],
    });
    await run(ctx, {
      categoryId: "expenseCategories:u",
      isActive: false,
    });
    expect(categories.get("expenseCategories:u")!.isActive).toBe(false);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]!.row.action).toBe("deactivate");
  });

  it("reactivates a category and emits a reactivate audit row", async () => {
    const { ctx, categories, auditInserts } = makeCtx({
      roles: ["admin"],
      initialCategories: [
        makeCategory({ _id: "expenseCategories:u", isActive: false }),
      ],
    });
    await run(ctx, { categoryId: "expenseCategories:u", isActive: true });
    expect(categories.get("expenseCategories:u")!.isActive).toBe(true);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]!.row.action).toBe("reactivate");
  });

  it("is a no-op when the value matches; no audit emitted", async () => {
    const { ctx, auditInserts } = makeCtx({
      roles: ["admin"],
      initialCategories: [makeCategory({ _id: "expenseCategories:u" })],
    });
    await run(ctx, { categoryId: "expenseCategories:u", isActive: true });
    expect(auditInserts).toHaveLength(0);
  });

  it("rejects office_staff with FORBIDDEN", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      initialCategories: [makeCategory({ _id: "expenseCategories:u" })],
    });
    const thrown = await run(ctx, {
      categoryId: "expenseCategories:u",
      isActive: false,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("deleteExpenseCategory", () => {
  const run = handlerOf(deleteExpenseCategory);

  it("deletes a category with zero linked expenses; emits delete audit", async () => {
    const { ctx, categories, auditInserts } = makeCtx({
      roles: ["admin"],
      initialCategories: [
        makeCategory({ _id: "expenseCategories:u", name: "Travel" }),
      ],
    });
    await run(ctx, { categoryId: "expenseCategories:u" });
    expect(categories.size).toBe(0);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]!.row.action).toBe("delete");
    expect(auditInserts[0]!.row.before).toMatchObject({ name: "Travel" });
  });

  it("refuses to delete when linked expenses exist", async () => {
    const { ctx, categories } = makeCtx({
      roles: ["admin"],
      initialCategories: [
        makeCategory({ _id: "expenseCategories:u", name: "Maintenance" }),
      ],
      initialExpenses: [
        makeExpense({ _id: "expenses:e1", category: "Maintenance" }),
      ],
    });
    const thrown = await run(ctx, {
      categoryId: "expenseCategories:u",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    expect(getKind(thrown)).toBe("CANNOT_DELETE_CATEGORY_WITH_EXPENSES");
    // Row still present.
    expect(categories.size).toBe(1);
  });

  it("rejects NOT_FOUND when the row is missing", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const thrown = await run(ctx, {
      categoryId: "expenseCategories:missing",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("rejects office_staff with FORBIDDEN", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      initialCategories: [makeCategory({ _id: "expenseCategories:u" })],
    });
    const thrown = await run(ctx, {
      categoryId: "expenseCategories:u",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("listExpenseCategories", () => {
  const run = handlerOf(listExpenseCategories);

  it("returns active rows by default, sorted by name", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialCategories: [
        makeCategory({ _id: "expenseCategories:s", name: "Supplies" }),
        makeCategory({ _id: "expenseCategories:u", name: "Utilities" }),
        makeCategory({
          _id: "expenseCategories:i",
          name: "Inactive",
          isActive: false,
        }),
      ],
    });
    const result = (await run(ctx, {})) as Array<{
      name: string;
      isActive: boolean;
    }>;
    expect(result.map((r) => r.name)).toEqual(["Supplies", "Utilities"]);
  });

  it("with includeInactive=true returns active first then inactive, each sorted by name", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialCategories: [
        makeCategory({ _id: "expenseCategories:1", name: "Zeta" }),
        makeCategory({ _id: "expenseCategories:2", name: "Alpha" }),
        makeCategory({
          _id: "expenseCategories:3",
          name: "Beta",
          isActive: false,
        }),
        makeCategory({
          _id: "expenseCategories:4",
          name: "Gamma",
          isActive: false,
        }),
      ],
    });
    const result = (await run(ctx, { includeInactive: true })) as Array<{
      name: string;
      isActive: boolean;
    }>;
    expect(result.map((r) => r.name)).toEqual(["Alpha", "Zeta", "Beta", "Gamma"]);
  });

  it("includes linkedExpenseCount per category", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialCategories: [
        makeCategory({ _id: "expenseCategories:u", name: "Utilities" }),
        makeCategory({ _id: "expenseCategories:m", name: "Maintenance" }),
      ],
      initialExpenses: [
        makeExpense({ _id: "expenses:1", category: "Utilities" }),
        makeExpense({ _id: "expenses:2", category: "Utilities" }),
        makeExpense({ _id: "expenses:3", category: "Maintenance" }),
      ],
    });
    const result = (await run(ctx, {})) as Array<{
      name: string;
      linkedExpenseCount: number;
    }>;
    const byName = new Map(result.map((r) => [r.name, r]));
    expect(byName.get("Utilities")!.linkedExpenseCount).toBe(2);
    expect(byName.get("Maintenance")!.linkedExpenseCount).toBe(1);
  });

  it("rejects office_staff with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("checkNameAvailability", () => {
  const run = handlerOf(checkNameAvailability);

  it("returns available=true for an unused name", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialCategories: [makeCategory({ name: "Utilities" })],
    });
    const r = (await run(ctx, { name: "Insurance" })) as {
      available: boolean;
    };
    expect(r.available).toBe(true);
  });

  it("returns available=false for a colliding name (case-insensitive)", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialCategories: [makeCategory({ name: "Utilities" })],
    });
    const r = (await run(ctx, { name: "utilities" })) as {
      available: boolean;
    };
    expect(r.available).toBe(false);
  });

  it("treats the excluded id as available when editing own row", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialCategories: [
        makeCategory({ _id: "expenseCategories:u", name: "Utilities" }),
      ],
    });
    const r = (await run(ctx, {
      name: "utilities",
      excludeCategoryId: "expenseCategories:u",
    })) as { available: boolean };
    expect(r.available).toBe(true);
  });

  it("returns available=false for empty input (defensive)", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const r = (await run(ctx, { name: "  " })) as { available: boolean };
    expect(r.available).toBe(false);
  });

  it("rejects office_staff with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(ctx, { name: "x" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});
