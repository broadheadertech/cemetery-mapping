/**
 * Portal invitations — Story 9.1 (FR5) Epic-9 adversarial-review fix.
 *
 * Two surfaces:
 *
 *   - `createPortalInvite` (admin / office_staff mutation) — mints a
 *     time-limited single-use token for a specific `customers` row,
 *     emits an `auditLog` row, and returns the token to the operator
 *     so they can paste the resulting URL into an SMS / email.
 *
 *   - `acceptPortalInvite` (PUBLIC mutation — NO `requireRole` — see
 *     the public-mutation rationale below) — validates the token, calls
 *     Convex Auth's password provider to create the `users` +
 *     `authAccounts` rows for the customer's email, grants the
 *     `customer` role, marks the invite consumed, and emits an audit
 *     trail.
 *
 *   - `listActiveInvitesForCustomer` (admin / office_staff query) — the
 *     admin UI uses this to surface "an invite is already pending; do
 *     you want to resend?" instead of issuing duplicate tokens.
 *
 * The single-use + expiry guards are the security boundary — Convex
 * has no UNIQUE constraint, so we enforce single-use via the `usedAt`
 * column at write time. A second `acceptPortalInvite` call against a
 * consumed token returns the same `INVALID_INVITE` error as expired /
 * unknown tokens (existence-enumeration defence per Story 9.1 ADR).
 *
 * Why a public mutation for `acceptPortalInvite`: the calling client
 * is not yet authenticated (the invite IS the authentication anchor).
 * The ESLint rule `local-rules/require-role-first-line` is suppressed
 * for the handler with an explicit exemption comment so the rule's
 * default invariant (every Convex function gates first) is honoured
 * with a documented escape hatch.
 *
 * Audit posture:
 *   - `createPortalInvite` emits an `update` audit row on the customer
 *     (action: "update", entityType: "customer") with the invite id in
 *     the `after` payload. The customer is the aggregate root; the
 *     invite is metadata about that aggregate.
 *   - `acceptPortalInvite` emits a `create` audit row on the user
 *     (action: "create", entityType: "user") capturing the customer-
 *     auth-link event. The token itself is NEVER logged — it is
 *     credential material; an audit row carrying the token would defeat
 *     the single-use property if the audit log leaks.
 */

import {
  type DataModelFromSchemaDefinition,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";
import { Scrypt } from "lucia";

import schema from "./schema";
import {
  requireRole,
  type MutationCtx,
  type QueryCtx,
} from "./lib/auth";
import { emitAudit } from "./lib/audit";
import { ErrorCode, throwError } from "./lib/errors";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type CustomerDoc = DataModel["customers"]["document"];
type CustomerId = CustomerDoc["_id"];
type UserId = DataModel["users"]["document"]["_id"];
type InviteDoc = DataModel["portalInvites"]["document"];
type InviteId = InviteDoc["_id"];

/**
 * Phase 1 invite-validity window. Renewable by issuing a fresh invite
 * from the admin UI; the prior invite stays in the table (audit trail)
 * and is queryable but is rejected by `acceptPortalInvite` once
 * `expiresAt < now`.
 */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Minimum password length applied to the customer's chosen password on
 * `acceptPortalInvite`. Phase 1 floor — the staff `/login` signUp path
 * uses the same 8-char minimum (see `src/app/(public)/login/page.tsx`).
 */
const MIN_PASSWORD_LENGTH = 8;

export interface CreatePortalInviteArgs {
  customerId: CustomerId;
}

export interface CreatePortalInviteResult {
  inviteId: InviteId;
  inviteToken: string;
  expiresAt: number;
}

/**
 * Mints a single-use portal-invite token for the given customer.
 *
 * Authorization: admin / office_staff. Field workers and customer-role
 * callers receive FORBIDDEN.
 *
 * Validation:
 *   - The customer must exist (NOT_FOUND otherwise).
 *   - The customer's `email` field must be present (the accept-invite
 *     flow re-uses it as the auth identity). VALIDATION otherwise — the
 *     operator must add an email to the customer record before
 *     inviting them to the portal.
 *
 * Idempotency note: the mutation does NOT short-circuit on a pre-
 * existing unused invite — issuing two invites under different tokens
 * is allowed (e.g. operator re-sends because the customer lost the
 * first message). The admin UI surfaces "an invite is pending; resend?"
 * via `listActiveInvitesForCustomer` so the operator makes the choice
 * consciously.
 */
export const createPortalInvite = mutationGeneric({
  args: { customerId: v.id("customers") },
  handler: async (
    ctx: MutationCtx,
    args: CreatePortalInviteArgs,
  ): Promise<CreatePortalInviteResult> => {
    const auth = await requireRole(ctx, ["admin", "office_staff"]);
    // pii-read-ok: existence check + email validation only; full PII is
    // NOT projected onto the response payload (only the invite id /
    // token / expiry land in the result, and `customers.email` is
    // already known to the operator from the detail page they invoked
    // this mutation from).
    const customer = await ctx.db.get(args.customerId);
    if (customer === null) {
      throwError(ErrorCode.NOT_FOUND, "Customer not found.", {
        entity: "customer",
        customerId: args.customerId,
      });
    }
    if (customer.email === undefined || customer.email.trim().length === 0) {
      throwError(
        ErrorCode.VALIDATION,
        "Customer has no email on file. Add an email before issuing a portal invite.",
        { customerId: args.customerId },
      );
    }

    const now = Date.now();
    const inviteToken = crypto.randomUUID();
    const expiresAt = now + INVITE_TTL_MS;
    const inviteId = await ctx.db.insert("portalInvites", {
      customerId: args.customerId,
      inviteToken,
      createdAt: now,
      createdByUserId: auth.userId,
      expiresAt,
    });

    await emitAudit(ctx, {
      action: "update",
      entityType: "customer",
      entityId: args.customerId,
      after: {
        kind: "portal_invite_issued",
        inviteId,
        expiresAt,
        // Deliberately NOT logging the token — credential material.
      },
    });

    return { inviteId, inviteToken, expiresAt };
  },
});

export interface AcceptPortalInviteArgs {
  token: string;
  password: string;
}

export interface AcceptPortalInviteResult {
  userId: UserId;
  email: string;
}

/**
 * Public mutation — consumes a portal-invite token by creating the
 * customer's auth-account row + granting the `customer` role.
 *
 * Authorization: PUBLIC. The caller is NOT yet authenticated — the
 * invite token IS the authentication anchor. The handler runs entirely
 * inside one Convex transaction so a failure on any step (invalid
 * token, duplicate account, role-insert race) rolls back ALL writes;
 * the customer never lands in a half-onboarded state.
 *
 * Failure modes (all surface as `ErrorCode.VALIDATION` with a generic
 * `"Invalid or expired invitation."` message — existence-enumeration
 * defence; the caller MUST NOT learn whether the token was unknown,
 * expired, or already-consumed):
 *   - Unknown token.
 *   - `usedAt !== undefined` (already consumed).
 *   - `expiresAt < now` (TTL elapsed).
 *   - Customer row missing the linked email (administratively cleared).
 *   - Password too short (< 8 chars).
 *   - An auth-account already exists for the customer's email (a
 *     legitimate customer can sign in directly; the invite path
 *     refuses to silently overwrite).
 */
export const acceptPortalInvite = mutationGeneric({
  args: {
    token: v.string(),
    password: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    args: AcceptPortalInviteArgs,
  ): Promise<AcceptPortalInviteResult> => {
    // eslint-disable-next-line local-rules/require-role-first-line -- Public mutation: the invite token IS the authentication anchor. The caller is not yet authenticated; gating on `requireRole` would defeat the entire invite-acceptance flow. The mutation's body re-validates the token + expiry + single-use invariant as the security boundary.
    if (args.password.length < MIN_PASSWORD_LENGTH) {
      throwError(
        ErrorCode.VALIDATION,
        "Invalid or expired invitation.",
        { reason: "weak_password" },
      );
    }

    const invite = await ctx.db
      .query("portalInvites")
      .withIndex("by_token", (q) => q.eq("inviteToken", args.token))
      .unique();
    if (invite === null) {
      throwError(
        ErrorCode.VALIDATION,
        "Invalid or expired invitation.",
        { reason: "unknown_token" },
      );
    }
    if (invite.usedAt !== undefined) {
      throwError(
        ErrorCode.VALIDATION,
        "Invalid or expired invitation.",
        { reason: "already_used" },
      );
    }
    const now = Date.now();
    if (invite.expiresAt <= now) {
      throwError(
        ErrorCode.VALIDATION,
        "Invalid or expired invitation.",
        { reason: "expired" },
      );
    }

    // pii-read-ok: the invite is authenticated material; resolving the
    // linked customer is necessary to derive the auth email + emit the
    // audit row. No PII is returned to the caller.
    const customer = await ctx.db.get(invite.customerId);
    if (customer === null) {
      throwError(
        ErrorCode.VALIDATION,
        "Invalid or expired invitation.",
        { reason: "customer_missing" },
      );
    }
    const email = customer.email?.trim().toLowerCase() ?? "";
    if (email.length === 0) {
      throwError(
        ErrorCode.VALIDATION,
        "Invalid or expired invitation.",
        { reason: "customer_missing_email" },
      );
    }

    // Refuse to silently overwrite an existing auth account. A legit
    // customer can sign in directly via the existing credentials;
    // re-issuing access through the invite path would clobber their
    // password.
    const existingAuthAccounts = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) =>
        q.eq("provider", "password").eq("providerAccountId", email),
      )
      .collect();
    if (existingAuthAccounts.length > 0) {
      throwError(
        ErrorCode.VALIDATION,
        "Invalid or expired invitation.",
        { reason: "account_exists" },
      );
    }

    // Hash + write the user / authAccounts rows. Same path as
    // `convex/users.ts:createUser` minus the staff-role grant — we
    // grant `customer` instead.
    const secret = await new Scrypt().hash(args.password);
    const userId = await ctx.db.insert("users", {
      name: customer.fullName,
      email,
      isActive: true,
      createdAt: now,
      // No createdBy: the customer self-onboards via the invite.
    });
    await ctx.db.insert("authAccounts", {
      userId,
      provider: "password",
      providerAccountId: email,
      secret,
    });
    await ctx.db.insert("userRoles", {
      userId,
      role: "customer",
      grantedAt: now,
      grantedBy: userId,
    });

    // Consume the invite. Single-use is enforced by setting `usedAt`
    // here AND by the `usedAt !== undefined` reject above on any
    // future call. Convex transactions provide the atomicity.
    await ctx.db.patch(invite._id, {
      usedAt: now,
      usedByUserId: userId,
    });

    // Audit trail. The user-creation event is the audit-meaningful
    // surface — capturing both the new user id AND the invite id so
    // breach-response queries can trace "which auth users were
    // created via the invite flow" without re-joining tables.
    await emitAudit(ctx, {
      action: "create",
      entityType: "user",
      entityId: userId,
      after: {
        kind: "portal_invite_accepted",
        inviteId: invite._id,
        customerId: invite.customerId,
        roles: ["customer"],
        // Email is captured for ops visibility — it's the customer's
        // own email and `emitAudit`'s redactor handles the redaction
        // pass before insert.
        email,
      },
    });

    return { userId, email };
  },
});

export interface ActivePortalInviteRow {
  inviteId: InviteId;
  createdAt: number;
  expiresAt: number;
  isExpired: boolean;
}

/**
 * Admin-facing read: list the customer's outstanding (unused) invites.
 * The UI uses this to surface "an invite is pending; resend?" so the
 * operator does not issue duplicates by reflex.
 *
 * Authorization: admin / office_staff.
 */
export const listActiveInvitesForCustomer = queryGeneric({
  args: { customerId: v.id("customers") },
  handler: async (
    ctx: QueryCtx,
    args: { customerId: CustomerId },
  ): Promise<ActivePortalInviteRow[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const now = Date.now();
    const rows = await ctx.db
      .query("portalInvites")
      .withIndex("by_customer_active", (q) =>
        q.eq("customerId", args.customerId).eq("usedAt", undefined),
      )
      .collect();
    return rows.map((row) => ({
      inviteId: row._id,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      isExpired: row.expiresAt <= now,
    }));
  },
});
