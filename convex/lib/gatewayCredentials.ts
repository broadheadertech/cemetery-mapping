/**
 * Where payment-gateway credentials come from.
 *
 * Two sources, in a fixed order:
 *
 *   1. **Environment variables** — `<GATEWAY>_API_BASE_URL`,
 *      `<GATEWAY>_API_KEY`, `<GATEWAY>_WEBHOOK_SECRET`. When the base
 *      URL is set in the environment, that source wins outright and
 *      the database row is ignored.
 *   2. **The `paymentGatewayConfig` table** — set by an admin at
 *      `/admin/settings/payment-gateways`.
 *
 * Env-first, deliberately. Storing an API key in the database is a
 * weaker posture than keeping it in the Convex environment (see the
 * table's schema comment for the full trade-off), so an operator who
 * wants the stricter arrangement gets it simply by setting the env
 * vars — no flag, no migration, and no way for a later UI edit to
 * silently override what ops configured. The table exists so a
 * cemetery with no developer on staff can still get set up and still
 * rotate a leaked secret the same afternoon.
 *
 * A gateway is "configured" when a base URL resolves from either
 * source. Without one, the adapters fall back to the in-app mock
 * checkout outside production, and refuse outright inside it.
 */

import { type DataModelFromSchemaDefinition } from "convex/server";

import schema from "../schema";
import type { MutationCtx, QueryCtx } from "./auth";
import type { GatewayId } from "./paymentGateways/types";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type GatewayConfigDoc = DataModel["paymentGatewayConfig"]["document"];

export interface GatewayCredentials {
  apiBaseUrl: string;
  apiKey: string;
  webhookSecret: string;
  /** Whether an admin has switched this gateway on. */
  isEnabled: boolean;
  mode: "sandbox" | "live";
  /** Which source supplied the values, for the admin page and errors. */
  source: "env" | "database" | "unset";
}

function envOf(gateway: GatewayId, suffix: string): string {
  const env = typeof process !== "undefined" ? process.env : undefined;
  if (env === undefined) return "";
  const raw = env[`${gateway.toUpperCase()}_${suffix}`];
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Resolve one gateway's credentials. Reads the config table only when
 * the environment does not supply a base URL.
 *
 * Returns the SECRETS IN CLEAR. Everything this touches must stay
 * server-side: adapter `fetch` calls and webhook HMAC verification.
 * Never hand the result to a query or mutation that a client awaits —
 * `getGatewayConfigSummaries` is the client-facing view.
 */
export async function resolveGatewayCredentials(
  ctx: QueryCtx | MutationCtx,
  gateway: GatewayId,
): Promise<GatewayCredentials> {
  const envBase = envOf(gateway, "API_BASE_URL");
  if (envBase.length > 0) {
    return {
      apiBaseUrl: envBase,
      apiKey: envOf(gateway, "API_KEY"),
      webhookSecret: envOf(gateway, "WEBHOOK_SECRET"),
      // An operator who set the env vars meant to turn it on. There is
      // no env-side off switch, and inventing one would be a second
      // way to disable a gateway that the admin page cannot see.
      isEnabled: true,
      mode: "live",
      source: "env",
    };
  }

  const row = await ctx.db
    .query("paymentGatewayConfig")
    .withIndex("by_gateway", (q) => q.eq("gateway", gateway))
    .first();

  if (row === null || row.apiBaseUrl.trim().length === 0) {
    return {
      apiBaseUrl: "",
      apiKey: "",
      // The webhook secret can still come from the environment even
      // with no base URL: receiving webhooks and creating intents are
      // separate capabilities, and a deployment may verify callbacks
      // while intents are created elsewhere.
      webhookSecret: envOf(gateway, "WEBHOOK_SECRET"),
      isEnabled: false,
      mode: "sandbox",
      source: "unset",
    };
  }

  return {
    apiBaseUrl: row.apiBaseUrl.trim(),
    apiKey: row.apiKey,
    webhookSecret:
      row.webhookSecret.length > 0
        ? row.webhookSecret
        : envOf(gateway, "WEBHOOK_SECRET"),
    isEnabled: row.isEnabled,
    mode: row.mode,
    source: "database",
  };
}

/**
 * Last four characters of a secret, for display.
 *
 * Anything shorter than 8 characters shows as `••••` with no tail —
 * revealing the back half of a short secret gives away too much of it,
 * and a secret that short is a configuration mistake worth noticing
 * rather than rendering prettily.
 */
export function maskSecret(secret: string): string {
  if (secret.length === 0) return "";
  if (secret.length < 8) return "••••";
  return `••••${secret.slice(-4)}`;
}

/**
 * Client-safe projection of a stored config row. The only function
 * that should ever shape a config row for a client.
 */
export interface GatewayConfigSummary {
  gateway: GatewayId;
  apiBaseUrl: string;
  apiKeyMasked: string;
  webhookSecretMasked: string;
  hasApiKey: boolean;
  hasWebhookSecret: boolean;
  isEnabled: boolean;
  mode: "sandbox" | "live";
  source: "env" | "database" | "unset";
  updatedAt: number | null;
}

export function toSummary(
  gateway: GatewayId,
  credentials: GatewayCredentials,
  row: GatewayConfigDoc | null,
): GatewayConfigSummary {
  return {
    gateway,
    apiBaseUrl: credentials.apiBaseUrl,
    apiKeyMasked: maskSecret(credentials.apiKey),
    webhookSecretMasked: maskSecret(credentials.webhookSecret),
    hasApiKey: credentials.apiKey.length > 0,
    hasWebhookSecret: credentials.webhookSecret.length > 0,
    isEnabled: credentials.isEnabled,
    mode: credentials.mode,
    source: credentials.source,
    updatedAt: row?.updatedAt ?? null,
  };
}
