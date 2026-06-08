"use client";

/**
 * /lots/[lotId]/edit — edit an existing lot (Story 1.8).
 *
 * TODO: Story 1.11 supersedes this with the lot detail page's inline
 * edit flow. Until then, this stand-alone edit page covers AC3
 * (Office Staff edits a lot's base price + other mutable fields).
 *
 * Stays on the edit page after submit so the user keeps context;
 * the reactive `useQuery` on `getLot` refreshes the displayed values
 * automatically on the next render tick.
 */

import { useParams, useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { LotForm, type LotFormSubmitPayload } from "@/components/LotForm";
import { useNetworkAwareMutation } from "@/hooks/useNetworkAwareMutation";
import type { LotStatus } from "@/types/lot-status";
import { useState } from "react";

interface LotDoc {
  _id: string;
  code: string;
  section: string;
  sectionId?: string;
  block: string;
  row: string;
  type: "single" | "family" | "mausoleum" | "niche";
  dimensions: { widthM: number; depthM: number };
  basePriceCents: number;
  status: LotStatus;
  isRetired: boolean;
}

const getLotRef = makeFunctionReference<
  "query",
  { lotId: string },
  LotDoc | null
>("lots:getLot");

const updateLotRef = makeFunctionReference<
  "mutation",
  {
    lotId: string;
    fields: {
      section?: string;
      sectionId?: string;
      block?: string;
      row?: string;
      type?: "single" | "family" | "mausoleum" | "niche";
      dimensions?: { widthM: number; depthM: number };
      basePriceCents?: number;
    };
  },
  null
>("lots:updateLot");

export default function EditLotPage() {
  const params = useParams<{ lotId: string }>();
  const router = useRouter();
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const lotId = params.lotId;
  const lot = useQuery(getLotRef, { lotId });
  // Story 1.13: wrap with the network-aware mutation so editing a lot
  // while offline throws OFFLINE_WRITE_BLOCKED instead of dispatching a
  // doomed request that would silently lose the edit. API-compatible
  // with `useMutation`.
  const updateLot = useNetworkAwareMutation(updateLotRef);

  const handleSubmit = async (
    payload: LotFormSubmitPayload,
  ): Promise<void> => {
    // `code` is immutable; drop it from the update payload so the
    // server's reject-on-`code` rule never fires.
    const updateFields: {
      section?: string;
      sectionId?: string;
      block?: string;
      row?: string;
      type?: "single" | "family" | "mausoleum" | "niche";
      dimensions?: { widthM: number; depthM: number };
      basePriceCents?: number;
    } = {
      section: payload.section,
      block: payload.block,
      row: payload.row,
      type: payload.type,
      dimensions: payload.dimensions,
      basePriceCents: payload.basePriceCents,
    };
    if (payload.sectionId !== undefined && payload.sectionId.length > 0) {
      updateFields.sectionId = payload.sectionId;
    }
    await updateLot({
      lotId,
      fields: updateFields,
    });
    setSavedAt(Date.now());
  };

  const heading =
    lot === undefined
      ? "Edit Lot"
      : lot === null
        ? "Lot not found"
        : `Edit Lot ${lot.code}`;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="font-display text-4xl font-semibold tracking-tight">{heading}</h1>
      {lot === undefined && (
        <p className="text-sm text-slate-500">Loading lot…</p>
      )}
      {lot === null && (
        <p className="text-sm text-slate-600">
          That lot does not exist or has been deleted.
        </p>
      )}
      {lot !== undefined && lot !== null && (
        <>
          {savedAt !== null && (
            <div
              role="status"
              className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
            >
              Changes saved.
            </div>
          )}
          <LotForm
            mode="edit"
            defaultValues={{
              code: lot.code,
              section: lot.section,
              sectionId: lot.sectionId,
              block: lot.block,
              row: lot.row,
              type: lot.type,
              dimensions: lot.dimensions,
              basePriceCents: lot.basePriceCents,
            }}
            onSubmit={handleSubmit}
            onCancel={() => router.push("/lots")}
          />
        </>
      )}
    </div>
  );
}
