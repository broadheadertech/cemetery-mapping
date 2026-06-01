"use client";

/**
 * CustomerDocumentList — Story 2.2 (FR15 / NFR-S3).
 *
 * Reactive list of the customer's uploaded identification
 * documents. Each row exposes:
 *   - Document type + file name + size + uploaded-by.
 *   - A "View" affordance that opens the file via the auth-gated,
 *     per-row `getCustomerDocumentUrl` query (NFR-S3) — the URL is
 *     short-lived; clicking the button issues a fresh URL each
 *     time so we never cache a stale signed URL on the client.
 *   - A "Delete" affordance that calls `softDeleteCustomerDocument`
 *     (idempotent — see the server-side handler comments).
 *
 * Subscribes via `useQuery(listCustomerDocumentsRef, ...)` so
 * uploads from another tab / Office Staff session show up reactively.
 *
 * The component does NOT render document URLs eagerly — that would
 * burn through audit-log entries (Story 2.3 wraps the URL retrieval
 * with `readPii`). Clicking "View" is the explicit access event.
 */

import { useState } from "react";
import { useConvex, useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { translateError } from "@/lib/errors";

import { DOC_TYPE_LABELS, type CustomerDocumentType } from "@/components/CustomerDocumentUpload";

interface ListedCustomerDocument {
  documentId: string;
  customerId: string;
  docType: CustomerDocumentType;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: number;
  uploadedByUserId: string;
  uploadedByName: string | null;
  isDeleted: boolean;
  notes: string | null;
}

interface DocumentUrlResult {
  url: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  docType: CustomerDocumentType;
}

const listDocumentsRef = makeFunctionReference<
  "query",
  { customerId: string; includeDeleted?: boolean },
  ListedCustomerDocument[]
>("customerDocuments:listCustomerDocuments");

// `getCustomerDocumentUrl` is a MUTATION (not a query): minting the
// signed URL writes a PII-access audit row (NFR-S8), and Convex queries
// are read-only. The "View" click invokes it imperatively below.
const getDocumentUrlRef = makeFunctionReference<
  "mutation",
  { documentId: string },
  DocumentUrlResult | null
>("customerDocuments:getCustomerDocumentUrl");

const softDeleteRef = makeFunctionReference<
  "mutation",
  { documentId: string; reason?: string },
  { documentId: string }
>("customerDocuments:softDeleteCustomerDocument");

export interface CustomerDocumentListProps {
  customerId: string;
  /**
   * When `true`, includes soft-deleted documents in the list with
   * an "Archived" badge. Default `false`.
   */
  includeDeleted?: boolean;
}

export function CustomerDocumentList({
  customerId,
  includeDeleted = false,
}: CustomerDocumentListProps) {
  const documents = useQuery(listDocumentsRef, {
    customerId,
    includeDeleted,
  });
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingDocumentId, setPendingDocumentId] = useState<string | null>(
    null,
  );

  if (documents === undefined) {
    return (
      <p
        className="text-sm text-slate-500"
        data-testid="customer-document-list-loading"
      >
        Loading documents…
      </p>
    );
  }

  if (documents.length === 0) {
    return (
      <p
        className="text-sm text-slate-500"
        data-testid="customer-document-list-empty"
      >
        No documents uploaded yet.
      </p>
    );
  }

  return (
    <div className="space-y-3" data-testid="customer-document-list">
      {actionError !== null && (
        <div
          role="alert"
          data-testid="customer-document-list-error"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {actionError}
        </div>
      )}
      <ul className="divide-y divide-slate-200 rounded-md border border-slate-200">
        {documents.map((doc) => (
          <DocumentRow
            key={doc.documentId}
            doc={doc}
            pending={pendingDocumentId === doc.documentId}
            onActionStart={() => {
              setPendingDocumentId(doc.documentId);
              setActionError(null);
            }}
            onActionEnd={() => setPendingDocumentId(null)}
            onActionError={(msg) => {
              setActionError(msg);
              setPendingDocumentId(null);
            }}
          />
        ))}
      </ul>
    </div>
  );
}

interface DocumentRowProps {
  doc: ListedCustomerDocument;
  pending: boolean;
  onActionStart: () => void;
  onActionEnd: () => void;
  onActionError: (message: string) => void;
}

function DocumentRow({
  doc,
  pending,
  onActionStart,
  onActionEnd,
  onActionError,
}: DocumentRowProps) {
  const softDelete = useMutation(softDeleteRef);
  const convex = useConvex();

  const sizeMb = (doc.sizeBytes / (1024 * 1024)).toFixed(2);
  const uploadedDate = new Date(doc.uploadedAt).toLocaleString();

  const handleView = async (): Promise<void> => {
    onActionStart();
    try {
      // One-shot mutation per click: it mints a fresh short-lived signed
      // URL AND writes the NFR-S8 PII-access audit row for this file
      // view. Each click is the explicit, logged access event.
      const result = await convex.mutation(getDocumentUrlRef, {
        documentId: doc.documentId,
      });
      if (result === null || result.url === null) {
        throw new Error("Document is no longer available.");
      }
      window.open(result.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      const translated = translateError(err);
      onActionError(translated.detail);
      return;
    } finally {
      onActionEnd();
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (
      !window.confirm(
        `Delete ${doc.fileName}? This action is reversible by an admin via the audit log.`,
      )
    ) {
      return;
    }
    onActionStart();
    try {
      await softDelete({ documentId: doc.documentId });
    } catch (err) {
      const translated = translateError(err);
      onActionError(translated.detail);
      return;
    } finally {
      onActionEnd();
    }
  };

  return (
    <li
      className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
      data-testid="customer-document-row"
      data-document-id={doc.documentId}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-slate-800">{doc.fileName}</span>
          {doc.isDeleted && (
            <span
              className="rounded-md bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600"
              data-testid="customer-document-row-archived"
            >
              Archived
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-xs text-slate-500">
          {DOC_TYPE_LABELS[doc.docType]} · {doc.mimeType} · {sizeMb} MB ·
          uploaded {uploadedDate}
          {doc.uploadedByName !== null && <> by {doc.uploadedByName}</>}
        </div>
        {doc.notes !== null && (
          <p className="mt-1 text-xs text-slate-500">{doc.notes}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {!doc.isDeleted && (
          <>
            <button
              type="button"
              onClick={handleView}
              disabled={pending}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              data-testid="customer-document-view-button"
            >
              View
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={pending}
              className="rounded-md border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
              data-testid="customer-document-delete-button"
            >
              Delete
            </button>
          </>
        )}
      </div>
    </li>
  );
}

/**
 * Hook variant that returns the raw documents subscription. Useful
 * for callers that want to render their own row UI but still get
 * the auth-gated, role-checked listing semantics. Story 2.4 (data-
 * subject report) is the likely consumer.
 */
export function useCustomerDocuments(
  customerId: string,
  includeDeleted = false,
): ListedCustomerDocument[] | undefined {
  return useQuery(listDocumentsRef, { customerId, includeDeleted });
}

export type { ListedCustomerDocument };
export { getDocumentUrlRef };
