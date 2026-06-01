"use client";

/**
 * /lots/[lotId] — canonical lot detail page (Story 1.11).
 *
 * Supersedes Story 1.8's placeholder. Composes Story 1.11's
 * `<LotDetail>` orchestrator with the page-level concerns:
 *
 *   - `useQuery(lots:getLot)` for the lot doc + live reactive updates.
 *   - `useQuery(lib/auth:getCurrentUserOrNull)` to know the caller's
 *     roles for the Edit / Retire UI gate. The server (`updateLot` /
 *     `retireLot` in `convex/lots.ts`) is the real gate; the UI gate
 *     is defense-in-depth + UX consistency.
 *   - Loading / not-found / error states (UX § Loading + Empty State
 *     Patterns — skeleton with the same layout shape, never spinner).
 *   - `document.title` set in a `useEffect` so the browser tab shows
 *     "Lot D-5-12 · Broadheader". Server-side metadata via App Router's
 *     `generateMetadata` would require a server/client split and pulls
 *     in another Convex fetch path — deferred to Phase 2.
 *
 * Recents integration (AC4): every mount calls Story 1.10's
 * `recordRecentView` so the lot appears in the Cmd-K palette's
 * RECENT group on next open. The helper is idempotent (dedupes by
 * `entityType + entityId`), so React Strict Mode's double-effect in
 * dev is harmless.
 */

import Link from "next/link";
import { useEffect } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { LotDetail, LotDetailSkeleton } from "@/components/LotDetail";
import { useNetworkAwareMutation } from "@/hooks/useNetworkAwareMutation";
import { recordRecentView } from "@/lib/recents";
import type { LotStatus } from "@/types/lot-status";

interface LotDoc {
  _id: string;
  code: string;
  section: string;
  block: string;
  row: string;
  type: "single" | "family" | "mausoleum" | "niche";
  dimensions: { widthM: number; depthM: number };
  basePriceCents: number;
  status: LotStatus;
  geometryStatus: "placeholder" | "surveyed";
  /**
   * Story 8.3 — coordinate redaction. The server returns `null` for
   * placeholder geometry (any role) and for field-worker callers when
   * the polygon would otherwise be exposed. The detail page only ever
   * reads `centroid` here; the `LotDetail` component already accepts a
   * missing geometry slot (`geometry?: ...`) so we just translate `null`
   * to `undefined` at the prop boundary below.
   */
  geometry: {
    centroid: { lat: number; lng: number };
  } | null;
  isRetired: boolean;
}

interface AuthUserDoc {
  email?: string;
  name?: string;
}

interface AuthPayload {
  userId: string;
  user: AuthUserDoc;
  roles: string[];
}

const getLotRef = makeFunctionReference<
  "query",
  { lotId: string },
  LotDoc | null
>("lots:getLot");

const getCurrentUserOrNullRef = makeFunctionReference<
  "query",
  Record<string, never>,
  AuthPayload | null
>("lib/auth:getCurrentUserOrNull");

const retireLotRef = makeFunctionReference<
  "mutation",
  { lotId: string },
  null
>("lots:retireLot");

export default function LotDetailPage() {
  const params = useParams<{ lotId: string }>();
  const lotId = params.lotId;

  const lot = useQuery(getLotRef, { lotId });
  const auth = useQuery(getCurrentUserOrNullRef, {});
  // Story 1.13: wrap with the network-aware mutation so retiring a lot
  // while offline throws OFFLINE_WRITE_BLOCKED instead of dispatching a
  // doomed request. API-compatible with `useMutation`.
  const retireLot = useNetworkAwareMutation(retireLotRef);

  // AC6 + AC4 — set the browser tab title once the lot resolves AND
  // record the visit in the Cmd-K palette's recents. Both run as
  // effects so they don't fire during render. Strict-Mode double-fire
  // is harmless because `recordRecentView` dedupes by id.
  useEffect(() => {
    if (lot !== undefined && lot !== null) {
      document.title = `Lot ${lot.code} · Broadheader`;
      recordRecentView("lot", lot._id, lot.code);
    } else if (lot === null) {
      document.title = "Lot not found · Broadheader";
    }
  }, [lot]);

  // Loading state — Convex returns `undefined` while the subscription
  // resolves. Render a skeleton with the same layout shape so content
  // doesn't jump when data arrives (UX § Loading State Patterns).
  if (lot === undefined) {
    return <LotDetailSkeleton />;
  }

  // Not-found state — Convex returns `null` for unknown / deleted ids.
  // Per UX § Empty State Patterns: friendly copy + a way back, never
  // a 404 or a thrown error.
  if (lot === null) {
    return (
      <div className="space-y-4" data-testid="lot-detail-not-found">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
          Lot not found
        </h1>
        <div
          role="alert"
          className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          We couldn&apos;t find that lot. It may have been retired or the
          link is incorrect.
        </div>
        <Link
          href="/lots"
          className="inline-flex items-center text-sm font-medium text-slate-900 underline"
        >
          ← Back to Lots
        </Link>
      </div>
    );
  }

  const roles = auth?.roles ?? [];

  return (
    <LotDetail
      detail={{
        _id: lot._id,
        code: lot.code,
        section: lot.section,
        block: lot.block,
        row: lot.row,
        type: lot.type,
        dimensions: lot.dimensions,
        basePriceCents: lot.basePriceCents,
        status: lot.status,
        geometryStatus: lot.geometryStatus,
        // Server-redacted geometry is `null` for placeholder lots and
        // for field workers viewing surveyed lots (polygon stripped).
        // `LotDetailData.geometry` is optional — translate `null` →
        // `undefined` so the centroid row + Navigate-to-Maps button
        // collapse gracefully when the caller cannot see coordinates.
        ...(lot.geometry !== null ? { geometry: lot.geometry } : {}),
        isRetired: lot.isRetired,
      }}
      roles={roles}
      onRetire={async () => {
        await retireLot({ lotId });
      }}
    />
  );
}
