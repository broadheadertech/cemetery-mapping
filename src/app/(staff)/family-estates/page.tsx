"use client";

/**
 * /family-estates — Story 2.9 (FR15 brand-tier extension).
 *
 * List page for family estates. Admin + office_staff read; admin-only
 * writes (the retire / lot-add / lot-remove affordances live on the
 * detail page). The list shows every ACTIVE estate by default; the
 * "Include retired" toggle widens the view.
 *
 * Reactive: `useQuery(listFamilyEstates)` re-renders when a parallel
 * staff member creates / modifies an estate.
 */

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { translateError } from "@/lib/errors";

interface FamilyEstateRow {
  estateId: string;
  name: string;
  primaryOwnerCustomerId: string;
  primaryOwnerFullName: string;
  secondaryOwners: Array<{ customerId: string; fullName: string }>;
  lots: Array<{ lotId: string; code: string }>;
  notes?: string;
  createdAt: number;
  retiredAt?: number;
  retirementReason?: string;
  isActive: boolean;
}

const listFamilyEstatesRef = makeFunctionReference<
  "query",
  { includeRetired?: boolean },
  FamilyEstateRow[]
>("familyEstates:listFamilyEstates");

const createFamilyEstateRef = makeFunctionReference<
  "mutation",
  {
    name: string;
    primaryOwnerCustomerId: string;
    secondaryOwnerCustomerIds: string[];
    lotIds: string[];
    notes?: string;
  },
  { estateId: string }
>("familyEstates:createFamilyEstate");

export default function FamilyEstatesListPage() {
  const [includeRetired, setIncludeRetired] = useState(false);
  const estates = useQuery(listFamilyEstatesRef, { includeRetired });
  const createEstate = useMutation(createFamilyEstateRef);
  const [showCreate, setShowCreate] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftPrimary, setDraftPrimary] = useState("");
  const [draftSecondaries, setDraftSecondaries] = useState("");
  const [draftLotIds, setDraftLotIds] = useState("");
  const [draftNotes, setDraftNotes] = useState("");

  async function handleCreate(): Promise<void> {
    setCreateError(null);
    setIsCreating(true);
    try {
      const secondaryIds = draftSecondaries
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const lotIds = draftLotIds
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const args: {
        name: string;
        primaryOwnerCustomerId: string;
        secondaryOwnerCustomerIds: string[];
        lotIds: string[];
        notes?: string;
      } = {
        name: draftName.trim(),
        primaryOwnerCustomerId: draftPrimary.trim(),
        secondaryOwnerCustomerIds: secondaryIds,
        lotIds,
      };
      if (draftNotes.trim().length > 0) args.notes = draftNotes.trim();
      await createEstate(args);
      setShowCreate(false);
      setDraftName("");
      setDraftPrimary("");
      setDraftSecondaries("");
      setDraftLotIds("");
      setDraftNotes("");
    } catch (err) {
      setCreateError(translateError(err).detail);
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-4xl font-semibold tracking-tight">Family estates</h1>
        <button
          type="button"
          onClick={() => setShowCreate((s) => !s)}
          data-testid="family-estate-toggle-create"
          className="min-h-[44px] rounded-md border border-[#1D5C4D] bg-[#1D5C4D] px-3 py-2 text-sm font-medium text-white hover:bg-[#144437]"
        >
          {showCreate ? "Cancel" : "+ New estate"}
        </button>
      </div>
      <p className="text-sm text-slate-600">
        Multi-lot reservations owned as one contractual unit by a
        household. Pricing, ownership transfer, and AR aging consolidate
        across the estate.
      </p>

      <label className="flex items-center gap-2 text-xs text-slate-600">
        <input
          type="checkbox"
          checked={includeRetired}
          onChange={(e) => setIncludeRetired(e.target.checked)}
          data-testid="family-estate-include-retired"
        />
        Include retired estates
      </label>

      {showCreate && (
        <div
          className="space-y-3 rounded-md border border-slate-200 bg-slate-50 px-4 py-3"
          data-testid="family-estate-create-panel"
        >
          <h2 className="text-sm font-semibold text-slate-800">
            Create a family estate
          </h2>
          <p className="text-xs text-slate-500">
            Phase 1 surface: paste customer + lot ids directly. Future
            iteration will wire the rich pickers.
          </p>
          {createError !== null && (
            <p
              role="alert"
              className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900"
            >
              {createError}
            </p>
          )}
          <input
            type="text"
            placeholder="Estate name (e.g. de los Santos Family Estate)"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            data-testid="family-estate-create-name"
            className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            type="text"
            placeholder="Primary owner customer id"
            value={draftPrimary}
            onChange={(e) => setDraftPrimary(e.target.value)}
            data-testid="family-estate-create-primary"
            className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            type="text"
            placeholder="Secondary owner customer ids (comma-separated, optional)"
            value={draftSecondaries}
            onChange={(e) => setDraftSecondaries(e.target.value)}
            data-testid="family-estate-create-secondaries"
            className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            type="text"
            placeholder="Lot ids (comma-separated, 2-12 lots)"
            value={draftLotIds}
            onChange={(e) => setDraftLotIds(e.target.value)}
            data-testid="family-estate-create-lots"
            className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <textarea
            placeholder="Notes (optional)"
            value={draftNotes}
            onChange={(e) => setDraftNotes(e.target.value)}
            data-testid="family-estate-create-notes"
            className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            disabled={isCreating}
            onClick={handleCreate}
            data-testid="family-estate-create-submit"
            className="min-h-[44px] rounded-md bg-[#1D5C4D] px-3 py-2 text-sm font-medium text-white hover:bg-[#144437] disabled:opacity-60"
          >
            {isCreating ? "Creating…" : "Create estate"}
          </button>
        </div>
      )}

      {estates === undefined ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : estates.length === 0 ? (
        <div
          className="rounded-md border border-slate-200 bg-slate-50 px-4 py-6 text-center"
          data-testid="family-estate-empty"
        >
          <p className="text-sm text-slate-700">
            No family estates yet.{" "}
            {includeRetired ? "(No retired estates either.)" : null}
          </p>
        </div>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-2">Name</th>
              <th className="py-2">Primary owner</th>
              <th className="py-2">Lot count</th>
              <th className="py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {estates.map((estate) => (
              <tr
                key={estate.estateId}
                className="border-b border-slate-100"
                data-testid={`family-estate-row-${estate.estateId}`}
              >
                <td className="py-2">
                  <Link
                    href={`/family-estates/${estate.estateId}`}
                    className="font-medium text-slate-900 underline"
                  >
                    {estate.name}
                  </Link>
                </td>
                <td className="py-2 text-slate-700">
                  {estate.primaryOwnerFullName}
                </td>
                <td className="py-2 tabular-nums">{estate.lots.length}</td>
                <td className="py-2">
                  {estate.isActive ? (
                    <span className="rounded-md bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-800">
                      Active
                    </span>
                  ) : (
                    <span className="rounded-md bg-slate-200 px-2 py-1 text-xs font-medium text-slate-700">
                      Retired
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
