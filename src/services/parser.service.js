const csv = require('csv-parser');
const { Readable } = require('stream');
const XLSX = require('xlsx');

const REQUIRED_FIELDS = ['date', 'items', 'total'];
const UNNAMED_COLUMN_RE = /^_(\d+)$/;

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
  if (items.length > 0) return items;

  return String(str)
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const loose = part.match(/^(\d+)\s*x?\s+(.+)$/i);
      if (loose) {
        return { name: loose[2].trim(), quantity: parseInt(loose[1], 10) || 1 };
      }
      return { name: part, quantity: 1 };
    })
    .filter((item) => item.name);
};

const cleanNumber = (raw) =>
  parseFloat(String(raw || 0).replace(/[^0-9.-]/g, '')) || 0;

const extraColumnIndex = (key) => {
  const match = String(key).match(UNNAMED_COLUMN_RE);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
};

const repairOverflowColumns = (rawRows, mapping) =>
  rawRows.map((raw) => {
    const keys = Object.keys(raw);
    const extraKeys = keys
      .filter((key) => UNNAMED_COLUMN_RE.test(key))
      .sort((a, b) => extraColumnIndex(a) - extraColumnIndex(b));

    if (!mapping.items || extraKeys.length === 0) return raw;

    const headers = keys.filter((key) => !UNNAMED_COLUMN_RE.test(key));
    const itemIndex = headers.indexOf(mapping.items);
    if (itemIndex < 0) return raw;

    const values = [...headers, ...extraKeys].map((key) => raw[key]);
    const overflow = values.length - headers.length;
    if (overflow <= 0) return raw;

    const repaired = {};
    for (let index = 0; index < headers.length; index++) {
      const header = headers[index];
      if (index < itemIndex) {
        repaired[header] = values[index];
      } else if (index === itemIndex) {
        repaired[header] = values
          .slice(index, index + overflow + 1)
          .filter((value) => String(value || '').trim() !== '')
          .join(', ');
      } else {
        repaired[header] = values[index + overflow];
      }
    }

    return repaired;
  });

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

const applyTimeParts = (date, timeStr) => {
  const time = parseTimeParts(timeStr);
  if (time) date.setHours(time.hours, time.minutes, time.seconds, 0);
  return date;
};

const dateFromParts = (year, month, day, timeStr) => {
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return applyTimeParts(date, timeStr);
};

const parseDateString = (dateStr, timeStr) => {
  const value = String(dateStr).trim();

  let match = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) {
    return dateFromParts(
      parseInt(match[1], 10),
      parseInt(match[2], 10),
      parseInt(match[3], 10),
      timeStr
    );
  }

  match = value.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (match) {
    return dateFromParts(
      parseInt(match[3], 10),
      parseInt(match[2], 10),
      parseInt(match[1], 10),
      timeStr
    );
  }

  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return null;
  return applyTimeParts(parsed, timeStr);
};

const parseDate = (dateStr, timeStr) => {
  if (!dateStr) return null;
  if (dateStr instanceof Date) {
    const date = new Date(dateStr);
    applyTimeParts(date, timeStr);
    return isNaN(date.getTime()) ? null : date;
  }
  if (typeof dateStr === 'number') {
    const parsedSerial = XLSX.SSF.parse_date_code(dateStr);
    if (parsedSerial) {
      const date = new Date(parsedSerial.y, parsedSerial.m - 1, parsedSerial.d);
      applyTimeParts(date, timeStr);
      return isNaN(date.getTime()) ? null : date;
    }
  }
  return parseDateString(dateStr, timeStr);
};

const buildPackedRow = (raw, mapping) => {
  const date = parseDate(raw[mapping.date], mapping.time && raw[mapping.time]);
  if (!date) return null;
  const items = parsePackedItems(raw[mapping.items] || '');
  if (items.length === 0) return null;
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
          totals: [],
          tip: mapping.tip ? cleanNumber(raw[mapping.tip]) : 0,
          discount: mapping.discount ? cleanNumber(raw[mapping.discount]) : 0,
          paymentMethod: mapping.paymentMethod ? String(raw[mapping.paymentMethod] || '').trim() : undefined,
          status: mapping.status ? String(raw[mapping.status] || 'approved').trim().toLowerCase() : 'approved',
        });
      }
      const group = groups.get(groupKey);
      group.items.push({ name: itemName, quantity });
      group.totals.push(total);
    } catch {
      errors++;
    }
  }
  const rows = [...groups.values()].map((row) => {
    const totalQty = row.items.reduce((sum, item) => sum + item.quantity, 0);
    const uniqueTotals = [...new Set(row.totals.map((total) => Number(total.toFixed(2))))];
    const total = uniqueTotals.length === 1
      ? uniqueTotals[0]
      : row.totals.reduce((sum, value) => sum + value, 0);
    const unitPrice = totalQty > 0 ? parseFloat((total / totalQty).toFixed(2)) : 0;
    const { totals, ...cleanRow } = row;
    return {
      ...cleanRow,
      total,
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
  const rawRows = repairOverflowColumns(await readRows(buffer, fileExt), columnMapping);

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
