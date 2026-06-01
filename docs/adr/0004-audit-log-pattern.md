# ADR 0004: Audit Log Cornerstone — `emitAudit` + Code-Enforced Append-Only

- **Status:** Accepted
- **Date:** 2026-05-18
- **Story:** 1.6

> **Numbering note:** ADR-0001 reserves ADR-0004 for "Map renderer Phase 1 SVG (Story 1.12)". That reservation predates this audit-log ADR and was based on an earlier outline. Story 1.6 lands first, so this ADR takes the 0004 slot; the map-renderer ADR (still to be authored when Story 1.12 lands) will pick the next available number. The 0001 cross-reference table should be updated by the next ADR author.

## Context

FR59 says **every financial-touching mutation MUST emit an audit log entry** capturing the actor, the timestamp, and the before/after document state. NFR-S7 says the audit log must be append-only — readers can investigate, but no one (including admins) can edit or delete a row after it's written.

Convex has **no DB-level append-only constraint** (architecture § Authentication & Security row). The schema can describe a table but cannot prevent a future code path from calling `ctx.db.patch(someAuditRowId, ...)`. Without enforcement, the audit log is hopeful documentation, not a compliance artifact.

PII compliance adds a second constraint: government-issued ID numbers, addresses, and similar fields end up in the `before` / `after` snapshots. Storing them raw means every admin who legitimately reads the audit log re-exposes the PII. The Philippines Data Privacy Act (RA 10173) treats unnecessary PII retention as a defect.

## Decision

1. **One cornerstone helper.** `convex/lib/audit.ts` exports `emitAudit(ctx, { action, entityType, entityId, before?, after?, reason? })`. The helper resolves the actor via `getCurrentUserAndRoles` (Story 1.2), validates `action` against the controlled vocabulary, redacts `before` / `after` via `redactPii`, stamps `timestamp = Date.now()`, and writes the row. Callers never construct an audit row directly.

2. **Append-only is enforced by lint + helper + tests, not by the database.** Two custom ESLint rules carry the contract (deferred to a follow-up commit per the file-ownership boundary on this story — see Open Items below):
   - `local-rules/no-audit-log-direct-write` — fails the build if any file outside `convex/lib/audit.ts` matches `ctx.db.insert("auditLog", ...)`.
   - `local-rules/no-audit-log-mutation` — fails the build on `ctx.db.patch(x, ...)`, `ctx.db.replace(x, ...)`, or `ctx.db.delete(x)` where `x` is typed as `Id<"auditLog">` (heuristic: identifier name matches `/auditLog(Id)?$/i`; deeper TypeScript type-service check is a follow-up).

3. **Redact PII at WRITE time, not at read time.** The audit log is read by admins for legitimate investigations. Redacting at read would (a) re-expose raw PII through any future code path that bypasses the read helper and (b) increase the attack surface. Redacting at write means the at-rest data is already safe — defense in depth.

4. **`entityId` is `v.string()`, not `v.id(...)`.** The audit log is polymorphic across many tables (lot, customer, contract, payment, receipt, user, expense, ownership, piiAccess). Convex's `v.id(table)` only binds one table; we store the id as an opaque string and use `entityType` as the discriminator. The `by_entity` index (`entityType`, `entityId`, `timestamp`) is the FR47 read path.

5. **Action is `v.string()` at the schema layer, runtime-checked at the helper.** Adding a new action then is a code-only change — no schema migration. The helper enforces the controlled vocabulary at write time via the `AUDIT_ACTIONS` constant. `entityType`, by contrast, IS a schema-level `v.union(v.literal(...))` because the discriminator must be stable.

6. **Helper signature accepts `MutationCtx | ActionCtx`, refuses `QueryCtx`.** Queries are read-only; writing audit logs from a query is a category error. TypeScript enforces this at the call site. The ActionCtx path delegates to an internal mutation — see Open Items.

7. **`before` and `after` are both optional.** Creation has no `before`; deletion has no `after`. Forcing both would require synthetic empty-object sentinels at every call site.

8. **`reason` is captured as-typed, never redacted.** The field is operator free text. UI guidance for Stories 1.8+ instructs operators "do not paste sensitive data into reason fields." This is a documented residual risk — automated redaction of free-text English would be unreliable and remove useful audit context.

## Consequences

### Positive

- A new financial mutation that forgets to emit audit fails CI (once the lint rules land — see Open Items). The rules are mechanical, not memory-dependent.
- PII redaction is a single function (`redactPii`) reused by Story 2.3's PII access log helper. Adding a new PII field name = one-line change.
- The controlled-vocabulary `AUDIT_ACTIONS` constant is the single source of truth for the action enum — search / reporting / compliance export all consume it.
- Schema is forward-compatible: new entity types extend the `v.union` validator; new actions are pure code changes.

### Negative

- The ESLint rules are heuristics — `local-rules/no-audit-log-mutation` matches by identifier-name regex, which can be bypassed by renaming a variable. The TypeScript type-service follow-up (deeper accuracy via `Id<"auditLog">` resolution) is the long-term fix.
- The `before` / `after` `v.any()` types are not queryable by content. Searching "all audits where `before.status` was `defaulted`" requires either a denormalized index field or a scan. Out of scope for Phase 1.
- The audit log is single-writer-path enforced. If anyone bypasses `emitAudit` (e.g. by removing the lint rule), there is no DB-side safety net. Mitigated by ADR-0008 (backup retention) — even a corrupted audit log is recoverable from yesterday's snapshot.

## Open Items

- **ESLint rules `no-audit-log-direct-write` and `no-audit-log-mutation` are deferred.** They were listed in Story 1.6's Task 5–7 but live in `eslint-rules/**` and `eslint.config.mjs`, both outside this commit's file-ownership boundary (per the dev-agent's strict file scope). The rules and their `RuleTester` suites will land in a follow-up commit or be picked up by Story 1.7's dev agent. Until they land, **the audit-log contract is enforced by the helper alone** — any direct `ctx.db.insert("auditLog", ...)` will succeed at runtime but violates the architectural intent.
- **Story 1.3 migration (Task 8) is deferred.** Story 1.3 (`convex/users.ts`) is still in `ready-for-dev` status and the file doesn't exist yet. The swap from "direct insert with TODO marker" to `emitAudit` call will happen in the same commit that authors `convex/users.ts`.
- **ActionCtx transport (`internal_writeAuditLog`) is deferred.** Convex actions can't `ctx.db.insert` directly; the transport requires an `internalMutation` registered through `convex/_generated/api`. The codegen directory is created by `npx convex dev` (interactive) and has not run in this repo yet. Today the helper throws `INVARIANT_VIOLATION` when called from an `ActionCtx`, which is strictly better than silently dropping audit events.
- **Read-side queries (`convex/auditLog.ts`).** Task 9's `listForEntity` and `listByActor` read queries are deferred — they're public Convex functions outside this commit's file-ownership boundary and depend on the read-side UI surfaces in Story 1.11 / Epic 6.
- **Integration test (Task 11).** Requires `convex-test`, which requires `convex/_generated/`. Deferred to a follow-up commit once the codegen directory exists.

## Future

- A future story will extend `AUDIT_ACTIONS` (e.g. Story 2.7 adds `"transfer"` — already reserved here; Story 3.7 may add `"cancel"`). New actions land with a JSDoc reference; the controlled vocabulary is documented here.
- If `before` / `after` content search becomes a real requirement, the architecture can add a denormalized `auditLogDigest` table indexed on the searched fields, populated by `emitAudit` via a co-mutation. Today's schema doesn't preclude this.
- ADR-0007 (PII encryption at rest — Story 2.8) will add a second layer: even the redacted-but-still-stored fields will be encrypted with field-level keys. `redactPii` operates on cleartext; the encryption layer wraps the entire `before` / `after` blob after redaction.

## References

- [PRD § 12. System Operations, Audit & Compliance (FR59)](../../_bmad-output/planning-artifacts/prd.md#12-system-operations-audit--compliance)
- [PRD § Security & Privacy (NFR-S7)](../../_bmad-output/planning-artifacts/prd.md#security--privacy)
- [PRD § Maintainability (NFR-M2)](../../_bmad-output/planning-artifacts/prd.md#maintainability)
- [Architecture § Communication Patterns > Audit-log emission](../../_bmad-output/planning-artifacts/architecture.md#communication-patterns)
- [Architecture § Authentication & Security](../../_bmad-output/planning-artifacts/architecture.md#authentication--security)
- [convex/lib/audit.ts](../../convex/lib/audit.ts)
- [convex/schema.ts](../../convex/schema.ts)
- [ADR-0002 (RBAC pattern — Story 1.2)](./0002-rbac-pattern.md)
- [Story 1.6](../../_bmad-output/implementation-artifacts/1-6-audit-log-emission-helper.md)
