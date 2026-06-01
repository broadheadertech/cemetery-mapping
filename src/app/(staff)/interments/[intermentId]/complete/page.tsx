"use client";

/**
 * /interments/[intermentId]/complete — Mark-complete route (Story 7.4 AC2/AC3).
 *
 * Standalone route page that renders `MarkIntermentCompleteSheet` as a
 * fullscreen surface on mobile and a right-side sheet on desktop.
 * Loads the interment detail (`getInterment`) for the read-only
 * context header (occupant name, lot code, scheduled time), then
 * delegates submission to `completeInterment`.
 *
 * On success, navigates back to `/interments/today` — the just-
 * completed row drops off the list reactively (the today's query
 * filters `status === "scheduled"`), and the office staff calendar
 * (Story 7.3) flips colour via Convex reactivity. No toast needed
 * (UX § Calm Reactivity).
 *
 * On error, the sheet stays open and surfaces the inline error;
 * Junior may retry or cancel.
 *
 * Auth: the (staff) layout protects this route; per-role checks live
 * inside `completeInterment` itself (admin / office_staff /
 * field_worker).
 */

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";

import {
  MarkIntermentCompleteSheet,
  type CompletionSubmitPayload,
} from "@/components/IntermentForm";
import { translateError } from "@/lib/errors";

interface IntermentDetail {
  intermentId: string;
  scheduledAt: number;
  status: "scheduled" | "completed" | "cancelled";
  occupantId: string;
  occupantName: string;
  notes: string | undefined;
  scheduledByName: string;
  scheduledAt_createdAt: number;
  lotId: string;
  lotCode: string;
  lotSection: string;
  lotBlock: string;
  lotRow: string;
  completedAt: number | undefined;
  completedByName: string | undefined;
  completionNotes: string | undefined;
  cancellationReason: string | undefined;
}

const getIntermentRef = makeFunctionReference<
  "query",
  { intermentId: string },
  IntermentDetail | null
>("interments:getInterment");

const generateUploadUrlRef = makeFunctionReference<
  "mutation",
  Record<string, never>,
  string
>("interments:generateUploadUrl");

interface CompleteIntermentResult {
  intermentId: string;
  lotTransitioned: boolean;
}

const completeIntermentRef = makeFunctionReference<
  "mutation",
  { intermentId: string; notes?: string; photoBlobId?: string },
  CompleteIntermentResult
>("interments:completeInterment");

export default function CompleteIntermentPage() {
  const params = useParams<{ intermentId: string }>();
  const router = useRouter();
  const intermentId = params?.intermentId ?? "";
  const interment = useQuery(
    getIntermentRef,
    intermentId !== "" ? { intermentId } : "skip",
  );
  const generateUploadUrl = useMutation(generateUploadUrlRef);
  const completeInterment = useMutation(completeIntermentRef);
  const [open, setOpen] = useState<boolean>(true);
  const [pageError, setPageError] = useState<string | null>(null);

  // If the sheet is closed (cancel or success) navigate back to the
  // today's list. Effect runs after the close handler so the close
  // animation completes before the route swap.
  useEffect(() => {
    if (!open) {
      router.push("/interments/today");
    }
  }, [open, router]);

  if (interment === undefined) {
    return (
      <div className="mx-auto max-w-xl p-6 text-sm text-slate-500">
        Loading interment…
      </div>
    );
  }

  if (interment === null) {
    return (
      <div className="mx-auto max-w-xl p-6 text-sm text-red-700">
        Interment not found.
      </div>
    );
  }

  if (interment.status !== "scheduled") {
    return (
      <div
        className="mx-auto max-w-xl space-y-3 p-6"
        data-testid="complete-already-done"
      >
        <p className="text-base font-medium text-slate-900">
          This interment is no longer scheduled.
        </p>
        <p className="text-sm text-slate-600">
          Current status: <strong>{interment.status}</strong>. Marking
          complete is only available for scheduled rows.
        </p>
        <button
          type="button"
          onClick={() => router.push("/interments/today")}
          className="min-h-[44px] rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Back to today’s list
        </button>
      </div>
    );
  }

  async function onSubmit(payload: CompletionSubmitPayload): Promise<void> {
    setPageError(null);
    try {
      await completeInterment({
        intermentId,
        notes: payload.notes,
        photoBlobId: payload.photoStorageId,
      });
      setOpen(false);
    } catch (err) {
      const translated =
        err instanceof ConvexError ? translateError(err) : translateError(err);
      setPageError(translated.detail);
      // Re-throw so the form can render its own inline error too.
      throw err;
    }
  }

  return (
    <>
      {/* Accessible page heading — required by `local-rules/single-h1-per-page`.
          Visually hidden because the active surface is the Sheet, which carries
          its own `<SheetTitle>` for screen readers. */}
      <h1 className="sr-only">Mark interment complete</h1>
      {pageError !== null && (
        <div
          className="mx-auto mt-4 max-w-xl rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
          role="alert"
          data-testid="complete-page-error"
        >
          {pageError}
        </div>
      )}
      <MarkIntermentCompleteSheet
        intermentId={interment.intermentId}
        occupantName={interment.occupantName}
        lotCode={interment.lotCode}
        scheduledAt={interment.scheduledAt}
        open={open}
        onOpenChange={setOpen}
        generateUploadUrl={() => generateUploadUrl({})}
        onSubmit={onSubmit}
      />
    </>
  );
}
