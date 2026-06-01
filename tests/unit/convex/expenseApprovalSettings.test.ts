/**
 * Story 6.6 — `convex/expenseApprovalSettings.ts` unit tests.
 *
 * Hand-mocked-ctx pattern (mirrors `expenseCategories.test.ts`).
 * Covers each exported mutation/query: list, getMap, set, setDefault,
 * delete. Verifies auth gating, validation, default-sentinel handling,
 * and audit emission.
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
  DEFAULT_CATEGORY_SENTINEL,
  deleteExpenseApprovalSetting,
  getExpenseApprovalSettingsMap,
  listExpenseApprovalSettings,
  setDefaultExpenseApprovalSetting,
  setExpenseApprovalSetting,
} from "../../../convex/expenseApprovalSettings";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-05-15T12:00:00+08:00").getTime();
const USER_ID = "users:admin1";
const SESSION_ID = "authSessions:s1";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface SettingFixture {
  _id: string;
  _creationTime: number;
  category: string;
  thresholdCents: number;
  requiresApproval: boolean;
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

interface CtxBag {
  settings: Map<string, SettingFixture>;
  auditInserts: AuditInsert[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  initialSettings?: SettingFixture[];
  authenticated?: boolean;
}): CtxBag {
  const settings = new Map<string, SettingFixture>(
    (opts.initialSettings ?? []).map((s) => [s._id, s]),
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

  interface IndexQuery {
    eqs: Record<string, unknown>;
    eq(field: string, value: unknown): IndexQuery;
  }

  function makeSettingsQueryBuilder() {
    type Predicate = (r: SettingFixture) => boolean;
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
        return Array.from(settings.values()).filter((r) =>
          predicates.every((p) => p(r)),
        );
      },
      async first() {
        const rows: SettingFixture[] = Array.from(settings.values()).filter(
          (r) => predicates.every((p) => p(r)),
        );
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
        if (settings.has(id)) return settings.get(id);
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
        if (table === "expenseApprovalSettings") {
          return makeSettingsQueryBuilder();
        }
        return {
          withIndex: () => ({
            collect: async (): Promise<unknown[]> => [],
            first: async (): Promise<unknown | null> => null,
          }),
          collect: async (): Promise<unknown[]> => [],
          first: async (): Promise<unknown | null> => null,
        };
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "expenseApprovalSettings") {
          const id = `expenseApprovalSettings:${nextId++}`;
          settings.set(id, {
            _id: id,
            _creationTime: T0,
            ...row,
          } as SettingFixture);
          return id;
        }
        if (table === "auditLog") {
          auditInserts.push({ table, row: row as AuditInsert["row"] });
          return `auditLog:${auditInserts.length}`;
        }
        return `${table}:?`;
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        const existing = settings.get(id);
        if (existing !== undefined) {
          settings.set(id, { ...existing, ...patch } as SettingFixture);
        }
        return null;
      }),
      delete: vi.fn(async (id: string) => {
        settings.delete(id);
        return null;
      }),
    },
  };

  return { settings, auditInserts, ctx };
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

function makeSetting(overrides: Partial<SettingFixture> = {}): SettingFixture {
  const category = overrides.category ?? "Utilities";
  return {
    _id: overrides._id ?? `expenseApprovalSettings:${category}`,
    _creationTime: T0,
    category,
    thresholdCents: overrides.thresholdCents ?? 500_000,
    requiresApproval: overrides.requiresApproval ?? true,
    updatedAt: overrides.updatedAt ?? T0,
    updatedBy: overrides.updatedBy ?? USER_ID,
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

describe("setExpenseApprovalSetting", () => {
  const run = handlerOf(setExpenseApprovalSetting);

  it("admin inserts a new per-category setting; emits audit", async () => {
    const { ctx, settings, auditInserts } = makeCtx({ roles: ["admin"] });
    const result = (await run(ctx, {
      category: "Utilities",
      thresholdCents: 500_000,
      requiresApproval: true,
    })) as { settingId: string };

    expect(settings.size).toBe(1);
    const row = settings.get(result.settingId)!;
    expect(row.category).toBe("Utilities");
    expect(row.thresholdCents).toBe(500_000);
    expect(row.requiresApproval).toBe(true);
    expect(row.updatedBy).toBe(USER_ID);

    expect(auditInserts).toHaveLength(1);
    const audit = auditInserts[0]!;
    expect(audit.row.action).toBe("create");
    expect(audit.row.entityType).toBe("expense");
    expect(audit.row.after).toMatchObject({
      kind: "expenseApprovalSetting",
      category: "Utilities",
      thresholdCents: 500_000,
      requiresApproval: true,
    });
  });

  it("admin updates an existing per-category setting; emits update audit", async () => {
    const seeded = makeSetting({ thresholdCents: 100_000 });
    const { ctx, auditInserts } = makeCtx({
      roles: ["admin"],
      initialSettings: [seeded],
    });
    await run(ctx, {
      category: "Utilities",
      thresholdCents: 250_000,
      requiresApproval: true,
    });
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]!.row.action).toBe("update");
    expect(auditInserts[0]!.row.after).toMatchObject({
      thresholdCents: 250_000,
    });
    expect(auditInserts[0]!.row.before).toMatchObject({
      thresholdCents: 100_000,
    });
  });

  it("no-op when values are unchanged — does not emit audit", async () => {
    const seeded = makeSetting({ thresholdCents: 100_000 });
    const { ctx, auditInserts } = makeCtx({
      roles: ["admin"],
      initialSettings: [seeded],
    });
    await run(ctx, {
      category: "Utilities",
      thresholdCents: 100_000,
      requiresApproval: true,
    });
    expect(auditInserts).toHaveLength(0);
  });

  it("rejects non-admin with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(ctx, {
      category: "Utilities",
      thresholdCents: 100_000,
      requiresApproval: true,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {
      category: "Utilities",
      thresholdCents: 100_000,
      requiresApproval: true,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("rejects negative or non-integer threshold with VALIDATION", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    for (const bad of [-1, 1.5, Number.NaN]) {
      const thrown = await run(ctx, {
        category: "Utilities",
        thresholdCents: bad,
        requiresApproval: true,
      }).catch((e) => e);
      expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    }
  });

  it("rejects empty category with VALIDATION", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const thrown = await run(ctx, {
      category: "   ",
      thresholdCents: 100_000,
      requiresApproval: true,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });
});

describe("setDefaultExpenseApprovalSetting", () => {
  const run = handlerOf(setDefaultExpenseApprovalSetting);

  it("inserts the default sentinel row on first call", async () => {
    const { ctx, settings, auditInserts } = makeCtx({ roles: ["admin"] });
    await run(ctx, { thresholdCents: 200_000, requiresApproval: true });
    expect(settings.size).toBe(1);
    const rows = Array.from(settings.values());
    expect(rows[0]!.category).toBe(DEFAULT_CATEGORY_SENTINEL);
    expect(rows[0]!.thresholdCents).toBe(200_000);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]!.row.action).toBe("create");
  });

  it("updates the default sentinel row on subsequent calls", async () => {
    const seeded = makeSetting({
      _id: "expenseApprovalSettings:default",
      category: DEFAULT_CATEGORY_SENTINEL,
      thresholdCents: 100_000,
    });
    const { ctx, auditInserts } = makeCtx({
      roles: ["admin"],
      initialSettings: [seeded],
    });
    await run(ctx, { thresholdCents: 300_000, requiresApproval: true });
    expect(auditInserts[0]!.row.action).toBe("update");
  });

  it("rejects non-admin with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(ctx, {
      thresholdCents: 200_000,
      requiresApproval: true,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects negative threshold with VALIDATION", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const thrown = await run(ctx, {
      thresholdCents: -10,
      requiresApproval: true,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });
});

describe("listExpenseApprovalSettings", () => {
  const run = handlerOf(listExpenseApprovalSettings);

  it("returns a synthetic default row when no rows exist", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const result = (await run(ctx, {})) as {
      settings: Array<{
        category: string;
        isDefault: boolean;
        requiresApproval: boolean;
      }>;
    };
    expect(result.settings).toHaveLength(1);
    expect(result.settings[0]!.category).toBe(DEFAULT_CATEGORY_SENTINEL);
    expect(result.settings[0]!.isDefault).toBe(true);
    expect(result.settings[0]!.requiresApproval).toBe(false);
  });

  it("returns the real default row when it exists", async () => {
    const seeded = makeSetting({
      _id: "expenseApprovalSettings:default",
      category: DEFAULT_CATEGORY_SENTINEL,
      thresholdCents: 200_000,
      requiresApproval: true,
    });
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialSettings: [seeded],
    });
    const result = (await run(ctx, {})) as {
      settings: Array<{
        category: string;
        isDefault: boolean;
        requiresApproval: boolean;
      }>;
    };
    const def = result.settings.find((s) => s.isDefault);
    expect(def).toBeDefined();
    expect(def!.requiresApproval).toBe(true);
  });

  it("rejects non-admin with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("getExpenseApprovalSettingsMap", () => {
  const run = handlerOf(getExpenseApprovalSettingsMap);

  it("returns empty map + zero default when no rows exist", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const result = (await run(ctx, {})) as {
      map: Record<string, { thresholdCents: number; requiresApproval: boolean }>;
      default: { thresholdCents: number; requiresApproval: boolean };
    };
    expect(Object.keys(result.map)).toHaveLength(0);
    expect(result.default).toEqual({
      thresholdCents: 0,
      requiresApproval: false,
    });
  });

  it("splits the default sentinel from per-category rows", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      initialSettings: [
        makeSetting({
          _id: "expenseApprovalSettings:default",
          category: DEFAULT_CATEGORY_SENTINEL,
          thresholdCents: 100_000,
          requiresApproval: true,
        }),
        makeSetting({
          _id: "expenseApprovalSettings:utilities",
          category: "Utilities",
          thresholdCents: 500_000,
          requiresApproval: true,
        }),
      ],
    });
    const result = (await run(ctx, {})) as {
      map: Record<string, { thresholdCents: number; requiresApproval: boolean }>;
      default: { thresholdCents: number; requiresApproval: boolean };
    };
    expect(result.default.thresholdCents).toBe(100_000);
    expect(result.map.Utilities!.thresholdCents).toBe(500_000);
    expect(result.map[DEFAULT_CATEGORY_SENTINEL]).toBeUndefined();
  });

  it("allows admin + office_staff", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const result = (await run(ctx, {})) as unknown;
    expect(result).toBeDefined();
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("deleteExpenseApprovalSetting", () => {
  const run = handlerOf(deleteExpenseApprovalSetting);

  it("deletes a per-category row and emits audit", async () => {
    const seeded = makeSetting({
      _id: "expenseApprovalSettings:utilities",
      category: "Utilities",
    });
    const { ctx, settings, auditInserts } = makeCtx({
      roles: ["admin"],
      initialSettings: [seeded],
    });
    await run(ctx, { settingId: seeded._id });
    expect(settings.size).toBe(0);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]!.row.action).toBe("delete");
  });

  it("refuses to delete the default sentinel row with VALIDATION", async () => {
    const seeded = makeSetting({
      _id: "expenseApprovalSettings:default",
      category: DEFAULT_CATEGORY_SENTINEL,
    });
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialSettings: [seeded],
    });
    const thrown = await run(ctx, { settingId: seeded._id }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("throws NOT_FOUND for an unknown id", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const thrown = await run(ctx, {
      settingId: "expenseApprovalSettings:missing",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("rejects non-admin with FORBIDDEN", async () => {
    const seeded = makeSetting();
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      initialSettings: [seeded],
    });
    const thrown = await run(ctx, { settingId: seeded._id }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});
