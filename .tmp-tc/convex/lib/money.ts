import { ErrorCode, throwError } from "./errors";

/**
 * Integer-centavo math — taxonomy §11.2.
 *
 * Every money field in the schema is an INTEGER number of centavos
 * (`amountCents`, `releasedCents`, `openingBalanceCents`, …). Float
 * pesos are forbidden: `0.1 + 0.2 !== 0.3` is not an acceptable
 * property for a ledger that has to tie to a bank statement.
 *
 * Why a helper module instead of inline `a + b`:
 *
 *   1. **Negative results fail loudly.** `sub` throws when it would
 *      underflow, so a bug produces an error at the point of the
 *      mistake rather than a negative balance discovered at month-end.
 *   2. **Non-integers fail loudly.** Every entry point asserts. A float
 *      that leaks in from a parsed form field is caught on the first
 *      operation, not after it has been persisted.
 *   3. **Percentages never touch a float.** `pctOf` takes basis points
 *      (1 bp = 0.01%), so 12.5% is `1250` and the division is integer
 *      arithmetic rounded once, at the end.
 *   4. **It gives the lint rule something to point at.** The
 *      `local-rules/no-float-money` rule bans raw `*` and `/` on
 *      identifiers ending in `Cents`; routing through these functions
 *      is how you satisfy it.
 */

function assertInt(name: string, value: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      `Money math received a non-integer for ${name}: ${value}. Amounts are integer centavos.`,
      { field: name, value: String(value) },
    );
  }
}

/** Integer addition in centavos. */
export function add(a: number, b: number): number {
  assertInt("a", a);
  assertInt("b", b);
  return a + b;
}

/**
 * Integer subtraction in centavos. Throws on a negative result —
 * financial math should fail loudly rather than silently produce a
 * negative balance. Where a negative IS legitimate (a variance, a
 * signed delta), use `diff`.
 */
export function sub(a: number, b: number): number {
  assertInt("a", a);
  assertInt("b", b);
  const result = a - b;
  if (result < 0) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      `Money sub would underflow: ${a} - ${b} = ${result}.`,
      { a, b },
    );
  }
  return result;
}

/**
 * Signed difference. Use only where a negative outcome is meaningful
 * and the caller handles it — a budget variance, an over/short figure.
 * Never use this to work around a `sub` that threw.
 */
export function diff(a: number, b: number): number {
  assertInt("a", a);
  assertInt("b", b);
  return a - b;
}

/** Sums a list of centavo amounts. Empty list is 0. */
export function sum(amounts: readonly number[]): number {
  return amounts.reduce((acc, n) => add(acc, n), 0);
}

/** Multiplies a centavo amount by a non-negative integer factor. */
export function mul(amountCents: number, factor: number): number {
  assertInt("amountCents", amountCents);
  assertInt("factor", factor);
  if (factor < 0) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      `Money mul factor must be non-negative: ${factor}.`,
      { factor },
    );
  }
  return amountCents * factor;
}

/**
 * Percent of an amount, given in basis points (1 bp = 0.01%).
 *
 *   pctOf(1_250_000, 1250)  →  156_250   // 12.5% of ₱12,500.00
 *
 * Rounds to the nearest centavo rather than flooring, so the rounding
 * error is unbiased across many operations.
 */
export function pctOf(amountCents: number, percentBp: number): number {
  assertInt("amountCents", amountCents);
  assertInt("percentBp", percentBp);
  if (percentBp < 0) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      `pctOf percentBp must be non-negative: ${percentBp}.`,
      { percentBp },
    );
  }
  return Math.round((amountCents * percentBp) / 10_000);
}

/**
 * Guards an amount arriving from outside — a form, an import, an API.
 * Rejects non-integers, negatives and zero.
 *
 * Zero is rejected because every money movement in this system
 * represents something that actually happened. A zero-peso movement is
 * a data-entry accident, and letting it through means reconciliation
 * has to explain rows that do not exist in the real world.
 */
export function assertPositiveAmount(name: string, amountCents: number): void {
  assertInt(name, amountCents);
  if (amountCents <= 0) {
    throwError(
      ErrorCode.VALIDATION,
      `${name} must be greater than zero.`,
      { field: name, value: amountCents },
    );
  }
}

/**
 * Formats centavos for display: `1_234_567` → `"₱12,345.67"`.
 *
 * Server-side use is for audit summaries and generated documents. UI
 * formatting normally happens client-side, but this exists so a log
 * line never has to do its own `/ 100`.
 */
export function formatPeso(amountCents: number): string {
  assertInt("amountCents", amountCents);
  const negative = amountCents < 0;
  const abs = Math.abs(amountCents);
  const pesos = Math.trunc(abs / 100);
  const centavos = abs % 100;
  const grouped = String(pesos).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}₱${grouped}.${centavos < 10 ? "0" : ""}${centavos}`;
}
