/**
 * Who may say where a lot is, and on what evidence.
 *
 * `geometryStatus: "surveyed"` was doing the work of three very
 * different claims — a measured outline from a survey file, a point
 * somebody clicked on a map, and a phone reading with metres of slop
 * round it. They render identically, so the map presented all three
 * with the same confidence.
 *
 * These tests are about keeping them apart, and about the one rule that
 * makes opening this up to field workers safe: a phone must never
 * overwrite a real survey. Nothing here throws by accident — the
 * failure is a measured corner silently downgraded to a guess, with no
 * way to tell afterwards that it happened.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

vi.mock("../../../convex/lib/audit", () => ({
  emitAudit: vi.fn(async () => undefined),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import {
  clearLotLocation,
  setLotLocation,
  MAX_GPS_ACCURACY_M,
} from "../../../convex/lots";
import { ErrorCode } from "../../../convex/lib/errors";
import { ConvexError, type Value } from "convex/values";
import type { ErrorPayload } from "../../../convex/lib/errors";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-11-01T10:00:00+08:00").getTime();
const CALLER_ID = "users:c1";
const SESSION_ID = "authSessions:s1";
const LOT_ID = "lots:a1";

// Aringay, La Union — inside the sanity range the mutation enforces.
const AT = { lat: 16.3959, lng: 120.3556 };

type Row = Record<string, unknown>;
type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

function makeCtx(opts: { roles?: RoleName[]; lot?: Row } = {}) {
  const lot: Row = {
    _id: LOT_ID,
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
    ...opts.lot,
  };

  const caller = {
    _id: CALLER_ID,
    _creationTime: T0,
    name: "Someone",
    email: "s@example.com",
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

  const patches: Row[] = [];
  const ctx = {
    db: {
      get: vi.fn(async (id: string) => {
        if (id === CALLER_ID) return caller;
        if (id === SESSION_ID) {
          return {
            _id: SESSION_ID,
            _creationTime: T0,
            userId: CALLER_ID,
            expirationTime: T0 + 30 * 24 * 3600 * 1000,
          };
        }
        if (id === LOT_ID) return lot;
        return null;
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return { withIndex: () => ({ collect: async () => userRoles }) };
        }
        return {
          withIndex: () => ({ collect: async () => [] }),
          collect: async () => [],
        };
      }),
      patch: vi.fn(async (_id: string, p: Row) => {
        patches.push(p);
      }),
      insert: vi.fn(async () => "audit:1"),
    },
  };

  return { ctx, patches };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerOf(fn: any): (ctx: unknown, args: unknown) => Promise<any> {
  for (const key of ["_handler", "handler", "invokeMutation"]) {
    const v = fn[key];
    if (typeof v === "function") return v as never;
  }
  if (typeof fn === "function") return fn as never;
  throw new Error("Cannot locate handler");
}

const run = handlerOf(setLotLocation);
const runClear = handlerOf(clearLotLocation);

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof ConvexError)) return undefined;
    return ((e as ConvexError<Value>).data as unknown as ErrorPayload)?.code;
  }
  return undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

describe("recording how a position was obtained", () => {
  it("marks a clicked point as clicked", async () => {
    const { ctx, patches } = makeCtx({ roles: ["office_staff"] });
    await run(ctx, { lotId: LOT_ID, ...AT });
    expect(patches[0]!.geometrySource).toBe("clicked");
    expect(patches[0]!.geometryStatus).toBe("surveyed");
  });

  it("marks a phone reading as gps, WITH its accuracy", async () => {
    // The accuracy is the difference between a position and a guess.
    // Storing the coordinate alone would lose that forever.
    const { ctx, patches } = makeCtx({ roles: ["field_worker"] });
    await run(ctx, { lotId: LOT_ID, ...AT, source: "gps", accuracyM: 6 });
    expect(patches[0]!.geometrySource).toBe("gps");
    expect(patches[0]!.geometryAccuracyM).toBe(6);
  });

  it("records when it was captured", async () => {
    const { ctx, patches } = makeCtx({ roles: ["office_staff"] });
    await run(ctx, { lotId: LOT_ID, ...AT });
    expect(patches[0]!.geometryCapturedAt).toBe(T0);
  });

  it("does not attach an accuracy to a clicked point", async () => {
    // A click has no accuracy to report, and inventing one would make
    // it look like a measurement.
    const { ctx, patches } = makeCtx({ roles: ["office_staff"] });
    await run(ctx, { lotId: LOT_ID, ...AT, accuracyM: 6 });
    expect(patches[0]!.geometryAccuracyM).toBeUndefined();
  });
});

describe("who may set a position", () => {
  it("lets a field worker capture one from a phone", async () => {
    // They are the people standing in the park. A position that has to
    // go through the office is a position nobody records.
    const { ctx, patches } = makeCtx({ roles: ["field_worker"] });
    await run(ctx, { lotId: LOT_ID, ...AT, source: "gps", accuracyM: 5 });
    expect(patches).toHaveLength(1);
  });

  it("does NOT let a field worker click a point on a map", async () => {
    // Clicking a map is not a thing done at the graveside; it is a
    // claim about somewhere you are not standing.
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    expect(await codeOf(() => run(ctx, { lotId: LOT_ID, ...AT }))).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  it("refuses a customer outright", async () => {
    const { ctx } = makeCtx({ roles: ["customer"] });
    expect(
      await codeOf(() =>
        run(ctx, { lotId: LOT_ID, ...AT, source: "gps", accuracyM: 5 }),
      ),
    ).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("a phone must not overwrite a survey", () => {
  it("refuses a field worker's reading over imported geometry", async () => {
    // An imported outline is measured shape at a measured angle. A GPS
    // point is a dot with metres of slop. Replacing the first with the
    // second loses what cannot be recovered — and looks identical
    // afterwards.
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      lot: { geometryStatus: "surveyed", geometrySource: "imported" },
    });
    expect(
      await codeOf(() =>
        run(ctx, { lotId: LOT_ID, ...AT, source: "gps", accuracyM: 4 }),
      ),
    ).toBe(ErrorCode.FORBIDDEN);
  });

  it("lets the office override an import deliberately", async () => {
    // Somebody has to be able to fix a bad import.
    const { ctx, patches } = makeCtx({
      roles: ["office_staff"],
      lot: { geometryStatus: "surveyed", geometrySource: "imported" },
    });
    await run(ctx, { lotId: LOT_ID, ...AT, source: "gps", accuracyM: 4 });
    expect(patches).toHaveLength(1);
  });

  it("lets a field worker replace their OWN earlier reading", async () => {
    // Re-capturing on a better day is the whole point of it being easy.
    const { ctx, patches } = makeCtx({
      roles: ["field_worker"],
      lot: { geometryStatus: "surveyed", geometrySource: "gps" },
    });
    await run(ctx, { lotId: LOT_ID, ...AT, source: "gps", accuracyM: 4 });
    expect(patches).toHaveLength(1);
  });
});

describe("how rough a reading may be", () => {
  it("refuses a reading past the usable limit", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    expect(
      await codeOf(() =>
        run(ctx, {
          lotId: LOT_ID,
          ...AT,
          source: "gps",
          accuracyM: MAX_GPS_ACCURACY_M + 1,
        }),
      ),
    ).toBe(ErrorCode.VALIDATION);
  });

  it("refuses a gps reading that reports NO accuracy", async () => {
    // The browser is not a trust boundary. A hand-made request with the
    // accuracy left off would otherwise save an unbounded guess.
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    expect(
      await codeOf(() =>
        run(ctx, { lotId: LOT_ID, ...AT, source: "gps" }),
      ),
    ).toBe(ErrorCode.VALIDATION);
  });

  it("refuses a nonsensical accuracy", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    expect(
      await codeOf(() =>
        run(ctx, { lotId: LOT_ID, ...AT, source: "gps", accuracyM: 0 }),
      ),
    ).toBe(ErrorCode.VALIDATION);
  });

  it("still refuses a point outside the cemetery entirely", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    expect(
      await codeOf(() => run(ctx, { lotId: LOT_ID, lat: 51.5, lng: -0.12 })),
    ).toBe(ErrorCode.VALIDATION);
  });
});

/**
 * Taking a position back.
 *
 * There was no way to do this at all. A bad import, a mis-click, a GPS
 * fix taken beside a wall — all permanent, because the only recourse
 * was to place the lot somewhere else, which replaces one assertion
 * with another rather than withdrawing the first.
 *
 * "Not surveyed" is a real state and a better one than a coordinate
 * nobody trusts: the map leaves the lot out and says how many it is not
 * showing, instead of drawing it confidently in the wrong place.
 */
describe("removing a position", () => {
  it("puts the lot back to not surveyed", async () => {
    const { ctx, patches } = makeCtx({
      roles: ["office_staff"],
      lot: {
        geometryStatus: "surveyed",
        geometrySource: "gps",
        geometryAccuracyM: 18,
      },
    });
    await runClear(ctx, { lotId: LOT_ID });
    expect(patches[0]!.geometryStatus).toBe("placeholder");
  });

  it("clears the CLAIM as well as the status", async () => {
    // A leftover source or accuracy would let a later reader conclude
    // the lot had been surveyed after all.
    const { ctx, patches } = makeCtx({
      roles: ["office_staff"],
      lot: {
        geometryStatus: "surveyed",
        geometrySource: "gps",
        geometryAccuracyM: 18,
        geometryCapturedAt: T0,
      },
    });
    await runClear(ctx, { lotId: LOT_ID });
    expect(patches[0]!.geometrySource).toBeUndefined();
    expect(patches[0]!.geometryAccuracyM).toBeUndefined();
    expect(patches[0]!.geometryCapturedAt).toBeUndefined();
  });

  it("leaves a stand-in centroid rather than nothing", async () => {
    // Geometry is required on the document; removing it outright would
    // break every reader that assumes it is there.
    const { ctx, patches } = makeCtx({
      roles: ["office_staff"],
      lot: { geometryStatus: "surveyed", geometrySource: "clicked" },
    });
    await runClear(ctx, { lotId: LOT_ID });
    expect(patches[0]!.geometry).toBeDefined();
  });

  it("refuses when there is no position to remove", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    expect(await codeOf(() => runClear(ctx, { lotId: LOT_ID }))).toBe(
      ErrorCode.VALIDATION,
    );
  });

  it("is office work, not field work", async () => {
    // A field worker who thinks their own reading was poor can take
    // another. Deciding the record should say "not surveyed" is a
    // different call.
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      lot: { geometryStatus: "surveyed", geometrySource: "gps" },
    });
    expect(await codeOf(() => runClear(ctx, { lotId: LOT_ID }))).toBe(
      ErrorCode.FORBIDDEN,
    );
  });
});
