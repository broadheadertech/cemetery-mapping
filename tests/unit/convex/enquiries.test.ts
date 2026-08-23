/**
 * `convex/enquiries.ts` unit tests.
 *
 * `submitEnquiry` is the only public unauthenticated write in the app
 * besides the auth rate-limiter, so the cases that matter most are the
 * ones bounding it: that both rate limits actually bite, that a public
 * writer cannot choose how much storage it consumes, and that the
 * staff-facing half stays gated.
 *
 * The other thing pinned here is the behaviour this whole feature
 * exists to fix — a submission either lands or reports failure, and
 * there is no path where a visitor is thanked for a message nobody
 * received.
 */

import { ConvexError, type Value } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ErrorPayload } from "../../../convex/lib/errors";
import { MINUTE_MS } from "../../../convex/lib/time";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import {
  contactKeyOf,
  GLOBAL_LIMIT,
  getEnquiryCounts,
  listEnquiries,
  PER_CONTACT_LIMIT,
  submitEnquiry,
  updateEnquiryStatus,
} from "../../../convex/enquiries";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-08-23T09:00:00+08:00").getTime();
const USER_ID = "users:staff1";
const SESSION_ID = "authSessions:sess1";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface EnquiryRow {
  _id: string;
  _creationTime: number;
  kind: "visit" | "pricing";
  name: string;
  contact: string;
  contactKey: string;
  status: "new" | "contacted" | "closed";
  createdAt: number;
  [key: string]: unknown;
}

interface CtxBag {
  rows: Map<string, EnquiryRow>;
  all: () => EnquiryRow[];
  audits: () => Record<string, unknown>[];
  scheduled: () => Array<{ ms: number; args: unknown }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(
  opts: {
    roles?: RoleName[];
    initial?: EnquiryRow[];
    authenticated?: boolean;
  } = {},
): CtxBag {
  const rows = new Map<string, EnquiryRow>(
    (opts.initial ?? []).map((r) => [r._id, r]),
  );
  const audits: Record<string, unknown>[] = [];
  const scheduled: Array<{ ms: number; args: unknown }> = [];

  if (opts.authenticated === false) {
    mockedGetAuthUserId.mockResolvedValue(null);
    mockedGetAuthSessionId.mockResolvedValue(null);
  } else {
    mockedGetAuthUserId.mockResolvedValue(USER_ID as never);
    mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);
  }

  const user = { _id: USER_ID, _creationTime: T0 - 1000, email: "s@x.test" };
  const session = {
    _id: SESSION_ID,
    _creationTime: T0,
    userId: USER_ID,
    expirationTime: T0 + 8 * 60 * MINUTE_MS,
  };
  const userRoles = (opts.roles ?? ["office_staff"]).map((role, idx) => ({
    _id: `userRoles:${idx}`,
    _creationTime: T0,
    userId: USER_ID,
    role,
    grantedAt: T0,
    grantedBy: USER_ID,
  }));

  interface RangeQuery {
    eqs: Record<string, unknown>;
    gtes: Record<string, number>;
    eq(field: string, value: unknown): RangeQuery;
    gte(field: string, value: number): RangeQuery;
  }

  function makeQueryBuilder() {
    const predicates: Array<(r: EnquiryRow) => boolean> = [];
    let descending = false;
    const builder = {
      withIndex(_name: string, fn?: (q: RangeQuery) => RangeQuery) {
        if (fn !== undefined) {
          const q: RangeQuery = {
            eqs: {},
            gtes: {},
            eq(field, value) {
              this.eqs[field] = value;
              return this;
            },
            gte(field, value) {
              this.gtes[field] = value;
              return this;
            },
          };
          fn(q);
          for (const [field, value] of Object.entries(q.eqs)) {
            predicates.push((r) => r[field] === value);
          }
          for (const [field, value] of Object.entries(q.gtes)) {
            predicates.push((r) => Number(r[field]) >= value);
          }
        }
        return builder;
      },
      order(dir: "asc" | "desc") {
        descending = dir === "desc";
        return builder;
      },
      matching(): EnquiryRow[] {
        const out = Array.from(rows.values()).filter((r) =>
          predicates.every((p) => p(r)),
        );
        out.sort((a, b) =>
          descending ? b.createdAt - a.createdAt : a.createdAt - b.createdAt,
        );
        return out;
      },
      async collect(): Promise<EnquiryRow[]> {
        return builder.matching();
      },
      async take(n: number): Promise<EnquiryRow[]> {
        return builder.matching().slice(0, n);
      },
      async first(): Promise<EnquiryRow | null> {
        return builder.matching()[0] ?? null;
      },
    };
    return builder;
  }

  let seq = 0;
  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    scheduler: {
      runAfter: vi.fn(async (ms: number, _ref: unknown, args: unknown) => {
        scheduled.push({ ms, args });
      }),
    },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === USER_ID) return user;
        if (id === SESSION_ID) return session;
        return rows.get(id) ?? null;
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return {
            withIndex: (_n: string, _f: unknown) => ({
              collect: async () => userRoles,
            }),
          };
        }
        return makeQueryBuilder();
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        seq += 1;
        const id = `${table}:${seq}`;
        if (table === "auditLog") {
          audits.push(row);
          return id;
        }
        rows.set(id, { _id: id, _creationTime: T0, ...row } as EnquiryRow);
        return id;
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        const existing = rows.get(id);
        if (existing !== undefined) {
          rows.set(id, { ...existing, ...patch } as EnquiryRow);
        }
      }),
    },
  };

  return {
    rows,
    all: () => Array.from(rows.values()),
    audits: () => audits,
    scheduled: () => scheduled,
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

function getCode(thrown: unknown): string | undefined {
  if (!(thrown instanceof ConvexError)) return undefined;
  const data = (thrown as ConvexError<Value>).data as unknown as ErrorPayload;
  return data?.code;
}

const runSubmit = handlerOf(submitEnquiry);
const runList = handlerOf(listEnquiries);
const runCounts = handlerOf(getEnquiryCounts);
const runUpdate = handlerOf(updateEnquiryStatus);

function visitArgs(overrides: Record<string, unknown> = {}) {
  return {
    kind: "visit" as const,
    name: "Maria Reyes",
    contact: "+63 917 555 0000",
    preferredDate: "2026-09-01",
    preferredTime: "Morning · 9am",
    purpose: "Pre-need planning — no rush",
    notes: "Coming with my sister.",
    ...overrides,
  };
}

function existingRow(overrides: Partial<EnquiryRow> = {}): EnquiryRow {
  return {
    _id: `enquiries:${overrides.contactKey ?? "x"}${overrides.createdAt ?? T0}`,
    _creationTime: T0,
    kind: "visit",
    name: "Someone",
    contact: "+63 917 555 0000",
    contactKey: "639175550000",
    status: "new",
    createdAt: T0,
    ...overrides,
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

describe("contactKeyOf", () => {
  it("collapses the ways one phone number gets typed", () => {
    const a = contactKeyOf("+63 917 555 0000");
    expect(contactKeyOf("09175550000")).not.toBe(a); // different number
    expect(contactKeyOf("+63(917)555-0000")).toBe(a);
    expect(contactKeyOf("  +63 917 555 0000  ".trim())).toBe(a);
  });

  it("is case-insensitive for emails", () => {
    expect(contactKeyOf("Juan@Example.PH")).toBe(contactKeyOf("juan@example.ph"));
  });
});

describe("submitEnquiry — the happy path", () => {
  it("stores the enquiry without requiring a signed-in user", async () => {
    const bag = makeCtx({ authenticated: false });
    const result = (await runSubmit(bag.ctx, visitArgs())) as {
      enquiryId: string;
    };
    expect(result.enquiryId).toBeTruthy();
    const row = bag.all()[0]!;
    expect(row.name).toBe("Maria Reyes");
    expect(row.contact).toBe("+63 917 555 0000");
    expect(row.status).toBe("new");
    expect(row.kind).toBe("visit");
  });

  it("schedules the staff notification", async () => {
    const bag = makeCtx({ authenticated: false });
    await runSubmit(bag.ctx, visitArgs());
    expect(bag.scheduled()).toHaveLength(1);
    expect(bag.scheduled()[0]!.ms).toBe(0);
  });

  it("keeps the pricing form's distinct fields", async () => {
    const bag = makeCtx({ authenticated: false });
    await runSubmit(bag.ctx, {
      kind: "pricing",
      name: "Ana Cruz",
      contact: "ana@example.ph",
      lotTypeInterest: "family",
      timing: "This month",
    });
    const row = bag.all()[0]!;
    expect(row.lotTypeInterest).toBe("family");
    expect(row.timing).toBe("This month");
  });

  it("omits blank optional fields rather than storing empty strings", async () => {
    const bag = makeCtx({ authenticated: false });
    await runSubmit(bag.ctx, {
      kind: "visit",
      name: "Ana",
      contact: "ana@example.ph",
      notes: "   ",
      purpose: "",
    });
    const row = bag.all()[0]!;
    expect(row.notes).toBeUndefined();
    expect(row.purpose).toBeUndefined();
  });

  it("emits no audit row — an enquiry arriving is not an operator action", async () => {
    const bag = makeCtx({ authenticated: false });
    await runSubmit(bag.ctx, visitArgs());
    expect(bag.audits()).toHaveLength(0);
  });
});

describe("submitEnquiry — rejects what it cannot act on", () => {
  it("requires a name", async () => {
    const bag = makeCtx({ authenticated: false });
    let thrown: unknown;
    try {
      await runSubmit(bag.ctx, visitArgs({ name: "   " }));
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe("VALIDATION");
    expect(bag.all()).toHaveLength(0);
  });

  it("requires a way to reach the person", async () => {
    // The entire point of the form. A submission with no contact is a
    // message we can never answer, so it must fail loudly rather than
    // be stored and silently ignored.
    const bag = makeCtx({ authenticated: false });
    let thrown: unknown;
    try {
      await runSubmit(bag.ctx, visitArgs({ contact: "" }));
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe("VALIDATION");
    expect(bag.all()).toHaveLength(0);
  });

  it("never schedules a notification for a rejected submission", async () => {
    const bag = makeCtx({ authenticated: false });
    try {
      await runSubmit(bag.ctx, visitArgs({ name: "" }));
    } catch {
      /* expected */
    }
    expect(bag.scheduled()).toHaveLength(0);
  });
});

describe("submitEnquiry — bounds on a public writer", () => {
  it("caps how much storage one submission can consume", async () => {
    const bag = makeCtx({ authenticated: false });
    await runSubmit(
      bag.ctx,
      visitArgs({
        name: "N".repeat(5_000),
        contact: "C".repeat(5_000),
        notes: "x".repeat(50_000),
      }),
    );
    const row = bag.all()[0]!;
    expect(row.name.length).toBeLessThanOrEqual(120);
    expect(row.contact.length).toBeLessThanOrEqual(160);
    expect(String(row.notes).length).toBeLessThanOrEqual(2_000);
  });

  it("rate-limits repeat submissions from the same contact", async () => {
    const bag = makeCtx({ authenticated: false });
    for (let i = 0; i < PER_CONTACT_LIMIT; i += 1) {
      await runSubmit(bag.ctx, visitArgs());
    }
    let thrown: unknown;
    try {
      await runSubmit(bag.ctx, visitArgs());
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe("RATE_LIMITED");
    expect(bag.all()).toHaveLength(PER_CONTACT_LIMIT);
  });

  it("treats differently-formatted versions of one number as the same contact", async () => {
    const bag = makeCtx({ authenticated: false });
    await runSubmit(bag.ctx, visitArgs({ contact: "+63 917 555 0000" }));
    await runSubmit(bag.ctx, visitArgs({ contact: "+63(917)555-0000" }));
    await runSubmit(bag.ctx, visitArgs({ contact: "+639175550000" }));
    let thrown: unknown;
    try {
      await runSubmit(bag.ctx, visitArgs({ contact: "+63 917-555-0000" }));
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe("RATE_LIMITED");
  });

  it("lets the same contact through again once the window passes", async () => {
    const bag = makeCtx({ authenticated: false });
    for (let i = 0; i < PER_CONTACT_LIMIT; i += 1) {
      await runSubmit(bag.ctx, visitArgs());
    }
    vi.setSystemTime(T0 + 61 * MINUTE_MS);
    await runSubmit(bag.ctx, visitArgs());
    expect(bag.all()).toHaveLength(PER_CONTACT_LIMIT + 1);
  });

  it("applies a global ceiling so one script cannot fill the table", async () => {
    // Seeded from many distinct contacts, so the per-contact limit is
    // not what stops this — the global window is.
    const initial = Array.from({ length: GLOBAL_LIMIT }, (_, i) =>
      existingRow({
        _id: `enquiries:seed${i}`,
        contactKey: `key${i}`,
        createdAt: T0 - 1_000,
      }),
    );
    const bag = makeCtx({ authenticated: false, initial });
    let thrown: unknown;
    try {
      await runSubmit(bag.ctx, visitArgs({ contact: "brand-new@example.ph" }));
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe("RATE_LIMITED");
  });

  it("does not count enquiries older than the global window", async () => {
    const initial = Array.from({ length: GLOBAL_LIMIT }, (_, i) =>
      existingRow({
        _id: `enquiries:old${i}`,
        contactKey: `old${i}`,
        createdAt: T0 - 120 * MINUTE_MS,
      }),
    );
    const bag = makeCtx({ authenticated: false, initial });
    await runSubmit(bag.ctx, visitArgs({ contact: "brand-new@example.ph" }));
    expect(bag.all()).toHaveLength(GLOBAL_LIMIT + 1);
  });
});

describe("listEnquiries", () => {
  it("is closed to field workers", async () => {
    const bag = makeCtx({ roles: ["field_worker"] });
    let thrown: unknown;
    try {
      await runList(bag.ctx, {});
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe("FORBIDDEN");
  });

  it("is open to office staff", async () => {
    const bag = makeCtx({ roles: ["office_staff"], initial: [existingRow()] });
    const result = (await runList(bag.ctx, { status: "new" })) as unknown[];
    expect(result).toHaveLength(1);
  });

  it("filters by status", async () => {
    const bag = makeCtx({
      initial: [
        existingRow({ _id: "enquiries:a", status: "new" }),
        existingRow({ _id: "enquiries:b", status: "closed" }),
      ],
    });
    const open = (await runList(bag.ctx, { status: "new" })) as unknown[];
    expect(open).toHaveLength(1);
  });

  it("flags a row whose staff notification never went out", async () => {
    const bag = makeCtx({
      initial: [existingRow({ notifyFailedAt: T0 })],
    });
    const result = (await runList(bag.ctx, { status: "new" })) as Array<{
      notifyFailed: boolean;
    }>;
    expect(result[0]!.notifyFailed).toBe(true);
  });
});

describe("getEnquiryCounts", () => {
  it("counts new and contacted separately", async () => {
    const bag = makeCtx({
      initial: [
        existingRow({ _id: "enquiries:1", status: "new" }),
        existingRow({ _id: "enquiries:2", status: "new" }),
        existingRow({ _id: "enquiries:3", status: "contacted" }),
        existingRow({ _id: "enquiries:4", status: "closed" }),
      ],
    });
    const result = (await runCounts(bag.ctx, {})) as {
      new: number;
      contacted: number;
    };
    expect(result).toEqual({ new: 2, contacted: 1 });
  });
});

describe("updateEnquiryStatus", () => {
  it("records who handled it and audits the change", async () => {
    const bag = makeCtx({ initial: [existingRow({ _id: "enquiries:1" })] });
    await runUpdate(bag.ctx, {
      enquiryId: "enquiries:1",
      status: "contacted",
    });
    const row = bag.rows.get("enquiries:1")!;
    expect(row.status).toBe("contacted");
    expect(row.handledBy).toBe(USER_ID);
    expect(bag.audits()).toHaveLength(1);
    expect(bag.audits()[0]!.entityType).toBe("enquiry");
  });

  it("keeps the visitor's details out of the audit payload", async () => {
    // `emitAudit` redacts PII, but the payload should not be carrying
    // the name or phone in the first place — the enquiry row already
    // holds them and copying them into a second table serves nothing.
    const bag = makeCtx({ initial: [existingRow({ _id: "enquiries:1" })] });
    await runUpdate(bag.ctx, { enquiryId: "enquiries:1", status: "closed" });
    const serialised = JSON.stringify(bag.audits()[0]);
    expect(serialised).not.toContain("555");
    expect(serialised).not.toContain("Someone");
  });

  it("allows reopening a closed enquiry", async () => {
    const bag = makeCtx({
      initial: [existingRow({ _id: "enquiries:1", status: "closed" })],
    });
    await runUpdate(bag.ctx, { enquiryId: "enquiries:1", status: "new" });
    expect(bag.rows.get("enquiries:1")!.status).toBe("new");
  });

  it("refuses a field worker", async () => {
    const bag = makeCtx({
      roles: ["field_worker"],
      initial: [existingRow({ _id: "enquiries:1" })],
    });
    let thrown: unknown;
    try {
      await runUpdate(bag.ctx, {
        enquiryId: "enquiries:1",
        status: "contacted",
      });
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe("FORBIDDEN");
  });

  it("reports NOT_FOUND for an enquiry that is gone", async () => {
    const bag = makeCtx();
    let thrown: unknown;
    try {
      await runUpdate(bag.ctx, {
        enquiryId: "enquiries:gone",
        status: "closed",
      });
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe("NOT_FOUND");
  });
});
