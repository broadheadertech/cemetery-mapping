import { httpRouter, httpActionGeneric, makeFunctionReference } from "convex/server";
import { auth } from "./auth";
import { adapters, type GatewayId } from "./lib/paymentGateways";

/**
 * Convex HTTP routes.
 *
 * Phase 1 Story 1.1: ONLY the Convex Auth routes (sign-in callbacks,
 * OAuth redirects if any provider needs them).
 *
 * Story 9.5 / 9.6 appended: payment-gateway webhook routes for GCash,
 * Maya, and card. The shape is gateway-agnostic — each adapter (in
 * `convex/lib/paymentGateways/`) provides the per-gateway signature
 * scheme + payload parser; this file's loop registers one route per
 * adapter and delegates to the single `portal:handleGatewayWebhook`
 * internal mutation for atomic posting via `postFinancialEvent`.
 *
 * Route shape — same for every gateway:
 *   1. Read raw body (`req.text()`) — signature schemes are
 *      raw-body-sensitive; do NOT `req.json()`.
 *   2. Read the gateway-specific signature header.
 *   3. Read the gateway-specific env-var secret
 *      (`<GATEWAY>_WEBHOOK_SECRET`).
 *   4. `adapter.verifyWebhookSignature(rawBody, sig, secret)` —
 *      constant-time compare inside the adapter; returns false on
 *      mismatch / empty inputs.
 *   5. On signature failure → 401, no body parsing.
 *   6. On signature success → `JSON.parse(rawBody)` → adapter's
 *      `parseWebhookPayload` normalises to
 *      `NormalizedGatewayWebhookEvent` → `ctx.runMutation` invokes
 *      the internal handler with `(gateway, event)`.
 *   7. Return 200 on success; 500 on internal-mutation throw so the
 *      gateway retries (idempotency anchor inside the mutation
 *      makes retries safe).
 *
 * Per Story 9.5 Dev Notes § NFR-I2 5-second ACK budget: the body of
 * this handler is the synchronous mutation only. Email + PDF
 * delivery are deferred to scheduled actions inside the handler.
 */
const http = httpRouter();

auth.addHttpRoutes(http);

const handleGatewayWebhookRef = makeFunctionReference<
  "mutation",
  {
    gateway: GatewayId;
    event: {
      paymentIntentId: string;
      gatewayTransactionId: string;
      status: "succeeded" | "failed" | "expired" | "unknown";
      amountCents: number;
      currency: string;
      failureReason?: string;
      rawEventId?: string;
    };
  },
  void
>("portal:handleGatewayWebhook");

const GATEWAY_IDS: readonly GatewayId[] = ["gcash", "maya", "card"];

for (const gateway of GATEWAY_IDS) {
  const adapter = adapters[gateway];
  http.route({
    path: `/api/${gateway}-webhook`,
    method: "POST",
    handler: httpActionGeneric(async (ctx, req: Request): Promise<Response> => {
      const rawBody = await req.text();
      const sig = req.headers.get(adapter.signatureHeader) ?? "";
      const secret = process.env[`${gateway.toUpperCase()}_WEBHOOK_SECRET`] ?? "";
      if (secret.length === 0 || sig.length === 0) {
        return new Response("unauthorized", { status: 401 });
      }
      const ok = await adapter.verifyWebhookSignature(rawBody, sig, secret);
      if (!ok) {
        return new Response("unauthorized", { status: 401 });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return new Response("bad request", { status: 400 });
      }
      let event;
      try {
        event = adapter.parseWebhookPayload(parsed);
      } catch {
        return new Response("bad request", { status: 400 });
      }
      try {
        await ctx.runMutation(handleGatewayWebhookRef, { gateway, event });
      } catch {
        // Surface as 500 so the gateway retries. Idempotency anchor
        // inside the mutation (`paymentIntents.completedAt`) makes
        // re-delivery safe — a duplicate that already landed will
        // short-circuit cleanly on the next retry.
        return new Response("internal", { status: 500 });
      }
      return new Response("ok", { status: 200 });
    }),
  });
}

/**
 * Email-bounce webhook — Story 9.8 (FR57, AC3).
 *
 * Receives bounce + spam-complaint events from the email provider
 * (Resend / SendGrid / Postmark per ADR-0013). Hard bounces flip the
 * customer's `emailBouncedAt` flag so subsequent reminder scans skip
 * the address; spam complaints flip `reminderOptOut` to true (a
 * stronger signal than a bounce — the customer asked their mailbox
 * provider to block us).
 *
 * Defensive posture (Story 9.8 § Hard stops):
 *   - Signature verification BEFORE parse. Spoofed bounce events
 *     could mass-disable email reminders in a competitor scenario;
 *     the constant-time HMAC compare in `verifyEmailBounceSignature`
 *     closes the hole.
 *   - When `EMAIL_WEBHOOK_SECRET` is unset, the route REJECTS all
 *     requests (401). Deployment discipline: set the secret before
 *     registering the provider's webhook URL.
 *   - Soft bounces are ignored at this layer — the action's own
 *     retry backoff handles them. Only hard bounces and complaints
 *     reach the mutation.
 *   - Malformed JSON is ACKed with 200 (rather than 4xx) so the
 *     provider does not back off its retry schedule on transient
 *     parse glitches.
 *
 * Provider-agnostic — `parseEmailProviderEvents` normalises the
 * provider's payload to the canonical `{ type, email,
 * providerMessageId, reason }` event shape.
 */
const handleEmailBouncesRef = makeFunctionReference<
  "mutation",
  {
    events: Array<{
      type: string;
      email?: string;
      providerMessageId?: string;
      reason?: string;
    }>;
  },
  {
    processed: number;
    hardBounces: number;
    complaints: number;
    skipped: number;
  }
>("reminders:internal_handleEmailBounces");

http.route({
  path: "/api/email-bounce-webhook",
  method: "POST",
  handler: httpActionGeneric(async (ctx, req: Request): Promise<Response> => {
    const rawBody = await req.text();
    const sig =
      req.headers.get("svix-signature") ??
      req.headers.get("x-webhook-signature") ??
      req.headers.get("x-postmark-signature") ??
      req.headers.get("x-sendgrid-signature") ??
      "";

    // Svix companion headers — `svix-id` is the `msg_id`,
    // `svix-timestamp` is the unix-seconds timestamp. Both contribute
    // to the signed payload `${msg_id}.${timestamp}.${body}`. When
    // either is missing, the Svix verification path falls back to the
    // legacy raw-body formats (SendGrid hex, Postmark base64).
    const svixId = req.headers.get("svix-id") ?? "";
    const svixTimestamp = req.headers.get("svix-timestamp") ?? "";

    const secret =
      typeof process !== "undefined" && process.env !== undefined
        ? process.env.EMAIL_WEBHOOK_SECRET
        : undefined;

    if (
      typeof secret !== "string" ||
      secret.trim().length === 0 ||
      sig.length === 0
    ) {
      return new Response("unauthorized", { status: 401 });
    }

    const ok = await verifyEmailBounceSignature(
      rawBody,
      sig,
      secret.trim(),
      {
        svixId: svixId.length > 0 ? svixId : undefined,
        svixTimestamp: svixTimestamp.length > 0 ? svixTimestamp : undefined,
        nowSeconds: Math.floor(Date.now() / 1000),
      },
    );
    if (!ok) {
      return new Response("unauthorized", { status: 401 });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      console.warn("[email-bounce-webhook] malformed JSON; ack with 200");
      return new Response("ok", { status: 200 });
    }

    const events = parseEmailProviderEvents(parsed);
    if (events.length === 0) {
      return new Response("ok", { status: 200 });
    }

    try {
      await ctx.runMutation(handleEmailBouncesRef, { events });
    } catch (e) {
      console.error(
        "[email-bounce-webhook] mutation failed",
        (e as Error).message,
      );
      return new Response("internal", { status: 500 });
    }
    return new Response("ok", { status: 200 });
  }),
});

/**
 * Allowable Svix timestamp skew, in seconds. Matches the Svix client
 * library default (300s = 5 min). Replayed signatures older than this
 * window are rejected even if otherwise well-formed.
 */
const SVIX_MAX_TIMESTAMP_SKEW_SECONDS = 300;

/**
 * HMAC-SHA256 signature verification for the email-bounce webhook.
 *
 * P0-3 (replaces the loose split-and-try fallback):
 *
 *   1. Svix-formatted header (`svix-signature: v1,<base64sig>
 *      v1,<base64sig>` — space-separated, multi-version):
 *      - The signed payload is `${svix-id}.${svix-timestamp}.${body}`,
 *        NOT the raw body. The `svix-id` + `svix-timestamp` arrive in
 *        SEPARATE request headers; without them we cannot construct
 *        the signed payload, so Svix verification is skipped (the
 *        caller falls through to the legacy raw-body fallbacks).
 *      - Each version segment is `v<n>,<base64sig>`. We accept any
 *        version (Svix rotates versions over time). The comparison is
 *        constant-time base64-byte equality.
 *      - The `svix-timestamp` MUST be within +/- 5 minutes of the
 *        server's clock to bound replay windows. A drifted timestamp
 *        fails verification even if the signature would otherwise
 *        match.
 *
 *   2. Raw-hex format (SendGrid, Postmark configured for hex):
 *      Strip the optional `sha256=` prefix, lowercase, compare hex.
 *
 *   3. Raw-base64 format (Postmark default, some self-hosted setups):
 *      Strip the optional prefix, compare bytes byte-for-byte. Do NOT
 *      lowercase — base64 is case-sensitive.
 *
 * Returns `false` on any verification failure (mismatched signature,
 * malformed input, stale timestamp, etc.). Constant-time compares on
 * equal-length normalised forms guard against signature-timing side
 * channels.
 *
 * Exported for unit-test injection of edge-case headers.
 */
export async function verifyEmailBounceSignature(
  rawBody: string,
  headerValue: string,
  secret: string,
  context?: {
    svixId?: string;
    svixTimestamp?: string;
    nowSeconds?: number;
  },
): Promise<boolean> {
  if (headerValue.length === 0 || secret.length === 0) return false;

  const svixId = context?.svixId;
  const svixTimestamp = context?.svixTimestamp;
  const nowSeconds = context?.nowSeconds ?? Math.floor(Date.now() / 1000);

  // ----- Svix format (preferred) ----------------------------------
  // Header shape: "v1,<base64sig>" (single) or
  // "v1,<base64sig> v1,<base64sig>" (multiple).
  // Requires svix-id + svix-timestamp from companion headers.
  if (
    typeof svixId === "string" &&
    svixId.length > 0 &&
    typeof svixTimestamp === "string" &&
    svixTimestamp.length > 0 &&
    /\bv\d+,/.test(headerValue)
  ) {
    // Reject stale timestamps. Svix recommends a +/- 5 minute window.
    const tsNum = Number.parseInt(svixTimestamp, 10);
    if (!Number.isFinite(tsNum)) return false;
    if (Math.abs(nowSeconds - tsNum) > SVIX_MAX_TIMESTAMP_SKEW_SECONDS) {
      return false;
    }

    // Signed payload is `${msg_id}.${timestamp}.${body}`.
    const signedPayload = `${svixId}.${svixTimestamp}.${rawBody}`;
    const expectedBytes = await hmacSha256Bytes(secret, signedPayload);
    if (expectedBytes === null) return false;

    // Walk every `v<n>,<base64sig>` segment in the header.
    for (const segment of headerValue.split(/\s+/)) {
      const seg = segment.trim();
      if (seg.length === 0) continue;
      const commaIdx = seg.indexOf(",");
      if (commaIdx <= 0) continue;
      const tag = seg.slice(0, commaIdx);
      if (!/^v\d+$/.test(tag)) continue;
      const candidateB64 = seg.slice(commaIdx + 1);
      const candidateBytes = tryDecodeBase64(candidateB64);
      if (candidateBytes === null) continue;
      if (constantTimeEqBytes(candidateBytes, expectedBytes)) return true;
    }
    // A Svix-shaped header that fails to match is a hard failure —
    // do NOT fall through to the legacy fallbacks. The header
    // explicitly committed to the Svix scheme; any other reading
    // would be a downgrade attack vector.
    return false;
  }

  // ----- Legacy fallbacks (raw body signed) -----------------------
  const expectedBytes = await hmacSha256Bytes(secret, rawBody);
  if (expectedBytes === null) return false;

  const stripped = stripSignaturePrefix(headerValue.trim());

  // Raw hex: SendGrid, Postmark hex-configured.
  const hexBytes = tryDecodeHex(stripped);
  if (hexBytes !== null && constantTimeEqBytes(hexBytes, expectedBytes)) {
    return true;
  }

  // Raw base64: Postmark default. Case-sensitive — do NOT lowercase.
  const b64Bytes = tryDecodeBase64(stripped);
  if (b64Bytes !== null && constantTimeEqBytes(b64Bytes, expectedBytes)) {
    return true;
  }

  return false;
}

/**
 * Computes HMAC-SHA256 of `payload` keyed by `secret`. Returns the raw
 * byte digest, or `null` if Web Crypto rejects the operation.
 */
async function hmacSha256Bytes(
  secret: string,
  payload: string,
): Promise<Uint8Array | null> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(payload),
    );
    return new Uint8Array(sig);
  } catch (e) {
    console.error(
      "[email-bounce-webhook] HMAC compute failed",
      (e as Error).message,
    );
    return null;
  }
}

/**
 * Strips an optional algorithm prefix (e.g. `sha256=`) from a
 * signature header value. Returns the remainder unchanged when no
 * prefix is present.
 */
function stripSignaturePrefix(value: string): string {
  const eqIdx = value.indexOf("=");
  if (eqIdx <= 0) return value;
  const head = value.slice(0, eqIdx);
  // Recognised prefixes — keep narrow so an accidental match against
  // a base64 string that happens to contain `=` doesn't truncate the
  // actual signature (base64 uses `=` as padding only at the tail).
  if (/^(sha256|sha512|hmac-sha256|HMAC-SHA256)$/.test(head)) {
    return value.slice(eqIdx + 1);
  }
  return value;
}

/**
 * Parses a hex-encoded byte string. Returns `null` on any non-hex
 * character or odd length.
 */
function tryDecodeHex(value: string): Uint8Array | null {
  const v = value.trim();
  if (v.length === 0 || v.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(v)) return null;
  const out = new Uint8Array(v.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(v.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Parses a base64-encoded byte string. Returns `null` on malformed
 * input. Case-sensitive.
 */
function tryDecodeBase64(value: string): Uint8Array | null {
  const v = value.trim();
  if (v.length === 0) return null;
  try {
    const bin = atob(v);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Constant-time byte-array equality. Returns `false` when lengths
 * differ; runtime is proportional to `min(a, b)` length only when
 * lengths match, masking signature-timing leaks for the common
 * case of equal-length comparisons.
 */
function constantTimeEqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Normalises a provider-specific webhook payload to the canonical
 * `{ type, email, providerMessageId, reason }` event shape consumed
 * by `reminders.internal_handleEmailBounces`.
 *
 * Recognises Resend, SendGrid, and Postmark payload shapes. Unknown
 * providers return an empty array (the handler ACKs 200 without
 * dispatching the mutation).
 *
 * Exported for unit-test coverage of the provider-matrix.
 */
export function parseEmailProviderEvents(payload: unknown): Array<{
  type: string;
  email?: string;
  providerMessageId?: string;
  reason?: string;
}> {
  const out: Array<{
    type: string;
    email?: string;
    providerMessageId?: string;
    reason?: string;
  }> = [];

  // SendGrid: array of events.
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const event = typeof rec.event === "string" ? rec.event : null;
      const type = typeof rec.type === "string" ? rec.type : null;
      if (event === "bounce" && type === "hard") {
        out.push({
          type: "hard_bounce",
          ...(typeof rec.email === "string" ? { email: rec.email } : {}),
          ...(typeof rec.sg_message_id === "string"
            ? { providerMessageId: rec.sg_message_id }
            : {}),
          ...(typeof rec.reason === "string" ? { reason: rec.reason } : {}),
        });
      } else if (event === "spamreport") {
        out.push({
          type: "spam_complaint",
          ...(typeof rec.email === "string" ? { email: rec.email } : {}),
          ...(typeof rec.sg_message_id === "string"
            ? { providerMessageId: rec.sg_message_id }
            : {}),
        });
      }
    }
    return out;
  }

  if (typeof payload !== "object" || payload === null) return out;
  const root = payload as Record<string, unknown>;

  // Resend: single event with `type` discriminator.
  if (typeof root.type === "string") {
    const type = root.type;
    const data =
      typeof root.data === "object" && root.data !== null
        ? (root.data as Record<string, unknown>)
        : {};
    if (type === "email.bounced") {
      const bounce =
        typeof data.bounce === "object" && data.bounce !== null
          ? (data.bounce as Record<string, unknown>)
          : null;
      const isHard =
        bounce !== null &&
        (bounce.type === "hard" || bounce.type === "Permanent");
      if (isHard) {
        const evt: {
          type: string;
          email?: string;
          providerMessageId?: string;
          reason?: string;
        } = { type: "hard_bounce" };
        if (typeof data.email === "string") evt.email = data.email;
        const messageId =
          typeof data.message_id === "string"
            ? data.message_id
            : typeof data.id === "string"
              ? data.id
              : undefined;
        if (messageId !== undefined) evt.providerMessageId = messageId;
        if (typeof bounce.subType === "string") evt.reason = bounce.subType;
        out.push(evt);
      }
    } else if (type === "email.complained") {
      const evt: {
        type: string;
        email?: string;
        providerMessageId?: string;
      } = { type: "spam_complaint" };
      if (typeof data.email === "string") evt.email = data.email;
      if (typeof data.message_id === "string") {
        evt.providerMessageId = data.message_id;
      }
      out.push(evt);
    }
    return out;
  }

  // Postmark: single event with `RecordType` discriminator.
  if (typeof root.RecordType === "string") {
    if (
      root.RecordType === "Bounce" &&
      typeof root.Type === "string" &&
      (root.Type === "HardBounce" || root.Type === "BadEmailAddress")
    ) {
      const evt: {
        type: string;
        email?: string;
        providerMessageId?: string;
        reason?: string;
      } = { type: "hard_bounce" };
      if (typeof root.Email === "string") evt.email = root.Email;
      if (typeof root.MessageID === "string") {
        evt.providerMessageId = root.MessageID;
      }
      if (typeof root.Description === "string") evt.reason = root.Description;
      out.push(evt);
    } else if (root.RecordType === "SpamComplaint") {
      const evt: {
        type: string;
        email?: string;
        providerMessageId?: string;
      } = { type: "spam_complaint" };
      if (typeof root.Email === "string") evt.email = root.Email;
      if (typeof root.MessageID === "string") {
        evt.providerMessageId = root.MessageID;
      }
      out.push(evt);
    }
    return out;
  }

  return out;
}

export default http;
