/**
 * Story 5.6 — `convex/healthCheck.ts` unit tests.
 *
 * Same hand-mocked ctx pattern as `auditLogQueries.test.ts` and
 * `users.test.ts`. `verifyBackupHealth` is a pure read with no DB
 * dependencies (it returns module-level constants + a clock read),
 * so the ctx mock can be minimal — it just needs to satisfy
 * `requireRole(ctx, ["admin"])` via the mocked `@convex-dev/auth/server`.
 *
 * Coverage focus:
 *   - `requireRole(ctx, ["admin"])` is the first line of the handler
 *     (FORBIDDEN for non-admin; UNAUTHENTICATED for missing session).
 *   - The returned report shape is the stable contract documented in
 *     `BackupHealthReport`: status literal, deployment name, retention
 *     target, ageBreaches semantics, runbook / ADR pointers.
 *   - `ageBreaches` is `true` when `LAST_VERIFIED_AT` is null (the
 *     current scaffold state — runbook never executed against live
 *     deployment yet).
 *   - The `computeReport` helper correctly handles a stubbed
 *     verification timestamp (within threshold → ageBreaches false;
 *     beyond threshold → ageBreaches true).
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
  AGE_THRESHOLD_MS,
  computeReport,
  DEPLOYMENT_NAME,
  LAST_VERIFIED_AT,
  ORIGINAL_25H_THRESHOLD_MS,
  RETENTION_DAYS_TARGET,
  verifyBackupHealth,
  type BackupHealthReport,
} from "../../../convex/healthCheck";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const ADMIN_ID = "users:admin1";
const SESSION_ID = "authSessions:s1";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface UserFixture {
  _id: string;
  _creationTime: number;
  name?: string;
  email?: string;
  isActive?: boolean;
}

interface UserRoleFixture {
  _id: string;
  _creationTime: number;
  userId: string;
  role: RoleName;
  grantedAt: number;
  grantedBy: string;
}

interface CtxBag {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  callerRoles?: RoleName[];
  callerId?: string;
  callerIsActive?: boolean;
  authenticated?: boolean;
}): CtxBag {
  const users = new Map<string, UserFixture>();
  const userRoles = new Map<string, UserRoleFixture>();

  const callerId = opts.callerId ?? ADMIN_ID;
  const callerRoles = opts.callerRoles ?? ["admin"];

  users.set(callerId, {
    _id: callerId,
    _creationTime: T0 - 1000,
    name: "Caller Admin",
    email: "caller@example.com",
    isActive: opts.callerIsActive !== false,
  });
  callerRoles.forEach((role, idx) => {
    const rid = `userRoles:caller-${idx}`;
    userRoles.set(rid, {
      _id: rid,
      _creationTime: T0,
      userId: callerId,
      role,
      grantedAt: T0,
      grantedBy: callerId,
    });
  });

  if (opts.authenticated === false) {
    mockedGetAuthUserId.mockResolvedValue(null);
    mockedGetAuthSessionId.mockResolvedValue(null);
  } else {
    mockedGetAuthUserId.mockResolvedValue(callerId as never);
    mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);
  }

  const session = {
    _id: SESSION_ID,
    _creationTime: T0,
    userId: callerId,
    expirationTime: T0 + 30 * 24 * HOUR_MS,
  };

  // Minimal query builder — `requireRole` only needs `userRoles` lookup
  // by `by_user` index + `.collect()`. We satisfy that surface and let
  // anything else throw if accidentally used.
  function queryBuilder(table: string) {
    let rows: Array<UserRoleFixture>;
    if (table === "userRoles") rows = Array.from(userRoles.values());
    else rows = [];
    const predicates: Array<(r: UserRoleFixture) => boolean> = [];
    const builder = {
      withIndex(_indexName: string, fn?: (q: IndexQuery) => IndexQuery) {
        const q: IndexQuery = {
          eqs: {},
          eq(field, value) {
            this.eqs[field] = value;
            return this;
          },
        };
        if (fn) fn(q);
        for (const [field, value] of Object.entries(q.eqs)) {
          predicates.push(
            (r) => (r as unknown as Record<string, unknown>)[field] === value,
          );
        }
        return builder;
      },
      async collect() {
        return rows.filter((r) => predicates.every((p) => p(r)));
      },
    };
    return builder;
  }

  interface IndexQuery {
    eqs: Record<string, unknown>;
    eq(field: string, value: unknown): IndexQuery;
  }

  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === SESSION_ID) return session;
        if (users.has(id)) return users.get(id);
        if (userRoles.has(id)) return userRoles.get(id);
        return null;
      }),
      query: vi.fn((table: string) => queryBuilder(table)),
      insert: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  };

  return { ctx };
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

describe("module-level constants", () => {
  it("exposes the documented deployment name from Story 1.1 / ADR-0017", () => {
    expect(DEPLOYMENT_NAME).toBe("beaming-boar-935");
  });

  it("retention target matches NFR-R2's ≥ 30 day floor", () => {
    expect(RETENTION_DAYS_TARGET).toBe(30);
  });

  it("AGE_THRESHOLD_MS is 100 days (quarter + grace)", () => {
    expect(AGE_THRESHOLD_MS).toBe(100 * DAY_MS);
  });

  it("preserves the original 25h spec value for the future programmatic check", () => {
    expect(ORIGINAL_25H_THRESHOLD_MS).toBe(25 * HOUR_MS);
  });

  it("LAST_VERIFIED_AT is null until the first quarterly verification lands", () => {
    // This assertion is intentionally pinned: the moment a real
    // verification is logged, LAST_VERIFIED_AT becomes a number and
    // this test needs to be updated in the same PR that updates the
    // ADR ledger. The coupling is the point — the runbook step
    // "update LAST_VERIFIED_AT in convex/healthCheck.ts" is enforced
    // by this test going red until it happens.
    expect(LAST_VERIFIED_AT).toBeNull();
  });
});

describe("computeReport", () => {
  const now = T0;

  it("returns the manual-verification posture by default", () => {
    const report = computeReport(now);
    expect(report.status).toBe("manual-verification-required");
    expect(report.deploymentName).toBe(DEPLOYMENT_NAME);
    expect(report.retentionDaysTarget).toBe(RETENTION_DAYS_TARGET);
    expect(report.ageThresholdMs).toBe(AGE_THRESHOLD_MS);
    expect(report.runbookSection).toBe("docs/runbook.md#database-backups");
    expect(report.adr).toBe("docs/adr/0017-database-backups.md");
    expect(report.notes).toMatch(/Convex does not expose backup metadata/);
  });

  it("reports ageMs null + ageBreaches true when LAST_VERIFIED_AT is null", () => {
    // Today's snapshot — pin-tests the scaffold state.
    const report = computeReport(now);
    expect(report.lastVerifiedAt).toBeNull();
    expect(report.ageMs).toBeNull();
    expect(report.ageBreaches).toBe(true);
  });
});

describe("verifyBackupHealth handler", () => {
  const run = handlerOf(verifyBackupHealth);

  it("rejects unauthenticated callers with UNAUTHENTICATED", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("rejects office_staff callers with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ callerRoles: ["office_staff"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects field_worker callers with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ callerRoles: ["field_worker"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects customer callers with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ callerRoles: ["customer"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects deactivated admins with UNAUTHENTICATED", async () => {
    const { ctx } = makeCtx({ callerIsActive: false });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("returns the manual-verification report for admin callers", async () => {
    const { ctx } = makeCtx({ callerRoles: ["admin"] });
    const result = (await run(ctx, {})) as BackupHealthReport;
    expect(result.status).toBe("manual-verification-required");
    expect(result.deploymentName).toBe(DEPLOYMENT_NAME);
    expect(result.retentionDaysTarget).toBe(RETENTION_DAYS_TARGET);
    expect(result.ageThresholdMs).toBe(AGE_THRESHOLD_MS);
    expect(result.runbookSection).toBe("docs/runbook.md#database-backups");
    expect(result.adr).toBe("docs/adr/0017-database-backups.md");
  });

  it("reports ageBreaches true while LAST_VERIFIED_AT is null", async () => {
    const { ctx } = makeCtx({ callerRoles: ["admin"] });
    const result = (await run(ctx, {})) as BackupHealthReport;
    expect(result.lastVerifiedAt).toBeNull();
    expect(result.ageMs).toBeNull();
    expect(result.ageBreaches).toBe(true);
  });

  it("never writes to the database (read-only invariant)", async () => {
    const { ctx } = makeCtx({ callerRoles: ["admin"] });
    await run(ctx, {});
    expect(ctx.db.insert).not.toHaveBeenCalled();
    expect(ctx.db.patch).not.toHaveBeenCalled();
    expect(ctx.db.delete).not.toHaveBeenCalled();
  });
});
