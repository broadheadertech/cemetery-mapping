/**
 * /admin — administration hub.
 *
 * Landing page for the "Admin" sidebar entry. The cemetery has ~15
 * admin sub-pages (staff accounts, settings, compliance, operations)
 * that are not individually in the sidebar — this hub is their single
 * entry point. Pure links; `/admin/*` is admin-gated at the edge by
 * `src/middleware.ts`, so no client-side role check is needed here.
 */

import Link from "next/link";

interface AdminLink {
  href: string;
  title: string;
  description: string;
}

interface AdminGroup {
  heading: string;
  links: AdminLink[];
}

const GROUPS: AdminGroup[] = [
  {
    heading: "People & access",
    links: [
      {
        href: "/admin/users",
        title: "Staff accounts",
        description:
          "Create staff, grant / revoke roles (admin, office, field), deactivate accounts.",
      },
      {
        href: "/admin/sections",
        title: "Sections registry",
        description:
          "Named cemetery sections (chapel, garden, columbarium) used by the map and lots.",
      },
    ],
  },
  {
    heading: "Settings",
    links: [
      {
        href: "/admin/settings",
        title: "General settings",
        description: "Runtime toggles, e.g. sales-agent tracking.",
      },
      {
        href: "/admin/settings/perpetual-care",
        title: "Perpetual-care policy",
        description:
          "Per-lot-type perpetual-care fees applied at sale. Sales are blocked until this is configured.",
      },
      {
        href: "/admin/settings/bir-receipt-config",
        title: "BIR receipt config",
        description:
          "Registered name, TIN, ATP number, and serial range stamped on official receipts.",
      },
      {
        href: "/admin/settings/reminders",
        title: "Payment reminders",
        description:
          "Reminder cadence (days before / after due), channel, and the global pause switch.",
      },
      {
        href: "/admin/expense-approval-settings",
        title: "Expense approval rules",
        description:
          "Per-category approval thresholds — which expenses route to the approval queue.",
      },
      {
        href: "/admin/expense-categories",
        title: "Expense categories",
        description: "Manage the categories staff pick when recording expenses.",
      },
    ],
  },
  {
    heading: "Compliance & finance",
    links: [
      {
        href: "/admin/audit-log",
        title: "Audit log",
        description:
          "Append-only record of who changed what, when — and every PII access.",
      },
      {
        href: "/admin/reconciliation",
        title: "Reconciliation",
        description:
          "Daily financial-integrity check + any open drift requiring acknowledgement.",
      },
      {
        href: "/admin/archival-exports",
        title: "BIR archival exports",
        description:
          "Monthly 10-year-retention ledger exports; download or re-run a month.",
      },
      {
        href: "/admin/data-subject-reports",
        title: "Data-subject reports",
        description:
          "Generate a Data Privacy Act subject-access report for a customer.",
      },
      {
        href: "/admin/reports/email-bounces",
        title: "Bounced emails",
        description:
          "Customers whose reminder email hard-bounced — follow up by phone.",
      },
      {
        href: "/admin/trends",
        title: "Trend analysis",
        description: "Trailing-12-month sales, collections, expenses, and net.",
      },
    ],
  },
  {
    heading: "Operations",
    links: [
      {
        href: "/admin/expense-approvals",
        title: "Expense approvals",
        description: "Approve or reject expenses that exceeded the threshold.",
      },
      {
        href: "/admin/gps-import",
        title: "GPS geometry import",
        description:
          "Import surveyed lot polygons / centroids from a GPS data file.",
      },
    ],
  },
];

export default function AdminHubPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Administration</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Cemetery-wide configuration, compliance, and back-office tools.
          Everything here is admin-only.
        </p>
      </div>

      {GROUPS.map((group) => (
        <section key={group.heading} className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            {group.heading}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {group.links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="group rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition-colors hover:border-emerald-300 hover:bg-emerald-50/40"
                data-testid="admin-hub-link"
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-900">
                    {link.title}
                  </h3>
                  <span
                    aria-hidden="true"
                    className="text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-emerald-600"
                  >
                    →
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-600">
                  {link.description}
                </p>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
