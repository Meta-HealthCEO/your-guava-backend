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
        { name: 'Flat White', quantity: 2 },
        { name: 'Muffin', quantity: 1 },
      ]);
      expect(r100.total).toBe(75);
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
      expect(result.rows).toHaveLength(0);
    });
  });
});
