/**
 * Minimal, valid .xlsx packages built in memory with no library. Tests need
 * workbooks no spreadsheet program writes on request: a declared size of a
 * million rows, a cell at the last coordinate, one enormous shared string
 * used by every row. Entries are stored by default; `deflate` compresses them.
 */
const zlib = require('node:zlib');

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const PACKAGE_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOC_RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const buildZip = (entries, { deflate = false } = {}) => {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name);
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const body = deflate ? zlib.deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const crc = zlib.crc32(raw) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

const escapeXml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const columnName = (index) => {
  let name = '';
  let rest = index;
  do {
    name = String.fromCharCode(65 + (rest % 26)) + name;
    rest = Math.floor(rest / 26) - 1;
  } while (rest >= 0);
  return name;
};

const sheetXml = (dimension, body) => [
  XML_HEAD, `<worksheet xmlns="${MAIN_NS}">`, dimension ? `<dimension ref="${dimension}"/>` : '',
  `<sheetData>${body}</sheetData></worksheet>`,
].join('');

// secondSheet adds a tab named "Raw" (xl/worksheets/sheet2.xml, rId3) after
// "Sales"; the import never reads it. workbookComment puts an XML comment in
// xl/workbook.xml, which a regex cannot read the way an XML parser does.
const xlsxWith = (rows, {
  dimension, sharedStrings = false, extraRowsXml = '', deflate = false, secondSheet, workbookComment = false,
} = {}) => {
  const strings = new Map();
  const cell = (value, ref) => {
    if (value == null || value === '') return '';
    if (!sharedStrings) return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
    if (!strings.has(value)) strings.set(value, strings.size);
    return `<c r="${ref}" t="s"><v>${strings.get(value)}</v></c>`;
  };
  const rowsXml = rows
    .map((row, r) => `<row r="${r + 1}">${row.map((value, c) => cell(value, `${columnName(c)}${r + 1}`)).join('')}</row>`)
    .join('');
  const workbookRels = [
    `${XML_HEAD}<Relationships xmlns="${PACKAGE_RELS}">`,
    `<Relationship Id="rId1" Type="${DOC_RELS}/worksheet" Target="worksheets/sheet1.xml"/>`,
    sharedStrings ? `<Relationship Id="rId2" Type="${DOC_RELS}/sharedStrings" Target="sharedStrings.xml"/>` : '',
    secondSheet ? `<Relationship Id="rId3" Type="${DOC_RELS}/worksheet" Target="worksheets/sheet2.xml"/>` : '',
    '</Relationships>',
  ].join('');
  const sheets = `<sheet name="Sales" sheetId="1" r:id="rId1"/>${secondSheet ? '<sheet name="Raw" sheetId="2" r:id="rId3"/>' : ''}`;
  const workbook = [
    `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${DOC_RELS}">`,
    workbookComment ? '<!-- saved by a test -->' : '',
    `<sheets>${sheets}</sheets></workbook>`,
  ].join('');
  const entries = [
    { name: '[Content_Types].xml', data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>` },
    { name: '_rels/.rels', data: `${XML_HEAD}<Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="rId1" Type="${DOC_RELS}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(dimension, `${rowsXml}${extraRowsXml}`) },
  ];
  if (secondSheet) {
    entries.push({ name: 'xl/worksheets/sheet2.xml', data: sheetXml(secondSheet.dimension, secondSheet.rowsXml || '') });
  }
  if (sharedStrings) {
    const items = [...strings.keys()].map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`).join('');
    entries.push({ name: 'xl/sharedStrings.xml', data: `${XML_HEAD}<sst xmlns="${MAIN_NS}" count="${strings.size}" uniqueCount="${strings.size}">${items}</sst>` });
  }
  return buildZip(entries, { deflate });
};

module.exports = { buildZip, xlsxWith, columnName };
