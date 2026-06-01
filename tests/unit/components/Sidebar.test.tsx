import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  filterNavItems,
  isNavItemActive,
  NAV_ITEMS,
} from "@/components/Sidebar/nav-items";
import { Sidebar } from "@/components/Sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

// Mock `next/navigation` so usePathname returns deterministic values.
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// `useAuthActions` reaches into ConvexAuthNextjsProvider context; the
// UserMenu in the sidebar footer consumes it. We stub the module so
// rendering a bare Sidebar in jsdom doesn't blow up.
vi.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: vi.fn().mockResolvedValue(undefined) }),
}));

function renderSidebar(
  overrides: Partial<React.ComponentProps<typeof Sidebar>> = {},
) {
  return render(
    <TooltipProvider>
      <Sidebar
        collapsed={false}
        onToggleCollapse={() => {}}
        onOpenSearch={() => {}}
        roles={["admin"]}
        user={{ name: "Maria Reyes", email: "maria@example.test" }}
        {...overrides}
      />
    </TooltipProvider>,
  );
}

describe("Sidebar nav-items helpers", () => {
  it("hides admin-only items for office_staff", () => {
    const items = filterNavItems(NAV_ITEMS, ["office_staff"]);
    expect(items.find((i) => i.href === "/admin")).toBeUndefined();
    expect(items.find((i) => i.href === "/dashboard")).toBeDefined();
  });

  it("hides admin-only items for field_worker", () => {
    const items = filterNavItems(NAV_ITEMS, ["field_worker"]);
    expect(items.find((i) => i.href === "/admin")).toBeUndefined();
    expect(items.find((i) => i.href === "/reports")).toBeUndefined();
  });

  it("shows all items for admin", () => {
    const items = filterNavItems(NAV_ITEMS, ["admin"]);
    expect(items.find((i) => i.href === "/admin")).toBeDefined();
    expect(items.length).toBeGreaterThanOrEqual(NAV_ITEMS.length - 1);
  });

  it("returns nothing for empty roles", () => {
    expect(filterNavItems(NAV_ITEMS, [])).toHaveLength(0);
  });

  it("isNavItemActive: dashboard requires exact match", () => {
    const dashboard = NAV_ITEMS.find((i) => i.href === "/dashboard")!;
    expect(isNavItemActive(dashboard, "/dashboard")).toBe(true);
    expect(isNavItemActive(dashboard, "/dashboard/x")).toBe(false);
    expect(isNavItemActive(dashboard, "/lots")).toBe(false);
  });

  it("isNavItemActive: lots matches descendants", () => {
    const lots = NAV_ITEMS.find((i) => i.href === "/lots")!;
    expect(isNavItemActive(lots, "/lots")).toBe(true);
    expect(isNavItemActive(lots, "/lots/d-5-12")).toBe(true);
    expect(isNavItemActive(lots, "/customers")).toBe(false);
  });
});

describe("Sidebar component", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders the dashboard nav item", () => {
    renderSidebar();
    // The Sidebar renders the dashboard NavLink. usePathname is mocked
    // to /dashboard so the link will have aria-current="page".
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
  });

  it("renders the search trigger with a Cmd-K hint", () => {
    renderSidebar();
    const searchButton = screen.getByRole("button", { name: /search/i });
    expect(searchButton).toBeInTheDocument();
  });

  it("calls onOpenSearch when the search trigger is clicked", () => {
    const onOpenSearch = vi.fn();
    renderSidebar({ onOpenSearch });
    const searchButton = screen.getByRole("button", { name: /search/i });
    searchButton.click();
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
  });

  it("calls onToggleCollapse from the collapse button", () => {
    const onToggleCollapse = vi.fn();
    renderSidebar({ onToggleCollapse });
    const collapseButton = screen.getByRole("button", {
      name: /collapse sidebar/i,
    });
    collapseButton.click();
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it("renders in collapsed mode with data-collapsed=true", () => {
    const { container } = renderSidebar({ collapsed: true });
    const aside = container.querySelector("aside");
    expect(aside?.getAttribute("data-collapsed")).toBe("true");
  });

  it("hides the collapse toggle in forceExpanded mode", () => {
    renderSidebar({ forceExpanded: true });
    expect(
      screen.queryByRole("button", { name: /collapse sidebar/i }),
    ).not.toBeInTheDocument();
  });

  it("hides admin link when user lacks admin role", () => {
    renderSidebar({ roles: ["office_staff"] });
    expect(screen.queryByText("Admin")).not.toBeInTheDocument();
  });
});
