/**
 * Runs once, in the parent process, before any test file or worker starts.
 * Assigning process.env.TZ here changes the zone Date uses for the whole run (in-band and workers,
 * which inherit the env). A per-file process.env copy could not do this. Production pins the same
 * zone in src/server.js. GUAVA_TEST_TZ exists for cards that prove code is zone-independent.
 */
module.exports = async () => {
  process.env.TZ = process.env.GUAVA_TEST_TZ || 'Africa/Johannesburg';
  // Fetch (or find cached) the mongod binary now, before tests/hermetic.js forbids network,
  // so MongoMemoryReplSet.create() never downloads inside a test.
  const { MongoBinary } = require('mongodb-memory-server');
  await MongoBinary.getPath();
};
