"use client";

/**
 * /customers/new — create a new customer (Story 2.1).
 *
 * Thin wrapper around `<CustomerForm />`. The form owns the
 * `customers.create` mutation call AND the post-success redirect
 * to `/customers/<customerId>`. This page only:
 *   - Provides the page heading + intro copy.
 *   - Wires a Cancel button back to `/dashboard` (the customer list
 *     page doesn't exist in this story — Story 2.5 lands it; the
 *     dashboard is the safe fallback).
 *
 * Auth: the (staff) layout's server-side `requireAuth` gate (Story
 * 1.1 + 1.2) protects this route. Per-role enforcement
 * (`office_staff` / `admin`) lives inside `customers.create` —
 * which is the only mutation this page calls — so a `field_worker`
 * who navigates here will see the form render but receive a
 * FORBIDDEN translation when they try to submit. That's the
 * defense-in-depth pattern from Story 1.2 ADR-0002.
 */

import { useRouter } from "next/navigation";

import { CustomerForm } from "@/components/CustomerForm";

export default function NewCustomerPage() {
  const router = useRouter();
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">New Customer</h1>
      <p className="text-sm text-slate-600">
        Record a new customer with their contact details, address, and
        government ID. Capturing Data Privacy Act consent is required before
        ID scans can be attached (Story 2.2).
      </p>
      <CustomerForm onCancel={() => router.push("/dashboard")} />
    </div>
  );
}
