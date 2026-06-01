"use client";

/**
 * /admin/sections — admin manages the named-sections registry
 * (Story 1.15, FR3 brand-tier extension).
 *
 * Admin-only. Middleware (`src/middleware.ts`) gates `/admin/*` at
 * the edge; `convex/sections.ts` re-enforces every call server-side
 * via `requireRole(ctx, ["admin"])` per NFR-S4 (defense in depth).
 *
 * Reactive table of all sections (active + retired) with four flows:
 *   1. New section → dialog with `<SectionForm>` → `createSection`
 *      mutation.
 *   2. Edit name / displayName / sortOrder / kind / description →
 *      dialog with `<SectionForm>` in edit mode → `updateSection`.
 *   3. Retire / Restore → inline confirmation → `updateSection`
 *      with `{ isRetired: true|false }`.
 *   4. Delete → confirmation dialog (only available when
 *      `linkedLotCount === 0`) → `deleteSection`.
 *
 * Mirrors the Story 4.7 `/admin/expense-categories` pattern. Because
 * `convex/_generated/` is not built in this repo, we reference
 * Convex functions via `makeFunctionReference`.
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
  SectionForm,
  type SectionFormSubmitPayload,
  type SectionFormValues,
  type SectionKind,
} from "@/components/SectionForm";
import { translateError } from "@/lib/errors";

/** Mirror of the row shape returned by `api.sections.listSections`. */
interface SectionRow {
  _id: string;
  _creationTime: number;
  name: string;
  displayName: string;
  sortOrder: number;
  kind: SectionKind;
  descriptionMarkdown?: string;
  isRetired: boolean;
  createdAt: number;
  linkedLotCount: number;
}

const listSectionsRef = makeFunctionReference<
  "query",
  { includeRetired?: boolean },
  SectionRow[]
>("sections:listSections");

const createSectionRef = makeFunctionReference<
  "mutation",
  {
    name: string;
    displayName: string;
    sortOrder: number;
    kind: SectionKind;
    descriptionMarkdown?: string;
  },
  { sectionId: string }
>("sections:createSection");

const updateSectionRef = makeFunctionReference<
  "mutation",
  {
    sectionId: string;
    patch: {
      name?: string;
      displayName?: string;
      sortOrder?: number;
      kind?: SectionKind;
      descriptionMarkdown?: string;
      isRetired?: boolean;
    };
  },
  { sectionId: string }
>("sections:updateSection");

const deleteSectionRef = makeFunctionReference<
  "mutation",
  { sectionId: string },
  { deleted: true }
>("sections:deleteSection");

function RetiredStatusBadge({ retired }: { retired: boolean }) {
  if (retired) {
    return <StatePillTransition status="cancelled" size="sm" />;
  }
  return <StatePillTransition status="available" size="sm" />;
}

function formatDate(ms: number): string {
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
  }).format(new Date(ms));
}

export default function AdminSectionsPage() {
  const sections = useQuery(listSectionsRef, { includeRetired: true });
  const createSection = useMutation(createSectionRef);
  const updateSection = useMutation(updateSectionRef);
  const deleteSection = useMutation(deleteSectionRef);

  const [newSectionOpen, setNewSectionOpen] = useState(false);
  const [editSection, setEditSection] = useState<SectionRow | null>(null);
  const [retireConfirm, setRetireConfirm] = useState<{
    section: SectionRow;
    nextRetired: boolean;
  } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<SectionRow | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const isLoading = sections === undefined;
  const isEmpty = sections !== undefined && sections.length === 0;

  const handleCreateSubmit = async (
    payload: SectionFormSubmitPayload,
  ): Promise<void> => {
    setActionError(null);
    await createSection(payload);
    setNewSectionOpen(false);
  };

  const handleEditSubmit = async (
    payload: SectionFormSubmitPayload,
  ): Promise<void> => {
    if (editSection === null) return;
    setActionError(null);
    await updateSection({
      sectionId: editSection._id,
      patch: {
        name: payload.name,
        displayName: payload.displayName,
        sortOrder: payload.sortOrder,
        kind: payload.kind,
        descriptionMarkdown: payload.descriptionMarkdown ?? "",
      },
    });
    setEditSection(null);
  };

  const handleSetRetired = async (
    section: SectionRow,
    nextRetired: boolean,
  ): Promise<void> => {
    setActionError(null);
    try {
      await updateSection({
        sectionId: section._id,
        patch: { isRetired: nextRetired },
      });
      setRetireConfirm(null);
    } catch (err) {
      const translated = translateError(err);
      setActionError(translated.detail);
      setRetireConfirm(null);
    }
  };

  const handleDelete = async (section: SectionRow): Promise<void> => {
    setActionError(null);
    try {
      await deleteSection({ sectionId: section._id });
      setDeleteConfirm(null);
    } catch (err) {
      const translated = translateError(err);
      setActionError(translated.detail);
      setDeleteConfirm(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Sections</h1>
        <button
          type="button"
          onClick={() => setNewSectionOpen(true)}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          New section
        </button>
      </div>

      <p className="max-w-2xl text-sm text-slate-600">
        Maintain the registry of named cemetery sections that families
        see on signage and in correspondence. The lot create / edit
        form picks from this list. Retired sections stay visible
        everywhere they are already referenced, but new lots can no
        longer be assigned to them.
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
          data-testid="sections-loading"
          className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500"
        >
          Loading sections…
        </div>
      )}

      {isEmpty && (
        <div className="rounded-md border border-slate-200 bg-white p-8 text-center">
          <p className="text-sm text-slate-600">
            No sections defined yet. Click &quot;New section&quot; to
            add the first wayfinding-grade name (e.g. &quot;Chapel of
            Grace&quot;, &quot;Section A · North&quot;,
            &quot;Columbarium&quot;).
          </p>
        </div>
      )}

      {sections !== undefined && sections.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Display name</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Kind</th>
                <th className="px-4 py-3">Sort</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Lots</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sections.map((s) => (
                <tr key={s._id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">
                      {s.displayName}
                    </div>
                    {s.descriptionMarkdown !== undefined &&
                      s.descriptionMarkdown.length > 0 && (
                        <div className="mt-0.5 line-clamp-2 text-xs text-slate-500">
                          {s.descriptionMarkdown}
                        </div>
                      )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">
                    {s.name}
                  </td>
                  <td className="px-4 py-3 capitalize text-slate-700">
                    {s.kind}
                  </td>
                  <td className="px-4 py-3 text-slate-500">{s.sortOrder}</td>
                  <td className="px-4 py-3">
                    <RetiredStatusBadge retired={s.isRetired} />
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {s.linkedLotCount}
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {formatDate(s.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-3 text-sm">
                      <button
                        type="button"
                        onClick={() => setEditSection(s)}
                        className="font-medium text-slate-900 hover:underline"
                      >
                        Edit
                      </button>
                      {s.isRetired ? (
                        <button
                          type="button"
                          onClick={() =>
                            setRetireConfirm({
                              section: s,
                              nextRetired: false,
                            })
                          }
                          className="font-medium text-emerald-700 hover:underline"
                        >
                          Restore
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            setRetireConfirm({
                              section: s,
                              nextRetired: true,
                            })
                          }
                          className="font-medium text-red-600 hover:underline"
                        >
                          Retire
                        </button>
                      )}
                      {s.linkedLotCount === 0 ? (
                        <button
                          type="button"
                          onClick={() => setDeleteConfirm(s)}
                          className="font-medium text-red-700 hover:underline"
                        >
                          Delete
                        </button>
                      ) : (
                        <span
                          title="Cannot delete — lots reference this section. Retire to hide from new entries while preserving history."
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

      {/* New section dialog */}
      <Dialog open={newSectionOpen} onOpenChange={setNewSectionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New section</DialogTitle>
            <DialogDescription>
              Create a new named section. It will appear in the lot
              create / edit dropdown immediately.
            </DialogDescription>
          </DialogHeader>
          <SectionForm
            mode="create"
            onSubmit={handleCreateSubmit}
            onCancel={() => setNewSectionOpen(false)}
          />
        </DialogContent>
      </Dialog>

      {/* Edit section dialog */}
      <Dialog
        open={editSection !== null}
        onOpenChange={(open) => {
          if (!open) setEditSection(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit section</DialogTitle>
            <DialogDescription>
              Update the section&apos;s display name, sort order, kind,
              or description.
            </DialogDescription>
          </DialogHeader>
          {editSection !== null && (
            <SectionForm
              mode="edit"
              defaultValues={
                {
                  name: editSection.name,
                  displayName: editSection.displayName,
                  sortOrder: editSection.sortOrder,
                  kind: editSection.kind,
                  descriptionMarkdown: editSection.descriptionMarkdown ?? "",
                } satisfies SectionFormValues
              }
              onSubmit={handleEditSubmit}
              onCancel={() => setEditSection(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Retire / restore confirmation */}
      <Dialog
        open={retireConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setRetireConfirm(null);
        }}
      >
        <DialogContent>
          {retireConfirm !== null && (
            <RetireDialogBody
              section={retireConfirm.section}
              nextRetired={retireConfirm.nextRetired}
              onClose={() => setRetireConfirm(null)}
              onConfirm={() =>
                handleSetRetired(
                  retireConfirm.section,
                  retireConfirm.nextRetired,
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
              section={deleteConfirm}
              onClose={() => setDeleteConfirm(null)}
              onConfirm={() => handleDelete(deleteConfirm)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RetireDialogBody({
  section,
  nextRetired,
  onClose,
  onConfirm,
}: {
  section: SectionRow;
  nextRetired: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const isRetire = nextRetired === true;
  const title = isRetire ? "Retire section" : "Restore section";
  const verbDescription = isRetire
    ? `Retire "${section.displayName}"? It will be hidden from the lot create / edit dropdown but stay visible everywhere it is already referenced. ${section.linkedLotCount} lot${section.linkedLotCount === 1 ? "" : "s"} currently reference this section.`
    : `Restore "${section.displayName}"? Office staff will be able to pick it again when creating or editing lots.`;
  const confirmLabel = isRetire ? "Retire" : "Restore";

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
            isRetire
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

function DeleteDialogBody({
  section,
  onClose,
  onConfirm,
}: {
  section: SectionRow;
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
        <DialogTitle>Delete section</DialogTitle>
        <DialogDescription>
          Delete &quot;{section.displayName}&quot;? This section will be
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
