"use client";

/**
 * /family-estates/[estateId] — Story 2.9 (FR15 brand-tier extension).
 *
 * Detail page for a single family estate. Shows the estate name +
 * status, primary + secondary owners, member lots, and (admin-only)
 * the retire affordance.
 */

import Link from "next/link";
import { useState } from "react";
import { useParams } from "next/navigation";
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

const getFamilyEstateRef = makeFunctionReference<
  "query",
  { estateId: string },
  FamilyEstateRow
>("familyEstates:getFamilyEstate");

const retireEstateRef = makeFunctionReference<
  "mutation",
  { estateId: string; reason: string },
  { estateId: string; retiredAt: number }
>("familyEstates:retireEstate");

export default function FamilyEstateDetailPage() {
  const params = useParams<{ estateId: string }>();
  const estateId = params.estateId;
  const estate = useQuery(getFamilyEstateRef, { estateId });
  const retireEstate = useMutation(retireEstateRef);
  const [showRetire, setShowRetire] = useState(false);
  const [retireReason, setRetireReason] = useState("");
  const [retireError, setRetireError] = useState<string | null>(null);
  const [isRetiring, setIsRetiring] = useState(false);

  if (estate === undefined) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }

  async function handleRetire(): Promise<void> {
    setRetireError(null);
    setIsRetiring(true);
    try {
      await retireEstate({ estateId, reason: retireReason.trim() });
      setShowRetire(false);
      setRetireReason("");
    } catch (err) {
      setRetireError(translateError(err).detail);
    } finally {
      setIsRetiring(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-display text-4xl font-semibold tracking-tight">{estate.name}</h1>
          <p className="text-sm text-slate-600">
            {estate.lots.length} lots ·{" "}
            {estate.isActive ? (
              <span className="font-medium text-emerald-700">Active</span>
            ) : (
              <span className="font-medium text-slate-600">
                Retired{" "}
                {estate.retiredAt !== undefined && (
                  <>on {new Date(estate.retiredAt).toLocaleDateString()}</>
                )}
              </span>
            )}
          </p>
        </div>
        {estate.isActive && (
          <button
            type="button"
            onClick={() => setShowRetire((s) => !s)}
            data-testid="family-estate-retire-toggle"
            className="min-h-[44px] rounded-md border border-rose-500 bg-white px-3 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50"
          >
            Retire estate
          </button>
        )}
      </div>

      <section
        className="rounded-md border border-slate-200 bg-white px-4 py-3"
        data-testid="family-estate-owners"
      >
        <h2 className="text-sm font-semibold text-slate-800">Primary owner</h2>
        <p className="mt-1 text-sm">
          <Link
            href={`/customers/${estate.primaryOwnerCustomerId}`}
            className="text-slate-900 underline"
          >
            {estate.primaryOwnerFullName}
          </Link>
        </p>
        {estate.secondaryOwners.length > 0 && (
          <>
            <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Secondary owners
            </h3>
            <ul className="mt-1 space-y-1 text-sm">
              {estate.secondaryOwners.map((s) => (
                <li key={s.customerId}>
                  <Link
                    href={`/customers/${s.customerId}`}
                    className="text-slate-900 underline"
                  >
                    {s.fullName}
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section
        className="rounded-md border border-slate-200 bg-white px-4 py-3"
        data-testid="family-estate-lots"
      >
        <h2 className="text-sm font-semibold text-slate-800">Member lots</h2>
        <ul className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
          {estate.lots.map((lot) => (
            <li key={lot.lotId}>
              <Link
                href={`/lots/${lot.lotId}`}
                className="block rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-center font-mono text-slate-800 hover:bg-slate-100"
                data-testid={`family-estate-lot-${lot.lotId}`}
              >
                {lot.code}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {estate.notes !== undefined && (
        <section className="rounded-md border border-slate-200 bg-white px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-800">Notes</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
            {estate.notes}
          </p>
        </section>
      )}

      {!estate.isActive && estate.retirementReason !== undefined && (
        <section
          className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3"
          data-testid="family-estate-retirement"
        >
          <h2 className="text-sm font-semibold text-slate-800">
            Retirement
          </h2>
          <p className="mt-1 text-sm text-slate-700">
            {estate.retirementReason}
          </p>
        </section>
      )}

      {showRetire && estate.isActive && (
        <section
          className="space-y-3 rounded-md border border-rose-300 bg-rose-50 px-4 py-3"
          data-testid="family-estate-retire-panel"
        >
          <h2 className="text-sm font-semibold text-rose-900">
            Retire this estate
          </h2>
          <p className="text-xs text-rose-700">
            Retiring the estate is reversible only by manual data
            intervention. Member lots remain unchanged; this estate
            stops appearing in active surfaces.
          </p>
          {retireError !== null && (
            <p
              role="alert"
              className="rounded-md border border-red-300 bg-white px-3 py-2 text-xs text-red-900"
            >
              {retireError}
            </p>
          )}
          <textarea
            placeholder="Reason for retirement (10+ characters)"
            value={retireReason}
            onChange={(e) => setRetireReason(e.target.value)}
            maxLength={500}
            data-testid="family-estate-retire-reason"
            className="block w-full rounded-md border border-rose-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            disabled={isRetiring}
            onClick={handleRetire}
            data-testid="family-estate-retire-confirm"
            className="min-h-[44px] rounded-md bg-rose-600 px-3 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-60"
          >
            {isRetiring ? "Retiring…" : "Retire estate"}
          </button>
        </section>
      )}
    </div>
  );
}
