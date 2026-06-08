"use client";

/**
 * /admin/expense-categories — admin manages the expense taxonomy
 * (Story 4.7, FR40).
 *
 * Admin-only. Middleware (`src/middleware.ts`) gates `/admin/*` at
 * the edge; `convex/expenseCategories.ts` re-enforces every call
 * server-side via `requireRole(ctx, ["admin"])` per NFR-S4 (defense
 * in depth).
 *
 * Reactive table of all categories (active + inactive) with four
 * flows:
 *   1. New category → dialog with `<ExpenseCategoryForm>` →
 *      `createExpenseCategory` mutation.
 *   2. Edit name / description → dialog with `<ExpenseCategoryForm>`
 *      in edit mode → `updateExpenseCategory`.
 *   3. Deactivate / Reactivate → inline confirmation →
 *      `setExpenseCategoryActive`.
 *   4. Delete → confirmation dialog (only available when
 *      `linkedExpenseCount === 0`) → `deleteExpenseCategory`.
 *
 * Because `convex/_generated/` is not yet built in this repo, we
 * reference Convex functions via `makeFunctionReference` (the same
 * pattern used by `/admin/users` and `/lots`).
 */

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatePillTransition } from "@/components/ui/StatePillTransition";
import {
  ExpenseCategoryForm,
  type ExpenseCategoryFormSubmitPayload,
} from "@/components/ExpenseCategoryForm";
import { translateError } from "@/lib/errors";

/** Mirror of the row shape returned by `api.expenseCategories.listExpenseCategories`. */
interface CategoryRow {
  _id: string;
  _creationTime: number;
  name: string;
  description?: string;
  isActive: boolean;
  createdAt: number;
  linkedExpenseCount: number;
}

const listCategoriesRef = makeFunctionReference<
  "query",
  { includeInactive?: boolean },
  CategoryRow[]
>("expenseCategories:listExpenseCategories");

const createCategoryRef = makeFunctionReference<
  "mutation",
  { name: string; description?: string },
  { categoryId: string }
>("expenseCategories:createExpenseCategory");

const updateCategoryRef = makeFunctionReference<
  "mutation",
  { categoryId: string; name?: string; description?: string },
  { categoryId: string }
>("expenseCategories:updateExpenseCategory");

const setActiveRef = makeFunctionReference<
  "mutation",
  { categoryId: string; isActive: boolean },
  { categoryId: string }
>("expenseCategories:setExpenseCategoryActive");

const deleteCategoryRef = makeFunctionReference<
  "mutation",
  { categoryId: string },
  { deleted: true }
>("expenseCategories:deleteExpenseCategory");

/**
 * Status-pill variant for active vs. inactive. Matches the
 * `/admin/users` page's mapping: `available` (green) for active,
 * `cancelled` (grey) for inactive.
 *
 * Story 5.9 — uses StatePillTransition so toggling a category's
 * active flag (which arrives via the reactive `listExpenseCategories`
 * query) animates both the 300ms colour crossfade on the pill and
 * the 600ms amber surround flash. Operators flipping rows in another
 * tab see the change land here with the standard motion language.
 */
function ActiveStatusBadge({ active }: { active: boolean }) {
  if (active) {
    return <StatePillTransition status="available" size="sm" />;
  }
  return <StatePillTransition status="cancelled" size="sm" />;
}

function formatDate(ms: number): string {
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
  }).format(new Date(ms));
}

export default function AdminExpenseCategoriesPage() {
  const categories = useQuery(listCategoriesRef, { includeInactive: true });
  const createCategory = useMutation(createCategoryRef);
  const updateCategory = useMutation(updateCategoryRef);
  const setActive = useMutation(setActiveRef);
  const deleteCategory = useMutation(deleteCategoryRef);

  const [newCategoryOpen, setNewCategoryOpen] = useState(false);
  const [editCategory, setEditCategory] = useState<CategoryRow | null>(null);
  const [activeConfirm, setActiveConfirm] = useState<{
    category: CategoryRow;
    nextActive: boolean;
  } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<CategoryRow | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const isLoading = categories === undefined;
  const isEmpty = categories !== undefined && categories.length === 0;

  const handleCreateSubmit = async (
    payload: ExpenseCategoryFormSubmitPayload,
  ): Promise<void> => {
    setActionError(null);
    await createCategory(payload);
    setNewCategoryOpen(false);
  };

  const handleEditSubmit = async (
    payload: ExpenseCategoryFormSubmitPayload,
  ): Promise<void> => {
    if (editCategory === null) return;
    setActionError(null);
    await updateCategory({
      categoryId: editCategory._id,
      name: payload.name,
      description: payload.description ?? "",
    });
    setEditCategory(null);
  };

  const handleSetActive = async (
    category: CategoryRow,
    nextActive: boolean,
  ): Promise<void> => {
    setActionError(null);
    try {
      await setActive({ categoryId: category._id, isActive: nextActive });
      setActiveConfirm(null);
    } catch (err) {
      const translated = translateError(err);
      setActionError(translated.detail);
      setActiveConfirm(null);
    }
  };

  const handleDelete = async (category: CategoryRow): Promise<void> => {
    setActionError(null);
    try {
      await deleteCategory({ categoryId: category._id });
      setDeleteConfirm(null);
    } catch (err) {
      const translated = translateError(err);
      setActionError(translated.detail);
      setDeleteConfirm(null);
    }
  };

  // Duplicate-name hint for the create dialog. Looks at the live
  // category list to spot a same-name conflict (case-insensitive)
  // before the server returns DUPLICATE_CATEGORY_NAME.
  const createDuplicateHint = (candidate: string): string | null => {
    if (categories === undefined) return null;
    const lowered = candidate.trim().toLowerCase();
    if (lowered.length === 0) return null;
    const hit = categories.find((c) => c.name.toLowerCase() === lowered);
    return hit ? hit.name : null;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Expense Categories
        </h1>
        <button
          type="button"
          onClick={() => setNewCategoryOpen(true)}
          className="rounded-md bg-[#1D5C4D] px-4 py-2 text-sm font-medium text-white hover:bg-[#144437]"
        >
          New category
        </button>
      </div>

      <p className="max-w-2xl text-sm text-slate-600">
        Manage the expense categories the office staff sees when
        recording operating expenses. Deactivating a category hides it
        from new entries but preserves the name on past expense
        records. Deleting is only allowed when no expense references
        the category.
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
          data-testid="expense-categories-loading"
          className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500"
        >
          Loading categories…
        </div>
      )}

      {isEmpty && (
        <div className="rounded-md border border-slate-200 bg-white p-8 text-center">
          <p className="text-sm text-slate-600">
            No expense categories defined yet. Click &quot;New
            category&quot; to add the first one. Until then, the office
            staff records expenses against the built-in defaults
            (Utilities, Maintenance, Supplies, Salaries, Other).
          </p>
        </div>
      )}

      {categories !== undefined && categories.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-[#F6F2EA] text-left font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8E8C85]">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Expenses</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {categories.map((c) => (
                <tr key={c._id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{c.name}</div>
                    {c.description !== undefined &&
                      c.description.length > 0 && (
                        <div className="mt-0.5 text-xs text-slate-500">
                          {c.description}
                        </div>
                      )}
                  </td>
                  <td className="px-4 py-3">
                    <ActiveStatusBadge active={c.isActive} />
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {c.linkedExpenseCount}
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {formatDate(c.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-3 text-sm">
                      <button
                        type="button"
                        onClick={() => setEditCategory(c)}
                        className="font-medium text-slate-900 hover:underline"
                      >
                        Edit
                      </button>
                      {c.isActive ? (
                        <button
                          type="button"
                          onClick={() =>
                            setActiveConfirm({
                              category: c,
                              nextActive: false,
                            })
                          }
                          className="font-medium text-red-600 hover:underline"
                        >
                          Deactivate
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            setActiveConfirm({
                              category: c,
                              nextActive: true,
                            })
                          }
                          className="font-medium text-emerald-700 hover:underline"
                        >
                          Reactivate
                        </button>
                      )}
                      {c.linkedExpenseCount === 0 ? (
                        <button
                          type="button"
                          onClick={() => setDeleteConfirm(c)}
                          className="font-medium text-red-700 hover:underline"
                        >
                          Delete
                        </button>
                      ) : (
                        <span
                          title="Cannot delete — expenses reference this category. Deactivate to hide from new entries while preserving history."
                          className="cursor-not-allowed text-slate-400"
                        >
                          Delete
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* New category dialog */}
      <Dialog open={newCategoryOpen} onOpenChange={setNewCategoryOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New category</DialogTitle>
            <DialogDescription>
              Create a new expense category. The office staff will see
              it in the expense form&apos;s dropdown immediately.
            </DialogDescription>
          </DialogHeader>
          <ExpenseCategoryForm
            mode="create"
            onSubmit={handleCreateSubmit}
            onCancel={() => setNewCategoryOpen(false)}
            duplicateName={null}
          />
          <NewCategoryDuplicateHint
            categories={categories ?? []}
            hint={createDuplicateHint}
          />
        </DialogContent>
      </Dialog>

      {/* Edit category dialog */}
      <Dialog
        open={editCategory !== null}
        onOpenChange={(open) => {
          if (!open) setEditCategory(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit category</DialogTitle>
            <DialogDescription>
              Update the category&apos;s name or description.
            </DialogDescription>
          </DialogHeader>
          {editCategory !== null && (
            <ExpenseCategoryForm
              mode="edit"
              defaultValues={{
                name: editCategory.name,
                description: editCategory.description ?? "",
              }}
              onSubmit={handleEditSubmit}
              onCancel={() => setEditCategory(null)}
              duplicateName={null}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Deactivate / reactivate confirmation */}
      <Dialog
        open={activeConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setActiveConfirm(null);
        }}
      >
        <DialogContent>
          {activeConfirm !== null && (
            <ActiveDialogBody
              category={activeConfirm.category}
              nextActive={activeConfirm.nextActive}
              onClose={() => setActiveConfirm(null)}
              onConfirm={() =>
                handleSetActive(
                  activeConfirm.category,
                  activeConfirm.nextActive,
                )
              }
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
            <DeleteDialogBody
              category={deleteConfirm}
              onClose={() => setDeleteConfirm(null)}
              onConfirm={() => handleDelete(deleteConfirm)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Inline duplicate-name hint shown beneath the create dialog's form.
 * Hidden in the form's own UI by passing `duplicateName={null}` and
 * checking through the parent's `useQuery`-driven list directly.
 *
 * NOTE: this is a pure presentational helper — it does not subscribe
 * to anything new. The reactive subscription lives on the page; the
 * hint just reads it.
 */
function NewCategoryDuplicateHint({
  categories,
  hint,
}: {
  categories: CategoryRow[];
  hint: (candidate: string) => string | null;
}) {
  // We don't have direct access to the form's input value here
  // without lifting state — the parent form already shows duplicate
  // hints via its own `duplicateName` prop, so this component is a
  // no-op placeholder for the moment. Kept as a hook for the
  // upcoming "live duplicate" enhancement (Story 4.7 Task 12's
  // checkNameAvailability query) so the wiring point exists.
  void categories;
  void hint;
  return null;
}

/**
 * Body of the deactivate / reactivate confirmation dialog.
 *
 * Deactivation is operationally low-stakes (the category is hidden
 * from new entries but historical references are preserved) — we
 * still confirm because the office staff's dropdown changes the
 * instant this runs. Reactivation is always safe and uses the same
 * pattern for consistency.
 */
function ActiveDialogBody({
  category,
  nextActive,
  onClose,
  onConfirm,
}: {
  category: CategoryRow;
  nextActive: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const isDeactivate = nextActive === false;
  const title = isDeactivate ? "Deactivate category" : "Reactivate category";
  const verbDescription = isDeactivate
    ? `Deactivate "${category.name}"? It will be hidden from new expense entries but remain on the ${category.linkedExpenseCount} expense record${category.linkedExpenseCount === 1 ? "" : "s"} that already reference it.`
    : `Reactivate "${category.name}"? Office staff will be able to pick it again in the expense form.`;
  const confirmLabel = isDeactivate ? "Deactivate" : "Reactivate";

  const handle = async (): Promise<void> => {
    setSubmitting(true);
    await onConfirm();
    setSubmitting(false);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{verbDescription}</DialogDescription>
      </DialogHeader>
      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handle}
          disabled={submitting}
          className={
            isDeactivate
              ? "rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              : "rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
          }
        >
          {submitting ? "Saving…" : confirmLabel}
        </button>
      </div>
    </>
  );
}

/**
 * Body of the delete confirmation dialog.
 *
 * Delete is irreversible, so the confirmation uses a Dialog (more
 * friction than an inline confirm) and surfaces the operational
 * consequence in clear language.
 */
function DeleteDialogBody({
  category,
  onClose,
  onConfirm,
}: {
  category: CategoryRow;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);

  const handle = async (): Promise<void> => {
    setSubmitting(true);
    await onConfirm();
    setSubmitting(false);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Delete category</DialogTitle>
        <DialogDescription>
          Delete &quot;{category.name}&quot;? This category will be
          permanently removed. This cannot be undone.
        </DialogDescription>
      </DialogHeader>
      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handle}
          disabled={submitting}
          className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "Deleting…" : "Delete"}
        </button>
      </div>
    </>
  );
}
