/**
 * Story 4.3 — `internal_reflagExpired` unit tests.
 *
 * The daily sweep mutation in `convex/followUpActions.ts` re-categorizes
 * every `open` follow-up action whose `dueAt` has passed as `"expired"`.
 * The "with logged action" pill (Story 4.2) becomes a lie if it keeps
 * silencing a follow-up whose target date has slipped — this sweep
 * closes the loop, and these tests pin the invariants that make it safe
 * to run unattended once per day.
 *
 * Hand-mocked ctx pattern (mirrors `followUpActions.test.ts`,
 * `arAging.test.ts`, `occupants.test.ts`). `convex-test` requires
 * `_generated/`, which this repo deliberately avoids; we reproduce just
 * enough of `ctx.db` — `withIndex().eq().lt().collect()`, `patch` —
 * to drive the internal mutation end-to-end. The fixture also mocks
 * `ctx.scheduler.runAfter` + installment/contract lookups so the
 * Epic 4 adversarial-review wiring (system audit row + per-contract
 * recompute schedule) is end-to-end verified.
 *
 * Coverage focus:
 *   - Happy path: every `open` row with `dueAt < nowMs` flips to
 *     `"expired"` with `expiredAt` set to a deterministic captured
 *     timestamp (NOT a per-row `Date.now()` call).
 *   - Boundary: `dueAt === nowMs` is NOT swept (the `lt` predicate is
 *     strict — equal-to-now rows have not yet expired).
 *   - Status filter: rows already in `"completed"`, `"cancelled"`, or
 *     `"expired"` are left untouched even if `dueAt < nowMs`.
 *   - Idempotency: running the sweep twice in succession is a no-op on
 *     the second pass (zero patches, identical returned counts).
 *   - Determinism: every patched row in a single sweep shares the same
 *     `expiredAt` (no per-row clock drift).
 *   - Empty table: returns cleanly with `{ scanned: 0, expired: 0,
 *     skipped: 0 }`.
 *   - Resilience: a single failing `patch` does NOT halt the loop —
 *     the rest of the batch still flips.
 *   - Audit (Story 4.3 AC4): one `update` audit row per expired
 *     follow-up, anchored on the lot id (canonical aggregate root),
 *     with the `system: ...` reason prefix marking the row as
 *     cron-driven.
 *   - Aging-snapshot recompute: one scheduler entry per affected
 *     CONTRACT (dedup across multiple follow-ups on the same
 *     contract). Pattern matches `markContractInDefault`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DAY_MS, HOUR_MS } from "../../../convex/lib/time";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { internal_reflagExpired } from "../../../convex/followUpActions";

const T0 = new Date("2026-05-20T08:00:00+08:00").getTime();
const USER_ID = "users:abc123";

type FollowUpStatus = "open" | "completed" | "cancelled" | "expired";

interface FollowUpFixture {
  _id: string;
  _creationTime: number;
  installmentId: string;
  action: "phone_call" | "sms" | "letter" | "in_person" | "other";
  notes?: string;
  dueAt: number;
  status: FollowUpStatus;
  createdAt: number;
  createdBy: string;
  completedAt?: number;
  completedBy?: string;
  expiredAt?: number;
}

interface AuditInsert {
  row: Record<string, unknown>;
}

interface InstallmentFixture {
  _id: string;
  _creationTime: number;
  contractId: string;
}

interface ContractFixture {
  _id: string;
  _creationTime: number;
  lotId: string;
}

interface CtxBag {
  followUps: Map<string, FollowUpFixture>;
  installments: Map<string, InstallmentFixture>;
  contracts: Map<string, ContractFixture>;
  auditInserts: AuditInsert[];
  patches: Array<{ id: string; patch: Record<string, unknown> }>;
  scheduled: Array<{ delayMs: number; ref: unknown; args: unknown }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
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
    dueAt: overrides.dueAt ?? T0 - DAY_MS,
    status: overrides.status ?? "open",
    createdAt: overrides.createdAt ?? T0 - 7 * DAY_MS,
    createdBy: overrides.createdBy ?? USER_ID,
    completedAt: overrides.completedAt,
    completedBy: overrides.completedBy,
    expiredAt: overrides.expiredAt,
  };
}

function makeCtx(opts: {
  followUps?: FollowUpFixture[];
  installments?: InstallmentFixture[];
  contracts?: ContractFixture[];
  failPatchOnIds?: Set<string>;
}): CtxBag {
  const followUps = new Map<string, FollowUpFixture>(
    (opts.followUps ?? []).map((f) => [f._id, f]),
  );
  const installments = new Map<string, InstallmentFixture>(
    (opts.installments ?? []).map((i) => [i._id, i]),
  );
  const contracts = new Map<string, ContractFixture>(
    (opts.contracts ?? []).map((c) => [c._id, c]),
  );
  const auditInserts: AuditInsert[] = [];
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const scheduled: Array<{ delayMs: number; ref: unknown; args: unknown }> =
    [];
  const failPatchOnIds = opts.failPatchOnIds ?? new Set<string>();

  type Predicate = (r: Record<string, unknown>) => boolean;

  interface IndexQuery {
    eq(field: string, value: unknown): IndexQuery;
    lt(field: string, value: unknown): IndexQuery;
    gte(field: string, value: unknown): IndexQuery;
    lte(field: string, value: unknown): IndexQuery;
  }

  function rowsForTable(table: string): Record<string, unknown>[] {
    if (table === "followUpActions") {
      return Array.from(followUps.values()) as unknown as Record<
        string,
        unknown
      >[];
    }
    return [];
  }

  function makeQueryBuilder(table: string) {
    const predicates: Predicate[] = [];
    const builder = {
      withIndex(_indexName: string, fn?: (q: IndexQuery) => IndexQuery) {
        if (fn !== undefined) {
          const q: IndexQuery = {
            eq(field, value) {
              predicates.push(
                (r) => (r as Record<string, unknown>)[field] === value,
              );
              return this;
            },
            lt(field, value) {
              predicates.push((r) => {
                const v = (r as Record<string, unknown>)[field];
                return typeof v === "number" && v < (value as number);
              });
              return this;
            },
            gte(field, value) {
              predicates.push((r) => {
                const v = (r as Record<string, unknown>)[field];
                return typeof v === "number" && v >= (value as number);
              });
              return this;
            },
            lte(field, value) {
              predicates.push((r) => {
                const v = (r as Record<string, unknown>)[field];
                return typeof v === "number" && v <= (value as number);
              });
              return this;
            },
          };
          fn(q);
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
        if (followUps.has(id)) return followUps.get(id);
        if (installments.has(id)) return installments.get(id);
        if (contracts.has(id)) return contracts.get(id);
        return null;
      }),
      query: vi.fn((table: string) => makeQueryBuilder(table)),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "auditLog") {
          auditInserts.push({ row });
          return `auditLog:${auditInserts.length}`;
        }
        return `${table}:?`;
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        if (failPatchOnIds.has(id)) {
          throw new Error(`simulated patch failure on ${id}`);
        }
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
    followUps,
    installments,
    contracts,
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("internal_reflagExpired (daily cron body)", () => {
  const run = handlerOf(internal_reflagExpired);

  it("expires every open row whose dueAt < nowMs and leaves others alone", async () => {
    const rows: FollowUpFixture[] = [
      // Should expire: open + dueAt 1 day ago.
      makeFollowUp({
        _id: "followUpActions:expired1",
        status: "open",
        dueAt: T0 - DAY_MS,
      }),
      // Should expire: open + dueAt 30 days ago (badly overdue).
      makeFollowUp({
        _id: "followUpActions:expired2",
        status: "open",
        dueAt: T0 - 30 * DAY_MS,
      }),
      // Should NOT expire: open but dueAt is in the future.
      makeFollowUp({
        _id: "followUpActions:future",
        status: "open",
        dueAt: T0 + 7 * DAY_MS,
      }),
      // Should NOT expire: dueAt < nowMs but status is completed.
      makeFollowUp({
        _id: "followUpActions:completed",
        status: "completed",
        dueAt: T0 - 2 * DAY_MS,
        completedAt: T0 - DAY_MS,
        completedBy: USER_ID,
      }),
      // Should NOT expire: dueAt < nowMs but status is cancelled.
      makeFollowUp({
        _id: "followUpActions:cancelled",
        status: "cancelled",
        dueAt: T0 - 5 * DAY_MS,
        completedAt: T0 - 4 * DAY_MS,
        completedBy: USER_ID,
      }),
      // Should NOT expire (idempotency): already expired on a prior run.
      makeFollowUp({
        _id: "followUpActions:alreadyExpired",
        status: "expired",
        dueAt: T0 - 90 * DAY_MS,
        expiredAt: T0 - 60 * DAY_MS,
      }),
    ];
    const bag = makeCtx({ followUps: rows });

    const result = (await run(bag.ctx, {})) as {
      expired: number;
      skipped: number;
      scanned: number;
    };

    expect(result.expired).toBe(2);
    expect(result.scanned).toBe(2);
    expect(result.skipped).toBe(0);

    expect(bag.followUps.get("followUpActions:expired1")!.status).toBe(
      "expired",
    );
    expect(bag.followUps.get("followUpActions:expired1")!.expiredAt).toBe(T0);
    expect(bag.followUps.get("followUpActions:expired2")!.status).toBe(
      "expired",
    );
    expect(bag.followUps.get("followUpActions:expired2")!.expiredAt).toBe(T0);

    // Untouched rows keep their original status (and any prior
    // `expiredAt` is not overwritten).
    expect(bag.followUps.get("followUpActions:future")!.status).toBe("open");
    expect(bag.followUps.get("followUpActions:completed")!.status).toBe(
      "completed",
    );
    expect(bag.followUps.get("followUpActions:cancelled")!.status).toBe(
      "cancelled",
    );
    expect(bag.followUps.get("followUpActions:alreadyExpired")!.status).toBe(
      "expired",
    );
    expect(
      bag.followUps.get("followUpActions:alreadyExpired")!.expiredAt,
    ).toBe(T0 - 60 * DAY_MS);
  });

  it("does NOT expire a row whose dueAt equals nowMs (strict less-than boundary)", async () => {
    const rows: FollowUpFixture[] = [
      makeFollowUp({
        _id: "followUpActions:boundary",
        status: "open",
        dueAt: T0, // exactly nowMs — has NOT yet passed
      }),
    ];
    const bag = makeCtx({ followUps: rows });
    const result = (await run(bag.ctx, {})) as {
      expired: number;
      scanned: number;
    };
    expect(result.expired).toBe(0);
    expect(result.scanned).toBe(0);
    expect(bag.followUps.get("followUpActions:boundary")!.status).toBe("open");
    expect(bag.patches).toHaveLength(0);
  });

  it("is idempotent across a back-to-back second sweep (zero patches on the second pass)", async () => {
    const rows: FollowUpFixture[] = [
      makeFollowUp({
        _id: "followUpActions:a",
        status: "open",
        dueAt: T0 - 2 * HOUR_MS,
      }),
      makeFollowUp({
        _id: "followUpActions:b",
        status: "open",
        dueAt: T0 - DAY_MS,
      }),
    ];
    const bag = makeCtx({ followUps: rows });

    const first = (await run(bag.ctx, {})) as {
      expired: number;
      scanned: number;
    };
    expect(first.expired).toBe(2);
    expect(first.scanned).toBe(2);
    expect(bag.patches).toHaveLength(2);

    const patchesAfterFirst = bag.patches.length;

    const second = (await run(bag.ctx, {})) as {
      expired: number;
      scanned: number;
      skipped: number;
    };
    expect(second.expired).toBe(0);
    expect(second.scanned).toBe(0);
    expect(second.skipped).toBe(0);
    // Critically: no additional patches issued — the index filter on
    // `status === "open"` reduces the working set to empty.
    expect(bag.patches).toHaveLength(patchesAfterFirst);
  });

  it("captures nowMs once and stamps the same expiredAt on every patched row", async () => {
    const rows: FollowUpFixture[] = [
      makeFollowUp({
        _id: "followUpActions:r1",
        status: "open",
        dueAt: T0 - DAY_MS,
      }),
      makeFollowUp({
        _id: "followUpActions:r2",
        status: "open",
        dueAt: T0 - 2 * DAY_MS,
      }),
      makeFollowUp({
        _id: "followUpActions:r3",
        status: "open",
        dueAt: T0 - 3 * DAY_MS,
      }),
    ];
    const bag = makeCtx({ followUps: rows });

    await run(bag.ctx, {});

    const stamps = bag.patches.map((p) => p.patch.expiredAt);
    expect(stamps).toHaveLength(3);
    // Every row stamped with the SAME timestamp — no per-row Date.now().
    expect(new Set(stamps).size).toBe(1);
    expect(stamps[0]).toBe(T0);
    // Every patch flips status → "expired".
    for (const p of bag.patches) {
      expect(p.patch.status).toBe("expired");
    }
  });

  it("emits one system-actor audit row per expired follow-up (Story 4.3 AC4)", async () => {
    // Story 4.3 AC4 + Epic 4 adversarial-review fix (2026-05-24):
    // every expired follow-up MUST emit an audit row even though the
    // cron has no authenticated session. The schema's `actor:
    // v.id("users")` invariant forces us to attribute the row to the
    // follow-up's original `createdBy` (the "system acting on behalf
    // of" pattern); a `reason: "system: ..."` prefix marks the row
    // as cron-driven for audit consumers.
    const installment: InstallmentFixture = {
      _id: "installments:1",
      _creationTime: T0,
      contractId: "contracts:1",
    };
    const contract: ContractFixture = {
      _id: "contracts:1",
      _creationTime: T0,
      lotId: "lots:42",
    };
    const rows: FollowUpFixture[] = [
      makeFollowUp({
        _id: "followUpActions:audit-check",
        installmentId: installment._id,
        createdBy: USER_ID,
        status: "open",
        dueAt: T0 - DAY_MS,
      }),
    ];
    const bag = makeCtx({
      followUps: rows,
      installments: [installment],
      contracts: [contract],
    });
    await run(bag.ctx, {});
    expect(bag.auditInserts).toHaveLength(1);
    const audit = bag.auditInserts[0]!.row;
    expect(audit.action).toBe("update");
    expect(audit.entityType).toBe("lot");
    expect(audit.entityId).toBe("lots:42");
    expect(audit.actor).toBe(USER_ID);
    expect(typeof audit.reason).toBe("string");
    expect((audit.reason as string).startsWith("system:")).toBe(true);
  });

  it("skips audit emission when installment/contract lookup fails (graceful degrade)", async () => {
    // No installment + contract fixtures registered, so the
    // installment→contract→lot resolution returns null and the sweep
    // commits the status flip without an audit row. The patch still
    // succeeds; the operator sees the row flipped on next read.
    const rows: FollowUpFixture[] = [
      makeFollowUp({
        _id: "followUpActions:orphan",
        status: "open",
        dueAt: T0 - DAY_MS,
      }),
    ];
    const bag = makeCtx({ followUps: rows });
    const result = (await run(bag.ctx, {})) as { expired: number };
    expect(result.expired).toBe(1);
    expect(bag.auditInserts).toHaveLength(0);
    expect(bag.scheduled).toHaveLength(0);
  });

  it("schedules one AR aging recompute per affected contract (dedup across follow-ups)", async () => {
    // Two follow-ups under the same contract + one follow-up under a
    // different contract = exactly two scheduler entries (the
    // first contract is deduped).
    const installmentA: InstallmentFixture = {
      _id: "installments:A",
      _creationTime: T0,
      contractId: "contracts:1",
    };
    const installmentB: InstallmentFixture = {
      _id: "installments:B",
      _creationTime: T0,
      contractId: "contracts:1",
    };
    const installmentC: InstallmentFixture = {
      _id: "installments:C",
      _creationTime: T0,
      contractId: "contracts:2",
    };
    const contracts: ContractFixture[] = [
      { _id: "contracts:1", _creationTime: T0, lotId: "lots:1" },
      { _id: "contracts:2", _creationTime: T0, lotId: "lots:2" },
    ];
    const rows: FollowUpFixture[] = [
      makeFollowUp({
        _id: "followUpActions:1",
        installmentId: installmentA._id,
        status: "open",
        dueAt: T0 - DAY_MS,
      }),
      makeFollowUp({
        _id: "followUpActions:2",
        installmentId: installmentB._id,
        status: "open",
        dueAt: T0 - DAY_MS,
      }),
      makeFollowUp({
        _id: "followUpActions:3",
        installmentId: installmentC._id,
        status: "open",
        dueAt: T0 - DAY_MS,
      }),
    ];
    const bag = makeCtx({
      followUps: rows,
      installments: [installmentA, installmentB, installmentC],
      contracts,
    });
    await run(bag.ctx, {});
    expect(bag.scheduled).toHaveLength(2);
    expect(bag.scheduled[0]!.delayMs).toBe(0);
    expect(bag.scheduled[1]!.delayMs).toBe(0);
    const scheduledContractIds = new Set(
      bag.scheduled.map(
        (s) => (s.args as { contractId: string }).contractId,
      ),
    );
    expect(scheduledContractIds).toEqual(
      new Set(["contracts:1", "contracts:2"]),
    );
  });

  it("returns clean counters on an empty table", async () => {
    const bag = makeCtx({ followUps: [] });
    const result = (await run(bag.ctx, {})) as {
      expired: number;
      skipped: number;
      scanned: number;
    };
    expect(result).toEqual({ expired: 0, skipped: 0, scanned: 0 });
    expect(bag.patches).toHaveLength(0);
    expect(bag.auditInserts).toHaveLength(0);
  });

  it("one failing patch does NOT halt the batch — remaining rows still expire", async () => {
    const rows: FollowUpFixture[] = [
      makeFollowUp({
        _id: "followUpActions:ok1",
        status: "open",
        dueAt: T0 - DAY_MS,
      }),
      makeFollowUp({
        _id: "followUpActions:boom",
        status: "open",
        dueAt: T0 - DAY_MS,
      }),
      makeFollowUp({
        _id: "followUpActions:ok2",
        status: "open",
        dueAt: T0 - DAY_MS,
      }),
    ];
    const bag = makeCtx({
      followUps: rows,
      failPatchOnIds: new Set(["followUpActions:boom"]),
    });

    const result = (await run(bag.ctx, {})) as {
      expired: number;
      skipped: number;
      scanned: number;
    };

    expect(result.scanned).toBe(3);
    expect(result.expired).toBe(2);
    expect(result.skipped).toBe(1);
    expect(bag.followUps.get("followUpActions:ok1")!.status).toBe("expired");
    expect(bag.followUps.get("followUpActions:ok2")!.status).toBe("expired");
    // The failing row stays in its original `open` state.
    expect(bag.followUps.get("followUpActions:boom")!.status).toBe("open");
  });
});
