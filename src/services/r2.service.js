const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let client = null;

const localRoot = () => path.join(process.cwd(), 'uploads', 'r2');

const useLocalStorage = () =>
  !process.env.R2_ACCOUNT_ID ||
  !process.env.R2_ACCESS_KEY_ID ||
  !process.env.R2_SECRET_ACCESS_KEY ||
  !process.env.R2_BUCKET_NAME;

const localPathForKey = (key) => {
  const root = path.resolve(localRoot());
  const target = path.resolve(root, key);
  if (!target.startsWith(root + path.sep)) {
    throw new Error('Invalid storage key');
  }
  return target;
};

const signLocalUrl = (key, expires) => {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be set to sign local download URLs');
  }
  return crypto
    .createHmac('sha256', process.env.JWT_SECRET)
    .update(`${key}.${expires}`)
    .digest('hex');
};

const getClient = () => {
  if (client) return client;
  const accountId = process.env.R2_ACCOUNT_ID;
  if (!accountId) {
    throw new Error('R2_ACCOUNT_ID is not set');
  }
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return client;
};

const bucket = () => process.env.R2_BUCKET_NAME;

/**
 * Uploads a buffer to R2 under the given key.
 * @param {Buffer} buffer
 * @param {string} key
 * @param {string} contentType
 * @returns {Promise<void>}
 */
const uploadFile = async (buffer, key, contentType = 'application/octet-stream') => {
  if (useLocalStorage()) {
    const target = localPathForKey(key);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, buffer);
    return;
  }

  await getClient().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );
};

/**
 * Downloads a file from R2 as a Buffer.
 * @param {string} key
 * @returns {Promise<Buffer>}
 */
const downloadFile = async (key) => {
  if (useLocalStorage()) {
    return fs.promises.readFile(localPathForKey(key));
  }

  const res = await getClient().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

/**
 * Returns a signed URL for downloading the object.
 * @param {string} key
 * @param {number} ttlSeconds default 900 (15 min)
 * @returns {Promise<string>}
 */
const getSignedDownloadUrl = async (key, ttlSeconds = 900) => {
  if (useLocalStorage()) {
    const expires = Date.now() + ttlSeconds * 1000;
    const sig = signLocalUrl(key, expires);
    const baseUrl = process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 5000}`;
    return `${baseUrl}/api/uploads/local-download?key=${encodeURIComponent(key)}&expires=${expires}&sig=${sig}`;
  }

  const cmd = new GetObjectCommand({ Bucket: bucket(), Key: key });
  return getSignedUrl(getClient(), cmd, { expiresIn: ttlSeconds });
};

/**
 * Deletes an object from R2. Idempotent.
 * @param {string} key
 * @returns {Promise<void>}
 */
const deleteFile = async (key) => {
  if (useLocalStorage()) {
    await fs.promises.rm(localPathForKey(key), { force: true });
    return;
  }

  await getClient().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
};

const getLocalDownloadPath = (key, expires, sig) => {
  if (!useLocalStorage()) {
    throw new Error('Local storage download is disabled');
  }
  if (!key || !expires || !sig || Number(expires) < Date.now()) {
    throw new Error('Download link expired');
  }
  const expected = signLocalUrl(key, expires);
  const sigBuffer = Buffer.from(sig);
  const expectedBuffer = Buffer.from(expected);
  const valid =
    sigBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  if (!valid) {
    throw new Error('Invalid download signature');
  }
  return localPathForKey(key);
};

/**
 * Resets the cached client. Used by tests.
 */
const _resetClient = () => {
  client = null;
};

module.exports = {
  uploadFile,
  downloadFile,
  getSignedDownloadUrl,
  deleteFile,
  getLocalDownloadPath,
  useLocalStorage,
  _resetClient,
};
