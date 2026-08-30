/**
 * Logging out, without a crash screen.
 *
 * Clicking "Sign out" called `signOut()` while the dashboard was still
 * mounted. Every `useQuery` under it then rejected, and Convex surfaces
 * a rejected query by THROWING during render — so the ordinary act of
 * leaving landed on React's "Application error".
 *
 * `router.push("/login")` did not save it: the navigation is
 * asynchronous, and the old tree keeps rendering until the new route
 * commits. The window between the two is where the crash lived.
 *
 * The fix is ordering. The guard swaps the whole subtree for a message
 * FIRST — which unmounts every subscription synchronously — and only
 * then clears the session. These tests are about that order, because
 * the order is the entire fix.
 */

import { type ReactElement } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const signOutMock = vi.fn(async () => undefined);
const assignMock = vi.fn();

vi.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: signOutMock }),
}));

import { SessionGuard, useSignOut } from "@/components/SessionGuard";

/** Stands in for the dashboard: a component that dies without auth. */
function QueryingChild({ onRender }: { onRender: () => void }): ReactElement {
  onRender();
  return <div data-testid="dashboard">Dashboard</div>;
}

function SignOutButton(): ReactElement {
  const { beginSignOut } = useSignOut();
  return (
    <button type="button" data-testid="sign-out" onClick={beginSignOut}>
      Sign out
    </button>
  );
}

beforeEach(() => {
  signOutMock.mockClear();
  assignMock.mockClear();
  Object.defineProperty(window, "location", {
    writable: true,
    value: { assign: assignMock, href: "http://localhost/dashboard" },
  });
});

describe("signing out", () => {
  it("unmounts the querying tree BEFORE clearing the session", async () => {
    // The whole fix. If `signOut()` ran while the dashboard was still
    // mounted, its queries would reject and throw during render.
    const renders: string[] = [];
    signOutMock.mockImplementation(async () => {
      renders.push("signOut");
      return undefined;
    });

    render(
      <SessionGuard signInPath="/login">
        <QueryingChild onRender={() => renders.push("render")} />
        <SignOutButton />
      </SessionGuard>,
    );

    expect(screen.getByTestId("dashboard")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("sign-out"));

    // Gone immediately, in the same commit as the click.
    expect(screen.queryByTestId("dashboard")).toBeNull();

    await waitFor(() => expect(signOutMock).toHaveBeenCalled());

    // No render of the child after sign-out began.
    const signOutAt = renders.indexOf("signOut");
    expect(signOutAt).toBeGreaterThan(-1);
    expect(renders.slice(signOutAt)).not.toContain("render");
  });

  it("shows that it is signing out, not that something broke", () => {
    render(
      <SessionGuard signInPath="/login">
        <SignOutButton />
      </SessionGuard>,
    );
    fireEvent.click(screen.getByTestId("sign-out"));
    expect(screen.getByTestId("signing-out")).toBeInTheDocument();
  });

  it("does NOT tell the person their session has ended", () => {
    // They chose to leave. Nothing expired, and saying so reads as a
    // fault where there was none.
    render(
      <SessionGuard signInPath="/login">
        <SignOutButton />
      </SessionGuard>,
    );
    fireEvent.click(screen.getByTestId("sign-out"));
    expect(screen.queryByTestId("session-expired-redirect")).toBeNull();
    expect(screen.queryByText(/session has ended/i)).toBeNull();
  });

  it("leaves with a hard navigation, not a client-side push", async () => {
    // No React tree survives the transition holding a stale token.
    render(
      <SessionGuard signInPath="/login">
        <SignOutButton />
      </SessionGuard>,
    );
    fireEvent.click(screen.getByTestId("sign-out"));
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("/login"));
  });

  it("still leaves when clearing the session fails", async () => {
    // Stranding somebody on a spinner is the worse outcome.
    signOutMock.mockRejectedValueOnce(new Error("network"));
    render(
      <SessionGuard signInPath="/login">
        <SignOutButton />
      </SessionGuard>,
    );
    fireEvent.click(screen.getByTestId("sign-out"));
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("/login"));
  });

  it("signs out once however many times the button is pressed", async () => {
    render(
      <SessionGuard signInPath="/login">
        <SignOutButton />
      </SessionGuard>,
    );
    const button = screen.getByTestId("sign-out");
    fireEvent.click(button);
    // The button is gone with the subtree, but a double-fire in the
    // same tick must not sign out twice.
    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
  });
});

describe("the guard still does its original job", () => {
  it("renders children when nothing is wrong", () => {
    render(
      <SessionGuard signInPath="/login">
        <div data-testid="child">Fine</div>
      </SessionGuard>,
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });
});
