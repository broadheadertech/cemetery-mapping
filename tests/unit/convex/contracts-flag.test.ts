/**
 * Story 5.4 — Admin flags a contract for staff follow-up (FR44).
 *
 * Scope:
 *   - `flagContract` mutation: admin-only role gate, reason validation
 *     (empty / whitespace-only / over 280 chars), NOT_FOUND on missing
 *     contract, patch shape (`isFlagged`, `flagReason`, `flaggedAt`,
 *     `flaggedBy`), audit emission, re-flag (update reason in place)
 *     path.
 *   - `unflagContract` mutation: admin-only role gate, NOT_FOUND on
 *     missing contract, idempotent clear (no throw when already
 *     unflagged), audit emission, patch shape.
 *   - `listFlaggedContracts` query: admin + office_staff role gate,
 *     ordering (most-recently-flagged first), per-row hydration of lot
 *     code + customer name + flagger name, defensive skip on partial
 *     patches.
 *
 * Strategy: hand-mocked ctx mirroring `contracts-pdf.test.ts`. The
 * mock supports `contracts` / `lots` / `customers` / `users` lookups
 * plus the indexed `withIndex("by_isFlagged")` collect path used by
 * `listFlaggedContracts`. `convex-test` is not used here because this
 * repo deliberately avoids `convex/_generated/` (see `convex/gpsImport.ts`
 * for the rationale).
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
  flagContract,
  listFlaggedContracts,
  unflagContract,
} from "../../../convex/contracts";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-05-20T08:00:00+08:00").getTime();
const USER_ID = "users:admin1";
const SESSION_ID = "authSessions:sess1";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface ContractFixture {
  _id: string;
  _creationTime: number;
  contractNumber: string;
  lotId: string;
  customerId: string;
  kind: "full_payment" | "installment";
  totalPriceCents: number;
  state: "active" | "paid_in_full" | "cancelled" | "voided" | "in_default";
  createdAt: number;
  createdBy: string;
  isFlagged?: boolean;
  flagReason?: string;
  flaggedAt?: number;
  flaggedBy?: string;
}

interface LotFixture {
  _id: string;
  _creationTime: number;
  code: string;
}

interface CustomerFixture {
  _id: string;
  _creationTime: number;
  fullName: string;
}

interface UserFixture {
  _id: string;
  _creationTime: number;
  name?: string;
  email?: string;
}

interface CtxBag {
  contracts: Map<string, ContractFixture>;
  lots: Map<string, LotFixture>;
  customers: Map<string, CustomerFixture>;
  users: Map<string, UserFixture>;
  auditInserts: Array<{ row: Record<string, unknown> }>;
  patches: Array<{ id: string; patch: Record<string, unknown> }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  initialContracts?: ContractFixture[];
  initialLots?: LotFixture[];
  initialCustomers?: CustomerFixture[];
  initialUsers?: UserFixture[];
  authenticated?: boolean;
  userId?: string;
}): CtxBag {
  const callerUserId = opts.userId ?? USER_ID;
  const contracts = new Map<string, ContractFixture>(
    (opts.initialContracts ?? []).map((c) => [c._id, c]),
  );
  const lots = new Map<string, LotFixture>(
    (opts.initialLots ?? []).map((l) => [l._id, l]),
  );
  const customers = new Map<string, CustomerFixture>(
    (opts.initialCustomers ?? []).map((c) => [c._id, c]),
  );
  // Always include the caller user record (so the audit `actor` resolves)
  // alongside any extras (e.g. additional admins for the flagger-name
  // hydration in `listFlaggedContracts`).
  const baseUsers: UserFixture[] = [
    {
      _id: callerUserId,
      _creationTime: T0 - 1000,
      email: "admin@example.com",
      name: "Admin User",
    },
    ...(opts.initialUsers ?? []),
  ];
  const users = new Map<string, UserFixture>(baseUsers.map((u) => [u._id, u]));
  const auditInserts: Array<{ row: Record<string, unknown> }> = [];
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];

  if (opts.authenticated === false) {
    mockedGetAuthUserId.mockResolvedValue(null);
    mockedGetAuthSessionId.mockResolvedValue(null);
  } else {
    mockedGetAuthUserId.mockResolvedValue(callerUserId as never);
    mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);
  }

  const session = {
    _id: SESSION_ID,
    _creationTime: T0,
    userId: callerUserId,
    expirationTime: T0 + 30 * 24 * HOUR_MS,
  };
  const userRoles = (opts.roles ?? ["admin"]).map((role, idx) => ({
    _id: `userRoles:${idx}`,
    _creationTime: T0,
    userId: callerUserId,
    role,
    grantedAt: T0,
    grantedBy: callerUserId,
  }));

  interface IndexQuery {
    eqs: Record<string, unknown>;
    eq(field: string, value: unknown): IndexQuery;
  }

  function makeContractsQueryBuilder() {
    const predicates: Array<(c: ContractFixture) => boolean> = [];
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
              (c) => (c as unknown as Record<string, unknown>)[field] === value,
            );
          }
        }
        return builder;
      },
      async collect(): Promise<ContractFixture[]> {
        return Array.from(contracts.values()).filter((c) =>
          predicates.every((p) => p(c)),
        );
      },
    };
    return builder;
  }

  function tableQuery(table: string) {
    if (table === "userRoles") {
      return {
        withIndex: () => ({
          collect: async () => userRoles,
        }),
      };
    }
    if (table === "contracts") {
      return makeContractsQueryBuilder();
    }
    return {
      withIndex: () => ({
        collect: async () => [],
        first: async () => null,
      }),
      collect: async () => [],
    };
  }

  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === SESSION_ID) return session;
        if (users.has(id)) return users.get(id);
        if (contracts.has(id)) return contracts.get(id);
        if (lots.has(id)) return lots.get(id);
        if (customers.has(id)) return customers.get(id);
        return null;
      }),
      query: vi.fn((table: string) => tableQuery(table)),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "auditLog") {
          auditInserts.push({ row });
          return `auditLog:${auditInserts.length}`;
        }
        return `${table}:?`;
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        patches.push({ id, patch });
        if (contracts.has(id)) {
          const existing = contracts.get(id)!;
          const merged: ContractFixture = { ...existing };
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined) {
              delete (merged as unknown as Record<string, unknown>)[k];
            } else {
              (merged as unknown as Record<string, unknown>)[k] = v;
            }
          }
          contracts.set(id, merged);
        }
      }),
    },
  };

  return {
    contracts,
    lots,
    customers,
    users,
    auditInserts,
    patches,
    ctx,
  };
}

function makeContract(
  overrides: Partial<ContractFixture> = {},
): ContractFixture {
  return {
    _id: overrides._id ?? "contracts:1",
    _creationTime: T0,
    contractNumber: "CON-20260520-A-1-0001",
    lotId: "lots:1",
    customerId: "customers:1",
    kind: "installment",
    totalPriceCents: 150_000_00,
    state: "active",
    createdAt: T0,
    createdBy: USER_ID,
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

describe("flagContract", () => {
  const run = handlerOf(flagContract);

  it("flags a contract — patches the four flag fields + emits an audit row", async () => {
    const contract = makeContract();
    const bag = makeCtx({
      roles: ["admin"],
      initialContracts: [contract],
    });
    const result = (await run(bag.ctx, {
      contractId: contract._id,
      reason: "  Customer called about installment 5  ",
    })) as { contractId: string; flaggedAt: number };
    expect(result.contractId).toBe(contract._id);
    expect(result.flaggedAt).toBe(T0);

    // Patch shape — `reason` is trimmed.
    expect(bag.patches).toHaveLength(1);
    const patch = bag.patches[0]!.patch;
    expect(patch.isFlagged).toBe(true);
    expect(patch.flagReason).toBe("Customer called about installment 5");
    expect(patch.flaggedAt).toBe(T0);
    expect(patch.flaggedBy).toBe(USER_ID);

    // Audit row recorded the flag.
    expect(bag.auditInserts).toHaveLength(1);
    const auditRow = bag.auditInserts[0]!.row;
    expect(auditRow.action).toBe("update");
    expect(auditRow.entityType).toBe("contract");
    expect(auditRow.entityId).toBe(contract._id);
    expect(auditRow.reason).toBe("Contract flagged for staff follow-up.");
    const after = auditRow.after as { isFlagged?: unknown };
    expect(after.isFlagged).toBe(true);
  });

  it("rejects office_staff with FORBIDDEN (admin-only per AC3)", async () => {
    const contract = makeContract();
    const bag = makeCtx({
      roles: ["office_staff"],
      initialContracts: [contract],
    });
    const thrown = await run(bag.ctx, {
      contractId: contract._id,
      reason: "Should not work",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
    expect(bag.patches).toHaveLength(0);
    expect(bag.auditInserts).toHaveLength(0);
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const contract = makeContract();
    const bag = makeCtx({
      roles: ["field_worker"],
      initialContracts: [contract],
    });
    const thrown = await run(bag.ctx, {
      contractId: contract._id,
      reason: "Field worker tries to flag",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const contract = makeContract();
    const bag = makeCtx({
      authenticated: false,
      initialContracts: [contract],
    });
    const thrown = await run(bag.ctx, {
      contractId: contract._id,
      reason: "Anon flag attempt",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("rejects empty reason with VALIDATION", async () => {
    const contract = makeContract();
    const bag = makeCtx({
      roles: ["admin"],
      initialContracts: [contract],
    });
    const thrown = await run(bag.ctx, {
      contractId: contract._id,
      reason: "",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    expect(bag.patches).toHaveLength(0);
  });

  it("rejects whitespace-only reason with VALIDATION", async () => {
    const contract = makeContract();
    const bag = makeCtx({
      roles: ["admin"],
      initialContracts: [contract],
    });
    const thrown = await run(bag.ctx, {
      contractId: contract._id,
      reason: "    ",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects over-length reason (281 chars) with VALIDATION", async () => {
    const contract = makeContract();
    const bag = makeCtx({
      roles: ["admin"],
      initialContracts: [contract],
    });
    const thrown = await run(bag.ctx, {
      contractId: contract._id,
      reason: "x".repeat(281),
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("accepts exactly 280-char reason", async () => {
    const contract = makeContract();
    const bag = makeCtx({
      roles: ["admin"],
      initialContracts: [contract],
    });
    const reason280 = "y".repeat(280);
    const result = (await run(bag.ctx, {
      contractId: contract._id,
      reason: reason280,
    })) as { flaggedAt: number };
    expect(result.flaggedAt).toBe(T0);
    expect(bag.patches[0]!.patch.flagReason).toBe(reason280);
  });

  it("throws NOT_FOUND when the contract does not exist", async () => {
    const bag = makeCtx({ roles: ["admin"], initialContracts: [] });
    const thrown = await run(bag.ctx, {
      contractId: "contracts:ghost",
      reason: "Doesn't matter",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("re-flagging an already-flagged contract replaces the reason + timestamp", async () => {
    const contract = makeContract({
      isFlagged: true,
      flagReason: "Old reason",
      flaggedAt: T0 - 10_000,
      flaggedBy: USER_ID,
    });
    const bag = makeCtx({
      roles: ["admin"],
      initialContracts: [contract],
    });
    await run(bag.ctx, {
      contractId: contract._id,
      reason: "Updated reason",
    });
    const patch = bag.patches[0]!.patch;
    expect(patch.flagReason).toBe("Updated reason");
    expect(patch.flaggedAt).toBe(T0);
    // Audit `before` captures the prior flag state for review.
    const auditRow = bag.auditInserts[0]!.row;
    const before = auditRow.before as { flagReason?: unknown };
    expect(before.flagReason).toBe("Old reason");
  });
});

describe("unflagContract", () => {
  const run = handlerOf(unflagContract);

  it("clears the flag fields + emits an audit row", async () => {
    const contract = makeContract({
      isFlagged: true,
      flagReason: "Some reason",
      flaggedAt: T0 - 5_000,
      flaggedBy: USER_ID,
    });
    const bag = makeCtx({
      roles: ["admin"],
      initialContracts: [contract],
    });
    const result = (await run(bag.ctx, {
      contractId: contract._id,
    })) as { contractId: string };
    expect(result.contractId).toBe(contract._id);

    // Patch clears all four fields.
    expect(bag.patches).toHaveLength(1);
    const patch = bag.patches[0]!.patch;
    expect(patch.isFlagged).toBe(false);
    expect(patch.flagReason).toBeUndefined();
    expect(patch.flaggedAt).toBeUndefined();
    expect(patch.flaggedBy).toBeUndefined();

    // Audit row recorded the clear.
    const auditRow = bag.auditInserts[0]!.row;
    expect(auditRow.action).toBe("update");
    expect(auditRow.entityType).toBe("contract");
    expect(auditRow.reason).toBe("Contract follow-up flag cleared.");
    const before = auditRow.before as { isFlagged?: unknown };
    expect(before.isFlagged).toBe(true);
  });

  it("is idempotent — clearing an already-unflagged contract does not throw", async () => {
    const contract = makeContract();
    const bag = makeCtx({
      roles: ["admin"],
      initialContracts: [contract],
    });
    const result = (await run(bag.ctx, {
      contractId: contract._id,
    })) as { contractId: string };
    expect(result.contractId).toBe(contract._id);
    // Still emits an audit row + patch so reviewers can see the clear
    // was attempted; the operator's intent is satisfied either way.
    expect(bag.auditInserts).toHaveLength(1);
    expect(bag.patches).toHaveLength(1);
  });

  it("rejects office_staff with FORBIDDEN", async () => {
    const contract = makeContract({ isFlagged: true, flagReason: "x", flaggedAt: T0, flaggedBy: USER_ID });
    const bag = makeCtx({
      roles: ["office_staff"],
      initialContracts: [contract],
    });
    const thrown = await run(bag.ctx, { contractId: contract._id }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
    expect(bag.patches).toHaveLength(0);
  });

  it("rejects unauthenticated callers", async () => {
    const contract = makeContract();
    const bag = makeCtx({
      authenticated: false,
      initialContracts: [contract],
    });
    const thrown = await run(bag.ctx, { contractId: contract._id }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("throws NOT_FOUND when the contract does not exist", async () => {
    const bag = makeCtx({ roles: ["admin"], initialContracts: [] });
    const thrown = await run(bag.ctx, {
      contractId: "contracts:ghost",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });
});

describe("listFlaggedContracts", () => {
  const run = handlerOf(listFlaggedContracts);

  function flaggedContract(
    id: string,
    flaggedAt: number,
    reason: string,
  ): ContractFixture {
    return makeContract({
      _id: id,
      isFlagged: true,
      flagReason: reason,
      flaggedAt,
      flaggedBy: USER_ID,
    });
  }

  it("returns flagged contracts sorted by flaggedAt desc, hydrating lot + customer + flagger names", async () => {
    const older = flaggedContract("contracts:older", T0 - 10_000, "Older");
    const newer = flaggedContract("contracts:newer", T0 - 1_000, "Newer");
    const unflagged = makeContract({ _id: "contracts:plain" });
    const bag = makeCtx({
      roles: ["admin"],
      initialContracts: [older, newer, unflagged],
      initialLots: [
        { _id: "lots:1", _creationTime: T0, code: "A-12-3" },
      ],
      initialCustomers: [
        { _id: "customers:1", _creationTime: T0, fullName: "Juan Dela Cruz" },
      ],
    });
    const rows = (await run(bag.ctx, {})) as Array<{
      contractId: string;
      flagReason: string;
      flaggedAt: number;
      lotCode: string;
      customerFullName: string;
      flaggedByName: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.contractId).toBe("contracts:newer");
    expect(rows[1]!.contractId).toBe("contracts:older");
    expect(rows[0]!.lotCode).toBe("A-12-3");
    expect(rows[0]!.customerFullName).toBe("Juan Dela Cruz");
    expect(rows[0]!.flaggedByName).toBe("Admin User");
  });

  it("permits office_staff (staff queue read access)", async () => {
    const bag = makeCtx({
      roles: ["office_staff"],
      initialContracts: [
        flaggedContract("contracts:1", T0 - 500, "A reason"),
      ],
      initialLots: [{ _id: "lots:1", _creationTime: T0, code: "L-1" }],
      initialCustomers: [
        { _id: "customers:1", _creationTime: T0, fullName: "Jane" },
      ],
    });
    const rows = (await run(bag.ctx, {})) as unknown[];
    expect(rows).toHaveLength(1);
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const bag = makeCtx({
      roles: ["field_worker"],
      initialContracts: [flaggedContract("contracts:1", T0, "x")],
    });
    const thrown = await run(bag.ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const bag = makeCtx({ authenticated: false });
    const thrown = await run(bag.ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("returns an empty array when no contracts are flagged", async () => {
    const bag = makeCtx({
      roles: ["admin"],
      initialContracts: [makeContract()],
    });
    const rows = (await run(bag.ctx, {})) as unknown[];
    expect(rows).toEqual([]);
  });

  it("falls back to '[retired]' / '[deleted customer]' when relations are missing", async () => {
    const bag = makeCtx({
      roles: ["admin"],
      initialContracts: [flaggedContract("contracts:1", T0, "Orphan")],
      initialLots: [],
      initialCustomers: [],
    });
    const rows = (await run(bag.ctx, {})) as Array<{
      lotCode: string;
      customerFullName: string;
    }>;
    expect(rows[0]!.lotCode).toBe("[retired]");
    expect(rows[0]!.customerFullName).toBe("[deleted customer]");
  });
});
