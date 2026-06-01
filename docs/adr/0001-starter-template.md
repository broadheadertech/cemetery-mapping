# ADR-0001 — Starter Template

**Status:** accepted
**Date:** 2026-05-17
**Decider:** theundead (project owner) + Winston (architect)

## Context

cemetery-mapping needs a Next.js + Convex starter foundation. Several options exist:

1. **`npx create-next-app@latest`** then `npm install convex` (Convex's own quickstart).
2. **`npx create-convex@latest -t get-convex/v1`** (v1 SaaS template with Clerk + shadcn/ui pre-wired).
3. **`npx create-convex@latest -t get-convex/ents-saas-starter`** (Convex Ents + Clerk + SaaS scaffolding).
4. Community starters (Better Auth, edge-first, etc.).

## Decision

**Option 1: `create-next-app` + `npm install convex` + `npm install @convex-dev/auth @auth/core`.**

## Rationale

1. **Auth decision was deferred to the architect** (PRD §7.2). A starter that bundles Clerk (options 2 + 3) would foreclose the Convex Auth vs. Clerk-on-Convex comparison before it happened. Architecture's § Authentication & Security chose Convex Auth — option 1 doesn't carry the Clerk baggage.
2. **Single-cemetery, not SaaS.** Options 2 + 3 bring tenant tables, organization management, billing scaffolding — all dead code for a single-cemetery client.
3. **Boring technology for stability** (Winston's architectural principle). Convex's own official quickstart is the smallest, best-documented, most predictable starting point.
4. **Freelance + single-engineer maintenance** (Resource Risk #4). Minimum starter = minimum future learning surface for whoever maintains this next.
5. **Community starters carry maintenance risk** that's hard to evaluate.

## Consequences

### Positive

- Auth choice (Convex Auth) cleanly embodied in `convex/auth.ts` and `convex/auth.config.ts`.
- No SaaS / multi-tenant cruft.
- Matches Convex's own published quickstart guide → easier for future maintainers to follow standard docs.
- TypeScript strict mode (NFR-M1) on from the initial commit.

### Negative

- We don't get a pre-built component library (no shadcn/ui in the starter). Story 1.4 adds it.
- We don't get a pre-built admin panel. Story 1.3 adds user management.
- We pay the cost of wiring auth + middleware + provider chain ourselves — but that's also what gives us full control.

## Implementation notes

The architecture's documented starter command was:

```bash
npx create-next-app@latest cemetery-mapping \
  --typescript --tailwind --eslint --app --src-dir \
  --use-npm --import-alias "@/*"
cd cemetery-mapping
npm install convex @convex-dev/auth @auth/core
npx convex dev
```

Story 1.1's dev implementation wrote the equivalent files directly (rather than running the interactive CLI) because the existing repo already contains planning artifacts that `create-next-app` would refuse to overwrite. The resulting project structure matches what the CLI produces, with the addition of `concurrently` for the `dev:all` script and the Convex Auth package pre-wired.

## Superseded by

None.

## Related ADRs

- ADR-0002 (RBAC pattern — Story 1.2)
- ADR-0003 (PDF library choice — Story 3.11)
- ADR-0004 (Map renderer Phase 1 SVG — Story 1.12)
- ADR-0007 (PII encryption — Story 2.8)
- ADR-0008 (Backup retention — Story 5.6)
- ADR-0010 (Email provider — Story 3.13)
