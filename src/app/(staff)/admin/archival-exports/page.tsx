"use client";

/**
 * /admin/archival-exports — admin index of monthly archival exports
 * (Story 5.7, FR62 / NFR-R3 / NFR-C2).
 *
 * Admin-only. Middleware (`src/middleware.ts`) gates `/admin/*` at
 * the edge; `convex/archivalExports.ts` re-enforces every call
 * server-side via `requireRole(ctx, ["admin"])` per NFR-S4 (defense
 * in depth).
 *
 * Surfaces:
 *   - Table of every `archivalExports` row ordered by `period`
 *     descending. Columns: period, record counts (R/P/C/Co), gzipped
 *     size, exported-at timestamp, S3 status badge, Download.
 *   - "Re-run for period" form at the top — admin enters a `YYYY-MM`
 *     period and submits to schedule a fresh export action (via the
 *     `triggerArchivalExport` mutation in `convex/archivalExports.ts`).
 *     Useful for backfills + failure recovery.
 *
 * Download flow: clicking the row's Download button calls the
 * `getDownloadUrl` query for that row, which returns the short-lived
 * signed URL (NFR-S3 — never the raw `storageId`). The URL is
 * opened in a new tab; the browser handles the gzip download.
 *
 * The Convex `_generated/` ambient module is not committed in this
 * repo — we reference the functions via `makeFunctionReference`,
 * matching `/admin/audit-log`, `/admin/expense-approvals`, etc.
 */

import { useCallback, useState, type FormEvent, type ReactElement } from "react";
import { useConvex, useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

interface ArchivalExportListRow {
  _id: string;
  _creationTime: number;
  period: string;
  sha256: string;
  sizeBytesUncompressed: number;
  sizeBytesCompressed: number;
  recordCounts: {
    receipts: number;
    payments: number;
    customers: number;
    contracts: number;
  };
  exportedAt: number;
  s3Status: "uploaded" | "failed" | "skipped" | null;
  s3Etag: string | null;
  s3UploadedAt: number | null;
  s3ErrorMessage: string | null;
}

const listExportsRef = makeFunctionReference<
  "query",
  Record<string, never>,
  ArchivalExportListRow[]
>("archivalExports:listExports");

const getDownloadUrlRef = makeFunctionReference<
  "query",
  { exportId: string },
  { url: string | null; period: string | null }
>("archivalExports:getDownloadUrl");

const triggerArchivalExportRef = makeFunctionReference<
  "mutation",
  { period: string },
  { scheduled: true; period: string }
>("archivalExports:triggerArchivalExport");

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatExportedAt(ms: number): string {
  // Render in Manila local tz; consistent with `/admin/audit-log`'s
  // approach for timestamp formatting. Distinct from `formatPeriod`
  // which renders the YYYY-MM period.
  const manila = new Date(ms + MANILA_OFFSET_MS);
  const yyyy = manila.getUTCFullYear().toString().padStart(4, "0");
  const mm = (manila.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = manila.getUTCDate().toString().padStart(2, "0");
  const hh = manila.getUTCHours().toString().padStart(2, "0");
  const mi = manila.getUTCMinutes().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi} (Manila)`;
}

interface S3BadgeProps {
  status: "uploaded" | "failed" | "skipped" | null;
}

function S3StatusBadge({ status }: S3BadgeProps): ReactElement {
  if (status === null) {
    return (
      <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
        Pending
      </span>
    );
  }
  if (status === "uploaded") {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
        S3 uploaded
      </span>
    );
  }
  if (status === "skipped") {
    return (
      <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
        S3 skipped
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-700">
      S3 failed
    </span>
  );
}

interface DownloadButtonProps {
  exportId: string;
}

function DownloadButton({ exportId }: DownloadButtonProps): ReactElement {
  const convex = useConvex();
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await convex.query(getDownloadUrlRef, { exportId });
      if (result.url === null) {
        throw new Error("Archive blob is not available.");
      }
      // Open in a new tab — the browser handles the gzip download.
      window.open(result.url, "_blank", "noopener,noreferrer");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [convex, exportId]);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className="inline-flex min-h-[36px] items-center justify-center rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? "Loading..." : "Download"}
      </button>
      {error !== null ? (
        <span role="alert" className="text-xs text-rose-700">
          {error}
        </span>
      ) : null}
    </div>
  );
}

interface RerunFormState {
  period: string;
  busy: boolean;
  error: string | null;
  success: string | null;
}

export default function AdminArchivalExportsPage(): ReactElement {
  const exports_ = useQuery(listExportsRef, {});
  const triggerExport = useMutation(triggerArchivalExportRef);

  const [form, setForm] = useState<RerunFormState>({
    period: "",
    busy: false,
    error: null,
    success: null,
  });

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const period = form.period.trim();
      if (!/^\d{4}-\d{2}$/.test(period)) {
        setForm((prev) => ({
          ...prev,
          error: 'Period must be in "YYYY-MM" format (e.g. "2026-05").',
          success: null,
        }));
        return;
      }
      setForm((prev) => ({ ...prev, busy: true, error: null, success: null }));
      try {
        await triggerExport({ period });
        setForm((prev) => ({
          ...prev,
          busy: false,
          success: `Archival export scheduled for ${period}. The new row will appear within a few seconds.`,
        }));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setForm((prev) => ({
          ...prev,
          busy: false,
          error: message,
        }));
      }
    },
    [form.period, triggerExport],
  );

  const isLoading = exports_ === undefined;
  const rows: ArchivalExportListRow[] = exports_ ?? [];

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Archival exports</h1>
        <p className="max-w-3xl text-sm text-slate-600">
          Monthly BIR archival exports of receipts, payments, customers, and
          contracts. The cron runs at 04:00 Manila on the 1st of each month
          and exports the prior month&apos;s data as gzipped JSON. Files are
          retained for ten years in Convex File Storage and optionally
          mirrored to an S3-compatible bucket. See the runbook for the S3
          lifecycle policy that backs the long-tail retention requirement.
        </p>
      </header>

      <section
        aria-labelledby="rerun-heading"
        className="rounded-md border border-slate-200 bg-white p-4"
      >
        <h2
          id="rerun-heading"
          className="text-base font-semibold text-slate-900"
        >
          Re-run for period
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Use this form to backfill a missed month or to retry an export that
          failed. The action is idempotent — a successful row will not be
          overwritten unless its previous run failed.
        </p>
        <form
          onSubmit={handleSubmit}
          className="mt-3 flex flex-wrap items-end gap-3"
        >
          <div className="flex flex-col">
            <label
              htmlFor="rerun-period"
              className="text-xs font-medium text-slate-700"
            >
              Period (YYYY-MM)
            </label>
            <input
              id="rerun-period"
              type="text"
              inputMode="numeric"
              placeholder="2026-05"
              value={form.period}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, period: e.target.value }))
              }
              className="mt-1 w-40 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              pattern="\d{4}-\d{2}"
              maxLength={7}
              required
            />
          </div>
          <button
            type="submit"
            disabled={form.busy}
            className="inline-flex min-h-[36px] items-center justify-center rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {form.busy ? "Scheduling..." : "Run archival export now"}
          </button>
        </form>
        {form.error !== null ? (
          <p role="alert" className="mt-2 text-sm text-rose-700">
            {form.error}
          </p>
        ) : null}
        {form.success !== null ? (
          <p role="status" className="mt-2 text-sm text-emerald-700">
            {form.success}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="exports-heading" className="space-y-3">
        <h2
          id="exports-heading"
          className="text-base font-semibold text-slate-900"
        >
          Recent exports
        </h2>
        {isLoading ? (
          <p className="text-sm text-slate-600">Loading exports...</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-600">
            No archival exports yet. The first export will run on the 1st of
            next month, or you can trigger one manually above.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
                <tr>
                  <th className="px-3 py-2 text-left">Period</th>
                  <th className="px-3 py-2 text-left">Records (R / P / C / Co)</th>
                  <th className="px-3 py-2 text-left">Size (gzipped)</th>
                  <th className="px-3 py-2 text-left">Exported</th>
                  <th className="px-3 py-2 text-left">S3</th>
                  <th className="px-3 py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-900">
                {rows.map((r) => (
                  <tr key={r._id}>
                    <td className="px-3 py-2 font-medium">{r.period}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {r.recordCounts.receipts} / {r.recordCounts.payments} /{" "}
                      {r.recordCounts.customers} / {r.recordCounts.contracts}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {formatBytes(r.sizeBytesCompressed)}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600">
                      {formatExportedAt(r.exportedAt)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-1">
                        <S3StatusBadge status={r.s3Status} />
                        {r.s3Status === "failed" &&
                        r.s3ErrorMessage !== null ? (
                          <span className="text-xs text-rose-700">
                            {r.s3ErrorMessage}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <DownloadButton exportId={r._id} />
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
