/**
 * Story 3.6 — `transitionContractState` implementation tests.
 *
 * This story added the domain helper `transitionContractState` to the
 * Story 1.7 cornerstone — mirrors `transitionLotStatus`'s shape:
 * fetch → assertTransition → patch → emitAudit → return updated doc.
 *
 * Coverage targets (NFR-M2: ≥ 90% on financial-touching code; the
 * contract state machine is financial):
 *   1. Happy path: schema-aligned `active → paid_in_full` (auto-fire
 *      from the cornerstone), `active → in_default` (admin default),
 *      `active → cancelled` (admin cancel), `active → voided`
 *      (admin void post-sale), `in_default → active` (admin
 *      reinstate).
 *   2. NOT_FOUND when the contract id does not resolve.
 *   3. ILLEGAL_STATE_TRANSITION propagation for forbidden edges
 *      (every terminal state outbound, plus `paid_in_full → *`).
 *   4. INVARIANT_VIOLATION for reason-required transitions without
 *      a reason (every contract transition except the auto-fire
 *      `active → paid_in_full` requires a reason per the Story 3.6
 *      additions to `REASON_REQUIRED_TRANSITIONS`).
 *   5. The audit row records `before.state`, `after.state`, and
 *      `reason` — forensic traceability per FR23.
 *
 * Pattern mirrors `stateMachines-transitionLotStatus.test.ts`:
 * hand-mocked MutationCtx, no `convex/_generated/` dependency,
 * `@convex-dev/auth/server` mocked so `emitAudit` can resolve the
 * caller's identity without spinning up Convex Auth.
 */

import { ConvexError, type Value } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCode, type ErrorPayload } from "../../../../convex/lib/errors";
import { HOUR_MS } from "../../../../convex/lib/time";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { transitionContractState } from "../../../../convex/lib/stateMachines";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const USER_ID = "users:abc123";
const SESSION_ID = "authSessions:def456";

type ContractState =
  | "active"
  | "paid_in_full"
  | "in_default"
  | "cancelled"
  | "voided";

interface ContractFixture {
  _id: string;
  _creationTime: number;
  state: ContractState;
  contractNumber?: string;
}

interface AuditInsert {
  table: string;
  row: {
    actor: string;
    timestamp: number;
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
    reason?: string;
  };
}

interface CtxBag {
  inserts: AuditInsert[];
  patches: Array<{ id: string; patch: Record<string, unknown> }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(contract: ContractFixture | null): CtxBag {
  const inserts: AuditInsert[] = [];
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];

  let currentContract = contract;

  mockedGetAuthUserId.mockResolvedValue(USER_ID as never);
  mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);

  const user = {
    _id: USER_ID,
    _creationTime: T0 - 1000,
    email: "admin@example.com",
    isActive: true,
  };
  const session = {
    _id: SESSION_ID,
    _creationTime: T0,
    userId: USER_ID,
    expirationTime: T0 + 30 * 24 * HOUR_MS,
  };
  // emitAudit calls getCurrentUserAndRoles which scans userRoles —
  // we return an admin role so the audit emission succeeds (the
  // helper itself is role-agnostic; only the audit emission needs a
  // resolvable actor).
  const userRoles = [
    {
      _id: "userRoles:0",
      _creationTime: T0,
      userId: USER_ID,
      role: "admin" as const,
      grantedAt: T0,
      grantedBy: USER_ID,
    },
  ];

  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === USER_ID) return user;
        if (id === SESSION_ID) return session;
        if (currentContract !== null && id === currentContract._id) {
          return currentContract;
        }
        return null;
      }),
      // Story 5.2 follow-up: `transitionContractState` now bumps the
      // `dashboardCountersByContractState` summary doc via
      // `shiftContractStateCounter`. The helper reads via
      // `.withIndex("by_key", ...).first()`; returning `null` makes
      // the helper take the insert branch, which the mock filters out
      // below so the existing `inserts.length` assertions remain
      // faithful to "audit-log row count".
      query: vi.fn((_table: string) => ({
        withIndex: (_indexName: string, _fn: unknown) => ({
          collect: async () => userRoles,
          first: async () => null,
        }),
      })),
      patch: vi.fn(
        async (id: string, patch: Record<string, unknown>) => {
          if (
            typeof id === "string" &&
            id.startsWith("dashboardCounters")
          ) {
            return;
          }
          patches.push({ id, patch });
          if (currentContract !== null && id === currentContract._id) {
            currentContract = {
              ...currentContract,
              ...patch,
            } as ContractFixture;
          }
        },
      ),
      insert: vi.fn(
        async (table: string, row: AuditInsert["row"]) => {
          if (
            table === "dashboardCountersByLotStatus" ||
            table === "dashboardCountersByContractState"
          ) {
            return `${table}:counter`;
          }
          inserts.push({ table, row });
          return `${table}:row${inserts.length}`;
        },
      ),
    },
  };

  return { inserts, patches, ctx };
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

describe("transitionContractState — happy paths (schema vocab)", () => {
  it("active → paid_in_full (auto-fire path) patches state and emits a transition audit row", async () => {
    const contract: ContractFixture = {
      _id: "contracts:autopay",
      _creationTime: T0,
      state: "active",
      contractNumber: "CON-2026-1",
    };
    const { ctx, inserts, patches } = makeCtx(contract);

    const result = await transitionContractState(ctx, {
      contractId: contract._id as never,
      to: "paid_in_full",
      // active → paid_in_full is the only contract edge that does
      // NOT require a reason (system auto-fire from the cornerstone).
    });

    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({
      id: contract._id,
      patch: { state: "paid_in_full" },
    });
    expect(inserts).toHaveLength(1);
    const auditRow = inserts[0]!.row;
    expect(auditRow.action).toBe("transition");
    expect(auditRow.entityType).toBe("contract");
    expect(auditRow.entityId).toBe(contract._id);
    expect(auditRow.before).toEqual({ state: "active" });
    expect(auditRow.after).toEqual({ state: "paid_in_full" });
    expect(result.state).toBe("paid_in_full");
  });

  it("active → in_default carries the reason through to the audit row", async () => {
    const contract: ContractFixture = {
      _id: "contracts:default",
      _creationTime: T0,
      state: "active",
    };
    const { ctx, inserts } = makeCtx(contract);

    await transitionContractState(ctx, {
      contractId: contract._id as never,
      to: "in_default",
      reason: "Three missed installments past grace period",
    });

    expect(inserts[0]!.row.reason).toBe(
      "Three missed installments past grace period",
    );
    expect(inserts[0]!.row.before).toEqual({ state: "active" });
    expect(inserts[0]!.row.after).toEqual({ state: "in_default" });
  });

  it("active → cancelled is a legal admin edge with a reason", async () => {
    const contract: ContractFixture = {
      _id: "contracts:cancel",
      _creationTime: T0,
      state: "active",
    };
    const { ctx, patches, inserts } = makeCtx(contract);

    const result = await transitionContractState(ctx, {
      contractId: contract._id as never,
      to: "cancelled",
      reason: "Customer requested cancellation pre-interment",
    });

    expect(patches[0]!.patch).toEqual({ state: "cancelled" });
    expect(inserts[0]!.row.reason).toBe(
      "Customer requested cancellation pre-interment",
    );
    expect(result.state).toBe("cancelled");
  });

  it("active → voided is a legal admin edge (FR24)", async () => {
    const contract: ContractFixture = {
      _id: "contracts:void",
      _creationTime: T0,
      state: "active",
    };
    const { ctx, patches } = makeCtx(contract);

    await transitionContractState(ctx, {
      contractId: contract._id as never,
      to: "voided",
      reason: "Duplicate contract entry — voiding per BIR process",
    });

    expect(patches[0]!.patch).toEqual({ state: "voided" });
  });

  it("in_default → active reinstates a recovered contract", async () => {
    const contract: ContractFixture = {
      _id: "contracts:reinstate",
      _creationTime: T0,
      state: "in_default",
    };
    const { ctx, patches } = makeCtx(contract);

    await transitionContractState(ctx, {
      contractId: contract._id as never,
      to: "active",
      reason: "Customer paid arrears in full",
    });

    expect(patches[0]!.patch).toEqual({ state: "active" });
  });

  it("in_default → voided terminal-voids after failed recovery", async () => {
    const contract: ContractFixture = {
      _id: "contracts:default-void",
      _creationTime: T0,
      state: "in_default",
    };
    const { ctx, patches } = makeCtx(contract);

    await transitionContractState(ctx, {
      contractId: contract._id as never,
      to: "voided",
      reason: "180 days in default, recovery efforts exhausted",
    });

    expect(patches[0]!.patch).toEqual({ state: "voided" });
  });

  it("in_default → cancelled is a legal edge with reason", async () => {
    const contract: ContractFixture = {
      _id: "contracts:default-cancel",
      _creationTime: T0,
      state: "in_default",
    };
    const { ctx, patches } = makeCtx(contract);

    await transitionContractState(ctx, {
      contractId: contract._id as never,
      to: "cancelled",
      reason: "Customer requested cancellation after default review",
    });

    expect(patches[0]!.patch).toEqual({ state: "cancelled" });
  });
});

describe("transitionContractState — error paths", () => {
  it("throws NOT_FOUND when the contract id does not resolve", async () => {
    const { ctx, inserts, patches } = makeCtx(null);
    const thrown = await transitionContractState(ctx, {
      contractId: "contracts:missing" as never,
      to: "paid_in_full",
    }).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
    // No DB writes when the contract is missing — the assertion
    // never runs.
    expect(patches).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("propagates ILLEGAL_STATE_TRANSITION for paid_in_full → cancelled (terminal source)", async () => {
    const contract: ContractFixture = {
      _id: "contracts:terminal",
      _creationTime: T0,
      state: "paid_in_full",
    };
    const { ctx, inserts, patches } = makeCtx(contract);

    const thrown = await transitionContractState(ctx, {
      contractId: contract._id as never,
      to: "cancelled",
      reason: "should not be allowed",
    }).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.ILLEGAL_STATE_TRANSITION);
    // No DB writes when the transition is forbidden.
    expect(patches).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("propagates ILLEGAL_STATE_TRANSITION for voided → active (terminal source)", async () => {
    const contract: ContractFixture = {
      _id: "contracts:voided",
      _creationTime: T0,
      state: "voided",
    };
    const { ctx, inserts, patches } = makeCtx(contract);

    const thrown = await transitionContractState(ctx, {
      contractId: contract._id as never,
      to: "active",
      reason: "trying to un-void",
    }).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.ILLEGAL_STATE_TRANSITION);
    expect(patches).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("propagates ILLEGAL_STATE_TRANSITION for cancelled → active (terminal source)", async () => {
    const contract: ContractFixture = {
      _id: "contracts:cancelled",
      _creationTime: T0,
      state: "cancelled",
    };
    const { ctx } = makeCtx(contract);

    const thrown = await transitionContractState(ctx, {
      contractId: contract._id as never,
      to: "active",
      reason: "trying to un-cancel",
    }).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.ILLEGAL_STATE_TRANSITION);
  });

  it("throws INVARIANT_VIOLATION when reason is required but omitted (active → cancelled)", async () => {
    const contract: ContractFixture = {
      _id: "contracts:cancel-noreason",
      _creationTime: T0,
      state: "active",
    };
    const { ctx, inserts, patches } = makeCtx(contract);

    const thrown = await transitionContractState(ctx, {
      contractId: contract._id as never,
      to: "cancelled",
      // no reason
    }).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(patches).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("throws INVARIANT_VIOLATION when reason is whitespace-only (active → voided)", async () => {
    const contract: ContractFixture = {
      _id: "contracts:void-blank",
      _creationTime: T0,
      state: "active",
    };
    const { ctx } = makeCtx(contract);

    const thrown = await transitionContractState(ctx, {
      contractId: contract._id as never,
      to: "voided",
      reason: "   \t  ",
    }).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("active → active is rejected (no-op transitions are forbidden)", async () => {
    const contract: ContractFixture = {
      _id: "contracts:noop",
      _creationTime: T0,
      state: "active",
    };
    const { ctx } = makeCtx(contract);

    const thrown = await transitionContractState(ctx, {
      contractId: contract._id as never,
      to: "active",
      reason: "no-op",
    }).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.ILLEGAL_STATE_TRANSITION);
  });
});

describe("transitionContractState — audit row shape", () => {
  it("emits exactly one audit row per transition", async () => {
    const contract: ContractFixture = {
      _id: "contracts:audit-shape",
      _creationTime: T0,
      state: "active",
    };
    const { ctx, inserts } = makeCtx(contract);

    await transitionContractState(ctx, {
      contractId: contract._id as never,
      to: "in_default",
      reason: "FR37 admin default",
    });

    // Single audit row — no duplicate emissions.
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.table).toBe("auditLog");
    expect(inserts[0]!.row.action).toBe("transition");
    expect(inserts[0]!.row.entityType).toBe("contract");
  });

  it("records the calling user as the audit actor", async () => {
    const contract: ContractFixture = {
      _id: "contracts:actor",
      _creationTime: T0,
      state: "active",
    };
    const { ctx, inserts } = makeCtx(contract);

    await transitionContractState(ctx, {
      contractId: contract._id as never,
      to: "in_default",
      reason: "FR37 admin default",
    });

    // The auto-fire path (active → paid_in_full from the cornerstone)
    // and the admin paths both attribute the audit row to the
    // calling user — no synthetic "system" principal.
    expect(inserts[0]!.row.actor).toBe(USER_ID);
  });
});
