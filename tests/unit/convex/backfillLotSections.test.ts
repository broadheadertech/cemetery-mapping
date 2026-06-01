/**
 * Story 1.15 — `convex/internal/backfillLotSections.ts` unit tests.
 *
 * Covers the one-shot deploy-time migration that promotes the legacy
 * free-text `lots.section` string into the `sections` registry.
 *
 * Cases:
 *   - happy path: 5 lots / 3 distinct legacy strings → 3 sections, 5
 *     `sectionId` patches, 3 deterministic sortOrder values.
 *   - idempotency: re-run on already-backfilled data is a no-op.
 *   - kebab derivation: "Section A · North" → "section-a-north".
 *   - empty legacy values are skipped + counted.
 *   - existing section rows are reused via the `by_name` index.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import {
  deriveKebabName,
  run as backfillRun,
} from "../../../convex/internal/backfillLotSections";

const T0 = new Date("2026-05-24T12:00:00+08:00").getTime();
const USER_ID = "users:admin1";

type SectionKind =
  | "chapel"
  | "family"
  | "standard"
  | "niche"
  | "columbarium";

interface LotFixture {
  _id: string;
  _creationTime: number;
  section: string;
  sectionId?: string;
  createdBy: string;
}

interface SectionFixture {
  _id: string;
  _creationTime: number;
  name: string;
  displayName: string;
  sortOrder: number;
  kind: SectionKind;
  isRetired: boolean;
  createdAt: number;
  createdBy: string;
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

function makeCtx(opts: {
  initialLots?: LotFixture[];
  initialSections?: SectionFixture[];
}) {
  const lots = new Map<string, LotFixture>(
    (opts.initialLots ?? []).map((l) => [l._id, l]),
  );
  const sections = new Map<string, SectionFixture>(
    (opts.initialSections ?? []).map((s) => [s._id, s]),
  );
  const auditInserts: AuditInsert[] = [];

  let nextId = 1;

  interface IndexQuery {
    eqs: Record<string, unknown>;
    eq(field: string, value: unknown): IndexQuery;
  }

  function makeSectionsQueryBuilder() {
    type Predicate = (r: SectionFixture) => boolean;
    const predicates: Predicate[] = [];
    const builder = {
      withIndex(_indexName: string, fn?: (q: IndexQuery) => IndexQuery) {
        if (fn !== undefined) {
          const q: IndexQuery = {
            eqs: {},
            eq(field, value) {
              this.eqs[field] = value;
              return this;
            },
          };
          fn(q);
          for (const [field, value] of Object.entries(q.eqs)) {
            predicates.push(
              (r) =>
                (r as unknown as Record<string, unknown>)[field] === value,
            );
          }
        }
        return builder;
      },
      async collect() {
        return Array.from(sections.values()).filter((r) =>
          predicates.every((p) => p(r)),
        );
      },
      async first() {
        const rows = await builder.collect();
        return rows[0] ?? null;
      },
    };
    return builder;
  }

  function makeLotsQueryBuilder() {
    const builder = {
      withIndex() {
        return builder;
      },
      async collect() {
        return Array.from(lots.values());
      },
      async first() {
        return Array.from(lots.values())[0] ?? null;
      },
    };
    return builder;
  }

  const ctx = {
    db: {
      get: vi.fn(async (id: string) => {
        if (lots.has(id)) return lots.get(id);
        if (sections.has(id)) return sections.get(id);
        return null;
      }),
      query: vi.fn((table: string) => {
        if (table === "sections") return makeSectionsQueryBuilder();
        if (table === "lots") return makeLotsQueryBuilder();
        return {
          withIndex: () => ({
            collect: async () => [],
            first: async () => null,
          }),
        };
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "sections") {
          const id = `sections:${nextId++}`;
          sections.set(id, {
            _id: id,
            _creationTime: T0,
            ...row,
          } as SectionFixture);
          return id;
        }
        if (table === "auditLog") {
          auditInserts.push({ table, row: row as AuditInsert["row"] });
          return `auditLog:${auditInserts.length}`;
        }
        return `${table}:?`;
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        const existing = lots.get(id);
        if (existing !== undefined) {
          lots.set(id, { ...existing, ...patch } as LotFixture);
        }
        return null;
      }),
    },
  };

  return { lots, sections, auditInserts, ctx };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerOf(fn: any): (ctx: unknown, args: unknown) => Promise<unknown> {
  for (const key of ["_handler", "handler", "invokeMutation", "invokeQuery"]) {
    const v = fn[key];
    if (typeof v === "function") return v as never;
  }
  if (typeof fn === "function") return fn as never;
  throw new Error("Cannot locate handler on internal mutation");
}

function makeLot(overrides: Partial<LotFixture> = {}): LotFixture {
  return {
    _id: overrides._id ?? "lots:L?",
    _creationTime: T0,
    section: overrides.section ?? "Section A · North",
    createdBy: USER_ID,
    ...overrides,
  };
}

beforeEach(() => {
  // Silence any incidental console output during the run.
  vi.spyOn(console, "log").mockImplementation(() => {});
});

// Helper so test bodies don't repeat the actorUserId arg literal. The
// internal mutation refuses to run without it (post-H5).
const RUN_ARGS = { actorUserId: USER_ID };

describe("deriveKebabName", () => {
  it("converts 'Section A · North' to 'section-a-north'", () => {
    expect(deriveKebabName("Section A · North")).toBe("section-a-north");
  });

  it("converts 'Family Estates · East' to 'family-estates-east'", () => {
    expect(deriveKebabName("Family Estates · East")).toBe(
      "family-estates-east",
    );
  });

  it("lowercases and collapses repeated hyphens", () => {
    expect(deriveKebabName("CHAPEL  OF  GRACE")).toBe("chapel-of-grace");
  });

  it("trims trailing whitespace and hyphens", () => {
    expect(deriveKebabName("  D  ")).toBe("d");
    expect(deriveKebabName("--abc--")).toBe("abc");
  });

  it("collapses repeated non-alnum runs in middle", () => {
    expect(deriveKebabName("A · B · C")).toBe("a-b-c");
  });
});

describe("backfillLotSections.run", () => {
  const run = handlerOf(backfillRun);

  it("creates one section per distinct legacy string and patches every lot", async () => {
    const { ctx, lots, sections } = makeCtx({
      initialLots: [
        makeLot({ _id: "lots:L1", section: "Section A · North" }),
        makeLot({ _id: "lots:L2", section: "Section A · North" }),
        makeLot({ _id: "lots:L3", section: "Chapel of Grace" }),
        makeLot({ _id: "lots:L4", section: "Family Estates · East" }),
        makeLot({ _id: "lots:L5", section: "Family Estates · East" }),
      ],
    });
    const result = (await run(ctx, RUN_ARGS)) as {
      lotsTouched: number;
      sectionsCreated: number;
      sectionsReused: number;
      lotsSkipped: number;
      emptyLegacyValueLots: number;
    };
    expect(result.sectionsCreated).toBe(3);
    expect(result.lotsTouched).toBe(5);
    expect(result.sectionsReused).toBe(0);
    expect(result.lotsSkipped).toBe(0);
    expect(result.emptyLegacyValueLots).toBe(0);

    expect(sections.size).toBe(3);

    // Sort orders are 10, 20, 30 (× 10 spacing).
    const orderedSortOrders = Array.from(sections.values())
      .map((s) => s.sortOrder)
      .sort((a, b) => a - b);
    expect(orderedSortOrders).toEqual([10, 20, 30]);

    // Every lot now carries a sectionId.
    for (const lot of lots.values()) {
      expect(lot.sectionId).toBeDefined();
    }

    // Lots sharing a legacy string share their sectionId.
    expect(lots.get("lots:L1")!.sectionId).toBe(
      lots.get("lots:L2")!.sectionId,
    );
    expect(lots.get("lots:L4")!.sectionId).toBe(
      lots.get("lots:L5")!.sectionId,
    );
  });

  it("seeds sections with kind=standard and isRetired=false", async () => {
    const { ctx, sections } = makeCtx({
      initialLots: [makeLot({ _id: "lots:L1", section: "Chapel of Grace" })],
    });
    await run(ctx, RUN_ARGS);
    const section = Array.from(sections.values())[0]!;
    expect(section.kind).toBe("standard");
    expect(section.isRetired).toBe(false);
    expect(section.displayName).toBe("Chapel of Grace");
    expect(section.name).toBe("chapel-of-grace");
  });

  it("is idempotent on re-run (no new sections, no patches)", async () => {
    const { ctx, lots, sections } = makeCtx({
      initialLots: [
        makeLot({ _id: "lots:L1", section: "Section A · North" }),
        makeLot({ _id: "lots:L2", section: "Section A · North" }),
      ],
    });
    const first = (await run(ctx, RUN_ARGS)) as { sectionsCreated: number };
    expect(first.sectionsCreated).toBe(1);
    expect(sections.size).toBe(1);

    const second = (await run(ctx, RUN_ARGS)) as {
      sectionsCreated: number;
      lotsTouched: number;
      lotsSkipped: number;
      sectionsReused: number;
    };
    expect(second.sectionsCreated).toBe(0);
    expect(second.lotsTouched).toBe(0);
    expect(second.lotsSkipped).toBe(2);
    expect(second.sectionsReused).toBe(1);
    // No duplicate section row inserted.
    expect(sections.size).toBe(1);
    // Lot sectionId unchanged after the second pass.
    const firstAssigned = lots.get("lots:L1")!.sectionId;
    expect(lots.get("lots:L2")!.sectionId).toBe(firstAssigned);
  });

  it("skips lots with empty / whitespace-only legacy values", async () => {
    const { ctx, lots, sections } = makeCtx({
      initialLots: [
        makeLot({ _id: "lots:L1", section: "Section A · North" }),
        makeLot({ _id: "lots:L2", section: "" }),
        makeLot({ _id: "lots:L3", section: "   " }),
      ],
    });
    const result = (await run(ctx, RUN_ARGS)) as {
      sectionsCreated: number;
      lotsTouched: number;
      emptyLegacyValueLots: number;
    };
    expect(result.sectionsCreated).toBe(1);
    expect(result.lotsTouched).toBe(1);
    expect(result.emptyLegacyValueLots).toBe(2);
    expect(sections.size).toBe(1);
    expect(lots.get("lots:L2")!.sectionId).toBeUndefined();
    expect(lots.get("lots:L3")!.sectionId).toBeUndefined();
  });

  it("reuses an existing section row that matches by name", async () => {
    const { ctx, sections } = makeCtx({
      initialSections: [
        {
          _id: "sections:preseed",
          _creationTime: T0,
          name: "section-a-north",
          displayName: "Section A · North (pre-seed)",
          sortOrder: 99,
          kind: "standard",
          isRetired: false,
          createdAt: T0,
          createdBy: USER_ID,
        },
      ],
      initialLots: [
        makeLot({ _id: "lots:L1", section: "Section A · North" }),
      ],
    });
    const result = (await run(ctx, RUN_ARGS)) as {
      sectionsCreated: number;
      sectionsReused: number;
      lotsTouched: number;
    };
    expect(result.sectionsCreated).toBe(0);
    expect(result.sectionsReused).toBe(1);
    expect(result.lotsTouched).toBe(1);
    expect(sections.size).toBe(1);
  });

  it("handles an empty lots table cleanly", async () => {
    const { ctx } = makeCtx({});
    const result = (await run(ctx, RUN_ARGS)) as {
      sectionsCreated: number;
      lotsTouched: number;
    };
    expect(result.sectionsCreated).toBe(0);
    expect(result.lotsTouched).toBe(0);
  });
});

describe("backfillLotSections.run — AC4 audit emission (Story 1.15 H5)", () => {
  const run = handlerOf(backfillRun);

  it("emits a migration_backfill audit row with operator-supplied actor", async () => {
    const { ctx, auditInserts } = makeCtx({
      initialLots: [
        makeLot({ _id: "lots:L1", section: "Section A · North" }),
        makeLot({ _id: "lots:L2", section: "Section A · North" }),
        makeLot({ _id: "lots:L3", section: "Chapel of Grace" }),
      ],
    });
    await run(ctx, RUN_ARGS);
    // Exactly one audit row per invocation (AC4 — replaces the prior
    // console.log path).
    expect(auditInserts).toHaveLength(1);
    const audit = auditInserts[0]!;
    expect(audit.table).toBe("auditLog");
    expect(audit.row.actor).toBe(USER_ID);
    expect(audit.row.action).toBe("create");
    expect(audit.row.entityType).toBe("section");
    // entityId points at one of the inserted sections (non-empty
    // string id, not the "all" fallback).
    expect(audit.row.entityId.startsWith("sections:")).toBe(true);
    expect(audit.row.after).toMatchObject({
      kind: "migration_backfill",
      rowsTouched: 3,
      sectionsCreated: 2,
      sectionsReused: 0,
      lotsSkipped: 0,
      emptyLegacyValueLots: 0,
    });
    expect(audit.row.reason).toMatch(/Story 1\.15 backfill/);
  });

  it("emits a fresh audit row on a no-op re-run (idempotent state, append-only log)", async () => {
    const { ctx, auditInserts } = makeCtx({
      initialLots: [
        makeLot({ _id: "lots:L1", section: "Section A · North" }),
      ],
    });
    await run(ctx, RUN_ARGS);
    await run(ctx, RUN_ARGS);
    expect(auditInserts).toHaveLength(2);
    const second = auditInserts[1]!;
    expect(second.row.after).toMatchObject({
      kind: "migration_backfill",
      rowsTouched: 0,
      sectionsCreated: 0,
      sectionsReused: 1,
      lotsSkipped: 1,
    });
  });

  it("falls back to the 'all' entityId when no sections were created or reused", async () => {
    // Empty lots table — no sections inserted, no sections reused.
    // The migration still needs an audit row; entityId falls back to
    // the literal "all".
    const { ctx, auditInserts } = makeCtx({});
    await run(ctx, RUN_ARGS);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]!.row.entityId).toBe("all");
    expect(auditInserts[0]!.row.after).toMatchObject({
      kind: "migration_backfill",
      rowsTouched: 0,
      sectionsCreated: 0,
    });
  });
});
