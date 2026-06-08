"use client";

/**
 * Data-subject report viewer (Story 2.4).
 *
 * Renders the JSON payload returned by
 * `convex/dataSubject.ts → produceDataSubjectReport` in a readable,
 * sectioned layout, with a "Download JSON" affordance the admin can
 * hand to the requesting subject.
 *
 * The component is purely presentational — it accepts a fully-loaded
 * report object and a `customerId` for filenaming. All network /
 * mutation orchestration lives in the page that hosts it
 * (`src/app/(staff)/admin/data-subject-reports/page.tsx`).
 *
 * Why no PDF affordance: the rich PDF path is a follow-up — see
 * `convex/dataSubject.ts` header. Downloadable JSON is the AC4 surface
 * this story ships; the PDF affordance will land alongside Story 2.2 +
 * Story 2.5 once attachments and ownership history have on-disk
 * representations to embed.
 */

import { useMemo, type ReactElement } from "react";

import type { DataSubjectReport } from "./types";

export interface DataSubjectReportViewProps {
  report: DataSubjectReport;
}

export function DataSubjectReportView({
  report,
}: DataSubjectReportViewProps): ReactElement {
  // Pre-compute the pretty-printed JSON string once per report so we
  // don't pay the stringify cost on every download click. `useMemo`
  // is overkill for a single payload but keeps the affordance
  // accessible for very large reports (5000+ audit rows).
  const jsonText = useMemo(() => JSON.stringify(report, null, 2), [report]);

  const handleDownload = (): void => {
    // Blob + object-URL pattern — standard browser-side download.
    const blob = new Blob([jsonText], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `data-subject-report-${report.customer.customerId}-${report.generatedAt}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    // Release the URL on the next tick so the click has fired through.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <section
      aria-labelledby="data-subject-report-heading"
      data-testid="data-subject-report"
      className="space-y-6 rounded-md border border-slate-200 bg-white p-6"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="data-subject-report-heading"
            className="text-xl font-semibold text-slate-900"
          >
            Report for {report.customer.fullName}
          </h2>
          <p className="text-xs text-slate-500">
            Schema {report.schemaVersion} · generated{" "}
            {formatDateTime(report.generatedAt)}
          </p>
        </div>
        <button
          type="button"
          onClick={handleDownload}
          data-testid="download-json-button"
          className="rounded-md bg-[#1D5C4D] px-4 py-2 text-sm font-medium text-white hover:bg-[#144437]"
        >
          Download JSON
        </button>
      </header>

      <CustomerPanel section={report.customer} />
      <AuditTrailPanel
        title="Customer audit trail"
        description="Every audit-log entry referencing this customer, including this very export at the tail."
        entries={report.customerAuditTrail}
      />
      <AuditTrailPanel
        title="Actions taken by this customer"
        description="Events where this customer was the actor. Empty until customers have portal accounts (Epic 9)."
        entries={report.actsByCustomer}
      />
      <FollowUpsPanel followUps={report.followUps} />
      <JsonPanel jsonText={jsonText} />
    </section>
  );
}

function CustomerPanel({
  section,
}: {
  section: DataSubjectReport["customer"];
}): ReactElement {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
        Customer record
      </h3>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm md:grid-cols-2">
        <Row label="Full name" value={section.fullName} />
        <Row label="Phone" value={section.phone ?? "—"} />
        <Row label="Email" value={section.email ?? "—"} />
        <Row label="Gov ID type" value={section.govIdType} />
        <Row label="Gov ID number" value={section.govIdNumber} />
        <Row
          label="Relationship to occupant"
          value={section.relationshipToOccupant ?? "—"}
        />
        <Row label="Consent" value={section.hasConsent ? "Yes" : "No"} />
        <Row
          label="Consent timestamp"
          value={
            section.consentTimestamp !== null
              ? formatDateTime(section.consentTimestamp)
              : "—"
          }
        />
        <Row
          label="Address"
          value={formatAddress(section.address)}
          fullWidth
        />
        <Row label="Created at" value={formatDateTime(section.createdAt)} />
        <Row label="Updated at" value={formatDateTime(section.updatedAt)} />
      </dl>
    </div>
  );
}

function AuditTrailPanel({
  title,
  description,
  entries,
}: {
  title: string;
  description: string;
  entries: DataSubjectReport["customerAuditTrail"];
}): ReactElement {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          {title}
        </h3>
        <p className="text-xs text-slate-500">{description}</p>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-slate-500">No entries.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-[#F6F2EA] text-left font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8E8C85]">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Action</th>
                <th className="px-3 py-2">Entity</th>
                <th className="px-3 py-2">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {entries.map((entry, idx) => (
                <tr
                  key={`${entry.auditLogId}-${idx}`}
                  className="hover:bg-slate-50"
                >
                  <td className="px-3 py-2 text-slate-700">
                    {formatDateTime(entry.timestamp)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-700">
                    {entry.action}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-700">
                    {entry.entityType}:{entry.entityId}
                  </td>
                  <td className="px-3 py-2 text-slate-600">
                    {entry.reason ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FollowUpsPanel({
  followUps,
}: {
  followUps: DataSubjectReport["followUps"];
}): ReactElement {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
        Pending data sources
      </h3>
      <p className="text-xs text-slate-500">
        These domains do not yet have on-disk tables. When the
        corresponding stories land, the data will appear here in future
        reports.
      </p>
      <ul className="space-y-2 text-sm">
        {followUps.map((followUp) => (
          <li
            key={followUp.source}
            className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2"
          >
            <div className="font-medium text-amber-900">
              {followUp.source}
            </div>
            <div className="text-xs text-amber-800">{followUp.note}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function JsonPanel({ jsonText }: { jsonText: string }): ReactElement {
  return (
    <details className="rounded-md border border-slate-200 bg-slate-50">
      <summary className="cursor-pointer px-4 py-2 text-sm font-medium text-slate-700">
        Raw JSON payload
      </summary>
      <pre
        data-testid="report-json"
        className="overflow-x-auto px-4 py-2 text-xs text-slate-700"
      >
        {jsonText}
      </pre>
    </details>
  );
}

function Row({
  label,
  value,
  fullWidth,
}: {
  label: string;
  value: string;
  fullWidth?: boolean;
}): ReactElement {
  return (
    <div className={fullWidth === true ? "md:col-span-2" : undefined}>
      <dt className="text-xs uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="text-sm text-slate-900">{value}</dd>
    </div>
  );
}

function formatAddress(
  address: DataSubjectReport["customer"]["address"],
): string {
  const parts = [
    address.line1,
    address.barangay,
    address.cityMunicipality,
    address.province,
    address.postalCode,
  ].filter((p): p is string => p !== null && p.length > 0);
  return parts.length > 0 ? parts.join(", ") : "—";
}

function formatDateTime(ms: number): string {
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}
