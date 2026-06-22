const csv = require('csv-parser');
const { Readable } = require('stream');
const readXlsxFile = require('read-excel-file/node');

const REQUIRED_FIELDS = ['date', 'items', 'total'];
const UNNAMED_COLUMN_RE = /^_(\d+)$/;
const VALID_ITEMS_MODES = new Set(['packed', 'line-per-row']);
const SOURCE_ROW_NUMBERS = '__sourceRowNumbers';
const MAX_ROW_ERRORS = 50;
const MAX_ROW_ERROR_COLUMNS = 12;
const MAX_ROW_ERROR_VALUE_LENGTH = 160;

const requiredFieldsForMode = (itemsMode = 'packed') =>
  itemsMode === 'line-per-row'
    ? [...REQUIRED_FIELDS, 'receiptId']
    : REQUIRED_FIELDS;

const normaliseHeader = (header, index = 0) => {
  const value = String(header ?? '').replace(/^\uFEFF/, '').trim();
  return value || `Column ${index + 1}`;
};

const normaliseCell = (value) => (typeof value === 'string' ? value.trim() : value);

const normaliseRow = (row) => {
  const normalised = {};
  Object.entries(row || {}).forEach(([key, value], index) => {
    const normalisedKey = UNNAMED_COLUMN_RE.test(key) ? key : normaliseHeader(key, index);
    normalised[normalisedKey] = normaliseCell(value);
  });
  if (row?.[SOURCE_ROW_NUMBERS]) {
    Object.defineProperty(normalised, SOURCE_ROW_NUMBERS, {
      value: row[SOURCE_ROW_NUMBERS],
      enumerable: false,
      configurable: true,
    });
  }
  return normalised;
};

const normaliseRows = (rows) => rows.map(normaliseRow);

const excelSerialDateToDate = (serial) => {
  if (!Number.isFinite(serial) || serial <= 0) return null;

  const wholeDays = Math.floor(serial);
  const dayFraction = serial - wholeDays;
  const epoch = Date.UTC(1899, 11, 30);
  const date = new Date(epoch + wholeDays * 86400000 + Math.round(dayFraction * 86400000));

  return new Date(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds()
  );
};

const readWorkbookRows = async (buffer) => {
  const matrix = await readXlsxFile(buffer);
  if (!matrix.length) return [];

  const [headerRow, ...dataRows] = matrix;
  const headers = headerRow.map((header, index) => normaliseHeader(header, index));

  return dataRows
    .map((row, index) => ({ row, rowNumber: index + 2 }))
    .filter(({ row }) => row.some((value) => value != null && String(value).trim() !== ''))
    .map(({ row, rowNumber }) => {
      const mapped = {};
      headers.forEach((header, index) => {
        mapped[header] = normaliseCell(row[index] ?? '');
      });
      Object.defineProperty(mapped, SOURCE_ROW_NUMBERS, {
        value: [rowNumber],
        enumerable: false,
        configurable: true,
      });
      return mapped;
    });
};

const detectCsvSeparator = (buffer) => {
  const firstLine = Buffer.isBuffer(buffer)
    ? buffer.toString('utf8', 0, Math.min(buffer.length, 4096)).split(/\r?\n/)[0] || ''
    : '';
  const semicolons = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return semicolons > commas ? ';' : ',';
};

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
    if (name && quantity > 0) items.push({ name, quantity });
  }
  if (items.length > 0) return items;

  return String(str)
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const loose = part.match(/^(\d+)\s*x?\s+(.+)$/i);
      if (loose) {
        const quantity = parseInt(loose[1], 10);
        return { name: loose[2].trim(), quantity: quantity > 0 ? quantity : null };
      }
      return { name: part, quantity: 1 };
    })
    .filter((item) => item.name && item.quantity > 0);
};

const cleanNumber = (raw) => {
  if (raw == null || raw === '') return 0;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;

  let value = String(raw).trim();
  const parenthesisedNegative = /^\(.*\)$/.test(value);
  value = value
    .replace(/[()]/g, '')
    .replace(/\s+/g, '')
    .replace(/[^\d,.-]/g, '');

  if (!value || value === '-' || value === '.' || value === ',') return 0;

  const lastComma = value.lastIndexOf(',');
  const lastDot = value.lastIndexOf('.');

  if (lastComma >= 0 && lastDot >= 0) {
    value = lastComma > lastDot
      ? value.replace(/\./g, '').replace(',', '.')
      : value.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const commaCount = (value.match(/,/g) || []).length;
    const decimalDigits = value.length - lastComma - 1;
    value = commaCount === 1 && decimalDigits > 0 && decimalDigits <= 2
      ? value.replace(',', '.')
      : value.replace(/,/g, '');
  }

  value = value.replace(/(?!^)-/g, '');
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) return 0;
  return parenthesisedNegative ? -Math.abs(parsed) : parsed;
};

const parseQuantity = (raw) => {
  const quantity = Math.trunc(cleanNumber(raw));
  return Number.isFinite(quantity) && quantity > 0 ? quantity : null;
};

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

    if (raw?.[SOURCE_ROW_NUMBERS]) {
      Object.defineProperty(repaired, SOURCE_ROW_NUMBERS, {
        value: raw[SOURCE_ROW_NUMBERS],
        enumerable: false,
        configurable: true,
      });
    }

    return repaired;
  });

const readRows = (buffer, fileExt) => {
  if (fileExt === 'xlsx') {
    return readWorkbookRows(buffer);
  }
  if (fileExt === 'xls') {
    return Promise.reject(new Error('Legacy XLS files are not supported. Please export as CSV or XLSX.'));
  }
  return new Promise((resolve, reject) => {
    const rows = [];
    let rowNumber = 1;
    Readable.from(buffer)
      .pipe(csv({
        separator: detectCsvSeparator(buffer),
        mapHeaders: ({ header, index }) => normaliseHeader(header, index),
        mapValues: ({ value }) => normaliseCell(value),
      }))
      .on('data', (row) => {
        rowNumber += 1;
        Object.defineProperty(row, SOURCE_ROW_NUMBERS, {
          value: [rowNumber],
          enumerable: false,
          configurable: true,
        });
        rows.push(row);
      })
      .on('error', reject)
      .on('end', () => resolve(normaliseRows(rows)));
  });
};

const sourceRowNumber = (raw, fallbackIndex = 0) =>
  Array.isArray(raw?.[SOURCE_ROW_NUMBERS]) && raw[SOURCE_ROW_NUMBERS][0]
    ? raw[SOURCE_ROW_NUMBERS][0]
    : fallbackIndex + 2;

const setSourceRowNumbers = (row, rowNumbers) => {
  Object.defineProperty(row, SOURCE_ROW_NUMBERS, {
    value: [...rowNumbers],
    enumerable: false,
    configurable: true,
  });
  return row;
};

const serialiseRowErrorValue = (value) => {
  if (value instanceof Date) return value.toISOString();
  if (value == null) return '';

  const stringValue = typeof value === 'object'
    ? JSON.stringify(value)
    : String(value);

  return stringValue.length > MAX_ROW_ERROR_VALUE_LENGTH
    ? `${stringValue.slice(0, MAX_ROW_ERROR_VALUE_LENGTH)}...`
    : stringValue;
};

const serialiseRowErrorRaw = (raw) =>
  Object.fromEntries(
    Object.entries(raw || {})
      .slice(0, MAX_ROW_ERROR_COLUMNS)
      .map(([key, value]) => [key, serialiseRowErrorValue(value)])
  );

const addRowError = (rowErrors, rowNumber, reason, raw) => {
  if (rowErrors.length >= MAX_ROW_ERRORS) return;
  rowErrors.push({
    rowNumber,
    reason,
    raw: serialiseRowErrorRaw(raw),
  });
};

const validateMapping = (mapping, itemsMode = 'packed') => {
  const missing = requiredFieldsForMode(itemsMode).filter((f) => !mapping?.[f]);
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
    if (!Number.isFinite(timeStr)) return null;
    const dayFraction = ((timeStr % 1) + 1) % 1;
    const totalSeconds = Math.round(dayFraction * 24 * 60 * 60);
    return {
      hours: Math.floor(totalSeconds / 3600) % 24,
      minutes: Math.floor((totalSeconds % 3600) / 60),
      seconds: totalSeconds % 60,
    };
  }
  const match = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const parts = {
    hours: parseInt(match[1], 10),
    minutes: parseInt(match[2], 10),
    seconds: parseInt(match[3] || '0', 10),
  };
  if (
    parts.hours < 0 || parts.hours > 23 ||
    parts.minutes < 0 || parts.minutes > 59 ||
    parts.seconds < 0 || parts.seconds > 59
  ) {
    return null;
  }
  return parts;
};

const applyTimeParts = (date, timeStr) => {
  const hasExplicitTime = timeStr != null && String(timeStr).trim() !== '';
  if (!hasExplicitTime) return date;
  const time = parseTimeParts(timeStr);
  if (!time) return null;
  date.setHours(time.hours, time.minutes, time.seconds, 0);
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
    const withTime = applyTimeParts(date, timeStr);
    return !withTime || isNaN(withTime.getTime()) ? null : withTime;
  }
  if (typeof dateStr === 'number') {
    const date = excelSerialDateToDate(dateStr);
    if (date) {
      const withTime = applyTimeParts(date, timeStr);
      return !withTime || isNaN(withTime.getTime()) ? null : withTime;
    }
  }
  return parseDateString(dateStr, timeStr);
};

const buildPackedRow = (raw, mapping, rowNumber) => {
  const date = parseDate(raw[mapping.date], mapping.time && raw[mapping.time]);
  if (!date) return { error: 'Could not parse date or time' };
  const items = parsePackedItems(raw[mapping.items] || '');
  if (items.length === 0) return { error: 'Missing or invalid items' };
  const total = cleanNumber(raw[mapping.total]);
  const totalQty = items.reduce((s, i) => s + i.quantity, 0);
  if (totalQty <= 0) return { error: 'Invalid item quantity' };
  const unitPrice = totalQty > 0 ? total / totalQty : 0;
  const row = {
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
  return { row: setSourceRowNumbers(row, [rowNumber]) };
};

const groupLinePerRow = (rawRows, mapping) => {
  const groups = new Map();
  const rowErrors = [];
  let errors = 0;
  const totalsAreLineAmounts = /(^|\s)(line|item)(\s|$)/i.test(String(mapping.total || '').replace(/[_-]+/g, ' '));

  for (const [index, raw] of rawRows.entries()) {
    const rowNumber = sourceRowNumber(raw, index);
    try {
      const date = parseDate(raw[mapping.date], mapping.time && raw[mapping.time]);
      if (!date) {
        errors++;
        addRowError(rowErrors, rowNumber, 'Could not parse date or time', raw);
        continue;
      }
      const receiptId = String(raw[mapping.receiptId] || '').trim();
      if (!receiptId) {
        errors++;
        addRowError(rowErrors, rowNumber, 'Missing receipt ID', raw);
        continue;
      }
      const groupKey = receiptId;
      const itemName = String(raw[mapping.items] || '').trim();
      if (!itemName) {
        errors++;
        addRowError(rowErrors, rowNumber, 'Missing item name', raw);
        continue;
      }
      const quantity = mapping.quantity ? parseQuantity(raw[mapping.quantity]) : 1;
      if (!quantity) {
        errors++;
        addRowError(rowErrors, rowNumber, 'Invalid item quantity', raw);
        continue;
      }
      const total = cleanNumber(raw[mapping.total]);
      if (!groups.has(groupKey)) {
        groups.set(groupKey, setSourceRowNumbers({
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
        }, []));
      }
      const group = groups.get(groupKey);
      group[SOURCE_ROW_NUMBERS].push(rowNumber);
      group.items.push({ name: itemName, quantity, lineTotal: total });
      group.totals.push(total);
    } catch {
      errors++;
      addRowError(rowErrors, rowNumber, 'Could not parse row', raw);
    }
  }
  const rows = [...groups.values()].map((row) => {
    const totalQty = row.items.reduce((sum, item) => sum + item.quantity, 0);
    const uniqueTotals = [...new Set(row.totals.map((total) => Number(total.toFixed(2))))];
    const total = !totalsAreLineAmounts && uniqueTotals.length === 1
      ? uniqueTotals[0]
      : row.totals.reduce((sum, value) => sum + value, 0);
    const averageUnitPrice = totalQty > 0 ? parseFloat((total / totalQty).toFixed(2)) : 0;
    const { totals, ...cleanRow } = row;
    return setSourceRowNumbers({
      ...cleanRow,
      total,
      items: row.items.map(({ lineTotal, ...item }) => ({
        ...item,
        unitPrice: totalsAreLineAmounts && item.quantity > 0
          ? parseFloat((lineTotal / item.quantity).toFixed(2))
          : averageUnitPrice,
      })),
    }, row[SOURCE_ROW_NUMBERS] || []);
  });
  return { rows, errors, rowErrors };
};

/**
 * Parses a CSV/XLSX buffer using a column mapping.
 *
 * @param {Buffer} buffer
 * @param {object} opts
 * @param {object} opts.columnMapping
 * @param {'packed' | 'line-per-row'} opts.itemsMode
 * @param {string} [opts.fileExt='csv']
 * @returns {Promise<{rows: object[], errors: number, rowErrors: object[], totalRows: number, dateRange: {firstDate: Date, lastDate: Date}}>}
 */
const parseBuffer = async (buffer, { columnMapping, itemsMode = 'packed', fileExt = 'csv' }) => {
  if (!VALID_ITEMS_MODES.has(itemsMode)) {
    throw new Error(`Invalid itemsMode: ${itemsMode}`);
  }
  validateMapping(columnMapping, itemsMode);
  const rawRows = repairOverflowColumns(await readRows(buffer, fileExt), columnMapping);

  let rows;
  let errors = 0;
  let rowErrors = [];

  if (itemsMode === 'line-per-row') {
    const grouped = groupLinePerRow(rawRows, columnMapping);
    rows = grouped.rows;
    errors = grouped.errors;
    rowErrors = grouped.rowErrors;
  } else {
    rows = [];
    for (const [index, raw] of rawRows.entries()) {
      const rowNumber = sourceRowNumber(raw, index);
      try {
        const parsed = buildPackedRow(raw, columnMapping, rowNumber);
        if (parsed.row) {
          rows.push(parsed.row);
        } else {
          errors++;
          addRowError(rowErrors, rowNumber, parsed.error || 'Could not parse row', raw);
        }
      } catch {
        errors++;
        addRowError(rowErrors, rowNumber, 'Could not parse row', raw);
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
    rowErrors,
    totalRows: rawRows.length,
    dateRange: { firstDate, lastDate },
  };
};

module.exports = {
  parseBuffer,
  parsePackedItems,
  normaliseHeader,
  normaliseCell,
  normaliseRow,
  normaliseRows,
  detectCsvSeparator,
  readWorkbookRows,
  requiredFieldsForMode,
};
