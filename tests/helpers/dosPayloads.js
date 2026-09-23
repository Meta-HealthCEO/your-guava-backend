/**
 * Every crafted input BE-01 defends against, built in one place. The UAT
 * fixtures F29 and F32-F35 (backend-90/tools/gen-fixtures.mjs) have the same
 * shapes, so a UAT failure has a unit-sized reproduction here.
 */
const { xlsxWith, buildZip } = require('./xlsx');

const LF = String.fromCharCode(10);
const HEADER = ['Receipt', 'Date', 'Items', 'Total'];
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

const hostileEmail = (dots) => `a@${'.'.repeat(dots)}@`;
const singleLineCsv = (bytes) => Buffer.concat([Buffer.from(`Receipt,Items${LF}`), Buffer.alloc(bytes, ',')]);
const emailHeaderCsv = (dots) => Buffer.from(`${hostileEmail(dots)},b${LF}1,2${LF}`);
const dimensionBombXlsx = () => xlsxWith([HEADER], { dimension: 'A1:XFD1048576', deflate: true });
const coordinateBombXlsx = (ref = 'XFD1048576') => xlsxWith([HEADER], {
  extraRowsXml: `<row r="1048576"><c r="${ref}" t="inlineStr"><is><t>x</t></is></c></row>`, deflate: true,
});
const unterminatedTagsXlsx = () => xlsxWith([HEADER], { extraRowsXml: '<c '.repeat(350_000) });
// Exactly 10,000 characters, as F34's ADVERSARIAL_ITEMS in gen-fixtures.mjs.
const ADVERSARIAL_ITEMS_CELL = `${'1'.repeat(5000)} x ${'a'.repeat(4995)}${LF}z`;
const REPEATED_MARKERS_CELL = `${'1 x '.repeat(2495)}${LF}z`;
const PACKED_ITEMS_XLSX_CELL = `1 x Flat White${LF}${'1'.repeat(4990)} x ${'a'.repeat(4990)}${LF}z`;
// The same 10,000 bytes per row in a benign shape (BE-01-T05's control): what a 10 KB cell costs the import regardless of the grammar.
const BENIGN_10K_CELL = `1 x Flat White${'\n'.repeat(9985)}z`;

const packedItemsXlsx = (rowCount, cell = PACKED_ITEMS_XLSX_CELL, prefix = 'P') => {
  const rows = [['Receipt', 'Date', 'Time', 'Items', 'Total']];
  for (let index = 0; index < rowCount; index += 1) {
    const time = `${String(8 + Math.floor(index / 1000)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`;
    rows.push([`${prefix}${index}`, '2026-04-01', time, cell, '38.00']);
  }
  return xlsxWith(rows, { sharedStrings: true });
};

// BE-01-T04 (re-scoped): a well-formed workbook whose sheet XML is 17 MB (the
// reader's DOM of it was ~1.1 GB), and one whose styles part is 16 MB of
// distinct elements, inside the archive guard's entry and ratio limits.
const heavySheetXlsx = () => {
  const rows = [Array.from({ length: 25 }, (_, index) => `C${index}`)];
  for (let r = 0; r < 9_999; r += 1) rows.push(Array.from({ length: 25 }, () => 'x'));
  return xlsxWith(rows, { deflate: true });
};
const stylesBombXlsx = () => buildZip([
  { name: '[Content_Types].xml', data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
  { name: '_rels/.rels', data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
  { name: 'xl/workbook.xml', data: `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>` },
  { name: 'xl/_rels/workbook.xml.rels', data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
  { name: 'xl/worksheets/sheet1.xml', data: `${XML_HEAD}<worksheet xmlns="${MAIN_NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Receipt</t></is></c></row></sheetData></worksheet>` },
  { name: 'xl/styles.xml', data: `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}"><cellXfs count="1"><xf numFmtId="0"/></cellXfs>${Array.from({ length: 1_000_000 }, (_, i) => `<x i="${i * 7}"/>`).join('')}</styleSheet>` },
], { deflate: true });

const longName = (seed) => `${'a'.repeat(190)}${String(seed).padStart(10, '0')}`;
const craftedMenu = (cafeId, normalize) => [
  ...Array.from({ length: 100 }, (_, c) => {
    const aliases = Array.from({ length: 50 }, (_, a) => longName(c * 1000 + a + 1));
    return {
      cafeId, name: longName(c * 1000), normalizedName: normalize(longName(c * 1000)), aliases,
      aliasKeys: aliases.map(normalize), reviewStatus: 'matched', totalSold: 1000 - c, isActive: true,
    };
  }),
  ...Array.from({ length: 100 }, (_, index) => ({
    cafeId, name: longName(900_000 + index), normalizedName: normalize(longName(900_000 + index)),
    reviewStatus: 'needs_review', totalSold: 1, isActive: true,
  })),
];

const RESERVED_NAMES_MAPPING = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total' };
const RESERVED_NAMES_CSV = [
  'Receipt,Date,Time,Items,Total',
  'R1,2026-04-01,08:30,"1 x __proto__,1 x Latte",60.00',
  'R2,2026-04-02,09:00,2 x constructor,40.00',
  'R3,2026-04-03,10:00,"1 x prototype,1 x Latte",55.00',
  'R4,2026-04-09,08:30,3 x __proto__,90.00',
  'R5,2026-04-10,09:15,1 x constructor,20.00',
  // F29 also names the other Object.prototype members.
  'R6,2026-04-10,10:00,"1 x hasOwnProperty,1 x toString,1 x valueOf",45.00',
].join(LF);

module.exports = {
  hostileEmail, singleLineCsv, emailHeaderCsv, dimensionBombXlsx, coordinateBombXlsx, unterminatedTagsXlsx,
  ADVERSARIAL_ITEMS_CELL, REPEATED_MARKERS_CELL, PACKED_ITEMS_XLSX_CELL, BENIGN_10K_CELL, packedItemsXlsx,
  heavySheetXlsx, stylesBombXlsx, craftedMenu, RESERVED_NAMES_CSV, RESERVED_NAMES_MAPPING,
};
