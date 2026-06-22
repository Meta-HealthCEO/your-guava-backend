const fs = require('fs');
const path = require('path');
const { parseBuffer } = require('../../src/services/parser.service');

const fixture = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name));

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
  });
});
