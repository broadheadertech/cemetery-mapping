/**
 * Occupants domain (Story 2.6, FR18).
 *
 * An occupant is a deceased person interred at a lot. Occupants are
 * intentionally distinct from `customers` (a person record / next-of-
 * kin) and from `ownerships` (a property right; Story 2.7). The
 * common cemetery case of "one owner, many interments in a family
 * lot" models cleanly with two separate tables — `customers` /
 * `ownerships` carry the legal-rights side; `occupants` carries the
 * factual "who is buried where" side. The deceased is not a Data
 * Privacy Act data subject, so there is no per-occupant customer
 * record.
 *
 * Conventions every handler obeys:
 *
 *   1. FIRST awaited statement is `await requireRole(ctx, [...])`. The
 *      ESLint rule `local-rules/require-role-first-line` enforces this.
 *   2. Mutations call `emitAudit` — direct `auditLog` inserts are
 *      banned by `local-rules/no-audit-log-direct-write`. The
 *      `entityId` we pass is the LOT id, NOT the occupant id, because
 *      the lot is the canonical aggregate root for this sub-entity
 *      (matches the FR16 ownership-history audit pattern).
 *   3. Soft delete only — interment records persist for cemetery
 *      history retention. `removeOccupant` flips `isRemoved` rather
 *      than physically deleting the row.
 *   4. `listLotOccupants` admits `field_worker` callers (Phase 2's
 *      Story 8.3 GPS-navigation flow shows the occupant list on the
 *      mobile lot view). All other queries / mutations are
 *      `office_staff` / `admin` only; `removeOccupant` is `admin`
 *      only.
 *   5. `dateOfInterment` is OPTIONAL end-to-end. §10 Q4 legacy
 *      records frequently lack a precise date ("buried 1987"); the
 *      list pins undated rows to the tail of the chronological sort
 *      so ordering stays deterministic.
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
import { DAY_MS } from "./lib/time";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type LotId = DataModel["lots"]["document"]["_id"];
type OccupantDoc = DataModel["occupants"]["document"];
type OccupantId = OccupantDoc["_id"];

/** Field-length caps mirrored on the client Zod schema. */
export const OCCUPANT_NAME_MIN_LENGTH = 2;
export const OCCUPANT_NAME_MAX_LENGTH = 200;
export const OCCUPANT_RELATIONSHIP_MAX_LENGTH = 100;
export const OCCUPANT_NOTES_MAX_LENGTH = 1000;
export const OCCUPANT_REMOVAL_REASON_MIN_LENGTH = 3;
export const OCCUPANT_REMOVAL_REASON_MAX_LENGTH = 500;

/**
 * Shape returned to the client by `listLotOccupants`. Deliberately
 * trimmed (no raw `_id`, no `createdByUserId`) — minimise the
 * response surface so future PII-classification work (Story 2.3) has
 * a small auditable footprint.
 */
export interface ListedOccupant {
  occupantId: OccupantId;
  name: string;
  dateOfInterment: number | undefined;
  relationshipToOwner: string;
  notes: string | undefined;
  isRemoved: boolean;
  removedReason: string | undefined;
  createdAt: number;
}

/**
 * Reactive listing of occupants for a lot. Sorted by `dateOfInterment`
 * ascending with `undefined` dates pinned to the tail (legacy-data
 * friendly). Excludes removed occupants unless `includeRemoved` is
 * `true`.
 *
 * Role gate: `office_staff`, `admin`, `field_worker`. Field workers
 * see the list (Story 8.3's burial-navigation flow) but cannot add or
 * remove rows — those mutations gate `office_staff` / `admin` only.
 */
export const listLotOccupants = queryGeneric({
  args: {
    lotId: v.id("lots"),
    includeRemoved: v.optional(v.boolean()),
  },
  handler: async (
    ctx: QueryCtx,
    args: { lotId: LotId; includeRemoved?: boolean },
  ): Promise<ListedOccupant[]> => {
    await requireRole(ctx, ["admin", "office_staff", "field_worker"]);
    const includeRemoved = args.includeRemoved === true;
    const rows = await ctx.db
      .query("occupants")
      .withIndex("by_lot_interment_date", (q) => q.eq("lotId", args.lotId))
      .collect();
    const visible = includeRemoved
      ? rows
      : rows.filter((r) => r.isRemoved !== true);
    // Sort ascending by interment date; undated rows tail-sorted by
    // `createdAt` for deterministic ordering on legacy imports that
    // share `dateOfInterment: undefined`.
    const sorted = [...visible].sort((a, b) => {
      const ad = a.dateOfInterment;
      const bd = b.dateOfInterment;
      if (ad === undefined && bd === undefined) {
        return a.createdAt - b.createdAt;
      }
      if (ad === undefined) return 1;
      if (bd === undefined) return -1;
      return ad - bd;
    });
    return sorted.map((r) => ({
      occupantId: r._id,
      name: r.name,
      dateOfInterment: r.dateOfInterment,
      relationshipToOwner: r.relationshipToOwner,
      notes: r.notes,
      isRemoved: r.isRemoved,
      removedReason: r.removedReason,
      createdAt: r.createdAt,
    }));
  },
});

/**
 * Adds an occupant to a lot. Validates server-side (defense in depth
 * — the client also Zod-validates), refuses retired lots, and emits
 * an audit row keyed on the LOT (not the occupant — the lot is the
 * aggregate root for the audit feed).
 */
export const addOccupant = mutationGeneric({
  args: {
    lotId: v.id("lots"),
    name: v.string(),
    dateOfInterment: v.optional(v.number()),
    relationshipToOwner: v.string(),
    notes: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      lotId: LotId;
      name: string;
      dateOfInterment?: number;
      relationshipToOwner: string;
      notes?: string;
    },
  ): Promise<{ occupantId: OccupantId }> => {
    const auth = await requireRole(ctx, ["admin", "office_staff"]);

    const trimmedName = args.name.trim();
    const trimmedRelationship = args.relationshipToOwner.trim();
    const trimmedNotes = args.notes !== undefined ? args.notes.trim() : undefined;

    if (
      trimmedName.length < OCCUPANT_NAME_MIN_LENGTH ||
      trimmedName.length > OCCUPANT_NAME_MAX_LENGTH
    ) {
      throwError(
        ErrorCode.VALIDATION,
        `Name must be between ${OCCUPANT_NAME_MIN_LENGTH} and ${OCCUPANT_NAME_MAX_LENGTH} characters.`,
      );
    }
    if (trimmedRelationship.length === 0) {
      throwError(
        ErrorCode.VALIDATION,
        "Relationship to owner is required.",
      );
    }
    if (trimmedRelationship.length > OCCUPANT_RELATIONSHIP_MAX_LENGTH) {
      throwError(
        ErrorCode.VALIDATION,
        `Relationship to owner must be ${OCCUPANT_RELATIONSHIP_MAX_LENGTH} characters or fewer.`,
      );
    }
    if (
      trimmedNotes !== undefined &&
      trimmedNotes.length > OCCUPANT_NOTES_MAX_LENGTH
    ) {
      throwError(
        ErrorCode.VALIDATION,
        `Notes must be ${OCCUPANT_NOTES_MAX_LENGTH} characters or fewer.`,
      );
    }
    if (args.dateOfInterment !== undefined) {
      if (
        !Number.isFinite(args.dateOfInterment) ||
        !Number.isInteger(args.dateOfInterment) ||
        args.dateOfInterment <= 0
      ) {
        throwError(
          ErrorCode.VALIDATION,
          "Date of interment must be a positive integer (unix ms).",
        );
      }
      // Manila tz tolerance — allow same-day recording with a slight
      // clock skew (one day). Interment cannot meaningfully be in the
      // future.
      if (args.dateOfInterment > Date.now() + DAY_MS) {
        throwError(
          ErrorCode.VALIDATION,
          "Date of interment cannot be in the future.",
        );
      }
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
        "Cannot add an occupant to a retired lot.",
        { lotId: args.lotId },
      );
    }

    const createdAt = Date.now();
    const insertRow: {
      lotId: LotId;
      name: string;
      dateOfInterment?: number;
      relationshipToOwner: string;
      notes?: string;
      createdAt: number;
      createdByUserId: typeof auth.userId;
      isRemoved: boolean;
    } = {
      lotId: args.lotId,
      name: trimmedName,
      relationshipToOwner: trimmedRelationship,
      createdAt,
      createdByUserId: auth.userId,
      isRemoved: false,
    };
    if (args.dateOfInterment !== undefined) {
      insertRow.dateOfInterment = args.dateOfInterment;
    }
    if (trimmedNotes !== undefined && trimmedNotes.length > 0) {
      insertRow.notes = trimmedNotes;
    }
    const occupantId = await ctx.db.insert("occupants", insertRow);

    // The audit row is keyed on the LOT, not the occupant — occupants
    // are sub-entities of a lot for audit purposes (matches the FR16
    // ownership-history audit pattern). The `entityType` enum on
    // `auditLog` does not contain "occupant" deliberately; the lot
    // groups all sub-events.
    await emitAudit(ctx, {
      action: "create",
      entityType: "lot",
      entityId: args.lotId,
      after: {
        occupantId,
        name: trimmedName,
        dateOfInterment: args.dateOfInterment,
        relationshipToOwner: trimmedRelationship,
      },
    });

    return { occupantId };
  },
});

/**
 * Soft-deletes an occupant by setting `isRemoved: true`. Admin-only;
 * `office_staff` create occupants but only admins remove them
 * (interment records affect family-history sensitivity, so the
 * removal affordance is gated tighter than the create affordance).
 *
 * Cemetery history retention requires that the row PERSIST — this is
 * not a physical delete. Audit-emitted with `entityType: "lot"`, same
 * aggregate-root convention as `addOccupant`.
 */
export const removeOccupant = mutationGeneric({
  args: {
    occupantId: v.id("occupants"),
    reason: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    args: { occupantId: OccupantId; reason: string },
  ): Promise<{ occupantId: OccupantId }> => {
    const auth = await requireRole(ctx, ["admin"]);

    const trimmedReason = args.reason.trim();
    if (
      trimmedReason.length < OCCUPANT_REMOVAL_REASON_MIN_LENGTH ||
      trimmedReason.length > OCCUPANT_REMOVAL_REASON_MAX_LENGTH
    ) {
      throwError(
        ErrorCode.VALIDATION,
        `Removal reason must be between ${OCCUPANT_REMOVAL_REASON_MIN_LENGTH} and ${OCCUPANT_REMOVAL_REASON_MAX_LENGTH} characters.`,
      );
    }

    const occupant = await ctx.db.get(args.occupantId);
    if (occupant === null) {
      throwError(ErrorCode.NOT_FOUND, "Occupant not found.", {
        occupantId: args.occupantId,
      });
    }
    if (occupant.isRemoved) {
      // Idempotent — already removed, no-op (but still return id).
      return { occupantId: args.occupantId };
    }

    await ctx.db.patch(args.occupantId, {
      isRemoved: true,
      removedAt: Date.now(),
      removedByUserId: auth.userId,
      removedReason: trimmedReason,
    });

    await emitAudit(ctx, {
      action: "delete",
      entityType: "lot",
      entityId: occupant.lotId,
      before: { occupantId: args.occupantId, isRemoved: false },
      after: { occupantId: args.occupantId, isRemoved: true },
      reason: trimmedReason,
    });

    return { occupantId: args.occupantId };
  },
});
