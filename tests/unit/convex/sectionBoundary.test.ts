/**
 * A garden's edges.
 *
 * The cemetery map showed lots floating in an empty field — coloured
 * squares with nothing to say where a garden begins, where it ends, or
 * that they belong together at all.
 *
 * The outline is traced, never derived. A hull around four placed lots
 * out of eighty is a confident drawing of the wrong shape, and the whole
 * point of an irregular park is that its edges are not implied by its
 * contents. So the rules here are about refusing a shape that is not
 * one, rather than inventing a shape from whatever is nearby.
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
  clearSectionBoundary,
  listSectionBoundaries,
  setSectionBoundary,
} from "../../../convex/sections";
import { ErrorCode } from "../../../convex/lib/errors";
import { ConvexError, type Value } from "convex/values";
import type { ErrorPayload } from "../../../convex/lib/errors";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-11-01T10:00:00+08:00").getTime();
const CALLER_ID = "users:c1";
const SESSION_ID = "authSessions:s1";
const SEC_ID = "sections:faith";

// Aringay, La Union.
const AT = { lat: 16.3959, lng: 120.3556 };
const SQUARE = [
  { lat: AT.lat, lng: AT.lng },
  { lat: AT.lat + 0.0004, lng: AT.lng },
  { lat: AT.lat + 0.0004, lng: AT.lng + 0.0004 },
  { lat: AT.lat, lng: AT.lng + 0.0004 },
];

type Row = Record<string, unknown>;
type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

function makeCtx(opts: { roles?: RoleName[]; sections?: Row[] } = {}) {
  const sections = opts.sections ?? [
    {
      _id: SEC_ID,
      _creationTime: T0,
      name: "garden-of-faith",
      displayName: "Garden of Faith",
      sortOrder: 1,
      kind: "standard",
      isRetired: false,
    },
  ];

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
        return sections.find((s) => s["_id"] === id) ?? null;
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return { withIndex: () => ({ collect: async () => userRoles }) };
        }
        if (table === "sections") {
          return {
            withIndex: () => ({ collect: async () => sections }),
            collect: async () => sections,
          };
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
  for (const key of ["_handler", "handler", "invokeMutation", "invokeQuery"]) {
    const v = fn[key];
    if (typeof v === "function") return v as never;
  }
  if (typeof fn === "function") return fn as never;
  throw new Error("Cannot locate handler");
}

const runSet = handlerOf(setSectionBoundary);
const runClear = handlerOf(clearSectionBoundary);
const runList = handlerOf(listSectionBoundaries);

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

describe("tracing an outline", () => {
  it("saves the corners in the order they were traced", async () => {
    // Order IS the shape. Sorting or de-duplicating them would turn a
    // traced outline into a different polygon.
    const { ctx, patches } = makeCtx();
    await runSet(ctx, { sectionId: SEC_ID, boundary: SQUARE });
    expect(patches[0]!.boundary).toEqual(SQUARE);
    expect(patches[0]!.boundaryUpdatedAt).toBe(T0);
  });

  it("refuses two points, which are a line and not an area", async () => {
    const { ctx } = makeCtx();
    expect(
      await codeOf(() =>
        runSet(ctx, { sectionId: SEC_ID, boundary: SQUARE.slice(0, 2) }),
      ),
    ).toBe(ErrorCode.VALIDATION);
  });

  it("refuses a corner outside the cemetery entirely", async () => {
    // Refuses rather than clamps: a corner in the wrong province is a
    // mistake somebody should see, not a point to quietly move.
    const { ctx } = makeCtx();
    expect(
      await codeOf(() =>
        runSet(ctx, {
          sectionId: SEC_ID,
          boundary: [...SQUARE.slice(0, 3), { lat: 51.5, lng: -0.12 }],
        }),
      ),
    ).toBe(ErrorCode.VALIDATION);
  });

  it("refuses an outline with absurdly many corners", async () => {
    // The map redraws every one of them on every pan.
    const { ctx } = makeCtx();
    const many = Array.from({ length: 500 }, (_, i) => ({
      lat: AT.lat + i * 0.000001,
      lng: AT.lng,
    }));
    expect(
      await codeOf(() => runSet(ctx, { sectionId: SEC_ID, boundary: many })),
    ).toBe(ErrorCode.VALIDATION);
  });

  it("is admin work", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    expect(
      await codeOf(() => runSet(ctx, { sectionId: SEC_ID, boundary: SQUARE })),
    ).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("removing an outline", () => {
  it("clears the shape and its timestamp together", async () => {
    const { ctx, patches } = makeCtx({
      sections: [
        {
          _id: SEC_ID,
          _creationTime: T0,
          name: "garden-of-faith",
          displayName: "Garden of Faith",
          sortOrder: 1,
          kind: "standard",
          isRetired: false,
          boundary: SQUARE,
          boundaryUpdatedAt: T0,
        },
      ],
    });
    await runClear(ctx, { sectionId: SEC_ID });
    expect(patches[0]!.boundary).toBeUndefined();
    expect(patches[0]!.boundaryUpdatedAt).toBeUndefined();
  });

  it("refuses when there is nothing traced", async () => {
    const { ctx } = makeCtx();
    expect(await codeOf(() => runClear(ctx, { sectionId: SEC_ID }))).toBe(
      ErrorCode.VALIDATION,
    );
  });
});

describe("what the map is given", () => {
  it("lists only gardens that have been traced", async () => {
    // A garden with no outline has no shape to draw. Returning it with
    // an empty array would make the map draw a degenerate polygon.
    const { ctx } = makeCtx({
      sections: [
        {
          _id: SEC_ID,
          name: "garden-of-faith",
          displayName: "Garden of Faith",
          sortOrder: 1,
          kind: "standard",
          isRetired: false,
          boundary: SQUARE,
        },
        {
          _id: "sections:hope",
          name: "garden-of-hope",
          displayName: "Garden of Hope",
          sortOrder: 2,
          kind: "standard",
          isRetired: false,
        },
      ],
    });
    const out = await runList(ctx, {});
    expect(out).toHaveLength(1);
    expect(out[0].displayName).toBe("Garden of Faith");
  });

  it("leaves out retired gardens", async () => {
    const { ctx } = makeCtx({
      sections: [
        {
          _id: SEC_ID,
          name: "old",
          displayName: "Old Garden",
          sortOrder: 1,
          kind: "standard",
          isRetired: true,
          boundary: SQUARE,
        },
      ],
    });
    expect(await runList(ctx, {})).toEqual([]);
  });

  it("lets a field worker see the gardens", async () => {
    // Finding a grave on the ground is their job, and the outline is
    // most of what makes the map legible.
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      sections: [
        {
          _id: SEC_ID,
          name: "garden-of-faith",
          displayName: "Garden of Faith",
          sortOrder: 1,
          kind: "standard",
          isRetired: false,
          boundary: SQUARE,
        },
      ],
    });
    expect(await runList(ctx, {})).toHaveLength(1);
  });
});
