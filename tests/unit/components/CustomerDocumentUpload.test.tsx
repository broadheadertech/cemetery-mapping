/**
 * Story 2.2 — `<CustomerDocumentUpload>` component tests.
 *
 * Covers:
 *   - Client-side MIME + size validation (rejects gif, oversized
 *     PDF, etc. before touching the network).
 *   - Successful flow: generateUrl mutation -> fetch POST ->
 *     uploadDocument mutation -> success banner + onUploaded
 *     callback.
 *   - Server-side rejection surfaces a translated error; the
 *     consent-required branch surfaces the "Update consent" link.
 *
 * Convex hooks are mocked at the module level — jsdom has no Convex
 * client connection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { ConvexError } from "convex/values";

const generateUrlMock = vi.fn();
const uploadDocumentMock = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => {
    // We discriminate by the second character of the function name
    // baked into the function reference. Both refs are
    // `makeFunctionReference("customerDocuments:...")` — the
    // reference object itself is opaque, but we get its identity
    // back from the spy at call time. Simpler approach: alternate
    // by call order. The component calls `useMutation(generateUrl)`
    // first, then `useMutation(uploadDocument)`.
    const idx = useMutationCallCount.value++;
    if (idx % 2 === 0) return generateUrlMock;
    return uploadDocumentMock;
  },
}));

const useMutationCallCount = { value: 0 };

vi.mock("next/navigation", () => ({
  // Component doesn't currently use any next/navigation hook, but
  // future re-renders that switch to redirect should not blow up.
  useRouter: () => ({ push: vi.fn() }),
}));

import { CustomerDocumentUpload } from "@/components/CustomerDocumentUpload";

// Replace global fetch so the upload POST never tries to hit the
// network. Tests configure the response per-case.
const fetchMock = vi.fn();
beforeEach(() => {
  cleanup();
  generateUrlMock.mockReset();
  uploadDocumentMock.mockReset();
  fetchMock.mockReset();
  useMutationCallCount.value = 0;
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch;
});

function makeFile(opts: {
  name?: string;
  type?: string;
  sizeBytes?: number;
}): File {
  const size = opts.sizeBytes ?? 1024;
  const content = new Uint8Array(size);
  return new File([content], opts.name ?? "id.jpg", {
    type: opts.type ?? "image/jpeg",
  });
}

describe("CustomerDocumentUpload — client-side validation", () => {
  it("rejects a disallowed MIME type before any network call", () => {
    render(<CustomerDocumentUpload customerId="customers:1" />);
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = makeFile({ name: "bad.gif", type: "image/gif" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(
      screen.getByTestId("customer-document-upload-error"),
    ).toHaveTextContent(/Only JPG, PNG, WEBP, or PDF/i);
    expect(generateUrlMock).not.toHaveBeenCalled();
  });

  it("rejects files larger than 10MB before any network call", () => {
    render(<CustomerDocumentUpload customerId="customers:1" />);
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = makeFile({
      name: "huge.pdf",
      type: "application/pdf",
      sizeBytes: 11 * 1024 * 1024,
    });
    fireEvent.change(input, { target: { files: [file] } });

    expect(
      screen.getByTestId("customer-document-upload-error"),
    ).toHaveTextContent(/smaller than 10MB/i);
    expect(generateUrlMock).not.toHaveBeenCalled();
  });

  it("rejects empty files", () => {
    render(<CustomerDocumentUpload customerId="customers:1" />);
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = makeFile({ name: "empty.jpg", sizeBytes: 0 });
    fireEvent.change(input, { target: { files: [file] } });

    expect(
      screen.getByTestId("customer-document-upload-error"),
    ).toHaveTextContent(/empty/i);
    expect(generateUrlMock).not.toHaveBeenCalled();
  });

  it("shows the selected file metadata after a valid pick", () => {
    render(<CustomerDocumentUpload customerId="customers:1" />);
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = makeFile({ name: "id.jpg", sizeBytes: 256 * 1024 });
    fireEvent.change(input, { target: { files: [file] } });

    expect(
      screen.getByTestId("customer-document-selected"),
    ).toHaveTextContent("id.jpg");
  });
});

describe("CustomerDocumentUpload — successful upload flow", () => {
  it("runs generateUrl, POSTs the file, calls uploadDocument, fires onUploaded", async () => {
    const onUploaded = vi.fn();
    generateUrlMock.mockResolvedValue("https://example/upload/abc");
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ storageId: "_storage:new" }),
    });
    uploadDocumentMock.mockResolvedValue({
      documentId: "customerDocuments:1",
    });

    render(
      <CustomerDocumentUpload
        customerId="customers:1"
        onUploaded={onUploaded}
      />,
    );

    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = makeFile({ name: "id.jpg", sizeBytes: 1024 * 1024 });
    fireEvent.change(input, { target: { files: [file] } });

    const submit = screen.getByRole("button", { name: /upload document/i });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(generateUrlMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example/upload/abc",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "image/jpeg",
        }),
        body: file,
      }),
    );
    await waitFor(() => {
      expect(uploadDocumentMock).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: "customers:1",
          docType: "national_id",
          fileName: "id.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 1024 * 1024,
          storageId: "_storage:new",
        }),
      );
    });
    await waitFor(() => {
      expect(onUploaded).toHaveBeenCalledWith("customerDocuments:1");
    });
    expect(
      screen.getByTestId("customer-document-upload-success"),
    ).toBeInTheDocument();
  });
});

describe("CustomerDocumentUpload — server-side error surfaces", () => {
  it("displays a consent-required action when the server throws INVARIANT_VIOLATION about consent", async () => {
    generateUrlMock.mockResolvedValue("https://example/upload/abc");
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ storageId: "_storage:new" }),
    });
    uploadDocumentMock.mockRejectedValue(
      new ConvexError({
        code: "INVARIANT_VIOLATION",
        message:
          "Customer consent is required before attaching identification documents. Update consent on the customer record first.",
      }),
    );

    render(<CustomerDocumentUpload customerId="customers:1" />);
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [makeFile({ sizeBytes: 1024 })] },
    });
    fireEvent.click(screen.getByRole("button", { name: /upload document/i }));

    const errorBox = await screen.findByTestId(
      "customer-document-upload-error",
    );
    expect(errorBox).toHaveTextContent(/consent is required/i);
    expect(errorBox).toHaveTextContent(/Update consent on the customer record/i);
  });

  it("displays a generic translated error for other server failures", async () => {
    generateUrlMock.mockResolvedValue("https://example/upload/abc");
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ storageId: "_storage:new" }),
    });
    uploadDocumentMock.mockRejectedValue(
      new ConvexError({
        code: "FORBIDDEN",
        message: "Your role does not permit this action.",
      }),
    );

    render(<CustomerDocumentUpload customerId="customers:1" />);
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [makeFile({ sizeBytes: 1024 })] },
    });
    fireEvent.click(screen.getByRole("button", { name: /upload document/i }));

    const errorBox = await screen.findByTestId(
      "customer-document-upload-error",
    );
    expect(errorBox).toHaveTextContent(/Your role does not permit this action/);
    // Should NOT show the consent-update link for a FORBIDDEN error.
    expect(errorBox).not.toHaveTextContent(/Update consent on the customer record/i);
  });

  it("displays an error when the file upload POST fails", async () => {
    generateUrlMock.mockResolvedValue("https://example/upload/abc");
    fetchMock.mockResolvedValue({ ok: false });

    render(<CustomerDocumentUpload customerId="customers:1" />);
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [makeFile({ sizeBytes: 1024 })] },
    });
    fireEvent.click(screen.getByRole("button", { name: /upload document/i }));

    const errorBox = await screen.findByTestId(
      "customer-document-upload-error",
    );
    expect(errorBox).toBeInTheDocument();
    expect(uploadDocumentMock).not.toHaveBeenCalled();
  });
});

describe("CustomerDocumentUpload — submit guard", () => {
  it("disables the submit button until a file is chosen", () => {
    render(<CustomerDocumentUpload customerId="customers:1" />);
    const submit = screen.getByRole("button", {
      name: /upload document/i,
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });
});
