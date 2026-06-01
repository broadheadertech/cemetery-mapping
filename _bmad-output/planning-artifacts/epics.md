---
stepsCompleted: ['step-01-validate-prerequisites', 'step-02-design-epics', 'step-03-create-stories', 'step-04-final-validation']
lastStep: 4
status: 'complete'
completedAt: '2026-05-17'
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/architecture.md
  - _bmad-output/planning-artifacts/ux-design-specification.md
  - cemetery-management-system-brief (1).md
workflowType: 'epics-and-stories'
project_name: 'cemetery-mapping'
user_name: 'theundead'
date: '2026-05-17'
---

# cemetery-mapping — Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for cemetery-mapping, decomposing the requirements from the PRD, UX Design Specification, and Architecture into implementable stories.

## Requirements Inventory

### Functional Requirements

**1. Identity & Access Control**

- **FR1:** An unauthenticated user can authenticate using credentials issued by an Admin. [P1]
- **FR2:** An Admin can create, deactivate, and update staff and field-worker accounts. [P1]
- **FR3:** An Admin can assign one or more roles (Admin/Owner, Office Staff, Field Worker) to each account. [P1]
- **FR4:** The system can enforce role-based access on every data read and write at the server, not just the UI. [P1]
- **FR5:** A Customer can authenticate to the self-service portal using credentials linked to their contracts. [P3]

**2. Lot Inventory & Mapping**

- **FR6:** Office Staff can create, edit, and retire lot records with section/block/row, type, dimensions, base price, and status. [P1]
- **FR7:** Any authenticated user can search lots by ID, section/block, owner name, or status. [P1]
- **FR8:** Any authenticated user can view a lot detail showing status, current owner (if any), occupants, active contract, and payment history. [P1]
- **FR9:** The system can store lat/lng centroid and polygon vertices on every lot record from Phase 1. [P1]
- **FR10:** Any authenticated user can view a 2D map showing all lots with status-coded markers, filterable by section/block/type/status. [P1 static · P2 GPS-backed]
- **FR11:** A Field Worker can read lot data on a phone browser after first load even when offline. [P1]
- **FR12:** A Field Worker on a phone can request turn-by-turn navigation from current GPS position to a lot's centroid. [P2]
- **FR13:** A Field Worker can log lot condition (note + photo + timestamp) against a lot. [P1]

**3. Customer & Ownership Records**

- **FR14:** Office Staff can create a customer record with name, contact, address, government-ID number, and relationship to occupant. [P1]
- **FR15:** Office Staff can upload identification documents (ID scans, transfer affidavits) to a customer or transfer record. [P1]
- **FR16:** The system can maintain a time-versioned ownership history for every lot (owner, effective dates, transfer type). [P1]
- **FR17:** Office Staff can record an ownership transfer (sale, inheritance, gift, court order) with required documentation and effective date. [P1, gated on §10 Q6]
- **FR18:** The system can record one or more occupants per lot with name, date of interment, and relationship to owner — distinct from owner records. [P1]

**4. Sales & Installment Contracts**

- **FR19:** Office Staff can record a full-payment sale linking a lot, a customer, price, and payment method. [P1]
- **FR20:** Office Staff can record an installment sale with configurable down payment, term, due day, grace period, and penalty rules. [P1, gated on §10 Q1]
- **FR21:** The system can auto-generate the payment schedule for an installment contract on creation. [P1]
- **FR22:** Office Staff can apply configurable discounts and promo pricing to a sale. [P1]
- **FR23:** A contract can transition through states (active, fully_paid, in_default, cancelled, transferred); state transitions require an explicit user action with logged reason. [P1]
- **FR24:** An Admin can void or cancel a contract pre-interment with logged reason. [P1]
- **FR25:** The system can attach perpetual care fees (one-time, annual, or none) to a contract based on configuration. [P1, gated on §10 Q7]

**5. Payments & BIR Receipts**

- **FR26:** Office Staff can record a payment against a contract (cash, check, bank transfer) with auto-allocation to the oldest unpaid installment as default. [P1]
- **FR27:** Office Staff can override default allocation and manually allocate a payment across installments. [P1]
- **FR28:** The system can generate a BIR-compliant official receipt for every recorded payment, with a unique sequential serial number per the cemetery's BIR registration. [P1, gated on §10 Q3]
- **FR29:** The system can record a receipt as voided with an explicit reason; voided serial numbers remain consumed and are not re-issued. [P1]
- **FR30:** Office Staff can print and email a generated receipt as PDF. [P1]
- **FR31:** Once issued, a payment and its receipt are immutable; corrections require a separate reversal entry that issues a new receipt. [P1]
- **FR32:** The system can post payment, contract balance update, receipt generation, and audit-log entry as a single atomic transaction. [P1]
- **FR33:** A Customer can pay an installment online via supported gateways (GCash, Maya, card); the system can post the payment atomically on receipt of the gateway webhook. [P3]

**6. AR Aging & Collections Workflow**

- **FR34:** The system can compute AR aging buckets (current / 30 / 60 / 90+ days) for every active contract on a daily schedule. [P1]
- **FR35:** Office Staff can attach a logged follow-up action (free-text note + target date) to any overdue installment. [P1]
- **FR36:** The system can re-flag overdue installments whose logged follow-up action target date has passed without resolution. [P1]
- **FR37:** An Admin can transition a contract to in_default status with a logged reason; default state does not automatically reclaim the lot. [P1]
- **FR38:** An Admin can reclaim a defaulted lot in a separate explicit action with logged reason; the lot returns to available and prior payments are recorded per policy. [P1, gated on §10 Q1]

**7. Expense Tracking**

- **FR39:** Office Staff can record an operating expense with date, amount, vendor, category, and optional receipt-photo attachment. [P1, categories gated on §10 Q8]
- **FR40:** An Admin can define and edit the list of expense categories. [P1]
- **FR41:** An Admin can configure whether expenses require approval before posting; pending-approval expenses do not affect dashboard totals until approved. [P2, gated on §10 Q9]

**8. Reporting & Financial Dashboards**

- **FR42:** An Admin can view a KPI dashboard showing MTD/YTD sales, collections, AR balance, AR aging breakdown, expenses, and net position. [P1]
- **FR43:** An Admin can drill down from any dashboard metric to the underlying contracts, payments, or expenses. [P1]
- **FR44:** An Admin can flag a specific contract for staff follow-up with a short comment; the flag appears in the assigned staff's queue. [P1]
- **FR45:** An Admin can view a report breaking down sales by lot type, section, and (if enabled) sales agent. [P2, agent breakdown gated on §10 Q5]
- **FR46:** An Admin can export any report to Excel or PDF for a configurable date range. [P2]
- **FR47:** An Admin can view a full audit log of financial mutations filterable by actor, entity, and date range. [P2]
- **FR48:** An Admin can view trend analysis of sales, collections, and AR balance over user-selected time periods. [P3]

**9. Document Generation**

- **FR49:** Office Staff can generate an installment contract as a PDF document. [P2]
- **FR50:** Office Staff can generate a demand letter for an overdue contract as a PDF document. [P2]

**10. Interment Scheduling**

- **FR51:** Office Staff can schedule an interment against a lot and an occupant record on a date and time. [P2]
- **FR52:** The system can prevent double-booking of the same lot or the same scheduled time slot. [P2]
- **FR53:** A Field Worker can mark an interment as complete with timestamp and notes. [P2]
- **FR54:** Office Staff can view a calendar of scheduled interments filterable by section, date range, and status. [P2]

**11. Customer Self-Service**

- **FR55:** A Customer can view their own contracts, payment history, current balance, and remaining installments. [P3]
- **FR56:** A Customer can download a receipt for any past payment as a PDF. [P3]
- **FR57:** The system can send automated SMS or email payment reminders to customers based on configurable rules. [P3]
- **FR58:** A Customer can update their own contact information (excluding name and government-ID number). [P3]

**12. System Operations, Audit & Compliance**

- **FR59:** The system can append an audit-log entry (actor, timestamp, before/after values) on every financial-touching mutation. [P1]
- **FR60:** The system can run a daily reconciliation invariant (sum of payments against contract = contract balance reduction) and surface failures on the Admin dashboard. [P1]
- **FR61:** The system can produce a daily database backup retained for at least 30 operational days. [P1]
- **FR62:** The system can produce an archival export of receipts and related records suitable for 10-year retention per BIR. [P1]
- **FR63:** An Admin can produce a data-subject report listing all PII the system holds about a named customer. [P1]
- **FR64:** The system can log access to PII fields and ID-scan files; the log supports a "which records were affected" query for breach response. [P1]
- **FR65:** The system can encrypt PII fields and ID-scan files at rest. [P1]

### NonFunctional Requirements

**Performance**

- **NFR-P1:** Largest Contentful Paint (LCP) on the office-staff workflow routes — < 2.5s on desktop, < 4s on mid-range Android over emulated 4G. Measured via Lighthouse in CI on every PR.
- **NFR-P2:** Map render (first paint with all visible lots) — < 3s on mid-range Android over 4G. Measured against the production lot inventory (2,000+ lots, viewport-based loading).
- **NFR-P3:** Map pan/zoom frame rate — ≥ 30fps on mid-range Android.
- **NFR-P4:** Convex query latency — p95 < 300ms across all production query traffic.
- **NFR-P5:** Interaction-to-Next-Paint (INP) — < 200ms at p75 across all interactive UI.
- **NFR-P6:** Initial JS bundle on every authenticated route — < 250KB gzipped.
- **NFR-P7:** Office-staff transactional flow (open new-sale screen → submit completed sale with receipt issued) — < 4 minutes elapsed including data entry.

**Security & Privacy**

- **NFR-S1:** All HTTP traffic is TLS 1.2+; HTTP requests redirect to HTTPS. No mixed content.
- **NFR-S2:** PII fields (customer government-ID number, optionally full address) are encrypted at rest with keys held in Convex's managed key infrastructure.
- **NFR-S3:** ID-scan files and other PII attachments in Convex File Storage are gated by RBAC-checked access URLs. No public-by-default file URLs.
- **NFR-S4:** Every Convex mutation and query enforces role-based access at the server. UI-only authorization is a non-compliance defect.
- **NFR-S5:** Authentication sessions expire after configurable inactivity (default 8 hours office staff, 30 days customer-portal, 1 hour Admin).
- **NFR-S6:** Failed authentication attempts rate-limited per account (default: 5 failures in 15 minutes → 1-hour lockout).
- **NFR-S7:** Audit log is append-only at the database level — no mutation can update or delete audit-log rows in production.
- **NFR-S8:** PII access log captures user, timestamp, customer record accessed, and access type for every interaction with PII fields and ID-scan files. Supports "which subjects affected by access in window X" query for breach response within 72 hours.

**Reliability & Availability**

- **NFR-R1:** Target uptime during cemetery operating hours (08:00–17:00 Manila time, Mon–Sat) — 99.5% monthly. (⚠️ Pending procurement decision — Convex Enterprise tier or NFR downgrade.)
- **NFR-R2:** Convex managed backups produce a daily point-in-time snapshot retained ≥ 30 operational days. Restore RPO ≤ 24 hours, RTO ≤ 4 hours.
- **NFR-R3:** Archival export of receipts and financial records retained ≥ 10 years in cold storage per BIR retention requirements.
- **NFR-R4:** Daily reconciliation invariant (FR60) failures appear on the Admin dashboard within 2 hours of detection.
- **NFR-R5:** Payment-posting mutations are atomic; client-side retries with the same idempotency key produce no duplicate payments or receipts.
- **NFR-R6:** Read-path PWA cache (FR11) serves field-worker lot lookups with cached data up to 24 hours stale after last successful sync, after which the UI clearly indicates "data may be outdated."

**Accessibility**

- **NFR-A1:** All authenticated routes target WCAG 2.1 Level AA conformance. Verified via automated axe-core scans in CI plus quarterly manual audit.
- **NFR-A2:** Lot status is encoded with color + icon + text label (never color alone). Verified colorblind-safe.
- **NFR-A3:** All interactive elements reachable by keyboard with visible focus indicators. Office-staff flows complete end-to-end without a pointing device.
- **NFR-A4:** Touch targets on the field-worker mobile UI are ≥ 44 × 44 px.
- **NFR-A5:** Body-text contrast against the field-worker map base layer passes WCAG AA (≥ 4.5:1) in both default and direct-sunlight conditions.
- **NFR-A6:** Form validation errors are announced to screen readers via aria-live regions.

**Integration**

- **NFR-I1 (Phase 3):** Payment gateway webhooks (GCash, Maya, card) are idempotent on the gateway's transaction ID.
- **NFR-I2 (Phase 3):** Webhook handlers acknowledge within 5 seconds; long-running work deferred to scheduled actions.
- **NFR-I3 (Phase 3):** SMS/email provider integration tolerates provider downtime — failed reminders queue and retry up to 3 attempts over 24 hours.
- **NFR-I4:** No external integrations have hard dependencies in Phase 1.

**Compliance**

- **NFR-C1:** Every BIR receipt generated carries a serial number unique across all receipts ever issued. No serial gaps; voids consume their serial.
- **NFR-C2:** Receipts and their underlying payments are immutable after issuance. Reversals create new records.
- **NFR-C3:** Customer can be issued a Data Privacy Act subject report within 15 working days of request.
- **NFR-C4:** Breach impact query returns results within 2 hours to support the 72-hour NPC notification window.
- **NFR-C5:** Customer consent for ID retention is captured and timestamped at customer creation. Records without consent cannot have ID scans attached.

**Maintainability**

- **NFR-M1:** Convex schema, all queries/mutations/actions, and the Next.js app are strict TypeScript end-to-end. No `any` types in production code without explicit ESLint suppression + reviewer sign-off.
- **NFR-M2:** Test coverage on financial-touching server functions (payments, contract state transitions, reconciliation) — ≥ 90% line coverage. Coverage enforced in CI.
- **NFR-M3:** Architecture Decision Records (ADRs) captured in-repo under `docs/adr/` for every decision that constrains future implementation.
- **NFR-M4:** Cemetery owns the codebase (Git repo), Convex project, and Vercel deployment from day one.
- **NFR-M5:** Local dev environment startup from clean clone — < 10 minutes including Convex dev deploy and seed data.

### Additional Requirements

Drawn from the Architecture document — technical setup and infrastructure requirements that shape implementation:

**Project initialization & toolchain (Epic 1 — Setup):**

- Run `npx create-next-app@latest cemetery-mapping --typescript --tailwind --eslint --app --src-dir --use-npm --import-alias "@/*"` as the first commit
- Add `convex` package + run `npx convex dev` to scaffold the Convex backend project
- Cemetery owns the Git repo, Convex project, and Vercel deployment from day one (NFR-M4)
- TypeScript strict mode enabled in initial commit (NFR-M1)
- ESLint configured with custom rules: no client-side imports of `leaflet`/`pdfkit`, no `ctx.db.patch(..., { status })` outside state-machine files, no `* / 100` math on `Cents`-suffix identifiers, every `convex/*.ts` must contain `requireRole` call

**Cornerstone server-side infrastructure (Phase 1 weeks 1–2):**

- `convex/lib/auth.ts` — `requireRole(ctx, [...])` helper, called as first line of every public function
- `convex/lib/stateMachines.ts` — transition tables for contract states, lot states, receipt states; `assertTransition(...)` guard
- `convex/lib/audit.ts` — `emitAudit(...)` helper; audit log writes only via this helper (lint-enforced)
- `convex/lib/postFinancialEvent.ts` — ★ atomic-mutation cornerstone; all financial mutations route through it; ≥ 95% line coverage
- `convex/lib/pii.ts` — `readPii(ctx, customerId, fields[])` helper logs access on every PII read
- `convex/lib/money.ts` — integer-centavo arithmetic helpers (add, sub, mul, pctOf as basis points)
- `convex/lib/time.ts` — Manila timezone helpers + `Date.now()` wrapper
- `convex/lib/errors.ts` — `ConvexError` discriminated code constants

**Configuration-driven receipt template:**

- BIR receipt template lives in config, not hardcoded — changeable without a deploy
- Config includes cemetery TIN, BIR ATP reference, registered business name, address
- Receipt format gated on §10 Q3 client answer

**Compliance & audit infrastructure:**

- Convex's default at-rest encryption satisfies NFR-S2
- ID-scan files stored in Convex File Storage with auth-gated signed URLs (no public-by-default URLs)
- `auditLog` table append-only enforced via mutation pattern (no patch/replace/delete writes)
- `piiAccessLog` table for breach-impact query (NFR-C4)
- Monthly archival export via Convex scheduled action to compressed JSON in Convex File Storage, mirrored to S3-compatible bucket the cemetery controls (NFR-R3 / FR62)
- Daily reconciliation invariant scheduled function (FR60)

**CI/CD pipeline:**

- GitHub Actions: lint → typecheck → Vitest → Playwright (smoke subset) → Lighthouse on every PR
- Full Playwright suite + extended Lighthouse run nightly
- Vercel preview per PR + Convex preview deployment per PR (using April-2026 reusable-preview-name pattern)
- Production deploy on `main` merge: `npx convex deploy` + Vercel auto-deploy

**Monitoring & observability:**

- Convex built-in function logs + metrics for server
- Sentry free tier for client-side error tracking + Web Vitals
- Admin-only `recent_errors` Convex query surfacing last 24h of Sentry events + Convex errors on the dashboard

**Deferred to Phase 3 architectural re-evaluation:**

- Customer-portal auth approach (Convex Auth + Twilio SMS-OTP vs. Better Auth)
- Payment gateway webhook handlers in `convex/http.ts` (GCash, Maya, card)
- SMS / email provider integration for reminders

### UX Design Requirements

Drawn from the UX Design Specification — first-class implementation work items, not supplementary material:

**Design tokens & theme infrastructure:**

- **UX-DR1:** Implement Tailwind config with all semantic color tokens from § Visual Design Foundation (primary slate-800, surface/text scales, status palette across 7 lot states + 5 payment states, focus-ring, destructive, flash). All contrast ratios verified WCAG 2.1 AA.
- **UX-DR2:** Implement outdoor / high-contrast mode via `[data-theme="outdoor"]` selector with pure-black-on-white, thicker pill borders, yellow focus rings, shadows removed. Single user-menu toggle; respect `prefers-contrast: more` automatically; preference saved per-user.
- **UX-DR3:** Load Inter font via `next/font/google` with `display: 'swap'`; configure tabular numerics for money/IDs/dates; lock 4-weight scale (400/500/600/700); confirm Filipino character rendering (ñ, é, ô).
- **UX-DR4:** Implement 4px-base spacing scale + 12-col CSS Grid for desktop (max 1440px), single-column for mobile (16px gutter); density-comfortable vs density-compact classes with user preference.

**Custom domain components (9 components — each is a story):**

- **UX-DR5:** Build `StatusPill` component — 3 sizes (sm/md/lg), all 12 status variants, outdoor-mode auto-variant, 300ms color crossfade on state change, aria-label, color+icon+label always (NFR-A2). ≥ 90% test coverage including axe-core.
- **UX-DR6:** Build `ReactiveHighlight` wrapper — 600ms `bg-amber-50` fade triggered on `watch` prop change; first-render does NOT flash; respects `prefers-reduced-motion`; `aria-live="polite"` announces changes.
- **UX-DR7:** Build `LotMap` component — Phase 1 SVG renderer with per-section overlays; props match Phase 2 Leaflet swap contract; each lot polygon has `role="button"` + `aria-label`; keyboard navigation; status-coded fills.
- **UX-DR8:** Build `SchedulePreview` component — timeline view (default) + table view toggle; editable mode (sale-form preview) + read-only mode (contract detail); 24 dots with paid/current/due/overdue/missed states; tap-for-detail tooltip; keyboard accessible.
- **UX-DR9:** Build `KpiCard` component — label + tabular value + delta with positive/negative/neutral tone; wraps in `ReactiveHighlight`; clickable variant renders as `<button>` with aria-label; responsive `text-2xl`/`text-3xl` sizes.
- **UX-DR10:** Build `ArAgingTable` component — rows with conditional `bg-red-50/30` background for no-logged-action; `StatusPill` in status column; tap-row-to-drill; empty-state copy "No overdue contracts. Stay vigilant."
- **UX-DR11:** Build `ReceiptViewer` component — inline + modal-preview variants; native browser PDF viewer iframe (not image render); print/email/download/void actions; "Generating..." state for fresh receipts; VOIDED watermark for voided.
- **UX-DR12:** Build `LotSearchCommand` (Cmd-K palette) — global keyboard shortcut from any page; searches lots/customers/contracts/receipts with grouped results; recent/pinned items when empty; mobile fullscreen sheet variant.
- **UX-DR13:** Build `StatePillTransition` wrapper — 300ms color crossfade animating between `StatusPill` states; respects `prefers-reduced-motion`.

**Composite form components (per-page implementations):**

- **UX-DR14:** Build `PaymentForm` — focus-on-amount, peso-prefix tabular input, method/date/reference fields, inline allocation preview with manual-allocation toggle, idempotency-key per form-mount, Enter submits, "Review receipt" opens preview modal.
- **UX-DR15:** Build `SaleForm` — lot picker with map+search, customer picker with inline-create, Full/Installment tabs, `SchedulePreview` editable mode, advanced terms (grace + penalty) in expandable section, "Review receipt" opens preview modal.
- **UX-DR16:** Build `CustomerForm` — name/contact/address/gov-ID fields, ID-photo upload via paste/drag/click, consent checkbox, inline-create-friendly layout, no name/gov-ID editing post-creation by non-admins.
- **UX-DR17:** Build `ExpenseForm` — date/amount/vendor/category/receipt-photo, with category picker that auto-suggests from configured list.

**Layout & navigation primitives:**

- **UX-DR18:** Build app shell with route groups `(public)`, `(staff)`, `(customer)`; middleware-based auth-gate redirects; sidebar 240px expanded / 64px collapsed; user menu in sidebar footer with outdoor-mode toggle and sign-out.
- **UX-DR19:** Build mobile top-bar layout — hamburger left (opens Sheet with sidebar contents), page title center, search icon right (opens cmd-K palette as fullscreen).
- **UX-DR20:** Build skip-to-content link at top of every page (`sr-only` until focus); `<html lang="en-PH">`; one `<h1>` per page enforced; breadcrumbs only on detail pages.

**Loading, empty & error states:**

- **UX-DR21:** Implement skeleton-matches-layout pattern for all first-load states (tables, dashboard, lot detail). Shimmer 1.4s linear; respects `prefers-reduced-motion`. NEVER full-page spinners.
- **UX-DR22:** Implement honest cached-state indicator for PWA — amber `Cached 12m ago` pill in page header when PWA cache is the data source; updates to `Live` after sync.
- **UX-DR23:** Implement empty states as calm confirmations, not failures — sentence + optional action button. Examples: "No overdue contracts. Stay vigilant.", "No lots match these filters. Clear filters", "No customers found. Create new customer".
- **UX-DR24:** Implement error-translation layer `src/lib/errors.ts` — `ConvexError` discriminated codes → user-readable sentences (no raw codes, no stack traces, no "Oops!"). Inline error display, not toast.

**Reactive update affordances:**

- **UX-DR25:** Apply `ReactiveHighlight` to: KPI tile values, AR aging counts, table row insertions, contract balance displays, inline totals. NEVER to user-edited form fields or static UI chrome.
- **UX-DR26:** Implement `StatusPill` built-in 300ms transition on `status` prop change across all entity displays.

**Accessibility implementation:**

- **UX-DR27:** Implement focus rings — 2px solid `slate-700` with 2px offset, visible on every interactive element via `:focus-visible`. Outdoor mode uses 4px yellow ring with 2px offset.
- **UX-DR28:** Implement 44×44 px minimum touch targets globally via `min-h-[44px] min-w-[44px]` Tailwind utilities; ESLint custom rule flags violations.
- **UX-DR29:** Implement `aria-live="polite"` on reactive update wrappers; `aria-live="assertive"` for errors; `aria-label` on icon-only buttons; status pills carry their label in `aria-label`.
- **UX-DR30:** Implement PII redaction display patterns — gov ID shows `***-***-1234` by default; click-to-reveal triggers `piiAccessLog` write; ID-scan thumbnails blurred until clicked.

**Performance implementation:**

- **UX-DR31:** Lazy-load Leaflet via `next/dynamic` (Phase 2) so Phase 1 doesn't pay for it.
- **UX-DR32:** Configure `next/image` for all images with proper `sizes` prop; ID-scan photos resized server-side before storage.
- **UX-DR33:** Bundle budget verification in CI — fail PR if initial route JS > 250KB gzipped (NFR-P6).
- **UX-DR34:** Lighthouse mobile CI on every PR at 360px throttled 4G — fail PR if LCP > 4s or INP p75 > 200ms (NFRs P1, P2, P5).

**Testing infrastructure:**

- **UX-DR35:** Configure axe-core via `@axe-core/playwright` on every key page; CI fails build on critical accessibility issues.
- **UX-DR36:** Configure Playwright cross-browser test profiles (Chrome, Edge, Safari, Firefox latest 2 each); nightly + PR smoke.
- **UX-DR37:** Configure visual regression / screenshot tests for `StatusPill` variants in both indoor and outdoor modes; verify contrast in CI.

### FR Coverage Map

All 65 FRs are accounted for. Cross-cutting requirements (FR59 audit emission, FR4 RBAC) have their infrastructure in Epic 1 and are applied in subsequent epics.

| FRs | Epic | Notes |
|---|---|---|
| FR1, FR2, FR3, FR4 | Epic 1 | Auth + RBAC infrastructure |
| FR5 | Epic 9 | Customer portal auth |
| FR6, FR7, FR8, FR9, FR10 (P1), FR11, FR13 | Epic 1 | Lot inventory + map + search + PWA |
| FR10 (P2 portion), FR12 | Epic 8 | GPS migration |
| FR14, FR15, FR16, FR17, FR18 | Epic 2 | Customer + ownership |
| FR19, FR20, FR21, FR22, FR23, FR24, FR25 | Epic 3 | Sales & contracts |
| FR26, FR27 | Epic 3 | Payment intake |
| FR28, FR29, FR30, FR31, FR32 | Epic 3 | BIR receipts + atomicity |
| FR33 | Epic 9 | Online payment gateway |
| FR34, FR35, FR36, FR37, FR38 | Epic 4 | AR aging + default |
| FR39, FR40 | Epic 4 | Expense tracking |
| FR41 | Epic 6 | Expense approval (P2) |
| FR42, FR43, FR44 | Epic 5 | Dashboard |
| FR45, FR46, FR47 | Epic 6 | Reports + audit UI (P2) |
| FR48 | Epic 9 | Trend analysis (P3) |
| FR49, FR50 | Epic 6 | Contract / demand-letter PDFs (P2) |
| FR51, FR52, FR53, FR54 | Epic 7 | Interments (P2) |
| FR55, FR56, FR57, FR58 | Epic 9 | Customer self-service |
| FR59 | Epic 1 (helper) + cross-cutting use in Epics 2–5 | Audit log emission |
| FR60, FR61, FR62 | Epic 5 | Reconciliation + backup + archival |
| FR63, FR64, FR65 | Epic 2 | PII handling |

## Epic List

### Epic 1: Foundation & Floor Operations [P1]

Project initialization + cornerstone server-side helpers + auth/RBAC + lot inventory + Phase 1 SVG map + global search + field-worker PWA + lot condition logging. Maria can authenticate; Junior can find any lot on his phone in < 5s; admin can manage staff accounts. This epic establishes "navigate the floor digitally" and lays down the architectural cornerstones (`requireRole`, `stateMachines`, `emitAudit`) that every subsequent epic builds on.

**FRs covered:** FR1, FR2, FR3, FR4, FR6, FR7, FR8, FR9, FR10 (Phase 1), FR11, FR13, FR59 (helper infrastructure)
**Additional Architecture requirements:** project starter + CI pipeline + all `convex/lib/*` cornerstone helpers
**UX-DRs covered:** UX-DR1, UX-DR2, UX-DR3, UX-DR4, UX-DR5, UX-DR6, UX-DR7, UX-DR18, UX-DR19, UX-DR20, UX-DR21, UX-DR22, UX-DR23, UX-DR24, UX-DR27, UX-DR28, UX-DR29, UX-DR35, UX-DR36, UX-DR37

### Epic 2: Customer & Ownership Records [P1]

Customer CRUD with PII handling, time-versioned ownership history, ownership transfer workflow, PII access logging, encryption-at-rest verification, data-subject reports. Maria knows who owns what and who is interred where; Mr. Reyes can produce a Data Privacy Act subject report on demand within 15 working days (NFR-C3).

**FRs covered:** FR14, FR15, FR16, FR17 (gated §10 Q6), FR18, FR63, FR64, FR65
**UX-DRs covered:** UX-DR16 (CustomerForm), UX-DR30 (PII redaction patterns)

### Epic 3: Sales, Contracts & Payment Intake (with BIR Receipts) [P1, large]

The heart of the system. `postFinancialEvent` cornerstone gets built and battle-tested here. Full-payment sales, installment contract creation with schedule generation, contract state machine, payment intake with auto + manual allocation, BIR-compliant receipt issuance with serial integrity, voids, immutability, atomic multi-document mutations. Maria can complete Journey 1 (4-min sale) and Journey 2 (90s payment) with confidence; Mr. Reyes sees the result live on his dashboard from another room.

**FRs covered:** FR19, FR20 (gated §10 Q1), FR21, FR22, FR23, FR24, FR25 (gated §10 Q7), FR26, FR27, FR28 (gated §10 Q3), FR29, FR30, FR31, FR32
**Additional Architecture requirements:** `postFinancialEvent` cornerstone implementation, `receiptCounter` doc with optimistic concurrency, PDFKit Phase 1 receipt PDF generation, BIR receipt template config
**UX-DRs covered:** UX-DR8 (SchedulePreview), UX-DR11 (ReceiptViewer), UX-DR12 (LotSearchCommand Cmd-K), UX-DR14 (PaymentForm), UX-DR15 (SaleForm)

### Epic 4: AR Aging, Collections & Expense Tracking [P1]

AR aging buckets recomputed daily, logged follow-up actions with target dates, follow-up expiry re-flag, contract default state machine, lot reclaim workflow, basic expense tracking with categories. The cemetery's receivables become continuously visible; operating expenses become tracked rather than guessed.

**FRs covered:** FR34, FR35, FR36, FR37, FR38 (gated §10 Q1), FR39 (categories gated §10 Q8), FR40
**UX-DRs covered:** UX-DR10 (ArAgingTable), UX-DR17 (ExpenseForm)

### Epic 5: Owner Dashboard & Compliance Operations [P1]

KPI dashboard with reactive updates and drill-down, flag-for-followup workflow, daily reconciliation invariant scheduled function, daily backups verified, monthly 10-year BIR archival exports. Mr. Reyes completes Journey 4 in 90 seconds; compliance posture is continuously maintained.

**FRs covered:** FR42, FR43, FR44, FR60, FR61, FR62
**UX-DRs covered:** UX-DR9 (KpiCard), UX-DR13 (StatePillTransition), UX-DR25, UX-DR26 (reactive update application), UX-DR31, UX-DR32, UX-DR33, UX-DR34 (perf implementation)

### Epic 6: Document Generation, Reporting & Audit View [P2]

PDF contract documents, demand letters, custom reports with date-range filters, exports to Excel/PDF, full audit-log read UI, expense approval workflow. The operational-maturity layer on top of the Phase 1 financial spine.

**FRs covered:** FR41 (gated §10 Q9), FR45 (agent breakdown gated §10 Q5), FR46, FR47, FR49, FR50

### Epic 7: Interment Scheduling [P2]

Calendar-based interment scheduling against lots and occupants, double-booking prevention, field-worker completion logging with timestamps, calendar view filterable by section/date. Replaces the phone-and-paper interment coordination.

**FRs covered:** FR51, FR52, FR53, FR54

### Epic 8: GPS Map Migration [P2]

GPS survey of 2,000+ lots (cemetery-side activity preceding dev), Leaflet renderer swapping in place of Phase 1 SVG, turn-by-turn navigation from current GPS position to lot centroid. Unlocks the < 30s field-worker physical lot location metric. If the GPS survey is delayed, Epic 8 ships behind Epics 6 + 7 (Phase 2.5) without blocking the rest of Phase 2.

**FRs covered:** FR10 (Phase 2 GPS-backed portion), FR12

### Epic 9: Customer Self-Service Portal [P3]

Customer authentication (with the Phase 3 architectural re-evaluation of Convex Auth + Twilio vs. Better Auth), self-service portal showing own contracts and payments and receipts, online payment via GCash / Maya / card with webhook atomicity, configurable SMS/email payment reminders, owner-side trend analysis.

**FRs covered:** FR5, FR33, FR48, FR55, FR56, FR57, FR58

## Epic 1: Foundation & Floor Operations [P1]

Project initialization + cornerstone server-side helpers + auth/RBAC + lot inventory + Phase 1 SVG map + global search + field-worker PWA + lot condition logging.

### Story 1.1: Admin logs into the system

As an Admin,
I want to authenticate with email + password,
So that I can access the system as the first user and begin onboarding staff.

**Acceptance Criteria:**

**Given** a freshly cloned and initialized project,
**When** the developer runs `npx create-next-app@latest cemetery-mapping --typescript --tailwind --eslint --app --src-dir --use-npm --import-alias "@/*"` followed by `npm install convex` and `npx convex dev`,
**Then** the project boots successfully with `npm run dev:all` (Next.js + Convex) in under 10 minutes from clean clone (NFR-M5).

**Given** an Admin user seeded into Convex Auth's password provider,
**When** the Admin visits `/login` and submits valid credentials,
**Then** they are authenticated, a session token is set, and they are redirected to the staff layout.

**Given** any user attempts login with invalid credentials,
**When** they submit the form,
**Then** the form shows an inline error sentence ("Incorrect email or password") and does not reveal whether the email exists.

**Given** the developer pushes any commit,
**When** GitHub Actions runs the CI pipeline,
**Then** `lint`, `typecheck`, `vitest`, `playwright smoke`, and `lighthouse` jobs all execute and the build succeeds with TypeScript strict mode enabled (NFR-M1).

### Story 1.2: Server enforces role-based access on every endpoint

As a developer / security reviewer,
I want a single `requireRole(ctx, [...])` helper enforced on every Convex query and mutation,
So that no endpoint can be reached without server-side authorization (NFR-S4).

**Acceptance Criteria:**

**Given** the `convex/lib/auth.ts` helper is implemented,
**When** any public query or mutation is called without calling `requireRole` as the first action,
**Then** ESLint's custom rule fails the build with the message: "Every public Convex function must call requireRole as its first action."

**Given** an authenticated user with the `office_staff` role,
**When** they invoke a query that requires `admin`,
**Then** the call throws `ConvexError({ code: "FORBIDDEN", message: "Your role does not permit this action." })`.

**Given** an unauthenticated request,
**When** it attempts to invoke any public Convex function,
**Then** the call throws `ConvexError({ code: "UNAUTHENTICATED" })` before any read or write occurs.

**Given** a session has been idle longer than the role's configured timeout (Admin 1h / Staff 8h / Customer 30d per NFR-S5),
**When** the user invokes any Convex function,
**Then** the call throws `ConvexError({ code: "SESSION_EXPIRED" })` and the client clears the session token.

### Story 1.3: Admin creates and manages staff accounts

As an Admin,
I want to create, deactivate, and update staff and field-worker accounts and assign roles,
So that I can onboard the team without involving the developer.

**Acceptance Criteria:**

**Given** an Admin is on the `/admin/users` page,
**When** they click "New user" and submit name, email, and one or more role assignments (Admin/Owner, Office Staff, Field Worker),
**Then** the user record is created, a temporary password is generated, and the new user appears in the user list with an active status.

**Given** an Admin views the user list,
**When** they click "Deactivate" on a user,
**Then** the user's `isActive` field is set to false, their sessions are invalidated, and they cannot log in anymore.

**Given** an Admin edits a user's role assignment,
**When** they save changes,
**Then** the change takes effect on the user's next request (no re-login required) and is logged via `emitAudit`.

**Given** a non-admin user attempts to access `/admin/users`,
**When** they navigate to the URL directly,
**Then** middleware redirects them to their dashboard without revealing the page existed.

### Story 1.4: Visual foundation locked + StatusPill + ReactiveHighlight ship

As a developer,
I want all Tailwind tokens locked, Inter font loaded, the `StatusPill` component shipped in 3 sizes / 12 variants with outdoor-mode support, and the `ReactiveHighlight` wrapper component shipped,
So that all subsequent UI work uses a consistent visual language and can apply the 600ms reactive-fade pattern from day one.

**Acceptance Criteria:**

**Given** the `tailwind.config.ts` file,
**When** loaded by Next.js,
**Then** every semantic token from UX § Visual Design Foundation is defined (primary, surface, text, focus-ring, flash, destructive, status palette across 7 lot states + 5 payment states).

**Given** the `StatusPill` component is implemented,
**When** rendered with status `available` at size `md`,
**Then** the markup includes color + icon + label (NFR-A2), contrast ratio passes WCAG 2.1 AA (verified by axe-core in CI), `aria-label` carries the label text, and the icon has `aria-hidden="true"`.

**Given** the user toggles outdoor mode in the user menu,
**When** the `[data-theme="outdoor"]` attribute is set on `<html>`,
**Then** all `StatusPill` instances render with 2px borders and darker tone variants, all buttons switch to black-on-white, focus rings render at 4px yellow.

**Given** the user's OS sets `prefers-contrast: more`,
**When** the user navigates to any page,
**Then** outdoor mode is automatically applied.

**Given** the user's OS sets `prefers-reduced-motion: reduce`,
**When** a `StatusPill` transitions states,
**Then** no color crossfade animation plays.

**Given** the `ReactiveHighlight` wrapper component is implemented in `src/components/ReactiveHighlight.tsx`,
**When** rendered with `{ watch, children, durationMs? }` and the `watch` value changes after first render,
**Then** the wrapper applies `bg-amber-50` for 600ms (default) before fading to transparent; first render does NOT flash; `prefers-reduced-motion` disables the flash; the wrapper has `aria-live="polite"` for screen reader announcement of changes.

### Story 1.5: App shell with route groups, middleware, and Cmd-K palette scaffold

As an authenticated user,
I want a consistent shell with sidebar, top bar (mobile), and Cmd-K palette that appears from anywhere,
So that I can orient myself in the system regardless of which page I land on.

**Acceptance Criteria:**

**Given** an authenticated user navigates to `/`,
**When** the page loads,
**Then** the appropriate route group's layout is applied: `(staff)/` for Admin / Office Staff / Field Worker; `(customer)/` for Customer role (Phase 3); `(public)/` for unauthenticated routes.

**Given** an authenticated Office Staff user,
**When** they navigate to `/admin/users` directly,
**Then** Next.js middleware checks their role and redirects them to `/dashboard` since `/admin/*` requires Admin role (defense-in-depth alongside server-side `requireRole`).

**Given** a user on any page,
**When** they press `Ctrl-K` (or `⌘-K` on Mac),
**Then** the `LotSearchCommand` palette opens as a centered modal on desktop or a fullscreen sheet on mobile, focuses the search input, and shows recent items (empty in this story; populated in story 1.10).

**Given** the user is on a mobile viewport (< 768px),
**When** they tap the hamburger icon in the top bar,
**Then** a Sheet slides in from the left containing the same navigation items as the desktop sidebar; tapping outside or pressing ESC closes it.

**Given** every page in the app,
**When** rendered to the DOM,
**Then** a skip-to-content link is present at the top (visible only on focus), `<html lang="en-PH">` is set, and exactly one `<h1>` exists per page.

### Story 1.6: Audit log emission helper

As a developer / compliance reviewer,
I want a single `emitAudit(ctx, {...})` helper that all financial mutations call,
So that the audit log captures actor + timestamp + before/after values consistently, and is append-only at the database level (NFR-S7).

**Acceptance Criteria:**

**Given** the `convex/lib/audit.ts` helper is implemented,
**When** any code attempts `ctx.db.insert("auditLog", ...)` outside `convex/lib/audit.ts`,
**Then** ESLint fails the build with: "Use emitAudit() from convex/lib/audit.ts; do not write to auditLog directly."

**Given** any code attempts `ctx.db.patch(auditLogId, ...)` or `ctx.db.replace(auditLogId, ...)` or `ctx.db.delete(auditLogId)`,
**When** the build runs,
**Then** ESLint fails the build with: "auditLog is append-only; no patch/replace/delete allowed."

**Given** a mutation calls `emitAudit(ctx, { action: "test", entityType: "lot", entityId: id, before: x, after: y, reason: "test" })`,
**When** the mutation succeeds,
**Then** a new row appears in `auditLog` with `actor` (from ctx auth), `timestamp` (Date.now()), `action`, `entityType`, `entityId`, `before`, `after`, `reason` — with PII fields redacted to last-4 in `before`/`after`.

**Given** the `emitAudit` helper has a Vitest test suite,
**When** the suite runs,
**Then** coverage is ≥ 90% line coverage (NFR-M2 financial code threshold).

### Story 1.7: State machine transition guards

As a developer,
I want explicit transition tables for entities with state (contracts, lots, receipts) and an `assertTransition(...)` guard,
So that illegal state changes are blocked at the mutation layer with logged reasons (cross-cutting infrastructure for FR23, FR24, FR37, FR38).

**Acceptance Criteria:**

**Given** `convex/lib/stateMachines.ts` defines a `transitions` record for entity type `lot` with legal transitions: `available → reserved`, `available → sold`, `reserved → sold`, `reserved → available`, `sold → occupied`, `sold → defaulted`, `defaulted → available` (reclaim),
**When** a developer calls `assertTransition({ entityType: "lot", from: "available", to: "occupied", reason: "test" })`,
**Then** the helper throws `ConvexError({ code: "ILLEGAL_STATE_TRANSITION" })` because `available → occupied` is not a legal transition.

**Given** the same transitions table,
**When** a developer calls `assertTransition({ entityType: "lot", from: "available", to: "reserved", reason: "Mrs. Cruz family lot sale" })`,
**Then** the call succeeds and returns the validated transition object.

**Given** any code in `convex/lots.ts`, `convex/contracts.ts`, `convex/receipts.ts` performs `ctx.db.patch(..., { status: ... })`,
**When** ESLint runs,
**Then** the build fails unless the file imports from `convex/lib/stateMachines.ts` (heuristic check).

**Given** every transition for every entity,
**When** the Vitest test suite runs,
**Then** each legal transition has a passing test and each illegal transition has a test that asserts the `ConvexError`.

### Story 1.8: Office Staff creates and edits lot records

As Office Staff,
I want to create, edit, and retire lot records with section/block/row, type, dimensions, base price, and status,
So that the cemetery's lot inventory is digitally tracked.

**Acceptance Criteria:**

**Given** `convex/schema.ts` defines the `lots` table with fields per the architecture sample (code, section, block, row, type, dimensions, basePriceCents, status, geometry with bbox indexes),
**When** the Convex deploy runs,
**Then** the `by_status`, `by_section_block`, and `by_bbox_lat` indexes are present.

**Given** Office Staff visits `/lots/new`,
**When** they fill in section, block, row, type (single / family / mausoleum / niche), dimensions, base price (in pesos, converted to centavos on submit), and submit with status `available`,
**Then** the lot is created, `emitAudit` is called, and the user is redirected to the new lot's detail page.

**Given** Office Staff on a lot detail page,
**When** they click "Edit" and change the lot's base price,
**Then** the change is saved, `emitAudit` records the before/after, and the lot list reactively updates the price.

**Given** Office Staff attempts to delete a lot that has any payment or contract history,
**When** they click "Retire,"
**Then** the action fails with `ConvexError({ code: "CANNOT_RETIRE_WITH_HISTORY" })` and the UI shows the error sentence.

**Given** Office Staff retires an available lot with no history,
**When** they confirm,
**Then** the lot is marked `isRetired: true` (soft delete; preserves audit trail), and the lot disappears from default lot list filters.

### Story 1.9: Schema-ready lot geometry from day one

As an architect,
I want every lot record to carry lat/lng centroid + polygon vertices + bounding-box index fields from Phase 1,
So that the Phase 2 Leaflet swap is a rendering change, not a data migration (FR9).

**Acceptance Criteria:**

**Given** the `lots` schema in `convex/schema.ts`,
**When** a developer inspects it,
**Then** every lot has `geometry: { centroid: { lat, lng }, polygon: Array<{ lat, lng }>, bboxMinLat, bboxMaxLat, bboxMinLng, bboxMaxLng }` and the `by_bbox_lat` index exists.

**Given** Office Staff creates a lot in Phase 1 without GPS-surveyed coordinates,
**When** the lot is saved,
**Then** the geometry fields default to a placeholder (cemetery's approximate centroid for centroid; empty array for polygon) with a `geometryStatus: "placeholder" | "surveyed"` field set to `"placeholder"`.

**Given** Phase 2 GPS survey data arrives,
**When** a developer or scheduled import updates a lot's geometry,
**Then** `geometryStatus` is set to `"surveyed"` and the bbox fields are recomputed.

**Given** any viewport query is added in story 1.10,
**When** it queries lots by bbox,
**Then** it uses the `by_bbox_lat` index (verified in performance test — query latency p95 < 300ms per NFR-P4).

### Story 1.10: Any authenticated user searches lots from anywhere

As Maria or Junior,
I want to press Cmd-K (or tap the mobile search icon) and find any lot by ID, section/block, or owner name,
So that I can navigate to a specific lot in under 5 seconds without sidebar drilling (FR7).

**Acceptance Criteria:**

**Given** an authenticated user on any page,
**When** they press `Ctrl-K` (`⌘-K` on Mac) and type "D-5,"
**Then** the LotSearchCommand palette filters live (debounced 80ms) and shows matching lots grouped by entity type ("LOTS") with code + status pill + section/block visible.

**Given** the user types "Bautista" (owner name),
**When** the palette searches,
**Then** results appear under both "LOTS" (lots owned by Bautista, via the current-ownership query) and "CUSTOMERS" (Bautista customer records).

**Given** search results are present,
**When** the user presses Enter or clicks a result,
**Then** they are navigated to the result's detail page (lot, customer, contract, or receipt as applicable).

**Given** the search query has no matches,
**When** results would be empty,
**Then** the palette shows "No results for '...'" and remains open until ESC.

**Given** the user has previously navigated to lots,
**When** they open the palette with an empty query,
**Then** the palette shows up to 5 recently-viewed entities for quick re-access.

### Story 1.11: Office Staff views any lot's detail

As Office Staff,
I want to view a lot's complete detail — status, current owner (if any), occupants, active contract, and payment history,
So that I can answer customer questions without consulting paper records (FR8).

**Acceptance Criteria:**

**Given** Office Staff navigates to `/lots/<lotId>`,
**When** the page loads,
**Then** the detail page shows: lot identifier + status pill + dimensions + type + base price, currently-active ownership (if any) with customer name + relationship, list of occupants (if any), active contract preview (if any) with balance + next-due-date, and a placeholder "Payment history" section (populated in Epic 3).

**Given** the lot has no current owner,
**When** the page loads,
**Then** the ownership section shows "Available" with no customer listed and a primary "New Sale" button.

**Given** the lot's status changes server-side while the user is viewing the page (e.g. someone else marks it sold),
**When** the reactive query updates,
**Then** the status pill cross-fades to the new state (300ms via UX-DR26) and a 600ms amber flash (UX-DR25) highlights the change.

**Given** the lot exists in the system,
**When** Office Staff and Field Worker view the same lot detail at the same time,
**Then** they both see the same data; mutations by one are visible to the other within 1 second without manual refresh.

### Story 1.12: Phase 1 SVG map renders lots with status filters

As an authenticated user,
I want to view a 2D map showing all lots with status-coded markers filterable by section/block/type/status,
So that I can visually scan availability and identify lots at a glance (FR10 Phase 1).

**Acceptance Criteria:**

**Given** authenticated user visits `/lots`,
**When** the page loads,
**Then** the LotMap component renders in SVG mode using per-section background overlays from `public/map/overlay-section-*.svg` + lot polygons drawn from the placeholder geometry, status-colored per the `StatusPill` palette.

**Given** the user changes a filter (status / lot type / section),
**When** the filter updates,
**Then** the map re-renders only the matching lots within the current viewport — no other lots fetched (viewport-bbox query); status filter updates the URL (shareable).

**Given** the user is on a mid-range Android (Lighthouse mobile emulation, 4G throttling),
**When** the map page first renders with the production lot inventory (~2,000 lots),
**Then** first-paint completes in under 3 seconds (NFR-P2) and the bundle stays under 250KB (NFR-P6, Leaflet excluded since Phase 1 is SVG-only).

**Given** the user clicks/taps a lot polygon on the map,
**When** the click registers,
**Then** the user navigates to that lot's detail page; the polygon has `aria-label="Lot {code}, {status}"` for screen readers.

**Given** the user is on a viewport less than 768px,
**When** they visit `/lots`,
**Then** the map renders full-width above a toggle that switches between map view and list view.

### Story 1.13: Field worker reads cached lot data offline

As Junior (Field Worker),
I want lot data to remain accessible on my phone even when I lose signal,
So that I can complete lot lookups behind the chapel or in low-coverage areas without waiting (FR11, NFR-R6).

**Acceptance Criteria:**

**Given** the production build,
**When** the user's browser registers the service worker,
**Then** the SW caches `/lots`, `/lots/*`, search queries, and the `LotSearchCommand` static assets for offline retrieval.

**Given** the user navigates to `/lots/D-5-12` while online,
**When** the lot data is fetched,
**Then** the response is stored in the SW cache with a 24-hour TTL.

**Given** the user opens the app on a phone with no signal,
**When** they navigate to a previously-cached lot,
**Then** the lot data renders from cache and the page header shows an amber pill "Cached 12m ago" (UX-DR22).

**Given** cached data is older than 24 hours,
**When** the user views it offline,
**Then** the pill changes to "Cached, may be outdated" (NFR-R6 staleness UI).

**Given** the user attempts to post any mutation (lot condition log, etc.) without signal,
**When** they submit,
**Then** the action is blocked with the inline message: "Posting requires connection. Reconnect and try again."

**Given** the SW is registered in development mode,
**When** the developer runs `npm run dev`,
**Then** the SW does NOT activate (only production builds register the SW per UX-DR / architecture decision).

### Story 1.14: Field worker logs lot condition with note + photo

As Junior (Field Worker),
I want to log a lot's condition with a note, photo, and timestamp,
So that office staff can see lot status updates from the field in real time (FR13).

**Acceptance Criteria:**

**Given** Field Worker on a lot detail page on phone,
**When** they tap "Log condition,"
**Then** a Sheet slides in with fields: free-text note (textarea, 3-row), camera-capture photo (uses native `<input type="file" capture="environment">`), timestamp (auto-filled with Date.now()).

**Given** Field Worker fills the form and submits,
**When** the mutation runs,
**Then** the lot condition is persisted to a `lotConditionLogs` table, the photo file is stored in Convex File Storage with auth-gated access URL, `emitAudit` records the change, and the Sheet closes.

**Given** Office Staff has the same lot detail page open at the same time,
**When** Junior's submission completes,
**Then** Maria's view reactively renders the new condition log entry with a 600ms amber flash.

**Given** Field Worker is on mobile with gloves on,
**When** they tap the "Log condition" button or any field in the Sheet,
**Then** every interactive element is ≥ 44 × 44 px and outdoor-mode toggle works one-tap from the user menu (NFR-A4, NFR-A5).

**Given** Field Worker submits without a photo (photo is optional),
**When** the mutation runs,
**Then** it succeeds with no photo attached.

## Epic 2: Customer & Ownership Records [P1]

Customer CRUD with PII handling, time-versioned ownership history, ownership transfers, PII access logging, encryption-at-rest, data-subject reports.

### Story 2.1: Office Staff creates a customer record

As Office Staff,
I want to create a customer record with name, contact, address, government-ID number, and relationship to occupant,
So that the cemetery has a digital record of every person who owns or is interred in a lot (FR14).

**Acceptance Criteria:**

**Given** `convex/schema.ts` defines the `customers` table with PII fields (govIdNumber stored encrypted at rest per NFR-S2),
**When** Office Staff visits `/customers/new`,
**Then** the CustomerForm renders with fields: full name, phone, email, full address, government-ID type + number, relationship to occupant.

**Given** Office Staff submits a complete customer form,
**When** the mutation runs,
**Then** a customer record is created, the gov-ID number is stored encrypted, `emitAudit` records actor + timestamp (with the gov ID redacted to last-4 in the audit before/after), and the user is redirected to the customer's detail page.

**Given** Office Staff submits a form without government-ID consent checked,
**When** they try to upload an ID scan,
**Then** the upload is blocked with the message "Customer consent for ID retention is required before attaching ID scans" (NFR-C5).

**Given** Office Staff has the customer form open and types a name,
**When** the system finds a fuzzy-matching existing customer,
**Then** a non-blocking notice appears: "Similar customer exists: Mrs. Maria Cruz (gov ID ***-***-1234). [View / Continue with new]."

### Story 2.2: Office Staff uploads identification documents

As Office Staff,
I want to upload ID scans, transfer affidavits, and other documents to a customer or transfer record,
So that the cemetery retains digital copies of legally-relevant documentation (FR15).

**Acceptance Criteria:**

**Given** Office Staff on a customer detail page,
**When** they click "Upload ID" and select a file or paste from clipboard,
**Then** the file is uploaded to Convex File Storage with an auth-gated access URL (no public URL), the file metadata is linked to the customer with attachment type (e.g. `"gov_id_scan"`), and `emitAudit` records the upload.

**Given** the customer has not given retention consent (`hasConsent: false`),
**When** Office Staff attempts upload,
**Then** the upload is blocked with the consent-required message (NFR-C5).

**Given** the file is larger than 10MB,
**When** upload is attempted,
**Then** the client validates and rejects with "File must be smaller than 10MB. Try resizing."

**Given** an authorized user (Office Staff or Admin) views the customer detail page,
**When** they click an ID-scan thumbnail,
**Then** the thumbnail un-blurs to show the full image, the `piiAccessLog` records the access, and the full image loads via a short-lived signed URL.

**Given** an unauthorized user (Field Worker, Customer) attempts to access an ID-scan file URL directly,
**When** they fetch the URL,
**Then** Convex returns 403 unauthorized (NFR-S3 — no public-by-default file URLs).

### Story 2.3: PII access is logged on every read

As an Admin / compliance officer,
I want every access to PII fields (gov-ID number, ID-scan files) logged with actor + timestamp,
So that I can answer "which subjects were affected by a security incident in window X" within 2 hours (NFR-C4, FR64).

**Acceptance Criteria:**

**Given** `convex/lib/pii.ts` exposes `readPii(ctx, customerId, fields[])`,
**When** any client-facing query reads PII fields,
**Then** it routes through `readPii`, which logs to `piiAccessLog { userId, timestamp, customerId, fields, accessType }` before returning the fields.

**Given** any client-facing query in `convex/*.ts` reads `customer.govIdNumber` directly via `ctx.db.get`,
**When** ESLint runs,
**Then** the build fails with the message: "Read PII fields via convex/lib/pii.ts only."

**Given** an Admin queries `piiAccessLog` filtered by `timestamp BETWEEN start AND end`,
**When** the query runs against 6 months of logs,
**Then** results return within 2 seconds and list all subjects whose PII was accessed in that window (NFR-C4 supports the 72-hour NPC breach notification window).

**Given** the customer search query returns customer names,
**When** the customer's name is displayed (not PII per se),
**Then** no `piiAccessLog` entry is created — only PII field reads (gov ID, ID-scan) are logged.

### Story 2.4: Admin produces a data-subject report

As an Admin,
I want to produce a complete report of all PII the system holds about a named customer,
So that I can comply with Data Privacy Act subject access requests within 15 working days (NFR-C3, FR63).

**Acceptance Criteria:**

**Given** an Admin on `/admin/data-subject-report`,
**When** they enter a customer name or ID and submit,
**Then** the system produces a downloadable PDF + JSON report containing: customer record (with full PII), all contracts, all payments, all receipts, all ownership history, all occupants linked, all `piiAccessLog` entries for this customer.

**Given** the report is generated,
**When** the Admin downloads it,
**Then** `emitAudit` records the export with actor + customer ID + timestamp, and the export is logged in `piiAccessLog` with `accessType: "subject_report_export"`.

**Given** the customer does not exist,
**When** the Admin queries,
**Then** the system returns "No customer found" without creating any log entry.

**Given** a non-admin user attempts to access `/admin/data-subject-report`,
**When** they navigate there,
**Then** middleware redirects them to their dashboard.

### Story 2.5: Customer detail page with ownership history

As Office Staff,
I want to see a customer's complete detail — contact info, ownership history, contracts, and document attachments,
So that I can answer any question about that customer without flipping between pages (FR16, FR18).

**Acceptance Criteria:**

**Given** Office Staff navigates to `/customers/<customerId>`,
**When** the page loads,
**Then** the detail page shows: customer name, contact info (phone + email + address; gov-ID redacted to last-4 with click-to-reveal), ownership history (list of lots owned with `effectiveFrom` / `effectiveTo` dates and transfer types), document attachments (ID scans with blurred thumbnails), and a contracts list.

**Given** the customer has owned multiple lots over time,
**When** the ownership history renders,
**Then** entries are sorted by `effectiveFrom` descending, each shows the lot code + transfer type (sale / inheritance / gift / court order) + the dates the ownership was active.

**Given** Office Staff clicks "View full ID number,"
**When** the click registers,
**Then** the gov-ID number un-redacts to its full value, `piiAccessLog` records the read, and a 30-second timeout re-redacts it.

**Given** the customer was created without any owned lots,
**When** the page loads,
**Then** the ownership history section shows the calm empty-state "No lot ownership recorded for this customer."

### Story 2.6: Lot has multiple occupants distinct from owners

As Office Staff,
I want a lot to record one or more occupants (deceased persons interred there) separately from owners,
So that a family lot with multiple interments and a single ownership chain is modelled correctly (FR18).

**Acceptance Criteria:**

**Given** `convex/schema.ts` defines an `occupants` table with `lotId`, `name`, `dateOfInterment`, `relationshipToOwner`,
**When** Office Staff on a lot detail page clicks "Add occupant,"
**Then** a form opens to enter the occupant's name, date of interment, and relationship.

**Given** Office Staff submits the occupant form,
**When** the mutation runs,
**Then** a new occupant record is created linked to the lot, `emitAudit` records the addition, and the lot detail page reactively shows the new occupant.

**Given** a lot has 3 occupants over the years,
**When** Office Staff views the lot detail page,
**Then** all 3 occupants are listed, sorted by `dateOfInterment` ascending.

**Given** the occupant has been recorded but no interment date is known (e.g. legacy migration),
**When** the occupant form is submitted with `dateOfInterment: null`,
**Then** the record saves and the lot detail shows "Date unknown" rather than failing validation.

### Story 2.7: Office Staff records ownership transfer

As Office Staff,
I want to record an ownership transfer (sale / inheritance / gift / court order) with required documentation and effective date,
So that the lot's ownership history reflects the new owner and the lot's ownership relations are time-versioned correctly (FR17 — gated on §10 Q6).

**Acceptance Criteria:**

**Given** `convex/schema.ts` defines `transferEvents` with type, fromCustomerId, toCustomerId, lotId, effectiveDate, requiredDocsAttached,
**When** Office Staff on a lot detail page (with an existing owner) clicks "Record transfer,"
**Then** a Dialog opens with transfer-type selector (sale / inheritance / gift / court order) and a destination-customer picker.

**Given** Office Staff selects transfer type "inheritance" and a new customer,
**When** the type-specific required-documents field shows "Affidavit of self-adjudication" as required,
**Then** the submit button is disabled until at least one matching document is attached.

**Given** Office Staff completes the form including the required documents and an effective date,
**When** they submit and confirm the preview modal,
**Then** a single atomic mutation: closes the previous ownership (sets `effectiveTo` = effectiveDate), opens a new ownership (with `effectiveFrom` = effectiveDate, customerId = new customer), creates a `transferEvent` record with documentation references, and `emitAudit` records the transfer.

**Given** the transfer's effective date is in the past,
**When** submitted,
**Then** the transfer is recorded normally — backdating is permitted for legacy data migration scenarios with audit-logged actor + reason.

### Story 2.8: PII fields encrypted at rest

As an Admin / compliance reviewer,
I want gov-ID numbers and ID-scan files to be encrypted at rest by Convex's managed key infrastructure,
So that NFR-S2 is satisfied without application-level key management.

**Acceptance Criteria:**

**Given** Convex's default at-rest encryption is enabled (it is by default),
**When** any customer record is stored,
**Then** the underlying data store encrypts it at rest with keys held in Convex's managed infrastructure (not application-level keys).

**Given** the implementation has been verified via Convex's published documentation,
**When** an ADR is written (`docs/adr/0007-pii-encryption.md`),
**Then** the ADR documents: Convex's default at-rest encryption satisfies NFR-S2; application-level field-level encryption is intentionally NOT applied (out of scope for the threat model); future revisit point if the threat model expands.

**Given** the ADR exists,
**When** a code reviewer or auditor inspects the codebase for PII encryption posture,
**Then** the ADR clearly states the decision and rationale.

## Epic 3: Sales, Contracts & Payment Intake (with BIR Receipts) [P1, large]

The heart of the system. `postFinancialEvent` cornerstone gets built and battle-tested here. Most consequential epic.

### Story 3.1: Receipt counter with optimistic-concurrent serial allocation

As a developer / compliance officer,
I want a single `receiptCounter` document that tracks the next BIR receipt serial,
So that serial numbers are unique across all receipts ever issued, with no gaps (NFR-C1).

**Acceptance Criteria:**

**Given** `convex/schema.ts` defines a `receiptCounter` table with exactly one row containing `currentSerial: number`,
**When** the Convex deploy runs,
**Then** the table exists with one row, `currentSerial` seeded from the cemetery's BIR-registered starting serial.

**Given** `convex/lib/postFinancialEvent.ts` allocates a new serial,
**When** it reads the counter, increments, and patches in one mutation,
**Then** Convex's per-document optimistic concurrency ensures no two mutations allocate the same serial; if a conflict occurs, the second mutation retries automatically.

**Given** a payment is voided after issuance,
**When** the voided receipt is recorded,
**Then** the serial number remains consumed — the counter is not decremented (FR29).

**Given** a Vitest concurrency test that fires 100 concurrent payment mutations,
**When** the test runs,
**Then** all 100 receipts have unique sequential serial numbers with no duplicates or gaps.

### Story 3.2: `postFinancialEvent` cornerstone

As a developer / architect,
I want every financial mutation (sale, payment, void, gateway-webhook posting) to route through a single `postFinancialEvent(ctx, payload)` helper,
So that atomicity, audit emission, state-machine guards, and receipt-counter allocation are guaranteed for all financial work (FR32, NFR-C1, NFR-C2).

**Acceptance Criteria:**

**Given** `convex/lib/postFinancialEvent.ts` is implemented,
**When** invoked with a payment payload,
**Then** in a single Convex mutation it: (a) calls `requireRole`, (b) checks idempotency-key (returns existing receipt if found), (c) reads + increments `receiptCounter`, (d) inserts the payment record, (e) updates the contract balance, (f) inserts the receipt with the new serial, (g) calls `emitAudit`. All in one mutation, all-or-nothing.

**Given** an idempotency key has already been used,
**When** the same key is submitted again,
**Then** the function returns the existing receipt without writing any new records (NFR-R5).

**Given** any code outside `convex/lib/postFinancialEvent.ts` attempts to `ctx.db.insert` into `payments`, `receipts`, or `paymentAllocations`,
**When** ESLint runs,
**Then** the build fails with: "Use postFinancialEvent for financial table writes."

**Given** the `postFinancialEvent` test suite runs in CI,
**When** coverage is measured,
**Then** line coverage is ≥ 95% (architecture's target above NFR-M2's 90% threshold).

### Story 3.3: Office Staff records full-payment sale

As Office Staff,
I want to record a full-payment sale linking a lot, a customer, price, and payment method,
So that the customer can buy a lot in one transaction with a single receipt (FR19).

**Acceptance Criteria:**

**Given** Office Staff on `/sales/new` with the SaleForm rendered,
**When** they pick a lot (via lot picker), pick or create a customer, choose "Full Payment," enter price + method,
**Then** the form previews the receipt that will be issued.

**Given** they click "Generate & Print" in the preview modal,
**When** the mutation runs through `postFinancialEvent`,
**Then** all of: (a) the lot transitions from `available` to `sold` (via `assertTransition`), (b) a new ownership record opens for the customer, (c) a contract is created in `fully_paid` state, (d) a payment record is inserted, (e) a receipt is issued with the next serial, (f) audit log records the sale.

**Given** the customer was newly created in the same flow,
**When** the sale completes,
**Then** the customer record was created in the same atomic mutation chain (via internal mutation composition).

**Given** the user submits while the lot has already been sold by another office staff member,
**When** `assertTransition` runs,
**Then** the mutation throws `ConvexError({ code: "ILLEGAL_STATE_TRANSITION" })` and the UI shows: "This lot was just sold to someone else. Refresh to view current status."

### Story 3.4: Office Staff records installment sale with schedule

As Office Staff,
I want to record an installment sale with configurable down payment, term, due day, grace period, and penalty rules,
So that customers can buy a lot on installments and the contract tracks every installment (FR20, FR21 — gated on §10 Q1).

**Acceptance Criteria:**

**Given** Office Staff on `/sales/new` chooses "Installment,"
**When** they enter down payment amount, term (12–48 months), due day (1–28), grace period (days), penalty rate (% per month),
**Then** the SchedulePreview renders all installments with computed amounts and due dates, plus a banner showing the grace period and penalty terms.

**Given** the schedule preview is displayed,
**When** the user changes the term or due day,
**Then** the schedule re-renders live without server roundtrip; the cents-precise math is verified by the test suite.

**Given** the user submits the form and confirms the receipt preview,
**When** `postFinancialEvent` runs,
**Then** in one mutation: lot transitions to `reserved`, ownership opens, contract is created in `active` state with all installment rows generated, the down payment is posted against installment #1 (or as a separate "down payment" line item), the receipt is issued.

**Given** the cemetery's installment policy is undefined (§10 Q1 unanswered),
**When** Office Staff opens the form,
**Then** the grace period and penalty rate fields default to placeholder values (5 days / 2% per month) with a banner: "Defaults pending client policy confirmation."

### Story 3.5: Office Staff applies discounts and promo pricing

As Office Staff,
I want to apply configurable discounts and promo pricing to a sale,
So that special pricing (family discount, anniversary promo) is recorded transparently rather than as silent price adjustments (FR22).

**Acceptance Criteria:**

**Given** Office Staff on the SaleForm,
**When** they click "Apply discount,"
**Then** a small panel opens with: discount type (fixed amount / percentage / promo code), value, and a required note explaining the discount.

**Given** Office Staff enters a 10% discount with note "Family loyalty",
**When** they apply it,
**Then** the schedule preview re-renders with the discounted price and the receipt preview shows the discount as a line item.

**Given** the discount type is "promo code" and Office Staff enters a code,
**When** the system validates against an `activePromos` config table,
**Then** valid codes apply the corresponding discount; invalid codes show inline error "Promo code not found or expired."

**Given** the sale is submitted,
**When** the contract is created,
**Then** the discount is recorded on the contract document with the note, applied amount, and actor + timestamp; `emitAudit` captures the discount application.

### Story 3.6: Contract state machine transitions

As Office Staff / Admin,
I want contracts to transition through states (active → fully_paid / cancelled / in_default / transferred) only via explicit user actions with logged reasons,
So that no contract changes state silently (FR23).

**Acceptance Criteria:**

**Given** `stateMachines.ts` defines the contract transition table: `active → fully_paid` (automatic when balance hits zero), `active → cancelled` (requires admin + reason), `active → in_default` (requires admin + reason), `active → transferred` (requires transfer event),
**When** a payment posting brings a contract's balance to zero,
**Then** an internal mutation transitions the contract to `fully_paid` with reason "All installments paid" and `emitAudit` records the transition.

**Given** an Admin on a contract detail page,
**When** they click "Cancel contract" and provide a reason,
**Then** the contract transitions to `cancelled`, the lot status reverts to `available` (via internal state-machine call), and audit records both transitions with the same reason.

**Given** Office Staff (not Admin) attempts to cancel a contract,
**When** they invoke the mutation,
**Then** `requireRole` rejects the call with `FORBIDDEN`.

**Given** a contract is already `fully_paid`,
**When** any user tries to transition it to `cancelled`,
**Then** `assertTransition` throws `ILLEGAL_STATE_TRANSITION` — voiding a fully-paid contract is not a legal flow.

### Story 3.7: Admin voids or cancels a contract pre-interment

As an Admin,
I want to void or cancel a contract before any interment occurs, with a logged reason,
So that pre-interment cancellations (customer changes mind, error in sale) are handled explicitly (FR24).

**Acceptance Criteria:**

**Given** an Admin on a contract detail page where the lot's status is `reserved` (no interment yet),
**When** they click "Void contract" and provide a reason in the Dialog,
**Then** the contract transitions to `cancelled`, the lot status returns to `available`, the ownership record's `effectiveTo` is set to now, all already-issued receipts for this contract remain valid (immutable per FR31), and audit records all three changes.

**Given** the lot has an interment recorded (any occupant has a `dateOfInterment`),
**When** the Admin tries to void,
**Then** the action is blocked with: "Cannot void contract — lot has been interred. Use transfer workflow if ownership needs to change."

**Given** prior payments exist for the cancelled contract,
**When** the void completes,
**Then** the prior payments remain in the database (immutable per FR31); a refund workflow (separate story or out-of-band action) handles the financial reversal.

### Story 3.8: System attaches perpetual care fees to a contract

As Office Staff / Admin,
I want the system to attach perpetual care fees (one-time, annual, or none) to a contract based on configuration,
So that the cemetery's perpetual care revenue is tracked alongside the sale (FR25 — gated on §10 Q7).

**Acceptance Criteria:**

**Given** an Admin has configured perpetual care policy in `/admin/settings`,
**When** Office Staff creates a sale,
**Then** the contract is created with a `perpetualCare: { type: "one-time" | "annual" | "none", amountCents, annualScheduleStart? }` field set per configuration.

**Given** the policy is "annual,"
**When** the contract is created,
**Then** an `annualFeeSchedule` is generated alongside the installment schedule.

**Given** the policy is "one-time,"
**When** the contract is created,
**Then** a single perpetual-care line item is added to the schedule for collection at sale or at customer election.

**Given** the policy is "none" or §10 Q7 is unanswered,
**When** the contract is created,
**Then** no perpetual care fees are attached and the UI shows "Perpetual care: not configured" in the contract detail.

### Story 3.9: Office Staff records a payment with auto-allocation

As Office Staff,
I want to record a payment against a contract with auto-allocation defaulting to the oldest unpaid installment,
So that the common case (customer pays this month's installment) takes one click (FR26).

**Acceptance Criteria:**

**Given** Office Staff on a contract detail page clicks "Record Payment,"
**When** the PaymentForm renders,
**Then** the form fields are: amount (peso-prefix, tabular), method (default Cash), date (default today, Manila tz), reference (optional), and an inline allocation preview showing where the amount will be applied (defaults to oldest unpaid installment).

**Given** Office Staff enters ₱4,000 for a contract with installment #3 (₱4,000 due, overdue) and #4 (₱4,000 due, current),
**When** the allocation preview computes,
**Then** the full ₱4,000 is allocated to installment #3 (oldest unpaid), and #4 remains untouched.

**Given** Office Staff clicks "Review receipt,"
**When** the modal opens,
**Then** the receipt preview renders the actual PDF content (not an image render) showing the payment amount, method, date, and allocation.

**Given** they click "Generate & Print,"
**When** `postFinancialEvent` runs,
**Then** the payment is posted, installment #3 transitions to `paid`, the contract balance decreases, the receipt is issued with the next serial, audit is recorded, the print dialog opens, the modal closes, and the contract detail's payment list shows the new entry with a 600ms amber flash.

**Given** the user's browser crashes after submit but before the print dialog opens,
**When** they re-open the app,
**Then** the payment is recorded with its receipt available; no duplicate was issued (idempotency-key dedup per FR31/NFR-R5).

### Story 3.10: Office Staff overrides default allocation

As Office Staff,
I want to override the default allocation and manually distribute a payment across installments,
So that customer wishes ("apply this to next month, not the overdue one") are honored without breaking the audit trail (FR27).

**Acceptance Criteria:**

**Given** Office Staff on the PaymentForm,
**When** they click "Allocate manually,"
**Then** an inline allocation editor expands showing all unpaid installments with per-row amount inputs.

**Given** Office Staff re-distributes ₱4,000 across installment #4 (₱4,000) instead of the default #3,
**When** the allocation total matches the payment amount,
**Then** the submit button is enabled.

**Given** the override leaves an installment overdue,
**When** Office Staff submits the form,
**Then** the system prompts (inline, not a separate modal): "Installment #3 will remain overdue. Add a logged follow-up action?" with optional free-text reason + target date.

**Given** Office Staff adds a follow-up action note,
**When** the payment posts,
**Then** the follow-up action is recorded on installment #3 with the reason and target date; the AR aging tile categorizes it as "overdue with logged action" rather than "silently overdue."

### Story 3.11: System generates BIR-compliant receipts

As Office Staff / Admin / compliance officer,
I want every recorded payment to generate a BIR-compliant official receipt with a unique sequential serial number,
So that the cemetery's BIR registration obligations are continuously satisfied (FR28, NFR-C1 — gated on §10 Q3).

**Acceptance Criteria:**

**Given** the BIR receipt template config is loaded (cemetery TIN, ATP, registered name, address) from `docs/bir-receipt-template.md` or admin settings,
**When** a payment is posted via `postFinancialEvent`,
**Then** a Convex action generates a PDF receipt using PDFKit with the BIR-required format, the assigned serial, customer name, payment details, method, VAT breakdown (if VAT-registered), and the cemetery's stamp/signature placeholder.

**Given** §10 Q3 is unanswered,
**When** the receipt template is initialized,
**Then** the template uses BIR-compliant placeholders and the cemetery's compliance officer is flagged via dashboard banner: "Receipt format pending BIR confirmation (§10 Q3)."

**Given** a receipt is generated,
**When** it is stored,
**Then** the PDF file is in Convex File Storage with auth-gated URL, the receipt record references the PDF blob ID, and the receipt is immediately viewable from the contract / payment / customer detail pages.

**Given** the PDFKit action fails (e.g. font missing in Node runtime),
**When** the failure occurs,
**Then** the payment IS still recorded (transactional), the receipt record exists with `pdfStatus: "pending"`, a scheduled retry runs, and the contract page shows "Receipt PDF pending — retry generation" with a manual retry button.

### Story 3.12: Office Staff voids a receipt with reason

As an Admin,
I want to void a receipt with an explicit reason that does not consume a new serial,
So that erroneous receipts can be voided per BIR requirements while preserving the audit trail (FR29).

**Acceptance Criteria:**

**Given** an Admin on a payment / receipt detail page,
**When** they click "Void receipt" and the void Dialog opens,
**Then** the dialog requires a void-reason category (e.g. "data entry error," "customer dispute," "cancelled transaction") + free-text explanation.

**Given** the Admin submits the void form,
**When** the mutation runs,
**Then** the receipt's `isVoided` field is set to true, a `voidedReceipts` audit-companion record is created with the reason, the receipt's serial remains consumed (not re-issued), the underlying payment is NOT deleted but flagged as voided, and the contract balance is reversed (a compensating credit is recorded).

**Given** the receipt PDF is regenerated,
**When** the PDF is displayed,
**Then** a "VOIDED" watermark overlays the receipt.

**Given** Office Staff (not Admin) attempts to void,
**When** they invoke the mutation,
**Then** `requireRole` rejects with `FORBIDDEN`.

### Story 3.13: Receipts are print/email-able as PDF

As Office Staff,
I want to print a receipt directly to the office printer and email it to the customer as PDF,
So that customers receive their official receipt immediately (FR30).

**Acceptance Criteria:**

**Given** a generated receipt PDF,
**When** Office Staff clicks "Print,"
**Then** the browser's native print dialog opens with the PDF pre-loaded; the office printer configuration is the user's browser default.

**Given** the customer has an email on file,
**When** Office Staff clicks "Email receipt,"
**Then** a small form opens with the email pre-filled; submitting triggers a Convex action that emails the PDF as an attachment via the configured email provider; on success the action shows "Receipt emailed to ..."; the email send is logged.

**Given** the customer has no email on file,
**When** Office Staff clicks "Email receipt,"
**Then** the form opens with an empty email field that requires entry before submit.

**Given** the email send fails (provider down, invalid address),
**When** the action fails,
**Then** the UI shows the failure inline: "Email could not be sent. Please verify the address or send manually" — the receipt remains intact (the email is a side-channel, not part of the financial mutation).

## Epic 4: AR Aging, Collections & Expense Tracking [P1]

AR aging buckets, logged follow-up actions, default workflow, basic expense tracking.

### Story 4.1: System computes AR aging buckets daily

As an Admin / Owner,
I want the system to recompute AR aging buckets (current / 30 / 60 / 90+ days) for every active contract on a daily schedule,
So that the dashboard always reflects current receivables without manual calculation (FR34).

**Acceptance Criteria:**

**Given** a Convex scheduled function `recomputeArAging` is registered in `convex/scheduled.ts`,
**When** the function runs (daily at 02:00 Manila time),
**Then** for every active contract, it computes each installment's days-overdue and updates the contract's `arAgingSnapshot` (`current`, `days_30`, `days_60`, `days_90Plus` buckets + total overdue amount).

**Given** the aging recompute has just finished,
**When** an Admin opens the dashboard,
**Then** the AR aging tile shows the current snapshot values; values are < 24 hours old at any given time.

**Given** a contract has both current and overdue installments,
**When** the aging snapshot computes,
**Then** the contract appears only in the most overdue bucket (each contract counted once); the bucket totals sum to the total AR.

### Story 4.2: Office Staff attaches logged follow-up actions to overdue installments

As Office Staff,
I want to attach a logged follow-up action with note + target date to any overdue installment,
So that "we're handling this" is visible at scale and overdue ≠ silently-overdue (FR35).

**Acceptance Criteria:**

**Given** Office Staff on an overdue installment row (in contract detail or AR aging page),
**When** they click "Add follow-up action,"
**Then** a Popover opens with: required free-text note (textarea, 3-row max) and target date.

**Given** Office Staff submits,
**When** the mutation runs,
**Then** a `followUpAction` record is attached to the installment with note + targetDate + actor + timestamp; the installment's status pill changes from "Overdue" to "Overdue with logged action" (amber); `emitAudit` records the action.

**Given** the AR aging tile / table is shown,
**When** the recompute next runs,
**Then** the contract is categorized as "with logged action" rather than "silently overdue" in the bucket breakdown.

### Story 4.3: System re-flags expired follow-up actions

As Office Staff,
I want the system to re-flag overdue installments whose follow-up action target date has passed without resolution,
So that no contract slips back into invisible overdue status (FR36).

**Acceptance Criteria:**

**Given** a Convex scheduled function `expireFollowUpActions` is registered,
**When** it runs daily,
**Then** for every `followUpAction` whose `targetDate < now` and whose installment is still unpaid, the action is marked `expired`, the installment's status pill reverts to "Overdue" (silently), and the contract reappears in the "needs follow-up" view.

**Given** Office Staff has dealt with the customer (e.g. recorded payment) before target date,
**When** the recompute runs,
**Then** the now-paid installment is not re-flagged.

**Given** an action expires,
**When** the dashboard reactively updates,
**Then** Office Staff (and the assigned-staff member if applicable) sees the re-flag appear in their queue.

### Story 4.4: Admin transitions contract to in_default

As an Admin,
I want to transition a contract to `in_default` with a logged reason,
So that severely overdue contracts are formally marked for collections (FR37).

**Acceptance Criteria:**

**Given** an Admin on a contract detail page,
**When** they click "Mark as default,"
**Then** a Dialog opens with required free-text reason field; on submit, `assertTransition({ entityType: "contract", from: "active", to: "in_default", reason })` runs.

**Given** the transition succeeds,
**When** the contract state changes,
**Then** the contract's state pill becomes "In Default" (red), the AR aging snapshot recategorizes the contract, audit is logged, the lot status is NOT changed (default ≠ reclaim — explicit per FR38).

### Story 4.5: Admin reclaims a defaulted lot

As an Admin,
I want to reclaim a defaulted lot in a separate explicit action,
So that lot reclamation is intentional and prior-payments handling is explicit per policy (FR38 — gated on §10 Q1).

**Acceptance Criteria:**

**Given** a contract is in `in_default` state,
**When** an Admin on the contract detail clicks "Reclaim lot,"
**Then** a Dialog opens with a warning about prior payments and a required reason field.

**Given** the Admin submits,
**When** the mutation runs,
**Then** in one atomic operation: the contract transitions to `cancelled` (with reason "reclaim — defaulted"), the lot transitions to `available` (via state machine), the ownership record's `effectiveTo` is set to now, the prior-payments handling is invoked per policy (forfeit, refund, or credit — config-driven via §10 Q1).

**Given** §10 Q1's prior-payments policy is unanswered,
**When** the form is opened,
**Then** the policy dropdown defaults to "forfeit" with a warning banner: "Prior-payments policy pending client confirmation."

### Story 4.6: Office Staff records an operating expense

As Office Staff,
I want to record an operating expense with date, amount, vendor, category, and optional receipt photo,
So that the cemetery's operating costs are visible in the dashboard alongside revenue (FR39 — categories gated §10 Q8).

**Acceptance Criteria:**

**Given** Office Staff on `/expenses/new`,
**When** the ExpenseForm renders,
**Then** the fields are: date (Manila tz), amount (peso-prefix, tabular), vendor, category (Select from admin-configured list, defaults to "Other"), receipt photo (optional, drag/paste/click upload).

**Given** they submit,
**When** the mutation runs,
**Then** an `expenses` record is created, the receipt photo (if any) is stored in Convex File Storage with auth-gated URL, and the dashboard's expense total reactively updates with a 600ms amber flash.

**Given** §10 Q8 (predefined categories) is unanswered,
**When** Office Staff opens the form,
**Then** the category dropdown shows a placeholder list ("Utilities, Maintenance, Supplies, Salaries, Other") with a banner: "Expense categories pending client confirmation."

### Story 4.7: Admin manages expense categories

As an Admin,
I want to define and edit the list of expense categories,
So that reports and dashboards reflect the cemetery's actual cost structure (FR40).

**Acceptance Criteria:**

**Given** an Admin on `/admin/expense-categories`,
**When** they click "Add category,"
**Then** a form opens to enter category name + optional description.

**Given** the Admin saves,
**When** the mutation runs,
**Then** the category appears in the list and is immediately available in the ExpenseForm's category dropdown.

**Given** an Admin edits or deactivates a category,
**When** they save,
**Then** existing expenses retain their original category (categories are not retroactively renamed); the deactivated category is hidden from new entries but visible in historical reports.

**Given** a category has expenses linked,
**When** the Admin tries to delete it,
**Then** the action is blocked with: "Cannot delete category with linked expenses. Deactivate instead."

### Story 4.8: AR aging table shows risk distinction

As an Admin / Owner,
I want the AR aging drill-down table to visually distinguish "overdue with logged action" rows from "silently overdue" rows,
So that I can identify the contracts that actually need my attention at a glance (UX-DR10, Journey 4 climax).

**Acceptance Criteria:**

**Given** the `ArAgingTable` component is implemented,
**When** the Owner drills into the 90+ bucket from the dashboard,
**Then** rows with logged actions render with a white background and amber pill in the Status column; rows without logged actions render with `bg-red-50/30` background and red pill.

**Given** an Owner views a bucket with 7 contracts, 3 with logged actions and 4 without,
**When** the page renders,
**Then** the page sub-header notes: "7 contracts overdue · 4 need follow-up."

**Given** the table is sorted by overdue amount descending by default,
**When** the user changes sort,
**Then** the URL updates (shareable view).

**Given** the bucket is empty,
**When** the page renders,
**Then** the empty state shows: "No overdue contracts in this bucket. Stay vigilant." (UX-DR23).

## Epic 5: Owner Dashboard & Compliance Operations [P1]

KPI dashboard with reactive updates, drill-down, flag-for-followup, reconciliation invariant, daily backups, archival exports.

### Story 5.1: KpiCard component using ReactiveHighlight

As a developer / UX implementer,
I want a `KpiCard` component that composes the `ReactiveHighlight` wrapper (from Story 1.4) to display a label + tabular value + optional delta with the 600ms amber fade pattern,
So that dashboard tiles deliver the calm-reactivity affordance defined in UX-DR9.

**Acceptance Criteria:**

**Given** the `KpiCard` component is implemented in `src/components/KpiCard.tsx` and composes `ReactiveHighlight` watching the `value` prop,
**When** rendered with props `{ label, value, delta?, onClick? }`,
**Then** it renders matching the UX spec (label-text-xs / value-text-2xl mobile / text-3xl desktop / delta-text-xs with tone color).

**Given** the card's `value` prop changes due to a reactive query update,
**When** the change occurs,
**Then** the `ReactiveHighlight` wrapper triggers the 600ms amber fade; `prefers-reduced-motion` disables the flash via the wrapper's behavior; the screen-reader announcement also comes from the wrapper.

**Given** an `onClick` prop is provided,
**When** the user clicks/taps the card,
**Then** the card renders as a `<button>` with `aria-label="{label}: {value}, {delta}"` and the click handler fires; keyboard navigation works.

### Story 5.2: Admin views the KPI dashboard

As an Admin / Owner,
I want a dashboard showing MTD/YTD sales, collections, AR balance, AR aging breakdown, expenses, and net position,
So that I can assess the business at a glance in under 90 seconds (FR42, Journey 4).

**Acceptance Criteria:**

**Given** an Admin navigates to `/dashboard`,
**When** the page loads,
**Then** the dashboard renders KpiCards for: MTD sales, MTD collections, AR balance (with breakdown), MTD expenses, Net MTD; plus an AR aging summary tile and a "flagged for follow-up" tile.

**Given** the dashboard is loaded,
**When** a payment is posted by Office Staff in another browser/tab,
**Then** the relevant tiles (sales, collections, AR) reactively update with a 600ms amber flash within 1 second; no manual refresh required.

**Given** the dashboard renders on mobile (< 768px),
**When** displayed,
**Then** KpiCards are 2-up, AR aging breakdown is a card-style list, and all tap targets are ≥ 44px.

**Given** the dashboard's MTD numbers,
**When** the period changes (user clicks "YTD" toggle),
**Then** the values recompute and re-fade in over 600ms.

### Story 5.3: Admin drills down from dashboard metrics

As an Admin / Owner,
I want to click any dashboard metric and see the underlying contracts, payments, or expenses,
So that I can investigate any number without leaving the dashboard mental model (FR43).

**Acceptance Criteria:**

**Given** an Admin on the dashboard,
**When** they click the "MTD Sales" KpiCard,
**Then** they navigate to a list of all sales in the current month with sortable columns and the same status pills as elsewhere.

**Given** they click the "AR Aging 90+" tile,
**When** the click registers,
**Then** they navigate to the `ArAgingTable` filtered to the 90+ bucket (Story 4.8).

**Given** they click a specific contract row in any drill-down,
**When** the click registers,
**Then** they navigate to that contract's detail page.

**Given** any drill-down page,
**When** the user clicks the browser back button,
**Then** they return to the dashboard with their previous filter / period selections preserved (URL-based state).

### Story 5.4: Admin flags a contract for staff follow-up

As an Admin / Owner,
I want to flag a specific contract for staff follow-up with a short comment,
So that I can route attention to Maria without making a phone call (FR44, Journey 4 climax).

**Acceptance Criteria:**

**Given** an Admin on a contract detail page,
**When** they click "Flag for follow-up,"
**Then** a Popover opens with a single short-comment field and a "Submit" button.

**Given** they submit a comment,
**When** the mutation runs,
**Then** a `flaggedContract` record is created with the comment + flagging Admin + timestamp; the assigned staff member (default: all Office Staff) sees the flag in their queue.

**Given** Office Staff opens their dashboard,
**When** they have unaddressed flagged contracts,
**Then** they see a "Flagged for me" tile with a count and the most recent flag's comment.

**Given** Office Staff clicks the flag entry,
**When** they navigate to the contract,
**Then** the flag is marked "viewed" but remains active until explicitly resolved by either Admin or Staff.

### Story 5.5: Daily reconciliation invariant scheduled function

As a developer / compliance officer,
I want a daily scheduled function that checks the reconciliation invariant (sum of payments against contract = contract balance reduction),
So that any drift between payments and balances surfaces immediately (FR60, NFR-R4).

**Acceptance Criteria:**

**Given** a Convex scheduled function `checkReconciliationInvariant` is registered,
**When** it runs daily at 03:00 Manila time,
**Then** for every active contract, it sums all non-voided payments and compares against (original contract amount - current balance); any mismatch is recorded in a `reconciliationFailures` table with contract ID + actual vs expected.

**Given** any reconciliation failure exists,
**When** the dashboard renders,
**Then** the Admin dashboard shows a banner "Reconciliation failures — N contracts need investigation" with a link to the failures detail.

**Given** the invariant passes for all contracts,
**When** the dashboard renders,
**Then** a small "System health: all contracts reconciled" indicator shows the timestamp of the last successful run.

**Given** the Vitest test suite includes a deliberate-divergence test,
**When** the test runs,
**Then** the invariant correctly detects the manufactured mismatch and surfaces it as a failure.

### Story 5.6: Daily database backups verified

As a developer / compliance officer,
I want to verify that Convex's managed backups produce a daily snapshot with ≥ 30-day retention,
So that NFR-R2 is satisfied and a quarterly restore drill can be conducted (FR61, NFR-R2).

**Acceptance Criteria:**

**Given** the cemetery's Convex deployment is configured for daily backups (verified in Convex dashboard config),
**When** an Admin or developer inspects the Convex backup retention setting,
**Then** retention is set to ≥ 30 operational days.

**Given** an ADR is written (`docs/adr/0008-backups-retention.md`),
**When** a reviewer opens it,
**Then** the ADR documents: daily backup schedule, retention period, quarterly restore-drill procedure, and the procedure for restoring to a scratch environment.

**Given** the runbook (`docs/runbook.md`) includes a "Restore from backup" section,
**When** a quarterly drill is performed,
**Then** the drill exercises the documented procedure and records the result.

### Story 5.7: Monthly archival export for BIR 10-year retention

As a developer / compliance officer,
I want a monthly scheduled action to export receipts + payments + customers to compressed JSON in Convex File Storage and to an S3-compatible bucket the cemetery controls,
So that BIR's 10-year archival requirement is met independent of Convex's operational backups (FR62, NFR-R3).

**Acceptance Criteria:**

**Given** a Convex scheduled action `monthlyArchivalExport` is registered,
**When** it runs on the 1st of each month at 04:00 Manila time,
**Then** it: (a) queries all receipts, payments, and customers from the previous month, (b) serializes to compressed (gzip) JSON, (c) writes the file to Convex File Storage with a deterministic filename like `archives/2026-04.json.gz`, (d) optionally mirrors to a configured S3 bucket (if `ARCHIVE_S3_BUCKET` env var is set).

**Given** the archive file is created,
**When** an Admin downloads it,
**Then** the JSON is human-readable, the file is < 100MB for a typical month's volume, and it includes all receipts with their full BIR-required fields.

**Given** the S3 mirror is configured,
**When** the export completes,
**Then** the S3 upload succeeds with a verified ETag matching the local file's hash; on failure, the next-day retry attempts re-upload.

**Given** the archive output is retained,
**When** 10 years pass,
**Then** all monthly archives remain accessible per the configured retention policy (S3 lifecycle rule on the bucket).

### Story 5.8: Performance budget gates in CI

As a developer / UX implementer,
I want Lighthouse and bundle-size checks to fail the build if NFR thresholds are breached,
So that performance regressions are caught at PR time (UX-DR33, UX-DR34).

**Acceptance Criteria:**

**Given** the CI pipeline includes a Lighthouse mobile run on emulated 4G,
**When** any PR's Lighthouse run produces an LCP > 4s or INP p75 > 200ms or bundle JS > 250KB gzipped,
**Then** the build fails with a clear message identifying which metric breached and by how much.

**Given** the bundle analyzer runs against the production build,
**When** any route's initial JS bundle exceeds 250KB gzipped,
**Then** the build fails with the bundle composition shown.

**Given** axe-core scans run via Playwright on the key pages,
**When** any "critical" or "serious" accessibility violation is detected,
**Then** the build fails with the violation details.

### Story 5.9: Cross-cutting StatePillTransition application

As a developer / UX implementer,
I want the `StatusPill` component's built-in 300ms color crossfade to apply across all entity state displays (contracts, lots, receipts, installments),
So that state changes always animate consistently per UX-DR13 + UX-DR26.

**Acceptance Criteria:**

**Given** any `StatusPill` is rendered with a `status` prop,
**When** the underlying status changes (via reactive query update or local prop change),
**Then** the pill's background and text color cross-fade over 300ms; `prefers-reduced-motion` disables the animation.

**Given** a Vitest test for the StatusPill,
**When** the test simulates a status prop change and waits 300ms,
**Then** the pill's classes have transitioned to the new state's color palette without flicker.

**Given** the StatusPill is rendered on every page where entity state matters (lot detail, contract detail, AR aging table, dashboard tiles, search results),
**When** state changes happen anywhere in the system,
**Then** all consumer surfaces of that entity reflect the transition consistently.

## Epic 6: Document Generation, Reporting & Audit View [P2]

PDF contract documents, demand letters, custom reports with filters, exports, audit log read UI, expense approval workflow.

### Story 6.1: Office Staff generates an installment contract as PDF

As Office Staff,
I want to generate an installment contract as a PDF document with cemetery letterhead and full terms,
So that customers receive a formal contract they can sign and retain (FR49).

**Acceptance Criteria:**

**Given** Office Staff on a contract detail page,
**When** they click "Generate contract PDF,"
**Then** a Convex action invokes PDFKit to produce a multi-page PDF containing: cemetery letterhead, customer + lot details, full installment schedule, grace + penalty terms, signature placeholders for both parties.

**Given** the PDF is generated,
**When** it is stored,
**Then** the file is in Convex File Storage with auth-gated URL, the contract record references the PDF blob ID, and Office Staff can download / email / print it via the same UI pattern as receipts.

**Given** the contract terms change (rare — e.g. via amendment),
**When** Office Staff regenerates the PDF,
**Then** a new version is created (`v2`, `v3`...) preserving the original; the contract detail page shows version history.

### Story 6.2: Office Staff generates a demand letter for an overdue contract

As Office Staff,
I want to generate a demand letter as a PDF for an overdue contract,
So that I can send formal collection notices through legal channels (FR50).

**Acceptance Criteria:**

**Given** Office Staff on an overdue contract detail page,
**When** they click "Generate demand letter,"
**Then** a Convex action produces a PDF with: cemetery letterhead, customer name + address, contract reference, overdue amount + aging, demand-for-payment language (configurable template), signature line for cemetery officer.

**Given** the demand letter is generated,
**When** stored,
**Then** the file is in Convex File Storage, the contract record references it as an attachment with type "demand_letter," and Office Staff can re-generate (creates v2) if terms change.

**Given** the contract is not overdue,
**When** Office Staff attempts to generate a demand letter,
**Then** the action is blocked with: "Demand letter is only available for overdue contracts."

### Story 6.3: Admin views custom sales reports

As an Admin / Owner,
I want to view reports breaking down sales by lot type, section, and (if enabled) sales agent,
So that I can understand revenue distribution beyond top-line totals (FR45 — agent breakdown gated on §10 Q5).

**Acceptance Criteria:**

**Given** an Admin on `/reports/sales`,
**When** they select a date range and click "Run,"
**Then** the report shows total sales count + amount grouped by lot type, then by section, then (if agent tracking is enabled) by sales agent.

**Given** agent tracking is disabled (§10 Q5 unanswered or "no commission tracking"),
**When** the report renders,
**Then** the agent breakdown section is hidden; lot type + section breakdowns work normally.

**Given** the report renders,
**When** the user clicks any row,
**Then** they drill down to the underlying sales list filtered to that group.

### Story 6.4: Admin exports reports to Excel / PDF

As an Admin / Owner,
I want to export any report to Excel or PDF for a configurable date range,
So that I can share reports with the accountant or store them outside the system (FR46).

**Acceptance Criteria:**

**Given** an Admin on any report page,
**When** they click "Export → Excel,"
**Then** a Convex action generates an XLSX file with the report's data plus a header row including report title + date range + generated-by + generated-at, and triggers a download.

**Given** they click "Export → PDF,"
**When** the PDF action runs,
**Then** a print-formatted PDF is generated with the same header info plus page numbers.

**Given** the report contains 10,000+ rows,
**When** the export runs,
**Then** it streams to the file without blocking the UI for more than 5 seconds; the user sees a progress indicator.

### Story 6.5: Admin views the audit log

As an Admin / compliance officer,
I want to view the full audit log of financial mutations filterable by actor, entity, and date range,
So that I can answer any "who changed what, when, and why" question (FR47).

**Acceptance Criteria:**

**Given** an Admin on `/admin/audit`,
**When** they apply filters (actor / entityType / dateRange),
**Then** the audit-log table shows matching entries with: timestamp (Manila tz), actor name, action, entity reference, before/after summary (PII redacted to last-4), reason (if state transition).

**Given** the user clicks an audit entry,
**When** the detail panel opens,
**Then** the full before/after JSON is shown (with PII still redacted unless the Admin explicitly clicks "Reveal PII" — which logs the PII access).

**Given** the audit log has tens of thousands of entries,
**When** filters return many results,
**Then** the page paginates 50 entries per page with cursor-based pagination, sorted by timestamp descending.

### Story 6.6: Admin configures expense approval workflow

As an Admin,
I want to configure whether expenses require approval before posting,
So that controls match the cemetery's actual operating practice (FR41 — gated on §10 Q9).

**Acceptance Criteria:**

**Given** an Admin on `/admin/settings`,
**When** they toggle "Expenses require approval" to ON,
**Then** new expenses entered by Office Staff are saved with `approvalStatus: "pending"` and don't affect dashboard expense totals until an Admin approves them.

**Given** the toggle is ON and Office Staff submits an expense,
**When** the submission completes,
**Then** the expense appears in `/admin/expenses-pending` queue; an Admin can approve or reject with optional reason.

**Given** the toggle is OFF (default),
**When** Office Staff submits an expense,
**Then** the expense is posted directly to the dashboard (current Phase 1 behavior).

**Given** §10 Q9 is unanswered,
**When** the toggle is configured,
**Then** the toggle defaults to OFF with a banner: "Approval workflow pending client confirmation (§10 Q9)."

### Story 6.7: Admin sees expense approval queue

As an Admin,
I want to see a queue of expenses awaiting approval,
So that I can review and approve them in bulk during my standard review cadence (FR41).

**Acceptance Criteria:**

**Given** the approval workflow is enabled and pending expenses exist,
**When** an Admin navigates to `/admin/expenses-pending`,
**Then** they see a list with date / vendor / amount / category / submitter / receipt-photo preview; bulk-approve checkbox available.

**Given** the Admin selects one or more entries and clicks "Approve,"
**When** the mutation runs,
**Then** each expense's `approvalStatus` becomes "approved," approval is audit-logged, and the dashboard expense total reactively updates.

**Given** they click "Reject" on an entry,
**When** the rejection dialog opens,
**Then** a reason is required; on submit, the expense is marked "rejected" with the reason; the submitter sees the rejection in their own activity view.

## Epic 7: Interment Scheduling [P2]

Calendar with double-booking prevention, scheduling against lots/occupants, field-worker completion, calendar view.

### Story 7.1: Office Staff schedules an interment

As Office Staff,
I want to schedule an interment against a lot and an occupant record on a specific date and time,
So that the cemetery's interment calendar replaces the phone-and-paper coordination (FR51).

**Acceptance Criteria:**

**Given** `convex/schema.ts` defines an `interments` table with `lotId`, `occupantId`, `scheduledAt`, `status: "scheduled" | "completed" | "cancelled"`,
**When** Office Staff on a lot detail page clicks "Schedule interment,"
**Then** a form opens with: occupant selector (from this lot's occupants or create-new-inline), date + time picker, notes.

**Given** Office Staff submits,
**When** the mutation runs,
**Then** the interment is created in `scheduled` state with the scheduled date/time; `emitAudit` records the action; the lot detail page shows the upcoming interment.

### Story 7.2: System prevents double-booking

As Office Staff,
I want the system to prevent scheduling an interment that conflicts with an existing one (same lot OR same time slot),
So that scheduling errors are caught before they become operational problems (FR52).

**Acceptance Criteria:**

**Given** an interment already exists at lot L on date D at time T,
**When** Office Staff attempts to schedule another interment at lot L at the same date/time,
**Then** the mutation rejects with `ConvexError({ code: "LOT_ALREADY_SCHEDULED" })` and the UI shows the conflict.

**Given** an interment exists at any lot at date D at time T,
**When** Office Staff attempts to schedule another at a different lot but same date/time,
**Then** the mutation rejects with `ConvexError({ code: "TIMESLOT_ALREADY_BOOKED" })` because the cemetery has limited interment staff.

**Given** the conflict is detected,
**When** the UI displays the error,
**Then** it includes the conflicting interment's details and a "View existing" link.

### Story 7.3: Office Staff views the interment calendar

As Office Staff / Admin,
I want to view a calendar of scheduled interments filterable by section, date range, and status,
So that I can see what's coming up at a glance (FR54).

**Acceptance Criteria:**

**Given** an authenticated user on `/interments`,
**When** the calendar renders,
**Then** scheduled interments appear as events on a month/week/day view (toggle); each event shows occupant name + lot code + time.

**Given** the user filters by section,
**When** the filter applies,
**Then** only interments at lots in matching sections are shown.

**Given** the calendar reactively updates,
**When** another user schedules or completes an interment,
**Then** the calendar updates within 1 second with a 600ms amber flash on the changed event.

### Story 7.4: Field Worker marks an interment complete

As Junior (Field Worker),
I want to mark an interment as complete with timestamp and optional notes,
So that office staff sees the completion in real time and field-completion is tracked (FR53).

**Acceptance Criteria:**

**Given** Junior on his phone navigates to today's interments,
**When** he taps an interment that's scheduled for today,
**Then** he sees the interment detail with "Mark complete" button (visible only if `status === "scheduled"` and the user has Field Worker role).

**Given** Junior taps "Mark complete,"
**When** a Sheet opens,
**Then** the form shows: timestamp (auto-now), optional notes, optional photo.

**Given** Junior submits,
**When** the mutation runs,
**Then** the interment's status becomes `completed`, the lot transitions to `occupied` (via state machine, if not already), audit is recorded, and Maria's calendar reactively shows the completion.

## Epic 8: GPS Map Migration [P2]

GPS survey of lots + Leaflet renderer + turn-by-turn navigation.

### Story 8.1: System imports GPS-surveyed lot geometry

As a developer / GIS surveyor,
I want to import GPS-surveyed lot geometry (centroid + polygon) into the existing `lots.geometry` fields,
So that the schema is populated with real coordinates without changing the data model (FR9, prep for FR10 Phase 2).

**Acceptance Criteria:**

**Given** the GPS surveyor delivers a CSV / GeoJSON file with lot code + centroid + polygon vertices,
**When** a developer runs a one-time import script via `npx convex run import:lotGeometry`,
**Then** each matching lot's `geometry` fields are updated (centroid, polygon, bbox fields recomputed) and `geometryStatus` is set to `"surveyed"`.

**Given** some lot codes in the survey don't match any lot in the database,
**When** the import runs,
**Then** the unmatched lots are listed in the import report; the import succeeds for matched lots and the unmatched ones remain at `geometryStatus: "placeholder"`.

**Given** the geometry import is complete,
**When** the Phase 1 SVG renderer is still active,
**Then** it continues to render correctly using the new geometry (or falling back to the SVG overlay coordinates if developer prefers); no user-visible change yet.

### Story 8.2: Phase 2 Leaflet renderer

As an authenticated user (especially field workers),
I want the `LotMap` component to render via Leaflet + OpenStreetMap tiles instead of SVG,
So that I see real geographic context (roads, satellite imagery, GPS overlays) (FR10 Phase 2).

**Acceptance Criteria:**

**Given** `<LotMap renderer="leaflet" />` is rendered,
**When** Leaflet loads (lazy-loaded via `next/dynamic`),
**Then** the map shows OpenStreetMap tiles, lot polygons rendered on the map, status-coded fills using the same color palette as the SVG renderer.

**Given** the user pans or zooms the Leaflet map,
**When** the viewport changes,
**Then** the bbox query refetches lots within the new viewport (debounced 200ms); only viewport lots are fetched (NFR-P2 stays under 3s for 2,000+ inventory).

**Given** the SVG renderer is still in use by default,
**When** a feature flag or admin setting flips to `"leaflet"`,
**Then** the LotMap component re-renders with Leaflet without other code changes (component swap pattern from architecture).

**Given** Leaflet is loaded only on pages that need the map,
**When** the bundle analyzer runs,
**Then** the initial JS bundle remains under 250KB gzipped (NFR-P6); Leaflet adds < 100KB only to lot pages.

### Story 8.3: Field Worker navigates to a lot via GPS

As Junior (Field Worker),
I want to tap "Navigate to lot" and have my phone's GPS guide me there,
So that I find the physical lot in under 30 seconds even if I don't know the section (FR12).

**Acceptance Criteria:**

**Given** Junior on a lot detail page on phone (Phase 2),
**When** he taps "Navigate to lot,"
**Then** the action constructs a geographic URI with the lot's centroid coordinates (e.g. `geo:14.5995,120.9842?q=14.5995,120.9842(D-5-12)` for Android, `maps://?daddr=14.5995,120.9842` for iOS) and triggers the device's native map / nav app.

**Given** the phone doesn't have a default nav app,
**When** Junior taps the button,
**Then** he sees a fallback: a static map with the lot pin visible and the centroid coordinates displayed for manual entry.

**Given** the lot's `geometryStatus` is `"placeholder"` (not yet surveyed),
**When** Junior tries to navigate,
**Then** the button is disabled with the tooltip: "GPS coordinates not yet surveyed for this lot."

## Epic 9: Customer Self-Service Portal [P3]

Customer authentication, self-service portal, online payments, reminders, trend analysis.

### Story 9.1: Customer authenticates to the portal

As a Customer (or family member of a customer),
I want to authenticate to the customer portal using credentials linked to my contracts,
So that I can view my contract and pay online (FR5).

**Acceptance Criteria:**

**Given** the architectural re-evaluation point at Phase 3 kickoff has determined the auth approach (Convex Auth + Twilio SMS-OTP OR Better Auth — decision made in ADR-009),
**When** a customer visits `/login` on the customer-portal route group,
**Then** they can authenticate via email + password or SMS-OTP (depending on chosen approach).

**Given** the customer has no existing portal account but has a contract,
**When** Office Staff sends them a portal-invite email,
**Then** the email contains a one-time link that lets the customer set their portal password.

**Given** the customer authenticates,
**When** they are redirected to the portal,
**Then** the `(customer)/` route group loads with their own contracts visible — `requireRole` blocks access to any staff-only data.

### Story 9.2: Customer views own contracts and balances

As a Customer,
I want to view all of my contracts with current balances and remaining installments,
So that I always know where I stand without calling the office (FR55).

**Acceptance Criteria:**

**Given** an authenticated Customer on the portal,
**When** they navigate to the dashboard,
**Then** they see a list of their active contracts with: contract ID, lot reference, current balance, next due date, remaining installment count.

**Given** they tap a contract,
**When** the detail page renders,
**Then** they see the full schedule preview (read-only mode of SchedulePreview), payment history, and a "Pay now" button.

**Given** the customer's contract status changes (a payment posts on Maria's side),
**When** they refresh / reactively update,
**Then** the balance and next-due-date update accordingly.

### Story 9.3: Customer downloads receipt PDFs

As a Customer,
I want to download a PDF receipt for any past payment,
So that I can archive my records (FR56).

**Acceptance Criteria:**

**Given** a Customer on a contract detail page,
**When** they tap any past payment row,
**Then** a "Download receipt" link opens the PDF via a short-lived signed URL (auth-checked).

**Given** the customer is not on a contract that lists this payment,
**When** they attempt to access the receipt URL directly,
**Then** Convex returns 403 (PII protection — receipt URLs are auth-gated).

### Story 9.4: Customer updates own contact info

As a Customer,
I want to update my own contact information (excluding name and gov-ID number),
So that the cemetery has my latest phone and address without me calling them (FR58).

**Acceptance Criteria:**

**Given** a Customer on their profile page,
**When** they edit phone / email / address fields and submit,
**Then** the mutation runs (with `requireRole("customer")` + ownership check), the customer record is updated, and `emitAudit` records the change.

**Given** they attempt to edit `name` or `govIdNumber`,
**When** the fields render,
**Then** they are read-only with a note: "Contact the cemetery office to update these fields."

**Given** the customer enters an invalid email or phone,
**When** they submit,
**Then** inline validation blocks the submission with a clear error.

### Story 9.5: Customer pays via GCash

As a Customer,
I want to pay an outstanding installment via GCash,
So that I can settle my account from my phone without visiting the office (FR33 — GCash portion).

**Acceptance Criteria:**

**Given** the cemetery has onboarded a GCash merchant account (paperwork-heavy client-side activity completed 4–6 weeks pre-integration),
**When** the Convex env vars include GCash API credentials,
**Then** the Convex HTTP endpoint `convex/http.ts` registers a webhook handler at `/api/gcash-webhook`.

**Given** a Customer on the "Pay now" screen selects GCash,
**When** they enter an amount and submit,
**Then** the system creates a GCash payment intent (server-side), redirects the customer to GCash's payment page, and stores the pending payment with the GCash transaction ID as idempotency key.

**Given** GCash redirects back to the portal after payment,
**When** the gateway webhook arrives at `/api/gcash-webhook`,
**Then** the webhook handler validates the GCash signature, checks idempotency, invokes `postFinancialEvent` (Story 3.2) to atomically post the payment + receipt, and acknowledges within 5 seconds (NFR-I2).

**Given** the payment fails or times out,
**When** the user returns to the portal,
**Then** the contract page reflects the actual state (paid if webhook arrived; pending if still in flight; failed if GCash returned a failure).

### Story 9.6: Customer pays via Maya / card

As a Customer,
I want to pay an outstanding installment via Maya or credit/debit card,
So that I have payment options beyond GCash (FR33 — Maya + card portion).

**Acceptance Criteria:**

**Given** the cemetery has onboarded Maya and a card-processor merchant account,
**When** the Convex env vars include their API credentials,
**Then** Maya and card webhook handlers are registered alongside GCash in `convex/http.ts`.

**Given** a Customer on the "Pay now" screen selects Maya or card,
**When** they complete the gateway-redirect flow,
**Then** the webhook returns to a generic handler that detects gateway + validates signature + posts via `postFinancialEvent` per the same pattern as GCash.

**Given** a webhook from any gateway is delivered twice,
**When** both deliveries are processed,
**Then** idempotency-key dedup ensures only one payment + receipt is posted (NFR-I1).

### Story 9.7: System sends SMS payment reminders

As an Admin / Customer,
I want the system to send automated SMS reminders to customers about upcoming installments,
So that customers stay current without manual nag from office staff (FR57 — SMS portion).

**Acceptance Criteria:**

**Given** an Admin has configured reminder cadence in `/admin/settings/reminders` (e.g. "send SMS 3 days before due date, again on due date, again 7 days after if not paid"),
**When** the scheduled reminder function runs daily,
**Then** for each matching reminder condition, it dispatches an SMS via the configured provider with a templated message + portal link.

**Given** an SMS send fails,
**When** the action retries,
**Then** it retries up to 3 times over 24 hours (NFR-I3); on final failure, the admin sees an alert.

**Given** the customer has opted out of reminders,
**When** the scheduler evaluates them,
**Then** no SMS is dispatched.

### Story 9.8: System sends email reminders

As an Admin / Customer,
I want the system to send automated email reminders as an alternative or supplement to SMS,
So that customers without active phone service still receive reminders (FR57 — email portion).

**Acceptance Criteria:**

**Given** the reminder cadence config supports email,
**When** the scheduler runs,
**Then** email reminders are dispatched alongside (or instead of) SMS per customer preference.

**Given** the email send fails,
**When** the action retries,
**Then** the retry behavior matches the SMS pattern (3 attempts over 24 hours).

**Given** the customer's email is invalid or bounces,
**When** the bounce is detected,
**Then** the customer record is flagged for staff attention; further email reminders to this address are paused until updated.

### Story 9.9: Admin views trend analysis

As an Admin / Owner,
I want trend analysis of sales, collections, and AR balance over user-selected time periods,
So that I can see the business's trajectory over months/years (FR48).

**Acceptance Criteria:**

**Given** an Admin on `/reports/trends`,
**When** they select a time period (last 30/90/365 days, or custom range) and metrics (sales, collections, AR, expenses, net),
**Then** the page renders line/bar charts showing the selected metrics over time with appropriate aggregation (daily / weekly / monthly).

**Given** the chart renders,
**When** the user hovers/taps a data point,
**Then** a tooltip shows the exact value and date with optional drill-down link.

**Given** charts use color for series differentiation,
**When** rendered,
**Then** chart elements use distinct shapes/textures alongside colors so colorblind users can distinguish series (NFR-A2 applied to charts).
