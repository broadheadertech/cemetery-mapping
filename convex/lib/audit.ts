/**
 * Audit log cornerstone — Story 1.6.
 *
 * Updated 2026-05-22 per Epic 1/2 adversarial review — `email`,
 * `phone`, and nested-address sub-fields (`line1`, `line2`, `barangay`,
 * `cityMunicipality`, `province`, `postalCode`) are now redacted at
 * write time. Historical audit rows written BEFORE this change retain
 * plaintext contact + nested-address PII; a separate migration story
 * should handle backfill if compliance requires (tracked alongside ADR
 * 0004).
 *
 * Every financial-touching mutation in this codebase MUST call
 * `emitAudit(ctx, { ... })` instead of writing to the `auditLog` table
 * directly. Direct inserts are blocked at lint time by
 * `local-rules/no-audit-log-direct-write`; `patch` / `replace` / `delete`
 * against audit rows is blocked by `local-rules/no-audit-log-mutation`.
 * Together, the helper + the two rules give us code-enforced
 * append-only semantics — Convex has no DB-level append-only
 * constraint (architecture § Authentication & Security row).
 *
 * Why redact at WRITE time (not read time):
 *   The audit log is read by admins for legitimate investigations; if
 *   we redacted at read time we'd risk re-exposing raw PII through any
 *   future code path that bypasses the read helper. Redacting at write
 *   means the at-rest data is already safe — defense in depth.
 *
 * Why `entityId: string` and not `v.id(...)`:
 *   The audit log is polymorphic across tables (lot, customer,
 *   contract, ...). Convex's `v.id(table)` accepts ONE table; we use
 *   `entityType` as the discriminator and store the id as an opaque
 *   string. Document refs are still queryable via the `by_entity`
 *   index (`entityType`, `entityId`, `timestamp`).
 *
 * See `docs/adr/0004-audit-log-pattern.md` for the full decision
 * record.
 */

import {
  type DataModelFromSchemaDefinition,
  type GenericActionCtx,
  type GenericMutationCtx,
  internalMutationGeneric,
  makeFunctionReference,
} from "convex/server";
import { v } from "convex/values";
import type { GenericId } from "convex/values";

import schema from "../schema";
import { getCurrentUserAndRoles } from "./auth";
import { ErrorCode, throwError } from "./errors";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;

/**
 * Local Ctx aliases mirroring `convex/lib/auth.ts`'s approach — driven
 * off the schema so this file is independent of `convex/_generated/`
 * (which only exists after the user runs `npx convex dev` interactively).
 */
export type MutationCtx = GenericMutationCtx<DataModel>;
export type ActionCtx = GenericActionCtx<DataModel>;

/** Convex `Id<"auditLog">` exposed as a branded string. */
export type AuditLogId = DataModel["auditLog"]["document"]["_id"];

/**
 * Controlled vocabulary of audit actions. Adding a new action requires
 * an ADR amendment — the enum is the contract between the audit log
 * and every consumer (search, reporting, compliance export).
 *
 * Reserved for future stories:
 *   - "create" / "update" / "delete" — universal CRUD (Stories 1.3,
 *     1.8, 2.1, ...).
 *   - "transition" — state-machine transitions (Story 1.7, 3.6).
 *   - "void" — receipt / contract voids (Story 3.7, 3.12).
 *   - "deactivate" / "reactivate" — user lifecycle (Story 1.3).
 *   - "transfer" — ownership transfer (Story 2.7).
 *   - "read_pii" — PII reads logged separately by `convex/lib/pii.ts`
 *     (Story 2.3); included here because `emitAudit` is sometimes the
 *     transport from `piiAccessLog`-style helpers.
 */
export type AuditAction =
  | "create"
  | "update"
  | "delete"
  | "transition"
  | "void"
  | "deactivate"
  | "reactivate"
  | "transfer"
  | "read_pii";

/**
 * Runtime-validated list mirroring `AuditAction`. The Convex schema
 * stores `action` as `v.string()` (not `v.union(v.literal(...))`) so
 * that adding a new action doesn't require a schema migration — but
 * the runtime check inside `emitAudit` enforces the enum at write time.
 */
export const AUDIT_ACTIONS: ReadonlyArray<AuditAction> = [
  "create",
  "update",
  "delete",
  "transition",
  "void",
  "deactivate",
  "reactivate",
  "transfer",
  "read_pii",
];

/**
 * Mirror of the `entityType` validator in `convex/schema.ts`. Kept in
 * sync by hand — adding a new entity type requires updating BOTH the
 * schema validator and this type alias.
 */
export type AuditEntityType =
  | "lot"
  | "customer"
  | "contract"
  | "payment"
  | "receipt"
  | "user"
  | "expense"
  | "ownership"
  | "piiAccess"
  | "section"
  | "family_estate"
  | "ceremony"
  | "plaque_draft";

/**
 * PII field names that `redactPii` recognizes. Extend the set as new
 * customer / contract fields land in later stories.
 *
 * `PII_ID_FIELDS` — government identifier values; redacted via
 * `redactIdValue` (preserves last-4 alphanumerics).
 *
 * `PII_ADDRESS_FIELDS` — keys whose STRING value is a free-form
 * single-line address; redacted via `redactAddressValue` (first-letter
 * preserved per whitespace-delimited token).
 *
 * `PII_CONTACT_FIELDS` — `email` and `phone`. Email values are reduced
 * to domain-only form ("…@example.com"); any other string contact
 * (e.g. `phone: "+639170000001"`) is reduced to first-3-chars +
 * ellipsis ("+63…"). Both forms preserve enough shape for an admin to
 * recognize the record without re-exposing the full value.
 *
 * `PII_ADDRESS_SUBFIELDS` — keys that appear INSIDE the nested
 * `address` object validator in `convex/schema.ts` (§ customers). The
 * recursion treats `address` as a regular object (so it descends in)
 * and these sub-field keys trigger the same first-3-chars + ellipsis
 * redaction as contact fields (or the `[REDACTED]` sentinel for
 * non-string values like the optional `postalCode` numeric edge case).
 */
const PII_ID_FIELDS = new Set([
  "govIdNumber",
  "idNumber",
  "nationalId",
]);
const PII_ADDRESS_FIELDS = new Set(["address"]);
const PII_CONTACT_FIELDS = new Set(["email", "phone"]);
const PII_ADDRESS_SUBFIELDS = new Set([
  "line1",
  "line2",
  "barangay",
  "cityMunicipality",
  "province",
  "postalCode",
]);

/**
 * Depth cap on recursive redaction. Convex's document serializer
 * already rejects cyclic structures, but a malicious / buggy caller
 * could nest deeply; the cap is a belt-and-suspenders bound on work.
 */
const REDACTION_MAX_DEPTH = 5;

function redactIdValue(raw: string): string {
  // ID redaction strips hyphens / spaces before taking the last 4
  // alphanumerics, so "123-456-789-012" → "***-***-9012" (the
  // canonical example from the Story 1.6 spec) rather than
  // "***-***--012" (which would leak the formatting hyphen).
  const compact = raw.replace(/[^a-zA-Z0-9]/g, "");
  if (compact.length < 4) return "***";
  return `***-***-${compact.slice(-4)}`;
}

function redactContactValue(key: string, raw: string): string {
  // Email: keep the domain so admins can recognize "yes, this is the
  // gmail account on file" without exposing the local-part. Anything
  // that doesn't contain "@" falls back to the generic first-3-chars
  // form (phones, malformed emails, etc.).
  if (key === "email") {
    const atIdx = raw.indexOf("@");
    if (atIdx > 0) {
      return `…${raw.slice(atIdx)}`;
    }
  }
  // Generic contact (phone, or email without "@"): first-3-chars +
  // ellipsis. Keeps country-code / area-code shape ("+63…", "091…")
  // for human recognition.
  if (raw.length <= 3) return "…";
  return `${raw.slice(0, 3)}…`;
}

function redactAddressSubfieldValue(raw: string): string {
  // Nested address sub-fields (line1, barangay, ...) — reuse the
  // first-3-chars + ellipsis shape used for contact values. Short
  // tokens (province codes, postal codes ≤ 3 chars) collapse to "…"
  // to avoid leaking the entire short value.
  if (raw.length <= 3) return "…";
  return `${raw.slice(0, 3)}…`;
}

function redactAddressValue(raw: string): string {
  // "123 Main St, Manila" → "1. M. S., M." — preserves enough shape
  // for the admin to recognize "yes this is the address that was on
  // file" without exposing the full text. Trailing punctuation on
  // each whitespace-delimited token (e.g. "St," → "S.,") is kept so
  // the audit reader sees the original commas / dashes that
  // delimited address segments.
  const tokens = raw.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens
    .map((token) => {
      // Find the first alphanumeric character (skipping any leading
      // punctuation like "(123)"), then preserve all trailing
      // non-alphanumeric characters as the segment separator. Pure
      // punctuation tokens fall back to "."
      const firstAlnumIdx = token.search(/[a-zA-Z0-9]/);
      if (firstAlnumIdx < 0) return ".";
      const firstAlnum = token[firstAlnumIdx];
      const trailingMatch = token.match(/[^a-zA-Z0-9]*$/);
      const trailing = trailingMatch !== null ? trailingMatch[0] : "";
      return `${firstAlnum}.${trailing}`;
    })
    .join(" ");
}

/**
 * Deep clone + redact PII fields. Pure function, no side effects on
 * the input. Exported for reuse by Story 2.3's PII access log helper.
 *
 * Recognized PII keys:
 *   - `PII_ID_FIELDS` (`govIdNumber`, `idNumber`, `nationalId`) — last-4
 *     form (`"***-***-9012"`).
 *   - `PII_ADDRESS_FIELDS` (`address`) — applied when the value is a
 *     STRING (free-form single-line address). Returns first-letter form
 *     (`"1. M. S., M."`).
 *   - `PII_CONTACT_FIELDS` (`email`, `phone`) — emails reduce to
 *     `"…@example.com"`; other contact strings reduce to first-3-chars
 *     + ellipsis (`"+63…"`).
 *   - `PII_ADDRESS_SUBFIELDS` (`line1`, `line2`, `barangay`,
 *     `cityMunicipality`, `province`, `postalCode`) — first-3-chars +
 *     ellipsis. The recursion still descends into the `address` object
 *     so these sub-fields are caught one level down.
 *
 * Behavior:
 *   - Primitive top-level values pass through unchanged (a bare
 *     `"foo"` is not PII; only PII *fields* are redacted).
 *   - Plain objects: each known PII field is replaced with its
 *     redacted form; unknown fields recurse.
 *   - Arrays: each element recurses.
 *   - `null` / `undefined`: pass through.
 *   - Depth cap at `REDACTION_MAX_DEPTH`: deeper levels are replaced
 *     by the literal string `"[depth-capped]"`.
 *   - `Date`, `Map`, `Set` instances are NOT recursed into (otherwise
 *     `Object.entries()` would return `[]` and the value would
 *     silently become `{}`). `Date` is coerced to its ISO string;
 *     `Map` / `Set` are coerced to the literal sentinel
 *     `"[non-plain-object]"`. Audit payloads should be JSON-shaped
 *     (Convex values) — these branches are defense in depth for
 *     accidental non-plain inputs.
 */
export function redactPii(value: unknown): unknown {
  return redactWithDepth(value, 0);
}

function redactWithDepth(value: unknown, depth: number): unknown {
  if (depth > REDACTION_MAX_DEPTH) return "[depth-capped]";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactWithDepth(item, depth + 1));
  }
  if (typeof value === "object") {
    // Defensive: Date / Map / Set are objects whose `Object.entries`
    // returns `[]` (or, for Date, the underlying numeric timestamp
    // surfaces nothing useful). Recursing would silently produce `{}`
    // and erase the original value from the audit row. Convex docs are
    // JSON-shaped so these shouldn't appear in practice; we coerce
    // them to something readable rather than recurse.
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (value instanceof Map || value instanceof Set) {
      return "[non-plain-object]";
    }
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (PII_ID_FIELDS.has(key) && typeof val === "string") {
        out[key] = redactIdValue(val);
      } else if (PII_ADDRESS_FIELDS.has(key) && typeof val === "string") {
        out[key] = redactAddressValue(val);
      } else if (PII_CONTACT_FIELDS.has(key) && typeof val === "string") {
        out[key] = redactContactValue(key, val);
      } else if (PII_ADDRESS_SUBFIELDS.has(key) && typeof val === "string") {
        out[key] = redactAddressSubfieldValue(val);
      } else {
        out[key] = redactWithDepth(val, depth + 1);
      }
    }
    return out;
  }
  // Primitives at any level: string / number / boolean / bigint / symbol.
  return value;
}

/**
 * Parameters accepted by `emitAudit`. Both `before` and `after` are
 * optional — `create` has no `before`, `delete` has no `after`.
 *
 * `actorOverride` is REQUIRED when calling from an `ActionCtx` (actions
 * have no auth context — Convex Auth resolves the caller at the
 * mutation/query boundary, not inside the V8-runtime action). The
 * caller passes the userId they verified at the entry-point mutation
 * that scheduled the action; the internal-mutation transport in turn
 * stores that id as the audit row's `actor`.
 *
 * From a `MutationCtx`, `actorOverride` is normally ignored — the
 * authenticated caller's userId is always preferred (defense in depth
 * against client-callable mutations forging an actor). The one
 * exception is internal mutations invoked by an operator via
 * `npx convex run`: those have NO auth context to read from, so
 * `actorOverride` falls back to the explicit value when
 * `getCurrentUserAndRoles` returns `null`. This branch is ONLY safe
 * because internal mutations are unreachable from client code — the
 * operator running the CLI is the trusted source of the actor userId.
 * Story 1.15 H5 uses this for the section-backfill audit row.
 *
 * NEVER accept `actorOverride` from a client-callable mutation. The
 * audit row's actor attribution is only as good as the caller's
 * discipline in passing a verified userId.
 */
export interface EmitAuditParams {
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  /**
   * Required when called from an `ActionCtx`.
   *
   * From a `MutationCtx`: ignored when an authenticated caller exists;
   * used as the actor fallback when no auth context is present (i.e.
   * an internal mutation invoked via `npx convex run` by an operator).
   * Never accept this value from a client-callable mutation — the
   * actor field MUST attribute to the authenticated caller for every
   * non-CLI write path.
   */
  actorOverride?: GenericId<"users">;
}

function isMutationCtx(
  ctx: MutationCtx | ActionCtx,
): ctx is MutationCtx {
  // `ActionCtx` has `runMutation` / `runQuery` but no `db`; `MutationCtx`
  // has `db`. This branch is the runtime-safe way to choose between
  // "insert directly" vs "call internal mutation".
  return "db" in ctx;
}

/**
 * Append a row to `auditLog`. The cornerstone helper — every
 * financial-touching mutation MUST call this (lint rule
 * `no-audit-log-direct-write` blocks the bypass).
 *
 * Contract:
 *   1. Caller MUST be authenticated OR pass `actorOverride` —
 *      `emitAudit` throws `UNAUTHENTICATED` otherwise. (Audit emission
 *      with neither would leave the `actor` field unset, defeating the
 *      purpose.) The override path is reserved for internal mutations
 *      invoked via `npx convex run` — see `EmitAuditParams.actorOverride`
 *      JSDoc; never accept it from a client-callable mutation.
 *   2. `action` MUST be a member of `AUDIT_ACTIONS` — throws
 *      `INVARIANT_VIOLATION` otherwise. The Convex schema's
 *      `action: v.string()` does NOT enforce the enum; this runtime
 *      check is the enforcement point. The schema-level enum is on
 *      `entityType` (the Convex validator rejects unknown values
 *      directly).
 *   3. `before` and `after` are redacted via `redactPii` before
 *      insert — callers don't need to redact themselves and SHOULDN'T
 *      try (defense in depth).
 *   4. The timestamp is set inside this helper via `Date.now()`;
 *      callers cannot override it.
 *
 * Action-context callers: when called from an `ActionCtx` (Convex
 * actions can't `ctx.db.insert` directly), `emitAudit` delegates to
 * an internal mutation. The internal-mutation transport is a Story
 * 1.6 follow-up gated on `convex/_generated/` existing; today the
 * helper throws `INVARIANT_VIOLATION` to make the wiring gap
 * explicit rather than silently dropping audit events.
 *
 * Note on QueryCtx: not in the signature deliberately — queries are
 * read-only and writing audit logs from a query is a category error.
 * TypeScript enforces this at the call site.
 */
export async function emitAudit(
  ctx: MutationCtx | ActionCtx,
  params: EmitAuditParams,
): Promise<AuditLogId> {
  if (isMutationCtx(ctx)) {
    return await emitAuditFromMutation(ctx, params);
  }
  return await emitAuditFromAction(ctx, params);
}

async function emitAuditFromMutation(
  ctx: MutationCtx,
  params: EmitAuditParams,
): Promise<AuditLogId> {
  const payload = await getCurrentUserAndRoles(ctx);
  // Resolve the actor. Authenticated callers are always preferred —
  // `actorOverride` is only consulted when no auth context is present
  // (the `npx convex run` operator-CLI path used by one-shot internal
  // migrations; see `EmitAuditParams.actorOverride` JSDoc + the
  // Story 1.15 H5 backfill).
  let actor: GenericId<"users">;
  if (payload !== null) {
    actor = payload.userId;
  } else if (params.actorOverride !== undefined) {
    actor = params.actorOverride;
  } else {
    throwError(
      ErrorCode.UNAUTHENTICATED,
      "Cannot emit audit log from an unauthenticated context.",
    );
  }
  if (!isKnownAction(params.action)) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      "Unknown audit action.",
      { action: params.action },
    );
  }
  // `Record<string, unknown>` is what Convex's `v.any()` resolves to
  // at the type layer; constructing the insert payload as such keeps
  // TypeScript happy without weakening to `any`.
  const row: {
    actor: DataModel["users"]["document"]["_id"];
    timestamp: number;
    action: string;
    entityType: AuditEntityType;
    entityId: string;
    before?: unknown;
    after?: unknown;
    reason?: string;
  } = {
    actor,
    timestamp: Date.now(),
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
  };
  if (params.before !== undefined) {
    row.before = redactPii(params.before);
  }
  if (params.after !== undefined) {
    row.after = redactPii(params.after);
  }
  if (params.reason !== undefined) {
    row.reason = params.reason;
  }
  return await ctx.db.insert("auditLog", row);
}

/**
 * Function reference to the `internal_recordActionAudit` mutation
 * below. We use `makeFunctionReference` (rather than
 * `internal.lib.audit.internal_recordActionAudit`) because the
 * `convex/_generated/` directory only exists after the developer runs
 * `npx convex dev` interactively — depending on it would break the
 * unit-test runtime. The string path mirrors the file location
 * (`convex/lib/audit.ts` → `lib/audit`) and the exported symbol name.
 */
const recordActionAuditRef = makeFunctionReference<
  "mutation",
  {
    actor: GenericId<"users">;
    action: string;
    entityType: AuditEntityType;
    entityId: string;
    before?: unknown;
    after?: unknown;
    reason?: string;
  },
  AuditLogId
>("lib/audit:internal_recordActionAudit");

/**
 * Action-context transport for `emitAudit`. Actions have no `ctx.db`
 * and no auth context, so the helper:
 *
 *   1. Validates the audit action enum (same gate as the mutation path).
 *   2. Requires `actorOverride` — the caller must explicitly pass the
 *      userId they verified at the entry-point mutation that scheduled
 *      the action. Refusing to default this prevents accidentally
 *      writing an audit row with no actor attribution.
 *   3. Delegates the actual `auditLog` insert to the
 *      `internal_recordActionAudit` internal mutation registered below,
 *      which runs in a real `MutationCtx` and so can `ctx.db.insert`.
 *
 * The internal mutation re-runs the action enum check, runs the
 * `redactPii` pipeline, and stamps `timestamp` server-side. The action
 * cannot override the timestamp or skip redaction.
 */
async function emitAuditFromAction(
  ctx: ActionCtx,
  params: EmitAuditParams,
): Promise<AuditLogId> {
  if (!isKnownAction(params.action)) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      "Unknown audit action.",
      { action: params.action },
    );
  }
  if (params.actorOverride === undefined) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      "emitAudit from an ActionCtx requires `actorOverride` — actions have no auth context. Pass the userId you verified at the entry-point mutation.",
    );
  }
  const payload: {
    actor: GenericId<"users">;
    action: string;
    entityType: AuditEntityType;
    entityId: string;
    before?: unknown;
    after?: unknown;
    reason?: string;
  } = {
    actor: params.actorOverride,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
  };
  if (params.before !== undefined) payload.before = params.before;
  if (params.after !== undefined) payload.after = params.after;
  if (params.reason !== undefined) payload.reason = params.reason;
  return await ctx.runMutation(recordActionAuditRef, payload);
}

/**
 * Internal mutation that backs the action-context transport.
 *
 * NOT exposed to the public API. The only caller is
 * `emitAuditFromAction` above (via the `makeFunctionReference` ref);
 * the only callers OF that helper are Convex actions that previously
 * received a verified `actor` userId from their entry-point mutation.
 *
 * The mutation re-runs the same gates as `emitAuditFromMutation`:
 *   - `action` is validated against `AUDIT_ACTIONS` (defense in depth —
 *     `emitAuditFromAction` already checks but a third-party caller
 *     could in principle ref this directly).
 *   - `before` / `after` are redacted via `redactPii`.
 *   - `timestamp` is set inside this mutation via `Date.now()`; the
 *     caller cannot override it.
 *
 * `actor` is taken from the args (not from `getCurrentUserAndRoles`)
 * because internal mutations called from an action have NO auth
 * context to read from. The audit row's attribution is only as good
 * as the caller's discipline in passing the verified userId.
 */
export const internal_recordActionAudit = internalMutationGeneric({
  args: {
    actor: v.id("users"),
    action: v.string(),
    entityType: v.union(
      v.literal("lot"),
      v.literal("customer"),
      v.literal("contract"),
      v.literal("payment"),
      v.literal("receipt"),
      v.literal("user"),
      v.literal("expense"),
      v.literal("ownership"),
      v.literal("piiAccess"),
      v.literal("section"),
      v.literal("family_estate"),
      v.literal("ceremony"),
      v.literal("plaque_draft"),
    ),
    entityId: v.string(),
    before: v.optional(v.any()),
    after: v.optional(v.any()),
    reason: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      actor: GenericId<"users">;
      action: string;
      entityType: AuditEntityType;
      entityId: string;
      before?: unknown;
      after?: unknown;
      reason?: string;
    },
  ): Promise<AuditLogId> => {
    if (!isKnownAction(args.action)) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Unknown audit action.",
        { action: args.action },
      );
    }
    const row: {
      actor: GenericId<"users">;
      timestamp: number;
      action: string;
      entityType: AuditEntityType;
      entityId: string;
      before?: unknown;
      after?: unknown;
      reason?: string;
    } = {
      actor: args.actor,
      timestamp: Date.now(),
      action: args.action,
      entityType: args.entityType,
      entityId: args.entityId,
    };
    if (args.before !== undefined) row.before = redactPii(args.before);
    if (args.after !== undefined) row.after = redactPii(args.after);
    if (args.reason !== undefined) row.reason = args.reason;
    return await ctx.db.insert("auditLog", row);
  },
});

function isKnownAction(action: string): action is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(action);
}
