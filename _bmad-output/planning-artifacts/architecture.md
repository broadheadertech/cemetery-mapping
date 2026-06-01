---
stepsCompleted: ['step-01-init', 'step-02-context', 'step-03-starter', 'step-04-decisions', 'step-05-patterns', 'step-06-structure', 'step-07-validation', 'step-08-complete']
lastStep: 8
status: 'complete'
completedAt: '2026-05-17'
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - cemetery-management-system-brief (1).md
workflowType: 'architecture'
project_name: 'cemetery-mapping'
user_name: 'theundead'
date: '2026-05-17'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Project Context Analysis

### Requirements Overview

**Functional Requirements:** 65 FRs across 12 capability areas. Phase distribution: **47 Phase 1**, **13 Phase 2**, **5 Phase 3**. The Phase 1 footprint is broad — auth, lot inventory, geospatial schema, customer records, ownership history, full sales + installment contract engine, payment intake with BIR receipts, AR aging, expense tracking, KPI dashboard, audit log, daily reconciliation. Most architectural complexity lands in Phase 1; Phase 2 / 3 are mostly additions on top of the same shape (PDF infrastructure reused, gateway adapters added).

**Architecturally significant FR clusters:**

- **Atomic financial mutations (FR32, FR59):** every payment writes payment + contract update + receipt + audit log in one transaction. Single most consequential architectural invariant.
- **Receipt serial integrity (FR28, FR29, NFR-C1):** sequential BIR serials with no gaps, voids consume the serial. Forces a serial-counter pattern with optimistic concurrency.
- **Time-versioned ownership (FR16, FR17):** history is a first-class data-model concern, not a side audit.
- **State machines (FR23 contract states, lot states from Domain Patterns):** explicit transitions with logged reasons. Convex has no built-in state-machine guard — enforced in mutation code.
- **Append-only audit log (NFR-S7):** no updates / deletes ever; mutation pattern, not a DB feature.
- **Geospatial viewport queries (FR9, FR10, NFR-P2):** every lot carries `lat/lng centroid + polygon vertices` from day one; bounding-box index required for 2,000+ lot viewport queries on mobile / 4G.
- **Read-path PWA cache (FR11, NFR-R6):** field-worker offline read works after first load; no offline writes (intentional to protect financial-integrity invariants).

**Non-Functional Requirements:** 37 NFRs across 7 categories (P / S / R / A / I / C / M).

**Architecturally driving NFRs:**

- **NFR-P2 / NFR-P4:** Map render < 3s on mid-range Android / 4G with 2,000+ lots; Convex query p95 < 300ms. → viewport-based fetch (not "load all lots") and indexed queries only.
- **NFR-S2 / NFR-S3:** PII encrypted at rest; file URLs RBAC-gated, not public-by-default.
- **NFR-S4:** RBAC enforced on every mutation / query at the server — code-organization concern.
- **NFR-S7:** Audit log append-only at DB level — enforced via mutation pattern (no updates ever issued).
- **NFR-R5:** Idempotent payment posting with client-supplied idempotency keys.
- **NFR-C1 / NFR-C2:** Receipt serial uniqueness + immutability — enforced by data model + mutation pattern.
- **NFR-I1 / NFR-I2 (Phase 3):** Webhook idempotency + 5-second ack budget — long work deferred to scheduled actions.
- **NFR-M2:** ≥ 90% line coverage on financial-touching server functions — testing strategy, not just a metric.

### Scale & Complexity

Project complexity: **medium**, with several discrete pockets of "high" pulled in by financial integrity and BIR compliance — not by scale.

| Indicator | Value |
|---|---|
| Primary domain | Full-stack web app (Next.js + Convex), responsive, PWA-capable |
| User scale | ~10–20 named staff (Phase 1) + potentially hundreds–low-thousands of customer-portal users (Phase 3). Not a scale-out problem. |
| Data scale | ~2,000 lots, ~2,000 contracts (steady state), ~50,000+ payments over 10 years (BIR retention). Not big-data scale. |
| Transaction volume | Modest. Human-typing-speed: sales (~10/day), payments (~50/day at peak). Burst pattern: month-end / holidays. |
| Real-time | Yes — reactive cross-role sync is the product's central differentiator. |
| Multi-tenancy | No — single cemetery, single client. |
| Regulatory compliance | Yes — BIR (Philippines tax) + RA 10173 (Data Privacy Act). Both shape data model and mutation patterns. |
| Integration complexity | Phase 1: zero external integrations. Phase 3: payment gateways + SMS / email. |
| User interaction complexity | High for office-staff transactional flows (sale, payment, customer creation); medium for field worker (search + read + small writes); low for customer portal. |
| Geospatial complexity | Light — 2,000 lots, viewport queries, bounding-box indexes. No PostGIS-class operations. |
| Estimated architectural components | ~12–15 Convex domains + ~6–8 Next.js route groups |

### Technical Constraints & Dependencies

**Locked stack** (PRD § Project Classification + Web App Requirements): Next.js App Router + TypeScript strict; Convex (backend + DB + auth + file storage + scheduled jobs); Tailwind CSS (no runtime CSS-in-JS); Leaflet + OSM / Mapbox (Phase 2 map renderer); Vercel hosting.

**Implications of the locked stack:**

- **No SQL / no PostGIS** — all queries are Convex TypeScript functions; spatial queries are bounding-box-on-indexed-fields, not real GIS.
- **No separate API layer** — React talks to Convex directly. No REST / GraphQL gateway, no ORM.
- **Atomicity guarantee** — Convex mutations are atomic and serializable per document. Multi-document atomicity comes for free *within* a single mutation but requires careful design when crossing document boundaries.
- **Reactive queries are the default** — opting out (caching, pre-aggregation) is the deliberate choice, not opting in.
- **TypeScript end-to-end** — schema → queries → React hooks. Type-safety is a primary stack-selection rationale (NFR-M1).

**Open architectural decisions inside the locked stack:**

- Auth: **Convex Auth vs. Clerk-on-Convex.** PRD §7.2 explicitly defers this to the architect.
- Map renderer (Phase 1): SVG overlay vs. static image. Both schema-compatible with the Phase 2 Leaflet swap.
- PDF library: server-side in Convex actions. Options: `pdf-lib`, `pdfkit`, `puppeteer-core`. Trade-offs around BIR template fidelity vs. bundle / cost.
- BIR receipt issuance modality: depends on brief §10 Q3 (CAS / accredited POS / manual). Architect must design for the answer; until then, design assumes CAS path (most demanding) so other answers narrow scope rather than expand it.
- State-machine implementation: explicit transition tables vs. inline switch logic in mutations.
- Reporting strategy: live aggregation queries vs. pre-aggregated summary documents (updated-on-write).

**Hard external dependencies:**

- **None in Phase 1** (per PRD Domain Requirements > Integration). System functions correctly with only Convex.
- **Phase 2:** optional map-tile provider (OSM free, attribution-only; Mapbox paid).
- **Phase 3:** payment gateways (GCash, Maya, card), SMS / email provider.

### Cross-Cutting Concerns

These touch most / all architectural components and need consistent patterns across the codebase:

1. **Atomic financial mutations.** Payment + contract update + receipt + audit log in one Convex mutation. Receipt-serial allocation is the hardest sub-problem (single-row optimistic-locked counter).
2. **Server-side RBAC enforcement.** Every mutation and query begins with a `requireRole(ctx, [allowed])` helper. UI-layer authorization is not enough (NFR-S4).
3. **Audit log emission.** Every financial-touching mutation calls a shared audit-emit helper that records actor + timestamp + before / after. Never inline; never optional.
4. **State-machine guards.** Contracts and lots have explicit transition tables; mutations check legal transitions before applying changes and emit logged reasons.
5. **Time-versioned relations.** Ownership and occupancy are not single fields on `lots`; they are separate documents with effective-date ranges and a "current" query helper.
6. **Reactive query subscriptions.** Default pattern. Pre-aggregated summary docs for heavy reports only (dashboard MTD / YTD, AR-aging snapshot). Updated atomically with the underlying mutation.
7. **PWA offline read.** Service worker config (production only per NFR-M); cache versioning tied to Convex deploy ID; stale-after-24h indicator surfaced in UI.
8. **Scheduled functions.** Daily reconciliation invariant (FR60), daily AR aging recompute (FR34), follow-up-action expiry re-flag (FR36), archival exports (FR62), Phase 3 reminder dispatch (FR57).
9. **PII handling.** Encrypted at rest (NFR-S2), file URLs RBAC-gated (NFR-S3), access-logged (NFR-S8), breach-impact query supported (NFR-C4).
10. **Idempotency.** Payment posting (NFR-R5) and Phase 3 webhooks (NFR-I1) both rely on idempotency keys with deduplication windows.
11. **Bounding-box geospatial indexing.** Every viewport-driven query uses indexed lat-min / lat-max / lng-min / lng-max fields, not full-table scans.
12. **Configuration-driven receipt template.** BIR format lives in config (NFR-C / brief §10 Q3 risk mitigation); changeable without a deploy.

## Starter Template Evaluation

### Primary Technology Domain

Full-stack web application: Next.js (App Router, TypeScript) frontend + Convex backend. Stack is already locked by PRD § Web Application Requirements; the starter decision lives inside those constraints.

### Starter Options Considered

| Option | What it gives you | Why it's wrong for this project |
|---|---|---|
| **`create-next-app` + `npm install convex`** | Convex's own official quickstart. Minimum imposed decisions. Standard `create-next-app` skeleton + Convex SDK on top. | **Right choice — see below.** |
| `npx create-convex@latest -t get-convex/v1` | Convex v1 starter — Convex + Next.js + Clerk auth + Tailwind + shadcn/ui pre-wired. | Forces Clerk before the auth decision is made (PRD §7.2 explicitly defers Convex-Auth-vs-Clerk to the architect). Would re-litigate that decision later. |
| `npx create-convex@latest -t get-convex/ents-saas-starter` | Convex Ents (ORM-ish layer) + Clerk + shadcn/ui + SaaS scaffolding (orgs, billing, tenants). | Wrong shape — single-cemetery non-tenanted product. SaaS scaffolding is dead code. Convex Ents is also a non-trivial additional dependency to onboard. |
| Community starters (Better Auth, edge-first, etc.) | Various opinionated stacks with extra goodies (Better Auth, Cloudflare Workers, agentic-workflow tooling). | Unverified maintenance, opinionated patterns that don't match the PRD's stack lock, edge-runtime adds complexity we don't need. "Boring technology for stability" rules these out. |

### Selected Starter: `create-next-app` + `convex` package

**Rationale for selection:**

1. **Doesn't foreclose the auth decision.** PRD §7.2 explicitly leaves "Convex Auth vs. Clerk-on-Convex" to the architect. A starter that bundles Clerk would commit us before the comparison happens (Step 4+).
2. **Single-cemetery, not SaaS.** No tenant / org tables, no billing, no team management. SaaS starters carry significant scaffolding that becomes dead code or, worse, actively misleads new contributors.
3. **Boring technology for stability.** Two well-maintained official tools combined per their own official guide. Lowest possible risk of starter-introduced surprises.
4. **Freelance build with single-engineer dependency** (PRD Resource Risks #4). Every starter-imposed pattern is something a future maintainer needs to learn. Minimum starter = minimum future learning surface.
5. **Convex's official Next.js quickstart uses this exact path.** Plain `create-next-app` → install Convex → `npx convex dev`. Matches what their own docs teach.

**Initialization Command:**

```bash
# 1. Create the Next.js app — TypeScript, Tailwind, ESLint, App Router, src/ layout, npm
npx create-next-app@latest cemetery-mapping \
  --typescript \
  --tailwind \
  --eslint \
  --app \
  --src-dir \
  --use-npm \
  --import-alias "@/*"

cd cemetery-mapping

# 2. Add Convex as the backend / DB / auth / file-storage layer
npm install convex

# 3. Initialize the Convex dev deploy (prompts to log in, names the project,
#    writes CONVEX_URL to .env.local, creates the convex/ folder)
npx convex dev
```

### Architectural Decisions Provided by the Starter

**Language & Runtime:**

- TypeScript with `tsconfig.json` configured for Next.js App Router
- Node.js runtime for Next.js; Convex runs on its own managed runtime
- TypeScript **strict mode** to be enabled in the first commit (NFR-M1) — `create-next-app` defaults to strict; verify and tighten if not

**Styling Solution:**

- **Tailwind CSS** (whatever version `create-next-app@latest` ships — currently v4 in newer Next.js releases, v3 in older ones; pinned explicitly in the first commit). Zero-runtime CSS, JIT compilation, matches NFR-P6 bundle-size targets.
- No CSS-in-JS at runtime (PRD § Web App Requirements — Tailwind only).

**Build Tooling:**

- **Turbopack** for dev server (default in current Next.js)
- Standard `next build` for production (route-level code splitting by default)
- Vercel auto-detects everything; no custom build config needed for Phase 1

**Testing Framework:**

- Not provided by `create-next-app` — must be added in the first implementation story. Recommended (confirmed in Step 4):
  - **Vitest** for unit / integration tests on Convex functions (fast, ESM-native, plays well with Convex's testing utilities)
  - **Playwright** for end-to-end tests on the office-staff transactional flows
- NFR-M2 (≥ 90% coverage on financial-touching server functions) requires the test infrastructure to land in week 1.

**Code Organization:**

- `src/app/` — Next.js App Router routes
- `src/components/` — React components
- `src/lib/` — client-side helpers
- `convex/` — Convex schema, queries, mutations, actions, scheduled functions
- `convex/_generated/` — type-generated client API (committed; Convex regenerates)
- `@/*` import alias points to `src/*`

**Development Experience:**

- `npm run dev` — Next.js dev server with Turbopack hot reload
- `npx convex dev` (separate terminal) — Convex dev watch mode, regenerates types on schema change
- ESLint with Next.js rules
- VS Code TypeScript intellisense across Next.js + Convex (Convex client types flow into React hooks automatically)

### What the Starter Deliberately Does Not Provide

These need explicit decisions in Step 4 (Architectural Decisions):

- **Auth** — Convex Auth vs. Clerk-on-Convex (PRD-deferred)
- **Component library** — shadcn/ui, Radix primitives, or build from scratch (UX phase input ideal but architecture must propose)
- **Form library** — React Hook Form vs. native + minimal helper
- **Map renderer** — Phase 1 SVG / image vs. lightweight static-image approach
- **PDF library** — `pdf-lib` vs. `pdfkit` vs. headless-Chrome (for BIR receipts)
- **Testing libraries** — Vitest + Playwright as recommended, but confirm
- **Service worker / PWA** — Workbox-based via `next-pwa` vs. hand-rolled
- **Convex Auth helper packages** — depending on auth choice

**Note:** Project initialization using this command should be the first implementation story. ADR-001 should capture this starter choice and the rationale above.

## Core Architectural Decisions

### Decision Priority Analysis

**Critical Decisions (block implementation):** Auth provider, RBAC pattern, PDF library, time-versioned data modeling, financial-mutation pattern, receipt-serial allocation, state-machine guards, geospatial indexing.

**Important Decisions (shape architecture):** Component library, form library, error-handling pattern, monitoring stack, CI/CD pipeline, preview-deploy strategy, PWA service-worker approach.

**Deferred Decisions (post-Phase-1):** Reporting pre-aggregation strategy (decide once dashboard load patterns are real), tile-provider switch (OSM → Mapbox only if Phase 2 reveals coverage issues), customer-portal SMS auth (Phase 3 — re-evaluate Convex Auth vs. Better Auth then).

### Data Architecture

| Decision | Choice | Rationale | Affects |
|---|---|---|---|
| Database | **Convex managed database** | Stack lock; reactive queries + ACID per-mutation | All |
| Schema location | **`convex/schema.ts`** (canonical model) | Convex convention; type-generated client | All |
| Data modeling | **Document-centric with explicit reference tables** | No SQL → no joins; references resolved in queries | Lots, Customers, Contracts, etc. |
| **Time-versioned relations** | **Separate documents with `effective_from` / `effective_to`** (not embedded arrays, not event-sourcing) | Indexable on date ranges; cleaner queries; right tool for ownership / occupancy history (FR16, FR18) | Ownership history, Occupancy history |
| Data validation | **Convex `v.*` validators in schema, paired with TypeScript types** | Runtime + compile-time safety; runs on every mutation | All |
| Migration strategy | **Convex migration functions + staging table for legacy paper records** (load → validate → promote) | Two-stage migration isolates dirty legacy data from production schema; matches brief §9 30–40% effort estimate | Phase 1 data migration |
| Caching | **Convex's built-in reactive cache only** | No TanStack Query / SWR / Redux on top; the differentiator IS the reactive system | Frontend state mgmt |
| Pre-aggregation | **Reserved for Phase 1.5 if dashboard latency requires it** | Premature optimization; measure live aggregation first against NFR-P4 (Convex query p95 < 300ms) | Reporting (FR42, FR43) |

**Sample schema shape (illustrative, not final):**

```typescript
// convex/schema.ts (illustrative)
export default defineSchema({
  lots: defineTable({
    code: v.string(),                  // "D-5-12"
    section: v.string(),
    block: v.string(),
    row: v.string(),
    type: v.union(v.literal("single"), v.literal("family"), ...),
    dimensions: v.object({ widthM: v.number(), depthM: v.number() }),
    basePrice: v.number(),             // pesos in centavos
    status: v.union(v.literal("available"), v.literal("reserved"), ...),
    geometry: v.object({
      centroid: v.object({ lat: v.number(), lng: v.number() }),
      polygon: v.array(v.object({ lat: v.number(), lng: v.number() })),
      bboxMinLat: v.number(),          // indexed for viewport queries
      bboxMaxLat: v.number(),
      bboxMinLng: v.number(),
      bboxMaxLng: v.number(),
    }),
  })
    .index("by_status", ["status"])
    .index("by_section_block", ["section", "block"])
    .index("by_bbox_lat", ["bboxMinLat", "bboxMaxLat"]),

  ownerships: defineTable({
    lotId: v.id("lots"),
    customerId: v.id("customers"),
    effectiveFrom: v.number(),         // unix ms
    effectiveTo: v.optional(v.number()), // null = current
    transferType: v.union(v.literal("sale"), v.literal("inheritance"), ...),
    transferEventId: v.optional(v.id("transferEvents")),
  })
    .index("by_lot_effective", ["lotId", "effectiveFrom"])
    .index("by_customer", ["customerId"]),
  // ...
});
```

### Authentication & Security

| Decision | Choice | Rationale | Affects |
|---|---|---|---|
| **Auth provider (Phase 1, staff)** | **Convex Auth** (password + Google OAuth) | Single-stack, no extra cost, ~10–20 staff users — Convex Auth's password + OAuth coverage is sufficient. No MFA / SSO requirement in NFRs. | FR1–FR4 |
| **Auth provider (Phase 3, customers)** | **Re-evaluate at Phase 3 kickoff** — Convex Auth (with custom Twilio-via-action SMS-OTP) vs. Better Auth (`get-convex/better-auth`) for richer customer flows | Convex Auth lacks native SMS, which is the standard PH customer-portal flow. Decision deferred — premature now. | FR5 |
| RBAC pattern | **Shared `requireRole(ctx, [roles])` helper in `convex/lib/auth.ts`**; every query / mutation begins with the call | Centralizes the NFR-S4 guarantee. Linted: any query / mutation file missing `requireRole` call fails CI. | All mutations / queries |
| Route protection (frontend) | **Next.js middleware** for route-level redirect + **`useConvexAuth()`** for UI gating | Defense-in-depth; the Convex `requireRole` is the real gate, UI is just UX. | Route layouts |
| Session timeout | **8h office staff, 1h admin, 30d customer** (per NFR-S5) | Built into Convex Auth session config; admin shortened because role-escalation events warrant re-auth. | Auth config |
| Failed-auth rate limit | **5 failures / 15 min → 1-hour lockout** in custom `auth_attempts` table | NFR-S6. No Convex built-in rate limiter; implement as a tracking table cleared by scheduled function. | Auth flow |
| PII encryption | **Convex default at-rest encryption** (sufficient per NFR-S2 wording) | Convex encrypts all data at rest with managed keys outside the application code. Application-layer field-level encryption is overscope for the threat model (single-cemetery freelance build). | PII fields |
| File-storage access | **Convex File Storage with auth-gated URL generation per request** | NFR-S3. Generate short-lived signed URLs in queries that check role; never expose direct storage URLs. | ID scans, receipt photos |
| Audit-log append-only | **Mutation-pattern enforcement**: audit table has `insert` only, never `patch` / `replace` / `delete`; CI lint rule | NFR-S7. Convex has no DB-level append-only constraint; enforce in code + tests. | Audit log |
| PII access logging | **`pii_access_log` table written on every read of PII fields** (gov ID, ID scans) | NFR-S8. Supports the 72-hour breach-impact query (NFR-C4). | Customer queries |

### API & Communication Patterns

| Decision | Choice | Rationale | Affects |
|---|---|---|---|
| API style | **Convex queries / mutations / actions** (RPC-like, type-generated client) | Stack lock; no REST / GraphQL gateway. | All |
| Documentation | **TypeScript types from `_generated/api` + JSDoc on every public function**; no OpenAPI | Type-generated client IS the contract; JSDoc covers semantic intent. | All |
| Error handling | **`ConvexError` with discriminated `code` field for known errors**; uncaught throws are server errors. **Single translation layer in `src/lib/errors.ts`** converts codes to user messages. | Frontend never reads raw error strings — only code + payload. Allows i18n later (Filipino) without rewriting handlers. | Frontend error UX |
| Rate limiting | **Per-endpoint manual rate-limit table for auth + receipt issuance** (FR28). For Phase 3 webhooks, gateway idempotency keys. | Convex has no built-in rate limiter. Phase 1 only enforces it on the few endpoints where it matters (auth — NFR-S6; receipt issuance — defense against accidental duplicate issuance). | Auth, receipts |
| **Atomic mutation pattern (cornerstone)** | **All financial mutations route through a `postFinancialEvent(ctx, payload)` helper** that: (1) `requireRole` check; (2) reads receipt-counter doc with optimistic concurrency; (3) writes payment + contract update + receipt + audit log atomically; (4) returns receipt PDF blob key. | The single most important architectural pattern in the system. PRD NFR-C1, NFR-C2, FR32 all depend on this. Tested to ≥ 95% line coverage (NFR-M2). | All payment-touching flows |
| Receipt-serial allocation | **Single `receipt_counter` document with `currentSerial` field; allocation is `db.patch(counterId, { currentSerial: existing + 1 })` inside the same mutation as the payment** | Convex's per-document optimistic concurrency = serializable counter without locks. Voids consume serials (FR29) by writing a `void_receipts` record without incrementing. | FR28, FR29, NFR-C1 |
| State-machine guards | **Explicit transition tables in `convex/lib/state-machines.ts`** for contract states (FR23), lot states (Domain Patterns), receipt states. Mutations call `assertTransition(currentState, requestedState, reason)` before applying. | Convex has no built-in FSM. Centralizing transitions in declarative tables makes them testable and discoverable. | Contracts, lots, receipts |
| Webhook handlers (Phase 3) | **Convex HTTP actions** validating gateway signature + idempotency key, then immediately routing to `postFinancialEvent`. ACK within NFR-I2 5-second budget; defer email send to scheduled action. | Same atomic pattern as office-staff payments — the webhook is just a different entry point. | FR33 |

### Frontend Architecture

| Decision | Choice | Rationale | Affects |
|---|---|---|---|
| State management | **Convex reactive queries only** for server state; React `useState` for local UI | Stack lock; no Redux / Zustand / TanStack Query on top. | All |
| Server vs Client components | **Server components for public / landing (Phase 3) only**; everything authenticated is client-component | Convex hooks require client context; auth-walled routes get no SEO benefit from RSC. | Route structure |
| **Component library** | **shadcn/ui** (Radix primitives + Tailwind, copy-paste-into-repo model) | Tailwind-native, no runtime dependency, owns-the-code model fits the freelance / single-engineer constraint (no upstream API churn). Used everywhere shadcn/ui has a component; bespoke Tailwind otherwise. | All UI |
| **Form library** | **React Hook Form + Zod** for schemas (sale, payment, customer creation, expense) | Standard pair; integrates with shadcn/ui's form components; handles the installment-schedule preview form (Journey 1) cleanly. | Sale / payment / customer forms |
| Routing | **Next.js App Router file-based routing with route groups**: `(staff)/...`, `(customer)/...` (Phase 3), `(public)/...` | Layouts handle role-based redirects; route groups separate authn surface without affecting URLs. | Route structure |
| **Phase 1 map renderer** | **SVG overlay** with per-section image backing | More flexible than a single static image; clickable lot regions; easy to author section-by-section; schema-compatible with the Phase 2 Leaflet swap (geometry fields just go unused until then). | FR10 Phase 1 |
| Phase 2 map renderer | **Leaflet + OpenStreetMap tiles** (Mapbox switch only if OSM coverage proves inadequate — deferred) | Per PRD §7.1; OSM free, well-supported. `next/dynamic` lazy-load to honor NFR-P6 bundle budget. | FR10 / FR12 Phase 2 |
| **PDF library** | **PDFKit** (Node.js) inside Convex `"use node"` actions | PDFKit is the right tool for "creating new PDFs from scratch on the server with precise control" — exactly the BIR receipt + Phase 2 contract / demand-letter use case. `pdf-lib` is for modifying existing PDFs. | FR30, FR49, FR50 |
| **PWA / service worker** | **Hand-rolled service worker** (~100 lines) for read-path lot caching; no `next-pwa` dependency | `next-pwa` lags Next.js releases; PWA needs here are narrow (NFR-R6 24-hour stale rule + lot data only). Custom SW is lower risk than a complex dependency. | FR11, NFR-R6 |
| Bundle enforcement | **ESLint rule banning client imports of `leaflet`, `pdfkit`** | Prevents accidental client-bundle bloat (NFR-P6 < 250KB). | All |

### Brand Identity & Visual System

Adopted 2026-05-22 from `apostle-paul-brand-guidelines.html` at the repo root. The cemetery client is **Apostle Paul Memorial Park · Cases Land Inc.** at Zone 1, San Eugenio, Aringay, La Union 2503, Philippines. The brand guide commits to specific visual + tonal decisions every UI surface honours.

| Decision | Choice | Rationale | Affects |
|---|---|---|---|
| **Brand palette** | Emerald `#1D5C4D` (primary), Forest `#2F6B57`, Moss `#4A8270`, Ivory `#F6F2EA` (surface), Stone `#B8B6AF`, Gold `#C9A96B` (accent only, rationed to hairlines + mark inlay; never fill), Ink `#2A2925` (never `#000`) | Brand commitment; replaces the slate-based palette from Story 1.4. Status-pill semantic colors (overdue red, available emerald) stay — they're functional, not brand. | All UI; defined in `tailwind.config.ts` + `globals.css` |
| **Typography pair** | **Cormorant Garamond** (serif, ceremonial — headings, wordmark, pull-quotes) + **Manrope** (sans, operational — body, forms, tables) + JetBrains Mono (codes, labels) | Brand spec Chapter IV. Replaces Inter. Loaded via `next/font/google` so SSR + indoor-mode bootstrap render without FOUC. | All UI; `src/app/layout.tsx` |
| **Logo** | Dove within laurel; gold diamond inlay at stem crossover. Placeholder SVG lives in `public/brand/mark.svg` + `wordmark.svg` until a final asset arrives | Brand spec Chapter II. The placeholder honours the dove-laurel motif. | AppShell masthead, login pages, PDF headers |
| **Voice pillars** | Reverent · Compassionate · Permanent · Restrained. No exclamation, no urgency, no superlatives, no "buy now" / "deal" / "package" language. Sign-off pattern: "With reverence, / The Estate Office" | Brand spec Chapter IX. Customer-facing copy (portal, reminders, demand letters, error toasts) honours all four pillars. Staff-facing copy stays operational. | `convex/lib/reminderTemplates.ts`, `src/app/(customer)/portal/**`, all customer-facing components |
| **Document templates** | Branded letterhead for receipt + contract + demand-letter PDFs: emerald masthead, gold hairline rule, Cormorant Garamond display, italic "With reverence" sign-off. NEW plaque PDF generator for monument inscriptions (name + Roman-numeral life dates + italic epitaph) | Stories 3.13, 6.1, 6.2 templates retrofitted. New plaque story 6.8 fronts the office-staff workflow. PDFKit handles font registration + base64-bundled brand assets via `convex/lib/brandAssets.ts`. | `convex/actions/generate{Receipt,Contract,DemandLetter,Plaque}Pdf.ts` |
| **Cemetery address** | Always render the canonical address: `Zone 1, San Eugenio / Aringay, La Union 2503 / Philippines`. Brand HTML's earlier "Bulacan" references corrected on 2026-05-22. | Real cemetery location. PDFs, portal, letterhead, signage all consume the same string from `convex/lib/brandAddress.ts` (single source of truth) | All branded surfaces |

**Brand-implied future stories (filed 2026-05-22, status: `ready-for-dev`):**

- [Story 1.15 — Named sections registry](../../_bmad-output/implementation-artifacts/1-15-named-sections-registry.md): wayfinding-grade section names (e.g. "Chapel of Grace", "Family Estates · East") replace `lots.section` free-text.
- [Story 2.9 — Family-estate multi-lot grouping](../../_bmad-output/implementation-artifacts/2-9-family-estate-multi-lot-grouping.md): multi-lot estates owned as a single contractual unit by a household.
- [Story 6.8 — Memorial plaque PDF generator](../../_bmad-output/implementation-artifacts/6-8-generate-memorial-plaque-pdf.md): office-staff-facing workflow on top of the new `generatePlaquePdf` action.
- [Story 7.5 — Consecration ceremony scheduling](../../_bmad-output/implementation-artifacts/7-5-schedule-consecration-ceremony.md): ceremony scheduling distinct from interment, extending Epic 7's calendar.

### Infrastructure & Deployment

| Decision | Choice | Rationale | Affects |
|---|---|---|---|
| Frontend hosting | **Vercel** (locked in PRD § Web App Requirements) | One-click integration with Convex preview deploys. Cemetery owns the Vercel account from day one (NFR-M4). | All |
| Backend hosting | **Convex Cloud** (locked) | Stack lock. | All |
| CI provider | **GitHub Actions** | Free for private repos at this team size; standard. | All |
| CI pipeline (per PR) | **Lint → Typecheck → Vitest → Playwright (smoke subset) → Lighthouse (emulated mid-Android / 4G)** | NFR-M2 coverage gate, NFR-P1 / P2 performance gate. Full Playwright suite runs nightly, not on every PR. | All |
| Preview deploys | **Vercel preview per PR** + **Convex preview deployment per PR** (April 2026 reusable-preview-name pattern) | Confirms each PR works end-to-end in a real environment before merge; cheap, fast. | All |
| Environment configuration | **`.env.local` dev**; **Vercel + Convex env vars for preview / prod** (twin per environment) | Standard. Secrets never in repo. | All |
| Monitoring (server) | **Convex built-in function logs + metrics** | Free, included; sufficient for Phase 1 scale. | All |
| Monitoring (client) | **Sentry free tier** for client-side error tracking + performance | NFR-P5 (INP) easier to monitor via Sentry's Web Vitals than ad-hoc. Free tier covers this scale. | All |
| Admin error visibility | **`recent_errors` Convex query** for the Admin dashboard — surfaces last 24h of Sentry events + Convex function errors in one place | NFR-R4 visibility principle: failures should appear on the dashboard, not buried in logs. | Admin dashboard |
| Scaling | **No autoscaling needed**; Convex's tier-based scaling is sufficient; Vercel auto-scales | Fixed-scope project; transaction volume is human-typing-speed. | All |
| Backups (operational) | **Convex managed daily backup, 30-day retention** (NFR-R2) | Built-in feature; verify retention via dashboard config. Quarterly restore drill on a scratch environment. | All |
| **Archival exports (BIR 10-year)** | **Scheduled monthly Convex action exports receipts + payments + customers to compressed JSON in Convex File Storage**, manually mirrored to an S3-compatible bucket the cemetery controls | NFR-R3 / NFR-C2. Separate retention policy from operational backup. Re-evaluate Phase 2 if regulatory audit reveals a stricter format requirement. | Compliance |

### Decision Impact Analysis

**Implementation sequence (first stories of Phase 1):**

1. Run starter command from Starter Template Evaluation → commit `package.json` + `tsconfig.json` + `tailwind.config.*` + initial Convex deploy
2. **ADR-001:** Starter choice & rationale (this doc, condensed)
3. Set up CI pipeline (lint, typecheck, Vitest, Playwright skeleton, Lighthouse)
4. Implement `convex/lib/auth.ts` (`requireRole` helper) — tested in isolation first
5. Implement `convex/lib/state-machines.ts` (transition tables for contract + lot + receipt)
6. Implement `convex/lib/audit.ts` (`emitAudit` helper)
7. Implement `convex/lib/postFinancialEvent.ts` (the atomic-mutation cornerstone) — tested to ≥ 95% coverage before any UI work
8. Schema first cut: lots + customers + ownerships + occupants
9. Map renderer (Phase 1 SVG) + viewport-bbox query
10. Sale flow (Journey 1) end-to-end

**Cross-component dependencies:**

- `postFinancialEvent` is depended on by: sale, payment, refund / void, Phase 3 webhook handler. It must be correct before any of those land.
- `requireRole` is depended on by every other server function. It lands in week 1.
- `state-machines.ts` is depended on by sale flow (lot status transition), contract creation, payment posting. Lands before the sale flow.
- The SVG map renderer can be built in parallel with the financial backend (different engineer if a second engineer joins) since it shares only the lot schema.
- Customer auth (Phase 3, FR5) is deferred — the Phase 3 architectural re-evaluation point.

### Deferred to UX Phase

These need Sally's UX input before final lock:

- shadcn/ui component selection (which components vs. bespoke Tailwind)
- Specific form layouts (the installment-schedule preview in Journey 1 is the most complex)
- Map interaction patterns (tap-and-hold? long-press? click-vs-tap differences across devices?)
- High-contrast / outdoor mode toggle UI (NFR-A5)
- Color-blind-safe lot status palette (NFR-A2)

Architecture will not block on these; sensible defaults established now, refined when UX lands.

## Implementation Patterns & Consistency Rules

### Pattern Categories Defined

**Critical conflict points identified:** 14 areas where contributors (human or AI) could plausibly make different choices. Each is locked here.

### Naming Patterns

#### Database (Convex tables, fields, indexes)

| Pattern | Rule | Example |
|---|---|---|
| **Table names** | `camelCase`, plural, noun | `lots`, `customers`, `ownerships`, `paymentReceipts`, `auditLog` |
| **Foreign-key fields** | `<entity>Id` (camelCase, singular) typed as `v.id("<table>")` | `lotId: v.id("lots")`, `customerId: v.id("customers")` |
| **Boolean fields** | `is<X>` or `has<X>` prefix; never bare adjectives | `isVoided`, `hasConsent`, NOT `voided`, `consent` |
| **Timestamp fields** | Unix ms `v.number()`; field name ends in `At` for instants, `From` / `To` for ranges | `createdAt`, `effectiveFrom`, `effectiveTo`, `dueAt` |
| **Money fields** | Field name ends in `Cents`; type `v.number()`; always integer pesos × 100 | `basePriceCents`, `outstandingBalanceCents` |
| **Enum-typed fields** | `v.union(v.literal("a"), v.literal("b"), ...)`; values are lowercase snake-style; field name describes the dimension | `status: "available" \| "reserved" \| "sold" \| "occupied" \| "cancelled" \| "defaulted" \| "transferred"` |
| **Index names** | `by_<field>` for single, `by_<field1>_<field2>` for compound | `.index("by_status", ["status"])`, `.index("by_lot_effective", ["lotId", "effectiveFrom"])` |
| **Audit-emitting tables** | Every table that takes financial-touching writes has corresponding entries in `auditLog`. No exceptions; enforced by `postFinancialEvent` helper. | — |

#### Convex Functions

| Pattern | Rule | Example |
|---|---|---|
| **File location** | One file per domain in `convex/<domain>.ts`; shared helpers under `convex/lib/<helper>.ts` | `convex/payments.ts`, `convex/lib/postFinancialEvent.ts` |
| **Query naming** | `verb + Noun`; verb is `list`, `get`, `find`, `search` | `listAvailableLots`, `getLot`, `findCustomerByName`, `searchLots` |
| **Mutation naming** | `verb + Noun`; verb is `create`, `update`, `record`, `post`, `void`, `transition` | `createCustomer`, `recordPayment`, `voidReceipt`, `transitionContractState` |
| **Action naming (Node runtime)** | `verb + Noun` with `Pdf`, `Webhook`, or external-system suffix | `generateReceiptPdf`, `handleGcashWebhook`, `sendReminderSms` |
| **Internal-only functions** | Use `internalMutation` / `internalQuery` / `internalAction` from `_generated/server`; never callable from client | `internalRecomputeArAging` |
| **First line of every public function** | `requireRole(ctx, [allowedRoles])` — no exceptions; lint-enforced | `await requireRole(ctx, ["admin", "office_staff"]);` |

#### Frontend (React + Next.js)

| Pattern | Rule | Example |
|---|---|---|
| **Route files** | App Router conventions only: `page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`. Lowercase folder names. | `src/app/(staff)/lots/[lotId]/page.tsx` |
| **Component files** | `PascalCase.tsx`, one component per file (named export matches filename). No default exports. | `src/components/LotMap.tsx` → `export function LotMap()` |
| **Component folder structure** | Flat by default; folder-per-component only when the component has > 3 sub-files | `src/components/SaleForm/{index.ts, SaleForm.tsx, schedule-preview.tsx, helpers.ts}` |
| **Client component marker** | `"use client";` is line 1 in every client component; absent in server components | — |
| **Hook naming** | `use<X>`; custom hooks under `src/hooks/`; never call Convex hooks inside event handlers | `useCurrentUser`, `useLotsInViewport` |
| **Types** | Inferred from Convex `_generated/api` wherever possible; explicit types in `src/types/<domain>.ts` only for client-derived shapes | `type LotStatus = Doc<"lots">["status"]` |

### Structure Patterns

#### Repo layout (definitive)

```
cemetery-mapping/
├── .github/workflows/         # CI definitions
├── convex/
│   ├── _generated/            # Convex-generated; committed
│   ├── schema.ts              # Canonical data model
│   ├── lib/                   # Shared helpers
│   │   ├── auth.ts            # requireRole, session helpers
│   │   ├── audit.ts           # emitAudit
│   │   ├── stateMachines.ts   # Transition tables for contract / lot / receipt
│   │   ├── postFinancialEvent.ts  # The atomic-mutation cornerstone
│   │   ├── money.ts           # Centavo arithmetic + PH peso formatting
│   │   ├── time.ts            # Manila timezone helpers
│   │   └── errors.ts          # ConvexError code constants
│   ├── lots.ts                # Domain: lot queries / mutations
│   ├── customers.ts
│   ├── ownerships.ts
│   ├── sales.ts
│   ├── contracts.ts
│   ├── payments.ts
│   ├── receipts.ts
│   ├── expenses.ts
│   ├── auditLog.ts            # Queries over auditLog table (writes are via emitAudit)
│   ├── scheduled.ts           # Daily AR aging, reconciliation, follow-up re-flag
│   └── http.ts                # Phase 3 webhook endpoints
├── src/
│   ├── app/
│   │   ├── (public)/          # Phase 3 portal landing
│   │   ├── (staff)/           # Authenticated staff routes
│   │   ├── (customer)/        # Phase 3 customer portal
│   │   ├── layout.tsx
│   │   └── middleware.ts      # Auth gate per route group
│   ├── components/
│   ├── hooks/
│   ├── lib/                   # Client-side helpers (formatting, error translation)
│   ├── types/                 # Client-only type aliases
│   └── styles/
├── tests/
│   ├── unit/                  # Vitest, mirrors convex/ + src/ structure
│   ├── e2e/                   # Playwright
│   └── fixtures/
├── docs/
│   ├── adr/                   # Architecture Decision Records (NFR-M3)
│   ├── runbook.md             # Ops playbook
│   └── bir-receipt-template.md
├── public/
└── package.json
```

**Why not feature-folders (`src/features/sales/...`)?** Two reasons: (1) Convex's flat per-domain file convention works against it, so the convention would be inconsistent across the stack; (2) for a small team, type-based grouping has a flatter mental model and easier code review. Re-evaluate if team grows past 3 engineers.

#### Test file location

- **Convex function tests:** `tests/unit/convex/<domain>.test.ts` — mirrors `convex/<domain>.ts`. Vitest with Convex test harness.
- **React component tests:** co-located as `<Component>.test.tsx` next to the component. Vitest + Testing Library.
- **E2E tests:** `tests/e2e/<journey>.spec.ts` — one file per PRD User Journey (e.g. `journey-1-installment-sale.spec.ts`). Playwright.

### Format Patterns

#### Money

- **Storage:** integer centavos (`number`). ₱1,250.00 stored as `125000`.
- **Arithmetic:** never use floating-point math on monetary values. All operations through `convex/lib/money.ts` helpers: `add(a, b)`, `sub(a, b)`, `mul(amountCents, factor)`, `pctOf(amountCents, percentBp)`. `percentBp` is basis points (1% = 100bp) to keep integer math.
- **Display (client):** `src/lib/money.ts` exposes `formatPeso(cents: number): string` → `"₱1,250.00"`. Uses `Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" })`.
- **Input (forms):** React Hook Form `controller` converts user-typed pesos to centavos before submission. Display value never leaves the form layer.
- **Forbidden:** `Number(x) * 100`, `x.toFixed(2)`, any peso math outside the helpers.

#### Time & dates

- **Storage:** Unix milliseconds (`number`). UTC implicit; Convex doesn't have a timestamp type.
- **Server functions:** use `Date.now()` for "now"; never accept a client-supplied "now" unless explicitly testing.
- **Display (client):** all date display through `src/lib/time.ts` → `formatDate(ms, "short" | "long" | "datetime")`. Always in Manila timezone (`Asia/Manila`), regardless of where the browser is.
- **Forbidden:** raw `new Date()` in components, `toLocaleString()` without explicit `"en-PH"` + `timeZone: "Asia/Manila"`.

#### Error responses

- **Server:** throw `ConvexError` with object payload: `{ code: "<UPPER_SNAKE>", message: "...", details?: {...} }`. Codes live in `convex/lib/errors.ts` as constants.
- **Client:** every Convex hook call wrapped in a top-level `<ErrorBoundary>` (route layout). Inline mutation errors via `try { await mutation } catch (e)` → call `translateError(e)` from `src/lib/errors.ts`, which returns `{ headline, detail, retryable }`.
- **User-facing message:** never raw stack traces; never raw codes; always a sentence the office staff can act on.
- **Forbidden:** swallowing errors silently, logging only without UI feedback, `console.error` in production paths.

#### JSON / data field naming

- **Client ↔ server:** `camelCase` throughout. Convex enforces this; matches TypeScript convention.
- **Boolean values:** always `true` / `false`. Never `1` / `0`, never `"yes"` / `"no"`.
- **Null vs undefined:** undefined = field not provided; null = field explicitly cleared. Convex distinguishes; we honor that distinction.
- **Arrays for single items:** never. Use single item or `null` / `undefined`.

### Communication Patterns

#### State updates (frontend)

- **Server state:** `useQuery(api.<domain>.<query>, args)` — single source of truth. Never copy into local state.
- **Local UI state:** `useState` / `useReducer` only.
- **Optimistic updates:** Convex supports them via `useMutation(...).withOptimisticUpdate(...)`. Use sparingly — only for non-financial flows where the optimistic outcome is certain (e.g. toggling a UI filter). **Never optimistic on financial mutations.**
- **Forbidden:** Redux, Zustand, Jotai, Recoil, TanStack Query, SWR.

#### Audit-log emission

- **Pattern:** all financial-touching mutations call `emitAudit(ctx, { action, entityType, entityId, before, after, reason })` from `convex/lib/audit.ts`.
- **`reason`** is required for state-machine transitions (FR23, lot status, contract state). Free-text, captured from UI input. Optional otherwise.
- **`before`/`after`** are stripped of PII at write time (gov ID number redacted to last 4) — keeps audit log queryable for admins without re-exposing sensitive data.
- **Forbidden:** writing to `auditLog` table directly; inlining audit emit logic; conditional audit emission.

#### PII access logging

- **Pattern:** any query that reads `customer.govIdNumber` or generates a signed URL for an ID-scan file goes through `convex/lib/pii.ts` → `readPii(ctx, customerId, fields[])`. The helper logs to `piiAccessLog` and returns the field values.
- **Forbidden:** reading PII fields directly via `ctx.db.get(customerId)` in queries surfaced to the client. (Server-side internal use is OK; flagged for review.)

### Process Patterns

#### Loading states

- **Convex `useQuery`** returns `undefined` while loading. Default pattern:
  ```tsx
  const lots = useQuery(api.lots.listInViewport, { bbox });
  if (lots === undefined) return <LotsListSkeleton />;
  ```
- **Skeletons over spinners** for content (table rows, cards, map sections). Spinners only for in-flight mutations (button label).
- **Suspense boundaries** at the route level via `loading.tsx`. Never wrap individual components.
- **Forbidden:** showing empty state during loading; spinner-on-everything; conditional rendering of zero-state vs loading without explicit checks.

#### Validation timing

- **Forms:** validation runs on blur (React Hook Form default) and on submit. Inline submission errors via `setError(name, ...)` from RHF.
- **Server:** Convex schema validators run on every mutation entry. Domain-level invariants (e.g. "contract balance can't go negative") are guarded inside the mutation; throw `ConvexError("INVARIANT_VIOLATION", ...)` if violated.
- **Defense-in-depth:** never trust client validation. Re-validate everything on the server even when forms have already validated.

#### Retry & idempotency

- **Client retries on mutations:** Convex client retries network errors automatically. App code does NOT retry mutations manually.
- **Idempotent mutations:** payment-posting accepts an `idempotencyKey: string` (UUIDv4 from client). The mutation checks `payments.find_by_idempotency_key(key)` before processing; if found, returns the existing receipt without writing.
- **Webhook handlers:** gateway-supplied transaction ID is the idempotency key.

#### State-machine guards

- **Pattern:** any mutation that transitions an entity's state calls `assertTransition(currentState, requestedState, transitions[entityType], reason)` from `convex/lib/stateMachines.ts`. Throws `ConvexError("ILLEGAL_STATE_TRANSITION", ...)` if invalid.
- **Tables:** `transitions: Record<EntityType, Record<FromState, ToState[]>>`. Documented + tested.
- **Forbidden:** updating `status` fields with `ctx.db.patch(..., { status: ... })` outside a state-machine guard call.

### Enforcement Guidelines

**All contributors (human or AI) MUST:**

1. Begin every public Convex query / mutation / action with `await requireRole(ctx, [...])`.
2. Use `postFinancialEvent` for every payment, sale, void, or refund. Never write to `payments` / `receipts` / `contracts.balance` directly.
3. Use the `money.ts` helpers for all monetary arithmetic.
4. Use `formatPeso` and `formatDate` for all user-facing money and date display.
5. Emit audit log entries via `emitAudit(...)` — never write to `auditLog` table directly.
6. Use `assertTransition(...)` for every entity state change.
7. Throw `ConvexError` with `{ code, message }` for known errors.
8. Place one Convex domain per file; one React component per file (named export).

**Lint-enforced (ESLint custom rules + CI):**

- No client-side imports of `leaflet`, `pdfkit`, or Node-only Convex action files
- No raw `* / 100` or `* * 100` math on identifiers ending in `Cents` (heuristic; flags suspicious peso math)
- No `useQuery` / `useMutation` calls without explicit destructure of loading / error state
- No `ctx.db.patch(..., { status: ... })` outside files importing from `stateMachines.ts`
- Every `convex/*.ts` (non-`_generated`, non-`lib`) file must contain at least one `requireRole` call

**Test-enforced:**

- `postFinancialEvent` has ≥ 95% line coverage (NFR-M2 target is 90%; cornerstone code goes higher)
- Every state machine has tests covering: each legal transition, each illegal transition produces `ConvexError`, transitions emit audit log entries
- Daily reconciliation invariant has a test that produces a deliberately-divergent payment and verifies the invariant fails

### Pattern Examples

**Good — payment posting:**

```typescript
export const recordPayment = mutation({
  args: {
    contractId: v.id("contracts"),
    amountCents: v.number(),
    method: v.union(v.literal("cash"), v.literal("check"), v.literal("bank")),
    allocationOverride: v.optional(v.array(v.object({...}))),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["office_staff", "admin"]);
    return await postFinancialEvent(ctx, {
      kind: "payment",
      ...args,
    });
  },
});
```

**Anti-pattern — payment posting (don't do this):**

```typescript
// ❌ No requireRole check
// ❌ Direct writes to multiple tables outside postFinancialEvent
// ❌ Raw math on cents
// ❌ Missing audit emission
// ❌ Missing idempotency check
export const recordPayment = mutation({
  args: { contractId: v.id("contracts"), amount: v.number() },
  handler: async (ctx, args) => {
    const contract = await ctx.db.get(args.contractId);
    await ctx.db.insert("payments", { contractId: args.contractId, amount: args.amount });
    await ctx.db.patch(args.contractId, { balance: contract.balance - args.amount });
  },
});
```

## Project Structure & Boundaries

### Complete Project Directory Structure

The repo layout from § Implementation Patterns > Structure Patterns is the canonical structure. This section adds file-level detail (config files, helper files, test files) that wasn't named there. Read both together.

```
cemetery-mapping/
├── README.md                  # Quick-start (dev setup, common commands)
├── CLAUDE.md                  # AI-agent guide (updated per Phase)
├── package.json
├── package-lock.json
├── tsconfig.json              # strict: true, target ES2022
├── next.config.ts             # Next.js config (PWA registration in prod only)
├── tailwind.config.ts         # Tailwind preset + custom theme tokens
├── postcss.config.mjs
├── eslint.config.mjs          # Standard + custom rules
├── vitest.config.ts           # Vitest + Convex test harness
├── playwright.config.ts       # Playwright with mid-Android-on-4G emulation profile
├── .gitignore
├── .env.example               # Documents required env vars (no secrets)
├── .env.local                 # Dev only; gitignored
│
├── .github/
│   └── workflows/
│       ├── ci.yml             # Lint → typecheck → vitest → playwright(smoke) → lighthouse
│       ├── nightly.yml        # Full Playwright suite + extended Lighthouse run
│       └── archival.yml       # (Phase 1.5) Monthly archival export verification
│
├── convex/
│   ├── _generated/            # Auto-generated; committed
│   ├── schema.ts              # Canonical data model — all tables + indexes
│   ├── auth.config.ts         # Convex Auth provider config (password + Google OAuth)
│   │
│   ├── lib/                   # Server-internal helpers (NEVER imported by client)
│   │   ├── auth.ts            # requireRole, getCurrentUser, sessionConfig
│   │   ├── audit.ts           # emitAudit, redactPii
│   │   ├── errors.ts          # ConvexError code constants
│   │   ├── money.ts           # Centavo arithmetic
│   │   ├── pii.ts             # readPii (logs access + returns fields)
│   │   ├── postFinancialEvent.ts  # ★ Atomic-mutation cornerstone
│   │   ├── stateMachines.ts   # Transition tables + assertTransition
│   │   └── time.ts            # Manila tz helpers
│   │
│   ├── lots.ts                # FR6–FR13 domain
│   ├── customers.ts           # FR14, FR15, FR18 domain
│   ├── ownerships.ts          # FR16, FR17 — time-versioned ownership
│   ├── sales.ts               # FR19, FR22 — entry to postFinancialEvent
│   ├── contracts.ts           # FR20, FR21, FR23, FR24, FR25
│   ├── payments.ts            # FR26, FR27, FR31, FR32 — entry to postFinancialEvent
│   ├── receipts.ts            # FR28, FR29, FR30 — receipt queries
│   ├── arAging.ts             # FR34, FR35, FR36, FR37, FR38
│   ├── expenses.ts            # FR39, FR40, (FR41 P2)
│   ├── dashboards.ts          # FR42, FR43, FR44
│   ├── reports.ts             # FR45, FR46, FR47 (P2), FR48 (P3)
│   ├── audit.ts               # FR47 (P2 audit UI), FR59 — reads only
│   ├── piiAccess.ts           # FR63, FR64
│   │
│   ├── actions/               # "use node" actions (Node runtime)
│   │   ├── generateReceiptPdf.ts   # FR30 PDFKit
│   │   ├── generateContractPdf.ts  # FR49 (P2)
│   │   ├── generateDemandLetterPdf.ts  # FR50 (P2)
│   │   ├── archivalExport.ts       # FR62 monthly export
│   │   ├── sendReminderSms.ts      # FR57 (P3)
│   │   └── sendReminderEmail.ts    # FR57 (P3)
│   │
│   ├── scheduled.ts           # Cron registrations only; logic in lib/ + actions/
│   ├── http.ts                # Phase 3 webhook endpoints (GCash, Maya, card)
│   ├── customerPortal.ts      # FR5, FR55, FR56, FR58 (P3)
│   └── interments.ts          # FR51–FR54 (P2)
│
├── src/
│   ├── app/
│   │   ├── layout.tsx                 # Root layout: ConvexProvider, theme, fonts
│   │   ├── globals.css                # Tailwind directives, custom CSS vars
│   │   ├── middleware.ts              # Auth-gate routing per route group
│   │   ├── not-found.tsx
│   │   ├── error.tsx                  # Top-level error boundary
│   │   │
│   │   ├── (public)/                  # No auth required (Phase 3 portal landing)
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx
│   │   │   └── login/page.tsx
│   │   │
│   │   ├── (staff)/                   # Authenticated office staff / admin / field
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx               # → /dashboard redirect
│   │   │   ├── dashboard/page.tsx     # FR42 KPI dashboard
│   │   │   ├── lots/
│   │   │   │   ├── page.tsx           # FR7 map + list view
│   │   │   │   └── [lotId]/page.tsx   # FR8 lot detail
│   │   │   ├── customers/
│   │   │   │   ├── page.tsx
│   │   │   │   ├── new/page.tsx       # FR14, FR15
│   │   │   │   └── [customerId]/page.tsx
│   │   │   ├── sales/new/page.tsx     # Journey 1 — FR19, FR20
│   │   │   ├── contracts/
│   │   │   │   ├── page.tsx
│   │   │   │   └── [contractId]/page.tsx
│   │   │   ├── payments/new/page.tsx  # Journey 2 — FR26, FR27
│   │   │   ├── ar-aging/page.tsx      # FR34
│   │   │   ├── expenses/
│   │   │   │   ├── page.tsx           # FR39
│   │   │   │   └── new/page.tsx
│   │   │   ├── reports/page.tsx       # FR45, FR46 (P2)
│   │   │   ├── audit/page.tsx         # FR47 (P2)
│   │   │   ├── interments/page.tsx    # FR51 (P2)
│   │   │   └── admin/
│   │   │       ├── users/page.tsx     # FR2, FR3
│   │   │       ├── expense-categories/page.tsx  # FR40
│   │   │       └── settings/page.tsx
│   │   │
│   │   ├── (customer)/                # P3 customer portal
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx               # FR55
│   │   │   ├── contracts/[id]/page.tsx
│   │   │   ├── pay/page.tsx           # FR33 gateway
│   │   │   └── profile/page.tsx       # FR58
│   │   │
│   │   └── api/                       # Reserved — most "API" lives in convex/http.ts
│   │
│   ├── components/
│   │   ├── ui/                        # shadcn/ui copies (button, input, dialog, …)
│   │   ├── LotMap/                    # Phase 1 SVG renderer / Phase 2 Leaflet swap
│   │   │   ├── index.ts
│   │   │   ├── LotMap.tsx
│   │   │   ├── SvgRenderer.tsx        # Phase 1
│   │   │   └── LeafletRenderer.tsx    # Phase 2 (lazy-loaded)
│   │   ├── SaleForm/
│   │   │   ├── SaleForm.tsx           # Journey 1
│   │   │   ├── SchedulePreview.tsx
│   │   │   └── lotPicker.tsx
│   │   ├── PaymentForm/               # Journey 2
│   │   ├── CustomerForm/
│   │   ├── KpiCard.tsx
│   │   ├── ArAgingTable.tsx
│   │   ├── ExpenseForm.tsx
│   │   ├── ReceiptViewer.tsx
│   │   ├── SkeletonCard.tsx
│   │   ├── SkeletonTable.tsx
│   │   ├── StatusBadge.tsx            # Color + icon + label (NFR-A2)
│   │   └── ErrorBoundary.tsx
│   │
│   ├── hooks/
│   │   ├── useCurrentUser.ts
│   │   ├── useLotsInViewport.ts       # FR10 viewport-bbox query
│   │   ├── useIdempotencyKey.ts       # UUIDv4 per form-mount
│   │   └── useManilaNow.ts
│   │
│   ├── lib/                           # Client-side helpers
│   │   ├── money.ts                   # formatPeso
│   │   ├── time.ts                    # formatDate, Manila tz
│   │   ├── errors.ts                  # translateError
│   │   ├── geometry.ts                # bbox utilities for the map
│   │   ├── pwa.ts                     # Service worker registration helpers
│   │   └── convexClient.ts
│   │
│   ├── types/
│   │   ├── lot-status.ts
│   │   ├── contract-state.ts
│   │   └── role.ts
│   │
│   ├── styles/
│   │
│   └── sw.ts                          # Hand-rolled service worker (production only)
│
├── tests/
│   ├── unit/
│   │   ├── convex/
│   │   │   ├── lib/
│   │   │   │   ├── postFinancialEvent.test.ts  # ★ ≥ 95% line coverage
│   │   │   │   ├── stateMachines.test.ts
│   │   │   │   ├── auth.test.ts
│   │   │   │   ├── money.test.ts
│   │   │   │   └── audit.test.ts
│   │   │   ├── payments.test.ts
│   │   │   ├── contracts.test.ts
│   │   │   ├── arAging.test.ts
│   │   │   └── …
│   │   └── lib/
│   │       ├── money.test.ts
│   │       └── errors.test.ts
│   │
│   ├── e2e/
│   │   ├── journey-1-installment-sale.spec.ts
│   │   ├── journey-2-payment-override.spec.ts
│   │   ├── journey-3-field-worker-lookup.spec.ts
│   │   ├── journey-4-admin-dashboard.spec.ts
│   │   └── smoke.spec.ts              # CI per-PR subset
│   │
│   └── fixtures/
│       ├── seedLots.ts                # ~200-lot pilot fixture
│       ├── seedCustomers.ts
│       └── seedScenarios.ts
│
├── docs/
│   ├── adr/
│   │   ├── 0001-starter-template.md
│   │   ├── 0002-auth-convex-auth.md
│   │   ├── 0003-pdf-pdfkit.md
│   │   ├── 0004-map-renderer-phase1-svg.md
│   │   ├── 0005-money-integer-centavos.md
│   │   └── 0006-postFinancialEvent-pattern.md
│   ├── runbook.md                     # Ops: incident response, backup restore, BIR audit prep
│   ├── bir-receipt-template.md        # Locked receipt format (gated on brief §10 Q3)
│   ├── data-migration-plan.md
│   └── threat-model.md
│
└── public/
    ├── favicon.ico
    ├── manifest.webmanifest           # PWA manifest
    └── map/
        ├── overlay-section-a.svg      # Phase 1 SVG section overlays
        ├── overlay-section-b.svg
        └── …
```

### Architectural Boundaries

#### API boundary

- **Public API to clients:** Convex queries, mutations, and actions defined in `convex/<domain>.ts` (NOT in `convex/lib/`, NOT in `convex/_generated/`, NOT in `convex/actions/` Node-runtime files unless explicitly re-exported via a `mutation` / `query` wrapper).
- **Internal-only functions:** Use `internalMutation` / `internalQuery` / `internalAction`. Not callable from the client. Used for: scheduled-function callbacks, cross-mutation composition, archival exports.
- **HTTP boundary (Phase 3):** `convex/http.ts` only. Webhooks acknowledge inside 5s (NFR-I2) and delegate to internal actions for heavy work.

#### Component boundary

- **Server components:** `src/app/(public)/**` only. Render at request time; no Convex hooks. Use server-side `convex/values` for any data needs.
- **Client components:** All `src/app/(staff)/**` and `src/app/(customer)/**` files plus everything under `src/components/`. Marked with `"use client"` on line 1.
- **Cross-route-group communication:** None directly. The middleware (`src/app/middleware.ts`) redirects users by role; route groups don't share layouts or state.

#### Service boundary

- **V8-runtime functions** (queries / mutations): pure TypeScript, no Node APIs, no native deps. Default for everything *except* PDF generation, external HTTP, and SMS / email.
- **Node-runtime actions** (`"use node"`): live in `convex/actions/`. Used for PDFKit, fetch to external services, file-system operations. Cannot be called transactionally — actions are NOT atomic with the calling mutation. Pattern: mutation schedules action; action does external work; action calls back into an internal mutation to record results.
- **External services:** Reached only from `convex/actions/`. Never from queries / mutations. Never from client code.

#### Data boundary

- **PII read boundary:** `convex/lib/pii.ts → readPii(ctx, customerId, fields[])` is the ONLY way to surface PII fields (gov ID, ID-scan signed URLs) to clients. Logs access automatically. Direct `ctx.db.get(customer)` in client-facing queries returns the customer doc with PII fields redacted.
- **Audit-log write boundary:** Only `convex/lib/audit.ts → emitAudit(...)` writes to `auditLog`. ESLint rule blocks `ctx.db.insert("auditLog", ...)` anywhere else.
- **Financial-entity write boundary:** Only `convex/lib/postFinancialEvent.ts` writes to `payments`, `receipts`, `paymentAllocations`. Other code can read these tables; it cannot mutate them.
- **Receipt counter boundary:** Only `postFinancialEvent` reads or writes `receiptCounter`. Tested invariant: serial number is strictly monotonic, no gaps.

### Requirements to Structure Mapping

Mapping each FR capability area from the PRD to its primary files. (Full per-FR mapping lives in the Epic phase — this is the architectural mapping.)

| Capability area | Primary location(s) | Phase |
|---|---|---|
| **1. Identity & Access** | `convex/auth.config.ts`, `convex/lib/auth.ts`, `src/app/middleware.ts`, `src/app/(public)/login/`, `src/hooks/useCurrentUser.ts` | P1 + P3 |
| **2. Lot Inventory & Mapping** | `convex/lots.ts`, `src/components/LotMap/`, `src/hooks/useLotsInViewport.ts`, `src/lib/geometry.ts`, `public/map/overlay-*.svg` (P1) | P1 + P2 |
| **3. Customer & Ownership** | `convex/customers.ts`, `convex/ownerships.ts`, `convex/piiAccess.ts`, `src/components/CustomerForm/` | P1 |
| **4. Sales & Installment Contracts** | `convex/sales.ts`, `convex/contracts.ts`, `convex/lib/stateMachines.ts`, `src/components/SaleForm/`, `src/app/(staff)/sales/new/`, `src/app/(staff)/contracts/` | P1 |
| **5. Payments & BIR Receipts** | `convex/payments.ts`, `convex/receipts.ts`, `convex/lib/postFinancialEvent.ts`, `convex/actions/generateReceiptPdf.ts`, `src/components/PaymentForm/`, `src/components/ReceiptViewer.tsx` | P1 |
| **6. AR Aging & Collections** | `convex/arAging.ts`, `convex/scheduled.ts`, `src/app/(staff)/ar-aging/` | P1 |
| **7. Expense Tracking** | `convex/expenses.ts`, `src/components/ExpenseForm.tsx`, `src/app/(staff)/expenses/` | P1 (+ P2 approval) |
| **8. Reporting & Financial Dashboards** | `convex/dashboards.ts`, `convex/reports.ts`, `src/app/(staff)/dashboard/`, `src/app/(staff)/reports/`, `src/components/KpiCard.tsx`, `src/components/ArAgingTable.tsx` | P1 (basic) + P2 (export) + P3 (trends) |
| **9. Document Generation** | `convex/actions/generateContractPdf.ts`, `convex/actions/generateDemandLetterPdf.ts`, `docs/bir-receipt-template.md` | P2 (receipts already in P1) |
| **10. Interment Scheduling** | `convex/interments.ts`, `src/app/(staff)/interments/` | P2 |
| **11. Customer Self-Service** | `convex/customerPortal.ts`, `convex/http.ts`, `convex/actions/sendReminder*.ts`, `src/app/(customer)/` | P3 |
| **12. System Operations, Audit & Compliance** | `convex/scheduled.ts`, `convex/audit.ts`, `convex/piiAccess.ts`, `convex/actions/archivalExport.ts`, `docs/runbook.md`, `docs/threat-model.md` | P1 |

### Integration Points

#### Internal communication

- **Client → server:** Convex React SDK (`useQuery`, `useMutation`, `useAction`). No other path. Type-safe via `_generated/api`.
- **Server → server:** Convex mutations can call internal mutations / queries (`ctx.runMutation`, `ctx.runQuery`, `ctx.runAction`). Used for scheduled-function bodies and the action-to-mutation callback pattern.
- **Scheduled triggers:** `convex/scheduled.ts` registers cron entries pointing at internal actions / mutations. Run on Convex Cloud's scheduler.

#### External integrations

- **Phase 1:** None.
- **Phase 2:** Map tile provider (OpenStreetMap or Mapbox) — accessed by the browser-side Leaflet renderer, NOT through Convex.
- **Phase 3:**
  - GCash / Maya / card processor → webhook to `convex/http.ts` → validates signature + idempotency → internal call to `postFinancialEvent`.
  - SMS provider (Twilio or PH-local) → `convex/actions/sendReminderSms.ts` outbound only.
  - Email provider (Resend, SendGrid, or similar) → `convex/actions/sendReminderEmail.ts` outbound only.

#### Data flow

**Reading lots in viewport (Journey 3 backbone):**

```
Field worker pans map →
src/components/LotMap/LotMap.tsx computes bbox →
useLotsInViewport(bbox) hook →
api.lots.listInViewport({ bbox }) Convex query →
convex/lots.ts uses by_bbox_lat index → returns ≤ 100 lots →
React reactive subscription renders → SW caches response (NFR-R6).
```

**Posting a payment (Journey 2 backbone):**

```
Office staff submits PaymentForm →
useMutation(api.payments.recordPayment) →
convex/payments.ts → requireRole → postFinancialEvent →
[atomically: insert payment, patch contract.balance, allocate to installments,
  increment receiptCounter, insert receipt, emitAudit] →
scheduled action generateReceiptPdf produces PDF →
PDF stored in Convex File Storage; URL returned via reactive query →
Client renders ReceiptViewer with download link.
```

### File Organization Patterns

#### Configuration

- Root level only: `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `eslint.config.mjs`, `package.json`.
- Environment: `.env.example` (committed, documents required vars) + `.env.local` (gitignored, dev secrets). Vercel + Convex env-var systems for preview / prod.
- No nested config files. Single source of truth per concern.

#### Source

- Two top-level source roots: `src/` (Next.js / React) and `convex/` (backend). They share types via `convex/_generated/dataModel.d.ts`.

#### Tests

- Separation between `tests/unit/` (Vitest, fast) and `tests/e2e/` (Playwright, slow). CI runs unit always, e2e smoke on PRs, full e2e nightly.

#### Assets

- `public/` for served-as-is files: favicon, PWA manifest, SVG map overlays (Phase 1), font files.
- Customer-uploaded images (ID photos) go to Convex File Storage with signed URLs, NOT to `public/`.

### Development Workflow Integration

#### Development server

Two long-running processes during dev:

1. **Terminal 1:** `npm run dev` — Next.js dev server with Turbopack (port 3000).
2. **Terminal 2:** `npx convex dev` — Convex dev watch (regenerates `_generated/` on schema change, hot-reloads server functions).

A `npm run dev:all` script in `package.json` uses `concurrently` to start both. Documented in `README.md`. NFR-M5 (< 10 min from clean clone) measured against this single command + Convex login.

#### Build process

- **Production:** `npm run build` → Next.js production build → Vercel deploys.
- **Convex deploy:** Separate command `npx convex deploy` against the prod deployment (run in CI on `main` merge).
- **Preview:** Vercel preview per PR + Convex preview deploy per PR. Both URLs surface on the PR.

#### Deployment

- **Frontend:** Vercel auto-deploys `main` → production, PRs → preview.
- **Backend:** Convex Cloud — `npx convex deploy` triggered by GitHub Actions on `main` merge.
- **Environment promotion:** Dev → Preview (per-PR) → Prod (`main`). No staging environment — preview deploys serve that role.
- **Rollback:** Vercel one-click; Convex via dashboard or `npx convex deploy --from <previous_deployment_id>`.

## Architecture Validation Results

### Coherence Validation ✅

**Decision compatibility:**

All technology choices form a coherent and well-trodden combination — Next.js 15 + Convex + TypeScript + Tailwind + Vercel + GitHub Actions is documented as the canonical Convex stack in Convex's own quickstart. No version conflicts identified. No contradictory decisions across Steps 3–6.

**Pattern consistency:**

- Naming conventions (camelCase tables, `Cents`-suffix money fields, `verb + Noun` functions, `is / has` boolean prefixes) apply consistently across schema, server functions, and frontend.
- Required-helper enforcement (`requireRole`, `postFinancialEvent`, `emitAudit`, `assertTransition`, `readPii`) is uniform — no exceptions, all lint-enforced.
- "Server is source of truth, client subscribes reactively" pattern is consistent: no Redux / Zustand / TanStack Query introduced anywhere; React `useState` for local UI only.
- Server-component / client-component boundary is explicit: `(public)/**` server, everything else client with `"use client"` marker.

**Structure alignment:**

- The project tree directly supports each architectural decision — `convex/lib/` for server-internal helpers, `convex/actions/` for Node-runtime work, `(staff)` / `(customer)` / `(public)` route groups for auth-surface separation, ADR folder for decisions, runbook for ops.
- Boundaries (API, component, service, data) are encoded in directory structure, not just convention.

### Requirements Coverage Validation

**FR coverage — 65 / 65 covered ✅**

| Capability area | FRs | Architectural support |
|---|---|---|
| 1. Identity & Access | FR1–FR5 | `convex/auth.config.ts`, `convex/lib/auth.ts`, middleware, route groups |
| 2. Lot Inventory & Mapping | FR6–FR13 | `convex/lots.ts`, geometry fields + bbox index, `LotMap` component, PWA cache, schema-ready Phase 2 swap |
| 3. Customer & Ownership | FR14–FR18 | `convex/customers.ts`, `convex/ownerships.ts`, time-versioned schema, `piiAccess.ts` |
| 4. Sales & Installment Contracts | FR19–FR25 | `convex/sales.ts`, `convex/contracts.ts`, `stateMachines.ts` transition tables, perpetual-care `annual_fee_schedule` field |
| 5. Payments & BIR Receipts | FR26–FR33 | `postFinancialEvent` cornerstone, `receipts.ts`, `receiptCounter` doc with optimistic concurrency, `generateReceiptPdf` action, idempotency-key dedup |
| 6. AR Aging & Collections | FR34–FR38 | `convex/arAging.ts`, daily scheduled functions, logged-action expiry re-flag, default-vs-reclaim state-machine separation |
| 7. Expense Tracking | FR39–FR41 | `convex/expenses.ts`, P2 approval flag |
| 8. Reporting & Dashboards | FR42–FR48 | `convex/dashboards.ts`, `convex/reports.ts`, drill-down via reactive queries, flag-for-followup, P2 audit-log read UI |
| 9. Document Generation | FR49–FR50 | `convex/actions/generate{Contract,DemandLetter}Pdf.ts` reusing PDFKit |
| 10. Interment Scheduling | FR51–FR54 | `convex/interments.ts`, calendar UI route |
| 11. Customer Self-Service | FR55–FR58 | `convex/customerPortal.ts`, `(customer)/` route group, `convex/http.ts` webhooks |
| 12. System Operations, Audit & Compliance | FR59–FR65 | `convex/auditLog.ts` (append-only pattern), `convex/scheduled.ts` reconciliation, `convex/actions/archivalExport.ts`, `piiAccess.ts` data-subject + breach-impact queries, Convex managed encryption-at-rest |

**NFR coverage — 36 / 37 covered, 1 with gap ⚠️**

| Category | NFRs | Architectural support | Gap |
|---|---|---|---|
| Performance | NFR-P1–P7 | Viewport bbox query, `by_bbox_lat` index, Leaflet lazy-load, Tailwind zero-runtime, route-level code split, Lighthouse CI gate | None |
| Security & Privacy | NFR-S1–S8 | Vercel HTTPS, Convex managed at-rest encryption, `readPii` access logging, `requireRole` on all functions, append-only audit log, session-timeout config, `auth_attempts` rate-limit table | None |
| Reliability & Availability | NFR-R1–R6 | Convex managed backups (30-day), reconciliation invariant scheduled function, idempotency keys, PWA staleness UI indicator, monthly archival exports | **⚠️ NFR-R1 (99.5% business-hours uptime) — Convex's currently published SLAs do not clearly meet this on the standard Pro tier. Enterprise tier needed, or NFR-R1 must be downgraded.** |
| Accessibility | NFR-A1–A6 | shadcn/ui + Radix primitives (WCAG-aware), `StatusBadge` color + icon + label, axe-core CI scan, 44px touch targets in mobile components, `aria-live` form errors | None |
| Integration | NFR-I1–I4 | `convex/http.ts` webhook idempotency, action-deferred long work, retry queue in `sendReminder*` actions, Phase-1 zero external deps | None |
| Compliance | NFR-C1–C5 | Receipt counter doc + monotonic-serial test, immutable payment records (mutation pattern), `piiAccess.ts` data-subject query, `piiAccessLog` breach-impact query, customer-consent capture at customer creation | None |
| Maintainability | NFR-M1–M5 | `tsconfig.json` strict, 90% coverage gate on financial code (95% on `postFinancialEvent`), ADRs in `docs/adr/`, `npm run dev:all` < 10 min from clone, cemetery owns Vercel + Convex accounts | None |

### Implementation Readiness Validation

**Decision completeness:**

All critical decisions (auth, RBAC, PDF, money handling, time, state machines, atomicity, idempotency) are documented with explicit rationale, named library / pattern choices, and lint-enforcement where applicable. Versions intentionally not pinned (use `@latest` of well-maintained tools) since the starter command is the first implementation story and locks the versions at install time.

**Structure completeness:**

The project tree names every Phase 1 file an AI agent needs to create. Phase 2 / 3 files marked by phase tags in the requirements-mapping table. The PRD's 65 FRs all map to specific files; no FR is unmoored.

**Pattern completeness:**

14 conflict points addressed with explicit rules. Every "forbidden" pattern paired with the "preferred" pattern + concrete example. Lint rules called out for the patterns enforceable automatically; test rules called out for the patterns verifiable in coverage / behavior.

### Gap Analysis Results

#### Critical gaps (must be resolved before / during Phase 1 week 1)

1. **NFR-R1 uptime SLA mismatch.** The PRD targets 99.5% monthly uptime during cemetery operating hours. Convex Cloud's standard Pro tier does not clearly publish a 99.5%+ SLA at this time — SLAs are largely Enterprise-tier territory. **Resolution path:** either (a) procure Convex Enterprise tier, (b) downgrade NFR-R1 to a best-effort target without contractual SLA, or (c) confirm Convex Pro currently advertises a 99.5%+ figure (re-verify with Convex sales / current pricing page during procurement). Architect's recommendation: option (b) for a single-cemetery freelance build, with the cemetery's Convex contact alerted on the rare Convex incident; document this as an accepted NFR adjustment.
2. **Brief §10 Q3 (BIR receipt modality).** Architecture has designed for the CAS path (most demanding). The receipt template (`docs/bir-receipt-template.md`) is unbuildable without the client's actual format. Lands in the Open Questions Summary as a dev-start gate. **Resolution path:** client questionnaire before Phase 1 week 2.
3. **Brief §10 Q1 (installment grace / penalty / reclaim policy).** State machine transitions, payment-allocation behavior under overdue, default-vs-reclaim distinction, and forfeited-payment record requirement are all gated. **Resolution path:** same client questionnaire as Q3.

#### Important gaps (should be resolved during Phase 1)

1. **UX phase has not run.** Architecture proposed shadcn/ui + React Hook Form + Zod + bespoke `LotMap` UX defaults, but Sally's UX phase has not validated form layouts, map interaction patterns, or the high-contrast outdoor mode. **Resolution path:** UX phase runs in parallel with weeks 1–4 of Phase 1 dev; deliverables refine specific components named in the structure section without changing the architecture itself.
2. **Convex Auth for Phase 1 staff has known limitations** (no MFA, no SMS, no SSO). Per the architecture, this is acceptable for ~10–20 staff users. **Resolution path:** the Phase 3 architectural re-evaluation point (Convex Auth-with-Twilio vs. Better Auth) is already documented.
3. **§10 Q2, Q5, Q6, Q7, Q8, Q9** are schema-finalization gates. Default schema choices are documented (forward-compatible) but final values land in weeks 1–4. **Resolution path:** client questionnaire — same workstream as Q1 / Q3.

#### Minor gaps (nice-to-have)

1. No explicit observability strategy beyond Convex's built-in + Sentry. Sufficient for current scale. Could add Logflare / Better Stack later if log volume exceeds Convex's built-in retention.
2. No explicit error budget framework. Meta-NFR; not blocking. Re-visit at Phase 2 retrospective.
3. No CDN strategy explicitly named for SVG map overlays. Vercel's static-asset CDN handles `public/` automatically — effectively addressed.

### Validation Issues Addressed

- **NFR-R1 (uptime SLA) called out as a critical gap.** Recommendation in Gap Analysis #1 above.
- No other Critical or Important issues found that aren't already documented or already routed through the PRD's Open Questions Summary.

### Architecture Completeness Checklist

**Requirements Analysis**

- [x] Project context thoroughly analyzed (§ Project Context Analysis)
- [x] Scale and complexity assessed (medium complexity, fixed scope)
- [x] Technical constraints identified (stack lock, no SQL / PostGIS, atomicity invariant)
- [x] Cross-cutting concerns mapped (12 concerns)

**Architectural Decisions**

- [x] Critical decisions documented with versions (versions verified via web search; `@latest` at install time)
- [x] Technology stack fully specified (§ Core Architectural Decisions)
- [x] Integration patterns defined (`postFinancialEvent`, state-machine guards, webhook idempotency)
- [x] Performance considerations addressed (viewport queries, indexes, lazy-load, Lighthouse CI)

**Implementation Patterns**

- [x] Naming conventions established (§ Naming Patterns)
- [x] Structure patterns defined (repo layout, test layout, file-organization rules)
- [x] Communication patterns specified (state updates, audit emission, PII access)
- [x] Process patterns documented (loading states, validation timing, retry / idempotency, state-machine guards)

**Project Structure**

- [x] Complete directory structure defined (§ Complete Project Directory Structure)
- [x] Component boundaries established (§ Architectural Boundaries)
- [x] Integration points mapped (§ Integration Points)
- [x] Requirements to structure mapping complete (§ Requirements to Structure Mapping)

**All 16 items checked.**

### Architecture Readiness Assessment

**Overall Status: READY WITH MINOR GAPS.**

All 16 checklist items are checked, but NFR-R1 (uptime SLA) is an open Critical Gap. Since the gap requires a procurement decision (not an architectural one) and has a documented resolution path, the architecture is implementation-ready *contingent on*: (a) NFR-R1 being downgraded or upgraded with Convex Enterprise; (b) brief §10 Q1 and Q3 being answered before Phase 1 week 2.

**Confidence Level: high** on the architecture itself. The cornerstone — `postFinancialEvent` with receipt-counter optimistic concurrency — is the right pattern; the rest follows.

**Key Strengths:**

- Atomicity cornerstone (`postFinancialEvent` + `receiptCounter`) is the right architectural answer to the PRD's financial-integrity NFRs.
- Time-versioned ownership / occupancy is the right answer to FR16–FR18 and brief §10 Q6.
- Schema-ready geometry from day one means the Phase 1 → Phase 2 map swap is a rendering swap, not a data migration.
- Server-side RBAC enforcement (`requireRole` everywhere) plus lint enforcement means NFR-S4 holds even under aggressive code generation.
- Convex-only stack keeps the freelance + single-engineer maintenance surface minimal (Resource Risk #4 mitigated).
- Open questions are gated explicitly at the architecture level — no decision waits silently.

**Areas for Future Enhancement:**

- Pre-aggregated reporting (Phase 1.5 if dashboard latency requires).
- Convex Enterprise tier procurement if NFR-R1 (or audit / compliance) hardens.
- Customer-portal SMS auth via Twilio-action OR Better Auth migration (Phase 3 kickoff).
- Tile provider switch OSM → Mapbox if Phase 2 coverage reveals issues.
- Map renderer Phase 1 (SVG) → Phase 2 (Leaflet) cutover.

### Implementation Handoff

**AI Agent Guidelines:**

- Follow all architectural decisions exactly as documented in earlier sections.
- Use implementation patterns consistently across all components — `requireRole`, `postFinancialEvent`, `emitAudit`, `assertTransition`, `readPii`, `formatPeso`, `formatDate`.
- Respect project structure and boundaries — `convex/lib/` is server-internal, `convex/actions/` is Node-runtime, `(public) / (staff) / (customer)` route groups have separate middleware, PII goes through `readPii` only.
- Refer to this document for all architectural questions before improvising patterns.
- Open the `docs/adr/` folder before changing an architecturally-significant decision; superseded ADRs get a new ADR superseding them, never deleted.

**First Implementation Priority:**

Run the starter command from § Starter Template Evaluation as the first commit. Establish ADR-001 (starter choice). Set up CI pipeline before any feature work.

```bash
npx create-next-app@latest cemetery-mapping \
  --typescript --tailwind --eslint --app --src-dir \
  --use-npm --import-alias "@/*"
cd cemetery-mapping
npm install convex
npx convex dev
```

Implementation order: `requireRole` → `stateMachines` → `audit` → `postFinancialEvent` → schema → first sale flow (Journey 1).
