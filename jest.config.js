module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  testTimeout: 30000,
  verbose: true,
  // Hermetic by design (BE-12-T01). globalSetup pins the timezone before any test file runs;
  // tests/env.js sets every variable src reads before any module loads; tests/hermetic.js makes
  // dotenv inert and refuses outbound network.
  globalSetup: '<rootDir>/tests/globalSetup.js',
  setupFiles: ['<rootDir>/tests/env.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/hermetic.js'],
};
