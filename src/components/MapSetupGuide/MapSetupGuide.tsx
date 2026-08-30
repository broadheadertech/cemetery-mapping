"use client";

/**
 * Building the 3D map, in one place.
 *
 * The six things it takes — create the garden, set its arrangement, add
 * its lots, look at it, photograph them, place them — used to live on
 * six screens. Doing that by tab-hopping means holding in your head
 * which gardens you have already done, which is exactly the thing a
 * computer should be holding for you.
 *
 * So every step is COUNTED, not claimed. There is no "mark as done"
 * anywhere here: a step is complete when the data says it is, which
 * means the page cannot tell you the map is ready when it is not.
 *
 * Steps 1, 2 and 4 run inline — the garden form, the layout control and
 * the map itself are all on this page. Steps 3, 5 and 6 need a screen of
 * their own (a lot form, a camera at the lot, a pin on a map), so they
 * link out, but they say exactly WHICH garden needs the visit rather
 * than sending you off to work it out.
 *
 * @gated-route-only — mounts on `/admin/map-setup`; middleware keeps
 * non-admins off the `/admin` family, and `lots:mapSetupProgress`
 * re-checks server-side.
 */

import dynamic from "next/dynamic";
import Link from "next/link";
import { useState, type ReactElement, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import {
  SectionForm,
  type SectionFormSubmitPayload,
  type SectionKind,
} from "@/components/SectionForm";
import { SectionLayoutControl } from "@/components/SectionLayoutControl";
import { translateError } from "@/lib/errors";

const Phase3DMap = dynamic(
  () => import("@/components/Phase3DMap").then((m) => m.Phase3DMap),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[420px] items-center justify-center rounded-md border border-surface-border bg-surface-muted text-sm text-text-muted">
        Building the 3D map&hellip;
      </div>
    ),
  },
);

interface SetupSection {
  sectionId: string;
  name: string;
  displayName: string;
  sortOrder: number;
  kind: string;
  gridColumns: number | null;
  gridRows: number | null;
  lotCount: number;
  photoCount: number;
  surveyedCount: number;
}

interface SetupProgress {
  sections: SetupSection[];
  orphanSections: Array<{ section: string; lotCount: number }>;
  totals: {
    sectionCount: number;
    laidOutCount: number;
    lotCount: number;
    photoCount: number;
    surveyedCount: number;
  };
}

const progressRef = makeFunctionReference<
  "query",
  Record<string, never>,
  SetupProgress
>(
  "lots:mapSetupProgress",
);

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

type StepState = "todo" | "partial" | "done" | "optional";

export function MapSetupGuide(): ReactElement {
  const progress = useQuery(progressRef, {});
  const createSection = useMutation(createSectionRef);

  const [addingGarden, setAddingGarden] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(
    payload: SectionFormSubmitPayload,
  ): Promise<void> {
    setError(null);
    try {
      await createSection({
        name: payload.name,
        displayName: payload.displayName,
        sortOrder: payload.sortOrder,
        kind: payload.kind,
        ...(payload.descriptionMarkdown !== undefined &&
        payload.descriptionMarkdown !== ""
          ? { descriptionMarkdown: payload.descriptionMarkdown }
          : {}),
      });
      setAddingGarden(false);
    } catch (err) {
      setError(translateError(err).detail);
    }
  }

  if (progress === undefined) {
    return (
      <p className="text-sm text-text-muted" data-testid="map-setup-loading">
        Loading&hellip;
      </p>
    );
  }

  const { sections, orphanSections, totals } = progress;
  const withLots = sections.filter((s) => s.lotCount > 0);
  const withoutLots = sections.filter((s) => s.lotCount === 0);
  const unlaid = sections.filter(
    (s) => s.gridColumns === null || s.gridRows === null,
  );

  const step1: StepState = totals.sectionCount > 0 ? "done" : "todo";
  const step2: StepState =
    totals.sectionCount === 0
      ? "todo"
      : unlaid.length === 0
        ? "done"
        : totals.laidOutCount > 0
          ? "partial"
          : "todo";
  const step3: StepState =
    totals.sectionCount === 0
      ? "todo"
      : withoutLots.length === 0
        ? "done"
        : withLots.length > 0
          ? "partial"
          : "todo";
  const step4: StepState = totals.lotCount > 0 ? "done" : "todo";
  /*
   * Placing lots is not optional for an irregular park — it is the only
   * thing that draws it truthfully — but it genuinely is for a park of
   * neat rectangles, where the grid is already right. So it reports
   * progress rather than nagging: "optional" until somebody starts,
   * then a real count once they have.
   */
  const step6: StepState =
    totals.lotCount === 0
      ? "todo"
      : totals.surveyedCount === 0
        ? "optional"
        : totals.surveyedCount >= totals.lotCount
          ? "done"
          : "partial";
  const step5: StepState =
    totals.lotCount === 0
      ? "todo"
      : totals.photoCount >= totals.lotCount
        ? "done"
        : totals.photoCount > 0
          ? "partial"
          : "todo";

  return (
    <div className="space-y-4" data-testid="map-setup">
      {/* What is actually done, before any of the steps. */}
      <div
        data-testid="map-setup-summary"
        className="flex flex-wrap gap-x-8 gap-y-3 rounded-md border border-surface-border bg-surface-muted px-5 py-4"
      >
        <Tally label="Gardens" value={totals.sectionCount} />
        <Tally
          label="Arranged"
          value={`${totals.laidOutCount} of ${totals.sectionCount}`}
        />
        <Tally label="Lots" value={totals.lotCount} />
        <Tally
          label="Photographed"
          value={`${totals.photoCount} of ${totals.lotCount}`}
        />
      </div>

      {error !== null && (
        <p
          role="alert"
          data-testid="map-setup-error"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {error}
        </p>
      )}

      {/*
        Lots whose garden name matches nothing in the registry. They are
        real, the map cannot draw them, and no other screen would ever
        mention it — so it goes at the top, not buried in a step.
      */}
      {orphanSections.length > 0 && (
        <div
          role="alert"
          data-testid="map-setup-orphans"
          className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <strong className="font-semibold">
            Some lots belong to no garden.
          </strong>{" "}
          These lots exist but the map cannot place them, because their
          section name matches no garden in the registry. Create a garden
          with the matching display name, or edit the lots onto an
          existing one.
          <ul className="mt-2 space-y-0.5">
            {orphanSections.map((o) => (
              <li key={o.section} className="font-mono text-xs">
                &ldquo;{o.section}&rdquo; — {o.lotCount} lot
                {o.lotCount === 1 ? "" : "s"}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ---- 1 ------------------------------------------------------ */}
      <Step
        n={1}
        state={step1}
        title="Create the gardens"
        blurb="A garden is a named part of the park — Garden of Faith, Chapel of Grace. Every lot belongs to one, and the map draws one block per garden."
      >
        {sections.length > 0 && (
          <ul
            data-testid="map-setup-gardens"
            className="mb-3 flex flex-wrap gap-2"
          >
            {sections.map((s) => (
              <li
                key={s.sectionId}
                className="rounded-full border border-surface-border bg-surface-base px-3 py-1 text-xs text-text-default"
              >
                {s.displayName}
                <span className="ml-1.5 text-text-muted">
                  {s.lotCount} lot{s.lotCount === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        )}

        {addingGarden ? (
          <div className="rounded-md border border-surface-border bg-surface-base p-4">
            <SectionForm
              mode="create"
              onSubmit={handleCreate}
              onCancel={() => setAddingGarden(false)}
            />
          </div>
        ) : (
          <button
            type="button"
            data-testid="map-setup-add-garden"
            onClick={() => {
              setError(null);
              setAddingGarden(true);
            }}
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            Add a garden
          </button>
        )}
      </Step>

      {/* ---- 2 ------------------------------------------------------ */}
      <Step
        n={2}
        state={step2}
        title="Set how each garden is arranged"
        blurb="Columns across, rows deep. Lots fill the grid in code order, so the codes are the arrangement — this is a visual representation, not a survey."
      >
        {sections.length === 0 ? (
          <Waiting>Create a garden first.</Waiting>
        ) : (
          <ul className="divide-y divide-surface-border rounded-md border border-surface-border bg-surface-base">
            {sections.map((s) => (
              <li key={s.sectionId} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-text-default">
                    {s.displayName}
                  </span>
                  <span className="text-xs text-text-muted">
                    {s.lotCount} lot{s.lotCount === 1 ? "" : "s"}
                  </span>
                </div>
                <SectionLayoutControl
                  sectionId={s.sectionId}
                  displayName={s.displayName}
                  gridColumns={s.gridColumns}
                  gridRows={s.gridRows}
                  lotCount={s.lotCount}
                />
              </li>
            ))}
          </ul>
        )}
      </Step>

      {/* ---- 3 ------------------------------------------------------ */}
      <Step
        n={3}
        state={step3}
        title="Add the lots"
        blurb="Number the codes in the order the lots physically sit — that ordering IS the map. A spreadsheet is the fast way in; the lot form is for one at a time."
      >
        {sections.length === 0 ? (
          <Waiting>Create a garden first.</Waiting>
        ) : (
          <>
            {withoutLots.length > 0 && (
              <p
                data-testid="map-setup-empty-gardens"
                className="mb-3 text-sm text-text-muted"
              >
                No lots yet in{" "}
                <strong className="font-medium text-text-default">
                  {withoutLots.map((s) => s.displayName).join(", ")}
                </strong>
                .
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Jump href="/admin/lot-import">
                Import a spreadsheet of lots
              </Jump>
              <Jump href="/lots/new">Add one lot</Jump>
            </div>
          </>
        )}
      </Step>

      {/* ---- 4 ------------------------------------------------------ */}
      <Step
        n={4}
        state={step4}
        title="Look at the map"
        blurb="Drag to orbit, scroll to zoom, click a lot to inspect it. Colour is status — available, reserved, sold, occupied."
      >
        {totals.lotCount === 0 ? (
          <Waiting>
            Nothing to draw yet. Add lots and they appear here.
          </Waiting>
        ) : showMap ? (
          <div data-testid="map-setup-preview">
            <Phase3DMap />
          </div>
        ) : (
          <button
            type="button"
            data-testid="map-setup-show-map"
            onClick={() => setShowMap(true)}
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            Show the map
          </button>
        )}
      </Step>

      {/* ---- 5 ------------------------------------------------------ */}
      <Step
        n={5}
        state={step5}
        title="Photograph the lots"
        blurb="This is what a survey means at this scale. A picture is what a family recognises, and what settles which lot is the one by the tree. Field workers can post one from the lot itself."
      >
        {totals.lotCount === 0 ? (
          <Waiting>Add lots first.</Waiting>
        ) : (
          <>
            <ul
              data-testid="map-setup-photos"
              className="mb-3 space-y-1 text-sm"
            >
              {withLots.map((s) => (
                <li key={s.sectionId} className="text-text-muted">
                  <span className="text-text-default">{s.displayName}</span> —{" "}
                  {s.photoCount} of {s.lotCount} photographed
                </li>
              ))}
            </ul>
            <Jump href="/lots">Open the lot list</Jump>
          </>
        )}
      </Step>

      {/* ---- 6 ------------------------------------------------------ */}
      <Step
        n={6}
        state={step6}
        title="Place the lots on the ground"
        blurb="Where each lot actually is. A garden that is a neat rectangle does not need this — the grid already draws it right. A garden with curved edges, angled rows, or blocks that do not line up does, because no grid can draw that honestly."
      >
        {totals.lotCount === 0 ? (
          <Waiting>Add lots first.</Waiting>
        ) : (
          <>
            <p
              data-testid="map-setup-surveyed"
              className="text-sm text-text-muted"
            >
              {totals.surveyedCount} of {totals.lotCount} lots have a
              measured position.
              {totals.surveyedCount > 0 && (
                <>
                  {" "}
                  The 3D map draws those where they were measured, and
                  says how many it is not showing.
                </>
              )}
            </p>
            {/*
              An irregular garden drawn as a rectangle looks exactly as
              confident as one drawn right, so somebody has to be told
              which they are looking at before they trust it.
            */}
            <p className="mt-2 text-sm text-text-muted">
              A survey file places hundreds at once. One at a time is a
              click on a map, from the lot&rsquo;s own page.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Jump href="/admin/gps-import">Import a survey file</Jump>
              <Jump href="/lots">Place one from the lot list</Jump>
            </div>
          </>
        )}
      </Step>
    </div>
  );
}

function Tally({
  label,
  value,
}: {
  label: string;
  value: string | number;
}): ReactElement {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
        {label}
      </div>
      <div className="mt-0.5 text-lg text-text-default">{value}</div>
    </div>
  );
}

const STATE_COPY: Record<StepState, { label: string; className: string }> = {
  todo: {
    label: "To do",
    className: "border-surface-border bg-surface-muted text-text-muted",
  },
  partial: {
    label: "In progress",
    className: "border-amber-300 bg-amber-50 text-amber-900",
  },
  done: {
    label: "Done",
    className: "border-primary bg-primary/10 text-primary",
  },
  optional: {
    label: "Optional",
    className: "border-surface-border bg-surface-muted text-text-muted",
  },
};

function Step({
  n,
  state,
  title,
  blurb,
  children,
}: {
  n: number;
  state: StepState;
  title: string;
  blurb: string;
  children: ReactNode;
}): ReactElement {
  const copy = STATE_COPY[state];
  return (
    <section
      data-testid={`map-setup-step-${n}`}
      data-state={state}
      className="rounded-lg border border-surface-border bg-surface-base p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex gap-3">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-surface-border font-mono text-xs text-text-muted">
            {n}
          </span>
          <div>
            <h2 className="font-display text-xl font-semibold text-text-default">
              {title}
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-text-muted">{blurb}</p>
          </div>
        </div>
        <span
          data-testid={`map-setup-state-${n}`}
          className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${copy.className}`}
        >
          {copy.label}
        </span>
      </div>
      <div className="mt-4 pl-0 sm:pl-10">{children}</div>
    </section>
  );
}

function Waiting({ children }: { children: ReactNode }): ReactElement {
  return <p className="text-sm text-text-muted">{children}</p>;
}

function Jump({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}): ReactElement {
  return (
    <Link
      href={href}
      className="inline-flex min-h-[38px] items-center rounded-md border border-surface-border bg-surface-base px-4 py-2 text-sm font-semibold text-text-default hover:border-accent-gold hover:text-primary"
    >
      {children}
    </Link>
  );
}
