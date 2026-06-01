/**
 * Lot inventory domain (Story 1.8, FR6 / FR8).
 *
 * Public surface — the canonical CRUD for the `lots` table. Every
 * downstream feature depends on these functions:
 *
 *   - Story 1.9 will refine `geometry` defaults + viewport queries.
 *   - Story 1.10 will read `listLots` results into the Cmd-K palette.
 *   - Story 1.11 will replace `/lots/[lotId]/edit/page.tsx` with the
 *     full lot detail page (which still calls `updateLot` here).
 *   - Story 1.12 will add the map toggle to `/lots/page.tsx`.
 *   - Epic 2+ (contracts, payments) will reference `_id` from this
 *     table.
 *
 * Conventions every handler obeys:
 *
 *   1. FIRST awaited statement is `await requireRole(ctx, [...])`. The
 *      ESLint rule `local-rules/require-role-first-line` enforces this.
 *   2. Mutations call `emitAudit` — direct `auditLog` inserts are
 *      banned by `local-rules/no-audit-log-direct-write` (Story 1.6).
 *   3. Status writes go through `transitionLotStatus` from
 *      `convex/lib/stateMachines.ts`. Direct `ctx.db.patch(..., { status })`
 *      is banned by `local-rules/no-raw-status-patch`; this file imports
 *      from stateMachines so the rule lets `updateLot`'s patch through
 *      (we still don't write `status` raw — `updateLot` rejects status
 *      in the field set).
 *   4. Money is stored as INTEGER centavos (`basePriceCents`). Math
 *      goes through `convex/lib/money.ts`; raw `* 100` / `/ 100` will
 *      eventually fail the deferred `no-cents-math` lint rule.
 *   5. Retire is soft-delete (`isRetired: true`) — never `ctx.db.delete`.
 *      Audit trail and reactive queries depend on the row persisting.
 */

import {
  type DataModelFromSchemaDefinition,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import { emitAudit } from "./lib/audit";
import {
  bumpLotStatusCounter,
} from "./lib/dashboardCounters";
import { ErrorCode, throwError } from "./lib/errors";
import {
  assertPolygonValid,
  type Bbox,
  bboxFromPolygon,
  getDefaultPlaceholderGeometry,
  isCoordInManilaSanityRange,
  type LatLng,
  type LotGeometry,
  type Polygon,
  polygonCentroid,
} from "./lib/geometry";
import { transitionLotStatus } from "./lib/stateMachines";
import { LOT_STATUSES, type LotStatus } from "./lib/states";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type LotDoc = DataModel["lots"]["document"];
type LotId = LotDoc["_id"];

/**
 * Lot status validator — matches the schema's `v.union(v.literal(...))`
 * exactly. Used for argument validation on `setLotStatusReserved` and
 * the `statusFilter` arg on `listLots`.
 */
const lotStatusValidator = v.union(
  v.literal("available"),
  v.literal("reserved"),
  v.literal("sold"),
  v.literal("occupied"),
  v.literal("cancelled"),
  v.literal("defaulted"),
  v.literal("transferred"),
);

const lotTypeValidator = v.union(
  v.literal("single"),
  v.literal("family"),
  v.literal("mausoleum"),
  v.literal("niche"),
);

/**
 * Lists lots with optional filters. Sorted by `code` ascending.
 *
 * - When `statusFilter` is provided, uses the `by_status` index.
 * - When `sectionFilter` is provided (and no status filter), uses
 *   `by_section_block`.
 * - Otherwise, full-table scan — acceptable at the architecture's
 *   target scale of ~2,000 rows.
 *
 * Retired lots are filtered in-memory; the architecture's "premature
 * optimization" principle says we add a `by_is_retired` index only
 * when the row count justifies it (≥100k rows).
 */
export const listLots = queryGeneric({
  args: {
    includeRetired: v.optional(v.boolean()),
    statusFilter: v.optional(lotStatusValidator),
    sectionFilter: v.optional(v.string()),
  },
  handler: async (
    ctx: QueryCtx,
    args: {
      includeRetired?: boolean;
      statusFilter?: LotStatus;
      sectionFilter?: string;
    },
  ): Promise<LotDoc[]> => {
    await requireRole(ctx, ["admin", "office_staff", "field_worker"]);
    let rows: LotDoc[];
    if (args.statusFilter !== undefined) {
      const statusFilter = args.statusFilter;
      rows = await ctx.db
        .query("lots")
        .withIndex("by_status", (q) => q.eq("status", statusFilter))
        .collect();
      if (args.sectionFilter !== undefined) {
        const section = args.sectionFilter;
        rows = rows.filter((r) => r.section === section);
      }
    } else if (args.sectionFilter !== undefined) {
      const section = args.sectionFilter;
      rows = await ctx.db
        .query("lots")
        .withIndex("by_section_block", (q) => q.eq("section", section))
        .collect();
    } else {
      rows = await ctx.db.query("lots").collect();
    }
    const includeRetired = args.includeRetired === true;
    const filtered = includeRetired
      ? rows
      : rows.filter((r) => !r.isRetired);
    // Sort by code ascending — stable, deterministic ordering for the
    // list view. `localeCompare` keeps "D-5-12" / "D-5-2" ordering
    // alphabetically rather than ASCII-numerically (12 < 2 by code,
    // which is the human expectation).
    return [...filtered].sort((a, b) => a.code.localeCompare(b.code));
  },
});

/**
 * Server-side projection for `getLot` — `geometry` is replaced by a
 * nullable variant so the redaction policy (Story 8.3 AC4 / NFR-S4)
 * can be expressed without leaking coordinate data through the type
 * system. Either:
 *
 *   - the lot's geometry is fully exposed (`LotGeometry`),
 *   - the polygon is redacted but the centroid kept (field workers on
 *     surveyed lots), or
 *   - geometry is null (placeholder lots, regardless of role).
 *
 * Returning `null` for the geometry slot is the explicit "this caller
 * is not allowed to see coordinates" signal — distinct from the field
 * being missing on the document (which never happens; the schema
 * guarantees a `geometry` object on every row).
 */
type RedactedLotGeometry =
  | LotGeometry
  | (Bbox & { centroid: LatLng; polygon: null })
  | null;

type GetLotResult = Omit<LotDoc, "geometry"> & {
  geometry: RedactedLotGeometry;
};

/**
 * Fetches a single lot by id (or `null` when not found / retired and
 * the caller didn't ask for retired). Retired lots are returned here
 * so the detail page (Story 1.11) can show "this lot is retired"
 * rather than 404 — the list view filters them out, but the detail
 * view treats them as still-existing.
 *
 * Coordinate redaction (Story 8.3 AC4, NFR-S4):
 *
 *   - admin / office_staff → full geometry (centroid + polygon).
 *   - field_worker (and no higher role) → geometry.polygon is null;
 *     centroid is exposed so the "Open in Maps" handoff still works
 *     for navigation. Polygon vertices have legal-evidence value per
 *     ADR-0008 §4 and are not appropriate for field-worker scope.
 *   - any role → if `geometryStatus === "placeholder"`, geometry is
 *     null. The placeholder centroid points at the cemetery centroid
 *     and is misleading on a per-lot basis; we refuse to expose it
 *     even to admins through this surface (it is still queryable via
 *     `listInBbox` because the map needs to render placeholder
 *     markers in aggregate).
 *
 * UI-only hiding is not sufficient (NFR-S4): a field worker calling
 * `getLot` directly must NOT receive polygon vertices.
 */
export const getLot = queryGeneric({
  args: { lotId: v.id("lots") },
  handler: async (
    ctx: QueryCtx,
    args: { lotId: LotId },
  ): Promise<GetLotResult | null> => {
    const auth = await requireRole(ctx, [
      "admin",
      "office_staff",
      "field_worker",
    ]);
    const lot = await ctx.db.get(args.lotId);
    if (lot === null) {
      return null;
    }
    return redactLotGeometryForCaller(lot, auth.roles);
  },
});

/**
 * Apply Story 8.3's geometry redaction policy. Pure function — exported
 * for unit-test friendliness within this module. Roles are checked in
 * descending privilege order: any presence of admin or office_staff
 * yields the unredacted document; otherwise the caller is treated as a
 * field worker.
 */
function redactLotGeometryForCaller(
  lot: LotDoc,
  roles: ReadonlyArray<"admin" | "office_staff" | "field_worker" | "customer">,
): GetLotResult {
  // Placeholder geometry is misleading per-lot (the centroid points at
  // the cemetery-wide reference, not the lot). Drop it for everyone.
  if (lot.geometryStatus === "placeholder") {
    return { ...lot, geometry: null };
  }
  const hasOfficeAccess =
    roles.includes("admin") || roles.includes("office_staff");
  if (hasOfficeAccess) {
    return lot;
  }
  // Field-worker only: keep centroid + bbox (needed for the navigation
  // handoff and for rendering a marker), redact polygon vertices.
  return {
    ...lot,
    geometry: {
      centroid: lot.geometry.centroid,
      polygon: null,
      bboxMinLat: lot.geometry.bboxMinLat,
      bboxMaxLat: lot.geometry.bboxMaxLat,
      bboxMinLng: lot.geometry.bboxMinLng,
      bboxMaxLng: lot.geometry.bboxMaxLng,
    },
  };
}

/**
 * Creates a new lot. Status starts at `available` — creation is not a
 * transition (no `from` state exists), so this DOES patch `status`
 * directly via the insert; subsequent changes route through
 * `transitionLotStatus`.
 *
 * Validates:
 *   - `code` is unique (manual check via `by_code` index — Convex has
 *     no DB-level UNIQUE constraint).
 *   - `basePriceCents` is a positive integer (sanity check; the UI
 *     enforces ≥ ₱100 / 10000 centavos, but the server's floor is
 *     just "> 0" so admin tools can seed cheap test data).
 *   - `dimensions` width/depth are positive numbers (real-world m²
 *     can't be zero or negative).
 *
 * Emits an audit log with the created row as `after`. `before` is
 * absent (create has no prior state — see `convex/lib/audit.ts`).
 */
export const createLot = mutationGeneric({
  args: {
    code: v.string(),
    section: v.string(),
    // Story 1.15 — optional FK to the new `sections` registry. Lot
    // CRUD continues to work without `sectionId` for back-compat with
    // existing callers and the legacy free-text section column; the
    // LotForm dropdown supplies the FK once the registry is populated.
    sectionId: v.optional(v.id("sections")),
    block: v.string(),
    row: v.string(),
    type: lotTypeValidator,
    dimensions: v.object({
      widthM: v.number(),
      depthM: v.number(),
    }),
    basePriceCents: v.number(),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      code: string;
      section: string;
      sectionId?: DataModel["sections"]["document"]["_id"];
      block: string;
      row: string;
      type: "single" | "family" | "mausoleum" | "niche";
      dimensions: { widthM: number; depthM: number };
      basePriceCents: number;
    },
  ): Promise<LotId> => {
    const auth = await requireRole(ctx, ["admin", "office_staff"]);
    validateLotPayload({
      code: args.code,
      section: args.section,
      block: args.block,
      row: args.row,
      dimensions: args.dimensions,
      basePriceCents: args.basePriceCents,
    });
    // Story 1.15 — when the form supplies a `sectionId`, validate the
    // section exists + is not retired. Caller-supplied IDs targeting
    // a missing or retired section indicate a programming error or a
    // stale dropdown cache; reject loudly rather than write a
    // dangling FK.
    if (args.sectionId !== undefined) {
      const sectionRow = await ctx.db.get(args.sectionId);
      if (sectionRow === null) {
        throwError(ErrorCode.NOT_FOUND, "Section not found.", {
          sectionId: args.sectionId,
        });
      }
      if (sectionRow.isRetired) {
        throwError(
          ErrorCode.INVARIANT_VIOLATION,
          "Cannot assign a lot to a retired section.",
          { sectionId: args.sectionId, kind: "RETIRED_SECTION" },
        );
      }
    }
    // Uniqueness check on `code` — manual because Convex has no
    // UNIQUE index. Re-check on insert path (a concurrent insert
    // could still slip through; under load Story 3.1's optimistic
    // pattern would apply, but at 2,000 lots manual create + a
    // single uniqueness lookup is sufficient).
    const existing = await ctx.db
      .query("lots")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .first();
    if (existing !== null) {
      throwError(
        ErrorCode.DUPLICATE_CODE,
        `A lot with code "${args.code}" already exists.`,
        { code: args.code, existingLotId: existing._id },
      );
    }
    // Story 1.9 Task 3: replace Story 1.8's inline placeholder centroid
    // (it was inlined under a different name in this same module; the
    // helper now lives in `convex/lib/geometry.ts` so changing the
    // cemetery's reference coordinate is a one-line change in one file
    // rather than a grep-and-replace risk). `section` is forwarded so
    // Story 1.12's section-specific overlays can wire in section-keyed
    // centroids without a `createLot` signature change.
    const geometry = getDefaultPlaceholderGeometry({ section: args.section });
    const lotInsert: {
      code: string;
      section: string;
      sectionId?: DataModel["sections"]["document"]["_id"];
      block: string;
      row: string;
      type: "single" | "family" | "mausoleum" | "niche";
      dimensions: { widthM: number; depthM: number };
      basePriceCents: number;
      status: "available";
      geometry: typeof geometry;
      geometryStatus: "placeholder";
      isRetired: false;
      createdAt: number;
      createdBy: typeof auth.userId;
    } = {
      code: args.code,
      section: args.section,
      block: args.block,
      row: args.row,
      type: args.type,
      dimensions: args.dimensions,
      basePriceCents: args.basePriceCents,
      status: "available",
      geometry,
      geometryStatus: "placeholder",
      isRetired: false,
      createdAt: Date.now(),
      createdBy: auth.userId,
    };
    if (args.sectionId !== undefined) {
      lotInsert.sectionId = args.sectionId;
    }
    const lotId = await ctx.db.insert("lots", lotInsert);
    // Story 5.2 follow-up — keep the dashboard's lot-status summary
    // counter in sync. New (non-retired) lot defaults to `available`.
    await bumpLotStatusCounter(ctx, "available", +1);
    await emitAudit(ctx, {
      action: "create",
      entityType: "lot",
      entityId: lotId,
      after: {
        code: args.code,
        section: args.section,
        sectionId: args.sectionId ?? null,
        block: args.block,
        row: args.row,
        type: args.type,
        dimensions: args.dimensions,
        basePriceCents: args.basePriceCents,
        status: "available",
      },
    });
    return lotId;
  },
});

/**
 * Updates an existing lot's mutable fields. Explicitly REJECTS:
 *   - `code` — immutable identifier; correcting a typo requires a
 *     migration + ADR (architecture § Naming Patterns).
 *   - `status` — status changes go through `transitionLotStatus`
 *     (Story 1.7 / 1.8). The lint rule `no-raw-status-patch` also
 *     catches this at build time.
 *   - `isRetired` — use `retireLot` mutation for soft-delete.
 *   - `geometry` / `geometryStatus` — Story 1.9 owns the geometry
 *     update surface; calling `updateLot` to patch geometry is a
 *     category error.
 *
 * Emits an audit log with `before` / `after` capturing only the
 * fields that changed.
 */
export const updateLot = mutationGeneric({
  args: {
    lotId: v.id("lots"),
    fields: v.object({
      section: v.optional(v.string()),
      // Story 1.15 — additive `sectionId` patch path. The legacy
      // `section` string remains writable for back-compat (Story
      // 1.8 callers + the inflight migration); the new dropdown
      // path supplies BOTH fields atomically so the by_section_block
      // index stays in step with the FK.
      sectionId: v.optional(v.id("sections")),
      block: v.optional(v.string()),
      row: v.optional(v.string()),
      type: v.optional(lotTypeValidator),
      dimensions: v.optional(
        v.object({ widthM: v.number(), depthM: v.number() }),
      ),
      basePriceCents: v.optional(v.number()),
    }),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      lotId: LotId;
      fields: {
        section?: string;
        sectionId?: DataModel["sections"]["document"]["_id"];
        block?: string;
        row?: string;
        type?: "single" | "family" | "mausoleum" | "niche";
        dimensions?: { widthM: number; depthM: number };
        basePriceCents?: number;
      };
    },
  ): Promise<void> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const lot = await ctx.db.get(args.lotId);
    if (lot === null) {
      throwError(ErrorCode.NOT_FOUND, "Lot not found.", { lotId: args.lotId });
    }
    if (lot.isRetired) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Cannot edit a retired lot. Reactivate first.",
        { lotId: args.lotId },
      );
    }
    validatePartialLotPayload(args.fields);
    // Story 1.15 — when the caller supplies a `sectionId`, validate
    // the section exists + is not retired before the patch lands.
    if (args.fields.sectionId !== undefined) {
      const sectionRow = await ctx.db.get(args.fields.sectionId);
      if (sectionRow === null) {
        throwError(ErrorCode.NOT_FOUND, "Section not found.", {
          sectionId: args.fields.sectionId,
        });
      }
      if (sectionRow.isRetired) {
        throwError(
          ErrorCode.INVARIANT_VIOLATION,
          "Cannot assign a lot to a retired section.",
          {
            sectionId: args.fields.sectionId,
            kind: "RETIRED_SECTION",
          },
        );
      }
    }
    // Compose the patch: only fields explicitly provided land in the
    // patch object. Construct `before` / `after` to mirror exactly
    // those fields so the audit log highlights what changed.
    const patch: Partial<LotDoc> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (args.fields.section !== undefined) {
      patch.section = args.fields.section;
      before.section = lot.section;
      after.section = args.fields.section;
    }
    if (args.fields.sectionId !== undefined) {
      patch.sectionId = args.fields.sectionId;
      before.sectionId = lot.sectionId ?? null;
      after.sectionId = args.fields.sectionId;
    }
    if (args.fields.block !== undefined) {
      patch.block = args.fields.block;
      before.block = lot.block;
      after.block = args.fields.block;
    }
    if (args.fields.row !== undefined) {
      patch.row = args.fields.row;
      before.row = lot.row;
      after.row = args.fields.row;
    }
    if (args.fields.type !== undefined) {
      patch.type = args.fields.type;
      before.type = lot.type;
      after.type = args.fields.type;
    }
    if (args.fields.dimensions !== undefined) {
      patch.dimensions = args.fields.dimensions;
      before.dimensions = lot.dimensions;
      after.dimensions = args.fields.dimensions;
    }
    if (args.fields.basePriceCents !== undefined) {
      patch.basePriceCents = args.fields.basePriceCents;
      before.basePriceCents = lot.basePriceCents;
      after.basePriceCents = args.fields.basePriceCents;
    }
    if (Object.keys(patch).length === 0) {
      // Nothing to update — no-op rather than empty audit row.
      return;
    }
    await ctx.db.patch(args.lotId, patch);
    await emitAudit(ctx, {
      action: "update",
      entityType: "lot",
      entityId: args.lotId,
      before,
      after,
    });
  },
});

/**
 * Soft-deletes a lot by setting `isRetired: true`. Refuses if the lot
 * has any history (ownerships, contracts, payments) — those tables
 * don't exist yet at Story 1.8; `hasAnyHistory` returns `false` for
 * now and will be extended in Stories 2.x / 3.x.
 *
 * Throws `CANNOT_RETIRE_WITH_HISTORY` (AC4) once history checks
 * become non-trivial.
 */
export const retireLot = mutationGeneric({
  args: { lotId: v.id("lots") },
  handler: async (
    ctx: MutationCtx,
    args: { lotId: LotId },
  ): Promise<void> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const lot = await ctx.db.get(args.lotId);
    if (lot === null) {
      throwError(ErrorCode.NOT_FOUND, "Lot not found.", { lotId: args.lotId });
    }
    if (lot.isRetired) {
      // Idempotent — already retired, no-op.
      return;
    }
    const hasHistory = await hasAnyHistory(ctx, args.lotId);
    if (hasHistory) {
      throwError(
        ErrorCode.CANNOT_RETIRE_WITH_HISTORY,
        "This lot has sales or payment history and cannot be retired.",
        { lotId: args.lotId },
      );
    }
    await ctx.db.patch(args.lotId, { isRetired: true });
    // Story 5.2 follow-up — retired lots leave the dashboard's
    // inventory grid. Decrement the counter for the lot's current
    // status so the dashboard tile reflects the retirement immediately.
    await bumpLotStatusCounter(ctx, lot.status, -1);
    await emitAudit(ctx, {
      action: "deactivate",
      entityType: "lot",
      entityId: args.lotId,
      before: { isRetired: false },
      after: { isRetired: true },
    });
  },
});

/**
 * AC5 smoke-test mutation — exercises `transitionLotStatus` end-to-end
 * for `available → reserved`. The real reservation flow (with deposit
 * capture, contract creation, etc.) lives in Story 3.x; this exists so
 * Story 1.8 can verify the state-machine wiring works without waiting
 * for Epic 3.
 */
export const setLotStatusReserved = mutationGeneric({
  args: {
    lotId: v.id("lots"),
    reason: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: { lotId: LotId; reason?: string },
  ): Promise<void> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    await transitionLotStatus(ctx, {
      lotId: args.lotId,
      to: "reserved",
      reason: args.reason,
    });
  },
});

/**
 * Cross-references the lot id against future tables to determine
 * whether retiring is safe (AC4). Story 1.8 introduces a stub that
 * always returns `false`; Stories 2.7 (ownerships), 3.3 (contracts),
 * and 3.9 (payments) will each extend this to check their own table.
 *
 * Implementation note: leave each future check as a separate query
 * (with a TODO) rather than collapsing them — easier to add new
 * tables incrementally and to test each clause in isolation.
 */
async function hasAnyHistory(
  _ctx: MutationCtx,
  _lotId: LotId,
): Promise<boolean> {
  // TODO (Story 2.7): check `ownerships` for any row where `lotId`
  // matches. Until the table exists, this check is a no-op.
  // TODO (Story 3.3 / 3.9): check `contracts` and `payments` for any
  // reference to this lot. Same scaffolding pattern.
  return false;
}

/**
 * Stateless validation for `createLot`'s full payload.
 *
 * Centralises the per-field invariants so `createLot` reads as a
 * straight-line happy path. Throws `VALIDATION` on any failure.
 */
function validateLotPayload(payload: {
  code: string;
  section: string;
  block: string;
  row: string;
  dimensions: { widthM: number; depthM: number };
  basePriceCents: number;
}): void {
  if (payload.code.trim().length === 0) {
    throwError(ErrorCode.VALIDATION, "Lot code is required.");
  }
  if (payload.section.trim().length === 0) {
    throwError(ErrorCode.VALIDATION, "Section is required.");
  }
  if (payload.block.trim().length === 0) {
    throwError(ErrorCode.VALIDATION, "Block is required.");
  }
  if (payload.row.trim().length === 0) {
    throwError(ErrorCode.VALIDATION, "Row is required.");
  }
  if (!Number.isFinite(payload.dimensions.widthM) || payload.dimensions.widthM <= 0) {
    throwError(ErrorCode.VALIDATION, "Width must be a positive number.");
  }
  if (!Number.isFinite(payload.dimensions.depthM) || payload.dimensions.depthM <= 0) {
    throwError(ErrorCode.VALIDATION, "Depth must be a positive number.");
  }
  if (
    !Number.isFinite(payload.basePriceCents) ||
    !Number.isInteger(payload.basePriceCents) ||
    payload.basePriceCents <= 0
  ) {
    throwError(
      ErrorCode.VALIDATION,
      "Base price must be a positive integer in centavos.",
    );
  }
}

/**
 * Validation for `updateLot`'s optional-field payload. Skips checks
 * for fields not present.
 */
function validatePartialLotPayload(fields: {
  section?: string;
  block?: string;
  row?: string;
  dimensions?: { widthM: number; depthM: number };
  basePriceCents?: number;
}): void {
  if (fields.section !== undefined && fields.section.trim().length === 0) {
    throwError(ErrorCode.VALIDATION, "Section is required.");
  }
  if (fields.block !== undefined && fields.block.trim().length === 0) {
    throwError(ErrorCode.VALIDATION, "Block is required.");
  }
  if (fields.row !== undefined && fields.row.trim().length === 0) {
    throwError(ErrorCode.VALIDATION, "Row is required.");
  }
  if (fields.dimensions !== undefined) {
    if (
      !Number.isFinite(fields.dimensions.widthM) ||
      fields.dimensions.widthM <= 0
    ) {
      throwError(ErrorCode.VALIDATION, "Width must be a positive number.");
    }
    if (
      !Number.isFinite(fields.dimensions.depthM) ||
      fields.dimensions.depthM <= 0
    ) {
      throwError(ErrorCode.VALIDATION, "Depth must be a positive number.");
    }
  }
  if (fields.basePriceCents !== undefined) {
    if (
      !Number.isFinite(fields.basePriceCents) ||
      !Number.isInteger(fields.basePriceCents) ||
      fields.basePriceCents <= 0
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "Base price must be a positive integer in centavos.",
      );
    }
  }
}

// Re-export for tests so they don't reach into `lib/states.ts` directly.
export { LOT_STATUSES };

/**
 * Viewport-bbox query (Story 1.9, AC5, NFR-P4).
 *
 * Returns the lots whose bounding box OVERLAPS the supplied viewport
 * bbox. Two lots overlap iff `lot.bboxMaxLat >= viewport.bboxMinLat`
 * AND `lot.bboxMinLat <= viewport.bboxMaxLat` (mirror on lng).
 *
 * Why the 0.1° pad on the index range:
 *
 *   Convex indexes only support one range-condition per query. The
 *   index is on `(geometry.bboxMinLat, geometry.bboxMaxLat)` — we use
 *   the FIRST field for the range. That means lots whose
 *   `geometry.bboxMinLat` is well below the viewport's `bboxMinLat`
 *   would be excluded from the index scan even though they *do*
 *   overlap (their `bboxMaxLat` may reach into the viewport).
 *
 *   We compensate with a 0.1° pad on the lower bound — wide enough to
 *   cover the largest plausible cemetery section (~10 km, ≈ 0.09° at
 *   Manila latitude) plus a margin. The in-memory filters then trim
 *   the candidate set to actual overlaps. The pad's "wasted scan"
 *   cost is small: at 2,000 total lots and selectivity ≈ 0.05, the
 *   index narrows to ≈ 100–300 candidates before the in-memory pass.
 *
 *   Once Phase 2 GPS data lands (Story 8.1+) and real polygons replace
 *   placeholders, the bboxes get real intervals and the pad can shrink
 *   to 0.01° or less. Updating the constant is a one-line change.
 *
 * Why fetch the whole document (and not a projection):
 *
 *   Story 1.12's map renderer needs `_id`, `code`, `status`,
 *   `geometry.centroid`. At 200 lots × ≈ 1 KB each, the wire payload
 *   is ≈ 200 KB — acceptable for Phase 1. If bundle pressure becomes
 *   a concern, add a `listInBboxMinimal` companion query that
 *   projects only the four fields; do NOT add a `populate=true` arg
 *   here (that pattern leaks the projection contract into every
 *   downstream type).
 *
 * Caller cap: returns at most `limit` rows (default 200, ceiling 500).
 * Architectural choice — a viewport showing > 500 lots is a UX bug
 * (the user can't read 500 markers at once); the cap is the server's
 * defence against a runaway viewport bug on the client.
 */
export const listInBbox = queryGeneric({
  args: {
    bboxMinLat: v.number(),
    bboxMaxLat: v.number(),
    bboxMinLng: v.number(),
    bboxMaxLng: v.number(),
    statusFilter: v.optional(lotStatusValidator),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx: QueryCtx,
    args: {
      bboxMinLat: number;
      bboxMaxLat: number;
      bboxMinLng: number;
      bboxMaxLng: number;
      statusFilter?: LotStatus;
      limit?: number;
    },
  ): Promise<LotDoc[]> => {
    await requireRole(ctx, ["admin", "office_staff", "field_worker"]);
    const limit = Math.min(args.limit ?? 200, 500);
    // 0.1° pad — see header JSDoc for the placeholder-bbox rationale.
    const PAD = 0.1;
    const indexLowerBound = args.bboxMinLat - PAD;
    const indexUpperBound = args.bboxMaxLat;
    const candidates = await ctx.db
      .query("lots")
      .withIndex("by_bbox_lat", (q) =>
        q
          .gte("geometry.bboxMinLat", indexLowerBound)
          .lte("geometry.bboxMinLat", indexUpperBound),
      )
      .collect();
    const statusFilter = args.statusFilter;
    const filtered: LotDoc[] = [];
    for (const lot of candidates) {
      if (lot.isRetired) continue;
      // Bbox-overlap predicate. Lat is partially pre-filtered by the
      // index (`bboxMinLat` only); double-check `bboxMaxLat` here
      // because a lot whose `bboxMinLat` is well below the viewport
      // may still not reach into it.
      if (lot.geometry.bboxMaxLat < args.bboxMinLat) continue;
      if (lot.geometry.bboxMinLng > args.bboxMaxLng) continue;
      if (lot.geometry.bboxMaxLng < args.bboxMinLng) continue;
      if (statusFilter !== undefined && lot.status !== statusFilter) continue;
      filtered.push(lot);
      if (filtered.length >= limit) break;
    }
    return filtered;
  },
});

/**
 * Internal geometry rewrite mutation (Story 1.9, AC4).
 *
 * Marked `internalMutationGeneric` deliberately: GPS-survey import
 * flows are Epic 5+ (server-to-server data migration). Exposing this
 * as a public mutation without a follow-up `requireRole(["admin"])`
 * inside the handler would let any signed-in user rewrite a lot's
 * polygon — which is a legal / dispute exposure (a corrupted lot
 * boundary becomes an ownership-dispute trigger).
 *
 * If a future story wants a user-facing "field worker re-surveyed
 * this lot from their phone" capability, that is a NEW public
 * mutation: it gates on `requireRole(["admin"])` (admins only —
 * geometry rewrites are not routine staff work), it captures a
 * `reason` argument for the audit trail, and it potentially routes
 * through a state machine (`geometryStatus: placeholder → surveyed`
 * is a transition worth modelling). All of those are out of scope
 * for this story; this internal mutation is the foundation.
 *
 * Implementation:
 *   1. `validatePolygon` (via `assertPolygonValid`) — rejects
 *      empty-but-claimed-as-surveyed, 1-or-2-vertex polygons,
 *      duplicate consecutive vertices, non-finite or out-of-range
 *      coords.
 *   2. Load the existing lot. Throws `NOT_FOUND` if missing — the
 *      caller (GPS import script) must address its own ID-resolution
 *      bugs.
 *   3. Compute the new bbox from the polygon. Compute the centroid
 *      via `polygonCentroid` UNLESS the caller supplied one — a GPS
 *      import that knows the geometric centroid via a separate
 *      computation may pass it directly to avoid the vertex-average
 *      approximation.
 *   4. Patch the lot with the new geometry + status.
 *   5. Emit an audit with the FULL before / after geometry payload.
 *      The audit emits with action `"update"` (the closest enum
 *      member to "geometry rewrite"; the canonical `AuditAction`
 *      enum in `convex/lib/audit.ts` does not yet contain a
 *      `"update_geometry"` member — adding one is an ADR
 *      amendment + audit.ts edit out of this story's scope).
 *      Audit consumers can distinguish geometry-only edits by the
 *      `before` / `after` shape (both carry a `geometry` field).
 *
 * Authentication: the audit emission requires an authenticated
 * caller. Internal mutations invoked from `ctx.runMutation(...)` in
 * a server context inherit the originating auth identity; for
 * cron / scheduled invocations (Epic 5+) the import job will run as
 * an admin service account.
 */
export const updateLotGeometry = internalMutationGeneric({
  args: {
    lotId: v.id("lots"),
    polygon: v.array(v.object({ lat: v.number(), lng: v.number() })),
    centroid: v.optional(v.object({ lat: v.number(), lng: v.number() })),
    geometryStatus: v.union(
      v.literal("placeholder"),
      v.literal("surveyed"),
    ),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      lotId: LotId;
      polygon: Polygon;
      centroid?: LatLng;
      geometryStatus: "placeholder" | "surveyed";
    },
  ): Promise<void> => {
    assertPolygonValid(args.polygon);
    // Epic 8 H1 — validate an operator-supplied centroid OVERRIDE.
    // `assertPolygonValid` only checks the polygon vertices; a bad or
    // lat/lng-swapped centroid override would be stored verbatim and
    // later drive field-worker GPS navigation to the wrong place. Same
    // Manila coordinate sanity range as the vertex check.
    if (
      args.centroid !== undefined &&
      !isCoordInManilaSanityRange(args.centroid)
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "Supplied centroid is outside the Manila coordinate sanity range — check the lat/lng order.",
        { centroidLat: args.centroid.lat, centroidLng: args.centroid.lng },
      );
    }
    const before = await ctx.db.get(args.lotId);
    if (before === null) {
      throwError(ErrorCode.NOT_FOUND, "Lot not found.", {
        lotId: args.lotId,
      });
    }
    const centroid: LatLng =
      args.centroid ??
      polygonCentroid(args.polygon, before.geometry.centroid);
    const bbox = bboxFromPolygon(args.polygon, centroid);
    const nextGeometry: LotGeometry = {
      centroid,
      polygon: args.polygon,
      ...bbox,
    };
    await ctx.db.patch(args.lotId, {
      geometry: nextGeometry,
      geometryStatus: args.geometryStatus,
    });
    await emitAudit(ctx, {
      // See JSDoc: `"update"` chosen because `AuditAction` does not yet
      // contain `"update_geometry"`. Audit readers can distinguish a
      // geometry rewrite by the `before`/`after` shape (both carry the
      // `geometry` + `geometryStatus` fields).
      action: "update",
      entityType: "lot",
      entityId: args.lotId,
      before: {
        geometry: before.geometry,
        geometryStatus: before.geometryStatus,
      },
      after: {
        geometry: nextGeometry,
        geometryStatus: args.geometryStatus,
      },
    });
  },
});

/**
 * Internal-only lookup by lot `code` (Story 8.1).
 *
 * Story 1.8 ships a `by_code` index on `lots.code` (schema.ts §
 * "Indexes") plus a private uniqueness check inside `createLot` that
 * uses that index directly. The GPS-import flow (Story 8.1, FR9 → FR10
 * P2) needs the same resolution from outside this file — given a
 * surveyor's `lotCode` string, return the existing lot doc or null.
 *
 * Internal-only (`internalQueryGeneric`) because:
 *
 *   - Lot codes are not a client-facing search surface (Story 1.10's
 *     palette uses substring matching across multiple fields and is
 *     the canonical UI for this). A public `getLotByCode` would invite
 *     callers to hard-code the lookup pattern when the search palette
 *     should be the single entry point.
 *
 *   - The audit / RBAC surface is unchanged: any caller already inside
 *     a Convex function carries its own role context, and looking up a
 *     lot by code is not itself sensitive (the schema validator already
 *     prevents `code` from carrying PII).
 *
 * Note on duplication: `convex/gpsImport.ts` carries a module-private
 * `findLotByCode(ctx, code)` helper that runs the same index query in
 * a single round-trip from inside the bulk-import mutation's loop. The
 * private helper avoids the per-item `ctx.runQuery(...)` overhead that
 * crossing the internal-query boundary would impose; this exported
 * `getLotByCode` is for OTHER server-side files that need the lookup
 * (e.g. future stories: data-subject report extensions, ownership
 * transfer pre-flight checks). The two implementations share their
 * invariant — same index, same return shape — by mechanical
 * duplication; if drift becomes a maintenance hazard, promote one of
 * them to a shared helper in `convex/lib/lots.ts` (which does not
 * exist today).
 */
export const getLotByCode = internalQueryGeneric({
  args: { code: v.string() },
  handler: async (
    ctx: QueryCtx,
    args: { code: string },
  ): Promise<LotDoc | null> => {
    return await ctx.db
      .query("lots")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .first();
  },
});
