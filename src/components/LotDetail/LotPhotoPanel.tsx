"use client";

/**
 * A photograph of the lot as it stands.
 *
 * This is what "surveyed" means in practice for a park this size: a
 * picture somebody took, not a polygon somebody paid a surveyor for. It
 * is what a family recognises, and what settles "is this the one by the
 * tree" — a question `geometry.polygon` has never answered for anybody.
 *
 * Field workers can post one. They are the people standing at the lot
 * with a phone, and a photograph that has to go through the office is a
 * photograph that does not get taken.
 *
 * Distinct from the condition log below it, which is a dated
 * observation of a PROBLEM. This is the representative image, and there
 * is one: replacing it deletes the old file rather than leaving a trail
 * of superseded attempts nothing references.
 *
 * @gated-route-only — mounts on `/lots/[lotId]`, which field workers
 * use; the mutations behind it admit them explicitly.
 */

import { useRef, useState, type ReactElement } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

interface LotPhotoView {
  photoUrl: string | null;
  photoUpdatedAt: number | null;
  geometryStatus: string;
  lat: number | null;
  lng: number | null;
  areaSqm: number;
  widthM: number;
  depthM: number;
}

const detailRef = makeFunctionReference<
  "query",
  { lotId: string },
  LotPhotoView | null
>("lots:getMapLotDetail");

const uploadUrlRef = makeFunctionReference<
  "mutation",
  Record<string, never>,
  string
>("lots:generateLotPhotoUploadUrl");

const setPhotoRef = makeFunctionReference<
  "mutation",
  { lotId: string; storageId: string },
  { lotId: string }
>("lots:setLotPhoto");

/** What a phone camera produces, and nothing else. */
const ACCEPT = "image/png,image/jpeg,image/webp";

/** Above this a phone photo is being uploaded unresized. */
const LARGE_BYTES = 8 * 1024 * 1024;

export interface LotPhotoPanelProps {
  lotId: string;
  /** Field workers may add one; the panel is read-only otherwise. */
  canEdit?: boolean;
}

export function LotPhotoPanel({
  lotId,
  canEdit = true,
}: LotPhotoPanelProps): ReactElement {
  const detail = useQuery(detailRef, { lotId });
  const getUploadUrl = useMutation(uploadUrlRef);
  const setPhoto = useMutation(setPhotoRef);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * A remark about the file, kept apart from `error`.
   *
   * `handleUpload` clears `error` on the way in, so a size notice set
   * just before calling it was wiped in the same tick — the upload
   * succeeded and the person was never told their photo was 12MB. Two
   * states because they have two lifetimes: one belongs to the attempt,
   * the other to the file.
   */
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function handleUpload(file: File): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const url = await getUploadUrl({});
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status}).`);
      const { storageId } = (await res.json()) as { storageId: string };
      await setPhoto({ lotId, storageId });
      if (fileRef.current !== null) fileRef.current.value = "";
    } catch (e: unknown) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid="lot-photo-panel"
      className="w-full rounded-md border border-slate-200 bg-white p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-xl font-light">Photograph</h2>
        {detail?.photoUpdatedAt != null && (
          <span className="text-xs text-slate-500">
            Taken {formatDay(detail.photoUpdatedAt)}
          </span>
        )}
      </div>

      {detail === undefined ? (
        <p className="mt-3 text-sm text-slate-500">Loading&hellip;</p>
      ) : detail === null ? (
        <p className="mt-3 text-sm text-slate-500">This lot is not there.</p>
      ) : (
        <>
          {detail.photoUrl !== null ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={detail.photoUrl}
              alt="The lot as it stands"
              data-testid="lot-photo-image"
              className="mt-3 w-full rounded-md border border-slate-200 object-cover"
            />
          ) : (
            <p
              data-testid="lot-photo-empty"
              className="mt-3 rounded-md border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500"
            >
              No photograph yet. One picture does more to make this lot
              findable than any coordinate.
            </p>
          )}

          {/* The size and where it is — the facts somebody standing in
              the park actually needs, beside the picture of it. */}
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-slate-500">Size</dt>
              <dd className="text-slate-800">
                {detail.widthM}m × {detail.depthM}m · {detail.areaSqm} sqm
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Position</dt>
              <dd
                data-testid="lot-photo-position"
                className="text-slate-800"
              >
                {detail.lat !== null && detail.lng !== null ? (
                  <span className="font-mono text-xs">
                    {detail.lat.toFixed(6)}, {detail.lng.toFixed(6)}
                  </span>
                ) : (
                  <span className="text-slate-500">
                    Not surveyed
                  </span>
                )}
              </dd>
            </div>
          </dl>

          {canEdit && (
            <div className="mt-4 space-y-2">
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPT}
                disabled={busy}
                data-testid="lot-photo-input"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file === undefined) return;
                  // A phone photo straight off the camera can be 12MB.
                  // Uploading it works but costs the field worker their
                  // data and everybody else the load time, so it is
                  // worth saying rather than silently accepting.
                  setNotice(null);
                  if (file.size > LARGE_BYTES) {
                    setNotice(
                      `That is ${Math.round(file.size / (1024 * 1024))}MB. It will upload, but a smaller picture loads faster for everybody — most phones can send a reduced copy.`,
                    );
                  }
                  void handleUpload(file);
                }}
                className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:text-white"
              />
              <p className="text-xs text-slate-500">
                {detail.photoUrl !== null
                  ? "Uploading a new picture replaces this one."
                  : "A photograph of the lot as it stands."}
              </p>
            </div>
          )}

          {busy && (
            <p className="mt-2 text-sm text-slate-500">Uploading&hellip;</p>
          )}
          {notice !== null && (
            <p
              data-testid="lot-photo-notice"
              className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            >
              {notice}
            </p>
          )}
          {error !== null && (
            <p
              role="alert"
              data-testid="lot-photo-error"
              className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            >
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function formatDay(ms: number): string {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(ms));
}

/** The server's own words, when it has any. */
function messageOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const data = (error as { data?: { message?: unknown } }).data;
    if (typeof data?.message === "string" && data.message.length > 0) {
      return data.message;
    }
    const msg = (error as { message?: unknown }).message;
    if (typeof msg === "string" && msg.length > 0) return msg;
  }
  return "Something went wrong. Nothing was saved.";
}
