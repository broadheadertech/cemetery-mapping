import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";
import localRules from "eslint-plugin-local-rules";
import jsxA11y from "eslint-plugin-jsx-a11y";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    plugins: {
      "local-rules": localRules,
      "jsx-a11y": jsxA11y,
    },
    rules: {
      // NFR-M1: TypeScript strict mode; no `any` without explicit suppression.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Story 1.5 Task 10: enable the two jsx-a11y rules that codify
      // the heading + role hygiene we care about for the app shell.
      // The remaining a11y guardrails are covered by axe-core in CI
      // (Story 1.4 visual-foundation spec; Story 1.5 extends to the
      // staff shell + open palette).
      "jsx-a11y/heading-has-content": "error",
      "jsx-a11y/no-redundant-roles": "error",
    },
  },
  {
    // Story 1.2: every public Convex function in convex/ must call
    // requireRole or requireAuth as its first action. The rule lives in
    // eslint-rules/require-role-first-line.js and is exported by
    // eslint-local-rules.js at the repo root.
    //
    // Exemptions (these files contain provider config, helpers, or
    // schema and either can't or shouldn't call the auth helpers):
    files: ["convex/**/*.ts"],
    ignores: [
      "convex/_generated/**",
      "convex/lib/**",
      "convex/http.ts",
      "convex/auth.ts",
      "convex/auth.config.ts",
      "convex/schema.ts",
    ],
    rules: {
      "local-rules/require-role-first-line": "error",
    },
  },
  {
    // Story 1.7: state-machine transition guards. Files in convex/ must
    // not raw-patch the `status` field via ctx.db.patch(..., { status })
    // unless they import from convex/lib/stateMachines. The rule itself
    // also exempts convex/lib/stateMachines.ts (defines the helpers)
    // and convex/seed.ts (seeding may set initial statuses). The rule
    // file lives in eslint-rules/no-raw-status-patch.js.
    files: ["convex/**/*.ts"],
    ignores: ["convex/_generated/**"],
    rules: {
      "local-rules/no-raw-status-patch": "error",
    },
  },
  {
    // Story 1.6 (deferred-task closeout): audit-log append-only enforcement.
    // NFR-S7 / FR59 — audit-log rows must only be created by emitAudit
    // in convex/lib/audit.ts; never patched, replaced, or deleted.
    files: ["convex/**/*.ts"],
    ignores: [
      "convex/_generated/**",
      "convex/lib/audit.ts", // the canonical inserter
    ],
    rules: {
      "local-rules/no-audit-log-direct-write": "error",
      "local-rules/no-audit-log-mutation": "error",
    },
  },
  {
    // Story 3.1: BIR receipt counter boundary enforcement.
    // FR28 / NFR-C1 — direct ctx.db access to "receiptCounter" is
    // forbidden outside the allowed files. The rule itself bakes the
    // exempt list (receiptCounter.ts, postFinancialEvent.ts,
    // receiptCounterTesting.ts, schema.ts) and short-circuits in those
    // files, so we don't duplicate the list here. The rule file lives
    // in eslint-rules/no-direct-receipt-counter-access.js.
    files: ["convex/**/*.ts"],
    ignores: ["convex/_generated/**"],
    rules: {
      "local-rules/no-direct-receipt-counter-access": "error",
    },
  },
  {
    // Story 2.3 AC4: PII-read boundary enforcement.
    // NFR-S8 — direct `ctx.db.get(<customerId>)` reads in convex/ must
    // either route through `readPii` (the audited entry point in
    // `convex/lib/piiAccess.ts`), pair with an adjacent `logPiiAccess`
    // call, or carry the documented `// pii-read-ok: <reason>` escape
    // comment. The rule itself bakes the exempt files (piiAccess.ts,
    // auth.ts, schema.ts) and the adjacent-audit + comment exemptions.
    files: ["convex/**/*.ts"],
    ignores: ["convex/_generated/**"],
    rules: {
      "local-rules/no-direct-pii-read": "error",
    },
  },
  {
    // Story 3.2: financial-entity write boundary enforcement.
    // FR28 / FR32 / NFR-C1 / NFR-C2 — direct ctx.db.{insert,replace,delete}
    // against "payments" / "receipts" / "paymentAllocations" is forbidden
    // outside the cornerstone helper. The rule itself bakes the exempt
    // list (postFinancialEvent.ts, schema.ts) and short-circuits in those
    // files. See `eslint-rules/no-direct-financial-write.js`.
    files: ["convex/**/*.ts"],
    ignores: ["convex/_generated/**"],
    rules: {
      "local-rules/no-direct-financial-write": "error",
    },
  },
  {
    // TODO (Story 1.5 or later): "local-rules/no-leaflet-client-import"
    //   — bans client-side imports of `leaflet` (must be lazy via next/dynamic).
    //
    // Story 3.1 (DONE): "local-rules/no-direct-receipt-counter-access"
    //   — bans ctx.db.<method>("receiptCounter", ...) outside
    //     convex/lib/{receiptCounter,postFinancialEvent,receiptCounterTesting}.ts
    //     and convex/schema.ts. Wired above.
    //
    // Story 3.2 (DONE): "local-rules/no-direct-financial-write"
    //   — bans ctx.db.{insert,replace,delete}("payments" | "receipts"
    //     | "paymentAllocations", ...) outside convex/lib/postFinancialEvent.ts
    //     and convex/schema.ts. Wired above.
    //
    // TODO (Story 3.x): "local-rules/no-cents-math" — flags `* / 100`
    //   or `* 100` on identifiers ending in `Cents`.
    files: ["src/**/*.{ts,tsx}"],
  },
  {
    // Story 1.5 Task 10: every Next.js App Router `page.tsx` must render
    // exactly one top-level <h1>. The custom rule scans for JSX <h1>
    // occurrences; 0 or 2+ fails the build. See
    // `eslint-rules/single-h1-per-page.js`.
    files: ["src/app/**/page.tsx"],
    rules: {
      "local-rules/single-h1-per-page": "error",
    },
  },
  {
    // The custom-rule source itself is CommonJS and lints as plain JS.
    files: ["eslint-rules/**/*.js", "eslint-local-rules.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];

export default eslintConfig;
