import {
  CheckCircle2,
  Clock,
  Ban,
  Circle,
  XCircle,
  AlertTriangle,
  ArrowRightCircle,
  CircleDashed,
  Dot,
  CalendarCheck,
  CalendarClock,
  HourglassIcon,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";

/**
 * Status type unions consumed by `<StatusPill>`.
 *
 * Intentionally split into separate semantic axes so call sites can
 * constrain the prop type when they know the domain:
 *
 *   - `LotStatus`     — what state is the lot in? (7 values)
 *   - `PaymentStatus` — where does this installment sit? (5 values)
 *   - `ContractStatus` — contract lifecycle (Stories 3.3 / 3.4 / 3.6
 *                        / 4.4). Added by Story 5.9 HIGH fix so the
 *                        contracts / receipts / sales pages stop
 *                        rendering raw status-coloured spans.
 *   - `IntermentStatus` — burial scheduling (Story 7.1).
 *   - `ExpenseApprovalStatus` — pending-approval queue (Story 6.6).
 *
 * Every member unites into `PillStatus` for the StatusPill itself,
 * which dispatches via the lookup maps below. Disjoint members across
 * unions MUST keep unique literal values — the Tailwind class lookup
 * is keyed by status string.
 */
export type LotStatus =
  | "available"
  | "reserved"
  | "sold"
  | "occupied"
  | "cancelled"
  | "defaulted"
  | "transferred";

export type PaymentStatus =
  | "paid"
  | "current"
  | "due"
  | "overdue"
  | "overdue-action";

/**
 * Contract-lifecycle states from `convex/contracts.ts`. `cancelled` is
 * shared with `LotStatus` (same string literal — both render in the
 * same muted-zinc treatment) so it intentionally is NOT repeated here.
 */
export type ContractStatus =
  | "active"
  | "paid_in_full"
  | "voided"
  | "in_default";

/**
 * Interment-lifecycle states from `convex/interments.ts`. `cancelled`
 * (shared with LotStatus / ContractStatus) again uses the unified
 * literal.
 */
export type IntermentStatus = "scheduled" | "completed";

/**
 * Expense approval-queue states from `convex/expenses.ts` (Story 6.6).
 * `approved` deliberately uses its own literal — visually the same
 * emerald family as `paid`, but call sites typing an expense row want
 * to constrain the union to expense-approval values only.
 */
export type ExpenseApprovalStatus =
  | "approved"
  | "pending_approval"
  | "rejected";

export type PillStatus =
  | LotStatus
  | PaymentStatus
  | ContractStatus
  | IntermentStatus
  | ExpenseApprovalStatus;

/**
 * Title-case label rendered inside the pill AND exposed via `aria-label`
 * so screen readers never depend on the icon glyph alone (NFR-A2:
 * color + icon + label, never color alone).
 */
export const LABEL_MAP: Record<PillStatus, string> = {
  available: "Available",
  reserved: "Reserved",
  sold: "Sold",
  occupied: "Occupied",
  cancelled: "Cancelled",
  defaulted: "Defaulted",
  transferred: "Transferred",
  paid: "Paid",
  current: "Current",
  due: "Due",
  overdue: "Overdue",
  "overdue-action": "Overdue (action)",
  // Contract lifecycle (Story 5.9 — staff-facing operational labels).
  active: "Active",
  paid_in_full: "Paid in full",
  voided: "Voided",
  in_default: "In default",
  // Interment lifecycle (Story 7.1).
  scheduled: "Scheduled",
  completed: "Completed",
  // Expense approval queue (Story 6.6).
  approved: "Approved",
  pending_approval: "Pending approval",
  rejected: "Rejected",
};

/**
 * Glyph paired with each status. Lucide ships every icon as an
 * individual ESM export so tree-shaking drops unused glyphs from the
 * client bundle. Matches the UX § Status palette table.
 */
export const ICON_MAP: Record<PillStatus, LucideIcon> = {
  available: CheckCircle2,
  reserved: Clock,
  sold: Ban,
  occupied: Circle,
  cancelled: XCircle,
  defaulted: AlertTriangle,
  transferred: ArrowRightCircle,
  paid: CheckCircle2,
  current: CircleDashed,
  due: Dot,
  overdue: AlertTriangle,
  "overdue-action": Clock,
  // Contract lifecycle.
  active: CircleDashed,
  paid_in_full: CheckCircle2,
  voided: XCircle,
  in_default: ShieldAlert,
  // Interment lifecycle.
  scheduled: CalendarClock,
  completed: CalendarCheck,
  // Expense approval queue.
  approved: CheckCircle2,
  pending_approval: HourglassIcon,
  rejected: XCircle,
};

/**
 * Tailwind utility chunks per status. Kept as a static map so the
 * Tailwind JIT compiler can see every class literal at build time;
 * a ternary chain over status would defeat tree-shaking.
 *
 * Outdoor mode adds a 2px border by reading `--pill-border-width`
 * from the parent `:root` — the colour comes from these classes.
 */
export const VARIANT_CLASSES: Record<PillStatus, string> = {
  available:
    "bg-status-available-bg text-status-available-text border-status-available-border",
  reserved:
    "bg-status-reserved-bg text-status-reserved-text border-status-reserved-border",
  sold: "bg-status-sold-bg text-status-sold-text border-status-sold-border",
  occupied:
    "bg-status-occupied-bg text-status-occupied-text border-status-occupied-border",
  cancelled:
    "bg-status-cancelled-bg text-status-cancelled-text border-status-cancelled-border",
  defaulted:
    "bg-status-defaulted-bg text-status-defaulted-text border-status-defaulted-border",
  transferred:
    "bg-status-transferred-bg text-status-transferred-text border-status-transferred-border",
  paid: "bg-status-paid-bg text-status-paid-text border-status-paid-border",
  current:
    "bg-status-current-bg text-status-current-text border-status-current-border",
  due: "bg-status-due-bg text-status-due-text border-status-due-border",
  overdue:
    "bg-status-overdue-bg text-status-overdue-text border-status-overdue-border",
  "overdue-action":
    "bg-status-overdue-action-bg text-status-overdue-action-text border-status-overdue-action-border",
  // Contract lifecycle.
  active:
    "bg-status-active-bg text-status-active-text border-status-active-border",
  paid_in_full:
    "bg-status-paid_in_full-bg text-status-paid_in_full-text border-status-paid_in_full-border",
  voided:
    "bg-status-voided-bg text-status-voided-text border-status-voided-border",
  in_default:
    "bg-status-in_default-bg text-status-in_default-text border-status-in_default-border",
  // Interment lifecycle.
  scheduled:
    "bg-status-scheduled-bg text-status-scheduled-text border-status-scheduled-border",
  completed:
    "bg-status-completed-bg text-status-completed-text border-status-completed-border",
  // Expense approval queue.
  approved:
    "bg-status-approved-bg text-status-approved-text border-status-approved-border",
  pending_approval:
    "bg-status-pending_approval-bg text-status-pending_approval-text border-status-pending_approval-border",
  rejected:
    "bg-status-rejected-bg text-status-rejected-text border-status-rejected-border",
};

/**
 * Icon colour utilities mirror VARIANT_CLASSES but apply to the
 * `<svg>` (Lucide forwards className). Keeping these separate keeps
 * the icon colour subtly different from the text colour where the UX
 * spec calls for it (icon a touch brighter than the deep body text).
 */
export const ICON_COLOR: Record<PillStatus, string> = {
  available: "text-status-available-icon",
  reserved: "text-status-reserved-icon",
  sold: "text-status-sold-icon",
  occupied: "text-status-occupied-icon",
  cancelled: "text-status-cancelled-icon",
  defaulted: "text-status-defaulted-icon",
  transferred: "text-status-transferred-icon",
  paid: "text-status-paid-icon",
  current: "text-status-current-icon",
  due: "text-status-due-icon",
  overdue: "text-status-overdue-icon",
  "overdue-action": "text-status-overdue-action-icon",
  // Contract lifecycle.
  active: "text-status-active-icon",
  paid_in_full: "text-status-paid_in_full-icon",
  voided: "text-status-voided-icon",
  in_default: "text-status-in_default-icon",
  // Interment lifecycle.
  scheduled: "text-status-scheduled-icon",
  completed: "text-status-completed-icon",
  // Expense approval queue.
  approved: "text-status-approved-icon",
  pending_approval: "text-status-pending_approval-icon",
  rejected: "text-status-rejected-icon",
};
