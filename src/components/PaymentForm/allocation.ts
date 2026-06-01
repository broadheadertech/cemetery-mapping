/**
 * Pure allocation-preview helper — Story 3.9 (FR26).
 *
 * Given a contract's installment schedule and a candidate payment
 * amount, returns the FIFO oldest-unpaid-first allocation plan the
 * server would apply. The helper is PURE — no ctx, no IO — so the form
 * can call it on every keystroke to render the live preview without a
 * network round-trip, and the server-side mutation can call the same
 * shape (or a parallel implementation in `convex/payments.ts`) to
 * produce the authoritative result.
 *
 * The story's Tasks 4 + 7 originally placed this helper at
 * `convex/lib/allocation.ts` with a `src/lib/allocation.ts` re-export.
 * Story 3.9's file-ownership constraints lock `convex/lib/**` and the
 * top-level `src/lib/**` outside our scope, so the canonical home is
 * here in the PaymentForm component folder. The server logic in
 * `convex/payments.ts` mirrors this algorithm directly (FIFO oldest
 * unpaid first, `min(remaining, balance)` per row, terminate at
 * `remaining === 0`); keeping the two implementations parallel is the
 * cost of the file-ownership scope.
 */

export interface AllocationInstallmentInput {
  installmentId: string;
  installmentNumber: number;
  dueDate: number;
  principalCents: number;
  paidCents: number;
  status: "pending" | "paid" | "overdue" | "waived";
}

export interface AllocationPreviewEntry {
  installmentId: string;
  installmentNumber: number;
  dueDate: number;
  principalCents: number;
  paidCents: number;
  status: "pending" | "paid" | "overdue" | "waived";
  /** Balance owed BEFORE this candidate payment is applied. */
  balanceBeforeCents: number;
  /** Centavos this candidate payment would apply to the row. */
  amountAppliedCents: number;
  /** Would this row be marked `paid` after the candidate payment? */
  willMarkPaid: boolean;
}

export interface AllocationPreviewResult {
  /** One entry per installment, in `installmentNumber` order. */
  entries: AllocationPreviewEntry[];
  /** Total centavos the candidate payment would apply. */
  totalAppliedCents: number;
  /** Centavos left over (overpay) if the amount exceeds the outstanding balance. */
  remainingCents: number;
  /** True iff `remainingCents > 0`. */
  wouldOverpay: boolean;
  /** True iff every installment would read `paid` after the payment. */
  wouldCloseContract: boolean;
}

/**
 * Pure FIFO allocator. Walks the installment schedule ordered by
 * `installmentNumber` ascending, applying `min(remaining, balance)` to
 * each unpaid row (status !== "paid" / "waived"; "waived" rows are
 * not allocated against — they were settled by an admin write).
 *
 * The return shape is rich enough to drive both the `AllocationPreview`
 * subcomponent's table render AND the receipt-preview modal's line-
 * item list. Callers should not mutate the returned `entries` array.
 *
 * Edge cases:
 *   - `amountCents <= 0`: every entry's `amountAppliedCents` is 0;
 *     `totalAppliedCents` is 0; `remainingCents` is 0;
 *     `wouldOverpay` is false; `wouldCloseContract` is false (a 0
 *     payment closes nothing).
 *   - All installments already paid: every entry's
 *     `amountAppliedCents` is 0; `totalAppliedCents` is 0;
 *     `remainingCents === amountCents`; `wouldOverpay` is true iff
 *     `amountCents > 0`; `wouldCloseContract` is true (every row IS
 *     already paid).
 *   - Amount equals the oldest unpaid row's balance exactly: that row
 *     gets `willMarkPaid: true`; remaining rows get 0.
 *   - Amount exceeds the oldest row's balance: cascades to the next
 *     row.
 */
export function previewAllocation(
  installments: ReadonlyArray<AllocationInstallmentInput>,
  amountCents: number,
): AllocationPreviewResult {
  // Defensive copy + sort so the caller's array order does not matter.
  // The Convex query already returns the rows ordered by
  // installmentNumber ascending (Story 3.4's
  // `listContractInstallments`), but the pure helper does not assume
  // that contract — defense in depth + predictable test behavior.
  const ordered = [...installments].sort(
    (a, b) => a.installmentNumber - b.installmentNumber,
  );

  let remaining = Number.isFinite(amountCents) && amountCents > 0
    ? Math.floor(amountCents)
    : 0;
  const entries: AllocationPreviewEntry[] = [];
  let allWouldBePaid = true;
  for (const row of ordered) {
    const balance = Math.max(row.principalCents - row.paidCents, 0);
    let applied = 0;
    let willMarkPaid = row.status === "paid" || row.status === "waived";
    if (
      remaining > 0 &&
      row.status !== "paid" &&
      row.status !== "waived" &&
      balance > 0
    ) {
      applied = Math.min(remaining, balance);
      remaining -= applied;
      if (row.paidCents + applied === row.principalCents) {
        willMarkPaid = true;
      }
    }
    entries.push({
      installmentId: row.installmentId,
      installmentNumber: row.installmentNumber,
      dueDate: row.dueDate,
      principalCents: row.principalCents,
      paidCents: row.paidCents,
      status: row.status,
      balanceBeforeCents: balance,
      amountAppliedCents: applied,
      willMarkPaid,
    });
    if (!willMarkPaid) {
      allWouldBePaid = false;
    }
  }

  const startAmount =
    Number.isFinite(amountCents) && amountCents > 0
      ? Math.floor(amountCents)
      : 0;
  const totalAppliedCents = startAmount - remaining;
  return {
    entries,
    totalAppliedCents,
    remainingCents: remaining,
    wouldOverpay: remaining > 0 && startAmount > 0,
    wouldCloseContract: allWouldBePaid && entries.length > 0,
  };
}

/**
 * Story 3.10 — custom-allocation client-side validator.
 *
 * Office staff can override the FIFO default by editing per-installment
 * amounts directly. The PaymentForm's submit button stays disabled
 * until `validateCustomAllocation` returns `ok: true`. The mutation
 * (`recordPaymentWithCustomAllocation`) re-validates server-side; this
 * helper is a pure UX gate, not the authoritative invariant.
 *
 * Invariants enforced (the server enforces the same):
 *
 *   1. Every input row's `amountCents` is a non-negative integer.
 *   2. Each row's `amountCents` is `≤` the matched installment's
 *      outstanding balance (`principalCents - paidCents`). Phase 1
 *      forbids credit-forward overpayment per row (Story 3.2 Task 9
 *      strict-fail decision).
 *   3. No row targets an installment with `status === "paid"` or
 *      `"waived"` — those rows have no outstanding balance to apply
 *      against.
 *   4. The sum of `allocations[].amountCents` equals
 *      `paymentAmountCents`. The cornerstone refuses partial
 *      allocations (ALLOCATION_SUM_MISMATCH), so the UX gate matches.
 *   5. `paymentAmountCents` is a positive integer.
 *
 * Returns a discriminated result the form can use both for the
 * submit-disabled gate (`ok: false`) and the per-row warning UI (the
 * `rowErrors` map keys by `installmentId`).
 */
export interface CustomAllocationRow {
  installmentId: string;
  amountCents: number;
}

export interface CustomAllocationValidationResult {
  /** Overall validity — the form's submit button mirrors this. */
  ok: boolean;
  /** Sum of `allocations[].amountCents`. */
  totalAllocatedCents: number;
  /**
   * `paymentAmountCents - totalAllocatedCents`. Positive means the
   * staff under-allocated (needs more rows or a larger amount); negative
   * means they over-allocated (needs to reduce somewhere); zero means
   * sums match.
   */
  remainderCents: number;
  /**
   * Per-row error codes keyed by `installmentId`. Used by the row
   * warning slot. Absent key = no error on that row.
   */
  rowErrors: Record<string, "exceeds_outstanding" | "not_payable" | "not_integer" | "negative">;
  /** Top-level errors that aren't tied to a specific row. */
  formErrors: Array<"amount_not_positive_integer" | "sum_mismatch">;
}

export function validateCustomAllocation(
  installments: ReadonlyArray<AllocationInstallmentInput>,
  allocations: ReadonlyArray<CustomAllocationRow>,
  paymentAmountCents: number,
): CustomAllocationValidationResult {
  const rowErrors: CustomAllocationValidationResult["rowErrors"] = {};
  const formErrors: CustomAllocationValidationResult["formErrors"] = [];

  const byId = new Map<string, AllocationInstallmentInput>();
  for (const row of installments) {
    byId.set(row.installmentId, row);
  }

  // Top-level: payment amount must be a positive integer.
  if (
    !Number.isFinite(paymentAmountCents) ||
    !Number.isInteger(paymentAmountCents) ||
    paymentAmountCents <= 0
  ) {
    formErrors.push("amount_not_positive_integer");
  }

  let totalAllocatedCents = 0;
  for (const row of allocations) {
    if (
      !Number.isFinite(row.amountCents) ||
      !Number.isInteger(row.amountCents)
    ) {
      rowErrors[row.installmentId] = "not_integer";
      continue;
    }
    if (row.amountCents < 0) {
      rowErrors[row.installmentId] = "negative";
      continue;
    }
    totalAllocatedCents += row.amountCents;
    if (row.amountCents === 0) {
      // A zero-allocated row is fine — staff chose not to apply to this
      // installment. It will be filtered out before being sent to the
      // server (the cornerstone refuses zero-amount allocation rows).
      continue;
    }
    const installment = byId.get(row.installmentId);
    if (installment === undefined) {
      rowErrors[row.installmentId] = "not_payable";
      continue;
    }
    if (
      installment.status === "paid" ||
      installment.status === "waived"
    ) {
      rowErrors[row.installmentId] = "not_payable";
      continue;
    }
    const outstanding = Math.max(
      installment.principalCents - installment.paidCents,
      0,
    );
    if (row.amountCents > outstanding) {
      rowErrors[row.installmentId] = "exceeds_outstanding";
      continue;
    }
  }

  const safeAmount =
    Number.isFinite(paymentAmountCents) && Number.isInteger(paymentAmountCents)
      ? paymentAmountCents
      : 0;
  const remainderCents = safeAmount - totalAllocatedCents;
  if (remainderCents !== 0) {
    formErrors.push("sum_mismatch");
  }

  const ok =
    Object.keys(rowErrors).length === 0 && formErrors.length === 0;

  return {
    ok,
    totalAllocatedCents,
    remainderCents,
    rowErrors,
    formErrors,
  };
}
