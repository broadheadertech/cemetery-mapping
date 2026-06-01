/**
 * Memorial plaque drafts domain (Story 6.8, FR49).
 *
 * Office-staff-facing surface for generating + iterating on plaque
 * PDF previews. The cemetery's office staff produce these for the
 * family to review BEFORE the stonemason engraves the actual plaque;
 * families often iterate on the epitaph across multiple revisions, so
 * every regenerate creates a NEW versioned row rather than overwriting
 * the prior one (see Story 6.8 § Disaster prevention).
 *
 * Conventions every handler obeys:
 *
 *   1. FIRST awaited statement is `await requireRole(ctx, [...])`. The
 *      ESLint rule `local-rules/require-role-first-line` enforces this.
 *   2. Mutations call `emitAudit` — direct `auditLog` inserts are
 *      banned by `local-rules/no-audit-log-direct-write`. We key audit
 *      rows on the LOT (`entityType: "lot"`), NOT the plaque-draft id,
 *      because the lot is the canonical aggregate root for the
 *      interment + occupant + plaque chain (mirrors the `interments` /
 *      `occupants` audit pattern).
 *   3. The PDFKit render lives in the Node-runtime action
 *      `convex/actions/generatePlaquePdf.ts:runForDraft`. The mutation
 *      schedules the action via `ctx.scheduler.runAfter(0, ...)` and
 *      NEVER calls the action directly — V8 cannot import `"use node"`
 *      files. The action calls back into `_recordPlaqueReady` /
 *      `_recordPlaqueFailed` to patch the draft row.
 *   4. Retry is admin-only per Story 6.1 precedent. Office staff
 *      cannot manually retry a failed draft — the daily cron sweeps
 *      `pending` + `failed` rows automatically (cap of 3 retries).
 *
 * Story scope:
 *   - This file ships the V8 mutations + queries + internal callbacks.
 *   - The PDFKit render lives in the parallel Tier-3 action file.
 *   - The retry-sweep extension lives in `convex/pdfRetrySweep.ts`.
 *   - The page + components live under `src/app/(staff)/interments/
 *     [intermentId]/plaque/` and `src/components/PlaqueForm/` +
 *     `src/components/PlaqueDraftHistory/`.
 */

import {
  type DataModelFromSchemaDefinition,
  internalMutationGeneric,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import { emitAudit } from "./lib/audit";
import { ErrorCode, throwError } from "./lib/errors";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type IntermentId = DataModel["interments"]["document"]["_id"];
type PlaqueDraftDoc = DataModel["plaqueDrafts"]["document"];
type PlaqueDraftId = PlaqueDraftDoc["_id"];
type PlaqueStorageId = NonNullable<PlaqueDraftDoc["pdfStorageId"]>;

// ---------------------------------------------------------------------------
// Validation caps. Mirror the client Zod schema in
// `src/components/PlaqueForm/schema.ts` so server-side defense matches
// the form's UI affordance.
// ---------------------------------------------------------------------------

/** Brand-system maximum epitaph length (chars). 3 lines on the
 *  physical plaque; 240 chars is the loose approximation. */
export const PLAQUE_EPITAPH_MAX_LENGTH = 240;

/** Cemetery accepts only modern + recent dates; rejects bornYear < 1800. */
export const PLAQUE_MIN_YEAR = 1800;

/** Per-row PDF retry cap. Matches Story 6.1's contract-PDF cap. */
export const PLAQUE_MAX_RETRIES = 3;

/**
 * Function-reference path for the Node-runtime plaque-draft action.
 * Duplicated as a string (rather than imported) because the V8 mutation
 * cannot `import` from the `"use node"` action module. The path is
 * pinned by the path-string parity test in
 * `tests/unit/convex/plaqueDrafts.test.ts`.
 */
const GENERATE_PLAQUE_DRAFT_PDF_ACTION_PATH =
  "actions/generatePlaquePdf:runForDraft";

// ---------------------------------------------------------------------------
// Public surface — requestPlaqueDraft + retryPlaqueDraft +
// listForInterment + getPlaqueUrl.
// ---------------------------------------------------------------------------

/**
 * Public arg shape for `requestPlaqueDraft`. Mirrors the validator
 * below; exported so the React form + tests can typecheck against the
 * mutation's contract.
 */
export interface RequestPlaqueDraftArgs {
  intermentId: IntermentId;
  deceasedName: string;
  bornYear: number;
  diedYear: number;
  dateFormat: "arabic" | "roman";
  epitaph?: string;
}

export interface RequestPlaqueDraftResult {
  plaqueDraftId: PlaqueDraftId;
  version: number;
}

/**
 * Schedule a fresh plaque-draft PDF generation for the given interment
 * (Story 6.8, AC3). Inserts a `pending` `plaqueDrafts` row with the
 * next per-interment version, emits an audit row, and schedules the
 * Tier-3 plaque action which will patch the row's `pdfStorageId` +
 * flip `pdfStatus` to `ready` (or `failed` on error).
 *
 * Auth: admin / office_staff. Field workers + customer-role callers
 * are rejected — plaque generation is an office-staff workflow.
 *
 * Validation:
 *   - `deceasedName` must be non-empty after trim, ≤ 200 chars
 *     (mirrors the occupant-name cap in `convex/occupants.ts`).
 *   - `bornYear` < `diedYear` (the cemetery does not engrave plaques
 *     with reversed dates, even at the operator's request — the
 *     stonemason will refuse).
 *   - Both years in `[PLAQUE_MIN_YEAR, currentYear + 1]`. The `+1`
 *     buffer accommodates a pending interment scheduled for next year.
 *   - `epitaph?.length <= PLAQUE_EPITAPH_MAX_LENGTH` (240).
 *   - Interment exists (NOT_FOUND on bogus id).
 *
 * Audit: emits `entityType: "lot"` (per the
 * `interments` / `occupants` precedent — the lot is the aggregate
 * root) with `action: "create"` and a payload describing the draft
 * version + format + dates.
 *
 * Idempotency: NOT idempotent across calls. Every invocation inserts
 * a new versioned row. The UI prevents accidental double-clicks via
 * the button's disabled state while the mutation is in flight; the
 * action's per-row retry-counter caps automatic re-attempts at 3.
 *
 * Concurrency: the `nextVersion = max(existing) + 1` computation is a
 * read-then-write that two concurrent submits against the same
 * interment can both pass with the same `maxVersion` observation,
 * producing duplicate `version` numbers. There is no DB-level unique
 * constraint on `(intermentId, version)`. To close that race we
 * perform a POST-INSERT VERIFY scan inside the same mutation: after
 * the insert, we re-query `by_interment_version` for this interment
 * and assert that our newly-inserted row carries the MAX version.
 * If a concurrent insert beat us (or tied), we throw
 * `INVARIANT_VIOLATION { kind: "plaque_version_race" }`. Convex's
 * optimistic-concurrency-control (OCC) layer will retry the loser of
 * the race because its read set (the `by_interment_version` slice)
 * overlaps the winner's write set, so the user-visible behaviour is a
 * transparent retry that succeeds with the next version number.
 * Structurally mirrors the lot-uniqueness post-insert verify pattern
 * recommended by Story 2.9's reviewers.
 *
 * Throws:
 *   - `UNAUTHENTICATED` / `FORBIDDEN` — auth gate.
 *   - `VALIDATION` — name / year / epitaph invariants.
 *   - `NOT_FOUND` — interment id does not resolve.
 *   - `INVARIANT_VIOLATION` `{ kind: "plaque_version_race" }` — a
 *     concurrent submit produced a duplicate version; OCC will retry.
 */
export const requestPlaqueDraft = mutationGeneric({
  args: {
    intermentId: v.id("interments"),
    deceasedName: v.string(),
    bornYear: v.number(),
    diedYear: v.number(),
    dateFormat: v.union(v.literal("arabic"), v.literal("roman")),
    epitaph: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: RequestPlaqueDraftArgs,
  ): Promise<RequestPlaqueDraftResult> => {
    const auth = await requireRole(ctx, ["admin", "office_staff"]);

    // Cheap argument validation (defense in depth — the client Zod
    // schema covers the same surface).
    const trimmedName = args.deceasedName.trim();
    if (trimmedName.length === 0) {
      throwError(
        ErrorCode.VALIDATION,
        "Deceased name is required.",
      );
    }
    if (trimmedName.length > 200) {
      throwError(
        ErrorCode.VALIDATION,
        "Deceased name must be 200 characters or fewer.",
      );
    }

    const currentYear = new Date().getUTCFullYear();
    const yearMax = currentYear + 1;
    if (
      !Number.isInteger(args.bornYear) ||
      args.bornYear < PLAQUE_MIN_YEAR ||
      args.bornYear > yearMax
    ) {
      throwError(
        ErrorCode.VALIDATION,
        `Born year must be an integer in [${PLAQUE_MIN_YEAR}, ${yearMax}].`,
        { bornYear: args.bornYear },
      );
    }
    if (
      !Number.isInteger(args.diedYear) ||
      args.diedYear < PLAQUE_MIN_YEAR ||
      args.diedYear > yearMax
    ) {
      throwError(
        ErrorCode.VALIDATION,
        `Died year must be an integer in [${PLAQUE_MIN_YEAR}, ${yearMax}].`,
        { diedYear: args.diedYear },
      );
    }
    if (args.bornYear >= args.diedYear) {
      throwError(
        ErrorCode.VALIDATION,
        "Born year must be earlier than died year.",
        { bornYear: args.bornYear, diedYear: args.diedYear },
      );
    }

    const trimmedEpitaph =
      args.epitaph !== undefined ? args.epitaph.trim() : undefined;
    if (
      trimmedEpitaph !== undefined &&
      trimmedEpitaph.length > PLAQUE_EPITAPH_MAX_LENGTH
    ) {
      throwError(
        ErrorCode.VALIDATION,
        `Epitaph must be ${PLAQUE_EPITAPH_MAX_LENGTH} characters or fewer.`,
        { epitaphLength: trimmedEpitaph.length },
      );
    }

    // Interment existence — NOT_FOUND on bogus id (UI navigated to a
    // deleted / wrong interment).
    const interment = await ctx.db.get(args.intermentId);
    if (interment === null) {
      throwError(ErrorCode.NOT_FOUND, "Interment not found.", {
        intermentId: args.intermentId,
      });
    }

    // Compute the next version for this interment. The
    // `by_interment_version` index keys on `["intermentId", "version"]`,
    // so collecting the rows and taking the max is O(n) over per-interment
    // history (small N — a family typically goes through ≤ a handful of
    // revisions before settling on the engraved text).
    const priorDrafts = await ctx.db
      .query("plaqueDrafts")
      .withIndex("by_interment_version", (q) =>
        q.eq("intermentId", args.intermentId),
      )
      .collect();
    const maxVersion = priorDrafts.reduce(
      (acc, row) => (row.version > acc ? row.version : acc),
      0,
    );
    const nextVersion = maxVersion + 1;

    const now = Date.now();
    const insertRow: Omit<PlaqueDraftDoc, "_id" | "_creationTime"> = {
      intermentId: args.intermentId,
      deceasedName: trimmedName,
      bornYear: args.bornYear,
      diedYear: args.diedYear,
      dateFormat: args.dateFormat,
      version: nextVersion,
      pdfStatus: "pending",
      generatedBy: auth.userId,
      generatedAt: now,
      retryCount: 0,
    };
    if (trimmedEpitaph !== undefined && trimmedEpitaph.length > 0) {
      insertRow.epitaph = trimmedEpitaph;
    }
    const plaqueDraftId = await ctx.db.insert("plaqueDrafts", insertRow);

    // Post-insert verify (defensive race guard — see JSDoc § Concurrency).
    // Re-query the per-interment slice and assert our row is the
    // unique-max for its `(intermentId, version)`. If a concurrent
    // mutation inserted a row at the same `version`, Convex's OCC
    // layer will retry the loser of the race when its read set
    // (the slice we just collected) overlaps the winner's write set.
    const verifyRows = await ctx.db
      .query("plaqueDrafts")
      .withIndex("by_interment_version", (q) =>
        q.eq("intermentId", args.intermentId),
      )
      .collect();
    const verifySorted = [...verifyRows].sort((a, b) => b.version - a.version);
    const verifyTop = verifySorted[0];
    if (verifyTop === undefined || verifyTop._id !== plaqueDraftId) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Another draft was created concurrently. Please retry.",
        {
          kind: "plaque_version_race",
          intermentId: args.intermentId,
          attemptedVersion: nextVersion,
          observedTopVersion: verifyTop?.version ?? null,
        },
      );
    }

    // Audit — keyed on the lot (the aggregate root). The interment row
    // carries `lotId`; surface it on the audit row so per-lot queries
    // pick the draft event up.
    await emitAudit(ctx, {
      action: "create",
      entityType: "lot",
      entityId: interment.lotId,
      after: {
        plaqueDraftId,
        intermentId: args.intermentId,
        version: nextVersion,
        deceasedName: trimmedName,
        bornYear: args.bornYear,
        diedYear: args.diedYear,
        dateFormat: args.dateFormat,
        hasEpitaph: trimmedEpitaph !== undefined && trimmedEpitaph.length > 0,
        pdfStatus: "pending" as const,
      },
      reason: `generate_plaque_draft v${nextVersion}`,
    });

    // Schedule the Node-runtime renderer. The action calls back into
    // `_recordPlaqueReady` / `_recordPlaqueFailed` to patch the
    // `pdfStorageId` + flip `pdfStatus`.
    const actionRef = makeFunctionReference<
      "action",
      {
        plaqueDraftId: PlaqueDraftId;
        deceasedName: string;
        bornYear: number;
        diedYear: number;
        dateFormat: "arabic" | "roman";
        epitaph?: string;
      },
      { storageId: string }
    >(GENERATE_PLAQUE_DRAFT_PDF_ACTION_PATH);
    const scheduleArgs: {
      plaqueDraftId: PlaqueDraftId;
      deceasedName: string;
      bornYear: number;
      diedYear: number;
      dateFormat: "arabic" | "roman";
      epitaph?: string;
    } = {
      plaqueDraftId,
      deceasedName: trimmedName,
      bornYear: args.bornYear,
      diedYear: args.diedYear,
      dateFormat: args.dateFormat,
    };
    if (trimmedEpitaph !== undefined && trimmedEpitaph.length > 0) {
      scheduleArgs.epitaph = trimmedEpitaph;
    }
    await ctx.scheduler.runAfter(0, actionRef, scheduleArgs);

    return { plaqueDraftId, version: nextVersion };
  },
});

/**
 * Public arg shape for `retryPlaqueDraft`.
 */
export interface RetryPlaqueDraftArgs {
  plaqueDraftId: PlaqueDraftId;
}

export interface RetryPlaqueDraftResult {
  plaqueDraftId: PlaqueDraftId;
  retryCount: number;
}

/**
 * Manual admin retry for a failed plaque draft (Story 6.8, AC5).
 *
 * Admin-only per Story 6.1's precedent — office_staff cannot manually
 * retry a failed draft. The retry-sweep cron handles automatic retries
 * up to `PLAQUE_MAX_RETRIES`; this surface is the operator escape
 * hatch when a draft has exhausted its retries.
 *
 * Resets the draft row to `pending` (preserves the existing version,
 * does NOT insert a new row), bumps the retry counter, emits an
 * audit row, then re-schedules the action.
 *
 * Throws:
 *   - `UNAUTHENTICATED` / `FORBIDDEN` — auth gate (admin-only).
 *   - `NOT_FOUND` — draft id does not resolve.
 *   - `INVARIANT_VIOLATION` — draft is currently in `ready` status
 *     (no retry needed) or `pending` (already in flight).
 */
export const retryPlaqueDraft = mutationGeneric({
  args: { plaqueDraftId: v.id("plaqueDrafts") },
  handler: async (
    ctx: MutationCtx,
    args: RetryPlaqueDraftArgs,
  ): Promise<RetryPlaqueDraftResult> => {
    const auth = await requireRole(ctx, ["admin"]);

    const draft = await ctx.db.get(args.plaqueDraftId);
    if (draft === null) {
      throwError(ErrorCode.NOT_FOUND, "Plaque draft not found.", {
        plaqueDraftId: args.plaqueDraftId,
      });
    }
    if (draft.pdfStatus === "ready") {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Cannot retry a draft that already has a generated PDF.",
        { plaqueDraftId: args.plaqueDraftId, pdfStatus: draft.pdfStatus },
      );
    }
    if (draft.pdfStatus === "pending") {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Cannot retry a draft that is already generating.",
        { plaqueDraftId: args.plaqueDraftId, pdfStatus: draft.pdfStatus },
      );
    }

    const nextRetryCount = draft.retryCount + 1;
    await ctx.db.patch(args.plaqueDraftId, {
      pdfStatus: "pending",
      retryCount: nextRetryCount,
      lastError: undefined,
    });

    const interment = await ctx.db.get(draft.intermentId);
    // Audit keyed on the lot (with fallback when the interment row was
    // deleted between draft creation and retry).
    const auditLotId: string =
      interment !== null ? interment.lotId : draft.intermentId;
    await emitAudit(ctx, {
      action: "update",
      entityType: "lot",
      entityId: auditLotId,
      before: {
        plaqueDraftId: args.plaqueDraftId,
        version: draft.version,
        pdfStatus: draft.pdfStatus,
        retryCount: draft.retryCount,
      },
      after: {
        plaqueDraftId: args.plaqueDraftId,
        version: draft.version,
        pdfStatus: "pending" as const,
        retryCount: nextRetryCount,
      },
      reason: `plaque_pdf_retry by ${auth.userId}`,
    });

    const actionRef = makeFunctionReference<
      "action",
      {
        plaqueDraftId: PlaqueDraftId;
        deceasedName: string;
        bornYear: number;
        diedYear: number;
        dateFormat: "arabic" | "roman";
        epitaph?: string;
      },
      { storageId: string }
    >(GENERATE_PLAQUE_DRAFT_PDF_ACTION_PATH);
    const scheduleArgs: {
      plaqueDraftId: PlaqueDraftId;
      deceasedName: string;
      bornYear: number;
      diedYear: number;
      dateFormat: "arabic" | "roman";
      epitaph?: string;
    } = {
      plaqueDraftId: args.plaqueDraftId,
      deceasedName: draft.deceasedName,
      bornYear: draft.bornYear,
      diedYear: draft.diedYear,
      dateFormat: draft.dateFormat,
    };
    if (draft.epitaph !== undefined) {
      scheduleArgs.epitaph = draft.epitaph;
    }
    await ctx.scheduler.runAfter(0, actionRef, scheduleArgs);

    return {
      plaqueDraftId: args.plaqueDraftId,
      retryCount: nextRetryCount,
    };
  },
});

// ---------------------------------------------------------------------------
// Internal callbacks — invoked by the Node-runtime action after the
// PDF render lands (success or failure). Internal mutations bypass
// `requireRole` (no user context); the originating mutation's role
// check was the gate.
// ---------------------------------------------------------------------------

/**
 * Patch the draft row with the freshly-stored blob id + flip
 * `pdfStatus` to `ready`. Called by the action on success.
 *
 * Silently no-ops if the row was deleted between the action being
 * scheduled and the callback (operationally rare — drafts are not
 * deletable in Phase 1).
 */
export const _recordPlaqueReady = internalMutationGeneric({
  args: {
    plaqueDraftId: v.id("plaqueDrafts"),
    pdfStorageId: v.id("_storage"),
  },
  handler: async (
    ctx: MutationCtx,
    args: { plaqueDraftId: PlaqueDraftId; pdfStorageId: PlaqueStorageId },
  ): Promise<void> => {
    const draft = await ctx.db.get(args.plaqueDraftId);
    if (draft === null) return;
    await ctx.db.patch(args.plaqueDraftId, {
      pdfStorageId: args.pdfStorageId,
      pdfStatus: "ready",
      lastError: undefined,
    });
    const interment = await ctx.db.get(draft.intermentId);
    const auditLotId: string =
      interment !== null ? interment.lotId : draft.intermentId;
    await emitAudit(ctx, {
      action: "update",
      entityType: "lot",
      entityId: auditLotId,
      before: {
        plaqueDraftId: args.plaqueDraftId,
        version: draft.version,
        pdfStatus: draft.pdfStatus,
      },
      after: {
        plaqueDraftId: args.plaqueDraftId,
        version: draft.version,
        pdfStatus: "ready" as const,
      },
      reason: "plaque_pdf_ready",
    });
  },
});

/**
 * Patch the draft row with the error string + flip `pdfStatus` to
 * `failed`. Called by the action on render / storage failure. Bumps
 * `retryCount` so the retry-sweep cron's per-row cap is correctly
 * accounted for; rows at the cap stay `failed` and the sweep skips
 * them.
 */
export const _recordPlaqueFailed = internalMutationGeneric({
  args: {
    plaqueDraftId: v.id("plaqueDrafts"),
    error: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    args: { plaqueDraftId: PlaqueDraftId; error: string },
  ): Promise<void> => {
    const draft = await ctx.db.get(args.plaqueDraftId);
    if (draft === null) return;
    const truncated =
      args.error.length > 500 ? args.error.slice(0, 500) : args.error;
    const nextRetryCount = draft.retryCount + 1;
    await ctx.db.patch(args.plaqueDraftId, {
      pdfStatus: "failed",
      lastError: truncated,
      retryCount: nextRetryCount,
    });
    const interment = await ctx.db.get(draft.intermentId);
    const auditLotId: string =
      interment !== null ? interment.lotId : draft.intermentId;
    await emitAudit(ctx, {
      action: "update",
      entityType: "lot",
      entityId: auditLotId,
      before: {
        plaqueDraftId: args.plaqueDraftId,
        version: draft.version,
        pdfStatus: draft.pdfStatus,
        retryCount: draft.retryCount,
      },
      after: {
        plaqueDraftId: args.plaqueDraftId,
        version: draft.version,
        pdfStatus: "failed" as const,
        retryCount: nextRetryCount,
        lastError: truncated,
      },
      reason: "plaque_pdf_failed",
    });
  },
});

/**
 * Internal mutation — bumps the per-draft retry counter and flips
 * `pdfStatus` back to `pending` so the renderer can re-attempt. Called
 * by the retry-sweep cron in `convex/pdfRetrySweep.ts` BEFORE
 * rescheduling the action against a consistent row state.
 *
 * Mirrors Story 6.1's `_bumpContractPdfRetryCount` helper — the cap-
 * check itself lives in the sweep (this just bumps unconditionally).
 */
export const _bumpPlaqueDraftRetryCount = internalMutationGeneric({
  args: { plaqueDraftId: v.id("plaqueDrafts") },
  handler: async (
    ctx: MutationCtx,
    args: { plaqueDraftId: PlaqueDraftId },
  ): Promise<{ retryCount: number }> => {
    const draft = await ctx.db.get(args.plaqueDraftId);
    if (draft === null) return { retryCount: 0 };
    const next = draft.retryCount + 1;
    await ctx.db.patch(args.plaqueDraftId, {
      retryCount: next,
      pdfStatus: "pending",
    });
    return { retryCount: next };
  },
});

// ---------------------------------------------------------------------------
// Read surfaces — listForInterment + getPlaqueUrl.
// ---------------------------------------------------------------------------

/**
 * Wire shape for the plaque-draft-history rail. Joins
 * `generatedByName` server-side so the UI renders without a per-row
 * follow-up `users` lookup.
 */
export interface PlaqueDraftHistoryRow {
  plaqueDraftId: PlaqueDraftId;
  intermentId: IntermentId;
  version: number;
  deceasedName: string;
  bornYear: number;
  diedYear: number;
  dateFormat: "arabic" | "roman";
  epitaph: string | undefined;
  pdfStatus: "pending" | "ready" | "failed";
  generatedAt: number;
  generatedByName: string;
  retryCount: number;
  lastError: string | undefined;
}

/**
 * Reactive listing of plaque drafts for an interment. Sorted by
 * `version` DESCENDING so the newest revision sits at the top of the
 * draft-history rail.
 *
 * Role gate: admin / office_staff. Field workers + customer-role
 * callers do not see plaque drafts (the workflow is office-staff
 * coordination; the customer interacts via in-person review).
 */
export const listForInterment = queryGeneric({
  args: { intermentId: v.id("interments") },
  handler: async (
    ctx: QueryCtx,
    args: { intermentId: IntermentId },
  ): Promise<PlaqueDraftHistoryRow[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const rows = await ctx.db
      .query("plaqueDrafts")
      .withIndex("by_interment_version", (q) =>
        q.eq("intermentId", args.intermentId),
      )
      .collect();
    const sorted = [...rows].sort((a, b) => b.version - a.version);
    return await Promise.all(
      sorted.map(async (r) => {
        const generator = await ctx.db.get(r.generatedBy);
        const generatedByName =
          generator !== null && generator.name !== undefined
            ? generator.name
            : "[unknown]";
        return {
          plaqueDraftId: r._id,
          intermentId: r.intermentId,
          version: r.version,
          deceasedName: r.deceasedName,
          bornYear: r.bornYear,
          diedYear: r.diedYear,
          dateFormat: r.dateFormat,
          epitaph: r.epitaph,
          pdfStatus: r.pdfStatus,
          generatedAt: r.generatedAt,
          generatedByName,
          retryCount: r.retryCount,
          lastError: r.lastError,
        };
      }),
    );
  },
});

/**
 * Returns an auth-gated signed URL for the draft's most-recently
 * generated PDF (Story 6.8, NFR-S3). Returns `null` when the draft
 * has not yet completed (`pdfStatus !== "ready"`) or when the storage
 * blob has been garbage-collected (operationally rare in Phase 1).
 *
 * Role gate: admin / office_staff.
 *
 * Throws:
 *   - `UNAUTHENTICATED` / `FORBIDDEN` — auth gate.
 *   - `NOT_FOUND` — draft id does not resolve.
 */
export const getPlaqueUrl = queryGeneric({
  args: { plaqueDraftId: v.id("plaqueDrafts") },
  handler: async (
    ctx: QueryCtx,
    args: { plaqueDraftId: PlaqueDraftId },
  ): Promise<{ url: string | null; generatedAt: number | null }> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const draft = await ctx.db.get(args.plaqueDraftId);
    if (draft === null) {
      throwError(ErrorCode.NOT_FOUND, "Plaque draft not found.", {
        plaqueDraftId: args.plaqueDraftId,
      });
    }
    if (draft.pdfStatus !== "ready" || draft.pdfStorageId === undefined) {
      return { url: null, generatedAt: null };
    }
    const url = await ctx.storage.getUrl(draft.pdfStorageId);
    return { url, generatedAt: draft.generatedAt };
  },
});

/**
 * Test helper — exposes path constants so the unit-test suite can
 * pin the cross-runtime function-reference parity (the V8 mutation's
 * scheduled-action path must match the action file's exported
 * constant) without needing to spin up the action plumbing.
 */
export const __testing = {
  GENERATE_PLAQUE_DRAFT_PDF_ACTION_PATH,
  PLAQUE_EPITAPH_MAX_LENGTH,
  PLAQUE_MIN_YEAR,
  PLAQUE_MAX_RETRIES,
};
