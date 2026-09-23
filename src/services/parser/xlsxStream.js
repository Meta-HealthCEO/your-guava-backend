// Streaming XLSX reader (BE-01-T04): the SAX handler, shared-string and sheet-cell streams, part-size and cell budgets.
// Moved from parser.service.js by BE-11-T01; behaviour unchanged.
const { createClientInputError } = require('./limits');

const path = require('path');

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
  const parseCellCoordinates = step('xlsx/parseCellCoordinates.js');
  readerSteps = {
    unpackXlsxFile: step('export/unpackXlsxFileNode.js'),
    xml: step('xml/xml.js'),
    parseFilePaths: step('xlsx/parseFilePaths.js'),
    parseStyles: step('xlsx/parseStyles.js'),
    parseSpreadsheetInfo: step('xlsx/parseSpreadsheetInfo.js'),
    parseCellValue: step('xlsx/parseCellValue.js'),
    parseCellCoordinates,
    // parseSheetDimensions, applied to the `<dimension ref>` string itself.
    parseSheetDimensionsRef: (ref) => {
      const parsed = ref.split(':').map(parseCellCoordinates).map(([row, column]) => ({ row, column }));
      return parsed.length === 1 ? [parsed[0], parsed[0]] : parsed;
    },
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

// ---------------------------------------------------------------------------
// Streaming sheet reader (BE-01-T04). read-excel-file builds a DOM of sheet 1
// and of the shared-string table before it looks at a single cell, and that
// DOM costs about 3 KB per element: a real 10,000 x 16 export needed ~450 MB
// and a 20 MB sheet entry, which the archive guard allows, ~1.5 GB - enough to
// take the API down with a well-formed file. The two parts are read here with
// the same SAX reader the DOM was built from (@xmldom/xmldom's XMLReader), so
// every tag, attribute and entity is read exactly as before, but only the
// cells are kept, and the read stops at the cell budget. Cell values still go
// through the reader's own parseCellValue.
let xmldomLib = null;
const loadXmldom = () => {
  if (xmldomLib) return xmldomLib;
  const readerDir = path.dirname(require.resolve('read-excel-file/node'));
  const lib = path.dirname(require.resolve('@xmldom/xmldom', { paths: [readerDir] }));
  const load = (file) => {
    try {
      return require(path.join(lib, file));
    } catch (error) {
      throw new Error(`@xmldom/xmldom no longer ships ${file}; the streaming sheet reader was written against 0.9 (${error.message})`);
    }
  };
  const { XMLReader } = load('sax.js');
  const { XML_ENTITIES } = load('entities.js');
  const { NAMESPACE } = load('conventions.js');
  const { ParseError } = load('errors.js');
  if (typeof XMLReader !== 'function' || !XML_ENTITIES || !NAMESPACE || typeof ParseError !== 'function') {
    throw new Error('@xmldom/xmldom internals changed; the streaming sheet reader was written against 0.9');
  }
  xmldomLib = { XMLReader, XML_ENTITIES, NAMESPACE, ParseError };
  return xmldomLib;
};

// What DOMParser does to the source before the reader sees it. Built from char
// codes: a raw U+2028 inside a regex literal is a line terminator, and the
// source-hygiene test forbids raw control bytes in src.
const XML_NEL = String.fromCharCode(0x85);
const XML_LINE_SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const XML_CRLF_RE = new RegExp('\\r[\\n' + XML_NEL + ']', 'g');
const XML_NEWLINE_RE = new RegExp('[\\r' + XML_NEL + XML_LINE_SEPARATORS + ']', 'g');
const normaliseXmlLineEndings = (input) => input.replace(XML_CRLF_RE, '\n').replace(XML_NEWLINE_RE, '\n');

// The minimum the reader needs from its "DOM builder": a document with a root,
// a current element, and the SAX callbacks. Elements are plain records on a
// stack; text is collected only for the element a subclass asked for.
class XlsxSaxHandler {
  constructor(xmldom) {
    this.xmldom = xmldom;
    this.mimeType = 'text/xml';
    this.locator = undefined;
    this.stack = [];
    this.currentElement = null;
    this.doc = { documentElement: null, createTextNode: (data) => ({ nodeType: 3, data }), appendChild() {} };
    this.collecting = null;
  }

  startDocument() {}
  endDocument() {}
  setDocumentLocator() {}
  startPrefixMapping() {}
  endPrefixMapping() {}
  processingInstruction() {}
  comment() {}
  startCDATA() {}
  endCDATA() {}
  startDTD() {}
  endDTD() {}
  warning() {}
  error() {} // DOMParser logs recoverable errors and carries on; so does this.
  fatalError(message, cause) { throw new this.xmldom.ParseError(message, undefined, cause); }

  startElement(namespaceUri, localName, qName, attributes) {
    // createElementNS refused a prefixed element whose prefix is undeclared.
    if (qName.indexOf(':') > 0 && !namespaceUri) {
      throw new this.xmldom.ParseError('Error constructing the DOM: NamespaceError: prefix is non-null and namespace is null');
    }
    const parent = this.stack.length ? this.stack[this.stack.length - 1] : null;
    const element = { tagName: qName, localName, parent, firstElementChild: null };
    if (parent && !parent.firstElementChild) parent.firstElementChild = element;
    if (!this.doc.documentElement) this.doc.documentElement = element;
    this.guard(() => this.open(element, attributes));
    this.stack.push(element);
    this.currentElement = element;
  }

  endElement() {
    const element = this.stack.pop();
    this.currentElement = this.stack.length ? this.stack[this.stack.length - 1] : null;
    if (this.collecting && this.collecting.element === element) {
      const { text } = this.collecting;
      this.collecting = null;
      this.guard(() => this.close(element, text));
    } else {
      this.guard(() => this.close(element, undefined));
    }
  }

  // The reader treats any exception from its builder as a recoverable "element
  // parse error" and carries on; a refusal (the cell budget) or a value the
  // reader's own parseCellValue rejects must stop the read instead.
  guard(fn) {
    try {
      fn();
    } catch (error) {
      if (error instanceof this.xmldom.ParseError) throw error;
      const abort = new this.xmldom.ParseError(String(error && error.message ? error.message : error), undefined, error);
      abort.abortedBy = error;
      throw abort;
    }
  }

  characters(chars, start, length) {
    if (this.collecting) this.collecting.text += String(chars).substr(start, length);
  }

  // textContent of `element`: every text node below it until it closes.
  collect(element) {
    if (!this.collecting) this.collecting = { element, text: '' };
  }

  parse(source) {
    const { XMLReader, XML_ENTITIES, NAMESPACE } = this.xmldom;
    const reader = new XMLReader();
    reader.domBuilder = this;
    reader.errorHandler = this;
    try {
      reader.parse(normaliseXmlLineEndings(String(source)), { '': null, xml: NAMESPACE.XML }, XML_ENTITIES);
    } catch (error) {
      if (error && error.abortedBy) throw error.abortedBy; // the refusal or the reader's own value error, as thrown
      throw error;
    }
    if (!this.doc.documentElement) this.fatalError('missing root element');
  }
}

const xlsxAttribute = (attributes, name) => {
  for (let index = 0; index < attributes.length; index += 1) {
    if (attributes.getQName(index) === name) return attributes.getValue(index);
  }
  return null; // getAttribute() of an absent attribute
};

/**
 * `<sst><si>...</si></sst>` as the reader's getSharedStrings reads it: each
 * `<si>` is the text of its first direct `<t>`, or else its direct `<r>` runs'
 * first `<t>`s joined. Memory is the strings themselves, never a DOM.
 */
const streamXlsxSharedStrings = (xml) => {
  const strings = [];
  class SharedStringsHandler extends XlsxSaxHandler {
    open(element) {
      const { parent } = element;
      if (!parent) return;
      if (!parent.parent && element.localName === 'si') {
        element.si = { directText: undefined, runs: [], sawDirectT: false };
        return;
      }
      if (parent.si && element.localName === 't' && !parent.si.sawDirectT) {
        parent.si.sawDirectT = true;
        element.role = 'si-t';
        this.collect(element);
        return;
      }
      if (parent.si && element.localName === 'r') {
        element.run = { text: null, sawT: false };
        parent.si.runs.push(element.run);
        return;
      }
      if (parent.run && element.localName === 't' && !parent.run.sawT) {
        parent.run.sawT = true;
        element.role = 'run-t';
        this.collect(element);
      }
    }

    close(element, text) {
      if (element.role === 'si-t') element.parent.si.directText = text;
      else if (element.role === 'run-t') element.parent.run.text = text;
      else if (element.si) {
        if (element.si.sawDirectT) strings.push(element.si.directText);
        else {
          let value = '';
          for (const run of element.si.runs) {
            if (run.text == null) throw new TypeError("Cannot read properties of undefined (reading 'textContent')");
            value += run.text;
          }
          strings.push(value);
        }
      }
    }
  }
  new SharedStringsHandler(loadXmldom()).parse(xml);
  return strings;
};

const xlsxCellBudget = (limits) => (limits.maxRows + 1) * limits.maxColumns;

const xlsxBudgetError = (row, column, limits) => {
  if (row > limits.maxRows + 1) return createClientInputError(`File exceeds the ${limits.maxRows} row limit`);
  if (column > limits.maxColumns) return createClientInputError(`File exceeds the ${limits.maxColumns} column limit`);
  return createClientInputError(`File exceeds the ${xlsxCellBudget(limits)} cell limit`);
};

/**
 * Sheet 1's cells and dimension as the reader's parseCells and
 * parseSheetDimensions produce them, read as a stream: only `<c>` directly
 * under a `<row>` directly under the first `<sheetData>` count, values come
 * from the first direct `<v>` or the first `<is>`'s first `<t>`, and the read
 * stops with the row- or column-limit message once the budget is exceeded.
 */
const streamXlsxSheetCells = (xml, { sharedStrings, styles, epoch1904, options, limits }) => {
  const { parseCellValue, parseCellCoordinates, parseSheetDimensionsRef, reconstructSheetDimensions } = loadReaderSteps();
  const cells = [];
  const budget = xlsxCellBudget(limits);
  let dimensionRef = null;
  let sheetData = null;
  class SheetHandler extends XlsxSaxHandler {
    open(element, attributes) {
      const { parent } = element;
      if (!parent) return;
      if (!parent.parent) {
        if (element.localName === 'dimension' && dimensionRef === null) dimensionRef = xlsxAttribute(attributes, 'ref');
        if (element.localName === 'sheetData' && !sheetData) sheetData = element;
        return;
      }
      if (parent === sheetData && element.localName === 'row') { element.isRow = true; return; }
      if (parent.isRow && element.localName === 'c') {
        element.cell = {
          reference: xlsxAttribute(attributes, 'r'), type: xlsxAttribute(attributes, 't'), styleId: xlsxAttribute(attributes, 's'),
          value: undefined, sawValue: false, inlineText: undefined, // no <v>: undefined, as findChild returns
        };
        return;
      }
      if (parent.cell) {
        if (element.localName === 'v' && !parent.cell.sawValue) {
          parent.cell.sawValue = true;
          element.role = 'v';
          this.collect(element);
        } else if (element.localName === 'is' && parent.firstElementChild === element) {
          element.isInline = true;
        }
        return;
      }
      if (parent.isInline && element.localName === 't' && parent.firstElementChild === element) {
        element.role = 'is-t';
        this.collect(element);
      }
    }

    close(element, text) {
      if (element.role === 'v') { element.parent.cell.value = text; return; }
      if (element.role === 'is-t') { element.parent.parent.cell.inlineText = text; return; }
      if (!element.cell) return;
      const { cell } = element;
      const [row, column] = parseCellCoordinates(cell.reference);
      if (cells.length >= budget) throw xlsxBudgetError(row, column, limits);
      cells.push({
        row,
        column,
        value: parseCellValue(cell.value, cell.type, {
          getInlineStringValue: () => cell.inlineText,
          getInlineStringXml: () => `<c r="${cell.reference}" t="${cell.type}">...</c>`,
          getStyleId: () => cell.styleId,
          styles,
          sharedStrings,
          epoch1904,
          options,
        }),
      });
    }
  }
  new SheetHandler(loadXmldom()).parse(xml);
  // As parseSheetDimensions: undefined without a <dimension ref>; the caller reconstructs from the cells.
  return { cells, dimensions: dimensionRef ? parseSheetDimensionsRef(dimensionRef) : undefined };
};

const xlsxPartTooLargeError = (partName, size, limits) => {
  const error = createClientInputError(
    `This spreadsheet's ${partName} is ${Math.round(size / 1048576)} MB, far larger than a spreadsheet's should be, so it was not read. `
    + 'Save it again from Excel, or export it as "CSV UTF-8", and upload that.'
  );
  error.code = 'XLSX_PART_TOO_LARGE';
  return error;
};

const assertXlsxPartSize = (partName, content, limits) => {
  if (content && content.length > limits.xlsxMaxPartBytes) throw xlsxPartTooLargeError(partName, content.length, limits);
  return content;
};

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

module.exports = {
  loadReaderSteps, XLSX_MAX_SHEET_COST, loadXmldom, streamXlsxSharedStrings, streamXlsxSheetCells, xlsxPartTooLargeError,
  assertXlsxPartSize, xlsxUnreadableError,
};
