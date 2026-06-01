"use client";

/**
 * /follow-ups — open follow-up actions list (Story 4.2).
 *
 * Reactive listing of every `open` follow-up action across the
 * cemetery, sorted by `dueAt` ascending so the earliest-due rows render
 * first. Office Staff uses this list to triage the missed-payment
 * recovery queue ("what do I need to follow up on today?").
 *
 * Each row carries an installment id; office staff can drill back to
 * the contract detail page once Story 4.8 wires the AR aging
 * drill-down. Per the file-ownership boundary on this story, the
 * contract detail page wiring lives in a follow-on story.
 *
 * Auth: the (staff) layout protects the route. Per-role enforcement
 * (`office_staff` / `admin`) lives inside the underlying Convex query.
 */

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { formatDate } from "@/lib/time";
import {
  FOLLOW_UP_ACTION_LABELS,
  type FollowUpActionChannel,
  FollowUpActionForm,
  type FollowUpSubmitPayload,
} from "@/components/FollowUpActionForm";

interface FollowUpRow {
  followUpActionId: string;
  installmentId: string;
  action: FollowUpActionChannel;
  notes: string | undefined;
  dueAt: number;
  status: "open" | "completed" | "cancelled";
  createdAt: number;
}

const listOpenFollowUpsRef = makeFunctionReference<
  "query",
  Record<string, never>,
  FollowUpRow[]
>("followUpActions:listOpenFollowUps");

const markCompleteRef = makeFunctionReference<
  "mutation",
  { followUpActionId: string },
  { followUpActionId: string }
>("followUpActions:markComplete");

const markCancelledRef = makeFunctionReference<
  "mutation",
  { followUpActionId: string },
  { followUpActionId: string }
>("followUpActions:markCancelled");

const createFollowUpRef = makeFunctionReference<
  "mutation",
  {
    installmentId: string;
    action: FollowUpActionChannel;
    dueAt: number;
    notes?: string;
  },
  { followUpActionId: string }
>("followUpActions:createFollowUp");

function isOverdue(dueAt: number): boolean {
  return dueAt < Date.now();
}

export default function FollowUpsListPage() {
  const rows = useQuery(listOpenFollowUpsRef, {});
  const markComplete = useMutation(markCompleteRef);
  const markCancelled = useMutation(markCancelledRef);
  const createFollowUp = useMutation(createFollowUpRef);

  const [installmentId, setInstallmentId] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const isLoading = rows === undefined;
  const isEmpty = rows !== undefined && rows.length === 0;

  async function handleSubmit(payload: FollowUpSubmitPayload) {
    setSubmitError(null);
    const trimmed = installmentId.trim();
    if (trimmed.length === 0) {
      setSubmitError("Installment id is required.");
      throw new Error("Installment id is required.");
    }
    const args: {
      installmentId: string;
      action: FollowUpActionChannel;
      dueAt: number;
      notes?: string;
    } = {
      installmentId: trimmed,
      action: payload.action,
      dueAt: payload.dueAt,
    };
    if (payload.notes !== undefined) {
      args.notes = payload.notes;
    }
    await createFollowUp(args);
    setInstallmentId("");
    setShowForm(false);
  }

  async function handleComplete(id: string) {
    setPendingId(id);
    try {
      await markComplete({ followUpActionId: id });
    } finally {
      setPendingId(null);
    }
  }

  async function handleCancel(id: string) {
    setPendingId(id);
    try {
      await markCancelled({ followUpActionId: id });
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Follow-ups</h1>
        <button
          type="button"
          onClick={() => setShowForm((s) => !s)}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          data-testid="follow-ups-new-toggle"
        >
          {showForm ? "Close form" : "Log follow-up"}
        </button>
      </div>

      <p className="text-sm text-slate-600">
        Open follow-up actions on overdue installments. Mark complete when
        the planned action is done; cancel when the underlying installment
        is settled or the follow-up is no longer relevant.
      </p>

      {showForm && (
        <div className="rounded-md border border-slate-200 bg-white p-4">
          <h2 className="text-lg font-semibold text-slate-900">
            Log a follow-up
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Paste the installment id from the contract detail page. The
            installment must currently be in the &ldquo;overdue&rdquo;
            state.
          </p>
          <div className="mt-3">
            <label
              htmlFor="follow-ups-installment-id"
              className="block text-sm font-medium text-slate-700"
            >
              Installment id
            </label>
            <input
              id="follow-ups-installment-id"
              type="text"
              value={installmentId}
              onChange={(e) => setInstallmentId(e.target.value)}
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              data-testid="follow-ups-installment-id-input"
              placeholder="installments:..."
            />
          </div>
          {submitError !== null && (
            <p
              role="alert"
              data-testid="follow-ups-create-error"
              className="mt-2 text-sm text-red-700"
            >
              {submitError}
            </p>
          )}
          <div className="mt-4">
            <FollowUpActionForm
              onSubmit={handleSubmit}
              onCancel={() => setShowForm(false)}
            />
          </div>
        </div>
      )}

      {isLoading && (
        <div
          data-testid="follow-ups-loading"
          className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500"
        >
          Loading follow-ups…
        </div>
      )}

      {isEmpty && (
        <div className="rounded-md border border-slate-200 bg-white p-8 text-center">
          <p className="text-sm text-slate-600">
            No open follow-up actions. Log one above to start the queue.
          </p>
        </div>
      )}

      {rows !== undefined && rows.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Due</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Notes</th>
                <th className="px-4 py-3">Installment</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => {
                const overdue = isOverdue(row.dueAt);
                const isPending = pendingId === row.followUpActionId;
                return (
                  <tr
                    key={row.followUpActionId}
                    data-testid={`follow-up-row-${row.followUpActionId}`}
                    className="hover:bg-slate-50"
                  >
                    <td className="px-4 py-3 font-medium">
                      <span
                        className={
                          overdue
                            ? "text-red-700"
                            : "text-slate-900"
                        }
                      >
                        {formatDate(row.dueAt, "short")}
                      </span>
                      {overdue && (
                        <span className="ml-2 text-xs text-red-700">
                          overdue
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {FOLLOW_UP_ACTION_LABELS[row.action]}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {row.notes ?? (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">
                      {row.installmentId}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => handleComplete(row.followUpActionId)}
                          disabled={isPending}
                          className="min-h-[36px] rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
                          data-testid={`follow-up-complete-${row.followUpActionId}`}
                        >
                          Complete
                        </button>
                        <button
                          type="button"
                          onClick={() => handleCancel(row.followUpActionId)}
                          disabled={isPending}
                          className="min-h-[36px] rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                          data-testid={`follow-up-cancel-${row.followUpActionId}`}
                        >
                          Cancel
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
