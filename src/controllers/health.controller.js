const mongoose = require('mongoose');
const packageJson = require('../../package.json');

const DB_STATES = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

const requiredEnvReady = () =>
  ['JWT_SECRET', 'JWT_REFRESH_SECRET'].every((key) => Boolean(process.env[key]));

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

const readiness = (req, res) => {
  const databaseState = DB_STATES[mongoose.connection.readyState] || 'unknown';
  const checks = {
    database: {
      ok: mongoose.connection.readyState === 1,
      state: databaseState,
    },
    environment: {
      ok: requiredEnvReady(),
      required: ['JWT_SECRET', 'JWT_REFRESH_SECRET'],
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
