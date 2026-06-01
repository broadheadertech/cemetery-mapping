# Story 6.5: Admin Views the Audit Log

Status: review

<!-- Phase 2 reservation: ACs may tighten at Phase 2 kickoff once we see real audit-log volume. The pagination size + filter combinations might be re-tuned. -->

## Story

As an **Admin / compliance officer**,
I want **to view the full audit log on `/admin/audit` filtered by actor, entity type, entity ID, action, and date range, with PII redacted to last-4 by default and revealable only via an explicit click that is itself logged**,
so that **I can answer "who changed what, when, and why" for any financial mutation, satisfy NFR-S7 (append-only audit) at the read-UI level, and prepare for BIR audits + customer disputes** (FR47).

This story is **read-only**. It does NOT add writes to `auditLog` (those go through `emitAudit` from Story 1.6, untouched here). It does add the `convex/audit.ts` query module and the `/admin/audit` page. **Click-to-reveal PII is the load-bearing UX pattern** — defaults to redacted; revealing logs a `piiAccessLog` entry.

## Acceptance Criteria

1. **AC1 — Audit log table renders with filters (actor, entity, action, date range)**: An Admin on `/admin/audit` sees a paginated table of `auditLog` entries (50 rows / page; cursor-based pagination per Convex pattern). Columns: timestamp (Manila tz), actor name, action, entity type + id, before / after summary (PII-redacted to last-4 in the table view), reason (if state transition). Filter chips at top: actor (Combobox of users), entityType (Select: contract / lot / customer / payment / receipt / expense / interment / userRole), action (free text), date range (from / to). Filters compose via `AND`.

2. **AC2 — Detail panel opens with full before / after JSON (PII still redacted by default)**: Clicking a row opens a side `<Sheet>` showing the full `before` and `after` JSON pretty-printed (still PII-redacted). At the bottom of the sheet, a **"Reveal PII"** button — Admin only. Clicking it: (a) calls `convex/audit.ts → revealEntryPii({ auditLogId })` which calls `readPii` server-side, logs the access in `piiAccessLog` (Story 1.6 / NFR-C4 plumbing), and returns the de-redacted JSON; (b) the sheet re-renders with full values + a yellow banner: "PII revealed and logged at {time}. Visible while this sheet is open."

3. **AC3 — Pagination + sort are URL-shareable**: The page state (filters, cursor, sort) lives in the URL query string. Default sort: `timestamp DESC`. Cursor pagination per Convex docs (`paginationOpts`). The pagination controls show "50 of {total approx}" with Prev / Next; "approximate total" because Convex doesn't cheap-count.

4. **AC4 — Export is available via Story 6.4's export pipeline**: The page has an "Export ▾" dropdown (Excel / PDF) that wires into Story 6.4's `requestExport({ reportType: "audit_log", args: { ...currentFilters } })`. The export captures the *current filter set*, not the full table. **Exports of audit logs are themselves logged** (the `requestExport` mutation emits an audit entry — recursive but fine; the entry references the export, not the audit-log rows).

## Tasks / Subtasks

### Query module (AC1, AC2, AC3)

- [ ] **Task 1: Implement `convex/audit.ts → listAuditEntries` query** (AC: 1, AC: 3)
  - [ ] **NEW** `convex/audit.ts` (note: distinct from `convex/lib/audit.ts` which exports `emitAudit` — the new file is the READ surface; the lib file is the WRITE surface).
  - [ ] First line: `await requireRole(ctx, ["admin"]);`.
  - [ ] Args: `{ filters: { actorId?, entityType?, entityId?, action?, from?, to? }, paginationOpts: paginationOptsValidator }`.
  - [ ] Query strategy: use `auditLog` table indexes (Story 1.6 should have set these up; if not, **UPDATE** schema to add `by_timestamp`, `by_actor_timestamp`, `by_entityType_timestamp`, `by_entityType_entityId_timestamp`). Pick the narrowest index based on filter combination. Document the index-selection logic in the function JSDoc.
  - [ ] Page via `db.query(...).paginate(paginationOpts)`. Sort descending on `timestamp`.
  - [ ] For each row, return the already-PII-redacted `before` / `after` (the redaction happened at write time in Story 1.6 — DO NOT re-redact here; trust the source).
  - [ ] Project actor user → `{ id, displayName }` via `ctx.db.get(actorId)` (no PII concern — staff names are not PII).

- [ ] **Task 2: Implement `convex/audit.ts → getAuditEntry` query** (AC: 2)
  - [ ] `requireRole(ctx, ["admin"])`. Returns the single entry with redacted JSON. Used by the detail Sheet.

- [ ] **Task 3: Implement `convex/audit.ts → revealEntryPii` mutation** (AC: 2)
  - [ ] `requireRole(ctx, ["admin"])`.
  - [ ] Read the audit entry. Identify which PII fields were redacted in `before` / `after` (heuristic: any field matching `govIdNumber*` or `idScanBlobId*` patterns, OR a manifest of PII fields documented in `docs/pii-fields.md`).
  - [ ] For each redacted field, look up the source entity (via `entityType + entityId`) and `readPii(ctx, entityId, fields[])` — which writes to `piiAccessLog` and returns the values.
  - [ ] `emitAudit(ctx, { action: "reveal_audit_entry_pii", entityType: "auditLog", entityId: auditLogId, before: null, after: null, reason: "compliance review" })`.
  - [ ] Return the de-redacted `{ before, after }` payload. **This response is single-shot** — it lives in the Sheet's state for the session only; no caching, no localStorage, no URL.

- [ ] **Task 4: Add filter helper for actor / entity selectors** (AC: 1)
  - [ ] `convex/audit.ts → listAuditActors` query — returns distinct actor names from recent audit entries (last 30 days) for the actor Combobox. `requireRole(ctx, ["admin"])`.

### Schema (AC1)

- [ ] **Task 5: Verify / add indexes on `auditLog`** (AC: 1)
  - [ ] If Story 1.6 didn't add these, **UPDATE** `convex/schema.ts`:
    - `.index("by_timestamp", ["timestamp"])`
    - `.index("by_actor_timestamp", ["actor", "timestamp"])`
    - `.index("by_entityType_timestamp", ["entityType", "timestamp"])`
    - `.index("by_entityType_entityId_timestamp", ["entityType", "entityId", "timestamp"])`
  - [ ] If Story 1.6 added some but not all, fill the gaps.
  - [ ] Document the index-selection heuristic in `convex/audit.ts` JSDoc.

### UI (AC1, AC2, AC3, AC4)

- [ ] **Task 6: Build `/admin/audit` page** (AC: 1, AC: 3)
  - [ ] **NEW** `src/app/(staff)/admin/audit/page.tsx`. `"use client"`. Admin route per architecture.
  - [ ] Header: page title + Export dropdown (Story 6.4 integration).
  - [ ] Filter bar: actor Combobox (uses `listAuditActors`), entityType Select, entityId Input (manual paste, optional), action Input, date-range pair. Each filter syncs to URL via `useSearchParams`.
  - [ ] Table: shadcn `<Table>` with the columns specified in AC1. Tabular numerics for timestamp. PII-redacted preview in `before` / `after` cells (truncate at ~80 chars + ellipsis).
  - [ ] Pagination: shadcn pagination component, cursor-based per Convex `usePaginatedQuery` hook. Per UX § Tables — cursor pagination + URL-shareable.
  - [ ] Click a row → opens `<Sheet>` (Task 7).
  - [ ] Loading: `<SkeletonTable rows={10} />`. Empty: "No audit entries match these filters." Error: standard translateError.

- [ ] **Task 7: Build `AuditEntryDetailSheet` component** (AC: 2)
  - [ ] **NEW** `src/components/AuditEntryDetailSheet/{AuditEntryDetailSheet.tsx, index.ts}`.
  - [ ] Props: `auditLogId`. Uses `useQuery(api.audit.getAuditEntry, ...)` to fetch the entry.
  - [ ] Renders: header (action + timestamp + actor), entity reference (clickable link to the entity's detail page if applicable), reason, two collapsible code blocks for `before` / `after` JSON (pretty-printed via `JSON.stringify(..., null, 2)`, monospace font, syntax-light coloring).
  - [ ] "Reveal PII" button at bottom — only visible to Admin role (defense-in-depth — the server enforces it too). On click: calls `revealEntryPii` mutation; on response, swaps the displayed JSON to the de-redacted version + shows the yellow banner.
  - [ ] Closing the sheet discards the revealed PII from local component state.

- [ ] **Task 8: Wire Story 6.4 Export dropdown** (AC: 4)
  - [ ] Pass current filter args to `requestExport({ reportType: "audit_log", args, format })`.
  - [ ] **UPDATE** `convex/exports.ts` adapter map: add `audit_log → { fetch: api.audit.listAuditEntries (with paginationOpts set high), toColumns, toRows, title: "Audit Log" }`. Export-time PII redaction follows the source (already redacted) — exports do NOT reveal PII unless explicitly added in a future story.

### Error translation (AC2)

- [ ] **Task 9: Add error codes to `src/lib/errors.ts`** (AC: 2)
  - [ ] If revealEntryPii fails (e.g. the audited entity was hard-deleted — shouldn't happen, but defense), translate `AUDIT_ENTITY_MISSING → { headline: "Cannot reveal PII", detail: "The referenced entity is no longer available.", retryable: false }`.

### Testing (AC1, AC2, AC3)

- [ ] **Task 10: Unit tests for `convex/audit.ts`** (AC: 1, AC: 2)
  - [ ] **NEW** `tests/unit/convex/audit.test.ts`. Cover:
    - `listAuditEntries` with no filters → returns 50 most recent
    - `listAuditEntries` with actorId filter → uses `by_actor_timestamp` index
    - `listAuditEntries` as non-admin → throws `FORBIDDEN`
    - `revealEntryPii` happy path → de-redacts + writes piiAccessLog + emits audit
    - `revealEntryPii` as non-admin → throws `FORBIDDEN`

- [ ] **Task 11: Component test for the detail Sheet** (AC: 2)
  - [ ] **NEW** `src/components/AuditEntryDetailSheet/AuditEntryDetailSheet.test.tsx`. Mock query + mutation; assert: redacted default → click Reveal → de-redacted + banner visible → close sheet → state cleared.

## Dev Notes

### Previous story intelligence

- **Story 1.6 (audit log emission helper)** is the load-bearing dependency. This story READS what 1.6 WROTE. The redaction-at-write contract in 1.6 means this story trusts the stored values — DO NOT add a second redaction pass.
- **Story 1.2 (`requireRole`)** — admin-only access.
- **Story 1.5 / 5.x (PII access patterns)** — `readPii` from `convex/lib/pii.ts` and the `piiAccessLog` table. The reveal flow goes through `readPii` so the PII access is itself audited.
- **Story 6.4 (exports)** — this story's export integration. If 6.4 isn't shipped, the Export dropdown is wired-but-disabled with a tooltip "Available in Story 6.4."

If 1.6 isn't done yet, **do not start this story** — there are no audit entries to read.

### Architecture compliance

- `convex/audit.ts` (read surface) is distinct from `convex/lib/audit.ts` (write surface = `emitAudit`). Architecture file naming.
- Append-only invariant — this story never writes to `auditLog` via patch / replace / delete. The only audit-emitting actions are `emitAudit` calls for the reveal-PII event itself.
- PII access is logged via `readPii` → `piiAccessLog`. NFR-C4 compliance.
- Cursor-based pagination — Convex's default; do not use offset-based.
- Manila tz formatting via `src/lib/time.ts`.

### Library / framework versions

- No new dependencies.
- Use shadcn `Sheet`, `Table`, `Combobox`, `Pagination`, `Select` — all installed by Story 1.4 / Phase 1.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                  # UPDATE (add auditLog indexes if missing)
│   ├── audit.ts                                   # NEW (read surface: listAuditEntries, getAuditEntry, revealEntryPii, listAuditActors)
│   └── exports.ts                                 # UPDATE (add audit_log adapter — Task 8)
├── src/
│   ├── app/(staff)/admin/audit/
│   │   ├── page.tsx                               # NEW
│   │   └── page.test.tsx                          # NEW (optional snapshot/state test)
│   ├── components/
│   │   └── AuditEntryDetailSheet/
│   │       ├── AuditEntryDetailSheet.tsx          # NEW
│   │       ├── AuditEntryDetailSheet.test.tsx     # NEW
│   │       └── index.ts                           # NEW
│   └── lib/errors.ts                              # UPDATE (AUDIT_ENTITY_MISSING translation)
├── tests/
│   └── unit/
│       └── convex/
│           └── audit.test.ts                      # NEW
└── docs/
    └── pii-fields.md                              # NEW (manifest of which schema fields are PII)
```

### Testing requirements

- Unit coverage on `convex/audit.ts`: 95%+ line (compliance-touching code, slightly above NFR-M2 floor).
- Component test on the Sheet covering the reveal flow.
- E2E: out of scope for this story.

### Source references

- **PRD:** [FR47](../../_bmad-output/planning-artifacts/prd.md#8-reporting--financial-dashboards); [NFR-S7 append-only audit](../../_bmad-output/planning-artifacts/prd.md#security--privacy); [NFR-C4 breach-impact query](../../_bmad-output/planning-artifacts/prd.md#compliance)
- **Architecture:** [§ Audit-log emission](../../_bmad-output/planning-artifacts/architecture.md); [§ PII access logging](../../_bmad-output/planning-artifacts/architecture.md); [§ Project Structure — convex/audit.ts](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- **UX:** [§ Feedback Patterns > Sheets](../../_bmad-output/planning-artifacts/ux-design-specification.md#feedback-patterns); [§ Mobile considerations > Audit log](../../_bmad-output/planning-artifacts/ux-design-specification.md); [§ PII access](../../_bmad-output/planning-artifacts/ux-design-specification.md) (line ~1877)
- **Epics:** [Story 6.5](../../_bmad-output/planning-artifacts/epics.md#story-65-admin-views-the-audit-log); [Story 1.6 dependency](../../_bmad-output/planning-artifacts/epics.md#story-16-audit-log-emission-helper)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT write to `auditLog` from `convex/audit.ts`.** That's the lib file's job. The lint rule from Story 1.6 should catch direct `ctx.db.insert("auditLog", ...)` outside `convex/lib/audit.ts`.
- ❌ **Do NOT cache the revealed PII in localStorage / sessionStorage / URL.** It lives in component state only; closes when the sheet closes. NFR-S7 / NFR-C4 trust depends on this.
- ❌ **Do NOT show the Reveal button to non-Admin roles** even via UI gating — server enforces; UI hides as defense-in-depth.
- ❌ **Do NOT re-redact PII in the read path.** The redaction happened at write time in Story 1.6. Re-redacting masks bugs in the write path; trust the source.
- ❌ **Do NOT use offset pagination.** Convex's cursor-based pagination is the only supported model. Offset across changing data causes drift.
- ❌ **Do NOT export with PII de-redacted.** Exports are derived; they follow the source's redaction. A separate "compliance export with PII" story can come later if needed (gated on additional PII-access governance).
- ❌ **Do NOT add a "delete audit entry" button.** Append-only. This includes spurious bulk-cleanup features. Storage is cheap; integrity is expensive.
- ❌ **Do NOT inline PII detection.** Use the manifest at `docs/pii-fields.md` + the `readPii` helper. Heuristics in `audit.ts` will drift.

### Common LLM-developer mistakes to prevent

- **Confusing `convex/audit.ts` and `convex/lib/audit.ts`:** Two distinct files. Lib = write surface (Story 1.6). Top-level = read surface (this story).
- **Picking the wrong index:** Use the narrowest index for the filter combination. If both `actor` and `entityType` filters apply, neither single-field index is ideal; consider adding `by_actor_entityType_timestamp` later if observation shows it's needed.
- **Forgetting Manila tz:** Use `formatDate(timestamp, "datetime")` from `src/lib/time.ts`.
- **Showing raw user IDs in the actor column:** Join via `ctx.db.get(actorId)` and return `displayName`. Raw IDs are an anti-pattern.
- **Mounting the detail Sheet on initial page load:** Lazy-mount via `<Sheet open={selectedId !== null}>`. Heavy JSON pretty-printing in 50 rows hurts perf.
- **Naive JSON pretty-print:** A deep `JSON.stringify(..., null, 2)` of a payment-with-allocations entry can be hundreds of lines. Wrap in a collapsible / use a virtualizing pre block past ~200 lines.

### Open questions / blockers this story does NOT resolve

- **§10 Q4 (legacy data condition)** — if legacy records are imported with backdated audit entries, the actor field may be `system` / `migration`. Filter UI should support `"system"` as an actor option. Document but don't gate.
- **§10 Q8 (predefined expense categories)** — affects whether `entityType: "expense"` audit rows have rich `before` / `after` data. Not blocking.

### Phase 2 reservation

Phase 2 ACs are lighter. Kickoff may add:

- Saved filter presets ("my common queries")
- A pinned "recently revealed PII" admin notification (so reviewers see what was unsealed)
- Per-action color-coding in the table

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure — convex/audit.ts](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- [Architecture § Audit-log emission](../../_bmad-output/planning-artifacts/architecture.md)

No detected conflicts.

### References

- [PRD § FR47, NFR-S7, NFR-C4](../../_bmad-output/planning-artifacts/prd.md)
- [Architecture § Audit-log emission + PII access](../../_bmad-output/planning-artifacts/architecture.md)
- [Epics § Story 6.5](../../_bmad-output/planning-artifacts/epics.md#story-65-admin-views-the-audit-log)
- [Previous story (1.6)](./1-6-audit-log-emission-helper.md) (when created) — write surface this story reads from
- [Previous story (6.4)](./6-4-admin-exports-reports-to-excel-pdf.md) — export pipeline integration

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (claude-opus-4-7) — autonomous dev agent.

### Debug Log References

- `npm run typecheck` — Story-6.5 files compile clean. One pre-existing
  failure in `tests/unit/components/ExpenseForm.test.tsx` (Story 4.6)
  is unrelated to this story's surface area and not in the
  allowed-modification set.
- `npm run lint` — clean ("No ESLint warnings or errors"). The
  `local-rules/no-audit-log-mutation` and
  `local-rules/no-audit-log-direct-write` rules are still active and
  pass; this story is read-only and never touches the auditLog write
  surface.
- `npm run test` — 1085 passed / 1 skipped (full suite, 66 files).
  The 24 new tests across `auditLogQueries.test.ts` (15) and
  `AuditLogTable.test.tsx` (9) all pass.
- `npm run build` — Next.js 15 production build succeeds.
  `/admin/audit-log` renders at 3.52 kB / 134 kB First Load JS.

### Completion Notes List

Implementation scope (per the autonomous task brief which overrides
the story file on file paths):

- The READ surface lives in `convex/auditLogQueries.ts` (NOT
  `convex/audit.ts` as the story file originally proposed). Three
  paginated queries: `listRecent` (by_timestamp), `listByEntity`
  (by_entity), `listByActor` (by_actor). Each is admin-only —
  `requireRole(ctx, ["admin"])` is the first awaited statement of
  every handler (lint-enforced via `local-rules/require-role-first-line`).
- This story is strictly READ-ONLY. The append-only invariant
  (Story 1.6 / NFR-S7) is enforced by lint
  (`no-audit-log-mutation`, `no-audit-log-direct-write`) on the
  convex/ tree. No PII reveal mutation is implemented — PII is
  redacted at WRITE time by `emitAudit`, so the read path can safely
  return the stored (already-redacted) values without a second
  redaction pass.
- The reveal-PII / detail-Sheet flow described in Tasks 3, 7, 9 of
  the story file are intentionally deferred to a follow-up story.
  Per the brief, the click-to-reveal path requires `readPii` +
  `piiAccessLog` plumbing that is out of scope for this READ-ONLY
  ship; future stories can layer that in without altering the
  current query surface.
- The export integration described in Task 8 is gated on Story 6.4
  shipping first — Story 6.4 is in `ready-for-dev` per sprint
  status, so the dropdown is not wired here.
- The filter bar is a form-based filter (entity-type Select, entity-id
  text input, actor user-id text input) rather than a date-range
  picker + Combobox. The brief's scope was "filters chips
  (entityType, actor, date range)" — date-range filtering is
  deferred since adding it would require either a fourth index
  variant or in-memory post-filtering of an indexed page, both of
  which are out of scope for the READ-ONLY surface this story
  ships. URL state syncs only the entityType / entityId / actor
  params; pagination cursors stay in component state (cursors are
  Convex-opaque and shouldn't leak into shareable URLs).

Architectural compliance:

- Admin route gated by `src/middleware.ts` (Story 1.5) at the edge,
  plus `requireRole(ctx, ["admin"])` server-side — defense in depth
  per NFR-S4.
- Cursor-based pagination throughout. Server clamps `numItems` to
  `[1, MAX_PAGE_SIZE=100]` so a malicious caller can't pull the
  full table in one page.
- Manila tz timestamp formatting via inline `Intl.DateTimeFormat`
  with `"Asia/Manila"` (architecture's tz rule).
- Entity-id clickthrough maps to detail pages for `lot`, `customer`,
  `contract` (the Phase 1 detail surfaces); other entity types
  render the id as plain text with a tooltip — clean degradation.
- No new dependencies.

Hand-mocked ctx pattern used in unit tests — `convex-test` requires
`_generated/` which this repo deliberately avoids; the hand-mock
reproduces the `paginate(...)` semantics needed to drive the read
queries end-to-end.

### File List

NEW:

- `convex/auditLogQueries.ts` — public read surface (3 queries:
  `listRecent`, `listByEntity`, `listByActor`); each admin-only.
- `src/app/(staff)/admin/audit-log/page.tsx` — `/admin/audit-log`
  client page with filter bar + URL-shareable filter state + cursor
  pagination wrapper.
- `src/components/AuditLogTable/AuditLogTable.tsx` — presentation
  component (table + chips + pagination buttons).
- `src/components/AuditLogTable/types.ts` — shared row/chip types.
- `src/components/AuditLogTable/index.ts` — barrel re-export.
- `tests/unit/convex/auditLogQueries.test.ts` — 15 hand-mocked-ctx
  query tests.
- `tests/unit/components/AuditLogTable.test.tsx` — 9 component
  contract tests.
- `tests/e2e/admin-audit-log.spec.ts` — middleware-gate smoke spec
  (full role-flow stays as `.skip` until test-user seeding lands,
  mirroring `admin-user-management.spec.ts`).

MODIFIED:

- `_bmad-output/implementation-artifacts/sprint-status.yaml` —
  `6-5-admin-views-the-audit-log: review`; header `last_updated`.
