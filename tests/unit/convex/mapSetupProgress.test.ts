/**
 * What the map-setup walkthrough is allowed to claim.
 *
 * The page shows six steps as done, in progress or to do. Every one of
 * those is COUNTED here rather than ticked off by a person, which makes
 * this query the thing that decides whether the walkthrough can lie.
 *
 * Two failures matter more than the rest:
 *
 *   - A garden with no lots is invisible to `listForMap`, because that
 *     builds its section list from the lots. If it were invisible here
 *     too, the one garden you forgot would be the one the walkthrough
 *     never mentions.
 *
 *   - A lot whose section string matches no garden cannot be drawn and
 *     cannot be laid out. Nothing else in the app would ever say so.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { mapSetupProgress } from "../../../convex/lots";
import { ErrorCode } from "../../../convex/lib/errors";
import { ConvexError, type Value } from "convex/values";
import type { ErrorPayload } from "../../../convex/lib/errors";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-11-01T10:00:00+08:00").getTime();
const CALLER_ID = "users:admin1";
const SESSION_ID = "authSessions:s1";

type Row = Record<string, unknown>;
type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

function makeCtx(opts: {
  lots?: Row[];
  sections?: Row[];
  roles?: RoleName[];
}) {
  const t = { lots: opts.lots ?? [], sections: opts.sections ?? [] };

  const caller = {
    _id: CALLER_ID,
    _creationTime: T0,
    name: "Admin",
    email: "a@example.com",
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

  const ctx = {
    db: {
      get: vi.fn(async (id: string) => {
        if (id === CALLER_ID) return caller;
        if (id === SESSION_ID) return session;
        for (const rows of Object.values(t) as Row[][]) {
          const hit = rows.find((r) => r["_id"] === id);
          if (hit !== undefined) return hit;
        }
        return null;
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return { withIndex: () => ({ collect: async () => userRoles }) };
        }
        const rows = (t as unknown as Record<string, Row[]>)[table] ?? [];
        return {
          withIndex: () => ({ collect: async () => rows }),
          collect: async () => rows,
        };
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
  throw new Error("Cannot locate handler");
}

const run = handlerOf(mapSetupProgress);

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof ConvexError)) return undefined;
    return ((e as ConvexError<Value>).data as unknown as ErrorPayload)?.code;
  }
  return undefined;
}

function lot(over: Row = {}): Row {
  return {
    _id: "lots:a1",
    _creationTime: T0,
    code: "A-01",
    section: "Garden of Faith",
    block: "1",
    row: "1",
    type: "single",
    status: "available",
    isRetired: false,
    basePriceCents: 100_000_00,
    dimensions: { widthM: 2.5, depthM: 1.2 },
    geometryStatus: "placeholder",
    ...over,
  };
}

function section(over: Row = {}): Row {
  return {
    _id: "sections:faith",
    _creationTime: T0,
    name: "garden-of-faith",
    displayName: "Garden of Faith",
    sortOrder: 1,
    kind: "standard",
    isRetired: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

describe("who may read it", () => {
  it("is admin only", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    expect(await codeOf(() => run(ctx, {}))).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("counting a garden", () => {
  it("counts lots by the garden's DISPLAY name, which is what lots carry", async () => {
    // Same trap the map fell into: the registry stores
    // `name: "garden-of-faith"`, the lot stores
    // `section: "Garden of Faith"`.
    const { ctx } = makeCtx({
      sections: [section()],
      lots: [lot(), lot({ _id: "lots:a2", code: "A-02" })],
    });
    const p = await run(ctx, {});
    expect(p.sections[0].lotCount).toBe(2);
    expect(p.orphanSections).toEqual([]);
  });

  it("LISTS a garden that has no lots", async () => {
    // The whole reason this query exists rather than reusing the map's.
    // An empty garden is invisible on the map, so if it were invisible
    // here it would be the one nobody ever gets round to filling.
    const { ctx } = makeCtx({
      sections: [
        section(),
        section({
          _id: "sections:hope",
          name: "garden-of-hope",
          displayName: "Garden of Hope",
          sortOrder: 2,
        }),
      ],
      lots: [lot()],
    });
    const p = await run(ctx, {});
    expect(p.sections.map((s: { displayName: string }) => s.displayName)).toEqual([
      "Garden of Faith",
      "Garden of Hope",
    ]);
    expect(p.sections[1].lotCount).toBe(0);
  });

  it("reports a configured layout, and null when there is none", async () => {
    const { ctx } = makeCtx({
      sections: [
        section({ gridColumns: 6, gridRows: 5 }),
        section({
          _id: "sections:hope",
          name: "garden-of-hope",
          displayName: "Garden of Hope",
          sortOrder: 2,
        }),
      ],
    });
    const p = await run(ctx, {});
    expect(p.sections[0].gridColumns).toBe(6);
    expect(p.sections[0].gridRows).toBe(5);
    expect(p.sections[1].gridColumns).toBeNull();
    expect(p.totals.laidOutCount).toBe(1);
  });

  it("counts photographs and measured positions separately", async () => {
    const { ctx } = makeCtx({
      sections: [section()],
      lots: [
        lot({ photoStorageId: "_storage:p1" }),
        lot({
          _id: "lots:a2",
          code: "A-02",
          geometryStatus: "surveyed",
        }),
        lot({ _id: "lots:a3", code: "A-03" }),
      ],
    });
    const p = await run(ctx, {});
    expect(p.sections[0].lotCount).toBe(3);
    expect(p.sections[0].photoCount).toBe(1);
    expect(p.sections[0].surveyedCount).toBe(1);
    expect(p.totals.photoCount).toBe(1);
    expect(p.totals.surveyedCount).toBe(1);
  });

  it("leaves out retired lots and retired gardens", async () => {
    const { ctx } = makeCtx({
      sections: [
        section(),
        section({
          _id: "sections:old",
          name: "old-garden",
          displayName: "Old Garden",
          isRetired: true,
          sortOrder: 9,
        }),
      ],
      lots: [lot(), lot({ _id: "lots:x", code: "A-99", isRetired: true })],
    });
    const p = await run(ctx, {});
    expect(p.sections).toHaveLength(1);
    expect(p.sections[0].lotCount).toBe(1);
    expect(p.totals.sectionCount).toBe(1);
  });

  it("orders gardens the way every other screen does", async () => {
    const { ctx } = makeCtx({
      sections: [
        section({ _id: "sections:b", name: "b", displayName: "B", sortOrder: 20 }),
        section({ _id: "sections:a", name: "a", displayName: "A", sortOrder: 10 }),
      ],
    });
    const p = await run(ctx, {});
    expect(p.sections.map((s: { displayName: string }) => s.displayName)).toEqual([
      "A",
      "B",
    ]);
  });
});

describe("lots that belong to no garden", () => {
  it("REPORTS them rather than dropping them", async () => {
    // These lots are real. The map cannot draw them and the layout
    // control cannot reach them. Silence would mean the inventory count
    // and the map disagree with nothing anywhere to explain it.
    const { ctx } = makeCtx({
      sections: [section()],
      lots: [
        lot(),
        lot({ _id: "lots:z1", code: "Z-01", section: "Garden of Nowhere" }),
        lot({ _id: "lots:z2", code: "Z-02", section: "Garden of Nowhere" }),
      ],
    });
    const p = await run(ctx, {});
    expect(p.orphanSections).toEqual([
      { section: "Garden of Nowhere", lotCount: 2 },
    ]);
  });

  it("does not count an orphan toward any garden's total", async () => {
    const { ctx } = makeCtx({
      sections: [section()],
      lots: [lot({ section: "Typo of Faith" })],
    });
    const p = await run(ctx, {});
    expect(p.sections[0].lotCount).toBe(0);
    expect(p.totals.lotCount).toBe(0);
  });

  it("treats a retired garden's lots as orphaned, because the map drops them", async () => {
    // Retiring a garden with lots still in it is a real way to make
    // inventory vanish from the map. The walkthrough should say so.
    const { ctx } = makeCtx({
      sections: [section({ isRetired: true })],
      lots: [lot()],
    });
    const p = await run(ctx, {});
    expect(p.orphanSections).toEqual([
      { section: "Garden of Faith", lotCount: 1 },
    ]);
  });

  it("lists the biggest orphan group first", async () => {
    const { ctx } = makeCtx({
      sections: [],
      lots: [
        lot({ _id: "lots:1", section: "One" }),
        lot({ _id: "lots:2", section: "Many" }),
        lot({ _id: "lots:3", section: "Many" }),
      ],
    });
    const p = await run(ctx, {});
    expect(
      p.orphanSections.map((o: { section: string }) => o.section),
    ).toEqual(["Many", "One"]);
  });
});
