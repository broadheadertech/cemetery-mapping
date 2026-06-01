/**
 * Card processor adapter — Story 9.6 (FR33 — card portion).
 *
 * Default Phase 1 recommendation: PayMongo (PH local rails, simple
 * REST API, BIR-friendly). Stripe is the international-card
 * alternative. The actual processor is captured in ADR-0011 once the
 * cemetery business confirms — the structural code here does not
 * change either way.
 *
 * 3-D Secure / SCA: the gateway's hosted page handles the auth
 * challenge transparently. From our side, `createIntent` returns the
 * `redirectUrl` (which may be the 3DS challenge URL on first hit);
 * the webhook arrives once the full flow completes. No special
 * 3DS-specific handling here.
 *
 * Signature scheme is the same HMAC-SHA256 hex of raw body that GCash
 * + Maya use. The signature header is `x-card-signature`.
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

interface CardWebhookBody {
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
    case "paid":
    case "captured":
      return "succeeded";
    case "failed":
    case "declined":
    case "card_declined":
      return "failed";
    case "expired":
    case "abandoned":
      return "expired";
    default:
      return "unknown";
  }
}

export const cardAdapter: IGatewayAdapter = {
  id: "card",
  signatureHeader: "x-card-signature",
  // Phase 1 default (PayMongo): raw hex HMAC-SHA256 of the raw body.
  // When the processor decision lands on Stripe (ADR-0011), flip this
  // tag to `"stripe"` and the adapter's `verifyWebhookSignature` body
  // switches branches via `parseSignature`. The four schemes
  // (`raw-hex`, `raw-base64`, `stripe`, `svix`) cover the PSP market
  // we are likely to choose from. P0-2 fix.
  signatureScheme: "raw-hex",

  async createIntent(
    args: GatewayCreateIntentArgs,
  ): Promise<GatewayCreateIntentResult> {
    const base = process.env.CARD_API_BASE_URL ?? "";
    if (base.length === 0) {
      // Production refuses to fall through to the mock URL — see the
      // matching guard in `gcashAdapter.ts` (P0-1).
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "configuration_error: CARD_API_BASE_URL is not set in production",
        );
      }
      const params = new URLSearchParams({
        intent: args.paymentIntentId,
        provider: "card",
        amount: String(args.amountCents),
        return: args.returnUrl,
      });
      return {
        redirectUrl: `/portal/pay/mock-gateway?${params.toString()}`,
        gatewayIntentId: `card_sandbox_${args.paymentIntentId}`,
        expiresAt: Date.now() + 60 * 60 * 1000,
      };
    }
    const response = await fetch(`${base}/payment_intents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.CARD_API_KEY ?? ""}`,
      },
      body: JSON.stringify({
        amount: args.amountCents,
        currency: args.currency,
        client_reference_id: args.paymentIntentId,
        return_url: args.returnUrl,
        metadata: args.metadata,
      }),
    });
    if (!response.ok) {
      throw new Error(`card createIntent failed: HTTP ${response.status}`);
    }
    const json = (await response.json()) as unknown;
    if (!isRecord(json)) {
      throw new Error("card createIntent returned non-object body");
    }
    const redirectUrl =
      readString(json, "next_action_url") ??
      readString(json, "redirectUrl") ??
      readString(json, "redirect_url");
    const gatewayIntentId = readString(json, "id") ?? readString(json, "intentId");
    if (redirectUrl === undefined || gatewayIntentId === undefined) {
      throw new Error("card createIntent missing redirectUrl / id");
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
      throw new Error("card webhook body is not an object");
    }
    const b = body as CardWebhookBody;
    const paymentIntentId = b.paymentIntentId;
    const gatewayTransactionId = b.transactionId;
    const amountCents = b.amountCents;
    if (typeof paymentIntentId !== "string" || paymentIntentId.length === 0) {
      throw new Error("card webhook missing paymentIntentId");
    }
    if (
      typeof gatewayTransactionId !== "string" ||
      gatewayTransactionId.length === 0
    ) {
      throw new Error("card webhook missing transactionId");
    }
    if (typeof amountCents !== "number" || !Number.isFinite(amountCents)) {
      throw new Error("card webhook missing/invalid amountCents");
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
