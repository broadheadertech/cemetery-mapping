/**
 * ArAgingTable — Story 4.8 (FR34/FR35, UX-DR10).
 *
 * Shared types for the table component. The row shape mirrors what
 * `arAging:listAgingDetail` returns; we keep the type local to the
 * component folder so the table can be exercised by a unit test
 * without a Convex client wired in (the page is the seam between
 * Convex and React; the table is pure presentation).
 */

export type ArAgingBucket =
  | "current"
  | "1-30"
  | "31-60"
  | "61-90"
  | "90+";

/**
 * The four "overdue" buckets surfaced as filter chips. `"current"` is
 * intentionally excluded — UX § Journey 4 framing is "risk distinction
 * across the overdue tail," not "show me every contract."
 */
export const OVERDUE_BUCKETS: readonly ArAgingBucket[] = [
  "1-30",
  "31-60",
  "61-90",
  "90+",
];

/** Title-case label rendered on the bucket chip + the sub-header. */
export const BUCKET_LABEL: Record<ArAgingBucket, string> = {
  current: "Current",
  "1-30": "1 – 30 days",
  "31-60": "31 – 60 days",
  "61-90": "61 – 90 days",
  "90+": "90+ days",
};

/**
 * Wire shape returned by `arAging:listAgingDetail`. The component
 * accepts already-resolved rows as props; the parent page handles the
 * Convex round-trip.
 */
export interface ArAgingDetailRow {
  contractId: string;
  contractNumber: string;
  customerId: string;
  customerFullName: string;
  lotId: string;
  lotCode: string;
  bucket: ArAgingBucket;
  totalOverdueCents: number;
  currentBalanceCents: number;
  daysOverdue: number;
  hasActiveFollowUp: boolean;
  followUpActionNote: string | undefined;
  lastPaymentAt: number | undefined;
  contractState:
    | "active"
    | "paid_in_full"
    | "cancelled"
    | "voided"
    | "in_default";
}

export interface ArAgingDetailResult {
  rows: ArAgingDetailRow[];
  totalCount: number;
  needsActionCount: number;
  /**
   * `null` when the result was not capped. A number (e.g. `100`)
   * means the server clipped the result at that row index — the
   * sorted-by-totalOverdueCents top N rows are returned, and the UI
   * can surface a "showing first N of M" hint pointing operators
   * toward the report-export surface (Epic 6) for the long tail.
   * See `AR_AGING_DETAIL_ROW_CAP` in `convex/arAging.ts`.
   */
  truncatedAt: number | null;
}
