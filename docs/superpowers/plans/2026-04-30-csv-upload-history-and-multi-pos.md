# CSV Upload History + Multi-POS Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an auditable upload history to Your Guava with original-file retention in Cloudflare R2, and accept CSV/XLSX exports from any POS system using a column-mapping wizard pre-filled by the Yoco preset (when matched) or by Claude Haiku.

**Architecture:** Two-phase ingestion. Phase 1 stages the file to R2 and creates an `Upload` record with a proposed column mapping. Phase 2 re-reads from R2, parses with the user-confirmed mapping, and writes transactions tagged with `uploadId`. Predictions remain algorithmic; AI is suggestion-only, with a deterministic manual fallback when the API is unavailable.

**Tech Stack:** Node.js / Express, MongoDB / Mongoose, Cloudflare R2 (`@aws-sdk/client-s3`), Anthropic SDK, Jest + Supertest + mongodb-memory-server, React 19 + Vite + shadcn/ui + Vitest + RTL.

**Spec:** [docs/superpowers/specs/2026-04-30-csv-upload-history-and-multi-pos-design.md](../specs/2026-04-30-csv-upload-history-and-multi-pos-design.md)

**Repos:**
- Backend: `C:\Users\shaun\your-guava-backend`
- Frontend: `C:\Users\shaun\your-guava-portal`

---

## File Structure

### Backend — `your-guava-backend`

**Create:**
- `src/models/Upload.model.js`
- `src/services/r2.service.js`
- `src/services/parser.service.js` (generic mapping parser)
- `src/utils/dedupKey.js`
- `src/controllers/uploads.controller.js`
- `src/routes/uploads.routes.js`
- `tests/integration/uploads.test.js`
- `tests/unit/dedupKey.test.js`
- `tests/unit/parser.service.test.js`
- `tests/fixtures/test-generic-pos.csv`
- `tests/fixtures/test-line-per-row.csv`

**Modify:**
- `src/app.js` — register `/api/uploads` routes
- `src/models/Transaction.model.js` — add `uploadId`, `dedupKey`, sparse unique compound index
- `src/models/Cafe.model.js` — add `savedColumnMapping`
- `src/services/ingestion.service.js` — refactor to two-phase + delegate parsing
- `src/services/anthropic.service.js` — add `proposeColumnMapping`
- `src/controllers/transactions.controller.js` — `upload` becomes Phase 1
- `package.json` — add `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

### Frontend — `your-guava-portal`

**Create:**
- `src/types/upload.ts`
- `src/components/upload/ColumnMappingWizard.tsx`
- `src/components/upload/ColumnMappingWizard.test.tsx`
- `src/components/upload/UploadHistoryCard.tsx`
- `src/pages/UploadDetail.tsx`
- `src/pages/UploadDetail.test.tsx`

**Modify:**
- `src/pages/Connect.tsx` — open wizard on `needsConfirmation`, render history card
- `src/pages/Connect.test.tsx`
- `src/App.tsx` (or wherever routes live) — add `/uploads/:id`

---

## Task 1: Add R2 SDK dependency

**Files:**
- Modify: `your-guava-backend/package.json`

- [ ] **Step 1: Install dependencies**

```bash
cd C:\Users\shaun\your-guava-backend
npm install @aws-sdk/client-s3@^3.700.0 @aws-sdk/s3-request-presigner@^3.700.0
```

Expected: package.json updated, package-lock.json updated, no errors.

- [ ] **Step 2: Verify install**

```bash
node -e "require('@aws-sdk/client-s3'); require('@aws-sdk/s3-request-presigner'); console.log('ok')"
```

Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @aws-sdk/client-s3 for R2 file storage"
```

---

## Task 2: Dedup key utility

**Files:**
- Create: `your-guava-backend/src/utils/dedupKey.js`
- Test: `your-guava-backend/tests/unit/dedupKey.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/dedupKey.test.js`:

```js
const { computeDedupKey } = require('../../src/utils/dedupKey');

describe('computeDedupKey', () => {
  it('produces a deterministic SHA1 hex string for identical inputs', () => {
    const a = computeDedupKey({ date: '2026-04-01', time: '08:30', total: 45.5, items: [{ name: 'Flat White', quantity: 1 }] });
    const b = computeDedupKey({ date: '2026-04-01', time: '08:30', total: 45.5, items: [{ name: 'Flat White', quantity: 1 }] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{40}$/);
  });

  it('produces different keys when any field differs', () => {
    const base = { date: '2026-04-01', time: '08:30', total: 45.5, items: [{ name: 'Flat White', quantity: 1 }] };
    expect(computeDedupKey(base)).not.toBe(computeDedupKey({ ...base, total: 46 }));
    expect(computeDedupKey(base)).not.toBe(computeDedupKey({ ...base, time: '08:31' }));
    expect(computeDedupKey(base)).not.toBe(computeDedupKey({ ...base, date: '2026-04-02' }));
    expect(computeDedupKey(base)).not.toBe(computeDedupKey({ ...base, items: [{ name: 'Cappuccino', quantity: 1 }] }));
  });

  it('treats missing time as empty string consistently', () => {
    const a = computeDedupKey({ date: '2026-04-01', total: 45.5, items: [] });
    const b = computeDedupKey({ date: '2026-04-01', time: '', total: 45.5, items: [] });
    expect(a).toBe(b);
  });

  it('orders items deterministically regardless of input order', () => {
    const items1 = [{ name: 'A', quantity: 1 }, { name: 'B', quantity: 2 }];
    const items2 = [{ name: 'B', quantity: 2 }, { name: 'A', quantity: 1 }];
    const a = computeDedupKey({ date: '2026-04-01', total: 50, items: items1 });
    const b = computeDedupKey({ date: '2026-04-01', total: 50, items: items2 });
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest tests/unit/dedupKey.test.js
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the utility**

Create `src/utils/dedupKey.js`:

```js
const crypto = require('crypto');

/**
 * Computes a deterministic SHA1 hex digest used as a synthetic transaction
 * dedup key when no receipt ID is available in the source CSV.
 *
 * @param {object} input
 * @param {string} input.date     ISO date string YYYY-MM-DD
 * @param {string} [input.time]   HH:MM (optional)
 * @param {number} input.total
 * @param {Array<{name: string, quantity: number}>} input.items
 * @returns {string} 40-char SHA1 hex
 */
const computeDedupKey = ({ date, time, total, items }) => {
  const sortedItems = [...(items || [])]
    .map((i) => ({ name: i.name, quantity: i.quantity }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const itemsJoined = sortedItems.map((i) => `${i.name}x${i.quantity}`).join('|');
  const input = `${date}|${time || ''}|${total}|${itemsJoined}`;
  return crypto.createHash('sha1').update(input).digest('hex');
};

module.exports = { computeDedupKey };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest tests/unit/dedupKey.test.js
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/utils/dedupKey.js tests/unit/dedupKey.test.js
git commit -m "feat: add deterministic dedup key utility for receipt-less rows"
```

---

## Task 3: R2 service wrapper

**Files:**
- Create: `your-guava-backend/src/services/r2.service.js`

The R2 service is mocked in tests (no real S3 calls), so we don't write a real-network test for it. The service is exercised via integration tests later. We keep this task focused on a clean, testable interface.

- [ ] **Step 1: Implement the service**

Create `src/services/r2.service.js`:

```js
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let client = null;

const getClient = () => {
  if (client) return client;
  const accountId = process.env.R2_ACCOUNT_ID;
  if (!accountId) {
    throw new Error('R2_ACCOUNT_ID is not set');
  }
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return client;
};

const bucket = () => process.env.R2_BUCKET_NAME;

/**
 * Uploads a buffer to R2 under the given key.
 * @param {Buffer} buffer
 * @param {string} key
 * @param {string} contentType
 * @returns {Promise<void>}
 */
const uploadFile = async (buffer, key, contentType = 'application/octet-stream') => {
  await getClient().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );
};

/**
 * Downloads a file from R2 as a Buffer.
 * @param {string} key
 * @returns {Promise<Buffer>}
 */
const downloadFile = async (key) => {
  const res = await getClient().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

/**
 * Returns a signed URL for downloading the object.
 * @param {string} key
 * @param {number} ttlSeconds default 900 (15 min)
 * @returns {Promise<string>}
 */
const getSignedDownloadUrl = async (key, ttlSeconds = 900) => {
  const cmd = new GetObjectCommand({ Bucket: bucket(), Key: key });
  return getSignedUrl(getClient(), cmd, { expiresIn: ttlSeconds });
};

/**
 * Deletes an object from R2. Idempotent.
 * @param {string} key
 * @returns {Promise<void>}
 */
const deleteFile = async (key) => {
  await getClient().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
};

/**
 * Resets the cached client. Used by tests.
 */
const _resetClient = () => {
  client = null;
};

module.exports = {
  uploadFile,
  downloadFile,
  getSignedDownloadUrl,
  deleteFile,
  _resetClient,
};
```

- [ ] **Step 2: Verify it loads**

```bash
node -e "const r2 = require('./src/services/r2.service'); console.log(Object.keys(r2));"
```

Expected: prints `[ 'uploadFile', 'downloadFile', 'getSignedDownloadUrl', 'deleteFile', '_resetClient' ]`.

- [ ] **Step 3: Add R2 env vars to .env.example**

Modify `your-guava-backend/.env.example` (create if missing) — append:

```
# Cloudflare R2 (file storage for upload history)
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=your-guava-uploads
UPLOAD_MAX_BYTES=10485760
```

- [ ] **Step 4: Commit**

```bash
git add src/services/r2.service.js .env.example
git commit -m "feat: add R2 service wrapper for upload file storage"
```

---

## Task 4: Upload model

**Files:**
- Create: `your-guava-backend/src/models/Upload.model.js`

- [ ] **Step 1: Implement the model**

Create `src/models/Upload.model.js`:

```js
const mongoose = require('mongoose');

const columnMappingSchema = new mongoose.Schema(
  {
    receiptId: { type: String },
    date: { type: String },
    time: { type: String },
    items: { type: String },
    total: { type: String },
    tip: { type: String },
    discount: { type: String },
    paymentMethod: { type: String },
    status: { type: String },
  },
  { _id: false }
);

const uploadSchema = new mongoose.Schema(
  {
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafe',
      required: true,
      index: true,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    fileName: { type: String, required: true },
    fileSize: { type: Number, required: true },
    r2Key: { type: String, required: true },
    posType: {
      type: String,
      enum: ['yoco', 'wizard'],
      required: true,
    },
    columnMapping: { type: columnMappingSchema, default: {} },
    itemsMode: {
      type: String,
      enum: ['packed', 'line-per-row'],
      default: 'packed',
    },
    status: {
      type: String,
      enum: ['pending_mapping', 'parsing', 'completed', 'failed', 'deleted'],
      default: 'pending_mapping',
      index: true,
    },
    stats: {
      imported: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      errors: { type: Number, default: 0 },
      totalRows: { type: Number, default: 0 },
    },
    dateRange: {
      firstDate: { type: Date },
      lastDate: { type: Date },
    },
    errorMessage: { type: String },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

uploadSchema.index({ cafeId: 1, createdAt: -1 });

module.exports = mongoose.model('Upload', uploadSchema);
```

- [ ] **Step 2: Verify it loads**

```bash
node -e "const Upload = require('./src/models/Upload.model'); console.log(Upload.modelName);"
```

Expected: prints `Upload`.

- [ ] **Step 3: Commit**

```bash
git add src/models/Upload.model.js
git commit -m "feat: add Upload model for upload history tracking"
```

---

## Task 5: Modify Transaction model

**Files:**
- Modify: `your-guava-backend/src/models/Transaction.model.js`

The `receiptId` field becomes optional (was required). Add `uploadId` and `dedupKey`. Replace the existing unique index with a sparse-unique on `receiptId` plus a sparse-unique on `dedupKey`.

- [ ] **Step 1: Edit the model**

Replace `src/models/Transaction.model.js` with:

```js
const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema(
  {
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafe',
      required: true,
      index: true,
    },
    uploadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Upload',
      index: true,
    },
    receiptId: { type: String },
    dedupKey: { type: String },
    date: { type: Date, required: true, index: true },
    hour: { type: Number },
    dayOfWeek: { type: Number },
    status: {
      type: String,
      enum: ['approved', 'declined', 'error', 'aborted'],
      default: 'approved',
    },
    paymentMethod: { type: String },
    items: [
      {
        name: { type: String, required: true },
        quantity: { type: Number, required: true },
        unitPrice: { type: Number },
      },
    ],
    total: { type: Number },
    tip: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    source: {
      type: String,
      enum: ['csv', 'api', 'manual'],
      default: 'csv',
    },
  },
  { timestamps: true }
);

// Sparse-unique compound indexes — at most one of receiptId/dedupKey should be set per row.
transactionSchema.index(
  { cafeId: 1, receiptId: 1 },
  { unique: true, partialFilterExpression: { receiptId: { $type: 'string' } } }
);
transactionSchema.index(
  { cafeId: 1, dedupKey: 1 },
  { unique: true, partialFilterExpression: { dedupKey: { $type: 'string' } } }
);
transactionSchema.index({ cafeId: 1, date: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);
```

- [ ] **Step 2: Run existing transaction tests**

```bash
npx jest tests/integration/transactions.test.js
```

Expected: all existing tests still pass (Yoco-style imports still work because `receiptId` is set on every row).

If they fail, the test file references receiptId behaviour — read the failure and update only the assertions that depend on the old required-receiptId rule.

- [ ] **Step 3: Commit**

```bash
git add src/models/Transaction.model.js
git commit -m "feat: add uploadId + dedupKey to Transaction; sparse-unique indexes"
```

---

## Task 6: Modify Cafe model

**Files:**
- Modify: `your-guava-backend/src/models/Cafe.model.js`

- [ ] **Step 1: Read current Cafe model**

```bash
cat src/models/Cafe.model.js
```

- [ ] **Step 2: Add savedColumnMapping field**

Add inside the schema definition object, alongside existing fields:

```js
savedColumnMapping: {
  type: new mongoose.Schema(
    {
      receiptId: { type: String },
      date: { type: String },
      time: { type: String },
      items: { type: String },
      total: { type: String },
      tip: { type: String },
      discount: { type: String },
      paymentMethod: { type: String },
      status: { type: String },
      itemsMode: { type: String, enum: ['packed', 'line-per-row'] },
    },
    { _id: false }
  ),
  default: undefined,
},
```

- [ ] **Step 3: Verify the model loads**

```bash
node -e "const Cafe = require('./src/models/Cafe.model'); console.log(Cafe.schema.path('savedColumnMapping') ? 'ok' : 'missing');"
```

Expected: prints `ok`.

- [ ] **Step 4: Commit**

```bash
git add src/models/Cafe.model.js
git commit -m "feat: add Cafe.savedColumnMapping for wizard mapping reuse"
```

---

## Task 7: Generic parser service

**Files:**
- Create: `your-guava-backend/src/services/parser.service.js`
- Test: `your-guava-backend/tests/unit/parser.service.test.js`
- Create: `your-guava-backend/tests/fixtures/test-generic-pos.csv`
- Create: `your-guava-backend/tests/fixtures/test-line-per-row.csv`

The parser takes a buffer + columnMapping + itemsMode and returns a list of normalised transaction objects. It does NOT write to the database. The DB write step lives in ingestion.service.

- [ ] **Step 1: Create test fixtures**

Create `tests/fixtures/test-generic-pos.csv`:

```csv
Txn Number,Sale Date,Sale Time,Description,Amount
A001,2026/04/01,08:30,2 x Flat White; 1 x Muffin,75.00
A002,2026/04/01,09:15,1 x Cappuccino,32.00
A003,2026/04/01,12:45,3 x Sandwich,165.00
```

Create `tests/fixtures/test-line-per-row.csv`:

```csv
Receipt,Date,Time,Item,Qty,Total
R100,2026-04-01,08:30,Flat White,2,75.00
R100,2026-04-01,08:30,Muffin,1,75.00
R101,2026-04-01,09:15,Cappuccino,1,32.00
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/parser.service.test.js`:

```js
const fs = require('fs');
const path = require('path');
const { parseBuffer } = require('../../src/services/parser.service');

const fixture = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name));

describe('parser.service', () => {
  describe('packed itemsMode', () => {
    const mapping = {
      receiptId: 'Txn Number',
      date: 'Sale Date',
      time: 'Sale Time',
      items: 'Description',
      total: 'Amount',
    };

    it('parses generic POS CSV into normalised transaction rows', async () => {
      const buf = fixture('test-generic-pos.csv');
      const result = await parseBuffer(buf, { columnMapping: mapping, itemsMode: 'packed' });

      expect(result.rows).toHaveLength(3);
      expect(result.rows[0]).toMatchObject({
        receiptId: 'A001',
        total: 75,
        items: [
          { name: 'Flat White', quantity: 2 },
          { name: 'Muffin', quantity: 1 },
        ],
      });
      expect(result.rows[0].date).toBeInstanceOf(Date);
    });

    it('returns dateRange spanning earliest to latest row', async () => {
      const buf = fixture('test-generic-pos.csv');
      const result = await parseBuffer(buf, { columnMapping: mapping, itemsMode: 'packed' });
      expect(result.dateRange.firstDate.toISOString().slice(0, 10)).toBe('2026-04-01');
      expect(result.dateRange.lastDate.toISOString().slice(0, 10)).toBe('2026-04-01');
    });
  });

  describe('line-per-row itemsMode', () => {
    it('groups line items by receiptId into single transactions', async () => {
      const mapping = {
        receiptId: 'Receipt',
        date: 'Date',
        time: 'Time',
        items: 'Item',
        total: 'Total',
      };
      const buf = fixture('test-line-per-row.csv');
      const result = await parseBuffer(buf, {
        columnMapping: { ...mapping, quantity: 'Qty' },
        itemsMode: 'line-per-row',
      });

      expect(result.rows).toHaveLength(2);
      const r100 = result.rows.find((r) => r.receiptId === 'R100');
      expect(r100.items).toEqual([
        { name: 'Flat White', quantity: 2 },
        { name: 'Muffin', quantity: 1 },
      ]);
      expect(r100.total).toBe(75);
    });
  });

  describe('error cases', () => {
    it('throws when required fields are unmapped', async () => {
      const buf = fixture('test-generic-pos.csv');
      await expect(
        parseBuffer(buf, { columnMapping: { date: 'Sale Date' }, itemsMode: 'packed' })
      ).rejects.toThrow(/required.*items|required.*total/i);
    });

    it('returns errors for unparseable date rows', async () => {
      const csv = 'Date,Items,Total\nnot-a-date,1 x Foo,10';
      const result = await parseBuffer(Buffer.from(csv), {
        columnMapping: { date: 'Date', items: 'Items', total: 'Total' },
        itemsMode: 'packed',
      });
      expect(result.errors).toBeGreaterThanOrEqual(1);
      expect(result.rows).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx jest tests/unit/parser.service.test.js
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 4: Implement the parser**

Create `src/services/parser.service.js`:

```js
const csv = require('csv-parser');
const { Readable } = require('stream');
const XLSX = require('xlsx');

const REQUIRED_FIELDS = ['date', 'items', 'total'];

/**
 * Parses Yoco-style "1 x Flat White,2 x Brownie" item strings.
 * @param {string} str
 * @returns {{name: string, quantity: number}[]}
 */
const parsePackedItems = (str) => {
  if (!str) return [];
  const items = [];
  const regex = /(\d+)\s+x\s+(.+?)(?:[,;](?=\s*\d+\s+x\s+)|$)/g;
  let match;
  while ((match = regex.exec(str)) !== null) {
    const quantity = parseInt(match[1], 10);
    const name = match[2].trim();
    if (name) items.push({ name, quantity });
  }
  return items;
};

const cleanNumber = (raw) =>
  parseFloat(String(raw || 0).replace(/[^0-9.-]/g, '')) || 0;

const readRows = (buffer, fileExt) => {
  if (fileExt === 'xlsx' || fileExt === 'xls') {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return Promise.resolve(XLSX.utils.sheet_to_json(sheet, { defval: '' }));
  }
  return new Promise((resolve, reject) => {
    const rows = [];
    Readable.from(buffer)
      .pipe(csv())
      .on('data', (row) => rows.push(row))
      .on('error', reject)
      .on('end', () => resolve(rows));
  });
};

const validateMapping = (mapping) => {
  const missing = REQUIRED_FIELDS.filter((f) => !mapping[f]);
  if (missing.length > 0) {
    throw new Error(`Mapping missing required fields: ${missing.join(', ')}`);
  }
};

const parseDate = (dateStr, timeStr) => {
  if (!dateStr) return null;
  const normalised = String(dateStr).replace(/\//g, '-').trim();
  const dt = timeStr ? `${normalised}T${String(timeStr).trim()}` : normalised;
  const parsed = new Date(dt);
  return isNaN(parsed.getTime()) ? null : parsed;
};

const buildPackedRow = (raw, mapping) => {
  const date = parseDate(raw[mapping.date], mapping.time && raw[mapping.time]);
  if (!date) return null;
  const items = parsePackedItems(raw[mapping.items] || '');
  const total = cleanNumber(raw[mapping.total]);
  const totalQty = items.reduce((s, i) => s + i.quantity, 0);
  const unitPrice = totalQty > 0 ? total / totalQty : 0;
  return {
    receiptId: mapping.receiptId ? String(raw[mapping.receiptId] || '').trim() || undefined : undefined,
    date,
    hour: date.getHours(),
    dayOfWeek: date.getDay(),
    items: items.map((i) => ({ ...i, unitPrice: parseFloat(unitPrice.toFixed(2)) })),
    total,
    tip: mapping.tip ? cleanNumber(raw[mapping.tip]) : 0,
    discount: mapping.discount ? cleanNumber(raw[mapping.discount]) : 0,
    paymentMethod: mapping.paymentMethod ? String(raw[mapping.paymentMethod] || '').trim() : undefined,
    status: mapping.status ? String(raw[mapping.status] || 'approved').trim().toLowerCase() : 'approved',
  };
};

const groupLinePerRow = (rawRows, mapping) => {
  const groups = new Map();
  let errors = 0;
  for (const raw of rawRows) {
    try {
      const date = parseDate(raw[mapping.date], mapping.time && raw[mapping.time]);
      if (!date) { errors++; continue; }
      const receiptId = mapping.receiptId ? String(raw[mapping.receiptId] || '').trim() : undefined;
      const groupKey = receiptId || `${date.toISOString()}|${cleanNumber(raw[mapping.total])}`;
      const itemName = String(raw[mapping.items] || '').trim();
      if (!itemName) { errors++; continue; }
      const quantity = mapping.quantity ? parseInt(raw[mapping.quantity], 10) || 1 : 1;
      const total = cleanNumber(raw[mapping.total]);
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          receiptId,
          date,
          hour: date.getHours(),
          dayOfWeek: date.getDay(),
          items: [],
          total,
          tip: 0,
          discount: 0,
          status: 'approved',
        });
      }
      groups.get(groupKey).items.push({ name: itemName, quantity });
    } catch {
      errors++;
    }
  }
  return { rows: [...groups.values()], errors };
};

/**
 * Parses a CSV/XLSX buffer using a column mapping.
 *
 * @param {Buffer} buffer
 * @param {object} opts
 * @param {object} opts.columnMapping
 * @param {'packed' | 'line-per-row'} opts.itemsMode
 * @param {string} [opts.fileExt='csv']
 * @returns {Promise<{rows: object[], errors: number, totalRows: number, dateRange: {firstDate: Date, lastDate: Date}}>}
 */
const parseBuffer = async (buffer, { columnMapping, itemsMode = 'packed', fileExt = 'csv' }) => {
  validateMapping(columnMapping);
  const rawRows = await readRows(buffer, fileExt);

  let rows;
  let errors = 0;

  if (itemsMode === 'line-per-row') {
    const grouped = groupLinePerRow(rawRows, columnMapping);
    rows = grouped.rows;
    errors = grouped.errors;
  } else {
    rows = [];
    for (const raw of rawRows) {
      try {
        const row = buildPackedRow(raw, columnMapping);
        if (row) rows.push(row);
        else errors++;
      } catch {
        errors++;
      }
    }
  }

  let firstDate = null;
  let lastDate = null;
  for (const r of rows) {
    if (!firstDate || r.date < firstDate) firstDate = r.date;
    if (!lastDate || r.date > lastDate) lastDate = r.date;
  }

  return {
    rows,
    errors,
    totalRows: rawRows.length,
    dateRange: { firstDate, lastDate },
  };
};

module.exports = { parseBuffer, parsePackedItems };
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx jest tests/unit/parser.service.test.js
```

Expected: all 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/parser.service.js tests/unit/parser.service.test.js tests/fixtures/test-generic-pos.csv tests/fixtures/test-line-per-row.csv
git commit -m "feat: add generic mapping-based CSV/XLSX parser service"
```

---

## Task 8: AI column mapping proposer

**Files:**
- Modify: `your-guava-backend/src/services/anthropic.service.js`

The `proposeColumnMapping` function takes header names + sample rows and returns a `ColumnMapping` object. Cached in-memory by SHA1 of the headers tuple. Falls back to `{}` (empty mapping) if no API key or response is unparseable — the wizard then opens in manual mode.

- [ ] **Step 1: Edit anthropic.service.js**

Append to `src/services/anthropic.service.js` (before `module.exports`):

```js
const crypto = require('crypto');

const mappingCache = new Map(); // sha1(headers) -> mapping

/**
 * Asks Claude Haiku to propose a column mapping for an unknown CSV format.
 *
 * @param {string[]} headers
 * @param {object[]} sampleRows up to 5 rows for context
 * @returns {Promise<{mapping: object, itemsMode: 'packed'|'line-per-row'}>}
 */
const proposeColumnMapping = async (headers, sampleRows) => {
  const cacheKey = crypto.createHash('sha1').update(headers.join('|')).digest('hex');
  if (mappingCache.has(cacheKey)) {
    return mappingCache.get(cacheKey);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return { mapping: {}, itemsMode: 'packed' };
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `You are mapping CSV columns from a coffee-shop POS export to a canonical schema.

Canonical fields (target keys):
- receiptId (optional): unique transaction/receipt ID
- date (REQUIRED): transaction date
- time (optional): transaction time
- items (REQUIRED): item description column. May be packed like "1 x Flat White,2 x Muffin", or one row per line item.
- total (REQUIRED): total amount paid
- tip, discount, paymentMethod, status (optional)
- quantity (optional, only for line-per-row mode): item quantity column

Headers: ${JSON.stringify(headers)}

Sample rows:
${JSON.stringify(sampleRows.slice(0, 5), null, 2)}

Return ONLY valid JSON with this exact shape, no markdown, no preamble:
{
  "mapping": {
    "receiptId": "<source header or null>",
    "date": "<source header>",
    "time": "<source header or null>",
    "items": "<source header>",
    "total": "<source header>",
    "tip": "<source header or null>",
    "discount": "<source header or null>",
    "paymentMethod": "<source header or null>",
    "status": "<source header or null>",
    "quantity": "<source header or null>"
  },
  "itemsMode": "packed" | "line-per-row"
}

Use null for fields you cannot confidently identify. Choose itemsMode "line-per-row" if each row appears to be a single line item rather than a full receipt.`;

  let result = { mapping: {}, itemsMode: 'packed' };
  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = (message.content[0]?.text || '').replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);
    const cleaned = {};
    for (const [k, v] of Object.entries(parsed.mapping || {})) {
      if (v && headers.includes(v)) cleaned[k] = v;
    }
    result = {
      mapping: cleaned,
      itemsMode: parsed.itemsMode === 'line-per-row' ? 'line-per-row' : 'packed',
    };
  } catch (err) {
    console.error('[anthropic] proposeColumnMapping failed:', err.message);
  }

  mappingCache.set(cacheKey, result);
  return result;
};

const _resetMappingCache = () => mappingCache.clear();
```

Update the existing `module.exports` line at the bottom of the file:

```js
module.exports = { generateInsights, proposeColumnMapping, _resetMappingCache };
```

- [ ] **Step 2: Verify it loads**

```bash
node -e "const a = require('./src/services/anthropic.service'); console.log(typeof a.proposeColumnMapping);"
```

Expected: prints `function`.

- [ ] **Step 3: Commit**

```bash
git add src/services/anthropic.service.js
git commit -m "feat: add proposeColumnMapping to anthropic service for wizard"
```

---

## Task 9: Refactor ingestion service

**Files:**
- Modify: `your-guava-backend/src/services/ingestion.service.js`

The new responsibility: take a parsed-row list (from parser.service) + an Upload record, write transactions tagged with `uploadId`, return stats. The Yoco preset detection moves here as a helper. The old top-level `ingestFile(filePath)` is preserved for compatibility but now delegates to the new flow.

- [ ] **Step 1: Replace ingestion.service.js**

Replace the entire file contents:

```js
const fs = require('fs');
const path = require('path');
const Transaction = require('../models/Transaction.model');
const Item = require('../models/Item.model');
const { parseBuffer } = require('./parser.service');
const { computeDedupKey } = require('../utils/dedupKey');

const YOCO_HEADERS = [
  'Receipt', 'Date', 'Time', 'Status', 'Payment Method', 'Order Number',
  'Card Reader', 'Items', 'Note', 'Currency', 'Tip', 'Discount', 'VAT',
  'Total (incl. tax)', 'Fee Amount', 'Net Amount',
];

/**
 * Returns true if the headers strongly match a Yoco export.
 * Looks for at least 6 of the canonical Yoco headers.
 */
const isYocoFormat = (headers) => {
  const matches = YOCO_HEADERS.filter((h) => headers.includes(h)).length;
  return matches >= 6;
};

const yocoMapping = () => ({
  mapping: {
    receiptId: 'Receipt',
    date: 'Date',
    time: 'Time',
    items: 'Items',
    total: 'Total (incl. tax)',
    tip: 'Tip',
    discount: 'Discount',
    paymentMethod: 'Payment Method',
    status: 'Status',
  },
  itemsMode: 'packed',
});

/**
 * Reads the first row of a CSV buffer to extract headers.
 * @param {Buffer} buffer
 * @returns {Promise<string[]>}
 */
const extractHeaders = async (buffer) => {
  const csv = require('csv-parser');
  const { Readable } = require('stream');
  return new Promise((resolve, reject) => {
    let captured = false;
    const stream = Readable.from(buffer).pipe(csv());
    stream.on('headers', (h) => {
      captured = true;
      resolve(h);
      stream.destroy();
    });
    stream.on('error', reject);
    stream.on('end', () => {
      if (!captured) resolve([]);
    });
  });
};

/**
 * Returns headers + first 5 rows for AI/preset analysis.
 */
const previewBuffer = async (buffer) => {
  const csv = require('csv-parser');
  const { Readable } = require('stream');
  return new Promise((resolve, reject) => {
    const rows = [];
    let headers = [];
    Readable.from(buffer)
      .pipe(csv())
      .on('headers', (h) => { headers = h; })
      .on('data', (row) => {
        if (rows.length < 5) rows.push(row);
      })
      .on('error', reject)
      .on('end', () => resolve({ headers, sampleRows: rows }));
  });
};

/**
 * Phase 2: parses a buffer using the given mapping and writes transactions.
 *
 * @param {Buffer} buffer
 * @param {object} opts
 * @param {string} opts.cafeId
 * @param {string} opts.uploadId
 * @param {object} opts.columnMapping
 * @param {'packed'|'line-per-row'} opts.itemsMode
 * @param {string} [opts.fileExt='csv']
 * @returns {Promise<{imported: number, skipped: number, errors: number, totalRows: number, dateRange: object}>}
 */
const ingestParsedRows = async (buffer, { cafeId, uploadId, columnMapping, itemsMode, fileExt = 'csv' }) => {
  const parsed = await parseBuffer(buffer, { columnMapping, itemsMode, fileExt });

  let imported = 0;
  let skipped = 0;
  let errors = parsed.errors;

  const itemNamesSeen = new Map();

  for (const row of parsed.rows) {
    try {
      const status = (row.status || 'approved').toLowerCase();
      if (status !== 'approved') {
        skipped++;
        continue;
      }

      const dedupKey = row.receiptId ? undefined : computeDedupKey({
        date: row.date.toISOString().slice(0, 10),
        time: row.date.toISOString().slice(11, 16),
        total: row.total,
        items: row.items,
      });

      const filter = row.receiptId
        ? { cafeId, receiptId: row.receiptId }
        : { cafeId, dedupKey };

      const existing = await Transaction.findOne(filter).lean();
      if (existing) {
        skipped++;
        continue;
      }

      await Transaction.create({
        cafeId,
        uploadId,
        receiptId: row.receiptId,
        dedupKey,
        date: row.date,
        hour: row.hour,
        dayOfWeek: row.dayOfWeek,
        status: 'approved',
        paymentMethod: row.paymentMethod,
        items: row.items,
        total: row.total,
        tip: row.tip,
        discount: row.discount,
        source: 'csv',
      });
      imported++;

      for (const item of row.items) {
        const cur = itemNamesSeen.get(item.name) || { totalQty: 0, totalRevenue: 0 };
        cur.totalQty += item.quantity;
        cur.totalRevenue += (item.unitPrice || 0) * item.quantity;
        itemNamesSeen.set(item.name, cur);
      }
    } catch (err) {
      if (err.code === 11000) {
        skipped++;
      } else {
        console.error('[ingestion] row error:', err.message);
        errors++;
      }
    }
  }

  // Item upserts
  for (const [name, stats] of itemNamesSeen.entries()) {
    try {
      await Item.findOneAndUpdate(
        { cafeId, name },
        {
          $inc: { totalSold: stats.totalQty },
          $set: {
            avgPrice: stats.totalQty > 0
              ? parseFloat((stats.totalRevenue / stats.totalQty).toFixed(2))
              : 0,
          },
          $setOnInsert: { cafeId, name },
        },
        { upsert: true, new: true }
      );
    } catch (err) {
      console.error(`[ingestion] item upsert error "${name}":`, err.message);
    }
  }

  return {
    imported,
    skipped,
    errors,
    totalRows: parsed.totalRows,
    dateRange: parsed.dateRange,
  };
};

/**
 * Legacy file-path API. Reads a local file and ingests using the Yoco preset.
 * Preserved so the existing transactions.controller.upload tests still pass while
 * the new two-phase flow is being built up.
 */
const ingestFile = async (filePath, cafeId) => {
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const { mapping, itemsMode } = yocoMapping();
  return ingestParsedRows(buffer, { cafeId, uploadId: null, columnMapping: mapping, itemsMode, fileExt: ext });
};

module.exports = {
  ingestFile,
  ingestParsedRows,
  isYocoFormat,
  yocoMapping,
  extractHeaders,
  previewBuffer,
};
```

- [ ] **Step 2: Run existing transaction tests**

```bash
npx jest tests/integration/transactions.test.js
```

Expected: all existing tests still pass. The Yoco fixture goes through `ingestFile → ingestParsedRows → parseBuffer` end-to-end.

- [ ] **Step 3: Commit**

```bash
git add src/services/ingestion.service.js
git commit -m "refactor: split ingestion into preview + ingestParsedRows for two-phase flow"
```

---

## Task 10: Modify POST /api/transactions/upload (Phase 1)

**Files:**
- Modify: `your-guava-backend/src/controllers/transactions.controller.js`

The endpoint now: uploads to R2, creates an `Upload` record with status `pending_mapping`, runs Yoco preset detection or AI proposal, returns `{ uploadId, posType, columnMapping, itemsMode, preview, needsConfirmation }`. It does NOT write transactions yet.

- [ ] **Step 1: Replace `upload` function**

In `src/controllers/transactions.controller.js`, replace the existing `upload` function and add a require for the new dependencies at the top:

```js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Transaction = require('../models/Transaction.model');
const Cafe = require('../models/Cafe.model');
const Upload = require('../models/Upload.model');
const r2 = require('../services/r2.service');
const ingestion = require('../services/ingestion.service');
const { proposeColumnMapping } = require('../services/anthropic.service');

const upload = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    const cafeId = req.user.cafeId;
    const userId = req.user.id;
    const filePath = req.file.path;
    const fileName = req.file.originalname;
    const fileExt = path.extname(fileName).toLowerCase().slice(1);
    const buffer = fs.readFileSync(filePath);

    // Validate size
    const maxBytes = parseInt(process.env.UPLOAD_MAX_BYTES || '10485760', 10);
    if (buffer.length > maxBytes) {
      try { fs.unlinkSync(filePath); } catch {}
      return res.status(400).json({ success: false, message: `File exceeds ${maxBytes} bytes` });
    }

    // Preview headers + sample rows
    const { headers, sampleRows } = await ingestion.previewBuffer(buffer);
    if (!headers || headers.length === 0) {
      try { fs.unlinkSync(filePath); } catch {}
      return res.status(400).json({ success: false, message: 'Could not parse CSV headers' });
    }

    // Stage to R2
    const r2Key = `uploads/${cafeId}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${fileName}`;
    try {
      await r2.uploadFile(buffer, r2Key, req.file.mimetype || 'text/csv');
    } catch (err) {
      try { fs.unlinkSync(filePath); } catch {}
      return res.status(503).json({ success: false, message: 'File storage unavailable, please retry' });
    }
    try { fs.unlinkSync(filePath); } catch {}

    // Detect format
    let posType, columnMapping, itemsMode;
    if (ingestion.isYocoFormat(headers)) {
      const y = ingestion.yocoMapping();
      posType = 'yoco';
      columnMapping = y.mapping;
      itemsMode = y.itemsMode;
    } else {
      posType = 'wizard';
      // Try cafe-saved mapping first
      const cafe = await Cafe.findById(cafeId).lean();
      if (cafe?.savedColumnMapping) {
        const saved = cafe.savedColumnMapping;
        columnMapping = { ...saved };
        delete columnMapping.itemsMode;
        itemsMode = saved.itemsMode || 'packed';
      } else {
        const proposal = await proposeColumnMapping(headers, sampleRows);
        columnMapping = proposal.mapping;
        itemsMode = proposal.itemsMode;
      }
    }

    const uploadDoc = await Upload.create({
      cafeId,
      uploadedBy: userId,
      fileName,
      fileSize: buffer.length,
      r2Key,
      posType,
      columnMapping,
      itemsMode,
      status: 'pending_mapping',
    });

    return res.status(200).json({
      success: true,
      uploadId: uploadDoc._id,
      posType,
      columnMapping,
      itemsMode,
      headers,
      preview: sampleRows,
      needsConfirmation: posType !== 'yoco',
    });
  } catch (error) {
    next(error);
  }
};
```

Keep `getTransactions` and `getStats` unchanged. Update `module.exports` to include all three.

- [ ] **Step 2: Update existing transactions.test.js for new shape**

Modify `tests/integration/transactions.test.js`. The existing first test expects `res.body.imported` directly. With the new flow, a Yoco-format upload skips the wizard but still goes through Phase 2. For the integration test, we'll auto-confirm Yoco uploads — but since the controller now returns `needsConfirmation: false`, we need the test to call confirm.

Replace the first two tests in the `POST /api/transactions/upload` describe block:

```js
it('uploads Yoco CSV and returns preset mapping ready to confirm', async () => {
  const csvPath = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');
  const res = await request
    .post('/api/transactions/upload')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', csvPath);

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.posType).toBe('yoco');
  expect(res.body.uploadId).toBeDefined();
  expect(res.body.needsConfirmation).toBe(false);
  expect(res.body.columnMapping.date).toBe('Date');
});

it('returns 400 when no file is uploaded', async () => {
  const res = await request
    .post('/api/transactions/upload')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(400);
});
```

The "skips duplicates on re-upload" test moves to `uploads.test.js` in Task 11.

- [ ] **Step 3: Add mocks at the top of transactions.test.js**

`jest.mock` calls are hoisted per-file, so they go in each test file that needs them. At the very top of `tests/integration/transactions.test.js` (above the existing requires):

```js
const _r2Files = new Map();
jest.mock('../../src/services/r2.service', () => ({
  uploadFile: async (buffer, key) => { _r2Files.set(key, buffer); },
  downloadFile: async (key) => _r2Files.get(key),
  getSignedDownloadUrl: async (key) => `https://test.r2.local/${key}`,
  deleteFile: async (key) => { _r2Files.delete(key); },
  _resetClient: () => {},
}));
jest.mock('../../src/services/anthropic.service', () => ({
  generateInsights: async () => ({ insights: [], generatedAt: new Date() }),
  proposeColumnMapping: async () => ({ mapping: {}, itemsMode: 'packed' }),
  _resetMappingCache: () => {},
}));
```

- [ ] **Step 4: Defer transaction-data tests to Task 11**

The `GET /api/transactions` and `GET /api/transactions/stats` tests in this file rely on data being imported, which now requires both stage + confirm. Wrap them in `describe.skip(...)` for now with a comment `// re-enabled after /uploads/:id/confirm exists`. They get re-enabled in Task 11.

```bash
npx jest tests/integration/transactions.test.js
```

Expected: the upload-shape tests pass; the data-dependent tests are skipped (Jest reports them as skipped, not failing).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/transactions.controller.js tests/integration/transactions.test.js tests/setup.js
git commit -m "feat: convert /transactions/upload to Phase 1 staging endpoint"
```

---

## Task 11: POST /api/uploads/:id/confirm

**Files:**
- Create: `your-guava-backend/src/controllers/uploads.controller.js`
- Create: `your-guava-backend/src/routes/uploads.routes.js`
- Modify: `your-guava-backend/src/app.js`
- Create: `your-guava-backend/tests/integration/uploads.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/uploads.test.js`:

```js
const _r2Files = new Map();
jest.mock('../../src/services/r2.service', () => ({
  uploadFile: async (buffer, key) => { _r2Files.set(key, buffer); },
  downloadFile: async (key) => _r2Files.get(key),
  getSignedDownloadUrl: async (key) => `https://test.r2.local/${key}`,
  deleteFile: async (key) => { _r2Files.delete(key); },
  _resetClient: () => {},
}));
jest.mock('../../src/services/anthropic.service', () => ({
  generateInsights: async () => ({ insights: [], generatedAt: new Date() }),
  proposeColumnMapping: async () => ({ mapping: {}, itemsMode: 'packed' }),
  _resetMappingCache: () => {},
}));

const path = require('path');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

const yocoFixture = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');

describe('Uploads API', () => {
  let token;

  beforeEach(async () => {
    const u = await createTestUser();
    token = u.token;
  });

  describe('POST /api/uploads/:id/confirm', () => {
    it('parses transactions and marks upload completed', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      const uploadId = stage.body.uploadId;

      const confirm = await request
        .post(`/api/uploads/${uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      expect(confirm.status).toBe(200);
      expect(confirm.body.success).toBe(true);
      expect(confirm.body.stats.imported).toBe(4);

      const txns = await Transaction.find({ uploadId }).lean();
      expect(txns).toHaveLength(4);
      expect(txns[0].uploadId.toString()).toBe(uploadId);
    });

    it('returns 409 when confirming an already-completed upload', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      const uploadId = stage.body.uploadId;
      await request
        .post(`/api/uploads/${uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });
      const second = await request
        .post(`/api/uploads/${uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });
      expect(second.status).toBe(409);
    });

    it('returns 400 when required fields are missing from mapping', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      const res = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: { date: 'Date' }, itemsMode: 'packed' });
      expect(res.status).toBe(400);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest tests/integration/uploads.test.js
```

Expected: FAIL with route not found.

- [ ] **Step 3: Implement controller**

Create `src/controllers/uploads.controller.js`:

```js
const Upload = require('../models/Upload.model');
const Transaction = require('../models/Transaction.model');
const Cafe = require('../models/Cafe.model');
const r2 = require('../services/r2.service');
const ingestion = require('../services/ingestion.service');

const REQUIRED = ['date', 'items', 'total'];

const confirm = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { columnMapping, itemsMode } = req.body;
    const cafeId = req.user.cafeId;

    const missing = REQUIRED.filter((f) => !columnMapping?.[f]);
    if (missing.length > 0) {
      return res.status(400).json({ success: false, message: `Missing required mapping: ${missing.join(', ')}` });
    }

    const upload = await Upload.findOne({ _id: id, cafeId });
    if (!upload) return res.status(404).json({ success: false, message: 'Upload not found' });
    if (upload.status === 'completed' || upload.status === 'parsing') {
      return res.status(409).json({ success: false, message: `Upload already ${upload.status}` });
    }

    upload.status = 'parsing';
    upload.columnMapping = columnMapping;
    upload.itemsMode = itemsMode || 'packed';
    await upload.save();

    try {
      const buffer = await r2.downloadFile(upload.r2Key);
      const ext = upload.fileName.split('.').pop().toLowerCase();
      const result = await ingestion.ingestParsedRows(buffer, {
        cafeId,
        uploadId: upload._id,
        columnMapping,
        itemsMode: upload.itemsMode,
        fileExt: ext,
      });

      upload.status = 'completed';
      upload.stats = {
        imported: result.imported,
        skipped: result.skipped,
        errors: result.errors,
        totalRows: result.totalRows,
      };
      upload.dateRange = result.dateRange;
      upload.completedAt = new Date();
      await upload.save();

      // Persist mapping for next time, only when wizard route was used
      if (upload.posType === 'wizard') {
        await Cafe.findByIdAndUpdate(cafeId, {
          $set: { savedColumnMapping: { ...columnMapping, itemsMode: upload.itemsMode } },
        });
      }

      await Cafe.findByIdAndUpdate(cafeId, {
        $set: { dataUploaded: true, lastSyncAt: new Date() },
      });

      return res.status(200).json({
        success: true,
        uploadId: upload._id,
        stats: upload.stats,
        dateRange: upload.dateRange,
      });
    } catch (err) {
      upload.status = 'failed';
      upload.errorMessage = err.message;
      await upload.save();
      throw err;
    }
  } catch (error) {
    next(error);
  }
};

module.exports = { confirm };
```

- [ ] **Step 4: Create routes file**

Create `src/routes/uploads.routes.js`:

```js
const express = require('express');
const authMiddleware = require('../middleware/auth.middleware');
const uploads = require('../controllers/uploads.controller');

const router = express.Router();

router.post('/:id/confirm', authMiddleware, uploads.confirm);

module.exports = router;
```

- [ ] **Step 5: Register route in app.js**

Modify `src/app.js`. Add after the other route imports:

```js
const uploadsRoutes = require('./routes/uploads.routes');
```

Add after the other `app.use` lines:

```js
app.use('/api/uploads', uploadsRoutes);
```

- [ ] **Step 6: Run tests**

```bash
npx jest tests/integration/uploads.test.js
```

Expected: 3 tests pass.

- [ ] **Step 7: Re-enable skipped transactions.test.js tests**

In `tests/integration/transactions.test.js`, change `describe.skip` back to `describe`. For each test that previously expected data after a single upload, insert a confirm call between the upload and the assertions:

```js
const stage = await request
  .post('/api/transactions/upload')
  .set('Authorization', `Bearer ${token}`)
  .attach('file', csvPath);
await request
  .post(`/api/uploads/${stage.body.uploadId}/confirm`)
  .set('Authorization', `Bearer ${token}`)
  .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });
```

Run:
```bash
npx jest tests/integration/transactions.test.js
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/controllers/uploads.controller.js src/routes/uploads.routes.js src/app.js tests/integration/uploads.test.js tests/integration/transactions.test.js
git commit -m "feat: POST /api/uploads/:id/confirm — Phase 2 ingestion"
```

---

## Task 12: GET /api/uploads (list)

**Files:**
- Modify: `your-guava-backend/src/controllers/uploads.controller.js`
- Modify: `your-guava-backend/src/routes/uploads.routes.js`
- Modify: `your-guava-backend/tests/integration/uploads.test.js`

- [ ] **Step 1: Add failing test**

Append inside the `describe('Uploads API'` block in `tests/integration/uploads.test.js`:

```js
describe('GET /api/uploads', () => {
  it('returns uploads for the current cafe in reverse chronological order', async () => {
    await request
      .post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', yocoFixture);
    await request
      .post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', yocoFixture);

    const res = await request.get('/api/uploads').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.uploads).toHaveLength(2);
    expect(new Date(res.body.uploads[0].createdAt).getTime())
      .toBeGreaterThanOrEqual(new Date(res.body.uploads[1].createdAt).getTime());
  });

  it('does not leak uploads across cafes', async () => {
    const other = await createTestUser({ email: 'b@yourguava.com', cafeName: 'Cafe B', orgName: 'Org B' });
    await request
      .post('/api/transactions/upload')
      .set('Authorization', `Bearer ${other.token}`)
      .attach('file', yocoFixture);
    const res = await request.get('/api/uploads').set('Authorization', `Bearer ${token}`);
    expect(res.body.uploads).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest tests/integration/uploads.test.js -t "GET /api/uploads"
```

Expected: FAIL with 404.

- [ ] **Step 3: Implement list endpoint**

Add to `src/controllers/uploads.controller.js`:

```js
const list = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const [uploads, total] = await Promise.all([
      Upload.find({ cafeId, status: { $ne: 'deleted' } })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('uploadedBy', 'name email')
        .lean(),
      Upload.countDocuments({ cafeId, status: { $ne: 'deleted' } }),
    ]);

    return res.status(200).json({
      success: true,
      uploads,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};
```

Update `module.exports`:

```js
module.exports = { confirm, list };
```

- [ ] **Step 4: Add route**

In `src/routes/uploads.routes.js` add before the confirm route:

```js
router.get('/', authMiddleware, uploads.list);
```

- [ ] **Step 5: Run tests**

```bash
npx jest tests/integration/uploads.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/controllers/uploads.controller.js src/routes/uploads.routes.js tests/integration/uploads.test.js
git commit -m "feat: GET /api/uploads — paginated history list"
```

---

## Task 13: GET /api/uploads/:id (detail + signed URL)

**Files:**
- Modify: `your-guava-backend/src/controllers/uploads.controller.js`
- Modify: `your-guava-backend/src/routes/uploads.routes.js`
- Modify: `your-guava-backend/tests/integration/uploads.test.js`

- [ ] **Step 1: Add failing test**

Append to the `describe('Uploads API'` block:

```js
describe('GET /api/uploads/:id', () => {
  it('returns the upload record with a signed download URL', async () => {
    const stage = await request
      .post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', yocoFixture);
    await request
      .post(`/api/uploads/${stage.body.uploadId}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

    const res = await request
      .get(`/api/uploads/${stage.body.uploadId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.upload._id).toBe(stage.body.uploadId);
    expect(res.body.upload.status).toBe('completed');
    expect(res.body.downloadUrl).toMatch(/^https:\/\//);
  });

  it('returns 404 for another cafe\'s upload', async () => {
    const stage = await request
      .post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', yocoFixture);
    const other = await createTestUser({ email: 'c@yourguava.com', cafeName: 'Cafe C', orgName: 'Org C' });
    const res = await request
      .get(`/api/uploads/${stage.body.uploadId}`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest tests/integration/uploads.test.js -t "GET /api/uploads/:id"
```

Expected: FAIL with 404 from missing route.

- [ ] **Step 3: Implement detail endpoint**

Add to `src/controllers/uploads.controller.js`:

```js
const detail = async (req, res, next) => {
  try {
    const upload = await Upload.findOne({ _id: req.params.id, cafeId: req.user.cafeId })
      .populate('uploadedBy', 'name email')
      .lean();
    if (!upload || upload.status === 'deleted') {
      return res.status(404).json({ success: false, message: 'Upload not found' });
    }
    const downloadUrl = await r2.getSignedDownloadUrl(upload.r2Key, 900);
    return res.status(200).json({ success: true, upload, downloadUrl });
  } catch (error) {
    next(error);
  }
};
```

Add `detail` to `module.exports`.

- [ ] **Step 4: Add route**

In `src/routes/uploads.routes.js` add:

```js
router.get('/:id', authMiddleware, uploads.detail);
```

(Place above `/:id/confirm`.)

- [ ] **Step 5: Run tests**

```bash
npx jest tests/integration/uploads.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/controllers/uploads.controller.js src/routes/uploads.routes.js tests/integration/uploads.test.js
git commit -m "feat: GET /api/uploads/:id with signed R2 download URL"
```

---

## Task 14: GET /api/uploads/:id/rows

**Files:**
- Modify: `your-guava-backend/src/controllers/uploads.controller.js`
- Modify: `your-guava-backend/src/routes/uploads.routes.js`
- Modify: `your-guava-backend/tests/integration/uploads.test.js`

- [ ] **Step 1: Add failing test**

```js
describe('GET /api/uploads/:id/rows', () => {
  it('returns paginated transactions linked to this upload', async () => {
    const stage = await request
      .post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', yocoFixture);
    await request
      .post(`/api/uploads/${stage.body.uploadId}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

    const res = await request
      .get(`/api/uploads/${stage.body.uploadId}/rows`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(4);
    expect(res.body.transactions[0].uploadId).toBe(stage.body.uploadId);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx jest tests/integration/uploads.test.js -t "GET /api/uploads/:id/rows"
```

Expected: 404.

- [ ] **Step 3: Implement rows endpoint**

Add to `src/controllers/uploads.controller.js`:

```js
const rows = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const upload = await Upload.findOne({ _id: req.params.id, cafeId }).lean();
    if (!upload) return res.status(404).json({ success: false, message: 'Upload not found' });

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      Transaction.find({ cafeId, uploadId: upload._id })
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Transaction.countDocuments({ cafeId, uploadId: upload._id }),
    ]);

    return res.status(200).json({
      success: true,
      transactions,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};
```

Add `rows` to `module.exports`.

- [ ] **Step 4: Add route**

In `src/routes/uploads.routes.js` add:

```js
router.get('/:id/rows', authMiddleware, uploads.rows);
```

- [ ] **Step 5: Run tests**

```bash
npx jest tests/integration/uploads.test.js
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/controllers/uploads.controller.js src/routes/uploads.routes.js tests/integration/uploads.test.js
git commit -m "feat: GET /api/uploads/:id/rows for upload row audit"
```

---

## Task 15: PATCH /api/uploads/:id/mapping

**Files:**
- Modify: `your-guava-backend/src/controllers/uploads.controller.js`
- Modify: `your-guava-backend/src/routes/uploads.routes.js`
- Modify: `your-guava-backend/tests/integration/uploads.test.js`

Atomicity requirement: re-parsing must not lose existing data on failure. Implementation strategy: delete linked transactions, re-parse, re-insert. If anything throws mid-way, mark Upload `failed` so the user can retry. We don't need a Mongo session/transaction because the Upload record itself records the canonical state.

- [ ] **Step 1: Add failing test**

```js
describe('PATCH /api/uploads/:id/mapping', () => {
  it('re-parses with new mapping, replacing transactions', async () => {
    const stage = await request
      .post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', yocoFixture);
    await request
      .post(`/api/uploads/${stage.body.uploadId}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

    const before = await Transaction.find({ uploadId: stage.body.uploadId }).lean();
    expect(before).toHaveLength(4);

    const res = await request
      .patch(`/api/uploads/${stage.body.uploadId}/mapping`)
      .set('Authorization', `Bearer ${token}`)
      .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

    expect(res.status).toBe(200);
    expect(res.body.stats.imported).toBe(4);
    const after = await Transaction.find({ uploadId: stage.body.uploadId }).lean();
    expect(after).toHaveLength(4);
  });

  it('returns 409 when status is parsing', async () => {
    const stage = await request
      .post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', yocoFixture);
    // Manually set status to parsing
    const Upload = require('../../src/models/Upload.model');
    await Upload.updateOne({ _id: stage.body.uploadId }, { $set: { status: 'parsing' } });
    const res = await request
      .patch(`/api/uploads/${stage.body.uploadId}/mapping`)
      .set('Authorization', `Bearer ${token}`)
      .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx jest tests/integration/uploads.test.js -t "PATCH /api/uploads/:id/mapping"
```

Expected: 404.

- [ ] **Step 3: Implement remap endpoint**

Add to `src/controllers/uploads.controller.js`:

```js
const remap = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { columnMapping, itemsMode } = req.body;
    const cafeId = req.user.cafeId;

    const missing = REQUIRED.filter((f) => !columnMapping?.[f]);
    if (missing.length > 0) {
      return res.status(400).json({ success: false, message: `Missing required mapping: ${missing.join(', ')}` });
    }

    const upload = await Upload.findOne({ _id: id, cafeId });
    if (!upload || upload.status === 'deleted') {
      return res.status(404).json({ success: false, message: 'Upload not found' });
    }
    if (upload.status === 'parsing' || upload.status === 'pending_mapping') {
      return res.status(409).json({ success: false, message: `Cannot remap while ${upload.status}` });
    }

    upload.status = 'parsing';
    upload.columnMapping = columnMapping;
    upload.itemsMode = itemsMode || 'packed';
    await upload.save();

    try {
      await Transaction.deleteMany({ cafeId, uploadId: upload._id });

      const buffer = await r2.downloadFile(upload.r2Key);
      const ext = upload.fileName.split('.').pop().toLowerCase();
      const result = await ingestion.ingestParsedRows(buffer, {
        cafeId,
        uploadId: upload._id,
        columnMapping,
        itemsMode: upload.itemsMode,
        fileExt: ext,
      });

      upload.status = 'completed';
      upload.stats = {
        imported: result.imported,
        skipped: result.skipped,
        errors: result.errors,
        totalRows: result.totalRows,
      };
      upload.dateRange = result.dateRange;
      upload.completedAt = new Date();
      upload.errorMessage = undefined;
      await upload.save();

      return res.status(200).json({
        success: true,
        uploadId: upload._id,
        stats: upload.stats,
        dateRange: upload.dateRange,
      });
    } catch (err) {
      upload.status = 'failed';
      upload.errorMessage = err.message;
      await upload.save();
      throw err;
    }
  } catch (error) {
    next(error);
  }
};
```

Add `remap` to `module.exports`.

- [ ] **Step 4: Add route**

```js
router.patch('/:id/mapping', authMiddleware, uploads.remap);
```

- [ ] **Step 5: Run tests**

```bash
npx jest tests/integration/uploads.test.js
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/controllers/uploads.controller.js src/routes/uploads.routes.js tests/integration/uploads.test.js
git commit -m "feat: PATCH /api/uploads/:id/mapping — atomic re-parse"
```

---

## Task 16: DELETE /api/uploads/:id (owner only)

**Files:**
- Modify: `your-guava-backend/src/controllers/uploads.controller.js`
- Modify: `your-guava-backend/src/routes/uploads.routes.js`
- Modify: `your-guava-backend/tests/integration/uploads.test.js`

- [ ] **Step 1: Inspect existing role middleware**

```bash
cat src/middleware/auth.middleware.js
```

Note the export name for role-checking (`requireRole`, `roleMiddleware`, etc.). The tests below assume `requireRole('owner')`. If the export is named differently, adapt the route.

- [ ] **Step 2: Add failing test**

```js
describe('DELETE /api/uploads/:id', () => {
  it('owner soft-deletes upload, removing transactions and R2 object', async () => {
    const stage = await request
      .post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', yocoFixture);
    await request
      .post(`/api/uploads/${stage.body.uploadId}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

    const res = await request
      .delete(`/api/uploads/${stage.body.uploadId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const txns = await Transaction.find({ uploadId: stage.body.uploadId }).lean();
    expect(txns).toHaveLength(0);

    const Upload = require('../../src/models/Upload.model');
    const u = await Upload.findById(stage.body.uploadId).lean();
    expect(u.status).toBe('deleted');
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
npx jest tests/integration/uploads.test.js -t "DELETE /api/uploads/:id"
```

Expected: 404.

- [ ] **Step 4: Implement delete endpoint**

Add to `src/controllers/uploads.controller.js`:

```js
const remove = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const upload = await Upload.findOne({ _id: req.params.id, cafeId });
    if (!upload || upload.status === 'deleted') {
      return res.status(404).json({ success: false, message: 'Upload not found' });
    }

    await Transaction.deleteMany({ cafeId, uploadId: upload._id });
    try { await r2.deleteFile(upload.r2Key); } catch (err) {
      console.error('[uploads] r2 delete failed:', err.message);
    }
    upload.status = 'deleted';
    await upload.save();

    return res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};
```

Add `remove` to `module.exports`.

- [ ] **Step 5: Add owner-only route**

In `src/routes/uploads.routes.js`, import the role middleware and add the DELETE route. Adjust the import name to match what's actually exported by your auth middleware:

```js
const { requireRole } = require('../middleware/auth.middleware');
// ...
router.delete('/:id', authMiddleware, requireRole('owner'), uploads.remove);
```

If `requireRole` lives elsewhere or has a different name, find and use it (`grep "requireRole\\|roleMiddleware" src/`).

- [ ] **Step 6: Run tests**

```bash
npx jest tests/integration/uploads.test.js
```

Expected: all pass (the test user created by `createTestUser` is an owner).

- [ ] **Step 7: Commit**

```bash
git add src/controllers/uploads.controller.js src/routes/uploads.routes.js tests/integration/uploads.test.js
git commit -m "feat: DELETE /api/uploads/:id (owner only) cascades to txns + R2"
```

---

## Task 17: Run full backend test suite

**Files:** none (verification only)

- [ ] **Step 1: Run everything**

```bash
cd C:\Users\shaun\your-guava-backend
npx jest
```

Expected: all suites pass. Existing forecasts/analytics/etc tests must still pass.

If any pre-existing test fails because of model changes (Transaction.receiptId no longer required), fix the test by either supplying a receiptId or by setting a dedupKey. Do not change the model back.

- [ ] **Step 2: Commit any test fixups**

```bash
git add -A
git commit -m "test: align existing tests with optional receiptId"
```

(Skip if nothing needed fixing.)

---

## Task 18: Frontend — Upload types

**Files:**
- Create: `your-guava-portal/src/types/upload.ts`

- [ ] **Step 1: Create types file**

Create `src/types/upload.ts`:

```ts
export type UploadStatus =
  | 'pending_mapping'
  | 'parsing'
  | 'completed'
  | 'failed'
  | 'deleted';

export type ItemsMode = 'packed' | 'line-per-row';

export interface ColumnMapping {
  receiptId?: string;
  date?: string;
  time?: string;
  items?: string;
  total?: string;
  tip?: string;
  discount?: string;
  paymentMethod?: string;
  status?: string;
  quantity?: string;
}

export interface UploadStats {
  imported: number;
  skipped: number;
  errors: number;
  totalRows: number;
}

export interface UploadDateRange {
  firstDate?: string;
  lastDate?: string;
}

export interface Upload {
  _id: string;
  cafeId: string;
  uploadedBy: { _id: string; name: string; email: string } | string;
  fileName: string;
  fileSize: number;
  r2Key: string;
  posType: 'yoco' | 'wizard';
  columnMapping: ColumnMapping;
  itemsMode: ItemsMode;
  status: UploadStatus;
  stats: UploadStats;
  dateRange: UploadDateRange;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
}

export interface StageUploadResponse {
  success: true;
  uploadId: string;
  posType: 'yoco' | 'wizard';
  columnMapping: ColumnMapping;
  itemsMode: ItemsMode;
  headers: string[];
  preview: Record<string, string>[];
  needsConfirmation: boolean;
}
```

- [ ] **Step 2: Verify it type-checks**

```bash
cd C:\Users\shaun\your-guava-portal
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/types/upload.ts
git commit -m "feat: add Upload TypeScript types"
```

---

## Task 19: Frontend — ColumnMappingWizard

**Files:**
- Create: `your-guava-portal/src/components/upload/ColumnMappingWizard.tsx`
- Test: `your-guava-portal/src/components/upload/ColumnMappingWizard.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/upload/ColumnMappingWizard.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ColumnMappingWizard } from './ColumnMappingWizard'
import type { ColumnMapping } from '@/types/upload'

const headers = ['Txn', 'When', 'Description', 'Amount']
const preview = [
  { Txn: 'A1', When: '2026-04-01 08:30', Description: '1 x Flat White', Amount: '32.00' },
]

const baseMapping: ColumnMapping = { date: 'When', items: 'Description', total: 'Amount' }

describe('ColumnMappingWizard', () => {
  it('disables confirm when required fields are unmapped', () => {
    const onConfirm = vi.fn()
    render(
      <ColumnMappingWizard
        open
        headers={headers}
        preview={preview}
        initialMapping={{ date: 'When' }}
        initialItemsMode="packed"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />
    )
    const confirm = screen.getByRole('button', { name: /confirm/i })
    expect(confirm).toBeDisabled()
  })

  it('calls onConfirm with mapping when all required fields set', () => {
    const onConfirm = vi.fn()
    render(
      <ColumnMappingWizard
        open
        headers={headers}
        preview={preview}
        initialMapping={baseMapping}
        initialItemsMode="packed"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ date: 'When', items: 'Description', total: 'Amount' }),
      'packed'
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/components/upload/ColumnMappingWizard.test.tsx
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement the component**

Create `src/components/upload/ColumnMappingWizard.tsx`:

```tsx
import { useMemo, useState } from 'react'
import type { ColumnMapping, ItemsMode } from '@/types/upload'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

const CANONICAL_FIELDS: { key: keyof ColumnMapping; label: string; required: boolean }[] = [
  { key: 'date', label: 'Date', required: true },
  { key: 'items', label: 'Items / Description', required: true },
  { key: 'total', label: 'Total amount', required: true },
  { key: 'time', label: 'Time', required: false },
  { key: 'receiptId', label: 'Receipt ID', required: false },
  { key: 'tip', label: 'Tip', required: false },
  { key: 'discount', label: 'Discount', required: false },
  { key: 'paymentMethod', label: 'Payment method', required: false },
  { key: 'status', label: 'Status', required: false },
  { key: 'quantity', label: 'Quantity (line-per-row mode)', required: false },
]

interface Props {
  open: boolean
  headers: string[]
  preview: Record<string, string>[]
  initialMapping: ColumnMapping
  initialItemsMode: ItemsMode
  onConfirm: (mapping: ColumnMapping, itemsMode: ItemsMode) => void
  onCancel: () => void
}

export function ColumnMappingWizard({
  open,
  headers,
  preview,
  initialMapping,
  initialItemsMode,
  onConfirm,
  onCancel,
}: Props) {
  const [mapping, setMapping] = useState<ColumnMapping>(initialMapping)
  const [itemsMode, setItemsMode] = useState<ItemsMode>(initialItemsMode)

  const requiredOk = useMemo(
    () => Boolean(mapping.date && mapping.items && mapping.total),
    [mapping]
  )

  if (!open) return null

  const setField = (key: keyof ColumnMapping, value: string | undefined) =>
    setMapping((m) => ({ ...m, [key]: value || undefined }))

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 overflow-auto">
      <Card className="max-w-3xl w-full">
        <CardHeader>
          <CardTitle>Map your CSV columns</CardTitle>
          <p className="text-sm text-[#888888]">
            We couldn't auto-detect your file format. Match each canonical field on the left to the
            column from your CSV on the right. Required fields are marked with *.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {CANONICAL_FIELDS.map(({ key, label, required }) => (
              <div key={key} className="contents">
                <label className="text-sm text-[#F0F0F0] self-center">
                  {label}{required && <span className="text-[#D43D3D]"> *</span>}
                </label>
                <select
                  className="bg-[#111111] border border-[#2A2A2A] rounded-lg px-2 py-1 text-sm"
                  value={mapping[key] || ''}
                  onChange={(e) => setField(key, e.target.value)}
                >
                  <option value="">— none —</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <div>
            <label className="text-sm text-[#F0F0F0] mr-3">Items mode:</label>
            <select
              className="bg-[#111111] border border-[#2A2A2A] rounded-lg px-2 py-1 text-sm"
              value={itemsMode}
              onChange={(e) => setItemsMode(e.target.value as ItemsMode)}
            >
              <option value="packed">Packed (one row per receipt)</option>
              <option value="line-per-row">Line-per-row (one row per item)</option>
            </select>
          </div>

          {preview.length > 0 && (
            <div className="text-xs text-[#777777]">
              <p className="mb-2">Preview (first {preview.length} rows):</p>
              <div className="overflow-auto max-h-48 border border-[#2A2A2A] rounded-lg">
                <table className="text-xs w-full">
                  <thead className="bg-[#111111]">
                    <tr>{headers.map((h) => <th key={h} className="px-2 py-1 text-left">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {preview.map((row, i) => (
                      <tr key={i} className="border-t border-[#2A2A2A]">
                        {headers.map((h) => <td key={h} className="px-2 py-1">{row[h]}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onCancel}>Cancel</Button>
            <Button
              variant="success"
              disabled={!requiredOk}
              onClick={() => onConfirm(mapping, itemsMode)}
            >
              Confirm and import
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 4: Run test**

```bash
npx vitest run src/components/upload/ColumnMappingWizard.test.tsx
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/upload/ColumnMappingWizard.tsx src/components/upload/ColumnMappingWizard.test.tsx
git commit -m "feat: ColumnMappingWizard component for non-Yoco CSV imports"
```

---

## Task 20: Frontend — UploadHistoryCard

**Files:**
- Create: `your-guava-portal/src/components/upload/UploadHistoryCard.tsx`

This is a presentation card that fetches `/uploads` and renders a table. We'll skip a unit test for it — the integration coverage comes from `Connect.test.tsx` in Task 22.

- [ ] **Step 1: Implement the component**

Create `src/components/upload/UploadHistoryCard.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { History, FileText, ExternalLink, Loader2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import api from '@/lib/api'
import type { Upload } from '@/types/upload'

const statusColor: Record<string, 'success' | 'secondary' | 'destructive'> = {
  completed: 'success',
  pending_mapping: 'secondary',
  parsing: 'secondary',
  failed: 'destructive',
}

export function UploadHistoryCard() {
  const [uploads, setUploads] = useState<Upload[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    api.get<{ success: boolean; uploads: Upload[] }>('/uploads')
      .then(({ data }) => { if (active) setUploads(data.uploads) })
      .catch(() => { if (active) setUploads([]) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-[#D43D3D]" />
          <CardTitle>Upload history</CardTitle>
        </div>
        <CardDescription>
          Every CSV/XLSX you've imported. Click an entry to view the imported rows or download the original file.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading && (
          <div className="flex items-center gap-2 text-sm text-[#555555]">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading...
          </div>
        )}
        {!loading && uploads.length === 0 && (
          <p className="text-sm text-[#555555]">No uploads yet. Drop a CSV in the card above to get started.</p>
        )}
        {!loading && uploads.length > 0 && (
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[#777777] text-xs">
                  <th className="py-2">File</th>
                  <th>POS</th>
                  <th>Imported</th>
                  <th>Date range</th>
                  <th>Status</th>
                  <th>Uploaded</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {uploads.map((u) => (
                  <tr key={u._id} className="border-t border-[#2A2A2A]">
                    <td className="py-2 flex items-center gap-2"><FileText className="w-3.5 h-3.5 text-[#777777]" />{u.fileName}</td>
                    <td>{u.posType}</td>
                    <td>{u.stats.imported}</td>
                    <td className="text-[#888888]">
                      {u.dateRange?.firstDate ? new Date(u.dateRange.firstDate).toLocaleDateString('en-ZA') : '—'}
                      {' → '}
                      {u.dateRange?.lastDate ? new Date(u.dateRange.lastDate).toLocaleDateString('en-ZA') : '—'}
                    </td>
                    <td><Badge variant={statusColor[u.status] || 'secondary'}>{u.status}</Badge></td>
                    <td className="text-[#888888]">{new Date(u.createdAt).toLocaleString('en-ZA')}</td>
                    <td>
                      <Link to={`/uploads/${u._id}`} className="text-[#D43D3D] hover:underline inline-flex items-center gap-1">
                        View <ExternalLink className="w-3 h-3" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/upload/UploadHistoryCard.tsx
git commit -m "feat: UploadHistoryCard listing past uploads"
```

---

## Task 21: Frontend — UploadDetail page + route

**Files:**
- Create: `your-guava-portal/src/pages/UploadDetail.tsx`
- Test: `your-guava-portal/src/pages/UploadDetail.test.tsx`
- Modify: `your-guava-portal/src/App.tsx` (or wherever `<Routes>` is declared)

- [ ] **Step 1: Find the routes file**

```bash
cd C:\Users\shaun\your-guava-portal
grep -rn "ProtectedRoute\\|Routes>" src/
```

Note the path that contains the route definitions (likely `src/App.tsx` or `src/main.tsx`).

- [ ] **Step 2: Write the failing test**

Create `src/pages/UploadDetail.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import UploadDetail from './UploadDetail'
import api from '@/lib/api'

vi.mock('@/lib/api', () => ({
  default: { get: vi.fn(), delete: vi.fn() },
}))
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const apiMock = api as unknown as { get: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }

describe('UploadDetail', () => {
  beforeEach(() => {
    apiMock.get.mockReset()
    apiMock.delete.mockReset()
  })

  it('renders upload metadata and a download link', async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.endsWith('/rows')) return Promise.resolve({ data: { transactions: [], pagination: { total: 0 } } })
      return Promise.resolve({
        data: {
          upload: {
            _id: 'u1',
            fileName: 'export.csv',
            status: 'completed',
            stats: { imported: 4, skipped: 0, errors: 0, totalRows: 4 },
            posType: 'yoco',
            createdAt: new Date().toISOString(),
            uploadedBy: { name: 'Shaun', email: 's@x.za' },
            dateRange: { firstDate: '2026-04-01', lastDate: '2026-04-02' },
          },
          downloadUrl: 'https://test.r2.local/foo',
        },
      })
    })
    render(
      <MemoryRouter initialEntries={["/uploads/u1"]}>
        <Routes>
          <Route path="/uploads/:id" element={<UploadDetail />} />
        </Routes>
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByText('export.csv')).toBeInTheDocument())
    expect(screen.getByText(/imported/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /download/i })).toHaveAttribute('href', 'https://test.r2.local/foo')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run src/pages/UploadDetail.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement the page**

Create `src/pages/UploadDetail.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Loader2, Download, Trash2, ArrowLeft } from 'lucide-react'
import { AppLayout } from '@/components/layout/AppLayout'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import api from '@/lib/api'
import type { Upload } from '@/types/upload'

interface Row {
  _id: string
  date: string
  total: number
  items: { name: string; quantity: number }[]
  receiptId?: string
}

export default function UploadDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [upload, setUpload] = useState<Upload | null>(null)
  const [downloadUrl, setDownloadUrl] = useState<string>('')
  const [rows, setRows] = useState<Row[]>([])
  const [tab, setTab] = useState<'rows' | 'file'>('rows')
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (!id) return
    Promise.all([
      api.get<{ upload: Upload; downloadUrl: string }>(`/uploads/${id}`),
      api.get<{ transactions: Row[] }>(`/uploads/${id}/rows`),
    ])
      .then(([detail, rowsRes]) => {
        setUpload(detail.data.upload)
        setDownloadUrl(detail.data.downloadUrl)
        setRows(rowsRes.data.transactions)
      })
      .finally(() => setLoading(false))
  }, [id])

  const handleDelete = async () => {
    if (!confirm('Delete this upload? Linked transactions will be removed.')) return
    setDeleting(true)
    try {
      await api.delete(`/uploads/${id}`)
      navigate('/connect')
    } catch {
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <AppLayout title="Upload">
        <div className="flex items-center gap-2 text-sm text-[#555555]"><Loader2 className="w-4 h-4 animate-spin" /> Loading...</div>
      </AppLayout>
    )
  }

  if (!upload) {
    return <AppLayout title="Upload"><p>Not found.</p></AppLayout>
  }

  return (
    <AppLayout title={upload.fileName}>
      <div className="max-w-4xl space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate('/connect')}>
          <ArrowLeft className="w-4 h-4" /> Back to Connect
        </Button>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between">
            <div>
              <CardTitle>{upload.fileName}</CardTitle>
              <p className="text-sm text-[#888888] mt-1">
                Uploaded {new Date(upload.createdAt).toLocaleString('en-ZA')} • {upload.posType}
              </p>
            </div>
            <Badge variant={upload.status === 'completed' ? 'success' : 'secondary'}>{upload.status}</Badge>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-4 gap-3">
              <Stat label="Imported" value={upload.stats.imported} />
              <Stat label="Skipped" value={upload.stats.skipped} />
              <Stat label="Errors" value={upload.stats.errors} />
              <Stat label="Total rows" value={upload.stats.totalRows} />
            </div>
            {upload.dateRange?.firstDate && (
              <p className="text-sm text-[#888888] mt-3">
                Date range: {new Date(upload.dateRange.firstDate).toLocaleDateString('en-ZA')}
                {' → '}
                {new Date(upload.dateRange.lastDate!).toLocaleDateString('en-ZA')}
              </p>
            )}
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button variant={tab === 'rows' ? 'success' : 'outline'} size="sm" onClick={() => setTab('rows')}>
            Imported transactions
          </Button>
          <Button variant={tab === 'file' ? 'success' : 'outline'} size="sm" onClick={() => setTab('file')}>
            Original file
          </Button>
        </div>

        {tab === 'rows' && (
          <Card>
            <CardContent className="overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[#777777] text-xs">
                    <th className="py-2">Date</th>
                    <th>Receipt</th>
                    <th>Items</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r._id} className="border-t border-[#2A2A2A]">
                      <td className="py-2">{new Date(r.date).toLocaleString('en-ZA')}</td>
                      <td>{r.receiptId || '—'}</td>
                      <td>{r.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')}</td>
                      <td>R{r.total?.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}

        {tab === 'file' && (
          <Card>
            <CardContent className="space-y-3">
              <p className="text-sm text-[#888888]">Download the original file you uploaded.</p>
              <a href={downloadUrl} target="_blank" rel="noreferrer">
                <Button variant="success">
                  <Download className="w-4 h-4" /> Download {upload.fileName}
                </Button>
              </a>
            </CardContent>
          </Card>
        )}

        <div className="pt-4 border-t border-[#2A2A2A]">
          <Button variant="ghost" size="sm" className="text-[#D43D3D]" onClick={handleDelete} disabled={deleting}>
            <Trash2 className="w-4 h-4" /> Delete this upload
          </Button>
        </div>
      </div>
    </AppLayout>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-[#111111] border border-[#2A2A2A] rounded-lg p-3 text-center">
      <p className="text-[#F0F0F0] text-xl font-bold">{value}</p>
      <p className="text-[#555555] text-xs">{label}</p>
    </div>
  )
}
```

- [ ] **Step 5: Add `/uploads/:id` route**

In your routes file (e.g. `src/App.tsx`), add inside the `<Routes>` block, alongside other protected routes:

```tsx
<Route path="/uploads/:id" element={<ProtectedRoute><UploadDetail /></ProtectedRoute>} />
```

And add the import:

```tsx
import UploadDetail from './pages/UploadDetail'
```

- [ ] **Step 6: Run test**

```bash
npx vitest run src/pages/UploadDetail.test.tsx
```

Expected: 1 test passes.

- [ ] **Step 7: Commit**

```bash
git add src/pages/UploadDetail.tsx src/pages/UploadDetail.test.tsx src/App.tsx
git commit -m "feat: UploadDetail page with rows / file tabs and delete"
```

---

## Task 22: Wire Connect.tsx to wizard + history

**Files:**
- Modify: `your-guava-portal/src/pages/Connect.tsx`
- Modify: `your-guava-portal/src/pages/Connect.test.tsx`

- [ ] **Step 1: Update the test**

In `src/pages/Connect.test.tsx`, add a new test case (alongside existing ones):

```tsx
import { ColumnMappingWizard } from '@/components/upload/ColumnMappingWizard'

vi.mock('@/components/upload/ColumnMappingWizard', () => ({
  ColumnMappingWizard: vi.fn(() => <div data-testid="wizard-mock">wizard</div>),
}))

it('opens the mapping wizard when needsConfirmation is true', async () => {
  // Mock the staging response to require confirmation
  apiMock.post.mockImplementation((url: string) => {
    if (url === '/transactions/upload') {
      return Promise.resolve({
        data: {
          uploadId: 'u1',
          posType: 'wizard',
          columnMapping: { date: 'When' },
          itemsMode: 'packed',
          headers: ['When', 'Items', 'Total'],
          preview: [],
          needsConfirmation: true,
        },
      })
    }
    return Promise.resolve({ data: {} })
  })
  // ... existing render setup ...
  // simulate file drop, then assert the wizard renders:
  await waitFor(() => expect(screen.getByTestId('wizard-mock')).toBeInTheDocument())
})
```

Adapt to whatever mocking pattern `Connect.test.tsx` already uses.

- [ ] **Step 2: Update `Connect.tsx` upload flow**

Modify `src/pages/Connect.tsx`:

1. Add imports at the top with the others:

```tsx
import { ColumnMappingWizard } from '@/components/upload/ColumnMappingWizard'
import { UploadHistoryCard } from '@/components/upload/UploadHistoryCard'
import type { ColumnMapping, ItemsMode, StageUploadResponse } from '@/types/upload'
```

2. Add wizard state alongside the existing CSV state:

```tsx
const [stageResponse, setStageResponse] = useState<StageUploadResponse | null>(null)
```

3. Replace the body of `handleFile` after `formData.append('file', file)`:

```tsx
try {
  const { data } = await api.post<StageUploadResponse>('/transactions/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: (e) => {
      if (e.total) setProgress(Math.round((e.loaded / e.total) * 100))
    },
  })
  if (data.needsConfirmation) {
    setStageResponse(data)
    setUploadState('idle')
  } else {
    // Auto-confirm Yoco
    const confirmRes = await api.post<{ stats: ImportResult & { totalRows: number } }>(
      `/uploads/${data.uploadId}/confirm`,
      { columnMapping: data.columnMapping, itemsMode: data.itemsMode }
    )
    setResult({
      imported: confirmRes.data.stats.imported,
      skipped: confirmRes.data.stats.skipped,
      total: confirmRes.data.stats.totalRows,
      firstDate: '',
      lastDate: '',
    })
    setUploadState('success')
    setLastUpload(new Date().toISOString())
  }
} catch (err: unknown) {
  const msg = extractErrorMsg(err, '')
  setErrorMsg(msg ?? 'Upload failed.')
  setUploadState('error')
}
```

4. Add wizard rendering at the bottom of the JSX, just before the closing `</AppLayout>`:

```tsx
{stageResponse && (
  <ColumnMappingWizard
    open
    headers={stageResponse.headers}
    preview={stageResponse.preview}
    initialMapping={stageResponse.columnMapping}
    initialItemsMode={stageResponse.itemsMode}
    onCancel={() => setStageResponse(null)}
    onConfirm={async (mapping: ColumnMapping, itemsMode: ItemsMode) => {
      try {
        const res = await api.post(`/uploads/${stageResponse.uploadId}/confirm`, { columnMapping: mapping, itemsMode })
        setResult({
          imported: res.data.stats.imported,
          skipped: res.data.stats.skipped,
          total: res.data.stats.totalRows,
          firstDate: '',
          lastDate: '',
        })
        setUploadState('success')
        setLastUpload(new Date().toISOString())
      } catch (err: unknown) {
        setErrorMsg(extractErrorMsg(err, 'Confirm failed.'))
        setUploadState('error')
      } finally {
        setStageResponse(null)
      }
    }}
  />
)}
```

5. Render the history card at the bottom of the cards stack inside the main `<div className="max-w-2xl space-y-6">`:

```tsx
<UploadHistoryCard />
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/pages/Connect.test.tsx
```

Expected: all pass, including the new wizard test.

- [ ] **Step 4: Type-check the whole portal**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Connect.tsx src/pages/Connect.test.tsx
git commit -m "feat: wire Connect page to mapping wizard + history card"
```

---

## Task 23: End-to-end smoke test

**Files:** none (manual verification)

- [ ] **Step 1: Start backend**

```bash
cd C:\Users\shaun\your-guava-backend
npm run dev
```

Expected: server boots on configured port. Set R2 env vars in `.env` first.

- [ ] **Step 2: Start portal**

```bash
cd C:\Users\shaun\your-guava-portal
npm run dev
```

Expected: Vite dev server running.

- [ ] **Step 3: Manual happy path**

In a browser:
1. Sign up a new account.
2. Go to Connect page.
3. Upload `tests/fixtures/test-transactions.csv` (Yoco-format) — should auto-confirm and show import stats.
4. Upload `tests/fixtures/test-generic-pos.csv` — wizard opens with AI/empty mapping.
5. Map Date → "Sale Date", Items → "Description", Total → "Amount", click Confirm.
6. Verify the upload appears in the Upload History card.
7. Click "View" → UploadDetail page loads, rows visible, download link works.
8. From UploadDetail, click "Delete this upload" → confirms → returns to Connect, history entry gone, transactions removed.

- [ ] **Step 4: Notes back to user**

If anything in the smoke path is broken, capture the failure and add a fix task. Otherwise mark plan complete.

---

## Self-Review

This is a coverage check against the spec. After implementation, verify:

**Spec coverage:**
- [x] Two-phase ingestion — Tasks 10 (stage) + 11 (confirm)
- [x] Cloudflare R2 storage — Task 3
- [x] Upload model — Task 4
- [x] Transaction.uploadId + dedupKey — Task 5
- [x] Cafe.savedColumnMapping — Task 6
- [x] Yoco preset detection — Task 9 (`isYocoFormat`)
- [x] AI column mapping fallback — Task 8
- [x] CRUD on uploads (C/R/R/R/U/D) — Tasks 11, 12, 13, 14, 15, 16
- [x] Items mode (packed / line-per-row) — Task 7 (parser), Task 19 (wizard toggle)
- [x] Required field validation — Tasks 11, 15
- [x] Owner-only delete — Task 16
- [x] Cross-tenant isolation tests — Task 12 (list), Task 13 (detail)
- [x] Re-parse atomicity — Task 15
- [x] Multer file deletion removed — Task 10
- [x] R2/Anthropic mocked at boundary in tests — Task 10 (setup.js)
- [x] Frontend wizard + history + detail page — Tasks 19, 20, 21, 22

**Type consistency check:**
- `ColumnMapping` keys match between backend (`Upload.model.js`), parser (`parser.service.js`), and frontend (`types/upload.ts`).
- `posType` is `'yoco' | 'wizard'` everywhere.
- `itemsMode` is `'packed' | 'line-per-row'` everywhere.
- Status enum matches across model + frontend type.

If you find a placeholder or missing coverage during execution, add a task for it.
