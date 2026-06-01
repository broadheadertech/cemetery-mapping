# Story 2.2: Office Staff Uploads Identification Documents

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **Office Staff (Maria)**,
I want **to upload ID scans, transfer affidavits, and other documents to a customer or transfer record — gated on the customer's retention consent, capped at 10MB, served via short-lived auth-checked signed URLs, with the upload + every subsequent view logged**,
so that **the cemetery retains digital copies of legally-relevant documentation without exposing PII attachments to direct unauthenticated URLs** (FR15, NFR-S3, NFR-C5).

This is the **first File Storage story** in the codebase. It introduces the `customerAttachments` table (metadata pointer to Convex File Storage blobs), the upload-URL generation pattern (`generateUploadUrl` action with role check), the signed-URL retrieval pattern (queries that produce short-lived storage URLs gated on role), the 10MB client-side validation, and the consent gate (`hasConsent === true` required for `gov_id_scan` uploads). It locks the pattern that Stories 1.14 (lot condition photo), 2.7 (transfer affidavits), and Epic 3 (receipt photos) will all reuse.

## Acceptance Criteria

1. **AC1 — `customerAttachments` schema is defined** (FR15): `convex/schema.ts` extends with `customerAttachments` table: `customerId` (`v.id("customers")`), `storageId` (`v.id("_storage")` — Convex's built-in file storage ID type), `attachmentType` (union literal: `"gov_id_scan" | "transfer_affidavit" | "death_certificate" | "court_order" | "other"`), `fileName` (string — original client filename, for display), `mimeType` (string), `sizeBytes` (number), `uploadedAt` (number), `uploadedByUserId` (`v.id("users")`), `notes` (optional string). Indexed by `by_customer` (`["customerId"]`) and `by_customer_type` (`["customerId", "attachmentType"]`).

2. **AC2 — Upload URL action is auth-checked and consent-gated** (NFR-S3, NFR-C5): `convex/customers.ts` exports a `generateUploadUrl` action (Convex action — necessary because `ctx.storage.generateUploadUrl()` is action-only in current Convex). The action: (a) `requireRole(ctx, ["office_staff", "admin"])`; (b) takes args `{ customerId: v.id("customers"), attachmentType: <literal>, expectedSizeBytes: v.number(), expectedMimeType: v.string() }`; (c) loads the customer doc; if `attachmentType === "gov_id_scan"` and `customer.hasConsent === false`, throws `ConvexError({ code: "CONSENT_REQUIRED", message: "Customer consent for ID retention is required before attaching ID scans." })`; (d) rejects `expectedSizeBytes > 10 * 1024 * 1024` with `ConvexError({ code: "FILE_TOO_LARGE" })`; (e) rejects `expectedMimeType` not in the allowlist (`image/jpeg`, `image/png`, `image/webp`, `application/pdf`) with `ConvexError({ code: "UNSUPPORTED_FILE_TYPE" })`; (f) returns `{ uploadUrl: await ctx.storage.generateUploadUrl(), expiresAt: Date.now() + 60_000 }` — Convex's upload URL is short-lived by default.

3. **AC3 — `recordAttachment` mutation links the uploaded blob to the customer** (FR15, NFR-S7): After the client POSTs the file directly to the upload URL and receives the `storageId`, it calls `convex/customers.ts → recordAttachment(ctx, { customerId, storageId, attachmentType, fileName, mimeType, sizeBytes })`. The mutation: (a) `requireRole(ctx, ["office_staff", "admin"])`; (b) re-validates consent (defense-in-depth — between `generateUploadUrl` and `recordAttachment`, the customer's consent could theoretically be revoked; refuse `gov_id_scan` if `hasConsent === false`); (c) re-validates size + mime against the actual file metadata fetched via `ctx.db.system.get(storageId)` (a Convex pattern for reading storage metadata); (d) inserts the `customerAttachments` row; (e) calls `emitAudit(ctx, { action: "customerAttachment.upload", entityType: "customerAttachment", entityId: newAttachmentId, before: null, after: { ...row, storageId: "[storage-id-redacted]" }, reason: undefined })` — the `storageId` is replaced with a sentinel to keep audit logs free of direct storage references that could leak via `auditLog` reads.

4. **AC4 — Signed-URL retrieval is role-gated and access-logged** (NFR-S3, NFR-S8, UX-DR30): A `convex/customers.ts → getAttachmentUrl` query takes `{ attachmentId: v.id("customerAttachments") }`, calls `requireRole(ctx, ["office_staff", "admin"])`, generates a short-lived signed URL via `ctx.storage.getUrl(storageId)`, **and logs the access to `piiAccessLog`** (preview of the Story 2.3 helper — this story writes one row directly to the `piiAccessLog` table using a stub pattern; Story 2.3 then refactors it to route through `readPii`). The query returns `{ url, expiresAt }`. Convex's signed URLs are auth-gated by default — direct fetch by unauthenticated parties returns 403 (NFR-S3 confirmed).

5. **AC5 — `AttachmentUploadField` component validates client-side and uploads** (UX integration): A new `src/components/CustomerForm/AttachmentUploadField.tsx` component renders a drag-and-drop + file-picker zone (using a minimal Tailwind-styled `<input type="file">` per architecture's "no extra dep unless justified" stance — no `react-dropzone`). The component: (a) accepts an `accept` prop (`"image/jpeg,image/png,image/webp,application/pdf"`); (b) validates `file.size <= 10 * 1024 * 1024` before upload, showing inline error `"File must be smaller than 10MB. Try resizing."`; (c) validates MIME type against the allowlist with `"Only JPG, PNG, WEBP, or PDF files are allowed."`; (d) calls `generateUploadUrl` action → POSTs file to the URL → calls `recordAttachment` mutation with the resulting `storageId`; (e) shows a progress indicator during upload; (f) on consent failure, surfaces the inline "consent required" message + a link to "Update consent on customer record." The component is reusable: customer detail page (Story 2.5), transfer flow (Story 2.7), and the customer-create form (Story 2.1's `/customers/new` — note: in 2.1 the form is built but file upload is deferred to 2.2; that's expected).

6. **AC6 — Unauthorized fetch returns 403** (NFR-S3): An E2E spec confirms that an unauthenticated browser (no session cookie) fetching a previously-issued signed URL after its expiry, OR a field_worker fetching one before expiry, gets a 403 / 401 response. This is Convex's built-in behavior; the spec exists to confirm we haven't accidentally created a public URL pattern.

## Tasks / Subtasks

### Schema (AC1)

- [ ] **Task 1: Define `customerAttachments` table in `convex/schema.ts`** (AC: 1)
  - [ ] Field definitions per AC1. Use `v.id("_storage")` for `storageId` — this is the canonical Convex File Storage ID type.
  - [ ] Add the `by_customer` and `by_customer_type` indexes.
  - [ ] Do NOT add a `by_storageId` index — `storageId` is opaque; we never need to look up by it from user code (we always start from the attachment doc).
  - [ ] Add `piiAccessLog` table per AC4 — the **schema lands here as a stub** for the Story 2.3 helper. Schema: `userId: v.id("users")`, `customerId: v.id("customers")`, `timestamp: v.number()`, `fields: v.array(v.string())`, `accessType: v.union(v.literal("read"), v.literal("file_view"), v.literal("subject_report_export"))`. Indexed `by_customer_timestamp` (`["customerId", "timestamp"]`) and `by_timestamp` (`["timestamp"]` — for breach-impact queries per NFR-C4). **The full `readPii` helper lands in Story 2.3.** This story writes to `piiAccessLog` from `getAttachmentUrl` directly; that direct-write will be the last one before Story 2.3 makes the ESLint rule enforce routing through `readPii`.

- [ ] **Task 2: Update `convex/lib/errors.ts` with new codes** (AC: 2, AC: 3)
  - [ ] Add to `ErrorCode` constants: `CONSENT_REQUIRED`, `FILE_TOO_LARGE`, `UNSUPPORTED_FILE_TYPE`, `ATTACHMENT_NOT_FOUND`.
  - [ ] Each code has a human-readable message companion exported as `ErrorMessages[code]` — kept server-side for now (the client error-translation layer in `src/lib/errors.ts` translates code → user sentence with i18n-friendly indirection per architecture § 300).

### Backend (AC2, AC3, AC4, AC6)

- [ ] **Task 3: Implement `generateUploadUrl` action in `convex/customers.ts`** (AC: 2)
  - [ ] **Action**, not mutation — Convex's `ctx.storage.generateUploadUrl()` is only available in actions. Use `action({ ... })` from `_generated/server`. **First line: `await requireRole(ctx, ["office_staff", "admin"]);`** — Story 1.2's helper works in `ActionCtx` just as it does in `MutationCtx` / `QueryCtx`.
  - [ ] Args validator: `v.object({ customerId: v.id("customers"), attachmentType: v.union(v.literal("gov_id_scan"), v.literal("transfer_affidavit"), v.literal("death_certificate"), v.literal("court_order"), v.literal("other")), expectedSizeBytes: v.number(), expectedMimeType: v.string() })`.
  - [ ] Use `ctx.runQuery(internal.customers._loadCustomerForAttachment, { customerId })` (an `internalQuery` that bypasses public role checks — actions can call internal functions; see architecture § 142 on internal-function exemption from RBAC lint rule). Internal query returns `{ hasConsent: boolean } | null`.
  - [ ] Consent gate: if `attachmentType === "gov_id_scan"` and `!customer.hasConsent` → `throwError(ErrorCode.CONSENT_REQUIRED, ErrorMessages.CONSENT_REQUIRED)`.
  - [ ] Size gate: `expectedSizeBytes > 10 * 1024 * 1024` → `throwError(ErrorCode.FILE_TOO_LARGE, "File must be smaller than 10MB. Try resizing.")`.
  - [ ] MIME gate: `!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(expectedMimeType)` → `throwError(ErrorCode.UNSUPPORTED_FILE_TYPE, "Only JPG, PNG, WEBP, or PDF files are allowed.")`.
  - [ ] Return `{ uploadUrl: await ctx.storage.generateUploadUrl(), expiresAt: Date.now() + 60_000 }`.

- [ ] **Task 4: Implement `recordAttachment` mutation in `convex/customers.ts`** (AC: 3)
  - [ ] First line: `await requireRole(ctx, ["office_staff", "admin"]);`.
  - [ ] Args: `customerId`, `storageId: v.id("_storage")`, `attachmentType`, `fileName: v.string()`, `mimeType: v.string()`, `sizeBytes: v.number()`.
  - [ ] **Re-validate consent** (defense-in-depth): load the customer; refuse `gov_id_scan` uploads when `hasConsent === false`. This catches the race where consent was revoked between `generateUploadUrl` and `recordAttachment`.
  - [ ] **Re-validate size + mime via storage metadata.** Convex exposes file metadata via `await ctx.db.system.get(storageId)` (returns `{ contentType, size, ... }`). Verify the actual uploaded file matches the declared `mimeType` + `sizeBytes` (defense against a client lying about the file). If mismatch → `throwError(ErrorCode.FILE_TOO_LARGE)` or `UNSUPPORTED_FILE_TYPE` as appropriate, then `await ctx.storage.delete(storageId)` to clean up the orphan blob, then throw.
  - [ ] Insert the attachment row with `uploadedAt: Date.now()`, `uploadedByUserId: userId from requireRole`.
  - [ ] Call `emitAudit(ctx, { action: "customerAttachment.upload", entityType: "customerAttachment", entityId: attachmentId, before: null, after: { ...row, storageId: "[storage-id-redacted]" }, reason: undefined })` — replace `storageId` with the sentinel string to prevent audit log readers from getting a backdoor to file URLs.
  - [ ] Return `{ attachmentId }`.

- [ ] **Task 5: Implement `getAttachmentUrl` query in `convex/customers.ts`** (AC: 4)
  - [ ] First line: `await requireRole(ctx, ["office_staff", "admin"]);`.
  - [ ] Args: `{ attachmentId: v.id("customerAttachments") }`.
  - [ ] Load the attachment row; if missing → `throwError(ErrorCode.ATTACHMENT_NOT_FOUND)`.
  - [ ] Generate the URL: `await ctx.storage.getUrl(attachment.storageId)` — Convex returns a short-lived signed URL (auth-gated by default).
  - [ ] **Write a `piiAccessLog` entry directly here** — Story 2.3 will refactor this to route through `readPii`. For now: `await ctx.db.insert("piiAccessLog", { userId, customerId: attachment.customerId, timestamp: Date.now(), fields: ["customerAttachment.url"], accessType: "file_view" })`.
  - [ ] Add a leading comment block: `// TODO(Story 2.3): replace direct piiAccessLog.insert with readPii(ctx, attachment.customerId, ["customerAttachment.url"]).` Story 2.3's ESLint rule will catch the leftover when it lands.
  - [ ] Return `{ url, expiresAt: Date.now() + 60_000, fileName: attachment.fileName, mimeType: attachment.mimeType }`.

- [ ] **Task 6: Implement `listAttachments` query in `convex/customers.ts`** (AC: 4, supports Story 2.5)
  - [ ] First line: `await requireRole(ctx, ["office_staff", "admin"]);`.
  - [ ] Args: `{ customerId, attachmentType: v.optional(<union>) }`.
  - [ ] Use the `by_customer` or `by_customer_type` index (depending on whether `attachmentType` is provided).
  - [ ] **Return metadata only — NOT URLs.** URLs come from `getAttachmentUrl` per-attachment, which is the access-logging boundary. Returning a URL here would log a view that didn't actually happen, AND would create a public-by-listing pattern. Comment this decision in the query JSDoc.
  - [ ] Return `attachments.map(a => ({ attachmentId: a._id, attachmentType, fileName, mimeType, sizeBytes, uploadedAt }))`.

- [ ] **Task 7: Implement `internal.customers._loadCustomerForAttachment`** (AC: 2)
  - [ ] `internalQuery` — no RBAC check (called only from the `generateUploadUrl` action which has already verified RBAC).
  - [ ] Loads the customer; returns `{ hasConsent, fullName }` only (NOT the full doc — actions shouldn't see PII fields just to check consent).
  - [ ] Document the function as "called only by `generateUploadUrl`; never expose to clients."

### Frontend (AC5)

- [ ] **Task 8: Build `src/components/CustomerForm/AttachmentUploadField.tsx`** (AC: 5)
  - [ ] Props: `customerId: Id<"customers">`, `attachmentType: AttachmentType`, `accept?: string` (default `"image/jpeg,image/png,image/webp,application/pdf"`), `onUploaded?: (attachmentId) => void`.
  - [ ] State: `selectedFile: File | null`, `uploadState: "idle" | "validating" | "uploading" | "recording" | "success" | "error"`, `errorMessage: string | null`, `progress: number` (0-100).
  - [ ] Layout: drop zone (drag-and-drop styling via Tailwind `border-dashed`) + a file-picker `<input type="file" accept={accept}>` for keyboard-accessible alt path. Drop zone is `min-h-[100px]` and has visible focus ring (NFR-A4 + NFR-A1).
  - [ ] On file select / drop: validate size + mime client-side (don't wait for server). If invalid → set `errorMessage` + return. If valid: transition to `"uploading"`.
  - [ ] Upload flow:
    1. `const { uploadUrl } = await uploadAction({ customerId, attachmentType, expectedSizeBytes: file.size, expectedMimeType: file.type });`
    2. `const result = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.type }, body: file });` (use `XMLHttpRequest` instead if progress is needed; `fetch` doesn't expose upload progress natively. Acceptable in Phase 1 to skip progress and just show an indeterminate spinner.)
    3. `const { storageId } = await result.json();`
    4. `const { attachmentId } = await recordAttachmentMutation({ customerId, storageId, attachmentType, fileName: file.name, mimeType: file.type, sizeBytes: file.size });`
    5. Call `onUploaded?.(attachmentId)`.
  - [ ] Error handling: each step is in a try/catch; failures route through `src/lib/errors.ts:translateError` (Story 1.2 / 1.4 helper — if not yet built, use a minimal local translate function in this story; flag for cleanup when the central layer ships). Distinguish `CONSENT_REQUIRED` (special message with action link to "Update consent on the customer record") from other errors.
  - [ ] On `CONSENT_REQUIRED`: render the special action: "Customer consent is required. [Update consent on the customer record]" — link goes to `/customers/<customerId>` (Story 2.5 page). Until Story 2.5 ships, the link target may 404; OK for Phase 1 dev. Don't block on Story 2.5 cross-dependency.

- [ ] **Task 9: Wire the field into a thin demo page** (AC: 5)
  - [ ] Create `src/app/(staff)/customers/[customerId]/upload/page.tsx` as a temporary surface to exercise `AttachmentUploadField` until Story 2.5 (customer detail) integrates it properly.
  - [ ] This page is **deletable once Story 2.5 lands** — flag with a comment block: "TODO(Story 2.5): remove this page; the upload field belongs on the customer detail page." Sprint plan will track the cleanup.
  - [ ] Renders a customer name (from a separate query that returns only `{ fullName }` — non-PII) + the `AttachmentUploadField` for `attachmentType: "gov_id_scan"`. Cancel link back to `/dashboard`.

### Testing (AC2, AC3, AC4, AC6)

- [ ] **Task 10: Unit tests for `generateUploadUrl` action** (AC: 2)
  - [ ] Extend `tests/unit/convex/customers.test.ts`. Cases:
    - **Happy path:** office_staff + customer with `hasConsent: true` + `gov_id_scan` + 5MB file + `image/jpeg` → returns `{ uploadUrl, expiresAt }`.
    - **Consent gate:** customer with `hasConsent: false` + `gov_id_scan` → `CONSENT_REQUIRED`.
    - **Consent NOT required for other types:** `hasConsent: false` + `transfer_affidavit` → succeeds. (Only `gov_id_scan` is consent-gated. Transfer affidavits are notarized public-ish documents; death certificates / court orders are externally verified. Document this decision in the action's JSDoc.)
    - **Size limit:** `expectedSizeBytes = 11 * 1024 * 1024` → `FILE_TOO_LARGE`.
    - **Mime allowlist:** `image/gif` → `UNSUPPORTED_FILE_TYPE`. `application/pdf` → succeeds.
    - **NFR-S4 RBAC:** unauth → `UNAUTHENTICATED`; field_worker → `FORBIDDEN`.

- [ ] **Task 11: Unit tests for `recordAttachment` mutation** (AC: 3)
  - [ ] Cases:
    - **Happy path:** valid args + matching storage metadata → row inserted + audit emitted with `storageId: "[storage-id-redacted]"`.
    - **Consent revoked race:** action passed but `hasConsent` flipped to `false` before mutation → mutation refuses, cleans up the orphan blob via `ctx.storage.delete`.
    - **Size mismatch:** declared 5MB but `ctx.db.system.get(storageId)` reports 11MB → throws + deletes blob.
    - **Mime mismatch:** declared `image/png` but actual `application/javascript` → throws + deletes blob.
  - [ ] Coverage target: ≥ 90% on `convex/customers.ts` (PII-adjacent code).

- [ ] **Task 12: Unit tests for `getAttachmentUrl` + `piiAccessLog` write** (AC: 4)
  - [ ] Cases:
    - **Happy path:** office_staff gets URL; `piiAccessLog` row appears with `accessType: "file_view"` and the correct `customerId`, `fields: ["customerAttachment.url"]`.
    - **NFR-S4:** field_worker → `FORBIDDEN`; access log row NOT created.
    - **Not found:** invalid `attachmentId` → `ATTACHMENT_NOT_FOUND`; access log row NOT created.

- [ ] **Task 13: E2E spec — full upload flow** (AC: 5)
  - [ ] `tests/e2e/customer-attachment-upload.spec.ts`: log in as office_staff, create a customer with consent (via API directly to skip the UI in this spec), navigate to `/customers/<id>/upload`, select a small JPG fixture from `tests/fixtures/`, submit, assert "success" indicator appears, query the DB via the convex-test harness to confirm the `customerAttachments` row exists.

- [ ] **Task 14: E2E spec — unauthorized fetch returns 403** (AC: 6)
  - [ ] `tests/e2e/customer-attachment-auth.spec.ts`: log in as office_staff, upload a file, capture the signed URL from the response; in a new browser context (no cookies), fetch the URL → assert `status === 403` (or `401`, whichever Convex returns — verify against current docs).
  - [ ] Same test with a field_worker session: should also fail.
  - [ ] Same URL after `expiresAt + 5s` wait: should fail (URL expired).

### Documentation (AC1, AC3)

- [ ] **Task 15: JSDoc + commit-time TODOs** (AC: 1, AC: 4)
  - [ ] File-level JSDoc on `convex/customers.ts`: document the upload flow (action → POST → mutation → query for URL), the consent gate, the size + mime gates, the audit/PII log boundaries.
  - [ ] Inline TODO comments tagged `TODO(Story 2.3)` where direct `piiAccessLog.insert` happens — Story 2.3 grep-finds these for refactoring.
  - [ ] **No new ADR.** Architecture § 290 already commits the auth-gated signed-URL pattern; no new decision to record. (ADR-0007 in Story 2.8 covers the encryption-at-rest decision separately.)

## Dev Notes

### Previous story intelligence

**Stories that must be implemented before this one:**

- **Story 1.1:** scaffold, `(staff)/` group, layout.
- **Story 1.2:** `requireRole` (used 4× in this story), `ErrorCode` constants (extended here), ESLint `require-role-first-line` rule (will catch missing checks).
- **Story 1.6 (audit helper):** `emitAudit(ctx, {...})` — this story emits one audit event for every upload. The Story 1.6 helper already redacts known PII fields; storage IDs aren't PII per se but they ARE access tokens, so this story replaces `storageId` with a sentinel string in the audit `after` payload (different concern from PII redaction; document inline).
- **Story 2.1 (customer creation):** the `customers` table, the `hasConsent` field. This story's upload gate reads `customer.hasConsent`. If 2.1 hasn't shipped, this story has nothing to attach to.

**Stories that build on this one:**

- **Story 2.3 (PII access logging):** refactors the direct `piiAccessLog.insert` in `getAttachmentUrl` to route through a new `readPii` helper, and adds an ESLint rule that bans direct `piiAccessLog` inserts elsewhere. Grep for `TODO(Story 2.3)` to find the cleanup spots this story leaves.
- **Story 2.4 (data-subject report):** lists attachments + access-log entries for a customer; uses `listAttachments` from this story.
- **Story 2.5 (customer detail page):** integrates `AttachmentUploadField` into the customer detail page; can delete `/customers/[customerId]/upload/page.tsx`.
- **Story 2.7 (ownership transfer):** uses `AttachmentUploadField` with `attachmentType: "transfer_affidavit" | "court_order" | "death_certificate"`. The component generalizes via the `attachmentType` prop.
- **Story 1.14 (lot condition photo) — already exists in Epic 1:** uses a parallel pattern (`lotConditionLogs` + Convex File Storage). This story locks the convention for both.

### Architecture compliance

**Pattern locked by architecture:**

- **File-storage access** (architecture § 290): "Convex File Storage with auth-gated URL generation per request. Generate short-lived signed URLs in queries that check role; never expose direct storage URLs." This story is the canonical implementation.
- **Action vs mutation** (Convex idiom): `generateUploadUrl` must be an action because `ctx.storage.generateUploadUrl()` is action-only. `recordAttachment` is a mutation. The flow is: client calls action → action returns upload URL → client uploads → client calls mutation with the resulting `storageId`. Architecture § 354 notes the action / mutation split.
- **Audit boundary** (architecture § 869): `emitAudit` only writes to `auditLog`. Even when `customerAttachment` has its own access log (`piiAccessLog`), the *creation* audit goes through `emitAudit` like every other entity creation.
- **PII boundary** (architecture § 525–528, § 868): the URL itself is treated as PII-revealing (it points to scan data). `getAttachmentUrl` is the access-logging seam. Story 2.3 makes this a hard ESLint rule.
- **MIME allowlist:** `image/jpeg | image/png | image/webp | application/pdf` matches reasonable real-world cases (phone photos of IDs, PDFs of affidavits). `image/heic` is conspicuously absent — iPhone-native photos require conversion. Document in the form UX: "If your iPhone photo doesn't upload, share it from the Photos app to convert to JPG first."

### Library / framework versions (researched current)

- **No new dependencies.** Convex's built-in storage API + native `fetch` for uploads. We could add `react-dropzone` for nicer DnD UX but architecture's "no extra dep unless justified" stance + Tailwind's drag styling makes the hand-roll preferable. ~30 lines of code.
- **shadcn primitives needed:** `Progress` (for upload indicator), `Alert` (for consent / error messages). Add via `npx shadcn@latest add progress alert` if not already installed from Story 2.1.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                        # UPDATE (add customerAttachments + piiAccessLog tables)
│   ├── customers.ts                                     # UPDATE (add generateUploadUrl, recordAttachment, getAttachmentUrl, listAttachments, _loadCustomerForAttachment)
│   └── lib/
│       └── errors.ts                                    # UPDATE (CONSENT_REQUIRED, FILE_TOO_LARGE, UNSUPPORTED_FILE_TYPE, ATTACHMENT_NOT_FOUND + ErrorMessages map)
├── src/
│   ├── app/(staff)/customers/[customerId]/
│   │   └── upload/page.tsx                              # NEW (temporary; deleted when Story 2.5 lands)
│   ├── components/CustomerForm/
│   │   └── AttachmentUploadField.tsx                    # NEW (reusable upload component)
│   └── lib/
│       └── errors.ts                                    # UPDATE if not yet built — minimal translate layer for the new error codes
├── tests/
│   ├── unit/convex/
│   │   └── customers.test.ts                            # UPDATE (add upload-flow test cases)
│   ├── e2e/
│   │   ├── customer-attachment-upload.spec.ts           # NEW
│   │   └── customer-attachment-auth.spec.ts             # NEW (NFR-S3 / 403 confirmation)
│   └── fixtures/
│       ├── sample-id.jpg                                # NEW (5–8KB test fixture)
│       └── sample-affidavit.pdf                         # NEW (small PDF)
└── package.json                                         # UPDATE only if shadcn primitives added; no new npm deps
```

### Testing requirements

- **Coverage target on `convex/customers.ts`:** ≥ 90% (NFR-M2 PII-adjacent threshold).
- **E2E coverage:** the unauthorized-fetch spec is non-optional. NFR-S3 is explicit ("No public-by-default file URLs.") — we test the negative case to confirm.
- **Fixture file sizes:** keep test fixtures < 10KB so the test suite stays fast. Real scans run 1–5MB; we don't need to test that size to verify the logic.
- **`convex-test` storage stubbing:** verify the harness supports `ctx.storage.generateUploadUrl()` and `ctx.storage.getUrl()` mocks. If not, write a small adapter in `tests/unit/convex/_storageStub.ts`. The Convex test docs cover this pattern.

### Source references

- **PRD:** [§ FR15 (upload identification documents)](../../_bmad-output/planning-artifacts/prd.md#functional-requirements), [§ NFR-S3 (auth-gated file URLs, no public default)](../../_bmad-output/planning-artifacts/prd.md#security--privacy), [§ NFR-S8 (PII access log)](../../_bmad-output/planning-artifacts/prd.md#security--privacy), [§ NFR-C5 (consent gates ID retention)](../../_bmad-output/planning-artifacts/prd.md#compliance--legal)
- **Architecture:** [§ Authentication & Security > File-storage access](../../_bmad-output/planning-artifacts/architecture.md#authentication--security), [§ PII access logging](../../_bmad-output/planning-artifacts/architecture.md#authentication--security), [§ Boundary Discipline > PII read boundary](../../_bmad-output/planning-artifacts/architecture.md#boundary-discipline)
- **UX:** [§ PII Handling UI Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#pii-handling-ui-patterns) (ID-scan thumbnails, alt-text patterns), [§ Pattern Library > CustomerForm](../../_bmad-output/planning-artifacts/ux-design-specification.md#pattern-library) (the upload field is the file-upload primitive embedded inside)
- **Epics:** [§ Story 2.2](../../_bmad-output/planning-artifacts/epics.md#story-22-office-staff-uploads-identification-documents)
- **Previous stories:** [1.1](./1-1-admin-logs-into-the-system.md), [1.2](./1-2-server-enforces-role-based-access-on-every-endpoint.md), Story 1.6 (audit), Story 2.1 (customer creation)
- Convex docs: [File Storage](https://docs.convex.dev/file-storage) · [Storage URLs](https://docs.convex.dev/file-storage/serve-files) · [Actions](https://docs.convex.dev/functions/actions)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT return signed URLs from `listAttachments`.** Listing attachments shouldn't burn through access-log entries; URLs come from the per-attachment `getAttachmentUrl` query only. Architecture-mandated boundary.
- ❌ **Do NOT skip the storage metadata re-check in `recordAttachment`.** A malicious client can lie about the file's size or mime. Convex's `ctx.db.system.get(storageId)` returns the actual metadata; verify it.
- ❌ **Do NOT forget to delete the orphan blob** when `recordAttachment` rejects an upload. Otherwise blob storage accumulates garbage.
- ❌ **Do NOT use Convex's `ctx.storage.generateUploadUrl()` from a mutation** — it doesn't exist there. Actions only. If you see "Property 'generateUploadUrl' does not exist on type 'StorageReader'", you're in a query / mutation context.
- ❌ **Do NOT cache the upload URL on the client.** Convex's upload URLs expire fast (~minutes). One URL per file upload.
- ❌ **Do NOT add a `customer.govIdScans: v.array(v.id("_storage"))` array on the customer doc.** Attachments are a separate table because (a) we want to query them with filters (by type, by date), (b) one customer can have many scans + non-scan attachments, (c) a future occupant-attachment table (death certificates) follows the same pattern.
- ❌ **Do NOT log the raw `storageId` in `emitAudit`.** It's a backdoor to the file. The sentinel string `"[storage-id-redacted]"` keeps the audit log searchable without leaking access tokens.
- ❌ **Do NOT make the consent gate client-only.** AC4's server-side re-check in `recordAttachment` exists because consent could be revoked between `generateUploadUrl` and the mutation. Client-only would be NFR-S4 violation (UI-only authorization is a non-compliance defect).
- ❌ **Do NOT skip the unauthorized-fetch E2E spec (AC6).** It's the only test that proves NFR-S3 — and if the spec accidentally passes against a public URL pattern, we'd never know.
- ❌ **Do NOT use HEIC support.** Convex / native browser converters don't reliably support it; complicates the verifier. iPhone users share-to-JPG manually.

### Common LLM-developer mistakes to prevent

- **Reinventing wheels:** Use `ctx.storage.generateUploadUrl()` / `getUrl()` / `delete()` — don't write a presigned-URL generator. Convex has the primitive.
- **Wrong context for storage API:** `generateUploadUrl` is action-only. Re-read the Convex docs if confused. Mutations can only read storage metadata, not generate upload URLs.
- **Wrong file location for `AttachmentUploadField`:** lives under `src/components/CustomerForm/` because it's customer-domain and intended for inline-embedding inside the form composite. Story 2.7's transfer flow imports it from the same path.
- **Race-condition blindness:** the consent gate exists in BOTH `generateUploadUrl` AND `recordAttachment` — that's not redundancy, it's defense against a 5-second window where consent could be revoked. Don't "DRY this up" by removing one.
- **Wrong test fixture sizes:** if the fixture is 8MB, every test run pays for it. Keep fixtures small; the size logic is tested with declared sizes, not with actual gigantic files.
- **Forgetting the `_loadCustomerForAttachment` internal query:** Convex actions can't directly access `ctx.db`; they must call queries/mutations. The internal query is the bridge. Don't try to read `ctx.db.get(customerId)` directly inside the action.
- **CSRF / Content-Type:** when POSTing to the upload URL, the `Content-Type` must match the file's actual MIME (`file.type`). Wrong `Content-Type` may cause Convex to reject the upload or store wrong metadata.

### Open questions / blockers this story does NOT resolve

- **§10 Q4 (Legacy data condition):** Legacy customers may not have consent recorded. For Phase 1 migration: upload UI surfaces the "consent required" gate; staff records consent via the customer detail page (Story 2.5) when the customer next visits. No blocker for this story.
- **§10 Q6 (Ownership transfer policy):** Story 2.7 will define which `attachmentType` values are required for which transfer types. This story's `attachmentType` union covers the expected values; if Q6 reveals additional document categories, extend the union in 2.7.

### Project Structure Notes

Aligns with architecture's directory structure. The temporary `/customers/[customerId]/upload/page.tsx` route is the only structural anomaly; flagged for removal in Story 2.5.

### References

- [PRD § FR15, NFR-S3, NFR-S8, NFR-C5](../../_bmad-output/planning-artifacts/prd.md#functional-requirements)
- [Architecture § Authentication & Security](../../_bmad-output/planning-artifacts/architecture.md#authentication--security)
- [Architecture § Boundary Discipline](../../_bmad-output/planning-artifacts/architecture.md#boundary-discipline)
- [UX § PII Handling UI Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#pii-handling-ui-patterns)
- [Epics § Story 2.2](../../_bmad-output/planning-artifacts/epics.md#story-22-office-staff-uploads-identification-documents)
- Previous stories: [1.1](./1-1-admin-logs-into-the-system.md), [1.2](./1-2-server-enforces-role-based-access-on-every-endpoint.md), Story 1.6 (audit), [Story 2.1](./2-1-office-staff-creates-a-customer-record.md)
- Convex docs: [File Storage](https://docs.convex.dev/file-storage) · [Upload files](https://docs.convex.dev/file-storage/upload-files) · [Serve files](https://docs.convex.dev/file-storage/serve-files) · [Storage metadata](https://docs.convex.dev/file-storage/file-metadata)

## Dev Agent Record

### Agent Model Used

_To be filled by dev agent_

### Debug Log References

_To be filled by dev agent_

### Completion Notes List

_To be filled by dev agent_

### File List

_To be filled by dev agent_
