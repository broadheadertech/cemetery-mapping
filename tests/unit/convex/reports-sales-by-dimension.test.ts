/**
 * Story 6.3 — `convex/reports.ts → salesByDimension` unit tests.
 *
 * Hand-mocked-ctx pattern (mirrors `expenseApprovalSettings.test.ts`
 * and `dashboard.test.ts`). The mock supports:
 *
 *   - `contracts` table walk via `withIndex("by_createdAt", q => q.gte(...).lte(...))`
 *   - `lots` lookups via `ctx.db.get(lotId)`
 *   - `users` lookups (for the agent-name resolution branch)
 *   - `appSettings` singleton via `withIndex("by_key", ...)`
 *   - `auditLog` inserts (mutation path)
 *   - `userRoles` reads for the auth helper
 *
 * Coverage:
 *   - Auth gates (admin allowed; office_staff / field_worker /
 *     unauthenticated rejected).
 *   - Empty date range — no contracts → totalCount 0, lotTypes [].
 *   - Multiple lot types + sections → nested grouping correct.
 *   - Voided / cancelled contracts excluded.
 *   - Setting off → response has NO `agents` keys (defense in depth).
 *   - Setting on → response includes `agents` array per section.
 *   - `salesByDimension` returns the setting flag in the report payload.
 *   - `setSalesAgentTracking` admin-only + audit-emitting + no-op
 *     short-circuit.
 *   - `getAppSettings` returns absent-row default.
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
  getAppSettings,
  salesByDimension,
  setSalesAgentTracking,
} from "../../../convex/reports";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-05-15T12:00:00+08:00").getTime();
const USER_ID = "users:admin1";
const SESSION_ID = "authSessions:s1";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";
type LotType = "single" | "family" | "mausoleum" | "niche";

interface LotFixture {
  _id: string;
  _creationTime: number;
  type: LotType;
  section: string;
  code: string;
}
interface ContractFixture {
  _id: string;
  _creationTime: number;
  lotId: string;
  customerId: string;
  state: "active" | "paid_in_full" | "cancelled" | "voided" | "in_default";
  totalPriceCents: number;
  createdAt: number;
  agentId?: string;
}
interface AppSettingsFixture {
  _id: string;
  _creationTime: number;
  key: "singleton";
  salesAgentTrackingEnabled?: boolean;
}
interface UserFixture {
  _id: string;
  _creationTime: number;
  name?: string;
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
  settings: Map<string, AppSettingsFixture>;
  contracts: ContractFixture[];
  lots: Map<string, LotFixture>;
  users: Map<string, UserFixture>;
  auditInserts: AuditInsert[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  contracts?: ContractFixture[];
  lots?: LotFixture[];
  appSettings?: AppSettingsFixture[];
  users?: UserFixture[];
  authenticated?: boolean;
}): CtxBag {
  const contracts = opts.contracts ?? [];
  const lots = new Map<string, LotFixture>(
    (opts.lots ?? []).map((l) => [l._id, l]),
  );
  const settings = new Map<string, AppSettingsFixture>(
    (opts.appSettings ?? []).map((s) => [s._id, s]),
  );
  const users = new Map<string, UserFixture>(
    (opts.users ?? []).map((u) => [u._id, u]),
  );
  const auditInserts: AuditInsert[] = [];

  if (opts.authenticated === false) {
    mockedGetAuthUserId.mockResolvedValue(null);
    mockedGetAuthSessionId.mockResolvedValue(null);
  } else {
    mockedGetAuthUserId.mockResolvedValue(USER_ID as never);
    mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);
  }

  const user: UserFixture = {
    _id: USER_ID,
    _creationTime: T0 - 1000,
    name: "Admin Reyes",
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

  let nextSettingsId = 1;

  interface IndexQuery {
    eqs: Record<string, unknown>;
    ranges: Array<{ field: string; op: "gte" | "lte" | "lt"; value: number }>;
    eq(field: string, value: unknown): IndexQuery;
    gte(field: string, value: number): IndexQuery;
    lte(field: string, value: number): IndexQuery;
    lt(field: string, value: number): IndexQuery;
  }

  function makeQueryBuilder<T extends object>(rows: T[]) {
    const predicates: Array<(r: T) => boolean> = [];
    const builder = {
      withIndex(_idx: string, fn?: (q: IndexQuery) => IndexQuery) {
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
            lt(field, value) {
              this.ranges.push({ field, op: "lt", value });
              return this;
            },
          };
          fn(q);
          for (const [field, value] of Object.entries(q.eqs)) {
            predicates.push(
              (r) => (r as Record<string, unknown>)[field] === value,
            );
          }
          for (const range of q.ranges) {
            predicates.push((r) => {
              const v = (r as Record<string, unknown>)[range.field];
              if (typeof v !== "number") return false;
              if (range.op === "gte") return v >= range.value;
              if (range.op === "lte") return v <= range.value;
              return v < range.value;
            });
          }
        }
        return builder;
      },
      async collect(): Promise<T[]> {
        return rows.filter((r) => predicates.every((p) => p(r)));
      },
      async first(): Promise<T | null> {
        for (const r of rows) {
          if (predicates.every((p) => p(r))) return r;
        }
        return null;
      },
    };
    return builder;
  }

  const ctx = {
    db: {
      get: vi.fn(async (id: string) => {
        if (id === USER_ID) return user;
        if (id === SESSION_ID) return session;
        if (users.has(id)) return users.get(id);
        if (lots.has(id)) return lots.get(id);
        if (settings.has(id)) return settings.get(id);
        return null;
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return {
            withIndex: () => ({ collect: async () => userRoles }),
          };
        }
        if (table === "contracts") return makeQueryBuilder(contracts);
        if (table === "appSettings") {
          return makeQueryBuilder(Array.from(settings.values()));
        }
        return {
          collect: async () => [] as unknown[],
          first: async () => null,
          withIndex: () => ({
            collect: async () => [],
            first: async () => null,
          }),
        };
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "appSettings") {
          const id = `appSettings:${nextSettingsId++}`;
          settings.set(id, {
            _id: id,
            _creationTime: T0,
            ...row,
          } as AppSettingsFixture);
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
          settings.set(id, { ...existing, ...patch } as AppSettingsFixture);
        }
        return null;
      }),
    },
  };

  return { settings, contracts, lots, users, auditInserts, ctx };
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

function makeLot(
  id: string,
  overrides: Partial<LotFixture>,
): LotFixture {
  return {
    _id: id,
    _creationTime: T0,
    type: "single",
    section: "A",
    code: id,
    ...overrides,
  };
}

function makeContract(
  id: string,
  overrides: Partial<ContractFixture>,
): ContractFixture {
  return {
    _id: id,
    _creationTime: T0,
    lotId: "lots:1",
    customerId: "customers:1",
    state: "active",
    totalPriceCents: 100_000,
    createdAt: T0,
    ...overrides,
  };
}

const FROM = T0 - 14 * 24 * HOUR_MS;
const TO = T0 + 24 * HOUR_MS;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  mockedGetAuthUserId.mockReset();
  mockedGetAuthSessionId.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("salesByDimension — auth", () => {
  const run = handlerOf(salesByDimension);

  it("rejects unauthenticated callers with UNAUTHENTICATED", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, { from: FROM, to: TO }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("rejects office_staff with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(ctx, { from: FROM, to: TO }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    const thrown = await run(ctx, { from: FROM, to: TO }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("salesByDimension — empty + bad range", () => {
  const run = handlerOf(salesByDimension);

  it("empty contract set → totalCount 0, lotTypes []", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const result = (await run(ctx, { from: FROM, to: TO })) as {
      totalCount: number;
      lotTypes: unknown[];
    };
    expect(result.totalCount).toBe(0);
    expect(result.lotTypes).toEqual([]);
  });

  it("from > to → empty report (no scan)", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      contracts: [makeContract("contracts:1", {})],
      lots: [makeLot("lots:1", {})],
    });
    const result = (await run(ctx, { from: TO, to: FROM })) as {
      totalCount: number;
    };
    expect(result.totalCount).toBe(0);
  });
});

describe("salesByDimension — grouping", () => {
  const run = handlerOf(salesByDimension);

  it("groups sales by lot type → section; excludes voided + cancelled", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      lots: [
        makeLot("lots:1", { type: "single", section: "A" }),
        makeLot("lots:2", { type: "single", section: "A" }),
        makeLot("lots:3", { type: "single", section: "B" }),
        makeLot("lots:4", { type: "family", section: "A" }),
      ],
      contracts: [
        makeContract("contracts:1", {
          lotId: "lots:1",
          state: "active",
          totalPriceCents: 100_000,
          createdAt: T0 - HOUR_MS,
        }),
        makeContract("contracts:2", {
          lotId: "lots:2",
          state: "paid_in_full",
          totalPriceCents: 150_000,
          createdAt: T0 - 2 * HOUR_MS,
        }),
        makeContract("contracts:3", {
          lotId: "lots:3",
          state: "active",
          totalPriceCents: 250_000,
          createdAt: T0 - 3 * HOUR_MS,
        }),
        makeContract("contracts:4", {
          lotId: "lots:4",
          state: "in_default",
          totalPriceCents: 500_000,
          createdAt: T0 - 4 * HOUR_MS,
        }),
        // Voided + cancelled — must be excluded.
        makeContract("contracts:5", {
          lotId: "lots:1",
          state: "voided",
          totalPriceCents: 9_999_999,
          createdAt: T0 - HOUR_MS,
        }),
        makeContract("contracts:6", {
          lotId: "lots:1",
          state: "cancelled",
          totalPriceCents: 9_999_999,
          createdAt: T0 - HOUR_MS,
        }),
      ],
    });

    interface Result {
      totalCount: number;
      totalAmountCents: number;
      salesAgentTrackingEnabled: boolean;
      lotTypes: Array<{
        lotType: string;
        count: number;
        totalAmountCents: number;
        sections: Array<{
          section: string;
          count: number;
          totalAmountCents: number;
          agents?: unknown[];
        }>;
      }>;
    }
    const result = (await run(ctx, { from: FROM, to: TO })) as Result;

    expect(result.totalCount).toBe(4);
    expect(result.totalAmountCents).toBe(1_000_000);
    expect(result.salesAgentTrackingEnabled).toBe(false);

    expect(result.lotTypes).toHaveLength(2);
    const single = result.lotTypes.find((r) => r.lotType === "single")!;
    const family = result.lotTypes.find((r) => r.lotType === "family")!;
    expect(single.count).toBe(3);
    expect(single.totalAmountCents).toBe(500_000);
    expect(family.count).toBe(1);
    expect(family.totalAmountCents).toBe(500_000);

    expect(single.sections).toHaveLength(2);
    const sectionA = single.sections.find((s) => s.section === "A")!;
    const sectionB = single.sections.find((s) => s.section === "B")!;
    expect(sectionA.count).toBe(2);
    expect(sectionA.totalAmountCents).toBe(250_000);
    expect(sectionB.count).toBe(1);
    expect(sectionB.totalAmountCents).toBe(250_000);

    // Defense-in-depth: agent field MUST be absent when toggle off.
    for (const lt of result.lotTypes) {
      for (const sec of lt.sections) {
        expect(sec.agents).toBeUndefined();
      }
    }
  });

  it("excludes contracts outside [from, to]", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      lots: [makeLot("lots:1", { type: "single", section: "A" })],
      contracts: [
        makeContract("contracts:1", {
          lotId: "lots:1",
          createdAt: FROM - HOUR_MS, // before range
        }),
        makeContract("contracts:2", {
          lotId: "lots:1",
          createdAt: TO + HOUR_MS, // after range
        }),
        makeContract("contracts:3", {
          lotId: "lots:1",
          createdAt: T0, // inside
        }),
      ],
    });
    const result = (await run(ctx, { from: FROM, to: TO })) as {
      totalCount: number;
    };
    expect(result.totalCount).toBe(1);
  });
});

describe("salesByDimension — agent branch gating", () => {
  const run = handlerOf(salesByDimension);

  it("setting OFF → no agents key on any section row (defense in depth)", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      lots: [makeLot("lots:1", { type: "single", section: "A" })],
      contracts: [
        makeContract("contracts:1", {
          lotId: "lots:1",
          createdAt: T0,
          // even with agent set on the row, the off toggle must strip
          // it from the response.
          agentId: "users:agent1",
        }),
      ],
      appSettings: [
        {
          _id: "appSettings:1",
          _creationTime: T0,
          key: "singleton",
          salesAgentTrackingEnabled: false,
        },
      ],
    });
    interface Result {
      salesAgentTrackingEnabled: boolean;
      lotTypes: Array<{
        sections: Array<{ agents?: unknown[] }>;
      }>;
    }
    const result = (await run(ctx, { from: FROM, to: TO })) as Result;
    expect(result.salesAgentTrackingEnabled).toBe(false);
    for (const lt of result.lotTypes) {
      for (const sec of lt.sections) {
        expect(sec.agents).toBeUndefined();
      }
    }
  });

  it("setting ON → response carries agents array per section (populated when agentId is present)", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      lots: [makeLot("lots:1", { type: "single", section: "A" })],
      contracts: [
        makeContract("contracts:1", {
          lotId: "lots:1",
          createdAt: T0,
          totalPriceCents: 100_000,
          agentId: "users:agent1",
        }),
        makeContract("contracts:2", {
          lotId: "lots:1",
          createdAt: T0 - HOUR_MS,
          totalPriceCents: 200_000,
          agentId: "users:agent1",
        }),
        makeContract("contracts:3", {
          lotId: "lots:1",
          createdAt: T0 - 2 * HOUR_MS,
          totalPriceCents: 150_000,
          agentId: "users:agent2",
        }),
      ],
      users: [
        { _id: "users:agent1", _creationTime: T0, name: "Alice Cruz" },
        { _id: "users:agent2", _creationTime: T0, name: "Ben Santos" },
      ],
      appSettings: [
        {
          _id: "appSettings:1",
          _creationTime: T0,
          key: "singleton",
          salesAgentTrackingEnabled: true,
        },
      ],
    });
    interface AgentRow {
      agentId: string;
      agentName: string;
      count: number;
      totalAmountCents: number;
    }
    interface Result {
      salesAgentTrackingEnabled: boolean;
      lotTypes: Array<{
        sections: Array<{
          agents?: AgentRow[];
        }>;
      }>;
    }
    const result = (await run(ctx, { from: FROM, to: TO })) as Result;
    expect(result.salesAgentTrackingEnabled).toBe(true);

    const sectionA = result.lotTypes[0]!.sections[0]!;
    expect(sectionA.agents).toBeDefined();
    expect(sectionA.agents!).toHaveLength(2);
    const alice = sectionA.agents!.find((a) => a.agentId === "users:agent1")!;
    const ben = sectionA.agents!.find((a) => a.agentId === "users:agent2")!;
    expect(alice.agentName).toBe("Alice Cruz");
    expect(alice.count).toBe(2);
    expect(alice.totalAmountCents).toBe(300_000);
    expect(ben.agentName).toBe("Ben Santos");
    expect(ben.count).toBe(1);
    expect(ben.totalAmountCents).toBe(150_000);
  });

  it("setting ON but no agentIds → agents arrays present but empty", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      lots: [makeLot("lots:1", { type: "single", section: "A" })],
      contracts: [
        makeContract("contracts:1", { lotId: "lots:1", createdAt: T0 }),
      ],
      appSettings: [
        {
          _id: "appSettings:1",
          _creationTime: T0,
          key: "singleton",
          salesAgentTrackingEnabled: true,
        },
      ],
    });
    interface Result {
      lotTypes: Array<{ sections: Array<{ agents?: unknown[] }> }>;
    }
    const result = (await run(ctx, { from: FROM, to: TO })) as Result;
    expect(result.lotTypes[0]!.sections[0]!.agents).toEqual([]);
  });
});

describe("getAppSettings", () => {
  const run = handlerOf(getAppSettings);

  it("admin reads absent-row default → salesAgentTrackingEnabled: false", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const result = (await run(ctx, {})) as { salesAgentTrackingEnabled: boolean };
    expect(result.salesAgentTrackingEnabled).toBe(false);
  });

  it("admin reads existing row", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      appSettings: [
        {
          _id: "appSettings:1",
          _creationTime: T0,
          key: "singleton",
          salesAgentTrackingEnabled: true,
        },
      ],
    });
    const result = (await run(ctx, {})) as { salesAgentTrackingEnabled: boolean };
    expect(result.salesAgentTrackingEnabled).toBe(true);
  });

  it("rejects non-admin with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("setSalesAgentTracking", () => {
  const run = handlerOf(setSalesAgentTracking);

  it("admin inserts singleton row + emits create audit on first set", async () => {
    const { ctx, settings, auditInserts } = makeCtx({ roles: ["admin"] });
    await run(ctx, { enabled: true });
    expect(settings.size).toBe(1);
    const rows = Array.from(settings.values());
    expect(rows[0]!.salesAgentTrackingEnabled).toBe(true);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]!.row.action).toBe("create");
    expect(auditInserts[0]!.row.entityType).toBe("user");
    expect(auditInserts[0]!.row.after).toMatchObject({
      kind: "appSetting",
      salesAgentTrackingEnabled: true,
    });
  });

  it("admin patches existing row + emits update audit when value changes", async () => {
    const { ctx, auditInserts } = makeCtx({
      roles: ["admin"],
      appSettings: [
        {
          _id: "appSettings:1",
          _creationTime: T0,
          key: "singleton",
          salesAgentTrackingEnabled: false,
        },
      ],
    });
    await run(ctx, { enabled: true });
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]!.row.action).toBe("update");
    expect(auditInserts[0]!.row.before).toMatchObject({
      salesAgentTrackingEnabled: false,
    });
    expect(auditInserts[0]!.row.after).toMatchObject({
      salesAgentTrackingEnabled: true,
    });
  });

  it("no-op short-circuit when value unchanged → no audit emission", async () => {
    const { ctx, auditInserts } = makeCtx({
      roles: ["admin"],
      appSettings: [
        {
          _id: "appSettings:1",
          _creationTime: T0,
          key: "singleton",
          salesAgentTrackingEnabled: true,
        },
      ],
    });
    await run(ctx, { enabled: true });
    expect(auditInserts).toHaveLength(0);
  });

  it("rejects non-admin with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(ctx, { enabled: true }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, { enabled: true }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});
