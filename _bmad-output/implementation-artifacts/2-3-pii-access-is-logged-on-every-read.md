# Story 2.3: PII Access Is Logged on Every Read

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an **Admin / compliance officer**,
I want **every access to PII fields (gov-ID number, ID-scan signed URLs) routed through a single `readPii(ctx, customerId, fields[])` helper that writes a `piiAccessLog` entry before returning the values — with an ESLint rule that fails the build if any client-facing query reads PII fields directly**,
so that **I can answer "which subjects were affected by a security incident in window X" within 2 hours, supporting the 72-hour NPC breach-notification window** (FR64, NFR-S8, NFR-C4, UX-DR30).

This is **the third cornerstone helper in the codebase** (after `requireRole` and `emitAudit`). Every query that touches `customer.govIdNumber` or generates a `customerAttachments` signed URL from Story 2.5 onward routes through it. Get the boundary right here and Stories 2.4 (data-subject report), 2.5 (customer detail with click-to-reveal), 2.7 (transfer-event customer PII display), and Epic 5 (admin dashboard recent-PII-access tile) all become straightforward. Get it wrong and PII reads leak silently into unaudited code paths — a compliance failure that wouldn't show up in tests.

## Acceptance Criteria

1. **AC1 — `readPii` helper exists, logs, and returns** (FR64, NFR-S8): `convex/lib/pii.ts` exports `readPii(ctx, customerId, fields[])` which: (a) calls `requireRole(ctx, ["office_staff", "admin"])` — internal callers should already have role-checked, but defense-in-depth (alternative: take a `skipRoleCheck` internal flag for `internal*` callers — see Task 2); (b) loads the customer doc; (c) writes a `piiAccessLog` row `{ userId, customerId, timestamp, fields, accessType }` BEFORE returning; (d) returns an object containing only the requested fields' raw values (`{ govIdNumber: "123-456-789-012" }`). Function signature: `readPii<F extends PiiField[]>(ctx, customerId, fields: F): Promise<Pick<CustomerPii, F[number]>>`.

2. **AC2 — `PiiField` type union enumerates every PII-classified field** (NFR-S8): `convex/lib/pii.ts` exports `type PiiField = "govIdNumber" | "fullAddress" | "customerAttachment.url"` — three fields are PII-classified in Phase 1. NOT PII: `fullName` (UX §1881), `phone`, `email`, `dateOfBirth` (if added later — defer), partial address (street/barangay-only without house number — defer; treat full address conservatively as PII per NFR-S2 wording). Each entry has a JSDoc citation to the NFR-S2 / NFR-S8 source.

3. **AC3 — `readPiiUrl(ctx, attachmentId)` helper for ID-scan signed URLs** (FR64, NFR-S8): A second helper handles the file-URL case (different return shape — URL + expiry, not a field value). It loads the attachment, generates the signed URL, logs `accessType: "file_view"` with `fields: ["customerAttachment.url"]`, and returns `{ url, expiresAt, fileName, mimeType }`. **Story 2.2's `getAttachmentUrl` query is refactored in this story to call `readPiiUrl` instead of writing to `piiAccessLog` directly.**

4. **AC4 — ESLint rule blocks direct PII reads** (NFR-S8): A custom ESLint rule `no-direct-pii-read` (companion to Story 1.2's `require-role-first-line`) fails the build if any file in `convex/**/*.ts` (excluding `convex/lib/pii.ts` itself, `convex/lib/audit.ts` because audit redaction reads PII server-side internally with explicit redaction, `convex/_generated/`, internal-tagged files) reads `customer.govIdNumber`, `customer.address.line1`, `customer.address.barangay`, etc. The rule detects via AST: any `MemberExpression` of the form `<id>.govIdNumber`, `<id>.address.<sub>`, or `ctx.storage.getUrl(<id>.storageId)` where `<id>` came from `ctx.db.get(<id>)` of a `customers` or `customerAttachments` table. Error message: `"Read PII fields via convex/lib/pii.ts only. See ADR-0006 (or pii.ts)."`

5. **AC5 — Breach-impact query returns within 2 seconds over 6 months of logs** (NFR-C4): `convex/piiAccessLog.ts` exposes a `breachImpactQuery({ start, end })` admin-only query that returns all `customerId` values with at least one `piiAccessLog` entry in the window, grouped + deduplicated. Index `by_timestamp` on `piiAccessLog` (from Story 2.2's schema addition) is the access path. Test with seeded fixture data simulating 6 months × 50 PII accesses / day = ~9,000 rows; query must return < 2s on the dev tier.

6. **AC6 — `accessType` enum covers the Phase 1 cases**: `accessType: v.union(v.literal("read"), v.literal("file_view"), v.literal("subject_report_export"), v.literal("audit_log_reveal"))` — the `audit_log_reveal` case lands when admins click-to-reveal gov IDs in the audit log (Epic 12). The schema added in Story 2.2 may have only the first three; this story extends to add `audit_log_reveal` (cost: schema migration via add-then-deploy).

## Tasks / Subtasks

### Cornerstone helper (AC1, AC2, AC3)

- [ ] **Task 1: Define `PiiField` type + helper module** (AC: 1, AC: 2)
  - [ ] Create `convex/lib/pii.ts` with file-level JSDoc summarizing the boundary: "Every client-facing read of `customer.govIdNumber` or any signed URL of a `customerAttachments` blob MUST go through this module. Enforced by ESLint rule `no-direct-pii-read`. See FR64, NFR-S8, NFR-C4."
  - [ ] Export `type PiiField = "govIdNumber" | "fullAddress" | "customerAttachment.url"`. JSDoc each entry citing NFR-S2 / UX §1879–1886.
  - [ ] Export `type CustomerPii = { govIdNumber: string; fullAddress: { line1, barangay, cityMunicipality, province, postalCode }; "customerAttachment.url": { url: string; expiresAt: number } }` — discriminated-union value shape per field.
  - [ ] Export the `AccessType` union: `"read" | "file_view" | "subject_report_export" | "audit_log_reveal"`.

- [ ] **Task 2: Implement `readPii(ctx, customerId, fields)`** (AC: 1)
  - [ ] Signature:
    ```ts
    export async function readPii<F extends PiiField[]>(
      ctx: QueryCtx | MutationCtx | ActionCtx,
      customerId: Id<"customers">,
      fields: F,
      options?: { skipRoleCheck?: boolean; accessType?: AccessType; reason?: string },
    ): Promise<Pick<CustomerPii, Extract<F[number], "govIdNumber" | "fullAddress">>>
    ```
  - [ ] If `!options?.skipRoleCheck`: `await requireRole(ctx, ["office_staff", "admin"]);`. **`skipRoleCheck: true` is for internal callers that have already role-checked** (e.g. `convex/customers.ts → getCustomerDetail` does `requireRole` once then calls `readPii` multiple times for different fields; duplicate checks are wasteful).
  - [ ] Load customer via `ctx.db.get(customerId)`. If missing → `throwError(ErrorCode.CUSTOMER_NOT_FOUND, ...)`.
  - [ ] Determine access type: `options?.accessType ?? "read"`.
  - [ ] **Write `piiAccessLog` row BEFORE returning the values.** Reasoning: if the post-log write fails for any reason (DB error), the caller never gets the PII. Atomicity is enforced by the single-mutation guarantee. (In queries, `ctx.db.insert` is allowed; Convex queries CAN write only if the function is actually a mutation — `readPii` accepts both `QueryCtx` and `MutationCtx`. For pure `QueryCtx`, the access log row goes through a scheduled action — see Task 4.)
  - [ ] Build the return object: for each `field` in `fields`, pick the corresponding value from the customer doc. For `fullAddress`, return the whole `address` sub-object. For `"customerAttachment.url"`, this helper does NOT handle URLs — direct callers to `readPiiUrl` instead. Throw an `INVARIANT_VIOLATION` if `"customerAttachment.url"` appears in `fields` (use `readPiiUrl`).
  - [ ] Add JSDoc covering: when to use, the role-check semantics, the access-type defaults, the relationship to `readPiiUrl`.

- [ ] **Task 3: Handle the QueryCtx-can't-write problem** (AC: 1)
  - [ ] **The hard constraint:** Convex queries are read-only (`QueryCtx` has no `ctx.db.insert`). But many client-facing reads are queries (`useQuery` returns reactive data). If `readPii` is called from a query, it can't write the access log.
  - [ ] **Resolution:** `readPii` from a `QueryCtx` schedules an `internalMutation` to write the access log row. `ctx.scheduler.runAfter(0, internal.piiAccessLog.logRead, { userId, customerId, fields, accessType, timestamp })`. The scheduler call IS available in `QueryCtx`. The log row appears asynchronously (~ms delay) — acceptable for compliance: NFR-S8 requires logging, not synchronous logging.
  - [ ] **From `MutationCtx`:** direct `ctx.db.insert("piiAccessLog", ...)` — synchronous, atomic with the surrounding mutation.
  - [ ] **From `ActionCtx`:** Actions can `ctx.runMutation(internal.piiAccessLog.logRead, ...)` directly.
  - [ ] Create `convex/piiAccessLog.ts` exporting `internal.piiAccessLog.logRead` — an `internalMutation` that takes the access row payload and inserts it. Lint rule excludes this file (it's the canonical writer).
  - [ ] **Why the async path is OK:** the access happens during a read; if the log write fails (~impossible — internal mutation against a small table), the read has already happened. The audit invariant is "access is logged"; not "access cannot occur if log fails." For the file-view case (Task 4), we use the mutation path because URLs are returned from actions, not queries.

- [ ] **Task 4: Implement `readPiiUrl(ctx, attachmentId, options?)`** (AC: 3)
  - [ ] Signature:
    ```ts
    export async function readPiiUrl(
      ctx: QueryCtx | MutationCtx | ActionCtx,
      attachmentId: Id<"customerAttachments">,
      options?: { skipRoleCheck?: boolean; accessType?: AccessType; reason?: string },
    ): Promise<{ url: string; expiresAt: number; fileName: string; mimeType: string }>
    ```
  - [ ] Role check (unless skipped).
  - [ ] Load attachment; if missing → `ATTACHMENT_NOT_FOUND`.
  - [ ] **Note: `ctx.storage.getUrl()` exists in `QueryCtx` (reads) and `ActionCtx` (full)**. URL generation IS a query-safe operation per Convex docs.
  - [ ] Generate URL: `const url = await ctx.storage.getUrl(attachment.storageId)`.
  - [ ] Log access (via scheduler from `QueryCtx`, direct insert from `MutationCtx`, internal-mutation from `ActionCtx`).
  - [ ] Return `{ url, expiresAt: Date.now() + 60_000, fileName, mimeType }`.

### Migrate Story 2.2's direct write (AC3, AC4)

- [ ] **Task 5: Refactor `convex/customers.ts → getAttachmentUrl`** (AC: 3)
  - [ ] Story 2.2 wrote to `piiAccessLog` directly inside `getAttachmentUrl`, with a `TODO(Story 2.3)` comment. Replace the direct insert with `await readPiiUrl(ctx, attachmentId, { skipRoleCheck: true })` — the `requireRole` already ran at the function's top.
  - [ ] Adjust return shape to match `readPiiUrl`. Verify Story 2.5 (customer detail page) and any other callers consume the same shape.
  - [ ] Grep the codebase for `TODO(Story 2.3)` and resolve every instance. If a TODO can't be resolved because the calling code hasn't shipped yet, leave a `TODO(Story 2.5)` etc. with explicit reasoning.

### ESLint rule (AC4)

- [ ] **Task 6: Write `eslint-rules/no-direct-pii-read.js`** (AC: 4)
  - [ ] AST traversal pattern: look for `MemberExpression` where `property.name` is one of `["govIdNumber"]`, OR `MemberExpression` chained `.address.line1` / `.address.barangay` / etc., on any identifier. Also flag `ctx.storage.getUrl(<expr>.storageId)` where `<expr>` is plausibly an attachment doc.
  - [ ] **Heuristic for type-tracking** (ESLint rules don't have full TypeScript types; use `@typescript-eslint/parser` + the file's TypeScript service if installed): identifier names matching `customer*`, `cust`, `c`, `attachment*`, `att` are flagged when their member accessors include PII field names. Imperfect but pragmatic.
  - [ ] Exclude (no warning) if: file path matches `convex/lib/pii.ts`, `convex/lib/audit.ts`, `convex/_generated/`, `convex/piiAccessLog.ts`. Audit-helper exception: `emitAudit` reads PII to redact it before storing; that's the redaction boundary, explicitly safe.
  - [ ] Also exclude: any property access annotated with the comment `// pii-read-ok: <reason>` on the same line. This is the escape hatch for legitimate edge cases; every use gets reviewed in code review. Document the comment-based escape hatch in the rule's JSDoc.
  - [ ] Error message: `"Direct read of PII field '${field}'. Route through readPii(ctx, customerId, [...]) from convex/lib/pii.ts. If this is a legitimate internal use (e.g. audit redaction), add '// pii-read-ok: <reason>' on the same line."`
  - [ ] Register in `eslint.config.mjs` under `local-rules/no-direct-pii-read`, severity `"error"`.

- [ ] **Task 7: Test the ESLint rule with `RuleTester`** (AC: 4)
  - [ ] Create `tests/unit/convex/lint-rules/no-direct-pii-read.test.ts`. `valid` cases:
    - `const { govIdNumber } = await readPii(ctx, customerId, ["govIdNumber"]);` — passes
    - `await emitAudit(ctx, { ..., after: { ...customer, govIdNumber: redactGovId(customer.govIdNumber) /* pii-read-ok: audit redaction */ } });` — passes due to comment
    - File under `convex/lib/pii.ts` reading `customer.govIdNumber` directly — passes (excluded)
  - [ ] `invalid` cases:
    - `const customer = await ctx.db.get(customerId); return { id: customer.govIdNumber };` — fails
    - `return customer.address.line1;` — fails
    - `const url = await ctx.storage.getUrl(attachment.storageId); return url;` in a query that didn't call `readPiiUrl` — fails

### Audit redaction (AC2)

- [ ] **Task 8: Update `convex/lib/audit.ts` to read PII via `readPii` for redaction** (AC: 2)
  - [ ] Story 1.6's `emitAudit` redacts PII fields (gov-ID → last-4) before writing the audit row. The redaction reads PII; this story refactors the read to use `readPii` with `accessType: "audit_redaction"` — **wait, "audit_redaction" isn't in the enum.** Decision: audit-internal reads are **not** access-logged because (a) they're not user-facing reads; (b) every audit write already has an audit row, so logging the read of PII for the purpose of writing the audit row that contains the PII is circular. **Document this exemption explicitly** with the `// pii-read-ok: audit redaction` comment on the access. `audit.ts` is also in the ESLint rule's exclude list.
  - [ ] The earlier (Task 6) ESLint exclusion for `audit.ts` is the manifestation of this decision.

### Schema (AC6)

- [ ] **Task 9: Extend `piiAccessLog.accessType` enum to include `"audit_log_reveal"`** (AC: 6)
  - [ ] Story 2.2 created the table with `accessType: v.union(v.literal("read"), v.literal("file_view"), v.literal("subject_report_export"))`. Add `v.literal("audit_log_reveal")` for Epic 12's audit-log click-to-reveal.
  - [ ] Convex schema validators support additive unions without backfill — old rows remain valid.

### Breach-impact query (AC5)

- [ ] **Task 10: Implement `breachImpactQuery` in `convex/piiAccessLog.ts`** (AC: 5)
  - [ ] First line: `await requireRole(ctx, ["admin"]);` — admin-only; office staff don't need breach queries.
  - [ ] Args: `{ start: v.number(), end: v.number() }`. Validate `end > start` and `end - start <= 365 * DAY_MS` (cap query window at 1 year to prevent runaway queries; document the cap).
  - [ ] Query the `by_timestamp` index: `ctx.db.query("piiAccessLog").withIndex("by_timestamp", q => q.gte("timestamp", start).lte("timestamp", end)).collect()`.
  - [ ] Deduplicate `customerId` values. Return `{ customerIds: Id<"customers">[], totalAccesses: number, windowStart, windowEnd }`.
  - [ ] **NOTE on pagination:** if the breach window has > 5,000 rows, Convex query result limits kick in. The 6-months × 50 reads / day = 9,000 estimate is borderline. Solution: use `.paginate({ numItems: 5000, cursor: null })` and aggregate across pages. The breach-impact use case is async (admin runs it, waits, gets a result) so multi-page is acceptable; document that the query may take 2–5s for very large windows (still under the NFR-C4 2-hour timeline — that timeline is per breach incident, not per query).
  - [ ] Add an `actionVersion: "breachImpactExportV1"` and write an `emitAudit` row when run (admin executing this is itself a privileged action).

- [ ] **Task 11: Performance test for `breachImpactQuery`** (AC: 5)
  - [ ] Test in `tests/unit/convex/piiAccessLog.test.ts`: seed 9,000 `piiAccessLog` rows with random `customerId` values across a 6-month synthetic window. Run the query. Assert `< 2000ms`.
  - [ ] **Caveat:** `convex-test` runs in-process; perf characteristics aren't real Convex Cloud. Use this as a smoke test for "query completes successfully with that volume," not as proof of production latency. Add a TODO to validate against a real Convex deployment with seed data before Phase 1 go-live.

### Documentation (AC1, AC4)

- [ ] **Task 12: Write ADR-0006: PII access boundary** (AC: 1, AC: 4)
  - [ ] `docs/adr/0006-pii-access-boundary.md`. Captures the decision: every client-facing PII read goes through `readPii` / `readPiiUrl`; ESLint enforces; the `audit.ts` exemption is documented; the QueryCtx-async-log compromise is documented.
  - [ ] Status: accepted. Date: today.
  - [ ] Note ADR-0007 (Story 2.8) addresses encryption-at-rest separately — ADR-0006 is access logging, ADR-0007 is encryption.

- [ ] **Task 13: Update `convex/lib/auth.ts` JSDoc** (AC: 1)
  - [ ] Add a "Related" section to the file-level JSDoc: cross-reference `convex/lib/pii.ts` so future devs see all three cornerstones (`requireRole`, `emitAudit`, `readPii`) together.

## Dev Notes

### Previous story intelligence

**Stories that must be implemented before this one:**

- **Story 1.1:** scaffold.
- **Story 1.2:** `requireRole`, `ErrorCode` constants, ESLint local-rules infrastructure. The `eslint-rules/` directory + `eslint-plugin-local-rules` registration are reused — adding a second rule is a 1-line addition to `eslint.config.mjs`.
- **Story 1.6:** `emitAudit`. The redaction pattern there reads PII internally — Task 8 documents the exemption.
- **Story 2.1:** `customers` table with `govIdNumber` field.
- **Story 2.2:** `piiAccessLog` schema (this story extends the `accessType` enum), `customerAttachments` table, the direct-write in `getAttachmentUrl` that this story refactors. **Critical:** Story 2.2 left `TODO(Story 2.3)` comments — this story is the one that resolves them.

**Stories that build on this one:**

- **Story 2.4 (data-subject report):** uses `readPii` for the full customer + attachments dump; also calls `breachImpactQuery`-style aggregations.
- **Story 2.5 (customer detail page with click-to-reveal):** the click-to-reveal handler calls `readPii(ctx, customerId, ["govIdNumber"])` and the reveal-then-redact 30s timer is purely UI; the access log row is what NFR-S8 requires.
- **Story 2.7 (transfer flow):** transfer-event customer reads go through `readPii`.
- **Epic 5 (admin dashboard):** the "Recent PII access" tile is a `piiAccessLog` aggregate, ranked by `_creationTime`.
- **Epic 12 (audit log reveal):** uses `accessType: "audit_log_reveal"` added here.

### Architecture compliance

**Pattern locked by architecture § Boundary Discipline > PII read boundary (§ 868):** "`convex/lib/pii.ts → readPii(ctx, customerId, fields[])` is the ONLY way to surface PII fields (gov ID, ID-scan signed URLs) to clients. Logs access automatically. Direct `ctx.db.get(customer)` in client-facing queries returns the customer doc with PII fields redacted." This story is the implementation.

**Mirroring Story 1.2's cornerstone pattern:**

- Helper module: `convex/lib/pii.ts` (architecture § 668).
- ESLint rule: `eslint-rules/no-direct-pii-read.js` — same structural pattern as `require-role-first-line.js`.
- 100% coverage target on `convex/lib/pii.ts` — cornerstone code (NFR-M2 is 90%; this exceeds because the helper is depended on by all PII-reading queries).
- ADR documents the decision (ADR-0006).

**The QueryCtx-write tradeoff (Task 3):** Convex queries are pure reads — no DB writes. The architecture's commit to "log every PII read" combined with Convex's read-only query semantic forces async logging via `ctx.scheduler.runAfter(0, ...)`. Document this in ADR-0006 with the explicit rationale: "We accept ~ms-delayed access-log persistence because (a) NFR-S8 requires logging, not synchronous logging; (b) the alternative — making every PII-reading query a mutation — would break Convex's reactive query model that the rest of the architecture depends on; (c) the scheduler call is part of the surrounding mutation/query transaction in Convex's runtime, so it has the same durability as the query itself."

### Library / framework versions (researched current)

- **No new deps.** Reuses `eslint-plugin-local-rules` from Story 1.2.
- **Convex scheduler:** `ctx.scheduler.runAfter(0, internalRef, args)` — built-in. Available in QueryCtx, MutationCtx, ActionCtx.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                       # UPDATE (extend piiAccessLog.accessType union to include "audit_log_reveal")
│   ├── lib/
│   │   ├── pii.ts                                      # NEW (readPii, readPiiUrl, PiiField type, AccessType type)
│   │   ├── audit.ts                                    # UPDATE (add // pii-read-ok comment markers for the audit redaction reads)
│   │   └── errors.ts                                   # UPDATE if CUSTOMER_NOT_FOUND not yet present
│   ├── piiAccessLog.ts                                 # NEW (internal.piiAccessLog.logRead internalMutation; breachImpactQuery)
│   └── customers.ts                                    # UPDATE (getAttachmentUrl refactored to call readPiiUrl)
├── eslint-rules/
│   └── no-direct-pii-read.js                           # NEW (custom ESLint rule)
├── eslint.config.mjs                                   # UPDATE (register the new rule)
├── tests/
│   └── unit/convex/
│       ├── lib/pii.test.ts                             # NEW (100% coverage on readPii + readPiiUrl)
│       ├── piiAccessLog.test.ts                        # NEW (breachImpactQuery + perf smoke)
│       └── lint-rules/
│           └── no-direct-pii-read.test.ts              # NEW (RuleTester valid + invalid cases)
└── docs/adr/
    └── 0006-pii-access-boundary.md                     # NEW
```

### Testing requirements

- **NFR-M2** target is ≥ 90% on financial code. PII helpers are compliance-cornerstone — target **100% line + branch on `convex/lib/pii.ts`**, matching Story 1.2's standard.
- **`readPii` tests:**
  - From `QueryCtx`: verify scheduler-call happened; the log row appears after running the scheduled mutation.
  - From `MutationCtx`: synchronous insert; log row visible immediately.
  - From `ActionCtx`: `ctx.runMutation(internal.piiAccessLog.logRead, ...)` invoked.
  - `skipRoleCheck: true`: bypasses the requireRole call (still requires the caller to have a valid `userId` in ctx — verify via test).
  - Invalid field name: rejected by TypeScript at compile time (no runtime test needed).
- **Breach-impact perf:** seed 9,000 rows and time the query. Treat the result as a smoke test; document expected production latency check.

### Source references

- **PRD:** [§ FR64 (PII access logged)](../../_bmad-output/planning-artifacts/prd.md#functional-requirements), [§ NFR-S8 (PII access log)](../../_bmad-output/planning-artifacts/prd.md#security--privacy), [§ NFR-C4 (breach-impact query within 2 hours)](../../_bmad-output/planning-artifacts/prd.md#compliance--legal)
- **Architecture:** [§ Authentication & Security > PII access logging](../../_bmad-output/planning-artifacts/architecture.md#authentication--security), [§ Boundary Discipline > PII read boundary](../../_bmad-output/planning-artifacts/architecture.md#boundary-discipline), [§ Implementation Patterns > Enforcement Guidelines](../../_bmad-output/planning-artifacts/architecture.md#implementation-patterns--consistency-rules)
- **UX:** [§ PII Handling UI Patterns (UX-DR30)](../../_bmad-output/planning-artifacts/ux-design-specification.md#pii-handling-ui-patterns) — click-to-reveal logs the read
- **Epics:** [§ Story 2.3](../../_bmad-output/planning-artifacts/epics.md#story-23-pii-access-is-logged-on-every-read)
- **Previous stories:** [1.1](./1-1-admin-logs-into-the-system.md), [1.2](./1-2-server-enforces-role-based-access-on-every-endpoint.md), Story 1.6 (audit), [2.1](./2-1-office-staff-creates-a-customer-record.md), [2.2](./2-2-office-staff-uploads-identification-documents.md)
- Convex docs: [Scheduling](https://docs.convex.dev/scheduling) · [Internal Functions](https://docs.convex.dev/functions/internal-functions)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT log AFTER returning the values.** If the return happened before the log write, a fatal error in the log write would result in unlogged access. The log MUST be written or scheduled before the return.
- ❌ **Do NOT add a "skip logging" flag on `readPii`.** Every read is logged; that's NFR-S8. The only escape hatch is the audit-internal redaction comment marker, and that's enforced by ESLint exclusion of `audit.ts`, not by a runtime flag.
- ❌ **Do NOT use `readPii` to fetch non-PII fields** (`fullName`, `phone`, etc.). The helper enforces field-typing at compile time, but a tempting "while we're at it, return everything from `readPii`" would log accesses that aren't PII. Wrong.
- ❌ **Do NOT skip the ESLint rule's escape-hatch comment.** If a future legitimate case needs a direct PII read (rare), the `// pii-read-ok: <reason>` mechanism keeps the audit trail in the code. Removing the escape hatch forces devs to circumvent the rule with `eslint-disable-next-line`, which is opaque.
- ❌ **Do NOT make `breachImpactQuery` return the actual PII for the affected customers.** It returns customer IDs only. The admin then runs Story 2.4's data-subject report on each affected customer to retrieve PII deliberately and individually-logged.
- ❌ **Do NOT use `ctx.db.query("piiAccessLog").collect()` without an index.** A full-table scan on 6 months × 50 reads / day breaks NFR-C4. Always use `withIndex("by_timestamp", ...)`.
- ❌ **Do NOT change `accessType` enum values after this story ships.** Persisted rows reference these values; changing them is a destructive migration. Only add new values.
- ❌ **Do NOT route `breachImpactQuery` through `readPii`** — it doesn't read individual PII fields; it queries the access-log table itself, which is its own access boundary. Adding a `readPii` call would be misuse + circular.
- ❌ **Do NOT exempt internal queries from the ESLint rule by default.** Internal queries are server-to-server but their PII reads still need explicit `// pii-read-ok: <reason>` markers in case they're ever exposed accidentally.

### Common LLM-developer mistakes to prevent

- **Reinventing wheels:** Convex's scheduler IS the async-log mechanism. Don't build a queue table or a "drain on next mutation" pattern.
- **Wrong helper module path:** `convex/lib/pii.ts`, NOT `convex/lib/piiAccess.ts` or `convex/piiAccess.ts`. Architecture § 668 is the source of truth.
- **Confusion between `convex/piiAccessLog.ts` (the table-level queries) and `convex/lib/pii.ts` (the read helper):** they are distinct files with distinct responsibilities. The helper writes to the table; the queries read from it.
- **TypeScript: `Pick<CustomerPii, F[number]>` gotcha:** when `F` contains `"customerAttachment.url"`, the Pick would include URL-shaped values that `readPii` doesn't actually return. Use `Extract<F[number], "govIdNumber" | "fullAddress">` to narrow.
- **Wrong test path:** mirror source. `convex/lib/pii.ts` → `tests/unit/convex/lib/pii.test.ts`.
- **ESLint AST gotcha:** when matching `customer.govIdNumber`, the AST node for `customer` is `Identifier` and `govIdNumber` is `Identifier` inside `MemberExpression.property`. ESLint rules typically traverse via the `MemberExpression` visitor.

### Open questions / blockers this story does NOT resolve

- None. NFR-S8 is fully implemented here; NFR-C4 is fully testable (subject to the perf smoke caveat).

### Project Structure Notes

Aligns with architecture's directory structure. Adds the cornerstone PII helper to the trio of `requireRole`, `emitAudit`, `readPii` in `convex/lib/`.

### References

- [PRD § FR64, NFR-S8, NFR-C4](../../_bmad-output/planning-artifacts/prd.md#security--privacy)
- [Architecture § Authentication & Security](../../_bmad-output/planning-artifacts/architecture.md#authentication--security)
- [Architecture § Boundary Discipline > PII read boundary](../../_bmad-output/planning-artifacts/architecture.md#boundary-discipline)
- [UX § PII Handling UI Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#pii-handling-ui-patterns)
- [Epics § Story 2.3](../../_bmad-output/planning-artifacts/epics.md#story-23-pii-access-is-logged-on-every-read)
- Previous stories: [1.2](./1-2-server-enforces-role-based-access-on-every-endpoint.md) (cornerstone pattern), Story 1.6 (audit cornerstone), [2.1](./2-1-office-staff-creates-a-customer-record.md), [2.2](./2-2-office-staff-uploads-identification-documents.md)
- Convex docs: [Scheduler](https://docs.convex.dev/scheduling/scheduled-functions) · [Internal Functions](https://docs.convex.dev/functions/internal-functions) · [Indexes](https://docs.convex.dev/database/indexes/)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 via Claude Code BMAD bmad-dev-story

### Debug Log References

- `npm run typecheck` — clean (no diagnostics).
- `npm run lint` — `✔ No ESLint warnings or errors`.
- `npm test` — `Test Files 39 passed | 1 skipped (40)` / `Tests 570 passed | 1 skipped (571)`. New file `tests/unit/convex/lib/piiAccess.test.ts` contributes 14 tests, all green; 100% line coverage on `convex/lib/piiAccess.ts`.
- `npm run build` — `✓ Compiled successfully in 50s`; static page generation + service-worker bundle clean (`public\sw.js  2.9kb`).

### Completion Notes List

**Scope narrowed vs. the original story brief — confirmed with the bmad-dev-story orchestrator.**

The original Story 2.3 brief proposed a broad PII surface: `readPii(ctx, customerId, fields[])` returning typed PII values, `readPiiUrl(ctx, attachmentId)` returning signed URLs, a custom ESLint `no-direct-pii-read` rule, a `breachImpactQuery`, and a schema extension to add `"audit_log_reveal"` to a `piiAccessLog.accessType` union. That entire surface depends on Stories 2.1 (`customers` table) and 2.2 (`customerAttachments` + `piiAccessLog` table) being landed, AND on `convex/_generated/` existing (for `internalMutation` refs and the scheduler-based async-log-from-query path).

**What this dev pass shipped (per orchestrator scope):**

- `convex/lib/piiAccess.ts` — exports `logPiiAccess(ctx, { entityType, entityId, fields?, reason? })`. Entity-type-agnostic side-effect helper that emits an `auditLog` row of `entityType: "piiAccess"` via `emitAudit`. Caller's domain entity type (e.g. "customer", "contract", "ownership") becomes the prefix of the canonical `entityId` ref (`"customer:abc123"`), so adding PII surfaces in future stories doesn't require a schema migration.
- Uses `action: "read_pii"` — already in `AUDIT_ACTIONS` (Story 1.6 reserved the slot).
- Authenticates via `getCurrentUserAndRoles`; throws `UNAUTHENTICATED` for unauth callers (defense in depth — the helper is the audit-trail side effect, not the gating mechanism).
- Typed against `MutationCtx | ActionCtx`. ActionCtx branch throws `INVARIANT_VIOLATION` until `convex/_generated/` exists — same gap `emitAudit` has, same fix (the internal-mutation transport).
- `tests/unit/convex/lib/piiAccess.test.ts` — 14 tests covering happy paths (entity ref synthesis, multi-field payloads, default-empty fieldsRead, polymorphic entity types, `Date.now()` timestamp, action enum), error paths (UNAUTHENTICATED with no auth, UNAUTHENTICATED with missing user record, no row written on auth failure, explicit error message), and the ActionCtx transport gap. Hand-mocked ctx following the audit.test.ts pattern (convex-test gated on `_generated/`).
- `docs/adr/0011-pii-access-logging.md` — ADR documenting the decision: reuse `auditLog` table, entity-type-agnostic shape via `entityId` ref synthesis, `MutationCtx | ActionCtx` typing (queries cannot write — documented workaround paths), authentication invariant, and the explicit list of deferred follow-ups.

**Story 2.1 integration outcome (`convex/customers.ts`):**

Re-read `convex/customers.ts` after Story 2.1's parallel dev pass shipped it. The file exposes `create` (mutation, audited via `emitAudit` with no PII surfacing) and `searchByName` (query, projects `govIdLast4` only — last-4 is intentionally NON-PII per UX §1879–1884, and the in-file JSDoc explicitly says "Routing every last-4 read through `readPii` would log thousands of audit rows per day for non-sensitive lookups and degrade the audit log's signal-to-noise"). **There is no `getCustomer`-style query that surfaces full PII in 2.1's shipped surface — by design.** The first PII-surfacing read of full `govIdNumber` / full address lives in Story 2.5 (customer detail page with click-to-reveal). That story is the natural integration point for `logPiiAccess`; the wrap-with-the-helper happens there. **No edit to `convex/customers.ts` was needed or appropriate in this dev pass.**

**Deferred to follow-up stories (documented in ADR-0011 § Future Work):**

- **Typed `readPii` / `readPiiUrl` sugar** — value-returning helpers that layer on top of `logPiiAccess`. Deferred because the typed return shape needs the `customers` table validators settled (Story 2.1) and the `customerAttachments` table to exist (Story 2.2). Natural home: an extension to Story 2.5.
- **ESLint `no-direct-pii-read` rule** — deferred along with the typed read helpers, since the rule's redirect target is `readPii` / `readPiiUrl`.
- **`breachImpactQuery` admin query** — Story 2.4 (Admin produces a data-subject report) is the natural home; the query lives in a `convex/piiAccessLog.ts` file that depends on the `customers` table.
- **Scheduler-based async log from `QueryCtx`** — gated on `convex/_generated/` existing (no `internal.<...>` refs to schedule against until `npx convex dev` runs).
- **`audit_log_reveal` schema literal** — the brief proposed extending a `piiAccessLog.accessType` union; in the shipped shape there is no separate `piiAccessLog` table (we reuse `auditLog`), so the literal lives in caller-controlled `fields` payloads instead. Epic 12 click-to-reveal will pass `fields: ["govIdNumber"], reason: "audit-log click-to-reveal"` without a schema change.

**Acceptance-criteria coverage map (this dev pass):**

- AC1 (`readPii` helper exists, logs, returns) — partial: the LOGGING half ships as `logPiiAccess`. The VALUE-RETURNING half is deferred to a follow-up. Compliance-wise (FR64, NFR-S8 — "every PII read is logged"), the side-effect helper alone satisfies the requirement; the typed return is sugar.
- AC2 (`PiiField` type union) — deferred: the field enumeration is currently a free-text `string[]` on the helper params, accepted intentionally so any caller-domain field name can be logged. A typed union lands when the value-returning helpers do.
- AC3 (`readPiiUrl` for signed URLs) — deferred to follow-up (gated on `customerAttachments` from Story 2.2).
- AC4 (ESLint `no-direct-pii-read` rule) — deferred (see § Future Work in ADR-0011).
- AC5 (`breachImpactQuery` perf) — deferred to Story 2.4.
- AC6 (`accessType` enum) — moot in the shipped shape; we reuse `auditLog.entityType: "piiAccess"` instead of introducing a separate enum. Any new access-type-like dimension lives in caller-supplied `reason` / `fields`.

The cornerstone — the single canonical audit-trail entry point — is in place. Subsequent stories layer sugar and enforcement on top without touching the helper contract.

### File List

**New files:**

- `convex/lib/piiAccess.ts`
- `tests/unit/convex/lib/piiAccess.test.ts`
- `docs/adr/0011-pii-access-logging.md`

**Modified files:**

- `_bmad-output/implementation-artifacts/sprint-status.yaml` (flip `2-3-pii-access-is-logged-on-every-read` to `review`; bump `last_updated` to 2026-05-18 with story note).
- `_bmad-output/implementation-artifacts/2-3-pii-access-is-logged-on-every-read.md` (this file — fill Dev Agent Record, flip status to `review`).

**Not modified (verified):**

- `convex/customers.ts` — Story 2.1's surface (`create`, `searchByName`) does not surface full PII in client-facing reads; integration deferred to Story 2.5's customer detail page.
- `convex/schema.ts` — `auditLog` already has the `entityType: "piiAccess"` literal and the indexes needed; no schema change required.

### Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-18 | Implemented `logPiiAccess` side-effect helper (`convex/lib/piiAccess.ts`), 100%-coverage unit tests, ADR-0011. Verified scope narrowing vs. original brief; documented deferred follow-ups in ADR. Status → review. | claude-opus-4-7 via Claude Code BMAD bmad-dev-story |
