/**
 * Custom ESLint rule: convex/no-audit-log-direct-write
 *
 * Blocks `ctx.db.insert("auditLog", ...)` calls in any file under
 * `convex/**` except `convex/lib/audit.ts` (where `emitAudit` is the
 * one allowed inserter). NFR-S7 / FR59: audit-log writes must go
 * through the helper so PII redaction, schema validation, and the
 * controlled action vocabulary all apply.
 *
 * Detection:
 *   - CallExpression where callee is `<...>.db.insert` (MemberExpression
 *     chain) AND first argument is a string literal "auditLog".
 *
 * The rule fires regardless of how the chain is spelled — `ctx.db.insert`,
 * `mutationCtx.db.insert`, `(await someCtxFactory()).db.insert`. We
 * match on the member shape `.db.insert(...)` with a "auditLog" first
 * argument. False positives are unlikely; if a future helper needs to
 * write to auditLog, it lives in `convex/lib/audit.ts` (already exempt).
 */

"use strict";

/** @type {import("eslint").Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Direct ctx.db.insert into auditLog is forbidden — use emitAudit from convex/lib/audit.ts.",
    },
    schema: [],
    messages: {
      directInsert:
        "Direct ctx.db.insert('auditLog', ...) is forbidden. Use emitAudit(ctx, ...) from convex/lib/audit.ts. NFR-S7 / FR59.",
    },
  },

  create(context) {
    function isDbInsertChain(callee) {
      // We want: <anything>.db.insert
      if (!callee || callee.type !== "MemberExpression") return false;
      const insert = callee.property;
      if (!insert || insert.type !== "Identifier" || insert.name !== "insert") {
        return false;
      }
      const dbObj = callee.object;
      if (!dbObj || dbObj.type !== "MemberExpression") return false;
      const dbProp = dbObj.property;
      if (!dbProp || dbProp.type !== "Identifier" || dbProp.name !== "db") {
        return false;
      }
      return true;
    }

    function firstArgIsAuditLog(node) {
      const arg = node.arguments[0];
      if (!arg) return false;
      if (arg.type === "Literal" && arg.value === "auditLog") return true;
      // ESTree TemplateLiteral with no interpolation
      if (
        arg.type === "TemplateLiteral" &&
        arg.expressions.length === 0 &&
        arg.quasis.length === 1 &&
        arg.quasis[0].value.cooked === "auditLog"
      ) {
        return true;
      }
      return false;
    }

    return {
      CallExpression(node) {
        if (!isDbInsertChain(node.callee)) return;
        if (!firstArgIsAuditLog(node)) return;
        context.report({
          node,
          messageId: "directInsert",
        });
      },
    };
  },
};
