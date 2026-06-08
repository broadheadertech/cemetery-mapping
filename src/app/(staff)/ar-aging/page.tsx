"use client";

/**
 * /ar-aging — Story 4.8 (FR34/FR35, UX-DR10).
 *
 * Drill-down destination for the dashboard's AR Aging Summary buckets
 * (Story 5.3 AC2). The page hosts the `ArAgingTable` component (the
 * Journey-4 climax surface) plus a bucket filter chip row so the user
 * can switch buckets without bouncing back to the dashboard.
 *
 * URL is the source of truth (Story 5.3 AC5):
 *   - `?bucket=1-30 | 31-60 | 61-90 | 90+`  — filter to a single bucket.
 *     `90+` arrives URL-encoded as `90%2B`; `parseBucket` also accepts
 *     `90 ` (where `+` decoded to space) for hand-built deep links.
 *   - No `bucket` param — show all overdue buckets in one list.
 *
 * Auth:
 *   - `requireRole(ctx, ["admin", "office_staff"])` is enforced inside
 *     `arAging:listAgingDetail` (Story 4.8 server task).
 *   - Story 4.8 acceptance criteria called for "admin only" with
 *     middleware redirect, but Story 4.1 set the precedent that the
 *     drill-down + dashboard aging surfaces are visible to office_staff
 *     (Maria's flagged-for-me queue links here too). Server-side
 *     authorisation is the source of truth.
 */

import { useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import {
  ArAgingTable,
  BUCKET_LABEL,
  OVERDUE_BUCKETS,
  type ArAgingBucket,
  type ArAgingDetailResult,
} from "@/components/ArAgingTable";
import { cn } from "@/lib/cn";

const listAgingDetailRef = makeFunctionReference<
  "query",
  { bucket?: ArAgingBucket },
  ArAgingDetailResult
>("arAging:listAgingDetail");

function parseBucket(raw: string | null): ArAgingBucket | null {
  if (raw === null) return null;
  // Defend against `+` decoded to ` ` (space) — Next.js's `Link` uses
  // `URLSearchParams` which encodes `+` as `%2B`, but a hand-built URL
  // may slip through as `90+` which `useSearchParams` will read as
  // `90 ` (space). Accept both.
  const normalised = raw.replace(/\s$/, "+");
  if (
    normalised === "1-30" ||
    normalised === "31-60" ||
    normalised === "61-90" ||
    normalised === "90+"
  ) {
    return normalised;
  }
  return null;
}

export default function ArAgingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const bucket = useMemo(
    () => parseBucket(searchParams.get("bucket")),
    [searchParams],
  );

  // Convex query — undefined while loading, the result object once
  // resolved. The reactive subscription means a follow-up action
  // attached by Maria in another tab will flip the row tint here
  // without a manual refresh (AC6).
  const result = useQuery(
    listAgingDetailRef,
    bucket === null ? {} : { bucket },
  );

  const setBucket = (next: ArAgingBucket | null): void => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === null) {
      params.delete("bucket");
    } else {
      params.set("bucket", next);
    }
    const query = params.toString();
    router.push(query.length === 0 ? "/ar-aging" : `/ar-aging?${query}`);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-4xl font-semibold tracking-tight">AR Aging</h1>
        <Link
          href="/dashboard"
          className="text-sm font-medium text-slate-600 hover:text-slate-900"
          data-testid="ar-aging-back-to-dashboard"
        >
          ← Back to dashboard
        </Link>
      </div>

      <p className="text-sm text-slate-600">
        Distinguishes <span className="font-medium text-rose-700">silently
        overdue</span> contracts (need follow-up) from{" "}
        <span className="font-medium text-amber-700">overdue with a
        logged action</span> (already being handled). Tap a row to open
        the contract.
      </p>

      {/* Bucket filter chips */}
      <div
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label="Filter by aging bucket"
        data-testid="ar-aging-bucket-chips"
      >
        <BucketChip
          label="All overdue"
          active={bucket === null}
          onClick={() => setBucket(null)}
          testId="ar-aging-bucket-chip-all"
        />
        {OVERDUE_BUCKETS.map((b) => (
          <BucketChip
            key={b}
            label={BUCKET_LABEL[b]}
            active={bucket === b}
            onClick={() => setBucket(b)}
            testId={`ar-aging-bucket-chip-${b}`}
          />
        ))}
      </div>

      <ArAgingTable result={result} bucket={bucket} />
    </div>
  );
}

interface BucketChipProps {
  label: string;
  active: boolean;
  onClick: () => void;
  testId: string;
}

function BucketChip({
  label,
  active,
  onClick,
  testId,
}: BucketChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={active}
      className={cn(
        "inline-flex h-9 items-center rounded-full border px-3 text-sm font-medium transition-colors",
        active
          ? "border-[#1D5C4D] bg-[#1D5C4D] text-white"
          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
      )}
    >
      {label}
    </button>
  );
}
