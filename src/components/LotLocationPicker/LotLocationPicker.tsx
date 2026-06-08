"use client";

/**
 * LotLocationPicker — the Map cockpit's "click to place a lot" surface.
 *
 * Shows an OpenStreetMap tile map; the operator clicks where the lot is
 * and the marker moves there. Saving calls `lots:setLotLocation`, which
 * stores the clicked point as the centroid and auto-draws a footprint
 * from the lot's own dimensions. This is the point-at-the-map alternative
 * to typing coordinates / uploading a CSV.
 *
 * Leaflet discipline (mirrors LeafletRenderer):
 *   - `import("leaflet")` + its CSS happen inside `useEffect`, never at
 *     module load, so `window` is never touched during SSR.
 *   - The initial view is non-animated and the container size is settled
 *     with `invalidateSize` first — avoids the `_leaflet_pos` init crash.
 *   - A circle marker (not `L.marker`) sidesteps Leaflet's broken
 *     default-icon asset resolution under bundlers.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { translateError } from "@/lib/errors";

const setLotLocationRef = makeFunctionReference<
  "mutation",
  { lotId: string; lat: number; lng: number },
  null
>("lots:setLotLocation");

export interface LotLocationPickerProps {
  lotId: string;
  lotCode: string;
  /** Initial map centre + marker — the lot's current centroid, or the
   *  cemetery default when it has none yet. */
  initial: { lat: number; lng: number };
  /** Whether the lot already has surveyed geometry (affects the copy). */
  surveyed: boolean;
}

export function LotLocationPicker({
  lotId,
  lotCode,
  initial,
  surveyed,
}: LotLocationPickerProps) {
  const router = useRouter();
  const setLotLocation = useMutation(setLotLocationRef);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<unknown>(null);

  const [point, setPoint] = useState<{ lat: number; lng: number }>(initial);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (container === null) return;

    (async () => {
      const L = await import("leaflet");
      await import("leaflet/dist/leaflet.css");
      if (cancelled || containerRef.current === null) return;

      const map = L.map(container, {
        center: [initial.lat, initial.lng],
        zoom: 18,
        keyboard: true,
        attributionControl: true,
      });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(map);
      map.invalidateSize({ animate: false });

      const marker = L.circleMarker([initial.lat, initial.lng], {
        radius: 9,
        color: "#1D5C4D",
        fillColor: "#1D5C4D",
        fillOpacity: 0.7,
        weight: 3,
      }).addTo(map);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      map.on("click", (e: any) => {
        const lat = e.latlng.lat as number;
        const lng = e.latlng.lng as number;
        marker.setLatLng([lat, lng]);
        setPoint({ lat, lng });
      });

      mapRef.current = map;
      setReady(true);
    })();

    return () => {
      cancelled = true;
      const map = mapRef.current as { remove?: () => void } | null;
      if (map !== null && typeof map.remove === "function") map.remove();
      mapRef.current = null;
    };
  }, [initial.lat, initial.lng]);

  async function handleSave(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await setLotLocation({ lotId, lat: point.lat, lng: point.lng });
      router.push(`/lots/${lotId}`);
    } catch (err) {
      setError(translateError(err).detail);
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div
        role="status"
        className="rounded-md border border-surface-border bg-surface-muted px-4 py-3 text-sm text-text-default"
      >
        Click the map where lot <strong>{lotCode}</strong> sits. The system
        draws the lot&apos;s footprint from its recorded dimensions around the
        point you choose.
        {surveyed && (
          <span className="mt-1 block text-xs text-text-muted">
            This lot already has a location — clicking sets a new one.
          </span>
        )}
      </div>

      <div
        ref={containerRef}
        role="application"
        aria-label={`Click to place lot ${lotCode}. Arrow keys pan; plus and minus zoom.`}
        data-testid="lot-location-picker"
        className="w-full overflow-hidden rounded-md border border-surface-border bg-surface-muted"
        style={{ height: "60vh", minHeight: 360 }}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="font-mono text-xs text-text-muted">
          {ready
            ? `Selected: ${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`
            : "Loading map…"}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => router.push(`/lots/${lotId}`)}
            className="inline-flex min-h-[44px] items-center rounded-md border border-surface-border bg-surface-base px-4 py-2 text-sm font-medium text-text-default hover:bg-surface-emphasis"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !ready}
            className="inline-flex min-h-[44px] items-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-fg hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save location"}
          </button>
        </div>
      </div>

      {error !== null && (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {error}
        </p>
      )}
    </div>
  );
}

export default LotLocationPicker;
