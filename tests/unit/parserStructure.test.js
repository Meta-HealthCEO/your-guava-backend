const fs = require('fs');
const path = require('path');

// BE-11-T01: parser.service.js became a re-export barrel over focused modules.
// Line counts use wc -l semantics (newline characters), so they match the card's check.
const SRC = path.resolve(__dirname, '../../src');
const lineCount = (relative) => (fs.readFileSync(path.join(SRC, relative), 'utf8').match(/\n/g) || []).length;

const PARSER_MODULES = [
  'limits', 'rowErrors', 'headers', 'numbers', 'xlsxArchive', 'fileType',
  'xlsx', 'dates', 'lineItems', 'packedItems', 'csv', 'parse',
];

describe('parser module structure (BE-11-T01)', () => {
  it('keeps parser.service.js a barrel: under 60 lines and no function of its own', () => {
    const source = fs.readFileSync(path.join(SRC, 'services/parser.service.js'), 'utf8');
    expect(lineCount('services/parser.service.js')).toBeLessThan(60);
    expect(source).not.toMatch(/=>|function\s/);
  });

  it('has every focused module the split promises', () => {
    const missing = PARSER_MODULES.filter((name) => !fs.existsSync(path.join(SRC, `services/parser/${name}.js`)));
    expect(missing).toEqual([]);
    expect(fs.existsSync(path.join(SRC, 'utils/timezone.js'))).toBe(true);
  });

  it('re-exports the functions its modules define, not copies of them', () => {
    const barrel = require('../../src/services/parser.service');
    expect(barrel.parseBuffer).toBe(require('../../src/services/parser/parse').parseBuffer);
    expect(barrel.groupLinePerRow).toBe(require('../../src/services/parser/lineItems').groupLinePerRow);
    expect(barrel.parsePackedItems).toBe(require('../../src/services/parser/packedItems').parsePackedItems);
    expect(barrel.readWorkbook).toBe(require('../../src/services/parser/xlsx').readWorkbook);
    expect(barrel.assertSupportedFileBuffer).toBe(require('../../src/services/parser/fileType').assertSupportedFileBuffer);
    expect(barrel.zonedDayStart).toBe(require('../../src/utils/timezone').zonedDayStart);
  });
});
