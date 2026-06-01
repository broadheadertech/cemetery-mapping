"use client";

/**
 * /receipts/[receiptId] — canonical BIR receipt detail page (Story 3.11,
 * extended in Story 3.13).
 *
 * Server-component pattern mirrors `/lots/[lotId]/page.tsx`:
 *   - `useQuery(receipts:getReceipt)` for live reactive updates.
 *   - Loading / not-found / error states (UX § Loading + Empty State).
 *   - `document.title` set in a `useEffect` so the browser tab shows
 *     "Receipt OR-0000123 · Broadheader".
 *
 * The page itself is a thin shell — `<ReceiptDisplay>` (Story 3.11)
 * owns the BIR-format layout. Keeping the heavy DOM in the component
 * means the PDF render path (Story 3.13) re-uses the visual contract
 * via shared formatting helpers (`convex/lib/birFormat.ts`).
 *
 * Print path (Story 3.11): the page renders `<ReceiptDisplay>` inside
 * a print-friendly container; clicking "Print" calls `window.print()`
 * and the `print.css` stylesheet hides the surrounding chrome.
 *
 * PDF path (Story 3.13, this update):
 *   - "Download PDF" button. On click:
 *       1. Calls the `receipts:generateReceiptPdfRequest` mutation
 *          (idempotent — returns `"ready"` immediately if a prior
 *          run produced a `pdfStorageId`).
 *       2. Subscribes via `useQuery(receipts:getReceiptPdfUrl)` —
 *          the URL becomes non-null once the scheduled action's
 *          writeback mutation lands.
 *       3. When the URL is available, triggers a download via a
 *          programmatic `<a download>` click. The filename pattern
 *          is `receipt-{number}-{customer-lastname}.pdf`, sanitised
 *          to ASCII alphanumeric + dashes so it survives every
 *          file-system the cemetery's staff might use.
 *   - Both buttons (Print + Download) remain visible for voided
 *     receipts — voided receipts are legitimate documents that may
 *     need to be re-distributed for audit purposes (the PDF carries
 *     the VOIDED watermark from `generateReceiptPdf`).
 *
 * Email-the-receipt is OUT of scope in this slice — see the story
 * file's narrowed file-ownership list. A future slice will wire the
 * email side channel using the same PDF blob this story produces.
 */

import "@/components/ReceiptDisplay/print.css";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import {
  ReceiptDisplay,
  type ReceiptDetailViewModel,
} from "@/components/ReceiptDisplay";
import { VoidReceiptDialog } from "@/components/VoidReceiptDialog";
import {
  formatIssuedDateTime,
  formatPesoAmount,
} from "../../../../../convex/lib/birFormat";

const getReceiptRef = makeFunctionReference<
  "query",
  { receiptId: string },
  ReceiptDetailViewModel | null
>("receipts:getReceipt");

/**
 * Story 3.12 — function ref for the admin-only `voidReceipt` mutation.
 * Resolved via `makeFunctionReference` for the same reason as the
 * other refs in this file (codegen-`api` is not checked in). The
 * mutation routes through the Story 3.2 cornerstone's `void` path; the
 * caller (here) is responsible for the UI's optimistic-state flow.
 */
const voidReceiptRef = makeFunctionReference<
  "mutation",
  { receiptId: string; reason: string },
  { receiptId: string; receiptNumber: string; voidedAt: number }
>("receipts:voidReceipt");

/**
 * Story 3.12 — function ref for `getCurrentUserOrNull`. The receipt
 * detail page reads the caller's roles client-side to gate the
 * admin-only "Void receipt" affordance. Defence in depth: the
 * `voidReceipt` mutation re-checks via `requireRole(["admin"])` on the
 * server. This UI gate hides the button when the caller is not an
 * admin so office_staff never see a control they cannot use; the
 * server is the load-bearing authority.
 */
interface AuthPayloadShape {
  userId: string;
  user: { email?: string; name?: string };
  roles: string[];
}

const getCurrentUserOrNullRef = makeFunctionReference<
  "query",
  Record<string, never>,
  AuthPayloadShape | null
>("lib/auth:getCurrentUserOrNull");

/**
 * Story 3.13 function refs. We resolve via `makeFunctionReference`
 * because the project does not check in `convex/_generated/api` (see
 * the architectural note in `convex/lib/audit.ts`).
 */
const generateReceiptPdfRequestRef = makeFunctionReference<
  "mutation",
  { receiptId: string },
  { receiptId: string; status: "ready" | "scheduled" | "not_found" }
>("receipts:generateReceiptPdfRequest");

const getReceiptPdfUrlRef = makeFunctionReference<
  "query",
  { receiptId: string },
  { url: string | null; generatedAt: number | null }
>("receipts:getReceiptPdfUrl");

/**
 * Build the downloaded filename. Customer-lastname segment is
 * defensive: any non-ASCII-alphanumeric char becomes a dash, and a
 * trailing run of dashes is trimmed. Filipino names with hyphens
 * (e.g. "Dela Cruz-Reyes") collapse to a single dash separator;
 * names with diacritics (rare in the cemetery's source records) get
 * stripped to ASCII so Windows file systems accept them.
 */
function buildPdfFilename(
  receiptNumber: string,
  customerFullName: string | null,
): string {
  const numberSlug = receiptNumber.replace(/[^A-Za-z0-9-]+/g, "-");
  const lastName =
    customerFullName === null
      ? "customer"
      : customerFullName.trim().split(/\s+/).slice(-1)[0] ?? "customer";
  const nameSlug = lastName
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `receipt-${numberSlug}-${nameSlug || "customer"}.pdf`;
}

export default function ReceiptDetailPage() {
  const params = useParams<{ receiptId: string }>();
  const receiptId = params.receiptId;

  const receipt = useQuery(getReceiptRef, { receiptId });
  const pdfUrlResult = useQuery(getReceiptPdfUrlRef, { receiptId });
  const auth = useQuery(getCurrentUserOrNullRef, {});
  const generateReceiptPdfRequest = useMutation(generateReceiptPdfRequestRef);
  const voidReceipt = useMutation(voidReceiptRef);

  // Story 3.12 — admin-only void affordance. The button is rendered
  // only when (a) the caller is an admin, AND (b) the receipt is not
  // already voided. Both gates live client-side as cosmetic
  // defence-in-depth; the server's `requireRole(["admin"])` is the
  // load-bearing authorisation point.
  const isAdmin = (auth?.roles ?? []).includes("admin");
  const [voidDialogOpen, setVoidDialogOpen] = useState(false);
  const [voidStatusMessage, setVoidStatusMessage] = useState<string | null>(
    null,
  );

  // Tracks the user's intent to download. When the user clicks
  // "Download PDF":
  //   1. We set `downloadPending = true` and call the mutation.
  //   2. If the mutation returns `"ready"`, the URL is already
  //      available; the effect below picks it up and triggers the
  //      download.
  //   3. If the mutation returns `"scheduled"`, we keep waiting; the
  //      effect fires as soon as the reactive `pdfUrlResult.url`
  //      flips from null to a signed URL.
  const [downloadPending, setDownloadPending] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    if (receipt !== undefined && receipt !== null) {
      document.title = `Receipt ${receipt.receiptNumber} · Broadheader`;
    } else if (receipt === null) {
      document.title = "Receipt not found · Broadheader";
    }
  }, [receipt]);

  // Effect: when a download is pending and the URL becomes available,
  // trigger the browser download. We trigger via a programmatic <a>
  // element with the `download` attribute so the browser saves the
  // file rather than navigating to it.
  useEffect(() => {
    if (
      !downloadPending ||
      receipt === undefined ||
      receipt === null ||
      pdfUrlResult === undefined ||
      pdfUrlResult.url === null
    ) {
      return;
    }
    const filename = buildPdfFilename(
      receipt.receiptNumber,
      receipt.customer.fullName,
    );
    const anchor = document.createElement("a");
    anchor.href = pdfUrlResult.url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setDownloadPending(false);
  }, [downloadPending, pdfUrlResult, receipt]);

  const onPrint = useCallback(() => {
    if (typeof window !== "undefined") {
      window.print();
    }
  }, []);

  /**
   * Story 3.12 — admin void workflow. The `VoidReceiptDialog`
   * collects the reason; this handler invokes the mutation and, on
   * success, closes the dialog and surfaces a success status banner.
   * The receipt itself updates reactively (the `getReceipt` query
   * subscription picks up the `isVoided: true` flip emitted by the
   * cornerstone), so we do NOT navigate away — the same page now
   * shows the VOIDED banner via `ReceiptDisplay`.
   *
   * The handler re-throws on mutation failure so the dialog can
   * surface the message inline (it stays open, the operator can
   * adjust + retry). This matches the contract `VoidContractDialog`
   * relies on (Story 3.7 pattern).
   */
  const handleVoidReceipt = useCallback(
    async (reason: string): Promise<void> => {
      setVoidStatusMessage(null);
      const result = await voidReceipt({ receiptId, reason });
      setVoidDialogOpen(false);
      setVoidStatusMessage(
        `Receipt ${result.receiptNumber} voided. The PDF will regenerate with the VOIDED watermark.`,
      );
    },
    [voidReceipt, receiptId],
  );

  const onDownloadPdf = useCallback(async () => {
    setDownloadError(null);
    setDownloadPending(true);
    try {
      const result = await generateReceiptPdfRequest({ receiptId });
      if (result.status === "not_found") {
        setDownloadPending(false);
        setDownloadError("Receipt not found.");
      }
      // For "ready" and "scheduled" we keep `downloadPending = true`;
      // the effect above triggers the download once the URL query
      // resolves.
    } catch (err) {
      setDownloadPending(false);
      setDownloadError(
        err instanceof Error
          ? err.message
          : "PDF download failed. Try again or contact an admin.",
      );
    }
  }, [generateReceiptPdfRequest, receiptId]);

  if (receipt === undefined) {
    return (
      <div className="space-y-4" data-testid="receipt-loading">
        <div className="h-7 w-48 animate-pulse rounded bg-surface-muted" />
        <div className="h-96 rounded-md border border-surface-border bg-surface-base p-6" />
      </div>
    );
  }

  if (receipt === null) {
    return (
      <div className="space-y-4" data-testid="receipt-not-found">
        <h1 className="text-3xl font-bold tracking-tight text-text-default">
          Receipt not found
        </h1>
        <div
          role="alert"
          className="rounded-md border border-status-due-border bg-status-due-bg px-4 py-3 text-sm text-status-due-text"
        >
          We couldn&apos;t find that receipt. The link may be incorrect.
        </div>
        <Link
          href="/receipts"
          className="inline-flex items-center text-sm font-medium text-text-default underline"
        >
          ← Back to Receipts
        </Link>
      </div>
    );
  }

  // The "Download PDF" button text reflects the current state:
  //   - idle:        "Download PDF"
  //   - pending +    "Preparing PDF..."  (mutation in flight OR
  //     PDF rendering in flight on the server)
  // The button is never permanently disabled; if the user clicks
  // again, the mutation re-resolves to "ready" and the effect
  // re-triggers the download (idempotent).
  const isDownloadInFlight =
    downloadPending && (pdfUrlResult === undefined || pdfUrlResult.url === null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4 print:hidden">
        <Link
          href="/receipts"
          className="inline-flex items-center text-sm font-medium text-text-default underline"
        >
          ← Back to Receipts
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onPrint}
            data-testid="receipt-print-button"
            className="rounded-md border border-surface-border bg-surface-base px-4 py-2 text-sm font-medium text-text-default hover:bg-surface-muted"
          >
            Print
          </button>
          <button
            type="button"
            onClick={onDownloadPdf}
            disabled={isDownloadInFlight}
            data-testid="receipt-download-pdf-button"
            aria-busy={isDownloadInFlight}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-fg hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isDownloadInFlight ? "Preparing PDF…" : "Download PDF"}
          </button>
          {/* Story 3.12 — admin-only void affordance. Hidden when the
           *   caller is not an admin AND when the receipt is already
           *   voided. Server-side `requireRole(["admin"])` is the load-
           *   bearing authority; this UI gate is cosmetic. */}
          {isAdmin && !receipt.isVoided && (
            <button
              type="button"
              data-testid="receipt-void-button"
              onClick={() => setVoidDialogOpen(true)}
              className="rounded-md border border-rose-300 bg-white px-4 py-2 text-sm font-medium text-rose-700 shadow-sm hover:bg-rose-50"
            >
              Void receipt
            </button>
          )}
        </div>
      </div>

      {voidStatusMessage !== null && (
        <div
          role="status"
          data-testid="receipt-void-success"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 print:hidden"
        >
          {voidStatusMessage}
        </div>
      )}

      {downloadError !== null && (
        <div
          role="alert"
          data-testid="receipt-download-error"
          className="rounded-md border border-status-due-border bg-status-due-bg px-4 py-3 text-sm text-status-due-text print:hidden"
        >
          {downloadError}
        </div>
      )}

      <ReceiptDisplay receipt={receipt} />

      {/* Story 3.12 — admin void confirmation dialog. Mounted
       *   unconditionally so the `open` toggle drives the animation
       *   smoothly; the dialog component itself returns null DOM when
       *   `open === false`. The summary fields are PII-narrow: receipt
       *   number, amount, customer full name, issued-at. No gov ID. */}
      <VoidReceiptDialog
        open={voidDialogOpen}
        onClose={() => setVoidDialogOpen(false)}
        onConfirm={handleVoidReceipt}
        receiptNumber={receipt.receiptNumber}
        amountFormatted={formatPesoAmount(receipt.amountCents)}
        customerName={receipt.customer.fullName}
        issuedAtFormatted={formatIssuedDateTime(receipt.issuedAt)}
      />
    </div>
  );
}
