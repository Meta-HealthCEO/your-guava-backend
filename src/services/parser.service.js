const csv = require('csv-parser');
const { Readable } = require('stream');
const {
  DEFAULT_TIMEZONE, safeTimezone, zonedDateTimeToUtc, getZonedDateParts, zonedDayStart, zonedDayEnd,
  addZonedDays, zonedDayOrdinal, zonedDateKey, zonedDayOfWeek, processLocalCalendarDate,
} = require('../utils/timezone');
const { parserLimits, createClientInputError, tooManyColumnsError } = require('./parser/limits');
const { SOURCE_ROW_NUMBERS, sourceRowNumber, setSourceRowNumbers, addRowError } = require('./parser/rowErrors');
const { parseBoundedAmount, parseOptionalAmount } = require('./parser/numbers');
const {
  UNNAMED_COLUMN_RE, MAX_HEADER_CHARS, requiredFieldsForMode, normaliseHeader, headerDeduper, normaliseCell,
  normaliseRow, normaliseRows, validateMapping,
} = require('./parser/headers');
const { streamXlsxSharedStrings, streamXlsxSheetCells, xlsxPartTooLargeError } = require('./parser/xlsxStream');
const { assertSupportedFileBuffer } = require('./parser/fileType');
const { readWorkbook, readWorkbookRows } = require('./parser/xlsx');
const { parseDate, transactionDateError, temporalFields } = require('./parser/dates');
const { unitPriceSource, groupLinePerRow } = require('./parser/lineItems');

const VALID_ITEMS_MODES = new Set(['packed', 'line-per-row']);
// csv-parser's own wording for a line longer than maxRowBytes.
const CSV_ROW_TOO_LONG_MESSAGE = 'Row exceeds the maximum size';

/** The longest line any CSV reader buffers before refusing the file. */
const csvMaxRowBytes = (limits = parserLimits()) => limits.maxRowBytes;

/**
 * csv-parser reports an over-long line as a bare Error with no status, and
 * confirm passed it straight to the error middleware as a 500. Say what is
 * wrong and what to do; leave every other error as it was.
 */
const csvReadError = (error, limits = parserLimits()) => {
  if (error?.message !== CSV_ROW_TOO_LONG_MESSAGE) return error;
  const tooLong = createClientInputError(
    `A line in this file is longer than ${Math.round(limits.maxRowBytes / 1024)} KB. A sales export keeps each sale on `
    + 'its own short line, so this is usually one runaway cell or the wrong separator. Export the report again, or save '
    + 'it from Excel as "CSV UTF-8 (Comma delimited)", and upload that.'
  );
  tooLong.code = 'CSV_ROW_TOO_LONG';
  return tooLong;
};

// Ordered so ',' wins a tie, which is what an ambiguous file most often is.
const CSV_SEPARATOR_CANDIDATES = [',', ';', '\t', '|'];
const CSV_SEPARATOR_SAMPLE_LINES = 5;

/**
 * Picks the delimiter a CSV is really using.
 *
 * Only ';' was ever weighed against ',', so a tab- or pipe-delimited export --
 * "Text (Tab delimited)" is a standard Excel save-as, and several tills write
 * it with a .csv extension -- collapsed its entire header row into one column.
 * The owner was shown one nonsensical column and had no way forward.
 *
 * The winner is the candidate that appears on EVERY sampled line, scored by its
 * smallest per-line count: a real delimiter separates every row, while a comma
 * inside one quoted item cell shows up on one line only.
 */
/**
 * Excel writes `sep=;` as the first line of a CSV whenever the machine's list
 * separator is not a comma, which is the default on South African and most
 * European Windows installs. It is a directive to Excel, not data.
 *
 * Read as data it becomes the header row: production upload 6a3289a4 has
 * `headers: ["sep=", ""]` and imported nothing, and its owner was told "no
 * valid transaction rows could be imported with this mapping" beside a mapping
 * screen listing one nonsensical column.
 *
 * It matters beyond that one file. The fix we hand someone with a legacy .xls
 * is "Save As CSV UTF-8", so this is the very next thing that same owner
 * produces. Without this they walk out of one dead end into another.
 *
 * Only the first line counts, and only when the directive is the whole of it,
 * so a genuine column named `sep=x` stays a column.
 */
const SEP_DIRECTIVE_RE = /^﻿?sep=(\\t|.)[ \t]*$/i;

const csvSeparatorDirective = (buffer) => {
  if (!Buffer.isBuffer(buffer)) return null;
  const head = buffer.toString('utf8', 0, Math.min(buffer.length, 64));
  const firstLine = head.split(/\r?\n/)[0];
  const match = SEP_DIRECTIVE_RE.exec(firstLine || '');
  if (!match) return null;
  // `sep=\t` is written literally, two characters, not a tab byte.
  const separator = match[1] === '\\t' ? '\t' : match[1];
  return { separator, byteLength: Buffer.byteLength(firstLine, 'utf8') };
};

/** The buffer with any `sep=` directive line removed, ready to be parsed. */
const stripCsvSeparatorDirective = (buffer) => {
  const directive = csvSeparatorDirective(buffer);
  if (!directive) return buffer;
  let offset = directive.byteLength;
  if (buffer[offset] === 0x0d) offset += 1;
  if (buffer[offset] === 0x0a) offset += 1;
  return buffer.subarray(offset);
};

const detectCsvSeparator = (buffer) => {
  // The file declaring its own separator beats guessing from the shape of
  // the rows, which a one-column-per-row export gives nothing to score.
  const declared = csvSeparatorDirective(buffer);
  if (declared) return declared.separator;

  const lines = (Buffer.isBuffer(buffer)
    ? buffer.toString('utf8', 0, Math.min(buffer.length, 4096))
    : '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(0, CSV_SEPARATOR_SAMPLE_LINES);
  if (lines.length === 0) return ',';

  let best = ',';
  let bestScore = 0;
  for (const candidate of CSV_SEPARATOR_CANDIDATES) {
    const score = Math.min(...lines.map((line) => line.split(candidate).length - 1));
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
};

/**
 * The one way an uploaded CSV is read: the upload preview, the wizard's
 * headers and the import itself all come through here. The preview used to
 * have its own reader, and it drifted: it kept an Excel "sep=" line as its
 * header row (so the wizard had nothing to map) and showed a repeated "Total"
 * once, with one column's money, while the import read the other column.
 * Returns the csv-parser stream; the source is piped in already.
 */
const readCsvStream = (buffer, limits = parserLimits()) => {
  const dedupeHeader = headerDeduper();
  // Stripped before parsing; left in place the directive becomes the header
  // row and every real column disappears behind it.
  return Readable.from(stripCsvSeparatorDirective(buffer)).pipe(csv({
    separator: detectCsvSeparator(buffer),
    // csv-parser buffers a whole line before it splits it; without a cap one
    // line of separators became a row object with one key per separator.
    maxRowBytes: csvMaxRowBytes(limits),
    mapHeaders: ({ header, index }) => dedupeHeader(header, index),
    mapValues: ({ value }) => normaliseCell(value, limits),
  }));
};

// Quantities may be fractional: cafes selling by weight export rows like
// "0.35 x Cheese Wheel". Matching digits only made the engine skip past the
// "0." and read the decimal part as the whole quantity, turning 0.35 into 35.
// A comma decimal is the same trap wearing South African clothes -- "1,5 x
// Biltong" was read as five units, a 3.3x overstatement of the weight sold.
//
// The leading sign matters just as much. A till exports a refund as "-1 x Flat
// White"; without the sign the engine stepped over the minus and recorded a
// SALE of one, so a refund moved demand two units the wrong way and the stored
// row contradicted itself -- total -38 against quantity +1. The sign also has to
// appear in the separator lookahead, or "1 x Flat White,-1 x Flat White" is not
// recognised as two lines at all and collapses into one item whose name is the
// rest of the string.
const PACKED_QUANTITY = String.raw`-?\d+(?:[.,]\d+)?`;
// Plenty of tills print U+00D7 rather than an ASCII x, and some print a capital
// X. The sign used to stay glued to the item name, so "Flat White" and
// "× Flat White" were two different products splitting one history in half.
const PACKED_MARKER = String.raw`\s+[x×]\s+`;
// The name may not cross a newline, and a newline separates basket lines. A
// till that wraps its basket inside one quoted cell had only its LAST line
// read: `.` never matches a newline and `$` is end-of-string, so the earlier
// items vanished with no error and the survivor absorbed the whole basket
// total as an "exact" price.
// The packed grammar, `-?\d+(?:[.,]\d+)?\s+[x×]\s+NAME` repeated, where NAME
// runs to the first `,` `;` or newline that is followed by another quantity
// and marker, or to the end of the cell, and never crosses a newline. It used
// to be one global regex, `(QTY)MARKER([^\n]+?)(?:[,;\n](?=\s*QTY MARKER)|$)`,
// whose lazy NAME re-scanned to the next newline from every digit: a
// 10,000-character cell cost tens of millions of steps and an XLSX could repeat
// it on every row (parsing-2). This reads it in one pass with three precomputed
// look-up arrays, and returns exactly what that regex returned.
const CODE_NEWLINE = 10;
const CODE_COMMA = 44;
const CODE_MINUS = 45;
const CODE_DOT = 46;
const CODE_SEMICOLON = 59;
const MARKER_CODES = new Set([120, 88, 215]); // x, X, ×

const isDigitCode = (code) => code >= 48 && code <= 57;

// Exactly the code units JavaScript's \s matches.
const isJsWhitespace = (code) =>
  (code >= 9 && code <= 13) || code === 32 || code === 160 || code === 5760
  || (code >= 8192 && code <= 8202) || code === 8232 || code === 8233 || code === 8239
  || code === 8287 || code === 12288 || code === 65279;

// Reused between calls: parsePackedItems is synchronous and never re-entered,
// and four fresh arrays per 10,000-character cell were 160 KB of garbage per
// row, 1.6 GB across a 10,000-row file. Every slot in [0, n] is rewritten on
// each call, so nothing stale is ever read.
let packedScratch = new Int32Array(4 * 1024);

const buildPackedIndex = (text) => {
  const n = text.length;
  const size = n + 1;
  if (packedScratch.length < size * 4) packedScratch = new Int32Array(size * 4);
  const digitEnd = packedScratch.subarray(0, size); // first non-digit at or after i
  const spaceEnd = packedScratch.subarray(size, size * 2); // first non-whitespace at or after i
  const newlineAt = packedScratch.subarray(size * 2, size * 3); // first newline at or after i (n if none)
  const nextTerminator = packedScratch.subarray(size * 3, size * 4);
  digitEnd[n] = n;
  spaceEnd[n] = n;
  newlineAt[n] = n;
  for (let i = n - 1; i >= 0; i -= 1) {
    const code = text.charCodeAt(i);
    digitEnd[i] = isDigitCode(code) ? digitEnd[i + 1] : i;
    spaceEnd[i] = isJsWhitespace(code) ? spaceEnd[i + 1] : i;
    newlineAt[i] = code === CODE_NEWLINE ? i : newlineAt[i + 1];
  }
  return { n, digitEnd, spaceEnd, newlineAt, nextTerminator };
};

// Where `-?\d+(?:[.,]\d+)?\s+[x×]\s+` matches from `start`: the end of the
// quantity and the start of the name. Constant time with the index.
const packedHeadAt = (text, index, start) => {
  const { n, digitEnd, spaceEnd } = index;
  let cursor = start;
  if (cursor < n && text.charCodeAt(cursor) === CODE_MINUS) cursor += 1;
  if (cursor >= n || !isDigitCode(text.charCodeAt(cursor))) return null;
  cursor = digitEnd[cursor];
  const decimal = cursor < n ? text.charCodeAt(cursor) : -1;
  if ((decimal === CODE_DOT || decimal === CODE_COMMA) && cursor + 1 < n && isDigitCode(text.charCodeAt(cursor + 1))) {
    cursor = digitEnd[cursor + 1];
  }
  const qtyEnd = cursor;
  const markerAt = spaceEnd[qtyEnd];
  if (markerAt === qtyEnd || markerAt >= n || !MARKER_CODES.has(text.charCodeAt(markerAt))) return null;
  const nameStart = spaceEnd[markerAt + 1];
  if (nameStart === markerAt + 1) return null;
  return { qtyEnd, nameStart };
};

// nextTerminator[i]: the first position at or after i where a name may end:
// a separator followed by another quantity and marker, or the end of the cell.
const buildPackedTerminators = (text, index) => {
  const { n, spaceEnd, nextTerminator } = index;
  nextTerminator[n] = n;
  for (let i = n - 1; i >= 0; i -= 1) {
    const code = text.charCodeAt(i);
    const separator = code === CODE_COMMA || code === CODE_SEMICOLON || code === CODE_NEWLINE;
    nextTerminator[i] = separator && packedHeadAt(text, index, spaceEnd[i + 1]) ? i : nextTerminator[i + 1];
  }
  return nextTerminator;
};

const scanPackedItems = (text) => {
  const index = buildPackedIndex(text);
  const nextTerminator = buildPackedTerminators(text, index);
  const items = [];
  let start = 0;
  while (start < index.n) {
    const code = text.charCodeAt(start);
    const head = code === CODE_MINUS || isDigitCode(code) ? packedHeadAt(text, index, start) : null;
    if (head && head.nameStart < index.n) {
      const end = nextTerminator[head.nameStart + 1];
      // The name may not cross a newline; the newline can only be its terminator.
      if (end <= index.newlineAt[head.nameStart]) {
        const quantity = packedQuantity(text.slice(start, head.qtyEnd));
        const name = text.slice(head.nameStart, end).trim();
        if (name && quantity != null) items.push({ name, quantity });
        start = end < index.n ? end + 1 : index.n;
        continue;
      }
    }
    // Every later start inside this digit run reaches the same quantity end,
    // the same marker check and the same name start, so it fails the same way
    // (the regex's backtracked matches only ever produced whitespace-only
    // names, which were dropped): skip the run. A minus steps on by one.
    start = isDigitCode(code) ? index.digitEnd[start] : start + 1;
  }
  return items;
};
// The marker is mandatory here. With `x` optional, any description starting
// with a number was read as a quantity: "500 Still Water" became 500 units of
// "Still Water", and "2 Minute Noodles" two units of "Minute Noodles".
const LOOSE_PACKED_ITEM_RE = new RegExp(`^(${PACKED_QUANTITY})\\s*[x\\u00d7]\\s+(.+)$`, 'i');

const packedQuantity = (raw) => {
  const quantity = parseFloat(String(raw).replace(',', '.'));
  return Number.isFinite(quantity) && quantity !== 0 ? quantity : null;
};

/**
 * Parses Yoco-style "1 x Flat White,2 x Brownie" item strings.
 * @param {string} str
 * @returns {{name: string, quantity: number}[]}
 */
const parsePackedItems = (str) => {
  if (!str) return [];
  const items = scanPackedItems(String(str));
  if (items.length > 0) return items;

  return String(str)
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const loose = part.match(LOOSE_PACKED_ITEM_RE);
      if (loose) {
        return { name: loose[2].trim(), quantity: packedQuantity(loose[1]) };
      }
      // A part with no letters in it is a stray field the export left behind,
      // not a product. Emitting it created menu entries literally named "2".
      if (!/\p{L}/u.test(part)) return null;
      return { name: part, quantity: 1 };
    })
    .filter((item) => item && item.name && item.quantity != null && item.quantity !== 0);
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
  assertSupportedFileBuffer(buffer, fileExt);
  if (fileExt === 'xlsx') {
    return readWorkbookRows(buffer);
  }
  return new Promise((resolve, reject) => {
    const limits = parserLimits();
    const rows = [];
    let rowNumber = 1;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const parserStream = readCsvStream(buffer, limits);
    parserStream
      .on('headers', (headers) => {
        if (headers.length > limits.maxColumns) parserStream.destroy(tooManyColumnsError(limits));
      })
      .on('data', (row) => {
        if (settled) return;
        if (Object.keys(row).length > limits.maxColumns) {
          parserStream.destroy(tooManyColumnsError(limits));
          return;
        }
        if (rows.length >= limits.maxRows) {
          const error = createClientInputError(`File exceeds the ${limits.maxRows} row limit`);
          parserStream.destroy(error);
          return;
        }
        rowNumber += 1;
        Object.defineProperty(row, SOURCE_ROW_NUMBERS, {
          value: [rowNumber],
          enumerable: false,
          configurable: true,
        });
        rows.push(row);
      })
      .on('error', (error) => fail(csvReadError(error, limits)))
      .on('end', () => {
        if (settled) return;
        settled = true;
        resolve(normaliseRows(rows));
      });
  });
};

const buildPackedRow = (raw, mapping, rowNumber, timezone) => {
  const limits = parserLimits();
  const date = parseDate(raw[mapping.date], mapping.time && raw[mapping.time], timezone);
  if (!date) return { error: 'Could not parse date or time' };
  const dateError = transactionDateError(date, timezone);
  if (dateError) return { error: dateError };
  const items = parsePackedItems(raw[mapping.items] || '');
  if (items.length === 0) return { error: 'Missing or invalid items' };
  if (items.length > limits.maxItemsPerTransaction) {
    return { error: `Transaction exceeds the ${limits.maxItemsPerTransaction} item limit` };
  }
  if (items.some((item) => item.name.length > limits.maxItemNameChars)) {
    return { error: `Item name exceeds the ${limits.maxItemNameChars} character limit` };
  }
  // Quantities may legitimately be fractional -- a deli sells 0.35 of a cheese
  // wheel -- so require a finite non-zero number rather than a whole one, and
  // report the reason that actually applies instead of blaming the upper limit
  // for a sub-unit weight. Negative is legitimate too: it is a refund, and the
  // bound applies to how big the line is, not which way it points.
  const badQuantity = items.find((item) => !Number.isFinite(item.quantity) || item.quantity === 0
    || Math.abs(item.quantity) > limits.maxItemQuantity);
  if (badQuantity) {
    return {
      error: Math.abs(badQuantity.quantity) > limits.maxItemQuantity
        ? `Item quantity exceeds the ${limits.maxItemQuantity} limit`
        : 'Item quantity must be a non-zero number',
    };
  }
  const receiptId = mapping.receiptId ? String(raw[mapping.receiptId] || '').trim() : '';
  if (receiptId.length > limits.maxIdentifierChars) {
    return { error: `Receipt ID exceeds the ${limits.maxIdentifierChars} character limit` };
  }
  const paymentMethod = mapping.paymentMethod
    ? String(raw[mapping.paymentMethod] || '').trim()
    : '';
  if (paymentMethod.length > limits.maxIdentifierChars) {
    return { error: `Payment method exceeds the ${limits.maxIdentifierChars} character limit` };
  }
  const total = parseBoundedAmount(raw[mapping.total], limits);
  if (total === null) {
    return { error: `Invalid transaction total or amount exceeds ${limits.maxAbsoluteAmount}` };
  }
  const parsedTip = parseOptionalAmount(mapping.tip && raw[mapping.tip], 'Tip', limits);
  if (parsedTip.error) return { error: parsedTip.error };
  const parsedDiscount = parseOptionalAmount(
    mapping.discount && raw[mapping.discount],
    'Discount',
    limits
  );
  if (parsedDiscount.error) return { error: parsedDiscount.error };
  const tip = parsedTip.value;
  const discount = parsedDiscount.value;
  // Price is derived from magnitudes, not the signed sum. A refund receipt has a
  // negative total AND a negative quantity, and dividing one by the other would
  // give a positive price by accident; a receipt mixing a sale and a refund can
  // sum to zero and divide by nothing at all. Absolute values keep the unit price
  // the positive menu price it should be, and leave the sign where it belongs --
  // on the quantity, which is what every downstream aggregate nets.
  const absQty = items.reduce((sum, item) => sum + Math.abs(item.quantity), 0);
  if (absQty <= 0) return { error: 'Invalid item quantity' };
  const unitPrice = parseFloat((Math.abs(total) / absQty).toFixed(2));
  const hasRefund = items.some((item) => item.quantity < 0);
  const priceSource = unitPriceSource(items, { tip, discount, hasRefund });
  const row = {
    receiptId: receiptId || undefined,
    date,
    ...temporalFields(date, timezone),
    items: items.map((i) => ({ ...i, unitPrice, priceSource })),
    total,
    tip,
    discount,
    paymentMethod: paymentMethod || undefined,
    status: mapping.status ? String(raw[mapping.status] || 'approved').trim().toLowerCase() : 'approved',
    // The operator's own wording, kept so a skip reason can quote their file
    // rather than a lowercased version of it.
    statusRaw: mapping.status ? String(raw[mapping.status] || '').trim() : '',
  };
  return { row: setSourceRowNumbers(row, [rowNumber]) };
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
const parseBuffer = async (
  buffer,
  { columnMapping, itemsMode = 'packed', fileExt = 'csv', timezone = DEFAULT_TIMEZONE }
) => {
  if (!VALID_ITEMS_MODES.has(itemsMode)) {
    throw new Error(`Invalid itemsMode: ${itemsMode}`);
  }
  const resolvedTimezone = safeTimezone(timezone);
  const normalizedExt = String(fileExt || 'csv').toLowerCase();
  assertSupportedFileBuffer(buffer, normalizedExt);
  validateMapping(columnMapping, itemsMode);
  const rawRows = repairOverflowColumns(await readRows(buffer, normalizedExt), columnMapping);

  let rows;
  let errors = 0;
  let rowErrors = [];

  if (itemsMode === 'line-per-row') {
    const grouped = groupLinePerRow(rawRows, columnMapping, resolvedTimezone);
    rows = grouped.rows;
    errors = grouped.errors;
    rowErrors = grouped.rowErrors;
  } else {
    rows = [];
    for (const [index, raw] of rawRows.entries()) {
      const rowNumber = sourceRowNumber(raw, index);
      try {
        const parsed = buildPackedRow(raw, columnMapping, rowNumber, resolvedTimezone);
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
  if (firstDate && lastDate) {
    const rangeDays = zonedDayOrdinal(lastDate, resolvedTimezone) -
      zonedDayOrdinal(firstDate, resolvedTimezone) + 1;
    if (rangeDays > parserLimits().maxDateRangeDays) {
      throw createClientInputError(
        `Upload date range exceeds the ${parserLimits().maxDateRangeDays} day limit`
      );
    }
  }

  return {
    rows,
    errors,
    rowErrors,
    totalRows: rawRows.length,
    dateRange: { firstDate, lastDate },
    timezone: resolvedTimezone,
  };
};

module.exports = {
  groupLinePerRow,
  parseBuffer,
  parsePackedItems,
  normaliseHeader,
  normaliseCell,
  normaliseRow,
  normaliseRows,
  csvSeparatorDirective,
  detectCsvSeparator,
  readCsvStream,
  csvMaxRowBytes,
  csvReadError,
  tooManyColumnsError,
  MAX_HEADER_CHARS,
  stripCsvSeparatorDirective,
  assertSupportedFileBuffer,
  readWorkbookRows,
  readWorkbook,
  streamXlsxSheetCells,
  streamXlsxSharedStrings,
  xlsxPartTooLargeError,
  requiredFieldsForMode,
  headerDeduper,
  parserLimits,
  safeTimezone,
  getZonedDateParts,
  zonedDateTimeToUtc,
  zonedDayStart,
  zonedDayEnd,
  addZonedDays,
  zonedDayOrdinal,
  zonedDateKey,
  zonedDayOfWeek,
  processLocalCalendarDate,
};
