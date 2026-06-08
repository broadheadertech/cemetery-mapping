"use client";

/**
 * Admin "bounced emails" view — Story 9.8 (FR57, AC3).
 *
 * Read-only list of customers whose reminder email hard-bounced or filed
 * a spam complaint (set by the `/api/email-bounce-webhook` route). These
 * customers are excluded from the email reminder scan until their address
 * is corrected; staff use this page to follow up by phone / in person.
 *
 * Data: `reminders:getBouncedEmailCustomers` (admin/office_staff-gated
 * server-side). Reactive — a new bounce webhook surfaces here without a
 * refresh, and the row drops out automatically once the customer updates
 * their email (the contact-update mutation clears the bounce flag).
 *
 * Role gating is enforced at THREE layers: middleware (route), the
 * `(staff)/admin` layout, and the query's own `requireRole`. This page
 * carries no second client-side gate by design — the server query is the
 * lock.
 */

import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

interface BouncedCustomerRow {
  _id: string;
  fullName: string;
  email: string | undefined;
  emailBouncedAt: number | undefined;
  emailReminderPausedReason: string | undefined;
  emailBounceMessageId: string | undefined;
}

const getBouncedEmailCustomersRef = makeFunctionReference<
  "query",
  { limit?: number },
  BouncedCustomerRow[]
>("reminders:getBouncedEmailCustomers");

const WHEN_FORMATTER = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  dateStyle: "medium",
  timeStyle: "short",
});

function formatWhen(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return WHEN_FORMATTER.format(new Date(ms));
}

export default function AdminEmailBouncesPage() {
  const rows = useQuery(getBouncedEmailCustomersRef, {});

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-4xl font-semibold tracking-tight">Bounced emails</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Customers whose reminder email hard-bounced or filed a spam
          complaint. They are skipped by the reminder scan until their
          address is corrected — follow up by phone, then ask them to update
          their email from the owner portal (which clears the flag and
          re-enables reminders).
        </p>
      </div>

      <section
        className="rounded-lg border border-slate-200 bg-white shadow-sm"
        aria-label="Bounced-email customers"
      >
        {rows === undefined ? (
          <p
            className="p-6 text-sm text-slate-500"
            data-testid="email-bounces-loading"
          >
            Loading…
          </p>
        ) : rows.length === 0 ? (
          <p
            className="p-6 text-sm text-slate-500"
            data-testid="email-bounces-empty"
          >
            No bounced email addresses on file. Reminder delivery is healthy.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="email-bounces-table">
              <thead>
                <tr className="border-b border-[#E1DAC8] bg-[#F6F2EA] font-mono text-[10px] uppercase tracking-[0.12em] text-[#8E8C85]">
                  <th className="px-4 py-3 font-medium">Customer</th>
                  <th className="px-4 py-3 font-medium">Email</th>
                  <th className="px-4 py-3 font-medium">Bounced</th>
                  <th className="px-4 py-3 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r._id} data-testid="email-bounces-row">
                    <td className="px-4 py-3 font-medium text-slate-800">
                      {r.fullName}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {r.email ?? "—"}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate-600">
                      {formatWhen(r.emailBouncedAt)}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {r.emailReminderPausedReason ?? "hard bounce"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
