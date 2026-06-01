"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { cn } from "@/lib/cn";
import { formatPeso } from "@/lib/money";
import { formatDate } from "@/lib/time";
import { ReactiveHighlight } from "@/components/ui/ReactiveHighlight";
import { StatusPill } from "@/components/ui/StatusPill/StatusPill";
import type { PillStatus } from "@/components/ui/StatusPill/icons";

/**
 * CustomerContractsList — Story 9.2 (FR55).
 *
 * Renders the authenticated customer's own contracts as a mobile-first
 * card list. Each card surfaces:
 *
 *   - lot reference (code + section / block / row),
 *   - the contract's current outstanding balance (peso-formatted),
 *   - next due date + remaining installments (when applicable),
 *   - a `<StatusPill>` translating the contract's state into a
 *     colour + icon + label triple (NFR-A2),
 *   - tappable affordance navigating to
 *     `/portal/contracts/[contractId]`.
 *
 * The whole list reads from a single Convex query
 * (`portal:listCustomerContracts`). The query is gated on the
 * `customer` role AND hard-scoped to the caller's `_id`, so the
 * component does NOT take a `customerId` prop — the server resolves it.
 *
 * Reactivity (AC3): Convex's `useQuery` re-renders the cards when the
 * subscribed contract / payment / installment rows change. The balance
 * cell is wrapped in `<ReactiveHighlight watch={balance}>` so a
 * staff-side payment post triggers the 600ms amber flash without a
 * page reload.
 *
 * Accessibility:
 *   - Touch target ≥ 48px (NFR-A4) — the card's `min-h-[88px]` plus
 *     padding leaves room for the body content while keeping the tap
 *     area comfortable on a mid-Android device.
 *   - `<StatusPill>` carries `role="status"` + `aria-label`, so the
 *     state semantics survive screen readers and high-contrast modes.
 *   - The whole card is a `<Link>` so keyboard navigation + screen
 *     reader linearisation are correct without `role="link"` overrides.
 */

interface CustomerLotRef {
  lotId: string;
  code: string;
  section: string;
  block: string;
  row: string;
  centroid: { lat: number; lng: number };
}

export interface CustomerContractListRow {
  contractId: string;
  contractNumber: string;
  kind: "full_payment" | "installment";
  state:
    | "active"
    | "paid_in_full"
    | "cancelled"
    | "voided"
    | "in_default";
  totalPriceCents: number;
  outstandingBalanceCents: number;
  nextDueDate?: number;
  remainingInstallments?: number;
  totalInstallments?: number;
  createdAt: number;
  lot: CustomerLotRef | null;
}

const listCustomerContracts = makeFunctionReference<
  "query",
  Record<string, never>,
  CustomerContractListRow[]
>("portal:listCustomerContracts");

/**
 * Translate contract `state` to the `<StatusPill>` vocabulary.
 *
 * `active` contracts map to either `current` (no balance left) or
 * `due` (balance > 0 and not overdue). We don't have day-aging
 * information here (overdue is computed in installment.status by the
 * Story 4.1 cron), so the dashboard reflects the contract's lifecycle
 * state — installment-level overdue is shown on the schedule.
 */
function pillStatusFor(row: CustomerContractListRow): PillStatus {
  if (row.state === "paid_in_full") return "paid";
  if (row.state === "in_default") return "defaulted";
  if (row.state === "cancelled") return "cancelled";
  if (row.state === "voided") return "cancelled";
  // Active — current vs. due.
  if (row.outstandingBalanceCents === 0) return "current";
  return "due";
}

function lotDisplay(lot: CustomerLotRef | null): string {
  if (lot === null) return "Lot details unavailable";
  return `${lot.code} · Section ${lot.section} · Block ${lot.block} · Row ${lot.row}`;
}

export interface CustomerContractsListProps {
  /**
   * Optional override used by tests + the page wrapper when it has
   * already resolved the contracts list (avoids the inner `useQuery`
   * during SSR-only renders). When omitted, the component subscribes
   * via Convex's reactive query.
   */
  contracts?: CustomerContractListRow[] | undefined;
  /**
   * Optional className for the list wrapper. Defaults to spacing
   * appropriate for the portal layout's max-width column.
   */
  className?: string;
}

export function CustomerContractsList({
  contracts: contractsProp,
  className,
}: CustomerContractsListProps) {
  // When `contractsProp` is supplied, skip the inner query — the parent
  // page already has the data. Otherwise subscribe live so the list
  // re-renders on any contract / payment update.
  const fromQuery = useQuery(
    listCustomerContracts,
    contractsProp === undefined ? {} : "skip",
  );
  const contracts = contractsProp ?? fromQuery;

  if (contracts === undefined) {
    // Loading skeleton — two placeholder cards mirroring the card
    // height. Shimmer is applied via Tailwind's animate-pulse on the
    // inner blocks. Total skeleton runtime is bounded by the Convex
    // query's reactive resolution (NFR-P1 / P2 ≤ 1s warm).
    return (
      <ul
        aria-busy="true"
        aria-label="Loading your contracts"
        className={cn("space-y-3", className)}
      >
        {[0, 1].map((i) => (
          <li
            key={i}
            className="rounded-md border border-surface-border bg-surface-base p-4 shadow-sm"
          >
            <div className="h-4 w-24 animate-pulse rounded bg-surface-muted" />
            <div className="mt-3 h-6 w-40 animate-pulse rounded bg-surface-muted" />
            <div className="mt-2 h-4 w-32 animate-pulse rounded bg-surface-muted" />
          </li>
        ))}
      </ul>
    );
  }

  if (contracts.length === 0) {
    return (
      <div
        className={cn(
          "rounded-md border border-dashed border-surface-border bg-surface-muted p-6 text-center",
          className,
        )}
      >
        <p className="text-sm font-medium text-text-default">
          The estate holds no active contracts in your name.
        </p>
        <p className="mt-1 text-sm text-text-muted">
          Should this seem in error, please write to the Estate Office.
        </p>
      </div>
    );
  }

  return (
    <ul
      aria-label="Contracts held in your name"
      className={cn("space-y-3", className)}
    >
      {contracts.map((contract) => (
        <li key={contract.contractId}>
          <Link
            href={`/portal/contracts/${contract.contractId}`}
            aria-label={`Contract ${contract.contractNumber} — outstanding balance ${formatPeso(contract.outstandingBalanceCents)}`}
            className={cn(
              "block min-h-[88px] rounded-md border border-surface-border bg-surface-base p-4 shadow-sm",
              "transition-colors hover:bg-surface-muted",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium uppercase tracking-wide text-text-muted">
                  {contract.contractNumber}
                </p>
                <p className="mt-1 truncate text-base font-semibold text-text-default">
                  {lotDisplay(contract.lot)}
                </p>
              </div>
              <StatusPill status={pillStatusFor(contract)} size="md" />
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase tracking-wide text-text-muted">
                  Outstanding balance
                </p>
                <p className="mt-0.5 text-lg font-semibold text-text-default">
                  <ReactiveHighlight watch={contract.outstandingBalanceCents}>
                    {formatPeso(contract.outstandingBalanceCents)}
                  </ReactiveHighlight>
                </p>
              </div>
              {contract.kind === "installment" &&
              contract.remainingInstallments !== undefined &&
              contract.totalInstallments !== undefined ? (
                <div>
                  <p className="text-xs uppercase tracking-wide text-text-muted">
                    Installments
                  </p>
                  <p className="mt-0.5 text-sm text-text-default">
                    {contract.remainingInstallments} of{" "}
                    {contract.totalInstallments} remaining
                  </p>
                  {contract.nextDueDate !== undefined ? (
                    <p className="text-xs text-text-muted">
                      Next due {formatDate(contract.nextDueDate, "short")}
                    </p>
                  ) : null}
                </div>
              ) : (
                <div>
                  <p className="text-xs uppercase tracking-wide text-text-muted">
                    Contract type
                  </p>
                  <p className="mt-0.5 text-sm text-text-default">
                    {contract.kind === "full_payment"
                      ? "Full payment"
                      : "Installment"}
                  </p>
                </div>
              )}
            </div>

            <p className="mt-3 text-right text-xs font-medium text-text-link">
              See particulars →
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}
