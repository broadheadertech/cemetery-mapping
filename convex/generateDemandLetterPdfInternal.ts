/**
 * V8-runtime internal helpers for the demand-letter-PDF action (Story 6.2).
 *
 * Same runtime-split rationale as `generateContractPdfInternal.ts`: the
 * PDFKit render runs in Node (`actions/generateDemandLetterPdf.ts` carries
 * `"use node"`), but Convex forbids defining queries/mutations in a
 * `"use node"` module — so the internal query (read overdue installments)
 * + the blob/failure/retry mutations live HERE in the default V8 runtime.
 * The Node action imports `DemandLetterRenderPayload` with a type-only
 * `import type`, erased at bundle time so the Node bundle never pulls these
 * V8 definitions in.
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
 * Shape consumed by the PDFKit renderer. `_getContractForDemandLetterRender`
 * flattens contract + customer + lot + overdue-installments into this
 * object so the action body never round-trips back into Convex mid-render.
 */
export interface DemandLetterRenderPayload {
  contractNumber: string;
  contractCreatedAt: number;
  contractCreationTime: number;
  customerFullName: string;
  customerGovIdLast4: string;
  customerGovIdType: string;
  customerAddressLines: string[];
  lotCode: string;
  lotSection: string;
  lotBlock: string;
  lotRow: string;
  overdueInstallments: Array<{
    installmentNumber: number;
    dueDate: number;
    principalCents: number;
    paidCents: number;
  }>;
  totalOverdueCents: number;
  oldestMissedDate: number;
  generatedAt: number;
  consultantName?: string;
}

/**
 * Internal query — fetches contract + customer + lot + overdue
 * installments in a single round-trip. Bypasses `requireRole` (the
 * originating mutation already gated on `["admin","office_staff"]` and
 * verified the contract is overdue); surfaces full PII which the action
 * redacts to last-4 in the rendered document.
 */
export const _getContractForDemandLetterRender = internalQueryGeneric({
  args: { contractId: v.id("contracts"), generatedAt: v.number() },
  handler: async (
    ctx: QueryCtx,
    args: { contractId: ContractId; generatedAt: number },
  ): Promise<DemandLetterRenderPayload> => {
    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }
    // pii-read-ok: demand letter PDF render must include customer name + address (Estate Office correspondence); audit is emitted by the parent mutation that scheduled this action
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

    // Filter to OVERDUE installments only (matches the AR-aging classifier
    // in `convex/arAging.ts`): unpaid/unwaived, due date strictly before
    // the generation timestamp, positive outstanding balance.
    const allInstallments = await ctx.db
      .query("installments")
      .withIndex("by_contract", (q) => q.eq("contractId", args.contractId))
      .collect();
    const overdue = [...allInstallments]
      .filter(
        (row) =>
          row.status !== "paid" &&
          row.status !== "waived" &&
          row.dueDate < args.generatedAt &&
          row.principalCents - row.paidCents > 0,
      )
      .sort((a, b) => a.dueDate - b.dueDate);

    let totalOverdueCents = 0;
    for (const row of overdue) {
      totalOverdueCents += row.principalCents - row.paidCents;
    }
    if (overdue.length === 0) {
      throwError(
        ErrorCode.NOT_FOUND,
        "No overdue installments found for contract; demand letter not generated.",
        { contractId: args.contractId },
      );
    }
    const oldestMissedDate = overdue[0]!.dueDate;

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

    return {
      contractNumber: contract.contractNumber,
      contractCreatedAt: contract.createdAt,
      contractCreationTime: contract._creationTime,
      customerFullName: customer.fullName,
      customerGovIdLast4: govIdLast4,
      customerGovIdType: customer.govIdType,
      customerAddressLines,
      lotCode: lot.code,
      lotSection: lot.section,
      lotBlock: lot.block,
      lotRow: lot.row,
      overdueInstallments: overdue.map((row) => ({
        installmentNumber: row.installmentNumber,
        dueDate: row.dueDate,
        principalCents: row.principalCents,
        paidCents: row.paidCents,
      })),
      totalOverdueCents,
      oldestMissedDate,
      generatedAt: args.generatedAt,
    };
  },
});

/**
 * Internal mutation — records the freshly-stored blob id on the contract
 * row after the action renders + stores the demand-letter PDF. Flips
 * `demandLetterStatus: "ready"` + clears any prior error.
 */
export const _recordDemandLetterPdfReady = internalMutationGeneric({
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
      demandLetterStorageId: args.storageId,
      demandLetterGeneratedAt: args.generatedAt,
      demandLetterStatus: "ready",
      demandLetterLastError: undefined,
    });
  },
});

/**
 * Internal mutation — records that demand-letter generation FAILED so the
 * row doesn't stay stuck on "pending"; the retry-sweep cron filters on
 * `"failed"`.
 */
export const _recordDemandLetterPdfFailed = internalMutationGeneric({
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
      demandLetterStatus: "failed",
      demandLetterLastError: truncated,
    });
  },
});

/**
 * Internal mutation — bumps the demand-letter retry count (called by the
 * retry-sweep cron before rescheduling).
 */
export const _bumpDemandLetterRetryCount = internalMutationGeneric({
  args: { contractId: v.id("contracts") },
  handler: async (
    ctx: MutationCtx,
    args: { contractId: ContractId },
  ): Promise<{ retryCount: number }> => {
    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      return { retryCount: 0 };
    }
    const next = (contract.demandLetterRetryCount ?? 0) + 1;
    await ctx.db.patch(args.contractId, {
      demandLetterRetryCount: next,
      demandLetterStatus: "pending",
    });
    return { retryCount: next };
  },
});
