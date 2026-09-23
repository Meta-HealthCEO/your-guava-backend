const mongoose = require('mongoose');
const { setup, teardown, clearDB } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');
const { computeDedupKey } = require('../../src/utils/dedupKey');
const {
  transactionIdentity, identityComparisonKey, findExistingIdentities, chunksOf,
} = require('../../src/services/transactionIdentity');

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

const ZONE = 'Africa/Johannesburg';
// 23:30 UTC on 26 Sep is 01:30 on 27 Sep in Johannesburg.
const lateSale = {
  receiptId: '#0001',
  date: new Date('2026-09-26T23:30:00Z'),
  total: 38,
  items: [{ name: 'Flat White', quantity: 1 }],
};

describe('services/transactionIdentity, the one identity rule (BE-11-T05)', () => {
  it('scopes a receipt to the cafe-local trading day when the row has no dateKey', () => {
    const identity = transactionIdentity(lateSale, 'fp', ZONE);
    expect(identity).toEqual({ type: 'receiptId', value: '#0001', dayKey: '2026-09-27' });
    expect(identityComparisonKey(identity)).toBe('receiptId:#0001|2026-09-27');
  });

  it('keeps the stored dedup key of a receipt-less row exactly as before the move', () => {
    const row = { ...lateSale, receiptId: undefined, __sourceRowNumbers: [2] };
    expect(transactionIdentity(row, 'fp', ZONE)).toEqual({
      type: 'dedupKey',
      value: computeDedupKey({
        date: '2026-09-26', time: '23:30', total: 38, items: row.items, sourceFingerprint: 'fp', sourceRowNumbers: [2],
      }),
    });
  });

  it('finds stored identities by trading day and can leave out the upload being remapped', async () => {
    const cafeId = new mongoose.Types.ObjectId();
    const uploadA = new mongoose.Types.ObjectId();
    const uploadB = new mongoose.Types.ObjectId();
    const base = { cafeId, date: lateSale.date, dayOfWeek: 0, hour: 1, total: 38, items: lateSale.items, status: 'approved', source: 'csv' };
    await Transaction.create([
      { ...base, uploadId: uploadA, receiptId: '#0001' },
      { ...base, uploadId: uploadB, dedupKey: 'abc' },
    ]);
    const wanted = [transactionIdentity(lateSale, 'fp', ZONE), { type: 'dedupKey', value: 'abc' }];
    const all = await findExistingIdentities(cafeId, wanted, { timezone: ZONE });
    expect([...all].sort()).toEqual(['dedupKey:abc', 'receiptId:#0001|2026-09-27']);
    const withoutA = await findExistingIdentities(cafeId, wanted, { timezone: ZONE, excludeUploadId: uploadA });
    expect([...withoutA]).toEqual(['dedupKey:abc']);
  });

  it('queries in chunks of 500', () => {
    expect(chunksOf(Array.from({ length: 1001 }, (_, index) => index)).map((chunk) => chunk.length)).toEqual([500, 500, 1]);
  });
});
