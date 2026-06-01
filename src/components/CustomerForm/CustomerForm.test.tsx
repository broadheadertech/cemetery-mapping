/**
 * Story 2.1 — CustomerForm component tests.
 *
 * Coverage:
 *   - AC3 render: all required fields present; submit disabled until
 *     consent is given.
 *   - AC4 consent gate: checking the consent box enables submit.
 *   - AC5 dedupe: when `searchByName` returns a hit, the alert
 *     renders with `***-***-LAST4` formatting and a [View] link.
 *   - Gov-ID masking: on blur the field shows `"•••• •••• 1234"`;
 *     on focus the full value re-appears.
 *   - Submit payload normalisation: empty-string optional fields
 *     are dropped from the mutation args.
 *   - Submit error from the mutation is translated and rendered.
 *
 * The component owns `useMutation` and `useQuery`, so the tests
 * mock `convex/react` with deterministic stubs (no Convex network
 * round-trip). `useDebouncedValue` is mocked to pass through
 * synchronously — the 300ms debounce is a wall-clock concern and
 * fights `userEvent` timing.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const createMutationMock = vi.fn(
  async (_args: unknown) =>
    ({ customerId: "customers:new1", fullName: "Maria Cruz" }) as const,
);
const searchByNameMock = vi.fn<(args?: unknown) => unknown[]>(() => []);

vi.mock("convex/react", () => ({
  useMutation: () => createMutationMock,
  useQuery: (_ref: unknown, args: unknown) => {
    if (args === "skip") return undefined;
    return searchByNameMock(args);
  },
}));

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// Pass-through debounce so tests don't fight fake timers vs
// real-timer-driven userEvent. The 300ms debounce is exercised at
// the hook level in `useDebouncedValue.test.ts`.
vi.mock("@/hooks/useDebouncedValue", () => ({
  useDebouncedValue: <T,>(value: T) => value,
}));

import { CustomerForm } from "./CustomerForm";

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/full name/i), "Maria Cruz");
  await user.type(screen.getByLabelText(/line 1/i), "123 Main St");
  await user.type(
    screen.getByLabelText(/government id number/i),
    "1234-5678-9012",
  );
}

beforeEach(() => {
  cleanup();
  createMutationMock.mockClear();
  searchByNameMock.mockClear();
  pushMock.mockClear();
  searchByNameMock.mockReturnValue([]);
});

afterEach(() => {
  cleanup();
});

describe("CustomerForm — AC3 render + AC4 consent gate", () => {
  it("renders the full name, address, gov-ID, and consent fields", () => {
    render(<CustomerForm />);
    expect(screen.getByLabelText(/full name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/line 1/i)).toBeInTheDocument();
    expect(
      screen.getByLabelText(/government id number/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/government id type/i)).toBeInTheDocument();
    // The consent fieldset is the canonical anchor (legend text).
    // Using getAllByText because "Data Privacy Act" appears in both
    // the legend and the descriptive copy below the checkbox.
    expect(screen.getAllByText(/Data Privacy Act/i).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
  });

  it("renders today's Manila date inside the consent label", () => {
    render(<CustomerForm />);
    // Loose: the label includes "Captured:" followed by a date.
    expect(screen.getByText(/Captured:/i)).toBeInTheDocument();
  });

  it("disables submit until the consent checkbox is checked", async () => {
    const user = userEvent.setup();
    render(<CustomerForm />);
    const submit = screen.getByRole("button", { name: /create customer/i });
    expect(submit).toBeDisabled();
    const checkbox = screen.getByRole("checkbox");
    await user.click(checkbox);
    expect(submit).not.toBeDisabled();
  });
});

describe("CustomerForm — AC2 successful submit", () => {
  it("calls the create mutation with normalised args + redirects when onCreated is absent", async () => {
    const user = userEvent.setup();
    render(<CustomerForm />);
    await fillRequiredFields(user);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: /create customer/i }));

    await waitFor(() => expect(createMutationMock).toHaveBeenCalledTimes(1));
    const args = createMutationMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(args.fullName).toBe("Maria Cruz");
    expect(args.hasConsent).toBe(true);
    expect(args.govIdNumber).toBe("1234-5678-9012");
    expect((args.address as Record<string, unknown>).line1).toBe(
      "123 Main St",
    );
    // Empty optional fields dropped (not `""`):
    expect(args.phone).toBeUndefined();
    expect(args.email).toBeUndefined();

    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith("/customers/customers:new1"),
    );
  });

  it("invokes onCreated and skips the redirect when the prop is supplied", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(<CustomerForm onCreated={onCreated} />);
    await fillRequiredFields(user);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: /create customer/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated).toHaveBeenCalledWith(
      "customers:new1",
      expect.any(String),
    );
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("surfaces a translated error when the mutation rejects", async () => {
    const user = userEvent.setup();
    (createMutationMock as unknown as Mock).mockRejectedValueOnce(
      Object.assign(new Error("server"), {
        data: { code: "FORBIDDEN" },
      }),
    );
    render(<CustomerForm />);
    await fillRequiredFields(user);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: /create customer/i }));
    await screen.findByTestId("customer-form-error");
  });
});

describe("CustomerForm — AC5 dedupe alert", () => {
  it("renders the alert with ***-***-LAST4 formatting when matches exist", async () => {
    searchByNameMock.mockReturnValue([
      {
        customerId: "customers:existing",
        fullName: "Maria Cruz",
        govIdLast4: "1234",
      },
    ]);
    const user = userEvent.setup();
    render(<CustomerForm />);
    await user.type(screen.getByLabelText(/full name/i), "Mar");
    const alert = await screen.findByTestId("customer-dedupe-alert");
    expect(alert).toBeInTheDocument();
    expect(alert.textContent).toContain("***-***-1234");
    expect(alert.textContent).toContain("Maria Cruz");
    // [View] is a Link to the existing customer's detail page.
    const viewLink = alert.querySelector("a");
    expect(viewLink?.getAttribute("href")).toBe(
      "/customers/customers:existing",
    );
  });

  it("does not render the alert when fewer than 3 chars are typed", async () => {
    searchByNameMock.mockReturnValue([
      {
        customerId: "customers:existing",
        fullName: "Maria",
        govIdLast4: "1234",
      },
    ]);
    const user = userEvent.setup();
    render(<CustomerForm />);
    await user.type(screen.getByLabelText(/full name/i), "Ma");
    // The mock returns matches regardless of input length, but the
    // component skips the useQuery (passes "skip") until ≥ 3 chars.
    expect(
      screen.queryByTestId("customer-dedupe-alert"),
    ).not.toBeInTheDocument();
  });

  it("hides the alert when [Continue with new] is clicked", async () => {
    searchByNameMock.mockReturnValue([
      {
        customerId: "customers:existing",
        fullName: "Maria Cruz",
        govIdLast4: "1234",
      },
    ]);
    const user = userEvent.setup();
    render(<CustomerForm />);
    await user.type(screen.getByLabelText(/full name/i), "Mar");
    await screen.findByTestId("customer-dedupe-alert");
    await user.click(screen.getByRole("button", { name: /continue with new/i }));
    expect(
      screen.queryByTestId("customer-dedupe-alert"),
    ).not.toBeInTheDocument();
  });
});

describe("CustomerForm — gov-ID masking (UX §1875–1886)", () => {
  it("masks the field on blur as `•••• •••• LAST4`", async () => {
    const user = userEvent.setup();
    render(<CustomerForm />);
    const input = screen.getByLabelText(
      /government id number/i,
    ) as HTMLInputElement;
    await user.click(input);
    await user.type(input, "1234-5678-9012");
    // Focused: full value visible.
    expect(input.value).toBe("1234-5678-9012");
    // Tab away to blur the field — masking kicks in.
    await user.tab();
    expect(input.value).toBe("•••• •••• 9012");
    expect(input.getAttribute("data-masked")).toBe("true");
  });

  it("re-shows the full value when the field regains focus", async () => {
    const user = userEvent.setup();
    render(<CustomerForm />);
    const input = screen.getByLabelText(
      /government id number/i,
    ) as HTMLInputElement;
    await user.click(input);
    await user.type(input, "1234-5678-9012");
    await user.tab();
    expect(input.value).toBe("•••• •••• 9012");
    await user.click(input);
    expect(input.value).toBe("1234-5678-9012");
  });
});
