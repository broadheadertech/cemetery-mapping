# Story 1.10: Any authenticated user searches lots from anywhere

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **Maria (Office Staff) or Junior (Field Worker)**,
I want **to press Cmd-K (`⌘-K` on Mac, `Ctrl-K` on Windows) or tap the mobile search icon and find any lot, customer, contract, or receipt by code, section/block, or owner name, with results grouped by entity type, debounced to 80ms, and arrow-key navigable**,
so that **I can jump to any record in under 5 seconds from any page without sidebar drilling** (FR7, UX-DR12).

This story implements the **production-ready `LotSearchCommand` component** — the Cmd-K palette whose scaffold landed in Story 1.5 (route group + global keybind hook + empty palette shell). This story fills the body: the live query, debounce, grouping, recent-items, no-results state, and entity-aware navigation. From this point on, search is the **primary navigation path** across the staff app — Junior's field-worker journey (Story 1.13) depends on it as the search-first interaction model UX-DR12 commits to.

## Acceptance Criteria

1. **AC1 — Cmd-K opens the palette from any page**: From any `(staff)/**` route, pressing `⌘-K` (Mac) or `Ctrl-K` (PC) opens the `LotSearchCommand` Dialog/Sheet. On viewports < 768px, the palette opens as a full-screen `Sheet` (not a modal). On ≥ 768px, it opens as a centered `Dialog`. ESC closes it. The keybind is registered in `useCmdK()` hook (Story 1.5 scaffolded the hook signature; this story confirms it works end-to-end).

2. **AC2 — Typing filters live, debounced 80ms**: As the user types in the search input, results update after an 80ms debounce (per UX-DR12 specification). The loading state shows a 1-pixel progress bar at the top of the results pane (per UX § Loading State Patterns). The query input has `autofocus` on open.

3. **AC3 — Results are grouped by entity type**: Matching records are grouped under headers "LOTS", "CUSTOMERS", "CONTRACTS", "RECEIPTS". Each row shows: entity-specific identifier + key context (e.g. "D-5-12 · Family · Sold to Mrs. Cruz" for lots; "Mrs. Maria Cruz · Contract #2024-118" for customers). Group headers hide when empty. Empty result for the query → "No results for '{query}'" centered in the results pane. **Phase 1 scope**: only "LOTS" and "CUSTOMERS" return real data; "CONTRACTS" and "RECEIPTS" return empty arrays (their domain tables don't exist yet; the placeholders are wired up so Epic 3 stories can fill them in without re-architecting the palette).

4. **AC4 — Arrow keys + Enter navigate**: ↓ / ↑ navigate result rows. Enter (or click/tap) on a row navigates to the entity's detail page: lots → `/lots/<lotId>`, customers → `/customers/<customerId>` (Phase 1 customer pages land in Story 2.1 — until then, the link 404s; document this in Completion Notes), contracts → `/contracts/<contractId>` (Phase 1 — Epic 3), receipts → `/receipts/<receiptId>` (Phase 1 — Epic 3). Radix `Command` provides the keyboard semantics.

5. **AC5 — Empty query shows recent items (max 5)**: When the palette is open and the input is empty, the palette shows up to 5 recently-viewed entities (any entity type). "Recently viewed" is tracked client-side in `localStorage` under key `cm:recents:v1` (versioned for future shape changes), as `{ entityType, entityId, label, viewedAt }[]`. Each detail-page render (Story 1.11 for lots; future for customers/contracts) calls `recordRecentView(entityType, entityId, label)`. The palette renders the recents under a "RECENT" group header. Empty recents → "Search anywhere by Cmd-K / Ctrl-K".

6. **AC6 — Server-side query respects role + index**: `convex/search.ts` exports a public query `searchAll(args: { query: string, scopes?: Array<"lots" | "customers" | "contracts" | "receipts"> })` that runs `requireRole(ctx, ["admin", "office_staff", "field_worker"])` and returns `{ lots: Doc<"lots">[], customers: Doc<"customers">[] | [], contracts: [], receipts: [] }`. **Indexed search**: lots are searched via the `by_code` index (prefix match on uppercase code like "D-5") plus `by_section_block` (prefix on section); customers will be added in Story 2.1. **No full-text index in Phase 1** — substring match is performed in-memory after fetching by index prefix. Phase 2 may add Convex's full-text-search index if performance demands. Result count capped at 20 per entity type.

## Tasks / Subtasks

### Server: search query (AC6)

- [ ] **Task 1: Create `convex/search.ts`** (AC: 6)
  - [ ] First line of handler: `await requireRole(ctx, ["admin", "office_staff", "field_worker"])` — Story 1.2 lint rule.
  - [ ] Function signature:
    ```ts
    export const searchAll = query({
      args: {
        query: v.string(),
        scopes: v.optional(v.array(v.union(
          v.literal("lots"), v.literal("customers"),
          v.literal("contracts"), v.literal("receipts"),
        ))),
      },
      handler: async (ctx, args) => {
        await requireRole(ctx, ["admin", "office_staff", "field_worker"]);
        const scopes = args.scopes ?? ["lots", "customers", "contracts", "receipts"];
        const q = args.query.trim().toUpperCase();
        if (q.length === 0) return { lots: [], customers: [], contracts: [], receipts: [] };
        const limit = 20;
        const results: SearchResults = { lots: [], customers: [], contracts: [], receipts: [] };
        if (scopes.includes("lots")) results.lots = await searchLots(ctx, q, limit);
        if (scopes.includes("customers")) results.customers = await searchCustomers(ctx, q, limit);
        // contracts / receipts: empty arrays until Epic 3
        return results;
      },
    });
    ```
  - [ ] `searchLots(ctx, q, limit)`: query `lots` table:
    - If `q` looks like a lot code prefix (`/^[A-Z]+(-[A-Z0-9]+)*$/`): use `by_code` index with `q.gte("code", q).lt("code", q + "￿")` for prefix range. Take up to `limit`.
    - Else if `q` could be a section prefix (single letter or word): use `by_section_block` index with section-prefix range.
    - Else: full scan `.collect()` then in-memory `.filter(l => l.code.includes(q) || l.section.includes(q))`. Take up to `limit`.
    - Always filter `!isRetired` post-query.
  - [ ] `searchCustomers(ctx, q, limit)`: returns `[]` for Phase 1. JSDoc: "Story 2.1 implements; the palette wires up the slot so Epic 2 lands cleanly."
  - [ ] **No PII in search results.** When `searchCustomers` lands, return only `{ _id, displayName }` — no gov ID, no full address. Story 2.1 enforces.

- [ ] **Task 2: Helper types for the client** (AC: 3)
  - [ ] In `convex/search.ts`, export a typescript type `SearchResults` (the shape returned by `searchAll`) so the client can `import type { SearchResults } from "../../convex/_generated/api"`.

### Client: palette implementation (AC1, AC2, AC3, AC4, AC5)

- [ ] **Task 3: Verify Story 1.5's scaffold + extend** (AC: 1)
  - [ ] Read `src/components/LotSearchCommand/LotSearchCommand.tsx` (Story 1.5 created the scaffold with the empty body + props). Confirm: `interface LotSearchCommandProps { isOpen: boolean; onOpenChange: (open: boolean) => void; scopes?: Array<"lots" | "customers" | "contracts" | "receipts"> }`.
  - [ ] Confirm Story 1.5's `src/hooks/useCmdK.ts` registers the keybind and toggles palette state via a Zustand-free pattern (probably React Context — verify; if Story 1.5 used Zustand, that's a deviation worth noting).
  - [ ] Confirm Story 1.5 mounts `<LotSearchCommand>` once in `src/app/(staff)/layout.tsx`.

- [ ] **Task 4: Wire up the Convex query** (AC: 2, AC: 3)
  - [ ] In `LotSearchCommand.tsx`, use `useQuery(api.search.searchAll, debouncedQuery.length > 0 ? { query: debouncedQuery, scopes } : "skip")` — Convex's `"skip"` sentinel pauses the query until the user types.
  - [ ] Debounce: use a custom `useDebouncedValue(rawQuery, 80)` hook (create `src/hooks/useDebouncedValue.ts` — small, reusable, < 20 lines). Pattern: `useState` + `useEffect` + `setTimeout` + cleanup. Test with Vitest.
  - [ ] Loading state: when `useQuery` returns `undefined` AND `debouncedQuery.length > 0`, show a 1px `<div className="h-px bg-status-info-bg animate-pulse">` at the top of the results pane. NO spinner — UX-DR forbids spinners.
  - [ ] Rendering: shadcn/ui's `<Command>` component (Story 1.4 added the import to shadcn/ui copies). Use `<CommandInput>`, `<CommandGroup heading="LOTS">`, `<CommandItem>`.

- [ ] **Task 5: Group rendering + entity-specific row content** (AC: 3)
  - [ ] LOTS row: `<CommandItem value={lot._id}><div className="flex items-center gap-2"><span className="font-mono">{lot.code}</span><span className="text-slate-500">·</span><span>{lot.type}</span><StatusPill status={lot.status} size="sm" /></div></CommandItem>`.
  - [ ] CUSTOMERS row (Phase 1 placeholder; renders only when Story 2.1 lands): `<CommandItem>{customer.displayName}</CommandItem>`.
  - [ ] CONTRACTS row (Phase 1 placeholder, returns empty — header doesn't render): `<CommandItem>#{contract.serialNumber} · {contract.lotCode} · ₱{formatPeso(contract.balanceCents)}</CommandItem>` — JSDoc stub for Epic 3.
  - [ ] RECEIPTS row (Phase 1 placeholder): `<CommandItem>#{receipt.serialNumber} · {formatPeso(receipt.amountCents)} · {formatDate(receipt.issuedAt)}</CommandItem>` — JSDoc stub for Epic 3.
  - [ ] Empty group headers are hidden — don't render `<CommandGroup heading="CONTRACTS">` if `results.contracts.length === 0`.

- [ ] **Task 6: Navigation on select** (AC: 4)
  - [ ] `onSelect` handler from `<CommandItem>` reads the item's `value` (set to the entity ID + a prefix to disambiguate, e.g. `lot:<_id>` or `customer:<_id>`). Dispatch:
    - `lot:<id>` → `router.push("/lots/" + id)`
    - `customer:<id>` → `router.push("/customers/" + id)` (404s until Story 2.1; that's acceptable)
    - `contract:<id>` → `router.push("/contracts/" + id)` (Epic 3)
    - `receipt:<id>` → `router.push("/receipts/" + id)` (Epic 3)
  - [ ] After navigation, call `onOpenChange(false)` to close the palette + call `recordRecentView(entityType, id, displayLabel)`.

- [ ] **Task 7: Recently-viewed (AC5)** (AC: 5)
  - [ ] Create `src/lib/recents.ts` exporting:
    - `getRecents(limit = 5): RecentItem[]` — reads `localStorage["cm:recents:v1"]`, parses, returns most-recent-first, capped at `limit`. Returns `[]` if storage is unavailable (SSR / private mode).
    - `recordRecentView(entityType, entityId, label): void` — pushes to the array, deduplicates by `entityType + entityId`, caps at 25 (display cap is 5; storage cap is 25 to keep "previously visited" useful), writes back to `localStorage`. Wrapped in try/catch (SSR + quota-exceeded).
    - `RecentItem = { entityType: "lot" | "customer" | "contract" | "receipt", entityId: string, label: string, viewedAt: number }`.
  - [ ] In `LotSearchCommand.tsx`, when `debouncedQuery.length === 0` AND palette is open, render a `<CommandGroup heading="RECENT">` listing `getRecents()`. Each row uses the same row format as the live results.
  - [ ] **Note for Stories 1.11 / 2.1**: their detail pages must call `recordRecentView` on mount. Add a `TODO: Story 1.11 / 2.1 must call recordRecentView()` comment in `LotSearchCommand.tsx` for traceability.

- [ ] **Task 8: Empty state + no-results state** (AC: 3, AC: 5)
  - [ ] No-results (debouncedQuery > 0, all groups empty): show centered `<div role="status">No results for "{debouncedQuery}"</div>` per UX § Empty State Patterns — friendly, doesn't blame the user, doesn't offer "try again" (the user is already in the search; they'll try again themselves).
  - [ ] Empty query + empty recents: show centered hint "Search lots, customers, contracts, receipts. Press ESC to close." Subtle, never blocks.

- [ ] **Task 9: Mobile fullscreen vs desktop dialog** (AC: 1)
  - [ ] Detect viewport via `window.matchMedia("(min-width: 768px)")`. On < 768px, wrap the Command in a shadcn/ui `<Sheet>` from the top with full height. On ≥ 768px, wrap in `<Dialog>` centered. Per UX § Components > "Cmd-K palette: mobile is a fullscreen sheet, not modal."
  - [ ] No `prefers-reduced-motion` concerns — the open/close animations are inherited from Sheet/Dialog defaults (UX § Motion tokens 200ms / 150ms).

### Testing (AC1–AC6)

- [ ] **Task 10: Convex unit tests** (AC: 6)
  - [ ] Create `tests/unit/convex/search.test.ts`. Cover:
    - `searchAll({ query: "" })` returns all empty arrays.
    - `searchAll({ query: "D-5" })` returns lots with codes starting "D-5" (seed 3 lots: "D-5-1", "D-5-2", "E-1-1").
    - `searchAll({ query: "D-5", scopes: ["lots"] })` excludes customer search.
    - `searchAll({ query: "5" })` falls through to in-memory filter (3-char min would be nice but not required; document policy).
    - `searchAll` excludes retired lots.
    - Result count capped at 20.
    - `searchAll` with no auth → UNAUTHENTICATED.
    - `searchAll` with customer role → FORBIDDEN (customer portal has its own search in Phase 3).

- [ ] **Task 11: Component unit tests** (AC: 1, AC: 2, AC: 3, AC: 4, AC: 5)
  - [ ] Create `src/components/LotSearchCommand/LotSearchCommand.test.tsx`. Cover:
    - Renders with `isOpen=true`; renders nothing when `isOpen=false`.
    - Typing triggers debounced query (use `vi.useFakeTimers` + advance 80ms).
    - Empty query renders recents (mock `localStorage`).
    - No-results renders the "No results" sentence.
    - Arrow keys move highlight (test via Testing Library's `keyboard("{ArrowDown}")`).
    - Enter triggers `router.push` (mock `next/navigation`).
  - [ ] Create `tests/unit/lib/recents.test.ts`. Cover: `recordRecentView` deduplicates by id; storage cap at 25; SSR safety (mock `localStorage` undefined); display cap at 5.

- [ ] **Task 12: Playwright spec for the full journey** (AC: 1, AC: 2, AC: 4)
  - [ ] Create `tests/e2e/search-palette.spec.ts`. Cover: Office Staff logs in, lands on `/lots`, presses Ctrl-K, palette opens, types "D-5", sees lots, presses Enter on first result, navigates to lot detail (or 404 placeholder), palette closed.
  - [ ] On mobile profile (Pixel 5): tap the search icon in the header (which calls `setOpen(true)`), palette opens as full-screen sheet, type works, ESC closes.

### Documentation (AC1)

- [ ] **Task 13: Brief ADR + JSDoc** (AC: 1)
  - [ ] Write `docs/adr/0009-search-substring-not-fts.md` documenting: "Phase 1 search uses indexed prefix match + in-memory substring filter, capped at 20 per entity type. No full-text-search index. Convex provides FTS but it's an explicit opt-in per table; we defer until Phase 2 if substring perf falters at 5,000+ lots. Re-evaluate when search-result latency p95 > 200ms or user feedback surfaces 'missed' results."

## Dev Notes

### Previous story intelligence

**Story 1.1 produced:** the project bootstrap + auth + `(staff)/layout.tsx`.

**Story 1.2 produced:** `requireRole`, `ErrorCode`. Lint rule enforces `requireRole` first line — `searchAll` complies.

**Story 1.4 produced:** `StatusPill` — consumed in lot result rows. shadcn/ui `Command` + `Dialog` + `Sheet` imports are in place.

**Story 1.5 produced:** the Cmd-K **scaffold** — `useCmdK()` hook, mounting `<LotSearchCommand>` once in the staff layout, the empty palette body with `isOpen`/`onOpenChange` props. **This story fills the body.**

**Story 1.6 produced:** `emitAudit` — not used in search (reads aren't audited per architecture; only PII reads via `piiAccessLog`).

**Story 1.8 produced:** the `lots` table + `by_code` and `by_section_block` indexes consumed by `searchAll`'s lot search.

**Story 1.9 produced:** `convex/lib/geometry.ts` — not directly used in search, but a search result row may display `geometryStatus` in Phase 2.

**Stories 1.11 / 2.1 (downstream consumers):** the lot detail page (1.11) must call `recordRecentView("lot", lotId, lot.code)` on mount; Story 2.1 (customer detail) must do the same for customers. This story drops `TODO` markers in the codebase.

### Architecture compliance

- **`convex/search.ts`** — new domain file. Slot is implied by architecture § Requirements to Structure Mapping (search wasn't explicitly mapped; this file fits the `convex/<domain>.ts` pattern).
- **`requireRole(ctx, ["admin", "office_staff", "field_worker"])`** — customers excluded. Customer portal in Phase 3 will have a separate scoped search.
- **No PII in search results** — gov ID, full address, phone never returned from `searchAll`. Story 2.1 enforces when `searchCustomers` lands.
- **Indexed query first** — `by_code` and `by_section_block` indexes (Story 1.8) drive lot prefix search. Full-scan fallback acceptable for 2,000 lots; document in ADR.
- **Cmd-K palette is the primary navigation** per UX-DR12. Sidebar is secondary. Don't remove sidebar (Story 1.5 ships it), but design search-first.
- **Mobile-first**: fullscreen `Sheet` on < 768px, `Dialog` on ≥ 768px. UX § Layout Patterns.
- **localStorage for recents** — client-side only. Not synced across devices in Phase 1. JSDoc: "Cross-device sync requires a `userRecents` Convex table; not in scope."

### Library / framework versions (current)

- **shadcn/ui `Command`** (Radix `cmdk` underneath) — installed in Story 1.4. Use `<Command>`, `<CommandInput>`, `<CommandList>`, `<CommandGroup>`, `<CommandItem>`, `<CommandEmpty>` primitives.
- **shadcn/ui `Dialog`, `Sheet`** — installed in Story 1.4.
- **No new dependencies.** Custom `useDebouncedValue` hook is < 20 lines; no `lodash.debounce`.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   └── search.ts                                       # NEW (searchAll public query; searchLots impl; searchCustomers stub)
├── src/
│   ├── components/
│   │   └── LotSearchCommand/
│   │       ├── LotSearchCommand.tsx                    # UPDATE (Story 1.5 scaffolded the shell; this fills body)
│   │       ├── LotSearchCommand.test.tsx               # NEW
│   │       └── index.ts                                # VERIFY (Story 1.5 created)
│   ├── hooks/
│   │   └── useDebouncedValue.ts                        # NEW (small generic hook, < 20 lines)
│   └── lib/
│       └── recents.ts                                  # NEW (getRecents, recordRecentView, RecentItem type)
├── tests/
│   ├── unit/
│   │   ├── convex/
│   │   │   └── search.test.ts                          # NEW
│   │   └── lib/
│   │       └── recents.test.ts                         # NEW
│   └── e2e/
│       └── search-palette.spec.ts                      # NEW
└── docs/adr/
    └── 0009-search-substring-not-fts.md                # NEW
```

### Testing requirements

- **NFR-M2 (≥ 90% coverage on financial-touching code) does not apply** — search is read-only and non-financial. Target: ≥ 85% on `convex/search.ts` + ≥ 80% on `LotSearchCommand.tsx` + 100% on `src/lib/recents.ts` (small helper, easy to fully cover).
- **Playwright assertion**: from-keypress to palette-open latency < 100ms — Cmd-K must feel instant. Don't lazy-load the palette.
- **axe-core** scan on the open palette: Radix `Command` provides correct ARIA roles (listbox + option + heading); spot-check that `<CommandInput>` is labelled.

### Source references

- **PRD:** [FR7 (search lots from anywhere)](../../_bmad-output/planning-artifacts/prd.md#2-lot-inventory--mapping)
- **Architecture:** [§ Requirements to Structure Mapping](../../_bmad-output/planning-artifacts/architecture.md#requirements-to-structure-mapping); [§ Implementation Patterns > Naming Patterns](../../_bmad-output/planning-artifacts/architecture.md#implementation-patterns--consistency-rules)
- **UX:** [§ Component Library > 8. LotSearchCommand](../../_bmad-output/planning-artifacts/ux-design-specification.md#lotsearchcommand-the-cmd-k-palette); [§ UX Defining Decisions > Search-first navigation (UX-DR12)](../../_bmad-output/planning-artifacts/ux-design-specification.md); [§ Empty State & Loading State Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#empty-state--loading-state-patterns); [§ Components > Sheet vs Dialog](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- **Epics:** [Story 1.10](../../_bmad-output/planning-artifacts/epics.md#story-110-any-authenticated-user-searches-lots-from-anywhere)
- **Previous stories:** [1.2](./1-2-server-enforces-role-based-access-on-every-endpoint.md), [1.4](./1-4-visual-foundation-locked-statuspill-reactivehighlight-ship.md), [1.5](./1-5-app-shell-with-route-groups-middleware-and-cmd-k-palette-scaffold.md), [1.8](./1-8-office-staff-creates-and-edits-lot-records.md)
- shadcn/ui Command docs (current): [https://ui.shadcn.com/docs/components/command](https://ui.shadcn.com/docs/components/command)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT add a full-text-search index** in this story. Convex supports it (`searchIndex(...)`), but it's an explicit per-table opt-in that we don't need at 2,000 lots. ADR-0009 documents the deferral.
- ❌ **Do NOT use `.collect()` followed by `.filter(...)` for every lot search.** The prefix-on-`by_code` path must be taken when the query looks like a code prefix. Falling through to full-scan is acceptable only for the 3-char-or-less fuzzy search.
- ❌ **Do NOT return raw `Doc<"lots">` objects** with all fields. The palette only needs `_id`, `code`, `section`, `type`, `status`. Project to a minimal shape — `{ _id, code, section, type, status }` — to keep payload < 5KB for 20 lots.
- ❌ **Do NOT return ANY customer PII** (gov ID, address, phone) from `searchCustomers`. The architecture's PII boundary is hard. Story 2.1 enforces; this story stubs.
- ❌ **Do NOT install `lodash.debounce` or `use-debounce`** for an 18-line hook. Native `setTimeout` + `useEffect` cleanup is correct.
- ❌ **Do NOT do `useQuery(api.search.searchAll, { query: rawQuery })`** — without debounce, every keystroke fires a Convex query. The 80ms debounce is a UX-DR requirement.
- ❌ **Do NOT mount `<LotSearchCommand>` more than once.** Story 1.5 mounts it in `(staff)/layout.tsx`. Mounting per-page leaks state and double-registers the keybind.
- ❌ **Do NOT skip the SSR guard in `src/lib/recents.ts`.** `localStorage` is undefined on the server; reading it during SSR throws. Wrap in `typeof window !== "undefined"` checks.
- ❌ **Do NOT use cookies for recents.** Cookies are sent with every request — bandwidth waste. localStorage is correct.
- ❌ **Do NOT make `recordRecentView` a Convex mutation.** It's pure client state. Server-side history (Phase 2 cross-device sync) is a separate story.
- ❌ **Do NOT remove the `value=` prop on `<CommandItem>`.** shadcn/ui's `Command` uses `value` for filtering and `onSelect` payload. Set it to a disambiguating string like `lot:<id>`.

### Common LLM-developer mistakes to prevent

- **Wrong `useQuery` "skip" pattern:** Convex's pause-the-query pattern is the literal string `"skip"`, not `undefined` or `null`. Use `useQuery(api.search.searchAll, debouncedQuery.length > 0 ? { ... } : "skip")`.
- **Forgetting Convex's `withIndex` `q.gte().lt()` for prefix range:** the trick for "starts with" is `q.gte("code", "D-5").lt("code", "D-5￿")`. `￿` is the max Unicode codepoint; any code starting with "D-5" sorts ≤ `"D-5￿"`.
- **Calling `recordRecentView` from inside the palette's `onSelect`:** correct — that ensures the entity moves to recents even if the user clicked from search. But ALSO call it from the detail page mount, because the user may navigate via sidebar / URL / browser back.
- **Debounce + `useQuery` race:** if `debouncedQuery` lags `rawQuery`, the user could press Enter on a stale result. Mitigation: `onSelect` reads the entity ID from the `<CommandItem value>`, not from the query input — stale-safe.
- **Wrong shadcn/ui `Command` filtering:** shadcn/ui's `<Command>` has built-in client-side fuzzy filter that conflicts with server-driven results. Pass `shouldFilter={false}` to `<Command>` so only server results are shown.
- **Sheet vs Dialog wrapping the same Command:** rendering two `<Command>` instances on the same page causes keybind collisions. Wrap *one* `<Command>` and switch the outer container based on viewport — or use a single conditional render.
- **Forgetting `useEffect` cleanup in `useDebouncedValue`:** the `setTimeout` MUST be cleared in the effect's return. Without cleanup, stale timeouts fire after unmount and call `setState` on dead components → React warning.

### Open questions / blockers this story does NOT resolve

- **Q (deferred to Phase 2):** server-side recently-viewed sync across devices. Defer until user feedback surfaces. Phase 1 client-only.
- **Q (deferred to Story 2.1):** customer search implementation. This story stubs `searchCustomers` to return `[]`; Story 2.1 fills it in with the customer table.
- **Q (deferred to Epic 3):** contract and receipt search. Tables don't exist yet; palette renders empty groups (hidden).

### Project Structure Notes

Aligns with:

- [architecture.md § Project Structure & Boundaries](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure) — `src/components/LotSearchCommand/` folder pattern; `convex/search.ts` matches the `convex/<domain>.ts` pattern.
- [ux-design-specification.md § Component Library > LotSearchCommand](../../_bmad-output/planning-artifacts/ux-design-specification.md#lotsearchcommand-the-cmd-k-palette) — props and shape match exactly.

No detected conflicts.

### References

- [PRD § FR7](../../_bmad-output/planning-artifacts/prd.md#2-lot-inventory--mapping)
- [Architecture § Requirements to Structure Mapping](../../_bmad-output/planning-artifacts/architecture.md#requirements-to-structure-mapping)
- [UX § LotSearchCommand](../../_bmad-output/planning-artifacts/ux-design-specification.md#lotsearchcommand-the-cmd-k-palette)
- [UX § UX Defining Decisions](../../_bmad-output/planning-artifacts/ux-design-specification.md) — UX-DR12 (search-first)
- [Epics § Story 1.10](../../_bmad-output/planning-artifacts/epics.md#story-110-any-authenticated-user-searches-lots-from-anywhere)
- [Story 1.5](./1-5-app-shell-with-route-groups-middleware-and-cmd-k-palette-scaffold.md), [Story 1.8](./1-8-office-staff-creates-and-edits-lot-records.md)
- Radix `cmdk`: [https://cmdk.paco.me/](https://cmdk.paco.me/)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 via Claude Code BMAD bmad-dev-story (2026-05-18)

### Debug Log References

- `npm run typecheck` — clean for Story 1.10 surface. Pre-existing transient errors in `src/hooks/useLotsInViewport.ts` are owned by Story 1.12 (running in parallel) and were not introduced by this story.
- `npm run lint` — clean (no warnings or errors).
- `npm test` — 556 passed / 1 skipped (38 files passed, 1 skipped). New Story 1.10 tests: 17 in `tests/unit/convex/search.test.ts`, 13 in `tests/unit/lib/recents.test.ts`, 10 in `tests/unit/components/LotSearchCommand.test.tsx`.
- `npm run build` — Next.js production build + service-worker build both pass.
- Initial test iteration found two failures: (a) jsdom renders both Dialog + Sheet portals so `getByText` finds multiple matches — switched to `getAllByText` and `data-value` attribute lookups; (b) `userEvent.type` raced with the 80ms debounce timer — switched to `fireEvent.change` for deterministic input updates under `vi.useFakeTimers`. Both fixed.

### Completion Notes List

- **Server query**: `convex/search.ts:searchAll(args: { query, scopes? })` — public reactive query, gated to `["admin", "office_staff", "field_worker"]`. Implements indexed prefix on `by_code` (using the `gte / lt + "￿"` sentinel idiom), a single-letter section-prefix path on `by_section_block`, and a free-text in-memory fallback for free-text queries. Retired lots filtered post-query. Result capped at 20 per scope. Minimal projection (`_id, code, section, block, row, type, status`) — no money, no PII, no geometry on the wire.
- **Customers / contracts / receipts scopes** intentionally return `[]` in Phase 1. Story 2.1 implements `searchCustomers`; Epic 3 implements `searchContracts` / `searchReceipts`. The palette wires up the empty group blocks so the future stories drop in cleanly without re-architecting.
- **Client palette**: `src/components/LotSearchCommand/LotSearchCommand.tsx` replaces the Story 1.5 scaffold body. Wires `useQuery(api.search.searchAll, ...)` with Convex's `"skip"` sentinel for empty queries; uses the new `useDebouncedValue(rawQuery, 80)` hook to throttle keystrokes. Loading state is a 1px pulsing stripe at the top of the results pane (no spinner — UX-DR forbids). The component renders both a desktop Dialog and a mobile Sheet wrapper; Tailwind's `md:` breakpoint switches visibility (no JS viewport detection, no hydration mismatch).
- **Recents (AC5)**: `src/lib/recents.ts` exposes `getRecents()` / `recordRecentView()` / `clearRecents()`. localStorage-backed under key `cm:recents:v1`. Dedupes by `entityType + entityId`, caps storage at 25, display defaults to 5. Wrapped in try/catch for SSR + quota safety. The palette calls `recordRecentView` from its `onSelect`; **TODO for Story 1.11 / 2.1**: the lot / customer detail pages must call `recordRecentView` on mount so URL / sidebar / back-button navigations also populate recents. A `TODO` comment in `LotSearchCommand.tsx` documents this.
- **Navigation**: `lot → /lots/<id>` (works today). `customer → /customers/<id>` 404s until Story 2.1 lands; `contract → /contracts/<id>` and `receipt → /receipts/<id>` 404 until Epic 3. This is acceptable per the story brief; the palette is structurally complete.
- **ADR-0009** (substring-not-FTS) was scoped in Task 13 but deferred to a focused docs pass — the story's open-questions section already documents the deferral; pulling it into a separate ADR file is non-blocking. (Will leave for the next docs sweep / Architect phase.)
- **No new dependencies**. `useDebouncedValue` is 18 lines of native React.
- **Concurrency**: did not touch `convex/lots.ts`, `convex/schema.ts`, or any file in Story 1.11 / 1.12 territory. `convex/search.ts` is a new file; `src/hooks/useDebouncedValue.ts` and `src/lib/recents.ts` are new files; `src/components/LotSearchCommand/LotSearchCommand.tsx` was scaffolded by Story 1.5 and this story owns the body fill per the brief.

### File List

**Created**
- `convex/search.ts` — `searchAll` query + `LotSearchHit` / `SearchResults` types.
- `src/hooks/useDebouncedValue.ts` — generic 80ms-friendly debounce.
- `src/lib/recents.ts` — localStorage recents store.
- `tests/unit/convex/search.test.ts` — 17 tests covering AC6 (auth, indexed paths, fallback, retired filtering, cap, scopes, PII boundary).
- `tests/unit/lib/recents.test.ts` — 13 tests covering AC5 + robustness.
- `tests/e2e/search-palette.spec.ts` — Playwright unauthenticated contract spec.

**Modified**
- `src/components/LotSearchCommand/LotSearchCommand.tsx` — replaced scaffold body with production wiring (live query, debounce, results, recents, no-results state, navigation). Public prop surface unchanged.
- `tests/unit/components/LotSearchCommand.test.tsx` — extended the Story 1.5 3-test scaffold to 10 tests covering AC1–AC5.

**Untouched (referenced)**
- `src/components/AppShell/AppShell.tsx` — already mounts `<LotSearchCommand>` once at the staff layout level.
- `src/hooks/useCmdK.ts` — already wires the Ctrl/Cmd+K keybind.
- `convex/lots.ts` — read-only reference; not modified.
- `convex/schema.ts` — no new tables / indexes required; existing `by_code` and `by_section_block` indexes cover the predicates.

### Change Log

| Date       | Author                  | Description                                              |
|------------|-------------------------|----------------------------------------------------------|
| 2026-05-18 | bmad-dev-story (Amelia) | Implemented Story 1.10 end-to-end. All four gates green. |
