/**
 * The desk flow: a family arrives, someone has died, where do we put them.
 *
 * The rule this file exists to hold is the cemetery's, stated plainly:
 * a quick interment goes into an empty lot the family buys, a lot they
 * own, or a lot their family owns. Never anyone else's. The listing
 * query is a convenience and could be bypassed by a hand-made request,
 * so the tests below prove the MUTATION refuses a stranger's lot — not
 * merely that the page declines to show it.
 *
 * The other half is what a blocked option says. A lot the family owns
 * but has not paid far enough on is still shown, with the peso figure
 * that would unblock it, because a family sent away to buy a second
 * plot they do not need is a worse outcome than a hard "no".
 */

import { ConvexError, type Value } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCode, type ErrorPayload } from "../../../convex/lib/errors";
import { HOUR_MS } from "../../../convex/lib/time";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import {
  bookQuickInterment,
  findLotsForFamily,
} from "../../../convex/quickInterment";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const CALLER_ID = "users:office1";
const SESSION_ID = "authSessions:s1";

const CUSTOMER = "customers:reyes";
const STRANGER = "customers:cruz";

type Row = Record<string, unknown>;
type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface Tables {
  customers: Row[];
  lots: Row[];
  ownerships: Row[];
  familyEstates: Row[];
  occupants: Row[];
  contracts: Row[];
  installments: Row[];
  interments: Row[];
  ceremonies: Row[];
  appSettings: Row[];
}

function emptyTables(): Tables {
  return {
    customers: [],
    lots: [],
    ownerships: [],
    familyEstates: [],
    occupants: [],
    contracts: [],
    installments: [],
    interments: [],
    ceremonies: [],
    appSettings: [],
  };
}

/**
 * A fake db that honours the index predicates the production code
 * actually uses — `eq` plus the range forms the double-booking scans
 * depend on. A builder that ignored `gte`/`lte` would quietly make
 * every conflict scan match everything, and the booking tests would
 * fail for a reason that has nothing to do with the rule under test.
 */
function makeCtx(opts: {
  tables?: Partial<Tables>;
  roles?: RoleName[];
  authenticated?: boolean;
  thresholdPercent?: number;
}) {
  const t: Tables = { ...emptyTables(), ...opts.tables };
  const audit: Row[] = [];

  const caller = {
    _id: CALLER_ID,
    _creationTime: T0 - 1000,
    name: "Desk",
    email: "desk@example.com",
    isActive: true,
  };
  const userRoles = (opts.roles ?? ["office_staff"]).map((role, i) => ({
    _id: `userRoles:r${i}`,
    _creationTime: T0,
    userId: CALLER_ID,
    role,
    grantedAt: T0,
    grantedBy: CALLER_ID,
  }));

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

  if (t.appSettings.length === 0) {
    t.appSettings.push({
      _id: "appSettings:1",
      _creationTime: T0,
      key: "singleton",
      intermentPaymentThresholdPercent: opts.thresholdPercent ?? 50,
    });
  }

  let counter = 0;

  function builderFor(rows: Row[]) {
    const preds: Array<(r: Row) => boolean> = [];
    const q = {
      eq(f: string, v: unknown) {
        preds.push((r) => r[f] === v);
        return q;
      },
      gte(f: string, v: number) {
        preds.push((r) => (r[f] as number) >= v);
        return q;
      },
      gt(f: string, v: number) {
        preds.push((r) => (r[f] as number) > v);
        return q;
      },
      lte(f: string, v: number) {
        preds.push((r) => (r[f] as number) <= v);
        return q;
      },
      lt(f: string, v: number) {
        preds.push((r) => (r[f] as number) < v);
        return q;
      },
    };
    const b = {
      withIndex(_n: string, fn?: (x: typeof q) => unknown) {
        if (fn !== undefined) fn(q);
        return b;
      },
      async collect(): Promise<Row[]> {
        return rows.filter((r) => preds.every((p) => p(r)));
      },
      async first(): Promise<Row | null> {
        return (await b.collect())[0] ?? null;
      },
      async take(n: number): Promise<Row[]> {
        return (await b.collect()).slice(0, n);
      },
    };
    return b;
  }

  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === CALLER_ID) return caller;
        if (id === SESSION_ID) return session;
        for (const rows of Object.values(t) as Row[][]) {
          const hit = rows.find((r: Row) => r["_id"] === id);
          if (hit !== undefined) return hit;
        }
        return null;
      }),
      insert: vi.fn(async (table: string, row: Row) => {
        counter += 1;
        const id = `${table}:new${counter}`;
        const stored = { _id: id, _creationTime: T0, ...row };
        if (table === "auditLog") {
          audit.push(stored);
        } else {
          const rows = (t as unknown as Record<string, Row[] | undefined>)[
            table
          ];
          if (rows !== undefined) rows.push(stored);
        }
        return id;
      }),
      patch: vi.fn(async () => undefined),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return {
            withIndex: () => ({ collect: async () => userRoles }),
          };
        }
        const rows = (t as unknown as Record<string, Row[]>)[table] ?? [];
        return builderFor(rows);
      }),
    },
  };

  return { ctx, tables: t, audit };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerOf(fn: any): (ctx: unknown, args: unknown) => Promise<any> {
  for (const key of ["_handler", "handler", "invokeQuery"]) {
    const v = fn[key];
    if (typeof v === "function") return v as never;
  }
  if (typeof fn === "function") return fn as never;
  throw new Error("Cannot locate handler on Convex function");
}

const runFind = handlerOf(findLotsForFamily);
const runBook = handlerOf(bookQuickInterment);

function getCode(thrown: unknown): string | undefined {
  if (!(thrown instanceof ConvexError)) return undefined;
  return ((thrown as ConvexError<Value>).data as unknown as ErrorPayload)?.code;
}

// --- fixtures ---------------------------------------------------------

function customer(_id: string, fullName: string): Row {
  return { _id, _creationTime: T0, fullName };
}

function lot(_id: string, over: Partial<Row> = {}): Row {
  return {
    _id,
    _creationTime: T0,
    code: _id.replace("lots:", "").toUpperCase(),
    section: "Garden of Faith",
    block: "1",
    row: "1",
    type: "family",
    status: "sold",
    isRetired: false,
    basePriceCents: 100_000_00,
    ...over,
  };
}

function ownership(
  lotId: string,
  customerId: string,
  over: Partial<Row> = {},
): Row {
  return {
    _id: `ownerships:${lotId}-${customerId}`,
    _creationTime: T0,
    lotId,
    customerId,
    effectiveFrom: T0,
    transferType: "sale",
    createdAt: T0,
    createdBy: CALLER_ID,
    ...over,
  };
}

function estate(_id: string, over: Partial<Row> = {}): Row {
  return {
    _id,
    _creationTime: T0,
    name: "Reyes Family Estate",
    primaryOwnerCustomerId: CUSTOMER,
    secondaryOwnerCustomerIds: [],
    lotIds: [],
    createdAt: T0,
    createdByUserId: CALLER_ID,
    ...over,
  };
}

function occupant(lotId: string, kind: "body" | "bones", i: number): Row {
  return {
    _id: `occupants:${lotId}-${i}`,
    _creationTime: T0,
    lotId,
    name: `Occupant ${i}`,
    intermentKind: kind,
    relationshipToOwner: "parent",
    createdAt: T0,
    createdByUserId: CALLER_ID,
    isRemoved: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

// --- what the family may use ------------------------------------------

describe("the three sources, and nothing else", () => {
  it("offers a lot the customer owns", async () => {
    const { ctx } = makeCtx({
      tables: {
        customers: [customer(CUSTOMER, "Ana Reyes")],
        lots: [lot("lots:a1")],
        ownerships: [ownership("lots:a1", CUSTOMER)],
      },
    });
    const r = await runFind(ctx, { customerId: CUSTOMER });
    expect(r.existing).toHaveLength(1);
    expect(r.existing[0].relation).toBe("owned");
    expect(r.existing[0].canInterNow).toBe(true);
    expect(r.needsNewLot).toBe(false);
  });

  it("offers a lot their family estate holds, and says which estate", async () => {
    // The staffer has to explain to a grandchild why a plot they have
    // never been named on is theirs to use. The estate name is that
    // explanation.
    const { ctx } = makeCtx({
      tables: {
        customers: [customer(CUSTOMER, "Ana Reyes")],
        lots: [lot("lots:b2")],
        familyEstates: [
          estate("familyEstates:e1", {
            primaryOwnerCustomerId: STRANGER,
            secondaryOwnerCustomerIds: [CUSTOMER],
            lotIds: ["lots:b2"],
          }),
        ],
      },
    });
    const r = await runFind(ctx, { customerId: CUSTOMER });
    expect(r.existing).toHaveLength(1);
    expect(r.existing[0].relation).toBe("family_estate");
    expect(r.existing[0].estateName).toBe("Reyes Family Estate");
  });

  it("never offers a lot belonging to another family", async () => {
    const { ctx } = makeCtx({
      tables: {
        customers: [customer(CUSTOMER, "Ana Reyes")],
        lots: [lot("lots:a1"), lot("lots:z9")],
        ownerships: [
          ownership("lots:a1", CUSTOMER),
          ownership("lots:z9", STRANGER),
        ],
      },
    });
    const r = await runFind(ctx, { customerId: CUSTOMER });
    expect(r.existing.map((o: { code: string }) => o.code)).toEqual(["A1"]);
  });

  it("drops a lot they have transferred away", async () => {
    const { ctx } = makeCtx({
      tables: {
        customers: [customer(CUSTOMER, "Ana Reyes")],
        lots: [lot("lots:a1")],
        ownerships: [
          ownership("lots:a1", CUSTOMER, { effectiveTo: T0 - HOUR_MS }),
        ],
      },
    });
    const r = await runFind(ctx, { customerId: CUSTOMER });
    expect(r.existing).toHaveLength(0);
    expect(r.needsNewLot).toBe(true);
  });

  it("ignores a retired estate", async () => {
    const { ctx } = makeCtx({
      tables: {
        customers: [customer(CUSTOMER, "Ana Reyes")],
        lots: [lot("lots:b2")],
        familyEstates: [
          estate("familyEstates:e1", {
            lotIds: ["lots:b2"],
            retiredAt: T0 - HOUR_MS,
          }),
        ],
      },
    });
    const r = await runFind(ctx, { customerId: CUSTOMER });
    expect(r.existing).toHaveLength(0);
  });

  it("labels a lot they own outright as theirs, not as the estate's", async () => {
    // Both claims are real; the direct one is the one a family
    // recognises when it is read back to them.
    const { ctx } = makeCtx({
      tables: {
        customers: [customer(CUSTOMER, "Ana Reyes")],
        lots: [lot("lots:a1")],
        ownerships: [ownership("lots:a1", CUSTOMER)],
        familyEstates: [estate("familyEstates:e1", { lotIds: ["lots:a1"] })],
      },
    });
    const r = await runFind(ctx, { customerId: CUSTOMER });
    expect(r.existing).toHaveLength(1);
    expect(r.existing[0].relation).toBe("owned");
  });

  it("skips a retired lot", async () => {
    const { ctx } = makeCtx({
      tables: {
        customers: [customer(CUSTOMER, "Ana Reyes")],
        lots: [lot("lots:a1", { isRetired: true })],
        ownerships: [ownership("lots:a1", CUSTOMER)],
      },
    });
    const r = await runFind(ctx, { customerId: CUSTOMER });
    expect(r.existing).toHaveLength(0);
  });
});

// --- what a blocked option says ---------------------------------------

describe("an option that cannot be used today", () => {
  it("still lists a full lot, and says it is full", async () => {
    const { ctx } = makeCtx({
      tables: {
        customers: [customer(CUSTOMER, "Ana Reyes")],
        lots: [lot("lots:a1", { type: "single" })],
        ownerships: [ownership("lots:a1", CUSTOMER)],
        occupants: [
          occupant("lots:a1", "body", 1),
          // A single lot holds two bodies; this fills it.
          occupant("lots:a1", "body", 2),
        ],
      },
    });
    const r = await runFind(ctx, { customerId: CUSTOMER });
    expect(r.existing).toHaveLength(1);
    expect(r.existing[0].hasRoom).toBe(false);
    expect(r.existing[0].blockedReason).toContain("full");
    expect(r.needsNewLot).toBe(true);
  });

  it("names the peso shortfall on an under-paid contract", async () => {
    // Not "ineligible". A family can very often settle ₱30,000 at the
    // counter, and being told the number is what lets them.
    const { ctx } = makeCtx({
      tables: {
        customers: [customer(CUSTOMER, "Ana Reyes")],
        lots: [lot("lots:a1")],
        ownerships: [ownership("lots:a1", CUSTOMER)],
        contracts: [
          {
            _id: "contracts:c1",
            _creationTime: T0,
            lotId: "lots:a1",
            customerId: CUSTOMER,
            state: "active",
            totalPriceCents: 100_000_00,
          },
        ],
        installments: [
          {
            _id: "installments:i1",
            _creationTime: T0,
            contractId: "contracts:c1",
            paidCents: 20_000_00,
          },
        ],
      },
    });
    const r = await runFind(ctx, { customerId: CUSTOMER });
    expect(r.existing[0].canInterNow).toBe(false);
    expect(r.existing[0].shortfallCents).toBe(30_000_00);
    expect(r.existing[0].blockedReason).toContain("₱30,000");
  });

  it("clears the block once the threshold is met", async () => {
    const { ctx } = makeCtx({
      tables: {
        customers: [customer(CUSTOMER, "Ana Reyes")],
        lots: [lot("lots:a1")],
        ownerships: [ownership("lots:a1", CUSTOMER)],
        contracts: [
          {
            _id: "contracts:c1",
            _creationTime: T0,
            lotId: "lots:a1",
            customerId: CUSTOMER,
            state: "active",
            totalPriceCents: 100_000_00,
          },
        ],
        installments: [
          {
            _id: "installments:i1",
            _creationTime: T0,
            contractId: "contracts:c1",
            paidCents: 50_000_00,
          },
        ],
      },
    });
    const r = await runFind(ctx, { customerId: CUSTOMER });
    expect(r.existing[0].canInterNow).toBe(true);
  });

  it("puts the usable lot first", async () => {
    const { ctx } = makeCtx({
      tables: {
        customers: [customer(CUSTOMER, "Ana Reyes")],
        lots: [lot("lots:full", { type: "single" }), lot("lots:open")],
        ownerships: [
          ownership("lots:full", CUSTOMER),
          ownership("lots:open", CUSTOMER),
        ],
        occupants: [
          occupant("lots:full", "body", 1),
          occupant("lots:full", "body", 2),
        ],
      },
    });
    const r = await runFind(ctx, { customerId: CUSTOMER });
    expect(r.existing[0].code).toBe("OPEN");
    expect(r.needsNewLot).toBe(false);
  });

  it("explains why a purchase is being suggested", async () => {
    const { ctx } = makeCtx({
      tables: { customers: [customer(CUSTOMER, "Ana Reyes")] },
    });
    const r = await runFind(ctx, { customerId: CUSTOMER });
    expect(r.needsNewLot).toBe(true);
    expect(r.needsNewLotReason).toContain("Ana Reyes");
  });

  it("flags a lot they own that was never contracted", async () => {
    const { ctx } = makeCtx({
      tables: {
        customers: [customer(CUSTOMER, "Ana Reyes")],
        lots: [lot("lots:a1", { status: "available" })],
        ownerships: [ownership("lots:a1", CUSTOMER)],
      },
    });
    const r = await runFind(ctx, { customerId: CUSTOMER });
    expect(r.existing[0].canInterNow).toBe(false);
    expect(r.existing[0].blockedReason).toContain("contract");
  });
});

describe("who may ask", () => {
  it("refuses a field worker", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    await expect(runFind(ctx, { customerId: CUSTOMER })).rejects.toThrow();
  });
});

// --- booking ----------------------------------------------------------

describe("booking at the desk", () => {
  const goodBooking = {
    customerId: CUSTOMER,
    lotId: "lots:a1",
    deceasedName: "Jose Reyes",
    dateOfDeath: T0 - 24 * HOUR_MS,
    relationshipToOwner: "father",
    scheduledAt: T0 + 48 * HOUR_MS,
  };

  function ownedLotWorld() {
    return makeCtx({
      tables: {
        customers: [customer(CUSTOMER, "Ana Reyes")],
        lots: [lot("lots:a1")],
        ownerships: [ownership("lots:a1", CUSTOMER)],
      },
    });
  }

  it("records the deceased and the interment together", async () => {
    const { ctx, tables } = ownedLotWorld();
    const r = await runBook(ctx, goodBooking);
    expect(r.occupantId).toBeDefined();
    expect(r.intermentId).toBeDefined();
    expect(tables.occupants).toHaveLength(1);
    expect(tables.occupants[0]?.name).toBe("Jose Reyes");
    expect(tables.occupants[0]?.dateOfDeath).toBe(goodBooking.dateOfDeath);
    expect(tables.interments).toHaveLength(1);
    expect(tables.interments[0]?.occupantId).toBe(r.occupantId);
  });

  it("REFUSES a lot the family has no claim on", async () => {
    // The rule, at the only place that can enforce it. The listing
    // query would never have shown this lot; a hand-made request can
    // still name it.
    const { ctx, tables } = makeCtx({
      tables: {
        customers: [
          customer(CUSTOMER, "Ana Reyes"),
          customer(STRANGER, "Cruz"),
        ],
        lots: [lot("lots:z9")],
        ownerships: [ownership("lots:z9", STRANGER)],
      },
    });
    let thrown: unknown;
    try {
      await runBook(ctx, { ...goodBooking, lotId: "lots:z9" });
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(String(thrown)).toContain("Ana Reyes");
    // And nothing was written on the way to refusing.
    expect(tables.occupants).toHaveLength(0);
    expect(tables.interments).toHaveLength(0);
  });

  it("accepts a lot reached through the family estate", async () => {
    const { ctx, tables } = makeCtx({
      tables: {
        customers: [customer(CUSTOMER, "Ana Reyes")],
        lots: [lot("lots:b2")],
        familyEstates: [
          estate("familyEstates:e1", {
            primaryOwnerCustomerId: STRANGER,
            secondaryOwnerCustomerIds: [CUSTOMER],
            lotIds: ["lots:b2"],
          }),
        ],
      },
    });
    await runBook(ctx, { ...goodBooking, lotId: "lots:b2" });
    expect(tables.interments).toHaveLength(1);
  });

  it("refuses a burial dated before the death", async () => {
    const { ctx, tables } = ownedLotWorld();
    let thrown: unknown;
    try {
      await runBook(ctx, {
        ...goodBooking,
        dateOfDeath: T0 + 24 * HOUR_MS,
        scheduledAt: T0 + HOUR_MS,
      });
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    expect(tables.occupants).toHaveLength(0);
  });

  it("allows a burial on the day of the death", async () => {
    // Same-day burial is ordinary here. A raw timestamp comparison
    // would reject an 8am booking for a 10am death.
    const { ctx, tables } = ownedLotWorld();
    await runBook(ctx, {
      ...goodBooking,
      dateOfDeath: T0 + 6 * HOUR_MS,
      scheduledAt: T0 + 2 * HOUR_MS,
    });
    expect(tables.interments).toHaveLength(1);
  });

  it("refuses when the lot is full", async () => {
    const { ctx, tables } = makeCtx({
      tables: {
        customers: [customer(CUSTOMER, "Ana Reyes")],
        lots: [lot("lots:a1", { type: "single" })],
        ownerships: [ownership("lots:a1", CUSTOMER)],
        occupants: [
          occupant("lots:a1", "body", 1),
          occupant("lots:a1", "body", 2),
        ],
      },
    });
    await expect(runBook(ctx, goodBooking)).rejects.toThrow();
    expect(tables.interments).toHaveLength(0);
  });

  it("refuses when the contract is short of the threshold", async () => {
    const { ctx, tables } = makeCtx({
      tables: {
        customers: [customer(CUSTOMER, "Ana Reyes")],
        lots: [lot("lots:a1")],
        ownerships: [ownership("lots:a1", CUSTOMER)],
        contracts: [
          {
            _id: "contracts:c1",
            _creationTime: T0,
            lotId: "lots:a1",
            customerId: CUSTOMER,
            state: "active",
            totalPriceCents: 100_000_00,
          },
        ],
        installments: [
          {
            _id: "installments:i1",
            _creationTime: T0,
            contractId: "contracts:c1",
            paidCents: 10_000_00,
          },
        ],
      },
    });
    await expect(runBook(ctx, goodBooking)).rejects.toThrow();
    expect(tables.interments).toHaveLength(0);
  });

  it("takes a set of bones into a lot with only half a space left", async () => {
    const { ctx, tables } = makeCtx({
      tables: {
        customers: [customer(CUSTOMER, "Ana Reyes")],
        lots: [lot("lots:a1", { type: "single" })],
        ownerships: [ownership("lots:a1", CUSTOMER)],
        occupants: [
          occupant("lots:a1", "body", 1),
          occupant("lots:a1", "bones", 2),
        ],
      },
    });
    await runBook(ctx, { ...goodBooking, intermentKind: "bones" });
    expect(tables.occupants).toHaveLength(3);
    expect(tables.interments).toHaveLength(1);
  });

  it("refuses a field worker", async () => {
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      tables: {
        customers: [customer(CUSTOMER, "Ana Reyes")],
        lots: [lot("lots:a1")],
        ownerships: [ownership("lots:a1", CUSTOMER)],
      },
    });
    let thrown: unknown;
    try {
      await runBook(ctx, goodBooking);
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});
