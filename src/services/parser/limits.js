// Parser limits: the default and hard bounds, the env-driven parserLimits() and the client-input error factory.
// Moved from parser.service.js by BE-11-T01; behaviour unchanged.

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
// The workbook parts the reader still builds as a DOM (workbook.xml, its rels,
// styles.xml): small in every real file, and a DOM costs ~3 KB per element.
const DEFAULT_XLSX_MAX_PART_BYTES = 4 * 1024 * 1024;
const HARD_XLSX_MAX_PART_BYTES = 20 * 1024 * 1024;

const boundedInteger = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
};

const parserLimits = () => ({
  maxRows: boundedInteger(process.env.UPLOAD_MAX_ROWS, DEFAULT_MAX_ROWS, 1, HARD_MAX_ROWS),
  maxRowBytes: boundedInteger(process.env.UPLOAD_MAX_ROW_BYTES, DEFAULT_MAX_ROW_BYTES, 4096, HARD_MAX_ROW_BYTES),
  xlsxMaxPartBytes: boundedInteger(process.env.XLSX_MAX_PART_BYTES, DEFAULT_XLSX_MAX_PART_BYTES, 64 * 1024, HARD_XLSX_MAX_PART_BYTES),
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

const tooManyColumnsError = (limits = parserLimits()) =>
  createClientInputError(`File exceeds the ${limits.maxColumns} column limit`);

module.exports = {
  parserLimits, boundedInteger, createClientInputError, tooManyColumnsError,
};
