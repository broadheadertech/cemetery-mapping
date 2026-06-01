/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actions_archivalExport from "../actions/archivalExport.js";
import type * as actions_gatewayCreateIntent from "../actions/gatewayCreateIntent.js";
import type * as actions_generateContractPdf from "../actions/generateContractPdf.js";
import type * as actions_generateDemandLetterPdf from "../actions/generateDemandLetterPdf.js";
import type * as actions_generatePlaquePdf from "../actions/generatePlaquePdf.js";
import type * as actions_generateReceiptPdf from "../actions/generateReceiptPdf.js";
import type * as actions_generateReportExport from "../actions/generateReportExport.js";
import type * as actions_sendAccountEmailChanged from "../actions/sendAccountEmailChanged.js";
import type * as actions_sendEmailReminder from "../actions/sendEmailReminder.js";
import type * as arAging from "../arAging.js";
import type * as archivalExportInternal from "../archivalExportInternal.js";
import type * as archivalExports from "../archivalExports.js";
import type * as auditLogQueries from "../auditLogQueries.js";
import type * as auth from "../auth.js";
import type * as authRateLimit from "../authRateLimit.js";
import type * as birExport from "../birExport.js";
import type * as cemeterySettings from "../cemeterySettings.js";
import type * as ceremonies from "../ceremonies.js";
import type * as conditionLogs from "../conditionLogs.js";
import type * as contracts from "../contracts.js";
import type * as crons from "../crons.js";
import type * as customerDocuments from "../customerDocuments.js";
import type * as customers from "../customers.js";
import type * as dashboard from "../dashboard.js";
import type * as dataSubject from "../dataSubject.js";
import type * as expenseApprovalSettings from "../expenseApprovalSettings.js";
import type * as expenseCategories from "../expenseCategories.js";
import type * as expenses from "../expenses.js";
import type * as exports from "../exports.js";
import type * as familyEstates from "../familyEstates.js";
import type * as followUpActions from "../followUpActions.js";
import type * as generateContractPdfInternal from "../generateContractPdfInternal.js";
import type * as generateDemandLetterPdfInternal from "../generateDemandLetterPdfInternal.js";
import type * as gpsImport from "../gpsImport.js";
import type * as healthCheck from "../healthCheck.js";
import type * as http from "../http.js";
import type * as installments from "../installments.js";
import type * as interments from "../interments.js";
import type * as internal_backfillCeremoniesKind from "../internal/backfillCeremoniesKind.js";
import type * as internal_backfillLotSections from "../internal/backfillLotSections.js";
import type * as internal_bootstrapFirstAdmin from "../internal/bootstrapFirstAdmin.js";
import type * as lib_archivalExportPath from "../lib/archivalExportPath.js";
import type * as lib_archivalPeriods from "../lib/archivalPeriods.js";
import type * as lib_archivalQueries from "../lib/archivalQueries.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_birFormat from "../lib/birFormat.js";
import type * as lib_brandAssets from "../lib/brandAssets.js";
import type * as lib_dashboardCounters from "../lib/dashboardCounters.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_expenseCategories from "../lib/expenseCategories.js";
import type * as lib_geometry from "../lib/geometry.js";
import type * as lib_installmentSchedule from "../lib/installmentSchedule.js";
import type * as lib_money from "../lib/money.js";
import type * as lib_passwords from "../lib/passwords.js";
import type * as lib_paymentGateways_cardAdapter from "../lib/paymentGateways/cardAdapter.js";
import type * as lib_paymentGateways_gcashAdapter from "../lib/paymentGateways/gcashAdapter.js";
import type * as lib_paymentGateways_index from "../lib/paymentGateways/index.js";
import type * as lib_paymentGateways_mayaAdapter from "../lib/paymentGateways/mayaAdapter.js";
import type * as lib_paymentGateways_types from "../lib/paymentGateways/types.js";
import type * as lib_perpetualCare from "../lib/perpetualCare.js";
import type * as lib_piiAccess from "../lib/piiAccess.js";
import type * as lib_postFinancialEvent from "../lib/postFinancialEvent.js";
import type * as lib_receiptCounter from "../lib/receiptCounter.js";
import type * as lib_receiptCounterTesting from "../lib/receiptCounterTesting.js";
import type * as lib_reminderTemplates from "../lib/reminderTemplates.js";
import type * as lib_roman from "../lib/roman.js";
import type * as lib_scheduling from "../lib/scheduling.js";
import type * as lib_seedBirReceiptConfig from "../lib/seedBirReceiptConfig.js";
import type * as lib_stateMachines from "../lib/stateMachines.js";
import type * as lib_states from "../lib/states.js";
import type * as lib_time from "../lib/time.js";
import type * as lots from "../lots.js";
import type * as occupants from "../occupants.js";
import type * as ownerships from "../ownerships.js";
import type * as payments from "../payments.js";
import type * as pdfRetrySweep from "../pdfRetrySweep.js";
import type * as perpetualCare from "../perpetualCare.js";
import type * as phasePlanning from "../phasePlanning.js";
import type * as plaqueDrafts from "../plaqueDrafts.js";
import type * as portal from "../portal.js";
import type * as portalInvites from "../portalInvites.js";
import type * as receipts from "../receipts.js";
import type * as reconciliation from "../reconciliation.js";
import type * as reminders from "../reminders.js";
import type * as reports from "../reports.js";
import type * as search from "../search.js";
import type * as sections from "../sections.js";
import type * as seed from "../seed.js";
import type * as trends from "../trends.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "actions/archivalExport": typeof actions_archivalExport;
  "actions/gatewayCreateIntent": typeof actions_gatewayCreateIntent;
  "actions/generateContractPdf": typeof actions_generateContractPdf;
  "actions/generateDemandLetterPdf": typeof actions_generateDemandLetterPdf;
  "actions/generatePlaquePdf": typeof actions_generatePlaquePdf;
  "actions/generateReceiptPdf": typeof actions_generateReceiptPdf;
  "actions/generateReportExport": typeof actions_generateReportExport;
  "actions/sendAccountEmailChanged": typeof actions_sendAccountEmailChanged;
  "actions/sendEmailReminder": typeof actions_sendEmailReminder;
  arAging: typeof arAging;
  archivalExportInternal: typeof archivalExportInternal;
  archivalExports: typeof archivalExports;
  auditLogQueries: typeof auditLogQueries;
  auth: typeof auth;
  authRateLimit: typeof authRateLimit;
  birExport: typeof birExport;
  cemeterySettings: typeof cemeterySettings;
  ceremonies: typeof ceremonies;
  conditionLogs: typeof conditionLogs;
  contracts: typeof contracts;
  crons: typeof crons;
  customerDocuments: typeof customerDocuments;
  customers: typeof customers;
  dashboard: typeof dashboard;
  dataSubject: typeof dataSubject;
  expenseApprovalSettings: typeof expenseApprovalSettings;
  expenseCategories: typeof expenseCategories;
  expenses: typeof expenses;
  exports: typeof exports;
  familyEstates: typeof familyEstates;
  followUpActions: typeof followUpActions;
  generateContractPdfInternal: typeof generateContractPdfInternal;
  generateDemandLetterPdfInternal: typeof generateDemandLetterPdfInternal;
  gpsImport: typeof gpsImport;
  healthCheck: typeof healthCheck;
  http: typeof http;
  installments: typeof installments;
  interments: typeof interments;
  "internal/backfillCeremoniesKind": typeof internal_backfillCeremoniesKind;
  "internal/backfillLotSections": typeof internal_backfillLotSections;
  "internal/bootstrapFirstAdmin": typeof internal_bootstrapFirstAdmin;
  "lib/archivalExportPath": typeof lib_archivalExportPath;
  "lib/archivalPeriods": typeof lib_archivalPeriods;
  "lib/archivalQueries": typeof lib_archivalQueries;
  "lib/audit": typeof lib_audit;
  "lib/auth": typeof lib_auth;
  "lib/birFormat": typeof lib_birFormat;
  "lib/brandAssets": typeof lib_brandAssets;
  "lib/dashboardCounters": typeof lib_dashboardCounters;
  "lib/errors": typeof lib_errors;
  "lib/expenseCategories": typeof lib_expenseCategories;
  "lib/geometry": typeof lib_geometry;
  "lib/installmentSchedule": typeof lib_installmentSchedule;
  "lib/money": typeof lib_money;
  "lib/passwords": typeof lib_passwords;
  "lib/paymentGateways/cardAdapter": typeof lib_paymentGateways_cardAdapter;
  "lib/paymentGateways/gcashAdapter": typeof lib_paymentGateways_gcashAdapter;
  "lib/paymentGateways/index": typeof lib_paymentGateways_index;
  "lib/paymentGateways/mayaAdapter": typeof lib_paymentGateways_mayaAdapter;
  "lib/paymentGateways/types": typeof lib_paymentGateways_types;
  "lib/perpetualCare": typeof lib_perpetualCare;
  "lib/piiAccess": typeof lib_piiAccess;
  "lib/postFinancialEvent": typeof lib_postFinancialEvent;
  "lib/receiptCounter": typeof lib_receiptCounter;
  "lib/receiptCounterTesting": typeof lib_receiptCounterTesting;
  "lib/reminderTemplates": typeof lib_reminderTemplates;
  "lib/roman": typeof lib_roman;
  "lib/scheduling": typeof lib_scheduling;
  "lib/seedBirReceiptConfig": typeof lib_seedBirReceiptConfig;
  "lib/stateMachines": typeof lib_stateMachines;
  "lib/states": typeof lib_states;
  "lib/time": typeof lib_time;
  lots: typeof lots;
  occupants: typeof occupants;
  ownerships: typeof ownerships;
  payments: typeof payments;
  pdfRetrySweep: typeof pdfRetrySweep;
  perpetualCare: typeof perpetualCare;
  phasePlanning: typeof phasePlanning;
  plaqueDrafts: typeof plaqueDrafts;
  portal: typeof portal;
  portalInvites: typeof portalInvites;
  receipts: typeof receipts;
  reconciliation: typeof reconciliation;
  reminders: typeof reminders;
  reports: typeof reports;
  search: typeof search;
  sections: typeof sections;
  seed: typeof seed;
  trends: typeof trends;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
