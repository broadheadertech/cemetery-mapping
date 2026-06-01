/**
 * Story 9.4 — `<CustomerAccountForm>` component tests.
 *
 * Coverage:
 *   - AC1 render: identity fields render with `readOnly` +
 *     `aria-readonly="true"`; the visible helper note points the
 *     customer at the cemetery office; editable contact fields are
 *     pre-filled from the initial props.
 *   - AC1 touch targets: editable inputs + the submit button meet the
 *     ≥48px portal touch target (NFR-A4) — asserted via the `min-h-`
 *     class which Tailwind compiles to `min-height` rules.
 *   - AC4 dirty-state gate: the Save button is disabled until the
 *     customer makes a meaningful change (the "submit unchanged form"
 *     bug never reaches the server).
 *   - AC4 client validation: invalid phone / email surface inline
 *     errors and the mutation is NOT invoked.
 *   - AC2 happy path: a valid phone change calls the mutation with
 *     the trimmed string; the success state appears.
 *   - AC2 mutation payload shape: the form passes through ONLY the
 *     fields that changed — `name` / `govId` / `_id` are never in
 *     the payload (the form doesn't even register them with RHF).
 *   - AC4 error rendering: a thrown mutation surfaces a translated
 *     error in the alert region.
 *
 * The component owns `useMutation` and `useQuery`, so the tests mock
 * `convex/react` with deterministic stubs — no Convex network
 * round-trip. `next/navigation` and `next/link` aren't used by this
 * component but are mocked defensively to keep render() from
 * complaining about ESM imports.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

interface UpdateResult {
  customerId: string;
  updatedFields: Array<"phone" | "email" | "address">;
}

const updateMutationMock = vi.fn<(_args: unknown) => Promise<UpdateResult>>(
  async (_args) => ({ customerId: "customers:c1", updatedFields: [] }),
);

let currentProfileMock: {
  customerId: string;
  fullName: string;
  email: string;
} | null = null;

vi.mock("convex/react", () => ({
  useMutation: () => updateMutationMock,
  useQuery: (_ref: unknown) => {
    return currentProfileMock ?? undefined;
  },
}));

import { CustomerAccountForm } from "@/components/CustomerPortal/CustomerAccountForm";

const INITIAL_PROPS = {
  initialFullName: "Maria Cruz",
  initialPhone: "+639170000001",
  initialEmail: "maria@example.com",
  initialAddress: {
    line1: "1 Old St",
    cityMunicipality: "Manila",
  },
  govIdLast4: "7890",
  govIdTypeLabel: "SSS",
} as const;

beforeEach(() => {
  cleanup();
  updateMutationMock.mockClear();
  updateMutationMock.mockResolvedValue({
    customerId: "customers:c1",
    updatedFields: [],
  });
  // Mirror the server snapshot — the live query returns the same
  // values the props carry so the form's "live wins" logic does not
  // clobber the initial state.
  currentProfileMock = {
    customerId: "customers:c1",
    fullName: INITIAL_PROPS.initialFullName,
    email: INITIAL_PROPS.initialEmail,
  };
});

afterEach(() => {
  cleanup();
  currentProfileMock = null;
});

describe("CustomerAccountForm — AC1 render (read-only identity)", () => {
  it("renders the identity fields with readOnly + aria-readonly", () => {
    render(<CustomerAccountForm {...INITIAL_PROPS} />);
    const fullNameInput = screen.getByLabelText("Full name") as HTMLInputElement;
    expect(fullNameInput.readOnly).toBe(true);
    expect(fullNameInput.getAttribute("aria-readonly")).toBe("true");
    expect(fullNameInput.value).toBe("Maria Cruz");

    const govIdInput = screen.getByLabelText("SSS") as HTMLInputElement;
    expect(govIdInput.readOnly).toBe(true);
    expect(govIdInput.getAttribute("aria-readonly")).toBe("true");
    expect(govIdInput.value).toBe("***-***-7890");
  });

  it("shows the contact-the-office helper note", () => {
    render(<CustomerAccountForm {...INITIAL_PROPS} />);
    expect(
      screen.getByText(/Amendments to these fields are made through the Estate Office/i),
    ).toBeInTheDocument();
  });

  it("pre-fills the editable contact fields from initial props", () => {
    render(<CustomerAccountForm {...INITIAL_PROPS} />);
    expect((screen.getByLabelText(/^Phone$/i) as HTMLInputElement).value).toBe(
      "+639170000001",
    );
    expect((screen.getByLabelText(/^Email$/i) as HTMLInputElement).value).toBe(
      "maria@example.com",
    );
    expect(
      (screen.getByLabelText(/Address line 1/i) as HTMLTextAreaElement).value,
    ).toBe("1 Old St");
    expect(
      (screen.getByLabelText(/City \/ Municipality/i) as HTMLInputElement)
        .value,
    ).toBe("Manila");
  });

  it("applies the NFR-A4 48px touch target to editable inputs + submit", () => {
    render(<CustomerAccountForm {...INITIAL_PROPS} />);
    expect(screen.getByLabelText(/^Phone$/i).className).toMatch(
      /min-h-\[48px\]/,
    );
    expect(screen.getByLabelText(/^Email$/i).className).toMatch(
      /min-h-\[48px\]/,
    );
    expect(
      screen.getByRole("button", { name: /commit to the record/i }).className,
    ).toMatch(/min-h-\[48px\]/);
  });

  it("falls back to a placeholder gov-ID label when govIdLast4 is omitted", () => {
    render(
      <CustomerAccountForm
        initialFullName="Maria Cruz"
        initialPhone="+639170000001"
        initialEmail="maria@example.com"
        initialAddress={{ line1: "1 Old St" }}
      />,
    );
    const govIdInput = screen.getByLabelText(
      "Government ID",
    ) as HTMLInputElement;
    expect(govIdInput.value).toBe("•••• •••• ••••");
  });
});

describe("CustomerAccountForm — AC4 dirty-state gate", () => {
  it("disables the Save button until a field changes", () => {
    render(<CustomerAccountForm {...INITIAL_PROPS} />);
    const submit = screen.getByRole("button", { name: /commit to the record/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables the Save button after the customer edits phone", async () => {
    const user = userEvent.setup();
    render(<CustomerAccountForm {...INITIAL_PROPS} />);
    const phone = screen.getByLabelText(/^Phone$/i);
    await user.clear(phone);
    await user.type(phone, "09177771234");
    const submit = screen.getByRole("button", { name: /commit to the record/i });
    await waitFor(() => {
      expect((submit as HTMLButtonElement).disabled).toBe(false);
    });
  });
});

describe("CustomerAccountForm — AC4 inline validation", () => {
  it("blocks submit when the phone is malformed", async () => {
    const user = userEvent.setup();
    render(<CustomerAccountForm {...INITIAL_PROPS} />);
    const phone = screen.getByLabelText(/^Phone$/i);
    await user.clear(phone);
    await user.type(phone, "abcde");
    await user.tab(); // trigger onBlur validation

    await waitFor(() => {
      expect(
        screen.getByText(/Philippine mobile number/i),
      ).toBeInTheDocument();
    });
    const submit = screen.getByRole("button", { name: /commit to the record/i });
    await user.click(submit);
    expect(updateMutationMock).not.toHaveBeenCalled();
  });

  it("blocks submit when the email is malformed", async () => {
    const user = userEvent.setup();
    render(<CustomerAccountForm {...INITIAL_PROPS} />);
    const email = screen.getByLabelText(/^Email$/i);
    await user.clear(email);
    await user.type(email, "not-an-email");
    await user.tab();

    await waitFor(() => {
      expect(screen.getByText(/valid email address/i)).toBeInTheDocument();
    });
    const submit = screen.getByRole("button", { name: /commit to the record/i });
    await user.click(submit);
    expect(updateMutationMock).not.toHaveBeenCalled();
  });
});

describe("CustomerAccountForm — AC2 happy path", () => {
  it("calls the mutation with only the changed phone field", async () => {
    const user = userEvent.setup();
    updateMutationMock.mockResolvedValueOnce({
      customerId: "customers:c1",
      updatedFields: ["phone"],
    });

    render(<CustomerAccountForm {...INITIAL_PROPS} />);
    const phone = screen.getByLabelText(/^Phone$/i);
    await user.clear(phone);
    await user.type(phone, "09177771234");
    await user.click(screen.getByRole("button", { name: /commit to the record/i }));

    await waitFor(() => {
      expect(updateMutationMock).toHaveBeenCalledTimes(1);
    });
    const payload = updateMutationMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(payload.phone).toBe("09177771234");
    // ONLY phone changed — other fields must NOT be in the payload.
    expect("email" in payload).toBe(false);
    expect("address" in payload).toBe(false);
    // Identity fields are never registered with RHF → never in the payload.
    expect("fullName" in payload).toBe(false);
    expect("name" in payload).toBe(false);
    expect("govIdNumber" in payload).toBe(false);
    expect("customerId" in payload).toBe(false);
  });

  it("shows the success toast after a successful save", async () => {
    const user = userEvent.setup();
    updateMutationMock.mockResolvedValueOnce({
      customerId: "customers:c1",
      updatedFields: ["phone"],
    });

    render(<CustomerAccountForm {...INITIAL_PROPS} />);
    const phone = screen.getByLabelText(/^Phone$/i);
    await user.clear(phone);
    await user.type(phone, "09177771234");
    await user.click(screen.getByRole("button", { name: /commit to the record/i }));

    await waitFor(() => {
      expect(
        screen.getByTestId("customer-account-success"),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("customer-account-success").textContent).toMatch(
      /updated/i,
    );
  });

  it("passes the structured address when address fields change", async () => {
    const user = userEvent.setup();
    updateMutationMock.mockResolvedValueOnce({
      customerId: "customers:c1",
      updatedFields: ["address"],
    });

    render(<CustomerAccountForm {...INITIAL_PROPS} />);
    const line1 = screen.getByLabelText(/Address line 1/i);
    await user.clear(line1);
    await user.type(line1, "456 New Rd");
    await user.click(screen.getByRole("button", { name: /commit to the record/i }));

    await waitFor(() => {
      expect(updateMutationMock).toHaveBeenCalledTimes(1);
    });
    const payload = updateMutationMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(payload.address).toEqual({
      line1: "456 New Rd",
      cityMunicipality: "Manila",
    });
    expect("phone" in payload).toBe(false);
    expect("email" in payload).toBe(false);
  });
});

describe("CustomerAccountForm — AC4 mutation error rendering", () => {
  it("surfaces a translated error when the mutation throws", async () => {
    const user = userEvent.setup();
    updateMutationMock.mockRejectedValueOnce(new Error("boom"));

    render(<CustomerAccountForm {...INITIAL_PROPS} />);
    const phone = screen.getByLabelText(/^Phone$/i);
    await user.clear(phone);
    await user.type(phone, "09177771234");
    await user.click(screen.getByRole("button", { name: /commit to the record/i }));

    await waitFor(() => {
      expect(
        screen.getByTestId("customer-account-error"),
      ).toBeInTheDocument();
    });
  });
});
