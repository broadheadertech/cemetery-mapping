/**
 * The guard that turns an expired session into a sign-in page.
 *
 * Sessions expire on age — an hour for an admin — and after that every
 * query throws `SESSION_EXPIRED` during render. Convex's `useQuery`
 * surfaces a rejected query by throwing, so with nothing to catch it a
 * person who left a tab open over lunch came back to React's
 * "Application error" screen.
 *
 * Two properties matter here, and the second is the one that is easy to
 * get wrong: it must catch session errors, and it must NOT catch
 * anything else. A boundary that swallows every failure turns real bugs
 * into mysterious redirects.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ConvexError } from "convex/values";
import type { ReactElement } from "react";

const mockReplace = vi.fn();
const mockSignOut = vi.fn().mockResolvedValue(undefined);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, push: vi.fn() }),
  usePathname: () => "/contracts/abc123",
}));

vi.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: mockSignOut }),
}));

import {
  SessionGuard,
  isSignedOutError,
} from "../../../src/components/SessionGuard/SessionGuard";

/** A component that throws on render, the way a rejected useQuery does. */
function Throws({ error }: { error: unknown }): ReactElement {
  throw error;
}

const expired = (): unknown =>
  new ConvexError({
    code: "SESSION_EXPIRED",
    message: "Your session has expired. Sign in again.",
  });

beforeEach(() => {
  mockReplace.mockClear();
  mockSignOut.mockClear();
  // The boundary logs the caught error; keep the run readable.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("isSignedOutError", () => {
  it("recognises an expired session", () => {
    expect(isSignedOutError(expired())).toBe(true);
  });

  it("recognises a missing session", () => {
    expect(
      isSignedOutError(
        new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in." }),
      ),
    ).toBe(true);
  });

  it("does not claim a permission error", () => {
    // FORBIDDEN means signed in as the wrong role. Redirecting to the
    // sign-in page would be a lie and an infinite loop.
    expect(
      isSignedOutError(
        new ConvexError({ code: "FORBIDDEN", message: "Not permitted." }),
      ),
    ).toBe(false);
  });

  it("does not claim an ordinary bug", () => {
    expect(isSignedOutError(new TypeError("x is not a function"))).toBe(false);
    expect(isSignedOutError(null)).toBe(false);
  });
});

describe("SessionGuard", () => {
  it("renders its children when nothing is wrong", () => {
    render(
      <SessionGuard>
        <p>the page</p>
      </SessionGuard>,
    );
    expect(screen.getByText("the page")).toBeInTheDocument();
  });

  it("shows the hand-off instead of a crash when the session expires", () => {
    render(
      <SessionGuard>
        <Throws error={expired()} />
      </SessionGuard>,
    );
    expect(
      screen.getByTestId("session-expired-redirect"),
    ).toBeInTheDocument();
    expect(screen.getByText(/session has ended/i)).toBeInTheDocument();
  });

  it("clears the stale session before redirecting", async () => {
    // Not optional: the app's own age rule is not applied by the read
    // the middleware uses, so an expired-but-present session still looks
    // signed in to the server. Redirecting without signing out bounces
    // straight back and loops.
    render(
      <SessionGuard>
        <Throws error={expired()} />
      </SessionGuard>,
    );
    await waitFor(() => expect(mockSignOut).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledTimes(1));

    const order = mockSignOut.mock.invocationCallOrder[0]!;
    const redirect = mockReplace.mock.invocationCallOrder[0]!;
    expect(order).toBeLessThan(redirect);
  });

  it("sends staff to /login and remembers where they were", async () => {
    render(
      <SessionGuard>
        <Throws error={expired()} />
      </SessionGuard>,
    );
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    const target = String(mockReplace.mock.calls[0]![0]);
    expect(target.startsWith("/login?")).toBe(true);
    expect(target).toContain("reason=expired");
    expect(target).toContain("next=%2Fcontracts%2Fabc123");
  });

  it("sends portal users to the portal sign-in", async () => {
    render(
      <SessionGuard signInPath="/portal/login">
        <Throws error={expired()} />
      </SessionGuard>,
    );
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(String(mockReplace.mock.calls[0]![0])).toContain("/portal/login?");
  });

  it("redirects once even if React renders the fallback twice", async () => {
    const { rerender } = render(
      <SessionGuard>
        <Throws error={expired()} />
      </SessionGuard>,
    );
    rerender(
      <SessionGuard>
        <Throws error={expired()} />
      </SessionGuard>,
    );
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  it("lets a real bug through instead of redirecting", () => {
    // The important negative. If this boundary claimed everything, a
    // genuine failure would look like a session problem and the actual
    // defect would never be seen.
    expect(() =>
      render(
        <SessionGuard>
          <Throws error={new TypeError("genuine bug")} />
        </SessionGuard>,
      ),
    ).toThrow(/genuine bug/);
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("lets a permission error through", () => {
    expect(() =>
      render(
        <SessionGuard>
          <Throws
            error={
              new ConvexError({ code: "FORBIDDEN", message: "Not permitted." })
            }
          />
        </SessionGuard>,
      ),
    ).toThrow();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
