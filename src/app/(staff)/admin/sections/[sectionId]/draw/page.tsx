"use client";

/**
 * /admin/sections/[sectionId]/draw — lay out a garden by drawing rows.
 *
 * The practical way to map an irregular park with no survey: click
 * where a row starts and ends, and every lot in it lands at real
 * coordinates at the real angle the row runs. Two clicks per row rather
 * than one visit per grave.
 *
 * Admin-only at the route; `lots:placeLotRow` admits office staff too
 * and re-checks server-side.
 */

import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { ChevronLeft } from "lucide-react";

import { DEFAULT_CEMETERY_BBOX } from "@/lib/geometry";

const RowDrawer = dynamic(
  () => import("@/components/RowDrawer").then((m) => m.RowDrawer),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        aria-busy="true"
        className="flex w-full items-center justify-center rounded-md border border-surface-border bg-surface-muted text-sm text-text-muted"
        style={{ height: "60vh", minHeight: 360 }}
      >
        Loading map&hellip;
      </div>
    ),
  },
);

interface SectionRow {
  _id: string;
  name: string;
  displayName: string;
  boundary?: Array<{ lat: number; lng: number }>;
}

const listSectionsRef = makeFunctionReference<
  "query",
  { includeRetired?: boolean },
  SectionRow[]
>("sections:listSections");

const CENTRE = {
  lat: (DEFAULT_CEMETERY_BBOX.bboxMinLat + DEFAULT_CEMETERY_BBOX.bboxMaxLat) / 2,
  lng: (DEFAULT_CEMETERY_BBOX.bboxMinLng + DEFAULT_CEMETERY_BBOX.bboxMaxLng) / 2,
};

export default function SectionDrawPage() {
  const params = useParams<{ sectionId: string }>();
  const sectionId = params.sectionId;
  const sections = useQuery(listSectionsRef, {});

  if (sections === undefined) {
    return (
      <div
        role="status"
        aria-busy="true"
        className="h-[60vh] animate-pulse rounded-md border border-surface-border bg-surface-muted"
      />
    );
  }

  const section = sections.find((s) => s._id === sectionId);
  if (section === undefined) {
    return (
      <div className="space-y-4">
        <h1 className="text-3xl font-bold tracking-tight">Garden not found</h1>
        <Link
          href="/admin/sections"
          className="text-sm font-medium text-primary underline"
        >
          ← Back to Gardens
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link
          href="/admin/sections"
          className="inline-flex items-center gap-1 text-sm font-medium text-text-muted hover:text-primary"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Back to Gardens
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">
          Draw rows — {section.displayName}
        </h1>
      </header>

      <RowDrawer
        sectionName={section.displayName}
        displayName={section.displayName}
        fallbackCentre={section.boundary?.[0] ?? CENTRE}
      />
    </div>
  );
}
