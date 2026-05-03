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

const parseTimeParts = (timeStr) => {
  if (!timeStr) return null;
  if (timeStr instanceof Date) {
    return {
      hours: timeStr.getHours(),
      minutes: timeStr.getMinutes(),
      seconds: timeStr.getSeconds(),
    };
  }
  if (typeof timeStr === 'number') {
    const totalSeconds = Math.round(timeStr * 24 * 60 * 60);
    return {
      hours: Math.floor(totalSeconds / 3600) % 24,
      minutes: Math.floor((totalSeconds % 3600) / 60),
      seconds: totalSeconds % 60,
    };
  }
  const match = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  return {
    hours: parseInt(match[1], 10),
    minutes: parseInt(match[2], 10),
    seconds: parseInt(match[3] || '0', 10),
  };
};

const parseDate = (dateStr, timeStr) => {
  if (!dateStr) return null;
  if (dateStr instanceof Date) {
    const date = new Date(dateStr);
    const time = parseTimeParts(timeStr);
    if (time) date.setHours(time.hours, time.minutes, time.seconds, 0);
    return isNaN(date.getTime()) ? null : date;
  }
  if (typeof dateStr === 'number') {
    const parsedSerial = XLSX.SSF.parse_date_code(dateStr);
    if (parsedSerial) {
      const date = new Date(parsedSerial.y, parsedSerial.m - 1, parsedSerial.d);
      const time = parseTimeParts(timeStr);
      if (time) date.setHours(time.hours, time.minutes, time.seconds, 0);
      return isNaN(date.getTime()) ? null : date;
    }
  }
  const normalised = String(dateStr).replace(/\//g, '-').trim();
  const time = parseTimeParts(timeStr);
  const dt = time
    ? `${normalised}T${String(time.hours).padStart(2, '0')}:${String(time.minutes).padStart(2, '0')}:${String(time.seconds).padStart(2, '0')}`
    : normalised;
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
  const rows = [...groups.values()].map((row) => {
    const totalQty = row.items.reduce((sum, item) => sum + item.quantity, 0);
    const unitPrice = totalQty > 0 ? parseFloat((row.total / totalQty).toFixed(2)) : 0;
    return {
      ...row,
      items: row.items.map((item) => ({ ...item, unitPrice })),
    };
  });
  return { rows, errors };
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
