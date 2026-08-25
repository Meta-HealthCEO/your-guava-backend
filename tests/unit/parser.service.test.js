const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
  parseBuffer,
  zonedDayStart,
  assertSupportedFileBuffer,
} = require('../../src/services/parser.service');

const fixture = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name));

const buildStoredZip = (entries) => {
  const localChunks = [];
  const centralChunks = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name || '[Content_Types].xml');
    const data = Buffer.from(entry.data || 'x');
    const flags = entry.flags || 0;
    const compressionMethod = entry.compressionMethod || 0;
    const compressedSize = entry.compressedSize ?? data.length;
    const uncompressedSize = entry.uncompressedSize ?? data.length;
    const crcData = Buffer.from(entry.crcData ?? data);
    const crc = zlib.crc32(crcData) >>> 0;
    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(entry.versionNeeded || 20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(compressionMethod, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    data.copy(local, 30 + name.length);
    localChunks.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(entry.versionNeeded || 20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(compressionMethod, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralChunks.push(central);
    localOffset += local.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localChunks, centralDirectory, end]);
};

describe('parser.service', () => {
  describe('packed itemsMode', () => {
    const mapping = {
      receiptId: 'Txn Number',
      date: 'Sale Date',
      time: 'Sale Time',
      items: 'Description',
      total: 'Amount',
    };

    it('parses generic POS CSV into normalised transaction rows', async () => {
      const buf = fixture('test-generic-pos.csv');
      const result = await parseBuffer(buf, { columnMapping: mapping, itemsMode: 'packed' });

      expect(result.rows).toHaveLength(3);
      expect(result.rows[0]).toMatchObject({
        receiptId: 'A001',
        total: 75,
        items: [
          { name: 'Flat White', quantity: 2 },
          { name: 'Muffin', quantity: 1 },
        ],
      });
      expect(result.rows[0].date).toBeInstanceOf(Date);
    });

    it('returns dateRange spanning earliest to latest row', async () => {
      const buf = fixture('test-generic-pos.csv');
      const result = await parseBuffer(buf, { columnMapping: mapping, itemsMode: 'packed' });
      expect(result.dateRange.firstDate.toISOString().slice(0, 10)).toBe('2026-04-01');
      expect(result.dateRange.lastDate.toISOString().slice(0, 10)).toBe('2026-04-01');
    });

    it('parses South African day-first date strings explicitly', async () => {
      const csv = 'Txn Number,Sale Date,Sale Time,Description,Amount\nA006,31/01/2026,10:15,Flat White,35.00';
      const result = await parseBuffer(Buffer.from(csv), { columnMapping: mapping, itemsMode: 'packed' });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].date.getFullYear()).toBe(2026);
      expect(result.rows[0].date.getMonth()).toBe(0);
      expect(result.rows[0].date.getDate()).toBe(31);
      expect(result.rows[0].hour).toBe(10);
    });

    it('interprets wall-clock timestamps in the cafe timezone', async () => {
      const csv = 'Txn Number,Sale Date,Sale Time,Description,Amount\nA009,2026-04-01,23:30,Flat White,35.00';
      const result = await parseBuffer(Buffer.from(csv), {
        columnMapping: mapping,
        itemsMode: 'packed',
        timezone: 'Africa/Johannesburg',
      });

      expect(result.rows[0].date.toISOString()).toBe('2026-04-01T21:30:00.000Z');
      expect(result.rows[0].hour).toBe(23);
      expect(result.rows[0].dayOfWeek).toBe(3);
    });

    it('normalises BOM/whitespace headers and comma-decimal currency values', async () => {
      const csv = '\uFEFF Sale Date , Sale Time , Description , Amount \n2026-04-01,09:30,Flat White,"R 1 234,56"';
      const result = await parseBuffer(Buffer.from(csv), { columnMapping: {
        date: 'Sale Date',
        time: 'Sale Time',
        items: 'Description',
        total: 'Amount',
      }, itemsMode: 'packed' });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].total).toBe(1234.56);
      expect(result.rows[0].items[0].unitPrice).toBe(1234.56);
      expect(result.rows[0].hour).toBe(9);
    });

    it('detects semicolon-delimited CSV exports', async () => {
      const csv = 'Txn Number;Sale Date;Sale Time;Description;Amount\nA008;2026-04-01;09:30;Flat White;R 35,00';
      const result = await parseBuffer(Buffer.from(csv), { columnMapping: mapping, itemsMode: 'packed' });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].receiptId).toBe('A008');
      expect(result.rows[0].total).toBe(35);
    });

    it('treats plain item descriptions as quantity-one items', async () => {
      const csv = 'Txn Number,Sale Date,Sale Time,Description,Amount\nA004,2026/04/01,10:00,Flat White,35.00';
      const result = await parseBuffer(Buffer.from(csv), { columnMapping: mapping, itemsMode: 'packed' });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].items).toEqual([
        { name: 'Flat White', quantity: 1, unitPrice: 35 },
      ]);
    });

    it('repairs unquoted comma-separated item cells before parsing later columns', async () => {
      const yocoMapping = {
        receiptId: 'Receipt',
        date: 'Date',
        time: 'Time',
        items: 'Items',
        total: 'Total (incl. tax)',
        tip: 'Tip',
        discount: 'Discount',
        paymentMethod: 'Payment Method',
        status: 'Status',
      };
      const buf = fixture('test-transactions.csv');
      const result = await parseBuffer(buf, { columnMapping: yocoMapping, itemsMode: 'packed' });

      const receipt = result.rows.find((row) => row.receiptId === '2026/01/000005');
      expect(receipt.total).toBe(159);
      expect(receipt.items).toEqual([
        { name: 'Brownie', quantity: 3, unitPrice: 39.75 },
        { name: 'Espresso (Blend)', quantity: 1, unitPrice: 39.75 },
      ]);
    });

    it('treats empty item descriptions as parse errors', async () => {
      const csv = 'Txn Number,Sale Date,Sale Time,Description,Amount\nA005,2026/04/01,10:00,,35.00';
      const result = await parseBuffer(Buffer.from(csv), { columnMapping: mapping, itemsMode: 'packed' });

      expect(result.rows).toHaveLength(0);
      expect(result.errors).toBe(1);
      expect(result.rowErrors).toEqual([
        expect.objectContaining({
          rowNumber: 2,
          reason: 'Missing or invalid items',
          raw: expect.objectContaining({ Description: '' }),
        }),
      ]);
    });

    it('treats impossible times as parse errors', async () => {
      const csv = 'Txn Number,Sale Date,Sale Time,Description,Amount\nA007,2026/04/01,25:99,Flat White,35.00';
      const result = await parseBuffer(Buffer.from(csv), { columnMapping: mapping, itemsMode: 'packed' });

      expect(result.rows).toHaveLength(0);
      expect(result.errors).toBe(1);
      expect(result.rowErrors).toEqual([
        expect.objectContaining({
          rowNumber: 2,
          reason: 'Could not parse date or time',
          raw: expect.objectContaining({ 'Sale Time': '25:99' }),
        }),
      ]);
    });
  });

  describe('line-per-row itemsMode', () => {
    it('groups line items by receiptId into single transactions', async () => {
      const mapping = {
        receiptId: 'Receipt',
        date: 'Date',
        time: 'Time',
        items: 'Item',
        total: 'Total',
      };
      const buf = fixture('test-line-per-row.csv');
      const result = await parseBuffer(buf, {
        columnMapping: { ...mapping, quantity: 'Qty' },
        itemsMode: 'line-per-row',
      });

      expect(result.rows).toHaveLength(2);
      const r100 = result.rows.find((r) => r.receiptId === 'R100');
      expect(r100.items).toEqual([
        { name: 'Flat White', quantity: 2, unitPrice: 25 },
        { name: 'Muffin', quantity: 1, unitPrice: 25 },
      ]);
      expect(r100.total).toBe(75);
    });

    it('requires a receipt ID mapping for line-per-row imports', async () => {
      const buf = fixture('test-line-per-row.csv');

      await expect(
        parseBuffer(buf, {
          columnMapping: {
            date: 'Date',
            time: 'Time',
            items: 'Item',
            total: 'Total',
            quantity: 'Qty',
          },
          itemsMode: 'line-per-row',
        })
      ).rejects.toThrow(/receiptId/i);
    });

    it('treats blank receipt IDs as row errors in line-per-row mode', async () => {
      const mapping = {
        receiptId: 'Receipt',
        date: 'Date',
        time: 'Time',
        items: 'Item',
        total: 'Line Total',
        quantity: 'Qty',
      };
      const csv = 'Receipt,Date,Time,Item,Qty,Line Total\n,2026-04-01,08:30,Flat White,1,35.00';

      const result = await parseBuffer(Buffer.from(csv), {
        columnMapping: mapping,
        itemsMode: 'line-per-row',
      });

      expect(result.rows).toHaveLength(0);
      expect(result.errors).toBe(1);
      expect(result.rowErrors).toEqual([
        expect.objectContaining({
          rowNumber: 2,
          reason: 'Missing receipt ID',
          raw: expect.objectContaining({ Receipt: '' }),
        }),
      ]);
    });

    it('sums line totals when rows provide item-level amounts', async () => {
      const mapping = {
        receiptId: 'Receipt',
        date: 'Date',
        time: 'Time',
        items: 'Item',
        total: 'Line Total',
        quantity: 'Qty',
      };
      const csv = [
        'Receipt,Date,Time,Item,Qty,Line Total',
        'R200,2026-04-01,08:30,Flat White,2,50.00',
        'R200,2026-04-01,08:30,Muffin,1,25.00',
      ].join('\n');

      const result = await parseBuffer(Buffer.from(csv), {
        columnMapping: mapping,
        itemsMode: 'line-per-row',
      });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].total).toBe(75);
      expect(result.rows[0].items).toEqual([
        { name: 'Flat White', quantity: 2, unitPrice: 25 },
        { name: 'Muffin', quantity: 1, unitPrice: 25 },
      ]);
    });

    it('preserves item-level unit prices from line total columns', async () => {
      const mapping = {
        receiptId: 'Receipt',
        date: 'Date',
        time: 'Time',
        items: 'Item',
        total: 'Line Total',
        quantity: 'Qty',
      };
      const csv = [
        'Receipt,Date,Time,Item,Qty,Line Total',
        'R201,2026-04-01,08:30,Flat White,2,70.00',
        'R201,2026-04-01,08:30,Muffin,1,25.00',
      ].join('\n');

      const result = await parseBuffer(Buffer.from(csv), {
        columnMapping: mapping,
        itemsMode: 'line-per-row',
      });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].total).toBe(95);
      expect(result.rows[0].items).toEqual([
        { name: 'Flat White', quantity: 2, unitPrice: 35 },
        { name: 'Muffin', quantity: 1, unitPrice: 25 },
      ]);
    });

    it('rejects non-positive line quantities', async () => {
      const mapping = {
        receiptId: 'Receipt',
        date: 'Date',
        time: 'Time',
        items: 'Item',
        total: 'Line Total',
        quantity: 'Qty',
      };
      const csv = 'Receipt,Date,Time,Item,Qty,Line Total\nR202,2026-04-01,08:30,Flat White,0,70.00';

      const result = await parseBuffer(Buffer.from(csv), {
        columnMapping: mapping,
        itemsMode: 'line-per-row',
      });

      expect(result.rows).toHaveLength(0);
      expect(result.errors).toBe(1);
      expect(result.rowErrors).toEqual([
        expect.objectContaining({
          rowNumber: 2,
          reason: 'Invalid item quantity',
          raw: expect.objectContaining({ Qty: '0' }),
        }),
      ]);
    });
  });

  describe('error cases', () => {
    it('throws when required fields are unmapped', async () => {
      const buf = fixture('test-generic-pos.csv');
      await expect(
        parseBuffer(buf, { columnMapping: { date: 'Sale Date' }, itemsMode: 'packed' })
      ).rejects.toThrow(/required.*items|required.*total/i);
    });

    it('returns errors for unparseable date rows', async () => {
      const csv = 'Date,Items,Total\nnot-a-date,1 x Foo,10';
      const result = await parseBuffer(Buffer.from(csv), {
        columnMapping: { date: 'Date', items: 'Items', total: 'Total' },
        itemsMode: 'packed',
      });
      expect(result.errors).toBeGreaterThanOrEqual(1);
      expect(result.rowErrors).toEqual([
        expect.objectContaining({
          rowNumber: 2,
          reason: 'Could not parse date or time',
        }),
      ]);
      expect(result.rows).toHaveLength(0);
    });

    it.each([
      {
        label: 'oversized quantities',
        csv: 'Date,Items,Total\n2026-04-01,10001 x Foo,10',
        reason: /quantity exceeds/i,
      },
      {
        label: 'oversized monetary values',
        csv: 'Date,Items,Total\n2026-04-01,1 x Foo,10000001',
        reason: /amount exceeds/i,
      },
      {
        label: 'missing monetary values',
        csv: 'Date,Items,Total\n2026-04-01,1 x Foo,',
        reason: /invalid transaction total/i,
      },
      {
        label: 'scientific-notation monetary values',
        csv: 'Date,Items,Total\n2026-04-01,1 x Foo,1e999',
        reason: /invalid transaction total/i,
      },
      {
        label: 'oversized canonical item names',
        csv: `Date,Items,Total\n2026-04-01,1 x ${'x'.repeat(201)},10`,
        reason: /item name exceeds/i,
      },
    ])('rejects $label before they can poison analytics', async ({ csv, reason }) => {
      const result = await parseBuffer(Buffer.from(csv), {
        columnMapping: { date: 'Date', items: 'Items', total: 'Total' },
        itemsMode: 'packed',
      });

      expect(result.rows).toHaveLength(0);
      expect(result.errors).toBe(1);
      expect(result.rowErrors[0].reason).toMatch(reason);
    });

    it('rejects a grouped receipt whose line totals exceed the transaction amount bound', async () => {
      const csv = [
        'Receipt,Date,Item,Qty,Line Total',
        'R-LARGE,2026-04-01,Foo,1,6000000',
        'R-LARGE,2026-04-01,Bar,1,6000000',
      ].join('\n');
      const result = await parseBuffer(Buffer.from(csv), {
        columnMapping: {
          receiptId: 'Receipt',
          date: 'Date',
          items: 'Item',
          quantity: 'Qty',
          total: 'Line Total',
        },
        itemsMode: 'line-per-row',
      });

      expect(result.rows).toHaveLength(0);
      expect(result.rowErrors).toEqual([
        expect.objectContaining({ reason: expect.stringMatching(/transaction total exceeds/i) }),
      ]);
    });

    it('rejects conflicting receipt totals instead of guessing that they are line amounts', async () => {
      const csv = [
        'Receipt,Date,Time,Item,Qty,Total',
        'R-conflict,2026-04-01,08:30,Flat White,1,35.00',
        'R-conflict,2026-04-01,08:30,Muffin,1,25.00',
      ].join('\n');
      const result = await parseBuffer(Buffer.from(csv), {
        columnMapping: {
          receiptId: 'Receipt',
          date: 'Date',
          time: 'Time',
          items: 'Item',
          quantity: 'Qty',
          total: 'Total',
        },
        itemsMode: 'line-per-row',
      });

      expect(result.rows).toHaveLength(0);
      expect(result.rowErrors).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: expect.stringMatching(/conflicting receipt totals/i) }),
      ]));
    });

    // This case used two different DATES and expected rejection, on the model
    // that a receipt ID identifies one sale globally. That holds for exports
    // with globally unique references (Yoco numbers receipts year/month/
    // sequence), but line-per-row exists for arbitrary tills and plenty restart
    // their order numbers each morning -- rejecting those blocked the cafe from
    // importing at all. A reused number on a different day is now read as a
    // different sale. The protection this test exists for is unchanged, and is
    // asserted here with a contradiction inside a single day.
    it('rejects rows that reuse a receipt ID with conflicting transaction metadata', async () => {
      const csv = [
        'Receipt,Date,Time,Item,Qty,Line Total',
        'R-reused,2026-04-01,08:30,Flat White,1,35.00',
        'R-reused,2026-04-01,14:45,Muffin,1,25.00',
      ].join('\n');
      const result = await parseBuffer(Buffer.from(csv), {
        columnMapping: {
          receiptId: 'Receipt',
          date: 'Date',
          time: 'Time',
          items: 'Item',
          quantity: 'Qty',
          total: 'Line Total',
        },
        itemsMode: 'line-per-row',
      });

      expect(result.rows).toHaveLength(0);
      expect(result.rowErrors).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: expect.stringMatching(/conflicting date/i) }),
      ]));
    });

    it('stops parsing when the configured row bound is exceeded', async () => {
      const previous = process.env.UPLOAD_MAX_ROWS;
      process.env.UPLOAD_MAX_ROWS = '1';
      const csv = 'Date,Items,Total\n2026-04-01,1 x Foo,10\n2026-04-02,1 x Bar,12';
      try {
        await expect(parseBuffer(Buffer.from(csv), {
          columnMapping: { date: 'Date', items: 'Items', total: 'Total' },
          itemsMode: 'packed',
        })).rejects.toThrow(/row limit/i);
      } finally {
        if (previous == null) delete process.env.UPLOAD_MAX_ROWS;
        else process.env.UPLOAD_MAX_ROWS = previous;
      }
    });

    it('rejects uploads whose calendar span exceeds the configured bound', async () => {
      const previous = process.env.UPLOAD_MAX_DATE_RANGE_DAYS;
      process.env.UPLOAD_MAX_DATE_RANGE_DAYS = '1';
      const csv = 'Date,Items,Total\n2026-04-01,1 x Foo,10\n2026-04-02,1 x Bar,12';
      try {
        await expect(parseBuffer(Buffer.from(csv), {
          columnMapping: { date: 'Date', items: 'Items', total: 'Total' },
          itemsMode: 'packed',
        })).rejects.toThrow(/date range/i);
      } finally {
        if (previous == null) delete process.env.UPLOAD_MAX_DATE_RANGE_DAYS;
        else process.env.UPLOAD_MAX_DATE_RANGE_DAYS = previous;
      }
    });

    it('rejects binary content presented as CSV', async () => {
      await expect(parseBuffer(Buffer.from([0x50, 0x4b, 0x00, 0x01]), {
        columnMapping: { date: 'Date', items: 'Items', total: 'Total' },
        itemsMode: 'packed',
      })).rejects.toThrow(/binary data/i);
    });

    it('does not normalize impossible date-only boundaries', () => {
      expect(zonedDayStart('2026-02-30', 'Africa/Johannesburg')).toBeNull();
    });
  });

  describe('XLSX archive preflight', () => {
    it('accepts a small, well-formed ZIP archive', () => {
      const archive = buildStoredZip([{ name: '[Content_Types].xml', data: '<Types />' }]);

      expect(() => assertSupportedFileBuffer(archive, 'xlsx')).not.toThrow();
    });

    it('rejects suspicious compression ratios before decompression', () => {
      const archive = buildStoredZip([{
        name: 'xl/worksheets/sheet1.xml',
        data: 'x',
        compressedSize: 1,
        uncompressedSize: 500000,
      }]);

      expect(() => assertSupportedFileBuffer(archive, 'xlsx')).toThrow(/compression-ratio/i);
    });

    it('rejects deflate streams that lie about their expanded size', () => {
      const compressed = zlib.deflateRawSync(Buffer.from('x'.repeat(5000)));
      const archive = buildStoredZip([{
        name: 'xl/worksheets/sheet1.xml',
        data: compressed,
        compressionMethod: 8,
        uncompressedSize: 1,
        crcData: Buffer.from('x'.repeat(5000)),
      }]);

      expect(() => assertSupportedFileBuffer(archive, 'xlsx')).toThrow(/safely decompressed/i);
    });

    it('rejects entries whose content does not match the declared CRC', () => {
      const archive = buildStoredZip([{
        name: 'xl/workbook.xml',
        data: 'actual',
        crcData: Buffer.from('different'),
      }]);

      expect(() => assertSupportedFileBuffer(archive, 'xlsx')).toThrow(/CRC checksum/i);
    });

    it('rejects encrypted archive entries', () => {
      const archive = buildStoredZip([{
        name: 'xl/workbook.xml',
        data: 'x',
        flags: 0x0001,
      }]);

      expect(() => assertSupportedFileBuffer(archive, 'xlsx')).toThrow(/unsafe ZIP features/i);
    });

    it('rejects ZIP64 end records', () => {
      const archive = buildStoredZip([{ name: 'xl/workbook.xml', data: 'x' }]);
      archive.writeUInt16LE(0xffff, archive.length - 12);

      expect(() => assertSupportedFileBuffer(archive, 'xlsx')).toThrow(/ZIP64/i);
    });

    it('enforces the configured archive entry bound', () => {
      const previous = process.env.XLSX_MAX_ENTRIES;
      process.env.XLSX_MAX_ENTRIES = '1';
      const archive = buildStoredZip([
        { name: '[Content_Types].xml', data: 'x' },
        { name: 'xl/workbook.xml', data: 'x' },
      ]);
      try {
        expect(() => assertSupportedFileBuffer(archive, 'xlsx')).toThrow(/entry limit/i);
      } finally {
        if (previous == null) delete process.env.XLSX_MAX_ENTRIES;
        else process.env.XLSX_MAX_ENTRIES = previous;
      }
    });

    it('rejects traversal entry names even in otherwise valid archives', () => {
      const archive = buildStoredZip([{ name: '../outside.xml', data: 'x' }]);

      expect(() => assertSupportedFileBuffer(archive, 'xlsx')).toThrow(/unsafe entry name/i);
    });
  });
});

describe('parsePackedItems fractional quantities', () => {
  const { parsePackedItems } = require('../../src/services/parser.service');

  // Cafes that sell by weight -- deli counters, bakeries, beans by the kilo --
  // export rows like "0.35 x Cheese Wheel". The quantity pattern used to match
  // only digits, so the engine skipped past "0." and read the decimal part as
  // the whole quantity: 0.35 became 35, a hundredfold overstatement that then
  // flowed into forecasts, revenue and the learning calibration.
  it('reads a sub-unit weight as a fraction, not as its decimal digits', () => {
    expect(parsePackedItems('0.35 x Cheese Wheel')).toEqual([
      { name: 'Cheese Wheel', quantity: 0.35 },
    ]);
  });

  it('keeps the whole part of a quantity greater than one', () => {
    expect(parsePackedItems('1.5 x Biltong')).toEqual([{ name: 'Biltong', quantity: 1.5 }]);
    expect(parsePackedItems('2.25 x Coffee Beans')).toEqual([
      { name: 'Coffee Beans', quantity: 2.25 },
    ]);
  });

  it('still parses ordinary whole quantities', () => {
    expect(parsePackedItems('1 x Flat White')).toEqual([{ name: 'Flat White', quantity: 1 }]);
    expect(parsePackedItems('2 x Brownie,1 x Muffin')).toEqual([
      { name: 'Brownie', quantity: 2 },
      { name: 'Muffin', quantity: 1 },
    ]);
  });

  it('splits a mixed row of whole and fractional lines', () => {
    expect(parsePackedItems('2 x Flat White,0.5 x Carrot Cake')).toEqual([
      { name: 'Flat White', quantity: 2 },
      { name: 'Carrot Cake', quantity: 0.5 },
    ]);
  });

  it('does not mistake a decimal point inside an item name for a quantity', () => {
    expect(parsePackedItems('1 x Still Water 1.5L')).toEqual([
      { name: 'Still Water 1.5L', quantity: 1 },
    ]);
  });

  it('ignores a zero quantity rather than importing it', () => {
    expect(parsePackedItems('0 x Refunded Item')).toEqual([]);
    expect(parsePackedItems('0.0 x Voided Item')).toEqual([]);
  });
});

describe('line-per-row receipt grouping across days', () => {
  const { groupLinePerRow } = require('../../src/services/parser.service');
  const mapping = {
    receiptId: 'Receipt', date: 'Date', time: 'Time',
    items: 'Item', total: 'Total', quantity: 'Qty',
  };
  const row = (receipt, date, item) => ({
    Receipt: receipt, Date: date, Time: '09:00:00', Item: item, Qty: '1', Total: '50.00',
  });

  it('keeps the same receipt number on different days as separate sales', () => {
    // Most tills restart order numbers each morning, so "#0001" recurs daily.
    // Keyed on the receipt alone those rows collided, the differing dates were
    // reported as conflicting, and the whole import was rejected.
    const { rows, errors } = groupLinePerRow(
      [
        row('#0001', '2026-08-22', 'Flat White'),
        row('#0001', '2026-08-23', 'Flat White'),
        row('#0001', '2026-08-24', 'Muffin'),
      ],
      mapping,
      'Africa/Johannesburg'
    );

    expect(rows).toHaveLength(3);
    expect(errors).toBe(0);
  });

  it('still groups the lines of one receipt within a single day', () => {
    const { rows } = groupLinePerRow(
      [row('#0007', '2026-08-22', 'Flat White'), row('#0007', '2026-08-22', 'Croissant')],
      mapping,
      'Africa/Johannesburg'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].items).toHaveLength(2);
  });

  it('still rejects a receipt whose rows contradict each other within one day', () => {
    // The protection that matters is preserved: genuinely contradictory rows
    // for one sale are still refused rather than merged.
    const conflicting = [
      { ...row('#0009', '2026-08-22', 'Flat White'), Time: '09:00:00' },
      { ...row('#0009', '2026-08-22', 'Croissant'), Time: '14:30:00' },
    ];
    const { errors, rowErrors } = groupLinePerRow(conflicting, mapping, 'Africa/Johannesburg');
    expect(errors).toBeGreaterThan(0);
    expect(rowErrors.some((e) => /conflicting/i.test(e.reason))).toBe(true);
  });
});
