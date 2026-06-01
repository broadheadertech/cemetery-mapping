/**
 * Story 3.1 — Receipt counter unit tests.
 *
 * Coverage target: 100% line + branch on `convex/lib/receiptCounter.ts`
 * (NFR-M2 — cornerstone financial primitive; no gaps tolerated).
 *
 * Strategy: hand-mocked ctx (mirroring `audit.test.ts` / `auth.test.ts` /
 * `lots.test.ts`). `convex-test` requires `convex/_generated/` which this
 * repo deliberately doesn't have until the operator runs `npx convex
 * dev`. The hand-mocked ctx exercises the exact code paths that
 * `convex-test` would, with the additional ability to inject an
 * optimistic-concurrency conflict via mock overrides — something
 * `convex-test`'s harness doesn't expose directly.
 *
 * Concurrency framing:
 *   Within a single Convex mutation, `ctx.db.query("receiptCounter").first()`
 *   + `ctx.db.patch(...)` is atomic — Convex serialises the mutation as
 *   a transaction. The "concurrency" risk arises ACROSS mutations:
 *   mutation A reads currentSerial = 5, mutation B (running in parallel
 *   on the same row) also reads 5, both patch to 6 — that's where
 *   Convex's per-document OCC retries the loser. The harness here
 *   simulates the same behavior by exposing `simulateConflict()`, which
 *   has the loser's patch throw a ConflictError on first call and
 *   succeed on retry. The tests verify:
 *     1. Sequential allocations are gap-free (1..N).
 *     2. The allocator's read-then-patch shape is correct (re-reading
 *        after a simulated conflict produces the post-winner state).
 *     3. The void-doesn't-decrement invariant — sequential allocations
 *        after a "voided" placeholder receipt continue past the void.
 */

import { ConvexError, type Value } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCode, type ErrorPayload } from "../../../../convex/lib/errors";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import {
  allocateNextSerial,
  formatSerial,
  seedReceiptCounter,
} from "../../../../convex/lib/receiptCounter";
import { _testAllocate } from "../../../../convex/lib/receiptCounterTesting";

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const COUNTER_ID = "receiptCounter:row1";

interface CounterFixture {
  _id: string;
  _creationTime: number;
  currentSerial: number;
  startingSerial: number;
  prefix: string;
  seededAt: number;
  seededBy?: string;
}

interface FakeReceipt {
  _id: string;
  serial: number;
  formatted: string;
  isVoided: boolean;
}

interface CtxBag {
  rows: CounterFixture[];
  fakeReceipts: FakeReceipt[];
  patches: Array<{ id: string; patch: Record<string, unknown> }>;
  inserts: Array<{ table: string; row: Record<string, unknown> }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

interface CtxOptions {
  initialRows?: CounterFixture[];
  /**
   * If set, the FIRST patch call on the counter row throws a synthetic
   * ConvexError simulating a Convex OCC conflict. Subsequent calls
   * succeed normally. The allocator's caller (postFinancialEvent, in
   * production) re-runs the entire mutation; the test harness simulates
   * that by exposing `retryAfterConflict()` on the returned bag.
   */
  simulateConflictOnFirstPatch?: boolean;
}

function makeCtx(opts: CtxOptions = {}): CtxBag {
  const rows: CounterFixture[] = (opts.initialRows ?? []).map((r) => ({
    ...r,
  }));
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const fakeReceipts: FakeReceipt[] = [];
  let conflictPending = opts.simulateConflictOnFirstPatch === true;

  const ctx = {
    db: {
      query: vi.fn((table: string) => {
        if (table !== "receiptCounter") {
          throw new Error(
            `Mock ctx: unexpected query on table "${table}" — the only ` +
              `table this helper touches is receiptCounter.`,
          );
        }
        const builder = {
          async first(): Promise<CounterFixture | null> {
            return rows[0] ?? null;
          },
          async collect(): Promise<CounterFixture[]> {
            return [...rows];
          },
        };
        return builder;
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "receiptCounter") {
          const id = COUNTER_ID;
          rows.push({
            _id: id,
            _creationTime: T0,
            ...(row as Omit<CounterFixture, "_id" | "_creationTime">),
          });
          inserts.push({ table, row });
          return id;
        }
        inserts.push({ table, row });
        return `${table}:fake`;
      }),
      patch: vi.fn(
        async (id: string, patch: Record<string, unknown>): Promise<void> => {
          if (conflictPending) {
            conflictPending = false;
            throw new ConvexError({
              code: "OCC_CONFLICT_SIMULATED",
              message:
                "Synthetic OCC conflict — Convex's runtime would retry the mutation.",
            });
          }
          patches.push({ id, patch });
          const row = rows.find((r) => r._id === id);
          if (row !== undefined) {
            Object.assign(row, patch);
          }
        },
      ),
      get: vi.fn(async (id: string) => {
        return rows.find((r) => r._id === id) ?? null;
      }),
    },
  };

  return { rows, fakeReceipts, patches, inserts, ctx };
}

function expectConvexErrorCode(promise: Promise<unknown>, code: string) {
  return expect(promise).rejects.toMatchObject({ data: { code } });
}

// Convex's registered functions wrap the user-supplied handler in a
// small adapter. The original handler is exposed under one of a few
// property names depending on the Convex version; we iterate the
// candidates the same way `lots.test.ts` does. Falls back to invoking
// the registration directly if the wrapper exposes the call signature.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerOf(fn: any): (ctx: unknown, args: unknown) => Promise<unknown> {
  for (const key of ["_handler", "handler", "invokeMutation", "invokeQuery"]) {
    const v = fn[key];
    if (typeof v === "function") return v as never;
  }
  if (typeof fn === "function") return fn as never;
  throw new Error("Cannot locate handler on Convex function");
}

function getSeedHandler() {
  return handlerOf(seedReceiptCounter);
}

function getTestAllocateHandler() {
  return handlerOf(_testAllocate);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatSerial", () => {
  it("pads to 7 digits with leading zeros", () => {
    expect(formatSerial("OR-", 1)).toBe("OR-0000001");
  });

  it("pads at the maximum 7-digit boundary", () => {
    expect(formatSerial("OR-", 9999999)).toBe("OR-9999999");
  });

  it("does NOT truncate when the integer exceeds 7 digits", () => {
    // Story 3.1's pad-width is a minimum, not a maximum. If we ever
    // cross 9,999,999 the format widens — widening is non-breaking
    // because downstream code reads the formatted field directly.
    expect(formatSerial("OR-", 10000000)).toBe("OR-10000000");
  });

  it("handles an empty prefix (cemeteries on BIR variants with no leading code)", () => {
    expect(formatSerial("", 42)).toBe("0000042");
  });

  it("uses the configured prefix verbatim", () => {
    expect(formatSerial("AR-", 7)).toBe("AR-0000007");
  });
});

describe("seedReceiptCounter — happy path", () => {
  it("inserts the single row when the table is empty", async () => {
    const { ctx, rows, inserts } = makeCtx({});
    const handler = getSeedHandler();
    const result = await handler(ctx, { startingSerial: 0, prefix: "OR-" });
    expect(result).toEqual({ alreadySeeded: false, currentSerial: 0 });
    expect(rows).toHaveLength(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.table).toBe("receiptCounter");
    expect(inserts[0]!.row).toMatchObject({
      currentSerial: 0,
      startingSerial: 0,
      prefix: "OR-",
      seededAt: T0,
    });
    // seededBy intentionally omitted from internal-mutation seeds
    expect("seededBy" in inserts[0]!.row).toBe(false);
  });

  it("accepts startingSerial > 0 (BIR-registered non-zero start)", async () => {
    const { ctx, rows } = makeCtx({});
    const handler = getSeedHandler();
    await handler(ctx, { startingSerial: 100, prefix: "OR-" });
    expect(rows[0]!.currentSerial).toBe(100);
    expect(rows[0]!.startingSerial).toBe(100);
  });

  it("accepts an empty prefix", async () => {
    const { ctx, rows } = makeCtx({});
    const handler = getSeedHandler();
    await handler(ctx, { startingSerial: 0, prefix: "" });
    expect(rows[0]!.prefix).toBe("");
  });

  it("accepts BIR-style multi-segment prefix like 'AR-2026-'", async () => {
    const { ctx, rows } = makeCtx({});
    const handler = getSeedHandler();
    await handler(ctx, { startingSerial: 0, prefix: "AR-2026-" });
    expect(rows[0]!.prefix).toBe("AR-2026-");
  });
});

describe("seedReceiptCounter — idempotency invariant (AC1)", () => {
  it("is a no-op on the second call; the first row's values stick", async () => {
    const { ctx, rows, inserts } = makeCtx({});
    const handler = getSeedHandler();
    await handler(ctx, { startingSerial: 100, prefix: "OR-" });
    const second = await handler(ctx, {
      startingSerial: 999,
      prefix: "X-",
    });
    expect(second).toEqual({ alreadySeeded: true, currentSerial: 100 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.currentSerial).toBe(100);
    expect(rows[0]!.prefix).toBe("OR-");
    expect(rows[0]!.startingSerial).toBe(100);
    // Only one insert happened.
    expect(inserts).toHaveLength(1);
  });

  it("reflects post-allocation currentSerial on the idempotent return", async () => {
    const { ctx } = makeCtx({});
    const seed = getSeedHandler();
    await seed(ctx, { startingSerial: 5, prefix: "OR-" });
    // Burn a few serials to advance currentSerial past startingSerial.
    await allocateNextSerial(ctx);
    await allocateNextSerial(ctx);
    const idempotent = await seed(ctx, { startingSerial: 999, prefix: "X-" });
    expect(idempotent).toEqual({ alreadySeeded: true, currentSerial: 7 });
  });
});

describe("seedReceiptCounter — validation", () => {
  it("throws INVARIANT_VIOLATION when startingSerial is negative", async () => {
    const { ctx } = makeCtx({});
    const handler = getSeedHandler();
    await expectConvexErrorCode(
      handler(ctx, { startingSerial: -1, prefix: "OR-" }),
      ErrorCode.INVARIANT_VIOLATION,
    );
  });

  it("throws INVARIANT_VIOLATION when startingSerial is a non-integer", async () => {
    const { ctx } = makeCtx({});
    const handler = getSeedHandler();
    await expectConvexErrorCode(
      handler(ctx, { startingSerial: 1.5, prefix: "OR-" }),
      ErrorCode.INVARIANT_VIOLATION,
    );
  });

  it("throws INVARIANT_VIOLATION when startingSerial is NaN", async () => {
    const { ctx } = makeCtx({});
    const handler = getSeedHandler();
    await expectConvexErrorCode(
      handler(ctx, { startingSerial: Number.NaN, prefix: "OR-" }),
      ErrorCode.INVARIANT_VIOLATION,
    );
  });

  it("throws INVARIANT_VIOLATION on a lowercase prefix", async () => {
    const { ctx } = makeCtx({});
    const handler = getSeedHandler();
    await expectConvexErrorCode(
      handler(ctx, { startingSerial: 0, prefix: "or-" }),
      ErrorCode.INVARIANT_VIOLATION,
    );
  });

  it("throws INVARIANT_VIOLATION on a prefix with disallowed characters", async () => {
    const { ctx } = makeCtx({});
    const handler = getSeedHandler();
    await expectConvexErrorCode(
      handler(ctx, { startingSerial: 0, prefix: "OR_" }), // underscore not in allowlist
      ErrorCode.INVARIANT_VIOLATION,
    );
  });

  it("throws INVARIANT_VIOLATION on an over-long prefix (>10 chars)", async () => {
    const { ctx } = makeCtx({});
    const handler = getSeedHandler();
    await expectConvexErrorCode(
      handler(ctx, { startingSerial: 0, prefix: "ABCDEFGHIJK" }),
      ErrorCode.INVARIANT_VIOLATION,
    );
  });

  it("attaches the invalid input to error details for diagnostics", async () => {
    const { ctx } = makeCtx({});
    const handler = getSeedHandler();
    const err = await handler(ctx, {
      startingSerial: -5,
      prefix: "OR-",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConvexError);
    const data = (err as ConvexError<Value>).data as unknown as ErrorPayload;
    expect(data.code).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(data.details).toMatchObject({ startingSerial: -5 });
  });

  it("does NOT insert a row when validation fails", async () => {
    const { ctx, rows } = makeCtx({});
    const handler = getSeedHandler();
    await handler(ctx, { startingSerial: -1, prefix: "OR-" }).catch(
      () => undefined,
    );
    expect(rows).toHaveLength(0);
  });
});

describe("allocateNextSerial — happy path (AC2)", () => {
  function seededCtx(overrides: Partial<CounterFixture> = {}) {
    const counter: CounterFixture = {
      _id: COUNTER_ID,
      _creationTime: T0,
      currentSerial: 0,
      startingSerial: 0,
      prefix: "OR-",
      seededAt: T0,
      ...overrides,
    };
    return makeCtx({ initialRows: [counter] });
  }

  it("returns serial=1 on the very first allocation against a fresh seed", async () => {
    const { ctx, rows, patches } = seededCtx();
    const result = await allocateNextSerial(ctx);
    expect(result).toEqual({ serial: 1, formatted: "OR-0000001" });
    expect(rows[0]!.currentSerial).toBe(1);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({
      id: COUNTER_ID,
      patch: { currentSerial: 1 },
    });
  });

  it("increments from a non-zero starting serial", async () => {
    const { ctx } = seededCtx({ currentSerial: 1234, startingSerial: 1234 });
    const result = await allocateNextSerial(ctx);
    expect(result).toEqual({ serial: 1235, formatted: "OR-0001235" });
  });

  it("uses the configured prefix in the formatted output", async () => {
    const { ctx } = seededCtx({ prefix: "AR-" });
    const result = await allocateNextSerial(ctx);
    expect(result.formatted).toBe("AR-0000001");
  });

  it("uses ctx.db.patch (not replace) so other fields are preserved", async () => {
    const { ctx, rows } = seededCtx({
      currentSerial: 99,
      startingSerial: 0,
      prefix: "OR-",
    });
    await allocateNextSerial(ctx);
    // Patch is targeted — startingSerial / prefix / seededAt untouched.
    expect(rows[0]!.startingSerial).toBe(0);
    expect(rows[0]!.prefix).toBe("OR-");
    expect(rows[0]!.seededAt).toBe(T0);
  });
});

describe("allocateNextSerial — error paths", () => {
  it("throws INVARIANT_VIOLATION when the counter row is missing", async () => {
    const { ctx } = makeCtx({ initialRows: [] });
    await expectConvexErrorCode(
      allocateNextSerial(ctx),
      ErrorCode.INVARIANT_VIOLATION,
    );
  });

  it("throws INVARIANT_VIOLATION when currentSerial is a non-integer (data corruption)", async () => {
    const { ctx } = makeCtx({
      initialRows: [
        {
          _id: COUNTER_ID,
          _creationTime: T0,
          currentSerial: 1.5 as unknown as number,
          startingSerial: 0,
          prefix: "OR-",
          seededAt: T0,
        },
      ],
    });
    await expectConvexErrorCode(
      allocateNextSerial(ctx),
      ErrorCode.INVARIANT_VIOLATION,
    );
  });

  it("does NOT patch the row when validation fails", async () => {
    const { ctx, patches } = makeCtx({ initialRows: [] });
    await allocateNextSerial(ctx).catch(() => undefined);
    expect(patches).toHaveLength(0);
  });

  it("includes a helpful error message when the row is missing", async () => {
    const { ctx } = makeCtx({ initialRows: [] });
    const err = await allocateNextSerial(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConvexError);
    const data = (err as ConvexError<Value>).data as unknown as ErrorPayload;
    expect(data.message).toMatch(/seed it before issuing receipts/i);
  });
});

describe("allocateNextSerial — gap-free guarantee (AC3)", () => {
  it("produces strictly sequential serials across 100 sequential allocations", async () => {
    const { ctx, rows } = makeCtx({
      initialRows: [
        {
          _id: COUNTER_ID,
          _creationTime: T0,
          currentSerial: 0,
          startingSerial: 0,
          prefix: "OR-",
          seededAt: T0,
        },
      ],
    });
    const serials: number[] = [];
    for (let i = 0; i < 100; i++) {
      const r = await allocateNextSerial(ctx);
      serials.push(r.serial);
    }
    // No duplicates, no gaps — exactly [1..100].
    expect(serials).toHaveLength(100);
    expect(new Set(serials).size).toBe(100);
    expect(serials).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(rows[0]!.currentSerial).toBe(100);
  });

  it("produces the same gap-free sequence when invoked via the test wrapper", async () => {
    // The test wrapper is the surface convex-test will drive in a
    // follow-up environment where `_generated/` exists. Exercising
    // the wrapper here confirms it forwards correctly and that the
    // post-_generated migration path keeps the contract.
    const { ctx, rows } = makeCtx({
      initialRows: [
        {
          _id: COUNTER_ID,
          _creationTime: T0,
          currentSerial: 50,
          startingSerial: 50,
          prefix: "OR-",
          seededAt: T0,
        },
      ],
    });
    const handler = getTestAllocateHandler();
    const out = await handler(ctx, {});
    expect(out).toEqual({ serial: 51, formatted: "OR-0000051" });
    expect(rows[0]!.currentSerial).toBe(51);
  });

  it("100 concurrent allocations via Promise.all + OCC retry produce 100 distinct, gap-free serials", async () => {
    // Epic-3/4 adversarial-review HIGH fix: the prior coverage burned
    // 100 SEQUENTIAL allocations against a single shared ctx — which
    // doesn't actually exercise the concurrency claim in the
    // architecture doc ("Convex's per-document OCC serialises
    // concurrent mutations at the row level; the loser is transparently
    // retried by the runtime, producing strictly sequential serials
    // without duplicates or gaps").
    //
    // This test builds a CONCURRENT-FAITHFUL mock: each in-flight
    // allocation captures the `currentSerial` it read at the time of
    // its `.first()` call. On patch, the mock checks the row's
    // `currentSerial` against the captured value and throws a synthetic
    // conflict if another mutation has since landed. The wrapper
    // retries the loser, mimicking Convex's runtime behaviour.
    //
    // Promise.all over 100 such calls + interleaved scheduling via
    // microtask boundaries reliably triggers many cross-call conflicts
    // (verified by counting retries). The invariant the test asserts
    // is the production-relevant one: 100 distinct serials, no gaps,
    // no duplicates, and the final `currentSerial` equals 100.

    interface OccRow {
      _id: string;
      _creationTime: number;
      currentSerial: number;
      startingSerial: number;
      prefix: string;
      seededAt: number;
    }
    const row: OccRow = {
      _id: COUNTER_ID,
      _creationTime: T0,
      currentSerial: 0,
      startingSerial: 0,
      prefix: "OR-",
      seededAt: T0,
    };
    let retryCount = 0;

    // Per-call transaction context. Each `allocateNextSerial` invocation
    // receives its own ctx so the captured-currentSerial bookkeeping
    // is isolated between in-flight transactions (mirrors Convex's
    // per-mutation transaction scope).
    function makeOccCtx() {
      let snapshotSerial: number | null = null;
      return {
        db: {
          query: vi.fn((table: string) => {
            if (table !== "receiptCounter") {
              throw new Error(`unexpected table ${table}`);
            }
            return {
              async first(): Promise<OccRow | null> {
                // Yield to the scheduler so other in-flight transactions
                // can interleave their reads/patches and trigger the
                // OCC conflict path. Without this, JS's single-threaded
                // event-loop would serialise the awaits trivially and
                // no conflict would ever fire.
                await new Promise<void>((resolve) =>
                  queueMicrotask(resolve),
                );
                snapshotSerial = row.currentSerial;
                return { ...row };
              },
              async collect(): Promise<OccRow[]> {
                return [{ ...row }];
              },
            };
          }),
          patch: vi.fn(
            async (
              id: string,
              patch: Record<string, unknown>,
            ): Promise<void> => {
              // Yield once more before applying — gives interleaved
              // transactions another chance to overlap.
              await new Promise<void>((resolve) =>
                queueMicrotask(resolve),
              );
              if (id !== COUNTER_ID) {
                throw new Error(`unexpected patch id ${id}`);
              }
              if (snapshotSerial === null) {
                throw new Error("patch without preceding read");
              }
              if (row.currentSerial !== snapshotSerial) {
                // Stale write — another mutation has incremented
                // currentSerial between our read and our patch. Throw
                // a synthetic OCC conflict; the caller retries.
                throw new ConvexError({
                  code: "OCC_CONFLICT_SIMULATED",
                  message:
                    "Concurrent receiptCounter patch — runtime would retry the mutation.",
                });
              }
              Object.assign(row, patch);
            },
          ),
        },
      };
    }

    // Retry wrapper — mirrors what the Convex runtime does for a
    // mutation that hits an OCC conflict. The wrapper re-invokes
    // `allocateNextSerial` with a fresh ctx until it succeeds.
    async function allocateWithRetry(): Promise<{
      serial: number;
      formatted: string;
    }> {
      for (let attempt = 0; attempt < 1000; attempt++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctx = makeOccCtx() as any;
        try {
          return await allocateNextSerial(ctx);
        } catch (e: unknown) {
          if (
            e instanceof ConvexError &&
            (e.data as { code?: string } | null)?.code ===
              "OCC_CONFLICT_SIMULATED"
          ) {
            retryCount += 1;
            continue;
          }
          throw e;
        }
      }
      throw new Error("retry loop exhausted (this is a test-harness bug)");
    }

    const results = await Promise.all(
      Array.from({ length: 100 }, () => allocateWithRetry()),
    );
    const serials = results.map((r) => r.serial).sort((a, b) => a - b);
    expect(serials).toHaveLength(100);
    expect(new Set(serials).size).toBe(100); // distinct
    expect(serials).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(row.currentSerial).toBe(100);
    // Sanity — the test actually exercises the OCC retry path. A zero
    // retry count would mean the harness didn't induce any conflicts
    // and the test is effectively still sequential.
    expect(retryCount).toBeGreaterThan(0);
  });

  it("preserves the gap-free invariant when an OCC conflict forces a retry", async () => {
    // Simulate the Convex runtime's per-document OCC: the FIRST patch
    // throws a synthetic conflict; the calling mutation (here, the
    // test) re-runs the read+patch, which now succeeds. The resulting
    // serial is what the second-attempt mutation would have produced —
    // never a duplicate, never a gap.
    const { ctx, rows } = makeCtx({
      initialRows: [
        {
          _id: COUNTER_ID,
          _creationTime: T0,
          currentSerial: 10,
          startingSerial: 0,
          prefix: "OR-",
          seededAt: T0,
        },
      ],
      simulateConflictOnFirstPatch: true,
    });
    // First call hits the synthetic conflict.
    await expect(allocateNextSerial(ctx)).rejects.toMatchObject({
      data: { code: "OCC_CONFLICT_SIMULATED" },
    });
    // The row is UNCHANGED by the failed patch — that's the OCC
    // guarantee. The retry sees currentSerial=10 still.
    expect(rows[0]!.currentSerial).toBe(10);
    // Retry — succeeds, produces serial 11.
    const retry = await allocateNextSerial(ctx);
    expect(retry).toEqual({ serial: 11, formatted: "OR-0000011" });
    expect(rows[0]!.currentSerial).toBe(11);
  });
});

describe("allocateNextSerial — void-doesn't-decrement invariant (AC4)", () => {
  it("subsequent allocation is N+1 even after the serial-N receipt was voided", async () => {
    const { ctx, fakeReceipts, rows } = makeCtx({
      initialRows: [
        {
          _id: COUNTER_ID,
          _creationTime: T0,
          currentSerial: 0,
          startingSerial: 0,
          prefix: "OR-",
          seededAt: T0,
        },
      ],
    });

    // Allocate serial 1, 2, 3.
    const r1 = await allocateNextSerial(ctx);
    const r2 = await allocateNextSerial(ctx);
    const r3 = await allocateNextSerial(ctx);
    fakeReceipts.push(
      { _id: "receipts:1", serial: r1.serial, formatted: r1.formatted, isVoided: false },
      { _id: "receipts:2", serial: r2.serial, formatted: r2.formatted, isVoided: false },
      { _id: "receipts:3", serial: r3.serial, formatted: r3.formatted, isVoided: false },
    );

    // Simulate the Story 3.12 void path: flag receipt-2 as voided.
    // The void workflow does NOT decrement the counter.
    const voidedReceipt = fakeReceipts.find((r) => r.serial === r2.serial)!;
    voidedReceipt.isVoided = true;

    // Next allocation = 4, NOT 2.
    const r4 = await allocateNextSerial(ctx);
    expect(r4).toEqual({ serial: 4, formatted: "OR-0000004" });
    expect(rows[0]!.currentSerial).toBe(4);

    // The voided receipt still carries its original serial — the
    // serial is "consumed" forever.
    expect(voidedReceipt.serial).toBe(2);
    expect(voidedReceipt.isVoided).toBe(true);
  });

  it("a long sequence with mid-sequence voids still yields no gaps in the counter", async () => {
    const { ctx, fakeReceipts, rows } = makeCtx({
      initialRows: [
        {
          _id: COUNTER_ID,
          _creationTime: T0,
          currentSerial: 0,
          startingSerial: 0,
          prefix: "OR-",
          seededAt: T0,
        },
      ],
    });

    for (let i = 0; i < 20; i++) {
      const r = await allocateNextSerial(ctx);
      fakeReceipts.push({
        _id: `receipts:${r.serial}`,
        serial: r.serial,
        formatted: r.formatted,
        isVoided: false,
      });
    }
    // Void every 3rd receipt (5 voids).
    for (const r of fakeReceipts) {
      if (r.serial % 3 === 0) r.isVoided = true;
    }
    // Counter is at 20 — voids did not decrement.
    expect(rows[0]!.currentSerial).toBe(20);
    // Allocate one more — must be 21.
    const next = await allocateNextSerial(ctx);
    expect(next.serial).toBe(21);
  });
});

describe("seed + allocate — end-to-end", () => {
  it("a fresh seed followed by 5 allocations yields serials 1..5", async () => {
    const { ctx } = makeCtx({});
    const seed = getSeedHandler();
    await seed(ctx, { startingSerial: 0, prefix: "OR-" });
    const serials: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await allocateNextSerial(ctx);
      serials.push(r.serial);
    }
    expect(serials).toEqual([1, 2, 3, 4, 5]);
  });

  it("a seed with startingSerial=1000 produces 1001 on first allocation", async () => {
    const { ctx } = makeCtx({});
    const seed = getSeedHandler();
    await seed(ctx, { startingSerial: 1000, prefix: "OR-" });
    const r = await allocateNextSerial(ctx);
    expect(r).toEqual({ serial: 1001, formatted: "OR-0001001" });
  });
});
