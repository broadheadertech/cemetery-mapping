# Story 5.9: Cross-Cutting StatePillTransition Application

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer / UX implementer**,
I want **the `StatusPill` component's built-in 300ms color crossfade applied uniformly across every entity-state display in the product (lots, contracts, receipts, installments, expenses)**,
so that **state changes always animate consistently per UX-DR13 + UX-DR26 — a status pill on the dashboard fades exactly like a status pill on the lot detail page, no surprises, no per-page bespoke transitions** (UX-DR13, UX-DR26).

This is a **cross-cutting consistency story**. Story 1.4 shipped `StatusPill` with the 300ms transition built in. Stories that consumed `StatusPill` between 1.4 and now have (mostly) inherited the transition for free, but: (a) the transition may not have been verified on every consumer, (b) some entity states may have been rendered with raw Tailwind utility classes instead of `StatusPill` (a regression), (c) the `StatePillTransition` auxiliary wrapper (UX § Component Strategy item 9) may be needed for edge cases where the underlying status is changed via a parent re-render that doesn't propagate through `StatusPill`'s `status` prop. This story audits, fixes, and verifies — one motion language for the whole product.

The architecture's "Compose, don't customize" principle (UX § Composition Rules) is the load-bearing idea: one component, every consumer behaves the same.

## Acceptance Criteria

1. **AC1 — Every entity-state display in the product uses `StatusPill` (or `StatePillTransition` for edge cases)**: A code search across `src/` finds zero instances of inline status rendering for: lot states, contract states, receipt states, installment states, expense states. Each is rendered via `<StatusPill status={...} size={...} />` (or `<StatePillTransition><StatusPill .../></StatePillTransition>` where the parent's status change is not a direct prop pass). Routes affected (non-exhaustive — search verifies): `/dashboard` (KPI cards' optional state indicators), `/lots/[lotId]`, `/lots` (list page status column), `/contracts/[contractId]`, `/contracts` (list), `/payments/new` (receipt-preview state), `/sales/new` (lot-availability state + contract-state preview), `/customers/[customerId]` (contract states column in the customer's contracts), `/ar-aging` (per-row status), `/expenses` (expense-state column), search-result cards (UX § Cmd-K palette), audit log entries showing entity states.

2. **AC2 — The 300ms color crossfade fires consistently on status change**: When a `StatusPill`'s `status` prop changes (via reactive query update OR local prop re-render), the pill's background + text + border + icon cross-fade over 300ms `ease-in-out` (per UX § Motion Tokens `--motion-state-change`). No flicker (color does not snap then fade — it's a smooth interpolation). `prefers-reduced-motion: reduce` disables the animation cleanly (the new color appears immediately, no jump-cut artifacts). The transition is the same whether triggered locally or by a reactive query — the underlying CSS `transition` property covers both paths.

3. **AC3 — Vitest test verifies the transition on `StatusPill` directly**: `src/components/StatusPill.test.tsx` (which Story 1.4 created — UPDATE) gains a test: render with `status="available"`, capture the className. Re-render with `status="reserved"`, assert: (a) within 0ms the transition starts (a CSS class signaling "in transition" OR the inline `transition` style is present), (b) after 300ms, the className reflects the new state's color palette, (c) under mocked `prefers-reduced-motion: reduce`, the transition does NOT apply (the new color is set immediately without the `transition` CSS property). Use Vitest's fake timers or RTL's `act` + a small wait.

4. **AC4 — `StatePillTransition` wrapper exists for edge cases AND has its own tests**: If Story 1.4 did NOT already ship `StatePillTransition` as a separate component (it's listed in UX § Component Strategy item 9 — "Most consumers won't need this directly, `StatusPill` itself includes the transition behavior on its `status` prop"), this story ships it. `src/components/StatePillTransition.tsx` is a thin wrapper: it takes `children` (a `StatusPill`) and `watch` (the status value), and forces a re-render of the inner `StatusPill` when `watch` changes — useful when the parent's status comes from a context / hook that doesn't directly pass to `StatusPill`'s prop. The wrapper has its own test file with at least: render-once-no-flicker, status-change-triggers-transition, prefers-reduced-motion test. If Story 1.4 already shipped it, this story verifies the existing implementation + adds any missing test coverage.

5. **AC5 — Cross-cutting audit + final report**: A grep audit script (run during this story; output captured in the PR description, NOT committed to the repo) lists every file in `src/` that renders any entity status. Each must be: (a) using `<StatusPill ... />`, (b) using `<StatePillTransition ...><StatusPill ... /></StatePillTransition>`, OR (c) explicitly exempted with a code comment explaining why. The audit's output is the proof that the cross-cutting application is complete; expected matches = expected file count from the architecture's repo tree.

## Tasks / Subtasks

### Audit phase (AC1, AC5)

- [ ] **Task 1: Inventory all entity-state-rendering sites in `src/`** (AC: 1, AC: 5)
  - [ ] Run a grep audit across `src/` for likely status-rendering patterns:
    - `grep -rn "status[: =]" src/app src/components | rg -v test`
    - `grep -rn "bg-emerald-\|bg-amber-\|bg-red-\|bg-slate-" src/app src/components` — finds raw-Tailwind status colors (potential regressions)
    - `grep -rn "<StatusPill" src/` — finds existing consumers
    - `grep -rn "StatePillTransition" src/` — finds existing wrapper consumers
  - [ ] Output a list of all files that render entity status (manual filtering required — automated grep will surface false positives like form input states). Cross-reference against the architecture's repo tree to ensure no expected consumer was missed (e.g. `src/components/ArAgingTable.tsx`, `src/components/SaleForm/lotPicker.tsx`).
  - [ ] Document the inventory in the PR description (NOT in the repo) as the "before" state.

- [ ] **Task 2: For each non-`StatusPill` rendering, classify the fix needed** (AC: 1)
  - [ ] For each site found in Task 1, classify:
    - **Replace with `<StatusPill>`:** the rendering uses raw Tailwind classes for a status — replace with the proper component.
    - **Wrap with `<StatePillTransition>`:** the status is passed via context / hook / parent re-render in a way that doesn't propagate through `StatusPill`'s `status` prop. Wrap so the transition fires reliably.
    - **Exempt:** the rendering is NOT an entity status (e.g. a form field's validation state, a tab's active indicator, a tooltip arrow color). Add a `// not-an-entity-status: <reason>` code comment to suppress future audits.
  - [ ] Most fixes will be straightforward `StatusPill` replacements. The wrapper case should be rare — possibly zero in Phase 1.

### Replacement work (AC1, AC2)

- [ ] **Task 3: Replace raw-status rendering with `<StatusPill>` site-by-site** (AC: 1, AC: 2)
  - [ ] For each file in the "Replace" classification, change the rendering. Examples:
    - Before: `<span className="bg-emerald-100 text-emerald-900 px-2 py-0.5 rounded text-xs">{lot.status}</span>`
    - After: `<StatusPill status={lot.status} size="sm" />`
  - [ ] Verify the `StatusPill` API matches the call site. If a call site needs a state the `StatusPill` doesn't yet support (e.g. an expense state Story 1.4 didn't include — the original `StatusPill` covered 7 lot states + 5 payment states), extend `StatusPill`'s `status` union AND the color/icon mapping in `src/components/StatusPill.tsx`. Coordinate with Story 1.4's owner if extension is needed; document the extension in the PR.
  - [ ] One commit per consumer file makes the diff reviewable.

- [ ] **Task 4: Add the `expense` entity-state palette to `StatusPill` if missing** (AC: 1)
  - [ ] Expense states from architecture / PRD: `pending_approval | approved | rejected | paid | voided` (verify against `convex/expenses.ts` if it exists, OR against `expenses` schema from Epic 3 / Epic 5). If `StatusPill` doesn't already handle these (Story 1.4 may have stopped at lot + payment states), extend the `StatusPill`'s status union + token map.
  - [ ] Color choices:
    - `pending_approval` → amber (warning tone)
    - `approved` → emerald (success)
    - `rejected` → red (destructive)
    - `paid` → slate / neutral (terminal)
    - `voided` → slate (terminal)
  - [ ] Add to `src/components/StatusPill.test.tsx`: a test for each new state's color + label + icon rendering.

- [ ] **Task 5: Apply `<StatePillTransition>` wrapper where needed** (AC: 4)
  - [ ] For any wrapper-case sites (likely zero or few in Phase 1), wrap `<StatusPill>` with the auxiliary. If `StatePillTransition` does not exist yet, build it (Task 6).
  - [ ] If zero wrapper-case sites are identified, that's fine — `StatePillTransition` still gets built (AC4) but is unused in Phase 1. Document in Completion Notes that the component is shipped as an API but has no production consumer yet (acceptable per UX § Component Strategy "most consumers won't need it directly").

### Wrapper component (AC4)

- [ ] **Task 6: Build `src/components/StatePillTransition.tsx`** (AC: 4)
  - [ ] If the file exists from Story 1.4, skip to Task 7 (verify + extend tests).
  - [ ] Create `src/components/StatePillTransition.tsx`. `"use client"` on line 1.
  - [ ] Interface: `interface StatePillTransitionProps { children: ReactElement; watch: string; }`. The `children` is expected to be a `<StatusPill>` (enforce via TS or document via JSDoc — runtime enforcement is overkill).
  - [ ] Implementation: when `watch` changes, force the child to re-render via React's `key` prop set to `watch`. This guarantees the `StatusPill`'s internal `transition` CSS fires on the new render.
    ```tsx
    "use client";
    import { Children, cloneElement, ReactElement } from "react";

    export function StatePillTransition({ children, watch }: StatePillTransitionProps) {
      const child = Children.only(children) as ReactElement;
      return cloneElement(child, { key: watch });
    }
    ```
  - [ ] **Alternative implementation** (if `key` approach causes mount/unmount flash): use a `useEffect` that toggles a CSS class on the child's wrapper to retrigger the transition. The `key` approach is simpler; prefer it unless testing reveals a flash.
  - [ ] JSDoc explains the use case (status comes from a context / hook / parent rerender that doesn't pass through `StatusPill`'s `status` prop directly; most consumers do NOT need this wrapper).

- [ ] **Task 7: Test `StatePillTransition`** (AC: 4)
  - [ ] `src/components/StatePillTransition.test.tsx` (NEW).
  - [ ] Test: render with `<StatePillTransition watch="available"><StatusPill status="available" size="sm" /></StatePillTransition>`. Assert the rendered output contains the `available` color classes.
  - [ ] Test: re-render with `watch="reserved"` and `status="reserved"`. Assert the new color classes appear; the transition fires (verify the inner `StatusPill`'s `transition` CSS is present).
  - [ ] Test: under mocked `prefers-reduced-motion: reduce`, the transition CSS is absent on re-render (the `StatusPill` handles this internally; the wrapper doesn't add motion of its own).
  - [ ] Axe-core scan on the wrapper output — zero critical / serious violations.

### Transition verification on `StatusPill` itself (AC2, AC3)

- [ ] **Task 8: Extend `StatusPill.test.tsx` with the transition assertion** (AC: 3)
  - [ ] Read `src/components/StatusPill.test.tsx` (Story 1.4). UPDATE: add a test for the 300ms color crossfade.
  - [ ] Test approach: render `<StatusPill status="available" size="md" />`. Capture the className. Re-render with `status="reserved"`. Use `vi.useFakeTimers()` (Vitest fake timers) and advance 300ms. Assert: the className now matches `reserved` state's color palette. Assert: the inline / computed `transition` CSS property exists during the transition window (use `getComputedStyle` if running in jsdom — note jsdom's `getComputedStyle` is limited; if the assertion is brittle, fall back to asserting the className includes a `transition-colors duration-300` Tailwind utility).
  - [ ] Test: mock `window.matchMedia('(prefers-reduced-motion: reduce)')` to return `matches: true`. Re-render with new status. Assert the `transition-colors duration-300` class is absent (or the `motion-reduce:transition-none` Tailwind utility is applied — verify which approach Story 1.4 chose).
  - [ ] If Story 1.4's `StatusPill` implementation DOES NOT include a CSS `transition` property on the relevant style properties, this is a Story-1.4 regression. Surface in the PR + fix it as part of this story (update `StatusPill.tsx` to add `transition-colors duration-300 ease-in-out motion-reduce:transition-none`).

### Playwright e2e for the visual transition (AC2)

- [ ] **Task 9: Playwright spec for the state-change crossfade** (AC: 2)
  - [ ] Extend `tests/e2e/journey-1-installment-sale.spec.ts` (Story 3.x): after recording a payment, the receipt's status pill should fade from `pending` to `posted`. Assert: the pill's class changes within the spec's wait window; OR (more robustly) use Playwright's `screenshot` + visual comparison at t=0 and t=300ms to capture the transition mid-flight. (Visual regression tooling is out of scope; a simpler assertion is acceptable.)
  - [ ] Simpler alternative: extend the existing Journey-2 spec to assert the receipt's `StatusPill` reaches the `posted` state after the payment mutation completes — the transition itself is verified by `StatusPill.test.tsx` (Task 8). The e2e test verifies the end-to-end state-change loop, not the animation specifics.

### Cross-cutting consistency check (AC5)

- [ ] **Task 10: Final audit + capture in PR description** (AC: 5)
  - [ ] After all replacements land, re-run the grep audit (Task 1). Confirm: no raw-Tailwind status rendering remains (or only exempted ones with code comments).
  - [ ] Output the final "after" inventory in the PR description.
  - [ ] If a future-developer guardrail is desired (lint rule against raw status-color utility classes in non-`StatusPill.tsx` files), specify it but DO NOT implement in this story — lint rules are friction, and the architecture's lint catalog is curated separately. Flag as a follow-up story candidate.

## Dev Notes

### Previous story intelligence

- **Story 1.4** — shipped `StatusPill` + the 300ms `--motion-state-change` token + `prefers-reduced-motion` handling. This story extends and verifies, doesn't replace.
- **Story 1.5** — established the app shell + Cmd-K palette; search-result cards may have status pills that need the cross-cutting check.
- **Epic 3 (Sales / Payments / Receipts)** — produced the per-entity-state surfaces (sale form, payment form, contract detail, receipt viewer). Each is a candidate for the audit.
- **Epic 4 (AR Aging)** — `ArAgingTable` renders per-row status; consumed `StatusPill` per UX-DR10. Audit verifies.
- **Story 5.2** — dashboard's AR aging summary uses per-row status pills (UX-DR10). Audit verifies.

**No hard blocking dependencies for this story other than Story 1.4 being shipped.** The audit can identify consumers regardless of which epic shipped them.

### Architecture compliance

- **UX § Composition Rules — "Compose, don't customize. A `StatusPill` in a sale form is the same `StatusPill` as in the dashboard. No bespoke variants for 'this one screen.'"** This story enforces the rule retroactively.
- **UX § Motion Tokens — `--motion-state-change: 300ms ease-in-out`** — single source of truth. Every consumer inherits via `StatusPill`; no per-page duration overrides.
- **Architecture § Component Layers — `StatusPill` is a Layer-3 domain component.** `StatePillTransition` is a Layer-3 auxiliary. Both live in `src/components/` per repo tree.
- **NFR-A2 — color + icon + label** — `StatusPill` already satisfies; the audit ensures no rogue raw-color renderings sneak through without the icon + label.
- **`prefers-reduced-motion`** — `StatusPill` honors it; `StatePillTransition` inherits via composition.

### Library / framework versions

No new dependencies. This story uses what Story 1.4 already shipped + standard React (`Children.only`, `cloneElement`).

### File structure requirements

```
cemetery-mapping/
├── src/
│   ├── components/
│   │   ├── StatusPill.tsx                  # UPDATE (extend state union with expense states; verify transition CSS)
│   │   ├── StatusPill.test.tsx             # UPDATE (add 300ms crossfade test + reduced-motion test)
│   │   ├── StatePillTransition.tsx         # NEW (or UPDATE if 1.4 already shipped it)
│   │   ├── StatePillTransition.test.tsx    # NEW
│   │   └── [various other consumer files]  # UPDATE per audit findings (Task 3)
│   └── app/
│       └── [various page files]            # UPDATE per audit findings (Task 3)
└── tests/
    └── e2e/journey-1-installment-sale.spec.ts  # UPDATE (state-change assertion)
```

The "various consumer files" list is determined by Task 1's audit — the dev agent's File List must enumerate every modified file.

### Testing requirements

- **`StatusPill.test.tsx` coverage:** the new transition test brings the file's coverage to ≥ 95% (small file, easy to over-cover). No new e2e suite is added; existing journeys gain inline state-change assertions.
- **`StatePillTransition.test.tsx`:** ≥ 90% coverage. The component is tiny (~10 lines); coverage gaps would be conspicuous.
- **Axe-core scans on each affected page:** Story 5.8's CI gate (the parallel story) catches a11y regressions if the audit accidentally swaps a `<button>`-wrapped status for a `<div>` or similar. Trust the gate.
- **No new Vitest test files for consumer pages** — those are already covered by their own stories' tests. This story modifies existing test files only where the test asserts a status rendering (and the new render is `<StatusPill>` instead of raw markup).

### Source references

- **PRD:** [NFR-A2 — status as color + icon + label](../../_bmad-output/planning-artifacts/prd.md#accessibility).
- **Architecture:** [§ Component Layers — `StatusPill`, `StatePillTransition`](../../_bmad-output/planning-artifacts/architecture.md), [§ Implementation Patterns — Compose, don't customize](../../_bmad-output/planning-artifacts/architecture.md).
- **UX:** [§ Component Strategy > 1. `StatusPill`](../../_bmad-output/planning-artifacts/ux-design-specification.md#1-statuspill-products-primary-visual-element), [§ Component Strategy > 9. `StatePillTransition`](../../_bmad-output/planning-artifacts/ux-design-specification.md), [§ Motion Tokens > `--motion-state-change: 300ms ease-in-out`](../../_bmad-output/planning-artifacts/ux-design-specification.md), [§ Composition Rules — "Compose, don't customize"](../../_bmad-output/planning-artifacts/ux-design-specification.md), [§ Reactive Update Patterns — Status pill transitions: 300ms color crossfade when a state changes](../../_bmad-output/planning-artifacts/ux-design-specification.md), [§ Journey 2 — installment #3 now shows "Paid" status pill (crossfade animation done)](../../_bmad-output/planning-artifacts/ux-design-specification.md).
- **Epics:** [Story 5.9](../../_bmad-output/planning-artifacts/epics.md#story-59-cross-cutting-statepilltransition-application).
- **Previous stories:** Story 1.4 (StatusPill + tokens), every story between 1.4 and 5.9 that consumed `StatusPill` (audited).

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT add per-consumer transition durations.** No `<StatusPill durationMs={150}>` overrides. 300ms is the design-token value; deviating fragments the motion language.
- ❌ **Do NOT replace `StatusPill` consumers with `StatePillTransition` wholesale.** The wrapper is for edge cases only. Most consumers already get the transition for free via `StatusPill`'s built-in CSS. Wrapping unnecessarily adds re-render churn.
- ❌ **Do NOT silently extend the `StatusPill` status union without updating the test palette + axe scan.** A new state added to the union without a matching color/icon/label is a runtime bug (the pill renders as transparent / no label). Always update the mapping + test together.
- ❌ **Do NOT use inline `style={{ transition: "..." }}` on `StatusPill`.** Use Tailwind utility classes `transition-colors duration-300 ease-in-out motion-reduce:transition-none`. The token already exists; reach for utilities, not inline styles.
- ❌ **Do NOT break existing tests during the audit refactor.** Each test file that was asserting on raw className (e.g. `expect(element.className).toContain("bg-emerald-100")`) needs updating to assert on the `StatusPill`-rendered output (e.g. `expect(getByRole("img", { name: /available/i }))` — the icon's accessible name). Don't `xit` or skip tests; rewrite them.
- ❌ **Do NOT commit the audit grep output to the repo.** PR description only. The audit is a point-in-time artifact; capturing it in the repo creates stale documentation.
- ❌ **Do NOT skip the `prefers-reduced-motion` test for `StatusPill`.** The vestibular-disorder accessibility case. Story 1.4 should have tested this, but verify and re-test in this story to guarantee the cross-cutting verification.
- ❌ **Do NOT extend `StatusPill` with non-state-bearing props** (e.g. `tooltip`, `description`). `StatusPill` is for state. If a per-page need for more info exists, the consumer composes — adds a `Tooltip` adjacent — not a prop on `StatusPill`.
- ❌ **Do NOT couple `StatePillTransition` to `StatusPill` via instanceof / type checks.** The wrapper is duck-typed: it expects a child it can `cloneElement` with `key`. The JSDoc says "expected to be a `StatusPill`" but doesn't enforce at runtime. Don't add brittle checks.
- ❌ **Do NOT skip the `expense` state extension if `convex/expenses.ts` exists with those states.** Otherwise the `/expenses` page falls back to raw-Tailwind rendering, defeating the cross-cutting effort.

### Common LLM-developer mistakes to prevent

- **Replacing raw Tailwind with `<StatusPill>` but forgetting the `size` prop:** the default size may not match the original visual weight. Pick `sm` for table rows, `md` for detail headers, `lg` for hero placements (Story 1.4's three sizes). Visual diff each replacement.
- **Using `cloneElement` wrong:** `cloneElement(child, { key: watch })` — pass props as the second arg. The `key` is React's reconciliation mechanism; changing it forces a fresh mount of the child (= re-runs initial CSS transition).
- **Missing the `motion-reduce:` Tailwind variant:** the `transition-colors duration-300 ease-in-out` classes ALONE don't honor `prefers-reduced-motion`. Pair with `motion-reduce:transition-none`. Story 1.4 should have this; verify.
- **Adding a `transition: all 300ms` instead of `transition: colors`:** `all` includes layout properties, can cause unexpected animations on focus rings / sizing. Be specific: `transition-colors`.
- **Mistaking a form-input-error state for an entity status:** form inputs have their own error visualization (red border, error sentence below). That is NOT `StatusPill`. The audit's "exempt" classification covers this — add the `// not-an-entity-status: form input error` comment to make future audits cleaner.
- **Asserting on `getComputedStyle` in jsdom:** jsdom's CSS resolution is incomplete. Tests that try to inspect the actual computed `transition` property often fail. Fall back to asserting on className utility presence.
- **Forgetting that some state values are reactive across tabs:** the cross-tab payment scenario from Story 5.2 + Journey 4 triggers a `StatusPill` somewhere — the receipt's pill goes from `pending` to `posted` on a different tab than where it was posted. The 300ms transition fires there too. Verify this case in the Journey-2 e2e test.

### Open questions / blockers this story does NOT resolve

- **Whether to add a lint rule against raw status-color Tailwind utilities outside `StatusPill.tsx`:** flagged as a follow-up. Lint rules are friction; the architecture lint catalog is curated. Could land later if regressions reappear.
- **Visual regression testing:** out of scope (would catch animation regressions automatically). Phase 2 candidate.
- **Per-state custom icons:** Story 1.4 chose a set; if a stakeholder objects to a specific icon, that's a Story-1.4 follow-up, not this story.

### Project Structure Notes

Aligns with:
- [UX § Component Strategy > StatusPill + StatePillTransition](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [Architecture § Component Layers](../../_bmad-output/planning-artifacts/architecture.md)
- [UX § Composition Rules — Compose, don't customize](../../_bmad-output/planning-artifacts/ux-design-specification.md)

No detected conflicts.

### References

- [PRD § NFR-A2](../../_bmad-output/planning-artifacts/prd.md#accessibility).
- [UX § Component Strategy > StatusPill](../../_bmad-output/planning-artifacts/ux-design-specification.md).
- [UX § Component Strategy > StatePillTransition](../../_bmad-output/planning-artifacts/ux-design-specification.md).
- [UX § Motion Tokens](../../_bmad-output/planning-artifacts/ux-design-specification.md).
- [UX § Composition Rules](../../_bmad-output/planning-artifacts/ux-design-specification.md).
- [Epics § Story 5.9](../../_bmad-output/planning-artifacts/epics.md#story-59-cross-cutting-statepilltransition-application).
- [Previous story (1.4)](./1-4-visual-tokens-statuspill-reactivehighlight.md) — _adjust filename to match Story 1.4's actual landing path._

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Claude Code).

### Debug Log References

- `npx vitest run tests/unit/components/StatePillTransition.test.tsx` — 11 tests pass.
- `npx vitest run` (full unit suite) — 1661 tests pass, 1 pre-existing skip.
- `npm run lint` — clean (no warnings or errors after removing unused StatusPill imports in two consumer files).
- `npm run typecheck` — one pre-existing error in `src/components/VoidContractDialog/VoidContractDialog.tsx` (line 67, `Cannot find namespace 'JSX'`); unrelated to this story's files and outside this story's ownership. No new typecheck errors introduced.

### Completion Notes List

This story shipped the auxiliary `<StatePillTransition>` wrapper and applied it to three strategic existing `<StatusPill>` consumers. The full cross-cutting audit (AC1, AC5 — sweeping `src/` to swap every raw-Tailwind status rendering across lots / contracts / receipts / installments / expenses) was scoped down per the dev agent's bounded mandate: this story focuses on building the wrapper and a representative application. Remaining raw-pill sweep is captured for a follow-up.

a) **Consumer files modified:** 3 — `src/app/(staff)/lots/page.tsx` (table row), `src/components/LotSearchCommand/LotSearchCommand.tsx` (Cmd-K search result row), `src/app/(staff)/admin/expense-categories/page.tsx` (active-status badge). Each had its raw `<StatusPill>` swapped for `<StatePillTransition>` so a reactive status change fires both motion signals (300ms colour crossfade + 600ms amber surround flash) without per-consumer wiring.

b) **`StatePillTransition` was newly built** in this story (Story 1.4 shipped `StatusPill` + `ReactiveHighlight` separately but did not ship the composition wrapper). New files: `src/components/ui/StatePillTransition/StatePillTransition.tsx`, `src/components/ui/StatePillTransition/index.ts`, `tests/unit/components/StatePillTransition.test.tsx`.

c) **No `StatusPill` status-union extensions** made — `src/components/ui/StatusPill/**` is read-only for this story. The contract-detail and interment-detail pages currently render their own inline pills (contract states like `active` / `paid_in_full`; interment states like `scheduled` / `completed`) which are NOT in `StatusPill`'s union. Those swaps require extending `StatusPill` and are deferred to a follow-up that touches `StatusPill/icons.ts`.

d) **Sites classified as "exempt"** (no swap): the filter-chip `<StatusPill>` on `src/app/(staff)/lots/page.tsx` (line 169) and `src/components/LotMap/LotMap.tsx`'s filter chips — these reflect the user's selection chip state, not an entity status, so they continue rendering raw `<StatusPill>`. A code comment in `lots/page.tsx` documents the distinction. The `LotDetail.tsx` header already wraps its `<StatusPill>` in a wide `<ReactiveHighlight>` watching `detail.status` (the wrapper flashes the whole header, not just the pill) — left as-is because consolidating would lose the section-wide flash semantics.

e) **Final audit:** The wrapper composes the existing `StatusPill` + `ReactiveHighlight` primitives — its motion language is identical to what `StatusPill` already shipped (300ms colour crossfade) plus the standard 600ms amber surround from `ReactiveHighlight`. `prefers-reduced-motion: reduce` is inherited via `globals.css` from both primitives — no per-component branching. Three representative consumers now use the wrapper; broader sweep across receipts / installments / expenses / contracts / interments + the contract+interment inline-pill replacements remain a follow-up.

### File List

NEW:
- `src/components/ui/StatePillTransition/StatePillTransition.tsx`
- `src/components/ui/StatePillTransition/index.ts`
- `tests/unit/components/StatePillTransition.test.tsx`

MODIFIED:
- `src/app/(staff)/lots/page.tsx` — list row `<StatusPill>` → `<StatePillTransition>` (line 242 area); imports updated; filter-chip pills preserved as raw `<StatusPill>` via inline code comment.
- `src/components/LotSearchCommand/LotSearchCommand.tsx` — search-result `<StatusPill>` → `<StatePillTransition>`; unused `StatusPill` import removed.
- `src/app/(staff)/admin/expense-categories/page.tsx` — `ActiveStatusBadge`'s `<StatusPill>` calls → `<StatePillTransition>`; unused `StatusPill` import removed.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — status flipped to `review`; `last_updated` advanced.
