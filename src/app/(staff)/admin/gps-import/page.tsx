"use client";

/**
 * /admin/gps-import — GPS-surveyed lot geometry import (Story 8.1).
 *
 * Admin-only by middleware (`src/middleware.ts` gates `/admin/*` on
 * the `admin` role) and by server-side `requireRole(["admin"])` inside
 * `convex/gpsImport.ts:importGpsBatch`. Both layers are required per
 * NFR-S4 (UI-only authorization is a non-compliance defect).
 *
 * The page is intentionally thin — the multi-step workflow lives in
 * `<GpsImportPanel>`. The page only wraps the panel with the standard
 * h1 + introductory copy that frames the operational context.
 *
 * Operational notes for the admin running this:
 *
 *   - This is a one-shot Phase 1 → Phase 2 bridge. The first run
 *     applies the surveyor's deliverable and flips `geometryStatus`
 *     from `"placeholder"` to `"surveyed"` on every matched lot.
 *
 *   - Default behaviour is safe: already-surveyed lots are SKIPPED
 *     on subsequent runs unless the admin explicitly toggles
 *     "Overwrite surveyed lots" (the form's `force` checkbox).
 *
 *   - Every applied lot gets an audit row tagged with the operator-
 *     entered "Reason" (free text). The audit row carries the full
 *     before/after geometry payload — admins reviewing the audit log
 *     later can reconstruct the polygon as it was prior to the import.
 *
 *   - This page does NOT trigger Phase 2 renderer activation (Story
 *     8.2). The SVG renderer continues to work because it ignores
 *     `geometry` and reads only static SVG overlay coordinates. Once
 *     all lots show `geometryStatus: "surveyed"`, Story 8.2 swaps in
 *     the Leaflet renderer with no further data work.
 */

import { GpsImportPanel } from "@/components/GpsImport";

export default function AdminGpsImportPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-4xl font-semibold tracking-tight">GPS geometry import</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Bridge Phase 1 (placeholder geometry) to Phase 2 (real surveyed
          polygons) by uploading the surveyor&apos;s deliverable. Every applied
          lot gets an audit row; already-surveyed lots are skipped by
          default — toggle the override only for re-survey corrections.
        </p>
      </header>

      <GpsImportPanel />
    </div>
  );
}
