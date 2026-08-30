"use client";

/**
 * /admin/settings/certificate — the park's own certificate, and where
 * each detail goes on it.
 *
 * Nothing here composes a certificate. The park uploads the document it
 * had designed — letterhead, border, seal, signature blocks, and the
 * wording its lawyer approved — and then drags the owner's name onto
 * it. Guessing the legal text of a document a family frames, and may
 * one day take to a court, is not this system's business.
 *
 * Admin-only: middleware gates `/admin/*` at the edge and
 * `convex/certificates.ts` re-enforces `requireRole(["admin"])` on
 * every write.
 *
 * The placement grid stores FRACTIONS of the page, not pixels. The
 * preview here is whatever size the browser made it; the certificate is
 * A4. Fractions are the only thing that means the same on both.
 */

import { useRef, useState, type ReactElement } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

// --- server surface ---------------------------------------------------

type Align = "left" | "center" | "right";

interface Field {
  key: string;
  xFrac: number;
  yFrac: number;
  fontSize: number;
  align: Align;
  maxWidthFrac?: number;
}

interface TemplateRow {
  _id: string;
  name: string;
  mimeType: string;
  fileName?: string;
  pageWidthPt: number;
  pageHeightPt: number;
  fields: Field[];
  isActive: boolean;
  createdAt: number;
  previewUrl: string | null;
}

const getTemplateRef = makeFunctionReference<
  "query",
  Record<string, never>,
  TemplateRow | null
>("certificates:getActiveTemplate");

const uploadUrlRef = makeFunctionReference<
  "mutation",
  Record<string, never>,
  string
>("certificates:generateTemplateUploadUrl");

const setTemplateRef = makeFunctionReference<
  "mutation",
  {
    name: string;
    storageId: string;
    mimeType: string;
    fileName?: string;
    pageWidthPt: number;
    pageHeightPt: number;
    fields?: Field[];
  },
  { templateId: string }
>("certificates:setCertificateTemplate");

const setFieldsRef = makeFunctionReference<
  "mutation",
  { templateId: string; fields: Field[] },
  { templateId: string }
>("certificates:setTemplateFields");

/**
 * The details a certificate can carry.
 *
 * Mirrors `FIELD_KEYS` in `convex/lib/certificate.ts`. The server
 * REFUSES a key it does not know rather than dropping it, so a drift
 * here surfaces as a clear error at save rather than a field that
 * silently never appears.
 */
const FIELDS: Array<{ key: string; label: string }> = [
  { key: "ownerName", label: "Owner's name" },
  { key: "lotCode", label: "Lot" },
  { key: "section", label: "Garden" },
  { key: "lotType", label: "Lot type" },
  { key: "contractNumber", label: "Contract number" },
  { key: "serial", label: "Certificate number" },
  { key: "issuedDate", label: "Date issued" },
  { key: "amountPaid", label: "Amount paid" },
];

/** A4 in points — the fallback when a file's own size cannot be read. */
const A4_PT = { width: 595.28, height: 841.89 };

// --- page -------------------------------------------------------------

export default function CertificateTemplatePage(): ReactElement {
  const template = useQuery(getTemplateRef, {});

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Certificate of ownership
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Upload the park&rsquo;s own certificate &mdash; your design,
          your wording &mdash; and say where each detail goes on it. Every
          fully-paid contract is then filled from it.
        </p>
      </header>

      <UploadPanel current={template ?? null} />

      {template !== undefined && template !== null && (
        <PlacementPanel template={template} />
      )}

      {template === null && (
        <p
          data-testid="certificate-no-template"
          className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          No certificate has been uploaded yet. Until one is, the office
          can still attach a finished certificate to a contract by hand
          &mdash; nothing is blocked, it just is not filled in for them.
        </p>
      )}
    </div>
  );
}

// --- uploading the blank ----------------------------------------------

function UploadPanel({ current }: { current: TemplateRow | null }): ReactElement {
  const getUploadUrl = useMutation(uploadUrlRef);
  const setTemplate = useMutation(setTemplateRef);

  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function handleUpload(): Promise<void> {
    const file = fileRef.current?.files?.[0];
    if (file === undefined) {
      setError("Choose a file first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const page = await readPageSize(file);
      const url = await getUploadUrl({});
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status}).`);
      const { storageId } = (await res.json()) as { storageId: string };

      await setTemplate({
        name: name.trim().length > 0 ? name.trim() : file.name,
        storageId,
        mimeType: file.type,
        fileName: file.name,
        pageWidthPt: page.width,
        pageHeightPt: page.height,
      });
      setName("");
      if (fileRef.current !== null) fileRef.current.value = "";
    } catch (e: unknown) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid="certificate-upload"
      className="space-y-4 rounded-md border border-slate-200 bg-white p-5"
    >
      <h2 className="font-display text-2xl font-light">The blank</h2>

      {current !== null && (
        <p className="text-sm text-slate-700">
          In use: <span className="font-medium">{current.name}</span>
          {current.fileName !== undefined && (
            <span className="ml-2 text-xs text-slate-500">
              {current.fileName}
            </span>
          )}
          <span className="ml-2 text-xs text-slate-500">
            {Math.round(current.pageWidthPt)} &times;{" "}
            {Math.round(current.pageHeightPt)} pt
          </span>
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">
            Name it
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Certificate of Ownership 2026"
            data-testid="certificate-name"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">
            The file
          </span>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,image/png,image/jpeg"
            data-testid="certificate-file"
            className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:text-white"
          />
          <span className="text-xs text-slate-500">
            PDF keeps your artwork crisp. PNG or JPEG works too.
          </span>
        </label>
      </div>

      {error !== null && (
        <p
          role="alert"
          data-testid="certificate-upload-error"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
        >
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={busy}
        data-testid="certificate-upload-submit"
        onClick={() => void handleUpload()}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:bg-slate-300"
      >
        {busy ? "Uploading…" : current === null ? "Upload" : "Replace"}
      </button>

      {current !== null && (
        <p className="text-xs text-slate-500">
          Replacing installs a new blank and starts its placements from
          scratch. The old one is kept, not deleted &mdash; a certificate
          issued last year was issued against last year&rsquo;s design,
          and the record should be able to say so.
        </p>
      )}
    </section>
  );
}

// --- placing the fields ------------------------------------------------

function PlacementPanel({
  template,
}: {
  template: TemplateRow;
}): ReactElement {
  const setFields = useMutation(setFieldsRef);

  const [fields, setLocalFields] = useState<Field[]>(template.fields);
  const [selected, setSelected] = useState<string | null>(
    template.fields[0]?.key ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const placed = new Set(fields.map((f) => f.key));
  const current = fields.find((f) => f.key === selected) ?? null;

  function update(key: string, patch: Partial<Field>): void {
    setSaved(false);
    setLocalFields((prev) =>
      prev.map((f) => (f.key === key ? { ...f, ...patch } : f)),
    );
  }

  return (
    <section data-testid="certificate-placement" className="space-y-4">
      <h2 className="font-display text-2xl font-light">Where things go</h2>
      <p className="max-w-2xl text-sm text-slate-600">
        Add a detail, then click on the certificate to put it there. The
        marker is the anchor &mdash; a centred field stays centred whether
        the name is short or long.
      </p>

      <div className="flex flex-wrap gap-2">
        {FIELDS.map((f) => (
          <button
            key={f.key}
            type="button"
            data-testid="certificate-add-field"
            disabled={placed.has(f.key)}
            onClick={() => {
              setLocalFields((prev) => [
                ...prev,
                {
                  key: f.key,
                  xFrac: 0.5,
                  yFrac: 0.5,
                  fontSize: 16,
                  align: "center",
                },
              ]);
              setSelected(f.key);
              setSaved(false);
            }}
            className={[
              "rounded-md border px-3 py-1.5 text-xs font-medium",
              placed.has(f.key)
                ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
            ].join(" ")}
          >
            {placed.has(f.key) ? `${f.label} ✓` : `+ ${f.label}`}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
        <Preview
          template={template}
          fields={fields}
          selected={selected}
          onSelect={setSelected}
          onPlace={(xFrac, yFrac) => {
            if (selected === null) return;
            update(selected, { xFrac, yFrac });
          }}
        />

        <div className="space-y-4">
          {current === null ? (
            <p className="text-sm text-slate-500">
              Add a detail above, or click one on the certificate to
              adjust it.
            </p>
          ) : (
            <div className="space-y-3 rounded-md border border-slate-200 bg-white p-4">
              <p className="font-medium text-slate-900">
                {FIELDS.find((f) => f.key === current.key)?.label ??
                  current.key}
              </p>

              <label className="flex flex-col gap-1">
                <span className="text-sm text-slate-700">Size</span>
                <input
                  type="range"
                  min={6}
                  max={48}
                  value={current.fontSize}
                  data-testid="certificate-font-size"
                  onChange={(e) =>
                    update(current.key, {
                      fontSize: Number.parseInt(e.target.value, 10),
                    })
                  }
                />
                <span className="text-xs text-slate-500">
                  {current.fontSize} pt
                </span>
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm text-slate-700">Alignment</span>
                <select
                  value={current.align}
                  data-testid="certificate-align"
                  onChange={(e) =>
                    update(current.key, { align: e.target.value as Align })
                  }
                  className={inputClass}
                >
                  <option value="left">Starts at the marker</option>
                  <option value="center">Centred on the marker</option>
                  <option value="right">Ends at the marker</option>
                </select>
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm text-slate-700">
                  Room to fill
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round((current.maxWidthFrac ?? 0) * 100)}
                  onChange={(e) => {
                    const pct = Number.parseInt(e.target.value, 10);
                    update(current.key, {
                      maxWidthFrac: pct === 0 ? undefined : pct / 100,
                    });
                  }}
                />
                <span className="text-xs text-slate-500">
                  {current.maxWidthFrac === undefined
                    ? "No limit — a long name may run past the border"
                    : `${Math.round(current.maxWidthFrac * 100)}% of the page; longer text shrinks to fit`}
                </span>
              </label>

              <button
                type="button"
                data-testid="certificate-remove-field"
                onClick={() => {
                  setLocalFields((prev) =>
                    prev.filter((f) => f.key !== current.key),
                  );
                  setSelected(null);
                  setSaved(false);
                }}
                className="text-xs font-medium text-red-700 underline"
              >
                Take this off the certificate
              </button>
            </div>
          )}

          {error !== null && (
            <p
              role="alert"
              data-testid="certificate-placement-error"
              className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
            >
              {error}
            </p>
          )}

          <button
            type="button"
            disabled={busy}
            data-testid="certificate-save-fields"
            onClick={() => {
              setBusy(true);
              setError(null);
              void setFields({ templateId: template._id, fields })
                .then(() => setSaved(true))
                .catch((e: unknown) => setError(messageOf(e)))
                .finally(() => setBusy(false));
            }}
            className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:bg-slate-300"
          >
            {busy ? "Saving…" : "Save placement"}
          </button>

          {saved && (
            <p
              data-testid="certificate-saved"
              className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
            >
              Saved. Issue a certificate on any fully-paid contract to see
              it in place &mdash; worth doing once before a family is
              waiting on one.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * The blank with markers on it.
 *
 * A click anywhere sets the selected field's position, converted from
 * the click's pixel offset into a fraction of the rendered box. The
 * preview's own size is irrelevant to what gets stored, which is the
 * point: this box is a few hundred pixels wide and the certificate is
 * A4.
 */
function Preview({
  template,
  fields,
  selected,
  onSelect,
  onPlace,
}: {
  template: TemplateRow;
  fields: Field[];
  selected: string | null;
  onSelect: (key: string) => void;
  onPlace: (xFrac: number, yFrac: number) => void;
}): ReactElement {
  const aspect = template.pageHeightPt / template.pageWidthPt;

  return (
    <div>
      <div
        data-testid="certificate-preview"
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const xFrac = (e.clientX - box.left) / box.width;
          const yFrac = (e.clientY - box.top) / box.height;
          onPlace(clamp01(xFrac), clamp01(yFrac));
        }}
        style={{ aspectRatio: `1 / ${aspect}` }}
        className="relative w-full cursor-crosshair overflow-hidden rounded-md border border-slate-300 bg-white"
      >
        {template.previewUrl !== null && template.mimeType !== "application/pdf" && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={template.previewUrl}
            alt=""
            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
          />
        )}
        {template.previewUrl !== null && template.mimeType === "application/pdf" && (
          // A PDF renders through the browser's own viewer. It is inert
          // to pointer events so clicks land on the placement layer
          // rather than being swallowed by the plugin.
          <object
            data={`${template.previewUrl}#toolbar=0&navpanes=0&view=Fit`}
            type="application/pdf"
            aria-label="Certificate blank"
            className="pointer-events-none absolute inset-0 h-full w-full"
          />
        )}

        {fields.map((f) => (
          <button
            key={f.key}
            type="button"
            data-testid="certificate-marker"
            onClick={(e) => {
              e.stopPropagation();
              onSelect(f.key);
            }}
            style={{
              left: `${f.xFrac * 100}%`,
              top: `${f.yFrac * 100}%`,
              transform:
                f.align === "center"
                  ? "translate(-50%, -50%)"
                  : f.align === "right"
                    ? "translate(-100%, -50%)"
                    : "translate(0, -50%)",
            }}
            className={[
              "absolute whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium",
              f.key === selected
                ? "bg-emerald-600 text-white ring-2 ring-emerald-300"
                : "bg-slate-900/80 text-white",
            ].join(" ")}
          >
            {FIELDS.find((x) => x.key === f.key)?.label ?? f.key}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Positions are stored as a share of the page, so replacing the
        blank with a different size moves everything proportionally
        rather than off the edge.
      </p>
    </div>
  );
}

// --- bits -------------------------------------------------------------

/**
 * The page size of the uploaded file, in PDF points.
 *
 * A PDF carries its own `/MediaBox`; reading it here means the
 * placements are stored against the real page rather than a guess.
 * `pdf-lib` is server-side only in this repo — the bundle gate exists
 * to keep PDF libraries out of the browser — so this reads the box with
 * a small regex over the file's own header bytes and falls back to A4.
 *
 * An image reports its pixel dimensions, read as points. That is the
 * reading that makes a 300dpi A4 export land at roughly A4 and keeps
 * the fractions meaningful.
 */
async function readPageSize(
  file: File,
): Promise<{ width: number; height: number }> {
  if (file.type.startsWith("image/")) {
    const size = await readImageSize(file);
    if (size !== null) return size;
    return A4_PT;
  }

  try {
    // The MediaBox lives near the front of almost every PDF; reading a
    // slice avoids pulling a multi-megabyte artwork file into memory.
    const head = await file.slice(0, 65536).text();
    const m = /\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)/.exec(
      head,
    );
    if (m !== null) {
      const width = Math.abs(Number.parseFloat(m[3] ?? "") - Number.parseFloat(m[1] ?? ""));
      const height = Math.abs(Number.parseFloat(m[4] ?? "") - Number.parseFloat(m[2] ?? ""));
      if (width > 50 && height > 50) return { width, height };
    }
  } catch {
    // Fall through to A4 — a wrong page size shifts placements
    // proportionally, which is recoverable; refusing the upload is not.
  }
  return A4_PT;
}

function readImageSize(
  file: File,
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * The server's own words, when it has any.
 *
 * The messages from `convex/certificates.ts` name the problem — a field
 * placed twice, a blank whose page size could not be read — and a
 * generic "check the form" would throw exactly that away.
 */
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

const inputClass =
  "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";
