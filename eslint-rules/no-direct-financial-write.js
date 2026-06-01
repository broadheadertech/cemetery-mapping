/**
 * Custom ESLint rule: local-rules/no-direct-financial-write
 *
 * Financial-entity write boundary (Story 3.2 — FR28, FR32, NFR-C1,
 * NFR-C2). Blocks ANY direct `ctx.db.<method>("payments" | "receipts"
 * | "paymentAllocations", ...)` call expression in a file outside the
 * cornerstone helper. The cornerstone (`convex/lib/postFinancialEvent.ts`)
 * is the SINGLE point at which money touches the database; lint
 * enforces what code review can miss.
 *
 * Forbidden patterns (all in files other than the cornerstone):
 *   - ctx.db.insert("payments", ...)
 *   - ctx.db.insert("receipts", ...)
 *   - ctx.db.insert("paymentAllocations", ...)
 *   - ctx.db.patch on a value queried from those tables — heuristic
 *     coverage via the table-name detector on the *.query/get path
 *     is not enforced here (the static-only rule cannot follow the
 *     id flow). The literal-table-name surface catches the most
 *     common drive-by mistake; the architectural boundary + code
 *     review close the rest.
 *   - ctx.db.replace("payments" | "receipts" | "paymentAllocations", ...)
 *   - ctx.db.delete on a financial-table row by id — same flow
 *     limitation as above. The cornerstone NEVER deletes; lint flags
 *     literal table-name deletes via `ctx.db.delete("payments", ...)`
 *     (Convex's `delete` API takes an id, not a table name, so this
 *     pattern is rare-in-practice but covered for completeness if a
 *     hand-rolled helper ever destructures the table-name string).
 *
 * Allowed:
 *   - `ctx.db.query("payments" | "receipts" | "paymentAllocations",
 *     ...)` — reads are unrestricted. Reporting queries, the
 *     idempotency-key lookup, the contract-detail timeline all read
 *     these tables.
 *   - All calls inside `convex/lib/postFinancialEvent.ts` — the
 *     cornerstone is the implementation.
 *   - The schema declaration in `convex/schema.ts` — the literal
 *     "payments" etc. appears as part of `defineTable` and is not a
 *     runtime DB access.
 *
 * Detection:
 *   - CallExpression where callee is `<...>.db.<method>` (MemberExpression
 *     chain) AND method is one of `insert`, `replace`, `delete` AND
 *     the first argument is a string literal matching one of the
 *     financial tables.
 *   - Untagged template literals (e.g. `` ctx.db.insert(`payments`, x) ``)
 *     are also matched — same canonicalisation pattern as
 *     `no-audit-log-direct-write.js`.
 *
 * Limitation (acknowledged in ADR-0012):
 *   The rule cannot statically detect dynamic table names —
 *   `const t = "payments"; ctx.db.insert(t, ...)` slips through. The
 *   architectural boundary + code review catch this; the rule
 *   catches the 95% straightforward case. The receiptCounter rule
 *   (Story 3.1) accepts the same limitation explicitly.
 */

"use strict";

const path = require("path");

const FINANCIAL_TABLES = new Set([
  "payments",
  "receipts",
  "paymentAllocations",
]);

const WRITE_METHODS = new Set(["insert", "replace", "delete"]);

const ALLOWED_BASENAMES = new Set([
  "postFinancialEvent.ts",
  // schema.ts contains the table declaration; the literal "payments"
  // appears in `defineTable` and is not a runtime DB access.
  "schema.ts",
  // seed.ts is the operator-run demo/initial-data seeder (invoked only via
  // `npx convex run seed:*`, never client-callable). Like postFinancialEvent
  // it is a sanctioned writer of financial rows — it reuses
  // `allocateNextSerial` so seeded receipts are serial-consistent with
  // cornerstone-produced ones. Keep this file STRICTLY seed-only.
  "seed.ts",
]);

/** @type {import("eslint").Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Direct ctx.db.{insert,replace,delete} into financial tables (payments / receipts / paymentAllocations) is forbidden — route through postFinancialEvent. See docs/adr/0012-postfinancialevent-cornerstone.md.",
    },
    schema: [],
    messages: {
      directWrite:
        "Direct write to financial table '{{table}}' via ctx.db.{{method}} is forbidden. Route through postFinancialEvent (convex/lib/postFinancialEvent.ts). FR32 / NFR-C1.",
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    const basename = path.basename(filename);
    if (ALLOWED_BASENAMES.has(basename)) {
      // The file owns the boundary — let it through.
      return {};
    }

    function getDbMethod(callee) {
      if (!callee || callee.type !== "MemberExpression") return null;
      const method = callee.property;
      if (!method || method.type !== "Identifier") return null;
      if (!WRITE_METHODS.has(method.name)) return null;
      const dbObj = callee.object;
      if (!dbObj || dbObj.type !== "MemberExpression") return null;
      const dbProp = dbObj.property;
      if (!dbProp || dbProp.type !== "Identifier" || dbProp.name !== "db") {
        return null;
      }
      return method.name;
    }

    function getFirstArgFinancialTable(node) {
      const arg = node.arguments[0];
      if (!arg) return null;
      if (arg.type === "Literal" && typeof arg.value === "string") {
        return FINANCIAL_TABLES.has(arg.value) ? arg.value : null;
      }
      // ESTree TemplateLiteral with no interpolation, e.g. `payments`.
      if (
        arg.type === "TemplateLiteral" &&
        arg.expressions.length === 0 &&
        arg.quasis.length === 1
      ) {
        const cooked = arg.quasis[0].value.cooked;
        return FINANCIAL_TABLES.has(cooked) ? cooked : null;
      }
      return null;
    }

    return {
      CallExpression(node) {
        const method = getDbMethod(node.callee);
        if (method === null) return;
        const table = getFirstArgFinancialTable(node);
        if (table === null) return;
        context.report({
          node,
          messageId: "directWrite",
          data: { table, method },
        });
      },
    };
  },
};
