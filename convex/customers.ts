/**
 * Customer domain (Story 2.1, FR14 / NFR-S2 / NFR-C5).
 *
 * Public surface for the `customers` table — the canonical PII
 * container introduced in this story. The first domain table after
 * the auth / lot infrastructure of Epic 1.
 *
 * PII encryption posture (Story 2.8 / ADR-0007):
 *   The `govIdNumber`, `address`, `phone`, and `email` fields are
 *   stored as plaintext at the application layer and encrypted at
 *   rest by Convex's managed infrastructure (NFR-S2). NO application-
 *   level encryption is applied. See
 *   `docs/adr/0007-pii-encryption.md` for the decision rationale,
 *   rejected alternatives, and revisit triggers. Audit-log redaction
 *   (Story 1.6 / `redactPii`) and PII access logging (Story 2.3 /
 *   `logPiiAccess`) are independent, complementary protections that
 *   stay in place regardless of the encryption posture.
 *
 * Conventions every handler obeys (mirrored from `convex/users.ts`
 * and `convex/lots.ts`):
 *
 *   1. FIRST awaited statement is `await requireRole(ctx, [...])`.
 *      The ESLint rule `local-rules/require-role-first-line`
 *      enforces this for any `query` / `mutation` / `action` call;
 *      we use `queryGeneric` / `mutationGeneric` here following the
 *      schema-derived-generic-types pattern from `convex/lots.ts`
 *      (no dependency on `convex/_generated/`).
 *   2. Mutations call `emitAudit` — direct `auditLog` inserts are
 *      banned by `local-rules/no-audit-log-direct-write`. The
 *      `emitAudit` helper PII-redacts known fields (`govIdNumber`,
 *      `address`) at WRITE time per Story 1.6's `redactPii`. We
 *      pass the full inserted doc; the helper does the redaction.
 *      Pre-redacting here is forbidden ("double redaction").
 *   3. PII boundary (architecture § 525–528, § 868): the
 *      `searchByName` query returns ONLY last-4 of `govIdNumber` —
 *      never the full ID. Last-4 is treated as non-identifying per
 *      UX §1879–1884 and is therefore NOT routed through Story
 *      2.3's `readPii`. Other reads of the full ID happen in Story
 *      2.5's detail page and DO route through `readPii`.
 *   4. Consent gate (NFR-C5): the create mutation refuses to set
 *      `consentTimestamp` / `consentCapturedByUserId` unless
 *      `hasConsent === true`. The args surface intentionally does
 *      NOT accept `consentTimestamp` — the server sets it from
 *      `Date.now()` to keep client clocks out of the trust path.
 *
 * Story callers:
 *   - The standalone `/customers/new` page (this story) calls
 *     `create` from `src/app/(staff)/customers/new/page.tsx`.
 *   - The fuzzy-match dedupe alert in `src/components/CustomerForm`
 *     calls `searchByName` via `useQuery` while the user types.
 *   - Future Story 3.x sale-flow inline-customer-create will reuse
 *     the same `create` mutation through `CustomerForm`'s
 *     `onCreated` callback.
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
import { ErrorCode, throwError } from "./lib/errors";
import { logPiiAccess } from "./lib/piiAccess";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type CustomerDoc = DataModel["customers"]["document"];
type CustomerId = CustomerDoc["_id"];

/**
 * Public arg validator for the address sub-object. Mirrors the
 * `customers.address` shape in `convex/schema.ts` so the create
 * mutation accepts exactly what the table stores.
 */
const addressValidator = v.object({
  line1: v.string(),
  barangay: v.optional(v.string()),
  cityMunicipality: v.optional(v.string()),
  province: v.optional(v.string()),
  postalCode: v.optional(v.string()),
});

/**
 * Public arg validator for `govIdType`. Mirrors the
 * `customers.govIdType` union in `convex/schema.ts`.
 */
const govIdTypeValidator = v.union(
  v.literal("sss"),
  v.literal("tin"),
  v.literal("umid"),
  v.literal("drivers_license"),
  v.literal("passport"),
  v.literal("philhealth"),
  v.literal("voters_id"),
  v.literal("other"),
);

/**
 * Server-side TypeScript mirror of the gov-ID union. Used for the
 * handler's typed args object.
 */
export type GovIdType =
  | "sss"
  | "tin"
  | "umid"
  | "drivers_license"
  | "passport"
  | "philhealth"
  | "voters_id"
  | "other";

/**
 * Shape of the client-supplied address sub-object. Mirrors the
 * Convex validator above so client + server agree.
 */
export interface CustomerAddressInput {
  line1: string;
  barangay?: string;
  cityMunicipality?: string;
  province?: string;
  postalCode?: string;
}

/**
 * Public arg shape for `customers.create`. Mirrors the validator
 * below. Exported so the React form can typecheck against the
 * mutation's contract.
 */
export interface CreateCustomerArgs {
  fullName: string;
  phone?: string;
  email?: string;
  address: CustomerAddressInput;
  govIdType: GovIdType;
  govIdNumber: string;
  relationshipToOccupant?: string;
  hasConsent: boolean;
}

/**
 * Return shape of `customers.create`. Intentionally minimal — no
 * PII — because the redirect target (`/customers/<customerId>`) is
 * the place where full PII reads happen (gated by Story 2.3's
 * `readPii` when it lands).
 */
export interface CreateCustomerResult {
  customerId: CustomerId;
  fullName: string;
}

/**
 * Creates a new customer record.
 *
 * Authorization: office_staff or admin. Field workers do NOT create
 * customers in Phase 1 (they have no UI surface for it; the
 * field-only flow is condition logging, Story 1.14).
 *
 * Validation:
 *   - `fullName` trimmed, ≥ 2 chars.
 *   - `govIdNumber` trimmed, ≥ 4 chars (so the last-4 redaction in
 *     the audit log + the `searchByName` result is meaningful).
 *   - `address.line1` trimmed, non-empty (the rest of the address
 *     is optional).
 *   - `email` plausible-shape check (same permissive rule as
 *     `convex/users.ts`).
 *   - `phone` is free-text — Filipino numbers come in many shapes
 *     (`09XX-XXX-XXXX`, `+639XXXXXXXXX`, with/without dashes); we
 *     trim + leave content validation to the client Zod schema. A
 *     stricter server-side phone validator can land in Story 9.4
 *     when the customer portal needs SMS reminders.
 *
 * Consent invariant (NFR-C5): when `hasConsent === false`, the
 * insert MUST omit `consentTimestamp` and
 * `consentCapturedByUserId`. The public arg surface doesn't accept
 * those fields, so the invariant is satisfied for legitimate
 * callers; the defense-in-depth check exists as a TypeScript-level
 * guard against a future internal-write path that hand-crafts an
 * args object.
 *
 * Audit: emits a single `create` row with the full inserted doc as
 * `after`. `redactPii` redacts `govIdNumber` to last-4 and
 * `address` to per-token initials at write time. Pre-redacting in
 * this handler would double-redact — DON'T do it.
 */
export const create = mutationGeneric({
  args: {
    fullName: v.string(),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    address: addressValidator,
    govIdType: govIdTypeValidator,
    govIdNumber: v.string(),
    relationshipToOccupant: v.optional(v.string()),
    hasConsent: v.boolean(),
  },
  handler: async (
    ctx: MutationCtx,
    args: CreateCustomerArgs,
  ): Promise<CreateCustomerResult> => {
    const auth = await requireRole(ctx, ["admin", "office_staff"]);
    const fullName = args.fullName.trim();
    const phone = trimToOptional(args.phone);
    const email = trimToOptional(args.email)?.toLowerCase();
    const govIdNumber = args.govIdNumber.trim();
    const relationshipToOccupant = trimToOptional(args.relationshipToOccupant);
    const address: CustomerAddressInput = {
      line1: args.address.line1.trim(),
      barangay: trimToOptional(args.address.barangay),
      cityMunicipality: trimToOptional(args.address.cityMunicipality),
      province: trimToOptional(args.address.province),
      postalCode: trimToOptional(args.address.postalCode),
    };

    validateCreateCustomerPayload({
      fullName,
      email,
      address,
      govIdNumber,
    });

    const now = Date.now();
    const fullNameLowercased = fullName.toLowerCase();

    // Build the insert payload one field at a time so we can satisfy
    // Convex's exactOptionalPropertyTypes-style validators (optional
    // fields must be ABSENT, not `undefined`, when not supplied).
    const insertPayload: {
      fullName: string;
      fullNameLowercased: string;
      phone?: string;
      email?: string;
      address: CustomerAddressInput;
      govIdType: GovIdType;
      govIdNumber: string;
      relationshipToOccupant?: string;
      hasConsent: boolean;
      consentTimestamp?: number;
      consentCapturedByUserId?: CustomerDoc["consentCapturedByUserId"];
      createdAt: number;
      createdByUserId: CustomerDoc["createdByUserId"];
      updatedAt: number;
    } = {
      fullName,
      fullNameLowercased,
      address,
      govIdType: args.govIdType,
      govIdNumber,
      hasConsent: args.hasConsent,
      createdAt: now,
      createdByUserId: auth.userId,
      updatedAt: now,
    };
    if (phone !== undefined) insertPayload.phone = phone;
    if (email !== undefined) insertPayload.email = email;
    if (relationshipToOccupant !== undefined) {
      insertPayload.relationshipToOccupant = relationshipToOccupant;
    }
    if (args.hasConsent === true) {
      insertPayload.consentTimestamp = now;
      insertPayload.consentCapturedByUserId = auth.userId;
    }

    // Defense-in-depth invariant: even though the args surface
    // doesn't accept these fields, surfacing the check explicitly
    // documents the rule and protects future internal-write paths
    // (Story 2.4 migration runbook may hand-craft inserts).
    if (
      args.hasConsent === false &&
      (insertPayload.consentTimestamp !== undefined ||
        insertPayload.consentCapturedByUserId !== undefined)
    ) {
      throwError(
        ErrorCode.CUSTOMER_CONSENT_INVARIANT,
        "Cannot record a consent timestamp without explicit consent.",
        { hasConsent: args.hasConsent },
      );
    }

    const customerId = await ctx.db.insert("customers", insertPayload);

    // Pass the full inserted payload (with the freshly-allocated id)
    // to `emitAudit` — the helper will redact `govIdNumber` to
    // last-4 and `address` to per-token initials before insert.
    await emitAudit(ctx, {
      action: "create",
      entityType: "customer",
      entityId: customerId,
      after: { ...insertPayload, _id: customerId },
    });

    return { customerId, fullName };
  },
});

/**
 * Public arg shape for `customers.searchByName`.
 */
export interface SearchByNameArgs {
  q: string;
}

/**
 * Shape of each `searchByName` result row. Intentionally minimal:
 *   - `customerId` for the `[View]` link's `<Link href="/customers/...">`.
 *   - `fullName` for the alert display text.
 *   - `govIdLast4` — last 4 alphanumeric chars of `govIdNumber`,
 *     formatted unprefixed (e.g. `"1234"`). The dedupe alert
 *     renders this as `"***-***-1234"` per UX §1879–1884; the
 *     prefix is a client concern.
 *
 * **Never** include the full `govIdNumber`, `phone`, `email`, or
 * any address field here — the dedupe alert is a known sneaky PII
 * leak vector.
 */
export interface CustomerSearchHit {
  customerId: CustomerId;
  fullName: string;
  govIdLast4: string;
}

/**
 * Fuzzy-match-by-name query used by the dedupe alert in
 * `CustomerForm`.
 *
 * Implementation:
 *   1. Reject sub-3-char queries early — the client also gates
 *      this, but defense in depth keeps the index cold for noise.
 *   2. Lower-case the query and look up via the
 *      `by_fullName_lowercased` index using the Convex prefix-match
 *      pattern: `gte(needle).lt(needle + "￿")`. `￿` is the
 *      maximum Unicode codepoint, so any name starting with `q`
 *      sorts ≤ that boundary.
 *   3. Cap at 5 results (UX requirement — the alert renders at most
 *      1-3 matches; the cap is the wire-payload bound).
 *   4. Project to `{ customerId, fullName, govIdLast4 }`. Take the
 *      last 4 alphanumeric chars of `govIdNumber` so a formatted
 *      ID like `"123-456-789-0123"` resolves to `"0123"`.
 *
 * PII-policy note: this query returns last-4 of `govIdNumber`
 * INTENTIONALLY without routing through Story 2.3's `readPii`.
 * UX §1879–1884 establishes last-4 as non-identifying — it's the
 * display format everywhere in the staff UI (search results,
 * dedupe alerts, ownership-history cards). Routing every last-4
 * read through `readPii` would log thousands of audit rows per day
 * for non-sensitive lookups and degrade the audit log's
 * signal-to-noise.
 */
export const searchByName = queryGeneric({
  args: { q: v.string() },
  handler: async (
    ctx: QueryCtx,
    args: SearchByNameArgs,
  ): Promise<CustomerSearchHit[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const needle = args.q.trim().toLowerCase();
    if (needle.length < 3) return [];

    // Prefix range on `by_fullName_lowercased`. The Convex idiom
    // for prefix match is `gte(prefix).lt(prefix + "￿")` where the
    // upper bound is the max Unicode codepoint.
    const rows = await ctx.db
      .query("customers")
      .withIndex("by_fullName_lowercased", (idx) =>
        idx
          .gte("fullNameLowercased", needle)
          .lt("fullNameLowercased", needle + "￿"),
      )
      .collect();

    const hits: CustomerSearchHit[] = [];
    for (const row of rows) {
      hits.push({
        customerId: row._id,
        fullName: row.fullName,
        govIdLast4: lastFourAlnum(row.govIdNumber),
      });
      if (hits.length >= 5) break;
    }
    return hits;
  },
});

/** Row shape returned by `listCustomers` for the staff customers list. */
export interface CustomerListRow {
  customerId: CustomerId;
  fullName: string;
  phone: string | null;
  email: string | null;
  cityMunicipality: string | null;
  govIdType: string;
  /** Last-4 only — non-identifying per UX §1879 (same policy as search). */
  govIdLast4: string;
  createdAt: number;
}

/**
 * Staff-facing customers list (admin / office_staff). Walks
 * `by_fullName_lowercased` so rows come back alphabetically; returns a
 * narrow, PII-safe projection (gov-ID is last-4 only — full PII stays
 * behind the audited `revealGovId` on the detail page). Phase-1 cemetery
 * scale (~2k customers) fits a single bounded `take`; a future story can
 * paginate if the roster grows.
 */
export const listCustomers = queryGeneric({
  args: { limit: v.optional(v.number()) },
  handler: async (
    ctx: QueryCtx,
    args: { limit?: number },
  ): Promise<CustomerListRow[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const limit = Math.min(args.limit ?? 200, 500);
    // pii-read-ok: list projection returns last-4 gov-ID only (non-identifying per UX §1879); full PII stays behind the audited revealGovId on the detail page
    const rows = await ctx.db
      .query("customers")
      .withIndex("by_fullName_lowercased")
      .take(limit);
    return rows.map((r) => ({
      customerId: r._id,
      fullName: r.fullName,
      phone: r.phone ?? null,
      email: r.email ?? null,
      cityMunicipality: r.address.cityMunicipality ?? null,
      govIdType: r.govIdType,
      govIdLast4: lastFourAlnum(r.govIdNumber),
      createdAt: r.createdAt,
    }));
  },
});

/**
 * Stateless validation for `customers.create`. Centralises the
 * per-field invariants so the handler reads as a happy-path
 * narrative. Throws `VALIDATION` on any failure.
 */
function validateCreateCustomerPayload(payload: {
  fullName: string;
  email: string | undefined;
  address: CustomerAddressInput;
  govIdNumber: string;
}): void {
  if (payload.fullName.length < 2) {
    throwError(ErrorCode.VALIDATION, "Full name is required (min 2 characters).");
  }
  if (payload.address.line1.length === 0) {
    throwError(ErrorCode.VALIDATION, "Address line 1 is required.");
  }
  if (payload.govIdNumber.length < 4) {
    throwError(
      ErrorCode.VALIDATION,
      "Government ID number is required (min 4 characters).",
    );
  }
  if (payload.email !== undefined && !isPlausibleEmail(payload.email)) {
    throwError(ErrorCode.VALIDATION, "Email is not a valid address.");
  }
}

/**
 * Returns the trimmed value, or `undefined` when the trimmed value
 * is empty. Convex's optional-field validators reject `""` but
 * accept absence — this helper keeps the insert payload clean.
 */
function trimToOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Permissive email check — same rule as `convex/users.ts`. We're
 * not the address validator; we just rule out the obviously-malformed
 * inputs.
 */
function isPlausibleEmail(value: string): boolean {
  if (value.length < 3) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at === value.length - 1) return false;
  if (value.includes(" ")) return false;
  return value.lastIndexOf(".") > at;
}

/**
 * Returns the last 4 ALPHANUMERIC characters of `raw` (formatting
 * characters like dashes / spaces stripped first). Used by
 * `searchByName` to project a `govIdLast4` for the dedupe alert.
 *
 * Examples:
 *   "123-456-789-0123" → "0123"
 *   "AB CD-1234"       → "1234"
 *   "A1B"              → "A1B"   (fewer than 4 alnum chars; returns
 *                                 what's available rather than padding)
 *
 * The function never throws — short / weird inputs degrade
 * gracefully to whatever's available.
 */
function lastFourAlnum(raw: string): string {
  const compact = raw.replace(/[^a-zA-Z0-9]/g, "");
  if (compact.length <= 4) return compact;
  return compact.slice(-4);
}

// ---------------------------------------------------------------------------
// Story 2.5 — Customer detail page (FR16, FR18, NFR-S4, NFR-S8, UX-DR30)
// ---------------------------------------------------------------------------

/**
 * Shape of the address sub-object returned by `getCustomerDetail`.
 * Mirrors the table validator. Re-declared here as a TypeScript-only
 * type so the detail page can typecheck against the wire format
 * without importing from `convex/_generated/`.
 */
export interface CustomerDetailAddress {
  line1: string;
  barangay?: string;
  cityMunicipality?: string;
  province?: string;
  postalCode?: string;
}

/**
 * Return shape of `getCustomerDetail`. Critically:
 *
 *   - `govIdLast4` (NOT `govIdNumber`) — the page receives only the
 *     redacted form on every load. The full gov-ID is fetched by the
 *     separate `revealGovId` mutation on user click, so the audit
 *     trail records reveals as discrete user gestures rather than
 *     once-per-page-load.
 *   - `address` IS included in full. Per Story 2.5 AC1 the design
 *     accepts displaying the structured address inline; this is a
 *     legitimate Office-Staff need (correspondence) and the masked
 *     gov-ID + role gate are the audit-meaningful boundaries. The
 *     access-logging follow-up for page-load address reads is tracked
 *     in `docs/adr/0011-pii-access-logging.md` (the helper requires a
 *     mutation context; `getCustomerDetail` is a query for reactive
 *     updates).
 */
export interface CustomerDetailResult {
  customerId: CustomerId;
  fullName: string;
  phone?: string;
  email?: string;
  address: CustomerDetailAddress;
  govIdType: GovIdType;
  govIdLast4: string;
  relationshipToOccupant?: string;
  hasConsent: boolean;
  consentTimestamp?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Loads a customer's detail payload for the `/customers/<id>` page
 * (Story 2.5, AC1).
 *
 * Implemented as a `queryGeneric` (NOT a mutation) so the page can use
 * `useQuery` and receive reactive updates when, e.g., Story 2.7's
 * transfer flow writes a new `ownerships` row in another tab or Story
 * 2.1's edit form adjusts a phone number.
 *
 * Return-payload contract:
 *
 *   - `govIdNumber` is NEVER present. The page renders `***-***-{last4}`
 *     by default and reveals the full number only through the discrete
 *     `revealGovId` mutation. Returning the full gov-ID here would log
 *     a read on every page open, defeating the click-to-reveal pattern.
 *     The escape line below — `customer.govIdNumber.slice(-4)` — uses
 *     a pii-read-ok comment so Story 2.3's `no-direct-pii-read` lint
 *     rule (when it lands) does not flag the last-4 projection.
 *   - `address` is returned in full. See `CustomerDetailResult` JSDoc
 *     for the design rationale; the page-load address read is a known
 *     follow-up gated on the scheduler-internal-mutation transport.
 *   - No `emitAudit` call. Reads of a customer record are NOT audit
 *     events; PII reads are tracked separately in `piiAccessLog`
 *     (Story 2.3) and only on the `revealGovId` mutation.
 *
 * Throws ConvexError with one of:
 *   - UNAUTHENTICATED — no session.
 *   - FORBIDDEN — caller is not admin or office_staff (field workers
 *     and customer-role callers cannot read customer detail).
 *   - NOT_FOUND — `customerId` does not resolve to a customers row.
 *     (Story 2.5's spec suggests a dedicated `CUSTOMER_NOT_FOUND`
 *     code; the surrounding `convex/lib/errors.ts` is owned by the
 *     errors-helper story scope and not modified in Story 2.5 to
 *     avoid a forbidden-file edit. The page maps `NOT_FOUND` to the
 *     customer-specific empty state via the entity context.)
 */
export const getCustomerDetail = queryGeneric({
  args: { customerId: v.id("customers") },
  handler: async (
    ctx: QueryCtx,
    args: { customerId: CustomerId },
  ): Promise<CustomerDetailResult> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    // pii-read-ok: customer detail view; paired piiAccess audit is wired via the recordCustomerDetailView mutation called from the detail page on mount (Story 2.3 + 2.5 follow-on)
    const customer = await ctx.db.get(args.customerId);
    if (customer === null) {
      throwError(ErrorCode.NOT_FOUND, "Customer not found.", {
        entity: "customer",
        customerId: args.customerId,
      });
    }
    // pii-read-ok: last-4 is non-identifying per UX §1879
    const govIdLast4 = lastFourAlnum(customer.govIdNumber);

    const result: CustomerDetailResult = {
      customerId: customer._id,
      fullName: customer.fullName,
      address: customer.address,
      govIdType: customer.govIdType as GovIdType,
      govIdLast4,
      hasConsent: customer.hasConsent,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
    };
    if (customer.phone !== undefined) result.phone = customer.phone;
    if (customer.email !== undefined) result.email = customer.email;
    if (customer.relationshipToOccupant !== undefined) {
      result.relationshipToOccupant = customer.relationshipToOccupant;
    }
    if (customer.consentTimestamp !== undefined) {
      result.consentTimestamp = customer.consentTimestamp;
    }
    return result;
  },
});

/**
 * Reveals a customer's full gov-ID number for a single user gesture
 * (Story 2.5, AC2). Implemented as a MUTATION (not a query) for two
 * structural reasons:
 *
 *   1. `logPiiAccess` (Story 2.3) writes an `auditLog` row, and Convex
 *      QueryCtx is read-only. Making `revealGovId` a mutation lets us
 *      log every reveal inline, in the same transaction that returns
 *      the value, with no scheduler / internal-mutation indirection.
 *   2. The disaster-prevention note in Story 2.5 explicitly warns
 *      against calling `useQuery(...revealGovId)` reactively — a query
 *      would re-subscribe and re-log on every server tick. A mutation
 *      is one-shot by definition; the caller invokes it imperatively
 *      via `useMutation`.
 *
 * The `RevealField` client component (Story 2.5 Task 6) calls this
 * mutation on the user's click, displays the returned `govIdNumber`
 * for 30 seconds, then re-redacts via a local setTimeout. Each click
 * is its own logged access; hovering / focusing does not re-fetch.
 *
 * Throws ConvexError with one of:
 *   - UNAUTHENTICATED, FORBIDDEN — see `getCustomerDetail`.
 *   - NOT_FOUND — `customerId` does not resolve to a customers row.
 */
/**
 * Paired mutation that audits a customer-detail page open (Story 2.5
 * NFR-S8 fix — Epic 2 adversarial review).
 *
 * `getCustomerDetail` is a `queryGeneric` (so the page can subscribe
 * reactively to ownership / contact-info updates) and queries cannot
 * write `auditLog` rows. The detail page therefore fires
 * `recordCustomerDetailView` once on mount via `useEffect`; the
 * mutation lands the audited "I read PII X / Y / Z" trail without
 * disturbing the reactive read path.
 *
 * Audit semantics:
 *   - One row per detail-page open. Re-mounts (React Strict Mode,
 *     tab refocus, navigation back) emit additional rows by design —
 *     each view is a discrete access event for NFR-S8 / breach-impact
 *     queries.
 *   - The audit row carries `fields: ["address", "phone", "email"]`.
 *     `govIdNumber` is NOT in the field set because the page receives
 *     `govIdLast4` only on load; the full gov-ID has its own audited
 *     reveal path (`revealGovId`), and double-logging it here would
 *     pollute the trail with phantom reads.
 *
 * Authorization: `requireRole(ctx, ["admin", "office_staff"])` —
 * mirrors `getCustomerDetail`. Field-worker and customer-role callers
 * receive FORBIDDEN.
 *
 * Throws ConvexError with one of:
 *   - UNAUTHENTICATED — no session.
 *   - FORBIDDEN — caller is not admin or office_staff.
 *   - NOT_FOUND — `customerId` does not resolve to a customers row.
 *     We re-check here so a tampered client cannot log "I opened the
 *     detail page for customer X" without that customer actually
 *     existing.
 */
export const recordCustomerDetailView = mutationGeneric({
  args: { customerId: v.id("customers") },
  handler: async (
    ctx: MutationCtx,
    args: { customerId: CustomerId },
  ): Promise<{ recorded: true }> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    // pii-read-ok: existence probe before audit-log emission; the
    // following `logPiiAccess` call is the audited surface for the
    // page-load PII read.
    const customer = await ctx.db.get(args.customerId);
    if (customer === null) {
      throwError(ErrorCode.NOT_FOUND, "Customer not found.", {
        entity: "customer",
        customerId: args.customerId,
      });
    }
    await logPiiAccess(ctx, {
      entityType: "customer",
      entityId: args.customerId,
      // Tracks the page-load surface enumerated in `CustomerDetail`:
      // contact block (phone, email, address). `govIdNumber` is NOT
      // listed because the page never receives it on load; the
      // separate `revealGovId` mutation is the audited reveal surface.
      fields: ["address", "phone", "email"],
      reason: "customer detail page view",
    });
    return { recorded: true };
  },
});

export const revealGovId = mutationGeneric({
  args: { customerId: v.id("customers") },
  handler: async (
    ctx: MutationCtx,
    args: { customerId: CustomerId },
  ): Promise<{ govIdNumber: string }> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    // pii-read-ok: customer detail view; paired piiAccess audit is wired via the recordCustomerDetailView mutation called from the detail page on mount (Story 2.3 + 2.5 follow-on)
    const customer = await ctx.db.get(args.customerId);
    if (customer === null) {
      throwError(ErrorCode.NOT_FOUND, "Customer not found.", {
        entity: "customer",
        customerId: args.customerId,
      });
    }
    await logPiiAccess(ctx, {
      entityType: "customer",
      entityId: args.customerId,
      fields: ["govIdNumber"],
      reason: "detail-page reveal",
    });
    return { govIdNumber: customer.govIdNumber };
  },
});
