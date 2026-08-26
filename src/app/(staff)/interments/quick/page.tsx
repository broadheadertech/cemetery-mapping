"use client";

/**
 * /interments/quick — someone has died and the family is at the desk.
 *
 * The ordinary path (create the occupant on the lot page, then open the
 * booking form) assumes you already know which lot. At this counter you
 * do not: the family knows a name, a date, and that "we have something
 * here somewhere". So the page asks in the order the conversation
 * actually goes — who are you, who died, where do they go, when — and
 * finds the lots for them.
 *
 * Two things it deliberately does NOT do. It does not hide a lot the
 * family owns but cannot use today; it shows it with the reason, and
 * the peso figure if the reason is money, because a family sent away to
 * buy a plot they already own is the worst outcome available. And it
 * does not enforce the ownership rule — the mutation does. This page
 * can only decide what to offer.
 */

import { useMemo, useState, type ReactElement } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { formatPeso } from "@/lib/money";

// --- server surface ---------------------------------------------------

/**
 * The caller's own roles — a `requireAuth` self-read every signed-in
 * user may run. Read BEFORE the office-only queries below so a field
 * worker who reaches this URL is told so, rather than being handed a
 * rejected query: `useQuery` throws during render, it does not return
 * `undefined`.
 */
const rolesRef = makeFunctionReference<
  "query",
  Record<string, never>,
  { userId: string; roles: string[]; isActive: boolean }
>("users:getCurrentUserRoles");

interface CustomerHit {
  customerId: string;
  fullName: string;
  govIdLast4: string;
}

const searchCustomersRef = makeFunctionReference<
  "query",
  { q: string },
  CustomerHit[]
>("customers:searchByName");

interface LotOption {
  lotId: string;
  code: string;
  section: string;
  status: string;
  relation: "owned" | "family_estate";
  estateName?: string;
  bodiesRemaining: number;
  bonesRemaining: number;
  hasRoom: boolean;
  canInterNow: boolean;
  blockedReason?: string;
  shortfallCents?: number;
}

interface FamilyLots {
  customerName: string;
  existing: LotOption[];
  needsNewLot: boolean;
  needsNewLotReason?: string;
}

const findLotsRef = makeFunctionReference<
  "query",
  { customerId: string },
  FamilyLots
>("quickInterment:findLotsForFamily");

const bookRef = makeFunctionReference<
  "mutation",
  {
    customerId: string;
    lotId: string;
    deceasedName: string;
    dateOfDeath: number;
    relationshipToOwner: string;
    intermentKind?: "body" | "bones";
    scheduledAt: number;
    notes?: string;
  },
  { occupantId: string; intermentId: string }
>("quickInterment:bookQuickInterment");

// --- page -------------------------------------------------------------

export default function QuickIntermentPage(): ReactElement {
  const me = useQuery(rolesRef, {});
  const roles = me?.roles ?? [];
  const mayUse = roles.includes("admin") || roles.includes("office_staff");

  const [family, setFamily] = useState<CustomerHit | null>(null);
  const [name, setName] = useState("");
  const [dateOfDeath, setDateOfDeath] = useState("");
  const [relationship, setRelationship] = useState("");
  const [kind, setKind] = useState<"body" | "bones">("body");
  const [lotId, setLotId] = useState("");
  const [when, setWhen] = useState("");
  const [notes, setNotes] = useState("");
  const [booking, setBooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<{ intermentId: string } | null>(null);

  const lots = useQuery(
    findLotsRef,
    mayUse && family !== null ? { customerId: family.customerId } : "skip",
  );
  const book = useMutation(bookRef);

  const deathMs = useMemo(() => parseDate(dateOfDeath), [dateOfDeath]);
  const whenMs = useMemo(() => parseDateTime(when), [when]);

  const ready =
    family !== null &&
    name.trim().length > 0 &&
    deathMs !== null &&
    relationship.trim().length > 0 &&
    lotId.length > 0 &&
    whenMs !== null;

  if (me === undefined) {
    return <p className="text-sm text-slate-600">Loading&hellip;</p>;
  }

  if (!mayUse) {
    return (
      <div className="space-y-4">
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Quick interment
        </h1>
        <p
          data-testid="quick-not-permitted"
          className="max-w-xl rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          This is an office desk flow &mdash; it records a sale-adjacent
          booking against a family&rsquo;s lot, so it is limited to office
          staff and administrators. Your scheduled work is on{" "}
          <Link href="/interments/today" className="underline">
            today&rsquo;s interments
          </Link>
          .
        </p>
      </div>
    );
  }

  if (booked !== null) {
    return (
      <div className="space-y-4">
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Booked
        </h1>
        <div
          data-testid="quick-booked"
          className="max-w-xl rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
        >
          <p className="font-medium">
            {name.trim()} is recorded, and the interment is scheduled.
          </p>
          <p className="mt-1">
            Print the schedule for the crew and confirm the time with the
            family before they leave.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/interments/${booked.intermentId}`}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            Open the interment
          </Link>
          <button
            type="button"
            onClick={() => {
              setBooked(null);
              setFamily(null);
              setName("");
              setDateOfDeath("");
              setRelationship("");
              setKind("body");
              setLotId("");
              setWhen("");
              setNotes("");
            }}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Start another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Quick interment
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          For a family at the counter. Find who they are, record who has
          died, and book the burial in one step &mdash; the lots they may
          use are found for you.
        </p>
      </header>

      <Step n={1} title="Which family">
        {family === null ? (
          <CustomerSearch onPick={setFamily} />
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-slate-800">
              <span className="font-medium">{family.fullName}</span>
              <span className="ml-2 font-mono text-xs text-slate-500">
                ***-***-{family.govIdLast4}
              </span>
            </p>
            <button
              type="button"
              onClick={() => {
                setFamily(null);
                setLotId("");
              }}
              className="text-xs font-medium text-slate-600 underline hover:text-slate-900"
            >
              Change
            </button>
          </div>
        )}
      </Step>

      <Step n={2} title="Who has died">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Full name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="quick-name"
              className={inputClass}
            />
          </Field>
          <Field label="Date of death" hint="From the certificate">
            <input
              type="date"
              value={dateOfDeath}
              onChange={(e) => setDateOfDeath(e.target.value)}
              data-testid="quick-date-of-death"
              className={inputClass}
            />
          </Field>
          <Field label="Relationship to the owner">
            <input
              type="text"
              value={relationship}
              onChange={(e) => setRelationship(e.target.value)}
              placeholder="father"
              data-testid="quick-relationship"
              className={inputClass}
            />
          </Field>
          <Field
            label="Interment"
            hint="Two sets of bones take one body's space"
          >
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as "body" | "bones")}
              className={inputClass}
            >
              <option value="body">A burial</option>
              <option value="bones">Transferred remains</option>
            </select>
          </Field>
        </div>
      </Step>

      <Step n={3} title="Which lot">
        {family === null ? (
          <p className="text-sm text-slate-500">
            Find the family first.
          </p>
        ) : lots === undefined ? (
          <p className="text-sm text-slate-500">Looking&hellip;</p>
        ) : (
          <LotChoices
            lots={lots}
            selected={lotId}
            onSelect={setLotId}
            kind={kind}
          />
        )}
      </Step>

      <Step n={4} title="When">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Date and time of the interment">
            <input
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              data-testid="quick-when"
              className={inputClass}
            />
          </Field>
          <Field label="Notes" hint="Optional — read by the crew">
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>
      </Step>

      {error !== null && (
        <p
          role="alert"
          data-testid="quick-error"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900"
        >
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={!ready || booking}
        data-testid="quick-submit"
        onClick={() => {
          if (!ready || family === null || deathMs === null || whenMs === null) {
            return;
          }
          setBooking(true);
          setError(null);
          void book({
            customerId: family.customerId,
            lotId,
            deceasedName: name.trim(),
            dateOfDeath: deathMs,
            relationshipToOwner: relationship.trim(),
            intermentKind: kind,
            scheduledAt: whenMs,
            ...(notes.trim().length > 0 ? { notes: notes.trim() } : {}),
          })
            .then((r) => setBooked({ intermentId: r.intermentId }))
            .catch((e: unknown) => setError(messageOf(e)))
            .finally(() => setBooking(false));
        }}
        className="rounded-md bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {booking ? "Booking…" : "Record and book"}
      </button>
    </div>
  );
}

// --- pieces -----------------------------------------------------------

function CustomerSearch({
  onPick,
}: {
  onPick: (hit: CustomerHit) => void;
}): ReactElement {
  const [term, setTerm] = useState("");
  // `searchByName` rejects anything under three characters itself; the
  // gate here just keeps the index cold while someone is still typing.
  const hits = useQuery(
    searchCustomersRef,
    term.trim().length >= 3 ? { q: term.trim() } : "skip",
  );

  return (
    <div className="space-y-3">
      <Field label="Name of the lot owner" hint="At least three letters">
        <input
          type="text"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Reyes"
          data-testid="quick-customer-search"
          className={`${inputClass} max-w-md`}
        />
      </Field>

      {hits !== undefined && hits.length === 0 && (
        <p className="text-sm text-slate-600">
          No one by that name. They may be recorded under a different
          spelling &mdash; or,{" "}
          <Link href="/customers/new" className="underline">
            add them
          </Link>{" "}
          if this is their first dealing with the park.
        </p>
      )}

      {hits !== undefined && hits.length > 0 && (
        <ul className="max-w-md divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
          {hits.map((h) => (
            <li key={h.customerId}>
              <button
                type="button"
                data-testid="quick-customer-hit"
                onClick={() => onPick(h)}
                className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm hover:bg-slate-50"
              >
                <span className="font-medium text-slate-900">{h.fullName}</span>
                <span className="font-mono text-xs text-slate-500">
                  ***-***-{h.govIdLast4}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LotChoices({
  lots,
  selected,
  onSelect,
  kind,
}: {
  lots: FamilyLots;
  selected: string;
  onSelect: (id: string) => void;
  kind: "body" | "bones";
}): ReactElement {
  return (
    <div className="space-y-3">
      {lots.existing.length > 0 && (
        <ul className="space-y-2">
          {lots.existing.map((o) => (
            <li key={o.lotId}>
              <label
                data-testid="quick-lot-option"
                className={[
                  "flex cursor-pointer items-start gap-3 rounded-md border p-4",
                  o.canInterNow
                    ? selected === o.lotId
                      ? "border-slate-900 bg-slate-50"
                      : "border-slate-200 bg-white hover:bg-slate-50"
                    : "cursor-not-allowed border-slate-200 bg-slate-50 opacity-80",
                ].join(" ")}
              >
                <input
                  type="radio"
                  name="quick-lot"
                  className="mt-1"
                  disabled={!o.canInterNow}
                  checked={selected === o.lotId}
                  onChange={() => onSelect(o.lotId)}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-display text-xl font-light text-slate-900">
                      Lot {o.code}
                    </span>
                    <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-500">
                      {o.section}
                    </span>
                    <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-700">
                      {o.relation === "owned"
                        ? "Owned by them"
                        : `Through ${o.estateName ?? "the family estate"}`}
                    </span>
                  </span>

                  <span className="mt-1 block text-sm text-slate-700">
                    Room for {o.bodiesRemaining} more{" "}
                    {o.bodiesRemaining === 1 ? "burial" : "burials"}
                    {o.bonesRemaining > 0 &&
                      `, or ${o.bonesRemaining} set${
                        o.bonesRemaining === 1 ? "" : "s"
                      } of transferred remains`}
                    .
                  </span>

                  {o.blockedReason !== undefined && (
                    <span
                      data-testid="quick-lot-blocked"
                      className="mt-2 block rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                    >
                      {o.blockedReason}
                      {o.shortfallCents !== undefined &&
                        o.shortfallCents > 0 && (
                          <>
                            {" "}
                            <Link
                              href={`/lots/${o.lotId}`}
                              className="font-medium underline"
                            >
                              Take a payment of{" "}
                              {formatPeso(o.shortfallCents)}
                            </Link>{" "}
                            and this lot opens up.
                          </>
                        )}
                    </span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {lots.needsNewLot && (
        <div
          data-testid="quick-needs-lot"
          className="rounded-md border border-slate-300 bg-white px-4 py-3 text-sm text-slate-800"
        >
          <p className="font-medium">A lot will need to be chosen.</p>
          <p className="mt-1 text-slate-600">
            {lots.needsNewLotReason ??
              "None of the family's lots can take a burial today."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href="/lots/suggest"
              className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
            >
              Help them choose
            </Link>
            <Link
              href="/sales/new"
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Record a sale
            </Link>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Once the sale is recorded, come back here &mdash; the new lot
            will be listed above.
          </p>
        </div>
      )}

      {kind === "bones" && lots.existing.some((o) => !o.hasRoom) && (
        <p className="text-xs text-slate-500">
          A lot with no room for a burial may still take transferred
          remains. If one is greyed out and you are certain, open the lot
          directly.
        </p>
      )}
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}): ReactElement {
  return (
    <section className="rounded-md border border-slate-200 bg-white p-5">
      <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.14em] text-slate-500">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-xs text-white">
          {n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

const inputClass =
  "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint !== undefined && (
        <span className="text-xs text-slate-500">{hint}</span>
      )}
    </label>
  );
}

// --- input parsing ----------------------------------------------------

/**
 * A `<input type="date">` value as Manila noon.
 *
 * Noon, not midnight: a date of death is a day, and anchoring it at
 * midnight puts it one timezone step from landing on the day before.
 */
function parseDate(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T12:00:00+08:00`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * A `<input type="datetime-local">` value, read as Manila time.
 *
 * The browser hands back `YYYY-MM-DDTHH:MM`, sometimes with seconds.
 * Both are truncated to the minute and stamped +08:00 — a staffer at
 * the counter in Aringay means Aringay time, whatever the machine's
 * clock is set to.
 */
function parseDateTime(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
  const ms = Date.parse(`${value.slice(0, 16)}:00+08:00`);
  return Number.isNaN(ms) ? null : ms;
}

function messageOf(e: unknown): string {
  if (typeof e === "object" && e !== null) {
    const data = (e as { data?: { message?: string } }).data;
    if (data?.message !== undefined) return data.message;
    const msg = (e as { message?: string }).message;
    if (msg !== undefined) return msg;
  }
  return "Something went wrong. Nothing was saved.";
}
