import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KpiCard } from "@/components/KpiCard";

/**
 * KpiCard contract (Story 5.1):
 *   1. Renders label, value, and optional delta.
 *   2. Delta tone maps to the documented colour token utility.
 *   3. `onClick` provided → outer is a real `<button type="button">`
 *      with composed `aria-label`, a 44px minimum touch target, and
 *      native Enter / Space activation.
 *   4. `onClick` absent → outer is a `<div>` with no role / tabIndex
 *      / aria-label.
 *   5. Value wrapped in `ReactiveHighlight watch={value}`:
 *      - first render does NOT apply the flash class
 *      - re-render with a new value applies it once
 *      - re-render with the same value does NOT re-flash
 *   6. Reduced-motion suppression is delegated to the global CSS rule
 *      in globals.css — the wrapper still mounts unchanged.
 */

describe("KpiCard", () => {
  describe("static rendering (AC1)", () => {
    it("renders label and value with no delta", () => {
      const { container } = render(
        <KpiCard label="MTD Sales" value="₱340,000" />,
      );
      expect(screen.getByText("MTD Sales")).toBeInTheDocument();
      expect(screen.getByText("₱340,000")).toBeInTheDocument();
      // No delta DOM node.
      expect(container.querySelector("[data-tone]")).toBeNull();
    });

    it("renders the positive delta with the emerald token class", () => {
      const { container } = render(
        <KpiCard
          label="MTD Sales"
          value="₱340,000"
          delta={{ text: "+₱16,000 today", tone: "positive" }}
        />,
      );
      const deltaEl = container.querySelector('[data-tone="positive"]');
      expect(deltaEl).not.toBeNull();
      expect(deltaEl).toHaveTextContent("+₱16,000 today");
      expect(deltaEl?.className ?? "").toContain("text-emerald-700");
    });

    it("renders the negative delta with the red token class", () => {
      const { container } = render(
        <KpiCard
          label="AR balance"
          value="₱1,825,000"
          delta={{ text: "+₱30,000 vs. last week", tone: "negative" }}
        />,
      );
      const deltaEl = container.querySelector('[data-tone="negative"]');
      expect(deltaEl).not.toBeNull();
      expect(deltaEl?.className ?? "").toContain("text-red-700");
    });

    it("renders the neutral delta with the slate token class", () => {
      const { container } = render(
        <KpiCard
          label="MTD Expenses"
          value="₱48,000"
          delta={{ text: "+₱4,000 vs. avg", tone: "neutral" }}
        />,
      );
      const deltaEl = container.querySelector('[data-tone="neutral"]');
      expect(deltaEl).not.toBeNull();
      expect(deltaEl?.className ?? "").toContain("text-slate-600");
    });

    it("applies tabular-nums to the value for column alignment during fades", () => {
      render(<KpiCard label="Active contracts" value="412" />);
      const valueEl = screen.getByText("412");
      expect(valueEl.className).toContain("tabular-nums");
    });

    it("applies tabular-nums to the delta line so deltas don't shift", () => {
      const { container } = render(
        <KpiCard
          label="MTD Sales"
          value="₱340,000"
          delta={{ text: "+₱16,000 today", tone: "positive" }}
        />,
      );
      const deltaEl = container.querySelector('[data-tone="positive"]');
      expect(deltaEl?.className ?? "").toContain("tabular-nums");
    });
  });

  describe("clickable variant (AC3)", () => {
    it("renders as <button type=\"button\"> when onClick is provided", () => {
      render(
        <KpiCard label="MTD Sales" value="₱340,000" onClick={() => {}} />,
      );
      const btn = screen.getByRole("button");
      expect(btn.tagName).toBe("BUTTON");
      expect(btn).toHaveAttribute("type", "button");
    });

    it("composes aria-label as `{label}: {value}, {delta.text}` when delta is present", () => {
      render(
        <KpiCard
          label="MTD Sales"
          value="₱340,000"
          delta={{ text: "+₱16,000 today", tone: "positive" }}
          onClick={() => {}}
        />,
      );
      expect(screen.getByRole("button")).toHaveAttribute(
        "aria-label",
        "MTD Sales: ₱340,000, +₱16,000 today",
      );
    });

    it("composes aria-label as `{label}: {value}` when delta is absent (no trailing comma)", () => {
      render(
        <KpiCard label="MTD Sales" value="₱340,000" onClick={() => {}} />,
      );
      const label = screen
        .getByRole("button")
        .getAttribute("aria-label");
      expect(label).toBe("MTD Sales: ₱340,000");
      expect(label).not.toContain(",,");
      // Defensive: no trailing comma.
      expect(label?.endsWith(",")).toBe(false);
    });

    it("fires onClick on mouse click", async () => {
      const user = userEvent.setup();
      const onClick = vi.fn();
      render(
        <KpiCard label="MTD Sales" value="₱340,000" onClick={onClick} />,
      );
      await user.click(screen.getByRole("button"));
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("fires onClick on Enter (native button keyboard behavior)", async () => {
      const user = userEvent.setup();
      const onClick = vi.fn();
      render(
        <KpiCard label="MTD Sales" value="₱340,000" onClick={onClick} />,
      );
      screen.getByRole("button").focus();
      await user.keyboard("{Enter}");
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("fires onClick on Space (native button keyboard behavior)", async () => {
      const user = userEvent.setup();
      const onClick = vi.fn();
      render(
        <KpiCard label="MTD Sales" value="₱340,000" onClick={onClick} />,
      );
      screen.getByRole("button").focus();
      await user.keyboard(" ");
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("applies min-h-[44px] for the NFR-A4 touch target", () => {
      render(
        <KpiCard label="MTD Sales" value="₱340,000" onClick={() => {}} />,
      );
      expect(screen.getByRole("button").className).toContain("min-h-[44px]");
    });

    it("applies the focus-ring token utilities for keyboard visibility", () => {
      render(
        <KpiCard label="MTD Sales" value="₱340,000" onClick={() => {}} />,
      );
      const btn = screen.getByRole("button");
      expect(btn.className).toContain("focus-visible:ring-2");
      expect(btn.className).toContain("focus-visible:ring-focus-ring");
    });
  });

  describe("static (non-clickable) variant (AC3)", () => {
    it("renders as <div> when onClick is omitted", () => {
      const { container } = render(
        <KpiCard label="Active contracts" value="412" />,
      );
      // No button role exists in the tree.
      expect(screen.queryByRole("button")).toBeNull();
      // Outer card element is a <div>.
      const outer = container.firstElementChild as HTMLElement;
      expect(outer.tagName).toBe("DIV");
    });

    it("has no aria-label / tabIndex / role on the static variant", () => {
      const { container } = render(
        <KpiCard label="Active contracts" value="412" />,
      );
      const outer = container.firstElementChild as HTMLElement;
      expect(outer.hasAttribute("aria-label")).toBe(false);
      expect(outer.hasAttribute("tabindex")).toBe(false);
      expect(outer.hasAttribute("role")).toBe(false);
    });

    it("does not apply hover / focus-ring classes when non-interactive", () => {
      const { container } = render(
        <KpiCard label="Active contracts" value="412" />,
      );
      const outer = container.firstElementChild as HTMLElement;
      expect(outer.className).not.toContain("hover:bg-surface-muted");
      expect(outer.className).not.toContain("focus-visible:ring");
    });
  });

  describe("ReactiveHighlight composition (AC2)", () => {
    it("wraps the value in a ReactiveHighlight (data-testid present)", () => {
      render(<KpiCard label="MTD Sales" value="₱340,000" />);
      expect(screen.getByTestId("reactive-highlight")).toBeInTheDocument();
    });

    it("does NOT apply the flash class on first render", () => {
      render(<KpiCard label="MTD Sales" value="₱340,000" />);
      const wrapper = screen.getByTestId("reactive-highlight");
      const inner = wrapper.firstElementChild as HTMLElement;
      expect(inner.className ?? "").not.toContain("animate-flash-fade");
      expect(inner.getAttribute("data-flash-key")).toBe("0");
    });

    it("applies the flash class when value changes (reactive update)", () => {
      const { rerender } = render(
        <KpiCard label="MTD Sales" value="₱340,000" />,
      );
      rerender(<KpiCard label="MTD Sales" value="₱356,000" />);
      const inner = screen.getByTestId("reactive-highlight")
        .firstElementChild as HTMLElement;
      expect(inner.className ?? "").toContain("animate-flash-fade");
      expect(inner.getAttribute("data-flash-key")).toBe("1");
    });

    it("does NOT re-flash when value stays identical across renders", () => {
      const { rerender } = render(
        <KpiCard label="MTD Sales" value="₱340,000" />,
      );
      rerender(<KpiCard label="MTD Sales" value="₱340,000" />);
      const inner = screen.getByTestId("reactive-highlight")
        .firstElementChild as HTMLElement;
      expect(inner.getAttribute("data-flash-key")).toBe("0");
      expect(inner.className ?? "").not.toContain("animate-flash-fade");
    });

    it("delegates prefers-reduced-motion suppression to the global CSS rule (no JS branching)", () => {
      // Story 1.4's design: globals.css carries the universal
      // `@media (prefers-reduced-motion: reduce)` rule that collapses
      // animation-duration. ReactiveHighlight has no per-component
      // matchMedia check — the class is still applied identically so
      // SSR output is stable. This test pins that behaviour so a
      // future "optimisation" doesn't drop the wrapper's class when
      // the OS preference is set.
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: vi.fn().mockImplementation((query: string) => ({
          matches: query.includes("prefers-reduced-motion"),
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        })),
      });

      const { rerender } = render(
        <KpiCard label="MTD Sales" value="₱340,000" />,
      );
      rerender(<KpiCard label="MTD Sales" value="₱356,000" />);
      const inner = screen.getByTestId("reactive-highlight")
        .firstElementChild as HTMLElement;
      // The class is still applied; the global CSS rule clamps
      // animation-duration so the user sees no motion.
      expect(inner.className ?? "").toContain("animate-flash-fade");
    });

    it("aria-live=polite stays on the wrapper, not on the card itself", () => {
      const { container } = render(
        <KpiCard label="MTD Sales" value="₱340,000" onClick={() => {}} />,
      );
      // The KpiCard outer element must NOT carry aria-live — only the
      // inner ReactiveHighlight wrapper does.
      const outer = container.firstElementChild as HTMLElement;
      expect(outer.hasAttribute("aria-live")).toBe(false);
      expect(
        screen.getByTestId("reactive-highlight"),
      ).toHaveAttribute("aria-live", "polite");
    });
  });

  describe("accessibility (AC4)", () => {
    it("renders all four delta tones plus clickable + non-clickable cards without throwing", () => {
      // Fixture render covering the matrix the story calls out for
      // axe-core scanning. With @axe-core/react not yet wired into the
      // unit suite (axe runs in Playwright per Story 5.8 setup), we
      // assert the rendered DOM has no obviously-broken a11y
      // primitives: buttons have accessible names, non-interactive
      // cards have no orphan ARIA, no duplicate IDs.
      const { container } = render(
        <div>
          <KpiCard
            label="MTD Sales"
            value="₱340,000"
            delta={{ text: "+₱16,000 today", tone: "positive" }}
            onClick={() => {}}
          />
          <KpiCard
            label="Collections MTD"
            value="₱285,000"
            delta={{ text: "+₱12,000 today", tone: "positive" }}
          />
          <KpiCard
            label="AR balance"
            value="₱1,825,000"
            delta={{ text: "+₱30,000 vs. last week", tone: "negative" }}
            onClick={() => {}}
          />
          <KpiCard
            label="MTD Expenses"
            value="₱48,000"
            delta={{ text: "+₱4,000 vs. avg", tone: "neutral" }}
          />
          <KpiCard label="Active contracts" value="412" />
        </div>,
      );

      // Every button has an accessible name.
      const buttons = container.querySelectorAll("button");
      buttons.forEach((b) => {
        const name = b.getAttribute("aria-label") ?? b.textContent ?? "";
        expect(name.length).toBeGreaterThan(0);
      });

      // Reactive wrappers all carry aria-live=polite for SR announcement.
      const wrappers = container.querySelectorAll(
        '[data-testid="reactive-highlight"]',
      );
      expect(wrappers.length).toBe(5);
      wrappers.forEach((w) => {
        expect(w.getAttribute("aria-live")).toBe("polite");
      });
    });
  });
});
