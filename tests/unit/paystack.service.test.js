const axios = require('axios');
const paystack = require('../../src/services/paystack.service');
const paymentProvider = require('../../src/services/paymentProvider.service');

jest.mock('axios');

const ORIGINAL_ENV = { ...process.env };

describe('paystack.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_abc123';
    process.env.PAYMENT_PROVIDER = 'paystack';
    process.env.CLIENT_URL = 'http://localhost:5174';
    process.env.API_PUBLIC_URL = '';
    process.env.PORT = '5055';
  });

  afterAll(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('createPaymentKey', () => {
    it('sends the amount in cents and returns the hosted checkout url', async () => {
      axios.post.mockResolvedValue({
        data: {
          status: true,
          data: { authorization_url: 'https://checkout.paystack.com/xyz', access_code: 'xyz' },
        },
      });

      const result = await paystack.createPaymentKey({
        reference: 'GGC123',
        amount: 69,
        customerReference: 'Bean There',
        email: 'owner@example.com',
      });

      const [, body] = axios.post.mock.calls[0];
      // R69.00 must reach Paystack as 6900 cents, not 69.
      expect(body.amount).toBe(6900);
      expect(body.currency).toBe('ZAR');
      expect(body.reference).toBe('GGC123');
      expect(body.email).toBe('owner@example.com');
      expect(result).toEqual({
        key: 'xyz',
        url: 'https://checkout.paystack.com/xyz',
        origin: 'https://checkout.paystack.com',
      });
    });

    it('rounds fractional rand amounts to whole cents', async () => {
      axios.post.mockResolvedValue({
        data: { status: true, data: { authorization_url: 'https://c/1', access_code: 'a' } },
      });
      await paystack.createPaymentKey({
        reference: 'R1',
        amount: 1799.99,
        email: 'a@b.com',
      });
      expect(axios.post.mock.calls[0][1].amount).toBe(179999);
    });

    it('refuses to open checkout without a customer email', async () => {
      await expect(
        paystack.createPaymentKey({ reference: 'R1', amount: 10 })
      ).rejects.toThrow(/customer email is required/i);
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('reports a missing key as unconfigured rather than failing upstream', async () => {
      process.env.PAYSTACK_SECRET_KEY = '';
      await expect(
        paystack.createPaymentKey({ reference: 'R1', amount: 10, email: 'a@b.com' })
      ).rejects.toThrow(/not configured/i);
    });

    it('points the callback at the API so the server verifies before the customer sees an outcome', async () => {
      axios.post.mockResolvedValue({
        data: { status: true, data: { authorization_url: 'https://c/1', access_code: 'a' } },
      });
      await paystack.createPaymentKey({ reference: 'R1', amount: 10, email: 'a@b.com' });
      expect(axios.post.mock.calls[0][1].callback_url).toBe(
        'http://localhost:5055/api/account/payments/paystack/return'
      );
    });
  });

  describe('lookupGatewayTransaction', () => {
    it('normalises a successful verify onto the shape billing already reads', async () => {
      axios.get.mockResolvedValue({
        data: {
          status: true,
          data: {
            status: 'success',
            reference: 'GGC123',
            amount: 6900,
            currency: 'ZAR',
            id: 998877,
            gateway_response: 'Successful',
          },
        },
      });

      const txn = await paystack.lookupGatewayTransaction('GGC123');
      expect(txn.successful).toBe(true);
      // Cents must come back as rand so the session amount comparison holds.
      expect(txn.amount).toBe(69);
      expect(txn.merchant_reference).toBe('GGC123');
      expect(txn.gateway_reference).toBe('998877');
    });

    it('marks a failed transaction as unsuccessful', async () => {
      axios.get.mockResolvedValue({
        data: { status: true, data: { status: 'failed', reference: 'R1', amount: 100 } },
      });
      const txn = await paystack.lookupGatewayTransaction('R1');
      expect(txn.successful).toBe(false);
      expect(txn.status).toBe('failed');
    });

    it('treats an unknown reference as nothing settled rather than an error', async () => {
      axios.get.mockRejectedValue({ response: { status: 404 } });
      await expect(paystack.lookupGatewayTransaction('nope')).resolves.toBeNull();
    });
  });

  describe('key safety', () => {
    it('recognises a live key', () => {
      process.env.PAYSTACK_SECRET_KEY = 'sk_live_real';
      expect(paystack.isLiveKey()).toBe(true);
    });

    it('does not treat a test key as live', () => {
      process.env.PAYSTACK_SECRET_KEY = 'sk_test_abc';
      expect(paystack.isLiveKey()).toBe(false);
    });
  });
});

describe('paymentProvider resolver', () => {
  afterAll(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('selects paystack when PAYMENT_PROVIDER says so', () => {
    process.env.PAYMENT_PROVIDER = 'paystack';
    expect(paymentProvider.getProvider().name).toBe('paystack');
    expect(paymentProvider.isHostedCheckoutEnabled()).toBe(true);
  });

  it('keeps onegate reachable for an environment still pointed at it', () => {
    process.env.PAYMENT_PROVIDER = 'onegate';
    expect(paymentProvider.getProvider().name).toBe('onegate');
  });

  it('reports no hosted provider for mock or unset, so callers fall through to mock checkout', () => {
    process.env.PAYMENT_PROVIDER = 'mock';
    expect(paymentProvider.getProvider()).toBeNull();
    expect(paymentProvider.isHostedCheckoutEnabled()).toBe(false);
    delete process.env.PAYMENT_PROVIDER;
    expect(paymentProvider.isHostedCheckoutEnabled()).toBe(false);
  });

  it('verifies a session against the provider that created it, not the current env', () => {
    // Switching providers must not strand payments that are already in flight.
    process.env.PAYMENT_PROVIDER = 'paystack';
    expect(paymentProvider.providerForSession({ provider: 'onegate' }).name).toBe('onegate');
    expect(paymentProvider.providerForSession({ provider: 'paystack' }).name).toBe('paystack');
  });

  it('falls back to onegate for sessions written before the provider was recorded', () => {
    delete process.env.PAYMENT_PROVIDER;
    expect(paymentProvider.providerForSession({}).name).toBe('onegate');
  });
});
