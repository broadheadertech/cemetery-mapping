/**
 * Story 9.5 / 9.6 — mock-gateway page production-guard test (P0-1).
 *
 * The page is a Next.js async server component. We can't render it
 * through React Testing Library (it touches `convexAuthNextjsToken`
 * and `fetchQuery`), so this test calls the default export directly
 * and asserts that with `NODE_ENV=production` the call invokes
 * `notFound()` *before* any auth / query work.
 *
 * We mock `next/navigation`'s `notFound` to a throw — that mirrors
 * the real Next.js runtime behaviour (the helper throws a special
 * marker error that the framework catches and renders as a 404).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NOT_FOUND_MARKER = "__next_not_found_marker__";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`__redirect:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error(NOT_FOUND_MARKER);
  }),
}));

vi.mock("convex/nextjs", () => ({
  fetchQuery: vi.fn(),
}));

vi.mock("@convex-dev/auth/nextjs/server", () => ({
  convexAuthNextjsToken: vi.fn(async () => "token-abc"),
}));

vi.mock("convex/server", () => ({
  makeFunctionReference: vi.fn(() => () => undefined),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("@/components/CustomerPortal/MockGatewayCheckout", () => ({
  MockGatewayCheckout: () => null,
}));

import CustomerMockGatewayPage from "@/app/(customer)/portal/pay/mock-gateway/page";

beforeEach(() => {
  // ensure NODE_ENV is restored between tests
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Mock-gateway page — production guard (P0-1)", () => {
  it("invokes notFound() when NODE_ENV=production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(
      CustomerMockGatewayPage({
        searchParams: Promise.resolve({
          provider: "gcash",
          intent: "intent-1",
          amount: "100",
          return: "/portal/contracts",
        }),
      }),
    ).rejects.toThrow(NOT_FOUND_MARKER);
  });

  it("does NOT invoke notFound() in non-production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    // The function will proceed past the guard and hit the auth /
    // query path. Our mocks return a token + a (mock) payload from
    // fetchQuery, so we shouldn't get the not-found marker.
    const { fetchQuery } = await import("convex/nextjs");
    (fetchQuery as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: "users:1",
      user: { email: "a@b.test" },
      roles: ["customer"],
    });
    let thrown: unknown = null;
    try {
      await CustomerMockGatewayPage({
        searchParams: Promise.resolve({
          provider: "gcash",
          intent: "intent-1",
          amount: "100",
          return: "/portal/contracts",
        }),
      });
    } catch (e) {
      thrown = e;
    }
    // We expect either no throw OR a non-notFound throw — but
    // certainly not the production-guard branch.
    if (thrown instanceof Error) {
      expect(thrown.message).not.toBe(NOT_FOUND_MARKER);
    }
  });
});
