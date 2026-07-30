const crypto = require('crypto');
const path = require('path');
const r2 = require('../../src/services/r2.service');

const R2_KEYS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
];

describe('r2 storage safety', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test-local-signing-secret-with-enough-entropy';
    process.env.API_PUBLIC_URL = 'http://localhost:5000';
    delete process.env.UPLOAD_MAX_BYTES;
    for (const key of R2_KEYS) delete process.env[key];
    r2._resetClient();
  });

  afterAll(() => {
    process.env = originalEnv;
    r2._resetClient();
  });

  it('accepts an untampered, unexpired local signed URL', async () => {
    const signedUrl = await r2.getSignedDownloadUrl('cafe/upload.csv', 60);
    const url = new URL(signedUrl);
    const filePath = r2.getLocalDownloadPath(
      url.searchParams.get('key'),
      url.searchParams.get('expires'),
      url.searchParams.get('sig')
    );

    expect(filePath).toBe(path.resolve(process.cwd(), 'uploads', 'r2', 'cafe', 'upload.csv'));
  });

  it('rejects a tampered signature with 403', async () => {
    const signedUrl = await r2.getSignedDownloadUrl('cafe/upload.csv', 60);
    const url = new URL(signedUrl);

    expect(() => r2.getLocalDownloadPath(
      url.searchParams.get('key'),
      url.searchParams.get('expires'),
      '0'.repeat(64)
    )).toThrow(expect.objectContaining({ statusCode: 403, code: 'INVALID_DOWNLOAD_SIGNATURE' }));
  });

  it('rejects an expired link with 410', () => {
    const key = 'cafe/upload.csv';
    const expires = String(Date.now() - 1000);
    const sig = crypto.createHmac('sha256', process.env.JWT_SECRET)
      .update(`${key}.${expires}`)
      .digest('hex');

    expect(() => r2.getLocalDownloadPath(key, expires, sig))
      .toThrow(expect.objectContaining({ statusCode: 410, code: 'DOWNLOAD_LINK_EXPIRED' }));
  });

  it('rejects traversal even when the traversal value has a valid signature', () => {
    const key = '../outside.csv';
    const expires = String(Date.now() + 60_000);
    const sig = crypto.createHmac('sha256', process.env.JWT_SECRET)
      .update(`${key}.${expires}`)
      .digest('hex');

    expect(() => r2.getLocalDownloadPath(key, expires, sig))
      .toThrow(expect.objectContaining({ statusCode: 403, code: 'INVALID_DOWNLOAD_LINK' }));
  });

  it('fails closed when R2 is incomplete in production', () => {
    process.env.NODE_ENV = 'production';

    expect(() => r2.useLocalStorage()).toThrow(/R2 storage is required in production/i);
  });

  it('does not silently fall back when R2 is only partially configured', () => {
    process.env.R2_BUCKET_NAME = 'test-bucket';

    expect(() => r2.useLocalStorage()).toThrow(/configuration is incomplete/i);
    expect(r2.getConfigurationStatus()).toMatchObject({ ok: false, mode: 'misconfigured' });
  });

  it('rejects oversized upload buffers before storage', async () => {
    process.env.UPLOAD_MAX_BYTES = '1024';

    await expect(r2.uploadFile(Buffer.alloc(1025), 'cafe/large.csv'))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});
