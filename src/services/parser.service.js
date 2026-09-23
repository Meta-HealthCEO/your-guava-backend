const csv = require('csv-parser');
const { Readable } = require('stream');
const path = require('path');
const zlib = require('zlib');

const REQUIRED_FIELDS = ['date', 'items', 'total'];
const UNNAMED_COLUMN_RE = /^_(\d+)$/;
const VALID_ITEMS_MODES = new Set(['packed', 'line-per-row']);
const SOURCE_ROW_NUMBERS = '__sourceRowNumbers';
const DEFAULT_TIMEZONE = 'Africa/Johannesburg';
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_ROW_ERRORS = 50;
const MAX_ROW_ERROR_COLUMNS = 12;
const MAX_ROW_ERROR_VALUE_LENGTH = 160;
const DEFAULT_MAX_ROWS = 10000;
const HARD_MAX_ROWS = 25000;
const DEFAULT_MAX_COLUMNS = 100;
const HARD_MAX_COLUMNS = 250;
const DEFAULT_MAX_CELL_CHARS = 10000;
const HARD_MAX_CELL_CHARS = 100000;
const DEFAULT_MAX_ITEMS_PER_TRANSACTION = 100;
const HARD_MAX_ITEMS_PER_TRANSACTION = 500;
const DEFAULT_MAX_ITEM_QUANTITY = 10000;
const HARD_MAX_ITEM_QUANTITY = 1000000;
const DEFAULT_MAX_ABSOLUTE_AMOUNT = 10000000;
const HARD_MAX_ABSOLUTE_AMOUNT = 1000000000;
const DEFAULT_MAX_ITEM_NAME_CHARS = 200;
const HARD_MAX_ITEM_NAME_CHARS = 1000;
const DEFAULT_MAX_IDENTIFIER_CHARS = 200;
const HARD_MAX_IDENTIFIER_CHARS = 1000;
const DEFAULT_MAX_DATE_RANGE_DAYS = 5 * 366;
const HARD_MAX_DATE_RANGE_DAYS = 10 * 366;
const DEFAULT_MAX_FUTURE_DAYS = 366;
const HARD_MAX_FUTURE_DAYS = 5 * 366;
const DEFAULT_MIN_YEAR = 2000;
const DEFAULT_XLSX_MAX_ENTRIES = 1000;
const HARD_XLSX_MAX_ENTRIES = 5000;
const DEFAULT_XLSX_MAX_TOTAL_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const HARD_XLSX_MAX_TOTAL_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const DEFAULT_XLSX_MAX_ENTRY_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
const HARD_XLSX_MAX_ENTRY_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const DEFAULT_XLSX_MAX_COMPRESSION_RATIO = 200;
const HARD_XLSX_MAX_COMPRESSION_RATIO = 1000;
const DEFAULT_MAX_ROW_BYTES = 128 * 1024;
const HARD_MAX_ROW_BYTES = 1024 * 1024;
// A column name, not a cell. Clipped before anything reads it, so no check
// downstream (the PII guard, the POS preset, the AI prompt) sees a runaway line.
const MAX_HEADER_CHARS = 200;
// csv-parser's own wording for a line longer than maxRowBytes.
const CSV_ROW_TOO_LONG_MESSAGE = 'Row exceeds the maximum size';

const boundedInteger = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
};

const parserLimits = () => ({
  maxRows: boundedInteger(process.env.UPLOAD_MAX_ROWS, DEFAULT_MAX_ROWS, 1, HARD_MAX_ROWS),
  maxRowBytes: boundedInteger(process.env.UPLOAD_MAX_ROW_BYTES, DEFAULT_MAX_ROW_BYTES, 4096, HARD_MAX_ROW_BYTES),
  maxColumns: boundedInteger(process.env.UPLOAD_MAX_COLUMNS, DEFAULT_MAX_COLUMNS, 2, HARD_MAX_COLUMNS),
  maxCellChars: boundedInteger(
    process.env.UPLOAD_MAX_CELL_CHARS,
    DEFAULT_MAX_CELL_CHARS,
    100,
    HARD_MAX_CELL_CHARS
  ),
  maxItemsPerTransaction: boundedInteger(
    process.env.UPLOAD_MAX_ITEMS_PER_TRANSACTION,
    DEFAULT_MAX_ITEMS_PER_TRANSACTION,
    1,
    HARD_MAX_ITEMS_PER_TRANSACTION
  ),
  maxItemQuantity: boundedInteger(
    process.env.UPLOAD_MAX_ITEM_QUANTITY,
    DEFAULT_MAX_ITEM_QUANTITY,
    1,
    HARD_MAX_ITEM_QUANTITY
  ),
  maxAbsoluteAmount: boundedInteger(
    process.env.UPLOAD_MAX_ABSOLUTE_AMOUNT,
    DEFAULT_MAX_ABSOLUTE_AMOUNT,
    1,
    HARD_MAX_ABSOLUTE_AMOUNT
  ),
  maxItemNameChars: boundedInteger(
    process.env.UPLOAD_MAX_ITEM_NAME_CHARS,
    DEFAULT_MAX_ITEM_NAME_CHARS,
    1,
    HARD_MAX_ITEM_NAME_CHARS
  ),
  maxIdentifierChars: boundedInteger(
    process.env.UPLOAD_MAX_IDENTIFIER_CHARS,
    DEFAULT_MAX_IDENTIFIER_CHARS,
    1,
    HARD_MAX_IDENTIFIER_CHARS
  ),
  maxDateRangeDays: boundedInteger(
    process.env.UPLOAD_MAX_DATE_RANGE_DAYS,
    DEFAULT_MAX_DATE_RANGE_DAYS,
    1,
    HARD_MAX_DATE_RANGE_DAYS
  ),
  maxFutureDays: boundedInteger(
    process.env.UPLOAD_MAX_FUTURE_DAYS,
    DEFAULT_MAX_FUTURE_DAYS,
    0,
    HARD_MAX_FUTURE_DAYS
  ),
  minYear: boundedInteger(process.env.UPLOAD_MIN_YEAR, DEFAULT_MIN_YEAR, 1970, 2100),
  xlsxMaxEntries: boundedInteger(
    process.env.XLSX_MAX_ENTRIES,
    DEFAULT_XLSX_MAX_ENTRIES,
    1,
    HARD_XLSX_MAX_ENTRIES
  ),
  xlsxMaxTotalUncompressedBytes: boundedInteger(
    process.env.XLSX_MAX_TOTAL_UNCOMPRESSED_BYTES,
    DEFAULT_XLSX_MAX_TOTAL_UNCOMPRESSED_BYTES,
    1024,
    HARD_XLSX_MAX_TOTAL_UNCOMPRESSED_BYTES
  ),
  xlsxMaxEntryUncompressedBytes: boundedInteger(
    process.env.XLSX_MAX_ENTRY_UNCOMPRESSED_BYTES,
    DEFAULT_XLSX_MAX_ENTRY_UNCOMPRESSED_BYTES,
    1024,
    HARD_XLSX_MAX_ENTRY_UNCOMPRESSED_BYTES
  ),
  xlsxMaxCompressionRatio: boundedInteger(
    process.env.XLSX_MAX_COMPRESSION_RATIO,
    DEFAULT_XLSX_MAX_COMPRESSION_RATIO,
    1,
    HARD_XLSX_MAX_COMPRESSION_RATIO
  ),
});

const createClientInputError = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
};

/** The longest line any CSV reader buffers before refusing the file. */
const csvMaxRowBytes = (limits = parserLimits()) => limits.maxRowBytes;

const tooManyColumnsError = (limits = parserLimits()) =>
  createClientInputError(`File exceeds the ${limits.maxColumns} column limit`);

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

const safeTimezone = (timezone) => {
  const candidate = String(timezone || DEFAULT_TIMEZONE);
  try {
    Intl.DateTimeFormat('en-ZA', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return DEFAULT_TIMEZONE;
  }
};

const getTimeZoneOffsetMs = (date, timezone) => {
  const parts = new Intl.DateTimeFormat('en-ZA', {
    timeZone: safeTimezone(timezone),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)])
  );
  const asUtc = Date.UTC(
    values.year,
    values.month - 1,
    values.day,
    values.hour,
    values.minute,
    values.second
  );
  return asUtc + date.getUTCMilliseconds() - date.getTime();
};

const zonedDateTimeToUtc = (
  { year, month, day, hour = 0, minute = 0, second = 0, ms = 0 },
  timezone
) => {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const firstOffset = getTimeZoneOffsetMs(new Date(utcGuess), timezone);
  const firstUtc = utcGuess - firstOffset;
  const secondOffset = getTimeZoneOffsetMs(new Date(firstUtc), timezone);
  return new Date(utcGuess - secondOffset);
};

const getZonedDateParts = (date, timezone) => {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-ZA', {
    timeZone: safeTimezone(timezone),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(parsed);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)])
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
};

const dateOnlyParts = (value, timezone) => {
  const match = typeof value === 'string' ? String(value).trim().match(DATE_ONLY_RE) : null;
  if (match) {
    const parts = {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
    };
    const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    if (
      check.getUTCFullYear() !== parts.year ||
      check.getUTCMonth() !== parts.month - 1 ||
      check.getUTCDate() !== parts.day
    ) return null;
    return parts;
  }
  const parts = getZonedDateParts(value, timezone);
  return parts && { year: parts.year, month: parts.month, day: parts.day };
};

const addDatePartsDays = (parts, days) => {
  const cursor = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return {
    year: cursor.getUTCFullYear(),
    month: cursor.getUTCMonth() + 1,
    day: cursor.getUTCDate(),
  };
};

const zonedDayStart = (value, timezone = DEFAULT_TIMEZONE) => {
  const parts = dateOnlyParts(value, timezone);
  if (!parts) return null;
  return zonedDateTimeToUtc(parts, timezone);
};

const zonedDayEnd = (value, timezone = DEFAULT_TIMEZONE) => {
  const parts = dateOnlyParts(value, timezone);
  if (!parts) return null;
  return zonedDateTimeToUtc(
    { ...parts, hour: 23, minute: 59, second: 59, ms: 999 },
    timezone
  );
};

const addZonedDays = (value, days, timezone = DEFAULT_TIMEZONE) => {
  const parts = dateOnlyParts(value, timezone);
  if (!parts) return null;
  return zonedDateTimeToUtc(addDatePartsDays(parts, days), timezone);
};

const zonedDayOrdinal = (value, timezone = DEFAULT_TIMEZONE) => {
  const parts = dateOnlyParts(value, timezone);
  if (!parts) return null;
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86400000);
};

const zonedDateKey = (value, timezone = DEFAULT_TIMEZONE) => {
  const parts = dateOnlyParts(value, timezone);
  if (!parts) return null;
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
};

const zonedDayOfWeek = (value, timezone = DEFAULT_TIMEZONE) => {
  const parts = dateOnlyParts(value, timezone);
  if (!parts) return null;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
};

const processLocalCalendarDate = (value, timezone = DEFAULT_TIMEZONE) => {
  const parts = dateOnlyParts(value, timezone);
  if (!parts) return null;
  return new Date(parts.year, parts.month - 1, parts.day, 12, 0, 0, 0);
};

const requiredFieldsForMode = (itemsMode = 'packed') =>
  itemsMode === 'line-per-row'
    ? [...REQUIRED_FIELDS, 'receiptId']
    : REQUIRED_FIELDS;

const normaliseHeader = (header, index = 0) => {
  const value = String(header ?? '').replace(/^\uFEFF/, '').trim().slice(0, MAX_HEADER_CHARS);
  return value || `Column ${index + 1}`;
};

/**
 * POS exports do repeat column names -- "Amount" for gross and net, "Total" for
 * the line and the receipt, "Date" for the sale and the settlement. Collapsed
 * into one key the last column silently won, so the owner mapped a column they
 * had never seen and the money came out wrong with no warning at any stage.
 *
 * Suffixing repeats keeps every column addressable, and because the preview and
 * the parse run the same deterministic pass, the column the owner picks is the
 * column that is read.
 */
const headerDeduper = () => {
  const seen = new Map();
  return (header, index) => {
    const base = normaliseHeader(header, index);
    const occurrence = (seen.get(base) || 0) + 1;
    seen.set(base, occurrence);
    return occurrence === 1 ? base : `${base} (${occurrence})`;
  };
};

// One runaway cell -- a pasted note, an escaped-quote bug in the till's own
// export that ran several lines together -- used to throw out of the parser and
// abort a 10,000-row import, naming neither the row nor the column, and often
// in a column the owner never intended to import. Clip it instead: the mapped
// fields have their own length bounds, so a truncated item name or receipt ID
// still becomes an honest row error while the rest of the file lands.
// A reader passes the limits it already holds: parserLimits() reads the
// environment about fifteen times, and a 128 KB line of separators is 131
// thousand cells.
const normaliseCell = (value, limits = parserLimits()) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > limits.maxCellChars ? trimmed.slice(0, limits.maxCellChars) : trimmed;
};

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

const excelSerialDateToDate = (serial, timezone = DEFAULT_TIMEZONE) => {
  if (!Number.isFinite(serial) || serial <= 0) return null;

  const wholeDays = Math.floor(serial);
  const dayFraction = serial - wholeDays;
  const epoch = Date.UTC(1899, 11, 30);
  const date = new Date(epoch + wholeDays * 86400000 + Math.round(dayFraction * 86400000));

  return zonedDateTimeToUtc({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  }, timezone);
};

// read-excel-file's own steps for reading sheet 1, with one check added before
// it allocates. The reader sizes its matrix from the sheet's declared
// <dimension ref> (or, with none, its furthest cell) and fills rows x columns
// before any row limit applies, so a 2.6 KB workbook declaring A1:XFD1048576
// asked for about 17 billion slots and took the API down for every cafe. Two
// imitations of that sizing failed review (a regex guard read r="XFD 1048576"
// differently from the reader; a capped worker still returned a sparse
// 1,048,576-row matrix), so the size is taken from the reader's own functions.
// These are read-excel-file 9.2.0's internal modules. 9.3 moved them, and
// package.json allows ^9.2.0, so they are loaded on first use rather than at
// startup: a version drift fails .xlsx reads with this message instead of
// stopping the API from booting, and a parser test pins the version.
let readerSteps = null;
const loadReaderSteps = () => {
  if (readerSteps) return readerSteps;
  const root = path.join(path.dirname(require.resolve('read-excel-file/node')), '..', 'commonjs');
  const step = (file) => {
    try {
      return require(path.join(root, file)).default;
    } catch (error) {
      throw new Error(`read-excel-file no longer ships ${file}; readFirstSheet was written against 9.2.0 (${error.message})`);
    }
  };
  readerSteps = {
    unpackXlsxFile: step('export/unpackXlsxFileNode.js'),
    xml: step('xml/xml.js'),
    parseFilePaths: step('xlsx/parseFilePaths.js'),
    parseSharedStrings: step('xlsx/parseSharedStrings.js'),
    parseStyles: step('xlsx/parseStyles.js'),
    parseSpreadsheetInfo: step('xlsx/parseSpreadsheetInfo.js'),
    parseCells: step('xlsx/parseCells.js'),
    parseSheetDimensions: step('xlsx/parseSheetDimensions.js'),
    reconstructSheetDimensions: step('xlsx/reconstructSheetDimensionsFromSheetCells.js'),
    convertCellsToData2dArray: step('xlsx/convertCellsToData2dArray.js'),
  };
  return readerSteps;
};

// What the reader will allocate: one array per row (about eight slots of
// overhead each) plus a slot per cell, so rows x (columns + 8) slots of eight
// bytes. Ten million is about 80 MB whatever the shape. Counting cells alone
// let A1:A10000000 through at "10M" while its ten million row arrays needed
// ~640 MB. Real exports stay far below: A1:Z65536 is 2.2M, and the parser's
// hard limits (25,000 x 250) are 6.5M.
const XLSX_MAX_SHEET_COST = 10000000;

// The reader's reason, on one line and short enough to sit inside a message.
const XLSX_REASON_MAX_CHARS = 160;
const xlsxUnreadableError = (error) => {
  if (error && error.statusCode) return error;
  const reason = String(error && error.message ? error.message : error).replace(/\s+/g, ' ').trim().slice(0, XLSX_REASON_MAX_CHARS);
  const unreadable = createClientInputError(
    `This spreadsheet could not be read (${reason}). Save it again from Excel, or export it as "CSV UTF-8", and upload that.`
  );
  unreadable.code = 'XLSX_UNREADABLE';
  return unreadable;
};

/**
 * readSheet(buffer) for sheet 1, as read-excel-file 9.2.0 does it, refusing a
 * sheet whose matrix would be unsafe to allocate. A side of 0 counts as 1:
 * A1:1000000000 has no column letters, and the reader still builds a billion
 * empty rows for it.
 */
const readFirstSheet = async (buffer) => {
  const {
    unpackXlsxFile, xml: readerXml, parseFilePaths, parseSharedStrings, parseStyles,
    parseSpreadsheetInfo, parseCells, parseSheetDimensions, reconstructSheetDimensions,
    convertCellsToData2dArray,
  } = loadReaderSteps();
  // Everything the reader does to a workbook that reached this point is about
  // the file's shape (a missing part, a sheet it cannot parse, an unescaped
  // "<" in an attribute, an undeclared namespace prefix). The reader reports
  // those as bare Errors, which the error middleware turned into a 500 as if
  // the API were at fault; they are 400s that tell the owner what to do.
  let cells;
  let dimensions;
  try {
    const contents = await unpackXlsxFile(buffer);
    const fileContent = (filePath) => {
      if (!contents[filePath]) {
        throw new Error(`"${filePath}" file not found inside the *.xlsx file zip archive`);
      }
      return contents[filePath];
    };
    const options = { sheets: [1] };
    const filePaths = parseFilePaths(fileContent('xl/_rels/workbook.xml.rels'), readerXml);
    const sharedStrings = filePaths.sharedStrings
      ? parseSharedStrings(fileContent(filePaths.sharedStrings), readerXml)
      : [];
    const styles = filePaths.styles ? parseStyles(fileContent(filePaths.styles), readerXml) : {};
    const { sheets, epoch1904 } = parseSpreadsheetInfo(fileContent('xl/workbook.xml'), readerXml);
    if (sheets.length < 1) {
      throw new Error('Sheet number out of bounds: 1. Available sheets count: 0');
    }
    const sheetPath = filePaths.sheets[sheets[0].relationId];
    if (!sheetPath) throw new Error('The first sheet of this workbook could not be found');

    const sheetDocument = readerXml.createDocument(fileContent(sheetPath));
    cells = parseCells(sheetDocument, sharedStrings, styles, epoch1904, options);
    dimensions = parseSheetDimensions(sheetDocument) || reconstructSheetDimensions(cells);
  } catch (error) {
    throw xlsxUnreadableError(error);
  }
  if (cells.length > 0) {
    const { row, column } = dimensions[1];
    const cost = Math.max(row, 1) * (Math.max(column, 1) + 8);
    if (!(cost <= XLSX_MAX_SHEET_COST)) {
      throw createClientInputError(
        `This spreadsheet says it spans ${row} rows by ${column} columns, which is too large to read safely. `
        + 'Save it again from Excel, or export it as "CSV UTF-8", and upload that.'
      );
    }
  }
  return convertCellsToData2dArray(cells, dimensions);
};

/**
 * Reads a workbook into its header row and its data rows.
 *
 * Headers are taken from the sheet's own first row rather than inferred from a
 * data row, so a spreadsheet exported over a quiet period still reports its
 * columns. Deriving them from `rows[0]` made an empty export look like a file
 * with unreadable headers, which is what the operator was then told.
 */
const readWorkbook = async (buffer) => {
  const limits = parserLimits();
  const matrix = await readFirstSheet(buffer);
  if (!matrix.length) return { headers: [], rows: [] };
  if (matrix.length - 1 > limits.maxRows) {
    throw createClientInputError(`File exceeds the ${limits.maxRows} row limit`);
  }

  const [headerRow, ...dataRows] = matrix;
  if (headerRow.length > limits.maxColumns) {
    throw createClientInputError(`File exceeds the ${limits.maxColumns} column limit`);
  }
  const dedupeHeader = headerDeduper();
  const headers = headerRow.map((header, index) => dedupeHeader(header, index));

  const rows = dataRows
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

  return { headers, rows };
};

const readWorkbookRows = async (buffer) => (await readWorkbook(buffer)).rows;

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_LOCATOR = 0x07064b50;
const ZIP_ENCRYPTION_FLAGS = 0x0001 | 0x0040 | 0x2000;

const assertZipExtraFields = (buffer, start, length) => {
  const end = start + length;
  if (start < 0 || end > buffer.length) throw createClientInputError('XLSX ZIP metadata is malformed');
  let offset = start;
  while (offset < end) {
    if (offset + 4 > end) throw createClientInputError('XLSX ZIP extra fields are malformed');
    const headerId = buffer.readUInt16LE(offset);
    const dataLength = buffer.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + dataLength > end) throw createClientInputError('XLSX ZIP extra fields are malformed');
    if (headerId === 0x0001) throw createClientInputError('ZIP64 XLSX archives are not supported');
    offset += dataLength;
  }
};

const findZipEndRecord = (buffer) => {
  if (buffer.length < 22) return null;
  const earliest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  return null;
};

const assertSafeZipEntryName = (name) => {
  const normalized = String(name || '').replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (
    !normalized ||
    normalized.length > 1024 ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    segments.includes('..')
  ) {
    throw createClientInputError('XLSX archive contains an unsafe entry name');
  }
};

const assertSafeXlsxArchive = (buffer) => {
  const limits = parserLimits();
  const endOffset = findZipEndRecord(buffer);
  if (endOffset == null) throw createClientInputError('XLSX ZIP directory is missing or malformed');
  if (endOffset >= 20 && buffer.readUInt32LE(endOffset - 20) === ZIP64_END_LOCATOR) {
    throw createClientInputError('ZIP64 XLSX archives are not supported');
  }

  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const centralDisk = buffer.readUInt16LE(endOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(endOffset + 8);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0 ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw createClientInputError('Multi-disk or ZIP64 XLSX archives are not supported');
  }
  if (entryCount > limits.xlsxMaxEntries) {
    throw createClientInputError(`XLSX archive exceeds the ${limits.xlsxMaxEntries} entry limit`);
  }
  if (centralOffset + centralSize !== endOffset || centralOffset >= endOffset) {
    throw createClientInputError('XLSX ZIP directory offsets are malformed');
  }

  let offset = centralOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  let actualTotalUncompressed = 0;
  const localRanges = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > endOffset || buffer.readUInt32LE(offset) !== ZIP_CENTRAL_HEADER) {
      throw createClientInputError('XLSX ZIP central directory is malformed');
    }
    const versionMadeBy = buffer.readUInt16LE(offset + 4);
    const versionNeeded = buffer.readUInt16LE(offset + 6);
    const flags = buffer.readUInt16LE(offset + 8);
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const entryDisk = buffer.readUInt16LE(offset + 34);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const centralEntryEnd = offset + 46 + fileNameLength + extraLength + commentLength;

    if (
      centralEntryEnd > endOffset ||
      versionNeeded >= 45 ||
      (flags & ZIP_ENCRYPTION_FLAGS) !== 0 ||
      ![0, 8].includes(compressionMethod) ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff ||
      entryDisk !== 0
    ) {
      throw createClientInputError('XLSX archive uses unsupported or unsafe ZIP features');
    }
    const unixMode = externalAttributes >>> 16;
    if ((versionMadeBy >>> 8) === 3 && (unixMode & 0xf000) === 0xa000) {
      throw createClientInputError('XLSX archive symbolic-link entries are not supported');
    }

    const fileNameStart = offset + 46;
    const fileNameBuffer = buffer.subarray(fileNameStart, fileNameStart + fileNameLength);
    const fileName = fileNameBuffer.toString((flags & 0x0800) !== 0 ? 'utf8' : 'latin1');
    assertSafeZipEntryName(fileName);
    assertZipExtraFields(buffer, fileNameStart + fileNameLength, extraLength);

    if (uncompressedSize > limits.xlsxMaxEntryUncompressedBytes) {
      throw createClientInputError(
        `XLSX entry exceeds the ${limits.xlsxMaxEntryUncompressedBytes} byte expanded-size limit`
      );
    }
    if (
      uncompressedSize > 0 &&
      (compressedSize === 0 || uncompressedSize / compressedSize > limits.xlsxMaxCompressionRatio)
    ) {
      throw createClientInputError(
        `XLSX entry exceeds the ${limits.xlsxMaxCompressionRatio}:1 compression-ratio limit`
      );
    }
    if (compressionMethod === 0 && compressedSize !== uncompressedSize) {
      throw createClientInputError('Stored XLSX ZIP entry sizes are inconsistent');
    }

    totalCompressed += compressedSize;
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > limits.xlsxMaxTotalUncompressedBytes) {
      throw createClientInputError(
        `XLSX archive exceeds the ${limits.xlsxMaxTotalUncompressedBytes} byte expanded-size limit`
      );
    }

    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_HEADER) {
      throw createClientInputError('XLSX ZIP local-file offsets are malformed');
    }
    const localVersionNeeded = buffer.readUInt16LE(localOffset + 4);
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localCrc = buffer.readUInt32LE(localOffset + 14);
    const localCompressedSize = buffer.readUInt32LE(localOffset + 18);
    const localUncompressedSize = buffer.readUInt32LE(localOffset + 22);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const dataStart = localNameStart + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (
      localVersionNeeded >= 45 ||
      localFlags !== flags ||
      localMethod !== compressionMethod ||
      localNameLength !== fileNameLength ||
      dataStart > centralOffset ||
      dataEnd > centralOffset ||
      !buffer.subarray(localNameStart, localNameStart + localNameLength).equals(fileNameBuffer)
    ) {
      throw createClientInputError('XLSX ZIP local-file metadata is inconsistent');
    }
    if (
      (flags & 0x0008) === 0 &&
      (
        localCrc !== expectedCrc ||
        localCompressedSize !== compressedSize ||
        localUncompressedSize !== uncompressedSize
      )
    ) {
      throw createClientInputError('XLSX ZIP entry sizes are inconsistent');
    }
    assertZipExtraFields(buffer, localNameStart + localNameLength, localExtraLength);
    let expanded;
    if (compressionMethod === 8) {
      const verificationLimit = Math.max(1, Math.min(
        limits.xlsxMaxEntryUncompressedBytes,
        limits.xlsxMaxTotalUncompressedBytes - actualTotalUncompressed,
        uncompressedSize + 1
      ));
      try {
        expanded = zlib.inflateRawSync(buffer.subarray(dataStart, dataEnd), {
          maxOutputLength: verificationLimit,
        });
      } catch (error) {
        throw createClientInputError('XLSX ZIP entry could not be safely decompressed');
      }
    } else {
      expanded = buffer.subarray(dataStart, dataEnd);
    }
    if (expanded.length !== uncompressedSize) {
      throw createClientInputError('XLSX ZIP expanded sizes are inconsistent');
    }
    if ((zlib.crc32(expanded) >>> 0) !== expectedCrc) {
      throw createClientInputError('XLSX ZIP entry CRC checksum is inconsistent');
    }
    actualTotalUncompressed += expanded.length;
    if (actualTotalUncompressed > limits.xlsxMaxTotalUncompressedBytes) {
      throw createClientInputError(
        `XLSX archive exceeds the ${limits.xlsxMaxTotalUncompressedBytes} byte actual expanded-size limit`
      );
    }
    localRanges.push({ start: localOffset, end: dataEnd });
    offset = centralEntryEnd;
  }

  if (offset !== endOffset) throw createClientInputError('XLSX ZIP central directory size is inconsistent');
  if (
    totalUncompressed > 0 &&
    (totalCompressed === 0 || totalUncompressed / totalCompressed > limits.xlsxMaxCompressionRatio)
  ) {
    throw createClientInputError(
      `XLSX archive exceeds the ${limits.xlsxMaxCompressionRatio}:1 compression-ratio limit`
    );
  }
  localRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index].start < localRanges[index - 1].end) {
      throw createClientInputError('XLSX ZIP entries overlap');
    }
  }
};

// OLE2/CFBF signature: every Excel 97-2003 .xls begins with these eight bytes.
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

// Names the format and the way out. CSV UTF-8 is the instruction rather than XLSX
// because it imports on every build, and the portal says the same thing (D-002).
const LEGACY_XLS_MESSAGE =
  'This is a legacy .xls file. In Excel choose File -> Save As -> "CSV UTF-8 (Comma delimited)" '
  + 'and upload that .csv.';

const assertSupportedFileBuffer = (buffer, fileExt = 'csv') => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw createClientInputError('Uploaded file is empty');
  }

  const ext = String(fileExt || '').toLowerCase();

  // Identify a legacy .xls by its bytes before trusting the extension. An owner
  // whose till only writes .xls will often rename it to .xlsx and try again, and
  // that produced 'XLSX file signature is invalid' - true, and useless: it does not
  // say what the file is or what to do with it. OLE2/CFBF compound document.
  if (buffer.length >= OLE2_MAGIC.length && buffer.subarray(0, OLE2_MAGIC.length).equals(OLE2_MAGIC)) {
    const err = createClientInputError(LEGACY_XLS_MESSAGE);
    err.code = 'LEGACY_XLS';
    throw err;
  }

  if (ext === 'xlsx') {
    const validZipSuffixes = new Set(['3:4', '5:6', '7:8']);
    const isZip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b &&
      validZipSuffixes.has(`${buffer[2]}:${buffer[3]}`);
    if (!isZip) throw createClientInputError('XLSX file signature is invalid');
    assertSafeXlsxArchive(buffer);
    return;
  }

  // The legacy-XLS guidance lived downstream of this assert, so it was
  // unreachable: an owner whose till only offers .xls was told the format was
  // unsupported and nothing about what to export instead. Say it here and every
  // entry point says it.
  if (ext === 'xls') {
    const err = createClientInputError(LEGACY_XLS_MESSAGE);
    err.code = 'LEGACY_XLS';
    throw err;
  }

  if (ext !== 'csv') {
    throw createClientInputError('Only CSV and XLSX files are supported');
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) {
    throw createClientInputError('CSV file contains binary data');
  }
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
const PACKED_ITEM_RE = new RegExp(
  `(${PACKED_QUANTITY})${PACKED_MARKER}([^\\n]+?)(?:[,;\\n](?=\\s*${PACKED_QUANTITY}${PACKED_MARKER})|$)`,
  'gi'
);
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
  const items = [];
  const regex = new RegExp(PACKED_ITEM_RE.source, PACKED_ITEM_RE.flags);
  let match;
  while ((match = regex.exec(str)) !== null) {
    const quantity = packedQuantity(match[1]);
    const name = match[2].trim();
    if (name && quantity != null) items.push({ name, quantity });
  }
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

const parseCleanNumber = (raw) => {
  if (raw == null || raw === '') return { valid: false, value: 0 };
  if (typeof raw === 'number') {
    return Number.isFinite(raw)
      ? { valid: true, value: raw }
      : { valid: false, value: 0 };
  }

  let value = String(raw).trim();
  if (/\d[eE][+-]?\d/.test(value)) return { valid: false, value: 0 };

  // Judge the sign markers only after currency symbols and spacing are gone.
  // The parenthesis test used to run on the raw string, so "R(150.00)" read as
  // a positive 150 while "(150.00)" correctly read as -150; and every minus
  // after the first character was stripped outright, so the trailing-minus
  // convention older accounting exports use -- "45.00-" -- lost its sign
  // entirely. Either way a refund was booked as revenue and the day's takings
  // overstated by twice it.
  value = value.replace(/\s+/g, '').replace(/[^\d(),.-]/g, '');
  const negative = /^\(.+\)$/.test(value) || /^-/.test(value) || /-$/.test(value);
  value = value.replace(/[()-]/g, '');

  if (!value || value === '.' || value === ',') {
    return { valid: false, value: 0 };
  }

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

  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) return { valid: false, value: 0 };
  return {
    valid: true,
    value: negative ? -Math.abs(parsed) : parsed,
  };
};

const parseBoundedAmount = (raw, limits = parserLimits()) => {
  const parsed = parseCleanNumber(raw);
  if (!parsed.valid || Math.abs(parsed.value) > limits.maxAbsoluteAmount) return null;
  return parsed.value;
};

/**
 * Reads an optional money column -- Tip, Discount -- where a blank cell means
 * "none".
 *
 * Tills routinely leave these columns empty on a cash sale rather than writing
 * 0.0. A blank cell was read as an unparseable amount and the whole row was
 * discarded, so a till with that habit lost every cash transaction it ever
 * exported, and the owner was told the amount had exceeded ten million. Absent
 * is not malformed: only a cell with something in it can fail to parse.
 *
 * Returns `{ value }` or `{ error }`, where the error names which column failed
 * and whether it was unreadable or simply too large -- an operator can act on
 * "Tip is not a valid amount" and cannot act on the two fused together.
 */
const parseOptionalAmount = (raw, label, limits) => {
  if (raw == null || String(raw).trim() === '') return { value: 0 };
  const parsed = parseCleanNumber(raw);
  if (!parsed.valid) return { error: `${label} is not a valid amount` };
  if (Math.abs(parsed.value) > limits.maxAbsoluteAmount) {
    return { error: `${label} exceeds the ${limits.maxAbsoluteAmount} amount limit` };
  }
  return { value: parsed.value };
};

const parseQuantity = (raw, limits = parserLimits()) => {
  const parsed = parseCleanNumber(raw);
  // Truncating discarded weight-based quantities entirely: 0.35 became 0 and the
  // row was rejected as invalid. Keep the value the till actually recorded.
  const quantity = parsed.value;
  // Negative quantities are refunds and must survive parsing for the same reason
  // they do in packed mode -- silently dropping the sign turns a return into a
  // sale. Zero is still meaningless, and the bound applies to the magnitude.
  return parsed.valid && Number.isFinite(quantity) &&
    quantity !== 0 && Math.abs(quantity) <= limits.maxItemQuantity
    ? quantity
    : null;
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
      hours: timeStr.getUTCHours(),
      minutes: timeStr.getUTCMinutes(),
      seconds: timeStr.getUTCSeconds(),
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

const applyTimeParts = (date, timeStr, timezone = DEFAULT_TIMEZONE) => {
  const hasExplicitTime = timeStr != null && String(timeStr).trim() !== '';
  if (!hasExplicitTime) return date;
  const time = parseTimeParts(timeStr);
  if (!time) return null;
  const localDate = getZonedDateParts(date, timezone);
  if (!localDate) return null;
  return zonedDateTimeToUtc({
    year: localDate.year,
    month: localDate.month,
    day: localDate.day,
    hour: time.hours,
    minute: time.minutes,
    second: time.seconds,
  }, timezone);
};

const dateFromParts = (year, month, day, timeStr, timezone = DEFAULT_TIMEZONE) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  const time = timeStr != null && String(timeStr).trim() !== ''
    ? parseTimeParts(timeStr)
    : { hours: 0, minutes: 0, seconds: 0 };
  if (!time) return null;
  return zonedDateTimeToUtc({
    year,
    month,
    day,
    hour: time.hours,
    minute: time.minutes,
    second: time.seconds,
  }, timezone);
};

// A cell can carry its own time -- "2026-09-03 23:30", "03/09/2026T14:30:00".
// The anchor after the time is what keeps an offset-qualified timestamp out:
// "...T23:30:00Z" and "...+02:00" do not match, and go to `new Date`, which is
// the right reader for a string that already states its zone.
const COMBINED_DATE_TIME_RE =
  /^(\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4})[T\s]+(\d{1,2}:\d{2}(?::\d{2})?)$/;
// Two-digit years are day-first too, like every other date an SA till writes.
// The pivot: 70-99 is the 1900s, 00-69 the 2000s, which covers every export
// that could plausibly be trading history without reaching a year that has not
// happened. Both ends are refused anyway by the min-year and future-day bounds.
const TWO_DIGIT_YEAR_PIVOT = 70;

const expandTwoDigitYear = (shortYear) =>
  (shortYear >= TWO_DIGIT_YEAR_PIVOT ? 1900 : 2000) + shortYear;

const parseDateString = (dateStr, timeStr, timezone = DEFAULT_TIMEZONE) => {
  const value = String(dateStr).trim();

  // A combined cell used to reach `new Date`, which resolves a naive local
  // string in the NODE process timezone rather than the cafe's, and
  // applyTimeParts then only re-read the resulting instant -- so the process
  // reading was already baked in. On a UTC host that stamped every sale after
  // 22:00 cafe-local with the next trading day and shifted every hour by two.
  // Splitting the cell and building the instant from its parts puts it in the
  // cafe zone, exactly as a separate Time column already does.
  const combined = value.match(COMBINED_DATE_TIME_RE);
  const datePart = combined ? combined[1] : value;
  // A mapped Time column still wins: it is the operator's explicit choice.
  const time = timeStr != null && String(timeStr).trim() !== '' ? timeStr : combined?.[2];

  let match = datePart.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) {
    return dateFromParts(
      parseInt(match[1], 10),
      parseInt(match[2], 10),
      parseInt(match[3], 10),
      time,
      timezone
    );
  }

  match = datePart.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (match) {
    return dateFromParts(
      parseInt(match[3], 10),
      parseInt(match[2], 10),
      parseInt(match[1], 10),
      time,
      timezone
    );
  }

  // Nothing matched a two-digit year, so "03/09/26" fell through to V8's
  // month-first reading and landed on 9 March instead of 3 September, while
  // "13/09/26" was discarded as unparseable. Days 1-12 moved month in silence
  // and days 13-31 vanished, on a till doing nothing more exotic than using a
  // short date format.
  match = datePart.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/);
  if (match) {
    return dateFromParts(
      expandTwoDigitYear(parseInt(match[3], 10)),
      parseInt(match[2], 10),
      parseInt(match[1], 10),
      time,
      timezone
    );
  }

  // A bare number is not a date, whatever `new Date` makes of it: it reads "0"
  // as the year 2000 and "45900" as the year 45899. Both passed the minimum-year
  // floor, and one junk cell then widened the file's span far enough to have the
  // whole upload refused for a date range the owner's three-day file never had.
  if (/^\d+$/.test(value)) return null;

  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return null;
  return applyTimeParts(parsed, timeStr, timezone);
};

const parseDate = (dateStr, timeStr, timezone = DEFAULT_TIMEZONE) => {
  if (!dateStr) return null;
  if (dateStr instanceof Date) {
    const source = new Date(dateStr);
    const sourceTime = timeStr != null && String(timeStr).trim() !== ''
      ? timeStr
      : `${source.getUTCHours()}:${String(source.getUTCMinutes()).padStart(2, '0')}:${String(source.getUTCSeconds()).padStart(2, '0')}`;
    const withTime = dateFromParts(
      source.getUTCFullYear(),
      source.getUTCMonth() + 1,
      source.getUTCDate(),
      sourceTime,
      timezone
    );
    return !withTime || isNaN(withTime.getTime()) ? null : withTime;
  }
  if (typeof dateStr === 'number') {
    const date = excelSerialDateToDate(dateStr, timezone);
    if (date) {
      const withTime = applyTimeParts(date, timeStr, timezone);
      return !withTime || isNaN(withTime.getTime()) ? null : withTime;
    }
  }
  return parseDateString(dateStr, timeStr, timezone);
};

const transactionDateError = (date, timezone) => {
  const limits = parserLimits();
  const earliest = zonedDayStart(`${limits.minYear}-01-01`, timezone);
  const latest = addZonedDays(new Date(), limits.maxFutureDays, timezone);
  if (!date || Number.isNaN(date.getTime())) return 'Could not parse date or time';
  if (date < earliest) return `Transaction date is before ${limits.minYear}`;
  if (date > latest) return `Transaction date is more than ${limits.maxFutureDays} days in the future`;
  return null;
};

const temporalFields = (date, timezone) => {
  const parts = getZonedDateParts(date, timezone);
  return {
    hour: parts.hour,
    dayOfWeek: new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay(),
    // The cafe-local trading day. Receipt numbers are only unique within a day
    // on tills that restart their numbering, so identity has to be scoped by it.
    dateKey: zonedDateKey(date, timezone),
  };
};

/**
 * A packed receipt carries one total for the whole basket. With a single
 * distinct item the unit price is exact (total / quantity); with several it
 * can only be a basket average. The average keeps per-item revenue summing to
 * the receipt, which analytics relies on, but it is not a price -- the menu
 * used to learn it as one, so nearly every item showed a false "price
 * differs" warning. The flag lets price learning and mismatch checks skip it.
 */
const unitPriceSource = (items, { isExactPerLine = false, tip = 0, discount = 0, hasRefund = false } = {}) => {
  if (isExactPerLine) return 'exact';
  // A refund or a void is a correction, not a price observation. Its arithmetic
  // can even divide to zero, which must never be learned as a menu price.
  if (hasRefund) return 'derived';
  // A tip or discount lands in the receipt total, so total / quantity is the
  // menu price plus the tip (or minus the discount), not the price itself.
  // One tipped single-item receipt was enough to seed an item 18% high and
  // flag every later sale as a mismatch.
  if (Number(tip) !== 0 || Number(discount) !== 0) return 'derived';
  return new Set(items.map((item) => item.name)).size === 1 ? 'exact' : 'derived';
};

const LINE_AMOUNT_HEADER_RE = /(^|\s)(line|item)(\s|$)/i;
const TOTALS_MODE_CONSENSUS = 0.9;
// Below this many multi-row receipts the vote is trivially unanimous: a lone
// receipt with two items at the same price is an everyday coincidence, not
// evidence that the file repeats receipt totals.
const MIN_MULTI_ROW_RECEIPTS_FOR_INFERENCE = 5;

const headerSuggestsLineAmounts = (mapping) =>
  LINE_AMOUNT_HEADER_RE.test(String(mapping.total || '').replace(/[_-]+/g, ' '));

/**
 * Decides, per file, whether each row's total is a line amount (summed into
 * the receipt) or the receipt total repeated on every line (taken once).
 *
 * This used to be read off the mapped column's NAME: anything containing
 * "line" or "item" was summed. A till that repeats the order total under a
 * header like "Item Total" then had every receipt multiplied by its line
 * count, and revenue inflated silently. The data settles it: across receipts
 * with two or more rows, near-unanimous identical totals mean receipt totals
 * and near-unanimous differing totals mean line amounts. Only when neither
 * reading reaches consensus, or too few receipts have more than one row to
 * be evidence, does the header decide as before.
 */
const inferTotalsAreLineAmounts = (groups, mapping) => {
  let identical = 0;
  let differing = 0;
  for (const group of groups.values()) {
    if (group.invalidReason || group.totals.length < 2) continue;
    const uniqueTotals = new Set(group.totals.map((total) => Number(total.toFixed(2))));
    if (uniqueTotals.size === 1) identical++;
    else differing++;
  }
  const multiRowReceipts = identical + differing;
  if (multiRowReceipts >= MIN_MULTI_ROW_RECEIPTS_FOR_INFERENCE) {
    if (identical / multiRowReceipts >= TOTALS_MODE_CONSENSUS) return false;
    if (differing / multiRowReceipts >= TOTALS_MODE_CONSENSUS) return true;
  }
  return headerSuggestsLineAmounts(mapping);
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

const groupLinePerRow = (rawRows, mapping, timezone) => {
  const limits = parserLimits();
  const groups = new Map();
  const rowErrors = [];
  let errors = 0;

  for (const [index, raw] of rawRows.entries()) {
    const rowNumber = sourceRowNumber(raw, index);
    try {
      const date = parseDate(raw[mapping.date], mapping.time && raw[mapping.time], timezone);
      if (!date) {
        errors++;
        addRowError(rowErrors, rowNumber, 'Could not parse date or time', raw);
        continue;
      }
      const dateError = transactionDateError(date, timezone);
      if (dateError) {
        errors++;
        addRowError(rowErrors, rowNumber, dateError, raw);
        continue;
      }
      const receiptId = String(raw[mapping.receiptId] || '').trim();
      if (!receiptId) {
        errors++;
        addRowError(rowErrors, rowNumber, 'Missing receipt ID', raw);
        continue;
      }
      if (receiptId.length > limits.maxIdentifierChars) {
        errors++;
        addRowError(
          rowErrors,
          rowNumber,
          `Receipt ID exceeds the ${limits.maxIdentifierChars} character limit`,
          raw
        );
        continue;
      }
      // Receipt numbers are only unique within a day on most tills -- plenty
      // restart their order numbers each morning. Keyed on the receipt alone,
      // the same number on two days collided, the date mismatch was flagged as
      // conflicting rows, and the whole group was rejected: a till that
      // restarts numbering could not import at all.
      const groupKey = `${zonedDateKey(date, timezone)}::${receiptId}`;
      const itemName = String(raw[mapping.items] || '').trim();
      if (!itemName) {
        errors++;
        addRowError(rowErrors, rowNumber, 'Missing item name', raw);
        continue;
      }
      if (itemName.length > limits.maxItemNameChars) {
        errors++;
        addRowError(
          rowErrors,
          rowNumber,
          `Item name exceeds the ${limits.maxItemNameChars} character limit`,
          raw
        );
        continue;
      }
      const quantity = mapping.quantity ? parseQuantity(raw[mapping.quantity], limits) : 1;
      if (!quantity) {
        errors++;
        addRowError(rowErrors, rowNumber, 'Invalid item quantity', raw);
        continue;
      }
      const total = parseBoundedAmount(raw[mapping.total], limits);
      if (total === null) {
        errors++;
        addRowError(
          rowErrors,
          rowNumber,
          `Invalid transaction total or amount exceeds ${limits.maxAbsoluteAmount}`,
          raw
        );
        continue;
      }
      const parsedTip = parseOptionalAmount(mapping.tip && raw[mapping.tip], 'Tip', limits);
      const parsedDiscount = parseOptionalAmount(
        mapping.discount && raw[mapping.discount],
        'Discount',
        limits
      );
      if (parsedTip.error || parsedDiscount.error) {
        errors++;
        addRowError(rowErrors, rowNumber, parsedTip.error || parsedDiscount.error, raw);
        continue;
      }
      const tip = parsedTip.value;
      const discount = parsedDiscount.value;
      const paymentMethod = mapping.paymentMethod
        ? String(raw[mapping.paymentMethod] || '').trim()
        : '';
      if (paymentMethod.length > limits.maxIdentifierChars) {
        errors++;
        addRowError(
          rowErrors,
          rowNumber,
          `Payment method exceeds the ${limits.maxIdentifierChars} character limit`,
          raw
        );
        continue;
      }
      if (!groups.has(groupKey)) {
        groups.set(groupKey, setSourceRowNumbers({
          receiptId,
          date,
          ...temporalFields(date, timezone),
          items: [],
          totals: [],
          tip,
          discount,
          paymentMethod: paymentMethod || undefined,
          status: mapping.status ? String(raw[mapping.status] || 'approved').trim().toLowerCase() : 'approved',
          statusRaw: mapping.status ? String(raw[mapping.status] || '').trim() : '',
          invalidReason: undefined,
        }, []));
      }
      const group = groups.get(groupKey);
      const status = mapping.status
        ? String(raw[mapping.status] || 'approved').trim().toLowerCase()
        : 'approved';
      const inconsistent =
        group.date.getTime() !== date.getTime() ||
        Number(group.tip || 0) !== Number(tip || 0) ||
        Number(group.discount || 0) !== Number(discount || 0) ||
        String(group.paymentMethod || '') !== String(paymentMethod || '') ||
        String(group.status || 'approved') !== status;
      if (inconsistent) {
        // The rows already accepted into this receipt are discarded with it, so
        // count them and name them. Counting one error while dropping four rows
        // under-reported the damage: the owner reconciled against the till
        // report, found revenue missing, and the error list gave them no row
        // number to look at.
        const discarded = group.invalidReason ? [] : group[SOURCE_ROW_NUMBERS];
        errors += 1 + discarded.length;
        group.invalidReason =
          'Rows sharing a receipt ID have conflicting date, time, payment, status, tip, or discount values';
        addRowError(
          rowErrors,
          rowNumber,
          discarded.length > 0
            ? `${group.invalidReason}. Receipt ${receiptId} was dropped, including rows ${discarded.join(', ')}`
            : group.invalidReason,
          { receiptId }
        );
        continue;
      }
      if (group.items.length >= limits.maxItemsPerTransaction) {
        errors++;
        addRowError(
          rowErrors,
          rowNumber,
          `Transaction exceeds the ${limits.maxItemsPerTransaction} item limit`,
          raw
        );
        continue;
      }
      group[SOURCE_ROW_NUMBERS].push(rowNumber);
      group.items.push({ name: itemName, quantity, lineTotal: total });
      group.totals.push(total);
    } catch {
      errors++;
      addRowError(rowErrors, rowNumber, 'Could not parse row', raw);
    }
  }
  const totalsAreLineAmounts = inferTotalsAreLineAmounts(groups, mapping);
  const rows = [];
  for (const row of groups.values()) {
    if (row.invalidReason) continue;
    const totalQty = row.items.reduce((sum, item) => sum + item.quantity, 0);
    const uniqueTotals = [...new Set(row.totals.map((total) => Number(total.toFixed(2))))];
    if (!totalsAreLineAmounts && uniqueTotals.length !== 1) {
      // Every source row of this receipt is discarded, not just the first.
      errors += row[SOURCE_ROW_NUMBERS]?.length || 1;
      addRowError(
        rowErrors,
        row[SOURCE_ROW_NUMBERS]?.[0] || 1,
        `Rows sharing a receipt ID have conflicting receipt totals. Map a column labelled as a line/item amount when each row is a line amount. Receipt ${row.receiptId} was dropped, including rows ${(row[SOURCE_ROW_NUMBERS] || []).join(', ')}`,
        { receiptId: row.receiptId }
      );
      continue;
    }
    const total = totalsAreLineAmounts
      ? row.totals.reduce((sum, value) => sum + value, 0)
      : uniqueTotals[0];
    if (!Number.isFinite(total) || Math.abs(total) > limits.maxAbsoluteAmount) {
      errors += row[SOURCE_ROW_NUMBERS]?.length || 1;
      addRowError(
        rowErrors,
        row[SOURCE_ROW_NUMBERS]?.[0] || 1,
        `Transaction total exceeds the ${limits.maxAbsoluteAmount} amount limit`,
        { receiptId: row.receiptId }
      );
      continue;
    }
    const averageUnitPrice = totalQty > 0 ? parseFloat((total / totalQty).toFixed(2)) : 0;
    const priceSource = unitPriceSource(row.items, {
      isExactPerLine: totalsAreLineAmounts,
      tip: row.tip,
      discount: row.discount,
    });
    const { totals, invalidReason, ...cleanRow } = row;
    rows.push(setSourceRowNumbers({
      ...cleanRow,
      total,
      items: row.items.map(({ lineTotal, ...item }) => ({
        ...item,
        unitPrice: totalsAreLineAmounts && item.quantity > 0
          ? parseFloat((lineTotal / item.quantity).toFixed(2))
          : averageUnitPrice,
        priceSource,
      })),
    }, row[SOURCE_ROW_NUMBERS] || []));
  }
  return { rows, errors, rowErrors, totalsAreLineAmounts };
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
