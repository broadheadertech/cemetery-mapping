"use client";

/**
 * Customers list — Epic 2 (FR14). Staff-facing roster of every customer
 * record, linking to the per-customer detail page. Reactive: new
 * customers created from the sale flow or the create form appear live.
 *
 * Role gating: middleware + the `(staff)` layout gate the route;
 * `customers:listCustomers` enforces `requireRole(["admin","office_staff"])`
 * server-side. Gov-ID is shown last-4 only (non-identifying); the full
 * number stays behind the audited reveal on the detail page.
 */

import Link from "next/link";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

interface CustomerListRow {
  customerId: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  cityMunicipality: string | null;
  govIdType: string;
  govIdLast4: string;
  createdAt: number;
}

const listCustomersRef = makeFunctionReference<
  "query",
  { limit?: number },
  CustomerListRow[]
>("customers:listCustomers");

const DATE_FMT = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  dateStyle: "medium",
});

const GOV_ID_LABELS: Record<string, string> = {
  sss: "SSS",
  tin: "TIN",
  umid: "UMID",
  drivers_license: "Driver's License",
  passport: "Passport",
  philhealth: "PhilHealth",
  voters_id: "Voter's ID",
  other: "Gov ID",
};

export default function CustomersPage() {
  const customers = useQuery(listCustomersRef, {});

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl font-semibold tracking-tight">Customers</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Every customer the cemetery has on record. Press{" "}
            <kbd className="rounded border border-slate-300 bg-slate-50 px-1 text-xs">
              Ctrl K
            </kbd>{" "}
            to search, or open a row for the full profile, ownership
            history, and documents.
          </p>
        </div>
        <Link
          href="/customers/new"
          className="shrink-0 rounded-md bg-[#1D5C4D] px-4 py-2 text-sm font-medium text-white hover:bg-[#144437]"
          data-testid="customers-new-button"
        >
          New customer
        </Link>
      </div>

      <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
        {customers === undefined ? (
          <p className="p-6 text-sm text-slate-500" data-testid="customers-loading">
            Loading…
          </p>
        ) : customers.length === 0 ? (
          <p className="p-6 text-sm text-slate-500" data-testid="customers-empty">
            No customers yet. They&apos;re created from the sale flow or the
            customer form.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="customers-table">
              <thead>
                <tr className="border-b border-[#E1DAC8] bg-[#F6F2EA] font-mono text-[10px] uppercase tracking-[0.12em] text-[#8E8C85]">
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Phone</th>
                  <th className="px-4 py-3 font-medium">Email</th>
                  <th className="px-4 py-3 font-medium">City</th>
                  <th className="px-4 py-3 font-medium">Gov ID</th>
                  <th className="px-4 py-3 font-medium">Added</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {customers.map((c) => (
                  <tr key={c.customerId} data-testid="customers-row">
                    <td className="px-4 py-3 font-medium text-slate-800">
                      <Link
                        href={`/customers/${c.customerId}`}
                        className="text-emerald-800 underline-offset-2 hover:underline"
                      >
                        {c.fullName}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{c.phone ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-600">{c.email ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-600">
                      {c.cityMunicipality ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {(GOV_ID_LABELS[c.govIdType] ?? "Gov ID")} ····{c.govIdLast4}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate-600">
                      {DATE_FMT.format(new Date(c.createdAt))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
