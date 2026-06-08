import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

/**
 * Canonical data model for cemetery-mapping.
 *
 * Phase 1:
 *   - Convex Auth `authTables` (Story 1.1) — owns `users`, `authSessions`,
 *     `authAccounts`, etc. Do not write to these directly EXCEPT through
 *     the `users` extension below.
 *   - `userRoles` (Story 1.2) — separates RBAC from Auth.js's internal
 *     user shape. One row per role per user. A user can hold multiple
 *     roles (FR3); `requireRole` accepts the union.
 *
 * Users-table extension (Story 1.3, FR2 / FR3):
 *   `authTables.users` ships with `name`, `email`, etc. as OPTIONAL
 *   fields. Story 1.3 promotes `name` to required and adds operational
 *   fields:
 *     - `isActive` — soft-deactivation flag; `requireAuth` rejects users
 *       with `isActive: false` so deactivation takes effect on the
 *       caller's next request. See ADR-0005.
 *     - `createdAt` / `createdBy` — admin-attribution trail. `createdBy`
 *       is optional because the seed admin (Story 1.1's `convex/seed.ts`)
 *       has no creator.
 *   We re-declare `users` AFTER `...authTables` so the override wins.
 *   The Convex-Auth-provided indexes (`email`, `phone`) are re-asserted
 *   here so account-lookup keeps working; we add `by_active` for the
 *   admin user list.
 *
 * Domain tables (lots, customers, contracts, payments, receipts, etc.)
 * are added incrementally per their respective stories — see the
 * architecture's "schema gets built incrementally" principle.
 */
export default defineSchema({
  ...authTables,
  users: defineTable({
    // Convex-Auth-provided fields, repeated verbatim so the override
    // table is a strict superset of `authTables.users.validator`.
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    // Story 1.3 extensions — every NEW user created via
    // `convex/users.ts:createUser` writes these; the Story 1.1 seed
    // admin backfills them in its own mutation. Existing rows
    // pre-1.3 (none in production yet) would need a migration if any
    // exist — covered by ADR-0005.
    isActive: v.optional(v.boolean()),
    createdAt: v.optional(v.number()),
    createdBy: v.optional(v.id("users")),
  })
    .index("email", ["email"])
    .index("phone", ["phone"])
    .index("by_active", ["isActive"]),
  userRoles: defineTable({
    userId: v.id("users"),
    role: v.union(
      v.literal("admin"),
      v.literal("office_staff"),
      v.literal("field_worker"),
      v.literal("customer"),
    ),
    grantedAt: v.number(),
    grantedBy: v.id("users"),
  }).index("by_user", ["userId"]),

  /**
   * Append-only audit log (Story 1.6, FR59, NFR-S7).
   *
   * Every financial-touching mutation MUST emit a row here via the
   * `emitAudit` helper in `convex/lib/audit.ts` — direct
   * `ctx.db.insert("auditLog", ...)` calls are blocked at lint time by
   * the `local-rules/no-audit-log-direct-write` rule, and any attempt to
   * `patch` / `replace` / `delete` a row is blocked by
   * `local-rules/no-audit-log-mutation`. Convex has no DB-level
   * append-only constraint; lint + helper + tests are the enforcement.
   *
   * Field notes:
   *   - `entityId` is `v.string()`, not `v.id(...)`, because the log is
   *     polymorphic across many tables (lot, customer, contract, ...).
   *     Convex's `v.id(table)` only binds one table; `entityType` is the
   *     discriminator on read.
   *   - `before` / `after` are `v.any()` JSON blobs, PII-redacted at
   *     WRITE time by `redactPii` inside `emitAudit`. Redaction at write
   *     keeps the at-rest data safe even when an admin reads the log;
   *     redaction-at-read would expose PII to the read path.
   *   - `before` and `after` are both optional — `create` has no
   *     `before`, `delete` has no `after`.
   *   - `reason` is free-text from the operator; the UI guidance for
   *     stories 1.8+ instructs users NOT to paste sensitive data here.
   *
   * Indexes:
   *   - `by_entity` for FR47 "show me everything that happened to lot
   *     #1234" queries.
   *   - `by_actor` for "what did user X do last week" admin reviews.
   *   - `by_timestamp` for the global activity feed.
   */
  auditLog: defineTable({
    actor: v.id("users"),
    timestamp: v.number(),
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
      // Story 1.15 H6 — section CRUD events now have a first-class
      // entityType so `by_entity` lookups surface section history. Prior
      // rows were emitted with `entityType: "lot"` + `entityId: <sectionId>`
      // and remain readable via `by_entity` queries on those legacy ids;
      // no migration required because the read path is additive.
      v.literal("section"),
      // Additive (Stories 2.9, 7.5, 6.8) — parallel agents will land
      // entityType-correct audit emits for these aggregates; reserving
      // the literals now keeps the schema deploy independent of the
      // mutation work in their stories.
      v.literal("family_estate"),
      v.literal("ceremony"),
      v.literal("plaque_draft"),
    ),
    entityId: v.string(),
    before: v.optional(v.any()),
    after: v.optional(v.any()),
    reason: v.optional(v.string()),
  })
    .index("by_entity", ["entityType", "entityId", "timestamp"])
    .index("by_actor", ["actor", "timestamp"])
    .index("by_timestamp", ["timestamp"]),

  /**
   * Lot inventory table (Story 1.8, FR6 / FR8 / FR10).
   *
   * Central inventory entity that every downstream domain depends on
   * (Story 1.9 geometry refinement, 1.10 search palette, 1.11 detail
   * page, 1.12 map, every Epic 2+ contract / sale / payment).
   *
   * Naming conventions (architecture § Naming Patterns):
   *   - `basePriceCents` — money fields end in `Cents`. INTEGER ONLY
   *     (no decimal pesos; see ADR-0007 for the rationale).
   *   - `isRetired` — boolean with `is` prefix.
   *   - `createdAt` — timestamp ends in `At` (epoch ms).
   *   - `createdBy` — actor reference (`Id<"users">`).
   *
   * Geometry (Story 1.9):
   *   Schema-ready from day one (architectural commitment). Story 1.8
   *   inserts a placeholder centroid + degenerate polygon so the Phase
   *   1 SVG renderer has data to draw; Story 1.9 will refine the
   *   defaults, validate vertex shapes, and seed the `by_bbox_lat`
   *   index with real values for viewport queries.
   *
   * Indexes:
   *   - `by_status` — status filter on `/lots` list.
   *   - `by_section_block` — section-scoped filter (FR8 lot detail
   *     siblings; later "lots in section D" queries).
   *   - `by_code` — manual uniqueness check inside `createLot`
   *     (Convex has no UNIQUE index; the query speeds the check up).
   *   - `by_bbox_lat` — placeholder for Story 1.9's viewport query;
   *     populated when geometry hydrates from real survey data.
   */
  lots: defineTable({
    code: v.string(),
    section: v.string(),
    /**
     * Story 1.15 — additive FK to the new `sections` registry.
     *
     * Phase 1 keeps the legacy free-text `section` field alongside this
     * optional reference so the migration is a two-step process: (1)
     * deploy this story, (2) run the backfill mutation which populates
     * `sectionId` for every lot from the free-text `section` value.
     * Once Phase 2 is comfortable that no callers read `section`
     * directly, a follow-up story drops the string column. Until then,
     * the form writes `sectionId` AND the matching `section` string so
     * Story 1.8's existing `by_section_block` index queries continue to
     * function unchanged.
     */
    sectionId: v.optional(v.id("sections")),
    block: v.string(),
    row: v.string(),
    type: v.union(
      v.literal("single"),
      v.literal("family"),
      v.literal("mausoleum"),
      v.literal("niche"),
    ),
    dimensions: v.object({
      widthM: v.number(),
      depthM: v.number(),
    }),
    basePriceCents: v.number(),
    status: v.union(
      v.literal("available"),
      v.literal("reserved"),
      v.literal("sold"),
      v.literal("occupied"),
      v.literal("cancelled"),
      v.literal("defaulted"),
      v.literal("transferred"),
    ),
    geometry: v.object({
      centroid: v.object({ lat: v.number(), lng: v.number() }),
      polygon: v.array(v.object({ lat: v.number(), lng: v.number() })),
      bboxMinLat: v.number(),
      bboxMaxLat: v.number(),
      bboxMinLng: v.number(),
      bboxMaxLng: v.number(),
    }),
    geometryStatus: v.union(
      v.literal("placeholder"),
      v.literal("surveyed"),
    ),
    isRetired: v.boolean(),
    createdAt: v.number(),
    createdBy: v.id("users"),
  })
    .index("by_status", ["status"])
    .index("by_section_block", ["section", "block"])
    .index("by_sectionId", ["sectionId"])
    .index("by_code", ["code"])
    .index("by_bbox_lat", ["geometry.bboxMinLat", "geometry.bboxMaxLat"]),

  /**
   * Named sections registry (Story 1.15 — FR3 brand-tier extension).
   *
   * Promotes the free-text `lots.section` string (Story 1.8) into a
   * first-class registry table so admins can maintain wayfinding-grade
   * names (e.g. "Chapel of Grace", "Section A · North", "Columbarium",
   * "Family Estates · East") with a stable identifier, sort order, and
   * descriptive copy.
   *
   * Phase 1 keeps the legacy `lots.section` string column alive in
   * parallel — the additive `lots.sectionId` optional FK is populated
   * by the backfill mutation (`convex/internal/backfillLotSections.ts`)
   * which derives section rows from the distinct free-text values. A
   * follow-up deploy drops the string column once the backfill is
   * verified in production.
   *
   * Field notes:
   *   - `name` — canonical kebab-case identifier (e.g. "section-a-north")
   *     unique across the registry. The create / update mutation
   *     enforces uniqueness via the `by_name` index — Convex does not
   *     support DB-level UNIQUE constraints, so the check is a
   *     pre-insert lookup.
   *   - `displayName` — human-readable wayfinding label (e.g. "Section
   *     A · North"). What the customer sees on signage and in the
   *     consecration letter.
   *   - `sortOrder` — admin-controlled ordering. The migration seeds
   *     `index * 10` so future inserts can land at decimal increments
   *     between existing rows without re-numbering.
   *   - `kind` — five-literal union mapped to the brand guide's
   *     Chapter VII wayfinding categories (chapel / family / standard /
   *     niche / columbarium).
   *   - `descriptionMarkdown` — optional long-form description (1–3
   *     paragraphs) for future surfaces like the customer portal or
   *     brochure. Stored verbatim; markdown is rendered downstream.
   *   - `geometryBoundsBox` — optional reservation for Story 8.1 (GPS
   *     import) to populate. Phase 1 admin form persists what the
   *     admin types; null is the expected initial state for most rows.
   *   - `isRetired` — soft-delete flag. Retired sections stay
   *     queryable so historical lot references continue to render
   *     correctly; the LotForm dropdown hides them from new selections.
   *
   * Indexes:
   *   - `by_name` — uniqueness enforcement on create / update + the
   *     backfill migration's "have we already created this section?"
   *     lookup.
   *   - `by_kind` — admin filter on the registry list.
   *   - `by_sortOrder` — list ordering for the admin page + the
   *     LotForm dropdown.
   *
   * Audit pattern: every mutation emits via `emitAudit` with
   * `entityType: "section"` (Story 1.15 H6 adversarial review added the
   * dedicated literal to the `auditLog.entityType` union so per-section
   * `by_entity` lookups surface section CRUD events directly). The
   * `before` / `after` payload carries the per-section detail.
   */
  sections: defineTable({
    name: v.string(),
    displayName: v.string(),
    sortOrder: v.number(),
    kind: v.union(
      v.literal("chapel"),
      v.literal("family"),
      v.literal("standard"),
      v.literal("niche"),
      v.literal("columbarium"),
    ),
    descriptionMarkdown: v.optional(v.string()),
    geometryBoundsBox: v.optional(
      v.object({
        minLat: v.number(),
        maxLat: v.number(),
        minLng: v.number(),
        maxLng: v.number(),
      }),
    ),
    isRetired: v.boolean(),
    createdAt: v.number(),
    createdBy: v.id("users"),
  })
    .index("by_name", ["name"])
    .index("by_kind", ["kind"])
    .index("by_sortOrder", ["sortOrder"]),

  /**
   * Development phases — the cemetery's build-out parcels (Phase Planning
   * feature; ADR-0008 frames a "phase" as a development parcel containing
   * several sections/gardens, NOT a single garden).
   *
   * One row per parcel (Phase 1 / 2 / 3 …). A phase owns a set of named
   * sections (`sectionsLabel` is the human-readable roll-up; the canonical
   * section→phase mapping stays in the `sections` registry as that grows).
   * The runway readout on `/phase-planning` is computed from
   * `availableLotCount / monthlyAbsorption`, so both are stored on the row
   * and updated by operations as surveys complete and lots sell.
   *
   * `readiness` carries the next-phase preparation checklist inline — it is
   * per-phase planning state with no cross-row queries, so an embedded
   * array (rather than a child table) keeps the read a single `get`.
   *
   * Reference content that is NOT data — the 6-step "how to map a phase"
   * playbook — lives in `src/app/(staff)/phase-planning/playbook.ts`; it is
   * editorial guidance, not per-tenant state.
   */
  phases: defineTable({
    number: v.number(),
    name: v.string(),
    sectionsLabel: v.string(),
    // Free-text `lots.section` names this parcel owns. When present and
    // matching real lot rows, `getPhasePlanningOverview` computes the
    // runway from live inventory; otherwise it falls back to the stored
    // `plannedLotCount` / `availableLotCount` below. Optional so adding
    // it does not invalidate phase rows seeded before this field existed.
    sectionNames: v.optional(v.array(v.string())),
    stage: v.union(
      v.literal("live"),
      v.literal("surveying"),
      v.literal("planned"),
    ),
    plannedLotCount: v.number(),
    availableLotCount: v.number(),
    monthlyAbsorption: v.number(),
    surveyLeadWeeks: v.number(),
    projectedSelloutLabel: v.optional(v.string()),
    readyByLabel: v.optional(v.string()),
    readiness: v.array(
      v.object({
        label: v.string(),
        area: v.string(),
        status: v.union(
          v.literal("completed"),
          v.literal("scheduled"),
          v.literal("current"),
        ),
      }),
    ),
    isRetired: v.boolean(),
    createdAt: v.number(),
    createdBy: v.id("users"),
  }).index("by_number", ["number"]),

  /**
   * Family estates — multi-lot reservations owned as one contractual
   * unit (Story 2.9, FR15 brand-tier extension).
   *
   * Promotes the brand guide's "family estate at Section A" framing
   * (Chapters VI & VIII) into a first-class concept. An estate groups
   * 2–12 existing `lots` rows under a single owning household (primary
   * customer + optional secondary owners — spouse, children) so that
   * pricing, ownership transfer, AR aging, and receipts treat the
   * grouping as one row rather than N parallel single-lot contracts.
   *
   * Additive design: this story does NOT modify the single-lot contract
   * path. Estate-bound contracts opt in via the optional
   * `contracts.familyEstateId` FK above; everything else continues to
   * work without estate awareness. Downstream queries check
   * `contract.familyEstateId !== undefined` to know whether to render
   * the estate surface.
   *
   * Field notes:
   *   - `name` — human-readable label (e.g. "de los Santos Family Estate").
   *     Free text, 3–120 chars, server-validated. NOT slug-encoded — the
   *     brand voice prefers prose labels over machine identifiers.
   *   - `primaryOwnerCustomerId` — household head; the canonical owner
   *     in legal contexts. Must resolve to an existing `customers` row.
   *   - `secondaryOwnerCustomerIds` — array (≥ 0) of additional owners.
   *     Empty array allowed (a solo primary owner is a legitimate
   *     household shape). The order is significant — index 0 is "first
   *     after the primary" for display purposes.
   *   - `lotIds` — array of 2..12 lot ids the estate covers. The bound
   *     mirrors the brief's brand-tier framing ("3–7 lots typical, up
   *     to 12 for extended families"). Enforced server-side in
   *     `createFamilyEstate`. Per the spec's disaster-prevention list a
   *     lot CANNOT belong to two active estates simultaneously — the
   *     create / addLot mutations walk every other ACTIVE estate (rows
   *     with `retiredAt === undefined`) before insert to enforce this.
   *   - `createdAt` / `createdByUserId` — actor + insertion timestamp.
   *   - `retiredAt` — soft-delete sentinel. Set by `retireEstate` to
   *     mark the estate dissolved (heirs split the lots, household
   *     consolidates, etc.). Retired estates remain queryable for
   *     historical AR / receipt reprints (FR31 immutability of audit
   *     trail). Lots from a retired estate become eligible for a new
   *     active estate or single-lot contract.
   *   - `retiredByUserId` / `retirementReason` — populated when
   *     `retiredAt` is set. Both absent on active estates.
   *
   * Indexes:
   *   - `by_primaryOwner` — customer detail page's "Family estates"
   *     section + admin list filter by household head. Stories 2.9 AC1.
   *   - `by_retiredAt` — admin list "active vs. retired" partition; the
   *     create-mutation's "is any candidate lot in an active estate?"
   *     scan walks this index with `q.eq("retiredAt", undefined)`.
   *
   * Audit pattern: every mutation emits via `emitAudit` with
   * `entityType: "ownership"` (family-estate ownership is logically a
   * subkind of ownership — the `auditLog.entityType` union does not
   * carry a dedicated `family_estate` value today, and adding one is a
   * follow-up coordinated with the cornerstone owners).
   */
  familyEstates: defineTable({
    name: v.string(),
    primaryOwnerCustomerId: v.id("customers"),
    secondaryOwnerCustomerIds: v.array(v.id("customers")),
    lotIds: v.array(v.id("lots")),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    createdByUserId: v.id("users"),
    retiredAt: v.optional(v.number()),
    retiredByUserId: v.optional(v.id("users")),
    retirementReason: v.optional(v.string()),
  })
    .index("by_primaryOwner", ["primaryOwnerCustomerId"])
    .index("by_retiredAt", ["retiredAt"]),

  /**
   * Lot ↔ family estate membership companion table — Story 2.9
   * CRITICAL adversarial-review fix.
   *
   * One row per (lot, active-or-retired estate) pair. The table exists
   * SOLELY to provide DB-level uniqueness for the "a lot belongs to at
   * most one ACTIVE estate" invariant — without it, two concurrent
   * `createFamilyEstate` calls referencing overlapping lots can BOTH
   * succeed under Convex's OCC layer (each transaction reads the same
   * empty conflicting-estate set and writes through). With the table
   * in place, the second insert (or the second `addLotToEstate`)
   * re-reads the `by_lot_active` index, finds a row with
   * `isActive: true`, and throws `INVARIANT_VIOLATION` with
   * `kind: "lot_in_other_active_estate"`. The OCC layer retries the
   * loser of any genuine race; the retried transaction sees the
   * membership row written by the winner and rejects cleanly.
   *
   * The companion table is kept in lockstep with `familyEstates.lotIds`
   * by every mutation that mutates the estate's footprint:
   *
   *   - `createFamilyEstate` — inserts one `isActive: true` row per lot.
   *   - `addLotToEstate`     — inserts one `isActive: true` row for the
   *     newly added lot (after re-confirming no active row exists for
   *     that lot via the `by_lot_active` index).
   *   - `removeLotFromEstate` — flips the row's `isActive` to `false`
   *     and stamps `removedAt`.
   *   - `retireEstate`       — flips every active membership row for
   *     the estate to `isActive: false` + `removedAt`.
   *
   * Field notes:
   *   - `lotId` / `familyEstateId` — strong FKs to the lot and the
   *     owning estate.
   *   - `isActive` — true while the lot is a live member of an active
   *     estate; false after either the lot was removed or the estate
   *     was retired. The uniqueness invariant is keyed on
   *     (`lotId`, `isActive: true`).
   *   - `addedAt` / `removedAt` — epoch ms. `removedAt` absent while
   *     active. Both are timestamps the operator can inspect when
   *     reconstructing the membership timeline.
   *
   * Indexes:
   *   - `by_lot_active` — primary uniqueness lookup. Pre-insert checks
   *     walk `q.eq("lotId", lotId).eq("isActive", true)`; the first
   *     hit fires the rejection.
   *   - `by_estate` — `retireEstate` walks every membership for the
   *     estate to deactivate them in a single atomic mutation.
   */
  lotEstateMembership: defineTable({
    lotId: v.id("lots"),
    familyEstateId: v.id("familyEstates"),
    isActive: v.boolean(),
    addedAt: v.number(),
    removedAt: v.optional(v.number()),
  })
    .index("by_lot_active", ["lotId", "isActive"])
    .index("by_estate", ["familyEstateId"]),

  /**
   * Lot condition logs (Story 1.14, FR13).
   *
   * Free-text + optional photo observations posted from the field by
   * field workers (and office staff / admins). This is the first
   * field-worker write surface in the system and a non-financial
   * counterpart to Journey 4's "Mr. Reyes sees a payment land" reactive
   * primitive — Office Staff's open lot detail page reactively shows
   * new entries with a 600ms amber flash via `ReactiveHighlight`.
   *
   * Field notes:
   *   - `loggedAt` — server-set epoch ms inside the mutation (never
   *     client-supplied; a phone with a wrong system clock would
   *     otherwise produce bad data).
   *   - `note` — free text. The schema lets any string in; the
   *     server-side validator in `convex/lots.ts → logLotCondition`
   *     trims and enforces 1 ≤ length ≤ 2000.
   *   - `photoStorageId` — optional pointer to a Convex File Storage
   *     blob uploaded via the two-step `generateUploadUrl` pattern.
   *     The blob URL is NEVER public — only surfaced through the
   *     auth-gated `getLotConditionLogPhotoUrl` query (NFR-S3).
   *   - `idempotencyKey` — optional client-generated token that
   *     dedupes a submit retried on the same form mount. Indexed for
   *     O(1) dedup inside the mutation.
   *
   * Logs are append-only by operational principle: no edit, no delete
   * UI surface in Phase 1. Admin-void (with `voidedReason` and original
   * row preserved) is a Phase 2 housekeeping story if the cemetery's
   * process requires it.
   *
   * Indexes:
   *   - `by_lot_loggedAt` — reactive list query on the lot detail page
   *     (`useQuery(listLotConditionLogs, { lotId })`). Sorted
   *     descending by `loggedAt` in the handler.
   *   - `by_loggedBy` — Phase 2 "my recent logs" view for field workers.
   *   - `by_idempotency` — dedup lookup keyed on the optional client
   *     idempotency token.
   */
  lotConditionLogs: defineTable({
    lotId: v.id("lots"),
    loggedBy: v.id("users"),
    loggedAt: v.number(),
    note: v.string(),
    photoStorageId: v.optional(v.id("_storage")),
    idempotencyKey: v.optional(v.string()),
  })
    .index("by_lot_loggedAt", ["lotId", "loggedAt"])
    .index("by_loggedBy", ["loggedBy"])
    .index("by_idempotency", ["idempotencyKey"]),

  /**
   * BIR receipt serial counter — Story 3.1 (FR28, NFR-C1).
   *
   * Single-row table. The row is seeded once per environment via the
   * `seedReceiptCounter` internal mutation in `convex/lib/receiptCounter.ts`.
   *
   * Why no index: this table holds exactly one row. Queries always read
   * via `ctx.db.query("receiptCounter").first()`. Adding an index would
   * invite multi-row mistakes the seed mutation guards against.
   *
   * Access discipline:
   *   - Only `convex/lib/postFinancialEvent.ts` may read or write this
   *     table at runtime; the `no-direct-receipt-counter-access`
   *     ESLint rule fails the build on any other consumer.
   *   - `convex/lib/receiptCounter.ts` is the implementation file; the
   *     ESLint rule exempts it.
   *   - Voids do NOT decrement `currentSerial` (FR29). The counter is
   *     monotonic forever — a voided serial is "consumed" the same as
   *     any other.
   *
   * Field notes:
   *   - `currentSerial` — last-issued serial. The next allocation is
   *     `currentSerial + 1`. Stored as a plain JS number; Number.MAX_SAFE_INTEGER
   *     (2^53 - 1) bounds the lifetime ceiling; with a 7-digit padded
   *     format we cover 9,999,999 receipts before the formatted prefix
   *     widens — sufficient for any single cemetery.
   *   - `startingSerial` — the BIR-registered starting serial captured at
   *     seed time. Immutable after seed; the only writer is `seedReceiptCounter`.
   *   - `prefix` — BIR-approved prefix string (e.g. `"OR-"`). Immutable
   *     after seed. The seed validates the shape against `/^[A-Z0-9-]{0,10}$/`.
   *   - `seededAt` — Unix ms when the row was inserted.
   *   - `seededBy` — optional id of the admin that triggered the seed.
   *     Omitted when the seed runs from a script / internal mutation
   *     with no authenticated user context.
   *
   * See `docs/adr/0010-receipt-counter-pattern.md` and the Story 3.1 spec.
   */
  receiptCounter: defineTable({
    currentSerial: v.number(),
    startingSerial: v.number(),
    prefix: v.string(),
    seededAt: v.number(),
    seededBy: v.optional(v.id("users")),
  }),

  /**
   * Customer records (Story 2.1, FR14 / NFR-S2 / NFR-C5).
   *
   * Canonical PII container. Every person who owns a lot, will be
   * interred in one, or is otherwise referenced by a contract / sale
   * lives here. PII fields (`govIdNumber`, `address`, `phone`, etc.)
   * are stored using Convex's default at-rest encryption — ADR-0007
   * (Story 2.8) commits to "no application-level field encryption."
   *
   * Naming conventions (architecture § Naming Patterns):
   *   - `fullName` / `phone` / `email` — camelCase, plain strings.
   *   - `address` — sub-object so the full mailing address stays a
   *     single field on the doc.
   *   - `govIdType` — string-literal union; values come from FR14
   *     (SSS, TIN, UMID, …).
   *   - `govIdNumber` — stored as `v.string()` (NOT `v.bytes()`); see
   *     Story 2.8 ADR-0007 for the rationale.
   *   - `hasConsent` — boolean with `has<X>` prefix. Required at
   *     insert time (the form requires a conscious check per NFR-C5).
   *     Legacy migration may write `false` for rows where consent was
   *     not captured.
   *   - `consentTimestamp` / `consentCapturedByUserId` — populated by
   *     the create mutation ONLY when `hasConsent === true`. The
   *     invariant is enforced server-side
   *     (`ErrorCode.CUSTOMER_CONSENT_INVARIANT`).
   *   - `fullNameLowercased` — denormalized lower-case copy of
   *     `fullName`. Convex indexes only stored fields (no functional
   *     indexes); the create/update path writes this so the
   *     `by_fullName_lowercased` index works for the fuzzy-match
   *     dedupe UX.
   *
   * Indexes:
   *   - `by_fullName_lowercased` — supports the prefix-match dedupe
   *     query (`customers:searchByName`) the form uses to show
   *     "similar customer exists" suggestions while the user types.
   *   - `by_govIdNumber` — supports the future blocking-dedupe path
   *     (Story 2.7 ownership transfer may promote duplicate IDs to a
   *     hard reject per §10 Q6). Story 2.1 does NOT enforce uniqueness
   *     at the DB level — Convex has no UNIQUE constraint; uniqueness
   *     is advisory in this story.
   *
   * Stories that build on this table:
   *   - 2.2 (ID document uploads) reads `hasConsent` to gate uploads.
   *   - 2.3 (PII access logging) introduces `readPii(ctx, customerId,
   *     fields[])`; this story's `searchByName` returns only last-4
   *     of `govIdNumber` per UX §1879–1884 and so does NOT route
   *     through `readPii`.
   *   - 2.5 (customer detail page) is the create-mutation's redirect
   *     target and the primary read path for full-PII display.
   *   - 3.x (sale flow Journey 1) embeds `CustomerForm` inline via
   *     the form's `onCreated` callback.
   */
  customers: defineTable({
    fullName: v.string(),
    fullNameLowercased: v.string(),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    address: v.object({
      line1: v.string(),
      barangay: v.optional(v.string()),
      cityMunicipality: v.optional(v.string()),
      province: v.optional(v.string()),
      postalCode: v.optional(v.string()),
    }),
    govIdType: v.union(
      v.literal("sss"),
      v.literal("tin"),
      v.literal("umid"),
      v.literal("drivers_license"),
      v.literal("passport"),
      v.literal("philhealth"),
      v.literal("voters_id"),
      v.literal("other"),
    ),
    govIdNumber: v.string(),
    relationshipToOccupant: v.optional(v.string()),
    hasConsent: v.boolean(),
    consentTimestamp: v.optional(v.number()),
    consentCapturedByUserId: v.optional(v.id("users")),
    createdAt: v.number(),
    createdByUserId: v.id("users"),
    updatedAt: v.number(),
    // Story 9.7 — per-customer reminder opt-out (FR57).
    //
    // Defaults to `undefined` (treated as opt-in) so existing customer
    // rows remain schema-valid without a backfill. The portal opt-out
    // toggle (Story 9.7 customer profile extension) flips this to
    // `true`; the reminder scan skips customers with the flag set.
    // Twilio STOP-reply handling (provider webhook, deferred to a
    // follow-on) flips the flag automatically to mirror the carrier-
    // side opt-out state in our schema for reporting.
    reminderOptOut: v.optional(v.boolean()),
    // Story 9.8 — email bounce state (FR57 email portion).
    //
    // `emailBouncedAt` is the timestamp of the most recent hard bounce
    // reported by the email provider. When set, the daily reminder
    // scan skips this customer for any rule with `channel: "email"` to
    // prevent deliverability-suicide loops sending to a known-bad
    // address.
    //
    // `emailReminderPausedReason` carries the discriminator the bounce
    // webhook supplies — `"hard_bounce"`, `"spam_complaint"`, or
    // `"manual_pause"` — so the admin "bounced emails" view can sort /
    // filter by cause.
    //
    // `emailBounceMessageId` is the provider's message id that
    // bounced, captured for support tickets (when the customer says
    // "the cemetery emails are landing somewhere weird," staff can
    // cross-reference with the provider dashboard by this id).
    //
    // All three clear in the same patch when the customer updates
    // their email via Story 9.4's `updateCustomerContact` (Story 9.8
    // extends the mutation to clear on email change). Auto-clear via
    // time-based policy is intentionally NOT supported — a bad address
    // does not become good with age.
    emailBouncedAt: v.optional(v.number()),
    emailReminderPausedReason: v.optional(v.string()),
    emailBounceMessageId: v.optional(v.string()),
  })
    .index("by_fullName_lowercased", ["fullNameLowercased"])
    .index("by_govIdNumber", ["govIdNumber"])
    // Story 9.8 — admin "bounced emails" view. Paginated listing of
    // customers with `emailBouncedAt` set, sorted by bounce timestamp
    // descending. Convex indexes treat `undefined` as a sentinel value
    // so the index works even when most rows have the field absent.
    .index("by_emailBouncedAt", ["emailBouncedAt"]),

  /**
   * Customer identification documents (Story 2.2, FR15 / NFR-S3 / NFR-C5).
   *
   * Metadata pointer to Convex File Storage blobs. The blob itself
   * lives in Convex File Storage (referenced by `storageId`); this
   * table holds the operational fields (who, when, what type, what
   * filename) plus the soft-delete columns.
   *
   * Per-customer cap (10 active rows) is enforced server-side in
   * `convex/customerDocuments.ts:uploadCustomerDocument` — Convex
   * has no CHECK constraint, so the helper counts existing
   * non-deleted rows before insert.
   *
   * Consent gate (NFR-C5): `uploadCustomerDocument` refuses inserts
   * when `customers.hasConsent === false` for the `national_id`,
   * `drivers_license`, `passport`, and `voters_id` document types
   * (the government-ID family). Notarized public-ish documents
   * (`affidavit`, `death_certificate`, `court_order`) bypass the
   * consent gate per the FR15 § "consent applies to PII retention,
   * not notarized public records" carve-out.
   *
   * Naming conventions (architecture § Naming Patterns):
   *   - `docType` — string-literal union; the controlled vocabulary
   *     covers the Phase 1 surface (gov IDs, transfer affidavits,
   *     death certificates, court orders). `other` is the escape
   *     hatch for legacy / unforeseen docs.
   *   - `fileName` — original client filename, for display ONLY.
   *     We never use it to re-open the blob (`storageId` is the
   *     identity); a malicious filename like `../etc/passwd` can't
   *     leak out of the storage sandbox.
   *   - `storageId` — `v.id("_storage")` is the canonical Convex
   *     File Storage ID type. Opaque outside the storage API.
   *   - `mimeType` / `sizeBytes` — recorded at upload time so the
   *     list view can render type-aware icons + human-readable
   *     sizes without re-fetching the storage metadata per row.
   *   - `uploadedAt` / `uploadedByUserId` — actor + timestamp
   *     attribution. Server-set inside the mutation.
   *   - `isDeleted` / `deletedAt` / `deletedByUserId` / `deletedReason` —
   *     soft-delete. The row PERSISTS so the audit trail (Story 1.6)
   *     stays referentially intact; `listDocuments` filters out the
   *     deleted rows by default.
   *
   * Indexes:
   *   - `by_customer` — list query on the customer detail page.
   *     Pages through all of a customer's documents (deleted +
   *     active) so callers can opt into showing the deleted set.
   *
   * PII access logging note: Story 2.3 introduces `piiAccessLog`
   * + the `readPii` helper. Story 2.3 has shipped to `review`
   * (per sprint-status as of 2026-05-18); the file-view access log
   * row is written via that helper, NOT directly here. The Story 2.2
   * scope as actually shipped (per the system message's strict file
   * ownership) leaves the `piiAccessLog` schema to the Story 2.3
   * file already in review.
   *
   * Stories that build on this table:
   *   - 2.3 (PII access logging): wraps `getCustomerDocumentUrl` with
   *     `readPii` so every file view is captured in `piiAccessLog`.
   *   - 2.4 (data-subject report): lists customer documents +
   *     uses `listCustomerDocuments` from this story.
   *   - 2.5 (customer detail page): renders the upload + list
   *     components inline.
   *   - 2.7 (ownership transfer): uses `uploadCustomerDocument`
   *     with `docType: "affidavit" | "court_order"`.
   */
  customerDocuments: defineTable({
    customerId: v.id("customers"),
    docType: v.union(
      v.literal("national_id"),
      v.literal("drivers_license"),
      v.literal("passport"),
      v.literal("voters_id"),
      v.literal("affidavit"),
      v.literal("death_certificate"),
      v.literal("court_order"),
      v.literal("other"),
    ),
    fileName: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    storageId: v.id("_storage"),
    uploadedAt: v.number(),
    uploadedByUserId: v.id("users"),
    notes: v.optional(v.string()),
    isDeleted: v.boolean(),
    deletedAt: v.optional(v.number()),
    deletedByUserId: v.optional(v.id("users")),
    deletedReason: v.optional(v.string()),
  }).index("by_customer", ["customerId"]),

  /**
   * Occupants — deceased persons interred at a lot (Story 2.6, FR18).
   *
   * Distinct from `customers` (a person record / next-of-kin) and
   * distinct from `ownerships` (a property right; Story 2.7). An
   * occupant is a FACT of who is buried where; ownership is who holds
   * legal title. The two are intentionally separate tables so the
   * common case of "one owner, multiple interments in a family lot"
   * models cleanly without forcing the occupant into the customer
   * surface (the deceased is not a Data Privacy Act data subject).
   *
   * Naming conventions:
   *   - `name` — full name as recorded on the interment / ledger.
   *     Phase 1 stores in a single field (handwritten legacy ledgers
   *     rarely split first/last cleanly). Free-text 2..200 chars,
   *     enforced server-side in `convex/occupants.ts → addOccupant`.
   *   - `dateOfInterment` — unix ms; OPTIONAL because §10 Q4 legacy
   *     records frequently lack a precise date ("buried 1987"). When
   *     absent, the UI renders "Date unknown" and sorts the row to the
   *     tail of the chronological list (deterministic ordering).
   *   - `relationshipToOwner` — free-text Phase 1. Filipino family
   *     terms ("kuya", "ate", "ninang", "anak sa labas") would not
   *     survive a strict enum; Phase 2 may introduce a controlled
   *     vocabulary with an ADR.
   *   - `notes` — optional, up to 1000 chars. Captures legacy import
   *     context (e.g. "transferred from old book entry 1987").
   *   - `isRemoved` — soft-delete flag (admin-only; Phase 2 may add
   *     exhumation tracking on top). The row PERSISTS for cemetery
   *     history retention — never `db.delete` an occupant.
   *
   * Why two indexes:
   *   - `by_lot` — un-sorted membership check + count operations.
   *   - `by_lot_interment_date` — sorted listing per AC3. Convex
   *     indexes are cheap; defining both upfront avoids a future
   *     schema migration when Phase 2 adds bulk-by-date queries.
   *
   * What we deliberately do NOT index:
   *   - `name` — Phase 1 has no cross-lot occupant search. A deceased
   *     name in a search result reveals burial location (sensitive);
   *     access-control thinking deferred to Phase 2 interment work.
   *
   * Audit pattern: every write emits to `auditLog` with
   * `entityType: "lot"` (the lot is the aggregate root) — see
   * `convex/occupants.ts` for the rationale comment at the
   * `emitAudit` call sites.
   */
  occupants: defineTable({
    lotId: v.id("lots"),
    name: v.string(),
    dateOfInterment: v.optional(v.number()),
    relationshipToOwner: v.string(),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    createdByUserId: v.id("users"),
    isRemoved: v.boolean(),
    removedAt: v.optional(v.number()),
    removedByUserId: v.optional(v.id("users")),
    removedReason: v.optional(v.string()),
  })
    .index("by_lot", ["lotId"])
    .index("by_lot_interment_date", ["lotId", "dateOfInterment"]),

  /**
   * Time-versioned lot ownership rows (Story 2.5 scaffold; Story 2.7
   * extends with the transfer flow, FR16 / FR17).
   *
   * One row per (customer, lot) ownership episode. An ownership episode
   * is closed (i.e. ended) by populating `effectiveTo`; the open / active
   * row for a lot is the one whose `effectiveTo` is `undefined`. Phase 1
   * relies on application-level enforcement (Story 2.7's transfer
   * mutation closes the prior row inside the same transaction) — Convex
   * has no foreign-key / unique constraints.
   *
   * Soft foreign key to `lots`: when a lot is retired or deleted, the
   * historical ownership row remains. `listByCustomer` (Story 2.5)
   * falls back to `lotCode: "[retired]"` when the lot lookup returns
   * null, so the customer's history stays intact across lot lifecycle
   * changes. Legacy data (§10 Q4) may have ownership rows pointing at
   * retired or never-imported lots; the read path must not crash on
   * those.
   *
   * Field notes:
   *   - `effectiveFrom` — unix ms when ownership started. Required;
   *     set inside the transfer mutation (server-controlled clock).
   *   - `effectiveTo` — unix ms when ownership ended (sold,
   *     transferred, defaulted, reclaimed). Absent on the active row.
   *   - `transferType` — discriminated literal union mirroring the
   *     architecture sample schema (§265). `initial` is reserved for
   *     the bootstrap ownership of legacy lots; `sale` is the Epic 3
   *     happy path; `inheritance` / `gift` / `court_order` are the
   *     Story 2.7 branches per §10 Q6.
   *   - `transferEventId` — optional pointer to the Story 2.7 transfer
   *     event that created this row. Typed as `v.string()` for now
   *     because the `transferEvents` table doesn't exist yet (Story
   *     2.7 introduces it); the column tightens to `v.id(...)` once
   *     2.7 ships its schema PR.
   *   - `createdAt` / `createdBy` — audit attribution for the insert
   *     itself (separate from `effectiveFrom`, which is the BUSINESS
   *     date of the ownership change — usually equal but allowed to
   *     diverge for back-dated migrations).
   *
   * Indexes:
   *   - `by_customer` — Story 2.5's `listByCustomer` query (this
   *     story).
   *   - `by_lot_effective` — Story 2.7's "current owner of lot X"
   *     lookup; sorted by `effectiveFrom` so the head of a descending
   *     cursor is the most recently opened ownership.
   *   - `by_active` — index on `effectiveTo` for "all currently-active
   *     ownerships" admin queries (Phase 2). Convex indexes a missing
   *     field as a sentinel so the index works even when most rows
   *     have `effectiveTo` populated.
   */
  ownerships: defineTable({
    lotId: v.id("lots"),
    customerId: v.id("customers"),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    transferType: v.union(
      v.literal("sale"),
      v.literal("inheritance"),
      v.literal("gift"),
      v.literal("court_order"),
      v.literal("initial"),
    ),
    transferEventId: v.optional(v.string()),
    createdAt: v.number(),
    createdBy: v.id("users"),
  })
    .index("by_customer", ["customerId"])
    .index("by_lot_effective", ["lotId", "effectiveFrom"])
    .index("by_active", ["effectiveTo"]),

  /**
   * Contracts (Story 3.3, FR19 / FR23).
   *
   * One row per signed sale of a lot to a customer. The contract is the
   * aggregate that ties a lot, a customer, and the financial events that
   * paid for it together. Phase 1 introduces the row via two kinds:
   *
   *   - `full_payment` — one-shot lump-sum sale (Story 3.3). The contract
   *     is created in state `paid_in_full` because the matching payment +
   *     receipt are written in the same transaction by the cornerstone.
   *   - `installment` — Story 3.4. The contract is created in state
   *     `active` and transitions to `paid_in_full` once the last
   *     installment lands. Story 3.4 also introduces the `installments`
   *     child table; this story scaffolds the contract row and leaves
   *     installment-specific columns to that story.
   *
   * State machine (mirrors `convex/lib/stateMachines.ts:TRANSITIONS.contract`):
   *   - `active → fully_paid | in_default | cancelled | transferred`
   *   - `paid_in_full` is terminal — used by full-payment sales.
   *
   * Naming conventions (architecture § Naming Patterns):
   *   - `contractNumber` — externally-visible identifier (e.g. cemetery's
   *     contract series). Story 3.3 derives it from a timestamp + lot
   *     code; a richer numbering scheme can land in Story 3.6 without a
   *     schema change.
   *   - `kind` — discriminator for the contract type. Phase 1 surfaces
   *     `full_payment` (Story 3.3) and `installment` (Story 3.4).
   *   - `totalPriceCents` — INTEGER centavos. The lot's `basePriceCents`
   *     at sale time is the canonical source; admins can override (Story
   *     3.5 discount workflow).
   *   - `state` — controlled vocabulary mirroring the state-machine
   *     transition table. `paid_in_full` is a terminal state used by
   *     full-payment sales; `active` is the entry state for installment
   *     contracts; the rest are reachable via documented transitions.
   *   - `paymentId` / `receiptId` — back-pointer to the financial event
   *     that closed the contract. Populated by Story 3.3 after the
   *     cornerstone returns; optional because installment contracts
   *     (Story 3.4) reference multiple payments via `paymentAllocations`.
   *
   * Indexes:
   *   - `by_lot` — "every contract that ever existed against this lot"
   *     (Story 3.6 lot-history timeline, Story 4.5 default-reclaim
   *     pre-flight).
   *   - `by_customer` — customer detail page's contract list.
   *   - `by_state` — admin dashboards filtering by lifecycle state.
   *   - `by_contractNumber` — admin search by the human-readable number.
   */
  contracts: defineTable({
    contractNumber: v.string(),
    lotId: v.id("lots"),
    customerId: v.id("customers"),
    kind: v.union(
      v.literal("full_payment"),
      v.literal("installment"),
    ),
    totalPriceCents: v.number(),
    state: v.union(
      v.literal("active"),
      v.literal("paid_in_full"),
      v.literal("cancelled"),
      v.literal("voided"),
      v.literal("in_default"),
    ),
    createdAt: v.number(),
    createdBy: v.id("users"),
    paymentId: v.optional(v.id("payments")),
    receiptId: v.optional(v.id("receipts")),
    // Story 3.4 — installment-specific contract terms. Present only on
    // `kind: "installment"` contracts; all optional so `kind: "full_payment"`
    // rows (Story 3.3) stay structurally narrower. Captured at sale time
    // and immutable afterwards (FR31) — only `state` /
    // `outstandingBalanceCents` shift across the contract's lifetime.
    downPaymentCents: v.optional(v.number()),
    termMonths: v.optional(v.number()),
    monthlyAmountCents: v.optional(v.number()),
    firstDueDate: v.optional(v.number()),
    // Story 3.5 — discount / promo-price audit fields (FR22).
    //
    // The cornerstone always writes `totalPriceCents` as the
    // net-of-discount amount the customer pays. These three fields
    // record the lot's listed price (`basePriceCents`), the discount
    // applied (`discountCents`), and the operator's rationale
    // (`discountReason`). Invariants enforced server-side in the sale
    // mutations:
    //   - `basePriceCents >= totalPriceCents` whenever the field is
    //     supplied.
    //   - `discountCents = basePriceCents - totalPriceCents` whenever
    //     both fields are supplied.
    //   - `0 <= discountCents <= basePriceCents` — no negative
    //     discounts, no discount that drives the price below zero.
    //   - When `discountCents > 0`, `discountReason` MUST be a trimmed
    //     non-empty string of ≥ 5 chars — every applied discount needs
    //     a recorded business rationale (family-loyalty, manager
    //     override, anniversary promo, etc.).
    //
    // All three columns are optional so the existing Story 3.3 / 3.4
    // contract rows (sales without discounts) remain schema-valid. The
    // sale mutations write `basePriceCents` + `discountCents: 0` on
    // every new contract starting with Story 3.5, so going forward the
    // fields are effectively required.
    basePriceCents: v.optional(v.number()),
    discountCents: v.optional(v.number()),
    discountReason: v.optional(v.string()),
    // Story 3.8 (FR25) — perpetual care fee addon.
    //
    // Phase 1 scope per the §10 Q7-pending interpretation: a single
    // one-time perpetual care fee captured at contract creation and
    // ADDED to `totalPriceCents`. The schema reserves three optional
    // columns so the existing pre-3.8 contract rows remain valid
    // without backfill; sale mutations starting with 3.8 write
    // `perpetualCareCents: 0` + `perpetualCarePaidCents: 0` on every
    // new contract, so going forward the two cent columns are
    // effectively required.
    //
    //   - `perpetualCareCents` — total perpetual-care addon priced
    //     into the contract at sale time. Integer centavos, ≥ 0.
    //     INCLUDED in `totalPriceCents` (i.e. the customer pays the
    //     base + discount-adjusted price PLUS this addon as part of
    //     the same financial event).
    //   - `perpetualCarePaidCents` — running tally of the
    //     perpetual-care portion that the customer has actually paid.
    //     For full-payment sales this lands at the same value as
    //     `perpetualCareCents` (collected in full at sale time). For
    //     installment sales it begins at 0 and increments via
    //     payment allocations targeting the perpetual-care portion
    //     (Phase 2 / Epic 4 will wire the per-installment allocation
    //     UX; for now the column exists so the schema is stable).
    //   - `perpetualCareReason` — free-text rationale the operator
    //     records when applying a fee. Optional; defensive guard
    //     against silent fee creep (every applied fee should have a
    //     human-readable explanation surfaced in the audit trail).
    //
    // FR31 immutability: `perpetualCareCents` + `perpetualCareReason`
    // are frozen at contract creation. Only `perpetualCarePaidCents`
    // moves over the contract's lifetime as payments allocate to the
    // perpetual care portion.
    perpetualCareCents: v.optional(v.number()),
    perpetualCarePaidCents: v.optional(v.number()),
    perpetualCareReason: v.optional(v.string()),
    // Story 6.1 — generated contract PDF blob pointer (FR49). Phase 2
    // reservation: this story persists the latest rendered PDF inline on
    // the contract row rather than introducing a separate
    // `contractDocuments` table; regeneration overwrites both fields. A
    // future story may promote this to a versioned child table — at that
    // point these columns become the "current version" pointer and the
    // child table carries the history. `pdfStorageId` is the Convex File
    // Storage blob id served via the auth-gated `getContractPdfUrl` query
    // (NFR-S3); `pdfGeneratedAt` is the epoch ms the action successfully
    // stored the blob. Both absent when the contract has never had a PDF
    // generated.
    pdfStorageId: v.optional(v.id("_storage")),
    pdfGeneratedAt: v.optional(v.number()),
    // Epic-3/4 adversarial-review HIGH fix — PDF lifecycle bookkeeping
    // (Story 6.1).
    //
    // `pdfStatus`     — `"pending"` while the action is in flight,
    //                   `"ready"` once the blob has landed, `"failed"`
    //                   when the action errored. Absent on contracts
    //                   that have never had a PDF requested.
    // `pdfRetryCount` — number of retries the scheduled retry sweep
    //                   has attempted. Starts at 0 on first request;
    //                   bumped by the cron sweep. Capped at 3 by the
    //                   sweep itself.
    // `pdfLastError`  — short error string from the most-recent
    //                   failed action. Operator-facing on the UI's
    //                   "Retry generation" affordance.
    // `pdfIdempotencyKey` — caller-supplied key (the public mutation
    //                   normalises a generated one when absent) used
    //                   for rapid-double-click dedupe so a second
    //                   click while a generation is in flight returns
    //                   the cached storage id rather than scheduling
    //                   a second action.
    pdfStatus: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("ready"),
        v.literal("failed"),
      ),
    ),
    pdfRetryCount: v.optional(v.number()),
    pdfLastError: v.optional(v.string()),
    pdfIdempotencyKey: v.optional(v.string()),
    // Story 6.2 — generated demand-letter PDF blob pointer (FR50). Mirrors
    // the `pdfStorageId` / `pdfGeneratedAt` shape above but for the demand
    // letter document. Both fields are absent until a demand letter has
    // been generated for the contract. Regeneration overwrites both
    // fields; the prior blob is not retained (Phase 1 scope deviation
    // from the story spec's `contractDocuments` versioned-child-table
    // proposal — same simplification the contract PDF made in Story 6.1
    // for the same reasons; a future story may promote both fields to a
    // versioned child table together). `demandLetterStorageId` is the
    // Convex File Storage blob id served via the auth-gated
    // `getDemandLetterUrl` query (NFR-S3); `demandLetterGeneratedAt` is
    // the epoch ms the action successfully stored the blob.
    demandLetterStorageId: v.optional(v.id("_storage")),
    demandLetterGeneratedAt: v.optional(v.number()),
    // Epic-3/4 adversarial-review HIGH fix — demand-letter PDF
    // lifecycle bookkeeping (Story 6.2). Same shape as the contract
    // PDF fields above; separate columns so the two surfaces can fail
    // / retry independently without overwriting each other's state.
    demandLetterStatus: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("ready"),
        v.literal("failed"),
      ),
    ),
    demandLetterRetryCount: v.optional(v.number()),
    demandLetterLastError: v.optional(v.string()),
    demandLetterIdempotencyKey: v.optional(v.string()),
    // Story 5.4 (FR44) — admin "flag for staff follow-up" fields.
    //
    // A flat per-contract flag (rather than a separate `flaggedContracts`
    // table) keeps the surface narrow for the Phase 1 owner workflow Mr.
    // Reyes runs from his phone in a typical week: a contract is either
    // flagged for the staff to look at or it isn't. The whole lifecycle
    // (open → viewed → resolved) collapses into "isFlagged: true" until
    // an admin unflags. The reactive subscription on Maria's dashboard
    // re-evaluates whenever a contract row's `isFlagged` changes.
    //
    //   - `isFlagged` — true while the contract is awaiting staff attention.
    //   - `flagReason` — admin-supplied free-text comment (max 280 chars,
    //     trimmed; required when flagging).
    //   - `flaggedAt` — epoch ms when the flag was set (Story 5.4 audit
    //     trail mirror).
    //   - `flaggedBy` — admin user who set the flag (FK to users).
    //
    // Unflagging clears all four fields (sets them undefined). The audit
    // log retains the full history (flag.create / flag.clear actions —
    // emitted via the standard `update` audit action with `before` /
    // `after` payloads).
    //
    // Optionality: every field is `v.optional(...)` so existing pre-5.4
    // contract rows remain schema-valid without a backfill.
    isFlagged: v.optional(v.boolean()),
    flagReason: v.optional(v.string()),
    flaggedAt: v.optional(v.number()),
    flaggedBy: v.optional(v.id("users")),
    // Story 2.9 (FR15 brand-tier extension) — optional FK to a
    // `familyEstates` row. When set, this contract covers EVERY lot in
    // the estate (`lotIds`), not just the row's `lotId` (which is set to
    // the estate's first lot as the canonical anchor). Downstream
    // consumers (AR aging rollup, receipt PDF, contract detail) check
    // `familyEstateId !== undefined` to know they're rendering an
    // estate-bound surface and switch to the estate label / consolidated
    // financial view. Absent on every pre-2.9 contract; single-lot
    // contracts written after 2.9 leave it absent as well — back-compat
    // is total. See `convex/familyEstates.ts` for the surface that
    // populates it.
    familyEstateId: v.optional(v.id("familyEstates")),
  })
    .index("by_lot", ["lotId"])
    .index("by_customer", ["customerId"])
    .index("by_state", ["state"])
    .index("by_contractNumber", ["contractNumber"])
    // Story 2.9 — AR aging rollup needs to find every contract bound to
    // an estate quickly. The index pairs `familyEstateId` with `state`
    // so the aging recompute can filter to active / in-default rows in
    // a single bounded scan.
    .index("by_familyEstate_state", ["familyEstateId", "state"])
    // Story 5.4 — dashboard "flagged for follow-up" tile + admin queue.
    // Counts contracts where `isFlagged === true`. Using the index keeps
    // the dashboard query bounded to flagged rows rather than scanning
    // the whole contracts table on every reactive re-evaluation.
    .index("by_isFlagged", ["isFlagged"])
    // Epic-3/4 adversarial-review HIGH fix — PDF retry sweep indices
    // (Stories 6.1 / 6.2). The cron in `convex/crons.ts` filters
    // contracts where pdfStatus / demandLetterStatus is "pending" OR
    // "failed" so it can re-schedule the generation action. A status
    // index keeps the scan bounded to rows that actually need work
    // rather than walking every contract on every sweep.
    .index("by_pdfStatus", ["pdfStatus"])
    .index("by_demandLetterStatus", ["demandLetterStatus"])
    // Story 6.3 — sales-by-dimension report's date-range scan. Without
    // this index, the salesByDimension query scans the full contracts
    // table per call (NFR-P4 breaks once the table grows past a few
    // thousand rows). The index is also a future hand-hold for the
    // dashboard's MTD / YTD sales tile if it migrates from full-table
    // scan + in-memory filter to an indexed range scan.
    .index("by_createdAt", ["createdAt"]),

  /**
   * Installments — one row per scheduled payment in an installment
   * contract (Story 3.4, FR20 / FR21).
   *
   * Created in a batch by `recordInstallmentSale` after the contract row
   * and the down-payment financial event have landed. Each row mirrors
   * the schedule generated client-side by `SchedulePreview` — the server
   * regenerates the schedule from the contract terms (defense in depth)
   * and inserts the authoritative copy.
   *
   * Lifecycle (Phase 1 surface — Epic 4 extends with aging):
   *   - `pending`  → freshly inserted. Default status.
   *   - `paid`     → an installment-targeted allocation closed it
   *                  (Stories 3.9 / 3.10).
   *   - `overdue`  → daily aging job (Story 4.1) flips the flag when
   *                  `dueDate < now() - gracePeriodDays`.
   *   - `waived`   → admin-only state (future Story 4.x); reserved here
   *                  so the validator is stable.
   *
   * Money columns are integer centavos (ADR-0007). `paidCents` starts at
   * 0; subsequent installment-targeted allocations bump it via the
   * payment-allocator mutation in Story 3.9. `principalCents` is the
   * scheduled amount due — never patched after insert.
   *
   * Indexes:
   *   - `by_contract`  — load every installment row for a contract
   *                      detail page in one round-trip.
   *   - `by_dueDate`   — daily aging scheduler (Story 4.1) scans
   *                      `dueDate < cutoff` to flip `pending → overdue`.
   */
  installments: defineTable({
    contractId: v.id("contracts"),
    installmentNumber: v.number(),
    dueDate: v.number(),
    principalCents: v.number(),
    paidCents: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("paid"),
      v.literal("overdue"),
      v.literal("waived"),
    ),
    paidAt: v.optional(v.number()),
  })
    .index("by_contract", ["contractId"])
    .index("by_dueDate", ["dueDate"]),

  /**
   * Payments (Story 3.2 cornerstone — FR28, FR32, NFR-C1).
   *
   * Every money-in event the cemetery records lives here: a full-payment
   * sale's lump sum, an installment down-payment, a mid-stream
   * installment payment, a future webhook-initiated GCash/Maya/card
   * payment in Epic 9. One row per posted payment. The row is created
   * by `postFinancialEvent` and nowhere else — the ESLint rule
   * `local-rules/no-direct-financial-write` blocks the bypass.
   *
   * Polymorphic linkage:
   *   Phase 1 keeps the linkage shape narrow: `contractId` and
   *   `customerId` are OPTIONAL strings (not `v.id(...)`) because the
   *   cornerstone is contract-agnostic — it accepts whatever id the
   *   caller supplies as the target without FK-validating beyond
   *   shape. Story 3.3+ wires the typed sale flow and supplies both
   *   ids; the downstream `paymentAllocations` rows carry the
   *   per-installment detail.
   *
   * Naming conventions (architecture § Naming Patterns):
   *   - `paymentNumber` — externally-visible payment identifier (the
   *     cornerstone reuses the receipt serial here so payments and
   *     receipts share an audit-friendly key). Stored as the formatted
   *     string for display fidelity.
   *   - `amountCents` — INTEGER centavos only (ADR-0007).
   *   - `paymentMethod` — string-literal union enumerating BIR-accepted
   *     methods Phase 1 supports. New methods land via ADR amendment.
   *   - `receivedAt` — operator-supplied epoch ms (cemetery's local
   *     Manila tz, normalised to UTC at submit time). Distinct from
   *     `_creationTime` which is Convex's server-side insert timestamp.
   *   - `receivedByUserId` — id of the staff member who recorded the
   *     payment (not the customer; customer-initiated portal payments
   *     in Epic 9 fall back to a designated system user).
   *   - `idempotencyKey` — UUIDv4 from the client. Indexed for O(1)
   *     dedup inside `postFinancialEvent`.
   *   - `isVoided` — set true by the void path. The receipt row
   *     mirrors this flag for display consistency.
   *
   * Indexes:
   *   - `by_contract` — Phase 1 contract-detail view; will be heavily
   *     queried by Stories 3.6, 4.1 (AR aging), 4.4 (default flow).
   *   - `by_customer` — Phase 2 customer-detail view.
   *   - `by_idempotency` — primary dedup path inside the cornerstone.
   *   - `by_receivedAt` — admin financial-report queries (Story 5.x).
   *
   * Immutability:
   *   The row is created with `ctx.db.insert` once and only patched
   *   by the void path (setting `isVoided`, `voidedAt`, `voidReason`).
   *   `ctx.db.replace` against this table is forbidden by the
   *   `no-direct-financial-write` rule — `replace` would clobber the
   *   `_creationTime` audit trail, which BIR retention requires.
   */
  payments: defineTable({
    paymentNumber: v.string(),
    contractId: v.optional(v.string()),
    customerId: v.optional(v.string()),
    amountCents: v.number(),
    paymentMethod: v.union(
      v.literal("cash"),
      v.literal("check"),
      v.literal("bank_transfer"),
      v.literal("gcash"),
      v.literal("maya"),
      v.literal("card"),
    ),
    reference: v.optional(v.string()),
    receivedAt: v.number(),
    receivedByUserId: v.id("users"),
    idempotencyKey: v.string(),
    isVoided: v.boolean(),
    voidedAt: v.optional(v.number()),
    voidReason: v.optional(v.string()),
    voidedByUserId: v.optional(v.id("users")),
  })
    .index("by_contract", ["contractId"])
    .index("by_customer", ["customerId"])
    .index("by_idempotency", ["idempotencyKey"])
    .index("by_receivedAt", ["receivedAt"]),

  /**
   * Receipts (Story 3.2 cornerstone — FR28, FR29, NFR-C1).
   *
   * Every payment posts exactly one receipt. The receipt is what BIR
   * cares about: the serial-numbered record-of-issuance. Void
   * (Story 3.12) sets `isVoided: true` on the row but DOES NOT release
   * the serial — voided serials are consumed forever per FR29.
   *
   * Field notes:
   *   - `paymentId` — back-pointer to the payment that issued this
   *     receipt. One-to-one in Phase 1; the linkage is always set.
   *   - `receiptSeries` — the BIR-registered prefix snapshot at issue
   *     time (e.g. `"OR-"`). The receiptCounter's prefix is the
   *     source of truth; mirroring it here keeps the receipt
   *     self-describing for the audit export.
   *   - `receiptNumber` — formatted string the customer sees on the
   *     PDF: e.g. `"OR-0000123"`. Pre-formatted by `formatSerial` and
   *     immutable after insert.
   *   - `receiptSerial` — the integer serial backing `receiptNumber`.
   *     Stored alongside the formatted string so downstream code can
   *     do integer comparisons (sort, search) without re-parsing.
   *   - `amountCents` — mirror of `payments.amountCents` at issue
   *     time so the receipt row is self-contained for printing even
   *     if a defect later corrupts the payment row (defense in depth).
   *   - `issuedAt` / `issuedByUserId` — who-when of issuance.
   *   - `voidedAt` / `voidedByUserId` / `voidReason` — populated by
   *     the void path (Story 3.12). The reason is FREE TEXT but the
   *     UI guidance is "describe the operational reason, not the
   *     customer's personal context" (Story 3.12 spec).
   *
   * Indexes:
   *   - `by_payment` — receipt-from-payment lookup (one-to-one).
   *   - `by_serial` — admin receipt-search by integer serial.
   *   - `by_receiptNumber` — admin receipt-search by formatted string
   *     (cashiers think in `"OR-0000123"`, not in the integer 123).
   *   - `by_issuedAt` — reporting / monthly archival (Story 5.7).
   *
   * Immutability:
   *   Insert + patch-of-void-fields only. The `no-direct-financial-write`
   *   rule blocks any other write path, including `ctx.db.replace`.
   */
  receipts: defineTable({
    paymentId: v.id("payments"),
    receiptSeries: v.string(),
    receiptNumber: v.string(),
    receiptSerial: v.number(),
    contractId: v.optional(v.string()),
    customerId: v.optional(v.string()),
    amountCents: v.number(),
    issuedAt: v.number(),
    issuedByUserId: v.id("users"),
    isVoided: v.boolean(),
    voidedAt: v.optional(v.number()),
    voidReason: v.optional(v.string()),
    voidedByUserId: v.optional(v.id("users")),
    // Story 3.13 — PDF rendering extension.
    //
    // The receipt PDF is generated by an out-of-band `"use node"` action
    // (PDFKit needs the Node runtime; the V8 runtime can't compile it).
    // The cornerstone path that creates the receipt row leaves both
    // fields unset; staff trigger PDF generation via
    // `receipts:generateReceiptPdfRequest`, which schedules the action
    // immediately. When the action finishes, an internal mutation
    // patches:
    //   - `pdfStorageId` — `Id<"_storage">` of the generated blob. The
    //     auth-gated `receipts:getReceiptPdfUrl` query is the only way
    //     to surface a signed URL (NFR-S3 — never raw storage IDs in
    //     responses).
    //   - `pdfGeneratedAt` — unix ms when the action finished. Surfaces
    //     in the UI ("PDF generated 5 minutes ago") and provides an
    //     auditable trail without writing to `auditLog` (PDF generation
    //     is not a financial-touching event).
    //
    // The fields are intentionally NOT indexed: the only queries are
    // by `_id` (the receipt detail page) which always uses the primary
    // index, and the `pdfGeneratedAt` field is display-only — no
    // sort/filter needs it.
    //
    // FR31 immutability respected: the underlying receipt row's
    // financial fields stay untouched. The PDF can be regenerated on
    // demand (the action does not bump the serial); regeneration
    // produces a new storage blob and updates `pdfGeneratedAt` to the
    // latest run. The `no-direct-financial-write` rule still applies
    // — the patch path lives inside `convex/receipts.ts` as an
    // internal mutation that ONLY touches `pdfStorageId` /
    // `pdfGeneratedAt`, never the financial fields.
    pdfStorageId: v.optional(v.id("_storage")),
    pdfGeneratedAt: v.optional(v.number()),
    // Epic-3/4 adversarial-review HIGH fix — receipt PDF lifecycle
    // bookkeeping (Story 3.13). Mirrors the contract PDF lifecycle
    // columns on the `contracts` table; same semantics, same retry-sweep
    // wiring in `convex/crons.ts`. The bookkeeping is additive on top
    // of the existing `pdfStorageId` / `pdfGeneratedAt` fields above —
    // a "ready" status with a non-null storage id is the steady state;
    // "pending" gates the UI's Download-PDF button to "Rendering…"; a
    // "failed" status with `pdfRetryCount < 3` is what the cron's retry
    // sweep re-attempts.
    pdfStatus: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("ready"),
        v.literal("failed"),
      ),
    ),
    pdfRetryCount: v.optional(v.number()),
    pdfLastError: v.optional(v.string()),
    pdfIdempotencyKey: v.optional(v.string()),
    // Story 9.3 — customer-portal receipt-download counter (Epic-9
    // adversarial-review HIGH fix). Increments on every successful
    // `getCustomerReceiptPdfUrl` call. Optional so pre-fix rows remain
    // schema-valid without backfill; the bumper treats `undefined` as
    // 0. The audit row is the canonical PII-access surface for NFR-S8;
    // the counter is a denormalised aggregate for operational
    // visibility ("which receipts get re-downloaded frequently?")
    // without scanning the audit log.
    downloadCount: v.optional(v.number()),
  })
    .index("by_payment", ["paymentId"])
    .index("by_serial", ["receiptSerial"])
    .index("by_receiptNumber", ["receiptNumber"])
    .index("by_issuedAt", ["issuedAt"])
    // Epic-3/4 adversarial-review HIGH fix — retry sweep index.
    .index("by_pdfStatus", ["pdfStatus"]),

  /**
   * Payment allocations (Story 3.2 cornerstone).
   *
   * Splits a payment across the things it pays for. A full-payment
   * sale records one allocation; an installment payment records one
   * row per touched installment; a perpetual-care payment (Story 3.8)
   * records its own allocation kind. The sum of a payment's
   * allocations MUST equal the payment's amount — the cornerstone
   * enforces this with `ALLOCATION_SUM_MISMATCH`.
   *
   * Polymorphic target:
   *   `targetType` is the discriminator; `targetId` is the opaque id
   *   of the thing being paid (contract / installment / perpetualCare
   *   fee / future tag). Phase 1 validates the shape only — target
   *   existence is the caller's responsibility (the calling mutation
   *   in Story 3.3+ has already loaded the contract / installment by
   *   the time it invokes the cornerstone). This keeps the cornerstone
   *   table-agnostic — adding a new target type (e.g. interment fee
   *   in Epic 7) is a `targetType` literal addition, not a structural
   *   change.
   *
   * Field notes:
   *   - `paymentId` — back-pointer to the payment. Strong FK.
   *   - `targetType` — `"contract" | "installment" | "perpetualCare"
   *     | "credit"`. Open enum; new kinds land via ADR amendment.
   *   - `targetId` — opaque string-id of the target document.
   *   - `amountCents` — INTEGER centavos.
   *   - `sequence` — insertion-order index within a single payment's
   *     allocation set. Lets downstream UIs render allocations in the
   *     order the cornerstone wrote them without depending on Convex's
   *     internal `_creationTime` resolution.
   *   - `note` — operator-supplied free text (e.g. "Manually
   *     overridden — customer requested ahead-application").
   *
   * Indexes:
   *   - `by_payment` — "show me what this payment paid for" — the
   *     primary read path from receipt-detail / payment-detail UI.
   *   - `by_target` — "show me every payment that touched this
   *     installment" — Story 3.9 oldest-unpaid-first allocator + the
   *     contract-detail timeline both query here.
   */
  paymentAllocations: defineTable({
    paymentId: v.id("payments"),
    targetType: v.union(
      v.literal("contract"),
      v.literal("installment"),
      v.literal("perpetualCare"),
      v.literal("credit"),
    ),
    targetId: v.string(),
    amountCents: v.number(),
    sequence: v.number(),
    note: v.optional(v.string()),
  })
    .index("by_payment", ["paymentId"])
    .index("by_target", ["targetType", "targetId"]),

  /**
   * Interments — scheduled / completed burials at a lot (Story 7.1, FR51).
   *
   * Third Phase-2 state-machine-bearing entity (after `lots` and the
   * `contracts` table Story 3.x introduces). An interment ties a planned
   * occupant to a lot at a specific moment in time. The schema is shared
   * across Story 7.1 (scheduling), 7.2 (double-booking guard), 7.3
   * (calendar view), and 7.4 (field-worker completion).
   *
   * Naming conventions (architecture § Naming Patterns):
   *   - `scheduledAt` — epoch ms (UTC) of the planned interment moment.
   *     Rendered in `Asia/Manila` via shared formatter — never store as
   *     a string (loses ordering + tz safety + is not numerically
   *     indexable). The Manila offset is hardcoded for now per
   *     `convex/lib/time.ts` (no DST in PH).
   *   - `scheduledAt_createdAt` — epoch ms when the ROW itself was
   *     inserted (i.e. when the operator hit "Schedule"). Intentionally
   *     separate from `scheduledAt` (the interment's moment) so the
   *     audit trail captures both "WHEN was this scheduled?" and
   *     "WHEN is the burial?". Common LLM-developer mistake: collapsing
   *     the two into a single field — don't.
   *   - `status` — 3-state union per UX § Status palette scaling. Richer
   *     states ("in_progress", "rescheduled") deferred to Phase 2 kickoff
   *     re-elicitation.
   *   - `occupantId` — strong FK to the `occupants` table (Story 2.6).
   *     The server-side invariant `occupant.lotId === lotId` is enforced
   *     in `scheduleInterment` (defense against malformed clients).
   *   - `scheduledBy` — id of the user who created the row.
   *   - `completedAt` / `completedBy` / `completionNotes` /
   *     `completionPhotoBlobId` — populated by Story 7.4's completion
   *     transition. Absent on `scheduled` rows; absent on `cancelled`
   *     rows.
   *   - `cancellationReason` — optional free text. The `cancelled`
   *     status is in the enum from day one (Story 7.5 will wire the
   *     transition; this story only inserts `scheduled` rows).
   *
   * Indexes:
   *   - `by_lot_status` — lot detail card's "Upcoming interments" query
   *     (Story 7.1) — filters by status to render scheduled-only.
   *   - `by_scheduledAt` — calendar / global list (Story 7.3).
   *   - `by_status_scheduledAt` — Story 7.3's calendar query with status
   *     filter + chronological order in a single index scan.
   *   - `by_lot_scheduledAt` — Story 7.2's double-booking conflict check
   *     (same lot + same day). Adding the index here avoids a second
   *     schema deploy in 7.2.
   *
   * Audit pattern: every write emits to `auditLog` with
   * `entityType: "lot"` (the lot is the aggregate root) — same convention
   * as `occupants` (Story 2.6). The `entityType` enum on `auditLog` does
   * NOT contain "interment" deliberately; the lot groups all sub-events.
   * Adding "interment" is a follow-up that requires both a schema enum
   * extension and an `audit.ts` type-list update, coordinated with the
   * audit cornerstone owners.
   *
   * State machine: NOT routed through `assertTransition` in this story.
   * The initial insert state is always `scheduled` — inserts are not
   * transitions. Story 7.4 introduces the first real transition
   * (`scheduled → completed`); a future 7.5 wires `scheduled → cancelled`.
   * When those stories land, the `interment` entry in `TRANSITIONS`
   * (convex/lib/stateMachines.ts) is added then. For Story 7.1, inline
   * guards in `scheduleInterment` suffice.
   */
  interments: defineTable({
    lotId: v.id("lots"),
    occupantId: v.id("occupants"),
    scheduledAt: v.number(),
    status: v.union(
      v.literal("scheduled"),
      v.literal("completed"),
      v.literal("cancelled"),
    ),
    notes: v.optional(v.string()),
    scheduledBy: v.id("users"),
    scheduledAt_createdAt: v.number(),
    completedAt: v.optional(v.number()),
    completedBy: v.optional(v.id("users")),
    completionNotes: v.optional(v.string()),
    completionPhotoBlobId: v.optional(v.id("_storage")),
    cancellationReason: v.optional(v.string()),
    // Story 7.5 H4 fix (adversarial review) — interments held in the
    // chapel or along the eastern pathway compete for the SAME shared
    // resources as ceremonies (consecration / memorial anniversary).
    // Before this fix, `convex/lib/scheduling.ts:assertNoBookingConflict`
    // hard-coded `chapelReserved: false, pathwayReserved: false` when
    // mapping interment rows into the conflict scan, which meant a
    // chapel-bound interment could NOT collide with a chapel-bound
    // consecration -- a disaster-class scheduling failure (two families
    // arrive at the same hour).
    //
    // Both fields are additive and OPTIONAL so every existing interment
    // row stays schema-valid without a backfill. The conflict mapper
    // treats `undefined` as `false` via a `=== true` defensive check,
    // preserving the pre-fix behaviour for legacy rows that never
    // captured the toggle. Going forward, staff explicitly opt-in by
    // flipping these flags when reserving a shared resource for the
    // interment ceremony.
    chapelReserved: v.optional(v.boolean()),
    pathwayReserved: v.optional(v.boolean()),
  })
    .index("by_lot_status", ["lotId", "status"])
    .index("by_scheduledAt", ["scheduledAt"])
    .index("by_status_scheduledAt", ["status", "scheduledAt"])
    .index("by_lot_scheduledAt", ["lotId", "scheduledAt"]),

  /**
   * Ceremonies — generalised scheduling surface (Story 7.5, FR43 extension).
   *
   * Per docs/adr/0069-ceremonies-table.md the team chose **Option B**
   * (parallel table) over Option A (rename interments -> ceremonies).
   * Rationale: the existing `interments` table is referenced by 37+
   * call-sites across `convex/`, `src/components/`, `src/app/`, and
   * `tests/` -- a single-PR rename would multiply the blast radius and
   * conflict with parallel agents (6.8 plaque PDF, 2.9 family estate,
   * 1.15 named sections). The parallel-table cost is paid in
   * `convex/lib/scheduling.ts` which queries BOTH tables for the
   * kind-agnostic double-booking guard. Interments stay anchored to
   * `convex/interments.ts`; ceremonies (consecration + future
   * memorial-anniversary) live in this row shape.
   */
  ceremonies: defineTable({
    kind: v.union(
      v.literal("consecration"),
      v.literal("interment"),
      v.literal("memorial_anniversary"),
    ),
    contractId: v.id("contracts"),
    // Story 2.9 forward-compat: stored as a string today; once 2.9
    // introduces the `familyEstates` table this tightens to
    // `v.optional(v.id("familyEstates"))` in a single-PR migration.
    familyEstateId: v.optional(v.string()),
    lotId: v.id("lots"),
    deceasedOccupantId: v.optional(v.id("occupants")),
    scheduledAt: v.number(),
    durationMinutes: v.number(),
    chapelReserved: v.boolean(),
    pathwayReserved: v.boolean(),
    consultantUserId: v.optional(v.id("users")),
    notes: v.optional(v.string()),
    status: v.union(
      v.literal("scheduled"),
      v.literal("completed"),
      v.literal("cancelled"),
    ),
    scheduledBy: v.id("users"),
    scheduledAt_createdAt: v.number(),
    completedAt: v.optional(v.number()),
    completedBy: v.optional(v.id("users")),
    cancellationReason: v.optional(v.string()),
  })
    .index("by_kind_scheduledAt", ["kind", "scheduledAt"])
    .index("by_contract", ["contractId"])
    .index("by_status_scheduledAt", ["status", "scheduledAt"])
    .index("by_scheduledAt", ["scheduledAt"])
    .index("by_lot_scheduledAt", ["lotId", "scheduledAt"]),

  /**
   * Operating expenses (Story 4.6, FR39).
   *
   * Non-financial-cornerstone Phase 1 capability. Expenses do NOT route
   * through `postFinancialEvent` — they are operational ledger entries
   * with a simpler write path (single insert + audit emit). They DO
   * affect Mr. Reyes's dashboard MTD / net-position tiles (Story 5.2)
   * via reactive queries that aggregate the `expenses` table.
   *
   * Naming conventions (architecture § Naming Patterns):
   *   - `paidAt` — epoch ms of the BUSINESS-relevant moment of payment.
   *     Operator-supplied (date-input). The matching "row insert
   *     timestamp" is `recordedAt`. The two are intentionally separate:
   *     `paidAt` answers "when did we spend the money?", `recordedAt`
   *     answers "when did Maria type it in?". Common LLM mistake:
   *     collapsing them; do not.
   *   - `amountCents` — INTEGER centavos (ADR-0007). Always positive;
   *     server-validated > 0. UI displays via `formatPeso(cents)`.
   *   - `vendor` — free text 1..200, server-validated. Vendors are
   *     business entities (not PII); no redaction in audit log.
   *   - `category` — `v.string()` for Phase 1. Story 4.7 lands the
   *     admin-managed `expenseCategories` table; until then, validation
   *     runs against a hardcoded default list in
   *     `convex/lib/expenseCategories.ts`. The schema stays flexible so
   *     4.7's swap is one-line.
   *   - `photoStorageId` — optional pointer to a Convex File Storage
   *     blob, two-step uploaded via the Story 1.14 pattern. URLs are
   *     auth-gated through `getExpensePhotoUrl` (NFR-S3); the blob URL
   *     is NEVER public.
   *   - `recordedBy` — id of the staff member who recorded the expense
   *     (server-set inside the mutation; clients cannot override).
   *   - `recordedAt` — unix ms of insertion (server-set via Date.now()).
   *   - `idempotencyKey` — optional UUID stable across retries of the
   *     same form mount. Indexed for O(1) dedup inside the mutation.
   *   - `note` — reserved free-text annotation field (not exposed in
   *     the Phase 1 form; reserved for later admin annotations).
   *   - `approvalStatus` — reserved Phase 2 field (Story 6.6). Default
   *     `"approved"` so Phase 1 inserts always satisfy "expense is
   *     real money out". Phase 2's approval-queue toggle will flip the
   *     default to `"pending_approval"` without a schema migration.
   *
   * Indexes:
   *   - `by_paidAt` — primary read path for the recent-expenses list
   *     and Story 5.2 dashboard's MTD aggregation. Sorted descending in
   *     handlers.
   *   - `by_category` — Phase 2 category-filtered reports. Story 4.7
   *     keeps this index meaningful.
   *   - `by_recordedBy` — "expenses I recorded" view for Phase 2 staff
   *     productivity reports.
   *   - `by_idempotency_key` — dedup lookup inside `recordExpense`.
   *
   * Audit pattern: every mutation emits via `emitAudit` with
   * `entityType: "expense"` (schema-validated; the `auditLog`
   * `entityType` union includes `"expense"` from Story 1.6).
   */
  expenses: defineTable({
    paidAt: v.number(),
    amountCents: v.number(),
    vendor: v.string(),
    category: v.string(),
    photoStorageId: v.optional(v.id("_storage")),
    recordedBy: v.id("users"),
    recordedAt: v.number(),
    idempotencyKey: v.optional(v.string()),
    note: v.optional(v.string()),
    approvalStatus: v.optional(
      v.union(
        v.literal("approved"),
        v.literal("pending_approval"),
        v.literal("rejected"),
      ),
    ),
    /**
     * Story 6.6 — snapshot of the threshold (in centavos) that was
     * effective at the time the expense was recorded. Captured on the
     * row so the audit trail can answer "why was this routed through
     * approval?" without recomputing against current settings. When
     * the row was auto-approved (amount < threshold OR threshold = 0)
     * the field still records the active threshold so reports can
     * surface "auto-approved at threshold ₱X".
     */
    approvalThresholdCents: v.optional(v.number()),
    /**
     * Story 6.6 — admin who approved (or implicit auto-approval where
     * this is `recordedBy`). Set on insert when amount is below the
     * threshold; set on `approveExpense` when an admin clears a pending
     * row.
     */
    approvedBy: v.optional(v.id("users")),
    /** Story 6.6 — unix ms of the approval decision. */
    approvedAt: v.optional(v.number()),
    /**
     * Story 6.6 — required free-text reason supplied by the admin on
     * `rejectExpense`. Never overwritten — once a row is rejected the
     * reason is part of the audit history (the row itself is not
     * deleted, matching the financial-history immutability principle).
     */
    rejectionReason: v.optional(v.string()),
  })
    .index("by_paidAt", ["paidAt"])
    .index("by_category", ["category"])
    .index("by_recordedBy", ["recordedBy"])
    .index("by_idempotency_key", ["idempotencyKey"])
    /**
     * Story 6.6 — admin approval queue. The pending-approvals view
     * reads `withIndex("by_approvalStatus_paidAt", (q) =>
     * q.eq("approvalStatus", "pending_approval"))` and consumes the
     * resulting rows in `paidAt`-descending order.
     */
    .index("by_approvalStatus_paidAt", ["approvalStatus", "paidAt"]),

  /**
   * AR aging snapshots (Story 4.1, FR34 / NFR-P3).
   *
   * Pre-aggregated summary table written by the daily AR-aging cron in
   * `convex/crons.ts` and the on-demand recompute path in
   * `convex/arAging.ts`. One row per `(contractId, bucket)` pair — the
   * cron upserts a single most-overdue row per contract, so in practice
   * the table holds exactly one snapshot row per active / in_default
   * contract.
   *
   * Why pre-aggregation: live aggregation over `installments` × `contracts`
   * × `followUpActions` would not meet NFR-P3's dashboard-freshness target
   * (≤ 1 day). The architecture's "pre-aggregated summary docs" exception
   * (§ Tech Stack / § Design Patterns) names AR aging as the canonical
   * use case.
   *
   * Bucket semantics (matches the dashboard `ArAgingBucketKey` literal
   * union in `convex/dashboard.ts` so the consumer-facing shape stays
   * single-source-of-truth):
   *   - `current`  — contract has no unpaid installment more than 30
   *                  days past its `dueDate`. Effectively "not yet
   *                  alarming" — UX-DR aging definition.
   *   - `1-30`     — most-overdue installment is 1–30 days past due.
   *   - `31-60`    — most-overdue installment is 31–60 days past due.
   *   - `61-90`    — most-overdue installment is 61–90 days past due.
   *   - `90+`      — most-overdue installment is more than 90 days past
   *                  due. The "₱X in 90+ days" line Mr. Reyes reads off
   *                  the dashboard tile (Journey 4) keys on this bucket.
   *
   * Money field is INTEGER centavos (ADR-0007). `totalOverdueCents` sums
   * `principalCents - paidCents` across every unpaid installment with
   * `dueDate < now` — the contract's outstanding past-due principal at
   * snapshot time.
   *
   * Counts fields:
   *   - `overdueCountSilent`     — overdue installments with NO active
   *                                `followUpAction` (Story 4.2 introduces
   *                                that table; in Story 4.1 every overdue
   *                                installment is "silent" because no
   *                                follow-up surface exists yet).
   *   - `overdueCountWithAction` — reserved for Story 4.2; the schema
   *                                stays stable so 4.2's swap is a one-
   *                                line code change in the recompute
   *                                helper, not a schema migration.
   *
   * Idempotency: the recompute helper upserts by `contractId` via the
   * `by_contract` index — running the cron twice on the same day produces
   * identical row contents (modulo `recomputedAt`). Story 4.1 AC4.
   *
   * Indexes:
   *   - `by_contract`               — primary upsert path (one row per
   *                                   contract; the recompute helper
   *                                   looks up the existing row before
   *                                   patch / insert).
   *   - `by_bucket`                 — Story 4.8 drill-down table query
   *                                   ("show me every contract in the
   *                                   90+ bucket"). Defining it now
   *                                   avoids a future schema migration.
   *   - `by_bucket_overdue_desc`    — Story 4.8 paginated read sorted by
   *                                   bucket then by overdue amount.
   */
  arAgingSnapshots: defineTable({
    contractId: v.id("contracts"),
    bucket: v.union(
      v.literal("current"),
      v.literal("1-30"),
      v.literal("31-60"),
      v.literal("61-90"),
      v.literal("90+"),
    ),
    totalOverdueCents: v.number(),
    overdueCountWithAction: v.number(),
    overdueCountSilent: v.number(),
    oldestDueDate: v.optional(v.number()),
    recomputedAt: v.number(),
  })
    .index("by_contract", ["contractId"])
    .index("by_bucket", ["bucket"])
    .index("by_bucket_overdue_desc", ["bucket", "totalOverdueCents"]),

  /**
   * Follow-up actions on overdue installments (Story 4.2, FR35).
   *
   * One row per logged follow-up that Office Staff (or admin) attaches to
   * an installment. The lifecycle moves through three states:
   *
   *   - `open`       → freshly inserted; the dueAt is in the future or
   *                    today. Stays open until the staff explicitly
   *                    marks it complete or cancelled, OR Story 4.3's
   *                    scheduled sweep expires it.
   *   - `completed`  → staff confirmed the planned follow-up happened.
   *                    `completedAt` / `completedBy` are populated.
   *   - `cancelled`  → staff abandoned the follow-up (customer paid,
   *                    or the action is no longer relevant).
   *                    `completedAt` is reused as the cancellation
   *                    timestamp; `completedBy` carries the cancelling
   *                    user.
   *
   * The row keys to the underlying `installments` row (a child of a
   * `contracts.kind === "installment"` row). Story 4.1's AR aging
   * recompute reads this table per-installment to split the snapshot
   * counts into `overdueCountWithAction` vs `overdueCountSilent` — the
   * helper hook is intentionally one-line so future stories can wire it
   * without a schema change.
   *
   * Naming conventions (architecture § Naming Patterns):
   *   - `action` — controlled vocabulary literal union (channel of
   *     contact). `"other"` is the escape hatch for legacy or future
   *     channels.
   *   - `notes` — free-text annotation 0..500 chars. Optional because
   *     a quick "I called" doesn't always merit a note; the form
   *     enforces the upper bound when supplied.
   *   - `dueAt` — operator-supplied epoch ms (the moment the follow-up
   *     SHOULD be performed). Server-validated to be ≥ today Manila tz.
   *   - `status` — `"open"` on insert; flipped by `markComplete` /
   *     `markCancelled` (this story) and by Story 4.3's sweep.
   *   - `createdAt` / `createdBy` — actor + timestamp attribution.
   *     Server-set inside the mutation.
   *   - `completedAt` / `completedBy` — populated by the close-out
   *     mutations (markComplete / markCancelled). Optional because an
   *     open row has nothing to record yet.
   *
   * Indexes:
   *   - `by_installment`     — list per installment for the contract
   *                            detail page + Story 4.1's aging hook.
   *   - `by_status_dueAt`    — Story 4.3's expiry sweep ("all `open`
   *                            rows whose `dueAt` is in the past") and
   *                            this story's `/follow-ups` page listing
   *                            ("open rows sorted by `dueAt` asc").
   *
   * Audit pattern: every mutation emits via `emitAudit` with
   * `entityType: "lot"`. Follow-up actions are sub-entities of
   * installments → contracts → lots (the aggregate root for cemetery
   * audit purposes, same convention as `occupants`).
   */
  followUpActions: defineTable({
    installmentId: v.id("installments"),
    action: v.union(
      v.literal("phone_call"),
      v.literal("sms"),
      v.literal("letter"),
      v.literal("in_person"),
      v.literal("other"),
    ),
    notes: v.optional(v.string()),
    dueAt: v.number(),
    /**
     * Lifecycle states (Story 4.2 + 4.3):
     *
     *   - "open"      — newly logged, target date in the future (or recently
     *                   past but not yet swept).
     *   - "completed" — operator confirmed the follow-up happened.
     *   - "cancelled" — operator abandoned the follow-up.
     *   - "expired"   — `dueAt` passed and the daily sweep
     *                   (`internal_reflagExpired` in `convex/followUpActions.ts`)
     *                   re-categorized the row so the "with logged action"
     *                   pill stops silencing the silently-overdue alarm.
     *                   Story 4.3 (FR36).
     */
    status: v.union(
      v.literal("open"),
      v.literal("completed"),
      v.literal("cancelled"),
      v.literal("expired"),
    ),
    createdAt: v.number(),
    createdBy: v.id("users"),
    completedAt: v.optional(v.number()),
    completedBy: v.optional(v.id("users")),
    /**
     * Wall-clock time (unix ms) the daily sweep flipped this row from
     * `"open"` to `"expired"`. Set exclusively by
     * `internal_reflagExpired` (Story 4.3); never written by any
     * staff-facing mutation. Absent on rows that were never expired.
     */
    expiredAt: v.optional(v.number()),
  })
    .index("by_installment", ["installmentId"])
    .index("by_status_dueAt", ["status", "dueAt"]),

  /**
   * Admin-managed expense categories (Story 4.7, FR40).
   *
   * Story 4.6 introduced expense recording with a hardcoded
   * `DEFAULT_EXPENSE_CATEGORIES` constant and an `IS_PLACEHOLDER`
   * sentinel banner. This table is the swap target: the admin manages
   * the active taxonomy here; `convex/lib/expenseCategories.ts`
   * helpers now read from this table (falling back to the hardcoded
   * defaults only when the table is empty — the bootstrap path).
   *
   * Architectural backbone: the deactivate-not-delete pattern.
   * Historical expense rows hold the category name as a denormalised
   * string at write time (the `expenses.category` field) — they never
   * point back to this table by id. Renaming a category therefore
   * does NOT retroactively update past expenses (financial-history
   * immutability). Deactivating hides the category from new-entry
   * dropdowns but preserves the historical name on every existing
   * record. Hard delete is permitted ONLY when no expense references
   * the category by name.
   *
   * Naming conventions (architecture § Naming Patterns):
   *   - `name` — human-readable label (1–50 chars). Trimmed on write.
   *   - `nameLowercased` — denormalised lower-case copy of `name` for
   *     case-insensitive uniqueness lookups. Convex has no functional
   *     index; this is the standard pattern (see `customers`).
   *   - `description` — optional free text (≤ 200 chars).
   *   - `isActive` — soft-deactivation flag. Deactivated categories
   *     are excluded from `getActiveCategories` (Story 4.6's helper)
   *     but remain queryable for historical reports.
   *   - `displayOrder` — reserved for future drag-to-reorder UX
   *     (Phase 2). Defaults to 0; harmless to ship now.
   *   - `createdAt` / `createdBy` — actor + timestamp attribution.
   *   - `lastModifiedAt` / `lastModifiedBy` — populated on every
   *     update / setActive / rename. Optional because freshly-created
   *     rows have nothing to record yet.
   *
   * Indexes:
   *   - `by_nameLowercased` — case-insensitive uniqueness check (the
   *     `checkNameAvailability` query + create/update guards).
   *   - `by_active_name` — list-page rendering ("active first, then
   *     inactive, sorted by name").
   *
   * Audit pattern: every mutation emits via `emitAudit` with
   * `entityType: "expense"` (categories are taxonomy for expenses —
   * the schema's `entityType` union does not carry a dedicated
   * `expenseCategory` value, and adding one is a follow-up that
   * requires updating both `auditLog` validator + `convex/lib/audit.ts`
   * `AuditEntityType` together).
   */
  expenseCategories: defineTable({
    name: v.string(),
    nameLowercased: v.string(),
    description: v.optional(v.string()),
    isActive: v.boolean(),
    displayOrder: v.optional(v.number()),
    createdAt: v.number(),
    createdBy: v.id("users"),
    lastModifiedAt: v.optional(v.number()),
    lastModifiedBy: v.optional(v.id("users")),
  })
    .index("by_nameLowercased", ["nameLowercased"])
    .index("by_active_name", ["isActive", "name"]),

  /**
   * Admin-configured expense approval thresholds — Story 6.6 (FR41).
   *
   * One row per expense-category name. A separate row keyed by the
   * sentinel `category === "__default__"` carries the catch-all
   * threshold applied to uncategorised expenses or categories that
   * have not been configured explicitly.
   *
   * Per-category opt-out: a row with `requiresApproval === false`
   * disables the workflow for that category regardless of amount —
   * useful for "Salaries" or other operationally-routine expenses
   * the admin trusts implicitly.
   *
   * Threshold semantics:
   *   - `thresholdCents` — expenses with `amountCents >= thresholdCents`
   *     are routed to `approvalStatus: "pending_approval"` on
   *     insert; expenses below the threshold are auto-approved.
   *     `thresholdCents === 0` means EVERY expense requires approval
   *     (when `requiresApproval === true`).
   *   - `requiresApproval === false` is the master switch for the
   *     category. The threshold is ignored.
   *
   * Default row: when `category === "__default__"`, the row supplies
   * the fallback used for categories not configured in this table.
   * Phase 1 default (seeded by the admin on first visit, or shipped
   * via a future bootstrap mutation): `requiresApproval: false,
   * thresholdCents: 0` — the workflow is OFF until the admin opts in,
   * preserving Phase 1 behaviour.
   *
   * Naming conventions (architecture § Naming Patterns):
   *   - `category` — string matching the category name stored on
   *     `expenses.category`. Case-sensitive (the category table itself
   *     enforces case-insensitive uniqueness on insert).
   *   - `thresholdCents` — INTEGER centavos (ADR-0007).
   *   - `requiresApproval` — boolean toggle for the category.
   *   - `updatedAt` / `updatedBy` — actor + timestamp on every
   *     mutation. Initial create still populates them so the audit
   *     trail has a uniform shape.
   *
   * Indexes:
   *   - `by_category` — primary lookup ("what is the threshold for
   *     Utilities?") used inside `recordExpense`.
   *
   * Audit pattern: every mutation emits via `emitAudit` with
   * `entityType: "expense"` (the `auditLog.entityType` union does not
   * carry a dedicated `expenseApprovalSetting` value; adding one
   * coordinates with the cornerstone owners). The `before` / `after`
   * payload carries the per-category detail.
   */
  expenseApprovalSettings: defineTable({
    category: v.string(),
    thresholdCents: v.number(),
    requiresApproval: v.boolean(),
    updatedAt: v.number(),
    updatedBy: v.id("users"),
  }).index("by_category", ["category"]),

  /**
   * Daily reconciliation invariant runs — Story 5.5 (FR60, NFR-R4).
   *
   * Append-only log of every reconciliation invariant check. One row per
   * (run, checkType) tuple — a single daily cron run produces up to three
   * rows, one for each of:
   *
   *   - "payments_match_allocations" — for every non-voided payment in the
   *     ledger, `sum(paymentAllocations.amountCents WHERE paymentId === p._id)
   *     === payments.amountCents`. The cornerstone's
   *     `ALLOCATION_SUM_MISMATCH` invariant proves this holds at write
   *     time; the reconciliation cron re-verifies it nightly against
   *     restore-from-backup / direct-DB-edit drift scenarios.
   *
   *   - "contract_total_ok" — for every contract, the sum of every
   *     contract- and installment-targeted allocation pointing at the
   *     contract (or its installments) MUST not exceed
   *     `contracts.totalPriceCents`. An over-applied contract would
   *     indicate a double-applied payment or a corrupted allocation
   *     row.
   *
   *   - "installment_paid_bounded" — for every installment row,
   *     `paidCents <= principalCents`. Bookkeeping bugs that "overpay"
   *     a single installment are the most common drift mode and the
   *     cheapest to detect.
   *
   * Status semantics:
   *   - "ok"   — zero discrepancies; the invariant holds.
   *   - "warn" — reserved for future fuzzy / advisory checks (e.g. an
   *              installment whose `paidCents === principalCents` but
   *              `status === "pending"`). No Phase-1 check produces
   *              "warn"; the literal is included so the schema is stable
   *              across future story additions.
   *   - "fail" — at least one discrepancy. The `summary.discrepancies`
   *              array carries the offending row ids + computed deltas.
   *
   * Field notes:
   *   - `runAt`         — unix ms of the run start (cron-driven or manual).
   *   - `checkType`     — one of the three invariant kinds above.
   *   - `status`        — three-state union; the dashboard surfaces non-"ok"
   *                       runs.
   *   - `summary`       — `v.any()` JSON blob carrying counts +
   *                       discrepancy details. Shape varies by checkType
   *                       (each check defines its own `discrepancies`
   *                       array shape inside `convex/reconciliation.ts`).
   *                       The top-level fields are always:
   *                         `{ checked: number, mismatches: number,
   *                            discrepancies: Array<...>, durationMs: number }`.
   *   - `triggeredBy`   — `"cron"` when the daily schedule fires, `"manual"`
   *                       when an admin invokes the on-demand mutation.
   *                       Optional because future automation may schedule
   *                       runs through a different path.
   *
   * Access discipline: this table is NEVER written to by application code
   * outside `convex/reconciliation.ts`. There is no in-file ESLint rule
   * enforcing the boundary in Phase 1 (cost/benefit on a single-writer
   * surface is low); a future story may add `local-rules/no-direct-
   * reconciliation-write` mirroring the audit-log + financial patterns
   * once a second consumer is contemplated.
   *
   * Indexes:
   *   - `by_runAt`           — most-recent-first listing for the dashboard
   *                             "last reconciliation run" indicator. Sorted
   *                             ascending; the dashboard reads
   *                             `.order("desc").take(1)`.
   *   - `by_checkType_runAt` — per-invariant history ("show me the last
   *                             7 days of contract_total_ok runs"). Surfaces
   *                             at the future failures-detail page; Phase 1
   *                             admin-only public query exposes only the
   *                             latest summary per check type.
   *
   * Retention: append-only, no delete. One run per day × three checks
   * ≈ 1,100 rows / year — negligible storage. A future Phase-2 archival
   * pass may move rows older than N years to cold storage; out of scope.
   */
  reconciliationRuns: defineTable({
    runAt: v.number(),
    checkType: v.union(
      v.literal("payments_match_allocations"),
      v.literal("contract_total_ok"),
      v.literal("installment_paid_bounded"),
    ),
    status: v.union(
      v.literal("ok"),
      v.literal("warn"),
      v.literal("fail"),
    ),
    summary: v.any(),
    triggeredBy: v.optional(
      v.union(v.literal("cron"), v.literal("manual")),
    ),
  })
    .index("by_runAt", ["runAt"])
    .index("by_checkType_runAt", ["checkType", "runAt"]),

  /**
   * Reconciliation drift register — Story 5.5 follow-up (FR60, NFR-R4).
   *
   * One row per detected drift entity. Distinct from `reconciliationRuns`
   * (which is the append-only PER-CHECK log): this table is a working
   * register the admin acts on. The daily cron upserts a row per
   * detected drift keyed by `entityId`, so re-detected drift updates
   * `discoveredAt` rather than producing N rows for the same root
   * entity. An admin acknowledges a row by setting `acknowledgedAt` +
   * `acknowledgedBy` via `acknowledgeReconciliationFailure`.
   *
   * Why a separate table:
   *   The dashboard banner needs a fast "count of unacknowledged
   *   failures" query without scanning `reconciliationRuns.summary`
   *   blobs. NFR-R4 ("≤ 2 hour visibility") is unsatisfiable if the
   *   only surface is buried in a JSON blob inside a runs row — the
   *   banner needs a top-level reactive count.
   *
   * Field notes:
   *   - `runId`         — `reconciliationRuns._id` that produced this
   *     row. Typed as `v.string()` to avoid a hard FK cycle with the
   *     runs table (the cron upserts before the runs row insert is
   *     visible across the mutation budget; the field is informational
   *     only — the read path does not dereference it).
   *   - `entityType`    — `"payment" | "contract" | "installment"`.
   *     Discriminator matching the three reconciliation checks.
   *   - `entityId`      — opaque `v.string()` because the row is
   *     polymorphic across `payments` / `contracts` / `installments`.
   *     Dedup key: the cron upserts on `(entityType, entityId)`.
   *   - `expectedCents` — invariant's expected amount in centavos.
   *   - `actualCents`   — actual computed amount in centavos.
   *   - `discoveredAt`  — unix ms of the most-recent detection. Updated
   *     on every upsert so the admin sees a fresh "discovered N
   *     minutes ago" stamp.
   *   - `firstDiscoveredAt` — unix ms of the FIRST detection. Set on
   *     insert; never overwritten. Surfaces "how long has this been
   *     drifting?" in the admin queue.
   *   - `acknowledgedAt`  — unix ms when an admin acknowledged the row.
   *     Absent on open rows.
   *   - `acknowledgedBy`  — admin user id who acknowledged. Absent on
   *     open rows.
   *   - `acknowledgmentNote` — optional free-text rationale from the
   *     acknowledging admin (≤ 500 chars). Captured for the audit
   *     trail.
   *
   * Indexes:
   *   - `by_acknowledged` — primary read path for the dashboard banner
   *     count + the admin queue listing (open rows first, sorted by
   *     `discoveredAt` via the in-handler sort).
   *   - `by_entity`       — upsert lookup keyed on `(entityType,
   *     entityId)` so the cron's "have we already detected this drift?"
   *     check is one index hit per failing row, not a table scan.
   */
  reconciliationFailures: defineTable({
    runId: v.string(),
    entityType: v.union(
      v.literal("payment"),
      v.literal("contract"),
      v.literal("installment"),
    ),
    entityId: v.string(),
    expectedCents: v.number(),
    actualCents: v.number(),
    discoveredAt: v.number(),
    firstDiscoveredAt: v.number(),
    acknowledgedAt: v.optional(v.number()),
    acknowledgedBy: v.optional(v.id("users")),
    acknowledgmentNote: v.optional(v.string()),
    /**
     * Unix ms when a subsequent reconciliation run found this drift had
     * DISAPPEARED (the entity now reconciles cleanly). Story 5.5 AC2
     * self-resolution: rather than deleting the row (which would erase
     * the forensic "this drifted between T1 and T2" trail), the run
     * stamps `resolvedAt` and the dashboard/queue stop counting it as
     * open. Re-detection of the same drift clears this back to absent.
     */
    resolvedAt: v.optional(v.number()),
  })
    .index("by_acknowledged", ["acknowledgedAt"])
    .index("by_entity", ["entityType", "entityId"]),

  /**
   * Dashboard counter summary docs — Story 5.2 adversarial-review
   * follow-up (AC5, NFR-P4 / NFR-P5).
   *
   * The Story 5.2 dashboard originally aggregated lot + contract
   * inventory tiles via `ctx.db.query("lots").collect()` /
   * `query("contracts").collect()` on every reactive re-evaluation. At
   * Phase 2 scale (~2,000 lots × N reactive subscribers) the full-table
   * scan blows the NFR-P4 / P5 latency budget — and Convex's reactive
   * fanout means EVERY write to either table triggers a re-evaluation
   * for every connected dashboard client.
   *
   * These two tables hold pre-aggregated counters maintained on every
   * lot / contract mutation. `getDashboardKpis` reads them O(1); if a
   * row is missing (fresh deploy, never written), the dashboard falls
   * back to a one-time recomputation that ALSO populates the summary
   * docs so subsequent loads stay fast.
   *
   * Schema shape:
   *   - One row per summary kind. The cardinality is "one row per
   *     enum value" rather than a single mega-doc so that Convex's
   *     index resolution can target a single document on read without
   *     bouncing through a parent doc + nested object.
   *   - `key` is the canonical enum literal (lot status / contract
   *     state). Indexed via `by_key` so the read path is a single
   *     `withIndex(..).eq("key", ...).first()`.
   *   - `count` is the live count of NON-retired rows whose status /
   *     state matches `key`.
   *   - `updatedAt` lets the dashboard surface "last refreshed"
   *     diagnostics and helps the bootstrap path detect a stale /
   *     missing summary that needs recomputation.
   *
   * Writers:
   *   - `convex/lib/dashboardCounters.ts` is the ONLY module allowed
   *     to write these tables in domain code. Lot mutations call the
   *     helpers; contract mutations call the helpers; the
   *     reconciliation-style recompute path also writes through the
   *     helpers. There is no ESLint rule yet enforcing the boundary
   *     (cost/benefit is low while writers fit on one hand).
   */
  dashboardCountersByLotStatus: defineTable({
    key: v.union(
      v.literal("available"),
      v.literal("reserved"),
      v.literal("sold"),
      v.literal("occupied"),
      v.literal("cancelled"),
      v.literal("defaulted"),
      v.literal("transferred"),
    ),
    count: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  dashboardCountersByContractState: defineTable({
    key: v.union(
      v.literal("active"),
      v.literal("paid_in_full"),
      v.literal("cancelled"),
      v.literal("voided"),
      v.literal("in_default"),
    ),
    count: v.number(),
    // Sum of `totalPriceCents` across contracts in this state. Used
    // for the AR balance tile (active + in_default sums). Stored
    // alongside the count so the dashboard's AR aggregate is also
    // O(summary-rows) rather than O(contracts).
    totalPriceCentsSum: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  /**
   * Email reminder log — Story 9.8 (FR57 email portion). DEPRECATED.
   *
   * ⚠️ LEGACY / NO WRITER. This was the Phase 1 stub log written by
   * `convex/actions/sendEmailReminders.ts` → `internal_sendEmailReminders`.
   * That stub (and its `send-email-reminders` cron) was RETIRED at the
   * email cut-over: the live system is the cadence scan
   * (`reminders.ts → internal_runDailyReminderScan`) writing to
   * `reminderDeliveries`, with the actual Resend dispatch in
   * `convex/actions/sendEmailReminder.ts`. The stub could not stay under
   * `convex/actions/` (Convex now requires `"use node"` there, which is
   * illegal in a mutation module), so it was removed. This table is
   * retained EMPTY for now to avoid a destructive schema migration; it
   * can be dropped in a dedicated migration once any historical rows are
   * archived. Nothing writes to it today.
   *
   * Historical context (the stub's original behaviour) — kept for the
   * eventual drop migration:
   *
   * Cadence rules (mirror Story 9.7's SMS rules):
   *   - `ruleOffset: -3` — installment due in 3 days, status pending.
   *   - `ruleOffset:  0` — installment due today, status pending.
   *   - `ruleOffset:  7` — installment 7 days past due, status overdue.
   *
   * Dedup is keyed by `(installmentId, ruleOffset)` — the scan checks
   * for an existing row before inserting, so re-running the cron on the
   * same day is a no-op. The `channel` field is fixed to `"email"` in
   * Phase 1 (SMS lives in a separate log when Story 9.7 ships); the
   * field is kept for future-proofing the dedup boundary.
   *
   * Body content (Phase 1):
   *   - `subject` — generic subject line; no PII per Story 9.8 §
   *     "No PII in email subjects."
   *   - `bodyPlain` — rendered plain-text body with `{name}`, `{amount}`,
   *     `{lotCode}`, `{date}` substitutions. Same body pattern as Story
   *     9.7's SMS templates; email-richer HTML lands when the real
   *     provider is wired.
   *
   * Access discipline: this table is NEVER written to outside
   * `convex/actions/sendEmailReminders.ts`. There is no public read
   * surface in this story; admins inspect via `npx convex run` until a
   * dashboard widget lands in a follow-on story.
   *
   * Indexes:
   *   - `by_installment_rule` — dedup probe on `(installmentId,
   *     ruleOffset)` before insert.
   *   - `by_sentAt` — most-recent-first listing for the future admin
   *     widget; sorted ascending, consumers read `.order("desc")`.
   *   - `by_customer` — "did customer X receive a reminder this week?"
   *     ad-hoc queries.
   *
   * Retention: append-only, no delete. At ~2000 customers × ~3 rules ×
   * ~36 installments lifetime ≈ at most ~200k rows over the lifetime of
   * the system. Negligible storage; archival is out of scope.
   */
  emailReminderLog: defineTable({
    customerId: v.id("customers"),
    contractId: v.id("contracts"),
    installmentId: v.id("installments"),
    channel: v.literal("email"),
    ruleOffset: v.number(),
    toEmail: v.string(),
    subject: v.string(),
    bodyPlain: v.string(),
    status: v.union(
      v.literal("stub_logged"),
      v.literal("skipped_no_email"),
      v.literal("sent"),
      v.literal("failed"),
    ),
    failureReason: v.optional(v.string()),
    sentAt: v.number(),
  })
    .index("by_installment_rule", ["installmentId", "ruleOffset"])
    .index("by_sentAt", ["sentAt"])
    .index("by_customer", ["customerId"]),

  /**
   * BIR monthly archival exports (Story 5.7 — FR62, NFR-R3 / NFR-C2).
   *
   * One row per (year, month) export. The cron-driven action in
   * `convex/birExport.ts:generateMonthlyBirExport` writes a CSV archive
   * of every receipt issued in the period to Convex File Storage and
   * inserts (or patches) the matching row here.
   *
   * The cemetery's BIR examiner needs the 10-year retention window —
   * Convex File Storage's product-level retention plus this admin-
   * visible index together satisfy NFR-R3 ("≥ 10-year retention of
   * receipts independent of Convex's 30-day operational backups"). The
   * S3 mirror noted in the story's longer-form spec is deferred — see
   * Dev Agent Record completion notes.
   *
   * Field notes:
   *   - `year` / `month` — calendar year + 1..12 month-of-year. The
   *     period is anchored to the Manila timezone (the action's period-
   *     bounds helper computes Manila start/end ms for the month).
   *   - `generatedAt` — unix ms timestamp the action completed.
   *   - `storageId` — Convex File Storage id for the CSV blob.
   *   - `status` — lifecycle flag. `pending` is the transient state
   *     between the row insert and the file being stored (the action
   *     also supports an idempotent re-run that overwrites the row).
   *     `ready` indicates the storage blob is available for download.
   *     `failed` is the explicit error state — the row stays so the
   *     admin can see the failure in `/admin/bir-exports` and retry.
   *   - `receiptCount` / `paymentCount` — record-count summary surfaced
   *     in the admin list so staff know the period was non-empty.
   *   - `sizeBytes` — uncompressed CSV size for capacity-planning.
   *   - `errorMessage` — populated when `status === "failed"`.
   *
   * Indexes:
   *   - `by_period` — fast lookup by (year, month) for idempotent re-
   *     run + cron-side "did we already export this period?" check.
   *   - `by_generatedAt` — admin list ordered most-recent-first.
   *
   * Immutability: rows are insert + patch only; we never delete the
   * row even on failure (the failure trail is part of the BIR audit
   * surface).
   */
  birExports: defineTable({
    year: v.number(),
    month: v.number(),
    generatedAt: v.number(),
    storageId: v.optional(v.id("_storage")),
    status: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    receiptCount: v.optional(v.number()),
    paymentCount: v.optional(v.number()),
    sizeBytes: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
  })
    .index("by_period", ["year", "month"])
    .index("by_generatedAt", ["generatedAt"]),

  /**
   * Payment-gateway intent records (Story 9.5 — GCash, FR33; Story 9.6
   * extends the table with Maya / card via the `provider` discriminator).
   *
   * Lifecycle:
   *   1. Customer initiates a portal payment. `portal.createGcashPaymentIntent`
   *      inserts a row with `status: "pending"`, a server-minted
   *      `intentId` (the customer-facing reference), and the destination
   *      `contractId` / `amountCents` snapshot.
   *   2. The customer is redirected to the gateway's hosted page. In
   *      Phase 1 this is a mock "GCash" placeholder under
   *      `/portal/pay/mock-gcash`; the real GCash sandbox swap at
   *      go-live is a credential + URL rotation, not a code rewrite.
   *   3. The gateway POSTs back to `/webhooks/gcash`. The HTTP route
   *      verifies the signature (stub in Phase 1) and routes the
   *      success event through `postFinancialEvent`. On success the
   *      row's `status` flips to `"succeeded"`, `completedAt` is
   *      stamped, and `paymentId` points at the newly-posted payment
   *      row.
   *
   * Idempotency: `by_intentId` is the dedup index. The webhook's first
   * action is a lookup on this index; if the row's `status` is already
   * `"succeeded"`, the handler short-circuits to a no-op 200 ACK so a
   * retried delivery cannot double-post.
   *
   * Field notes:
   *   - `provider` — `"gcash"` for Story 9.5; Story 9.6 widens to
   *     `"maya"` / `"card"`.
   *   - `intentId` — server-minted UUID (Phase 1 mock; real GCash
   *     replaces with the merchant API's payment-intent id at
   *     credential-swap time).
   *   - `customerId` — auth-resolved customer owner of the intent. The
   *     status query gates on this to prevent cross-customer polling.
   *   - `contractId` — destination contract (validated against the
   *     calling customer at creation time).
   *   - `amountCents` — snapshot of the customer's chosen amount. The
   *     webhook re-asserts this matches the gateway's reported amount
   *     before posting (defense against a compromised webhook source).
   *   - `status` — `"pending" | "succeeded" | "failed" | "expired"`.
   *     Status transitions are one-way (pending → terminal).
   *   - `completedAt` — set when the webhook posts the payment (success
   *     path) OR when the gateway reports a terminal failure.
   *   - `paymentId` — FK to the posted `payments` row. Only set on the
   *     success path.
   *   - `gatewayTransactionId` — the gateway's own transaction
   *     reference, captured from the webhook payload. Set on success
   *     and surfaced for reconciliation against gateway statements.
   *   - `failureReason` — set on the failure path; surfaced to the
   *     customer's return page.
   *
   * PII posture: this table stores NO PII beyond the customer's own
   * id linkage. No card numbers, no GCash account handles — the gateway
   * holds those. The webhook payload IS NOT persisted in full; only the
   * fields the system needs (gateway transaction id, amount, status).
   */
  paymentIntents: defineTable({
    provider: v.union(
      v.literal("gcash"),
      v.literal("maya"),
      v.literal("card"),
    ),
    intentId: v.string(),
    customerId: v.id("customers"),
    contractId: v.id("contracts"),
    amountCents: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("expired"),
    ),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
    paymentId: v.optional(v.id("payments")),
    gatewayTransactionId: v.optional(v.string()),
    failureReason: v.optional(v.string()),
    // Story 9.5 / 9.6 addition — the gateway's hosted-checkout URL
    // the customer's browser is redirected to. Patched onto the row
    // by `convex/actions/gatewayCreateIntent.ts` after the gateway's
    // `createIntent` API returns. The `/portal/pay/return` page reads
    // this via `getCustomerPaymentIntent` and navigates the customer
    // to the URL while `status === "pending"`. The query stops
    // exposing the URL once the intent reaches a terminal state so
    // stale navigation cannot resurrect a closed intent.
    redirectUrl: v.optional(v.string()),
    // Story 9.6 — the gateway-supplied intent / checkout id (distinct
    // from the gateway's eventual `transactionId` returned on the
    // webhook). Captured for reconciliation against gateway
    // statements when the intent never reaches a terminal state.
    gatewayIntentId: v.optional(v.string()),
  })
    .index("by_intentId", ["intentId"])
    .index("by_customer", ["customerId"])
    .index("by_contract", ["contractId"])
    .index("by_status_createdAt", ["status", "createdAt"]),

  /**
   * SMS reminder delivery log — Story 9.7 (FR57 SMS portion, Phase 1 stub).
   *
   * Append-only record of every reminder the daily SMS-reminder scan
   * (`convex/actions/sendSmsReminders.ts` → `internal_sendSmsReminders`)
   * decided to dispatch. In Phase 1 the Twilio / PH-local provider call
   * is STUBBED — the scan inserts one row per `(installmentId, ruleOffset)`
   * match with `status: "logged"` and the rendered SMS body. The full
   * Story 9.7 surface (cadence config table, retry/backoff, opt-out
   * toggle, admin settings UI) is intentionally deferred per the scoped
   * Phase 1 brief; this table is the entire observability artefact until
   * the real provider integration lands.
   *
   * Cadence rules the scan applies (scoped brief):
   *   - `ruleOffset: -7` — installment due in 7 days, status pending.
   *   - `ruleOffset:  0` — installment due today, status pending.
   *   - `ruleOffset:  3` — installment 3 days past due, status overdue.
   * Each `(installmentId, ruleOffset)` pair is exactly-once: the dedup
   * scan walks `by_installment_sentAt` for an existing row with the same
   * offset before scheduling a new send, so a re-run of the cron inside
   * the same day is a no-op.
   *
   * Body content (Phase 1):
   *   - `body` — fully-rendered SMS text (template: "Reminder: Your
   *     installment of PHP X is due on Y at Broadheader Memorial Park.
   *     Thank you."). Storing the rendered body lets the runbook
   *     reconstruct "what would the customer have received" without
   *     re-running the scan against current data.
   *
   * Access discipline: this table is NEVER written to outside
   * `convex/actions/sendSmsReminders.ts`. There is no public read surface
   * in this scoped story; admins inspect via `npx convex run` until a
   * dashboard widget lands in the follow-on full-story implementation.
   *
   * Schema:
   *   - `recipientPhone` — the customer's stored phone string at scan
   *     time. The scan skips customers without a phone before insert so
   *     this field is always present.
   *   - `body` — rendered SMS body (see above).
   *   - `installmentId` — the installment the reminder is for. FK linkage
   *     to `installments`.
   *   - `ruleOffset` — integer days from the rule. Dedup key component.
   *   - `sentAt` — epoch ms the scan inserted the row.
   *   - `status` — `"logged"` for the Phase 1 stub. Reserved `"sent"` /
   *     `"failed"` literals match the future Twilio integration so the
   *     migration is additive.
   *
   * Indexes:
   *   - `by_installment_sentAt` — primary dedup probe. The scan walks
   *     this index per candidate installment to detect prior emissions
   *     for the same `(installmentId, ruleOffset)` pair before inserting
   *     another. The brief explicitly names the index after `sentAt` (not
   *     `ruleOffset`) to keep the schema surface narrow; dedup walks the
   *     index by `installmentId` and filters `ruleOffset` in-handler.
   *   - `by_status_sentAt` — runbook visibility ("most recent logged /
   *     failed reminders") and the lookup surface for the future admin
   *     "recent reminder failures" tile.
   */
  smsReminderLog: defineTable({
    recipientPhone: v.string(),
    body: v.string(),
    installmentId: v.id("installments"),
    ruleOffset: v.number(),
    sentAt: v.number(),
    status: v.union(
      v.literal("logged"),
      v.literal("sent"),
      v.literal("failed"),
    ),
  })
    .index("by_installment_sentAt", ["installmentId", "sentAt"])
    .index("by_status_sentAt", ["status", "sentAt"]),

  /**
   * Story 5.7 — monthly archival exports for BIR 10-year retention
   * (FR62, NFR-R3, NFR-C2).
   *
   * Companion to the existing `birExports` (CSV / receipts-only narrowed
   * Phase-1 surface) — `archivalExports` is the FULL-LEDGER monthly
   * archive: receipts + payments + customers + contracts serialised as
   * compressed JSON, stored in Convex File Storage with a deterministic
   * filename `archives/{YYYY-MM}.json.gz`, and optionally mirrored to
   * an S3-compatible bucket the cemetery controls. One row per
   * (period) tuple; the period is `"YYYY-MM"` anchored to Manila tz.
   *
   * Why a separate table from `birExports`:
   *   - Different content (receipts CSV vs. full-ledger JSON) and
   *     different retention horizon (operational visibility vs. 10-year
   *     regulatory archive).
   *   - The two coexist intentionally: the `/admin/bir-exports` page
   *     surfaces the narrow CSV for spreadsheet auditors; the
   *     `/admin/archival-exports` page surfaces the full archive for
   *     long-tail BIR retention + vendor-independent recovery
   *     (Story 5.6's operational backup is the 30-day floor; this
   *     story extends the horizon to 10 years).
   *
   * Field notes:
   *   - `period` — `"YYYY-MM"` (e.g. `"2026-05"`). The period is
   *     anchored to Manila timezone — the archival action computes
   *     period bounds via `convex/lib/archivalPeriods.ts`.
   *   - `storageId` — Convex File Storage id for the gzipped JSON
   *     blob. Always present after a successful export.
   *   - `sha256` — SHA-256 of the gzipped (compressed) blob,
   *     hex-encoded. Recorded so a future restorer can verify
   *     integrity without re-running the export.
   *   - `sizeBytesUncompressed` / `sizeBytesCompressed` — capacity-
   *     planning + drift detection over time. The first real export
   *     pins the actual ratio.
   *   - `recordCounts` — per-entity counts so the admin listing can
   *     render "R/P/C/Co" badges without re-reading the blob.
   *   - `exportedAt` — unix ms when the action wrote the row. Distinct
   *     from `_creationTime` to keep the action-side timestamp under
   *     application control.
   *   - `s3Status` — `"uploaded" | "failed" | "skipped"`. `"skipped"`
   *     when `ARCHIVE_S3_BUCKET` is unset (S3 mirror is opt-in).
   *     `"failed"` when the upload threw — `s3ErrorMessage` carries
   *     the captured error so the admin UI surfaces the failure for
   *     manual retry.
   *   - `s3Etag` / `s3UploadedAt` — populated on the upload success
   *     path. The ETag is S3's MD5 for non-multipart uploads (which
   *     our < 100MB monthly blobs always are).
   *
   * Indexes:
   *   - `by_period` — idempotent-rerun guard + admin listing lookups
   *     by year/month.
   *   - `by_exportedAt` — listing ordering ("most recent at the top").
   *
   * Immutability: rows are insert + patch only; we never delete a row
   * (the failure trail is part of the BIR audit surface). Files in
   * Convex File Storage are append-only by design.
   *
   * S3 retention: 10-year horizon is enforced by the S3 bucket's
   * lifecycle policy configured at the cemetery's S3 console — NOT
   * from this codebase. See `docs/adr/0018-archival-export.md` and the
   * runbook for the lifecycle-rule JSON.
   */
  archivalExports: defineTable({
    period: v.string(),
    storageId: v.id("_storage"),
    sha256: v.string(),
    sizeBytesUncompressed: v.number(),
    sizeBytesCompressed: v.number(),
    recordCounts: v.object({
      receipts: v.number(),
      payments: v.number(),
      customers: v.number(),
      contracts: v.number(),
    }),
    exportedAt: v.number(),
    s3Status: v.optional(
      v.union(
        v.literal("uploaded"),
        v.literal("failed"),
        v.literal("skipped"),
      ),
    ),
    s3Etag: v.optional(v.string()),
    s3UploadedAt: v.optional(v.number()),
    s3ErrorMessage: v.optional(v.string()),
  })
    .index("by_period", ["period"])
    .index("by_exportedAt", ["exportedAt"]),

  /**
   * Singleton admin settings — Story 6.3 (FR45).
   *
   * One-row table keyed by the literal `"singleton"` discriminator. The
   * row is the runtime config knob for cross-cutting Phase 2 admin
   * toggles that are NOT environment-variables (the cemetery can flip
   * them without a redeploy):
   *
   *   - `salesAgentTrackingEnabled` — gate for the sales-by-dimension
   *     report's agent-breakdown branch (§10 Q5 pending). Default
   *     `false` so the conditional branch is off until the cemetery
   *     answers Q5.
   *
   * Future Phase 2 toggles land here as additional optional fields.
   * Optionality keeps pre-existing rows valid without backfill (the
   * read path treats missing fields as their "off" / default value).
   *
   * Read pattern: `ctx.db.query("appSettings").withIndex("by_key", q =>
   * q.eq("key", "singleton")).first()`. When the row is absent (fresh
   * deployment / first read) the caller synthesizes a default-valued
   * settings object — see `convex/reports.ts → readAppSettings`. The
   * setter mutation (`reports.setSalesAgentTracking`) is the only
   * write path; it upserts the singleton row.
   */
  appSettings: defineTable({
    key: v.literal("singleton"),
    salesAgentTrackingEnabled: v.optional(v.boolean()),
  }).index("by_key", ["key"]),

  /**
   * Perpetual care policy — Story 3.8 rebuild (FR25).
   *
   * Single-row singleton table that owns the cemetery-wide perpetual-care
   * pricing policy. Sale-path mutations (`recordFullPaymentSale`,
   * `recordInstallmentSale`) DERIVE the per-contract perpetual-care fee
   * from this row at sale time — operators no longer supply the fee as
   * a per-sale input.
   *
   * Policy types:
   *   - "one_time"  — single fee at sale, varies by lot type. Looked up
   *                   from `oneTimeFeesByLotType` (e.g. single ₱5000,
   *                   family ₱5000, mausoleum ₱10000, niche ₱0).
   *   - "annual"    — recurring per-year fee. Phase 2 hook; the sale
   *                   path records `perpetualCareCents: 0` and the
   *                   annual billing scheduler (out of scope here)
   *                   bills the customer separately on its own cadence.
   *   - "none"      — perpetual care is not collected.
   *
   * §10 Q7 placeholder flag: until the cemetery confirms the policy,
   * the seed inserts a row with `isPlaceholder: true` and the Q7
   * defaults pre-filled. `loadPerpetualCarePolicy` (sale-path helper)
   * REFUSES to run while the flag is true to prevent silent fee creep.
   * The admin clears the placeholder by saving the form with the
   * confirmation toggle flipped.
   *
   * Indexes:
   *   - `by_singleton` — the table only ever has one row. Queries use
   *     `.first()`; the index exists for parity with other singleton
   *     tables and supports a future `.withIndex` form.
   */
  perpetualCarePolicy: defineTable({
    type: v.union(
      v.literal("one_time"),
      v.literal("annual"),
      v.literal("none"),
    ),
    oneTimeFeesByLotType: v.optional(
      v.array(
        v.object({
          lotType: v.string(),
          feeCents: v.number(),
        }),
      ),
    ),
    annualFeeCents: v.optional(v.number()),
    annualBillingStartMonthsAfterSale: v.optional(v.number()),
    isPlaceholder: v.boolean(),
    updatedAt: v.number(),
    updatedBy: v.id("users"),
  }),

  /**
   * Report-export job tracking — Story 6.4 (FR46).
   *
   * One row per export request. The row is the audit-trail anchor for
   * the "Admin X exported data Y on date Z" compliance question
   * (NFR-S7 / NFR-C4) PLUS the reactive surface the UI subscribes to
   * while the Node-runtime action renders the file in the background.
   *
   * Lifecycle:
   *   1. UI calls `requestExport({ reportType, args, format })` —
   *      mutation inserts the row with `status: "pending"` and
   *      schedules `convex/actions/generateReportExport.ts`.
   *   2. Action fetches data via the matching internal report query,
   *      renders XLSX (CSV in Phase 2 — no exceljs dep) or PDF (PDFKit)
   *      bytes, stores via `ctx.storage.store()`, calls internal
   *      mutation `_markReady({ exportRowId, blobId })`. Row flips to
   *      `status: "ready"`.
   *   3. On failure: internal mutation `_markFailed` increments
   *      `retryCount` + sets `status: "failed"`. The 5-minute sweep
   *      reschedules pending/failed rows until `retryCount >= 3`.
   *   4. 30-day cleanup sweep marks `ready` rows older than 30 days
   *      as `status: "expired"` and deletes the underlying blob.
   *      The ROW PERSISTS — audit trail of "who exported what when"
   *      is itself a compliance artefact.
   *
   * Field notes:
   *   - `reportType` — string-literal union enumerating the supported
   *     reports. Phase 2 ships `sales_by_dimension`, `ar_aging`, and
   *     `audit_log`; extending the enum requires updating BOTH this
   *     validator and the adapter map in `convex/exports.ts`.
   *   - `args` — `v.any()` JSON blob carrying the per-report filter
   *     args (date range, bucket filter, etc.). Re-validated at
   *     action time before re-running the underlying query so a
   *     tampered row cannot bypass the report query's own validators.
   *   - `format` — `"xlsx"` (CSV-as-xlsx in Phase 2 — no exceljs dep
   *     per Story 6.4's "no new npm deps" Phase 2 reservation; opens
   *     natively in Excel/Sheets/Numbers) or `"pdf"` (PDFKit reused).
   *   - `status` — `pending`/`ready`/`failed`/`expired`. One-way
   *     transitions; the action + scheduled sweep are the only writers.
   *   - `blobId` — optional `Id<"_storage">` set when the action
   *     completes successfully. Cleared on cleanup (but the row stays).
   *   - `requestedBy` / `requestedAt` — actor + insertion timestamp
   *     (server-set inside the mutation).
   *   - `readyAt` — populated when the action transitions to `ready`.
   *     Optional because pending/failed/expired rows have nothing yet.
   *   - `downloadCount` — incremented by `getExportDownloadUrl` so
   *     Phase 2 kickoff retros can see what's actually being exported.
   *   - `retryCount` — incremented per failed run; the 5-minute sweep
   *     stops rescheduling once it hits 3.
   *   - `lastError` — free-text error message from the last failed run.
   *     Surfaced in the UI's "retry" affordance.
   *
   * Indexes:
   *   - `by_requestedBy_requestedAt` — primary list path for the "My
   *     exports" page (`listMyExports`).
   *   - `by_status_requestedAt` — sweep paths (retry sweep filters by
   *     `status IN ("pending", "failed")`; cleanup sweep filters by
   *     `status === "ready"`).
   */
  exports: defineTable({
    reportType: v.union(
      v.literal("sales_by_dimension"),
      v.literal("ar_aging"),
      v.literal("audit_log"),
    ),
    args: v.any(),
    format: v.union(v.literal("xlsx"), v.literal("pdf")),
    status: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("failed"),
      v.literal("expired"),
    ),
    blobId: v.optional(v.id("_storage")),
    requestedBy: v.id("users"),
    requestedAt: v.number(),
    readyAt: v.optional(v.number()),
    downloadCount: v.number(),
    retryCount: v.number(),
    lastError: v.optional(v.string()),
    /**
     * Epoch ms of the most recent `ctx.scheduler.runAfter` invocation
     * for this row's action. Set by `requestExport` on initial schedule
     * and by `internal_retrySweep` on re-schedule. The sweep uses this
     * field as an optimistic-claim marker — two sweep firings observing
     * the same `pending` row within ~5 minutes will see a fresh
     * `scheduledAt` and skip the row, preventing a double schedule.
     */
    scheduledAt: v.optional(v.number()),
  })
    .index("by_requestedBy_requestedAt", ["requestedBy", "requestedAt"])
    .index("by_status_requestedAt", ["status", "requestedAt"]),

  /**
   * Reminder cadence config — Story 9.7 (FR57).
   *
   * Single-row admin-managed configuration that drives the daily
   * reminder scan. The cron mutation reads `.first()` from this table;
   * if no row exists the scan is a no-op (the admin has not yet
   * configured cadence).
   *
   * Rule shape (per element of `rules`):
   *   - `daysOffset`     — negative = days BEFORE due, 0 = on due day,
   *                        positive = days AFTER due. A rule with
   *                        `daysOffset: -3` fires on installments whose
   *                        `dueDate` is 3 days from now; a rule with
   *                        `daysOffset: 7` fires on installments due 7
   *                        days ago.
   *   - `requiresUnpaid` — when true, the rule only fires for
   *                        installments whose `status !== "paid"`. The
   *                        common case (every cadence rule should
   *                        skip already-paid installments).
   *   - `channel`        — `"sms" | "email" | "both"`. Story 9.7 wires
   *                        the SMS path; Story 9.8 extends the scan
   *                        for the email branch. `"both"` fires both
   *                        channels in the same scan iteration; the
   *                        dedup index keys on `(installmentId,
   *                        daysOffset, channel)` so the two channels
   *                        never collide.
   *   - `templateKey`    — string identifier looked up from
   *                        `convex/lib/reminderTemplates.ts`. Keys are
   *                        per-channel (e.g. `upcoming_due_3d` for SMS,
   *                        `upcoming_due_3d_email` for email); a rule
   *                        with `channel: "both"` resolves the SMS key
   *                        for the SMS row and the matching `_email`
   *                        sibling for the email row.
   *   - `enabled`        — soft-disable flag. Admins can disable a rule
   *                        without deleting it (preserving the audit
   *                        history of "what was the cadence on date X").
   *
   * The whole `rules` array is rewritten on every admin save (versus
   * patching individual rules in place). This keeps the atomic-write
   * semantics simple — a save is one mutation, one audit row.
   *
   * `timezone` is `"Asia/Manila"` for the pilot cemetery; the cron
   * itself runs at the configured Manila wall-clock hour (default
   * 09:00) — the cron entry in `convex/crons.ts` translates to UTC.
   *
   * No index needed — the table has at most one row. Queries always
   * read via `ctx.db.query("reminderConfig").first()`.
   */
  reminderConfig: defineTable({
    rules: v.array(
      v.object({
        daysOffset: v.number(),
        requiresUnpaid: v.boolean(),
        channel: v.union(
          v.literal("sms"),
          v.literal("email"),
          v.literal("both"),
        ),
        templateKey: v.string(),
        enabled: v.boolean(),
      }),
    ),
    timezone: v.string(),
    sendHour: v.number(),
    updatedAt: v.number(),
    updatedBy: v.id("users"),
    // P1-5 — global reminders kill switch. When `true`, the daily
    // scan (`internal_runDailyReminderScan`) short-circuits at the
    // top and logs "reminders paused, skipping scan." The admin flips
    // this via `setRemindersPaused({ paused: boolean })` (admin-only).
    // The flag is intentionally NOT modelled as per-rule
    // `enabled: false` toggles — a single deployment-wide stop is
    // faster to flip in a deliverability incident, and easier to
    // verify at a glance ("reminders are paused" vs. "every individual
    // rule is off"). Optional so pre-existing seeded rows remain
    // schema-valid without backfill.
    paused: v.optional(v.boolean()),
  }),

  /**
   * Reminder delivery rows — Story 9.7 (FR57, NFR-I3).
   *
   * One row per (installment, rule, channel) reminder the scan decides
   * to dispatch. The row is the entire idempotency anchor:
   *
   *   - The `by_installment_rule` index keys on `(installmentId,
   *     ruleOffset, channel)` so the scan probes for an existing row
   *     before scheduling a new send. Re-running the cron on the same
   *     day with no new matches is a no-op.
   *
   *   - The same installment legitimately receives reminders across
   *     multiple rules (e.g. `-3d` AND `0d` AND `+7d`) — the dedup is
   *     per-rule, not per-installment.
   *
   *   - SMS and email for the same `(installment, rule)` pair are
   *     separate rows because `channel` is part of the dedup key. A
   *     rule with `channel: "both"` produces two delivery rows.
   *
   * Lifecycle (mirrors NFR-I3 — 3 attempts over 24h):
   *
   *   - `queued`             — scan inserted the row + scheduled the
   *                            send action. Default state on insert.
   *   - `sending`            — provider call in flight. Reserved for
   *                            observability; the action transitions
   *                            directly from `queued` to a terminal
   *                            state on the same scheduled run today.
   *   - `sent`               — provider returned success;
   *                            `providerMessageId` + `sentAt` set.
   *   - `failed`             — provider returned a transient error
   *                            (5xx, network timeout). The action
   *                            increments `attempt`, appends to
   *                            `providerError`, and re-schedules per
   *                            the backoff curve (immediate → 4h →
   *                            24h). Status returns to `queued` on
   *                            re-schedule.
   *   - `permanent_failure`  — three retries exhausted OR a 4xx
   *                            provider response (invalid number,
   *                            opt-out, invalid email). No further
   *                            retries; surfaces in the admin
   *                            dashboard.
   *
   * Field notes:
   *   - `customerId` / `contractId` / `installmentId` — strong FKs.
   *     Stored to short-circuit the action's hydration path.
   *   - `channel` — `"sms"` (Story 9.7) or `"email"` (Story 9.8).
   *   - `templateKey` — the resolved template, stored at scan time so
   *     the action doesn't need to re-resolve the cadence config.
   *   - `ruleOffset` — copy of the rule's `daysOffset` for dedup
   *     keying. The rule's other fields are immaterial to the dedup.
   *   - `attempt` — 1-indexed retry counter. NFR-I3 budgets 3
   *     attempts total before the row transitions to
   *     `permanent_failure`.
   *   - `providerMessageId` — Twilio SID / Resend message id captured
   *     on success. Used to correlate delivery / bounce webhooks.
   *   - `providerError` — last error message string from the
   *     provider. Set on every failed attempt for forensic visibility.
   *   - `scheduledAt` — epoch ms the scan inserted the row.
   *   - `sentAt` — epoch ms the action received a `sent` response.
   *   - `failedAt` — epoch ms the row transitioned to
   *     `permanent_failure`.
   *   - `nextAttemptAt` — epoch ms of the next retry attempt (when
   *     `status === "queued"` after a transient failure).
   *
   * Indexes:
   *   - `by_installment_rule` — `(installmentId, ruleOffset, channel)`.
   *     Primary dedup probe before insert.
   *   - `by_customer` — admin "show all reminders for customer X".
   *   - `by_status_scheduledAt` — admin dashboard widget surfacing
   *     recent failures + pending deliveries.
   *   - `by_channel_status` — channel-specific reporting (e.g. "all
   *     email permanent failures last 30 days").
   */
  reminderDeliveries: defineTable({
    customerId: v.id("customers"),
    contractId: v.id("contracts"),
    installmentId: v.id("installments"),
    channel: v.union(v.literal("sms"), v.literal("email")),
    templateKey: v.string(),
    ruleOffset: v.number(),
    attempt: v.number(),
    status: v.union(
      v.literal("queued"),
      v.literal("sending"),
      v.literal("sent"),
      v.literal("failed"),
      v.literal("permanent_failure"),
    ),
    providerMessageId: v.optional(v.string()),
    providerError: v.optional(v.string()),
    scheduledAt: v.number(),
    sentAt: v.optional(v.number()),
    failedAt: v.optional(v.number()),
    nextAttemptAt: v.optional(v.number()),
  })
    .index("by_installment_rule", ["installmentId", "ruleOffset", "channel"])
    .index("by_customer", ["customerId"])
    .index("by_status_scheduledAt", ["status", "scheduledAt"])
    .index("by_channel_status", ["channel", "status"]),

  /**
   * BIR receipt configuration — Story 3.11 adversarial-review follow-up
   * (FR28, NFR-C1).
   *
   * Singleton table carrying the cemetery's legally-registered BIR
   * (Bureau of Internal Revenue) identity used on every issued Official
   * Receipt. Replaces the hard-coded `PLACEHOLDER_BIR_CONFIG` constant
   * that previously lived in `convex/lib/birFormat.ts` — every receipt
   * issued from that constant was BIR-non-compliant by construction
   * (placeholder TIN, placeholder ATP, missing mandatory footer text).
   *
   * One row per deployment. The seed mutation
   * (`convex/internal/seedBirReceiptConfig.ts`) inserts a starter row
   * with `isPlaceholder: true`; the admin settings page
   * (`/admin/settings/bir-receipt-config`) is the only edit surface,
   * and the destructive-styled "Mark as production-ready" toggle is
   * the only way to flip `isPlaceholder` to `false`.
   *
   * BIR-compliance contract — the receipt PDF action
   * (`convex/actions/generateReceiptPdf.ts`) MUST refuse to render a
   * receipt while `isPlaceholder === true`. The action's hydrator
   * (`receipts:getReceiptForPdf`) loads the singleton and throws
   * `INVARIANT_VIOLATION` with `kind: "bir_not_configured"` if the row
   * is missing OR placeholder — receipt issuance halts loudly rather
   * than producing legally-invalid documents.
   *
   * Field notes:
   *   - `registeredName` — the BIR-registered legal-entity name (e.g.
   *     "Cases Land Inc."). NOT the customer-facing trade name. Printed
   *     verbatim in the receipt header per BIR convention.
   *   - `tradeName` — optional doing-business-as name customers
   *     recognise (e.g. "Apostle Paul Memorial Park"). When present
   *     the receipt renders it beneath the registered name.
   *   - `tin` — 12-digit Tax Identification Number, no separators.
   *     `birFormat:formatTin` is the canonical display formatter.
   *   - `registeredAddressLines` — the BIR-registered postal address
   *     as an array of pre-split lines. DISTINCT from the brand-layer
   *     `CEMETERY_ADDRESS_LINES` (which is the customer-facing
   *     marketing address). The brand wordmark / dove-laurel mark
   *     stays on the receipt for visual identity, but the
   *     legally-required address block reads from THIS field.
   *   - `atpNumber` — Authority to Print / Permit to Use reference
   *     issued by BIR for the receipt booklet/series.
   *   - `atpExpiryDate` — epoch ms when the ATP expires. Surfaces in
   *     the mandatory BIR footer ("VALID FOR FIVE (5) YEARS FROM THE
   *     DATE OF THE PERMIT TO USE") so cashiers can spot a stale
   *     permit before it lapses.
   *   - `serialRangeStart` / `serialRangeEnd` — the BIR-approved
   *     serial range for the booklet/series (e.g. "0000001" .. "9999999").
   *     Stored as strings to preserve any leading zeros / prefix shape
   *     the operator entered; the receipt counter (`receiptCounter`
   *     table, owned by `convex/lib/receiptCounter.ts`) is the
   *     authoritative monotonic source.
   *   - `vatRate` — VAT percentage (e.g. 12 for 12%). Optional / null
   *     when the cemetery is VAT-exempt. The receipt VAT block
   *     conditions on `isVatRegistered` (below); the rate is the
   *     display value only.
   *   - `isVatRegistered` — boolean toggle controlling the VAT
   *     breakdown block on the receipt. When `false` the breakdown is
   *     omitted entirely (VAT-exempt sellers must not show a VAT block
   *     per BIR rules).
   *   - `isPlaceholder` — production-readiness gate. SEEDED as `true`;
   *     admin flips to `false` from the settings page ONLY after every
   *     other field has been verified against the actual BIR documents.
   *     The receipt PDF action throws when this is `true` — every
   *     receipt issued from this config is BIR-non-compliant otherwise.
   *   - `updatedAt` / `updatedBy` — audit attribution for the most
   *     recent admin edit. Each save also emits an `auditLog` row via
   *     `emitAudit` for the full change history.
   *
   * Index: `by_singleton` is an empty-key index so the singleton
   * read (`ctx.db.query("birReceiptConfig").withIndex("by_singleton").first()`)
   * is O(1) without requiring callers to remember the table is single-row.
   */
  birReceiptConfig: defineTable({
    registeredName: v.string(),
    tradeName: v.optional(v.string()),
    tin: v.string(),
    registeredAddressLines: v.array(v.string()),
    atpNumber: v.string(),
    atpExpiryDate: v.number(),
    serialRangeStart: v.string(),
    serialRangeEnd: v.string(),
    vatRate: v.optional(v.number()),
    isVatRegistered: v.boolean(),
    isPlaceholder: v.boolean(),
    updatedAt: v.number(),
    updatedBy: v.id("users"),
  }),

  /**
   * Memorial plaque draft revisions (Story 6.8, FR49).
   *
   * One row per generated plaque-preview PDF. The cemetery's office
   * staff produce these for the family to review BEFORE the stonemason
   * engraves the actual plaque; families often iterate on the epitaph
   * across multiple revisions, so the table is intentionally
   * VERSIONED — every regeneration inserts a new row rather than
   * overwriting the prior one. The family may want to compare v1 vs.
   * v3 epitaphs; preserving every draft is a legal-courtesy invariant,
   * not just a feature (see Story 6.8 § Disaster prevention).
   *
   * Lifecycle (mirrors Story 6.1's contract PDF retry pattern):
   *   - `pending` — row inserted, action scheduled, blob not yet stored.
   *   - `ready`   — action completed and `_recordPlaqueReady` patched in
   *                 the `pdfStorageId`.
   *   - `failed`  — action threw and `_recordPlaqueFailed` patched the
   *                 row with `lastError`. The retry sweep in
   *                 `convex/pdfRetrySweep.ts` re-schedules `pending` /
   *                 `failed` rows whose `retryCount < 3`; rows past the
   *                 cap require an admin "Retry" click via the
   *                 plaque-page draft-history rail.
   *
   * Field notes:
   *   - `intermentId` — strong FK to `interments`. The plaque page
   *     anchors to a specific interment so the deceased's name + dates
   *     are derivable from the joined occupant record by default.
   *   - `deceasedName` — operator-entered free text (the form prefills
   *     from the occupant row but lets the operator override for legacy
   *     records / nickname variations). Rendered uppercase on the
   *     plaque; stored AS ENTERED so the original casing survives.
   *   - `bornYear` / `diedYear` — 4-digit calendar years in
   *     `[1800, currentYear + 1]`. Integers, not timestamps — the
   *     plaque shows years only (the brand spec § Chapter VII shows
   *     the canonical "1942 — 2026" form). Storage as integers is
   *     independent of the Roman-vs-Arabic toggle; the action handles
   *     the render-time conversion via `convex/lib/roman.ts:toRoman`.
   *   - `dateFormat` — render-time choice: `"arabic"` (1942 — 2026) or
   *     `"roman"` (MCMXLII — MMXXVI). Per-draft so families can compare
   *     formats across revisions.
   *   - `epitaph` — optional italic-serif inscription. Max 240 chars —
   *     the brand guide shows a 3-line maximum on the physical plaque
   *     and 240 chars loosely approximates that limit; the cap is
   *     brand-system-enforced.
   *   - `version` — 1-indexed per interment. The mutation computes
   *     `nextVersion = (maxExisting?.version ?? 0) + 1` via
   *     `by_interment_version`. NEVER overwritten.
   *   - `pdfStorageId` / `pdfStatus` / `retryCount` / `lastError` —
   *     PDF lifecycle bookkeeping mirroring Story 6.1's contract-PDF
   *     pattern. The `by_status` index supports the retry sweep.
   *   - `generatedBy` / `generatedAt` — actor + wall-clock at insert.
   *     Surfaces on the draft-history rail ("v2 — by Maria Cruz at
   *     2026-05-24 14:32 Manila").
   *
   * Audit pattern: every mutation emits to `auditLog` with
   * `entityType: "lot"` (the lot is the canonical aggregate root for
   * the interment + occupant + plaque chain) — matches the
   * `occupants` / `interments` precedent. The `auditLog.entityType`
   * enum doesn't include "interment" or "plaque"; the lot groups all
   * sub-events for unified per-lot history queries.
   *
   * Indexes:
   *   - `by_interment_version` — primary read path for the draft-
   *     history rail and the `nextVersion` lookup inside
   *     `requestPlaqueDraft`. Sorted by `version` ascending; the rail
   *     reverses for "newest first" display.
   *   - `by_status` — retry-sweep parity with Story 6.1. The cron in
   *     `convex/pdfRetrySweep.ts` scans `pending` + `failed` rows whose
   *     `retryCount < 3`.
   */
  plaqueDrafts: defineTable({
    intermentId: v.id("interments"),
    deceasedName: v.string(),
    bornYear: v.number(),
    diedYear: v.number(),
    dateFormat: v.union(v.literal("arabic"), v.literal("roman")),
    epitaph: v.optional(v.string()),
    version: v.number(),
    pdfStorageId: v.optional(v.id("_storage")),
    pdfStatus: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    generatedBy: v.id("users"),
    generatedAt: v.number(),
    retryCount: v.number(),
    lastError: v.optional(v.string()),
  })
    .index("by_interment_version", ["intermentId", "version"])
    .index("by_status", ["pdfStatus"]),

  /**
   * Customer-portal login rate-limit ledger — Story 9.1 adversarial
   * review follow-up (NFR-S6).
   *
   * One row per attempted sign-in against `/portal/login`. The customer
   * portal client calls `checkLoginRateLimit({ identifier })` BEFORE
   * Convex Auth's `signIn("password", ...)` and `recordPortalLoginOutcome
   * ({ identifier, succeeded })` AFTER. The rate-limit helper consumes
   * this table via `by_identifier_attempted` to enforce:
   *
   *   - 5 failed attempts within 15 minutes → throttle (retry in N min).
   *   - 10 failed attempts within 1 hour → lockout for 1 hour.
   *   - A successful login resets the counter — failures BEFORE the
   *     latest success no longer count against subsequent attempts.
   *
   * Additive table — never patched. Cleanup is a daily cron sweep
   * (`authAttemptsCleanup` in `convex/crons.ts`) that deletes rows
   * older than 7 days (lockout window + buffer).
   *
   * Field notes:
   *   - `identifier` — the rate-limit key. Email (lowercased + trimmed)
   *     or any future portal alias. Cross-check is identifier-only —
   *     the table NEVER stores raw passwords.
   *   - `attemptedAt` — epoch ms. Distinct from `_creationTime` so the
   *     test harness can fast-forward windows without re-mocking
   *     Convex's insert timestamp.
   *   - `succeeded` — boolean. Successful rows are inserted alongside
   *     failed ones so the rate-limit helper can find the latest
   *     success and ignore prior failures (counter reset).
   *   - `ipHash` — SHA-256 of the request IP, truncated to the first 16
   *     hex chars to avoid storing raw IPs (privacy: an IP is a
   *     pseudonymous identifier under the Philippines Data Privacy Act).
   *     Optional because the wire-level IP isn't always available from
   *     the public mutation path.
   *   - `userAgent` — operator-supplied UA string, truncated to 200
   *     chars. Defensive sizing keeps a malicious client from inflating
   *     a single row to absurd size.
   *
   * Indexes:
   *   - `by_identifier_attempted` — primary lookup for the rate-limit
   *     window scan; sorted by `attemptedAt` ascending so the latest
   *     attempts surface at the tail of the page.
   *   - `by_attemptedAt` — daily cleanup sweep filters by age via this
   *     index instead of scanning the whole table.
   */
  authAttempts: defineTable({
    identifier: v.string(),
    attemptedAt: v.number(),
    succeeded: v.boolean(),
    ipHash: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  })
    .index("by_identifier_attempted", ["identifier", "attemptedAt"])
    .index("by_attemptedAt", ["attemptedAt"]),

  /**
   * Portal invitations — Story 9.1 (FR5) Epic-9 adversarial-review fix.
   *
   * Bridges the auth-account-creation gap the original Story 9.1 left
   * undocumented: customer-portal sign-ins assume an `authAccounts`
   * row exists for the customer's email, but the system shipped with
   * NO path for the customer to acquire credentials short of staff
   * hand-crafting an auth user and matching the customer's `email`
   * column manually. This table is the single source of truth for
   * the invite-acceptance flow.
   *
   * Lifecycle:
   *   1. Admin / office_staff calls `portalInvites.createPortalInvite`
   *      from the customer detail page. The mutation generates a
   *      cryptographically-random token (UUIDv4 via `crypto.randomUUID()`)
   *      and inserts the row with `expiresAt = now + 7 days` (Phase 1
   *      window; renewable by issuing a fresh invite).
   *   2. The operator copies the resulting `/portal/accept-invite/<token>`
   *      URL into an SMS / email to the customer.
   *   3. The customer opens the URL. The accept-invite page calls
   *      `acceptPortalInvite({ token, password })`:
   *        - Looks up the row via the `by_token` index.
   *        - Validates `usedAt === undefined` (single-use).
   *        - Validates `expiresAt > now` (not expired).
   *        - Signs the customer up via Convex Auth's password provider
   *          using the linked `customers.email`.
   *        - Inserts a `userRoles { role: "customer" }` row pointing at
   *          the freshly-created auth user.
   *        - Patches the invite row with `usedAt` + `usedByUserId`.
   *
   * Field notes:
   *   - `customerId` — strong FK to `customers`. The invite belongs to
   *     exactly one customer.
   *   - `inviteToken` — UUIDv4. The operator-facing URL embeds this
   *     verbatim; the table never stores the password the customer
   *     will set (that lives in Convex Auth's `authAccounts.secret`
   *     after acceptance).
   *   - `createdAt` / `expiresAt` — epoch ms. Single-source-of-truth
   *     for the expiry policy; the runtime check uses `Date.now()`.
   *   - `usedAt` / `usedByUserId` — populated once the invite is
   *     consumed. The row PERSISTS (audit trail; the consumed-invite
   *     surface is part of the breach-impact corpus per NFR-S8).
   *
   * Indexes:
   *   - `by_token` — primary lookup for the public accept-invite
   *     mutation. Fast token → row resolution under a Convex unique-
   *     index assumption (we enforce single-use via `usedAt` rather
   *     than a uniqueness constraint, which Convex doesn't carry).
   *   - `by_customer_active` — the "is there an outstanding invite
   *     for this customer?" check the admin UI uses to surface a
   *     "Invite already pending; resend?" affordance instead of
   *     issuing duplicate tokens.
   */
  portalInvites: defineTable({
    customerId: v.id("customers"),
    inviteToken: v.string(),
    createdAt: v.number(),
    createdByUserId: v.id("users"),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
    usedByUserId: v.optional(v.id("users")),
  })
    .index("by_token", ["inviteToken"])
    .index("by_customer_active", ["customerId", "usedAt"]),
});
