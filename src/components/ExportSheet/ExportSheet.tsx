"use client";

/**
 * ExportSheet — Story 6.4 (FR46, UX § Feedback Patterns > Sheets for
 * long operations).
 *
 * Side-anchored sheet the report pages mount when the admin triggers
 * an export. Subscribes reactively to a single `exports` row via
 * `getExportById({ exportId })` and renders one of four states:
 *
 *   - `pending`  — "Preparing your export…" + spinner copy.
 *   - `ready`    — "Your export is ready" + Download button (opens
 *                  the signed URL in a new tab).
 *   - `failed`   — translated error message + Retry button.
 *   - `expired`  — "This export has expired. Re-run the report to
 *                  generate a fresh file."
 *
 * The component is intentionally a "lightweight progress reporter".
 * The original Story 6.4 spec called for a cancel affordance — that
 * was deferred because Convex actions are fire-and-forget at the
 * storage layer (a cancel button is misleading once the action has
 * started rendering). A future story can wire client-side
 * abort-on-network-disconnect if the cemetery requests it.
 *
 * Auth: the queries this component invokes are admin-gated; the
 * parent page is also admin-gated by middleware + the report query
 * itself.
 *
 * Convex coupling: this file references `makeFunctionReference` so
 * the component is decoupled from the codegen
 * (`convex/_generated/api`) that hasn't been run yet in this repo.
 * The reference shape mirrors `convex/exports.ts`.
 */

import { useCallback, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { translateError } from "@/lib/errors";

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

const getExportByIdRef = makeFunctionReference<
  "query",
  { exportId: string },
  ExportRow | null
>("exports:getExportById");

const getExportDownloadUrlRef = makeFunctionReference<
  "mutation",
  { exportId: string },
  { url: string | null }
>("exports:getExportDownloadUrl");

const requestExportRef = makeFunctionReference<
  "mutation",
  {
    reportType: "sales_by_dimension" | "ar_aging" | "audit_log";
    args: Record<string, unknown>;
    format: "xlsx" | "pdf";
  },
  { exportId: string }
>("exports:requestExport");

export interface ExportSheetProps {
  /** The export row the sheet renders progress for. */
  exportId: string;
  /** Called when the user dismisses the sheet (Esc, backdrop, X, close). */
  onClose: () => void;
  /**
   * Optional retry payload — when present, the "Retry" button on the
   * failed-state branch re-requests an export with these args + the
   * same format. When absent, the failed-state branch only offers
   * Close.
   */
  retry?: {
    reportType: "sales_by_dimension" | "ar_aging" | "audit_log";
    format: "xlsx" | "pdf";
    args: Record<string, unknown>;
    /** Called with the new exportId after a successful retry request. */
    onRetried: (newExportId: string) => void;
  };
}

const REPORT_TITLE: Record<ExportRow["reportType"], string> = {
  sales_by_dimension: "Sales by dimension",
  ar_aging: "AR aging summary",
  audit_log: "Audit log",
};

const FORMAT_LABEL: Record<ExportRow["format"], string> = {
  xlsx: "Excel (CSV)",
  pdf: "PDF",
};

/**
 * Mirror of `convex/exports.ts → MAX_RETRY_COUNT`. The Retry button on
 * the failed branch is hidden once `retryCount >= MAX_RETRY_COUNT` so
 * the admin doesn't click into an inevitable "Retry cap exceeded"
 * rejection. The Convex mutation enforces the cap independently
 * (defense in depth — see P1-4 in `requestExport`).
 */
const MAX_RETRY_COUNT = 3;

export function ExportSheet({
  exportId,
  onClose,
  retry,
}: ExportSheetProps): React.ReactElement {
  const row = useQuery(getExportByIdRef, { exportId });
  const getDownloadUrl = useMutation(getExportDownloadUrlRef);
  const requestExport = useMutation(requestExportRef);
  const [busy, setBusy] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const handleDownload = useCallback(async () => {
    setBusy(true);
    setDownloadError(null);
    try {
      const { url } = await getDownloadUrl({ exportId });
      if (url === null) {
        setDownloadError(
          "Download link is not available. The export may have expired.",
        );
        return;
      }
      // Opens in a new tab so the existing report page state survives.
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      const t = translateError(err);
      setDownloadError(`${t.headline}: ${t.detail}`);
    } finally {
      setBusy(false);
    }
  }, [getDownloadUrl, exportId]);

  const handleRetry = useCallback(async () => {
    if (retry === undefined) return;
    setBusy(true);
    setDownloadError(null);
    try {
      const result = await requestExport({
        reportType: retry.reportType,
        args: retry.args,
        format: retry.format,
      });
      retry.onRetried(result.exportId);
    } catch (err) {
      const t = translateError(err);
      setDownloadError(`${t.headline}: ${t.detail}`);
    } finally {
      setBusy(false);
    }
  }, [requestExport, retry]);

  return (
    <Sheet open={true} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full max-w-md"
        data-testid="export-sheet"
      >
        <div className="space-y-4">
          <div>
            <SheetTitle>Report export</SheetTitle>
            <SheetDescription>
              {row !== undefined && row !== null
                ? `${REPORT_TITLE[row.reportType]} · ${FORMAT_LABEL[row.format]}`
                : "Preparing your export…"}
            </SheetDescription>
          </div>

          {row === undefined && (
            <div
              className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600"
              data-testid="export-sheet-loading"
            >
              Loading export status…
            </div>
          )}

          {row === null && (
            <div
              className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900"
              data-testid="export-sheet-missing"
            >
              Export not found. It may have been cleaned up.
            </div>
          )}

          {row !== null && row !== undefined && (
            <>
              {row.status === "pending" && (
                <div
                  className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600"
                  data-testid="export-sheet-pending"
                >
                  Preparing your export… This usually takes a few
                  seconds. The download button will appear here when
                  the file is ready.
                </div>
              )}

              {row.status === "ready" && (
                <div className="space-y-3" data-testid="export-sheet-ready">
                  <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                    Your export is ready.
                  </div>
                  <button
                    type="button"
                    onClick={handleDownload}
                    disabled={busy}
                    className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                    data-testid="export-sheet-download"
                  >
                    Download
                  </button>
                </div>
              )}

              {row.status === "failed" && (
                <div className="space-y-3" data-testid="export-sheet-failed">
                  <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
                    {row.lastError ?? "Export failed."}
                  </div>
                  {retry !== undefined &&
                    row.retryCount < MAX_RETRY_COUNT && (
                      <button
                        type="button"
                        onClick={handleRetry}
                        disabled={busy}
                        className="w-full rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                        data-testid="export-sheet-retry"
                      >
                        Retry export
                      </button>
                    )}
                  {row.retryCount >= MAX_RETRY_COUNT && (
                    <div
                      className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
                      data-testid="export-sheet-retry-cap"
                    >
                      This export has failed {row.retryCount} times. Please
                      check the report inputs or contact support before
                      re-running.
                    </div>
                  )}
                </div>
              )}

              {row.status === "expired" && (
                <div
                  className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
                  data-testid="export-sheet-expired"
                >
                  This export has expired (kept for 30 days). Re-run
                  the report to generate a fresh file.
                </div>
              )}

              {downloadError !== null && (
                <div
                  role="alert"
                  className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900"
                  data-testid="export-sheet-download-error"
                >
                  {downloadError}
                </div>
              )}
            </>
          )}

          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            data-testid="export-sheet-close"
          >
            Close
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
