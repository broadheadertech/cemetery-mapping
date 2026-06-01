/**
 * Story 9.5 / 9.6 — `<CustomerPayReturn>` component tests.
 *
 * Coverage of the adversarial review fixes:
 *
 *   - P0-3: the `failureReason` rendered to the customer is the
 *     `friendlyFailureMessage()` lookup, NOT the raw stored string.
 *     We render an intent with `failureReason: "configuration_error"`
 *     and assert the customer-facing copy is the friendly translation
 *     (and that the raw token does not leak into the DOM).
 *
 *   - P1-1: the redirect effect respects the `completedAt` guard.
 *     We mount with an intent that has `status: "pending"`,
 *     `redirectUrl: "/redirect-target"`, AND `completedAt: 12345`
 *     (the simulated stale-closure scenario) and assert that
 *     `window.location.href` was NOT assigned.
 *
 * The `useQuery` hook is mocked via the `intentOverride` test-only
 * prop the component exposes; that path skips the Convex query and
 * uses the supplied object directly, so the test never has to go
 * through the reactive subscription.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import {
  CustomerPayReturn,
  friendlyFailureMessage,
} from "@/components/CustomerPortal/CustomerPayReturn";

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
});

describe("CustomerPayReturn — friendlyFailureMessage (P0-3)", () => {
  it("maps each whitelisted token onto a non-empty friendly string", () => {
    expect(friendlyFailureMessage("gateway_unavailable")).toMatch(
      /provider/i,
    );
    expect(friendlyFailureMessage("validation_failed")).toMatch(/details/i);
    expect(friendlyFailureMessage("configuration_error")).toMatch(
      /unavailable/i,
    );
    expect(friendlyFailureMessage("unknown")).toMatch(/did not complete/i);
  });

  it("never echoes the raw token back to the customer", () => {
    expect(friendlyFailureMessage("configuration_error")).not.toContain(
      "configuration_error",
    );
    expect(friendlyFailureMessage("gateway_unavailable")).not.toContain(
      "gateway_unavailable",
    );
  });

  it("falls back to a generic message for null / unrecognised inputs", () => {
    expect(friendlyFailureMessage(null)).toMatch(/did not complete/i);
    expect(friendlyFailureMessage("some-future-token")).toMatch(
      /did not complete/i,
    );
  });
});

describe("CustomerPayReturn — failed state renders the friendly message (P0-3)", () => {
  it("renders the friendlyFailureMessage and never the raw token", () => {
    render(
      <CustomerPayReturn
        paymentIntentId="intent-1"
        intentOverride={{
          paymentIntentId: "intent-1",
          provider: "gcash",
          status: "failed",
          amountCents: 100_000,
          contractId: "contracts:c1",
          createdAt: 1,
          completedAt: 2,
          redirectUrl: null,
          gatewayTransactionId: null,
          failureReason: "configuration_error",
          paymentId: null,
        }}
      />,
    );
    // The friendly message renders.
    expect(
      screen.getByText(/temporarily unavailable/i),
    ).toBeInTheDocument();
    // The raw token must not appear in the rendered output.
    expect(
      screen.queryByText(/configuration_error/),
    ).not.toBeInTheDocument();
  });

  it("renders the gateway_unavailable friendly message", () => {
    render(
      <CustomerPayReturn
        paymentIntentId="intent-2"
        intentOverride={{
          paymentIntentId: "intent-2",
          provider: "maya",
          status: "failed",
          amountCents: 100_000,
          contractId: "contracts:c1",
          createdAt: 1,
          completedAt: 2,
          redirectUrl: null,
          gatewayTransactionId: null,
          failureReason: "gateway_unavailable",
          paymentId: null,
        }}
      />,
    );
    expect(
      screen.getByText(/could not reach the payment provider/i),
    ).toBeInTheDocument();
  });
});

describe("CustomerPayReturn — redirect race guard (P1-1)", () => {
  let originalHref: string;

  beforeEach(() => {
    originalHref = window.location.href;
    // Replace `window.location` with a spyable shape — the
    // production effect does `window.location.href = ...`. We track
    // assignment via a setter.
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        _href: originalHref,
        set href(v: string) {
          this._href = v;
        },
        get href() {
          return this._href;
        },
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { href: originalHref },
    });
  });

  it("does NOT redirect when the intent has a completedAt marker (stale closure)", () => {
    render(
      <CustomerPayReturn
        paymentIntentId="intent-stale"
        intentOverride={{
          paymentIntentId: "intent-stale",
          provider: "gcash",
          // Even with status: pending AND a redirectUrl present, the
          // completedAt marker means the webhook has already landed
          // and the intent is closed. The redirect effect MUST NOT
          // fire — that would resurrect a stale gateway URL.
          status: "pending",
          amountCents: 100_000,
          contractId: "contracts:c1",
          createdAt: 1,
          completedAt: 12345,
          redirectUrl: "https://gateway.example/checkout/abc",
          gatewayTransactionId: null,
          failureReason: null,
          paymentId: null,
        }}
      />,
    );
    expect(window.location.href).toBe(originalHref);
  });

  it("DOES redirect on a clean pending+redirectUrl intent (completedAt=null)", () => {
    render(
      <CustomerPayReturn
        paymentIntentId="intent-clean"
        intentOverride={{
          paymentIntentId: "intent-clean",
          provider: "gcash",
          status: "pending",
          amountCents: 100_000,
          contractId: "contracts:c1",
          createdAt: 1,
          completedAt: null,
          redirectUrl: "https://gateway.example/checkout/abc",
          gatewayTransactionId: null,
          failureReason: null,
          paymentId: null,
        }}
      />,
    );
    expect(window.location.href).toBe(
      "https://gateway.example/checkout/abc",
    );
  });
});
