"use client";

/**
 * /admin/sections/[sectionId]/boundary — trace a garden's outline.
 *
 * The map showed lots floating in an empty field. This is where the
 * field gets its edges.
 *
 * Admin-only: middleware gates `/admin`, and both mutations behind the
 * editor re-check the role server-side.
 */

import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { ChevronLeft } from "lucide-react";

import { DEFAULT_CEMETERY_BBOX } from "@/lib/geometry";

const SectionBoundaryEditor = dynamic(
  () =>
    import("@/components/SectionBoundaryEditor").then(
      (m) => m.SectionBoundaryEditor,
    ),
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

export default function SectionBoundaryPage() {
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
          Outline — {section.displayName}
        </h1>
      </header>

      <SectionBoundaryEditor
        sectionId={section._id}
        displayName={section.displayName}
        initial={section.boundary ?? null}
        fallbackCentre={CENTRE}
      />
    </div>
  );
}
