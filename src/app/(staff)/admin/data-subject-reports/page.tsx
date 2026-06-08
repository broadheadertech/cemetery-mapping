"use client";

/**
 * /admin/data-subject-reports — admin-only data-subject report tool
 * (Story 2.4, FR63 / NFR-C3).
 *
 * Three-pane UI:
 *   1. Customer search — debounced fuzzy-name match via
 *      `customers.searchByName` (Story 2.1's last-4-only surface).
 *   2. Reason form — the operator types a 10+ char free-text reason.
 *      The audit trail will carry this verbatim; it answers "why was
 *      this subject's full record read?"
 *   3. Result panel — renders the report once the mutation resolves;
 *      offers a "Download JSON" button.
 *
 * Auth gates:
 *   - Middleware (`src/middleware.ts`) blocks non-admins from
 *     `/admin/*` at the edge.
 *   - The Convex `produceDataSubjectReport` mutation re-enforces
 *     admin-only via `requireRole(ctx, ["admin"])`. Both layers
 *     defend per NFR-S4.
 *
 * Because `convex/_generated/` is not yet built in this repo, Convex
 * function refs use `makeFunctionReference`, mirroring the pattern in
 * `/admin/users/page.tsx`.
 */

import { useState, type ReactElement } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { DataSubjectReportView } from "@/components/DataSubjectReport";
import type { DataSubjectReport } from "@/components/DataSubjectReport/types";
import { translateError } from "@/lib/errors";

interface CustomerSearchHit {
  customerId: string;
  fullName: string;
  govIdLast4: string;
}

const searchByNameRef = makeFunctionReference<
  "query",
  { q: string },
  CustomerSearchHit[]
>("customers:searchByName");

const produceReportRef = makeFunctionReference<
  "mutation",
  { customerId: string; reason: string },
  DataSubjectReport
>("dataSubject:produceDataSubjectReport");

const REASON_MIN_LENGTH = 10;

export default function DataSubjectReportsPage(): ReactElement {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCustomer, setSelectedCustomer] =
    useState<CustomerSearchHit | null>(null);
  const [reason, setReason] = useState("");
  const [report, setReport] = useState<DataSubjectReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Convex queries return `undefined` until the first response lands.
  // We pass the bare term — `searchByName` itself rejects sub-3-char
  // inputs early and returns `[]`, so the empty-needle case is the
  // server's problem, not ours.
  const searchHits = useQuery(searchByNameRef, { q: searchTerm });
  const produceReport = useMutation(produceReportRef);

  const trimmedReason = reason.trim();
  const reasonValid = trimmedReason.length >= REASON_MIN_LENGTH;
  const canSubmit =
    selectedCustomer !== null && reasonValid && submitting === false;

  const handleSelectCustomer = (hit: CustomerSearchHit): void => {
    setSelectedCustomer(hit);
    setReport(null);
    setError(null);
    setSearchTerm("");
  };

  const handleSubmit = async (): Promise<void> => {
    if (selectedCustomer === null) return;
    if (!reasonValid) return;
    setSubmitting(true);
    setError(null);
    setReport(null);
    try {
      const result = await produceReport({
        customerId: selectedCustomer.customerId,
        reason: trimmedReason,
      });
      setReport(result);
    } catch (err) {
      const translated = translateError(err);
      setError(translated.detail);
    } finally {
      setSubmitting(false);
    }
  };

  const handleClearCustomer = (): void => {
    setSelectedCustomer(null);
    setReport(null);
    setError(null);
    setReason("");
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Data subject reports
        </h1>
        <p className="max-w-3xl text-sm text-slate-600">
          Produce a complete report of all the data the system holds
          about a single customer. Every report is logged in the audit
          trail and shows up in the customer&apos;s own history.
          Required for Data Privacy Act (RA 10173) subject access
          requests.
        </p>
      </header>

      {error !== null && (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {error}
        </div>
      )}

      <section
        aria-labelledby="select-customer-heading"
        className="space-y-3 rounded-md border border-slate-200 bg-white p-6"
      >
        <h2
          id="select-customer-heading"
          className="text-sm font-semibold uppercase tracking-wide text-slate-500"
        >
          1. Select customer
        </h2>
        {selectedCustomer === null ? (
          <>
            <div className="space-y-1">
              <label
                htmlFor="customer-search"
                className="block text-sm font-medium text-slate-700"
              >
                Search by name
              </label>
              <input
                id="customer-search"
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Type 3+ letters of the customer's name"
                className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              />
              <p className="text-xs text-slate-500">
                Search results show only the last 4 of the
                government-ID number, never the full ID. Selecting a
                customer does not create an audit entry.
              </p>
            </div>
            <SearchResults
              hits={searchHits}
              onSelect={handleSelectCustomer}
              searchTerm={searchTerm}
            />
          </>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
            <div>
              <div className="text-sm font-medium text-slate-900">
                {selectedCustomer.fullName}
              </div>
              <div className="text-xs text-slate-500">
                Gov ID ending ***-***-{selectedCustomer.govIdLast4}
              </div>
            </div>
            <button
              type="button"
              onClick={handleClearCustomer}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Change customer
            </button>
          </div>
        )}
      </section>

      <section
        aria-labelledby="reason-heading"
        className="space-y-3 rounded-md border border-slate-200 bg-white p-6"
      >
        <h2
          id="reason-heading"
          className="text-sm font-semibold uppercase tracking-wide text-slate-500"
        >
          2. Record the reason
        </h2>
        <div className="space-y-1">
          <label
            htmlFor="report-reason"
            className="block text-sm font-medium text-slate-700"
          >
            Why are you producing this report?
          </label>
          <textarea
            id="report-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="e.g. Subject access request received via email on 2026-05-19. Ticket #DSR-2026-0042."
            className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
          <p className="text-xs text-slate-500">
            Minimum {REASON_MIN_LENGTH} characters. Stored in the audit
            trail — written to the report itself and visible to the
            requesting subject.
          </p>
        </div>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={handleSubmit}
          data-testid="generate-report-button"
          className="rounded-md bg-[#1D5C4D] px-4 py-2 text-sm font-medium text-white hover:bg-[#144437] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "Generating…" : "Generate report"}
        </button>
      </section>

      {report !== null && (
        <section aria-labelledby="result-heading">
          <h2 id="result-heading" className="sr-only">
            Result
          </h2>
          <DataSubjectReportView report={report} />
        </section>
      )}
    </div>
  );
}

function SearchResults({
  hits,
  onSelect,
  searchTerm,
}: {
  hits: CustomerSearchHit[] | undefined;
  onSelect: (hit: CustomerSearchHit) => void;
  searchTerm: string;
}): ReactElement | null {
  if (searchTerm.trim().length < 3) {
    return null;
  }
  if (hits === undefined) {
    return (
      <p className="text-sm text-slate-500" data-testid="search-loading">
        Searching…
      </p>
    );
  }
  if (hits.length === 0) {
    return (
      <p className="text-sm text-slate-500" data-testid="search-empty">
        No matching customers.
      </p>
    );
  }
  return (
    <ul
      className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white"
      data-testid="search-results"
    >
      {hits.map((hit) => (
        <li key={hit.customerId}>
          <button
            type="button"
            onClick={() => onSelect(hit)}
            className="flex w-full items-center justify-between px-4 py-2 text-left text-sm hover:bg-slate-50"
          >
            <span className="font-medium text-slate-900">
              {hit.fullName}
            </span>
            <span className="font-mono text-xs text-slate-500">
              ***-***-{hit.govIdLast4}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
