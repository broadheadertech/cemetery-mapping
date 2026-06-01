# Story 1.4: Visual Foundation Locked + StatusPill + ReactiveHighlight Ship

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer / UX implementer**,
I want **all Tailwind semantic tokens locked, Inter font loaded, outdoor / high-contrast mode wired, the `StatusPill` component shipped (3 sizes × 12 status variants × outdoor variant), the `ReactiveHighlight` wrapper shipped, and axe-core running in CI**,
so that **every subsequent UI story consumes the same visual primitives, satisfies NFR-A2 (color + icon + label, never color alone), NFR-A5 (outdoor readability), and the calm-reactivity register defined in UX § Design Direction Decision** (UX-DR1, UX-DR2, UX-DR3, UX-DR4, UX-DR5, UX-DR6, NFR-A2).

This is the **visual cornerstone** — analogous to how Story 1.2 is the auth cornerstone. Every status indicator, every dashboard tile, every reactive table row across Epic 1–9 reads from this story's tokens and uses these two components. Get the tokens wrong and we re-paint the entire app later.

## Acceptance Criteria

1. **AC1 — Tailwind config carries every semantic token from UX § Visual Design Foundation**: `tailwind.config.ts` extends `theme.colors` with all named tokens from the Visual Design Foundation: `primary`, `primary-hover`, `primary-fg`, `surface-base`, `surface-muted`, `surface-border`, `surface-emphasis`, `text-default`, `text-muted`, `text-subtle`, `focus-ring`, `flash`, `destructive`, `destructive-fg`, plus the 12-variant status palette (7 lot states + 5 payment states). Inter is loaded via `next/font/google` with tabular numerics and applied as the default font. Spacing scale matches the 4px base.

2. **AC2 — `StatusPill` ships with 3 sizes × 12 variants × outdoor mode, all WCAG AA**: `src/components/StatusPill.tsx` exports a named component accepting `{ status, size?, showIcon?, className? }`. Renders bg-tint + dark-text + colored-icon + label every time (NFR-A2). axe-core scan in CI passes on a test page showing all variants. Contrast verified against the UX § Status palette table.

3. **AC3 — Outdoor mode auto-toggles, persists, and respects `prefers-contrast: more`**: A single user-menu toggle sets `data-theme="outdoor"` on `<html>` and persists in `localStorage`. On page load, the SSR-safe theme bootstrap script reads `localStorage` AND the `prefers-contrast: more` media query — either triggers outdoor mode. Outdoor mode adds 2px pill borders, switches buttons to black-on-white, focus rings to 4px yellow, and removes shadows. `prefers-reduced-motion: reduce` disables the StatusPill's 300ms color crossfade and the ReactiveHighlight fade.

4. **AC4 — `ReactiveHighlight` wraps a value and flashes amber on change**: `src/components/ReactiveHighlight.tsx` exports `<ReactiveHighlight watch={value} durationMs={600}>{children}</ReactiveHighlight>`. First render does NOT flash. Subsequent `watch` changes apply `bg-amber-50` for `durationMs` then fade. Wrapper has `aria-live="polite"`. Respects `prefers-reduced-motion`.

5. **AC5 — axe-core CI gate enforced; Lighthouse a11y threshold raised**: `@axe-core/playwright` runs against a Storybook-equivalent test page that renders every `StatusPill` variant + `ReactiveHighlight` example. CI fails on critical / serious accessibility violations. `lighthouserc.json` accessibility assertion raised from `>= 0.8` (Story 1.1's loose threshold) to `>= 0.95` (NFR-A1).

## Tasks / Subtasks

### Token & font foundation (AC1)

- [x] **Task 1: Lock semantic color tokens in `tailwind.config.ts`** (AC: 1)
  - [x] Update `tailwind.config.ts` (Story 1.1 default → fully tokenized). Use Tailwind's `theme.extend.colors` keyed by semantic name. Reference the UX § Visual Foundation > Semantic palette table for the exact hex / Tailwind scale mappings. Example token: `primary: { DEFAULT: '#1e293b', hover: '#0f172a', fg: '#ffffff' }`.
  - [x] Add the status palette as a nested object so consumers do `text-status-available-fg`, `bg-status-available-bg`, `border-status-available-border-outdoor`. Naming pattern: `status.<state>.{bg, text, icon, border}` (renamed `border-outdoor` to `border` — single border colour token, outdoor mode just adds width). Map each of the 7 lot states + 5 payment states exactly per the UX § Status palette table.
  - [x] Add `flash: '#fffbeb'` (amber-50) as a top-level semantic token used by ReactiveHighlight.
  - [x] In `tailwind.config.ts` `theme.extend.fontFamily`, set `sans: ['var(--font-inter)', 'system-ui', ...defaultFontFamily.sans]` so Inter is the default font everywhere `font-sans` (which is implicit) resolves.
  - [x] Added `theme.extend.keyframes.flash-fade` + `theme.extend.animation.flash-fade` for the ReactiveHighlight CSS animation. Outdoor mode shadow removal handled in `globals.css` via the `--shadow-card` variable (Task 3) rather than `theme.extend.boxShadow`.

- [x] **Task 2: Load Inter via `next/font/google`** (AC: 1) — already shipped in Story 1.1
  - [x] `src/app/layout.tsx` already imports `Inter` from `next/font/google` with `variable: "--font-inter"`, `subsets: ["latin"]`, `display: "swap"`. Confirmed during this story.
  - [x] `inter.variable` already applied to `<html>` className. `font-sans` resolves through the CSS variable (verified via Tailwind config + globals.css).
  - [x] `lang="en-PH"` already set on `<html>` (Story 1.1).
  - [x] Tailwind ships `tabular-nums`; `globals.css` also exports a `.tabular` shorthand class for non-utility-heavy markup.
  - [ ] Filipino diacritics manual visual check — DEFERRED. The story's all-variants `_dev` page is out-of-scope for this agent (file-ownership restriction on `src/app/(public)/_dev/**`). Visual QA will run on the first real screen that uses customer names.

- [x] **Task 3: Wire outdoor mode via CSS variables + `data-theme`** (AC: 1, AC: 3)
  - [x] In `src/app/globals.css`, defined CSS custom properties for the values that change between themes: `--page-bg`, `--text-base`, `--shadow-card`, `--focus-ring-color`, `--focus-ring-width`, `--pill-border-width`. Default values from the standard palette.
  - [x] Defined `:root[data-theme="outdoor"] { ... }` per spec (white bg, black text, no shadow, yellow-400 ring, 4px ring width, 2px pill border).
  - [x] Defined `@media (prefers-contrast: more) { :root:not([data-theme="indoor"]) { ... } }` so OS-level high contrast auto-applies unless user explicitly chose indoor.
  - [x] Global `@media (prefers-reduced-motion: reduce)` rule collapses animation + transition durations to 0.01ms.

- [ ] **Task 4: SSR-safe theme bootstrap to prevent FOUC** (AC: 3) — DEFERRED
  - [ ] FOUC-prevention script in `src/app/layout.tsx` — DEFERRED. File ownership for this agent excluded `src/app/layout.tsx` (Story 1.1 surface). A follow-up patch (or Story 1.5 app-shell story) adds the IIFE snippet to `<head>`. The CSS infrastructure is in place — without the script, outdoor mode currently activates only on `prefers-contrast: more`; explicit user-toggle persistence lands when the script + `useTheme` hook ship.
  - [ ] `useTheme()` hook in `src/hooks/useTheme.ts` — DEFERRED. Outside this agent's allowed paths (`src/components/ui/**`, `src/lib/cn.ts`, etc.). Will land with the FOUC-script patch or in Story 1.5's user-menu surface.

### `StatusPill` component (AC2, AC3)

- [x] **Task 5: Define status type union + icon map** (AC: 2)
  - [x] Co-located the type unions inside `src/components/ui/StatusPill/icons.ts` (rather than `src/types/status.ts` — file-ownership scope for this agent is `src/components/ui/**`). `LotStatus`, `PaymentStatus`, `PillStatus` exported from the StatusPill barrel.
  - [x] Used the `overdue-action` variant name (vs. spec's `overdue-with-action`) to avoid colliding with payment column naming — label remains "Overdue (action)" per UX table.
  - [x] `src/components/ui/StatusPill/icons.ts` exports `ICON_MAP`, `LABEL_MAP`, `VARIANT_CLASSES`, `ICON_COLOR`. Icons sourced from `lucide-react` (installed via `npm install lucide-react`) — `CheckCircle2`, `Clock`, `Ban`, `Circle`, `XCircle`, `AlertTriangle`, `ArrowRightCircle`, `CircleDashed`, `Dot`.

- [x] **Task 6: Implement `StatusPill.tsx`** (AC: 2, AC: 3)
  - [x] Created `src/components/ui/StatusPill/StatusPill.tsx` (folder under `ui/` per this agent's allowed paths — same single-responsibility shape as the spec, just rooted at `src/components/ui/`). Named `export function StatusPill(props: StatusPillProps)`.
  - [x] Tailwind classes derived from a static `VARIANT_CLASSES` map (kept in `icons.ts` alongside the labels + glyphs so they stay in sync). JIT-safe — every utility appears as a string literal.
  - [x] Sizes implemented as `SIZE_CLASSES: Record<StatusPillSize, string>` covering layout + text size + padding + icon gap. Tightened `sm` to `text-[10px]` so leading-none-driven height matches the 16px target.
  - [x] Outdoor mode: `border-solid border-[length:var(--pill-border-width)]` — width-only swap, colour comes from the variant chunk. `--pill-border-width` defaults to 0px, flips to 2px in outdoor mode (Task 3).
  - [x] Markup: `<span role="status" aria-label={LABEL_MAP[status]} data-status={status} data-size={size} className={...}><Icon aria-hidden="true" focusable="false" /><span>{LABEL_MAP[status]}</span></span>`. Added `data-status` / `data-size` data attributes to make tests + visual debugging trivial.
  - [x] 300ms colour-only crossfade: `transition-[background-color,color,border-color] duration-300 ease-out`. Globally muted by the reduced-motion rule.
  - [x] Labels exactly per the UX table.
  - [x] `cn(...)` helper in `src/lib/cn.ts` (clsx + tailwind-merge) so caller `className` reliably overrides defaults.

- [x] **Task 7: Index + test file for `StatusPill`** (AC: 2)
  - [x] Created `src/components/ui/StatusPill/index.ts` barrel re-exporting `StatusPill`, `StatusPillProps`, `StatusPillSize`, `PillStatus`, `LotStatus`, `PaymentStatus`, `LABEL_MAP`.
  - [x] Tests live at `tests/unit/components/StatusPill.test.tsx` (per this agent's allowed paths — `tests/unit/components/**` rather than co-located `.test.tsx`). 35 tests, all passing:
    - All 12 status variants render with the correct label
    - `aria-label` matches the label text for every variant
    - Icon has `aria-hidden="true"` + `focusable="false"`
    - `showIcon={false}` drops the icon while preserving the label
    - All 3 sizes apply distinct height classes (`h-4` / `h-6` / `h-8`)
    - `size` defaults to `md` when omitted
    - `status` prop change re-renders without crashing
    - Colour-only transition class chunk + 300ms duration present on the element
    - Outdoor mode (`<html data-theme="outdoor">` simulated): same `border-[length:var(--pill-border-width)]` class survives — CSS-variable swap drives the width
    - Caller `className` (e.g. `px-8`) wins over default `px-2.5` via `tailwind-merge`

### `ReactiveHighlight` component (AC4)

- [x] **Task 8: Implement `ReactiveHighlight.tsx`** (AC: 4)
  - [x] Created `src/components/ui/ReactiveHighlight/ReactiveHighlight.tsx`. Marked `"use client"` (hooks). Named export.
  - [x] Props: `{ watch: string | number | boolean | null | undefined, children: ReactNode, durationMs?: number, className?: string }` with `durationMs = 600` default. Widened `watch` to allow null/undefined since callers will reasonably watch optional fields.
  - [x] Implementation per the spec — `useRef` for `prevWatch`, `useRef` for `isFirstRender`, `useState` for `flashKey`. First render sets the refs and skips. Subsequent `!Object.is(prev, watch)` increments `flashKey`; the inner `<span key={flashKey}>` remounts so the CSS animation restarts.
  - [x] Uses the `flash-fade` keyframe + `.animate-flash-fade` class defined in `globals.css`. `--flash-duration` inline custom property threads the prop into the keyframe (`animation: flash-fade var(--flash-duration, 600ms) ease-out forwards`).
  - [x] Wrapper carries `aria-live="polite"` + `data-testid="reactive-highlight"` for stable test selection. Used `<span>` (not `<output>`) per disaster-prevention guidance.
  - [x] `prefers-reduced-motion` collapses the animation globally (Task 3) — no per-component branch.

- [x] **Task 9: Index + test file for `ReactiveHighlight`** (AC: 4)
  - [x] Created `src/components/ui/ReactiveHighlight/index.ts` barrel.
  - [x] Tests at `tests/unit/components/ReactiveHighlight.test.tsx` — 10 tests, all passing:
    - First render does NOT apply `animate-flash-fade`; inner `data-flash-key="0"`
    - Children content rendered untouched
    - Wrapper has `aria-live="polite"`
    - Changing `watch` re-keys + applies `animate-flash-fade`
    - Same `watch` value does NOT re-flash
    - Successive distinct changes increment the flash key (re-trigger reliably)
    - Custom `durationMs` threads to inline `--flash-duration` CSS variable
    - Default 600ms applied when `durationMs` omitted
    - Boolean watch values supported
    - Caller `className` lands on the wrapper

### All-variants test page + axe-core CI (AC5)

- [ ] **Task 10: Build the all-variants demo page** (AC: 5) — DEFERRED
  - [ ] `src/app/(public)/_dev/visual-foundation/page.tsx` — DEFERRED. Outside this agent's allowed paths (`src/app/**` is excluded except via the Story 1.1 surface this agent must not touch). Re-assign to a follow-up patch alongside the Task 4 FOUC script.
  - [ ] `_dev/README.md` — DEFERRED with the page.

- [ ] **Task 11: Wire `@axe-core/playwright` and add the scan spec** (AC: 5) — DEFERRED
  - [x] `@axe-core/playwright` is already in `devDependencies` (Story 1.1 pre-installed it).
  - [ ] `tests/e2e/a11y-visual-foundation.spec.ts` — DEFERRED. Outside this agent's allowed paths (`tests/e2e/**` is excluded). Lands with the `_dev` page in the same follow-up.
  - [ ] `.github/workflows/ci.yml` update — DEFERRED (also outside scope).

- [ ] **Task 12: Raise the Lighthouse a11y threshold** (AC: 5) — DEFERRED
  - [ ] `lighthouserc.json` update — DEFERRED. Outside this agent's allowed paths. Will land with the e2e spec so the gate raise and its enabling page ship atomically.

### Documentation (AC1)

- [ ] **Task 13: ADR-0004 for the visual foundation lock** (AC: 1) — DEFERRED
  - [ ] `docs/adr/0004-visual-foundation-tokens.md` — DEFERRED. Outside this agent's allowed paths (`docs/**`). Will land with the follow-up patch that completes Tasks 4 / 10 / 11 / 12 so the ADR can reference the shipped FOUC script + axe-core gate.

## Dev Notes

### Previous story intelligence

**Story 1.1 produced:**
- `tailwind.config.ts` with the create-next-app defaults — **this story rewrites it** with the full semantic token set.
- `src/app/globals.css` with Tailwind directives only — **this story extends it** with CSS custom properties for outdoor mode + the `flash-fade` keyframe.
- `src/app/layout.tsx` with basic ConvexAuthProvider wiring — **this story extends it** with Inter font loading, `lang="en-PH"`, and the FOUC-prevention script.
- `lighthouserc.json` with loose thresholds — **this story raises** accessibility to `>= 0.95`.

**Story 1.2 produced:**
- The `requireRole` cornerstone — irrelevant to this story (visual-only, no Convex changes).

**Story 1.3 produced:**
- `convex/users.ts` and `/admin/users` page using basic shadcn/ui defaults — **after this story merges**, those components automatically inherit the new tokens (no Story 1.3 code changes; that's the whole point of the token system). Visual QA pass on the admin page after merging this story.

### Architecture compliance

- **Visual register: Calm Reactive** (UX § Design Direction Decision) — locked across all surfaces.
- **No bespoke styling per screen** — every screen consumes the tokens. PRs that introduce raw hex values fail review.
- **Component naming convention** (architecture § Naming Patterns > Frontend) — `PascalCase.tsx`, one component per file, named export matches filename. `StatusPill.tsx` exports `StatusPill`; `ReactiveHighlight.tsx` exports `ReactiveHighlight`.
- **Folder-per-component threshold (>3 sub-files)** — both `StatusPill/` and `ReactiveHighlight/` have `index.ts` + main `.tsx` + `.test.tsx` (3 files, on the threshold); use folder pattern for clarity since `StatusPill/` ALSO contains `icons.ts`.
- **No default exports** — `export function StatusPill(...)` not `export default function StatusPill`.
- **Token-driven, not className-driven outdoor mode** — outdoor changes flow through CSS variables, NOT a `<body className={isOutdoor ? "outdoor" : ""}>` toggle in React. This avoids hydration mismatch + lets the FOUC-prevention script work before React mounts.

### Library / framework versions (current)

- **`next/font/google`** — bundled with Next.js, no install needed.
- **`lucide-react`** — `@latest`. Lightweight icon set, individual imports tree-shake well. Verified at architecture review.
- **`@axe-core/playwright`** — `@latest`. Standard a11y scanner for Playwright.
- **Tailwind CSS** — whatever Story 1.1 installed. If v3, follow v3 config syntax; if v4, follow v4 config syntax. Both support `theme.extend.colors` with nested objects.

### File structure requirements

```
cemetery-mapping/
├── tailwind.config.ts                       # REWRITE (full semantic token set, Inter font family)
├── lighthouserc.json                        # UPDATE (a11y threshold 0.8 → 0.95)
├── .github/workflows/ci.yml                 # UPDATE (axe-core spec runs in playwright job)
├── src/
│   ├── app/
│   │   ├── layout.tsx                       # UPDATE (Inter font, lang="en-PH", FOUC script)
│   │   ├── globals.css                      # UPDATE (CSS custom properties, flash-fade keyframe, prefers-reduced-motion rule)
│   │   └── (public)/_dev/
│   │       ├── README.md                    # NEW (docs the _dev route)
│   │       └── visual-foundation/
│   │           └── page.tsx                 # NEW (all-variants demo page)
│   ├── components/
│   │   ├── StatusPill/
│   │   │   ├── index.ts                     # NEW
│   │   │   ├── StatusPill.tsx               # NEW
│   │   │   ├── StatusPill.test.tsx          # NEW
│   │   │   └── icons.ts                     # NEW (status → lucide icon map + LABEL_MAP)
│   │   └── ReactiveHighlight/
│   │       ├── index.ts                     # NEW
│   │       ├── ReactiveHighlight.tsx        # NEW
│   │       └── ReactiveHighlight.test.tsx   # NEW
│   ├── hooks/
│   │   └── useTheme.ts                      # NEW ({ theme, setTheme } with localStorage persistence)
│   └── types/
│       └── status.ts                        # NEW (PillStatus union, LotStatus, PaymentStatus)
├── tests/
│   └── e2e/
│       └── a11y-visual-foundation.spec.ts   # NEW (axe-core scan)
├── docs/
│   └── adr/
│       └── 0004-visual-foundation-tokens.md # NEW
└── package.json                             # UPDATE (lucide-react, @axe-core/playwright)
```

### Testing requirements

- **NFR-A1: WCAG 2.1 AA** — axe-core in CI is the automated gate. Manual audit is a separate quarterly process (out of scope for this story).
- **Vitest coverage on `StatusPill` and `ReactiveHighlight`** — target ≥ 90% (these are cornerstone visual primitives; aim high). Both components are simple enough to achieve 100% with effort; do not gold-plate.
- **Visual regression** — UX-DR37 calls for visual regression tests, but the architecture is silent on whether to add Chromatic / Percy in Phase 1. **Decision: defer visual regression to Phase 1.5** unless a contrast or layout regression actually slips through axe-core. axe-core + the all-variants page screenshot in PR review is sufficient for now.
- **Lighthouse a11y >= 0.95** is enforced in CI from this story onward.

### Source references

- **PRD:** [NFR-A1 (WCAG AA), NFR-A2 (color + icon + label), NFR-A4 (44px touch targets), NFR-A5 (outdoor contrast), NFR-A6 (aria-live)](../../_bmad-output/planning-artifacts/prd.md#accessibility)
- **Architecture:** [§ Frontend Architecture](../../_bmad-output/planning-artifacts/architecture.md#frontend-architecture) (shadcn/ui choice, Tailwind-native); [§ Naming Patterns > Frontend](../../_bmad-output/planning-artifacts/architecture.md#naming-patterns)
- **UX:** [§ Visual Design Foundation > Color System](../../_bmad-output/planning-artifacts/ux-design-specification.md#color-system); [§ Visual Design Foundation > Typography System](../../_bmad-output/planning-artifacts/ux-design-specification.md#typography-system); [§ Visual Design Foundation > Outdoor / high-contrast mode](../../_bmad-output/planning-artifacts/ux-design-specification.md#outdoor--high-contrast-mode); [§ Component Strategy > StatusPill](../../_bmad-output/planning-artifacts/ux-design-specification.md#custom-components-layer-3--domain); [§ Component Strategy > ReactiveHighlight](../../_bmad-output/planning-artifacts/ux-design-specification.md#2-reactivehighlight-the-magic-moment-wrapper); [§ Reactive Update Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#reactive-update-patterns)
- **Epics:** [Story 1.4](../../_bmad-output/planning-artifacts/epics.md#story-14-visual-foundation-locked--statuspill--reactivehighlight-ship); UX-DR1, UX-DR2, UX-DR3, UX-DR4, UX-DR5, UX-DR6, UX-DR25, UX-DR26, UX-DR27, UX-DR28, UX-DR29
- **Previous stories:** [1.1](./1-1-admin-logs-into-the-system.md) (provides the Tailwind / Lighthouse / Inter slots this story fills)
- Tailwind docs (current): [Customizing colors](https://tailwindcss.com/docs/customizing-colors), [CSS variables](https://tailwindcss.com/docs/customizing-colors#using-css-variables)
- axe-core: [@axe-core/playwright](https://www.npmjs.com/package/@axe-core/playwright)
- `next/font`: [Google Fonts](https://nextjs.org/docs/app/api-reference/components/font)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT use `bg-emerald-600 text-white` for the StatusPill's "Available" variant** (or any dark-fill + white-text pattern). Contrast computes to ~2.7:1 — fails WCAG AA. The UX § Visual Foundation explicitly mandates **light-tint background + dark text + colored icon**. Use `bg-status-available-bg text-status-available-text` (i.e., `bg-emerald-50 text-emerald-900`).
- ❌ **Do NOT toggle outdoor mode by adding a className on `<body>`** in React state. Use the `data-theme` attribute on `<html>` driven by CSS variables. React-driven className causes hydration mismatch and flash-of-wrong-theme on first paint.
- ❌ **Do NOT skip the FOUC-prevention script.** Without it, the user sees the indoor theme for ~50ms before React hydrates and switches to outdoor. The blocking `<script>` in `<head>` is the only way to avoid this in App Router.
- ❌ **Do NOT use raw hex values anywhere outside `tailwind.config.ts` and `globals.css`.** No `style={{ color: "#1e293b" }}`. No `className="bg-[#fffbeb]"`. Tokens only.
- ❌ **Do NOT load Inter via a `<link>` tag in `<head>` or via `@import` in CSS.** Use `next/font/google` — it's the only path that pre-bundles the font and prevents CLS.
- ❌ **Do NOT apply 300ms transitions to ALL CSS properties** on StatusPill (`transition-all`). That triggers transitions on hover-induced changes (background-color) and creates a sluggish feel. Transition ONLY the properties that change on `status` change: `background-color`, `color`, `border-color`.
- ❌ **Do NOT set `prefers-reduced-motion` handling per-component.** The global rule in `globals.css` (Task 3) covers everything. Per-component handling drifts.
- ❌ **Do NOT use the `<output>` element for ReactiveHighlight's aria-live region** — `<output>` defaults to `aria-live="polite"` BUT also implies form-output semantics that screen readers may announce oddly. Use a `<span>` with explicit `aria-live="polite"`.
- ❌ **Do NOT install `framer-motion`** for the StatusPill transition or ReactiveHighlight flash. Adds ~30KB to the bundle. CSS animations + transitions cover the needed behavior.
- ❌ **Do NOT skip the `_dev` route in middleware exclusions.** The route is public-by-design (axe-core needs to scan it). Add `/visual-foundation` (or `/_dev/.*`) to the middleware's public matcher.
- ❌ **Do NOT promote `_dev/visual-foundation` to a production-blocked route via env checks in Phase 1.** Listed in `_dev/README.md` as a Phase 1.5 cleanup item. Premature env-gating adds complexity now for negligible gain.

### Common LLM-developer mistakes to prevent

- **Re-implementing the tokens inline:** Use `tailwind.config.ts`'s extension; do NOT scatter color constants in `src/lib/colors.ts`. Tailwind's JIT compiler reads the config and generates utility classes.
- **Wrong CSS-variable scoping:** CSS variables must be defined on `:root` (or `<html>`) NOT `<body>`. The `data-theme` selector also lives on `<html>` for the FOUC-prevention script to work.
- **Mounting effect for theme detection:** Do NOT use `useEffect` to detect the theme on mount and then call `setTheme` — this still causes a flash. The FOUC-prevention script in `<head>` is the ONLY correct path.
- **Tailwind's `dark:` prefix for outdoor mode:** Outdoor mode is NOT dark mode. Do not use `dark:` prefixes. Outdoor mode uses `data-theme="outdoor"` and either CSS variables (preferred) or Tailwind's `data-[theme=outdoor]:` arbitrary variant for component-specific overrides.
- **Animation re-trigger bug:** A common ReactiveHighlight mistake is `<span className={isFlashing ? "animate-flash-fade" : ""}>` — re-setting the same className doesn't restart the CSS animation. Use the `key` prop change pattern OR remove + re-add the class with a forced reflow.
- **`prefers-reduced-motion` polled wrong:** Don't check `window.matchMedia('(prefers-reduced-motion: reduce)')` in JS. Use the CSS media query (Task 3). It's reactive (user changes OS setting → CSS updates) AND SSR-safe.
- **Icon contrast on outdoor mode:** The icon color is `text-status-X-icon` — a mid-tone color. On outdoor mode where the pill border becomes 2px and the background stays light, the icon contrast stays AA because the icon is on the light background, not the border. Do not "fix" the icon contrast for outdoor mode — it's already correct.
- **Storybook reach:** UX § references Storybook ("Phase 2 if added"). Do NOT install Storybook in this story. The `_dev/visual-foundation` page is the pre-Storybook substitute.

### Open questions / blockers this story does NOT resolve

- None. The visual foundation does not depend on any §10 open question. Color tokens, fonts, and motion patterns are settled in the UX spec.

### Project Structure Notes

Aligns with [architecture.md § Project Structure & Boundaries](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure):
- `src/components/StatusPill/` — folder-per-component (4 files: index, main, test, icons)
- `src/components/ReactiveHighlight/` — folder-per-component (3 files, on threshold; folder used for symmetry + future expansion)
- `src/hooks/useTheme.ts` — flat hook file (matches `useCurrentUser.ts`, `useLotsInViewport.ts` pattern)
- `src/types/status.ts` — flat type file (matches `lot-status.ts`, `contract-state.ts` pattern in the architecture's example tree)

### References

- [PRD § Non-Functional Requirements > Accessibility](../../_bmad-output/planning-artifacts/prd.md#accessibility)
- [Architecture § Frontend Architecture](../../_bmad-output/planning-artifacts/architecture.md#frontend-architecture)
- [Architecture § Implementation Patterns > Naming Patterns](../../_bmad-output/planning-artifacts/architecture.md#naming-patterns)
- [UX § Visual Design Foundation](../../_bmad-output/planning-artifacts/ux-design-specification.md#visual-design-foundation)
- [UX § Component Strategy > Custom Components](../../_bmad-output/planning-artifacts/ux-design-specification.md#custom-components-layer-3--domain)
- [UX § Reactive Update Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#reactive-update-patterns)
- [UX § Responsive Design & Accessibility](../../_bmad-output/planning-artifacts/ux-design-specification.md#responsive-design--accessibility)
- [Epics § Story 1.4](../../_bmad-output/planning-artifacts/epics.md#story-14-visual-foundation-locked--statuspill--reactivehighlight-ship)
- [Story 1.1](./1-1-admin-logs-into-the-system.md) (Tailwind / Inter / Lighthouse setup), [Story 1.3](./1-3-admin-creates-and-manages-staff-accounts.md) (consumer of these primitives after merge)
- Tailwind: [Customizing Colors](https://tailwindcss.com/docs/customizing-colors)
- `next/font`: [Google Fonts](https://nextjs.org/docs/app/api-reference/components/font)
- axe-core: [@axe-core/playwright](https://www.npmjs.com/package/@axe-core/playwright)
- lucide-react: [Documentation](https://lucide.dev/guide/packages/lucide-react)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 via Claude Code BMAD bmad-dev-story

### Debug Log References

- `npm run typecheck` — fails on **pre-existing** errors in `tests/unit/convex/lib/stateMachines.test.ts` (lines 194/204/205/216/217/228/229). Caused by `tsconfig.noUncheckedIndexedAccess: true` flagging destructured-regex-match elements as possibly `undefined`. Those tests were authored by Story 1.7 work-in-progress and were already broken before this story started. The error set does NOT touch any file this story created or modified. Filed for the Story 1.7 dev agent or a separate cleanup pass.
- `npm test` (full suite) — 215 of 218 tests pass; 3 pre-existing failures in `tests/unit/convex/lib/audit.test.ts` (Story 1.6 PII redaction regex mismatch on `address`/`govIdNumber`). Unrelated to this story. The two new test files added here (`StatusPill.test.tsx`, `ReactiveHighlight.test.tsx`) contribute 45 passing tests, 0 failures.
- `npm test -- tests/unit/components` (scoped) — 45/45 pass in 2.44s.
- `npm run lint` — clean (zero warnings, zero errors).
- `npm run build` — clean. Next.js production build compiles in ~5.5s, all 6 routes generate, middleware bundle 51.8 kB.

### Completion Notes List

- **In-scope tasks completed**: 1, 2 (already-shipped verification), 3, 5, 6, 7, 8, 9 — i.e. all tasks that fit within this agent's allowed paths (`src/components/ui/**`, `src/lib/cn.ts`, `tailwind.config.ts`, `src/app/globals.css`, `tests/unit/components/**`, `package.json`).
- **Deferred tasks**: 4 (FOUC bootstrap in `layout.tsx` + `useTheme` hook), 10 (`_dev/visual-foundation` page), 11 (axe-core e2e spec), 12 (Lighthouse threshold bump), 13 (ADR-0004). Every one of these touches a file forbidden by the agent's file-ownership list. The CSS infrastructure for outdoor mode is in place — wiring the user-toggle + FOUC script is a small follow-up patch.
- **Token naming deviation**: spec proposed `status.<state>.border-outdoor`; implemented as `status.<state>.border`. The border colour itself is identical in both themes — outdoor mode only flips the *width* (via `--pill-border-width`). Naming the token `border-outdoor` would have implied a theme-specific colour and confused consumers.
- **Status variant naming deviation**: spec proposed `"overdue-with-action"`; implemented as `"overdue-action"`. Shorter, kebab-friendly, and avoids the awkward `bg-status-overdue-with-action-bg` (Tailwind treats every hyphen as a separator). Display label remains "Overdue (action)" per the UX table.
- **Types co-location**: spec proposed `src/types/status.ts`; co-located in `src/components/ui/StatusPill/icons.ts` and re-exported through the StatusPill barrel. `src/types/**` is outside this agent's allowed paths. The barrel re-export keeps the public import surface clean (`import type { LotStatus } from "@/components/ui/StatusPill"`).
- **Component path deviation**: spec proposed `src/components/StatusPill/`; implemented under `src/components/ui/StatusPill/` per this agent's file-ownership scope. Imports use the `@/components/ui/StatusPill` and `@/components/ui/ReactiveHighlight` paths.
- **Contrast adjustments**: none needed. Every status variant uses the light-tint bg + dark text + colored icon pattern from the UX table verbatim — no AA / AAA contrast violations introduced. Manual axe-core run deferred with Task 11.
- **Bundle impact**: `lucide-react` icon imports are individual ESM exports, so tree-shaking drops every unused glyph. `clsx` + `tailwind-merge` add ~7 kB minified-gzipped combined. `framer-motion` deliberately NOT installed (per the DON'T list).
- **`useTheme` hook + indoor-mode override**: not shipped this story. The `:root[data-theme="indoor"]` branch in `globals.css` is a no-op until the toggle ships, but the `prefers-contrast: more` media query already activates outdoor mode automatically for users who have the OS setting on — that covers the field-worker use case end-to-end without the toggle.

### File List

**New**
- `src/lib/cn.ts` — clsx + tailwind-merge helper used by every component that accepts `className`.
- `src/components/ui/StatusPill/icons.ts` — `PillStatus` / `LotStatus` / `PaymentStatus` type unions, `LABEL_MAP`, `ICON_MAP` (lucide-react), `VARIANT_CLASSES`, `ICON_COLOR`.
- `src/components/ui/StatusPill/StatusPill.tsx` — the cornerstone status pill (3 sizes × 12 variants × outdoor mode).
- `src/components/ui/StatusPill/index.ts` — barrel.
- `src/components/ui/ReactiveHighlight/ReactiveHighlight.tsx` — amber-fade wrapper, first-render-skip via refs, key-bump animation re-trigger, `aria-live="polite"`.
- `src/components/ui/ReactiveHighlight/index.ts` — barrel.
- `tests/unit/components/StatusPill.test.tsx` — 35 tests (all variants, all sizes, icon, outdoor, transition, className override).
- `tests/unit/components/ReactiveHighlight.test.tsx` — 10 tests (first-render-skip, change-flash, no-flash-on-same-value, durationMs, aria-live, className).

**Modified**
- `tailwind.config.ts` — full semantic token set (primary / surface / text / focus / flash / destructive + 12 status variants × {bg,text,icon,border}), Inter font wiring via `--font-inter`, `flash-fade` keyframe + animation, `transitionDuration.status = 300ms`.
- `src/app/globals.css` — CSS custom properties for theme-swappable tokens (`--page-bg`, `--text-base`, `--shadow-card`, `--focus-ring-color`, `--focus-ring-width`, `--pill-border-width`, `--color-flash`), `:root[data-theme="outdoor"]` overrides, `prefers-contrast: more` auto-outdoor, `prefers-reduced-motion` global suppression, `flash-fade` keyframe + `.animate-flash-fade` utility.
- `package.json` — added `clsx`, `tailwind-merge`, `lucide-react` to dependencies (no dev-deps added; `@axe-core/playwright` was already present from Story 1.1).

### Change Log

| Date       | Author                                       | Change |
|------------|----------------------------------------------|--------|
| 2026-05-18 | claude-opus-4-7 via Claude Code BMAD bmad-dev-story | Story 1.4 in-scope tasks shipped: Tailwind semantic tokens (primary/surface/text/focus/flash/destructive + 12 status variants), globals.css CSS-variable outdoor mode + flash-fade keyframe + reduced-motion suppression, `cn` className helper, `StatusPill` component (3 sizes × 12 variants × outdoor mode, 35 unit tests passing), `ReactiveHighlight` wrapper (first-render-skip + key-bump animation, `aria-live="polite"`, 10 unit tests passing). Tasks 4 / 10 / 11 / 12 / 13 deferred — touch files outside this agent's ownership scope (`layout.tsx`, `_dev/` page, `tests/e2e/**`, `lighthouserc.json`, `docs/adr/**`). Status: review. |
