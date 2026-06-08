import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  filterNavItems,
  filterNavGroups,
  isNavItemActive,
  NAV_ITEMS,
  NAV_GROUPS,
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

// The grouped nav renders NavLinks that subscribe to the pending-approvals
// badge via Convex `useQuery`. Outside a ConvexProvider that would throw,
// so we stub it to "loading" (undefined) — badges simply don't render.
vi.mock("convex/react", () => ({
  useQuery: () => undefined,
}));

function renderSidebar(
  overrides: Partial<React.ComponentProps<typeof Sidebar>> = {},
) {
  return render(
    <TooltipProvider>
      <Sidebar
        collapsed={false}
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

describe("filterNavGroups", () => {
  it("returns nothing for empty roles", () => {
    expect(filterNavGroups(NAV_GROUPS, [])).toHaveLength(0);
  });

  it("keeps every group for admin and flattens to all items", () => {
    const groups = filterNavGroups(NAV_GROUPS, ["admin"]);
    const flat = groups.flatMap((g) => g.items);
    expect(flat).toHaveLength(NAV_ITEMS.length);
    expect(groups.map((g) => g.label)).toContain("Overview");
    expect(groups.map((g) => g.label)).toContain("Admin");
  });

  it("drops the Admin group entirely for field_worker (no visible items)", () => {
    const groups = filterNavGroups(NAV_GROUPS, ["field_worker"]);
    expect(groups.map((g) => g.label)).not.toContain("Admin");
    // Overview survives — Dashboard/Map/Lots are field-visible.
    expect(groups.map((g) => g.label)).toContain("Overview");
  });

  it("never yields an empty group", () => {
    for (const roles of [["admin"], ["office_staff"], ["field_worker"]]) {
      for (const group of filterNavGroups(NAV_GROUPS, roles)) {
        expect(group.items.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("Sidebar component", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders the dashboard nav item", () => {
    renderSidebar();
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
  });

  it("renders the mono-uppercase section headers", () => {
    renderSidebar();
    expect(screen.getByText("Overview")).toBeInTheDocument();
    expect(screen.getByText("Sales & Records")).toBeInTheDocument();
    expect(screen.getByText("Finance")).toBeInTheDocument();
  });

  it("renders in collapsed mode with data-collapsed=true", () => {
    const { container } = renderSidebar({ collapsed: true });
    const aside = container.querySelector("aside");
    expect(aside?.getAttribute("data-collapsed")).toBe("true");
  });

  it("hides admin link when user lacks admin role", () => {
    renderSidebar({ roles: ["office_staff"] });
    expect(screen.queryByText("Admin")).not.toBeInTheDocument();
  });
});
