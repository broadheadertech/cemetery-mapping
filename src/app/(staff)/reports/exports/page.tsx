"use client";

/**
 * /reports/exports — My exports listing (Story 6.4, FR46 AC4).
 *
 * Lists the admin's export history (most-recent first) via
 * `exports:listMyExports`. Each row shows:
 *
 *   - report type label
 *   - format (Excel / PDF)
 *   - status (pending / ready / failed / expired)
 *   - requested-at + ready-at timestamps
 *   - download / retry action (when applicable)
 *
 * Auth: middleware gates `/reports/*` for admin; the underlying
 * `listMyExports` query also calls `requireRole(["admin"])`.
 *
 * The download button reuses the `<ExportSheet>` workflow — clicking
 * a "ready" row opens the sheet (so the same download path covers
 * "I just exported it" + "I exported it yesterday and want to grab
 * it again").
 */

import { useState } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { formatDate } from "@/lib/time";
import { ExportSheet } from "@/components/ExportSheet";

interface ExportRow {
  _id: string;
  reportType: "sales_by_dimension" | "ar_aging" | "audit_log";
  format: "xlsx" | "pdf";
  status: "pending" | "ready" | "failed" | "expired";
  requestedAt: number;
  readyAt: number | null;
  downloadCount: number;
  retryCount: number;
  lastError: string | null;
}

const listMyExportsRef = makeFunctionReference<
  "query",
  { limit?: number },
  { exports: ExportRow[] }
>("exports:listMyExports");

const REPORT_LABEL: Record<ExportRow["reportType"], string> = {
  sales_by_dimension: "Sales by dimension",
  ar_aging: "AR aging summary",
  audit_log: "Audit log",
};

// Matches `ExportSheet.tsx → FORMAT_LABEL` exactly. The xlsx-format
// rows are CSV bytes for Phase 1 (zero new npm deps; see
// `convex/actions/generateReportExport.ts` for the Phase 2 reservation
// around real `exceljs`), so the label must say so. Keeping the two
// labels in lockstep avoids the cross-page confusion called out in
// the adversarial review (P1-8).
const FORMAT_LABEL: Record<ExportRow["format"], string> = {
  xlsx: "Excel (CSV)",
  pdf: "PDF",
};

const STATUS_CLASS: Record<ExportRow["status"], string> = {
  pending: "bg-slate-100 text-slate-700 border-slate-200",
  ready: "bg-emerald-50 text-emerald-800 border-emerald-200",
  failed: "bg-rose-50 text-rose-900 border-rose-200",
  expired: "bg-amber-50 text-amber-900 border-amber-200",
};

const STATUS_LABEL: Record<ExportRow["status"], string> = {
  pending: "Preparing",
  ready: "Ready",
  failed: "Failed",
  expired: "Expired",
};

export default function MyExportsPage(): React.ReactElement {
  const result = useQuery(listMyExportsRef, { limit: 50 });
  const [activeId, setActiveId] = useState<string | null>(null);

  const isLoading = result === undefined;
  const rows = result?.exports ?? [];
  const isEmpty = rows.length === 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">My exports</h1>
        <p className="mt-1 text-sm text-slate-600">
          Excel and PDF exports you have requested. Files are kept for
          30 days; re-run a report to generate a fresh export.
        </p>
      </div>

      {isLoading && (
        <div
          className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500"
          data-testid="my-exports-loading"
        >
          Loading exports…
        </div>
      )}

      {!isLoading && isEmpty && (
        <div
          className="rounded-md border border-slate-200 bg-white p-8 text-center"
          data-testid="my-exports-empty"
        >
          <p className="text-sm text-slate-600">
            You haven&apos;t exported any reports yet. Open a report
            (Sales, AR aging, Audit log) and click Export to generate
            one.
          </p>
        </div>
      )}

      {!isLoading && !isEmpty && (
        <div
          className="overflow-x-auto rounded-md border border-slate-200 bg-white"
          data-testid="my-exports-table"
        >
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Report</th>
                <th className="px-4 py-3">Format</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Requested</th>
                <th className="px-4 py-3">Ready</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row._id} data-testid={`my-exports-row-${row._id}`}>
                  <td className="px-4 py-3 font-medium text-slate-900">
                    {REPORT_LABEL[row.reportType]}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {FORMAT_LABEL[row.format]}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[row.status]}`}
                    >
                      {STATUS_LABEL[row.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {formatDate(row.requestedAt, "short")}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {row.readyAt !== null
                      ? formatDate(row.readyAt, "short")
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setActiveId(row._id)}
                      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      data-testid={`my-exports-open-${row._id}`}
                    >
                      {row.status === "ready" ? "Download" : "View"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeId !== null && (
        <ExportSheet
          exportId={activeId}
          onClose={() => setActiveId(null)}
        />
      )}
    </div>
  );
}
