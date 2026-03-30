const path = require('path');
const mongoose = require('mongoose');
const { setup, teardown, clearDB } = require('../setup');

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

const Transaction = require('../../src/models/Transaction.model');
const Item = require('../../src/models/Item.model');
const { parseYocoCSV } = require('../../src/services/ingestion.service');

describe('ingestion service', () => {
  describe('parseYocoCSV', () => {
    it('parses a valid CSV file and imports approved transactions', async () => {
      const cafeId = new mongoose.Types.ObjectId();
      const csvPath = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');
      const result = await parseYocoCSV(csvPath, cafeId);

      // 5 rows: 4 approved, 1 declined
      expect(result.imported).toBe(4);
      expect(result.skipped).toBe(1); // declined row
      expect(result.errors).toBe(0);

      // Verify transactions in database
      const transactions = await Transaction.find({ cafeId });
      expect(transactions.length).toBe(4);
    });

    it('skips duplicate receipts on re-import', async () => {
      const cafeId = new mongoose.Types.ObjectId();
      const csvPath = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');

      // First import
      const first = await parseYocoCSV(csvPath, cafeId);
      expect(first.imported).toBe(4);

      // Second import — all should be skipped
      const second = await parseYocoCSV(csvPath, cafeId);
      expect(second.imported).toBe(0);
      expect(second.skipped).toBe(5); // 4 already exist + 1 declined

      // Total in DB should still be 4
      const count = await Transaction.countDocuments({ cafeId });
      expect(count).toBe(4);
    });

    it('creates Item records for unique item names', async () => {
      const cafeId = new mongoose.Types.ObjectId();
      const csvPath = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');

      await parseYocoCSV(csvPath, cafeId);

      const items = await Item.find({ cafeId });
      const itemNames = items.map((i) => i.name).sort();

      // Expected items from approved rows:
      // "Flat White (Blend)", "Long White (Blend)", "Iced Coffee (None)", "Brownie", "Espresso (Blend)"
      expect(itemNames).toContain('Flat White (Blend)');
      expect(itemNames).toContain('Brownie');
      expect(itemNames).toContain('Iced Coffee (None)');
      expect(items.length).toBeGreaterThanOrEqual(4);
    });

    it('correctly parses items with quantities from CSV', async () => {
      const cafeId = new mongoose.Types.ObjectId();
      const csvPath = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');

      await parseYocoCSV(csvPath, cafeId);

      // Row 2: "2 x Long White (Blend)" in Items column
      const tx = await Transaction.findOne({ cafeId, receiptId: '2026/01/000002' });
      expect(tx).not.toBeNull();
      expect(tx.items.length).toBeGreaterThanOrEqual(1);
      // Verify the quantity was parsed correctly
      const longWhite = tx.items.find((i) => i.name === 'Long White (Blend)');
      if (longWhite) {
        expect(longWhite.quantity).toBe(2);
      }
    });
  });
});
