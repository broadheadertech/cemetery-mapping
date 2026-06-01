/**
 * Lot condition logs (Story 1.14, FR13).
 *
 * Field-worker write surface. Free-text + optional photo observations
 * posted against a specific lot. This is the first field-worker write
 * capability in the system and a non-financial counterpart to Journey
 * 4's "Mr. Reyes sees a payment land" reactive primitive — Office
 * Staff's open lot detail page reactively shows new entries with a
 * 600ms amber flash via `ReactiveHighlight`.
 *
 * NOTE on file location: the Story 1.14 design originally placed these
 * handlers inside `convex/lots.ts`, but Story 1.9 (which lands
 * concurrently) is extending `convex/lots.ts` for geometry. To avoid a
 * three-way merge with Story 1.9, the condition-log handlers live in
 * this dedicated file. The data model still belongs to the `lots`
 * table (one-to-many) — `lotConditionLogs` references `lots._id`.
 *
 * Schema invariants enforced server-side (Story 1.14 § Dev Notes):
 *   1. `requireRole(ctx, [...])` as the first awaited statement of
 *      every public handler (NFR-S4, lint-enforced by
 *      `local-rules/require-role-first-line`).
 *   2. `note` is trimmed and must satisfy `1 ≤ length ≤ 2000`.
 *   3. The lot must exist and not be retired — retired lots are not a
 *      legal target for new operational writes.
 *   4. `loggedAt = Date.now()` is set server-side. Clients cannot
 *      override (a phone with a wrong clock would corrupt the
 *      timeline).
 *   5. `emitAudit` is called after every successful insert (Story 1.6
 *      cornerstone).
 *   6. Photos use Convex File Storage's two-step upload pattern; the
 *      mutation only stores the resulting `Id<"_storage">`. URLs are
 *      auth-gated through `getLotConditionLogPhotoUrl` (NFR-S3).
 *   7. Idempotency: clients pass a UUID stable across re-renders of
 *      the form mount; a second submit with the same key returns the
 *      original log id without inserting a duplicate (`by_idempotency`
 *      index lookup).
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

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type LotId = DataModel["lots"]["document"]["_id"];
type LotConditionLogDoc = DataModel["lotConditionLogs"]["document"];
type LotConditionLogId = LotConditionLogDoc["_id"];
type StorageId = NonNullable<LotConditionLogDoc["photoStorageId"]>;

/** Maximum note length, in characters. Per Story 1.14 § Task 1. */
export const CONDITION_NOTE_MAX_LENGTH = 2000;

/**
 * Generates a short-lived upload URL for a lot condition photo.
 *
 * Implemented as a MUTATION (not an action) because:
 *   1. `ctx.storage.generateUploadUrl()` is available on `MutationCtx`
 *      (Convex's `StorageWriter` interface).
 *   2. A mutation lets future stories call `emitAudit` from the same
 *      handler without paying the ActionCtx-internal-mutation tax
 *      (Story 1.6's open follow-up).
 *
 * The client uses this URL with a `POST` whose body is the file blob;
 * the response is `{ storageId: Id<"_storage"> }` which the client
 * then passes back to `logLotCondition`.
 */
export const generateLotConditionPhotoUploadUrl = mutationGeneric({
  args: {},
  handler: async (ctx: MutationCtx): Promise<string> => {
    await requireRole(ctx, ["admin", "office_staff", "field_worker"]);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Inserts a new lot-condition-log row. Server-side timestamp, audit
 * emission, idempotency check, and lot-retired guard all live here.
 *
 * Returns the log id (existing one on idempotent retry, new one
 * otherwise) so the client can subscribe to the photo-URL query
 * immediately if needed.
 */
export const logLotCondition = mutationGeneric({
  args: {
    lotId: v.id("lots"),
    note: v.string(),
    photoStorageId: v.optional(v.id("_storage")),
    idempotencyKey: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      lotId: LotId;
      note: string;
      photoStorageId?: StorageId;
      idempotencyKey: string;
    },
  ): Promise<LotConditionLogId> => {
    const auth = await requireRole(ctx, [
      "admin",
      "office_staff",
      "field_worker",
    ]);

    // Idempotency check FIRST — a retried submit (same form mount,
    // same uuid) must return the original id without a second insert.
    // We narrow further by `loggedBy` so two workers who pick
    // identical uuids (vanishingly unlikely with crypto.randomUUID,
    // but still) don't collide.
    if (args.idempotencyKey.length > 0) {
      const existing = await ctx.db
        .query("lotConditionLogs")
        .withIndex("by_idempotency", (q) =>
          q.eq("idempotencyKey", args.idempotencyKey),
        )
        .collect();
      const dup = existing.find((r) => r.loggedBy === auth.userId);
      if (dup !== undefined) {
        return dup._id;
      }
    }

    const trimmed = args.note.trim();
    if (trimmed.length === 0) {
      throwError(ErrorCode.VALIDATION, "Note is required.");
    }
    if (trimmed.length > CONDITION_NOTE_MAX_LENGTH) {
      throwError(
        ErrorCode.VALIDATION,
        `Note is too long (max ${CONDITION_NOTE_MAX_LENGTH} characters).`,
      );
    }

    const lot = await ctx.db.get(args.lotId);
    if (lot === null) {
      throwError(ErrorCode.NOT_FOUND, "Lot not found.", {
        lotId: args.lotId,
      });
    }
    if (lot.isRetired) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Cannot log a condition on a retired lot.",
        { lotId: args.lotId },
      );
    }

    const loggedAt = Date.now();
    const insertRow: {
      lotId: LotId;
      loggedBy: typeof auth.userId;
      loggedAt: number;
      note: string;
      photoStorageId?: StorageId;
      idempotencyKey?: string;
    } = {
      lotId: args.lotId,
      loggedBy: auth.userId,
      loggedAt,
      note: trimmed,
    };
    if (args.photoStorageId !== undefined) {
      insertRow.photoStorageId = args.photoStorageId;
    }
    if (args.idempotencyKey.length > 0) {
      insertRow.idempotencyKey = args.idempotencyKey;
    }
    const logId = await ctx.db.insert("lotConditionLogs", insertRow);

    // The audit captures the event but NOT the full note text — the
    // note lives on the log row itself; the audit summarises the
    // operational action. `hasPhoto` is kept as a tiny boolean so an
    // admin reviewing the audit feed can tell at a glance which
    // entries had a photo attached without loading the log row.
    await emitAudit(ctx, {
      action: "create",
      entityType: "lot",
      entityId: args.lotId,
      after: {
        logId,
        noteLength: trimmed.length,
        hasPhoto: args.photoStorageId !== undefined,
      },
    });

    return logId;
  },
});

/**
 * Listed condition log row — extends the raw doc with `loggedByName`
 * (best-effort: name → email → null) so the list view can render the
 * actor without doing N extra `db.get` calls in React.
 */
export interface ListedLotConditionLog extends LotConditionLogDoc {
  loggedByName: string | null;
}

/**
 * Lists the N most-recent condition logs for a lot. Reactive by
 * default (it's a `query`); Office Staff's open lot detail page
 * subscribes via `useQuery` and receives new entries from Junior's
 * mobile submit in real time.
 *
 * Each row is augmented with `loggedByName` — a one-off `db.get` per
 * row to resolve the user's display name. At the default limit (10)
 * the extra fetch is trivial; a larger view (Phase 2 "my recent
 * logs") would join differently.
 *
 * Customers (Phase 3 portal) are NOT allowed to read condition logs —
 * they're internal operational data and could reveal field-worker
 * routines or lot status drift.
 */
export const listLotConditionLogs = queryGeneric({
  args: {
    lotId: v.id("lots"),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx: QueryCtx,
    args: { lotId: LotId; limit?: number },
  ): Promise<ListedLotConditionLog[]> => {
    await requireRole(ctx, ["admin", "office_staff", "field_worker"]);
    const limit = args.limit ?? 10;
    const rows = await ctx.db
      .query("lotConditionLogs")
      .withIndex("by_lot_loggedAt", (q) => q.eq("lotId", args.lotId))
      .order("desc")
      .take(limit);
    const out: ListedLotConditionLog[] = [];
    for (const row of rows) {
      const user = await ctx.db.get(row.loggedBy);
      const userName =
        user !== null && typeof user === "object" && "name" in user
          ? ((user as { name?: string }).name ?? null)
          : null;
      const userEmail =
        user !== null && typeof user === "object" && "email" in user
          ? ((user as { email?: string }).email ?? null)
          : null;
      out.push({
        ...row,
        loggedByName: userName ?? userEmail ?? null,
      });
    }
    return out;
  },
});

/**
 * Returns an auth-gated, short-lived URL for fetching a condition
 * photo. NFR-S3: file URLs are NEVER public. The caller's role is
 * checked here on every read, so even a leaked log id can't be used
 * by a customer-role token to fetch the photo.
 */
export const getLotConditionLogPhotoUrl = queryGeneric({
  args: { logId: v.id("lotConditionLogs") },
  handler: async (
    ctx: QueryCtx,
    args: { logId: LotConditionLogId },
  ): Promise<string | null> => {
    await requireRole(ctx, ["admin", "office_staff", "field_worker"]);
    const log = await ctx.db.get(args.logId);
    if (log === null) {
      return null;
    }
    if (log.photoStorageId === undefined) {
      return null;
    }
    return await ctx.storage.getUrl(log.photoStorageId);
  },
});
