/**
 * Payment gateway adapter tests — Story 9.5 (GCash) + Story 9.6
 * (Maya + card + the adapter abstraction).
 *
 * Three things under test per adapter:
 *
 *   - `verifyWebhookSignature` — accepts a valid signature, rejects
 *     a tampered one. Constant-time-compare implementation detail is
 *     not directly observable here; we assert the boolean outcomes.
 *
 *   - `parseWebhookPayload` — maps the gateway-native event shape
 *     onto the normalised `NormalizedGatewayWebhookEvent`. Tests
 *     cover the happy path (succeeded), each terminal-status string,
 *     unknown-status forward-compat, and the missing-required-fields
 *     rejection paths.
 *
 *   - `createIntent` — Phase 1 sandbox path returns a
 *     `/portal/pay/mock-gateway?...` redirect URL when no
 *     `<GATEWAY>_API_BASE_URL` env var is set. We exercise that path
 *     for each adapter so the route+intent+amount+return query string
 *     stays stable.
 *
 * Adapter registry:
 *   - `getAdapter("gcash" | "maya" | "card")` returns the matching
 *     adapter; the literal-narrowed union means the unknown-id path
 *     is a TypeScript error (the runtime throw is defensive belt-
 *     and-braces and tested via the cast escape).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  adapters,
  cardAdapter,
  gcashAdapter,
  getAdapter,
  mayaAdapter,
  type GatewayId,
} from "../../../convex/lib/paymentGateways";
import {
  constantTimeEqual,
  hmacSha256Base64,
  hmacSha256Hex,
  parseSignature,
} from "../../../convex/lib/paymentGateways/types";

describe("paymentGateways — constantTimeEqual", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
  });

  it("returns false for different lengths", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });

  it("returns false for same-length but different content", () => {
    expect(constantTimeEqual("abc123", "abc124")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("paymentGateways — hmacSha256Hex", () => {
  it("produces a stable digest for known inputs", async () => {
    // Known vector: HMAC-SHA256("hello", "secret") = "88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b"
    const digest = await hmacSha256Hex("hello", "secret");
    expect(digest).toBe(
      "88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b",
    );
  });

  it("produces different digests for different bodies", async () => {
    const a = await hmacSha256Hex("a", "secret");
    const b = await hmacSha256Hex("b", "secret");
    expect(a).not.toBe(b);
  });

  it("produces different digests for different secrets", async () => {
    const a = await hmacSha256Hex("hello", "secret1");
    const b = await hmacSha256Hex("hello", "secret2");
    expect(a).not.toBe(b);
  });
});

describe("paymentGateways — adapter registry", () => {
  it("returns the gcash adapter for gateway id 'gcash'", () => {
    expect(getAdapter("gcash")).toBe(gcashAdapter);
  });

  it("returns the maya adapter for gateway id 'maya'", () => {
    expect(getAdapter("maya")).toBe(mayaAdapter);
  });

  it("returns the card adapter for gateway id 'card'", () => {
    expect(getAdapter("card")).toBe(cardAdapter);
  });

  it("throws on an unknown gateway id", () => {
    expect(() => getAdapter("paypal" as unknown as GatewayId)).toThrow(
      /Unknown payment gateway id/,
    );
  });

  it("exposes the adapter map for direct lookup", () => {
    expect(Object.keys(adapters).sort()).toEqual(["card", "gcash", "maya"]);
  });
});

// ---------------------------------------------------------------------------
// Each adapter — verifyWebhookSignature
// ---------------------------------------------------------------------------

const ADAPTERS = [gcashAdapter, mayaAdapter, cardAdapter];

describe.each(ADAPTERS)("$id adapter — verifyWebhookSignature", (adapter) => {
  it("accepts a valid HMAC-SHA256 signature of the raw body", async () => {
    const body = JSON.stringify({
      paymentIntentId: "intent-1",
      transactionId: "tx-1",
      status: "succeeded",
      amountCents: 100_000,
    });
    const sig = await hmacSha256Hex(body, "test-secret");
    expect(
      await adapter.verifyWebhookSignature(body, sig, "test-secret"),
    ).toBe(true);
  });

  it("rejects a tampered signature", async () => {
    const body = "irrelevant";
    const sig = await hmacSha256Hex(body, "test-secret");
    expect(
      await adapter.verifyWebhookSignature(body, sig + "00", "test-secret"),
    ).toBe(false);
  });

  it("rejects when the body has been tampered with", async () => {
    const body = JSON.stringify({ paymentIntentId: "i1" });
    const sig = await hmacSha256Hex(body, "test-secret");
    expect(
      await adapter.verifyWebhookSignature(
        body + " ", // whitespace flips the digest
        sig,
        "test-secret",
      ),
    ).toBe(false);
  });

  it("rejects an empty secret", async () => {
    const body = "x";
    const sig = await hmacSha256Hex(body, "test-secret");
    expect(await adapter.verifyWebhookSignature(body, sig, "")).toBe(false);
  });

  it("rejects an empty signature header", async () => {
    expect(await adapter.verifyWebhookSignature("x", "", "test-secret")).toBe(
      false,
    );
  });

  it("normalises signature whitespace and casing before compare", async () => {
    const body = "abc";
    const sig = await hmacSha256Hex(body, "test-secret");
    expect(
      await adapter.verifyWebhookSignature(
        body,
        `  ${sig.toUpperCase()}  `,
        "test-secret",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Each adapter — parseWebhookPayload
// ---------------------------------------------------------------------------

describe.each(ADAPTERS)("$id adapter — parseWebhookPayload", (adapter) => {
  function fixture(overrides: Record<string, unknown> = {}): unknown {
    return {
      paymentIntentId: "intent-abc",
      transactionId: "gateway-tx-1",
      status: "succeeded",
      amountCents: 250_000,
      currency: "PHP",
      ...overrides,
    };
  }

  it("normalises a successful event", () => {
    const out = adapter.parseWebhookPayload(fixture());
    expect(out.paymentIntentId).toBe("intent-abc");
    expect(out.gatewayTransactionId).toBe("gateway-tx-1");
    expect(out.status).toBe("succeeded");
    expect(out.amountCents).toBe(250_000);
    expect(out.currency).toBe("PHP");
  });

  it("maps failed/declined/payment_failed to status: failed", () => {
    const out1 = adapter.parseWebhookPayload(fixture({ status: "failed" }));
    expect(out1.status).toBe("failed");
    const out2 = adapter.parseWebhookPayload(fixture({ status: "declined" }));
    expect(out2.status).toBe("failed");
  });

  it("maps expired/timeout to status: expired", () => {
    const out = adapter.parseWebhookPayload(fixture({ status: "expired" }));
    expect(out.status).toBe("expired");
  });

  it("collapses unknown statuses to 'unknown' (forward compat)", () => {
    const out = adapter.parseWebhookPayload(
      fixture({ status: "some_new_event_class_we_dont_know_about" }),
    );
    expect(out.status).toBe("unknown");
  });

  it("defaults currency to PHP when missing", () => {
    const f = fixture();
    delete (f as Record<string, unknown>).currency;
    const out = adapter.parseWebhookPayload(f);
    expect(out.currency).toBe("PHP");
  });

  it("forwards failureReason + rawEventId when present", () => {
    const out = adapter.parseWebhookPayload(
      fixture({
        status: "failed",
        failureReason: "insufficient_funds",
        eventId: "evt-77",
      }),
    );
    expect(out.failureReason).toBe("insufficient_funds");
    expect(out.rawEventId).toBe("evt-77");
  });

  it("throws when paymentIntentId is missing", () => {
    expect(() =>
      adapter.parseWebhookPayload(fixture({ paymentIntentId: undefined })),
    ).toThrow(/paymentIntentId/);
  });

  it("throws when transactionId is missing", () => {
    expect(() =>
      adapter.parseWebhookPayload(fixture({ transactionId: undefined })),
    ).toThrow(/transactionId/);
  });

  it("throws when amountCents is missing or NaN", () => {
    expect(() =>
      adapter.parseWebhookPayload(fixture({ amountCents: undefined })),
    ).toThrow(/amountCents/);
    expect(() =>
      adapter.parseWebhookPayload(fixture({ amountCents: NaN })),
    ).toThrow(/amountCents/);
  });

  it("throws when the body is not an object", () => {
    expect(() => adapter.parseWebhookPayload("not an object")).toThrow();
    expect(() => adapter.parseWebhookPayload(null)).toThrow();
    expect(() => adapter.parseWebhookPayload(42)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Each adapter — createIntent (sandbox path, no env var set)
// ---------------------------------------------------------------------------

describe.each(ADAPTERS)("$id adapter — createIntent (sandbox)", (adapter) => {
  const ENV_KEYS = [
    "GCASH_API_BASE_URL",
    "MAYA_API_BASE_URL",
    "CARD_API_BASE_URL",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns a /portal/pay/mock-gateway URL when no API base URL is set", async () => {
    const result = await adapter.createIntent({
      paymentIntentId: "intent-xyz",
      amountCents: 100_000,
      currency: "PHP",
      returnUrl: "/portal/pay/return?intent=intent-xyz",
      metadata: { contractId: "contract-1", customerId: "customer-1" },
    });
    expect(result.redirectUrl).toMatch(/^\/portal\/pay\/mock-gateway\?/);
    expect(result.redirectUrl).toContain(`intent=intent-xyz`);
    expect(result.redirectUrl).toContain(`provider=${adapter.id}`);
    expect(result.redirectUrl).toContain("amount=100000");
    expect(result.gatewayIntentId).toContain(adapter.id);
    expect(result.gatewayIntentId).toContain("intent-xyz");
  });

  it("throws configuration_error when API base URL is unset AND NODE_ENV=production (P0-1)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      await expect(
        adapter.createIntent({
          paymentIntentId: "intent-prod",
          amountCents: 100_000,
          currency: "PHP",
          returnUrl: "/portal/pay/return?intent=intent-prod",
          metadata: { contractId: "contract-1", customerId: "customer-1" },
        }),
      ).rejects.toThrow(/configuration_error/i);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ---------------------------------------------------------------------------
// P0-2 — parseSignature
// ---------------------------------------------------------------------------

describe("paymentGateways — parseSignature (raw-hex)", () => {
  it("accepts a bare hex digest", () => {
    const parsed = parseSignature(
      "raw-hex",
      "88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b",
    );
    expect(parsed.scheme).toBe("raw-hex");
    if (parsed.scheme === "raw-hex") {
      expect(parsed.value).toBe(
        "88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b",
      );
    }
  });

  it("strips a sha256= prefix (case-insensitive prefix only)", () => {
    const parsed = parseSignature(
      "raw-hex",
      "sha256=88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b",
    );
    expect(parsed.scheme).toBe("raw-hex");
    if (parsed.scheme === "raw-hex") {
      expect(parsed.value).toBe(
        "88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b",
      );
    }
  });

  it("lowercases hex digits (case-insensitive comparison target)", () => {
    const parsed = parseSignature(
      "raw-hex",
      "88AABB3EDE8D3ADF94D26AB90D3BAFD4A2083070C3BCCE9C014EE04A443847C0B",
    );
    expect(parsed.scheme).toBe("raw-hex");
    if (parsed.scheme === "raw-hex") {
      expect(parsed.value).toMatch(/^[0-9a-f]+$/);
    }
  });

  it("rejects non-hex content as invalid", () => {
    const parsed = parseSignature("raw-hex", "not-hex-content");
    expect(parsed.scheme).toBe("invalid");
  });

  it("rejects an empty header as invalid", () => {
    expect(parseSignature("raw-hex", "").scheme).toBe("invalid");
    expect(parseSignature("raw-hex", "   ").scheme).toBe("invalid");
  });
});

describe("paymentGateways — parseSignature (raw-base64) does NOT lowercase", () => {
  it("preserves the case-sensitive base64 alphabet", async () => {
    // Build a known base64 signature; it must include both upper and
    // lower case characters so the test can detect a stray
    // lowercase().
    const body = "hello";
    const secret = "test-secret";
    const sigBase64 = await hmacSha256Base64(body, secret);
    expect(sigBase64).toMatch(/[A-Z]/); // ensure the test vector has uppercase
    const parsed = parseSignature("raw-base64", sigBase64);
    expect(parsed.scheme).toBe("raw-base64");
    if (parsed.scheme === "raw-base64") {
      // Critical: the parser MUST NOT lowercase the value. The
      // original Story 9.5 implementation did `.toLowerCase()` over
      // the header, which would silently corrupt this signature.
      expect(parsed.value).toBe(sigBase64);
      expect(parsed.value).not.toBe(sigBase64.toLowerCase());
    }
  });

  it("strips a sha256= prefix without lowercasing the value", async () => {
    const sigBase64 = await hmacSha256Base64("body", "secret");
    const parsed = parseSignature("raw-base64", `sha256=${sigBase64}`);
    expect(parsed.scheme).toBe("raw-base64");
    if (parsed.scheme === "raw-base64") {
      expect(parsed.value).toBe(sigBase64);
    }
  });

  it("rejects bogus base64 characters as invalid", () => {
    expect(parseSignature("raw-base64", "abc***").scheme).toBe("invalid");
  });
});

describe("paymentGateways — parseSignature (stripe-style)", () => {
  it("parses a t=<unix>,v1=<hex> header", () => {
    const header =
      "t=1234567890,v1=88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b";
    const parsed = parseSignature("stripe", header);
    expect(parsed.scheme).toBe("stripe");
    if (parsed.scheme === "stripe") {
      expect(parsed.timestamp).toBe(1234567890);
      expect(parsed.v1).toBe(
        "88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b",
      );
    }
  });

  it("tolerates extra v0 / legacy keys without breaking", () => {
    const header =
      "t=1700000000,v0=deadbeef,v1=88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b";
    const parsed = parseSignature("stripe", header);
    expect(parsed.scheme).toBe("stripe");
    if (parsed.scheme === "stripe") {
      expect(parsed.timestamp).toBe(1700000000);
      expect(parsed.v1).toBe(
        "88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b",
      );
    }
  });

  it("rejects a header missing the t= component", () => {
    const parsed = parseSignature("stripe", "v1=abc");
    expect(parsed.scheme).toBe("invalid");
  });

  it("rejects a header missing the v1= component", () => {
    const parsed = parseSignature("stripe", "t=1700000000");
    expect(parsed.scheme).toBe("invalid");
  });

  it("rejects a header with a non-numeric timestamp", () => {
    const parsed = parseSignature("stripe", "t=not-a-number,v1=abc");
    expect(parsed.scheme).toBe("invalid");
  });

  it("verifies a Stripe-style HMAC over ${t}.${rawBody}", async () => {
    const rawBody = '{"hello":"world"}';
    const secret = "stripe-secret";
    const t = 1700000000;
    const signed = `${t}.${rawBody}`;
    const v1 = await hmacSha256Hex(signed, secret);
    const header = `t=${t},v1=${v1}`;
    const parsed = parseSignature("stripe", header);
    expect(parsed.scheme).toBe("stripe");
    if (parsed.scheme === "stripe") {
      const recomputed = await hmacSha256Hex(`${parsed.timestamp}.${rawBody}`, secret);
      expect(constantTimeEqual(recomputed, parsed.v1)).toBe(true);
      // Tamper the timestamp — recomputed HMAC no longer matches.
      const tampered = await hmacSha256Hex(`${parsed.timestamp + 1}.${rawBody}`, secret);
      expect(constantTimeEqual(tampered, parsed.v1)).toBe(false);
    }
  });
});

describe("paymentGateways — parseSignature (svix-style)", () => {
  it("parses a v1,<base64> token", async () => {
    const sig = await hmacSha256Base64("msg-id.1700000000.{\"hello\":1}", "wh-secret");
    const header = `v1,${sig}`;
    const parsed = parseSignature("svix", header);
    expect(parsed.scheme).toBe("svix");
    if (parsed.scheme === "svix") {
      expect(parsed.v1Base64).toBe(sig);
    }
  });

  it("parses multi-version space-separated headers", async () => {
    const sigV1 = await hmacSha256Base64("a", "wh-secret");
    const sigV2 = await hmacSha256Base64("b", "wh-secret");
    const header = `v1,${sigV1} v2,${sigV2}`;
    const parsed = parseSignature("svix", header);
    expect(parsed.scheme).toBe("svix");
    if (parsed.scheme === "svix") {
      // We currently honour only v1.
      expect(parsed.v1Base64).toBe(sigV1);
    }
  });

  it("rejects when no v1 token is present", () => {
    const parsed = parseSignature("svix", "v2,abc");
    expect(parsed.scheme).toBe("invalid");
  });

  it("rejects on an empty header", () => {
    expect(parseSignature("svix", "").scheme).toBe("invalid");
  });
});
