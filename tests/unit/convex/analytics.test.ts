/**
 * What counts as a lot leaving the shelf.
 *
 * The arithmetic lives in `convex/lib/absorption.ts` and is tested
 * there. This file is about the other half — the counting rules — which
 * is where an inventory report goes quietly wrong:
 *
 *   - a voided contract released its lot, so counting it reports ground
 *     as sold that is standing available
 *   - two contracts on one lot in one month is one lot of inventory
 *   - a cancelled interment never happened
 *   - a retired lot is not inventory at all
 *
 * None of these produce an error. They produce a runway that is wrong
 * by a year or two, on a screen someone commits a development budget
 * against.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { HOUR_MS } from "../../../convex/lib/time";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { getInventoryAnalytics } from "../../../convex/analytics";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

/** Mid-month, so the current bucket is unambiguous. */
const T0 = new Date("2026-06-15T10:00:00+08:00").getTime();
const CALLER_ID = "users:admin1";
const SESSION_ID = "authSessions:s1";

const DAY_MS = 24 * HOUR_MS;

type Row = Record<string, unknown>;
type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface Tables {
  lots: Row[];
  contracts: Row[];
  interments: Row[];
  phases: Row[];
}

function makeCtx(opts: { tables?: Partial<Tables>; roles?: RoleName[] }) {
  const t: Tables = {
    lots: [],
    contracts: [],
    interments: [],
    phases: [],
    ...opts.tables,
  };

  const caller = {
    _id: CALLER_ID,
    _creationTime: T0 - 1000,
    name: "Owner",
    email: "owner@example.com",
    isActive: true,
  };
  const userRoles = (opts.roles ?? ["admin"]).map((role, i) => ({
    _id: `userRoles:r${i}`,
    _creationTime: T0,
    userId: CALLER_ID,
    role,
    grantedAt: T0,
    grantedBy: CALLER_ID,
  }));

  mockedGetAuthUserId.mockResolvedValue(CALLER_ID as never);
  mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);

  const session = {
    _id: SESSION_ID,
    _creationTime: T0,
    userId: CALLER_ID,
    expirationTime: T0 + 30 * DAY_MS,
  };

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
      lt(f: string, v: number) {
        preds.push((r) => (r[f] as number) < v);
        return q;
      },
      lte(f: string, v: number) {
        preds.push((r) => (r[f] as number) <= v);
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
        return null;
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return { withIndex: () => ({ collect: async () => userRoles }) };
        }
        return builderFor((t as unknown as Record<string, Row[]>)[table] ?? []);
      }),
    },
  };

  return { ctx };
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

const run = handlerOf(getInventoryAnalytics);

// --- fixtures ---------------------------------------------------------

let seq = 0;

function lot(over: Partial<Row> = {}): Row {
  seq += 1;
  return {
    _id: `lots:l${seq}`,
    _creationTime: T0,
    code: `A-${seq}`,
    section: "Garden of Faith",
    status: "available",
    isRetired: false,
    ...over,
  };
}

/** A contract created `monthsAgo` whole months before the fixed clock. */
function contract(monthsAgo: number, over: Partial<Row> = {}): Row {
  seq += 1;
  const d = new Date(T0);
  d.setUTCMonth(d.getUTCMonth() - monthsAgo);
  return {
    _id: `contracts:c${seq}`,
    _creationTime: T0,
    lotId: `lots:l${seq}`,
    createdAt: d.getTime(),
    state: "active",
    totalPriceCents: 100_000_00,
    ...over,
  };
}

function interment(monthsAgo: number, over: Partial<Row> = {}): Row {
  seq += 1;
  const d = new Date(T0);
  d.setUTCMonth(d.getUTCMonth() - monthsAgo);
  return {
    _id: `interments:i${seq}`,
    _creationTime: T0,
    lotId: `lots:l1`,
    scheduledAt: d.getTime(),
    status: "completed",
    ...over,
  };
}

function phase(over: Partial<Row> = {}): Row {
  seq += 1;
  return {
    _id: `phases:p${seq}`,
    _creationTime: T0,
    number: 1,
    name: "Phase 1",
    stage: "live",
    sectionsLabel: "Gardens of Faith",
    plannedLotCount: 500,
    availableLotCount: 100,
    monthlyAbsorption: 5,
    surveyLeadWeeks: 12,
    readiness: [],
    isRetired: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  seq = 0;
});

// --- inventory --------------------------------------------------------

describe("counting what there is", () => {
  it("splits the park by status", async () => {
    const { ctx } = makeCtx({
      tables: {
        lots: [
          lot({ status: "available" }),
          lot({ status: "available" }),
          lot({ status: "reserved" }),
          lot({ status: "sold" }),
          lot({ status: "occupied" }),
        ],
      },
    });
    const r = await run(ctx, {});
    expect(r.totalLots).toBe(5);
    expect(r.availableLots).toBe(2);
    expect(r.reservedLots).toBe(1);
    expect(r.soldLots).toBe(1);
    expect(r.occupiedLots).toBe(1);
  });

  it("does not count a retired lot as inventory", async () => {
    // A retired lot is ground taken out of service — a drainage
    // problem, a boundary correction. Counting it inflates the runway.
    const { ctx } = makeCtx({
      tables: {
        lots: [lot({ status: "available" }), lot({ isRetired: true })],
      },
    });
    const r = await run(ctx, {});
    expect(r.totalLots).toBe(1);
    expect(r.availableLots).toBe(1);
    expect(r.retiredLots).toBe(1);
  });

  it("does NOT fold cancelled or defaulted lots into available", async () => {
    // They are not on sale. Treating them as available would promise
    // ground the office cannot actually sell today.
    const { ctx } = makeCtx({
      tables: {
        lots: [
          lot({ status: "available" }),
          lot({ status: "cancelled" }),
          lot({ status: "defaulted" }),
          lot({ status: "transferred" }),
        ],
      },
    });
    const r = await run(ctx, {});
    expect(r.totalLots).toBe(4);
    expect(r.availableLots).toBe(1);
  });

  it("groups gardens, best sell-through first", async () => {
    const { ctx } = makeCtx({
      tables: {
        lots: [
          lot({ section: "Slow Garden", status: "available" }),
          lot({ section: "Slow Garden", status: "available" }),
          lot({ section: "Fast Garden", status: "sold" }),
          lot({ section: "Fast Garden", status: "sold" }),
        ],
      },
    });
    const r = await run(ctx, {});
    expect(r.sections).toHaveLength(2);
    expect(r.sections[0].section).toBe("Fast Garden");
    expect(r.sections[0].sellThroughPercent).toBe(100);
    expect(r.sections[1].sellThroughPercent).toBe(0);
  });
});

// --- what counts as a sale -------------------------------------------

describe("counting what left the shelf", () => {
  it("counts an active contract", async () => {
    const { ctx } = makeCtx({
      tables: {
        lots: [lot()],
        contracts: [contract(1, { lotId: "lots:x1" })],
      },
    });
    const r = await run(ctx, {});
    expect(r.absorption.totalSold).toBe(1);
  });

  it("does NOT count a voided contract", async () => {
    // The lot went back on the shelf. Counting it reports ground as
    // sold that is standing available right now.
    const { ctx } = makeCtx({
      tables: {
        lots: [lot()],
        contracts: [
          contract(1, { lotId: "lots:x1", state: "voided" }),
          contract(1, { lotId: "lots:x2", state: "cancelled" }),
        ],
      },
    });
    const r = await run(ctx, {});
    expect(r.absorption.totalSold).toBe(0);
  });

  it("counts a contract in default — the lot is still held", async () => {
    const { ctx } = makeCtx({
      tables: {
        lots: [lot()],
        contracts: [contract(1, { lotId: "lots:x1", state: "in_default" })],
      },
    });
    const r = await run(ctx, {});
    expect(r.absorption.totalSold).toBe(1);
  });

  it("counts two contracts on ONE lot in one month as one lot", async () => {
    // A correction or a re-paper is not a second lot of inventory.
    const { ctx } = makeCtx({
      tables: {
        lots: [lot()],
        contracts: [
          contract(1, { lotId: "lots:same" }),
          contract(1, { lotId: "lots:same" }),
        ],
      },
    });
    const r = await run(ctx, {});
    expect(r.absorption.totalSold).toBe(1);
  });

  it("spreads sales across the right months", async () => {
    const { ctx } = makeCtx({
      tables: {
        lots: [lot()],
        contracts: [
          contract(0, { lotId: "lots:a" }),
          contract(1, { lotId: "lots:b" }),
          contract(1, { lotId: "lots:c" }),
        ],
      },
    });
    const r = await run(ctx, {});
    expect(r.series).toHaveLength(12);
    expect(r.series[11].lotsSold).toBe(1); // this month
    expect(r.series[10].lotsSold).toBe(2); // last month
    expect(r.absorption.totalSold).toBe(3);
  });
});

// --- interments -------------------------------------------------------

describe("counting the work the crew did", () => {
  it("counts scheduled and completed interments", async () => {
    const { ctx } = makeCtx({
      tables: {
        lots: [lot()],
        interments: [
          interment(1, { status: "completed" }),
          interment(0, { status: "scheduled" }),
        ],
      },
    });
    const r = await run(ctx, {});
    expect(r.intermentsInWindow).toBe(2);
  });

  it("does NOT count a cancelled interment", async () => {
    const { ctx } = makeCtx({
      tables: {
        lots: [lot()],
        interments: [interment(1, { status: "cancelled" })],
      },
    });
    const r = await run(ctx, {});
    expect(r.intermentsInWindow).toBe(0);
  });
});

// --- the plan check ---------------------------------------------------

describe("checking the phase plan", () => {
  it("puts each live phase's assumption beside the measured rate", async () => {
    const { ctx } = makeCtx({
      tables: {
        lots: [lot()],
        phases: [phase({ monthlyAbsorption: 5 })],
        // Twelve months at five a month — the plan is right.
        contracts: Array.from({ length: 12 }, (_, m) =>
          Array.from({ length: 5 }, (_, k) =>
            contract(m, { lotId: `lots:m${m}k${k}` }),
          ),
        ).flat(),
      },
    });
    const r = await run(ctx, {});
    expect(r.absorption.perMonth).toBe(5);
    expect(r.phaseChecks).toHaveLength(1);
    expect(r.phaseChecks[0].variance.verdict).toBe("agrees");
  });

  it("flags a phase whose assumption is far under the real rate", async () => {
    const { ctx } = makeCtx({
      tables: {
        lots: [lot()],
        phases: [phase({ monthlyAbsorption: 2 })],
        contracts: Array.from({ length: 12 }, (_, m) =>
          Array.from({ length: 9 }, (_, k) =>
            contract(m, { lotId: `lots:m${m}k${k}` }),
          ),
        ).flat(),
      },
    });
    const r = await run(ctx, {});
    expect(r.phaseChecks[0].variance.verdict).toBe("sales_above_plan");
    expect(r.phaseChecks[0].variance.isRisk).toBe(true);
  });

  it("skips a retired phase", async () => {
    const { ctx } = makeCtx({
      tables: {
        lots: [lot()],
        phases: [phase(), phase({ number: 2, isRetired: true })],
      },
    });
    const r = await run(ctx, {});
    expect(r.phaseChecks).toHaveLength(1);
  });
});

// --- the whole-park answer -------------------------------------------

describe("the runway", () => {
  it("never claims infinite ground when nothing has sold", async () => {
    // The failure that matters. An empty sales window with 500 lots on
    // the shelf must read as "not measurable", not as forever.
    const { ctx } = makeCtx({
      tables: {
        lots: Array.from({ length: 20 }, () => lot({ status: "available" })),
      },
    });
    const r = await run(ctx, {});
    expect(r.runway.months).toBeNull();
    expect(r.runway.label).toContain("Not measurable");
    expect(r.absorption.confidence).toBe("insufficient");
  });

  it("divides real inventory by the real rate", async () => {
    const { ctx } = makeCtx({
      tables: {
        lots: Array.from({ length: 60 }, () => lot({ status: "available" })),
        contracts: Array.from({ length: 12 }, (_, m) =>
          Array.from({ length: 5 }, (_, k) =>
            contract(m, { lotId: `lots:m${m}k${k}` }),
          ),
        ).flat(),
      },
    });
    const r = await run(ctx, {});
    expect(r.absorption.perMonth).toBe(5);
    expect(r.runway.months).toBe(12);
    expect(r.runway.isUrgent).toBe(true);
  });
});

describe("who may read it", () => {
  it("refuses a field worker", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    await expect(run(ctx, {})).rejects.toThrow();
  });

  it("allows office staff", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"], tables: { lots: [lot()] } });
    await expect(run(ctx, {})).resolves.toBeDefined();
  });
});
