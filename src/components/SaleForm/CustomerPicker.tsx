"use client";

/**
 * CustomerPicker — Story 3.3.
 *
 * Search-by-name picker for customers. Wraps `customers:searchByName`
 * (Story 2.1) with a 300ms debounce, renders matches as a simple list
 * of buttons the operator clicks to select, and surfaces an inline
 * "+ Create new customer" affordance that opens `CustomerForm` (Story
 * 2.1) in a Dialog. On successful create, the freshly-inserted
 * customer auto-selects without an extra fetch.
 *
 * Reusability: Story 3.4 (installment sale) consumes the same picker
 * via the same props shape.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { cn } from "@/lib/cn";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { CustomerForm } from "@/components/CustomerForm";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export interface CustomerPickerOption {
  customerId: string;
  fullName: string;
}

type SearchHit = {
  customerId: string;
  fullName: string;
  govIdLast4: string;
};

const searchByNameRef = makeFunctionReference<
  "query",
  { q: string },
  SearchHit[]
>("customers:searchByName");

export interface CustomerPickerProps {
  value: CustomerPickerOption | null;
  onSelect: (customer: CustomerPickerOption | null) => void;
  disabled?: boolean;
  testId?: string;
}

const DEBOUNCE_MS = 300;
// Matches the server-side floor in `customers:searchByName` — anything
// shorter returns an empty result, so we don't fire the query at all.
const MIN_CHARS = 3;

export function CustomerPicker({
  value,
  onSelect,
  disabled = false,
  testId = "sale-customer-picker",
}: CustomerPickerProps) {
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const debounced = useDebouncedValue(search, DEBOUNCE_MS);
  const trimmed = debounced.trim();
  const shouldSearch = trimmed.length >= MIN_CHARS && value === null;
  const hits = useQuery(
    searchByNameRef,
    shouldSearch ? { q: trimmed } : "skip",
  );
  const isLoading = shouldSearch && hits === undefined;

  // Reset search when the parent clears the selection so the next pick
  // starts from a blank slate.
  useEffect(() => {
    if (value === null && search !== "") {
      // Don't auto-clear the user's keystrokes — they may be typing a
      // fresh search. We just stop showing the previous picked name.
    }
  }, [value, search]);

  const showResults = useMemo<boolean>(() => {
    return shouldSearch && hits !== undefined && hits.length > 0;
  }, [shouldSearch, hits]);

  function handleCreated(customerId: string, fullName: string): void {
    onSelect({ customerId, fullName });
    setCreateOpen(false);
    setSearch(fullName);
  }

  if (value !== null) {
    return (
      <div className="space-y-1">
        <label className="block text-sm font-medium text-slate-700">
          Customer
        </label>
        <div
          data-testid={`${testId}-selected`}
          className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm"
        >
          <span className="font-medium text-slate-900">{value.fullName}</span>
          <button
            type="button"
            onClick={() => {
              onSelect(null);
              setSearch("");
            }}
            disabled={disabled}
            className="text-xs font-medium text-slate-600 underline hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid={`${testId}-change`}
          >
            Change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <label
          htmlFor="sale-customer-search"
          className="block text-sm font-medium text-slate-700"
        >
          Customer
        </label>
        <input
          id="sale-customer-search"
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name (min 3 letters)…"
          disabled={disabled}
          data-testid={`${testId}-search`}
          autoComplete="off"
          className={cn(
            "block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            "disabled:cursor-not-allowed disabled:bg-slate-50",
          )}
        />
      </div>

      {trimmed.length > 0 && trimmed.length < MIN_CHARS && (
        <p className="text-xs text-slate-500">
          Type at least {MIN_CHARS} characters to search.
        </p>
      )}

      {isLoading && (
        <p
          className="text-xs text-slate-500"
          data-testid={`${testId}-loading`}
        >
          Searching…
        </p>
      )}

      {showResults && hits !== undefined && (
        <ul
          data-testid={`${testId}-results`}
          className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white"
        >
          {hits.map((hit) => (
            <li key={hit.customerId}>
              <button
                type="button"
                onClick={() =>
                  onSelect({
                    customerId: hit.customerId,
                    fullName: hit.fullName,
                  })
                }
                data-testid={`${testId}-result-${hit.customerId}`}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"
              >
                <span className="font-medium text-slate-900">
                  {hit.fullName}
                </span>
                <span className="text-xs text-slate-500">
                  ID ***-***-{hit.govIdLast4}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {shouldSearch && hits !== undefined && hits.length === 0 && (
        <p className="text-xs text-slate-500" data-testid={`${testId}-empty`}>
          No customers match. Create a new one below.
        </p>
      )}

      <button
        type="button"
        onClick={() => setCreateOpen(true)}
        disabled={disabled}
        data-testid={`${testId}-create`}
        className={cn(
          "inline-flex min-h-[44px] items-center rounded-md border border-dashed border-slate-300",
          "px-3 py-2 text-sm font-medium text-slate-700",
          "hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        + Create new customer
      </button>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>New customer</DialogTitle>
            <DialogDescription>
              Create a customer to attach to this sale. The selection will
              auto-populate when the customer is saved.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto pr-1">
            <CustomerForm
              onCreated={handleCreated}
              onCancel={() => setCreateOpen(false)}
              ariaLabel="Inline create customer form"
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
