/**
 * Story 9.1 adversarial-review follow-up — `convex/authRateLimit.ts`
 * unit tests (NFR-S6).
 *
 * Coverage target: ≥ 95% line + branch on the helper file + public
 * surface (auth-adjacent code per the Story 9.1 NFR-M2 commitment).
 *
 * Strategy: hand-mocked ctx (mirroring `portal.test.ts` /
 * `exports.test.ts`). `convex-test` requires `convex/_generated/` which
 * this repo deliberately doesn't have until the operator runs
 * `npx convex dev`. The hand-mock satisfies the runtime needs of the
 * `by_identifier_attempted` index scan (filter + descending order +
 * take) and the `by_attemptedAt` range scan (lt cutoff + collect).
 *
 * Cases:
 *   - assertLoginRateOk:
 *       • Passes on 0 attempts.
 *       • Passes on 4 failed attempts within 15 min.
 *       • Throws RATE_LIMITED on the 5th failed attempt within 15 min.
 *       • Failures outside the short window don't trip the short limit.
 *       • 10 failed within 1h triggers lockout (longer message + 60-min
 *         retry-after).
 *       • Successful attempt resets the short-window counter (4 fails
 *         followed by a success then 4 more fails is allowed).
 *   - recordLoginAttempt:
 *       • Inserts a row with the supplied identifier + succeeded flag.
 *       • Honours optional ipHash / userAgent (omits when blank).
 *   - normalizeIdentifier:
 *       • Lowercases + trims; returns null on empty / whitespace-only.
 *   - cleanupExpiredAuthAttempts:
 *       • Deletes rows older than retention window.
 *       • Leaves rows newer than retention window untouched.
 *   - Public checkLoginRateLimit:
 *       • VALIDATION on empty identifier.
 *       • Normalises (case-insensitive) before lookup.
 *       • Passes through to assertLoginRateOk on success.
 *   - Public recordPortalLoginOutcome:
 *       • Normalises (lowercases) before insert.
 *       • Silent no-op on empty identifier.
 *       • Truncates userAgent to 200 chars.
 */

import { ConvexError, type Value } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCode, type ErrorPayload } from "../../../convex/lib/errors";
import { MINUTE_MS } from "../../../convex/lib/time";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import {
  AUTH_ATTEMPTS_RETENTION_MS,
  LONG_WINDOW_LIMIT,
  LONG_WINDOW_MS,
  SHORT_WINDOW_LIMIT,
  SHORT_WINDOW_MS,
  assertLoginRateOk,
  checkLoginRateLimit,
  cleanupExpiredAuthAttempts,
  internal_cleanupAuthAttempts,
  normalizeIdentifier,
  recordLoginAttempt,
  recordPortalLoginOutcome,
} from "../../../convex/authRateLimit";

interface AttemptFixture {
  _id: string;
  _creationTime: number;
  identifier: string;
  attemptedAt: number;
  succeeded: boolean;
  ipHash?: string;
  userAgent?: string;
}

interface MockCtxBag {
  rows: Map<string, AttemptFixture>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();

function makeCtx(initial: AttemptFixture[] = []): MockCtxBag {
  const rows = new Map<string, AttemptFixture>(
    initial.map((r) => [r._id, r]),
  );
  let nextId = initial.length + 1;

  const ctx = {
    db: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: vi.fn((table: string): any => {
        if (table !== "authAttempts") {
          throw new Error(
            `Mock ctx: unexpected query on table "${table}" — the only ` +
              `table this helper touches is authAttempts.`,
          );
        }
        // The `withIndex` calls in the helpers come in two shapes:
        //   - by_identifier_attempted: q => q.eq("identifier", id)
        //   - by_attemptedAt: q => q.lt("attemptedAt", cutoff)
        // We capture the index name + the callback's intent by running
        // the callback against a tiny stub that records the filter.
        return {
          withIndex: (
            indexName: string,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            cb: (q: any) => any,
          ) => {
            const filters: {
              identifier?: string;
              lt?: { field: string; value: number };
            } = {};
            const builder = {
              eq: (field: string, value: unknown) => {
                if (field === "identifier" && typeof value === "string") {
                  filters.identifier = value;
                }
                return builder;
              },
              lt: (field: string, value: unknown) => {
                if (typeof value === "number") {
                  filters.lt = { field, value };
                }
                return builder;
              },
            };
            cb(builder);

            // Filter rows according to the captured filter set.
            const filtered = Array.from(rows.values()).filter((row) => {
              if (filters.identifier !== undefined) {
                if (row.identifier !== filters.identifier) return false;
              }
              if (filters.lt !== undefined) {
                if (filters.lt.field === "attemptedAt") {
                  if (row.attemptedAt >= filters.lt.value) return false;
                }
              }
              return true;
            });
            // Default sort: ascending by attemptedAt (the index's natural order).
            let order: "asc" | "desc" = "asc";
            const orderable = {
              order: (dir: "asc" | "desc") => {
                order = dir;
                return orderable;
              },
              take: async (n: number) => {
                const sorted = [...filtered].sort((a, b) =>
                  order === "desc"
                    ? b.attemptedAt - a.attemptedAt
                    : a.attemptedAt - b.attemptedAt,
                );
                return sorted.slice(0, n);
              },
              collect: async () => {
                return [...filtered].sort((a, b) =>
                  order === "desc"
                    ? b.attemptedAt - a.attemptedAt
                    : a.attemptedAt - b.attemptedAt,
                );
              },
            };
            void indexName;
            return orderable;
          },
        };
      }),
      insert: vi.fn(
        async (table: string, row: Record<string, unknown>) => {
          if (table !== "authAttempts") {
            throw new Error(`Unexpected insert into ${table}`);
          }
          const id = `authAttempts:${nextId}`;
          nextId += 1;
          rows.set(id, {
            _id: id,
            _creationTime: Date.now(),
            ...(row as Omit<AttemptFixture, "_id" | "_creationTime">),
          });
          return id;
        },
      ),
      delete: vi.fn(async (id: string) => {
        rows.delete(id);
      }),
    },
  };

  return { rows, ctx };
}

function attempt(
  id: string,
  identifier: string,
  attemptedAt: number,
  succeeded: boolean,
  extras: { ipHash?: string; userAgent?: string } = {},
): AttemptFixture {
  return {
    _id: `authAttempts:${id}`,
    _creationTime: attemptedAt,
    identifier,
    attemptedAt,
    succeeded,
    ...extras,
  };
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

function getRateLimitMessage(thrown: unknown): string | undefined {
  if (!(thrown instanceof ConvexError)) return undefined;
  const data = (thrown as ConvexError<Value>).data as unknown as {
    message?: string;
  };
  return data?.message;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("normalizeIdentifier", () => {
  it("lowercases + trims", () => {
    expect(normalizeIdentifier("  Maria@Example.COM  ")).toBe(
      "maria@example.com",
    );
  });

  it("returns null on empty input", () => {
    expect(normalizeIdentifier("")).toBeNull();
  });

  it("returns null on whitespace-only input", () => {
    expect(normalizeIdentifier("   \t\n  ")).toBeNull();
  });
});

describe("assertLoginRateOk — short window (5 fails / 15 min)", () => {
  it("passes when no attempts exist", async () => {
    const { ctx } = makeCtx();
    await expect(
      assertLoginRateOk(ctx, "maria@example.com"),
    ).resolves.toBeUndefined();
  });

  it("passes on 4 failed attempts within the short window", async () => {
    const rows: AttemptFixture[] = [];
    for (let i = 0; i < 4; i += 1) {
      rows.push(
        attempt(`${i}`, "maria@example.com", T0 - (i + 1) * MINUTE_MS, false),
      );
    }
    const { ctx } = makeCtx(rows);
    await expect(
      assertLoginRateOk(ctx, "maria@example.com"),
    ).resolves.toBeUndefined();
  });

  it("throws RATE_LIMITED on the 5th failed attempt within the short window", async () => {
    const rows: AttemptFixture[] = [];
    for (let i = 0; i < SHORT_WINDOW_LIMIT; i += 1) {
      rows.push(
        attempt(`${i}`, "maria@example.com", T0 - (i + 1) * MINUTE_MS, false),
      );
    }
    const { ctx } = makeCtx(rows);
    const thrown = await assertLoginRateOk(
      ctx,
      "maria@example.com",
    ).catch((e) => e);
    expect(getCode(thrown)).toBe("RATE_LIMITED");
    expect(getRateLimitMessage(thrown)).toContain("15 minutes");
  });

  it("does NOT count failures older than the short window towards the short limit", async () => {
    // 5 fails all aged > 15 min but < 60 min — should be inside the
    // long window's count (still under 10) but outside the short
    // window's count → assertion passes.
    const rows: AttemptFixture[] = [];
    for (let i = 0; i < 5; i += 1) {
      rows.push(
        attempt(
          `${i}`,
          "maria@example.com",
          T0 - (SHORT_WINDOW_MS + (i + 1) * MINUTE_MS),
          false,
        ),
      );
    }
    const { ctx } = makeCtx(rows);
    await expect(
      assertLoginRateOk(ctx, "maria@example.com"),
    ).resolves.toBeUndefined();
  });
});

describe("assertLoginRateOk — long window lockout (10 fails / 1h)", () => {
  it("throws RATE_LIMITED with the 60-minute message when long-window limit reached", async () => {
    // 10 fails spread across the long window (1 every 5 min).
    const rows: AttemptFixture[] = [];
    for (let i = 0; i < LONG_WINDOW_LIMIT; i += 1) {
      rows.push(
        attempt(
          `${i}`,
          "maria@example.com",
          T0 - (i + 1) * 5 * MINUTE_MS,
          false,
        ),
      );
    }
    const { ctx } = makeCtx(rows);
    const thrown = await assertLoginRateOk(
      ctx,
      "maria@example.com",
    ).catch((e) => e);
    expect(getCode(thrown)).toBe("RATE_LIMITED");
    // The long-window branch fires (10 fails inside 60 min) — message
    // says 60 minutes, not 15.
    expect(getRateLimitMessage(thrown)).toContain("60 minutes");
  });

  it("does NOT count failures older than the long window", async () => {
    // 10 fails all > 60 min ago — outside both windows → pass.
    const rows: AttemptFixture[] = [];
    for (let i = 0; i < 10; i += 1) {
      rows.push(
        attempt(
          `${i}`,
          "maria@example.com",
          T0 - (LONG_WINDOW_MS + (i + 1) * MINUTE_MS),
          false,
        ),
      );
    }
    const { ctx } = makeCtx(rows);
    await expect(
      assertLoginRateOk(ctx, "maria@example.com"),
    ).resolves.toBeUndefined();
  });
});

describe("assertLoginRateOk — counter reset on success", () => {
  it("ignores failures BEFORE the latest success", async () => {
    // 4 old fails, then a success, then 4 fresh fails. The walk should
    // stop at the success — short count = 4 (passes).
    const rows: AttemptFixture[] = [
      attempt("0", "maria@example.com", T0 - 12 * MINUTE_MS, false),
      attempt("1", "maria@example.com", T0 - 11 * MINUTE_MS, false),
      attempt("2", "maria@example.com", T0 - 10 * MINUTE_MS, false),
      attempt("3", "maria@example.com", T0 - 9 * MINUTE_MS, false),
      attempt("4", "maria@example.com", T0 - 8 * MINUTE_MS, true),
      attempt("5", "maria@example.com", T0 - 4 * MINUTE_MS, false),
      attempt("6", "maria@example.com", T0 - 3 * MINUTE_MS, false),
      attempt("7", "maria@example.com", T0 - 2 * MINUTE_MS, false),
      attempt("8", "maria@example.com", T0 - 1 * MINUTE_MS, false),
    ];
    const { ctx } = makeCtx(rows);
    await expect(
      assertLoginRateOk(ctx, "maria@example.com"),
    ).resolves.toBeUndefined();
  });

  it("still throws when the 5th post-success failure lands", async () => {
    const rows: AttemptFixture[] = [
      attempt("0", "maria@example.com", T0 - 12 * MINUTE_MS, true),
      attempt("1", "maria@example.com", T0 - 5 * MINUTE_MS, false),
      attempt("2", "maria@example.com", T0 - 4 * MINUTE_MS, false),
      attempt("3", "maria@example.com", T0 - 3 * MINUTE_MS, false),
      attempt("4", "maria@example.com", T0 - 2 * MINUTE_MS, false),
      attempt("5", "maria@example.com", T0 - 1 * MINUTE_MS, false),
    ];
    const { ctx } = makeCtx(rows);
    const thrown = await assertLoginRateOk(
      ctx,
      "maria@example.com",
    ).catch((e) => e);
    expect(getCode(thrown)).toBe("RATE_LIMITED");
  });
});

describe("assertLoginRateOk — identifier isolation", () => {
  it("counts only attempts for the queried identifier", async () => {
    // Maria has 5 fresh fails (would trip her limit); pedro is a
    // different identifier — pedro must pass.
    const rows: AttemptFixture[] = [];
    for (let i = 0; i < 5; i += 1) {
      rows.push(
        attempt(`${i}`, "maria@example.com", T0 - (i + 1) * MINUTE_MS, false),
      );
    }
    const { ctx } = makeCtx(rows);
    await expect(
      assertLoginRateOk(ctx, "pedro@example.com"),
    ).resolves.toBeUndefined();
  });
});

describe("recordLoginAttempt", () => {
  it("inserts a row with identifier + succeeded + attemptedAt", async () => {
    const { rows, ctx } = makeCtx();
    await recordLoginAttempt(ctx, "maria@example.com", false);
    expect(rows.size).toBe(1);
    const stored = Array.from(rows.values())[0];
    expect(stored?.identifier).toBe("maria@example.com");
    expect(stored?.succeeded).toBe(false);
    expect(stored?.attemptedAt).toBe(T0);
  });

  it("stores ipHash + userAgent when provided", async () => {
    const { rows, ctx } = makeCtx();
    await recordLoginAttempt(ctx, "maria@example.com", true, {
      ipHash: "abcdef1234567890",
      userAgent: "Mozilla/5.0",
    });
    const stored = Array.from(rows.values())[0];
    expect(stored?.ipHash).toBe("abcdef1234567890");
    expect(stored?.userAgent).toBe("Mozilla/5.0");
  });

  it("omits empty ipHash / userAgent fields", async () => {
    const { rows, ctx } = makeCtx();
    await recordLoginAttempt(ctx, "maria@example.com", true, {
      ipHash: "",
      userAgent: "",
    });
    const stored = Array.from(rows.values())[0];
    expect(stored?.ipHash).toBeUndefined();
    expect(stored?.userAgent).toBeUndefined();
  });
});

describe("cleanupExpiredAuthAttempts", () => {
  it("deletes rows older than the retention window", async () => {
    const old = attempt(
      "old",
      "maria@example.com",
      T0 - AUTH_ATTEMPTS_RETENTION_MS - 1 * MINUTE_MS,
      false,
    );
    const recent = attempt(
      "recent",
      "maria@example.com",
      T0 - 1 * MINUTE_MS,
      false,
    );
    const { rows, ctx } = makeCtx([old, recent]);
    const result = await cleanupExpiredAuthAttempts(ctx);
    expect(result.deleted).toBe(1);
    expect(rows.has(old._id)).toBe(false);
    expect(rows.has(recent._id)).toBe(true);
  });

  it("returns deleted: 0 when nothing is past retention", async () => {
    const recent = attempt(
      "recent",
      "maria@example.com",
      T0 - 1 * MINUTE_MS,
      false,
    );
    const { rows, ctx } = makeCtx([recent]);
    const result = await cleanupExpiredAuthAttempts(ctx);
    expect(result.deleted).toBe(0);
    expect(rows.size).toBe(1);
  });

  it("internal_cleanupAuthAttempts logs the sweep result", async () => {
    const old = attempt(
      "old",
      "maria@example.com",
      T0 - AUTH_ATTEMPTS_RETENTION_MS - 1 * MINUTE_MS,
      false,
    );
    const { ctx } = makeCtx([old]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const run = handlerOf(internal_cleanupAuthAttempts);
    const result = (await run(ctx, {})) as { deleted: number };
    expect(result.deleted).toBe(1);
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

describe("checkLoginRateLimit (public query)", () => {
  const run = handlerOf(checkLoginRateLimit);

  it("throws VALIDATION on empty identifier", async () => {
    const { ctx } = makeCtx();
    const thrown = await run(ctx, { identifier: "" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("throws VALIDATION on whitespace-only identifier", async () => {
    const { ctx } = makeCtx();
    const thrown = await run(ctx, { identifier: "   " }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("normalises (lowercases) before lookup", async () => {
    // 5 fresh fails recorded against the lowercase identifier — a
    // mixed-case query should still trip the limit.
    const rows: AttemptFixture[] = [];
    for (let i = 0; i < SHORT_WINDOW_LIMIT; i += 1) {
      rows.push(
        attempt(`${i}`, "maria@example.com", T0 - (i + 1) * MINUTE_MS, false),
      );
    }
    const { ctx } = makeCtx(rows);
    const thrown = await run(ctx, {
      identifier: "MARIA@Example.COM",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe("RATE_LIMITED");
  });

  it("returns { allowed: true } when under the limit", async () => {
    const { ctx } = makeCtx();
    const result = (await run(ctx, {
      identifier: "maria@example.com",
    })) as { allowed: true };
    expect(result.allowed).toBe(true);
  });
});

describe("recordPortalLoginOutcome (public mutation)", () => {
  const run = handlerOf(recordPortalLoginOutcome);

  it("inserts a normalised row on success", async () => {
    const { rows, ctx } = makeCtx();
    await run(ctx, {
      identifier: "MARIA@Example.COM",
      succeeded: true,
    });
    const stored = Array.from(rows.values())[0];
    expect(stored?.identifier).toBe("maria@example.com");
    expect(stored?.succeeded).toBe(true);
  });

  it("silently no-ops on empty identifier", async () => {
    const { rows, ctx } = makeCtx();
    const result = (await run(ctx, {
      identifier: "",
      succeeded: false,
    })) as { recorded: true };
    expect(result.recorded).toBe(true);
    expect(rows.size).toBe(0);
  });

  it("truncates userAgent to ≤ 200 chars", async () => {
    const { rows, ctx } = makeCtx();
    const longUa = "A".repeat(500);
    await run(ctx, {
      identifier: "maria@example.com",
      succeeded: false,
      userAgent: longUa,
    });
    const stored = Array.from(rows.values())[0];
    expect(stored?.userAgent?.length).toBe(200);
  });

  it("omits empty userAgent", async () => {
    const { rows, ctx } = makeCtx();
    await run(ctx, {
      identifier: "maria@example.com",
      succeeded: false,
      userAgent: "",
    });
    const stored = Array.from(rows.values())[0];
    expect(stored?.userAgent).toBeUndefined();
  });
});
