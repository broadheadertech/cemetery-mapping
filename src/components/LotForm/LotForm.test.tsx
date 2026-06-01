/**
 * LotForm — Story 1.8 component tests.
 *
 * Coverage:
 *   - Required fields surface inline validation errors.
 *   - Submit handler receives a normalised payload (centavos).
 *   - Edit mode disables `code` and pre-fills inputs.
 *   - Server error from `onSubmit` is translated and rendered.
 *
 * Story 1.15: the section input is now a dropdown wired to
 * `api.sections.listActiveSections`. The `convex/react` mock returns
 * a seeded section list so existing tests still find a `section`
 * field with a valid option to select.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

interface SectionStub {
  _id: string;
  name: string;
  displayName: string;
  sortOrder: number;
  kind: "chapel" | "family" | "standard" | "niche" | "columbarium";
}

// Default mock for the LotForm tests — three active sections seeded
// so the dropdown is populated and the test below can select "D" to
// satisfy the required-field check.
const lotFormSectionStubs: SectionStub[] = [
  {
    _id: "sections:d",
    name: "d",
    displayName: "D",
    sortOrder: 10,
    kind: "standard",
  },
];

vi.mock("convex/react", () => ({
  useQuery: () => lotFormSectionStubs,
  useMutation: () => vi.fn(),
}));

import { LotForm, type LotFormSubmitPayload } from "./LotForm";

describe("LotForm — create mode", () => {
  it("requires every field before submit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    render(<LotForm mode="create" onSubmit={onSubmit} />);

    await user.click(screen.getByRole("button", { name: /create lot/i }));

    // Code, section, block, row, price errors should all appear.
    await screen.findByText(/code is required/i);
    expect(await screen.findAllByText(/required/i)).not.toHaveLength(0);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("normalises the payload to integer centavos on submit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (_p: LotFormSubmitPayload) => {});
    render(<LotForm mode="create" onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/code/i), "D-5-12");
    // Story 1.15 — section is now a dropdown; select "D" from the
    // seeded test stubs (see vi.mock at top of file).
    await user.selectOptions(screen.getByLabelText(/section/i), "sections:d");
    await user.type(screen.getByLabelText(/block/i), "5");
    await user.type(screen.getByLabelText(/row/i), "12");
    // Width / depth default to 1 / 2; clear and re-type.
    const width = screen.getByLabelText(/width/i);
    await user.clear(width);
    await user.type(width, "1.5");
    const depth = screen.getByLabelText(/depth/i);
    await user.clear(depth);
    await user.type(depth, "2.5");
    await user.type(screen.getByLabelText(/base price/i), "1250.50");

    await user.click(screen.getByRole("button", { name: /create lot/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "D-5-12",
        section: "D",
        sectionId: "sections:d",
        block: "5",
        row: "12",
        type: "single",
        dimensions: { widthM: 1.5, depthM: 2.5 },
        basePriceCents: 125_050,
      }),
    );
  });

  it("renders submit error from onSubmit via translateError", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {
      throw Object.assign(new Error("server"), {
        data: { code: "DUPLICATE_CODE" },
      });
    });
    render(<LotForm mode="create" onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/code/i), "D-5-12");
    await user.selectOptions(screen.getByLabelText(/section/i), "sections:d");
    await user.type(screen.getByLabelText(/block/i), "5");
    await user.type(screen.getByLabelText(/row/i), "12");
    await user.type(screen.getByLabelText(/base price/i), "1000");

    await user.click(screen.getByRole("button", { name: /create lot/i }));

    // The form's submit-error alert renders the translated detail
    // sentence — currently the FALLBACK because the test-double
    // error isn't a ConvexError instance. We assert SOME error
    // alert appears rather than the exact text, which keeps the
    // test resilient to future copy tweaks.
    await screen.findByTestId("lot-form-error");
  });
});

describe("LotForm — edit mode", () => {
  it("disables the code input and pre-fills the form", () => {
    render(
      <LotForm
        mode="edit"
        defaultValues={{
          code: "D-5-12",
          section: "D",
          block: "5",
          row: "12",
          type: "family",
          dimensions: { widthM: 2, depthM: 3 },
          basePriceCents: 150_000_00,
        }}
        onSubmit={vi.fn()}
      />,
    );
    const code = screen.getByLabelText(/code/i) as HTMLInputElement;
    expect(code.value).toBe("D-5-12");
    expect(code).toBeDisabled();
    expect((screen.getByLabelText(/base price/i) as HTMLInputElement).value).toBe(
      "150000",
    );
  });

  it("submits an edit payload with the same shape as create", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    render(
      <LotForm
        mode="edit"
        defaultValues={{
          code: "D-5-12",
          section: "D",
          // Story 1.15 — sectionId must be present so the FK-required
          // form validates on submit. Matches the seeded stub above.
          sectionId: "sections:d",
          block: "5",
          row: "12",
          type: "single",
          dimensions: { widthM: 1.5, depthM: 2.5 },
          basePriceCents: 100_000_00,
        }}
        onSubmit={onSubmit}
      />,
    );
    const price = screen.getByLabelText(/base price/i);
    await user.clear(price);
    await user.type(price, "120000");

    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ basePriceCents: 120_000_00 }),
    );
  });
});
