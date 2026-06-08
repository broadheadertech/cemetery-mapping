"use client";

/**
 * /admin/reconciliation — admin queue of OPEN reconciliation failures
 * (Story 5.5 follow-up, FR60 / NFR-R4).
 *
 * Admin-only. Middleware (`src/middleware.ts`) gates `/admin/*` at the
 * edge; `convex/reconciliation.ts` re-enforces every call server-side
 * via `requireRole(ctx, ["admin"])` per NFR-S4 (defense in depth).
 *
 * Surfaces:
 *   - Table of every un-acknowledged `reconciliationFailures` row
 *     sorted most-recently-discovered first. Columns: entity type,
 *     entity id, expected / actual amounts (cents), first / latest
 *     discovery timestamps, Acknowledge button.
 *   - Acknowledge action opens an inline note prompt and calls
 *     `acknowledgeReconciliationFailure` with the optional reason.
 *     Once acknowledged, the row drops out of the queue + the
 *     dashboard banner.
 *
 * Empty state: when no open failures exist, renders a friendly "All
 * clear" panel so the admin can confidently confirm the system is
 * healthy.
 *
 * The Convex `_generated/` ambient module is not committed in this
 * repo — we reference the functions via `makeFunctionReference`,
 * matching the other admin pages.
 */

import {
  useCallback,
  useMemo,
  useState,
  type ReactElement,
} from "react";

import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { formatPeso } from "@/lib/money";

interface ReconciliationFailureRow {
  _id: string;
  _creationTime: number;
  runId: string;
  entityType: "payment" | "contract" | "installment";
  entityId: string;
  expectedCents: number;
  actualCents: number;
  discoveredAt: number;
  firstDiscoveredAt: number;
  acknowledgedAt?: number;
  acknowledgedBy?: string;
  acknowledgmentNote?: string;
}

interface ListOpenResult {
  count: number;
  rows: ReconciliationFailureRow[];
}

const listOpenReconciliationFailuresRef = makeFunctionReference<
  "query",
  { limit?: number },
  ListOpenResult
>("reconciliation:listOpenReconciliationFailures");

const acknowledgeReconciliationFailureRef = makeFunctionReference<
  "mutation",
  { failureId: string; note?: string },
  void
>("reconciliation:acknowledgeReconciliationFailure");

const ENTITY_LABEL: Record<
  ReconciliationFailureRow["entityType"],
  string
> = {
  payment: "Payment",
  contract: "Contract",
  installment: "Installment",
};

function formatTimestamp(ms: number): string {
  // Manila tz wall-clock for the admin's local sanity.
  return new Date(ms).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function AdminReconciliationPage(): ReactElement {
  const failures = useQuery(listOpenReconciliationFailuresRef, {});
  const acknowledge = useMutation(acknowledgeReconciliationFailureRef);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const rows = failures?.rows ?? [];
  const count = failures?.count ?? 0;

  const openId = useMemo(() => activeId, [activeId]);

  const handleStartAcknowledge = useCallback((rowId: string) => {
    setActiveId(rowId);
    setNoteDraft("");
    setErrorMessage(null);
  }, []);

  const handleCancelAcknowledge = useCallback(() => {
    setActiveId(null);
    setNoteDraft("");
  }, []);

  const handleConfirmAcknowledge = useCallback(
    async (rowId: string) => {
      setBusyId(rowId);
      setErrorMessage(null);
      try {
        const trimmed = noteDraft.trim();
        await acknowledge({
          failureId: rowId,
          note: trimmed.length > 0 ? trimmed : undefined,
        });
        setActiveId(null);
        setNoteDraft("");
      } catch (err) {
        setErrorMessage(
          err instanceof Error
            ? err.message
            : "Failed to acknowledge failure. Please try again.",
        );
      } finally {
        setBusyId(null);
      }
    },
    [acknowledge, noteDraft],
  );

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Reconciliation failures
        </h1>
        <p className="max-w-2xl text-sm text-slate-600">
          Drift detected by the nightly reconciliation invariants is
          listed below. Each row stays open until an admin acknowledges
          it (with an optional explanatory note). Acknowledged rows
          drop out of this queue and the dashboard banner. The next
          cron run that re-detects the same drift will reopen the row
          for fresh attention.
        </p>
      </header>

      {failures === undefined ? (
        <p
          role="status"
          aria-live="polite"
          className="text-sm text-slate-500"
        >
          Loading reconciliation failures...
        </p>
      ) : count === 0 ? (
        <div
          role="status"
          data-testid="reconciliation-empty"
          className="rounded-md border border-emerald-200 bg-emerald-50 p-6 text-emerald-900"
        >
          <p className="text-base font-semibold">All clear.</p>
          <p className="mt-1 text-sm">
            No open reconciliation failures. The dashboard banner is
            currently dismissed.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-slate-200 bg-white shadow-sm">
          <table
            className="min-w-full divide-y divide-slate-200 text-sm"
            data-testid="reconciliation-failures-table"
          >
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th scope="col" className="px-3 py-2">
                  Entity
                </th>
                <th scope="col" className="px-3 py-2">
                  Entity id
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  Expected
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  Actual
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  Delta
                </th>
                <th scope="col" className="px-3 py-2">
                  First seen
                </th>
                <th scope="col" className="px-3 py-2">
                  Last seen
                </th>
                <th scope="col" className="px-3 py-2">
                  Action
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => {
                const delta = row.actualCents - row.expectedCents;
                const isActive = openId === row._id;
                return (
                  <tr
                    key={row._id}
                    data-testid={`reconciliation-failure-${row._id}`}
                    className="bg-white"
                  >
                    <td className="px-3 py-2 font-medium text-slate-900">
                      {ENTITY_LABEL[row.entityType]}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-700">
                      {row.entityId}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-900">
                      {formatPeso(row.expectedCents)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-900">
                      {formatPeso(row.actualCents)}
                    </td>
                    <td
                      className={
                        delta === 0
                          ? "px-3 py-2 text-right tabular-nums text-slate-600"
                          : "px-3 py-2 text-right font-semibold tabular-nums text-red-700"
                      }
                    >
                      {delta > 0 ? "+" : ""}
                      {formatPeso(Math.abs(delta))}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600">
                      {formatTimestamp(row.firstDiscoveredAt)}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600">
                      {formatTimestamp(row.discoveredAt)}
                    </td>
                    <td className="px-3 py-2">
                      {isActive ? (
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                          <label className="flex flex-col gap-1 text-xs text-slate-700">
                            <span>Note (optional, ≤ 500 chars)</span>
                            <textarea
                              value={noteDraft}
                              onChange={(e) => setNoteDraft(e.target.value)}
                              maxLength={500}
                              rows={2}
                              className="min-w-[16rem] rounded border border-slate-300 px-2 py-1 text-sm"
                              data-testid={`reconciliation-note-${row._id}`}
                            />
                          </label>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                handleConfirmAcknowledge(row._id)
                              }
                              disabled={busyId === row._id}
                              data-testid={`reconciliation-confirm-${row._id}`}
                              className="inline-flex min-h-[36px] items-center justify-center rounded-md bg-[#1D5C4D] px-3 py-1 text-xs font-medium text-white disabled:opacity-60"
                            >
                              {busyId === row._id
                                ? "Saving..."
                                : "Confirm"}
                            </button>
                            <button
                              type="button"
                              onClick={handleCancelAcknowledge}
                              disabled={busyId === row._id}
                              className="inline-flex min-h-[36px] items-center justify-center rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 disabled:opacity-60"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleStartAcknowledge(row._id)}
                          data-testid={`reconciliation-ack-${row._id}`}
                          className="inline-flex min-h-[36px] items-center justify-center rounded-md bg-red-700 px-3 py-1 text-xs font-medium text-white hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
                        >
                          Acknowledge
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {errorMessage !== null && (
        <p
          role="alert"
          data-testid="reconciliation-error"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
        >
          {errorMessage}
        </p>
      )}
    </div>
  );
}
