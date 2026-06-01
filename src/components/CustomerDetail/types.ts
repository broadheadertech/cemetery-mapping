/**
 * Shared types for the CustomerDetail composite (Story 2.5).
 *
 * Re-declares the wire shape of `getCustomerDetail`'s return payload as
 * a TypeScript-only type so the React layer can typecheck without
 * importing from `convex/_generated/` (which only exists after
 * `npx convex dev` has run interactively).
 */

export type CustomerGovIdType =
  | "sss"
  | "tin"
  | "umid"
  | "drivers_license"
  | "passport"
  | "philhealth"
  | "voters_id"
  | "other";

export interface CustomerDetailAddress {
  line1: string;
  barangay?: string;
  cityMunicipality?: string;
  province?: string;
  postalCode?: string;
}

export interface CustomerDetailData {
  customerId: string;
  fullName: string;
  phone?: string;
  email?: string;
  address: CustomerDetailAddress;
  govIdType: CustomerGovIdType;
  govIdLast4: string;
  relationshipToOccupant?: string;
  hasConsent: boolean;
  consentTimestamp?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Wire shape of one row in `api.ownerships.listByCustomer`'s return
 * payload. Mirrors `convex/ownerships.ts:OwnershipHistoryRow`.
 */
export interface OwnershipHistoryRowData {
  ownershipId: string;
  lotId: string;
  lotCode: string;
  effectiveFrom: number;
  effectiveTo?: number;
  transferType: "sale" | "inheritance" | "gift" | "court_order" | "initial";
}
