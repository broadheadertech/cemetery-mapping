"use client";

/**
 * /lots/[lotId]/location — click-to-place a lot on the map (Map cockpit).
 *
 * Loads the lot, then hosts the Leaflet location picker. The picker is
 * dynamically imported with `ssr: false` so Leaflet/WebGL never enters
 * the server bundle. Server-side, `lots:setLotLocation` enforces the
 * admin / office_staff role; the link into this page is role-gated too
 * (defense in depth).
 */

import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { ChevronLeft } from "lucide-react";

import { DEFAULT_CEMETERY_BBOX } from "@/lib/geometry";

const LotLocationPicker = dynamic(
  () => import("@/components/LotLocationPicker").then((m) => m.LotLocationPicker),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        aria-busy="true"
        className="flex w-full items-center justify-center rounded-md border border-surface-border bg-surface-muted text-sm text-text-muted"
        style={{ height: "60vh", minHeight: 360 }}
      >
        Loading map…
      </div>
    ),
  },
);

interface LotDoc {
  _id: string;
  code: string;
  geometry: { centroid: { lat: number; lng: number } } | null;
  geometryStatus: "placeholder" | "surveyed";
}

const getLotRef = makeFunctionReference<
  "query",
  { lotId: string },
  LotDoc | null
>("lots:getLot");

const DEFAULT_CENTER = {
  lat: (DEFAULT_CEMETERY_BBOX.bboxMinLat + DEFAULT_CEMETERY_BBOX.bboxMaxLat) / 2,
  lng: (DEFAULT_CEMETERY_BBOX.bboxMinLng + DEFAULT_CEMETERY_BBOX.bboxMaxLng) / 2,
};

export default function LotLocationPage() {
  const params = useParams<{ lotId: string }>();
  const lotId = params.lotId;
  const lot = useQuery(getLotRef, { lotId });

  if (lot === undefined) {
    return (
      <div
        role="status"
        aria-busy="true"
        className="h-[60vh] animate-pulse rounded-md border border-surface-border bg-surface-muted"
      />
    );
  }

  if (lot === null) {
    return (
      <div className="space-y-4">
        <h1 className="text-3xl font-bold tracking-tight">Lot not found</h1>
        <Link href="/lots" className="text-sm font-medium text-primary underline">
          ← Back to Lots
        </Link>
      </div>
    );
  }

  const initial = lot.geometry?.centroid ?? DEFAULT_CENTER;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link
          href={`/lots/${lotId}`}
          className="inline-flex items-center gap-1 text-sm font-medium text-text-muted hover:text-primary"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Back to lot{" "}
          {lot.code}
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">
          Set location — Lot {lot.code}
        </h1>
      </header>

      <LotLocationPicker
        lotId={lotId}
        lotCode={lot.code}
        initial={initial}
        surveyed={lot.geometryStatus === "surveyed"}
      />
    </div>
  );
}
