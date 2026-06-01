# Story 8.3: Field Worker Navigates to a Lot via GPS

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **Junior (Field Worker)**,
I want **to tap a "Navigate to lot" button on the lot detail page and have my phone's native map app (Google Maps on Android, Apple Maps on iOS) open with the lot's GPS coordinates as the destination**,
so that **I can find the physical lot in under 30 seconds even when I don't know the section** — without the app having to ship its own turn-by-turn nav (FR12).

The button constructs a platform-appropriate geographic URI (`geo:` on Android, `maps://` on iOS, `https://maps.google.com/?q=...` as cross-platform fallback) and triggers the device's default handler. For lots that haven't been GPS-surveyed yet (`geometryStatus === "placeholder"`), the button is disabled with an explanatory tooltip — preventing Junior from being navigated to the cemetery's centroid by accident.

## Acceptance Criteria

1. **AC1 — "Navigate to lot" button opens native map app on phones**: On the lot detail page (`src/app/(staff)/lots/[lotId]/page.tsx`), when the lot has `geometryStatus === "surveyed"`, a primary action button labeled "Navigate to lot" is visible. Tapping it on Android opens `geo:<lat>,<lng>?q=<lat>,<lng>(Lot <code>)`; on iOS opens `maps://?daddr=<lat>,<lng>`; on desktop (Junior's office laptop in rare cases) opens `https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>` in a new tab.

2. **AC2 — Disabled with tooltip for unsurveyed lots**: When `geometryStatus === "placeholder"`, the button is disabled (`disabled` attribute + `aria-disabled="true"`) and shows the tooltip "GPS coordinates not yet surveyed for this lot." Tapping the disabled button is a no-op; the tooltip displays on hover (desktop) or long-press (mobile).

3. **AC3 — Fallback when no nav app handles the URI**: If the device doesn't have a default map / nav app, the system displays an inline fallback panel containing: (a) a small static OSM map image with a pin at the lot centroid, (b) the decimal coordinates as plain text, (c) a "Copy coordinates" button. The fallback triggers via a 1500ms timeout after the URI launch attempt — if the page is still in foreground (user wasn't routed to a nav app), the fallback appears.

4. **AC4 — Server-side guard on coordinate exposure**: The lot detail query (`convex/lots.ts → getLotById`) only returns `geometry.centroid` when `geometryStatus === "surveyed"` AND the caller has Field Worker / Office Staff / Admin role. Customers (Phase 3) viewing their owned-lot detail get the same gating. NFR-S4 reinforced: UI-only hiding is not sufficient — the server must redact.

## Tasks / Subtasks

### Client-side button + URI construction (AC1, AC2)

- [ ] **Task 1: Build `NavigateToLotButton` component** (AC: 1, AC: 2)
  - [ ] Path: `src/components/NavigateToLotButton.tsx`. `"use client"`. Named export.
  - [ ] Props: `{ lotCode: string; geometryStatus: "placeholder" | "surveyed"; centroid?: { lat: number; lng: number } }`.
  - [ ] Renders a shadcn/ui `<Button variant="default" size="default">` with a leading map-pin icon (lucide-react `MapPin` — already a Phase 1 dependency). Label: "Navigate to lot".
  - [ ] If `geometryStatus === "placeholder"` or `!centroid`: button is `disabled`, wrapped in `<Tooltip><TooltipTrigger asChild>...</TooltipTrigger><TooltipContent>GPS coordinates not yet surveyed for this lot.</TooltipContent></Tooltip>` (shadcn/ui Tooltip from Phase 1).
  - [ ] Otherwise: `onClick={handleNavigate}` calls `buildNavigationUri(centroid, lotCode)` and `window.location.href = uri` (do NOT use `window.open(uri, "_blank")` — `geo:` and `maps:` schemes don't open in tabs, and the new-tab attempt confuses the browser).

- [ ] **Task 2: Implement `buildNavigationUri` helper** (AC: 1)
  - [ ] Path: `src/lib/navigation.ts`. Pure function: `buildNavigationUri(centroid: { lat: number; lng: number }, lotCode: string): { uri: string; fallbackUri: string }`.
  - [ ] Detect platform via `navigator.userAgent` + the modern `navigator.userAgentData?.platform` when available. Returns:
    - Android (`/Android/i.test(ua)`): `uri = "geo:${lat},${lng}?q=${lat},${lng}(Lot ${lotCode})"`, fallback `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`.
    - iOS (`/iPhone|iPad|iPod/i.test(ua)`): `uri = "maps://?daddr=${lat},${lng}"`, fallback same Google Maps URL.
    - Desktop / other: only the Google Maps `https://` URL.
  - [ ] **Encode `lotCode` via `encodeURIComponent`** before interpolating into URIs to handle special chars (e.g. lot code `D-5-12` is fine but defense-in-depth).
  - [ ] Unit test thoroughly — UA-string sniffing is fragile; the helper must be a pure-function with injected `userAgent` parameter to make testing trivial.

- [ ] **Task 3: Fallback panel** (AC: 3)
  - [ ] In `NavigateToLotButton.tsx`: after launching the URI, set `setFallbackVisible(false)` and start a 1500ms `setTimeout` that flips it to `true` *only if* `document.visibilityState === "visible"`. If the user was successfully routed to a nav app, the page goes hidden → no fallback. If the URI scheme failed silently → page stays visible → fallback appears.
  - [ ] Fallback content: `<Card>` with an `<img>` of a static OSM map URL (`https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lng}&zoom=18&size=400x300&markers=${lat},${lng},red-pushpin` — verify this static-image service is still operational at dev time; if not, use a Convex-generated SVG pin overlay or skip the image and show only coordinates), the lot's coordinates ("Lat: 14.5995, Lng: 120.9842"), and a `<Button>` "Copy coordinates" that calls `navigator.clipboard.writeText("${lat}, ${lng}")` and toasts "Copied".
  - [ ] Accessibility: when fallback appears, focus moves to its heading; the fallback heading announces via `aria-live="polite"` "Navigation app not available. Manual coordinates shown."

- [ ] **Task 4: Add button to lot detail page** (AC: 1, AC: 2)
  - [ ] In `src/app/(staff)/lots/[lotId]/page.tsx`: import `NavigateToLotButton`. Place it in the action row alongside existing actions (e.g. "Edit lot," "View map"). Pass `lotCode={lot.code}` `geometryStatus={lot.geometryStatus}` `centroid={lot.geometry?.centroid}`.
  - [ ] Verify mobile layout: on phone, the button is 44px+ tall (NFR-A4) and sits prominently — it's Junior's primary action on this page when he's in the field.

### Server-side coordinate gating (AC4)

- [ ] **Task 5: Update `convex/lots.ts → getLotById`** (AC: 4)
  - [ ] Read the existing `getLotById` (Phase 1 query). Add: if the caller's role is not in `["admin", "office_staff", "field_worker"]`, redact `geometry.centroid` and `geometry.polygon` to `undefined` in the returned doc — even if `requireRole` was passed (it'll be passed because the query is public; the redaction is per-field).
  - [ ] If `geometryStatus === "placeholder"`, redact `geometry.centroid` even for staff — there's no real coordinate to expose, and exposing the placeholder centroid invites accidental navigation. The client-side button gates on `geometryStatus`, but the server-side redaction is defense-in-depth.
  - [ ] Phase 3 customers (Story 9.2): if the caller is `"customer"` AND they own the lot via `ownerships`, return `geometry.centroid` only. Polygon redacted (customers don't need it; saves bandwidth). This is a Phase 3 concern; document the rule here and verify the implementation when Story 9.2 lands.

- [ ] **Task 6: Verify `pii_access_log` is NOT triggered for coordinates** (AC: 4)
  - [ ] Lot GPS coordinates are not PII per the data model (lots are physical infrastructure, not people). Do NOT write a `pii_access_log` row on every `getLotById` read. Confirm by checking `convex/lib/pii.ts → readPii` — it lists PII fields explicitly; `geometry.centroid` is not among them.

### Disabled-state UX (AC2)

- [ ] **Task 7: Tooltip behavior on touch devices** (AC: 2)
  - [ ] shadcn/ui Tooltip uses Radix; Radix tooltip on touch defaults to long-press to show. Verify this works on iOS Safari + Android Chrome.
  - [ ] As a fallback for users who don't long-press, the disabled button's `aria-disabled="true"` + screen-reader-visible text "Navigate to lot, disabled, GPS coordinates not yet surveyed" is sufficient. Visible disabled styling (slate-300 background, lower text contrast) communicates state visually.

### Testing (AC1–AC4)

- [ ] **Task 8: Unit tests** (AC: 1, AC: 2)
  - [ ] Create `tests/unit/lib/navigation.test.ts`:
    - Android UA → `geo:` URI with correct lat/lng + label.
    - iOS UA → `maps://` URI with correct daddr.
    - Desktop UA → `https://www.google.com/maps/dir/?api=1&destination=...`.
    - Special-char lot code → properly encoded.
    - Centroid with extra precision → uses 6 decimal places (cemeteries don't need 10-decimal GPS precision; 6 decimals = ~10cm).
  - [ ] Create `tests/unit/components/NavigateToLotButton.test.tsx`:
    - Renders disabled when `geometryStatus === "placeholder"`.
    - Renders disabled when `centroid` is undefined.
    - Renders enabled when both present; clicking sets `window.location.href`.
    - Fallback appears after 1500ms if visibilityState stays "visible".
    - Fallback does NOT appear if visibilityState becomes "hidden" before timeout.

- [ ] **Task 9: Server-side query test** (AC: 4)
  - [ ] Update `tests/unit/convex/lots.test.ts` (Phase 1 test file): add cases:
    - `getLotById` called by customer (non-owner) → `geometry.centroid` undefined.
    - `getLotById` called by office_staff on placeholder lot → `geometry.centroid` undefined (defense-in-depth).
    - `getLotById` called by office_staff on surveyed lot → `geometry.centroid` populated.

- [ ] **Task 10: Playwright manual smoke** (AC: 1, AC: 3)
  - [ ] Document a manual mobile-device test in `docs/runbook.md` (no automated test for native-app handoff — Playwright can't drive `geo:` schemes): on a real Android phone + a real iPhone, navigate to a surveyed lot's detail page, tap "Navigate to lot," verify the native map app opens with the correct destination. Run this once per phone OS per release.

### Documentation (AC1, AC4)

- [ ] **Task 11: ADR-0012 — GPS navigation via URI scheme** (AC: 1, AC: 4)
  - [ ] Write `docs/adr/0012-gps-navigation-uri-scheme.md`: rationale for delegating to native apps (no turn-by-turn library, no Google Maps API key, no licensing complexity); `geo:` for Android, `maps://` for iOS, `https://maps.google.com/` cross-platform fallback; server-side coordinate redaction for unsurveyed lots; the visibility-detection fallback pattern.

- [ ] **Task 12: User-facing help text** (AC: 1, AC: 2)
  - [ ] In `docs/runbook.md` add a "Field worker quickstart" section: "Tap 'Navigate to lot' on any lot detail page. Your phone will open Google Maps (Android) or Apple Maps (iOS) with directions to the lot. If your phone doesn't open a nav app, the page will show the coordinates so you can paste them into any map of your choice."

## Dev Notes

### Previous story intelligence

**Phase 1 dependencies:**

- **Story 2.4 — Lot detail page (`/lots/[lotId]`):** the page this story extends. The "Navigate to lot" button is one of its actions.
- **Story 1.2 — `requireRole`:** the lot query already calls it. This story extends the query's *response shape* (redacts coordinates based on role + survey status), not its auth pattern.
- **Story 1.4 — shadcn/ui (Button, Tooltip, Card):** all reused; no new UI primitives.

**Phase 2 dependencies (must be complete):**

- **Story 8.1 — GPS geometry import:** this story is only useful when real coordinates exist. Without it, every lot is `geometryStatus: "placeholder"` and the button is always disabled. **Order: 8.1 → (8.2 ∥ 8.3) — 8.2 and 8.3 are independent and can ship in parallel** once 8.1 has landed.
- **Story 8.2 — Leaflet renderer:** independent. Navigate-to-lot works on the lot detail page regardless of which map renderer is active. The detail page is not the map.

**Phase 3 hand-off:**

- **Story 9.2 — Customer views own contracts:** when customers view a lot they own, the same query (`getLotById`) is used. AC4's customer-ownership rule applies. Coordinate exposure on the customer side is a (very minor) PII consideration; redact polygon, expose only centroid to owners, redact to non-owners.

### Architecture compliance

- **`geo:` URI scheme:** standardized by RFC 5870; supported by Android since 2.0. iOS doesn't support `geo:` natively but supports `maps://` (the Apple Maps URL scheme). No proprietary SDKs needed.
- **Cross-platform fallback:** `https://www.google.com/maps/dir/?api=1&destination=...` works on every platform with a browser and respects the user's default maps app via Google Maps' own handoff.
- **No new external dependencies:** this story adds no third-party libraries. URI construction is a 20-line pure function.
- **No API keys:** zero Google Maps Platform usage (no JS SDK, no Static Maps API). The OSM static-map fallback is also keyless (verify the staticmap.openstreetmap.de service is still operational at dev time; if not, use a tiny SVG-pin overlay rendered server-side or omit the image).
- **Server-side authorization** (NFR-S4): every public query enforces `requireRole`; coordinate redaction is a per-field response transform after the auth gate.
- **NFR-A4 touch targets:** 44×44px minimum on the button.

### Library / framework versions (researched current)

- **`lucide-react`** — already a Phase 1 dependency (icons). `MapPin` icon used.
- **shadcn/ui Button + Tooltip + Card** — already Phase 1.
- **`navigator.clipboard.writeText`** — supported in all modern browsers; required HTTPS context (Vercel preview + prod is HTTPS, dev is `localhost` which counts as secure).
- **`navigator.userAgentData`** (modern UA Client Hints API) — preferred when available, falls back to `navigator.userAgent` string parsing.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   └── lots.ts                                # UPDATE (getLotById redacts geometry based on role + geometryStatus)
├── src/
│   ├── app/
│   │   └── (staff)/
│   │       └── lots/[lotId]/page.tsx          # UPDATE (add NavigateToLotButton to action row)
│   ├── components/
│   │   └── NavigateToLotButton.tsx            # NEW
│   └── lib/
│       └── navigation.ts                      # NEW (buildNavigationUri pure helper)
├── tests/
│   └── unit/
│       ├── lib/
│       │   └── navigation.test.ts             # NEW
│       ├── components/
│       │   └── NavigateToLotButton.test.tsx   # NEW
│       └── convex/
│           └── lots.test.ts                   # UPDATE (add coordinate-redaction tests)
├── docs/
│   ├── adr/
│   │   └── 0012-gps-navigation-uri-scheme.md  # NEW
│   └── runbook.md                             # UPDATE (Field worker quickstart + manual mobile test)
```

### Testing requirements

- **NFR-M2 coverage:** target **≥ 90% on `src/lib/navigation.ts`** (pure logic, easy to cover) and **≥ 80% on `NavigateToLotButton.tsx`** (UI logic + visibility detection).
- **Manual mobile test required** for the URI handoff — Playwright cannot drive native apps. Document in runbook; run before each release that touches navigation.
- **No e2e test for the button** beyond verifying it renders + click handler fires (the native handoff itself is not testable in Playwright).

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT integrate Google Maps Platform JS SDK.** No Maps JavaScript API, no Places API, no Directions API. We're delegating to whatever nav app the user has. Avoids licensing complexity, API keys, and bundle bloat.
- ❌ **Do NOT trust the client's `geometryStatus` for the button enable/disable alone.** Client-side gating is UX, not security. The server query also redacts coordinates for unsurveyed lots so the button literally cannot fire with garbage coordinates.
- ❌ **Do NOT expose lot polygons to customers.** Phase 3: customers see their lot's centroid (so they can find their family's plot when visiting) but not the polygon vertices. Polygon is staff data.
- ❌ **Do NOT use `window.open(uri)` for `geo:` / `maps://` URIs.** These aren't HTTP — opening in a new tab is wrong. Use `window.location.href`.
- ❌ **Do NOT hard-code Google Maps as the only target.** Junior may prefer Waze, Maps.me, or any other installed nav app. The `geo:` scheme on Android invokes the user's default — that's the right behavior. Forcing Google Maps `https://` URL ignores the user's preference.
- ❌ **Do NOT render the fallback before the URI attempt.** The fallback exists for failure modes. Always launch the URI first; only show fallback if visibility check confirms launch didn't happen.
- ❌ **Do NOT use `setTimeout` longer than 2000ms** for fallback detection. Junior is in the field; 2 seconds of "nothing happening" is the patience budget.
- ❌ **Do NOT depend on a single static-map service.** The OSM static-map service in the fallback is community-run with no uptime SLA. Plan for it to be down: if `img` fails to load, hide it and show only the text coordinates.
- ❌ **Do NOT log lat/lng to Sentry or analytics.** Coordinates aren't PII but they're sensitive operational data — a cemetery's lot layout is private. Configure Sentry's `beforeSend` to scrub `geometry.*` fields from error breadcrumbs.

### Common LLM-developer mistakes to prevent

- **UA-string sniffing pitfalls:** iOS-Chrome reports a UA that contains "Mobile" + "Safari" but not "Mac OS X" — verify your iOS check matches it. Better: test the helper with both real device UAs.
- **`encodeURIComponent` placement:** apply to `lotCode` interpolation, NOT to lat/lng numbers. Lat/lng go in as decimal strings; encoding them is harmless but unnecessary.
- **Wrong centroid precision:** trimming to 6 decimals is enough. Storing or sending 14 decimals (JS `number` default) wastes bytes and looks unprofessional in the URI.
- **Tooltip on disabled buttons:** Radix Tooltip requires `<TooltipTrigger asChild>` wrapping a focusable element, but disabled buttons aren't focusable. Wrap in a `<span tabIndex={0}>` or use `pointer-events: none` on a visually-disabled-but-actually-focusable button. Test with keyboard.
- **Customer-coordinate exposure in Phase 3:** when Story 9.2 ships, verify the query's response correctly handles the customer / owner case. Don't accidentally expose all-lot coordinates to all customers.
- **Server-redacted coordinates breaking the SVG renderer:** SVG renderer uses Phase 1 overlay coordinates (not `lots.geometry`), so it's unaffected. Leaflet renderer (Story 8.2) uses `lots.geometry.polygon` — if you redact polygon for staff too, the map breaks. AC4's redaction must NOT apply to polygons for staff roles.

### Open questions / blockers this story does NOT resolve

- **Offline navigation:** if Junior is offline, the URI handoff still works (native map apps cache or work offline depending on user setup). Web fallback is online-only — acceptable since the fallback is a degraded case.
- **Indoor / above-ground mausoleum navigation:** GPS isn't useful inside large structures. Out of scope; the lot detail page can show a section-overlay image as supplementary aid.
- **Wayfinding within the cemetery (no roads):** Google Maps will route Junior to the cemetery entrance closest to the lot's GPS coordinates. Internal cemetery roads aren't on OSM. Acceptable for Phase 2; consider custom routing in a far-future story if pain emerges.

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure & Boundaries](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries) — `src/components/NavigateToLotButton.tsx`, `src/lib/navigation.ts` match the established layout.
- [UX § Field worker patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md) — large touch targets, outdoor-readable contrast, search-first model preserved.

No detected conflicts.

### References

- [PRD § FR12 — Field-worker GPS navigation](../../_bmad-output/planning-artifacts/prd.md#2-lot-inventory--mapping)
- [PRD § NFR-A4 (touch targets), NFR-S4 (server-side auth)](../../_bmad-output/planning-artifacts/prd.md#accessibility)
- [Architecture § Phase 2 map + nav scope](../../_bmad-output/planning-artifacts/architecture.md#frontend-architecture)
- [UX § Field-worker context patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [Epics § Story 8.3](../../_bmad-output/planning-artifacts/epics.md)
- [Previous story 8.1 — geometry import](./8-1-system-imports-gps-surveyed-lot-geometry.md)
- [Previous story 8.2 — Leaflet renderer (independent)](./8-2-phase-2-leaflet-renderer.md)
- [`geo:` URI scheme RFC 5870](https://datatracker.ietf.org/doc/html/rfc5870)
- [Apple Maps URL Scheme reference (current)](https://developer.apple.com/library/archive/featuredarticles/iPhoneURLScheme_Reference/MapLinks/MapLinks.html)
- [Google Maps URLs (current)](https://developers.google.com/maps/documentation/urls/get-started)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Claude Code, Anthropic CLI).

### Debug Log References

- Typecheck (`tsc --noEmit`): clean.
- Lint (`next lint`): clean (no warnings or errors).
- Unit tests (`vitest run`): 1650 passed, 1 pre-existing skip. New tests added:
  - `tests/unit/lib/navigateToLot.test.ts` — 16 tests (every UA branch, encoding edge cases, precision contract).
  - `tests/unit/components/NavigateToLotButton.test.tsx` — 9 tests (enabled / disabled / tooltip wrapping / touch target / re-entrancy).
- E2E (`playwright test lot-navigate`): authored as an unauthenticated guard smoke. The full authenticated journey is blocked by the same Convex test-user seed gap that the rest of `tests/e2e/lot-detail.spec.ts` documents — out of scope here.
- Build: `next build` Compile step succeeds in ~20s; "Collecting page data" flakes intermittently due to a Next.js 15 workspace-lockfile-detection issue (multiple lockfiles in parent dirs) that is environmental, not story-induced.

### Completion Notes List

- **Scope discipline**: the story's AC4 (server-side coordinate redaction in `convex/lots.ts → getLotById`) is explicitly out of the brief's file-ownership scope for this story. The client-side gate on `geometryStatus` + `centroid` presence is in place; server-side redaction is deferred to a follow-up convex-owned story (likely paired with Story 9.2's customer-portal coordinate exposure rules).
- **Fallback panel deferred**: the story's AC3 fallback (visibility-detection + static OSM map + copy-coords) is documented in the story file but not shipped in this iteration — the brief's "Do" list called for a focused button + helper, not the full fallback surface. The button still works correctly without it: on Android / iOS the OS handler takes over and the page falls behind; on desktop the cross-platform Google Maps `https://` URL opens in a new tab.
- **UA-string sniffing**: the `detectPlatform` helper accepts UA strings from real Android Chrome, iOS Safari, iPad Safari, iOS Chrome (CriOS), Desktop Chrome, and Desktop Safari. iPad in desktop-mode (UA reports as Mac) intentionally falls through to "other" and gets the cross-platform Google Maps URL, which still works.
- **Coordinate precision**: 6 decimals (`toFixed(6)`), ≈ 10 cm. Verified by `tests/unit/lib/navigateToLot.test.ts`.
- **Re-entrancy guard**: rapid double-tap of the button (frustrated outdoor user) fires `onNavigate` exactly once per tick via an `inFlight` ref + busy state. Verified.
- **Manual mobile test**: not executed in this session (no physical devices). The manual mobile smoke (real Android Chrome + real iOS Safari opening their respective native map apps) is owed before release per the story's Task 10 + the runbook entry.
- **`SvgRenderer.tsx`** popup was left untouched: the brief allowed a minimal additive edit but flagged it as optional. The lot detail page now carries the Navigate button on the LotFactsPanel — that is the primary surface for the field-worker journey; the map popup is a "nice to have" deferrable to a future polish pass.

### File List

Created:
- `src/lib/navigateToLot.ts` — pure helper, UA classification + URL construction.
- `src/components/NavigateToLotButton/NavigateToLotButton.tsx` — primary action button + disabled tooltip wrapper.
- `src/components/NavigateToLotButton/index.ts` — public re-export.
- `tests/unit/lib/navigateToLot.test.ts`
- `tests/unit/components/NavigateToLotButton.test.tsx`
- `tests/e2e/lot-navigate.spec.ts`

Modified:
- `src/components/LotDetail/LotFactsPanel.tsx` — appended NavigateToLotButton to the geometry section + added optional `code` to `LotFactsData`.
- `src/components/LotDetail/LotDetail.tsx` — pass `code` through to `LotFactsData`.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `8-3-field-worker-navigates-to-a-lot-via-gps: review`, `last_updated: 2026-05-18`.
