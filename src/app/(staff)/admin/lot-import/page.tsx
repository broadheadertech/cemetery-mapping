"use client";

/**
 * /admin/lot-import — legacy lot-inventory import (Q4).
 *
 * The counterpart to `/admin/gps-import`: that page attaches surveyed
 * geometry to lots that already exist, this one gets the lots here in
 * the first place. Together they cover the migration path from paper
 * and Excel to a live inventory.
 *
 * Admin-only twice over — middleware gates `/admin/*` on the `admin`
 * role, and `convex/lotImport.ts` calls `requireRole(["admin"])` inside
 * both the preview query and the import mutation. NFR-S4 requires the
 * server-side half; the middleware is convenience.
 *
 * Scope note worth repeating to whoever runs this: lots only. Owners,
 * contracts, and payment history are re-recorded through the normal
 * sale flow as customers come in to verify (client decision Q4), so
 * every peso in the ledger has a contract and a receipt behind it.
 */

import { LotImportPanel } from "@/components/LotImport";

export default function AdminLotImportPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Lot inventory import
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Load the cemetery&rsquo;s lot inventory from a spreadsheet. Check the
          file against the database first — the check writes nothing and tells
          you exactly which rows would land and which need fixing. Import in
          section-sized batches and verify each one before moving on.
        </p>
      </header>

      <LotImportPanel />
    </div>
  );
}
