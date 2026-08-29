"use client";

/**
 * Where this sale came from.
 *
 * One optional field, and the whole enquiry-conversion analysis rests
 * on somebody filling it in. Until it is filled in routinely, every
 * conversion figure the park sees is a floor rather than a truth — a
 * sale nobody linked looks exactly like an enquiry that went nowhere,
 * and a park reading that as a marketing failure would be reading its
 * own paperwork habit.
 *
 * So the list is short, recent, and open-only. Asking somebody to scroll
 * a year of enquiries at the counter is asking them not to bother.
 *
 * @gated-route-only — renders inside `SaleForm` on `/sales/new`;
 * middleware keeps field workers off the `/sales` family.
 */

import { type ReactElement } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

interface EnquiryView {
  id: string;
  kind: "visit" | "pricing";
  name: string;
  contact: string;
  status: "new" | "contacted" | "closed";
  createdAt: number;
}

const listEnquiriesRef = makeFunctionReference<
  "query",
  { status?: "new" | "contacted" | "closed"; limit?: number },
  EnquiryView[]
>("enquiries:listEnquiries");

export interface EnquiryPickerProps {
  value: string;
  onChange: (enquiryId: string) => void;
}

export function EnquiryPicker({
  value,
  onChange,
}: EnquiryPickerProps): ReactElement {
  // Contacted rather than new: an enquiry that turned into a sale was
  // almost certainly spoken to first. Untouched ones stay on the
  // enquiries list where somebody still needs to answer them.
  const contacted = useQuery(listEnquiriesRef, {
    status: "contacted",
    limit: 50,
  });
  const fresh = useQuery(listEnquiriesRef, { status: "new", limit: 50 });

  if (contacted === undefined || contacted === null) {
    return <p className="text-sm text-slate-500">Loading enquiries&hellip;</p>;
  }

  const options = [...contacted, ...(fresh ?? [])].sort(
    (a, b) => b.createdAt - a.createdAt,
  );

  if (options.length === 0) {
    return (
      <p data-testid="enquiry-picker-none" className="text-xs text-slate-500">
        No open enquiries to link this sale to.
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-slate-700">
          Came from an enquiry
        </span>
        <select
          value={value}
          data-testid="enquiry-picker"
          onChange={(e) => onChange(e.target.value)}
          className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        >
          <option value="">Not from an enquiry</option>
          {options.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} &middot; {e.kind === "visit" ? "visit" : "pricing"}{" "}
              &middot; {formatDay(e.createdAt)}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-slate-500">
        Optional, but it is the only way the park can tell which enquiries
        turn into sales.
      </p>
    </div>
  );
}

function formatDay(ms: number): string {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    day: "numeric",
    month: "short",
  }).format(new Date(ms));
}
