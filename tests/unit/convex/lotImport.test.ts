/**
 * `convex/lotImport.ts` — legacy lot-inventory import unit tests.
 *
 * Same hand-mocked ctx strategy as `gpsImport.test.ts` and
 * `lots.test.ts`: `convex-test` needs `convex/_generated/`, which this
 * repo deliberately omits.
 *
 * The cases worth having here are the ones that protect real money and
 * real graves: that `sold` cannot be conjured without a contract, that
 * a duplicate never double-creates a lot, that one bad spreadsheet row
 * does not cost the operator the other 499, and that the preview and
 * the import agree on what will happen.
 */

import { ConvexError, type Value } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ErrorPayload } from "../../../convex/lib/errors";
import { HOUR_MS } from "../../../convex/lib/time";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { importLotBatch, previewLotBatch } from "../../../convex/lotImport";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-08-23T08:00:00+08:00").getTime();
const USER_ID = "users:admin1";
const SESSION_ID = "authSessions:sessAdmin";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface LotRow {
  _id: string;
  _creationTime: number;
  code: string;
  section: string;
  sectionId?: string;
  block: string;
  row: string;
  type: string;
  dimensions: { widthM: number; depthM: number };
  basePriceCents: number;
  status: string;
  isRetired: boolean;
  [key: string]: unknown;
}

interface SectionRow {
  _id: string;
  _creationTime: number;
  name: string;
  displayName: string;
  isRetired: boolean;
}

interface InsertRecord {
  table: string;
  row: Record<string, unknown>;
}

interface CtxBag {
  inserts: InsertRecord[];
  lotsInserted: () => Record<string, unknown>[];
  audits: () => Record<string, unknown>[];
  counterWrites: () => Array<{ table: string; row: Record<string, unknown> }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  lots?: LotRow[];
  sections?: SectionRow[];
  authenticated?: boolean;
}): CtxBag {
  const lots = new Map<string, LotRow>(
    (opts.lots ?? []).map((l) => [l._id, l]),
  );
  const sections = opts.sections ?? [];
  const inserts: InsertRecord[] = [];
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const counters = new Map<string, { _id: string; key: string; count: number }>();

  if (opts.authenticated === false) {
    mockedGetAuthUserId.mockResolvedValue(null);
    mockedGetAuthSessionId.mockResolvedValue(null);
  } else {
    mockedGetAuthUserId.mockResolvedValue(USER_ID as never);
    mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);
  }

  const user = {
    _id: USER_ID,
    _creationTime: T0 - 1000,
    email: "admin@example.com",
  };
  const session = {
    _id: SESSION_ID,
    _creationTime: T0,
    userId: USER_ID,
    expirationTime: T0 + 30 * 24 * HOUR_MS,
  };
  const userRoles = (opts.roles ?? ["admin"]).map((role, idx) => ({
    _id: `userRoles:${idx}`,
    _creationTime: T0,
    userId: USER_ID,
    role,
    grantedAt: T0,
    grantedBy: USER_ID,
  }));

  interface IndexQuery {
    eqs: Record<string, unknown>;
    eq(field: string, value: unknown): IndexQuery;
  }

  function rowsFor(table: string): Record<string, unknown>[] {
    if (table === "lots") return Array.from(lots.values());
    if (table === "sections") return sections as unknown as Record<string, unknown>[];
    if (table === "dashboardCountersByLotStatus") {
      return Array.from(counters.values()) as unknown as Record<
        string,
        unknown
      >[];
    }
    return [];
  }

  function makeQueryBuilder(table: string) {
    const predicates: Array<(r: Record<string, unknown>) => boolean> = [];
    const builder = {
      withIndex(_name: string, fn: (q: IndexQuery) => IndexQuery) {
        const q: IndexQuery = {
          eqs: {},
          eq(field: string, value: unknown) {
            this.eqs[field] = value;
            return this;
          },
        };
        fn(q);
        for (const [field, value] of Object.entries(q.eqs)) {
          predicates.push((r) => r[field] === value);
        }
        return builder;
      },
      async first(): Promise<Record<string, unknown> | null> {
        for (const row of rowsFor(table)) {
          if (predicates.every((p) => p(row))) return row;
        }
        return null;
      },
      async collect(): Promise<Record<string, unknown>[]> {
        return rowsFor(table).filter((r) => predicates.every((p) => p(r)));
      },
    };
    return builder;
  }

  let seq = 0;
  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === USER_ID) return user;
        if (id === SESSION_ID) return session;
        if (lots.has(id)) return lots.get(id);
        return sections.find((s) => s._id === id) ?? null;
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return {
            withIndex: (_n: string, _f: unknown) => ({
              collect: async () => userRoles,
            }),
          };
        }
        return makeQueryBuilder(table);
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        seq += 1;
        const id = `${table}:${seq}`;
        inserts.push({ table, row });
        if (table === "lots") {
          lots.set(id, { _id: id, _creationTime: T0, ...row } as LotRow);
        }
        if (table === "dashboardCountersByLotStatus") {
          counters.set(String(row.key), {
            _id: id,
            key: String(row.key),
            count: Number(row.count),
          });
        }
        return id;
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        patches.push({ id, patch });
        for (const [key, counter] of counters) {
          if (counter._id === id) {
            counters.set(key, { ...counter, ...patch } as typeof counter);
          }
        }
      }),
    },
  };

  return {
    inserts,
    lotsInserted: () =>
      inserts.filter((i) => i.table === "lots").map((i) => i.row),
    audits: () =>
      inserts.filter((i) => i.table === "auditLog").map((i) => i.row),
    counterWrites: () =>
      inserts.filter((i) => i.table === "dashboardCountersByLotStatus"),
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

interface Row {
  rowNumber: number;
  code: string;
  section: string;
  block: string;
  row: string;
  type: string;
  widthM: number;
  depthM: number;
  basePriceCents: number;
  status?: string;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    rowNumber: 2,
    code: "A-01-01",
    section: "Section A",
    block: "1",
    row: "1",
    type: "single",
    widthM: 2.5,
    depthM: 1.2,
    basePriceCents: 4_500_000,
    ...overrides,
  };
}

function existingLot(code: string): LotRow {
  return {
    _id: `lots:${code}`,
    _creationTime: T0,
    code,
    section: "Section A",
    block: "1",
    row: "9",
    type: "single",
    dimensions: { widthM: 2.5, depthM: 1.2 },
    basePriceCents: 4_500_000,
    status: "available",
    isRetired: false,
  };
}

function section(name: string, displayName: string): SectionRow {
  return {
    _id: `sections:${name}`,
    _creationTime: T0,
    name,
    displayName,
    isRetired: false,
  };
}

interface Report {
  totalRows: number;
  created: number;
  plan: Array<{
    rowNumber: number;
    code: string;
    section: string;
    sectionLinked: boolean;
    status: string;
  }>;
  errors: Array<{
    rowNumber: number;
    code: string;
    reason: string;
    details: string;
  }>;
  warnings: Array<{ rowNumber: number; code: string; reason: string }>;
}

const runPreview = handlerOf(previewLotBatch);
const runImport = handlerOf(importLotBatch);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  mockedGetAuthUserId.mockReset();
  mockedGetAuthSessionId.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("importLotBatch — authorization", () => {
  it("refuses a non-admin caller", async () => {
    const bag = makeCtx({ roles: ["office_staff"] });
    let thrown: unknown;
    try {
      await runImport(bag.ctx, { rows: [row()] });
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe("FORBIDDEN");
    expect(bag.lotsInserted()).toHaveLength(0);
  });

  it("refuses an unauthenticated caller", async () => {
    const bag = makeCtx({ authenticated: false });
    let thrown: unknown;
    try {
      await runImport(bag.ctx, { rows: [row()] });
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe("UNAUTHENTICATED");
  });

  it("gates the preview on admin too", async () => {
    const bag = makeCtx({ roles: ["office_staff"] });
    let thrown: unknown;
    try {
      await runPreview(bag.ctx, { rows: [row()] });
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe("FORBIDDEN");
  });
});

describe("importLotBatch — batch guards", () => {
  it("rejects an empty batch", async () => {
    const bag = makeCtx({});
    let thrown: unknown;
    try {
      await runImport(bag.ctx, { rows: [] });
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe("VALIDATION");
  });

  it("rejects a batch over the per-call cap", async () => {
    const bag = makeCtx({});
    const rows = Array.from({ length: 501 }, (_, i) =>
      row({ code: `A-${i}`, rowNumber: i + 2 }),
    );
    let thrown: unknown;
    try {
      await runImport(bag.ctx, { rows });
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe("VALIDATION");
    expect(bag.lotsInserted()).toHaveLength(0);
  });
});

describe("importLotBatch — the happy path", () => {
  it("creates a lot with placeholder geometry and an audit row", async () => {
    const bag = makeCtx({});
    const result = (await runImport(bag.ctx, {
      rows: [row()],
      reason: "Section A legacy migration, batch 1/4",
    })) as Report;

    expect(result.created).toBe(1);
    expect(result.errors).toEqual([]);

    const lot = bag.lotsInserted()[0]!;
    expect(lot.code).toBe("A-01-01");
    expect(lot.status).toBe("available");
    expect(lot.geometryStatus).toBe("placeholder");
    expect(lot.isRetired).toBe(false);
    expect(lot.createdBy).toBe(USER_ID);

    const audit = bag.audits()[0]!;
    expect(audit.action).toBe("create");
    expect(audit.entityType).toBe("lot");
    expect(audit.reason).toBe("Section A legacy migration, batch 1/4");
  });

  it("records the source line number in the audit payload", async () => {
    // An ownership dispute years later asks "where did this lot come
    // from?" — the answer should name the file line it was imported on.
    const bag = makeCtx({});
    await runImport(bag.ctx, { rows: [row({ rowNumber: 47 })] });
    const audit = bag.audits()[0]!;
    expect(
      (audit.after as Record<string, unknown>).importedFromLine,
    ).toBe(47);
  });

  it("keeps the dashboard lot-status counter in step", async () => {
    const bag = makeCtx({});
    await runImport(bag.ctx, {
      rows: [
        row({ code: "A-01", rowNumber: 2 }),
        row({ code: "A-02", rowNumber: 3, status: "occupied" }),
      ],
    });
    const written = bag.counterWrites().map((w) => w.row);
    expect(written).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "available", count: 1 }),
        expect.objectContaining({ key: "occupied", count: 1 }),
      ]),
    );
  });

  it("defaults a blank status to available", async () => {
    const bag = makeCtx({});
    await runImport(bag.ctx, { rows: [row({ status: "" })] });
    expect(bag.lotsInserted()[0]!.status).toBe("available");
  });
});

describe("importLotBatch — status rules", () => {
  it("refuses to import a lot as sold", async () => {
    // A `sold` lot means "there is an active contract here". Importing
    // one without a contract manufactures a row that AR aging and the
    // reconciliation invariants both expect to find a contract for.
    const bag = makeCtx({});
    const result = (await runImport(bag.ctx, {
      rows: [row({ status: "sold" })],
    })) as Report;

    expect(result.created).toBe(0);
    expect(bag.lotsInserted()).toHaveLength(0);
    expect(result.errors[0]!.reason).toBe("INVALID_STATUS");
    expect(result.errors[0]!.details).toMatch(/contract/i);
  });

  it("admits occupied — a pre-2020 burial is a physical fact", async () => {
    const bag = makeCtx({});
    const result = (await runImport(bag.ctx, {
      rows: [row({ status: "OCCUPIED" })],
    })) as Report;
    expect(result.created).toBe(1);
    expect(bag.lotsInserted()[0]!.status).toBe("occupied");
  });

  it("admits reserved", async () => {
    const bag = makeCtx({});
    await runImport(bag.ctx, { rows: [row({ status: "reserved" })] });
    expect(bag.lotsInserted()[0]!.status).toBe("reserved");
  });

  it("rejects a status outside the importable set", async () => {
    const bag = makeCtx({});
    const result = (await runImport(bag.ctx, {
      rows: [row({ status: "defaulted" })],
    })) as Report;
    expect(result.errors[0]!.reason).toBe("INVALID_STATUS");
  });

  it("rejects an unknown lot type", async () => {
    const bag = makeCtx({});
    const result = (await runImport(bag.ctx, {
      rows: [row({ type: "condo" })],
    })) as Report;
    expect(result.errors[0]!.reason).toBe("INVALID_TYPE");
  });
});

describe("importLotBatch — duplicates", () => {
  it("skips a code that already exists in the database", async () => {
    const bag = makeCtx({ lots: [existingLot("A-01-01")] });
    const result = (await runImport(bag.ctx, { rows: [row()] })) as Report;
    expect(result.created).toBe(0);
    expect(result.errors[0]!.reason).toBe("DUPLICATE_IN_DB");
    expect(bag.lotsInserted()).toHaveLength(0);
  });

  it("creates the first of a code duplicated within the file, not both", async () => {
    const bag = makeCtx({});
    const result = (await runImport(bag.ctx, {
      rows: [
        row({ code: "A-01", rowNumber: 2 }),
        row({ code: "A-01", rowNumber: 9 }),
      ],
    })) as Report;
    expect(result.created).toBe(1);
    expect(result.errors[0]!.reason).toBe("DUPLICATE_IN_FILE");
    // The message must point at the EARLIER line so the operator knows
    // which of the two to delete.
    expect(result.errors[0]!.details).toContain("line 2");
  });

  it("is safe to re-run after a partial import", async () => {
    const bag = makeCtx({});
    const rows = [
      row({ code: "A-01", rowNumber: 2 }),
      row({ code: "A-02", rowNumber: 3 }),
    ];
    await runImport(bag.ctx, { rows });
    const second = (await runImport(bag.ctx, { rows })) as Report;
    expect(second.created).toBe(0);
    expect(second.errors.every((e) => e.reason === "DUPLICATE_IN_DB")).toBe(
      true,
    );
    expect(bag.lotsInserted()).toHaveLength(2);
  });
});

describe("importLotBatch — partial success", () => {
  it("lands the good rows and reports the bad ones by source line", async () => {
    const bag = makeCtx({});
    const result = (await runImport(bag.ctx, {
      rows: [
        row({ code: "A-01", rowNumber: 2 }),
        row({ code: "", rowNumber: 3 }),
        row({ code: "A-03", rowNumber: 4, basePriceCents: 0 }),
        row({ code: "A-04", rowNumber: 5 }),
      ],
    })) as Report;

    expect(result.created).toBe(2);
    expect(bag.lotsInserted().map((l) => l.code)).toEqual(["A-01", "A-04"]);
    expect(result.errors.map((e) => e.rowNumber)).toEqual([3, 4]);
  });

  it("rejects a non-integer centavo amount", async () => {
    const bag = makeCtx({});
    const result = (await runImport(bag.ctx, {
      rows: [row({ basePriceCents: 4_500_000.5 })],
    })) as Report;
    expect(result.created).toBe(0);
    expect(result.errors[0]!.reason).toBe("INVALID_INPUT");
  });

  it("rejects non-positive dimensions", async () => {
    const bag = makeCtx({});
    const result = (await runImport(bag.ctx, {
      rows: [row({ widthM: 0 })],
    })) as Report;
    expect(result.errors[0]!.reason).toBe("INVALID_INPUT");
  });
});

describe("importLotBatch — section linking", () => {
  it("links the section FK when the registry has a matching row", async () => {
    const bag = makeCtx({
      sections: [section("section-a", "Section A")],
    });
    const result = (await runImport(bag.ctx, {
      rows: [row({ section: "Section A" })],
    })) as Report;
    expect(bag.lotsInserted()[0]!.sectionId).toBe("sections:section-a");
    expect(result.warnings).toEqual([]);
    expect(result.plan[0]!.sectionLinked).toBe(true);
  });

  it("matches a section despite case and punctuation drift", async () => {
    const bag = makeCtx({
      sections: [section("section-a-north", "Section A · North")],
    });
    await runImport(bag.ctx, { rows: [row({ section: "SECTION_A_NORTH" })] });
    expect(bag.lotsInserted()[0]!.sectionId).toBe("sections:section-a-north");
  });

  it("still imports when no section is registered, with a warning", async () => {
    const bag = makeCtx({});
    const result = (await runImport(bag.ctx, {
      rows: [row({ section: "Unregistered Field" })],
    })) as Report;
    expect(result.created).toBe(1);
    expect(bag.lotsInserted()[0]!.sectionId).toBeUndefined();
    expect(bag.lotsInserted()[0]!.section).toBe("Unregistered Field");
    expect(result.warnings[0]!.reason).toBe("SECTION_NOT_REGISTERED");
  });

  it("does not link a retired section", async () => {
    const bag = makeCtx({
      sections: [{ ...section("section-a", "Section A"), isRetired: true }],
    });
    const result = (await runImport(bag.ctx, {
      rows: [row({ section: "Section A" })],
    })) as Report;
    expect(bag.lotsInserted()[0]!.sectionId).toBeUndefined();
    expect(result.warnings[0]!.reason).toBe("SECTION_NOT_REGISTERED");
  });
});

describe("previewLotBatch", () => {
  it("writes nothing", async () => {
    const bag = makeCtx({});
    const result = (await runPreview(bag.ctx, {
      rows: [row(), row({ code: "A-02", rowNumber: 3 })],
    })) as Report;
    expect(result.created).toBe(2);
    expect(bag.inserts).toHaveLength(0);
  });

  it("returns the same verdict the import then acts on", async () => {
    // The whole point of the dry run: what the admin signs off on is
    // what runs. Both paths share `validateLotImportRows`, and this
    // asserts they have not drifted.
    const rows = [
      row({ code: "A-01", rowNumber: 2 }),
      row({ code: "A-02", rowNumber: 3, status: "sold" }),
      row({ code: "A-03", rowNumber: 4, type: "bogus" }),
      row({ code: "A-04", rowNumber: 5, status: "occupied" }),
    ];
    const previewBag = makeCtx({});
    const preview = (await runPreview(previewBag.ctx, { rows })) as Report;
    const importBag = makeCtx({});
    const applied = (await runImport(importBag.ctx, { rows })) as Report;

    expect(preview.created).toBe(applied.created);
    expect(preview.plan).toEqual(applied.plan);
    expect(preview.errors).toEqual(applied.errors);
    expect(preview.warnings).toEqual(applied.warnings);
  });

  it("reports the plan in file order with resolved status", async () => {
    const bag = makeCtx({});
    const result = (await runPreview(bag.ctx, {
      rows: [
        row({ code: "A-01", rowNumber: 2 }),
        row({ code: "A-02", rowNumber: 3, status: "occupied" }),
      ],
    })) as Report;
    expect(result.plan).toEqual([
      expect.objectContaining({ rowNumber: 2, code: "A-01", status: "available" }),
      expect.objectContaining({ rowNumber: 3, code: "A-02", status: "occupied" }),
    ]);
  });
});
