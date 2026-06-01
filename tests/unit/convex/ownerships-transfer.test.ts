/**
 * Story 2.7 — `convex/ownerships.ts:recordOwnershipTransfer` unit tests.
 *
 * Coverage target: ≥ 90% line + branch on the mutation (NFR-M2). This
 * is a multi-document atomic write — the kind of code that fails
 * silently without thorough cases. Cases mirror the story's Task 9
 * checklist:
 *
 *   - Happy path: previous ownership patched with `effectiveTo`, new
 *     ownership inserted, audit emitted with action="transfer".
 *   - Backdated transfer with sufficient reason → success.
 *   - Backdated transfer with too-short reason → INVARIANT_VIOLATION.
 *   - Self-transfer (from === to) → INVARIANT_VIOLATION.
 *   - No current ownership (lot has never been sold) → INVARIANT_VIOLATION.
 *   - Source-owner mismatch → INVARIANT_VIOLATION.
 *   - Retired lot → INVARIANT_VIOLATION.
 *   - Missing destination customer → NOT_FOUND.
 *   - Missing lot → NOT_FOUND.
 *   - RBAC: field_worker → FORBIDDEN; unauthenticated → UNAUTHENTICATED.
 *   - Validation: empty reason / over-long reason / non-positive date.
 *
 * Strategy: hand-mocked ctx, same pattern as `customers.test.ts` and
 * `ownerships.test.ts`. The mutation depends on `emitAudit` which in
 * turn calls `getCurrentUserAndRoles` and `ctx.db.insert("auditLog")`.
 * The mock satisfies both.
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
import { recordOwnershipTransfer } from "../../../convex/ownerships";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const CALLER_ID = "users:office1";
const SESSION_ID = "authSessions:s1";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface OwnershipFixture {
  _id: string;
  _creationTime: number;
  lotId: string;
  customerId: string;
  effectiveFrom: number;
  effectiveTo?: number;
  transferType: "sale" | "inheritance" | "gift" | "court_order" | "initial";
  transferEventId?: string;
  createdAt: number;
  createdBy: string;
}

interface LotFixture {
  _id: string;
  _creationTime: number;
  code: string;
  isRetired: boolean;
}

interface ContractFixture {
  _id: string;
  _creationTime: number;
  lotId: string;
  state: string;
  familyEstateId?: string;
}

interface CustomerFixture {
  _id: string;
  _creationTime: number;
  fullName: string;
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
    reason?: string;
  };
}

const FROM_CUSTOMER_ID = "customers:from";
const TO_CUSTOMER_ID = "customers:to";
const LOT_ID = "lots:l1";

function makeCtx(opts: {
  roles?: RoleName[];
  initialOwnerships?: OwnershipFixture[];
  initialLots?: LotFixture[];
  initialCustomers?: CustomerFixture[];
  initialContracts?: ContractFixture[];
  authenticated?: boolean;
}) {
  const users = new Map<
    string,
    { _id: string; _creationTime: number; name?: string; isActive?: boolean }
  >();
  const userRoles = new Map<
    string,
    {
      _id: string;
      _creationTime: number;
      userId: string;
      role: RoleName;
      grantedAt: number;
      grantedBy: string;
    }
  >();
  const ownerships = new Map<string, OwnershipFixture>(
    (opts.initialOwnerships ?? []).map((o) => [o._id, o]),
  );
  const lots = new Map<string, LotFixture>(
    (opts.initialLots ?? []).map((l) => [l._id, l]),
  );
  const customers = new Map<string, CustomerFixture>(
    (opts.initialCustomers ?? []).map((c) => [c._id, c]),
  );
  const contracts = new Map<string, ContractFixture>(
    (opts.initialContracts ?? []).map((c) => [c._id, c]),
  );
  const inserts: AuditInsert[] = [];
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];

  users.set(CALLER_ID, {
    _id: CALLER_ID,
    _creationTime: T0 - 1000,
    name: "Office Staff",
    isActive: true,
  });
  const roles = opts.roles ?? ["office_staff"];
  roles.forEach((role, idx) => {
    const rid = `userRoles:caller-${idx}`;
    userRoles.set(rid, {
      _id: rid,
      _creationTime: T0,
      userId: CALLER_ID,
      role,
      grantedAt: T0,
      grantedBy: CALLER_ID,
    });
  });

  if (opts.authenticated === false) {
    mockedGetAuthUserId.mockResolvedValue(null);
    mockedGetAuthSessionId.mockResolvedValue(null);
  } else {
    mockedGetAuthUserId.mockResolvedValue(CALLER_ID as never);
    mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);
  }

  const session = {
    _id: SESSION_ID,
    _creationTime: T0,
    userId: CALLER_ID,
    expirationTime: T0 + 30 * 24 * HOUR_MS,
  };

  let nextId = 1;
  function newId(prefix: string): string {
    return `${prefix}:new-${nextId++}`;
  }

  interface IdxQuery {
    eq(field: string, value: unknown): IdxQuery;
  }

  function makeQueryBuilder(table: string) {
    type Pred = (r: Record<string, unknown>) => boolean;
    const predicates: Pred[] = [];
    const builder = {
      withIndex(_name: string, fn: (q: IdxQuery) => IdxQuery) {
        const q: IdxQuery = {
          eq(field: string, value: unknown) {
            predicates.push((r) => r[field] === value);
            return this;
          },
        };
        fn(q);
        return builder;
      },
      async collect(): Promise<Record<string, unknown>[]> {
        const source: Record<string, unknown>[] =
          table === "ownerships"
            ? (Array.from(ownerships.values()) as unknown as Record<
                string,
                unknown
              >[])
            : table === "contracts"
              ? (Array.from(contracts.values()) as unknown as Record<
                  string,
                  unknown
                >[])
              : [];
        return source.filter((r) => predicates.every((p) => p(r)));
      },
    };
    return builder;
  }

  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === CALLER_ID) return users.get(CALLER_ID);
        if (id === SESSION_ID) return session;
        if (users.has(id)) return users.get(id);
        if (lots.has(id)) return lots.get(id);
        if (ownerships.has(id)) return ownerships.get(id);
        if (customers.has(id)) return customers.get(id);
        return null;
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return {
            withIndex: () => ({
              collect: async () => Array.from(userRoles.values()),
            }),
          };
        }
        return makeQueryBuilder(table);
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "ownerships") {
          const id = newId("ownerships");
          ownerships.set(id, {
            _id: id,
            _creationTime: T0,
            ...(row as Omit<OwnershipFixture, "_id" | "_creationTime">),
          });
          return id;
        }
        if (table === "auditLog") {
          inserts.push({ table, row: row as AuditInsert["row"] });
          return `auditLog:${inserts.length}`;
        }
        return `${table}:?`;
      }),
      patch: vi.fn(
        async (id: string, patch: Record<string, unknown>) => {
          patches.push({ id, patch });
          const existing = ownerships.get(id);
          if (existing !== undefined) {
            ownerships.set(id, { ...existing, ...patch } as OwnershipFixture);
          }
        },
      ),
    },
  };

  return { ctx, ownerships, inserts, patches };
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

function makeOpenOwnership(
  overrides: Partial<OwnershipFixture> & { _id: string },
): OwnershipFixture {
  return {
    _creationTime: T0 - 30 * 24 * HOUR_MS,
    lotId: LOT_ID,
    customerId: FROM_CUSTOMER_ID,
    effectiveFrom: T0 - 30 * 24 * HOUR_MS,
    transferType: "initial",
    createdAt: T0 - 30 * 24 * HOUR_MS,
    createdBy: CALLER_ID,
    ...overrides,
  };
}

const VALID_ARGS = {
  fromCustomerId: FROM_CUSTOMER_ID,
  toCustomerId: TO_CUSTOMER_ID,
  lotId: LOT_ID,
  transferReason: "Sale per signed deed dated today",
  transferDate: T0,
  transferType: "sale" as const,
};

function defaultFixtures() {
  return {
    initialOwnerships: [
      makeOpenOwnership({ _id: "ownerships:current" }),
    ],
    initialLots: [
      { _id: LOT_ID, _creationTime: T0, code: "A-1", isRetired: false },
    ],
    initialCustomers: [
      { _id: FROM_CUSTOMER_ID, _creationTime: T0, fullName: "Mrs. Cruz" },
      { _id: TO_CUSTOMER_ID, _creationTime: T0, fullName: "Mr. Garcia" },
    ],
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

describe("recordOwnershipTransfer — auth gating", () => {
  const run = handlerOf(recordOwnershipTransfer);

  it("throws UNAUTHENTICATED when no session", async () => {
    const { ctx } = makeCtx({ ...defaultFixtures(), authenticated: false });
    const thrown = await run(ctx, VALID_ARGS).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("throws FORBIDDEN for field_worker", async () => {
    const { ctx } = makeCtx({
      ...defaultFixtures(),
      roles: ["field_worker"],
    });
    const thrown = await run(ctx, VALID_ARGS).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("throws FORBIDDEN for customer role", async () => {
    const { ctx } = makeCtx({ ...defaultFixtures(), roles: ["customer"] });
    const thrown = await run(ctx, VALID_ARGS).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("succeeds for office_staff", async () => {
    const { ctx } = makeCtx({ ...defaultFixtures(), roles: ["office_staff"] });
    const out = (await run(ctx, VALID_ARGS)) as {
      newOwnershipId: string;
      closedOwnershipId: string;
    };
    expect(out.newOwnershipId).toMatch(/^ownerships:new-/);
    expect(out.closedOwnershipId).toBe("ownerships:current");
  });

  it("succeeds for admin", async () => {
    const { ctx } = makeCtx({ ...defaultFixtures(), roles: ["admin"] });
    const out = await run(ctx, VALID_ARGS);
    expect(out).toBeDefined();
  });
});

describe("recordOwnershipTransfer — happy path", () => {
  const run = handlerOf(recordOwnershipTransfer);

  it("closes the previous ownership row with effectiveTo = transferDate", async () => {
    const { ctx, ownerships } = makeCtx(defaultFixtures());
    await run(ctx, VALID_ARGS);
    const closed = ownerships.get("ownerships:current")!;
    expect(closed.effectiveTo).toBe(T0);
  });

  it("inserts a new ownership row pointing at toCustomerId with effectiveFrom = transferDate", async () => {
    const { ctx, ownerships } = makeCtx(defaultFixtures());
    const out = (await run(ctx, VALID_ARGS)) as { newOwnershipId: string };
    const inserted = ownerships.get(out.newOwnershipId)!;
    expect(inserted.customerId).toBe(TO_CUSTOMER_ID);
    expect(inserted.lotId).toBe(LOT_ID);
    expect(inserted.effectiveFrom).toBe(T0);
    expect(inserted.effectiveTo).toBeUndefined();
    expect(inserted.transferType).toBe("sale");
    expect(inserted.createdBy).toBe(CALLER_ID);
  });

  it("emits an audit row with action='transfer' and entityType='ownership'", async () => {
    const { ctx, inserts } = makeCtx(defaultFixtures());
    await run(ctx, VALID_ARGS);
    expect(inserts).toHaveLength(1);
    const audit = inserts[0]!;
    expect(audit.row.action).toBe("transfer");
    expect(audit.row.entityType).toBe("ownership");
    expect(audit.row.actor).toBe(CALLER_ID);
    expect(audit.row.reason).toBe("Sale per signed deed dated today");
  });

  it("audit row captures before/after owner ids", async () => {
    const { ctx, inserts } = makeCtx(defaultFixtures());
    await run(ctx, VALID_ARGS);
    const before = inserts[0]!.row.before as Record<string, unknown>;
    const after = inserts[0]!.row.after as Record<string, unknown>;
    expect(before.ownerCustomerId).toBe(FROM_CUSTOMER_ID);
    expect(after.ownerCustomerId).toBe(TO_CUSTOMER_ID);
    expect(after.transferType).toBe("sale");
    expect(after.effectiveDate).toBe(T0);
  });

  it("defaults transferType to 'sale' when omitted", async () => {
    const { ctx, ownerships } = makeCtx(defaultFixtures());
    const { transferType: _drop, ...withoutType } = VALID_ARGS;
    void _drop;
    const out = (await run(ctx, withoutType)) as { newOwnershipId: string };
    expect(ownerships.get(out.newOwnershipId)!.transferType).toBe("sale");
  });

  it("supports inheritance transferType", async () => {
    const { ctx, ownerships } = makeCtx(defaultFixtures());
    const out = (await run(ctx, {
      ...VALID_ARGS,
      transferType: "inheritance" as const,
    })) as { newOwnershipId: string };
    expect(ownerships.get(out.newOwnershipId)!.transferType).toBe("inheritance");
  });

  it("trims the transferReason before storing in audit", async () => {
    const { ctx, inserts } = makeCtx(defaultFixtures());
    await run(ctx, {
      ...VALID_ARGS,
      transferReason: "   Sale per deed dated today   ",
    });
    expect(inserts[0]!.row.reason).toBe("Sale per deed dated today");
  });
});

describe("recordOwnershipTransfer — backdated reason", () => {
  const run = handlerOf(recordOwnershipTransfer);

  it("accepts a backdated transfer with a long-enough reason", async () => {
    const { ctx } = makeCtx(defaultFixtures());
    const backdated = T0 - 30 * 24 * HOUR_MS;
    const out = await run(ctx, {
      ...VALID_ARGS,
      transferDate: backdated,
      transferReason: "Legacy migration from 2018 paper ledger entry",
    });
    expect(out).toBeDefined();
  });

  it("rejects a backdated transfer with a short reason", async () => {
    const { ctx } = makeCtx(defaultFixtures());
    const backdated = T0 - 30 * 24 * HOUR_MS;
    const thrown = await run(ctx, {
      ...VALID_ARGS,
      transferDate: backdated,
      transferReason: "old",
    }).catch((e) => e);
    // "old" is 3 chars — passes the basic VALIDATION floor, then
    // trips the backdated-needs-≥10 INVARIANT_VIOLATION check.
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("rejects a backdated transfer with a 9-char reason (just below the 10-char floor)", async () => {
    const { ctx } = makeCtx(defaultFixtures());
    const backdated = T0 - 2 * 24 * HOUR_MS;
    const thrown = await run(ctx, {
      ...VALID_ARGS,
      transferDate: backdated,
      transferReason: "Nine char",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("accepts today's transferDate with a 3-char reason (not backdated)", async () => {
    const { ctx } = makeCtx(defaultFixtures());
    const out = await run(ctx, {
      ...VALID_ARGS,
      transferReason: "Yes",
    });
    expect(out).toBeDefined();
  });
});

describe("recordOwnershipTransfer — validation", () => {
  const run = handlerOf(recordOwnershipTransfer);

  it("rejects empty transferReason", async () => {
    const { ctx } = makeCtx(defaultFixtures());
    const thrown = await run(ctx, {
      ...VALID_ARGS,
      transferReason: "",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects whitespace-only transferReason", async () => {
    const { ctx } = makeCtx(defaultFixtures());
    const thrown = await run(ctx, {
      ...VALID_ARGS,
      transferReason: "   ",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects over-long transferReason (501 chars)", async () => {
    const { ctx } = makeCtx(defaultFixtures());
    const thrown = await run(ctx, {
      ...VALID_ARGS,
      transferReason: "x".repeat(501),
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects non-positive transferDate", async () => {
    const { ctx } = makeCtx(defaultFixtures());
    const thrown = await run(ctx, {
      ...VALID_ARGS,
      transferDate: 0,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects NaN transferDate", async () => {
    const { ctx } = makeCtx(defaultFixtures());
    const thrown = await run(ctx, {
      ...VALID_ARGS,
      transferDate: Number.NaN,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });
});

describe("recordOwnershipTransfer — invariant violations", () => {
  const run = handlerOf(recordOwnershipTransfer);

  it("rejects self-transfer (from === to)", async () => {
    const { ctx } = makeCtx(defaultFixtures());
    const thrown = await run(ctx, {
      ...VALID_ARGS,
      toCustomerId: FROM_CUSTOMER_ID,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("rejects transfer when the lot has no open ownership row", async () => {
    const { ctx } = makeCtx({
      initialOwnerships: [
        makeOpenOwnership({
          _id: "ownerships:closed",
          effectiveTo: T0 - 24 * HOUR_MS,
        }),
      ],
      initialLots: [
        { _id: LOT_ID, _creationTime: T0, code: "A-1", isRetired: false },
      ],
      initialCustomers: [
        { _id: FROM_CUSTOMER_ID, _creationTime: T0, fullName: "Mrs. Cruz" },
        { _id: TO_CUSTOMER_ID, _creationTime: T0, fullName: "Mr. Garcia" },
      ],
    });
    const thrown = await run(ctx, VALID_ARGS).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("rejects transfer when fromCustomerId does not match the current owner", async () => {
    const { ctx } = makeCtx({
      initialOwnerships: [
        makeOpenOwnership({
          _id: "ownerships:current",
          customerId: "customers:somebody-else",
        }),
      ],
      initialLots: [
        { _id: LOT_ID, _creationTime: T0, code: "A-1", isRetired: false },
      ],
      initialCustomers: [
        { _id: FROM_CUSTOMER_ID, _creationTime: T0, fullName: "Mrs. Cruz" },
        { _id: TO_CUSTOMER_ID, _creationTime: T0, fullName: "Mr. Garcia" },
      ],
    });
    const thrown = await run(ctx, VALID_ARGS).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("rejects transfer of a retired lot", async () => {
    const { ctx } = makeCtx({
      ...defaultFixtures(),
      initialLots: [
        { _id: LOT_ID, _creationTime: T0, code: "A-1", isRetired: true },
      ],
    });
    const thrown = await run(ctx, VALID_ARGS).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });
});

describe("recordOwnershipTransfer — missing entities", () => {
  const run = handlerOf(recordOwnershipTransfer);

  it("throws NOT_FOUND when destination customer does not exist", async () => {
    const { ctx } = makeCtx({
      ...defaultFixtures(),
      initialCustomers: [
        { _id: FROM_CUSTOMER_ID, _creationTime: T0, fullName: "Mrs. Cruz" },
      ],
    });
    const thrown = await run(ctx, VALID_ARGS).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("throws NOT_FOUND when lot does not exist", async () => {
    const { ctx } = makeCtx({
      ...defaultFixtures(),
      initialLots: [],
    });
    const thrown = await run(ctx, VALID_ARGS).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });
});

describe("recordOwnershipTransfer — atomicity", () => {
  const run = handlerOf(recordOwnershipTransfer);

  it("does NOT patch the previous ownership when validation fails", async () => {
    const { ctx, ownerships, inserts } = makeCtx(defaultFixtures());
    const thrown = await run(ctx, {
      ...VALID_ARGS,
      transferReason: "",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    const original = ownerships.get("ownerships:current")!;
    expect(original.effectiveTo).toBeUndefined();
    // No audit emitted on failure.
    expect(inserts).toHaveLength(0);
  });

  it("does NOT emit audit when invariant fails (self-transfer)", async () => {
    const { ctx, ownerships, inserts } = makeCtx(defaultFixtures());
    await run(ctx, { ...VALID_ARGS, toCustomerId: FROM_CUSTOMER_ID }).catch(
      (e) => e,
    );
    const original = ownerships.get("ownerships:current")!;
    expect(original.effectiveTo).toBeUndefined();
    expect(inserts).toHaveLength(0);
  });
});

/**
 * Story 2.9 adversarial-review HIGH (H1) — recordOwnershipTransfer
 * must refuse to rewrite a lot's per-lot ownership when the lot is
 * bound to a family-estate contract. The operator must use the
 * estate-wide flow (transferEstateOwnership) instead.
 */
describe("recordOwnershipTransfer — estate-aware gate (H1)", () => {
  const run = handlerOf(recordOwnershipTransfer);

  it("rejects when the lot's contract is bound to a family estate", async () => {
    const estateBoundContract: ContractFixture = {
      _id: "contracts:bound",
      _creationTime: T0,
      lotId: LOT_ID,
      state: "active",
      familyEstateId: "familyEstates:e1",
    };
    const { ctx, ownerships, inserts } = makeCtx({
      ...defaultFixtures(),
      initialContracts: [estateBoundContract],
    });
    const thrown = await run(ctx, VALID_ARGS).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
    const data = (thrown as ConvexError<Value>).data as unknown as ErrorPayload;
    const details = data.details as { kind?: string; familyEstateId?: string };
    expect(details.kind).toBe("estate_bound_use_transferEstateOwnership");
    expect(details.familyEstateId).toBe("familyEstates:e1");
    // No state was rewritten.
    const original = ownerships.get("ownerships:current")!;
    expect(original.effectiveTo).toBeUndefined();
    expect(inserts).toHaveLength(0);
  });

  it("rejects when the lot's contract is paid_in_full but estate-bound", async () => {
    // Even a settled contract that's estate-bound still routes the
    // transfer through the estate path — the estate ownership concept
    // persists past financial settlement.
    const paidEstateBound: ContractFixture = {
      _id: "contracts:paid",
      _creationTime: T0,
      lotId: LOT_ID,
      state: "paid_in_full",
      familyEstateId: "familyEstates:e1",
    };
    const { ctx } = makeCtx({
      ...defaultFixtures(),
      initialContracts: [paidEstateBound],
    });
    const thrown = await run(ctx, VALID_ARGS).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
    const data = (thrown as ConvexError<Value>).data as unknown as ErrorPayload;
    expect((data.details as { kind?: string }).kind).toBe(
      "estate_bound_use_transferEstateOwnership",
    );
  });

  it("allows the transfer when the lot's only contract is voided", async () => {
    const voided: ContractFixture = {
      _id: "contracts:voided",
      _creationTime: T0,
      lotId: LOT_ID,
      state: "voided",
      familyEstateId: "familyEstates:e1",
    };
    const { ctx } = makeCtx({
      ...defaultFixtures(),
      initialContracts: [voided],
    });
    const out = await run(ctx, VALID_ARGS);
    expect(out).toBeDefined();
  });

  it("allows the transfer when the lot's contract is NOT estate-bound", async () => {
    const singleLot: ContractFixture = {
      _id: "contracts:single",
      _creationTime: T0,
      lotId: LOT_ID,
      state: "paid_in_full",
      // familyEstateId omitted — single-lot contract.
    };
    const { ctx } = makeCtx({
      ...defaultFixtures(),
      initialContracts: [singleLot],
    });
    const out = await run(ctx, VALID_ARGS);
    expect(out).toBeDefined();
  });
});
