/**
 * Installment schedule generator — Story 3.4 (FR20 / FR21).
 *
 * Thin re-export shim around the canonical implementation at
 * `convex/lib/installmentSchedule.ts`. The shared module is the single
 * source of truth — the client `SchedulePreview` UI and the server's
 * `recordInstallmentSale` mutation BOTH consume it, and the server
 * re-derives the schedule and compares against the client-supplied
 * array to reject any tampering (Epic-3/4 adversarial-review HIGH
 * fix — defense in depth against a hostile client supplying due dates
 * in 2099).
 *
 * Historical note: this file used to carry the implementation; the
 * adversarial review moved the canonical copy server-side. The client
 * surface is unchanged so existing imports (the SaleForm + the
 * component tests) keep working without churn.
 */

export {
  addMonthsClamped,
  generateInstallmentSchedule,
} from "../../../convex/lib/installmentSchedule";
export type {
  ScheduleInput,
  ScheduleResult,
  ScheduleRow,
} from "../../../convex/lib/installmentSchedule";
