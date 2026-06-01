/**
 * Client-side mirror of the `DataSubjectReport` payload shape returned
 * by `convex/dataSubject.ts → produceDataSubjectReport`.
 *
 * Kept in a separate file so test files + the page component can
 * import it without bundling JSX. We mirror by hand (not via type
 * import from `convex/`) because the convex side carries Convex's
 * branded `Id<...>` types — opaque strings at the wire level. The
 * client treats them as plain strings.
 */

export interface DataSubjectReportCustomerAddress {
  line1: string;
  barangay: string | null;
  cityMunicipality: string | null;
  province: string | null;
  postalCode: string | null;
}

export interface DataSubjectReportCustomerSection {
  customerId: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  address: DataSubjectReportCustomerAddress;
  govIdType: string;
  govIdNumber: string;
  relationshipToOccupant: string | null;
  hasConsent: boolean;
  consentTimestamp: number | null;
  consentCapturedByUserId: string | null;
  createdAt: number;
  createdByUserId: string;
  updatedAt: number;
}

export interface DataSubjectReportAuditEntry {
  auditLogId: string;
  timestamp: number;
  actorUserId: string;
  action: string;
  entityType: string;
  entityId: string;
  reason: string | null;
}

export interface DataSubjectReportFollowUp {
  source: string;
  status: "deferred";
  note: string;
}

export interface DataSubjectReport {
  schemaVersion: "v1";
  generatedAt: number;
  generatedByUserId: string;
  reason: string;
  customer: DataSubjectReportCustomerSection;
  customerAuditTrail: DataSubjectReportAuditEntry[];
  actsByCustomer: DataSubjectReportAuditEntry[];
  attachments: never[];
  ownerships: never[];
  contracts: never[];
  payments: never[];
  receipts: never[];
  followUps: DataSubjectReportFollowUp[];
}
