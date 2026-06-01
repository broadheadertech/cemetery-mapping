/**
 * Payment gateway adapter contract — Story 9.5 / 9.6 (FR33).
 *
 * Story 9.5 introduced the GCash webhook + payment-intent pattern.
 * Story 9.6 generalises the per-gateway plumbing behind this
 * `IGatewayAdapter` interface so adding Maya, card processors, or
 * future PSPs is a single-file additive change (a new adapter module
 * + an entry in the `adapters` map in `./index.ts`).
 *
 * Three responsibilities per adapter:
 *
 *   - `createIntent(args)`        — call the gateway's
 *     payment-intent / checkout-session API. Inputs: our
 *     `paymentIntentId` (server-minted UUID, the webhook idempotency
 *     anchor), amount in centavos, and metadata the gateway echoes
 *     back. Output: a redirect URL we hand to the customer's browser
 *     plus the gateway's own intent id for reconciliation. Phase 1
 *     ships MOCK implementations — sandbox / production HTTP calls
 *     are a credential-swap + URL rotation away (the structural code
 *     does not change).
 *
 *   - `verifyWebhookSignature(rawBody, signature, secret)` — verify
 *     the gateway's HMAC of the raw request body. **Constant-time
 *     compare** (`crypto.timingSafeEqual` / WebCrypto equivalent).
 *     Naive `===` comparison is a timing oracle. Each gateway has
 *     its own signature scheme; the adapter encapsulates the
 *     gateway-specific details so `convex/http.ts` stays gateway-
 *     agnostic.
 *
 *   - `parseWebhookPayload(body)` — map the gateway-specific event
 *     shape onto the normalised `NormalizedGatewayWebhookEvent`
 *     shape. Downstream code (the `handleGatewayWebhook` mutation in
 *     `convex/portal.ts`) only knows the normalised shape; adapter
 *     quirks (status string drift, field renaming, nested envelopes)
 *     stay encapsulated.
 *
 * Sandbox-first posture (both stories):
 *
 *   The gateway integrations are designed against sandbox endpoints
 *   from day one. Production credentials swap in at go-live without
 *   structural code changes — env vars + base URLs are the only
 *   moving pieces. See `docs/runbook.md`'s "Payment gateway
 *   integration" section for the swap procedure.
 *
 * Why functional adapter objects (not classes):
 *
 *   Each adapter is stateless — there is no per-instance state to
 *   carry across calls. A plain object literal exported from the
 *   module is simpler to test, easier to mock, and avoids the
 *   accidental-singleton problem class-based adapters tend to invite.
 *   If a particular gateway's SDK requires class instances, hold the
 *   instance inside the module's closure; the exported
 *   `IGatewayAdapter` shape stays functional.
 */

/**
 * The supported gateway discriminator. Adding a gateway requires
 * extending this union AND adding a new adapter file AND wiring it
 * in `./index.ts`. The schema's `paymentIntents.provider` validator
 * mirrors this union exactly.
 */
export type GatewayId = "gcash" | "maya" | "card";

/**
 * Normalised webhook event shape. Every adapter's
 * `parseWebhookPayload` returns this. Downstream code never sees a
 * gateway-native event.
 *
 * Status semantics (strict per Story 9.5 AC3 + Story 9.6 AC3):
 *
 *   - `"succeeded"` — gateway confirms the payment landed. The
 *     webhook handler routes through `postFinancialEvent`.
 *   - `"failed"`    — gateway reports a terminal failure (insufficient
 *     funds, card declined, customer abandoned the GCash auth). The
 *     handler patches `paymentIntents.status = "failed"` and stops.
 *   - `"expired"`   — pending intent timed out. Distinguished from
 *     `failed` so the return page can render a different message.
 *   - `"unknown"`   — adapter could not map the gateway-native status
 *     onto one of the above. Treated as a no-op by the handler
 *     (logged but no state change), so a future gateway adding a new
 *     event class doesn't accidentally tear down a valid intent.
 */
export interface NormalizedGatewayWebhookEvent {
  /** Our server-minted intent id (the idempotency anchor). */
  paymentIntentId: string;
  /** Gateway's own transaction reference. */
  gatewayTransactionId: string;
  status: "succeeded" | "failed" | "expired" | "unknown";
  amountCents: number;
  currency: string;
  failureReason?: string;
  /** Gateway-native event id, for debugging / reconciliation logs. */
  rawEventId?: string;
}

/**
 * Inputs to `createIntent`. The gateway echoes `metadata` back on the
 * webhook so the handler can cross-reference (Phase 1 relies on
 * `paymentIntentId` alone; `metadata` is forward-compatible).
 */
export interface GatewayCreateIntentArgs {
  paymentIntentId: string;
  amountCents: number;
  currency: string;
  returnUrl: string;
  metadata: {
    contractId: string;
    customerId: string;
  };
}

/**
 * Result from `createIntent`. The mutation in `portal.ts` returns
 * `redirectUrl` to the client; `gatewayIntentId` is persisted on the
 * `paymentIntents` row for reconciliation against the gateway's
 * statement.
 */
export interface GatewayCreateIntentResult {
  redirectUrl: string;
  gatewayIntentId: string;
  expiresAt?: number;
}

/**
 * The adapter contract. Every concrete adapter exports an object of
 * this shape.
 *
 * `verifyWebhookSignature` is async because WebCrypto's HMAC-SHA256
 * digest is Promise-returning in both the Convex V8 and Node
 * runtimes. The webhook route is itself an `httpAction` so awaiting
 * the verify call costs nothing structurally.
 */
export interface IGatewayAdapter {
  readonly id: GatewayId;
  /** HTTP header the gateway places its signature in. */
  readonly signatureHeader: string;
  /**
   * Signature-scheme tag — drives the parsing strategy inside
   * `verifyWebhookSignature`. See `parseSignature` for the four
   * supported shapes. Stripe + Svix schemes also consult adapter-
   * specific extra headers (timestamp / message id); the adapter's
   * `verifyWebhookSignature` implementation owns that read because
   * the `convex/http.ts` route only forwards the primary signature
   * header.
   */
  readonly signatureScheme: "raw-hex" | "raw-base64" | "stripe" | "svix";
  createIntent(args: GatewayCreateIntentArgs): Promise<GatewayCreateIntentResult>;
  verifyWebhookSignature(
    rawBody: string,
    signature: string,
    secret: string,
  ): Promise<boolean>;
  parseWebhookPayload(body: unknown): NormalizedGatewayWebhookEvent;
}

/**
 * Helper — constant-time comparison of two hex / base64 strings.
 *
 * Adapter implementations call this from `verifyWebhookSignature`
 * (after stripping any scheme prefix). Implemented as a manual
 * length-then-xor walk so it works in BOTH the Convex V8 runtime
 * (no `Buffer` / `crypto.timingSafeEqual`) and the Node runtime — the
 * webhook route is an `httpAction` which runs on the V8 runtime, so
 * we can't depend on Node-only APIs here.
 *
 * Returns `false` immediately when lengths differ (length itself is
 * not secret; gateway signature lengths are fixed per scheme). For
 * equal-length inputs, walks the full string accumulating XOR into a
 * single byte and returns `acc === 0`.
 *
 * NOTE: This sidesteps the timing-oracle attack class because the
 * loop iterations are constant for any equal-length inputs and the
 * accumulator is OR'd (never short-circuited). The `===` on the
 * accumulator at the end is a single fixed-time comparison.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) {
    acc |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return acc === 0;
}

/**
 * Helper — HMAC-SHA256 hex digest of `rawBody` using `secret`.
 *
 * Uses the WebCrypto API available in both the Convex V8 runtime
 * (the webhook route) and Node. Async because WebCrypto's `sign` is
 * Promise-returning; adapter implementations call it from their
 * (sync) `verifyWebhookSignature` via an internal sync facade is
 * NOT possible — the signature verification path is itself async in
 * the http route. We expose the async helper here and adapters
 * provide an async-friendly `verifyWebhookSignature` when the scheme
 * requires it.
 *
 * For Phase 1 sandbox / mock signatures, adapters use a synchronous
 * length-checked compare so the `IGatewayAdapter.verifyWebhookSignature`
 * surface can stay synchronous (cleaner control flow in the webhook
 * route). When real production HMACs land at credential-swap time,
 * the adapter's `verifyWebhookSignature` body switches to an
 * `await`-able helper without changing the route's wiring (the
 * route's await on the verify call is already there).
 */
export async function hmacSha256Hex(
  rawBody: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const keyBytes = encoder.encode(secret);
  const bodyBytes = encoder.encode(rawBody);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, bodyBytes);
  // Hex encode the resulting bytes.
  const bytes = new Uint8Array(sigBuffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Helper — HMAC-SHA256 base64 digest of `rawBody` using `secret`.
 *
 * Some PSPs (Svix, Stripe-style v2, several PH-local processors)
 * encode their signatures in base64 rather than hex. Base64 is
 * case-sensitive (the alphabet has both upper and lower case), so the
 * "trim + lowercase" normalisation that the original Story 9.5
 * adapter used would silently corrupt a valid signature.
 *
 * The `parseSignature` helper below dispatches on a per-adapter scheme
 * tag so each adapter can compare the right encoding.
 */
export async function hmacSha256Base64(
  rawBody: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const keyBytes = encoder.encode(secret);
  const bodyBytes = encoder.encode(rawBody);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, bodyBytes);
  const bytes = new Uint8Array(sigBuffer);
  // Base64 encode without depending on Node's `Buffer` — Convex's V8
  // runtime does not expose `Buffer`. We use the `btoa` global with
  // a manual byte→latin1 string bridge.
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * Per-adapter signature schemes — P0-2 adversarial review.
 *
 * The original implementation did `signature.trim().toLowerCase()`
 * over the entire header and compared against a hex digest. That
 * normalisation:
 *
 *   - corrupts Stripe-style multi-part headers (`t=…,v1=…`) because
 *     the `=`/`,` separators get folded into the compared blob;
 *   - corrupts base64 signatures because the base64 alphabet is
 *     case-sensitive;
 *   - corrupts Svix-style multi-version headers (`v1,base64 v2,base64`).
 *
 * Each adapter declares its expected scheme via `signatureScheme` (see
 * `IGatewayAdapter` below). `parseSignature` understands the four
 * common shapes:
 *
 *   - `"raw-hex"`    — bare hex digest, optionally prefixed `sha256=`.
 *   - `"raw-base64"` — bare base64 digest, optionally prefixed `sha256=`.
 *   - `"stripe"`     — `t=<unix>,v1=<hex>[,v0=<legacy>]…`; HMAC over
 *                      `${t}.${rawBody}`; hex compare on `v1`.
 *   - `"svix"`       — `v1,<base64> v2,<base64> …` (space-separated);
 *                      HMAC over `${msgId}.${timestamp}.${rawBody}`;
 *                      base64 compare on the `v1` part. The adapter
 *                      supplies `msgId` / `timestamp` from its own
 *                      headers when constructing the signing string.
 *
 * The parser returns a discriminated union so adapters can branch
 * cleanly. Bad / empty inputs produce `{ scheme: "invalid" }` rather
 * than throwing — the adapter caller treats that as "signature
 * verification failed" and returns false.
 */
export type ParsedSignature =
  | { scheme: "raw-hex"; value: string }
  | { scheme: "raw-base64"; value: string }
  | {
      scheme: "stripe";
      timestamp: number;
      v1: string;
    }
  | {
      scheme: "svix";
      v1Base64: string;
    }
  | { scheme: "invalid" };

/**
 * Strip an optional `sha256=` (case-insensitive on the *prefix only*)
 * from a signature value. The prefix is the only piece we may safely
 * normalise — the digest itself stays untouched so base64 case is
 * preserved.
 */
function stripScheme(raw: string): string {
  const m = /^sha256=(.+)$/i.exec(raw);
  return m ? m[1]! : raw;
}

/**
 * Parse a `t=…,v1=…` style header (Stripe). Returns `null` on any
 * parse failure so the caller returns false from verifyWebhookSignature.
 */
function parseStripeHeader(header: string): { timestamp: number; v1: string } | null {
  // Split on `,` and walk the key=value pairs. We do NOT trim/lowercase
  // the values — `v1` is a hex digest (lowercase canonical but we still
  // do a case-sensitive constant-time compare against our own
  // lowercase digest output).
  const parts = header.split(",");
  let timestamp: number | null = null;
  let v1: string | null = null;
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) timestamp = Math.floor(n);
    } else if (key === "v1") {
      if (value.length > 0) v1 = value;
    }
  }
  if (timestamp === null || v1 === null) return null;
  return { timestamp, v1 };
}

/**
 * Parse a Svix-style header — space-separated `v<n>,base64` pairs.
 * We only honour `v1` (the current scheme version); a future scheme
 * bump would add `v2` handling here.
 */
function parseSvixHeader(header: string): { v1Base64: string } | null {
  const tokens = header.split(/\s+/).filter((t) => t.length > 0);
  for (const tok of tokens) {
    // Each token looks like `v1,<base64>`. The base64 may contain
    // `=` padding which is why we split only on the FIRST comma.
    const c = tok.indexOf(",");
    if (c <= 0) continue;
    const version = tok.slice(0, c);
    const value = tok.slice(c + 1);
    if (version === "v1" && value.length > 0) {
      return { v1Base64: value };
    }
  }
  return null;
}

/**
 * Top-level parser. Adapters call this with their declared scheme
 * tag; the dispatch keeps the per-adapter `verifyWebhookSignature`
 * body small.
 */
export function parseSignature(
  scheme: "raw-hex" | "raw-base64" | "stripe" | "svix",
  header: string,
): ParsedSignature {
  // We do trim *whitespace* around the whole header — that is safe
  // for every scheme (Stripe / Svix / raw both define the value as
  // having no surrounding whitespace, and gateways occasionally add a
  // trailing newline). We never `.toLowerCase()` because base64 +
  // multi-part schemes are case-sensitive.
  const trimmed = header.trim();
  if (trimmed.length === 0) return { scheme: "invalid" };

  if (scheme === "raw-hex") {
    const value = stripScheme(trimmed).toLowerCase();
    if (!/^[0-9a-f]+$/.test(value)) return { scheme: "invalid" };
    return { scheme: "raw-hex", value };
  }
  if (scheme === "raw-base64") {
    const value = stripScheme(trimmed);
    // Lightweight base64 sanity check — letters, digits, `+`/`/`/`-`/`_`
    // and `=` padding. We do NOT lowercase.
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
      return { scheme: "invalid" };
    }
    return { scheme: "raw-base64", value };
  }
  if (scheme === "stripe") {
    const parsed = parseStripeHeader(trimmed);
    if (parsed === null) return { scheme: "invalid" };
    return { scheme: "stripe", timestamp: parsed.timestamp, v1: parsed.v1 };
  }
  if (scheme === "svix") {
    const parsed = parseSvixHeader(trimmed);
    if (parsed === null) return { scheme: "invalid" };
    return { scheme: "svix", v1Base64: parsed.v1Base64 };
  }
  return { scheme: "invalid" };
}
