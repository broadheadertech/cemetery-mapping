/**
 * Telling a family they have finished paying.
 *
 * The one message the estate sends that asks for nothing. It rides the
 * reminder pipeline because opt-out, bounce handling and retries are
 * the same problem whatever the message says — a second delivery
 * system would have been a second place for all three to be got wrong.
 *
 * Two properties matter more than the wording.
 *
 * ONCE. A family hearing "you have finished paying" twice reads as a
 * system that does not know what it has already said.
 *
 * NEVER LOUDLY. No email on file, an opt-out, a bounced address — none
 * of them is an error worth failing a payment over. The office work
 * list does not depend on anybody's inbox.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { internal_enqueuePaidInFull } from "../../../convex/reminders";
import {
  isEmailTemplateKey,
  renderEmail,
} from "../../../convex/lib/reminderTemplates";

const T0 = new Date("2026-11-01T10:00:00+08:00").getTime();

type Row = Record<string, unknown>;

interface Tables {
  contracts: Row[];
  customers: Row[];
  lots: Row[];
  reminderDeliveries: Row[];
}

function makeCtx(over: Partial<Tables> = {}) {
  const t: Tables = {
    contracts: [],
    customers: [],
    lots: [],
    reminderDeliveries: [],
    ...over,
  };
  const scheduled: Array<{ delayMs: number; args: unknown }> = [];
  let counter = 0;

  function builderFor(rows: Row[]) {
    const preds: Array<(r: Row) => boolean> = [];
    const q = {
      eq(f: string, v: unknown) {
        preds.push((r) => r[f] === v);
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
    };
    return b;
  }

  const ctx = {
    db: {
      get: vi.fn(async (id: string) => {
        for (const rows of Object.values(t) as Row[][]) {
          const hit = rows.find((r) => r["_id"] === id);
          if (hit !== undefined) return hit;
        }
        return null;
      }),
      insert: vi.fn(async (table: string, row: Row) => {
        counter += 1;
        const id = `${table}:new${counter}`;
        const stored = { _id: id, _creationTime: T0, ...row };
        const rows = (t as unknown as Record<string, Row[] | undefined>)[table];
        if (rows !== undefined) rows.push(stored);
        return id;
      }),
      patch: vi.fn(async () => undefined),
      query: vi.fn((table: string) =>
        builderFor((t as unknown as Record<string, Row[]>)[table] ?? []),
      ),
    },
    scheduler: {
      runAfter: vi.fn(async (delayMs: number, _fn: unknown, args: unknown) => {
        scheduled.push({ delayMs, args });
        return "scheduled:1";
      }),
    },
  };

  return { ctx, tables: t, scheduled };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerOf(fn: any): (ctx: unknown, args: unknown) => Promise<any> {
  for (const key of ["_handler", "handler"]) {
    const v = fn[key];
    if (typeof v === "function") return v as never;
  }
  if (typeof fn === "function") return fn as never;
  throw new Error("Cannot locate handler");
}

const run = handlerOf(internal_enqueuePaidInFull);

function contract(over: Row = {}): Row {
  return {
    _id: "contracts:c1",
    _creationTime: T0,
    contractNumber: "CTR-2026-0042",
    customerId: "customers:reyes",
    lotId: "lots:a1",
    state: "paid_in_full",
    totalPriceCents: 120_000_00,
    ...over,
  };
}

function customer(over: Row = {}): Row {
  return {
    _id: "customers:reyes",
    _creationTime: T0,
    fullName: "Ana Reyes",
    email: "ana@example.com",
    ...over,
  };
}

function world(over: Partial<Tables> = {}) {
  return makeCtx({
    contracts: [contract()],
    customers: [customer()],
    lots: [{ _id: "lots:a1", _creationTime: T0, code: "A-2-01" }],
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

describe("queueing the notice", () => {
  it("queues one for a settled contract", async () => {
    const { ctx, tables } = world();
    const r = await run(ctx, { contractId: "contracts:c1" });
    expect(r.queued).toBe(true);
    expect(tables.reminderDeliveries).toHaveLength(1);
  });

  it("marks it as its own kind, not an instalment reminder", async () => {
    const { ctx, tables } = world();
    await run(ctx, { contractId: "contracts:c1" });
    const row = tables.reminderDeliveries[0];
    expect(row?.["kind"]).toBe("contract_paid_in_full");
    expect(row?.["templateKey"]).toBe("paid_in_full_email");
    expect(row?.["installmentId"]).toBeUndefined();
  });

  it("schedules the send immediately", async () => {
    const { ctx, scheduled } = world();
    await run(ctx, { contractId: "contracts:c1" });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(0);
  });
});

describe("saying it once", () => {
  it("REFUSES a second notice for the same contract", async () => {
    // Hearing it twice reads as a system that does not know what it has
    // already said.
    const { ctx, tables } = world();
    await run(ctx, { contractId: "contracts:c1" });
    const second = await run(ctx, { contractId: "contracts:c1" });
    expect(second.queued).toBe(false);
    expect(second.reason).toBe("already_sent");
    expect(tables.reminderDeliveries).toHaveLength(1);
  });

  it("does not schedule a second send either", async () => {
    const { ctx, scheduled } = world();
    await run(ctx, { contractId: "contracts:c1" });
    await run(ctx, { contractId: "contracts:c1" });
    expect(scheduled).toHaveLength(1);
  });

  it("is not confused by an instalment reminder on the same contract", async () => {
    // The dedupe is on kind as well as contract, or a family who ever
    // got a due-date reminder would never be told they had finished.
    const { ctx } = world({
      reminderDeliveries: [
        {
          _id: "reminderDeliveries:old",
          _creationTime: T0,
          contractId: "contracts:c1",
          kind: "installment_due",
          channel: "email",
          templateKey: "due_today_email",
          status: "sent",
        },
      ],
    });
    const r = await run(ctx, { contractId: "contracts:c1" });
    expect(r.queued).toBe(true);
  });
});

describe("staying silent rather than failing", () => {
  it("says nothing for a contract that is not settled", async () => {
    const { ctx, tables } = world({ contracts: [contract({ state: "active" })] });
    const r = await run(ctx, { contractId: "contracts:c1" });
    expect(r.queued).toBe(false);
    expect(r.reason).toBe("not_settled");
    expect(tables.reminderDeliveries).toHaveLength(0);
  });

  it("says nothing when there is no email on file", async () => {
    const { ctx } = world({ customers: [customer({ email: undefined })] });
    const r = await run(ctx, { contractId: "contracts:c1" });
    expect(r.queued).toBe(false);
    expect(r.reason).toBe("no_email");
  });

  it("RESPECTS an opt-out", async () => {
    const { ctx, tables } = world({
      customers: [customer({ reminderOptOut: true })],
    });
    const r = await run(ctx, { contractId: "contracts:c1" });
    expect(r.queued).toBe(false);
    expect(r.reason).toBe("opted_out");
    expect(tables.reminderDeliveries).toHaveLength(0);
  });

  it("respects a hard-bounced address", async () => {
    // Sending to a known-bad address is how a park's whole domain ends
    // up in spam folders.
    const { ctx } = world({
      customers: [customer({ emailBouncedAt: T0 - 1000 })],
    });
    const r = await run(ctx, { contractId: "contracts:c1" });
    expect(r.queued).toBe(false);
    expect(r.reason).toBe("bounced");
  });

  it("never throws — a payment must not fail over an email", async () => {
    const { ctx } = makeCtx({});
    await expect(
      run(ctx, { contractId: "contracts:missing" }),
    ).resolves.toEqual({ queued: false, reason: "no_contract" });
  });
});

describe("what the message says", () => {
  const ctx = {
    customerName: "Ana Reyes",
    amountCents: 120_000_00,
    lotCode: "A-2-01",
    dueDateMs: T0,
    portalUrl: "https://portal.example.ph",
  };

  it("is a recognised template key", () => {
    expect(isEmailTemplateKey("paid_in_full_email")).toBe(true);
  });

  it("NEVER uses the word due", () => {
    // Every other template in this registry is chasing money. This one
    // is not, and a stray "due" would land as a demand on somebody who
    // has just finished paying.
    const r = renderEmail("paid_in_full_email", ctx);
    expect(r.bodyPlain.toLowerCase()).not.toContain("due");
    expect(r.bodyHtml.toLowerCase()).not.toContain("due");
    expect(r.subject.toLowerCase()).not.toContain("due");
  });

  it("says the ground is theirs and nothing is owed", () => {
    const r = renderEmail("paid_in_full_email", ctx);
    expect(r.bodyPlain).toContain("nothing further is owed");
  });

  it("tells them the certificate is coming", () => {
    // The actual new information for somebody who just paid at a
    // counter and already has a receipt.
    const r = renderEmail("paid_in_full_email", ctx);
    expect(r.bodyPlain).toContain("certificate of ownership");
  });

  it("names the lot and the amount", () => {
    const r = renderEmail("paid_in_full_email", ctx);
    expect(r.bodyPlain).toContain("A-2-01");
    expect(r.bodyPlain).toContain("120,000");
  });

  it("carries a subject that says what happened", () => {
    const r = renderEmail("paid_in_full_email", ctx);
    expect(r.subject).toContain("fully paid");
  });

  it("renders both plain text and HTML", () => {
    const r = renderEmail("paid_in_full_email", ctx);
    expect(r.bodyPlain.length).toBeGreaterThan(100);
    expect(r.bodyHtml).toContain("<");
  });
});
