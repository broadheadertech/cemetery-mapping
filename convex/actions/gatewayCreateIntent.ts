"use node";

/**
 * Gateway-intent-creation action — Story 9.5 / 9.6 (FR33).
 *
 * The `convex/portal.ts:createGatewayPaymentIntent` mutation schedules
 * this action via `ctx.scheduler.runAfter(0, ...)` after inserting
 * the `paymentIntents` row. The action's responsibility is narrow:
 *
 *   1. Resolve the gateway adapter from the registry.
 *   2. Call `adapter.createIntent(...)` — Phase 1 sandbox / mock
 *      implementation returns a `/portal/pay/mock-gateway?...` URL;
 *      production swap calls the gateway's hosted-checkout API.
 *   3. Patch the `paymentIntents` row with the gateway-returned
 *      `redirectUrl` + `gatewayIntentId` via an internal mutation
 *      (actions cannot touch `ctx.db` directly).
 *   4. On failure (gateway 4xx / 5xx, network blip), invoke the
 *      `markPaymentIntentFailed` internal mutation so the return
 *      page renders the retry affordance.
 *
 * Why an action (`"use node"`) and not a mutation: the gateway's
 * `createIntent` call is an HTTP fetch with potentially significant
 * latency (sandbox: ms; production: 100ms–2s). Holding the mutation
 * open for that long would block other concurrent writes against
 * `paymentIntents`. The action + internal-mutation pattern keeps the
 * row-insert mutation tight; the action's patch is a separate
 * transaction that does not block anything.
 *
 * Auth contract: this action does not call `requireRole` itself —
 * actions cannot read auth via `ctx.db.query("userRoles")` and the
 * scheduler refuses cross-deployment invocations, so the gating
 * happens in the calling mutation. The action only runs when the
 * mutation has already authorised the caller AND inserted the row.
 *
 * Error surface: any throw inside the action body is caught by the
 * try/catch and surfaced via the `markPaymentIntentFailed` mutation.
 * The customer's return page reads the row reactively and renders
 * "Payment failed — please try again" without a confused waiting
 * state.
 */

import type { GenericActionCtx } from "convex/server";
import { actionGeneric, makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import schema from "../schema";
import type { DataModelFromSchemaDefinition } from "convex/server";
import { getAdapter, type GatewayId } from "../lib/paymentGateways";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ActionCtx = GenericActionCtx<DataModel>;

interface GatewayCreateIntentArgs {
  paymentIntentId: string;
  gateway: GatewayId;
  amountCents: number;
  currency: string;
  returnUrl: string;
  contractId: string;
  customerId: string;
}

/**
 * Internal mutation refs — see comment in `convex/portal.ts` re. the
 * `makeFunctionReference` pattern (no codegen during dev).
 */
const patchPaymentIntentRedirectRef = makeFunctionReference<
  "mutation",
  {
    paymentIntentId: string;
    redirectUrl: string;
    gatewayIntentId: string;
  },
  void
>("portal:patchPaymentIntentRedirect");

const markPaymentIntentFailedRef = makeFunctionReference<
  "mutation",
  { paymentIntentId: string; failureReason: string },
  void
>("portal:markPaymentIntentFailed");

/**
 * Whitelisted failure reasons surfaced to the customer-facing return
 * page. P0-3 adversarial review: never forward raw `error.message`
 * from the action's try/catch to the customer's browser — gateway
 * errors leak stack frames, request paths, and occasionally request
 * payloads that the customer must never see.
 *
 * The mapping is deliberately coarse (four buckets). The full error
 * is `console.error`-logged for ops triage; the customer sees a
 * whitelisted token that the return-page renderer translates to a
 * friendly message.
 */
export type WhitelistedFailureReason =
  | "gateway_unavailable"
  | "validation_failed"
  | "configuration_error"
  | "unknown";

const WHITELISTED_REASONS: ReadonlySet<WhitelistedFailureReason> = new Set([
  "gateway_unavailable",
  "validation_failed",
  "configuration_error",
  "unknown",
]);

/**
 * Map a thrown error onto one of the whitelisted reason tokens.
 * Recognised throw prefixes (e.g. `configuration_error: …`) — see
 * the adapter implementations for the throw shapes — collapse to the
 * matching token. HTTP-fetch failures (`gcash createIntent failed:
 * HTTP 500`, network failures, body-shape failures) collapse to
 * `gateway_unavailable`. Adapter parse-shape failures collapse to
 * `validation_failed`. Everything else is `unknown`.
 *
 * Exported so the unit test asserts the mapping table directly
 * without re-implementing it. Tests stay aligned to the production
 * truth-table.
 */
export function mapErrorToWhitelistedReason(
  error: unknown,
): WhitelistedFailureReason {
  const message =
    error instanceof Error ? error.message : String(error ?? "");
  // Explicit `<token>:` prefix the adapter throws — preserves intent
  // across the boundary without leaking the trailing diagnostic.
  for (const token of WHITELISTED_REASONS) {
    if (message.startsWith(`${token}:`) || message === token) {
      return token;
    }
  }
  if (/^HTTP\s+\d|HTTP\s+\d|HTTP \d|failed: HTTP/i.test(message)) {
    return "gateway_unavailable";
  }
  if (/createIntent (returned|missing)/i.test(message)) {
    return "gateway_unavailable";
  }
  if (/fetch failed|network|ECONN|ENOTFOUND|ETIMEDOUT/i.test(message)) {
    return "gateway_unavailable";
  }
  if (/invalid|missing|validation/i.test(message)) {
    return "validation_failed";
  }
  return "unknown";
}

export const gatewayCreateIntent = actionGeneric({
  args: {
    paymentIntentId: v.string(),
    gateway: v.union(
      v.literal("gcash"),
      v.literal("maya"),
      v.literal("card"),
    ),
    amountCents: v.number(),
    currency: v.string(),
    returnUrl: v.string(),
    contractId: v.string(),
    customerId: v.string(),
  },
  handler: async (
    ctx: ActionCtx,
    args: GatewayCreateIntentArgs,
  ): Promise<void> => {
    // eslint-disable-next-line local-rules/require-role-first-line -- Scheduled-only: `portal.createGatewayPaymentIntent` role-gates the caller before scheduling this action; actions cannot read user auth from ctx.db.
    try {
      const adapter = getAdapter(args.gateway);
      const result = await adapter.createIntent({
        paymentIntentId: args.paymentIntentId,
        amountCents: args.amountCents,
        currency: args.currency,
        returnUrl: args.returnUrl,
        metadata: {
          contractId: args.contractId,
          customerId: args.customerId,
        },
      });
      await ctx.runMutation(patchPaymentIntentRedirectRef, {
        paymentIntentId: args.paymentIntentId,
        redirectUrl: result.redirectUrl,
        gatewayIntentId: result.gatewayIntentId,
      });
    } catch (error) {
      // P0-3: do NOT forward raw `error.message` to the customer.
      // Log the full error for ops triage, persist only a
      // whitelisted token.
      const reason = mapErrorToWhitelistedReason(error);
      console.error("gatewayCreateIntent failure", {
        paymentIntentId: args.paymentIntentId,
        gateway: args.gateway,
        whitelistedReason: reason,
        error: error instanceof Error ? error.message : String(error),
      });
      await ctx.runMutation(markPaymentIntentFailedRef, {
        paymentIntentId: args.paymentIntentId,
        failureReason: reason,
      });
    }
  },
});
