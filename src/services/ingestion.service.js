const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { Readable } = require('stream');
const Transaction = require('../models/Transaction.model');
const {
  parseBuffer,
  normaliseHeader,
  normaliseCell,
  normaliseRow,
  detectCsvSeparator,
  readWorkbookRows,
  readWorkbook,
  assertSupportedFileBuffer,
  parserLimits,
  zonedDateKey,
  safeTimezone,
} = require('./parser.service');
const { computeDedupKey } = require('../utils/dedupKey');
const {
  rebuildItemsForCafe,
  reconcileTransactionItems,
} = require('./menuItems.service');

const YOCO_HEADERS = [
  'Receipt', 'Date', 'Time', 'Status', 'Payment Method', 'Order Number',
  'Card Reader', 'Items', 'Note', 'Currency', 'Tip', 'Discount', 'VAT',
  'Total (incl. tax)', 'Fee Amount', 'Net Amount',
];
const MAX_ROW_ERRORS = 50;

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
const previewWorkbook = async (buffer) => {
  assertSupportedFileBuffer(buffer, 'xlsx');
  // Take the sheet's own header row rather than the keys of the first data row,
  // so an export covering a quiet period still reports its columns instead of
  // looking like a file whose headers could not be read.
  const { headers, rows } = await readWorkbook(buffer);
  return { headers, sampleRows: rows.slice(0, 5) };
};

const extractHeaders = async (buffer, fileExt = 'csv') => {
  assertSupportedFileBuffer(buffer, fileExt);
  if (fileExt === 'xlsx') {
    return (await previewWorkbook(buffer)).headers;
  }
  if (fileExt === 'xls') {
    throw new Error('Legacy XLS files are not supported. Please export as CSV or XLSX.');
  }
  return new Promise((resolve, reject) => {
    let captured = false;
    const stream = Readable.from(buffer).pipe(csv({
      separator: detectCsvSeparator(buffer),
      mapHeaders: ({ header, index }) => normaliseHeader(header, index),
      mapValues: ({ value }) => normaliseCell(value),
    }));
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
const previewBuffer = async (buffer, fileExt = 'csv') => {
  assertSupportedFileBuffer(buffer, fileExt);
  if (fileExt === 'xlsx') {
    return previewWorkbook(buffer);
  }
  if (fileExt === 'xls') {
    throw new Error('Legacy XLS files are not supported. Please export as CSV or XLSX.');
  }
  return new Promise((resolve, reject) => {
    const limits = parserLimits();
    const rows = [];
    let headers = [];
    let settled = false;
    const input = Readable.from(buffer);
    const parserStream = csv({
        separator: detectCsvSeparator(buffer),
        mapHeaders: ({ header, index }) => normaliseHeader(header, index),
        mapValues: ({ value }) => normaliseCell(value),
      });
    input
      .pipe(parserStream)
      .on('headers', (h) => {
        if (h.length > limits.maxColumns) {
          parserStream.destroy(new Error(`File exceeds the ${limits.maxColumns} column limit`));
          return;
        }
        headers = h;
      })
      .on('data', (row) => {
        if (settled) return;
        if (rows.length < 5) rows.push(normaliseRow(row));
        if (rows.length === 5) {
          settled = true;
          resolve({ headers, sampleRows: rows });
          parserStream.destroy();
        }
      })
      .on('error', (error) => {
        if (settled) return;
        settled = true;
        if (!error.statusCode) error.statusCode = 400;
        reject(error);
      })
      .on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ headers, sampleRows: rows });
      });
  });
};

const cloneRowErrors = (rowErrors) =>
  Array.isArray(rowErrors) ? rowErrors.slice(0, MAX_ROW_ERRORS) : [];

const addPersistenceRowError = (rowErrors, row, reason) => {
  if (rowErrors.length >= MAX_ROW_ERRORS) return;
  const sourceRows = row?.__sourceRowNumbers;
  rowErrors.push({
    rowNumber: Array.isArray(sourceRows) ? sourceRows[0] : undefined,
    reason,
  });
};

/**
 * Identity used to recognise a transaction we already hold.
 *
 * A receipt number is only unique within a trading day on tills that restart
 * their numbering each morning, which is common. Scoping the identity by the
 * cafe-local day keeps re-uploads idempotent -- the same file yields the same
 * receipt on the same day -- while letting "#0001" on Tuesday and "#0001" on
 * Wednesday be recognised as the two different sales they are.
 */
const transactionIdentity = (row, sourceFingerprint) => {
  if (row.receiptId) {
    const dayKey = row.dateKey || row.date.toISOString().slice(0, 10);
    return { type: 'receiptId', value: row.receiptId, dayKey };
  }
  return {
    type: 'dedupKey',
    value: computeDedupKey({
      date: row.date.toISOString().slice(0, 10),
      time: row.date.toISOString().slice(11, 16),
      total: row.total,
      items: row.items,
      sourceFingerprint,
      sourceRowNumbers: row.__sourceRowNumbers,
    }),
  };
};

const transactionDocument = (row, { cafeId, uploadId, identity }) => ({
  cafeId,
  uploadId,
  receiptId: identity.type === 'receiptId' ? identity.value : undefined,
  dedupKey: identity.type === 'dedupKey' ? identity.value : undefined,
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

const chunksOf = (values, size = 500) => {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

/** Receipt identities compare on the receipt AND its trading day; others on value alone. */
const identityComparisonKey = (identity) =>
  identity.type === 'receiptId'
    ? `receiptId:${identity.value}|${identity.dayKey}`
    : `${identity.type}:${identity.value}`;

const findExistingIdentities = async (cafeId, candidates, session, timezone) => {
  const existing = new Set();
  const zone = safeTimezone(timezone);
  const receiptIds = [...new Set(
    candidates.filter((candidate) => candidate.identity.type === 'receiptId')
      .map((candidate) => candidate.identity.value)
  )];
  const dedupKeys = [...new Set(
    candidates.filter((candidate) => candidate.identity.type === 'dedupKey')
      .map((candidate) => candidate.identity.value)
  )];

  const queries = [
    ...chunksOf(receiptIds).map((chunk) => ({ receiptId: { $in: chunk } })),
    ...chunksOf(dedupKeys).map((chunk) => ({ dedupKey: { $in: chunk } })),
  ];
  for (const identityQuery of queries) {
    let query = Transaction.find({ cafeId, ...identityQuery }).select('receiptId dedupKey date');
    if (session) query = query.session(session);
    const rows = await query.lean();
    for (const row of rows) {
      // Stored rows keep only the instant, so the trading day is recomputed in
      // the cafe's timezone rather than read off a UTC date.
      if (row.receiptId) {
        existing.add(`receiptId:${row.receiptId}|${zonedDateKey(row.date, zone)}`);
      }
      if (row.dedupKey) existing.add(`dedupKey:${row.dedupKey}`);
    }
  }
  return existing;
};

const reconcileParsedRows = async (parsed, { cafeId, session }) => {
  const reconciledCache = new Map();
  for (const row of parsed.rows) {
    if ((row.status || 'approved').toLowerCase() !== 'approved') continue;
    const cacheKey = JSON.stringify(row.items || []);
    let reconciled = reconciledCache.get(cacheKey);
    if (!reconciled) {
      reconciled = await reconcileTransactionItems(cafeId, row.items, { session });
      reconciledCache.set(cacheKey, reconciled);
    }
    row.items = reconciled.map((item) => ({ ...item }));
  }
  return parsed;
};

const persistParsedRowsBulk = async (
  parsed,
  { cafeId, uploadId, session, itemsAlreadyReconciled = false, sourceFingerprint, timezone }
) => {
  let skipped = 0;
  let errors = parsed.errors;
  const rowErrors = cloneRowErrors(parsed.rowErrors);
  let approvedRows = 0;
  let declinedRows = 0;
  let duplicateRows = 0;
  const candidates = [];
  const seen = new Set();

  for (const row of parsed.rows) {
    const status = (row.status || 'approved').toLowerCase();
    if (status !== 'approved') {
      skipped++;
      declinedRows++;
      continue;
    }
    approvedRows++;
    try {
      if (!itemsAlreadyReconciled) {
        row.items = await reconcileTransactionItems(cafeId, row.items, { session });
      }
      const identity = transactionIdentity(row, sourceFingerprint);
      const identityKey = identityComparisonKey(identity);
      if (seen.has(identityKey)) {
        skipped++;
        duplicateRows++;
        continue;
      }
      seen.add(identityKey);
      candidates.push({ row, identity, identityKey });
    } catch (error) {
      errors++;
      addPersistenceRowError(rowErrors, row, 'Could not reconcile row items');
      throw error;
    }
  }

  const existing = await findExistingIdentities(cafeId, candidates, session, timezone);
  const importable = candidates.filter((candidate) => {
    if (!existing.has(candidate.identityKey)) return true;
    skipped++;
    duplicateRows++;
    return false;
  });

  const documents = importable.map(({ row, identity }) =>
    transactionDocument(row, { cafeId, uploadId, identity })
  );
  if (documents.length > 0) {
    await Transaction.insertMany(documents, { ordered: true, ...(session ? { session } : {}) });
  }

  return {
    imported: documents.length,
    skipped,
    errors,
    rowErrors,
    totalRows: parsed.totalRows,
    approvedRows,
    declinedRows,
    duplicateRows,
    dateRange: parsed.dateRange,
  };
};

/**
 * Persistence-only half of ingestion: takes an already-parsed result object and
 * writes transactions + item upserts to the database. Does NOT touch R2 or the
 * file system. Safe to call after a successful parseBuffer call.
 *
 * @param {object} parsed  — the object returned by parseBuffer
 * @param {object} opts
 * @param {string} opts.cafeId
 * @param {string} opts.uploadId
 * @returns {Promise<{imported: number, skipped: number, errors: number, rowErrors: object[], totalRows: number, dateRange: object}>}
 */
const persistParsedRows = async (
  parsed,
  {
    cafeId,
    uploadId,
    session,
    bulk = false,
    itemsAlreadyReconciled = false,
    rebuildItems = true,
    failOnPersistenceError = false,
    sourceFingerprint,
    timezone,
  }
) => {
  if (bulk) {
    const result = await persistParsedRowsBulk(parsed, {
      cafeId,
      uploadId,
      session,
      itemsAlreadyReconciled,
      sourceFingerprint,
      timezone,
    });
    if (rebuildItems) await rebuildItemsForCafe(cafeId, { session });
    return result;
  }

  let imported = 0;
  let skipped = 0;
  let errors = parsed.errors;
  const rowErrors = cloneRowErrors(parsed.rowErrors);
  let approvedRows = 0;
  let declinedRows = 0;
  let duplicateRows = 0;

  for (const row of parsed.rows) {
    try {
      const status = (row.status || 'approved').toLowerCase();
      if (status !== 'approved') {
        skipped++;
        declinedRows++;
        continue;
      }
      approvedRows++;

      const dedupKey = row.receiptId ? undefined : computeDedupKey({
        date: row.date.toISOString().slice(0, 10),
        time: row.date.toISOString().slice(11, 16),
        total: row.total,
        items: row.items,
        sourceFingerprint,
        sourceRowNumbers: row.__sourceRowNumbers,
      });

      const filter = row.receiptId
        ? { cafeId, receiptId: row.receiptId }
        : { cafeId, dedupKey };

      let existingQuery = Transaction.findOne(filter);
      if (session) existingQuery = existingQuery.session(session);
      const existing = await existingQuery.lean();
      if (existing) {
        skipped++;
        duplicateRows++;
        continue;
      }

      const reconciledItems = itemsAlreadyReconciled
        ? row.items
        : await reconcileTransactionItems(cafeId, row.items, { session });

      const document = {
        cafeId,
        uploadId,
        receiptId: row.receiptId,
        dedupKey,
        date: row.date,
        hour: row.hour,
        dayOfWeek: row.dayOfWeek,
        status: 'approved',
        paymentMethod: row.paymentMethod,
        items: reconciledItems,
        total: row.total,
        tip: row.tip,
        discount: row.discount,
        source: 'csv',
      };
      if (session) await Transaction.create([document], { session });
      else await Transaction.create(document);
      imported++;
    } catch (err) {
      if (err.code === 11000) {
        skipped++;
        duplicateRows++;
      } else {
        if (failOnPersistenceError) throw err;
        console.error('[ingestion] row error:', err.message);
        errors++;
        addPersistenceRowError(rowErrors, row, 'Could not save row');
      }
    }
  }

  if (rebuildItems) await rebuildItemsForCafe(cafeId, { session });

  return {
    imported,
    skipped,
    errors,
    rowErrors,
    totalRows: parsed.totalRows,
    approvedRows,
    declinedRows,
    duplicateRows,
    dateRange: parsed.dateRange,
  };
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
const ingestParsedRows = async (
  buffer,
  {
    cafeId,
    uploadId,
    columnMapping,
    itemsMode,
    fileExt = 'csv',
    timezone,
    sourceFingerprint,
  }
) => {
  const parsed = await parseBuffer(buffer, { columnMapping, itemsMode, fileExt, timezone });
  return persistParsedRows(parsed, { cafeId, uploadId, sourceFingerprint, timezone });
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

// Backward-compat alias — unit tests written before the refactor still call this
const parseYocoCSV = ingestFile;

module.exports = {
  ingestFile,
  ingestParsedRows,
  persistParsedRows,
  reconcileParsedRows,
  isYocoFormat,
  yocoMapping,
  extractHeaders,
  previewBuffer,
  rebuildItemsForCafe,
  parseYocoCSV,
};
