/**
 * What the 3D map is allowed to ask the server for.
 *
 * `listLots` returns whole lot documents — every field, including the
 * `geometry` blob with its polygon array and four bounding-box numbers
 * — for every lot in the park. The map reads none of that. At two
 * thousand lots it shipped megabytes to draw a few hundred coloured
 * boxes, and the client did the arithmetic on top.
 *
 * So the first group of tests is about what the payload does NOT
 * contain. A field creeping back into it would not break anything
 * visibly; it would just make the map slow again, quietly, on somebody
 * else's connection.
 *
 * The second is about the layout being data, and about being honest
 * when it is a guess rather than a decision.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import {
  areaOf,
  deriveGrid,
  getMapLotDetail,
  listForMap,
  listSurveyedForMap,
  UNPLACED_SAMPLE_LIMIT,
} from "../../../convex/lots";
import { ErrorCode } from "../../../convex/lib/errors";
import { ConvexError, type Value } from "convex/values";
import type { ErrorPayload } from "../../../convex/lib/errors";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-11-01T10:00:00+08:00").getTime();
const CALLER_ID = "users:field1";
const SESSION_ID = "authSessions:s1";

type Row = Record<string, unknown>;
type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

function makeCtx(opts: {
  lots?: Row[];
  sections?: Row[];
  roles?: RoleName[];
}) {
  const t = {
    lots: opts.lots ?? [],
    sections: opts.sections ?? [],
  };

  const caller = {
    _id: CALLER_ID,
    _creationTime: T0,
    name: "Field",
    email: "f@example.com",
    isActive: true,
  };
  const userRoles = (opts.roles ?? ["field_worker"]).map((role, i) => ({
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
    storage: {
      getUrl: vi.fn(async (id: string) => `https://files.test/${id}`),
    },
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

const runMap = handlerOf(listForMap);
const runDetail = handlerOf(getMapLotDetail);
const runSurveyed = handlerOf(listSurveyedForMap);

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
    geometry: {
      centroid: { lat: 16.3, lng: 120.3 },
      polygon: [
        { lat: 16.3, lng: 120.3 },
        { lat: 16.3001, lng: 120.3 },
        { lat: 16.3001, lng: 120.3001 },
        { lat: 16.3, lng: 120.3001 },
      ],
      bboxMinLat: 16.3,
      bboxMaxLat: 16.3001,
      bboxMinLng: 120.3,
      bboxMaxLng: 120.3001,
    },
    geometryStatus: "placeholder",
    ...over,
  };
}

function section(over: Row = {}): Row {
  return {
    _id: "sections:faith",
    _creationTime: T0,
    name: "Garden of Faith",
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

// --- the payload -------------------------------------------------------

describe("what the map is sent", () => {
  it("NEVER ships the geometry blob", () => {
    // The whole point. A polygon per lot, times two thousand lots, to
    // draw boxes that are positioned on a grid.
    return (async () => {
      const { ctx } = makeCtx({ lots: [lot()] });
      const data = await runMap(ctx, {});
      const row = data.lots[0];
      expect(row.geometry).toBeUndefined();
      expect(row.polygon).toBeUndefined();
      expect(row.bboxMinLat).toBeUndefined();
    })();
  });

  it("ships exactly the fields the scene draws with", async () => {
    const { ctx } = makeCtx({ lots: [lot()] });
    const data = await runMap(ctx, {});
    expect(Object.keys(data.lots[0]).sort()).toEqual(
      [
        "_id",
        "areaSqm",
        "basePriceCents",
        "block",
        "code",
        "hasPhoto",
        "section",
        "status",
        "type",
      ].sort(),
    );
  });

  it("does the area arithmetic on the server", () => {
    // 2.5 × 1.2. The client should not be multiplying numbers it can be
    // handed, once per lot, on every render.
    return (async () => {
      const { ctx } = makeCtx({ lots: [lot()] });
      const data = await runMap(ctx, {});
      expect(data.lots[0].areaSqm).toBe(3);
    })();
  });

  it("says whether a photograph exists without fetching its URL", async () => {
    // A signed URL per lot for the whole park would undo the point of
    // the light list. The flag is enough to draw a marker.
    const { ctx } = makeCtx({
      lots: [lot({ photoStorageId: "_storage:p1" })],
    });
    const data = await runMap(ctx, {});
    expect(data.lots[0].hasPhoto).toBe(true);
    expect(data.lots[0].photoUrl).toBeUndefined();
    expect(ctx.storage.getUrl).not.toHaveBeenCalled();
  });

  it("leaves out retired lots", async () => {
    const { ctx } = makeCtx({ lots: [lot(), lot({ _id: "lots:x", isRetired: true })] });
    expect((await runMap(ctx, {})).lots).toHaveLength(1);
  });

  it("draws only the gardens asked for", async () => {
    const { ctx } = makeCtx({
      lots: [lot(), lot({ _id: "lots:b", section: "Garden of Hope" })],
    });
    const data = await runMap(ctx, { sectionNames: ["Garden of Hope"] });
    expect(data.lots).toHaveLength(1);
    expect(data.sections.map((s: { name: string }) => s.name)).toEqual([
      "Garden of Hope",
    ]);
  });

  it("orders lots by code, because that IS the layout order", async () => {
    // The grid fills from this list, so the sort is the arrangement on
    // screen rather than a cosmetic detail.
    const { ctx } = makeCtx({
      lots: [
        lot({ _id: "lots:c", code: "A-03" }),
        lot({ _id: "lots:a", code: "A-01" }),
        lot({ _id: "lots:b", code: "A-02" }),
      ],
    });
    const data = await runMap(ctx, {});
    expect(data.lots.map((l: { code: string }) => l.code)).toEqual([
      "A-01",
      "A-02",
      "A-03",
    ]);
  });
});

// --- the layout --------------------------------------------------------

describe("how a garden is laid out", () => {
  it("uses the grid somebody configured", async () => {
    const { ctx } = makeCtx({
      lots: [lot()],
      sections: [section({ gridColumns: 6, gridRows: 5 })],
    });
    const s = (await runMap(ctx, {})).sections[0];
    expect(s.columns).toBe(6);
    expect(s.rows).toBe(5);
    expect(s.layoutIsDerived).toBe(false);
  });

  it("guesses a square-ish grid when nobody has", async () => {
    // Drawing a garden in a sensible shape beats drawing nothing while
    // somebody goes and configures it.
    const { ctx } = makeCtx({
      lots: Array.from({ length: 10 }, (_, i) =>
        lot({ _id: `lots:${i}`, code: `A-${i}` }),
      ),
      sections: [section()],
    });
    const s = (await runMap(ctx, {})).sections[0];
    expect(s.columns).toBe(4);
    expect(s.rows).toBe(3);
  });

  it("SAYS when the layout is a guess", async () => {
    // A layout nobody chose must not be mistaken for one somebody did —
    // otherwise the map quietly asserts a shape the park never agreed.
    const { ctx } = makeCtx({ lots: [lot()], sections: [section()] });
    expect((await runMap(ctx, {})).sections[0].layoutIsDerived).toBe(true);
  });

  it("still draws a garden with no entry in the registry", async () => {
    const { ctx } = makeCtx({ lots: [lot()], sections: [] });
    const s = (await runMap(ctx, {})).sections[0];
    expect(s.name).toBe("Garden of Faith");
    expect(s.layoutIsDerived).toBe(true);
  });

  it("matches a garden on its DISPLAY name, which is what lots carry", async () => {
    // The bug this was written for. The seed writes
    // `sections.name: "garden-of-peace"` and
    // `lots.section: "Garden of Peace"`. Keying the lookup on `name`
    // alone matched nothing, so every garden reported its layout as
    // guessed and configuring one appeared to do nothing at all.
    const { ctx } = makeCtx({
      lots: [lot({ section: "Garden of Peace" })],
      sections: [
        section({
          name: "garden-of-peace",
          displayName: "Garden of Peace",
          gridColumns: 6,
          gridRows: 5,
        }),
      ],
    });
    const s = (await runMap(ctx, {})).sections[0];
    expect(s.columns).toBe(6);
    expect(s.rows).toBe(5);
    expect(s.layoutIsDerived).toBe(false);
    expect(s.displayName).toBe("Garden of Peace");
  });

  it("still matches when the registry uses the display form as its name", async () => {
    const { ctx } = makeCtx({
      lots: [lot({ section: "Garden of Faith" })],
      sections: [
        section({
          name: "Garden of Faith",
          displayName: "Garden of Faith",
          gridColumns: 4,
          gridRows: 4,
        }),
      ],
    });
    expect((await runMap(ctx, {})).sections[0].columns).toBe(4);
  });

  it("ignores a retired section's configured grid", async () => {
    const { ctx } = makeCtx({
      lots: [lot()],
      sections: [section({ isRetired: true, gridColumns: 9, gridRows: 9 })],
    });
    expect((await runMap(ctx, {})).sections[0].columns).not.toBe(9);
  });

  it("counts the lots in each garden", async () => {
    const { ctx } = makeCtx({
      lots: [lot(), lot({ _id: "lots:b", code: "A-02" })],
      sections: [section()],
    });
    expect((await runMap(ctx, {})).sections[0].lotCount).toBe(2);
  });
});

describe("deriveGrid", () => {
  it("is square-ish", () => {
    expect(deriveGrid(25)).toEqual({ columns: 5, rows: 5 });
    expect(deriveGrid(30)).toEqual({ columns: 6, rows: 5 });
  });

  it("never returns zero of anything", () => {
    // A grid of zero columns draws nothing and divides by zero on the
    // way there.
    expect(deriveGrid(0)).toEqual({ columns: 1, rows: 1 });
    expect(deriveGrid(-5)).toEqual({ columns: 1, rows: 1 });
  });

  it("always holds every lot", () => {
    for (const n of [1, 7, 13, 28, 99, 401]) {
      const g = deriveGrid(n);
      expect(g.columns * g.rows).toBeGreaterThanOrEqual(n);
    }
  });
});

describe("areaOf", () => {
  it("multiplies width by depth", () => {
    expect(areaOf({ widthM: 2.5, depthM: 1.2 })).toBe(3);
  });

  it("rounds to one decimal", () => {
    expect(areaOf({ widthM: 1.11, depthM: 1.11 })).toBe(1.2);
  });

  it("survives nonsense without producing NaN", () => {
    expect(areaOf({ widthM: Number.NaN, depthM: 2 })).toBe(0);
  });
});

// --- the detail --------------------------------------------------------

describe("one lot, when somebody clicks it", () => {
  it("carries the size and the photograph", async () => {
    const { ctx } = makeCtx({
      lots: [lot({ photoStorageId: "_storage:p1", photoUpdatedAt: T0 })],
    });
    const d = await runDetail(ctx, { lotId: "lots:a1" });
    expect(d.areaSqm).toBe(3);
    expect(d.widthM).toBe(2.5);
    expect(d.photoUrl).toBe("https://files.test/_storage:p1");
  });

  it("REFUSES to report a placeholder centroid as a location", async () => {
    // A placeholder is a stand-in written at lot creation, not a
    // position anybody measured. Reporting it would send somebody to
    // the wrong part of the park with confidence.
    const { ctx } = makeCtx({ lots: [lot({ geometryStatus: "placeholder" })] });
    const d = await runDetail(ctx, { lotId: "lots:a1" });
    expect(d.lat).toBeNull();
    expect(d.lng).toBeNull();
    expect(d.geometryStatus).toBe("placeholder");
  });

  it("gives the coordinates once a lot has actually been surveyed", async () => {
    const { ctx } = makeCtx({ lots: [lot({ geometryStatus: "surveyed" })] });
    const d = await runDetail(ctx, { lotId: "lots:a1" });
    expect(d.lat).toBe(16.3);
    expect(d.lng).toBe(120.3);
  });

  it("returns null for a lot that is not there", async () => {
    const { ctx } = makeCtx({ lots: [] });
    expect(await runDetail(ctx, { lotId: "lots:ghost" })).toBeNull();
  });
});

describe("who may read the map", () => {
  it("lets a field worker — finding a grave is their job", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"], lots: [lot()] });
    await expect(runMap(ctx, {})).resolves.toBeDefined();
  });

  it("refuses a customer", async () => {
    const { ctx } = makeCtx({ roles: ["customer"], lots: [lot()] });
    expect(await codeOf(() => runMap(ctx, {}))).toBe(ErrorCode.FORBIDDEN);
  });
});

// --- drawing the park as it actually is --------------------------------

/**
 * A grid cannot draw an irregular garden honestly, so the other path is
 * the measured one: `/admin/gps-import` writes real polygons and flips
 * a lot to `surveyed`.
 *
 * The failure that matters here is not an exception. Every lot is
 * created with a PLACEHOLDER centroid pointing at the middle of the
 * park. Drawing on those would pile the whole cemetery into one heap at
 * the centre and present it as a survey — tidy, confident, and wrong.
 */
describe("the surveyed map", () => {
  it("draws only lots somebody actually measured", () => {
    return (async () => {
      const { ctx } = makeCtx({
        lots: [
          lot({ geometryStatus: "surveyed" }),
          lot({ _id: "lots:b", code: "A-02" }), // placeholder
        ],
      });
      const data = await runSurveyed(ctx, {});
      expect(data.lots).toHaveLength(1);
      expect(data.lots[0].code).toBe("A-01");
    })();
  });

  it("ships the measured outline, not just the centre", async () => {
    // The outline is what makes an angled or irregular garden draw
    // true. A centre alone can only ever produce a north-aligned box.
    const { ctx } = makeCtx({
      lots: [lot({ geometryStatus: "surveyed" })],
    });
    const data = await runSurveyed(ctx, {});
    expect(data.lots[0].polygon).toHaveLength(4);
    expect(data.lots[0].lat).toBe(16.3);
    expect(data.lots[0].lng).toBe(120.3);
  });

  it("counts what is placed and what is not, per garden", async () => {
    const { ctx } = makeCtx({
      lots: [
        lot({ geometryStatus: "surveyed" }),
        lot({ _id: "lots:b", code: "A-02" }),
        lot({ _id: "lots:c", code: "A-03" }),
      ],
      sections: [section()],
    });
    const s = (await runSurveyed(ctx, {})).sections[0];
    expect(s.placedCount).toBe(1);
    expect(s.unplacedCount).toBe(2);
    expect(s.displayName).toBe("Garden of Faith");
  });

  it("NAMES a few unplaced lots, and caps the list", async () => {
    // "412 lots unplaced" is a number somebody skims. Four codes they
    // can go and look for is a number they act on — and shipping all
    // 412 strings to make that point would be the same waste the light
    // list exists to avoid.
    const many = Array.from({ length: 20 }, (_, i) =>
      lot({ _id: `lots:u${i}`, code: `U-${i}` }),
    );
    const { ctx } = makeCtx({ lots: many });
    const s = (await runSurveyed(ctx, {})).sections[0];
    expect(s.unplacedCount).toBe(20);
    expect(s.unplacedSample).toHaveLength(UNPLACED_SAMPLE_LIMIT);
  });

  it("centres the scene on what was measured", async () => {
    // Not on the park bounding box: that includes ground nobody has
    // surveyed, and would push the drawn lots off to one side.
    const { ctx } = makeCtx({
      lots: [
        lot({ geometryStatus: "surveyed" }),
        lot({
          _id: "lots:b",
          code: "A-02",
          geometryStatus: "surveyed",
          geometry: {
            centroid: { lat: 16.4, lng: 120.4 },
            polygon: [],
            bboxMinLat: 16.4,
            bboxMaxLat: 16.4,
            bboxMinLng: 120.4,
            bboxMaxLng: 120.4,
          },
        }),
      ],
    });
    const { origin } = await runSurveyed(ctx, {});
    expect(origin?.lat).toBeCloseTo(16.35, 6);
    expect(origin?.lng).toBeCloseTo(120.35, 6);
  });

  it("has no origin when nothing is measured", async () => {
    const { ctx } = makeCtx({ lots: [lot()] });
    const data = await runSurveyed(ctx, {});
    expect(data.origin).toBeNull();
    expect(data.lots).toEqual([]);
  });

  it("still reports gardens that have nothing placed at all", async () => {
    // Otherwise the survey view is silently short a whole garden and
    // looks complete.
    const { ctx } = makeCtx({
      lots: [lot({ section: "Garden of Hope" })],
      sections: [section({ name: "Garden of Hope", displayName: "Garden of Hope" })],
    });
    const s = (await runSurveyed(ctx, {})).sections[0];
    expect(s.placedCount).toBe(0);
    expect(s.unplacedCount).toBe(1);
  });

  it("treats a surveyed status with no centroid as unplaced", async () => {
    // A half-written geometry record should not become a lot drawn at
    // the scene origin.
    const { ctx } = makeCtx({
      lots: [lot({ geometryStatus: "surveyed", geometry: undefined })],
    });
    const data = await runSurveyed(ctx, {});
    expect(data.lots).toEqual([]);
    expect(data.sections[0].unplacedCount).toBe(1);
  });

  it("leaves out retired lots", async () => {
    const { ctx } = makeCtx({
      lots: [
        lot({ geometryStatus: "surveyed" }),
        lot({ _id: "lots:x", code: "A-99", geometryStatus: "surveyed", isRetired: true }),
      ],
    });
    expect((await runSurveyed(ctx, {})).lots).toHaveLength(1);
  });

  it("draws only the gardens asked for", async () => {
    const { ctx } = makeCtx({
      lots: [
        lot({ geometryStatus: "surveyed" }),
        lot({ _id: "lots:b", code: "B-01", section: "Garden of Hope", geometryStatus: "surveyed" }),
      ],
    });
    const data = await runSurveyed(ctx, { sectionNames: ["Garden of Hope"] });
    expect(data.lots).toHaveLength(1);
    expect(data.lots[0].section).toBe("Garden of Hope");
  });

  it("lets a field worker read it", async () => {
    // Finding a grave on the ground is their job more than anybody's,
    // and this is the view that says where it actually is.
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      lots: [lot({ geometryStatus: "surveyed" })],
    });
    expect((await runSurveyed(ctx, {})).lots).toHaveLength(1);
  });

  it("refuses a customer", async () => {
    const { ctx } = makeCtx({ roles: ["customer"] });
    expect(await codeOf(() => runSurveyed(ctx, {}))).toBe(ErrorCode.FORBIDDEN);
  });
});
