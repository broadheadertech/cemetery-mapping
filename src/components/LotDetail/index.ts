/**
 * Story 1.11 — LotDetail public surface.
 *
 * The orchestrator (`LotDetail`) is the canonical export; the
 * subcomponents are also exported for downstream stories that want to
 * compose them differently (e.g. a printable report could reuse the
 * facts panel without the condition log).
 */

export { LotDetail } from "./LotDetail";
export type { LotDetailData, LotDetailProps } from "./LotDetail";
export { LotFactsPanel } from "./LotFactsPanel";
export type { LotFactsData, LotFactsPanelProps } from "./LotFactsPanel";
export { OwnershipPanel } from "./OwnershipPanel";
export type { OwnershipPanelProps } from "./OwnershipPanel";
export { OccupantsPanel } from "./OccupantsPanel";
export type { Occupant, OccupantsPanelProps } from "./OccupantsPanel";
export { ActiveContractPanel } from "./ActiveContractPanel";
export type {
  ActiveContract,
  ActiveContractPanelProps,
} from "./ActiveContractPanel";
export { PaymentHistoryPlaceholder } from "./PaymentHistoryPlaceholder";
export { ConditionLogsPanel } from "./ConditionLogsPanel";
export type { ConditionLogsPanelProps } from "./ConditionLogsPanel";
export { LotDetailSkeleton } from "./LotDetailSkeleton";
