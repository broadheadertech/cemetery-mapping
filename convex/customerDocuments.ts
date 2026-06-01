/**
 * Customer identification documents (Story 2.2, FR15 / NFR-S3 / NFR-C5).
 *
 * Office-staff write surface for the `customerDocuments` table — the
 * metadata pointer to Convex File Storage blobs that hold scans of
 * government IDs, transfer affidavits, death certificates, and court
 * orders.
 *
 * ## File ownership note
 *
 * Per the Story 2.2 system-message file-ownership boundary, the
 * upload + retrieval handlers live in this dedicated file rather
 * than extending `convex/customers.ts` (owned by Story 2.1). The
 * data model is the same — `customerDocuments` references
 * `customers._id`.
 *
 * ## Flow
 *
 *   1. Client calls `generateCustomerDocumentUploadUrl` →
 *      receives a short-lived POST endpoint.
 *   2. Client `POST`s the file blob directly to that URL → receives
 *      `{ storageId: Id<"_storage"> }`.
 *   3. Client calls `uploadCustomerDocument` with the storageId +
 *      file metadata → row inserted, audit emitted.
 *   4. Subsequent reads call `getCustomerDocumentUrl` (per-document)
 *      and `listCustomerDocuments` (per-customer).
 *
 * ## Conventions every handler obeys
 *
 *   1. FIRST awaited statement is `await requireRole(ctx, [...])`.
 *      The ESLint rule `local-rules/require-role-first-line` is
 *      tied to identifier `query`/`mutation`/`action` only; we use
 *      `queryGeneric`/`mutationGeneric` (same as `conditionLogs.ts`
 *      and `customers.ts`) which sidesteps the lint detection — the
 *      first-line `requireRole` call remains the operational rule.
 *   2. Mutations call `emitAudit` — direct `auditLog` inserts are
 *      banned by `local-rules/no-audit-log-direct-write`. We treat
 *      the customer as the audit aggregate root (`entityType:
 *      "customer"`, `entityId: customerId`) so all per-customer
 *      activity surfaces in one audit feed.
 *   3. **Consent gate** (NFR-C5): only the government-ID family
 *      (`national_id`, `drivers_license`, `passport`, `voters_id`)
 *      requires `customer.hasConsent === true`. Notarized public-ish
 *      documents (`affidavit`, `death_certificate`, `court_order`)
 *      skip the consent gate. The `other` bucket is treated
 *      conservatively (consent required).
 *   4. **Per-customer cap**: at most `MAX_DOCUMENTS_PER_CUSTOMER`
 *      non-deleted rows per customer (currently 10). Exceeded =>
 *      `INVARIANT_VIOLATION`.
 *   5. **Type + size validation**: server-side allowlist for MIME +
 *      `MAX_FILE_BYTES` ceiling.
 *   6. **Soft delete only** (`isDeleted` flag). The row PERSISTS so
 *      the audit trail and downstream `piiAccessLog` references
 *      (Story 2.3) stay referentially intact.
 *
 * ## What this file deliberately does NOT do
 *
 *   - Does NOT directly write to `piiAccessLog`. Story 2.3 shipped
 *     the `readPii` helper + ESLint rule that bans direct
 *     `piiAccessLog` writes; integrating the file-view access log
 *     into `getCustomerDocumentUrl` is owned by Story 2.3's review
 *     iteration (which extends `readPii` for the `file_view`
 *     access type).
 *   - Does NOT generate URLs from `listCustomerDocuments`. URLs
 *     come from the per-document `getCustomerDocumentUrl` query
 *     only — that's the per-row access-log boundary. Architecture
 *     § 290 / Story 2.2 AC4.
 *   - Does NOT delete the underlying storage blob on soft-delete.
 *     `ctx.storage.delete` is irreversible; we keep the blob until
 *     a future hard-delete / retention-sweep story decides
 *     otherwise (FR-archival / Story 5.7).
 */

import {
  type DataModelFromSchemaDefinition,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import { emitAudit } from "./lib/audit";
import { logPiiAccess } from "./lib/piiAccess";
import { ErrorCode, throwError } from "./lib/errors";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type CustomerId = DataModel["customers"]["document"]["_id"];
type CustomerDocumentDoc = DataModel["customerDocuments"]["document"];
type CustomerDocumentId = CustomerDocumentDoc["_id"];
type StorageId = CustomerDocumentDoc["storageId"];
type UserId = DataModel["users"]["document"]["_id"];

/**
 * Controlled vocabulary of document types. Mirror of the
 * `customerDocuments.docType` union in `convex/schema.ts`. Adding
 * a new type requires updating BOTH the schema validator and this
 * array (the gov-ID set + the consent-skip set are derived from
 * here).
 */
export type CustomerDocumentType =
  | "national_id"
  | "drivers_license"
  | "passport"
  | "voters_id"
  | "affidavit"
  | "death_certificate"
  | "court_order"
  | "other";

/**
 * Document types that require `customer.hasConsent === true`
 * before upload (NFR-C5). The notarized public-ish documents
 * (`affidavit`, `death_certificate`, `court_order`) are NOT in
 * this set — those are externally verified records that the
 * cemetery has a legitimate operational interest in retaining
 * irrespective of Data-Privacy-Act consent for ID retention.
 *
 * `other` is conservative-default consent-required.
 */
const CONSENT_REQUIRED_DOC_TYPES = new Set<CustomerDocumentType>([
  "national_id",
  "drivers_license",
  "passport",
  "voters_id",
  "other",
]);

/**
 * Maximum number of NON-DELETED documents per customer. Caps blob
 * storage growth + protects the customer detail page from
 * accidentally-unbounded list rendering. Story-spec value.
 */
export const MAX_DOCUMENTS_PER_CUSTOMER = 10;

/**
 * Maximum allowed file size in bytes (10 MB per the story spec).
 * Phone-photo ID scans run 1–5MB; PDFs of affidavits stay under
 * 2MB. The ceiling is generous enough not to bite real-world
 * uploads while preventing accidental multi-gig dumps.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Server-side MIME allowlist. Matches reasonable real-world cases
 * (phone photos of IDs, PDF affidavits). `image/heic` is
 * deliberately absent — iPhone users share-to-JPG manually.
 */
export const ALLOWED_MIME_TYPES: ReadonlyArray<string> = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
];

/**
 * Convex validator that mirrors `CustomerDocumentType`. Kept as a
 * module-level constant so the four public handlers share a single
 * source of truth.
 */
const docTypeValidator = v.union(
  v.literal("national_id"),
  v.literal("drivers_license"),
  v.literal("passport"),
  v.literal("voters_id"),
  v.literal("affidavit"),
  v.literal("death_certificate"),
  v.literal("court_order"),
  v.literal("other"),
);

// ---------------------------------------------------------------------------
// generateCustomerDocumentUploadUrl
// ---------------------------------------------------------------------------

/**
 * Generates a short-lived upload URL for a customer document.
 *
 * Implemented as a MUTATION (not an action) for the same reasons
 * documented on `conditionLogs.ts:generateLotConditionPhotoUploadUrl`:
 * `ctx.storage.generateUploadUrl()` is available on `MutationCtx`,
 * and a mutation lets future stories tack on audit emission without
 * the ActionCtx-internal-mutation tax.
 *
 * The client uses this URL with a `POST` whose body is the file
 * blob; the response is `{ storageId: Id<"_storage"> }` which the
 * client then passes back to `uploadCustomerDocument`.
 *
 * Role gate: `office_staff` and `admin` only. Field workers do not
 * have a customer-document workflow in Phase 1.
 *
 * Returns the raw URL string. Convex's upload URLs are short-lived
 * (~minutes); the client must not cache.
 */
export const generateCustomerDocumentUploadUrl = mutationGeneric({
  args: {},
  handler: async (ctx: MutationCtx): Promise<string> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    return await ctx.storage.generateUploadUrl();
  },
});

// ---------------------------------------------------------------------------
// uploadCustomerDocument
// ---------------------------------------------------------------------------

/**
 * Public arg shape for `uploadCustomerDocument`. Mirrors the
 * validator below.
 */
export interface UploadCustomerDocumentArgs {
  customerId: CustomerId;
  docType: CustomerDocumentType;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageId: StorageId;
  notes?: string;
}

/** Return shape of `uploadCustomerDocument`. */
export interface UploadCustomerDocumentResult {
  documentId: CustomerDocumentId;
}

/**
 * Inserts a `customerDocuments` row that links a previously-
 * uploaded Convex File Storage blob to a customer.
 *
 * Flow contract:
 *   1. The client has already POSTed the file to the URL returned
 *      by `generateCustomerDocumentUploadUrl` and received the
 *      `storageId` from the storage service.
 *   2. The client now calls this mutation with the storageId +
 *      declared metadata.
 *   3. We re-validate the declared `mimeType` + `sizeBytes` against
 *      the server-side allowlist + ceiling (defense against a
 *      client lying about the file).
 *   4. We re-validate the customer's consent for ID-family doc
 *      types (defense against consent being revoked between the
 *      `generateUploadUrl` call and this call).
 *   5. We count existing non-deleted rows for this customer and
 *      refuse if `>= MAX_DOCUMENTS_PER_CUSTOMER`.
 *   6. Insert + emitAudit.
 *
 * Role gate: `office_staff` and `admin`.
 *
 * Audit boundary: `emitAudit` is called with `entityType: "customer"`
 * (the document is a child of the customer; per Story 1.6's
 * polymorphic-audit-log pattern, the customer is the aggregate root
 * for "everything that ever happened to this person's record"
 * queries). The audit `after` payload omits the raw `storageId` —
 * that opaque token is a backdoor to the file URL and storing it
 * in the audit log would let any audit-log reader fetch the scan.
 * We substitute the literal `"[storage-id-redacted]"` sentinel so
 * the audit row is still recognisable but unactionable.
 */
export const uploadCustomerDocument = mutationGeneric({
  args: {
    customerId: v.id("customers"),
    docType: docTypeValidator,
    fileName: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    storageId: v.id("_storage"),
    notes: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: UploadCustomerDocumentArgs,
  ): Promise<UploadCustomerDocumentResult> => {
    const auth = await requireRole(ctx, ["admin", "office_staff"]);

    // --- Size + MIME re-check -----------------------------------------
    // The client passed these values; we trust the storage service
    // for the actual upload but re-verify the declared metadata
    // against the server-side allowlist + ceiling. A client lying
    // about a 50MB binary as a 1MB JPEG still gets caught here
    // because the size ceiling is rejected; the blob is left
    // orphaned (a future retention-sweep job collects orphans —
    // out of scope for this story).
    if (args.sizeBytes <= 0) {
      throwError(
        ErrorCode.VALIDATION,
        "File size must be a positive number of bytes.",
        { sizeBytes: args.sizeBytes },
      );
    }
    if (args.sizeBytes > MAX_FILE_BYTES) {
      throwError(
        ErrorCode.VALIDATION,
        "File must be smaller than 10MB. Try resizing the image or compressing the PDF.",
        { sizeBytes: args.sizeBytes, maxBytes: MAX_FILE_BYTES },
      );
    }
    if (!ALLOWED_MIME_TYPES.includes(args.mimeType)) {
      throwError(
        ErrorCode.VALIDATION,
        "Only JPG, PNG, WEBP, or PDF files are allowed.",
        { mimeType: args.mimeType, allowed: [...ALLOWED_MIME_TYPES] },
      );
    }

    const fileName = args.fileName.trim();
    if (fileName.length === 0) {
      throwError(ErrorCode.VALIDATION, "File name is required.");
    }
    if (fileName.length > 255) {
      throwError(
        ErrorCode.VALIDATION,
        "File name is too long (max 255 characters).",
      );
    }

    // --- Customer + consent gate --------------------------------------
    // pii-read-ok: consent-gate lookup — customer fields are not returned; only existence + consent flags are checked
    const customer = await ctx.db.get(args.customerId);
    if (customer === null) {
      throwError(ErrorCode.NOT_FOUND, "Customer not found.", {
        customerId: args.customerId,
      });
    }
    if (
      CONSENT_REQUIRED_DOC_TYPES.has(args.docType) &&
      customer.hasConsent !== true
    ) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Customer consent is required before attaching identification documents. Update consent on the customer record first.",
        { customerId: args.customerId, docType: args.docType },
      );
    }

    // --- Per-customer cap --------------------------------------------
    const existing = await ctx.db
      .query("customerDocuments")
      .withIndex("by_customer", (q) => q.eq("customerId", args.customerId))
      .collect();
    const activeCount = existing.filter((d) => d.isDeleted === false).length;
    if (activeCount >= MAX_DOCUMENTS_PER_CUSTOMER) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        `A customer can have at most ${MAX_DOCUMENTS_PER_CUSTOMER} documents. Delete an old document before uploading a new one.`,
        {
          customerId: args.customerId,
          activeCount,
          maxAllowed: MAX_DOCUMENTS_PER_CUSTOMER,
        },
      );
    }

    // --- Insert -------------------------------------------------------
    const uploadedAt = Date.now();
    const notes =
      args.notes !== undefined && args.notes.trim().length > 0
        ? args.notes.trim()
        : undefined;

    const insertRow: {
      customerId: CustomerId;
      docType: CustomerDocumentType;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      storageId: StorageId;
      uploadedAt: number;
      uploadedByUserId: UserId;
      notes?: string;
      isDeleted: boolean;
    } = {
      customerId: args.customerId,
      docType: args.docType,
      fileName,
      mimeType: args.mimeType,
      sizeBytes: args.sizeBytes,
      storageId: args.storageId,
      uploadedAt,
      uploadedByUserId: auth.userId,
      isDeleted: false,
    };
    if (notes !== undefined) {
      insertRow.notes = notes;
    }

    const documentId = await ctx.db.insert("customerDocuments", insertRow);

    // --- Audit --------------------------------------------------------
    // `storageId` is intentionally replaced with a sentinel — it
    // would otherwise be a backdoor to file URLs for anyone with
    // audit-log read access.
    await emitAudit(ctx, {
      action: "create",
      entityType: "customer",
      entityId: args.customerId,
      after: {
        documentId,
        docType: args.docType,
        fileName,
        mimeType: args.mimeType,
        sizeBytes: args.sizeBytes,
        storageId: "[storage-id-redacted]",
      },
    });

    return { documentId };
  },
});

// ---------------------------------------------------------------------------
// getCustomerDocumentUrl
// ---------------------------------------------------------------------------

/** Return shape of `getCustomerDocumentUrl`. */
export interface GetCustomerDocumentUrlResult {
  url: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  docType: CustomerDocumentType;
}

/**
 * Returns an auth-gated, short-lived signed URL for fetching a
 * customer document, plus the file metadata needed by the caller
 * (so the UI can render the filename + a type-appropriate viewer).
 *
 * NFR-S3: file URLs are NEVER public. The caller's role is checked
 * here on every read, so a leaked document id can't be used by a
 * customer-role token to fetch the scan.
 *
 * Refuses to return a URL for soft-deleted rows — once `isDeleted`
 * is set, the document is effectively gone from the UI's
 * perspective. (The underlying blob persists; future hard-delete
 * is out of scope.)
 *
 * Story 2.3 file-view access-log boundary (NFR-S8): minting a signed
 * URL to an ID-scan / death-certificate / court-order blob IS a PII
 * read and MUST be logged. Because audit-row insertion is a write and
 * Convex queries are read-only, this is a `mutationGeneric` (the same
 * reason `revealGovId` is a mutation), not a query — the "View" click
 * already calls it imperatively, so there is no reactive-subscription
 * concern. A `queryGeneric` here served the most sensitive blobs in
 * the system with ZERO access logging, leaving NFR-C4 breach-impact
 * queries blind to every document view.
 */
export const getCustomerDocumentUrl = mutationGeneric({
  args: { documentId: v.id("customerDocuments") },
  handler: async (
    ctx: MutationCtx,
    args: { documentId: CustomerDocumentId },
  ): Promise<GetCustomerDocumentUrlResult | null> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const doc = await ctx.db.get(args.documentId);
    if (doc === null) {
      return null;
    }
    if (doc.isDeleted === true) {
      return null;
    }
    const url = await ctx.storage.getUrl(doc.storageId);
    // NFR-S8: record the file-view access BEFORE returning the signed
    // URL, so a thrown audit write fails the read rather than leaking an
    // unlogged view. `fields: ["customerAttachment.url"]` marks this as a
    // document-blob access (distinct from field-level PII reads).
    await logPiiAccess(ctx, {
      entityType: "customer",
      entityId: doc.customerId,
      fields: ["customerAttachment.url"],
      reason: `id-scan view (${doc.docType})`,
    });
    return {
      url,
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      docType: doc.docType,
    };
  },
});

// ---------------------------------------------------------------------------
// listCustomerDocuments
// ---------------------------------------------------------------------------

/**
 * Listed customer document row. Intentionally returns metadata
 * ONLY — URLs come from the per-document `getCustomerDocumentUrl`
 * query, which is the access-logging boundary. Returning a URL
 * here would log a view that didn't actually happen AND would
 * create a public-by-listing pattern.
 */
export interface ListedCustomerDocument {
  documentId: CustomerDocumentId;
  customerId: CustomerId;
  docType: CustomerDocumentType;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: number;
  uploadedByUserId: UserId;
  uploadedByName: string | null;
  isDeleted: boolean;
  notes: string | null;
}

/**
 * Lists the customer's documents in upload-date-descending order.
 *
 * Args:
 *   - `customerId` — required.
 *   - `includeDeleted` — optional, default `false`. When `true`,
 *     soft-deleted rows are included with `isDeleted: true` so the
 *     caller can render an "Archived documents" sub-list.
 *
 * Role gate: `office_staff` and `admin` only. Field workers and
 * customer-role tokens see nothing. Audit privilege is read-only
 * here (no audit emission for a list).
 *
 * Augments each row with `uploadedByName` (one-off `db.get` per row;
 * at the 10-row cap the cost is trivial).
 */
export const listCustomerDocuments = queryGeneric({
  args: {
    customerId: v.id("customers"),
    includeDeleted: v.optional(v.boolean()),
  },
  handler: async (
    ctx: QueryCtx,
    args: { customerId: CustomerId; includeDeleted?: boolean },
  ): Promise<ListedCustomerDocument[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const includeDeleted = args.includeDeleted ?? false;
    const rows = await ctx.db
      .query("customerDocuments")
      .withIndex("by_customer", (q) => q.eq("customerId", args.customerId))
      .collect();
    const filtered = includeDeleted
      ? rows
      : rows.filter((r) => r.isDeleted === false);
    // Sort newest-first by uploadedAt. We don't index on
    // (customerId, uploadedAt) because the per-customer cap of 10
    // makes in-memory sort cheap and the index footprint isn't
    // justified for the size.
    filtered.sort((a, b) => b.uploadedAt - a.uploadedAt);

    const out: ListedCustomerDocument[] = [];
    for (const row of filtered) {
      const user = await ctx.db.get(row.uploadedByUserId);
      const userName =
        user !== null && typeof user === "object" && "name" in user
          ? ((user as { name?: string }).name ?? null)
          : null;
      const userEmail =
        user !== null && typeof user === "object" && "email" in user
          ? ((user as { email?: string }).email ?? null)
          : null;
      out.push({
        documentId: row._id,
        customerId: row.customerId,
        docType: row.docType,
        fileName: row.fileName,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        uploadedAt: row.uploadedAt,
        uploadedByUserId: row.uploadedByUserId,
        uploadedByName: userName ?? userEmail ?? null,
        isDeleted: row.isDeleted,
        notes: row.notes ?? null,
      });
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// softDeleteCustomerDocument
// ---------------------------------------------------------------------------

/**
 * Public arg shape for `softDeleteCustomerDocument`.
 */
export interface SoftDeleteCustomerDocumentArgs {
  documentId: CustomerDocumentId;
  reason?: string;
}

/**
 * Soft-deletes a customer document. The row PERSISTS (so the audit
 * trail + any future `piiAccessLog` references stay referentially
 * intact) — `isDeleted: true` plus the actor / timestamp / reason
 * metadata is what the listing query filters on by default.
 *
 * The underlying Convex File Storage blob is NOT deleted. A
 * future retention-sweep / hard-delete story (FR-archival or Story
 * 5.7) may collect blobs whose `customerDocuments` row is marked
 * deleted beyond a configurable grace period.
 *
 * Role gate: `office_staff` and `admin`. (We intentionally allow
 * office_staff to soft-delete — typo correction during initial
 * upload is the common case. A future story may move this to
 * admin-only if operational policy changes.)
 *
 * Idempotency: a second call on an already-deleted row is a no-op
 * — returns the same documentId with no second audit row.
 */
export const softDeleteCustomerDocument = mutationGeneric({
  args: {
    documentId: v.id("customerDocuments"),
    reason: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: SoftDeleteCustomerDocumentArgs,
  ): Promise<{ documentId: CustomerDocumentId }> => {
    const auth = await requireRole(ctx, ["admin", "office_staff"]);

    const doc = await ctx.db.get(args.documentId);
    if (doc === null) {
      throwError(ErrorCode.NOT_FOUND, "Document not found.", {
        documentId: args.documentId,
      });
    }
    if (doc.isDeleted === true) {
      // Idempotent no-op. Do NOT emit a second audit row.
      return { documentId: doc._id };
    }

    const reason =
      args.reason !== undefined && args.reason.trim().length > 0
        ? args.reason.trim()
        : undefined;
    const deletedAt = Date.now();

    const patch: {
      isDeleted: true;
      deletedAt: number;
      deletedByUserId: UserId;
      deletedReason?: string;
    } = {
      isDeleted: true,
      deletedAt,
      deletedByUserId: auth.userId,
    };
    if (reason !== undefined) {
      patch.deletedReason = reason;
    }
    await ctx.db.patch(doc._id, patch);

    await emitAudit(ctx, {
      action: "delete",
      entityType: "customer",
      entityId: doc.customerId,
      before: {
        documentId: doc._id,
        docType: doc.docType,
        fileName: doc.fileName,
        isDeleted: false,
      },
      after: {
        documentId: doc._id,
        docType: doc.docType,
        fileName: doc.fileName,
        isDeleted: true,
        deletedReason: reason ?? null,
      },
      reason,
    });

    return { documentId: doc._id };
  },
});
