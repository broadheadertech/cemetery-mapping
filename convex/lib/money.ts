/**
 * Server-side integer-centavo math helpers — Story 1.8.
 *
 * Every money field in the schema is stored as an INTEGER number of
 * centavos (`basePriceCents`, `principalCents`, `paidCents`, …). Float
 * pesos are forbidden — see `docs/adr/0007-money-integer-centavos.md`.
 *
 * Why a helper module instead of inline `a + b`:
 *
 *   1. Negative results: `sub(a, b)` throws when `b > a` so the
 *      caller can't silently produce a negative balance. Financial
 *      math should fail loudly, not roll over.
 *   2. Percent of: `pctOf(amountCents, percentBp)` accepts basis
 *      points (1 bp = 0.01%) so 12.5% → 1250 bp without ever
 *      touching a float.
 *   3. Future-proofing the deferred `no-cents-math` lint rule
 *      (Story 1.2 § eslint TODO): when that rule lands, any raw
 *      `* 100` / `/ 100` on identifiers ending in `Cents` becomes a
 *      build failure. Routing every operation through these helpers
 *      keeps the code clean from day one.
 *
 * Story 3.2's `postFinancialEvent` consumes these for payment
 * allocation math; Stories 3.5 (discounts) and 3.8 (perpetual care
 * fees) layer percentage / fixed-fee operations on top.
 */

import { ErrorCode, throwError } from "./errors";

function assertInt(name: string, value: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      `Money math received non-integer for ${name}: ${value}.`,
    );
  }
}

/**
 * Integer addition in centavos. Throws on non-integer inputs.
 */
export function add(a: number, b: number): number {
  assertInt("a", a);
  assertInt("b", b);
  return a + b;
}

/**
 * Integer subtraction in centavos. Throws on non-integer inputs and on
 * negative results (financial math should fail loudly rather than
 * silently produce negative balances).
 */
export function sub(a: number, b: number): number {
  assertInt("a", a);
  assertInt("b", b);
  const result = a - b;
  if (result < 0) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      `Money sub would underflow: ${a} - ${b} = ${result}.`,
    );
  }
  return result;
}

/**
 * Multiplies a centavo amount by an integer factor. Factor must be a
 * non-negative integer — for percentage-style scaling, use `pctOf`.
 */
export function mul(amountCents: number, factor: number): number {
  assertInt("amountCents", amountCents);
  assertInt("factor", factor);
  if (factor < 0) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      `Money mul factor must be non-negative: ${factor}.`,
    );
  }
  return amountCents * factor;
}

/**
 * Percent of an amount, given as basis points (1 bp = 0.01%).
 *
 *   pctOf(125_00_00, 1250)  →  15_62_50  // 12.5% of ₱12,500.00 = ₱1,562.50
 *
 * Uses integer math throughout: `(amountCents * percentBp) / 10000`
 * with `Math.round` to land cleanly on the nearest centavo. We round
 * to the nearest centavo (not floor / ceil) so the rounding error is
 * unbiased — the same rule architecture § Format Patterns endorses.
 */
export function pctOf(amountCents: number, percentBp: number): number {
  assertInt("amountCents", amountCents);
  assertInt("percentBp", percentBp);
  if (percentBp < 0) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      `pctOf percentBp must be non-negative: ${percentBp}.`,
    );
  }
  return Math.round((amountCents * percentBp) / 10_000);
}
