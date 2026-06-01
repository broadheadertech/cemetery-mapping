/**
 * Wire shape for one plaque-draft-history row. Mirrors
 * `convex/plaqueDrafts.ts:PlaqueDraftHistoryRow` exactly.
 *
 * Re-declared in TypeScript so the React layer can typecheck without
 * importing from `convex/_generated/`, which this repo deliberately
 * doesn't check in (see `convex/gpsImport.ts` line 21-34).
 */
export interface PlaqueDraftHistoryRow {
  plaqueDraftId: string;
  intermentId: string;
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
