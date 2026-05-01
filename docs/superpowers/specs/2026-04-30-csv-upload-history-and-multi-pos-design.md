# CSV Upload History + Multi-POS Support

**Date:** 2026-04-30
**Status:** Approved (pending implementation plan)
**Repos affected:** `your-guava-backend`, `your-guava-portal`

## Goal

Let coffee shops upload CSV/XLSX exports from any POS (not just Yoco), keep an auditable history of every upload, and let users review or re-import the original data. Predictions remain algorithmic; AI is used only to suggest column mappings for unknown POS formats.

## Non-goals

- Replacing the existing weighted-moving-average forecast algorithm (deferred — possible future work).
- Building hardcoded preset parsers for non-Yoco systems before we have real customer exports.
- File-versioning beyond "uploaded → re-mapped → deleted".

## Approach

CSV ingestion becomes a **two-phase flow**:

1. **Stage:** receive file → upload original to Cloudflare R2 → create an `Upload` record with `status: pending_mapping`. Try the Yoco preset detector. If unmatched, ask Claude Haiku to propose a column mapping from headers + first 5 rows.
2. **Ingest:** user reviews/confirms the mapping in a wizard → backend re-reads the file from R2, parses with the confirmed mapping, upserts transactions tagged with `uploadId`, marks Upload `completed`.

Original file persists in R2 indefinitely (cheap, ~free at this scale). Users can download it later from the upload detail page.

The Anthropic SDK is already wired up for forecast insights. Reusing the same client for a new `proposeColumnMapping` function adds zero infrastructure.

## Data model changes

### New `Upload` model
```
{
  cafeId: ObjectId (indexed),
  uploadedBy: ObjectId (ref User),
  fileName: string,
  fileSize: number,
  r2Key: string,
  posType: 'yoco' | 'wizard',
  columnMapping: {
    receiptId?: string,
    date: string,
    time?: string,
    items: string,
    total: string,
    tip?: string,
    discount?: string,
    paymentMethod?: string,
    status?: string
  },
  itemsMode: 'packed' | 'line-per-row',
  status: 'pending_mapping' | 'parsing' | 'completed' | 'failed' | 'deleted',
  stats: { imported: number, skipped: number, errors: number, totalRows: number },
  dateRange: { firstDate?: Date, lastDate?: Date },
  errorMessage?: string,
  createdAt: Date,
  completedAt?: Date
}
```
Index: `(cafeId, createdAt desc)` for the history list.

### Modified `Transaction` model
- Add `uploadId: ObjectId` (ref Upload, null for Yoco OAuth-sourced transactions).
- Add `dedupKey: string` (sparse unique index per cafe — only set when `receiptId` is absent).

### Modified `Cafe` model
- Add `savedColumnMapping: object` — last confirmed mapping. Used to skip the wizard on subsequent uploads of the same shape.

## API surface

### Modified
- `POST /api/transactions/upload` — Phase 1. Returns `{ uploadId, posType, columnMapping, preview, needsConfirmation }`.

### New (`/api/uploads`)
| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| POST | `/:id/confirm` | Phase 2: parse + create transactions | owner/manager |
| GET | `/` | Paginated list of uploads (cafe-scoped) | owner/manager |
| GET | `/:id` | Full record + signed download URL (15 min TTL) | owner/manager |
| GET | `/:id/rows` | Paginated transactions linked to this upload | owner/manager |
| PATCH | `/:id/mapping` | Re-parse with corrected mapping (atomic, rollback on failure) | owner/manager |
| DELETE | `/:id` | Soft-delete — Upload record kept with `status: deleted`; linked transactions and R2 object removed | **owner only** |

### New service: `r2.service.js`
Thin S3-compatible wrapper around `@aws-sdk/client-s3` pointed at Cloudflare R2.
Functions: `uploadFile(buffer, key)`, `getSignedDownloadUrl(key, ttl)`, `deleteFile(key)`, `streamFile(key)`.

### Anthropic addition
New function in `anthropic.service.js`: `proposeColumnMapping(headers, sampleRows) → ColumnMapping`. Cached in-memory by SHA1(headers) so identical column shapes never round-trip twice. Falls back to empty mapping if API key missing or response unparseable.

## Frontend

### `Connect.tsx` — three cards (was two)
1. Upload (existing, modified to open the wizard when `needsConfirmation: true`)
2. Yoco Live Integration (existing, unchanged)
3. **Upload history** (new) — table: filename, uploader, date, POS type, rows imported, status, actions

### New `ColumnMappingWizard` (modal)
- Header: detected POS type or "Unknown format — AI suggested mapping below"
- Two-column mapping UI: canonical fields ↔ user's CSV columns (dropdowns)
- Pre-filled with preset / AI suggestion
- Required-field validation (Date, Items, Total)
- Live preview of first 3 rows under chosen mapping
- "Items mode" toggle: each row is one transaction (multi-item packed) vs each row is one line item

### New `UploadDetail.tsx` page (`/uploads/:id`)
- Header: filename, status badge, upload time, uploader
- Stats: imported / skipped / errors / date range
- Tab 1: imported transactions (paginated)
- Tab 2: original file (download via signed URL)
- Footer: "Re-map columns" (reopens wizard) and "Delete upload" (owner only, with confirm dialog)

### New types in `src/types/`
`Upload`, `ColumnMapping`, `UploadStatus`, `ItemsMode`.

## Error handling and edge cases

**Required canonical fields:** `date`, `items`, `total`. Wizard blocks confirm if unmapped. Optional: `receiptId`, `time`, `tip`, `discount`, `paymentMethod`, `status`.

**Dedup:**
- With `receiptId`: upsert by `(cafeId, receiptId)` — preserves Yoco compatibility.
- Without `receiptId`: synthetic `dedupKey = SHA1(date|time|total|itemsJoined)`. Upsert by `(cafeId, dedupKey)`.
- Re-uploading the same file is idempotent in both modes.

**Items modes:**
- `packed`: one row per receipt, items in one cell as `"1 x Flat White,2 x Brownie"` (Yoco style).
- `line-per-row`: one row per line item; rows grouped by `receiptId` or by `(date, time, total)` synthetic key.

**File validation at staging:**
- Max size 10 MB (env-configurable).
- Reject empty files, files with no headers, single-column files.
- Sniff first bytes to verify CSV/XLSX content beyond extension check.

**R2 failure modes:**
- R2 upload fails → 503, no Upload record created, frontend retries.
- Confirm phase, R2 object missing → mark Upload `failed`, surface `errorMessage`.

**AI mapping failures:**
- Invalid JSON from Claude → wizard opens in manual mode with empty mapping.
- API key missing or API down → same fallback. Wizard always works without AI.

**Race conditions:**
- Multiple concurrent uploads per cafe allowed (independent uploadIds).
- Confirming an already-`completed` upload returns 409.
- `PATCH /mapping` while status is `parsing` returns 409.

**Permissions:**
- Upload, list, view, view rows: owner + manager.
- Delete: owner only (existing `requireRole('owner')` middleware).

**Existing file deletion removed:** `transactions.controller.js:18` no longer `fs.unlinkSync`'s the parsed file. R2 holds the original; multer's local temp file is cleaned after R2 upload succeeds.

## Testing

### Backend integration (`tests/integration/uploads.test.js`)
- Yoco preset detection — no AI call needed.
- Non-Yoco file — AI proposer (mocked) returns mapping.
- Confirm — happy path; transactions created with `uploadId`.
- Confirm — invalid mapping (missing required) → 400.
- Confirm — already completed → 409.
- List — cross-tenant isolation (cafe A cannot see cafe B's uploads).
- Detail — signed URL returned.
- PATCH mapping — atomic re-parse; rollback on failure.
- DELETE — owner-only (manager → 403); cascades to transactions + R2.
- Dedup with receiptId — idempotent re-upload.
- Dedup without receiptId — synthetic SHA1 key dedupes.

### Backend unit (`tests/unit/`)
- Generic-mapping parser: both `packed` and `line-per-row` modes against synthetic CSV strings.
- Dedup-key util: deterministic for identical inputs.

### Frontend (Vitest + RTL)
- `Connect.test.tsx` — wizard opens on `needsConfirmation: true`.
- `ColumnMappingWizard.test.tsx` — required-field gating; preview updates with mapping changes.
- `UploadDetail.test.tsx` — tabs, download CTA, delete confirm flow.

### Mocked at boundaries
- `r2.service.js` writes to local temp dir during tests.
- `anthropic.service.proposeColumnMapping` returns canned JSON.
- Real R2 / Anthropic never called from tests.

## Environment variables (new)

```
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET_NAME
R2_PUBLIC_URL_BASE      # optional, for non-signed access if ever needed
UPLOAD_MAX_BYTES        # default 10485760 (10 MB)
```

`ANTHROPIC_API_KEY` already exists.

## Open items deferred to future specs

- Hardcoded preset parsers for iKhokha, Square, Loyverse — added reactively as customers arrive with real exports.
- Replacing the algorithmic forecast with an AI/ML model (the "C" path).
- Bulk delete / bulk re-map on the upload history page.
- Email notification when a long-running re-parse completes.
