/**
 * Custom ESLint rule: local-rules/no-direct-pii-read
 *
 * PII-read boundary — Story 2.3 AC4. Direct `ctx.db.get(<customerId>)`
 * reads in any `convex/` file are flagged WHEN the loaded value's
 * PII fields (`govIdNumber`, `address`, `phone`, `email`) are actually
 * accessed in the enclosing function, UNLESS the caller routes through
 * `readPii(ctx, customerId, fields, opts)` (the audited entry point in
 * `convex/lib/piiAccess.ts`), pairs the read with an adjacent
 * `logPiiAccess(...)` call, OR is explicitly opted-out via a
 * `// pii-read-ok: <reason>` comment (matching Story 2.5's existing
 * convention).
 *
 * Heuristic detection (static-only, no type-flow tracing):
 *   - Match `<...>.db.get(<arg>)` call expressions where the argument
 *     name CONTAINS the substring `customer` (case-insensitive) —
 *     `customerId`, `args.customerId`, `contract.customerId`, etc.
 *   - Identify the variable the result is assigned to (the enclosing
 *     `VariableDeclarator`'s `id`).
 *   - Scan the enclosing function for property-access patterns where
 *     that variable's PII fields are READ:
 *     `customer.govIdNumber`, `row.address`, `customer.phone`,
 *     `customer.email`. Reads of non-PII fields (`._id`, `.customerId`,
 *     `.fullName`, `.contractId`, etc.) DO NOT trigger the rule —
 *     ownership-check / FK-navigation reads are not PII accesses.
 *   - Flag the original read site when:
 *     1. A PII property is accessed AND
 *     2. The file is not exempt (see ALLOWED_BASENAMES) AND
 *     3. No `// pii-read-ok` comment precedes the call / statement AND
 *     4. No `logPiiAccess` / `readPii` call lives within 5 sibling
 *        statements (the "audit beside read" pattern).
 *
 * Why field-access scoping (not name-based alone):
 *   The repo has many legitimate ownership-check reads where a contract
 *   or webhook handler loads a `customers` row solely to verify
 *   existence or to read the `_id` for an `===` comparison. Flagging
 *   those as PII reads would force `pii-read-ok` annotations across
 *   files outside the rule's intent. The field-access scope keeps the
 *   rule sharp: it fires when the call site really IS reading PII.
 *
 * Allowed-basename exemptions:
 *   - `piiAccess.ts` — defines `readPii`; the helper itself contains
 *     the sanctioned `ctx.db.get` call.
 *   - `auth.ts` — the auth resolver reads `users` rows by id; the
 *     identifier may collide with the heuristic via test fixtures.
 *   - `schema.ts` — schema declaration, no runtime DB access.
 *
 * Limitation: the rule cannot statically prove that an arbitrary
 * variable is OR is NOT a `customers` row id. The combined "name has
 * customer + PII field accessed" heuristic catches the canonical
 * pattern; non-conforming code paths are flagged and the developer
 * either routes through `readPii`, pairs with `logPiiAccess`, or adds
 * the documented escape comment.
 */

"use strict";

const path = require("path");

const ALLOWED_BASENAMES = new Set([
  "piiAccess.ts",
  "auth.ts",
  "schema.ts",
]);

const PII_READ_OK_RE = /\bpii-read-ok\b/;

/** @type {import("eslint").Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Direct ctx.db.get(<customerId>) without routing through readPii / logPiiAccess is forbidden under convex/. Use convex/lib/piiAccess.ts:readPii, or annotate with // pii-read-ok: <reason>.",
    },
    schema: [],
    messages: {
      directPiiRead:
        "Direct PII read via ctx.db.get('{{name}}'): wrap in readPii(ctx, {{name}}, [...], { reason }) from convex/lib/piiAccess.ts, OR pair with logPiiAccess on the adjacent line, OR annotate with `// pii-read-ok: <reason>`. NFR-S8 / Story 2.3 AC4.",
      unloggedDocBlobUrl:
        "Minting a signed URL for a customer-document blob (ctx.storage.getUrl) is a PII-access event under NFR-S8: pair it with logPiiAccess on an adjacent line, OR annotate with `// pii-read-ok: <reason>`. An unlogged ID-scan view leaves breach-impact queries blind.",
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    const basename = path.basename(filename);
    if (ALLOWED_BASENAMES.has(basename)) {
      // The file owns the boundary — let it through.
      return {};
    }
    // Only apply under convex/.
    const normalised = filename.replace(/\\/g, "/");
    if (!normalised.includes("/convex/") && !normalised.startsWith("convex/")) {
      return {};
    }

    const sourceCode = context.sourceCode ?? context.getSourceCode();

    function isDbGetChain(callee) {
      if (!callee || callee.type !== "MemberExpression") return false;
      const method = callee.property;
      if (
        !method ||
        method.type !== "Identifier" ||
        method.name !== "get"
      ) {
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

    // Matches `<...>.storage.getUrl(...)` — the signed-URL minting path
    // for a stored blob. We only police this for customer-DOCUMENT blobs
    // (see fileTouchesCustomerDocuments below); receipt / report / BIR /
    // photo blobs use their own access patterns and are out of scope.
    function isStorageGetUrlChain(callee) {
      if (!callee || callee.type !== "MemberExpression") return false;
      const method = callee.property;
      if (
        !method ||
        method.type !== "Identifier" ||
        method.name !== "getUrl"
      ) {
        return false;
      }
      const storageObj = callee.object;
      if (!storageObj || storageObj.type !== "MemberExpression") return false;
      const storageProp = storageObj.property;
      if (
        !storageProp ||
        storageProp.type !== "Identifier" ||
        storageProp.name !== "storage"
      ) {
        return false;
      }
      return true;
    }

    // True when this file deals with the `customerDocuments` table at all
    // (its id validator, a query against it, etc.). This scopes the
    // storage.getUrl check sharply: only files that actually serve
    // customer-document blobs are policed, so receipts.ts / contracts.ts /
    // archivalExports.ts (which also call ctx.storage.getUrl on unrelated
    // blobs) never false-positive. The only minter today is
    // convex/customerDocuments.ts; any future file that adds customer-
    // document blob serving will reference the table name and be caught.
    const fileTouchesCustomerDocuments =
      /customerDocuments/.test(sourceCode.getText());

    /**
     * Returns the textual "name" of the first argument when it looks
     * like a customer-id reference. Recognised shapes:
     *   - Identifier `customerId`        → "customerId"
     *   - MemberExpression `args.customerId` / `contract.customerId` →
     *     "args.customerId"
     *   - CallExpression / others → null (not flagged; we cannot prove
     *     this is a customer-id read).
     *
     * Returns null when the name does NOT contain the substring
     * "customer" (case-insensitive); the heuristic targets the canonical
     * naming convention used throughout the codebase.
     */
    function customerIdishArgName(arg) {
      if (!arg) return null;
      let textual = null;
      if (arg.type === "Identifier") {
        textual = arg.name;
      } else if (arg.type === "MemberExpression") {
        // a.b — flatten to "a.b"
        const parts = [];
        let cursor = arg;
        while (cursor && cursor.type === "MemberExpression") {
          if (cursor.property && cursor.property.type === "Identifier") {
            parts.unshift(cursor.property.name);
          } else {
            return null;
          }
          cursor = cursor.object;
        }
        if (cursor && cursor.type === "Identifier") {
          parts.unshift(cursor.name);
          textual = parts.join(".");
        }
      }
      if (textual === null) return null;
      if (!/customer/i.test(textual)) return null;
      return textual;
    }

    function hasPiiReadOkComment(node) {
      // Check comments on the line above OR trailing on the same line.
      const comments = sourceCode.getCommentsBefore(node);
      for (const c of comments) {
        if (PII_READ_OK_RE.test(c.value)) return true;
      }
      // Walk up to the enclosing statement (VariableDeclaration /
      // ExpressionStatement / AwaitExpression) and look for comments
      // attached to it (the previous-line comment commonly attaches to
      // the statement, not the inner call).
      let cursor = node.parent;
      while (
        cursor &&
        cursor.type !== "VariableDeclaration" &&
        cursor.type !== "ExpressionStatement" &&
        cursor.type !== "ReturnStatement"
      ) {
        cursor = cursor.parent;
      }
      if (cursor) {
        const stmtComments = sourceCode.getCommentsBefore(cursor);
        for (const c of stmtComments) {
          if (PII_READ_OK_RE.test(c.value)) return true;
        }
      }
      return false;
    }

    /**
     * Walks the siblings AFTER the enclosing statement looking for an
     * adjacent `logPiiAccess(...)` or `readPii(...)` call expression.
     * "Adjacent" = within the same block, within 3 statements (to allow
     * for trivial intermediate handling like `if (row === null) throw`).
     */
    function adjacentAuditCallExists(node, name) {
      let stmt = node;
      while (
        stmt &&
        stmt.type !== "VariableDeclaration" &&
        stmt.type !== "ExpressionStatement" &&
        stmt.type !== "ReturnStatement"
      ) {
        stmt = stmt.parent;
      }
      if (!stmt || !stmt.parent || !Array.isArray(stmt.parent.body)) {
        return false;
      }
      const body = stmt.parent.body;
      const idx = body.indexOf(stmt);
      if (idx < 0) return false;
      // Search the next 5 sibling statements (the "audit-then-read" or
      // "read-then-audit" pattern is usually adjacent).
      const SCAN_RADIUS = 5;
      for (
        let i = Math.max(0, idx - SCAN_RADIUS);
        i <= Math.min(body.length - 1, idx + SCAN_RADIUS);
        i++
      ) {
        if (i === idx) continue;
        const sibling = body[i];
        if (statementContainsAuditCall(sibling, name)) return true;
      }
      return false;
    }

    function statementContainsAuditCall(stmt, _name) {
      const text = sourceCode.getText(stmt);
      // Cheap textual scan — the rule's signal is "did the developer
      // explicitly wire an audit call somewhere right next to the
      // read?" — full AST traversal is overkill for a heuristic.
      if (/\blogPiiAccess\s*\(/.test(text)) return true;
      if (/\breadPii\s*\(/.test(text)) return true;
      return false;
    }

    // PII property names whose access on the loaded value qualifies
    // the read as a PII access (per the rule's docstring). Reads of
    // `_id`, `customerId`, `contractId`, `fullName`, etc. DO NOT
    // qualify — they're FK-navigation or display-name reads that
    // aren't part of NFR-S8's breach-impact corpus.
    const PII_FIELD_NAMES = new Set([
      "govIdNumber",
      "address",
      "phone",
      "email",
    ]);

    /**
     * Returns the variable name the call result is assigned to, when
     * the enclosing structure is a `VariableDeclarator`. Handles both:
     *   - `const c = await ctx.db.get(...)`
     *   - `const c = ctx.db.get(...)`
     * Returns null when the call is used directly (no assignment) or
     * the assignment target is a destructuring pattern.
     */
    function assignedVarName(callNode) {
      let cursor = callNode.parent;
      // Unwrap a single AwaitExpression.
      if (cursor && cursor.type === "AwaitExpression") {
        cursor = cursor.parent;
      }
      if (
        cursor &&
        cursor.type === "VariableDeclarator" &&
        cursor.id &&
        cursor.id.type === "Identifier"
      ) {
        return cursor.id.name;
      }
      return null;
    }

    /**
     * Walks the enclosing block / function body for any property-
     * access expression of the form `<varName>.<piiField>` where
     * `piiField` is in PII_FIELD_NAMES. Returns true on first match.
     */
    function functionAccessesPiiField(callNode, varName) {
      // Find the enclosing function-body / block to scope the scan.
      let cursor = callNode.parent;
      while (
        cursor &&
        cursor.type !== "BlockStatement" &&
        cursor.type !== "Program"
      ) {
        cursor = cursor.parent;
      }
      if (!cursor) return false;
      const text = sourceCode.getText(cursor);
      // Cheap textual scan — `<varName>.<piiField>` with a word
      // boundary. Handles `customer.govIdNumber`, `customer.address`,
      // etc. Also catches `customer?.email` (optional chaining) via
      // the lookahead allowing `?` after the var name.
      for (const field of PII_FIELD_NAMES) {
        const re = new RegExp(`\\b${escapeRegExp(varName)}\\??\\.${field}\\b`);
        if (re.test(text)) return true;
      }
      return false;
    }

    function escapeRegExp(s) {
      return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    return {
      CallExpression(node) {
        // Customer-document blob URL minting (NFR-S8 file-view boundary).
        if (
          fileTouchesCustomerDocuments &&
          isStorageGetUrlChain(node.callee)
        ) {
          if (
            !hasPiiReadOkComment(node) &&
            !adjacentAuditCallExists(node, "storage.getUrl")
          ) {
            context.report({ node, messageId: "unloggedDocBlobUrl" });
          }
          return;
        }
        if (!isDbGetChain(node.callee)) return;
        const arg = node.arguments[0];
        const name = customerIdishArgName(arg);
        if (name === null) return;
        if (hasPiiReadOkComment(node)) return;
        if (adjacentAuditCallExists(node, name)) return;
        // Field-access scoping: only fire when the loaded value's PII
        // fields are actually accessed in the enclosing function. A
        // bare ownership-check `ctx.db.get(customerId)` whose result
        // is only used for `=== null` or `.customerId === me` is NOT
        // a PII read; we don't flag it. The audited-surface intent is
        // covered by the field-access scope.
        const varName = assignedVarName(node);
        if (varName === null) {
          // No assignment target — likely a bare existence check
          // (`if (await ctx.db.get(customerId)) ...`). Not a PII read.
          return;
        }
        if (!functionAccessesPiiField(node, varName)) return;
        context.report({
          node,
          messageId: "directPiiRead",
          data: { name },
        });
      },
    };
  },
};
