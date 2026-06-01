/**
 * Story 1.8 — transitionLotStatus implementation tests.
 *
 * Story 1.7 shipped the assertion library + a NOT_IMPLEMENTED stub
 * for `transitionLotStatus`; Story 1.8 filled the body. The tests
 * here cover the now-implemented behaviour:
 *
 *   1. Happy path: fetch → assertTransition → patch → emitAudit
 *      → return the updated doc.
 *   2. NOT_FOUND when the lot id doesn't resolve.
 *   3. ILLEGAL_STATE_TRANSITION propagation when the move is invalid.
 *   4. INVARIANT_VIOLATION for reason-required transitions without
 *      a reason.
 *   5. Defensive: `NOT_FOUND` re-fetch failure.
 *
 * Pattern mirrors `tests/unit/convex/lib/audit.test.ts` — hand-mocked
 * MutationCtx because `convex/_generated/` isn't built (the project's
 * test infra deliberately doesn't depend on `npx convex dev`).
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
import { transitionLotStatus } from "../../../../convex/lib/stateMachines";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const USER_ID = "users:abc123";
const SESSION_ID = "authSessions:def456";

interface LotFixture {
  _id: string;
  _creationTime: number;
  status: string;
  code?: string;
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

function makeCtx(lot: LotFixture | null): CtxBag {
  const inserts: AuditInsert[] = [];
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];

  let currentLot = lot;

  mockedGetAuthUserId.mockResolvedValue(USER_ID as never);
  mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);

  const user = {
    _id: USER_ID,
    _creationTime: T0 - 1000,
    email: "office@example.com",
  };
  const session = {
    _id: SESSION_ID,
    _creationTime: T0,
    userId: USER_ID,
    expirationTime: T0 + 30 * 24 * HOUR_MS,
  };
  const userRoles = [
    {
      _id: "userRoles:0",
      _creationTime: T0,
      userId: USER_ID,
      role: "office_staff" as const,
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
        if (currentLot !== null && id === currentLot._id) return currentLot;
        return null;
      }),
      // Story 5.2 follow-up: `transitionLotStatus` now writes to the
      // `dashboardCountersByLotStatus` summary doc via
      // `bumpLotStatusCounter`. The maintenance helper reads with
      // `.withIndex("by_key", ...).first()` and writes via the existing
      // `insert` / `patch` mocks. The test mock returns `null` for the
      // first-lookup (no prior counter row) so the helper takes the
      // insert branch — which is captured by the `inserts` array but
      // does not affect the assertions below (they target only the
      // audit-log insert).
      query: vi.fn((_table: string) => ({
        withIndex: (_indexName: string, _fn: unknown) => ({
          collect: async () => userRoles,
          first: async () => null,
        }),
      })),
      patch: vi.fn(
        async (id: string, patch: Record<string, unknown>) => {
          // Counter rows live under `dashboardCounters*` table ids;
          // their patches do not represent state-machine writes the
          // tests assert on. Drop them so the `patches.length` check
          // remains a faithful proxy for "how many times did the
          // helper patch the entity".
          if (
            typeof id === "string" &&
            id.startsWith("dashboardCounters")
          ) {
            return;
          }
          patches.push({ id, patch });
          if (currentLot !== null && id === currentLot._id) {
            currentLot = { ...currentLot, ...patch } as LotFixture;
          }
        },
      ),
      insert: vi.fn(
        async (table: string, row: AuditInsert["row"]) => {
          // Filter out the dashboard-counter inserts the new helper
          // performs so the existing assertions on `inserts.length`
          // continue to count ONLY the audit-log rows the original
          // tests cared about.
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

describe("transitionLotStatus — happy path", () => {
  it("patches status, emits a `transition` audit row, and returns the updated lot", async () => {
    const lot: LotFixture = {
      _id: "lots:abc",
      _creationTime: T0,
      status: "available",
      code: "D-5-12",
    };
    const { ctx, inserts, patches } = makeCtx(lot);

    const result = await transitionLotStatus(ctx, {
      // The test ctx uses untyped string ids; cast for the helper's
      // strictly-typed signature. The runtime path doesn't care about
      // the brand.
      lotId: lot._id as never,
      to: "reserved",
    });

    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({
      id: lot._id,
      patch: { status: "reserved" },
    });
    expect(inserts).toHaveLength(1);
    const auditRow = inserts[0]!.row;
    expect(auditRow.action).toBe("transition");
    expect(auditRow.entityType).toBe("lot");
    expect(auditRow.entityId).toBe(lot._id);
    expect(auditRow.before).toEqual({ status: "available" });
    expect(auditRow.after).toEqual({ status: "reserved" });
    expect(result.status).toBe("reserved");
  });

  it("passes `reason` through to the audit row when supplied", async () => {
    const lot: LotFixture = {
      _id: "lots:def",
      _creationTime: T0,
      status: "sold",
    };
    const { ctx, inserts } = makeCtx(lot);

    await transitionLotStatus(ctx, {
      lotId: lot._id as never,
      to: "defaulted",
      reason: "180 days past due",
    });

    expect(inserts[0]!.row.reason).toBe("180 days past due");
  });
});

describe("transitionLotStatus — error paths", () => {
  it("throws NOT_FOUND when the lot id does not resolve", async () => {
    const { ctx, inserts, patches } = makeCtx(null);
    const thrown = await transitionLotStatus(ctx, {
      lotId: "lots:missing" as never,
      to: "reserved",
    }).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
    expect(patches).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("propagates ILLEGAL_STATE_TRANSITION from assertTransition", async () => {
    const lot: LotFixture = {
      _id: "lots:ghi",
      _creationTime: T0,
      status: "available",
    };
    const { ctx, inserts, patches } = makeCtx(lot);

    const thrown = await transitionLotStatus(ctx, {
      lotId: lot._id as never,
      // available → occupied is not a legal transition.
      to: "occupied",
    }).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.ILLEGAL_STATE_TRANSITION);
    // No DB writes when validation fails.
    expect(patches).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("throws INVARIANT_VIOLATION when reason is required but omitted", async () => {
    const lot: LotFixture = {
      _id: "lots:jkl",
      _creationTime: T0,
      status: "sold",
    };
    const { ctx } = makeCtx(lot);

    const thrown = await transitionLotStatus(ctx, {
      lotId: lot._id as never,
      // sold → defaulted is in REASON_REQUIRED_TRANSITIONS.
      to: "defaulted",
    }).catch((e: unknown) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });
});
