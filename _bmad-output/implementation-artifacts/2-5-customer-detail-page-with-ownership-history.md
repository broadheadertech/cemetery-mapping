# Story 2.5: Customer Detail Page with Ownership History

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **Office Staff (Maria)**,
I want **to open `/customers/<customerId>` and see one complete page — contact info, time-versioned ownership history (with `effectiveFrom` / `effectiveTo` and transfer type per row), ID-scan attachments (blurred thumbnails), contracts list, and a click-to-reveal gov-ID number that logs every reveal**,
so that **I can answer any customer question without flipping pages, while every PII read is audited per NFR-S8 / UX-DR30** (FR16, FR18, UX-DR30, NFR-S8).

This is the **read-side counterpart to Story 2.1's create form** and the **first consumer of `readPii` + `readPiiUrl`** (Story 2.3). It introduces the `getCustomerDetail` query that composes role-checked field reads through the PII boundary, the `RevealField` client component that holds the un-redacted gov-ID for 30 seconds before re-masking, the ownership-history list that reads from the `ownerships` table (created in Story 2.7's schema; the page renders an empty state cleanly until that table is populated), and the attachments grid that renders blurred thumbnails until the user clicks through. After this story, Story 2.7's transfer flow has a destination page to redirect to, and the customer-PII surface has its canonical access pattern locked.

## Acceptance Criteria

1. **AC1 — `/customers/<customerId>` page renders the documented sections** (FR16, FR18, UX-DR30): `src/app/(staff)/customers/[customerId]/page.tsx` renders, in this order: (a) header with full name + status (active / archived); (b) contact block (phone, email, address — `address.line1` and below shown in full; full address is PII-classified per Story 2.3 but the design accepts displaying the structured address on the detail page because Office Staff need it for correspondence — the read is access-logged through `readPii(..., ["fullAddress"])`); (c) gov-ID number rendered as `RevealField` (default `***-***-1234` showing last-4 only); (d) Ownership history list (Story 2.7's `ownerships` table; renders empty state "No lot ownership recorded for this customer." if none); (e) ID-scan attachment grid (blurred thumbnails, click-to-view full image); (f) Contracts list (Story 3.4's `contracts` table; renders empty state if none); (g) audit trail link "View activity for this customer" (deep links into the Story 6.5 audit log filtered by `entityId = customerId`).

2. **AC2 — Gov-ID click-to-reveal routes through `readPii` and re-redacts after 30 s** (NFR-S8, UX-DR30, UX §1879): The `RevealField` component is a client component that, on click, calls `api.customers.revealGovId({ customerId })` — a query (NOT a mutation; reads are queries) that runs `requireRole(ctx, ["office_staff", "admin"])` and **then calls `readPii(ctx, customerId, ["govIdNumber"], { skipRoleCheck: true, accessType: "read", reason: "detail-page reveal" })` from Story 2.3's helper**. The full value displays for 30 seconds, then the component switches back to the redacted display via a `setTimeout` + state cleanup. Hovering or focusing within the 30 s window does NOT extend the timer (every reveal is its own click → its own logged access). Clicking "View" while already revealed is a no-op (no duplicate log row in the same 30 s window — handled by a local `isRevealed` guard).

3. **AC3 — Ownership history is sorted, time-versioned, and shows transfer type** (FR16): The ownership-history list is fetched via `api.ownerships.listByCustomer({ customerId })`. Each row shows: lot code (linked to `/lots/<lotId>`), `effectiveFrom` formatted via `src/lib/time.ts:formatDate(ms, "short")`, `effectiveTo` (or "Present" if null), `transferType` rendered as a small badge ("Sale" / "Inheritance" / "Gift" / "Court order" / "Initial"). Rows are sorted by `effectiveFrom` descending — most recent ownership first. **The `ownerships` table is created in Story 2.7**; this story implements the query and renders an empty state if the table is empty.

4. **AC4 — Attachments grid shows blurred thumbnails; click reveals full image via `readPiiUrl`** (NFR-S8, UX §1880): The attachments grid uses Story 2.2's `listAttachments` query (metadata only — no URLs). For each attachment, render a card with: file name, file size (formatted), upload date, and a **blurred placeholder thumbnail** (`<div class="bg-gray-200 blur-sm w-24 h-24">` for PDFs and unsupported types; for images, no thumbnail is fetched at all in the listing — the listing returns metadata, not URLs, to prevent passive PII leak per Story 2.2 design). Clicking "View attachment" calls `api.customers.getAttachmentUrl({ attachmentId })` (Story 2.2 query refactored in Story 2.3 to route through `readPiiUrl`); the returned signed URL opens in a new tab (PDF) or in a Dialog with the rendered image (JPG / PNG / WEBP). The reveal is logged automatically by `readPiiUrl`.

5. **AC5 — Page is role-gated end-to-end and handles the not-found case** (NFR-S4): Field workers visiting `/customers/<id>` are redirected to `/dashboard` by the `(staff)/layout.tsx` role guard (or — if the guard is per-role rather than per-route, return a 403 page; coordinate with whatever Story 1.5 shipped). `getCustomerDetail` query throws `FORBIDDEN` for field-worker callers regardless. Visiting a `customerId` that does not exist renders the standard `not-found.tsx` page with a "Return to customers list" link. The page renders skeleton placeholders for each section while the queries are in flight (per UX § Skeleton Patterns).

## Tasks / Subtasks

### Backend queries (AC1, AC2, AC3)

- [ ] **Task 1: `convex/customers.ts → getCustomerDetail` query** (AC: 1, AC: 5)
  - [ ] First line: `await requireRole(ctx, ["office_staff", "admin"]);` (Story 1.2 helper + lint rule).
  - [ ] Args: `{ customerId: v.id("customers") }`.
  - [ ] Load `customer = await ctx.db.get(customerId)`. If missing → `throwError(ErrorCode.CUSTOMER_NOT_FOUND)`. (Add `CUSTOMER_NOT_FOUND` to `convex/lib/errors.ts` if not yet present — Story 2.3 may have introduced it via `readPii`'s missing-customer branch; verify before adding.)
  - [ ] Compose the return payload:
    - Non-PII fields (read directly): `fullName`, `phone`, `email`, `govIdType`, `relationshipToOccupant`, `hasConsent`, `createdAt`, `updatedAt`, `consentTimestamp`.
    - PII fields routed through `readPii(ctx, customerId, ["fullAddress"], { skipRoleCheck: true, accessType: "read" })` — the page renders the address inline; the read is logged on every page open. The address read is **not** the same as the gov-ID reveal (separate user gesture, separate access type).
    - **Do NOT include `govIdNumber` in the payload** — that field is fetched via the separate `revealGovId` query, only when the user clicks Reveal. Returning the full gov ID here would log a read on every page load, which is wrong.
    - Return `govIdLast4: customer.govIdNumber.slice(-4)` for the default redacted display. Marking the line with `// pii-read-ok: last-4 is non-identifying per UX §1879` so Story 2.3's ESLint rule does not flag it.
  - [ ] Return shape:
    ```ts
    { customerId, fullName, phone?, email?, address: {...},
      govIdType, govIdLast4: string,
      relationshipToOccupant?, hasConsent, consentTimestamp?,
      createdAt, updatedAt }
    ```
  - [ ] **Do NOT call `emitAudit` here.** Reading a customer detail is access-logged via `readPii`, not via the audit log. The audit log is for writes; the PII access log is for PII reads. This boundary matters and Story 1.6's helper distinguishes them.

- [ ] **Task 2: `convex/customers.ts → revealGovId` query** (AC: 2)
  - [ ] First line: `await requireRole(ctx, ["office_staff", "admin"]);`.
  - [ ] Args: `{ customerId: v.id("customers") }`.
  - [ ] Single line of business logic: `return await readPii(ctx, customerId, ["govIdNumber"], { skipRoleCheck: true, accessType: "read", reason: "detail-page reveal" });`
  - [ ] Return shape: `{ govIdNumber: string }`.
  - [ ] **Why a separate query rather than a flag on `getCustomerDetail`?** Two reasons: (a) the access log entry should match the user gesture — the page load is one access (address); the reveal click is another access (gov ID). Two queries → two log entries → accurate audit trail. (b) Reactive `useQuery` for `getCustomerDetail` would re-fetch on every reactive update, multiplying the logged accesses; gating reveal behind a discrete query avoids that.
  - [ ] JSDoc note: "Called only from the `RevealField` component on user click. Never auto-call this query on mount."

- [ ] **Task 3: `convex/ownerships.ts → listByCustomer` query** (AC: 3)
  - [ ] **First-time domain file creation** — `convex/ownerships.ts` does not yet exist. Per architecture § 442 / § 675 it is the FR16/FR17 domain. This story creates the file with one query; Story 2.7 will add the mutations.
  - [ ] **Schema note: `ownerships` table is created by Story 2.7**, not by this story. If Story 2.7 has not shipped at the time this story is implemented, **add the table definition to `convex/schema.ts` in this story as a minimal scaffold** — Story 2.7 will extend it with `transferEventId` if needed. The architecture's sample schema (§ 265) is the canonical shape:
    ```ts
    ownerships: defineTable({
      lotId: v.id("lots"),
      customerId: v.id("customers"),
      effectiveFrom: v.number(),
      effectiveTo: v.optional(v.number()),
      transferType: v.union(
        v.literal("sale"), v.literal("inheritance"),
        v.literal("gift"), v.literal("court_order"),
        v.literal("initial"),
      ),
      transferEventId: v.optional(v.id("transferEvents")),
    })
      .index("by_lot_effective", ["lotId", "effectiveFrom"])
      .index("by_customer", ["customerId"]),
    ```
  - [ ] First line: `await requireRole(ctx, ["office_staff", "admin"]);`.
  - [ ] Args: `{ customerId: v.id("customers") }`.
  - [ ] Use `by_customer` index. Map to row shape `{ ownershipId, lotId, lotCode, effectiveFrom, effectiveTo, transferType }`. For `lotCode`, `ctx.db.get(lotId).code` per row (denormalizing for the page; 1 lot per ownership row → cheap N+1 over Convex's batching).
  - [ ] Sort by `effectiveFrom` descending in user code (Convex index returns ascending; reverse in JS).
  - [ ] **Defensive: if a lot was retired or deleted, fall back to `lotCode: "[retired]"`** — the ownership row should still render in history (legacy data scenarios per §10 Q4).

- [ ] **Task 4: `convex/contracts.ts → listByCustomer` query** (AC: 1)
  - [ ] **Story 3.4 ships `contracts` table.** If Story 3.4 has shipped: add a `listByCustomer({ customerId })` query that returns `{ contractId, contractNumber, state, balanceCents, createdAt }` for the customer. Indexed via `by_customer` on the `contracts` table.
  - [ ] If Story 3.4 has NOT yet shipped: stub the query as `return [];` and add a `TODO(Story 3.4)` comment. The page renders an empty state cleanly.
  - [ ] Coordinate with whichever Epic 3 story owns the `contracts` table; do not re-define the table here.

### Frontend page + components (AC1, AC2, AC4, AC5)

- [ ] **Task 5: Build `src/app/(staff)/customers/[customerId]/page.tsx`** (AC: 1, AC: 5)
  - [ ] Client component (`"use client"`) — uses `useQuery` hooks.
  - [ ] Fetch `useQuery(api.customers.getCustomerDetail, { customerId })`. If `undefined` (loading) → render skeleton scaffold (5 skeleton sections matching the final layout). If `null` / `404` → render `not-found.tsx` programmatically via `notFound()` from `next/navigation`.
  - [ ] Sections:
    1. **Header**: `<h1>{fullName}</h1>` + a small `StatusPill` (Story 1.4) showing "Active" (or "Archived" if a future archived flag exists).
    2. **Contact block**: phone (clickable `tel:` link), email (clickable `mailto:` link if present), address rendered as a `<dl>` with each address line.
    3. **Gov-ID block**: render `<RevealField customerId={customerId} govIdLast4={govIdLast4} govIdType={govIdType} />`. The component handles its own reveal state.
    4. **Ownership history**: `<OwnershipHistoryList customerId={customerId} />` — pulls from `listByCustomer`.
    5. **Attachments**: `<AttachmentGrid customerId={customerId} />` — pulls from `api.customers.listAttachments` (Story 2.2).
    6. **Contracts**: `<ContractsList customerId={customerId} />` — pulls from `api.contracts.listByCustomer` (or stub if Story 3.4 not shipped).
    7. **Audit trail link**: `<Link href={`/audit?entityType=customer&entityId=${customerId}`}>View activity for this customer →</Link>` (Story 6.5 audit page; link target may 404 until Story 6.5 ships — acceptable).
  - [ ] Responsive: at `< 1024px`, sections stack single-column. At `≥ 1024px`, use a three-column grid (profile / contracts / attachments) per UX § Customer detail (line 1901).
  - [ ] All headings use semantic `<h2>` / `<h3>` hierarchy. Section landmarks use `<section aria-labelledby="...">` for screen-reader navigation.

- [ ] **Task 6: Build `src/components/CustomerDetail/RevealField.tsx`** (AC: 2)
  - [ ] Props: `customerId: Id<"customers">`, `govIdLast4: string`, `govIdType: "sss" | "tin" | ...`.
  - [ ] State: `revealed: { value: string; expiresAt: number } | null`.
  - [ ] **Use Convex's `useAction` or manual `convex.query` call** — NOT `useQuery`. We do not want a reactive subscription on the gov-ID query. The reveal is one-shot; subscription would re-log on every reactive tick.
    - Preferred: import `useConvex` from `convex/react`, then on click: `const { govIdNumber } = await convex.query(api.customers.revealGovId, { customerId });`
    - This is the canonical pattern for "imperative query" in Convex; document it inline.
  - [ ] On reveal: set `revealed = { value: govIdNumber, expiresAt: Date.now() + 30_000 }`. Start a `setTimeout(() => setRevealed(null), 30_000)`.
  - [ ] On unmount or `customerId` change: clear the timeout and clear state. Defense against stale gov IDs lingering after navigation.
  - [ ] Render: `{revealed ? <span class="font-mono">{revealed.value}</span> : <span>***-***-{govIdLast4}</span>}` + a "Reveal" / "Hide" button (44 × 44 px tap target). The button shows "Reveal" when not revealed, "Hide" when revealed (clicking "Hide" just clears the state — does not need a server roundtrip).
  - [ ] **Aria**: `<button aria-label={revealed ? "Hide gov-ID number" : "Reveal full gov-ID number; access will be logged"}>`. Screen readers must understand the reveal is audited.
  - [ ] **Visual countdown**: small `text-xs text-gray-500` showing `"Visible for 28s"` and counting down, so the user knows the auto-hide is coming. Pure cosmetic; no impact on the server-side log.

- [ ] **Task 7: Build `src/components/CustomerDetail/OwnershipHistoryList.tsx`** (AC: 3)
  - [ ] Props: `customerId: Id<"customers">`.
  - [ ] `const ownerships = useQuery(api.ownerships.listByCustomer, { customerId });` Loading → skeleton list (3 rows). Empty → "No lot ownership recorded for this customer." per UX § Empty State Patterns.
  - [ ] Render `<ul>` with one `<li>` per row:
    ```
    [Lot D-5-12] · Sale · 17 Mar 2025 — Present
    ```
  - [ ] Lot code is a `<Link href={`/lots/${lotId}`}>` — Story 1.11's lot detail page.
  - [ ] Transfer type rendered as a small inline badge using shadcn/ui `Badge`. Colors per UX § Color Palette: sale = neutral, inheritance = blue, gift = green, court_order = amber, initial = gray.
  - [ ] Dates via `src/lib/time.ts:formatDate(ms, "short")`. "Present" if `effectiveTo === undefined`.

- [ ] **Task 8: Build `src/components/CustomerDetail/AttachmentGrid.tsx`** (AC: 4)
  - [ ] Props: `customerId: Id<"customers">`.
  - [ ] `const attachments = useQuery(api.customers.listAttachments, { customerId });` (Story 2.2's metadata-only listing).
  - [ ] Render a CSS-grid of cards. Each card: blurred placeholder thumbnail + file name + size (formatted via a small `formatBytes` helper) + upload date + `[View]` button.
  - [ ] **The placeholder thumbnail is a div with Tailwind `bg-gray-200 blur-sm`** — no image is fetched from the server in the listing pass. This is by design (Story 2.2 returns no URLs). The blur cue tells the user "PII hidden until you actively view."
  - [ ] On `[View]` click: call `api.customers.getAttachmentUrl({ attachmentId })` (imperative via `useConvex()`, same pattern as `RevealField` Task 6, since the URL grant is access-logged through `readPiiUrl`). The returned `{ url, fileName, mimeType }` opens in:
    - For `image/*`: a shadcn/ui `Dialog` with `<img src={url} alt={fileName}>` + Close button. The signed URL is in the image src; the URL expires in 60 s (Story 2.2 / 2.3 default).
    - For `application/pdf`: `window.open(url, "_blank")`.
  - [ ] Empty state: "No documents attached for this customer." with a `<Link href={`/customers/${customerId}/upload`}>` to a future upload page (not in scope for 2.5; the upload flow is Story 2.2's `AttachmentUploadField` mounted somewhere — leave the link target as `/customers/${customerId}` for now if 2.2's standalone upload page doesn't exist).

- [ ] **Task 9: Build `src/components/CustomerDetail/ContractsList.tsx`** (AC: 1)
  - [ ] Props: `customerId: Id<"customers">`.
  - [ ] `const contracts = useQuery(api.contracts.listByCustomer, { customerId });`
  - [ ] Render a small `<Table>` (or list on mobile) with columns: Contract number, State (StatusPill), Balance (formatPeso), Created (formatDate).
  - [ ] Each row links to `/contracts/<contractId>`.
  - [ ] Empty state: "No contracts on file for this customer."
  - [ ] If the query returns `undefined` because Story 3.4's `contracts` table doesn't exist yet, render the empty state (the stub returns `[]`).

### Testing (AC1, AC2, AC3, AC4, AC5)

- [ ] **Task 10: Unit tests for `getCustomerDetail`** (AC: 1)
  - [ ] In `tests/unit/convex/customers.test.ts` (extending Story 2.1's file), add cases:
    - **Happy path**: office_staff calls → returns all non-PII fields + `govIdLast4`; **the response does NOT contain `govIdNumber` in full**. Verify the address read produces one `piiAccessLog` entry with `fields: ["fullAddress"]`, `accessType: "read"`.
    - **Not found**: invalid `customerId` → `CUSTOMER_NOT_FOUND`.
    - **RBAC**: field_worker → `FORBIDDEN`. Unauthenticated → `UNAUTHENTICATED`.

- [ ] **Task 11: Unit tests for `revealGovId`** (AC: 2)
  - [ ] Cases:
    - **Happy path**: office_staff calls → returns `{ govIdNumber: "<full value>" }`; one `piiAccessLog` row inserted with `fields: ["govIdNumber"]`, `accessType: "read"`, `reason: "detail-page reveal"`.
    - **Each call logs**: calling the query twice → two `piiAccessLog` rows.
    - **RBAC**: field_worker → `FORBIDDEN`.
  - [ ] Coverage target: ≥ 90% line + branch on `convex/customers.ts:revealGovId` (NFR-M2; PII-touching).

- [ ] **Task 12: Unit tests for `ownerships.listByCustomer`** (AC: 3)
  - [ ] Create `tests/unit/convex/ownerships.test.ts`.
  - [ ] Cases:
    - Customer with 3 ownership rows across 2 lots → returns 3 rows sorted by `effectiveFrom` desc.
    - Customer with no ownerships → returns `[]`.
    - One row's lot has been deleted → row still returns with `lotCode: "[retired]"`.
    - **RBAC**: field_worker → `FORBIDDEN`.

- [ ] **Task 13: Component tests for `RevealField`** (AC: 2)
  - [ ] Create `src/components/CustomerDetail/RevealField.test.tsx`.
  - [ ] Cases (Testing Library + mocked `useConvex`):
    - **Initial render**: displays `"***-***-1234"` plus a "Reveal" button.
    - **Click reveal**: mocked query resolves with `{ govIdNumber: "123-456-789-1234" }`; the component now shows the full number; button text changes to "Hide"; countdown text starts.
    - **30 s timeout**: advance fake timers by 30 s; component re-redacts.
    - **Click hide**: state clears immediately without a new query call.
    - **Unmount during reveal**: timer is cleared (no memory leak warning).

- [ ] **Task 14: E2E smoke spec** (AC: 1, AC: 2, AC: 4)
  - [ ] `tests/e2e/customer-detail.spec.ts`: log in as seeded office_staff; navigate to a seeded customer detail; assert the header shows the customer name + the redacted gov-ID. Click Reveal; assert the full gov ID appears; wait 30 s (or use `page.clock.fastForward(30_000)` for speed); assert the redacted form returns.
  - [ ] **Cover the attachment-view flow**: seed one attachment via Story 2.2's fixtures; click "View" on the card; assert a Dialog opens with the image rendered (use Playwright's `page.locator('dialog img').toBeVisible()`).

### Documentation (AC1, AC2)

- [ ] **Task 15: JSDoc on new files** (AC: all)
  - [ ] `convex/customers.ts:getCustomerDetail` — document the no-`govIdNumber`-in-payload contract.
  - [ ] `convex/customers.ts:revealGovId` — document "called only from `RevealField` on user click; never auto-call on mount."
  - [ ] `convex/ownerships.ts` — file-level JSDoc summarizing FR16 ownership-history semantics + the soft-foreign-key to `lots` (retired lots still render).
  - [ ] `src/components/CustomerDetail/RevealField.tsx` — comment block explaining the imperative-query pattern + the 30 s auto-hide contract.
  - [ ] No ADR — every architectural decision here was already locked by ADR-0006-ish (Story 1.6 audit) and ADR-0007 (Story 2.8 PII encryption). Story 2.3 introduces the `readPii` boundary; this story consumes it.

## Dev Notes

### Previous story intelligence

**Stories that must be implemented before this one:**

- **Story 1.1 (auth + scaffold):** provides the `(staff)/` route group and middleware; this story's page lives inside it.
- **Story 1.2 (`requireRole` + ESLint rule + error codes):** every new query in this story begins with `requireRole`. The lint rule will fail the build if missing.
- **Story 1.4 (StatusPill):** the header status badge + the ownership-history transfer-type badges reuse this component.
- **Story 1.5 (App shell + Cmd-K):** `(staff)/layout.tsx` provides the chrome; `(staff)/customers/[customerId]/page.tsx` lives inside it.
- **Story 1.6 (`emitAudit`):** NOT called from this story (reads do not emit audit; PII reads emit `piiAccessLog` instead).
- **Story 1.7 (state machines):** not used.
- **Story 2.1 (`customers.create` + schema):** this story READS the rows that 2.1 writes. The `address` field shape, the `govIdNumber` field, the `hasConsent` flag — all defined in 2.1.
- **Story 2.2 (`customerAttachments` + `getAttachmentUrl` + `listAttachments`):** this story's attachment grid consumes those queries. The `piiAccessLog` table was introduced in 2.2 as a stub; Story 2.3 cleaned up the direct-write pattern.
- **Story 2.3 (`readPii` + `readPiiUrl` + ESLint rule):** this story's `getCustomerDetail` calls `readPii(ctx, customerId, ["fullAddress"])`; `revealGovId` calls `readPii(ctx, customerId, ["govIdNumber"])`. The ESLint rule `no-direct-pii-read` (Story 2.3 Task 6) will fail the build if any code in this story reads `customer.govIdNumber` directly. The page's `govIdLast4` line uses the `// pii-read-ok: last-4 is non-identifying per UX §1879` escape comment.
- **Story 2.4 (Data-subject report):** unrelated direct use, but the same `readPii` boundary applies — this story's patterns are reusable.

**Stories that build on this one:**

- **Story 2.6 (Occupants):** the lot detail page will reuse the `RevealField`-style pattern, but for occupants (which are not PII per the current model). No direct dependency.
- **Story 2.7 (Ownership transfer):** redirects back to `/customers/<customerId>` after a transfer is recorded; the ownership-history list re-renders reactively. This story's `listByCustomer` query is the consumer.
- **Story 3.4 (Contracts):** populates the `ContractsList` section. Until shipped, the section renders the empty state.
- **Story 6.5 (Audit log):** the "View activity for this customer" deep link target. Until shipped, the link may 404.

### Architecture compliance

- **PII boundary (architecture § 525–528, § 868; Story 2.3):** every PII read goes through `readPii` / `readPiiUrl`. `getCustomerDetail` reads `fullAddress` through `readPii` once per page load; `revealGovId` is a separate query so that the gov-ID reveal is logged as its own user-initiated access.
- **File location (architecture § 442, § 675, § 678):** `convex/customers.ts` (existing from Story 2.1) gets `getCustomerDetail` + `revealGovId`. `convex/ownerships.ts` is NEW (architecture § 675).
- **Page location (architecture § 723):** `src/app/(staff)/customers/[customerId]/page.tsx` is the documented path.
- **Component location (architecture § 750):** composite components live under `src/components/<ComponentName>/`. `CustomerDetail/` is the folder name; `RevealField.tsx`, `OwnershipHistoryList.tsx`, `AttachmentGrid.tsx`, `ContractsList.tsx` co-exist there.
- **Reactive queries (architecture § 311):** `useQuery` for every server fetch; no React Query / SWR.
- **Server-side auth gate (architecture § 286, § 312):** `(staff)/layout.tsx` redirects unauthenticated users; per-role server-side checks live in `requireRole` inside each query. The page-level guard is UX defense-in-depth.
- **Time / money formatting (architecture § 490–495):** `formatDate(ms, "short")` for dates, `formatPeso(cents)` for contract balances. All client-side.

### Library / framework versions (researched current)

- **shadcn/ui primitives needed:** `Badge`, `Dialog`, `Skeleton`, `Table`. Install via `npx shadcn@latest add badge dialog skeleton table` if not yet present. (Story 2.1 / 1.4 may have already installed some.)
- **No new dependencies.** The imperative query pattern uses Convex's existing `useConvex` hook from `convex/react`.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── customers.ts                                        # UPDATE (add getCustomerDetail + revealGovId)
│   ├── ownerships.ts                                       # NEW (listByCustomer query + minimal schema if Story 2.7 not yet shipped)
│   ├── contracts.ts                                        # UPDATE if Story 3.4 has shipped (add listByCustomer); else stub via convex/ stub file
│   ├── schema.ts                                           # UPDATE if Story 2.7 has not yet added ownerships table (this story scaffolds it)
│   └── lib/
│       └── errors.ts                                       # UPDATE (add CUSTOMER_NOT_FOUND if not yet present)
├── src/
│   ├── app/(staff)/customers/[customerId]/
│   │   └── page.tsx                                        # NEW
│   ├── components/
│   │   └── CustomerDetail/
│   │       ├── RevealField.tsx                             # NEW
│   │       ├── RevealField.test.tsx                        # NEW
│   │       ├── OwnershipHistoryList.tsx                    # NEW
│   │       ├── AttachmentGrid.tsx                          # NEW
│   │       └── ContractsList.tsx                           # NEW
│   └── lib/
│       └── format.ts                                       # UPDATE if formatBytes missing (small helper for attachment sizes)
├── tests/
│   ├── unit/convex/
│   │   ├── customers.test.ts                               # UPDATE (add getCustomerDetail + revealGovId cases)
│   │   └── ownerships.test.ts                              # NEW
│   └── e2e/
│       └── customer-detail.spec.ts                         # NEW
└── _bmad-output/implementation-artifacts/                  # this story file
```

### Testing requirements

- **NFR-M2 coverage**: `convex/customers.ts` is already ≥ 90% from Story 2.1; this story's additions (`getCustomerDetail`, `revealGovId`) must maintain that bar. Target ≥ 90% on `convex/ownerships.ts`.
- **No e2e on Story 6.5 cross-link**: the audit-trail link's target may 404 until 6.5 ships; do not test the cross-link landing — only the link's presence + `href`.
- **30 s timer**: in unit tests, use `vi.useFakeTimers()` / `vi.advanceTimersByTime(30_000)`. In Playwright, prefer `page.clock.fastForward(30_000)` (Playwright clock API) over real-time waiting.

### Source references

- **PRD:** [FR16 (ownership history)](../../_bmad-output/planning-artifacts/prd.md#functional-requirements), [FR18 (occupants distinct from owners)](../../_bmad-output/planning-artifacts/prd.md#functional-requirements), [NFR-S4 (server-side RBAC)](../../_bmad-output/planning-artifacts/prd.md#security--privacy), [NFR-S8 (PII access logging)](../../_bmad-output/planning-artifacts/prd.md#security--privacy)
- **Architecture:** [§ Time-versioned relations (line 232)](../../_bmad-output/planning-artifacts/architecture.md#data-storage--persistence); [§ Project Structure (line 675)](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries); [§ Frontend Architecture (lines 311–315)](../../_bmad-output/planning-artifacts/architecture.md#frontend-architecture); [§ Boundary Discipline > PII read boundary](../../_bmad-output/planning-artifacts/architecture.md#boundary-discipline)
- **UX:** [§ Pattern Library > PII handling](../../_bmad-output/planning-artifacts/ux-design-specification.md#pii-handling-ui-patterns) (line 1879–1886); [§ Responsive Strategy > Customer detail (line 1901)](../../_bmad-output/planning-artifacts/ux-design-specification.md#responsive-strategy); [§ Empty State Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md); [§ Skeleton Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- **Epics:** [§ Story 2.5](../../_bmad-output/planning-artifacts/epics.md#story-25-customer-detail-page-with-ownership-history)
- **Previous stories:** [2.1](./2-1-office-staff-creates-a-customer-record.md), [2.2](./2-2-office-staff-uploads-identification-documents.md), [2.3](./2-3-pii-access-is-logged-on-every-read.md), [2.4](./2-4-admin-produces-a-data-subject-report.md), [1.4](./1-4-visual-foundation-locked-statuspill-reactivehighlight-ship.md)
- Convex docs: [Imperative query via `useConvex`](https://docs.convex.dev/client/react#querying-from-event-handlers) · [Reactive queries with `useQuery`](https://docs.convex.dev/client/react)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT include `govIdNumber` in `getCustomerDetail`'s return payload.** That would log a read on every page load, contaminating the access log and defeating the click-to-reveal pattern. The page receives `govIdLast4` only.
- ❌ **Do NOT call `useQuery(api.customers.revealGovId, ...)` reactively from the page.** Reactive subscriptions log on every server update — Maria opens the page, walks away, the page sits there, every reactive tick logs a "read." The reveal is imperative; use `useConvex().query(...)` inside an event handler.
- ❌ **Do NOT bypass `readPii` by reading `customer.govIdNumber` or `customer.address.line1` directly anywhere outside `convex/lib/pii.ts`.** Story 2.3's ESLint rule `no-direct-pii-read` will fail the build. The only exception is the `govIdLast4 = customer.govIdNumber.slice(-4)` line in `getCustomerDetail`, which uses the `// pii-read-ok: last-4 is non-identifying per UX §1879` escape comment.
- ❌ **Do NOT fetch attachment URLs in the listing pass.** Story 2.2's `listAttachments` returns metadata only by design. Calling `getAttachmentUrl` for each row in the grid would log a view that didn't actually happen — passive PII leak.
- ❌ **Do NOT skip the 30 s auto-hide.** The hide is the UX-DR30 contract. If the timer is missing or longer than 30 s, the audit trail loses its "clicked + held for 30 s" semantics.
- ❌ **Do NOT use `Date.now()` directly in the reveal-state expiry math without storing the absolute `expiresAt`.** Use `expiresAt = Date.now() + 30_000`; recheck against `Date.now()` in the timer callback. Storing the duration only and recomputing leads to off-by-one bugs when React re-renders.
- ❌ **Do NOT use the `customers` index `by_govIdNumber` from Story 2.1 to look up a customer in this story.** That index exists for the create-form dedupe (Story 2.1 Task 4). This page uses `ctx.db.get(customerId)` — the direct primary-key lookup is the indexed path.
- ❌ **Do NOT define the `ownerships` table in this story if Story 2.7 has already shipped.** Coordinate with whoever owns 2.7's schema PR. The architecture's sample schema (§ 265) is the canonical shape; both stories must agree.
- ❌ **Do NOT call `emitAudit` on customer detail page loads.** The audit log is for writes; PII access log is for PII reads. Mixing them inflates the audit log and confuses Story 6.5's audit-log query.
- ❌ **Do NOT show the full address in any list view or search result.** That escape would re-leak PII outside the detail-page reveal pattern. The Story 2.1 search returns only `fullName` + `govIdLast4`; this is the contract.

### Common LLM-developer mistakes to prevent

- **Reinventing wheels (imperative query pattern):** Convex provides `useConvex()` hook returning a client that supports `client.query(api.x.y, args)` directly inside event handlers. Don't write a custom fetch wrapper. The pattern is documented in Convex's React docs.
- **Wrong setTimeout cleanup:** the `useEffect` cleanup MUST clear the timer. Without cleanup, unmounting mid-reveal leaves a dangling timer that calls `setRevealed(null)` on an unmounted component (React warning) and — worse — the gov ID is held in component state until GC. Always: `return () => clearTimeout(handle);`
- **Wrong file location for `OwnershipHistoryList`:** `src/components/CustomerDetail/OwnershipHistoryList.tsx` — colocated with the detail page's other components. **Not** `src/components/OwnershipHistoryList.tsx` (too generic).
- **Premature optimization on attachment thumbnails:** Phase 1 ships blurred-placeholder thumbnails (CSS-only). Do NOT fetch image data on the listing pass to generate real thumbnails — that defeats Story 2.2's "no URLs in listings" design.
- **Skeleton ≠ spinner:** UX § Skeleton Patterns mandates structural skeletons matching the final layout. A single spinner in the middle of the page is wrong.
- **Forgetting the `not-found` case:** the page MUST handle `customerId` not existing. The Next.js convention is `import { notFound } from "next/navigation"; if (data === null) notFound();` — this triggers the nearest `not-found.tsx`. Story 1.1 may have shipped a default `not-found.tsx`; if not, this story adds a basic one.
- **Tab order / focus management on reveal:** when the gov-ID reveals, focus should NOT shift. The "Reveal" button stays focused (it changes label to "Hide"). Auto-shifting focus to the revealed value breaks keyboard users.
- **Forgetting role guard on field workers:** the page lives in `(staff)/` — but the `(staff)/layout.tsx` from Story 1.5 likely allows all three staff roles. Add an extra check at the page level (or, preferably, rely on `requireRole` in `getCustomerDetail` throwing `FORBIDDEN`, which the page surfaces as an error boundary). Field workers should never see this page's content.

### Open questions / blockers this story does NOT resolve

- **§10 Q1 (installment policy):** unrelated. No blocker.
- **§10 Q3 (BIR receipt format):** unrelated. No blocker.
- **§10 Q4 (legacy data condition):** **partially relevant** — legacy customers may have missing fields (no consent, no email, address only partially populated). The page handles each as optional and renders gracefully. Empty states + "—" placeholders are the UX contract.
- **§10 Q6 (ownership transfer policy):** Story 2.7's blocker; this story does NOT need a resolved policy because it only reads ownerships, doesn't create them. The empty state "No lot ownership recorded for this customer" is the answer until Story 2.7 ships.

### Project Structure Notes

Aligns with:
- [Architecture § Project Structure & Boundaries > Complete Project Directory Structure](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure) — `convex/customers.ts` (§ 674), `convex/ownerships.ts` (§ 675), `src/app/(staff)/customers/[customerId]/page.tsx` (§ 723).
- [Architecture § Boundary Discipline > PII read boundary](../../_bmad-output/planning-artifacts/architecture.md#boundary-discipline) — every PII read in this story routes through Story 2.3's `readPii` helper.

No detected conflicts.

### References

- [PRD § Functional Requirements > FR16, FR18](../../_bmad-output/planning-artifacts/prd.md#4-customer--ownership-management)
- [PRD § Non-Functional Requirements > NFR-S4, NFR-S8](../../_bmad-output/planning-artifacts/prd.md#security--privacy)
- [Architecture § Data Storage & Persistence > Time-versioned relations](../../_bmad-output/planning-artifacts/architecture.md#data-storage--persistence)
- [Architecture § Boundary Discipline > PII read boundary](../../_bmad-output/planning-artifacts/architecture.md#boundary-discipline)
- [Architecture § Frontend Architecture](../../_bmad-output/planning-artifacts/architecture.md#frontend-architecture)
- [UX § Pattern Library > PII handling UI patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#pii-handling-ui-patterns)
- [UX § Responsive Strategy](../../_bmad-output/planning-artifacts/ux-design-specification.md#responsive-strategy)
- [Epics § Story 2.5](../../_bmad-output/planning-artifacts/epics.md#story-25-customer-detail-page-with-ownership-history)
- Previous stories: [2.1](./2-1-office-staff-creates-a-customer-record.md) (schema + create), [2.2](./2-2-office-staff-uploads-identification-documents.md) (attachments), [2.3](./2-3-pii-access-is-logged-on-every-read.md) (`readPii`), [1.4](./1-4-visual-foundation-locked-statuspill-reactivehighlight-ship.md) (StatusPill)

## Dev Agent Record

### Agent Model Used

_To be filled by dev agent_

### Debug Log References

_To be filled by dev agent_

### Completion Notes List

_To be filled by dev agent — list any deviations from the task list, design decisions made during implementation, and items deferred to follow-up stories with rationale._

### File List

_To be filled by dev agent — list every file created or modified._
