"use client";

/**
 * LotDetail — Story 1.11 orchestrator.
 *
 * Composes the seven Phase 1 sections of the lot detail page:
 *
 *   1. Header (lot code + StatusPill, wrapped in <ReactiveHighlight>
 *      so the section flashes amber for 600ms when the lot's status
 *      changes server-side — UX-DR25, AC2).
 *   2. Lot facts (type, dimensions, section/block/row, base price,
 *      geometry status pill + centroid preview).
 *   3. Ownership panel (Phase 1 placeholder; Story 2.3 will populate).
 *   4. Occupants panel (Phase 1 placeholder; Story 2.x will populate).
 *   5. Active contract panel (Phase 1 placeholder; Epic 3 will populate).
 *   6. Payment history placeholder (Epic 3 will populate).
 *   7. Recent condition logs (live via Story 1.14's reactive query).
 *
 * Followed by the action row: role-gated Edit / Retire (admin +
 * office_staff only) and the reserved "Log condition" slot for Story
 * 1.14's Sheet (rendered disabled here so the layout doesn't shift
 * when that story lands).
 *
 * Pure presentational at this level: parent provides the resolved
 * `LotDetailData` so the page-level component owns loading / null /
 * error states. This keeps the orchestrator easy to unit-test with
 * a fixture object.
 */

import Link from "next/link";
import { useState } from "react";

import { ReactiveHighlight } from "@/components/ui/ReactiveHighlight";
import { StatusPill } from "@/components/ui/StatusPill";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { LotStatus } from "@/types/lot-status";
import { translateError } from "@/lib/errors";

import { ActiveContractPanel } from "./ActiveContractPanel";
import { ConditionLogsPanel } from "./ConditionLogsPanel";
import { LotFactsPanel, type LotFactsData } from "./LotFactsPanel";
import { OccupantsPanel } from "./OccupantsPanel";
import { OwnershipPanel } from "./OwnershipPanel";
import { PaymentHistoryPlaceholder } from "./PaymentHistoryPlaceholder";

export interface LotDetailData {
  _id: string;
  code: string;
  section: string;
  block: string;
  row: string;
  type: "single" | "family" | "mausoleum" | "niche";
  dimensions: { widthM: number; depthM: number };
  basePriceCents: number;
  status: LotStatus;
  geometryStatus: "placeholder" | "surveyed";
  geometry?: {
    centroid: { lat: number; lng: number };
  };
  isRetired: boolean;
}

export interface LotDetailProps {
  detail: LotDetailData;
  /**
   * Caller-supplied roles list — typically threaded from the (staff)
   * layout's server-resolved user payload. Used here for the UI gate
   * on Edit / Retire (server gates in `convex/lots.ts` are the real
   * check; the UI gate is defense in depth + UX consistency).
   */
  roles?: ReadonlyArray<string>;
  /**
   * Retire callback. Caller owns the Convex mutation so this component
   * stays test-friendly. The component handles the confirmation dialog
   * and the error translation; the caller is only asked to perform the
   * actual write.
   */
  onRetire?: () => Promise<void>;
}

export function LotDetail({ detail, roles = [], onRetire }: LotDetailProps) {
  const canEdit =
    roles.includes("admin") || roles.includes("office_staff");
  const [retireOpen, setRetireOpen] = useState(false);
  const [retireBusy, setRetireBusy] = useState(false);
  const [retireError, setRetireError] = useState<string | null>(null);

  const facts: LotFactsData = {
    code: detail.code,
    section: detail.section,
    block: detail.block,
    row: detail.row,
    type: detail.type,
    dimensions: detail.dimensions,
    basePriceCents: detail.basePriceCents,
    status: detail.status,
    geometryStatus: detail.geometryStatus,
    ...(detail.geometry !== undefined ? { geometry: detail.geometry } : {}),
  };

  async function handleConfirmRetire() {
    if (onRetire === undefined) return;
    setRetireBusy(true);
    setRetireError(null);
    try {
      await onRetire();
      setRetireOpen(false);
    } catch (err) {
      const translated = translateError(err);
      setRetireError(translated.detail);
    } finally {
      setRetireBusy(false);
    }
  }

  return (
    <div className="space-y-6" data-testid="lot-detail">
      {/*
        AC2 — the entire header row is wrapped in <ReactiveHighlight>
        watching the lot's status. When another tab transitions the
        lot, the 600ms amber flash fires here AND the StatusPill's
        baked-in 300ms colour crossfade animates the pill itself.
        Geometry-status changes flash the lot-facts panel via its own
        ReactiveHighlight on `basePriceCents` (price changes flash) —
        geometryStatus is covered by the dedicated wrapper below.
      */}
      <ReactiveHighlight watch={detail.status} className="block w-full">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">
              Lot {detail.code}
            </h1>
            <StatusPill status={detail.status} size="md" />
          </div>
          {detail.isRetired && (
            <span
              role="status"
              className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-900"
            >
              Retired
            </span>
          )}
        </header>
      </ReactiveHighlight>

      <ReactiveHighlight
        watch={detail.geometryStatus}
        className="block w-full"
      >
        <LotFactsPanel facts={facts} />
      </ReactiveHighlight>

      <OwnershipPanel />
      <OccupantsPanel />
      <ActiveContractPanel />
      <PaymentHistoryPlaceholder />
      <ConditionLogsPanel lotId={detail._id} />

      <ActionRow
        lotId={detail._id}
        canEdit={canEdit}
        retired={detail.isRetired}
        onRequestRetire={() => setRetireOpen(true)}
      />

      <Dialog open={retireOpen} onOpenChange={setRetireOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Retire lot {detail.code}?</DialogTitle>
            <DialogDescription>
              This soft-deletes the lot. It will not appear in default
              lists. Existing audit history is preserved. You can
              restore the lot via the Admin panel (Phase 2).
            </DialogDescription>
          </DialogHeader>
          {retireError !== null && (
            <p
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
            >
              {retireError}
            </p>
          )}
          <div className="mt-2 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setRetireOpen(false)}
              disabled={retireBusy}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmRetire}
              disabled={retireBusy}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
            >
              {retireBusy ? "Retiring…" : "Retire lot"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * ActionRow — Edit / Retire / Log-condition buttons. Edit + Retire are
 * gated by `canEdit` (admin + office_staff). The Log-condition button
 * is visible for all staff roles AND links to Story 1.14's existing
 * `/conditions` route (we do not inline the Sheet in this story — the
 * full Sheet treatment is a Story 1.14-owned follow-up).
 */
function ActionRow({
  lotId,
  canEdit,
  retired,
  onRequestRetire,
}: {
  lotId: string;
  canEdit: boolean;
  retired: boolean;
  onRequestRetire: () => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-end gap-3"
      data-testid="lot-detail-actions"
    >
      <Link
        href={`/lots/${lotId}/conditions`}
        className="inline-flex min-h-[44px] items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        aria-label="Log condition for this lot"
      >
        Log condition
      </Link>
      {canEdit && (
        <>
          <Link
            href={`/lots/${lotId}/edit`}
            className="inline-flex min-h-[44px] items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            aria-label="Edit lot details"
            data-testid="lot-detail-edit"
          >
            Edit
          </Link>
          <button
            type="button"
            onClick={onRequestRetire}
            disabled={retired}
            aria-label={retired ? "Lot is already retired" : "Retire lot"}
            data-testid="lot-detail-retire"
            className="inline-flex min-h-[44px] items-center rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
          >
            {retired ? "Retired" : "Retire"}
          </button>
        </>
      )}
    </div>
  );
}
