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
 * Persistence-only half of ingestion: takes an already-parsed result object and
 * writes transactions + item upserts to the database. Does NOT touch R2 or the
 * file system. Safe to call after a successful parseBuffer call.
 *
 * @param {object} parsed  — the object returned by parseBuffer
 * @param {object} opts
 * @param {string} opts.cafeId
 * @param {string} opts.uploadId
 * @returns {Promise<{imported: number, skipped: number, errors: number, totalRows: number, dateRange: object}>}
 */
const persistParsedRows = async (parsed, { cafeId, uploadId }) => {
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
  parseYocoCSV,
};
