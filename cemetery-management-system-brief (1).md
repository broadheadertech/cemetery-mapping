# Cemetery Management System — Project Brief

> **Purpose of this document:** Input for BMAD agents (Analyst → PM → Architect → SM → Dev). This is a project brief; the PM agent should expand it into a full PRD and the Architect should produce the architecture doc from it. Open questions are flagged in the final section and must be resolved with the client before sprint planning.

---

## 1. Executive Summary

A digital cemetery management platform for a **large private cemetery (2,000+ lots)** to replace the current manual/paper-based system. The platform consolidates **cemetery mapping, lot inventory, sales, installment contracts, interment scheduling, payments, and operating expense tracking** into a single responsive web application usable by office staff (desktop) and field workers (mobile browser).

**Project type:** Freelance build for a single cemetery client.
**Region:** Philippines (BIR/receipt compliance applies).
**Primary outcome:** Full operational visibility — every lot, every contract, every payment, every peso of expense, and the resulting P&L visible to ownership in real time.

---

## 2. Problem Statement

The cemetery currently manages four critical workflows manually or in disconnected spreadsheets/paper:

1. **Cemetery mapping** — physical/paper map; locating a specific lot among 2,000+ requires staff who memorize the layout.
2. **Interment schedules** — coordinated by phone/paper, prone to double-booking and missed prep.
3. **Lot payments and reservations** — manual ledgers; reconciliation is slow and error-prone.
4. **Lot contracts (installment plans)** — paper contracts; missed payments and grace-period tracking are reactive, not proactive.

There is **no consolidated view of sales vs. operating expenses**, so management cannot see true profitability or cash flow.

---

## 3. Goals & Success Metrics

### Business Goals
- Eliminate paper-based lot and contract records.
- Reduce time to locate a lot from minutes to seconds (especially in the field).
- Provide real-time sales, AR (accounts receivable), and expense visibility to ownership.
- Reduce missed installment payments through automated tracking and reminders.

### Success Metrics (proposed — confirm with client)
- 100% of active lots digitized within 60 days of go-live.
- Field worker can locate any lot via mobile in < 30 seconds.
- Monthly financial close (sales − expenses) producible in < 1 hour.
- < 5% of installment contracts past due without a logged action.

---

## 4. Target Users & Roles

| Role | Primary Device | Key Responsibilities |
|------|---------------|---------------------|
| **Admin / Owner** | Desktop | Full access, financial reports, user management, expense approval |
| **Office Staff** | Desktop | Sales, contracts, payment intake, interment scheduling, customer records |
| **Field Worker** | Mobile (phone browser) | Locate lots on-site, update lot condition/status, log interment completion |
| **(Phase 3) Customer** | Mobile/Desktop | View own contract, payment history, make online payment |

Role-based access control is required from day one.

---

## 5. Scope

### In Scope (Phase 1 — MVP)
- User authentication and role-based permissions
- Lot inventory with interactive map (status: available / reserved / sold / occupied)
- Customer / lot-owner records with ownership history
- Sales transactions (full payment and installment)
- Installment contract tracking with payment schedule, balance, and aging
- Payment intake (cash, check, bank transfer) with official receipt generation
- Basic expense tracking (operating expenses, categorized)
- Dashboard: sales, collections, AR aging, expenses, net position

### In Scope (Phase 2)
- Interment scheduling with calendar view and conflict detection
- Document generation: contracts (PDF), official receipts (BIR-compliant), demand letters
- Reporting module: customizable date ranges, exports to Excel/PDF
- Audit log for all financial transactions
- GPS-based lot navigation (if not already in Phase 1 — see §7)

### In Scope (Phase 3)
- Customer self-service portal (view contract, make online payments)
- Automated SMS/email payment reminders
- Online payment gateway integration (GCash, Maya, card)
- Advanced analytics

### Out of Scope (explicitly excluded unless renegotiated)
- Accounting/general-ledger replacement (the system feeds data to QuickBooks/Xero, doesn't replace them)
- Funeral home / mortuary operations
- Inventory of caskets, urns, headstones
- Native mobile apps (responsive web only)

---

## 6. Functional Requirements (by Module)

### 6.1 Cemetery Map & Lot Inventory
- Visual map of cemetery with all lots rendered.
- Click/tap a lot → see status, owner (if any), contract, occupant (if any), payment history.
- Filter map by status, lot type, section/block.
- Lot types: **single, family, mausoleum, niche/columbarium** (different capacity and pricing rules — confirm types with client).
- Each lot has: ID, section/block/row, type, dimensions, base price, status, current owner, occupants.

### 6.2 Customer & Ownership Records
- Full customer profile (name, contact, address, gov ID, relationship to occupant).
- Ownership history per lot (a lot sold in 1995 may transfer to heirs in 2025 — capture all transfers).
- Document attachments (ID copies, transfer affidavits).

### 6.3 Sales
- Full-payment sale: lot → customer, single receipt, status changes to "sold."
- Installment sale: generates contract with schedule (term, down payment, monthly amount, due day).
- Configurable: discounts, promo pricing, perpetual care fees.

### 6.4 Installment Contracts
- Auto-generated payment schedule.
- Track per-installment status: due, paid, partial, missed.
- **Grace period and penalty rules** — must be configurable; confirm policy with client (see Open Questions).
- AR aging (current, 30/60/90/90+ days).
- Contract states: active, fully paid, in default, cancelled, transferred.

### 6.5 Payments
- Accept payment against a contract or as full payment.
- Multiple methods: cash, check, bank transfer, (Phase 3) online.
- Auto-allocate to oldest unpaid installment by default; allow manual allocation.
- Print/email official receipt (BIR-compliant format — confirm requirements).

### 6.6 Interment Scheduling (Phase 2)
- Calendar of scheduled interments.
- Each interment ties to a lot and an occupant record.
- Prevent double-booking the same lot or time slot.
- Field workers can mark interment complete with timestamp and notes.

### 6.7 Expense Tracking
- Categorized operating expenses (utilities, maintenance, salaries, supplies, etc. — confirm categories).
- Date, amount, vendor, category, attachment (receipt photo).
- Approval workflow (Phase 2 if needed).

### 6.8 Reporting & Dashboard
- KPI dashboard: MTD/YTD sales, collections, AR balance, expenses, net.
- Sales by lot type, section, sales agent.
- Collection efficiency, AR aging.
- Expense by category.
- Exportable to Excel/PDF.

---

## 7. Key Technical Decisions

### 7.1 The Map (Critical Decision)
Three options were considered:

| Option | Pros | Cons | Recommendation |
|--------|------|------|----------------|
| Static image + hotspots | Fast to build | No GPS for field, hard to update | Backup only |
| **Real GPS (Leaflet + geometry in Convex)** | Field workers navigate to actual lots; future-proof; satellite overlay | Requires one-time GPS survey of 2,000+ lots | **Recommended** |
| SVG custom map | Flexible visuals | No GPS, requires manual drawing | Phase 1 fallback if GPS survey delayed |

**Recommendation:** Store lot geometry (lat/lng centroid + polygon vertices as arrays) on each lot document from day one, with indexes on bounding-box fields for viewport queries. Start with an SVG/image overlay for Phase 1 launch if the GPS survey isn't complete, then switch the rendering layer to Leaflet without changing the schema.

### 7.2 Stack (Confirmed)
- **Frontend:** **Next.js** (App Router, React, TypeScript) — responsive web, single codebase for desktop + mobile browser.
- **Backend + Database:** **Convex** — reactive backend with built-in document database, real-time subscriptions, server functions (queries/mutations/actions), scheduled functions, and file storage. Replaces the traditional API layer, ORM, and most of the auth/storage glue.
- **Auth:** Convex Auth (or Clerk integrated with Convex) — role-based access enforced inside Convex functions, not just at the UI layer.
- **Map rendering:** Leaflet with OpenStreetMap or Mapbox tiles (rendering layer is decoupled from data layer).
- **Hosting:** Vercel for the Next.js app; Convex is self-hosted by Convex Cloud.
- **File storage:** Convex File Storage (built-in) for ID scans, receipts, contract PDFs.
- **Scheduled jobs:** Convex scheduled functions (cron) for AR aging recalculation, payment reminders (Phase 3), daily backups.

#### Implications of the Convex choice
- **No PostGIS.** Spatial queries are handled in Convex by storing lot geometry (lat/lng centroid + polygon vertices) as document fields and using indexed bounding-box queries. For 2,000+ lots this is well within Convex's performance envelope — viewport-based lot loading is the right pattern, not "load all lots."
- **Real-time by default.** Multi-user scenarios (office staff and field workers seeing the same lot update live) come essentially for free via Convex's reactive queries. This is a meaningful UX win — no manual refresh, no websockets to wire up.
- **Schema in code.** Convex schema lives in TypeScript (`convex/schema.ts`). The Architect should produce this schema file as the canonical data model, not a separate ERD.
- **No SQL.** All queries are TypeScript functions. Reporting that requires complex aggregation should be designed as Convex queries with appropriate indexes, or pre-aggregated into summary documents updated on write.
- **Financial integrity.** Convex mutations are atomic and serializable per document — good for payment posting. For multi-document transactions (e.g., payment + contract update + receipt generation), wrap in a single mutation.

### 7.3 Non-Functional Requirements
- **Performance:** Map with 2,000+ lots must render and remain interactive on a mid-range Android phone over 4G.
- **Offline tolerance:** Field workers may have spotty signal — at minimum, read-only lot lookup should work after first load (PWA with cache).
- **Security:** All financial transactions logged. PII (customer IDs) encrypted at rest. HTTPS only.
- **Backup:** Daily automated DB backup, 30-day retention minimum.
- **Audit trail:** Every contract, payment, and expense change is logged with user and timestamp.

---

## 8. Phasing & Milestones (Proposed)

**Phase 1 — MVP (target: 10–14 weeks)**
- Auth, lot inventory + map (static), customer records, sales, installment contracts, payments, basic expense tracking, dashboard.

**Phase 2 — Operations (target: +6–8 weeks)**
- Interment scheduling, document generation, reporting, audit log, GPS survey + Leaflet migration.

**Phase 3 — Customer-facing (target: +6–8 weeks)**
- Customer portal, online payments, SMS/email reminders, advanced analytics.

---

## 9. Data Migration

Existing records (paper, Excel, or other) must be migrated. Migration plan to be confirmed once client provides current data formats. Expect this to be **~30–40% of Phase 1 effort** for a cemetery of this size.

---

## 10. Risks & Open Questions

### Risks
- **Scope creep on contract policy** — installment penalty and grace rules vary widely and are easy to under-spec.
- **Data quality of legacy records** — paper records may be inconsistent; migration may surface ownership disputes.
- **GPS survey logistics** — capturing 2,000+ lot coordinates takes time and good weather.
- **BIR compliance for receipts** — non-trivial; may require accredited POS-style receipt printer integration.

### Open Questions for Client (must answer before Phase 1 dev starts)
1. What is the exact policy for **missed installment payments**? Grace period? Penalty rate? When does a lot get reclaimed?
2. What **lot types** exist and what is the pricing structure for each?
3. What are the **BIR receipt requirements** — do they currently use accredited receipts, and is a registered POS needed?
4. What **existing records** exist (paper, Excel, other system) and in what condition?
5. Are there **multiple sales agents** with commission tracking required?
6. What is the policy on **ownership transfers** (sale, inheritance, gift)? Documentation required?
7. **Perpetual care fees** — annual? One-time? How tracked?
8. **Expense categories** — predefined list from the client.
9. **Approval workflows** — do expenses need approval before recording, or post-hoc?
10. **Number of named user accounts** required at launch (sizes the auth setup).

---

## 11. References / Context for BMAD Agents

- **Analyst:** Use this brief as project context; produce a deeper market/competitive analysis only if client requests it (commercial cemetery software exists — CIMS, PlotBox, byondpro — for reference, not replication).
- **PM:** Expand §6 into full PRD with user stories per module. Resolve §10 open questions before finalizing.
- **Architect:** Produce `convex/schema.ts` as the canonical data model. Design lot geometry fields and indexes for bounding-box viewport queries. Plan migration path from legacy records. Document the auth/role model and where role enforcement lives in Convex functions.
- **PO:** Prioritize Phase 1 stories; defer anything Phase 2+ regardless of how "small" it seems.
- **SM:** Suggested sprint size 2 weeks. Phase 1 ≈ 5–7 sprints.

---

*Document version: 0.2 — stack confirmed as Convex + Next.js. To be revised once client answers open questions in §10.*
