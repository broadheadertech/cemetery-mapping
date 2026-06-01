/**
 * Named-sections registry domain — Story 1.15 (FR3 brand-tier extension).
 *
 * Public CRUD surface for the `sections` table introduced in this
 * story. Replaces the free-text `lots.section` string field (Story
 * 1.8) with a structured registry of wayfinding-grade names so the
 * system reflects the brand guide's Chapter VII signage categories.
 *
 * Conventions every handler obeys:
 *
 *   1. FIRST awaited statement is `await requireRole(ctx, [...])`. The
 *      ESLint rule `local-rules/require-role-first-line` enforces this
 *      at build time.
 *   2. Mutations call `emitAudit` — direct `auditLog` inserts are
 *      banned by `local-rules/no-audit-log-direct-write` (Story 1.6).
 *   3. Case-sensitive uniqueness on `name` enforced via the
 *      `by_name` index + a pre-insert lookup. Convex has no DB-level
 *      UNIQUE constraint.
 *   4. Deletion refuses when any non-retired lot references the
 *      section via `sectionId` — the admin must either reassign the
 *      lots first or retire the section instead (soft-delete pattern
 *      mirrors `lots.isRetired` and `expenseCategories.isActive`).
 *   5. Audit `entityType` is `"section"` — Story 1.15 H6 (adversarial
 *      review) extended the `auditLog.entityType` union with the
 *      dedicated literal so per-section `by_entity` lookups surface
 *      section CRUD events directly. Prior rows emitted with
 *      `entityType: "lot"` + `entityId: <sectionId>` remain readable
 *      via the legacy ids; no migration required because the read
 *      path is additive.
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
type SectionDoc = DataModel["sections"]["document"];
type SectionId = SectionDoc["_id"];

/**
 * Maximum lengths for form fields. Mirrored by the client-side Zod
 * schema in `src/components/SectionForm/schema.ts`; the server is
 * authoritative.
 */
export const SECTION_NAME_MAX_LENGTH = 64;
export const SECTION_DISPLAY_NAME_MAX_LENGTH = 80;
export const SECTION_DESCRIPTION_MAX_LENGTH = 2000;

/**
 * The five-literal union of brand-guide wayfinding categories.
 * Mirrored verbatim from the schema validator.
 */
const sectionKindValidator = v.union(
  v.literal("chapel"),
  v.literal("family"),
  v.literal("standard"),
  v.literal("niche"),
  v.literal("columbarium"),
);

type SectionKind =
  | "chapel"
  | "family"
  | "standard"
  | "niche"
  | "columbarium";

const KEBAB_CASE_REGEX = /^[a-z0-9-]+$/;

/**
 * Shape the admin list page consumes. Each row carries the raw
 * document plus a denormalised `linkedLotCount` so the "Delete"
 * action can render conditionally without an extra round-trip per
 * row.
 */
export interface ListedSection {
  _id: SectionId;
  _creationTime: number;
  name: string;
  displayName: string;
  sortOrder: number;
  kind: SectionKind;
  descriptionMarkdown?: string;
  geometryBoundsBox?: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
  isRetired: boolean;
  createdAt: number;
  createdBy: SectionDoc["createdBy"];
  linkedLotCount: number;
}

/**
 * Admin-only registry listing. Sorted by `sortOrder` ascending so the
 * admin's chosen order drives both the registry page table and any
 * downstream dropdown using this query.
 *
 * `includeRetired` defaults to `false`. The admin page passes `true`
 * to surface retired rows so they can be restored if needed.
 */
export const listSections = queryGeneric({
  args: {
    includeRetired: v.optional(v.boolean()),
  },
  handler: async (
    ctx: QueryCtx,
    args: { includeRetired?: boolean },
  ): Promise<ListedSection[]> => {
    await requireRole(ctx, ["admin"]);
    const rows = await ctx.db.query("sections").collect();
    const includeRetired = args.includeRetired === true;
    const filtered = includeRetired
      ? rows
      : rows.filter((r) => !r.isRetired);

    // Compute linked-lot counts. Phase 1 scale (~2,000 lots) makes
    // per-section index scans cheap. If section count × lot count
    // grows past ~10k, a maintained counter on the section row would
    // be the next step.
    const out: ListedSection[] = [];
    for (const row of filtered) {
      const linkedLots = await ctx.db
        .query("lots")
        .withIndex("by_sectionId", (q) => q.eq("sectionId", row._id))
        .collect();
      const item: ListedSection = {
        _id: row._id,
        _creationTime: row._creationTime,
        name: row.name,
        displayName: row.displayName,
        sortOrder: row.sortOrder,
        kind: row.kind,
        isRetired: row.isRetired,
        createdAt: row.createdAt,
        createdBy: row.createdBy,
        linkedLotCount: linkedLots.length,
      };
      if (row.descriptionMarkdown !== undefined) {
        item.descriptionMarkdown = row.descriptionMarkdown;
      }
      if (row.geometryBoundsBox !== undefined) {
        item.geometryBoundsBox = row.geometryBoundsBox;
      }
      out.push(item);
    }
    // Sort by `sortOrder` ascending; secondary by displayName for
    // deterministic ordering when `sortOrder` ties.
    return out.sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.displayName.localeCompare(b.displayName);
    });
  },
});

/**
 * Public read-side helper for the LotForm dropdown. Available to all
 * staff roles (admin, office_staff, field_worker) so cached offline
 * lot data (Story 1.13) can join section labels. Retired sections
 * are excluded — assigning a new lot to a retired section is a
 * brand-system regression.
 */
export const listActiveSections = queryGeneric({
  args: {},
  handler: async (
    ctx: QueryCtx,
  ): Promise<
    Array<{
      _id: SectionId;
      name: string;
      displayName: string;
      sortOrder: number;
      kind: SectionKind;
    }>
  > => {
    await requireRole(ctx, ["admin", "office_staff", "field_worker"]);
    const rows = await ctx.db.query("sections").collect();
    const active = rows.filter((r) => !r.isRetired);
    return active
      .map((r) => ({
        _id: r._id,
        name: r.name,
        displayName: r.displayName,
        sortOrder: r.sortOrder,
        kind: r.kind,
      }))
      .sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return a.displayName.localeCompare(b.displayName);
      });
  },
});

/**
 * Single-row read for the section detail surface (admin only — the
 * admin page is the only consumer in Phase 1).
 */
export const getSection = queryGeneric({
  args: { sectionId: v.id("sections") },
  handler: async (
    ctx: QueryCtx,
    args: { sectionId: SectionId },
  ): Promise<SectionDoc | null> => {
    await requireRole(ctx, ["admin"]);
    return await ctx.db.get(args.sectionId);
  },
});

/**
 * Inserts a new section. `name` is asserted unique (case-sensitive)
 * via the `by_name` index lookup before the insert lands.
 */
export const createSection = mutationGeneric({
  args: {
    name: v.string(),
    displayName: v.string(),
    sortOrder: v.number(),
    kind: sectionKindValidator,
    descriptionMarkdown: v.optional(v.string()),
    geometryBoundsBox: v.optional(
      v.object({
        minLat: v.number(),
        maxLat: v.number(),
        minLng: v.number(),
        maxLng: v.number(),
      }),
    ),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      name: string;
      displayName: string;
      sortOrder: number;
      kind: SectionKind;
      descriptionMarkdown?: string;
      geometryBoundsBox?: {
        minLat: number;
        maxLat: number;
        minLng: number;
        maxLng: number;
      };
    },
  ): Promise<{ sectionId: SectionId }> => {
    const auth = await requireRole(ctx, ["admin"]);

    const name = args.name.trim();
    const displayName = args.displayName.trim();
    validateSectionPayload({
      name,
      displayName,
      sortOrder: args.sortOrder,
      descriptionMarkdown: args.descriptionMarkdown,
    });

    // Uniqueness check on `name` — manual because Convex has no
    // UNIQUE index.
    const duplicate = await ctx.db
      .query("sections")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
    if (duplicate !== null) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "A section with this name already exists.",
        { kind: "DUPLICATE_SECTION_NAME", name },
      );
    }

    const now = Date.now();
    const insertRow: {
      name: string;
      displayName: string;
      sortOrder: number;
      kind: SectionKind;
      descriptionMarkdown?: string;
      geometryBoundsBox?: {
        minLat: number;
        maxLat: number;
        minLng: number;
        maxLng: number;
      };
      isRetired: boolean;
      createdAt: number;
      createdBy: typeof auth.userId;
    } = {
      name,
      displayName,
      sortOrder: args.sortOrder,
      kind: args.kind,
      isRetired: false,
      createdAt: now,
      createdBy: auth.userId,
    };
    const trimmedDescription = args.descriptionMarkdown?.trim();
    if (trimmedDescription !== undefined && trimmedDescription.length > 0) {
      insertRow.descriptionMarkdown = trimmedDescription;
    }
    if (args.geometryBoundsBox !== undefined) {
      insertRow.geometryBoundsBox = args.geometryBoundsBox;
    }
    const sectionId = await ctx.db.insert("sections", insertRow);

    await emitAudit(ctx, {
      action: "create",
      entityType: "section",
      entityId: sectionId,
      after: {
        kind: "section",
        sectionKind: args.kind,
        name,
        displayName,
        sortOrder: args.sortOrder,
        isRetired: false,
      },
    });

    return { sectionId };
  },
});

/**
 * Partial-patch update. Supply only the fields you want to change.
 * Rename collisions on `name` are rejected before any patch lands.
 *
 * `isRetired` is settable through this mutation so the admin page
 * can use a single "Update" action for both editing the fields and
 * flipping the retired flag — no separate `retireSection` /
 * `restoreSection` round-trip required.
 */
export const updateSection = mutationGeneric({
  args: {
    sectionId: v.id("sections"),
    patch: v.object({
      name: v.optional(v.string()),
      displayName: v.optional(v.string()),
      sortOrder: v.optional(v.number()),
      kind: v.optional(sectionKindValidator),
      descriptionMarkdown: v.optional(v.string()),
      geometryBoundsBox: v.optional(
        v.object({
          minLat: v.number(),
          maxLat: v.number(),
          minLng: v.number(),
          maxLng: v.number(),
        }),
      ),
      isRetired: v.optional(v.boolean()),
    }),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      sectionId: SectionId;
      patch: {
        name?: string;
        displayName?: string;
        sortOrder?: number;
        kind?: SectionKind;
        descriptionMarkdown?: string;
        geometryBoundsBox?: {
          minLat: number;
          maxLat: number;
          minLng: number;
          maxLng: number;
        };
        isRetired?: boolean;
      };
    },
  ): Promise<{ sectionId: SectionId }> => {
    await requireRole(ctx, ["admin"]);

    const existing = await ctx.db.get(args.sectionId);
    if (existing === null) {
      throwError(ErrorCode.NOT_FOUND, "Section not found.", {
        sectionId: args.sectionId,
      });
    }

    const patch: Partial<SectionDoc> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    if (args.patch.name !== undefined) {
      const name = args.patch.name.trim();
      validateName(name);
      if (name !== existing.name) {
        const collision = await ctx.db
          .query("sections")
          .withIndex("by_name", (q) => q.eq("name", name))
          .first();
        if (collision !== null && collision._id !== args.sectionId) {
          throwError(
            ErrorCode.INVARIANT_VIOLATION,
            "A section with this name already exists.",
            { kind: "DUPLICATE_SECTION_NAME", name },
          );
        }
      }
      patch.name = name;
      before.name = existing.name;
      after.name = name;
    }
    if (args.patch.displayName !== undefined) {
      const displayName = args.patch.displayName.trim();
      validateDisplayName(displayName);
      patch.displayName = displayName;
      before.displayName = existing.displayName;
      after.displayName = displayName;
    }
    if (args.patch.sortOrder !== undefined) {
      validateSortOrder(args.patch.sortOrder);
      patch.sortOrder = args.patch.sortOrder;
      before.sortOrder = existing.sortOrder;
      after.sortOrder = args.patch.sortOrder;
    }
    if (args.patch.kind !== undefined) {
      patch.kind = args.patch.kind;
      before.kind = existing.kind;
      after.kind = args.patch.kind;
    }
    if (args.patch.descriptionMarkdown !== undefined) {
      const description = args.patch.descriptionMarkdown.trim();
      validateDescription(description);
      // Empty string → unset the field via re-write of the row.
      // Convex `patch` cannot remove a key; we mirror the
      // expense-categories pattern and write an empty string when
      // the description is cleared. Downstream callers tolerate the
      // empty-string sentinel via `.trim().length === 0`.
      patch.descriptionMarkdown = description;
      before.descriptionMarkdown = existing.descriptionMarkdown ?? null;
      after.descriptionMarkdown = description;
    }
    if (args.patch.geometryBoundsBox !== undefined) {
      patch.geometryBoundsBox = args.patch.geometryBoundsBox;
      before.geometryBoundsBox = existing.geometryBoundsBox ?? null;
      after.geometryBoundsBox = args.patch.geometryBoundsBox;
    }
    if (args.patch.isRetired !== undefined) {
      patch.isRetired = args.patch.isRetired;
      before.isRetired = existing.isRetired;
      after.isRetired = args.patch.isRetired;
    }

    if (Object.keys(patch).length === 0) {
      // No-op — same as `updateLot`'s behaviour.
      return { sectionId: args.sectionId };
    }

    await ctx.db.patch(args.sectionId, patch);

    // Determine the audit action: when the `isRetired` flag is the
    // only changing field, surface `deactivate` / `reactivate` so
    // the audit reader can spot retire actions without parsing the
    // diff. Otherwise emit a generic `update`.
    const isOnlyRetireToggle =
      args.patch.isRetired !== undefined &&
      Object.keys(patch).length === 1;
    const action = isOnlyRetireToggle
      ? args.patch.isRetired === true
        ? "deactivate"
        : "reactivate"
      : "update";

    await emitAudit(ctx, {
      action,
      entityType: "section",
      entityId: args.sectionId,
      before: { kind: "section", ...before },
      after: { kind: "section", ...after },
    });

    return { sectionId: args.sectionId };
  },
});

/**
 * Hard-deletes a section. Refuses if any non-retired lot references
 * the section via `sectionId` — historical references must remain
 * intact, and retirement (via `updateSection` with `isRetired: true`)
 * is the correct path for "stop using this".
 */
export const deleteSection = mutationGeneric({
  args: { sectionId: v.id("sections") },
  handler: async (
    ctx: MutationCtx,
    args: { sectionId: SectionId },
  ): Promise<{ deleted: true }> => {
    await requireRole(ctx, ["admin"]);

    const existing = await ctx.db.get(args.sectionId);
    if (existing === null) {
      throwError(ErrorCode.NOT_FOUND, "Section not found.", {
        sectionId: args.sectionId,
      });
    }

    const linkedLots = await ctx.db
      .query("lots")
      .withIndex("by_sectionId", (q) => q.eq("sectionId", args.sectionId))
      .collect();
    if (linkedLots.length > 0) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Cannot delete — this section is referenced by existing lots. Retire it instead.",
        {
          kind: "CANNOT_DELETE_SECTION_WITH_LOTS",
          linkedLotCount: linkedLots.length,
        },
      );
    }

    await ctx.db.delete(args.sectionId);

    await emitAudit(ctx, {
      action: "delete",
      entityType: "section",
      entityId: args.sectionId,
      before: {
        kind: "section",
        sectionKind: existing.kind,
        name: existing.name,
        displayName: existing.displayName,
        sortOrder: existing.sortOrder,
        isRetired: existing.isRetired,
      },
    });

    return { deleted: true };
  },
});

/**
 * Stateless full-payload validation for `createSection`. Centralises
 * the per-field invariants so the create handler reads as a straight
 * happy path.
 */
function validateSectionPayload(payload: {
  name: string;
  displayName: string;
  sortOrder: number;
  descriptionMarkdown?: string;
}): void {
  validateName(payload.name);
  validateDisplayName(payload.displayName);
  validateSortOrder(payload.sortOrder);
  if (payload.descriptionMarkdown !== undefined) {
    validateDescription(payload.descriptionMarkdown.trim());
  }
}

function validateName(name: string): void {
  if (name.length === 0) {
    throwError(ErrorCode.VALIDATION, "Name is required.", { field: "name" });
  }
  if (name.length > SECTION_NAME_MAX_LENGTH) {
    throwError(
      ErrorCode.VALIDATION,
      `Name too long (max ${SECTION_NAME_MAX_LENGTH} characters).`,
      { field: "name", length: name.length },
    );
  }
  if (!KEBAB_CASE_REGEX.test(name)) {
    throwError(
      ErrorCode.VALIDATION,
      "Name must be lowercase letters, numbers, and hyphens only (kebab-case).",
      { field: "name" },
    );
  }
}

function validateDisplayName(displayName: string): void {
  if (displayName.length === 0) {
    throwError(ErrorCode.VALIDATION, "Display name is required.", {
      field: "displayName",
    });
  }
  if (displayName.length > SECTION_DISPLAY_NAME_MAX_LENGTH) {
    throwError(
      ErrorCode.VALIDATION,
      `Display name too long (max ${SECTION_DISPLAY_NAME_MAX_LENGTH} characters).`,
      { field: "displayName", length: displayName.length },
    );
  }
}

function validateSortOrder(sortOrder: number): void {
  if (
    !Number.isFinite(sortOrder) ||
    !Number.isInteger(sortOrder) ||
    sortOrder < 0
  ) {
    throwError(
      ErrorCode.VALIDATION,
      "Sort order must be a non-negative integer.",
      { field: "sortOrder" },
    );
  }
}

function validateDescription(description: string): void {
  if (description.length > SECTION_DESCRIPTION_MAX_LENGTH) {
    throwError(
      ErrorCode.VALIDATION,
      `Description too long (max ${SECTION_DESCRIPTION_MAX_LENGTH} characters).`,
      { field: "descriptionMarkdown", length: description.length },
    );
  }
}
