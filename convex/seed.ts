/**
 * Demo / initial-data seeder.
 *
 * Run ONCE after `npx convex dev` has pushed the schema:
 *
 *     npx convex run seed:seedDemo
 *
 * Idempotent — a second run detects the seeded admin and no-ops (returns
 * `{ alreadySeeded: true }`). To re-seed from scratch, clear the tables
 * from the Convex dashboard first.
 *
 * What it creates (enough to demo every page end-to-end):
 *   - Four login accounts, one per role (admin / office_staff /
 *     field_worker / customer). Password for ALL of them is
 *     `Demo!2026` (documented in docs/getting-started.md). The customer
 *     account is email-linked to a seeded customer so the owner portal
 *     resolves it.
 *   - Reference config that otherwise blocks the app: perpetual-care
 *     policy (NOT placeholder, so sales work), BIR receipt config,
 *     reminder cadence, expense categories, sales-agent app setting.
 *   - The receipt counter (so seeded + live receipts share one serial
 *     sequence).
 *   - Sections, lots (varied statuses), customers, contracts
 *     (full-payment + installment, incl. an overdue one for AR aging),
 *     installments, ownerships, occupants, an interment, and expenses.
 *   - Realistic payments + receipts + allocations, minted through the
 *     SAME `allocateNextSerial` the cornerstone uses (BIR-consistent
 *     serials). Seeded financial rows carry NO audit row (the seed is
 *     an infrastructure event, not an operator action); live actions
 *     during the demo audit normally.
 *
 * Boundary note: this file is the one place outside `postFinancialEvent`
 * permitted to write financial tables (see the `no-direct-financial-write`
 * ESLint allow-list). Keep it strictly seed-only.
 */

import {
  type DataModelFromSchemaDefinition,
  internalMutationGeneric,
} from "convex/server";
import { Scrypt } from "lucia";

import schema from "./schema";
import { type MutationCtx } from "./lib/auth";
import { allocateNextSerial } from "./lib/receiptCounter";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type UserId = DataModel["users"]["document"]["_id"];
type LotId = DataModel["lots"]["document"]["_id"];
type CustomerId = DataModel["customers"]["document"]["_id"];
type ContractId = DataModel["contracts"]["document"]["_id"];
type SectionId = DataModel["sections"]["document"]["_id"];
type OccupantId = DataModel["occupants"]["document"]["_id"];

const DEMO_PASSWORD = "Demo!2026";
const ADMIN_EMAIL = "admin@apostlepaul.test";
const RECEIPT_PREFIX = "APMP-";

// Fixed clock so the seed is deterministic regardless of when it runs.
// (Date.now() IS available in Convex mutations; using it here is fine —
// seeds are not replayed like workflow scripts.)
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

/** Square polygon (~6m) around a centroid + its bounding box. */
function geometryAround(lat: number, lng: number) {
  const d = 0.00003; // ~3.3m at Manila latitude
  const polygon = [
    { lat: lat - d, lng: lng - d },
    { lat: lat - d, lng: lng + d },
    { lat: lat + d, lng: lng + d },
    { lat: lat + d, lng: lng - d },
  ];
  return {
    centroid: { lat, lng },
    polygon,
    bboxMinLat: lat - d,
    bboxMaxLat: lat + d,
    bboxMinLng: lng - d,
    bboxMaxLng: lng + d,
  };
}

export const seedDemo = internalMutationGeneric({
  args: {},
  handler: async (
    ctx: MutationCtx,
  ): Promise<{ alreadySeeded: boolean; summary?: Record<string, number> }> => {
    // Idempotency guard: if the demo admin already exists, no-op.
    const existingAdmin = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", ADMIN_EMAIL))
      .first();
    if (existingAdmin !== null) {
      return { alreadySeeded: true };
    }

    const scrypt = new Scrypt();
    const secret = await scrypt.hash(DEMO_PASSWORD);

    // ---- Accounts ---------------------------------------------------
    async function makeAccount(
      email: string,
      name: string,
      role: "admin" | "office_staff" | "field_worker" | "customer",
    ): Promise<UserId> {
      const userId = await ctx.db.insert("users", {
        name,
        email,
        isActive: true,
        createdAt: NOW,
      });
      await ctx.db.insert("authAccounts", {
        userId,
        provider: "password",
        providerAccountId: email,
        secret,
      });
      await ctx.db.insert("userRoles", {
        userId,
        role,
        grantedAt: NOW,
        grantedBy: userId,
      });
      return userId;
    }

    const adminId = await makeAccount(ADMIN_EMAIL, "Demo Admin", "admin");
    const officeId = await makeAccount(
      "office@apostlepaul.test",
      "Demo Office Staff",
      "office_staff",
    );
    await makeAccount(
      "field@apostlepaul.test",
      "Demo Field Worker",
      "field_worker",
    );
    // Customer portal account — email MUST match the linked customer row
    // below so `resolveCurrentCustomer` (portal) finds it.
    const customerLoginEmail = "juan@example.ph";
    await makeAccount(customerLoginEmail, "Juan dela Cruz", "customer");

    // ---- Reference config ------------------------------------------
    // Perpetual-care policy — NOT placeholder, so sales are not blocked.
    await ctx.db.insert("perpetualCarePolicy", {
      type: "one_time",
      oneTimeFeesByLotType: [
        { lotType: "single", feeCents: 500000 },
        { lotType: "family", feeCents: 500000 },
        { lotType: "mausoleum", feeCents: 1000000 },
        { lotType: "niche", feeCents: 0 },
      ],
      isPlaceholder: false,
      updatedAt: NOW,
      updatedBy: adminId,
    });

    await ctx.db.insert("birReceiptConfig", {
      registeredName: "Apostle Paul Memorial Park, Inc.",
      tradeName: "Apostle Paul Memorial Park",
      tin: "123-456-789-00000",
      registeredAddressLines: [
        "National Highway, Brgy. Macabato",
        "Aringay, La Union 2503",
      ],
      atpNumber: "OCN-2026-000123",
      atpExpiryDate: NOW + 365 * DAY,
      serialRangeStart: `${RECEIPT_PREFIX}0000001`,
      serialRangeEnd: `${RECEIPT_PREFIX}9999999`,
      vatRate: 12,
      isVatRegistered: true,
      isPlaceholder: false,
      updatedAt: NOW,
      updatedBy: adminId,
    });

    await ctx.db.insert("reminderConfig", {
      rules: [
        {
          daysOffset: -3,
          requiresUnpaid: true,
          channel: "email",
          templateKey: "upcoming_due_3d_email",
          enabled: true,
        },
        {
          daysOffset: 0,
          requiresUnpaid: true,
          channel: "email",
          templateKey: "due_today_email",
          enabled: true,
        },
        {
          daysOffset: 7,
          requiresUnpaid: true,
          channel: "email",
          templateKey: "overdue_7d_email",
          enabled: true,
        },
      ],
      timezone: "Asia/Manila",
      sendHour: 9,
      updatedAt: NOW,
      updatedBy: adminId,
      paused: false,
    });

    await ctx.db.insert("appSettings", {
      key: "singleton",
      salesAgentTrackingEnabled: false,
    });

    const categoryNames = [
      "Utilities",
      "Maintenance",
      "Salaries",
      "Supplies",
    ];
    for (let i = 0; i < categoryNames.length; i++) {
      const name = categoryNames[i]!;
      await ctx.db.insert("expenseCategories", {
        name,
        nameLowercased: name.toLowerCase(),
        isActive: true,
        displayOrder: i * 10,
        createdAt: NOW,
        createdBy: adminId,
      });
    }

    // Receipt counter (so seeded + live receipts share one sequence).
    await ctx.db.insert("receiptCounter", {
      currentSerial: 0,
      startingSerial: 1,
      prefix: RECEIPT_PREFIX,
      seededAt: NOW,
      seededBy: adminId,
    });

    // ---- Sections ---------------------------------------------------
    async function makeSection(
      name: string,
      displayName: string,
      kind: "chapel" | "family" | "standard" | "niche" | "columbarium",
      order: number,
    ): Promise<SectionId> {
      return await ctx.db.insert("sections", {
        name,
        displayName,
        sortOrder: order,
        kind,
        isRetired: false,
        createdAt: NOW,
        createdBy: adminId,
      });
    }
    const secGarden = await makeSection(
      "garden-of-peace",
      "Garden of Peace",
      "standard",
      0,
    );
    const secChapel = await makeSection(
      "chapel-of-grace",
      "Chapel of Grace",
      "chapel",
      10,
    );
    const secColumbarium = await makeSection(
      "columbarium-east",
      "Columbarium · East",
      "columbarium",
      20,
    );

    // ---- Lots (varied statuses) -------------------------------------
    const BASE_LAT = 16.3955;
    const BASE_LNG = 120.3585;
    interface LotSpec {
      code: string;
      sectionId: SectionId;
      sectionName: string;
      block: string;
      row: string;
      type: "single" | "family" | "mausoleum" | "niche";
      basePriceCents: number;
      status:
        | "available"
        | "reserved"
        | "sold"
        | "occupied";
      i: number;
    }
    const lotSpecs: LotSpec[] = [
      { code: "A-1-01", sectionId: secGarden, sectionName: "Garden of Peace", block: "1", row: "01", type: "single", basePriceCents: 8800000, status: "available", i: 0 },
      { code: "A-1-02", sectionId: secGarden, sectionName: "Garden of Peace", block: "1", row: "02", type: "single", basePriceCents: 8800000, status: "available", i: 1 },
      { code: "A-1-03", sectionId: secGarden, sectionName: "Garden of Peace", block: "1", row: "03", type: "single", basePriceCents: 8800000, status: "reserved", i: 2 },
      { code: "A-2-01", sectionId: secGarden, sectionName: "Garden of Peace", block: "2", row: "01", type: "family", basePriceCents: 34000000, status: "sold", i: 3 },
      { code: "C-1-01", sectionId: secChapel, sectionName: "Chapel of Grace", block: "1", row: "01", type: "mausoleum", basePriceCents: 135000000, status: "sold", i: 4 },
      { code: "C-1-02", sectionId: secChapel, sectionName: "Chapel of Grace", block: "1", row: "02", type: "mausoleum", basePriceCents: 135000000, status: "occupied", i: 5 },
      { code: "N-1-01", sectionId: secColumbarium, sectionName: "Columbarium · East", block: "1", row: "01", type: "niche", basePriceCents: 4500000, status: "available", i: 6 },
      { code: "N-1-02", sectionId: secColumbarium, sectionName: "Columbarium · East", block: "1", row: "02", type: "niche", basePriceCents: 4500000, status: "occupied", i: 7 },
    ];
    const lotIdByCode = new Map<string, LotId>();
    for (const spec of lotSpecs) {
      const geometry = geometryAround(
        BASE_LAT + spec.i * 0.00008,
        BASE_LNG + (spec.i % 4) * 0.00008,
      );
      const lotId = await ctx.db.insert("lots", {
        code: spec.code,
        section: spec.sectionName,
        sectionId: spec.sectionId,
        block: spec.block,
        row: spec.row,
        type: spec.type,
        dimensions: { widthM: spec.type === "family" ? 5 : 2.5, depthM: 2.5 },
        basePriceCents: spec.basePriceCents,
        status: spec.status,
        geometry,
        geometryStatus: "surveyed",
        isRetired: false,
        createdAt: NOW,
        createdBy: adminId,
      });
      lotIdByCode.set(spec.code, lotId);
    }

    // ---- Customers --------------------------------------------------
    async function makeCustomer(
      fullName: string,
      email: string | undefined,
      phone: string,
      govIdType: "sss" | "tin" | "umid" | "drivers_license" | "passport",
      govIdNumber: string,
      city: string,
    ): Promise<CustomerId> {
      return await ctx.db.insert("customers", {
        fullName,
        fullNameLowercased: fullName.toLowerCase(),
        phone,
        email,
        address: {
          line1: "123 Rizal St.",
          barangay: "Macabato",
          cityMunicipality: city,
          province: "La Union",
          postalCode: "2503",
        },
        govIdType,
        govIdNumber,
        hasConsent: true,
        consentTimestamp: NOW,
        consentCapturedByUserId: officeId,
        createdAt: NOW,
        createdByUserId: officeId,
        updatedAt: NOW,
      });
    }
    const custJuan = await makeCustomer(
      "Juan dela Cruz",
      customerLoginEmail,
      "+639171234567",
      "sss",
      "34-1234567-8",
      "Aringay",
    );
    const custMaria = await makeCustomer(
      "Maria Santos",
      "maria@example.ph",
      "+639172345678",
      "tin",
      "123-456-789-000",
      "Bauang",
    );
    // A third customer with no contract yet — populates the customers
    // list and gives the demo a "create a contract for an existing
    // customer" starting point.
    await makeCustomer(
      "Pedro Reyes",
      "pedro@example.ph",
      "+639173456789",
      "umid",
      "0111-2233445-6",
      "Caba",
    );

    // ---- Helper: post a seeded payment + receipt + allocation -------
    let paymentSeq = 0;
    async function postSeededPayment(opts: {
      amountCents: number;
      method: "cash" | "check" | "bank_transfer" | "gcash" | "maya" | "card";
      contractId: ContractId;
      customerId: CustomerId;
      receivedAt: number;
      allocations: Array<{
        targetType: "contract" | "installment" | "perpetualCare" | "credit";
        targetId: string;
        amountCents: number;
      }>;
    }): Promise<{ paymentId: DataModel["payments"]["document"]["_id"]; receiptId: DataModel["receipts"]["document"]["_id"] }> {
      const { serial, formatted } = await allocateNextSerial(ctx);
      paymentSeq += 1;
      const paymentId = await ctx.db.insert("payments", {
        paymentNumber: formatted,
        contractId: opts.contractId as unknown as string,
        customerId: opts.customerId as unknown as string,
        amountCents: opts.amountCents,
        paymentMethod: opts.method,
        receivedAt: opts.receivedAt,
        receivedByUserId: officeId,
        idempotencyKey: `seed-payment-${paymentSeq}`,
        isVoided: false,
      });
      const receiptId = await ctx.db.insert("receipts", {
        paymentId,
        receiptSeries: RECEIPT_PREFIX,
        receiptNumber: formatted,
        receiptSerial: serial,
        contractId: opts.contractId as unknown as string,
        customerId: opts.customerId as unknown as string,
        amountCents: opts.amountCents,
        issuedAt: opts.receivedAt,
        issuedByUserId: officeId,
        isVoided: false,
      });
      let seq = 0;
      for (const a of opts.allocations) {
        await ctx.db.insert("paymentAllocations", {
          paymentId,
          targetType: a.targetType,
          targetId: a.targetId,
          amountCents: a.amountCents,
          sequence: seq++,
        });
      }
      return { paymentId, receiptId };
    }

    // ---- Contract 1: full-payment, paid in full (Juan, family lot) --
    const lotFamily = lotIdByCode.get("A-2-01")!;
    const pcFamily = 500000; // one_time family fee
    const c1Base = 34000000;
    const c1Total = c1Base + pcFamily;
    const c1Id = await ctx.db.insert("contracts", {
      contractNumber: "C-2026-0001-A-2-01",
      lotId: lotFamily,
      customerId: custJuan,
      kind: "full_payment",
      totalPriceCents: c1Total,
      state: "paid_in_full",
      createdAt: NOW - 40 * DAY,
      createdBy: officeId,
      basePriceCents: c1Base,
      discountCents: 0,
      perpetualCareCents: pcFamily,
      perpetualCarePaidCents: pcFamily,
    });
    const c1Pay = await postSeededPayment({
      amountCents: c1Total,
      method: "bank_transfer",
      contractId: c1Id,
      customerId: custJuan,
      receivedAt: NOW - 40 * DAY,
      allocations: [
        { targetType: "contract", targetId: c1Id as unknown as string, amountCents: c1Total },
      ],
    });
    await ctx.db.patch(c1Id, {
      paymentId: c1Pay.paymentId,
      receiptId: c1Pay.receiptId,
    });
    await ctx.db.insert("ownerships", {
      lotId: lotFamily,
      customerId: custJuan,
      effectiveFrom: NOW - 40 * DAY,
      transferType: "sale",
      createdAt: NOW - 40 * DAY,
      createdBy: officeId,
    });

    // ---- Contract 2: installment, active, ONE overdue (Maria) -------
    const lotMaus = lotIdByCode.get("C-1-01")!;
    const c2Base = 135000000;
    const pcMaus = 1000000;
    const c2Total = c2Base + pcMaus;
    const c2Down = 27200000; // 20% down
    const c2Term = 12;
    const c2Monthly = Math.round((c2Total - c2Down) / c2Term);
    const c2Id = await ctx.db.insert("contracts", {
      contractNumber: "C-2026-0002-C-1-01",
      lotId: lotMaus,
      customerId: custMaria,
      kind: "installment",
      totalPriceCents: c2Total,
      state: "active",
      createdAt: NOW - 95 * DAY,
      createdBy: officeId,
      downPaymentCents: c2Down,
      termMonths: c2Term,
      monthlyAmountCents: c2Monthly,
      firstDueDate: NOW - 65 * DAY,
      basePriceCents: c2Base,
      discountCents: 0,
      perpetualCareCents: pcMaus,
      perpetualCarePaidCents: pcMaus,
    });
    // Down payment (paid) — covers the perpetual care + the down payment.
    const c2DownPay = await postSeededPayment({
      amountCents: c2Down,
      method: "cash",
      contractId: c2Id,
      customerId: custMaria,
      receivedAt: NOW - 95 * DAY,
      allocations: [
        { targetType: "contract", targetId: c2Id as unknown as string, amountCents: c2Down },
      ],
    });
    await ctx.db.patch(c2Id, { paymentId: c2DownPay.paymentId, receiptId: c2DownPay.receiptId });
    await ctx.db.insert("ownerships", {
      lotId: lotMaus,
      customerId: custMaria,
      effectiveFrom: NOW - 95 * DAY,
      transferType: "sale",
      createdAt: NOW - 95 * DAY,
      createdBy: officeId,
    });
    // 12 installments. First two paid; #3 overdue (~5 days past due);
    // the rest pending in the future. Drives the AR-aging demo.
    for (let n = 1; n <= c2Term; n++) {
      const dueDate = (NOW - 65 * DAY) + (n - 1) * 30 * DAY;
      let status: "paid" | "overdue" | "pending";
      let paidCents = 0;
      let paidAt: number | undefined;
      if (n <= 2) {
        status = "paid";
        paidCents = c2Monthly;
        paidAt = dueDate + DAY;
      } else if (dueDate < NOW) {
        status = "overdue";
      } else {
        status = "pending";
      }
      const instId = await ctx.db.insert("installments", {
        contractId: c2Id,
        installmentNumber: n,
        dueDate,
        principalCents: c2Monthly,
        paidCents,
        status,
        ...(paidAt !== undefined ? { paidAt } : {}),
      });
      if (status === "paid") {
        await postSeededPayment({
          amountCents: c2Monthly,
          method: "gcash",
          contractId: c2Id,
          customerId: custMaria,
          receivedAt: paidAt!,
          allocations: [
            { targetType: "installment", targetId: instId as unknown as string, amountCents: c2Monthly },
          ],
        });
      }
    }

    // ---- Occupants + interment -------------------------------------
    // Helper: an occupied lot gets an occupant AND a completed interment
    // behind it, so the lot's "occupied" status is backed by a record.
    async function makeBuriedOccupant(
      lotId: LotId,
      name: string,
      relationship: string,
      buriedDaysAgo: number,
    ): Promise<void> {
      const buriedAt = NOW - buriedDaysAgo * DAY;
      const occId: OccupantId = await ctx.db.insert("occupants", {
        lotId,
        name,
        dateOfInterment: buriedAt,
        relationshipToOwner: relationship,
        createdAt: buriedAt - DAY,
        createdByUserId: officeId,
        isRemoved: false,
      });
      await ctx.db.insert("interments", {
        lotId,
        occupantId: occId,
        scheduledAt: buriedAt,
        status: "completed",
        scheduledBy: officeId,
        scheduledAt_createdAt: buriedAt - 5 * DAY,
        completedAt: buriedAt,
        completedBy: officeId,
        completionNotes: "Interment completed; marker set.",
      });
    }
    const lotOccupied = lotIdByCode.get("C-1-02")!;
    const lotNiche = lotIdByCode.get("N-1-02")!;
    await makeBuriedOccupant(lotOccupied, "Lola Remedios Reyes", "Grandmother", 200);
    await makeBuriedOccupant(lotNiche, "Tomas Aquino", "Uncle", 365);
    // A scheduled (upcoming) interment on the sold mausoleum lot.
    const occUpcoming: OccupantId = await ctx.db.insert("occupants", {
      lotId: lotMaus,
      name: "Don Alfonso Santos",
      relationshipToOwner: "Father",
      createdAt: NOW - 3 * DAY,
      createdByUserId: officeId,
      isRemoved: false,
    });
    await ctx.db.insert("interments", {
      lotId: lotMaus,
      occupantId: occUpcoming,
      scheduledAt: NOW + 7 * DAY,
      status: "scheduled",
      notes: "Family requests 9:00 AM service at the chapel.",
      scheduledBy: officeId,
      scheduledAt_createdAt: NOW - 3 * DAY,
      chapelReserved: true,
      pathwayReserved: false,
    });
    // ---- Expenses ---------------------------------------------------
    const expenses: Array<{ vendor: string; category: string; amountCents: number; daysAgo: number }> = [
      { vendor: "La Union Electric Coop", category: "Utilities", amountCents: 1850000, daysAgo: 12 },
      { vendor: "GreenScape Landscaping", category: "Maintenance", amountCents: 1200000, daysAgo: 20 },
      { vendor: "Payroll — March", category: "Salaries", amountCents: 9800000, daysAgo: 5 },
    ];
    for (const e of expenses) {
      await ctx.db.insert("expenses", {
        paidAt: NOW - e.daysAgo * DAY,
        amountCents: e.amountCents,
        vendor: e.vendor,
        category: e.category,
        recordedBy: officeId,
        recordedAt: NOW - e.daysAgo * DAY,
        approvalStatus: "approved",
        approvalThresholdCents: 0,
        approvedBy: adminId,
        approvedAt: NOW - e.daysAgo * DAY,
      });
    }

    return {
      alreadySeeded: false,
      summary: {
        accounts: 4,
        sections: 3,
        lots: lotSpecs.length,
        customers: 3,
        contracts: 2,
        receiptsAndPayments: paymentSeq,
        expenses: expenses.length,
      },
    };
  },
});
