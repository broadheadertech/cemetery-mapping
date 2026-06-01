# Phase 1 Threat Model

- **Status:** Living document
- **Created:** 2026-05-18 (Story 2.8)
- **Owner:** Architect (Winston) — reviewed at each epic retrospective

## Scope

This is the **Phase 1** threat model for the cemetery-mapping system: a single Philippine cemetery, 2,000+ lots, ~5–10 named staff users across the `admin` / `office_staff` / `field_worker` roles plus a `customer` self-service surface (Epic 9). The system runs on Convex (backend, file storage, scheduled jobs) + Next.js (Vercel-hosted front end).

This file documents:

1. The **assets** at risk.
2. The **adversaries** in scope (and the ones explicitly out of scope).
3. The **mitigations** currently in place, mapped to PRD NFRs and the ADRs that locked each decision.
4. The **out-of-scope surfaces** — what Phase 1 does NOT defend against and what the trigger conditions are for re-evaluating.

Site-specific operational security (cemetery building access, camera placement, key custody for backup media) is **NOT** in this document. This file is in the code repo; it documents the system's architecture-level threat posture, not the cemetery's physical OpSec.

## Assets

| Asset | Description | Location | Sensitivity |
|-------|-------------|----------|-------------|
| Customer PII — gov-ID numbers | SSS, TIN, UMID, driver's license, passport, PhilHealth, voter's ID, other government identifiers attached to each customer record. | `customers.govIdNumber` (`v.string()`); `customerDocuments` rows + their `_storage` blobs (ID scans). | **High** (NPC-regulated; breach triggers 72-hour notification). |
| Customer PII — addresses | Structured residential address (line1, barangay, city/municipality, province, postal code) per customer. | `customers.address` (`v.object`). | **High** (NPC-regulated). |
| Customer PII — phone / email | Contact channels for billing / interment notifications / portal login. | `customers.phone` / `customers.email`. | **Medium** (NPC-regulated but lower targeting value than gov-ID + address). |
| Customer ID-scan blobs | Photo/PDF uploads of government identification documents. | Convex File Storage (referenced via `customerDocuments.storageId`). | **High** (image of a government-issued ID is a credential-strength asset). |
| Financial records | Contracts, payments, receipts, BIR-compliant numbered receipt sequence. | `contracts`, `payments`, `receipts`, `receiptCounters` tables. | **High** (BIR retention obligation; financial integrity). |
| Audit log | Append-only record of every state-changing mutation plus every PII surface event. | `auditLog` table. | **High** (integrity-critical — corruption defeats compliance defense). |
| Authentication credentials | Session tokens, password hashes (if email/password is enabled), OAuth tokens. | `authTables` (Convex Auth — managed by `@convex-dev/auth`). | **Critical** (compromise → full system access at the role of the compromised account). |
| Lot inventory + occupant records | Lot geometry, status, occupant identification (deceased persons, dates). | `lots`, `occupants` tables. | **Medium** (occupant records contain decedent identification, lower targeting value than living-person PII but still NPC-regulated). |

## Adversaries — in scope for Phase 1

### A1. Phishing / credential theft of staff users

**Probability:** Medium (a single cemetery is not a high-value phishing target but staff accounts can be opportunistically harvested).

**Impact if successful:** Attacker gains the role of the compromised account — `office_staff` for most cases (PII read + customer create), `admin` in the worst case (RBAC management, financial cancellations, audit-log read).

**Mitigations:**

- Convex Auth + Next.js middleware (NFR-S1) — authenticated session required at every page boundary.
- Per-role session timeouts (NFR-S5 / ADR-0002): admin 1h, office_staff 8h, field_worker 8h, customer 30d. Multi-role users get the **strictest** timeout. A phished admin session expires within an hour.
- `requireRole` server-side gate (ADR-0002 / NFR-S4) — every mutation re-validates the caller's role; the strictest timeout is enforced on each call.
- `logPiiAccess` audit trail (ADR-0011 / NFR-S8) — every PII surface event is recorded. The breach-impact query (Story 2.4) answers "what did the compromised account read" within 2 hours, supporting the 72-hour NPC notification rule.
- Click-to-reveal pattern (Story 2.5's `revealGovId`) — the full gov-ID is never on the wire by default; it requires a deliberate user gesture, each of which is its own logged event.

### A2. Insider misuse — a legitimate user reading PII they have no business reason to access

**Probability:** Low–Medium (small team, social trust, but small teams are also exactly where insider misuse hides).

**Impact:** Same PII exposure as A1, but the attacker already has legitimate credentials so authentication won't catch it.

**Mitigations:**

- `logPiiAccess` audit trail — every PII surface is logged with actor, timestamp, fields read, reason. Admins can review the access log for anomalous patterns (Epic 5 "Recent PII access" tile, Story 5.x).
- Audit log redaction at write time (Story 1.6 / `redactPii`) — even if an insider reads the audit log itself, the redacted form does not re-expose the PII they would otherwise have to fetch from the canonical record.
- Click-to-reveal pattern — each reveal is its own logged gesture; "the office_staff opened 47 customer pages in 10 minutes" is detectable.
- Role separation — `field_worker` cannot read full customer detail; the `customer` role only sees their own records (Epic 9).

### A3. Lost / stolen staff device with an active session

**Probability:** Medium (PWAs, phones, laptops).

**Impact:** Same as A1 for the duration of the open session; the strict timeout limits the window.

**Mitigations:**

- Session timeouts (ADR-0002 / NFR-S5) — strict by-role.
- Convex Auth session invalidation — admin can revoke sessions for a deactivated user (Story 1.3 / ADR-0005).
- Offline cache scope (Story 1.13) — the field-worker offline cache deliberately excludes PII; only lot status + map data is cached locally. A stolen field-worker device exposes lot map but NOT customer PII.

### A4. Exfiltrated database backup

**Probability:** Low (Convex's managed posture; no in-house backups in Phase 1).

**Impact:** Bulk PII exposure — gov-IDs, addresses, ID-scan blobs.

**Mitigations:**

- **At-rest encryption by Convex** (NFR-S2 / **ADR-0007**) — the canonical defense. Customer rows + `_storage` blobs are encrypted with managed keys; an exfiltrated backup at the storage layer is unintelligible without the keys.
- Convex's managed key infrastructure (not customer-managed in Phase 1) means key compromise requires compromising Convex's KMS, which is outside the Phase 1 threat model boundary.
- Audit log + receipt counter + financial records are similarly at-rest-encrypted. A bulk exfiltration would not yield plaintext financial state.

### A5. Application-layer injection / authorization bypass

**Probability:** Low (Convex's typed validators reject malformed inputs; ESLint rules + tests enforce `requireRole` on every endpoint).

**Impact:** Privilege escalation, data corruption, or PII exposure depending on the bypass surface.

**Mitigations:**

- TypeScript strict mode + Convex validators (`v.object`, `v.union`, etc.) — malformed inputs reject at the wire boundary.
- `local-rules/require-role-first-line` ESLint rule (ADR-0002) — every public function must call `requireRole` as its first awaited statement. CI fails the build if missed.
- `local-rules/no-audit-log-direct-write` / `no-audit-log-mutation` ESLint rules — audit-log integrity guards.
- Convex's reactive query model does NOT execute arbitrary client code on the server; SQL injection has no analogue.
- Atomic multi-document writes (architecture commitment) — payment + contract update + receipt issuance happen in a single Convex mutation; partial-state attack surfaces are eliminated.

## Adversaries — out of scope for Phase 1

| Adversary | Why out of scope | Trigger to revisit |
|-----------|------------------|--------------------|
| Nation-state actors | Single Philippine cemetery is not a state-level target. Defense would require a posture (HSM, BYOK, network segmentation) the operational budget does not support. | Cemetery becomes a custody chain for politically sensitive remains. |
| Hardware-level side-channel attacks (Spectre/Meltdown class) | Mitigated transitively by Convex's managed infrastructure and Vercel's hosting; no application-level posture would meaningfully add. | Convex publishes a relevant CVE that is NOT patched at the managed layer. |
| Supply-chain attacks on Convex itself | Out of application's control. Mitigated by Convex's own SDLC. | Convex publishes a security incident; trigger an out-of-band review. |
| Physical seizure of Convex's data centers | Out of application's control. Mitigated by Convex's own physical-security posture (published in their SOC 2 / security whitepaper). | N/A within Phase 1 scope. |
| PCI-DSS scope (card-on-file) | Phase 1 does NOT store card data — GCash / Maya payments are tokenized (Story 9.5 / 9.6). Card data never lands in our backend. | Product decides to add card-on-file billing. |
| Multi-tenant isolation | Single-cemetery deployment; no second tenant exists. | Second cemetery is provisioned onto the same Convex project. |

## Mitigation map → PRD NFRs

| NFR | Description | Mitigation lever | Reference |
|-----|-------------|------------------|-----------|
| NFR-S1 | Authentication required for every request | Convex Auth + middleware | Story 1.1 |
| NFR-S2 | PII encrypted at rest | Convex managed at-rest encryption | **ADR-0007** (this story) |
| NFR-S3 | TLS in transit | Vercel + Convex (HTTPS-only) | Infrastructure |
| NFR-S4 | Server-side authorization on every endpoint | `requireRole` + ESLint rule | ADR-0002 / Story 1.2 |
| NFR-S5 | Per-role session timeouts (strictest wins for multi-role) | `requireRole` enforces inside Convex | ADR-0002 |
| NFR-S6 | Password complexity (when password auth is enabled) | Convex Auth provider config | Story 1.1 |
| NFR-S7 | Append-only audit log | `emitAudit` + `no-audit-log-direct-write` / `no-audit-log-mutation` | ADR-0004 / Story 1.6 |
| NFR-S8 | PII access logged | `logPiiAccess` helper | ADR-0011 / Story 2.3 |
| NFR-C4 | Breach-impact query within 2 hours | `auditLog.by_actor` + `by_timestamp` indexes; Story 2.4 | Story 2.3 / 2.4 |
| NFR-C5 | Consent gate on PII retention | `customers.hasConsent` invariant in create mutation; `customerDocuments` consent check | Story 2.1 / 2.2 |

## Out of scope (operational, not architectural)

This document does NOT cover:

- Physical security of the cemetery office.
- Staff onboarding background checks.
- Disaster recovery procedures (see `docs/runbook.md` once filled in by Story 5.6+).
- Convex's internal security posture (covered by Convex's own SOC 2 / security whitepaper).
- Vercel's hosting security posture.

These are referenced where they intersect (e.g. A3 above benefits from staff devices having OS-level password / MFA; that is an operational concern, not an architectural one).

## References

- [PRD § Security & Privacy](../_bmad-output/planning-artifacts/prd.md#security--privacy)
- [Architecture § Authentication & Security](../_bmad-output/planning-artifacts/architecture.md#authentication--security)
- [ADR-0002 — RBAC pattern](./adr/0002-rbac-pattern.md)
- [ADR-0004 — Audit log pattern](./adr/0004-audit-log-pattern.md)
- [ADR-0005 — User deactivation semantics](./adr/0005-user-deactivation-semantics.md)
- [ADR-0007 — PII encryption at rest](./adr/0007-pii-encryption.md)
- [ADR-0011 — PII access logging](./adr/0011-pii-access-logging.md)
- [Runbook](./runbook.md)
