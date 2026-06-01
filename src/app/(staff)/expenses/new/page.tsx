"use client";

/**
 * /expenses/new — Office Staff records an operating expense (Story 4.6).
 *
 * Client component that hosts the `ExpenseForm`. Pulls the active
 * category list + placeholder sentinel via
 * `api.expenses.getActiveCategoriesForForm`, wires the two-step photo
 * upload to `generateExpensePhotoUploadUrl`, and submits via
 * `recordExpense`. On success, routes back to `/expenses` — the new row
 * shows up there with a 600ms amber flash via the list page's
 * `ReactiveHighlight` wrapper.
 *
 * Auth: the (staff) layout's `requireAuth` gate (Story 1.1 + 1.2)
 * protects this route. Per-role enforcement (`office_staff` / `admin`)
 * lives inside the underlying Convex mutation.
 *
 * `makeFunctionReference` keeps this file typecheck-clean before
 * `npx convex dev` regenerates `convex/_generated/api.ts`. Once codegen
 * runs the references can be swapped for typed `api.*` imports.
 */

import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { ExpenseForm, type ExpenseSubmitPayload } from "@/components/ExpenseForm";
import { translateError } from "@/lib/errors";
import { useNetworkAwareMutation } from "@/hooks/useNetworkAwareMutation";
import { useNetworkState } from "@/hooks/useNetworkState";

const getActiveCategoriesForFormRef = makeFunctionReference<
  "query",
  Record<string, never>,
  { categories: readonly string[]; isPlaceholder: boolean }
>("expenses:getActiveCategoriesForForm");

const generateExpensePhotoUploadUrlRef = makeFunctionReference<
  "mutation",
  Record<string, never>,
  string
>("expenses:generateExpensePhotoUploadUrl");

const recordExpenseRef = makeFunctionReference<
  "mutation",
  {
    paidAt: number;
    amountCents: number;
    vendor: string;
    category: string;
    photoStorageId?: string;
    idempotencyKey?: string;
  },
  { expenseId: string }
>("expenses:recordExpense");

const getCurrentUserOrNullRef = makeFunctionReference<
  "query",
  Record<string, never>,
  { roles: string[] } | null
>("lib/auth:getCurrentUserOrNull");

export default function NewExpensePage() {
  const router = useRouter();
  const categoriesData = useQuery(getActiveCategoriesForFormRef, {});
  const me = useQuery(getCurrentUserOrNullRef, {});
  const network = useNetworkState();
  const isOnline = network !== "offline";

  // `useNetworkAwareMutation` blocks the call when offline, throwing
  // OFFLINE_WRITE_BLOCKED before the request hits the wire (Story 1.13).
  // We also gate the form's submit button on `isOnline` for the same
  // semantics in the UI affordance.
  const generateUploadUrl = useNetworkAwareMutation(
    generateExpensePhotoUploadUrlRef,
  );
  const recordExpense = useNetworkAwareMutation(recordExpenseRef);

  const categories = categoriesData?.categories ?? [];
  const isPlaceholder = categoriesData?.isPlaceholder ?? true;
  const callerRoles = me?.roles ?? [];

  async function handleUploadUrl(): Promise<string> {
    return await generateUploadUrl({});
  }

  async function handleSubmit(payload: ExpenseSubmitPayload): Promise<void> {
    try {
      await recordExpense({
        paidAt: payload.paidAt,
        amountCents: payload.amountCents,
        vendor: payload.vendor,
        category: payload.category,
        photoStorageId: payload.photoStorageId,
        idempotencyKey: payload.idempotencyKey,
      });
      router.push("/expenses");
    } catch (err) {
      // Re-throw so ExpenseForm can translate + show the error inline.
      // Avoid swallowing here — that would leave the user with a stuck
      // "Recording…" button and no message.
      // (translateError is used by the form's catch.)
      void translateError(err);
      throw err;
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Record expense</h1>
          <p className="mt-1 text-sm text-slate-600">
            Track an operating expense for the cemetery. Receipt photo
            optional.
          </p>
        </div>
        <button
          type="button"
          onClick={() => router.push("/expenses")}
          className="min-h-[44px] rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>

      {categoriesData === undefined ? (
        <div
          data-testid="expense-form-loading"
          className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500"
        >
          Loading form…
        </div>
      ) : (
        <ExpenseForm
          categories={categories}
          isPlaceholderCategories={isPlaceholder}
          callerRoles={callerRoles}
          isOnline={isOnline}
          generateUploadUrl={handleUploadUrl}
          onSubmit={handleSubmit}
          onCancel={() => router.push("/expenses")}
        />
      )}
    </div>
  );
}
