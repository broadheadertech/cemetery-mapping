"use client";

/**
 * /admin/audit-log — admin audit-log browser (Story 6.5, FR47).
 *
 * Admin-only. Middleware (`src/middleware.ts`) gates `/admin/*` at the
 * edge; `convex/auditLogQueries.ts` re-enforces the role server-side
 * via `requireRole(ctx, ["admin"])` per NFR-S4 (defense in depth).
 *
 * Three filter modes (mutually exclusive — first non-empty filter wins):
 *   1. `entityType` + `entityId` → routes to `listByEntity` query
 *      (uses the narrow `by_entity` index).
 *   2. `actor` (a user id) → routes to `listByActor` query
 *      (uses `by_actor`).
 *   3. No filter → routes to `listRecent` (uses `by_timestamp`).
 *
 * Filter state lives in the URL query string so the page is
 * shareable. The state is read once per render via `useSearchParams`
 * and converted to query args in a `useMemo` so the Convex query
 * subscription is stable.
 *
 * Pagination is cursor-based per the Convex pattern. We track a
 * stack of cursors as the user pages forward; "Previous" pops the
 * stack. The cursor is intentionally NOT URL-bound — sharing a
 * cursor would be brittle across data changes (cursor staleness is
 * a Convex semantic that no UI should leak to the user).
 *
 * PII safety: the rows arrive already-redacted from the server
 * (`emitAudit` redacted at write time, Story 1.6). This page does
 * not implement a "reveal full PII" affordance — that lives in a
 * future story behind `readPii` + `piiAccessLog`. Read-only here.
 */

import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import {
  AuditLogTable,
  type AuditEntityType,
  type AuditLogFilterChip,
  type AuditLogRow,
} from "@/components/AuditLogTable";

const PAGE_SIZE = 50;

const ENTITY_TYPE_VALUES: ReadonlyArray<AuditEntityType> = [
  "lot",
  "customer",
  "contract",
  "payment",
  "receipt",
  "user",
  "expense",
  "ownership",
  "piiAccess",
];

const ENTITY_TYPE_LABELS: Record<AuditEntityType, string> = {
  lot: "Lot",
  customer: "Customer",
  contract: "Contract",
  payment: "Payment",
  receipt: "Receipt",
  user: "User",
  expense: "Expense",
  ownership: "Ownership",
  piiAccess: "PII Access",
};

interface PageEnvelope {
  page: AuditLogRow[];
  isDone: boolean;
  continueCursor: string;
}

interface PaginationOpts {
  numItems: number;
  cursor: string | null;
}

const listRecentRef = makeFunctionReference<
  "query",
  { paginationOpts: PaginationOpts },
  PageEnvelope
>("auditLogQueries:listRecent");

const listByEntityRef = makeFunctionReference<
  "query",
  {
    entityType: AuditEntityType;
    entityId: string;
    paginationOpts: PaginationOpts;
  },
  PageEnvelope
>("auditLogQueries:listByEntity");

const listByActorRef = makeFunctionReference<
  "query",
  { actorUserId: string; paginationOpts: PaginationOpts },
  PageEnvelope
>("auditLogQueries:listByActor");

function isEntityType(value: string | null): value is AuditEntityType {
  if (value === null) return false;
  return (ENTITY_TYPE_VALUES as readonly string[]).includes(value);
}

export default function AdminAuditLogPage(): ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Read URL state once per render. The values feed directly into the
  // Convex query selector below.
  const filters = useMemo(() => {
    const rawEntityType = searchParams.get("entityType");
    const entityType = isEntityType(rawEntityType) ? rawEntityType : null;
    const entityId = searchParams.get("entityId");
    const actorUserId = searchParams.get("actor");
    return {
      entityType,
      entityId: entityId !== null && entityId.length > 0 ? entityId : null,
      actorUserId:
        actorUserId !== null && actorUserId.length > 0 ? actorUserId : null,
    };
  }, [searchParams]);

  // Cursor stack — head is the current page's cursor, lower entries
  // are previous pages. `null` cursor means "first page". A separate
  // stack is needed because Convex's continuation cursor is opaque
  // and forward-only.
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const currentCursor = cursorStack[cursorStack.length - 1] ?? null;

  const paginationOpts: PaginationOpts = useMemo(
    () => ({ numItems: PAGE_SIZE, cursor: currentCursor }),
    [currentCursor],
  );

  // Pick one query based on the filter shape. The other two are
  // skipped (`undefined` argument) so Convex doesn't fire them.
  const useEntityQuery =
    filters.entityType !== null && filters.entityId !== null;
  const useActorQuery =
    !useEntityQuery && filters.actorUserId !== null;
  const useRecentQuery = !useEntityQuery && !useActorQuery;

  const entityResult = useQuery(
    listByEntityRef,
    useEntityQuery
      ? {
          entityType: filters.entityType as AuditEntityType,
          entityId: filters.entityId as string,
          paginationOpts,
        }
      : "skip",
  );
  const actorResult = useQuery(
    listByActorRef,
    useActorQuery
      ? {
          actorUserId: filters.actorUserId as string,
          paginationOpts,
        }
      : "skip",
  );
  const recentResult = useQuery(
    listRecentRef,
    useRecentQuery ? { paginationOpts } : "skip",
  );

  const result: PageEnvelope | undefined =
    entityResult ?? actorResult ?? recentResult;
  const isLoading = result === undefined;
  const rows: AuditLogRow[] = result?.page ?? [];
  const isDone = result?.isDone ?? true;
  const nextCursor = result?.continueCursor ?? null;

  const filterChips: AuditLogFilterChip[] = useMemo(() => {
    const chips: AuditLogFilterChip[] = [];
    if (filters.entityType !== null) {
      chips.push({
        key: "entityType",
        label: `Type: ${ENTITY_TYPE_LABELS[filters.entityType]}`,
      });
    }
    if (filters.entityId !== null) {
      chips.push({
        key: "entityId",
        label: `Entity: ${filters.entityId}`,
      });
    }
    if (filters.actorUserId !== null) {
      chips.push({
        key: "actor",
        label: `Actor: ${filters.actorUserId}`,
      });
    }
    return chips;
  }, [filters]);

  const updateSearchParam = useCallback(
    (mutator: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutator(params);
      const query = params.toString();
      const url = query.length > 0 ? `/admin/audit-log?${query}` : "/admin/audit-log";
      router.replace(url);
      // Any filter change resets pagination — cursors are tied to the
      // previous query shape and can't be reused.
      setCursorStack([null]);
    },
    [router, searchParams],
  );

  const handleRemoveFilter = useCallback(
    (key: string) => {
      updateSearchParam((params) => {
        params.delete(key);
      });
    },
    [updateSearchParam],
  );

  const handleNextPage = useCallback(() => {
    if (nextCursor === null) return;
    if (isDone) return;
    setCursorStack((prev) => [...prev, nextCursor]);
  }, [nextCursor, isDone]);

  const handlePrevPage = useCallback(() => {
    setCursorStack((prev) => {
      if (prev.length <= 1) return prev;
      return prev.slice(0, -1);
    });
  }, []);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Audit log</h1>
        <p className="max-w-3xl text-sm text-slate-600">
          Read-only browser of every financial-touching action recorded by
          the system. PII (gov-IDs, addresses) is redacted at write time
          and shown as last-4 only. Append-only — entries cannot be
          edited or deleted.
        </p>
      </header>

      <AuditLogFilterBar
        filters={filters}
        onApplyFilters={(next) => {
          updateSearchParam((params) => {
            if (next.entityType !== null) {
              params.set("entityType", next.entityType);
            } else {
              params.delete("entityType");
            }
            if (next.entityId !== null && next.entityId.length > 0) {
              params.set("entityId", next.entityId);
            } else {
              params.delete("entityId");
            }
            if (next.actorUserId !== null && next.actorUserId.length > 0) {
              params.set("actor", next.actorUserId);
            } else {
              params.delete("actor");
            }
          });
        }}
      />

      <AuditLogTable
        rows={rows}
        isLoading={isLoading}
        isDone={isDone}
        filterChips={filterChips}
        onRemoveFilter={handleRemoveFilter}
        onNextPage={handleNextPage}
        onPrevPage={handlePrevPage}
        hasPrevPage={cursorStack.length > 1}
      />
    </div>
  );
}

interface AuditLogFilterBarProps {
  filters: {
    entityType: AuditEntityType | null;
    entityId: string | null;
    actorUserId: string | null;
  };
  onApplyFilters: (next: AuditLogFilterBarProps["filters"]) => void;
}

function AuditLogFilterBar({
  filters,
  onApplyFilters,
}: AuditLogFilterBarProps): ReactElement {
  const [entityType, setEntityType] = useState<AuditEntityType | "">(
    filters.entityType ?? "",
  );
  const [entityId, setEntityId] = useState<string>(filters.entityId ?? "");
  const [actorUserId, setActorUserId] = useState<string>(
    filters.actorUserId ?? "",
  );

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    onApplyFilters({
      entityType: entityType === "" ? null : entityType,
      entityId: entityId.trim() === "" ? null : entityId.trim(),
      actorUserId: actorUserId.trim() === "" ? null : actorUserId.trim(),
    });
  };

  const handleClear = (): void => {
    setEntityType("");
    setEntityId("");
    setActorUserId("");
    onApplyFilters({ entityType: null, entityId: null, actorUserId: null });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 rounded-md border border-slate-200 bg-white p-4"
      data-testid="audit-log-filter-bar"
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="space-y-1">
          <label
            htmlFor="audit-entity-type"
            className="block text-xs font-medium uppercase tracking-wide text-slate-500"
          >
            Entity type
          </label>
          <select
            id="audit-entity-type"
            value={entityType}
            onChange={(e) =>
              setEntityType((e.target.value as AuditEntityType) || "")
            }
            className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          >
            <option value="">All</option>
            {ENTITY_TYPE_VALUES.map((value) => (
              <option key={value} value={value}>
                {ENTITY_TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label
            htmlFor="audit-entity-id"
            className="block text-xs font-medium uppercase tracking-wide text-slate-500"
          >
            Entity id
          </label>
          <input
            id="audit-entity-id"
            type="text"
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
            placeholder="e.g. lots:abc123"
            className="block w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
          <p className="text-[11px] text-slate-500">
            Requires Entity type to also be set.
          </p>
        </div>
        <div className="space-y-1">
          <label
            htmlFor="audit-actor"
            className="block text-xs font-medium uppercase tracking-wide text-slate-500"
          >
            Actor (user id)
          </label>
          <input
            id="audit-actor"
            type="text"
            value={actorUserId}
            onChange={(e) => setActorUserId(e.target.value)}
            placeholder="e.g. users:abc123"
            className="block w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={handleClear}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Clear
        </button>
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
        >
          Apply filters
        </button>
      </div>
    </form>
  );
}
