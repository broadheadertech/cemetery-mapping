"use client";

/**
 * /reports — admin reports index (Story 6.3).
 *
 * Card list of admin-grade reports. Phase 2 surfaces:
 *   - "Sales by dimension" (Story 6.3 — this file's first sibling)
 *   - "Audit log" (Story 6.5 — links to `/admin/audit-log`)
 *
 * Trend analysis (FR48) is admin-only and lives at `/admin/trends`.
 * The export hub (Story 6.4 "My exports") lands at
 * `/reports/exports`.
 *
 * The page is admin-only at the UI affordance level. Server-side, every
 * destination query enforces `requireRole(["admin"])` (NFR-S4 defense
 * in depth). Middleware also gates `/admin/*` at the edge.
 *
 * Card layout intentionally simple — UX § Mobile considerations
 * calls for the report list to be mobile-friendly. The cards are a
 * single-column stack on phone, two-column grid on tablet+.
 */

import Link from "next/link";
import { FileBarChart, Receipt, ListChecks, FolderOpen } from "lucide-react";

interface ReportCard {
  href: string;
  title: string;
  blurb: string;
  icon: React.ComponentType<{ className?: string }>;
  /** When set, the card is rendered disabled with the phase label. */
  comingSoon?: string;
}

const REPORTS: ReadonlyArray<ReportCard> = [
  {
    href: "/reports/sales",
    title: "Sales by dimension",
    blurb:
      "Sales broken down by lot type, then section. Drill into the underlying contracts.",
    icon: Receipt,
  },
  {
    href: "/admin/audit-log",
    title: "Audit log",
    blurb:
      "Every system action, filterable by actor, entity, and date range.",
    icon: ListChecks,
  },
  {
    href: "/reports/exports",
    title: "My exports",
    blurb:
      "Excel and PDF exports you have requested. Files are kept for 30 days.",
    icon: FolderOpen,
  },
  {
    href: "/admin/trends",
    title: "Trends",
    blurb:
      "Trailing-12-month sales, collections, expenses, and net position.",
    icon: FileBarChart,
  },
];

export default function ReportsIndexPage(): React.ReactElement {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Reports</h1>
        <p className="mt-1 text-sm text-slate-600">
          Admin-grade reports for the cemetery&apos;s accountant and
          auditor. Reports are reactive; refresh on its own as data
          changes.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {REPORTS.map((report) => {
          const Icon = report.icon;
          const disabled = report.comingSoon !== undefined;
          const body = (
            <div
              className={[
                "flex h-full flex-col gap-3 rounded-lg border bg-white p-5 transition-colors",
                disabled
                  ? "border-slate-200 opacity-60"
                  : "border-slate-200 hover:border-slate-400 hover:bg-slate-50",
              ].join(" ")}
              data-testid={`reports-card-${report.href.replace(/[^a-z0-9]+/gi, "-")}`}
            >
              <div className="flex items-center gap-3">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-slate-100 text-slate-700">
                  <Icon className="h-5 w-5" />
                </span>
                <h2 className="text-lg font-semibold text-slate-900">
                  {report.title}
                  {report.comingSoon !== undefined && (
                    <span className="ml-2 text-xs font-medium text-slate-500">
                      {report.comingSoon}
                    </span>
                  )}
                </h2>
              </div>
              <p className="text-sm text-slate-600">{report.blurb}</p>
            </div>
          );

          if (disabled) {
            return (
              <div
                key={report.href}
                aria-disabled="true"
                data-testid={`reports-disabled-${report.href}`}
              >
                {body}
              </div>
            );
          }

          return (
            <Link
              key={report.href}
              href={report.href}
              className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2"
            >
              {body}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
