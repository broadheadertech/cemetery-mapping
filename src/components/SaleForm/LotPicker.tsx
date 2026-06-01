"use client";

/**
 * LotPicker — Story 3.3.
 *
 * Searchable select for available lots. The full-payment sale form
 * (Task 6) consumes this to populate `lotId` + `basePriceCents`.
 *
 * Phase 1 implementation:
 *   - Fetches all `available` lots via `lots:listLots` with
 *     `statusFilter="available"` — at ~2,000 lots total and a small
 *     subset available at any given time, the un-paginated fetch is
 *     fine. The query is reactive: another staff member selling a lot
 *     in another tab will invalidate the list immediately (architectural
 *     "live availability" commitment, Story 3.3 § disaster prevention).
 *   - Client-side filter by trimmed lower-case substring match on the
 *     lot's `code` and `section`. Real text search lands when search
 *     infrastructure does (Story 1.10).
 *   - Renders as a plain native `<select>` for Phase 1 (matches the
 *     existing InternmentForm + Lot list view patterns) — shadcn/ui
 *     Command is the eventual richer surface, deferred to a follow-up
 *     UX polish story.
 *
 * Reusability: Story 3.4 (installment sale) consumes the same picker
 * via the same props shape.
 */

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { cn } from "@/lib/cn";
import { formatPeso } from "@/lib/money";
import type { LotStatus } from "@/types/lot-status";

/**
 * Public shape callers receive when a lot is selected. Mirrors only the
 * fields the SaleForm needs — keeps the wire payload from leaking into
 * downstream UI typing.
 */
export interface LotPickerOption {
  lotId: string;
  code: string;
  section: string;
  block: string;
  row: string;
  basePriceCents: number;
}

interface LotRow {
  _id: string;
  code: string;
  section: string;
  block: string;
  row: string;
  type: "single" | "family" | "mausoleum" | "niche";
  basePriceCents: number;
  status: LotStatus;
  isRetired: boolean;
}

const listLotsRef = makeFunctionReference<
  "query",
  { statusFilter?: LotStatus },
  LotRow[]
>("lots:listLots");

export interface LotPickerProps {
  value: string;
  onSelect: (lot: LotPickerOption | null) => void;
  disabled?: boolean;
  /** Test id forwarded onto the underlying select for E2E targeting. */
  testId?: string;
}

export function LotPicker({
  value,
  onSelect,
  disabled = false,
  testId = "sale-lot-picker",
}: LotPickerProps) {
  const [search, setSearch] = useState("");

  const lots = useQuery(listLotsRef, { statusFilter: "available" });
  const isLoading = lots === undefined;

  const filtered = useMemo<LotRow[]>(() => {
    if (lots === undefined) return [];
    const trimmed = search.trim().toLowerCase();
    const base = lots.filter((l) => !l.isRetired);
    if (trimmed.length === 0) return base;
    return base.filter((lot) => {
      const haystack = `${lot.code} ${lot.section}-${lot.block}-${lot.row}`
        .toLowerCase();
      return haystack.includes(trimmed);
    });
  }, [lots, search]);

  function handleChange(nextLotId: string): void {
    if (nextLotId === "") {
      onSelect(null);
      return;
    }
    const lot = filtered.find((l) => l._id === nextLotId);
    if (lot === undefined) {
      onSelect(null);
      return;
    }
    onSelect({
      lotId: lot._id,
      code: lot.code,
      section: lot.section,
      block: lot.block,
      row: lot.row,
      basePriceCents: lot.basePriceCents,
    });
  }

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <label
          htmlFor="sale-lot-search"
          className="block text-xs font-medium text-slate-600"
        >
          Filter
        </label>
        <input
          id="sale-lot-search"
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by lot code or section…"
          disabled={disabled || isLoading}
          data-testid={`${testId}-search`}
          className={cn(
            "block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            "disabled:cursor-not-allowed disabled:bg-slate-50",
          )}
        />
      </div>
      <div className="space-y-1">
        <label
          htmlFor="sale-lot-select"
          className="block text-sm font-medium text-slate-700"
        >
          Lot
        </label>
        <select
          id="sale-lot-select"
          autoFocus
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          disabled={disabled || isLoading || filtered.length === 0}
          data-testid={testId}
          aria-required="true"
          className={cn(
            "block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            "disabled:cursor-not-allowed disabled:bg-slate-50",
          )}
        >
          <option value="">
            {isLoading
              ? "Loading available lots…"
              : filtered.length === 0
                ? search.trim().length > 0
                  ? "No available lots match. Clear filter."
                  : "No available lots."
                : "Select a lot…"}
          </option>
          {filtered.map((lot) => (
            <option key={lot._id} value={lot._id}>
              {lot.code} — Section {lot.section}/{lot.block}/{lot.row} —{" "}
              {formatPeso(lot.basePriceCents)}
            </option>
          ))}
        </select>
        <p className="text-xs text-slate-500">
          Only lots currently in <strong>Available</strong> status appear here.
          Selecting a lot auto-fills the price.
        </p>
      </div>
    </div>
  );
}
