const mongoose = require('mongoose');
const PaymentSession = require('../../src/models/PaymentSession.model');
const paymentProvider = require('../../src/services/paymentProvider.service');

const base = () => ({
  orgId: new mongoose.Types.ObjectId(),
  userId: new mongoose.Types.ObjectId(),
  kind: 'credits',
  idempotencyKey: 'k-1',
  requestFingerprint: 'f-1',
  reference: 'GGC1',
  amount: 69,
  currency: 'ZAR',
});

describe('PaymentSession provider', () => {
  it('accepts every provider the resolver can select', () => {
    // The session is written with paymentProvider.providerName(), so any name
    // the resolver accepts must also be storable. When these disagreed, every
    // Paystack checkout failed validation at creation.
    for (const name of Object.keys(paymentProvider.PROVIDERS)) {
      const error = new PaymentSession({ ...base(), provider: name }).validateSync();
      expect(error?.errors?.provider).toBeUndefined();
    }
  });

  it('accepts mock, used by the local checkout path', () => {
    expect(new PaymentSession({ ...base(), provider: 'mock' }).validateSync()?.errors?.provider)
      .toBeUndefined();
  });

  it('still rejects an unknown provider', () => {
    expect(new PaymentSession({ ...base(), provider: 'nonsense' }).validateSync()?.errors?.provider)
      .toBeDefined();
  });
});
