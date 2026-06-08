"use client";

/**
 * CustomerDocumentUpload — Story 2.2 (FR15 / NFR-S3 / NFR-C5).
 *
 * Drag-and-drop + file-picker zone for attaching identification
 * documents (government IDs, transfer affidavits, death certificates,
 * court orders) to a customer record.
 *
 * Composition:
 *   - Owns the two-step upload flow:
 *       1. `customerDocuments.generateCustomerDocumentUploadUrl`
 *          mutation returns a short-lived POST endpoint.
 *       2. Client `fetch`'s the file blob to that endpoint and
 *          receives a `storageId`.
 *       3. `customerDocuments.uploadCustomerDocument` mutation
 *          attaches the storageId + metadata to the customer.
 *   - Client-side validates `file.size <= MAX_FILE_BYTES` and
 *     `file.type` against the MIME allowlist before initiating
 *     the upload (defense in depth — the server re-checks).
 *   - On `CONSENT_REQUIRED` / `INVARIANT_VIOLATION` from the
 *     server, surfaces the consent message + a link to update
 *     consent on the customer detail page.
 *
 * The component is reusable across the customer detail page
 * (Story 2.5) and the transfer flow (Story 2.7); both pass a
 * different `docType` prop.
 *
 * Tailwind-only (no `react-dropzone` per architecture's "no extra
 * dep unless justified" stance). The drop zone is keyboard-
 * accessible — focus the label, press Enter / Space, the file
 * picker opens.
 */

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { cn } from "@/lib/cn";
import { translateError } from "@/lib/errors";

/** Mirror of `convex/customerDocuments.ts:CustomerDocumentType`. */
export type CustomerDocumentType =
  | "national_id"
  | "drivers_license"
  | "passport"
  | "voters_id"
  | "affidavit"
  | "death_certificate"
  | "court_order"
  | "other";

/** Human-readable labels for the doc-type select. */
export const DOC_TYPE_LABELS: Record<CustomerDocumentType, string> = {
  national_id: "National ID",
  drivers_license: "Driver's License",
  passport: "Passport",
  voters_id: "Voter's ID",
  affidavit: "Affidavit",
  death_certificate: "Death Certificate",
  court_order: "Court Order",
  other: "Other",
};

/**
 * Mirror of `convex/customerDocuments.ts:MAX_FILE_BYTES`. Kept in
 * sync by hand — adding a third source of truth (e.g. importing
 * from `convex/`) crosses the client/server boundary the project
 * explicitly forbids.
 */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Mirror of `convex/customerDocuments.ts:ALLOWED_MIME_TYPES`. */
const ALLOWED_MIME_TYPES: ReadonlyArray<string> = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
];

/** HTML `accept` attribute string built from the MIME allowlist. */
const ACCEPT_ATTR = ALLOWED_MIME_TYPES.join(",");

/**
 * Args record types declared with index-signature compatibility so
 * Convex's `makeFunctionReference` accepts them as
 * `DefaultFunctionArgs` (which constraints `Record<string,
 * Value>`). The shapes are intentionally permissive at the type
 * boundary; the server-side validator + `UploadDocumentArgs`
 * structural type are the real contract.
 */
type GenerateUrlArgs = Record<string, never>;

type UploadDocumentArgs = {
  customerId: string;
  docType: CustomerDocumentType;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageId: string;
  notes?: string;
} & Record<string, unknown>;

interface UploadDocumentResult {
  documentId: string;
}

const generateUploadUrlRef = makeFunctionReference<
  "mutation",
  GenerateUrlArgs,
  string
>("customerDocuments:generateCustomerDocumentUploadUrl");

const uploadDocumentRef = makeFunctionReference<
  "mutation",
  UploadDocumentArgs,
  UploadDocumentResult
>("customerDocuments:uploadCustomerDocument");

export interface CustomerDocumentUploadProps {
  /** Customer this document attaches to. */
  customerId: string;
  /**
   * Default document type. The user can still change it in the
   * select before uploading; this is the initial value (Story 2.2
   * Task 9's demo page passes `"national_id"`; Story 2.7's transfer
   * flow will pass `"affidavit"`).
   */
  defaultDocType?: CustomerDocumentType;
  /**
   * Constrain the doc-type select to a subset. When undefined, all
   * eight types render. Story 2.7 may pass
   * `["affidavit", "court_order", "death_certificate"]` to scope
   * the transfer flow.
   */
  allowedDocTypes?: ReadonlyArray<CustomerDocumentType>;
  /**
   * Called AFTER the `uploadCustomerDocument` mutation succeeds,
   * with the newly-allocated documentId. Story 2.5's customer
   * detail page will use this to refocus the document list / show
   * a toast; the demo page in Story 2.2 uses it to show a success
   * banner.
   */
  onUploaded?: (documentId: string) => void;
  /**
   * ARIA label for the form region. Default `"Upload identification document"`.
   */
  ariaLabel?: string;
}

type UploadState =
  | { status: "idle" }
  | { status: "validating" }
  | { status: "uploading" }
  | { status: "recording" }
  | { status: "success"; documentId: string }
  | { status: "error"; message: string; consentRequired: boolean };

export function CustomerDocumentUpload({
  customerId,
  defaultDocType = "national_id",
  allowedDocTypes,
  onUploaded,
  ariaLabel = "Upload identification document",
}: CustomerDocumentUploadProps) {
  const generateUrl = useMutation(generateUploadUrlRef);
  const uploadDocument = useMutation(uploadDocumentRef);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [docType, setDocType] = useState<CustomerDocumentType>(defaultDocType);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [notes, setNotes] = useState<string>("");
  const [dragActive, setDragActive] = useState(false);
  const [uploadState, setUploadState] = useState<UploadState>({ status: "idle" });

  const docTypeOptions: ReadonlyArray<CustomerDocumentType> =
    allowedDocTypes !== undefined && allowedDocTypes.length > 0
      ? allowedDocTypes
      : (Object.keys(DOC_TYPE_LABELS) as CustomerDocumentType[]);

  // -- File selection ---------------------------------------------------
  const handleFile = useCallback((file: File): void => {
    setUploadState({ status: "validating" });
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      setUploadState({
        status: "error",
        message: "Only JPG, PNG, WEBP, or PDF files are allowed.",
        consentRequired: false,
      });
      setSelectedFile(null);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setUploadState({
        status: "error",
        message: "File must be smaller than 10MB. Try resizing.",
        consentRequired: false,
      });
      setSelectedFile(null);
      return;
    }
    if (file.size <= 0) {
      setUploadState({
        status: "error",
        message: "File is empty.",
        consentRequired: false,
      });
      setSelectedFile(null);
      return;
    }
    setSelectedFile(file);
    setUploadState({ status: "idle" });
  }, []);

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0] ?? null;
    if (file !== null) handleFile(file);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0] ?? null;
    if (file !== null) handleFile(file);
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragActive(true);
  };

  const onDragLeave = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragActive(false);
  };

  // -- Submit -----------------------------------------------------------
  const isBusy =
    uploadState.status === "uploading" ||
    uploadState.status === "recording" ||
    uploadState.status === "validating";

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (selectedFile === null) {
      setUploadState({
        status: "error",
        message: "Choose a file to upload.",
        consentRequired: false,
      });
      return;
    }
    try {
      // Step 1 — short-lived upload URL.
      setUploadState({ status: "uploading" });
      const uploadUrl = await generateUrl({});
      // Step 2 — POST the file blob.
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Type": selectedFile.type || "application/octet-stream",
        },
        body: selectedFile,
      });
      if (!res.ok) {
        throw new Error("File upload failed.");
      }
      const json = (await res.json()) as { storageId?: string };
      if (typeof json.storageId !== "string") {
        throw new Error("File upload returned no storageId.");
      }
      // Step 3 — record the document metadata + emit audit.
      setUploadState({ status: "recording" });
      const trimmedNotes = notes.trim();
      const recordArgs: UploadDocumentArgs = {
        customerId,
        docType,
        fileName: selectedFile.name,
        mimeType: selectedFile.type,
        sizeBytes: selectedFile.size,
        storageId: json.storageId,
      };
      if (trimmedNotes.length > 0) {
        recordArgs.notes = trimmedNotes;
      }
      const { documentId } = await uploadDocument(recordArgs);
      setUploadState({ status: "success", documentId });
      // Clear the form state — a parent that re-renders us still
      // sees a fresh, ready-for-next-upload zone.
      setSelectedFile(null);
      setNotes("");
      if (fileInputRef.current !== null) {
        fileInputRef.current.value = "";
      }
      onUploaded?.(documentId);
    } catch (err) {
      const translated = translateError(err);
      // The server raises INVARIANT_VIOLATION when consent is
      // missing for an ID-family document; we surface a more
      // specific message + link in that case. Other errors get
      // the generic translation.
      const message =
        typeof err === "object" &&
        err !== null &&
        "data" in err &&
        typeof (err as { data?: unknown }).data === "object" &&
        (err as { data?: { message?: string } }).data?.message !== undefined
          ? ((err as { data: { message: string } }).data.message)
          : translated.detail;
      const consentRequired =
        typeof message === "string" &&
        message.toLowerCase().includes("consent") &&
        CONSENT_REQUIRED_DOC_TYPES_SET.has(docType);
      setUploadState({
        status: "error",
        message,
        consentRequired,
      });
    }
  };

  const showSelectedSize =
    selectedFile !== null
      ? `${(selectedFile.size / (1024 * 1024)).toFixed(2)} MB`
      : null;

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4"
      aria-label={ariaLabel}
      data-testid="customer-document-upload-form"
    >
      <div className="space-y-1">
        <label
          htmlFor="customer-doc-type"
          className="block text-sm font-medium text-slate-700"
        >
          Document type
        </label>
        <select
          id="customer-doc-type"
          value={docType}
          onChange={(e) => setDocType(e.target.value as CustomerDocumentType)}
          className={cn(
            "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm min-h-[44px]",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
          )}
          disabled={isBusy}
        >
          {docTypeOptions.map((opt) => (
            <option key={opt} value={opt}>
              {DOC_TYPE_LABELS[opt]}
            </option>
          ))}
        </select>
      </div>

      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        className={cn(
          "flex min-h-[120px] flex-col items-center justify-center rounded-md border-2 border-dashed px-4 py-6 text-center transition-colors",
          dragActive
            ? "border-slate-500 bg-slate-50"
            : "border-slate-300 bg-white",
          "focus-within:border-slate-500 focus-within:ring-1 focus-within:ring-slate-500",
        )}
        data-testid="customer-document-dropzone"
      >
        {selectedFile === null ? (
          <>
            <p className="text-sm text-slate-700">
              Drag & drop a file here, or
            </p>
            <label
              htmlFor="customer-doc-file"
              className="mt-2 inline-block cursor-pointer rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Choose file
            </label>
            <input
              ref={fileInputRef}
              id="customer-doc-file"
              type="file"
              accept={ACCEPT_ATTR}
              onChange={onInputChange}
              className="sr-only"
              disabled={isBusy}
              data-testid="customer-document-file-input"
            />
            <p className="mt-2 text-xs text-slate-500">
              JPG, PNG, WEBP, or PDF up to 10MB
            </p>
          </>
        ) : (
          <div
            className="flex w-full flex-col items-start gap-1 text-left"
            data-testid="customer-document-selected"
          >
            <p className="text-sm font-medium text-slate-800">
              {selectedFile.name}
            </p>
            <p className="text-xs text-slate-500">
              {selectedFile.type} · {showSelectedSize}
            </p>
            <button
              type="button"
              onClick={() => {
                setSelectedFile(null);
                if (fileInputRef.current !== null) {
                  fileInputRef.current.value = "";
                }
              }}
              disabled={isBusy}
              className="mt-2 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              Choose a different file
            </button>
          </div>
        )}
      </div>

      <div className="space-y-1">
        <label
          htmlFor="customer-doc-notes"
          className="block text-sm font-medium text-slate-700"
        >
          Notes (optional)
        </label>
        <textarea
          id="customer-doc-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. captured at customer's request, original sighted"
          rows={2}
          maxLength={500}
          className={cn(
            "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
          )}
          disabled={isBusy}
        />
      </div>

      {uploadState.status === "error" && (
        <div
          role="alert"
          data-testid="customer-document-upload-error"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          <p>{uploadState.message}</p>
          {uploadState.consentRequired && (
            <p className="mt-2">
              <Link
                href={`/customers/${customerId}`}
                className="font-medium underline"
              >
                Update consent on the customer record.
              </Link>
            </p>
          )}
        </div>
      )}

      {uploadState.status === "success" && (
        <div
          role="status"
          data-testid="customer-document-upload-success"
          className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
        >
          Document uploaded.
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isBusy || selectedFile === null}
          className="rounded-md bg-[#1D5C4D] px-4 py-2 text-sm font-medium text-white hover:bg-[#144437] disabled:cursor-not-allowed disabled:opacity-60 min-h-[44px]"
        >
          {uploadState.status === "uploading"
            ? "Uploading…"
            : uploadState.status === "recording"
              ? "Saving…"
              : "Upload document"}
        </button>
        {isBusy && (
          <span
            aria-live="polite"
            className="text-xs text-slate-500"
            data-testid="customer-document-upload-progress"
          >
            {uploadState.status === "uploading"
              ? "Uploading file…"
              : uploadState.status === "recording"
                ? "Saving record…"
                : "Validating…"}
          </span>
        )}
      </div>
    </form>
  );
}

/** Mirror of the server-side `CONSENT_REQUIRED_DOC_TYPES` set. */
const CONSENT_REQUIRED_DOC_TYPES_SET = new Set<CustomerDocumentType>([
  "national_id",
  "drivers_license",
  "passport",
  "voters_id",
  "other",
]);
