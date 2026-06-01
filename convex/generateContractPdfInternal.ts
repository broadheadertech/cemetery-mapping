/**
 * V8-runtime internal helpers for the contract-PDF action (Story 6.1).
 *
 * WHY THIS FILE EXISTS (Convex runtime split): the PDF render itself runs
 * in the Node.js runtime (`convex/actions/generateContractPdf.ts` carries
 * `"use node"` for PDFKit). Convex forbids defining queries or mutations
 * in a `"use node"` module — Node files may export ONLY actions. So the
 * internal query (read the contract) + internal mutations (write the blob
 * pointer / failure / retry bookkeeping) live HERE, in the default V8
 * runtime, and the action calls them via `makeFunctionReference` against
 * the `generateContractPdfInternal:*` paths.
 *
 * The `ContractRenderPayload` shape is exported from this module (it's the
 * return type of `_getContractForPdfRender`); the Node action imports it
 * with a type-only `import type`, which is erased at bundle time so the
 * Node bundle never pulls these V8 function definitions in.
 */

import {
  type DataModelFromSchemaDefinition,
  internalMutationGeneric,
  internalQueryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { type MutationCtx, type QueryCtx } from "./lib/auth";
import { ErrorCode, throwError } from "./lib/errors";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ContractId = DataModel["contracts"]["document"]["_id"];
type StorageId = DataModel["customerDocuments"]["document"]["storageId"];

/**
 * Shape consumed by the PDFKit renderer. `_getContractForPdfRender`
 * flattens contract + customer + lot + installments into this object so
 * the action body never makes round-trips back into Convex while the PDF
 * is mid-render.
 */
export interface ContractRenderPayload {
  contractNumber: string;
  contractKind: "full_payment" | "installment";
  totalPriceCents: number;
  state: string;
  createdAt: number;
  contractCreationTime: number;
  downPaymentCents?: number;
  termMonths?: number;
  monthlyAmountCents?: number;
  firstDueDate?: number;
  customerFullName: string;
  customerGovIdLast4: string;
  customerGovIdType: string;
  customerAddressLines: string[];
  customerPhone?: string;
  customerEmail?: string;
  lotCode: string;
  lotSection: string;
  lotBlock: string;
  lotRow: string;
  lotType: "single" | "family" | "mausoleum" | "niche";
  lotWidthM: number;
  lotDepthM: number;
  installments: Array<{
    installmentNumber: number;
    dueDate: number;
    principalCents: number;
    paidCents: number;
    status: "pending" | "paid" | "overdue" | "waived";
  }>;
}

/**
 * Internal query — fetches contract + customer + lot + installments in a
 * single round-trip so the action has all data before the PDFKit render.
 * Bypasses `requireRole` (the originating mutation already gated on
 * `["admin", "office_staff"]`); surfaces full PII which the action then
 * redacts to last-4 in the rendered document.
 */
export const _getContractForPdfRender = internalQueryGeneric({
  args: { contractId: v.id("contracts") },
  handler: async (
    ctx: QueryCtx,
    args: { contractId: ContractId },
  ): Promise<ContractRenderPayload> => {
    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }
    // pii-read-ok: contract PDF render must include customer name + address (BIR-compliant document); audit is emitted by the parent mutation that scheduled this action
    const customer = await ctx.db.get(contract.customerId);
    if (customer === null) {
      throwError(ErrorCode.NOT_FOUND, "Customer not found.", {
        customerId: contract.customerId,
      });
    }
    const lot = await ctx.db.get(contract.lotId);
    if (lot === null) {
      throwError(ErrorCode.NOT_FOUND, "Lot not found.", {
        lotId: contract.lotId,
      });
    }

    let installments: ContractRenderPayload["installments"] = [];
    if (contract.kind === "installment") {
      const rows = await ctx.db
        .query("installments")
        .withIndex("by_contract", (q) => q.eq("contractId", args.contractId))
        .collect();
      installments = [...rows]
        .sort((a, b) => a.installmentNumber - b.installmentNumber)
        .map((r) => ({
          installmentNumber: r.installmentNumber,
          dueDate: r.dueDate,
          principalCents: r.principalCents,
          paidCents: r.paidCents,
          status: r.status,
        }));
    }

    const govIdDigits = customer.govIdNumber.replace(/[^A-Za-z0-9]/g, "");
    const govIdLast4 =
      govIdDigits.length >= 4 ? govIdDigits.slice(-4) : govIdDigits;

    const addressParts = [
      customer.address.line1,
      customer.address.barangay,
      customer.address.cityMunicipality,
      customer.address.province,
      customer.address.postalCode,
    ].filter((p): p is string => typeof p === "string" && p.length > 0);
    const customerAddressLines =
      addressParts.length > 0 ? addressParts : ["(address not on file)"];

    const payload: ContractRenderPayload = {
      contractNumber: contract.contractNumber,
      contractKind: contract.kind,
      totalPriceCents: contract.totalPriceCents,
      state: contract.state,
      createdAt: contract.createdAt,
      contractCreationTime: contract._creationTime,
      customerFullName: customer.fullName,
      customerGovIdLast4: govIdLast4,
      customerGovIdType: customer.govIdType,
      customerAddressLines,
      lotCode: lot.code,
      lotSection: lot.section,
      lotBlock: lot.block,
      lotRow: lot.row,
      lotType: lot.type,
      lotWidthM: lot.dimensions.widthM,
      lotDepthM: lot.dimensions.depthM,
      installments,
    };
    if (contract.downPaymentCents !== undefined) {
      payload.downPaymentCents = contract.downPaymentCents;
    }
    if (contract.termMonths !== undefined) {
      payload.termMonths = contract.termMonths;
    }
    if (contract.monthlyAmountCents !== undefined) {
      payload.monthlyAmountCents = contract.monthlyAmountCents;
    }
    if (contract.firstDueDate !== undefined) {
      payload.firstDueDate = contract.firstDueDate;
    }
    if (customer.phone !== undefined) payload.customerPhone = customer.phone;
    if (customer.email !== undefined) payload.customerEmail = customer.email;
    return payload;
  },
});

/**
 * Internal mutation — records the freshly-stored blob id on the contract
 * row after the action renders + stores the PDF successfully. Flips
 * `pdfStatus: "ready"` + clears any prior error.
 */
export const _recordContractPdfReady = internalMutationGeneric({
  args: {
    contractId: v.id("contracts"),
    storageId: v.id("_storage"),
    generatedAt: v.number(),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      contractId: ContractId;
      storageId: StorageId;
      generatedAt: number;
    },
  ): Promise<void> => {
    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }
    await ctx.db.patch(args.contractId, {
      pdfStorageId: args.storageId,
      pdfGeneratedAt: args.generatedAt,
      pdfStatus: "ready",
      pdfLastError: undefined,
    });
  },
});

/**
 * Internal mutation — records that PDF generation FAILED so the contract
 * row doesn't stay stuck on "pending"; the retry-sweep cron filters on
 * `"failed"`.
 */
export const _recordContractPdfFailed = internalMutationGeneric({
  args: {
    contractId: v.id("contracts"),
    errorMessage: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    args: { contractId: ContractId; errorMessage: string },
  ): Promise<void> => {
    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      return;
    }
    const truncated =
      args.errorMessage.length > 500
        ? args.errorMessage.slice(0, 500)
        : args.errorMessage;
    await ctx.db.patch(args.contractId, {
      pdfStatus: "failed",
      pdfLastError: truncated,
    });
  },
});

/**
 * Internal mutation — bumps the PDF retry count (called by the retry-sweep
 * cron before rescheduling). Returns the post-bump count so the cron can
 * cap-check at 3.
 */
export const _bumpContractPdfRetryCount = internalMutationGeneric({
  args: { contractId: v.id("contracts") },
  handler: async (
    ctx: MutationCtx,
    args: { contractId: ContractId },
  ): Promise<{ retryCount: number }> => {
    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      return { retryCount: 0 };
    }
    const next = (contract.pdfRetryCount ?? 0) + 1;
    await ctx.db.patch(args.contractId, {
      pdfRetryCount: next,
      pdfStatus: "pending",
    });
    return { retryCount: next };
  },
});
