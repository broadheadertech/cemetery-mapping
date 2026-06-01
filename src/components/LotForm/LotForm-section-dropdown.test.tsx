/**
 * LotForm — Story 1.15 section-dropdown coverage.
 *
 * The LotForm's free-text Section input is replaced by a dropdown
 * wired to `api.sections.listActiveSections`. These tests cover:
 *   - Active sections appear in the dropdown.
 *   - The empty-registry case surfaces a helper note pointing to
 *     `/admin/sections`.
 *   - The loading state renders a disabled placeholder.
 *   - Submit composes the selected `sectionId` AND the section
 *     `displayName` (for the legacy back-compat column).
 *
 * Each test re-renders the form with a fresh `convex/react` mock
 * implementation so the seeded list varies per scenario.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

interface SectionStub {
  _id: string;
  name: string;
  displayName: string;
  sortOrder: number;
  kind: "chapel" | "family" | "standard" | "niche" | "columbarium";
}

// Mutable per-test stub for the section list. Initialised to the
// three brand-guide-style sections AC3 of the story names; tests
// reassign it for the empty / loading variants.
let stubSections: SectionStub[] | undefined = [
  {
    _id: "sections:s1",
    name: "section-a-north",
    displayName: "Section A · North",
    sortOrder: 10,
    kind: "standard",
  },
  {
    _id: "sections:s2",
    name: "section-b-south",
    displayName: "Section B · South",
    sortOrder: 20,
    kind: "standard",
  },
  {
    _id: "sections:s3",
    name: "chapel-of-grace",
    displayName: "Chapel of Grace",
    sortOrder: 30,
    kind: "chapel",
  },
];

vi.mock("convex/react", () => ({
  useQuery: () => stubSections,
  useMutation: () => vi.fn(),
}));

// Imported AFTER the mock so the module picks up the stub.
import { LotForm, type LotFormSubmitPayload } from "./LotForm";

afterEach(() => {
  cleanup();
  stubSections = [
    {
      _id: "sections:s1",
      name: "section-a-north",
      displayName: "Section A · North",
      sortOrder: 10,
      kind: "standard",
    },
    {
      _id: "sections:s2",
      name: "section-b-south",
      displayName: "Section B · South",
      sortOrder: 20,
      kind: "standard",
    },
    {
      _id: "sections:s3",
      name: "chapel-of-grace",
      displayName: "Chapel of Grace",
      sortOrder: 30,
      kind: "chapel",
    },
  ];
});

describe("LotForm — section dropdown (Story 1.15)", () => {
  it("renders every active section as a dropdown option", () => {
    render(<LotForm mode="create" onSubmit={vi.fn()} />);
    const select = screen.getByLabelText(/section/i) as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    // Placeholder + 3 sections.
    expect(optionValues).toEqual([
      "",
      "sections:s1",
      "sections:s2",
      "sections:s3",
    ]);
    const optionTexts = Array.from(select.options).map((o) => o.textContent);
    expect(optionTexts).toContain("Section A · North");
    expect(optionTexts).toContain("Section B · South");
    expect(optionTexts).toContain("Chapel of Grace");
  });

  it("submit composes both sectionId AND the section displayName", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (_p: LotFormSubmitPayload) => {});
    render(<LotForm mode="create" onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/code/i), "A-1-1");
    await user.selectOptions(
      screen.getByLabelText(/section/i),
      "sections:s1",
    );
    await user.type(screen.getByLabelText(/block/i), "1");
    await user.type(screen.getByLabelText(/row/i), "1");
    await user.type(screen.getByLabelText(/base price/i), "1500");

    await user.click(screen.getByRole("button", { name: /create lot/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        sectionId: "sections:s1",
        section: "Section A · North",
      }),
    );
  });

  it("surfaces the empty-registry helper note pointing at /admin/sections", () => {
    stubSections = [];
    render(<LotForm mode="create" onSubmit={vi.fn()} />);
    expect(
      screen.getByTestId("lot-section-empty-hint"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /\/admin\/sections/i }),
    ).toBeInTheDocument();
  });

  it("renders a disabled placeholder while the query is loading", () => {
    stubSections = undefined;
    render(<LotForm mode="create" onSubmit={vi.fn()} />);
    const select = screen.getByLabelText(/section/i) as HTMLSelectElement;
    expect(select).toBeDisabled();
    expect(select.options[0]!.textContent).toMatch(/Loading sections/i);
  });

  it("blocks submit when no section is selected (placeholder option only)", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (_p: LotFormSubmitPayload) => {});
    render(<LotForm mode="create" onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/code/i), "A-1-1");
    // Skip selecting a section.
    await user.type(screen.getByLabelText(/block/i), "1");
    await user.type(screen.getByLabelText(/row/i), "1");
    await user.type(screen.getByLabelText(/base price/i), "1500");

    await user.click(screen.getByRole("button", { name: /create lot/i }));

    // The Zod schema requires sectionId.min(1); submit should not fire.
    await screen.findByText(/section is required/i);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
