"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { StatePillTransition } from "@/components/ui/StatePillTransition";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import {
  getRecents,
  recordRecentView,
  type RecentEntityType,
  type RecentItem,
} from "@/lib/recents";

import { VisuallyHidden } from "./VisuallyHidden";

/**
 * LotSearchCommand — global Cmd-K palette (Story 1.10 production wiring).
 *
 * UX-DR12 commits to search-first navigation. This component is the
 * primary navigation path across the staff app — sidebar is secondary.
 * The body is filled (live `searchAll` query, 80ms debounce, grouped
 * results, recents, no-results state) on top of Story 1.5's scaffold.
 *
 * Composition:
 *   - Single `<Command shouldFilter={false}>` (server drives results;
 *     shadcn/ui's built-in fuzzy filter would conflict).
 *   - Wrapped in `<Dialog>` on ≥ md and `<Sheet>` on < md. Tailwind's
 *     `md:` breakpoint switches via class visibility — no JS viewport
 *     detection, no hydration mismatch.
 *   - Empty query → `<CommandGroup heading="RECENT">` listing up to 5
 *     localStorage-backed recents. Empty recents → friendly hint.
 *   - Live results → grouped headings ("LOTS", "CUSTOMERS",
 *     "CONTRACTS", "RECEIPTS"). Empty groups don't render their
 *     heading — cleaner than a list of empty sections.
 *
 * Phase 1 reality:
 *   - LOTS returns real data.
 *   - CUSTOMERS / CONTRACTS / RECEIPTS return `[]` from the server
 *     (Story 2.1 and Epic 3 fill in). Their group blocks are wired
 *     up so dropping in real results doesn't require re-architecting
 *     the palette.
 *
 * TODO (Story 1.11 / 2.1): the lot / customer detail pages must call
 * `recordRecentView(...)` on mount. URL- and back-button navigations
 * don't pass through this palette's `onSelect`, so the detail page is
 * the only catch for them.
 */

export interface LotSearchCommandProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Server result shapes. Mirrored by hand because `_generated/api.ts`
 *  is built interactively by `npx convex dev`. */
interface LotSearchHit {
  _id: string;
  code: string;
  section: string;
  block: string;
  row: string;
  type: "single" | "family" | "mausoleum" | "niche";
  status:
    | "available"
    | "reserved"
    | "sold"
    | "occupied"
    | "cancelled"
    | "defaulted"
    | "transferred";
}

interface CustomerSearchHit {
  _id: string;
  displayName: string;
}

interface ContractSearchHit {
  _id: string;
  serialNumber: string;
}

interface ReceiptSearchHit {
  _id: string;
  serialNumber: string;
}

interface SearchResults {
  lots: LotSearchHit[];
  customers: CustomerSearchHit[];
  contracts: ContractSearchHit[];
  receipts: ReceiptSearchHit[];
}

const searchAllRef = makeFunctionReference<
  "query",
  { query: string },
  SearchResults
>("search:searchAll");

const PLACEHOLDER = "Search lots, customers, contracts, receipts…";

/** UX-DR12: 80ms debounce on every keystroke. */
const DEBOUNCE_MS = 80;

export function LotSearchCommand({
  isOpen,
  onOpenChange,
}: LotSearchCommandProps) {
  return (
    <>
      {/* Desktop: centered Dialog, hidden on < md. */}
      <Dialog open={isOpen} onOpenChange={onOpenChange}>
        <DialogContent
          hideCloseButton
          className="hidden p-0 md:grid md:max-w-2xl"
          aria-describedby={undefined}
        >
          <VisuallyHidden>
            <DialogTitle>Global search</DialogTitle>
          </VisuallyHidden>
          {/* Only mount the body when open — otherwise typing in
              another field could fire useQuery against a closed
              palette. */}
          {isOpen && <PaletteBody onOpenChange={onOpenChange} />}
        </DialogContent>
      </Dialog>

      {/* Mobile: fullscreen Sheet, hidden on >= md. */}
      <Sheet open={isOpen} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          hideCloseButton
          className="h-full w-full max-w-none border-0 p-0 md:hidden"
          aria-describedby={undefined}
        >
          <VisuallyHidden>
            <SheetTitle>Global search</SheetTitle>
          </VisuallyHidden>
          {isOpen && <PaletteBody onOpenChange={onOpenChange} />}
        </SheetContent>
      </Sheet>
    </>
  );
}

interface PaletteBodyProps {
  onOpenChange: (open: boolean) => void;
}

/**
 * The palette body. Owns the input state, the debounced query, the
 * `useQuery` call, and the result rendering. Mounted only when the
 * palette is open so closed palettes don't subscribe to Convex.
 */
function PaletteBody({ onOpenChange }: PaletteBodyProps) {
  const router = useRouter();
  const [rawQuery, setRawQuery] = useState("");
  const debouncedQuery = useDebouncedValue(rawQuery, DEBOUNCE_MS);

  // Convex's "skip" sentinel pauses the subscription until the user
  // has typed something. Empty queries are answered locally with the
  // recents list — no need to round-trip.
  const trimmed = debouncedQuery.trim();
  const results = useQuery(
    searchAllRef,
    trimmed.length > 0 ? { query: trimmed } : "skip",
  );

  // Recents are read once per open (the component is remounted on
  // re-open thanks to the `isOpen && <PaletteBody/>` gate, so this
  // useState initialiser runs fresh each time).
  const [recents] = useState<RecentItem[]>(() => getRecents());

  // Show the loading shimmer only when we've actually issued a query
  // and Convex hasn't returned yet (still `undefined`). Empty-query
  // case bypasses loading entirely.
  const isLoading = trimmed.length > 0 && results === undefined;

  // Aggregate empty test for the "no results" message.
  const hasNoResults =
    trimmed.length > 0 &&
    results !== undefined &&
    results.lots.length === 0 &&
    results.customers.length === 0 &&
    results.contracts.length === 0 &&
    results.receipts.length === 0;

  const navigate = useCallback(
    (entityType: RecentEntityType, entityId: string, label: string) => {
      recordRecentView(entityType, entityId, label);
      onOpenChange(false);
      // Defer navigation so the close transition runs cleanly.
      const url =
        entityType === "lot"
          ? `/lots/${entityId}`
          : entityType === "customer"
            ? `/customers/${entityId}`
            : entityType === "contract"
              ? `/contracts/${entityId}`
              : `/receipts/${entityId}`;
      router.push(url);
    },
    [router, onOpenChange],
  );

  return (
    <Command label="Global search" shouldFilter={false}>
      <CommandInput
        placeholder={PLACEHOLDER}
        autoFocus
        value={rawQuery}
        onValueChange={setRawQuery}
        data-testid="lot-search-input"
      />
      {/* 1px progress bar at the top of the results pane. UX-DR forbids
          spinners; the pulsing accent stripe is the agreed signal. */}
      {isLoading && (
        <div
          data-testid="lot-search-loading"
          className="h-px w-full animate-pulse bg-slate-300"
          aria-hidden="true"
        />
      )}
      <CommandList>
        {/* Empty query: render recents (if any) and a hint. */}
        {trimmed.length === 0 && recents.length > 0 && (
          <CommandGroup heading="RECENT">
            {recents.map((r) => (
              <CommandItem
                key={`${r.entityType}:${r.entityId}`}
                value={`recent:${r.entityType}:${r.entityId}`}
                onSelect={() => navigate(r.entityType, r.entityId, r.label)}
              >
                <span className="font-mono">{r.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {trimmed.length === 0 && recents.length === 0 && (
          <div
            role="status"
            className="py-8 text-center text-sm text-slate-500"
            data-testid="lot-search-empty-hint"
          >
            Search lots, customers, contracts, receipts. Press ESC to close.
          </div>
        )}

        {/* Live results: hidden under the no-results message when all
            scopes are empty. */}
        {trimmed.length > 0 && results !== undefined && !hasNoResults && (
          <>
            {results.lots.length > 0 && (
              <CommandGroup heading="LOTS">
                {results.lots.map((lot) => (
                  <CommandItem
                    key={lot._id}
                    value={`lot:${lot._id}`}
                    onSelect={() => navigate("lot", lot._id, lot.code)}
                  >
                    <div className="flex w-full items-center gap-2">
                      <span className="font-mono">{lot.code}</span>
                      <span className="text-slate-500">·</span>
                      <span className="capitalize">{lot.type}</span>
                      <span className="ml-auto">
                        {/* Story 5.9 — Cmd-K search result status uses
                         *   StatePillTransition so a live reactive
                         *   status update (lot transitioning while the
                         *   palette is open) animates with the standard
                         *   300ms + 600ms motion pair. */}
                        <StatePillTransition status={lot.status} size="sm" />
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {results.customers.length > 0 && (
              <CommandGroup heading="CUSTOMERS">
                {results.customers.map((c) => (
                  <CommandItem
                    key={c._id}
                    value={`customer:${c._id}`}
                    onSelect={() => navigate("customer", c._id, c.displayName)}
                  >
                    {c.displayName}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {/* CONTRACTS and RECEIPTS groups: header omitted when empty.
                Wiring exists so Epic 3 can drop in results without a
                palette rewrite. */}
            {results.contracts.length > 0 && (
              <CommandGroup heading="CONTRACTS">
                {results.contracts.map((c) => (
                  <CommandItem
                    key={c._id}
                    value={`contract:${c._id}`}
                    onSelect={() =>
                      navigate("contract", c._id, `#${c.serialNumber}`)
                    }
                  >
                    #{c.serialNumber}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {results.receipts.length > 0 && (
              <CommandGroup heading="RECEIPTS">
                {results.receipts.map((r) => (
                  <CommandItem
                    key={r._id}
                    value={`receipt:${r._id}`}
                    onSelect={() =>
                      navigate("receipt", r._id, `#${r.serialNumber}`)
                    }
                  >
                    #{r.serialNumber}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </>
        )}

        {hasNoResults && (
          <CommandEmpty>
            <span role="status" data-testid="lot-search-no-results">
              No results for &ldquo;{trimmed}&rdquo;
            </span>
          </CommandEmpty>
        )}
      </CommandList>
    </Command>
  );
}

/**
 * Default export: Story 1.5's `<AppShell>` already mounts the named
 * export `LotSearchCommand`. The default export here is provided as a
 * convenience for any future per-page mounts (none exist in Phase 1).
 */
export default LotSearchCommand;
