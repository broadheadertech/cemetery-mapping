"use client";

/**
 * OccupantsPanel — Story 2.6 (FR18).
 *
 * Reactive list of occupants for a lot, with an Add-occupant
 * affordance and a Dialog hosting the `OccupantForm`. Replaces the
 * Story 1.11 Phase 1 placeholder.
 *
 * Why this panel self-fetches `lotId` via `useParams`:
 *   Story 1.11 ships `LotDetail.tsx` (locked) which mounts
 *   `<OccupantsPanel />` without props. Adding a `lotId` prop would
 *   require modifying that file; instead we read the route param
 *   directly. In a test environment without a Next.js router
 *   provider, `useParams()` returns `null`/`undefined` and the panel
 *   degrades to the calm empty state — preserving the existing
 *   `data-testid="occupants-empty"` selector that Story 1.11's
 *   `LotDetail.test.tsx` asserts.
 *
 * Why this panel self-fetches the caller's role:
 *   The Add-occupant button is gated to `office_staff` / `admin`.
 *   `LotDetail` accepts a `roles` prop but does not thread it into
 *   children (locked file). The panel fetches `getCurrentUserOrNull`
 *   on its own so the gate is preserved without that prop. The
 *   server (`addOccupant`) is the canonical gate — this UI check is
 *   defense in depth + UX consistency.
 *
 * Reactive subscription edge case: toggling "Show removed" flips
 * the query's `includeRemoved` arg, which Convex treats as a new
 * subscription. We do NOT wrap the list in `ReactiveHighlight` on
 * that toggle's value — only individual rows flash on their own
 * `createdAt` so a UI-only toggle does not produce a misleading
 * full-list amber fade.
 */

import { useState } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { ReactiveHighlight } from "@/components/ui/ReactiveHighlight";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { OccupantForm, type OccupantSubmitPayload } from "@/components/OccupantForm";

/**
 * Compat type — kept for backwards compatibility with Story 1.11's
 * placeholder export surface (`index.ts` re-exports `Occupant`). The
 * real list now flows through `ListedOccupant` below.
 */
export interface Occupant {
  name: string;
  relationship?: string;
  intermentDate?: string;
}

/**
 * Compat type — also retained for the `index.ts` re-export. The
 * `occupants` prop is no longer wired (the panel self-fetches), but
 * keeping the type avoids breaking external imports.
 */
export interface OccupantsPanelProps {
  occupants?: ReadonlyArray<Occupant>;
}

interface ListedOccupantRow {
  occupantId: string;
  name: string;
  dateOfInterment: number | undefined;
  relationshipToOwner: string;
  notes: string | undefined;
  isRemoved: boolean;
  removedReason: string | undefined;
  createdAt: number;
}

interface AuthUserDoc {
  email?: string;
  name?: string;
}

interface AuthPayload {
  userId: string;
  user: AuthUserDoc;
  roles: string[];
}

const listLotOccupantsRef = makeFunctionReference<
  "query",
  { lotId: string; includeRemoved?: boolean },
  ListedOccupantRow[]
>("occupants:listLotOccupants");

const addOccupantRef = makeFunctionReference<
  "mutation",
  {
    lotId: string;
    name: string;
    dateOfInterment?: number;
    relationshipToOwner: string;
    notes?: string;
  },
  { occupantId: string }
>("occupants:addOccupant");

const getCurrentUserOrNullRef = makeFunctionReference<
  "query",
  Record<string, never>,
  AuthPayload | null
>("lib/auth:getCurrentUserOrNull");

const DATE_FORMATTER = new Intl.DateTimeFormat("en-PH", {
  dateStyle: "medium",
  timeZone: "Asia/Manila",
});

function formatIntermentDate(epochMs: number | undefined): string {
  if (epochMs === undefined) return "Date unknown";
  return DATE_FORMATTER.format(new Date(epochMs));
}

export function OccupantsPanel(_props: OccupantsPanelProps = {}) {
  // Read the route parameter. `useParams` returns `null` in test
  // environments without a Next.js router provider — when that
  // happens we render the empty placeholder so Story 1.11's locked
  // `LotDetail.test.tsx` keeps passing.
  const params = useParams<{ lotId?: string }>();
  const lotId = params?.lotId;

  const auth = useQuery(getCurrentUserOrNullRef, {});
  const roles = auth?.roles ?? [];
  const canAdd = roles.includes("admin") || roles.includes("office_staff");

  const [showRemoved, setShowRemoved] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const occupants = useQuery(
    listLotOccupantsRef,
    lotId !== undefined && lotId.length > 0
      ? { lotId, includeRemoved: showRemoved }
      : "skip",
  );
  const addOccupant = useMutation(addOccupantRef);

  return (
    <section
      aria-labelledby="occupants-heading"
      className="rounded-md border border-slate-200 bg-white p-6"
    >
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2
          id="occupants-heading"
          className="text-base font-semibold text-slate-900"
        >
          Occupants
        </h2>
        {canAdd && lotId !== undefined && lotId.length > 0 && (
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            data-testid="occupants-add-button"
            className="inline-flex min-h-[44px] items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Add occupant
          </button>
        )}
      </div>
      <OccupantListBody occupants={occupants} />
      <RemovedToggle
        occupants={occupants}
        showRemoved={showRemoved}
        onChange={setShowRemoved}
      />
      {canAdd && lotId !== undefined && lotId.length > 0 && (
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add occupant</DialogTitle>
              <DialogDescription>
                Record a deceased person interred in this lot. Date of
                interment may be left as &quot;unknown&quot; for legacy
                entries.
              </DialogDescription>
            </DialogHeader>
            <OccupantForm
              onCancel={() => setDialogOpen(false)}
              onSubmit={async (payload: OccupantSubmitPayload) => {
                const args: {
                  lotId: string;
                  name: string;
                  dateOfInterment?: number;
                  relationshipToOwner: string;
                  notes?: string;
                } = {
                  lotId,
                  name: payload.name,
                  relationshipToOwner: payload.relationshipToOwner,
                };
                if (payload.dateOfInterment !== undefined) {
                  args.dateOfInterment = payload.dateOfInterment;
                }
                if (payload.notes !== undefined) {
                  args.notes = payload.notes;
                }
                await addOccupant(args);
                setDialogOpen(false);
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

function OccupantListBody({
  occupants,
}: {
  occupants: ListedOccupantRow[] | undefined;
}) {
  if (occupants === undefined) {
    // Loading: render the empty placeholder copy so the LotDetail
    // skeleton retains a useful shape — `data-testid` preserved for
    // Story 1.11's locked test.
    return (
      <p
        className="text-sm text-slate-600"
        data-testid="occupants-empty"
      >
        No occupants recorded.
      </p>
    );
  }
  if (occupants.length === 0) {
    return (
      <p
        className="text-sm text-slate-600"
        data-testid="occupants-empty"
      >
        No occupants recorded for this lot.
      </p>
    );
  }
  return (
    <ul
      className="divide-y divide-slate-100"
      data-testid="occupants-list"
    >
      {occupants.map((o) => (
        <li
          key={o.occupantId}
          data-testid="occupants-row"
          data-removed={o.isRemoved ? "true" : "false"}
          className="py-3"
        >
          <ReactiveHighlight watch={o.createdAt} className="block w-full">
            <OccupantRow occupant={o} />
          </ReactiveHighlight>
        </li>
      ))}
    </ul>
  );
}

function OccupantRow({ occupant }: { occupant: ListedOccupantRow }) {
  const nameClass = occupant.isRemoved
    ? "font-medium text-slate-400 line-through"
    : "font-medium text-slate-900";
  const metaClass = occupant.isRemoved
    ? "text-xs text-slate-400"
    : "text-xs text-slate-500";
  return (
    <div className="min-h-[44px] space-y-1">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span className={nameClass}>{occupant.name}</span>
        <span className="text-slate-500">{occupant.relationshipToOwner}</span>
      </div>
      <div className={metaClass}>
        <span>Interred {formatIntermentDate(occupant.dateOfInterment)}</span>
        {occupant.isRemoved && occupant.removedReason !== undefined && (
          <span
            className="ml-2"
            title={occupant.removedReason}
            aria-label={`Removed reason: ${occupant.removedReason}`}
          >
            · removed
          </span>
        )}
      </div>
      {occupant.notes !== undefined && occupant.notes.length > 0 && (
        <p className="text-xs text-slate-500">{occupant.notes}</p>
      )}
    </div>
  );
}

function RemovedToggle({
  occupants,
  showRemoved,
  onChange,
}: {
  occupants: ListedOccupantRow[] | undefined;
  showRemoved: boolean;
  onChange: (next: boolean) => void;
}) {
  // The toggle is only meaningful when at least one removed row
  // exists OR when the toggle is already on (so the user can flip it
  // back). We deliberately read the same `occupants` array as the
  // list so the toggle's removed count reflects what the server
  // returned for the current `includeRemoved` value.
  const removedCount =
    occupants !== undefined
      ? occupants.filter((o) => o.isRemoved).length
      : 0;
  if (!showRemoved && removedCount === 0) {
    return null;
  }
  return (
    <div className="mt-4">
      <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-slate-600">
        <input
          type="checkbox"
          checked={showRemoved}
          onChange={(e) => onChange(e.target.checked)}
          data-testid="occupants-show-removed"
          className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
        />
        <span>
          Show removed{removedCount > 0 ? ` (${removedCount})` : ""}
        </span>
      </label>
    </div>
  );
}
