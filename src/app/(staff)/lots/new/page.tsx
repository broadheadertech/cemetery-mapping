"use client";

/**
 * /lots/new — create a new lot (Story 1.8).
 *
 * Thin wrapper around `<LotForm mode="create" />`. Owns the Convex
 * `createLot` mutation call and the redirect to the new lot's detail
 * page on success.
 */

import { useRouter } from "next/navigation";
import { makeFunctionReference } from "convex/server";

import { LotForm, type LotFormSubmitPayload } from "@/components/LotForm";
import { useNetworkAwareMutation } from "@/hooks/useNetworkAwareMutation";

const createLotRef = makeFunctionReference<
  "mutation",
  {
    code: string;
    section: string;
    sectionId?: string;
    block: string;
    row: string;
    type: "single" | "family" | "mausoleum" | "niche";
    dimensions: { widthM: number; depthM: number };
    basePriceCents: number;
  },
  string
>("lots:createLot");

export default function NewLotPage() {
  const router = useRouter();
  // Story 1.13: wrap with the network-aware mutation so creating a lot
  // while offline throws OFFLINE_WRITE_BLOCKED instead of dispatching a
  // doomed request that would silently lose the new lot when the page
  // reloads. The wrapper is API-compatible with `useMutation`.
  const createLot = useNetworkAwareMutation(createLotRef);

  const handleSubmit = async (payload: LotFormSubmitPayload): Promise<void> => {
    const lotId = await createLot(payload);
    router.push(`/lots/${lotId}`);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="font-display text-4xl font-semibold tracking-tight">New Lot</h1>
      <p className="text-sm text-slate-600">
        Add a new lot to the inventory. Geometry is set to the cemetery
        centroid for now; survey data hydrates in Story 1.9.
      </p>
      <LotForm
        mode="create"
        onSubmit={handleSubmit}
        onCancel={() => router.push("/lots")}
      />
    </div>
  );
}
