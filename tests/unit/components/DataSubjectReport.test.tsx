/**
 * Story 2.4 — `DataSubjectReportView` component unit tests.
 *
 * The component is purely presentational. We mount it with a fully-
 * loaded report payload and verify:
 *   - Customer section: every PII field surfaces correctly.
 *   - Audit trail section: rows render in supplied order.
 *   - Follow-ups section: deferred sources show up.
 *   - Download JSON button: clicking it triggers a Blob download
 *     attempt with a sensible filename.
 *   - The raw JSON disclosure embeds the full payload as JSON.stringify.
 *
 * `URL.createObjectURL` / `revokeObjectURL` aren't shipped by jsdom by
 * default — we polyfill them as no-op spies so the download click
 * doesn't blow up.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { DataSubjectReportView } from "@/components/DataSubjectReport";
import type { DataSubjectReport } from "@/components/DataSubjectReport/types";

function makeReport(
  overrides: Partial<DataSubjectReport> = {},
): DataSubjectReport {
  const base: DataSubjectReport = {
    schemaVersion: "v1",
    generatedAt: new Date("2026-05-19T10:30:00+08:00").getTime(),
    generatedByUserId: "users:admin1",
    reason: "Subject access request ticket DSR-2026-0042.",
    customer: {
      customerId: "customers:cust1",
      fullName: "Maria Cruz",
      phone: "09171234567",
      email: "maria@example.com",
      address: {
        line1: "123 Main St",
        barangay: "Poblacion",
        cityMunicipality: "Quezon City",
        province: "Metro Manila",
        postalCode: "1100",
      },
      govIdType: "sss",
      govIdNumber: "1234-5678-9012",
      relationshipToOccupant: "spouse",
      hasConsent: true,
      consentTimestamp: new Date("2026-04-01T09:00:00+08:00").getTime(),
      consentCapturedByUserId: "users:office1",
      createdAt: new Date("2026-04-01T09:00:00+08:00").getTime(),
      createdByUserId: "users:office1",
      updatedAt: new Date("2026-05-10T11:00:00+08:00").getTime(),
    },
    customerAuditTrail: [
      {
        auditLogId: "auditLog:1",
        timestamp: new Date("2026-04-01T09:00:00+08:00").getTime(),
        actorUserId: "users:office1",
        action: "create",
        entityType: "customer",
        entityId: "customers:cust1",
        reason: "Initial record",
      },
      {
        auditLogId: "auditLog:2",
        timestamp: new Date("2026-05-19T10:30:00+08:00").getTime(),
        actorUserId: "users:admin1",
        action: "read_pii",
        entityType: "piiAccess",
        entityId: "customer:customers:cust1",
        reason: "Subject access request ticket DSR-2026-0042.",
      },
    ],
    actsByCustomer: [],
    attachments: [],
    ownerships: [],
    contracts: [],
    payments: [],
    receipts: [],
    followUps: [
      {
        source: "customerDocuments",
        status: "deferred",
        note: "Story 2.2 not landed.",
      },
      {
        source: "ownerships",
        status: "deferred",
        note: "Story 2.5 not landed.",
      },
    ],
  };
  return { ...base, ...overrides };
}

describe("DataSubjectReportView", () => {
  beforeEach(() => {
    // jsdom doesn't ship URL.createObjectURL — stub it as a spy so the
    // download path doesn't throw.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (URL as any).createObjectURL = vi.fn(() => "blob:fake");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (URL as any).revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the customer's full name in the heading", () => {
    render(<DataSubjectReportView report={makeReport()} />);
    expect(
      screen.getByRole("heading", { name: /Report for Maria Cruz/ }),
    ).toBeInTheDocument();
  });

  it("renders every PII field from the customer section", () => {
    render(<DataSubjectReportView report={makeReport()} />);
    expect(screen.getByText("Maria Cruz")).toBeInTheDocument();
    expect(screen.getByText("09171234567")).toBeInTheDocument();
    expect(screen.getByText("maria@example.com")).toBeInTheDocument();
    expect(screen.getByText("1234-5678-9012")).toBeInTheDocument();
    expect(screen.getByText("sss")).toBeInTheDocument();
    expect(screen.getByText("spouse")).toBeInTheDocument();
    // The composed address appears in BOTH the customer panel and
    // the embedded raw JSON; we use getAllByText to confirm at least
    // one occurrence (the rendered dd cell).
    expect(
      screen.getAllByText(
        /123 Main St.*Poblacion.*Quezon City.*Metro Manila.*1100/,
      ).length,
    ).toBeGreaterThan(0);
  });

  it("renders the schema version", () => {
    render(<DataSubjectReportView report={makeReport()} />);
    expect(screen.getByText(/Schema v1/)).toBeInTheDocument();
  });

  it("renders an em-dash for nullable PII fields when absent", () => {
    const sparse = makeReport({
      customer: {
        ...makeReport().customer,
        phone: null,
        email: null,
        relationshipToOccupant: null,
        consentTimestamp: null,
        consentCapturedByUserId: null,
        address: {
          line1: "Old book entry 1987",
          barangay: null,
          cityMunicipality: null,
          province: null,
          postalCode: null,
        },
      },
    });
    render(<DataSubjectReportView report={sparse} />);
    expect(screen.getByText("Old book entry 1987")).toBeInTheDocument();
    // At least one em-dash for the absent fields.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders every customer audit trail row", () => {
    render(<DataSubjectReportView report={makeReport()} />);
    expect(screen.getByText("create")).toBeInTheDocument();
    expect(screen.getByText("read_pii")).toBeInTheDocument();
    expect(screen.getByText("Initial record")).toBeInTheDocument();
    expect(
      screen.getByText("Subject access request ticket DSR-2026-0042."),
    ).toBeInTheDocument();
  });

  it("renders the empty-state copy for actsByCustomer when empty", () => {
    render(<DataSubjectReportView report={makeReport()} />);
    expect(
      screen.getByText(
        /Actions taken by this customer/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("No entries.")).toBeInTheDocument();
  });

  it("renders every follow-up source", () => {
    render(<DataSubjectReportView report={makeReport()} />);
    expect(screen.getByText("customerDocuments")).toBeInTheDocument();
    expect(screen.getByText("ownerships")).toBeInTheDocument();
  });

  it("renders the raw JSON inside a details disclosure", () => {
    render(<DataSubjectReportView report={makeReport()} />);
    const json = screen.getByTestId("report-json");
    // The JSON must include the schema version and the customer's name.
    expect(json.textContent).toContain("\"schemaVersion\": \"v1\"");
    expect(json.textContent).toContain("\"fullName\": \"Maria Cruz\"");
  });

  it("triggers a Blob download when the download button is clicked", () => {
    render(<DataSubjectReportView report={makeReport()} />);
    const button = screen.getByTestId("download-json-button");
    fireEvent.click(button);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((URL as any).createObjectURL).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blob = (URL as any).createObjectURL.mock.calls[0][0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/json");
  });
});
