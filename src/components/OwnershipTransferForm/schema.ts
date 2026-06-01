/**
 * Zod schema for the OwnershipTransferForm — Story 2.7.
 *
 * Client-side validation that mirrors `convex/ownerships.ts →
 * recordOwnershipTransfer`'s server validator. Server is authoritative;
 * this schema provides immediate inline feedback before submit.
 *
 * Field caps mirror the constants exported from `convex/ownerships.ts`.
 * Keep them in sync by convention; both layers throw VALIDATION /
 * INVARIANT_VIOLATION when bounds are exceeded.
 *
 * Backdated transfers (effective > 24h before now): the audit log
 * needs a longer reason. The Zod schema enforces this via a
 * `superRefine` against the parsed `transferDate`.
 *
 * Why the constants are duplicated rather than imported from
 * `convex/ownerships.ts`: the client bundle must not reach into the
 * Convex source tree directly. The mirroring pattern is the same as
 * `src/lib/errors.ts` (which mirrors `convex/lib/errors.ts`'s
 * `ErrorCode` enum). If either side updates, the other follows.
 */

import { z } from "zod";

export const TRANSFER_REASON_MIN_LENGTH = 3;
export const TRANSFER_REASON_MAX_LENGTH = 500;
export const BACKDATED_REASON_MIN_LENGTH = 10;

const HOUR_MS = 60 * 60 * 1000;
export const BACKDATED_THRESHOLD_MS = 24 * HOUR_MS;

export const TRANSFER_TYPES = [
  "sale",
  "inheritance",
  "gift",
  "court_order",
] as const;
export type TransferType = (typeof TRANSFER_TYPES)[number];

export const transferTypeLabels: Record<TransferType, string> = {
  sale: "Sale",
  inheritance: "Inheritance",
  gift: "Gift",
  court_order: "Court order",
};

export const ownershipTransferSchema = z
  .object({
    toCustomerId: z
      .string()
      .min(1, "Destination customer is required."),
    transferType: z.enum(TRANSFER_TYPES),
    /**
     * ISO-style `YYYY-MM-DD` from the native date picker. Required —
     * an empty string fails the `superRefine` below.
     */
    transferDate: z.string().min(1, "Transfer date is required."),
    transferReason: z
      .string()
      .trim()
      .min(
        TRANSFER_REASON_MIN_LENGTH,
        `Transfer reason is required (min ${TRANSFER_REASON_MIN_LENGTH} characters).`,
      )
      .max(
        TRANSFER_REASON_MAX_LENGTH,
        `Transfer reason must be ${TRANSFER_REASON_MAX_LENGTH} characters or fewer.`,
      ),
  })
  .superRefine((values, ctx) => {
    const parsed = Date.parse(values.transferDate);
    if (!Number.isFinite(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transferDate"],
        message: "Transfer date is not a valid date.",
      });
      return;
    }
    // Backdated check: anything earlier than now - 24h needs a longer
    // reason. The 24h slack absorbs operator-typed "today" dates that
    // resolve to UTC midnight earlier than the local now.
    const isBackdated = parsed < Date.now() - BACKDATED_THRESHOLD_MS;
    if (
      isBackdated &&
      values.transferReason.trim().length < BACKDATED_REASON_MIN_LENGTH
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transferReason"],
        message: `Backdated transfers require a reason of at least ${BACKDATED_REASON_MIN_LENGTH} characters.`,
      });
    }
  });

export type OwnershipTransferFormValues = z.infer<
  typeof ownershipTransferSchema
>;
