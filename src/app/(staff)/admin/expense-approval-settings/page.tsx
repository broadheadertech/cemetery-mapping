"use client";

/**
 * /admin/expense-approval-settings — admin configures the per-category
 * expense approval thresholds (Story 6.6, FR41).
 *
 * Admin-only. Middleware (`src/middleware.ts`) gates `/admin/*` at
 * the edge; `convex/expenseApprovalSettings.ts` re-enforces every
 * call server-side via `requireRole(ctx, ["admin"])` (NFR-S4).
 *
 * Reactive table of every configured threshold (default sentinel +
 * per-category rows) with four flows:
 *   1. Edit default → dialog with `<ExpenseApprovalSettingsForm
 *      mode="default">` → `setDefaultExpenseApprovalSetting`.
 *   2. Add per-category → dialog with `mode="create"` →
 *      `setExpenseApprovalSetting`.
 *   3. Edit per-category → dialog with `mode="edit"` →
 *      `setExpenseApprovalSetting`.
 *   4. Delete per-category → confirmation dialog →
 *      `deleteExpenseApprovalSetting`. The default sentinel cannot
 *      be deleted (the form disables the delete affordance).
 *
 * Because `convex/_generated/` is not yet built in this repo, we
 * reference Convex functions via `makeFunctionReference` (the same
 * pattern used by `/admin/expense-categories`).
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ExpenseApprovalSettingsForm,
  type ExpenseApprovalSettingsFormSubmitPayload,
  type ExpenseApprovalSettingsFormValues,
} from "@/components/ExpenseApprovalSettingsForm";
import { translateError } from "@/lib/errors";

/** Mirror of `DEFAULT_CATEGORY_SENTINEL` in convex/expenseApprovalSettings.ts. */
const DEFAULT_CATEGORY_SENTINEL = "__default__";

/** Mirror of the row shape returned by `listExpenseApprovalSettings`. */
interface ApprovalSettingRow {
  _id: string | null;
  category: string;
  thresholdCents: number;
  requiresApproval: boolean;
  updatedAt: number | null;
  isDefault: boolean;
}

interface ApprovalSettingsResult {
  settings: ApprovalSettingRow[];
}

interface CategoryRow {
  _id: string;
  name: string;
  isActive: boolean;
}

const listSettingsRef = makeFunctionReference<
  "query",
  Record<string, never>,
  ApprovalSettingsResult
>("expenseApprovalSettings:listExpenseApprovalSettings");

const setSettingRef = makeFunctionReference<
  "mutation",
  { category: string; thresholdCents: number; requiresApproval: boolean },
  { settingId: string }
>("expenseApprovalSettings:setExpenseApprovalSetting");

const setDefaultSettingRef = makeFunctionReference<
  "mutation",
  { thresholdCents: number; requiresApproval: boolean },
  { settingId: string }
>("expenseApprovalSettings:setDefaultExpenseApprovalSetting");

const deleteSettingRef = makeFunctionReference<
  "mutation",
  { settingId: string },
  { deleted: true }
>("expenseApprovalSettings:deleteExpenseApprovalSetting");

const listCategoriesRef = makeFunctionReference<
  "query",
  { includeInactive?: boolean },
  CategoryRow[]
>("expenseCategories:listExpenseCategories");

function formatPeso(cents: number): string {
  const pesos = cents / 100;
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    maximumFractionDigits: 0,
  }).format(pesos);
}

function formatDate(ms: number | null): string {
  if (ms === null) return "—";
  return new Intl.DateTimeFormat("en-PH", { dateStyle: "medium" }).format(
    new Date(ms),
  );
}

function categoryDisplayName(row: ApprovalSettingRow): string {
  return row.isDefault ? "Default (all uncategorised)" : row.category;
}

export default function AdminExpenseApprovalSettingsPage() {
  const settingsResult = useQuery(listSettingsRef, {});
  const categoriesResult = useQuery(listCategoriesRef, {
    includeInactive: false,
  });
  const setSetting = useMutation(setSettingRef);
  const setDefaultSetting = useMutation(setDefaultSettingRef);
  const deleteSetting = useMutation(deleteSettingRef);

  const [defaultDialogOpen, setDefaultDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editRow, setEditRow] = useState<ApprovalSettingRow | null>(null);
  const [deleteConfirm, setDeleteConfirm] =
    useState<ApprovalSettingRow | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const isLoading = settingsResult === undefined;
  const rows = settingsResult?.settings ?? [];
  const defaultRow = rows.find((r) => r.isDefault) ?? null;
  const categoryRows = rows.filter((r) => !r.isDefault);

  const categoryNames = useMemo<readonly string[]>(() => {
    if (categoriesResult === undefined) return [];
    const configured = new Set(categoryRows.map((r) => r.category));
    return categoriesResult
      .map((c) => c.name)
      .filter((name) => !configured.has(name));
  }, [categoriesResult, categoryRows]);

  const handleDefaultSubmit = async (
    payload: ExpenseApprovalSettingsFormSubmitPayload,
  ): Promise<void> => {
    setActionError(null);
    await setDefaultSetting({
      thresholdCents: payload.thresholdCents,
      requiresApproval: payload.requiresApproval,
    });
    setDefaultDialogOpen(false);
  };

  const handleCreateSubmit = async (
    payload: ExpenseApprovalSettingsFormSubmitPayload,
  ): Promise<void> => {
    setActionError(null);
    if (payload.category === DEFAULT_CATEGORY_SENTINEL) {
      throw Object.assign(new Error("validation"), {
        data: { code: "VALIDATION" },
      });
    }
    await setSetting(payload);
    setCreateDialogOpen(false);
  };

  const handleEditSubmit = async (
    payload: ExpenseApprovalSettingsFormSubmitPayload,
  ): Promise<void> => {
    if (editRow === null) return;
    setActionError(null);
    await setSetting({
      category: editRow.category,
      thresholdCents: payload.thresholdCents,
      requiresApproval: payload.requiresApproval,
    });
    setEditRow(null);
  };

  const handleDelete = async (row: ApprovalSettingRow): Promise<void> => {
    setActionError(null);
    if (row._id === null) {
      setDeleteConfirm(null);
      return;
    }
    try {
      await deleteSetting({ settingId: row._id });
      setDeleteConfirm(null);
    } catch (err) {
      const translated = translateError(err);
      setActionError(translated.detail);
      setDeleteConfirm(null);
    }
  };

  const defaultFormValues: ExpenseApprovalSettingsFormValues = {
    category: DEFAULT_CATEGORY_SENTINEL,
    thresholdPesos: Math.round((defaultRow?.thresholdCents ?? 0) / 100),
    requiresApproval: defaultRow?.requiresApproval ?? false,
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">
          Expense Approval Settings
        </h1>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setDefaultDialogOpen(true)}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Edit default
          </button>
          <button
            type="button"
            onClick={() => setCreateDialogOpen(true)}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            Add category override
          </button>
        </div>
      </div>

      <div
        role="note"
        className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
      >
        Approval workflow pending client confirmation (§10 Q9).
        Defaults to OFF — expenses are auto-approved until an admin
        toggles a category here.
      </div>

      <p className="max-w-2xl text-sm text-slate-600">
        Configure the approval thresholds the office staff sees when
        recording operating expenses. Expenses at or above the
        per-category threshold (or the default, when no override
        exists) require admin approval. When a category is set to
        &quot;Auto-approve all&quot;, the threshold is ignored.
      </p>

      {actionError !== null && (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {actionError}
        </div>
      )}

      {isLoading && (
        <div
          data-testid="expense-approval-settings-loading"
          className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500"
        >
          Loading settings…
        </div>
      )}

      {!isLoading && (
        <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Requires approval</th>
                <th className="px-4 py-3">Threshold</th>
                <th className="px-4 py-3">Updated</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {defaultRow !== null && (
                <tr
                  key="__default__"
                  className="bg-amber-50 hover:bg-amber-100"
                  data-testid="approval-settings-default-row"
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">
                      {categoryDisplayName(defaultRow)}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      Applied when no per-category override exists
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {defaultRow.requiresApproval ? "Yes" : "No"}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {defaultRow.requiresApproval
                      ? formatPeso(defaultRow.thresholdCents)
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {formatDate(defaultRow.updatedAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-3 text-sm">
                      <button
                        type="button"
                        onClick={() => setDefaultDialogOpen(true)}
                        className="font-medium text-slate-900 hover:underline"
                      >
                        Edit
                      </button>
                      <span
                        title="The default setting cannot be deleted. Use Edit to disable approval entirely."
                        className="cursor-not-allowed text-slate-400"
                      >
                        Delete
                      </span>
                    </div>
                  </td>
                </tr>
              )}
              {categoryRows.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-6 text-center text-sm text-slate-500"
                  >
                    No per-category overrides yet. The default setting
                    applies to all expenses.
                  </td>
                </tr>
              )}
              {categoryRows.map((row) => (
                <tr key={row._id ?? row.category} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">
                      {row.category}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {row.requiresApproval ? "Yes" : "No"}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {row.requiresApproval ? formatPeso(row.thresholdCents) : "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {formatDate(row.updatedAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-3 text-sm">
                      <button
                        type="button"
                        onClick={() => setEditRow(row)}
                        className="font-medium text-slate-900 hover:underline"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteConfirm(row)}
                        className="font-medium text-red-700 hover:underline"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit default dialog */}
      <Dialog open={defaultDialogOpen} onOpenChange={setDefaultDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit default approval setting</DialogTitle>
            <DialogDescription>
              The default setting applies to every expense category
              that does not have a per-category override.
            </DialogDescription>
          </DialogHeader>
          <ExpenseApprovalSettingsForm
            mode="default"
            defaultValues={defaultFormValues}
            onSubmit={handleDefaultSubmit}
            onCancel={() => setDefaultDialogOpen(false)}
          />
        </DialogContent>
      </Dialog>

      {/* Create category override dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add category approval setting</DialogTitle>
            <DialogDescription>
              Override the default for a specific expense category.
            </DialogDescription>
          </DialogHeader>
          <ExpenseApprovalSettingsForm
            mode="create"
            categorySuggestions={categoryNames}
            onSubmit={handleCreateSubmit}
            onCancel={() => setCreateDialogOpen(false)}
          />
        </DialogContent>
      </Dialog>

      {/* Edit category override dialog */}
      <Dialog
        open={editRow !== null}
        onOpenChange={(open) => {
          if (!open) setEditRow(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit approval setting</DialogTitle>
            <DialogDescription>
              Update the threshold for this category.
            </DialogDescription>
          </DialogHeader>
          {editRow !== null && (
            <ExpenseApprovalSettingsForm
              mode="edit"
              defaultValues={{
                category: editRow.category,
                thresholdPesos: Math.round(editRow.thresholdCents / 100),
                requiresApproval: editRow.requiresApproval,
              }}
              onSubmit={handleEditSubmit}
              onCancel={() => setEditRow(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog
        open={deleteConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteConfirm(null);
        }}
      >
        <DialogContent>
          {deleteConfirm !== null && (
            <>
              <DialogHeader>
                <DialogTitle>Delete approval setting</DialogTitle>
                <DialogDescription>
                  Remove the &quot;{deleteConfirm.category}&quot;
                  override? The category will fall back to the default
                  setting.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setDeleteConfirm(null)}
                  className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(deleteConfirm)}
                  className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800"
                >
                  Delete
                </button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
