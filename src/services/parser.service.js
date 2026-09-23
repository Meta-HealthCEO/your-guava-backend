const {
  DEFAULT_TIMEZONE, safeTimezone, zonedDateTimeToUtc, getZonedDateParts, zonedDayStart, zonedDayEnd,
  addZonedDays, zonedDayOrdinal, zonedDateKey, zonedDayOfWeek, processLocalCalendarDate,
} = require('../utils/timezone');
const { parserLimits, createClientInputError, tooManyColumnsError } = require('./parser/limits');
const { sourceRowNumber, addRowError } = require('./parser/rowErrors');
const {
  MAX_HEADER_CHARS, requiredFieldsForMode, normaliseHeader, headerDeduper, normaliseCell, normaliseRow,
  normaliseRows, validateMapping,
} = require('./parser/headers');
const { streamXlsxSharedStrings, streamXlsxSheetCells, xlsxPartTooLargeError } = require('./parser/xlsxStream');
const { assertSupportedFileBuffer } = require('./parser/fileType');
const { readWorkbook, readWorkbookRows } = require('./parser/xlsx');
const { groupLinePerRow } = require('./parser/lineItems');
const { parsePackedItems, buildPackedRow } = require('./parser/packedItems');
const {
  csvMaxRowBytes, csvReadError, csvSeparatorDirective, stripCsvSeparatorDirective, detectCsvSeparator, readCsvStream,
  repairOverflowColumns, readRows,
} = require('./parser/csv');

const VALID_ITEMS_MODES = new Set(['packed', 'line-per-row']);

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
