/**
 * GCash payment gateway adapter — Story 9.5 (FR33 — GCash portion).
 *
 * Implements the `IGatewayAdapter` contract for GCash. Phase 1 ships a
 * SANDBOX / MOCK-friendly shape: `createIntent` returns a redirect URL
 * pointing at the in-app `/portal/pay/mock-gateway/[intentId]?provider=gcash`
 * placeholder so the end-to-end happy path is exercisable in dev /
 * sandbox without GCash merchant credentials. At credential-swap
 * (go-live) the implementation switches to a real fetch against the
 * GCash merchant API; the structural code (signature header name,
 * normalised event shape, idempotency anchor on `paymentIntentId`)
 * does not change.
 *
 * Signature scheme — HMAC-SHA256 hex of the raw request body using
 * `GCASH_WEBHOOK_SECRET`. Verify-before-parse:
 *   1. Read raw body via `req.text()`.
 *   2. Compute expected = HMAC-SHA256(rawBody, secret).hex().
 *   3. Constant-time compare against the signature header.
 *   4. ONLY THEN `JSON.parse(rawBody)`.
 *
 * See `docs/runbook.md` § "GCash integration" for the credential-swap
 * procedure + sandbox / production env-var separation.
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

/**
 * GCash-native event shape (Phase 1 / sandbox-friendly).
 *
 * The shape mirrors what the GCash sandbox returns at the time of
 * writing; real-world fields may evolve. Adapter quirks (status
 * string drift, envelope wrapping) stay encapsulated in this
 * parser so downstream code only sees the normalised shape.
 */
interface GcashWebhookBody {
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

function readNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Maps GCash-native status strings onto the normalised shape. Unknown
 * statuses collapse to `"unknown"` — the handler treats those as
 * no-ops rather than tearing down a valid intent (defense against
 * gateway adding a new event class).
 */
function mapStatus(raw: string | undefined): NormalizedGatewayWebhookEvent["status"] {
  switch ((raw ?? "").toLowerCase()) {
    case "succeeded":
    case "success":
    case "paid":
    case "completed":
      return "succeeded";
    case "failed":
    case "failure":
    case "declined":
      return "failed";
    case "expired":
    case "timeout":
      return "expired";
    default:
      return "unknown";
  }
}

export const gcashAdapter: IGatewayAdapter = {
  id: "gcash",
  signatureHeader: "x-gcash-signature",
  // GCash (PH local rails) uses a raw lowercase hex HMAC-SHA256 of the
  // raw body. The header may optionally carry a `sha256=` prefix which
  // `parseSignature` strips. P0-2: we do NOT lowercase the whole
  // header any more — that would corrupt base64 / multi-part schemes
  // if a future GCash version migrates to one.
  signatureScheme: "raw-hex",

  async createIntent(
    args: GatewayCreateIntentArgs,
  ): Promise<GatewayCreateIntentResult> {
    // Phase 1 / sandbox: route the customer to the in-app mock gateway
    // page. The mock page presents Confirm / Decline buttons that fire
    // a test-side webhook via the runbook's "manual replay" path.
    //
    // Production swap: replace this block with a `fetch` against the
    // GCash merchant API using `process.env.GCASH_API_KEY` +
    // `process.env.GCASH_API_BASE_URL`. The returned `redirectUrl`
    // becomes GCash's hosted checkout URL; `gatewayIntentId` becomes
    // GCash's intent reference.
    const base = process.env.GCASH_API_BASE_URL ?? "";
    if (base.length === 0) {
      // Production refuses to fall through to the mock URL — the
      // mock-gateway page is dev / sandbox only (P0-1 adversarial
      // review). A missing `GCASH_API_BASE_URL` in production is a
      // configuration error; surface it loudly via the action's
      // failure-mapping (which whitelists the message into a fixed
      // customer-facing string).
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "configuration_error: GCASH_API_BASE_URL is not set in production",
        );
      }
      // Sandbox / mock path.
      const params = new URLSearchParams({
        intent: args.paymentIntentId,
        provider: "gcash",
        amount: String(args.amountCents),
        return: args.returnUrl,
      });
      return {
        redirectUrl: `/portal/pay/mock-gateway?${params.toString()}`,
        gatewayIntentId: `gcash_sandbox_${args.paymentIntentId}`,
        expiresAt: Date.now() + 60 * 60 * 1000,
      };
    }
    // Production fetch path. The shape mirrors common gateway APIs —
    // the calling action validates the HTTP status + JSON body shape
    // before returning to the mutation. Errors here bubble back to
    // the mutation which rolls back the `paymentIntents` insert.
    const response = await fetch(`${base}/intents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.GCASH_API_KEY ?? ""}`,
      },
      body: JSON.stringify({
        amount_cents: args.amountCents,
        currency: args.currency,
        merchant_reference: args.paymentIntentId,
        return_url: args.returnUrl,
        metadata: args.metadata,
      }),
    });
    if (!response.ok) {
      throw new Error(`gcash createIntent failed: HTTP ${response.status}`);
    }
    const json = (await response.json()) as unknown;
    if (!isRecord(json)) {
      throw new Error("gcash createIntent returned non-object body");
    }
    const redirectUrl = readString(json, "redirectUrl") ?? readString(json, "redirect_url");
    const gatewayIntentId = readString(json, "id") ?? readString(json, "intentId");
    if (redirectUrl === undefined || gatewayIntentId === undefined) {
      throw new Error("gcash createIntent missing redirectUrl / id");
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
    // Both `expected` and `parsed.value` are already lowercase hex
    // (the parser canonicalised the hex digits); we use the
    // constant-time compare to defeat timing oracles.
    return constantTimeEqual(expected, parsed.value);
  },

  parseWebhookPayload(body: unknown): NormalizedGatewayWebhookEvent {
    if (!isRecord(body)) {
      throw new Error("gcash webhook body is not an object");
    }
    const b = body as GcashWebhookBody;
    const paymentIntentId = b.paymentIntentId;
    const gatewayTransactionId = b.transactionId;
    const amountCents = b.amountCents;
    if (typeof paymentIntentId !== "string" || paymentIntentId.length === 0) {
      throw new Error("gcash webhook missing paymentIntentId");
    }
    if (
      typeof gatewayTransactionId !== "string" ||
      gatewayTransactionId.length === 0
    ) {
      throw new Error("gcash webhook missing transactionId");
    }
    if (typeof amountCents !== "number" || !Number.isFinite(amountCents)) {
      throw new Error("gcash webhook missing/invalid amountCents");
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

// Re-export for tests + downstream code that imports the helpers
// alongside the adapter. The `readNumber` helper is currently
// unreferenced (a forward-compat hook for future status-payload
// fields); export silently to keep tree-shake friendly.
export { readNumber };
