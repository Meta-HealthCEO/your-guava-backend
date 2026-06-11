/**
 * Standalone in-memory MongoDB for local development when Docker is
 * unavailable. Binds to the same port the backend expects (.env MONGODB_URI).
 * Data is ephemeral — gone when this process stops.
 *
 * Usage: node scripts/dev-mongo.js [port]
 */
const { MongoMemoryServer } = require('mongodb-memory-server');

const port = Number(process.argv[2]) || 27018;

(async () => {
  const server = await MongoMemoryServer.create({
    instance: { port, dbName: 'your-guava' },
  });
  console.log(`[dev-mongo] In-memory MongoDB running at ${server.getUri()}`);
  console.log('[dev-mongo] Press Ctrl+C to stop. Data is NOT persisted.');

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((err) => {
  console.error('[dev-mongo] Failed to start:', err.message);
  process.exit(1);
});
