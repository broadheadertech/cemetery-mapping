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
import { DEFAULT_CAPACITY_UNITS } from "./lib/lotCapacity";
import { layoutRow } from "./lib/rowLayout";

/**
 * The most lots one drawn line may place.
 *
 * A row, not a garden. Past this the line is almost certainly a mistake
 * — and every lot in it is a document write and an audit row.
 */
const MAX_ROW_LOTS = 200;

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type LotDoc = DataModel["lots"]["document"];
type LotId = LotDoc["_id"];
type StorageId = NonNullable<LotDoc["photoStorageId"]>;
type SectionId = DataModel["sections"]["document"]["_id"];

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
      capacityUnits: number;
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
      // Seeded from the type; an admin can adjust an individual lot
      // afterwards. Set explicitly at creation rather than left to the
      // fallback so the number is visible in the record and in audit.
      capacityUnits: DEFAULT_CAPACITY_UNITS[args.type],
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
 * Public "drop a pin" geometry setter — the Map cockpit's click-to-place
 * flow. Given a point the operator clicked on the map, place the lot
 * there: store the point as the centroid and auto-generate a footprint
 * rectangle sized from the lot's OWN dimensions, then mark it surveyed.
 *
 * This is the office-friendly counterpart to the bulk GPS import — point
 * at the map instead of typing coordinates. admin / office_staff only
 * (server-enforced). Emits the same geometry audit shape as
 * `updateLotGeometry`.
 */
/**
 * The roughest phone reading that may be saved, in metres.
 *
 * Ten graves' width. Past this a fix is not a position, it is a
 * neighbourhood — and it would sit on the map looking exactly like a
 * surveyed corner. Mirrors `MAX_USABLE_ACCURACY_M` in
 * `src/lib/gpsCapture.ts`; the browser refuses first, and this refuses
 * again because the browser is not a trust boundary.
 */
export const MAX_GPS_ACCURACY_M = 25;

export const setLotLocation = mutationGeneric({
  args: {
    lotId: v.id("lots"),
    lat: v.number(),
    lng: v.number(),
    /**
     * How this position was obtained. Defaults to `clicked`, which is
     * what every existing caller does.
     */
    source: v.optional(v.union(v.literal("clicked"), v.literal("gps"))),
    /** The radius a GPS capture claimed, in metres. */
    accuracyM: v.optional(v.number()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      lotId: LotId;
      lat: number;
      lng: number;
      source?: "clicked" | "gps";
      accuracyM?: number;
    },
  ): Promise<void> => {
    /*
     * Field workers may capture a position, but only from a phone at
     * the lot, and only where there is not already a better one.
     *
     * They are the people standing in the park — a position that has to
     * go through the office is a position nobody records. But a phone
     * fix is metres-accurate at best, and letting one overwrite an
     * imported survey would quietly downgrade measured ground to a
     * guess with no way to tell afterwards.
     *
     * The gate is the widest of the two role sets so it can be the
     * first thing this function does, then narrowed immediately below.
     */
    const caller = await requireRole(ctx, [
      "admin",
      "office_staff",
      "field_worker",
    ]);

    const source = args.source ?? "clicked";
    const isOffice = caller.roles.some(
      (r) => r === "admin" || r === "office_staff",
    );

    // Clicking a point on a map is not a thing done at the graveside.
    if (source !== "gps" && !isOffice) {
      throwError(
        ErrorCode.FORBIDDEN,
        "Setting a location from the map is office work. From the lot itself, use the GPS capture.",
        { lotId: args.lotId },
      );
    }

    if (source === "gps") {
      if (
        args.accuracyM === undefined ||
        !Number.isFinite(args.accuracyM) ||
        args.accuracyM <= 0
      ) {
        throwError(
          ErrorCode.VALIDATION,
          "A GPS capture must say how accurate it is.",
          { accuracyM: args.accuracyM ?? null },
        );
      }
      if (args.accuracyM > MAX_GPS_ACCURACY_M) {
        throwError(
          ErrorCode.VALIDATION,
          `That reading is accurate to about ${Math.round(args.accuracyM)}m, which is too rough to place a lot. Try again in the open.`,
          { accuracyM: args.accuracyM },
        );
      }
    }

    const point: LatLng = { lat: args.lat, lng: args.lng };
    if (!isCoordInManilaSanityRange(point)) {
      throwError(
        ErrorCode.VALIDATION,
        "That point is outside the cemetery's coordinate range — check the location.",
        { lat: args.lat, lng: args.lng },
      );
    }

    const before = await ctx.db.get(args.lotId);
    if (before === null) {
      throwError(ErrorCode.NOT_FOUND, "Lot not found.", { lotId: args.lotId });
    }

    // Footprint sized from the lot's real dimensions, centred on the
    // clicked point. North-aligned — the centroid is the meaningful datum
    // (drives field-worker navigation); a precise rotated outline comes
    // from a real survey import later.
    const metersPerDegLat = 111320;
    const cosLat = Math.cos((point.lat * Math.PI) / 180);
    const metersPerDegLng = 111320 * (cosLat === 0 ? 1 : cosLat);
    const dLat = before.dimensions.depthM / 2 / metersPerDegLat;
    const dLng = before.dimensions.widthM / 2 / metersPerDegLng;
    const polygon: Polygon = [
      { lat: point.lat - dLat, lng: point.lng - dLng },
      { lat: point.lat - dLat, lng: point.lng + dLng },
      { lat: point.lat + dLat, lng: point.lng + dLng },
      { lat: point.lat + dLat, lng: point.lng - dLng },
    ];
    assertPolygonValid(polygon);

    const bbox = bboxFromPolygon(polygon, point);
    const nextGeometry: LotGeometry = { centroid: point, polygon, ...bbox };

    /*
     * A phone must not overwrite a real survey.
     *
     * Imported geometry is a measured outline at a measured angle; a
     * GPS capture is a point with a radius round it. Replacing the
     * first with the second loses information that cannot be recovered,
     * and would look identical on the map afterwards.
     */
    if (
      source === "gps" &&
      before.geometrySource === "imported" &&
      !isOffice
    ) {
      throwError(
        ErrorCode.FORBIDDEN,
        "This lot has a surveyed position from a survey file. A phone reading cannot replace it — ask the office if it is wrong.",
        { lotId: args.lotId },
      );
    }

    await ctx.db.patch(args.lotId, {
      geometry: nextGeometry,
      geometryStatus: "surveyed",
      geometrySource: source,
      geometryCapturedAt: Date.now(),
      ...(source === "gps" && args.accuracyM !== undefined
        ? { geometryAccuracyM: args.accuracyM }
        : {}),
    });

    await emitAudit(ctx, {
      action: "update",
      entityType: "lot",
      entityId: args.lotId,
      before: {
        geometry: before.geometry,
        geometryStatus: before.geometryStatus,
      },
      after: { geometry: nextGeometry, geometryStatus: "surveyed" },
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

/**
 * Everything the 3D map needs, and nothing else.
 *
 * `listLots` returns whole lot documents — every field, including the
 * `geometry` blob with its polygon array and four bounding-box numbers,
 * for every lot in the park. The map reads none of that. At two
 * thousand lots it was shipping a payload measured in megabytes to draw
 * a few hundred coloured boxes.
 *
 * This returns eight scalars per lot, for the gardens actually being
 * drawn. Area comes pre-computed from `dimensions` because the client
 * should not be doing arithmetic it can be handed.
 */
export interface MapLot {
  _id: LotId;
  code: string;
  section: string;
  block: string;
  status: string;
  type: string;
  basePriceCents: number;
  /** Width × depth, in square metres, rounded to one decimal. */
  areaSqm: number;
  /** True when a photograph has been attached. */
  hasPhoto: boolean;
}

/** A garden's layout, as the map should draw it. */
export interface MapSection {
  name: string;
  displayName: string;
  sortOrder: number;
  columns: number;
  rows: number;
  tintHex: number | null;
  /** Lots actually in this garden. */
  lotCount: number;
  /**
   * True when the grid was guessed rather than configured. The map says
   * so, because a layout nobody chose should not be mistaken for one
   * somebody did.
   */
  layoutIsDerived: boolean;
}

export interface MapData {
  sections: MapSection[];
  lots: MapLot[];
}

/**
 * A square-ish grid that holds `count` lots.
 *
 * The fallback when a garden has no configured layout. It is a guess,
 * and it is flagged as one — but drawing a garden in a sensible shape
 * beats drawing nothing while somebody goes and configures it.
 */
export function deriveGrid(count: number): {
  columns: number;
  rows: number;
} {
  if (count <= 0) return { columns: 1, rows: 1 };
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / columns));
  return { columns, rows };
}

/** Square metres from a lot's dimensions, to one decimal. */
export function areaOf(dimensions: {
  widthM: number;
  depthM: number;
}): number {
  const w = Number.isFinite(dimensions.widthM) ? dimensions.widthM : 0;
  const d = Number.isFinite(dimensions.depthM) ? dimensions.depthM : 0;
  return Math.round(w * d * 10) / 10;
}

/**
 * A garden registry keyed by every name a lot might store.
 *
 * A section is written down twice: `name` is a kebab-case identifier
 * ("garden-of-peace") and `displayName` is the label ("Garden of
 * Peace"). A lot stores neither — the lot form resolves the chosen
 * section and writes its DISPLAY name into the `section` column.
 *
 * Keying on `name` alone matched nothing for any real lot, so every
 * garden reported its layout as guessed and configuring one appeared to
 * save and then change nothing, forever, with no error to explain it.
 *
 * Both keys, and one function, so the map and the setup walkthrough
 * cannot drift apart on what counts as a match.
 */
export function sectionsByLotName<
  T extends { name: string; displayName: string; isRetired: boolean },
>(registry: readonly T[]): Map<string, T> {
  const byName = new Map<string, T>();
  for (const row of registry) {
    if (row.isRetired) continue;
    byName.set(row.name, row);
    byName.set(row.displayName, row);
  }
  return byName;
}

/**
 * The map's data, in one read.
 *
 * Field workers may run it — the map is how somebody finds a grave on
 * the ground, which is their job more than anybody's.
 */
export const listForMap = queryGeneric({
  args: {
    /** Gardens to draw. Omitted means every garden with lots in it. */
    sectionNames: v.optional(v.array(v.string())),
  },
  handler: async (
    ctx: QueryCtx,
    args: { sectionNames?: string[] },
  ): Promise<MapData> => {
    await requireRole(ctx, ["admin", "office_staff", "field_worker"]);

    const wanted =
      args.sectionNames !== undefined && args.sectionNames.length > 0
        ? new Set(args.sectionNames)
        : null;

    const allLots = await ctx.db.query("lots").collect();
    const live = allLots.filter(
      (l) => !l.isRetired && (wanted === null || wanted.has(l.section)),
    );

    const lots: MapLot[] = live
      .map((l) => ({
        _id: l._id,
        code: l.code,
        section: l.section,
        block: l.block,
        status: l.status,
        type: l.type,
        basePriceCents: l.basePriceCents,
        areaSqm: areaOf(l.dimensions),
        hasPhoto: l.photoStorageId !== undefined,
      }))
      // Code order is the layout order — the map fills its grid from
      // this list, so the sort here IS the arrangement on screen.
      .sort((a, b) => a.code.localeCompare(b.code));

    const counts = new Map<string, number>();
    for (const l of lots) {
      counts.set(l.section, (counts.get(l.section) ?? 0) + 1);
    }

    const registry = await ctx.db.query("sections").collect();
    const byName = sectionsByLotName(registry);

    const sections: MapSection[] = [...counts.entries()].map(
      ([name, lotCount]) => {
        const row = byName.get(name);
        const configured =
          row?.gridColumns !== undefined && row.gridRows !== undefined;
        const grid = configured
          ? { columns: row.gridColumns as number, rows: row.gridRows as number }
          : deriveGrid(lotCount);
        return {
          name,
          displayName: row?.displayName ?? name,
          sortOrder: row?.sortOrder ?? 0,
          columns: grid.columns,
          rows: grid.rows,
          tintHex: row?.tintHex ?? null,
          lotCount,
          layoutIsDerived: !configured,
        };
      },
    );
    sections.sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
    );

    return { sections, lots };
  },
});

/**
 * One lot, in the detail the map's side panel shows.
 *
 * Split from the list on purpose: a photograph URL per lot, fetched for
 * every lot in the park, would undo the whole point of the light list.
 * This is read when somebody actually clicks something.
 */
export interface MapLotDetail {
  _id: LotId;
  code: string;
  section: string;
  block: string;
  row: string;
  status: string;
  type: string;
  basePriceCents: number;
  areaSqm: number;
  widthM: number;
  depthM: number;
  /** Where it is, for anybody trying to find it on the ground. */
  lat: number | null;
  lng: number | null;
  geometryStatus: string;
  photoUrl: string | null;
  photoUpdatedAt: number | null;
}

export const getMapLotDetail = queryGeneric({
  args: { lotId: v.id("lots") },
  handler: async (
    ctx: QueryCtx,
    args: { lotId: LotId },
  ): Promise<MapLotDetail | null> => {
    await requireRole(ctx, ["admin", "office_staff", "field_worker"]);

    const lot = await ctx.db.get(args.lotId);
    if (lot === null) return null;

    const centroid = lot.geometry.centroid;
    // A placeholder centroid is a stand-in written at lot creation, not
    // a position anybody measured. Reporting it as a location would
    // send somebody to the wrong part of the park with confidence.
    const surveyed = lot.geometryStatus === "surveyed";

    return {
      _id: lot._id,
      code: lot.code,
      section: lot.section,
      block: lot.block,
      row: lot.row,
      status: lot.status,
      type: lot.type,
      basePriceCents: lot.basePriceCents,
      areaSqm: areaOf(lot.dimensions),
      widthM: lot.dimensions.widthM,
      depthM: lot.dimensions.depthM,
      lat: surveyed ? centroid.lat : null,
      lng: surveyed ? centroid.lng : null,
      geometryStatus: lot.geometryStatus,
      photoUrl:
        lot.photoStorageId !== undefined
          ? await ctx.storage.getUrl(lot.photoStorageId)
          : null,
      photoUpdatedAt: lot.photoUpdatedAt ?? null,
    };
  },
});

/** A one-time URL to POST a lot photograph to. */
export const generateLotPhotoUploadUrl = mutationGeneric({
  args: {},
  handler: async (ctx: MutationCtx): Promise<string> => {
    // Field workers take these. They are standing at the lot.
    await requireRole(ctx, ["admin", "office_staff", "field_worker"]);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Attach a photograph to a lot, replacing any previous one.
 *
 * The old blob is deleted rather than orphaned. A lot has one
 * representative picture; keeping every superseded attempt would fill
 * storage with images nothing references and nobody can find.
 */
export const setLotPhoto = mutationGeneric({
  args: { lotId: v.id("lots"), storageId: v.id("_storage") },
  handler: async (
    ctx: MutationCtx,
    args: { lotId: LotId; storageId: StorageId },
  ): Promise<{ lotId: LotId }> => {
    const auth = await requireRole(ctx, [
      "admin",
      "office_staff",
      "field_worker",
    ]);

    const lot = await ctx.db.get(args.lotId);
    if (lot === null) {
      throwError(ErrorCode.NOT_FOUND, "Lot not found.", { lotId: args.lotId });
    }
    if (lot.isRetired) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "This lot has been retired.",
        { lotId: args.lotId },
      );
    }

    const previous = lot.photoStorageId;
    await ctx.db.patch(args.lotId, {
      photoStorageId: args.storageId,
      photoUpdatedAt: Date.now(),
    });
    if (previous !== undefined && previous !== args.storageId) {
      await ctx.storage.delete(previous);
    }

    await emitAudit(ctx, {
      action: "update",
      entityType: "lot",
      entityId: args.lotId,
      after: { photoStorageId: args.storageId as unknown as string },
      reason: `Photograph attached to lot ${lot.code}`,
    });
    void auth;

    return { lotId: args.lotId };
  },
});

/**
 * Where each garden stands in getting itself onto the 3D map.
 *
 * Building the map means six things across six screens — create the
 * garden, set its arrangement, add its lots, look at it, photograph
 * them, place them. Doing that by tab-hopping means holding in your
 * head which gardens you have already done, which is exactly the thing
 * a computer should be holding for you.
 *
 * So: one row per garden, counted rather than claimed. Every garden the
 * registry knows about, INCLUDING the empty ones — those are the whole
 * point, since a garden with no lots is invisible to `listForMap` and
 * would otherwise be the one you forget.
 */
export interface MapSetupSection {
  sectionId: SectionId;
  name: string;
  displayName: string;
  sortOrder: number;
  kind: string;
  /** The configured arrangement, or null when nobody has set one. */
  gridColumns: number | null;
  gridRows: number | null;
  /** Live lots in this garden. */
  lotCount: number;
  /** How many of them carry a photograph. */
  photoCount: number;
  /** How many have a measured position rather than a placeholder. */
  surveyedCount: number;
}

export interface MapSetupProgress {
  sections: MapSetupSection[];
  /**
   * Lots whose `section` string matches no garden in the registry.
   *
   * These are real lots that the map cannot draw and cannot lay out —
   * usually a legacy import written before the garden existed, or a
   * renamed garden that left its lots behind. Silence here would be the
   * worst outcome: the lots exist, the map omits them, and nothing
   * anywhere says why.
   */
  orphanSections: Array<{ section: string; lotCount: number }>;
  totals: {
    sectionCount: number;
    laidOutCount: number;
    lotCount: number;
    photoCount: number;
    surveyedCount: number;
  };
}

export const mapSetupProgress = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<MapSetupProgress> => {
    await requireRole(ctx, ["admin"]);

    const registry = (await ctx.db.query("sections").collect()).filter(
      (s) => !s.isRetired,
    );
    const lots = (await ctx.db.query("lots").collect()).filter(
      (l) => !l.isRetired,
    );

    // Tally against the same matcher the map draws with, so a garden
    // reported as ready here is a garden the map can actually place.
    const byName = sectionsByLotName(registry);
    const tally = new Map<
      string,
      { lots: number; photos: number; surveyed: number }
    >();
    const orphans = new Map<string, number>();

    for (const l of lots) {
      const row = byName.get(l.section);
      if (row === undefined) {
        orphans.set(l.section, (orphans.get(l.section) ?? 0) + 1);
        continue;
      }
      const key = row.name;
      const t = tally.get(key) ?? { lots: 0, photos: 0, surveyed: 0 };
      t.lots += 1;
      if (l.photoStorageId !== undefined) t.photos += 1;
      if (l.geometryStatus === "surveyed") t.surveyed += 1;
      tally.set(key, t);
    }

    const sections: MapSetupSection[] = registry
      .map((s) => {
        const t = tally.get(s.name) ?? { lots: 0, photos: 0, surveyed: 0 };
        return {
          sectionId: s._id,
          name: s.name,
          displayName: s.displayName,
          sortOrder: s.sortOrder,
          kind: s.kind,
          gridColumns: s.gridColumns ?? null,
          gridRows: s.gridRows ?? null,
          lotCount: t.lots,
          photoCount: t.photos,
          surveyedCount: t.surveyed,
        };
      })
      .sort(
        (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
      );

    return {
      sections,
      orphanSections: [...orphans.entries()]
        .map(([section, lotCount]) => ({ section, lotCount }))
        .sort((a, b) => b.lotCount - a.lotCount),
      totals: {
        sectionCount: sections.length,
        laidOutCount: sections.filter(
          (s) => s.gridColumns !== null && s.gridRows !== null,
        ).length,
        lotCount: sections.reduce((n, s) => n + s.lotCount, 0),
        photoCount: sections.reduce((n, s) => n + s.photoCount, 0),
        surveyedCount: sections.reduce((n, s) => n + s.surveyedCount, 0),
      },
    };
  },
});

/**
 * The lots that have actually been surveyed, with their real shapes.
 *
 * A grid cannot draw an irregular garden honestly. Curved edges, angled
 * rows, blocks that do not line up — every grid option still puts
 * squares in straight lines, and a garden drawn in the wrong shape
 * looks exactly as confident on the map as one drawn right. That is
 * worse than not drawing it, because somebody trusts it.
 *
 * So this is the other path: `/admin/gps-import` already accepts
 * `{ lotCode, polygon }` batches and flips a lot to `surveyed` with its
 * measured footprint. The truth was importable and the map simply did
 * not draw it.
 *
 * Deliberately NOT folded into `listForMap`. That query's whole point
 * is that it ships no geometry — a polygon per lot, for two thousand
 * lots, to draw boxes positioned on a grid. When the map is drawing the
 * polygons they are the payload rather than waste, but the two cases
 * are different enough to be different reads, so a gridded park never
 * pays for geometry it does not use.
 */
export interface SurveyedMapLot {
  _id: LotId;
  code: string;
  section: string;
  block: string;
  status: string;
  type: string;
  basePriceCents: number;
  areaSqm: number;
  hasPhoto: boolean;
  /** The measured centre. */
  lat: number;
  lng: number;
  /** The measured footprint. Empty when only a centre was recorded. */
  polygon: Array<{ lat: number; lng: number }>;
}

/** How much of a garden has actually been placed. */
export interface SurveyedMapSection {
  name: string;
  displayName: string;
  sortOrder: number;
  placedCount: number;
  unplacedCount: number;
  /**
   * A few of the unplaced codes, to make the gap concrete.
   *
   * Capped rather than complete: a garden with 400 unplaced lots does
   * not need to ship 400 strings to make the point, and the count above
   * is the honest total.
   */
  unplacedSample: string[];
}

export interface SurveyedMapData {
  lots: SurveyedMapLot[];
  sections: SurveyedMapSection[];
  /** The park's centre, for projecting everything into local metres. */
  origin: { lat: number; lng: number } | null;
}

/** Unplaced codes shown per garden before the count has to speak for itself. */
export const UNPLACED_SAMPLE_LIMIT = 8;

export const listSurveyedForMap = queryGeneric({
  args: {
    sectionNames: v.optional(v.array(v.string())),
  },
  handler: async (
    ctx: QueryCtx,
    args: { sectionNames?: string[] },
  ): Promise<SurveyedMapData> => {
    await requireRole(ctx, ["admin", "office_staff", "field_worker"]);

    const wanted =
      args.sectionNames !== undefined && args.sectionNames.length > 0
        ? new Set(args.sectionNames)
        : null;

    const live = (await ctx.db.query("lots").collect()).filter(
      (l) => !l.isRetired && (wanted === null || wanted.has(l.section)),
    );

    const lots: SurveyedMapLot[] = [];
    const placed = new Map<string, number>();
    const unplaced = new Map<string, string[]>();
    const unplacedTotal = new Map<string, number>();

    for (const l of live) {
      // "surveyed" is the only status that means somebody measured it.
      // A placeholder centroid is written at lot creation and points at
      // the middle of the park; drawing on it would scatter every
      // unplaced lot into one heap and call it a survey.
      const centroid = l.geometry?.centroid;
      if (l.geometryStatus !== "surveyed" || centroid === undefined) {
        unplacedTotal.set(l.section, (unplacedTotal.get(l.section) ?? 0) + 1);
        const sample = unplaced.get(l.section) ?? [];
        if (sample.length < UNPLACED_SAMPLE_LIMIT) sample.push(l.code);
        unplaced.set(l.section, sample);
        continue;
      }
      placed.set(l.section, (placed.get(l.section) ?? 0) + 1);
      lots.push({
        _id: l._id,
        code: l.code,
        section: l.section,
        block: l.block,
        status: l.status,
        type: l.type,
        basePriceCents: l.basePriceCents,
        areaSqm: areaOf(l.dimensions),
        hasPhoto: l.photoStorageId !== undefined,
        lat: centroid.lat,
        lng: centroid.lng,
        polygon: (l.geometry?.polygon ?? []).map((p) => ({
          lat: p.lat,
          lng: p.lng,
        })),
      });
    }

    lots.sort((a, b) => a.code.localeCompare(b.code));

    const registry = await ctx.db.query("sections").collect();
    const byName = sectionsByLotName(registry);

    const names = new Set<string>([
      ...placed.keys(),
      ...unplacedTotal.keys(),
    ]);
    const sections: SurveyedMapSection[] = [...names]
      .map((name) => {
        const row = byName.get(name);
        return {
          name,
          displayName: row?.displayName ?? name,
          sortOrder: row?.sortOrder ?? 0,
          placedCount: placed.get(name) ?? 0,
          unplacedCount: unplacedTotal.get(name) ?? 0,
          unplacedSample: unplaced.get(name) ?? [],
        };
      })
      .sort(
        (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
      );

    // The centre of what was actually measured, so the scene is built
    // around real lots rather than around a park bounding box that
    // includes ground nobody has surveyed.
    const origin =
      lots.length === 0
        ? null
        : {
            lat: lots.reduce((n, l) => n + l.lat, 0) / lots.length,
            lng: lots.reduce((n, l) => n + l.lng, 0) / lots.length,
          };

    return { lots, sections, origin };
  },
});

/**
 * Take back a position.
 *
 * There was no way to do this at all. A lot could be placed by an
 * import, a click or a phone, and once placed it was placed — a bad
 * import, a mis-click, a GPS fix taken beside a wall, all permanent.
 * The only recourse was to place it somewhere else, which replaces one
 * assertion with another rather than withdrawing the first.
 *
 * "Not surveyed" is a real and useful state. It is what every lot
 * starts in, it is what the map and the lot page both say plainly, and
 * it is strictly better than a coordinate nobody trusts: the map leaves
 * the lot out of the surveyed view and says how many it is not showing,
 * instead of drawing it confidently in the wrong place.
 *
 * Office work, not field work. A field worker who thinks their own
 * reading was poor can simply take another; withdrawing a position
 * outright is a decision about the record.
 */
export const clearLotLocation = mutationGeneric({
  args: { lotId: v.id("lots") },
  handler: async (ctx: MutationCtx, args: { lotId: LotId }): Promise<void> => {
    await requireRole(ctx, ["admin", "office_staff"]);

    const before = await ctx.db.get(args.lotId);
    if (before === null) {
      throwError(ErrorCode.NOT_FOUND, "Lot not found.", { lotId: args.lotId });
    }
    if (before.geometryStatus !== "surveyed") {
      throwError(
        ErrorCode.VALIDATION,
        "This lot has no position to remove.",
        { lotId: args.lotId },
      );
    }

    // Back to the same stand-in a new lot is created with, so nothing
    // downstream has to cope with geometry being absent.
    const geometry = getDefaultPlaceholderGeometry({
      section: before.section,
    });

    await ctx.db.patch(args.lotId, {
      geometry,
      geometryStatus: "placeholder",
      geometrySource: undefined,
      geometryAccuracyM: undefined,
      geometryCapturedAt: undefined,
    });

    await emitAudit(ctx, {
      action: "update",
      entityType: "lot",
      entityId: args.lotId,
      before: {
        geometryStatus: before.geometryStatus,
        geometrySource: before.geometrySource ?? null,
        lat: before.geometry?.centroid.lat ?? null,
        lng: before.geometry?.centroid.lng ?? null,
      },
      after: { geometryStatus: "placeholder" },
    });
  },
});

/**
 * Place a whole row of lots along a line somebody drew.
 *
 * The practical way to map an irregular park by hand. A cemetery is
 * rows of near-identical plots, so the useful unit of work is not one
 * lot — it is "this row, from here to here". Two clicks place twenty
 * graves at real coordinates, at the real angle the row runs, which no
 * grid can express and which twenty separate GPS captures would take an
 * afternoon to collect.
 *
 * The lots keep their own recorded widths: the drawn line supplies the
 * row's START and BEARING, not its spacing. Stretching plots to fill
 * whatever line got drawn would always look tidy and would make the map
 * misstate how big a grave is.
 *
 * Order matters and is the caller's: `lotIds` are laid out in the order
 * given, which is the order they will sit on the ground.
 */
export const placeLotRow = mutationGeneric({
  args: {
    lotIds: v.array(v.id("lots")),
    start: v.object({ lat: v.number(), lng: v.number() }),
    end: v.object({ lat: v.number(), lng: v.number() }),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      lotIds: LotId[];
      start: { lat: number; lng: number };
      end: { lat: number; lng: number };
    },
  ): Promise<{ placed: number }> => {
    await requireRole(ctx, ["admin", "office_staff"]);

    if (args.lotIds.length === 0) {
      throwError(ErrorCode.VALIDATION, "Choose at least one lot to place.", {});
    }
    if (args.lotIds.length > MAX_ROW_LOTS) {
      throwError(
        ErrorCode.VALIDATION,
        `That is ${args.lotIds.length} lots in one row. Rows are drawn a row at a time — split it.`,
        { given: args.lotIds.length },
      );
    }
    for (const p of [args.start, args.end]) {
      if (!isCoordInManilaSanityRange(p)) {
        throwError(
          ErrorCode.VALIDATION,
          "That line is outside the cemetery's coordinate range — check where you drew it.",
          { lat: p.lat, lng: p.lng },
        );
      }
    }

    // Duplicates would place the same lot twice and silently drop
    // another from the row.
    if (new Set(args.lotIds).size !== args.lotIds.length) {
      throwError(
        ErrorCode.VALIDATION,
        "The same lot appears twice in that row.",
        {},
      );
    }

    const lots = [];
    for (const id of args.lotIds) {
      const lot = await ctx.db.get(id);
      if (lot === null) {
        throwError(ErrorCode.NOT_FOUND, "One of those lots is not there.", {
          lotId: id,
        });
      }
      if (lot.isRetired) {
        throwError(
          ErrorCode.VALIDATION,
          `Lot ${lot.code} is retired and cannot be placed.`,
          { lotId: id },
        );
      }
      lots.push(lot);
    }

    const layout = layoutRow(
      args.start,
      args.end,
      lots.map((l) => l.dimensions),
    );

    const now = Date.now();
    for (let i = 0; i < lots.length; i++) {
      const lot = lots[i]!;
      const place = layout.placements[i]!;
      // Every corner is checked, not just the line's ends: a row drawn
      // at the very edge of the park can put a plot outside it.
      assertPolygonValid(place.polygon);
      const bbox = bboxFromPolygon(place.polygon, place.centroid);

      await ctx.db.patch(lot._id, {
        geometry: { centroid: place.centroid, polygon: place.polygon, ...bbox },
        geometryStatus: "surveyed",
        geometrySource: "drawn",
        geometryCapturedAt: now,
        geometryAccuracyM: undefined,
      });

      await emitAudit(ctx, {
        action: "update",
        entityType: "lot",
        entityId: lot._id,
        before: {
          geometryStatus: lot.geometryStatus,
          geometrySource: lot.geometrySource ?? null,
        },
        after: {
          geometryStatus: "surveyed",
          geometrySource: "drawn",
          rowPosition: i + 1,
        },
      });
    }

    return { placed: lots.length };
  },
});

/**
 * Every lot in one garden, in code order, with whether it is placed.
 *
 * What the row-drawing screen picks from. Code order because that is the
 * order a row runs — somebody drawing "A-1-01 through A-1-20" is
 * selecting a contiguous run, and any other ordering makes that
 * selection meaningless.
 */
export interface RowCandidate {
  _id: LotId;
  code: string;
  block: string;
  row: string;
  status: string;
  type: string;
  widthM: number;
  depthM: number;
  placed: boolean;
  /** How it was placed, when it has been. */
  source: string | null;
}

export const listForRowDrawing = queryGeneric({
  args: { sectionName: v.string() },
  handler: async (
    ctx: QueryCtx,
    args: { sectionName: string },
  ): Promise<RowCandidate[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);

    return (await ctx.db.query("lots").collect())
      .filter((l) => !l.isRetired && l.section === args.sectionName)
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((l) => ({
        _id: l._id,
        code: l.code,
        block: l.block,
        row: l.row,
        status: l.status,
        type: l.type,
        widthM: l.dimensions.widthM,
        depthM: l.dimensions.depthM,
        placed: l.geometryStatus === "surveyed",
        source: l.geometrySource ?? null,
      }));
  },
});
