/**
 * Story 7.5 — `convex/lib/scheduling.ts` unit tests.
 *
 * Covers the three conflict axes plus the half-open back-to-back
 * no-conflict invariant and the cross-table (ceremonies + interments)
 * lot-overlap detection.
 */

import { ConvexError, type Value } from "convex/values";
import { describe, expect, it } from "vitest";

import { ErrorCode, type ErrorPayload } from "../../../../convex/lib/errors";
import { MINUTE_MS } from "../../../../convex/lib/time";
import {
  assertNoBookingConflict,
  INTERMENT_LEGACY_DURATION_MINUTES,
} from "../../../../convex/lib/scheduling";

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();

interface CeremonyRow {
  _id: string;
  lotId: string;
  scheduledAt: number;
  durationMinutes: number;
  chapelReserved: boolean;
  pathwayReserved: boolean;
  status: "scheduled" | "completed" | "cancelled";
}

interface IntermentRow {
  _id: string;
  lotId: string;
  scheduledAt: number;
  status: "scheduled" | "completed" | "cancelled";
  // Story 7.5 H4 fix (adversarial review) — additive optional flags
  // mirroring the new schema columns. Tests that omit them simulate
  // legacy interment rows (undefined → coerced to false in the mapper).
  chapelReserved?: boolean;
  pathwayReserved?: boolean;
}

interface FakeCtxOpts {
  ceremonies?: CeremonyRow[];
  interments?: IntermentRow[];
}

function makeCtx(opts: FakeCtxOpts = {}) {
  const ceremonies = opts.ceremonies ?? [];
  const interments = opts.interments ?? [];

  interface IndexQuery {
    eq(field: string, value: unknown): IndexQuery;
    gte(field: string, value: unknown): IndexQuery;
    lte(field: string, value: unknown): IndexQuery;
    gt(field: string, value: unknown): IndexQuery;
    lt(field: string, value: unknown): IndexQuery;
  }

  function makeBuilder<T>(rows: T[]) {
    type Predicate = (r: T) => boolean;
    const predicates: Predicate[] = [];
    const builder = {
      withIndex(_name: string, fn?: (q: IndexQuery) => IndexQuery) {
        if (fn === undefined) return builder;
        const q: IndexQuery = {
          eq(field: string, value: unknown) {
            predicates.push(
              (r) =>
                (r as unknown as Record<string, unknown>)[field] === value,
            );
            return q;
          },
          gte(field: string, value: unknown) {
            predicates.push((r) => {
              const v = (r as unknown as Record<string, unknown>)[field];
              return typeof v === "number" && v >= (value as number);
            });
            return q;
          },
          lte(field: string, value: unknown) {
            predicates.push((r) => {
              const v = (r as unknown as Record<string, unknown>)[field];
              return typeof v === "number" && v <= (value as number);
            });
            return q;
          },
          gt(field: string, value: unknown) {
            predicates.push((r) => {
              const v = (r as unknown as Record<string, unknown>)[field];
              return typeof v === "number" && v > (value as number);
            });
            return q;
          },
          lt(field: string, value: unknown) {
            predicates.push((r) => {
              const v = (r as unknown as Record<string, unknown>)[field];
              return typeof v === "number" && v < (value as number);
            });
            return q;
          },
        };
        fn(q);
        return builder;
      },
      async collect() {
        return rows.filter((r) => predicates.every((p) => p(r)));
      },
    };
    return builder;
  }

  return {
    db: {
      query: (table: string) => {
        if (table === "ceremonies") return makeBuilder(ceremonies);
        if (table === "interments") return makeBuilder(interments);
        return {
          withIndex: () => ({ collect: async () => [] }),
        };
      },
    },
  };
}

function getCode(thrown: unknown): string | undefined {
  if (!(thrown instanceof ConvexError)) return undefined;
  const data = (thrown as ConvexError<Value>).data as unknown as ErrorPayload;
  return data?.code;
}

function getDetails(thrown: unknown): Record<string, unknown> | undefined {
  if (!(thrown instanceof ConvexError)) return undefined;
  const data = (thrown as ConvexError<Value>).data as unknown as ErrorPayload;
  return data?.details as Record<string, unknown> | undefined;
}

describe("assertNoBookingConflict", () => {
  it("passes when the schedule is clear", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = makeCtx() as any;
    await expect(
      assertNoBookingConflict(ctx, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lotId: "lots:1" as any,
        scheduledAt: T0,
        durationMinutes: 90,
        chapelReserved: false,
        pathwayReserved: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects bad scheduledAt", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = makeCtx() as any;
    try {
      await assertNoBookingConflict(ctx, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lotId: "lots:1" as any,
        scheduledAt: -1,
        durationMinutes: 90,
        chapelReserved: false,
        pathwayReserved: false,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.VALIDATION);
    }
  });

  it("rejects bad durationMinutes", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = makeCtx() as any;
    try {
      await assertNoBookingConflict(ctx, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lotId: "lots:1" as any,
        scheduledAt: T0,
        durationMinutes: 1000,
        chapelReserved: false,
        pathwayReserved: false,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.VALIDATION);
    }
  });

  it("flags same-lot overlap (kind-agnostic)", async () => {
    const ctx = makeCtx({
      ceremonies: [
        {
          _id: "ceremonies:a",
          lotId: "lots:1",
          scheduledAt: T0 + 30 * MINUTE_MS,
          durationMinutes: 60,
          chapelReserved: false,
          pathwayReserved: false,
          status: "scheduled",
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    try {
      await assertNoBookingConflict(ctx, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lotId: "lots:1" as any,
        scheduledAt: T0,
        durationMinutes: 60,
        chapelReserved: false,
        pathwayReserved: false,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.SCHEDULING_CONFLICT);
      expect(getDetails(e)?.resource).toBe("lot");
    }
  });

  it("does NOT conflict when windows are back-to-back (half-open)", async () => {
    const ctx = makeCtx({
      ceremonies: [
        {
          _id: "ceremonies:a",
          lotId: "lots:1",
          scheduledAt: T0 + 60 * MINUTE_MS,
          durationMinutes: 60,
          chapelReserved: false,
          pathwayReserved: false,
          status: "scheduled",
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    await expect(
      assertNoBookingConflict(ctx, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lotId: "lots:1" as any,
        scheduledAt: T0,
        durationMinutes: 60,
        chapelReserved: false,
        pathwayReserved: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("flags chapel overlap on different lots when both reserve", async () => {
    const ctx = makeCtx({
      ceremonies: [
        {
          _id: "ceremonies:a",
          lotId: "lots:other",
          scheduledAt: T0 + 15 * MINUTE_MS,
          durationMinutes: 90,
          chapelReserved: true,
          pathwayReserved: false,
          status: "scheduled",
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    try {
      await assertNoBookingConflict(ctx, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lotId: "lots:1" as any,
        scheduledAt: T0,
        durationMinutes: 90,
        chapelReserved: true,
        pathwayReserved: false,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.SCHEDULING_CONFLICT);
      expect(getDetails(e)?.resource).toBe("chapel");
    }
  });

  it("does NOT conflict when only one side reserves chapel", async () => {
    const ctx = makeCtx({
      ceremonies: [
        {
          _id: "ceremonies:a",
          lotId: "lots:other",
          scheduledAt: T0 + 15 * MINUTE_MS,
          durationMinutes: 90,
          chapelReserved: false,
          pathwayReserved: false,
          status: "scheduled",
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    await expect(
      assertNoBookingConflict(ctx, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lotId: "lots:1" as any,
        scheduledAt: T0,
        durationMinutes: 90,
        chapelReserved: true,
        pathwayReserved: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("flags pathway overlap on different lots when both reserve", async () => {
    const ctx = makeCtx({
      ceremonies: [
        {
          _id: "ceremonies:a",
          lotId: "lots:other",
          scheduledAt: T0 + 15 * MINUTE_MS,
          durationMinutes: 90,
          chapelReserved: false,
          pathwayReserved: true,
          status: "scheduled",
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    try {
      await assertNoBookingConflict(ctx, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lotId: "lots:1" as any,
        scheduledAt: T0,
        durationMinutes: 90,
        chapelReserved: false,
        pathwayReserved: true,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.SCHEDULING_CONFLICT);
      expect(getDetails(e)?.resource).toBe("pathway");
    }
  });

  it("ignores cancelled rows", async () => {
    const ctx = makeCtx({
      ceremonies: [
        {
          _id: "ceremonies:a",
          lotId: "lots:1",
          scheduledAt: T0 + 30 * MINUTE_MS,
          durationMinutes: 60,
          chapelReserved: true,
          pathwayReserved: true,
          status: "cancelled",
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    await expect(
      assertNoBookingConflict(ctx, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lotId: "lots:1" as any,
        scheduledAt: T0,
        durationMinutes: 60,
        chapelReserved: true,
        pathwayReserved: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("detects same-lot conflict from the legacy interments table", async () => {
    const ctx = makeCtx({
      interments: [
        {
          _id: "interments:legacy",
          lotId: "lots:1",
          scheduledAt: T0 + 15 * MINUTE_MS,
          status: "scheduled",
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    try {
      await assertNoBookingConflict(ctx, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lotId: "lots:1" as any,
        scheduledAt: T0,
        durationMinutes: 60,
        chapelReserved: false,
        pathwayReserved: false,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.SCHEDULING_CONFLICT);
      expect(getDetails(e)?.resource).toBe("lot");
    }
    // Sanity check the legacy duration constant is in the right ballpark.
    expect(INTERMENT_LEGACY_DURATION_MINUTES).toBe(60);
  });

  // ---------------------------------------------------------------
  // Story 7.5 H4 fix — chapel / pathway conflict regression tests.
  //
  // Before the fix the interment-row mapper hard-coded
  // `chapelReserved: false, pathwayReserved: false`, so a chapel-bound
  // interment could NOT collide with a chapel-bound ceremony. These
  // tests pin the new mapper behaviour:
  //   - ceremony vs. ceremony, both chapel = conflict
  //   - ceremony vs. interment with chapelReserved=true = conflict
  //   - ceremony vs. legacy interment (field absent) = NO conflict (back-compat)
  // ...mirror set for pathway.
  // ---------------------------------------------------------------
  it("flags chapel conflict between two ceremonies on different lots", async () => {
    const ctx = makeCtx({
      ceremonies: [
        {
          _id: "ceremonies:a",
          lotId: "lots:other",
          scheduledAt: T0 + 15 * MINUTE_MS,
          durationMinutes: 90,
          chapelReserved: true,
          pathwayReserved: false,
          status: "scheduled",
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    try {
      await assertNoBookingConflict(ctx, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lotId: "lots:1" as any,
        scheduledAt: T0,
        durationMinutes: 90,
        chapelReserved: true,
        pathwayReserved: false,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.SCHEDULING_CONFLICT);
      expect(getDetails(e)?.resource).toBe("chapel");
    }
  });

  it("flags chapel conflict between a ceremony and a chapel-bound interment", async () => {
    const ctx = makeCtx({
      interments: [
        {
          _id: "interments:chapelBound",
          lotId: "lots:other",
          scheduledAt: T0 + 15 * MINUTE_MS,
          status: "scheduled",
          chapelReserved: true,
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    try {
      await assertNoBookingConflict(ctx, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lotId: "lots:1" as any,
        scheduledAt: T0,
        durationMinutes: 60,
        chapelReserved: true,
        pathwayReserved: false,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.SCHEDULING_CONFLICT);
      expect(getDetails(e)?.resource).toBe("chapel");
      const ids = getDetails(e)?.conflictingIds as string[];
      expect(ids).toContain("interments:chapelBound");
    }
  });

  it("does NOT flag chapel conflict for a legacy interment lacking the field (back-compat)", async () => {
    const ctx = makeCtx({
      interments: [
        {
          _id: "interments:legacy",
          lotId: "lots:other",
          scheduledAt: T0 + 15 * MINUTE_MS,
          status: "scheduled",
          // `chapelReserved` deliberately omitted — simulates a pre-fix
          // legacy row. Mapper must coerce undefined → false.
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    await expect(
      assertNoBookingConflict(ctx, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lotId: "lots:1" as any,
        scheduledAt: T0,
        durationMinutes: 60,
        chapelReserved: true,
        pathwayReserved: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("flags pathway conflict between two ceremonies on different lots", async () => {
    const ctx = makeCtx({
      ceremonies: [
        {
          _id: "ceremonies:a",
          lotId: "lots:other",
          scheduledAt: T0 + 15 * MINUTE_MS,
          durationMinutes: 90,
          chapelReserved: false,
          pathwayReserved: true,
          status: "scheduled",
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    try {
      await assertNoBookingConflict(ctx, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lotId: "lots:1" as any,
        scheduledAt: T0,
        durationMinutes: 90,
        chapelReserved: false,
        pathwayReserved: true,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.SCHEDULING_CONFLICT);
      expect(getDetails(e)?.resource).toBe("pathway");
    }
  });

  it("flags pathway conflict between a ceremony and a pathway-bound interment", async () => {
    const ctx = makeCtx({
      interments: [
        {
          _id: "interments:pathBound",
          lotId: "lots:other",
          scheduledAt: T0 + 15 * MINUTE_MS,
          status: "scheduled",
          pathwayReserved: true,
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    try {
      await assertNoBookingConflict(ctx, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lotId: "lots:1" as any,
        scheduledAt: T0,
        durationMinutes: 60,
        chapelReserved: false,
        pathwayReserved: true,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(getCode(e)).toBe(ErrorCode.SCHEDULING_CONFLICT);
      expect(getDetails(e)?.resource).toBe("pathway");
      const ids = getDetails(e)?.conflictingIds as string[];
      expect(ids).toContain("interments:pathBound");
    }
  });

  it("does NOT flag pathway conflict for a legacy interment lacking the field (back-compat)", async () => {
    const ctx = makeCtx({
      interments: [
        {
          _id: "interments:legacy",
          lotId: "lots:other",
          scheduledAt: T0 + 15 * MINUTE_MS,
          status: "scheduled",
          // `pathwayReserved` deliberately omitted.
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    await expect(
      assertNoBookingConflict(ctx, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lotId: "lots:1" as any,
        scheduledAt: T0,
        durationMinutes: 60,
        chapelReserved: false,
        pathwayReserved: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("excludes the row when excludeCeremonyId matches", async () => {
    const ctx = makeCtx({
      ceremonies: [
        {
          _id: "ceremonies:self",
          lotId: "lots:1",
          scheduledAt: T0,
          durationMinutes: 60,
          chapelReserved: true,
          pathwayReserved: false,
          status: "scheduled",
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    await expect(
      assertNoBookingConflict(ctx, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lotId: "lots:1" as any,
        scheduledAt: T0,
        durationMinutes: 60,
        chapelReserved: true,
        pathwayReserved: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        excludeCeremonyId: "ceremonies:self" as any,
      }),
    ).resolves.toBeUndefined();
  });
});
