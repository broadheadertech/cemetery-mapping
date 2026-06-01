/**
 * AuditLogTable shared types (Story 6.5).
 *
 * The row shape mirrors `AuditLogRow` in `convex/auditLogQueries.ts`
 * verbatim, but lives here so the component file can stay free of
 * Convex import wiring (the page that hosts the table is the seam
 * between Convex and React).
 */

export type AuditEntityType =
  | "lot"
  | "customer"
  | "contract"
  | "payment"
  | "receipt"
  | "user"
  | "expense"
  | "ownership"
  | "piiAccess";

export interface AuditLogRow {
  _id: string;
  _creationTime: number;
  actor: string;
  actorName: string | null;
  timestamp: number;
  action: string;
  entityType: AuditEntityType;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

/**
 * Active filter set displayed as chips above the table. Each chip is
 * dismissable; dismissing it tells the parent page to update the URL
 * query string accordingly.
 */
export interface AuditLogFilterChip {
  /** Filter key (`entityType` / `actor` / `from` / `to`). */
  key: string;
  /** Human-readable label rendered on the chip. */
  label: string;
}
