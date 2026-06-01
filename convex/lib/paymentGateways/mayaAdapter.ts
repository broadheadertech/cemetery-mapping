/**
 * Maya payment gateway adapter — Story 9.6 (FR33 — Maya portion).
 *
 * Mirrors the GCash adapter's shape. Signature scheme is the same
 * HMAC-SHA256 hex of raw body (the Maya merchant API uses this
 * pattern at the time of writing); the difference vs. GCash is the
 * signature header name (`x-maya-signature`) and the gateway-native
 * status string vocabulary.
 *
 * Phase 1 sandbox / mock-friendly behaviour: `createIntent` returns
 * a redirect URL pointing at the in-app `/portal/pay/mock-gateway?provider=maya&...`
 * placeholder. Production swap at credential availability is a fetch
 * against `process.env.MAYA_API_BASE_URL`.
 *
 * See `docs/runbook.md` § "Maya integration" for the credential-swap
 * procedure.
 */

import {
  type IGatewayAdapter,
  type NormalizedGatewayWebhookEvent,
  type GatewayCreateIntentArgs,
  type GatewayCreateIntentResult,
  constantTimeEqual,
  hmacSha256Hex,
  parseSignature,
} from "./types";

interface MayaWebhookBody {
  paymentIntentId?: string;
  transactionId?: string;
  status?: string;
  amountCents?: number;
  currency?: string;
  failureReason?: string;
  eventId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function mapStatus(raw: string | undefined): NormalizedGatewayWebhookEvent["status"] {
  switch ((raw ?? "").toLowerCase()) {
    case "succeeded":
    case "payment_success":
    case "paid":
      return "succeeded";
    case "failed":
    case "payment_failed":
    case "declined":
      return "failed";
    case "expired":
      return "expired";
    default:
      return "unknown";
  }
}

export const mayaAdapter: IGatewayAdapter = {
  id: "maya",
  signatureHeader: "x-maya-signature",
  // Maya merchant API uses a raw hex HMAC-SHA256 of the raw body
  // (same family as GCash). See `parseSignature` in `./types.ts` for
  // the prefix-stripping + canonicalisation. P0-2 fix.
  signatureScheme: "raw-hex",

  async createIntent(
    args: GatewayCreateIntentArgs,
  ): Promise<GatewayCreateIntentResult> {
    const base = process.env.MAYA_API_BASE_URL ?? "";
    if (base.length === 0) {
      // Production refuses to fall through to the mock URL — see the
      // matching guard in `gcashAdapter.ts` (P0-1).
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "configuration_error: MAYA_API_BASE_URL is not set in production",
        );
      }
      const params = new URLSearchParams({
        intent: args.paymentIntentId,
        provider: "maya",
        amount: String(args.amountCents),
        return: args.returnUrl,
      });
      return {
        redirectUrl: `/portal/pay/mock-gateway?${params.toString()}`,
        gatewayIntentId: `maya_sandbox_${args.paymentIntentId}`,
        expiresAt: Date.now() + 60 * 60 * 1000,
      };
    }
    const response = await fetch(`${base}/checkout`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${process.env.MAYA_API_KEY ?? ""}`,
      },
      body: JSON.stringify({
        totalAmount: { value: args.amountCents, currency: args.currency },
        requestReferenceNumber: args.paymentIntentId,
        redirectUrl: { success: args.returnUrl, failure: args.returnUrl, cancel: args.returnUrl },
        metadata: args.metadata,
      }),
    });
    if (!response.ok) {
      throw new Error(`maya createIntent failed: HTTP ${response.status}`);
    }
    const json = (await response.json()) as unknown;
    if (!isRecord(json)) {
      throw new Error("maya createIntent returned non-object body");
    }
    const redirectUrl = readString(json, "redirectUrl") ?? readString(json, "checkoutId");
    const gatewayIntentId = readString(json, "checkoutId") ?? readString(json, "id");
    if (redirectUrl === undefined || gatewayIntentId === undefined) {
      throw new Error("maya createIntent missing redirectUrl / id");
    }
    return { redirectUrl, gatewayIntentId };
  },

  async verifyWebhookSignature(
    rawBody: string,
    signature: string,
    secret: string,
  ): Promise<boolean> {
    if (secret.length === 0 || signature.length === 0) return false;
    const parsed = parseSignature("raw-hex", signature);
    if (parsed.scheme !== "raw-hex") return false;
    const expected = await hmacSha256Hex(rawBody, secret);
    return constantTimeEqual(expected, parsed.value);
  },

  parseWebhookPayload(body: unknown): NormalizedGatewayWebhookEvent {
    if (!isRecord(body)) {
      throw new Error("maya webhook body is not an object");
    }
    const b = body as MayaWebhookBody;
    const paymentIntentId = b.paymentIntentId;
    const gatewayTransactionId = b.transactionId;
    const amountCents = b.amountCents;
    if (typeof paymentIntentId !== "string" || paymentIntentId.length === 0) {
      throw new Error("maya webhook missing paymentIntentId");
    }
    if (
      typeof gatewayTransactionId !== "string" ||
      gatewayTransactionId.length === 0
    ) {
      throw new Error("maya webhook missing transactionId");
    }
    if (typeof amountCents !== "number" || !Number.isFinite(amountCents)) {
      throw new Error("maya webhook missing/invalid amountCents");
    }
    const result: NormalizedGatewayWebhookEvent = {
      paymentIntentId,
      gatewayTransactionId,
      status: mapStatus(b.status),
      amountCents,
      currency: b.currency ?? "PHP",
    };
    if (typeof b.failureReason === "string" && b.failureReason.length > 0) {
      result.failureReason = b.failureReason;
    }
    if (typeof b.eventId === "string" && b.eventId.length > 0) {
      result.rawEventId = b.eventId;
    }
    return result;
  },
};
