# ADR 0002: Server-Side RBAC via `requireRole` + ESLint Enforcement

- **Status:** Accepted
- **Date:** 2026-05-18
- **Story:** 1.2

## Context

NFR-S4 says UI-only authorization is a non-compliance defect: every endpoint must enforce its own authorization server-side, regardless of what the client thinks it's allowed to do. The system has 75 stories ahead of us and at least four roles (admin, office_staff, field_worker, customer). If we rely on every story author remembering to put a permission check at the top of every query / mutation / action, the answer is "we'll forget at least once" — and a single missed check is a hole.

NFR-S5 says session timeouts are per-role: Admin 1h, Office Staff 8h, Field Worker 8h, Customer 30d.

## Decision

1. **One cornerstone helper.** `convex/lib/auth.ts` exports `requireRole(ctx, allowedRoles[])` and a companion `requireAuth(ctx)`. Both return the resolved auth payload (userId, user doc, roles) on success and throw a typed `ConvexError` on failure (`UNAUTHENTICATED` / `INVALID_ROLE` / `FORBIDDEN` / `SESSION_EXPIRED`).

2. **Roles live in a separate `userRoles` table**, not as a column on `users`. One row per role per user. This (a) supports multi-role users (FR3), (b) keeps Convex Auth's internal user shape clean, and (c) makes "list every admin" a single indexed query (`by_user` plus a reverse `by_role` index when needed).

3. **Session timeouts are enforced inside `requireRole`**, not in Convex Auth's static config. Convex Auth's config doesn't express per-role timeouts, so the helper compares the session's `_creationTime` against the role timeout each call. **Multi-role precedence: the strictest (shortest) timeout wins** — a user holding both `admin` and `office_staff` must re-authenticate every hour even when acting as office_staff. Safe default.

4. **ESLint enforces the call.** `local-rules/require-role-first-line` is a custom rule (`eslint-rules/require-role-first-line.js`) that fails the build if any public `query` / `mutation` / `action` in `convex/**` does not call `requireRole` or `requireAuth` as the first awaited statement of its handler. Skipping the call is a CI failure, not a code-review smell.

5. **Exemptions are documented up-front, not discovered later.** The rule excludes:
   - `convex/_generated/**` — auto-generated
   - `convex/lib/**` — server-internal helpers, no client surface
   - `convex/http.ts` — webhook routes (signature-validated separately)
   - `convex/auth.ts`, `convex/auth.config.ts` — auth provider config; calling `requireRole` here would be circular
   - `convex/schema.ts` — schema definition, not a function
   - Any `internalQuery` / `internalMutation` / `internalAction` — server-to-server, no user context

6. **Server-side Next.js auth is a separate boundary.** Next.js server components (e.g. `src/app/(staff)/layout.tsx`) use Convex Auth's Next.js helpers (`convexAuthNextjsToken`) plus `fetchQuery(api.lib.auth.getCurrentUserOrNull)` for the user lookup. The ESLint rule does *not* apply to server components — it applies to Convex functions only.

## Consequences

- **Positive:** A new Convex function that forgets the auth check fails CI before it lands. The rule is mechanical, not memory-dependent. Multi-role precedence avoids accidental privilege upgrades (e.g. an admin acting as office_staff getting the 8h timeout).
- **Positive:** The error namespace (`ErrorCode` constants in `convex/lib/errors.ts`) is reserved for future codes (`ILLEGAL_STATE_TRANSITION` in Story 1.7, `INVARIANT_VIOLATION` in Story 3.2's `postFinancialEvent`). The client error-translation layer (Story 1.4/1.5) maps these codes to user-readable sentences — raw codes never appear in UI text.
- **Negative:** Adds a per-call DB read for the session record. For high-frequency queries this is acceptable; Convex caches reads aggressively within a query.
- **Negative:** Custom ESLint rule adds a touch of complexity to the build. Mitigated by colocating the rule and its tests, plus the upside of catching real bugs.

## Future

- A future story may add a `by_role` index on `userRoles` for "list all admins" queries when the user-management UI (Story 1.3) needs it.
- If activity-based ("sliding window") session timeouts become a requirement, the helper can write `lastActiveAt` to the session record on every call and compare against that instead of `_creationTime`. Today's implementation is absolute-age, which is the simpler and more conservative model.
- Story 1.7 introduces `ILLEGAL_STATE_TRANSITION` as a sibling error code for state-machine guards. The `throwError` shape stays the same.

## References

- [PRD § Identity & Access Control (FR1–FR4)](../../_bmad-output/planning-artifacts/prd.md#1-identity--access-control)
- [PRD § Security & Privacy (NFR-S4, NFR-S5)](../../_bmad-output/planning-artifacts/prd.md#security--privacy)
- [Architecture § Authentication & Security](../../_bmad-output/planning-artifacts/architecture.md#authentication--security)
- [convex/lib/auth.ts](../../convex/lib/auth.ts)
- [convex/lib/errors.ts](../../convex/lib/errors.ts)
- [eslint-rules/require-role-first-line.js](../../eslint-rules/require-role-first-line.js)
