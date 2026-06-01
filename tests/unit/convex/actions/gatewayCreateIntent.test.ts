/**
 * Story 9.5 / 9.6 — `gatewayCreateIntent` action tests.
 *
 * Focus: P0-3 adversarial review fix — the action's catch block must
 * map any thrown error onto a whitelisted reason token before
 * persisting via `markPaymentIntentFailed`. Raw `error.message` must
 * never reach the customer's browser.
 *
 * What's tested:
 *   - `mapErrorToWhitelistedReason` — direct table-driven assertions
 *     across the four buckets (`gateway_unavailable`,
 *     `validation_failed`, `configuration_error`, `unknown`).
 *   - Action happy path — patches the redirect via the patch mutation
 *     ref. Sanity check that the mock-gateway URL is forwarded.
 *   - Action failure path — when the adapter throws, the action
 *     persists the *whitelisted token*, not the raw message. The full
 *     error is `console.error`-logged for ops.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  gatewayCreateIntent,
  mapErrorToWhitelistedReason,
} from "../../../../convex/actions/gatewayCreateIntent";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerOf(fn: any): (ctx: unknown, args: unknown) => Promise<unknown> {
  for (const key of ["_handler", "handler", "invokeMutation", "invokeQuery"]) {
    const v = fn[key];
    if (typeof v === "function") return v as never;
  }
  if (typeof fn === "function") return fn as never;
  throw new Error("Cannot locate handler on Convex function");
}

describe("gatewayCreateIntent — mapErrorToWhitelistedReason (P0-3)", () => {
  it("recognises configuration_error: prefix", () => {
    expect(
      mapErrorToWhitelistedReason(
        new Error("configuration_error: GCASH_API_BASE_URL is not set"),
      ),
    ).toBe("configuration_error");
  });

  it("recognises gateway_unavailable: prefix", () => {
    expect(
      mapErrorToWhitelistedReason(
        new Error("gateway_unavailable: upstream timeout"),
      ),
    ).toBe("gateway_unavailable");
  });

  it("recognises validation_failed: prefix", () => {
    expect(
      mapErrorToWhitelistedReason(new Error("validation_failed: bad currency")),
    ).toBe("validation_failed");
  });

  it("maps HTTP failure strings to gateway_unavailable", () => {
    expect(
      mapErrorToWhitelistedReason(
        new Error("gcash createIntent failed: HTTP 502"),
      ),
    ).toBe("gateway_unavailable");
    expect(
      mapErrorToWhitelistedReason(
        new Error("maya createIntent failed: HTTP 500"),
      ),
    ).toBe("gateway_unavailable");
  });

  it("maps fetch / network errors to gateway_unavailable", () => {
    expect(mapErrorToWhitelistedReason(new Error("fetch failed"))).toBe(
      "gateway_unavailable",
    );
    expect(mapErrorToWhitelistedReason(new Error("ENOTFOUND api.gcash.com"))).toBe(
      "gateway_unavailable",
    );
  });

  it("maps adapter response-shape failures to gateway_unavailable", () => {
    expect(
      mapErrorToWhitelistedReason(
        new Error("gcash createIntent missing redirectUrl / id"),
      ),
    ).toBe("gateway_unavailable");
    expect(
      mapErrorToWhitelistedReason(
        new Error("maya createIntent returned non-object body"),
      ),
    ).toBe("gateway_unavailable");
  });

  it("collapses validation language to validation_failed", () => {
    expect(mapErrorToWhitelistedReason(new Error("invalid amount"))).toBe(
      "validation_failed",
    );
  });

  it("falls back to unknown for unrecognised strings", () => {
    expect(mapErrorToWhitelistedReason(new Error("internal weirdness"))).toBe(
      "unknown",
    );
    expect(mapErrorToWhitelistedReason("just a string")).toBe("unknown");
    expect(mapErrorToWhitelistedReason(undefined)).toBe("unknown");
  });

  it("never returns a non-whitelisted token", () => {
    const candidates = [
      new Error("foo"),
      new Error("bar bar bar"),
      "raw",
      42,
      null,
      undefined,
      { weird: true },
    ];
    const ALLOWED = new Set([
      "gateway_unavailable",
      "validation_failed",
      "configuration_error",
      "unknown",
    ]);
    for (const c of candidates) {
      expect(ALLOWED.has(mapErrorToWhitelistedReason(c))).toBe(true);
    }
  });
});

describe("gatewayCreateIntent — action handler failure path (P0-3)", () => {
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
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function makeCtx() {
    const calls: Array<{ ref: unknown; args: Record<string, unknown> }> = [];
    return {
      ctx: {
        runMutation: vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
          calls.push({ ref, args });
        }),
      },
      calls,
    };
  }

  it("persists a whitelisted reason (not the raw error message) when the adapter throws in production", async () => {
    // Force the gcashAdapter into its production-throws path by
    // unsetting GCASH_API_BASE_URL + setting NODE_ENV=production.
    vi.stubEnv("NODE_ENV", "production");
    const { ctx, calls } = makeCtx();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const run = handlerOf(gatewayCreateIntent);
    await run(ctx, {
      paymentIntentId: "intent-1",
      gateway: "gcash",
      amountCents: 100,
      currency: "PHP",
      returnUrl: "/portal/pay/return?intent=intent-1",
      contractId: "contract-1",
      customerId: "customer-1",
    });

    // The action should have called markPaymentIntentFailed, NOT
    // patchPaymentIntentRedirect.
    expect(calls).toHaveLength(1);
    const persisted = calls[0]!.args;
    expect(persisted.paymentIntentId).toBe("intent-1");
    // Critical: the persisted reason is the whitelisted token, NOT
    // the raw adapter-throw message containing the env-var name.
    expect(persisted.failureReason).toBe("configuration_error");
    expect(persisted.failureReason).not.toMatch(/GCASH_API_BASE_URL/);

    // The full error is console.error-logged so ops can debug.
    expect(consoleErr).toHaveBeenCalled();
    const logged = consoleErr.mock.calls[0]!;
    expect(logged[0]).toBe("gatewayCreateIntent failure");
  });

  it("happy-path patches the redirect when the adapter returns a sandbox URL", async () => {
    const { ctx, calls } = makeCtx();
    const run = handlerOf(gatewayCreateIntent);
    await run(ctx, {
      paymentIntentId: "intent-2",
      gateway: "gcash",
      amountCents: 100,
      currency: "PHP",
      returnUrl: "/portal/pay/return?intent=intent-2",
      contractId: "contract-1",
      customerId: "customer-1",
    });
    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    expect(args.paymentIntentId).toBe("intent-2");
    expect(args.redirectUrl).toMatch(/^\/portal\/pay\/mock-gateway\?/);
    expect(args.gatewayIntentId).toContain("gcash");
  });
});
