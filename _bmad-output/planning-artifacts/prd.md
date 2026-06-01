---
stepsCompleted: ['step-01-init', 'step-02-discovery', 'step-02b-vision', 'step-02c-executive-summary', 'step-03-success', 'step-04-journeys', 'step-05-domain', 'step-06-innovation-skipped', 'step-07-project-type', 'step-08-scoping', 'step-09-functional', 'step-10-nonfunctional', 'step-11-polish', 'step-12-complete']
completedAt: 2026-05-17
releaseMode: phased
inputDocuments:
  - cemetery-management-system-brief (1).md
documentCounts:
  briefs: 1
  research: 0
  brainstorming: 0
  projectDocs: 0
workflowType: 'prd'
projectType: 'greenfield'
classification:
  projectType: web_app
  domain: cemetery_operations
  complexity: medium
  projectContext: greenfield
  notes: >
    Custom domain label; closest standard is 'general'. Medium complexity is
    driven by BIR (Philippines) receipt compliance, installment-contract
    financial integrity, PII (gov ID) handling, and 2,000+ lot geospatial
    viewport queries on mobile over 4G. Complexity may escalate to high if
    BIR accredited-POS integration lands in Phase 1 (see brief §10 Q3).
---

# Product Requirements Document - cemetery-mapping

**Author:** theundead
**Date:** 2026-05-17

## Document Conventions

- **Source of truth:** This PRD supersedes the project brief ([cemetery-management-system-brief (1).md](../../cemetery-management-system-brief%20(1).md)) for product decisions. References to brief §X point to the original brief for context.
- **Phase tags:** `[P1]` = Phase 1 / MVP, `[P2]` = Phase 2 / Growth, `[P3]` = Phase 3 / Vision. Phase definitions live in the Product Scope section.
- **Open-question gates:** `gated on §10 Q#` means the FR or NFR carries a behavior that needs a client answer to one of the 10 open questions in brief §10 before final dev. Consolidated list in the Open Questions Summary section at the end.
- **FR / NFR numbering:** FRs are sequentially numbered (FR1–FR65) across all capability areas, not restarted per area. NFRs are prefixed by category (NFR-P, NFR-S, NFR-R, NFR-A, NFR-I, NFR-C, NFR-M).
- **Downstream consumers:** UX Designer (journeys → flows), Architect (FRs + NFRs + Domain → systems), SM (FRs + Product Scope → epics & stories), Dev (FRs + NFRs → implementation).

## Executive Summary

A web-based operational platform that replaces the paper-and-spreadsheet workflows of a private 2,000+ lot cemetery in the Philippines. The system consolidates lot inventory, customer and ownership records, sales (full-payment and installment), payment intake with BIR-compliant receipts, installment-contract AR tracking, and basic operating-expense capture into a single Next.js + Convex application. Office staff work primarily from desktop; field workers use the same app in a mobile browser. Ownership gets live financial visibility — sales, collections, AR aging, expenses, and net position — without waiting on month-end reconciliation.

The product is built for one specific cemetery client, but every architectural decision treats Philippines context (BIR receipts, GCash/Maya in Phase 3, peso-denominated installment contracts) as first-class rather than a localization afterthought.

### What Makes This Special

- **One reactive system, not four.** A single Convex schema collapses what would otherwise be a separate map, CRM, AR ledger, and expense tracker into one document model. Convex's reactive queries mean office staff and field workers see the same lot, contract, and payment state update live without manual refresh or websocket plumbing.
- **Installment AR is core, not an add-on.** Most generic cemetery or POS tools treat installment contracts as bolted-on extensions of a sale record. Here, contract state and AR aging ship in Phase 1 because that's where the cemetery's actual money sits.
- **PH-localized from the schema up.** BIR-compliant receipt formatting in Phase 1, GCash/Maya/card in Phase 3, peso-denominated contracts with configurable grace and penalty rules. Off-the-shelf alternatives (CIMS, PlotBox, byondpro) are built for US/UK markets and don't satisfy BIR out of the box.
- **Map designed for field workers, schema-ready from day one.** Phase 1 ships an office-staff lot-management view, with the field-worker mobile payoff arriving in Phase 2 once GPS coordinates are surveyed. Every lot carries lat/lng centroid and polygon vertices from the first migration, so the Phase 2 switch to Leaflet is a rendering swap — not a data migration.

**Core insight:** The bottleneck for this cemetery isn't recording lots, contracts, or payments — paper already does that. It's correlating them in real time so the owner sees the business as a business and a field worker can locate a lot without finding the staffer who memorized the layout. A single reactive document model is the technical answer to a workflow-integration problem.

## Project Classification

- **Project Type:** Responsive web application (Next.js App Router + TypeScript, mobile-browser optimized, PWA cache for field-worker lot lookup)
- **Domain:** Cemetery operations — closest standard classification is "general operations management," elevated by BIR receipt compliance, installment-contract financial integrity, customer PII (government ID) handling, and 2,000+ lot geospatial scale on mobile over 4G
- **Complexity:** Medium — may escalate to high if BIR accredited-POS integration lands inside Phase 1 (see brief §10 Q3)
- **Project Context:** Greenfield build with in-scope migration of legacy paper / Excel records (estimated 30–40% of Phase 1 effort per brief §9)
- **Stack (confirmed):** Next.js (App Router, React, TS) frontend on Vercel; Convex for backend, database, auth, file storage, and scheduled jobs; Leaflet + OpenStreetMap/Mapbox for the Phase 2 map rendering layer

## Success Criteria

### User Success

- **Office staff** can record a sale (full-payment or installment), generate a BIR-compliant receipt, and have the lot status + customer record updated in a single transaction — no double-entry into a separate ledger or spreadsheet.
- **Office staff** can answer "what's the status of contract X" — current balance, next due date, payment history, aging bucket — without opening another system or recalculating in Excel.
- **Field workers** (Phase 1) can look up any lot by ID, section/block, or owner name on a phone browser in **< 5 seconds** and see status, owner, and contract state. The < 30s "stand in the cemetery and locate this physical lot" metric moves to Phase 2 when GPS lands.
- **Ownership** can pull MTD/YTD sales, collections, AR aging, and expense totals from a dashboard at any time — not waiting on staff to assemble a report.
- **Aha moment:** the owner refreshes the dashboard mid-day and sees a payment that was just collected in the field — that is the reactive-system payoff.

### Business Success

- **Paper elimination:** within 30 days of go-live, 100% of new transactions (sales, payments, expenses) are entered through the system. No parallel paper ledger.
- **Lot digitization:** 100% of active lots digitized within 60 days of go-live, including status, owner (if any), and contract linkage.
- **AR discipline:** < 5% of installment contracts past due without a logged follow-up action within 90 days of go-live (no contracts silently aging).
- **Monthly financial close:** produce sales / collections / expenses / net-position view for any month within 1 hour of month-end close, with zero manual spreadsheet work.
- **Owner-driven question latency:** any ownership question of the form "what is our position on X" (cash collected this month, AR over 60 days, top expense category) is answerable in < 30 seconds from the dashboard.

### Technical Success

- **Map performance:** the 2,000+ lot map renders and remains interactive on a mid-range Android phone over 4G — first paint < 3s, pan/zoom stays at ≥ 30fps (Phase 1 with static/SVG; Phase 2 with Leaflet viewport queries).
- **Financial atomicity:** every payment-posting writes the payment record, updates the contract balance, generates the receipt, and creates the audit-log entry inside a single Convex mutation. No partial states observable to other clients.
- **Audit coverage:** 100% of financial-touching mutations (sales, payments, contract state changes, expense entries, ownership transfers) log actor + timestamp + before/after values.
- **PII at rest:** customer government-ID fields are encrypted at rest; ID-scan files in Convex File Storage carry RBAC-checked access.
- **Offline tolerance:** read-only lot lookup works on a field worker's phone after first load even with no signal (PWA cache).
- **Backups:** automated daily backup with ≥ 30-day retention.
- **Reconciliation invariant:** at any point, sum of recorded payments against a contract equals the contract's reduction in outstanding balance. Verified by a daily scheduled function.

### Measurable Outcomes

| Outcome | Target | When measured |
|---|---|---|
| New transactions entered in system | 100% | 30 days post-go-live |
| Active lots digitized | 100% | 60 days post-go-live |
| Installment contracts past due without logged action | < 5% | Ongoing, 90 days post-go-live |
| Monthly financial close time | < 1 hour | Each month-end |
| Office-staff lot lookup time | < 5 sec | Phase 1 |
| Field-worker physical lot location time | < 30 sec | Phase 2 (post-GPS) |
| Map first-paint on mid-range Android / 4G | < 3 sec | Continuous |
| Backup retention | ≥ 30 days | Continuous |

## Product Scope

### MVP — Minimum Viable Product (Phase 1, ~10–14 weeks)

The minimum that proves the concept and replaces the cemetery's current paper workflows end-to-end:

- Auth + role-based access (Admin/Owner, Office Staff, Field Worker) enforced **inside Convex functions**, not just at the UI layer
- Lot inventory with status (available / reserved / sold / occupied), lot type, section/block/row, dimensions, base price
- **Lot geometry fields populated from day one** (lat/lng centroid + polygon vertices), even though Phase 1 renders from a static image / SVG overlay
- Customer and ownership records, ownership-history tracking, document attachments (ID scans)
- Sales — full-payment and installment, configurable discounts and promo pricing
- Installment contracts with auto-generated payment schedule, AR aging, contract states (active / fully paid / in default / cancelled / transferred), configurable grace + penalty (gated on brief §10 Q1 from the client)
- Payment intake (cash, check, bank transfer) with auto-allocation to oldest unpaid installment
- **BIR-compliant official receipt generation** (gated on brief §10 Q3 — accredited-POS scope to confirm)
- Basic expense tracking — categorized operating expenses with vendor, date, amount, receipt-photo attachment
- KPI dashboard — MTD/YTD sales, collections, AR aging, expenses, net position
- Daily backups, audit log on financial mutations
- Legacy data migration from current paper / Excel records (~30–40% of Phase 1 effort per brief §9)

**Compliance gate:** BIR receipt format must be confirmed with the client before Phase 1 dev begins (brief §10 Q3). If accredited-POS-printer integration is required, that lands inside Phase 1 and re-scopes complexity to high.

### Growth Features (Phase 2, +6–8 weeks)

What makes it operationally competitive once the MVP is live:

- Interment scheduling with calendar view, double-booking prevention, field-worker completion logging
- Document generation — PDF contracts, BIR-compliant receipts as PDF, demand letters
- Reporting module — customizable date ranges, exports to Excel/PDF
- Full audit log surface (read UI, not just write logging)
- **GPS survey + Leaflet migration** — render-layer swap to real geographic coordinates; unlocks the < 30s field-worker physical lot location metric

### Vision — Future (Phase 3, +6–8 weeks)

The "if this is working, this is what is next" wave:

- Customer self-service portal — view own contract, payment history, make online payments
- Online payment gateway — **GCash, Maya, card** (PH-localized from the start)
- Automated SMS/email payment reminders via Convex scheduled functions
- Advanced analytics — cohort sales, agent performance (if commission tracking confirmed in brief §10 Q5), forecasting

### Explicitly Out of Scope (across all phases unless renegotiated)

- General-ledger / accounting replacement (system feeds data to QuickBooks/Xero, does not replace them)
- Funeral home / mortuary operations
- Casket / urn / headstone inventory
- Native mobile apps (responsive web only)

## User Journeys

Personas use placeholder names; replace with real personas once the client confirms staff composition (brief §10 Q10).

### Journey 1: Office Staff — Selling a lot on installment (happy path)

**Persona — Maria.** Office staff for 6 years. Knows the lot ledger by heart but spends 20 minutes per sale photocopying contracts, writing receipts, and updating three separate notebooks.

**Opening scene.** Mr. and Mrs. Cruz walk in. They have decided on a family lot in Section D, Block 5, and want to pay 20% down, balance over 24 months. In the old system this is a 30-minute exercise across paper contract, lot ledger, customer index card, and BIR booklet.

**Rising action.** Maria opens the app, searches "D-5" on the map, taps the lot. It shows status `available`, base price ₱80,000, dimensions, type `family`. She clicks **New Sale**, picks the Cruzes from the customer list (or creates them on the spot — snaps a photo of their gov IDs and uploads), chooses **Installment**, enters down payment ₱16,000, term 24 months, due day 15. The system shows a preview of the 24-row payment schedule with grace and penalty rules from config.

**Climax.** She clicks **Generate Receipt**. In a single Convex mutation: the lot flips to `reserved`, the contract is created with the 24-row schedule, the ₱16,000 down payment is posted against installment #1, the BIR-compliant receipt is generated as a PDF, an audit-log entry is written, and the dashboard's MTD sales bumps by ₱16,000 — visible the next time the owner refreshes from his phone.

**Resolution.** Maria prints the receipt + emails the PDF. Whole transaction took 4 minutes. Contract is now live; anyone on staff can find the Cruzes by name on next visit.

**Requirements revealed:** Map-driven lot picker with status & price on tap; inline customer creation with ID-scan upload; configurable installment schedule generator (term, down %, due day, grace, penalty); atomic "post sale" mutation (lot status + contract + payment + receipt + audit log); BIR-compliant PDF receipt; reactive dashboard subscriptions.

### Journey 2: Office Staff — Payment intake with allocation override (edge case)

**Persona — Maria again.** Two months later.

**Opening scene.** Mrs. Cruz walks in. She missed last month's installment (#3 is overdue, 30-day aging bucket). Hands over ₱8,000 cash and says, "Please apply this to next month's payment, not the missed one — we'll pay the missed one with our 13th-month pay in December."

**Rising action.** Maria opens the Cruzes' contract. Installment #3 marked **overdue**, installment #4 due in 12 days, AR balance, penalty accrued. She clicks **Record Payment** ₱8,000 cash. Default allocation is "oldest unpaid first" — would apply this to #3. She overrides: **manual allocation** → installment #4 fully paid, #3 still overdue.

**Climax.** System flags: "Installment #3 will remain overdue. Penalty will continue to accrue. Add a logged follow-up action?" Maria types: "Customer committed to settle #3 by Dec 15 from 13th-month." She saves. Contract now shows: #3 overdue with logged action, #4 paid, AR aging updated, penalty paused per policy until Dec 15.

**Resolution.** Receipt printed clearly noting which installment was covered. Follow-up shows on the dashboard's "overdue with logged action" list — counts against the < 5% metric only when no action is logged. If Dec 15 passes without payment, a scheduled function re-flags it as "needs follow-up."

**Requirements revealed:** Default-but-overridable payment allocation; per-installment status (current / paid / partial / overdue / overdue-with-action); free-text logged-action with due-date trigger; scheduled function re-flags expired actions; AR aging distinguishes "overdue with action" from "silently overdue."

### Journey 3: Field Worker — Locating a lot (Phase 1 → Phase 2)

**Persona — Junior.** Maintenance lead. Drives a utility cart between sections. Mid-range Android. Cemetery signal: 2–4 bars 4G, zero behind the chapel.

**Phase 1 opening scene.** Foreman radios: "Lot owner Bautista is bringing flowers at 3pm and can't remember where the lot is. Family lot, sold in 2019." Paper-system days: Junior would find Maria; she'd flip the index, hand him a hand-drawn sketch.

**Phase 1 rising action.** Junior opens the app on his phone. Searches "Bautista." Three matches — picks the family lot from 2019. App shows: Section E, Block 12, lot 4. Static map of Section E with lot 4 highlighted. He knows Section E from memory; drives there, finds the row, finds the lot in under a minute.

**Phase 1 resolution.** Marks the lot "freshly cleaned, ready for visit" with note + timestamp. Maria sees the update live at the office.

**Phase 2 climax (post-GPS).** Same scenario, but: Junior taps "Navigate to lot." Phone uses GPS to plot a path to the lot's lat/lng centroid. Even if he's never been to Section E, he gets there in under 30 seconds. Behind the chapel where signal drops, the lot record was already PWA-cached, so the lookup still works.

**Requirements revealed:** Phone-first search UI (owner / lot ID / section/block); PWA cache for read-only lot data; schema carries lat/lng centroid + polygon vertices from day one (Phase 1 doesn't render them, Phase 2 does); field-worker "log lot condition" mutation with note + photo + timestamp; reactive cross-role updates; Phase 2 Leaflet rendering + device-GPS routing.

### Journey 4: Admin / Owner — Checking the business mid-month

**Persona — Mr. Reyes.** Cemetery owner. Splits time across this and two other businesses. Has roughly 90 seconds between meetings to know if the business is running well.

**Opening scene.** It's the 18th of the month. Four minutes before his next call. Opens the dashboard on his phone.

**Rising action.** Dashboard shows: MTD sales ₱340,000, collections ₱280,000, AR balance ₱1.8M, AR aging (current 60% / 30-day 25% / 60-day 10% / 90+ 5%), MTD expenses ₱95,000, net MTD +₱245,000. He notices the 90+ bucket is up from last month.

**Climax.** Taps the 90+ aging bucket. Expands to a list of 7 contracts. Three have logged follow-up actions ("customer hospitalized, expected settle next month"); four don't. He taps one of the four-without-action — last payment 4 months ago, no notes, no follow-up. He flags it for Maria with a one-line comment: "Call this customer this week."

**Resolution.** Maria gets the flagged item in her queue the next morning. Mr. Reyes has spent 3 minutes and knows where the financial risk is. He didn't need to ask anyone to assemble a report.

**Requirements revealed:** KPI dashboard with MTD/YTD sales, collections, AR aging, expenses, net; drill-down from aggregate to individual contract; admin-to-staff annotation / flag-for-follow-up; mobile-responsive dashboard; permission model — admin sees everything, office staff sees their queue, field workers don't see financials.

### Journey 5: Customer (Phase 3) — Self-service contract check & online payment

**Persona — Aling Nena.** Bought a niche for her late husband in 2024 on a 36-month installment. Working overseas; payments handled by her daughter via GCash.

**Phase 3 opening scene.** Her daughter wants to know how many installments are left before flying home for the death anniversary.

**Rising action.** Daughter logs into the customer portal with the family's account. Sees: contract for niche C-3-22, original balance ₱120,000, paid ₱72,000, remaining ₱48,000, 14 installments to go, next due in 9 days.

**Climax.** Taps **Pay Now**, picks GCash, enters ₱4,000, confirms via GCash app. Convex receives the gateway webhook, posts the payment atomically, generates the BIR-compliant receipt, emails it. Aling Nena sees the receipt PDF in her inbox 6 seconds later.

**Resolution.** Portal updates: 13 installments to go. Maria sees the payment in her dashboard live. Daughter screenshots the receipt for the family group chat.

**Requirements revealed:** Customer authentication separate from staff authentication; customer-scoped read views (own contracts, own payments only); online payment gateway integration (GCash + Maya + card) with webhook → atomic Convex mutation → receipt → email; customer-facing receipt PDF formatting (same BIR template as in-office).

### Journey Requirements Summary

| Capability cluster | Surfaced by journeys |
|---|---|
| Map + lot inventory with status, geometry, search | 1, 3 |
| Customer & ownership records with ID scans and history | 1, 2, 5 |
| Sales + installment contract engine with configurable schedule, grace, penalty | 1, 2 |
| Payment intake with auto + manual allocation, BIR receipt generation, audit log | 1, 2, 5 |
| AR aging + "logged follow-up action" semantics | 2, 4 |
| Reactive dashboard with MTD/YTD financials and drill-down | 4 |
| Role-based access enforced in Convex (admin / office / field / customer) | all |
| PWA / offline cache for field-worker read paths | 3 |
| Scheduled functions for AR aging, follow-up-action-expiry detection | 2 |
| Phase 2: Leaflet + GPS navigation | 3 |
| Phase 3: Customer portal + online payment gateway + webhooks | 5 |

## Domain-Specific Requirements

### Compliance & Regulatory

**BIR (Bureau of Internal Revenue, Philippines) — Receipt compliance.** Highest-risk compliance surface; Phase 1 cannot ship without an answer to brief §10 Q3.

- **Receipt format.** BIR-prescribed format with: registered business name, BIR-issued TIN, business address, sequential serial number, customer name, transaction details, VAT breakdown (if VAT-registered, 12%), authority-to-print (ATP) reference, "this is an official receipt" labelling.
- **Sequential serial integrity.** Once issued, a serial cannot be reused, skipped silently, or modified. Voids must be explicitly recorded with the voided serial still consumed.
- **Issuance modality (gated decision).** Three plausible paths — confirm which applies before Phase 1 dev:
  1. **Manual BIR-issued receipts** — staff hand-writes a paper receipt and the system records it (lowest tech burden, highest manual burden, weakest control).
  2. **Computerized Accounting System (CAS) registration** — the app itself becomes a registered receipt-issuing system, requires BIR Permit to Use (PTU), backup module, system documentation. Adds 6–10 weeks to Phase 1.
  3. **Accredited POS-printer integration** — the app drives a BIR-accredited POS receipt printer. Hardware + driver scope; adds 2–4 weeks if a known accredited printer is procured.
- **Retention.** BIR requires 10-year retention of receipts and related records — must be reflected in backup and archival policy (the "30-day retention" success metric is for operational recovery; archival is separate).

**Data Privacy Act of 2012 (RA 10173).** The system handles customer government IDs and personal data at scale.

- **Lawful basis** for processing must be contract performance (the sale / installment) plus explicit consent for retention of ID copies.
- **Data subject rights** — customer can request copy, correction, or (where contract permits) erasure of their personal data. Phase 1 must at minimum log access; a self-service UI may land Phase 3 with the customer portal.
- **Encryption at rest** for PII fields (gov ID number, possibly full address) and for ID-scan files.
- **Breach notification** — must be capable of identifying within 72 hours which records were affected by a security incident. Audit log + access log support this.
- **DPO (Data Protection Officer)** — if the cemetery processes PII at a scale that triggers DPO requirement, that is a client-side org decision, not a product feature. Flag it.

**Financial-integrity expectations (not formally regulated, but enforced by the cemetery's own audit posture).**

- Once a receipt is issued, the underlying payment record is **immutable** — corrections happen as a separate reversal entry + a new receipt, not by editing history.
- Audit trail on every financial-touching mutation (already in success criteria) must capture **actor identity (Convex auth subject), timestamp, before/after values** — and survive backup/restore.
- Daily reconciliation invariant (sum of payments against contract = contract balance reduction) — already in success criteria; surface its failure as a dashboard alert, not a silent log entry.

### Technical Constraints

- **Atomic financial mutations.** Multi-document writes (payment + contract update + receipt + audit log) must be one Convex mutation. Partial states are not observable to other clients. This is a stack-level guarantee (Convex transaction model) but it must be the architecture's first invariant — no "let me just split this into two mutations for simplicity."
- **Receipt generation idempotency.** Network retries on the client must not produce duplicate receipts. Receipt generation keyed on (payment_id, receipt_serial) with idempotent server logic.
- **PII encryption.** Customer gov-ID fields encrypted at rest; ID-scan files in Convex File Storage gated by RBAC-checked access URLs (not public-by-default).
- **PWA offline tolerance** (already in success criteria) — read paths only. No offline writes; field workers cannot post payments without signal. This is intentional: offline writes would create reconciliation hazards that violate the financial-integrity expectations above.
- **Map performance on 4G / mid-range Android** (already in success criteria) — viewport-based loading is required, not "fetch all 2,000 lots." Bounding-box index on lot geometry fields is non-negotiable.

### Integration Requirements

- **Phase 1 — internal only.** PDF generation infrastructure (server-side, Convex action invoking a PDF library) for BIR receipts (FR30). No third-party network dependencies beyond Convex itself; the brief explicitly excludes general-ledger integration (the system feeds data to QuickBooks/Xero, does not replace them).
- **Phase 2.** Reuses the Phase 1 PDF infrastructure for contract documents (FR49) and demand letters (FR50). Optional: map-tile provider (OpenStreetMap or Mapbox) for the Leaflet rendering layer.
- **Phase 3.** Payment-gateway webhooks (GCash, Maya, card processor) → Convex HTTP action → atomic mutation. Webhook idempotency keys mandatory. SMS/email provider for reminders (Convex scheduled function → action).
- **Out of band.** A future export-to-QuickBooks/Xero feed is conceivable post-Phase-3 but is not in scope until the client requests it.

### Cemetery Domain Patterns (the easy-to-overlook stuff)

- **Lot status state machine.** The brief lists `available / reserved / sold / occupied`. Real cemetery operations need: `available → reserved (with hold expiry) → sold (contract active) → occupied (interment performed)`. Plus side paths: `cancelled` (contract voided pre-interment), `defaulted` (contract in default; reclaim policy applies — gated on brief §10 Q1), `transferred` (ownership changed; lot status unchanged). The state machine must be explicit in the schema, not implied.
- **Occupant ≠ Owner.** The occupant is the deceased interred in the lot; the owner is the person/family who paid. A lot may have multiple occupants over time (family lots, niches, mausoleums) and multiple owners over time (transfer to heirs). Both are time-versioned relations, not single fields.
- **Ownership transfer is its own workflow** (sale, inheritance, gift, court order). Each requires documentation (deed, affidavit of self-adjudication, donation deed, court order). Schema needs `transfer_event` records with type + document attachments + effective date — gated on brief §10 Q6.
- **Perpetual care fees** (brief §10 Q7, open). Could be one-time at sale, annual recurring, or both. Schema must accommodate both — design as an `annual_fee_schedule` field on the lot or contract, with `null` meaning "no perpetual care."
- **Interment ≠ Sale.** Interment scheduling (Phase 2) is a separate workflow from sale. A lot can be sold for years before its first interment. A pre-need vs. at-need distinction matters in PH cemetery operations — flag for client.
- **Lot reclaim policy.** When a contract goes into default and the policy says "lot is reclaimed and resold," prior payments may or may not be refundable. This is the highest-risk piece of contract policy in brief §10 Q1 — answer determines whether the schema needs `forfeited_payments` records.

### Risk Mitigations

| Risk | Mitigation |
|---|---|
| **BIR audit failure** (improperly issued or missing receipts) | Sequential serial enforcement at the schema layer (unique constraint, gap detection). Voids recorded explicitly. 10-year archival retention separate from operational backup. Receipt-format choice locked with client before dev starts. |
| **Data Privacy Act breach** | PII encryption at rest, RBAC-gated file access, access audit log, breach-impact query (which subjects affected) supported by data model. Customer consent recorded with ID-scan upload. |
| **Reconciliation divergence** (payments don't sum to contract reduction) | Daily scheduled function runs the invariant check across all active contracts; failures surfaced on the dashboard as actionable alerts, not silent log entries. |
| **Mid-transaction failure** (e.g. browser crash after receipt generated but before contract updated) | All multi-document writes inside one Convex mutation; receipt generation idempotent on (payment_id, receipt_serial); client retries safe. |
| **GPS survey delay holding up Phase 2** | Schema carries geometry fields from Phase 1; static-map fallback is the Phase 1 default anyway. Phase 2 ships its non-map deliverables (interments, reporting, audit-log UI) independently of survey progress. |
| **Tile-provider cost spiral** at scale | Phase 2 starts on OpenStreetMap (free, attribution-only). Switch to Mapbox only if OSM tile quality / coverage proves inadequate; that decision moves to Phase 2 retrospective. |
| **Receipt format change by BIR mid-build** | Receipt template lives in config, not hardcoded — changeable without a deploy. |
| **Lot reclaim disputes** (customer in default insists they're not) | All payment history immutable + audit-logged with actor + before/after. Contract state transitions to `default` require explicit user action + logged reason, never automatic. Default state alone doesn't reclaim the lot; reclaim is a separate explicit action. |

## Web Application Requirements

### Project-Type Overview

Single-codebase Next.js (App Router, TypeScript) application running in modern evergreen browsers. The same deployment serves three distinct audiences:

- **Phase 1+:** Office staff on desktop (the heaviest user; most transactions land here)
- **Phase 1+:** Field workers on Android phones (read-mostly; lot lookup + condition logging)
- **Phase 3:** Customers on mobile + desktop (self-service portal — view contract, pay online)

Not a classic SPA. Next.js App Router gives a hybrid model: server components render initial pages (good for Phase 3 customer portal landing pages where SEO and first-paint matter); client components subscribe to Convex reactive queries (the authenticated app shell behaves like a live SPA after login). One codebase, one deploy on Vercel.

### Technical Architecture Considerations

- **Rendering model:** Next.js App Router — server components for public/landing routes (Phase 3); client components with Convex hooks for everything authenticated. No separate API layer; React talks to Convex directly via the Convex React SDK.
- **State management:** Convex reactive queries are the source of truth for server state. No Redux / Zustand / SWR on top. Local UI state stays in React component state.
- **Auth:** Convex Auth (or Clerk-on-Convex if Convex Auth proves limiting for PH-specific identity flows — Architect decision). Role enforcement inside Convex functions.
- **PWA:** Service worker for read-path caching of lot data so field workers retain lot lookup behind the chapel. No offline writes.
- **Bundle strategy:** Route-level code splitting via Next.js defaults; Leaflet (Phase 2) lazy-loaded so the static-map Phase 1 doesn't pay for it.

### Browser Matrix

| Audience | Browsers | OS |
|---|---|---|
| Office staff | Chrome (latest 2 versions), Edge (latest 2) | Windows 10/11 desktop |
| Field workers | Chrome (latest 2) | Android 10+ on mid-range hardware |
| Customers (Phase 3) | Chrome, Safari, Edge, Firefox (latest 2 each) | iOS 15+, Android 10+, Windows/macOS desktop |

**Explicitly not supported:** Internet Explorer, legacy Edge (pre-Chromium), browsers older than the last two stable releases.

### Responsive Design

- **Desktop-first for office staff.** Sale + payment + dashboard workflows assume a keyboard and ≥ 1366px width. They will work on a tablet, but they're not designed for one.
- **Mobile-first for field workers.** Lot search, lot detail, condition logging — designed for phone-portrait first, scaled up to tablet/desktop.
- **Mobile-first for the customer portal (Phase 3).** Customers will overwhelmingly come from phones (the GCash flow is a phone-to-phone interaction).
- **Breakpoints:** Tailwind defaults — `sm 640 / md 768 / lg 1024 / xl 1280`. No custom breakpoints.

### Performance Targets

Restating the technical success metrics in implementation terms:

| Metric | Target | Notes |
|---|---|---|
| First Contentful Paint (FCP) | < 1.5s desktop, < 2.5s mid-range Android / 4G | Standard Lighthouse target |
| Largest Contentful Paint (LCP) | < 2.5s desktop, < 4s mobile / 4G | Map view is the worst case |
| Map render (2,000+ lots) first paint | < 3s on mid-range Android / 4G | Viewport-only fetch, not full inventory |
| Map pan/zoom frame rate | ≥ 30fps | Phase 2 Leaflet; Phase 1 static-image is trivially fast |
| Interaction-to-Next-Paint (INP) | < 200ms p75 | Reactive query updates must not block input |
| Convex query p95 | < 300ms | Indexed queries only; no full-collection scans |
| Bundle JS (initial route) | < 250KB gzipped | Leaflet lazy-loaded post-Phase-1 |

### SEO Strategy

- **Phase 1 + 2:** None. Internal auth-walled application. `noindex, nofollow` site-wide.
- **Phase 3:** Customer portal landing/login page is indexable so customers can find "[cemetery name] payment portal" via search. Authenticated routes remain `noindex`. Minimal: `<title>`, `<meta description>`, `LocalBusiness` structured data if the client wants public discoverability. Not investing in content marketing — this is not a marketing site.

### Accessibility Level

**Target: WCAG 2.1 AA.** AAA is overscope for a freelance build; A is below table stakes.

Practical implications for this app:

- **Keyboard navigation** through the entire office-staff workflow (sale, payment, customer lookup).
- **Color-blind-safe lot status palette.** Red-green palette fails ~8% of male users. Use color + icon + label, not color alone.
- **Screen-reader labels** on every interactive map element (lot tap target, status indicator, "where am I" on the Phase 2 mobile map).
- **Touch targets** ≥ 44×44 px on the field-worker mobile map. Workers may be wearing gloves.
- **High-contrast / outdoor-readable mode** for the field-worker mobile view — direct sunlight kills default light-gray-on-white. At minimum, body text passes WCAG AA contrast against the map base layer.
- **Form errors announced** to screen readers via `aria-live` on the sale, payment, and customer-creation forms.
- **Out of scope:** full dyslexia-friendly font option, full RTL support, full Filipino-language UI translation (i18n is a separate scope item — content is English in the brief).

### Implementation Considerations

- **TypeScript strict mode** non-negotiable — Convex's type-safety across schema → queries → React hooks is a primary reason for this stack.
- **No CSS-in-JS at runtime.** Tailwind CSS (zero-runtime, JIT) — keeps the bundle small and Lighthouse scores high.
- **PDF generation (Phase 1 onwards)** runs server-side in Convex actions, not in the browser. Phase 1 produces BIR receipts; Phase 2 reuses the same infrastructure for contracts and demand letters. Browser PDF libraries are large and font-rendering varies.
- **Map rendering swap (Phase 1 → Phase 2)** is a component-level change, not a route change. Lot-detail / lot-search routes don't move; the `<LotMap>` component swaps its underlying renderer.
- **No service worker in Phase 1 dev environment.** PWA caching turned on only for production builds — otherwise stale lot data hides bugs during development.
- **Skip:** native features (no Capacitor / React Native wrapper), CLI commands (no companion CLI tool). Brief explicitly excludes native mobile.

## Project Scoping & Phased Development

Brief §5 defines phased delivery; this PRD keeps the same Phase 1 / Phase 2 / Phase 3 labels. Feature contents per phase live in the Product Scope section above; this section adds strategic framing — MVP philosophy, resource sizing, and risk mitigation — for SM / PO hand-off.

### MVP Strategy & Philosophy

**Approach: problem-solving MVP.** This is not a market-validation MVP, not an investor-pitch MVP, not a platform play. The cemetery has four broken workflows already painful enough to motivate a custom build. Phase 1's job is to replace those workflows with a working digital one and let ownership see the business. Validation comes from "did the staff stop using the paper ledger?" — not cohort retention curves.

The implication: every Phase 1 decision favors **correctness over cleverness**. The financial transactions are real money — the architecture's first job is to be right, not impressive. The differentiation work (reactive sync, schema-ready geometry) is in service of correctness and future-readiness, not novelty.

**Critical questions answered:**

- *"What's the minimum that would make staff say this is useful?"* → A sale + payment + receipt can be completed in the app end-to-end without parallel paper. Ownership sees yesterday's totals on a dashboard. That is Phase 1.
- *"What's the fastest path to validated learning?"* → Migrate one section of the cemetery (~200 lots) into the system in week 6 and have office staff do live transactions on it for 2 weeks before opening up the full inventory. Catches schema/UX problems before they scale to 2,000 lots of legacy data.

### Resource Requirements

The brief frames this as a freelance build for a single cemetery client. Implication: small, sustained team — not a venture-scale build.

**Phase 1 (10–14 weeks):**

- 1 full-stack engineer (Next.js + Convex; comfortable with TypeScript strict mode and real money in a database)
- 0.5 UX / front-end specialist (for the office-staff transactional UIs — sale, payment, customer creation; getting these wrong adds friction every working day)
- 0.25 of a domain expert (the cemetery's office lead, ~1 day/week of structured Q&A — installment policy edge cases, BIR receipt format, legacy data triage)
- Client-side: BIR-related answers, legacy records access, ID-scan retention policy decisions, staff account provisioning

**Phase 2 (+6–8 weeks):** Same team. Adds: optional GIS surveyor for the GPS survey (one-time engagement, scheduled before Phase 2 dev so geometry data is ready when the rendering swap lands).

**Phase 3 (+6–8 weeks):** Same team. Adds: payment-gateway integration time (GCash + Maya merchant onboarding is paperwork-heavy on the client side — schedule it 4–6 weeks before integration code starts).

**If team shrinks to 0.5 engineer / no UX specialist:** Phase 1 extends to ~18–22 weeks. The transactional UIs degrade meaningfully without dedicated UX, and that *is* the product for office staff. Worth flagging — not a place to cut.

### Risk Mitigation Strategy

The Domain Requirements section enumerated technical risks per category; this section frames them strategically across all three risk axes (technical / market / resource).

**Technical risks.** The single biggest is **financial-integrity bugs** (split mutations, race conditions on payment posting, receipt sequence gaps). Mitigation: every payment-touching mutation is one Convex mutation by architectural contract — not a guideline, not best-effort. Code review explicitly looks for "did this need to be split" as a smell. Daily reconciliation invariant check runs from day one of Phase 1, not added later — surfaces drift while volume is low.

The second is **BIR receipt format misimplementation**. Mitigation: receipt template is config, not code (already in risk table); a BIR-format spike happens in week 1–2 of Phase 1 with a printable sample reviewed by the cemetery's accountant before the rest of the receipt flow is built.

The third is **map performance on 4G + mid-range Android**. Mitigation: viewport-based loading from day one (not retrofitted in Phase 2); performance budget enforced as a Lighthouse threshold in CI (LCP < 4s on emulated 4G).

**Market risks.** For a single freelance client there is no traditional market risk — no acquisition funnel, no competitive churn pressure. The closest equivalent is **client-adoption risk**: staff continue parallel paper work because the new system feels foreign. Mitigation:

- Week-1 onboarding session where Maria + counterparts run live transactions through the app, not a demo
- Two-week single-section pilot before full rollout (see "fastest path to validated learning" above)
- Owner dashboard live before staff workflows are fully built — the owner becomes the system's internal advocate to staff, not the freelancer

**Resource risks.** The riskiest scenarios:

1. **BIR CAS registration required** (option 2 of three receipt modalities) and the cemetery doesn't already have one. CAS Permit-to-Use is paperwork-heavy and can take 6–10 weeks of calendar time on the BIR side; if started late, it gates Phase 1 go-live. **Mitigation:** start the PTU application in week 1 of Phase 1 in parallel with dev, not week 8. If the answer to brief §10 Q3 is "accredited POS printer" or "manual BIR receipts," CAS risk is moot.
2. **Legacy data migration discovers disputes** — paper records show one owner, heirs claim another. Brief §9 estimates 30–40% of Phase 1 effort, which already buys buffer; mitigation: treat the 200-lot pilot section as the discovery survey and adjust the remaining-1,800 estimate after.
3. **GPS survey not done by Phase 2 kickoff.** Mitigation: Phase 2's non-map scope (interments, reporting, audit log UI) ships independently of survey progress. Leaflet migration becomes a Phase 2.5 deliverable if needed; no other Phase 2 work is gated by it.
4. **Single-engineer dependency.** Mitigation: code in a Git repo from day one; Convex schema and major flows documented as ADRs in the repo; cemetery owns the codebase + Convex project + Vercel deployment from day one, not the freelancer's account.

### Cross-phase Scope Discipline

Two principles to enforce on the SM / PO during phase-to-phase transitions:

1. **No requirement silently moves between phases.** If something tagged Phase 1 in the PRD looks tight at week 8, the question is not "can we slip it to Phase 2" but "is the brief / PRD wrong about it being Phase 1?" — surfaces the trade-off explicitly to the client.
2. **No Phase 3 work happens in Phase 1.** Payment gateway integration in particular is tempting to start early because it is interesting; building it before Phase 1's financial-integrity invariants are battle-tested compounds the wrong risks.

## Functional Requirements

This is the capability contract for the product. Any feature not listed here will not exist in the final product unless explicitly added. Phase tags `[P1]` / `[P2]` / `[P3]` correspond to the Product Scope section above. Bracketed `gated on §10 Q#` references the open questions in brief §10 that must be answered before that FR's behavior can be finalized.

### 1. Identity & Access Control

- **FR1:** An unauthenticated user can authenticate using credentials issued by an Admin. [P1]
- **FR2:** An Admin can create, deactivate, and update staff and field-worker accounts. [P1]
- **FR3:** An Admin can assign one or more roles (Admin/Owner, Office Staff, Field Worker) to each account. [P1]
- **FR4:** The system can enforce role-based access on every data read and write at the server, not just the UI. [P1]
- **FR5:** A Customer can authenticate to the self-service portal using credentials linked to their contracts. [P3]

### 2. Lot Inventory & Mapping

- **FR6:** Office Staff can create, edit, and retire lot records with section/block/row, type, dimensions, base price, and status. [P1]
- **FR7:** Any authenticated user can search lots by ID, section/block, owner name, or status. [P1]
- **FR8:** Any authenticated user can view a lot detail showing status, current owner (if any), occupants, active contract, and payment history. [P1]
- **FR9:** The system can store `lat/lng centroid` and `polygon vertices` on every lot record from Phase 1. [P1]
- **FR10:** Any authenticated user can view a 2D map showing all lots with status-coded markers, filterable by section/block/type/status. [P1 static · P2 GPS-backed]
- **FR11:** A Field Worker can read lot data on a phone browser after first load even when offline. [P1]
- **FR12:** A Field Worker on a phone can request turn-by-turn navigation from current GPS position to a lot's centroid. [P2]
- **FR13:** A Field Worker can log lot condition (note + photo + timestamp) against a lot. [P1]

### 3. Customer & Ownership Records

- **FR14:** Office Staff can create a customer record with name, contact, address, government-ID number, and relationship to occupant. [P1]
- **FR15:** Office Staff can upload identification documents (ID scans, transfer affidavits) to a customer or transfer record. [P1]
- **FR16:** The system can maintain a time-versioned ownership history for every lot (owner, effective dates, transfer type). [P1]
- **FR17:** Office Staff can record an ownership transfer (sale, inheritance, gift, court order) with required documentation and effective date. [P1, gated on §10 Q6]
- **FR18:** The system can record one or more occupants per lot with name, date of interment, and relationship to owner — distinct from owner records. [P1]

### 4. Sales & Installment Contracts

- **FR19:** Office Staff can record a full-payment sale linking a lot, a customer, price, and payment method. [P1]
- **FR20:** Office Staff can record an installment sale with configurable down payment, term, due day, grace period, and penalty rules. [P1, gated on §10 Q1]
- **FR21:** The system can auto-generate the payment schedule for an installment contract on creation. [P1]
- **FR22:** Office Staff can apply configurable discounts and promo pricing to a sale. [P1]
- **FR23:** A contract can transition through states (`active`, `fully_paid`, `in_default`, `cancelled`, `transferred`); state transitions require an explicit user action with logged reason. [P1]
- **FR24:** An Admin can void or cancel a contract pre-interment with logged reason. [P1]
- **FR25:** The system can attach perpetual care fees (one-time, annual, or none) to a contract based on configuration. [P1, gated on §10 Q7]

### 5. Payments & BIR Receipts

- **FR26:** Office Staff can record a payment against a contract (cash, check, bank transfer) with auto-allocation to the oldest unpaid installment as default. [P1]
- **FR27:** Office Staff can override default allocation and manually allocate a payment across installments. [P1]
- **FR28:** The system can generate a BIR-compliant official receipt for every recorded payment, with a unique sequential serial number per the cemetery's BIR registration. [P1, gated on §10 Q3]
- **FR29:** The system can record a receipt as voided with an explicit reason; voided serial numbers remain consumed and are not re-issued. [P1]
- **FR30:** Office Staff can print and email a generated receipt as PDF. [P1]
- **FR31:** Once issued, a payment and its receipt are immutable; corrections require a separate reversal entry that issues a new receipt. [P1]
- **FR32:** The system can post payment, contract balance update, receipt generation, and audit-log entry as a single atomic transaction. [P1]
- **FR33:** A Customer can pay an installment online via supported gateways (GCash, Maya, card); the system can post the payment atomically on receipt of the gateway webhook. [P3]

### 6. AR Aging & Collections Workflow

- **FR34:** The system can compute AR aging buckets (current / 30 / 60 / 90+ days) for every active contract on a daily schedule. [P1]
- **FR35:** Office Staff can attach a logged follow-up action (free-text note + target date) to any overdue installment. [P1]
- **FR36:** The system can re-flag overdue installments whose logged follow-up action target date has passed without resolution. [P1]
- **FR37:** An Admin can transition a contract to `in_default` status with a logged reason; default state does not automatically reclaim the lot. [P1]
- **FR38:** An Admin can reclaim a defaulted lot in a separate explicit action with logged reason; the lot returns to `available` and prior payments are recorded per policy. [P1, gated on §10 Q1]

### 7. Expense Tracking

- **FR39:** Office Staff can record an operating expense with date, amount, vendor, category, and optional receipt-photo attachment. [P1, categories gated on §10 Q8]
- **FR40:** An Admin can define and edit the list of expense categories. [P1]
- **FR41:** An Admin can configure whether expenses require approval before posting; pending-approval expenses do not affect dashboard totals until approved. [P2, gated on §10 Q9]

### 8. Reporting & Financial Dashboards

- **FR42:** An Admin can view a KPI dashboard showing MTD/YTD sales, collections, AR balance, AR aging breakdown, expenses, and net position. [P1]
- **FR43:** An Admin can drill down from any dashboard metric to the underlying contracts, payments, or expenses. [P1]
- **FR44:** An Admin can flag a specific contract for staff follow-up with a short comment; the flag appears in the assigned staff's queue. [P1]
- **FR45:** An Admin can view a report breaking down sales by lot type, section, and (if enabled) sales agent. [P2, agent breakdown gated on §10 Q5]
- **FR46:** An Admin can export any report to Excel or PDF for a configurable date range. [P2]
- **FR47:** An Admin can view a full audit log of financial mutations filterable by actor, entity, and date range. [P2]
- **FR48:** An Admin can view trend analysis of sales, collections, and AR balance over user-selected time periods. [P3]

### 9. Document Generation

- **FR49:** Office Staff can generate an installment contract as a PDF document. [P2]
- **FR50:** Office Staff can generate a demand letter for an overdue contract as a PDF document. [P2]

### 10. Interment Scheduling

- **FR51:** Office Staff can schedule an interment against a lot and an occupant record on a date and time. [P2]
- **FR52:** The system can prevent double-booking of the same lot or the same scheduled time slot. [P2]
- **FR53:** A Field Worker can mark an interment as complete with timestamp and notes. [P2]
- **FR54:** Office Staff can view a calendar of scheduled interments filterable by section, date range, and status. [P2]

### 11. Customer Self-Service

- **FR55:** A Customer can view their own contracts, payment history, current balance, and remaining installments. [P3]
- **FR56:** A Customer can download a receipt for any past payment as a PDF. [P3]
- **FR57:** The system can send automated SMS or email payment reminders to customers based on configurable rules. [P3]
- **FR58:** A Customer can update their own contact information (excluding name and government-ID number). [P3]

### 12. System Operations, Audit & Compliance

- **FR59:** The system can append an audit-log entry (actor, timestamp, before/after values) on every financial-touching mutation. [P1]
- **FR60:** The system can run a daily reconciliation invariant (sum of payments against contract = contract balance reduction) and surface failures on the Admin dashboard. [P1]
- **FR61:** The system can produce a daily database backup retained for at least 30 operational days. [P1]
- **FR62:** The system can produce an archival export of receipts and related records suitable for 10-year retention per BIR. [P1]
- **FR63:** An Admin can produce a data-subject report listing all PII the system holds about a named customer. [P1]
- **FR64:** The system can log access to PII fields and ID-scan files; the log supports a "which records were affected" query for breach response. [P1]
- **FR65:** The system can encrypt PII fields and ID-scan files at rest. [P1]

## Non-Functional Requirements

This section consolidates the quality-attribute requirements scattered across earlier sections (Performance Targets, Domain Requirements, Web App Requirements) into a single testable contract. Underlying rationale stays in those sections; this section is the binding numeric/quality form. Scalability is intentionally omitted — fixed-scope cemetery, no growth-curve to plan for beyond the Phase 3 customer count.

### Performance

- **NFR-P1:** Largest Contentful Paint (LCP) on the office-staff workflow routes (sale, payment, customer detail, dashboard) — **< 2.5s on desktop**, **< 4s on mid-range Android over emulated 4G**. Measured via Lighthouse in CI on every PR.
- **NFR-P2:** Map render (first paint with all visible lots) — **< 3s on mid-range Android over 4G**. Measured against the production lot inventory (2,000+ lots, viewport-based loading).
- **NFR-P3:** Map pan/zoom frame rate — **≥ 30fps on mid-range Android**. Phase 2 Leaflet only; Phase 1 static-image is trivially fast.
- **NFR-P4:** Convex query latency — **p95 < 300ms** across all production query traffic. Enforced via Convex's built-in metrics; queries breaching this consistently are flagged as bugs.
- **NFR-P5:** Interaction-to-Next-Paint (INP) — **< 200ms at p75** across all interactive UI. Reactive query updates must not block user input.
- **NFR-P6:** Initial JS bundle on every authenticated route — **< 250KB gzipped**. Leaflet lazy-loaded post-Phase-1; PDF library never client-side.
- **NFR-P7:** Office-staff transactional flow (open new-sale screen → submit completed sale with receipt issued) — **< 4 minutes elapsed including data entry**. Validates Journey 1's success metric.

### Security & Privacy

- **NFR-S1:** All HTTP traffic is TLS 1.2+; HTTP requests redirect to HTTPS. No mixed content.
- **NFR-S2:** PII fields (customer government-ID number, optionally full address) are **encrypted at rest** with keys held in Convex's managed key infrastructure, not in application code or environment variables.
- **NFR-S3:** ID-scan files and other PII attachments in Convex File Storage are gated by RBAC-checked access URLs. **No public-by-default file URLs.**
- **NFR-S4:** Every Convex mutation and query enforces role-based access at the server. UI-only authorization is a non-compliance defect.
- **NFR-S5:** Authentication sessions expire after configurable inactivity (default **8 hours** for office staff, **30 days** for customer-portal Phase 3, **1 hour** for Admin). Re-authentication required for role escalation actions.
- **NFR-S6:** Failed authentication attempts rate-limited per account (default: 5 failures in 15 minutes → 1-hour lockout). Rate limit lift requires Admin action, logged.
- **NFR-S7:** Audit log is append-only at the database level — no mutation can update or delete audit-log rows in production.
- **NFR-S8:** PII access log captures user, timestamp, customer record accessed, and access type (read / download / export) for every interaction with PII fields and ID-scan files. Supports a "which subjects affected by access in window X" query for breach response within **72 hours** (Data Privacy Act requirement).

### Reliability & Availability

- **NFR-R1:** Target uptime during cemetery operating hours (08:00–17:00 Manila time, Mon–Sat) — **99.5% monthly** (allows ~2 hours unplanned downtime per month during business hours). Outside business hours, no formal SLA.
- **NFR-R2:** Convex's managed backups produce a daily point-in-time snapshot retained **≥ 30 operational days**. Restore RPO ≤ 24 hours, RTO ≤ 4 hours (measurable via quarterly restore drills).
- **NFR-R3:** Archival export of receipts and financial records retained **≥ 10 years** in cold storage per BIR retention requirements. Separate retention policy from operational backup.
- **NFR-R4:** Daily reconciliation invariant (FR60) failures appear on the Admin dashboard within **2 hours** of detection and remain visible until resolved or explicitly acknowledged.
- **NFR-R5:** Payment-posting mutations are atomic; client-side retries with the same idempotency key produce no duplicate payments or receipts.
- **NFR-R6:** Read-path PWA cache (FR11) serves field-worker lot lookups with cached data **up to 24 hours stale** after last successful sync, after which the UI clearly indicates "data may be outdated."

### Accessibility

- **NFR-A1:** All authenticated routes target **WCAG 2.1 Level AA conformance**. Verified via automated axe-core scans in CI plus quarterly manual audit of the office-staff and field-worker primary flows.
- **NFR-A2:** Lot status is encoded with **color + icon + text label** (never color alone). Verified colorblind-safe with a deuteranopia simulator on the map and dashboard.
- **NFR-A3:** All interactive elements reachable by keyboard with visible focus indicators. The office-staff sale + payment + customer-creation flows complete end-to-end without a pointing device.
- **NFR-A4:** Touch targets on the field-worker mobile UI are **≥ 44 × 44 px** (accommodating glove use).
- **NFR-A5:** Body-text contrast against the field-worker map base layer passes **WCAG AA (≥ 4.5:1)** in both default and direct-sunlight conditions.
- **NFR-A6:** Form validation errors are announced to screen readers via `aria-live` regions on the sale, payment, customer-creation, and customer-portal forms.

### Integration

- **NFR-I1 (Phase 3):** Payment gateway webhooks (GCash, Maya, card) are idempotent on the gateway's transaction ID; duplicate webhook deliveries produce no duplicate payments or receipts.
- **NFR-I2 (Phase 3):** Webhook handlers acknowledge within **5 seconds** to satisfy gateway retry policies; long-running work (PDF generation, email send) deferred to scheduled actions.
- **NFR-I3 (Phase 3):** SMS / email provider integration tolerates provider downtime — failed reminders queue and retry up to **3 attempts over 24 hours** before surfacing as an Admin alert.
- **NFR-I4:** No external integrations have hard dependencies in Phase 1. Phase 1 functions correctly without any third-party network call beyond Convex itself and (optionally) the map tile provider for Phase 2.

### Compliance

- **NFR-C1:** Every BIR receipt generated carries a serial number unique across all receipts ever issued by the cemetery's BIR-registered business. **No serial gaps**; voids consume their serial.
- **NFR-C2:** Receipts and their underlying payments are immutable after issuance. **Reversals create new records**, never modify history. Verified by daily integrity scan.
- **NFR-C3:** Customer can be issued a Data Privacy Act subject report (all PII held about them) on Admin request, produced within **15 working days** of request per RA 10173 timeline.
- **NFR-C4:** Breach impact query (which subjects affected by a stated security incident in a stated time window) returns results within **2 hours** to support the 72-hour NPC notification window.
- **NFR-C5:** Customer consent for ID retention is captured and timestamped at customer creation. Records without captured consent cannot have ID scans attached.

### Maintainability

Not in the BMAD default category list but matters for a freelance build with a single-engineer dependency (see Resource Risks in Project Scoping & Phased Development).

- **NFR-M1:** Convex schema, all queries/mutations/actions, and the Next.js app are **strict TypeScript** end-to-end. No `any` types in production code without explicit ESLint suppression + reviewer sign-off.
- **NFR-M2:** Test coverage on financial-touching server functions (payments, contract state transitions, reconciliation) — **≥ 90% line coverage**. Coverage enforced in CI.
- **NFR-M3:** Architecture Decision Records (ADRs) captured in-repo under `docs/adr/` for every decision that constrains future implementation (auth choice, PDF library, map renderer, BIR receipt modality). Updated when superseded, never deleted.
- **NFR-M4:** Cemetery owns the codebase (Git repo), Convex project, and Vercel deployment from day one. Freelancer access is collaborator-level, not owner-level.
- **NFR-M5:** Local dev environment startup from clean clone — **< 10 minutes** including Convex dev deploy and seed data. Documented in `README.md`.

## Open Questions Summary

Brief §10 enumerates 10 open questions the client must answer before Phase 1 dev begins. Every FR or behavior gated on those questions is consolidated here so the SM / PO can drive answers as a single workstream rather than discovering them mid-build.

> **Update — 2026-05-17:** All 10 questions resolved as **working defaults** in [`client-decisions-defaults.md`](./client-decisions-defaults.md). Phase 1 dev proceeds against those defaults. Actual cemetery confirmation prior to go-live may revise specific values; architecture and schema accommodate revision without rework. The table below preserves the original gating context for traceability; see the defaults file for the actual values being used.

| § | Question | Gates | Impact if unanswered at Phase 1 start |
|---|---|---|---|
| Q1 | Installment policy — grace period, penalty rate, lot reclaim conditions | FR20 (installment schedule), FR38 (lot reclaim), Domain Risk Mitigations | Cannot finalize the installment schedule generator's penalty/grace config or the default-vs-reclaim state-machine transition. Schema may need `forfeited_payments` records depending on policy. |
| Q2 | Lot types and pricing structure | Product Scope (lot types referenced as single / family / mausoleum / niche), FR6 | Cannot seed the lot-type configuration or pricing rules. Migration of legacy lots blocked. |
| Q3 | BIR receipt requirements — current modality, accredited POS in use, registered for CAS | FR28 (BIR receipt generation), Domain Compliance, Resource Risks (#1) | The single biggest Phase 1 schedule risk. Answer determines whether Phase 1 needs CAS Permit-to-Use (+6–10 weeks), POS-printer integration (+2–4 weeks), or just records manual receipts. **Block dev start until answered.** |
| Q4 | Existing legacy records — format, condition, volume | Product Scope (migration ~30–40% of Phase 1 per brief §9), Resource Risks (#2) | Cannot size the migration accurately. Mitigation already in place (200-lot pilot in week 6 as a discovery survey). |
| Q5 | Multiple sales agents — commission tracking needed | FR45 (agent-breakdown report) | Without commission tracking, FR45 reduces to lot-type + section breakdowns only. Schema can defer the `agent_id` field on sales until confirmed. |
| Q6 | Ownership transfer policy — types (sale, inheritance, gift, court order) and documentation required | FR17 (record ownership transfer), Domain Cemetery Patterns | Cannot finalize the `transfer_event` record schema (required-doc-types, effective-date rules). Phase 1 can ship a simplified transfer flow if needed; full workflow gated on answer. |
| Q7 | Perpetual care fees — annual, one-time, or both | FR25 (perpetual care on contract), Domain Cemetery Patterns | Cannot finalize the `annual_fee_schedule` field design. Schema is forward-compatible (nullable + flexible), but billing UX needs the answer. |
| Q8 | Predefined expense categories | FR39 (record expense) | Cannot seed the expense-category configuration. Office staff can fall back to a free-text category at launch if needed, but reporting (FR42, FR46) is less useful without taxonomy. |
| Q9 | Expense approval workflow — required pre-posting? | FR41 (approval gate) | Determines whether FR41 is Phase 2 scope (currently tagged) or could simplify out of scope entirely. |
| Q10 | Number of named user accounts at launch | Resource Requirements (Phase 1 client-side), Identity & Access FRs (FR1–FR4), User Journeys (personas are placeholders) | Sizes the initial provisioning effort; doesn't gate dev. Replaces Maria / Junior / Mr. Reyes placeholder personas with real names. |

**Dev-start gates (must be answered before Phase 1 dev begins):** Q1, Q3.

**Schema-finalization gates (can be answered during Phase 1 weeks 1–4):** Q2, Q5, Q6, Q7, Q8, Q9.

**Operational gates (can be answered before go-live):** Q4, Q10.

