/**
 * Payment gateway adapter registry — Story 9.5 + 9.6.
 *
 * Single lookup entry point for the `convex/http.ts` webhook routes,
 * the `convex/portal.ts` intent-initiation mutation, and the
 * `convex/actions/gatewayCreateIntent.ts` action. Adding a new
 * gateway is a four-step additive change:
 *
 *   1. Create `convex/lib/paymentGateways/<id>Adapter.ts` exporting an
 *      `IGatewayAdapter` value.
 *   2. Append the gateway id to the `GatewayId` union in `./types.ts`.
 *   3. Append the gateway id to the `paymentIntents.provider`
 *      validator union in `convex/schema.ts`.
 *   4. Wire the adapter into the `adapters` map below.
 *
 * Webhook route registration in `convex/http.ts` is automatic —
 * the route loop reads this map at registration time, so step 4
 * is the only http.ts edit needed.
 *
 * No state lives in this module — the adapter objects are plain
 * exports from their respective files. Importing the registry does
 * not pull in any gateway-specific runtime side effects.
 */

import { cardAdapter } from "./cardAdapter";
import { gcashAdapter } from "./gcashAdapter";
import { mayaAdapter } from "./mayaAdapter";
import { type GatewayId, type IGatewayAdapter } from "./types";

export const adapters: Record<GatewayId, IGatewayAdapter> = {
  gcash: gcashAdapter,
  maya: mayaAdapter,
  card: cardAdapter,
};

/**
 * Returns the adapter for the supplied gateway id. Throws on an
 * unknown id — calling code (the webhook route, the mutation, the
 * action) should never pass an id outside the validated union, so a
 * throw here surfaces a programming bug loudly rather than silently
 * fall back to a default.
 */
export function getAdapter(id: GatewayId): IGatewayAdapter {
  const adapter = adapters[id];
  if (adapter === undefined) {
    throw new Error(`Unknown payment gateway id: ${String(id)}`);
  }
  return adapter;
}

export type { GatewayId, IGatewayAdapter };
export { gcashAdapter, mayaAdapter, cardAdapter };

// Re-export the signature-scheme primitives so tests + future
// adapters don't have to reach into the `./types` submodule path.
export {
  parseSignature,
  hmacSha256Hex,
  hmacSha256Base64,
  constantTimeEqual,
  type ParsedSignature,
} from "./types";
