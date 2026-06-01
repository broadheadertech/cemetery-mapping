/**
 * Custom ESLint rule: convex/no-audit-log-mutation
 *
 * Audit log is append-only (NFR-S7 / FR59). This rule blocks any
 * `ctx.db.{patch,replace,delete}` against a `Doc<"auditLog">` value.
 *
 * Detection (heuristic — Convex's row-by-id model doesn't carry the
 * table name through to the call site, so we match on the spelling of
 * the id-yielding expression):
 *   - CallExpression where callee is `<...>.db.patch | .db.replace | .db.delete`
 *   - AND the first argument expression CONTAINS the literal text
 *     "auditLog" anywhere (e.g. `ctx.db.query("auditLog")...`,
 *     `auditLogRow._id`, `auditLogId`). This catches the obvious
 *     misuses; the audit log is never patched in normal app code so
 *     false positives are unlikely.
 *
 * Exempt files: `convex/lib/audit.ts` (the helper itself) is exempted
 * via `eslint.config.mjs`'s `ignores` for this rule.
 */

"use strict";

/** @type {import("eslint").Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Audit log is append-only — patch/replace/delete against an auditLog row is forbidden.",
    },
    schema: [],
    messages: {
      mutation:
        "Audit log is append-only (NFR-S7 / FR59). ctx.db.{{op}}(...) on an auditLog row is forbidden.",
    },
  },

  create(context) {
    const MUTATION_OPS = new Set(["patch", "replace", "delete"]);

    function isDbMutationChain(callee) {
      if (!callee || callee.type !== "MemberExpression") return null;
      const op = callee.property;
      if (!op || op.type !== "Identifier" || !MUTATION_OPS.has(op.name)) {
        return null;
      }
      const dbObj = callee.object;
      if (!dbObj || dbObj.type !== "MemberExpression") return null;
      const dbProp = dbObj.property;
      if (!dbProp || dbProp.type !== "Identifier" || dbProp.name !== "db") {
        return null;
      }
      return op.name;
    }

    function argMentionsAuditLog(node) {
      const sourceCode = context.sourceCode ?? context.getSourceCode();
      const text = sourceCode.getText(node);
      return /auditLog/i.test(text);
    }

    return {
      CallExpression(node) {
        const op = isDbMutationChain(node.callee);
        if (!op) return;
        const arg = node.arguments[0];
        if (!arg) return;
        if (!argMentionsAuditLog(arg)) return;
        context.report({
          node,
          messageId: "mutation",
          data: { op },
        });
      },
    };
  },
};
