/**
 * PII-access logging side-effect helper — Story 2.3.
 *
 * Side-effect helper called from queries / mutations that surface PII
 * (gov-ID number, full address, signed URLs of ID-scan blobs).
 * `logPiiAccess` adds an `auditLog` row tagged
 * `entityType: "piiAccess"` so Story 2.4's data-subject report and
 * Epic 5's "Recent PII access" admin tile have a single canonical
 * access set to query against.
 *
 * Why a separate file (not folded into `emitAudit`):
 *   - The semantic boundary is different. `emitAudit` rows describe a
 *     mutation that changed state; `logPiiAccess` rows describe a READ
 *     that surfaced PII. They share storage (the `auditLog` table) for
 *     operational simplicity (one table, one set of indexes, one place
 *     to look during incident response) but the helper contract is
 *     distinct: `logPiiAccess` accepts a parameterized entity reference
 *     (e.g. "customer:abc123") and a list of field names that were read,
 *     and it does NOT carry `before` / `after` payloads — there is no
 *     before/after on a read.
 *   - Entity-type-agnostic: any future record that contains PII (a
 *     customer detail page, a contract that embeds customer info, an
 *     interment record that surfaces next-of-kin contact) can call this
 *     helper without first being added to the audit `entityType` enum.
 *     We always log under `entityType: "piiAccess"`; the caller's actual
 *     entity type is embedded in the `entityId` ref (e.g.
 *     `"customer:abc123"`).
 *
 * Why we reuse the existing `auditLog` table:
 *   - `auditLog` already has the `entityType: "piiAccess"` literal in
 *     its schema validator (see `convex/schema.ts`).
 *   - The `by_actor`, `by_entity`, and `by_timestamp` indexes already
 *     support the breach-impact / "what did user X read" / "what was
 *     read in window [start, end]" access patterns NFR-C4 calls for.
 *   - One audit pipeline = fewer surprises during incident response.
 *
 * Authentication contract:
 *   PII reads require a logged-in user. If the caller has not been
 *   authenticated yet (no session, deactivated user, missing user
 *   record), `logPiiAccess` throws `UNAUTHENTICATED`. The expectation
 *   is that the surrounding query / mutation has already called
 *   `requireRole(...)` — `logPiiAccess` is the audit-trail side effect,
 *   not the gating mechanism. The double-resolution is intentional
 *   belt-and-suspenders: an audit row with a missing actor would
 *   defeat the purpose.
 *
 * Hard constraint — Convex query write semantics:
 *   `logPiiAccess` is typed against `MutationCtx | ActionCtx` because
 *   `auditLog` insertion is a write. Callers that need to log a PII
 *   read from inside a Convex `query` should either (a) restructure
 *   to expose the read as a mutation, or (b) schedule an internal
 *   mutation via `ctx.scheduler.runAfter(0, ...)`. The scheduler-based
 *   "async log from a query" pattern is documented in
 *   `docs/adr/0011-pii-access-logging.md`; it is a follow-up because
 *   Convex `_generated/` does not exist yet (no internal-mutation refs
 *   to schedule against).
 *
 * Related cornerstones:
 *   - `requireRole` (Story 1.2) — role gating; `logPiiAccess` is the
 *     audit side-effect that fires AFTER role gating succeeded.
 *   - `emitAudit` (Story 1.6) — mutation audit cornerstone. This
 *     helper delegates to it for the actual `auditLog` write.
 *
 * See `docs/adr/0011-pii-access-logging.md` for the full decision
 * record (the audit-row reuse, the QueryCtx tradeoff, the
 * entity-type-agnostic shape).
 *
 * Encryption-at-rest boundary (Story 2.8 / ADR-0007):
 *   This helper logs WHO read WHEN. The underlying PII bytes are
 *   encrypted at rest by Convex's managed infrastructure (NFR-S2);
 *   see `docs/adr/0007-pii-encryption.md`. The two protections are
 *   independent and complementary — ADR-0011 defends against insider
 *   misuse + breach-impact response; ADR-0007 defends against
 *   storage-tier exfiltration.
 */

import {
  type DataModelFromSchemaDefinition,
} from "convex/server";

import schema from "../schema";
import { emitAudit, type ActionCtx, type MutationCtx } from "./audit";
import { getCurrentUserAndRoles } from "./auth";
import { ErrorCode, throwError } from "./errors";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type CustomerDoc = DataModel["customers"]["document"];
type CustomerId = CustomerDoc["_id"];

/**
 * Convex value shape the `auditLog.after` JSON blob carries for PII
 * reads. Always wrapped in an object (never a bare array) so consumers
 * can introspect `fieldsRead` without a length check.
 */
export interface PiiAccessAuditPayload {
  fieldsRead: string[];
}

/**
 * Parameters accepted by `logPiiAccess`.
 *
 * `entityType` is the caller's domain entity type (e.g. "customer",
 * "contract", "ownership"). This becomes the prefix of the canonical
 * `entityId` ref written to `auditLog.entityId` — so a customer read
 * surfaces as `"customer:abc123"`, a contract read as
 * `"contract:xyz789"`, etc. The audit `entityType` column always says
 * `"piiAccess"` regardless; the polymorphic disambiguation lives in
 * the `entityId` ref. This keeps the `auditLog.entityType` validator
 * stable and lets us add PII surfaces in future stories without a
 * schema migration.
 *
 * `entityId` is the raw Convex document id (a string under the hood);
 * `logPiiAccess` synthesizes the ref `"${entityType}:${entityId}"`
 * before writing.
 *
 * `fields` is the list of PII field names the caller surfaced (e.g.
 * `["govIdNumber", "fullAddress"]`). Optional because in the file-view
 * case (signed URL of an ID-scan blob) the "field" is the whole file
 * — the caller can omit `fields` and the helper writes
 * `fieldsRead: []`.
 *
 * `reason` is free-text caller-supplied context (e.g.
 * `"customer detail page open"`). Passed through verbatim into the
 * audit row's `reason` column; never redacted (it's caller-controlled
 * metadata, not customer PII).
 */
export interface LogPiiAccessParams {
  entityType: string;
  entityId: string;
  fields?: string[];
  reason?: string;
}

/**
 * Append a `piiAccess` audit row capturing a PII surface event.
 *
 * Contract:
 *   1. Caller MUST be authenticated. If `getCurrentUserAndRoles`
 *      returns null, throws `UNAUTHENTICATED`. (PII reads from an
 *      unauthenticated context would leave the `actor` field unset,
 *      defeating the audit trail.)
 *   2. The audit row is written BEFORE control returns to the caller.
 *      In a mutation, this is part of the surrounding transaction; if
 *      the audit write fails the surrounding mutation rolls back too.
 *   3. The helper returns nothing useful — callers wire it as a
 *      `await logPiiAccess(...)` side-effect adjacent to the PII
 *      surface.
 *
 * Usage from a `customers:getCustomer`-style query that surfaces PII:
 *   1. Restructure the query as a mutation (because audit-row insert
 *      is a write — see file header), OR
 *   2. From a real query, schedule an internal mutation to write the
 *      audit row asynchronously (Convex queries cannot write directly).
 *      This is the documented follow-up path; the helper as currently
 *      typed accepts only `MutationCtx | ActionCtx`.
 *
 * Throws ConvexError with one of:
 *   - UNAUTHENTICATED — no resolved user (no session, deactivated
 *     account, missing user record).
 */
export async function logPiiAccess(
  ctx: MutationCtx | ActionCtx,
  params: LogPiiAccessParams,
): Promise<void> {
  // Resolve the actor. `getCurrentUserAndRoles` takes a `ReadableCtx`
  // (Query | Mutation); `MutationCtx` is assignable. For `ActionCtx`,
  // user resolution flows through `runQuery` / `runMutation` — we
  // surface that gap explicitly here rather than silently dropping the
  // audit row. Story 1.6's ActionCtx transport gap (same root cause)
  // is tracked separately; this helper inherits the same `_generated/`
  // dependency.
  if (!("db" in ctx)) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      "logPiiAccess from an ActionCtx requires the internal-mutation transport (Story 2.3 follow-up gated on convex/_generated/).",
    );
  }
  const payload = await getCurrentUserAndRoles(ctx);
  if (payload === null) {
    throwError(
      ErrorCode.UNAUTHENTICATED,
      "Cannot log PII access from an unauthenticated context.",
    );
  }
  // Delegate to `emitAudit` so the row goes through the same redaction
  // / validation pipeline as every other audit write. We pass
  // `action: "read_pii"` — that action exists in `AUDIT_ACTIONS`
  // specifically for this case (see `convex/lib/audit.ts` JSDoc on
  // the controlled vocabulary).
  const fieldsRead: string[] = params.fields ?? [];
  const after: PiiAccessAuditPayload = { fieldsRead };
  await emitAudit(ctx, {
    action: "read_pii",
    entityType: "piiAccess",
    entityId: `${params.entityType}:${params.entityId}`,
    after,
    ...(params.reason !== undefined ? { reason: params.reason } : {}),
  });
}

/**
 * Whitelist of PII field names that `readPii` recognises on a
 * `customers` row. Mirrors the redaction set in
 * `convex/lib/audit.ts:PII_*` but kept narrow to the customer schema
 * so a typo in the caller surfaces at the type-check boundary.
 *
 * The literal union is exported as the `readPii` `fields` arg type so
 * call sites get autocompletion + invalid-field rejection inside
 * TypeScript — a defense-in-depth layer on top of the runtime check.
 */
export type CustomerPiiField =
  | "govIdNumber"
  | "address"
  | "phone"
  | "email";

/**
 * Options accepted by `readPii`. `reason` flows through to the audit
 * row's `reason` column (operator-controlled free text — e.g.
 * "customer detail page open"). Optional because most call sites are
 * self-describing from `entityType` + `fields`.
 */
export interface ReadPiiOptions {
  reason?: string;
}

/**
 * Projection shape returned by `readPii<F>`. Each requested field
 * lands as an optional property — Convex's customer row may legitimately
 * omit `phone` / `email` / `relationshipToOccupant` — so callers must
 * narrow before display. The opaque `customerId` is always present so
 * the caller can wire deep-links without a second lookup.
 *
 * `govIdNumber` carries the FULL gov-ID number (not redacted). This
 * helper is the audit-tracked surface for full-PII reads; the redacted
 * forms (last-4, etc.) belong to the call-site projection, not here.
 */
export type CustomerPiiProjection<F extends CustomerPiiField> = {
  customerId: CustomerId;
} & {
  [K in F]?: K extends "address" ? CustomerDoc["address"] : string;
};

/**
 * Reads the requested PII fields off a `customers` row AND emits the
 * matching `auditLog` row via `logPiiAccess`. The single audited
 * surface for "I want to display PII X / Y / Z to a staff user."
 *
 * Contract:
 *   1. Caller MUST already have called `requireRole(ctx, [...])`. This
 *      helper trusts the surrounding mutation has done the gating.
 *      The audit row is the trail, not the gate.
 *   2. Caller MUST be authenticated — `logPiiAccess` (which this
 *      delegates to) throws `UNAUTHENTICATED` otherwise.
 *   3. `fields` MUST be non-empty. The audit row needs the field list
 *      to be meaningful; calling with `[]` is a category error.
 *   4. The matched customer row is loaded via `ctx.db.get` inside this
 *      helper — the call is RECOGNISED by the
 *      `local-rules/no-direct-pii-read` ESLint rule as an authorised
 *      access. Callers that go through `readPii` therefore satisfy
 *      AC4 of Story 2.3 automatically.
 *   5. Returns `null` when the customer id does not resolve to a row.
 *      Throwing `NOT_FOUND` is the caller's choice — surfacing the
 *      missing row vs. silently returning is a domain concern, not a
 *      PII-helper concern.
 *
 * Throws ConvexError with one of:
 *   - UNAUTHENTICATED — `logPiiAccess` failed because no user is
 *     resolved (defense in depth — the gate above should have caught
 *     this).
 *   - VALIDATION — `fields` is empty.
 *
 * @param ctx The mutation / action ctx carrying `db` + auth.
 * @param customerId The customer row's `_id`.
 * @param fields Non-empty array of PII field names to project.
 * @param opts Optional `reason` free-text passed through to the audit row.
 */
export async function readPii<F extends CustomerPiiField>(
  ctx: MutationCtx,
  customerId: CustomerId,
  fields: ReadonlyArray<F>,
  opts: ReadPiiOptions = {},
): Promise<CustomerPiiProjection<F> | null> {
  if (fields.length === 0) {
    throwError(
      ErrorCode.VALIDATION,
      "readPii requires at least one PII field.",
      { customerId },
    );
  }
  // pii-read-ok: this helper is the audited entry point; the lint rule
  // exempts ctx.db.get inside convex/lib/piiAccess.ts via its allowed-
  // basename list.
  const customer = await ctx.db.get(customerId);
  if (customer === null) {
    return null;
  }
  // Project ONLY the requested fields onto the result. Never spread
  // `...customer` — that would defeat the "narrow projection" contract
  // and re-leak PII the caller didn't ask for through the audit
  // surface.
  const projection: CustomerPiiProjection<F> = {
    customerId: customer._id,
  } as CustomerPiiProjection<F>;
  const out = projection as Record<string, unknown>;
  for (const field of fields) {
    const value = (customer as unknown as Record<string, unknown>)[field];
    if (value !== undefined) {
      out[field] = value;
    }
  }
  // Audit row goes AFTER the projection so a thrown audit-write surfaces
  // before the caller can consume the bytes (defence against partially-
  // logged accesses).
  await logPiiAccess(ctx, {
    entityType: "customer",
    entityId: customerId,
    fields: [...fields],
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
  });
  return projection;
}
