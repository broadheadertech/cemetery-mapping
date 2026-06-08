"use client";

/**
 * LotActionMenu — the Map cockpit's click-a-lot action sheet.
 *
 * Clicking a lot on `/map` opens this instead of navigating straight to
 * the record, so the map becomes the place you *act*: view, sell,
 * schedule an interment, or record a payment — one tap from the map.
 *
 * Renderer-agnostic by design: it lives on the map page (React), driven
 * by the `onLotClick(lotId)` callback both the SVG and Leaflet renderers
 * already emit — no fiddly Leaflet popups. It fetches the lot by id so
 * the actions can be status-aware (e.g. "Start sale" only for an
 * Available lot, which is what the sale form's picker accepts).
 */

import Link from "next/link";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { CreditCard, FileText, MapPin, Receipt, CalendarPlus } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { StatusPill } from "@/components/ui/StatusPill";
import type { LotStatus } from "@/types/lot-status";

interface LotForMenu {
  _id: string;
  code: string;
  section: string;
  status: LotStatus;
}

const getLotRef = makeFunctionReference<
  "query",
  { lotId: string },
  LotForMenu | null
>("lots:getLot");

export interface LotActionMenuProps {
  /** The clicked lot, or null when the menu is closed. */
  lotId: string | null;
  onClose: () => void;
}

export function LotActionMenu({ lotId, onClose }: LotActionMenuProps) {
  const open = lotId !== null;
  // `"skip"` keeps hook order stable while avoiding a query when closed.
  const lot = useQuery(getLotRef, lotId !== null ? { lotId } : "skip");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {lot === undefined || lot === null
              ? "Lot"
              : `Lot ${lot.code}`}
          </DialogTitle>
          <DialogDescription>
            {lot === undefined
              ? "Loading…"
              : lot === null
                ? "This lot could not be loaded."
                : lot.section}
          </DialogDescription>
        </DialogHeader>

        {lot !== undefined && lot !== null && (
          <>
            <div className="mb-1">
              <StatusPill status={lot.status} size="md" />
            </div>

            <div className="flex flex-col gap-2">
              <ActionLink
                href={`/lots/${lot._id}`}
                icon={<FileText className="h-4 w-4" aria-hidden="true" />}
                label="Open full record"
                primary
              />
              {lot.status === "available" && (
                <ActionLink
                  href={`/sales/new?lotId=${encodeURIComponent(lot._id)}`}
                  icon={<Receipt className="h-4 w-4" aria-hidden="true" />}
                  label="Start a sale"
                />
              )}
              <ActionLink
                href={`/interments/new?lotId=${encodeURIComponent(lot._id)}`}
                icon={<CalendarPlus className="h-4 w-4" aria-hidden="true" />}
                label="Schedule interment"
              />
              <ActionLink
                href="/payments/new"
                icon={<CreditCard className="h-4 w-4" aria-hidden="true" />}
                label="Record payment"
              />
              <ActionLink
                href={`/lots/${lot._id}/location`}
                icon={<MapPin className="h-4 w-4" aria-hidden="true" />}
                label="Set / move location"
              />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ActionLink({
  href,
  icon,
  label,
  primary = false,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={[
        "inline-flex min-h-[44px] items-center gap-2.5 rounded-md px-4 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2",
        primary
          ? "bg-primary text-primary-fg hover:bg-primary-hover"
          : "border border-surface-border bg-surface-base text-text-default hover:border-accent-gold hover:text-primary",
      ].join(" ")}
    >
      {icon}
      {label}
    </Link>
  );
}

export default LotActionMenu;
