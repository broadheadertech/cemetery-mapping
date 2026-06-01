import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  StatusPill,
  LABEL_MAP,
  type PillStatus,
  type StatusPillSize,
} from "@/components/ui/StatusPill";

/**
 * Cornerstone visual primitive — exercise every prop axis:
 *   - 12 status variants × correct label + aria-label + icon-hidden
 *   - 3 sizes apply distinct size classes
 *   - showIcon=false drops the icon while keeping the label
 *   - Outdoor mode (data-theme="outdoor" on <html>) keeps the same
 *     `border-[length:var(--pill-border-width)]` class so the CSS
 *     variable swap takes effect.
 *   - Caller `className` wins over default utilities (tailwind-merge).
 *   - Status crossfade transition is on the element.
 */

const ALL_STATUSES: PillStatus[] = [
  "available",
  "reserved",
  "sold",
  "occupied",
  "cancelled",
  "defaulted",
  "transferred",
  "paid",
  "current",
  "due",
  "overdue",
  "overdue-action",
];

describe("StatusPill", () => {
  describe("variant rendering — every status", () => {
    it.each(ALL_STATUSES)(
      "renders the correct label and aria-label for %s",
      (status) => {
        render(<StatusPill status={status} />);
        const pill = screen.getByRole("status");
        expect(pill).toHaveAttribute("aria-label", LABEL_MAP[status]);
        expect(pill).toHaveAttribute("data-status", status);
        expect(pill).toHaveTextContent(LABEL_MAP[status]);
      },
    );

    it.each(ALL_STATUSES)("applies the variant class chunk for %s", (status) => {
      render(<StatusPill status={status} />);
      const pill = screen.getByRole("status");
      // Variant class includes the bg-status-<state>-bg utility.
      expect(pill.className).toContain(`bg-status-${status}-bg`);
      expect(pill.className).toContain(`text-status-${status}-text`);
      expect(pill.className).toContain(`border-status-${status}-border`);
    });
  });

  describe("icon", () => {
    it("renders an icon by default with aria-hidden", () => {
      render(<StatusPill status="available" />);
      const pill = screen.getByRole("status");
      const icon = pill.querySelector("svg");
      expect(icon).not.toBeNull();
      expect(icon).toHaveAttribute("aria-hidden", "true");
      expect(icon).toHaveAttribute("focusable", "false");
    });

    it("hides the icon when showIcon={false} but keeps the label", () => {
      render(<StatusPill status="overdue" showIcon={false} />);
      const pill = screen.getByRole("status");
      expect(pill.querySelector("svg")).toBeNull();
      expect(pill).toHaveTextContent("Overdue");
    });

    it("applies the correct icon colour utility per status", () => {
      render(<StatusPill status="defaulted" />);
      const pill = screen.getByRole("status");
      const icon = pill.querySelector("svg");
      expect(icon?.getAttribute("class") ?? "").toContain(
        "text-status-defaulted-icon",
      );
    });
  });

  describe("size variants", () => {
    const sizeProbes: Record<StatusPillSize, string> = {
      sm: "h-4",
      md: "h-6",
      lg: "h-8",
    };

    (Object.keys(sizeProbes) as StatusPillSize[]).forEach((size) => {
      it(`applies the ${size} size class chunk`, () => {
        render(<StatusPill status="paid" size={size} />);
        const pill = screen.getByRole("status");
        expect(pill).toHaveAttribute("data-size", size);
        expect(pill.className).toContain(sizeProbes[size]);
      });
    });

    it("defaults to md when size is omitted", () => {
      render(<StatusPill status="paid" />);
      expect(screen.getByRole("status")).toHaveAttribute("data-size", "md");
    });
  });

  describe("outdoor mode", () => {
    it("renders the CSS-variable-driven border utility regardless of theme", () => {
      // Outdoor mode flips `--pill-border-width` from 0 to 2px via
      // globals.css. The component just consumes the variable so the
      // same className is correct in both themes.
      document.documentElement.setAttribute("data-theme", "outdoor");
      try {
        render(<StatusPill status="available" />);
        const pill = screen.getByRole("status");
        expect(pill.className).toContain(
          "border-[length:var(--pill-border-width)]",
        );
        expect(pill.className).toContain("border-solid");
      } finally {
        document.documentElement.removeAttribute("data-theme");
      }
    });
  });

  describe("transitions", () => {
    it("declares the 300ms colour-only transition for status changes", () => {
      render(<StatusPill status="available" />);
      const pill = screen.getByRole("status");
      expect(pill.className).toContain(
        "transition-[background-color,color,border-color]",
      );
      expect(pill.className).toContain("duration-300");
    });

    it("re-renders cleanly when the status prop changes", () => {
      const { rerender } = render(<StatusPill status="available" />);
      expect(screen.getByRole("status")).toHaveAttribute(
        "data-status",
        "available",
      );
      rerender(<StatusPill status="overdue" />);
      expect(screen.getByRole("status")).toHaveAttribute(
        "data-status",
        "overdue",
      );
      expect(screen.getByRole("status")).toHaveTextContent("Overdue");
    });
  });

  describe("className override", () => {
    it("merges caller classes via tailwind-merge so overrides win", () => {
      render(<StatusPill status="sold" className="px-8" />);
      const pill = screen.getByRole("status");
      // tailwind-merge collapses the default `px-2.5` into the caller's `px-8`.
      expect(pill.className).toContain("px-8");
      expect(pill.className).not.toContain("px-2.5");
    });
  });
});
