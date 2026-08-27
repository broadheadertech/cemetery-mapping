/**
 * Who may change what the cemetery charges, and what a lot quotes at.
 *
 * The arithmetic is tested in `lib/pricing.test.ts`. This file covers
 * the two things that module cannot know about:
 *
 *   1. The gate. Office staff read plans all day to fill a sale form.
 *      They must never be able to create one — inventing a
 *      ninety-per-cent plan on the way to closing a sale is a shorter
 *      path to a giveaway than any discount field.
 *
 *   2. The selection. `quoteLot` picks the best promotion for each plan
 *      on the family's behalf, because whether a flat ₱5,000 beats 5%
 *      depends on the lot and nobody should work that out at a counter.
 *      It also has to say why an offer did NOT apply.
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
  createPaymentPlan,
  createPromo,
  listPaymentPlans,
  quoteLot,
  setPaymentPlanRetired,
} from "../../../convex/paymentPlans";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-11-01T10:00:00+08:00").getTime();
const DAY_MS = 24 * HOUR_MS;
const CALLER_ID = "users:admin1";
const SESSION_ID = "authSessions:s1";

type Row = Record<string, unknown>;
type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface Tables {
  lots: Row[];
  paymentPlans: Row[];
  promos: Row[];
  appSettings: Row[];
}

function makeCtx(opts: { tables?: Partial<Tables>; roles?: RoleName[] }) {
  const t: Tables = {
    lots: [],
    paymentPlans: [],
    promos: [],
    appSettings: [],
    ...opts.tables,
  };
  const audit: Row[] = [];

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
        if (table === "auditLog") audit.push(stored);
        else {
          const rows = (t as unknown as Record<string, Row[] | undefined>)[
            table
          ];
          if (rows !== undefined) rows.push(stored);
        }
        return id;
      }),
      patch: vi.fn(async (id: string, patch: Row) => {
        for (const rows of Object.values(t) as Row[][]) {
          const hit = rows.find((r) => r["_id"] === id);
          if (hit !== undefined) Object.assign(hit, patch);
        }
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return { withIndex: () => ({ collect: async () => userRoles }) };
        }
        return builderFor((t as unknown as Record<string, Row[]>)[table] ?? []);
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

const runCreatePlan = handlerOf(createPaymentPlan);
const runListPlans = handlerOf(listPaymentPlans);
const runRetirePlan = handlerOf(setPaymentPlanRetired);
const runCreatePromo = handlerOf(createPromo);
const runQuote = handlerOf(quoteLot);

function getCode(thrown: unknown): string | undefined {
  if (!(thrown instanceof ConvexError)) return undefined;
  return ((thrown as ConvexError<Value>).data as unknown as ErrorPayload)?.code;
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (e) {
    return getCode(e);
  }
  return undefined;
}

// --- fixtures ---------------------------------------------------------

const LOT = {
  _id: "lots:a1",
  _creationTime: T0,
  code: "A-1",
  section: "Garden of Faith",
  type: "family",
  status: "available",
  isRetired: false,
  basePriceCents: 100_000_00,
};

function plan(over: Partial<Row> = {}): Row {
  return {
    _id: `paymentPlans:${String(over["name"] ?? "p").replace(/\W/g, "")}`,
    _creationTime: T0,
    name: "Cash",
    kind: "full_payment",
    appliesToLotTypes: [],
    isDefault: false,
    sortOrder: 1,
    isRetired: false,
    createdAt: T0,
    createdByUserId: CALLER_ID,
    updatedAt: T0,
    ...over,
  };
}

function promo(over: Partial<Row> = {}): Row {
  return {
    _id: `promos:${String(over["name"] ?? "x").replace(/\W/g, "")}`,
    _creationTime: T0,
    name: "All Souls",
    startsAt: T0 - 7 * DAY_MS,
    endsAt: T0 + 7 * DAY_MS,
    appliesToLotTypes: [],
    appliesToSections: [],
    appliesToPlanKinds: [],
    redemptionCount: 0,
    isRetired: false,
    createdAt: T0,
    createdByUserId: CALLER_ID,
    updatedAt: T0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

// --- the gate ---------------------------------------------------------

describe("who may change what the cemetery charges", () => {
  const goodPlan = { name: "Cash — 10% off", kind: "full_payment" as const };

  it("lets an admin create a plan", async () => {
    const { ctx, tables } = makeCtx({ roles: ["admin"] });
    await runCreatePlan(ctx, goodPlan);
    expect(tables.paymentPlans).toHaveLength(1);
  });

  it("REFUSES office staff", async () => {
    // The one that matters. Office staff close sales; a staffer who can
    // mint a plan can price a lot at anything and it looks routine.
    const { ctx, tables } = makeCtx({ roles: ["office_staff"] });
    expect(await codeOf(() => runCreatePlan(ctx, goodPlan))).toBe(
      ErrorCode.FORBIDDEN,
    );
    expect(tables.paymentPlans).toHaveLength(0);
  });

  it("REFUSES office staff a promotion too", async () => {
    const { ctx, tables } = makeCtx({ roles: ["office_staff"] });
    const code = await codeOf(() =>
      runCreatePromo(ctx, {
        name: "Sneaky",
        discountPercent: 40,
        startsAt: T0,
        endsAt: T0 + DAY_MS,
      }),
    );
    expect(code).toBe(ErrorCode.FORBIDDEN);
    expect(tables.promos).toHaveLength(0);
  });

  it("still lets office staff READ the plans", async () => {
    // They fill the sale form from this list every day.
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      tables: { paymentPlans: [plan()] },
    });
    await expect(runListPlans(ctx, {})).resolves.toHaveLength(1);
  });

  it("refuses a field worker even a read", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    expect(await codeOf(() => runListPlans(ctx, {}))).toBe(ErrorCode.FORBIDDEN);
  });
});

// --- shapes that cannot close a sale ----------------------------------

describe("plans the sale flow would reject are refused up front", () => {
  it("refuses an instalment plan with no deposit", async () => {
    // `recordInstallmentSale` throws ZERO_DOWN_NOT_SUPPORTED. A plan
    // that can never close a sale should not be storable.
    const { ctx } = makeCtx({});
    const code = await codeOf(() =>
      runCreatePlan(ctx, {
        name: "No deposit",
        kind: "installment",
        termMonths: 12,
        downPaymentPercent: 0,
      }),
    );
    expect(code).toBe(ErrorCode.VALIDATION);
  });

  it("refuses an instalment plan with no term", async () => {
    const { ctx } = makeCtx({});
    const code = await codeOf(() =>
      runCreatePlan(ctx, {
        name: "No term",
        kind: "installment",
        downPaymentPercent: 20,
      }),
    );
    expect(code).toBe(ErrorCode.VALIDATION);
  });

  it("refuses a term beyond sixty months", async () => {
    const { ctx } = makeCtx({});
    const code = await codeOf(() =>
      runCreatePlan(ctx, {
        name: "Too long",
        kind: "installment",
        downPaymentPercent: 20,
        termMonths: 120,
      }),
    );
    expect(code).toBe(ErrorCode.VALIDATION);
  });

  it("refuses a deposit of the whole price", async () => {
    const { ctx } = makeCtx({});
    const code = await codeOf(() =>
      runCreatePlan(ctx, {
        name: "All of it",
        kind: "installment",
        downPaymentPercent: 100,
        termMonths: 12,
      }),
    );
    expect(code).toBe(ErrorCode.VALIDATION);
  });

  it("refuses a discount over 100 per cent", async () => {
    const { ctx } = makeCtx({});
    const code = await codeOf(() =>
      runCreatePlan(ctx, {
        name: "Free",
        kind: "full_payment",
        discountPercent: 150,
      }),
    );
    expect(code).toBe(ErrorCode.VALIDATION);
  });

  it("refuses a promotion carrying both a percent and pesos", async () => {
    const { ctx } = makeCtx({});
    const code = await codeOf(() =>
      runCreatePromo(ctx, {
        name: "Muddle",
        discountPercent: 5,
        discountCents: 5000,
        startsAt: T0,
        endsAt: T0 + DAY_MS,
      }),
    );
    expect(code).toBe(ErrorCode.VALIDATION);
  });

  it("refuses a promotion with neither", async () => {
    const { ctx } = makeCtx({});
    const code = await codeOf(() =>
      runCreatePromo(ctx, {
        name: "Empty",
        startsAt: T0,
        endsAt: T0 + DAY_MS,
      }),
    );
    expect(code).toBe(ErrorCode.VALIDATION);
  });

  it("refuses a promotion that ends before it starts", async () => {
    const { ctx } = makeCtx({});
    const code = await codeOf(() =>
      runCreatePromo(ctx, {
        name: "Backwards",
        discountPercent: 5,
        startsAt: T0 + DAY_MS,
        endsAt: T0,
      }),
    );
    expect(code).toBe(ErrorCode.VALIDATION);
  });

  it("refuses a code already in use", async () => {
    const { ctx } = makeCtx({
      tables: { promos: [promo({ code: "UNDAS", discountPercent: 5 })] },
    });
    const code = await codeOf(() =>
      runCreatePromo(ctx, {
        name: "Second",
        code: "undas",
        discountPercent: 10,
        startsAt: T0,
        endsAt: T0 + DAY_MS,
      }),
    );
    expect(code).toBe(ErrorCode.VALIDATION);
  });
});

// --- the default ------------------------------------------------------

describe("the default plan", () => {
  it("clears the previous default of the same kind", async () => {
    // Two defaults means the sale form opens on whichever the sort
    // happens to surface — a bug nobody reports and everybody works
    // around.
    const { ctx, tables } = makeCtx({
      tables: {
        paymentPlans: [plan({ name: "Old", isDefault: true })],
      },
    });
    await runCreatePlan(ctx, {
      name: "New",
      kind: "full_payment",
      isDefault: true,
    });
    const defaults = tables.paymentPlans.filter((p) => p["isDefault"] === true);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.["name"]).toBe("New");
  });

  it("leaves the other kind's default alone", async () => {
    // Cash and instalments each have one. Setting a cash default must
    // not silently unset the instalment one.
    const { ctx, tables } = makeCtx({
      tables: {
        paymentPlans: [
          plan({
            name: "12 months",
            kind: "installment",
            isDefault: true,
            downPaymentPercent: 20,
            termMonths: 12,
          }),
        ],
      },
    });
    await runCreatePlan(ctx, {
      name: "Cash",
      kind: "full_payment",
      isDefault: true,
    });
    expect(
      tables.paymentPlans.filter((p) => p["isDefault"] === true),
    ).toHaveLength(2);
  });

  it("drops the default flag when the default is retired", async () => {
    // Otherwise the sale form opens on a plan it will not show.
    const { ctx, tables } = makeCtx({
      tables: { paymentPlans: [plan({ name: "Old", isDefault: true })] },
    });
    await runRetirePlan(ctx, {
      planId: tables.paymentPlans[0]?.["_id"],
      isRetired: true,
    });
    expect(tables.paymentPlans[0]?.["isDefault"]).toBe(false);
  });

  it("retires rather than deletes", async () => {
    // Contracts point at plans. A contract has to go on saying what it
    // was sold under long after the offer ended.
    const { ctx, tables } = makeCtx({
      tables: { paymentPlans: [plan({ name: "Old" })] },
    });
    await runRetirePlan(ctx, {
      planId: tables.paymentPlans[0]?.["_id"],
      isRetired: true,
    });
    expect(tables.paymentPlans).toHaveLength(1);
    expect(tables.paymentPlans[0]?.["isRetired"]).toBe(true);
  });
});

// --- quoting a lot ----------------------------------------------------

describe("quoting a lot", () => {
  it("prices every plan on offer", async () => {
    const { ctx } = makeCtx({
      tables: {
        lots: [LOT],
        paymentPlans: [
          plan({ name: "Cash", discountPercent: 10 }),
          plan({
            name: "12 months",
            kind: "installment",
            downPaymentPercent: 20,
            termMonths: 12,
            sortOrder: 2,
          }),
        ],
      },
    });
    const q = await runQuote(ctx, { lotId: "lots:a1" });
    expect(q.options).toHaveLength(2);
    expect(q.options[0].netPriceCents).toBe(90_000_00);
    expect(q.options[1].downPaymentCents).toBe(20_000_00);
  });

  it("hides a retired plan", async () => {
    const { ctx } = makeCtx({
      tables: {
        lots: [LOT],
        paymentPlans: [plan({ name: "Gone", isRetired: true })],
      },
    });
    const q = await runQuote(ctx, { lotId: "lots:a1" });
    expect(q.options).toHaveLength(0);
    expect(q.noPlansConfigured).toBe(true);
  });

  it("hides a plan that does not cover this lot type", async () => {
    const { ctx } = makeCtx({
      tables: {
        lots: [LOT],
        paymentPlans: [plan({ name: "Niches only", appliesToLotTypes: ["niche"] })],
      },
    });
    const q = await runQuote(ctx, { lotId: "lots:a1" });
    expect(q.options).toHaveLength(0);
  });

  it("says when the cemetery has configured nothing", async () => {
    const { ctx } = makeCtx({ tables: { lots: [LOT] } });
    const q = await runQuote(ctx, { lotId: "lots:a1" });
    expect(q.noPlansConfigured).toBe(true);
  });
});

describe("choosing the promotion", () => {
  it("applies a live uncoded promotion without being asked", async () => {
    // A family is never quoted a worse price because the operator did
    // not know an offer was running.
    const { ctx } = makeCtx({
      tables: {
        lots: [LOT],
        paymentPlans: [plan({ name: "Cash" })],
        promos: [promo({ name: "All Souls", discountPercent: 5 })],
      },
    });
    const q = await runQuote(ctx, { lotId: "lots:a1" });
    expect(q.options[0].promoName).toBe("All Souls");
    expect(q.options[0].netPriceCents).toBe(95_000_00);
  });

  it("picks the better of two, computed rather than assumed", async () => {
    // A flat ₱8,000 beats 5% on this lot. On a cheaper one it would
    // not, which is exactly why nobody should work it out at a counter.
    const { ctx } = makeCtx({
      tables: {
        lots: [LOT],
        paymentPlans: [plan({ name: "Cash" })],
        promos: [
          promo({ name: "Five percent", discountPercent: 5 }),
          promo({ name: "Eight thousand", discountCents: 8_000_00 }),
        ],
      },
    });
    const q = await runQuote(ctx, { lotId: "lots:a1" });
    expect(q.options[0].promoName).toBe("Eight thousand");
    expect(q.options[0].netPriceCents).toBe(92_000_00);
  });

  it("NEVER applies a coded promotion by accident", async () => {
    // The whole point of a code. An offer meant for one family must
    // not attach itself to every quote.
    const { ctx } = makeCtx({
      tables: {
        lots: [LOT],
        paymentPlans: [plan({ name: "Cash" })],
        promos: [promo({ name: "Secret", code: "VIP", discountPercent: 30 })],
      },
    });
    const q = await runQuote(ctx, { lotId: "lots:a1" });
    expect(q.options[0].promoName).toBeUndefined();
    expect(q.options[0].netPriceCents).toBe(100_000_00);
  });

  it("applies a coded promotion when the family produces the code", async () => {
    const { ctx } = makeCtx({
      tables: {
        lots: [LOT],
        paymentPlans: [plan({ name: "Cash" })],
        promos: [promo({ name: "Secret", code: "VIP", discountPercent: 30 })],
      },
    });
    const q = await runQuote(ctx, { lotId: "lots:a1", promoCode: "vip" });
    expect(q.options[0].promoName).toBe("Secret");
  });

  it("says WHY an expired offer did not apply", async () => {
    // "The All Souls offer ended on 25 October" is something the office
    // can say to a family. An unexplained absence is not.
    const { ctx } = makeCtx({
      tables: {
        lots: [LOT],
        paymentPlans: [plan({ name: "Cash" })],
        promos: [
          promo({
            name: "All Souls",
            discountPercent: 5,
            startsAt: T0 - 30 * DAY_MS,
            endsAt: T0 - DAY_MS,
          }),
        ],
      },
    });
    const q = await runQuote(ctx, { lotId: "lots:a1" });
    expect(q.options[0].promoName).toBeUndefined();
    expect(q.promosNotApplied).toHaveLength(1);
    expect(q.promosNotApplied[0].reason).toContain("ended on");
  });

  it("does not report an offer as unapplied when another plan used it", async () => {
    // A cash-only promotion is not "not applied" — it applied to the
    // cash plan. Reporting it against the instalment plan would read
    // as a fault.
    const { ctx } = makeCtx({
      tables: {
        lots: [LOT],
        paymentPlans: [
          plan({ name: "Cash" }),
          plan({
            name: "12 months",
            kind: "installment",
            downPaymentPercent: 20,
            termMonths: 12,
            sortOrder: 2,
          }),
        ],
        promos: [
          promo({
            name: "Cash only",
            discountPercent: 5,
            appliesToPlanKinds: ["full_payment"],
          }),
        ],
      },
    });
    const q = await runQuote(ctx, { lotId: "lots:a1" });
    expect(q.options[0].promoName).toBe("Cash only");
    expect(q.promosNotApplied).toHaveLength(0);
  });

  it("skips an offer that is fully subscribed", async () => {
    const { ctx } = makeCtx({
      tables: {
        lots: [LOT],
        paymentPlans: [plan({ name: "Cash" })],
        promos: [
          promo({
            name: "First fifty",
            discountPercent: 20,
            maxRedemptions: 50,
            redemptionCount: 50,
          }),
        ],
      },
    });
    const q = await runQuote(ctx, { lotId: "lots:a1" });
    expect(q.options[0].promoName).toBeUndefined();
    expect(q.promosNotApplied[0].reason).toContain("fully subscribed");
  });

  it("honours the cemetery's discount ceiling", async () => {
    const { ctx } = makeCtx({
      tables: {
        lots: [LOT],
        paymentPlans: [plan({ name: "Cash", discountPercent: 40 })],
        promos: [promo({ name: "Big", discountPercent: 40 })],
        appSettings: [
          {
            _id: "appSettings:1",
            _creationTime: T0,
            key: "singleton",
            maxDiscountPercent: 25,
          },
        ],
      },
    });
    const q = await runQuote(ctx, { lotId: "lots:a1" });
    expect(q.options[0].totalDiscountCents).toBe(25_000_00);
    expect(q.options[0].cappedNote).toBeDefined();
  });

  it("falls back to the default ceiling when nothing is configured", async () => {
    // An unset row must never read as "no ceiling" — that is the
    // configuration a mistyped promotion is waiting for.
    const { ctx } = makeCtx({
      tables: {
        lots: [LOT],
        paymentPlans: [plan({ name: "Cash", discountPercent: 90 })],
      },
    });
    const q = await runQuote(ctx, { lotId: "lots:a1" });
    expect(q.options[0].totalDiscountCents).toBe(50_000_00);
  });
});
