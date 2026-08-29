/**
 * Certificates of ownership.
 *
 * The park uploads its own blank — letterhead, seal, signature blocks,
 * and whatever wording its lawyer approved — says where each detail
 * goes, and the system fills it in for every fully-paid contract. It
 * can also take a finished document straight from the office, for a
 * reissue or a hand-signed original a family wants scanned in.
 *
 * Read `convex/lib/certificate.ts` first; the placement arithmetic and
 * the eligibility rule live there and are tested there. This module is
 * the storage, the gate, and the history.
 *
 * Two rules run through everything below:
 *
 *   - Only a fully-paid contract may carry one. A certificate says the
 *     family owns the lot outright; issuing it against an open balance
 *     puts a document in their hands that contradicts the ledger, and
 *     it is the document that gets framed and produced years later.
 *
 *   - Nothing is ever overwritten. A replacement supersedes; both rows
 *     stay. Somebody out there is holding a printed copy of the old one,
 *     and "what did we give them in March" has to stay answerable.
 */

import {
  type DataModelFromSchemaDefinition,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import { emitAudit } from "./lib/audit";
import { ErrorCode, throwError } from "./lib/errors";
import {
  certificateSerial,
  checkCertificateEligibility,
  FIELD_KEYS,
  isFieldKey,
  type Align,
} from "./lib/certificate";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type TemplateId = DataModel["certificateTemplates"]["document"]["_id"];
type CertificateId = DataModel["certificates"]["document"]["_id"];
type ContractId = DataModel["contracts"]["document"]["_id"];
type StorageId = DataModel["certificates"]["document"]["storageId"];

/** What the park may upload as a blank, or as a finished certificate. */
const ACCEPTED_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
]);

const NAME_MIN = 2;
const NAME_MAX = 80;
const NOTE_MAX = 400;

const alignValidator = v.union(
  v.literal("left"),
  v.literal("center"),
  v.literal("right"),
);

const fieldValidator = v.object({
  key: v.string(),
  xFrac: v.number(),
  yFrac: v.number(),
  fontSize: v.number(),
  align: alignValidator,
  maxWidthFrac: v.optional(v.number()),
});

interface FieldArg {
  key: string;
  xFrac: number;
  yFrac: number;
  fontSize: number;
  align: Align;
  maxWidthFrac?: number;
}

// --- uploading ---------------------------------------------------------

/**
 * A one-time URL to POST a file to.
 *
 * A mutation, not an action, because `ctx.storage.generateUploadUrl()`
 * lives on `MutationCtx` — the same two-step pattern the customer
 * documents and condition-log photos use.
 *
 * Admin-only, and deliberately so even though the blank is not
 * sensitive: this is the file that becomes every certificate the park
 * issues, and replacing it is a decision, not a task.
 */
export const generateTemplateUploadUrl = mutationGeneric({
  args: {},
  handler: async (ctx: MutationCtx): Promise<string> => {
    await requireRole(ctx, ["admin"]);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * A one-time URL for a finished certificate the office wants to attach.
 *
 * Office staff may do this. Unlike the blank, this is ordinary desk
 * work — a family brings back a signed original, a reissue is prepared
 * by hand — and blocking it behind an admin would mean the certificate
 * simply never gets attached.
 */
export const generateCertificateUploadUrl = mutationGeneric({
  args: {},
  handler: async (ctx: MutationCtx): Promise<string> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    return await ctx.storage.generateUploadUrl();
  },
});

// --- the template ------------------------------------------------------

export interface TemplateRow {
  _id: TemplateId;
  name: string;
  storageId: StorageId;
  mimeType: string;
  fileName?: string;
  pageWidthPt: number;
  pageHeightPt: number;
  fields: FieldArg[];
  isActive: boolean;
  createdAt: number;
  /** A short-lived URL for previewing the blank while placing fields. */
  previewUrl: string | null;
}

/**
 * The blank in use, with a URL to render it behind the placement grid.
 *
 * Office staff may read it — the contract page shows which template a
 * certificate came from — but only an admin may change it.
 */
export const getActiveTemplate = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<TemplateRow | null> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const row = await ctx.db
      .query("certificateTemplates")
      .withIndex("by_isActive", (q) => q.eq("isActive", true))
      .first();
    if (row === null) return null;
    return {
      _id: row._id,
      name: row.name,
      storageId: row.storageId,
      mimeType: row.mimeType,
      ...(row.fileName !== undefined ? { fileName: row.fileName } : {}),
      pageWidthPt: row.pageWidthPt,
      pageHeightPt: row.pageHeightPt,
      fields: row.fields as FieldArg[],
      isActive: row.isActive,
      createdAt: row.createdAt,
      previewUrl: await ctx.storage.getUrl(row.storageId),
    };
  },
});

/**
 * Install a new blank, retiring whatever was in use.
 *
 * The previous template is deactivated rather than deleted: a
 * certificate issued last year was issued against last year's blank,
 * and the record should be able to say so.
 *
 * Field placements are NOT carried over. A new blank has its own
 * layout, and silently reusing the old coordinates would put the
 * owner's name wherever the previous design happened to have it —
 * which prints, and prints wrong.
 */
export const setCertificateTemplate = mutationGeneric({
  args: {
    name: v.string(),
    storageId: v.id("_storage"),
    mimeType: v.string(),
    fileName: v.optional(v.string()),
    pageWidthPt: v.number(),
    pageHeightPt: v.number(),
    fields: v.optional(v.array(fieldValidator)),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      name: string;
      storageId: StorageId;
      mimeType: string;
      fileName?: string;
      pageWidthPt: number;
      pageHeightPt: number;
      fields?: FieldArg[];
    },
  ): Promise<{ templateId: TemplateId }> => {
    const auth = await requireRole(ctx, ["admin"]);

    const name = args.name.trim();
    if (name.length < NAME_MIN || name.length > NAME_MAX) {
      throwError(
        ErrorCode.VALIDATION,
        `Name must be between ${NAME_MIN} and ${NAME_MAX} characters.`,
      );
    }
    if (!ACCEPTED_MIME.has(args.mimeType)) {
      throwError(
        ErrorCode.VALIDATION,
        "The blank must be a PDF, PNG or JPEG.",
        { mimeType: args.mimeType },
      );
    }
    assertPageSize(args.pageWidthPt, args.pageHeightPt);
    const fields = normaliseFields(args.fields ?? []);

    const now = Date.now();
    const previous = await ctx.db
      .query("certificateTemplates")
      .withIndex("by_isActive", (q) => q.eq("isActive", true))
      .collect();
    for (const p of previous) {
      await ctx.db.patch(p._id, {
        isActive: false,
        updatedAt: now,
        updatedByUserId: auth.userId,
      });
    }

    const row: Record<string, unknown> = {
      name,
      storageId: args.storageId,
      mimeType: args.mimeType,
      pageWidthPt: args.pageWidthPt,
      pageHeightPt: args.pageHeightPt,
      fields,
      isActive: true,
      createdAt: now,
      createdByUserId: auth.userId,
      updatedAt: now,
    };
    if (args.fileName !== undefined) row.fileName = args.fileName.trim();

    const templateId = await ctx.db.insert(
      "certificateTemplates",
      row as never,
    );
    await emitAudit(ctx, {
      action: "create",
      entityType: "certificate_template",
      entityId: templateId,
      after: { name, mimeType: args.mimeType, fieldCount: fields.length },
      reason: `Certificate template "${name}" installed`,
    });

    return { templateId };
  },
});

/**
 * Move the fields on the current blank.
 *
 * Separate from installing a template because it is a different act:
 * uploading replaces the park's document, this nudges a name half an
 * inch left. Conflating them would mean re-uploading the file to fix a
 * placement.
 */
export const setTemplateFields = mutationGeneric({
  args: {
    templateId: v.id("certificateTemplates"),
    fields: v.array(fieldValidator),
  },
  handler: async (
    ctx: MutationCtx,
    args: { templateId: TemplateId; fields: FieldArg[] },
  ): Promise<{ templateId: TemplateId }> => {
    const auth = await requireRole(ctx, ["admin"]);

    const existing = await ctx.db.get(args.templateId);
    if (existing === null) {
      throwError(ErrorCode.NOT_FOUND, "Certificate template not found.", {
        templateId: args.templateId,
      });
    }

    const fields = normaliseFields(args.fields);
    await ctx.db.patch(args.templateId, {
      fields,
      updatedAt: Date.now(),
      updatedByUserId: auth.userId,
    } as never);
    await emitAudit(ctx, {
      action: "update",
      entityType: "certificate_template",
      entityId: args.templateId,
      before: { fieldCount: existing.fields.length },
      after: { fieldCount: fields.length },
      reason: `Certificate field placement updated on "${existing.name}"`,
    });

    return { templateId: args.templateId };
  },
});

// --- issuing -----------------------------------------------------------

export interface CertificateRow {
  _id: CertificateId;
  contractId: ContractId;
  serial: string;
  source: "generated" | "uploaded";
  mimeType: string;
  issuedAt: number;
  note?: string;
  isSuperseded: boolean;
  supersededAt?: number;
  supersededReason?: string;
  /** Short-lived download URL. Null when the blob has gone missing. */
  url: string | null;
}

export interface ContractCertificates {
  eligible: boolean;
  /** Why not, when not — a sentence the office can read to a family. */
  reason?: string;
  /** The certificate in force, if one has been issued. */
  current: CertificateRow | null;
  /** Everything superseded, newest first. */
  history: CertificateRow[];
  /** False when no blank has been uploaded, so nothing can be generated. */
  templateReady: boolean;
}

/**
 * What certificate this contract has, and whether it may have one.
 *
 * Returns the eligibility REASON rather than an empty result. "This
 * contract is still being paid" is something the office can say to a
 * family across a desk; a missing button is not.
 */
export const getContractCertificates = queryGeneric({
  args: { contractId: v.id("contracts") },
  handler: async (
    ctx: QueryCtx,
    args: { contractId: ContractId },
  ): Promise<ContractCertificates> => {
    await requireRole(ctx, ["admin", "office_staff"]);

    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }

    const eligibility = checkCertificateEligibility(contract);
    const rows = await ctx.db
      .query("certificates")
      .withIndex("by_contract", (q) => q.eq("contractId", args.contractId))
      .collect();

    const template = await ctx.db
      .query("certificateTemplates")
      .withIndex("by_isActive", (q) => q.eq("isActive", true))
      .first();

    const withUrls: CertificateRow[] = [];
    for (const r of rows) {
      withUrls.push({
        _id: r._id,
        contractId: r.contractId,
        serial: r.serial,
        source: r.source,
        mimeType: r.mimeType,
        issuedAt: r.issuedAt,
        ...(r.note !== undefined ? { note: r.note } : {}),
        isSuperseded: r.isSuperseded,
        ...(r.supersededAt !== undefined
          ? { supersededAt: r.supersededAt }
          : {}),
        ...(r.supersededReason !== undefined
          ? { supersededReason: r.supersededReason }
          : {}),
        url: await ctx.storage.getUrl(r.storageId),
      });
    }
    withUrls.sort((a, b) => b.issuedAt - a.issuedAt);

    const result: ContractCertificates = {
      eligible: eligibility.eligible,
      current: withUrls.find((r) => !r.isSuperseded) ?? null,
      history: withUrls.filter((r) => r.isSuperseded),
      templateReady: template !== null && template.fields.length > 0,
    };
    if (eligibility.reason !== undefined) result.reason = eligibility.reason;
    return result;
  },
});

/**
 * Record a certificate against a contract.
 *
 * The blob is already in storage by the time this runs — generated by
 * the PDF action, or POSTed by the office through
 * `generateCertificateUploadUrl`. This is the row, the serial, and the
 * supersede.
 *
 * `source` is not a formality. A generated certificate can be
 * regenerated from the template; an uploaded one is the only copy the
 * park has, and the two need to be told apart when someone asks where a
 * document came from.
 */
export const recordCertificate = mutationGeneric({
  args: {
    contractId: v.id("contracts"),
    storageId: v.id("_storage"),
    mimeType: v.string(),
    source: v.union(v.literal("generated"), v.literal("uploaded")),
    templateId: v.optional(v.id("certificateTemplates")),
    note: v.optional(v.string()),
    /**
     * The number already printed on a generated document. Omitted for
     * an uploaded one, which takes a fresh number here.
     */
    serial: v.optional(v.string()),
    /** Required when one is already in force, so the trail says why. */
    supersedeReason: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      contractId: ContractId;
      storageId: StorageId;
      mimeType: string;
      source: "generated" | "uploaded";
      templateId?: TemplateId;
      note?: string;
      serial?: string;
      supersedeReason?: string;
    },
  ): Promise<{ certificateId: CertificateId; serial: string }> => {
    const auth = await requireRole(ctx, ["admin", "office_staff"]);

    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }

    // The gate, restated server-side. The page hides the button on an
    // unpaid contract; this is what stops a hand-made request.
    const eligibility = checkCertificateEligibility(contract);
    if (!eligibility.eligible) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        eligibility.reason ??
          "Only a fully-paid contract can carry a certificate of ownership.",
        {
          kind: "CERTIFICATE_NOT_ELIGIBLE",
          contractId: args.contractId,
          contractState: contract.state,
        },
      );
    }

    if (!ACCEPTED_MIME.has(args.mimeType)) {
      throwError(
        ErrorCode.VALIDATION,
        "A certificate must be a PDF, PNG or JPEG.",
        { mimeType: args.mimeType },
      );
    }

    const note = args.note?.trim();
    if (note !== undefined && note.length > NOTE_MAX) {
      throwError(
        ErrorCode.VALIDATION,
        `Note must be ${NOTE_MAX} characters or fewer.`,
      );
    }

    const now = Date.now();

    // Supersede whatever is in force. Never a delete: somebody may be
    // holding a printed copy of the old one.
    const existing = await ctx.db
      .query("certificates")
      .withIndex("by_contract_superseded", (q) =>
        q.eq("contractId", args.contractId).eq("isSuperseded", false),
      )
      .collect();

    if (existing.length > 0) {
      const reason = args.supersedeReason?.trim();
      if (reason === undefined || reason.length < 5) {
        throwError(
          ErrorCode.VALIDATION,
          "This contract already has a certificate. Say why it is being replaced — the reason goes on the record beside the one being withdrawn.",
          { kind: "SUPERSEDE_REASON_REQUIRED" },
        );
      }
      for (const e of existing) {
        await ctx.db.patch(e._id, {
          isSuperseded: true,
          supersededAt: now,
          supersededByUserId: auth.userId,
          supersededReason: reason,
        });
      }
    }

    // The serial was reserved before the PDF was rendered, because it
    // is PRINTED on the document. A generated certificate carries the
    // one it was drawn with; an uploaded one has nothing printed on it
    // by us, so it takes a fresh number here.
    const serial =
      args.serial !== undefined && args.serial.length > 0
        ? args.serial
        : certificateSerial(now, await reserveSequence(ctx));

    const row: Record<string, unknown> = {
      contractId: args.contractId,
      customerId: contract.customerId,
      lotId: contract.lotId,
      serial,
      source: args.source,
      storageId: args.storageId,
      mimeType: args.mimeType,
      issuedAt: now,
      issuedByUserId: auth.userId,
      isSuperseded: false,
    };
    if (args.templateId !== undefined) row.templateId = args.templateId;
    if (note !== undefined && note.length > 0) row.note = note;

    const certificateId = await ctx.db.insert("certificates", row as never);

    await emitAudit(ctx, {
      action: "create",
      entityType: "contract",
      entityId: args.contractId as unknown as string,
      after: { certificateId, serial, source: args.source },
      reason:
        existing.length > 0
          ? `Certificate ${serial} issued, replacing the previous one: ${args.supersedeReason?.trim()}`
          : `Certificate of ownership ${serial} issued`,
    });

    return { certificateId, serial };
  },
});

/**
 * Everything the renderer needs, gathered in one read.
 *
 * The action that issues a certificate cannot touch the database, so
 * this is where the contract, the customer, the lot and the active
 * template come together — and where the fully-paid rule is checked
 * before a serial is consumed on a document that would be refused.
 */
export interface IssueContext {
  ownerName: string;
  lotCode: string;
  section: string;
  lotType: string;
  contractNumber: string;
  amountPaidCents: number;
  templateId: TemplateId;
  templateStorageId: StorageId;
  templateMimeType: string;
  fields: FieldArg[];
}

export const getIssueContext = queryGeneric({
  args: { contractId: v.id("contracts") },
  handler: async (
    ctx: QueryCtx,
    args: { contractId: ContractId },
  ): Promise<IssueContext> => {
    await requireRole(ctx, ["admin", "office_staff"]);

    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }
    const eligibility = checkCertificateEligibility(contract);
    if (!eligibility.eligible) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        eligibility.reason ??
          "Only a fully-paid contract can carry a certificate of ownership.",
        { kind: "CERTIFICATE_NOT_ELIGIBLE", contractId: args.contractId },
      );
    }

    const template = await ctx.db
      .query("certificateTemplates")
      .withIndex("by_isActive", (q) => q.eq("isActive", true))
      .first();
    if (template === null) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "No certificate blank has been uploaded. An administrator can add the park's design under Certificate of ownership — or attach a finished certificate to this contract by hand.",
        { kind: "NO_CERTIFICATE_TEMPLATE" },
      );
    }
    if (template.fields.length === 0) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "The certificate blank has no details placed on it yet, so it would print blank. Set the placements under Certificate of ownership.",
        { kind: "CERTIFICATE_TEMPLATE_EMPTY" },
      );
    }

    const customer = await ctx.db.get(contract.customerId);
    const lot = await ctx.db.get(contract.lotId);

    return {
      ownerName: customer?.fullName ?? "",
      lotCode: lot?.code ?? "",
      section: lot?.section ?? "",
      lotType: lot?.type ?? "",
      contractNumber: contract.contractNumber,
      amountPaidCents: contract.totalPriceCents,
      templateId: template._id,
      templateStorageId: template.storageId,
      templateMimeType: template.mimeType,
      fields: template.fields as FieldArg[],
    };
  },
});

// --- the work list -----------------------------------------------------

export interface AwaitingCertificate {
  contractId: ContractId;
  contractNumber: string;
  customerName: string;
  lotCode: string;
  totalPriceCents: number;
}

/**
 * Fully paid, and nobody has issued the certificate yet.
 *
 * The other half of "alert the client when they are fully paid": the
 * office needs a list of families owed a document, or the alert is a
 * notification nobody acts on. Ordered oldest first — the family who
 * settled in March has been waiting longest.
 */
export const listAwaitingCertificate = queryGeneric({
  args: { limit: v.optional(v.number()) },
  handler: async (
    ctx: QueryCtx,
    args: { limit?: number },
  ): Promise<AwaitingCertificate[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);

    const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
    const paid = await ctx.db
      .query("contracts")
      .withIndex("by_state", (q) => q.eq("state", "paid_in_full"))
      .collect();

    const out: AwaitingCertificate[] = [];
    for (const c of paid) {
      const held = await ctx.db
        .query("certificates")
        .withIndex("by_contract_superseded", (q) =>
          q.eq("contractId", c._id).eq("isSuperseded", false),
        )
        .first();
      if (held !== null) continue;

      const customer = await ctx.db.get(c.customerId);
      const lot = await ctx.db.get(c.lotId);
      out.push({
        contractId: c._id,
        contractNumber: c.contractNumber,
        customerName: customer?.fullName ?? "Unknown",
        lotCode: lot?.code ?? "—",
        totalPriceCents: c.totalPriceCents,
      });
      if (out.length >= limit) break;
    }

    out.sort((a, b) => a.contractNumber.localeCompare(b.contractNumber));
    return out;
  },
});

// --- helpers -----------------------------------------------------------

/**
 * Take the next number in the certificate sequence.
 *
 * Read-modify-write on a single counter row, inside a mutation, so two
 * families issuing at the same moment cannot be handed the same number.
 * Counting existing rows instead would look correct and produce
 * duplicates under exactly the concurrency it is meant to survive.
 *
 * A gap — a reservation whose render then failed — is acceptable and
 * deliberate. This is not the BIR receipt sequence, where a gap is a
 * finding; see the note on `certificateCounter` in the schema.
 */
async function reserveSequence(ctx: MutationCtx): Promise<number> {
  const row = await ctx.db
    .query("certificateCounter")
    .withIndex("by_key", (q) => q.eq("key", "singleton"))
    .first();
  if (row === null) {
    await ctx.db.insert("certificateCounter", {
      key: "singleton",
      lastSerial: 1,
    });
    return 1;
  }
  const next = row.lastSerial + 1;
  await ctx.db.patch(row._id, { lastSerial: next });
  return next;
}

/**
 * Take a number for a document about to be rendered.
 *
 * Separate from `recordCertificate` because the serial is PRINTED on
 * the certificate: it has to exist before the PDF does. The row is
 * written afterwards, carrying the number it was drawn with.
 */
export const reserveCertificateSerial = mutationGeneric({
  args: { contractId: v.id("contracts") },
  handler: async (
    ctx: MutationCtx,
    args: { contractId: ContractId },
  ): Promise<{ serial: string }> => {
    await requireRole(ctx, ["admin", "office_staff"]);

    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }
    // Checked here as well as at record time, so a number is not
    // consumed for a contract that was never going to be allowed one.
    const eligibility = checkCertificateEligibility(contract);
    if (!eligibility.eligible) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        eligibility.reason ??
          "Only a fully-paid contract can carry a certificate of ownership.",
        { kind: "CERTIFICATE_NOT_ELIGIBLE", contractId: args.contractId },
      );
    }

    return { serial: certificateSerial(Date.now(), await reserveSequence(ctx)) };
  },
});

function assertPageSize(widthPt: number, heightPt: number): void {
  const ok = (n: number): boolean =>
    Number.isFinite(n) && n > 50 && n < 5000;
  if (!ok(widthPt) || !ok(heightPt)) {
    throwError(
      ErrorCode.VALIDATION,
      "The blank's page size could not be read. Re-export it and try again.",
      { pageWidthPt: widthPt, pageHeightPt: heightPt },
    );
  }
}

/**
 * Clean a set of placements before storing them.
 *
 * Unknown keys are refused rather than dropped. Dropping is right at
 * RENDER time — a stale field should vanish from a printed document
 * rather than appear as `{ownerAddress}` — but at WRITE time it would
 * mean the admin drags a field on, saves, and finds it silently gone.
 */
function normaliseFields(fields: FieldArg[]): FieldArg[] {
  const seen = new Set<string>();
  const out: FieldArg[] = [];
  for (const f of fields) {
    if (!isFieldKey(f.key)) {
      throwError(
        ErrorCode.VALIDATION,
        `"${f.key}" is not a field this certificate can carry. Choose one of: ${FIELD_KEYS.join(", ")}.`,
        { key: f.key },
      );
    }
    if (seen.has(f.key)) {
      throwError(
        ErrorCode.VALIDATION,
        `"${f.key}" is placed twice. Each detail goes in one place.`,
        { key: f.key },
      );
    }
    seen.add(f.key);

    const entry: FieldArg = {
      key: f.key,
      xFrac: clamp01(f.xFrac),
      yFrac: clamp01(f.yFrac),
      fontSize: Math.min(96, Math.max(6, Math.round(f.fontSize))),
      align: f.align,
    };
    if (f.maxWidthFrac !== undefined) {
      entry.maxWidthFrac = clamp01(f.maxWidthFrac);
    }
    out.push(entry);
  }
  return out;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
