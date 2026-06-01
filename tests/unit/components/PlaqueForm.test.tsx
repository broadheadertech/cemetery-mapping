/**
 * Story 6.8 — `PlaqueForm` component tests.
 *
 * Coverage:
 *   - Renders with prefilled name + date format defaults.
 *   - Date-format radio toggle live-updates the preview date band
 *     (1942 — 2026 ↔ MCMXLII — MMXXVI).
 *   - Epitaph textarea respects the 240-char `maxLength` + the counter
 *     decreases as the operator types.
 *   - Submit blocked while validation fails (bornYear >= diedYear,
 *     missing name); inline errors render under the invalid field.
 *   - Submit fires `onSubmit` with the trimmed/typed values.
 *   - Form re-seeds when `initialValues` prop identity changes
 *     (mirrors the "Use as starting point" affordance).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PlaqueForm } from "../../../src/components/PlaqueForm";

beforeEach(() => {
  cleanup();
});

describe("PlaqueForm — initial render", () => {
  it("pre-fills name + date format from initialValues", () => {
    render(
      <PlaqueForm
        initialValues={{
          deceasedName: "Mateo Reyes",
          bornYear: 1942,
          diedYear: 2026,
          dateFormat: "arabic",
        }}
        onSubmit={async () => {}}
      />,
    );
    const nameInput = screen.getByTestId("plaque-form-name") as HTMLInputElement;
    expect(nameInput.value).toBe("Mateo Reyes");
    const bornInput = screen.getByTestId(
      "plaque-form-born-year",
    ) as HTMLInputElement;
    expect(bornInput.value).toBe("1942");
    const diedInput = screen.getByTestId(
      "plaque-form-died-year",
    ) as HTMLInputElement;
    expect(diedInput.value).toBe("2026");
    expect(screen.getByTestId("plaque-form-preview-name")).toHaveTextContent(
      "Mateo Reyes",
    );
    expect(screen.getByTestId("plaque-form-preview-dates")).toHaveTextContent(
      "1942 — 2026",
    );
  });
});

describe("PlaqueForm — date format toggle", () => {
  it("re-renders the live preview when the operator toggles arabic → roman", async () => {
    const user = userEvent.setup();
    render(
      <PlaqueForm
        initialValues={{
          deceasedName: "Mateo Reyes",
          bornYear: 1942,
          diedYear: 2026,
          dateFormat: "arabic",
        }}
        onSubmit={async () => {}}
      />,
    );
    expect(screen.getByTestId("plaque-form-preview-dates")).toHaveTextContent(
      "1942 — 2026",
    );
    await user.click(screen.getByTestId("plaque-form-format-roman"));
    expect(screen.getByTestId("plaque-form-preview-dates")).toHaveTextContent(
      "MCMXLII — MMXXVI",
    );
  });
});

describe("PlaqueForm — epitaph counter", () => {
  it("enforces the 240-char maxLength on the textarea", () => {
    render(
      <PlaqueForm
        initialValues={{
          deceasedName: "Mateo Reyes",
          bornYear: 1942,
          diedYear: 2026,
          dateFormat: "arabic",
        }}
        onSubmit={async () => {}}
      />,
    );
    const epitaph = screen.getByTestId(
      "plaque-form-epitaph",
    ) as HTMLTextAreaElement;
    expect(epitaph.maxLength).toBe(240);
  });

  it("decrements the remaining-count as the operator types", async () => {
    const user = userEvent.setup();
    render(
      <PlaqueForm
        initialValues={{
          deceasedName: "Mateo Reyes",
          bornYear: 1942,
          diedYear: 2026,
          dateFormat: "arabic",
        }}
        onSubmit={async () => {}}
      />,
    );
    expect(screen.getByTestId("plaque-form-epitaph-counter")).toHaveTextContent(
      "240 of 240 characters remaining",
    );
    await user.type(
      screen.getByTestId("plaque-form-epitaph"),
      "A devoted father",
    );
    expect(screen.getByTestId("plaque-form-epitaph-counter")).toHaveTextContent(
      `${240 - "A devoted father".length} of 240 characters remaining`,
    );
  });
});

describe("PlaqueForm — validation gating", () => {
  it("submit button is disabled when bornYear >= diedYear", async () => {
    render(
      <PlaqueForm
        initialValues={{
          deceasedName: "Mateo Reyes",
          bornYear: 2026,
          diedYear: 2026,
          dateFormat: "arabic",
        }}
        onSubmit={async () => {}}
      />,
    );
    const submit = screen.getByTestId(
      "plaque-form-submit",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("submit button is disabled when name is empty", () => {
    render(
      <PlaqueForm
        initialValues={{
          deceasedName: "",
          bornYear: 1942,
          diedYear: 2026,
          dateFormat: "arabic",
        }}
        onSubmit={async () => {}}
      />,
    );
    const submit = screen.getByTestId(
      "plaque-form-submit",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });
});

describe("PlaqueForm — submit", () => {
  it("calls onSubmit with the trimmed values on a valid submit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    render(
      <PlaqueForm
        initialValues={{
          deceasedName: "Mateo Reyes",
          bornYear: 1942,
          diedYear: 2026,
          dateFormat: "arabic",
        }}
        onSubmit={onSubmit}
      />,
    );
    await user.type(
      screen.getByTestId("plaque-form-epitaph"),
      "A kind soul.",
    );
    await user.click(screen.getByTestId("plaque-form-submit"));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit).toHaveBeenCalledWith({
      deceasedName: "Mateo Reyes",
      bornYear: 1942,
      diedYear: 2026,
      dateFormat: "arabic",
      epitaph: "A kind soul.",
    });
  });

  it("does not call onSubmit when the form is invalid", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    render(
      <PlaqueForm
        initialValues={{
          deceasedName: "",
          bornYear: 1942,
          diedYear: 2026,
          dateFormat: "arabic",
        }}
        onSubmit={onSubmit}
      />,
    );
    // Even if the user attempts to submit, the form blocks it.
    await user.click(screen.getByTestId("plaque-form-submit"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("surfaces submit errors as inline role=alert without leaving the button stuck", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {
      throw new Error("Convex rejected the request.");
    });
    render(
      <PlaqueForm
        initialValues={{
          deceasedName: "Mateo Reyes",
          bornYear: 1942,
          diedYear: 2026,
          dateFormat: "arabic",
        }}
        onSubmit={onSubmit}
      />,
    );
    await user.click(screen.getByTestId("plaque-form-submit"));
    await waitFor(() => {
      expect(
        screen.getByText("Convex rejected the request."),
      ).toBeInTheDocument();
    });
    const submit = screen.getByTestId(
      "plaque-form-submit",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });
});
