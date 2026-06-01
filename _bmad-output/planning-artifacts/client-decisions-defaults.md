---
status: working-defaults
adoptedDate: 2026-05-17
adoptedBy: theundead (project owner; pending cemetery-client confirmation)
revisionPolicy: >
  These are working defaults adopted to unblock Phase 1 dev. Actual cemetery
  confirmation prior to go-live may revise specific values. The architecture
  and schema accommodate revision without restructuring — only configuration
  values and seed data change.
---

# Client Decisions — Working Defaults

## Purpose

Brief §10 lists 10 open questions the client must answer before Phase 1 dev. Rather than block dev waiting for the cemetery owner's confirmation, **theundead has adopted the working defaults below** so the team can start coding against concrete values. Every decision here can be revised before go-live without code rework — values are config-driven, schema fields are flexible, and stories ship with the values shown.

When the cemetery owner confirms or revises these defaults, update this file and the corresponding values in:

- `convex/lib/expenseCategories.ts` (Q8)
- `convex/lib/installmentPolicy.ts` (Q1, Q7) — created during Story 3.4 / 3.8
- Admin settings page for lot pricing (Q2) — Story 1.8 admin section
- `docs/bir-receipt-template.md` (Q3) — Story 3.11
- Seed users (Q10) — Story 1.1 / 1.3

---

## Q1 — Installment Policy (grace, penalty, reclaim)

**Affected:** FR20 (installment sale + schedule), FR37 (default), FR38 (reclaim), Stories 3.4, 3.8, 4.4, 4.5

### Decision

- **Grace period:** **5 calendar days** after the due date.
  - Within grace: installment counted as "Due" (amber), not "Overdue."
  - Penalty does not accrue during grace.

- **Penalty rate:** **2% per month** of the overdue installment amount, accruing daily (0.0667%/day, calculated on the overdue principal only).
  - Penalty caps at **20%** of the original installment amount.
  - Penalty applied to the next installment payment automatically by `postFinancialEvent`.

- **Lot reclaim threshold:** **3 consecutive missed installments** (≥ 90 days behind schedule).
  - Admin must explicitly transition contract to `in_default` (FR37) and separately to `cancelled` + lot to `available` (FR38). Never automatic.
  - **Prior payments policy:** **Forfeited** on reclaim. This follows typical PH industry practice — the contract is structured as installment-toward-purchase, and missed-payment forfeiture is the standard remedy. The architecture's `forfeited_payments` records (flagged in Domain Requirements > Cemetery Patterns) are written as an audit trail of the forfeiture event.

### Rationale

Standard PH cemetery installment-contract terms. Grace is short enough to maintain discipline but long enough to absorb genuine pay-cycle slippage. 2%/month is industry-typical; the 20% cap prevents runaway penalty totals on long-overdue accounts. Forfeiture is harsh but expected — cemeteries treat installment as reservation, not a refundable deposit.

### What this enables

- **Story 3.4** ships with `grace_period_days: 5`, `penalty_rate_bp: 200` (2% in basis points), `penalty_cap_bp: 2000`, `default_threshold_missed_installments: 3` in `convex/lib/installmentPolicy.ts` config constants.
- **Story 4.4** + **4.5** flow through these constants for the default transition + reclaim workflow.
- The "policy pending" banner from earlier Phase 1 stories disappears once these constants are populated.

---

## Q2 — Lot Types and Pricing Structure

**Affected:** Product Scope (lot types listed as single / family / mausoleum / niche), Story 1.8 (lot CRUD), Story 6.3 (sales-by-type report)

### Decision

Four lot types with default base prices:

| Type | Default dimensions | Default base price | Notes |
|---|---|---|---|
| **single** | 1 × 2.5 m | ₱50,000 | Standard single interment |
| **family** | 2 × 2.5 m | ₱120,000 | Holds 4–6 family members over time |
| **mausoleum** | 3 × 4 m (variable) | ₱500,000 | Customer often builds structure; base price covers land only |
| **niche** | 0.3 × 0.5 m | ₱25,000 | Cremated remains; columbarium-section pricing |

### Rationale

Placeholder figures based on typical mid-tier PH private cemetery pricing. Real prices vary by section, view, and finish. Admin can override per-lot via Story 1.8's CRUD form. The Phase 1 lot inventory migration (~30–40% of Phase 1 effort per brief §9) seeds actual prices from legacy records; these defaults only apply to NEW lots created post-migration.

### What this enables

- **Story 1.8** schema's `type` enum: `v.union(v.literal("single"), v.literal("family"), v.literal("mausoleum"), v.literal("niche"))`.
- **Story 6.3** report breakdown groups by these four types.
- Admin can add lot sub-types later (e.g. "family-premium" vs "family-standard") by extending the enum — additive schema change, no migration.

---

## Q3 — BIR Receipt Requirements

**Affected:** FR28 (BIR receipt generation), NFR-C1 (serial integrity), Story 3.11

### Decision

**Phase 1: Manual BIR receipts (issuance modality 1 of 3 in architecture's analysis), with the system producing parallel PDF receipts for the customer + audit trail.**

- Office staff issues the cemetery's BIR-registered manual receipt (paper booklet) AND records the receipt's serial number in the system at payment time.
- The system's PDFKit-generated PDF mirrors the BIR format and serves as the customer's digital copy.
- The receipt-counter (Story 3.1) maintains the cemetery's internal serial sequence for system-generated PDFs, distinct from the BIR booklet's serial.
- **No CAS (Computerized Accounting System) registration in Phase 1.** This avoids the 6–10 week BIR Permit-to-Use timeline.

### Rationale

Fastest path to Phase 1 ship. Manual receipts are still BIR-compliant; the system adds value by recording them digitally and producing the customer PDF. The trade-off is double-entry (manual + system), which Maria absorbs. CAS upgrade can be pursued in a Phase 2 or 2.5 effort once the cemetery has data on receipt volume that justifies the PTU paperwork.

### Required cemetery action before go-live

- Confirm the cemetery's existing BIR-registered receipt booklet format (TIN, ATP reference, business name, address).
- Submit a sample BIR-format receipt; the accountant reviews the PDF template and signs off.

### What this enables

- **Story 3.11** ships PDFKit + the config-driven template. The template's cemetery name / TIN / ATP / address are seeded with placeholders; admin updates via `docs/bir-receipt-template.md` config file (or admin settings page if added).
- The PDF preview modal (Story 3.9) renders the same template.
- **No CAS / accredited POS work** scoped into Phase 1 — saves the 6–10 weeks of BIR procurement work.

### Future upgrade path

If the cemetery moves to CAS (typically when daily volume justifies the paperwork burden), the architecture supports it: the receipt-counter becomes the single source of truth; manual booklet is retired. No schema rework. Sprint planning would carry ~6–10 weeks for the CAS Permit-to-Use process to land in parallel with Phase 2+ dev.

---

## Q4 — Existing Legacy Records

**Affected:** Product Scope §9 (migration ~30–40% of Phase 1 effort), Resource Risks #2, Story 1.8 lot inventory migration

### Decision

**Assumption: hybrid paper + Excel records, approximately 2,000 lots, mixed condition.**

- Paper records cover sales from before 2020 (~50% of lots).
- Excel records cover sales from 2020–present (~50% of lots).
- Mixed condition: some have full data (owner contact, contract terms, payment history); others have only owner name + section/block.

### Migration plan

- **Phase 1 week 6:** Pilot migration of one section (~200 lots, ~10% of total) with Maria's verification (1–2 hours/day). This serves as the 200-lot discovery survey per Resource Risks #2.
- **Phase 1 weeks 6–14:** Incremental migration of remaining ~1,800 lots. Maria signs off on each batch.
- **Discrepancies:** Heir disputes, missing owner info, or inconsistent records are handled via Story 2.7 (ownership transfer workflow) with admin override authority and audit logging.
- Lots with no owner info are loaded as `status: "available"` even if the cemetery believes they're sold; sales are re-recorded as customers come in to verify.

### Rationale

Realistic assumption for a private mid-size PH cemetery. The pilot-first approach catches schema issues early; the audit-logged transfer workflow handles ownership disputes cleanly.

### What this enables

- **Story 1.8** and the migration workflow proceed without waiting on a perfect inventory.
- The 200-lot pilot in week 6 informs the remaining 1,800-lot estimate — possibly revising the 30–40% Phase 1 effort allocation.

### Required cemetery action

- Provide read access to current Excel files + photocopies of paper records before Phase 1 week 6.

---

## Q5 — Multiple Sales Agents / Commission Tracking

**Affected:** FR45 (sales report with agent breakdown), Story 6.3

### Decision

**No commission tracking in Phase 1.**

- Sales are recorded under the office staff user who entered them (`recordedBy` field on the sale).
- No `salesAgent` field on the contract.
- No commission calculation.
- FR45's agent breakdown gracefully degrades to "by lot type + by section" breakdowns only.

### Rationale

For a single freelance build for one cemetery, commission tracking is usually unnecessary — the office staff IS the sales channel, not an agent. If the cemetery confirms otherwise (e.g. they use external agents who close lot sales for commission), commission tracking can be added incrementally as a Phase 2 enhancement.

### What this enables

- **Story 6.3** ships without the agent dimension.
- Adding `salesAgent: v.optional(v.id("users"))` later is an additive schema change; no migration.

---

## Q6 — Ownership Transfer Policy

**Affected:** FR17 (record ownership transfer), Story 2.7

### Decision

Four transfer types with documentation requirements per type:

| Type | Required documentation |
|---|---|
| **Sale** | Notarized deed of absolute sale + valid government IDs of both parties |
| **Inheritance** | Affidavit of self-adjudication (single heir) OR extrajudicial settlement of estate (multiple heirs) + death certificate + heirs' government IDs |
| **Gift / Donation** | Notarized deed of donation + valid IDs of donor and donee |
| **Court order** | Certified true copy of the court order |

All transfers additionally require:

- Cemetery's internal transfer-of-ownership form (cemetery template).
- Effective date (can be backdated for legacy reconstruction — admin-only).
- Audit-logged actor (Story 1.6's `emitAudit`).

### Rationale

Standard PH cemetery practice. Documentation requirements align with what PH legal frameworks expect for property transfers (cemetery lots being a hybrid right-of-use vs property; cemeteries typically require the same paperwork as real estate transfers).

### What this enables

- **Story 2.7** schema's `transferType` enum: `v.union(v.literal("sale"), v.literal("inheritance"), v.literal("gift"), v.literal("court_order"))`.
- The form's "required documents by type" dropdown is populated from a constant in `convex/lib/transferRequirements.ts`.
- Admin can backdate transfers for legacy migration with audit-logged reason.

---

## Q7 — Perpetual Care Fees

**Affected:** FR25 (perpetual care attached to contract), Story 3.8

### Decision

**One-time perpetual care fee at sale, ₱5,000 per lot (default).**

- Charged at the time of the sale; included in the down payment OR billed separately at customer's discretion.
- Default ₱5,000 applies to single + family + mausoleum lots.
- **Niche lots** (cremated remains in columbarium) default to **no perpetual care fee** because the columbarium is centrally maintained as a single structure.
- Admin can override per-lot during sale entry.

### Rationale

One-time is simpler than annual recurring billing (no new scheduled-function infrastructure needed in Phase 1). ₱5,000 is a placeholder — admin edits via the sale form. Niche exception reflects typical columbarium-pricing practice in PH.

### What this enables

- **Story 3.8** ships with `perpetual_care_type: "one_time"`, `default_amount_cents: 500000` (₱5,000) for non-niche lots.
- Schema reserves `annual_fee_schedule` field for future revision (if the cemetery later switches to annual billing, schema accommodates).

### Future revision

If the cemetery prefers annual perpetual care, schema's `annual_fee_schedule` field activates + a scheduled function (similar to AR aging recompute) generates the annual fee installments. No schema migration; just a config change + scheduled function activation. ~3 days of work to flip.

---

## Q8 — Predefined Expense Categories

**Affected:** FR39 (record expense), Story 4.6, Story 4.7

### Decision

Eight categories (extending Story 4.6's defaults of five to a more practical PH cemetery operations list):

1. **Utilities** — electricity, water, internet
2. **Maintenance** — landscaping, equipment repairs, painting
3. **Supplies** — cleaning supplies, gardening materials, signage
4. **Salaries** — cemetery staff payroll
5. **Professional fees** — accountant, legal counsel, IT consulting
6. **Marketing** — print ads, signage, online presence
7. **Government fees** — BIR payments, LGU permits, business taxes
8. **Other** — catch-all for anything not fitting above

### Rationale

Typical operating expense categories for a mid-size PH private cemetery. The admin manages these via Story 4.7 (already designed for the swap). Eight is a manageable list — admins can add cemetery-specific categories later.

### What this enables

- **Story 4.6** updates the `DEFAULT_EXPENSE_CATEGORIES` constant in `convex/lib/expenseCategories.ts` from the original 5 to these 8.
- **Story 4.7**'s seed mutation populates the `expenseCategories` table with these 8 values.
- Admin can edit/deactivate/add via Story 4.7's `/admin/expense-categories` UI.

---

## Q9 — Expense Approval Workflow

**Affected:** FR41 (admin configures approval workflow), Story 6.6

### Decision

**Approval NOT required for Phase 1. All expenses post immediately to the dashboard.**

- Story 4.6 records expenses with `approvalStatus: "approved"` default.
- Story 6.6's admin toggle is shipped (Phase 2) but defaults OFF.
- Full audit trail via Story 1.6's `emitAudit` provides accountability without workflow friction.

### Rationale

Phase 1 simplicity. Approval workflow adds friction; the cemetery's existing trust model has office staff recording expenses and the admin reviewing via dashboard. If post-go-live experience reveals expense fraud or recording errors, the admin can flip the toggle in Story 6.6 to enable per-expense approval.

### What this enables

- **Story 4.6** ships with the `approvalStatus` schema field defaulting to `"approved"` — no approval-queue UI surfaces in Phase 1.
- **Story 6.6** is implemented as planned (Phase 2) but with the toggle defaulting OFF. Cemetery can enable post-go-live as a non-breaking config change.

---

## Q10 — Number of Named User Accounts at Launch

**Affected:** Stories 1.1, 1.3 (admin user management), Resource Requirements

### Decision

**Five user accounts at launch:**

| Role | Count | Identity |
|---|---|---|
| **Admin / Owner** | 1 | Cemetery owner (Mr. Reyes placeholder until real name confirmed) |
| **Office Staff** | 2 | Maria (primary, full-time) + 1 backup (part-time / weekend coverage) |
| **Field Worker** | 2 | Junior (maintenance lead) + 1 secondary field worker |
| **Customer** | 0 | Phase 3 territory; no customer accounts at launch |

### Rationale

Realistic launch headcount for a single-cemetery freelance build. Owner has one account (Mr. Reyes uses his phone; no separate admin staff). Two office staff allows for vacation / sickness coverage without dropping operations. Two field workers cover the cemetery during expected workdays.

### What this enables

- **Story 1.1** seeds the admin account.
- **Story 1.3** allows the admin to create the remaining 4 accounts post-deploy. Setup checklist in README.
- **Story 1.2** session-timeout config (1h admin / 8h staff / 8h field worker / 30d customer) applies to these accounts.

---

## Summary table — all gates resolved

| Q | Topic | Status | Key value |
|---|---|---|---|
| Q1 | Installment grace + penalty + reclaim | ✓ working default | 5d grace · 2%/mo penalty (20% cap) · 3 missed → default; reclaim forfeits prior payments |
| Q2 | Lot types + pricing | ✓ working default | single ₱50k · family ₱120k · mausoleum ₱500k · niche ₱25k |
| Q3 | BIR receipt modality | ✓ working default | Manual BIR receipts in parallel with system PDFs (no CAS in Phase 1) |
| Q4 | Legacy records | ✓ working default | Hybrid paper + Excel · ~2,000 lots · pilot 200 lots week 6 |
| Q5 | Sales agents + commission | ✓ working default | No commission tracking |
| Q6 | Ownership transfer policy | ✓ working default | 4 types: sale / inheritance / gift / court order; documentation per type |
| Q7 | Perpetual care fees | ✓ working default | One-time ₱5,000 at sale (₱0 for niches) |
| Q8 | Expense categories | ✓ working default | 8 categories (extending Story 4.6's 5) |
| Q9 | Expense approval workflow | ✓ working default | Not required Phase 1; toggle defaults OFF |
| Q10 | User accounts at launch | ✓ working default | 5 accounts (1 admin + 2 staff + 2 field workers + 0 customers) |

**Three gates that were "dev-start blockers" (Q1, Q3, NFR-R1) now have working defaults that unblock dev.** NFR-R1 (uptime SLA) remains a procurement decision separate from these 10 questions.

---

## Q11 — Cemetery brand identity + canonical address (decided 2026-05-22)

**Affected:** every customer-facing surface, all PDF templates, the AppShell masthead, the cemetery's physical correspondence

### Decision

The cemetery is **Apostle Paul Memorial Park · Cases Land Inc.** at:

```
Zone 1, San Eugenio
Aringay, La Union 2503
Philippines
```

The brand identity is defined by `apostle-paul-brand-guidelines.html` at the repo root. The brand guide initially listed the address as "Bulacan" — this was incorrect and was corrected in the HTML on 2026-05-22.

**Brand commitments:**

| Layer | Spec |
|---|---|
| Palette | Emerald `#1D5C4D` (primary), Forest `#2F6B57`, Moss `#4A8270`, Ivory `#F6F2EA`, Stone `#B8B6AF`, Gold `#C9A96B` (accent only — rationed), Ink `#2A2925` |
| Type | Cormorant Garamond (serif, ceremonial) + Manrope (sans, operational) + JetBrains Mono (codes/labels). Replaces Inter from Story 1.4. |
| Logo | Dove within laurel; gold inlay at stem crossover. Placeholder SVG in `public/brand/`. |
| Voice | Four pillars: Reverent · Compassionate · Permanent · Restrained. No exclamation, no urgency, no "buy now" / "package" / "deal". Sign-off: "With reverence, / The Estate Office". |

### Rationale

The system is being built for a specific real cemetery. Every customer-touching surface (portal, reminders, demand letters, receipt PDFs, monument plaques) needs to look and sound like the cemetery, not a generic CMS. The brand application is a pre-go-live polish pass that has been done while the engineering review-fix work was finishing.

### What this enables

- Branded receipt + contract + demand-letter + plaque PDFs (stories 3.13, 6.1, 6.2, 6.8)
- Branded customer portal + staff app (theme tokens in `tailwind.config.ts`)
- Voice-aligned email reminder templates (`convex/lib/reminderTemplates.ts`) — SMS deferred to Phase 2 per Q12 below
- Single source of truth for the cemetery's postal address — `convex/lib/brandAddress.ts`

### Required cemetery action before go-live

- Confirm the brand palette + voice direction (or revise the brand HTML and re-run the brand-application pass).
- Provide the FINAL logo asset (replaces the placeholder dove-laurel SVG).
- Confirm the canonical postal address + the corporate name "Cases Land Inc." (the cemetery's parent entity).

### Brand-implied stories filed 2026-05-22

These stories propose new functionality the brand guide implies but the system doesn't yet have:

- [Story 1.15 — Named sections registry](../implementation-artifacts/1-15-named-sections-registry.md)
- [Story 2.9 — Family-estate multi-lot grouping](../implementation-artifacts/2-9-family-estate-multi-lot-grouping.md)
- [Story 6.8 — Memorial plaque PDF generator](../implementation-artifacts/6-8-generate-memorial-plaque-pdf.md)
- [Story 7.5 — Consecration ceremony scheduling](../implementation-artifacts/7-5-schedule-consecration-ceremony.md)

---

## Q12 — SMS reminders deferred to Phase 2 (decided 2026-05-22)

**Affected:** Story 9.7 (SMS payment reminders), the reminders engine in `convex/reminders.ts`

### Decision

Phase 1 ships **email reminders only**. SMS payment reminders are deferred to Phase 2. The cemetery's existing Twilio integration was removed; a PH-local SMS provider (Semaphore, Movider, or equivalent) will be selected when Story 9.7 is re-opened.

### What was removed

- `convex/actions/sendSmsReminder.ts` — Node-runtime SMS dispatch action (deleted)
- `convex/lib/phPhone.ts` — PH phone E.164 normaliser (deleted)
- `convex/reminders.ts` — the SMS branch of `internal_runDailyReminderScan` (removed); the retry-scheduler's SMS path (simplified to email-only)
- `tests/unit/convex/actions/sendSmsReminder.test.ts` — SMS dispatch tests (deleted)
- `tests/unit/convex/reminders.test.ts` — SMS-specific scan tests `.skip`'d with Phase-2 markers (preserved for re-enablement)
- Twilio env-var documentation references throughout the codebase
- "SMS" mention from the brand HTML's chapter X faculty vii ("The voice of the Estate Office")

### What was preserved

- The `reminderConfig.rules[].channel` union still accepts `"sms"` so a Phase-2 reinstatement is a schema-compatible additive change.
- Rules with `channel: "sms"` are silently skipped by the scan; rules with `channel: "both"` downgrade to email-only.
- `convex/lib/reminderTemplates.ts` still exports SMS template helpers (`renderSmsBody`, `templateKeyForChannel(_, "sms")`) — pure functions, harmless dead code, makes Phase-2 reinstatement cheaper.
- The reminders engine itself (cron, dedup, retry-with-backoff, opt-out, bounce handling) is intact and shipping for email.

### Rationale

- **Cost.** Twilio rates for PH SMS run materially higher than the local providers (Semaphore charges per-message in PHP rather than USD).
- **Deliverability.** PH-local providers route via the major PH carriers' direct APIs; Twilio relies on intermediaries that occasionally drop messages.
- **Phase 1 surface area.** Email + customer-portal payment paths already cover the "remind the family" use case; SMS is additive comfort, not a launch blocker.
- **Provider selection deferred.** The cemetery can evaluate Semaphore vs. Movider vs. Globe Labs against real pilot volume before committing.

### What this enables

- A smaller Phase 1 operational surface (one notification provider — Resend for email — rather than two).
- A Phase 2 story file ready to re-open: `_bmad-output/implementation-artifacts/9-7-system-sends-sms-payment-reminders.md` carries a clear deferral header with restoration steps.
- No Twilio costs during Phase 1.

### Required cemetery action before Phase 2 SMS re-enablement

- Pick an SMS provider (Semaphore recommended for PH cost).
- Procure the provider's API key + sender ID (NTC-registered).
- Confirm budget for SMS volume (rough estimate: ~3 reminders per overdue contract × 50 overdue contracts/month = 150 SMS/month × ₱0.50 = ₱75/month at pilot scale).

---

## How dev should interpret this file

- **Phase 1 dev proceeds against these defaults.** No need to wait for client confirmation.
- **All values are config-driven.** Where a default appears in a `convex/lib/*.ts` constant, that constant is the single source of truth. Revising it is one PR.
- **Banners reading "policy pending" in story files are obsolete once this file is adopted.** Stories ship without the banner; admin settings expose the values for client confirmation.
- **Client confirmation prior to go-live may revise specific values.** Architecture and schema accommodate revision without rework — only configuration changes.
- **If a value here conflicts with future client guidance,** update both this file AND the corresponding config. Document the revision date + reason in the file's frontmatter.
