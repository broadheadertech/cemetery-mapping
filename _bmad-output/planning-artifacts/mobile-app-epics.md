---
stepsCompleted: ['step-01-validate-prerequisites', 'step-02-design-epics', 'step-03-create-stories']
lastStep: 3
status: 'draft'
inputDocuments:
  - _bmad-output/planning-artifacts/mobile-app-spec.md
  - _bmad-output/planning-artifacts/architecture.md
  - _bmad-output/planning-artifacts/epics.md
workflowType: 'epics-and-stories'
project_name: 'cemetery-mapping — mobile companion app'
date: '2026-08-20'
---

# Mobile Companion App — Epic Breakdown

Decomposes [mobile-app-spec.md](mobile-app-spec.md) into implementable stories.
Story numbering is `M<epic>.<story>` so it never collides with the existing web
backlog in [epics.md](epics.md).

**Read the spec first.** This document assumes its §2 inventory (what the backend
already provides), §4–§6 feature rules, and §8 backend surface. Stories here carry
acceptance criteria and sequencing; they do not restate the rules.

---

## Requirements inventory

Numbered `MFR*` (mobile functional) and `MNFR*` (mobile non-functional) to stay
distinct from the web app's `FR*` series.

### Functional

**1. Identity**

- **MFR1:** A customer can authenticate in the app with the credentials they already use for the web portal. [W1]
- **MFR2:** The app persists the session across cold starts in device secure storage. [W1]
- **MFR3:** A customer can redeem a portal invite link on a device and land signed in. [W2]
- **MFR4:** A customer can sign out, which revokes the device's push token. [W6]

**2. Browse & 3D**

- **MFR5:** A customer can browse available lots filtered by section, type, price band, and status. [W2]
- **MFR6:** A customer can view a lot's detail — section copy, dimensions, price, status. [W2]
- **MFR7:** A customer can explore the park as a 3D scene driven by live lot data. [W3]
- **MFR8:** A customer can view a single lot in situ among its neighbours and share that view as an image. [W3]
- **MFR9:** Lots with placeholder geometry are visually distinguished from surveyed lots. [W3]
- **MFR10:** The app falls back to a list view when GL initialisation fails. [W3]

**3. Reservation**

- **MFR11:** A customer can place a deposit-backed, time-boxed hold on an available lot. [W3–4, gated on Q1, Q3, Q6]
- **MFR12:** A hold is created only after the payment gateway confirms the reservation fee. [W4]
- **MFR13:** A customer can view and cancel their own active holds. [W4]
- **MFR14:** A hold past its expiry is released automatically and the lot returns to inventory. [W4]
- **MFR15:** Office staff can see every active hold, extend one, and convert one to a contract. [W4]
- **MFR16:** A reservation fee paid against a lot that was taken first is refunded automatically. [W4]

**4. Booking**

- **MFR17:** A customer can see available ceremony slots for a chosen date on a lot they own. [W5, gated on Q2, Q4]
- **MFR18:** A customer can request an interment, consecration, or memorial anniversary. [W5]
- **MFR19:** A customer can cancel their own request while it is pending review. [W5]
- **MFR20:** Office staff can confirm, adjust, or decline a request from the web app. [W5]
- **MFR21:** Confirmation routes through the existing `scheduleCeremony` guard. [W5]

**5. Engagement & retrieval**

- **MFR22:** A customer receives push notifications for due installments, hold expiry, and ceremony outcomes. [W6]
- **MFR23:** Any visitor can look up a grave by name and receive walking guidance to it. [W6]
- **MFR24:** A customer can read and download their contracts, receipts, and uploaded documents. [W6]
- **MFR25:** A customer can request a callback from a consultant. [W6]
- **MFR26:** A secondary estate owner can read the estate, its ceremonies, and its documents. [W6]
- **MFR27:** A contract owner can publish a tribute to an occupant. [Overflow]

### Non-functional

- **MNFR1:** Cold start to interactive under 3 s on the reference mid-range Android device.
- **MNFR2:** 3D holds ≥30fps on the reference device with a full section visible; <60 draw calls.
- **MNFR3:** Owned lots, contracts, and receipts remain readable offline with a "last updated" stamp.
- **MNFR4:** Every mobile-facing Convex function is role-gated, ownership-scoped server-side, and audited.
- **MNFR5:** Session tokens live in Keychain / Keystore, never AsyncStorage.
- **MNFR6:** Push payloads carry ids only — never names, amounts, or contact details.
- **MNFR7:** Touch targets ≥44×44pt; dynamic type to 200%; 4.5:1 contrast; screen-reader labels on every control.
- **MNFR8:** All copy passes through `t()` with no inline string literals.
- **MNFR9:** Both stores' data-safety declarations match the app's actual collection.

---

## Epic list

| Epic | Title | Weeks | Depends on |
|---|---|---|---|
| **M0** | Release prerequisites (non-engineering) | W0, runs throughout | — |
| **M1** | Mobile foundation & customer identity | W1–W2 | M0.1 for device builds |
| **M2** | Browse & 3D displays | W2–W3 | M1 |
| **M3** | Online reservation | W3–W4 | M1, M2.2, Q1/Q3/Q6 answered |
| **M4** | Online booking | W5 | M1, Q2/Q4 answered |
| **M5** | Engagement & retrieval | W6 | M1 |
| **M6** | Hardening & release | W7–W8 | all above |

**Critical path:** M1.2 (auth spike) → M1.4 (app shell) → M2.2 (scene extraction) → M3.3 (hold transaction) → M6.5 (store submission). Everything else has slack.

**Gates.** M3 cannot start its payment stories until Q1 (fee refund policy) and Q6 (BIR receipt timing) are answered. M4 cannot ship its slot rules until Q2 (lead time) and Q4 (blackout dates) are answered. Both gates are named in the spec §12 with the weeks they bite.

---

## Epic M0: Release prerequisites [W0]

Not engineering work, but it blocks shipping and has the longest lead time in the
project. Tracked as stories so it has an owner and a due date.

### Story M0.1: Apple and Google developer accounts exist

As the project owner,
I want organisation accounts on both app stores,
So that the team can distribute test builds from week 4 and submit in week 7.

**Acceptance Criteria:**

**Given** Cases Land Inc. has no D-U-N-S number,
**When** the owner requests one from Dun & Bradstreet,
**Then** the number is obtained and recorded before Apple Developer Program enrolment is submitted.

**Given** enrolment is submitted,
**When** Apple completes its review,
**Then** the team can create an App Store Connect record and push a TestFlight build.

**Given** the accounts are created,
**When** ownership is recorded,
**Then** it is explicit whether Cases Land Inc. or the agency holds them (spec Q9) — transferring a published app later is painful.

*Blocks:* every device-distributed build. *Risk:* spec R2. *Start day one.*

### Story M0.2: Privacy policy and terms are published

**Given** both stores require a public privacy policy URL,
**When** the policy is drafted against RA 10173 and what the app actually collects,
**Then** it is published at a stable URL and linked from the app's account screen.

**Given** the app collects foreground location for wayfinding,
**When** the policy is written,
**Then** it names that purpose specifically rather than in a general clause.

### Story M0.3: Gateway sandbox credentials cover the mobile redirect

**Given** the app returns from hosted checkout via a deep link,
**When** the redirect URL scheme is registered with GCash, Maya, and the card provider,
**Then** a sandbox payment completes the full round-trip from app to gateway to webhook to app.

*Do this in week 4, not week 7 — spec R6.*

### Story M0.4: Store listing assets exist

**Given** the brand system defines logo, palette, and typography,
**When** the icon, splash, and screenshots are produced,
**Then** they honour the four voice pillars and contain no urgency or promotional language.

---

## Epic M1: Mobile foundation & customer identity [W1–W2]

Expo scaffold, the auth spike that de-risks everything downstream, the brand token
module, navigation, and the read-only "my estate" surface built entirely on Convex
functions that already exist.

### Story M1.1: Expo project boots on both platforms

As a developer,
I want a running Expo app wired to the existing Convex deployment,
So that feature work has somewhere to land.

**Acceptance Criteria:**

**Given** a clean clone,
**When** the developer runs the documented setup,
**Then** the app builds and runs on an iOS simulator and an Android emulator in under 10 minutes.

**Given** the app is running,
**When** it connects to `beaming-boar-935`,
**Then** a smoke query resolves and the connection state is visible in a debug screen.

**Given** `convex/_generated` is not committed,
**When** the app calls a Convex function,
**Then** it uses `makeFunctionReference` exactly as the web client does — no codegen step is introduced.

**Given** the repo's TypeScript settings,
**When** the mobile `tsconfig` is written,
**Then** `noUncheckedIndexedAccess` and strict mode are on, matching the web app.

### Story M1.2: Customer authentication works on device — SPIKE FIRST

As a customer,
I want to sign in with the credentials I already use for the portal,
So that I do not need a second account.

**Acceptance Criteria:**

**Given** `@convex-dev/auth` has not been exercised on React Native in this project,
**When** the spike runs at the start of week 1,
**Then** it produces a written answer on token storage, refresh on cold start, and deep-link return after an external browser round-trip — **before** any feature work depends on it.

**Given** a customer with an existing portal account,
**When** they sign in on the app,
**Then** `getCurrentCustomer` resolves and their name appears on the account screen.

**Given** a signed-in customer,
**When** they force-quit and relaunch,
**Then** they remain signed in, with the token read from `expo-secure-store` (MNFR5).

**Given** the spike finds the library path unworkable,
**When** the fallback is adopted,
**Then** a short-lived single-use mobile session token is minted by a Convex mutation from the existing web session, and the decision is recorded as an ADR.

**Given** a user whose role is not `customer`,
**When** they sign in,
**Then** they are told the app is for families and staff should use the web app — not shown an empty shell.

*Risk:* spec R1. *This is the single highest-leverage story in the backlog.*

### Story M1.3: Brand tokens are available to the app

**Given** `tailwind.config.ts` is the single token source,
**When** the token module is generated,
**Then** the app consumes emerald, forest, moss, ivory, stone, gold, and ink from that derived module — no hand-copied hex values.

**Given** the brand rations gold to hairline rules and the mark,
**When** a component uses gold as a fill,
**Then** review rejects it.

**Given** the type system,
**When** headings, body, and lot codes render,
**Then** they use Cormorant Garamond, Manrope, and JetBrains Mono respectively, with real fallback stacks.

### Story M1.4: App shell, navigation, and copy pipeline

**Given** the app has four top-level destinations (Explore, My Estate, Find a Grave, Account),
**When** the shell is built with `expo-router`,
**Then** each tab is reachable, labelled for screen readers, and has a ≥44×44pt target (MNFR7).

**Given** MNFR8,
**When** any string renders,
**Then** it comes from `t()`; a lint rule fails the build on inline user-facing literals.

**Given** a screen has no data,
**When** it renders,
**Then** it shows a written empty state in the park's voice — never a spinner that never resolves.

### Story M1.5: Portal invite redemption on device

**Given** a customer receives a portal invite email,
**When** they open the link on a phone with the app installed,
**Then** the deep link opens the app at the accept-invite screen and `acceptPortalInvite` completes.

**Given** the app is not installed,
**When** they open the link,
**Then** they land on the existing web accept-invite page — the web flow is not broken by adding the deep link.

**Given** an expired or already-used token,
**When** it is opened,
**Then** the app explains what happened and offers to contact the office.

### Story M1.6: "My estate" read surface

As a customer,
I want to see my contracts, payments, and receipts,
So that the app is useful from the first release even before reservation ships.

**Acceptance Criteria:**

**Given** the existing `listCustomerContracts`, `getCustomerContractDetail`, `listCustomerPayments`, and `listCustomerReceipts` queries,
**When** the screens are built,
**Then** no new backend function is written for this story.

**Given** money values arrive as integer centavos,
**When** they render,
**Then** they are formatted with a port of `formatPeso` — rounding is not reimplemented.

**Given** an installment contract,
**When** the detail screen renders,
**Then** it shows the next due date and remaining installments; a full-payment contract shows neither.

**Given** a crafted contract id belonging to another customer,
**When** the app requests it,
**Then** the handler returns `null` and the screen shows a not-found state — existence does not leak.

### Story M1.7: In-app installment payment

**Given** `createGatewayPaymentIntent` already exists,
**When** a customer pays an installment from the app,
**Then** the hosted checkout opens via `expo-web-browser` and the result returns through the deep link.

**Given** a payment succeeds,
**When** the webhook lands,
**Then** the contract balance updates reactively on the open screen without a manual refresh.

**Given** the customer backgrounds the app mid-checkout,
**When** they return,
**Then** the intent's live status resolves the screen — a stale "pending" never sticks.

---

## Epic M2: Browse & 3D displays [W2–W3]

The features that justify a native app. Story M2.2 is a refactor of working web code
and must land before the mobile scene starts.

### Story M2.1: Browse and filter reservable lots

**Given** a customer opens Explore,
**When** the list loads,
**Then** it shows available lots filtered by section, type (`single` / `family` / `mausoleum` / `niche`), price band, and status.

**Given** the park has 2,000+ lots,
**When** the list renders,
**Then** results are paginated and the payload omits full polygon arrays — the list does not need geometry.

**Given** a lot's status changes in the web app,
**When** the customer is looking at the list,
**Then** it updates reactively.

### Story M2.2: Extract the shared 3D scene module

As a developer,
I want scene construction to live in one platform-neutral module,
So that web and mobile render the same park from the same code.

**Acceptance Criteria:**

**Given** `Phase3DMap.tsx` currently holds scene construction inside a mount effect,
**When** the extraction lands,
**Then** `src/lib/scene3d/` exports `buildParcelScene`, `statusMaterials`, and `pickLotAtPointer` with no DOM or React Native imports.

**Given** the extraction,
**When** the web `/phase-3d` route is loaded,
**Then** it renders identically to before — verified by the existing checks plus a visual pass.

**Given** the module is platform-neutral,
**When** it is imported from the Expo app,
**Then** it compiles without a bundler shim.

*Blocks:* M2.3, M2.4, M2.5.

### Story M2.3: 3D park scene renders on device

**Given** the shared scene module,
**When** the mobile shell mounts it in an `expo-gl` view,
**Then** the park renders from live `lots` data with status colouring (MFR7).

**Given** 2,000+ lots,
**When** the scene builds,
**Then** lots are drawn with `THREE.InstancedMesh` — one instanced draw per type × status — and total draw calls stay under 60 (MNFR2).

**Given** the reference mid-range Android device,
**When** a full section is in view,
**Then** the scene sustains ≥30fps.

**Given** the camera moves,
**When** new lots enter the frustum,
**Then** they load via `listInBbox` rather than a full-park fetch.

**Given** the app is backgrounded and resumed,
**When** the GL context is lost and restored,
**Then** the scene rebuilds without a crash.

### Story M2.4: Touch camera and lot selection

**Given** OrbitControls binds DOM events and cannot be used,
**When** the gesture handler is wired,
**Then** one finger orbits, two fingers pan and pinch-zoom, and a double-tap frames a lot.

**Given** a customer taps a lot,
**When** the raycast resolves,
**Then** the lot is selected, highlighted, and its detail is reachable — with a hit target that tolerates a fat finger.

**Given** section labels cannot be DOM nodes,
**When** they render,
**Then** they are `THREE.Sprite` textures that occlude correctly.

### Story M2.5: Lot in situ, and sharing it

**Given** a lot detail screen,
**When** the in-situ view opens,
**Then** the camera frames that lot among its neighbours with the monument mass shown for its type (MFR8).

**Given** a customer wants to show family abroad,
**When** they tap share,
**Then** the GL view is captured to a PNG and handed to the system share sheet.

**Given** a lot with `geometryStatus === "placeholder"`,
**When** it renders,
**Then** it is visibly provisional — translucent and hatched — because showing an unsurveyed lot as surveyed is a promise the park cannot keep (MFR9).

### Story M2.6: Graceful degradation without GL

**Given** a device where GL initialisation fails,
**When** the customer opens Explore,
**Then** a list view renders with the same filters and no error dialog (MFR10).

**Given** no network,
**When** the scene opens,
**Then** the last cached lots render with a "last updated" stamp rather than an empty scene.

---

## Epic M3: Online reservation [W3–W4]

The largest new backend surface, and the one where correctness is money. **Gated on
Q1 and Q6** — do not build the fee stories until the refund policy and the BIR receipt
timing are answered.

### Story M3.1: `lotReservations` schema and state machine registration

**Given** spec §8.1,
**When** the table is added,
**Then** it carries the six-literal status union, both expiry timestamps, the payment-intent FK, the refund status, and all five indexes.

**Given** ADR-0006 makes the state machine the single source of truth for lot status,
**When** reservation-driven transitions are added,
**Then** they are registered there — no raw `db.patch` on `lots.status` anywhere in the reservation path.

**Given** ADR-0004,
**When** the `auditLog.entityType` union is extended,
**Then** it gains `"reservation"` so per-reservation `by_entity` lookups work.

### Story M3.2: Customer creates a reservation intent

**Given** an available, non-retired lot,
**When** a customer requests a reservation,
**Then** a `pending_payment` row is created with a 15-minute `intentExpiresAt` and a gateway checkout URL is returned.

**Given** a customer already holding three active reservations,
**When** they request a fourth,
**Then** the mutation refuses server-side with a message that explains the cap.

**Given** a lot that is reserved, sold, occupied, or retired,
**When** a reservation is requested,
**Then** it is refused server-side — not merely hidden in the UI.

**Given** the lot is not held yet at this point,
**When** another customer views it,
**Then** it still shows as available — the hold happens at confirmation, not here.

### Story M3.3: The hold transaction

As the system,
I want a lot held exactly once,
So that two families paying at the same moment cannot both own the same grave.

**Acceptance Criteria:**

**Given** a gateway webhook confirming a reservation fee,
**When** `confirmReservationFromWebhook` runs,
**Then** it re-reads the lot inside the mutation, checks the status, transitions to `reserved`, sets `holdExpiresAt`, and emits an audit row — all in one serializable transaction.

**Given** two confirmations for the same lot arrive concurrently,
**When** both mutations run,
**Then** exactly one produces a `held` reservation and the other produces `abandoned` with `failureReason: "lot_taken"`.

**Given** a reservation is `abandoned` for `lot_taken`,
**When** the mutation completes,
**Then** a refund action is scheduled immediately and a staff alert is raised.

**Given** the customer whose payment lost the race,
**When** they open the app,
**Then** they see a notice in the park's voice: the lot was taken moments before their payment completed, and their fee is being returned in full.

*Risk:* spec R5. *Load-test this in week 7.*

### Story M3.4: Webhook routing distinguishes reservation fees from installments

**Given** `convex/http.ts` currently routes every confirmed intent to the installment path,
**When** reservation intents are introduced,
**Then** the handler dispatches on intent kind and reservation fees never post as installment payments.

**Given** this modifies a financial cornerstone,
**When** the change is proposed,
**Then** it gets a dedicated review before merge.

**Given** a webhook arrives twice for the same intent,
**When** it is processed,
**Then** the second is a no-op — exactly-once semantics hold.

### Story M3.5: Holds expire on their own

**Given** a `pending_payment` row past `intentExpiresAt`,
**When** the 5-minute cron runs,
**Then** it is marked `abandoned` and no lot status changed (none was held).

**Given** a `held` reservation past `holdExpiresAt`,
**When** the 15-minute cron runs,
**Then** the lot returns to `available` through the state machine, an audit row is emitted, and the customer is notified (MFR14).

**Given** a hold approaching expiry,
**When** the daily cron runs,
**Then** the customer is notified at T-3 days and T-1 day.

*This story is on the never-cut list. A hold that cannot expire silently destroys inventory.*

### Story M3.6: Customer views and cancels their holds

**Given** a customer with active holds,
**When** they open My Estate,
**Then** each hold shows the lot, the days remaining, and what happens next.

**Given** a customer cancels their own hold,
**When** the mutation runs,
**Then** the lot returns to `available` immediately and the refund status follows the Q1 policy.

**Given** a hold belonging to another customer,
**When** its id is requested,
**Then** the handler returns `null`.

### Story M3.7: Reservation flow UI

**Given** a customer on a lot detail screen,
**When** they choose to reserve,
**Then** the review step states the fee, the hold duration, and the refund policy in plain language, with an explicit consent checkbox.

**Given** the review screen,
**When** copy is reviewed,
**Then** it contains no scarcity language, no countdown styled as pressure, and no exclamation marks.

**Given** the checkout sheet is open,
**When** another customer's hold lands on the same lot,
**Then** the live status updates in front of the customer before they pay.

**Given** the payment fails or is abandoned,
**When** the customer returns,
**Then** the result screen explains plainly and offers to try again.

### Story M3.8: Staff holds queue on the web app

**Given** office staff open the new holds screen,
**When** it loads,
**Then** every active hold is listed with customer, lot, expiry, and source.

**Given** a family needs more time,
**When** staff extend a hold,
**Then** the extension is once only, +7 days, with a required reason, and it is audited.

**Given** a family completes a purchase,
**When** staff convert the hold,
**Then** a contract is created, the reservation becomes `converted`, and the fee is credited to the first payment.

*Without this screen the app's holds land nowhere. It ships in the same week as M3.7.*

---

## Epic M4: Online booking [W5]

**Gated on Q2 and Q4.** Customers request; staff confirm. The authoritative conflict
check stays where it already is.

### Story M4.1: `ceremonyRequests` schema

**Given** spec §8.1,
**When** the table is added,
**Then** it carries the five-literal status union, the requested slot, chapel and pathway flags, the optional deceased name as encrypted PII (ADR-0007), and the resulting `ceremonyId`.

**Given** ADR-0004,
**When** the audit union is extended,
**Then** it gains `"ceremony_request"`.

### Story M4.2: Available slots query

**Given** a customer picks a date,
**When** `getAvailableSlots` runs,
**Then** it returns open windows accounting for existing ceremonies, chapel and pathway occupancy, park operating hours, blackout dates, and the lead-time floor.

**Given** the query is advisory only,
**When** its logic is written,
**Then** it calls the same primitives as `assertNoBookingConflict` rather than reimplementing overlap rules — the authoritative check must not drift from the advisory one.

**Given** Nov 1–2 and any park-defined closure,
**When** they are configured in `appSettings`,
**Then** no slot is offered on those dates.

### Story M4.3: Customer requests a ceremony

**Given** a customer with an active contract on a lot,
**When** they submit a request,
**Then** a `pending_review` row is created, staff are notified, and **no `ceremonies` row is written**.

**Given** a customer without ownership of the lot,
**When** they attempt a request,
**Then** it is refused server-side.

**Given** a secondary owner on the lot's family estate,
**When** they submit a request,
**Then** it is accepted.

**Given** a request inside the lead-time floor or on a blackout date,
**When** it is submitted,
**Then** it is refused server-side with a plain explanation.

**Given** notes exceed the ceremony notes limit,
**When** the form is submitted,
**Then** validation refuses it with the same bound the web app enforces.

### Story M4.4: Customer tracks and cancels a request

**Given** a pending request,
**When** the customer opens it,
**Then** they see its status and the stated response commitment — "The Estate Office will confirm within one business day".

**Given** a pending request,
**When** the customer cancels it,
**Then** it moves to `cancelled_by_customer` and staff are notified.

**Given** a confirmed ceremony,
**When** the customer opens it,
**Then** cancellation is not offered in-app; they are directed to contact the office.

### Story M4.5: Staff confirm, adjust, or decline

**Given** the request queue on the web app,
**When** staff confirm a request,
**Then** `scheduleCeremony` is called and its `assertNoBookingConflict` guard runs as the authoritative check (MFR21).

**Given** confirmation raises `SCHEDULING_CONFLICT`,
**When** the error is handled,
**Then** the request returns to the family with a plain-language explanation and alternative slots — never a raw error code.

**Given** staff adjust the slot,
**When** the family is notified,
**Then** the notice states what changed and why.

**Given** staff decline,
**When** they submit,
**Then** a reason is required and it is surfaced to the family.

**Given** a request pending longer than one business day,
**When** the ageing check runs,
**Then** staff are alerted — an unanswered booking queue is worse than not shipping the feature (spec R8).

### Story M4.6: Confirmed ceremony detail

**Given** a confirmed ceremony,
**When** the customer opens it,
**Then** they see date, time, section wayfinding, add-ons, and an add-to-device-calendar action.

---

## Epic M5: Engagement & retrieval [W6]

Cheap features with high value, because the backend for most of them already exists.

### Story M5.1: Push token registration

**Given** a signed-in customer,
**When** they grant notification permission,
**Then** an Expo push token is stored against their user with platform and device name.

**Given** a customer signs out,
**When** the session ends,
**Then** the token is revoked (MFR4).

**Given** MNFR6,
**When** any push payload is constructed,
**Then** it carries ids only — never names, amounts, or contact details.

### Story M5.2: Push becomes a fourth reminder channel

**Given** the existing reminder cron and `reminderDeliveries`,
**When** push is added,
**Then** it slots in beside email and SMS rather than becoming a parallel scan.

**Given** an installment due in 7 days, due today, or 3 days overdue,
**When** the scan runs,
**Then** the customer receives one push per rule offset — the existing exactly-once dedup applies.

**Given** a ceremony is confirmed, adjusted, or declined,
**When** the mutation completes,
**Then** the family is pushed.

**Given** a hold approaches expiry,
**When** the daily cron runs,
**Then** the customer is pushed at T-3 and T-1.

### Story M5.3: Find a grave, with walking guidance

**Given** any visitor — signed in or not,
**When** they search a name,
**Then** `findGrave` resolves it to a lot and shows the section, block, and row.

**Given** the visitor grants foreground location,
**When** they choose to walk there,
**Then** the app shows a bearing and distance to the lot centroid, updating as they move.

**Given** location permission is denied,
**When** the screen renders,
**Then** it still shows the lot on the section map with written directions from the gate.

**Given** MNFR3,
**When** the visitor has no signal at the park,
**Then** the cached section map and the resolved lot still render.

*This is the app's best acquisition surface — it works for people who are not customers.*

### Story M5.4: Document vault

**Given** a customer's contracts, receipts, and uploaded documents,
**When** they open the vault,
**Then** every document is listed, openable, and downloadable through the existing auth-gated URL mutations.

**Given** a receipt PDF has not been generated yet,
**When** the customer requests it,
**Then** `requestCustomerReceiptPdf` runs and the screen resolves when it is ready.

**Given** no network,
**When** the vault opens,
**Then** previously opened documents are readable from cache.

### Story M5.5: Callback request

**Given** a customer looking at a lot,
**When** they request a callback,
**Then** a `followUpActions` row is created and appears in the queue staff already work.

**Given** the request form,
**When** it renders,
**Then** it asks only what staff need to call back — no lead-capture interrogation.

### Story M5.6: Family sharing

**Given** a customer who is a secondary owner on a family estate,
**When** they open My Estate,
**Then** they see the estate, its lots, its ceremonies, and its documents — read-only.

**Given** a secondary owner,
**When** they attempt a payment or a reservation on the estate,
**Then** it is refused server-side; those remain the primary owner's actions in v1.

### Story M5.7: Tributes [Overflow — first to be cut]

**Given** an occupant record,
**When** a contract owner publishes a tribute,
**Then** it appears on the occupant's memorial page with their name and dates.

**Given** a user who is neither a contract owner nor a secondary estate owner,
**When** they attempt to publish,
**Then** it is refused server-side.

**Given** a published tribute,
**When** staff review it,
**Then** they can unpublish it with a logged reason.

---

## Epic M6: Hardening & release [W7–W8]

### Story M6.1: Offline reading

**Given** MNFR3,
**When** the app has no connection,
**Then** owned lots, contracts, receipts, and the section map render from cache with an explicit "last updated" stamp.

**Given** a queued write,
**When** connectivity returns,
**Then** it replays — **except** a reservation, which is never written optimistically offline because it needs a live transaction.

**Given** ADR-0009 already sets the web cache strategy,
**When** the mobile strategy is written,
**Then** it follows the same shape rather than inventing a second one.

### Story M6.2: Performance budgets in CI

**Given** MNFR1 and MNFR2,
**When** the mobile performance job runs,
**Then** cold-start and 3D frame-rate budgets are asserted against the reference device profile and the build fails when they regress.

**Given** ADR-0016 gates the web app's budgets,
**When** the mobile equivalent is added,
**Then** it reports in the same place.

### Story M6.3: Accessibility pass

**Given** MNFR7,
**When** the audit runs,
**Then** every control has a screen-reader label, targets are ≥44×44pt, dynamic type scales to 200% without clipping, and contrast is ≥4.5:1.

**Given** gold is an accent,
**When** any text relies on it to carry meaning,
**Then** the audit fails it.

**Given** a customer using the app in grief,
**When** copy is reviewed,
**Then** clarity is preferred over cleverness everywhere.

### Story M6.4: Security and privacy review

**Given** MNFR4,
**When** every new mobile-facing function is reviewed,
**Then** each has `requireRole` as its first awaited line, derives ownership server-side, and emits an audit row.

**Given** MNFR6,
**When** crash reporting is configured,
**Then** PII is scrubbed from breadcrumbs and payloads.

**Given** the existing threat model,
**When** the mobile surface is added,
**Then** `docs/threat-model.md` covers device token theft, deep-link hijacking, and push payload leakage.

**Given** RA 10173,
**When** onboarding runs,
**Then** consent is explicit and data-subject export and deletion route through the existing `dataSubject.ts`.

### Story M6.5: Store submission

**Given** MNFR9,
**When** the data-safety and privacy declarations are filed,
**Then** they match what the app actually collects — verified against the code, not the intent.

**Given** spec R7,
**When** the build is submitted,
**Then** review notes pre-emptively explain that cemetery lots and interment services are real-world goods and services consumed outside the app.

**Given** a rejection,
**When** feedback arrives,
**Then** week 8 has room to fix and resubmit.

### Story M6.6: Runbook and staff training

**Given** the runbook covers web operations only,
**When** mobile ships,
**Then** it gains mobile release, rollback, and push-notification incident response.

**Given** office staff will work two new queues,
**When** training happens,
**Then** it is in week 6 alongside the beta — not week 8 alongside launch (spec R8).

---

## Story count and shape

| Epic | Stories | Weeks |
|---|---|---|
| M0 Release prerequisites | 4 | W0 |
| M1 Foundation & identity | 7 | W1–W2 |
| M2 Browse & 3D | 6 | W2–W3 |
| M3 Reservation | 8 | W3–W4 |
| M4 Booking | 6 | W5 |
| M5 Engagement | 7 (1 Overflow) | W6 |
| M6 Hardening & release | 6 | W7–W8 |
| **Total** | **44** | **8 weeks + W0** |

Roughly 15 of the 44 are Convex backend stories, which is the §2.2 finding expressed
as a backlog: this is not a project that wraps an existing portal.

## De-scope ladder

If week 5 slips, cut in this order:

1. **M5.7** tributes → Phase 2.
2. **M5.6** family sharing → Phase 2.
3. **M2.5** reduces to two 3D views — park overview and lot in situ — dropping the section view.
4. **M4** ships iOS-first; Android follows two weeks later.

**Never cut:** M3.5 (hold expiry), M3.3 (the hold transaction and its refund path),
M6.4 (security and privacy), or the audit emission inside any mutation. These are the
ones that cost real families real money.
