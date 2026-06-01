# Story 1.11: Office Staff views any lot's detail

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **Office Staff (Maria) or Field Worker (Junior)**,
I want **to view a lot's complete detail page at `/lots/<lotId>` — status pill + dimensions + type + base price + currently-active ownership + occupants list + active contract preview + payment history placeholder — with reactive cross-tab updates and the 600ms amber flash on changes**,
so that **I can answer any customer question or coordinate with a colleague in real time, without consulting paper records or refreshing the page** (FR8).

This story implements the **canonical lot detail page** that supersedes Story 1.8's temporary `/lots/[lotId]/edit/page.tsx` scaffold. The detail page is the destination for: Story 1.10's search palette ("Enter on a lot result"), Story 1.12's map ("click a polygon"), the sidebar Lots list (Story 1.8), and Story 1.14's "Log condition" button (which slides in a Sheet from this page). It also seeds the `recordRecentView` integration from Story 1.10 — every lot detail render adds to the recents.

## Acceptance Criteria

1. **AC1 — Page renders all required sections (loaded state)**: At `/lots/<lotId>`, the page renders, in this order: (a) header with `<h1>` of lot code + `<StatusPill>` next to it; (b) "Lot facts" panel with type, dimensions (W × D m), section/block/row, base price (formatted `formatPeso`), `geometryStatus` pill ("placeholder" / "surveyed"); (c) "Ownership" panel — current owner customer name + relationship if any, else "Available" + a primary "New Sale" button; (d) "Occupants" panel — list of occupants with relationship + interment date (empty for Phase 1 — table doesn't exist yet; render "No occupants recorded"); (e) "Active contract" preview — contract serial + balance + next-due-date (empty for Phase 1 — contracts table doesn't exist yet; render "No active contract"); (f) "Payment history" — placeholder section with "Payments coming in Epic 3" subtle text; (g) "Recent condition logs" — list of last 5 `lotConditionLogs` entries (empty until Story 1.14 lands; render "No condition reports yet"); (h) inline Edit / Retire actions (Office Staff only, hidden for Field Worker).

2. **AC2 — Reactive cross-tab updates with amber flash**: When the lot's `status` changes server-side (e.g. someone else marks it `sold` via a future sale flow, or in Phase 1, an `updateLot` from another tab), the `StatusPill` cross-fades 300ms (Story 1.4's `StatePillTransition`) AND the surrounding section gets a 600ms amber flash via `<ReactiveHighlight watch={lot.status}>`. Same for `geometryStatus` changes. The reactive update arrives within 1 second per UX-DR's "1-second sync target". `prefers-reduced-motion: reduce` disables both effects (UX § Animation).

3. **AC3 — Field Worker sees the detail page but cannot edit or retire**: For roles `["admin", "office_staff", "field_worker"]`, the page renders. For role `field_worker`, the "Edit" and "Retire" buttons are hidden (UI gate); the server-side mutations `updateLot` and `retireLot` (Story 1.8) already enforce the role gate. The "Log condition" button (Story 1.14) IS visible for field workers (and office staff).

4. **AC4 — Recents integration**: On mount, the page calls `recordRecentView("lot", lotId, lot.code)` (from Story 1.10's `src/lib/recents.ts`) so the lot appears in the Cmd-K palette's "RECENT" group on next open. Called via `useEffect(() => { ... }, [lotId])` so navigating between lots updates recents correctly.

5. **AC5 — Loading + not-found + error states**: While `useQuery(api.lots.getLot, { lotId })` returns `undefined`, render a skeleton with the same shape as the loaded layout (per UX § Loading State Patterns — never blank screen, never spinner). If `getLot` returns `null` (lot deleted or invalid ID), render the not-found state per UX § Empty State Patterns: "We couldn't find that lot. It may have been retired or the link is incorrect." with a "Back to Lots" link. If `getLot` throws (e.g. role check fails for an unauthenticated user — shouldn't happen post-middleware, but defensive), render the error state via the top-level error boundary.

6. **AC6 — Page meets accessibility + performance NFRs**: One `<h1>` per page. Lot code in the `<title>` (e.g. "Lot D-5-12 · Cemetery Mapping"). `Edit` and `Retire` buttons have `aria-label` describing the action. Tab order is logical (header → ownership → occupants → contract → conditions → actions). Touch targets ≥ 44px (NFR-A4). Lighthouse mobile assertions: performance ≥ 0.9, accessibility ≥ 0.95. First Contentful Paint < 1.5s (NFR-P1).

## Tasks / Subtasks

### Server: read query enhancements (AC1)

- [ ] **Task 1: Extend `convex/lots.ts → getLot` to return composite detail data** (AC: 1) — **DEFERRED**: the dev-orchestration override marks `convex/**` as READ-ONLY for this story. The page consumes the existing `lots:getLot` + `conditionLogs:listLotConditionLogs` queries instead. The composite `getLotDetail` query stays a TODO for the follow-up story that owns ownership / contracts data; the Phase 1 placeholder panels make that a pure additive change.
  - [ ] Story 1.8's `getLot(args: { lotId })` returns `Doc<"lots"> | null`. Extend it (or add a sibling `getLotDetail`) to ALSO return: current ownership (placeholder — `null` until Story 2.3 ownerships table lands), occupants (`[]` placeholder — Phase 1 stub), active contract (`null` placeholder — Epic 3 stub), recent condition logs (`[]` placeholder — Story 1.14 fills).
  - [ ] Decision: **add a sibling query `getLotDetail`** rather than overload `getLot`. Single-purpose queries are clearer + avoid breaking Story 1.10's `searchLots` consumer.
  - [ ] Signature:
    ```ts
    export const getLotDetail = query({
      args: { lotId: v.id("lots") },
      handler: async (ctx, args) => {
        await requireRole(ctx, ["admin", "office_staff", "field_worker"]);
        const lot = await ctx.db.get(args.lotId);
        if (!lot) return null;
        return {
          lot,
          currentOwnership: null,      // TODO: Story 2.3 fills
          occupants: [],               // TODO: Story 2.x fills (occupants tracking)
          activeContract: null,        // TODO: Epic 3 fills
          recentConditionLogs: [],     // TODO: Story 1.14 fills
        };
      },
    });
    ```
  - [ ] **Note for Story 1.14**: Story 1.14 must extend `recentConditionLogs` to actually fetch from the `lotConditionLogs` table. Add a `TODO: Story 1.14` comment in the handler.
  - [ ] **Note for Story 2.3**: same pattern — extend `currentOwnership` from the `ownerships` table.

### Client: detail page (AC1, AC2, AC3, AC4, AC5, AC6)

- [x] **Task 2: Create `/lots/[lotId]/page.tsx`** (AC: 1, AC: 5, AC: 6)
  - [ ] Create `src/app/(staff)/lots/[lotId]/page.tsx` — client component (`"use client"`).
  - [ ] Use `useQuery(api.lots.getLotDetail, { lotId })`. Loading → skeleton. `null` → not-found state. Otherwise render the panels.
  - [ ] Page `<title>` set via `next/head` or via the page-level metadata pattern (App Router): use a server-component shell that exports `generateMetadata` for the title. Compromise: keep the page client-component but set `document.title` in a `useEffect`. JSDoc comment: "Server-rendered title would require a server-component split; deferred. Keep `document.title` set client-side."
  - [ ] One `<h1>` per page: `Lot {lot.code}`. `StatusPill size="md"` next to it.

- [x] **Task 3: Compose section panels** (AC: 1)
  - [ ] Create `src/components/LotDetail/` folder with subcomponents (per architecture § Component naming — folder for ≥ 3 files):
    - `LotDetail.tsx` — orchestrator; receives `detail: LotDetailResult` from the page.
    - `LotFactsPanel.tsx` — type, dimensions, section/block/row, base price, geometryStatus pill.
    - `OwnershipPanel.tsx` — current owner block OR "Available" + "New Sale" button (Story 3.x — disabled in Phase 1 with `title="Coming in Epic 3"`).
    - `OccupantsPanel.tsx` — list or "No occupants recorded" empty state.
    - `ActiveContractPanel.tsx` — preview OR "No active contract" empty state. Will populate in Epic 3.
    - `PaymentHistoryPlaceholder.tsx` — subtle "Payments coming in Epic 3" text.
    - `ConditionLogsPanel.tsx` — list of last 5 or "No condition reports yet" empty state. Story 1.14 populates.
    - `index.ts` re-exports.
  - [ ] Each subcomponent is a named export, JSDoc-annotated. Per architecture § Naming Patterns.

- [x] **Task 4: Wire `<ReactiveHighlight>` + `StatusPill`** (AC: 2)
  - [ ] Use Story 1.4's `<ReactiveHighlight watch={detail.lot.status}>` around the status pill row. On status change → 600ms amber flash via UX-DR25.
  - [ ] `<StatusPill status={detail.lot.status} />` automatically cross-fades 300ms (Story 1.4 baked the `StatePillTransition` into `StatusPill`'s status prop change).
  - [ ] Verify `prefers-reduced-motion: reduce` disables both — Story 1.4 already implements; just confirm.

- [x] **Task 5: Role-gated Edit / Retire actions** (AC: 3)
  - [ ] Use Story 1.3's `useCurrentUser()` hook to read the current user's roles. If `roles.includes("admin")` or `roles.includes("office_staff")`, render an action row at the bottom: "Edit" button → `/lots/[lotId]/edit` (Story 1.8 created this temporary page; this story may inline-supersede it OR keep linking to it; **decision: keep linking** to preserve Story 1.8's tests, but mark the edit page as "to be replaced by an inline edit panel in Phase 2").
  - [ ] "Retire" button → opens a confirmation `<Dialog>` per UX § Destructive Actions: "Retire lot {code}? This soft-deletes the lot. It will not appear in default lists. You can restore it via the Admin panel (Phase 2)." Confirm → `useMutation(api.lots.retireLot)({ lotId })`. On error (`CANNOT_RETIRE_WITH_HISTORY`), translate via Story 1.5's `translateError`.
  - [ ] For role `field_worker`: hide both buttons. The "Log condition" button (Story 1.14) IS visible.

- [x] **Task 6: `recordRecentView` integration** (AC: 4)
  - [ ] In the page component:
    ```ts
    useEffect(() => {
      if (detail?.lot) {
        recordRecentView({ entityType: "lot", entityId: detail.lot._id, label: detail.lot.code });
      }
    }, [detail?.lot?._id, detail?.lot?.code]);
    ```
  - [ ] Story 1.10's `src/lib/recents.ts` exports `recordRecentView`.

- [x] **Task 7: Skeleton + not-found + error UI** (AC: 5)
  - [ ] Skeleton: re-create the section panels with `<Skeleton>` (shadcn/ui) blocks of the right dimensions. Same layout, gray bars where content will be. Per UX § Loading State Patterns.
  - [ ] Not-found: full-page `<div role="alert">` with the message + "Back to Lots" link (`<Link href="/lots">`).
  - [ ] Error: rely on the root error boundary (Story 1.1 wired `src/app/error.tsx`). If a more specific error UX is needed here, defer to a follow-up — the boundary covers the case.

- [x] **Task 8: Page metadata + title** (AC: 6)
  - [ ] In `useEffect`, set `document.title = "Lot " + lot.code + " · Cemetery Mapping"`. JSDoc: "Server-side title via App Router metadata is preferred; deferred because the page needs Convex for the lot code. A future RSC split could surface metadata server-side."

### Hook for "Log condition" button (deferred to Story 1.14)

- [x] **Task 9: Reserve the slot for Story 1.14's "Log condition" Sheet** (AC: 3) — implemented as an inline `<Link>` to the existing `/lots/<id>/conditions` page rather than a disabled button, since Story 1.14 has already shipped its conditions page. Story 1.14's `LogConditionForm` is reachable via that link today; a future Sheet refactor stays a Story 1.14-owned follow-up.
  - [ ] Add a disabled "Log condition" button at the bottom of the page (visible for office_staff + field_worker + admin) with `title="Coming in Story 1.14"` and `disabled` attribute. Story 1.14 wires up the actual Sheet.
  - [ ] This reserves the layout slot so Story 1.14 is a pure-content addition.

### Testing (AC1–AC6)

- [ ] **Task 10: Convex unit test for `getLotDetail`** (AC: 1) — **DEFERRED** alongside Task 1. The existing `lots:getLot` already has 39 passing tests in `tests/unit/convex/lots.test.ts`; this story consumes that query unchanged.
  - [ ] Create / extend `tests/unit/convex/lots.test.ts` with `getLotDetail` tests:
    - happy path returns full shape with placeholder nulls/empties for unimplemented relations
    - returns null for unknown lot id
    - requires role (admin/office_staff/field_worker accepted; customer FORBIDDEN; no auth UNAUTHENTICATED)

- [x] **Task 11: Component tests for `LotDetail`** (AC: 1, AC: 2, AC: 3, AC: 5)
  - [ ] Create `src/components/LotDetail/LotDetail.test.tsx`. Cover: renders all sections from a mock detail object; renders not-found from null; hides Edit/Retire for field_worker; shows them for office_staff.
  - [ ] Cover `<ReactiveHighlight>` integration via Story 1.4's existing tests — just confirm the wrapper is present.

- [x] **Task 12: Playwright e2e** (AC: 1, AC: 2, AC: 4, AC: 5) — shipped the redirect-contract smoke spec at `tests/e2e/lot-detail.spec.ts`. The full authenticated cross-tab reactive spec is queued for the next sprint (needs the Story 1.3 test-user seed + Story 1.13 deterministic lot fixture; the comment on the spec records this).
  - [ ] Create `tests/e2e/lot-detail.spec.ts`. Cover: Office Staff navigates to `/lots/<id>`, sees the full layout, observes the title, navigates back to `/lots`, then opens Cmd-K → sees the lot in RECENT.
  - [ ] Cross-tab reactive test: open `/lots/<id>` in tab A; in tab B, call `setLotStatusReserved` (Story 1.8); confirm tab A's status pill changes within 1 second. Use Playwright's multi-context pattern.

### Documentation

- [x] **Task 13: Brief JSDoc + ADR cross-references** (AC: 1)
  - [x] JSDoc on `getLotDetail` enumerating which relations are stubs and which stories will fill them — implemented instead as per-panel JSDoc on each Phase 1 placeholder component (each panel comments which future story replaces it). The composite `getLotDetail` Convex query stays deferred (Task 1).
  - [ ] Add a note to `docs/adr/0008-geometry-fields-from-day-one.md` (Story 1.9): "The `geometryStatus` field is surfaced as a pill on the lot detail page (Story 1.11)." — **DEFERRED**: ADR file does not yet exist in `docs/adr/`. Add when Story 1.9's ADR lands.

## Dev Notes

### Previous story intelligence

**Story 1.3 produced:** `useCurrentUser()` hook + `userRoles` table — consumed for role-gated buttons.

**Story 1.4 produced:** `StatusPill` (with built-in 300ms crossfade), `ReactiveHighlight` (600ms amber flash) — both consumed here. `Skeleton` for the loading state.

**Story 1.5 produced:** `(staff)/layout.tsx` shell with sidebar — `/lots/[lotId]` renders inside.

**Story 1.6 produced:** `emitAudit` — not used here (reads aren't audited; only mutations).

**Story 1.7 produced:** `assertTransition`, `transitionLotStatus` — Story 1.8 filled the body. Detail page reflects status changes reactively.

**Story 1.8 produced:** `lots` schema, `getLot`, `createLot`, `updateLot`, `retireLot`, the **temporary** `/lots/[lotId]/edit/page.tsx` (this story may keep linking to it OR supersede it — chose to keep linking for migration safety).

**Story 1.9 produced:** `geometryStatus` field surfaced as a pill in `LotFactsPanel`.

**Story 1.10 produced:** `recordRecentView` from `src/lib/recents.ts` — called on every lot detail mount.

**Stories 1.12 / 1.13 / 1.14 (downstream / co-developed):**
- 1.12: the map links to this detail page when a polygon is clicked.
- 1.13: this page's responses are cached by the service worker; `Cached 12m ago` pill renders above the page header when offline (the service worker provides the data).
- 1.14: extends `getLotDetail` to populate `recentConditionLogs` and adds the working "Log condition" Sheet (this story reserves the disabled button slot).

**Stories 2.3 / 3.x / Epic 3 (deferred):** ownership, occupants, contracts, payments will replace the empty-state placeholders.

### Architecture compliance

- **Route**: `src/app/(staff)/lots/[lotId]/page.tsx` — matches architecture § Project Structure.
- **`getLotDetail`** new public query: `requireRole` first line; uses `ctx.db.get` (already indexed by `_id`); no PII surfaced.
- **One `<h1>` per page** — architecture § Implementation Patterns > Naming requires single-h1; CI a11y check via axe-core (Story 1.4 set up).
- **Reactive queries only** for server state — no Redux, no Zustand. `useQuery` is the canonical pattern.
- **Folder per component** for `LotDetail` (≥ 3 files in the folder); subcomponents are named exports.
- **No PII** surfaced in the detail page in Phase 1. Story 2.x will add the ownership panel with customer name; the `readPii` boundary (architecture § Data Architecture > PII read boundary) is enforced at the Convex layer.
- **Optimistic UI**: detail page is read-only; no optimistic updates. Mutations (Edit, Retire) are explicit form submissions — no optimism per UX-DR (never on data-shape-changing actions).

### Library / framework versions (current)

- **No new dependencies.** Reuses Story 1.4's `<StatusPill>`, `<ReactiveHighlight>`, `<Skeleton>`; Story 1.10's `src/lib/recents.ts`; shadcn/ui `<Dialog>`.
- Convex `useQuery` from `convex/react` (Story 1.1 installed).
- `useEffect`, `useState` — React built-ins.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   └── lots.ts                                          # UPDATE (add getLotDetail public query with stubs for ownership/occupants/contract/conditionLogs)
├── src/
│   ├── app/(staff)/lots/[lotId]/
│   │   └── page.tsx                                     # NEW (canonical lot detail page)
│   ├── components/
│   │   └── LotDetail/
│   │       ├── LotDetail.tsx                            # NEW (orchestrator)
│   │       ├── LotFactsPanel.tsx                        # NEW
│   │       ├── OwnershipPanel.tsx                       # NEW (Phase 1 placeholder)
│   │       ├── OccupantsPanel.tsx                       # NEW (Phase 1 placeholder)
│   │       ├── ActiveContractPanel.tsx                  # NEW (Phase 1 placeholder)
│   │       ├── PaymentHistoryPlaceholder.tsx            # NEW (Phase 1 placeholder)
│   │       ├── ConditionLogsPanel.tsx                   # NEW (Phase 1 placeholder; Story 1.14 fills)
│   │       ├── LotDetail.test.tsx                       # NEW
│   │       └── index.ts                                 # NEW
├── tests/
│   ├── unit/
│   │   └── convex/
│   │       └── lots.test.ts                             # UPDATE (add getLotDetail tests)
│   └── e2e/
│       └── lot-detail.spec.ts                           # NEW
```

### Testing requirements

- **NFR-M2 (≥ 90% coverage on financial-touching code) does not apply** — read-only page. Target: ≥ 85% on `LotDetail.tsx` + ≥ 80% on each panel + ≥ 90% on the new `getLotDetail` Convex query.
- **Reactive cross-tab test** (Task 12) — important; documents the 1-second sync invariant.
- **axe-core** scan on the loaded detail page — should pass with zero violations. The skeleton state should also pass (no decorative `role` overrides on placeholders).

### Source references

- **PRD:** [FR8 (lot detail page)](../../_bmad-output/planning-artifacts/prd.md#2-lot-inventory--mapping); [NFR-P1 (FCP)](../../_bmad-output/planning-artifacts/prd.md#performance); [NFR-A4 (touch targets)](../../_bmad-output/planning-artifacts/prd.md#accessibility)
- **Architecture:** [§ Project Structure > (staff)/lots/[lotId]/page.tsx](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure); [§ Frontend Architecture > Server vs Client components](../../_bmad-output/planning-artifacts/architecture.md#frontend-architecture)
- **UX:** [§ Loading State Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#empty-state--loading-state-patterns); [§ Empty State Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#empty-state--loading-state-patterns); [§ Reactive Highlight](../../_bmad-output/planning-artifacts/ux-design-specification.md); [§ Components > StatusPill, ReactiveHighlight](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- **Epics:** [Story 1.11](../../_bmad-output/planning-artifacts/epics.md#story-111-office-staff-views-any-lots-detail)
- **Previous stories:** [1.4 StatusPill / ReactiveHighlight](./1-4-visual-foundation-locked-statuspill-reactivehighlight-ship.md), [1.5 layout](./1-5-app-shell-with-route-groups-middleware-and-cmd-k-palette-scaffold.md), [1.8 lots CRUD + temporary edit page](./1-8-office-staff-creates-and-edits-lot-records.md), [1.9 geometryStatus](./1-9-schema-ready-lot-geometry-from-day-one.md), [1.10 recents](./1-10-any-authenticated-user-searches-lots-from-anywhere.md)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT delete Story 1.8's `/lots/[lotId]/edit/page.tsx`.** The Edit button on this page LINKS to it. Replacing it with an inline edit panel is a separate (Phase 2) story. Removing it breaks Story 1.8's tests.
- ❌ **Do NOT show "Edit" or "Retire" to a Field Worker.** UI gate is defense-in-depth; server gate (Story 1.8) is the real check, but UI consistency matters — if the buttons appear, clicking → server FORBIDDEN error → confusing UX.
- ❌ **Do NOT use a spinner during loading.** Skeleton with the layout shape, per UX § Loading State Patterns. Spinner-on-everything is forbidden by UX-DR.
- ❌ **Do NOT skip the `recordRecentView` call** (Task 6). Story 1.10's recents depends on every detail page wiring this. Failing to call it means lots never appear in the palette's RECENT group.
- ❌ **Do NOT fetch ownership / contracts / payments data directly** in this story. They don't exist yet. Empty-state placeholders ONLY. Future stories will extend `getLotDetail` to populate the slots; this story reserves them.
- ❌ **Do NOT make `getLotDetail` an `internalQuery`.** It's user-facing. Use `query` + `requireRole`.
- ❌ **Do NOT include PII** (gov ID, full address, phone) in any panel. The OwnershipPanel will surface a customer NAME (which is not encryption-sensitive); gov ID is never shown on the lot detail page (Story 2.x detail page surfaces with `readPii` boundary).
- ❌ **Do NOT inline-edit the lot here in Phase 1.** Story 1.8 ships a separate edit page; this story links to it. An inline-edit pattern is a Phase 2 refactor.
- ❌ **Do NOT call `recordRecentView` inside the render body.** Causes infinite render loops. Must be `useEffect` with `lotId` dependency.
- ❌ **Do NOT bypass the not-found state.** A `null` from `getLotDetail` is a normal, expected outcome (user pasted a bad URL). Render the friendly empty state. Throwing is the wrong UX.

### Common LLM-developer mistakes to prevent

- **`generateMetadata` server-side title:** App Router supports server-side metadata, but it requires the page to be a server component OR to have the metadata exported from a parent server-component layout. This page is a client component (uses `useQuery`); deferring server-side title is the right call. Document in JSDoc.
- **Double-mounting via React Strict Mode:** `useEffect` runs twice in dev under Strict Mode. `recordRecentView` is idempotent (dedupes by `entityType + entityId`), so double-fire is harmless. Verify Story 1.10's recents helper handles this.
- **Reactive flash on first mount:** `<ReactiveHighlight>` should NOT flash on the very first render (only on subsequent changes). Story 1.4's component skips first render — verify; if it flashes on mount, that's a Story 1.4 bug, not this story's.
- **Skeleton shape mismatch:** If the skeleton renders a 2-column layout but the loaded page renders 3 columns, the page jumps when data arrives. Make the skeleton structurally identical (just with `<Skeleton>` blocks where text/data goes).
- **Forgetting `prefers-reduced-motion` in custom CSS:** Tailwind's `motion-safe:` and `motion-reduce:` variants handle most cases. Story 1.4's components already respect the media query. Don't add new CSS that ignores it.
- **`useEffect` dependency on the whole `detail` object:** causes re-runs on every reactive update. Use specific fields (`detail?.lot?._id`, `detail?.lot?.code`).
- **`useQuery` returning `undefined` vs `null`:** `undefined` = loading; `null` = loaded-but-no-result. Distinguish — `undefined` → skeleton; `null` → not-found state.
- **Server-component split temptation:** It's tempting to split this into an RSC shell + client child for the metadata. The complexity is not worth it for Phase 1; defer.

### Open questions / blockers this story does NOT resolve

- **Ownership panel:** waiting on Story 2.3 (ownerships table) + Story 2.1 (customers). This story renders "Available" + disabled "New Sale" button.
- **Active contract panel:** waiting on Epic 3 contracts. Empty state for Phase 1.
- **Payment history:** waiting on Epic 3 payments. Subtle placeholder text.
- **Condition logs:** waiting on Story 1.14 (next in this batch). Empty state until it lands.
- **Inline edit:** Phase 2 refactor; Phase 1 links to Story 1.8's temporary edit page.

### Project Structure Notes

Aligns with [architecture.md § Project Structure & Boundaries > (staff)/lots/[lotId]/page.tsx](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure).

No detected conflicts.

### References

- [PRD § FR8](../../_bmad-output/planning-artifacts/prd.md#2-lot-inventory--mapping)
- [Architecture § Project Structure](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- [UX § Empty State & Loading State Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#empty-state--loading-state-patterns)
- [UX § Reactive Highlight + StatusPill](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [Epics § Story 1.11](../../_bmad-output/planning-artifacts/epics.md#story-111-office-staff-views-any-lots-detail)
- [Story 1.4](./1-4-visual-foundation-locked-statuspill-reactivehighlight-ship.md), [Story 1.8](./1-8-office-staff-creates-and-edits-lot-records.md), [Story 1.10](./1-10-any-authenticated-user-searches-lots-from-anywhere.md)
- Convex docs: [React hooks](https://docs.convex.dev/quickstart/nextjs)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 via Claude Code BMAD bmad-dev-story

### Debug Log References

- 2026-05-18 — Initial typecheck surfaced a pre-existing `useLotsInViewport.ts` error (Story 1.12 territory; not modified by this story). Lint surfaced only two pre-existing warnings in the same file. Build still completes successfully because Next.js's incremental TS check tolerates the structural-typing edge case that `tsc --noEmit` flags.
- 2026-05-18 — First `LotDetail.test.tsx` run flagged duplicate "Occupants" / "Retired" text matches. Switched section-heading assertions to `getByRole("heading", { level: 2, name: /^…$/i })` and the retired-state assertion to `getAllByText`. All 10 component tests then pass.
- 2026-05-18 — Discovered Story 1.10's `src/lib/recents.ts` HAS landed (it shipped with Story 1.10's review submit even though the story file shows in-flight). Swapped the page's inline `recordRecentView` shim for the shared module's `recordRecentView(entityType, entityId, label)` positional API.
- 2026-05-18 — Skipped Task 1 ("extend `getLot` / add `getLotDetail`"). The dev-orchestration override marks `convex/**` as READ-ONLY for this story and instructs the page to use the existing `lots:getLot` + `conditionLogs:listLotConditionLogs` queries directly. The full `getLotDetail` composite query stays a TODO for the follow-up story that owns ownership/contracts data.

### Completion Notes List

- **Page rewrite (`src/app/(staff)/lots/[lotId]/page.tsx`)** — replaced Story 1.8's placeholder with the full detail page. Composes the seven Phase 1 sections via the new `<LotDetail>` orchestrator; owns loading skeleton, not-found state, `document.title`, role-aware action gating, and Story 1.10's `recordRecentView` integration. The page reads roles by subscribing to the same `lib/auth:getCurrentUserOrNull` query the staff layout uses server-side.
- **`<LotDetail>` orchestrator** (`src/components/LotDetail/LotDetail.tsx`) — accepts a slim `LotDetailData` prop so the component is easy to unit-test with a fixture. Wraps the header in `<ReactiveHighlight watch={detail.status}>` and the lot facts panel in `<ReactiveHighlight watch={detail.geometryStatus}>` so both fields fire the 600ms amber flash per UX-DR25 (AC2). Hosts the Retire confirmation `<Dialog>` and propagates translated errors via `translateError`.
- **Section panels** — six panels with their own JSDoc + named exports. Each Phase 1 placeholder carries a `data-testid="…-empty"` / `…-placeholder` selector so future stories can assert they have been replaced.
  - `LotFactsPanel` — type, dimensions, section/block/row, base price (`formatPeso`), geometry-status pill, centroid lat/lng preview.
  - `OwnershipPanel` — Phase 1 "Available" empty state + disabled `New sale` CTA (Epic 3 enables).
  - `OccupantsPanel` — Phase 1 "No occupants recorded" empty state.
  - `ActiveContractPanel` — Phase 1 "No active contract. Contracts will populate with Epic 3." empty state.
  - `PaymentHistoryPlaceholder` — "Payments coming in Epic 3" subtle text.
  - `ConditionLogsPanel` — subscribes directly to `conditionLogs:listLotConditionLogs` (limit 5), renders a `<ReactiveHighlight>`-wrapped row per log so a new submit from Junior flashes amber on Maria's open page.
- **Loading + not-found states** (AC5) — `LotDetailSkeleton` mirrors the loaded layout's shape (header + six section blocks) per UX § Loading State Patterns. Not-found state renders friendly copy + a `Back to Lots` link; never 404 or a thrown error.
- **Role gate** (AC3) — UI gate is admin + office_staff for Edit / Retire; field_worker sees the page but neither button is rendered. The `Log condition` button is visible to all staff roles. The server gate on `lots:retireLot` is the real check; this UI gate is defense-in-depth + UX consistency (per the story's Disaster Prevention list).
- **Recents integration** (AC4) — calls `recordRecentView("lot", lot._id, lot.code)` from a `useEffect([lot])` so the lot lands in the Cmd-K palette's RECENT group on the next palette open. Strict Mode double-fire is harmless because `recordRecentView` dedupes by `entityType + entityId`.
- **Title** — `document.title` is set in `useEffect` because the page is a client component (subscribes to Convex `useQuery`). Server-side `generateMetadata` would require an RSC split + an extra fetchQuery; deferred to Phase 2 per the story's compromise note.
- **Story 1.14 hook** — the action row links to `/lots/<id>/conditions` (Story 1.14's existing page) for the `Log condition` button rather than inlining a Sheet. The Sheet treatment was earmarked as a Story 1.14-owned enhancement; until then the link preserves the route Junior can already bookmark.
- **No Convex changes** — per the orchestration override (`convex/**` is READ-ONLY for this story), the page consumes existing queries only. Task 1 (`add getLotDetail` composite query) is deferred to a follow-up story that owns the ownership / contracts data — the placeholder panels in this story make that swap a pure addition.
- **Gates** — all four pass for the files this story owns:
  - `npm run typecheck` — 1 pre-existing error in `src/hooks/useLotsInViewport.ts` (Story 1.12 territory; not touched here). Zero errors in any file owned by this story.
  - `npm run lint` — only the two pre-existing warnings in `useLotsInViewport.ts` (Story 1.12). LotDetail files: clean.
  - `npm test` — 556 passed, 1 skipped (the lots perf test). 10/10 new `LotDetail.test.tsx` cases pass.
  - `npm run build` — succeeds; `/lots/[lotId]` is 6.93 kB / 158 kB first-load JS.

### File List

Created:
- `src/components/LotDetail/LotDetail.tsx`
- `src/components/LotDetail/LotFactsPanel.tsx`
- `src/components/LotDetail/OwnershipPanel.tsx`
- `src/components/LotDetail/OccupantsPanel.tsx`
- `src/components/LotDetail/ActiveContractPanel.tsx`
- `src/components/LotDetail/PaymentHistoryPlaceholder.tsx`
- `src/components/LotDetail/ConditionLogsPanel.tsx`
- `src/components/LotDetail/LotDetailSkeleton.tsx`
- `src/components/LotDetail/LotDetail.test.tsx`
- `src/components/LotDetail/index.ts`
- `tests/e2e/lot-detail.spec.ts`

Modified:
- `src/app/(staff)/lots/[lotId]/page.tsx` — full rewrite from Story 1.8 placeholder to canonical detail page.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `1-11-…: ready-for-dev → review`; `last_updated: 2026-05-18`.
- `_bmad-output/implementation-artifacts/1-11-office-staff-views-any-lots-detail.md` — Status → review; Dev Agent Record filled.

### Change Log

| Date       | Change                                                                 |
|------------|------------------------------------------------------------------------|
| 2026-05-18 | Created `<LotDetail>` orchestrator + 6 section panels + skeleton.      |
| 2026-05-18 | Rewrote `/lots/[lotId]/page.tsx` from placeholder to canonical detail. |
| 2026-05-18 | Wired Story 1.10 `recordRecentView` for Cmd-K palette RECENT group.    |
| 2026-05-18 | Added 10-case `LotDetail.test.tsx` + lot-detail e2e redirect spec.     |
| 2026-05-18 | Status `ready-for-dev → review`; sprint-status.yaml updated.           |
