"use client";

/**
 * /admin/users — staff account management (Story 1.3, FR2 / FR3).
 *
 * Admin-only. Middleware (`src/middleware.ts`) gates the route at the
 * edge; `convex/users.ts` re-enforces every call server-side per
 * NFR-S4. Both layers are required.
 *
 * Reactive table of all users (active + inactive) with three flows:
 *   1. New user → dialog with `<UserForm>` → on success show one-time
 *      temporary-password dialog (Phase 1 has no email service per
 *      ADR-0005).
 *   2. Deactivate / Reactivate → reason-captured confirm dialog.
 *   3. Edit roles → compact checkbox dialog.
 *
 * UX § State Transition UI Patterns governs the deactivate reason
 * capture; UX § Modal & Overlay Patterns governs the dialog chrome.
 *
 * Because `convex/_generated/` is not yet built in this repo, we
 * reference Convex functions via `makeFunctionReference` (the same
 * pattern used by `/lots/page.tsx` and the middleware).
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
import { StatusPill } from "@/components/ui/StatusPill";
import { UserForm, type UserFormSubmitPayload } from "@/components/UserForm";
import {
  STAFF_ROLE_OPTIONS,
  ROLE_LABELS,
  type StaffRole,
} from "@/components/UserForm";
import { translateError } from "@/lib/errors";

/** Mirror of the row shape returned by `api.users.listUsers`. */
interface UserRow {
  _id: string;
  name: string;
  email: string;
  isActive: boolean;
  createdAt: number;
  createdBy: string | null;
  roles: StaffRole[];
}

const listUsersRef = makeFunctionReference<
  "query",
  Record<string, never>,
  UserRow[]
>("users:listUsers");

const createUserRef = makeFunctionReference<
  "mutation",
  { name: string; email: string; roles: StaffRole[] },
  { userId: string; temporaryPassword: string }
>("users:createUser");

const setUserActiveRef = makeFunctionReference<
  "mutation",
  { userId: string; isActive: boolean; reason?: string },
  null
>("users:setUserActive");

const setUserRolesRef = makeFunctionReference<
  "mutation",
  { userId: string; roles: StaffRole[] },
  null
>("users:setUserRoles");

/**
 * Status-pill variant for active vs. inactive. `StatusPill` is
 * constrained to lot/payment domain unions; "available" (green
 * checkmark) is the closest semantic match for "Active" and
 * "cancelled" (grey X) for "Inactive". This is a documented mapping;
 * if a dedicated user-status variant is added later, swap here.
 */
function ActiveStatusBadge({ active }: { active: boolean }) {
  if (active) {
    return <StatusPill status="available" size="sm" />;
  }
  return <StatusPill status="cancelled" size="sm" />;
}

function formatRoleList(roles: StaffRole[]): string {
  if (roles.length === 0) return "—";
  return roles.map((r) => ROLE_LABELS[r]).join(", ");
}

function formatDate(ms: number): string {
  // Locale-en-PH per the architecture's Philippines bias; falls back
  // to en-US if the runtime doesn't carry the locale.
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
  }).format(new Date(ms));
}

export default function AdminUsersPage() {
  const users = useQuery(listUsersRef, {});
  const createUser = useMutation(createUserRef);
  const setUserActive = useMutation(setUserActiveRef);
  const setUserRoles = useMutation(setUserRolesRef);

  const [newUserOpen, setNewUserOpen] = useState(false);
  const [tempPasswordInfo, setTempPasswordInfo] = useState<{
    email: string;
    password: string;
  } | null>(null);
  const [activeDialog, setActiveDialog] = useState<{
    user: UserRow;
    nextActive: boolean;
  } | null>(null);
  const [rolesDialog, setRolesDialog] = useState<UserRow | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const isLoading = users === undefined;
  const isEmpty = users !== undefined && users.length === 0;

  const handleCreateSubmit = async (
    payload: UserFormSubmitPayload,
  ): Promise<void> => {
    setActionError(null);
    const result = await createUser(payload);
    setNewUserOpen(false);
    setTempPasswordInfo({
      email: payload.email,
      password: result.temporaryPassword,
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Users</h1>
        <button
          type="button"
          onClick={() => setNewUserOpen(true)}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          New user
        </button>
      </div>

      <p className="max-w-2xl text-sm text-slate-600">
        Create staff and field-worker accounts, assign one or more roles,
        and deactivate accounts to revoke access. Deactivation takes
        effect on the user&apos;s next request.
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
          data-testid="users-loading"
          className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500"
        >
          Loading users…
        </div>
      )}

      {isEmpty && (
        <div className="rounded-md border border-slate-200 bg-white p-8 text-center">
          <p className="text-sm text-slate-600">
            No users yet. Create the first staff account to get started.
          </p>
        </div>
      )}

      {users !== undefined && users.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Roles</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((u) => (
                <tr key={u._id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-900">
                    {u.name || <span className="text-slate-400">(no name)</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{u.email}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {formatRoleList(u.roles)}
                  </td>
                  <td className="px-4 py-3">
                    <ActiveStatusBadge active={u.isActive} />
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {formatDate(u.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-3 text-sm">
                      <button
                        type="button"
                        onClick={() => setRolesDialog(u)}
                        className="font-medium text-slate-900 hover:underline"
                      >
                        Edit roles
                      </button>
                      {u.isActive ? (
                        <button
                          type="button"
                          onClick={() =>
                            setActiveDialog({ user: u, nextActive: false })
                          }
                          className="font-medium text-red-600 hover:underline"
                        >
                          Deactivate
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            setActiveDialog({ user: u, nextActive: true })
                          }
                          className="font-medium text-emerald-700 hover:underline"
                        >
                          Reactivate
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* New user dialog */}
      <Dialog open={newUserOpen} onOpenChange={setNewUserOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New user</DialogTitle>
            <DialogDescription>
              The system generates a one-time temporary password. Give it
              to the new user directly — Phase 1 doesn&apos;t send emails.
            </DialogDescription>
          </DialogHeader>
          <UserForm
            onSubmit={handleCreateSubmit}
            onCancel={() => setNewUserOpen(false)}
          />
        </DialogContent>
      </Dialog>

      {/* Temp password reveal dialog */}
      <Dialog
        open={tempPasswordInfo !== null}
        onOpenChange={(open) => {
          if (!open) setTempPasswordInfo(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Temporary password ready</DialogTitle>
            <DialogDescription>
              Read this password to {tempPasswordInfo?.email}. It is shown
              once and will not appear again — copy it now or have them
              sign in immediately.
            </DialogDescription>
          </DialogHeader>
          {tempPasswordInfo !== null && (
            <TempPasswordPanel
              email={tempPasswordInfo.email}
              password={tempPasswordInfo.password}
            />
          )}
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={() => setTempPasswordInfo(null)}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Done
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Activate / deactivate dialog */}
      <Dialog
        open={activeDialog !== null}
        onOpenChange={(open) => {
          if (!open) setActiveDialog(null);
        }}
      >
        <DialogContent>
          {activeDialog !== null && (
            <ActiveDialogBody
              user={activeDialog.user}
              nextActive={activeDialog.nextActive}
              onClose={() => setActiveDialog(null)}
              onConfirm={async (reason) => {
                setActionError(null);
                try {
                  await setUserActive({
                    userId: activeDialog.user._id,
                    isActive: activeDialog.nextActive,
                    reason: reason.length > 0 ? reason : undefined,
                  });
                  setActiveDialog(null);
                } catch (err) {
                  const translated = translateError(err);
                  setActionError(translated.detail);
                  setActiveDialog(null);
                }
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Edit roles dialog */}
      <Dialog
        open={rolesDialog !== null}
        onOpenChange={(open) => {
          if (!open) setRolesDialog(null);
        }}
      >
        <DialogContent>
          {rolesDialog !== null && (
            <EditRolesDialogBody
              user={rolesDialog}
              onClose={() => setRolesDialog(null)}
              onSubmit={async (roles) => {
                setActionError(null);
                try {
                  await setUserRoles({
                    userId: rolesDialog._id,
                    roles,
                  });
                  setRolesDialog(null);
                } catch (err) {
                  const translated = translateError(err);
                  setActionError(translated.detail);
                  setRolesDialog(null);
                }
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Panel that displays the one-time temporary password with a Copy
 * button. The password lives in a `<code>` block — never logged,
 * never put into the document title, never stored in localStorage.
 * `navigator.clipboard.writeText` is best-effort; the manual select +
 * Ctrl-C fallback works in every browser.
 */
function TempPasswordPanel({
  email,
  password,
}: {
  email: string;
  password: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
        <div className="text-xs uppercase tracking-wide text-slate-500">
          {email}
        </div>
        <code className="mt-1 block break-all text-base font-mono text-slate-900">
          {password}
        </code>
      </div>
      <button
        type="button"
        onClick={handleCopy}
        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
      >
        {copied ? "Copied" : "Copy password"}
      </button>
    </div>
  );
}

/**
 * Body of the activate/deactivate dialog. Captures a free-text reason
 * on deactivation (UX § State Transition UI Patterns); reactivation
 * skips the reason — re-enabling an account is always safe and
 * doesn't warrant the friction.
 */
function ActiveDialogBody({
  user,
  nextActive,
  onClose,
  onConfirm,
}: {
  user: UserRow;
  nextActive: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const isDeactivate = nextActive === false;
  const title = isDeactivate ? "Deactivate user" : "Reactivate user";
  const confirmLabel = isDeactivate ? "Deactivate" : "Reactivate";
  const verbDescription = isDeactivate
    ? `Deactivate ${user.name || user.email}? They will lose access on their next request. They stay in the list for audit and can be reactivated later.`
    : `Reactivate ${user.name || user.email}? They will regain access on their next sign-in.`;

  const handle = async (): Promise<void> => {
    setSubmitting(true);
    await onConfirm(reason);
    setSubmitting(false);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{verbDescription}</DialogDescription>
      </DialogHeader>
      {isDeactivate && (
        <div className="space-y-1">
          <label
            htmlFor="deactivate-reason"
            className="block text-sm font-medium text-slate-700"
          >
            Reason (optional)
          </label>
          <textarea
            id="deactivate-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="e.g. Left the company on 5/19."
            className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
          <p className="text-xs text-slate-500">
            Stored in the audit log. Do not include sensitive data.
          </p>
        </div>
      )}
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
 * Body of the edit-roles dialog. A checkbox group pre-populated with
 * the user's current roles; submits the new set to `setUserRoles`.
 * The server diffs against the existing rows — UI doesn't need to
 * compute the diff itself.
 */
function EditRolesDialogBody({
  user,
  onClose,
  onSubmit,
}: {
  user: UserRow;
  onClose: () => void;
  onSubmit: (roles: StaffRole[]) => Promise<void>;
}) {
  const [selected, setSelected] = useState<StaffRole[]>(user.roles);
  const [submitting, setSubmitting] = useState(false);

  const toggle = (role: StaffRole): void => {
    setSelected((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role],
    );
  };

  const handle = async (): Promise<void> => {
    setSubmitting(true);
    await onSubmit(selected);
    setSubmitting(false);
  };

  const empty = selected.length === 0;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit roles</DialogTitle>
        <DialogDescription>
          Update {user.name || user.email}&apos;s role assignments. The
          change takes effect on their next request.
        </DialogDescription>
      </DialogHeader>
      <fieldset>
        <legend className="sr-only">Roles</legend>
        <div className="flex flex-col gap-2">
          {STAFF_ROLE_OPTIONS.map((role) => (
            <label
              key={role}
              className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm cursor-pointer hover:bg-slate-50"
            >
              <input
                type="checkbox"
                checked={selected.includes(role)}
                onChange={() => toggle(role)}
                className="h-4 w-4"
              />
              <span>{ROLE_LABELS[role]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {empty && (
        <p className="text-xs text-red-600">Select at least one role.</p>
      )}
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
          disabled={submitting || empty}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "Saving…" : "Save roles"}
        </button>
      </div>
    </>
  );
}
