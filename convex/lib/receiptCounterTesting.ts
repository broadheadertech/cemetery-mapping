/**
 * Test-only wrapper around `allocateNextSerial` — Story 3.1.
 *
 * `allocateNextSerial` is a plain TypeScript helper function, not a
 * Convex mutation; it can only be invoked from inside another mutation's
 * handler. To exercise it from a `convex-test` harness we need an
 * `internalMutation` whose body simply calls it and returns the result.
 *
 * Scope of this file:
 *   - NOT a public mutation surface — `internalMutation` only.
 *   - NOT reachable from the client — the Convex client API only exposes
 *     `query` / `mutation` / `action`, never `internal*`.
 *   - Exempt from the `no-direct-receipt-counter-access` ESLint rule
 *     (lives in the allowed-files list inside the rule's source).
 *
 * Runtime note: until `convex/_generated/` exists in this repo (Story 1.6
 * follow-up), `convex-test` cannot import the registered functions by
 * the typed `internal.lib.receiptCounterTesting._testAllocate` reference.
 * The Story 3.1 unit-test suite therefore exercises `allocateNextSerial`
 * directly with a hand-mocked ctx (same pattern as `audit.test.ts` /
 * `auth.test.ts`); the simulated mutation context exercises the same
 * code path as the wrapper would, with the additional ability to
 * synthesise OCC conflicts via injected mocks. The wrapper exists so
 * that the moment `_generated/` lands, a `convex-test`-based 100-fan-out
 * test can drop in without further plumbing.
 */

import { internalMutationGeneric } from "convex/server";

import { type MutationCtx } from "./auth";
import { allocateNextSerial } from "./receiptCounter";

export const _testAllocate = internalMutationGeneric({
  args: {},
  handler: async (
    ctx: MutationCtx,
  ): Promise<{ serial: number; formatted: string }> => {
    return await allocateNextSerial(ctx);
  },
});
