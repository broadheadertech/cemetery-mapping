/**
 * Story 1.10 — `LotSearchCommand` component tests (extends the Story 1.5
 * scaffold tests with the production wiring assertions).
 *
 * Coverage target per the story: ≥ 80% on the component. We cover:
 *   - AC1: open / close via `isOpen` prop.
 *   - AC2: typing triggers a debounced query (`useQuery` invocation
 *     args change after the debounce window).
 *   - AC3: live results render under their headings + the no-results
 *     state.
 *   - AC4: selecting a row triggers navigation + closes the palette.
 *   - AC5: empty query renders recents from localStorage; empty
 *     recents render the friendly hint.
 *
 * Implementation notes:
 *   - `useQuery` is mocked so jsdom doesn't need a real Convex client.
 *   - The component renders BOTH a Dialog (desktop) and a Sheet
 *     (mobile) and lets Tailwind's `md:` class toggle visibility.
 *     jsdom has no viewport semantics, so both portals appear in the
 *     DOM. We scope queries via `getAllByText`'s "at least one" check
 *     or via `data-testid`-scoped lookups inside the dialog node.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: pushMock }),
}));

// `useQuery` returns whatever the test setup pushes — we wire the
// mock to a module-level holder so each `it` block can change the
// fixture without re-mocking the module.
const queryFixture: {
  result: unknown;
  lastArgs: unknown;
} = { result: undefined, lastArgs: undefined };

vi.mock("convex/react", () => ({
  useQuery: (_ref: unknown, args: unknown) => {
    queryFixture.lastArgs = args;
    return queryFixture.result;
  },
}));

import { LotSearchCommand } from "@/components/LotSearchCommand";
import { RECENTS_STORAGE_KEY, type RecentItem } from "@/lib/recents";

function setQueryResult(value: unknown) {
  queryFixture.result = value;
}

function seedRecents(items: RecentItem[]) {
  localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(items));
}

/**
 * Returns the first `cmdk-input` in the DOM — both Dialog and Sheet
 * portals render one; we pick the first because they're functionally
 * equivalent. Typing into one updates the React state of both since
 * they share `<PaletteBody>` instances.
 */
function firstCmdkInput(): HTMLInputElement {
  const input = document.querySelector(
    "[cmdk-input]",
  ) as HTMLInputElement | null;
  if (input === null) {
    throw new Error("No cmdk-input found in the DOM");
  }
  return input;
}

/**
 * Fires `change` on the first cmdk-input. We don't use `userEvent.type`
 * because it internally advances timers in ways that race with the
 * 80ms debounce being measured.
 */
function typeIntoFirst(value: string): void {
  const input = firstCmdkInput();
  act(() => {
    fireEvent.change(input, { target: { value } });
  });
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  pushMock.mockReset();
  queryFixture.result = undefined;
  queryFixture.lastArgs = undefined;
});

describe("LotSearchCommand — open/close (AC1)", () => {
  it("does not render the palette while closed", () => {
    render(<LotSearchCommand isOpen={false} onOpenChange={() => {}} />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("renders the search input + empty hint when open with no recents", () => {
    const { container } = render(
      <LotSearchCommand isOpen={true} onOpenChange={() => {}} />,
    );
    const inputs = container.ownerDocument.querySelectorAll("[cmdk-input]");
    expect(inputs.length).toBeGreaterThan(0);
    expect(
      container.ownerDocument.querySelectorAll(
        "[data-testid='lot-search-empty-hint']",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("toggles open state via the isOpen prop", () => {
    const onOpenChange = vi.fn();
    const { container, rerender } = render(
      <LotSearchCommand isOpen={true} onOpenChange={onOpenChange} />,
    );
    expect(
      container.ownerDocument.querySelectorAll("[cmdk-input]").length,
    ).toBeGreaterThan(0);
    rerender(<LotSearchCommand isOpen={false} onOpenChange={onOpenChange} />);
    expect(
      container.ownerDocument.querySelectorAll("[cmdk-input]").length,
    ).toBe(0);
    rerender(<LotSearchCommand isOpen={true} onOpenChange={onOpenChange} />);
    expect(
      container.ownerDocument.querySelectorAll("[cmdk-input]").length,
    ).toBeGreaterThan(0);
  });
});

describe("LotSearchCommand — debounced typing (AC2)", () => {
  it("debounces typing — query args reach 'skip' immediately and update after 80ms", () => {
    vi.useFakeTimers();
    setQueryResult({
      lots: [],
      customers: [],
      contracts: [],
      receipts: [],
    });
    render(<LotSearchCommand isOpen={true} onOpenChange={() => {}} />);
    // First render: debounced is "" → skip.
    expect(queryFixture.lastArgs).toBe("skip");

    // Type into the input. The raw query updates; the debounced one
    // hasn't fired yet, so the query stays in skip mode.
    typeIntoFirst("D-5");
    expect(queryFixture.lastArgs).toBe("skip");

    // Advance past the 80ms debounce window.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(queryFixture.lastArgs).toEqual({ query: "D-5" });

    vi.useRealTimers();
  });
});

describe("LotSearchCommand — results rendering (AC3)", () => {
  it("renders LOTS group with code + LOTS heading", () => {
    vi.useFakeTimers();
    setQueryResult({
      lots: [
        {
          _id: "lots:1",
          code: "D-5-12",
          section: "D",
          block: "5",
          row: "12",
          type: "family",
          status: "available",
        },
      ],
      customers: [],
      contracts: [],
      receipts: [],
    });
    render(<LotSearchCommand isOpen={true} onOpenChange={() => {}} />);
    typeIntoFirst("D-5");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    // Both Dialog + Sheet render the row — getAllByText with at-least-one.
    expect(screen.getAllByText("D-5-12").length).toBeGreaterThan(0);
    const headings = Array.from(
      document.querySelectorAll("[cmdk-group-heading]"),
    ).map((h) => h.textContent);
    expect(headings).toContain("LOTS");
    vi.useRealTimers();
  });

  it("renders the 'No results' message when all groups empty + query non-empty", () => {
    vi.useFakeTimers();
    setQueryResult({
      lots: [],
      customers: [],
      contracts: [],
      receipts: [],
    });
    render(<LotSearchCommand isOpen={true} onOpenChange={() => {}} />);
    typeIntoFirst("zz");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    const noResults = document.querySelectorAll(
      "[data-testid='lot-search-no-results']",
    );
    expect(noResults.length).toBeGreaterThan(0);
    expect(noResults[0]?.textContent ?? "").toMatch(/zz/);
    vi.useRealTimers();
  });
});

describe("LotSearchCommand — recents (AC5)", () => {
  it("renders recents under RECENT heading when query is empty", () => {
    seedRecents([
      { entityType: "lot", entityId: "lots:1", label: "D-5-12", viewedAt: 2 },
      { entityType: "lot", entityId: "lots:2", label: "E-1-1", viewedAt: 1 },
    ]);
    render(<LotSearchCommand isOpen={true} onOpenChange={() => {}} />);
    const headings = Array.from(
      document.querySelectorAll("[cmdk-group-heading]"),
    ).map((h) => h.textContent);
    expect(headings).toContain("RECENT");
    expect(screen.getAllByText("D-5-12").length).toBeGreaterThan(0);
    expect(screen.getAllByText("E-1-1").length).toBeGreaterThan(0);
  });

  it("renders the friendly hint when recents empty + query empty", () => {
    render(<LotSearchCommand isOpen={true} onOpenChange={() => {}} />);
    const hint = document.querySelector(
      "[data-testid='lot-search-empty-hint']",
    );
    expect(hint).not.toBeNull();
    expect(hint?.textContent ?? "").toMatch(/Search lots/);
  });
});

describe("LotSearchCommand — navigation (AC4)", () => {
  it("selecting a lot row pushes /lots/<id> and closes the palette", () => {
    vi.useFakeTimers();
    setQueryResult({
      lots: [
        {
          _id: "lots:42",
          code: "D-5-12",
          section: "D",
          block: "5",
          row: "12",
          type: "family",
          status: "available",
        },
      ],
      customers: [],
      contracts: [],
      receipts: [],
    });
    const onOpenChange = vi.fn();
    render(
      <LotSearchCommand isOpen={true} onOpenChange={onOpenChange} />,
    );
    typeIntoFirst("D-5");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    // Pick the first rendered <cmdk-item> with `data-value="lot:lots:42"`.
    const row = document.querySelector(
      "[cmdk-item][data-value='lot:lots:42']",
    ) as HTMLElement | null;
    expect(row).not.toBeNull();
    act(() => {
      row?.click();
    });
    expect(pushMock).toHaveBeenCalledWith("/lots/lots:42");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    vi.useRealTimers();
  });

  it("selecting a recent item pushes the right URL", () => {
    seedRecents([
      {
        entityType: "lot",
        entityId: "lots:99",
        label: "Z-9-9",
        viewedAt: 1,
      },
    ]);
    const onOpenChange = vi.fn();
    render(
      <LotSearchCommand isOpen={true} onOpenChange={onOpenChange} />,
    );
    const row = document.querySelector(
      "[cmdk-item][data-value='recent:lot:lots:99']",
    ) as HTMLElement | null;
    expect(row).not.toBeNull();
    act(() => {
      row?.click();
    });
    expect(pushMock).toHaveBeenCalledWith("/lots/lots:99");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
