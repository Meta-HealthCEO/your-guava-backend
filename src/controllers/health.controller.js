const mongoose = require('mongoose');
const packageJson = require('../../package.json');
const r2 = require('../services/r2.service');
const validateEnv = require('../config/validateEnv');

const DB_STATES = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

const requiredEnvNames = () => [
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'MONGODB_URI',
  ...(process.env.NODE_ENV === 'production'
    ? ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']
    : []),
];

const databaseCapability = async () => {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    return { ok: false, transactionCapable: false };
  }
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    const transactionCapable = Boolean(hello.setName) || hello.msg === 'isdbgrid';
    return {
      ok: transactionCapable,
      transactionCapable,
      topology: hello.msg === 'isdbgrid' ? 'sharded' : hello.setName ? 'replica_set' : 'standalone',
    };
  } catch (error) {
    return { ok: false, transactionCapable: false, state: 'probe_failed' };
  }
};

const basePayload = (req) => ({
  service: 'your-guava-api',
  version: packageJson.version,
  environment: process.env.NODE_ENV || 'development',
  uptimeSeconds: Math.round(process.uptime()),
  requestId: req.id,
});

const health = (req, res) => {
  res.status(200).json({
    success: true,
    status: 'ok',
    message: 'Your Guava API is running',
    ...basePayload(req),
  });
};

const readiness = async (req, res) => {
  const databaseState = DB_STATES[mongoose.connection.readyState] || 'unknown';
  const database = await databaseCapability();
  const required = requiredEnvNames();
  const storage = typeof r2.getConfigurationStatus === 'function'
    ? r2.getConfigurationStatus()
    : { ok: true, configured: true, mode: 'test-double', missing: [] };
  let environmentValid = true;
  try {
    validateEnv();
  } catch (error) {
    environmentValid = false;
  }
  const checks = {
    database: {
      ...database,
      state: databaseState,
    },
    environment: {
      ok: environmentValid && required.every((key) => Boolean(process.env[key])),
      state: environmentValid ? 'valid' : 'invalid',
      required,
    },
    storage: {
      ok: storage.ok,
      configured: storage.configured,
      mode: storage.mode,
      missing: storage.missing,
    },
  };
  const ready = Object.values(checks).every((check) => check.ok);

  res.status(ready ? 200 : 503).json({
    success: ready,
    status: ready ? 'ready' : 'not_ready',
    ...basePayload(req),
    checks,
  });
};

module.exports = {
  health,
  readiness,
};
