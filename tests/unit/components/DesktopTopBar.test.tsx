import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DesktopTopBar } from "@/components/DesktopTopBar";

// next/link renders a plain anchor in jsdom; no router context needed for
// the bell link. usePathname isn't consumed here, but stub navigation to
// keep the module graph happy if a transitive import reaches for it.
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

function renderBar(
  overrides: Partial<React.ComponentProps<typeof DesktopTopBar>> = {},
) {
  const onToggleCollapse = vi.fn();
  const onOpenSearch = vi.fn();
  render(
    <DesktopTopBar
      onToggleCollapse={onToggleCollapse}
      onOpenSearch={onOpenSearch}
      collapsed={false}
      {...overrides}
    />,
  );
  return { onToggleCollapse, onOpenSearch };
}

describe("DesktopTopBar", () => {
  beforeEach(() => cleanup());

  it("renders the Cmd-K search affordance", () => {
    renderBar();
    expect(
      screen.getByText(/search lots, customers, contracts/i),
    ).toBeInTheDocument();
  });

  it("calls onOpenSearch when the search affordance is clicked", () => {
    const { onOpenSearch } = renderBar();
    screen.getByTestId("desktop-topbar-search").click();
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
  });

  it("calls onToggleCollapse from the hamburger", () => {
    const { onToggleCollapse } = renderBar();
    screen.getByTestId("desktop-topbar-collapse").click();
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it("labels the hamburger by collapse state", () => {
    renderBar({ collapsed: true });
    expect(
      screen.getByRole("button", { name: /expand sidebar/i }),
    ).toBeInTheDocument();
  });

  it("shows the gold notification dot only when hasNotifications", () => {
    const { rerender } = render(
      <DesktopTopBar
        onToggleCollapse={vi.fn()}
        onOpenSearch={vi.fn()}
        collapsed={false}
        hasNotifications={false}
      />,
    );
    const bell = screen.getByTestId("desktop-topbar-bell");
    expect(bell.querySelector("span")).toBeNull();

    rerender(
      <DesktopTopBar
        onToggleCollapse={vi.fn()}
        onOpenSearch={vi.fn()}
        collapsed={false}
        hasNotifications
      />,
    );
    expect(
      screen.getByTestId("desktop-topbar-bell").querySelector("span"),
    ).not.toBeNull();
  });
});
