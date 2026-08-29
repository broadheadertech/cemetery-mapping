"use node";

/**
 * Issue a certificate: gather, reserve, render, record.
 *
 * Four steps in that order, and the order is the whole design. The
 * serial is PRINTED on the document, so it has to be reserved before
 * the PDF exists — and the row that says "this certificate was issued"
 * has to be written after, carrying the number that was actually drawn.
 * Any other ordering either prints a number nobody recorded or records
 * one nobody printed.
 *
 * Actions cannot read the database or the caller's identity directly,
 * so both the gather and the write go through mutations and queries
 * that re-check the role and the fully-paid rule themselves. This file
 * is orchestration; it is not where anything is enforced.
 */

import {
  type DataModelFromSchemaDefinition,
  type GenericActionCtx,
  actionGeneric,
  makeFunctionReference,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import type { CertificateData, FieldPlacement } from "./lib/certificate";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ActionCtx = GenericActionCtx<DataModel>;

interface IssueContext {
  ownerName: string;
  lotCode: string;
  section: string;
  lotType: string;
  contractNumber: string;
  amountPaidCents: number;
  templateId: string;
  templateStorageId: string;
  templateMimeType: string;
  fields: FieldPlacement[];
}

const getIssueContextRef = makeFunctionReference<
  "query",
  { contractId: string },
  IssueContext
>("certificates:getIssueContext");

const reserveSerialRef = makeFunctionReference<
  "mutation",
  { contractId: string },
  { serial: string }
>("certificates:reserveCertificateSerial");

const renderRef = makeFunctionReference<
  "action",
  {
    contractId: string;
    templateId: string;
    templateStorageId: string;
    templateMimeType: string;
    data: CertificateData;
    fields: FieldPlacement[];
    supersedeReason?: string;
  },
  { certificateId: string; serial: string; overflowed: string[] }
>("actions/generateCertificatePdf:generateCertificatePdf");

export const issueCertificate = actionGeneric({
  args: {
    contractId: v.string(),
    supersedeReason: v.optional(v.string()),
  },
  handler: async (
    ctx: ActionCtx,
    args: { contractId: string; supersedeReason?: string },
  ): Promise<{
    certificateId: string;
    serial: string;
    overflowed: string[];
  }> => {
    // 1. What goes on it. The query enforces the role and refuses a
    //    contract that is not fully paid.
    // eslint-disable-next-line local-rules/require-role-first-line -- Actions cannot read user auth from ctx.db. The FIRST thing this does is `getIssueContext`, a query that role-gates on ["admin","office_staff"] and refuses a contract that is not fully paid; `reserveCertificateSerial` and `recordCertificate` each re-check the same two rules. There is no path through this action that skips a gate.
    const context = await ctx.runQuery(getIssueContextRef, {
      contractId: args.contractId,
    });

    // 2. Take the number, before anything is drawn.
    const { serial } = await ctx.runMutation(reserveSerialRef, {
      contractId: args.contractId,
    });

    // 3. Draw it, and 4. record it — the render action writes the row
    //    itself, carrying the serial it printed.
    return await ctx.runAction(renderRef, {
      contractId: args.contractId,
      templateId: context.templateId,
      templateStorageId: context.templateStorageId,
      templateMimeType: context.templateMimeType,
      fields: context.fields,
      data: {
        ownerName: context.ownerName,
        lotCode: context.lotCode,
        section: context.section,
        lotType: context.lotType,
        contractNumber: context.contractNumber,
        serial,
        issuedAt: Date.now(),
        amountPaidCents: context.amountPaidCents,
      },
      ...(args.supersedeReason !== undefined
        ? { supersedeReason: args.supersedeReason }
        : {}),
    });
  },
});
