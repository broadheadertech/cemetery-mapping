/**
 * Client-side shape of a lot condition log row — Story 1.14.
 *
 * The Convex schema (`convex/schema.ts → lotConditionLogs`) is the
 * canonical source of truth. This file mirrors the doc shape for
 * Next.js components that can't import server types directly
 * (architecture's client/server boundary).
 *
 * The `loggedByName` augmentation matches what
 * `listLotConditionLogs` returns — the server resolves the user's
 * name / email once at query time so React doesn't have to do an
 * extra subscription per row.
 */

export interface LotConditionLog {
  _id: string;
  _creationTime: number;
  lotId: string;
  loggedBy: string;
  loggedAt: number;
  note: string;
  photoStorageId?: string;
  idempotencyKey?: string;
}

export interface ListedLotConditionLog extends LotConditionLog {
  loggedByName: string | null;
}
