"use client";

/**
 * /sales/new — record a full-payment sale (Story 3.3, FR19).
 *
 * Thin wrapper around `<SaleForm />`. The form owns the
 * `contracts.recordFullPaymentSale` mutation call AND the post-success
 * redirect to `/contracts/[contractId]`. This page provides the page
 * heading + intro copy + role-aware prop hydration.
 *
 * Auth: the (staff) layout's server-side `requireAuth` gate (Story 1.1
 * + 1.2) protects this route. Per-role enforcement (`office_staff` /
 * `admin`) lives inside `recordFullPaymentSale` itself — a field_worker
 * who navigates here will see the form render but receive a FORBIDDEN
 * translation on submit. Defense-in-depth pattern from Story 1.2.
 *
 * Role hydration: we fetch the current user via the existing
 * `lib/auth:getCurrentUserOrNull` query so the form can gate the
 * admin-only price-edit affordance UI-side. The server still enforces
 * the actual sale flow; the UI gate is purely for defensive UX.
 */

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { SaleForm } from "@/components/SaleForm";

interface AuthPayload {
  userId: string;
  user: { name?: string; email?: string };
  roles: string[];
}

const getCurrentUserOrNullRef = makeFunctionReference<
  "query",
  Record<string, never>,
  AuthPayload | null
>("lib/auth:getCurrentUserOrNull");

function NewSaleContent() {
  const me = useQuery(getCurrentUserOrNullRef, {});
  const roles: ReadonlyArray<string> = me?.roles ?? [];
  // Deep-link: "Start sale" from a lot's detail page / the map arrives as
  // `/sales/new?lotId=…` and the SaleForm pre-selects that lot.
  const searchParams = useSearchParams();
  const initialLotId = searchParams.get("lotId") ?? undefined;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="font-display text-4xl font-semibold tracking-tight">New sale</h1>
      <p className="text-sm text-slate-600">
        Pick an available lot, pick or create the customer, then review the
        receipt preview before generating. The receipt serial is allocated at
        commit time and cannot be re-issued.
      </p>
      <SaleForm userRoles={roles} initialLotId={initialLotId} />
    </div>
  );
}

export default function NewSalePage() {
  // `useSearchParams` requires a Suspense boundary (Next.js App Router).
  return (
    <Suspense fallback={null}>
      <NewSaleContent />
    </Suspense>
  );
}
