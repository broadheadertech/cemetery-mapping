"use client";

/**
 * /enquiries — the queue of people waiting to hear back from us.
 *
 * Lives in `(staff)`, not `(staff)/admin`: answering a visit request
 * is office work. `convex/enquiries.ts` gates the queries and the
 * status mutation on `["admin", "office_staff"]`.
 *
 * The page is organised around one question — who has not been called
 * yet — so it opens on New and treats the count as the thing worth
 * seeing first. Contacted and Closed are there for looking back.
 *
 * The `notifyFailed` badge matters more than it looks. When it shows,
 * the enquiry arrived but the notification email did not go out, which
 * means nobody was told about this person except whoever is reading
 * this page right now. The underlying cause is in /admin/errors.
 */

import { useCallback, useState, type ReactElement } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { translateError } from "@/lib/errors";
import { formatDate } from "@/lib/time";

type EnquiryStatus = "new" | "contacted" | "closed";

interface EnquiryRow {
  id: string;
  kind: "visit" | "pricing";
  name: string;
  contact: string;
  preferredDate: string | null;
  preferredTime: string | null;
  purpose: string | null;
  lotTypeInterest: string | null;
  timing: string | null;
  notes: string | null;
  status: EnquiryStatus;
  createdAt: number;
  handledAt: number | null;
  notifyFailed: boolean;
}

const listEnquiriesRef = makeFunctionReference<
  "query",
  { status?: EnquiryStatus; limit?: number },
  EnquiryRow[]
>("enquiries:listEnquiries");

const countsRef = makeFunctionReference<
  "query",
  Record<string, never>,
  { new: number; contacted: number }
>("enquiries:getEnquiryCounts");

const updateStatusRef = makeFunctionReference<
  "mutation",
  { enquiryId: string; status: EnquiryStatus },
  { status: EnquiryStatus }
>("enquiries:updateEnquiryStatus");

const TABS: ReadonlyArray<{ id: EnquiryStatus; label: string }> = [
  { id: "new", label: "New" },
  { id: "contacted", label: "Contacted" },
  { id: "closed", label: "Closed" },
];

export default function EnquiriesPage(): ReactElement {
  const [tab, setTab] = useState<EnquiryStatus>("new");
  const [actionError, setActionError] = useState<string | null>(null);

  const rows = useQuery(listEnquiriesRef, { status: tab });
  const counts = useQuery(countsRef, {});
  const updateStatus = useMutation(updateStatusRef);

  const setStatus = useCallback(
    async (id: string, status: EnquiryStatus): Promise<void> => {
      setActionError(null);
      try {
        await updateStatus({ enquiryId: id, status });
      } catch (err) {
        setActionError(translateError(err).detail);
      }
    },
    [updateStatus],
  );

  const isLoading = rows === undefined;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Enquiries
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Visit requests and pricing questions from the website. Each one is a
          person waiting for a call back.
        </p>
      </header>

      <div className="flex flex-wrap gap-2" role="tablist">
        {TABS.map((t) => {
          const count =
            t.id === "new"
              ? counts?.new
              : t.id === "contacted"
                ? counts?.contacted
                : undefined;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-md border px-3 py-1.5 text-sm font-medium ${
                tab === t.id
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {t.label}
              {count !== undefined && count > 0 && (
                <span className="ml-1.5 text-xs opacity-80">{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {actionError !== null && (
        <div
          role="alert"
          data-testid="enquiries-action-error"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {actionError}
        </div>
      )}

      {isLoading && (
        <div className="rounded-md border border-slate-200 bg-white p-5 text-sm text-slate-600">
          Loading…
        </div>
      )}

      {!isLoading && rows.length === 0 && (
        <div
          data-testid="enquiries-empty"
          className="rounded-md border border-slate-200 bg-white p-5 text-sm text-slate-600"
        >
          {tab === "new"
            ? "Nobody is waiting. New website enquiries land here."
            : `No ${tab} enquiries.`}
        </div>
      )}

      {!isLoading && rows.length > 0 && (
        <ul className="space-y-3" data-testid="enquiries-list">
          {rows.map((row) => (
            <EnquiryCard
              key={row.id}
              row={row}
              onSetStatus={(status) => void setStatus(row.id, status)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function EnquiryCard({
  row,
  onSetStatus,
}: {
  row: EnquiryRow;
  onSetStatus: (status: EnquiryStatus) => void;
}): ReactElement {
  const details: Array<[string, string]> = [];
  if (row.preferredDate !== null) {
    details.push(["Preferred day", row.preferredDate]);
  }
  if (row.preferredTime !== null) {
    details.push(["Preferred time", row.preferredTime]);
  }
  if (row.purpose !== null) details.push(["Purpose", row.purpose]);
  if (row.lotTypeInterest !== null) {
    details.push(["Lot type", row.lotTypeInterest]);
  }
  if (row.timing !== null) details.push(["Timing", row.timing]);

  return (
    <li
      data-testid="enquiry-row"
      className="rounded-md border border-slate-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700">
              {row.kind === "visit" ? "Visit request" : "Pricing"}
            </span>
            {row.notifyFailed && (
              <span
                data-testid="enquiry-notify-failed"
                title="The notification email did not go out. Check /admin/errors."
                className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900"
              >
                Not emailed to the office
              </span>
            )}
          </div>

          <p className="mt-2 text-base font-medium text-slate-900">
            {row.name}
          </p>
          <p className="text-sm text-slate-700">{row.contact}</p>

          {details.length > 0 && (
            <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {details.map(([label, value]) => (
                <div key={label} className="flex gap-2">
                  <dt className="text-slate-500">{label}:</dt>
                  <dd className="text-slate-800">{value}</dd>
                </div>
              ))}
            </dl>
          )}

          {row.notes !== null && (
            <p className="mt-2 whitespace-pre-wrap border-l-2 border-slate-200 pl-3 text-sm text-slate-700">
              {row.notes}
            </p>
          )}

          <p className="mt-2 text-xs text-slate-500">
            Received {formatDate(row.createdAt, "datetime")}
            {row.handledAt !== null && (
              <> · updated {formatDate(row.handledAt, "datetime")}</>
            )}
          </p>
        </div>

        <div className="flex shrink-0 flex-col gap-2">
          {row.status !== "contacted" && (
            <button
              type="button"
              onClick={() => onSetStatus("contacted")}
              data-testid="enquiry-mark-contacted"
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Mark contacted
            </button>
          )}
          {row.status !== "closed" && (
            <button
              type="button"
              onClick={() => onSetStatus("closed")}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Close
            </button>
          )}
          {row.status === "closed" && (
            <button
              type="button"
              onClick={() => onSetStatus("new")}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Reopen
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
