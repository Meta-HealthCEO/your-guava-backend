const crypto = require('crypto');
const mongoose = require('mongoose');
const { setup, teardown, clearDB } = require('../setup');
const Item = require('../../src/models/Item.model');
const Transaction = require('../../src/models/Transaction.model');
const { syncOrders, verifyWebhookSignature } = require('../../src/services/yoco.service');

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  delete process.env.YOCO_WEBHOOK_SECRET;
  await clearDB();
});

const signWebhook = (secret, id, timestamp, body) => {
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return crypto
    .createHmac('sha256', secretBytes)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
};

describe('yoco.service', () => {
  describe('verifyWebhookSignature', () => {
    const secret = `whsec_${Buffer.from('test-webhook-secret-key').toString('base64')}`;

    const reqFor = ({ body = { event_type: 'other.event' }, headers = {}, rawBody } = {}) => ({
      body,
      headers,
      rawBody: rawBody ?? Buffer.from(JSON.stringify(body)),
    });

    it('rejects webhooks when no secret is configured', () => {
      const result = verifyWebhookSignature(reqFor());
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/not configured/i);
    });

    it('rejects webhooks without signature headers', () => {
      process.env.YOCO_WEBHOOK_SECRET = secret;
      const result = verifyWebhookSignature(reqFor());
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/missing/i);
    });

    it('rejects webhooks with an invalid signature', () => {
      process.env.YOCO_WEBHOOK_SECRET = secret;
      const result = verifyWebhookSignature(reqFor({
        headers: {
          'webhook-id': 'msg_1',
          'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
          'webhook-signature': 'v1,bm90LWEtcmVhbC1zaWduYXR1cmU=',
        },
      }));
      expect(result.valid).toBe(false);
    });

    it('accepts webhooks with a valid signature', () => {
      process.env.YOCO_WEBHOOK_SECRET = secret;
      const body = JSON.stringify({ event_type: 'other.event' });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = signWebhook(secret, 'msg_1', timestamp, body);

      const result = verifyWebhookSignature(reqFor({
        rawBody: Buffer.from(body),
        headers: {
          'webhook-id': 'msg_1',
          'webhook-timestamp': timestamp,
          'webhook-signature': `v1,${signature}`,
        },
      }));

      expect(result.valid).toBe(true);
    });

    it('rejects webhooks with a stale timestamp', () => {
      process.env.YOCO_WEBHOOK_SECRET = secret;
      const body = JSON.stringify({ event_type: 'other.event' });
      const staleTimestamp = String(Math.floor(Date.now() / 1000) - 3600);
      const signature = signWebhook(secret, 'msg_1', staleTimestamp, body);

      const result = verifyWebhookSignature(reqFor({
        rawBody: Buffer.from(body),
        headers: {
          'webhook-id': 'msg_1',
          'webhook-timestamp': staleTimestamp,
          'webhook-signature': `v1,${signature}`,
        },
      }));

      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/timestamp/i);
    });
  });

  it('does not inflate item totals when duplicate orders are synced', async () => {
    const cafeId = new mongoose.Types.ObjectId();
    const order = {
      id: 'order-1',
      created_at: '2026-04-01T08:30:00Z',
      line_items: [
        {
          item_type: 'product',
          name: 'Flat White',
          quantity: 2,
          unit_price: { amount: 3500 },
        },
      ],
      amounts: {
        gross_amount: { amount: 7000 },
      },
      payments: [{ payment_method: 'card' }],
    };

    const first = await syncOrders(cafeId, [order]);
    const second = await syncOrders(cafeId, [order]);

    expect(first.imported).toBe(1);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
    expect(await Transaction.countDocuments({ cafeId })).toBe(1);

    const item = await Item.findOne({ cafeId, name: 'Flat White' }).lean();
    expect(item.totalSold).toBe(2);
    expect(item.avgPrice).toBe(35);
    expect(item.category).toBe('coffee');
  });
});
