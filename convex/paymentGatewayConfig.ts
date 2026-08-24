/**
 * Payment-gateway credentials — admin surface plus the internal
 * resolver the server side uses.
 *
 * Backs `/admin/settings/payment-gateways`. The reason it exists is
 * operational rather than technical: the adapters already had live
 * fetch paths, but their credentials came from
 * `<GATEWAY>_API_BASE_URL` / `_API_KEY` / `_WEBHOOK_SECRET` in the
 * process environment, which means `npx convex env set` from a
 * developer's terminal. The cemetery has no developer on staff, so
 * go-live and every subsequent key rotation would have required
 * calling one. A webhook secret nobody on site can rotate is a secret
 * that never gets rotated.
 *
 * ## The one rule
 *
 * **No secret ever crosses to a client.** `listGatewayConfigs` returns
 * masked previews. `internal_getCredentials` returns the real values
 * and is an INTERNAL query — reachable from a server-side action or
 * HTTP route, never from a browser. If you add a function here, decide
 * which of those two it is before you write the handler.
 *
 * Env vars still win when set; see `convex/lib/gatewayCredentials.ts`
 * for why that direction and not the other.
 */

import {
  type DataModelFromSchemaDefinition,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import { emitAudit } from "./lib/audit";
import { ErrorCode, throwError } from "./lib/errors";
import {
  type GatewayConfigSummary,
  type GatewayCredentials,
  resolveGatewayCredentials,
  toSummary,
} from "./lib/gatewayCredentials";
import { type GatewayId } from "./lib/paymentGateways/types";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type GatewayConfigDoc = DataModel["paymentGatewayConfig"]["document"];

const GATEWAYS: readonly GatewayId[] = ["gcash", "maya", "card"];

const gatewayValidator = v.union(
  v.literal("gcash"),
  v.literal("maya"),
  v.literal("card"),
);

async function rowFor(
  ctx: QueryCtx | MutationCtx,
  gateway: GatewayId,
): Promise<GatewayConfigDoc | null> {
  return await ctx.db
    .query("paymentGatewayConfig")
    .withIndex("by_gateway", (q) => q.eq("gateway", gateway))
    .first();
}

/**
 * All three gateways, masked, for the admin settings page.
 *
 * Always returns one entry per gateway whether or not it has been
 * configured — the page's job is to show the operator the state of
 * every payment route, and an unconfigured gateway is exactly the
 * thing they need to see.
 */
export const listGatewayConfigs = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<GatewayConfigSummary[]> => {
    await requireRole(ctx, ["admin"]);
    const out: GatewayConfigSummary[] = [];
    for (const gateway of GATEWAYS) {
      const credentials = await resolveGatewayCredentials(ctx, gateway);
      out.push(toSummary(gateway, credentials, await rowFor(ctx, gateway)));
    }
    return out;
  },
});

/**
 * Save one gateway's configuration.
 *
 * Secrets are write-only from the UI's perspective: omitting `apiKey`
 * or `webhookSecret` LEAVES THE STORED VALUE ALONE. The admin page
 * cannot show the current secret (by design), so if a blank field
 * meant "clear it", every edit to the base URL would silently wipe the
 * credentials. Clearing is deliberate and explicit — pass an empty
 * string.
 *
 * Audited, with the secrets redacted to booleans. The trail records
 * that a key was rotated and by whom, never what it was rotated to.
 */
export const updateGatewayConfig = mutationGeneric({
  args: {
    gateway: gatewayValidator,
    apiBaseUrl: v.string(),
    /** Omit to keep the stored value; pass "" to clear it. */
    apiKey: v.optional(v.string()),
    /** Omit to keep the stored value; pass "" to clear it. */
    webhookSecret: v.optional(v.string()),
    isEnabled: v.boolean(),
    mode: v.union(v.literal("sandbox"), v.literal("live")),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      gateway: GatewayId;
      apiBaseUrl: string;
      apiKey?: string;
      webhookSecret?: string;
      isEnabled: boolean;
      mode: "sandbox" | "live";
    },
  ): Promise<{ saved: true }> => {
    const auth = await requireRole(ctx, ["admin"]);

    const apiBaseUrl = args.apiBaseUrl.trim();
    if (apiBaseUrl.length > 0 && !/^https:\/\//i.test(apiBaseUrl)) {
      // Plain http would put the API key on the wire in clear.
      throwError(
        ErrorCode.VALIDATION,
        "The API base URL must start with https://.",
        { field: "apiBaseUrl" },
      );
    }
    if (args.isEnabled && apiBaseUrl.length === 0) {
      throwError(
        ErrorCode.VALIDATION,
        "Set an API base URL before enabling this gateway.",
        { field: "apiBaseUrl" },
      );
    }

    const existing = await rowFor(ctx, args.gateway);
    const apiKey = args.apiKey ?? existing?.apiKey ?? "";
    const webhookSecret =
      args.webhookSecret ?? existing?.webhookSecret ?? "";

    if (args.isEnabled && apiKey.length === 0) {
      throwError(
        ErrorCode.VALIDATION,
        "Set an API key before enabling this gateway.",
        { field: "apiKey" },
      );
    }

    const now = Date.now();
    if (existing === null) {
      await ctx.db.insert("paymentGatewayConfig", {
        gateway: args.gateway,
        apiBaseUrl,
        apiKey,
        webhookSecret,
        isEnabled: args.isEnabled,
        mode: args.mode,
        updatedAt: now,
        updatedBy: auth.userId,
      });
    } else {
      await ctx.db.patch(existing._id, {
        apiBaseUrl,
        apiKey,
        webhookSecret,
        isEnabled: args.isEnabled,
        mode: args.mode,
        updatedAt: now,
        updatedBy: auth.userId,
      });
    }

    // Never the values. `emitAudit` redacts known PII keys, but a
    // gateway API key is not PII and would pass straight through —
    // the redaction here is this function's responsibility.
    await emitAudit(ctx, {
      action: "update",
      entityType: "payment",
      entityId: `paymentGatewayConfig:${args.gateway}`,
      reason: `Payment gateway configuration — ${args.gateway}`,
      before:
        existing === null
          ? undefined
          : {
              apiBaseUrl: existing.apiBaseUrl,
              isEnabled: existing.isEnabled,
              mode: existing.mode,
              hasApiKey: existing.apiKey.length > 0,
              hasWebhookSecret: existing.webhookSecret.length > 0,
            },
      after: {
        apiBaseUrl,
        isEnabled: args.isEnabled,
        mode: args.mode,
        hasApiKey: apiKey.length > 0,
        hasWebhookSecret: webhookSecret.length > 0,
        apiKeyRotated:
          args.apiKey !== undefined && args.apiKey !== existing?.apiKey,
        webhookSecretRotated:
          args.webhookSecret !== undefined &&
          args.webhookSecret !== existing?.webhookSecret,
      },
    });

    return { saved: true };
  },
});

/**
 * Resolve one gateway's real credentials for server-side use.
 *
 * INTERNAL. Returns secrets in clear. Callers: the create-intent
 * action and the webhook routes in `convex/http.ts`. Anything that a
 * browser awaits must use `listGatewayConfigs` instead.
 */
export const internal_getCredentials = internalQueryGeneric({
  args: { gateway: gatewayValidator },
  handler: async (
    ctx: QueryCtx,
    args: { gateway: GatewayId },
  ): Promise<GatewayCredentials> => {
    return await resolveGatewayCredentials(ctx, args.gateway);
  },
});
