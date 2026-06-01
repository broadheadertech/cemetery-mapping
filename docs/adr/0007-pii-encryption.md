# ADR 0007: PII Encryption at Rest

- **Status:** Accepted
- **Date:** 2026-05-18
- **Story:** 2.8
- **Decider:** theundead (project owner) + Winston (architect)

## Context

PRD **FR65** and **NFR-S2** require that PII fields — specifically `customers.govIdNumber` (Story 2.1) and the customer-document blobs in Convex File Storage (Story 2.2's `customerDocuments` rows + their backing `_storage` files) — be **"encrypted at rest with keys held in Convex's managed key infrastructure."** Architecture § Authentication & Security (line 289) locks the decision: *"Convex default at-rest encryption (sufficient per NFR-S2 wording). Convex encrypts all data at rest with managed keys outside the application code. Application-layer field-level encryption is overscope for the threat model (single-cemetery freelance build)."*

This ADR formalises that locked-in decision so a future auditor, code reviewer, or threat-model revisit finds the rationale documented rather than implied.

Phase 1 threat model (see `docs/threat-model.md`):

- **Scope:** a single Philippine cemetery, ~5–10 staff (admin / office_staff / field_worker / customer roles per ADR-0002).
- **Regulatory frame:** NPC (Data Privacy Act 2012) compliance; BIR financial-record retention. **No PCI-DSS workload** (no card numbers stored — Phase 2 payments go through GCash / Maya tokenized, see ADR-0010).
- **Excluded adversaries:** nation-state actors, hardware-level side-channels, supply-chain attacks on Convex itself.
- **Primary in-scope adversaries:** phishing of staff credentials, opportunistic insider misuse, theft of an unlocked staff device.

## Decision

**Rely on Convex's managed at-rest encryption. No application-level field-level encryption is applied to `customers.govIdNumber`, `customers.address`, `customerDocuments.fileName`, or the backing `_storage` blobs.**

Concretely:

1. `customers.govIdNumber` remains `v.string()` (Story 2.1's design). It is **not** rewritten as `v.bytes()`, not wrapped in an envelope, not split into shards.
2. `customerDocuments` storage IDs remain plain `v.id("_storage")` references. The blobs themselves are uploaded via the standard Convex File Storage API; Convex's encryption applies transparently.
3. No `convex/lib/crypto.ts` module exists in Phase 1. There is no application-level DEK, no KMS integration, no key-rotation schedule.
4. The application-layer protections that DO exist for PII — `requireRole` server-side gating (ADR-0002), `emitAudit` redaction at write time (ADR-0004), `logPiiAccess` access logging (ADR-0011), per-role session timeouts (ADR-0002), and click-to-reveal mutations (Story 2.5's `revealGovId`) — are **complementary** to at-rest encryption, not substitutes for it. Each defends a different attacker scenario; see `docs/threat-model.md`.

## Verification

Convex's public security posture was reviewed at the time of this ADR and is summarised below. The verification anchors that satisfy NFR-S2's "encrypted at rest with keys held in Convex's managed key infrastructure" wording:

- **Convex Trust Center / Security page** (https://www.convex.dev/security) and **Convex production hardening doc** (https://docs.convex.dev/production/security): Convex's managed cloud encrypts customer data at rest using industry-standard symmetric encryption (AES-256) with keys held in Convex's managed key infrastructure (not customer-managed in Phase 1).
- **File Storage:** Convex File Storage inherits the same at-rest encryption as table rows. The `customerDocuments` backing blobs (ID scans, affidavits, death certificates) are therefore covered by the same guarantee.
- **Verified-by date:** 2026-05-18. The verification source is to be re-checked at every annual security review (see § Future revisit triggers).

If Convex's posture changes — e.g. they drop a managed-key tier, move to BYOK-only, or restrict at-rest encryption to a higher pricing tier — that is a § Future revisit trigger, not an automatic ADR invalidation.

## Consequences

### Positive

- **Operational simplicity.** No KMS to provision, no DEK to rotate, no envelope-decrypt path in every query that surfaces PII.
- **Compatible with Convex reactive queries.** Application-layer encryption would have broken `useQuery`'s reactive subscription model on encrypted fields — every client would decrypt locally, and indexes on the encrypted column become impossible.
- **Compatible with Convex indexes.** `customers.by_fullName_lowercased` and `customers.by_govIdNumber` (Story 2.1) remain functional. Story 2.1 already designed search-on-PII as last-4-projection (`govIdLast4`) and lowercase-name (`fullNameLowercased`), so the on-disk-plaintext field is never *displayed* without going through the access-logging boundary (`revealGovId` mutation + `logPiiAccess`).
- **Audit-log redaction stays independent.** Story 1.6's `redactPii` (in `convex/lib/audit.ts`) redacts `govIdNumber` to last-4 at write time on every audit row. That is a SEPARATE protection from at-rest encryption — the audit log redaction defends against an admin reading the audit log; the at-rest encryption defends against a storage-layer compromise. Both stay in place.

### Negative

- **No application-layer envelope.** If a future Convex deployment is exfiltrated (storage tier compromised, encryption keys leaked alongside), the customer PII rows are recoverable. The Phase 1 threat model accepts this — Convex's posture is the boundary; if it falls, NPC notification under the 72-hour rule is the response (Story 2.4's data-subject report + Story 2.3's breach-impact query are the operational tooling).
- **Search on full gov-ID number is unencrypted on disk.** This is identical to the alternative ("encrypt and lose search") only in failure mode — Story 2.1's design uses `govIdLast4` and `fullNameLowercased` projections in the search path, so the search ergonomics are already constrained. Adding application-level encryption would have made the constraint worse without changing the threat boundary.
- **Phase 1 is locked to Convex's pricing tier that includes managed at-rest encryption.** Downgrading to a tier without it would invalidate this ADR; see § Future revisit triggers.

## Rejected alternatives

1. **Application-level AES-GCM with KMS-stored DEK.**
   - *Rejected because:* introduces a key-management operational burden (rotation, audit, escrow) the cemetery cannot staff. Breaks Convex's reactive query model on the encrypted column. Forces every PII-surfacing function to be a mutation (decrypt is a side-effecting unwrap). Story 2.1's `by_govIdNumber` index would have to be dropped — the duplicate-detection design depends on it.
2. **Column-level transparent encryption (Postgres TDE / equivalent).**
   - *Rejected because:* Convex is not Postgres; it exposes no such primitive. Adopting this would require migrating the entire backend off Convex onto a managed PG with PostGIS — an architecturally rejected move per ADR-0001's "Boring technology for stability" principle.
3. **Bring-your-own-key (BYOK) on Convex.**
   - *Rejected because:* not a feature Convex's current tier exposes to single-cemetery customers; would require a contract upgrade that Phase 1's budget does not cover. Re-evaluate at the post-Phase-1 threat-model revisit (see § Future revisit triggers).
4. **HashiCorp Vault as an external encryption-at-write layer.**
   - *Rejected because:* introduces a runtime dependency outside the Convex serverless boundary, adds an inter-service latency tax on every PII write, and the operational footprint (Vault server, seal/unseal, audit) is well beyond a single freelance maintainer's bandwidth. Same threat-boundary as KMS+DEK above; same rejection.

## Future revisit triggers

This ADR is **NOT** "decided forever." Revisit when any of the following becomes true:

- **Threat model expands to nation-state actors** — e.g. cemetery becomes a custody chain for politically sensitive remains.
- **Multi-tenancy is introduced** — second cemetery deployed onto the same Convex project. Cross-tenant isolation would warrant application-layer envelopes.
- **PCI-DSS workload is added** — Phase 2 payment storage shifts from tokenized to card-on-file (currently NOT planned; GCash/Maya are tokenized).
- **Regulatory shift** — NPC issues stricter PII-handling guidance, or BIR mandates application-layer encryption of taxpayer IDs.
- **Convex changes its encryption posture** — drops the managed at-rest tier, requires BYOK, or publishes a security incident affecting key management.
- **Post-Phase-1 architectural revisit** — Epic 10+ or any "we are scaling beyond a single cemetery" planning cycle.

Each trigger fires a new ADR (`docs/adr/00XX-pii-encryption-revised.md`) that supersedes this one via `Supersedes: ADR-0007` rather than editing this file.

## Related cornerstones

- **ADR-0002 (RBAC pattern):** `requireRole` is the first defense — every PII-surfacing query / mutation calls it as the first awaited statement. Without an authenticated authorised caller, no PII bytes leave Convex.
- **ADR-0004 (Audit log pattern):** `emitAudit` + `redactPii` redact PII in the audit log AT WRITE TIME. This protects the audit reader from re-leaking PII even though the canonical customer row remains on-disk-encrypted-by-Convex.
- **ADR-0011 (PII access logging):** `logPiiAccess` writes an `auditLog` row tagged `entityType: "piiAccess"` for every PII surface event. This documents WHO read WHEN; ADR-0007 documents that the underlying bytes are encrypted at rest.

The three ADRs together (0002 + 0004 + 0007 + 0011) form the PII protection envelope for Phase 1. They are independent and complementary; none of them substitutes for any of the others.

## References

- [PRD § Functional Requirements > FR65](../../_bmad-output/planning-artifacts/prd.md#functional-requirements)
- [PRD § Non-Functional Requirements > NFR-S2](../../_bmad-output/planning-artifacts/prd.md#security--privacy)
- [Architecture § Authentication & Security > PII encryption (line 289)](../../_bmad-output/planning-artifacts/architecture.md#authentication--security)
- [Architecture § Project Structure > docs / adr (line 824)](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- [Threat model](../threat-model.md)
- [Runbook § PII encryption posture](../runbook.md)
- [Story 2.1 — customers schema + `govIdNumber`](../../_bmad-output/implementation-artifacts/2-1-office-staff-creates-a-customer-record.md)
- [Story 2.2 — customer document uploads](../../_bmad-output/implementation-artifacts/2-2-office-staff-uploads-identification-documents.md)
- [Story 2.3 — PII access logged on every read](../../_bmad-output/implementation-artifacts/2-3-pii-access-is-logged-on-every-read.md)
- [Story 2.4 — admin produces a data-subject report](../../_bmad-output/implementation-artifacts/2-4-admin-produces-a-data-subject-report.md)
- [Story 2.8 — this story](../../_bmad-output/implementation-artifacts/2-8-pii-fields-encrypted-at-rest.md)
- [ADR-0002 — RBAC pattern](./0002-rbac-pattern.md)
- [ADR-0004 — Audit log pattern](./0004-audit-log-pattern.md)
- [ADR-0011 — PII access logging](./0011-pii-access-logging.md)
- Convex security documentation (verified 2026-05-18): [Production security](https://docs.convex.dev/production/security) · [Trust center](https://www.convex.dev/security)
