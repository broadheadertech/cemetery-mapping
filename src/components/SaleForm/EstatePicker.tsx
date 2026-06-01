"use client";

/**
 * EstatePicker — Story 2.9.
 *
 * Sibling to `LotPicker`. Surfaced when the SaleForm's mode toggle is
 * set to "Family estate". Lists active family estates and emits the
 * full estate option (id, name, anchor lot, member lot codes) to the
 * parent so the SaleForm can wire the contract mutation with
 * `familyEstateId` + the anchor `lotId`.
 *
 * Implementation:
 *   - Reactive `listFamilyEstates` query (active rows only). At Phase 1
 *     cemetery scale (< 50 active estates) the un-paginated fetch is
 *     fine.
 *   - Native `<select>` matches the existing LotPicker / CustomerPicker
 *     pattern; richer UX deferred to a follow-up story.
 *
 * The picker does NOT enforce "lots are still available" — the SaleForm
 * +  server `recordFullPaymentSale` / `recordInstallmentSale` handlers
 * re-validate every member lot's status. The picker shows every active
 * estate; the server is the authority on whether the estate can
 * actually be sold today.
 */

import { useState } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { cn } from "@/lib/cn";

export interface EstatePickerOption {
  estateId: string;
  name: string;
  primaryOwnerCustomerId: string;
  primaryOwnerFullName: string;
  anchorLotId: string;
  memberLotCodes: string[];
}

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
  isActive: boolean;
}

const listFamilyEstatesRef = makeFunctionReference<
  "query",
  { includeRetired?: boolean },
  FamilyEstateRow[]
>("familyEstates:listFamilyEstates");

export interface EstatePickerProps {
  value: string;
  onSelect: (option: EstatePickerOption | null) => void;
}

export function EstatePicker({ value, onSelect }: EstatePickerProps) {
  const estates = useQuery(listFamilyEstatesRef, { includeRetired: false });
  const [touched, setTouched] = useState(false);

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>): void {
    const next = e.target.value;
    setTouched(true);
    if (next === "") {
      onSelect(null);
      return;
    }
    const row = (estates ?? []).find((r) => r.estateId === next);
    if (row === undefined || row.lots.length === 0) {
      onSelect(null);
      return;
    }
    onSelect({
      estateId: row.estateId,
      name: row.name,
      primaryOwnerCustomerId: row.primaryOwnerCustomerId,
      primaryOwnerFullName: row.primaryOwnerFullName,
      // Anchor lot — the SaleForm uses this as the contract row's `lotId`.
      anchorLotId: row.lots[0]!.lotId,
      memberLotCodes: row.lots.map((l) => l.code),
    });
  }

  const loading = estates === undefined;

  return (
    <div className="space-y-1" data-testid="sale-estate-picker">
      <label
        htmlFor="sale-estate"
        className="block text-sm font-medium text-slate-700"
      >
        Family estate
      </label>
      <select
        id="sale-estate"
        value={value}
        onChange={handleChange}
        aria-required="true"
        aria-invalid={touched && value === ""}
        data-testid="sale-estate-select"
        className={cn(
          "block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm",
          "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
          touched && value === "" && "border-red-400",
        )}
      >
        <option value="">
          {loading ? "Loading estates…" : "Select an active family estate"}
        </option>
        {(estates ?? []).map((row) => (
          <option key={row.estateId} value={row.estateId}>
            {row.name} · {row.lots.length} lots ({row.primaryOwnerFullName})
          </option>
        ))}
      </select>
      {!loading && estates !== undefined && estates.length === 0 && (
        <p className="text-xs text-slate-500">
          No active family estates yet. Create one from the Family Estates
          admin page first.
        </p>
      )}
    </div>
  );
}
