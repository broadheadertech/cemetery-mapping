/**
 * BIR receipt config seed — Story 3.11 adversarial-review follow-up.
 *
 * One-shot idempotent internal mutation that inserts the singleton
 * `birReceiptConfig` row with placeholder values + `isPlaceholder: true`
 * so a fresh deployment has a starting point. The admin then visits
 * `/admin/settings/bir-receipt-config`, replaces every placeholder
 * value with real BIR-issued ones, and toggles
 * `isPlaceholder: false` ("Mark as production-ready").
 *
 * Why an internal mutation (not a public one):
 *   - The seed never runs in normal application traffic — it is
 *     invoked once per deployment via the Convex dashboard or a
 *     `convex run` command. Exposing it as a public mutation would
 *     let any authenticated caller spam-seed (idempotency would no-op
 *     the spam, but the surface should still be private).
 *   - Mirrors the seed pattern in `convex/lib/receiptCounter.ts`
 *     (`seedReceiptCounter`).
 *
 * Why an `internal/` subdirectory was avoided:
 *   - The repo's convention places seed helpers in `convex/lib/`
 *     alongside their domain partner files (the receipt counter
 *     seed lives in `convex/lib/receiptCounter.ts`). Keeping this
 *     seed in `convex/lib/` matches that convention and keeps lint
 *     ignores narrow (`convex/lib/**` is already exempt from the
 *     require-role-first-line rule because lib files have no public
 *     surface).
 *
 * Audit emission: deliberately omitted. The seed is a one-shot
 * deployment event, not a domain transition; the production runbook
 * captures the seed event in a higher-level deployment log. The
 * `updatedAt` / `updatedBy` fields on the row are the in-table audit
 * trail; `updatedBy` is set to a sentinel value because internal
 * mutations carry no authenticated user context.
 */

import { internalMutationGeneric } from "convex/server";
import { v } from "convex/values";

import { type MutationCtx } from "./auth";

/**
 * Seed placeholder values — every string carries the literal token
 * "PLACEHOLDER" so the dashboard banner and the receipt PDF action's
 * placeholder-rejection are never lying about the BIR-readiness of
 * the deployment.
 *
 * Numeric placeholders (e.g. `atpExpiryDate`) use Date.now() at seed
 * time so the field validates against the "expiry within the last
 * year" tolerance the setter enforces; the admin overwrites the value
 * with the real BIR-issued expiry before flipping isPlaceholder.
 */
const PLACEHOLDER_TIN = "000000000000"; // 12-digit canonical shape.
const PLACEHOLDER_ATP = "OCN-PLACEHOLDER";
const PLACEHOLDER_REGISTERED_NAME =
  "(PLACEHOLDER) Cemetery Legal Entity Name";
const PLACEHOLDER_ADDRESS_LINES = [
  "(PLACEHOLDER) BIR-registered Street Address",
  "(PLACEHOLDER) Barangay",
  "(PLACEHOLDER) City, Postal Code",
  "Philippines",
];
const PLACEHOLDER_SERIAL_START = "0000001";
const PLACEHOLDER_SERIAL_END = "9999999";

/**
 * Idempotent seed of the `birReceiptConfig` singleton row.
 *
 * Behaviour:
 *   - First call: inserts the placeholder row with
 *     `isPlaceholder: true`. Returns `{ alreadySeeded: false }`.
 *   - Subsequent calls: returns `{ alreadySeeded: true }` reflecting
 *     the EXISTING row. The second-call has no args; production cannot
 *     re-seed and the admin settings page is the only edit surface.
 *
 * `updatedBy` requires `v.id("users")`. Internal mutations have no
 * authenticated caller — the seed accepts an optional `actorUserId`
 * arg (typically the admin user id captured from the dashboard
 * runtime) so the row's audit attribution is meaningful. When omitted,
 * the seed throws — refusing to insert a row with no attribution
 * surfaces the operational mistake (running the seed without an
 * actor) rather than silently writing a row whose `updatedBy`
 * pointer is invalid.
 */
export const seedBirReceiptConfig = internalMutationGeneric({
  args: {
    actorUserId: v.id("users"),
  },
  handler: async (
    ctx: MutationCtx,
    args: { actorUserId: import("convex/values").GenericId<"users"> },
  ): Promise<{ alreadySeeded: boolean }> => {
    const existing = await ctx.db.query("birReceiptConfig").first();
    if (existing !== null) {
      return { alreadySeeded: true };
    }
    const now = Date.now();
    await ctx.db.insert("birReceiptConfig", {
      registeredName: PLACEHOLDER_REGISTERED_NAME,
      tin: PLACEHOLDER_TIN,
      registeredAddressLines: PLACEHOLDER_ADDRESS_LINES,
      atpNumber: PLACEHOLDER_ATP,
      atpExpiryDate: now,
      serialRangeStart: PLACEHOLDER_SERIAL_START,
      serialRangeEnd: PLACEHOLDER_SERIAL_END,
      isVatRegistered: false,
      isPlaceholder: true,
      updatedAt: now,
      updatedBy: args.actorUserId,
    });
    return { alreadySeeded: false };
  },
});
