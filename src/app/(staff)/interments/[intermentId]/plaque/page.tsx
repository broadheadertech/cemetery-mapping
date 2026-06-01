"use client";

/**
 * /interments/[intermentId]/plaque — memorial plaque PDF generator
 * (Story 6.8).
 *
 * Two-column layout (stacked on mobile):
 *   - Left: `PlaqueForm` with name + dates + format toggle + epitaph,
 *     prefilled from the interment's joined occupant when available.
 *     Submit calls `plaqueDrafts.requestPlaqueDraft` via `useMutation`,
 *     which inserts a `pending` row and schedules the renderer action.
 *   - Right: `PlaqueDraftHistory` rail subscribed to
 *     `plaqueDrafts.listForInterment`. When the action lands, the row
 *     reactively flips `pending → ready` and the ReactiveHighlight
 *     amber flash announces the change.
 *
 * Role gate: admin + office_staff. Field workers are sent to a 403
 * panel; the (staff) layout's middleware lets them onto the route
 * but the server-side mutation throws FORBIDDEN — we shape the page
 * around the role check so the operator sees clear copy instead of
 * a generic toast.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useConvex, useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { PlaqueForm, type PlaqueFormValues } from "@/components/PlaqueForm";
import {
  PlaqueDraftHistory,
  type PlaqueDraftHistoryRow,
} from "@/components/PlaqueDraftHistory";

// -----------------------------------------------------------------------------
// Function references — string-path form, mirrors the rest of the codebase.
// -----------------------------------------------------------------------------

interface IntermentDetail {
  intermentId: string;
  scheduledAt: number;
  status: "scheduled" | "completed" | "cancelled";
  occupantId: string;
  occupantName: string;
  lotId: string;
  lotCode: string;
  lotSection: string;
  lotBlock: string;
  lotRow: string;
}

const getIntermentRef = makeFunctionReference<
  "query",
  { intermentId: string },
  IntermentDetail | null
>("interments:getInterment");

const listForIntermentRef = makeFunctionReference<
  "query",
  { intermentId: string },
  PlaqueDraftHistoryRow[]
>("plaqueDrafts:listForInterment");

const requestPlaqueDraftRef = makeFunctionReference<
  "mutation",
  {
    intermentId: string;
    deceasedName: string;
    bornYear: number;
    diedYear: number;
    dateFormat: "arabic" | "roman";
    epitaph?: string;
  },
  { plaqueDraftId: string; version: number }
>("plaqueDrafts:requestPlaqueDraft");

const retryPlaqueDraftRef = makeFunctionReference<
  "mutation",
  { plaqueDraftId: string },
  { plaqueDraftId: string; retryCount: number }
>("plaqueDrafts:retryPlaqueDraft");

const getPlaqueUrlRef = makeFunctionReference<
  "query",
  { plaqueDraftId: string },
  { url: string | null; generatedAt: number | null }
>("plaqueDrafts:getPlaqueUrl");

interface AuthPayloadShape {
  roles: ReadonlyArray<"admin" | "office_staff" | "field_worker" | "customer">;
}

const getCurrentUserOrNullRef = makeFunctionReference<
  "query",
  Record<string, never>,
  AuthPayloadShape | null
>("lib/auth:getCurrentUserOrNull");

// -----------------------------------------------------------------------------

export default function PlaquePage() {
  const params = useParams<{ intermentId: string }>();
  const intermentId = params?.intermentId ?? "";

  const interment = useQuery(
    getIntermentRef,
    intermentId !== "" ? { intermentId } : "skip",
  );
  const drafts = useQuery(
    listForIntermentRef,
    intermentId !== "" ? { intermentId } : "skip",
  );
  const auth = useQuery(getCurrentUserOrNullRef, {});
  const requestPlaqueDraft = useMutation(requestPlaqueDraftRef);
  const retryPlaqueDraft = useMutation(retryPlaqueDraftRef);
  const convex = useConvex();

  const isAdmin = (auth?.roles ?? []).includes("admin");
  const isStaff =
    (auth?.roles ?? []).includes("admin") ||
    (auth?.roles ?? []).includes("office_staff");

  // Form prefill: defaults derive from the joined occupant name. The
  // form doesn't pre-fill years from prior drafts on every page load
  // (per Story 6.8 § Disaster prevention) — "Use as starting point"
  // on a draft-row is the explicit affordance for that.
  const [initialFormValues, setInitialFormValues] = useState<
    Partial<PlaqueFormValues>
  >({});

  useEffect(() => {
    if (interment === undefined || interment === null) return;
    setInitialFormValues((current) => {
      if (current.deceasedName !== undefined && current.deceasedName !== "") {
        return current;
      }
      return {
        deceasedName: interment.occupantName,
        dateFormat: "arabic",
      };
    });
  }, [interment]);

  useEffect(() => {
    if (interment !== undefined && interment !== null) {
      document.title = `Plaque · ${interment.occupantName} · Broadheader`;
    } else if (interment === null) {
      document.title = "Plaque · interment not found · Broadheader";
    }
  }, [interment]);

  const handleSubmit = useCallback(
    async (values: PlaqueFormValues) => {
      const args: Parameters<typeof requestPlaqueDraft>[0] = {
        intermentId,
        deceasedName: values.deceasedName,
        bornYear: values.bornYear,
        diedYear: values.diedYear,
        dateFormat: values.dateFormat,
      };
      if (values.epitaph !== undefined && values.epitaph.length > 0) {
        args.epitaph = values.epitaph;
      }
      await requestPlaqueDraft(args);
    },
    [intermentId, requestPlaqueDraft],
  );

  const handleUseAsStartingPoint = useCallback(
    (row: PlaqueDraftHistoryRow) => {
      setInitialFormValues({
        deceasedName: row.deceasedName,
        bornYear: row.bornYear,
        diedYear: row.diedYear,
        dateFormat: row.dateFormat,
        epitaph: row.epitaph ?? "",
      });
    },
    [],
  );

  const handleDownload = useCallback(
    async (plaqueDraftId: string) => {
      const result = await convex.query(getPlaqueUrlRef, { plaqueDraftId });
      if (result.url === null) {
        throw new Error("PDF not yet ready. Please try again in a moment.");
      }
      // Open in a new tab so the operator can preview without leaving
      // the plaque page (the family often reviews the PDF on-screen
      // before requesting another revision).
      window.open(result.url, "_blank", "noopener");
    },
    [convex],
  );

  const handleRetry = useCallback(
    async (plaqueDraftId: string) => {
      await retryPlaqueDraft({ plaqueDraftId });
    },
    [retryPlaqueDraft],
  );

  // Loading state — wait for the auth resolve + interment resolve.
  if (auth === undefined || interment === undefined) {
    return (
      <div className="mx-auto max-w-5xl p-6">
        <p className="text-sm text-slate-500">Loading…</p>
      </div>
    );
  }

  if (!isStaff) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <h1 className="text-2xl font-bold text-slate-900">Access denied</h1>
        <p className="mt-2 text-sm text-slate-700">
          The plaque PDF generator is available to Office Staff and Admin only.
        </p>
      </div>
    );
  }

  if (interment === null) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <h1 className="text-2xl font-bold text-slate-900">Interment not found</h1>
        <p className="mt-2 text-sm text-slate-700">
          We couldn&apos;t find the interment record for this URL.
        </p>
        <Link
          href="/interments"
          className="mt-4 inline-flex min-h-[44px] items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Back to interments
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-slate-500">
          Memorial plaque
        </p>
        <h1 className="text-2xl font-bold text-slate-900">
          {interment.occupantName}
        </h1>
        <p className="text-sm text-slate-700">
          Lot {interment.lotCode}
          {interment.lotSection.length > 0 && (
            <> — {interment.lotSection}/{interment.lotBlock}/{interment.lotRow}</>
          )}
        </p>
      </header>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="rounded-md border border-slate-200 bg-white p-4">
          <PlaqueForm
            initialValues={initialFormValues}
            onSubmit={handleSubmit}
          />
        </div>
        <div>
          <PlaqueDraftHistory
            rows={drafts}
            onUseAsStartingPoint={handleUseAsStartingPoint}
            onDownload={handleDownload}
            isAdmin={isAdmin}
            onRetry={handleRetry}
          />
        </div>
      </div>

      <div>
        <Link
          href={`/interments/${interment.intermentId}`}
          className="inline-flex min-h-[44px] items-center text-sm font-medium text-slate-900 underline"
        >
          ← Back to interment
        </Link>
      </div>
    </div>
  );
}
