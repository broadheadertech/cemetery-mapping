/**
 * Story 4.2 — `convex/followUpActions.ts` unit tests.
 *
 * Hand-mocked ctx pattern (mirrors `occupants.test.ts`, `arAging.test.ts`).
 * `convex-test` requires `_generated/`, which this repo deliberately
 * avoids; we reproduce just enough of `ctx.db` to drive the public
 * mutations + queries end-to-end.
 *
 * Coverage focus:
 *   - createFollowUp: happy path, validation (action enum, dueAt past,
 *     notes too long), state guard (only overdue installments allowed),
 *     not-found installment, RBAC (field_worker rejected, unauth).
 *   - listForInstallment: returns rows sorted newest-first.
 *   - listOpenFollowUps: only `open` rows, sorted by `dueAt` ascending.
 *   - markComplete: happy path, idempotency on already-completed,
 *     rejection on cancelled, audit emission, RBAC.
 *   - markCancelled: happy path, idempotency on already-cancelled,
 *     rejection on completed, audit emission, RBAC.
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
  createFollowUp,
  listForInstallment,
  listOpenFollowUps,
  markCancelled,
  markComplete,
} from "../../../convex/followUpActions";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-05-20T08:00:00+08:00").getTime();
const USER_ID = "users:abc123";
const SESSION_ID = "authSessions:def456";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface ContractFixture {
  _id: string;
  _creationTime: number;
  lotId: string;
  state: string;
}

interface InstallmentFixture {
  _id: string;
  _creationTime: number;
  contractId: string;
  installmentNumber: number;
  dueDate: number;
  principalCents: number;
  paidCents: number;
  status: "pending" | "paid" | "overdue" | "waived";
}

interface FollowUpFixture {
  _id: string;
  _creationTime: number;
  installmentId: string;
  action: "phone_call" | "sms" | "letter" | "in_person" | "other";
  notes?: string;
  dueAt: number;
  status: "open" | "completed" | "cancelled";
  createdAt: number;
  createdBy: string;
  completedAt?: number;
  completedBy?: string;
}

interface AuditInsert {
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
  contracts: Map<string, ContractFixture>;
  installments: Map<string, InstallmentFixture>;
  followUps: Map<string, FollowUpFixture>;
  auditInserts: AuditInsert[];
  patches: Array<{ id: string; patch: Record<string, unknown> }>;
  scheduled: Array<{ delayMs: number; ref: unknown; args: unknown }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  contracts?: ContractFixture[];
  installments?: InstallmentFixture[];
  followUps?: FollowUpFixture[];
  authenticated?: boolean;
}): CtxBag {
  const contracts = new Map<string, ContractFixture>(
    (opts.contracts ?? []).map((c) => [c._id, c]),
  );
  const installments = new Map<string, InstallmentFixture>(
    (opts.installments ?? []).map((i) => [i._id, i]),
  );
  const followUps = new Map<string, FollowUpFixture>(
    (opts.followUps ?? []).map((f) => [f._id, f]),
  );
  const auditInserts: AuditInsert[] = [];
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const scheduled: Array<{ delayMs: number; ref: unknown; args: unknown }> =
    [];

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
    email: "office@example.com",
    isActive: true,
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

  type Predicate = (r: Record<string, unknown>) => boolean;

  function rowsForTable(table: string): Record<string, unknown>[] {
    if (table === "followUpActions") {
      return Array.from(followUps.values()) as unknown as Record<
        string,
        unknown
      >[];
    }
    if (table === "contracts") {
      return Array.from(contracts.values()) as unknown as Record<
        string,
        unknown
      >[];
    }
    if (table === "installments") {
      return Array.from(installments.values()) as unknown as Record<
        string,
        unknown
      >[];
    }
    return [];
  }

  interface IndexQuery {
    eqs: Record<string, unknown>;
    eq(field: string, value: unknown): IndexQuery;
  }

  function makeQueryBuilder(table: string) {
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
              (r) => (r as Record<string, unknown>)[field] === value,
            );
          }
        }
        return builder;
      },
      async collect(): Promise<Record<string, unknown>[]> {
        return rowsForTable(table).filter((r) =>
          predicates.every((p) => p(r)),
        );
      },
      async first(): Promise<Record<string, unknown> | null> {
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
        if (contracts.has(id)) return contracts.get(id);
        if (installments.has(id)) return installments.get(id);
        if (followUps.has(id)) return followUps.get(id);
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
        return makeQueryBuilder(table);
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "followUpActions") {
          const id = `followUpActions:${nextId++}`;
          followUps.set(id, {
            _id: id,
            _creationTime: T0,
            ...row,
          } as FollowUpFixture);
          return id;
        }
        if (table === "auditLog") {
          auditInserts.push({ row: row as AuditInsert["row"] });
          return `auditLog:${auditInserts.length}`;
        }
        return `${table}:?`;
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        patches.push({ id, patch });
        const existing = followUps.get(id);
        if (existing !== undefined) {
          followUps.set(id, { ...existing, ...patch } as FollowUpFixture);
        }
      }),
    },
    scheduler: {
      runAfter: vi.fn(async (delayMs: number, ref: unknown, args: unknown) => {
        scheduled.push({ delayMs, ref, args });
        return `scheduled:${scheduled.length}`;
      }),
    },
  };

  return {
    contracts,
    installments,
    followUps,
    auditInserts,
    patches,
    scheduled,
    ctx,
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

function makeContract(
  overrides: Partial<ContractFixture> = {},
): ContractFixture {
  return {
    _id: overrides._id ?? "contracts:1",
    _creationTime: T0,
    lotId: overrides.lotId ?? "lots:1",
    state: overrides.state ?? "active",
  };
}

function makeInstallment(
  overrides: Partial<InstallmentFixture> = {},
): InstallmentFixture {
  return {
    _id: overrides._id ?? "installments:1",
    _creationTime: T0,
    contractId: overrides.contractId ?? "contracts:1",
    installmentNumber: overrides.installmentNumber ?? 1,
    dueDate: overrides.dueDate ?? T0 - 30 * DAY_MS,
    principalCents: overrides.principalCents ?? 5_000_00,
    paidCents: overrides.paidCents ?? 0,
    status: overrides.status ?? "overdue",
  };
}

function makeFollowUp(
  overrides: Partial<FollowUpFixture> = {},
): FollowUpFixture {
  return {
    _id: overrides._id ?? "followUpActions:base",
    _creationTime: T0,
    installmentId: overrides.installmentId ?? "installments:1",
    action: overrides.action ?? "phone_call",
    notes: overrides.notes,
    dueAt: overrides.dueAt ?? T0 + 7 * DAY_MS,
    status: overrides.status ?? "open",
    createdAt: overrides.createdAt ?? T0 - HOUR_MS,
    createdBy: overrides.createdBy ?? USER_ID,
    completedAt: overrides.completedAt,
    completedBy: overrides.completedBy,
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

describe("createFollowUp", () => {
  const run = handlerOf(createFollowUp);

  it("happy path: inserts a follow-up, emits audit keyed on lot id (office_staff)", async () => {
    const contract = makeContract({ lotId: "lots:42" });
    const installment = makeInstallment({
      contractId: contract._id,
      status: "overdue",
    });
    const bag = makeCtx({
      roles: ["office_staff"],
      contracts: [contract],
      installments: [installment],
    });

    const result = (await run(bag.ctx, {
      installmentId: installment._id,
      action: "phone_call",
      dueAt: T0 + 7 * DAY_MS,
      notes: "  Called, will pay Friday  ",
    })) as { followUpActionId: string };

    expect(bag.followUps.size).toBe(1);
    const row = bag.followUps.get(result.followUpActionId)!;
    expect(row.installmentId).toBe(installment._id);
    expect(row.action).toBe("phone_call");
    expect(row.notes).toBe("Called, will pay Friday");
    expect(row.dueAt).toBe(T0 + 7 * DAY_MS);
    expect(row.status).toBe("open");
    expect(row.createdBy).toBe(USER_ID);
    expect(row.createdAt).toBe(T0);

    expect(bag.auditInserts).toHaveLength(1);
    const audit = bag.auditInserts[0]!;
    expect(audit.row.action).toBe("create");
    expect(audit.row.entityType).toBe("lot");
    expect(audit.row.entityId).toBe("lots:42");
    expect(audit.row.reason).toBe("Called, will pay Friday");

    // Epic 4 adversarial-review fix (2026-05-24): createFollowUp
    // schedules the AR aging recompute for the affected contract so
    // the `overdueCountWithAction` / `overdueCountSilent` split flips
    // within seconds. One scheduler entry, delayMs 0, args carry the
    // contract id.
    expect(bag.scheduled).toHaveLength(1);
    expect(bag.scheduled[0]!.delayMs).toBe(0);
    expect(bag.scheduled[0]!.args).toEqual({ contractId: contract._id });
  });

  it("blank notes are stored as undefined (not as empty string)", async () => {
    const contract = makeContract();
    const installment = makeInstallment({ status: "overdue" });
    const bag = makeCtx({
      contracts: [contract],
      installments: [installment],
    });
    const result = (await run(bag.ctx, {
      installmentId: installment._id,
      action: "sms",
      dueAt: T0 + DAY_MS,
      notes: "   ",
    })) as { followUpActionId: string };
    const row = bag.followUps.get(result.followUpActionId)!;
    expect(row.notes).toBeUndefined();
  });

  it("rejects an installment that is not overdue", async () => {
    const contract = makeContract();
    const installment = makeInstallment({ status: "paid" });
    const bag = makeCtx({
      contracts: [contract],
      installments: [installment],
    });
    const thrown = await run(bag.ctx, {
      installmentId: installment._id,
      action: "phone_call",
      dueAt: T0 + DAY_MS,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("rejects an unknown action channel as VALIDATION", async () => {
    const contract = makeContract();
    const installment = makeInstallment({ status: "overdue" });
    const bag = makeCtx({
      contracts: [contract],
      installments: [installment],
    });
    const thrown = await run(bag.ctx, {
      installmentId: installment._id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      action: "carrier_pigeon" as any,
      dueAt: T0 + DAY_MS,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects a dueAt that is far in the past", async () => {
    const contract = makeContract();
    const installment = makeInstallment({ status: "overdue" });
    const bag = makeCtx({
      contracts: [contract],
      installments: [installment],
    });
    const thrown = await run(bag.ctx, {
      installmentId: installment._id,
      action: "phone_call",
      dueAt: T0 - 10 * DAY_MS,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects notes longer than 500 chars", async () => {
    const contract = makeContract();
    const installment = makeInstallment({ status: "overdue" });
    const bag = makeCtx({
      contracts: [contract],
      installments: [installment],
    });
    const thrown = await run(bag.ctx, {
      installmentId: installment._id,
      action: "phone_call",
      dueAt: T0 + DAY_MS,
      notes: "x".repeat(501),
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects missing installment as NOT_FOUND", async () => {
    const bag = makeCtx({ contracts: [makeContract()] });
    const thrown = await run(bag.ctx, {
      installmentId: "installments:ghost",
      action: "phone_call",
      dueAt: T0 + DAY_MS,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("rejects field_worker as FORBIDDEN", async () => {
    const contract = makeContract();
    const installment = makeInstallment({ status: "overdue" });
    const bag = makeCtx({
      roles: ["field_worker"],
      contracts: [contract],
      installments: [installment],
    });
    const thrown = await run(bag.ctx, {
      installmentId: installment._id,
      action: "phone_call",
      dueAt: T0 + DAY_MS,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const bag = makeCtx({
      authenticated: false,
      contracts: [makeContract()],
      installments: [makeInstallment()],
    });
    const thrown = await run(bag.ctx, {
      installmentId: "installments:1",
      action: "phone_call",
      dueAt: T0 + DAY_MS,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("admin can also create a follow-up", async () => {
    const contract = makeContract();
    const installment = makeInstallment({ status: "overdue" });
    const bag = makeCtx({
      roles: ["admin"],
      contracts: [contract],
      installments: [installment],
    });
    const result = (await run(bag.ctx, {
      installmentId: installment._id,
      action: "letter",
      dueAt: T0 + DAY_MS,
    })) as { followUpActionId: string };
    expect(bag.followUps.has(result.followUpActionId)).toBe(true);
  });
});

describe("listForInstallment", () => {
  const run = handlerOf(listForInstallment);

  it("returns rows sorted by createdAt descending", async () => {
    const installmentId = "installments:1";
    const followUps: FollowUpFixture[] = [
      makeFollowUp({
        _id: "followUpActions:1",
        installmentId,
        createdAt: T0 - 2 * HOUR_MS,
      }),
      makeFollowUp({
        _id: "followUpActions:2",
        installmentId,
        createdAt: T0 - HOUR_MS,
      }),
      makeFollowUp({
        _id: "followUpActions:3",
        installmentId,
        createdAt: T0 - 3 * HOUR_MS,
      }),
    ];
    const bag = makeCtx({ followUps });
    const result = (await run(bag.ctx, { installmentId })) as Array<{
      followUpActionId: string;
    }>;
    expect(result.map((r) => r.followUpActionId)).toEqual([
      "followUpActions:2",
      "followUpActions:1",
      "followUpActions:3",
    ]);
  });

  it("rejects unauthenticated callers", async () => {
    const bag = makeCtx({ authenticated: false });
    const thrown = await run(bag.ctx, {
      installmentId: "installments:1",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});

describe("listOpenFollowUps", () => {
  const run = handlerOf(listOpenFollowUps);

  it("returns only `open` rows, sorted by dueAt ascending", async () => {
    const followUps: FollowUpFixture[] = [
      makeFollowUp({
        _id: "followUpActions:1",
        status: "open",
        dueAt: T0 + 7 * DAY_MS,
      }),
      makeFollowUp({
        _id: "followUpActions:2",
        status: "completed",
        dueAt: T0 + DAY_MS,
      }),
      makeFollowUp({
        _id: "followUpActions:3",
        status: "open",
        dueAt: T0 + 2 * DAY_MS,
      }),
      makeFollowUp({
        _id: "followUpActions:4",
        status: "cancelled",
        dueAt: T0,
      }),
    ];
    const bag = makeCtx({ followUps });
    const result = (await run(bag.ctx, {})) as Array<{
      followUpActionId: string;
      status: string;
      dueAt: number;
    }>;
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.followUpActionId)).toEqual([
      "followUpActions:3",
      "followUpActions:1",
    ]);
    for (const r of result) {
      expect(r.status).toBe("open");
    }
  });

  it("rejects field_worker", async () => {
    const bag = makeCtx({ roles: ["field_worker"] });
    const thrown = await run(bag.ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("markComplete", () => {
  const run = handlerOf(markComplete);

  it("happy path: patches the row to completed and emits audit", async () => {
    const contract = makeContract({ lotId: "lots:7" });
    const installment = makeInstallment({ contractId: contract._id });
    const followUp = makeFollowUp({
      _id: "followUpActions:1",
      installmentId: installment._id,
      status: "open",
    });
    const bag = makeCtx({
      contracts: [contract],
      installments: [installment],
      followUps: [followUp],
    });
    await run(bag.ctx, { followUpActionId: followUp._id });
    const patched = bag.followUps.get(followUp._id)!;
    expect(patched.status).toBe("completed");
    expect(patched.completedAt).toBe(T0);
    expect(patched.completedBy).toBe(USER_ID);
    expect(bag.auditInserts).toHaveLength(1);
    expect(bag.auditInserts[0]!.row.entityType).toBe("lot");
    expect(bag.auditInserts[0]!.row.entityId).toBe("lots:7");
  });

  it("is idempotent on already-completed rows (no patch, no audit)", async () => {
    const contract = makeContract();
    const installment = makeInstallment({ contractId: contract._id });
    const followUp = makeFollowUp({
      _id: "followUpActions:1",
      installmentId: installment._id,
      status: "completed",
      completedAt: T0 - HOUR_MS,
      completedBy: USER_ID,
    });
    const bag = makeCtx({
      contracts: [contract],
      installments: [installment],
      followUps: [followUp],
    });
    await run(bag.ctx, { followUpActionId: followUp._id });
    expect(bag.patches).toHaveLength(0);
    expect(bag.auditInserts).toHaveLength(0);
  });

  it("rejects already-cancelled rows with INVARIANT_VIOLATION", async () => {
    const contract = makeContract();
    const installment = makeInstallment({ contractId: contract._id });
    const followUp = makeFollowUp({
      _id: "followUpActions:1",
      installmentId: installment._id,
      status: "cancelled",
    });
    const bag = makeCtx({
      contracts: [contract],
      installments: [installment],
      followUps: [followUp],
    });
    const thrown = await run(bag.ctx, {
      followUpActionId: followUp._id,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("rejects missing follow-up as NOT_FOUND", async () => {
    const bag = makeCtx({});
    const thrown = await run(bag.ctx, {
      followUpActionId: "followUpActions:ghost",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("rejects field_worker as FORBIDDEN", async () => {
    const contract = makeContract();
    const installment = makeInstallment({ contractId: contract._id });
    const followUp = makeFollowUp({
      _id: "followUpActions:1",
      installmentId: installment._id,
      status: "open",
    });
    const bag = makeCtx({
      roles: ["field_worker"],
      contracts: [contract],
      installments: [installment],
      followUps: [followUp],
    });
    const thrown = await run(bag.ctx, {
      followUpActionId: followUp._id,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("markCancelled", () => {
  const run = handlerOf(markCancelled);

  it("happy path: patches the row to cancelled and emits audit", async () => {
    const contract = makeContract({ lotId: "lots:11" });
    const installment = makeInstallment({ contractId: contract._id });
    const followUp = makeFollowUp({
      _id: "followUpActions:1",
      installmentId: installment._id,
      status: "open",
    });
    const bag = makeCtx({
      contracts: [contract],
      installments: [installment],
      followUps: [followUp],
    });
    await run(bag.ctx, { followUpActionId: followUp._id });
    const patched = bag.followUps.get(followUp._id)!;
    expect(patched.status).toBe("cancelled");
    expect(patched.completedAt).toBe(T0);
    expect(patched.completedBy).toBe(USER_ID);
    expect(bag.auditInserts).toHaveLength(1);
    expect(bag.auditInserts[0]!.row.entityId).toBe("lots:11");
  });

  it("is idempotent on already-cancelled rows", async () => {
    const contract = makeContract();
    const installment = makeInstallment({ contractId: contract._id });
    const followUp = makeFollowUp({
      _id: "followUpActions:1",
      installmentId: installment._id,
      status: "cancelled",
    });
    const bag = makeCtx({
      contracts: [contract],
      installments: [installment],
      followUps: [followUp],
    });
    await run(bag.ctx, { followUpActionId: followUp._id });
    expect(bag.patches).toHaveLength(0);
    expect(bag.auditInserts).toHaveLength(0);
  });

  it("rejects completed rows with INVARIANT_VIOLATION", async () => {
    const contract = makeContract();
    const installment = makeInstallment({ contractId: contract._id });
    const followUp = makeFollowUp({
      _id: "followUpActions:1",
      installmentId: installment._id,
      status: "completed",
    });
    const bag = makeCtx({
      contracts: [contract],
      installments: [installment],
      followUps: [followUp],
    });
    const thrown = await run(bag.ctx, {
      followUpActionId: followUp._id,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("rejects unauthenticated callers", async () => {
    const bag = makeCtx({ authenticated: false });
    const thrown = await run(bag.ctx, {
      followUpActionId: "followUpActions:1",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});
