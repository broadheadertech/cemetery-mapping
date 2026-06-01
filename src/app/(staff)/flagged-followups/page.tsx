"use client";

/**
 * /flagged-followups — read-only list of currently-flagged contracts
 * (Story 5.3 AC3, drill-down destination for the dashboard's
 * "Flagged for Follow-up" tile).
 *
 * Scope:
 *   - This page is a NAVIGATION destination, not a flag-management UI.
 *     Editing / resolving / dismissing flags is owned by Story 5.4 (the
 *     contract detail page's flag card already lives there). Each row
 *     here is a link into the underlying contract detail page.
 *   - The `status` query param is reserved for a future filter (open
 *     vs. resolved) once a "resolved" lifecycle exists. Today every
 *     row returned by `contracts:listFlaggedContracts` is by definition
 *     open (the query filters on `isFlagged === true`), so the default
 *     `status=open` matches the only state we render.
 *
 * Architecture:
 *   - URL is the source of truth (Story 5.3 AC5).
 *   - `requireRole(ctx, ["admin", "office_staff"])` is enforced inside
 *     the underlying `contracts:listFlaggedContracts` query (Story 5.4).
 *   - Indexed via `by_isFlagged` — bounded scan on the flagged subset.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { formatPeso } from "@/lib/money";
import { formatDate } from "@/lib/time";

interface FlaggedContractRow {
  contractId: string;
  contractNumber: string;
  lotId: string;
  lotCode: string;
  customerId: string;
  customerFullName: string;
  kind: "full_payment" | "installment";
  totalPriceCents: number;
  state:
    | "active"
    | "paid_in_full"
    | "cancelled"
    | "voided"
    | "in_default";
  createdAt: number;
  flagReason: string;
  flaggedAt: number;
  flaggedByName: string;
}

const listFlaggedContractsRef = makeFunctionReference<
  "query",
  Record<string, never>,
  FlaggedContractRow[]
>("contracts:listFlaggedContracts");

const STATUS_LABEL: Record<string, string | undefined> = {
  open: "Open",
  resolved: "Resolved",
  all: "All",
};

function resolveStatusLabel(raw: string): string {
  return STATUS_LABEL[raw] ?? STATUS_LABEL.open ?? "Open";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export default function FlaggedFollowupsListPage() {
  const searchParams = useSearchParams();
  const statusParam = searchParams.get("status") ?? "open";
  const statusLabel = resolveStatusLabel(statusParam);

  const rows = useQuery(listFlaggedContractsRef, {});
  const isLoading = rows === undefined;
  const isEmpty = rows !== undefined && rows.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">
          Flagged for Follow-up
        </h1>
        <Link
          href="/dashboard"
          className="text-sm font-medium text-slate-600 hover:text-slate-900"
          data-testid="flagged-followups-back-to-dashboard"
        >
          ← Back to dashboard
        </Link>
      </div>

      <p
        className="text-sm text-slate-600"
        data-testid="flagged-followups-banner"
      >
        Showing <strong>{statusLabel.toLowerCase()}</strong> follow-up flags.
        Each row links into the underlying contract — resolving a flag is
        done from the contract detail page.
      </p>

      {isLoading && (
        <div
          data-testid="flagged-followups-loading"
          className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500"
        >
          Loading flags…
        </div>
      )}

      {isEmpty && (
        <div
          className="rounded-md border border-slate-200 bg-white p-8 text-center"
          data-testid="flagged-followups-empty"
        >
          <p className="text-sm text-slate-600">
            No open flags. Nothing waiting.
          </p>
        </div>
      )}

      {rows !== undefined && rows.length > 0 && (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-md border border-slate-200 bg-white md:block">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Flagged</th>
                  <th className="px-4 py-3">Contract</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Comment</th>
                  <th className="px-4 py-3">Flagged by</th>
                  <th className="px-4 py-3 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr
                    key={r.contractId}
                    className="hover:bg-slate-50"
                    data-testid={`flagged-followups-row-${r.contractId}`}
                  >
                    <td className="px-4 py-3 text-slate-600">
                      {formatDate(r.flaggedAt, "short")}
                    </td>
                    <td className="px-4 py-3 font-medium text-slate-900">
                      <Link
                        href={`/contracts/${r.contractId}`}
                        className="underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
                        data-testid={`flagged-followups-link-${r.contractId}`}
                      >
                        {r.contractNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {r.customerFullName}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {truncate(r.flagReason, 80)}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {r.flaggedByName}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-900">
                      {formatPeso(r.totalPriceCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-3 md:hidden">
            {rows.map((r) => (
              <Link
                key={r.contractId}
                href={`/contracts/${r.contractId}`}
                className="block rounded-md border border-slate-200 bg-white p-4 hover:bg-slate-50"
                data-testid={`flagged-followups-card-${r.contractId}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-slate-900">
                      {r.contractNumber}
                    </p>
                    <p className="text-xs text-slate-500">
                      {r.customerFullName}
                    </p>
                  </div>
                  <p className="text-sm font-medium tabular-nums text-slate-900">
                    {formatPeso(r.totalPriceCents)}
                  </p>
                </div>
                <p className="mt-2 text-xs text-slate-600">
                  {truncate(r.flagReason, 100)}
                </p>
                <p className="mt-2 text-xs text-slate-500">
                  Flagged {formatDate(r.flaggedAt, "short")} by{" "}
                  {r.flaggedByName}
                </p>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
