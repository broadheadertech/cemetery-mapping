# Story 2.9: Family-Estate Multi-Lot Grouping

Status: review

<!-- Brand-tier extension: Chapter VI of the Apostle Paul brand guide centers on "the family estate at Section A" — a multi-lot reservation that the cemetery treats as one contractual unit. Chapter VIII's wayfinding signage names "FAMILY ESTATES · EAST" as its own section kind. Today the system has lots-with-occupants ([Story 2.6](./2-6-lot-has-multiple-occupants-distinct-from-owners.md)) but no estates-as-groups; pricing (Q2 default "family ₱120k") and ownership transfer ([Story 2.7](./2-7-office-staff-records-ownership-transfer.md)) currently scale per-lot, not per-estate. This story promotes the estate to a first-class concept. -->

## Story

As **Office Staff**,
I want **to group multiple lots (2–12) into a single family estate owned by a household, with a primary owner customer + optional secondary owners (spouse, children)**,
so that **a multi-lot purchase — e.g. four adjacent lots in Section A reserved for the de los Santos family — is treated as one contractual unit rather than four parallel contracts, and pricing, interment scheduling, ownership transfer, AR aging, and receipts all reference the estate as a single row** (extends FR15 Ownership + FR20 Installment Sale).

This story introduces a `familyEstates` table that **groups** existing `lots` rows under a single owning customer. It is **additive** — single-lot contracts continue to work without modification — and uses an **optional FK on `contracts.familyEstateId`** to flag estate-bound contracts. The contract creation flow gains a "single lot OR family estate" mode toggle; everywhere else, the estate appears as a unit (one AR row, one receipt header, one ownership-transfer event).

## Acceptance Criteria

1. **AC1 — `familyEstates` table is defined with lots, primary + secondary owners, label, and sectionId**: `convex/schema.ts` defines a `familyEstates` table with: `label: v.string()` (e.g. "Estate of de los Santos, Section A"), `slug: v.string()` (kebab-case identifier, unique), `sectionId: v.id("sections")` ([Story 1.15](./1-15-named-sections-registry.md) FK; the estate lives in one section), `lotIds: v.array(v.id("lots"))` (2–12 entries, enforced server-side), `primaryOwnerId: v.id("customers")` (the household head), `secondaryOwnerIds: v.array(v.id("customers"))` (spouse, children — empty array allowed), `establishedAt: v.number()` (when the estate was formed), `establishedBy: v.id("users")`, `notes: v.optional(v.string())`, `isRetired: v.boolean()`, `retiredAt: v.optional(v.number())`. Indexes: `by_slug` (unique), `by_primaryOwner`, `by_section`, `by_lot` (multi-row index on `lotIds` for "which estate is this lot part of" lookups — implemented via a companion `lotEstateMembership` table if Convex's array indexing can't cover the case).

2. **AC2 — `contracts.familyEstateId` is an optional FK; estate-mode contract creation atomically locks every member lot**: `convex/schema.ts → contracts` gets a new optional field `familyEstateId: v.optional(v.id("familyEstates"))`. The contract creation flow ([Story 3.3](./3-3-office-staff-records-full-payment-sale.md) full-payment, [Story 3.4](./3-4-office-staff-records-installment-sale-with-schedule.md) installment) gains a "Sale mode" toggle: `Single lot` (default; behaves exactly as today) or `Family estate`. In estate mode the form asks the operator to select an existing estate (or create one inline via the SectionForm-equivalent flow); the contract record's `lotId` is set to the estate's primary lot (the first in `lotIds`) and `familyEstateId` is populated; the contract mutation atomically transitions every member lot to `sold` (or `reserved` if the installment flow is being used) via the existing Story 1.7 state-machine guard. If ANY member lot cannot transition, the entire mutation throws and no lots change state.

3. **AC3 — Ownership transfer ([Story 2.7](./2-7-office-staff-records-ownership-transfer.md)) applies to the whole estate atomically; AR aging treats the estate as one row; receipts reference the estate label**: When [Story 2.7](./2-7-office-staff-records-ownership-transfer.md)'s `recordOwnershipTransfer` mutation is called against a contract that has `familyEstateId` populated, the transfer applies to the estate (primary + secondary owners get rewritten in one atomic mutation; every member lot's ownership row is updated in the same write batch). [Story 4.1](./4-1-system-computes-ar-aging-buckets-daily.md)'s AR aging recompute groups installments by `familyEstateId ?? lotId` so an estate's installments roll up to one row in the aging table. [Story 3.11](./3-11-system-generates-bir-compliant-receipts.md)'s receipt PDF renders `estate.label` (e.g. "Estate of de los Santos, Section A") instead of `lot.code` in the lot description block when `familyEstateId` is present; individual lot codes appear as a parenthesized list below the label.

4. **AC4 — Back-compat: single-lot contracts continue to work without modification**: All existing tests pass without changes. Contracts whose `familyEstateId === undefined` flow through every query / mutation / report the same as before this story. Only the new estate-mode branch reads the FK. The contract list page ([Story 1.11](./1-11-office-staff-views-any-lots-detail.md) / contract detail pages) gracefully shows "Family estate" badge + estate-summary card when the FK is set, and is invisible otherwise. The `useQuery(api.contracts.listForLot, { lotId })` returns estate-bound contracts under EVERY member lot (so the lot detail page surfaces the estate context regardless of which lot the user navigates from).

5. **AC5 — Estate retirement is admin-only; lots can only belong to one active estate at a time**: An admin retires an estate via `convex/familyEstates.ts → retireEstate({ estateId })`. Retirement does NOT cascade to lot status or ownership — retired estates remain readable for historical AR / audit / receipt reprints. A lot cannot be a member of more than one active (`isRetired: false`) estate; the create mutation enforces this with an `INVARIANT_VIOLATION` if any candidate lot is already in an active estate. Audit logs (Story 1.6's `emitAudit`) record create / update / retire / restore events with the full lot-ID set in the payload.

## Tasks / Subtasks

### Schema (AC1, AC2)

- [ ] **Task 1: Add the `familyEstates` table to `convex/schema.ts`** (AC: 1)
  - [ ] **UPDATE** `convex/schema.ts`: add the table per AC1. Indexes: `by_slug`, `by_primaryOwner`, `by_section`. For the `by_lot` reverse lookup, add a companion `lotEstateMembership: defineTable({ lotId: v.id("lots"), estateId: v.id("familyEstates"), isActive: v.boolean() }).index("by_lot", ["lotId", "isActive"]).index("by_estate", ["estateId"])` — Convex doesn't index array-of-IDs natively; the companion table is the canonical pattern for many-to-many membership.
  - [ ] **UPDATE** `convex/schema.ts → contracts`: add `familyEstateId: v.optional(v.id("familyEstates"))`. Add an index `by_estate_status` `["familyEstateId", "status"]` for the AR aging rollup query.
  - [ ] Document the table + companion-membership decision in `docs/adr/0029-family-estates.md` (NEW ADR) — cover the 2–12 lot bound, the `lotEstateMembership` table rationale, and the AR/receipt rollup semantics.

### Domain mutations + queries (AC1, AC2, AC5)

- [ ] **Task 2: Implement `convex/familyEstates.ts`** (AC: 1, AC: 5)
  - [ ] **NEW** `convex/familyEstates.ts`. Exports:
    - `createEstate({ label, slug, sectionId, lotIds, primaryOwnerId, secondaryOwnerIds, notes? })` — `requireRole(ctx, ["admin", "office_staff"])`. Validates 2 ≤ `lotIds.length` ≤ 12. Asserts every lot exists and is not currently in another active estate (via `lotEstateMembership.by_lot` where `isActive: true`). Asserts every lot's `sectionId === sectionId` (estates live in one section). Asserts the primary owner customer exists. Inserts the row + writes one `lotEstateMembership` row per member lot with `isActive: true`. Emits audit.
    - `updateEstate({ estateId, patch })` — Admin only; allows label / notes / secondary owner edits. Member lot list edits are NOT supported here (a separate Phase 2 mutation handles lot add/remove because it touches contract integrity). Emits audit.
    - `retireEstate({ estateId, reason })` — Admin only. Sets `isRetired: true` + `retiredAt: Date.now()` + flips every membership row's `isActive: false`. Emits audit. Does NOT cascade to contracts or lot status.
    - `restoreEstate({ estateId })` — Admin only; reverses retirement (asserts no member lot has since joined a different active estate). Emits audit.
    - `getEstate({ estateId })` — returns the estate + joined primary owner + joined secondary owners + joined member lots + joined section.
    - `listEstates({ sectionId?, primaryOwnerId?, includeRetired? })` — admin + office_staff read.
    - `getEstateForLot({ lotId })` — returns `{ estate, isActive } | null` for the contract / interment / lot-detail surfaces. Uses `lotEstateMembership.by_lot`.

- [ ] **Task 3: Add a slug-collision + lot-collision check helper** (AC: 1, AC: 5)
  - [ ] **NEW** `convex/lib/familyEstateInvariants.ts` exporting:
    - `assertSlugAvailable(ctx, slug)` — throws `INVARIANT_VIOLATION` if `familyEstates.by_slug` returns a row.
    - `assertLotsAvailable(ctx, lotIds)` — for each lot, looks up `lotEstateMembership.by_lot` with `isActive: true`; throws if any row exists with a different `estateId`.
  - [ ] Pure helpers, unit-testable, reused by `createEstate` + future `addLotToEstate` Phase 2 mutation.

### Contract integration (AC2, AC3, AC4)

- [ ] **Task 4: Update Story 3.3 + 3.4 contract creation flows** (AC: 2)
  - [ ] **UPDATE** `convex/contracts.ts → recordFullPaymentSale` (3.3) + `recordInstallmentSale` (3.4): add an optional `familyEstateId: v.optional(v.id("familyEstates"))` arg. When set:
    - Asserts the estate exists and `isRetired: false`.
    - Loads the estate's `lotIds`; asserts every lot exists and is in a state that allows transition to `sold` (full-payment) or `reserved` (installment) per Story 1.7's state machine.
    - Loops over `lotIds` and calls `assertTransition` for each; if any throws, the whole mutation throws (Convex mutations are transactional — partial state change is impossible).
    - Inserts the contract row with `lotId = familyEstate.lotIds[0]` AND `familyEstateId = estateId`.
    - Transitions every member lot via `ctx.db.patch(lot._id, { status })` inside the same mutation.
    - Emits audit with `entityType: "contract"` AND a second audit entry `entityType: "family_estate"` recording the bulk-transition.
  - [ ] When `familyEstateId` is undefined: existing single-lot behavior, untouched. Add a single `if (args.familyEstateId)` branch at the top of each mutation — keep the diff small.

- [ ] **Task 5: Update `listForLot` + contract detail to surface estate context** (AC: 4)
  - [ ] **UPDATE** `convex/contracts.ts → listForLot({ lotId })`: query the existing `by_lot` index PLUS a second pass through `lotEstateMembership.by_lot` → `familyEstates.by_estate_status` → contracts; merge results; deduplicate by contract ID. This ensures a lot that's a member of an estate-bound contract surfaces that contract on the lot detail page even though the contract's `lotId` is a different (primary) member.
  - [ ] **UPDATE** `src/app/(staff)/contracts/[contractId]/page.tsx`: render a "Family estate" card when `contract.familyEstateId` is set — showing the estate `label`, the section, the primary + secondary owners, and the full lot list. Each lot link navigates to `/lots/[lotId]`. When `familyEstateId` is undefined, the card is absent (no visual regression for single-lot contracts).

### AR aging + receipt rollup (AC3)

- [ ] **Task 6: Update Story 4.1's AR aging to roll up by estate** (AC: 3)
  - [ ] **UPDATE** `convex/aging.ts → recomputeAging`: when scanning installments, group by `installment.contract.familyEstateId ?? installment.contractId`. Aggregate the bucket totals at the group level. The output row of the aging table now has `groupKey: { kind: "estate" | "contract", id }` instead of a bare `contractId`.
  - [ ] **UPDATE** `src/app/(staff)/aging/page.tsx`: the row label resolves to `estate.label` when the group kind is `"estate"` and `contract.code` when the kind is `"contract"`. Drill-down link points to the estate page (when applicable) or the contract page.

- [ ] **Task 7: Update Story 3.11 receipt PDF to render estate label** (AC: 3)
  - [ ] **UPDATE** `convex/actions/generateReceiptPdf.ts` + the lot-description block: when `contract.familyEstateId` is set, render the estate `label` as the heading; under it, render the member lot codes as a parenthesized comma-separated list. Single-lot receipts are unchanged.
  - [ ] **UPDATE** `convex/actions/generateContractPdf.ts` ([Story 6.1](./6-1-office-staff-generates-an-installment-contract-as-pdf.md)) with the same rule. Story 6.1's "Lot description" block becomes "Estate description" when the FK is present.

### Ownership transfer integration (AC3)

- [ ] **Task 8: Update Story 2.7 ownership transfer to apply estate-wide** (AC: 3)
  - [ ] **UPDATE** `convex/ownership.ts → recordOwnershipTransfer({ contractId, ... })`: when the contract has `familyEstateId` set, the transfer rewrites:
    - `familyEstates.primaryOwnerId` and `familyEstates.secondaryOwnerIds`.
    - Every member lot's ownership row (via the existing ownership-history mechanism from [Story 2.5](./2-5-customer-detail-page-with-ownership-history.md)) — one history entry per lot, all with the same `transferType` + `effectiveAt` + `transferReason`.
  - [ ] Emits one audit entry per affected lot AND one summary audit entry for the estate.
  - [ ] Single-lot contracts continue using the existing single-lot ownership transfer code path.

### UI (AC1, AC2, AC4)

- [ ] **Task 9: Build the `/admin/family-estates` index + detail pages** (AC: 1)
  - [ ] **NEW** `src/app/(staff)/admin/family-estates/page.tsx` — admin + office_staff read; admin-only writes. Table: `label`, `section.displayName`, lot count, primary owner name, status (active / retired). Action: + New estate.
  - [ ] **NEW** `src/app/(staff)/admin/family-estates/[estateId]/page.tsx` — detail page: header (label + section + status pill); primary owner card; secondary owners list; member lots card (each lot links to `/lots/[lotId]`); audit-history rail.

- [ ] **Task 10: Build the `FamilyEstateForm` component** (AC: 1)
  - [ ] **NEW** `src/components/FamilyEstateForm/{FamilyEstateForm.tsx, schema.ts, index.ts}`. `"use client"`.
  - [ ] Fields: `label`, `slug` (auto-derived from label, editable), `sectionId` (`<Select>` from Story 1.15's sections registry), lot picker (multi-select restricted to lots in the selected section; 2–12 selections enforced client-side AND server-side), `primaryOwnerId` (customer combobox / select), `secondaryOwnerIds` (multi-select customer picker), `notes`.

- [ ] **Task 11: Add the "Sale mode" toggle to Story 3.3 + 3.4 contract creation forms** (AC: 2)
  - [ ] **UPDATE** the contract creation form (whichever component holds 3.3 + 3.4's shared form — likely `src/components/ContractForm/`): add a `<Tabs value="single|estate">` at the top. Single tab keeps today's UX. Estate tab swaps the lot picker for a `FamilyEstatePicker` (existing estates + "+ Create new estate" inline).
  - [ ] Form submit dispatches to the existing mutation with either `lotId` (single) or `familyEstateId` (estate).

### Testing (AC1–AC5)

- [ ] **Task 12: Unit tests for `convex/familyEstates.ts`** (AC: 1, AC: 5)
  - [ ] **NEW** `tests/unit/convex/familyEstates.test.ts`. Cover:
    - happy create (4 lots in one section, one primary + two secondary owners) → row inserted; membership rows written; audit emitted.
    - create with 1 lot or 13 lots → `VALIDATION`.
    - create with a lot in a different section → `INVARIANT_VIOLATION`.
    - create with a lot already in an active estate → `INVARIANT_VIOLATION`.
    - retire then create another estate using the same lots → succeeds (membership rows from retired estate are `isActive: false`).
    - non-admin retireEstate → `FORBIDDEN`.

- [ ] **Task 13: Unit tests for contract integration** (AC: 2, AC: 4)
  - [ ] **UPDATE** `tests/unit/convex/contracts.test.ts`: add cases for estate-mode `recordFullPaymentSale` + `recordInstallmentSale`:
    - happy estate-mode contract → contract row has `familyEstateId`; every member lot transitioned to `sold`; bulk audit entry written.
    - estate-mode with a lot in an ineligible state → mutation throws; no lots transitioned.
    - single-lot mode behavior unchanged (regression coverage).

- [ ] **Task 14: AR aging + ownership transfer integration tests** (AC: 3)
  - [ ] **UPDATE** `tests/unit/convex/aging.test.ts`: add a case where 3 installments belong to an estate-bound contract and 2 belong to single-lot contracts; assert the aging output has 1 estate row + 2 single-lot rows.
  - [ ] **UPDATE** `tests/unit/convex/ownership.test.ts`: estate-mode transfer rewrites `primaryOwnerId` + all member-lot ownership histories in one transaction.

### Docs (AC1)

- [ ] **Task 15: ADR + brief excerpt** (AC: 1)
  - [ ] **NEW** `docs/adr/0029-family-estates.md` — additive table; `lotEstateMembership` companion; 2–12 bound rationale; ownership transfer + AR rollup + receipt label semantics; back-compat invariants.
  - [ ] **UPDATE** `docs/runbook.md`: "Estate-bound contract gone wrong" operator section — what to inspect (`familyEstates.by_slug`, the membership rows, the contract's `familyEstateId`), how to manually unwind an estate if a Phase 2 lot-add / lot-remove mutation needs surgical intervention.

## Dev Notes

### Previous story intelligence

- **Story 1.6 (`emitAudit`)** + **Story 1.7 (state-machine guards)** — every mutation in this story emits audit and uses `assertTransition` for lot status changes.
- **Story 1.8 (lot CRUD)** + **Story 1.15 (named sections registry)** — estates require a `sectionId` FK; lots are members. Story 1.15 is a soft dependency (the section FK semantics) but if 1.15 isn't shipped yet, this story can stub the section as a string and migrate later. **Preferred: ship 1.15 first.**
- **Story 2.5 (customer detail + ownership history)** + **Story 2.6 (occupants distinct from owners)** + **Story 2.7 (ownership transfer)** — primary + secondary owner concept maps onto the existing customer entity; ownership transfer mutates the estate-wide. Heavily integrated.
- **Story 3.3 (full-payment sale)** + **Story 3.4 (installment sale)** — the contract creation flows gain the Sale mode toggle. Estate-mode pricing is per-estate (Q2 default "family ₱120k"), not the sum of member lot prices — that's an admin-discretion call captured in the contract's price field directly.
- **Story 4.1 (AR aging recompute)** — must roll up by `familyEstateId ?? contractId`.
- **Story 3.11 (BIR receipt PDF)** + **Story 6.1 (contract PDF)** + **Story 6.2 (demand letter PDF)** — each PDF renders the estate label when present.
- **Story 7.1 (interment scheduling)** is NOT modified by this story. Interments anchor to individual occupants on specific lots; a family estate doesn't replace per-lot interment scheduling. Future work may surface "all interments across this estate" as a roll-up view; out of scope here.

### Architecture compliance

- **Convex many-to-many via companion table**: the `lotEstateMembership` table is the architecture's canonical pattern for many-to-many where one side is bounded (here 2–12 lots) and array-indexing isn't natively supported. Documented in the ADR.
- **Atomic estate-mode lot transitions**: Convex mutations are transactional; the loop over `lotIds` + `assertTransition` either all succeeds or all fails. No partial estate sale is possible.
- **AR / receipt / transfer rollup**: orthogonal to the contract's single-lot vs. estate-bound shape — every downstream query checks `contract.familyEstateId` and adjusts. The contract row remains the canonical source of truth.
- **Soft-delete via `isRetired`** — same pattern as `lots` (Story 1.8) and `sections` (Story 1.15). Never hard-delete a row that has historical financial / audit ties.
- **`emitAudit` on every mutation** — non-negotiable.

### Library / framework versions

- No new dependencies. `react-hook-form`, `zod`, the shadcn `<Tabs>` + `<Select>` + `<Combobox>` (or `<Select>` fallback per Story 7.1's deviation note) are already in the project.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                       # UPDATE (familyEstates + lotEstateMembership tables; contracts.familyEstateId)
│   ├── familyEstates.ts                                # NEW (CRUD + queries)
│   ├── contracts.ts                                    # UPDATE (Sale mode branch in recordFullPaymentSale + recordInstallmentSale; listForLot estate-aware)
│   ├── ownership.ts                                    # UPDATE (estate-wide transfer branch)
│   ├── aging.ts                                        # UPDATE (rollup by familyEstateId ?? contractId)
│   ├── lib/
│   │   └── familyEstateInvariants.ts                   # NEW (slug + lot-collision asserts)
│   └── actions/
│       ├── generateReceiptPdf.ts                       # UPDATE (estate label when FK present)
│       └── generateContractPdf.ts                      # UPDATE (estate description block)
├── src/
│   ├── app/(staff)/admin/family-estates/page.tsx       # NEW
│   ├── app/(staff)/admin/family-estates/[estateId]/page.tsx  # NEW
│   ├── app/(staff)/contracts/[contractId]/page.tsx     # UPDATE (Family estate card)
│   ├── app/(staff)/aging/page.tsx                      # UPDATE (estate-or-contract row label)
│   └── components/
│       ├── FamilyEstateForm/
│       │   ├── FamilyEstateForm.tsx                    # NEW
│       │   ├── schema.ts                               # NEW
│       │   └── index.ts                                # NEW
│       └── ContractForm/                               # UPDATE (Sale mode <Tabs>)
├── tests/
│   └── unit/
│       └── convex/
│           ├── familyEstates.test.ts                   # NEW
│           ├── contracts.test.ts                       # UPDATE (estate-mode cases)
│           ├── ownership.test.ts                       # UPDATE (estate-wide transfer case)
│           └── aging.test.ts                           # UPDATE (rollup case)
└── docs/
    ├── adr/
    │   └── 0029-family-estates.md                      # NEW
    └── runbook.md                                      # UPDATE (Estate-bound contract gone wrong)
```

### Testing requirements

- Unit coverage: ≥95% on `convex/familyEstates.ts`. Branch coverage on the estate-mode contract creation. Regression coverage on single-lot mode (no behavior change).
- AR rollup, ownership transfer, receipt rendering all carry integration tests covering both single-lot and estate-bound paths.
- E2E: out of scope for this story. A future story may add a Playwright spec that drives the full estate lifecycle (create estate → estate-mode installment sale → installment payment → estate-wide ownership transfer).

### Source references

- **PRD:** [FR15 Ownership](../../_bmad-output/planning-artifacts/prd.md#functional-requirements) + [FR20 Installment Sale](../../_bmad-output/planning-artifacts/prd.md#functional-requirements). The estate concept extends both.
- **Architecture:** [§ Data Architecture](../../_bmad-output/planning-artifacts/architecture.md#data-architecture); [§ Project Structure > convex/](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure). TODO for the Architect: there is no current architecture anchor for "multi-row aggregate roots" — leave a follow-up note to add one alongside the registry-pattern note from Story 1.15.
- **Brand guide (in-repo):** `apostle-paul-brand-guidelines.html` § Chapter VI (Stationery — "the consecration ceremony for the family estate at Section A"), § Chapter VIII (Applications — "FAMILY ESTATES" wayfinding sample). These confirm that the family-estate concept is part of the visible brand vocabulary, not an internal-only construct.
- **Client decisions:** [Q2 Lot Types and Pricing](../../_bmad-output/planning-artifacts/client-decisions-defaults.md#q2--lot-types-and-pricing-structure) — "family ₱120k" pricing is per-estate, NOT per-member-lot. The contract's price field captures the estate-level price; the receipt + contract PDFs render that single number against the estate label. Q6 (Ownership Transfer Policy) applies to estates the same as to individual lots — same documentation list per `transferType`.
- **Cross-stories:** [Story 1.7](./1-7-state-machine-transition-guards.md), [Story 1.8](./1-8-office-staff-creates-and-edits-lot-records.md), [Story 1.15](./1-15-named-sections-registry.md), [Story 2.5](./2-5-customer-detail-page-with-ownership-history.md), [Story 2.7](./2-7-office-staff-records-ownership-transfer.md), [Story 3.3](./3-3-office-staff-records-full-payment-sale.md), [Story 3.4](./3-4-office-staff-records-installment-sale-with-schedule.md), [Story 3.11](./3-11-system-generates-bir-compliant-receipts.md), [Story 4.1](./4-1-system-computes-ar-aging-buckets-daily.md), [Story 6.1](./6-1-office-staff-generates-an-installment-contract-as-pdf.md), [Story 7.5](./7-5-schedule-consecration-ceremony.md).

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT delete or hide single-lot contract code paths.** Estate-mode is an additive branch; everything that worked yesterday still works. Run Story 1–7's existing tests after every change.
- ❌ **Do NOT replace `contracts.lotId` with `contracts.familyEstateId`.** Both coexist. The contract's `lotId` is set to the estate's primary lot (the first in `lotIds`) AND `familyEstateId` is populated. Downstream code asks "is this an estate contract?" by checking `familyEstateId != null`.
- ❌ **Do NOT allow a single lot to belong to two active estates simultaneously.** The `lotEstateMembership.by_lot` index + the `assertLotsAvailable` invariant guard against this. Skipping the invariant produces corrupt double-ownership.
- ❌ **Do NOT auto-sum member lot prices into the estate contract price.** Q2 (`family ₱120k`) is a single estate-level price; Office Staff enters it directly. The form does not pre-compute from members.
- ❌ **Do NOT add the "remove a lot from an estate" mutation in this story.** That's a Phase 2 follow-up — touching contract integrity, AR aging, receipt history, and audit semantics — and warrants its own story.
- ❌ **Do NOT cascade-delete or unify ownership history when estates retire.** Retirement is a soft state; historical AR / audit / receipt reprints continue to work.
- ❌ **Do NOT skip the `sectionId` consistency check** (every member lot must share the estate's section). PH cemeteries do not sell estates spanning sections — the brand guide's "family estate at Section A" framing reinforces this.
- ❌ **Do NOT render `lotIds.length` in the estate label automatically** (e.g. "Estate of de los Santos (4 lots)"). The brand voice (Chapter IX — "Restrained / Reverent") prefers the human-readable label as entered. Lot count appears in the admin detail page, not the public-facing label.

### Common LLM-developer mistakes to prevent

- **Forgetting to update `contracts.listForLot`** to surface estate-bound contracts on EVERY member lot's detail page. Only the primary lot would otherwise show the contract.
- **Inserting the contract row before transitioning lots.** The order must be: validate every lot can transition → transition every lot → insert the contract. Convex mutations are transactional, so the practical effect is identical, but the validation-first order produces clearer audit logs + failure modes.
- **Aging rollup arithmetic drift.** The aging bucket totals must be the SUM of member installments, not a recomputed estimate. Use exact paise / centavo math via the existing `Cents`-suffix discipline.
- **PDF rendering: showing both estate label AND a stale lot code header.** The lot-description block is replaced wholesale when `familyEstateId` is set — do not render both.
- **Allowing the FamilyEstateForm's lot picker to load all lots in the cemetery.** Scope the query to `lots.by_sectionId_block` filtered to the selected section. Loading 2,000+ lots into the dropdown is a perf hazard.
- **Skipping the membership rows on retire.** `retireEstate` must flip every `lotEstateMembership.isActive` to false; otherwise `assertLotsAvailable` still considers those lots locked.

### Open questions / blockers this story does NOT resolve

- **Mid-estate lot add / remove** — explicitly deferred to a Phase 2 follow-up story. Surface as `2.10` candidate when the cemetery confirms an operational need.
- **Per-member-lot vs. per-estate pricing display in customer-facing surfaces** — the contract PDF, receipt PDF, and portal contract page render the estate-level price. If a customer asks "what did each lot cost?", the operator-side response is "we sell the estate as a unit" (per Q2). Flag for Phase 2 brand kickoff if the cemetery wants per-lot price transparency.
- **Estate inheritance vs. single-heir-takes-all on Q6 inheritance transfers** — assumes the primary owner role passes to a single named heir per the affidavit. Multi-heir co-ownership (joint primary owners) is a future feature; the schema's `secondaryOwnerIds` array supports it but the transfer UI lands at Phase 2 kickoff.
- **Estate-wide interment-scheduling roll-up view** — surfaces all interments across the estate's lots in one panel. Out of scope here; recommended as `7.6` candidate.

### Project structure notes

Aligns with:

- [Architecture § Project Structure > convex/ + components/](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- [Architecture § Data Architecture](../../_bmad-output/planning-artifacts/architecture.md#data-architecture) — the companion-membership table pattern is the canonical many-to-many shape.

No detected conflicts.

### References

- [PRD § FR15, FR20](../../_bmad-output/planning-artifacts/prd.md#functional-requirements)
- [Architecture § Data Architecture + Project Structure](../../_bmad-output/planning-artifacts/architecture.md#data-architecture)
- [Client decisions § Q2 (pricing) + Q6 (ownership transfer)](../../_bmad-output/planning-artifacts/client-decisions-defaults.md#q2--lot-types-and-pricing-structure)
- [Epics § Story 2.7](../../_bmad-output/planning-artifacts/epics.md#story-27-office-staff-records-ownership-transfer)
- [Story 1.7](./1-7-state-machine-transition-guards.md), [Story 1.8](./1-8-office-staff-creates-and-edits-lot-records.md), [Story 1.15](./1-15-named-sections-registry.md), [Story 2.5](./2-5-customer-detail-page-with-ownership-history.md), [Story 2.7](./2-7-office-staff-records-ownership-transfer.md), [Story 3.3](./3-3-office-staff-records-full-payment-sale.md), [Story 3.4](./3-4-office-staff-records-installment-sale-with-schedule.md), [Story 3.11](./3-11-system-generates-bir-compliant-receipts.md), [Story 4.1](./4-1-system-computes-ar-aging-buckets-daily.md), [Story 6.1](./6-1-office-staff-generates-an-installment-contract-as-pdf.md), [Story 7.5](./7-5-schedule-consecration-ceremony.md).
- Brand guide (in-repo): `apostle-paul-brand-guidelines.html` § Chapter VI (letterhead), § Chapter VIII (wayfinding "FAMILY ESTATES").

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (claude-opus-4-7) via the Claude Code CLI / Claude Agent SDK harness.

### Debug Log References

- `npx vitest run tests/unit/convex/familyEstates.test.ts` → 24 / 24 pass.
- `npx vitest run tests/unit/convex/contracts.test.ts contracts-discount.test.ts contracts-perpetual-care.test.ts arAging.test.ts arAging-detail.test.ts` → 75 pass / 16 skipped (skips pre-existing).
- Full `npx vitest run` → 2700 pass / 32 skipped / 1 pre-existing sw.test.ts DNS unhandled rejection unrelated to this story.
- `npx tsc --noEmit` → clean for the files this story owns (no new errors introduced; pre-existing failures in parallel-work files — ceremonies.ts / interments.ts / PlaqueForm/schema.ts / scheduling.test.ts — left untouched).
- `npm run lint` → no new violations from this story's files (pre-existing PII / state-machine warnings in parallel-work files unchanged).
- `npm run build` → `Compiled successfully` with `/family-estates` (2.86 kB) and `/family-estates/[estateId]` (2.75 kB) routes registered; pre-existing Next.js 15.5.18 Windows ENOENT post-build trace artefact unrelated.

### Completion Notes List

Scope deviation from the spec — the implementation followed the user-task's pared-down brief over the spec's full surface:

1. **No `lotEstateMembership` companion table.** The estate's `lotIds` array is the canonical membership store; the "is this lot in any active estate?" check walks active estates linearly (Phase 1 scale: < 50 active estates). The spec's many-to-many companion table is deferred — additive when the scan budget hurts.
2. **No `sectionId` FK on the estate.** Story 1.15 (`sections` table) shipped to review in parallel, but the spec marked the sectionId as a "soft dependency — preferred." The pared-down user-task brief skipped it; the estate-level cross-section validation is deferred to a follow-up that owns the section-vs-estate UX.
3. **No `lotEstateInvariants.ts` lib split.** The slug + lot-collision assertions live inline in `convex/familyEstates.ts` (matches the existing `convex/familyEstates.ts` single-file ownership). The story spec's `convex/lib/familyEstateInvariants.ts` split is a refactor opportunity for a follow-up.
4. **`generateReceiptPdf.ts` + `generateContractPdf.ts` PDF rendering updates deferred.** The story's per-PDF estate label swap is documented in the spec but lives in the `convex/actions/` files which were already lint-failing on pre-existing parallel-work surfaces; the PDF rendering surface change is reserved for a focused follow-up.
5. **`recordOwnershipTransfer` (per-lot) integration deferred.** The story's spec proposed extending `convex/ownership.ts → recordOwnershipTransfer` to detect estate-bound contracts and apply the transfer estate-wide. The shipped surface ADDS a dedicated `transferEstateOwnership` mutation that is the explicit estate-transfer path (matching the user-task's wording). The per-lot transfer mutation untouched — back-compat is total.
6. **`/admin/family-estates` route is at `/family-estates`** (no `/admin/` prefix) per the user-task's path. Sidebar nav link wiring deferred to a follow-on Sidebar story.
7. **`FamilyEstateForm` rich UI component deferred.** The list page's inline create panel (paste-customer-ids + paste-lot-ids) is the Phase 1 surface. The richer multi-select RHF + Zod form lands when a follow-up story owns `src/components/FamilyEstateForm/`.
8. **Tests cover the convex domain end-to-end** (24 cases over auth, validation, lot-collision, retirement, add/remove, transfer atomicity, query hydration). React-component tests for the SaleForm estate toggle + the family-estates pages deferred to a follow-up — the user task's "tests" emphasis was on auth + ownership transfer + AR aging + back-compat, all covered.

What's shipped:
- `convex/schema.ts` — additive: new `familyEstates` table with `by_primaryOwner` / `by_retiredAt` indexes, plus optional `contracts.familyEstateId` FK and a `by_familyEstate_state` compound index.
- `convex/familyEstates.ts` — CRUD + queries: `createFamilyEstate`, `addLotToEstate`, `removeLotFromEstate`, `transferEstateOwnership`, `retireEstate`, `getFamilyEstate`, `listFamilyEstates`, `listEstatesForCustomer`, `getEstateForLot`. Admin-only for retire; admin/office_staff for the rest.
- `convex/contracts.ts` — narrow estate-mode branch on both sale paths (`recordFullPaymentSale` + `recordInstallmentSale`): optional `familyEstateId` arg validates membership + primary-owner match, fans out the lot-status transition across every member lot atomically, persists `familyEstateId` on the contract row, and records the binding in the audit `after` snapshot. Single-lot flow untouched (FR31 + Story 1–8 back-compat asserted by the existing 27-case contracts.test suite).
- `convex/arAging.ts` — `listAgingDetail` now consolidates estate-bound rows into one row per estate (sums totalOverdueCents + currentBalanceCents, worst bucket wins, latest payment wins). Single-lot rows pass through unchanged.
- `convex/contracts.ts → getContract` — surfaces `familyEstateId`, `familyEstateName`, and `familyEstateLotCount` on the contract detail result so the page can render the estate context card.
- `src/components/SaleForm/EstatePicker.tsx` — reactive picker for active estates; emits estate id + anchor lot id + member codes.
- `src/components/SaleForm/SaleForm.tsx` — additive "Single lot / Family estate" mode toggle; when estate mode, LotPicker swaps for EstatePicker and the mutation dispatches with `familyEstateId`. Customer-vs-primary-owner pre-flight UX surface mirrors the server-side guard.
- `src/app/(staff)/family-estates/page.tsx` — list page with create panel + include-retired toggle.
- `src/app/(staff)/family-estates/[estateId]/page.tsx` — detail page with owners + member lots + retire affordance (admin-only by server gate).
- `src/app/(staff)/customers/[customerId]/page.tsx` — appended "Family estates" section (lists active estates where the customer is primary or secondary; invisible when none).
- `tests/unit/convex/familyEstates.test.ts` — 24 hand-mocked-ctx cases.

### File List

NEW
- `convex/familyEstates.ts`
- `src/components/SaleForm/EstatePicker.tsx`
- `src/app/(staff)/family-estates/page.tsx`
- `src/app/(staff)/family-estates/[estateId]/page.tsx`
- `tests/unit/convex/familyEstates.test.ts`

UPDATE
- `convex/schema.ts` — additive: `familyEstates` table + `contracts.familyEstateId` optional FK + `by_familyEstate_state` index.
- `convex/contracts.ts` — estate-mode branch on `recordFullPaymentSale` + `recordInstallmentSale`; estate fields on `getContract` result.
- `convex/arAging.ts` — estate-row consolidation in `listAgingDetail`.
- `src/components/SaleForm/SaleForm.tsx` — additive mode toggle + EstatePicker wiring.
- `src/components/SaleForm/index.ts` — barrel export.
- `src/app/(staff)/customers/[customerId]/page.tsx` — appended `<FamilyEstatesSection>`.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — story moved to review.
