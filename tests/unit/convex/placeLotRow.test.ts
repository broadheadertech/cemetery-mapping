/**
 * Placing a whole row of lots from one drawn line.
 *
 * This is the only tool that scales to a park: two clicks place twenty
 * graves. Which also means one bad call writes twenty wrong positions
 * at once, and every one of them lands looking exactly as confident as
 * a surveyed corner.
 *
 * So the guards are about refusing to write rather than about the
 * arithmetic, which lives in `convex/lib/rowLayout.ts` and is checked
 * against metres there.
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
import { placeLotRow } from "../../../convex/lots";
import { ErrorCode } from "../../../convex/lib/errors";
import { ConvexError, type Value } from "convex/values";
import type { ErrorPayload } from "../../../convex/lib/errors";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-11-01T10:00:00+08:00").getTime();
const CALLER_ID = "users:c1";
const SESSION_ID = "authSessions:s1";

const START = { lat: 16.3959, lng: 120.3556 };
const END = { lat: 16.3959, lng: 120.3559 };

type Row = Record<string, unknown>;
type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

function lot(id: string, over: Row = {}): Row {
  return {
    _id: id,
    _creationTime: T0,
    code: id.replace("lots:", "A-1-"),
    section: "Garden of Faith",
    block: "1",
    row: "01",
    type: "single",
    status: "available",
    isRetired: false,
    basePriceCents: 100_000_00,
    dimensions: { widthM: 2.5, depthM: 1.2 },
    geometryStatus: "placeholder",
    ...over,
  };
}

function makeCtx(opts: { roles?: RoleName[]; lots?: Row[] } = {}) {
  const lots = opts.lots ?? [lot("lots:1"), lot("lots:2"), lot("lots:3")];

  const caller = {
    _id: CALLER_ID,
    _creationTime: T0,
    name: "Office",
    email: "o@example.com",
    isActive: true,
  };
  const userRoles = (opts.roles ?? ["office_staff"]).map((role, i) => ({
    _id: `userRoles:r${i}`,
    _creationTime: T0,
    userId: CALLER_ID,
    role,
    grantedAt: T0,
    grantedBy: CALLER_ID,
  }));

  mockedGetAuthUserId.mockResolvedValue(CALLER_ID as never);
  mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);

  const patches: Array<{ id: string; patch: Row }> = [];
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
        return lots.find((l) => l["_id"] === id) ?? null;
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
      patch: vi.fn(async (id: string, patch: Row) => {
        patches.push({ id, patch });
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

const run = handlerOf(placeLotRow);

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

describe("placing a row", () => {
  it("places every lot given, in the order given", async () => {
    // Order IS the row. Sorting them here would put the graves in a
    // different sequence from the one drawn on screen.
    const { ctx, patches } = makeCtx();
    const res = await run(ctx, {
      lotIds: ["lots:1", "lots:2", "lots:3"],
      start: START,
      end: END,
    });
    expect(res.placed).toBe(3);
    expect(patches.map((p) => p.id)).toEqual(["lots:1", "lots:2", "lots:3"]);
  });

  it("marks them DRAWN, not surveyed by hand or by phone", async () => {
    // A drawn row has a real bearing and real widths, but nobody stood
    // at any of these plots. Recording it as a GPS capture or an import
    // would overstate what happened.
    const { ctx, patches } = makeCtx();
    await run(ctx, { lotIds: ["lots:1"], start: START, end: END });
    expect(patches[0]!.patch.geometrySource).toBe("drawn");
    expect(patches[0]!.patch.geometryStatus).toBe("surveyed");
    expect(patches[0]!.patch.geometryAccuracyM).toBeUndefined();
  });

  it("gives each lot its own footprint, not one shared shape", async () => {
    const { ctx, patches } = makeCtx();
    await run(ctx, { lotIds: ["lots:1", "lots:2"], start: START, end: END });
    const a = patches[0]!.patch.geometry as { centroid: { lng: number } };
    const b = patches[1]!.patch.geometry as { centroid: { lng: number } };
    expect(a.centroid.lng).not.toBe(b.centroid.lng);
  });

  it("records when the row was drawn", async () => {
    const { ctx, patches } = makeCtx();
    await run(ctx, { lotIds: ["lots:1"], start: START, end: END });
    expect(patches[0]!.patch.geometryCapturedAt).toBe(T0);
  });
});

describe("refusing to write", () => {
  it("refuses an empty row", async () => {
    const { ctx } = makeCtx();
    expect(
      await codeOf(() => run(ctx, { lotIds: [], start: START, end: END })),
    ).toBe(ErrorCode.VALIDATION);
  });

  it("refuses the same lot twice in one row", async () => {
    // It would be placed at two positions, and another lot would go
    // silently unplaced while the count still looked right.
    const { ctx } = makeCtx();
    expect(
      await codeOf(() =>
        run(ctx, { lotIds: ["lots:1", "lots:1"], start: START, end: END }),
      ),
    ).toBe(ErrorCode.VALIDATION);
  });

  it("refuses a line drawn outside the cemetery", async () => {
    const { ctx } = makeCtx();
    expect(
      await codeOf(() =>
        run(ctx, {
          lotIds: ["lots:1"],
          start: START,
          end: { lat: 51.5, lng: -0.12 },
        }),
      ),
    ).toBe(ErrorCode.VALIDATION);
  });

  it("refuses a retired lot rather than quietly skipping it", async () => {
    // Skipping would shift every following lot one place up the row.
    const { ctx } = makeCtx({
      lots: [lot("lots:1"), lot("lots:2", { isRetired: true })],
    });
    expect(
      await codeOf(() =>
        run(ctx, { lotIds: ["lots:1", "lots:2"], start: START, end: END }),
      ),
    ).toBe(ErrorCode.VALIDATION);
  });

  it("refuses a lot that is not there", async () => {
    const { ctx } = makeCtx();
    expect(
      await codeOf(() =>
        run(ctx, { lotIds: ["lots:gone"], start: START, end: END }),
      ),
    ).toBe(ErrorCode.NOT_FOUND);
  });

  it("writes NOTHING when one lot in the row is bad", async () => {
    // The whole row is one act. A partial write leaves half a row
    // placed and no record of where it stopped.
    const { ctx, patches } = makeCtx({
      lots: [lot("lots:1"), lot("lots:2", { isRetired: true })],
    });
    await codeOf(() =>
      run(ctx, { lotIds: ["lots:1", "lots:2"], start: START, end: END }),
    );
    expect(patches).toHaveLength(0);
  });

  it("refuses a row longer than a row", async () => {
    const { ctx } = makeCtx({
      lots: Array.from({ length: 300 }, (_, i) => lot(`lots:${i}`)),
    });
    expect(
      await codeOf(() =>
        run(ctx, {
          lotIds: Array.from({ length: 300 }, (_, i) => `lots:${i}`),
          start: START,
          end: END,
        }),
      ),
    ).toBe(ErrorCode.VALIDATION);
  });

  it("is not field work", async () => {
    // Drawing a row is a claim about ground the drawer is not standing
    // on. A field worker's tool is the phone at the graveside.
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    expect(
      await codeOf(() => run(ctx, { lotIds: ["lots:1"], start: START, end: END })),
    ).toBe(ErrorCode.FORBIDDEN);
  });
});
