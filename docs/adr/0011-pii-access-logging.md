# ADR 0011: PII Access Logging via `logPiiAccess` Side-Effect Helper

- **Status:** Accepted
- **Date:** 2026-05-18
- **Story:** 2.3

## Context

The PRD's **FR64** and **NFR-S8** require that every access to a customer's gov-ID number, full address, or signed URL of an ID-scan blob be logged with the actor, the timestamp, and the field(s) read — so that **NFR-C4**'s "answer 'which subjects were affected by a security incident in window X' within 2 hours" is achievable, supporting the 72-hour NPC breach-notification window.

Without a single canonical access-logging boundary, PII reads will leak silently into unaudited code paths as the codebase grows. The compliance failure mode (a PII surface that nobody knew to log) wouldn't show up in tests; it would surface as a regulator question we couldn't answer.

This ADR documents the cornerstone — the third in the `requireRole` / `emitAudit` / `logPiiAccess` trio that every Convex helper in `convex/lib/` orbits.

The original Story 2.3 brief proposed a wider surface (`readPii` + `readPiiUrl` returning typed PII values, plus an ESLint `no-direct-pii-read` rule) — that scope is being staged. **This ADR captures only what shipped in 2.3:** the side-effect logging helper. The typed value-returning helpers and the lint rule are tracked as follow-ups (see § Future Work).

## Decision

### 1. Reuse `auditLog` as the storage backplane

PII access events live in the same `auditLog` table as every other audit event. The schema validator on `auditLog.entityType` already includes the `"piiAccess"` literal (added in Story 1.6); the `by_actor`, `by_entity`, and `by_timestamp` indexes already support the access patterns NFR-C4 calls for.

One table, one set of indexes, one place to look during incident response — fewer surprises and no second audit pipeline to keep in sync.

### 2. Entity-type-agnostic shape via `entityId` ref synthesis

The helper accepts `{ entityType, entityId, fields?, reason? }` and synthesizes the canonical `auditLog.entityId` ref as `"${entityType}:${entityId}"`. The `auditLog.entityType` column always says `"piiAccess"`; the caller-domain entity type lives in the `entityId` prefix.

This means a future surface that adds PII (a contract that embeds customer info, an interment record that surfaces next-of-kin contact) can call `logPiiAccess` without first being added to the `auditLog.entityType` schema validator. Adding PII surfaces to the codebase is a one-line operation; the audit schema stays put.

### 3. `action: "read_pii"` — already in the controlled vocabulary

`AUDIT_ACTIONS` in `convex/lib/audit.ts` already enumerates `"read_pii"` — Story 1.6 reserved the slot for this story. The helper passes it through to `emitAudit`, which validates it against the controlled vocabulary at runtime.

### 4. Side-effect (returns nothing useful), called adjacent to the PII surface

`logPiiAccess` is **not** a read helper. It returns `void`. Callers invoke it next to the actual `ctx.db.get(...)` read, as `await logPiiAccess(ctx, { entityType: "customer", entityId, fields: ["govIdNumber"] })`. This keeps the helper's responsibility narrow: it logs, and only logs. The caller owns the actual surfacing of the PII values.

A future story (the deferred `readPii(ctx, customerId, fields[])` from the original Story 2.3 brief) can layer a typed return-the-values shape on top of this helper — but that's value-added sugar, not the cornerstone.

### 5. `MutationCtx | ActionCtx` only — Convex queries cannot write

`logPiiAccess` writes to `auditLog`. Convex queries are read-only, so the helper is typed against `MutationCtx | ActionCtx`. Callers that need to log a PII read from inside a Convex `query` have two options:

1. **Restructure as a mutation.** Most `getCustomer`-style entry points end up serving PII to one specific user action (a click-to-reveal handler, a customer detail page open); promoting them to mutations is the cleanest answer.
2. **Schedule an internal mutation** via `ctx.scheduler.runAfter(0, internal.<...>, args)`. The audit row appears asynchronously (~ms delay) — acceptable for compliance per NFR-S8 wording ("logging", not "synchronous logging"). This path requires `convex/_generated/` to exist (the codegen directory only appears after `npx convex dev` runs interactively), so it is a follow-up.

The ActionCtx branch in `logPiiAccess` itself currently throws `INVARIANT_VIOLATION` for the same `_generated/`-not-present reason — once the codegen runs, the body becomes `await ctx.runMutation(internal.lib.internalPiiAccess.writePiiAccessLog, params)`.

### 6. Authentication required — defense in depth

`logPiiAccess` resolves the actor via `getCurrentUserAndRoles(ctx)` and throws `UNAUTHENTICATED` if it gets `null`. The expectation is that the surrounding query / mutation already called `requireRole(...)` at its top; this is the audit-trail side effect, not the gating mechanism. The double resolution is intentional belt-and-suspenders — an audit row with a missing actor would defeat the purpose.

## Consequences

- **Positive:** Single canonical place to query PII access events (`auditLog` filtered by `entityType: "piiAccess"`). Stories 2.4 (data-subject report) and Epic 5 ("Recent PII access" admin tile) both target this set.
- **Positive:** Entity-type-agnostic — adding a new PII surface doesn't touch the `auditLog` schema validator.
- **Positive:** `emitAudit`'s redaction pipeline (`redactPii` from Story 1.6) runs on the helper's payload too, so any accidentally-included PII in the `fields` array or `reason` string is redacted before persistence.
- **Positive:** Reuses existing indexes (`by_actor`, `by_entity`, `by_timestamp`) — no new schema changes required.
- **Negative:** `MutationCtx | ActionCtx` typing means callers from a Convex `query` need a workaround (scheduler-based async log, or restructure as a mutation). Documented above.
- **Negative:** ActionCtx transport gap inherits from `emitAudit` — both throw `INVARIANT_VIOLATION` until `convex/_generated/` exists. Same root cause, same fix; tracked as a follow-up.
- **Negative:** Caller discipline replaces a lint rule — until `no-direct-pii-read` (deferred) lands, nothing in the build pipeline stops a future PR from reading `customer.govIdNumber` without calling `logPiiAccess`. Mitigation: every PII-surfacing query has a code-review checklist item; the deferred lint rule is the eventual machine enforcement.

## Future Work

### Typed value-returning helpers (`readPii`, `readPiiUrl`)

The original Story 2.3 brief described `readPii(ctx, customerId, fields[])` returning typed PII values and `readPiiUrl(ctx, attachmentId)` returning a signed URL with expiry. These layer on top of `logPiiAccess` — they log the access AND return the value, so the caller's call site collapses to one line.

Deferred because:
1. **`customers` table doesn't exist yet** — Story 2.1 is in flight as of 2026-05-18. The typed-value shape (`Pick<CustomerPii, F[number]>`) requires the customer schema to be settled.
2. **`customerAttachments` table doesn't exist yet** — Story 2.2 is in flight.

When Stories 2.1 and 2.2 land, a follow-up story (or an extension to Story 2.5's customer detail page) can introduce `readPii` / `readPiiUrl` as syntactic sugar around `logPiiAccess`. The helper API in `convex/lib/piiAccess.ts` is shaped so the sugar layers cleanly without a breaking change.

### ESLint `no-direct-pii-read` rule

The original brief proposed an AST-based lint rule that fails the build if any file reads `customer.govIdNumber`, `customer.address.<sub>`, or `ctx.storage.getUrl(<attachment>.storageId)` without going through `readPii` / `readPiiUrl`. Deferred to the same follow-up that introduces the typed value-returning helpers — the rule is most useful once the canonical read helpers exist to redirect callers to.

### QueryCtx async logging via scheduler

The "log from a query" path (`ctx.scheduler.runAfter(0, internal.lib.internalPiiAccess.writePiiAccessLog, args)`) requires `convex/_generated/api` to resolve the internal-mutation ref. Same `_generated/`-not-present gate as the ActionCtx transport. When the codegen runs, both paths unlock together.

### `breachImpactQuery` admin query

NFR-C4's 2-hour SLO needs an admin-facing query that returns all `customerId` values touched in a window. The query lives in a `convex/piiAccessLog.ts` file (not in scope for 2.3 — the entry point doesn't exist yet without Story 2.1's `customers` table). Story 2.4 ("Admin produces a data-subject report") is the natural home for this query.

## Implementation status

| Component | File | Status |
|-----------|------|--------|
| Helper | `convex/lib/piiAccess.ts` | Implemented |
| Unit tests | `tests/unit/convex/lib/piiAccess.test.ts` | Implemented (14 tests, 100% line coverage) |
| ADR | `docs/adr/0011-pii-access-logging.md` | This document |
| Customer-query integration | `convex/customers.ts` (`getCustomer`) | Deferred — owned by Story 2.1; integration noted in Story 2.3's Completion Notes as a follow-up |
| Typed `readPii` / `readPiiUrl` sugar | — | Deferred — see § Future Work |
| `no-direct-pii-read` ESLint rule | `eslint-rules/no-direct-pii-read.js` | Deferred — see § Future Work |
| `breachImpactQuery` admin query | `convex/piiAccessLog.ts` | Deferred to Story 2.4 |
| Scheduler-based async log from QueryCtx | — | Deferred — gated on `convex/_generated/` |

## References

- [PRD § FR64](../../_bmad-output/planning-artifacts/prd.md) — PII access logged
- [PRD § NFR-S8](../../_bmad-output/planning-artifacts/prd.md) — PII access log requirement
- [PRD § NFR-C4](../../_bmad-output/planning-artifacts/prd.md) — breach-impact query within 2 hours
- [Architecture § Authentication & Security > PII access logging](../../_bmad-output/planning-artifacts/architecture.md)
- [Architecture § Boundary Discipline > PII read boundary](../../_bmad-output/planning-artifacts/architecture.md)
- [ADR 0002 — RBAC pattern](./0002-rbac-pattern.md) — first cornerstone (`requireRole`)
- [ADR 0004 — Audit log pattern](./0004-audit-log-pattern.md) — second cornerstone (`emitAudit`); `logPiiAccess` delegates to it
- [Story 2.3](../../_bmad-output/implementation-artifacts/2-3-pii-access-is-logged-on-every-read.md) — this story
- [Story 2.1](../../_bmad-output/implementation-artifacts/2-1-office-staff-creates-a-customer-record.md) — `customers` table (in flight, owns the eventual integration)
- [Story 2.4](../../_bmad-output/implementation-artifacts/2-4-admin-produces-a-data-subject-report.md) — first downstream consumer
- Convex docs: [Scheduling](https://docs.convex.dev/scheduling/scheduled-functions) · [Internal Functions](https://docs.convex.dev/functions/internal-functions)
