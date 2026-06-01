"use client";

/**
 * MarkIntermentCompleteSheet — Story 7.4.
 *
 * Sheet wrapper around `CompletionForm`. Bottom sheet on mobile
 * (slides up from the bottom, where the operator's thumb is), right
 * sheet on desktop (matches `IntermentForm` placement). Responsive
 * `side` prop swap is the only difference between the two surfaces.
 *
 * The component is presentational + composition only — it owns no
 * mutation calls. The parent (the `/complete` route page or the
 * today's-interments list page) passes:
 *
 *   - `intermentId` + display context (occupant name, lot code,
 *     scheduled time) for the sheet header + form context
 *   - `generateUploadUrl` callback for the photo two-step upload
 *   - `onSubmit` callback that invokes
 *     `completeInterment({ intermentId, notes, photoBlobId })` and
 *     handles routing / toast / etc.
 *
 * The sheet stays open (no auto-close) during submission. On success
 * the parent's `onSubmit` typically calls `onOpenChange(false)` to
 * close; on error the inline form-level error stays visible inside
 * the sheet and the parent does NOT close.
 */

import { useEffect, useState } from "react";

import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

import {
  CompletionForm,
  type CompletionSubmitPayload,
} from "./CompletionForm";

export interface MarkIntermentCompleteSheetProps {
  /** Convex `Id<"interments">` as a string. */
  intermentId: string;
  occupantName: string;
  lotCode: string;
  scheduledAt: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Returns a short-lived Convex File Storage upload URL. */
  generateUploadUrl: () => Promise<string>;
  /**
   * Parent-supplied submit handler. The parent invokes the
   * `completeInterment` mutation; the form's payload arrives here
   * with the resolved `photoStorageId` (if any) and trimmed notes.
   */
  onSubmit: (payload: CompletionSubmitPayload) => Promise<void>;
}

const MOBILE_BREAKPOINT_PX = 768;

function useIsMobile(): boolean {
  // SSR-safe initial value — server renders the desktop variant; the
  // client effect below promotes to mobile when the viewport is
  // narrow enough. Avoids hydration mismatch.
  const [isMobile, setIsMobile] = useState<boolean>(false);
  useEffect(() => {
    function update() {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT_PX);
    }
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return isMobile;
}

export function MarkIntermentCompleteSheet({
  intermentId,
  occupantName,
  lotCode,
  scheduledAt,
  open,
  onOpenChange,
  generateUploadUrl,
  onSubmit,
}: MarkIntermentCompleteSheetProps) {
  const isMobile = useIsMobile();
  // Prevent unused-prop lint while keeping the `intermentId` in the
  // public contract — the parent always passes it and downstream
  // tests assert it's wired through. The form itself doesn't need it
  // (it's the parent's mutation that consumes it).
  void intermentId;
  const side: "bottom" | "right" = isMobile ? "bottom" : "right";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={side}
        className={
          isMobile
            ? "max-h-[90vh] w-full overflow-y-auto rounded-t-xl border-t"
            : "h-full w-full max-w-md overflow-y-auto"
        }
        data-testid="mark-interment-complete-sheet"
      >
        <div className="space-y-1 pb-4">
          <SheetTitle>Mark interment complete</SheetTitle>
          <SheetDescription>
            Capture the completion time, optional notes, and an
            optional photo. The lot transitions to “occupied” when you
            mark complete.
          </SheetDescription>
        </div>
        <CompletionForm
          occupantName={occupantName}
          lotCode={lotCode}
          scheduledAt={scheduledAt}
          generateUploadUrl={generateUploadUrl}
          onSubmit={onSubmit}
          onCancel={() => onOpenChange(false)}
        />
      </SheetContent>
    </Sheet>
  );
}
