require('dotenv').config();

process.env.TZ = process.env.TZ || process.env.DEFAULT_TIMEZONE || 'Africa/Johannesburg';

const mongoose = require('mongoose');
const app = require('./app');
const connectDB = require('./config/db');
const validateEnv = require('./config/validateEnv');
const { cleanupAbandonedPendingUploads } = require('./controllers/uploads.controller');
const PaymentSession = require('./models/PaymentSession.model');
const TeamInvitation = require('./models/TeamInvitation.model');
const UsageLedger = require('./models/UsageLedger.model');
const { reconcilePendingOneGatePayments } = require('./services/billingPayments.service');
const { reconcileStaleUsageReservations } = require('./services/usage.service');

const PORT = process.env.PORT || 5000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_PAYMENT_RECONCILIATION_INTERVAL_MS = 60 * 1000;
const DEFAULT_USAGE_RECONCILIATION_INTERVAL_MS = 60 * 1000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10 * 1000;

const boundedInteger = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
};

let httpServer;
let cleanupTimer;
let cleanupPromise;
let paymentReconciliationTimer;
let paymentReconciliationPromise;
let usageReconciliationTimer;
let usageReconciliationPromise;
let shutdownPromise;

const runPendingUploadCleanup = () => {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    try {
      const summary = await cleanupAbandonedPendingUploads();
      if (summary.deleted > 0 || summary.storageRetried > 0 || summary.failed > 0) {
        console.log('[uploads] abandoned upload cleanup:', summary);
      }
    } catch (error) {
      console.error('[uploads] abandoned upload cleanup failed:', error.message);
    }
  })().finally(() => {
    cleanupPromise = undefined;
  });
  return cleanupPromise;
};

const schedulePendingUploadCleanup = () => {
  void runPendingUploadCleanup();
  const intervalMs = boundedInteger(
    process.env.UPLOAD_CLEANUP_INTERVAL_MS,
    DEFAULT_CLEANUP_INTERVAL_MS,
    5 * 60 * 1000,
    24 * 60 * 60 * 1000
  );
  cleanupTimer = setInterval(() => void runPendingUploadCleanup(), intervalMs);
  cleanupTimer.unref();
};

const runPaymentReconciliation = () => {
  if (paymentReconciliationPromise) return paymentReconciliationPromise;
  if (process.env.PAYMENT_PROVIDER !== 'onegate') return Promise.resolve();
  paymentReconciliationPromise = (async () => {
    try {
      const summary = await reconcilePendingOneGatePayments();
      if (summary.paid > 0 || summary.failed > 0 || summary.errors > 0) {
        console.log('[billing] pending payment reconciliation:', summary);
      }
    } catch (error) {
      console.error('[billing] pending payment reconciliation failed:', error.message);
    }
  })().finally(() => {
    paymentReconciliationPromise = undefined;
  });
  return paymentReconciliationPromise;
};

const schedulePaymentReconciliation = () => {
  if (process.env.PAYMENT_PROVIDER !== 'onegate') return;
  void runPaymentReconciliation();
  const intervalMs = boundedInteger(
    process.env.PAYMENT_RECONCILIATION_INTERVAL_MS,
    DEFAULT_PAYMENT_RECONCILIATION_INTERVAL_MS,
    30 * 1000,
    60 * 60 * 1000
  );
  paymentReconciliationTimer = setInterval(() => void runPaymentReconciliation(), intervalMs);
  paymentReconciliationTimer.unref();
};

const runUsageReconciliation = () => {
  if (usageReconciliationPromise) return usageReconciliationPromise;
  usageReconciliationPromise = (async () => {
    try {
      const summary = await reconcileStaleUsageReservations();
      if (summary.refunded > 0 || summary.errors > 0) {
        console.log('[billing] stale usage reconciliation:', summary);
      }
    } catch (error) {
      console.error('[billing] stale usage reconciliation failed:', error.message);
    }
  })().finally(() => {
    usageReconciliationPromise = undefined;
  });
  return usageReconciliationPromise;
};

const scheduleUsageReconciliation = () => {
  void runUsageReconciliation();
  const intervalMs = boundedInteger(
    process.env.USAGE_RECONCILIATION_INTERVAL_MS,
    DEFAULT_USAGE_RECONCILIATION_INTERVAL_MS,
    30 * 1000,
    60 * 60 * 1000
  );
  usageReconciliationTimer = setInterval(() => void runUsageReconciliation(), intervalMs);
  usageReconciliationTimer.unref();
};

const cleanupFailedStart = async () => {
  const partialServer = httpServer;
  httpServer = undefined;
  if (partialServer?.listening) {
    await new Promise((resolve) => partialServer.close(() => resolve()));
  }
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
};

const start = async () => {
  if (httpServer) return httpServer;
  try {
    validateEnv();
    await connectDB();
    // Exactly-once guarantees depend on these unique indexes. Do not accept
    // traffic until MongoDB confirms they exist.
    await Promise.all([PaymentSession.init(), TeamInvitation.init(), UsageLedger.init()]);
    httpServer = app.listen(PORT);
    const candidateServer = httpServer;
    await new Promise((resolve, reject) => {
      const onListening = () => {
        candidateServer.off('error', onError);
        resolve();
      };
      const onError = (error) => {
        candidateServer.off('listening', onListening);
        reject(error);
      };
      candidateServer.once('listening', onListening);
      candidateServer.once('error', onError);
    });
    console.log(`Your Guava API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
    schedulePendingUploadCleanup();
    schedulePaymentReconciliation();
    scheduleUsageReconciliation();
    return httpServer;
  } catch (error) {
    try {
      await cleanupFailedStart();
    } catch (cleanupError) {
      console.error('[server] startup cleanup failed:', cleanupError.message);
    }
    throw error;
  }
};

const shutdown = async (signal = 'shutdown', { exitProcess = false } = {}) => {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    console.log(`[server] ${signal} received; draining connections`);
    if (cleanupTimer) clearInterval(cleanupTimer);
    if (paymentReconciliationTimer) clearInterval(paymentReconciliationTimer);
    if (usageReconciliationTimer) clearInterval(usageReconciliationTimer);

    const timeoutMs = boundedInteger(
      process.env.SHUTDOWN_TIMEOUT_MS,
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
      1000,
      60 * 1000
    );
    let timedOut = false;
    let timeoutHandle;
    const timeout = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (typeof httpServer?.closeAllConnections === 'function') httpServer.closeAllConnections();
        resolve();
      }, timeoutMs);
      timeoutHandle.unref();
    });
    const closeResources = (async () => {
      if (httpServer) {
        if (typeof httpServer.closeIdleConnections === 'function') httpServer.closeIdleConnections();
        await new Promise((resolve) => httpServer.close(() => resolve()));
      }
      await Promise.allSettled(
        [cleanupPromise, paymentReconciliationPromise, usageReconciliationPromise].filter(Boolean)
      );
      if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    })();

    await Promise.race([closeResources, timeout]);
    clearTimeout(timeoutHandle);
    if (timedOut) console.error(`[server] shutdown exceeded ${timeoutMs}ms; connections were forced closed`);
    else console.log('[server] shutdown complete');
    if (exitProcess) process.exit(timedOut ? 1 : 0);
  })();
  return shutdownPromise;
};

if (require.main === module) {
  start().catch((error) => {
    console.error('[server] startup failed:', error.message);
    process.exit(1);
  });
  const shutdownForSignal = (signal) => {
    void shutdown(signal, { exitProcess: true }).catch((error) => {
      console.error('[server] shutdown failed:', error.message);
      process.exit(1);
    });
  };
  process.once('SIGTERM', () => shutdownForSignal('SIGTERM'));
  process.once('SIGINT', () => shutdownForSignal('SIGINT'));
}

module.exports = { start, shutdown };
