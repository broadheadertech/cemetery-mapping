import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

/**
 * Canonical data model for the Income & Expense Tracker.
 *
 * Source of truth: `money-movement-taxonomy.md` v0.3.0. Section
 * references below (§1, §6.2, …) point at that document. If the two
 * ever disagree, the taxonomy wins and this file is wrong.
 *
 * ---------------------------------------------------------------
 * THE ONE IDEA THIS SCHEMA IS BUILT AROUND (taxonomy §1)
 * ---------------------------------------------------------------
 * Recognition and cash movement are different events that happen on
 * different days. Rent accrues on the 1st and is paid on the 5th.
 * Collapsing them into one row is the failure mode the taxonomy was
 * written to prevent, so they are two tables here:
 *
 *   `obligations`    — the expense/income EXISTS. Drives P&L and the
 *                      "expense recognized" reporting column. Carries
 *                      the due date, so it also drives reminders (§9).
 *   `moneyMovements` — money physically MOVED. Drives the cash balance
 *                      and every balance column of the daily tracker
 *                      (§10).
 *
 * A movement may point at an obligation (paying a bill) or stand alone
 * (a cash sale, an owner withdrawal). An obligation may sit unpaid with
 * no movement at all. Neither table is derivable from the other.
 *
 * ---------------------------------------------------------------
 * CONVEX-SPECIFIC NOTES (taxonomy §11 — read it before editing)
 * ---------------------------------------------------------------
 * Convex gives us serializable transactions and optimistic concurrency
 * for free, but it has NO unique constraints, NO check constraints, NO
 * foreign keys and NO migrations. Three consequences run through this
 * file:
 *
 *   1. Every invariant the taxonomy calls non-negotiable is enforced in
 *      a mutation helper plus a lint rule, never by the database. Where
 *      that applies it is marked ENFORCED IN CODE with the name of the
 *      helper that owns it.
 *   2. Uniqueness (cheque number per account, generator idempotency
 *      key) is a read-then-insert inside one mutation. That is safe
 *      here only because Convex mutations are serializable — the
 *      automatic retry on write conflict is what closes the race. See
 *      QUERY_PERFORMANCE.md §3.
 *   3. Schema change is additive: new fields land as `v.optional(...)`
 *      and are backfilled by an internal mutation. There is no
 *      migration file, so "never edit a shipped migration" becomes
 *      "never make an existing field required without a backfill".
 *
 * Money is ALWAYS an integer number of centavos (taxonomy §11.2).
 * Fields are suffixed `Cents` so raw arithmetic on them can be caught
 * by lint and routed through `convex/lib/money.ts`.
 *
 * Timestamps are unix milliseconds. Business DATES (a due date, a
 * ledger day) are ALSO stored as `YYYY-MM-DD` strings in the tenant
 * timezone, so day-boundary queries never depend on the server clock.
 * See `convex/lib/time.ts`.
 *
 * Every composite index leads with `tenantId` (taxonomy §11.4).
 */
export default defineSchema({
  ...authTables,

  /**
   * Users — Convex Auth's table, extended the way cemetery-mapping does
   * it: re-declared AFTER the `...authTables` spread so the override
   * wins, with the auth-provided indexes re-asserted so account lookup
   * keeps working.
   *
   * `tenantId` is optional only because the bootstrap admin is created
   * before any tenant row exists.
   */
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    tenantId: v.optional(v.id("tenants")),
    isActive: v.optional(v.boolean()),
    createdAt: v.optional(v.number()),
    createdBy: v.optional(v.id("users")),
  })
    .index("email", ["email"])
    .index("phone", ["phone"])
    .index("by_tenant_active", ["tenantId", "isActive"]),

  /**
   * Tenants (taxonomy §11.4).
   *
   * Present from day one even though v1 ships a single tenant. Adding
   * `tenantId` later would mean rewriting every index in this file and
   * backfilling every money row — the exact cost §11.4 exists to avoid.
   */
  tenants: defineTable({
    name: v.string(),
    /** IANA zone. Every day-boundary read uses this, never the server clock. */
    timezone: v.string(),
    /** Local hour (0-23) at which the daily close runs — taxonomy §13 Q4. */
    dayCloseHour: v.number(),
    /**
     * Days an advance may sit unliquidated before the UI flags it
     * (taxonomy §6.4, §13 Q10). Configurable because the client has not
     * set it yet; 0 means never flag.
     */
    advanceStaleDays: v.number(),
    isActive: v.boolean(),
    createdAt: v.number(),
  }).index("by_active", ["isActive"]),

  /**
   * Roles. Kept separate from the auth user shape so a user can hold
   * more than one, and so payroll access (taxonomy §4,
   * "Access-restricted") is a role check rather than a per-row flag.
   */
  userRoles: defineTable({
    tenantId: v.id("tenants"),
    userId: v.id("users"),
    role: v.union(
      v.literal("admin"),
      v.literal("bookkeeper"),
      v.literal("encoder"),
      v.literal("payroll"),
      v.literal("viewer"),
    ),
    grantedAt: v.number(),
    grantedBy: v.id("users"),
  })
    .index("by_tenant_user", ["tenantId", "userId"])
    .index("by_tenant_role", ["tenantId", "role"]),

  /**
   * Categories — taxonomy §3 and §4 expressed as data rather than as a
   * literal union in code.
   *
   * Why a table and not `v.union(v.literal("rent"), ...)`: §6.4
   * requires liquidation line items to map onto "the normal expense
   * categories", and the client will add categories after sign-off. A
   * literal union would make every addition a code deploy.
   *
   * `treatment` is the field that actually drives the accounting, and
   * it is the thing the taxonomy warns about twice (§3's note on
   * capital injections, §6.2's double-count warning). It answers: does
   * this touch P&L, and if not, what does it touch instead?
   *
   *   revenue          — income, hits P&L
   *   expense          — cash-out, hits P&L
   *   capital          — owner injection. Cash up, NOT income.
   *   liability_draw   — loan proceeds. Cash up, creates a liability.
   *   liability_repay  — principal repayment. Cash down, NOT expense.
   *   equity_draw      — owner withdrawal. Cash down, NOT expense.
   *   asset_purchase   — capex. Cash down, NOT expense (§13 Q1).
   *   advance_release  — cash down, NOT expense (§6.2).
   *   advance_return   — unspent cash back. NOT income (§6.2).
   *
   * There is deliberately NO `advance_liquidation` treatment. §4 lists
   * "Liquidation of advance" as a cash-out type, but §6.2 is clear that
   * liquidation moves no cash — the money already left at release. What
   * liquidation does is *recognize* expense, and §6.4 says it does so
   * through "the normal expense categories". So a liquidation line
   * carries an ordinary `expense` category and there is nothing left
   * for a distinct treatment to express. An advance produces at most
   * two movements: the release (`advance_release`) and the return of
   * unspent cash (`advance_return`).
   *
   * ENFORCED IN CODE: only `revenue` and `expense` enter a P&L
   * aggregate, sourced from `obligations` and `advanceLiquidationLines`
   * — never from `moneyMovements`, which is cash. The helpers in
   * `convex/lib/reporting.ts` filter on `treatment` and nothing else;
   * no report may re-derive profitability from `direction`, which is
   * how capital injections end up inflating revenue.
   */
  categories: defineTable({
    tenantId: v.id("tenants"),
    name: v.string(),
    /** Stable machine key, unique per tenant. ENFORCED IN CODE. */
    slug: v.string(),
    direction: v.union(v.literal("in"), v.literal("out")),
    treatment: v.union(
      v.literal("revenue"),
      v.literal("expense"),
      v.literal("capital"),
      v.literal("liability_draw"),
      v.literal("liability_repay"),
      v.literal("equity_draw"),
      v.literal("asset_purchase"),
      v.literal("advance_release"),
      v.literal("advance_return"),
    ),
    /** Taxonomy §2. Which UI files this — not an accounting property. */
    entryPath: v.union(
      v.literal("SCHED"),
      v.literal("ADHOC"),
      v.literal("DAILY"),
    ),
    /**
     * Payroll and government contributions are access-restricted
     * (taxonomy §4). Rows in a restricted category are readable only by
     * the `admin` and `payroll` roles.
     * ENFORCED IN CODE: `convex/lib/auth.ts:assertCategoryReadable`.
     */
    isRestricted: v.boolean(),
    /** Valid target for an advance liquidation line item (§6.4). */
    allowedInLiquidation: v.boolean(),
    isActive: v.boolean(),
    sortOrder: v.number(),
  })
    .index("by_tenant_slug", ["tenantId", "slug"])
    .index("by_tenant_direction_active", ["tenantId", "direction", "isActive"])
    .index("by_tenant_treatment", ["tenantId", "treatment"])
    .index("by_tenant_liquidation", ["tenantId", "allowedInLiquidation"]),

  /**
   * Bank / cash / e-wallet accounts (taxonomy §7, §13 Q5).
   *
   * Cash on hand is modelled as an account too, so the daily tracker's
   * balance math (§10) is one sum over accounts rather than a special
   * case for physical cash.
   */
  bankAccounts: defineTable({
    tenantId: v.id("tenants"),
    name: v.string(),
    kind: v.union(
      v.literal("cash_on_hand"),
      v.literal("bank"),
      v.literal("ewallet"),
    ),
    bankName: v.optional(v.string()),
    /** Last 4 only — never store a full account number. */
    accountNumberLast4: v.optional(v.string()),
    /** Balance at `openingBalanceAt`; the anchor the ledger builds from. */
    openingBalanceCents: v.number(),
    openingBalanceAt: v.number(),
    isActive: v.boolean(),
    createdAt: v.number(),
    createdBy: v.id("users"),
  })
    .index("by_tenant_active", ["tenantId", "isActive"])
    .index("by_tenant_kind", ["tenantId", "kind"]),

  /**
   * Recurring schedule declarations (taxonomy §8).
   *
   * Schedules are NEVER edited in place. An amendment writes a new
   * `scheduleVersions` row with an `effectiveFrom` date and marks the
   * prior one superseded; generated obligations record which version
   * produced them. This row is the stable identity that versions hang
   * off — it holds only what cannot change without becoming a different
   * schedule.
   */
  recurringSchedules: defineTable({
    tenantId: v.id("tenants"),
    /** Human label, e.g. "Meralco — main office". */
    name: v.string(),
    direction: v.union(v.literal("in"), v.literal("out")),
    isActive: v.boolean(),
    createdAt: v.number(),
    createdBy: v.id("users"),
    /** Set when the schedule is retired; generation stops past this. */
    deactivatedAt: v.optional(v.number()),
  })
    .index("by_tenant_active", ["tenantId", "isActive"])
    .index("by_tenant_direction", ["tenantId", "direction"]),

  /**
   * Immutable versions of a schedule (taxonomy §8, "Amendment").
   *
   * Fixed vs variable (§5) lives here because it can legitimately
   * change on amendment — a landlord moving from a flat rent to a
   * metered one is a new version, not a new schedule.
   *
   *   amountType `fixed`    — `expectedAmountCents` is the real amount.
   *                           The generated obligation is complete on
   *                           creation.
   *   amountType `variable` — `expectedAmountCents` is an ESTIMATE. The
   *                           generated obligation is a placeholder and
   *                           a person enters the actual when the bill
   *                           arrives. §5's reporting consequence hangs
   *                           entirely off this flag.
   *
   * ENFORCED IN CODE: `convex/schedules.ts:amendSchedule` is the only
   * writer. It supersedes the current version and inserts the new one
   * in a single mutation, so there is never a window with two live
   * versions.
   */
  scheduleVersions: defineTable({
    tenantId: v.id("tenants"),
    scheduleId: v.id("recurringSchedules"),
    /** Monotonic per schedule, starting at 1. */
    version: v.number(),
    categoryId: v.id("categories"),
    frequency: v.union(
      v.literal("monthly"),
      v.literal("quarterly"),
      v.literal("annual"),
    ),
    /** Day of month 1-31; clamped to month length by the generator. */
    dueDay: v.number(),
    amountType: v.union(v.literal("fixed"), v.literal("variable")),
    /** Exact if fixed, estimate basis if variable (§5). */
    expectedAmountCents: v.number(),
    payeeName: v.string(),
    /** Default account; the person paying may override per movement. */
    defaultBankAccountId: v.optional(v.id("bankAccounts")),
    defaultPaymentMethod: v.optional(
      v.union(
        v.literal("cash"),
        v.literal("cheque"),
        v.literal("bank_transfer"),
        v.literal("ewallet"),
        v.literal("auto_debit"),
      ),
    ),
    /** Lifecycle bounds (§8). `activeTo` null-ish means open-ended. */
    activeFrom: v.string(),
    activeTo: v.optional(v.string()),
    /** The date this version starts governing generation (§8). */
    effectiveFrom: v.string(),
    /** Set when a later version supersedes this one. Never deleted. */
    supersededAt: v.optional(v.number()),
    supersededBy: v.optional(v.id("scheduleVersions")),
    createdAt: v.number(),
    createdBy: v.id("users"),
  })
    .index("by_tenant_schedule_version", ["tenantId", "scheduleId", "version"])
    /** The live version of a schedule: `supersededAt` unset. */
    .index("by_tenant_schedule_superseded", [
      "tenantId",
      "scheduleId",
      "supersededAt",
    ])
    .index("by_tenant_category", ["tenantId", "categoryId"]),

  /**
   * Obligations — the RECOGNITION side of taxonomy §1.
   *
   * One row per thing owed or owed-to-us: a generated bill, an ad-hoc
   * invoice, a payroll period. Never a cash movement. The row exists
   * from the moment the expense is recognized, which for a `SCHED` item
   * is when the generator materializes it (§8) and for an `ADHOC` item
   * is when a person files it.
   *
   * `recognizedAt` vs `dueAt` vs the cash date:
   *   recognizedAt — when it hits P&L. Rent: the 1st.
   *   dueAt        — when it must be paid. Rent: the 5th.
   *   (cash)       — lives on `moneyMovements.occurredAt`. Rent: the
   *                  5th, or the 9th if they paid late.
   * All three are genuinely different and all three are queried.
   *
   * `amountCents` is null-ish (0) until a variable bill's actual is
   * entered; `isEstimate` says which side of §5's reporting split this
   * row falls on. A month-to-date figure that sums estimates and
   * actuals into one number is the bug §5 describes.
   *
   * Settlement: `settledCents` is maintained by the movement-posting
   * helper, not by the UI, and `status` flips to `settled` when it
   * reaches `amountCents`. Partial settlement is representable because
   * §13 Q2 is still open — if the client says bills are never split,
   * the UI simply never produces a partial, and no schema change is
   * needed either way.
   *
   * ENFORCED IN CODE: `convex/lib/postMovement.ts` owns every write to
   * `settledCents` and `status`. Direct patches are blocked by the
   * `local-rules/no-direct-financial-write` lint rule.
   */
  obligations: defineTable({
    tenantId: v.id("tenants"),
    direction: v.union(v.literal("in"), v.literal("out")),
    categoryId: v.id("categories"),
    entryPath: v.union(
      v.literal("SCHED"),
      v.literal("ADHOC"),
      v.literal("DAILY"),
    ),
    /** Set only for `SCHED` rows — which version generated this (§8). */
    scheduleId: v.optional(v.id("recurringSchedules")),
    scheduleVersionId: v.optional(v.id("scheduleVersions")),
    /**
     * Generator idempotency key (§8): `${scheduleId}:${period}` where
     * period is `YYYY-MM` / `YYYY-Qn` / `YYYY`. A re-run after a failed
     * job re-reads this index and skips rather than duplicating.
     * ENFORCED IN CODE: `convex/schedules.ts:generateHorizon`.
     */
    generationKey: v.optional(v.string()),
    payeeName: v.optional(v.string()),
    description: v.optional(v.string()),
    /** Recognized amount. Equals the estimate while `isEstimate`. */
    amountCents: v.number(),
    /** Taxonomy §5 — placeholder awaiting the real bill. */
    isEstimate: v.boolean(),
    /** When this hits P&L. Distinct from `dueAt` and from cash. */
    recognizedAt: v.number(),
    recognizedOn: v.string(),
    /** Due date drives reminders (§9). Ad-hoc rows may have none. */
    dueAt: v.optional(v.number()),
    dueOn: v.optional(v.string()),
    settledCents: v.number(),
    status: v.union(
      v.literal("open"),
      v.literal("partially_settled"),
      v.literal("settled"),
      v.literal("void"),
    ),
    /** Taxonomy §11.5 — one value in v1, so approval is a value change. */
    postingStatus: v.literal("posted"),
    recordedBy: v.id("users"),
    recordedAt: v.number(),
    note: v.optional(v.string()),
  })
    .index("by_tenant_generation_key", ["tenantId", "generationKey"])
    /** Reminder query (§9): unpaid rows due in the next 5 days. */
    .index("by_tenant_status_due", ["tenantId", "status", "dueOn"])
    /** Month-to-date recognized expense, split by estimate flag (§5). */
    .index("by_tenant_recognized", ["tenantId", "recognizedOn"])
    .index("by_tenant_estimate_recognized", [
      "tenantId",
      "isEstimate",
      "recognizedOn",
    ])
    .index("by_tenant_category_recognized", [
      "tenantId",
      "categoryId",
      "recognizedOn",
    ])
    .index("by_tenant_schedule_due", ["tenantId", "scheduleId", "dueOn"]),

  /**
   * Money movements — the CASH side of taxonomy §1, and the append-only
   * ledger at the centre of this schema.
   *
   * Every row is one movement of money in or out of one account. This
   * table alone determines the cash balance; `obligations` never does.
   *
   * APPEND-ONLY (taxonomy §11.1). Convex cannot enforce this, so:
   *   - `convex/lib/postMovement.ts` is the only module permitted to
   *     insert here, and nothing may patch or delete a row.
   *   - `local-rules/no-direct-financial-write` fails the build on any
   *     `ctx.db.insert("moneyMovements", …)` outside that helper, and
   *     on any `patch` / `replace` / `delete` against this table
   *     anywhere. This mirrors how cemetery-mapping protects its
   *     `auditLog`, and it is the ONLY thing standing between us and a
   *     silently mutated ledger.
   *   - A correction is a new row with `reversesMovementId` set. The
   *     reversed row is left exactly as it was.
   *
   * Backdating (§10 "Sealing"): a movement filed against a sealed day
   * posts to the CURRENT day. `occurredAt` is therefore always within
   * the open day, and `originalOccurredOn` carries the date the person
   * actually meant. Reports that need the true economic date read
   * `originalOccurredOn ?? occurredOn`; the balance math always reads
   * `occurredOn`. History is not rewritten.
   *
   * Cheques (§7.2): when the tenant issues post-dated cheques, cash-out
   * posts on CLEARING, not issue. In that mode a cheque-backed movement
   * is inserted only once `chequeDetails.status` reaches `cleared`, and
   * the issued-but-uncleared figure is read off `chequeDetails` instead.
   * The flag lives on the cheque row, not here, so this table stays a
   * record of cash that has genuinely moved.
   */
  moneyMovements: defineTable({
    tenantId: v.id("tenants"),
    direction: v.union(v.literal("in"), v.literal("out")),
    categoryId: v.id("categories"),
    entryPath: v.union(
      v.literal("SCHED"),
      v.literal("ADHOC"),
      v.literal("DAILY"),
    ),
    /** Always positive. `direction` carries the sign. */
    amountCents: v.number(),
    bankAccountId: v.id("bankAccounts"),
    /** When the cash actually moved (§1). Drives every balance. */
    occurredAt: v.number(),
    occurredOn: v.string(),
    /** Set only on a backdated entry posted to the open day (§10). */
    originalOccurredOn: v.optional(v.string()),
    /** The bill this settles, if any. Null for a standalone movement. */
    obligationId: v.optional(v.id("obligations")),
    /** Set on advance release / liquidation / return rows (§6). */
    advanceId: v.optional(v.id("advances")),
    paymentMethod: v.union(
      v.literal("cash"),
      v.literal("cheque"),
      v.literal("bank_transfer"),
      v.literal("ewallet"),
      v.literal("auto_debit"),
    ),
    /**
     * Taxonomy §7 — one generic reference field covers cheque numbers,
     * transfer references and e-wallet references. A dedicated cheque
     * column would be null on most rows; cheque-specific attributes
     * live in `chequeDetails`.
     */
    referenceNo: v.optional(v.string()),
    chequeId: v.optional(v.id("chequeDetails")),
    /** Per-person attribution for DAILY allowance rows (§4, §13 Q6). */
    personName: v.optional(v.string()),
    /** Groups one submitted daily sheet (§2 `DAILY`). */
    dailyBatchId: v.optional(v.id("dailyBatches")),
    payeeName: v.optional(v.string()),
    description: v.optional(v.string()),
    receiptStorageId: v.optional(v.id("_storage")),
    /** Taxonomy §11.5 — `posted` is the only v1 value. */
    postingStatus: v.literal("posted"),
    /** Correction target (§11.1). Set only on reversing entries. */
    reversesMovementId: v.optional(v.id("moneyMovements")),
    reversalReason: v.optional(v.string()),
    /** Guards double-submit on retry. ENFORCED IN CODE. */
    idempotencyKey: v.optional(v.string()),
    recordedBy: v.id("users"),
    recordedAt: v.number(),
    note: v.optional(v.string()),
  })
    /** Daily tracker aggregation (§10) and the day-seal read. */
    .index("by_tenant_occurred", ["tenantId", "occurredOn"])
    .index("by_tenant_account_occurred", [
      "tenantId",
      "bankAccountId",
      "occurredOn",
    ])
    .index("by_tenant_direction_occurred", [
      "tenantId",
      "direction",
      "occurredOn",
    ])
    .index("by_tenant_category_occurred", [
      "tenantId",
      "categoryId",
      "occurredOn",
    ])
    .index("by_tenant_obligation", ["tenantId", "obligationId"])
    .index("by_tenant_advance", ["tenantId", "advanceId"])
    .index("by_tenant_cheque", ["tenantId", "chequeId"])
    .index("by_tenant_batch", ["tenantId", "dailyBatchId"])
    .index("by_tenant_idempotency_key", ["tenantId", "idempotencyKey"])
    .index("by_tenant_reverses", ["tenantId", "reversesMovementId"])
    .index("by_tenant_recordedBy", ["tenantId", "recordedBy"]),

  /**
   * Daily batch header (taxonomy §2 `DAILY`).
   *
   * A gas/food allowance sheet is many line items submitted at once.
   * The header exists so the sheet can be shown, and audited, as the
   * one thing the person actually submitted — the line items are
   * ordinary `moneyMovements` rows pointing back here.
   */
  dailyBatches: defineTable({
    tenantId: v.id("tenants"),
    batchOn: v.string(),
    lineCount: v.number(),
    totalCents: v.number(),
    submittedBy: v.id("users"),
    submittedAt: v.number(),
    note: v.optional(v.string()),
  }).index("by_tenant_date", ["tenantId", "batchOn"]),

  /**
   * Cheque detail (taxonomy §7.1).
   *
   * Hangs off a movement rather than widening it, because these fields
   * are null for every non-cheque payment.
   *
   * UNIQUENESS: `cheque_no` is unique per bank account, and it is the
   * constraint that catches the duplicate-voucher entry §7.1 calls the
   * most common recording error. Convex has no unique index, so:
   *   ENFORCED IN CODE — `convex/cheques.ts:issueCheque` reads
   *   `by_tenant_account_number` and throws before inserting. Convex
   *   mutations are serializable, so a concurrent duplicate loses the
   *   OCC race and retries into the same check. A nightly cron
   *   re-scans for duplicates as a backstop, because a lint rule cannot
   *   prove every future writer went through the helper.
   *
   * `status` is the lifecycle §7.1 specifies. `clearedAt` is when funds
   * actually left the account — under post-dated cheques (§7.2) that is
   * the moment the cash-out movement may be posted, and it can be a
   * month or more after `chequeDate`.
   */
  chequeDetails: defineTable({
    tenantId: v.id("tenants"),
    chequeNo: v.string(),
    bankAccountId: v.id("bankAccounts"),
    /** Frequently differs from the issue date (§7.1). */
    chequeDate: v.string(),
    issuedOn: v.string(),
    amountCents: v.number(),
    /** As written on the cheque; may differ from the vendor record. */
    payeeName: v.string(),
    status: v.union(
      v.literal("issued"),
      v.literal("released"),
      v.literal("cleared"),
      v.literal("cancelled"),
      v.literal("bounced"),
    ),
    clearedAt: v.optional(v.number()),
    clearedOn: v.optional(v.string()),
    /** Set once the clearing movement is posted (§7.2). */
    movementId: v.optional(v.id("moneyMovements")),
    obligationId: v.optional(v.id("obligations")),
    voidReason: v.optional(v.string()),
    recordedBy: v.id("users"),
    recordedAt: v.number(),
  })
    /** The uniqueness probe. ENFORCED IN CODE — see the note above. */
    .index("by_tenant_account_number", ["tenantId", "bankAccountId", "chequeNo"])
    /** Issued-but-uncleared total for the §7.2 committed figure. */
    .index("by_tenant_status_date", ["tenantId", "status", "chequeDate"])
    /** Sequential-gap detection (§7.1) reads this in order. */
    .index("by_tenant_account_issued", [
      "tenantId",
      "bankAccountId",
      "issuedOn",
    ])
    .index("by_tenant_movement", ["tenantId", "movementId"]),

  /**
   * Advances — taxonomy §6, the part of this system most likely to be
   * got wrong.
   *
   * A release is NOT an expense (§6.2). Cash becomes a claim on a
   * person; both are assets and company value is unchanged. Expense is
   * recognized only at liquidation, by category, with receipts.
   * Booking both is the ₱10,000-counted-twice error.
   *
   * That is why this table has no `categoryId` for the released amount.
   * There is nothing to categorize yet — nobody knows what the money
   * was spent on. Categories appear on
   * `advanceLiquidationLines`, which is the only place advance spending
   * touches P&L.
   *
   * State is DERIVED, never set by hand (§6.3): the row is `closed`
   * when `liquidatedCents + returnedCents === releasedCents`. There is
   * no manual close action — the arithmetic decides.
   * ENFORCED IN CODE: `convex/advances.ts:recordLiquidation` recomputes
   * and writes `state` in the same mutation as the line items.
   *
   * `releasedAt` and `liquidatedAt` are stored as distinct fields even
   * when captured in one sitting (§11.6). This is what makes §6.6's
   * open question a UI decision rather than a migration: if the client
   * files releases retroactively, the form captures both dates at once
   * and the schema does not change.
   */
  advances: defineTable({
    tenantId: v.id("tenants"),
    /**
     * Who holds the money (§13 Q3 — named individual or a single petty
     * cash fund). Stored as a user reference when the custodian is a
     * system user, and as a name when they are not; the client has not
     * yet said which.
     */
    custodianUserId: v.optional(v.id("users")),
    custodianName: v.string(),
    releasedCents: v.number(),
    /** Sum of `advanceLiquidationLines`. Maintained by the helper. */
    liquidatedCents: v.number(),
    /** Unspent cash handed back. NOT income (§6.2). */
    returnedCents: v.number(),
    state: v.union(
      v.literal("open"),
      v.literal("partial"),
      v.literal("closed"),
    ),
    releasedAt: v.number(),
    releasedOn: v.string(),
    /** First liquidation event; distinct field per §11.6. */
    liquidatedAt: v.optional(v.number()),
    liquidatedOn: v.optional(v.string()),
    /** Set when the balance reaches zero. Never set by a human. */
    closedAt: v.optional(v.number()),
    /** The cash-out movement that released the money. */
    releaseMovementId: v.optional(v.id("moneyMovements")),
    purpose: v.optional(v.string()),
    recordedBy: v.id("users"),
    recordedAt: v.number(),
    note: v.optional(v.string()),
  })
    /**
     * The dashboard figure §6.5 insists on: every advance not yet
     * closed, so an open one cannot sit unnoticed for weeks. Days
     * outstanding is computed from `releasedOn` at read time, and this
     * index returns the rows already in release order so the
     * stale-first sort needs no post-sort.
     */
    .index("by_tenant_state_released", ["tenantId", "state", "releasedOn"])
    /** Running balance per custodian (§6.4). */
    .index("by_tenant_custodian_state", [
      "tenantId",
      "custodianName",
      "state",
    ])
    .index("by_tenant_custodian_user", ["tenantId", "custodianUserId"])
    .index("by_tenant_released", ["tenantId", "releasedOn"]),

  /**
   * Advance liquidation line items (taxonomy §6.3, §6.4).
   *
   * THIS is where advance spending becomes an expense — one row per
   * receipt, each mapped to a normal expense category. A `partial`
   * liquidation is simply fewer lines than the released total; §13 Q8
   * asks whether that can happen, and the answer changes only whether
   * the UI allows a second submission, not this shape.
   *
   * Append-only alongside `moneyMovements`: a wrong line is reversed by
   * a compensating line, not edited.
   */
  advanceLiquidationLines: defineTable({
    tenantId: v.id("tenants"),
    advanceId: v.id("advances"),
    /** Groups the lines submitted in one Liquidate action (§6.3). */
    liquidationId: v.string(),
    categoryId: v.id("categories"),
    amountCents: v.number(),
    description: v.string(),
    /** Receipts are attached at liquidation (§6.4), not at release. */
    receiptStorageId: v.optional(v.id("_storage")),
    /** When the spend actually happened, per the receipt. */
    spentOn: v.optional(v.string()),
    /** When it was recognized — the liquidation date (§4). */
    liquidatedAt: v.number(),
    liquidatedOn: v.string(),
    reversesLineId: v.optional(v.id("advanceLiquidationLines")),
    recordedBy: v.id("users"),
    recordedAt: v.number(),
  })
    .index("by_tenant_advance", ["tenantId", "advanceId"])
    .index("by_tenant_liquidation", ["tenantId", "liquidationId"])
    /** Advance spending joins the normal expense reports through this. */
    .index("by_tenant_category_liquidated", [
      "tenantId",
      "categoryId",
      "liquidatedOn",
    ])
    .index("by_tenant_liquidated", ["tenantId", "liquidatedOn"]),

  /**
   * Rolling daily tracker (taxonomy §10) — one row per calendar day.
   *
   * These are SNAPSHOTS, not a view. §10 requires closed days to be
   * stored and reports to read snapshots for closed periods, using live
   * aggregation only for today. QUERY_PERFORMANCE.md §3 is emphatic
   * about the Convex version of this: a reactive query re-runs on every
   * data change and for every subscribed client, so a historical
   * aggregation inside one is paid over and over. The daily close cron
   * writes here; the dashboard reads here.
   *
   * SEALING: once `isSealed` is true the row is immutable and the day
   * accepts no further movements — a backdated entry posts to the open
   * day instead (see `moneyMovements.originalOccurredOn`).
   * ENFORCED IN CODE: `convex/lib/postMovement.ts` refuses to insert
   * against a sealed day, and the seal mutation refuses to re-seal.
   *
   * `expenseRecognizedCents` is reporting only and is deliberately
   * EXCLUDED from the balance arithmetic — it comes from `obligations`
   * and `advanceLiquidationLines`, not from cash. Mixing it into
   * `closingBalanceCents` is precisely the §1 failure.
   */
  dailyLedger: defineTable({
    tenantId: v.id("tenants"),
    ledgerOn: v.string(),
    /** Previous day's closing — always (§10). */
    openingBalanceCents: v.number(),
    cashInCents: v.number(),
    cashOutCents: v.number(),
    /** opening + in − out. Cash only. */
    closingBalanceCents: v.number(),
    /** Accrual figure. Reporting only; never in the balance math. */
    expenseRecognizedCents: v.number(),
    /** Released, not yet liquidated (§6.5) — visible on the tracker. */
    unliquidatedAdvancesCents: v.number(),
    /**
     * Issued-but-uncleared cheques (§7.2). Committed but not yet gone
     * from the account. Only meaningful if the client issues post-dated
     * cheques — §13 Q9.
     */
    unclearedChequesCents: v.number(),
    movementCount: v.number(),
    isSealed: v.boolean(),
    sealedAt: v.optional(v.number()),
    sealedBy: v.optional(v.id("users")),
  })
    .index("by_tenant_date", ["tenantId", "ledgerOn"])
    .index("by_tenant_sealed_date", ["tenantId", "isSealed", "ledgerOn"]),

  /**
   * Per-account daily closing balances.
   *
   * `dailyLedger` answers "what did the business hold". This answers
   * "in which account", which is what someone reconciling against a
   * bank statement by hand (§12, deferred) actually needs.
   */
  dailyAccountBalances: defineTable({
    tenantId: v.id("tenants"),
    ledgerOn: v.string(),
    bankAccountId: v.id("bankAccounts"),
    openingBalanceCents: v.number(),
    cashInCents: v.number(),
    cashOutCents: v.number(),
    closingBalanceCents: v.number(),
  })
    .index("by_tenant_date_account", ["tenantId", "ledgerOn", "bankAccountId"])
    .index("by_tenant_account_date", ["tenantId", "bankAccountId", "ledgerOn"]),

  /**
   * Reminder send log (taxonomy §9).
   *
   * In-app reminders are a QUERY, not a job — unpaid obligations due
   * within 5 days, read straight off
   * `obligations.by_tenant_status_due`. Nothing is written for those.
   *
   * This table exists only for push/email, where §9 is explicit: a
   * retried cron will send the same reminder repeatedly without a
   * deduplicated sent-log. The dedup key is
   * `${obligationId}:${channel}:${dueOn}`.
   * ENFORCED IN CODE: `convex/reminders.ts:sendDue` reads
   * `by_tenant_dedupe_key` inside the same mutation that records the
   * send.
   */
  reminderLog: defineTable({
    tenantId: v.id("tenants"),
    obligationId: v.id("obligations"),
    channel: v.union(v.literal("email"), v.literal("push")),
    dedupeKey: v.string(),
    /** Local date the reminder was for — `dueAt - 5 days` (§9). */
    scheduledOn: v.string(),
    sentAt: v.number(),
    status: v.union(
      v.literal("sent"),
      v.literal("failed"),
      v.literal("skipped_duplicate"),
    ),
    recipient: v.string(),
    errorMessage: v.optional(v.string()),
  })
    .index("by_tenant_dedupe_key", ["tenantId", "dedupeKey"])
    .index("by_tenant_obligation", ["tenantId", "obligationId"])
    .index("by_tenant_sent", ["tenantId", "sentAt"]),

  /**
   * Audit log.
   *
   * Taxonomy §11.3 says that with no approval workflow in v1,
   * `recordedBy` / `recordedAt` on every row IS the audit trail. That
   * is true for "who created this", but it cannot answer "who sealed
   * day X", "who amended the schedule", or "who voided that cheque" —
   * events that touch money without creating a money row.
   *
   * Append-only, same enforcement as cemetery-mapping: writes go
   * through `convex/lib/audit.ts:emitAudit`, and
   * `local-rules/no-audit-log-direct-write` plus
   * `local-rules/no-audit-log-mutation` fail the build on anything
   * else. Convex has no append-only constraint; lint, helper and tests
   * are the whole of the enforcement.
   */
  auditLog: defineTable({
    tenantId: v.id("tenants"),
    action: v.string(),
    entityTable: v.string(),
    entityId: v.string(),
    actorId: v.id("users"),
    actorRole: v.optional(v.string()),
    at: v.number(),
    /** Small JSON summary of what changed. Never the full document. */
    summary: v.optional(v.string()),
    amountCents: v.optional(v.number()),
  })
    .index("by_tenant_at", ["tenantId", "at"])
    .index("by_tenant_entity", ["tenantId", "entityTable", "entityId"])
    .index("by_tenant_actor_at", ["tenantId", "actorId", "at"])
    .index("by_tenant_action_at", ["tenantId", "action", "at"]),
});
