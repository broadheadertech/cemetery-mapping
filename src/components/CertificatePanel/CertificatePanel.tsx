"use client";

/**
 * The certificate of ownership on a contract.
 *
 * Three things happen here: generate one from the park's uploaded
 * blank, attach a finished one the office prepared by hand, and read
 * back what was issued and when.
 *
 * A replacement never overwrites. It supersedes, the reason goes on the
 * record, and the old one stays listed — somebody out there may be
 * holding a printed copy, and "what did we give them in March" has to
 * stay answerable.
 *
 * @gated-route-only — mounts on `/contracts/[contractId]`; middleware
 * keeps field workers off the `/contracts` family.
 */

import { useRef, useState, type ReactElement } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

// --- server surface ---------------------------------------------------

interface CertificateRow {
  _id: string;
  serial: string;
  source: "generated" | "uploaded";
  mimeType: string;
  issuedAt: number;
  note?: string;
  isSuperseded: boolean;
  supersededAt?: number;
  supersededReason?: string;
  url: string | null;
}

interface ContractCertificates {
  eligible: boolean;
  reason?: string;
  current: CertificateRow | null;
  history: CertificateRow[];
  templateReady: boolean;
}

const getCertificatesRef = makeFunctionReference<
  "query",
  { contractId: string },
  ContractCertificates
>("certificates:getContractCertificates");

const uploadUrlRef = makeFunctionReference<
  "mutation",
  Record<string, never>,
  string
>("certificates:generateCertificateUploadUrl");

const recordRef = makeFunctionReference<
  "mutation",
  {
    contractId: string;
    storageId: string;
    mimeType: string;
    source: "generated" | "uploaded";
    note?: string;
    supersedeReason?: string;
  },
  { certificateId: string; serial: string }
>("certificates:recordCertificate");

const issueRef = makeFunctionReference<
  "action",
  { contractId: string; supersedeReason?: string },
  { certificateId: string; serial: string; overflowed: string[] }
>("issueCertificate:issueCertificate");

export interface CertificatePanelProps {
  contractId: string;
}

export function CertificatePanel({
  contractId,
}: CertificatePanelProps): ReactElement {
  const state = useQuery(getCertificatesRef, { contractId });
  const getUploadUrl = useMutation(uploadUrlRef);
  const record = useMutation(recordRef);
  const issue = useAction(issueRef);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overflowed, setOverflowed] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  if (state === undefined || state === null) {
    return <p className="text-sm text-slate-500">Loading&hellip;</p>;
  }

  const replacing = state.current !== null;
  const reasonOk = !replacing || reason.trim().length >= 5;

  async function handleIssue(): Promise<void> {
    setBusy(true);
    setError(null);
    setOverflowed([]);
    try {
      const result = await issue({
        contractId,
        ...(replacing ? { supersedeReason: reason.trim() } : {}),
      });
      setOverflowed(result.overflowed);
      setReason("");
    } catch (e: unknown) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleUpload(): Promise<void> {
    const file = fileRef.current?.files?.[0];
    if (file === undefined) {
      setError("Choose a file first.");
      return;
    }
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
      await record({
        contractId,
        storageId,
        mimeType: file.type,
        source: "uploaded",
        ...(replacing ? { supersedeReason: reason.trim() } : {}),
      });
      setReason("");
      setShowUpload(false);
      if (fileRef.current !== null) fileRef.current.value = "";
    } catch (e: unknown) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid="certificate-panel"
      className="space-y-4 rounded-md border border-slate-200 bg-white p-5"
    >
      <h2 className="font-display text-2xl font-light">
        Certificate of ownership
      </h2>

      {!state.eligible && (
        <p
          data-testid="certificate-not-eligible"
          className="rounded-md border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-700"
        >
          {state.reason ??
            "Only a fully-paid contract can carry a certificate of ownership."}
        </p>
      )}

      {state.current !== null && (
        <div
          data-testid="certificate-current"
          className="rounded-md border border-emerald-300 bg-emerald-50 p-4"
        >
          <p className="font-mono text-sm text-emerald-900">
            {state.current.serial}
          </p>
          <p className="mt-1 text-sm text-emerald-900">
            Issued {formatDay(state.current.issuedAt)} &middot;{" "}
            {state.current.source === "generated"
              ? "filled from the park's template"
              : "uploaded by the office"}
          </p>
          {state.current.url !== null && (
            <a
              href={state.current.url}
              target="_blank"
              rel="noreferrer"
              data-testid="certificate-download"
              className="mt-2 inline-block rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
            >
              Open the certificate
            </a>
          )}
        </div>
      )}

      {state.eligible && (
        <div className="space-y-3">
          {replacing && (
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium text-slate-700">
                Why is it being replaced?
              </span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Name corrected on the family's request"
                data-testid="certificate-supersede-reason"
                className={inputClass}
              />
              <span className="text-xs text-slate-500">
                Goes on the record beside the one being withdrawn. The
                old certificate is kept, not deleted.
              </span>
            </label>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !state.templateReady || !reasonOk}
              data-testid="certificate-issue"
              onClick={() => void handleIssue()}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:bg-slate-300"
            >
              {busy
                ? "Working…"
                : replacing
                  ? "Issue a replacement"
                  : "Issue the certificate"}
            </button>
            <button
              type="button"
              disabled={busy}
              data-testid="certificate-upload-toggle"
              onClick={() => setShowUpload((v) => !v)}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              {showUpload ? "Cancel" : "Attach one instead"}
            </button>
          </div>

          {!state.templateReady && (
            <p
              data-testid="certificate-no-template"
              className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
            >
              No certificate blank has been set up yet, so there is
              nothing to fill in. An administrator can upload the
              park&rsquo;s design under Certificate of ownership &mdash;
              or attach a finished certificate here by hand.
            </p>
          )}

          {showUpload && (
            <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm text-slate-700">
                For a certificate prepared outside the system &mdash; a
                reissue, a court-ordered wording, or a signed original
                the family brought back to be scanned.
              </p>
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                data-testid="certificate-file"
                className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:text-white"
              />
              <button
                type="button"
                disabled={busy || !reasonOk}
                data-testid="certificate-upload-submit"
                onClick={() => void handleUpload()}
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:bg-slate-300"
              >
                {busy ? "Uploading…" : "Attach it"}
              </button>
            </div>
          )}
        </div>
      )}

      {overflowed.length > 0 && (
        <p
          role="alert"
          data-testid="certificate-overflow"
          className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          The certificate was made, but{" "}
          {overflowed.length === 1 ? "one detail" : "some details"} would
          not fit the space allowed and had to be shrunk to the smallest
          readable size: {overflowed.join(", ")}. Check it before giving
          it to the family &mdash; the template may need more room there.
        </p>
      )}

      {error !== null && (
        <p
          role="alert"
          data-testid="certificate-error"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900"
        >
          {error}
        </p>
      )}

      {state.history.length > 0 && (
        <details data-testid="certificate-history">
          <summary className="cursor-pointer text-sm text-slate-600">
            {state.history.length} withdrawn certificate
            {state.history.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 space-y-2">
            {state.history.map((h) => (
              <li
                key={h._id}
                className="rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-sm"
              >
                <span className="font-mono text-xs text-slate-600">
                  {h.serial}
                </span>
                <span className="ml-2 text-slate-600">
                  issued {formatDay(h.issuedAt)}
                  {h.supersededAt !== undefined &&
                    `, withdrawn ${formatDay(h.supersededAt)}`}
                </span>
                {h.supersededReason !== undefined && (
                  <p className="mt-0.5 text-xs text-slate-500">
                    {h.supersededReason}
                  </p>
                )}
                {h.url !== null && (
                  <a
                    href={h.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-block text-xs font-medium text-slate-700 underline"
                  >
                    Open
                  </a>
                )}
              </li>
            ))}
          </ul>
        </details>
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

/** The server's own words — its messages name the actual problem. */
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
