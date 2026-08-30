/**
 * Agents, and money leaving the park.
 *
 * The arithmetic is tested in `lib/commission.test.ts`. This file
 * covers what only the database can show:
 *
 *   - office staff can attach an agent to a sale but cannot MINT one
 *     and set its rate — otherwise a staffer could route commission
 *     wherever they liked and it would look like ordinary desk work
 *   - the rate is frozen at the sale, so changing the park's default
 *     next year does not rewrite what an agent was promised
 *   - a payout is refused before the collection threshold is met, by
 *     the server and not merely by a hidden button
 */

import { ConvexError, type Value } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCode, type ErrorPayload } from "../../../convex/lib/errors";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { PLATFORM_AGENT_NAME } from "../../../convex/lib/commission";
import {
  createSalesAgent,
  listCommissions,
  listSalesAgents,
  markCommissionPaid,
  setCommissionPolicy,
  setSalesAgentRetired,
  updateSalesAgent,
} from "../../../convex/salesAgents";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-11-01T10:00:00+08:00").getTime();
const CALLER_ID = "users:admin1";
const SESSION_ID = "authSessions:s1";

type Row = Record<string, unknown>;
type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface Tables {
  salesAgents: Row[];
  contracts: Row[];
  customers: Row[];
  lots: Row[];
  installments: Row[];
  appSettings: Row[];
}

function makeCtx(opts: { tables?: Partial<Tables>; roles?: RoleName[] }) {
  const t: Tables = {
    salesAgents: [],
    contracts: [],
    customers: [],
    lots: [],
    installments: [],
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
    expirationTime: T0 + 30 * 24 * 3600 * 1000,
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

const runCreate = handlerOf(createSalesAgent);
const runList = handlerOf(listSalesAgents);
const runRetire = handlerOf(setSalesAgentRetired);
const runUpdate = handlerOf(updateSalesAgent);
const runPolicy = handlerOf(setCommissionPolicy);
const runLedger = handlerOf(listCommissions);
const runPay = handlerOf(markCommissionPaid);

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

function agent(over: Row = {}): Row {
  return {
    _id: "salesAgents:cruz",
    _creationTime: T0,
    fullName: "Marisol Cruz",
    fullNameLowercased: "marisol cruz",
    isRetired: false,
    createdAt: T0,
    createdByUserId: CALLER_ID,
    updatedAt: T0,
    ...over,
  };
}

function contract(over: Row = {}): Row {
  return {
    _id: "contracts:c1",
    _creationTime: T0,
    contractNumber: "CTR-2026-0042",
    customerId: "customers:reyes",
    lotId: "lots:a1",
    state: "active",
    totalPriceCents: 100_000_00,
    salesAgentId: "salesAgents:cruz",
    commissionPercent: 10,
    commissionCents: 10_000_00,
    ...over,
  };
}

const CUSTOMER = {
  _id: "customers:reyes",
  _creationTime: T0,
  fullName: "Ana Reyes",
};
const LOT = { _id: "lots:a1", _creationTime: T0, code: "A-2-01" };

function installment(paidCents: number, i = 1): Row {
  return {
    _id: `installments:i${i}`,
    _creationTime: T0,
    contractId: "contracts:c1",
    paidCents,
  };
}

function world(over: Partial<Tables> = {}) {
  return makeCtx({
    tables: {
      salesAgents: [agent()],
      contracts: [contract()],
      customers: [CUSTOMER],
      lots: [LOT],
      ...over,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

// --- the gate ---------------------------------------------------------

describe("who may create an agent", () => {
  const good = { fullName: "Marisol Cruz", commissionPercent: 10 };

  it("lets an admin", async () => {
    const { ctx, tables } = makeCtx({ roles: ["admin"] });
    await runCreate(ctx, good);
    expect(tables.salesAgents).toHaveLength(1);
  });

  it("REFUSES office staff", async () => {
    // A staffer who can mint an agent and set its rate can route
    // commission wherever they like, and it looks like desk work.
    const { ctx, tables } = makeCtx({ roles: ["office_staff"] });
    expect(await codeOf(() => runCreate(ctx, good))).toBe(ErrorCode.FORBIDDEN);
    expect(tables.salesAgents).toHaveLength(0);
  });

  it("still lets office staff READ the register", async () => {
    // They pick an agent when recording a sale.
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      tables: { salesAgents: [agent()] },
    });
    const list = await runList(ctx, {});
    expect(list.agents).toHaveLength(1);
  });

  it("refuses a field worker even a read", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    expect(await codeOf(() => runList(ctx, {}))).toBe(ErrorCode.FORBIDDEN);
  });

  it("REFUSES office staff the commission policy", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    expect(
      await codeOf(() => runPolicy(ctx, { defaultCommissionPercent: 40 })),
    ).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("rates that cannot be a policy", () => {
  it("refuses a rate above the cap", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    expect(
      await codeOf(() =>
        runCreate(ctx, { fullName: "Greedy", commissionPercent: 90 }),
      ),
    ).toBe(ErrorCode.VALIDATION);
  });

  it("refuses a negative rate", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    expect(
      await codeOf(() =>
        runCreate(ctx, { fullName: "Backwards", commissionPercent: -5 }),
      ),
    ).toBe(ErrorCode.VALIDATION);
  });

  it("refuses a threshold outside 0-100", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    expect(
      await codeOf(() => runPolicy(ctx, { earnedAtPercent: 150 })),
    ).toBe(ErrorCode.VALIDATION);
  });

  it("refuses a code already in use", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      tables: { salesAgents: [agent({ code: "MC01" })] },
    });
    expect(
      await codeOf(() => runCreate(ctx, { fullName: "Other", code: "mc01" })),
    ).toBe(ErrorCode.VALIDATION);
  });
});

describe("retiring", () => {
  it("keeps the record rather than deleting it", async () => {
    // Contracts point at agents. A contract has to go on saying who
    // sold it long after the agent left.
    const { ctx, tables } = makeCtx({
      roles: ["admin"],
      tables: { salesAgents: [agent()] },
    });
    await runRetire(ctx, { agentId: "salesAgents:cruz", isRetired: true });
    expect(tables.salesAgents).toHaveLength(1);
    expect(tables.salesAgents[0]?.["isRetired"]).toBe(true);
  });

  it("drops a retired agent from the pick list", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      tables: { salesAgents: [agent({ isRetired: true })] },
    });
    expect((await runList(ctx, {})).agents).toHaveLength(0);
    expect((await runList(ctx, { includeRetired: true })).agents).toHaveLength(
      1,
    );
  });
});

// --- the ledger --------------------------------------------------------

describe("what the park owes", () => {
  it("is NOT due on a barely-started instalment contract", async () => {
    // The case the threshold exists for. A deposit is not a sale that
    // has held; paying here means paying on money that may never come.
    const { ctx } = world({ installments: [installment(5_000_00)] });
    const ledger = await runLedger(ctx, {});
    expect(ledger.rows[0].state).toBe("not_due");
    expect(ledger.totalDueCents).toBe(0);
    expect(ledger.totalNotDueCents).toBe(10_000_00);
  });

  it("becomes due once the family passes the mark", async () => {
    const { ctx } = world({ installments: [installment(25_000_00)] });
    const ledger = await runLedger(ctx, {});
    expect(ledger.rows[0].state).toBe("due");
    expect(ledger.totalDueCents).toBe(10_000_00);
  });

  it("counts a full-payment sale as collected in full", async () => {
    // It has no instalment rows; it is paid by construction.
    const { ctx } = world({
      contracts: [contract({ state: "paid_in_full" })],
    });
    expect((await runLedger(ctx, {})).rows[0].state).toBe("due");
  });

  it("owes nothing on a voided sale, whatever was collected", async () => {
    const { ctx } = world({
      contracts: [contract({ state: "voided" })],
      installments: [installment(100_000_00)],
    });
    const ledger = await runLedger(ctx, {});
    expect(ledger.rows[0].state).toBe("void");
    expect(ledger.totalDueCents).toBe(0);
  });

  it("skips a sale with no agent entirely", async () => {
    // Most sales at a small park are walk-ins. A zero commission
    // attached to nobody is noise in every report that reads it.
    const { ctx } = world({
      contracts: [contract({ salesAgentId: undefined })],
    });
    expect((await runLedger(ctx, {})).rows).toHaveLength(0);
  });

  it("puts what is payable first", async () => {
    const { ctx } = world({
      contracts: [
        contract({ _id: "contracts:waiting", contractNumber: "CTR-0001" }),
        contract({
          _id: "contracts:ready",
          contractNumber: "CTR-0002",
          state: "paid_in_full",
        }),
      ],
    });
    const ledger = await runLedger(ctx, {});
    expect(ledger.rows[0].contractNumber).toBe("CTR-0002");
    expect(ledger.rows[0].state).toBe("due");
  });

  it("filters to one agent when asked", async () => {
    const { ctx } = world({
      salesAgents: [agent(), agent({ _id: "salesAgents:other", fullName: "B" })],
      contracts: [
        contract(),
        contract({ _id: "contracts:c2", salesAgentId: "salesAgents:other" }),
      ],
    });
    const ledger = await runLedger(ctx, { agentId: "salesAgents:other" });
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].agentName).toBe("B");
  });

  it("names the shortfall in pesos so the office can chase it", async () => {
    const { ctx } = world({ installments: [installment(8_000_00)] });
    const row = (await runLedger(ctx, {})).rows[0];
    expect(row.shortfallCents).toBe(12_000_00);
    expect(row.message).toContain("₱12,000");
  });

  it("is admin-only — it is a payroll view", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    expect(await codeOf(() => runLedger(ctx, {}))).toBe(ErrorCode.FORBIDDEN);
  });
});

// --- paying out --------------------------------------------------------

describe("paying a commission", () => {
  it("REFUSES one that is not due yet", async () => {
    // The whole point of the threshold. The office cannot get ahead of
    // the collections rule by clicking a button, and a payout recorded
    // early is indistinguishable afterwards from one properly earned.
    const { ctx, tables } = world({ installments: [installment(5_000_00)] });
    const code = await codeOf(() => runPay(ctx, { contractId: "contracts:c1" }));
    expect(code).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(tables.contracts[0]?.["commissionPaidOutAt"]).toBeUndefined();
  });

  it("pays one that is due", async () => {
    const { ctx, tables } = world({ installments: [installment(25_000_00)] });
    const result = await runPay(ctx, { contractId: "contracts:c1" });
    expect(result.commissionCents).toBe(10_000_00);
    expect(tables.contracts[0]?.["commissionPaidOutAt"]).toBe(T0);
  });

  it("refuses to pay the same one twice", async () => {
    const { ctx } = world({ installments: [installment(25_000_00)] });
    await runPay(ctx, { contractId: "contracts:c1" });
    expect(
      await codeOf(() => runPay(ctx, { contractId: "contracts:c1" })),
    ).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("refuses a sale with no agent", async () => {
    const { ctx } = world({
      contracts: [contract({ salesAgentId: undefined, state: "paid_in_full" })],
    });
    expect(
      await codeOf(() => runPay(ctx, { contractId: "contracts:c1" })),
    ).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("refuses a voided sale even when fully collected", async () => {
    const { ctx } = world({
      contracts: [contract({ state: "voided" })],
      installments: [installment(100_000_00)],
    });
    expect(
      await codeOf(() => runPay(ctx, { contractId: "contracts:c1" })),
    ).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("shows as settled afterwards rather than due again", async () => {
    const { ctx } = world({ installments: [installment(25_000_00)] });
    await runPay(ctx, { contractId: "contracts:c1" });
    const ledger = await runLedger(ctx, {});
    expect(ledger.rows[0].state).toBe("paid");
    expect(ledger.totalDueCents).toBe(0);
  });

  it("is admin-only", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      tables: { contracts: [contract()] },
    });
    expect(
      await codeOf(() => runPay(ctx, { contractId: "contracts:c1" })),
    ).toBe(ErrorCode.FORBIDDEN);
  });
});

// --- the frozen rate ---------------------------------------------------

describe("the rate is frozen at the sale", () => {
  it("uses what the contract recorded, not the agent's rate today", async () => {
    // An agent's income must not move because the park adjusted its
    // rates this year. The contract says 10%; the agent now says 25%.
    const { ctx } = world({
      salesAgents: [agent({ commissionPercent: 25 })],
      contracts: [
        contract({ commissionPercent: 10, commissionCents: 10_000_00 }),
      ],
      installments: [installment(25_000_00)],
    });
    const row = (await runLedger(ctx, {})).rows[0];
    expect(row.commissionPercent).toBe(10);
    expect(row.commissionCents).toBe(10_000_00);
  });

  it("uses what the contract recorded, not the park default today", async () => {
    const { ctx } = world({
      contracts: [
        contract({ commissionPercent: 10, commissionCents: 10_000_00 }),
      ],
      installments: [installment(25_000_00)],
      appSettings: [
        {
          _id: "appSettings:1",
          _creationTime: T0,
          key: "singleton",
          defaultCommissionPercent: 40,
        },
      ],
    });
    expect((await runLedger(ctx, {})).rows[0].commissionCents).toBe(10_000_00);
  });
});

describe("the policy", () => {
  it("defaults to no rate at all", async () => {
    // Not a hidden 10%. A park that has configured nothing owes nothing
    // until somebody decides what the rate is.
    const { ctx } = makeCtx({ roles: ["admin"] });
    expect((await runList(ctx, {})).defaultCommissionPercent).toBe(0);
  });

  it("DOES default the threshold to twenty per cent", async () => {
    // The opposite reasoning: the alternative default is "pay at
    // signing", which is the failure the threshold exists to prevent.
    const { ctx } = makeCtx({ roles: ["admin"] });
    expect((await runList(ctx, {})).earnedAtPercent).toBe(20);
  });

  it("stores what an admin sets", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    await runPolicy(ctx, {
      defaultCommissionPercent: 8,
      earnedAtPercent: 30,
    });
    const list = await runList(ctx, {});
    expect(list.defaultCommissionPercent).toBe(8);
    expect(list.earnedAtPercent).toBe(30);
  });
});

// --- the platform as an agent ------------------------------------------

describe("the park's own agent row", () => {
  function platform(over: Row = {}): Row {
    return agent({
      _id: "salesAgents:platform",
      fullName: PLATFORM_AGENT_NAME,
      fullNameLowercased: PLATFORM_AGENT_NAME.toLowerCase(),
      commissionPercent: 0,
      isSystem: true,
      ...over,
    });
  }

  it("is named for what it is", () => {
    // It appears in "sales by agent" beside real people, so it has to
    // read as a category and not as a person.
    expect(PLATFORM_AGENT_NAME).toBe("Online transaction");
  });

  it("CANNOT be retired", async () => {
    // Retiring it would leave every online sale unattributed, which is
    // the gap this whole change exists to close.
    const { ctx, tables } = makeCtx({
      roles: ["admin"],
      tables: { salesAgents: [platform()] },
    });
    const code = await codeOf(() =>
      runRetire(ctx, { agentId: "salesAgents:platform", isRetired: true }),
    );
    expect(code).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(tables.salesAgents[0]?.["isRetired"]).toBe(false);
  });

  it("CANNOT be given a rate", async () => {
    // Refused rather than clamped. A house agent quietly carrying 40%
    // would have the park reporting money it owes to nobody.
    const { ctx, tables } = makeCtx({
      roles: ["admin"],
      tables: { salesAgents: [platform()] },
    });
    const code = await codeOf(() =>
      runUpdate(ctx, {
        agentId: "salesAgents:platform",
        commissionPercent: 40,
      }),
    );
    expect(code).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(tables.salesAgents[0]?.["commissionPercent"]).toBe(0);
  });

  it("cannot be renamed either", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      tables: { salesAgents: [platform()] },
    });
    expect(
      await codeOf(() =>
        runUpdate(ctx, { agentId: "salesAgents:platform", fullName: "Bob" }),
      ),
    ).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("says why, in terms somebody can act on", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      tables: { salesAgents: [platform()] },
    });
    let thrown: unknown;
    try {
      await runRetire(ctx, {
        agentId: "salesAgents:platform",
        isRetired: true,
      });
    } catch (e) {
      thrown = e;
    }
    expect(String(thrown)).toContain("the park itself");
  });

  it("appears in the pick list as an ordinary option", async () => {
    // The desk should be able to mark a sale as having come through the
    // platform, not only fall into it by leaving the field blank.
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      tables: { salesAgents: [platform(), agent()] },
    });
    const list = await runList(ctx, {});
    const found = list.agents.find(
      (a: { fullName: string }) => a.fullName === PLATFORM_AGENT_NAME,
    );
    expect(found).toBeDefined();
    expect(found.isSystem).toBe(true);
  });

  it("marks a real agent as not a system row", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      tables: { salesAgents: [agent()] },
    });
    expect((await runList(ctx, {})).agents[0].isSystem).toBe(false);
  });

  it("stays out of the payables ledger", async () => {
    // Every sale is attributed now, most of them to the platform. A
    // commission of nothing is not a commission, and letting those
    // through would bury the real payables in the park's own sales.
    const { ctx } = world({
      salesAgents: [platform()],
      contracts: [
        contract({
          salesAgentId: "salesAgents:platform",
          commissionPercent: 0,
          commissionCents: 0,
          state: "paid_in_full",
        }),
      ],
    });
    const ledger = await runLedger(ctx, {});
    expect(ledger.rows).toHaveLength(0);
    expect(ledger.totalDueCents).toBe(0);
  });

  it("still leaves a real agent's commission in the ledger", async () => {
    // Guards the exclusion above from swallowing everything.
    const { ctx } = world({
      salesAgents: [platform(), agent()],
      contracts: [
        contract({
          _id: "contracts:online",
          salesAgentId: "salesAgents:platform",
          commissionCents: 0,
          state: "paid_in_full",
        }),
        contract({ _id: "contracts:c1", state: "paid_in_full" }),
      ],
    });
    const ledger = await runLedger(ctx, {});
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].agentName).toBe("Marisol Cruz");
  });
});
