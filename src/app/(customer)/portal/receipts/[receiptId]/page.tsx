"use client";

/**
 * Customer portal receipt detail page — Story 9.3 (FR56, AC1 / AC2 / AC3).
 *
 * Renders a single receipt's metadata (number, issued-on, amount,
 * voided badge) plus a working "Download receipt PDF" button for the
 * authenticated customer. All data access is scoped server-side by
 * `portal:getCustomerReceiptPdfUrl` + `portal:requestCustomerReceiptPdf`
 * — non-owners receive `null` from the query (404 panel) and a
 * `"not_found"` status from the mutation (no-op + toast). The same
 * URL bar a customer would screenshot is not the gate; the server is.
 *
 * Why a client component (not a server page like
 * `/portal/contracts/[contractId]`): the PDF download is a multi-step
 * reactive flow — request → wait for `pdfStorageId` to land → fetch
 * the signed URL → programmatically click an `<a download>` to save.
 * Server-rendering the shell would force a re-mount on every state
 * transition, breaking the reactive query subscription that drives
 * the "Receipt is being generated…" → "Tap to download" handoff.
 *
 * Reuses the staff-side download pattern from
 * `src/app/(staff)/receipts/[receiptId]/page.tsx` — same
 * `<a download>` trick, same filename-sanitisation logic — but
 * gates everything on the customer-portal queries so the staff
 * mutation's role check doesn't bounce a customer caller.
 *
 * Accessibility:
 *   - Single `<h1>` per the `local-rules/single-h1-per-page` lint
 *     rule (the page hosts the title directly).
 *   - "Download receipt PDF" button has `aria-busy` while the
 *     download is pending.
 *   - 404 panel uses `role="alert"`.
 *   - Voided receipts surface the void state via a status badge with
 *     `aria-label="Voided receipt"` (NFR-A3 colour-independence).
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/time";

interface AuthPayload {
  userId: string;
  roles: string[];
}

const getCurrentUserOrNull = makeFunctionReference<
  "query",
  Record<string, never>,
  AuthPayload | null
>("lib/auth:getCurrentUserOrNull");

interface CustomerReceiptListRow {
  receiptId: string;
  receiptNumber: string;
  receiptSerial: number;
  issuedAt: number;
  amountCents: number;
  paymentId: string;
  contractId: string | null;
  contractNumber: string | null;
  isVoided: boolean;
  voidedAt: number | null;
  pdfReady: boolean;
}

interface CustomerReceiptPdfUrlResult {
  url: string | null;
  ready: boolean;
  generatedAt: number | null;
  receiptNumber: string;
}

interface RequestCustomerReceiptPdfResult {
  receiptId: string;
  status: "ready" | "scheduled" | "not_found";
}

const listCustomerReceiptsRef = makeFunctionReference<
  "query",
  Record<string, never>,
  CustomerReceiptListRow[]
>("portal:listCustomerReceipts");

// Story 9.3 NFR-S8 fix: getCustomerReceiptPdfUrl is now a MUTATION (it
// emits the audit row + bumps the download counter inside the
// transaction). Reactive subscription is no longer needed — the
// download click drives the call imperatively.
const getCustomerReceiptPdfUrlRef = makeFunctionReference<
  "mutation",
  { receiptId: string },
  CustomerReceiptPdfUrlResult | null
>("portal:getCustomerReceiptPdfUrl");

const requestCustomerReceiptPdfRef = makeFunctionReference<
  "mutation",
  { receiptId: string },
  RequestCustomerReceiptPdfResult
>("portal:requestCustomerReceiptPdf");

/**
 * Build the downloaded filename. Defensive: any non-ASCII-alphanumeric
 * char in the receipt number becomes a dash, and a trailing run of
 * dashes is trimmed. Mirrors the staff-side
 * `buildPdfFilename` so a customer downloading their own receipt and
 * staff downloading the same receipt produce identical filenames.
 */
function buildPdfFilename(receiptNumber: string): string {
  const slug = receiptNumber
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `receipt-${slug || "receipt"}.pdf`;
}

/** Peso formatter — duplicated narrowly here so the page doesn't pull
 *  the full `formatPeso` helper through the client bundle when the
 *  detail page only needs one call. The format matches `@/lib/money`. */
function formatPeso(cents: number): string {
  const pesos = cents / 100;
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
  }).format(pesos);
}

export default function CustomerReceiptDetailPage() {
  const params = useParams<{ receiptId: string }>();
  const receiptId = params.receiptId;

  // Auth backstop — the middleware + (customer) layout already gate, but
  // a stale token can still mount this page. When `null` is returned,
  // the layout's redirect path will fire on next render; for now we just
  // show a loading shell instead of crashing.
  const authPayload = useQuery(getCurrentUserOrNull, {});

  // Reactive list query — drives the page chrome AND the "is PDF
  // ready?" gate the Download button consults. The list row's
  // `pdfReady` flag flips automatically when the Story 3.13 action
  // patches `pdfStorageId`. We do NOT reactively subscribe to the URL
  // itself — URL issuance is now a mutation (Story 9.3 NFR-S8 fix)
  // that bumps the download counter + emits the audit row.
  const allReceipts = useQuery(listCustomerReceiptsRef, {});
  const row =
    allReceipts === undefined
      ? undefined
      : allReceipts.find((r) => r.receiptId === receiptId) ?? null;

  const requestCustomerReceiptPdf = useMutation(requestCustomerReceiptPdfRef);
  const getCustomerReceiptPdfUrl = useMutation(getCustomerReceiptPdfUrlRef);

  const [downloadPending, setDownloadPending] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [lastReceiptNumber, setLastReceiptNumber] = useState<string | null>(
    null,
  );

  // Display title from the reactive list. `row === null` means
  // "receipt not in the customer's set" — the 404 panel renders the
  // matching message; both branches collapse to the same surface
  // (existence-enumeration defence per Story 9.1 ADR).
  useEffect(() => {
    if (row !== undefined && row !== null) {
      document.title = `Receipt ${row.receiptNumber} · Broadheader`;
      setLastReceiptNumber(row.receiptNumber);
    } else if (row === null) {
      document.title = "Receipt not found · Broadheader";
    }
  }, [row]);

  const onDownload = useCallback(async () => {
    setDownloadError(null);
    setDownloadPending(true);
    try {
      // Phase 1: request the render so the action kicks off if the PDF
      // hasn't been materialised yet. Idempotent on `ready`.
      const requested = await requestCustomerReceiptPdf({ receiptId });
      if (requested.status === "not_found") {
        setDownloadPending(false);
        setDownloadError(
          "This receipt is not at hand. Should this seem in error, please write to the Estate Office.",
        );
        return;
      }
      // Phase 2: ask for the signed URL. This is the audit-emitting
      // mutation. Returns `null` for non-ownership / non-existent;
      // returns `ready: false` when the PDF render hasn't completed
      // yet. We surface either branch as an error inviting the customer
      // to retry after a beat.
      const urlResult = await getCustomerReceiptPdfUrl({ receiptId });
      if (urlResult === null) {
        setDownloadPending(false);
        setDownloadError(
          "This receipt is not at hand. Should this seem in error, please write to the Estate Office.",
        );
        return;
      }
      if (urlResult.url === null) {
        setDownloadPending(false);
        setDownloadError(
          "The estate is preparing your receipt. Please try again in a moment.",
        );
        return;
      }
      // Trigger the browser download.
      const filename = buildPdfFilename(urlResult.receiptNumber);
      const anchor = document.createElement("a");
      anchor.href = urlResult.url;
      anchor.download = filename;
      anchor.rel = "noopener noreferrer";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setDownloadPending(false);
    } catch {
      setDownloadPending(false);
      setDownloadError(
        "The estate could not deliver the receipt just now. Please try again in a moment.",
      );
    }
  }, [receiptId, requestCustomerReceiptPdf, getCustomerReceiptPdfUrl]);

  // Loading shell — wait for both the list query AND the auth payload
  // to resolve before deciding between "happy path" and "404". `row`
  // is undefined while the list is loading; `null` when the receipt is
  // not in the customer's set (404 case).
  if (row === undefined || authPayload === undefined) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="h-7 w-48 animate-pulse rounded bg-surface-muted" />
        <div className="h-32 rounded-md border border-surface-border bg-surface-base p-6 shadow-sm" />
      </div>
    );
  }

  // 404 path — receipt doesn't exist OR doesn't belong to the caller.
  // Both branches collapse to the same UI (existence-enumeration
  // defence per Story 9.1 ADR).
  if (row === null) {
    return (
      <section
        aria-labelledby="receipt-not-found-heading"
        className="space-y-4"
      >
        <Link
          href="/portal/receipts"
          className="text-sm font-medium text-text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 rounded"
        >
          ← Return to your receipts
        </Link>
        <h1
          id="receipt-not-found-heading"
          className="text-2xl font-semibold tracking-tight text-text-default"
        >
          Receipt not found
        </h1>
        <div
          role="alert"
          className="rounded-md border border-surface-border bg-surface-base p-6 text-sm text-text-muted shadow-sm"
        >
          The estate does not hold that receipt under your name. Should
          this seem in error, please write to the Estate Office.
        </div>
      </section>
    );
  }

  // Happy path — receipt exists and is owned by the caller.
  const isDownloadInFlight = downloadPending;
  const displayReceiptNumber = row.receiptNumber ?? lastReceiptNumber ?? "";

  return (
    <section
      aria-labelledby="receipt-detail-heading"
      className="space-y-4"
    >
      <Link
        href="/portal/receipts"
        className="text-sm font-medium text-text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 rounded"
      >
        ← Return to your receipts
      </Link>
      <h1
        id="receipt-detail-heading"
        className="text-2xl font-semibold tracking-tight text-text-default"
      >
        Receipt {displayReceiptNumber}
      </h1>

      <article className="rounded-md border border-surface-border bg-surface-base p-4 shadow-sm sm:p-6">
        {(
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-text-muted">
                Contribution
              </dt>
              <dd className="mt-1 text-xl font-semibold text-text-default">
                {formatPeso(row.amountCents)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-text-muted">
                Issued by the estate
              </dt>
              <dd className="mt-1 text-sm text-text-default">
                {formatDate(row.issuedAt, "short")}
              </dd>
            </div>
            {row.contractNumber !== null ? (
              <div className="sm:col-span-2">
                <dt className="text-xs uppercase tracking-wide text-text-muted">
                  Contract
                </dt>
                <dd className="mt-1 text-sm text-text-default">
                  {row.contractNumber}
                </dd>
              </div>
            ) : null}
            {row.isVoided ? (
              <div className="sm:col-span-2">
                <span
                  role="status"
                  aria-label="Voided receipt"
                  className={cn(
                    "inline-flex items-center rounded-full",
                    "border border-status-due-border bg-status-due-bg",
                    "px-2 py-0.5 text-xs font-medium text-status-due-text",
                  )}
                >
                  Voided
                </span>
                {row.voidedAt !== null ? (
                  <p className="mt-1 text-xs text-text-muted">
                    Voided by the estate on {formatDate(row.voidedAt, "short")}
                  </p>
                ) : null}
              </div>
            ) : null}
          </dl>
        )}

        <div className="mt-6 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-text-muted">
            {row.pdfReady
              ? "PDF ready for keeping"
              : "The estate is preparing your receipt. A moment, please…"}
          </p>
          <button
            type="button"
            onClick={onDownload}
            disabled={isDownloadInFlight}
            aria-busy={isDownloadInFlight}
            aria-label={`Download receipt ${displayReceiptNumber} as PDF`}
            className={cn(
              "inline-flex min-h-[48px] items-center justify-center rounded-md",
              "bg-primary px-4 py-2 text-sm font-medium text-primary-fg",
              "hover:bg-primary-hover",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            {isDownloadInFlight ? "Preparing your PDF…" : "Retrieve receipt PDF"}
          </button>
        </div>

        {downloadError !== null ? (
          <div
            role="alert"
            data-testid="customer-receipt-download-error"
            className="mt-4 rounded-md border border-status-due-border bg-status-due-bg px-4 py-3 text-sm text-status-due-text"
          >
            {downloadError}
          </div>
        ) : null}
      </article>
    </section>
  );
}
