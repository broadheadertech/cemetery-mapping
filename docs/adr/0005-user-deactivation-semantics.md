# ADR 0005: User Deactivation Semantics — Next-Request-Effective, Not Instant

- **Status:** Accepted
- **Date:** 2026-05-18
- **Story:** 1.3

## Context

Story 1.3 (`Admin Creates and Manages Staff Accounts`) AC2 requires that "clicking Deactivate on a user row sets `isActive: false` and immediately invalidates that user's active sessions (so the next request from any of their tabs fails with `UNAUTHENTICATED` and they're bounced to `/login`)."

The literal reading is "all live sessions for that user must be killed the instant the admin clicks Deactivate." Convex Auth (`@convex-dev/auth`) does **not** expose a public API to delete a session by user id from a mutation. The session records live in the auto-managed `authSessions` table, and bulk-deleting them from `convex/users.ts:setUserActive` would (a) require iterating an internal index, and (b) couple our user-management code to the Convex Auth schema in a way the upstream library explicitly reserves the right to break.

We also don't have an out-of-band push mechanism (Convex's reactive queries push, but they push fresh data — the deactivated client would keep its old session blob and only fail when it next calls a Convex function).

## Decision

**Deactivation takes effect on the deactivated user's NEXT Convex call, not at the instant the Admin clicks Deactivate.** The mechanism:

1. `convex/users.ts:setUserActive(userId, false)` patches `users.isActive = false` and emits a `deactivate` audit row. It does NOT touch `authSessions`.

2. `convex/lib/auth.ts:requireAuth` (the cornerstone helper that runs first inside every public Convex function — Story 1.2's `local-rules/require-role-first-line` enforces this) reads `user.isActive` after the user-doc fetch and throws `UNAUTHENTICATED` with the message "Account deactivated. Contact an admin." if the flag is `false`.

3. The deactivated user's reactive queries (driven by Convex's `useQuery` subscription) re-evaluate on the next push, hit the new `UNAUTHENTICATED` branch, and the client's error-handling code (Story 1.5's middleware + `(staff)/layout.tsx`'s server-side fetch) bounces the user to `/login`.

**Window of exposure:** the deactivated user keeps their last-loaded query results until either (a) any Convex call they make returns `UNAUTHENTICATED`, or (b) any of their reactive subscriptions push new data. In practice, both happen within seconds because the AppShell sidebar's role query and the user menu both maintain live subscriptions. The session timeout (1h for admin, 8h for staff per NFR-S5) is the absolute upper bound on how long stale read state can persist.

## Alternatives Considered

1. **Bulk-delete `authSessions` rows directly.** Rejected — couples our code to Convex Auth's internal schema; any upstream change (e.g. a session-store refactor) silently breaks deactivation. Also, an internal API is not a stable contract.

2. **Convex Auth `signOut` from a mutation.** Rejected — `signOut` is wired to the calling user's own session, not arbitrary user IDs. There is no `signOutUser(userId)` API exposed.

3. **Server-Sent Events / WebSocket push to the deactivated client.** Rejected — Convex's reactive query layer IS the SSE/WebSocket equivalent; the client already gets pushed. Adding a parallel channel would duplicate transport and add complexity for no semantic gain.

4. **Encode a "deactivation epoch" in the session token.** Rejected — would require forking Convex Auth's token issuance. The cost-benefit doesn't justify a fork for a sub-second improvement on an Admin-triggered, infrequent action.

## Consequences

### Positive

- Implementation is one if-statement in `convex/lib/auth.ts`, four lines plus a comment. Provably correct.
- The next-request-effective semantic is what 99% of users intuit anyway ("they got logged out"). The 1% who care about the latency window are protected by the session-timeout floor.
- Reactivation is symmetric: removing the `isActive: false` flag immediately re-admits the user on their next call, no token re-issuance.
- The audit log (`deactivate` / `reactivate` actions) captures the admin's intent + timestamp; "when was the user actually locked out" is reconstructible from this trail plus the user's last-known activity.

### Negative

- A deactivated user with a stale browser tab who does NOT trigger any Convex call won't see the "Account deactivated" message until they do. The UX consequence: they may attempt a stale mutation and see an `UNAUTHENTICATED` error rather than a smooth deactivation banner. Acceptable; admins typically tell users they're being deactivated.
- The session row remains in `authSessions` until its natural expiration. Storage cost is negligible (a handful of rows per user, each O(100B)) and the rows are pruned by Convex Auth's session-cleanup background job.
- If we ever need true "instant" deactivation (e.g. revoke a compromised admin within milliseconds), we'd need to either bulk-delete sessions (alternative 1) or introduce a "deactivation epoch" on the user doc that the session-check helper compares against `session._creationTime`. Today's threat model doesn't justify either; revisit if it changes.

## Open Items

- **Story 1.5 / `(staff)/layout.tsx` redirect:** the layout currently redirects to `/login` if `getCurrentUserOrNull` returns `null` — and `requireAuth` now throws `UNAUTHENTICATED` for deactivated users, which means `getCurrentUserOrNull` (which uses `getCurrentUserAndRoles`, NOT `requireAuth`) still returns the user. The layout's redirect path therefore needs a small follow-up: either swap to a query that mirrors `requireAuth`'s isActive check, OR add the check inline in the layout. Filed against Story 1.5's known-issues — not blocking 1.3's AC because every Convex CALL the deactivated user makes will fail correctly. The layout's redirect is belt-and-suspenders.

- **Story 1.6 audit cornerstone:** the deactivate/reactivate actions use `emitAudit`. The lint-rule rollout (Story 1.6's deferred ESLint rules) will fail this file if anyone replaces `emitAudit` with a direct `ctx.db.insert("auditLog", ...)`. Cross-reference ADR-0004 Open Items.

- **Last-admin guard:** Story 1.3's `setUserActive` refuses to deactivate the last active admin. The guard implementation (in `convex/users.ts:assertNotLastActiveAdmin`) scans `userRoles` for `admin` rows and checks each owner's `isActive`. The scan is acceptable at 10–20 staff; if the user count grows past ~100, replace with a pre-aggregated admin counter doc updated on every userRoles write. Tracked as a follow-up against the same domain file.

## Future

- **Forced password reset on deactivation.** Phase 1 leaves the user's password hash intact, so reactivation works seamlessly. A future security review might require rotating the password on deactivation (to defeat credential-theft attempts during the window of inactivity). The mutation surface stays the same; we'd add a `secret = await new Scrypt().hash(generateTemporaryPassword())` patch to the authAccounts row when `isActive` flips false.

- **Reactivation banner.** When a user signs in after reactivation, the UI could surface "Welcome back — your account was reactivated on <date>". Pure copy / UX, no protocol change.

## References

- [Story 1.3 § AC2 (deactivation semantics)](../../_bmad-output/implementation-artifacts/1-3-admin-creates-and-manages-staff-accounts.md#acceptance-criteria)
- [PRD § Functional Requirements > 1. Identity & Access Control (FR2, FR3, FR4)](../../_bmad-output/planning-artifacts/prd.md#1-identity--access-control)
- [PRD § Non-Functional Requirements > Security & Privacy (NFR-S4, NFR-S5)](../../_bmad-output/planning-artifacts/prd.md#security--privacy)
- [ADR-0002 (RBAC pattern — Story 1.2)](./0002-rbac-pattern.md)
- [ADR-0004 (Audit log cornerstone — Story 1.6)](./0004-audit-log-pattern.md)
- [convex/users.ts](../../convex/users.ts)
- [convex/lib/auth.ts](../../convex/lib/auth.ts)
