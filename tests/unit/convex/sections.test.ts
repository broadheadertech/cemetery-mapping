/**
 * Story 1.15 — `convex/sections.ts` unit tests.
 *
 * Hand-mocked-ctx pattern (matches `expenseCategories.test.ts`).
 * Covers each exported mutation/query: listSections,
 * listActiveSections, getSection, createSection, updateSection,
 * deleteSection. Verifies auth gating, validation, name uniqueness,
 * deletion-with-linked-lots rejection, audit emission, and the
 * retired-section dropdown filter.
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
import {
  createSection,
  deleteSection,
  getSection,
  listActiveSections,
  listSections,
  updateSection,
} from "../../../convex/sections";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-05-24T12:00:00+08:00").getTime();
const USER_ID = "users:admin1";
const SESSION_ID = "authSessions:s1";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";
type SectionKind =
  | "chapel"
  | "family"
  | "standard"
  | "niche"
  | "columbarium";

interface SectionFixture {
  _id: string;
  _creationTime: number;
  name: string;
  displayName: string;
  sortOrder: number;
  kind: SectionKind;
  descriptionMarkdown?: string;
  geometryBoundsBox?: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
  isRetired: boolean;
  createdAt: number;
  createdBy: string;
}

interface LotFixture {
  _id: string;
  _creationTime: number;
  section: string;
  sectionId?: string;
  isRetired: boolean;
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
  };
}

interface CtxBag {
  sections: Map<string, SectionFixture>;
  lots: Map<string, LotFixture>;
  auditInserts: AuditInsert[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  initialSections?: SectionFixture[];
  initialLots?: LotFixture[];
  authenticated?: boolean;
}): CtxBag {
  const sections = new Map<string, SectionFixture>(
    (opts.initialSections ?? []).map((s) => [s._id, s]),
  );
  const lots = new Map<string, LotFixture>(
    (opts.initialLots ?? []).map((l) => [l._id, l]),
  );
  const auditInserts: AuditInsert[] = [];

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
    name: "Admin Reyes",
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
    type Predicate = (r: LotFixture) => boolean;
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
        return Array.from(lots.values()).filter((r) =>
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

  const ctx = {
    db: {
      get: vi.fn(async (id: string) => {
        if (id === USER_ID) return user;
        if (id === SESSION_ID) return session;
        if (sections.has(id)) return sections.get(id);
        if (lots.has(id)) return lots.get(id);
        return null;
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return {
            withIndex: () => ({
              collect: async () => userRoles,
            }),
          };
        }
        if (table === "sections") {
          return makeSectionsQueryBuilder();
        }
        if (table === "lots") {
          return makeLotsQueryBuilder();
        }
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
        const existing = sections.get(id);
        if (existing !== undefined) {
          sections.set(id, { ...existing, ...patch } as SectionFixture);
        }
        return null;
      }),
      delete: vi.fn(async (id: string) => {
        sections.delete(id);
        return null;
      }),
    },
  };

  return { sections, lots, auditInserts, ctx };
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

function getKind(thrown: unknown): string | undefined {
  if (!(thrown instanceof ConvexError)) return undefined;
  const data = (thrown as ConvexError<Value>).data as unknown as ErrorPayload;
  const details = data?.details as { kind?: string } | undefined;
  return details?.kind;
}

function makeSection(
  overrides: Partial<SectionFixture> = {},
): SectionFixture {
  const name = overrides.name ?? "section-a-north";
  return {
    _id: overrides._id ?? `sections:seed-${name}`,
    _creationTime: T0,
    name,
    displayName: overrides.displayName ?? "Section A · North",
    sortOrder: overrides.sortOrder ?? 10,
    kind: overrides.kind ?? "standard",
    isRetired: overrides.isRetired ?? false,
    createdAt: T0,
    createdBy: USER_ID,
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

describe("createSection", () => {
  const run = handlerOf(createSection);

  it("admin can create a new section; row inserted with isRetired=false; audit emitted", async () => {
    const { ctx, sections, auditInserts } = makeCtx({ roles: ["admin"] });
    const result = (await run(ctx, {
      name: "chapel-of-grace",
      displayName: "Chapel of Grace",
      sortOrder: 0,
      kind: "chapel",
      descriptionMarkdown: "The cemetery's central chapel.",
    })) as { sectionId: string };

    expect(sections.size).toBe(1);
    const row = sections.get(result.sectionId)!;
    expect(row.name).toBe("chapel-of-grace");
    expect(row.displayName).toBe("Chapel of Grace");
    expect(row.sortOrder).toBe(0);
    expect(row.kind).toBe("chapel");
    expect(row.descriptionMarkdown).toBe("The cemetery's central chapel.");
    expect(row.isRetired).toBe(false);
    expect(row.createdBy).toBe(USER_ID);
    expect(row.createdAt).toBe(T0);

    expect(auditInserts).toHaveLength(1);
    const audit = auditInserts[0]!;
    expect(audit.row.action).toBe("create");
    // Story 1.15 H6 — section CRUD audit rows now carry
    // entityType: "section" so `by_entity` lookups surface them.
    expect(audit.row.entityType).toBe("section");
    expect(audit.row.entityId).toBe(result.sectionId);
    expect(audit.row.after).toMatchObject({
      kind: "section",
      sectionKind: "chapel",
      name: "chapel-of-grace",
      isRetired: false,
    });
  });

  it("trims name + displayName before insert", async () => {
    const { ctx, sections } = makeCtx({ roles: ["admin"] });
    const result = (await run(ctx, {
      name: "  family-estates-east  ",
      displayName: "  Family Estates · East  ",
      sortOrder: 20,
      kind: "family",
    })) as { sectionId: string };
    const row = sections.get(result.sectionId)!;
    expect(row.name).toBe("family-estates-east");
    expect(row.displayName).toBe("Family Estates · East");
  });

  it("rejects an empty name with VALIDATION", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const thrown = await run(ctx, {
      name: "",
      displayName: "X",
      sortOrder: 0,
      kind: "standard",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects an empty displayName with VALIDATION", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const thrown = await run(ctx, {
      name: "x",
      displayName: "",
      sortOrder: 0,
      kind: "standard",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects a non-kebab-case name with VALIDATION", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const thrown = await run(ctx, {
      name: "Section A North",
      displayName: "X",
      sortOrder: 0,
      kind: "standard",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects a non-integer sortOrder with VALIDATION", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const thrown = await run(ctx, {
      name: "x",
      displayName: "X",
      sortOrder: 1.5,
      kind: "standard",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects a duplicate name with DUPLICATE_SECTION_NAME kind", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialSections: [makeSection({ name: "section-a-north" })],
    });
    const thrown = await run(ctx, {
      name: "section-a-north",
      displayName: "Section A · North (dup)",
      sortOrder: 20,
      kind: "standard",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(getKind(thrown)).toBe("DUPLICATE_SECTION_NAME");
  });

  it("rejects office_staff with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(ctx, {
      name: "x",
      displayName: "X",
      sortOrder: 0,
      kind: "standard",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects field_worker with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    const thrown = await run(ctx, {
      name: "x",
      displayName: "X",
      sortOrder: 0,
      kind: "standard",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {
      name: "x",
      displayName: "X",
      sortOrder: 0,
      kind: "standard",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });
});

describe("updateSection", () => {
  const run = handlerOf(updateSection);

  it("renames a section; emits audit with before / after", async () => {
    const { ctx, sections, auditInserts } = makeCtx({
      roles: ["admin"],
      initialSections: [
        makeSection({ _id: "sections:s1", name: "section-a-north" }),
      ],
    });
    await run(ctx, {
      sectionId: "sections:s1",
      patch: { name: "section-a-n" },
    });
    expect(sections.get("sections:s1")!.name).toBe("section-a-n");
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]!.row.action).toBe("update");
    // Story 1.15 H6 — section CRUD audit rows now carry entityType: "section".
    expect(auditInserts[0]!.row.entityType).toBe("section");
    expect(auditInserts[0]!.row.entityId).toBe("sections:s1");
    expect(auditInserts[0]!.row.before).toMatchObject({
      kind: "section",
      name: "section-a-north",
    });
    expect(auditInserts[0]!.row.after).toMatchObject({
      kind: "section",
      name: "section-a-n",
    });
  });

  it("rejects rename that collides with another section", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialSections: [
        makeSection({ _id: "sections:s1", name: "section-a-north" }),
        makeSection({ _id: "sections:s2", name: "section-b-south" }),
      ],
    });
    const thrown = await run(ctx, {
      sectionId: "sections:s2",
      patch: { name: "section-a-north" },
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(getKind(thrown)).toBe("DUPLICATE_SECTION_NAME");
  });

  it("retiring via patch.isRetired=true emits a deactivate audit row", async () => {
    const { ctx, sections, auditInserts } = makeCtx({
      roles: ["admin"],
      initialSections: [makeSection({ _id: "sections:s1" })],
    });
    await run(ctx, {
      sectionId: "sections:s1",
      patch: { isRetired: true },
    });
    expect(sections.get("sections:s1")!.isRetired).toBe(true);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]!.row.action).toBe("deactivate");
    expect(auditInserts[0]!.row.entityType).toBe("section");
  });

  it("restoring via patch.isRetired=false emits a reactivate audit row", async () => {
    const { ctx, sections, auditInserts } = makeCtx({
      roles: ["admin"],
      initialSections: [
        makeSection({ _id: "sections:s1", isRetired: true }),
      ],
    });
    await run(ctx, {
      sectionId: "sections:s1",
      patch: { isRetired: false },
    });
    expect(sections.get("sections:s1")!.isRetired).toBe(false);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]!.row.action).toBe("reactivate");
    expect(auditInserts[0]!.row.entityType).toBe("section");
  });

  it("updates non-name fields and emits an update audit row", async () => {
    const { ctx, sections, auditInserts } = makeCtx({
      roles: ["admin"],
      initialSections: [makeSection({ _id: "sections:s1" })],
    });
    await run(ctx, {
      sectionId: "sections:s1",
      patch: {
        displayName: "Section A · Updated",
        sortOrder: 100,
        kind: "family",
      },
    });
    const row = sections.get("sections:s1")!;
    expect(row.displayName).toBe("Section A · Updated");
    expect(row.sortOrder).toBe(100);
    expect(row.kind).toBe("family");
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]!.row.action).toBe("update");
    expect(auditInserts[0]!.row.entityType).toBe("section");
  });

  it("rejects NOT_FOUND when the row is missing", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const thrown = await run(ctx, {
      sectionId: "sections:missing",
      patch: { displayName: "X" },
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("rejects office_staff with FORBIDDEN", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      initialSections: [makeSection({ _id: "sections:s1" })],
    });
    const thrown = await run(ctx, {
      sectionId: "sections:s1",
      patch: { displayName: "X" },
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("empty patch is a no-op (no audit emitted)", async () => {
    const { ctx, auditInserts } = makeCtx({
      roles: ["admin"],
      initialSections: [makeSection({ _id: "sections:s1" })],
    });
    await run(ctx, { sectionId: "sections:s1", patch: {} });
    expect(auditInserts).toHaveLength(0);
  });
});

describe("deleteSection", () => {
  const run = handlerOf(deleteSection);

  it("admin can delete a section with no linked lots; audit emitted", async () => {
    const { ctx, sections, auditInserts } = makeCtx({
      roles: ["admin"],
      initialSections: [makeSection({ _id: "sections:s1" })],
    });
    const result = (await run(ctx, { sectionId: "sections:s1" })) as {
      deleted: true;
    };
    expect(result.deleted).toBe(true);
    expect(sections.has("sections:s1")).toBe(false);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]!.row.action).toBe("delete");
    expect(auditInserts[0]!.row.entityType).toBe("section");
    expect(auditInserts[0]!.row.entityId).toBe("sections:s1");
  });

  it("refuses delete when any lot references the section", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialSections: [makeSection({ _id: "sections:s1" })],
      initialLots: [
        {
          _id: "lots:L1",
          _creationTime: T0,
          section: "Section A · North",
          sectionId: "sections:s1",
          isRetired: false,
        },
      ],
    });
    const thrown = await run(ctx, { sectionId: "sections:s1" }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(getKind(thrown)).toBe("CANNOT_DELETE_SECTION_WITH_LOTS");
  });

  it("rejects NOT_FOUND when the row is missing", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const thrown = await run(ctx, { sectionId: "sections:missing" }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("rejects office_staff with FORBIDDEN", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      initialSections: [makeSection({ _id: "sections:s1" })],
    });
    const thrown = await run(ctx, { sectionId: "sections:s1" }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("listSections", () => {
  const run = handlerOf(listSections);

  it("admin sees all sections sorted by sortOrder ascending", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialSections: [
        makeSection({ _id: "sections:s1", name: "z", sortOrder: 30 }),
        makeSection({ _id: "sections:s2", name: "a", sortOrder: 10 }),
        makeSection({ _id: "sections:s3", name: "m", sortOrder: 20 }),
      ],
    });
    const result = (await run(ctx, {})) as Array<{
      _id: string;
      sortOrder: number;
    }>;
    expect(result.map((r) => r._id)).toEqual([
      "sections:s2",
      "sections:s3",
      "sections:s1",
    ]);
  });

  it("excludes retired sections by default", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialSections: [
        makeSection({ _id: "sections:s1", name: "a" }),
        makeSection({ _id: "sections:s2", name: "b", isRetired: true }),
      ],
    });
    const result = (await run(ctx, {})) as Array<{ _id: string }>;
    expect(result.map((r) => r._id)).toEqual(["sections:s1"]);
  });

  it("includeRetired surfaces retired rows too", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialSections: [
        makeSection({ _id: "sections:s1", name: "a" }),
        makeSection({ _id: "sections:s2", name: "b", isRetired: true }),
      ],
    });
    const result = (await run(ctx, { includeRetired: true })) as Array<{
      _id: string;
    }>;
    expect(result).toHaveLength(2);
  });

  it("includes linkedLotCount per row", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialSections: [makeSection({ _id: "sections:s1" })],
      initialLots: [
        {
          _id: "lots:L1",
          _creationTime: T0,
          section: "Section A · North",
          sectionId: "sections:s1",
          isRetired: false,
        },
        {
          _id: "lots:L2",
          _creationTime: T0,
          section: "Section A · North",
          sectionId: "sections:s1",
          isRetired: false,
        },
      ],
    });
    const result = (await run(ctx, {})) as Array<{
      _id: string;
      linkedLotCount: number;
    }>;
    expect(result[0]!.linkedLotCount).toBe(2);
  });

  it("rejects non-admin with FORBIDDEN", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("listActiveSections", () => {
  const run = handlerOf(listActiveSections);

  it("returns active sections sorted by sortOrder", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      initialSections: [
        makeSection({ _id: "sections:s1", name: "z", sortOrder: 30 }),
        makeSection({ _id: "sections:s2", name: "a", sortOrder: 10 }),
        makeSection({ _id: "sections:s3", name: "m", sortOrder: 20 }),
      ],
    });
    const result = (await run(ctx, {})) as Array<{
      _id: string;
      displayName: string;
    }>;
    expect(result.map((r) => r._id)).toEqual([
      "sections:s2",
      "sections:s3",
      "sections:s1",
    ]);
  });

  it("hides retired sections (NOT shown in the LotForm dropdown)", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      initialSections: [
        makeSection({ _id: "sections:s1", name: "a" }),
        makeSection({ _id: "sections:s2", name: "b", isRetired: true }),
      ],
    });
    const result = (await run(ctx, {})) as Array<{ _id: string }>;
    expect(result.map((r) => r._id)).toEqual(["sections:s1"]);
  });

  it("field_worker can read (cached offline data joins section labels)", async () => {
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      initialSections: [makeSection({ _id: "sections:s1" })],
    });
    const result = (await run(ctx, {})) as Array<{ _id: string }>;
    expect(result).toHaveLength(1);
  });

  it("rejects unauthenticated callers", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("rejects customer role", async () => {
    const { ctx } = makeCtx({ roles: ["customer"] });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("getSection", () => {
  const run = handlerOf(getSection);

  it("admin reads a section by id", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      initialSections: [makeSection({ _id: "sections:s1" })],
    });
    const result = (await run(ctx, { sectionId: "sections:s1" })) as {
      _id: string;
    } | null;
    expect(result?._id).toBe("sections:s1");
  });

  it("returns null for missing rows", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    const result = await run(ctx, { sectionId: "sections:missing" });
    expect(result).toBeNull();
  });

  it("rejects office_staff with FORBIDDEN", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      initialSections: [makeSection({ _id: "sections:s1" })],
    });
    const thrown = await run(ctx, { sectionId: "sections:s1" }).catch(
      (e) => e,
    );
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});
