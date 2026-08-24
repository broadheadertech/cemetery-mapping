# Go-live checklist

- **Status:** open
- **Last updated:** 2026-08-23
- **Deployment today:** `dev:beaming-boar-935` — there is no production deployment yet

This is the list of everything standing between the current branch and a cemetery taking real money through this system. It is organised by **who can clear it**, because the main finding is that most of what remains is not engineering work.

A line is only ticked when someone has verified it against the live deployment. "The code supports it" is not the same as "it is configured."

**`/admin/readiness` answers the machine-checkable half of this list live.** It reads the actual deployment — which gateways have credentials, which environment variables are set, whether the BIR and perpetual-care configs are still placeholders — so you do not need a developer at a terminal to find out. It reports presence only, never a secret's value, and it marks what it cannot see (backups) as uncheckable rather than green. This document stays the authoritative version because it also carries owners, lead times, and the items no query can answer.

---

## Legend

| Owner | Meaning |
| --- | --- |
| **Dev** | Someone with the repo and CLI access |
| **Cemetery** | Apostle Paul Memorial Park / Cases Land Inc. — a decision or a document only they have |
| **Provider** | A third party: BIR, GCash/Maya/the card processor, Resend |

---

## 1. Blocking — money cannot move until these are done

### 1.1 Payment gateway credentials — Cemetery + Provider

Merchant accounts for GCash, Maya, and the card processor, then credentials entered at `/admin/settings/payment-gateways` (or set as env vars).

- [ ] Merchant account approved — GCash
- [ ] Merchant account approved — Maya
- [ ] Merchant account approved — card processor (PayMongo is the standing recommendation; Stripe if international cards are needed)
- [ ] Sandbox credentials entered, one end-to-end payment completed per gateway
- [ ] Webhook endpoint registered with each provider: `https://<deployment>.convex.site/api/<gateway>-webhook`
- [ ] Production credentials swapped in, Mode set to Live

**Until this is done:** the portal's pay button routes to the in-app mock checkout outside production, and refuses outright in production. See runbook § Payment gateways.

**Failure mode to watch:** a missing webhook secret means every callback is rejected — customers pay, nothing lands, and nobody is told. This is the single most expensive misconfiguration in the system. It now surfaces at `/admin/errors` rather than in silence.

### 1.2 BIR receipt configuration — Cemetery + Provider

- [ ] Confirm the registered receipt booklet format: TIN, ATP reference, registered business name, address
- [ ] Accountant reviews and signs off the generated PDF against a real booklet receipt
- [ ] Enter the real values at `/admin/settings/bir-receipt-config` and mark production-ready

**Until this is done:** the receipt PDF action refuses to render while the config is flagged placeholder. No receipts can be issued.

**Scope note:** Phase 1 ships manual-booklet mode per client decision Q3 — no CAS, no Permit-to-Use. Staff enter receipts in both places. If the cemetery wants to retire the paper booklet, that is a 6–10 week BIR procurement effort, not a code change.

### 1.3 Perpetual care policy — Cemetery

- [ ] Confirm the fee structure and amounts, enter at `/admin/settings/perpetual-care`, clear the placeholder flag

**Until this is done:** sales are blocked.

### 1.4 Production deployment — Dev

- [ ] Provision a production Convex deployment (today's is `dev:beaming-boar-935`)
- [ ] Provision hosting for the Next.js front end (no `vercel.json` exists yet)
- [ ] Point `NEXT_PUBLIC_CONVEX_URL` / `CONVEX_DEPLOYMENT` at production
- [ ] Decide the canonical domain — Convex currently says `cemetery.broadheader.com`, `PORTAL_URL` locally says `portal.apostlepaul.ph`. These disagree.

---

## 2. Configuration — the system runs but parts of it are mute

The live deployment currently has **three** environment variables set: `JWKS`, `JWT_PRIVATE_KEY`, `SITE_URL`. Everything below is absent.

| Variable | Owner | What breaks while it is unset |
| --- | --- | --- |
| `RESEND_API_KEY`, `EMAIL_FROM` | Dev + Provider | No email at all: no reminders, no receipts emailed, no enquiry notifications |
| `ENQUIRY_NOTIFY_TO` | Cemetery | Website enquiries queue at `/enquiries` but nobody is emailed. Logged on every submission. |
| `PORTAL_URL` | Dev | Reminder emails link to `https://portal.example.ph` — a dead link in every message |
| `EMAIL_WEBHOOK_SECRET` | Dev + Provider | Bounce events all rejected; hard-bounced addresses keep being emailed |
| `ARCHIVE_S3_*` (5 vars) | Dev | Monthly BIR archival export cannot run — a 10-year retention obligation |

- [ ] All of the above set on the production deployment
- [ ] S3 bucket created with the 10-year lifecycle policy (runbook § Archival exports)

---

## 3. Operational readiness — Dev

- [ ] **Confirm Convex scheduled backups are actually enabled** on the production deployment. This has never been verified; it is a dashboard check nobody has done.
- [ ] **Run one restore drill** and record it in `docs/restore-drill-log.md`. Until this happens the documented procedure is specification, not practice, and NFR-R2's ≤4h RTO is a claim with no evidence. The log's own entry says as much.
- [x] Deploy the schema so the newer tables exist (`errorLog`, `enquiries`, `paymentGatewayConfig`) — pushed to `beaming-boar-935` on 2026-08-23
- [x] Demo seed has run on `beaming-boar-935` (8 lots, 3 customers, 2 contracts, 4 payments, 3 phases). Never run it against real cemetery data.
- [ ] Decide a retention policy for `enquiries` (names and phone numbers of people who never became customers — a Data Privacy Act question) and add a sweep to `convex/crons.ts`

---

## 4. Data migration — Dev + Cemetery

- [ ] Cemetery provides the Excel files and photocopies of the paper records
- [ ] Pilot: import one section (~200 lots) via `/admin/lot-import`, verified row by row with the office
- [ ] Remaining ~1,800 lots imported in section-sized batches, each signed off
- [ ] GPS survey delivered and applied via `/admin/gps-import`

**Scope note:** legacy *sold* lots import as `available` by design (client decision Q4) — the sale is re-recorded through the sale form when the owner comes in to verify, so every peso in the ledger has a contract and a receipt behind it. Occupancy imports as-is. Owners, contracts, and payment history are **not** bulk-imported.

---

## 5. Content and sign-off — Cemetery

- [ ] **Confirm the public phone number and email.** `+63 (72) 562-0187` and `care@apostlepaul.ph` came from the marketing draft and have never been verified. They are now the documented fallback on a bereavement page and the only route to locating a grave — an unanswered number there is worse than no number.
- [ ] Confirm the postal address and that **Cases Land Inc.** is the correct legal entity for receipts and contracts
- [ ] Final logo asset — the current SVG is a placeholder
- [ ] **Decide whether occupant names should be publicly searchable** with no login. Until then `/find-a-grave` offers "call the office and we will look it up" rather than a search box. This is a Data Privacy Act decision about the deceased and their families, not a technical one; the four steps to build it are in `FindGraveSearch.tsx`.
- [ ] Someone is named as the owner of the `/enquiries` queue. Every row is a person who was told we would call them.

---

## 6. Deferred by decision — not blockers

- **SMS reminders** (story 9-7) — deferred to Phase 2; email only at launch.
- **CAS / BIR Permit-to-Use** — manual booklet mode is the Phase 1 decision.
- **Public grave search** — see 5 above.
- **Mobile app** — spec and epics exist under `_bmad-output/planning-artifacts/`; nothing built.

---

## 7. Process

- [ ] All 75 stories are at `review` in `sprint-status.yaml`; none are `done`. Someone has to accept them.
- [ ] Epic retrospectives are marked optional and none have run.

---

## What is genuinely finished

Worth stating, because the list above is long and one-sided:

- 2,850+ unit tests, typecheck, lint, bundle-size and Lighthouse budgets all green in CI.
- The financial cornerstone (`postFinancialEvent`), receipt serial allocation, AR aging, reconciliation invariants, and the audit log.
- Role enforcement server-side on every function, PII access logging, PII redaction in the audit trail.
- Error log surfacing production failures that were previously silent.
- Bulk lot import, GPS geometry import, and the customer portal.

The gap is not the application. It is credentials, a BIR conversation, a hosting decision, and a handful of answers only the cemetery can give.
