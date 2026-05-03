const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let client = null;

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
  const cmd = new GetObjectCommand({ Bucket: bucket(), Key: key });
  return getSignedUrl(getClient(), cmd, { expiresIn: ttlSeconds });
};

/**
 * Deletes an object from R2. Idempotent.
 * @param {string} key
 * @returns {Promise<void>}
 */
const deleteFile = async (key) => {
  await getClient().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
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
  _resetClient,
};
