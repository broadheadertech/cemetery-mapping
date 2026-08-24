/**
 * Public enquiries — schedule-a-visit and pricing questions.
 *
 * The marketing forms used to call `setSent(true)` and discard
 * everything the visitor typed. The schedule-a-visit success state
 * promised a bereaved family "a care director will call within the
 * working day"; nobody was ever told to call. This module is the half
 * that was missing.
 *
 * Shape:
 *   - `submitEnquiry`  — PUBLIC, UNAUTHENTICATED. The only such write
 *     surface in the app besides the auth rate-limiter.
 *   - `listEnquiries` / `getEnquiryCounts` / `updateEnquiryStatus` —
 *     staff-facing (`admin`, `office_staff`), because answering these
 *     is office work, not administration.
 *
 * ## Why `submitEnquiry` is unauthenticated, and what bounds it
 *
 * A visitor planning a burial has no account and will not make one to
 * ask a question. `requireAuth` here would be a contradiction, the
 * same reasoning `convex/authRateLimit.ts` documents for the
 * pre-sign-in surface — and the `require-role-first-line` rule is
 * suppressed the same way, per call site, with the bound written down.
 *
 * The bound on damage:
 *
 *   1. **Rate limited two ways.** Per normalised contact
 *      (`PER_CONTACT_LIMIT` in `PER_CONTACT_WINDOW_MS`) so one person
 *      cannot spam the queue, and globally (`GLOBAL_LIMIT` in
 *      `GLOBAL_WINDOW_MS`) so a script cannot fill the table. The
 *      global cap is the load-bearing one; the per-contact cap only
 *      stops the honest-mistake double-submit and an unsophisticated
 *      flood, since the contact string is attacker-chosen.
 *
 *      Convex mutations do not see the client IP — that is only
 *      available in an `httpAction`. Per-IP throttling would mean
 *      moving this to an HTTP route and taking on CORS, which buys
 *      little while the global cap exists. Written down rather than
 *      pretended away.
 *
 *   2. **Every field is length-capped at write.** A public writer must
 *      never choose how much storage it consumes.
 *
 *   3. **It writes one row to one table** and touches nothing else.
 *      No customer, contract, lot, or financial row is created or
 *      modified. The worst outcome of abuse is a queue an admin has to
 *      clear, not corrupted business state.
 *
 *   4. **Nothing here is authoritative.** An enquiry is a stranger's
 *      claim about themselves. It becomes a `customers` row only when
 *      staff deliberately create one.
 *
 * ## Notification
 *
 * The submit schedules `actions/sendEnquiryNotification` rather than
 * emailing inline: the visitor's form must not hang on Resend, and a
 * provider outage must not lose the enquiry. The row is committed
 * first and is the source of truth — if the email never arrives the
 * enquiry is still in the queue at `/enquiries`, and the failed send
 * lands in the error log.
 */

import {
  type DataModelFromSchemaDefinition,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import { emitAudit } from "./lib/audit";
import { ErrorCode, throwError } from "./lib/errors";
import { MINUTE_MS } from "./lib/time";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type EnquiryDoc = DataModel["enquiries"]["document"];
type EnquiryId = EnquiryDoc["_id"];

export type EnquiryKind = "visit" | "pricing";
export type EnquiryStatus = "new" | "contacted" | "closed";

/** One person, honest double-submits aside, in a short window. */
export const PER_CONTACT_WINDOW_MS = 60 * MINUTE_MS;
export const PER_CONTACT_LIMIT = 3;

/**
 * Global flood ceiling. Deliberately generous — a real cemetery will
 * never approach it — and its job is to bound table growth under
 * abuse, not to police normal use.
 */
export const GLOBAL_WINDOW_MS = 60 * MINUTE_MS;
export const GLOBAL_LIMIT = 60;

/** Per-field write caps. */
const MAX_NAME = 120;
const MAX_CONTACT = 160;
const MAX_SHORT = 80;
const MAX_NOTES = 2_000;

const NOTIFY_ACTION_PATH = "actions/sendEnquiryNotification:default";

/**
 * Normalise a contact string into a rate-limit key. Lowercase, strip
 * everything that is not alphanumeric — so `+63 917 555 0000`,
 * `09175550000`, and `+639175550000` collapse together, and
 * `Juan@Example.PH` matches `juan@example.ph`.
 */
export function contactKeyOf(contact: string): string {
  return contact.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Trim and cap. Returns `""` for anything that is not a string. */
function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

/** Cleaned optional field — `undefined` when the visitor left it blank. */
function cleanOptional(value: unknown, max: number): string | undefined {
  const out = clean(value, max);
  return out.length > 0 ? out : undefined;
}

/* eslint-disable local-rules/require-role-first-line --
 * `submitEnquiry` below is UNAUTHENTICATED by design: it backs the
 * public marketing forms, whose whole purpose is to hear from people
 * who do not have accounts. `requireAuth` / `requireRole` would be a
 * structural contradiction, the same case `convex/authRateLimit.ts`
 * makes for the pre-sign-in surface. The bound on damage — two rate
 * limits, per-field length caps, one row in one table, nothing
 * authoritative — is documented in the file JSDoc above.
 */

/**
 * Record an enquiry from the public site and notify staff.
 *
 * Returns `{ enquiryId }`. Throws `VALIDATION` when the two required
 * fields are missing, and `RATE_LIMITED` when either window is full.
 * The client renders the retry message for the latter — see
 * `translateError`.
 */
export const submitEnquiry = mutationGeneric({
  args: {
    kind: v.union(v.literal("visit"), v.literal("pricing")),
    name: v.string(),
    contact: v.string(),
    preferredDate: v.optional(v.string()),
    preferredTime: v.optional(v.string()),
    purpose: v.optional(v.string()),
    lotTypeInterest: v.optional(v.string()),
    timing: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      kind: EnquiryKind;
      name: string;
      contact: string;
      preferredDate?: string;
      preferredTime?: string;
      purpose?: string;
      lotTypeInterest?: string;
      timing?: string;
      notes?: string;
    },
  ): Promise<{ enquiryId: EnquiryId }> => {
    const name = clean(args.name, MAX_NAME);
    const contact = clean(args.contact, MAX_CONTACT);

    if (name.length === 0) {
      throwError(ErrorCode.VALIDATION, "Please tell us your name.", {
        field: "name",
      });
    }
    if (contact.length === 0) {
      throwError(
        ErrorCode.VALIDATION,
        "Please leave a phone number or email so we can reach you.",
        { field: "contact" },
      );
    }

    const now = Date.now();
    const contactKey = contactKeyOf(contact);

    // Per-contact window. Indexed range read, not a scan.
    const recentFromContact = await ctx.db
      .query("enquiries")
      .withIndex("by_contactKey_createdAt", (q) =>
        q
          .eq("contactKey", contactKey)
          .gte("createdAt", now - PER_CONTACT_WINDOW_MS),
      )
      .collect();
    if (recentFromContact.length >= PER_CONTACT_LIMIT) {
      throwError(
        ErrorCode.RATE_LIMITED,
        "We already have your message and someone will be in touch. If it is urgent, please call us.",
        { scope: "contact" },
      );
    }

    // Global window. Read at most `GLOBAL_LIMIT` rows — once the cap is
    // reached the exact count past it does not matter, and scanning the
    // whole window is precisely what abuse would make expensive.
    //
    // `>=`, not `>`: the limit is how many may exist in the window, so
    // when that many already do, this one would be the excess. (`>` let
    // a 61st through on a limit of 60.)
    const recentGlobal = await ctx.db
      .query("enquiries")
      .withIndex("by_createdAt", (q) =>
        q.gte("createdAt", now - GLOBAL_WINDOW_MS),
      )
      .take(GLOBAL_LIMIT);
    if (recentGlobal.length >= GLOBAL_LIMIT) {
      throwError(
        ErrorCode.RATE_LIMITED,
        "We are receiving an unusual number of messages right now. Please call us instead.",
        { scope: "global" },
      );
    }

    const row: {
      kind: EnquiryKind;
      name: string;
      contact: string;
      contactKey: string;
      preferredDate?: string;
      preferredTime?: string;
      purpose?: string;
      lotTypeInterest?: string;
      timing?: string;
      notes?: string;
      status: EnquiryStatus;
      createdAt: number;
    } = {
      kind: args.kind,
      name,
      contact,
      contactKey,
      status: "new",
      createdAt: now,
    };
    const preferredDate = cleanOptional(args.preferredDate, MAX_SHORT);
    if (preferredDate !== undefined) row.preferredDate = preferredDate;
    const preferredTime = cleanOptional(args.preferredTime, MAX_SHORT);
    if (preferredTime !== undefined) row.preferredTime = preferredTime;
    const purpose = cleanOptional(args.purpose, MAX_SHORT);
    if (purpose !== undefined) row.purpose = purpose;
    const lotTypeInterest = cleanOptional(args.lotTypeInterest, MAX_SHORT);
    if (lotTypeInterest !== undefined) row.lotTypeInterest = lotTypeInterest;
    const timing = cleanOptional(args.timing, MAX_SHORT);
    if (timing !== undefined) row.timing = timing;
    const notes = cleanOptional(args.notes, MAX_NOTES);
    if (notes !== undefined) row.notes = notes;

    const enquiryId = await ctx.db.insert("enquiries", row);

    // Notify out of band. The row is already committed and is the
    // source of truth — a provider outage delays the email, it does
    // not lose the enquiry.
    await ctx.scheduler.runAfter(
      0,
      makeFunctionReference<"action", { enquiryId: EnquiryId }, null>(
        NOTIFY_ACTION_PATH,
      ),
      { enquiryId },
    );

    // No audit row on create. The audit log records what STAFF did;
    // an enquiry arriving is not an operator action, and the enquiry
    // row is itself the record. Staff status changes below do audit.
    return { enquiryId };
  },
});

/* eslint-enable local-rules/require-role-first-line */

export interface EnquiryView {
  id: EnquiryId;
  kind: EnquiryKind;
  name: string;
  contact: string;
  preferredDate: string | null;
  preferredTime: string | null;
  purpose: string | null;
  lotTypeInterest: string | null;
  timing: string | null;
  notes: string | null;
  status: EnquiryStatus;
  createdAt: number;
  handledAt: number | null;
  notifyFailed: boolean;
}

function toView(row: EnquiryDoc): EnquiryView {
  return {
    id: row._id,
    kind: row.kind,
    name: row.name,
    contact: row.contact,
    preferredDate: row.preferredDate ?? null,
    preferredTime: row.preferredTime ?? null,
    purpose: row.purpose ?? null,
    lotTypeInterest: row.lotTypeInterest ?? null,
    timing: row.timing ?? null,
    notes: row.notes ?? null,
    status: row.status,
    createdAt: row.createdAt,
    handledAt: row.handledAt ?? null,
    notifyFailed: row.notifyFailedAt !== undefined,
  };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Staff queue. Defaults to `new` — the question the page answers is
 * "who is waiting on a call from us".
 */
export const listEnquiries = queryGeneric({
  args: {
    status: v.optional(
      v.union(v.literal("new"), v.literal("contacted"), v.literal("closed")),
    ),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx: QueryCtx,
    args: { status?: EnquiryStatus; limit?: number },
  ): Promise<EnquiryView[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const limit = Math.min(
      Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT)),
      MAX_LIMIT,
    );
    const status = args.status;
    const rows =
      status === undefined
        ? await ctx.db
            .query("enquiries")
            .withIndex("by_createdAt")
            .order("desc")
            .take(limit)
        : await ctx.db
            .query("enquiries")
            .withIndex("by_status_createdAt", (q) => q.eq("status", status))
            .order("desc")
            .take(limit);
    return rows.map(toView);
  },
});

/** Counts for the queue's tabs and the staff-nav badge. */
export const getEnquiryCounts = queryGeneric({
  args: {},
  handler: async (
    ctx: QueryCtx,
  ): Promise<{ new: number; contacted: number }> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const fresh = await ctx.db
      .query("enquiries")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "new"))
      .take(MAX_LIMIT);
    const contacted = await ctx.db
      .query("enquiries")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "contacted"))
      .take(MAX_LIMIT);
    return { new: fresh.length, contacted: contacted.length };
  },
});

/**
 * Move an enquiry through `new` → `contacted` → `closed`.
 *
 * Audited, because "we called them back" is a claim someone may need
 * to check later. The audit payload carries the enquiry id and the
 * transition, NOT the name or contact — `emitAudit` redacts PII, and
 * copying it into a second table would defeat the point.
 *
 * Not a state machine, deliberately. `local-rules/no-raw-status-patch`
 * flags this patch, and the suppression below is the considered answer
 * rather than a convenience:
 *
 *   - ADR-0006's `TRANSITIONS` table governs entities whose moves are
 *     FR-mandated and carry legal or financial consequence — a lot
 *     becoming `sold`, a contract becoming `voided`. It asks for an ADR
 *     amendment to change. An enquiry's status is a workflow label on a
 *     stranger's message; no invariant depends on it and no money moves.
 *
 *   - Every transition here is legal, including backwards. A staff
 *     member who closed an enquiry and then hears back from the family
 *     should be able to reopen it. Encoding that as a machine would
 *     produce a table where every state points at every other state,
 *     which is a table that says nothing.
 *
 * The accountability the rule is really protecting comes from the audit
 * row below, which records who changed what and when.
 */
export const updateEnquiryStatus = mutationGeneric({
  args: {
    enquiryId: v.id("enquiries"),
    status: v.union(
      v.literal("new"),
      v.literal("contacted"),
      v.literal("closed"),
    ),
  },
  handler: async (
    ctx: MutationCtx,
    args: { enquiryId: EnquiryId; status: EnquiryStatus },
  ): Promise<{ status: EnquiryStatus }> => {
    const auth = await requireRole(ctx, ["admin", "office_staff"]);
    const existing = await ctx.db.get(args.enquiryId);
    if (existing === null) {
      throwError(ErrorCode.NOT_FOUND, "That enquiry no longer exists.");
    }

    /* eslint-disable local-rules/no-raw-status-patch --
     * Enquiry status is a workflow label, not a domain state machine.
     * See this function's JSDoc for why ADR-0006's transition table
     * does not apply; accountability comes from the audit row below.
     */
    await ctx.db.patch(args.enquiryId, {
      status: args.status,
      handledBy: auth.userId,
      handledAt: Date.now(),
    });
    /* eslint-enable local-rules/no-raw-status-patch */

    await emitAudit(ctx, {
      action: "update",
      entityType: "enquiry",
      entityId: args.enquiryId,
      before: { status: existing.status },
      after: { status: args.status },
    });

    return { status: args.status };
  },
});

// ---------------------------------------------------------------------------
// Internal surface for the notification action.
// ---------------------------------------------------------------------------

/**
 * Hydrate one enquiry for the notification email. Internal — the
 * action has no user context, and this returns the visitor's contact
 * details, which no public caller should be able to read by id.
 */
export const internal_getEnquiryForNotify = internalQueryGeneric({
  args: { enquiryId: v.id("enquiries") },
  handler: async (
    ctx: QueryCtx,
    args: { enquiryId: EnquiryId },
  ): Promise<EnquiryView | null> => {
    const row = await ctx.db.get(args.enquiryId);
    return row === null ? null : toView(row);
  },
});

/**
 * Flag an enquiry whose staff notification could not be sent.
 *
 * The row stays in the queue either way — the email is a convenience,
 * the queue is the system of record. The flag exists so the queue can
 * mark the row "nobody was emailed about this", which is the one thing
 * a staff member scanning the list would otherwise have no way to know.
 */
export const internal_markNotifyFailed = internalMutationGeneric({
  args: { enquiryId: v.id("enquiries") },
  handler: async (
    ctx: MutationCtx,
    args: { enquiryId: EnquiryId },
  ): Promise<null> => {
    const row = await ctx.db.get(args.enquiryId);
    if (row === null) return null;
    await ctx.db.patch(args.enquiryId, { notifyFailedAt: Date.now() });
    return null;
  },
});
