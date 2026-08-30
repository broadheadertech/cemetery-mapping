"use client";

/**
 * /certificates — families who have finished paying and have nothing
 * to show for it yet.
 *
 * This is the other half of "tell the client when they are fully paid".
 * A notification with no work list behind it is a message nobody acts
 * on; this is the list the office works through, and it empties itself
 * as certificates are issued.
 *
 * Deliberately not a dashboard tile. A family who settled in March and
 * is still waiting is not a statistic — they are a row with a name on
 * it and a button beside it.
 */

import { type ReactElement } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { formatPeso } from "@/lib/money";

interface AwaitingRow {
  contractId: string;
  contractNumber: string;
  customerName: string;
  lotCode: string;
  totalPriceCents: number;
}

const listAwaitingRef = makeFunctionReference<
  "query",
  { limit?: number },
  AwaitingRow[]
>("certificates:listAwaitingCertificate");

interface TemplateRow {
  _id: string;
  fields: Array<{ key: string }>;
}

const getTemplateRef = makeFunctionReference<
  "query",
  Record<string, never>,
  TemplateRow | null
>("certificates:getActiveTemplate");

export default function CertificatesPage(): ReactElement {
  const rows = useQuery(listAwaitingRef, {});
  const template = useQuery(getTemplateRef, {});
  const templateReady =
    template !== undefined && template !== null && template.fields.length > 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Certificates to issue
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Contracts that have been paid in full and have no certificate of
          ownership yet. Each one is a family owed a document.
        </p>
      </header>

      {template !== undefined && !templateReady && (
        <p
          data-testid="certificates-no-template"
          className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          No certificate blank has been set up, so nothing can be filled
          in automatically. An administrator can upload the park&rsquo;s
          design under{" "}
          <Link
            href="/admin/settings/certificate"
            className="font-medium underline"
          >
            Certificate of ownership
          </Link>
          . A finished certificate can still be attached to any contract
          by hand in the meantime.
        </p>
      )}

      {rows === undefined ? (
        <p className="text-sm text-slate-500">Looking&hellip;</p>
      ) : rows.length === 0 ? (
        <p
          data-testid="certificates-empty"
          className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
        >
          Nobody is waiting. Every fully-paid contract has its certificate.
        </p>
      ) : (
        <>
          <p className="text-sm text-slate-600">
            {rows.length} famil{rows.length === 1 ? "y is" : "ies are"}{" "}
            waiting.
          </p>
          <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-2 font-medium">Owner</th>
                  <th className="px-4 py-2 font-medium">Lot</th>
                  <th className="px-4 py-2 font-medium">Contract</th>
                  <th className="px-4 py-2 text-right font-medium">Paid</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.contractId} data-testid="certificates-row">
                    <td className="px-4 py-2.5 text-slate-900">
                      {r.customerName}
                    </td>
                    <td className="px-4 py-2.5 text-slate-700">{r.lotCode}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-600">
                      {r.contractNumber}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                      {formatPeso(r.totalPriceCents)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Link
                        href={`/contracts/${r.contractId}`}
                        className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                      >
                        Issue
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
