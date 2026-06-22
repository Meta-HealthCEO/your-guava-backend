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
  const rows = await readWorkbookRows(buffer);
  const headers = rows[0] ? Object.keys(rows[0]) : [];
  return { headers, sampleRows: rows.slice(0, 5) };
};

const extractHeaders = async (buffer, fileExt = 'csv') => {
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
  if (fileExt === 'xlsx') {
    return previewWorkbook(buffer);
  }
  if (fileExt === 'xls') {
    throw new Error('Legacy XLS files are not supported. Please export as CSV or XLSX.');
  }
  return new Promise((resolve, reject) => {
    const rows = [];
    let headers = [];
    Readable.from(buffer)
      .pipe(csv({
        separator: detectCsvSeparator(buffer),
        mapHeaders: ({ header, index }) => normaliseHeader(header, index),
        mapValues: ({ value }) => normaliseCell(value),
      }))
      .on('headers', (h) => { headers = h; })
      .on('data', (row) => {
        if (rows.length < 5) rows.push(normaliseRow(row));
      })
      .on('error', reject)
      .on('end', () => resolve({ headers, sampleRows: rows }));
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
const persistParsedRows = async (parsed, { cafeId, uploadId }) => {
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
      });

      const filter = row.receiptId
        ? { cafeId, receiptId: row.receiptId }
        : { cafeId, dedupKey };

      const existing = await Transaction.findOne(filter).lean();
      if (existing) {
        skipped++;
        duplicateRows++;
        continue;
      }

      const reconciledItems = await reconcileTransactionItems(cafeId, row.items);

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
        items: reconciledItems,
        total: row.total,
        tip: row.tip,
        discount: row.discount,
        source: 'csv',
      });
      imported++;
    } catch (err) {
      if (err.code === 11000) {
        skipped++;
        duplicateRows++;
      } else {
        console.error('[ingestion] row error:', err.message);
        errors++;
        addPersistenceRowError(rowErrors, row, 'Could not save row');
      }
    }
  }

  await rebuildItemsForCafe(cafeId);

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
const ingestParsedRows = async (buffer, { cafeId, uploadId, columnMapping, itemsMode, fileExt = 'csv' }) => {
  const parsed = await parseBuffer(buffer, { columnMapping, itemsMode, fileExt });
  return persistParsedRows(parsed, { cafeId, uploadId });
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
  isYocoFormat,
  yocoMapping,
  extractHeaders,
  previewBuffer,
  rebuildItemsForCafe,
  parseYocoCSV,
};
