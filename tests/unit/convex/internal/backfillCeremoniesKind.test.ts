/**
 * Story 7.5 — `convex/internal/backfillCeremoniesKind.ts` tests.
 *
 * Under Option B (parallel `ceremonies` table) the scan is a no-op
 * because every existing row was inserted with a valid `kind` field.
 * The test asserts (a) idempotency (running twice produces the same
 * result) and (b) the defensive patch path triggers when an old-shape
 * row without `kind` is present (forward-compat with the eventual
 * Option-A consolidation).
 */

import { describe, expect, it, vi } from "vitest";

import { run } from "../../../../convex/internal/backfillCeremoniesKind";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerOf(fn: any): (ctx: unknown, args: unknown) => Promise<unknown> {
  for (const key of ["_handler", "handler", "invokeMutation", "invokeQuery"]) {
    const v = fn[key];
    if (typeof v === "function") return v as never;
  }
  if (typeof fn === "function") return fn as never;
  throw new Error("Cannot locate handler on Convex function");
}

interface FakeRow {
  _id: string;
  kind?: string;
}

function makeCtx(rows: FakeRow[]) {
  const map = new Map<string, FakeRow>(rows.map((r) => [r._id, r]));
  return {
    db: {
      query: (table: string) => {
        if (table !== "ceremonies") {
          return { withIndex: () => ({ collect: async () => [] }) };
        }
        return {
          withIndex: () => ({
            collect: async () => Array.from(map.values()),
          }),
        };
      },
      patch: vi.fn(
        async (id: string, partial: Record<string, unknown>) => {
          const existing = map.get(id);
          if (existing === undefined) return null;
          map.set(id, { ...existing, ...(partial as Partial<FakeRow>) });
          return null;
        },
      ),
    },
  };
}

describe("backfillCeremoniesKind", () => {
  const exec = handlerOf(run);

  it("returns zeros on an empty table", async () => {
    const ctx = makeCtx([]);
    const result = (await exec(ctx, {})) as {
      scanned: number;
      patched: number;
      skipped: number;
    };
    expect(result.scanned).toBe(0);
    expect(result.patched).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("skips rows that already have a kind", async () => {
    const ctx = makeCtx([
      { _id: "ceremonies:1", kind: "consecration" },
      { _id: "ceremonies:2", kind: "interment" },
    ]);
    const result = (await exec(ctx, {})) as {
      scanned: number;
      patched: number;
      skipped: number;
    };
    expect(result.scanned).toBe(2);
    expect(result.patched).toBe(0);
    expect(result.skipped).toBe(2);
  });

  it("patches rows that are missing kind (defensive forward-compat)", async () => {
    const ctx = makeCtx([
      { _id: "ceremonies:bare" }, // no kind
      { _id: "ceremonies:typed", kind: "consecration" },
    ]);
    const result = (await exec(ctx, {})) as {
      scanned: number;
      patched: number;
      skipped: number;
    };
    expect(result.scanned).toBe(2);
    expect(result.patched).toBe(1);
    expect(result.skipped).toBe(1);
    expect(ctx.db.patch).toHaveBeenCalledWith(
      "ceremonies:bare",
      expect.objectContaining({
        kind: "interment",
        chapelReserved: false,
        pathwayReserved: false,
      }),
    );
  });

  it("is idempotent — second run patches zero", async () => {
    const ctx = makeCtx([
      { _id: "ceremonies:bare" },
      { _id: "ceremonies:typed", kind: "consecration" },
    ]);
    await exec(ctx, {});
    const second = (await exec(ctx, {})) as {
      scanned: number;
      patched: number;
      skipped: number;
    };
    expect(second.patched).toBe(0);
    expect(second.skipped).toBe(2);
  });
});
