# Story 2.7: Office Staff Records Ownership Transfer

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **Office Staff (Maria)**,
I want **to record an ownership transfer (sale / inheritance / gift / court order) on a lot — choosing a transfer type, picking a destination customer, attaching the type-specific required documents, and confirming an effective date — and have the system atomically close the previous ownership row and open a new one**,
so that **the lot's ownership history (Story 2.5's `OwnershipHistoryList`) reflects the new owner with correct time-versioning, and the cemetery's records can prove the transfer chain to a future buyer / regulator / heir** (FR17 — **gated on §10 Q6**).

This is the **first multi-document atomic mutation in Epic 2** and the **first consumer of Story 1.7's `assertTransition`** outside the Epic 3 sale flow. It introduces the `transferEvents` table (transfer-type-specific documentation metadata), the `RecordTransferDialog` workflow with type-driven required-document gates, and the `recordTransfer` mutation that — in one atomic write — closes the previous ownership, opens a new ownership, creates a transfer event, and emits audit. Until §10 Q6 (transfer policy + required documents per type) is answered by the client, this story ships with **explicit "policy pending" defaults** (a permissive document checklist + a banner on the Dialog) so the workflow is usable; when the client confirms the policy, the document-requirement table is updated in one configuration commit (no schema migration).

## Acceptance Criteria

1. **AC1 — `transferEvents` table is defined; `ownerships` schema is extended with `transferEventId` link** (FR17, architecture § 232, § 265): `convex/schema.ts` adds a `transferEvents` table: `lotId` (`v.id("lots")`), `fromCustomerId` (`v.optional(v.id("customers"))` — optional because the first owner has no `from`), `toCustomerId` (`v.id("customers")`), `transferType` (union literal: `"sale" | "inheritance" | "gift" | "court_order" | "initial"`), `effectiveDate` (number — unix ms; may be in the past for legacy migration), `requiredDocsAttached` (array of `v.id("customerAttachments")` — links to the attachments stored via Story 2.2), `notes` (optional string, up to 1000), `recordedAt` (number), `recordedByUserId` (`v.id("users")`), `actorReason` (string — 3–500, required for audit; for backdated transfers must explain why). Indexed by `by_lot_effective` (`["lotId", "effectiveDate"]`) and `by_to_customer` (`["toCustomerId"]`). The `ownerships` table (created in Story 2.5's scaffolding or already in place) has its `transferEventId` field hydrated by this story's mutation.

2. **AC2 — Document-requirements table drives the UI's per-type checklist** (FR17 — §10 Q6 gated): A new module `convex/lib/transferDocRequirements.ts` exports a typed table:
    ```ts
    export const TRANSFER_DOC_REQUIREMENTS: Record<TransferType, RequiredDocSpec[]> = {
      sale:         [{ docType: "deed_of_sale",                label: "Deed of sale",                required: true }],
      inheritance:  [{ docType: "affidavit_of_self_adjudication", label: "Affidavit of self-adjudication", required: true },
                     { docType: "death_certificate",          label: "Death certificate",           required: true }],
      gift:         [{ docType: "deed_of_donation",            label: "Deed of donation",            required: true }],
      court_order:  [{ docType: "court_order",                 label: "Court order",                 required: true }],
      initial:      [],
    };
    ```
   **POLICY-PENDING NOTE:** the per-type document list above is a placeholder consistent with PRD § Domain Notes (line 288) and is treated as the **default until §10 Q6 is answered**. When the client confirms, this table is the single edit point — no schema migration. The UI surfaces a banner: "Required documents per transfer type are pending client confirmation (open question §10 Q6). Current defaults shown."

3. **AC3 — `recordTransfer` mutation is atomic and audited** (FR17, architecture § 302): `convex/ownerships.ts → recordTransfer` mutation: (a) `requireRole(ctx, ["office_staff", "admin"]);` (b) validates args via Zod (effectiveDate must be a positive integer; transferType in the union; `toCustomerId` exists; `requiredDocsAttached` length matches the spec from `TRANSFER_DOC_REQUIREMENTS[transferType]` — each required doc must have a matching attachment ID; backdated transfers require `actorReason` length ≥ 10 chars explaining the backdating); (c) loads the lot; loads the current open ownership row (`effectiveTo` is undefined) via `ownerships.by_lot_effective` index; (d) calls `assertTransition(...)` from Story 1.7 if the lot's status warrants — for now, transfer does not change lot status (the lot stays `sold` / `occupied` after a transfer); flag for §10 Q6 to confirm; (e) in one mutation atomically: patches the previous ownership's `effectiveTo = effectiveDate`, inserts a new ownership row `{ lotId, customerId: toCustomerId, effectiveFrom: effectiveDate, effectiveTo: undefined, transferType, transferEventId }`, inserts the `transferEvents` row, calls `emitAudit(ctx, { action: "ownership.transfer", entityType: "lot", entityId: lotId, before: { ownerCustomerId: previousOwnerId }, after: { ownerCustomerId: toCustomerId, transferType, effectiveDate }, reason: actorReason })`; (f) returns `{ transferEventId, newOwnershipId }`. **All four writes are in the same mutation** — Convex's per-mutation atomicity guarantees no half-state.

4. **AC4 — `RecordTransferDialog` UI gates submit on required-doc-attachment** (UX § Form Patterns, FR17): On the lot detail page (Story 1.11), when the viewer is `office_staff` or `admin` AND the lot currently has an open ownership row (i.e. an owner), a "Record transfer" button opens a shadcn/ui `Dialog`. The Dialog contains: transfer-type Select (sale / inheritance / gift / court order), destination-customer picker (reuses Story 2.1's customer search pattern or a new `CustomerPicker` component if not present), required-document checklist (one row per item from `TRANSFER_DOC_REQUIREMENTS[transferType]`, each with an `AttachmentUploadField` from Story 2.2 wired to the destination customer), effective date input (default today Manila tz; pastes are allowed → triggers the backdated-flag UI), backdated-reason Textarea (shown only when `effectiveDate < startOfTodayManila`), notes Textarea (optional). Submit is disabled until every `required: true` document has a matching attachment ID. On submit, a confirmation preview modal summarizes the action ("Transfer Lot D-5-12 from Mrs. Cruz to Mr. Garcia, type: Inheritance, effective 17 Mar 2026; 2 documents attached. This will close the previous ownership.") with a Confirm button that calls `recordTransfer`.

5. **AC5 — Backdated transfers are permitted but require an actor reason** (legacy data migration, §10 Q4): If `effectiveDate < startOfTodayManila`, the UI renders a yellow `Alert` "This is a backdated transfer (effective {date}). Provide a reason." and the required `actorReason` Textarea below. The server-side mutation validates `actorReason.length >= 10` when `effectiveDate < Date.now() - 24 * HOUR_MS`. The audit `reason` carries the backdating explanation. Tests cover the backdated-without-reason rejection path.

## Tasks / Subtasks

### Schema (AC1)

- [ ] **Task 1: Add `transferEvents` table to `convex/schema.ts`** (AC: 1)
  - [ ] Definition (see AC1 for fields). Two indexes: `by_lot_effective`, `by_to_customer`.
  - [ ] **Ownerships table coordination:** Story 2.5 may have scaffolded the `ownerships` table with `transferEventId: v.optional(v.id("transferEvents"))`. If so, this story's only change is adding `transferEvents`. If 2.5's scaffolding is missing `transferEventId`, add it here. Verify `_generated/dataModel.d.ts` is consistent.
  - [ ] **Note: the `ownerships.transferEventId` is OPTIONAL.** Initial ownership (the first sale via Epic 3) may not have a `transferEvent` because the sale itself IS the initial transfer; or it may have a `transferEvent` with `transferType: "initial"`. The design accepts both; document in the table JSDoc.

- [ ] **Task 2: Update `convex/lib/errors.ts`** (AC: 3, AC: 5)
  - [ ] Add: `NO_CURRENT_OWNERSHIP: "NO_CURRENT_OWNERSHIP"` (used when transferring a lot with no open ownership row), `REQUIRED_DOC_MISSING: "REQUIRED_DOC_MISSING"`, `BACKDATED_REASON_REQUIRED: "BACKDATED_REASON_REQUIRED"`.

### Policy-defaults table (AC2)

- [ ] **Task 3: Create `convex/lib/transferDocRequirements.ts`** (AC: 2)
  - [ ] Export `TRANSFER_DOC_REQUIREMENTS` per AC2.
  - [ ] Export `DocType` union literal: `"deed_of_sale" | "affidavit_of_self_adjudication" | "death_certificate" | "deed_of_donation" | "court_order" | "other"`.
  - [ ] Export `RequiredDocSpec` type: `{ docType: DocType, label: string, required: boolean }`.
  - [ ] **File-level JSDoc with a giant warning banner**:
    ```ts
    /**
     * ⚠️ POLICY PENDING (§10 Q6) — These document requirements are PLACEHOLDERS
     * until the client confirms the transfer policy. When confirmed:
     *   1. Update this table to match.
     *   2. Update Story 2.7's UI banner.
     *   3. Run the unit tests in tests/unit/convex/transferDocRequirements.test.ts
     *      — they enforce that every transferType has at least one entry.
     * No schema migration required; this is configuration only.
     */
    ```
  - [ ] **Why a separate module rather than inline in `ownerships.ts`?** Three reasons: (a) the table is shared between client (UI checklist) and server (validation); (b) it is the single edit point for the §10 Q6 resolution; (c) clean import boundaries — `src/components/RecordTransferDialog/` can import directly from `convex/lib/transferDocRequirements.ts` via the path alias.

### Backend mutation (AC3, AC5)

- [ ] **Task 4: Implement `convex/ownerships.ts → recordTransfer` mutation** (AC: 3, AC: 5)
  - [ ] **`ownerships.ts` already exists** from Story 2.5 (`listByCustomer` query). Extend it with the new mutation. If Story 2.5 has NOT yet shipped, create the file with both the query and this mutation.
  - [ ] First line: `await requireRole(ctx, ["office_staff", "admin"]);`. Story 1.2 lint rule enforces.
  - [ ] Args validator: `v.object({ lotId: v.id("lots"), toCustomerId: v.id("customers"), transferType: v.union(v.literal("sale"), v.literal("inheritance"), v.literal("gift"), v.literal("court_order")), effectiveDate: v.number(), requiredDocsAttached: v.array(v.id("customerAttachments")), notes: v.optional(v.string()), actorReason: v.string() })`.
  - [ ] Zod re-validation:
    - `effectiveDate` is a positive integer.
    - `actorReason.trim().length >= 3 && <= 500`.
    - If `effectiveDate < Date.now() - 24 * HOUR_MS` (backdated > 1 day) → require `actorReason.trim().length >= 10`. Else throw `BACKDATED_REASON_REQUIRED`.
  - [ ] Load `toCustomer = ctx.db.get(toCustomerId)`. If missing → `CUSTOMER_NOT_FOUND`.
  - [ ] Load `lot = ctx.db.get(lotId)`. If missing → `LOT_NOT_FOUND`. If `lot.isRetired` → `LOT_RETIRED`.
  - [ ] Find the current open ownership row: `await ctx.db.query("ownerships").withIndex("by_lot_effective", q => q.eq("lotId", lotId)).order("desc").first()`. If none or `currentOwnership.effectiveTo !== undefined` → throw `NO_CURRENT_OWNERSHIP, "This lot has no current owner to transfer from. Use the Sales flow (Epic 3) for initial ownership."`.
  - [ ] Reject self-transfer: if `currentOwnership.customerId === toCustomerId` → throw `INVALID_TRANSFER, "Cannot transfer ownership to the current owner."` (add this code to errors.ts).
  - [ ] Validate required documents: load `spec = TRANSFER_DOC_REQUIREMENTS[transferType]`. For each `requiredDoc` in `spec.filter(s => s.required)`, verify at least one `customerAttachments` row with `customerId === toCustomerId` AND `attachmentType` matching the required doc type exists in `requiredDocsAttached`. If any missing → `REQUIRED_DOC_MISSING, "Missing required document: <label>"`. (The UI gates submit; the server is defense-in-depth.)
  - [ ] **Atomic write block**:
    1. `await ctx.db.patch(currentOwnership._id, { effectiveTo: effectiveDate });`
    2. `const transferEventId = await ctx.db.insert("transferEvents", { lotId, fromCustomerId: currentOwnership.customerId, toCustomerId, transferType, effectiveDate, requiredDocsAttached, notes, recordedAt: Date.now(), recordedByUserId: userId, actorReason: actorReason.trim() });`
    3. `const newOwnershipId = await ctx.db.insert("ownerships", { lotId, customerId: toCustomerId, effectiveFrom: effectiveDate, effectiveTo: undefined, transferType, transferEventId });`
    4. `await emitAudit(ctx, { action: "ownership.transfer", entityType: "lot", entityId: lotId, before: { ownerCustomerId: currentOwnership.customerId }, after: { ownerCustomerId: toCustomerId, transferType, effectiveDate }, reason: actorReason.trim() });`
  - [ ] Return `{ transferEventId, newOwnershipId }`.
  - [ ] **Important note on `assertTransition`:** Story 1.7's `assertTransition` is for state-machine transitions (lot status, contract state). A transfer **does not change the lot's status** in the current design (lot stays `sold` or `occupied`). Do NOT call `assertTransition` here. If §10 Q6 specifies that certain transfer types change the lot status (e.g. inheritance → status briefly to `reserved` pending probate), add the `assertTransition` call then.

- [ ] **Task 5: `convex/transferEvents.ts → listByLot` query** (supports Story 2.5 ownership history rendering)
  - [ ] First line: `await requireRole(ctx, ["office_staff", "admin"]);`.
  - [ ] Args: `{ lotId: v.id("lots") }`.
  - [ ] Query `transferEvents` by `by_lot_effective` index. Return rows with `{ transferEventId, transferType, fromCustomerId, toCustomerId, effectiveDate, recordedAt, recordedByUserId, notes }`.
  - [ ] **Why a separate file?** `convex/transferEvents.ts` is the canonical query home for the transfer-event read API; Story 2.5's `ownerships.listByCustomer` is the ownership-history read API. Keep them separate per the per-domain-file convention (architecture § 442).

### Frontend Dialog + supporting components (AC4, AC5)

- [ ] **Task 6: Build `src/components/RecordTransferDialog/RecordTransferDialog.tsx`** (AC: 4)
  - [ ] Props: `lotId: Id<"lots">`, `currentOwnerCustomerId: Id<"customers">`, `currentOwnerName: string`, `open: boolean`, `onOpenChange: (open: boolean) => void`, `onTransferred?: ({ transferEventId, newOwnershipId }) => void`.
  - [ ] Wraps shadcn/ui `Dialog`. Form via RHF + Zod (`transferSchema.ts` shared with server validation).
  - [ ] Layout: vertical form with sections — Transfer Type, Destination Customer, Required Documents (dynamic per type), Effective Date, Backdated Reason (conditional), Notes, Confirm.
  - [ ] **Policy-pending banner** (top of Dialog body): a yellow `Alert` "Required documents per transfer type are pending client confirmation (open question §10 Q6). Current defaults shown." — uses `variant="warning"` from shadcn/ui (or a Tailwind `bg-yellow-50 border-yellow-200 text-yellow-900` block if no variant exists).
  - [ ] **Transfer type Select**: 4 options (sale / inheritance / gift / court order). On change → the required-documents section re-renders to match `TRANSFER_DOC_REQUIREMENTS[selectedType]`.
  - [ ] **Destination customer picker**: use a thin wrapper around Story 2.1's `customers.searchByName` query. Mount as a popover-search-input pattern; on select, populate `toCustomerId` + display the selected customer's full name + last-4. Add an "or [Create new customer]" link that opens Story 2.1's `CustomerForm` inline (similar to the Journey 1 inline-create pattern). If the inline-create isn't feasible in this story's scope, link to `/customers/new` and instruct the user to return after.
  - [ ] **Required-documents section**: one row per `RequiredDocSpec`. Each row: label + `AttachmentUploadField` (Story 2.2) configured with `customerId={toCustomerId}` + `attachmentType={spec.docType}`. The form tracks the resulting `attachmentId` per row. Submit gating: every `required: true` row must have an attachment ID. **The upload happens BEFORE the transfer mutation runs** (per Story 2.2's pattern); the transfer mutation references the existing attachment IDs.
  - [ ] **Effective date input**: native `<input type="date">` defaulting to today (Manila tz via `src/lib/time.ts`). On change, check if `< startOfTodayManila` → reveal the backdated reason field.
  - [ ] **Backdated reason Textarea**: hidden by default; shown when effectiveDate is in the past. Label: "Reason for backdating (required by audit log)". Min 10 chars.
  - [ ] **Notes Textarea**: optional, max 1000.
  - [ ] **Confirm step**: Submit button labelled "Review transfer". On click, show a summary screen (a sub-page within the Dialog using `useState`'s `step` flag, or a second nested Dialog — keep it simple, use the same Dialog with two slides controlled by local state). The summary shows: "Transfer Lot {lotCode} from {fromName} to {toName}, type: {transferType}, effective {date}; {N} documents attached. This will close the previous ownership row and open a new one." Two buttons: Back (returns to form) and Confirm transfer (calls `recordTransfer`).
  - [ ] On success: call `onTransferred?.(...)`, close the Dialog, RHF `reset()`. Show a toast / banner on the host page "Transfer recorded successfully" (using whatever toast pattern Story 1.4 / 1.5 established; if no pattern exists yet, log to console for now and surface via the reactively-updating ownership history).
  - [ ] On error: surface via `translateError`; inline message at the bottom of the Dialog. Stay on the summary slide.

- [ ] **Task 7: Build `src/components/RecordTransferDialog/CustomerPicker.tsx`** (AC: 4)
  - [ ] If a generic `CustomerPicker` doesn't yet exist in the repo, build a thin one here. It is the only new file beyond the Dialog.
  - [ ] Pattern: shadcn/ui `Popover` + `Command` (cmdk-based search). On open, focus the input. Debounced query call to `customers.searchByName` (Story 2.1). Returns rows showing `{fullName} (gov ID ***-***-{last4})`. On select, fire `onSelect({ customerId, fullName })`.
  - [ ] **Why a dedicated component here?** Story 3.x sale flow will also need this picker. Keeping it in `src/components/RecordTransferDialog/` is wrong long-term; **place it at `src/components/CustomerPicker/CustomerPicker.tsx`** instead. Story 3.x will reuse.

- [ ] **Task 8: Wire "Record transfer" button into the lot detail page** (AC: 4)
  - [ ] In `src/app/(staff)/lots/[lotId]/page.tsx` (Story 1.11 or 2.5's edits), add a "Record transfer" button visible only when:
    - viewer role is `office_staff` or `admin`
    - the lot has a current open ownership row (read via `useQuery(api.ownerships.listByLot, { lotId })` — a new query needed in `convex/ownerships.ts`; thin wrapper around the existing index pattern)
  - [ ] Button opens the `RecordTransferDialog`.

### Testing (AC1, AC2, AC3, AC4, AC5)

- [ ] **Task 9: Unit tests for `recordTransfer`** (AC: 3, AC: 5)
  - [ ] Create `tests/unit/convex/ownerships.test.ts` (or extend if Story 2.5 created it).
  - [ ] Cases (via `convex-test` harness):
    - **Happy path — sale today**: seed lot + customer + current ownership + a `deed_of_sale` attachment. Call mutation. Assert: previous ownership patched with `effectiveTo`, new ownership inserted, transferEvent inserted, audit emitted. All four writes present.
    - **Happy path — inheritance with 2 docs**: seed two attachments (`affidavit_of_self_adjudication`, `death_certificate`); transfer succeeds.
    - **Missing required doc**: inheritance with only one doc → `REQUIRED_DOC_MISSING`. Previous ownership NOT patched (atomicity: the whole mutation rolled back).
    - **Backdated with sufficient reason**: `effectiveDate = today - 30 days`, `actorReason: "Legacy data migration from 2018 paper ledger entry"` → success.
    - **Backdated without sufficient reason**: same dates, `actorReason: "x"` → `BACKDATED_REASON_REQUIRED`.
    - **Self-transfer**: `toCustomerId === currentOwnership.customerId` → `INVALID_TRANSFER`.
    - **No current ownership**: lot has never been sold → `NO_CURRENT_OWNERSHIP`.
    - **Retired lot**: `lot.isRetired === true` → `LOT_RETIRED`.
    - **RBAC**: field_worker → `FORBIDDEN`.
    - **Audit**: verify the audit row's `entityId === lotId`, `action === "ownership.transfer"`, `reason === actorReason`.
  - [ ] Coverage target: ≥ 90% line + branch (this is a multi-doc atomic mutation; treat as financial-adjacent per NFR-M2).

- [ ] **Task 10: Unit tests for `TRANSFER_DOC_REQUIREMENTS`** (AC: 2)
  - [ ] Create `tests/unit/convex/transferDocRequirements.test.ts`.
  - [ ] Cases:
    - Every key in `TransferType` union has at least one entry in the requirements table (this catches a future §10 Q6 update where someone forgets a type).
    - `initial` is the only type with an empty requirement list.
    - Each entry's `docType` is a valid `AttachmentType` literal from Story 2.2's `customerAttachments` schema (catches drift between the two modules).

- [ ] **Task 11: Component test for `RecordTransferDialog`** (AC: 4, AC: 5)
  - [ ] Create `src/components/RecordTransferDialog/RecordTransferDialog.test.tsx`.
  - [ ] Cases (Testing Library + mocked Convex client):
    - **Render**: opens with the policy-pending banner, transfer type Select.
    - **Type change updates checklist**: select "Inheritance" → 2 doc rows render.
    - **Submit gating**: with 1 of 2 required docs uploaded → submit disabled.
    - **Backdated reason appears**: change effective date to 30 days ago → backdated reason field appears + required.
    - **Confirm step**: fill form fully → click "Review" → summary slide renders with computed labels.
    - **Successful submit**: mock mutation resolves → Dialog closes, `onTransferred` called.
    - **Error path**: mock mutation throws `REQUIRED_DOC_MISSING` → inline error on the summary slide; stays open.

- [ ] **Task 12: E2E spec** (AC: 4)
  - [ ] `tests/e2e/transfer-record.spec.ts`: log in as office_staff; navigate to a seeded lot with a current owner; click "Record transfer"; select inheritance type; pick destination customer; upload two attachments via the in-Dialog upload fields; submit and confirm; assert the ownership history list (Story 2.5) now shows the new owner at the top and the previous owner with an `effectiveTo` date.
  - [ ] Cover the backdated path in a second spec or expand the first one: change effective date to 30 days ago → fill reason → submit succeeds.

### Documentation (AC1, AC2, AC3)

- [ ] **Task 13: JSDoc + section comment in code** (AC: all)
  - [ ] File-level JSDoc on `convex/ownerships.ts` summarizing time-versioning semantics + the atomic-transfer contract.
  - [ ] File-level JSDoc on `convex/lib/transferDocRequirements.ts` per Task 3.
  - [ ] No ADR — the time-versioning pattern is locked by architecture § 232; this story is the implementation. If §10 Q6's answer differs materially from the placeholders, that resolution gets its own ADR-000X documenting the per-type requirements.

- [ ] **Task 14: Update `docs/data-migration-plan.md`** (AC: 5)
  - [ ] Add a section "Legacy ownership transfers (§10 Q4)": migration agents can run `recordTransfer` for each historical transfer in the old ledger, providing `actorReason: "Legacy migration from <ledger entry>"` and the historical `effectiveDate`. The mutation accepts backdated dates with the explicit reason.
  - [ ] If `docs/data-migration-plan.md` doesn't yet exist (architecture § 834 references it), this story creates it with this section as the seed.

## Dev Notes

### Previous story intelligence

**Stories that must be implemented before this one:**

- **Story 1.1 (auth + scaffold)** — `(staff)/` route group.
- **Story 1.2 (`requireRole` + lint rule + error codes)** — every new mutation/query begins with `requireRole`.
- **Story 1.4 (StatusPill + ReactiveHighlight + form patterns)** — Dialog patterns reuse the established UI primitives.
- **Story 1.6 (`emitAudit`)** — every write in this story emits audit; the transfer mutation emits one audit row covering all four writes.
- **Story 1.7 (state machines)** — NOT called from `recordTransfer` in this story (transfer doesn't change lot status). Available if §10 Q6 mandates a status change.
- **Story 1.8 (lots table + isRetired)** — the mutation reads `lot.isRetired` to reject transfers on retired lots.
- **Story 2.1 (`customers` table + search)** — `CustomerPicker` consumes `customers.searchByName`.
- **Story 2.2 (`customerAttachments` + `AttachmentUploadField`)** — the Dialog's required-documents section uses this component. Attachments are uploaded BEFORE the transfer mutation runs.
- **Story 2.3 (`readPii`)** — not directly used by this story (transfer doesn't read PII), but the dialog displays the to-customer's name + gov-ID last-4 via Story 2.5's existing PII patterns.
- **Story 2.5 (customer detail page + `ownerships` table scaffold + `ownerships.listByCustomer` query + `OwnershipHistoryList`)** — this story extends `convex/ownerships.ts` with the mutation. After this story ships, 2.5's ownership history list shows transfers correctly.
- **Story 2.6 (occupants)** — independent; transfers do NOT touch occupants.

**Stories that build on this one:**

- **Future Story 12.x (Phase 2 audit-log UI)** — the `ownership.transfer` audit rows produced here will be browsable.
- **Story 6.3 / 6.4 (Reports)** — transfer events become a queryable data source for "transfers in period X" reports.

### Architecture compliance

- **Time-versioned relations (architecture § 232):** the canonical pattern. Previous ownership is closed with `effectiveTo`; a new ownership row opens with `effectiveFrom`. No mutation of existing rows beyond setting `effectiveTo`.
- **Atomic multi-document writes (architecture § 302; brief §7):** all four writes (patch + 2 inserts + audit) happen in one mutation. Convex's per-mutation atomicity is the guarantee.
- **File location (architecture § 442, § 675):** `convex/ownerships.ts` (existing from Story 2.5). Adding a new file `convex/transferEvents.ts` for the read queries keeps the per-domain pattern. The doc-requirements table lives in `convex/lib/` (helper convention).
- **Naming patterns (architecture § 386):** `transferEvents` (camelCase plural), `transferEventId` foreign key on ownerships, `fromCustomerId` / `toCustomerId` for the two-sided relationship.
- **Component structure (architecture § 750):** `src/components/RecordTransferDialog/` for the composite; `src/components/CustomerPicker/` for the reusable picker.

### Library / framework versions (researched current)

- **No new dependencies.** Reuses RHF + Zod + shadcn/ui (Dialog, Select, Alert, Popover, Command) + Convex hooks. If the `cmdk`-based `Command` primitive isn't installed yet, `npx shadcn@latest add command`.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                            # UPDATE (add transferEvents; ensure ownerships.transferEventId present)
│   ├── ownerships.ts                                        # UPDATE (add recordTransfer mutation + listByLot query)
│   ├── transferEvents.ts                                    # NEW (listByLot query)
│   ├── lib/
│   │   ├── errors.ts                                        # UPDATE (NO_CURRENT_OWNERSHIP, REQUIRED_DOC_MISSING, BACKDATED_REASON_REQUIRED, INVALID_TRANSFER)
│   │   └── transferDocRequirements.ts                       # NEW (policy-defaults table + warning banner)
├── src/
│   ├── app/(staff)/lots/[lotId]/page.tsx                    # UPDATE (mount "Record transfer" button + Dialog)
│   └── components/
│       ├── RecordTransferDialog/
│       │   ├── RecordTransferDialog.tsx                     # NEW
│       │   ├── RecordTransferDialog.test.tsx                # NEW
│       │   └── transferSchema.ts                            # NEW (Zod schema shared client + server)
│       └── CustomerPicker/
│           └── CustomerPicker.tsx                           # NEW (reusable; Story 3.x sale flow also consumes)
├── tests/
│   ├── unit/convex/
│   │   ├── ownerships.test.ts                               # UPDATE (recordTransfer cases)
│   │   └── transferDocRequirements.test.ts                  # NEW
│   └── e2e/
│       └── transfer-record.spec.ts                          # NEW
├── docs/
│   └── data-migration-plan.md                               # UPDATE / NEW (legacy ownership migration section)
└── _bmad-output/implementation-artifacts/                   # this story file
```

### Testing requirements

- **NFR-M2 coverage**: ≥ 90% on `convex/ownerships.ts:recordTransfer`. Multi-doc atomic mutations are the kind that fail silently without thorough tests.
- **Atomicity test**: in the "missing required doc" case, the previous ownership must NOT be patched. Verify via `ctx.db.get(currentOwnershipId)` after the failed mutation — `effectiveTo` should still be `undefined`. Convex's mutation atomicity makes this true automatically, but the test pins the invariant.
- **Backdated edge**: test exactly at the `Date.now() - 24 * HOUR_MS` boundary — the threshold for "needs longer reason." Off-by-one is easy.

### Source references

- **PRD:** [FR17 (record ownership transfer)](../../_bmad-output/planning-artifacts/prd.md#functional-requirements), [§ Domain Notes (line 288)](../../_bmad-output/planning-artifacts/prd.md#domain-notes) (transfer types + documentation), [§10 Q6](../../_bmad-output/planning-artifacts/prd.md#open-questions) (transfer policy)
- **Architecture:** [§ Time-versioned relations (line 232)](../../_bmad-output/planning-artifacts/architecture.md#data-storage--persistence); [§ Schema illustration with ownerships (line 265)](../../_bmad-output/planning-artifacts/architecture.md#data-storage--persistence); [§ Atomic mutation pattern (line 302)](../../_bmad-output/planning-artifacts/architecture.md#api--communication-patterns)
- **UX:** [§ Form Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#form-patterns); [§ Confirmation Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#confirmation-patterns) (multi-step Dialog confirm)
- **Epics:** [§ Story 2.7](../../_bmad-output/planning-artifacts/epics.md#story-27-office-staff-records-ownership-transfer)
- **Previous stories:** [1.6](./1-6-audit-log-emission-helper.md) (audit), [1.7](./1-7-state-machine-transition-guards.md) (assertTransition; not called here), [1.8](./1-8-office-staff-creates-and-edits-lot-records.md) (lots + isRetired), [2.1](./2-1-office-staff-creates-a-customer-record.md) (customers + search), [2.2](./2-2-office-staff-uploads-identification-documents.md) (attachments + AttachmentUploadField), [2.5](./2-5-customer-detail-page-with-ownership-history.md) (ownerships scaffold + listByCustomer)
- Convex docs: [Mutations + atomicity](https://docs.convex.dev/functions/mutation-functions) · [Indexes](https://docs.convex.dev/database/indexes/)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT split the atomic write across multiple mutations.** All four writes (patch previous ownership + insert new ownership + insert transfer event + emit audit) must be in ONE Convex mutation. Splitting risks half-state if a later mutation fails (e.g. new ownership inserted but previous never closed → lot now has two open ownerships, which violates the time-versioning invariant).
- ❌ **Do NOT modify the lot's status as part of this mutation.** Transfer does not change lot status in the current design. If §10 Q6's answer mandates a status change, add the `assertTransition` call then with an explicit ADR.
- ❌ **Do NOT use a DB constraint to prevent two open ownerships.** Convex has no such constraint. Enforce in code via the `NO_CURRENT_OWNERSHIP` check + the atomic patch-then-insert sequence. Test the invariant explicitly.
- ❌ **Do NOT hard-code the document requirements inside `recordTransfer`.** Use `TRANSFER_DOC_REQUIREMENTS` from the module. The point of the indirection is that §10 Q6 resolution edits one file, not five.
- ❌ **Do NOT bypass the upload-first sequence.** Attachments must be uploaded (Story 2.2) BEFORE `recordTransfer` runs. The transfer mutation references existing `attachmentId` values; it does not upload files itself. The UI flow gates submit on completed uploads.
- ❌ **Do NOT allow office_staff to delete a recorded transfer.** Recorded transfers are immutable for audit purposes. Corrections happen via a NEW transfer event (e.g. a "court_order" reversing a prior transfer) — never via mutation/delete on the prior row. If a correction workflow is needed, that's a Phase 2 story with its own ADR.
- ❌ **Do NOT auto-populate `actorReason` with "Backdated transfer".** The audit log needs the operator's own words. The UI's backdated reason field is required to be user-typed (RHF validates the textarea is non-empty).
- ❌ **Do NOT show the destination customer's full gov-ID in the Dialog.** Only `***-***-{last4}` per Story 2.1's search-results pattern + UX §1879. The transfer flow should not be a backdoor to full PII display.
- ❌ **Do NOT let the Dialog stay open after a successful mutation.** Close on success; the host page reactively shows the new ownership row. Leaving the Dialog open invites a confused re-submit.
- ❌ **Do NOT throw a generic `Error` for missing required docs.** Use `ConvexError({ code: "REQUIRED_DOC_MISSING", missing: ["Death certificate"] })` — the structured payload lets the UI surface which doc is missing.

### Common LLM-developer mistakes to prevent

- **Reinventing time-versioning:** the pattern is patch `effectiveTo` + insert new row. Do NOT delete the previous ownership row. Do NOT update its `customerId` in place. History is preserved by retaining the old row with its closed date range.
- **Wrong index for the "find current ownership" lookup:** use `by_lot_effective` ordered descending + `.first()`. Filtering all ownerships and picking the open one in JS is a table scan.
- **Confusion between `transferEvents` and `ownerships`:** they are two tables with linked rows. The transfer event captures the AUDIT-grade transfer metadata (type, docs, reason, who-recorded); the ownership rows capture the TIME-VERSIONED ownership state. Both are needed for FR16's history-rendering + FR17's transfer-recording.
- **Wrong UI gating logic:** the submit button is disabled when ANY required document is missing, OR when the form has Zod validation errors, OR when the mutation is in flight. Triple-AND. Easy to miss one.
- **Missing the §10 Q6 banner:** the UX-DR23 calm-aesthetic must NOT hide the policy-pending state. The banner is visible at all times on the Dialog. When §10 Q6 resolves, remove the banner in the same commit as the table update.
- **Wrong `ownerships.transferType` value for the initial sale:** Epic 3's sale flow creates the FIRST ownership with `transferType: "initial"`. This story's flow creates subsequent ownerships with one of `sale | inheritance | gift | court_order`. The union supports both.
- **Async / event handler errors:** make sure each step (upload, then transfer) await chains correctly. The user can navigate away mid-upload — handle Promise rejection gracefully + reset Dialog state.
- **Forgetting to invalidate the ownership list cache:** Convex's reactive `useQuery` auto-invalidates when underlying data changes. **You do not need to manually invalidate.** Trust the Convex subscription.

### Open questions / blockers this story does NOT resolve

- **§10 Q6 (Ownership transfer policy):** **THIS STORY IS GATED.** Default placeholders ship; the banner declares the gating. When the client confirms, edit `convex/lib/transferDocRequirements.ts`, update the banner copy, re-run unit tests. No schema migration.
- **§10 Q4 (Legacy data):** **directly relevant** — backdated transfers + `actorReason` are the migration path. Documented in `docs/data-migration-plan.md`.
- **§10 Q1, Q2, Q3:** unrelated.

### Project Structure Notes

Aligns with:
- [Architecture § Project Structure & Boundaries > Complete Project Directory Structure](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure) — `convex/ownerships.ts` (§ 675), `convex/transferEvents.ts` (not explicitly listed; follows per-domain convention), `src/components/RecordTransferDialog/` (§ 750 composite pattern), `src/components/CustomerPicker/` (new shared component for Epic 3 reuse).
- [Architecture § API & Communication Patterns > Atomic mutation pattern](../../_bmad-output/planning-artifacts/architecture.md#api--communication-patterns) — the four-write atomic mutation matches the documented pattern.

No detected conflicts.

### References

- [PRD § Functional Requirements > FR17](../../_bmad-output/planning-artifacts/prd.md#4-customer--ownership-management)
- [PRD § Open Questions > §10 Q6](../../_bmad-output/planning-artifacts/prd.md#open-questions)
- [Architecture § Data Storage & Persistence](../../_bmad-output/planning-artifacts/architecture.md#data-storage--persistence)
- [Architecture § API & Communication Patterns > Atomic mutation pattern](../../_bmad-output/planning-artifacts/architecture.md#api--communication-patterns)
- [UX § Form Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#form-patterns)
- [Epics § Story 2.7](../../_bmad-output/planning-artifacts/epics.md#story-27-office-staff-records-ownership-transfer)
- Previous stories: [1.6](./1-6-audit-log-emission-helper.md), [1.7](./1-7-state-machine-transition-guards.md), [1.8](./1-8-office-staff-creates-and-edits-lot-records.md), [2.1](./2-1-office-staff-creates-a-customer-record.md), [2.2](./2-2-office-staff-uploads-identification-documents.md), [2.5](./2-5-customer-detail-page-with-ownership-history.md)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (claude-opus-4-7) via Claude Code.

### Debug Log References

- `npm run typecheck` — green.
- `npm run lint` — green (`No ESLint warnings or errors`).
- `npm run test` — 1445 passed, 1 pre-existing skip. New tests:
  `tests/unit/convex/ownerships-transfer.test.ts` (29 cases) and
  `tests/unit/components/OwnershipTransferForm.test.tsx` (10 cases).
- `npm run build` — green; `/customers/[customerId]/transfer` route
  registered.

### Completion Notes List

This pass implements the **orchestrator-scoped** version of Story 2.7
— the atomic ownership-transfer mutation + a multi-step form +
tests + route. The orchestrator restricted `convex/lib/**`,
`convex/schema.ts`, and other `convex/**/*.ts` to read-only, so the
story's larger scope (new `transferEvents` table, per-transfer-type
required-document checklist, `convex/lib/transferDocRequirements.ts`,
new error codes) was deferred and is called out below. The minimum-
viable atomic transfer ships today.

Deviations from the original story plan, with rationale:

1. **No `transferEvents` table.** The schema constraint forbade
   modifying `convex/schema.ts`. The ownership-transfer audit trail
   is captured via the existing `auditLog` row (`action: "transfer"`,
   `entityType: "ownership"`) which carries the from/to customer ids,
   transfer type, effective date, and the operator's reason. The
   `transferEvents` table can be added in a follow-up PR if the
   richer documentation metadata becomes a real requirement once §10
   Q6 resolves.
2. **No `convex/lib/transferDocRequirements.ts`.** Same reason —
   `convex/lib/**` was read-only. The form surfaces a yellow
   "policy pending" banner explaining the gating; when §10 Q6
   resolves, the required-document gate lands as a separate story.
3. **No new error codes.** The mutation reuses the existing
   `VALIDATION`, `INVARIANT_VIOLATION`, and `NOT_FOUND` codes for
   every documented rejection (backdated-without-reason, self-
   transfer, missing customer, missing lot, retired lot, source-
   owner mismatch, no current ownership). The richer codes
   (`NO_CURRENT_OWNERSHIP`, `REQUIRED_DOC_MISSING`,
   `BACKDATED_REASON_REQUIRED`, `INVALID_TRANSFER`) listed in the
   story can be added in `convex/lib/errors.ts` later — the messages
   embedded in each `throwError(...)` call already disambiguate.
4. **Mutation arg shape narrowed.** The orchestrator's args were
   `{ fromCustomerId, toCustomerId, lotId, transferReason,
   transferDate }`. I added an OPTIONAL `transferType` (defaults to
   `"sale"`) so the form can record sale / inheritance / gift /
   court_order without a separate mutation.
5. **No `convex/transferEvents.ts` query file.** Out of scope for
   the orchestrator's minimum-viable cut; the existing
   `ownerships.listByCustomer` / `ownerships.listByLot` already
   power the history rendering with the closed-row + open-row
   pattern.
6. **CustomerPicker is inlined in OwnershipTransferForm.** Built as
   a section of the form rather than a separately-extractable
   component because the orchestrator scoped the work to the form
   itself. The pattern is identical to `CustomerForm`'s dedupe
   alert (debounced `customers:searchByName`, last-4 PII mask, etc.).
   Future Story 3.x sale-flow reuse will extract the picker.
7. **No `customer detail page → Transfer button` link.** The
   orchestrator listed `CustomerDetail.tsx` as a NOT-allowed file;
   I left the detail-page Link out and rely on direct URL navigation
   (`/customers/<customerId>/transfer`). A follow-up PR that owns
   `CustomerDetail` can add the visible affordance in one line.
8. **E2E spec is route-protection only.** Mirrors the existing
   `customer-create.spec.ts` pattern — the full round-trip needs
   seeded test users + a seeded lot, which is still a Phase-1
   follow-up across the codebase.

Atomic transfer contract — VERIFIED:
   - Patches the previous open ownership row with `effectiveTo`.
   - Inserts a new ownership row with `effectiveFrom = transferDate`,
     `effectiveTo = undefined`, the new customer, and the chosen
     transfer type.
   - Emits one `auditLog` row with `action: "transfer"`,
     `entityType: "ownership"`, the from/to customer ids in
     before/after, and the operator's reason.
   - All three writes happen in one mutation handler — Convex's per-
     mutation atomicity guarantees the closed-and-opened state is
     never half-applied to a concurrent reader.

Unit tests cover (29 cases): auth gating (5), happy path (7),
backdated reason (4), validation (5), invariant violations (4),
missing entities (2), atomicity (2). Component tests cover (10
cases): empty state, initial render, backdated alert visibility,
customer-picker rendering, customer selection, self-transfer guard,
Cancel button wiring.

### File List

Created:
- `src/components/OwnershipTransferForm/OwnershipTransferForm.tsx`
- `src/components/OwnershipTransferForm/schema.ts`
- `src/components/OwnershipTransferForm/index.ts`
- `src/app/(staff)/customers/[customerId]/transfer/page.tsx`
- `tests/unit/convex/ownerships-transfer.test.ts`
- `tests/unit/components/OwnershipTransferForm.test.tsx`
- `tests/e2e/ownership-transfer.spec.ts`

Modified:
- `convex/ownerships.ts` — appended `recordOwnershipTransfer`
  mutation, the `TRANSFER_REASON_MIN_LENGTH` /
  `TRANSFER_REASON_MAX_LENGTH` / `BACKDATED_REASON_MIN_LENGTH`
  constants, and the supporting type exports
  (`RecordOwnershipTransferArgs`, `RecordOwnershipTransferResult`).
