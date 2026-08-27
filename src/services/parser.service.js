const csv = require('csv-parser');
const { Readable } = require('stream');
const zlib = require('zlib');
// read-excel-file v8 renamed the matrix-returning function to `readSheet` and
// repurposed the default export to return every sheet as [{ sheet, data }].
// Importing the default and treating it as a matrix is what broke every .xlsx
// upload, so take the named export deliberately.
const { readSheet } = require('read-excel-file/node');

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

const boundedInteger = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
};

const parserLimits = () => ({
  maxRows: boundedInteger(process.env.UPLOAD_MAX_ROWS, DEFAULT_MAX_ROWS, 1, HARD_MAX_ROWS),
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
  const value = String(header ?? '').replace(/^\uFEFF/, '').trim();
  return value || `Column ${index + 1}`;
};

const normaliseCell = (value) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed.length > parserLimits().maxCellChars) {
    throw createClientInputError(`A cell exceeds the ${parserLimits().maxCellChars} character limit`);
  }
  return trimmed;
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

const readWorkbookRows = async (buffer) => {
  const limits = parserLimits();
  const matrix = await readSheet(buffer);
  if (!matrix.length) return [];
  if (matrix.length - 1 > limits.maxRows) {
    throw createClientInputError(`File exceeds the ${limits.maxRows} row limit`);
  }

  const [headerRow, ...dataRows] = matrix;
  if (headerRow.length > limits.maxColumns) {
    throw createClientInputError(`File exceeds the ${limits.maxColumns} column limit`);
  }
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

const assertSupportedFileBuffer = (buffer, fileExt = 'csv') => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw createClientInputError('Uploaded file is empty');
  }

  const ext = String(fileExt || '').toLowerCase();
  if (ext === 'xlsx') {
    const validZipSuffixes = new Set(['3:4', '5:6', '7:8']);
    const isZip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b &&
      validZipSuffixes.has(`${buffer[2]}:${buffer[3]}`);
    if (!isZip) throw createClientInputError('XLSX file signature is invalid');
    assertSafeXlsxArchive(buffer);
    return;
  }

  if (ext !== 'csv') {
    throw createClientInputError('Only CSV and XLSX files are supported');
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) {
    throw createClientInputError('CSV file contains binary data');
  }
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
  // Quantities may be fractional: cafes selling by weight export rows like
  // "0.35 x Cheese Wheel". Matching digits only made the engine skip past the
  // "0." and read the decimal part as the whole quantity, turning 0.35 into 35.
  const regex = /(\d+(?:\.\d+)?)\s+x\s+(.+?)(?:[,;](?=\s*\d+(?:\.\d+)?\s+x\s+)|$)/g;
  let match;
  while ((match = regex.exec(str)) !== null) {
    const quantity = parseFloat(match[1]);
    const name = match[2].trim();
    if (name && Number.isFinite(quantity) && quantity > 0) items.push({ name, quantity });
  }
  if (items.length > 0) return items;

  return String(str)
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const loose = part.match(/^(\d+(?:\.\d+)?)\s*x?\s+(.+)$/i);
      if (loose) {
        const quantity = parseFloat(loose[1]);
        return {
          name: loose[2].trim(),
          quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null,
        };
      }
      return { name: part, quantity: 1 };
    })
    .filter((item) => item.name && item.quantity > 0);
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
  const parenthesisedNegative = /^\(.*\)$/.test(value);
  value = value
    .replace(/[()]/g, '')
    .replace(/\s+/g, '')
    .replace(/[^\d,.-]/g, '');

  if (!value || value === '-' || value === '.' || value === ',') {
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

  value = value.replace(/(?!^)-/g, '');
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) return { valid: false, value: 0 };
  return {
    valid: true,
    value: parenthesisedNegative ? -Math.abs(parsed) : parsed,
  };
};

const parseBoundedAmount = (raw, limits = parserLimits()) => {
  const parsed = parseCleanNumber(raw);
  if (!parsed.valid || Math.abs(parsed.value) > limits.maxAbsoluteAmount) return null;
  return parsed.value;
};

const parseQuantity = (raw, limits = parserLimits()) => {
  const parsed = parseCleanNumber(raw);
  const quantity = Math.trunc(parsed.value);
  return parsed.valid && Number.isSafeInteger(quantity) &&
    quantity > 0 && quantity <= limits.maxItemQuantity
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
  if (fileExt === 'xls') {
    return Promise.reject(new Error('Legacy XLS files are not supported. Please export as CSV or XLSX.'));
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
    const input = Readable.from(buffer);
    const parserStream = csv({
        separator: detectCsvSeparator(buffer),
        mapHeaders: ({ header, index }) => normaliseHeader(header, index),
        mapValues: ({ value }) => normaliseCell(value),
      });
    input
      .pipe(parserStream)
      .on('data', (row) => {
        if (settled) return;
        if (Object.keys(row).length > limits.maxColumns) {
          const error = createClientInputError(`File exceeds the ${limits.maxColumns} column limit`);
          parserStream.destroy(error);
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
      .on('error', fail)
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

const parseDateString = (dateStr, timeStr, timezone = DEFAULT_TIMEZONE) => {
  const value = String(dateStr).trim();

  let match = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) {
    return dateFromParts(
      parseInt(match[1], 10),
      parseInt(match[2], 10),
      parseInt(match[3], 10),
      timeStr,
      timezone
    );
  }

  match = value.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (match) {
    return dateFromParts(
      parseInt(match[3], 10),
      parseInt(match[2], 10),
      parseInt(match[1], 10),
      timeStr,
      timezone
    );
  }

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
  if (items.some((item) => !Number.isSafeInteger(item.quantity) ||
    item.quantity <= 0 || item.quantity > limits.maxItemQuantity)) {
    return { error: `Item quantity exceeds the ${limits.maxItemQuantity} limit` };
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
  const tip = mapping.tip ? parseBoundedAmount(raw[mapping.tip], limits) : 0;
  const discount = mapping.discount ? parseBoundedAmount(raw[mapping.discount], limits) : 0;
  if (tip === null || discount === null) {
    return { error: `Invalid tip or discount, or amount exceeds ${limits.maxAbsoluteAmount}` };
  }
  const totalQty = items.reduce((s, i) => s + i.quantity, 0);
  if (totalQty <= 0) return { error: 'Invalid item quantity' };
  const unitPrice = totalQty > 0 ? total / totalQty : 0;
  const row = {
    receiptId: receiptId || undefined,
    date,
    ...temporalFields(date, timezone),
    items: items.map((i) => ({ ...i, unitPrice: parseFloat(unitPrice.toFixed(2)) })),
    total,
    tip,
    discount,
    paymentMethod: paymentMethod || undefined,
    status: mapping.status ? String(raw[mapping.status] || 'approved').trim().toLowerCase() : 'approved',
  };
  return { row: setSourceRowNumbers(row, [rowNumber]) };
};

const groupLinePerRow = (rawRows, mapping, timezone) => {
  const limits = parserLimits();
  const groups = new Map();
  const rowErrors = [];
  let errors = 0;
  const totalsAreLineAmounts = /(^|\s)(line|item)(\s|$)/i.test(String(mapping.total || '').replace(/[_-]+/g, ' '));

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
      const tip = mapping.tip ? parseBoundedAmount(raw[mapping.tip], limits) : 0;
      const discount = mapping.discount ? parseBoundedAmount(raw[mapping.discount], limits) : 0;
      if (tip === null || discount === null) {
        errors++;
        addRowError(
          rowErrors,
          rowNumber,
          `Invalid tip or discount, or amount exceeds ${limits.maxAbsoluteAmount}`,
          raw
        );
        continue;
      }
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
        errors++;
        group.invalidReason =
          'Rows sharing a receipt ID have conflicting date, time, payment, status, tip, or discount values';
        addRowError(rowErrors, rowNumber, group.invalidReason, { receiptId });
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
  const rows = [];
  for (const row of groups.values()) {
    if (row.invalidReason) continue;
    const totalQty = row.items.reduce((sum, item) => sum + item.quantity, 0);
    const uniqueTotals = [...new Set(row.totals.map((total) => Number(total.toFixed(2))))];
    if (!totalsAreLineAmounts && uniqueTotals.length !== 1) {
      errors++;
      addRowError(
        rowErrors,
        row[SOURCE_ROW_NUMBERS]?.[0] || 1,
        'Rows sharing a receipt ID have conflicting receipt totals. Map a column labelled as a line/item amount when each row is a line amount.',
        { receiptId: row.receiptId }
      );
      continue;
    }
    const total = totalsAreLineAmounts
      ? row.totals.reduce((sum, value) => sum + value, 0)
      : uniqueTotals[0];
    if (!Number.isFinite(total) || Math.abs(total) > limits.maxAbsoluteAmount) {
      errors++;
      addRowError(
        rowErrors,
        row[SOURCE_ROW_NUMBERS]?.[0] || 1,
        `Transaction total exceeds the ${limits.maxAbsoluteAmount} amount limit`,
        { receiptId: row.receiptId }
      );
      continue;
    }
    const averageUnitPrice = totalQty > 0 ? parseFloat((total / totalQty).toFixed(2)) : 0;
    const { totals, invalidReason, ...cleanRow } = row;
    rows.push(setSourceRowNumbers({
      ...cleanRow,
      total,
      items: row.items.map(({ lineTotal, ...item }) => ({
        ...item,
        unitPrice: totalsAreLineAmounts && item.quantity > 0
          ? parseFloat((lineTotal / item.quantity).toFixed(2))
          : averageUnitPrice,
      })),
    }, row[SOURCE_ROW_NUMBERS] || []));
  }
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
  detectCsvSeparator,
  assertSupportedFileBuffer,
  readWorkbookRows,
  requiredFieldsForMode,
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
