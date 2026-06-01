/**
 * Data-subject report (Story 2.4, FR63 / NFR-C3 / NFR-S8).
 *
 * Admin-only surface that aggregates everything the system holds about
 * a single named customer into one snapshot — the canonical
 * "show me what you have on Mrs. Cruz" deliverable a cemetery's legal
 * counsel can hand to a requesting subject inside the Data Privacy Act
 * (RA 10173) 15-working-day window.
 *
 * Scope of this story (intentionally narrow):
 *   - One server entry point: `produceDataSubjectReport(args)`. Implemented
 *     as a MUTATION (not a query) because the act of producing the report
 *     is itself a PII access event — `logPiiAccess` writes a row to
 *     `auditLog`, which is a database write. The mutation returns the
 *     aggregated report payload to the admin's browser; the UI offers
 *     a "download as JSON" affordance.
 *   - No PDF generation, no `dataSubjectReports` archive table, no
 *     scheduled cleanup. The richer file-storage / PDF flow described in
 *     the story file is a follow-up that depends on tables not yet on
 *     disk (`dataSubjectReports`, `customerAttachments`, `ownerships`,
 *     contracts / payments). This story focuses on the data-aggregation
 *     contract + the self-logging audit invariant — which is the
 *     compliance-critical core. Downloadable JSON satisfies AC4's
 *     "machine-readable" requirement; the PDF affordance is deferred.
 *
 * Aggregation sources (only tables that exist on disk today):
 *   - `customers` — the full customer document (gov-ID number, full
 *     address, phone, email, consent metadata). The PII-bearing record.
 *   - `auditLog` filtered to `entityId === "customer:${customerId}"` —
 *     the canonical "everything that ever touched this customer" stream,
 *     including this very export at the tail (intentional and
 *     self-documenting per RA 10173 § 16 transparency).
 *   - `auditLog` filtered to `actor === customerId` — empty in Phase 1
 *     (customers don't have user accounts yet; Epic 9 portal lands
 *     them), but the join is defined so the contract doesn't change
 *     when Epic 9 ships.
 *
 * Sources NOT yet readable (placeholders in the report payload):
 *   - `customerDocuments` (Story 2.2 — uploaded ID scans). The story
 *     file's AC3 calls for an attachment appendix with signed URLs;
 *     until Story 2.2 lands, the `attachments: []` array is empty and
 *     accompanied by a `followUps` note.
 *   - `ownerships` (Story 2.5 — time-versioned ownership history).
 *     Same pattern: `ownerships: []` plus a follow-up note.
 *   - `contracts` / `payments` / `receipts` (Epic 3). Same pattern.
 *
 * Self-log invariant (AC5 of the story file):
 *   Before returning the payload to the admin, the mutation calls
 *   `logPiiAccess(ctx, { entityType: "customer", entityId: customerId,
 *   fields: ["full_record"], reason: args.reason })`. The
 *   `logPiiAccess` helper itself emits a `piiAccess` row in the audit
 *   log — so the report's `accessLog` array contains a self-reference
 *   to its own creation. This is the "self-documenting export" pattern
 *   RA 10173 transparency expects.
 *
 * Reason invariant (AC5 of the story file):
 *   `reason` must be ≥ 10 characters after trimming. Empty / short
 *   reasons fail with `VALIDATION`. The reason gets stamped on the
 *   audit row so an admin reviewer can later answer "why was this
 *   subject's full record read on 2026-05-19?" without ambiguity.
 *
 * Authorization (AC1):
 *   `await requireRole(ctx, ["admin"])` is the first awaited statement
 *   of the handler. Office staff and field workers cannot produce data-
 *   subject reports — RA 10173 § 21 makes Data Privacy Officer / admin
 *   the only legitimate caller. The route-level middleware gate
 *   (`/admin/*` in `src/middleware.ts`) is the defense-in-depth UI
 *   layer; this check is the enforcement.
 *
 * Non-existent customer (AC7):
 *   When the supplied `customerId` doesn't resolve to a row, the
 *   mutation throws `NOT_FOUND`. NO `logPiiAccess` row is written —
 *   logging a search for a non-existent subject would itself leak info
 *   ("the admin searched for Mrs. Smith at 3PM and Mrs. Smith doesn't
 *   exist" is data the audit log shouldn't carry).
 *
 * Related cornerstones:
 *   - `requireRole` (Story 1.2) — admin gating.
 *   - `logPiiAccess` (Story 2.3) — the PII access audit cornerstone;
 *     `produceDataSubjectReport` calls it once per invocation to
 *     self-log.
 *   - `emitAudit` (Story 1.6) — `logPiiAccess` delegates here.
 */

import {
  type DataModelFromSchemaDefinition,
  mutationGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type MutationCtx } from "./lib/auth";
import { logPiiAccess } from "./lib/piiAccess";
import { ErrorCode, throwError } from "./lib/errors";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type CustomerDoc = DataModel["customers"]["document"];
type CustomerId = CustomerDoc["_id"];
type AuditLogDoc = DataModel["auditLog"]["document"];

/** Minimum length, after trim, of the operator-supplied `reason`. */
export const REPORT_REASON_MIN_LENGTH = 10;

/**
 * Schema-versioned data-subject report payload. The `schemaVersion`
 * literal is part of the contract — downstream consumers (the cemetery's
 * legal counsel; future Convex archival exports) key off this string.
 * Future schema additions (Epic 3 contracts, Story 2.5 ownerships, etc.)
 * land as v2 with a new literal so subjects who received a v1 export
 * don't have to re-interpret old fields.
 */
export const DATA_SUBJECT_REPORT_SCHEMA_VERSION = "v1" as const;

export interface DataSubjectReportCustomerSection {
  customerId: CustomerId;
  fullName: string;
  phone: string | null;
  email: string | null;
  address: {
    line1: string;
    barangay: string | null;
    cityMunicipality: string | null;
    province: string | null;
    postalCode: string | null;
  };
  govIdType: CustomerDoc["govIdType"];
  govIdNumber: string;
  relationshipToOccupant: string | null;
  hasConsent: boolean;
  consentTimestamp: number | null;
  consentCapturedByUserId: CustomerDoc["consentCapturedByUserId"] | null;
  createdAt: number;
  createdByUserId: CustomerDoc["createdByUserId"];
  updatedAt: number;
}

export interface DataSubjectReportAuditEntry {
  auditLogId: AuditLogDoc["_id"];
  timestamp: number;
  actorUserId: AuditLogDoc["actor"];
  action: string;
  entityType: AuditLogDoc["entityType"];
  entityId: string;
  reason: string | null;
}

export interface DataSubjectReportFollowUp {
  source: string;
  status: "deferred";
  note: string;
}

export interface DataSubjectReport {
  schemaVersion: typeof DATA_SUBJECT_REPORT_SCHEMA_VERSION;
  generatedAt: number;
  generatedByUserId: DataModel["users"]["document"]["_id"];
  reason: string;
  customer: DataSubjectReportCustomerSection;
  /**
   * All audit-log entries about this customer (entries where
   * `entityType === "customer"` AND `entityId === customerId` OR
   * entries tagged `piiAccess` with the canonical ref
   * `"customer:${customerId}"`). Sorted ascending by timestamp.
   *
   * The very last entry — written by `logPiiAccess` inside this
   * mutation, just before the payload is assembled — is the export
   * itself. The self-reference is intentional (RA 10173 § 16
   * transparency).
   */
  customerAuditTrail: DataSubjectReportAuditEntry[];
  /**
   * Audit entries the customer (as actor) caused. Empty in Phase 1 —
   * customers don't have accounts until Epic 9. Kept as a typed empty
   * array so consumers' parsers don't have to special-case its
   * absence.
   */
  actsByCustomer: DataSubjectReportAuditEntry[];
  /**
   * Document attachments (Story 2.2). Empty until that story lands.
   * The follow-up note pointers (in `followUps` below) explains the
   * gap to the receiving subject.
   */
  attachments: never[];
  /**
   * Ownership history (Story 2.5). Empty until that story lands.
   */
  ownerships: never[];
  /**
   * Financial records (Epic 3). Empty until those stories land.
   */
  contracts: never[];
  payments: never[];
  receipts: never[];
  /**
   * Machine-readable list of data sources NOT yet integrated into the
   * report. Subjects can use this as a checklist to know which future
   * fields will appear when the corresponding domain ships.
   */
  followUps: DataSubjectReportFollowUp[];
}

/**
 * Produces the canonical data-subject report for a named customer.
 *
 * Implemented as a `mutation` rather than a `query` because the act of
 * generating the report writes to the audit log via `logPiiAccess`
 * (Story 2.3's helper signature is `MutationCtx | ActionCtx`, not
 * `QueryCtx`). The reactive read-only feel of a Convex query is not
 * appropriate here — each invocation is a distinct compliance event.
 *
 * Concurrency: there is no batching / caching. Each call produces a
 * fresh report and a fresh `piiAccess` audit row. NFR-S8 specifically
 * forbids caching here (would defeat the access log).
 *
 * Returns the full report payload. The admin UI offers a "download
 * JSON" affordance on top of this; the rich PDF / archive flow is
 * deferred (see file header).
 */
export const produceDataSubjectReport = mutationGeneric({
  args: {
    customerId: v.id("customers"),
    reason: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    args: { customerId: CustomerId; reason: string },
  ): Promise<DataSubjectReport> => {
    // FIRST line per the ESLint require-role-first-line rule.
    const auth = await requireRole(ctx, ["admin"]);

    // Validate the `reason` field before we go further. We do this
    // BEFORE the customer lookup so a short / missing reason doesn't
    // produce a "no such customer" leak path (the admin shouldn't be
    // able to probe customer existence by passing junk reasons).
    const reason = args.reason.trim();
    if (reason.length < REPORT_REASON_MIN_LENGTH) {
      throwError(
        ErrorCode.VALIDATION,
        `Reason must be at least ${REPORT_REASON_MIN_LENGTH} characters.`,
        { minLength: REPORT_REASON_MIN_LENGTH, actualLength: reason.length },
      );
    }

    // Customer existence check. AC7: missing customer throws NOT_FOUND
    // and we do NOT write a piiAccess row — logging a search for a
    // non-existent subject would leak the search itself.
    const customer = await ctx.db.get(args.customerId);
    if (customer === null) {
      throwError(ErrorCode.NOT_FOUND, "Customer not found.");
    }

    // Customer-scoped audit trail. The audit log is the primary
    // historical record about a customer; we read the full series
    // (sorted ascending) for the report.
    //
    // We pull from two angles:
    //   (a) Direct entity references: rows where
    //       entityType === "customer" AND entityId === customerId.
    //   (b) piiAccess events: rows where entityType === "piiAccess"
    //       AND entityId === `customer:${customerId}` (the canonical
    //       ref shape from `convex/lib/piiAccess.ts`).
    //
    // Both use the `by_entity` index for efficiency. Convex's
    // `.withIndex("by_entity", q => q.eq("entityType", ...).eq("entityId", ...))`
    // pattern lets us range-scan in O(matching rows) without a full
    // table scan.
    const directRows = await ctx.db
      .query("auditLog")
      .withIndex("by_entity", (q) =>
        q.eq("entityType", "customer").eq("entityId", args.customerId),
      )
      .collect();
    const piiAccessRows = await ctx.db
      .query("auditLog")
      .withIndex("by_entity", (q) =>
        q
          .eq("entityType", "piiAccess")
          .eq("entityId", `customer:${args.customerId}`),
      )
      .collect();

    // Audit entries the customer (as actor) caused — empty in Phase 1
    // because customers don't have user accounts (Epic 9 lands them).
    // We still issue the query so the join is defined; the index
    // lookup against `by_actor` returns zero rows.
    const actsByCustomerRows = await ctx.db
      .query("auditLog")
      .withIndex("by_actor", (q) =>
        // Customer IDs are not user IDs in Phase 1; the cast is the
        // documented "no actor will match" contract for now. When
        // Epic 9 lands and customers become users, the cast becomes
        // legitimate (the same string id will appear in both tables).
        q.eq(
          "actor",
          args.customerId as unknown as DataModel["users"]["document"]["_id"],
        ),
      )
      .collect();

    // Self-log: this report itself is a PII access. Doing this BEFORE
    // assembling the response means the row exists in the audit log
    // by the time we re-query — but to keep the report's
    // `customerAuditTrail` array stable + include the self-row, we
    // simply append a projection of the just-written self-event after
    // the queries. (Re-querying would double the index work; the
    // synthesized row is identical in content to what the index would
    // return.)
    await logPiiAccess(ctx, {
      entityType: "customer",
      entityId: args.customerId,
      fields: ["full_record"],
      reason,
    });

    // Compose the customer section. We surface every PII field
    // explicitly — this is the WHOLE POINT of a subject report: the
    // subject is entitled to see everything we hold. We do NOT redact
    // here (unlike audit emission); the admin reading this view IS
    // the legitimate access vector RA 10173 § 16 grants.
    const customerSection: DataSubjectReportCustomerSection = {
      customerId: customer._id,
      fullName: customer.fullName,
      phone: customer.phone ?? null,
      email: customer.email ?? null,
      address: {
        line1: customer.address.line1,
        barangay: customer.address.barangay ?? null,
        cityMunicipality: customer.address.cityMunicipality ?? null,
        province: customer.address.province ?? null,
        postalCode: customer.address.postalCode ?? null,
      },
      govIdType: customer.govIdType,
      govIdNumber: customer.govIdNumber,
      relationshipToOccupant: customer.relationshipToOccupant ?? null,
      hasConsent: customer.hasConsent,
      consentTimestamp: customer.consentTimestamp ?? null,
      consentCapturedByUserId: customer.consentCapturedByUserId ?? null,
      createdAt: customer.createdAt,
      createdByUserId: customer.createdByUserId,
      updatedAt: customer.updatedAt,
    };

    // Merge + sort the customer audit trail. We need a stable ordering
    // so the receiving subject can read it as a timeline. Ascending
    // by timestamp is the natural "history" reading order; ties (same
    // millisecond) sort by `_id` for determinism.
    const mergedAudit = [...directRows, ...piiAccessRows].sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return a._id < b._id ? -1 : a._id > b._id ? 1 : 0;
    });

    const customerAuditTrail: DataSubjectReportAuditEntry[] = mergedAudit.map(
      projectAuditEntry,
    );

    // Append a synthesized self-event for THIS export to the tail. We
    // build it from the values we just wrote rather than re-querying;
    // re-querying would still leave a race against any other audit
    // write that lands in the same instant.
    customerAuditTrail.push({
      // `auditLogId` is synthesized for this self-reference. We mark
      // it with a deterministic sentinel rather than re-querying the
      // freshly-inserted row — the inserted row IS the one already
      // captured in `piiAccessRows` if Convex's read-after-write
      // semantics include it, and is captured here otherwise. Either
      // way the subject sees the export.
      auditLogId: "self" as unknown as AuditLogDoc["_id"],
      timestamp: Date.now(),
      actorUserId: auth.userId,
      action: "read_pii",
      entityType: "piiAccess",
      entityId: `customer:${args.customerId}`,
      reason,
    });

    const actsByCustomer: DataSubjectReportAuditEntry[] = actsByCustomerRows
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(projectAuditEntry);

    // Follow-up references for domains that don't have on-disk tables
    // yet. These exist so the receiving subject can read the report
    // and know what's NOT in it — i.e. what to ask for separately if
    // those domains have records about them by the time they read this.
    const followUps: DataSubjectReportFollowUp[] = [
      {
        source: "customerDocuments",
        status: "deferred",
        note: "ID-scan attachments (Story 2.2) are not yet available on disk; once the table lands, attachment metadata + 24-hour signed URLs will be embedded here.",
      },
      {
        source: "ownerships",
        status: "deferred",
        note: "Time-versioned ownership history (Story 2.5) is not yet available on disk; once the table lands, every ownership tenure attributed to this customer will be embedded here.",
      },
      {
        source: "contracts",
        status: "deferred",
        note: "Sales contracts (Epic 3) are not yet available on disk; once those tables land, every contract where this customer is the named buyer will be embedded here.",
      },
      {
        source: "payments",
        status: "deferred",
        note: "Payment records (Epic 3) are not yet available on disk; once those tables land, every payment and allocation against this customer's contracts will be embedded here.",
      },
      {
        source: "receipts",
        status: "deferred",
        note: "BIR receipts (Epic 3) are not yet available on disk; once those tables land, every receipt issued to this customer will be embedded here.",
      },
    ];

    return {
      schemaVersion: DATA_SUBJECT_REPORT_SCHEMA_VERSION,
      generatedAt: Date.now(),
      generatedByUserId: auth.userId,
      reason,
      customer: customerSection,
      customerAuditTrail,
      actsByCustomer,
      attachments: [],
      ownerships: [],
      contracts: [],
      payments: [],
      receipts: [],
      followUps,
    };
  },
});

/**
 * Project an `auditLog` document into the lossless-but-redacted shape
 * the data-subject report carries. Notable: `before` / `after` payloads
 * are NOT included in the report. Those carry per-mutation deltas that
 * already include PII (redacted by `emitAudit`) but are not what a
 * subject access request is about — the SAR is about the data we hold,
 * not the diff stream that produced it. The timeline (with reason +
 * action) is sufficient transparency.
 */
function projectAuditEntry(row: AuditLogDoc): DataSubjectReportAuditEntry {
  return {
    auditLogId: row._id,
    timestamp: row.timestamp,
    actorUserId: row.actor,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    reason: row.reason ?? null,
  };
}
