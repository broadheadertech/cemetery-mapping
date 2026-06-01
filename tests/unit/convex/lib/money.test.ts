/**
 * Server-side money helpers — Story 1.8 unit tests.
 *
 * Coverage target: ≥ 90% (NFR-M2). Every helper rejects non-integer
 * input and (for `sub`) negative results, so each branch needs an
 * explicit test.
 */

import { ConvexError, type Value } from "convex/values";
import { describe, expect, it } from "vitest";

import { add, mul, pctOf, sub } from "../../../../convex/lib/money";
import { ErrorCode, type ErrorPayload } from "../../../../convex/lib/errors";

function getCode(thrown: unknown): string | undefined {
  if (!(thrown instanceof ConvexError)) return undefined;
  const data = (thrown as ConvexError<Value>).data as unknown as ErrorPayload;
  return data?.code;
}

describe("add", () => {
  it("adds two integers", () => {
    expect(add(100, 250)).toBe(350);
  });
  it("rejects float `a`", () => {
    const thrown = (() => {
      try {
        add(1.5, 1);
      } catch (e) {
        return e;
      }
    })();
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });
  it("rejects float `b`", () => {
    const thrown = (() => {
      try {
        add(1, 1.5);
      } catch (e) {
        return e;
      }
    })();
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });
});

describe("sub", () => {
  it("subtracts two integers", () => {
    expect(sub(500, 200)).toBe(300);
  });
  it("returns zero exactly when equal", () => {
    expect(sub(500, 500)).toBe(0);
  });
  it("throws INVARIANT_VIOLATION on underflow", () => {
    const thrown = (() => {
      try {
        sub(100, 200);
      } catch (e) {
        return e;
      }
    })();
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });
});

describe("mul", () => {
  it("multiplies by an integer factor", () => {
    expect(mul(1250, 3)).toBe(3750);
  });
  it("rejects negative factor", () => {
    const thrown = (() => {
      try {
        mul(100, -1);
      } catch (e) {
        return e;
      }
    })();
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });
  it("zero factor yields zero", () => {
    expect(mul(99999, 0)).toBe(0);
  });
});

describe("pctOf", () => {
  it("12.5% of ₱12,500.00 → ₱1,562.50", () => {
    // 1_250_000 centavos * 1250 bp / 10000 = 156_250 centavos
    expect(pctOf(1_250_000, 1_250)).toBe(156_250);
  });
  it("rounds to nearest centavo (half-up)", () => {
    // 1 * 50% = 0.5 centavo → rounds to 1 (Math.round half-up).
    expect(pctOf(1, 5_000)).toBe(1);
  });
  it("zero percent yields zero", () => {
    expect(pctOf(100_000, 0)).toBe(0);
  });
  it("rejects negative percentBp", () => {
    const thrown = (() => {
      try {
        pctOf(100, -10);
      } catch (e) {
        return e;
      }
    })();
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });
});
