"use client";

/**
 * /contracts/[contractId] — contract detail page (Story 3.3 minimal
 * implementation; Story 3.6 will replace with the rich timeline view).
 *
 * Scope for this story:
 *   - Show the contract's identifying fields (number, lot, customer,
 *     total, state, created-at).
 *   - Show the receipt number issued by the financial event so the
 *     operator confirms the sale landed.
 *   - Provide a "Back to sales" link.
 *
 * Story 3.6 owns the rich version (payment timeline, transition
 * controls, void / cancel actions). A `// TODO Story 3.6` comment marks
 * the gap; this page is the safe redirect target for
 * `recordFullPaymentSale` in the interim.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { formatPeso } from "@/lib/money";
import { formatDate } from "@/lib/time";
import { VoidContractDialog } from "@/components/VoidContractDialog";
import { FlagContractDialog } from "@/components/FlagContractDialog";
import { MarkInDefaultDialog } from "@/components/MarkInDefaultDialog";
import { ReclaimLotDialog } from "@/components/ReclaimLotDialog";
import { StatusPill } from "@/components/ui/StatusPill";

type ContractState =
  | "active"
  | "paid_in_full"
  | "cancelled"
  | "voided"
  | "in_default";

interface ContractDetail {
  contractId: string;
  contractNumber: string;
  lotId: string;
  lotCode: string;
  customerId: string;
  customerFullName: string;
  kind: "full_payment" | "installment";
  totalPriceCents: number;
  state: ContractState;
  createdAt: number;
  paymentId?: string;
  receiptId?: string;
  receiptNumber?: string;
  // Story 3.5 (FR22) — optional discount snapshot.
  basePriceCents?: number;
  discountCents?: number;
  discountReason?: string;
  // Story 3.8 (FR25) — optional perpetual care snapshot. Absent on
  // pre-3.8 legacy contracts; UI treats absence as "no perpetual
  // care fee."
  perpetualCareCents?: number;
  perpetualCarePaidCents?: number;
  perpetualCareReason?: string;
  // Story 5.4 (FR44) — admin follow-up flag. `isFlagged` is always
  // present; the other three are only populated when the contract is
  // currently flagged.
  isFlagged: boolean;
  flagReason?: string;
  flaggedAt?: number;
  flaggedByName?: string;
}

/**
 * Story 5.4 — minimal `getCurrentUserOrNull` shape used by the page to
 * gate the admin-only Flag-for-follow-up affordance. Mirrors the auth
 * payload OccupantsPanel reads (Story 1.x). The page self-fetches
 * rather than threading the roles prop through the layout because the
 * (staff) layout's payload already crossed the server boundary as a
 * server-component prop; reading it again client-side keeps the page
 * a self-contained authorisation island for the new button.
 */
interface AuthPayloadShape {
  userId: string;
  user: { email?: string; name?: string };
  roles: string[];
}

const getCurrentUserOrNullRef = makeFunctionReference<
  "query",
  Record<string, never>,
  AuthPayloadShape | null
>("lib/auth:getCurrentUserOrNull");

/**
 * Story 5.4 — function references for the admin-only flag mutations.
 * The contract detail page calls these via `useMutation` from the
 * FlagContractDialog `onConfirm` handler + the "Clear flag" button.
 */
const flagContractRef = makeFunctionReference<
  "mutation",
  { contractId: string; reason: string },
  { contractId: string; flaggedAt: number }
>("contracts:flagContract");

const unflagContractRef = makeFunctionReference<
  "mutation",
  { contractId: string },
  { contractId: string }
>("contracts:unflagContract");

const getContractRef = makeFunctionReference<
  "query",
  { contractId: string },
  ContractDetail
>("contracts:getContract");

/**
 * Story 3.7 — function reference for the admin-only `voidContract`
 * mutation. The contract detail page uses this via `useMutation` to
 * drive the pre-interment void confirmation dialog.
 */
const voidContractRef = makeFunctionReference<
  "mutation",
  { contractId: string; reason: string },
  { contractId: string; from: string; to: "voided" }
>("contracts:voidContract");

/**
 * Story 4.4 — function reference for the admin-only
 * `markContractInDefault` mutation. The contract detail page uses
 * this via `useMutation` to drive the FR37 default confirmation
 * dialog. The mutation flips `state: "active" → "in_default"` and
 * leaves the lot, ownership, payments, receipts, and installments
 * untouched (default ≠ reclaim).
 */
const markContractInDefaultRef = makeFunctionReference<
  "mutation",
  { contractId: string; reason: string },
  { contractId: string; from: string; to: "in_default" }
>("contracts:markContractInDefault");

/**
 * Story 4.5 — function reference for the admin-only `reclaimLot`
 * mutation (FR38). The contract detail page uses this via
 * `useMutation` to drive the "Reclaim lot" confirmation dialog when
 * the contract is in `in_default`. The mutation atomically (a) voids
 * the contract (`in_default → voided`), (b) walks the lot back to
 * `available` (via the legal `sold → defaulted → available` edges in
 * the lot transition table), and (c) emits the operator-facing
 * `void` audit row with a `reclaim:` reason prefix.
 */
const reclaimLotRef = makeFunctionReference<
  "mutation",
  { contractId: string; reason: string },
  {
    contractId: string;
    from: "in_default";
    to: "voided";
    lotId: string;
    lotFrom: "sold" | "defaulted";
    lotTo: "available";
  }
>("contracts:reclaimLot");

/**
 * Story 6.1 — function reference for the contract-PDF mutation +
 * URL query. The mutation schedules a Node-runtime action that renders
 * the PDF and stores the resulting blob in Convex File Storage; the
 * query returns an auth-gated signed URL for download. Both functions
 * live in `convex/contracts.ts`.
 */
const generateContractPdfRequestRef = makeFunctionReference<
  "mutation",
  { contractId: string },
  { contractId: string; status: "scheduled" }
>("contracts:generateContractPdfRequest");

interface ContractPdfUrlResult {
  url: string | null;
  generatedAt: number | null;
}

const getContractPdfUrlRef = makeFunctionReference<
  "query",
  { contractId: string },
  ContractPdfUrlResult
>("contracts:getContractPdfUrl");

/**
 * Story 6.2 — function references for the demand-letter mutation + URL
 * query + overdue summary. The mutation schedules a Node-runtime action
 * that renders the demand letter and stores the resulting blob; the URL
 * query returns an auth-gated signed download URL; the overdue summary
 * tells the UI whether to show the button at all (server enforces the
 * same gate per NFR-S4 — the UI's `disabled` is defense in depth). All
 * three live in `convex/contracts.ts`.
 */
const generateDemandLetterRequestRef = makeFunctionReference<
  "mutation",
  { contractId: string },
  { contractId: string; status: "scheduled" }
>("contracts:generateDemandLetterRequest");

interface DemandLetterUrlResult {
  url: string | null;
  generatedAt: number | null;
}

const getDemandLetterUrlRef = makeFunctionReference<
  "query",
  { contractId: string },
  DemandLetterUrlResult
>("contracts:getDemandLetterUrl");

interface ContractOverdueSummaryShape {
  contractId: string;
  isOverdue: boolean;
  overdueCount: number;
  totalOverdueCents: number;
}

const getContractOverdueSummaryRef = makeFunctionReference<
  "query",
  { contractId: string },
  ContractOverdueSummaryShape
>("contracts:getContractOverdueSummary");

// HIGH-F (Story 5.9 sweep): both STATE_LABEL and STATE_CLASS have been
// removed. The contract-state pill renders through `<StatusPill>`,
// which pulls its label + colour from the centralised status palette.

export default function ContractDetailPage() {
  const params = useParams<{ contractId: string }>();
  const router = useRouter();
  const contractId = params.contractId;

  // Story 3.7 — admin-only void workflow state.
  const voidContract = useMutation(voidContractRef);
  const [voidDialogOpen, setVoidDialogOpen] = useState(false);

  // Story 4.4 — admin-only "mark in default" workflow state (FR37).
  const markContractInDefault = useMutation(markContractInDefaultRef);
  const [markInDefaultDialogOpen, setMarkInDefaultDialogOpen] =
    useState(false);

  // Story 4.5 — admin-only "reclaim lot" workflow state (FR38). Only
  // surfaced when `detail.state === "in_default"`; the button stays
  // hidden in all other contract states and for all other roles.
  const reclaimLot = useMutation(reclaimLotRef);
  const [reclaimDialogOpen, setReclaimDialogOpen] = useState(false);


  // Story 5.4 — admin-only flag workflow state.
  const flagContract = useMutation(flagContractRef);
  const unflagContract = useMutation(unflagContractRef);
  const [flagDialogOpen, setFlagDialogOpen] = useState(false);
  const [unflagError, setUnflagError] = useState<string | null>(null);
  const auth = useQuery(getCurrentUserOrNullRef, {});
  const isAdmin = (auth?.roles ?? []).includes("admin");

  const detail = useQuery(getContractRef, { contractId });

  // Story 6.1: reactive PDF state. The query returns
  // `{ url: null, generatedAt: null }` until the first PDF lands; once
  // the scheduled action's callback mutation patches the contract row,
  // Convex re-runs this query and `url` becomes a signed download URL.
  const pdfState = useQuery(getContractPdfUrlRef, { contractId });
  const generateContractPdf = useMutation(generateContractPdfRequestRef);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // Story 6.2: reactive demand-letter state. Same pattern as the
  // contract PDF — the query returns `{ url: null, generatedAt: null }`
  // until the first demand letter lands, then the scheduled action's
  // callback patches `demandLetterStorageId` and Convex re-runs this
  // query. The overdue summary tells the UI whether to expose the
  // generate button at all (the server mutation enforces the same gate
  // per AC2 / NFR-S4 — UI is defense in depth).
  const demandLetterState = useQuery(getDemandLetterUrlRef, { contractId });
  const overdueSummary = useQuery(getContractOverdueSummaryRef, {
    contractId,
  });
  const generateDemandLetter = useMutation(generateDemandLetterRequestRef);
  const [isGeneratingDemandLetter, setIsGeneratingDemandLetter] =
    useState(false);
  const [demandLetterError, setDemandLetterError] = useState<string | null>(
    null,
  );

  // The user's most recent click sets `requestedAt`; when the query's
  // `generatedAt` advances past it, we clear the in-flight flag so the
  // button re-enables and the success state shows. This is the same
  // pattern Story 1.14's photo-upload uses for "reactively detect that
  // the side-channel work landed".
  const [requestedAt, setRequestedAt] = useState<number | null>(null);
  useEffect(() => {
    if (
      requestedAt !== null &&
      pdfState !== undefined &&
      pdfState.generatedAt !== null &&
      pdfState.generatedAt >= requestedAt
    ) {
      setIsGenerating(false);
      setRequestedAt(null);
    }
  }, [pdfState, requestedAt]);

  // Story 6.2 — same "request-time vs. server `generatedAt`" cadence as
  // the contract-PDF flow above, but for the demand-letter side-channel.
  const [demandLetterRequestedAt, setDemandLetterRequestedAt] = useState<
    number | null
  >(null);
  useEffect(() => {
    if (
      demandLetterRequestedAt !== null &&
      demandLetterState !== undefined &&
      demandLetterState.generatedAt !== null &&
      demandLetterState.generatedAt >= demandLetterRequestedAt
    ) {
      setIsGeneratingDemandLetter(false);
      setDemandLetterRequestedAt(null);
    }
  }, [demandLetterState, demandLetterRequestedAt]);

  /**
   * Story 3.7 — submits the void to the server. On success, route back
   * to the contracts list so the operator sees the updated catalogue
   * (which now excludes the voided contract under default filters).
   * The dialog itself handles per-attempt error display; this handler
   * re-throws so the dialog can render `INVARIANT_VIOLATION` / role
   * errors inline at the top of the form.
   */
  async function handleVoidContract(reason: string): Promise<void> {
    await voidContract({ contractId, reason });
    setVoidDialogOpen(false);
    router.push("/sales");
  }

  /**
   * Story 4.4 (FR37) — submits the "mark in default" request to the
   * server. On success we close the dialog and let the reactive
   * `getContract` subscription flip the state pill from "Active" to
   * "In default" without a page reload — that reactive flip IS the
   * confirmation. Unlike `handleVoidContract` we do NOT navigate away
   * from the page; the contract is still operationally relevant
   * (collections workflow, eventual reinstate-or-reclaim), so the
   * admin stays on its detail view.
   *
   * Errors propagate to the dialog, which renders them inline via
   * `role="alert"`. The dialog maps the verbose server error string
   * directly; the operator-friendly translation lives there.
   */
  async function handleMarkInDefault(reason: string): Promise<void> {
    await markContractInDefault({ contractId, reason });
    setMarkInDefaultDialogOpen(false);
  }

  /**
   * Story 4.5 (FR38) — submits the "reclaim lot" request to the
   * server. The mutation atomically voids the contract, returns the
   * lot to `available`, and emits the audit trail. On success we
   * close the dialog and navigate to `/sales` — the contract is now
   * terminal (voided) and the operator's most useful next step is
   * back to the sales catalogue where the freshly-available lot can
   * be re-sold. Errors propagate to the dialog, which renders them
   * inline via `role="alert"`.
   */
  async function handleReclaimLot(reason: string): Promise<void> {
    await reclaimLot({ contractId, reason });
    setReclaimDialogOpen(false);
    router.push("/sales");
  }

  /**
   * Story 5.4 — submits the flag-or-update-reason to the server. The
   * mutation handles whether the contract is freshly flagged or
   * re-flagged (admin updating an existing reason). On success we close
   * the dialog; the reactive `getContract` subscription will refresh
   * the `isFlagged` state without a page reload, and Maria's dashboard
   * tile updates over the same reactivity. Per Story 5.4 § Disaster
   * prevention, there is NO success toast on the admin's side — the
   * reactive UI change IS the confirmation.
   */
  async function handleFlagContract(reason: string): Promise<void> {
    await flagContract({ contractId, reason });
    setFlagDialogOpen(false);
  }

  /**
   * Story 5.4 — clears the flag. Idempotent on the server; the UI
   * surfaces failures inline (rare, normally a transient network /
   * auth issue) rather than throwing.
   */
  async function handleUnflagContract(): Promise<void> {
    setUnflagError(null);
    try {
      await unflagContract({ contractId });
    } catch (err: unknown) {
      setUnflagError(
        err instanceof Error
          ? err.message
          : "Failed to clear flag. Please try again.",
      );
    }
  }

  async function handleGeneratePdf(): Promise<void> {
    setGenerateError(null);
    setIsGenerating(true);
    const requestTime = Date.now();
    setRequestedAt(requestTime);
    try {
      await generateContractPdf({ contractId });
    } catch (err: unknown) {
      setIsGenerating(false);
      setRequestedAt(null);
      setGenerateError(
        err instanceof Error
          ? err.message
          : "Failed to schedule PDF generation.",
      );
    }
  }

  /**
   * Story 6.2 — submits the demand-letter request to the server. The
   * mutation re-checks the overdue gate server-side and throws
   * VALIDATION if the contract no longer has overdue installments
   * (e.g. a payment cleared between the page load and the click). The
   * handler surfaces the server message inline so the operator can
   * re-evaluate without a page reload.
   */
  async function handleGenerateDemandLetter(): Promise<void> {
    setDemandLetterError(null);
    setIsGeneratingDemandLetter(true);
    const requestTime = Date.now();
    setDemandLetterRequestedAt(requestTime);
    try {
      await generateDemandLetter({ contractId });
    } catch (err: unknown) {
      setIsGeneratingDemandLetter(false);
      setDemandLetterRequestedAt(null);
      setDemandLetterError(
        err instanceof Error
          ? err.message
          : "Failed to schedule demand letter generation.",
      );
    }
  }

  useEffect(() => {
    if (detail !== undefined) {
      document.title = `${detail.contractNumber} · Broadheader`;
    }
  }, [detail]);

  if (detail === undefined) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <h1 className="text-3xl font-bold tracking-tight">Contract</h1>
        <div
          data-testid="contract-detail-loading"
          className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500"
        >
          Loading contract…
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1
            className="text-3xl font-bold tracking-tight"
            data-testid="contract-detail-number"
          >
            {detail.contractNumber}
          </h1>
          {/* Story 5.4 (FR44) — visual indicator that this contract is
           *   flagged for staff follow-up. The amber pill mirrors the
           *   StatusPill amber tone used on the dashboard tile so the
           *   visual association is calm and immediate. */}
          {detail.isFlagged && (
            <span
              data-testid="contract-detail-flag-indicator"
              aria-label="Flagged for staff follow-up"
              title="Flagged for staff follow-up"
              className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900"
            >
              <span aria-hidden="true">⚑</span>
              <span>Flagged</span>
            </span>
          )}
        </div>
        <Link
          href="/sales"
          className="text-sm text-slate-600 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
        >
          ← Back to sales
        </Link>
      </div>

      <div className="rounded-md border border-slate-200 bg-white p-6">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">
              Lot
            </dt>
            <dd className="text-sm font-medium text-slate-900">
              <Link
                href={`/lots/${detail.lotId}`}
                className="underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
              >
                {detail.lotCode}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">
              Customer
            </dt>
            <dd className="text-sm font-medium text-slate-900">
              <Link
                href={`/customers/${detail.customerId}`}
                className="underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
              >
                {detail.customerFullName}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">
              Total price
            </dt>
            <dd
              className="text-sm font-medium tabular-nums text-slate-900"
              data-testid="contract-detail-total"
            >
              {formatPeso(detail.totalPriceCents)}
            </dd>
          </div>
          {detail.perpetualCareCents !== undefined &&
            detail.perpetualCareCents > 0 && (
              <div className="sm:col-span-2">
                <dt className="text-xs uppercase tracking-wide text-slate-500">
                  Perpetual care fee
                </dt>
                <dd
                  className="text-sm font-medium tabular-nums text-slate-900"
                  data-testid="contract-detail-perpetual-care"
                >
                  {formatPeso(detail.perpetualCareCents)}
                  {detail.perpetualCarePaidCents !== undefined && (
                    <span
                      className="ml-2 text-xs text-slate-500"
                      data-testid="contract-detail-perpetual-care-paid"
                    >
                      ({formatPeso(detail.perpetualCarePaidCents)} paid)
                    </span>
                  )}
                  {detail.perpetualCareReason !== undefined &&
                    detail.perpetualCareReason.length > 0 && (
                      <p
                        className="mt-1 text-xs font-normal text-slate-500"
                        data-testid="contract-detail-perpetual-care-reason"
                      >
                        Reason: {detail.perpetualCareReason}
                      </p>
                    )}
                </dd>
              </div>
            )}
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">
              Kind
            </dt>
            <dd className="text-sm font-medium text-slate-900">
              {detail.kind === "full_payment" ? "Full payment" : "Installment"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">
              State
            </dt>
            <dd>
              <span data-testid="contract-detail-state">
                <StatusPill status={detail.state} size="sm" />
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">
              Created
            </dt>
            <dd className="text-sm font-medium text-slate-900">
              {formatDate(detail.createdAt, "short")}
            </dd>
          </div>
          {detail.receiptNumber !== undefined && (
            <div className="sm:col-span-2">
              <dt className="text-xs uppercase tracking-wide text-slate-500">
                Receipt
              </dt>
              <dd
                className="text-sm font-medium tabular-nums text-slate-900"
                data-testid="contract-detail-receipt"
              >
                {detail.receiptNumber}
              </dd>
            </div>
          )}
        </dl>
      </div>

      {/* Story 6.1 — Contract PDF generation + download (FR49).
       *   Shows current PDF state (never-generated / ready / generating)
       *   and offers a button that schedules a Node-runtime action to
       *   render + store the document. The button stays available after
       *   the first generation so an operator can regenerate after the
       *   contract is amended (regeneration overwrites the prior blob —
       *   versioned history is a future story per the schema JSDoc). */}
      <div
        data-testid="contract-pdf-card"
        className="rounded-md border border-slate-200 bg-white p-6"
      >
        <h2 className="text-lg font-semibold text-slate-900">
          Contract document
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Generate a formal multi-page contract PDF with the cemetery
          letterhead, parties, lot details, installment schedule, terms,
          and signature blocks.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleGeneratePdf}
            disabled={isGenerating || pdfState === undefined}
            data-testid="contract-pdf-generate-button"
            className="inline-flex items-center rounded-md border border-slate-900 bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isGenerating
              ? "Generating…"
              : pdfState?.url !== null && pdfState?.url !== undefined
                ? "Regenerate PDF"
                : "Generate contract PDF"}
          </button>
          {pdfState?.url !== null &&
            pdfState?.url !== undefined &&
            !isGenerating && (
              <a
                href={pdfState.url}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="contract-pdf-download-link"
                className="inline-flex items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 shadow-sm hover:bg-slate-50"
              >
                Download PDF
              </a>
            )}
        </div>

        {generateError !== null && (
          <p
            data-testid="contract-pdf-error"
            className="mt-3 text-sm text-red-700"
          >
            {generateError}
          </p>
        )}

        {pdfState !== undefined && pdfState.generatedAt !== null && (
          <p
            data-testid="contract-pdf-generated-at"
            className="mt-3 text-xs text-slate-500"
          >
            Last generated{" "}
            {formatDate(pdfState.generatedAt, "short")} · Click Regenerate
            to refresh.
          </p>
        )}

        {pdfState !== undefined &&
          pdfState.url === null &&
          !isGenerating && (
            <p
              data-testid="contract-pdf-empty-state"
              className="mt-3 text-xs text-slate-500"
            >
              No PDF generated yet for this contract.
            </p>
          )}

        {isGenerating && (
          <p
            data-testid="contract-pdf-generating"
            className="mt-3 text-xs text-slate-500"
          >
            Generating the PDF — this usually takes a few seconds. The
            download link will appear automatically.
          </p>
        )}
      </div>

      {/* Story 6.2 — Demand-letter PDF generation + download (FR50).
       *   Only rendered when the contract has at least one overdue
       *   installment per the server-side overdue gate enforced by
       *   `generateDemandLetterRequest`. The UI mirrors that gate via
       *   `overdueSummary.isOverdue`; the server is the authoritative
       *   gate (NFR-S4 — UI-only enforcement is a non-compliance
       *   defect). Once at least one demand letter has been generated,
       *   the card stays visible (with the prior letter downloadable)
       *   even if subsequent payments clear the overdue balance — the
       *   historical record of issued letters is the operator-facing
       *   value. The button is gated on current overdue state. */}
      {overdueSummary !== undefined &&
        (overdueSummary.isOverdue ||
          (demandLetterState !== undefined &&
            demandLetterState.url !== null)) && (
          <div
            data-testid="contract-demand-letter-card"
            className="rounded-md border border-slate-200 bg-white p-6"
          >
            <h2 className="text-lg font-semibold text-slate-900">
              Demand letter
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Generate a formal demand letter as a PDF for the
              customer&apos;s overdue balance. Includes the cemetery
              letterhead, contract reference, overdue installments, and
              a 30-day demand for payment.
            </p>

            {overdueSummary.isOverdue && (
              <p
                data-testid="contract-demand-letter-overdue-summary"
                className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
              >
                <span className="font-medium">
                  {overdueSummary.overdueCount}
                </span>{" "}
                installment{overdueSummary.overdueCount === 1 ? "" : "s"}{" "}
                currently overdue —{" "}
                <span className="font-medium tabular-nums">
                  {formatPeso(overdueSummary.totalOverdueCents)}
                </span>{" "}
                total balance.
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  void handleGenerateDemandLetter();
                }}
                disabled={
                  isGeneratingDemandLetter ||
                  demandLetterState === undefined ||
                  !overdueSummary.isOverdue
                }
                data-testid="contract-demand-letter-generate-button"
                aria-describedby={
                  !overdueSummary.isOverdue
                    ? "contract-demand-letter-not-overdue-hint"
                    : undefined
                }
                className="inline-flex items-center rounded-md border border-slate-900 bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isGeneratingDemandLetter
                  ? "Generating…"
                  : demandLetterState?.url !== null &&
                      demandLetterState?.url !== undefined
                    ? "Regenerate demand letter"
                    : "Generate demand letter"}
              </button>
              {demandLetterState?.url !== null &&
                demandLetterState?.url !== undefined &&
                !isGeneratingDemandLetter && (
                  <a
                    href={demandLetterState.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="contract-demand-letter-download-link"
                    className="inline-flex items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 shadow-sm hover:bg-slate-50"
                  >
                    Download demand letter
                  </a>
                )}
            </div>

            {!overdueSummary.isOverdue && (
              <p
                id="contract-demand-letter-not-overdue-hint"
                data-testid="contract-demand-letter-not-overdue-hint"
                className="mt-3 text-xs text-slate-500"
              >
                Demand letter generation is only available while the
                contract has overdue installments. The prior letter
                remains available for download.
              </p>
            )}

            {demandLetterError !== null && (
              <p
                data-testid="contract-demand-letter-error"
                role="alert"
                className="mt-3 text-sm text-red-700"
              >
                {demandLetterError}
              </p>
            )}

            {demandLetterState !== undefined &&
              demandLetterState.generatedAt !== null && (
                <p
                  data-testid="contract-demand-letter-generated-at"
                  className="mt-3 text-xs text-slate-500"
                >
                  Last generated{" "}
                  {formatDate(demandLetterState.generatedAt, "short")}.
                </p>
              )}

            {isGeneratingDemandLetter && (
              <p
                data-testid="contract-demand-letter-generating"
                className="mt-3 text-xs text-slate-500"
              >
                Generating the demand letter — the download link will
                appear automatically once it&apos;s ready.
              </p>
            )}
          </div>
        )}

      {/* Story 5.4 (FR44) — admin flag-for-follow-up affordance + active
       *   flag display. The "Flag" / "Update flag" / "Clear flag" buttons
       *   are admin-only at the UI layer (cosmetic; the mutations re-check
       *   server-side). The current-flag panel surfaces below for both
       *   roles so office staff understand WHY a contract is flagged
       *   when they navigate from their dashboard. */}
      <div
        data-testid="contract-flag-card"
        className={`rounded-md border p-6 ${
          detail.isFlagged
            ? "border-amber-200 bg-amber-50"
            : "border-slate-200 bg-white"
        }`}
      >
        <h2
          className={`text-lg font-semibold ${
            detail.isFlagged ? "text-amber-900" : "text-slate-900"
          }`}
        >
          {detail.isFlagged
            ? "Flagged for staff follow-up"
            : "Staff follow-up"}
        </h2>
        {detail.isFlagged ? (
          <div className="mt-2 space-y-2 text-sm text-amber-900">
            <p
              data-testid="contract-flag-reason"
              className="rounded-md border border-amber-200 bg-white px-3 py-2 text-slate-800"
            >
              {detail.flagReason}
            </p>
            <p
              className="text-xs text-amber-800"
              data-testid="contract-flag-meta"
            >
              Flagged by{" "}
              <span className="font-medium">
                {detail.flaggedByName ?? "Unknown admin"}
              </span>
              {detail.flaggedAt !== undefined && (
                <>
                  {" "}on {formatDate(detail.flaggedAt, "short")}
                </>
              )}
              .
            </p>
          </div>
        ) : (
          <p className="mt-1 text-sm text-slate-600">
            Admins can flag this contract for staff attention. Maria&apos;s
            dashboard updates within a second.
          </p>
        )}
        {isAdmin && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-testid="contract-flag-button"
              onClick={() => setFlagDialogOpen(true)}
              className="inline-flex min-h-[44px] items-center rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-amber-700"
            >
              {detail.isFlagged ? "Update flag" : "Flag for follow-up"}
            </button>
            {detail.isFlagged && (
              <button
                type="button"
                data-testid="contract-unflag-button"
                onClick={() => {
                  void handleUnflagContract();
                }}
                className="inline-flex min-h-[44px] items-center rounded-md border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-900 shadow-sm hover:bg-amber-100"
              >
                Clear flag
              </button>
            )}
          </div>
        )}
        {unflagError !== null && (
          <p
            data-testid="contract-unflag-error"
            role="alert"
            className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
          >
            {unflagError}
          </p>
        )}
      </div>

      <FlagContractDialog
        open={flagDialogOpen}
        onClose={() => setFlagDialogOpen(false)}
        onConfirm={handleFlagContract}
        contractNumber={detail.contractNumber}
        initialReason={detail.flagReason}
      />

      {/* Story 3.7 — admin pre-interment void affordance (FR24). The
       *   button is only rendered while the contract is `active`;
       *   terminal contracts (paid_in_full / cancelled / voided /
       *   in_default) hide the affordance. The dialog itself enforces
       *   the reason floor and exposes the destructive copy. */}
      {detail.state === "active" && (
        <div
          data-testid="contract-void-card"
          className="rounded-md border border-rose-200 bg-rose-50 p-6"
        >
          <h2 className="text-lg font-semibold text-rose-900">
            Void contract
          </h2>
          <p className="mt-1 text-sm text-rose-800">
            Admin-only. Voiding the contract reverts the lot to{" "}
            <span className="font-semibold">Available</span> and closes
            the customer&apos;s ownership today. Receipts already issued
            remain valid.
          </p>
          <button
            type="button"
            data-testid="contract-void-button"
            onClick={() => setVoidDialogOpen(true)}
            className="mt-4 inline-flex items-center rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-rose-700"
          >
            Void contract
          </button>
        </div>
      )}

      <VoidContractDialog
        open={voidDialogOpen}
        onClose={() => setVoidDialogOpen(false)}
        onConfirm={handleVoidContract}
        contractNumber={detail.contractNumber}
        lotCode={detail.lotCode}
        customerName={detail.customerFullName}
      />

      {/* Story 4.4 (FR37) — admin "Mark in default" affordance. The
       *   card is admin-only and only shown when the contract is
       *   currently `active` AND has at least one overdue installment.
       *   Defaulting is structurally distinct from voiding — the lot
       *   stays sold and ownership intact (default ≠ reclaim per
       *   FR37 / FR38). Reclaim is a separate Story 4.5 action. */}
      {isAdmin &&
        detail.state === "active" &&
        overdueSummary?.isOverdue === true && (
          <div
            data-testid="contract-mark-in-default-card"
            className="rounded-md border border-amber-200 bg-amber-50 p-6"
          >
            <h2 className="text-lg font-semibold text-amber-900">
              Mark contract as in-default
            </h2>
            <p className="mt-1 text-sm text-amber-900">
              Admin-only. Routes this contract into the collections
              workflow and re-categorises it under the &quot;In
              Default&quot; AR aging bucket. The lot{" "}
              <span className="font-semibold">stays sold</span> until
              the separate reclaim action is taken.
            </p>
            <button
              type="button"
              data-testid="contract-mark-in-default-button"
              onClick={() => setMarkInDefaultDialogOpen(true)}
              className="mt-4 inline-flex min-h-[44px] items-center rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-rose-700"
            >
              Mark in default
            </button>
          </div>
        )}

      <MarkInDefaultDialog
        open={markInDefaultDialogOpen}
        onClose={() => setMarkInDefaultDialogOpen(false)}
        onConfirm={handleMarkInDefault}
        contractNumber={detail.contractNumber}
        lotCode={detail.lotCode}
        customerName={detail.customerFullName}
      />

      {/* Story 4.5 (FR38) — admin "Reclaim lot" affordance. The card
       *   is admin-only and only shown when the contract is in
       *   `in_default`. Reclaim is the intentional separate action
       *   that returns the lot to inventory after a defaulted
       *   contract is deemed unrecoverable (default ≠ reclaim per
       *   FR37 / FR38). Other contract states hide the affordance
       *   entirely. */}
      {isAdmin && detail.state === "in_default" && (
        <div
          data-testid="contract-reclaim-lot-card"
          className="rounded-md border border-rose-200 bg-rose-50 p-6"
        >
          <h2 className="text-lg font-semibold text-rose-900">
            Reclaim lot
          </h2>
          <p className="mt-1 text-sm text-rose-800">
            Admin-only. Voids this contract and returns lot{" "}
            <span className="font-semibold">{detail.lotCode}</span> to
            the available inventory. Closes the customer&apos;s
            ownership record. Receipts already issued remain valid.
          </p>
          <button
            type="button"
            data-testid="contract-reclaim-lot-button"
            onClick={() => setReclaimDialogOpen(true)}
            title="Returns the lot to available, voids the contract, and closes the ownership record."
            className="mt-4 inline-flex min-h-[44px] items-center rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-rose-700"
          >
            Reclaim lot
          </button>
        </div>
      )}

      <ReclaimLotDialog
        open={reclaimDialogOpen}
        onClose={() => setReclaimDialogOpen(false)}
        onConfirm={handleReclaimLot}
        contractNumber={detail.contractNumber}
        lotCode={detail.lotCode}
        customerName={detail.customerFullName}
      />

      {/* TODO Story 3.6: replace this stub with the full contract
       *   timeline (payment list, transition controls, void / cancel
       *   actions, ownership history). The minimal view above is the
       *   safe redirect target for Story 3.3's recordFullPaymentSale
       *   in the interim. */}
      <p className="text-xs text-slate-500">
        Full timeline view (payments, transitions, void / cancel) ships in
        Story 3.6.
      </p>
    </div>
  );
}
