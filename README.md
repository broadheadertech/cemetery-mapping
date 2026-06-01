# cemetery-mapping

Cemetery management system for a 2,000+ lot Philippine cemetery.
Replaces paper-and-spreadsheet workflows with a single reactive
Next.js + Convex web application.

See [`_bmad-output/planning-artifacts/`](_bmad-output/planning-artifacts/)
for the full PRD, Architecture, UX Specification, and Epics. See
[`_bmad-output/implementation-artifacts/`](_bmad-output/implementation-artifacts/)
for context-engineered story files ready for the dev agent.

---

## Prerequisites

- Node.js **20 or newer** (LTS).
- npm **10 or newer**.
- A Convex account ([convex.dev](https://www.convex.dev)) with access to the
  pre-provisioned deployment `beaming-boar-935`.

## First-time setup (clean clone)

```bash
# 1. Install dependencies
npm install

# 2. Configure Convex deployment (one-time, interactive)
#    Choose the existing deployment 'beaming-boar-935' rather than
#    creating a new project. Writes CONVEX_DEPLOYMENT + NEXT_PUBLIC_CONVEX_URL
#    to .env.local.
npx convex dev

# (Stop the dev server with Ctrl-C once the schema deploys cleanly.)

# 3. Copy environment variables template
cp .env.example .env.local
# Edit .env.local — set SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD for the
# first admin account. Rotate the password before go-live.

# 4. Run the development environment (Next.js + Convex watch)
npm run dev:all
```

Open [http://localhost:3000](http://localhost:3000). You'll be redirected to
`/login`. Sign up with the seed admin credentials (Story 1.1's
one-time-bootstrap flow); subsequent users are created by an admin via
the user-management UI added in Story 1.3.

The full bootstrap (clean clone → working `dev:all`) should complete
in under 10 minutes (NFR-M5).

## Daily development

```bash
npm run dev:all          # Next.js (port 3000) + Convex watch in parallel
npm run dev              # Next.js only
npm run dev:convex       # Convex only
```

## Tests

```bash
npm test                 # Vitest unit tests (one-shot)
npm run test:watch       # Vitest watch mode
npm run test:coverage    # Vitest with coverage report
npm run test:e2e         # Playwright E2E (requires npm run build first in CI)
npm run test:e2e:install # Install Playwright browser binaries (one-time)
```

## Quality gates

```bash
npm run lint             # ESLint
npm run typecheck        # TypeScript strict mode (NFR-M1)
npm run lighthouse       # Lighthouse CI against /login
```

All four run on every pull request via
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Environment variables

See [`.env.example`](.env.example) for the full list with explanatory
comments. Set production values via:

```bash
# Convex (server-side env vars)
npx convex env set RESEND_API_KEY <value>

# Vercel (Next.js env vars)
vercel env add NEXT_PUBLIC_CONVEX_URL
```

Never commit `.env.local` or any file containing secrets.

## Roles (Phase 1)

- **Admin / Owner** — full access, financial reports, user management.
  Default session timeout: 1 hour (NFR-S5).
- **Office Staff** — sales, contracts, payment intake, interments,
  customer records, expense entry. Session timeout: 8 hours.
- **Field Worker** — phone-browser lot lookup, lot condition logging.
  Session timeout: 8 hours.
- **Customer** — Phase 3 self-service portal. Session timeout: 30 days.

Roles are assigned by Admins via the user-management UI in Story 1.3.

## Project structure

See [`docs/adr/`](docs/adr/) for architecture decisions and the
[architecture document](_bmad-output/planning-artifacts/architecture.md)
for the canonical structure reference.

```
cemetery-mapping/
├── convex/              # Convex backend (schema, queries, mutations, actions)
│   ├── _generated/      # Auto-generated; committed
│   ├── schema.ts        # Canonical data model
│   ├── auth.ts          # Convex Auth wiring (password provider)
│   ├── auth.config.ts
│   ├── http.ts          # HTTP routes (auth callbacks; future webhooks)
│   └── seed.ts          # First-admin seed (idempotent)
├── src/
│   ├── app/             # Next.js App Router
│   │   ├── (public)/    # /login, future P3 landing
│   │   ├── (staff)/     # Authenticated routes (dashboard, lots, customers...)
│   │   ├── (customer)/  # Phase 3 customer portal (not yet present)
│   │   ├── layout.tsx   # Root layout + Convex providers
│   │   ├── page.tsx     # Root redirect (auth → dashboard | else → login)
│   │   ├── globals.css
│   │   └── ConvexClientProvider.tsx
│   ├── middleware.ts    # Auth-gate middleware
│   └── lib/             # Client-side helpers
├── tests/
│   ├── unit/            # Vitest
│   └── e2e/             # Playwright
├── docs/
│   ├── adr/             # Architecture Decision Records
│   └── runbook.md       # (Story 5.6) Ops playbook
└── _bmad-output/        # BMAD planning + implementation artifacts
```

## Story status

See [`_bmad-output/implementation-artifacts/sprint-status.yaml`](_bmad-output/implementation-artifacts/sprint-status.yaml)
for live progress across all 75 stories.

## License

Proprietary — single-cemetery freelance build. Cemetery owns the
codebase, Convex project, and Vercel deployment from day one (NFR-M4).
# cemetery-mapping
