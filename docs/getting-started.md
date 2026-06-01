# Getting started — local development & first run

This is the **fast path** from a fresh clone to a running, logged-in app.
Operational/production procedures live in [runbook.md](runbook.md); this
doc is just "make it run."

## Prerequisites

- **Node ≥ 20** (see `package.json` → `engines`).
- A **Convex account** (free tier is fine) — <https://dashboard.convex.dev>.
  The provisioned dev deployment for this project is `beaming-boar-935`;
  you can use it (ask the owner for access) or create your own.
- Dependencies installed: `npm install` (already present if `node_modules/`
  exists).

## 1. Bring up the backend (Convex)

```bash
npx convex dev
```

The first run is **interactive**: it logs you into Convex, links/creates a
deployment, **pushes the schema + all functions**, **generates
`convex/_generated/`** (the typed API the app and tests can import), and
**writes `CONVEX_DEPLOYMENT` + `NEXT_PUBLIC_CONVEX_URL` into `.env.local`**.
Leave it running — it hot-reloads `convex/**` on save.

> Until this has run once, `convex/_generated/` does not exist. The app
> still compiles because every UI→backend call uses
> `makeFunctionReference("module:fn")` string paths (verified to resolve),
> but you cannot actually talk to a deployment without this step.

## 1b. Initialize Convex Auth (one-time, REQUIRED before login)

```bash
npx @convex-dev/auth
```

Convex Auth signs session JWTs with a keypair that lives in the
deployment's environment. `convex dev` does NOT create it — this CLI
generates the RSA keypair and sets `JWT_PRIVATE_KEY`, `JWKS`, and
`SITE_URL` on the deployment. **Skip this and the first sign-in throws
`Missing environment variable JWT_PRIVATE_KEY`.** One-time per deployment.

(`convex/auth.config.ts` already declares the password provider + the
`CONVEX_SITE_URL` JWT issuer; this step only provisions the signing keys.)

## 2. Configure environment

```bash
cp .env.example .env.local    # then edit .env.local
```

`npx convex dev` manages the two Convex variables in `.env.local`. You fill
in the rest as you need them:

| Variable | Needed for | Notes |
|----------|-----------|-------|
| `NEXT_PUBLIC_CONVEX_URL`, `CONVEX_DEPLOYMENT` | everything | set by `convex dev` |
| `RESEND_API_KEY`, `RESEND_FROM` | email reminders + receipt email + account-email-change notice | leave blank to run with email disabled (sends fail-closed, logged) |
| `EMAIL_WEBHOOK_SECRET` | inbound bounce webhook | from the Resend dashboard |
| `GCASH_*` / `MAYA_*` / `CARD_*` | portal online payments | adapters refuse to run in prod without these; the dev mock-gateway works without them |
| `PORTAL_URL` | links inside reminder emails | public origin of the portal |
| `ARCHIVE_S3_*` | optional S3 mirror of BIR archives | optional; Convex storage is used regardless |

Server-side secrets that Convex **functions** read (e.g. `RESEND_API_KEY`,
`*_WEBHOOK_SECRET`, gateway keys, `ARCHIVE_S3_*`) must ALSO be set in the
Convex env, not just `.env.local`:

```bash
npx convex env set RESEND_API_KEY re_xxx
npx convex env set EMAIL_WEBHOOK_SECRET whsec_xxx
# …repeat per secret. NEXT_PUBLIC_* belongs only in .env.local (it's
# inlined into the browser bundle).
```

## 3. Run the front end

In a second terminal (or use the combined script):

```bash
npm run dev          # Next.js only (Convex already running from step 1)
# — or, to run both together from one terminal:
npm run dev:all      # concurrently runs `next dev` + `convex dev`
```

App: <http://localhost:3000>.

## 4. Seed demo data + accounts (recommended) — one command

```bash
npx convex run seed:seedDemo
```

This is **idempotent** (a second run no-ops). It creates four login
accounts (one per role), all the reference config the app needs to not
fail-closed (perpetual-care policy, BIR receipt config, reminder cadence,
expense categories, receipt counter), and a full slice of demo data —
sections, lots (varied statuses), customers, two contracts (a paid
full-payment one and an active installment one with an overdue
installment for the AR-aging tile), payments + BIR-serial receipts,
ownerships, an occupant, a scheduled interment, and expenses. Enough to
click through every page.

### Demo login accounts (password for all: `Demo!2026`)

| Role | Email | Demos |
|------|-------|-------|
| Admin | `admin@apostlepaul.test` | dashboard, reports, audit log, settings, everything |
| Office staff | `office@apostlepaul.test` | lots, customers, sales, payments, receipts, expenses |
| Field worker | `field@apostlepaul.test` | offline lot lookup, log condition, complete interment |
| Customer (portal) | `juan@example.ph` | `/portal` — own contracts, balances, receipts, pay, account |

> **Rotate these before any real deployment.** They're demo credentials
> with a known password. The seed only runs via `npx convex run` (never
> from the app), so it can't be triggered by a visitor.

### Alternative: bootstrap by signing up (no seed)

If you'd rather start empty: the **first** account to sign up at `/login`
is auto-promoted to `admin` by `convex/auth.ts`'s
`afterUserCreatedOrUpdated` callback (when `userRoles` is empty). Later
sign-ups get no role until an admin grants one. You'd then configure the
fail-closed bits manually (see below).

## 5. One-time domain configuration (the seed already does all of this)

If you ran `seed:seedDemo`, skip this — it's already configured. Doing it
manually as admin:

- **Perpetual-care policy** — sales throw
  `INVARIANT_VIOLATION { kind: "perpetual_care_not_configured" }` until set.
  **Admin → Settings → Perpetual care** (`/admin/settings/perpetual-care`).
- **BIR receipt config** — **Admin → Settings → BIR receipt config**
  (`/admin/settings/bir-receipt-config`) before issuing real receipts.
- **Sections registry** — **Admin → Sections** (`/admin/sections`).
- **Phase planning defaults** (optional) —
  `npx convex run phasePlanning:seedDefaultPhases`.

## 6. Webhooks (only when testing online payments / email bounces)

External providers POST to the `.convex.site` HTTP routes (see
`.env.example` for the exact URLs). Register them in each provider's
dashboard and copy their signing secrets into the Convex env (step 2).
For local payment testing without real gateways, use the dev
**mock-gateway** page the portal pay flow falls back to.

## Quick verification

```bash
npm run typecheck    # tsc --noEmit
npm run lint
npm test             # vitest run
npm run build        # next build (+ service worker)
```

All four are green on a clean checkout. (`npm test` exits non-zero only on
the known `tests/unit/sw/sw.test.ts` DNS rejection in sandboxed
environments — every actual test passes.)

## Appendix — optional: compile-time-safe function calls (after first `convex dev`)

Today every UI→backend call uses
`makeFunctionReference<"query"|"mutation"|"action", Args, Result>("module:fn")`
string paths (176 of them, all verified to resolve to a real exported
function). This is what lets the repo compile *without* `convex/_generated/`.
The tradeoff: the `Args`/`Result` generics are **hand-written**, so a drift
between a ref's declared types and the actual function signature is NOT
caught at compile time — only the function-name path is implicitly checked
(by the runtime, or by the audit script in this repo's history).

Once you have run `npx convex dev` once, `convex/_generated/{api,server,
dataModel}.d.ts` exist, and you can migrate to fully type-checked calls:

```ts
// before — hand-typed string ref:
const ref = makeFunctionReference<"query", { id: string }, Row[]>("lots:listInBbox");
const rows = useQuery(ref, { id });

// after — generated, type-checked end to end:
import { api } from "@/../convex/_generated/api";
const rows = useQuery(api.lots.listInBbox, { id });
```

Recommended migration order (highest payoff first): the financial +
portal surfaces (`portal:*`, `payments:*`, `receipts:*`,
`contracts:*`) where an arg/return drift is most costly. This is
mechanical but touches ~114 files, so do it incrementally per-feature and
run `npm run typecheck` after each batch — the compiler will surface any
ref whose hand-written generics never actually matched the function.

