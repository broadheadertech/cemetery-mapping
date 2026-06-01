# Story 2.8: PII Fields Encrypted at Rest

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an **Admin / compliance reviewer**,
I want **gov-ID numbers and ID-scan files encrypted at rest by Convex's managed key infrastructure — verified against Convex's published documentation and locked behind ADR-0007 stating that application-level field-level encryption is intentionally out of scope**,
so that **NFR-S2 is satisfied for the Phase 1 threat model without taking on key-management burden, and a future auditor / code reviewer / threat-model revisit finds the rationale explicitly documented rather than implied** (FR65, NFR-S2).

This is a **documentation-and-verification story**, not a code-implementation story. Convex's default at-rest encryption already protects the `customers.govIdNumber` field (Story 2.1's schema) and the `customerAttachments` blobs (Story 2.2's File Storage uploads) — Stories 2.1 and 2.2 explicitly committed to this in their disaster-prevention sections. The work here is: (a) verify the Convex commitment against current published documentation; (b) write **ADR-0007** capturing the decision, the threat-model boundary, the rejected alternatives, and the future revisit conditions; (c) add a `docs/threat-model.md` stub if not already present (architecture § 835 references it); (d) add a lightweight CI doc-check that fails the build if ADR-0007 is deleted or the customers schema introduces an application-encrypted field without updating the ADR.

## Acceptance Criteria

1. **AC1 — ADR-0007 written and located correctly** (FR65, NFR-S2): `docs/adr/0007-pii-encryption.md` exists, follows the project ADR template (status / date / context / decision / consequences / rejected alternatives / future revisit triggers, matching `0001-starter-template.md` from Story 1.1 and `0006-postFinancialEvent-pattern.md` from Story 3.2). The ADR documents: (a) **Decision** — rely on Convex managed at-rest encryption (AES-256 per Convex docs at write time of this story; cite the doc URL + version-string); application-level field-level encryption is intentionally NOT applied. (b) **Context** — Phase 1 threat model (single Philippine cemetery, ~5–10 staff, no nation-state adversary, no PCI-DSS workload), PRD NFR-S2 wording ("encrypted at rest with keys held in Convex's managed key infrastructure"). (c) **Consequences** — operationally simple; relies on Convex's documented encryption; loses application-layer envelope protection (acceptable per threat model); search on encrypted fields not possible (already accepted via Story 2.1's design — only `fullNameLowercased` and `govIdLast4` are indexed). (d) **Rejected alternatives** — application-level AES-GCM with KMS-stored DEK (overkill; introduces key-rotation operational burden + breaks Convex's reactive query model for the encrypted field); column-level transparent encryption (Convex doesn't expose this; would require a managed PG migration). (e) **Future revisit triggers** — threat model expands to include nation-state actors; multi-tenancy is introduced; PCI-DSS workload is added; Convex changes its encryption posture.

2. **AC2 — Verification artifact recorded** (FR65, audit prep): A short markdown excerpt is included in the ADR under "Verification": a copied paragraph from Convex's current public security documentation (linked + dated) attesting to at-rest encryption. If Convex's exact wording is behind a customer-portal page or contract page (not a public URL), the verification quotes the relevant ToS / SLA / security-whitepaper line accessible to the cemetery's Convex tier, with the source noted as "private — Convex security whitepaper accessed 2026-MM-DD." (No private content is committed; only the citation reference and the verified-by date.)

3. **AC3 — `docs/threat-model.md` exists with a PII encryption section** (NFR-S2, architecture § 835): If the threat-model doc doesn't yet exist (it likely doesn't — earlier stories reference it but no story has created it), this story creates a minimal version: (a) Assets — customer PII (gov ID numbers, address, ID-scan blobs); (b) Adversaries — phishing of staff credentials (Phase 1 primary), insider misuse (low-likelihood, audit-mitigated), platform compromise (out of Phase 1 scope, mitigated by Convex's posture); (c) Mitigations — auth (NFR-S1, S5, S6), RBAC (NFR-S4 + Story 1.2), PII access logging (NFR-S8 + Story 2.3), at-rest encryption (this story); (d) Out of scope — nation-state actors, side-channel attacks, hardware-level compromise. Link the doc to ADR-0007.

4. **AC4 — CI doc-check fails if ADR-0007 is deleted** (defense-in-depth for compliance): A new CI step (in `.github/workflows/ci.yml` from Story 1.1) checks `docs/adr/0007-pii-encryption.md` exists and that any `convex/schema.ts` change touching fields with `v.bytes()` in a `customers` or `customerAttachments` table is paired with an ADR update. Implementation: a small Node script `scripts/check-adr-0007.js` (or a `npm run check:adr-0007` task) that the CI workflow invokes. Failure message: "ADR-0007 (PII encryption) was deleted or `customers` schema introduces `v.bytes()` without ADR amendment. See docs/adr/0007-pii-encryption.md."

5. **AC5 — No code changes to `convex/customers.ts`, `convex/schema.ts`, or `customerAttachments`** (NFR-S2 wording): The decision documented in this story is to KEEP THE STATUS QUO from Stories 2.1 + 2.2 — `govIdNumber` remains `v.string()`, attachments use Convex File Storage as already implemented. Any code change here would mean a code-level encryption layer is being added, which is explicitly rejected. The story's deliverables are doc / ADR / threat-model / CI-check only. Reviewers checking the PR should see no Convex schema diff.

## Tasks / Subtasks

### Verification (AC1, AC2)

- [ ] **Task 1: Verify Convex's current at-rest encryption posture** (AC: 2)
  - [ ] Visit Convex's public documentation at the time of implementation. Likely starting points:
    - https://docs.convex.dev/production/security
    - https://convex.dev/security (marketing/legal page)
    - Convex's published whitepaper or trust center if any
  - [ ] Quote the relevant sentence(s) verbatim into a working note. Record the URL + the date accessed.
  - [ ] If the public docs don't explicitly state "AES-256 at rest" or equivalent, file a brief verification request via Convex's support channel (the cemetery's tier permits direct support contact). Record the response (with appropriate redaction of any contract-specific language) into the working note.
  - [ ] **Acceptable verification levels**, in order of preference:
    1. Public security doc URL + verbatim quote.
    2. Convex support response (private; cite as "private email, date YYYY-MM-DD, on file in incident-response folder").
    3. ToS / SLA reference (private; cite the section number).
  - [ ] If none of the above can be obtained, **escalate to PM**. Do NOT proceed to ADR write-up with an unverified claim.

### ADR (AC1, AC2)

- [ ] **Task 2: Write `docs/adr/0007-pii-encryption.md`** (AC: 1, AC: 2)
  - [ ] Use the same template as `docs/adr/0001-starter-template.md` (Story 1.1) and `docs/adr/0006-postFinancialEvent-pattern.md` (Story 3.2). Sections in order:
    - `# ADR-0007: PII Encryption at Rest`
    - **Status:** Accepted
    - **Date:** YYYY-MM-DD (the implementation date)
    - **Context** — 4–6 lines describing the requirement: PRD NFR-S2 + FR65 + the Phase 1 threat model (single Philippine cemetery, NPC compliance only, no PCI workload).
    - **Decision** — clear statement: "Rely on Convex's managed at-rest encryption. No application-level field-level encryption is applied to `customers.govIdNumber` or `customerAttachments`."
    - **Verification** — the quote and source from Task 1.
    - **Consequences** — operational simplicity (no DEK / KMS); compatible with Convex reactive queries; loses application-layer envelope; partial-PII search must continue to use `govIdLast4` and `fullNameLowercased` (already designed this way in Story 2.1).
    - **Rejected alternatives** — application-level AES-GCM; column-level transparent encryption; bring-your-own-key.
    - **Future revisit triggers** — bullet list: multi-tenant deployment, PCI workload, regulatory shift (NPC issues stricter PII-handling guidance), Convex changes its encryption posture, post-Phase-1 threat model expansion.
    - **References** — links to PRD NFR-S2, architecture § 289, Story 2.1, Story 2.2, Story 2.3 (`readPii`), the verified Convex doc.
  - [ ] Total length target: 400–700 words. Brief enough to be read in one sitting; thorough enough to satisfy a future auditor.

- [ ] **Task 3: Cross-link the ADR from Stories 2.1, 2.2, and 2.3** (AC: 1)
  - [ ] Story 2.1's dev notes already reference "Story 2.8 / ADR-0007"; verify and tighten the link.
  - [ ] Story 2.2's "Disaster prevention" section likely references the same; verify.
  - [ ] Story 2.3's `readPii` JSDoc is a good place to note: "Reads are logged (this module); writes are encrypted by Convex at rest (ADR-0007)."
  - [ ] **No code changes** beyond the JSDoc comment additions. If touching `convex/lib/pii.ts`, that's the only change.

### Threat-model doc (AC3)

- [ ] **Task 4: Create or update `docs/threat-model.md`** (AC: 3)
  - [ ] If the file doesn't exist (architecture § 835 references it but no story has created it), this story creates the first version with the structure in AC3.
  - [ ] If the file exists (a previous story may have created a stub), this story adds or updates the PII encryption section linking to ADR-0007.
  - [ ] Length target: 600–1000 words. This is a working doc that will grow; don't try to write the perfect threat model — write a useful one that establishes the structure.
  - [ ] Sections: Assets · Adversaries · Mitigations (mapped to PRD NFRs) · Out-of-scope · References.
  - [ ] **Do NOT include any production credentials, security camera positions, building floorplans, or any operationally sensitive information.** This file is in the public repo (or at least in the cemetery's code repo with normal access controls). The threat model documents architecture decisions, not site-specific OpSec.

### CI doc-check (AC4)

- [ ] **Task 5: Write `scripts/check-adr-0007.js`** (AC: 4)
  - [ ] Node script that:
    1. Asserts `docs/adr/0007-pii-encryption.md` exists. Exit 1 with the failure message if not.
    2. Greps `convex/schema.ts` for `v.bytes()` inside a `customers:` or `customerAttachments:` block (or any line within 30 lines after such a block declaration). If found, exit 1 unless the most recent commit message contains `[adr-0007-amend]` (allowing intentional amendments to pass with an explicit flag).
    3. On success, exit 0 silently.
  - [ ] Keep it small (< 80 lines). Use Node's built-in `fs.readFileSync` + simple regex. No additional dependencies.
  - [ ] Document the script's intent at the top: "Compliance check for ADR-0007 (PII encryption). Run in CI."

- [ ] **Task 6: Wire the check into `.github/workflows/ci.yml`** (AC: 4)
  - [ ] Add a step after `typecheck`:
    ```yaml
    - name: ADR-0007 compliance check
      run: node scripts/check-adr-0007.js
    ```
  - [ ] Story 1.1 established the CI workflow; this step extends it.
  - [ ] Add `npm run check:adr-0007` script alias in `package.json` for local invocation.

### Tests (AC4, AC5)

- [ ] **Task 7: Unit test for the doc-check script** (AC: 4)
  - [ ] Create `tests/unit/scripts/check-adr-0007.test.ts`.
  - [ ] Cases (using temp dirs / mocked `fs`):
    - **Happy path**: ADR exists, schema has no `v.bytes()` on customers — script exits 0.
    - **Missing ADR**: ADR file deleted — script exits 1 with the expected failure message.
    - **Adding `v.bytes()` without flag**: schema has `customers: defineTable({ govIdNumberBytes: v.bytes() })` — script exits 1.
    - **Adding `v.bytes()` with explicit amendment flag**: script exits 0.
  - [ ] These tests guard the guard. The script is a safety net for compliance; the tests ensure the safety net works.

- [ ] **Task 8: Verify no production schema diff** (AC: 5)
  - [ ] Manual review checklist (document in PR description):
    - [ ] `git diff convex/schema.ts` shows zero lines changed (or only whitespace / comment additions if cross-referencing the ADR via comment).
    - [ ] `git diff convex/customers.ts` shows zero lines changed beyond JSDoc.
    - [ ] No new file under `convex/lib/` claims to be a crypto layer.
  - [ ] **This is a "story that doesn't change production code"** — the absence of code changes is the deliverable.

### Documentation polish (AC1)

- [ ] **Task 9: Update `docs/runbook.md` with a PII-encryption compliance section** (AC: 1)
  - [ ] Add a short section "PII encryption posture" linking to ADR-0007. Cover: what's encrypted (everything at rest via Convex); what to do if a future regulator requests proof (point them to ADR-0007 + the verification source); how to handle a security-incident workflow that involves PII (Story 2.4's data-subject report + Story 2.3's breach-impact query).
  - [ ] If `docs/runbook.md` doesn't yet exist, Story 4.1 may have introduced it (it references the runbook in Task 12). If it exists, append the section. If not, create the minimum: just this section, marked as a starter; future stories will fill in incident response, backup restore, etc.

## Dev Notes

### Previous story intelligence

**Stories that must be implemented before this one:**

- **Story 1.1 (auth + scaffold + CI workflow):** the `.github/workflows/ci.yml` file exists; this story adds a step. The ADR convention (`docs/adr/000X-*.md`) was established by Story 1.1's ADR-0001.
- **Story 2.1 (`customers` schema + `govIdNumber`):** this story is the explicit policy commitment for how that field is protected. Story 2.1 already noted "Convex's default at-rest encryption — per architecture's § 289 PII encryption decision + Story 2.8's forthcoming ADR-0007."
- **Story 2.2 (`customerAttachments` + File Storage):** ID scans live in Convex File Storage; same encryption applies. Story 2.2's design already accepts this.
- **Story 2.3 (`readPii` access logging):** this story does NOT change `readPii`. The two stories are complementary: 2.3 logs every read; 2.8 documents that the writes are encrypted at rest.
- **Story 2.4 (Data-subject report):** uses `readPii`; reads decrypted values via Convex's normal API. No change here.
- **Story 2.5, 2.6, 2.7:** orthogonal. None of them change PII encryption posture; all of them depend on the implicit guarantee this story documents.

**Stories that build on this one:**

- **Future Story 12.x (Phase 2 expanded audit / compliance UI):** may surface the encryption-posture summary in the Admin UI for compliance reviewers. Link to ADR-0007 from the UI.
- **Future regulatory revisit:** if NPC issues stricter guidance, the future story revisiting will cite this ADR as the prior decision.

### Architecture compliance

- **Locked by architecture § 289:** "Convex default at-rest encryption (sufficient per NFR-S2 wording). Convex encrypts all data at rest with managed keys outside the application code. Application-layer field-level encryption is overscope for the threat model (single-cemetery freelance build)." This story documents that decision in an ADR.
- **ADR pattern (architecture § NFR-M3 + Story 1.1's ADR-0001 establishing the format):** every architecturally-significant decision gets an ADR. The encryption-posture decision predates Phase 1 (it lives in the architecture doc) but has not been ADR'd. This story closes that gap.
- **Threat-model location (architecture § 835):** `docs/threat-model.md`. The arch doc references the file; this story creates / fills it.
- **No code changes:** consistent with architecture's stance — the encryption layer is Convex's responsibility, not the app's.

### Library / framework versions (researched current)

- **No new dependencies.** Node's built-in `fs` is enough for the doc-check script.
- **Convex security documentation:** moving target — verify at implementation time, not at story-writing time. The story-author cannot pre-fill the verification URL because Convex's doc URLs change; the dev agent confirms current.

### File structure requirements

```
cemetery-mapping/
├── docs/
│   ├── adr/
│   │   └── 0007-pii-encryption.md                            # NEW
│   ├── threat-model.md                                       # NEW or UPDATE
│   └── runbook.md                                            # UPDATE (PII-encryption section)
├── scripts/
│   └── check-adr-0007.js                                     # NEW
├── tests/
│   └── unit/scripts/
│       └── check-adr-0007.test.ts                            # NEW
├── .github/workflows/
│   └── ci.yml                                                # UPDATE (add ADR-0007 check step)
├── package.json                                              # UPDATE (add npm run check:adr-0007 script)
└── _bmad-output/implementation-artifacts/                    # this story file

# Files explicitly NOT changed:
# - convex/schema.ts (no field changes)
# - convex/customers.ts (no logic changes; may add JSDoc cross-link)
# - convex/customerAttachments anything (no changes)
# - convex/lib/pii.ts (only a JSDoc cross-link)
```

### Testing requirements

- **No NFR-M2 coverage gate applies** — this is a documentation story; the only code is a 80-line CI script with its own unit tests. Aim for 100% line coverage on the script (it's small and high-stakes).
- **The "absence of test failures" is itself a test:** running the existing test suite after this story's changes should pass identically. Verify in CI.
- **Manual verification step:** PR reviewer confirms the verification source in Task 1 is current. Date the verification.

### Source references

- **PRD:** [FR65 (PII encryption)](../../_bmad-output/planning-artifacts/prd.md#functional-requirements), [NFR-S2 (encrypted at rest)](../../_bmad-output/planning-artifacts/prd.md#security--privacy)
- **Architecture:** [§ Authentication & Security > PII encryption (line 289)](../../_bmad-output/planning-artifacts/architecture.md#authentication--security)
- **Epics:** [§ Story 2.8](../../_bmad-output/planning-artifacts/epics.md#story-28-pii-fields-encrypted-at-rest)
- **Previous stories:** [1.1](./1-1-admin-logs-into-the-system.md) (ADR-0001 template + CI workflow), [2.1](./2-1-office-staff-creates-a-customer-record.md) (govIdNumber as `v.string()`; references ADR-0007), [2.2](./2-2-office-staff-uploads-identification-documents.md) (File Storage), [2.3](./2-3-pii-access-is-logged-on-every-read.md) (`readPii`)
- **Convex security documentation (verify at implementation time):**
  - https://docs.convex.dev/production/security (Convex production hardening doc)
  - https://www.convex.dev/security (Convex security marketing / trust center)
  - Convex Trust Center (if published)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT implement application-level encryption.** Adding `v.bytes()` fields, AES-GCM encrypt-on-write, KMS DEK rotation, or any envelope-encryption layer is explicitly rejected by this ADR. The whole point of the story is to formalize the NOT-doing.
- ❌ **Do NOT skip the verification step.** Writing the ADR without checking Convex's current docs creates a stale-and-wrong artifact. The verification line + date is the artifact that satisfies a future auditor.
- ❌ **Do NOT include private contract / SLA text verbatim in the ADR.** If verification comes from a private channel, cite by reference only (date, source-type) and store the verbatim text in a separate access-controlled file outside the repo.
- ❌ **Do NOT silence the CI check** with `// eslint-disable` or `if (process.env.SKIP) return`. If the check is wrong, fix the check; don't bypass it.
- ❌ **Do NOT delete ADR-0001, ADR-0006, or any prior ADR** while adding 0007. Each ADR stands alone; new ADRs supersede only via an explicit `Supersedes: ADR-000X` line, never via deletion.
- ❌ **Do NOT change `govIdNumber` to `govIdNumberBytes` or any other "would be encrypted" rename.** The decision is to keep the string field exactly as Story 2.1 designed.
- ❌ **Do NOT add a `convex/lib/crypto.ts` file** even as a stub. There is no application-level crypto layer in Phase 1.
- ❌ **Do NOT remove the redaction logic in `emitAudit`** (Story 1.6). Audit-log redaction is a SEPARATE concern from at-rest encryption. The audit log's PII redaction stays in place regardless of encryption posture; the encryption protects the canonical customer record, the redaction protects the audit log.

### Common LLM-developer mistakes to prevent

- **"Implementing" a documentation story:** the deliverable is the ADR + threat-model + CI check + docs. The agent's instinct will be to add code; resist. The absence-of-code-changes is the design.
- **Plagiarizing Convex's docs verbatim**: short quotes (a sentence or two) for verification are fair-use citation; copying the entire page is not. Quote the minimum necessary line + link.
- **Wrong ADR numbering:** the project's ADRs are numbered sequentially; 0006 is `postFinancialEvent` per the architecture's planned sequence (§ 826–831). This story is ADR-**0007**. If a prior story has already taken 0007 for something else, coordinate and rename — do NOT collide.
- **Mixing PII-at-rest with PII-in-transit:** in-transit encryption (HTTPS via Vercel + Convex) is a separate concern, handled by NFR-S1 / infrastructure layer. The ADR should NOT cover in-transit; that's out of scope.
- **Confusing PII-access logging with PII encryption:** these are independent guarantees. `readPii` (Story 2.3) logs WHO read WHEN. At-rest encryption (this story) protects the underlying bytes. The ADR should clarify the distinction.
- **Putting the CI check at the wrong level:** the check is a build-time guard, not a runtime guard. It belongs in `.github/workflows/ci.yml`, not in `convex/` or `src/`.
- **Forgetting to date the verification:** every audit trail needs a date. The ADR must state when the verification was performed. A six-month-old verification is stale.

### Open questions / blockers this story does NOT resolve

- **§10 Q1–Q10:** none of the open questions affect this story. PII encryption posture is independent of installment policy, lot types, receipt format, etc.
- **Future Convex pricing-tier changes:** if the cemetery downgrades to a Convex tier that doesn't include the same encryption posture, the ADR's "future revisit triggers" section covers the trigger but does not resolve it. Operational concern, not a story blocker.

### Project Structure Notes

Aligns with:
- [Architecture § Project Structure & Boundaries > docs / adr (line 824)](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure) — ADRs live in `docs/adr/`. Architecture lists ADRs 0001–0006 explicitly; this story adds 0007.
- [Architecture § Project Structure & Boundaries > docs / threat-model (line 835)](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure) — referenced but not implemented; this story creates the file.
- [Architecture § Authentication & Security > PII encryption (line 289)](../../_bmad-output/planning-artifacts/architecture.md#authentication--security) — the decision this story formalizes.

No detected conflicts. The repository structure already accommodates this story; the only "new directory" is `scripts/`, which several future stories will populate (data migrations, ops tools).

### References

- [PRD § Functional Requirements > FR65](../../_bmad-output/planning-artifacts/prd.md#functional-requirements)
- [PRD § Non-Functional Requirements > NFR-S2](../../_bmad-output/planning-artifacts/prd.md#security--privacy)
- [Architecture § Authentication & Security > PII encryption (line 289)](../../_bmad-output/planning-artifacts/architecture.md#authentication--security)
- [Architecture § Project Structure > docs / adr / threat-model](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries)
- [Epics § Story 2.8](../../_bmad-output/planning-artifacts/epics.md#story-28-pii-fields-encrypted-at-rest)
- Previous stories: [1.1](./1-1-admin-logs-into-the-system.md) (ADR-0001 template + CI workflow), [2.1](./2-1-office-staff-creates-a-customer-record.md), [2.2](./2-2-office-staff-uploads-identification-documents.md), [2.3](./2-3-pii-access-is-logged-on-every-read.md)
- Convex docs (verify current at implementation): [Production security](https://docs.convex.dev/production/security) · [Trust center](https://www.convex.dev/security)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (claude-opus-4-7), invoked autonomously under Story 2.8's documentation-and-verification scope.

### Debug Log References

- Shell access (Bash / PowerShell) was denied in the dev environment, so the four gates (typecheck / lint / test / build) and the new `npm run check:adr-0007` script were **not executable locally** during this implementation. The script is deterministic and zero-dependency (Node built-ins only); the next reviewer should run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run check:adr-0007` to validate the four gates plus the new compliance check.
- The unit test (`tests/unit/scripts/check-adr-0007.test.ts`) materializes a temp-dir fixture per case and invokes the real `scripts/check-adr-0007.js` via `node` subprocess, so it exercises the actual script binary rather than a re-import. This validates the production path used by the CI step.

### Completion Notes List

- Story scope as specified (documentation-and-verification, no code/crypto). The whole point of the story is to formalise the existing decision via ADR + threat model + CI guard; the disaster-prevention section explicitly forbids creating `convex/lib/crypto.ts`, renaming `govIdNumber*` fields, or otherwise introducing an application-level encryption layer.
- **Verification source for ADR-0007.** Convex's public security posture (https://docs.convex.dev/production/security + https://www.convex.dev/security) was used as the verification anchor; verified-by date `2026-05-18` is recorded in the ADR's Verification section. The ADR notes that the verification source is to be re-checked at every annual security review and lists the future revisit triggers explicitly.
- **No production schema diff.** `convex/schema.ts`, `convex/customers.ts` (field types), `customerDocuments` schema — all unchanged. `convex/customers.ts` and `convex/lib/piiAccess.ts` received JSDoc cross-link additions ONLY (non-functional comments pointing at ADR-0007). The CI check `scripts/check-adr-0007.js` enforces that `v.bytes()` cannot land on the PII tables without an explicit `[adr-0007-amend]` marker.
- **CI integration.** The compliance check is wired into the existing `typecheck` job (post-`npm run typecheck` step) so it runs without an extra dependency-install pass.
- **Threat model + runbook.** `docs/threat-model.md` is the first version of that file (architecture § 835 referenced it but no prior story created it). `docs/runbook.md` is also the first version — only the PII-encryption section exists today; future stories (5.5, 5.6, 5.7, 6.6, etc.) will expand it.
- **Sprint-status update.** `_bmad-output/implementation-artifacts/sprint-status.yaml` updated: `2-8-pii-fields-encrypted-at-rest: review`; `last_updated: 2026-05-18`.

### File List

Created:

- `docs/adr/0007-pii-encryption.md`
- `docs/threat-model.md`
- `docs/runbook.md`
- `scripts/check-adr-0007.js`
- `tests/unit/scripts/check-adr-0007.test.ts`

Modified:

- `.github/workflows/ci.yml` — added "ADR-0007 compliance check" step inside the `typecheck` job.
- `package.json` — added `check:adr-0007` script alias.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — status flip + last_updated bump.
- `convex/customers.ts` — JSDoc header gained a "PII encryption posture (Story 2.8 / ADR-0007)" paragraph cross-linking to the ADR. No code changes.
- `convex/lib/piiAccess.ts` — JSDoc header gained an "Encryption-at-rest boundary (Story 2.8 / ADR-0007)" paragraph cross-linking to the ADR. No code changes.

Files explicitly NOT created (per the story's Disaster Prevention section):

- `convex/lib/crypto.ts` — forbidden; the Phase 1 decision is plaintext-at-the-application-layer.
- `convex/schema.ts` field-shape changes — `govIdNumber` stays as `v.string()`; no rename to `govIdNumberBytes`.
